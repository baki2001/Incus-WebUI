// Package proxmox turns Proxmox vzdump backups into Incus images and
// instance settings. It does no network calls: the caller uploads what it
// builds.
package proxmox

import (
	"bufio"
	"bytes"
	"fmt"
	"strconv"
	"strings"
)

// Conf is a parsed qemu-server.conf or pct.conf. Only the current config is
// kept; snapshot sections ([name]) and the pending section are dropped.
type Conf struct {
	Values      map[string]string
	Description string
}

// ParseConf reads a Proxmox guest config.
func ParseConf(b []byte) (*Conf, error) {
	c := &Conf{Values: map[string]string{}}
	sc := bufio.NewScanner(bytes.NewReader(b))
	sc.Buffer(make([]byte, 64*1024), 1<<20)
	var desc []string
	for sc.Scan() {
		line := strings.TrimRight(sc.Text(), "\r")
		if strings.HasPrefix(line, "[") {
			break // snapshots and pending changes follow; the live config is above
		}
		if strings.HasPrefix(line, "#") {
			desc = append(desc, strings.TrimPrefix(line, "#"))
			continue
		}
		if strings.TrimSpace(line) == "" {
			continue
		}
		k, v, ok := strings.Cut(line, ":")
		if !ok {
			return nil, fmt.Errorf("unexpected line in Proxmox config: %q", line)
		}
		c.Values[strings.TrimSpace(k)] = strings.TrimSpace(v)
	}
	if err := sc.Err(); err != nil {
		return nil, err
	}
	c.Description = strings.TrimSpace(strings.Join(desc, "\n"))
	return c, nil
}

// Get returns a value, or "" when missing.
func (c *Conf) Get(k string) string { return c.Values[k] }

// Int returns a number, or def when missing or not a number.
func (c *Conf) Int(k string, def int) int {
	n, err := strconv.Atoi(c.Values[k])
	if err != nil {
		return def
	}
	return n
}

// Opts splits a property string such as
// "virtio=BC:24:11:00:00:01,bridge=vmbr0,firewall=1" into its parts. A part
// without "=" is returned under key "" (Proxmox uses that for the volume in
// disk lines).
func Opts(s string) map[string]string {
	out := map[string]string{}
	for _, p := range strings.Split(s, ",") {
		k, v, ok := strings.Cut(p, "=")
		if !ok {
			out[""] = strings.TrimSpace(p)
			continue
		}
		out[strings.TrimSpace(k)] = strings.TrimSpace(v)
	}
	return out
}

// Size parses Proxmox sizes such as "32G", "512M" or "8192" (bytes) into bytes.
func Size(s string) (int64, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, false
	}
	mult := int64(1)
	switch s[len(s)-1] {
	case 'K', 'k':
		mult = 1 << 10
	case 'M', 'm':
		mult = 1 << 20
	case 'G', 'g':
		mult = 1 << 30
	case 'T', 't':
		mult = 1 << 40
	}
	if mult != 1 {
		s = s[:len(s)-1]
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil || f < 0 {
		return 0, false
	}
	return int64(f * float64(mult)), true
}
