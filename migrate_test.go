package main

import (
	"bytes"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/baki2001/incus-webui/internal/pbs"
	"github.com/baki2001/incus-webui/internal/proxmox"
)

// TestVolumeBackupIncus checks that Incus takes the volume backup we build
// for extra VM disks, and keeps its contents. It needs the incus CLI.
func TestVolumeBackupIncus(t *testing.T) {
	if os.Getenv("INCUS_WEBUI_INCUS") == "" {
		t.Skip("INCUS_WEBUI_INCUS not set")
	}
	img := make([]byte, 8<<20)
	copy(img[3<<20:], "data disk")
	path := filepath.Join(t.TempDir(), "vol.tar.gz")
	var buf bytes.Buffer
	if err := volumeBackup(&buf, "default", "iwui-test-vol", bytes.NewReader(img), int64(len(img))); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(path, buf.Bytes(), 0o600)
	exec.Command("incus", "storage", "volume", "delete", "default", "iwui-test-vol").Run()
	if out, err := exec.Command("incus", "storage", "volume", "import", "default", path, "iwui-test-vol").CombinedOutput(); err != nil {
		t.Fatalf("import: %v\n%s", err, out)
	}
	defer exec.Command("incus", "storage", "volume", "delete", "default", "iwui-test-vol").Run()
	out, _ := exec.Command("incus", "storage", "volume", "show", "default", "iwui-test-vol").CombinedOutput()
	if !strings.Contains(string(out), "content_type: block") {
		t.Errorf("volume is not a block volume:\n%s", out)
	}
	back := filepath.Join(t.TempDir(), "back.tar.gz")
	if out, err := exec.Command("incus", "storage", "volume", "export", "default", "iwui-test-vol", back).CombinedOutput(); err != nil {
		t.Fatalf("export: %v\n%s", err, out)
	}
	out, err := exec.Command("tar", "-xzOf", back, "backup/volume.img").Output()
	if err != nil || !bytes.Equal(out, img) {
		t.Errorf("the volume's contents changed (%d bytes, %v)", len(out), err)
	}
}

// TestImportIncus runs the whole import, as the UI does, against the local
// Incus. Set INCUS_WEBUI_IMPORT to a vzdump backup. VMs start only with KVM.
// INCUS_WEBUI_IMPORT_NOTE, if set, must appear in the job's note.
func TestImportIncus(t *testing.T) {
	src := os.Getenv("INCUS_WEBUI_IMPORT")
	if src == "" {
		t.Skip("INCUS_WEBUI_IMPORT not set")
	}
	a := testApp(t)
	a.dataDir = t.TempDir()
	a.backends = &Backends{transports: map[string]*backend{}}
	_ = a.store.Update(func(c *Config) error {
		c.Servers = []ServerConfig{{Name: "local", URL: "unix:///var/lib/incus/unix.socket"}}
		return nil
	})
	c, err := a.conn("local")
	if err != nil {
		t.Fatal(err)
	}
	f := &importFile{ID: randHex(8), User: "t", Name: filepath.Base(src)}
	os.MkdirAll(a.importDir(), 0o700)
	if err := os.Symlink(src, a.importPath(f.ID)); err != nil {
		t.Fatal(err)
	}
	if f.Kind, err = proxmox.Kind(src); err != nil {
		t.Fatal(err)
	}
	importAndCheck(t, a, c, a.fileSource(f), f.Kind == "container")
}

// TestImportPBS imports a snapshot from a Proxmox Backup Server into the
// local Incus. INCUS_WEBUI_PBS is https://token-id:secret@host:port/datastore
// and INCUS_WEBUI_PBS_SNAP the snapshot (ct/110/1732406937, or ct/110 for
// the newest);
// INCUS_WEBUI_PBS_FP is the server's certificate fingerprint.
func TestImportPBS(t *testing.T) {
	raw, ref := os.Getenv("INCUS_WEBUI_PBS"), os.Getenv("INCUS_WEBUI_PBS_SNAP")
	if raw == "" || ref == "" {
		t.Skip("INCUS_WEBUI_PBS or INCUS_WEBUI_PBS_SNAP not set")
	}
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	secret, _ := u.User.Password()
	pc, err := pbs.New("https://"+u.Host, strings.Trim(u.Path, "/"), "", u.User.Username(), secret, os.Getenv("INCUS_WEBUI_PBS_FP"))
	if err != nil {
		t.Fatal(err)
	}
	// type/id picks the newest snapshot of that guest.
	if strings.Count(ref, "/") == 1 {
		list, err := pc.Snapshots(t.Context())
		if err != nil {
			t.Fatal(err)
		}
		var newest int64
		for _, x := range list {
			if x.Type+"/"+x.ID == ref && x.Time > newest {
				newest = x.Time
			}
		}
		ref += "/" + strconv.FormatInt(newest, 10)
	}
	snap, err := pc.Snapshot(t.Context(), ref)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("snapshot files: %+v", snap.Files)
	a := testApp(t)
	a.dataDir = t.TempDir()
	a.backends = &Backends{transports: map[string]*backend{}}
	_ = a.store.Update(func(c *Config) error {
		c.Servers = []ServerConfig{{Name: "local", URL: "unix:///var/lib/incus/unix.socket"}}
		return nil
	})
	c, err := a.conn("local")
	if err != nil {
		t.Fatal(err)
	}
	importAndCheck(t, a, c, pbsSource("pbs", pc, snap), snap.Type == "ct")
}

// importAndCheck runs an import as the UI does and checks the result.
func importAndCheck(t *testing.T, a *App, c *incusConn, src importSource, container bool) {
	t.Helper()
	q := importReq{Server: "local", Project: "default", Network: "incusbr0", Pool: "default", KeepMAC: true}
	_, kvm := os.Stat("/dev/kvm")
	q.Start = container || kvm == nil
	p, err := src.plan(t.Context(), q.options())
	if err != nil {
		t.Fatal(err)
	}
	p.Name = "iwui-imp-" + p.Name
	t.Logf("plan: %+v", p)
	cleanup := func() {
		exec.Command("incus", "delete", "-f", p.Name).Run()
		for _, d := range p.ExtraDisks {
			exec.Command("incus", "storage", "volume", "delete", "default", extraVolName(p.Name, d.Key)).Run()
		}
	}
	cleanup()
	t.Cleanup(cleanup)
	note, err := a.runImport(t.Context(), c, src, p, q, func(x float64, d string) { t.Logf("%3.0f%% %s", x*100, d) })
	if err != nil {
		if kvm != nil && strings.Contains(err.Error(), "KVM support is missing") {
			t.Skip("no KVM")
		}
		t.Fatal(err)
	}
	t.Logf("note: %s", note)
	if want := os.Getenv("INCUS_WEBUI_IMPORT_NOTE"); want != "" && !strings.Contains(note, want) {
		t.Errorf("note %q lacks %q", note, want)
	}
	if q.Start && !strings.Contains(note, "Running at") {
		t.Errorf("the instance got no address: %s", note)
	}
	if out, _ := exec.Command("incus", "image", "list", "-c", "d", "--format=csv").Output(); strings.Contains(string(out), p.Name) {
		t.Error("the import left its image behind")
	}
	for _, d := range p.ExtraDisks {
		out, err := exec.Command("incus", "config", "device", "get", p.Name, d.Key, "source").Output()
		if err != nil || strings.TrimSpace(string(out)) != extraVolName(p.Name, d.Key) {
			t.Errorf("disk %s is not attached: %s %v", d.Key, out, err)
		}
	}
}
