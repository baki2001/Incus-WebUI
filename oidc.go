package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"
)

// oidcState caches the provider so discovery runs once per issuer.
type oidcState struct {
	mu       sync.Mutex
	issuer   string
	provider *oidc.Provider
}

func (a *App) oidcProvider(ctx context.Context, cfg *OIDCConfig) (*oidc.Provider, error) {
	a.oidc.mu.Lock()
	defer a.oidc.mu.Unlock()
	if a.oidc.provider != nil && a.oidc.issuer == cfg.Issuer {
		return a.oidc.provider, nil
	}
	p, err := oidc.NewProvider(ctx, cfg.Issuer)
	if err != nil {
		return nil, err
	}
	a.oidc.provider, a.oidc.issuer = p, cfg.Issuer
	return p, nil
}

func (a *App) oauthConfig(r *http.Request, cfg *OIDCConfig, p *oidc.Provider) *oauth2.Config {
	base := strings.TrimRight(a.store.Get().PublicURL, "/")
	if base == "" {
		scheme := "http"
		if a.secureCookies(r) {
			scheme = "https"
		}
		base = scheme + "://" + r.Host
	}
	scopes := cfg.Scopes
	if len(scopes) == 0 {
		scopes = []string{oidc.ScopeOpenID, "profile", "email"}
	}
	return &oauth2.Config{
		ClientID: cfg.ClientID, ClientSecret: cfg.ClientSecret, Endpoint: p.Endpoint(),
		RedirectURL: base + "/api/ui/oidc/callback", Scopes: scopes,
	}
}

const oidcCookie = "iwui_oidc"

func (a *App) handleOIDCLogin(w http.ResponseWriter, r *http.Request) {
	cfg := a.store.Get().OIDC
	if cfg == nil {
		http.Error(w, "SSO is not configured", http.StatusNotFound)
		return
	}
	p, err := a.oidcProvider(r.Context(), cfg)
	if err != nil {
		http.Redirect(w, r, "/login?error=sso_unreachable", http.StatusFound)
		return
	}
	state, nonce, verifier := randHex(16), randHex(16), oauth2.GenerateVerifier()
	v, _ := json.Marshal([]string{state, nonce, verifier})
	p64 := base64.RawURLEncoding.EncodeToString(v)
	http.SetCookie(w, &http.Cookie{
		Name: oidcCookie, Value: p64 + "." + a.mac(p64), Path: "/api/ui/oidc", HttpOnly: true,
		Secure: a.secureCookies(r), SameSite: http.SameSiteLaxMode, MaxAge: 600,
	})
	url := a.oauthConfig(r, cfg, p).AuthCodeURL(state, oidc.Nonce(nonce), oauth2.S256ChallengeOption(verifier))
	http.Redirect(w, r, url, http.StatusFound)
}

func (a *App) handleOIDCCallback(w http.ResponseWriter, r *http.Request) {
	fail := func() { http.Redirect(w, r, "/login?error=sso_failed", http.StatusFound) }
	cfg := a.store.Get().OIDC
	if cfg == nil {
		fail()
		return
	}
	c, err := r.Cookie(oidcCookie)
	if err != nil {
		fail()
		return
	}
	http.SetCookie(w, &http.Cookie{Name: oidcCookie, Value: "", Path: "/api/ui/oidc", MaxAge: -1})
	p64, sig, ok := strings.Cut(c.Value, ".")
	if !ok || sig != a.mac(p64) {
		fail()
		return
	}
	raw, _ := base64.RawURLEncoding.DecodeString(p64)
	var st []string
	if json.Unmarshal(raw, &st) != nil || len(st) != 3 || r.URL.Query().Get("state") != st[0] {
		fail()
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	p, err := a.oidcProvider(ctx, cfg)
	if err != nil {
		fail()
		return
	}
	tok, err := a.oauthConfig(r, cfg, p).Exchange(ctx, r.URL.Query().Get("code"), oauth2.VerifierOption(st[2]))
	if err != nil {
		fail()
		return
	}
	rawID, _ := tok.Extra("id_token").(string)
	idt, err := p.Verifier(&oidc.Config{ClientID: cfg.ClientID}).Verify(ctx, rawID)
	if err != nil || idt.Nonce != st[1] {
		fail()
		return
	}
	var claims map[string]any
	_ = idt.Claims(&claims)
	email, _ := claims["email"].(string)
	name, _ := claims["preferred_username"].(string)
	if name == "" {
		name = email
	}
	if name == "" {
		name = idt.Subject
	}
	if !oidcAllowed(cfg, email, claims) {
		a.auditLogin(r, name, "oidc", false)
		http.Redirect(w, r, "/login?error=sso_denied", http.StatusFound)
		return
	}
	a.auditLogin(r, name, "oidc", true)
	a.setSession(w, r, name, "oidc", oidcGroups(cfg, claims)...)
	http.Redirect(w, r, "/", http.StatusFound)
}

func oidcGroups(cfg *OIDCConfig, claims map[string]any) []string {
	gc := cfg.GroupsClaim
	if gc == "" {
		gc = "groups"
	}
	var out []string
	if groups, ok := claims[gc].([]any); ok {
		for _, g := range groups {
			if s, ok := g.(string); ok && s != "" {
				out = append(out, s)
			}
		}
	}
	return out
}

// oidcAllowed: with no allow lists, anyone the issuer authenticates may sign in.
func oidcAllowed(cfg *OIDCConfig, email string, claims map[string]any) bool {
	if len(cfg.AllowedEmails) == 0 && len(cfg.AllowedGroups) == 0 {
		return true
	}
	if email != "" && slices.ContainsFunc(cfg.AllowedEmails, func(e string) bool { return strings.EqualFold(e, email) }) {
		if v, ok := claims["email_verified"].(bool); !ok || v {
			return true
		}
	}
	gc := cfg.GroupsClaim
	if gc == "" {
		gc = "groups"
	}
	if groups, ok := claims[gc].([]any); ok {
		for _, g := range groups {
			if s, ok := g.(string); ok && slices.Contains(cfg.AllowedGroups, s) {
				return true
			}
		}
	}
	return false
}
