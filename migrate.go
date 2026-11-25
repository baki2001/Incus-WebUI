package main

// Imports from Proxmox: the user uploads a vzdump backup, sees what it turns
// into, then a job builds an Incus image from it, creates the instance,
// starts it and waits for an address. A failed import removes what it made.

import (
	"archive/tar"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"mime/multipart"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/baki2001/incus-webui/internal/proxmox"
	"github.com/klauspost/compress/gzip"
)

// importFile is an uploaded backup waiting to be imported.
type importFile struct {
	ID      string    `json:"id"`
	User    string    `json:"user"`
	Owner   string    `json:"owner"` // method:user
	Name    string    `json:"name"`  // the file name the user uploaded
	Kind    string    `json:"kind"`  // container | virtual-machine
	Size    int64     `json:"size"`
	Created time.Time `json:"created"`
	Expires time.Time `json:"expires"` // when pruneImports removes it
}

// An upload stays on the UI server until it is imported or removed, for a
// day at most, so a big backup doesn't take up disk space for long. The
// import sheet shows when each one goes.
const importKeep = 24 * time.Hour

var importID = regexp.MustCompile(`^[0-9a-f]{16}$`)

func (a *App) importDir() string { return filepath.Join(a.dataDir, "imports") }

func (a *App) importPath(id string) string { return filepath.Join(a.importDir(), id+".bak") }

func (a *App) readImport(id string, s *Session) (*importFile, error) {
	if !importID.MatchString(id) {
		return nil, errors.New("no such upload")
	}
	path := filepath.Join(a.importDir(), id+".json")
	b, err := os.ReadFile(path)
	st, serr := os.Stat(path)
	if err != nil || serr != nil {
		return nil, errors.New("no such upload")
	}
	var f importFile
	if json.Unmarshal(b, &f) != nil || (f.Owner != owner(s) && !a.isAdmin(s)) {
		return nil, errors.New("no such upload")
	}
	f.Expires = st.ModTime().Add(importKeep)
	return &f, nil
}

func (a *App) removeImport(id string) {
	os.Remove(a.importPath(id))
	os.Remove(filepath.Join(a.importDir(), id+".json"))
}

// cleanImports removes the work folders of imports that a restart cut off,
// then prunes old uploads every 10 minutes, whether or not anyone opens the
// import sheet.
func (a *App) cleanImports(ctx context.Context) {
	ents, _ := os.ReadDir(a.importDir())
	for _, e := range ents {
		if e.IsDir() {
			os.RemoveAll(filepath.Join(a.importDir(), e.Name()))
		}
	}
	for {
		a.pruneImports()
		select {
		case <-ctx.Done():
			return
		case <-time.After(10 * time.Minute):
		}
	}
}

// pruneImports removes old uploads. A work folder is never old: it lives
// only while its import runs.
func (a *App) pruneImports() {
	ents, _ := os.ReadDir(a.importDir())
	for _, e := range ents {
		info, err := e.Info()
		if err == nil && !e.IsDir() && time.Since(info.ModTime()) > importKeep {
			os.Remove(filepath.Join(a.importDir(), e.Name()))
		}
	}
}

// canImport: importing creates instances, which takes the manager role.
func (a *App) canImport(s *Session) bool {
	for _, srv := range a.store.Get().Servers {
		if roleAnywhere(a.store.Get().Access, s, srv.Name) >= RoleManager {
			return true
		}
	}
	return false
}

func (a *App) handleImportUpload(w http.ResponseWriter, r *http.Request) {
	s, _ := a.currentSession(r)
	if !a.canImport(s) {
		jsonError(w, http.StatusForbidden, "Importing needs the manager role. Ask an admin.")
		return
	}
	a.pruneImports()
	if err := os.MkdirAll(a.importDir(), 0o700); err != nil {
		jsonError(w, http.StatusInternalServerError, err.Error())
		return
	}
	f := importFile{ID: randHex(8), User: s.User, Owner: owner(s), Name: filepath.Base(r.URL.Query().Get("name")), Created: time.Now()}
	path := a.importPath(f.ID)
	out, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, err.Error())
		return
	}
	f.Size, err = io.Copy(out, r.Body)
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		os.Remove(path)
		jsonError(w, http.StatusBadRequest, "The upload failed: "+err.Error())
		return
	}
	if f.Kind, err = proxmox.Kind(path); err != nil {
		os.Remove(path)
		jsonError(w, http.StatusBadRequest, err.Error())
		return
	}
	b, _ := json.Marshal(f)
	if err := os.WriteFile(filepath.Join(a.importDir(), f.ID+".json"), b, 0o600); err != nil {
		os.Remove(path)
		jsonError(w, http.StatusInternalServerError, err.Error())
		return
	}
	f.Expires = f.Created.Add(importKeep)
	writeJSON(w, f)
}

func (a *App) handleImports(w http.ResponseWriter, r *http.Request) {
	s, _ := a.currentSession(r)
	a.pruneImports()
	out := []importFile{}
	ents, _ := os.ReadDir(a.importDir())
	for _, e := range ents {
		if id, ok := strings.CutSuffix(e.Name(), ".json"); ok {
			if f, err := a.readImport(id, s); err == nil && f.Owner == owner(s) {
				out = append(out, *f)
			}
		}
	}
	writeJSON(w, out)
}

func (a *App) handleImportDelete(w http.ResponseWriter, r *http.Request) {
	s, _ := a.currentSession(r)
	f, err := a.readImport(r.PathValue("id"), s)
	if err != nil {
		jsonError(w, http.StatusNotFound, err.Error())
		return
	}
	a.removeImport(f.ID)
	w.WriteHeader(http.StatusNoContent)
}

// importReq is what the user picked in the wizard.
type importReq struct {
	Server  string `json:"server"`
	Project string `json:"project"`
	Name    string `json:"name"`
	Network string `json:"network"`
	Pool    string `json:"pool"`
	KeepMAC bool   `json:"keep_mac"`
	Start   bool   `json:"start"`
}

func (q importReq) options() proxmox.Options {
	return proxmox.Options{Name: q.Name, Network: q.Network, Pool: q.Pool, KeepMAC: q.KeepMAC}
}

// importPlan reads the backup's config and maps it to Incus.
func importPlan(path, kind string, o proxmox.Options) (*proxmox.Plan, error) {
	if kind == "container" {
		c, err := proxmox.ContainerConf(path)
		if err != nil {
			return nil, err
		}
		return proxmox.ContainerPlan(c, o), nil
	}
	c, devs, err := proxmox.VMConfig(path)
	if err != nil {
		return nil, err
	}
	return proxmox.VMPlan(c, devs, o), nil
}

func (a *App) handleImportPlan(w http.ResponseWriter, r *http.Request) {
	s, _ := a.currentSession(r)
	f, err := a.readImport(r.PathValue("id"), s)
	if err != nil {
		jsonError(w, http.StatusNotFound, err.Error())
		return
	}
	q := r.URL.Query()
	o := proxmox.Options{Name: q.Get("name"), Network: q.Get("network"), Pool: q.Get("pool"), KeepMAC: q.Get("keep_mac") == "true"}
	p, err := importPlan(a.importPath(f.ID), f.Kind, o)
	if err != nil {
		jsonError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, p)
}

func (a *App) handleImportRun(w http.ResponseWriter, r *http.Request) {
	s, _ := a.currentSession(r)
	f, err := a.readImport(r.PathValue("id"), s)
	if err != nil {
		jsonError(w, http.StatusNotFound, err.Error())
		return
	}
	var q importReq
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&q); err != nil {
		jsonError(w, http.StatusBadRequest, "bad request")
		return
	}
	// The day starts again, so pruning can't remove the file mid-import.
	now := time.Now()
	os.Chtimes(a.importPath(f.ID), now, now)
	os.Chtimes(filepath.Join(a.importDir(), f.ID+".json"), now, now)
	a.startImport(w, r, s, q, a.fileSource(f))
}

// fileSource reads an uploaded vzdump file.
func (a *App) fileSource(f *importFile) importSource {
	path := a.importPath(f.ID)
	return importSource{
		label: f.Name,
		plan:  func(_ context.Context, o proxmox.Options) (*proxmox.Plan, error) { return importPlan(path, f.Kind, o) },
		container: func(_ context.Context, w io.Writer, p *proxmox.Plan) error {
			conf, err := proxmox.ContainerConf(path)
			if err != nil {
				return err
			}
			return proxmox.ContainerImage(w, path, p, proxmox.Arch(conf.Get("arch")))
		},
		vmDisks: func(_ context.Context, p *proxmox.Plan, boot io.WriterAt, raw map[string]io.WriterAt, progress proxmox.Progress) (map[string][]byte, error) {
			return proxmox.VMDisksRaw(path, map[string]io.WriterAt{p.BootDisk: boot}, raw, progress)
		},
		done: func() { a.removeImport(f.ID) },
	}
}

// importSource is where an import reads the backup: an uploaded vzdump file
// or a snapshot on a Proxmox Backup Server.
type importSource struct {
	label string // shown in the task and the instance description
	plan  func(ctx context.Context, o proxmox.Options) (*proxmox.Plan, error)
	// container writes a unified Incus image.
	container func(ctx context.Context, w io.Writer, p *proxmox.Plan) error
	// vmDisks writes the boot disk as qcow2 to boot and the data disks raw,
	// and returns the first 64 KiB of each disk.
	vmDisks func(ctx context.Context, p *proxmox.Plan, boot io.WriterAt, raw map[string]io.WriterAt, progress proxmox.Progress) (map[string][]byte, error)
	done    func() // after a successful import
}

// startImport checks the request and starts the import job.
func (a *App) startImport(w http.ResponseWriter, r *http.Request, s *Session, q importReq, src importSource) {
	if q.Project == "" {
		q.Project = "default"
	}
	if roleFor(a.store.Get().Access, s, q.Server, q.Project) < RoleManager {
		jsonError(w, http.StatusForbidden, deniedMsg(RoleManager, q.Project))
		return
	}
	if q.Network == "" || q.Pool == "" {
		jsonError(w, http.StatusBadRequest, "Pick a network and a storage pool.")
		return
	}
	c, err := a.conn(q.Server)
	if err != nil {
		jsonError(w, http.StatusBadRequest, err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	p, err := src.plan(ctx, q.options())
	if err != nil {
		jsonError(w, http.StatusBadRequest, err.Error())
		return
	}
	if len(p.Blockers) > 0 {
		jsonError(w, http.StatusBadRequest, strings.Join(p.Blockers, " "))
		return
	}
	if len(p.ExtraDisks) > 0 && !a.ownVolumes(ctx, s, q.Server, q.Project) {
		jsonError(w, http.StatusForbidden, sharedVolumesMsg(q.Project))
		return
	}
	if _, err := c.call(ctx, "GET", "/1.0/instances/"+url.PathEscape(p.Name), q.Project, nil); err == nil {
		jsonError(w, http.StatusConflict, fmt.Sprintf("An instance named %s already exists. Pick another name.", p.Name))
		return
	}
	for _, d := range p.ExtraDisks {
		if _, err := c.call(ctx, "GET", volPath(q.Pool, extraVolName(p.Name, d.Key)), q.Project, nil); err == nil {
			jsonError(w, http.StatusConflict, fmt.Sprintf("A volume named %s already exists in pool %s.", extraVolName(p.Name, d.Key), q.Pool))
			return
		}
	}
	job := a.jobs.start("import", "Import "+src.label+" as "+p.Name, s, q.Server, q.Project, func(ctx context.Context, set func(float64, string)) (jobResult, error) {
		note, err := a.runImport(ctx, c, src, p, q, set)
		if err != nil {
			return jobResult{}, err
		}
		if src.done != nil {
			src.done()
		}
		link := "/instances/" + url.PathEscape(q.Server) + "/" + url.PathEscape(p.Name) + "?project=" + url.QueryEscape(q.Project)
		return jobResult{Link: link, Note: note}, nil
	})
	writeJSON(w, map[string]string{"job": job.ID})
}

func volPath(pool, name string) string {
	return "/1.0/storage-pools/" + url.PathEscape(pool) + "/volumes/custom/" + url.PathEscape(name)
}

func extraVolName(inst, key string) string { return inst + "-" + key }

// runImport does the import. On failure it removes the instance and volumes
// it created. It returns a note for the user when the import worked but
// something needs a look.
func (a *App) runImport(ctx context.Context, c *incusConn, src importSource, p *proxmox.Plan, q importReq, set func(float64, string)) (note string, err error) {
	lowPriority()
	if err := os.MkdirAll(a.importDir(), 0o700); err != nil {
		return "", err
	}
	tmp, err := os.MkdirTemp(a.importDir(), "run-")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(tmp)

	// Cleanup runs on failure, including cancel, with a context of its own.
	var undo []func(context.Context)
	defer func() {
		if err == nil {
			return
		}
		cctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()
		for i := len(undo) - 1; i >= 0; i-- {
			undo[i](cctx)
		}
	}()

	var fp string
	var heads map[string][]byte
	if p.Type == "container" {
		set(0.02, "Building the image")
		img := filepath.Join(tmp, "image.tar")
		out, err := os.Create(img)
		if err != nil {
			return "", err
		}
		err = src.container(ctx, out, p)
		if cerr := out.Close(); err == nil {
			err = cerr
		}
		if err != nil {
			return "", err
		}
		if err := ctx.Err(); err != nil {
			return "", err
		}
		sp := newSendProgress(set, 0.4, 0.8, "the image")
		fp, err = uploadImage(ctx, c, q.Project, []string{img}, nil, sp.update)
		sp.stop()
		if err != nil {
			return "", err
		}
		defer deleteImage(c, q.Project, fp)
	} else {
		set(0.01, "Reading the disks")
		boot, err := os.Create(filepath.Join(tmp, "rootfs.img"))
		if err != nil {
			return "", err
		}
		defer boot.Close()
		raw := map[string]io.WriterAt{}
		for _, d := range p.ExtraDisks {
			rf, err := os.Create(filepath.Join(tmp, d.Key+".img"))
			if err != nil {
				return "", err
			}
			defer rf.Close()
			if err := rf.Truncate(d.Size); err != nil {
				return "", err
			}
			raw[d.Device] = rf
		}
		done := make(chan struct{})
		go func() {
			select {
			case <-ctx.Done():
				// VMDisksRaw has no context; closing its input stops it.
				boot.Close()
			case <-done:
			}
		}()
		heads, err = src.vmDisks(ctx, p, boot, raw, func(d, t int64) {
			set(0.01+0.49*float64(d)/float64(max(t, 1)), "Reading the disks")
		})
		close(done)
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		if err != nil {
			return "", err
		}
		// The image grew if the partition table needed it, and the root
		// disk can't be smaller than the image.
		if need := proxmox.GPTSize(heads[p.BootDisk], p.DiskSize); need > 0 {
			if root := p.Devices["root"]; root != nil {
				root["size"] = fmt.Sprintf("%dB", need)
			}
			note = "The boot disk is slightly bigger now. Incus needs a little free space after the last partition for its copy of the partition table. "
		}
		meta, err := proxmox.VMMetadata(p)
		if err != nil {
			return "", err
		}
		metaPath := filepath.Join(tmp, "metadata.tar")
		if err := os.WriteFile(metaPath, meta, 0o600); err != nil {
			return "", err
		}
		sp := newSendProgress(set, 0.5, 0.75, "the image")
		fp, err = uploadImage(ctx, c, q.Project, []string{metaPath, boot.Name()}, []string{"metadata", "rootfs.img"}, sp.update)
		sp.stop()
		if err != nil {
			return "", err
		}
		defer deleteImage(c, q.Project, fp)
		for i, d := range p.ExtraDisks {
			name := extraVolName(p.Name, d.Key)
			lo := 0.75 + 0.1*float64(i)/float64(len(p.ExtraDisks))
			sp := newSendProgress(set, lo, lo+0.1/float64(len(p.ExtraDisks)), "disk "+d.Key)
			err := importVolume(ctx, c, q.Project, q.Pool, name, filepath.Join(tmp, d.Key+".img"), sp.update)
			sp.stop()
			if err != nil {
				return "", fmt.Errorf("disk %s: %w", d.Key, err)
			}
			undo = append(undo, func(ctx context.Context) {
				_, _ = c.call(ctx, "DELETE", volPath(q.Pool, name), q.Project, nil)
			})
			p.Devices[d.Key] = map[string]string{"type": "disk", "pool": q.Pool, "source": name}
		}
	}

	if p.Type == "virtual-machine" {
		note += capCPUs(ctx, c, q.Project, p)
	}

	set(0.85, "Creating the instance: Incus copies the disk into the storage pool")
	body := map[string]any{
		"name": p.Name, "type": p.Type, "config": p.Config, "devices": p.Devices,
		"description": "Imported from Proxmox (" + src.label + ")",
		"source":      map[string]string{"type": "image", "fingerprint": fp},
	}
	if _, err := c.call(ctx, "POST", "/1.0/instances", q.Project, body); err != nil {
		if strings.Contains(err.Error(), "sgdisk") {
			return "", fmt.Errorf("create the instance: Incus could not move the backup partition table to the end of the boot disk. sgdisk -v does not catch this. Inside the VM in Proxmox, run sgdisk -p on the boot disk (for example sudo sgdisk -p /dev/sda) and share the output. Incus said: %w", err)
		}
		return "", fmt.Errorf("create the instance: %w", err)
	}
	inst := "/1.0/instances/" + url.PathEscape(p.Name)
	undo = append(undo, func(ctx context.Context) {
		_, _ = c.call(ctx, "PUT", inst+"/state", q.Project, map[string]any{"action": "stop", "force": true})
		_, _ = c.call(ctx, "DELETE", inst, q.Project, nil)
	})
	if !q.Start {
		return strings.TrimSpace(note), nil
	}

	set(0.9, "Starting")
	start := func() error {
		_, err := c.call(ctx, "PUT", inst+"/state", q.Project, map[string]any{"action": "start"})
		return err
	}
	err = start()
	if err != nil && p.Config["security.csm"] == "true" && biosMissing(err) {
		// Legacy BIOS needs SeaBIOS, which not every Incus package ships. A
		// disk with an EFI system partition boots with UEFI just as well.
		if !proxmox.HasESP(heads[p.BootDisk]) {
			return strings.TrimSpace(note + "It was imported but did not start: it boots with legacy BIOS, and the Incus server has no SeaBIOS firmware for it. Install SeaBIOS on the Incus server (Incus looks for seabios.bin next to its UEFI firmware), then start it."), nil
		}
		if _, perr := c.call(ctx, "PATCH", inst, q.Project, map[string]any{"config": map[string]string{"security.csm": "false"}}); perr != nil {
			return "", perr
		}
		note += "The Incus server has no SeaBIOS, so the VM boots with UEFI. "
		err = start()
	}
	if err != nil {
		// Keep the instance. The copy took long, and the fix is usually a
		// setting the user can change before starting it again.
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		return strings.TrimSpace(note + "It was imported but did not start. Change its settings and start it. Incus said: " + err.Error()), nil
	}

	set(0.95, "Waiting for a network address")
	if addr := waitAddress(ctx, c, q.Project, p.Name, 3*time.Minute); addr != "" {
		return strings.TrimSpace(note + "Running at " + addr + "."), nil
	}
	if ctx.Err() != nil {
		return "", ctx.Err()
	}
	// No rollback: the guest may use a static address on another network.
	if p.Type == "virtual-machine" {
		// The guest names its NIC after the PCI slot, which differs from
		// Proxmox, and cloud-init's netplan matches it by MAC address.
		return note + "It runs, but no address showed up in 3 minutes. Most often the network settings inside the VM still point at the network card it had in Proxmox. In the VM's console, run ip -br link to see the card's new name (often enp5s0). Then use that name in /etc/netplan/ or /etc/network/interfaces inside the VM. If the VM uses a fixed address, check that it fits this network.", nil
	}
	return note + "It runs, but no address showed up in 3 minutes. Check its console: the guest may use a fixed address on another network.", nil
}

// sendProgress reports an upload to Incus. Once every byte is sent, Incus
// still has to check and store the data, which can take minutes for a big
// disk, so it then counts the time instead of leaving the task at one spot.
type sendProgress struct {
	set    func(float64, string)
	lo, hi float64
	what   string
	once   sync.Once
	done   chan struct{}
}

func newSendProgress(set func(float64, string), lo, hi float64, what string) *sendProgress {
	set(lo, "Sending "+what+" to Incus")
	return &sendProgress{set: set, lo: lo, hi: hi, what: what, done: make(chan struct{})}
}

func (s *sendProgress) update(sent, total int64) {
	if sent < total {
		s.set(s.lo+(s.hi-s.lo)*0.9*float64(sent)/float64(max(total, 1)), fmt.Sprintf("Sending %s to Incus: %s of %s", s.what, gib(sent), gib(total)))
		return
	}
	s.once.Do(func() {
		start := time.Now()
		at := s.lo + (s.hi-s.lo)*0.9
		s.set(at, "Incus is checking and storing "+s.what)
		go func() {
			t := time.NewTicker(10 * time.Second)
			defer t.Stop()
			for {
				select {
				case <-s.done:
					return
				case <-t.C:
					select {
					case <-s.done: // stopped while the tick fired
						return
					default:
					}
					s.set(at, fmt.Sprintf("Incus is checking and storing %s (%s so far)", s.what, time.Since(start).Round(time.Second)))
				}
			}
		}()
	})
}

func (s *sendProgress) stop() {
	select {
	case <-s.done:
	default:
		close(s.done)
	}
}

func gib(n int64) string { return fmt.Sprintf("%.1f GiB", float64(n)/(1<<30)) }

func biosMissing(err error) bool {
	m := strings.ToLower(err.Error())
	return strings.Contains(m, "seabios") || strings.Contains(m, "csm") || strings.Contains(m, "firmware")
}

// uploadImage sends a unified image (one file) or a split image (metadata
// plus rootfs) and returns its fingerprint.
func uploadImage(ctx context.Context, c *incusConn, project string, files, fields []string, progress func(sent, total int64)) (string, error) {
	var total int64
	for _, p := range files {
		st, err := os.Stat(p)
		if err != nil {
			return "", err
		}
		total += st.Size()
	}
	var sent atomic.Int64
	count := func(r io.Reader) io.Reader {
		return &countReader{r: r, n: &sent, total: total, progress: progress}
	}
	hdr := map[string]string{}
	var body io.Reader
	if len(files) == 1 {
		f, err := os.Open(files[0])
		if err != nil {
			return "", err
		}
		defer f.Close()
		body = count(f)
		hdr["Content-Type"] = "application/octet-stream"
		hdr["Content-Length"] = strconv.FormatInt(total, 10)
	} else {
		pr, pw := io.Pipe()
		mw := multipart.NewWriter(pw)
		go func() {
			for i, p := range files {
				part, err := mw.CreateFormFile(fields[i], fields[i])
				if err == nil {
					var f *os.File
					if f, err = os.Open(p); err == nil {
						_, err = io.Copy(part, f)
						f.Close()
					}
				}
				if err != nil {
					pw.CloseWithError(err)
					return
				}
			}
			pw.CloseWithError(mw.Close())
		}()
		defer pr.Close()
		body = count(pr)
		hdr["Content-Type"] = mw.FormDataContentType()
	}
	meta, err := c.send(ctx, "POST", "/1.0/images", project, body, hdr)
	if err != nil {
		return "", fmt.Errorf("Incus refused the image: %w", err)
	}
	var m struct {
		Fingerprint string `json:"fingerprint"`
	}
	if json.Unmarshal(meta, &m) != nil || m.Fingerprint == "" {
		return "", errors.New("incus did not return the image's fingerprint")
	}
	return m.Fingerprint, nil
}

type countReader struct {
	r        io.Reader
	n        *atomic.Int64
	total    int64
	progress func(sent, total int64)
	last     time.Time
}

func (c *countReader) Read(b []byte) (int, error) {
	n, err := c.r.Read(b)
	done := c.n.Add(int64(n))
	if err == io.EOF {
		c.progress(c.total, c.total)
	} else if time.Since(c.last) > time.Second {
		c.last = time.Now()
		c.progress(min(done, c.total), c.total)
	}
	return n, err
}

// importVolume creates a custom block volume from a raw disk, sent as an
// Incus volume backup: a tarball of backup/index.yaml and backup/volume.img.
// It is gzipped on the fly, which keeps the empty parts of the disk small.
func importVolume(ctx context.Context, c *incusConn, project, pool, name, img string, progress func(sent, total int64)) error {
	f, err := os.Open(img)
	if err != nil {
		return err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return err
	}
	pr, pw := io.Pipe()
	go func() {
		lowPriority()
		var sent atomic.Int64
		pw.CloseWithError(volumeBackup(pw, pool, name, &countReader{r: f, n: &sent, total: st.Size(), progress: progress}, st.Size()))
	}()
	defer pr.Close()
	_, err = c.send(ctx, "POST", "/1.0/storage-pools/"+url.PathEscape(pool)+"/volumes/custom", project, pr,
		map[string]string{"Content-Type": "application/octet-stream", "X-Incus-name": name})
	return err
}

// waitAddress waits for a global address: from the instance state, which
// needs the guest agent, or else from the DHCP leases of its network.
func waitAddress(ctx context.Context, c *incusConn, project, name string, d time.Duration) string {
	ctx, cancel := context.WithTimeout(ctx, d)
	defer cancel()
	inst := "/1.0/instances/" + url.PathEscape(name)
	for {
		var st struct {
			Network map[string]struct {
				Addresses []struct {
					Family, Address, Scope string
				}
			}
		}
		if b, err := c.call(ctx, "GET", inst+"/state", project, nil); err == nil && json.Unmarshal(b, &st) == nil {
			for nic, n := range st.Network {
				if nic == "lo" {
					continue
				}
				for _, ad := range n.Addresses {
					if ad.Scope == "global" && ad.Family == "inet" {
						return ad.Address
					}
				}
			}
		}
		if addr := leaseAddress(ctx, c, project, inst); addr != "" {
			return addr
		}
		select {
		case <-ctx.Done():
			return ""
		case <-time.After(3 * time.Second):
		}
	}
}

func leaseAddress(ctx context.Context, c *incusConn, project, inst string) string {
	b, err := c.call(ctx, "GET", inst, project, nil)
	if err != nil {
		return ""
	}
	var in struct {
		Config         map[string]string            `json:"config"`
		ExpandedDevice map[string]map[string]string `json:"expanded_devices"`
	}
	if json.Unmarshal(b, &in) != nil {
		return ""
	}
	for dev, d := range in.ExpandedDevice {
		if d["type"] != "nic" || d["network"] == "" {
			continue
		}
		mac := strings.ToLower(in.Config["volatile."+dev+".hwaddr"])
		lb, err := c.call(ctx, "GET", "/1.0/networks/"+url.PathEscape(d["network"])+"/leases", project, nil)
		if err != nil || mac == "" {
			continue
		}
		var leases []struct {
			Hwaddr, Address, Type string
		}
		_ = json.Unmarshal(lb, &leases)
		for _, l := range leases {
			if strings.ToLower(l.Hwaddr) == mac && l.Type == "dynamic" {
				return l.Address
			}
		}
	}
	return ""
}

func volumeBackup(w io.Writer, pool, name string, img io.Reader, size int64) error {
	index := fmt.Sprintf("name: %s\npool: %s\noptimized: false\noptimized_header: false\ntype: custom\nconfig:\n  volume:\n    name: %s\n    type: custom\n    content_type: block\n    config:\n      size: \"%d\"\n", name, pool, name, size)
	zw, _ := gzip.NewWriterLevel(w, gzip.BestSpeed)
	tw := tar.NewWriter(zw)
	now := time.Now()
	if err := tw.WriteHeader(&tar.Header{Name: "backup/index.yaml", Mode: 0o644, Size: int64(len(index)), ModTime: now, Typeflag: tar.TypeReg}); err != nil {
		return err
	}
	if _, err := tw.Write([]byte(index)); err != nil {
		return err
	}
	if err := tw.WriteHeader(&tar.Header{Name: "backup/volume.img", Mode: 0o600, Size: size, ModTime: now, Typeflag: tar.TypeReg}); err != nil {
		return err
	}
	if _, err := io.Copy(tw, img); err != nil {
		return err
	}
	if err := tw.Close(); err != nil {
		return err
	}
	return zw.Close()
}

// deleteImage removes the temporary image an import made: it is only a
// vehicle for the instance.
func deleteImage(c *incusConn, project, fp string) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	if _, err := c.call(ctx, "DELETE", "/1.0/images/"+fp, project, nil); err != nil {
		log.Printf("import: delete image %s: %v", fp, err)
	}
}

// ownVolumes says whether volumes made in a project stay in it. A project
// without its own volumes uses the default project's, which only admins may
// touch.
func (a *App) ownVolumes(ctx context.Context, s *Session, server, project string) bool {
	return project == "default" || a.isAdmin(s) || a.projectHas(ctx, server, project, "features.storage.volumes")
}

func sharedVolumesMsg(project string) string {
	return "Project " + project + " keeps its volumes in the default project, so only an admin can import volumes into it."
}

// capCPUs lowers limits.cpu to the number of CPUs on the Incus server. Incus
// can't start a VM with more CPUs than the server has, and a Proxmox host
// often has more. It returns a note for the user when it lowered it.
func capCPUs(ctx context.Context, c *incusConn, project string, p *proxmox.Plan) string {
	want, err := strconv.Atoi(p.Config["limits.cpu"])
	if err != nil || want <= 1 {
		return ""
	}
	raw, err := c.call(ctx, "GET", "/1.0/resources", project, nil)
	if err != nil {
		return ""
	}
	var res struct {
		CPU struct {
			Total int `json:"total"`
		} `json:"cpu"`
	}
	if json.Unmarshal(raw, &res) != nil || res.CPU.Total <= 0 || want <= res.CPU.Total {
		return ""
	}
	p.Config["limits.cpu"] = strconv.Itoa(res.CPU.Total)
	return fmt.Sprintf("The VM had %d CPUs in Proxmox, but the Incus server has %d, so it gets %d. ", want, res.CPU.Total, res.CPU.Total)
}
