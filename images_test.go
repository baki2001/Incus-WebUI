package main

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func TestParseProducts(t *testing.T) {
	raw := `{"products":{
	"debian:13:amd64:default":{"aliases":"debian/13/default,debian/13","arch":"amd64","os":"Debian","release":"13","variant":"default",
		"versions":{"20261101":{"items":{"a":{"ftype":"squashfs","size":10}}},
		            "20261119":{"items":{"a":{"ftype":"squashfs","size":20},"b":{"ftype":"disk-kvm.img","size":300}}}}},
	"odd:1:amd64:default":{"aliases":"odd","versions":{"1":{"items":{"a":{"ftype":"incus.tar.xz"}}}}}}}`
	var p streamsProducts
	if err := json.Unmarshal([]byte(raw), &p); err != nil {
		t.Fatal(err)
	}
	out := parseProducts(p)
	if len(out) != 1 {
		t.Fatalf("want 1 image, got %d", len(out))
	}
	img := out[0]
	if img.Updated != "20261119" || !img.Container || !img.VM || img.Size != 20 {
		t.Fatalf("wrong newest version: %+v", img)
	}
	if img.Aliases[0] != "debian/13" {
		t.Fatalf("shortest alias should come first: %v", img.Aliases)
	}
}

func TestStreamsError(t *testing.T) {
	cases := map[string]error{
		"Can't reach images.example.org.":   errors.New("Get \"https://images.example.org/streams/v1/index.json\": dial tcp: lookup images.example.org: no such host"),
		"images.example.org answered 503":   &statusError{"503 Service Unavailable"},
		"took too long":                     context.DeadlineExceeded,
		"sent an image list this app can't": &json.SyntaxError{},
	}
	for want, err := range cases {
		if got := streamsError("https://images.example.org", err); !strings.Contains(got, want) {
			t.Errorf("want %q in %q", want, got)
		}
	}
}
