package main

// The audit log: every change made through the UI, every sign-in and every
// failed sign-in, one JSON line each, in <data>/audit/YYYY-MM.jsonl. Files
// older than 12 months are removed. Bodies are never logged, since they can
// hold passwords and keys.

import (
	"bufio"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

type AuditEntry struct {
	Time    time.Time `json:"time"`
	User    string    `json:"user"`
	Method  string    `json:"method,omitempty"` // password | oidc
	IP      string    `json:"ip"`
	Action  string    `json:"action"` // "POST /1.0/instances/web/state" or "login"
	Server  string    `json:"server,omitempty"`
	Project string    `json:"project,omitempty"`
	Status  int       `json:"status"`
}

type auditLog struct {
	mu  sync.Mutex
	dir string
}

const auditKeepMonths = 12

func (l *auditLog) add(e AuditEntry) {
	if l == nil || l.dir == "" {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := os.MkdirAll(l.dir, 0o700); err != nil {
		return
	}
	name := filepath.Join(l.dir, e.Time.UTC().Format("2006-01")+".jsonl")
	f, err := os.OpenFile(name, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	defer f.Close()
	b, _ := json.Marshal(e)
	_, _ = f.Write(append(b, '\n'))
	l.prune(e.Time)
}

var auditFile = regexp.MustCompile(`^\d{4}-\d{2}\.jsonl$`)

func (l *auditLog) prune(now time.Time) {
	cut := now.UTC().AddDate(0, -auditKeepMonths, 0).Format("2006-01")
	files, _ := os.ReadDir(l.dir)
	for _, f := range files {
		if auditFile.MatchString(f.Name()) && f.Name()[:7] < cut {
			_ = os.Remove(filepath.Join(l.dir, f.Name()))
		}
	}
}

// months lists the months that have entries, newest first.
func (l *auditLog) months() []string {
	files, _ := os.ReadDir(l.dir)
	var out []string
	for _, f := range files {
		if auditFile.MatchString(f.Name()) {
			out = append(out, f.Name()[:7])
		}
	}
	sort.Sort(sort.Reverse(sort.StringSlice(out)))
	return out
}

func (l *auditLog) read(month string) []AuditEntry {
	out := []AuditEntry{}
	if !regexp.MustCompile(`^\d{4}-\d{2}$`).MatchString(month) {
		return out
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	f, err := os.Open(filepath.Join(l.dir, month+".jsonl"))
	if err != nil {
		return out
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64*1024), 1<<20)
	for sc.Scan() {
		var e AuditEntry
		if json.Unmarshal(sc.Bytes(), &e) == nil {
			out = append(out, e)
		}
	}
	// Newest first.
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	return out
}

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (s *statusWriter) WriteHeader(code int) {
	if s.status == 0 {
		s.status = code
	}
	s.ResponseWriter.WriteHeader(code)
}

func (s *statusWriter) Write(b []byte) (int, error) {
	if s.status == 0 {
		s.status = http.StatusOK
	}
	return s.ResponseWriter.Write(b)
}

func (s *statusWriter) Flush() {
	if f, ok := s.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// Unwrap lets http.ResponseController reach the connection (websockets).
func (s *statusWriter) Unwrap() http.ResponseWriter { return s.ResponseWriter }

// audited logs every request that changes something.
func (a *App) audited(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet || r.Method == http.MethodHead {
			next(w, r)
			return
		}
		sw := &statusWriter{ResponseWriter: w}
		start := time.Now()
		next(sw, r)
		e := AuditEntry{Time: start, IP: a.clientIP(r), Status: sw.status}
		if s, ok := a.currentSession(r); ok {
			e.User, e.Method = s.User, s.Method
		}
		path := r.URL.Path
		if rest, ok := strings.CutPrefix(path, "/api/s/"); ok {
			server, p, _ := strings.Cut(rest, "/")
			e.Server, path = server, "/"+p
			e.Project = r.URL.Query().Get("project")
			if e.Project == "" && strings.HasPrefix(path, "/1.0/") {
				e.Project = "default"
			}
		} else if s := r.PathValue("server"); s != "" {
			e.Server = s
			e.Project = r.URL.Query().Get("project")
		}
		e.Action = r.Method + " " + path
		a.audit.add(e)
	}
}

func (a *App) auditLogin(r *http.Request, user, method string, ok bool) {
	e := AuditEntry{Time: time.Now(), User: user, Method: method, IP: a.clientIP(r), Action: "login", Status: http.StatusOK}
	if !ok {
		e.Action, e.Status = "login failed", http.StatusUnauthorized
	}
	a.audit.add(e)
}

func (a *App) handleAudit(w http.ResponseWriter, r *http.Request) {
	month := r.URL.Query().Get("month")
	months := a.audit.months()
	if month == "" {
		month = time.Now().UTC().Format("2006-01")
	}
	writeJSON(w, map[string]any{"month": month, "months": months, "entries": a.audit.read(month)})
}
