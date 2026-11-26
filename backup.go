package main

// Backups export instances with the Incus backup API and keep the tarballs
// on a target the UI writes to: a directory (local or mounted) or an S3
// bucket. Each backup has a JSON file next to it with its SHA-256, which a
// restore checks. Schedules run every day or on chosen weekdays and keep a
// number of recent and weekly backups.

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"hash"
	"io"
	"log"
	"maps"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

type Backups struct {
	Targets   []BackupTarget   `yaml:"targets,omitempty" json:"targets"`
	Schedules []BackupSchedule `yaml:"schedules,omitempty" json:"schedules"`
	// PBS are Proxmox Backup Servers to import from (see pbs.go).
	PBS []PBSServer `yaml:"pbs,omitempty" json:"pbs"`
}

type BackupTarget struct {
	Name string `yaml:"name" json:"name"`
	Type string `yaml:"type" json:"type"` // dir | s3
	// Path is the directory for type dir.
	Path string `yaml:"path,omitempty" json:"path,omitempty"`
	// S3
	Endpoint    string `yaml:"endpoint,omitempty" json:"endpoint,omitempty"`
	Bucket      string `yaml:"bucket,omitempty" json:"bucket,omitempty"`
	Region      string `yaml:"region,omitempty" json:"region,omitempty"`
	Prefix      string `yaml:"prefix,omitempty" json:"prefix,omitempty"`
	AccessKey   string `yaml:"access_key,omitempty" json:"access_key,omitempty"`
	SecretKey   string `yaml:"secret_key,omitempty" json:"secret_key,omitempty"`
	VirtualHost bool   `yaml:"virtual_host,omitempty" json:"virtual_host,omitempty"`
	// Passphrase turns on encryption: new backups on this target are
	// encrypted with age (see backupcrypt.go). Empty means plain files.
	Passphrase string `yaml:"passphrase,omitempty" json:"passphrase,omitempty"`
}

type BackupSchedule struct {
	Name    string `yaml:"name" json:"name"`
	Server  string `yaml:"server" json:"server"`
	Project string `yaml:"project" json:"project"`
	// Instances to back up; empty means every instance in the project.
	Instances []string `yaml:"instances,omitempty" json:"instances"`
	Target    string   `yaml:"target" json:"target"`
	At        string   `yaml:"at" json:"at"` // HH:MM, local time of the UI
	// Days are the weekdays to run on, 0 for Sunday to 6 for Saturday.
	// Empty means every day.
	Days []int `yaml:"days,omitempty" json:"days"`
	// KeepDaily keeps the newest backup of each of the last KeepDaily days
	// that have a backup; KeepWeekly does the same for weeks.
	KeepDaily  int `yaml:"keep_daily" json:"keep_daily"`
	KeepWeekly int `yaml:"keep_weekly" json:"keep_weekly"`
	// Optimized asks Incus for its storage driver's own format (a ZFS or
	// Btrfs send stream) instead of a plain tarball. It is faster to make
	// and restore, but restores only to a pool with the same driver. Each
	// backup is still a full copy: Incus can't export increments.
	Optimized bool `yaml:"optimized,omitempty" json:"optimized"`
	// TestRestore restores one backup a week to a temporary instance and
	// deletes it again, to prove the backup works (see testRestoreDay).
	TestRestore bool `yaml:"test_restore,omitempty" json:"test_restore"`
	Paused      bool `yaml:"paused,omitempty" json:"paused"`
}

// BackupMeta is stored next to each backup as <id>.json.
type BackupMeta struct {
	Key      string    `json:"key"` // server/project/instance/stamp
	Target   string    `json:"target"`
	Server   string    `json:"server"`
	Project  string    `json:"project"`
	Instance string    `json:"instance"`
	Type     string    `json:"type"`
	Created  time.Time `json:"created"`
	Size     int64     `json:"size"`
	SHA256   string    `json:"sha256"`
	Schedule string    `json:"schedule,omitempty"`
	By       string    `json:"by,omitempty"`
	// Name is an optional label, such as the snapshot name it was taken as.
	Name string `json:"name,omitempty"`
	// Optimized is set when the backup is in the storage driver's own
	// format, which restores only to a pool with the same driver.
	Optimized bool `json:"optimized,omitempty"`
	// Encrypted is set when the files are encrypted with the target's passphrase.
	Encrypted bool `json:"encrypted,omitempty"`
	// Volumes are the custom storage volumes attached to the instance, kept
	// next to it as <key>.vol<N>.tar.
	Volumes []VolumeMeta `json:"volumes,omitempty"`
}

// VolumeMeta is one custom volume in a backup.
type VolumeMeta struct {
	Device string            `json:"device"` // the disk device it was attached as
	Pool   string            `json:"pool"`
	Name   string            `json:"name"`
	Dev    map[string]string `json:"dev"` // the device, to attach the restored volume the same way
	Size   int64             `json:"size"`
	SHA256 string            `json:"sha256"`
}

// dataFile is the name of the instance's backup file on the target.
func (m *BackupMeta) dataFile() string {
	if m.Encrypted {
		return m.Key + ".tar.age"
	}
	return m.Key + ".tar"
}

// volFile is the name of the i'th volume's backup file.
func (m *BackupMeta) volFile(i int) string {
	n := fmt.Sprintf("%s.vol%d.tar", m.Key, i)
	if m.Encrypted {
		n += ".age"
	}
	return n
}

// files are all the files of a backup, its metadata last.
func (m *BackupMeta) files() []string {
	out := []string{m.dataFile()}
	for i := range m.Volumes {
		out = append(out, m.volFile(i))
	}
	return append(out, m.Key+".json")
}

func deleteBackupFiles(ctx context.Context, st backupStore, m BackupMeta) error {
	var first error
	for _, f := range m.files() {
		if err := st.del(ctx, f); err != nil && first == nil {
			first = err
		}
	}
	return first
}

var (
	errNoBackup   = errors.New("no such backup")
	backupPart    = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$`)
	backupStamp   = regexp.MustCompile(`^\d{8}-\d{6}$`)
	backupTimeFmt = "20060102-150405"
	scheduleAt    = regexp.MustCompile(`^([01]\d|2[0-3]):[0-5]\d$`)
)

// splitKey checks a backup key and returns its parts.
func splitKey(key string) (server, project, inst, stamp string, ok bool) {
	p := strings.Split(key, "/")
	if len(p) != 4 || !backupPart.MatchString(p[0]) || !backupPart.MatchString(p[1]) || !backupPart.MatchString(p[2]) || !backupStamp.MatchString(p[3]) {
		return "", "", "", "", false
	}
	return p[0], p[1], p[2], p[3], true
}

// backupStore is where backups go.
type backupStore interface {
	put(ctx context.Context, name string, r io.Reader) (int64, error)
	get(ctx context.Context, name string) (io.ReadCloser, error)
	del(ctx context.Context, name string) error
	list(ctx context.Context, prefix string) ([]string, error)
}

type dirStore struct{ root string }

func (d dirStore) path(name string) string { return filepath.Join(d.root, filepath.FromSlash(name)) }

func (d dirStore) put(ctx context.Context, name string, r io.Reader) (int64, error) {
	p := d.path(name)
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return 0, err
	}
	f, err := os.OpenFile(p+".partial", os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return 0, err
	}
	n, err := io.Copy(f, ctxReader{ctx, r})
	if err == nil {
		err = f.Sync()
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Rename(p+".partial", p)
	}
	if err != nil {
		os.Remove(p + ".partial")
	}
	return n, err
}

func (d dirStore) get(ctx context.Context, name string) (io.ReadCloser, error) {
	f, err := os.Open(d.path(name))
	if os.IsNotExist(err) {
		return nil, errNoBackup
	}
	return f, err
}

func (d dirStore) del(ctx context.Context, name string) error {
	err := os.Remove(d.path(name))
	if os.IsNotExist(err) {
		return nil
	}
	return err
}

func (d dirStore) list(ctx context.Context, prefix string) ([]string, error) {
	var out []string
	base := d.path(prefix)
	err := filepath.WalkDir(base, func(p string, e os.DirEntry, err error) error {
		if err != nil {
			if os.IsNotExist(err) {
				return filepath.SkipDir
			}
			return err
		}
		if !e.IsDir() {
			rel, _ := filepath.Rel(d.root, p)
			out = append(out, filepath.ToSlash(rel))
		}
		return nil
	})
	return out, err
}

type ctxReader struct {
	ctx context.Context
	r   io.Reader
}

func (c ctxReader) Read(b []byte) (int, error) {
	if err := c.ctx.Err(); err != nil {
		return 0, err
	}
	return c.r.Read(b)
}

// prefixed adds a target's prefix to the names it stores.
type prefixed struct {
	backupStore
	prefix string
}

// name keeps a trailing slash: list("srv/proj/web/") must not match "web2/".
func (p prefixed) name(n string) string {
	j := path.Join(p.prefix, n)
	if strings.HasSuffix(n, "/") && j != "/" {
		j += "/"
	}
	return j
}
func (p prefixed) put(ctx context.Context, n string, r io.Reader) (int64, error) {
	return p.backupStore.put(ctx, p.name(n), r)
}
func (p prefixed) get(ctx context.Context, n string) (io.ReadCloser, error) {
	return p.backupStore.get(ctx, p.name(n))
}
func (p prefixed) del(ctx context.Context, n string) error { return p.backupStore.del(ctx, p.name(n)) }
func (p prefixed) list(ctx context.Context, n string) ([]string, error) {
	l, err := p.backupStore.list(ctx, p.name(n))
	for i := range l {
		l[i] = strings.TrimPrefix(strings.TrimPrefix(l[i], p.prefix), "/")
	}
	return l, err
}

func openTarget(t BackupTarget) (backupStore, error) {
	switch t.Type {
	case "dir":
		if !filepath.IsAbs(t.Path) {
			return nil, errors.New("the backup directory must be an absolute path")
		}
		return dirStore{t.Path}, nil
	case "s3":
		c, err := newS3(t)
		if err != nil {
			return nil, err
		}
		return prefixed{c, strings.Trim(t.Prefix, "/")}, nil
	}
	return nil, fmt.Errorf("unknown target type %q", t.Type)
}

func (a *App) backupTarget(name string) (BackupTarget, backupStore, error) {
	for _, t := range a.store.Get().Backups.Targets {
		if t.Name == name {
			s, err := openTarget(t)
			return t, s, err
		}
	}
	return BackupTarget{}, nil, fmt.Errorf("no backup target named %q", name)
}

// listBackups returns the backups under a key prefix, newest first.
func listBackups(ctx context.Context, st backupStore, target, prefix string) ([]BackupMeta, error) {
	names, err := st.list(ctx, prefix)
	if err != nil {
		return nil, err
	}
	out := []BackupMeta{}
	for _, n := range names {
		if !strings.HasPrefix(n, prefix) {
			continue
		}
		key, ok := strings.CutSuffix(n, ".json")
		if _, _, _, _, valid := splitKey(key); !ok || !valid {
			continue
		}
		r, err := st.get(ctx, n)
		if err != nil {
			continue
		}
		var m BackupMeta
		err = json.NewDecoder(io.LimitReader(r, 64<<10)).Decode(&m)
		r.Close()
		if err != nil {
			continue
		}
		// The key and target come from where the file is, not from its contents.
		m.Key, m.Target = key, target
		m.Server, m.Project, m.Instance, _, _ = splitKey(key)
		out = append(out, m)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Created.After(out[j].Created) })
	return out, nil
}

// backupInstance exports one instance to a target.
func (a *App) backupInstance(ctx context.Context, c *incusConn, t BackupTarget, st backupStore, server, project, inst, schedule, by string, set func(float64, string)) (*BackupMeta, error) {
	return a.backupInstanceNamed(ctx, c, t, st, server, project, inst, schedule, by, "", false, set)
}

// backupInstanceNamed is backupInstance with a label kept in the backup's
// metadata, and optionally in the storage driver's own format.
func (a *App) backupInstanceNamed(ctx context.Context, c *incusConn, t BackupTarget, st backupStore, server, project, inst, schedule, by, label string, optimized bool, set func(float64, string)) (*BackupMeta, error) {
	b, err := c.call(ctx, "GET", "/1.0/instances/"+url.PathEscape(inst), project, nil)
	if err != nil {
		return nil, err
	}
	var info struct {
		Type    string                       `json:"type"`
		Devices map[string]map[string]string `json:"expanded_devices"`
	}
	_ = json.Unmarshal(b, &info)

	now := time.Now().UTC()
	m := &BackupMeta{Key: server + "/" + project + "/" + inst + "/" + now.Format(backupTimeFmt), Target: t.Name, Server: server, Project: project, Instance: inst, Type: info.Type, Created: now, Schedule: schedule, By: by, Name: label, Optimized: optimized, Encrypted: t.Passphrase != ""}
	m.Volumes = attachedVolumes(info.Devices)
	if _, _, _, _, ok := splitKey(m.Key); !ok {
		return nil, fmt.Errorf("can't back up %s: the server, project or instance name doesn't fit a file name", inst)
	}

	set(0.05, "Incus is making the backup")
	bname := "iwui-" + now.Format(backupTimeFmt)
	base := "/1.0/instances/" + url.PathEscape(inst) + "/backups"
	_, err = c.call(ctx, "POST", base, project, map[string]any{
		"name": bname, "instance_only": true, "optimized_storage": optimized,
		"expires_at": now.Add(24 * time.Hour).Format(time.RFC3339),
	})
	if err != nil {
		return nil, fmt.Errorf("Incus couldn't make the backup: %w", err)
	}
	defer func() {
		cctx, cancel := context.WithTimeout(context.Background(), time.Minute)
		defer cancel()
		if _, err := c.call(cctx, "DELETE", base+"/"+bname, project, nil); err != nil {
			log.Printf("backup: delete %s on %s: %v", bname, server, err)
		}
	}()

	// Removes what was written so far when a later step fails.
	fail := func(err error) (*BackupMeta, error) {
		for _, f := range m.files() {
			st.del(context.WithoutCancel(ctx), f)
		}
		return nil, err
	}
	set(0.3, "Copying to "+t.Name)
	m.Size, m.SHA256, err = exportTo(ctx, c, base+"/"+bname+"/export", project, st, m.dataFile(), t.Passphrase)
	if err != nil {
		return fail(fmt.Errorf("writing to %s: %w", t.Name, err))
	}
	for i := range m.Volumes {
		v := &m.Volumes[i]
		set(0.5+0.4*float64(i)/float64(len(m.Volumes)), "Backing up volume "+v.Name)
		v.Size, v.SHA256, err = backupVolume(ctx, c, project, *v, bname, optimized, now, st, m.volFile(i), t.Passphrase)
		if err != nil {
			return fail(fmt.Errorf("volume %s: %w", v.Name, err))
		}
	}
	meta, _ := json.MarshalIndent(m, "", "  ")
	if _, err := st.put(ctx, m.Key+".json", strings.NewReader(string(meta))); err != nil {
		return fail(fmt.Errorf("writing to %s: %w", t.Name, err))
	}
	return m, nil
}

// attachedVolumes lists the custom volumes among an instance's disks, sorted
// by device name. Host paths, the root disk and snapshots of volumes are left out.
func attachedVolumes(devs map[string]map[string]string) []VolumeMeta {
	var out []VolumeMeta
	for name, d := range devs {
		if d["type"] != "disk" || d["pool"] == "" || d["source"] == "" || d["path"] == "/" || strings.Contains(d["source"], "/") {
			continue
		}
		out = append(out, VolumeMeta{Device: name, Pool: d["pool"], Name: d["source"], Dev: d})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Device < out[j].Device })
	return out
}

// exportTo streams an Incus backup export to a file on the target.
func exportTo(ctx context.Context, c *incusConn, path, project string, st backupStore, name, pass string) (int64, string, error) {
	resp, err := c.do(ctx, "GET", path, project, nil, nil)
	if err != nil {
		return 0, "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return 0, "", fmt.Errorf("Incus refused the export (%s)", resp.Status)
	}
	return putBackupFile(ctx, st, name, resp.Body, pass)
}

func volumePath(pool, name string) string {
	return "/1.0/storage-pools/" + url.PathEscape(pool) + "/volumes/custom/" + url.PathEscape(name)
}

// backupVolume has Incus make a backup of one custom volume and copies it to the target.
func backupVolume(ctx context.Context, c *incusConn, project string, v VolumeMeta, bname string, optimized bool, now time.Time, st backupStore, file, pass string) (int64, string, error) {
	base := volumePath(v.Pool, v.Name) + "/backups"
	_, err := c.call(ctx, "POST", base, project, map[string]any{
		"name": bname, "volume_only": true, "optimized_storage": optimized,
		"expires_at": now.Add(24 * time.Hour).Format(time.RFC3339),
	})
	if err != nil {
		return 0, "", fmt.Errorf("Incus couldn't make the backup: %w", err)
	}
	defer func() {
		cctx, cancel := context.WithTimeout(context.Background(), time.Minute)
		defer cancel()
		if _, err := c.call(cctx, "DELETE", base+"/"+bname, project, nil); err != nil {
			log.Printf("backup: delete volume backup %s of %s: %v", bname, v.Name, err)
		}
	}()
	return exportTo(ctx, c, base+"/"+bname+"/export", project, st, file, pass)
}

// checkReader fails the last read when the data's SHA-256 is not the one
// the backup was made with, so Incus gets a broken upload and refuses it.
type checkReader struct {
	r    io.Reader
	h    hash.Hash
	want string
}

func (c *checkReader) Read(b []byte) (int, error) {
	n, err := c.r.Read(b)
	c.h.Write(b[:n])
	if err == io.EOF && hex.EncodeToString(c.h.Sum(nil)) != c.want {
		return n, errors.New("the backup's checksum doesn't match: the file is damaged")
	}
	return n, err
}

// restoreBackup creates a new instance from a backup, with its custom
// volumes. A volume comes back under its old name when that is free, else as
// <instance>-<volume>. It returns the volumes it made, as pool/name.
func (a *App) restoreBackup(ctx context.Context, c *incusConn, st backupStore, pass string, m BackupMeta, project, name, pool string) ([]string, error) {
	var made []string
	undo := func() {
		cctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()
		for _, pv := range made {
			p, v, _ := strings.Cut(pv, "/")
			if _, err := c.call(cctx, "DELETE", volumePath(p, v), project, nil); err != nil {
				log.Printf("restore: remove volume %s: %v", pv, err)
			}
		}
	}
	// Restored volumes that got another name or pool are attached under the same device name.
	moved := map[string]map[string]string{}
	for i, v := range m.Volumes {
		vpool := v.Pool
		if pool != "" {
			vpool = pool
		}
		vname, err := freeVolumeName(ctx, c, project, vpool, v.Name, name)
		if err != nil {
			undo()
			return nil, err
		}
		if err := restoreVolume(ctx, c, st, pass, m, i, project, vpool, vname); err != nil {
			undo()
			return nil, fmt.Errorf("volume %s: %w", v.Name, err)
		}
		made = append(made, vpool+"/"+vname)
		if vname != v.Name || vpool != v.Pool {
			d := maps.Clone(v.Dev)
			d["pool"], d["source"] = vpool, vname
			moved[v.Device] = d
		}
	}
	if err := a.restoreInstance(ctx, c, st, pass, m, project, name, pool); err != nil {
		undo()
		return nil, err
	}
	if len(moved) > 0 {
		if _, err := c.call(ctx, "PATCH", "/1.0/instances/"+url.PathEscape(name), project, map[string]any{"devices": moved}); err != nil {
			// The new instance still points at the original volumes. Don't
			// leave it around where someone could start it on them.
			cctx, cancel := context.WithTimeout(context.Background(), time.Minute)
			defer cancel()
			if _, derr := c.call(cctx, "DELETE", "/1.0/instances/"+url.PathEscape(name), project, nil); derr != nil {
				log.Printf("restore: remove %s: %v", name, derr)
			}
			undo()
			return nil, fmt.Errorf("attaching the restored volumes failed, so the restore was undone: %w", err)
		}
	}
	return made, nil
}

// freeVolumeName picks a name for a restored volume that isn't used yet.
func freeVolumeName(ctx context.Context, c *incusConn, project, pool, want, inst string) (string, error) {
	cands := []string{want, inst + "-" + want}
	for i := 2; i < 20; i++ {
		cands = append(cands, fmt.Sprintf("%s-%s-%d", inst, want, i))
	}
	for _, n := range cands {
		_, err := c.call(ctx, "GET", volumePath(pool, n), project, nil)
		var ie *incusErr
		if errors.As(err, &ie) && ie.Status == http.StatusNotFound {
			return n, nil
		}
		if err != nil && !errors.As(err, &ie) {
			return "", err
		}
	}
	return "", fmt.Errorf("can't find a free name for volume %s", want)
}

func restoreVolume(ctx context.Context, c *incusConn, st backupStore, pass string, m BackupMeta, i int, project, pool, name string) error {
	r, err := openBackupFile(ctx, st, m.volFile(i), m.Encrypted, pass)
	if err != nil {
		return err
	}
	defer r.Close()
	body := io.Reader(r)
	if v := m.Volumes[i]; v.SHA256 != "" {
		body = &checkReader{r: r, h: sha256.New(), want: v.SHA256}
	}
	hdr := map[string]string{"Content-Type": "application/octet-stream", "X-Incus-name": name}
	_, err = c.send(ctx, "POST", "/1.0/storage-pools/"+url.PathEscape(pool)+"/volumes/custom", project, body, hdr)
	return err
}

// restoreInstance imports the instance itself.
func (a *App) restoreInstance(ctx context.Context, c *incusConn, st backupStore, pass string, m BackupMeta, project, name, pool string) error {
	r, err := openBackupFile(ctx, st, m.dataFile(), m.Encrypted, pass)
	if err != nil {
		return err
	}
	defer r.Close()
	hdr := map[string]string{"Content-Type": "application/octet-stream", "X-Incus-name": name}
	if pool != "" {
		hdr["X-Incus-pool"] = pool
	}
	body := io.Reader(r)
	if m.SHA256 != "" {
		body = &checkReader{r: r, h: sha256.New(), want: m.SHA256}
	}
	start := time.Now().Add(-time.Minute) // allow for clock skew
	if _, err := c.send(ctx, "POST", "/1.0/instances", project, body, hdr); err != nil {
		// A failed import can leave a half-made instance. Remove it only if
		// this restore made it, not one that had the name already.
		cctx, cancel := context.WithTimeout(context.Background(), time.Minute)
		defer cancel()
		var ie *incusErr
		conflict := errors.As(err, &ie) && (ie.Status == http.StatusConflict || strings.Contains(ie.Msg, "already exists"))
		if b, gerr := c.call(cctx, "GET", "/1.0/instances/"+url.PathEscape(name), project, nil); gerr == nil && !conflict {
			var in struct {
				CreatedAt time.Time `json:"created_at"`
			}
			if json.Unmarshal(b, &in) == nil && in.CreatedAt.After(start) {
				_, _ = c.call(cctx, "DELETE", "/1.0/instances/"+url.PathEscape(name), project, nil)
			}
		}
		return fmt.Errorf("restore: %w", err)
	}
	return nil
}

// prune deletes a schedule's backups of one instance beyond what it keeps:
// the newest backup of each of the last KeepDaily days and of the last
// KeepWeekly weeks. Backups made by hand are not touched.
func prune(list []BackupMeta, s BackupSchedule) (drop []BackupMeta) {
	var mine []BackupMeta
	for _, m := range list {
		if m.Schedule == s.Name {
			mine = append(mine, m)
		}
	}
	sort.Slice(mine, func(i, j int) bool { return mine[i].Created.After(mine[j].Created) })
	keep := map[string]bool{}
	days, weeks := map[string]bool{}, map[string]bool{}
	for _, m := range mine {
		t := m.Created.Local()
		d := t.Format("2006-01-02")
		y, w := t.ISOWeek()
		wk := fmt.Sprintf("%d-%d", y, w)
		if !days[d] && len(days) < s.KeepDaily {
			days[d] = true
			keep[m.Key] = true
		}
		if !weeks[wk] && len(weeks) < s.KeepWeekly {
			weeks[wk] = true
			keep[m.Key] = true
		}
	}
	for i, m := range mine {
		if i > 0 && !keep[m.Key] {
			drop = append(drop, m)
		}
	}
	return drop
}

// --- schedules ----------------------------------------------------------------

type scheduleState struct {
	LastRun   time.Time `json:"last_run,omitzero"`
	LastOK    bool      `json:"last_ok"`
	LastError string    `json:"last_error,omitempty"`
	Running   bool      `json:"running"`
	// Since is when the UI first saw the schedule. A new schedule waits for
	// its next time instead of running at once.
	Since time.Time `json:"since,omitzero"`
}

type scheduler struct {
	mu    sync.Mutex
	path  string
	state map[string]*scheduleState
}

func (s *scheduler) load(path string) {
	s.path = path
	s.state = map[string]*scheduleState{}
	if b, err := os.ReadFile(path); err == nil {
		_ = json.Unmarshal(b, &s.state)
	}
	for _, st := range s.state {
		st.Running = false
	}
}

func (s *scheduler) saveLocked() {
	b, _ := json.Marshal(s.state)
	tmp := s.path + ".tmp"
	if os.WriteFile(tmp, b, 0o600) == nil {
		_ = os.Rename(tmp, s.path)
	}
}

func (s *scheduler) get(name string) scheduleState {
	s.mu.Lock()
	defer s.mu.Unlock()
	if st := s.state[name]; st != nil {
		return *st
	}
	return scheduleState{}
}

// due says whether a schedule should run now: its time today has passed and
// it hasn't run since. A UI that was down at that time catches up.
func due(sc BackupSchedule, st scheduleState, now time.Time) bool {
	if sc.Paused || st.Running {
		return false
	}
	if len(sc.Days) > 0 && !slices.Contains(sc.Days, int(now.Weekday())) {
		return false
	}
	var h, m int
	if _, err := fmt.Sscanf(sc.At, "%d:%d", &h, &m); err != nil {
		return false
	}
	at := time.Date(now.Year(), now.Month(), now.Day(), h, m, 0, 0, now.Location())
	return !now.Before(at) && st.LastRun.Before(at) && st.Since.Before(at)
}

func (a *App) runSchedules(ctx context.Context) {
	t := time.NewTicker(30 * time.Second)
	defer t.Stop()
	for {
		now := time.Now()
		for _, sc := range a.store.Get().Backups.Schedules {
			a.sched.mu.Lock()
			if a.sched.state[sc.Name] == nil {
				a.sched.state[sc.Name] = &scheduleState{Since: now}
				a.sched.saveLocked()
			}
			a.sched.mu.Unlock()
			if due(sc, a.sched.get(sc.Name), now) {
				a.startSchedule(sc)
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// startSchedule runs a schedule as a job. Only one run of a schedule at a time.
func (a *App) startSchedule(sc BackupSchedule) *Job {
	a.sched.mu.Lock()
	st := a.sched.state[sc.Name]
	if st == nil {
		st = &scheduleState{}
		a.sched.state[sc.Name] = st
	}
	if st.Running {
		a.sched.mu.Unlock()
		return nil
	}
	st.Running, st.LastRun = true, time.Now()
	a.sched.saveLocked()
	a.sched.mu.Unlock()

	return a.jobs.start("backup", "Scheduled backup "+sc.Name, nil, sc.Server, sc.Project, func(ctx context.Context, set func(float64, string)) (jobResult, error) {
		note, err := a.runSchedule(ctx, sc, set)
		if err != nil && !errors.Is(err, context.Canceled) {
			title := "Backup " + sc.Name + " failed"
			if strings.Contains(err.Error(), "test restore failed") {
				title = "Test restore of " + sc.Name + " failed"
			}
			a.alert(alertMsg{Kind: alertBackup, Title: title, Body: err.Error(), Server: sc.Server, Bad: true})
		}
		a.sched.mu.Lock()
		st.Running, st.LastOK, st.LastError = false, err == nil, ""
		if err != nil {
			st.LastError = err.Error()
		}
		a.sched.saveLocked()
		a.sched.mu.Unlock()
		return jobResult{Note: note}, err
	})
}

func (a *App) runSchedule(ctx context.Context, sc BackupSchedule, set func(float64, string)) (string, error) {
	t, st, err := a.backupTarget(sc.Target)
	if err != nil {
		return "", err
	}
	c, err := a.conn(sc.Server)
	if err != nil {
		return "", err
	}
	insts := sc.Instances
	if len(insts) == 0 {
		b, err := c.call(ctx, "GET", "/1.0/instances", sc.Project, nil)
		if err != nil {
			return "", err
		}
		var urls []string
		_ = json.Unmarshal(b, &urls)
		for _, u := range urls {
			insts = append(insts, path.Base(strings.SplitN(u, "?", 2)[0]))
		}
	}
	var failed []string
	var done int
	for i, inst := range insts {
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		step := func(x float64, d string) {
			set((float64(i)+x)/float64(len(insts)), inst+": "+d)
		}
		m, err := a.backupInstanceNamed(ctx, c, t, st, sc.Server, sc.Project, inst, sc.Name, "", "", sc.Optimized, step)
		if err != nil {
			failed = append(failed, inst+": "+err.Error())
			continue
		}
		done++
		a.audit.add(AuditEntry{Time: time.Now(), User: "schedule:" + sc.Name, Server: sc.Server, Project: sc.Project, Action: "backup " + inst, Status: 200})
		list, err := listBackups(ctx, st, t.Name, path.Dir(m.Key)+"/")
		if err == nil {
			list = slices.DeleteFunc(list, func(x BackupMeta) bool { return x.Instance != inst })
			for _, old := range prune(list, sc) {
				deleteBackupFiles(ctx, st, old)
			}
		}
		if sc.TestRestore && time.Now().Weekday() == testRestoreDay(sc) {
			step(0.9, "test restore")
			if err := a.testRestore(ctx, c, st, t.Passphrase, *m); err != nil {
				failed = append(failed, inst+": the test restore failed: "+err.Error())
			}
		}
	}
	if len(failed) > 0 {
		return "", fmt.Errorf("%d of %d backups failed. %s", len(failed), len(insts), strings.Join(failed, "; "))
	}
	return fmt.Sprintf("Backed up %d instances to %s.", done, t.Name), nil
}

// testRestoreDay is the day of the week a schedule test-restores on: Sunday
// when it runs then, else the first day it runs, counting from Monday.
func testRestoreDay(sc BackupSchedule) time.Weekday {
	if len(sc.Days) == 0 || slices.Contains(sc.Days, 0) {
		return time.Sunday
	}
	return time.Weekday(slices.Min(sc.Days))
}

// testRestore restores a backup under a temporary name and removes it.
func (a *App) testRestore(ctx context.Context, c *incusConn, st backupStore, pass string, m BackupMeta) error {
	name := "restore-test-" + randHex(3)
	made, err := a.restoreBackup(ctx, c, st, pass, m, m.Project, name, "")
	cctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	if err == nil || len(made) > 0 {
		if _, derr := c.call(cctx, "DELETE", "/1.0/instances/"+name, m.Project, nil); err == nil {
			err = derr
		}
	}
	for _, pv := range made {
		p, v, _ := strings.Cut(pv, "/")
		if _, derr := c.call(cctx, "DELETE", volumePath(p, v), m.Project, nil); err == nil {
			err = derr
		}
	}
	return err
}

// --- HTTP ---------------------------------------------------------------------

func (a *App) handleBackupConfigGet(w http.ResponseWriter, r *http.Request) {
	b := a.store.Get().Backups
	for i := range b.Targets {
		if b.Targets[i].SecretKey != "" {
			b.Targets[i].SecretKey = secretMask
		}
		if b.Targets[i].Passphrase != "" {
			b.Targets[i].Passphrase = secretMask
		}
	}
	for i := range b.PBS {
		b.PBS[i].Secret = secretMask
	}
	type sched struct {
		BackupSchedule
		State scheduleState `json:"state"`
	}
	out := struct {
		Targets   []BackupTarget `json:"targets"`
		Schedules []sched        `json:"schedules"`
		PBS       []PBSServer    `json:"pbs"`
	}{Targets: append([]BackupTarget{}, b.Targets...), Schedules: []sched{}, PBS: append([]PBSServer{}, b.PBS...)}
	for _, s := range b.Schedules {
		out.Schedules = append(out.Schedules, sched{s, a.sched.get(s.Name)})
	}
	writeJSON(w, out)
}

func (a *App) handleBackupConfigPut(w http.ResponseWriter, r *http.Request) {
	var in Backups
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&in); err != nil {
		jsonError(w, http.StatusBadRequest, "bad request")
		return
	}
	err := a.store.Update(func(c *Config) error {
		old := map[string]BackupTarget{}
		for _, t := range c.Backups.Targets {
			old[t.Name] = t
		}
		names := map[string]bool{}
		for i := range in.Targets {
			t := &in.Targets[i]
			if !backupPart.MatchString(t.Name) || names[t.Name] {
				return fmt.Errorf("target name %q is empty, invalid or used twice", t.Name)
			}
			names[t.Name] = true
			// A renamed target has no saved secrets to fall back on. Ask for
			// them again rather than quietly saving it without encryption.
			prev, had := old[t.Name]
			if t.SecretKey == secretMask {
				if !had || prev.SecretKey == "" {
					return fmt.Errorf("target %s: enter the secret key again", t.Name)
				}
				t.SecretKey = prev.SecretKey
			}
			if t.Passphrase == secretMask {
				if !had || prev.Passphrase == "" {
					return fmt.Errorf("target %s: enter the passphrase again", t.Name)
				}
				t.Passphrase = prev.Passphrase
			}
			if t.Passphrase != "" && len(t.Passphrase) < 12 {
				return fmt.Errorf("target %s: use a passphrase of at least 12 characters", t.Name)
			}
			if t.Type == "s3" && (t.Bucket == "" || t.AccessKey == "" || t.SecretKey == "") {
				return fmt.Errorf("target %s needs a bucket, an access key and a secret key", t.Name)
			}
			if _, err := openTarget(*t); err != nil {
				return fmt.Errorf("target %s: %w", t.Name, err)
			}
		}
		pnames := map[string]bool{}
		for i := range in.PBS {
			p := &in.PBS[i]
			if !backupPart.MatchString(p.Name) || pnames[p.Name] {
				return fmt.Errorf("backup server name %q is empty, invalid or used twice", p.Name)
			}
			pnames[p.Name] = true
			if p.Secret == secretMask {
				p.Secret = savedPBSSecret(c.Backups.PBS, *p)
				if p.Secret == "" {
					return fmt.Errorf("backup server %s: type the secret again after changing the address or token", p.Name)
				}
			}
			if _, err := p.client(); err != nil {
				return fmt.Errorf("backup server %s: %w", p.Name, err)
			}
		}
		snames := map[string]bool{}
		for _, s := range in.Schedules {
			switch {
			case !backupPart.MatchString(s.Name) || snames[s.Name]:
				return fmt.Errorf("schedule name %q is empty, invalid or used twice", s.Name)
			case !names[s.Target]:
				return fmt.Errorf("schedule %s: no target named %q", s.Name, s.Target)
			case !scheduleAt.MatchString(s.At):
				return fmt.Errorf("schedule %s: the time must look like 03:00", s.Name)
			case !validDays(s.Days):
				return fmt.Errorf("schedule %s: the days of the week must be 0 (Sunday) to 6, each once", s.Name)
			case s.KeepDaily < 1 || s.KeepDaily > 366 || s.KeepWeekly < 0 || s.KeepWeekly > 520:
				return fmt.Errorf("schedule %s: keep 1 to 366 recent backups and 0 to 520 weekly ones", s.Name)
			case !slices.ContainsFunc(c.Servers, func(x ServerConfig) bool { return x.Name == s.Server }):
				return fmt.Errorf("schedule %s: no server named %q", s.Name, s.Server)
			}
			snames[s.Name] = true
		}
		c.Backups = in
		return nil
	})
	if err != nil {
		jsonError(w, http.StatusBadRequest, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleBackupTargets lists target names for anyone who may back up.
func (a *App) handleBackupTargets(w http.ResponseWriter, r *http.Request) {
	out := []map[string]string{}
	for _, t := range a.store.Get().Backups.Targets {
		out = append(out, map[string]string{"name": t.Name, "type": t.Type})
	}
	writeJSON(w, out)
}

// handleBackupTest writes, reads and deletes a small file on a target.
func (a *App) handleBackupTest(w http.ResponseWriter, r *http.Request) {
	var t BackupTarget
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&t); err != nil {
		jsonError(w, http.StatusBadRequest, "bad request")
		return
	}
	for _, o := range a.store.Get().Backups.Targets {
		if o.Name == t.Name {
			if t.SecretKey == secretMask {
				t.SecretKey = o.SecretKey
			}
			if t.Passphrase == secretMask {
				t.Passphrase = o.Passphrase
			}
		}
	}
	st, err := openTarget(t)
	if err == nil {
		ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
		defer cancel()
		name := ".incus-webui-test-" + randHex(4)
		if _, _, err = putBackupFile(ctx, st, name, strings.NewReader("ok"), t.Passphrase); err == nil {
			var rc io.ReadCloser
			if rc, err = openBackupFile(ctx, st, name, t.Passphrase != "", t.Passphrase); err == nil {
				var b []byte
				b, err = io.ReadAll(rc)
				rc.Close()
				if err == nil && string(b) != "ok" {
					err = errors.New("the test file came back different")
				}
			}
			if derr := st.del(ctx, name); err == nil {
				err = derr
			}
		}
	}
	if err != nil {
		jsonError(w, http.StatusBadRequest, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleBackups lists the backups of a project, or of one instance, on all
// targets. Needs the viewer role on the project. Project "*" lists the
// backups of every project the user may view on this server.
func (a *App) handleBackups(w http.ResponseWriter, r *http.Request) {
	s, _ := a.currentSession(r)
	q := r.URL.Query()
	server, project, inst := r.PathValue("server"), q.Get("project"), q.Get("instance")
	if project == "" {
		project = "default"
	}
	all := project == "*"
	if !backupPart.MatchString(server) || (!all && !backupPart.MatchString(project)) || (inst != "" && (all || !backupPart.MatchString(inst))) {
		jsonError(w, http.StatusBadRequest, "bad name")
		return
	}
	access := a.store.Get().Access
	if s == nil || (!all && roleFor(access, s, server, project) < RoleViewer) {
		jsonError(w, http.StatusForbidden, deniedMsg(RoleViewer, project))
		return
	}
	prefix := server + "/"
	if !all {
		prefix += project + "/"
		if inst != "" {
			prefix += inst + "/"
		}
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	out := []BackupMeta{}
	var errs []string
	for _, t := range a.store.Get().Backups.Targets {
		st, err := openTarget(t)
		if err == nil {
			var l []BackupMeta
			if l, err = listBackups(ctx, st, t.Name, prefix); err == nil {
				for _, m := range l {
					if !all || roleFor(access, s, server, m.Project) >= RoleViewer {
						out = append(out, m)
					}
				}
			}
		}
		if err != nil {
			errs = append(errs, t.Name+": "+err.Error())
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Created.After(out[j].Created) })
	writeJSON(w, map[string]any{"backups": out, "errors": errs})
}

func (a *App) handleBackupRun(w http.ResponseWriter, r *http.Request) {
	s, _ := a.currentSession(r)
	var in struct{ Project, Instance, Target, Name string }
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&in); err != nil {
		jsonError(w, http.StatusBadRequest, "bad request")
		return
	}
	if in.Name != "" && !backupPart.MatchString(in.Name) {
		jsonError(w, http.StatusBadRequest, "Pick a name with letters, numbers, dashes, dots and underscores.")
		return
	}
	server := r.PathValue("server")
	if in.Project == "" {
		in.Project = "default"
	}
	if roleFor(a.store.Get().Access, s, server, in.Project) < RoleManager {
		jsonError(w, http.StatusForbidden, deniedMsg(RoleManager, in.Project))
		return
	}
	t, st, err := a.backupTarget(in.Target)
	if err != nil {
		jsonError(w, http.StatusBadRequest, err.Error())
		return
	}
	c, err := a.conn(server)
	if err != nil {
		jsonError(w, http.StatusBadRequest, err.Error())
		return
	}
	title := "Back up " + in.Instance + " to " + t.Name
	if in.Name != "" {
		title = "Snapshot " + in.Instance + " to " + t.Name + " as " + in.Name
	}
	job := a.jobs.start("backup", title, s, server, in.Project, func(ctx context.Context, set func(float64, string)) (jobResult, error) {
		m, err := a.backupInstanceNamed(ctx, c, t, st, server, in.Project, in.Instance, "", s.User, in.Name, false, set)
		if err != nil {
			return jobResult{}, err
		}
		return jobResult{Note: fmt.Sprintf("Saved %s to %s.", bytesStr(m.Size), t.Name)}, nil
	})
	writeJSON(w, map[string]string{"job": job.ID})
}

// backupFor finds a backup by target and key and checks the user's role on
// the project it came from.
func (a *App) backupFor(w http.ResponseWriter, r *http.Request, target, key string, min Role) (*BackupMeta, backupStore, string, bool) {
	s, _ := a.currentSession(r)
	server, project, _, _, ok := splitKey(key)
	if !ok {
		jsonError(w, http.StatusBadRequest, "bad backup key")
		return nil, nil, "", false
	}
	if roleFor(a.store.Get().Access, s, server, project) < min {
		jsonError(w, http.StatusForbidden, deniedMsg(min, project))
		return nil, nil, "", false
	}
	t, st, err := a.backupTarget(target)
	if err != nil {
		jsonError(w, http.StatusBadRequest, err.Error())
		return nil, nil, "", false
	}
	l, err := listBackups(r.Context(), st, target, path.Dir(key)+"/")
	if err != nil {
		jsonError(w, http.StatusBadGateway, err.Error())
		return nil, nil, "", false
	}
	for _, m := range l {
		if m.Key == key {
			return &m, st, t.Passphrase, true
		}
	}
	jsonError(w, http.StatusNotFound, errNoBackup.Error())
	return nil, nil, "", false
}

func (a *App) handleBackupDownload(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	m, st, pass, ok := a.backupFor(w, r, q.Get("target"), q.Get("key"), RoleManager)
	if !ok {
		return
	}
	file, name, size := m.dataFile(), m.Instance+"-"+m.Created.UTC().Format(backupTimeFmt)+".tar", m.Size
	if v := q.Get("volume"); v != "" {
		i, err := strconv.Atoi(v)
		if err != nil || i < 0 || i >= len(m.Volumes) {
			jsonError(w, http.StatusNotFound, "no such volume in this backup")
			return
		}
		file, name, size = m.volFile(i), m.Instance+"-"+m.Volumes[i].Name+"-"+m.Created.UTC().Format(backupTimeFmt)+".tar", m.Volumes[i].Size
	}
	rc, err := openBackupFile(r.Context(), st, file, m.Encrypted, pass)
	if err != nil {
		jsonError(w, http.StatusBadGateway, err.Error())
		return
	}
	defer rc.Close()
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", `attachment; filename="`+name+`"`)
	if size > 0 {
		w.Header().Set("Content-Length", fmt.Sprint(size))
	}
	_, _ = io.Copy(w, rc)
}

func (a *App) handleBackupDelete(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	m, st, _, ok := a.backupFor(w, r, q.Get("target"), q.Get("key"), RoleManager)
	if !ok {
		return
	}
	if err := deleteBackupFiles(r.Context(), st, *m); err != nil {
		jsonError(w, http.StatusBadGateway, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *App) handleBackupRestore(w http.ResponseWriter, r *http.Request) {
	s, _ := a.currentSession(r)
	var in struct{ Target, Key, Server, Project, Name, Pool string }
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&in); err != nil {
		jsonError(w, http.StatusBadRequest, "bad request")
		return
	}
	m, st, pass, ok := a.backupFor(w, r, in.Target, in.Key, RoleManager)
	if !ok {
		return
	}
	if in.Server == "" {
		in.Server = m.Server
	}
	if in.Project == "" {
		in.Project = m.Project
	}
	if roleFor(a.store.Get().Access, s, in.Server, in.Project) < RoleManager {
		jsonError(w, http.StatusForbidden, deniedMsg(RoleManager, in.Project))
		return
	}
	if !backupPart.MatchString(in.Name) || strings.ContainsAny(in.Name, "._") {
		jsonError(w, http.StatusBadRequest, "Pick a name with letters, numbers and dashes.")
		return
	}
	c, err := a.conn(in.Server)
	if err != nil {
		jsonError(w, http.StatusBadRequest, err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	if _, err := c.call(ctx, "GET", "/1.0/instances/"+url.PathEscape(in.Name), in.Project, nil); err == nil {
		jsonError(w, http.StatusConflict, fmt.Sprintf("An instance named %s already exists. Pick another name.", in.Name))
		return
	}
	job := a.jobs.start("restore", "Restore "+m.Instance+" as "+in.Name, s, in.Server, in.Project, func(ctx context.Context, set func(float64, string)) (jobResult, error) {
		set(0.1, "Sending the backup to Incus")
		made, err := a.restoreBackup(ctx, c, st, pass, *m, in.Project, in.Name, in.Pool)
		if err != nil {
			return jobResult{}, err
		}
		var note string
		if len(made) > 0 {
			note = "Restored with its volumes " + strings.Join(made, ", ") + "."
		}
		return jobResult{Note: note, Link: "/instances/" + url.PathEscape(in.Server) + "/" + url.PathEscape(in.Name) + "?project=" + url.QueryEscape(in.Project)}, nil
	})
	writeJSON(w, map[string]string{"job": job.ID})
}

func (a *App) handleScheduleRun(w http.ResponseWriter, r *http.Request) {
	for _, sc := range a.store.Get().Backups.Schedules {
		if sc.Name == r.PathValue("name") {
			if j := a.startSchedule(sc); j != nil {
				writeJSON(w, map[string]string{"job": j.ID})
			} else {
				jsonError(w, http.StatusConflict, "This schedule is running already.")
			}
			return
		}
	}
	jsonError(w, http.StatusNotFound, "No such schedule.")
}

// validDays checks a schedule's weekdays: empty (every day) or distinct 0..6.
func validDays(d []int) bool {
	seen := map[int]bool{}
	for _, x := range d {
		if x < 0 || x > 6 || seen[x] {
			return false
		}
		seen[x] = true
	}
	return true
}

func bytesStr(n int64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	div, exp := int64(unit), 0
	for m := n / unit; m >= unit; m /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %ciB", float64(n)/float64(div), "KMGTPE"[exp])
}
