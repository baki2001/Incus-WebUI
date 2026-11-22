package vma

import (
	"crypto/md5"
	"encoding/binary"
	"errors"
	"io"
)

// Disk is input for Write: a device name and its contents.
type Disk struct {
	Name string
	Data []byte
}

// Write produces a VMA archive. It exists for tests: real archives come from
// Proxmox. Clusters of all disks are interleaved, like vzdump does when it
// backs up several disks at once, so tests exercise the same paths.
func Write(w io.Writer, uuid [16]byte, configs map[string][]byte, disks []Disk) error {
	be := binary.BigEndian
	var blob []byte
	blob = append(blob, 0) // offset 0 means "none"
	add := func(b []byte) uint32 {
		off := uint32(len(blob))
		blob = append(blob, byte(len(b)), byte(len(b)>>8))
		blob = append(blob, b...)
		return off
	}
	head := make([]byte, fixedHeaderSize)
	i := 0
	for name, data := range configs {
		be.PutUint32(head[2044+4*i:], add(append([]byte(name), 0)))
		be.PutUint32(head[3068+4*i:], add(data))
		i++
	}
	for d, disk := range disks {
		off := 4096 + 32*(d+1)
		be.PutUint32(head[off:], add(append([]byte(disk.Name), 0)))
		be.PutUint64(head[off+8:], uint64(len(disk.Data)))
	}
	blobSize := (len(blob) + 511) / 512 * 512
	full := append(head, make([]byte, blobSize)...)
	copy(full[fixedHeaderSize:], blob)
	copy(full[0:4], magic)
	be.PutUint32(full[4:], 1)
	copy(full[8:24], uuid[:])
	be.PutUint32(full[48:], fixedHeaderSize)
	be.PutUint32(full[52:], uint32(blobSize))
	be.PutUint32(full[56:], uint32(len(full)))
	sum := md5.Sum(full)
	copy(full[32:48], sum[:])
	if _, err := w.Write(full); err != nil {
		return err
	}

	type ref struct {
		dev int
		num int64
	}
	if len(disks) == 0 {
		return errors.New("no disks")
	}
	var order []ref
	for n, more := int64(0), true; more; n++ {
		more = false
		for d, disk := range disks {
			if n < (int64(len(disk.Data))+ClusterSize-1)/ClusterSize {
				order = append(order, ref{d + 1, n})
				more = true
			}
		}
	}
	for len(order) > 0 {
		chunk := order[:min(blocksPerExtent, len(order))]
		order = order[len(chunk):]
		h := make([]byte, extentHeaderSize)
		var body []byte
		for i, c := range chunk {
			data := disks[c.dev-1].Data
			var mask uint16
			for j := 0; j < 16; j++ {
				start := c.num*ClusterSize + int64(j)*BlockSize
				block := make([]byte, BlockSize)
				if start < int64(len(data)) {
					copy(block, data[start:min(start+BlockSize, int64(len(data)))])
				}
				if !allZero(block) {
					mask |= 1 << j
					body = append(body, block...)
				}
			}
			be.PutUint64(h[40+8*i:], uint64(mask)<<48|uint64(c.dev)<<32|uint64(c.num))
		}
		copy(h[0:4], extentMagic)
		be.PutUint16(h[6:], uint16(len(body)/BlockSize))
		copy(h[8:24], uuid[:])
		sum := md5.Sum(h)
		copy(h[24:40], sum[:])
		if _, err := w.Write(h); err != nil {
			return err
		}
		if _, err := w.Write(body); err != nil {
			return err
		}
	}
	return nil
}

func allZero(b []byte) bool {
	for _, c := range b {
		if c != 0 {
			return false
		}
	}
	return true
}
