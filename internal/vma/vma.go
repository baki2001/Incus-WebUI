// Package vma reads Proxmox VMA archives, the format vzdump writes VM backups in.
//
// The format is described in vma_spec.txt in Proxmox's pve-qemu repository:
// a header with the VM's config files and a device table, then extents that
// each hold up to 59 clusters of 64 KiB. Only non-zero 4 KiB blocks are stored.
// All numbers are big endian, except blob lengths, which are little endian.
//
// This is a fresh implementation from that description. It checks every
// checksum and bound the reference reader checks, so a damaged archive fails
// with an error instead of producing a damaged disk.
package vma

import (
	"bytes"
	"crypto/md5"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
)

const (
	BlockSize   = 4096
	ClusterSize = 65536

	extentHeaderSize = 512
	blocksPerExtent  = 59
	fixedHeaderSize  = 12288 // sizeof(VmaHeader)
	maxHeaderSize    = 16 << 20
	maxDevices       = 256
	maxConfigs       = 256
)

var (
	magic       = []byte{'V', 'M', 'A', 0}
	extentMagic = []byte{'V', 'M', 'A', 'E'}
)

// Device is one disk (or the saved RAM state) in the archive.
type Device struct {
	ID   int
	Name string // e.g. "drive-scsi0", "drive-efidisk0", "vmstate"
	Size int64  // bytes
}

// Clusters is the number of 64 KiB clusters the device spans.
func (d Device) Clusters() int64 { return (d.Size + ClusterSize - 1) / ClusterSize }

// Cluster is one 64 KiB piece of a device. Data always holds ClusterSize
// bytes (zero filled where the archive stored no block) and is only valid
// until the next call to Next.
type Cluster struct {
	Device int
	Num    int64
	Zero   bool // no data stored: the whole cluster reads as zeros
	Data   []byte
}

// Reader reads a VMA stream front to back.
type Reader struct {
	r       io.Reader
	UUID    [16]byte
	Ctime   int64
	Configs map[string][]byte // e.g. "qemu-server.conf"
	Devices map[int]Device

	seen   map[int][]uint64 // bitmap of clusters seen per device
	buf    []byte
	queue  []Cluster
	done   bool
	failed error
}

// NewReader reads and checks the header. The caller reads clusters with Next.
func NewReader(r io.Reader) (*Reader, error) {
	head := make([]byte, fixedHeaderSize)
	if _, err := io.ReadFull(r, head); err != nil {
		return nil, fmt.Errorf("read vma header: %w", err)
	}
	if !bytes.Equal(head[0:4], magic) {
		return nil, errors.New("not a vma file")
	}
	be := binary.BigEndian
	headerSize := be.Uint32(head[56:60])
	if headerSize <= fixedHeaderSize || headerSize > maxHeaderSize {
		return nil, fmt.Errorf("bad vma header size %d", headerSize)
	}
	full := make([]byte, headerSize)
	copy(full, head)
	if _, err := io.ReadFull(r, full[fixedHeaderSize:]); err != nil {
		return nil, fmt.Errorf("read vma header: %w", err)
	}

	var want [16]byte
	copy(want[:], full[32:48])
	clear(full[32:48])
	if md5.Sum(full) != want {
		return nil, errors.New("vma header checksum does not match")
	}
	copy(full[32:48], want[:])

	if v := be.Uint32(full[4:8]); v != 1 {
		return nil, fmt.Errorf("unsupported vma version %d", v)
	}
	v := &Reader{
		r:       r,
		Ctime:   int64(be.Uint64(full[24:32])),
		Configs: map[string][]byte{},
		Devices: map[int]Device{},
		seen:    map[int][]uint64{},
		buf:     make([]byte, extentHeaderSize+blocksPerExtent*ClusterSize),
	}
	copy(v.UUID[:], full[8:24])

	blobOff := be.Uint32(full[48:52])
	blobSize := be.Uint32(full[52:56])
	if blobOff+1 <= fixedHeaderSize || uint64(blobOff)+uint64(blobSize) > uint64(headerSize) {
		return nil, errors.New("bad vma blob buffer")
	}
	// Blobs are addressed by their offset from the blob buffer start. The
	// first byte of the buffer is unused, so offset 0 means "none".
	blobs := map[uint32][]byte{}
	for pos := blobOff + 1; pos+2 <= blobOff+blobSize; {
		n := uint32(full[pos]) | uint32(full[pos+1])<<8
		if pos+2+n <= blobOff+blobSize {
			blobs[pos-blobOff] = full[pos+2 : pos+2+n]
		}
		pos += n + 2
	}
	str := func(ptr uint32) (string, bool) {
		b, ok := blobs[ptr]
		if !ok || len(b) < 2 || b[len(b)-1] != 0 {
			return "", false
		}
		return string(b[:len(b)-1]), true
	}

	for i := 0; i < maxConfigs; i++ {
		np := be.Uint32(full[2044+4*i:])
		dp := be.Uint32(full[3068+4*i:])
		if np == 0 || dp == 0 {
			continue
		}
		name, ok := str(np)
		data, ok2 := blobs[dp]
		if !ok || !ok2 {
			return nil, errors.New("vma config table points outside the blob buffer")
		}
		v.Configs[name] = data
	}
	var total uint64
	for i := 1; i < maxDevices; i++ {
		off := 4096 + 32*i
		size := be.Uint64(full[off+8:])
		name, ok := str(be.Uint32(full[off:]))
		if size == 0 || !ok {
			continue
		}
		// 16 TiB in all, far above any homelab VM. The completeness check
		// keeps a bit per cluster, so this also bounds its memory (32 MiB).
		if total += size; size > 16<<40 || total > 16<<40 {
			return nil, fmt.Errorf("device %s is too large", name)
		}
		d := Device{ID: i, Name: name, Size: int64(size)}
		v.Devices[i] = d
		if name != "vmstate" {
			v.seen[i] = make([]uint64, (d.Clusters()+63)/64)
		}
	}
	if len(v.Devices) == 0 {
		return nil, errors.New("vma archive has no devices")
	}
	return v, nil
}

// Next returns the next cluster, or io.EOF after the last one. At the end it
// checks that every cluster of every disk was present exactly once.
func (v *Reader) Next() (*Cluster, error) {
	if v.failed != nil {
		return nil, v.failed
	}
	for len(v.queue) == 0 {
		if v.done {
			return nil, io.EOF
		}
		if err := v.readExtent(); err != nil {
			v.failed = err
			return nil, err
		}
	}
	c := v.queue[0]
	v.queue = v.queue[1:]
	return &c, nil
}

func (v *Reader) readExtent() error {
	h := v.buf[:extentHeaderSize]
	n, err := io.ReadFull(v.r, h)
	if err == io.EOF {
		v.done = true
		return v.checkComplete()
	}
	if err != nil {
		return fmt.Errorf("short vma extent header (%d bytes): %w", n, err)
	}
	var want [16]byte
	copy(want[:], h[24:40])
	clear(h[24:40])
	if md5.Sum(h) != want {
		return errors.New("vma extent checksum does not match")
	}
	if !bytes.Equal(h[0:4], extentMagic) || h[4] != 0 || h[5] != 0 {
		return errors.New("bad vma extent magic")
	}
	if !bytes.Equal(h[8:24], v.UUID[:]) {
		return errors.New("vma extent belongs to another archive")
	}
	be := binary.BigEndian
	blocks := int(be.Uint16(h[6:8]))
	if blocks > blocksPerExtent*16 {
		return errors.New("vma extent claims too many blocks")
	}
	body := v.buf[extentHeaderSize : extentHeaderSize+blocks*BlockSize]
	if _, err := io.ReadFull(v.r, body); err != nil {
		return fmt.Errorf("short vma extent: %w", err)
	}

	pos := 0
	v.queue = v.queue[:0]
	for i := 0; i < blocksPerExtent; i++ {
		info := be.Uint64(h[40+8*i:])
		num := int64(info & 0xffffffff)
		dev := int((info >> 32) & 0xff)
		mask := uint16(info >> 48)
		if dev == 0 {
			continue
		}
		d, ok := v.Devices[dev]
		if !ok {
			return fmt.Errorf("vma extent refers to unknown device %d", dev)
		}
		if d.Name != "vmstate" {
			if num >= d.Clusters() {
				return fmt.Errorf("cluster %d is past the end of %s", num, d.Name)
			}
			bm := v.seen[dev]
			if bm[num/64]&(1<<(num%64)) != 0 {
				return fmt.Errorf("cluster %d of %s appears twice", num, d.Name)
			}
			bm[num/64] |= 1 << (num % 64)
		}
		c := Cluster{Device: dev, Num: num, Zero: mask == 0}
		if mask != 0 {
			// Each cluster gets its own copy, since the queue holds a whole extent.
			data := make([]byte, ClusterSize)
			for j := 0; j < 16; j++ {
				if mask&(1<<j) == 0 {
					continue
				}
				if pos+BlockSize > len(body) {
					return errors.New("vma extent has fewer blocks than its clusters need")
				}
				copy(data[j*BlockSize:], body[pos:pos+BlockSize])
				pos += BlockSize
			}
			c.Data = data
		}
		v.queue = append(v.queue, c)
	}
	if pos != len(body) {
		return errors.New("vma extent has more blocks than its clusters use")
	}
	return nil
}

func (v *Reader) checkComplete() error {
	for id, bm := range v.seen {
		d := v.Devices[id]
		for c := int64(0); c < d.Clusters(); c++ {
			if bm[c/64]&(1<<(c%64)) == 0 {
				return fmt.Errorf("vma archive is missing cluster %d of %s (the backup is incomplete)", c, d.Name)
			}
		}
	}
	return nil
}
