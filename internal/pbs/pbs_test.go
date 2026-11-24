package pbs

import (
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func server(t *testing.T) (*httptest.Server, string) {
	t.Helper()
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "PBSAPIToken=root@pam!ui:s3cret" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		switch r.URL.Path {
		case "/api2/json/admin/datastore/store1/snapshots":
			if r.URL.Query().Get("ns") != "lab" {
				t.Errorf("ns = %q", r.URL.Query().Get("ns"))
			}
			io.WriteString(w, `{"data":[{"backup-type":"ct","backup-id":"110","backup-time":1732406937,"files":[{"filename":"pct.conf.blob","size":222,"crypt-mode":"none"},{"filename":"root.pxar.didx","size":3,"crypt-mode":"none"}]},{"backup-type":"vm","backup-id":"100","backup-time":1,"files":[{"filename":"qemu-server.conf.blob","crypt-mode":"encrypt"}]}]}`)
		case "/api2/json/admin/datastore/store1/download-decoded":
			q := r.URL.Query()
			if q.Get("backup-type") != "ct" || q.Get("backup-id") != "110" || q.Get("backup-time") != "1732406937" {
				t.Errorf("query %v", q)
			}
			io.WriteString(w, "file:"+q.Get("file-name"))
		default:
			w.WriteHeader(http.StatusBadRequest)
			io.WriteString(w, `{"data":null,"message":"no such path\n"}`)
		}
	}))
	t.Cleanup(srv.Close)
	sum := sha256.Sum256(srv.Certificate().Raw)
	return srv, strings.ToUpper(colonHex(sum[:]))
}

func TestClient(t *testing.T) {
	srv, fp := server(t)
	c, err := New(srv.URL, "store1", "lab", "root@pam!ui", "s3cret", fp)
	if err != nil {
		t.Fatal(err)
	}
	list, err := c.Snapshots(t.Context())
	if err != nil || len(list) != 2 {
		t.Fatalf("%v %v", list, err)
	}
	s, err := c.Snapshot(t.Context(), "ct/110/1732406937")
	if err != nil {
		t.Fatal(err)
	}
	b, err := c.ReadFile(t.Context(), s, "pct.conf.blob")
	if err != nil || string(b) != "file:pct.conf.blob" {
		t.Fatalf("%q %v", b, err)
	}
	if _, err := c.Open(t.Context(), s, "nope.blob"); err == nil {
		t.Error("missing file: no error")
	}
	if _, err := c.Open(t.Context(), list[1], "qemu-server.conf.blob"); err == nil || !strings.Contains(err.Error(), "encrypted") {
		t.Errorf("encrypted: %v", err)
	}
	if _, err := c.Snapshot(t.Context(), "ct/111/1"); err == nil {
		t.Error("unknown snapshot: no error")
	}
}

func TestClientErrors(t *testing.T) {
	srv, fp := server(t)
	c, _ := New(srv.URL, "store1", "lab", "root@pam!ui", "wrong", fp)
	if _, err := c.Snapshots(t.Context()); err == nil || !strings.Contains(err.Error(), "token") {
		t.Errorf("bad secret: %v", err)
	}
	other := sha256.Sum256([]byte("x"))
	c, _ = New(srv.URL, "store1", "lab", "root@pam!ui", "s3cret", hex.EncodeToString(other[:]))
	if _, err := c.Snapshots(t.Context()); err == nil || !strings.Contains(err.Error(), "fingerprint") {
		t.Errorf("wrong fingerprint: %v", err)
	}
	c, _ = New(srv.URL, "store1", "lab", "root@pam!ui", "s3cret", "")
	if _, err := c.Snapshots(t.Context()); err == nil {
		t.Error("self-signed certificate without a fingerprint: no error")
	}
	c, _ = New(srv.URL, "store2", "lab", "root@pam!ui", "s3cret", fp)
	if _, err := c.Snapshots(t.Context()); err == nil || !strings.Contains(err.Error(), "no such path") {
		t.Errorf("message: %v", err)
	}
	for _, bad := range [][]string{{"http://x", "s", "root@pam!ui", "x"}, {"https://x", "", "root@pam!ui", "x"}, {"https://x", "s", "root@pam", "x"}} {
		if _, err := New(bad[0], bad[1], "", bad[2], bad[3], ""); err == nil {
			t.Errorf("%v: no error", bad)
		}
	}
	if _, err := New("https://x", "s", "", "root@pam!ui", "x", "zz"); err == nil {
		t.Error("bad fingerprint: no error")
	}
}
