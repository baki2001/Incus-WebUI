package main

import (
	"bufio"
	"context"
	"crypto/tls"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"path"
	"sort"
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
			if st, err := client.Stat(path.Join(dir, fi.Name())); err == nil && st.IsDir() {
				e.Type = "symlink-dir"
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
