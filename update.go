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
	"regexp"
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
	Tag       string    `json:"tag"` // the version, like v0.7.0 or v0.7.0-dev.12
	URL       string    `json:"url"`
	Notes     string    `json:"notes"`
	Published time.Time `json:"published"`
	// asset is the GitHub tag the files hang under. It equals Tag, except for
	// dev builds, which all live under one release tagged "dev".
	asset string
}

// Update channels. Stable follows GitHub's latest release. Dev follows the
// rolling "dev" prerelease that CI rebuilds on every push to the dev branch.
const (
	channelStable = "stable"
	channelDev    = "dev"
)

type updater struct {
	mu      sync.Mutex
	channel string
	checked time.Time
	latest  *releaseInfo
	err     error
	running bool
}

var githubClient = &http.Client{Timeout: 5 * time.Minute}

func (u *updater) latestRelease(ctx context.Context, channel string, force bool) (*releaseInfo, error) {
	u.mu.Lock()
	defer u.mu.Unlock()
	if !force && u.channel == channel && time.Since(u.checked) < time.Hour && (u.latest != nil || u.err != nil) {
		return u.latest, u.err
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	path := "/releases/latest"
	if channel == channelDev {
		path = "/releases/tags/dev"
	}
	req, _ := http.NewRequestWithContext(ctx, "GET", "https://api.github.com/repos/"+releaseRepo+path, nil)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "incus-webui/"+version)
	resp, err := githubClient.Do(req)
	var rel struct {
		TagName     string    `json:"tag_name"`
		Name        string    `json:"name"`
		HTMLURL     string    `json:"html_url"`
		Body        string    `json:"body"`
		PublishedAt time.Time `json:"published_at"`
	}
	if err == nil {
		defer resp.Body.Close()
		switch {
		case resp.StatusCode == http.StatusNotFound && channel == channelDev:
			err = errors.New("there is no dev build yet")
		case resp.StatusCode != http.StatusOK:
			err = fmt.Errorf("GitHub answered %s", resp.Status)
		default:
			err = json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&rel)
		}
	}
	u.channel, u.checked = channel, time.Now()
	if err != nil {
		u.latest, u.err = nil, fmt.Errorf("can't check for updates: %w", err)
		return u.latest, u.err
	}
	info := &releaseInfo{Tag: rel.TagName, URL: rel.HTMLURL, Notes: rel.Body, Published: rel.PublishedAt, asset: rel.TagName}
	if channel == channelDev {
		// The dev release carries the build's version as its title.
		info.Tag = rel.Name
	}
	u.latest, u.err = info, nil
	return u.latest, u.err
}

func (a *App) updateChannel() string {
	if a.store.Get().UpdateChannel == channelDev {
		return channelDev
	}
	return channelStable
}

// offerUpdate says whether to offer rel on this channel. Both channels only
// move forward. Stable also offers the latest release when a dev build runs,
// so switching back to stable works.
func offerUpdate(channel string, rel *releaseInfo, current string) bool {
	if rel == nil || rel.Tag == "" || rel.Tag == current {
		return false
	}
	if channel == channelStable && isDevBuild(current) {
		return true
	}
	return newerVersion(rel.Tag, current)
}

// updateTarget returns where a new binary goes and whether that is possible.
// The binary is replaced in place when its folder is writable. Otherwise, as in
// the OCI image where the binary lives in a read-only /usr/local/bin, the new
// binary goes to <data>/bin, and handoff starts it on every later start.
func updateTarget(dataDir string) (string, string) {
	exe, err := os.Executable()
	if err != nil {
		return "", "can't find the running binary"
	}
	if p, err := filepath.EvalSymlinks(exe); err == nil {
		exe = p
	}
	if writable(filepath.Dir(exe)) {
		return exe, ""
	}
	dir := filepath.Join(dataDir, "bin")
	if err := os.MkdirAll(dir, 0o700); err == nil && writable(dir) {
		return filepath.Join(dir, "incus-webui"), ""
	}
	return "", fmt.Sprintf("The UI can't write to %s or to its data folder %s, so it can't update itself.", filepath.Dir(exe), dataDir)
}

func writable(dir string) bool {
	f, err := os.CreateTemp(dir, ".update-test-*")
	if err != nil {
		return false
	}
	f.Close()
	os.Remove(f.Name())
	return true
}

// handoff runs <data>/bin/incus-webui instead of this binary when an update
// put a newer version there. A newer image or package wins over an older copy.
func handoff(dataDir string) {
	if os.Getenv("INCUS_WEBUI_HANDOFF") != "" {
		return
	}
	bin := filepath.Join(dataDir, "bin", "incus-webui")
	exe, _ := os.Executable()
	if p, err := filepath.EvalSymlinks(exe); err == nil {
		exe = p
	}
	if exe == bin {
		return
	}
	if _, err := os.Stat(bin); err != nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	out, err := exec.CommandContext(ctx, bin, "--version").Output()
	cancel()
	v := strings.TrimSpace(string(out))
	if err != nil || !newerVersion(v, version) {
		return
	}
	log.Printf("Starting %s from %s, which is newer than this %s", v, bin, version)
	os.Setenv("INCUS_WEBUI_HANDOFF", "1")
	if err := syscall.Exec(bin, append([]string{bin}, os.Args[1:]...), os.Environ()); err != nil {
		log.Printf("Can't start %s, staying on %s: %v", bin, version, err)
	}
}

func (a *App) handleUpdateInfo(w http.ResponseWriter, r *http.Request) {
	_, reason := updateTarget(a.dataDir)
	ch := a.updateChannel()
	out := map[string]any{"current": version, "channel": ch, "can_update": reason == "", "reason": reason, "updating": a.updater.isRunning()}
	rel, err := a.updater.latestRelease(r.Context(), ch, r.URL.Query().Get("refresh") == "1")
	if err != nil {
		out["error"] = err.Error()
	} else {
		out["latest"] = rel
		out["newer"] = offerUpdate(ch, rel, version)
	}
	writeJSON(w, out)
}

func (a *App) handleUpdateChannel(w http.ResponseWriter, r *http.Request) {
	var req struct{ Channel string }
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024)).Decode(&req); err != nil || (req.Channel != channelStable && req.Channel != channelDev) {
		jsonError(w, http.StatusBadRequest, "The channel must be stable or dev.")
		return
	}
	err := a.store.Update(func(c *Config) error {
		c.UpdateChannel = req.Channel
		if req.Channel == channelStable {
			c.UpdateChannel = ""
		}
		return nil
	})
	if err != nil {
		jsonError(w, http.StatusInternalServerError, err.Error())
		return
	}
	a.handleUpdateInfo(w, r)
}

func (u *updater) isRunning() bool {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.running
}

func (a *App) handleUpdateApply(w http.ResponseWriter, r *http.Request) {
	exe, reason := updateTarget(a.dataDir)
	if reason != "" {
		jsonError(w, http.StatusConflict, reason)
		return
	}
	ch := a.updateChannel()
	rel, err := a.updater.latestRelease(r.Context(), ch, true)
	if err != nil {
		jsonError(w, http.StatusBadGateway, err.Error())
		return
	}
	if !offerUpdate(ch, rel, version) {
		jsonError(w, http.StatusConflict, "There is no update to install.")
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
	if err := installRelease(r.Context(), rel.asset, exe); err != nil {
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
		os.Setenv("INCUS_WEBUI_HANDOFF", "1")
		if err := syscall.Exec(exe, append([]string{exe}, os.Args[1:]...), os.Environ()); err != nil {
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
// like v1.2.3, v1.2.3-rc1 or v1.2.3-dev.12 (dev build 12, made after v1.2.3).
// A build that isn't a release ("dev") is always older.
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
	// Same numbers: rc1 < release < a build made after the release.
	if ra, rb := pa.rank(), pb.rank(); ra != rb {
		return ra > rb
	}
	if pa.rank() == 0 {
		return pa.pre > pb.pre
	}
	if da, ok := devNumber(pa.pre); ok {
		if db, ok := devNumber(pb.pre); ok {
			return da > db
		}
	}
	return false
}

// devNumber returns N for a dev build suffix "dev.N".
func devNumber(pre string) (int, bool) {
	s, ok := strings.CutPrefix(pre, "dev.")
	if !ok {
		return 0, false
	}
	n, err := strconv.Atoi(s)
	return n, err == nil && n >= 0
}

// isDevBuild reports whether v is a build of the dev branch.
func isDevBuild(v string) bool {
	p, ok := parseVersion(v)
	if !ok {
		return false
	}
	_, dev := devNumber(p.pre)
	return dev
}

type semver struct {
	n   [3]int
	pre string
}

// git describe names a build after the release as v0.3.0-21-gd22bd77[-dirty].
var describeRe = regexp.MustCompile(`^\d+-g[0-9a-f]+(-dirty)?$`)

func (v semver) rank() int {
	switch {
	case v.pre == "":
		return 1
	case describeRe.MatchString(v.pre):
		return 2
	}
	if _, ok := devNumber(v.pre); ok {
		return 2
	}
	return 0
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
