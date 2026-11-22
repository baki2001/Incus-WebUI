package vma

import (
	"bytes"
	"errors"
	"io"
	"math/rand"
	"testing"
)

func sample(t testing.TB) ([]Disk, []byte) {
	rng := rand.New(rand.NewSource(1))
	a := make([]byte, 5*ClusterSize+1000) // odd size: last cluster is partial
	b := make([]byte, 2*ClusterSize)
	rng.Read(a[:ClusterSize])                            // full cluster
	rng.Read(a[3*ClusterSize+8192 : 3*ClusterSize+9000]) // one 4K block
	rng.Read(a[5*ClusterSize:])                          // partial tail
	rng.Read(b[ClusterSize:])
	disks := []Disk{{"drive-scsi0", a}, {"drive-efidisk0", b}}
	var buf bytes.Buffer
	cfg := map[string][]byte{"qemu-server.conf": []byte("cores: 2\nmemory: 2048\n")}
	if err := Write(&buf, [16]byte{1, 2, 3}, cfg, disks); err != nil {
		t.Fatal(err)
	}
	return disks, buf.Bytes()
}

func readAll(data []byte) (*Reader, map[int][]byte, error) {
	r, err := NewReader(bytes.NewReader(data))
	if err != nil {
		return nil, nil, err
	}
	out := map[int][]byte{}
	for id, d := range r.Devices {
		out[id] = make([]byte, d.Clusters()*ClusterSize)
	}
	for {
		c, err := r.Next()
		if err == io.EOF {
			return r, out, nil
		}
		if err != nil {
			return r, out, err
		}
		if !c.Zero {
			copy(out[c.Device][c.Num*ClusterSize:], c.Data)
		}
	}
}

func TestRoundTrip(t *testing.T) {
	disks, data := sample(t)
	r, out, err := readAll(data)
	if err != nil {
		t.Fatal(err)
	}
	if string(r.Configs["qemu-server.conf"]) != "cores: 2\nmemory: 2048\n" {
		t.Errorf("config = %q", r.Configs["qemu-server.conf"])
	}
	for i, d := range disks {
		dev := r.Devices[i+1]
		if dev.Name != d.Name || dev.Size != int64(len(d.Data)) {
			t.Errorf("device %d = %+v", i+1, dev)
		}
		if !bytes.Equal(out[i+1][:len(d.Data)], d.Data) {
			t.Errorf("%s contents differ", d.Name)
		}
	}
}

func TestDamage(t *testing.T) {
	_, data := sample(t)
	cases := map[string]func([]byte) []byte{
		"header byte":   func(b []byte) []byte { b[13000] ^= 1; return b },
		"extent header": func(b []byte) []byte { b[12288+512+100] ^= 1; return b },
		"truncated":     func(b []byte) []byte { return b[:len(b)-4096] },
		"missing last extent": func(b []byte) []byte {
			// Cut at the last extent's start, so the archive ends cleanly but short.
			last := bytes.LastIndex(b, extentMagic)
			return b[:last]
		},
	}
	for name, f := range cases {
		d := f(append([]byte(nil), data...))
		if _, _, err := readAll(d); err == nil {
			t.Errorf("%s: damaged archive was accepted", name)
		}
	}
}

func FuzzReader(f *testing.F) {
	_, data := sample(f)
	f.Add(data)
	f.Fuzz(func(t *testing.T, b []byte) {
		r, err := NewReader(bytes.NewReader(b))
		if err != nil {
			return
		}
		for i := 0; i < 10000; i++ {
			if _, err := r.Next(); err != nil {
				if errors.Is(err, io.EOF) {
					return
				}
				return
			}
		}
	})
}
