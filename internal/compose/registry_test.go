package compose

import (
	"context"
	"os"
	"strings"
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

func TestSafeClientBlocksLocal(t *testing.T) {
	for _, u := range []string{"https://127.0.0.1:1/v2/", "https://169.254.169.254/latest/"} {
		if _, err := safeClient.Get(u); err == nil || !strings.Contains(err.Error(), "not allowed") {
			t.Errorf("%s: err = %v, want address not allowed", u, err)
		}
	}
}
