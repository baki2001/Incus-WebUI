package main

// Copy or move an instance to another Incus server connected to the UI. The
// target pulls the instance straight from the source (Incus migration in pull
// mode), so the data doesn't pass through the UI, but the target has to reach
// the source's API address. A move is a copy followed by deleting the
// original once the copy is there. It runs as a job, so it keeps going when
// the browser closes.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"maps"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"
)

type transferReq struct {
	Server        string `json:"server"`
	Project       string `json:"project"`
	Name          string `json:"name"`
	TargetServer  string `json:"target_server"`
	TargetProject string `json:"target_project"`
	TargetName    string `json:"target_name"`
	Pool          string `json:"pool"` // root disk pool on the target; empty keeps the one it has
	Move          bool   `json:"move"`
	Snapshots     bool   `json:"snapshots"`
}

type instFull struct {
	Name         string                       `json:"name"`
	Type         string                       `json:"type"`
	Status       string                       `json:"status"`
	Architecture string                       `json:"architecture"`
	Description  string                       `json:"description"`
	Ephemeral    bool                         `json:"ephemeral"`
	Profiles     []string                     `json:"profiles"`
	Config       map[string]string            `json:"config"`
	Devices      map[string]map[string]string `json:"devices"`
	ExpConfig    map[string]string            `json:"expanded_config"`
	ExpDevices   map[string]map[string]string `json:"expanded_devices"`
}

func (a *App) handleTransfer(w http.ResponseWriter, r *http.Request) {
	s, _ := a.currentSession(r)
	var in transferReq
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192)).Decode(&in); err != nil {
		jsonError(w, http.StatusBadRequest, "bad request")
		return
	}
	if in.Project == "" {
		in.Project = "default"
	}
	if in.TargetProject == "" {
		in.TargetProject = in.Project
	}
	if in.TargetName == "" {
		in.TargetName = in.Name
	}
	switch {
	case in.Server == in.TargetServer:
		jsonError(w, http.StatusBadRequest, "Pick another server. Within a server, use Copy or Move without changing the server.")
		return
	case !serverNameRe.MatchString(in.TargetName) || strings.HasSuffix(in.TargetName, "-"):
		jsonError(w, http.StatusBadRequest, "Use letters, numbers and dashes for the name.")
		return
	}
	access := a.store.Get().Access
	for _, x := range [][2]string{{in.Server, in.Project}, {in.TargetServer, in.TargetProject}} {
		if roleFor(access, s, x[0], x[1]) < RoleManager {
			jsonError(w, http.StatusForbidden, deniedMsg(RoleManager, x[1]))
			return
		}
	}
	src, err := a.conn(in.Server)
	if err != nil {
		jsonError(w, http.StatusBadRequest, err.Error())
		return
	}
	dst, err := a.conn(in.TargetServer)
	if err != nil {
		jsonError(w, http.StatusBadRequest, err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	inst, err := getInstance(ctx, src, in.Project, in.Name)
	if err != nil {
		jsonError(w, http.StatusBadGateway, err.Error())
		return
	}
	live, err := transferMode(inst, in.Move)
	if err != nil {
		jsonError(w, http.StatusBadRequest, err.Error())
		return
	}
	if _, err := dst.call(ctx, "GET", "/1.0/instances/"+url.PathEscape(in.TargetName), in.TargetProject, nil); err == nil {
		jsonError(w, http.StatusConflict, fmt.Sprintf("%s already has an instance named %s in project %s.", in.TargetServer, in.TargetName, in.TargetProject))
		return
	}
	verb := "Copy "
	if in.Move {
		verb = "Move "
	}
	title := verb + in.Name + " to " + in.TargetServer
	job := a.jobs.start("transfer", title, s, in.Server, in.Project, func(ctx context.Context, set func(float64, string)) (jobResult, error) {
		if err := a.transfer(ctx, src, dst, in, inst, live, set); err != nil {
			return jobResult{}, err
		}
		link := "/instances/" + url.PathEscape(in.TargetServer) + "/" + url.PathEscape(in.TargetName) + "?project=" + url.QueryEscape(in.TargetProject)
		return jobResult{Link: link}, nil
	})
	writeJSON(w, map[string]string{"job": job.ID})
}

func getInstance(ctx context.Context, c *incusConn, project, name string) (*instFull, error) {
	b, err := c.call(ctx, "GET", "/1.0/instances/"+url.PathEscape(name), project, nil)
	if err != nil {
		return nil, err
	}
	var in instFull
	if err := json.Unmarshal(b, &in); err != nil {
		return nil, err
	}
	return &in, nil
}

// transferMode says whether the copy runs live, or why it can't run at all.
// A running VM with migration.stateful moves live; any other instance has to
// be stopped to move. Custom volumes stay on their server, so an instance
// that uses them can't go.
func transferMode(inst *instFull, move bool) (live bool, err error) {
	if vols := attachedVolumes(inst.ExpDevices); len(vols) > 0 {
		names := []string{}
		for _, v := range vols {
			names = append(names, v.Name)
		}
		return false, fmt.Errorf("%s uses the custom volumes %s, which stay on this server. Detach them first, or back up and restore the instance on the other server.", inst.Name, strings.Join(names, ", "))
	}
	if inst.Status == "Stopped" {
		return false, nil
	}
	if inst.Type == "virtual-machine" && inst.ExpConfig["migration.stateful"] == "true" {
		return true, nil
	}
	if move || inst.Type == "virtual-machine" {
		return false, fmt.Errorf("Stop %s first. Only VMs with migration.stateful set move while they run.", inst.Name)
	}
	return false, nil
}

// transferBody is the target's create request: the instance as it is, with
// the profiles the target has. When some are missing, their devices and
// config come along as the instance's own.
func transferBody(inst *instFull, targetProfiles []string, pool string, move bool) (map[string]any, []string) {
	var profiles, missing []string
	for _, p := range inst.Profiles {
		if slices.Contains(targetProfiles, p) {
			profiles = append(profiles, p)
		} else {
			missing = append(missing, p)
		}
	}
	config := map[string]string{}
	devices := map[string]map[string]string{}
	if len(missing) > 0 {
		maps.Copy(config, inst.ExpConfig)
		for k, d := range inst.ExpDevices {
			devices[k] = maps.Clone(d)
		}
	}
	maps.Copy(config, inst.Config)
	for k, d := range inst.Devices {
		devices[k] = maps.Clone(d)
	}
	for k := range config {
		// A move keeps the MAC addresses, so DHCP leases and reservations still fit.
		keep := k == "volatile.base_image" || (move && strings.HasPrefix(k, "volatile.") && strings.HasSuffix(k, ".hwaddr"))
		if strings.HasPrefix(k, "volatile.") && !keep {
			delete(config, k)
		}
	}
	if pool != "" {
		root := devices["root"]
		if root == nil {
			root = maps.Clone(inst.ExpDevices["root"])
		}
		if root == nil {
			root = map[string]string{"type": "disk", "path": "/"}
		}
		root["pool"] = pool
		devices["root"] = root
	}
	if profiles == nil {
		profiles = []string{}
	}
	return map[string]any{
		"name": "", "type": inst.Type, "architecture": inst.Architecture, "description": inst.Description,
		"ephemeral": inst.Ephemeral, "profiles": profiles, "config": config, "devices": devices,
	}, missing
}

// sourceAddress is where the target reaches the source's API.
func (a *App) sourceAddress(ctx context.Context, c *incusConn, server string) (addr, cert string, err error) {
	b, err := c.call(ctx, "GET", "/1.0", "", nil)
	if err != nil {
		return "", "", err
	}
	var info struct {
		Environment struct {
			Addresses   []string `json:"addresses"`
			Certificate string   `json:"certificate"`
		} `json:"environment"`
	}
	_ = json.Unmarshal(b, &info)
	if sc, ok := a.server(server); ok && strings.HasPrefix(sc.URL, "https://") {
		addr = strings.TrimPrefix(sc.URL, "https://")
	} else if len(info.Environment.Addresses) > 0 {
		addr = info.Environment.Addresses[0]
	}
	if addr == "" {
		return "", "", fmt.Errorf("%s has no network address for the other server to pull from. Set core.https_address on %s first.", server, server)
	}
	return addr, info.Environment.Certificate, nil
}

func (a *App) transfer(ctx context.Context, src, dst *incusConn, in transferReq, inst *instFull, live bool, set func(float64, string)) error {
	set(0.05, "Getting ready")
	addr, cert, err := a.sourceAddress(ctx, src, in.Server)
	if err != nil {
		return err
	}
	b, err := dst.call(ctx, "GET", "/1.0/profiles", in.TargetProject, nil)
	if err != nil {
		return err
	}
	var purls []string
	_ = json.Unmarshal(b, &purls)
	var have []string
	for _, u := range purls {
		have = append(have, nameFromURL(u))
	}
	body, _ := transferBody(inst, have, in.Pool, in.Move)
	body["name"] = in.TargetName

	// The source offers the instance; the target pulls it with the secrets.
	resp, err := src.do(ctx, "POST", "/1.0/instances/"+url.PathEscape(in.Name), in.Project, jsonBody(map[string]any{"migration": true, "live": live, "instance_only": !in.Snapshots}), map[string]string{"Content-Type": "application/json"})
	if err != nil {
		return err
	}
	var r incusResp
	err = json.NewDecoder(resp.Body).Decode(&r)
	resp.Body.Close()
	if err != nil || r.Type == "error" || resp.StatusCode >= 400 {
		if r.Error == "" {
			r.Error = resp.Status
		}
		return fmt.Errorf("%s won't send the instance: %s", in.Server, r.Error)
	}
	var op struct {
		ID       string            `json:"id"`
		Metadata map[string]string `json:"metadata"`
	}
	if err := json.Unmarshal(r.Metadata, &op); err != nil || op.ID == "" {
		return errors.New("unexpected reply from Incus")
	}
	cancelSource := func() {
		cctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		_, _ = src.call(cctx, "DELETE", "/1.0/operations/"+url.PathEscape(op.ID), "", nil)
	}
	body["source"] = map[string]any{
		"type": "migration", "mode": "pull", "operation": "https://" + addr + "/1.0/operations/" + op.ID,
		"certificate": cert, "secrets": op.Metadata, "live": live, "instance_only": !in.Snapshots,
		"base-image": inst.Config["volatile.base_image"],
	}
	set(0.15, "Copying to "+in.TargetServer)
	if _, err := dst.call(ctx, "POST", "/1.0/instances", in.TargetProject, body); err != nil {
		cancelSource()
		msg := err.Error()
		if strings.Contains(msg, "connect") || strings.Contains(msg, "dial") || strings.Contains(msg, "timeout") {
			msg += ". " + in.TargetServer + " has to reach " + in.Server + " at " + addr + "."
		}
		return fmt.Errorf("copying to %s failed: %s", in.TargetServer, msg)
	}
	// The source's half ends when the target has everything.
	wctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	_, _ = src.call(wctx, "GET", "/1.0/operations/"+url.PathEscape(op.ID)+"/wait?timeout=60", "", nil)
	cancel()
	if !in.Move {
		return nil
	}
	set(0.95, "Removing the original")
	path := "/1.0/instances/" + url.PathEscape(in.Name)
	if cur, err := getInstance(ctx, src, in.Project, in.Name); err == nil && cur.Status != "Stopped" {
		// Someone started the original during the copy. What it wrote since
		// isn't in the copy, so keep it.
		if !live {
			return fmt.Errorf("the copy on %s is ready, but %s was started meanwhile, so the original was kept", in.TargetServer, in.Name)
		}
		_, _ = src.call(ctx, "PUT", path+"/state", in.Project, map[string]any{"action": "stop", "force": true})
	}
	if _, err := src.call(ctx, "DELETE", path, in.Project, nil); err != nil {
		return fmt.Errorf("the copy on %s is ready, but deleting the original failed: %w", in.TargetServer, err)
	}
	return nil
}

func jsonBody(v any) io.Reader {
	b, _ := json.Marshal(v)
	return bytes.NewReader(b)
}
