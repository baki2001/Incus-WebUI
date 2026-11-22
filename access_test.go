package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
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
	cases := []struct {
		method, path string
		want         Role
		wide         bool
	}{
		{"GET", "/1.0/instances", RoleViewer, false},
		{"PUT", "/1.0/instances/web/state", RoleOperator, false},
		{"POST", "/1.0/instances/web/exec", RoleOperator, false},
		{"POST", "/1.0/instances/web/snapshots", RoleOperator, false},
		{"PUT", "/1.0/instances/web", RoleManager, false},
		{"DELETE", "/1.0/instances/web", RoleManager, false},
		{"GET", "/1.0/instances/web/files", RoleOperator, false},
		{"GET", "/1.0/instances/web/logs/lxc.log", RoleOperator, false},
		{"GET", "/1.0/instances/web/backups/b1/export", RoleManager, false},
		{"POST", "/1.0/storage-pools", RoleAdmin, true},
		{"GET", "/1.0/storage-pools/default", RoleViewer, false},
		{"POST", "/1.0/storage-pools/default/volumes/custom", RoleManager, false},
		{"PATCH", "/1.0", RoleAdmin, true},
		{"GET", "/1.0/certificates", RoleAdmin, true},
		{"POST", "/1.0/projects", RoleAdmin, true},
		{"GET", "/os/1.0/system", RoleAdmin, true},
		{"PUT", "/1.0/cluster/members/a/state", RoleAdmin, true},
	}
	for _, c := range cases {
		got, wide := incusNeed(c.method, c.path, nil)
		if got != c.want || wide != c.wide {
			t.Errorf("%s %s = %v wide=%v, want %v wide=%v", c.method, c.path, got, wide, c.want, c.wide)
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
	_, ok, f = req("GET", "/1.0/projects?recursion=1&project=web")
	if !ok || f == nil {
		t.Fatal("expected a filtered project list")
	}
	pj, _ := json.Marshal(map[string]any{"metadata": []map[string]string{{"name": "web"}, {"name": "default"}}})
	var out3 struct{ Metadata []map[string]string }
	_ = json.Unmarshal(f(pj), &out3)
	if len(out3.Metadata) != 1 || out3.Metadata[0]["name"] != "web" {
		t.Errorf("filtered projects = %v", out3.Metadata)
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
