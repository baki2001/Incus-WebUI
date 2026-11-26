package main

// Alerts tell people when something needs a look while nobody is signed in:
// a failed backup or test restore, a server that stops answering, a storage
// pool that fills up, a new Incus warning or a new release of the UI. Each
// alert goes to every endpoint: a plain webhook, ntfy, Discord, Slack,
// Gotify or an e-mail address. There are no rules to write, only on/off
// switches per kind.

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"maps"
	"net"
	"net/http"
	"net/smtp"
	"net/url"
	"os"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
)

type Alerts struct {
	Endpoints []AlertEndpoint `yaml:"endpoints,omitempty" json:"endpoints"`
	// Off lists the kinds of alerts that are turned off (see alertKinds).
	// Everything is on by default.
	Off []string `yaml:"off,omitempty" json:"off"`
	// PoolPercent is how full a storage pool may get before it alerts. 0 means 90.
	PoolPercent int `yaml:"pool_percent,omitempty" json:"pool_percent"`
}

type AlertEndpoint struct {
	Name string `yaml:"name" json:"name"`
	Type string `yaml:"type" json:"type"` // webhook | ntfy | discord | slack | gotify | email
	// URL is where the message goes: the webhook, the ntfy topic or the Gotify server.
	URL string `yaml:"url,omitempty" json:"url,omitempty"`
	// Token is the ntfy access token or the Gotify application token.
	Token string `yaml:"token,omitempty" json:"token,omitempty"`
	// E-mail
	Host     string `yaml:"host,omitempty" json:"host,omitempty"`
	Port     int    `yaml:"port,omitempty" json:"port,omitempty"`
	Username string `yaml:"username,omitempty" json:"username,omitempty"`
	Password string `yaml:"password,omitempty" json:"password,omitempty"`
	From     string `yaml:"from,omitempty" json:"from,omitempty"`
	To       string `yaml:"to,omitempty" json:"to,omitempty"` // one or more addresses, comma separated
}

const (
	alertBackup  = "backup"  // a scheduled backup or test restore failed
	alertOffline = "offline" // a server stopped answering, or came back
	alertPool    = "pool"    // a storage pool is fuller than PoolPercent
	alertWarning = "warning" // Incus raised a new warning
	alertUpdate  = "update"  // a new release of the UI is out
)

var alertKinds = []string{alertBackup, alertOffline, alertPool, alertWarning, alertUpdate}

func (al Alerts) on(kind string) bool { return !slices.Contains(al.Off, kind) }

func (al Alerts) poolPercent() int {
	if al.PoolPercent == 0 {
		return 90
	}
	return al.PoolPercent
}

type alertMsg struct {
	Kind   string
	Title  string
	Body   string
	Server string
	Bad    bool // a problem, not a recovery or a note
}

var alertHTTP = &http.Client{Timeout: 20 * time.Second}

// alert sends a message to every endpoint, if that kind of alert is on. It
// doesn't wait: a slow endpoint must not hold up a backup or the checks.
func (a *App) alert(m alertMsg) {
	cfg := a.store.Get()
	al := cfg.Alerts
	if len(al.Endpoints) == 0 || !al.on(m.Kind) {
		return
	}
	link := strings.TrimRight(cfg.PublicURL, "/")
	for _, e := range al.Endpoints {
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			if err := sendAlert(ctx, e, m, link); err != nil {
				log.Printf("alert %q to %s: %v", m.Title, e.Name, err)
			}
		}()
	}
}

// sendAlert formats a message for one endpoint and sends it.
func sendAlert(ctx context.Context, e AlertEndpoint, m alertMsg, link string) error {
	body := m.Body
	if m.Server != "" {
		body = strings.TrimSpace(body + "\n\nServer: " + m.Server)
	}
	if link != "" {
		body += "\n" + link
	}
	switch e.Type {
	case "webhook":
		return postJSON(ctx, e.URL, nil, map[string]any{
			"source": "incus-webui", "kind": m.Kind, "title": m.Title, "message": m.Body,
			"server": m.Server, "problem": m.Bad, "time": time.Now().UTC().Format(time.RFC3339), "url": link,
		})
	case "discord":
		return postJSON(ctx, e.URL, nil, map[string]any{"content": "**" + m.Title + "**\n" + body, "allowed_mentions": map[string]any{"parse": []string{}}})
	case "slack":
		return postJSON(ctx, e.URL, nil, map[string]any{"text": "*" + m.Title + "*\n" + body})
	case "gotify":
		prio := 5
		if m.Bad {
			prio = 8
		}
		u := strings.TrimRight(e.URL, "/") + "/message"
		return postJSON(ctx, u, map[string]string{"X-Gotify-Key": e.Token}, map[string]any{"title": m.Title, "message": body, "priority": prio})
	case "ntfy":
		hdr := map[string]string{"Title": m.Title, "Content-Type": "text/plain; charset=utf-8"}
		if m.Bad {
			hdr["Priority"], hdr["Tags"] = "high", "warning"
		}
		if e.Token != "" {
			hdr["Authorization"] = "Bearer " + e.Token
		}
		if link != "" {
			hdr["Click"] = link
		}
		return httpPost(ctx, e.URL, hdr, []byte(body))
	case "email":
		return sendMail(ctx, e, m.Title, body)
	}
	return fmt.Errorf("unknown endpoint type %q", e.Type)
}

func postJSON(ctx context.Context, u string, hdr map[string]string, v any) error {
	b, _ := json.Marshal(v)
	h := map[string]string{"Content-Type": "application/json"}
	for k, x := range hdr {
		h[k] = x
	}
	return httpPost(ctx, u, h, b)
}

func httpPost(ctx context.Context, u string, hdr map[string]string, body []byte) error {
	req, err := http.NewRequestWithContext(ctx, "POST", u, bytes.NewReader(body))
	if err != nil {
		return err
	}
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	req.Header.Set("User-Agent", "incus-webui/"+version)
	resp, err := alertHTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 300))
		return fmt.Errorf("%s answered %s %s", req.URL.Host, resp.Status, strings.TrimSpace(string(msg)))
	}
	return nil
}

// sendMail sends over SMTP: implicit TLS on port 465, otherwise STARTTLS
// when the server offers it. A password is only sent over TLS.
func sendMail(ctx context.Context, e AlertEndpoint, subject, body string) error {
	addr := net.JoinHostPort(e.Host, strconv.Itoa(e.Port))
	d := &net.Dialer{Timeout: 15 * time.Second}
	var conn net.Conn
	var err error
	tlsCfg := &tls.Config{ServerName: e.Host, MinVersion: tls.VersionTLS12}
	if e.Port == 465 {
		conn, err = (&tls.Dialer{NetDialer: d, Config: tlsCfg}).DialContext(ctx, "tcp", addr)
	} else {
		conn, err = d.DialContext(ctx, "tcp", addr)
	}
	if err != nil {
		return err
	}
	if dl, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(dl)
	}
	c, err := smtp.NewClient(conn, e.Host)
	if err != nil {
		conn.Close()
		return err
	}
	defer c.Close()
	if e.Port != 465 {
		if ok, _ := c.Extension("STARTTLS"); ok {
			if err := c.StartTLS(tlsCfg); err != nil {
				return err
			}
		}
	}
	if e.Username != "" {
		// PlainAuth refuses to send the password without TLS, except to localhost.
		if err := c.Auth(smtp.PlainAuth("", e.Username, e.Password, e.Host)); err != nil {
			return err
		}
	}
	if err := c.Mail(e.From); err != nil {
		return err
	}
	to := mailList(e.To)
	for _, rcpt := range to {
		if err := c.Rcpt(rcpt); err != nil {
			return err
		}
	}
	w, err := c.Data()
	if err != nil {
		return err
	}
	msg := "From: " + e.From + "\r\nTo: " + strings.Join(to, ", ") + "\r\nSubject: " + mailHeader(subject) +
		"\r\nDate: " + time.Now().Format(time.RFC1123Z) + "\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n" +
		strings.ReplaceAll(body, "\n", "\r\n") + "\r\n"
	if _, err := io.WriteString(w, msg); err != nil {
		return err
	}
	if err := w.Close(); err != nil {
		return err
	}
	return c.Quit()
}

func mailList(s string) []string {
	var out []string
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// mailHeader keeps a subject on one line.
func mailHeader(s string) string { return strings.NewReplacer("\r", " ", "\n", " ").Replace(s) }

// --- checks ---------------------------------------------------------------------

// alertState is what the checks remember between runs, so an alert goes out
// once per problem and not again after a restart.
type alertState struct {
	Misses   map[string]int  `json:"misses"`   // server -> checks in a row it didn't answer
	Down     map[string]bool `json:"down"`     // server -> an offline alert went out
	FullPool map[string]bool `json:"full"`     // server/pool -> a full alert went out
	Warnings map[string]bool `json:"warnings"` // server/uuid -> seen
	Known    map[string]bool `json:"known"`    // server -> warnings were read once
	Update   string          `json:"update"`   // the release an alert went out for
}

type alertWatch struct {
	mu    sync.Mutex
	path  string
	state alertState
}

func (w *alertWatch) load(path string) {
	w.path = path
	if b, err := os.ReadFile(path); err == nil {
		_ = json.Unmarshal(b, &w.state)
	}
	s := &w.state
	for _, m := range []*map[string]bool{&s.Down, &s.FullPool, &s.Warnings, &s.Known} {
		if *m == nil {
			*m = map[string]bool{}
		}
	}
	if s.Misses == nil {
		s.Misses = map[string]int{}
	}
}

func (w *alertWatch) save() {
	if w.path == "" {
		return
	}
	b, _ := json.Marshal(w.state)
	tmp := w.path + ".tmp"
	if os.WriteFile(tmp, b, 0o600) == nil {
		_ = os.Rename(tmp, w.path)
	}
}

const alertEvery = 5 * time.Minute

func (a *App) runAlertChecks(ctx context.Context) {
	t := time.NewTimer(time.Minute)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		if len(a.store.Get().Alerts.Endpoints) > 0 {
			cctx, cancel := context.WithTimeout(ctx, 3*time.Minute)
			a.checkAlerts(cctx)
			cancel()
		}
		t.Reset(alertEvery)
	}
}

func (a *App) checkAlerts(ctx context.Context) {
	cfg := a.store.Get()
	var wg sync.WaitGroup
	var mu sync.Mutex
	var msgs []alertMsg
	add := func(m alertMsg) { mu.Lock(); msgs = append(msgs, m); mu.Unlock() }
	for _, s := range cfg.Servers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			a.checkServer(ctx, s, cfg.Alerts, add)
		}()
	}
	wg.Wait()
	a.checkUpdate(ctx, add)
	a.watch.mu.Lock()
	// Forget servers that were removed.
	gone := func(k string) bool {
		srv, _, _ := strings.Cut(k, "/")
		return !slices.ContainsFunc(cfg.Servers, func(s ServerConfig) bool { return s.Name == srv })
	}
	for _, m := range []map[string]bool{a.watch.state.Down, a.watch.state.Known, a.watch.state.FullPool, a.watch.state.Warnings} {
		maps.DeleteFunc(m, func(k string, _ bool) bool { return gone(k) })
	}
	maps.DeleteFunc(a.watch.state.Misses, func(k string, _ int) bool { return gone(k) })
	a.watch.save()
	a.watch.mu.Unlock()
	for _, m := range msgs {
		a.alert(m)
	}
}

// checkServer looks at one server: does it answer, are its pools full, does
// it have new warnings. It only reads and updates the state; add queues the
// messages to send.
func (a *App) checkServer(ctx context.Context, s ServerConfig, al Alerts, add func(alertMsg)) {
	st := a.probe(ctx, s)
	ok := st.Online && st.Trusted
	w := &a.watch
	w.mu.Lock()
	if !ok {
		w.state.Misses[s.Name]++
		// Two missed checks in a row, so a restart of Incus doesn't alert.
		if w.state.Misses[s.Name] >= 2 && !w.state.Down[s.Name] {
			w.state.Down[s.Name] = true
			why := st.Error
			if why == "" {
				why = "It doesn't answer."
			}
			add(alertMsg{Kind: alertOffline, Title: s.Name + " is offline", Body: "The UI has not reached " + s.Name + " for the last two checks, five minutes apart. " + why, Server: s.Name, Bad: true})
		}
		w.mu.Unlock()
		return
	}
	w.state.Misses[s.Name] = 0
	if w.state.Down[s.Name] {
		delete(w.state.Down, s.Name)
		add(alertMsg{Kind: alertOffline, Title: s.Name + " is back online", Body: s.Name + " answers again.", Server: s.Name})
	}
	w.mu.Unlock()

	c, err := a.conn(s.Name)
	if err != nil {
		return
	}
	a.checkPools(ctx, c, s.Name, al.poolPercent(), add)
	a.checkWarnings(ctx, c, s.Name, add)
}

func (a *App) checkPools(ctx context.Context, c *incusConn, server string, limit int, add func(alertMsg)) {
	b, err := c.call(ctx, "GET", "/1.0/storage-pools", "", nil)
	if err != nil {
		return
	}
	var urls []string
	_ = json.Unmarshal(b, &urls)
	// On a cluster, a local pool (dir, zfs, lvm) fills up on each member on
	// its own, so ask every member. A member that answers for a shared pool
	// gives the same numbers, which only alerts once per member.
	members := []string{""}
	if mb, err := c.call(ctx, "GET", "/1.0/cluster/members", "", nil); err == nil {
		var mu []string
		if json.Unmarshal(mb, &mu) == nil && len(mu) > 1 {
			members = members[:0]
			for _, u := range mu {
				members = append(members, nameFromURL(u))
			}
		}
	}
	for _, u := range urls {
		name := nameFromURL(u)
		for _, member := range members {
			p, key, where := "/1.0/storage-pools/"+url.PathEscape(name)+"/resources", server+"/"+name, ""
			if member != "" {
				p += "?target=" + url.QueryEscape(member)
				key += "@" + member
				where = " on " + member
			}
			rb, err := c.call(ctx, "GET", p, "", nil)
			if err != nil {
				continue
			}
			var res struct {
				Space struct {
					Used  uint64 `json:"used"`
					Total uint64 `json:"total"`
				} `json:"space"`
			}
			if json.Unmarshal(rb, &res) != nil || res.Space.Total == 0 {
				continue
			}
			pct := int(res.Space.Used * 100 / res.Space.Total)
			a.watch.mu.Lock()
			switch {
			case pct >= limit && !a.watch.state.FullPool[key]:
				a.watch.state.FullPool[key] = true
				add(alertMsg{Kind: alertPool, Title: fmt.Sprintf("Storage pool %s is %d%% full%s", name, pct, where), Body: fmt.Sprintf("%s of %s used on pool %s%s. Instances can stop working when it runs out.", bytesStr(int64(res.Space.Used)), bytesStr(int64(res.Space.Total)), name, where), Server: server, Bad: true})
			case pct < limit-5 && a.watch.state.FullPool[key]:
				// A few points below the limit, so a pool that hovers around it doesn't alert over and over.
				delete(a.watch.state.FullPool, key)
			}
			a.watch.mu.Unlock()
		}
	}
}

type incusWarning struct {
	UUID        string `json:"uuid"`
	Type        string `json:"type"`
	Status      string `json:"status"`
	Severity    string `json:"severity"`
	Project     string `json:"project"`
	LastMessage string `json:"last_message"`
}

func (a *App) checkWarnings(ctx context.Context, c *incusConn, server string, add func(alertMsg)) {
	b, err := c.call(ctx, "GET", "/1.0/warnings?recursion=1", "", nil)
	if err != nil {
		return
	}
	var list []incusWarning
	if json.Unmarshal(b, &list) != nil {
		return
	}
	a.watch.mu.Lock()
	defer a.watch.mu.Unlock()
	s := &a.watch.state
	// The first look only learns the warnings that are there already.
	first := !s.Known[server]
	s.Known[server] = true
	present := map[string]bool{}
	for _, wn := range list {
		key := server + "/" + wn.UUID
		present[key] = true
		if s.Warnings[key] || wn.Status == "resolved" {
			continue
		}
		s.Warnings[key] = true
		if first || wn.Status != "new" {
			continue
		}
		body := wn.LastMessage
		if wn.Project != "" && wn.Project != "default" {
			body += " (project " + wn.Project + ")"
		}
		add(alertMsg{Kind: alertWarning, Title: "Incus warning on " + server + ": " + wn.Type, Body: body, Server: server, Bad: true})
	}
	for k := range s.Warnings {
		if strings.HasPrefix(k, server+"/") && !present[k] {
			delete(s.Warnings, k)
		}
	}
}

func (a *App) checkUpdate(ctx context.Context, add func(alertMsg)) {
	if a.updater == nil {
		return
	}
	ch := a.updateChannel()
	rel, err := a.updater.latestRelease(ctx, ch, false)
	if err != nil || !offerUpdate(ch, rel, version) {
		return
	}
	a.watch.mu.Lock()
	defer a.watch.mu.Unlock()
	if a.watch.state.Update == rel.Tag {
		return
	}
	a.watch.state.Update = rel.Tag
	add(alertMsg{Kind: alertUpdate, Title: "Incus WebUI " + rel.Tag + " is out", Body: "You run " + version + ". Install it under Settings, Updates and about. " + rel.URL})
}

func nameFromURL(u string) string {
	u = strings.SplitN(u, "?", 2)[0]
	if i := strings.LastIndex(u, "/"); i >= 0 {
		u = u[i+1:]
	}
	n, err := url.PathUnescape(u)
	if err != nil {
		return u
	}
	return n
}

// --- HTTP ---------------------------------------------------------------------

func maskAlerts(al Alerts) Alerts {
	al.Endpoints = append([]AlertEndpoint{}, al.Endpoints...)
	for i := range al.Endpoints {
		e := &al.Endpoints[i]
		if e.Token != "" {
			e.Token = secretMask
		}
		if e.Password != "" {
			e.Password = secretMask
		}
	}
	if al.Off == nil {
		al.Off = []string{}
	}
	if al.PoolPercent == 0 {
		al.PoolPercent = 90
	}
	return al
}

// unmask puts back the saved secrets the browser only saw as a mask. A secret
// stays with its endpoint only while the address it goes to is unchanged, so
// a token can't be sent somewhere new without typing it again.
func unmask(e *AlertEndpoint, saved []AlertEndpoint) error {
	if e.Token != secretMask && e.Password != secretMask {
		return nil
	}
	var old *AlertEndpoint
	for i, o := range saved {
		if o.Type == e.Type && o.URL == e.URL && o.Host == e.Host && (old == nil || o.Name == e.Name) {
			old = &saved[i]
		}
	}
	if old == nil {
		return errors.New("the address changed, so enter the token or password again")
	}
	if e.Token == secretMask {
		e.Token = old.Token
	}
	if e.Password == secretMask {
		e.Password = old.Password
	}
	return nil
}

func (e AlertEndpoint) validate() error {
	switch e.Type {
	case "webhook", "ntfy", "discord", "slack", "gotify":
		u, err := url.Parse(e.URL)
		if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" {
			return errors.New("the address must be a URL like https://example.com/...")
		}
		if e.Type == "gotify" && e.Token == "" {
			return errors.New("Gotify needs an application token")
		}
	case "email":
		if e.Host == "" || e.Port < 1 || e.Port > 65535 {
			return errors.New("set the mail server and its port, like 587")
		}
		if !strings.Contains(e.From, "@") || len(mailList(e.To)) == 0 {
			return errors.New("set who it is from and who it goes to")
		}
		for _, x := range append(mailList(e.To), e.From) {
			if strings.ContainsAny(x, "\r\n<>") || !strings.Contains(x, "@") {
				return fmt.Errorf("%q is not an e-mail address", x)
			}
		}
	default:
		return fmt.Errorf("unknown type %q", e.Type)
	}
	return nil
}

func (a *App) handleAlertsGet(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, maskAlerts(a.store.Get().Alerts))
}

func (a *App) handleAlertsPut(w http.ResponseWriter, r *http.Request) {
	var in Alerts
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 256<<10)).Decode(&in); err != nil {
		jsonError(w, http.StatusBadRequest, "bad request")
		return
	}
	err := a.store.Update(func(c *Config) error {
		names := map[string]bool{}
		for i := range in.Endpoints {
			e := &in.Endpoints[i]
			if !backupPart.MatchString(e.Name) || names[e.Name] {
				return fmt.Errorf("endpoint name %q is empty, invalid or used twice", e.Name)
			}
			names[e.Name] = true
			if err := unmask(e, c.Alerts.Endpoints); err != nil {
				return fmt.Errorf("endpoint %s: %w", e.Name, err)
			}
			if err := e.validate(); err != nil {
				return fmt.Errorf("endpoint %s: %w", e.Name, err)
			}
		}
		for _, k := range in.Off {
			if !slices.Contains(alertKinds, k) {
				return fmt.Errorf("unknown alert %q", k)
			}
		}
		if in.PoolPercent != 0 && (in.PoolPercent < 50 || in.PoolPercent > 99) {
			return errors.New("the pool limit must be between 50 and 99%")
		}
		c.Alerts = in
		return nil
	})
	if err != nil {
		jsonError(w, http.StatusBadRequest, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleAlertsTest sends a test message to one endpoint, saved or not.
func (a *App) handleAlertsTest(w http.ResponseWriter, r *http.Request) {
	var e AlertEndpoint
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&e); err != nil {
		jsonError(w, http.StatusBadRequest, "bad request")
		return
	}
	cfg := a.store.Get()
	err := unmask(&e, cfg.Alerts.Endpoints)
	if err == nil {
		err = e.validate()
	}
	if err != nil {
		jsonError(w, http.StatusBadRequest, err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	m := alertMsg{Kind: "test", Title: "Test from Incus WebUI", Body: "Alerts reach you here. You get one when a backup fails, a server goes offline, a pool fills up, Incus raises a warning or an update is out."}
	if err := sendAlert(ctx, e, m, strings.TrimRight(cfg.PublicURL, "/")); err != nil {
		jsonError(w, http.StatusBadGateway, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
