package main

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"strconv"
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
