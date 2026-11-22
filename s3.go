package main

// A small S3 client for backup targets: put (multipart), get, delete, list.
// It signs with AWS Signature V4 and works with AWS, MinIO, Garage, Ceph,
// Backblaze B2 and other S3-compatible stores.

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
)

type s3Client struct {
	endpoint  *url.URL // https://s3.example.com
	bucket    string
	region    string
	accessKey string
	secretKey string
	pathStyle bool // bucket in the path, not the host name
	http      *http.Client
}

func newS3(t BackupTarget) (*s3Client, error) {
	u, err := url.Parse(strings.TrimRight(t.Endpoint, "/"))
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" {
		return nil, errors.New("the S3 endpoint must be a URL like https://s3.example.com")
	}
	region := t.Region
	if region == "" {
		region = "us-east-1"
	}
	return &s3Client{endpoint: u, bucket: t.Bucket, region: region, accessKey: t.AccessKey, secretKey: t.SecretKey, pathStyle: !t.VirtualHost, http: &http.Client{Timeout: 0}}, nil
}

const s3PartSize = 16 << 20

func (c *s3Client) objectURL(key string, q url.Values) *url.URL {
	u := *c.endpoint
	p := "/" + strings.TrimLeft(key, "/")
	if c.pathStyle {
		p = "/" + c.bucket + p
	} else {
		u.Host = c.bucket + "." + u.Host
	}
	u.Path = strings.TrimRight(c.endpoint.Path, "/") + p
	u.RawPath = ""
	if q != nil {
		u.RawQuery = q.Encode()
	}
	return &u
}

func (c *s3Client) do(ctx context.Context, method string, u *url.URL, body []byte) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, u.String(), bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.ContentLength = int64(len(body))
	sum := sha256.Sum256(body)
	c.sign(req, hex.EncodeToString(sum[:]), time.Now().UTC())
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode >= 300 {
		defer resp.Body.Close()
		var e struct {
			Code    string
			Message string
		}
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
		_ = xml.Unmarshal(b, &e)
		if e.Code == "" {
			e.Code = resp.Status
		}
		return nil, &s3Err{resp.StatusCode, strings.TrimSpace(e.Code + " " + e.Message)}
	}
	return resp, nil
}

type s3Err struct {
	Status int
	Msg    string
}

func (e *s3Err) Error() string { return "S3: " + e.Msg }

// sign adds an AWS Signature V4 Authorization header.
func (c *s3Client) sign(req *http.Request, payloadHash string, now time.Time) {
	amzDate := now.Format("20060102T150405Z")
	day := now.Format("20060102")
	req.Header.Set("x-amz-date", amzDate)
	req.Header.Set("x-amz-content-sha256", payloadHash)
	req.Header.Set("Host", req.URL.Host)

	names := []string{"host", "x-amz-content-sha256", "x-amz-date"}
	var canonHeaders strings.Builder
	for _, h := range names {
		v := req.Header.Get(h)
		if h == "host" {
			v = req.URL.Host
		}
		canonHeaders.WriteString(h + ":" + strings.TrimSpace(v) + "\n")
	}
	signed := strings.Join(names, ";")

	q := req.URL.Query()
	keys := make([]string, 0, len(q))
	for k := range q {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var cq []string
	for _, k := range keys {
		for _, v := range q[k] {
			cq = append(cq, awsEscape(k, true)+"="+awsEscape(v, true))
		}
	}
	canon := strings.Join([]string{req.Method, awsEscape(req.URL.Path, false), strings.Join(cq, "&"), canonHeaders.String(), signed, payloadHash}, "\n")
	scope := day + "/" + c.region + "/s3/aws4_request"
	h := sha256.Sum256([]byte(canon))
	toSign := "AWS4-HMAC-SHA256\n" + amzDate + "\n" + scope + "\n" + hex.EncodeToString(h[:])
	k := hmacSHA([]byte("AWS4"+c.secretKey), day)
	k = hmacSHA(k, c.region)
	k = hmacSHA(k, "s3")
	k = hmacSHA(k, "aws4_request")
	sig := hex.EncodeToString(hmacSHA(k, toSign))
	req.Header.Set("Authorization", "AWS4-HMAC-SHA256 Credential="+c.accessKey+"/"+scope+", SignedHeaders="+signed+", Signature="+sig)
}

func hmacSHA(key []byte, s string) []byte {
	m := hmac.New(sha256.New, key)
	m.Write([]byte(s))
	return m.Sum(nil)
}

// awsEscape is URI encoding as SigV4 wants it: everything but unreserved
// characters, and "/" kept in paths.
func awsEscape(s string, encodeSlash bool) string {
	var b strings.Builder
	for _, c := range []byte(s) {
		switch {
		case 'A' <= c && c <= 'Z', 'a' <= c && c <= 'z', '0' <= c && c <= '9', c == '-', c == '_', c == '.', c == '~':
			b.WriteByte(c)
		case c == '/' && !encodeSlash:
			b.WriteByte(c)
		default:
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}

func (c *s3Client) put(ctx context.Context, key string, r io.Reader) (int64, error) {
	buf := make([]byte, s3PartSize)
	n, err := io.ReadFull(r, buf)
	if err == io.EOF || err == io.ErrUnexpectedEOF {
		// Small enough for one PUT.
		resp, err := c.do(ctx, "PUT", c.objectURL(key, nil), buf[:n])
		if err != nil {
			return 0, err
		}
		resp.Body.Close()
		return int64(n), nil
	}
	if err != nil {
		return 0, err
	}
	resp, err := c.do(ctx, "POST", c.objectURL(key, url.Values{"uploads": {""}}), nil)
	if err != nil {
		return 0, err
	}
	var init struct{ UploadId string }
	err = xml.NewDecoder(resp.Body).Decode(&init)
	resp.Body.Close()
	if err != nil || init.UploadId == "" {
		return 0, errors.New("S3: no upload id")
	}
	abort := func() {
		actx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if r, err := c.do(actx, "DELETE", c.objectURL(key, url.Values{"uploadId": {init.UploadId}}), nil); err == nil {
			r.Body.Close()
		}
	}
	type part struct {
		PartNumber int
		ETag       string
	}
	var parts []part
	var total int64
	for num := 1; n > 0; num++ {
		q := url.Values{"partNumber": {strconv.Itoa(num)}, "uploadId": {init.UploadId}}
		resp, err := c.do(ctx, "PUT", c.objectURL(key, q), buf[:n])
		if err != nil {
			abort()
			return 0, err
		}
		resp.Body.Close()
		parts = append(parts, part{num, resp.Header.Get("ETag")})
		total += int64(n)
		n, err = io.ReadFull(r, buf)
		if err != nil && err != io.EOF && err != io.ErrUnexpectedEOF {
			abort()
			return 0, err
		}
	}
	var body bytes.Buffer
	body.WriteString("<CompleteMultipartUpload>")
	for _, p := range parts {
		fmt.Fprintf(&body, "<Part><PartNumber>%d</PartNumber><ETag>%s</ETag></Part>", p.PartNumber, xmlEscape(p.ETag))
	}
	body.WriteString("</CompleteMultipartUpload>")
	resp, err = c.do(ctx, "POST", c.objectURL(key, url.Values{"uploadId": {init.UploadId}}), body.Bytes())
	if err != nil {
		abort()
		return 0, err
	}
	// Completion can fail with a 200 and an error body.
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	resp.Body.Close()
	if bytes.Contains(b, []byte("<Error>")) {
		abort()
		return 0, fmt.Errorf("S3: completing the upload failed: %s", b)
	}
	return total, nil
}

func xmlEscape(s string) string {
	var b bytes.Buffer
	_ = xml.EscapeText(&b, []byte(s))
	return b.String()
}

func (c *s3Client) get(ctx context.Context, key string) (io.ReadCloser, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", c.objectURL(key, nil).String(), nil)
	if err != nil {
		return nil, err
	}
	c.sign(req, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", time.Now().UTC())
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode >= 300 {
		resp.Body.Close()
		if resp.StatusCode == 404 {
			return nil, errNoBackup
		}
		return nil, &s3Err{resp.StatusCode, resp.Status}
	}
	return resp.Body, nil
}

func (c *s3Client) del(ctx context.Context, key string) error {
	resp, err := c.do(ctx, "DELETE", c.objectURL(key, nil), nil)
	if err != nil {
		return err
	}
	resp.Body.Close()
	return nil
}

func (c *s3Client) list(ctx context.Context, prefix string) ([]string, error) {
	var out []string
	token := ""
	for {
		q := url.Values{"list-type": {"2"}, "prefix": {prefix}}
		if token != "" {
			q.Set("continuation-token", token)
		}
		u := c.objectURL("", q)
		if !c.pathStyle {
			u.Path = strings.TrimRight(c.endpoint.Path, "/") + "/"
		}
		resp, err := c.do(ctx, "GET", u, nil)
		if err != nil {
			return nil, err
		}
		var r struct {
			Contents              []struct{ Key string }
			IsTruncated           bool
			NextContinuationToken string
		}
		err = xml.NewDecoder(resp.Body).Decode(&r)
		resp.Body.Close()
		if err != nil {
			return nil, err
		}
		for _, c := range r.Contents {
			out = append(out, c.Key)
		}
		if !r.IsTruncated || r.NextContinuationToken == "" {
			return out, nil
		}
		token = r.NextContinuationToken
	}
}
