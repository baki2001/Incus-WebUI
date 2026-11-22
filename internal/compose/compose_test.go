package compose

import (
	"reflect"
	"strings"
	"testing"
)

const sample = `
name: blog
services:
  db:
    image: postgres:16
    restart: unless-stopped
    environment:
      POSTGRES_PASSWORD: ${DB_PASS}
      POSTGRES_DB: ${DB_NAME:-wordpress}
    volumes:
      - db_data:/var/lib/postgresql/data
    deploy:
      resources:
        limits: {cpus: "1.5", memory: 1g}
  web:
    image: ghcr.io/example/wp:6
    container_name: wp_front
    depends_on: [db]
    ports:
      - "8080:80"
      - "127.0.0.1:8443:443/tcp"
      - target: 53
        published: 5353
        protocol: udp
    environment:
      - WORDPRESS_DB_HOST=db
      - "PRICE=$$5"
    volumes:
      - ./html:/var/www/html
      - uploads:/uploads:ro
    command: ["php", "-S", "0.0.0.0:80", "it's"]
    cap_add: [NET_ADMIN]
  cache:
    image: redis
volumes:
  db_data:
  uploads:
`

func TestParse(t *testing.T) {
	p, err := Parse([]byte(sample), ParseEnv("DB_PASS='s3cret'\n# comment\n"), Options{Pool: "default", Entrypoint: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(p.Blockers) != 0 {
		t.Fatal(p.Blockers)
	}
	if p.Stack != "blog" {
		t.Errorf("stack = %s", p.Stack)
	}
	var order []string
	svc := map[string]Service{}
	for _, s := range p.Services {
		order = append(order, s.Service)
		svc[s.Service] = s
	}
	if !reflect.DeepEqual(order, []string{"cache", "db", "web"}) {
		t.Errorf("order = %v", order)
	}
	db, web, cache := svc["db"], svc["web"], svc["cache"]
	if db.Image != "library/postgres:16" || db.Server != "https://docker.io" {
		t.Errorf("db image = %s %s", db.Server, db.Image)
	}
	if cache.Image != "library/redis:latest" {
		t.Errorf("cache image = %s", cache.Image)
	}
	if web.Server != "https://ghcr.io" || web.Image != "example/wp:6" || web.Name != "wp-front" {
		t.Errorf("web = %s %s %s", web.Server, web.Image, web.Name)
	}
	want := map[string]string{
		"environment.POSTGRES_PASSWORD": "s3cret", "environment.POSTGRES_DB": "wordpress",
		"boot.autostart": "true", "limits.cpu.allowance": "150%", "limits.memory": "1073741824B",
	}
	for k, v := range want {
		if db.Config[k] != v {
			t.Errorf("db %s = %q, want %q", k, db.Config[k], v)
		}
	}
	if db.Config["boot.autostart.priority"] <= web.Config["boot.autostart.priority"] {
		t.Error("db must start before web")
	}
	if web.Config["environment.PRICE"] != "$5" || web.Config["environment.WORDPRESS_DB_HOST"] != "db" {
		t.Errorf("web env = %v", web.Config)
	}
	if web.Command != `php -S 0.0.0.0:80 'it'"'"'s'` || web.Config["oci.entrypoint"] != "" {
		t.Errorf("command = %s, entrypoint %s", web.Command, web.Config["oci.entrypoint"])
	}
	wantDevs := map[string]map[string]string{
		"port-8080-tcp": {"type": "proxy", "listen": "tcp:0.0.0.0:8080", "connect": "tcp:127.0.0.1:80"},
		"port-8443-tcp": {"type": "proxy", "listen": "tcp:127.0.0.1:8443", "connect": "tcp:127.0.0.1:443"},
		"port-5353-udp": {"type": "proxy", "listen": "udp:0.0.0.0:5353", "connect": "udp:127.0.0.1:53"},
		"vol1":          {"type": "disk", "pool": "default", "source": "blog-uploads", "path": "/uploads", "readonly": "true"},
	}
	if !reflect.DeepEqual(web.Devices, wantDevs) {
		t.Errorf("web devices = %v", web.Devices)
	}
	if !reflect.DeepEqual(p.Volumes, []string{"blog-db-data", "blog-uploads"}) {
		t.Errorf("volumes = %v", p.Volumes)
	}
	all := strings.Join(p.Warnings, "\n")
	for _, w := range []string{"./html", "cap_add", "wp-front"} {
		if !strings.Contains(all, w) {
			t.Errorf("no warning about %s:\n%s", w, all)
		}
	}
}

func TestParseProblems(t *testing.T) {
	cases := map[string]string{
		"services:\n  a:\n    build: .\n":                                                               "Dockerfile",
		"services:\n  a:\n    image: x\n    depends_on: [b]\n":                                          "not in the file",
		"services:\n  a:\n    image: x\n    depends_on: [b]\n  b:\n    image: y\n    depends_on: [a]\n": "loop",
	}
	for src, want := range cases {
		p, err := Parse([]byte(src), nil, Options{Pool: "default"})
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(strings.Join(p.Blockers, " "), want) {
			t.Errorf("%q: blockers %v, want %q", src, p.Blockers, want)
		}
	}
	if _, err := Parse([]byte("services: {}"), nil, Options{}); err == nil {
		t.Error("an empty file was accepted")
	}
	p, _ := Parse([]byte("services:\n  a:\n    image: x\n    entrypoint: [sh, -c]\n    command: run it\n"), nil, Options{Pool: "p", Entrypoint: true})
	if p.Services[0].Config["oci.entrypoint"] != "sh -c run it" {
		t.Errorf("entrypoint = %q", p.Services[0].Config["oci.entrypoint"])
	}
	p, _ = Parse([]byte("services:\n  a:\n    image: x\n    command: run\n"), nil, Options{Pool: "p"})
	if p.Services[0].Command != "" || len(p.Warnings) == 0 {
		t.Error("command without entrypoint support must warn, not set")
	}
}

func TestImageRef(t *testing.T) {
	cases := map[string][2]string{
		"nginx":                     {"https://docker.io", "library/nginx:latest"},
		"bitnami/redis:7":           {"https://docker.io", "bitnami/redis:7"},
		"docker.io/library/nginx:1": {"https://docker.io", "library/nginx:1"},
		"quay.io/a/b":               {"https://quay.io", "a/b:latest"},
		"localhost:5000/app:2":      {"https://localhost:5000", "app:2"},
		"ghcr.io/a/b@sha256:abc":    {"https://ghcr.io", "a/b@sha256:abc"},
	}
	for in, want := range cases {
		s, i, err := ImageRef(in)
		if err != nil || s != want[0] || i != want[1] {
			t.Errorf("%s = %s %s %v", in, s, i, err)
		}
	}
}

func TestMemBytes(t *testing.T) {
	for in, want := range map[string]int64{"512m": 512 << 20, "1g": 1 << 30, "1.5G": 3 << 29, "1024k": 1 << 20, "100": 100, "2GiB": 2 << 30} {
		if got, ok := memBytes(in); !ok || got != want {
			t.Errorf("%s = %d", in, got)
		}
	}
}

func FuzzParse(f *testing.F) {
	f.Add(sample)
	f.Fuzz(func(t *testing.T, s string) {
		_, _ = Parse([]byte(s), nil, Options{Pool: "p", Entrypoint: true})
	})
}
