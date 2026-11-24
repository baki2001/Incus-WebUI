// Package pxar reads pxar archives, the file archive format of Proxmox
// Backup Server, as a stream. It handles the single-file format (.pxar) and
// the split format, where the metadata (.mpxar) and the file contents
// (.ppxar) are two streams.
//
// The layout follows src/format/mod.rs and src/decoder/mod.rs in Proxmox's
// pxar crate. ACLs and quota project IDs are skipped; extended attributes
// and file capabilities are kept.
package pxar

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"
)

// Item types. Each item starts with a 16-byte header: the type and the size
// of the whole item, header included. All numbers are little-endian.
const (
	typeFormatVersion   = 0x730f6c75df16a40d
	typeEntry           = 0xd5956474e588acef
	typeEntryV1         = 0x11da850a1c1cceff
	typePrelude         = 0xe309d79d9f7b771b
	typeFilename        = 0x16701121063917b3
	typeSymlink         = 0x27f971e7dbf5dc5f
	typeDevice          = 0x9fc9e906586d5ce9
	typeXattr           = 0x0dab0229b57dcd03
	typeACLUser         = 0x2ce8540a457d55b8
	typeACLGroup        = 0x136e3eceb04c03ab
	typeACLGroupObj     = 0x10868031e9582876
	typeACLDefault      = 0xbbbb13415a6896f5
	typeACLDefaultUser  = 0xc89357b40532cd1f
	typeACLDefaultGroup = 0xf90a8a5816038ffe
	typeFCaps           = 0x2da9dd9db5f7fb67
	typeQuotaProjID     = 0xe07540e82f7d1cbb
	typeHardlink        = 0x51269c8422bd7275
	typePayload         = 0x28147a1b0b7c1a25
	typePayloadRef      = 0x419d3d6bc4ba977e
	typeGoodbye         = 0x2fec4fa642d5731d
	typePayloadStart    = 0x834c68c2194a4ed2
	typePayloadTail     = 0x6c72b78b984c81b5
	headerSize          = 16
	maxItem             = 1 << 20 // names, links and xattrs; file contents are streamed
	maxDepth            = 4096
	modeType            = 0o170000
	modeSock, modeLink  = 0o140000, 0o120000
	modeReg, modeBlk    = 0o100000, 0o060000
	modeDir, modeChr    = 0o040000, 0o020000
	modeFifo            = 0o010000
)

// Kind is the type of a file.
type Kind int

const (
	Dir Kind = iota
	File
	Symlink
	Hardlink
	CharDev
	BlockDev
	Fifo
	Socket
)

// Entry is one file in the archive.
type Entry struct {
	Path   string // relative to the archive root, "" for the root itself
	Kind   Kind
	Mode   int64 // permission bits, including setuid, setgid and sticky
	UID    int
	GID    int
	MTime  time.Time
	Size   int64             // File only
	Link   string            // Symlink: the target; Hardlink: the path of the first link, relative to the root
	Major  int64             // devices
	Minor  int64             // devices
	Xattrs map[string]string // name to value, file capabilities as security.capability
}

// Walk reads the archive and calls fn for every entry, parents before their
// children. For a File, data reads its contents; it must be read to the end
// or left alone, and is only valid during the call. payload is the .ppxar
// stream of a split archive, or nil for a single-file archive.
func Walk(meta, payload io.Reader, fn func(e *Entry, data io.Reader) error) error {
	w := &walker{r: meta, fn: fn}
	if payload != nil {
		h, err := readHeader(payload)
		if err != nil {
			return fmt.Errorf("pxar payload: %w", err)
		}
		if h.typ != typePayloadStart {
			return errors.New("pxar payload stream does not start with a start marker")
		}
		w.payload, w.consumed = payload, h.size
	}
	if err := w.entry("", 0); err != nil {
		return err
	}
	if w.peek != nil {
		return errors.New("pxar archive has items after its root directory")
	}
	return nil
}

type header struct {
	typ  uint64
	size uint64 // of the whole item
}

func (h header) content() uint64 { return h.size - headerSize }

func readHeader(r io.Reader) (header, error) {
	var b [headerSize]byte
	if _, err := io.ReadFull(r, b[:]); err != nil {
		if err == io.EOF {
			return header{}, io.ErrUnexpectedEOF
		}
		return header{}, err
	}
	h := header{binary.LittleEndian.Uint64(b[:8]), binary.LittleEndian.Uint64(b[8:])}
	if h.size < headerSize {
		return h, fmt.Errorf("pxar item %#x has a bad size %d", h.typ, h.size)
	}
	return h, nil
}

type walker struct {
	r        io.Reader
	payload  io.Reader
	consumed uint64 // bytes of the payload stream read so far
	peek     *header
	fn       func(*Entry, io.Reader) error
	started  bool
}

func (w *walker) next() (header, error) {
	if w.peek != nil {
		h := *w.peek
		w.peek = nil
		return h, nil
	}
	return readHeader(w.r)
}

func (w *walker) read(h header) ([]byte, error) {
	if h.content() > maxItem {
		return nil, fmt.Errorf("pxar item %#x is too large (%d bytes)", h.typ, h.content())
	}
	b := make([]byte, h.content())
	_, err := io.ReadFull(w.r, b)
	return b, err
}

func (w *walker) skip(h header) error {
	_, err := io.CopyN(io.Discard, w.r, int64(h.content()))
	return err
}

func cstring(b []byte) (string, error) {
	if len(b) == 0 || b[len(b)-1] != 0 {
		return "", errors.New("pxar string is not zero-terminated")
	}
	return string(b[:len(b)-1]), nil
}

// entry reads one entry (and, for a directory, everything in it).
func (w *walker) entry(path string, depth int) error {
	if depth > maxDepth {
		return errors.New("pxar archive is nested too deeply")
	}
	h, err := w.next()
	if err != nil {
		return err
	}
	if !w.started {
		w.started = true
		if h.typ == typeFormatVersion {
			if err := w.skip(h); err != nil {
				return err
			}
			if h, err = w.next(); err != nil {
				return err
			}
			if h.typ == typePrelude {
				if err := w.skip(h); err != nil {
					return err
				}
				if h, err = w.next(); err != nil {
					return err
				}
			}
		}
	}
	e := &Entry{Path: path}
	switch h.typ {
	case typeHardlink:
		b, err := w.read(h)
		if err != nil {
			return err
		}
		if len(b) < 8 {
			return errors.New("pxar hardlink is too short")
		}
		if e.Link, err = cstring(b[8:]); err != nil {
			return err
		}
		e.Link = strings.TrimPrefix(e.Link, "/")
		e.Kind = Hardlink
		return w.fn(e, nil)
	case typeEntry, typeEntryV1:
		b, err := w.read(h)
		if err != nil {
			return err
		}
		le := binary.LittleEndian
		var mode uint64
		switch {
		case h.typ == typeEntry && len(b) == 40:
			mode = le.Uint64(b)
			e.UID, e.GID = int(le.Uint32(b[16:])), int(le.Uint32(b[20:]))
			e.MTime = time.Unix(int64(le.Uint64(b[24:])), int64(le.Uint32(b[32:])))
		case h.typ == typeEntryV1 && len(b) == 32:
			mode = le.Uint64(b)
			e.UID, e.GID = int(le.Uint32(b[16:])), int(le.Uint32(b[20:]))
			e.MTime = time.Unix(0, int64(le.Uint64(b[24:])))
		default:
			return fmt.Errorf("pxar entry has a bad size %d", len(b))
		}
		e.Mode = int64(mode & 0o7777)
		return w.attrs(e, mode&modeType, depth)
	}
	return fmt.Errorf("pxar: expected an entry, got item %#x", h.typ)
}

// attrs reads the items after an ENTRY up to what ends it.
func (w *walker) attrs(e *Entry, typ uint64, depth int) error {
	for {
		h, err := w.next()
		if err != nil {
			return err
		}
		switch h.typ {
		case typeXattr, typeFCaps:
			b, err := w.read(h)
			if err != nil {
				return err
			}
			if e.Xattrs == nil {
				e.Xattrs = map[string]string{}
			}
			if h.typ == typeFCaps {
				e.Xattrs["security.capability"] = string(b)
				continue
			}
			name, value, ok := strings.Cut(string(b), "\x00")
			if !ok {
				return errors.New("pxar xattr has no name")
			}
			e.Xattrs[name] = value
		case typeACLUser, typeACLGroup, typeACLGroupObj, typeACLDefault, typeACLDefaultUser, typeACLDefaultGroup, typeQuotaProjID:
			if err := w.skip(h); err != nil {
				return err
			}
		case typeSymlink:
			b, err := w.read(h)
			if err != nil {
				return err
			}
			if e.Link, err = cstring(b); err != nil {
				return err
			}
			e.Kind = Symlink
			return w.fn(e, nil)
		case typeDevice:
			b, err := w.read(h)
			if err != nil {
				return err
			}
			if len(b) != 16 {
				return errors.New("pxar device has a bad size")
			}
			e.Major, e.Minor = int64(binary.LittleEndian.Uint64(b)), int64(binary.LittleEndian.Uint64(b[8:]))
			e.Kind = BlockDev
			if typ == modeChr {
				e.Kind = CharDev
			}
			return w.fn(e, nil)
		case typePayload:
			e.Kind, e.Size = File, int64(h.content())
			return w.file(e, w.r)
		case typePayloadRef:
			if w.payload == nil {
				return errors.New("this is the metadata part of a split pxar archive, and the payload part is missing")
			}
			b, err := w.read(h)
			if err != nil {
				return err
			}
			if len(b) != 16 {
				return errors.New("pxar payload reference has a bad size")
			}
			off, size := binary.LittleEndian.Uint64(b), binary.LittleEndian.Uint64(b[8:])
			if off < w.consumed {
				return errors.New("pxar payload references are out of order")
			}
			if _, err := io.CopyN(io.Discard, w.payload, int64(off-w.consumed)); err != nil {
				return fmt.Errorf("pxar payload: %w", err)
			}
			ph, err := readHeader(w.payload)
			if err != nil {
				return fmt.Errorf("pxar payload: %w", err)
			}
			if ph.typ != typePayload || ph.content() != size {
				return errors.New("pxar payload does not match its reference")
			}
			w.consumed = off + headerSize + size
			e.Kind, e.Size = File, int64(size)
			return w.file(e, w.payload)
		case typeFilename, typeGoodbye:
			// The entry has no content item: a directory, FIFO or socket.
			// This header belongs to the directory's contents, or to the
			// parent for a FIFO or socket.
			w.peek = &h
			switch typ {
			case modeFifo:
				e.Kind = Fifo
				return w.fn(e, nil)
			case modeSock:
				e.Kind = Socket
				return w.fn(e, nil)
			}
			e.Kind = Dir
			if err := w.fn(e, nil); err != nil {
				return err
			}
			return w.dir(e.Path, depth)
		default:
			return fmt.Errorf("pxar: unexpected item %#x", h.typ)
		}
	}
}

func (w *walker) file(e *Entry, r io.Reader) error {
	lr := &io.LimitedReader{R: r, N: e.Size}
	if err := w.fn(e, lr); err != nil {
		return err
	}
	_, err := io.Copy(io.Discard, lr)
	return err
}

func (w *walker) dir(path string, depth int) error {
	for {
		h, err := w.next()
		if err != nil {
			return err
		}
		switch h.typ {
		case typeGoodbye:
			return w.skip(h)
		case typeFilename:
			b, err := w.read(h)
			if err != nil {
				return err
			}
			name, err := cstring(b)
			if err != nil {
				return err
			}
			if name == "" || name == "." || name == ".." || strings.ContainsAny(name, "/\x00") {
				return fmt.Errorf("pxar archive has an unsafe file name %q", name)
			}
			child := name
			if path != "" {
				child = path + "/" + name
			}
			if err := w.entry(child, depth+1); err != nil {
				return err
			}
		default:
			return fmt.Errorf("pxar: expected a file name or the end of a directory, got item %#x", h.typ)
		}
	}
}
