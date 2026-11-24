package pxar

import (
	"bytes"
	"fmt"
	"io"
	"sort"
	"strings"
	"testing"
)

func tree() *Node {
	return &Node{Mode: modeDir | 0o755, Kids: map[string]*Node{
		"bin": {Mode: modeLink | 0o777, Data: "usr/bin"},
		"etc": {Mode: modeDir | 0o755, Kids: map[string]*Node{
			"hostname": {Mode: modeReg | 0o644, Data: "ct110\n"},
			"empty":    {Mode: modeReg | 0o600},
			"shadow":   {Mode: modeReg | 0o640, GID: 42, Data: "root:*:1::::::\n", Xattrs: map[string]string{"user.a": "1"}},
		}},
		"usr": {Mode: modeDir | 0o755, Kids: map[string]*Node{
			"bin": {Mode: modeDir | 0o755, Kids: map[string]*Node{
				"ping":  {Mode: modeReg | 0o755, Data: "ELF", FCaps: "caps"},
				"ping4": {Hardlink: true, Data: "usr/bin/ping"},
			}},
		}},
		"dev": {Mode: modeDir | 0o755, Kids: map[string]*Node{
			"null": {Mode: modeChr | 0o666},
			"fifo": {Mode: modeFifo | 0o600},
			"sock": {Mode: modeSock | 0o600},
		}},
		"tmp": {Mode: modeDir | 0o1777},
	}}
}

func walkAll(t *testing.T, meta, payload []byte) []string {
	t.Helper()
	var p io.Reader
	if payload != nil {
		p = bytes.NewReader(payload)
	}
	var out []string
	err := Walk(bytes.NewReader(meta), p, func(e *Entry, data io.Reader) error {
		s := e.Path + " " + map[Kind]string{Dir: "dir", File: "file", Symlink: "symlink", Hardlink: "hardlink", CharDev: "chr", BlockDev: "blk", Fifo: "fifo", Socket: "sock"}[e.Kind]
		switch e.Kind {
		case File:
			b, _ := io.ReadAll(data)
			s += " " + string(b)
		case Symlink, Hardlink:
			s += " -> " + e.Link
		case CharDev:
			if e.Major != 1 || e.Minor != 3 {
				t.Errorf("%s: device %d:%d", e.Path, e.Major, e.Minor)
			}
		}
		if e.Kind != Hardlink {
			s += fmt.Sprintf(" %04o", e.Mode)
		}
		if e.GID != 0 {
			s += " gid"
		}
		if len(e.Xattrs) > 0 {
			keys := []string{}
			for k := range e.Xattrs {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			s += " xattrs:" + strings.Join(keys, ",")
		}
		out = append(out, s)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func TestWalk(t *testing.T) {
	want := []string{
		" dir 0755",
		"bin symlink -> usr/bin 0777",
		"dev dir 0755",
		"dev/fifo fifo 0600",
		"dev/null chr 0666",
		"dev/sock sock 0600",
		"etc dir 0755",
		"etc/empty file  0600",
		"etc/hostname file ct110\n 0644",
		"etc/shadow file root:*:1::::::\n 0640 gid xattrs:user.a",
		"tmp dir 1777",
		"usr dir 0755",
		"usr/bin dir 0755",
		"usr/bin/ping file ELF 0755 xattrs:security.capability",
		"usr/bin/ping4 hardlink -> usr/bin/ping",
	}
	for _, split := range []bool{false, true} {
		meta, payload := Encode(tree(), split)
		if !split {
			payload = nil
		}
		got := walkAll(t, meta, payload)
		if strings.Join(got, "\n") != strings.Join(want, "\n") {
			t.Errorf("split=%v:\n%s\nwant\n%s", split, strings.Join(got, "\n"), strings.Join(want, "\n"))
		}
	}
}

func TestWalkSkipsUnreadData(t *testing.T) {
	meta, payload := Encode(tree(), true)
	n := 0
	err := Walk(bytes.NewReader(meta), bytes.NewReader(payload), func(e *Entry, data io.Reader) error {
		n++
		return nil
	})
	if err != nil || n != 15 {
		t.Fatalf("n=%d err=%v", n, err)
	}
}

func TestWalkRejects(t *testing.T) {
	meta, _ := Encode(tree(), true)
	if err := Walk(bytes.NewReader(meta), nil, func(*Entry, io.Reader) error { return nil }); err == nil || !strings.Contains(err.Error(), "payload part is missing") {
		t.Errorf("split without payload: %v", err)
	}
	bad := &Node{Mode: modeDir | 0o755, Kids: map[string]*Node{"..": {Mode: modeReg | 0o644}}}
	meta, _ = Encode(bad, false)
	if err := Walk(bytes.NewReader(meta), nil, func(*Entry, io.Reader) error { return nil }); err == nil || !strings.Contains(err.Error(), "unsafe") {
		t.Errorf("dot-dot name: %v", err)
	}
	meta, _ = Encode(tree(), false)
	for _, cut := range []int{10, 100, len(meta) - 5} {
		if err := Walk(bytes.NewReader(meta[:cut]), nil, func(*Entry, io.Reader) error { return nil }); err == nil {
			t.Errorf("truncated at %d: no error", cut)
		}
	}
}
