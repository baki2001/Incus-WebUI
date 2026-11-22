package proxmox

import (
	"archive/tar"
	"bufio"
	"compress/gzip"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/baki2001/incus-webui/internal/qcow2"
	"github.com/baki2001/incus-webui/internal/vma"
	"github.com/klauspost/compress/zstd"
	"gopkg.in/yaml.v3"
)

// Open opens a vzdump file and undoes its compression (zstd, gzip or none).
// vzdump's default is zstd; lzo is refused with a hint.
func Open(path string) (io.ReadCloser, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	br := bufio.NewReaderSize(f, 1<<20)
	magic, _ := br.Peek(4)
	closeBoth := func(c io.Closer) io.ReadCloser { return readCloser{br, c, f} }
	switch {
	case len(magic) == 4 && magic[0] == 0x28 && magic[1] == 0xb5 && magic[2] == 0x2f && magic[3] == 0xfd:
		d, err := zstd.NewReader(br, zstd.WithDecoderConcurrency(2), zstd.WithDecoderMaxWindow(1<<31))
		if err != nil {
			f.Close()
			return nil, err
		}
		return readCloser{d, closerFunc(func() error { d.Close(); return nil }), f}, nil
	case len(magic) >= 2 && magic[0] == 0x1f && magic[1] == 0x8b:
		g, err := gzip.NewReader(br)
		if err != nil {
			f.Close()
			return nil, err
		}
		return readCloser{g, g, f}, nil
	case len(magic) == 4 && magic[0] == 0x89 && magic[1] == 'L' && magic[2] == 'Z' && magic[3] == 'O':
		f.Close()
		return nil, errors.New("this backup is compressed with LZO, which isn't supported. Make a new backup in Proxmox with ZSTD compression (the default)")
	}
	return closeBoth(nil), nil
}

type readCloser struct {
	io.Reader
	inner io.Closer
	file  *os.File
}

func (r readCloser) Close() error {
	if r.inner != nil {
		r.inner.Close()
	}
	return r.file.Close()
}

type closerFunc func() error

func (f closerFunc) Close() error { return f() }

// Kind tells a VM backup (VMA) from a container backup (tar).
func Kind(path string) (string, error) {
	r, err := Open(path)
	if err != nil {
		return "", err
	}
	defer r.Close()
	head := make([]byte, 512)
	if _, err := io.ReadFull(r, head); err != nil {
		return "", errors.New("the file is too short to be a Proxmox backup")
	}
	if string(head[:4]) == "VMA\x00" {
		return "virtual-machine", nil
	}
	if string(head[257:262]) == "ustar" {
		return "container", nil
	}
	return "", errors.New("this is not a Proxmox vzdump backup (expected a .vma or .tar file, optionally .zst or .gz)")
}

const confPath = "etc/vzdump/pct.conf"

func cleanName(n string) string {
	n = strings.TrimPrefix(n, "./")
	n = strings.TrimPrefix(n, "/")
	return n
}

// ContainerConf finds pct.conf inside a container backup.
func ContainerConf(path string) (*Conf, error) {
	r, err := Open(path)
	if err != nil {
		return nil, err
	}
	defer r.Close()
	tr := tar.NewReader(r)
	for {
		h, err := tr.Next()
		if err == io.EOF {
			return nil, errors.New("the backup has no etc/vzdump/pct.conf, so it isn't a Proxmox container backup")
		}
		if err != nil {
			return nil, fmt.Errorf("read backup: %w", err)
		}
		if cleanName(h.Name) == confPath {
			b, err := io.ReadAll(io.LimitReader(tr, 1<<20))
			if err != nil {
				return nil, err
			}
			return ParseConf(b)
		}
	}
}

// Arch maps a Proxmox architecture name to the one Incus uses.
func Arch(pve string) string {
	if pve == "arm64" {
		return "aarch64"
	}
	return "x86_64"
}

func metadata(p *Plan, arch string, ctime time.Time) ([]byte, error) {
	m := map[string]any{
		"architecture":  arch,
		"creation_date": ctime.Unix(),
		"properties": map[string]string{
			"description": "Imported from Proxmox: " + p.Name,
			"os":          p.OS,
		},
	}
	return yaml.Marshal(m)
}

func writeFile(tw *tar.Writer, name string, data []byte, ctime time.Time) error {
	if err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0o644, Size: int64(len(data)), ModTime: ctime, Typeflag: tar.TypeReg}); err != nil {
		return err
	}
	_, err := tw.Write(data)
	return err
}

// ContainerImage writes a unified Incus image (metadata.yaml plus rootfs/)
// built from a container backup. Files owned by the host-side ID range of an
// unprivileged container (100000 and up) are shifted back to container IDs,
// since Incus does its own shifting.
func ContainerImage(w io.Writer, path string, p *Plan, arch string) error {
	r, err := Open(path)
	if err != nil {
		return err
	}
	defer r.Close()
	tr := tar.NewReader(r)
	tw := tar.NewWriter(w)
	now := time.Now()
	meta, err := metadata(p, arch, now)
	if err != nil {
		return err
	}
	if err := writeFile(tw, "metadata.yaml", meta, now); err != nil {
		return err
	}
	shift, first := 0, true
	for {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return fmt.Errorf("read backup: %w", err)
		}
		name := cleanName(h.Name)
		if first && (name == "" || name == ".") {
			// The root directory tells us whether IDs are shifted.
			if h.Uid >= 100000 {
				shift = h.Uid
			}
		}
		first = false
		if name == "etc/vzdump" || strings.HasPrefix(name, "etc/vzdump/") {
			continue
		}
		if strings.Contains("/"+name+"/", "/../") {
			return fmt.Errorf("the backup contains an unsafe path %q", h.Name)
		}
		h.Name = "rootfs/" + name
		if h.Typeflag == tar.TypeLink {
			h.Linkname = "rootfs/" + cleanName(h.Linkname)
		}
		if h.Typeflag == tar.TypeGNUSparse {
			h.Typeflag = tar.TypeReg
		}
		for k := range h.PAXRecords {
			if strings.HasPrefix(k, "GNU.sparse.") {
				delete(h.PAXRecords, k)
			}
		}
		if shift > 0 {
			h.Uid = unshift(h.Uid, shift)
			h.Gid = unshift(h.Gid, shift)
		}
		h.Uname, h.Gname = "", ""
		if len(h.PAXRecords) > 0 {
			h.Format = tar.FormatPAX
		} else {
			h.Format = tar.FormatUnknown
		}
		if err := tw.WriteHeader(h); err != nil {
			return fmt.Errorf("write image entry %s: %w", h.Name, err)
		}
		if h.Typeflag == tar.TypeReg {
			if _, err := io.Copy(tw, tr); err != nil {
				return fmt.Errorf("copy %s: %w", h.Name, err)
			}
		}
	}
	return tw.Close()
}

// unshift maps a host ID back into the container. IDs below the range
// (which a shifted container can't own) become nobody.
func unshift(id, base int) int {
	if id < base || id >= base+65536 {
		return 65534
	}
	return id - base
}

// VMMetadata is the metadata tarball of a VM image. The disk goes with it as
// rootfs.img (qcow2).
func VMMetadata(p *Plan) ([]byte, error) {
	var b strings.Builder
	tw := tar.NewWriter(&b)
	now := time.Now()
	meta, err := metadata(p, "x86_64", now)
	if err != nil {
		return nil, err
	}
	if err := writeFile(tw, "metadata.yaml", meta, now); err != nil {
		return nil, err
	}
	if err := tw.Close(); err != nil {
		return nil, err
	}
	return []byte(b.String()), nil
}

// VMConfig reads only the header of a VMA backup: its config and disks.
func VMConfig(path string) (*Conf, map[string]int64, error) {
	r, err := Open(path)
	if err != nil {
		return nil, nil, err
	}
	defer r.Close()
	v, err := vma.NewReader(r)
	if err != nil {
		return nil, nil, err
	}
	raw, ok := v.Configs["qemu-server.conf"]
	if !ok {
		// vzdump always names it qemu-server.conf; a hand-made archive may not.
		for name, b := range v.Configs {
			if strings.HasSuffix(name, ".conf") {
				if ok {
					return nil, nil, errors.New("the backup has more than one VM config")
				}
				raw, ok = b, true
			}
		}
	}
	if !ok {
		return nil, nil, errors.New("the backup has no qemu-server.conf")
	}
	c, err := ParseConf(raw)
	if err != nil {
		return nil, nil, err
	}
	devs := map[string]int64{}
	for _, d := range v.Devices {
		devs[d.Name] = d.Size
	}
	return c, devs, nil
}

// Progress is called with bytes of disk data processed so far and the total.
type Progress func(done, total int64)

// VMDisks reads a VMA backup once and writes the wanted disks as qcow2
// images. out maps VMA device names to the files to write.
func VMDisks(path string, out map[string]io.WriterAt, progress Progress) error {
	r, err := Open(path)
	if err != nil {
		return err
	}
	defer r.Close()
	v, err := vma.NewReader(r)
	if err != nil {
		return err
	}
	writers := map[int]*qcow2.Writer{}
	var total int64
	for id, d := range v.Devices {
		if w, ok := out[d.Name]; ok {
			q, err := qcow2.NewWriter(w, d.Size)
			if err != nil {
				return err
			}
			writers[id] = q
		}
		if d.Name != "vmstate" {
			total += d.Clusters() * vma.ClusterSize
		}
	}
	if len(writers) != len(out) {
		return errors.New("a disk to import is not in the backup")
	}
	var done int64
	for {
		c, err := v.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		done += vma.ClusterSize
		if progress != nil && done%(256*vma.ClusterSize) == 0 {
			progress(done, total)
		}
		q, ok := writers[c.Device]
		if !ok || c.Zero {
			continue
		}
		if err := q.WriteCluster(c.Num, c.Data); err != nil {
			return err
		}
	}
	for _, q := range writers {
		if err := q.Close(); err != nil {
			return err
		}
	}
	if progress != nil {
		progress(total, total)
	}
	return nil
}
