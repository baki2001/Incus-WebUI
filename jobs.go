package main

// Jobs are long tasks the backend runs on its own (backups, imports), so
// they keep going when the browser closes and show progress after a reload.
// Finished jobs, and the short actions the browser reports when they end
// (start, stop, delete...), make up the task history in <data>/tasks.json.
// History is kept for 30 days. A restart of the UI ends running jobs, and
// they come back as failed with that reason.

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

type Job struct {
	ID       string    `json:"id"`
	Kind     string    `json:"kind"` // backup | restore | import | action
	Title    string    `json:"title"`
	User     string    `json:"user"`
	Server   string    `json:"server,omitempty"`
	Project  string    `json:"project,omitempty"`
	State    string    `json:"state"` // running | done | failed | cancelled
	Progress float64   `json:"progress"`
	Detail   string    `json:"detail,omitempty"`
	Error    string    `json:"error,omitempty"`
	Link     string    `json:"link,omitempty"` // where the result is, e.g. the new instance
	Note     string    `json:"note,omitempty"` // what the user should know about the result
	Started  time.Time `json:"started"`
	Ended    time.Time `json:"ended,omitzero"`

	Owner string `json:"owner,omitempty"` // method:user, so a local and an SSO user of the same name differ
	Mine  bool   `json:"mine,omitempty"`  // set in responses only

	cancel context.CancelFunc
}

type jobs struct {
	mu   sync.Mutex
	list []*Job
	path string // empty in tests: nothing is saved
	seq  int    // bumped on every change, so an older snapshot never overwrites a newer one

	wmu     sync.Mutex // serializes file writes, which happen outside mu
	written int
}

const (
	keepFinishedJobs = 1000 // per user; scheduled jobs count as one more user
	keepJobsFor      = 30 * 24 * time.Hour
	recordsPerMinute = 120 // per user, for actions the browser reports
)

// load reads the saved history. Jobs that were running when the UI stopped
// can't resume, so they come back as failed.
func (j *jobs) load(path string) {
	j.mu.Lock()
	j.path = path
	b, err := os.ReadFile(path)
	if err != nil {
		j.mu.Unlock()
		return
	}
	var list []*Job
	if err := json.Unmarshal(b, &list); err != nil {
		// Keep the broken file for a look instead of overwriting it.
		log.Printf("task history %s is unreadable, moved aside and starting empty: %v", path, err)
		_ = os.Rename(path, path+".broken")
		j.mu.Unlock()
		return
	}
	for _, x := range list {
		if x.State == "running" {
			x.State, x.Error, x.Detail = "failed", "The UI restarted while this was running.", ""
			if x.Ended.IsZero() {
				x.Ended = time.Now()
			}
		}
	}
	j.list = list
	j.trimLocked()
	b, seq := j.snapLocked()
	j.mu.Unlock()
	j.write(b, seq)
}

// snapLocked encodes the list for saving. The caller writes it with write
// after letting go of mu, so a slow disk doesn't hold up progress updates.
func (j *jobs) snapLocked() ([]byte, int) {
	if j.path == "" {
		return nil, 0
	}
	j.seq++
	b, err := json.Marshal(j.list)
	if err != nil {
		log.Printf("task history: %v", err)
		return nil, 0
	}
	return b, j.seq
}

func (j *jobs) write(b []byte, seq int) {
	if b == nil {
		return
	}
	j.wmu.Lock()
	defer j.wmu.Unlock()
	if seq <= j.written {
		return
	}
	tmp := j.path + ".tmp"
	err := os.WriteFile(tmp, b, 0o600)
	if err == nil {
		err = os.Rename(tmp, j.path)
	}
	if err != nil {
		log.Printf("task history not saved: %v", err)
		return
	}
	j.written = seq
}

// jobResult is what a finished job leaves for the user.
type jobResult struct{ Link, Note string }

// start runs fn in the background. fn reports progress with set.
func (j *jobs) start(kind, title string, s *Session, server, project string, fn func(ctx context.Context, set func(progress float64, detail string)) (jobResult, error)) *Job {
	ctx, cancel := context.WithCancel(context.Background())
	job := &Job{ID: randHex(8), Kind: kind, Title: title, Server: server, Project: project, State: "running", Started: time.Now(), cancel: cancel}
	if s != nil {
		job.User, job.Owner = s.User, owner(s)
	}
	j.mu.Lock()
	j.list = append(j.list, job)
	j.trimLocked()
	b, seq := j.snapLocked()
	j.mu.Unlock()
	j.write(b, seq)
	go func() {
		defer cancel()
		defer func() {
			if r := recover(); r != nil {
				log.Printf("job %s (%s) panicked: %v", job.ID, title, r)
				j.finish(job, jobResult{}, fmt.Errorf("internal error: %v", r))
			}
		}()
		res, err := fn(ctx, func(p float64, d string) {
			j.mu.Lock()
			job.Progress, job.Detail = p, d
			j.mu.Unlock()
		})
		j.finish(job, res, err)
	}()
	return job
}

func (j *jobs) finish(job *Job, res jobResult, err error) {
	j.mu.Lock()
	job.Ended = time.Now()
	job.Link, job.Note, job.Detail = res.Link, res.Note, ""
	switch {
	case err == nil:
		job.State, job.Progress = "done", 1
	case err == context.Canceled:
		job.State = "cancelled"
	default:
		job.State, job.Error = "failed", err.Error()
	}
	j.trimLocked()
	b, seq := j.snapLocked()
	j.mu.Unlock()
	j.write(b, seq)
}

// record adds a finished short action that the browser ran. It says no when
// that user reported more than recordsPerMinute actions in the last minute.
func (j *jobs) record(job *Job) bool {
	j.mu.Lock()
	n, since := 0, job.Ended.Add(-time.Minute)
	for _, x := range j.list {
		if x.Kind == "action" && x.Owner == job.Owner && x.Ended.After(since) {
			n++
		}
	}
	if n >= recordsPerMinute {
		j.mu.Unlock()
		return false
	}
	j.list = append(j.list, job)
	j.trimLocked()
	b, seq := j.snapLocked()
	j.mu.Unlock()
	j.write(b, seq)
	return true
}

// trimLocked drops finished jobs older than 30 days, then each user's oldest
// finished ones beyond the cap, so one busy user can't push out the others'
// history. Running jobs always stay.
func (j *jobs) trimLocked() {
	cut := time.Now().Add(-keepJobsFor)
	kept := j.list[:0]
	for _, x := range j.list {
		if x.State == "running" || x.Ended.After(cut) {
			kept = append(kept, x)
		}
	}
	j.list = kept
	sort.SliceStable(j.list, func(a, b int) bool { return j.list[a].Started.Before(j.list[b].Started) })
	done := map[string]int{}
	for _, x := range j.list {
		if x.State != "running" {
			done[x.Owner]++
		}
	}
	kept = j.list[:0]
	for _, x := range j.list {
		if x.State != "running" && done[x.Owner] > keepFinishedJobs {
			done[x.Owner]--
			continue
		}
		kept = append(kept, x)
	}
	j.list = kept
}

func (j *jobs) snapshot() []Job {
	j.mu.Lock()
	defer j.mu.Unlock()
	out := make([]Job, 0, len(j.list))
	for _, x := range j.list {
		c := *x
		c.cancel = nil
		out = append(out, c)
	}
	sort.Slice(out, func(a, b int) bool { return out[a].Started.After(out[b].Started) })
	return out
}

// handleJobs lists the user's tasks, everyone's for an admin, newest first.
// With ?recent=N it returns only the running ones and the user's own N
// latest finished ones, which is all the top bar needs.
func (a *App) handleJobs(w http.ResponseWriter, r *http.Request) {
	s, _ := a.currentSession(r)
	admin := a.isAdmin(s)
	me := owner(s)
	recent, _ := strconv.Atoi(r.URL.Query().Get("recent"))
	out := []Job{}
	for _, x := range a.jobs.snapshot() {
		if !admin && x.Owner != me {
			continue
		}
		if r.URL.Query().Has("recent") && x.State != "running" {
			if x.Owner != me || recent <= 0 {
				continue
			}
			recent--
		}
		x.Mine, x.Owner = x.Owner == me, ""
		out = append(out, x)
	}
	writeJSON(w, out)
}

// handleJobRecord stores a short action the browser ran (start, delete...)
// once it ends, so it shows in the task history. It is the user's own note
// for their own list; the audit log stays the record of what changed.
func (a *App) handleJobRecord(w http.ResponseWriter, r *http.Request) {
	s, _ := a.currentSession(r)
	var in struct {
		Title   string `json:"title"`
		State   string `json:"state"`
		Error   string `json:"error"`
		Note    string `json:"note"`
		Server  string `json:"server"`
		Project string `json:"project"`
		Took    int64  `json:"took"` // milliseconds, measured by the browser
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10)).Decode(&in); err != nil {
		jsonError(w, http.StatusBadRequest, "Bad request.")
		return
	}
	in.Title = strings.TrimSpace(in.Title)
	if in.Title == "" || (in.State != "done" && in.State != "failed") {
		jsonError(w, http.StatusBadRequest, "A task needs a title and a state of done or failed.")
		return
	}
	// The server's clock sets both ends, so a browser with a wrong clock
	// can't skew the history.
	now := time.Now()
	took := time.Duration(min(max(in.Took, 0), 24*3600*1000)) * time.Millisecond
	job := &Job{ID: randHex(8), Kind: "action", Title: clip(in.Title, 200), State: in.State, Progress: 1, Error: clip(in.Error, 1000), Note: clip(in.Note, 200), Server: clip(in.Server, 100), Project: clip(in.Project, 100), Started: now.Add(-took), Ended: now}
	if in.State == "failed" {
		job.Progress, job.Note = 0, ""
	} else {
		job.Error = ""
	}
	if s != nil {
		job.User, job.Owner = s.User, owner(s)
	}
	if !a.jobs.record(job) {
		jsonError(w, http.StatusTooManyRequests, "Too many tasks at once.")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func clip(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n] + "…"
}

func (a *App) handleJobCancel(w http.ResponseWriter, r *http.Request) {
	s, _ := a.currentSession(r)
	id := r.PathValue("id")
	a.jobs.mu.Lock()
	defer a.jobs.mu.Unlock()
	for _, x := range a.jobs.list {
		if x.ID == id && (x.Owner == owner(s) || a.isAdmin(s)) {
			if x.State == "running" {
				x.cancel()
			}
			w.WriteHeader(http.StatusNoContent)
			return
		}
	}
	jsonError(w, http.StatusNotFound, "No such job.")
}

func owner(s *Session) string { return s.Method + ":" + s.User }
