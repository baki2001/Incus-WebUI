package proxmox

import (
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// Plan is what an import will create, shown to the user before anything
// happens. Blockers stop the import; warnings are things that won't carry over.
type Plan struct {
	Type     string                       `json:"type"` // "container" or "virtual-machine"
	Name     string                       `json:"name"`
	OS       string                       `json:"os,omitempty"`
	Config   map[string]string            `json:"config"`
	Devices  map[string]map[string]string `json:"devices"`
	BootDisk string                       `json:"boot_disk,omitempty"` // VMA device name, VMs only
	DiskSize int64                        `json:"disk_size,omitempty"`
	// ExtraDisks are VMA device names of data disks (VMs). Each becomes a
	// custom block volume attached to the VM.
	ExtraDisks []ExtraDisk `json:"extra_disks,omitempty"`
	Warnings   []string    `json:"warnings"`
	Blockers   []string    `json:"blockers"`
}

type ExtraDisk struct {
	Key    string `json:"key"`    // Proxmox key, e.g. "scsi1"
	Device string `json:"device"` // VMA device name, e.g. "drive-scsi1"
	Size   int64  `json:"size"`
}

// Options are the user's choices in the import wizard.
type Options struct {
	Name    string // empty: use the Proxmox name
	Network string // Incus network for the NICs, e.g. "incusbr0"
	Pool    string // storage pool for the disks
	KeepMAC bool   // keep the MAC addresses the guest had
}

var (
	diskKey  = regexp.MustCompile(`^(scsi|virtio|sata|ide)\d+$`)
	netKey   = regexp.MustCompile(`^net\d+$`)
	nameJunk = regexp.MustCompile(`[^a-z0-9-]+`)
)

// Name makes a valid Incus instance name from a Proxmox name.
func Name(s, fallback string) string {
	s = nameJunk.ReplaceAllString(strings.ToLower(s), "-")
	s = strings.Trim(s, "-")
	if len(s) > 63 {
		s = strings.TrimRight(s[:63], "-")
	}
	if s == "" || (s[0] >= '0' && s[0] <= '9') {
		s = strings.Trim(fallback+"-"+s, "-")
	}
	return s
}

func sortedKeys(m map[string]string, re *regexp.Regexp) []string {
	var keys []string
	for k := range m {
		if re.MatchString(k) {
			keys = append(keys, k)
		}
	}
	sort.Slice(keys, func(i, j int) bool {
		// scsi2 before scsi10
		a, b := keys[i], keys[j]
		pa, pb := strings.TrimRight(a, "0123456789"), strings.TrimRight(b, "0123456789")
		if pa != pb {
			return pa < pb
		}
		na, _ := strconv.Atoi(a[len(pa):])
		nb, _ := strconv.Atoi(b[len(pb):])
		return na < nb
	})
	return keys
}

func memory(c *Conf, p *Plan) {
	if mb := c.Int("memory", 0); mb > 0 {
		p.Config["limits.memory"] = fmt.Sprintf("%dMiB", mb)
	}
}

func nics(c *Conf, p *Plan, o Options, macKey string) {
	for i, k := range sortedKeys(c.Values, netKey) {
		opts := Opts(c.Values[k])
		dev := map[string]string{"type": "nic", "network": o.Network, "name": fmt.Sprintf("eth%d", i)}
		mac := opts["hwaddr"]
		if macKey == "" {
			// VMs put the model and MAC first: "virtio=BC:24:11:..".
			for _, m := range []string{"virtio", "e1000", "e1000e", "rtl8139", "vmxnet3"} {
				if v, ok := opts[m]; ok {
					mac = v
					if m != "virtio" {
						p.Warnings = append(p.Warnings, fmt.Sprintf("%s used an %s network card. Incus gives it a virtio card, which the guest needs a driver for (Linux has one built in).", k, m))
					}
				}
			}
		}
		if o.KeepMAC && mac != "" {
			dev["hwaddr"] = strings.ToLower(mac)
		}
		if opts["tag"] != "" {
			p.Warnings = append(p.Warnings, fmt.Sprintf("%s used VLAN %s on %s. It is connected to %s without a VLAN.", k, opts["tag"], opts["bridge"], o.Network))
		}
		if ip := opts["ip"]; ip != "" && ip != "dhcp" && ip != "manual" {
			p.Warnings = append(p.Warnings, fmt.Sprintf("%s has the fixed address %s set inside the guest. If %s uses another subnet, change the guest to DHCP after the import.", k, ip, o.Network))
		}
		p.Devices[dev["name"]] = dev
	}
}

func autostart(c *Conf, p *Plan) {
	if c.Get("onboot") == "1" {
		p.Config["boot.autostart"] = "true"
	}
	if order := Opts(c.Get("startup"))["order"]; order != "" {
		p.Config["boot.autostart.priority"] = order
	}
}

// ContainerPlan maps a pct.conf onto an Incus container.
func ContainerPlan(c *Conf, o Options) *Plan {
	p := &Plan{Type: "container", Config: map[string]string{}, Devices: map[string]map[string]string{}, Warnings: []string{}, Blockers: []string{}}
	p.Name = Name(o.Name, "")
	if p.Name == "" {
		p.Name = Name(c.Get("hostname"), "ct")
	}
	p.OS = c.Get("ostype")
	if n := c.Int("cores", 0); n > 0 {
		p.Config["limits.cpu"] = strconv.Itoa(n)
	}
	memory(c, p)
	autostart(c, p)
	feat := Opts(c.Get("features"))
	if feat["nesting"] == "1" {
		p.Config["security.nesting"] = "true"
	}
	if feat["keyctl"] == "1" {
		p.Config["security.syscalls.intercept.keyctl"] = "true"
	}
	if feat["fuse"] == "1" {
		p.Warnings = append(p.Warnings, "FUSE was enabled. Add a unix-char device for /dev/fuse if the container needs it.")
	}
	if c.Get("unprivileged") != "1" {
		p.Warnings = append(p.Warnings, "This was a privileged container. It becomes an unprivileged Incus container, which is safer. Most services don't notice.")
	}
	root := map[string]string{"type": "disk", "path": "/", "pool": o.Pool}
	if sz, ok := Size(Opts(c.Get("rootfs"))["size"]); ok && sz > 0 {
		root["size"] = fmt.Sprintf("%dB", sz)
		p.DiskSize = sz
	}
	p.Devices["root"] = root
	nics(c, p, o, "hwaddr")
	for k, v := range c.Values {
		switch {
		case strings.HasPrefix(k, "mp") && k != "mp":
			mp := Opts(v)
			if mp["backup"] == "1" {
				p.Warnings = append(p.Warnings, fmt.Sprintf("Mount point %s (%s) was in the backup. Its files land in the container's root disk.", k, mp["mp"]))
			} else {
				p.Warnings = append(p.Warnings, fmt.Sprintf("Mount point %s (%s) was not in the backup, so its files are not imported.", k, mp["mp"]))
			}
		case strings.HasPrefix(k, "lxc."):
			p.Warnings = append(p.Warnings, fmt.Sprintf("Raw LXC setting %s is not carried over.", k))
		case strings.HasPrefix(k, "dev"):
			p.Warnings = append(p.Warnings, fmt.Sprintf("Device passthrough %s (%s) is not carried over.", k, v))
		}
	}
	sort.Strings(p.Warnings)
	return p
}

// VMPlan maps a qemu-server.conf onto an Incus VM. devices are the disk
// names found in the VMA archive, so a disk missing from the backup is caught.
func VMPlan(c *Conf, devices map[string]int64, o Options) *Plan {
	p := &Plan{Type: "virtual-machine", Config: map[string]string{}, Devices: map[string]map[string]string{}, Warnings: []string{}, Blockers: []string{}}
	p.Name = Name(o.Name, "")
	if p.Name == "" {
		p.Name = Name(c.Get("name"), "vm")
	}
	p.OS = c.Get("ostype")
	cpus := c.Int("cores", 1) * c.Int("sockets", 1)
	if v := c.Int("vcpus", 0); v > 0 {
		cpus = v
	}
	p.Config["limits.cpu"] = strconv.Itoa(cpus)
	memory(c, p)
	autostart(c, p)

	windows := strings.HasPrefix(p.OS, "win")
	if c.Get("bios") == "ovmf" {
		efi := Opts(c.Get("efidisk0"))
		if efi["pre-enrolled-keys"] == "1" {
			p.Config["security.secureboot"] = "true"
		} else {
			p.Config["security.secureboot"] = "false"
		}
	} else {
		// SeaBIOS guests boot through Incus's legacy BIOS mode.
		p.Config["security.csm"] = "true"
		p.Config["security.secureboot"] = "false"
	}
	if c.Get("tpmstate0") != "" {
		p.Devices["tpm"] = map[string]string{"type": "tpm"}
		p.Warnings = append(p.Warnings, "The TPM's contents are not in the backup. The VM gets a new, empty TPM, so BitLocker or other TPM-sealed keys need their recovery key.")
	}
	if windows {
		p.Warnings = append(p.Warnings, "Windows needs the virtio drivers (virtio-win) installed before it can boot from a virtio disk. Install them in Proxmox first if the VM used SATA or IDE.")
	}

	// The boot disk: the first disk in the boot order, else the first disk.
	disks := map[string]map[string]string{}
	for _, k := range sortedKeys(c.Values, diskKey) {
		d := Opts(c.Values[k])
		if d["media"] == "cdrom" || d[""] == "none" || d[""] == "" {
			continue
		}
		disks[k] = d
	}
	var order []string
	if o := Opts(c.Get("boot"))["order"]; o != "" {
		order = strings.Split(o, ";")
	} else if bd := c.Get("bootdisk"); bd != "" {
		order = []string{bd}
	}
	boot := ""
	for _, k := range order {
		if _, ok := disks[k]; ok {
			boot = k
			break
		}
	}
	if boot == "" {
		for _, k := range sortedKeys(c.Values, diskKey) {
			if _, ok := disks[k]; ok {
				boot = k
				break
			}
		}
	}
	if boot == "" {
		p.Blockers = append(p.Blockers, "The VM has no disk.")
		return p
	}
	for _, k := range sortedKeys(c.Values, diskKey) {
		if _, ok := disks[k]; !ok {
			continue
		}
		dev := "drive-" + k
		size, inBackup := devices[dev]
		if !inBackup {
			if k == boot {
				p.Blockers = append(p.Blockers, fmt.Sprintf("The boot disk %s is not in the backup (it was excluded with backup=0).", k))
			} else {
				p.Warnings = append(p.Warnings, fmt.Sprintf("Disk %s was excluded from the backup, so it is not imported.", k))
			}
			continue
		}
		if k == boot {
			p.BootDisk = dev
			p.DiskSize = size
			root := map[string]string{"type": "disk", "path": "/", "pool": o.Pool, "size": fmt.Sprintf("%dB", size)}
			if strings.HasPrefix(k, "virtio") {
				// The guest knew this disk as /dev/vda. Incus can attach it the same way.
				root["io.bus"] = "virtio-blk"
			}
			p.Devices["root"] = root
			if (strings.HasPrefix(k, "sata") || strings.HasPrefix(k, "ide")) && !windows {
				p.Warnings = append(p.Warnings, fmt.Sprintf("The boot disk was on %s. Incus attaches it as virtio-scsi, which Linux supports, but check that /etc/fstab uses UUIDs or labels.", strings.TrimRight(k, "0123456789")))
			}
			continue
		}
		p.ExtraDisks = append(p.ExtraDisks, ExtraDisk{Key: k, Device: dev, Size: size})
	}
	nics(c, p, o, "")
	for k := range c.Values {
		switch {
		case strings.HasPrefix(k, "hostpci"):
			p.Warnings = append(p.Warnings, fmt.Sprintf("PCI passthrough %s is not carried over. Add it as a gpu or pci device after the import.", k))
		case strings.HasPrefix(k, "usb"):
			p.Warnings = append(p.Warnings, fmt.Sprintf("USB passthrough %s is not carried over.", k))
		case k == "args":
			p.Warnings = append(p.Warnings, "Extra QEMU arguments (args) are not carried over.")
		}
	}
	sort.Strings(p.Warnings)
	return p
}
