package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

// The "list objects" example from the AWS Signature V4 documentation.
func TestSigV4(t *testing.T) {
	c := &s3Client{region: "us-east-1", accessKey: "AKIAIOSFODNN7EXAMPLE", secretKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"}
	u, _ := url.Parse("https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J")
	req, _ := http.NewRequest("GET", u.String(), nil)
	c.sign(req, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", time.Date(2013, 5, 24, 0, 0, 0, 0, time.UTC))
	want := "Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7"
	if got := req.Header.Get("Authorization"); !strings.HasSuffix(got, want) {
		t.Errorf("Authorization = %s", got)
	}
}

func TestPrune(t *testing.T) {
	sc := BackupSchedule{Name: "s", KeepDaily: 3, KeepWeekly: 2}
	var list []BackupMeta
	start := time.Date(2026, 11, 1, 3, 0, 0, 0, time.Local) // a Sunday
	for d := 0; d < 21; d++ {
		at := start.AddDate(0, 0, d)
		list = append(list, BackupMeta{Key: at.Format(backupTimeFmt), Created: at, Schedule: "s"})
	}
	list = append(list, BackupMeta{Key: "manual", Created: start, Schedule: ""})
	drop := prune(list, sc)
	kept := map[string]bool{}
	for _, m := range list {
		kept[m.Key] = true
	}
	for _, m := range drop {
		delete(kept, m.Key)
	}
	// 3 days (Nov 19-21) plus the newest of the week before (Nov 15), and the manual one.
	for _, k := range []string{"20261121-030000", "20261120-030000", "20261119-030000", "20261115-030000", "manual"} {
		if !kept[k] {
			t.Errorf("%s was dropped", k)
		}
	}
	if len(kept) != 5 {
		t.Errorf("kept %d: %v", len(kept), kept)
	}
	if len(prune(list[:1], BackupSchedule{Name: "s", KeepDaily: 0})) != 0 {
		t.Error("the newest backup must stay")
	}
}

func TestDue(t *testing.T) {
	sc := BackupSchedule{At: "03:00"}
	day := time.Date(2026, 11, 22, 0, 0, 0, 0, time.Local)
	cases := []struct {
		now, last time.Time
		want      bool
	}{
		{day.Add(2 * time.Hour), time.Time{}, false},
		{day.Add(3 * time.Hour), time.Time{}, true},
		{day.Add(9 * time.Hour), day.Add(-21 * time.Hour), true}, // missed while down
		{day.Add(9 * time.Hour), day.Add(3 * time.Hour), false},
	}
	for _, c := range cases {
		if got := due(sc, scheduleState{LastRun: c.last, Since: day.Add(-48 * time.Hour)}, c.now); got != c.want {
			t.Errorf("now %v last %v = %v", c.now, c.last, got)
		}
	}
	if due(sc, scheduleState{Since: day.Add(4 * time.Hour)}, day.Add(9*time.Hour)) {
		t.Error("a schedule added after its time ran the same day")
	}
}

func testStore(t *testing.T, st backupStore) {
	ctx := context.Background()
	big := make([]byte, s3PartSize*2+12345)
	rand.Read(big)
	for name, data := range map[string][]byte{"a/b/small": []byte("hello"), "a/b/big": big} {
		if n, err := st.put(ctx, name, bytes.NewReader(data)); err != nil || n != int64(len(data)) {
			t.Fatalf("put %s: %d %v", name, n, err)
		}
		r, err := st.get(ctx, name)
		if err != nil {
			t.Fatal(err)
		}
		got, _ := io.ReadAll(r)
		r.Close()
		if !bytes.Equal(got, data) {
			t.Errorf("%s came back different", name)
		}
	}
	l, err := st.list(ctx, "a/")
	if err != nil || len(l) != 2 {
		t.Errorf("list = %v %v", l, err)
	}
	for _, n := range l {
		if err := st.del(ctx, n); err != nil {
			t.Error(err)
		}
	}
	if _, err := st.get(ctx, "a/b/small"); err != errNoBackup {
		t.Errorf("get after delete: %v", err)
	}
}

func TestDirStore(t *testing.T) { testStore(t, dirStore{t.TempDir()}) }

// TestS3Store needs an S3 server: INCUS_WEBUI_S3=http://key:secret@host:9000/bucket
func TestS3Store(t *testing.T) {
	env := os.Getenv("INCUS_WEBUI_S3")
	if env == "" {
		t.Skip("INCUS_WEBUI_S3 not set")
	}
	u, _ := url.Parse(env)
	secret, _ := u.User.Password()
	tgt := BackupTarget{Type: "s3", Endpoint: u.Scheme + "://" + u.Host, Bucket: strings.Trim(u.Path, "/"), AccessKey: u.User.Username(), SecretKey: secret, Prefix: "pre/fix"}
	st, err := openTarget(tgt)
	if err != nil {
		t.Fatal(err)
	}
	// Make the bucket; an error means it exists.
	c, _ := newS3(tgt)
	bu := *c.endpoint
	bu.Path = "/" + c.bucket
	if r, err := c.do(context.Background(), "PUT", &bu, nil); err == nil {
		r.Body.Close()
	}
	testStore(t, st)
}

// TestBackupIncus backs up instance c1 (or INCUS_WEBUI_BACKUP_INST) of the
// local Incus to a directory, restores it under a new name, and checks that
// a damaged backup is refused.
func TestBackupIncus(t *testing.T) {
	if os.Getenv("INCUS_WEBUI_INCUS") == "" {
		t.Skip("INCUS_WEBUI_INCUS not set")
	}
	inst := os.Getenv("INCUS_WEBUI_BACKUP_INST")
	if inst == "" {
		inst = "c1"
	}
	a := testApp(t)
	a.dataDir = t.TempDir()
	a.backends = &Backends{transports: map[string]*backend{}}
	dir := t.TempDir()
	tgt := BackupTarget{Name: "disk", Type: "dir", Path: dir}
	_ = a.store.Update(func(c *Config) error {
		c.Servers = []ServerConfig{{Name: "local", URL: "unix:///var/lib/incus/unix.socket"}}
		c.Backups.Targets = []BackupTarget{tgt}
		return nil
	})
	c, _ := a.conn("local")
	_, st, err := a.backupTarget("disk")
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	m, err := a.backupInstance(ctx, c, tgt, st, "local", "default", inst, "", "t", func(float64, string) {})
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("backup: %+v", m)
	l, err := listBackups(ctx, st, "disk", "local/default/"+inst+"/")
	if err != nil || len(l) != 1 || l[0].SHA256 != m.SHA256 {
		t.Fatalf("list = %+v %v", l, err)
	}
	if out, _ := exec.Command("incus", "query", "/1.0/instances/"+inst+"/backups").Output(); strings.Contains(string(out), "iwui-") {
		t.Error("the Incus-side backup was left behind")
	}
	name := "iwui-restored"
	exec.Command("incus", "delete", "-f", name).Run()
	defer exec.Command("incus", "delete", "-f", name).Run()
	if err := a.restoreBackup(ctx, c, st, *m, "default", name, ""); err != nil {
		t.Fatal(err)
	}
	if out, err := exec.Command("incus", "list", name, "-c", "n", "-f", "csv").Output(); err != nil || strings.TrimSpace(string(out)) != name {
		t.Fatalf("restored instance missing: %s %v", out, err)
	}
	exec.Command("incus", "delete", "-f", name).Run()

	// Flip a byte: the restore must fail and leave nothing behind.
	p := dirStore{dir}.path(m.Key + ".tar")
	b, _ := os.ReadFile(p)
	b[len(b)/2] ^= 0xff
	os.WriteFile(p, b, 0o600)
	if err := a.restoreBackup(ctx, c, st, *m, "default", name, ""); err == nil {
		t.Error("a damaged backup was restored")
	}
	if exec.Command("incus", "info", name).Run() == nil {
		t.Error("the failed restore left an instance")
	}
}
