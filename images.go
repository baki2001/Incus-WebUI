package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"
)

// The Incus API can't list the images on a remote image server, so the UI
// reads the server's simplestreams index itself and hands the browser a short
// list. Pulling an image is then a normal Incus API call with a "pull" source.

type ImageServer struct {
	Name string `yaml:"name" json:"name"`
	URL  string `yaml:"url" json:"url"`
}

var defaultImageServers = []ImageServer{{Name: "Linux Containers", URL: "https://images.linuxcontainers.org"}}

func (a *App) imageServers() []ImageServer {
	if s := a.store.Get().ImageServers; len(s) > 0 {
		return s
	}
	return defaultImageServers
}

type remoteImage struct {
	Aliases   []string `json:"aliases"`
	OS        string   `json:"os"`
	Release   string   `json:"release"`
	Title     string   `json:"release_title,omitempty"`
	Variant   string   `json:"variant"`
	Arch      string   `json:"arch"`
	Container bool     `json:"container"`
	VM        bool     `json:"vm"`
	Size      int64    `json:"size"`
	Updated   string   `json:"updated"`
}

type remoteCache struct {
	mu  sync.Mutex
	at  map[string]time.Time
	img map[string][]remoteImage
}

var remotes = &remoteCache{at: map[string]time.Time{}, img: map[string][]remoteImage{}}

var streamsClient = &http.Client{Timeout: 60 * time.Second}

func (a *App) handleImageServers(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, a.imageServers())
}

// handleRemoteImages returns the images on one of the configured image
// servers. Only configured servers can be read, so this can't be used to make
// the UI fetch arbitrary URLs.
func (a *App) handleRemoteImages(w http.ResponseWriter, r *http.Request) {
	url := r.URL.Query().Get("server")
	ok := false
	for _, s := range a.imageServers() {
		ok = ok || s.URL == url
	}
	if !ok {
		jsonError(w, http.StatusBadRequest, "unknown image server")
		return
	}
	list, err := remotes.get(r.Context(), url, r.URL.Query().Get("refresh") == "1")
	if err != nil {
		jsonError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, list)
}

func (c *remoteCache) get(ctx context.Context, base string, force bool) ([]remoteImage, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !force && time.Since(c.at[base]) < 6*time.Hour {
		return c.img[base], nil
	}
	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	list, err := fetchStreams(ctx, strings.TrimRight(base, "/"))
	if err != nil {
		if c.img[base] != nil {
			return c.img[base], nil // keep serving the last good list
		}
		return nil, errors.New(streamsError(base, err))
	}
	c.img[base], c.at[base] = list, time.Now()
	return list, nil
}

// streamsError explains in plain words why an image server's list can't be
// read, instead of passing on the raw Go network error.
func streamsError(base string, err error) string {
	host := strings.TrimPrefix(strings.TrimPrefix(base, "https://"), "http://")
	var status *statusError
	switch {
	case errors.As(err, &status):
		return fmt.Sprintf("%s answered %s. Try again in a few minutes.", host, status.status)
	case errors.Is(err, context.DeadlineExceeded):
		return fmt.Sprintf("%s took too long to answer. Try again in a few minutes.", host)
	default:
		var syn *json.SyntaxError
		var typ *json.UnmarshalTypeError
		if errors.As(err, &syn) || errors.As(err, &typ) || errors.Is(err, io.ErrUnexpectedEOF) {
			return fmt.Sprintf("%s sent an image list this app can't read. Check the server address in Settings.", host)
		}
		return fmt.Sprintf("Can't reach %s. Check that this host has internet access, then try again.", host)
	}
}

type statusError struct{ status string }

func (e *statusError) Error() string { return "server answered " + e.status }

type streamsIndex struct {
	Index map[string]struct {
		Datatype string `json:"datatype"`
		Path     string `json:"path"`
	} `json:"index"`
}

type streamsProducts struct {
	Products map[string]struct {
		Aliases      string `json:"aliases"`
		Arch         string `json:"arch"`
		OS           string `json:"os"`
		Release      string `json:"release"`
		ReleaseTitle string `json:"release_title"`
		Variant      string `json:"variant"`
		Versions     map[string]struct {
			Items map[string]struct {
				Ftype string `json:"ftype"`
				Size  int64  `json:"size"`
			} `json:"items"`
		} `json:"versions"`
	} `json:"products"`
}

func getJSON(ctx context.Context, url string, v any) error {
	req, _ := http.NewRequestWithContext(ctx, "GET", url, nil)
	req.Header.Set("User-Agent", "incus-webui/"+version)
	resp, err := streamsClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return &statusError{resp.Status}
	}
	return json.NewDecoder(io.LimitReader(resp.Body, 256<<20)).Decode(v)
}

func fetchStreams(ctx context.Context, base string) ([]remoteImage, error) {
	var idx streamsIndex
	if err := getJSON(ctx, base+"/streams/v1/index.json", &idx); err != nil {
		return nil, err
	}
	var out []remoteImage
	for _, e := range idx.Index {
		if e.Datatype != "image-downloads" || e.Path == "" {
			continue
		}
		var p streamsProducts
		if err := getJSON(ctx, base+"/"+strings.TrimLeft(e.Path, "/"), &p); err != nil {
			return nil, err
		}
		out = append(out, parseProducts(p)...)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].OS != out[j].OS {
			return out[i].OS < out[j].OS
		}
		if out[i].Release != out[j].Release {
			return out[i].Release > out[j].Release
		}
		return out[i].Variant < out[j].Variant
	})
	return out, nil
}

func parseProducts(p streamsProducts) []remoteImage {
	var out []remoteImage
	for _, pr := range p.Products {
		// Use the newest version of each product.
		latest := ""
		for v := range pr.Versions {
			if v > latest {
				latest = v
			}
		}
		if latest == "" {
			continue
		}
		img := remoteImage{OS: pr.OS, Release: pr.Release, Title: pr.ReleaseTitle, Variant: pr.Variant, Arch: pr.Arch, Updated: latest}
		for _, it := range pr.Versions[latest].Items {
			switch it.Ftype {
			case "squashfs", "root.tar.xz":
				img.Container = true
				if it.Size > img.Size {
					img.Size = it.Size
				}
			case "disk-kvm.img":
				img.VM = true
			}
		}
		if !img.Container && !img.VM {
			continue
		}
		for _, al := range strings.Split(pr.Aliases, ",") {
			if al = strings.TrimSpace(al); al != "" {
				img.Aliases = append(img.Aliases, al)
			}
		}
		// The shortest alias first, e.g. debian/13 before debian/13/default.
		sort.SliceStable(img.Aliases, func(i, j int) bool { return len(img.Aliases[i]) < len(img.Aliases[j]) })
		out = append(out, img)
	}
	return out
}
