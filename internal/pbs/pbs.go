// Package pbs reads backups from a Proxmox Backup Server through its HTTP
// API, with an API token. It only reads: it lists snapshots and downloads
// files, which the server decodes from its chunk store on the way out.
package pbs

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Client talks to one datastore.
type Client struct {
	base      string // https://host:8007
	store, ns string
	auth      string
	http      *http.Client
}

// New makes a client. fingerprint is the SHA-256 of the server's
// certificate as Proxmox shows it (hex, colons optional); when it is set the
// certificate is pinned instead of checked against the system CAs, since a
// PBS server uses a self-signed certificate by default.
func New(rawURL, datastore, namespace, tokenID, secret, fingerprint string) (*Client, error) {
	u, err := url.Parse(strings.TrimRight(rawURL, "/"))
	if err != nil || u.Scheme != "https" || u.Host == "" {
		return nil, errors.New("the address must look like https://pbs.lan:8007")
	}
	if u.Port() == "" {
		u.Host += ":8007"
	}
	if datastore == "" || tokenID == "" || secret == "" {
		return nil, errors.New("a datastore, an API token ID and its secret are needed")
	}
	if !strings.Contains(tokenID, "!") {
		return nil, errors.New("the API token ID looks like user@pbs!name")
	}
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.Proxy = nil // a backup server is on the LAN
	tr.TLSClientConfig = &tls.Config{MinVersion: tls.VersionTLS12}
	if fingerprint != "" {
		want, err := hex.DecodeString(strings.ReplaceAll(strings.TrimSpace(fingerprint), ":", ""))
		if err != nil || len(want) != sha256.Size {
			return nil, errors.New("the fingerprint must be a SHA-256 in hex, as the PBS dashboard shows it")
		}
		tr.TLSClientConfig.InsecureSkipVerify = true
		tr.TLSClientConfig.VerifyPeerCertificate = func(certs [][]byte, _ [][]*x509.Certificate) error {
			if len(certs) == 0 {
				return errors.New("the server sent no certificate")
			}
			got := sha256.Sum256(certs[0])
			if !bytes.Equal(got[:], want) {
				return fmt.Errorf("the server's certificate fingerprint is %s, not the one in the settings", colonHex(got[:]))
			}
			return nil
		}
	}
	return &Client{
		base:  u.String(),
		store: datastore,
		ns:    namespace,
		auth:  "PBSAPIToken=" + tokenID + ":" + secret,
		http:  &http.Client{Transport: tr},
	}, nil
}

func colonHex(b []byte) string {
	s := make([]string, len(b))
	for i, x := range b {
		s[i] = fmt.Sprintf("%02x", x)
	}
	return strings.Join(s, ":")
}

func (c *Client) get(ctx context.Context, path string, q url.Values) (*http.Response, error) {
	if c.ns != "" {
		q.Set("ns", c.ns)
	}
	u := c.base + "/api2/json/admin/datastore/" + url.PathEscape(c.store) + path + "?" + q.Encode()
	req, err := http.NewRequestWithContext(ctx, "GET", u, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", c.auth)
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("Proxmox Backup Server: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		defer resp.Body.Close()
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		msg := strings.TrimSpace(string(b))
		var m struct {
			Message string `json:"message"`
		}
		if json.Unmarshal(b, &m) == nil && m.Message != "" {
			msg = strings.TrimSpace(m.Message)
		}
		switch resp.StatusCode {
		case http.StatusUnauthorized:
			msg = "the API token or its secret is wrong"
		case http.StatusForbidden:
			msg = "the API token may not read this datastore. Give it the DatastoreReader role on it (and Privilege Separation needs the role on the token itself)"
		}
		return nil, fmt.Errorf("Proxmox Backup Server: %s", msg)
	}
	return resp, nil
}

// File is one archive in a snapshot.
type File struct {
	Name      string `json:"filename"`
	Size      int64  `json:"size"`
	CryptMode string `json:"crypt-mode"` // none | encrypt | sign-only
}

// Snapshot is one backup.
type Snapshot struct {
	Type    string `json:"backup-type"` // vm | ct | host
	ID      string `json:"backup-id"`
	Time    int64  `json:"backup-time"`
	Comment string `json:"comment,omitempty"`
	Files   []File `json:"files"`
	Size    int64  `json:"size,omitempty"`
}

// Ref names a snapshot as type/id/time, e.g. ct/110/1732406937.
func (s Snapshot) Ref() string { return s.Type + "/" + s.ID + "/" + strconv.FormatInt(s.Time, 10) }

// Created is when the backup was made.
func (s Snapshot) Created() time.Time { return time.Unix(s.Time, 0) }

// File returns the archive with the given name.
func (s Snapshot) File(name string) (File, bool) {
	for _, f := range s.Files {
		if f.Name == name {
			return f, true
		}
	}
	return File{}, false
}

// ParseRef splits a snapshot reference.
func ParseRef(ref string) (typ, id string, t int64, err error) {
	parts := strings.Split(ref, "/")
	if len(parts) != 3 || (parts[0] != "vm" && parts[0] != "ct") || parts[1] == "" {
		return "", "", 0, errors.New("bad snapshot reference")
	}
	t, err = strconv.ParseInt(parts[2], 10, 64)
	return parts[0], parts[1], t, err
}

// Snapshots lists the snapshots in the datastore (and namespace).
func (c *Client) Snapshots(ctx context.Context) ([]Snapshot, error) {
	resp, err := c.get(ctx, "/snapshots", url.Values{})
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var out struct {
		Data []Snapshot `json:"data"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 64<<20)).Decode(&out); err != nil {
		return nil, fmt.Errorf("Proxmox Backup Server: bad snapshot list: %w", err)
	}
	return out.Data, nil
}

// Snapshot finds one snapshot by its reference.
func (c *Client) Snapshot(ctx context.Context, ref string) (Snapshot, error) {
	typ, id, t, err := ParseRef(ref)
	if err != nil {
		return Snapshot{}, err
	}
	list, err := c.Snapshots(ctx)
	if err != nil {
		return Snapshot{}, err
	}
	for _, s := range list {
		if s.Type == typ && s.ID == id && s.Time == t {
			return s, nil
		}
	}
	return Snapshot{}, errors.New("the backup is no longer on the Proxmox Backup Server")
}

// Open downloads one file of a snapshot, decoded: a .blob gives its
// contents, a .didx the archive (pxar) and a .fidx the raw disk image.
func (c *Client) Open(ctx context.Context, s Snapshot, file string) (io.ReadCloser, error) {
	if f, ok := s.File(file); !ok {
		return nil, fmt.Errorf("the backup has no %s", file)
	} else if f.CryptMode == "encrypt" {
		return nil, errors.New("the backup is encrypted, and the server can't decrypt it for the UI. Restore it in Proxmox instead")
	}
	q := url.Values{"backup-type": {s.Type}, "backup-id": {s.ID}, "backup-time": {strconv.FormatInt(s.Time, 10)}, "file-name": {file}}
	resp, err := c.get(ctx, "/download-decoded", q)
	if err != nil {
		return nil, err
	}
	return resp.Body, nil
}

// ReadFile downloads a small decoded file, such as a config blob.
func (c *Client) ReadFile(ctx context.Context, s Snapshot, file string) ([]byte, error) {
	rc, err := c.Open(ctx, s, file)
	if err != nil {
		return nil, err
	}
	defer rc.Close()
	return io.ReadAll(io.LimitReader(rc, 1<<20))
}
