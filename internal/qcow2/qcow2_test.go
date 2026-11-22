package qcow2

import (
	"bytes"
	"math/rand"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// TestQemuImgAgrees writes a sparse image in random cluster order and asks
// qemu-img, which Incus uses to unpack VM images, to check it and compare it
// with the raw source. Skipped when qemu-img isn't installed.
func TestQemuImgAgrees(t *testing.T) {
	qemu, err := exec.LookPath("qemu-img")
	if err != nil {
		t.Skip("qemu-img not installed")
	}
	for _, size := range []int64{512, ClusterSize, 3*ClusterSize + 512, 600 << 20} {
		dir := t.TempDir()
		raw := make([]byte, size)
		rng := rand.New(rand.NewSource(size))
		clusters := (size + ClusterSize - 1) / ClusterSize
		for c := int64(0); c < clusters; c++ {
			if rng.Intn(3) == 0 { // a third of the clusters get data
				start := c * ClusterSize
				end := min(start+ClusterSize, size)
				rng.Read(raw[start : start+(end-start)/2+1])
			}
		}
		rawPath := filepath.Join(dir, "disk.raw")
		if err := os.WriteFile(rawPath, raw, 0o644); err != nil {
			t.Fatal(err)
		}
		f, err := os.Create(filepath.Join(dir, "disk.qcow2"))
		if err != nil {
			t.Fatal(err)
		}
		q, err := NewWriter(f, size)
		if err != nil {
			t.Fatal(err)
		}
		for _, c := range rng.Perm(int(clusters)) {
			buf := make([]byte, ClusterSize)
			copy(buf, raw[int64(c)*ClusterSize:min(int64(c+1)*ClusterSize, size)])
			if err := q.WriteCluster(int64(c), buf); err != nil {
				t.Fatal(err)
			}
		}
		if err := q.Close(); err != nil {
			t.Fatal(err)
		}
		f.Close()

		for _, args := range [][]string{
			{"check", "-f", "qcow2", f.Name()},
			{"compare", "-f", "qcow2", "-F", "raw", f.Name(), rawPath},
		} {
			out, err := exec.Command(qemu, args...).CombinedOutput()
			if err != nil {
				t.Fatalf("size %d: qemu-img %s: %v\n%s", size, args[0], err, out)
			}
		}
		// The same conversion Incus runs when it unpacks a VM image.
		back := filepath.Join(dir, "back.raw")
		if out, err := exec.Command(qemu, "convert", "-f", "qcow2", "-O", "raw", f.Name(), back).CombinedOutput(); err != nil {
			t.Fatalf("convert: %v\n%s", err, out)
		}
		got, _ := os.ReadFile(back)
		if !bytes.Equal(got, raw) {
			t.Fatalf("size %d: converted image differs from the source", size)
		}
	}
}

func TestRejectsBadWrites(t *testing.T) {
	var b bytes.Buffer
	_ = b
	q, _ := NewWriter(discard{}, 2*ClusterSize)
	data := bytes.Repeat([]byte{1}, ClusterSize)
	if err := q.WriteCluster(2, data); err == nil {
		t.Error("cluster past the end was accepted")
	}
	if err := q.WriteCluster(0, data[:10]); err == nil {
		t.Error("short cluster was accepted")
	}
	if err := q.WriteCluster(0, data); err != nil {
		t.Fatal(err)
	}
	if err := q.WriteCluster(0, data); err == nil {
		t.Error("duplicate cluster was accepted")
	}
}

type discard struct{}

func (discard) WriteAt(p []byte, _ int64) (int, error) { return len(p), nil }
