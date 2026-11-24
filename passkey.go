package main

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"
)

// Passkeys (WebAuthn) for local users. A passkey signs in on its own: it is
// already two factors (the device, and its PIN or fingerprint), so the
// password and authenticator code are not asked for.
//
// The browser only allows passkeys on HTTPS (or localhost) with a domain name,
// not an IP address. The relying party is public_url when it is set, else the
// host the browser used.

const (
	waCookie     = "iwui_wa"
	waTTL        = 5 * time.Minute
	maxPasskeys  = 20
	maxWAPending = 2000
)

// waPending holds ceremonies between their begin and finish requests. Each is
// used once; the browser holds its id in a short-lived cookie.
type waPending struct {
	mu sync.Mutex
	m  map[string]waCeremony
}

type waCeremony struct {
	user    string // registration: who started it
	login   bool
	session webauthn.SessionData
	expires time.Time
}

func (p *waPending) put(c waCeremony) (string, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.m == nil {
		p.m = map[string]waCeremony{}
	}
	now := time.Now()
	for k, v := range p.m {
		if now.After(v.expires) {
			delete(p.m, k)
		}
	}
	if len(p.m) >= maxWAPending {
		return "", errors.New("Too many sign-ins in progress. Try again in a few minutes.")
	}
	id := randHex(16)
	c.expires = now.Add(waTTL)
	p.m[id] = c
	return id, nil
}

func (p *waPending) take(id string) (waCeremony, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	c, ok := p.m[id]
	delete(p.m, id)
	if !ok || time.Now().After(c.expires) {
		return waCeremony{}, false
	}
	return c, true
}

func (a *App) startCeremony(w http.ResponseWriter, r *http.Request, c waCeremony) bool {
	id, err := a.wa.put(c)
	if err != nil {
		jsonError(w, http.StatusServiceUnavailable, err.Error())
		return false
	}
	http.SetCookie(w, &http.Cookie{Name: waCookie, Value: id, Path: "/api/ui/", HttpOnly: true, Secure: a.secureCookies(r), SameSite: http.SameSiteStrictMode, MaxAge: int(waTTL.Seconds())})
	return true
}

func (a *App) endCeremony(w http.ResponseWriter, r *http.Request) (waCeremony, bool) {
	http.SetCookie(w, &http.Cookie{Name: waCookie, Value: "", Path: "/api/ui/", MaxAge: -1, HttpOnly: true})
	ck, err := r.Cookie(waCookie)
	if err != nil {
		return waCeremony{}, false
	}
	return a.wa.take(ck.Value)
}

// rpFor returns the origin and relying party id passkeys are bound to.
func (a *App) rpFor(r *http.Request) (origin, rpid string) {
	if pu := a.store.Get().PublicURL; pu != "" {
		if u, err := url.Parse(pu); err == nil && u.Host != "" && (u.Scheme == "https" || u.Scheme == "http") {
			return u.Scheme + "://" + u.Host, u.Hostname()
		}
	}
	host := r.Host
	if xf := r.Header.Get("X-Forwarded-Host"); xf != "" {
		host = strings.TrimSpace(strings.Split(xf, ",")[0])
	}
	scheme := "http"
	if a.secureCookies(r) {
		scheme = "https"
	}
	name := host
	if h, _, err := net.SplitHostPort(host); err == nil {
		name = h
	}
	return scheme + "://" + host, strings.Trim(name, "[]")
}

func (a *App) webAuthn(r *http.Request) (*webauthn.WebAuthn, error) {
	origin, rpid := a.rpFor(r)
	if net.ParseIP(rpid) != nil {
		return nil, errors.New("Passkeys need the UI to be opened by a domain name, not an IP address.")
	}
	return webauthn.New(&webauthn.Config{RPID: rpid, RPDisplayName: "Incus", RPOrigins: []string{origin}})
}

// waUser adapts a local user to the webauthn library.
type waUser struct {
	u     User
	creds []webauthn.Credential
}

func newWAUser(u User) (*waUser, error) {
	x := &waUser{u: u}
	for _, p := range u.Passkeys {
		var c webauthn.Credential
		if err := json.Unmarshal([]byte(p.Credential), &c); err != nil {
			return nil, err
		}
		x.creds = append(x.creds, c)
	}
	return x, nil
}

func (x *waUser) WebAuthnID() []byte {
	b, _ := base64.RawURLEncoding.DecodeString(x.u.WebAuthnID)
	return b
}
func (x *waUser) WebAuthnName() string                       { return x.u.Username }
func (x *waUser) WebAuthnDisplayName() string                { return x.u.Username }
func (x *waUser) WebAuthnCredentials() []webauthn.Credential { return x.creds }

// handlePasskeyRegisterBegin starts adding a passkey to the signed-in user.
func (a *App) handlePasskeyRegisterBegin(w http.ResponseWriter, r *http.Request) {
	u, ok := a.localUser(w, r)
	if !ok {
		return
	}
	if len(u.Passkeys) >= maxPasskeys {
		jsonError(w, http.StatusBadRequest, "You have the most passkeys allowed. Remove one first.")
		return
	}
	wa, err := a.webAuthn(r)
	if err != nil {
		jsonError(w, http.StatusBadRequest, err.Error())
		return
	}
	if u.WebAuthnID == "" {
		b := make([]byte, 32)
		_, _ = rand.Read(b)
		id := base64.RawURLEncoding.EncodeToString(b)
		err := a.updateUser(u.Username, func(x *User) error {
			if x.WebAuthnID == "" {
				x.WebAuthnID = id
			}
			id = x.WebAuthnID
			return nil
		})
		if err != nil {
			jsonError(w, http.StatusInternalServerError, err.Error())
			return
		}
		u.WebAuthnID = id
	}
	wu, err := newWAUser(u)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, err.Error())
		return
	}
	var exclude []protocol.CredentialDescriptor
	for _, c := range wu.creds {
		exclude = append(exclude, c.Descriptor())
	}
	req := true
	opts, sess, err := wa.BeginRegistration(wu,
		webauthn.WithAuthenticatorSelection(protocol.AuthenticatorSelection{
			RequireResidentKey: &req,
			ResidentKey:        protocol.ResidentKeyRequirementRequired,
			UserVerification:   protocol.VerificationRequired,
		}),
		webauthn.WithExclusions(exclude),
	)
	if err != nil {
		jsonError(w, http.StatusBadRequest, err.Error())
		return
	}
	if !a.startCeremony(w, r, waCeremony{user: u.Username, session: *sess}) {
		return
	}
	writeJSON(w, opts)
}

func (a *App) handlePasskeyRegisterFinish(w http.ResponseWriter, r *http.Request) {
	u, ok := a.localUser(w, r)
	if !ok {
		return
	}
	var req struct {
		Name       string          `json:"name"`
		Credential json.RawMessage `json:"credential"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&req); err != nil {
		jsonError(w, http.StatusBadRequest, "bad request")
		return
	}
	cer, ok := a.endCeremony(w, r)
	if !ok || cer.login || cer.user != u.Username {
		jsonError(w, http.StatusBadRequest, "That took too long. Try again.")
		return
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		name = "Passkey"
	}
	if len([]rune(name)) > 64 {
		name = string([]rune(name)[:64])
	}
	wa, err := a.webAuthn(r)
	if err != nil {
		jsonError(w, http.StatusBadRequest, err.Error())
		return
	}
	parsed, err := protocol.ParseCredentialCreationResponseBody(bytes.NewReader(req.Credential))
	if err != nil {
		jsonError(w, http.StatusBadRequest, "The passkey answer could not be read.")
		return
	}
	wu, err := newWAUser(u)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, err.Error())
		return
	}
	cred, err := wa.CreateCredential(wu, cer.session, parsed)
	if err != nil {
		jsonError(w, http.StatusBadRequest, "The passkey could not be checked: "+protocolMsg(err))
		return
	}
	raw, _ := json.Marshal(cred)
	pk := Passkey{ID: base64.RawURLEncoding.EncodeToString(cred.ID), Name: name, Created: time.Now().Unix(), Credential: string(raw)}
	err = a.updateUser(u.Username, func(x *User) error {
		for _, p := range x.Passkeys {
			if p.ID == pk.ID {
				return errors.New("This passkey is already added.")
			}
		}
		if len(x.Passkeys) >= maxPasskeys {
			return errors.New("You have the most passkeys allowed. Remove one first.")
		}
		x.Passkeys = append(append([]Passkey(nil), x.Passkeys...), pk)
		return nil
	})
	if err != nil {
		jsonError(w, http.StatusConflict, err.Error())
		return
	}
	writeJSON(w, passkeyInfo{ID: pk.ID, Name: pk.Name, Created: pk.Created})
}

func (a *App) handlePasskeyDelete(w http.ResponseWriter, r *http.Request) {
	u, ok := a.localUser(w, r)
	if !ok {
		return
	}
	id := r.PathValue("id")
	err := a.updateUser(u.Username, func(x *User) error {
		keep := make([]Passkey, 0, len(x.Passkeys))
		for _, p := range x.Passkeys {
			if p.ID != id {
				keep = append(keep, p)
			}
		}
		if len(keep) == len(x.Passkeys) {
			return errors.New("No such passkey.")
		}
		x.Passkeys = keep
		return nil
	})
	if err != nil {
		jsonError(w, http.StatusNotFound, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *App) handlePasskeyRename(w http.ResponseWriter, r *http.Request) {
	u, ok := a.localUser(w, r)
	if !ok {
		return
	}
	var req struct{ Name string }
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
		jsonError(w, http.StatusBadRequest, "bad request")
		return
	}
	name := strings.TrimSpace(req.Name)
	if name == "" || len([]rune(name)) > 64 {
		jsonError(w, http.StatusBadRequest, "Give the passkey a name of up to 64 characters.")
		return
	}
	id := r.PathValue("id")
	err := a.updateUser(u.Username, func(x *User) error {
		next := append([]Passkey(nil), x.Passkeys...)
		for i := range next {
			if next[i].ID == id {
				next[i].Name = name
				x.Passkeys = next
				return nil
			}
		}
		return errors.New("No such passkey.")
	})
	if err != nil {
		jsonError(w, http.StatusNotFound, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// --- signing in with a passkey ---

const passkeyLimitKey = "\x00passkey"

func (a *App) handlePasskeyLoginBegin(w http.ResponseWriter, r *http.Request) {
	if !sameOriginOK(r) {
		jsonError(w, http.StatusForbidden, "bad request origin")
		return
	}
	wa, err := a.webAuthn(r)
	if err != nil {
		jsonError(w, http.StatusBadRequest, err.Error())
		return
	}
	opts, sess, err := wa.BeginDiscoverableLogin(webauthn.WithUserVerification(protocol.VerificationRequired))
	if err != nil {
		jsonError(w, http.StatusBadRequest, err.Error())
		return
	}
	if !a.startCeremony(w, r, waCeremony{login: true, session: *sess}) {
		return
	}
	writeJSON(w, opts)
}

func (a *App) handlePasskeyLoginFinish(w http.ResponseWriter, r *http.Request) {
	if !sameOriginOK(r) {
		jsonError(w, http.StatusForbidden, "bad request origin")
		return
	}
	ip := a.clientIP(r)
	if ok, wait := a.loginLimit.check(ip, passkeyLimitKey); !ok {
		tooMany(w, wait)
		return
	}
	cer, ok := a.endCeremony(w, r)
	if !ok || !cer.login {
		jsonError(w, http.StatusBadRequest, "That took too long. Try again.")
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 64<<10))
	if err != nil {
		jsonError(w, http.StatusBadRequest, "bad request")
		return
	}
	parsed, err := protocol.ParseCredentialRequestResponseBytes(body)
	if err != nil {
		jsonError(w, http.StatusBadRequest, "The passkey answer could not be read.")
		return
	}
	wa, err := a.webAuthn(r)
	if err != nil {
		jsonError(w, http.StatusBadRequest, err.Error())
		return
	}
	var found *waUser
	handler := func(rawID, userHandle []byte) (webauthn.User, error) {
		h := base64.RawURLEncoding.EncodeToString(userHandle)
		for _, u := range a.store.Get().Users {
			if u.WebAuthnID != "" && u.WebAuthnID == h {
				x, err := newWAUser(u)
				if err != nil {
					return nil, err
				}
				found = x
				return x, nil
			}
		}
		return nil, errors.New("unknown passkey")
	}
	_, cred, err := wa.ValidatePasskeyLogin(handler, cer.session, parsed)
	if err != nil || found == nil {
		name := ""
		if found != nil {
			name = found.u.Username
		}
		a.auditLogin(r, name, "passkey", false)
		jsonError(w, http.StatusUnauthorized, "This passkey isn't registered for any user here.")
		return
	}
	if cred.Authenticator.CloneWarning {
		a.auditLogin(r, found.u.Username, "passkey", false)
		jsonError(w, http.StatusUnauthorized, "This passkey looks copied, so it was refused. Sign in with your password and remove it.")
		return
	}
	user := found.u.Username
	id := base64.RawURLEncoding.EncodeToString(cred.ID)
	raw, _ := json.Marshal(cred)
	err = a.updateUser(user, func(x *User) error {
		next := append([]Passkey(nil), x.Passkeys...)
		for i := range next {
			if next[i].ID == id {
				next[i].Credential, next[i].LastUsed = string(raw), time.Now().Unix()
				x.Passkeys = next
				return nil
			}
		}
		return errors.New("This passkey was just removed.")
	})
	if err != nil {
		a.auditLogin(r, user, "passkey", false)
		jsonError(w, http.StatusUnauthorized, err.Error())
		return
	}
	a.loginLimit.release(ip, passkeyLimitKey)
	a.auditLogin(r, user, "passkey", true)
	a.setSession(w, r, user, "password")
	writeJSON(w, map[string]string{"user": user})
}

// protocolMsg gives the detail of a webauthn error, which says more than its message.
func protocolMsg(err error) string {
	var pe *protocol.Error
	if errors.As(err, &pe) && pe.Details != "" {
		return pe.Details
	}
	return err.Error()
}
