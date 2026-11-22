package main

import (
	"encoding/json"
	"math"
	"net/http/httptest"
	"testing"
	"time"
)

const sampleMetrics = `# HELP incus_cpu_seconds_total The total number of CPU time used in seconds.
incus_cpu_seconds_total{cpu="0",mode="user",name="c1",project="default",type="container"} 10
incus_cpu_seconds_total{cpu="0",mode="system",name="c1",project="default",type="container"} 5
incus_cpu_seconds_total{cpu="0",mode="idle",name="c1",project="default",type="container"} 500
incus_memory_MemTotal_bytes{name="c1",project="default",type="container"} 1000
incus_memory_MemAvailable_bytes{name="c1",project="default",type="container"} 400
incus_network_receive_bytes_total{device="eth0",name="c1",project="default",type="container"} 6000
incus_network_receive_bytes_total{device="lo",name="c1",project="default",type="container"} 99999
incus_network_transmit_bytes_total{device="eth0",name="c2",project="web",type="container"} 100
incus_uptime_seconds 5
`

func TestParseMetrics(t *testing.T) {
	m := parseMetrics(sampleMetrics, time.Now())
	c1 := m["default/c1"]
	if c1.cpu != 15 || c1.mem != 600 || c1.rx != 6000 {
		t.Errorf("c1 = %+v", c1)
	}
	if m["web/c2"].tx != 100 {
		t.Errorf("c2 = %+v", m["web/c2"])
	}
	if len(m) != 2 {
		t.Errorf("got %d instances", len(m))
	}
}

func TestRecordAndRead(t *testing.T) {
	ms := &metricStore{dir: t.TempDir()}
	t0 := time.Unix(1_700_000_000, 0)
	at := func(i int) time.Time { return t0.Add(time.Duration(i) * time.Minute) }
	for i := 0; i < 5; i++ {
		ms.record("lab", map[string]sample{"default/c1": {cpu: float64(i * 30), mem: 100, rx: float64(i * 600), at: at(i)}})
	}
	ih := ms.servers["lab"].Insts["default/c1"]
	start, data := ih.Fine.read(at(1).Unix())
	if start != at(1).Unix()/60*60 || len(data[0]) != 4 {
		t.Fatalf("start %d, %d points", start, len(data[0]))
	}
	if data[0][0] != 0.5 || data[2][0] != 10 || data[1][3] != 100 {
		t.Errorf("cpu %v rx %v mem %v", data[0], data[2], data[1])
	}
	// A gap of 3 minutes leaves NaN behind.
	ms.record("lab", map[string]sample{"default/c1": {cpu: 300, mem: 100, rx: 3000, at: at(8)}})
	_, data = ih.Fine.read(at(1).Unix())
	if len(data[0]) != 8 || !math.IsNaN(float64(data[0][4])) {
		t.Errorf("after gap: %v", data[0])
	}
	// Save and load again.
	ms.save()
	ms2 := &metricStore{dir: ms.dir}
	h := ms2.server("lab")
	_, d2 := h.Insts["default/c1"].Fine.read(at(1).Unix())
	if len(d2[0]) != 8 || !math.IsNaN(float64(d2[0][4])) || d2[0][0] != 0.5 {
		t.Errorf("after reload: %v", d2[0])
	}
}

func TestMetricsRespectRoles(t *testing.T) {
	a := testApp(t, "bob")
	a.metrics = &metricStore{dir: t.TempDir()}
	_ = a.store.Update(func(c *Config) error {
		c.Access = []Access{{Who: "user:bob", Server: "lab", Project: "web", Role: "viewer"}}
		return nil
	})
	now := time.Now()
	for i := 0; i < 3; i++ {
		ts := now.Add(time.Duration(i-3) * time.Minute)
		a.metrics.record("lab", map[string]sample{
			"default/c1": {cpu: float64(i * 60), at: ts},
			"web/c2":     {cpu: float64(i * 120), at: ts},
		})
	}
	ck := signedIn(t, a, "bob")
	get := func(url string) (int, map[string]any) {
		r := httptest.NewRequest("GET", url, nil)
		r.SetPathValue("server", "lab")
		r.AddCookie(ck)
		w := httptest.NewRecorder()
		a.handleMetrics(w, r)
		var out map[string]any
		_ = json.Unmarshal(w.Body.Bytes(), &out)
		return w.Code, out
	}
	if code, _ := get("/api/ui/metrics/lab?instance=c1&project=default"); code != 403 {
		t.Errorf("other project's instance gave %d", code)
	}
	code, out := get("/api/ui/metrics/lab")
	if code != 200 || out["instances"].(float64) != 1 {
		t.Errorf("host sum covered %v instances, want only the one bob may see", out["instances"])
	}
}
