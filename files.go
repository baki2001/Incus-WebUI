package main

import (
	"bufio"
	"context"
	"crypto/tls"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path"
	"sort"
	"strings"
	"time"

	"github.com/pkg/sftp"
)

// handleListDir lists a directory inside an instance with type, size, mode and
// time for every entry in one round trip, using the Incus SFTP endpoint. The
// plain files API only returns names, which would need one request per entry.
func (a *App) handleListDir(w http.ResponseWriter, r *http.Request) {
	s, ok := a.server(r.PathValue("server"))
	if !ok {
		jsonError(w, http.StatusNotFound, "unknown server")
		return
	}
	dir := path.Clean("/" + r.URL.Query().Get("path"))
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	client, closeFn, err := a.sftpClient(ctx, s, r.PathValue("name"), r.URL.Query().Get("project"))
	if err != nil {
		jsonError(w, http.StatusBadGateway, err.Error())
		return
	}
	defer closeFn()

	infos, err := client.ReadDir(dir)
	if err != nil {
		jsonError(w, http.StatusBadRequest, err.Error())
		return
	}
	type entry struct {
		Name     string `json:"name"`
		Type     string `json:"type"`
		Size     int64  `json:"size"`
		Mode     string `json:"mode"`
		Modified string `json:"modified"`
		Target   string `json:"target,omitempty"`
		Resolved string `json:"resolved,omitempty"` // final path a symlink points to (empty if broken)
		UID      uint32 `json:"uid"`
		GID      uint32 `json:"gid"`
	}
	out := make([]entry, 0, len(infos))
	for _, fi := range infos {
		e := entry{Name: fi.Name(), Size: fi.Size(), Mode: fmt.Sprintf("%04o", fi.Mode().Perm()), Modified: fi.ModTime().UTC().Format(time.RFC3339), Type: "file"}
		if st, ok := fi.Sys().(*sftp.FileStat); ok {
			e.UID, e.GID = st.UID, st.GID
		}
		switch {
		case fi.IsDir():
			e.Type = "directory"
		case fi.Mode()&os.ModeSymlink != 0:
			e.Type = "symlink"
			if t, err := client.ReadLink(path.Join(dir, fi.Name())); err == nil {
				e.Target = t
			}
			// Stat follows the link, so size, mode and owner describe the target.
			if st, err := client.Stat(path.Join(dir, fi.Name())); err == nil {
				if st.IsDir() {
					e.Type = "symlink-dir"
				}
				e.Size, e.Mode = st.Size(), fmt.Sprintf("%04o", st.Mode().Perm())
				if fs, ok := st.Sys().(*sftp.FileStat); ok {
					e.UID, e.GID = fs.UID, fs.GID
				}
				e.Resolved = resolveLink(client, path.Join(dir, fi.Name()))
			}
		}
		out = append(out, e)
	}
	sort.Slice(out, func(i, j int) bool {
		di, dj := out[i].Type == "directory" || out[i].Type == "symlink-dir", out[j].Type == "directory" || out[j].Type == "symlink-dir"
		if di != dj {
			return di
		}
		return out[i].Name < out[j].Name
	})
	writeJSON(w, map[string]any{"path": dir, "entries": out})
}

// resolveLink follows a chain of symlinks to the final path. The SFTP RealPath
// of Incus does not resolve links, so this reads them one by one.
func resolveLink(c *sftp.Client, p string) string {
	for i := 0; i < 40; i++ {
		fi, err := c.Lstat(p)
		if err != nil {
			return ""
		}
		if fi.Mode()&os.ModeSymlink == 0 {
			return p
		}
		t, err := c.ReadLink(p)
		if err != nil {
			return ""
		}
		if !path.IsAbs(t) {
			t = path.Join(path.Dir(p), t)
		}
		p = path.Clean(t)
	}
	return ""
}

// handleRemoveAll deletes a folder and everything in it (the Incus files API
// only deletes empty folders). The web UI asks for confirmation first.
func (a *App) handleRemoveAll(w http.ResponseWriter, r *http.Request) {
	s, ok := a.server(r.PathValue("server"))
	if !ok {
		jsonError(w, http.StatusNotFound, "unknown server")
		return
	}
	p := path.Clean("/" + r.URL.Query().Get("path"))
	if p == "/" {
		jsonError(w, http.StatusBadRequest, "refusing to delete /")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()
	client, closeFn, err := a.sftpClient(ctx, s, r.PathValue("name"), r.URL.Query().Get("project"))
	if err != nil {
		jsonError(w, http.StatusBadGateway, err.Error())
		return
	}
	defer closeFn()
	if err := client.RemoveAll(p); err != nil {
		jsonError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

// handleDownload streams one file as an attachment. The name goes out as an
// RFC 5987 filename* (plus an ASCII fallback) so non-ASCII names survive.
func (a *App) handleDownload(w http.ResponseWriter, r *http.Request) {
	s, ok := a.server(r.PathValue("server"))
	if !ok {
		jsonError(w, http.StatusNotFound, "unknown server")
		return
	}
	p := path.Clean("/" + r.URL.Query().Get("path"))
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	client, closeFn, err := a.sftpClient(ctx, s, r.PathValue("name"), r.URL.Query().Get("project"))
	if err != nil {
		jsonError(w, http.StatusBadGateway, err.Error())
		return
	}
	defer closeFn()
	f, err := client.Open(p) // follows symlinks
	if err != nil {
		jsonError(w, http.StatusBadRequest, err.Error())
		return
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || st.IsDir() {
		jsonError(w, http.StatusBadRequest, "not a file")
		return
	}
	base := path.Base(p)
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", contentDisposition(base))
	w.Header().Set("Content-Length", fmt.Sprint(st.Size()))
	_, _ = io.Copy(w, f)
}

func contentDisposition(name string) string {
	ascii := []rune{}
	for _, c := range name {
		if c < 0x20 || c > 0x7e || c == '"' || c == '\\' || c == '%' {
			c = '_'
		}
		ascii = append(ascii, c)
	}
	return "attachment; filename=\"" + string(ascii) + "\"; filename*=UTF-8''" + strings.NewReplacer("'", "%27", "(", "%28", ")", "%29", "*", "%2A").Replace(url.PathEscape(name))
}

func (a *App) sftpClient(ctx context.Context, s ServerConfig, name, project string) (*sftp.Client, func(), error) {
	u, err := url.Parse(s.URL)
	if err != nil {
		return nil, nil, err
	}
	var conn net.Conn
	host := "unix.socket"
	switch u.Scheme {
	case "unix":
		var d net.Dialer
		conn, err = d.DialContext(ctx, "unix", u.Path)
	case "https":
		d := &tls.Dialer{Config: tlsConfigFor(a.backends.clientCert, pemToDER(s.ServerCert))}
		conn, err = d.DialContext(ctx, "tcp", u.Host)
		host = u.Host
	default:
		err = fmt.Errorf("unsupported URL scheme %q", u.Scheme)
	}
	if err != nil {
		return nil, nil, err
	}
	if dl, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(dl)
	}
	q := url.Values{}
	if project != "" {
		q.Set("project", project)
	}
	req, _ := http.NewRequest("GET", "http://"+host+"/1.0/instances/"+url.PathEscape(name)+"/sftp?"+q.Encode(), nil)
	req.Host = host
	req.Header.Set("Upgrade", "sftp")
	req.Header.Set("Connection", "Upgrade")
	if err := req.Write(conn); err != nil {
		conn.Close()
		return nil, nil, err
	}
	br := bufio.NewReader(conn)
	resp, err := http.ReadResponse(br, req)
	if err != nil {
		conn.Close()
		return nil, nil, err
	}
	if resp.StatusCode != http.StatusSwitchingProtocols {
		conn.Close()
		if resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusBadRequest {
			return nil, nil, fmt.Errorf("files are not reachable (is the instance running, and for VMs, is the agent installed?)")
		}
		return nil, nil, fmt.Errorf("files not reachable: %s", resp.Status)
	}
	_ = conn.SetDeadline(time.Time{})
	client, err := sftp.NewClientPipe(br, conn)
	if err != nil {
		conn.Close()
		return nil, nil, err
	}
	return client, func() { client.Close(); conn.Close() }, nil
}
