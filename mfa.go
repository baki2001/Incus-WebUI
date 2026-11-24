package main

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base32"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"golang.org/x/crypto/bcrypt"
	"rsc.io/qr"
)

// Two-factor sign-in for local users: a time-based code from an authenticator
// app (RFC 6238: SHA-1, 6 digits, 30 seconds), with one-time recovery codes
// for when the phone is gone. Passkeys are in passkey.go.

const (
	totpPeriod   = 30
	totpDigits   = 6
	totpSkew     = 1 // steps accepted either side of now, for clock drift
	recoveryN    = 10
	totpIssuer   = "Incus"
	secretLength = 20
)

var b32 = base32.StdEncoding.WithPadding(base32.NoPadding)

func newTOTPSecret() string {
	b := make([]byte, secretLength)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return b32.EncodeToString(b)
}

func decodeSecret(s string) ([]byte, error) {
	return b32.DecodeString(strings.ToUpper(strings.TrimRight(strings.ReplaceAll(s, " ", ""), "=")))
}

func totpAt(key []byte, step int64) string {
	var msg [8]byte
	binary.BigEndian.PutUint64(msg[:], uint64(step))
	m := hmac.New(sha1.New, key)
	m.Write(msg[:])
	sum := m.Sum(nil)
	off := sum[len(sum)-1] & 0x0f
	v := binary.BigEndian.Uint32(sum[off:off+4]) & 0x7fffffff
	return fmt.Sprintf("%0*d", totpDigits, v%1000000)
}

// totpMatch returns the time step the code is valid for, or 0. Steps at or
// before last are refused, so a code that was used once can't be used again.
func totpMatch(secret, code string, now time.Time, last int64) int64 {
	key, err := decodeSecret(secret)
	if err != nil || len(code) != totpDigits {
		return 0
	}
	cur := now.Unix() / totpPeriod
	for d := int64(-totpSkew); d <= totpSkew; d++ {
		st := cur + d
		if st > last && subtle.ConstantTimeCompare([]byte(totpAt(key, st)), []byte(code)) == 1 {
			return st
		}
	}
	return 0
}

func normCode(c string) string {
	c = strings.ToLower(strings.TrimSpace(c))
	return strings.NewReplacer(" ", "", "-", "").Replace(c)
}

func hashRecovery(code string) string {
	h := sha256.Sum256([]byte(normCode(code)))
	return hex.EncodeToString(h[:])
}

// newRecoveryCodes returns codes to show once, and their hashes to keep.
func newRecoveryCodes() (show, keep []string) {
	const alpha = "abcdefghjkmnpqrstuvwxyz23456789" // no look-alikes
	for range recoveryN {
		b := make([]byte, 10)
		if _, err := rand.Read(b); err != nil {
			panic(err)
		}
		for i := range b {
			b[i] = alpha[int(b[i])%len(alpha)]
		}
		c := string(b[:5]) + "-" + string(b[5:])
		show = append(show, c)
		keep = append(keep, hashRecovery(c))
	}
	return
}

var errBadCode = errors.New("That code is not right. Try the newest one from your app.")

// useSecondFactor checks a code from the authenticator app, or a recovery
// code, for a user and records its use, all under the store lock so the same
// code can't sign in twice.
func (a *App) useSecondFactor(user, code string) (recovery bool, err error) {
	code = normCode(code)
	err = a.store.Update(func(c *Config) error {
		for i := range c.Users {
			u := &c.Users[i]
			if u.Username != user {
				continue
			}
			if u.TOTPSecret == "" {
				return errBadCode
			}
			if st := totpMatch(u.TOTPSecret, code, time.Now(), u.TOTPLast); st != 0 {
				u.TOTPLast = st
				return nil
			}
			if len(code) == 10 {
				h := hashRecovery(code)
				for j, k := range u.RecoveryCodes {
					if subtle.ConstantTimeCompare([]byte(k), []byte(h)) == 1 {
						left := make([]string, 0, len(u.RecoveryCodes)-1)
						left = append(append(left, u.RecoveryCodes[:j]...), u.RecoveryCodes[j+1:]...)
						u.RecoveryCodes = left
						recovery = true
						return nil
					}
				}
			}
			return errBadCode
		}
		return errBadCode
	})
	return recovery, err
}

// --- account endpoints: each local user manages their own sign-in ---

// localUser returns the signed-in local user, or answers the request itself.
func (a *App) localUser(w http.ResponseWriter, r *http.Request) (User, bool) {
	s, ok := a.currentSession(r)
	if !ok {
		jsonError(w, http.StatusUnauthorized, "not signed in")
		return User{}, false
	}
	if s.Method != "password" {
		jsonError(w, http.StatusBadRequest, "Single sign-on accounts set up two-factor sign-in with their sign-in provider.")
		return User{}, false
	}
	for _, u := range a.store.Get().Users {
		if u.Username == s.User {
			return u, true
		}
	}
	jsonError(w, http.StatusUnauthorized, "not signed in")
	return User{}, false
}

// updateUser runs fn on the named user's record inside a config update.
func (a *App) updateUser(name string, fn func(u *User) error) error {
	return a.store.Update(func(c *Config) error {
		for i := range c.Users {
			if c.Users[i].Username == name {
				return fn(&c.Users[i])
			}
		}
		return errors.New("No such user.")
	})
}

// checkPassword confirms the user's password before a change that weakens
// their sign-in. It shares the login rate limit.
func (a *App) checkPassword(w http.ResponseWriter, r *http.Request, u User, pass string) bool {
	ip := a.clientIP(r)
	if ok, wait := a.loginLimit.check(ip, u.Username); !ok {
		tooMany(w, wait)
		return false
	}
	if bcrypt.CompareHashAndPassword([]byte(u.PasswordHash), []byte(pass)) != nil {
		jsonError(w, http.StatusForbidden, "That password is not right.")
		return false
	}
	a.loginLimit.release(ip, u.Username)
	return true
}

type passkeyInfo struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Created  int64  `json:"created"`
	LastUsed int64  `json:"last_used,omitempty"`
}

func (a *App) handleSecurityGet(w http.ResponseWriter, r *http.Request) {
	u, ok := a.localUser(w, r)
	if !ok {
		return
	}
	keys := []passkeyInfo{}
	for _, p := range u.Passkeys {
		keys = append(keys, passkeyInfo{ID: p.ID, Name: p.Name, Created: p.Created, LastUsed: p.LastUsed})
	}
	writeJSON(w, map[string]any{"totp": u.TOTPSecret != "", "recovery_left": len(u.RecoveryCodes), "passkeys": keys})
}

// handleTOTPSetup makes a new secret for the user to scan. Nothing is saved
// until they prove their app has it (handleTOTPEnable).
func (a *App) handleTOTPSetup(w http.ResponseWriter, r *http.Request) {
	u, ok := a.localUser(w, r)
	if !ok {
		return
	}
	secret := newTOTPSecret()
	label := totpIssuer + ":" + u.Username
	q := url.Values{"secret": {secret}, "issuer": {totpIssuer}, "algorithm": {"SHA1"}, "digits": {"6"}, "period": {"30"}}
	uri := "otpauth://totp/" + url.PathEscape(label) + "?" + q.Encode()
	resp := map[string]string{"secret": secret, "uri": uri}
	if code, err := qr.Encode(uri, qr.M); err == nil {
		code.Scale = 5
		resp["qr"] = "data:image/png;base64," + base64.StdEncoding.EncodeToString(code.PNG())
	}
	writeJSON(w, resp)
}

func (a *App) handleTOTPEnable(w http.ResponseWriter, r *http.Request) {
	u, ok := a.localUser(w, r)
	if !ok {
		return
	}
	var req struct{ Secret, Code string }
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
		jsonError(w, http.StatusBadRequest, "bad request")
		return
	}
	if k, err := decodeSecret(req.Secret); err != nil || len(k) != secretLength {
		jsonError(w, http.StatusBadRequest, "bad secret")
		return
	}
	st := totpMatch(req.Secret, normCode(req.Code), time.Now(), 0)
	if st == 0 {
		jsonError(w, http.StatusBadRequest, "That code doesn't match. Check that your phone's clock is right and try the newest code.")
		return
	}
	show, keep := newRecoveryCodes()
	err := a.updateUser(u.Username, func(x *User) error {
		if x.TOTPSecret != "" {
			return errors.New("Two-factor sign-in is already on.")
		}
		x.TOTPSecret, x.TOTPLast, x.RecoveryCodes = strings.ToUpper(req.Secret), st, keep
		return nil
	})
	if err != nil {
		jsonError(w, http.StatusConflict, err.Error())
		return
	}
	writeJSON(w, map[string]any{"recovery_codes": show})
}

func (a *App) handleTOTPDisable(w http.ResponseWriter, r *http.Request) {
	u, ok := a.localUser(w, r)
	if !ok {
		return
	}
	var req struct{ Password string }
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
		jsonError(w, http.StatusBadRequest, "bad request")
		return
	}
	if !a.checkPassword(w, r, u, req.Password) {
		return
	}
	err := a.updateUser(u.Username, func(x *User) error {
		x.TOTPSecret, x.TOTPLast, x.RecoveryCodes = "", 0, nil
		return nil
	})
	if err != nil {
		jsonError(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *App) handleRecoveryRenew(w http.ResponseWriter, r *http.Request) {
	u, ok := a.localUser(w, r)
	if !ok {
		return
	}
	var req struct{ Password string }
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
		jsonError(w, http.StatusBadRequest, "bad request")
		return
	}
	if u.TOTPSecret == "" {
		jsonError(w, http.StatusBadRequest, "Turn on two-factor sign-in first.")
		return
	}
	if !a.checkPassword(w, r, u, req.Password) {
		return
	}
	show, keep := newRecoveryCodes()
	if err := a.updateUser(u.Username, func(x *User) error { x.RecoveryCodes = keep; return nil }); err != nil {
		jsonError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, map[string]any{"recovery_codes": show})
}

// handleUserResetSignIn lets an admin help someone who lost their phone or
// passkey: two-factor sign-in and all passkeys are removed, and the user's
// sessions end. Their password stays.
func (a *App) handleUserResetSignIn(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if s, ok := a.currentSession(r); ok && s.Method == "password" && s.User == name {
		jsonError(w, http.StatusBadRequest, "Change your own sign-in under Settings, Sign-in security.")
		return
	}
	err := a.updateUser(name, func(x *User) error {
		x.TOTPSecret, x.TOTPLast, x.RecoveryCodes, x.Passkeys = "", 0, nil, nil
		x.SessionGen = nextGen(x.SessionGen)
		return nil
	})
	if err != nil {
		jsonError(w, http.StatusNotFound, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
