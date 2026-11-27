package proxmox

import (
	"encoding/binary"
	"testing"
)

// gptHead builds the first 64 KiB of a disk with one GPT partition that
// ends at sector last.
func gptHead(last uint64) []byte {
	h := make([]byte, 64<<10)
	copy(h[512:], "EFI PART")
	binary.LittleEndian.PutUint64(h[512+72:], 2)
	binary.LittleEndian.PutUint32(h[512+80:], 128)
	binary.LittleEndian.PutUint32(h[512+84:], 128)
	e := h[1024:]
	e[0] = 0xaf // any type GUID
	binary.LittleEndian.PutUint64(e[32:], 2048)
	binary.LittleEndian.PutUint64(e[40:], last)
	return h
}

func TestGPTSize(t *testing.T) {
	const disk = 12 << 30
	sectors := uint64(disk / 512)
	if got := GPTSize(gptHead(sectors-34), disk); got != 0 {
		t.Errorf("a normal GPT needs no room, got %d", got)
	}
	if got := GPTSize(gptHead(sectors-1), disk); got != disk+1<<20 {
		t.Errorf("partition to the last sector: got %d, want %d", got, disk+1<<20)
	}
	if got := GPTSize(gptHead(sectors+100), disk); got != disk+1<<20 {
		t.Errorf("partition past the end: got %d", got)
	}
	if got := GPTSize(make([]byte, 64<<10), disk); got != 0 {
		t.Errorf("no GPT: got %d", got)
	}
	// fdisk and sfdisk start the usable sectors at 2048 but end them 34
	// sectors from the end. sgdisk --move-second-header, which Incus runs,
	// wants 2048 sectors after the last partition and exits with status 4.
	fdisk := gptHead(sectors - 34)
	binary.LittleEndian.PutUint64(fdisk[512+40:], 2048)
	if got := GPTSize(fdisk, disk); got != disk+1<<20 {
		t.Errorf("fdisk layout: got %d, want %d", got, disk+1<<20)
	}
	binary.LittleEndian.PutUint64(fdisk[1024+40:], sectors-2048)
	if got := GPTSize(fdisk, disk); got != 0 {
		t.Errorf("fdisk layout with room: got %d", got)
	}
	// A disk that is not a whole number of MiB with a normal GPT.
	odd := int64(disk + 7*512)
	if got := GPTSize(gptHead(uint64(odd/512)-34), odd); got != 0 {
		t.Errorf("odd size: got %d", got)
	}
}

func TestGPTProblem(t *testing.T) {
	h := gptHead(1 << 20)
	binary.LittleEndian.PutUint64(h[512+40:], 34) // first usable LBA
	if p := GPTProblem(h); p != "" {
		t.Errorf("good table: %s", p)
	}
	// A second partition that overlaps the first.
	e := h[1024+128:]
	e[0] = 0xaf
	binary.LittleEndian.PutUint64(e[32:], 4096)
	binary.LittleEndian.PutUint64(e[40:], 8191)
	if p := GPTProblem(h); p != "partitions 1 and 2 overlap" {
		t.Errorf("overlap: %q", p)
	}
	// Moved past the first, but starting inside the table.
	binary.LittleEndian.PutUint64(e[32:], 20)
	binary.LittleEndian.PutUint64(e[40:], 30)
	if p := GPTProblem(h); p == "" {
		t.Error("partition inside the table not reported")
	}
	if p := GPTProblem(make([]byte, 64<<10)); p != "" {
		t.Errorf("no GPT: %s", p)
	}
}
