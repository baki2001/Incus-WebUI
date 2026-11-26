package main

import (
	"encoding/json"
	"net/http"
	"regexp"
	"strings"
)

// UIPrefs are per-user interface settings, kept in config.yaml under ui_prefs.
type UIPrefs struct {
	Dashboard *DashPrefs `yaml:"dashboard,omitempty" json:"dashboard,omitempty"`
	// SSHKeys are public keys Create instance can put into cloud-init.
	SSHKeys []SSHKey `yaml:"ssh_keys,omitempty" json:"ssh_keys,omitempty"`
}

type SSHKey struct {
	Name string `yaml:"name" json:"name"`
	Key  string `yaml:"key" json:"key"`
}

var sshKeyRe = regexp.MustCompile(`^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/]+={0,3}( [^\r\n]*)?$`)

// DashPrefs is the Overview layout: elements in order, each on or off, with an optional size.
type DashPrefs struct {
	Items []DashItem `yaml:"items" json:"items"`
}

type DashItem struct {
	ID   string `yaml:"id" json:"id"`
	On   bool   `yaml:"on" json:"on"`
	Size string `yaml:"size,omitempty" json:"size,omitempty"`
}

var dashID = regexp.MustCompile(`^[a-z0-9-]{1,32}$`)

func (p *UIPrefs) validate() string {
	if len(p.SSHKeys) > 20 {
		return "Keep up to 20 SSH keys."
	}
	for _, k := range p.SSHKeys {
		if k.Name == "" || len(k.Name) > 64 || strings.ContainsAny(k.Name, "\r\n") {
			return "Give each SSH key a name of up to 64 characters."
		}
		if len(k.Key) > 16384 || !sshKeyRe.MatchString(k.Key) {
			return "The key " + k.Name + " doesn't look like an SSH public key. Paste the line from your .pub file."
		}
	}
	d := p.Dashboard
	if d == nil {
		return ""
	}
	if len(d.Items) > 40 {
		return "Too many dashboard elements."
	}
	seen := map[string]bool{}
	for _, it := range d.Items {
		if !dashID.MatchString(it.ID) || seen[it.ID] {
			return "Unknown or repeated dashboard element."
		}
		seen[it.ID] = true
		if it.Size != "" && it.Size != "s" && it.Size != "m" && it.Size != "l" {
			return "Unknown element size."
		}
	}
	return ""
}

// prefsKey keeps OIDC users apart from local ones with the same name.
func prefsKey(s *Session) string {
	if s.Method == "oidc" {
		return "oidc:" + s.User
	}
	return s.User
}

func (a *App) handlePrefsGet(w http.ResponseWriter, r *http.Request) {
	s, ok := a.currentSession(r)
	if !ok {
		jsonError(w, http.StatusUnauthorized, "not signed in")
		return
	}
	writeJSON(w, a.store.Get().UIPrefs[prefsKey(s)])
}

func (a *App) handlePrefsPut(w http.ResponseWriter, r *http.Request) {
	s, ok := a.currentSession(r)
	if !ok {
		jsonError(w, http.StatusUnauthorized, "not signed in")
		return
	}
	var p UIPrefs
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192)).Decode(&p); err != nil {
		jsonError(w, http.StatusBadRequest, "bad request")
		return
	}
	if msg := p.validate(); msg != "" {
		jsonError(w, http.StatusBadRequest, msg)
		return
	}
	err := a.store.Update(func(c *Config) error {
		m := make(map[string]UIPrefs, len(c.UIPrefs)+1)
		for k, v := range c.UIPrefs {
			m[k] = v
		}
		// Each part is saved on its own: what the request leaves out stays.
		cur := m[prefsKey(s)]
		if p.Dashboard != nil {
			cur.Dashboard = p.Dashboard
		}
		if p.SSHKeys != nil {
			cur.SSHKeys = p.SSHKeys
			if len(p.SSHKeys) == 0 {
				cur.SSHKeys = nil
			}
		}
		m[prefsKey(s)] = cur
		p = cur
		c.UIPrefs = m
		return nil
	})
	if err != nil {
		jsonError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, p)
}
