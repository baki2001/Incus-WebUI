package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"slices"
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

func TestDueDays(t *testing.T) {
	sun := time.Date(2026, 11, 22, 9, 0, 0, 0, time.Local) // a Sunday
	st := scheduleState{Since: sun.Add(-72 * time.Hour)}
	weekdays := BackupSchedule{At: "03:00", Days: []int{1, 2, 3, 4, 5}}
	if due(weekdays, st, sun) {
		t.Error("a weekday schedule ran on Sunday")
	}
	if !due(weekdays, st, sun.AddDate(0, 0, 1)) {
		t.Error("a weekday schedule didn't run on Monday")
	}
	if !due(BackupSchedule{At: "03:00", Days: []int{}}, st, sun) {
		t.Error("no days must mean every day")
	}
}

func TestTestRestoreDay(t *testing.T) {
	for _, c := range []struct {
		days []int
		want time.Weekday
	}{{nil, time.Sunday}, {[]int{0, 3}, time.Sunday}, {[]int{5, 2}, time.Tuesday}} {
		if got := testRestoreDay(BackupSchedule{Days: c.days}); got != c.want {
			t.Errorf("%v: %v", c.days, got)
		}
	}
}

func TestValidDays(t *testing.T) {
	for d, want := range map[string]bool{"[]": true, "[0,6]": true, "[7]": false, "[1,1]": false, "[-1]": false} {
		var x []int
		json.Unmarshal([]byte(d), &x)
		if validDays(x) != want {
			t.Errorf("%s: want %v", d, want)
		}
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
	made, err := a.restoreBackup(ctx, c, st, "", *m, "default", name, "")
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		exec.Command("incus", "delete", "-f", name).Run()
		for _, pv := range made {
			exec.Command("incus", "storage", "volume", "delete", strings.Split(pv, "/")[0], strings.Split(pv, "/")[1]).Run()
		}
	}()
	if out, err := exec.Command("incus", "list", name, "-c", "n", "-f", "csv").Output(); err != nil || strings.TrimSpace(string(out)) != name {
		t.Fatalf("restored instance missing: %s %v", out, err)
	}
	exec.Command("incus", "delete", "-f", name).Run()

	// Flip a byte: the restore must fail and leave nothing behind.
	p := dirStore{dir}.path(m.Key + ".tar")
	b, _ := os.ReadFile(p)
	b[len(b)/2] ^= 0xff
	os.WriteFile(p, b, 0o600)
	if _, err := a.restoreBackup(ctx, c, st, "", *m, "default", name, ""); err == nil {
		t.Error("a damaged backup was restored")
	}
	if exec.Command("incus", "info", name).Run() == nil {
		t.Error("the failed restore left an instance")
	}
}

// TestBackupIncusVolumes backs up an instance with a custom volume attached
// to an encrypted target and restores both under new names.
func TestBackupIncusVolumes(t *testing.T) {
	if os.Getenv("INCUS_WEBUI_INCUS") == "" {
		t.Skip("INCUS_WEBUI_INCUS not set")
	}
	inst := os.Getenv("INCUS_WEBUI_BACKUP_INST")
	if inst == "" {
		inst = "c1"
	}
	run := func(args ...string) string {
		out, err := exec.Command("incus", args...).CombinedOutput()
		if err != nil {
			t.Fatalf("incus %v: %s", args, out)
		}
		return strings.TrimSpace(string(out))
	}
	exec.Command("incus", "config", "device", "remove", inst, "iwuidata").Run()
	exec.Command("incus", "storage", "volume", "delete", "default", "iwui-vol").Run()
	run("storage", "volume", "create", "default", "iwui-vol")
	run("config", "device", "add", inst, "iwuidata", "disk", "pool=default", "source=iwui-vol", "path=/iwui-data")
	defer func() {
		exec.Command("incus", "config", "device", "remove", inst, "iwuidata").Run()
		exec.Command("incus", "storage", "volume", "delete", "default", "iwui-vol").Run()
	}()

	a := testApp(t)
	a.backends = &Backends{transports: map[string]*backend{}}
	dir := t.TempDir()
	tgt := BackupTarget{Name: "safe", Type: "dir", Path: dir, Passphrase: "correct horse battery"}
	_ = a.store.Update(func(c *Config) error {
		c.Servers = []ServerConfig{{Name: "local", URL: "unix:///var/lib/incus/unix.socket"}}
		c.Backups.Targets = []BackupTarget{tgt}
		return nil
	})
	c, _ := a.conn("local")
	st := dirStore{dir}
	ctx := context.Background()
	m, err := a.backupInstance(ctx, c, tgt, st, "local", "default", inst, "", "t", func(float64, string) {})
	if err != nil {
		t.Fatal(err)
	}
	vi := slices.IndexFunc(m.Volumes, func(v VolumeMeta) bool { return v.Name == "iwui-vol" })
	if !m.Encrypted || vi < 0 || m.Volumes[vi].Size == 0 {
		t.Fatalf("meta = %+v", m)
	}
	for _, f := range m.files() {
		if _, err := os.Stat(st.path(f)); err != nil {
			t.Errorf("missing %s", f)
		}
	}
	raw, _ := os.ReadFile(st.path(m.dataFile()))
	if !bytes.HasPrefix(raw, []byte("age-encryption.org/v1")) {
		t.Error("the backup is not encrypted")
	}

	name := "iwui-vrestored"
	exec.Command("incus", "delete", "-f", name).Run()
	defer exec.Command("incus", "delete", "-f", name).Run()
	defer exec.Command("incus", "storage", "volume", "delete", "default", name+"-iwui-vol").Run()
	if _, err := a.restoreBackup(ctx, c, st, "wrong passphrase!", *m, "default", name, ""); err == nil || !strings.Contains(err.Error(), "passphrase") {
		t.Fatalf("a wrong passphrase: %v", err)
	}
	made, err := a.restoreBackup(ctx, c, st, tgt.Passphrase, *m, "default", name, "")
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		exec.Command("incus", "delete", "-f", name).Run()
		for _, pv := range made {
			exec.Command("incus", "storage", "volume", "delete", strings.Split(pv, "/")[0], strings.Split(pv, "/")[1]).Run()
		}
	}()
	if len(made) != len(m.Volumes) || !slices.Contains(made, "default/"+name+"-iwui-vol") {
		t.Errorf("made %v", made)
	}
	if got := run("config", "device", "get", name, "iwuidata", "source"); got != name+"-iwui-vol" {
		t.Errorf("restored instance uses volume %q", got)
	}
	if err := a.testRestore(ctx, c, st, tgt.Passphrase, *m); err != nil {
		t.Errorf("test restore: %v", err)
	}
	if out := run("storage", "volume", "list", "default", "-c", "n", "-f", "csv"); strings.Contains(out, "restore-test-") {
		t.Errorf("the test restore left a volume: %s", out)
	}
	if err := deleteBackupFiles(ctx, st, *m); err != nil {
		t.Fatal(err)
	}
	if l, _ := st.list(ctx, ""); len(l) != 0 {
		t.Errorf("left after delete: %v", l)
	}
}

// TestBackupsAllProjects lists every project's backups on a server, but only
// those of projects the user may view.
func TestBackupsAllProjects(t *testing.T) {
	a := testApp(t, "bob")
	dir := t.TempDir()
	_ = a.store.Update(func(c *Config) error {
		c.Backups.Targets = []BackupTarget{{Name: "disk", Type: "dir", Path: dir}}
		c.Access = []Access{{Who: "user:bob", Server: "lab", Project: "web", Role: "viewer"}}
		return nil
	})
	st := dirStore{dir}
	for _, k := range []string{"lab/web/a/20260101-000000", "lab/db/b/20260101-000000", "other/web/c/20260101-000000"} {
		m, _ := json.Marshal(BackupMeta{Created: time.Now(), Name: "snap1"})
		if _, err := st.put(context.Background(), k+".json", strings.NewReader(string(m))); err != nil {
			t.Fatal(err)
		}
	}
	ck := signedIn(t, a, "bob")
	get := func(url string) (int, []BackupMeta) {
		r := httptest.NewRequest("GET", url, nil)
		r.SetPathValue("server", "lab")
		r.AddCookie(ck)
		w := httptest.NewRecorder()
		a.handleBackups(w, r)
		var out struct{ Backups []BackupMeta }
		_ = json.Unmarshal(w.Body.Bytes(), &out)
		return w.Code, out.Backups
	}
	code, l := get("/x?project=*")
	if code != 200 || len(l) != 1 || l[0].Instance != "a" || l[0].Name != "snap1" {
		t.Errorf("all projects: %d %+v", code, l)
	}
	if code, _ := get("/x?project=db"); code != 403 {
		t.Errorf("project db without a role: %d", code)
	}
	if code, l := get("/x?project=web&instance=a"); code != 200 || len(l) != 1 {
		t.Errorf("one instance: %d %+v", code, l)
	}
}

func TestEncryptRoundTrip(t *testing.T) {
	st := dirStore{t.TempDir()}
	ctx := context.Background()
	data := bytes.Repeat([]byte("incus "), 200000)
	n, sum, err := putBackupFile(ctx, st, "a/b.tar.age", bytes.NewReader(data), "a long passphrase")
	if err != nil || n != int64(len(data)) {
		t.Fatalf("put: %d %v", n, err)
	}
	raw, _ := os.ReadFile(st.path("a/b.tar.age"))
	if bytes.Contains(raw, []byte("incus incus")) {
		t.Fatal("stored in the clear")
	}
	rc, err := openBackupFile(ctx, st, "a/b.tar.age", true, "a long passphrase")
	if err != nil {
		t.Fatal(err)
	}
	got, _ := io.ReadAll(&checkReader{r: rc, h: sha256.New(), want: sum})
	rc.Close()
	if !bytes.Equal(got, data) {
		t.Fatal("came back different")
	}
	if _, err := openBackupFile(ctx, st, "a/b.tar.age", true, "another passphrase"); err == nil || !strings.Contains(err.Error(), "passphrase") {
		t.Errorf("wrong passphrase: %v", err)
	}
	if _, err := openBackupFile(ctx, st, "a/b.tar.age", true, ""); err == nil {
		t.Error("no passphrase opened it")
	}
	// A failing store must not leave the encrypting goroutine stuck.
	if _, _, err := putBackupFile(ctx, failStore{}, "x", bytes.NewReader(data), "a long passphrase"); err == nil {
		t.Error("no error from a failing store")
	}
}

type failStore struct{ backupStore }

func (failStore) put(ctx context.Context, name string, r io.Reader) (int64, error) {
	buf := make([]byte, 10)
	r.Read(buf)
	return 0, errors.New("disk full")
}

func TestAttachedVolumes(t *testing.T) {
	v := attachedVolumes(map[string]map[string]string{
		"root": {"type": "disk", "path": "/", "pool": "default"},
		"data": {"type": "disk", "path": "/data", "pool": "fast", "source": "db"},
		"host": {"type": "disk", "path": "/mnt", "source": "/srv/share"},
		"snap": {"type": "disk", "path": "/old", "pool": "fast", "source": "db/snap0"},
		"eth0": {"type": "nic", "network": "incusbr0"},
		"app":  {"type": "disk", "path": "/app", "pool": "default", "source": "app"},
	})
	if len(v) != 2 || v[0].Device != "app" || v[1].Name != "db" || v[1].Pool != "fast" {
		t.Errorf("%+v", v)
	}
	m := BackupMeta{Key: "s/p/i/20260101-000000", Encrypted: true, Volumes: v}
	if f := m.files(); len(f) != 4 || f[0] != "s/p/i/20260101-000000.tar.age" || f[2] != "s/p/i/20260101-000000.vol1.tar.age" || f[3] != "s/p/i/20260101-000000.json" {
		t.Errorf("files %v", f)
	}
}
