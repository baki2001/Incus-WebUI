package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"
)

// Backends keeps one HTTP transport per configured Incus server.
type Backends struct {
	mu         sync.Mutex
	clientCert tls.Certificate
	transports map[string]*backend
}

type backend struct {
	key       string // url + pin, to notice config changes
	base      *url.URL
	transport *http.Transport
}

func (b *Backends) get(s ServerConfig) (*backend, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	key := s.URL + "|" + s.ServerCert
	if be, ok := b.transports[s.Name]; ok && be.key == key {
		return be, nil
	}
	be, err := b.build(s)
	if err != nil {
		return nil, err
	}
	be.key = key
	b.transports[s.Name] = be
	return be, nil
}

func (b *Backends) build(s ServerConfig) (*backend, error) {
	u, err := url.Parse(s.URL)
	if err != nil {
		return nil, err
	}
	t := &http.Transport{
		Proxy:                 nil, // talk to Incus directly
		MaxIdleConnsPerHost:   16,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ResponseHeaderTimeout: 0, // operation waits can be long
	}
	switch u.Scheme {
	case "unix":
		path := u.Path
		t.DialContext = func(ctx context.Context, _, _ string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, "unix", path)
		}
		u = &url.URL{Scheme: "http", Host: "unix.socket"}
	case "https":
		t.TLSClientConfig = tlsConfigFor(b.clientCert, pemToDER(s.ServerCert))
	default:
		return nil, fmt.Errorf("unsupported URL scheme %q", u.Scheme)
	}
	return &backend{base: u, transport: t}, nil
}

// tlsConfigFor pins the server certificate when one is known (Incus servers
// usually have self-signed certs), else uses normal CA verification.
func tlsConfigFor(client tls.Certificate, pinned []byte) *tls.Config {
	c := &tls.Config{Certificates: []tls.Certificate{client}, MinVersion: tls.VersionTLS12}
	if len(pinned) > 0 {
		c.InsecureSkipVerify = true // replaced by the exact pin check below
		c.VerifyPeerCertificate = func(raw [][]byte, _ [][]*x509.Certificate) error {
			if len(raw) == 0 || !bytes.Equal(raw[0], pinned) {
				return errors.New("server certificate does not match the pinned one")
			}
			return nil
		}
	}
	return c
}

func (a *App) server(name string) (ServerConfig, bool) {
	for _, s := range a.store.Get().Servers {
		if s.Name == name {
			return s, true
		}
	}
	return ServerConfig{}, false
}

// handleProxy forwards /api/s/{server}/<incus path> to that Incus server,
// including websockets (exec, console, events). Only the Incus REST API
// (/1.0...) and the IncusOS API (/os/...) are reachable.
func (a *App) handleProxy(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("server")
	rest := "/" + r.PathValue("rest")
	if !(rest == "/1.0" || strings.HasPrefix(rest, "/1.0/") || strings.HasPrefix(rest, "/os/")) || strings.Contains(rest, "..") {
		jsonError(w, http.StatusNotFound, "not found")
		return
	}
	s, ok := a.server(name)
	if !ok {
		jsonError(w, http.StatusNotFound, "unknown server")
		return
	}
	allowed, filter := a.checkIncus(w, r, name, rest)
	if !allowed {
		return
	}
	if filter != nil {
		// Only lists across projects are filtered; drop compression so the body is plain JSON.
		r.Header.Del("Accept-Encoding")
		fw := &filterResponse{ResponseWriter: w}
		defer fw.finish(filter)
		w = fw
	}
	be, err := a.backends.get(s)
	if err != nil {
		jsonError(w, http.StatusBadGateway, err.Error())
		return
	}
	// A change to the host network (a bridge coming up) can make the browser drop
	// its request. If Incus saw the client vanish half way, it would leave the
	// object half made (a network stuck in Pending). So JSON changes run to the
	// end even when the browser is gone; the UI looks at the result afterwards.
	if r.Method != http.MethodGet && r.Method != http.MethodHead && r.Header.Get("Upgrade") == "" && strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 5*time.Minute)
		defer cancel()
		r = r.WithContext(ctx)
	}
	proxy := &httputil.ReverseProxy{
		Transport: be.transport,
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.Out.URL.Scheme = be.base.Scheme
			pr.Out.URL.Host = be.base.Host
			pr.Out.URL.Path = rest
			pr.Out.URL.RawPath = ""
			pr.Out.Host = be.base.Host
			// Nothing from the browser session goes to Incus.
			pr.Out.Header.Del("Cookie")
			pr.Out.Header.Del("Authorization")
			pr.Out.Header.Del("Origin")
			pr.Out.Header.Del("X-Incus-UI")
			pr.Out.Header.Del("Referer")
		},
		FlushInterval: -1,
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, err error) {
			jsonError(w, http.StatusBadGateway, "Can't reach "+name+": "+err.Error())
		},
	}
	proxy.ServeHTTP(w, r)
}

// --- server management ---

type serverStatus struct {
	Name        string `json:"name"`
	URL         string `json:"url"`
	Online      bool   `json:"online"`
	Trusted     bool   `json:"trusted"`
	Error       string `json:"error,omitempty"`
	Version     string `json:"version,omitempty"`
	OS          string `json:"os,omitempty"`
	ServerName  string `json:"server_name,omitempty"`
	Clustered   bool   `json:"clustered,omitempty"`
	IncusOS     bool   `json:"incus_os,omitempty"`
	Fingerprint string `json:"fingerprint,omitempty"`
}

func (a *App) probe(ctx context.Context, s ServerConfig) serverStatus {
	st := serverStatus{Name: s.Name, URL: s.URL}
	if d := pemToDER(s.ServerCert); d != nil {
		st.Fingerprint = certFingerprint(d)
	}
	be, err := a.backends.get(s)
	if err != nil {
		st.Error = err.Error()
		return st
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", be.base.String()+"/1.0", nil)
	resp, err := be.transport.RoundTrip(req)
	if err != nil {
		st.Error = err.Error()
		return st
	}
	defer resp.Body.Close()
	var body struct {
		Metadata struct {
			Auth        string `json:"auth"`
			Environment struct {
				ServerVersion   string `json:"server_version"`
				ServerName      string `json:"server_name"`
				OSName          string `json:"os_name"`
				OSVersion       string `json:"os_version"`
				ServerClustered bool   `json:"server_clustered"`
			} `json:"environment"`
		} `json:"metadata"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&body)
	st.Online = true
	m := body.Metadata
	st.Trusted = m.Auth == "trusted"
	st.Version = m.Environment.ServerVersion
	st.ServerName = m.Environment.ServerName
	st.OS = strings.TrimSpace(m.Environment.OSName + " " + m.Environment.OSVersion)
	st.Clustered = m.Environment.ServerClustered
	st.IncusOS = m.Environment.OSName == "IncusOS"
	if !st.Trusted {
		st.Error = "This UI's certificate is not trusted by the server yet."
	}
	return st
}

func (a *App) handleServers(w http.ResponseWriter, r *http.Request) {
	servers := a.store.Get().Servers
	out := make([]serverStatus, len(servers))
	var wg sync.WaitGroup
	for i, s := range servers {
		wg.Add(1)
		go func() { defer wg.Done(); out[i] = a.probe(r.Context(), s) }()
	}
	wg.Wait()
	writeJSON(w, out)
}

var serverNameRe = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9-]{0,62}$`)

// trustToken is what `incus config trust add <name>` prints (base64 JSON).
type trustToken struct {
	ClientName  string   `json:"client_name"`
	Fingerprint string   `json:"fingerprint"`
	Addresses   []string `json:"addresses"`
	Secret      string   `json:"secret"`
}

func decodeToken(s string) (*trustToken, error) {
	s = strings.TrimSpace(s)
	for _, enc := range []*base64.Encoding{base64.StdEncoding, base64.URLEncoding, base64.RawStdEncoding, base64.RawURLEncoding} {
		if b, err := enc.DecodeString(s); err == nil {
			var t trustToken
			if json.Unmarshal(b, &t) == nil && t.Secret != "" {
				return &t, nil
			}
		}
	}
	return nil, errors.New("That doesn't look like an Incus trust token.")
}

// handleServerAdd adds a server in one of three ways:
//   - token: a trust token from `incus config trust add incus-webui`; we find the
//     server, pin its certificate and get our certificate trusted in one go.
//   - url (https): we pin the certificate we see; the user trusts ours by hand.
//   - url (unix://): local socket when the UI runs on the Incus host.
func (a *App) handleServerAdd(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name, Token, URL string
		Fingerprint      string // optional, for https URLs: expected server fingerprint
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16384)).Decode(&req); err != nil {
		jsonError(w, http.StatusBadRequest, "bad request")
		return
	}
	if !serverNameRe.MatchString(req.Name) {
		jsonError(w, http.StatusBadRequest, "Name can use letters, numbers and dashes.")
		return
	}
	if _, exists := a.server(req.Name); exists {
		jsonError(w, http.StatusConflict, "A server with that name already exists.")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()

	var sc ServerConfig
	var err error
	switch {
	case req.Token != "":
		sc, err = a.addWithToken(ctx, req.Name, req.Token)
	case strings.HasPrefix(req.URL, "unix://"):
		if _, statErr := os.Stat(strings.TrimPrefix(req.URL, "unix://")); statErr != nil {
			err = errors.New("No Incus socket at that path.")
		}
		sc = ServerConfig{Name: req.Name, URL: req.URL}
	case strings.HasPrefix(req.URL, "https://"):
		sc, err = a.pinURL(ctx, req.Name, req.URL, req.Fingerprint)
	default:
		err = errors.New("Paste a trust token, or a URL like https://host:8443.")
	}
	if err != nil {
		jsonError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := a.store.Update(func(c *Config) error {
		c.Servers = append(c.Servers, sc)
		return nil
	}); err != nil {
		jsonError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, a.probe(r.Context(), sc))
}

// fetchCert connects once and returns the server's leaf certificate.
func fetchCert(ctx context.Context, addr string) ([]byte, error) {
	d := &tls.Dialer{NetDialer: &net.Dialer{Timeout: 4 * time.Second}, Config: &tls.Config{InsecureSkipVerify: true}}
	conn, err := d.DialContext(ctx, "tcp", addr)
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	certs := conn.(*tls.Conn).ConnectionState().PeerCertificates
	if len(certs) == 0 {
		return nil, errors.New("no certificate")
	}
	return certs[0].Raw, nil
}

func hostPort(u *url.URL) string {
	if u.Port() == "" {
		return net.JoinHostPort(u.Hostname(), "8443")
	}
	return u.Host
}

func (a *App) pinURL(ctx context.Context, name, raw, wantFP string) (ServerConfig, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return ServerConfig{}, errors.New("That URL doesn't look right.")
	}
	der, err := fetchCert(ctx, hostPort(u))
	if err != nil {
		return ServerConfig{}, fmt.Errorf("Can't connect: %v", err)
	}
	if wantFP != "" && !strings.EqualFold(strings.ReplaceAll(wantFP, ":", ""), certFingerprint(der)) {
		return ServerConfig{}, errors.New("The server's certificate fingerprint doesn't match.")
	}
	return ServerConfig{Name: name, URL: "https://" + hostPort(u), ServerCert: string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}))}, nil
}

func (a *App) addWithToken(ctx context.Context, name, token string) (ServerConfig, error) {
	t, err := decodeToken(token)
	if err != nil {
		return ServerConfig{}, err
	}
	var lastErr error = errors.New("The token has no addresses. Set core.https_address on the server first.")
	for _, addr := range t.Addresses {
		der, err := fetchCert(ctx, addr)
		if err != nil {
			lastErr = fmt.Errorf("Can't connect to %s: %v", addr, err)
			continue
		}
		if !strings.EqualFold(certFingerprint(der), t.Fingerprint) {
			lastErr = fmt.Errorf("Certificate at %s doesn't match the token.", addr)
			continue
		}
		sc := ServerConfig{Name: name, URL: "https://" + addr, ServerCert: string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}))}
		be, err := a.backends.get(sc)
		if err != nil {
			return ServerConfig{}, err
		}
		body, _ := json.Marshal(map[string]any{"type": "client", "name": "incus-webui", "trust_token": strings.TrimSpace(token)})
		req, _ := http.NewRequestWithContext(ctx, "POST", be.base.String()+"/1.0/certificates", bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		resp, err := be.transport.RoundTrip(req)
		if err != nil {
			lastErr = err
			continue
		}
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		resp.Body.Close()
		if resp.StatusCode >= 300 {
			var e struct{ Error string }
			_ = json.Unmarshal(msg, &e)
			if strings.Contains(e.Error, "already exists") || strings.Contains(e.Error, "already trusted") {
				return sc, nil
			}
			return ServerConfig{}, fmt.Errorf("The server refused the token: %s", e.Error)
		}
		return sc, nil
	}
	return ServerConfig{}, lastErr
}

func (a *App) handleServerDelete(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	err := a.store.Update(func(c *Config) error {
		out := c.Servers[:0]
		for _, s := range c.Servers {
			if s.Name != name {
				out = append(out, s)
			}
		}
		c.Servers = out
		return nil
	})
	if err != nil {
		jsonError(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleClientCert returns the certificate Incus servers need to trust.
func (a *App) handleClientCert(w http.ResponseWriter, r *http.Request) {
	der := a.backends.clientCert.Certificate[0]
	writeJSON(w, map[string]string{
		"pem":         string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})),
		"fingerprint": certFingerprint(der),
	})
}
