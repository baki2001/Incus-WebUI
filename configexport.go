package main

// Export of the UI's own settings, to bring an install back after the
// machine it runs on is lost: config.yaml (servers, users, roles, backup
// targets and schedules, alerts) and the client certificate the Incus
// servers trust. Optionally encrypted with a passphrase (age).

import (
	"archive/tar"
	"compress/gzip"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"filippo.io/age"
)

// exportFiles are the files in the data directory worth keeping. Metrics,
// tasks and the audit log are left out: they can be large and come back by themselves.
var exportFiles = []string{"config.yaml", "client.crt", "client.key", "server.crt", "server.key", "backup-schedules.json"}

func (a *App) handleConfigExport(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Passphrase string `json:"passphrase"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&in); err != nil {
		jsonError(w, http.StatusBadRequest, "bad request")
		return
	}
	if in.Passphrase != "" && len(in.Passphrase) < 12 {
		jsonError(w, http.StatusBadRequest, "Use a passphrase of at least 12 characters, or none.")
		return
	}
	name := "incus-webui-settings-" + time.Now().Format("20060102") + ".tar.gz"
	if in.Passphrase != "" {
		name += ".age"
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", `attachment; filename="`+name+`"`)
	w.Header().Set("Cache-Control", "no-store")
	out := io.Writer(w)
	if in.Passphrase != "" {
		rcp, err := age.NewScryptRecipient(in.Passphrase)
		if err != nil {
			jsonError(w, http.StatusBadRequest, err.Error())
			return
		}
		enc, err := age.Encrypt(w, rcp)
		if err != nil {
			jsonError(w, http.StatusInternalServerError, err.Error())
			return
		}
		defer enc.Close()
		out = enc
	}
	if err := a.writeSettingsTar(out); err != nil {
		// The headers are gone already; a cut-off file fails to unpack, which is what it should do.
		panic(http.ErrAbortHandler)
	}
}

func (a *App) writeSettingsTar(w io.Writer) error {
	gz := gzip.NewWriter(w)
	tw := tar.NewWriter(gz)
	// config.yaml is read under the store's lock, so it is never half written.
	a.store.mu.RLock()
	cfg, err := os.ReadFile(a.store.path)
	a.store.mu.RUnlock()
	if err != nil {
		return err
	}
	for _, f := range exportFiles {
		b := cfg
		if f != "config.yaml" {
			if b, err = os.ReadFile(filepath.Join(a.dataDir, f)); err != nil {
				continue
			}
		}
		if err := tw.WriteHeader(&tar.Header{Name: f, Mode: 0o600, Size: int64(len(b)), ModTime: time.Now()}); err != nil {
			return err
		}
		if _, err := tw.Write(b); err != nil {
			return err
		}
	}
	if err := tw.Close(); err != nil {
		return err
	}
	return gz.Close()
}
