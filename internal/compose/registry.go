package compose

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// ImageEntrypoint reads an image's ENTRYPOINT from its registry, without
// credentials, the way a pull does. arch is a Go/OCI name such as amd64.
func ImageEntrypoint(ctx context.Context, server, image, arch string) ([]string, error) {
	repo, ref := image, "latest"
	if i := strings.LastIndex(image, "@"); i >= 0 {
		repo, ref = image[:i], image[i+1:]
	} else if i := strings.LastIndex(image, ":"); i > strings.LastIndex(image, "/") {
		repo, ref = image[:i], image[i+1:]
	}
	host := strings.TrimPrefix(server, "https://")
	if host == "docker.io" {
		host = "registry-1.docker.io"
	}
	r := &registry{base: "https://" + host + "/v2/" + repo, client: &http.Client{Timeout: 30 * time.Second}}
	accept := "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json"
	var m struct {
		Manifests []struct {
			Digest   string
			Platform struct{ Architecture, OS string }
		}
		Config struct{ Digest string }
	}
	if err := r.get(ctx, "/manifests/"+ref, accept, &m); err != nil {
		return nil, err
	}
	if len(m.Manifests) > 0 {
		digest := ""
		for _, x := range m.Manifests {
			if x.Platform.OS == "linux" && x.Platform.Architecture == arch {
				digest = x.Digest
				break
			}
		}
		if digest == "" {
			return nil, fmt.Errorf("the image has no %s build", arch)
		}
		if err := r.get(ctx, "/manifests/"+digest, accept, &m); err != nil {
			return nil, err
		}
	}
	if m.Config.Digest == "" {
		return nil, errors.New("the image manifest has no config")
	}
	var cfg struct {
		Config struct{ Entrypoint []string }
	}
	if err := r.get(ctx, "/blobs/"+m.Config.Digest, "", &cfg); err != nil {
		return nil, err
	}
	return cfg.Config.Entrypoint, nil
}

type registry struct {
	base   string
	client *http.Client
	token  string
}

func (r *registry) get(ctx context.Context, path, accept string, v any) error {
	for try := 0; try < 2; try++ {
		req, _ := http.NewRequestWithContext(ctx, "GET", r.base+path, nil)
		if accept != "" {
			req.Header.Set("Accept", accept)
		}
		if r.token != "" {
			req.Header.Set("Authorization", "Bearer "+r.token)
		}
		resp, err := r.client.Do(req)
		if err != nil {
			return err
		}
		if resp.StatusCode == http.StatusUnauthorized && r.token == "" {
			auth := resp.Header.Get("WWW-Authenticate")
			resp.Body.Close()
			if r.token, err = r.anonToken(ctx, auth); err != nil {
				return err
			}
			continue
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			return fmt.Errorf("registry: %s", resp.Status)
		}
		return json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(v)
	}
	return errors.New("registry: not authorized")
}

// anonToken gets a pull token for a public image (Bearer realm=...,service=...,scope=...).
func (r *registry) anonToken(ctx context.Context, header string) (string, error) {
	rest, ok := strings.CutPrefix(header, "Bearer ")
	if !ok {
		return "", errors.New("registry: the image is private or the registry needs a login")
	}
	params := map[string]string{}
	for _, kv := range strings.Split(rest, ",") {
		k, v, _ := strings.Cut(strings.TrimSpace(kv), "=")
		params[k] = strings.Trim(v, `"`)
	}
	u, err := url.Parse(params["realm"])
	if err != nil || u.Scheme != "https" {
		return "", errors.New("registry: bad token address")
	}
	q := u.Query()
	for _, k := range []string{"service", "scope"} {
		if params[k] != "" {
			q.Set(k, params[k])
		}
	}
	u.RawQuery = q.Encode()
	req, _ := http.NewRequestWithContext(ctx, "GET", u.String(), nil)
	resp, err := r.client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	var t struct {
		Token       string `json:"token"`
		AccessToken string `json:"access_token"`
	}
	if resp.StatusCode != http.StatusOK || json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&t) != nil {
		return "", errors.New("registry: no pull token")
	}
	if t.Token == "" {
		t.Token = t.AccessToken
	}
	return t.Token, nil
}

// JoinCommand puts an entrypoint and a command line together for oci.entrypoint.
func JoinCommand(entrypoint []string, command string) string {
	parts := make([]string, 0, len(entrypoint)+1)
	for _, a := range entrypoint {
		parts = append(parts, shellQuote(a))
	}
	return strings.TrimSpace(strings.Join(parts, " ") + " " + command)
}

// OCIArch maps an Incus architecture name to the OCI one.
func OCIArch(incus string) string {
	switch incus {
	case "x86_64":
		return "amd64"
	case "aarch64":
		return "arm64"
	case "armv7l":
		return "arm"
	case "riscv64", "ppc64le", "s390x":
		return incus
	}
	return incus
}
