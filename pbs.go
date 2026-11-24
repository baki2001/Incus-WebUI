package main

// Imports from a Proxmox Backup Server. An admin adds the server under
// Settings, Backups and picks a snapshot in the import sheet. The UI
// downloads the backup itself, so nothing goes through the browser. Only
// admins import from PBS: a datastore holds the backups of every guest, and
// nothing ties a snapshot to an Incus project.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/baki2001/incus-webui/internal/pbs"
	"github.com/baki2001/incus-webui/internal/proxmox"
)

// PBSServer is a Proxmox Backup Server datastore to import from.
type PBSServer struct {
	Name        string `yaml:"name" json:"name"`
	URL         string `yaml:"url" json:"url"` // https://pbs.lan:8007
	Datastore   string `yaml:"datastore" json:"datastore"`
	Namespace   string `yaml:"namespace,omitempty" json:"namespace,omitempty"`
	TokenID     string `yaml:"token_id" json:"token_id"` // user@pbs!name
	Secret      string `yaml:"secret" json:"secret"`
	Fingerprint string `yaml:"fingerprint,omitempty" json:"fingerprint,omitempty"`
}

func (s PBSServer) client() (*pbs.Client, error) {
	return pbs.New(s.URL, s.Datastore, s.Namespace, s.TokenID, s.Secret, s.Fingerprint)
}

func (a *App) pbsClient(name string) (*pbs.Client, error) {
	for _, s := range a.store.Get().Backups.PBS {
		if s.Name == name {
			return s.client()
		}
	}
	return nil, fmt.Errorf("no Proxmox Backup Server named %q", name)
}

// Archive names in a PBS snapshot made by Proxmox VE.
const (
	pbsCTConf   = "pct.conf.blob"
	pbsVMConf   = "qemu-server.conf.blob"
	pbsRoot     = "root.pxar.didx"
	pbsRootMeta = "root.mpxar.didx"
	pbsRootData = "root.ppxar.didx"
	pbsDisk     = ".img.fidx"
)

// pbsSnapshot is a snapshot as the import sheet lists it.
type pbsSnapshot struct {
	Ref     string    `json:"ref"`
	Kind    string    `json:"kind"` // container | virtual-machine
	ID      string    `json:"id"`
	Created time.Time `json:"created"`
	Comment string    `json:"comment,omitempty"`
	Size    int64     `json:"size,omitempty"`
	Problem string    `json:"problem,omitempty"` // why it can't be imported
}

func pbsProblem(s pbs.Snapshot) string {
	for _, f := range s.Files {
		if f.CryptMode == "encrypt" && f.Name != "client.log.blob" {
			return "Encrypted: restore it in Proxmox instead."
		}
	}
	if s.Type == "ct" {
		_, conf := s.File(pbsCTConf)
		_, root := s.File(pbsRoot)
		_, meta := s.File(pbsRootMeta)
		_, data := s.File(pbsRootData)
		if !conf || !(root || meta && data) {
			return "Not a Proxmox container backup."
		}
		return ""
	}
	if _, ok := s.File(pbsVMConf); !ok {
		return "Not a Proxmox VM backup."
	}
	return ""
}

func (a *App) handlePBSList(w http.ResponseWriter, r *http.Request) {
	s, _ := a.currentSession(r)
	out := []map[string]string{}
	if a.isAdmin(s) {
		for _, p := range a.store.Get().Backups.PBS {
			out = append(out, map[string]string{"name": p.Name, "datastore": p.Datastore})
		}
	}
	writeJSON(w, out)
}

func (a *App) handlePBSSnapshots(w http.ResponseWriter, r *http.Request) {
	s, _ := a.currentSession(r)
	if !a.isAdmin(s) {
		jsonError(w, http.StatusForbidden, pbsAdminMsg)
		return
	}
	c, err := a.pbsClient(r.PathValue("name"))
	if err != nil {
		jsonError(w, http.StatusNotFound, err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	list, err := c.Snapshots(ctx)
	if err != nil {
		jsonError(w, http.StatusBadGateway, err.Error())
		return
	}
	out := []pbsSnapshot{}
	for _, x := range list {
		if x.Type != "ct" && x.Type != "vm" {
			continue
		}
		kind := "container"
		if x.Type == "vm" {
			kind = "virtual-machine"
		}
		out = append(out, pbsSnapshot{Ref: x.Ref(), Kind: kind, ID: x.ID, Created: x.Created(), Comment: x.Comment, Size: x.Size, Problem: pbsProblem(x)})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Created.After(out[j].Created) })
	writeJSON(w, out)
}

// pbsSource reads a snapshot from the server as the import runs.
func pbsSource(server string, c *pbs.Client, snap pbs.Snapshot) importSource {
	conf := func(ctx context.Context) (*proxmox.Conf, error) {
		name := pbsCTConf
		if snap.Type == "vm" {
			name = pbsVMConf
		}
		b, err := c.ReadFile(ctx, snap, name)
		if err != nil {
			return nil, err
		}
		return proxmox.ParseConf(b)
	}
	return importSource{
		label: fmt.Sprintf("%s/%s from %s (%s)", snap.Type, snap.ID, server, snap.Created().Format("2006-01-02 15:04")),
		plan: func(ctx context.Context, o proxmox.Options) (*proxmox.Plan, error) {
			if p := pbsProblem(snap); p != "" {
				return nil, errors.New(p)
			}
			cf, err := conf(ctx)
			if err != nil {
				return nil, err
			}
			if snap.Type == "ct" {
				return proxmox.ContainerPlan(cf, o), nil
			}
			devs := map[string]int64{}
			for _, f := range snap.Files {
				if dev, ok := strings.CutSuffix(f.Name, pbsDisk); ok {
					devs[dev] = f.Size
				}
			}
			return proxmox.VMPlan(cf, devs, o), nil
		},
		container: func(ctx context.Context, w io.Writer, p *proxmox.Plan) error {
			cf, err := conf(ctx)
			if err != nil {
				return err
			}
			var meta, data io.ReadCloser
			if _, ok := snap.File(pbsRoot); ok {
				meta, err = c.Open(ctx, snap, pbsRoot)
			} else if meta, err = c.Open(ctx, snap, pbsRootMeta); err == nil {
				if data, err = c.Open(ctx, snap, pbsRootData); err != nil {
					meta.Close()
				}
			}
			if err != nil {
				return err
			}
			defer meta.Close()
			var payload io.Reader
			if data != nil {
				defer data.Close()
				payload = data
			}
			return proxmox.PxarImage(w, meta, payload, p, proxmox.Arch(cf.Get("arch")))
		},
		vmDisks: func(ctx context.Context, p *proxmox.Plan, boot io.WriterAt, raw map[string]io.WriterAt, progress proxmox.Progress) (map[string][]byte, error) {
			disks := map[string]io.WriterAt{p.BootDisk: boot}
			for dev, w := range raw {
				disks[dev] = w
			}
			var total, done int64
			for dev := range disks {
				f, ok := snap.File(dev + pbsDisk)
				if !ok {
					return nil, fmt.Errorf("the backup has no disk %s", dev)
				}
				total += f.Size
			}
			heads := map[string][]byte{}
			for dev, w := range disks {
				f, _ := snap.File(dev + pbsDisk)
				rc, err := c.Open(ctx, snap, f.Name)
				if err != nil {
					return nil, err
				}
				head, err := proxmox.RawDisk(rc, f.Size, w, dev == p.BootDisk, func(n int64) { progress(done+n, total) })
				rc.Close()
				if err != nil {
					return nil, fmt.Errorf("disk %s: %w", dev, err)
				}
				heads[dev] = head
				done += f.Size
			}
			return heads, nil
		},
	}
}

// pbsSnapshotFor checks access and finds the snapshot a request names.
func (a *App) pbsSnapshotFor(w http.ResponseWriter, r *http.Request, ref string) (*pbs.Client, pbs.Snapshot, bool) {
	s, _ := a.currentSession(r)
	if !a.isAdmin(s) {
		jsonError(w, http.StatusForbidden, pbsAdminMsg)
		return nil, pbs.Snapshot{}, false
	}
	c, err := a.pbsClient(r.PathValue("name"))
	if err != nil {
		jsonError(w, http.StatusNotFound, err.Error())
		return nil, pbs.Snapshot{}, false
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	snap, err := c.Snapshot(ctx, ref)
	if err != nil {
		jsonError(w, http.StatusBadRequest, err.Error())
		return nil, pbs.Snapshot{}, false
	}
	return c, snap, true
}

func (a *App) handlePBSPlan(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	c, snap, ok := a.pbsSnapshotFor(w, r, q.Get("snap"))
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	o := proxmox.Options{Name: q.Get("name"), Network: q.Get("network"), Pool: q.Get("pool"), KeepMAC: q.Get("keep_mac") == "true"}
	p, err := pbsSource(r.PathValue("name"), c, snap).plan(ctx, o)
	if err != nil {
		jsonError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, p)
}

func (a *App) handlePBSRun(w http.ResponseWriter, r *http.Request) {
	var q struct {
		importReq
		Snap string `json:"snap"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&q); err != nil {
		jsonError(w, http.StatusBadRequest, "bad request")
		return
	}
	c, snap, ok := a.pbsSnapshotFor(w, r, q.Snap)
	if !ok {
		return
	}
	s, _ := a.currentSession(r)
	a.startImport(w, r, s, q.importReq, pbsSource(r.PathValue("name"), c, snap))
}

// handlePBSTest lists the snapshots with settings that may not be saved yet.
func (a *App) handlePBSTest(w http.ResponseWriter, r *http.Request) {
	var p PBSServer
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&p); err != nil {
		jsonError(w, http.StatusBadRequest, "bad request")
		return
	}
	if p.Secret == secretMask {
		p.Secret = savedPBSSecret(a.store.Get().Backups.PBS, p)
	}
	c, err := p.client()
	if err != nil {
		jsonError(w, http.StatusBadRequest, err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	list, err := c.Snapshots(ctx)
	if err != nil {
		jsonError(w, http.StatusBadRequest, err.Error())
		return
	}
	n := 0
	for _, x := range list {
		if x.Type == "ct" || x.Type == "vm" {
			n++
		}
	}
	writeJSON(w, map[string]int{"snapshots": n})
}

const secretMask = "********"

const pbsAdminMsg = "Only admins can import from a Proxmox Backup Server."

// savedPBSSecret is the stored secret for a server sent back with its
// secret masked. It only goes to the same server and token: after a change
// of address or token the secret has to be typed again, so a saved secret
// can't be sent somewhere new.
func savedPBSSecret(saved []PBSServer, p PBSServer) string {
	for _, o := range saved {
		if o.Name == p.Name && o.URL == p.URL && o.Datastore == p.Datastore && o.TokenID == p.TokenID {
			return o.Secret
		}
	}
	return ""
}
