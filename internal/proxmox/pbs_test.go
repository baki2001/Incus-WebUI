package proxmox

import (
	"archive/tar"
	"bytes"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/baki2001/incus-webui/internal/pxar"
	"github.com/baki2001/incus-webui/internal/qcow2"
)

func TestPxarImage(t *testing.T) {
	root := &pxar.Node{Mode: pxar.ModeDir | 0o755, UID: 100000, GID: 100000, Kids: map[string]*pxar.Node{
		"etc": {Mode: pxar.ModeDir | 0o755, UID: 100000, GID: 100000, Kids: map[string]*pxar.Node{
			"passwd": {Mode: pxar.ModeReg | 0o644, UID: 100000, GID: 100000, Data: "root:x:0:0::/root:/bin/sh\n"},
			"user":   {Mode: pxar.ModeReg | 0o600, UID: 101000, GID: 101000, Data: "u"},
		}},
		"ping": {Mode: pxar.ModeReg | 0o755, UID: 100000, GID: 100000, Data: "ELF", FCaps: "caps"},
		"pong": {Hardlink: true, Data: "ping"},
		"run":  {Mode: pxar.ModeDir | 0o755, UID: 100000, GID: 100000, Kids: map[string]*pxar.Node{"s": {Mode: pxar.ModeSock | 0o600}}},
	}}
	for _, split := range []bool{false, true} {
		meta, payload := pxar.Encode(root, split)
		var pr io.Reader
		if split {
			pr = bytes.NewReader(payload)
		}
		var out bytes.Buffer
		if err := PxarImage(&out, bytes.NewReader(meta), pr, &Plan{Name: "ct110", OS: "debian"}, "x86_64"); err != nil {
			t.Fatal(err)
		}
		tr := tar.NewReader(&out)
		got := map[string]*tar.Header{}
		for {
			h, err := tr.Next()
			if err == io.EOF {
				break
			}
			if err != nil {
				t.Fatal(err)
			}
			got[h.Name] = h
		}
		for name, want := range map[string]int{"rootfs/": 0, "rootfs/etc/passwd": 0, "rootfs/etc/user": 1000} {
			h := got[name]
			if h == nil {
				t.Fatalf("split=%v: %s missing; have %v", split, name, got)
			}
			if h.Uid != want || h.Gid != want {
				t.Errorf("%s: owner %d:%d, want %d", name, h.Uid, h.Gid, want)
			}
		}
		if got["metadata.yaml"] == nil {
			t.Error("no metadata.yaml")
		}
		if h := got["rootfs/pong"]; h == nil || h.Typeflag != tar.TypeLink || h.Linkname != "rootfs/ping" {
			t.Errorf("hardlink: %+v", h)
		}
		if h := got["rootfs/ping"]; h == nil || h.PAXRecords["SCHILY.xattr.security.capability"] != "caps" {
			t.Errorf("file capabilities: %+v", h)
		}
		if got["rootfs/run/s"] != nil {
			t.Error("a socket made it into the image")
		}
	}
}

func TestRawDisk(t *testing.T) {
	size := int64(5*qcow2.ClusterSize + 100)
	disk := make([]byte, size)
	copy(disk[0:], "MBR")
	copy(disk[3*qcow2.ClusterSize+7:], "data")
	copy(disk[size-4:], "tail")
	dir := t.TempDir()

	raw, _ := os.Create(filepath.Join(dir, "raw"))
	raw.Truncate(size)
	head, err := RawDisk(bytes.NewReader(disk), size, raw, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	if string(head[:3]) != "MBR" || len(head) != qcow2.ClusterSize {
		t.Errorf("head %q", head[:3])
	}
	raw.Close()
	b, _ := os.ReadFile(raw.Name())
	if !bytes.Equal(b, disk) {
		t.Error("raw copy differs")
	}

	q, _ := os.Create(filepath.Join(dir, "q"))
	if _, err := RawDisk(bytes.NewReader(disk), size, q, true, nil); err != nil {
		t.Fatal(err)
	}
	q.Close()
	st, _ := os.Stat(q.Name())
	if st.Size() > 12*qcow2.ClusterSize {
		t.Errorf("qcow2 is %d bytes; zero clusters were not skipped", st.Size())
	}

	r2, _ := os.Create(filepath.Join(dir, "r2"))
	defer r2.Close()
	if _, err := RawDisk(bytes.NewReader(disk[:size-1]), size, r2, false, nil); err == nil {
		t.Error("short disk: no error")
	}
	q2, _ := os.Create(filepath.Join(dir, "q2"))
	defer q2.Close()
	if _, err := RawDisk(bytes.NewReader(append(disk, 1)), size, q2, true, nil); err == nil || !strings.Contains(err.Error(), "larger") {
		t.Error("long disk: no error")
	}
}
