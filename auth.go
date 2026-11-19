package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/bcrypt"
)

const sessionCookie = "iwui_session"
const sessionTTL = 7 * 24 * time.Hour

type Session struct {
	User    string `json:"u"`
	Method  string `json:"m"` // password | oidc
	Expires int64  `json:"e"`
}

func (a *App) signSession(s Session) string {
	payload, _ := json.Marshal(s)
	p := base64.RawURLEncoding.EncodeToString(payload)
	return p + "." + a.mac(p)
}

func (a *App) mac(v string) string {
	m := hmac.New(sha256.New, []byte(a.store.Get().SessionSecret))
	m.Write([]byte(v))
	return base64.RawURLEncoding.EncodeToString(m.Sum(nil))
}

func (a *App) setSession(w http.ResponseWriter, r *http.Request, user, method string) {
	s := Session{User: user, Method: method, Expires: time.Now().Add(sessionTTL).Unix()}
	http.SetCookie(w, &http.Cookie{
		Name: sessionCookie, Value: a.signSession(s), Path: "/", HttpOnly: true,
		Secure: a.secureCookies(r), SameSite: http.SameSiteLaxMode, MaxAge: int(sessionTTL.Seconds()),
	})
}

func (a *App) secureCookies(r *http.Request) bool {
	return r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https"
}

// currentSession validates the cookie and re-checks that the user still exists,
// so deleting a user or turning off OIDC ends their sessions.
func (a *App) currentSession(r *http.Request) (*Session, bool) {
	c, err := r.Cookie(sessionCookie)
	if err != nil {
		return nil, false
	}
	p, sig, ok := strings.Cut(c.Value, ".")
	if !ok || subtle.ConstantTimeCompare([]byte(sig), []byte(a.mac(p))) != 1 {
		return nil, false
	}
	raw, err := base64.RawURLEncoding.DecodeString(p)
	if err != nil {
		return nil, false
	}
	var s Session
	if json.Unmarshal(raw, &s) != nil || time.Now().Unix() > s.Expires {
		return nil, false
	}
	cfg := a.store.Get()
	switch s.Method {
	case "password":
		for _, u := range cfg.Users {
			if u.Username == s.User {
				return &s, true
			}
		}
		return nil, false
	case "oidc":
		return &s, cfg.OIDC != nil
	}
	return nil, false
}

// requireAuth wraps every API handler. Mutating requests must also carry the
// X-Incus-UI header, which a cross-site form cannot set (CSRF guard), and
// websocket upgrades must come from our own origin.
func (a *App) requireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, ok := a.currentSession(r); !ok {
			jsonError(w, http.StatusUnauthorized, "not signed in")
			return
		}
		if !sameOriginOK(r) {
			jsonError(w, http.StatusForbidden, "bad request origin")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func sameOriginOK(r *http.Request) bool {
	if strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		o := r.Header.Get("Origin")
		if o == "" {
			return false
		}
		o = strings.TrimPrefix(strings.TrimPrefix(o, "https://"), "http://")
		return o == r.Host || o == r.Header.Get("X-Forwarded-Host")
	}
	if r.Method == http.MethodGet || r.Method == http.MethodHead {
		return true
	}
	return r.Header.Get("X-Incus-UI") == "1"
}

// --- login rate limiting: 10 attempts per 5 minutes per client IP ---

type limiter struct {
	mu   sync.Mutex
	hits map[string][]time.Time
}

func (l *limiter) allow(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	cut := now.Add(-5 * time.Minute)
	h := l.hits[key][:0]
	for _, t := range l.hits[key] {
		if t.After(cut) {
			h = append(h, t)
		}
	}
	if len(h) >= 10 {
		l.hits[key] = h
		return false
	}
	l.hits[key] = append(h, now)
	return true
}

func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// dummyHash keeps timing the same when the user does not exist.
var dummyHash, _ = bcrypt.GenerateFromPassword([]byte("not-a-real-password"), bcrypt.DefaultCost)

func (a *App) handleLogin(w http.ResponseWriter, r *http.Request) {
	if !sameOriginOK(r) {
		jsonError(w, http.StatusForbidden, "bad request origin")
		return
	}
	if !a.loginLimit.allow(clientIP(r)) {
		jsonError(w, http.StatusTooManyRequests, "Too many attempts. Try again in a few minutes.")
		return
	}
	var req struct{ Username, Password string }
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
		jsonError(w, http.StatusBadRequest, "bad request")
		return
	}
	hash := dummyHash
	found := false
	for _, u := range a.store.Get().Users {
		if u.Username == req.Username {
			hash, found = []byte(u.PasswordHash), true
		}
	}
	if bcrypt.CompareHashAndPassword(hash, []byte(req.Password)) != nil || !found {
		jsonError(w, http.StatusUnauthorized, "Wrong username or password.")
		return
	}
	a.setSession(w, r, req.Username, "password")
	writeJSON(w, map[string]string{"user": req.Username})
}

func (a *App) handleLogout(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{Name: sessionCookie, Value: "", Path: "/", MaxAge: -1, HttpOnly: true})
	w.WriteHeader(http.StatusNoContent)
}

// handleAuthInfo tells the login page what to show. It never reveals users.
func (a *App) handleAuthInfo(w http.ResponseWriter, r *http.Request) {
	cfg := a.store.Get()
	resp := map[string]any{
		"setup_required": len(cfg.Users) == 0 && cfg.OIDC == nil,
		"password":       len(cfg.Users) > 0,
		"oidc":           cfg.OIDC != nil,
		"theme":          cfg.Theme,
	}
	if cfg.OIDC != nil {
		label := cfg.OIDC.ButtonLabel
		if label == "" {
			label = "Sign in with SSO"
		}
		resp["oidc_label"] = label
	}
	if s, ok := a.currentSession(r); ok {
		resp["user"] = s.User
		resp["method"] = s.Method
	}
	writeJSON(w, resp)
}

var usernameRe = regexp.MustCompile(`^[a-zA-Z0-9._@-]{1,64}$`)

func validateCredentials(user, pass string) error {
	if !usernameRe.MatchString(user) {
		return errors.New("Username can use letters, numbers and . _ @ - (up to 64).")
	}
	if len(pass) < 10 {
		return errors.New("Password needs at least 10 characters.")
	}
	if len(pass) > 72 {
		return errors.New("Password can be at most 72 characters.")
	}
	return nil
}

// handleSetup creates the first user. It needs the one-time token printed in
// the server log, so nobody else on the network can claim a fresh install.
func (a *App) handleSetup(w http.ResponseWriter, r *http.Request) {
	if !sameOriginOK(r) {
		jsonError(w, http.StatusForbidden, "bad request origin")
		return
	}
	if !a.loginLimit.allow(clientIP(r)) {
		jsonError(w, http.StatusTooManyRequests, "Too many attempts. Try again in a few minutes.")
		return
	}
	var req struct{ Token, Username, Password string }
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
		jsonError(w, http.StatusBadRequest, "bad request")
		return
	}
	if a.setupToken == "" || subtle.ConstantTimeCompare([]byte(req.Token), []byte(a.setupToken)) != 1 {
		jsonError(w, http.StatusForbidden, "That setup code is not right. It is printed in the server log.")
		return
	}
	if err := validateCredentials(req.Username, req.Password); err != nil {
		jsonError(w, http.StatusBadRequest, err.Error())
		return
	}
	hash, _ := bcrypt.GenerateFromPassword([]byte(req.Password), bcrypt.DefaultCost)
	err := a.store.Update(func(c *Config) error {
		if len(c.Users) > 0 || c.OIDC != nil {
			return errors.New("already set up")
		}
		c.Users = append(c.Users, User{Username: req.Username, PasswordHash: string(hash)})
		return nil
	})
	if err != nil {
		jsonError(w, http.StatusConflict, err.Error())
		return
	}
	a.setupToken = ""
	a.setSession(w, r, req.Username, "password")
	writeJSON(w, map[string]string{"user": req.Username})
}

// --- local users ---

func (a *App) handleUsers(w http.ResponseWriter, r *http.Request) {
	cfg := a.store.Get()
	out := []map[string]string{}
	for _, u := range cfg.Users {
		out = append(out, map[string]string{"username": u.Username})
	}
	resp := map[string]any{"users": out}
	if cfg.OIDC != nil {
		resp["oidc"] = map[string]any{"issuer": cfg.OIDC.Issuer, "allowed_emails": cfg.OIDC.AllowedEmails, "allowed_groups": cfg.OIDC.AllowedGroups}
	}
	writeJSON(w, resp)
}

func (a *App) handleUserPut(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	var req struct{ Password string }
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
		jsonError(w, http.StatusBadRequest, "bad request")
		return
	}
	if err := validateCredentials(name, req.Password); err != nil {
		jsonError(w, http.StatusBadRequest, err.Error())
		return
	}
	hash, _ := bcrypt.GenerateFromPassword([]byte(req.Password), bcrypt.DefaultCost)
	err := a.store.Update(func(c *Config) error {
		for i := range c.Users {
			if c.Users[i].Username == name {
				c.Users[i].PasswordHash = string(hash)
				return nil
			}
		}
		c.Users = append(c.Users, User{Username: name, PasswordHash: string(hash)})
		return nil
	})
	if err != nil {
		jsonError(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *App) handleUserDelete(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	err := a.store.Update(func(c *Config) error {
		out := c.Users[:0]
		for _, u := range c.Users {
			if u.Username != name {
				out = append(out, u)
			}
		}
		if len(out) == 0 && c.OIDC == nil {
			return errors.New("You can't remove the last user while SSO is off.")
		}
		c.Users = out
		return nil
	})
	if err != nil {
		jsonError(w, http.StatusBadRequest, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func jsonError(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}
