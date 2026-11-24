package proxmox

// Backups on a Proxmox Backup Server. The server decodes its chunked
// formats on download, so what arrives here is a pxar stream (containers)
// or a raw disk image (VMs).

import (
	"archive/tar"
	"bytes"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/baki2001/incus-webui/internal/pxar"
	"github.com/baki2001/incus-webui/internal/qcow2"
)

// PxarImage writes a unified Incus image (metadata.yaml plus rootfs/) from
// a container backup in pxar format. payload is nil for a single-file
// archive (root.pxar) and the .ppxar stream for a split one. Like
// ContainerImage, IDs stored shifted (100000 and up) are shifted back.
func PxarImage(w io.Writer, meta, payload io.Reader, p *Plan, arch string) error {
	tw := tar.NewWriter(w)
	now := time.Now()
	m, err := metadata(p, arch, now)
	if err != nil {
		return err
	}
	if err := writeFile(tw, "metadata.yaml", m, now); err != nil {
		return err
	}
	shift := 0
	err = pxar.Walk(meta, payload, func(e *pxar.Entry, data io.Reader) error {
		if e.Path == "" && e.UID >= 100000 {
			shift = e.UID
		}
		h := &tar.Header{Name: "rootfs/" + e.Path, Mode: e.Mode, Uid: e.UID, Gid: e.GID, ModTime: e.MTime, Format: tar.FormatPAX}
		if shift > 0 {
			h.Uid, h.Gid = unshift(h.Uid, shift), unshift(h.Gid, shift)
		}
		switch e.Kind {
		case pxar.Dir:
			h.Typeflag = tar.TypeDir
			if e.Path != "" {
				h.Name += "/"
			}
		case pxar.File:
			h.Typeflag, h.Size = tar.TypeReg, e.Size
		case pxar.Symlink:
			h.Typeflag, h.Linkname = tar.TypeSymlink, e.Link
		case pxar.Hardlink:
			if e.Link == "" || strings.Contains("/"+e.Link+"/", "/../") {
				return fmt.Errorf("the backup contains an unsafe link %q", e.Link)
			}
			h.Typeflag, h.Linkname = tar.TypeLink, "rootfs/"+e.Link
			h.Mode, h.Uid, h.Gid = 0, 0, 0
		case pxar.CharDev, pxar.BlockDev:
			h.Typeflag = tar.TypeChar
			if e.Kind == pxar.BlockDev {
				h.Typeflag = tar.TypeBlock
			}
			h.Devmajor, h.Devminor = e.Major, e.Minor
		case pxar.Fifo:
			h.Typeflag = tar.TypeFifo
		case pxar.Socket:
			return nil // tar can't hold sockets; programs make them again
		}
		for k, v := range e.Xattrs {
			if h.PAXRecords == nil {
				h.PAXRecords = map[string]string{}
			}
			h.PAXRecords["SCHILY.xattr."+k] = v
		}
		if err := tw.WriteHeader(h); err != nil {
			return fmt.Errorf("write image entry %s: %w", h.Name, err)
		}
		if data != nil {
			if _, err := io.Copy(tw, data); err != nil {
				return fmt.Errorf("copy %s: %w", h.Name, err)
			}
		}
		return nil
	})
	if err != nil {
		return fmt.Errorf("read backup: %w", err)
	}
	return tw.Close()
}

// RawDisk reads a raw disk image of the given size from r. With q set it
// writes a qcow2 image to w; otherwise it writes the data at its offsets,
// skipping zeros, so w should be an empty file truncated to size. It
// returns the first 64 KiB, which hold the partition table. progress gets
// the bytes read so far.
func RawDisk(r io.Reader, size int64, w io.WriterAt, q bool, progress func(int64)) ([]byte, error) {
	var qw *qcow2.Writer
	if q {
		var err error
		if qw, err = qcow2.NewWriter(w, size); err != nil {
			return nil, err
		}
	}
	buf := make([]byte, qcow2.ClusterSize)
	zero := make([]byte, qcow2.ClusterSize)
	var head []byte
	for n := int64(0); n*qcow2.ClusterSize < size; n++ {
		want := min(size-n*qcow2.ClusterSize, qcow2.ClusterSize)
		if _, err := io.ReadFull(r, buf[:want]); err != nil {
			return nil, fmt.Errorf("read disk at %d: %w", n*qcow2.ClusterSize, err)
		}
		clear(buf[want:])
		if n == 0 {
			head = bytes.Clone(buf)
		}
		if progress != nil && n%64 == 0 {
			progress(n * qcow2.ClusterSize)
		}
		if bytes.Equal(buf, zero) {
			continue
		}
		var err error
		if qw != nil {
			err = qw.WriteCluster(n, buf)
		} else {
			_, err = w.WriteAt(buf[:want], n*qcow2.ClusterSize)
		}
		if err != nil {
			return nil, err
		}
	}
	if extra, _ := io.CopyN(io.Discard, r, 1); extra > 0 {
		return nil, errors.New("the disk image is larger than its index says")
	}
	if qw != nil {
		if err := qw.Close(); err != nil {
			return nil, err
		}
	}
	if progress != nil {
		progress(size)
	}
	return head, nil
}
