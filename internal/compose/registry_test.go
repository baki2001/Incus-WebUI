package compose

import (
	"context"
	"os"
	"testing"
)

// TestImageEntrypoint needs the internet: INCUS_WEBUI_REGISTRY=1.
func TestImageEntrypoint(t *testing.T) {
	if os.Getenv("INCUS_WEBUI_REGISTRY") == "" {
		t.Skip("INCUS_WEBUI_REGISTRY not set")
	}
	ep, err := ImageEntrypoint(context.Background(), "https://docker.io", "library/redis:alpine", "amd64")
	if err != nil || len(ep) == 0 || ep[0] != "docker-entrypoint.sh" {
		t.Errorf("redis entrypoint = %v %v", ep, err)
	}
}

func TestJoinCommand(t *testing.T) {
	if got := JoinCommand([]string{"docker-entrypoint.sh"}, "redis-server --save ''"); got != "docker-entrypoint.sh redis-server --save ''" {
		t.Error(got)
	}
	if got := JoinCommand(nil, "run"); got != "run" {
		t.Error(got)
	}
}
