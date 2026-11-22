package main

import (
	"io"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/baki2001/incus-webui/internal/compose"
)

const testStack = `
services:
  web:
    image: nginx:alpine
    restart: always
    depends_on: [cache]
    ports: ["18080:80"]
    volumes: ["html:/usr/share/nginx/html"]
  cache:
    image: redis:alpine
    command: ["redis-server", "--save", ""]
`

// TestComposeIncus imports a small stack into a new project on the local
// Incus, which must be 6.3 or newer, and fetches a page through its port.
func TestComposeIncus(t *testing.T) {
	if os.Getenv("INCUS_WEBUI_COMPOSE") == "" {
		t.Skip("INCUS_WEBUI_COMPOSE not set")
	}
	a := testApp(t)
	a.backends = &Backends{transports: map[string]*backend{}}
	_ = a.store.Update(func(c *Config) error {
		c.Servers = []ServerConfig{{Name: "local", URL: "unix:///var/lib/incus/unix.socket"}}
		return nil
	})
	c, _ := a.conn("local")
	b, _ := c.call(t.Context(), "GET", "/1.0", "", nil)
	p, err := compose.Parse([]byte(testStack), nil, compose.Options{Stack: "iwui-stack", Pool: "default", Entrypoint: strings.Contains(string(b), `"instance_oci_entrypoint"`)})
	if err != nil || len(p.Blockers) > 0 {
		t.Fatal(err, p.Blockers)
	}
	t.Logf("plan: %+v", p)
	q := &composeReq{Server: "local", Project: "iwui-stack", NewProject: true, Pool: "default", Start: true}
	cleanup := func() {
		for _, s := range p.Services {
			exec.Command("incus", "delete", "-f", "--project", q.Project, s.Name).Run()
		}
		for _, v := range p.Volumes {
			exec.Command("incus", "storage", "volume", "delete", "default", v, "--project", q.Project).Run()
		}
		exec.Command("incus", "project", "delete", q.Project).Run()
	}
	cleanup()
	t.Cleanup(cleanup)
	note, err := runCompose(t.Context(), c, q, p, func(x float64, d string) { t.Logf("%3.0f%% %s", x*100, d) })
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("note: %s", note)
	exec.Command("incus", "exec", "--project", q.Project, "web", "--", "sh", "-c", "echo stack-ok > /usr/share/nginx/html/index.html").Run()
	deadline := time.Now().Add(time.Minute)
	for {
		resp, err := http.Get("http://127.0.0.1:18080/")
		if err == nil {
			body, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			if strings.Contains(string(body), "stack-ok") {
				break
			}
			err = nil
			t.Logf("page: %.80s", body)
		}
		if time.Now().After(deadline) {
			out, _ := exec.Command("incus", "list", "--project", q.Project).CombinedOutput()
			t.Fatalf("no page through the proxy port: %v\n%s", err, out)
		}
		time.Sleep(2 * time.Second)
	}
	out, err := exec.Command("incus", "exec", "--project", q.Project, "cache", "--", "redis-cli", "ping").CombinedOutput()
	if err != nil || !strings.Contains(string(out), "PONG") {
		t.Errorf("redis: %s %v", out, err)
	}
}
