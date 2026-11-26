package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
)

func TestAlertFormats(t *testing.T) {
	var got struct {
		path string
		hdr  http.Header
		body string
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		got.path, got.hdr, got.body = r.URL.Path, r.Header, string(b)
	}))
	defer srv.Close()
	m := alertMsg{Kind: alertBackup, Title: "Backup nightly failed", Body: "web: disk full", Server: "atlas", Bad: true}
	for _, c := range []struct {
		e    AlertEndpoint
		want []string
	}{
		{AlertEndpoint{Type: "webhook", URL: srv.URL + "/hook"}, []string{`"kind":"backup"`, `"title":"Backup nightly failed"`, `"server":"atlas"`, `"problem":true`}},
		{AlertEndpoint{Type: "discord", URL: srv.URL}, []string{`"content":"**Backup nightly failed**\nweb: disk full\n\nServer: atlas`}},
		{AlertEndpoint{Type: "slack", URL: srv.URL}, []string{`"text":"*Backup nightly failed*`}},
		{AlertEndpoint{Type: "gotify", URL: srv.URL + "/", Token: "tok"}, []string{`"priority":8`, `"title":"Backup nightly failed"`}},
		{AlertEndpoint{Type: "ntfy", URL: srv.URL + "/incus", Token: "tk"}, []string{"web: disk full"}},
	} {
		if err := sendAlert(context.Background(), c.e, m, "https://ui.lan"); err != nil {
			t.Fatalf("%s: %v", c.e.Type, err)
		}
		for _, w := range c.want {
			if !strings.Contains(got.body, w) {
				t.Errorf("%s: %s lacks %s", c.e.Type, got.body, w)
			}
		}
		switch c.e.Type {
		case "gotify":
			if got.path != "/message" || got.hdr.Get("X-Gotify-Key") != "tok" {
				t.Errorf("gotify %s %v", got.path, got.hdr)
			}
		case "ntfy":
			if got.hdr.Get("Title") != m.Title || got.hdr.Get("Priority") != "high" || got.hdr.Get("Authorization") != "Bearer tk" || got.hdr.Get("Click") != "https://ui.lan" {
				t.Errorf("ntfy headers %v", got.hdr)
			}
		}
	}
	fail := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Error(w, "bad token", 401) }))
	defer fail.Close()
	if err := sendAlert(context.Background(), AlertEndpoint{Type: "webhook", URL: fail.URL}, m, ""); err == nil || !strings.Contains(err.Error(), "bad token") {
		t.Errorf("error = %v", err)
	}
}

func TestAlertsConfig(t *testing.T) {
	a := testApp(t, "admin")
	put := func(body string) int {
		w := httptest.NewRecorder()
		a.handleAlertsPut(w, httptest.NewRequest("PUT", "/", strings.NewReader(body)))
		return w.Code
	}
	if c := put(`{"endpoints":[{"name":"phone","type":"ntfy","url":"https://ntfy.sh/x","token":"secret"},{"name":"mail","type":"email","host":"smtp.lan","port":587,"from":"ui@lan","to":"me@lan, you@lan","password":"pw"}],"off":["update"],"pool_percent":85}`); c != 204 {
		t.Fatalf("put %d", c)
	}
	w := httptest.NewRecorder()
	a.handleAlertsGet(w, httptest.NewRequest("GET", "/", nil))
	if strings.Contains(w.Body.String(), "secret") || strings.Contains(w.Body.String(), `"pw"`) {
		t.Fatalf("secrets sent back: %s", w.Body.String())
	}
	var al Alerts
	_ = json.Unmarshal(w.Body.Bytes(), &al)
	// Saving the masked config keeps the secrets.
	b, _ := json.Marshal(al)
	if c := put(string(b)); c != 204 {
		t.Fatalf("put masked %d", c)
	}
	saved := a.store.Get().Alerts
	if saved.Endpoints[0].Token != "secret" || saved.Endpoints[1].Password != "pw" || saved.on(alertUpdate) || !saved.on(alertPool) || saved.poolPercent() != 85 {
		t.Errorf("saved %+v", saved)
	}
	// A new address doesn't get the old secret; the save is refused instead.
	moved := al
	moved.Endpoints = slices.Clone(al.Endpoints)
	moved.Endpoints[0].URL = "https://evil.example/x"
	b, _ = json.Marshal(moved)
	if c := put(string(b)); c != 400 || a.store.Get().Alerts.Endpoints[0].Token != "secret" {
		t.Errorf("moved endpoint: %d, token %q", c, a.store.Get().Alerts.Endpoints[0].Token)
	}
	// A new name at the same address keeps it.
	al.Endpoints[0].Name = "renamed"
	b, _ = json.Marshal(al)
	if c := put(string(b)); c != 204 || a.store.Get().Alerts.Endpoints[0].Token != "secret" {
		t.Errorf("renamed endpoint: %d, token %q", c, a.store.Get().Alerts.Endpoints[0].Token)
	}
	for _, bad := range []string{
		`{"endpoints":[{"name":"x","type":"webhook","url":"ftp://x"}]}`,
		`{"endpoints":[{"name":"x","type":"gotify","url":"https://g.lan"}]}`,
		`{"endpoints":[{"name":"x","type":"email","host":"h","port":25,"from":"a@b","to":"c@d\r\nBcc: e@f"}]}`,
		`{"endpoints":[{"name":"x","type":"pager","url":"https://x"}]}`,
		`{"off":["everything"]}`,
		`{"pool_percent":20}`,
	} {
		if c := put(bad); c != 400 {
			t.Errorf("%s: %d", bad, c)
		}
	}
}

func TestAlertChecksOnce(t *testing.T) {
	a := testApp(t)
	a.watch.load("")
	var msgs []alertMsg
	add := func(m alertMsg) { msgs = append(msgs, m) }
	// A server that never answers alerts once, after two checks.
	s := ServerConfig{Name: "gone", URL: "https://127.0.0.1:1"}
	a.backends = &Backends{transports: map[string]*backend{}}
	for i := 0; i < 4; i++ {
		a.checkServer(context.Background(), s, Alerts{}, add)
	}
	if len(msgs) != 1 || msgs[0].Kind != alertOffline || !msgs[0].Bad {
		t.Fatalf("offline alerts %+v", msgs)
	}
}
