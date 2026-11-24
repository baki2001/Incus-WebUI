package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"

	"gopkg.in/yaml.v3"
)

// Config is the whole settings file. There is no database: everything the UI
// needs to remember lives here and is rewritten atomically on change.
type Config struct {
	Listen        string `yaml:"listen"`
	PublicURL     string `yaml:"public_url,omitempty"` // needed for OIDC redirects
	TLS           *bool  `yaml:"tls,omitempty"`        // default true (self-signed cert in data dir)
	TLSCert       string `yaml:"tls_cert,omitempty"`
	TLSKey        string `yaml:"tls_key,omitempty"`
	SessionSecret string `yaml:"session_secret"`

	Theme Theme  `yaml:"theme"`
	Users []User `yaml:"users"`
	// Revoked lists sessions ended by logout; entries are dropped once the session would have expired.
	Revoked []RevokedSession `yaml:"revoked_sessions,omitempty"`
	OIDC    *OIDCConfig      `yaml:"oidc,omitempty"`
	// OIDCGen must match the generation in an OIDC session cookie. It changes
	// whenever the OIDC settings or the allowed lists change (see syncOIDCGen).
	OIDCGen int64 `yaml:"oidc_gen,omitempty"`
	// OIDCSum is a fingerprint of the OIDC settings, to notice edits made by hand.
	OIDCSum string `yaml:"oidc_sum,omitempty"`
	// TrustedProxies are the IPs or CIDRs of reverse proxies whose
	// X-Forwarded-For header is believed (used for the login rate limit).
	TrustedProxies []string       `yaml:"trusted_proxies,omitempty"`
	Servers        []ServerConfig `yaml:"servers"`
	// ImageServers are the simplestreams servers the UI offers images from.
	ImageServers []ImageServer `yaml:"image_servers,omitempty"`
	// UIPrefs are per-user interface settings, keyed by user name (see prefs.go).
	UIPrefs map[string]UIPrefs `yaml:"ui_prefs,omitempty"`
	// Access says who may do what (see access.go). Installs from before 0.5
	// get one entry that makes everyone admin, which is how they worked.
	Access []Access `yaml:"access,omitempty"`
	// Backups are the backup targets and schedules (see backup.go).
	Backups Backups `yaml:"backups,omitempty"`
}

type Theme struct {
	Name   string `yaml:"name" json:"name"`                         // kyoto | light | graphite | custom
	Accent string `yaml:"accent,omitempty" json:"accent,omitempty"` // hex, for custom
}

type User struct {
	Username     string `yaml:"username"`
	PasswordHash string `yaml:"password_hash"`
	// SessionGen must match the generation in a session cookie. It changes on
	// password change and is a creation timestamp for new users.
	SessionGen int64 `yaml:"session_gen,omitempty"`

	// TOTPSecret turns on two-factor sign-in with an authenticator app (base32, see mfa.go).
	TOTPSecret string `yaml:"totp_secret,omitempty"`
	// TOTPLast is the last time step a code was accepted for, so each code works once.
	TOTPLast int64 `yaml:"totp_last,omitempty"`
	// RecoveryCodes are SHA-256 hashes of the unused one-time recovery codes.
	RecoveryCodes []string `yaml:"recovery_codes,omitempty"`
	// WebAuthnID is the random user handle passkeys are registered under (base64url).
	WebAuthnID string    `yaml:"webauthn_id,omitempty"`
	Passkeys   []Passkey `yaml:"passkeys,omitempty"`
}

// Passkey is one registered WebAuthn credential (see passkey.go).
type Passkey struct {
	ID       string `yaml:"id"` // credential id, base64url
	Name     string `yaml:"name"`
	Created  int64  `yaml:"created"`
	LastUsed int64  `yaml:"last_used,omitempty"`
	// Credential is the webauthn library's credential record as JSON.
	Credential string `yaml:"credential"`
}

type RevokedSession struct {
	ID      string `yaml:"id"`
	Expires int64  `yaml:"expires"`
}

type OIDCConfig struct {
	Issuer        string   `yaml:"issuer"`
	ClientID      string   `yaml:"client_id"`
	ClientSecret  string   `yaml:"client_secret"`
	Scopes        []string `yaml:"scopes,omitempty"`
	AllowedEmails []string `yaml:"allowed_emails,omitempty"`
	AllowedGroups []string `yaml:"allowed_groups,omitempty"`
	GroupsClaim   string   `yaml:"groups_claim,omitempty"`
	ButtonLabel   string   `yaml:"button_label,omitempty"`
}

type ServerConfig struct {
	Name string `yaml:"name"`
	// URL is https://host:8443 or unix:///var/lib/incus/unix.socket
	URL string `yaml:"url"`
	// ServerCert pins the server's certificate (PEM). Empty means verify with system CAs.
	ServerCert string `yaml:"server_cert,omitempty"`
}

type Store struct {
	mu   sync.RWMutex
	path string
	cfg  Config
	// Fresh is true when the config file did not exist yet (first start).
	Fresh bool
}

func loadStore(dataDir string) (*Store, error) {
	path := filepath.Join(dataDir, "config.yaml")
	s := &Store{path: path}
	b, err := os.ReadFile(path)
	if err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	if err == nil {
		if err := yaml.Unmarshal(b, &s.cfg); err != nil {
			return nil, fmt.Errorf("parse %s: %w", path, err)
		}
	}
	changed := false
	if s.cfg.Listen == "" {
		s.cfg.Listen = ":8443"
		changed = true
	}
	if len(s.cfg.SessionSecret) < 32 {
		s.cfg.SessionSecret = randHex(32)
		changed = true
	}
	if s.cfg.Theme.Name == "" {
		s.cfg.Theme.Name = "kyoto"
		changed = true
	}
	// Harbor (teal) was replaced by Kyoto in 0.6.
	if s.cfg.Theme.Name == "harbor" {
		s.cfg.Theme.Name = "kyoto"
		changed = true
	}
	if len(s.cfg.Access) == 0 {
		s.cfg.Access = []Access{{Who: "*", Server: "*", Project: "*", Role: "admin"}}
		changed = true
	}
	if syncOIDCGen(&s.cfg) {
		changed = true
	}
	s.Fresh = err != nil
	if changed || err != nil {
		if err := s.saveLocked(); err != nil {
			return nil, err
		}
	}
	return s, nil
}

// syncOIDCGen ends all OIDC sessions when the OIDC settings or allowed lists
// differ from the last saved ones. It reports whether it changed anything.
func syncOIDCGen(c *Config) bool {
	sum := ""
	if o := c.OIDC; o != nil {
		cp := *o
		cp.ButtonLabel = "" // a label change needs no sign-out
		b, _ := json.Marshal(cp)
		h := sha256.Sum256(b)
		sum = hex.EncodeToString(h[:])
	}
	if sum == c.OIDCSum {
		return false
	}
	c.OIDCSum = sum
	c.OIDCGen = nextGen(c.OIDCGen)
	return true
}

func (s *Store) Get() Config {
	s.mu.RLock()
	defer s.mu.RUnlock()
	c := s.cfg
	c.Users = append([]User(nil), s.cfg.Users...)
	c.Servers = append([]ServerConfig(nil), s.cfg.Servers...)
	c.Revoked = append([]RevokedSession(nil), s.cfg.Revoked...)
	c.Access = append([]Access(nil), s.cfg.Access...)
	c.Backups.Targets = append([]BackupTarget(nil), s.cfg.Backups.Targets...)
	c.Backups.Schedules = append([]BackupSchedule(nil), s.cfg.Backups.Schedules...)
	c.Backups.PBS = append([]PBSServer(nil), s.cfg.Backups.PBS...)
	return c
}

// Update applies fn to the config and writes it to disk.
func (s *Store) Update(fn func(c *Config) error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	next := s.cfg
	next.Users = append([]User(nil), s.cfg.Users...)
	next.Servers = append([]ServerConfig(nil), s.cfg.Servers...)
	next.Revoked = append([]RevokedSession(nil), s.cfg.Revoked...)
	next.Access = append([]Access(nil), s.cfg.Access...)
	next.Backups.Targets = append([]BackupTarget(nil), s.cfg.Backups.Targets...)
	next.Backups.Schedules = append([]BackupSchedule(nil), s.cfg.Backups.Schedules...)
	next.Backups.PBS = append([]PBSServer(nil), s.cfg.Backups.PBS...)
	if err := fn(&next); err != nil {
		return err
	}
	syncOIDCGen(&next)
	prev := s.cfg
	s.cfg = next
	if err := s.saveLocked(); err != nil {
		s.cfg = prev
		return err
	}
	return nil
}

func (s *Store) saveLocked() error {
	b, err := yaml.Marshal(&s.cfg)
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

func randHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}
