package main

import (
	"archive/tar"
	"compress/gzip"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"filippo.io/age"
)

func TestDashboardPrefs(t *testing.T) {
	dir := t.TempDir()
	store, err := loadStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	store.Update(func(c *Config) error { c.Users = []User{{Username: "admin"}}; return nil })
	a := &App{store: store, dataDir: dir}
	h := a.routes()
	rec := httptest.NewRecorder()
	a.setSession(rec, httptest.NewRequest("GET", "/", nil), "admin", "password")
	cookie := rec.Result().Cookies()[0]

	do := func(method, body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, "/api/ui/prefs", strings.NewReader(body))
		r.Header.Set("X-Incus-UI", "1")
		r.AddCookie(cookie)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}

	if w := do("GET", ""); w.Code != 200 || strings.TrimSpace(w.Body.String()) != `{}` {
		t.Fatalf("fresh GET: %d %q", w.Code, w.Body.String())
	}
	good := `{"dashboard":{"items":[{"id":"capacity","on":true},{"id":"snapshots","on":false,"size":"s"}]}}`
	if w := do("PUT", good); w.Code != http.StatusOK {
		t.Fatalf("PUT: %d %s", w.Code, w.Body.String())
	}
	if w := do("GET", ""); !strings.Contains(w.Body.String(), `"id":"snapshots","on":false,"size":"s"`) {
		t.Fatalf("not saved: %s", w.Body.String())
	}
	// survives a reload from disk
	again, err := loadStore(dir)
	if err != nil || len(again.Get().UIPrefs["admin"].Dashboard.Items) != 2 {
		t.Fatalf("not on disk: %v", err)
	}
	for _, bad := range []string{
		`{"dashboard":{"items":[{"id":"Bad Id","on":true}]}}`,
		`{"dashboard":{"items":[{"id":"a","on":true},{"id":"a","on":true}]}}`,
		`{"dashboard":{"items":[{"id":"a","on":true,"size":"xl"}]}}`,
		`nope`,
	} {
		if w := do("PUT", bad); w.Code != http.StatusBadRequest {
			t.Fatalf("want 400 for %s, got %d", bad, w.Code)
		}
	}
	// SSH keys are saved on their own and leave the dashboard alone.
	key := `{"ssh_keys":[{"name":"laptop","key":"ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl me@laptop"}]}`
	if w := do("PUT", key); w.Code != http.StatusOK {
		t.Fatalf("PUT key: %d %s", w.Code, w.Body.String())
	}
	if w := do("GET", ""); !strings.Contains(w.Body.String(), `"laptop"`) || !strings.Contains(w.Body.String(), `"snapshots"`) {
		t.Fatalf("after key: %s", w.Body.String())
	}
	if w := do("PUT", good); w.Code != 200 || !strings.Contains(do("GET", "").Body.String(), `"laptop"`) {
		t.Fatal("a dashboard save dropped the SSH keys")
	}
	for _, bad := range []string{`{"ssh_keys":[{"name":"x","key":"not a key"}]}`, `{"ssh_keys":[{"name":"","key":"ssh-ed25519 AAAA"}]}`, `{"ssh_keys":[{"name":"x","key":"ssh-ed25519 AAAA\nssh-rsa BBBB"}]}`} {
		if w := do("PUT", bad); w.Code != http.StatusBadRequest {
			t.Errorf("want 400 for %s, got %d", bad, w.Code)
		}
	}
	if w := do("PUT", `{"ssh_keys":[]}`); w.Code != 200 || strings.Contains(do("GET", "").Body.String(), "laptop") {
		t.Error("keys not cleared")
	}
	// no session, no prefs
	r := httptest.NewRequest("GET", "/api/ui/prefs", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("want 401, got %d", w.Code)
	}
}

func TestDeleteUserDropsPrefs(t *testing.T) {
	a := testApp(t, "admin", "bob")
	a.store.Update(func(c *Config) error {
		c.UIPrefs = map[string]UIPrefs{"bob": {Dashboard: &DashPrefs{}}, "oidc:bob": {Dashboard: &DashPrefs{}}}
		return nil
	})
	r := httptest.NewRequest("DELETE", "/", nil)
	r.SetPathValue("name", "bob")
	a.handleUserDelete(httptest.NewRecorder(), r)
	p := a.store.Get().UIPrefs
	if _, ok := p["bob"]; ok || len(p) != 1 {
		t.Fatalf("prefs after delete: %v", p)
	}
}

func TestConfigExport(t *testing.T) {
	a := testApp(t, "admin")
	a.dataDir = filepath.Dir(a.store.path)
	os.WriteFile(filepath.Join(a.dataDir, "client.key"), []byte("KEY"), 0o600)
	for _, pass := range []string{"", "a long passphrase"} {
		w := httptest.NewRecorder()
		a.handleConfigExport(w, httptest.NewRequest("POST", "/", strings.NewReader(`{"passphrase":"`+pass+`"}`)))
		if w.Code != 200 {
			t.Fatalf("%d %s", w.Code, w.Body.String())
		}
		var r io.Reader = w.Body
		if pass != "" {
			id, _ := age.NewScryptIdentity(pass)
			var err error
			if r, err = age.Decrypt(r, id); err != nil {
				t.Fatal(err)
			}
		}
		gz, err := gzip.NewReader(r)
		if err != nil {
			t.Fatal(err)
		}
		tr := tar.NewReader(gz)
		got := map[string]string{}
		for {
			h, err := tr.Next()
			if err != nil {
				break
			}
			b, _ := io.ReadAll(tr)
			got[h.Name] = string(b)
		}
		if !strings.Contains(got["config.yaml"], "session_secret") || got["client.key"] != "KEY" {
			t.Errorf("export %v", got)
		}
	}
	w := httptest.NewRecorder()
	a.handleConfigExport(w, httptest.NewRequest("POST", "/", strings.NewReader(`{"passphrase":"short"}`)))
	if w.Code != 400 {
		t.Errorf("short passphrase: %d", w.Code)
	}
}
