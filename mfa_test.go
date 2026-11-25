package main

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base32"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/fxamacker/cbor/v2"
)

func TestTOTPVector(t *testing.T) {
	// RFC 6238 appendix B, SHA-1, cut to 6 digits.
	key := []byte("12345678901234567890")
	for step, want := range map[int64]string{59 / 30: "287082", 1111111109 / 30: "081804", 2000000000 / 30: "279037"} {
		if got := totpAt(key, step); got != want {
			t.Errorf("step %d: got %s want %s", step, got, want)
		}
	}
	secret := base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(key)
	now := time.Unix(59, 0)
	if totpMatch(secret, "287082", now, 0) == 0 {
		t.Fatal("current code refused")
	}
	if totpMatch(secret, "287082", now, 1) != 0 {
		t.Fatal("a used step was accepted again")
	}
	if totpMatch(secret, "000000", now, 0) != 0 {
		t.Fatal("wrong code accepted")
	}
}

func req(a *App, method, path, body string, cookies ...*http.Cookie) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, bytes.NewBufferString(body))
	r.Host = "ui.example.com"
	r.RemoteAddr = "10.0.0.9:1234"
	r.Header.Set("X-Incus-UI", "1")
	r.Header.Set("X-Forwarded-Proto", "https")
	for _, c := range cookies {
		if c != nil {
			r.AddCookie(c)
		}
	}
	w := httptest.NewRecorder()
	a.routes().ServeHTTP(w, r)
	return w
}

func cookieOf(w *httptest.ResponseRecorder, name string) *http.Cookie {
	for _, c := range w.Result().Cookies() {
		if c.Name == name && c.MaxAge >= 0 {
			return c
		}
	}
	return nil
}

func TestLoginWithTOTP(t *testing.T) {
	a := testApp(t, "admin")
	login := func(code string) *httptest.ResponseRecorder {
		return req(a, "POST", "/api/ui/login", `{"username":"admin","password":"correct-password","code":"`+code+`"}`)
	}
	c := cookieOf(login(""), sessionCookie)
	if c == nil {
		t.Fatal("no session")
	}

	// Turn it on.
	var setup struct{ Secret, QR string }
	w := req(a, "POST", "/api/ui/account/totp/setup", ``, c)
	_ = json.Unmarshal(w.Body.Bytes(), &setup)
	if setup.Secret == "" || !strings.HasPrefix(setup.QR, "data:image/png;base64,") {
		t.Fatalf("setup: %d %s", w.Code, w.Body)
	}
	key, _ := decodeSecret(setup.Secret)
	now := time.Now().Unix() / totpPeriod
	if w := req(a, "POST", "/api/ui/account/totp", `{"secret":"`+setup.Secret+`","code":"000000"}`, c); w.Code != 400 {
		t.Fatalf("wrong code enabled 2FA: %d", w.Code)
	}
	w = req(a, "POST", "/api/ui/account/totp", `{"secret":"`+setup.Secret+`","code":"`+totpAt(key, now)+`"}`, c)
	var rc struct {
		Codes []string `json:"recovery_codes"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &rc)
	if w.Code != 200 || len(rc.Codes) != recoveryN {
		t.Fatalf("enable: %d %s", w.Code, w.Body)
	}

	// The password alone now asks for a code and gives no session.
	w = login("")
	if cookieOf(w, sessionCookie) != nil || !strings.Contains(w.Body.String(), "totp_required") {
		t.Fatalf("password alone: %d %s", w.Code, w.Body)
	}
	if w := login("123456"); w.Code != 401 || cookieOf(w, sessionCookie) != nil {
		t.Fatalf("wrong code: %d", w.Code)
	}
	// The code used to turn it on can't be used again; the next one works once.
	if w := login(totpAt(key, now)); w.Code != 401 {
		t.Fatalf("reused code: %d", w.Code)
	}
	next := totpAt(key, now+1)
	if w := login(next); w.Code != 200 || cookieOf(w, sessionCookie) == nil {
		t.Fatalf("good code: %d %s", w.Code, w.Body)
	}
	if w := login(next); w.Code != 401 {
		t.Fatalf("replayed code: %d", w.Code)
	}

	// A recovery code works once, in any case and with or without the dash.
	rec := strings.ToUpper(strings.ReplaceAll(rc.Codes[0], "-", ""))
	if w := login(rec); w.Code != 200 {
		t.Fatalf("recovery code: %d %s", w.Code, w.Body)
	}
	if w := login(rc.Codes[0]); w.Code != 401 {
		t.Fatalf("recovery code used twice: %d", w.Code)
	}

	// Turning it off needs the password.
	if w := req(a, "POST", "/api/ui/account/totp/disable", `{"password":"nope"}`, c); w.Code != 403 {
		t.Fatalf("disable with wrong password: %d", w.Code)
	}
	if w := req(a, "POST", "/api/ui/account/totp/disable", `{"password":"correct-password"}`, c); w.Code != 204 {
		t.Fatalf("disable: %d %s", w.Code, w.Body)
	}
	if w := login(""); cookieOf(w, sessionCookie) == nil {
		t.Fatal("password alone should work again")
	}
}

func TestAdminResetSignIn(t *testing.T) {
	a := testApp(t, "admin", "bob")
	_ = a.store.Update(func(c *Config) error {
		c.Access = []Access{{Who: "user:admin", Server: "*", Project: "*", Role: "admin"}}
		c.Users[1].TOTPSecret = newTOTPSecret()
		c.Users[1].Passkeys = []Passkey{{ID: "x", Name: "k"}}
		return nil
	})
	c := cookieOf(req(a, "POST", "/api/ui/login", `{"username":"admin","password":"correct-password"}`), sessionCookie)
	if w := req(a, "POST", "/api/ui/users/admin/reset-sign-in", ``, c); w.Code != 400 {
		t.Fatalf("reset self: %d", w.Code)
	}
	if w := req(a, "POST", "/api/ui/users/bob/reset-sign-in", ``, c); w.Code != 204 {
		t.Fatalf("reset: %d %s", w.Code, w.Body)
	}
	u := a.store.Get().Users[1]
	if u.TOTPSecret != "" || len(u.Passkeys) != 0 {
		t.Fatal("not reset")
	}
}

// softKey is a minimal software authenticator: ES256, no attestation.
type softKey struct {
	key    *ecdsa.PrivateKey
	id     []byte
	user   []byte
	count  uint32
	origin string
	rpid   string
}

func b64(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

func challengeOf(t *testing.T, body []byte) string {
	var o struct {
		PublicKey struct {
			Challenge string `json:"challenge"`
			User      struct {
				ID string `json:"id"`
			} `json:"user"`
		} `json:"publicKey"`
	}
	if err := json.Unmarshal(body, &o); err != nil || o.PublicKey.Challenge == "" {
		t.Fatalf("options: %s", body)
	}
	return o.PublicKey.Challenge
}

func (k *softKey) clientData(typ, challenge string) []byte {
	b, _ := json.Marshal(map[string]any{"type": typ, "challenge": challenge, "origin": k.origin, "crossOrigin": false})
	return b
}

func (k *softKey) create(t *testing.T, challenge string) string {
	x, y := k.key.PublicKey.X.FillBytes(make([]byte, 32)), k.key.PublicKey.Y.FillBytes(make([]byte, 32))
	cose, _ := cbor.Marshal(map[int]any{1: 2, 3: -7, -1: 1, -2: x, -3: y})
	rp := sha256.Sum256([]byte(k.rpid))
	ad := append([]byte{}, rp[:]...)
	ad = append(ad, 0x45) // UP, UV, AT
	ad = binary.BigEndian.AppendUint32(ad, k.count)
	ad = append(ad, make([]byte, 16)...)
	ad = binary.BigEndian.AppendUint16(ad, uint16(len(k.id)))
	ad = append(append(ad, k.id...), cose...)
	att, _ := cbor.Marshal(map[string]any{"fmt": "none", "attStmt": map[string]any{}, "authData": ad})
	b, _ := json.Marshal(map[string]any{
		"id": b64(k.id), "rawId": b64(k.id), "type": "public-key",
		"response": map[string]any{"clientDataJSON": b64(k.clientData("webauthn.create", challenge)), "attestationObject": b64(att)},
	})
	return string(b)
}

func (k *softKey) get(t *testing.T, challenge string) string {
	k.count++
	rp := sha256.Sum256([]byte(k.rpid))
	ad := append(append([]byte{}, rp[:]...), 0x05)
	ad = binary.BigEndian.AppendUint32(ad, k.count)
	cd := k.clientData("webauthn.get", challenge)
	h := sha256.Sum256(cd)
	sum := sha256.Sum256(append(append([]byte{}, ad...), h[:]...))
	sig, err := ecdsa.SignASN1(rand.Reader, k.key, sum[:])
	if err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(map[string]any{
		"id": b64(k.id), "rawId": b64(k.id), "type": "public-key",
		"response": map[string]any{"clientDataJSON": b64(cd), "authenticatorData": b64(ad), "signature": b64(sig), "userHandle": b64(k.user)},
	})
	return string(b)
}

func TestPasskeyRegisterAndLogin(t *testing.T) {
	a := testApp(t, "admin")
	c := cookieOf(req(a, "POST", "/api/ui/login", `{"username":"admin","password":"correct-password"}`), sessionCookie)

	w := req(a, "POST", "/api/ui/account/passkeys/begin", ``, c)
	if w.Code != 200 {
		t.Fatalf("begin: %d %s", w.Code, w.Body)
	}
	ch := challengeOf(t, w.Body.Bytes())
	wac := cookieOf(w, waCookie)
	pk, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	uh, _ := base64.RawURLEncoding.DecodeString(a.store.Get().Users[0].WebAuthnID)
	k := &softKey{key: pk, id: []byte("cred-1"), user: uh, origin: "https://ui.example.com", rpid: "ui.example.com"}
	body, _ := json.Marshal(map[string]any{"name": "Laptop", "credential": json.RawMessage(k.create(t, ch))})
	if w := req(a, "POST", "/api/ui/account/passkeys/finish", string(body), c, wac); w.Code != 200 {
		t.Fatalf("finish: %d %s", w.Code, w.Body)
	}
	// The ceremony is single use.
	if w := req(a, "POST", "/api/ui/account/passkeys/finish", string(body), c, wac); w.Code != 400 {
		t.Fatalf("finish replay: %d", w.Code)
	}
	if !strings.Contains(req(a, "GET", "/api/ui/auth", ``).Body.String(), `"passkeys":true`) {
		t.Fatal("login page doesn't offer passkeys")
	}

	// Sign in with it, no password.
	w = req(a, "POST", "/api/ui/passkey/login/begin", ``)
	ch, wac = challengeOf(t, w.Body.Bytes()), cookieOf(w, waCookie)
	w = req(a, "POST", "/api/ui/passkey/login/finish", k.get(t, ch), wac)
	if w.Code != 200 || cookieOf(w, sessionCookie) == nil {
		t.Fatalf("passkey login: %d %s", w.Code, w.Body)
	}
	if u := a.store.Get().Users[0]; u.Passkeys[0].LastUsed == 0 {
		t.Fatal("last use not recorded")
	}

	// A signature from another origin is refused.
	w = req(a, "POST", "/api/ui/passkey/login/begin", ``)
	ch, wac = challengeOf(t, w.Body.Bytes()), cookieOf(w, waCookie)
	k.origin = "https://evil.example.net"
	if w := req(a, "POST", "/api/ui/passkey/login/finish", k.get(t, ch), wac); w.Code != 401 {
		t.Fatalf("wrong origin: %d %s", w.Code, w.Body)
	}
	k.origin = "https://ui.example.com"

	// After it's removed it no longer signs in.
	id := a.store.Get().Users[0].Passkeys[0].ID
	if w := req(a, "DELETE", "/api/ui/account/passkeys/"+id, ``, c); w.Code != 204 {
		t.Fatalf("delete: %d", w.Code)
	}
	w = req(a, "POST", "/api/ui/passkey/login/begin", ``)
	ch, wac = challengeOf(t, w.Body.Bytes()), cookieOf(w, waCookie)
	if w := req(a, "POST", "/api/ui/passkey/login/finish", k.get(t, ch), wac); w.Code != 401 {
		t.Fatalf("removed passkey: %d", w.Code)
	}
}

func TestPasskeyNeedsDomain(t *testing.T) {
	a := testApp(t, "admin")
	r := httptest.NewRequest("POST", "/", nil)
	r.Host = "192.168.1.5:8443"
	if _, err := a.webAuthn(r); err == nil {
		t.Fatal("IP address accepted as relying party")
	}
	_ = a.store.Update(func(c *Config) error { c.PublicURL = "https://incus.home.example:8443/"; return nil })
	o, id := a.rpFor(r)
	if o != "https://incus.home.example:8443" || id != "incus.home.example" {
		t.Fatalf("public_url: %s %s", o, id)
	}
}

func TestChangeOwnPassword(t *testing.T) {
	a := testApp(t, "admin")
	login := func(pass string) *httptest.ResponseRecorder {
		return req(a, "POST", "/api/ui/login", `{"username":"admin","password":"`+pass+`"}`)
	}
	c := cookieOf(login("correct-password"), sessionCookie)
	other := cookieOf(login("correct-password"), sessionCookie)
	if w := req(a, "POST", "/api/ui/account/password", `{"current":"wrong-password","new":"brand-new-password"}`, c); w.Code != 403 {
		t.Fatalf("wrong current: %d", w.Code)
	}
	if w := req(a, "POST", "/api/ui/account/password", `{"current":"correct-password","new":"short"}`, c); w.Code != 400 {
		t.Fatalf("short: %d", w.Code)
	}
	w := req(a, "POST", "/api/ui/account/password", `{"current":"correct-password","new":"brand-new-password"}`, c)
	if w.Code != 204 {
		t.Fatalf("change: %d %s", w.Code, w.Body)
	}
	if w := req(a, "GET", "/api/ui/me", ``, cookieOf(w, sessionCookie)); w.Code != 200 {
		t.Fatalf("this browser signed out: %d", w.Code)
	}
	if w := req(a, "GET", "/api/ui/me", ``, other); w.Code != 401 {
		t.Fatalf("other session still works: %d", w.Code)
	}
	if login("correct-password").Code == 200 || login("brand-new-password").Code != 200 {
		t.Fatal("password not changed")
	}
}
