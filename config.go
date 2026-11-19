package main

import (
	"crypto/rand"
	"encoding/hex"
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

	Theme   Theme          `yaml:"theme"`
	Users   []User         `yaml:"users"`
	OIDC    *OIDCConfig    `yaml:"oidc,omitempty"`
	Servers []ServerConfig `yaml:"servers"`
}

type Theme struct {
	Name   string `yaml:"name" json:"name"`                         // graphite | harbor | custom
	Accent string `yaml:"accent,omitempty" json:"accent,omitempty"` // hex, for custom
}

type User struct {
	Username     string `yaml:"username"`
	PasswordHash string `yaml:"password_hash"`
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
		s.cfg.Theme.Name = "graphite"
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

func (s *Store) Get() Config {
	s.mu.RLock()
	defer s.mu.RUnlock()
	c := s.cfg
	c.Users = append([]User(nil), s.cfg.Users...)
	c.Servers = append([]ServerConfig(nil), s.cfg.Servers...)
	return c
}

// Update applies fn to the config and writes it to disk.
func (s *Store) Update(fn func(c *Config) error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	next := s.cfg
	next.Users = append([]User(nil), s.cfg.Users...)
	next.Servers = append([]ServerConfig(nil), s.cfg.Servers...)
	if err := fn(&next); err != nil {
		return err
	}
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
