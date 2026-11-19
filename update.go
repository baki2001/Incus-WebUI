package main

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// Self-update: the UI checks GitHub for a newer release, downloads the binary
// for this CPU, checks it against SHA256SUMS from the same release, puts it in
// place of the running binary and restarts itself.

const releaseRepo = "baki2001/Incus-WebUI"

type releaseInfo struct {
	Tag       string    `json:"tag"`
	URL       string    `json:"url"`
	Notes     string    `json:"notes"`
	Published time.Time `json:"published"`
}

type updater struct {
	mu      sync.Mutex
	checked time.Time
	latest  *releaseInfo
	err     error
	running bool
}

var githubClient = &http.Client{Timeout: 5 * time.Minute}

func (u *updater) latestRelease(ctx context.Context, force bool) (*releaseInfo, error) {
	u.mu.Lock()
	defer u.mu.Unlock()
	if !force && time.Since(u.checked) < time.Hour && (u.latest != nil || u.err != nil) {
		return u.latest, u.err
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", "https://api.github.com/repos/"+releaseRepo+"/releases/latest", nil)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "incus-webui/"+version)
	resp, err := githubClient.Do(req)
	var rel struct {
		TagName     string    `json:"tag_name"`
		HTMLURL     string    `json:"html_url"`
		Body        string    `json:"body"`
		PublishedAt time.Time `json:"published_at"`
	}
	if err == nil {
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			err = fmt.Errorf("GitHub answered %s", resp.Status)
		} else {
			err = json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&rel)
		}
	}
	u.checked = time.Now()
	if err != nil {
		u.latest, u.err = nil, fmt.Errorf("can't check for updates: %w", err)
	} else {
		u.latest, u.err = &releaseInfo{Tag: rel.TagName, URL: rel.HTMLURL, Notes: rel.Body, Published: rel.PublishedAt}, nil
	}
	return u.latest, u.err
}

// selfPath returns the running binary and whether this process may replace it.
func selfPath() (string, string) {
	exe, err := os.Executable()
	if err != nil {
		return "", "can't find the running binary"
	}
	if p, err := filepath.EvalSymlinks(exe); err == nil {
		exe = p
	}
	if _, err := os.Stat("/.dockerenv"); err == nil {
		return exe, "This copy runs from an OCI image. Pull the new image to update."
	}
	f, err := os.CreateTemp(filepath.Dir(exe), ".update-test-*")
	if err != nil {
		return exe, fmt.Sprintf("The UI can't write to %s. Move the binary somewhere its user can write, or update it by hand.", filepath.Dir(exe))
	}
	f.Close()
	os.Remove(f.Name())
	return exe, ""
}

func (a *App) handleUpdateInfo(w http.ResponseWriter, r *http.Request) {
	_, reason := selfPath()
	out := map[string]any{"current": version, "can_update": reason == "", "reason": reason, "updating": a.updater.isRunning()}
	rel, err := a.updater.latestRelease(r.Context(), r.URL.Query().Get("refresh") == "1")
	if err != nil {
		out["error"] = err.Error()
	} else {
		out["latest"] = rel
		out["newer"] = newerVersion(rel.Tag, version)
	}
	writeJSON(w, out)
}

func (u *updater) isRunning() bool {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.running
}

func (a *App) handleUpdateApply(w http.ResponseWriter, r *http.Request) {
	exe, reason := selfPath()
	if reason != "" {
		jsonError(w, http.StatusConflict, reason)
		return
	}
	rel, err := a.updater.latestRelease(r.Context(), true)
	if err != nil {
		jsonError(w, http.StatusBadGateway, err.Error())
		return
	}
	u := a.updater
	u.mu.Lock()
	if u.running {
		u.mu.Unlock()
		jsonError(w, http.StatusConflict, "An update is already running.")
		return
	}
	u.running = true
	u.mu.Unlock()
	defer func() { u.mu.Lock(); u.running = false; u.mu.Unlock() }()

	log.Printf("Updating from %s to %s", version, rel.Tag)
	if err := installRelease(r.Context(), rel.Tag, exe); err != nil {
		log.Printf("Update failed: %v", err)
		jsonError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, map[string]string{"version": rel.Tag})
	if f, ok := w.(http.Flusher); ok {
		f.Flush()
	}
	go func() {
		time.Sleep(500 * time.Millisecond)
		log.Printf("Restarting into %s", rel.Tag)
		// Replace this process with the new binary. The PID stays the same, so
		// systemd and other supervisors keep tracking it.
		if err := syscall.Exec(exe, os.Args, os.Environ()); err != nil {
			log.Fatalf("restart failed, exiting so the service manager starts the new binary: %v", err)
		}
	}()
}

// installRelease downloads tag for this CPU, verifies it and renames it over exe.
func installRelease(ctx context.Context, tag, exe string) error {
	asset := "incus-webui-linux-" + runtime.GOARCH
	base := "https://github.com/" + releaseRepo + "/releases/download/" + tag + "/"

	sums, err := download(ctx, base+"SHA256SUMS", 1<<20)
	if err != nil {
		return fmt.Errorf("download SHA256SUMS: %w", err)
	}
	want := ""
	sc := bufio.NewScanner(strings.NewReader(string(sums)))
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) == 2 && strings.TrimPrefix(f[1], "*") == asset {
			want = strings.ToLower(f[0])
		}
	}
	if want == "" {
		return fmt.Errorf("release %s has no binary for %s", tag, runtime.GOARCH)
	}

	tmp, err := os.CreateTemp(filepath.Dir(exe), ".incus-webui-new-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	req, _ := http.NewRequestWithContext(ctx, "GET", base+asset, nil)
	req.Header.Set("User-Agent", "incus-webui/"+version)
	resp, err := githubClient.Do(req)
	if err != nil {
		tmp.Close()
		return fmt.Errorf("download %s: %w", asset, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		tmp.Close()
		return fmt.Errorf("download %s: %s", asset, resp.Status)
	}
	h := sha256.New()
	if _, err := io.Copy(io.MultiWriter(tmp, h), io.LimitReader(resp.Body, 200<<20)); err != nil {
		tmp.Close()
		return fmt.Errorf("download %s: %w", asset, err)
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	tmp.Close()
	if got := hex.EncodeToString(h.Sum(nil)); got != want {
		return errors.New("the downloaded binary doesn't match its checksum, so nothing was changed")
	}
	if err := os.Chmod(tmp.Name(), 0o755); err != nil {
		return err
	}
	// Make sure it runs on this machine before swapping it in.
	cctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if out, err := exec.CommandContext(cctx, tmp.Name(), "--version").Output(); err != nil {
		return fmt.Errorf("the new binary doesn't start: %w", err)
	} else if strings.TrimSpace(string(out)) == "" {
		return errors.New("the new binary doesn't report a version")
	}
	return os.Rename(tmp.Name(), exe)
}

func download(ctx context.Context, url string, limit int64) ([]byte, error) {
	req, _ := http.NewRequestWithContext(ctx, "GET", url, nil)
	req.Header.Set("User-Agent", "incus-webui/"+version)
	resp, err := githubClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, errors.New(resp.Status)
	}
	return io.ReadAll(io.LimitReader(resp.Body, limit))
}

// newerVersion reports whether tag a is a newer release than b. Versions look
// like v1.2.3 or v1.2.3-rc1. A build that isn't a release ("dev") is always
// older.
func newerVersion(a, b string) bool {
	pa, oka := parseVersion(a)
	pb, okb := parseVersion(b)
	if !oka {
		return false
	}
	if !okb {
		return true
	}
	for i := 0; i < 3; i++ {
		if pa.n[i] != pb.n[i] {
			return pa.n[i] > pb.n[i]
		}
	}
	// 1.2.3 is newer than 1.2.3-rc1.
	if pa.pre == "" || pb.pre == "" {
		return pa.pre == "" && pb.pre != ""
	}
	return pa.pre > pb.pre
}

type semver struct {
	n   [3]int
	pre string
}

func parseVersion(s string) (semver, bool) {
	var v semver
	s = strings.TrimPrefix(strings.TrimSpace(s), "v")
	s, v.pre, _ = strings.Cut(s, "-")
	parts := strings.Split(s, ".")
	if len(parts) < 2 || len(parts) > 3 {
		return v, false
	}
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil || n < 0 {
			return v, false
		}
		v.n[i] = n
	}
	return v, true
}
