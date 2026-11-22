// Package compose turns a Docker Compose file into Incus application
// containers: each service becomes an OCI container, ports become proxy
// devices, named volumes become custom volumes. What doesn't map is reported
// as a warning or a blocker.
package compose

import (
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

type Options struct {
	Stack string // name for the stack, used for volume names
	Pool  string // storage pool for named volumes
	// Entrypoint is true when the server can override the image's
	// entrypoint, command, user and working directory (instance_oci_entrypoint).
	Entrypoint bool
}

type Plan struct {
	Stack    string    `json:"stack"`
	Services []Service `json:"services"` // in start order
	Volumes  []string  `json:"volumes"`  // custom volumes to create
	Warnings []string  `json:"warnings"`
	Blockers []string  `json:"blockers"`
}

type Service struct {
	Service   string                       `json:"service"` // name in the compose file
	Name      string                       `json:"name"`    // instance name
	Server    string                       `json:"server"`  // OCI registry, e.g. https://docker.io
	Image     string                       `json:"image"`   // e.g. library/nginx:latest
	Config    map[string]string            `json:"config"`
	Devices   map[string]map[string]string `json:"devices"`
	DependsOn []string                     `json:"depends_on,omitempty"`
	// Command is a command line that goes after the image's own entrypoint
	// in oci.entrypoint. The caller looks that entrypoint up.
	Command string `json:"command,omitempty"`
}

var (
	instName = regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9-]{0,62}$`)
	envKey   = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
	varRef   = regexp.MustCompile(`\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-?])([^}]*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)`)
)

// Name makes an Incus name: letters, digits and dashes, starting with a letter.
func Name(s string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(s) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
		case r == '-' || r == '_' || r == '.':
			b.WriteRune('-')
		}
	}
	n := strings.Trim(b.String(), "-")
	if n != "" && (n[0] < 'a' || n[0] > 'z') {
		n = "s-" + n
	}
	if len(n) > 63 {
		n = strings.TrimRight(n[:63], "-")
	}
	return n
}

// ParseEnv reads a .env file: KEY=value lines, # comments, optional quotes.
func ParseEnv(s string) map[string]string {
	out := map[string]string{}
	for _, ln := range strings.Split(s, "\n") {
		ln = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(ln), "export "))
		if ln == "" || strings.HasPrefix(ln, "#") {
			continue
		}
		k, v, ok := strings.Cut(ln, "=")
		if !ok {
			continue
		}
		v = strings.TrimSpace(v)
		if len(v) >= 2 && (v[0] == '"' || v[0] == '\'') && v[len(v)-1] == v[0] {
			v = v[1 : len(v)-1]
		}
		out[strings.TrimSpace(k)] = v
	}
	return out
}

// interpolate replaces ${VAR}, ${VAR:-default}, ${VAR-default}, ${VAR:?err}
// and $VAR in every string of the document, like docker compose does.
func interpolate(n *yaml.Node, env map[string]string, missing map[string]bool) {
	if n.Kind == yaml.ScalarNode && n.Tag != "!!binary" {
		n.Value = varRef.ReplaceAllStringFunc(n.Value, func(m string) string {
			if m == "$$" {
				return "$"
			}
			g := varRef.FindStringSubmatch(m)
			name := g[1]
			if name == "" {
				name = g[4]
			}
			v, set := env[name]
			switch g[2] {
			case ":-":
				if v == "" {
					return g[3]
				}
			case "-":
				if !set {
					return g[3]
				}
			}
			if !set {
				missing[name] = true
			}
			return v
		})
		return
	}
	for _, c := range n.Content {
		interpolate(c, env, missing)
	}
}

// Parse reads a compose file and plans the import.
func Parse(src []byte, env map[string]string, o Options) (*Plan, error) {
	var doc yaml.Node
	if err := yaml.Unmarshal(src, &doc); err != nil {
		return nil, fmt.Errorf("the compose file is not valid YAML: %w", err)
	}
	missing := map[string]bool{}
	interpolate(&doc, env, missing)
	var f struct {
		Name     string                    `yaml:"name"`
		Services map[string]map[string]any `yaml:"services"`
		Volumes  map[string]any            `yaml:"volumes"`
	}
	if err := doc.Decode(&f); err != nil {
		return nil, fmt.Errorf("the compose file has an unexpected shape: %w", err)
	}
	if len(f.Services) == 0 {
		return nil, errors.New("the compose file has no services")
	}
	p := &Plan{Stack: Name(o.Stack), Warnings: []string{}, Blockers: []string{}, Volumes: []string{}}
	if p.Stack == "" {
		p.Stack = Name(f.Name)
	}
	if p.Stack == "" {
		p.Stack = "stack"
	}
	for _, k := range sortedKeys(missing) {
		p.Warnings = append(p.Warnings, fmt.Sprintf("$%s is not set, so it became empty. Add it under environment variables.", k))
	}
	for name, v := range f.Volumes {
		if m, ok := v.(map[string]any); ok && (m["external"] == true || m["driver"] != nil && m["driver"] != "local") {
			p.Warnings = append(p.Warnings, fmt.Sprintf("Volume %s is external or uses a driver. It becomes an empty Incus volume.", name))
		}
	}

	names := map[string]string{} // service -> instance
	for _, svc := range sortedKeys(f.Services) {
		s := f.Services[svc]
		n := Name(svc)
		if cn, ok := s["container_name"].(string); ok && cn != "" {
			n = Name(cn)
		}
		if !instName.MatchString(n) {
			p.Blockers = append(p.Blockers, fmt.Sprintf("Service %q has no usable name.", svc))
			continue
		}
		names[svc] = n
	}
	vols := map[string]bool{}
	for _, svc := range sortedKeys(f.Services) {
		if names[svc] == "" {
			continue
		}
		s, err := service(svc, names[svc], f.Services[svc], o, p, vols, names)
		if err != nil {
			p.Blockers = append(p.Blockers, err.Error())
			continue
		}
		if names[svc] != svc {
			p.Warnings = append(p.Warnings, fmt.Sprintf("Service %s is called %s in Incus. Other services that use the name %s to reach it need the new name.", svc, names[svc], svc))
		}
		p.Services = append(p.Services, *s)
	}
	for v := range vols {
		p.Volumes = append(p.Volumes, v)
	}
	sort.Strings(p.Volumes)
	if err := order(p); err != nil {
		p.Blockers = append(p.Blockers, err.Error())
	}
	// Services that start first get a higher autostart priority.
	for i := range p.Services {
		p.Services[i].Config["boot.autostart.priority"] = strconv.Itoa(len(p.Services) - i)
	}
	sort.Strings(p.Warnings)
	return p, nil
}

// ImageRef splits an image reference into registry URL and path:tag.
func ImageRef(ref string) (server, image string, err error) {
	ref = strings.TrimSpace(ref)
	if ref == "" || strings.ContainsAny(ref, " \t\n") {
		return "", "", errors.New("no image")
	}
	host := "docker.io"
	first, rest, ok := strings.Cut(ref, "/")
	if ok && (strings.ContainsAny(first, ".:") || first == "localhost") {
		host, ref = first, rest
	}
	if host == "docker.io" || host == "index.docker.io" || host == "registry-1.docker.io" {
		host = "docker.io"
		if !strings.Contains(ref, "/") {
			ref = "library/" + ref
		}
	}
	if !strings.Contains(ref[strings.LastIndex(ref, "/")+1:], ":") && !strings.Contains(ref, "@") {
		ref += ":latest"
	}
	return "https://" + host, ref, nil
}

func service(svc, name string, s map[string]any, o Options, p *Plan, vols map[string]bool, names map[string]string) (*Service, error) {
	out := &Service{Service: svc, Name: name, Config: map[string]string{}, Devices: map[string]map[string]string{}}
	if _, ok := s["build"]; ok && s["image"] == nil {
		return nil, fmt.Errorf("Service %s is built from a Dockerfile. Build and push the image to a registry, then set image: in the compose file.", svc)
	}
	img, _ := s["image"].(string)
	var err error
	if out.Server, out.Image, err = ImageRef(img); err != nil {
		return nil, fmt.Errorf("Service %s has no image.", svc)
	}
	if _, ok := s["build"]; ok {
		p.Warnings = append(p.Warnings, fmt.Sprintf("Service %s has a build section. The image %s is pulled instead.", svc, img))
	}
	warn := func(f string, a ...any) { p.Warnings = append(p.Warnings, fmt.Sprintf(f, a...)) }

	// environment: a list of KEY=value or a map.
	env := map[string]string{}
	switch e := s["environment"].(type) {
	case []any:
		for _, x := range e {
			k, v, _ := strings.Cut(fmt.Sprint(x), "=")
			env[k] = v
		}
	case map[string]any:
		for k, v := range e {
			if v == nil {
				env[k] = ""
			} else {
				env[k] = scalar(v)
			}
		}
	}
	for k, v := range env {
		if !envKey.MatchString(k) {
			warn("Service %s: environment variable %q has an invalid name and is skipped.", svc, k)
			continue
		}
		out.Config["environment."+k] = v
	}
	if _, ok := s["env_file"]; ok {
		warn("Service %s reads an env_file. Its variables are not in the compose file: add them to the service's environment after the import.", svc)
	}

	// Incus has one key for the whole command line, oci.entrypoint. An
	// entrypoint in the file replaces the image's entrypoint and command, as
	// in Docker. A command alone keeps the image's entrypoint, which only the
	// registry knows: the caller fills it in (see Service.Command).
	line := func(field string) (string, bool) {
		switch x := s[field].(type) {
		case string:
			return x, true
		case []any:
			parts := make([]string, len(x))
			for i, a := range x {
				parts[i] = shellQuote(fmt.Sprint(a))
			}
			return strings.Join(parts, " "), true
		}
		return "", false
	}
	ep, hasEP := line("entrypoint")
	cm, hasCmd := line("command")
	switch {
	case (hasEP || hasCmd) && !o.Entrypoint:
		warn("Service %s sets its command or entrypoint, which this Incus server can't override. The image's default is used. Incus 6.13 or newer can.", svc)
	case hasEP:
		out.Config["oci.entrypoint"] = strings.TrimSpace(ep + " " + cm)
	case hasCmd:
		out.Command = cm
	}
	if wd, ok := s["working_dir"].(string); ok && wd != "" {
		if o.Entrypoint {
			out.Config["oci.cwd"] = wd
		} else {
			warn("Service %s sets working_dir, which this Incus server can't override.", svc)
		}
	}
	if u, ok := s["user"]; ok {
		uid, gid, _ := strings.Cut(scalar(u), ":")
		if _, err := strconv.Atoi(uid); err != nil || !o.Entrypoint {
			warn("Service %s runs as user %v, which is not carried over. Only numeric IDs on Incus 6.13 or newer are.", svc, u)
		} else {
			out.Config["oci.uid"] = uid
			if gid != "" {
				out.Config["oci.gid"] = gid
			}
		}
	}

	switch r, _ := s["restart"].(string); r {
	case "always", "unless-stopped":
		out.Config["boot.autostart"] = "true"
	case "on-failure":
		out.Config["boot.autostart"] = "true"
		warn("Service %s restarts on failure in Docker. Incus starts it at boot but doesn't restart it when it exits.", svc)
	case "", "no":
		out.Config["boot.autostart"] = "false"
	}

	// Limits: deploy.resources.limits, or the old cpus and mem_limit keys.
	cpus, mem := scalar(s["cpus"]), scalar(s["mem_limit"])
	if d, ok := s["deploy"].(map[string]any); ok {
		if r, ok := d["resources"].(map[string]any); ok {
			if l, ok := r["limits"].(map[string]any); ok {
				if v := scalar(l["cpus"]); v != "" {
					cpus = v
				}
				if v := scalar(l["memory"]); v != "" {
					mem = v
				}
			}
		}
		if rep := scalar(d["replicas"]); rep != "" && rep != "1" {
			warn("Service %s asks for %s replicas. Incus makes one.", svc, rep)
		}
	}
	if cpus != "" {
		if f, err := strconv.ParseFloat(cpus, 64); err == nil && f > 0 {
			if f == float64(int(f)) {
				out.Config["limits.cpu"] = strconv.Itoa(int(f))
			} else {
				out.Config["limits.cpu.allowance"] = fmt.Sprintf("%d%%", int(f*100))
			}
		}
	}
	if mem != "" {
		if b, ok := memBytes(mem); ok {
			out.Config["limits.memory"] = fmt.Sprintf("%dB", b)
		} else {
			warn("Service %s: memory limit %q is not understood and is skipped.", svc, mem)
		}
	}

	// ports
	if ports, ok := s["ports"].([]any); ok {
		for _, pv := range ports {
			devs, err := portDevices(pv)
			if err != nil {
				warn("Service %s: port %v is skipped: %v", svc, pv, err)
				continue
			}
			for k, d := range devs {
				out.Devices[k] = d
			}
		}
	}

	// volumes: named volumes become custom volumes; bind mounts can't move.
	if vs, ok := s["volumes"].([]any); ok {
		for i, vv := range vs {
			src, dst, ro, kind := volumeSpec(vv)
			if dst == "" {
				warn("Service %s: volume %v is skipped: no target path.", svc, vv)
				continue
			}
			switch {
			case kind == "bind" || strings.HasPrefix(src, "/") || strings.HasPrefix(src, ".") || strings.HasPrefix(src, "~"):
				warn("Service %s mounts %s from the Docker host at %s. Host folders don't move with the import: the path starts empty. Copy the files in with the file explorer.", svc, src, dst)
			case kind == "tmpfs":
				continue
			case src == "":
				// An anonymous volume: Docker makes a throwaway one. The root disk holds it.
				continue
			default:
				vol := Name(p.Stack + "-" + src)
				vols[vol] = true
				d := map[string]string{"type": "disk", "pool": o.Pool, "source": vol, "path": dst}
				if ro {
					d["readonly"] = "true"
				}
				out.Devices[fmt.Sprintf("vol%d", i)] = d
			}
		}
	}

	// depends_on: a list or a map of service names.
	switch d := s["depends_on"].(type) {
	case []any:
		for _, x := range d {
			out.DependsOn = append(out.DependsOn, fmt.Sprint(x))
		}
	case map[string]any:
		out.DependsOn = sortedKeys(d)
	}
	for _, dep := range out.DependsOn {
		if names[dep] == "" {
			return nil, fmt.Errorf("Service %s depends on %s, which is not in the file.", svc, dep)
		}
	}

	for _, k := range []string{"privileged", "cap_add", "devices", "security_opt", "sysctls", "ulimits", "secrets", "configs", "extra_hosts", "dns", "healthcheck", "network_mode", "pid", "ipc", "shm_size", "gpus"} {
		if _, ok := s[k]; ok {
			warn("Service %s uses %s, which is not carried over.", svc, k)
		}
	}
	if nets, ok := s["networks"]; ok && nets != nil {
		if m, ok := nets.(map[string]any); !ok || len(m) > 1 {
			if l, ok := nets.([]any); !ok || len(l) > 1 {
				warn("Service %s is on several networks. In Incus all services of the stack share one network.", svc)
			}
		}
	}
	return out, nil
}

// order sorts services so that dependencies start first.
func order(p *Plan) error {
	byName := map[string]*Service{}
	for i := range p.Services {
		byName[p.Services[i].Service] = &p.Services[i]
	}
	var out []Service
	state := map[string]int{} // 1 visiting, 2 done
	var visit func(n string) error
	visit = func(n string) error {
		switch state[n] {
		case 1:
			return fmt.Errorf("services %s depend on each other in a loop", n)
		case 2:
			return nil
		}
		s := byName[n]
		if s == nil {
			return nil
		}
		state[n] = 1
		for _, d := range s.DependsOn {
			if err := visit(d); err != nil {
				return err
			}
		}
		state[n] = 2
		out = append(out, *s)
		return nil
	}
	names := make([]string, 0, len(byName))
	for n := range byName {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		if err := visit(n); err != nil {
			return err
		}
	}
	p.Services = out
	return nil
}

// portDevices maps one ports entry to proxy devices.
func portDevices(v any) (map[string]map[string]string, error) {
	var hostIP, published, target, proto string
	switch x := v.(type) {
	case map[string]any:
		target, published, proto, hostIP = scalar(x["target"]), scalar(x["published"]), scalar(x["protocol"]), scalar(x["host_ip"])
	default:
		s := scalar(x)
		s, proto, _ = strings.Cut(s, "/")
		// IPv6 host addresses come in brackets.
		if strings.HasPrefix(s, "[") {
			end := strings.Index(s, "]:")
			if end < 0 {
				return nil, errors.New("bad address")
			}
			hostIP, s = s[1:end], s[end+2:]
		}
		parts := strings.Split(s, ":")
		switch len(parts) {
		case 1:
			target = parts[0]
		case 2:
			published, target = parts[0], parts[1]
		case 3:
			hostIP, published, target = parts[0], parts[1], parts[2]
		default:
			return nil, errors.New("not understood")
		}
	}
	if proto == "" {
		proto = "tcp"
	}
	if proto != "tcp" && proto != "udp" {
		return nil, fmt.Errorf("protocol %s", proto)
	}
	if target == "" {
		return nil, errors.New("no container port")
	}
	if published == "" {
		// Docker picks a random host port; Incus needs one. Use the same.
		published = target
	}
	if !portRange.MatchString(target) || !portRange.MatchString(published) {
		return nil, errors.New("bad port")
	}
	if hostIP == "" {
		hostIP = "0.0.0.0"
	}
	listen := hostIP
	if strings.Contains(listen, ":") {
		listen = "[" + listen + "]"
	}
	name := "port-" + strings.ReplaceAll(published, "-", "_") + "-" + proto
	return map[string]map[string]string{name: {
		"type":    "proxy",
		"listen":  proto + ":" + listen + ":" + published,
		"connect": proto + ":127.0.0.1:" + target,
	}}, nil
}

var portRange = regexp.MustCompile(`^\d{1,5}(-\d{1,5})?$`)

// volumeSpec reads a short ("src:dst:ro") or long volume entry.
func volumeSpec(v any) (src, dst string, ro bool, kind string) {
	if m, ok := v.(map[string]any); ok {
		kind, src, dst = scalar(m["type"]), scalar(m["source"]), scalar(m["target"])
		ro = m["read_only"] == true
		return
	}
	parts := strings.Split(scalar(v), ":")
	switch len(parts) {
	case 1:
		dst = parts[0]
	case 2:
		src, dst = parts[0], parts[1]
	default:
		src, dst = parts[0], parts[1]
		ro = strings.Contains(parts[2], "ro")
	}
	if strings.HasPrefix(src, "/") || strings.HasPrefix(src, ".") || strings.HasPrefix(src, "~") {
		kind = "bind"
	}
	return
}

func scalar(v any) string {
	switch x := v.(type) {
	case nil:
		return ""
	case string:
		return x
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64)
	default:
		return fmt.Sprint(x)
	}
}

// memBytes reads Docker sizes like 512m, 1g, 1.5G, 1024k or 1048576.
func memBytes(s string) (int64, bool) {
	s = strings.ToLower(strings.TrimSpace(s))
	s = strings.TrimSuffix(strings.TrimSuffix(s, "b"), "i")
	mult := 1.0
	if s != "" {
		switch s[len(s)-1] {
		case 'k':
			mult = 1 << 10
		case 'm':
			mult = 1 << 20
		case 'g':
			mult = 1 << 30
		case 't':
			mult = 1 << 40
		}
		if mult > 1 {
			s = s[:len(s)-1]
		}
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil || f <= 0 {
		return 0, false
	}
	return int64(f * mult), true
}

func shellQuote(s string) string {
	if s != "" && !strings.ContainsAny(s, " \t\n'\"\\$`;&|<>(){}*?[]#~") {
		return s
	}
	return "'" + strings.ReplaceAll(s, "'", `'"'"'`) + "'"
}

func sortedKeys[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
