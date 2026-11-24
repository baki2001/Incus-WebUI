package main

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestJobsSurviveRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "tasks.json")
	var a jobs
	a.load(path)
	hold := make(chan struct{})
	a.start("import", "Import web", nil, "", "", func(ctx context.Context, _ func(float64, string)) (jobResult, error) {
		<-hold
		return jobResult{}, nil
	})
	a.start("backup", "Back up db", nil, "", "", func(ctx context.Context, _ func(float64, string)) (jobResult, error) {
		return jobResult{Note: "12 MB"}, nil
	})
	waitJobs(&a, 1)

	var b jobs
	b.load(path)
	got := map[string]Job{}
	for _, x := range b.snapshot() {
		got[x.Title] = x
	}
	if x := got["Import web"]; x.State != "failed" || !strings.Contains(x.Error, "restarted") || x.Ended.IsZero() {
		t.Errorf("running job after restart = %+v, want failed with a reason", x)
	}
	if x := got["Back up db"]; x.State != "done" || x.Note != "12 MB" {
		t.Errorf("finished job after restart = %+v", x)
	}
	close(hold)
	waitJobs(&a, 0)
}

// waitJobs waits until n jobs are still running.
func waitJobs(j *jobs, n int) {
	for deadline := time.Now().Add(2 * time.Second); time.Now().Before(deadline); time.Sleep(5 * time.Millisecond) {
		running := 0
		for _, x := range j.snapshot() {
			if x.State == "running" {
				running++
			}
		}
		if running == n {
			return
		}
	}
}

func TestJobsTrim(t *testing.T) {
	var j jobs
	old := time.Now().Add(-keepJobsFor - time.Hour)
	j.list = []*Job{
		{ID: "old", State: "done", Started: old, Ended: old},
		{ID: "run", State: "running", Started: old},
		{ID: "new", State: "failed", Started: time.Now(), Ended: time.Now()},
	}
	j.trimLocked()
	var ids []string
	for _, x := range j.list {
		ids = append(ids, x.ID)
	}
	if strings.Join(ids, ",") != "run,new" {
		t.Errorf("after trim = %v, want run,new", ids)
	}

	j.list = nil
	for i := 0; i < keepFinishedJobs+5; i++ {
		ts := time.Now().Add(time.Duration(i) * time.Second)
		j.list = append(j.list, &Job{ID: string(rune('a' + i%26)), State: "done", Started: ts, Ended: ts})
	}
	j.trimLocked()
	if len(j.list) != keepFinishedJobs {
		t.Errorf("kept %d, want %d", len(j.list), keepFinishedJobs)
	}
}

func TestClip(t *testing.T) {
	if got := clip("héllo", 2); got != "h…" {
		t.Errorf("clip cut a rune in half: %q", got)
	}
	if got := clip("abc", 5); got != "abc" {
		t.Errorf("clip changed a short string: %q", got)
	}
}
