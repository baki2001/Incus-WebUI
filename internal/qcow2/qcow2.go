// Package qcow2 writes qcow2 v3 disk images, the format Incus requires for
// virtual machine images.
//
// The writer takes 64 KiB clusters in any order and appends each one to the
// file. Clusters never written stay unallocated and read as zeros. Close
// writes the L2 tables, the L1 table, the refcounts and the header.
//
// The layout follows docs/interop/qcow2.txt in QEMU. Only what Incus needs is
// supported: no backing files, compression, encryption or snapshots.
package qcow2

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
)

const (
	clusterBits  = 16
	ClusterSize  = 1 << clusterBits
	l2Entries    = ClusterSize / 8
	refBlockSize = ClusterSize / 2 // 16-bit refcounts per block
	copiedFlag   = uint64(1) << 63
	headerLength = 104
)

// Writer builds a qcow2 image in w. Use one per image.
type Writer struct {
	w    io.WriterAt
	size int64
	next int64              // next free host cluster index
	l2   map[int64][]uint64 // L2 tables kept in memory until Close
	done bool
}

// NewWriter starts an image with the given virtual size in bytes. Cluster 0
// is kept for the header; data starts at cluster 1.
func NewWriter(w io.WriterAt, size int64) (*Writer, error) {
	if size <= 0 || size > 1<<50 {
		return nil, fmt.Errorf("bad disk size %d", size)
	}
	return &Writer{w: w, size: size, next: 1, l2: map[int64][]uint64{}}, nil
}

// Clusters is the number of guest clusters in the image.
func (q *Writer) Clusters() int64 { return (q.size + ClusterSize - 1) / ClusterSize }

// WriteCluster stores guest cluster n. data must be ClusterSize bytes. A
// cluster that is all zeros is skipped. Writing the same cluster twice is an
// error, since the VMA reader already rejects duplicates.
func (q *Writer) WriteCluster(n int64, data []byte) error {
	if q.done {
		return errors.New("qcow2: write after close")
	}
	if n < 0 || n >= q.Clusters() {
		return fmt.Errorf("qcow2: cluster %d is outside the disk", n)
	}
	if len(data) != ClusterSize {
		return fmt.Errorf("qcow2: cluster data is %d bytes", len(data))
	}
	if isZero(data) {
		return nil
	}
	t := q.l2[n/l2Entries]
	if t == nil {
		t = make([]uint64, l2Entries)
		q.l2[n/l2Entries] = t
	}
	if t[n%l2Entries] != 0 {
		return fmt.Errorf("qcow2: cluster %d written twice", n)
	}
	off := q.next * ClusterSize
	if _, err := q.w.WriteAt(data, off); err != nil {
		return err
	}
	q.next++
	t[n%l2Entries] = uint64(off) | copiedFlag
	return nil
}

// Close writes the metadata. The image is not valid before Close returns.
func (q *Writer) Close() error {
	if q.done {
		return nil
	}
	q.done = true
	be := binary.BigEndian

	// L2 tables, one cluster each, in guest order.
	l1Size := (q.Clusters() + l2Entries - 1) / l2Entries
	l1 := make([]uint64, l1Size)
	buf := make([]byte, ClusterSize)
	for i := int64(0); i < l1Size; i++ {
		t := q.l2[i]
		if t == nil {
			continue
		}
		for j, e := range t {
			be.PutUint64(buf[8*j:], e)
		}
		off := q.next * ClusterSize
		if _, err := q.w.WriteAt(buf, off); err != nil {
			return err
		}
		q.next++
		l1[i] = uint64(off) | copiedFlag
	}

	// L1 table.
	l1Bytes := make([]byte, roundUp(l1Size*8, ClusterSize))
	for i, e := range l1 {
		be.PutUint64(l1Bytes[8*i:], e)
	}
	l1Off := q.next * ClusterSize
	if _, err := q.w.WriteAt(l1Bytes, l1Off); err != nil {
		return err
	}
	q.next += int64(len(l1Bytes)) / ClusterSize

	// Refcounts. Every cluster up to here is used once, and the refcount
	// table and blocks must count themselves too, so grow until it fits.
	refStart := q.next
	var tableClusters, blocks int64
	for {
		total := refStart + tableClusters + blocks
		needBlocks := (total + refBlockSize - 1) / refBlockSize
		needTable := (needBlocks*8 + ClusterSize - 1) / ClusterSize
		if needBlocks == blocks && needTable == tableClusters {
			break
		}
		blocks, tableClusters = needBlocks, needTable
	}
	total := refStart + tableClusters + blocks
	table := make([]byte, tableClusters*ClusterSize)
	for b := int64(0); b < blocks; b++ {
		be.PutUint64(table[8*b:], uint64((refStart+tableClusters+b)*ClusterSize))
	}
	if _, err := q.w.WriteAt(table, refStart*ClusterSize); err != nil {
		return err
	}
	for b := int64(0); b < blocks; b++ {
		clear(buf)
		for i := int64(0); i < refBlockSize; i++ {
			if b*refBlockSize+i >= total {
				break
			}
			be.PutUint16(buf[2*i:], 1)
		}
		if _, err := q.w.WriteAt(buf, (refStart+tableClusters+b)*ClusterSize); err != nil {
			return err
		}
	}

	// Header, written last so a half-written image is never valid.
	h := make([]byte, ClusterSize)
	copy(h[0:4], "QFI\xfb")
	be.PutUint32(h[4:], 3)                             // version
	be.PutUint32(h[20:], clusterBits)                  // cluster_bits
	be.PutUint64(h[24:], uint64(q.size))               // size
	be.PutUint32(h[36:], uint32(l1Size))               // l1_size
	be.PutUint64(h[40:], uint64(l1Off))                // l1_table_offset
	be.PutUint64(h[48:], uint64(refStart*ClusterSize)) // refcount_table_offset
	be.PutUint32(h[56:], uint32(tableClusters))        // refcount_table_clusters
	be.PutUint32(h[96:], 4)                            // refcount_order: 16 bits
	be.PutUint32(h[100:], headerLength)
	// Bytes 104-111 stay zero: the end of header extensions.
	_, err := q.w.WriteAt(h, 0)
	return err
}

func roundUp(n, to int64) int64 { return (n + to - 1) / to * to }

func isZero(b []byte) bool {
	for len(b) >= 8 {
		if binary.LittleEndian.Uint64(b) != 0 {
			return false
		}
		b = b[8:]
	}
	for _, c := range b {
		if c != 0 {
			return false
		}
	}
	return true
}
