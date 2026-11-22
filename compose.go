package main

// Docker Compose import: each service becomes an Incus application (OCI)
// container. See internal/compose for the mapping.

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/baki2001/incus-webui/internal/compose"
)

type composeReq struct {
	Server     string `json:"server"`
	Project    string `json:"project"`
	NewProject bool   `json:"new_project"` // make a project named after the stack
	Compose    string `json:"compose"`
	Env        string `json:"env"`
	Stack      string `json:"stack"`
	Pool       string `json:"pool"`
	Start      bool   `json:"start"`
}

// composePlan reads the request and checks it against the server.
func (a *App) composePlan(ctx context.Context, w http.ResponseWriter, r *http.Request) (*composeReq, *compose.Plan, *incusConn, bool) {
	s, _ := a.currentSession(r)
	var q composeReq
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&q); err != nil {
		jsonError(w, http.StatusBadRequest, "bad request")
		return nil, nil, nil, false
	}
	c, err := a.conn(q.Server)
	if err != nil {
		jsonError(w, http.StatusBadRequest, err.Error())
		return nil, nil, nil, false
	}
	b, err := c.call(ctx, "GET", "/1.0", "", nil)
	if err != nil {
		jsonError(w, http.StatusBadGateway, err.Error())
		return nil, nil, nil, false
	}
	var info struct {
		Extensions  []string `json:"api_extensions"`
		Environment struct {
			Architectures []string `json:"architectures"`
		} `json:"environment"`
	}
	_ = json.Unmarshal(b, &info)
	if q.Pool == "" {
		q.Pool = "default"
	}
	p, err := compose.Parse([]byte(q.Compose), compose.ParseEnv(q.Env), compose.Options{Stack: q.Stack, Pool: q.Pool, Entrypoint: slices.Contains(info.Extensions, "instance_oci_entrypoint")})
	if err != nil {
		jsonError(w, http.StatusBadRequest, err.Error())
		return nil, nil, nil, false
	}
	if !slices.Contains(info.Extensions, "instance_oci") {
		p.Blockers = append(p.Blockers, "This Incus server can't run Docker images. That takes Incus 6.3 or newer.")
	}
	if q.NewProject {
		q.Project = p.Stack
		if !a.isAdmin(s) {
			p.Blockers = append(p.Blockers, "Only admins can make a new project. Pick an existing one.")
		} else if _, err := c.call(ctx, "GET", "/1.0/projects/"+url.PathEscape(q.Project), "", nil); err == nil {
			p.Blockers = append(p.Blockers, fmt.Sprintf("A project named %s exists already. Pick it, or give the stack another name.", q.Project))
		}
	} else {
		if q.Project == "" {
			q.Project = "default"
		}
		if roleFor(a.store.Get().Access, s, q.Server, q.Project) < RoleManager {
			jsonError(w, http.StatusForbidden, deniedMsg(RoleManager, q.Project))
			return nil, nil, nil, false
		}
		for _, svc := range p.Services {
			if _, err := c.call(ctx, "GET", "/1.0/instances/"+url.PathEscape(svc.Name), q.Project, nil); err == nil {
				p.Blockers = append(p.Blockers, fmt.Sprintf("An instance named %s exists already in project %s.", svc.Name, q.Project))
			}
		}
	}
	if !q.NewProject && len(p.Volumes) > 0 && !a.ownVolumes(ctx, s, q.Server, q.Project) {
		p.Blockers = append(p.Blockers, sharedVolumesMsg(q.Project))
	}
	arch := "amd64"
	if len(info.Environment.Architectures) > 0 {
		arch = compose.OCIArch(info.Environment.Architectures[0])
	}
	// The registry is only asked once the user may import and nothing blocks.
	for i := range p.Services {
		if len(p.Blockers) > 0 {
			break
		}
		svc := &p.Services[i]
		if svc.Command == "" {
			continue
		}
		ep, err := imageEntrypoint(ctx, svc.Server, svc.Image, arch)
		if err != nil {
			log.Printf("compose: entrypoint of %s/%s: %v", svc.Server, svc.Image, err)
			p.Warnings = append(p.Warnings, fmt.Sprintf("Service %s: the image's entrypoint couldn't be read from its registry, so its command runs without it.", svc.Service))
		}
		svc.Config["oci.entrypoint"] = compose.JoinCommand(ep, svc.Command)
	}
	return &q, p, c, true
}

func (a *App) handleComposePlan(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	q, p, _, ok := a.composePlan(ctx, w, r)
	if !ok {
		return
	}
	writeJSON(w, map[string]any{"plan": p, "project": q.Project})
}

func (a *App) handleComposeRun(w http.ResponseWriter, r *http.Request) {
	s, _ := a.currentSession(r)
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	q, p, c, ok := a.composePlan(ctx, w, r)
	if !ok {
		return
	}
	if len(p.Blockers) > 0 {
		jsonError(w, http.StatusBadRequest, strings.Join(p.Blockers, " "))
		return
	}
	job := a.jobs.start("import", "Import stack "+p.Stack, s, q.Server, q.Project, func(ctx context.Context, set func(float64, string)) (jobResult, error) {
		note, err := runCompose(ctx, c, q, p, set)
		if err != nil {
			return jobResult{}, err
		}
		return jobResult{Note: note, Link: "/instances"}, nil
	})
	writeJSON(w, map[string]string{"job": job.ID})
}

// runCompose creates the stack. On failure it removes what it made.
func runCompose(ctx context.Context, c *incusConn, q *composeReq, p *compose.Plan, set func(float64, string)) (note string, err error) {
	var undo []func(context.Context)
	defer func() {
		if err == nil {
			return
		}
		cctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
		defer cancel()
		for i := len(undo) - 1; i >= 0; i-- {
			undo[i](cctx)
		}
	}()
	if q.NewProject {
		set(0.02, "Making project "+q.Project)
		_, err := c.call(ctx, "POST", "/1.0/projects", "", map[string]any{
			"name":        q.Project,
			"description": "Docker Compose stack " + p.Stack,
			// The stack uses the default project's profiles, so it gets
			// the same network and root disk, and keeps its own volumes.
			"config": map[string]string{"features.images": "false", "features.profiles": "false", "features.storage.volumes": "true", "features.networks": "false"},
		})
		if err != nil {
			return "", fmt.Errorf("make the project: %w", err)
		}
		undo = append(undo, func(ctx context.Context) {
			_, _ = c.call(ctx, "DELETE", "/1.0/projects/"+url.PathEscape(q.Project), "", nil)
		})
	}
	var reused []string
	for _, v := range p.Volumes {
		if _, err := c.call(ctx, "GET", volPath(q.Pool, v), q.Project, nil); err == nil {
			reused = append(reused, v)
			continue
		}
		set(0.05, "Making volume "+v)
		if _, err := c.call(ctx, "POST", "/1.0/storage-pools/"+url.PathEscape(q.Pool)+"/volumes/custom", q.Project, map[string]any{"name": v, "content_type": "filesystem"}); err != nil {
			return "", fmt.Errorf("make volume %s: %w", v, err)
		}
		undo = append(undo, func(ctx context.Context) {
			_, _ = c.call(ctx, "DELETE", volPath(q.Pool, v), q.Project, nil)
		})
	}
	n := len(p.Services)
	for i, svc := range p.Services {
		set(0.1+0.6*float64(i)/float64(n), fmt.Sprintf("Pulling %s for %s", svc.Image, svc.Name))
		body := map[string]any{
			"name": svc.Name, "type": "container", "profiles": []string{"default"},
			"description": "Service " + svc.Service + " of stack " + p.Stack,
			"config":      svc.Config, "devices": svc.Devices,
			"source": map[string]string{"type": "image", "mode": "pull", "protocol": "oci", "server": svc.Server, "alias": svc.Image},
		}
		if _, err := c.call(ctx, "POST", "/1.0/instances", q.Project, body); err != nil {
			return "", fmt.Errorf("create %s: %w", svc.Name, err)
		}
		inst := "/1.0/instances/" + url.PathEscape(svc.Name)
		undo = append(undo, func(ctx context.Context) {
			_, _ = c.call(ctx, "PUT", inst+"/state", q.Project, map[string]any{"action": "stop", "force": true})
			_, _ = c.call(ctx, "DELETE", inst, q.Project, nil)
		})
	}
	if q.Start {
		for i, svc := range p.Services {
			set(0.7+0.3*float64(i)/float64(n), "Starting "+svc.Name)
			if _, err := c.call(ctx, "PUT", "/1.0/instances/"+url.PathEscape(svc.Name)+"/state", q.Project, map[string]any{"action": "start"}); err != nil {
				return "", fmt.Errorf("start %s: %w", svc.Name, err)
			}
		}
	}
	verb := "Created"
	if q.Start {
		verb = "Started"
	}
	note = fmt.Sprintf("%s %d containers in project %s.", verb, n, q.Project)
	if len(reused) > 0 {
		note += " Kept the data in the existing volumes " + strings.Join(reused, ", ") + "."
	}
	return note, nil
}

// Entrypoints are kept for an hour: the plan is asked for often.
var entrypoints sync.Map // server/image/arch -> cachedEntrypoint

type cachedEntrypoint struct {
	ep []string
	at time.Time
}

func imageEntrypoint(ctx context.Context, server, image, arch string) ([]string, error) {
	key := server + "/" + image + "/" + arch
	if v, ok := entrypoints.Load(key); ok && time.Since(v.(cachedEntrypoint).at) < time.Hour {
		return v.(cachedEntrypoint).ep, nil
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	ep, err := compose.ImageEntrypoint(ctx, server, image, arch)
	if err == nil {
		entrypoints.Store(key, cachedEntrypoint{ep, time.Now()})
	}
	return ep, err
}
