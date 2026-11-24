package main

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

var version = "dev"

//go:embed all:web/dist
var webFS embed.FS

type App struct {
	store      *Store
	backends   *Backends
	loginLimit *limiter
	oidc       oidcState
	setupToken string
	updater    *updater
	dataDir    string
	audit      *auditLog
	jobs       jobs
	metrics    *metricStore
	sched      scheduler
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "add-server" {
		addServerCmd(os.Args[2:])
		return
	}
	dataDir := flag.String("data", envOr("INCUS_WEBUI_DATA", "/var/lib/incus-webui"), "directory for config.yaml and certificates")
	listen := flag.String("listen", os.Getenv("INCUS_WEBUI_LISTEN"), "listen address, overrides config (e.g. :8443)")
	showVersion := flag.Bool("version", false, "print version")
	flag.Parse()
	if *showVersion {
		fmt.Println(version)
		return
	}

	if err := os.MkdirAll(*dataDir, 0o700); err != nil {
		log.Fatal(err)
	}
	handoff(*dataDir)
	store, err := loadStore(*dataDir)
	if err != nil {
		log.Fatal(err)
	}
	clientCert, err := ensureKeyPair(filepath.Join(*dataDir, "client.crt"), filepath.Join(*dataDir, "client.key"), "incus-webui", true)
	if err != nil {
		log.Fatal(err)
	}
	app := &App{
		store:      store,
		backends:   &Backends{clientCert: clientCert, transports: map[string]*backend{}},
		loginLimit: &limiter{},
		updater:    &updater{},
		dataDir:    *dataDir,
		audit:      &auditLog{dir: filepath.Join(*dataDir, "audit")},
		metrics:    &metricStore{dir: filepath.Join(*dataDir, "metrics")},
	}
	go app.collectMetrics(context.Background())
	app.sched.load(filepath.Join(*dataDir, "backup-schedules.json"))
	app.jobs.load(filepath.Join(*dataDir, "tasks.json"))
	go app.runSchedules(context.Background())
	go app.cleanImports(context.Background())

	// Running on the Incus host itself: use the local socket automatically.
	if store.Fresh && len(store.Get().Servers) == 0 {
		for _, sock := range []string{"/var/lib/incus/unix.socket", "/run/incus/unix.socket"} {
			if _, err := os.Stat(sock); err == nil {
				host, _ := os.Hostname()
				if !serverNameRe.MatchString(host) {
					host = "local"
				}
				_ = store.Update(func(c *Config) error {
					c.Servers = append(c.Servers, ServerConfig{Name: host, URL: "unix://" + sock})
					return nil
				})
				log.Printf("Found the local Incus socket at %s and added it as server %q", sock, host)
				break
			}
		}
	}

	cfg := store.Get()
	if len(cfg.Users) == 0 && cfg.OIDC == nil {
		app.setupToken = randHex(6)
		log.Printf("First run. Open the UI and use this setup code to create your account: %s", app.setupToken)
	}

	addr := cfg.Listen
	if *listen != "" {
		addr = *listen
	}
	srv := &http.Server{
		Addr:              addr,
		Handler:           securityHeaders(app.routes()),
		ReadHeaderTimeout: 15 * time.Second,
	}
	useTLS := cfg.TLS == nil || *cfg.TLS
	log.Printf("incus-webui %s listening on %s (tls=%v, data=%s)", version, addr, useTLS, *dataDir)
	if useTLS {
		certFile, keyFile := cfg.TLSCert, cfg.TLSKey
		if certFile == "" {
			certFile, keyFile = filepath.Join(*dataDir, "server.crt"), filepath.Join(*dataDir, "server.key")
			if _, err := ensureKeyPair(certFile, keyFile, "incus-webui", false); err != nil {
				log.Fatal(err)
			}
		}
		err = srv.ListenAndServeTLS(certFile, keyFile)
	} else {
		err = srv.ListenAndServe()
	}
	if err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}

// addServerCmd lets install scripts connect a server without the browser:
//
//	incus-webui add-server [--data DIR] NAME TRUST-TOKEN
func addServerCmd(args []string) {
	fs := flag.NewFlagSet("add-server", flag.ExitOnError)
	dataDir := fs.String("data", envOr("INCUS_WEBUI_DATA", "/var/lib/incus-webui"), "data directory")
	_ = fs.Parse(args)
	if fs.NArg() != 2 {
		fmt.Fprintln(os.Stderr, "usage: incus-webui add-server [--data DIR] NAME TRUST-TOKEN")
		os.Exit(2)
	}
	name, token := fs.Arg(0), fs.Arg(1)
	if !serverNameRe.MatchString(name) {
		log.Fatal("name can use letters, numbers and dashes")
	}
	if err := os.MkdirAll(*dataDir, 0o700); err != nil {
		log.Fatal(err)
	}
	store, err := loadStore(*dataDir)
	if err != nil {
		log.Fatal(err)
	}
	cert, err := ensureKeyPair(filepath.Join(*dataDir, "client.crt"), filepath.Join(*dataDir, "client.key"), "incus-webui", true)
	if err != nil {
		log.Fatal(err)
	}
	app := &App{store: store, backends: &Backends{clientCert: cert, transports: map[string]*backend{}}}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	sc, err := app.addWithToken(ctx, name, token)
	if err != nil {
		log.Fatal(err)
	}
	err = store.Update(func(c *Config) error {
		out := c.Servers[:0]
		for _, s := range c.Servers {
			if s.Name != name {
				out = append(out, s)
			}
		}
		c.Servers = append(out, sc)
		return nil
	})
	if err != nil {
		log.Fatal(err)
	}
	fmt.Printf("Added server %q at %s\n", name, sc.URL)
}

func envOr(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}

func (a *App) routes() http.Handler {
	mux := http.NewServeMux()
	auth := func(h http.HandlerFunc) http.Handler { return a.requireAuth(a.audited(h)) }
	admin := func(h http.HandlerFunc) http.Handler { return auth(a.requireAdmin(h)) }

	mux.HandleFunc("GET /api/ui/auth", a.handleAuthInfo)
	mux.HandleFunc("POST /api/ui/login", a.handleLogin)
	mux.HandleFunc("POST /api/ui/logout", a.handleLogout)
	mux.HandleFunc("POST /api/ui/setup", a.handleSetup)
	mux.HandleFunc("GET /api/ui/oidc/login", a.handleOIDCLogin)
	mux.HandleFunc("GET /api/ui/oidc/callback", a.handleOIDCCallback)

	mux.Handle("GET /api/ui/servers", auth(a.handleServers))
	mux.Handle("POST /api/ui/servers", admin(a.handleServerAdd))
	mux.Handle("DELETE /api/ui/servers/{name}", admin(a.handleServerDelete))
	mux.Handle("GET /api/ui/client-cert", admin(a.handleClientCert))
	mux.Handle("GET /api/ui/users", admin(a.handleUsers))
	mux.Handle("POST /api/ui/users", admin(a.handleUserCreate))
	mux.Handle("PUT /api/ui/users/{name}", admin(a.handleUserPut))
	mux.Handle("DELETE /api/ui/users/{name}", admin(a.handleUserDelete))
	mux.Handle("PUT /api/ui/theme", admin(a.handleTheme))
	mux.Handle("GET /api/ui/prefs", auth(a.handlePrefsGet))
	mux.Handle("PUT /api/ui/prefs", auth(a.handlePrefsPut))
	mux.Handle("GET /api/ui/version", auth(func(w http.ResponseWriter, r *http.Request) { writeJSON(w, map[string]string{"version": version}) }))

	mux.Handle("GET /api/ui/image-servers", auth(a.handleImageServers))
	mux.Handle("GET /api/ui/remote-images", auth(a.handleRemoteImages))
	mux.Handle("GET /api/ui/update", auth(a.handleUpdateInfo))
	mux.Handle("POST /api/ui/update", admin(a.handleUpdateApply))
	mux.Handle("GET /api/ui/files/{server}/{name}", auth(a.requireRole(RoleOperator, a.handleListDir)))
	mux.Handle("DELETE /api/ui/files/{server}/{name}", auth(a.requireRole(RoleOperator, a.handleRemoveAll)))
	mux.Handle("GET /api/ui/files/{server}/{name}/download", auth(a.requireRole(RoleOperator, a.handleDownload)))
	mux.Handle("GET /api/ui/me", auth(a.handleMe))
	mux.Handle("GET /api/ui/access", admin(a.handleAccessGet))
	mux.Handle("PUT /api/ui/access", admin(a.handleAccessPut))
	mux.Handle("GET /api/ui/audit", admin(a.handleAudit))
	mux.Handle("GET /api/ui/jobs", auth(a.handleJobs))
	// Not audited: it only notes an action the audit log already has.
	mux.Handle("POST /api/ui/jobs", a.requireAuth(http.HandlerFunc(a.handleJobRecord)))
	mux.Handle("GET /api/ui/metrics/{server}", auth(a.handleMetrics))
	mux.Handle("DELETE /api/ui/jobs/{id}", auth(a.handleJobCancel))
	mux.Handle("GET /api/ui/backup-config", admin(a.handleBackupConfigGet))
	mux.Handle("PUT /api/ui/backup-config", admin(a.handleBackupConfigPut))
	mux.Handle("POST /api/ui/backup-targets/test", admin(a.handleBackupTest))
	mux.Handle("GET /api/ui/backup-targets", auth(a.handleBackupTargets))
	mux.Handle("POST /api/ui/backup-schedules/{name}/run", admin(a.handleScheduleRun))
	mux.Handle("GET /api/ui/backups/{server}", auth(a.handleBackups))
	mux.Handle("POST /api/ui/backups/{server}", auth(a.handleBackupRun))
	mux.Handle("GET /api/ui/backup/download", auth(a.handleBackupDownload))
	mux.Handle("DELETE /api/ui/backup", auth(a.handleBackupDelete))
	mux.Handle("POST /api/ui/backup/restore", auth(a.handleBackupRestore))
	mux.Handle("POST /api/ui/compose/plan", auth(a.handleComposePlan))
	mux.Handle("POST /api/ui/compose/run", auth(a.handleComposeRun))
	mux.Handle("GET /api/ui/imports", auth(a.handleImports))
	mux.Handle("POST /api/ui/imports", auth(a.handleImportUpload))
	mux.Handle("GET /api/ui/imports/{id}/plan", auth(a.handleImportPlan))
	mux.Handle("POST /api/ui/imports/{id}/run", auth(a.handleImportRun))
	mux.Handle("DELETE /api/ui/imports/{id}", auth(a.handleImportDelete))
	mux.Handle("GET /api/ui/pbs", auth(a.handlePBSList))
	mux.Handle("POST /api/ui/pbs/test", admin(a.handlePBSTest))
	mux.Handle("GET /api/ui/pbs/{name}/snapshots", auth(a.handlePBSSnapshots))
	mux.Handle("GET /api/ui/pbs/{name}/plan", auth(a.handlePBSPlan))
	mux.Handle("POST /api/ui/pbs/{name}/run", auth(a.handlePBSRun))
	a.registerTunnelRoutes(mux, func(h http.HandlerFunc) http.Handler { return admin(h) })
	mux.Handle("/api/s/{server}/{rest...}", auth(a.handleProxy))
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) { jsonError(w, http.StatusNotFound, "not found") })
	mux.Handle("/", spaHandler())
	return mux
}

var hexColor = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

func (a *App) handleTheme(w http.ResponseWriter, r *http.Request) {
	var t Theme
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024)).Decode(&t); err != nil {
		jsonError(w, http.StatusBadRequest, "bad request")
		return
	}
	if t.Name == "harbor" { // replaced by Kyoto; old browser tabs may still send it
		t.Name = "kyoto"
	}
	switch t.Name {
	case "graphite", "kyoto":
		t.Accent = ""
	case "custom":
		if !hexColor.MatchString(t.Accent) {
			jsonError(w, http.StatusBadRequest, "Accent must be a colour like #3355ff.")
			return
		}
	default:
		jsonError(w, http.StatusBadRequest, "unknown theme")
		return
	}
	if err := a.store.Update(func(c *Config) error { c.Theme = t; return nil }); err != nil {
		jsonError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, t)
}

// spaHandler serves the built React app; unknown paths get index.html.
func spaHandler() http.Handler {
	dist, _ := fs.Sub(webFS, "web/dist")
	files := http.FileServer(http.FS(dist))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
		if p != "" && !strings.HasSuffix(p, ".map") {
			if f, err := dist.Open(p); err == nil {
				st, _ := f.Stat()
				f.Close()
				if !st.IsDir() {
					if strings.HasPrefix(p, "assets/") {
						w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
					}
					files.ServeHTTP(w, r)
					return
				}
			}
		}
		index, err := fs.ReadFile(dist, "index.html")
		if err != nil {
			http.Error(w, "UI not built", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		_, _ = w.Write(index)
	})
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
		h.Set("X-Frame-Options", "DENY")
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "same-origin")
		if r.TLS != nil {
			h.Set("Strict-Transport-Security", "max-age=31536000")
		}
		next.ServeHTTP(w, r)
	})
}
