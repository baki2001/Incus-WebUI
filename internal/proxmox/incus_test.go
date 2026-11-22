package proxmox

import (
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestIncusContainer imports a real container backup into a real Incus and
// checks it boots and gets an address. Set INCUS_WEBUI_PVE_CT to a vzdump
// container backup to run it; it needs the incus CLI and a bridge "incusbr0".
func TestIncusContainer(t *testing.T) {
	path := os.Getenv("INCUS_WEBUI_PVE_CT")
	if path == "" {
		t.Skip("INCUS_WEBUI_PVE_CT not set")
	}
	conf, err := ContainerConf(path)
	if err != nil {
		t.Fatal(err)
	}
	p := ContainerPlan(conf, Options{Network: "incusbr0", Pool: "default", KeepMAC: true})
	t.Logf("plan: %+v", p)
	if len(p.Blockers) > 0 {
		t.Fatal(p.Blockers)
	}
	img := filepath.Join(t.TempDir(), "image.tar")
	f, err := os.Create(img)
	if err != nil {
		t.Fatal(err)
	}
	if err := ContainerImage(f, path, p, Arch(conf.Get("arch"))); err != nil {
		t.Fatal(err)
	}
	f.Close()

	name := "pve-test-" + p.Name
	run := func(args ...string) string {
		t.Helper()
		out, err := exec.Command("incus", args...).CombinedOutput()
		if err != nil {
			t.Fatalf("incus %s: %v\n%s", strings.Join(args, " "), err, out)
		}
		return strings.TrimSpace(string(out))
	}
	exec.Command("incus", "delete", "-f", name).Run()
	exec.Command("incus", "image", "delete", name).Run()
	run("image", "import", img, "--alias", name)
	t.Cleanup(func() {
		exec.Command("incus", "delete", "-f", name).Run()
		exec.Command("incus", "image", "delete", name).Run()
	})
	args := []string{"init", name, name}
	for k, v := range p.Config {
		args = append(args, "-c", k+"="+v)
	}
	run(args...)
	for dev, d := range p.Devices {
		if dev == "root" {
			continue
		}
		kv := []string{"config", "device", "add", name, dev, d["type"]}
		for k, v := range d {
			if k != "type" && k != "name" {
				kv = append(kv, k+"="+v)
			}
		}
		kv = append(kv, "name="+d["name"])
		run(kv...)
	}
	run("start", name)

	deadline := time.Now().Add(2 * time.Minute)
	for {
		out := run("list", name, "-c4", "--format=csv")
		if strings.Contains(out, ".") {
			t.Logf("address: %s", out)
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("no IPv4 address after 2 minutes\n%s", run("console", name, "--show-log"))
		}
		time.Sleep(2 * time.Second)
	}
	if uid := run("exec", name, "--", "stat", "-c", "%u:%g", "/etc/passwd"); uid != "0:0" {
		t.Errorf("/etc/passwd is owned by %s inside the container, want 0:0", uid)
	}
	if exec.Command("incus", "exec", name, "--", "test", "-e", "/etc/vzdump").Run() == nil {
		t.Error("/etc/vzdump was imported")
	}
}

// TestIncusVM imports a real VM backup. Set INCUS_WEBUI_PVE_VM to a vzdump
// VMA backup. Without KVM it stops after Incus has accepted the image;
// with KVM it boots the VM and waits for an address.
func TestIncusVM(t *testing.T) {
	path := os.Getenv("INCUS_WEBUI_PVE_VM")
	if path == "" {
		t.Skip("INCUS_WEBUI_PVE_VM not set")
	}
	conf, devs, err := VMConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	p := VMPlan(conf, devs, Options{Network: "incusbr0", Pool: "default", KeepMAC: true})
	t.Logf("plan: %+v", p)
	if len(p.Blockers) > 0 {
		t.Fatal(p.Blockers)
	}
	dir := t.TempDir()
	disk, err := os.Create(filepath.Join(dir, "rootfs.img"))
	if err != nil {
		t.Fatal(err)
	}
	if err := VMDisks(path, map[string]io.WriterAt{p.BootDisk: disk}, nil); err != nil {
		t.Fatal(err)
	}
	disk.Close()
	meta, err := VMMetadata(p)
	if err != nil {
		t.Fatal(err)
	}
	metaPath := filepath.Join(dir, "meta.tar")
	os.WriteFile(metaPath, meta, 0o644)
	if out, err := exec.Command("qemu-img", "check", "-f", "qcow2", disk.Name()).CombinedOutput(); err != nil {
		t.Fatalf("qemu-img check: %v\n%s", err, out)
	}
	if raw := os.Getenv("INCUS_WEBUI_PVE_VM_RAW"); raw != "" {
		if out, err := exec.Command("qemu-img", "compare", "-f", "qcow2", "-F", "raw", disk.Name(), raw).CombinedOutput(); err != nil {
			t.Fatalf("disk differs from the source: %v\n%s", err, out)
		}
	}

	name := "pve-test-" + p.Name
	run := func(args ...string) string {
		t.Helper()
		out, err := exec.Command("incus", args...).CombinedOutput()
		if err != nil {
			t.Fatalf("incus %s: %v\n%s", strings.Join(args, " "), err, out)
		}
		return strings.TrimSpace(string(out))
	}
	exec.Command("incus", "delete", "-f", name).Run()
	exec.Command("incus", "image", "delete", name).Run()
	run("image", "import", metaPath, disk.Name(), "--alias", name)
	t.Cleanup(func() {
		exec.Command("incus", "delete", "-f", name).Run()
		exec.Command("incus", "image", "delete", name).Run()
	})
	if !strings.Contains(run("image", "list", name, "-c", "t", "--format=csv"), "VIRTUAL-MACHINE") {
		t.Fatal("Incus did not take the image as a VM image")
	}
	if _, err := os.Stat("/dev/kvm"); err != nil {
		t.Log("no KVM: the image import worked, skipping the boot")
		return
	}
	args := []string{"init", name, name, "--vm"}
	for k, v := range p.Config {
		args = append(args, "-c", k+"="+v)
	}
	run(args...)
	if sz := p.Devices["root"]["size"]; sz != "" {
		run("config", "device", "override", name, "root", "size="+sz)
	}
	run("config", "device", "override", name, "eth0", "hwaddr="+p.Devices["eth0"]["hwaddr"])
	run("start", name)
	deadline := time.Now().Add(4 * time.Minute)
	for {
		leases := run("network", "list-leases", "incusbr0", "--format=csv")
		if strings.Contains(leases, p.Devices["eth0"]["hwaddr"]) {
			t.Logf("lease: %s", leases)
			break
		}
		if time.Now().After(deadline) {
			out, _ := exec.Command("incus", "console", name, "--show-log").CombinedOutput()
			t.Fatalf("the VM got no DHCP lease within 4 minutes\n%s", out)
		}
		time.Sleep(3 * time.Second)
	}
}
