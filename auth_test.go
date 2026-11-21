package main

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/crypto/bcrypt"
)

func testApp(t *testing.T, users ...string) *App {
	t.Helper()
	st, err := loadStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	h, _ := bcrypt.GenerateFromPassword([]byte("correct-password"), bcrypt.MinCost)
	_ = st.Update(func(c *Config) error {
		for _, u := range users {
			c.Users = append(c.Users, User{Username: u, PasswordHash: string(h)})
		}
		return nil
	})
	return &App{store: st, loginLimit: &limiter{}}
}

func post(h http.HandlerFunc, ip, body string, cookie *http.Cookie) *httptest.ResponseRecorder {
	r := httptest.NewRequest("POST", "/x", bytes.NewBufferString(body))
	r.RemoteAddr = ip + ":1234"
	r.Header.Set("X-Incus-UI", "1")
	if cookie != nil {
		r.AddCookie(cookie)
	}
	w := httptest.NewRecorder()
	h(w, r)
	return w
}

func sessionOf(w *httptest.ResponseRecorder) *http.Cookie {
	for _, c := range w.Result().Cookies() {
		if c.Name == sessionCookie && c.MaxAge >= 0 {
			return c
		}
	}
	return nil
}

func valid(a *App, c *http.Cookie) bool {
	r := httptest.NewRequest("GET", "/", nil)
	r.AddCookie(c)
	_, ok := a.currentSession(r)
	return ok
}

func TestLogoutRevokesSession(t *testing.T) {
	a := testApp(t, "admin")
	good := `{"username":"admin","password":"correct-password"}`
	c := sessionOf(post(a.handleLogin, "10.0.0.1", good, nil))
	if c == nil || !valid(a, c) {
		t.Fatal("login did not give a working session")
	}
	other := sessionOf(post(a.handleLogin, "10.0.0.2", good, nil))
	post(a.handleLogout, "10.0.0.1", ``, c)
	if valid(a, c) {
		t.Fatal("old cookie still works after logout")
	}
	if !valid(a, other) {
		t.Fatal("logout ended a different session")
	}
}

func TestRateLimitIsolation(t *testing.T) {
	a := testApp(t, "admin", "bob")
	now := time.Now()
	a.loginLimit.now = func() time.Time { return now }
	bad := `{"username":"admin","password":"nope"}`
	good := `{"username":"admin","password":"correct-password"}`
	for i := 0; i <= loginFreeTries; i++ {
		post(a.handleLogin, "6.6.6.6", bad, nil)
	}
	if w := post(a.handleLogin, "6.6.6.6", good, nil); w.Code != 429 {
		t.Fatalf("locked pair must stay locked, got %d", w.Code)
	}
	if w := post(a.handleLogin, "10.0.0.9", good, nil); w.Code != 200 {
		t.Fatalf("admin from a fresh IP blocked: %d", w.Code)
	}
	if w := post(a.handleLogin, "6.6.6.6", `{"username":"bob","password":"correct-password"}`, nil); w.Code != 200 {
		t.Fatalf("other user from the same IP blocked: %d", w.Code)
	}
	// Lockouts grow: the second one is longer than the first.
	now = now.Add(loginBaseLockout + time.Second)
	if w := post(a.handleLogin, "6.6.6.6", bad, nil); w.Code != 401 {
		t.Fatalf("lockout should have ended, got %d", w.Code)
	}
	now = now.Add(loginBaseLockout + time.Second)
	if w := post(a.handleLogin, "6.6.6.6", good, nil); w.Code != 429 {
		t.Fatalf("second lockout should outlast the first, got %d", w.Code)
	}
	// Same error for an unknown user and a wrong password.
	w1 := post(a.handleLogin, "7.7.7.7", `{"username":"ghost","password":"x"}`, nil)
	w2 := post(a.handleLogin, "7.7.7.7", `{"username":"bob","password":"x"}`, nil)
	if w1.Code != w2.Code || w1.Body.String() != w2.Body.String() {
		t.Fatal("login errors reveal whether the user exists")
	}
}

func TestRateLimitPerIPCap(t *testing.T) {
	a := testApp(t, "admin")
	for i := 0; i < loginIPMax; i++ {
		post(a.handleLogin, "6.6.6.6", `{"username":"u`+strconv.Itoa(i)+`","password":"x"}`, nil)
	}
	good := `{"username":"admin","password":"correct-password"}`
	if w := post(a.handleLogin, "6.6.6.6", good, nil); w.Code != 429 {
		t.Fatalf("per-IP cap not applied: %d", w.Code)
	}
	if w := post(a.handleLogin, "8.8.8.8", good, nil); w.Code != 200 {
		t.Fatalf("other IP blocked: %d", w.Code)
	}
}

func TestUserRules(t *testing.T) {
	a := testApp(t, "admin", "bob")
	admin := sessionOf(post(a.handleLogin, "1.1.1.1", `{"username":"admin","password":"correct-password"}`, nil))
	del := func(name string, c *http.Cookie) int {
		r := httptest.NewRequest("DELETE", "/", nil)
		r.SetPathValue("name", name)
		if c != nil {
			r.AddCookie(c)
		}
		w := httptest.NewRecorder()
		a.handleUserDelete(w, r)
		return w.Code
	}
	put := func(name string) int {
		r := httptest.NewRequest("PUT", "/", bytes.NewBufferString(`{"password":"brand-new-password"}`))
		r.SetPathValue("name", name)
		w := httptest.NewRecorder()
		a.handleUserPut(w, r)
		return w.Code
	}
	if c := del("admin", admin); c != 400 {
		t.Fatalf("removing yourself: %d", c)
	}
	if w := post(a.handleUserCreate, "1.1.1.1", `{"username":"bob","password":"another-password"}`, nil); w.Code != 409 {
		t.Fatalf("duplicate add: %d", w.Code)
	}
	if err := bcrypt.CompareHashAndPassword([]byte(a.store.Get().Users[1].PasswordHash), []byte("correct-password")); err != nil {
		t.Fatal("duplicate add changed the password")
	}
	if w := post(a.handleUserCreate, "1.1.1.1", `{"username":"carol","password":"another-password"}`, nil); w.Code != 204 {
		t.Fatalf("add: %d", w.Code)
	}
	if c := put("carol"); c != 204 {
		t.Fatalf("change password: %d", c)
	}
	if c := put("nobody"); c != 404 {
		t.Fatalf("change password of a missing user: %d", c)
	}
	if c := del("ghost", admin); c != 404 {
		t.Fatalf("remove missing: %d", c)
	}
	if c := del("bob", admin); c != 204 {
		t.Fatalf("remove other: %d", c)
	}
	if c := del("carol", admin); c != 204 {
		t.Fatalf("remove other: %d", c)
	}
	// admin is the last user. Another caller (no own account in play) still can't remove them.
	if c := del("admin", nil); c != 400 {
		t.Fatalf("removing the last user: %d", c)
	}
	if len(a.store.Get().Users) != 1 {
		t.Fatal("last user was removed")
	}
}

func TestRateLimitParallel(t *testing.T) {
	l := &limiter{}
	var allowed atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if ok, _ := l.check("6.6.6.6", "admin"); ok {
				time.Sleep(10 * time.Millisecond) // a slow password check
				allowed.Add(1)
			}
		}()
	}
	wg.Wait()
	if n := allowed.Load(); n > loginFreeTries+1 {
		t.Fatalf("%d parallel attempts got through, want at most %d", n, loginFreeTries+1)
	}
}

func TestRateLimitPrunesIPs(t *testing.T) {
	l := &limiter{}
	now := time.Now()
	l.now = func() time.Time { return now }
	for i := 0; i < 10001; i++ {
		l.check("ip"+strconv.Itoa(i), "u")
	}
	now = now.Add(2 * time.Hour)
	l.check("fresh", "u")
	if len(l.ips) != 1 || len(l.pairs) != 1 {
		t.Fatalf("stale entries kept: %d ips, %d pairs", len(l.ips), len(l.pairs))
	}
}

func TestPasswordChangeEndsSessions(t *testing.T) {
	a := testApp(t, "admin", "bob")
	good := `{"username":"admin","password":"correct-password"}`
	old := sessionOf(post(a.handleLogin, "1.1.1.1", good, nil))
	bob := sessionOf(post(a.handleLogin, "1.1.1.2", `{"username":"bob","password":"correct-password"}`, nil))
	put := func(name string, c *http.Cookie) *httptest.ResponseRecorder {
		r := httptest.NewRequest("PUT", "/", bytes.NewBufferString(`{"password":"brand-new-password"}`))
		r.SetPathValue("name", name)
		if c != nil {
			r.AddCookie(c)
		}
		w := httptest.NewRecorder()
		a.handleUserPut(w, r)
		return w
	}
	// Changing your own password keeps this browser signed in, with a new cookie.
	w := put("admin", old)
	fresh := sessionOf(w)
	if w.Code != 204 || fresh == nil || !valid(a, fresh) {
		t.Fatal("own password change did not reissue a working session")
	}
	if valid(a, old) {
		t.Fatal("old cookie survived a password change")
	}
	// Changing someone else's password ends theirs only.
	put("bob", fresh)
	if valid(a, bob) || !valid(a, fresh) {
		t.Fatal("password change affected the wrong sessions")
	}
}

func TestRecreatedUserRejectsOldCookie(t *testing.T) {
	a := testApp(t, "admin", "bob")
	old := sessionOf(post(a.handleLogin, "1.1.1.2", `{"username":"bob","password":"correct-password"}`, nil))
	r := httptest.NewRequest("DELETE", "/", nil)
	r.SetPathValue("name", "bob")
	a.handleUserDelete(httptest.NewRecorder(), r)
	if w := post(a.handleUserCreate, "1.1.1.1", `{"username":"bob","password":"another-password"}`, nil); w.Code != 204 {
		t.Fatalf("recreate: %d", w.Code)
	}
	if valid(a, old) {
		t.Fatal("old cookie works for a re-created user")
	}
}

func TestClientIPTrustedProxies(t *testing.T) {
	trusted := parseTrusted([]string{"10.0.0.0/24", "192.168.1.1", "bogus", " ::1 "})
	if len(trusted) != 3 {
		t.Fatalf("trusted: %v", trusted)
	}
	req := func(remote, xff string) *http.Request {
		r := httptest.NewRequest("GET", "/", nil)
		r.RemoteAddr = remote
		if xff != "" {
			r.Header.Set("X-Forwarded-For", xff)
		}
		return r
	}
	for _, c := range []struct{ remote, xff, want string }{
		{"203.0.113.9:1234", "1.2.3.4", "203.0.113.9"},                  // not a proxy: header ignored
		{"10.0.0.7:80", "", "10.0.0.7"},                                 // no header
		{"10.0.0.7:80", "198.51.100.2", "198.51.100.2"},                 // plain proxy
		{"10.0.0.7:80", "6.6.6.6, 198.51.100.2", "198.51.100.2"},        // client-forged left entry ignored
		{"10.0.0.7:80", "198.51.100.2, 10.0.0.9", "198.51.100.2"},       // chain of trusted proxies
		{"192.168.1.1:80", "198.51.100.2, 192.168.1.1", "198.51.100.2"}, // single-IP entry
		{"10.0.0.7:80", "nonsense", "10.0.0.7"},
	} {
		if got := clientIP(req(c.remote, c.xff), trusted); got != c.want {
			t.Errorf("clientIP(%s, %q) = %s, want %s", c.remote, c.xff, got, c.want)
		}
	}
	if got := clientIP(req("10.0.0.7:80", "1.2.3.4"), nil); got != "10.0.0.7" {
		t.Errorf("no trusted proxies: %s", got)
	}
}

func TestOIDCGen(t *testing.T) {
	st, err := loadStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	a := &App{store: st}
	if err := st.Update(func(c *Config) error {
		c.OIDC = &OIDCConfig{Issuer: "https://idp", ClientID: "x", AllowedEmails: []string{"a@x"}}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRecorder()
	a.setSession(r, httptest.NewRequest("GET", "/", nil), "a@x", "oidc")
	cookie := r.Result().Cookies()[0]
	check := func() bool {
		req := httptest.NewRequest("GET", "/", nil)
		req.AddCookie(cookie)
		_, ok := a.currentSession(req)
		return ok
	}
	if !check() {
		t.Fatal("fresh oidc session should work")
	}
	_ = st.Update(func(c *Config) error { c.OIDC.ButtonLabel = "Company SSO"; return nil })
	if !check() {
		t.Error("a label change must not end sessions")
	}
	_ = st.Update(func(c *Config) error { c.OIDC.AllowedEmails = []string{"b@x"}; return nil })
	if check() {
		t.Error("changing the allowed list must end oidc sessions")
	}
}

func TestLogoutChecksOrigin(t *testing.T) {
	st, _ := loadStore(t.TempDir())
	a := &App{store: st}
	r := httptest.NewRequest("POST", "/api/ui/logout", nil)
	w := httptest.NewRecorder()
	a.handleLogout(w, r)
	if w.Code != http.StatusForbidden {
		t.Errorf("logout without X-Incus-UI: %d", w.Code)
	}
	r.Header.Set("X-Incus-UI", "1")
	w = httptest.NewRecorder()
	a.handleLogout(w, r)
	if w.Code != http.StatusNoContent {
		t.Errorf("logout: %d", w.Code)
	}
}
