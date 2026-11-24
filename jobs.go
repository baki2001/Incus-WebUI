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

	cancel context.CancelFunc
}

type jobs struct {
	mu   sync.Mutex
	list []*Job
	path string // empty in tests: nothing is saved
}

const (
	keepFinishedJobs = 1000
	keepJobsFor      = 30 * 24 * time.Hour
)

// load reads the saved history. Jobs that were running when the UI stopped
// can't resume, so they come back as failed.
func (j *jobs) load(path string) {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.path = path
	b, err := os.ReadFile(path)
	if err != nil {
		return
	}
	var list []*Job
	if json.Unmarshal(b, &list) != nil {
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
	j.saveLocked()
}

func (j *jobs) saveLocked() {
	if j.path == "" {
		return
	}
	b, _ := json.Marshal(j.list)
	tmp := j.path + ".tmp"
	if os.WriteFile(tmp, b, 0o600) == nil {
		_ = os.Rename(tmp, j.path)
	}
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
	j.saveLocked()
	j.mu.Unlock()
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
	defer j.mu.Unlock()
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
	j.saveLocked()
}

// record adds a finished short action that the browser ran.
func (j *jobs) record(job *Job) {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.list = append(j.list, job)
	j.trimLocked()
	j.saveLocked()
}

// trimLocked drops finished jobs older than 30 days, then the oldest
// finished ones beyond the cap. Running jobs always stay.
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
	var done int
	for _, x := range j.list {
		if x.State != "running" {
			done++
		}
	}
	for i := 0; done > keepFinishedJobs && i < len(j.list); {
		if j.list[i].State != "running" {
			j.list = append(j.list[:i], j.list[i+1:]...)
			done--
			continue
		}
		i++
	}
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

func (a *App) handleJobs(w http.ResponseWriter, r *http.Request) {
	s, _ := a.currentSession(r)
	admin := a.isAdmin(s)
	out := []Job{}
	for _, x := range a.jobs.snapshot() {
		if admin || x.Owner == owner(s) {
			x.Owner = ""
			out = append(out, x)
		}
	}
	writeJSON(w, out)
}

// handleJobRecord stores a short action the browser ran (start, delete...)
// once it ends, so it shows in the task history. It is the user's own note
// for their own list; the audit log stays the record of what changed.
func (a *App) handleJobRecord(w http.ResponseWriter, r *http.Request) {
	s, _ := a.currentSession(r)
	var in struct {
		Title   string    `json:"title"`
		State   string    `json:"state"`
		Error   string    `json:"error"`
		Note    string    `json:"note"`
		Server  string    `json:"server"`
		Project string    `json:"project"`
		Started time.Time `json:"started"`
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
	now := time.Now()
	if in.Started.IsZero() || in.Started.After(now) || now.Sub(in.Started) > 24*time.Hour {
		in.Started = now
	}
	job := &Job{ID: randHex(8), Kind: "action", Title: clip(in.Title, 200), State: in.State, Progress: 1, Error: clip(in.Error, 1000), Note: clip(in.Note, 200), Server: clip(in.Server, 100), Project: clip(in.Project, 100), Started: in.Started, Ended: now}
	if in.State == "failed" {
		job.Progress, job.Note = 0, ""
	} else {
		job.Error = ""
	}
	if s != nil {
		job.User, job.Owner = s.User, owner(s)
	}
	a.jobs.record(job)
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
