package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
)

func TestRoleFor(t *testing.T) {
	list := []Access{
		{Who: "user:ann", Server: "*", Project: "*", Role: "admin"},
		{Who: "user:bob", Server: "lab", Project: "web", Role: "manager"},
		{Who: "user:bob", Server: "*", Project: "*", Role: "viewer"},
		{Who: "group:ops", Server: "lab", Project: "*", Role: "operator"},
		{Who: "user:eve", Server: "lab", Project: "web", Role: "admin"}, // invalid scope, ignored
	}
	cases := []struct {
		s               Session
		server, project string
		want            Role
	}{
		{Session{User: "ann", Method: "password"}, "lab", "x", RoleAdmin},
		{Session{User: "bob", Method: "password"}, "lab", "web", RoleManager},
		{Session{User: "bob", Method: "password"}, "lab", "db", RoleViewer},
		{Session{User: "bob", Method: "oidc"}, "lab", "web", RoleNone}, // sso:bob is someone else
		{Session{User: "zed", Method: "oidc", Groups: []string{"ops"}}, "lab", "db", RoleOperator},
		{Session{User: "zed", Method: "oidc", Groups: []string{"ops"}}, "other", "db", RoleNone},
		{Session{User: "eve", Method: "password"}, "lab", "web", RoleNone},
	}
	for _, c := range cases {
		if got := roleFor(list, &c.s, c.server, c.project); got != c.want {
			t.Errorf("%s/%s on %s/%s = %v, want %v", c.s.Method, c.s.User, c.server, c.project, got, c.want)
		}
	}
}

func TestIncusNeed(t *testing.T) {
	P, S, A := ScopeProject, ScopeServer, ScopeAny
	cases := []struct {
		method, path string
		want         Role
		scope        Scope
	}{
		{"GET", "/1.0", RoleViewer, A},
		{"GET", "/1.0/instances", RoleViewer, P},
		{"PUT", "/1.0/instances/web/state", RoleOperator, P},
		{"POST", "/1.0/instances/web/exec", RoleOperator, P},
		{"POST", "/1.0/instances/web/snapshots", RoleOperator, P},
		{"PUT", "/1.0/instances/web", RoleManager, P},
		{"DELETE", "/1.0/instances/web", RoleManager, P},
		{"GET", "/1.0/instances/web/files", RoleOperator, P},
		{"GET", "/1.0/instances/web/logs/lxc.log", RoleOperator, P},
		{"GET", "/1.0/instances/web/backups/b1/export", RoleManager, P},
		{"POST", "/1.0/storage-pools", RoleAdmin, S},
		{"GET", "/1.0/storage-pools/default", RoleViewer, A},
		{"POST", "/1.0/storage-pools/default/volumes/custom", RoleManager, P},
		{"PATCH", "/1.0", RoleAdmin, S},
		{"GET", "/1.0/certificates", RoleAdmin, S},
		{"GET", "/1.0/metrics", RoleViewer, S},
		{"POST", "/1.0/projects", RoleAdmin, S},
		{"GET", "/1.0/projects/web", RoleViewer, P},
		{"GET", "/os/1.0/system", RoleAdmin, S},
		{"PUT", "/1.0/cluster/members/a/state", RoleAdmin, S},
		{"GET", "/1.0/operations", RoleOperator, P},
		{"GET", "/1.0/operations/x/websocket", RoleOperator, P},
		{"GET", "/1.0/events", RoleOperator, P},
		{"GET", "/1.0/storage-pools/p/buckets/b/keys", RoleManager, P},
		{"GET", "/1.0/storage-pools/p/volumes/custom/v/backups/b/export", RoleManager, P},
		{"GET", "/1.0/storage-pools/p/volumes/custom/v/sftp", RoleOperator, P},
		{"GET", "/1.0/instances/x/debug/memory", RoleManager, P},
		{"POST", "/1.0/networks", RoleAdmin, S},
		{"GET", "/1.0/networks", RoleViewer, P},
		{"POST", "/1.0/network-integrations", RoleAdmin, S},
	}
	for _, c := range cases {
		got, scope := incusNeed(c.method, c.path)
		if got != c.want || scope != c.scope {
			t.Errorf("%s %s = %v scope %v, want %v scope %v", c.method, c.path, got, scope, c.want, c.scope)
		}
	}
}

func signedIn(t *testing.T, a *App, user string) *http.Cookie {
	t.Helper()
	w := httptest.NewRecorder()
	a.setSession(w, httptest.NewRequest("GET", "/", nil), user, "password")
	return sessionOf(w)
}

func TestCheckIncusFiltersProjects(t *testing.T) {
	a := testApp(t, "bob")
	_ = a.store.Update(func(c *Config) error {
		c.Access = []Access{{Who: "user:bob", Server: "lab", Project: "web", Role: "operator"}}
		return nil
	})
	ck := signedIn(t, a, "bob")
	req := func(method, url string) (*httptest.ResponseRecorder, bool, func([]byte) []byte) {
		r := httptest.NewRequest(method, url, nil)
		r.AddCookie(ck)
		w := httptest.NewRecorder()
		ok, f := a.checkIncus(w, r, "lab", strings.SplitN(r.URL.Path, "?", 2)[0])
		return w, ok, f
	}
	if _, ok, _ := req("PUT", "/1.0/instances/a/state?project=web"); !ok {
		t.Error("operator can't start an instance in its project")
	}
	if w, ok, _ := req("PUT", "/1.0/instances/a/state?project=db"); ok || w.Code != 403 {
		t.Error("operator could start an instance in another project")
	}
	if _, ok, _ := req("PUT", "/1.0/instances/a/state"); ok {
		t.Error("no project means default, which bob has no role on")
	}
	if _, ok, _ := req("DELETE", "/1.0/instances/a?project=web"); ok {
		t.Error("operator could delete an instance")
	}
	_, ok, f := req("GET", "/1.0/instances?recursion=1&all-projects=true")
	if !ok || f == nil {
		t.Fatal("expected a filtered list")
	}
	body, _ := json.Marshal(map[string]any{"metadata": []map[string]string{{"name": "a", "project": "web"}, {"name": "b", "project": "db"}}})
	var out struct{ Metadata []map[string]string }
	_ = json.Unmarshal(f(body), &out)
	if len(out.Metadata) != 1 || out.Metadata[0]["name"] != "a" {
		t.Errorf("filtered list = %v", out.Metadata)
	}
	urls, _ := json.Marshal(map[string]any{"metadata": []string{"/1.0/instances/a?project=web", "/1.0/instances/b?project=db", "/1.0/instances/c"}})
	_ = json.Unmarshal(f(urls), &struct{}{})
	var out2 struct{ Metadata []string }
	_ = json.Unmarshal(f(urls), &out2)
	if len(out2.Metadata) != 1 {
		t.Errorf("filtered URL list = %v", out2.Metadata)
	}
	if _, ok, _ := req("GET", "/1.0"); !ok {
		t.Error("server info must be readable with a role in any project")
	}
	if _, ok, _ := req("GET", "/1.0/projects/web"); !ok {
		t.Error("can't read own project")
	}
	if _, ok, _ := req("GET", "/1.0/projects/db"); ok {
		t.Error("could read another project")
	}
	if _, ok, _ := req("GET", "/1.0/metrics"); ok {
		t.Error("raw metrics cover every project")
	}
	_, ok, f = req("GET", "/1.0/projects?recursion=1")
	if !ok || f == nil {
		t.Fatal("expected a filtered project list")
	}
	pj, _ := json.Marshal(map[string]any{"metadata": []map[string]string{{"name": "web"}, {"name": "default"}}})
	var out3 struct{ Metadata []map[string]string }
	_ = json.Unmarshal(f(pj), &out3)
	if len(out3.Metadata) != 1 || out3.Metadata[0]["name"] != "web" {
		t.Errorf("filtered projects = %v", out3.Metadata)
	}
	copyFrom := func(body string) bool {
		r := httptest.NewRequest("POST", "/1.0/instances?project=web", strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		r.AddCookie(ck)
		ok, _ := a.checkIncus(httptest.NewRecorder(), r, "lab", "/1.0/instances")
		return ok
	}
	_ = a.store.Update(func(c *Config) error {
		c.Access = append(c.Access, Access{Who: "user:bob", Server: "lab", Project: "web", Role: "manager"}, Access{Who: "user:bob", Server: "lab", Project: "own", Role: "manager"})
		return nil
	})
	if copyFrom(`{"name":"x","source":{"type":"copy","source":"db1","project":"db"}}`) {
		t.Error("a copy out of another project was allowed")
	}
	r := httptest.NewRequest("POST", "/1.0/instances?project=web", strings.NewReader(`{"source":{"project":"db"}}`))
	r.AddCookie(ck)
	if ok, _ := a.checkIncus(httptest.NewRecorder(), r, "lab", "/1.0/instances"); ok {
		t.Error("a copy without a Content-Type skipped the project check")
	}
	if !copyFrom(`{"name":"x","source":{"type":"copy","source":"a","project":"own"}}`) {
		t.Error("a copy between own projects was refused")
	}
	if _, ok, _ := req("POST", "/1.0/instances/a/exec?all-projects=true"); ok {
		t.Error("a change across all projects was allowed")
	}
}

func TestUpgradeMakesEveryoneAdmin(t *testing.T) {
	a := testApp(t, "old")
	if got := a.store.Get().Access; len(got) != 1 || got[0].Who != "*" || got[0].Role != "admin" {
		t.Fatalf("access after upgrade = %+v", got)
	}
	s := &Session{User: "old", Method: "password"}
	if !a.isAdmin(s) {
		t.Error("existing users must stay admin")
	}
}

func TestAccessPutKeepsAnAdmin(t *testing.T) {
	a := testApp(t, "ann")
	ck := signedIn(t, a, "ann")
	put := func(body string) int {
		r := httptest.NewRequest("PUT", "/api/ui/access", strings.NewReader(body))
		r.AddCookie(ck)
		w := httptest.NewRecorder()
		a.handleAccessPut(w, r)
		return w.Code
	}
	if c := put(`{"access":[{"who":"user:bob","server":"*","project":"*","role":"admin"}]}`); c != 400 {
		t.Errorf("removing your own admin role gave %d", c)
	}
	if c := put(`{"access":[{"who":"user:ann","server":"lab","project":"*","role":"admin"}]}`); c != 400 {
		t.Errorf("admin with a narrow scope gave %d", c)
	}
	if c := put(`{"access":[{"who":"user:ann","server":"*","project":"*","role":"admin"},{"who":"user:bob","server":"lab","project":"web","role":"operator"}]}`); c != 204 {
		t.Errorf("valid list gave %d", c)
	}
}

func TestBodyProjects(t *testing.T) {
	cases := []struct {
		path, body string
		want       []string
		bad        bool
	}{
		{"/1.0/instances/vm1", `{"name":"vm1","project":"db"} x`, []string{"db"}, false},
		{"/1.0/instances", "\n\t {\"source\":{\"project\":\"db\"}}", []string{"db"}, false},
		{"/1.0/instances", `{"name":`, nil, true},
		{"/1.0/instances/vm1/files", `{"project":"db"}`, nil, false},
		{"/1.0/instances/vm1/files", "\n  #!/bin/sh\n", nil, false},
		{"/1.0/images", "  \x00binary", nil, false},
		{"/1.0/instances/vm1", strings.Repeat(" ", 5000) + `{"project":"db"}`, nil, true},
		{"/1.0/instances/files", `{"name":"files","project":"db"}`, []string{"db"}, false},
	}
	for _, c := range cases {
		r := httptest.NewRequest("POST", c.path, strings.NewReader(c.body))
		got, err := bodyProjects(r)
		if (err != nil) != c.bad || !slices.Equal(got, c.want) {
			t.Errorf("%s %q: got %v, %v", c.path, c.body, got, err)
		}
		if c.bad {
			continue
		}
		rest, _ := io.ReadAll(r.Body)
		if string(rest) != c.body {
			t.Errorf("%s %q: body forwarded as %q", c.path, c.body, rest)
		}
	}
}
