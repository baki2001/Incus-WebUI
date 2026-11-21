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
	"strconv"
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
	ID      string `json:"i"` // lets logout revoke this one session
	Gen     int64  `json:"g"` // the user's session generation; a password change or re-creation ends older sessions
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
	s := Session{User: user, Method: method, Expires: time.Now().Add(sessionTTL).Unix(), ID: randHex(16)}
	if method == "password" {
		for _, u := range a.store.Get().Users {
			if u.Username == user {
				s.Gen = u.SessionGen
			}
		}
	}
	http.SetCookie(w, &http.Cookie{
		Name: sessionCookie, Value: a.signSession(s), Path: "/", HttpOnly: true,
		Secure: a.secureCookies(r), SameSite: http.SameSiteLaxMode, MaxAge: int(sessionTTL.Seconds()),
	})
}

func (a *App) secureCookies(r *http.Request) bool {
	return r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https"
}

// currentSession validates the cookie and re-checks that the user still exists,
// so deleting a user or turning off OIDC ends their sessions. Logout adds the
// session id to the revoked list in the config (kept until the cookie expires).
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
	if s.ID == "" {
		return nil, false // issued before sessions were revocable
	}
	cfg := a.store.Get()
	for _, rv := range cfg.Revoked {
		if rv.ID == s.ID {
			return nil, false
		}
	}
	switch s.Method {
	case "password":
		for _, u := range cfg.Users {
			if u.Username == s.User {
				return &s, u.SessionGen == s.Gen
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

// --- login rate limiting ---
//
// Failed logins are counted per username+IP, with a lockout that grows with
// each further failure, so someone guessing the admin password from one
// address cannot lock the admin out from another. A looser per-IP cap stops one
// address from trying many usernames. Successful logins reset their own counter.
//
// check() reserves the attempt as a failure under the same lock, so parallel
// requests cannot slip past the limit while a slow password check runs. A
// successful attempt calls release() to take its reservation back.

const (
	loginFreeTries   = 5                // failures per username+IP before lockouts start
	loginBaseLockout = 30 * time.Second // doubles with every further failure
	loginMaxLockout  = 15 * time.Minute
	loginIPWindow    = 10 * time.Minute
	loginIPMax       = 30 // failures per IP per window, any username
)

type failState struct {
	n     int
	until time.Time
	last  time.Time
}

type limiter struct {
	mu    sync.Mutex
	now   func() time.Time // tests replace this
	pairs map[string]*failState
	ips   map[string][]time.Time
}

func (l *limiter) clock() time.Time {
	if l.now != nil {
		return l.now()
	}
	return time.Now()
}

func pairKey(ip, user string) string { return ip + "\x00" + user }

// check reports whether this attempt may go ahead and, if not, how long to wait.
// An allowed attempt is counted as a failure right away; call release if it succeeds.
func (l *limiter) check(ip, user string) (bool, time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.clock()
	if l.pairs == nil {
		l.pairs, l.ips = map[string]*failState{}, map[string][]time.Time{}
	}
	if len(l.pairs) > 10000 || len(l.ips) > 10000 { // forget stale entries
		for k, f := range l.pairs {
			if now.Sub(f.last) > time.Hour {
				delete(l.pairs, k)
			}
		}
		for k := range l.ips {
			l.recent(k, now)
		}
	}
	k := pairKey(ip, user)
	f := l.pairs[k]
	if f != nil && now.Before(f.until) {
		return false, f.until.Sub(now)
	}
	h := l.recent(ip, now)
	if len(h) >= loginIPMax {
		return false, h[0].Add(loginIPWindow).Sub(now)
	}
	if f == nil || now.Sub(f.last) > time.Hour {
		f = &failState{}
		l.pairs[k] = f
	}
	f.n++
	f.last = now
	if f.n > loginFreeTries {
		d := loginBaseLockout
		for i := loginFreeTries + 1; i < f.n && d < loginMaxLockout; i++ {
			d *= 2
		}
		if d > loginMaxLockout {
			d = loginMaxLockout
		}
		f.until = now.Add(d)
	}
	l.ips[ip] = append(h, now)
	return true, 0
}

func (l *limiter) recent(ip string, now time.Time) []time.Time {
	cut := now.Add(-loginIPWindow)
	h := l.ips[ip][:0]
	for _, t := range l.ips[ip] {
		if t.After(cut) {
			h = append(h, t)
		}
	}
	if len(h) == 0 {
		delete(l.ips, ip)
	} else {
		l.ips[ip] = h
	}
	return h
}

// release undoes the reservation made by check for an attempt that succeeded.
func (l *limiter) release(ip, user string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.pairs, pairKey(ip, user))
	if h := l.ips[ip]; len(h) > 1 {
		l.ips[ip] = h[:len(h)-1]
	} else {
		delete(l.ips, ip)
	}
}

func tooMany(w http.ResponseWriter, wait time.Duration) {
	secs := int(wait.Seconds()) + 1
	w.Header().Set("Retry-After", strconv.Itoa(secs))
	msg := "Too many attempts. Try again in a few minutes."
	if secs <= 90 {
		msg = "Too many attempts. Try again in a minute."
	}
	jsonError(w, http.StatusTooManyRequests, msg)
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
	var req struct{ Username, Password string }
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
		jsonError(w, http.StatusBadRequest, "bad request")
		return
	}
	ip := clientIP(r)
	if ok, wait := a.loginLimit.check(ip, req.Username); !ok {
		tooMany(w, wait)
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
	a.loginLimit.release(ip, req.Username)
	a.setSession(w, r, req.Username, "password")
	writeJSON(w, map[string]string{"user": req.Username})
}

func (a *App) handleLogout(w http.ResponseWriter, r *http.Request) {
	if s, ok := a.currentSession(r); ok {
		now := time.Now().Unix()
		_ = a.store.Update(func(c *Config) error {
			keep := c.Revoked[:0:0]
			for _, rv := range c.Revoked {
				if rv.Expires > now {
					keep = append(keep, rv)
				}
			}
			c.Revoked = append(keep, RevokedSession{ID: s.ID, Expires: s.Expires})
			return nil
		})
	}
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
	ip := clientIP(r)
	if ok, wait := a.loginLimit.check(ip, "\x00setup"); !ok {
		tooMany(w, wait)
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
	a.loginLimit.release(ip, "\x00setup")
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

// handleUserPut changes the password of an existing user.
func (a *App) handleUserPut(w http.ResponseWriter, r *http.Request) {
	a.saveUser(w, r, r.PathValue("name"), false)
}

// handleUserCreate adds a user and refuses a name that is already taken.
func (a *App) handleUserCreate(w http.ResponseWriter, r *http.Request) {
	a.saveUser(w, r, "", true)
}

func (a *App) saveUser(w http.ResponseWriter, r *http.Request, name string, create bool) {
	var req struct{ Username, Password string }
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
		jsonError(w, http.StatusBadRequest, "bad request")
		return
	}
	if create {
		name = req.Username
	}
	if err := validateCredentials(name, req.Password); err != nil {
		jsonError(w, http.StatusBadRequest, err.Error())
		return
	}
	hash, _ := bcrypt.GenerateFromPassword([]byte(req.Password), bcrypt.DefaultCost)
	cur, signedIn := a.currentSession(r)
	code := 0
	err := a.store.Update(func(c *Config) error {
		for i := range c.Users {
			if c.Users[i].Username == name {
				if create {
					code = http.StatusConflict
					return errors.New("A user with that name already exists. Use Change password on their row instead.")
				}
				c.Users[i].PasswordHash = string(hash)
				c.Users[i].SessionGen = nextGen(c.Users[i].SessionGen) // ends their other sessions
				return nil
			}
		}
		if !create {
			code = http.StatusNotFound
			return errors.New("No such user.")
		}
		c.Users = append(c.Users, User{Username: name, PasswordHash: string(hash), SessionGen: nextGen(0)})
		return nil
	})
	if err != nil {
		if code == 0 {
			code = http.StatusInternalServerError
		}
		jsonError(w, code, err.Error())
		return
	}
	// Changing your own password keeps this browser signed in; every other session ends.
	if signedIn && !create && cur.Method == "password" && cur.User == name {
		a.setSession(w, r, name, "password")
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *App) handleUserDelete(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if s, ok := a.currentSession(r); ok && s.Method == "password" && s.User == name {
		jsonError(w, http.StatusBadRequest, "You can't remove your own account. Ask another user to do it.")
		return
	}
	code := http.StatusBadRequest
	err := a.store.Update(func(c *Config) error {
		out := c.Users[:0:0]
		for _, u := range c.Users {
			if u.Username != name {
				out = append(out, u)
			}
		}
		if len(out) == len(c.Users) {
			code = http.StatusNotFound
			return errors.New("No such user.")
		}
		if len(out) == 0 && c.OIDC == nil {
			return errors.New("You can't remove the last user while SSO is off.")
		}
		c.Users = out
		if _, ok := c.UIPrefs[name]; ok {
			m := make(map[string]UIPrefs, len(c.UIPrefs))
			for k, v := range c.UIPrefs {
				if k != name {
					m[k] = v
				}
			}
			c.UIPrefs = m
		}
		return nil
	})
	if err != nil {
		jsonError(w, code, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// nextGen returns a session generation newer than prev (a timestamp, so a
// re-created user never matches cookies of a deleted one).
func nextGen(prev int64) int64 {
	g := time.Now().UnixNano()
	if g <= prev {
		g = prev + 1
	}
	return g
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
