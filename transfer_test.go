package main

import (
	"context"
	"os"
	"os/exec"
	"strings"
	"testing"
)

func TestTransferBody(t *testing.T) {
	inst := &instFull{
		Name: "web", Type: "container", Architecture: "x86_64", Profiles: []string{"default", "gpu"},
		Config:     map[string]string{"limits.cpu": "2", "volatile.eth0.hwaddr": "00:16:3e:00:00:01", "volatile.base_image": "abc", "volatile.idmap.current": "[]"},
		Devices:    map[string]map[string]string{"web": {"type": "proxy", "listen": "tcp:0.0.0.0:80", "connect": "tcp:127.0.0.1:80"}},
		ExpConfig:  map[string]string{"limits.cpu": "2", "nvidia.runtime": "true"},
		ExpDevices: map[string]map[string]string{"root": {"type": "disk", "path": "/", "pool": "default"}, "gpu0": {"type": "gpu"}},
	}
	b, missing := transferBody(inst, []string{"default"}, "fast", false)
	cfg := b["config"].(map[string]string)
	devs := b["devices"].(map[string]map[string]string)
	if len(missing) != 1 || missing[0] != "gpu" || len(b["profiles"].([]string)) != 1 {
		t.Errorf("profiles %v missing %v", b["profiles"], missing)
	}
	if cfg["nvidia.runtime"] != "true" || devs["gpu0"] == nil || devs["web"] == nil {
		t.Errorf("the missing profile's settings didn't come along: %v %v", cfg, devs)
	}
	if devs["root"]["pool"] != "fast" || inst.ExpDevices["root"]["pool"] != "default" {
		t.Errorf("root %v", devs["root"])
	}
	if _, ok := cfg["volatile.eth0.hwaddr"]; ok || cfg["volatile.base_image"] != "abc" || cfg["volatile.idmap.current"] != "" {
		t.Errorf("copy config %v", cfg)
	}
	b, _ = transferBody(inst, []string{"default", "gpu"}, "", true)
	cfg = b["config"].(map[string]string)
	if cfg["volatile.eth0.hwaddr"] == "" || cfg["nvidia.runtime"] != "" || b["devices"].(map[string]map[string]string)["root"] != nil {
		t.Errorf("move config %v devices %v", cfg, b["devices"])
	}
}

func TestTransferMode(t *testing.T) {
	ct := &instFull{Name: "a", Type: "container", Status: "Running"}
	if _, err := transferMode(ct, true); err == nil {
		t.Error("moved a running container")
	}
	if live, err := transferMode(ct, false); err != nil || live {
		t.Errorf("copy a running container: %v %v", live, err)
	}
	vm := &instFull{Name: "v", Type: "virtual-machine", Status: "Running", ExpConfig: map[string]string{"migration.stateful": "true"}}
	if live, err := transferMode(vm, true); err != nil || !live {
		t.Errorf("stateful VM: %v %v", live, err)
	}
	vol := &instFull{Name: "d", Status: "Stopped", ExpDevices: map[string]map[string]string{"data": {"type": "disk", "pool": "p", "source": "db", "path": "/db"}}}
	if _, err := transferMode(vol, false); err == nil || !strings.Contains(err.Error(), "db") {
		t.Errorf("custom volume: %v", err)
	}
}

// TestTransferIncus copies and then moves an instance between two "servers"
// that are the same local Incus (it needs core.https_address set), using
// image INCUS_WEBUI_TRANSFER_IMAGE.
func TestTransferIncus(t *testing.T) {
	img := os.Getenv("INCUS_WEBUI_TRANSFER_IMAGE")
	if os.Getenv("INCUS_WEBUI_INCUS") == "" || img == "" {
		t.Skip("INCUS_WEBUI_INCUS or INCUS_WEBUI_TRANSFER_IMAGE not set")
	}
	run := func(args ...string) {
		if out, err := exec.Command("incus", args...).CombinedOutput(); err != nil {
			t.Fatalf("incus %v: %s", args, out)
		}
	}
	for _, n := range []string{"tsrc", "tcopy", "tmoved"} {
		exec.Command("incus", "delete", "-f", n).Run()
		defer exec.Command("incus", "delete", "-f", n).Run()
	}
	run("init", img, "tsrc")
	a := testApp(t)
	a.backends = &Backends{transports: map[string]*backend{}}
	_ = a.store.Update(func(c *Config) error {
		c.Servers = []ServerConfig{{Name: "a", URL: "unix:///var/lib/incus/unix.socket"}, {Name: "b", URL: "unix:///var/lib/incus/unix.socket"}}
		return nil
	})
	src, _ := a.conn("a")
	dst, _ := a.conn("b")
	ctx := context.Background()
	do := func(name string, move bool) {
		inst, err := getInstance(ctx, src, "default", "tsrc")
		if err != nil {
			t.Fatal(err)
		}
		in := transferReq{Server: "a", Project: "default", Name: "tsrc", TargetServer: "b", TargetProject: "default", TargetName: name, Move: move}
		if err := a.transfer(ctx, src, dst, in, inst, false, func(float64, string) {}); err != nil {
			t.Fatal(err)
		}
		if exec.Command("incus", "info", name).Run() != nil {
			t.Fatalf("%s is missing", name)
		}
	}
	do("tcopy", false)
	if exec.Command("incus", "info", "tsrc").Run() != nil {
		t.Fatal("the copy removed the original")
	}
	do("tmoved", true)
	if exec.Command("incus", "info", "tsrc").Run() == nil {
		t.Fatal("the move kept the original")
	}
}
