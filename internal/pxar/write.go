package pxar

import (
	"bytes"
	"encoding/binary"
	"sort"
)

// File types for Node.Mode.
const (
	ModeDir  = modeDir
	ModeReg  = modeReg
	ModeLink = modeLink
	ModeChr  = modeChr
	ModeBlk  = modeBlk
	ModeFifo = modeFifo
	ModeSock = modeSock
)

// Node is a file for Encode.
type Node struct {
	Mode     uint64 // type and permission bits
	UID, GID uint32
	Data     string // file contents, symlink target or hardlink target
	Hardlink bool
	Xattrs   map[string]string
	FCaps    string
	Kids     map[string]*Node
}

type enc struct {
	meta, payload bytes.Buffer
	split         bool
}

func (e *enc) item(typ uint64, content []byte) {
	var h [16]byte
	binary.LittleEndian.PutUint64(h[:], typ)
	binary.LittleEndian.PutUint64(h[8:], uint64(16+len(content)))
	e.meta.Write(h[:])
	e.meta.Write(content)
}

func cstr(s string) []byte { return append([]byte(s), 0) }

func (e *enc) node(n *Node) {
	if n.Hardlink {
		b := make([]byte, 8)
		e.item(typeHardlink, append(b, cstr(n.Data)...))
		return
	}
	st := make([]byte, 40)
	le := binary.LittleEndian
	le.PutUint64(st, n.Mode)
	le.PutUint32(st[16:], n.UID)
	le.PutUint32(st[20:], n.GID)
	le.PutUint64(st[24:], 1700000000)
	e.item(typeEntry, st)
	keys := make([]string, 0, len(n.Xattrs))
	for k := range n.Xattrs {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		e.item(typeXattr, append(cstr(k), n.Xattrs[k]...))
	}
	e.item(typeACLUser, make([]byte, 16)) // skipped by the reader
	if n.FCaps != "" {
		e.item(typeFCaps, []byte(n.FCaps))
	}
	switch n.Mode & modeType {
	case ModeReg:
		if !e.split {
			e.item(typePayload, []byte(n.Data))
			return
		}
		e.payload.WriteString("pad") // unreferenced bytes between payloads
		ref := make([]byte, 16)
		le.PutUint64(ref, uint64(e.payload.Len()))
		le.PutUint64(ref[8:], uint64(len(n.Data)))
		var h [16]byte
		le.PutUint64(h[:], typePayload)
		le.PutUint64(h[8:], uint64(16+len(n.Data)))
		e.payload.Write(h[:])
		e.payload.WriteString(n.Data)
		e.item(typePayloadRef, ref)
	case ModeLink:
		e.item(typeSymlink, cstr(n.Data))
	case ModeChr, ModeBlk:
		d := make([]byte, 16)
		le.PutUint64(d, 1)
		le.PutUint64(d[8:], 3)
		e.item(typeDevice, d)
	case ModeDir:
		names := make([]string, 0, len(n.Kids))
		for k := range n.Kids {
			names = append(names, k)
		}
		sort.Strings(names)
		for _, k := range names {
			e.item(typeFilename, cstr(k))
			e.node(n.Kids[k])
		}
		e.item(typeGoodbye, make([]byte, 24)) // content is skipped by the reader
	}
}

// Encode writes a pxar archive. It exists for tests: real archives come
// from Proxmox. With split it writes the metadata and payload streams of a
// split archive; otherwise payload is empty.
func Encode(root *Node, split bool) (meta, payload []byte) {
	e := &enc{split: split}
	if split {
		var h [16]byte
		binary.LittleEndian.PutUint64(h[:], typePayloadStart)
		binary.LittleEndian.PutUint64(h[8:], 16)
		e.payload.Write(h[:])
		e.item(typeFormatVersion, make([]byte, 8))
		e.item(typePrelude, []byte("prelude"))
	}
	e.node(root)
	return e.meta.Bytes(), e.payload.Bytes()
}
