package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
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
	// no session, no prefs
	r := httptest.NewRequest("GET", "/api/ui/prefs", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("want 401, got %d", w.Code)
	}
}
