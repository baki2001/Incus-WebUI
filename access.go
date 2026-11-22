package main

// Roles. Every Incus call and every UI action passes through this file:
// the backend decides, the UI only hides what you can't use.
//
// Access entries say who gets which role on which server and project:
//
//	who:     "user:alice" (local account), "sso:alice" (SSO login),
//	         "group:ops" (SSO group) or "*" (everyone who can sign in)
//	server:  a server name or "*"
//	project: a project name or "*"
//	role:    admin | manager | operator | viewer
//
// Admin only exists for server "*" and project "*" and covers everything,
// including users, servers, updates and tunnels.

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"
)

type Access struct {
	Who     string `yaml:"who" json:"who"`
	Server  string `yaml:"server" json:"server"`
	Project string `yaml:"project" json:"project"`
	Role    string `yaml:"role" json:"role"`
}

type Role int

const (
	RoleNone Role = iota
	RoleViewer
	RoleOperator
	RoleManager
	RoleAdmin
)

var roleNames = map[string]Role{"viewer": RoleViewer, "operator": RoleOperator, "manager": RoleManager, "admin": RoleAdmin}

func (r Role) String() string {
	for k, v := range roleNames {
		if v == r {
			return k
		}
	}
	return "none"
}

// subjects lists the access names a session matches.
func subjects(s *Session) []string {
	out := []string{"*"}
	if s.Method == "oidc" {
		out = append(out, "sso:"+s.User)
		for _, g := range s.Groups {
			out = append(out, "group:"+g)
		}
	} else {
		out = append(out, "user:"+s.User)
	}
	return out
}

// roleFor is the highest role the session has on a server and project.
func roleFor(list []Access, s *Session, server, project string) Role {
	subs := subjects(s)
	best := RoleNone
	for _, a := range list {
		if !slices.Contains(subs, a.Who) {
			continue
		}
		r := roleNames[a.Role]
		if r == RoleAdmin {
			if a.Server == "*" && a.Project == "*" {
				return RoleAdmin
			}
			continue // admin entries with a narrower scope are invalid and ignored
		}
		if (a.Server == "*" || a.Server == server) && (a.Project == "*" || a.Project == project) && r > best {
			best = r
		}
	}
	return best
}

func (a *App) isAdmin(s *Session) bool {
	return roleFor(a.store.Get().Access, s, "", "") == RoleAdmin
}

// requireAdmin wraps handlers only admins may use.
func (a *App) requireAdmin(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		s, _ := a.currentSession(r)
		if s == nil || !a.isAdmin(s) {
			jsonError(w, http.StatusForbidden, "Only admins can do this.")
			return
		}
		next(w, r)
	}
}

// requireRole checks a role on the server and project named in the request
// (path value "server", query "project", default "default").
func (a *App) requireRole(min Role, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		s, _ := a.currentSession(r)
		project := r.URL.Query().Get("project")
		if project == "" {
			project = "default"
		}
		if s == nil || roleFor(a.store.Get().Access, s, r.PathValue("server"), project) < min {
			jsonError(w, http.StatusForbidden, deniedMsg(min, project))
			return
		}
		next(w, r)
	}
}

func deniedMsg(min Role, project string) string {
	if project == "*" {
		return "You need the " + min.String() + " role on all projects of this server for this. Ask an admin."
	}
	return "You need the " + min.String() + " role on project " + project + " for this. Ask an admin."
}

// Scope says where the role in incusNeed must hold.
type Scope int

const (
	ScopeProject Scope = iota // the project in ?project= (default "default")
	ScopeServer               // the whole server: a role on project "*"
	ScopeAny                  // any project on the server (harmless server info)
)

// incusNeed says which role an Incus API call needs, and where.
func incusNeed(method, path string) (Role, Scope) {
	read := method == http.MethodGet || method == http.MethodHead
	parts := strings.Split(strings.Trim(path, "/"), "/") // "1.0", "instances", ...
	if parts[0] == "os" {
		return RoleAdmin, ScopeServer
	}
	if len(parts) == 1 { // GET /1.0 is the server's info; PUT/PATCH changes server config
		if read {
			return RoleViewer, ScopeAny
		}
		return RoleAdmin, ScopeServer
	}
	coll := parts[1]
	switch coll {
	case "storage-pools":
		if len(parts) >= 4 && (parts[3] == "volumes" || parts[3] == "buckets") {
			break // volumes and buckets live in projects
		}
		if read {
			return RoleViewer, ScopeAny
		}
		return RoleAdmin, ScopeServer
	case "resources", "cluster":
		if read {
			return RoleViewer, ScopeAny
		}
		return RoleAdmin, ScopeServer
	case "certificates", "auth", "metrics", "network-integrations":
		// Certificates and raw metrics cover every project.
		if read && coll == "metrics" {
			return RoleViewer, ScopeServer
		}
		return RoleAdmin, ScopeServer
	case "networks", "network-acls", "network-zones", "network-address-sets":
		// Networks of a project without its own networks live in the
		// default project and are shared by everyone, so changes are for admins.
		if !read {
			return RoleAdmin, ScopeServer
		}
	case "warnings":
		if read {
			return RoleViewer, ScopeAny
		}
		return RoleAdmin, ScopeServer
	case "projects":
		// Reads are checked against the project itself in checkIncus.
		if read {
			return RoleViewer, ScopeProject
		}
		return RoleAdmin, ScopeServer
	case "operations", "events":
		// Operations and events carry the websocket secrets of terminals
		// and consoles, so they need the role that may open those.
		return RoleOperator, ScopeProject
	}
	if read {
		// Reads that hand out data or credentials, not just state.
		for _, seg := range parts[2:] {
			switch seg {
			case "export", "debug", "keys":
				return RoleManager, ScopeProject
			case "files", "sftp", "logs", "console":
				return RoleOperator, ScopeProject
			}
		}
		return RoleViewer, ScopeProject
	}
	if coll == "instances" && len(parts) >= 4 {
		switch parts[3] {
		case "state", "exec", "console", "snapshots", "files", "sftp":
			// Restoring a snapshot goes through PUT /instances/<name>, which needs manager.
			if parts[3] == "snapshots" && method == http.MethodPut {
				return RoleManager, ScopeProject
			}
			return RoleOperator, ScopeProject
		}
	}
	return RoleManager, ScopeProject
}

// bodyProjects returns the projects a JSON request body names: Incus copies
// and moves between projects with "project" and "source.project".
func bodyProjects(r *http.Request) ([]string, error) {
	// Incus reads JSON whatever the Content-Type says. Uploads (images,
	// backups, files) never start with "{", so those are left unread.
	// File contents pushed to an instance are data, not a request.
	if r.Body == nil || r.Body == http.NoBody || strings.HasSuffix(r.URL.Path, "/files") {
		return nil, nil
	}
	br := bufio.NewReader(r.Body)
	body := r.Body
	r.Body = struct {
		io.Reader
		io.Closer
	}{br, body}
	// Look past leading whitespace without consuming it, so the body
	// reaches Incus byte for byte.
	for i := 0; ; i++ {
		c, err := br.Peek(i + 1)
		if err != nil || i >= 4096 {
			return nil, nil // empty, unreadable or not JSON: Incus gets the same
		}
		ch := c[i]
		if ch == ' ' || ch == '\t' || ch == '\r' || ch == '\n' {
			continue
		}
		if ch != '{' {
			return nil, nil
		}
		break
	}
	b, err := io.ReadAll(io.LimitReader(br, 4<<20+1))
	body.Close()
	if err != nil {
		return nil, err
	}
	if len(b) > 4<<20 {
		return nil, errors.New("request too large")
	}
	r.Body = io.NopCloser(bytes.NewReader(b))
	var v struct {
		Project string `json:"project"`
		Source  struct {
			Project string `json:"project"`
		} `json:"source"`
	}
	// Decode the way Incus does: the first JSON value, ignoring what follows.
	if err := json.NewDecoder(bytes.NewReader(b)).Decode(&v); err != nil {
		return nil, errors.New("bad request body")
	}
	var out []string
	for _, p := range []string{v.Project, v.Source.Project} {
		if p != "" {
			out = append(out, p)
		}
	}
	return out, nil
}

// roleAnywhere is the highest role the session has in any project of a server.
func roleAnywhere(list []Access, s *Session, server string) Role {
	subs := subjects(s)
	best := RoleNone
	for _, a := range list {
		if slices.Contains(subs, a.Who) && (a.Server == "*" || a.Server == server) && roleNames[a.Role] > best {
			best = roleNames[a.Role]
		}
	}
	return best
}

// checkIncus enforces roles on a proxied Incus call. It returns false after
// writing the error. For list calls across all projects it returns a filter
// that drops entries from projects the user can't see.
func (a *App) checkIncus(w http.ResponseWriter, r *http.Request, server, path string) (ok bool, filter func([]byte) []byte) {
	s, _ := a.currentSession(r)
	if s == nil {
		jsonError(w, http.StatusUnauthorized, "not signed in")
		return false, nil
	}
	access := a.store.Get().Access
	if roleFor(access, s, server, "") == RoleAdmin {
		return true, nil
	}
	q := r.URL.Query()
	need, scope := incusNeed(r.Method, path)
	project := q.Get("project")
	if project == "" {
		project = "default"
	}
	deny := func(p string) (bool, func([]byte) []byte) {
		jsonError(w, http.StatusForbidden, deniedMsg(need, p))
		return false, nil
	}
	switch scope {
	case ScopeServer:
		if roleFor(access, s, server, "*") < need {
			return deny("*")
		}
		return true, nil
	case ScopeAny:
		if roleAnywhere(access, s, server) < need {
			return deny(project)
		}
		return true, nil
	}
	if path == "/1.0/projects" {
		if roleFor(access, s, server, "*") >= RoleViewer {
			return true, nil
		}
		return true, func(body []byte) []byte {
			return filterProjects(body, true, func(p string) bool { return roleFor(access, s, server, p) >= RoleViewer })
		}
	}
	if p, ok := strings.CutPrefix(path, "/1.0/projects/"); ok {
		project, _, _ = strings.Cut(p, "/")
	}
	if q.Get("all-projects") == "true" {
		if roleFor(access, s, server, "*") >= need {
			return true, nil
		}
		if r.Method != http.MethodGet || strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
			jsonError(w, http.StatusForbidden, "You can only see some projects on this server, so pick one project.")
			return false, nil
		}
		return true, func(body []byte) []byte {
			return filterProjects(body, false, func(p string) bool { return roleFor(access, s, server, p) >= need })
		}
	}
	if roleFor(access, s, server, project) < need {
		return deny(project)
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead && project != "default" {
		// A project without its own profiles, volumes or images uses those
		// of the default project, which everyone shares.
		if f := sharedFeature(path); f != "" && !a.projectHas(r.Context(), server, project, f) {
			need = RoleAdmin
			return deny("*")
		}
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		// A copy or move names its other project in the body. Copying out
		// of a project reads all its data, so it takes the manager role.
		others, err := bodyProjects(r)
		if err != nil {
			jsonError(w, http.StatusBadRequest, err.Error())
			return false, nil
		}
		for _, p := range others {
			if roleFor(access, s, server, p) < max(need, RoleManager) {
				need = max(need, RoleManager)
				return deny(p)
			}
		}
	}
	return true, nil
}

// filterProjects drops list entries whose project fails keep. Entries are
// objects with a "project" field (recursion=1) or URLs with ?project=
// (recursion=0). For /1.0/projects (isProjects) the entry is the project itself.
func filterProjects(body []byte, isProjects bool, keep func(string) bool) []byte {
	var resp map[string]json.RawMessage
	if json.Unmarshal(body, &resp) != nil {
		return body
	}
	var items []json.RawMessage
	if json.Unmarshal(resp["metadata"], &items) != nil {
		// Not a plain list (operations come grouped by state, and those
		// don't say their project). Show nothing rather than too much.
		resp["metadata"] = json.RawMessage(`{}`)
		b, _ := json.Marshal(resp)
		return b
	}
	out := []json.RawMessage{}
	for _, it := range items {
		if keep(itemProject(it, isProjects)) {
			out = append(out, it)
		}
	}
	resp["metadata"], _ = json.Marshal(out)
	b, _ := json.Marshal(resp)
	return b
}

func itemProject(it json.RawMessage, isProjects bool) string {
	var s string
	if json.Unmarshal(it, &s) == nil {
		if strings.HasPrefix(s, "/1.0/projects/") {
			return strings.TrimPrefix(s, "/1.0/projects/")
		}
		if _, q, ok := strings.Cut(s, "?"); ok {
			for _, kv := range strings.Split(q, "&") {
				if p, ok := strings.CutPrefix(kv, "project="); ok {
					return p
				}
			}
		}
		return "default"
	}
	var o struct {
		Project string `json:"project"`
		Name    string `json:"name"`
	}
	_ = json.Unmarshal(it, &o)
	if isProjects {
		return o.Name
	}
	if o.Project != "" {
		return o.Project
	}
	return "default"
}

// filterResponse buffers a JSON response and rewrites it with fn.
type filterResponse struct {
	http.ResponseWriter
	buf    bytes.Buffer
	status int
}

func (f *filterResponse) WriteHeader(code int) { f.status = code }
func (f *filterResponse) Write(b []byte) (int, error) {
	return f.buf.Write(b)
}
func (f *filterResponse) Flush() {}

func (f *filterResponse) finish(fn func([]byte) []byte) {
	body := f.buf.Bytes()
	if f.status == 0 {
		f.status = http.StatusOK
	}
	if f.status == http.StatusOK && strings.Contains(f.Header().Get("Content-Type"), "json") {
		body = fn(body)
	}
	f.Header().Set("Content-Length", strconv.Itoa(len(body)))
	f.ResponseWriter.WriteHeader(f.status)
	_, _ = io.Copy(f.ResponseWriter, bytes.NewReader(body))
}

// --- the UI's view of its own permissions ---

func (a *App) handleMe(w http.ResponseWriter, r *http.Request) {
	s, _ := a.currentSession(r)
	cfg := a.store.Get()
	subs := subjects(s)
	mine := []Access{}
	for _, e := range cfg.Access {
		if slices.Contains(subs, e.Who) {
			mine = append(mine, e)
		}
	}
	writeJSON(w, map[string]any{"user": s.User, "method": s.Method, "admin": a.isAdmin(s), "access": mine})
}

func (a *App) handleAccessGet(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, map[string]any{"access": a.store.Get().Access})
}

func (a *App) handleAccessPut(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Access []Access `json:"access"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
		jsonError(w, http.StatusBadRequest, "bad request")
		return
	}
	for _, e := range req.Access {
		if msg := validAccess(e); msg != "" {
			jsonError(w, http.StatusBadRequest, msg)
			return
		}
	}
	s, _ := a.currentSession(r)
	if roleFor(req.Access, s, "", "") != RoleAdmin {
		jsonError(w, http.StatusBadRequest, "This would take away your own admin role. Keep at least one admin entry that matches you.")
		return
	}
	err := a.store.Update(func(c *Config) error {
		c.Access = req.Access
		return nil
	})
	if err != nil {
		jsonError(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func validAccess(e Access) string {
	if _, ok := roleNames[e.Role]; !ok {
		return "Unknown role " + strconv.Quote(e.Role) + "."
	}
	if e.Role == "admin" && (e.Server != "*" || e.Project != "*") {
		return "Admin covers every server and project. Use manager for one server or project."
	}
	if e.Server == "" || e.Project == "" {
		return "Pick a server and a project, or * for all."
	}
	switch {
	case e.Who == "*":
	case strings.HasPrefix(e.Who, "user:"), strings.HasPrefix(e.Who, "sso:"), strings.HasPrefix(e.Who, "group:"):
		if len(e.Who) < 6 || len(e.Who) > 200 {
			return "Bad name in " + strconv.Quote(e.Who) + "."
		}
	default:
		return "Who must start with user:, sso: or group:, or be *."
	}
	return ""
}

// sharedFeature is the project feature that decides whether a write to path
// stays in the project ("features.profiles"), or "" when it always does.
func sharedFeature(path string) string {
	parts := strings.Split(strings.Trim(path, "/"), "/")
	if len(parts) < 2 {
		return ""
	}
	switch {
	case parts[1] == "profiles":
		return "features.profiles"
	case parts[1] == "images":
		return "features.images"
	case parts[1] == "storage-pools" && len(parts) >= 4 && parts[3] == "volumes":
		return "features.storage.volumes"
	case parts[1] == "storage-pools" && len(parts) >= 4 && parts[3] == "buckets":
		return "features.storage.buckets"
	}
	return ""
}

// projectHas asks Incus whether a project has a feature turned on.
func (a *App) projectHas(ctx context.Context, server, project, feature string) bool {
	c, err := a.conn(server)
	if err != nil {
		return false
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	b, err := c.call(ctx, "GET", "/1.0/projects/"+url.PathEscape(project), "", nil)
	if err != nil {
		return false
	}
	var p struct {
		Config map[string]string `json:"config"`
	}
	return json.Unmarshal(b, &p) == nil && p.Config[feature] == "true"
}
