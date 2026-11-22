package proxmox

import (
	"os"
	"testing"
)

// The cloud image used in CI has a GPT with an ESP; a blank disk has none.
func TestHasESP(t *testing.T) {
	if HasESP(make([]byte, 65536)) {
		t.Error("a blank disk has an ESP")
	}
	raw := os.Getenv("INCUS_WEBUI_PVE_VM_RAW")
	if raw == "" {
		t.Skip("INCUS_WEBUI_PVE_VM_RAW not set")
	}
	f, err := os.Open(raw)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	head := make([]byte, 65536)
	if _, err := f.ReadAt(head, 0); err != nil {
		t.Fatal(err)
	}
	if !HasESP(head) {
		t.Error("no ESP found on the cloud image")
	}
}
