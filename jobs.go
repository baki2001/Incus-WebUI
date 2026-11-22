package main

// Jobs are long tasks the backend runs on its own (backups, imports), so
// they keep going when the browser closes and show progress after a reload.
// They live in memory: a restart of the UI ends them, and says so.

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"sort"
	"sync"
	"time"
)

type Job struct {
	ID       string    `json:"id"`
	Kind     string    `json:"kind"` // backup | restore | import
	Title    string    `json:"title"`
	User     string    `json:"user"`
	Server   string    `json:"server,omitempty"`
	Project  string    `json:"project,omitempty"`
	State    string    `json:"state"` // running | done | failed | cancelled
	Progress float64   `json:"progress"`
	Detail   string    `json:"detail,omitempty"`
	Error    string    `json:"error,omitempty"`
	Link     string    `json:"link,omitempty"` // where the result is, e.g. the new instance
	Started  time.Time `json:"started"`
	Ended    time.Time `json:"ended,omitzero"`

	cancel context.CancelFunc
}

type jobs struct {
	mu   sync.Mutex
	list []*Job
}

const keepFinishedJobs = 50

// start runs fn in the background. fn reports progress with set.
func (j *jobs) start(kind, title string, s *Session, server, project string, fn func(ctx context.Context, set func(progress float64, detail string)) (link string, err error)) *Job {
	ctx, cancel := context.WithCancel(context.Background())
	job := &Job{ID: randHex(8), Kind: kind, Title: title, Server: server, Project: project, State: "running", Started: time.Now(), cancel: cancel}
	if s != nil {
		job.User = s.User
	}
	j.mu.Lock()
	j.list = append(j.list, job)
	j.trimLocked()
	j.mu.Unlock()
	go func() {
		defer cancel()
		defer func() {
			if r := recover(); r != nil {
				log.Printf("job %s (%s) panicked: %v", job.ID, title, r)
				j.finish(job, "", fmt.Errorf("internal error: %v", r))
			}
		}()
		link, err := fn(ctx, func(p float64, d string) {
			j.mu.Lock()
			job.Progress, job.Detail = p, d
			j.mu.Unlock()
		})
		j.finish(job, link, err)
	}()
	return job
}

func (j *jobs) finish(job *Job, link string, err error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	job.Ended = time.Now()
	job.Link = link
	switch {
	case err == nil:
		job.State, job.Progress = "done", 1
	case err == context.Canceled:
		job.State = "cancelled"
	default:
		job.State, job.Error = "failed", err.Error()
	}
}

func (j *jobs) trimLocked() {
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
		if admin || x.User == s.User {
			out = append(out, x)
		}
	}
	writeJSON(w, out)
}

func (a *App) handleJobCancel(w http.ResponseWriter, r *http.Request) {
	s, _ := a.currentSession(r)
	id := r.PathValue("id")
	a.jobs.mu.Lock()
	defer a.jobs.mu.Unlock()
	for _, x := range a.jobs.list {
		if x.ID == id && (x.User == s.User || a.isAdmin(s)) {
			if x.State == "running" {
				x.cancel()
			}
			w.WriteHeader(http.StatusNoContent)
			return
		}
	}
	jsonError(w, http.StatusNotFound, "No such job.")
}
