package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/baki2001/incus-webui/internal/proxmox"
)

func TestCapCPUs(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"type":"sync","status_code":200,"metadata":{"cpu":{"total":2}}}`))
	}))
	defer srv.Close()
	u, _ := url.Parse(srv.URL)
	c := &incusConn{be: &backend{base: u, transport: &http.Transport{}}}
	for _, tc := range []struct{ in, out string }{{"4", "2"}, {"2", "2"}, {"1", "1"}, {"0-1", "0-1"}} {
		p := &proxmox.Plan{Config: map[string]string{"limits.cpu": tc.in}}
		note := capCPUs(context.Background(), c, "default", p)
		if p.Config["limits.cpu"] != tc.out {
			t.Errorf("%s CPUs: got %s, want %s", tc.in, p.Config["limits.cpu"], tc.out)
		}
		if (tc.in != tc.out) != strings.Contains(note, "Incus server has 2") {
			t.Errorf("%s CPUs: note %q", tc.in, note)
		}
	}
}
