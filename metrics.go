package main

// Metric history. Every minute the backend reads /1.0/metrics from each
// server and keeps, per instance, the last 24 hours by the minute and the
// last 7 days by 10 minutes. It is saved to <data>/metrics/<server>.json.gz
// every 10 minutes, so a restart loses at most that much.

import (
	"bufio"
	"compress/gzip"
	"context"
	"encoding/json"
	"io"
	"log"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	fineStep    = 60         // seconds
	finePoints  = 24 * 60    // 24 hours
	coarseStep  = 600        // 10 minutes
	coarsePoint = 7 * 24 * 6 // 7 days
)

// Series names, in the order of the arrays in a ring.
var metricNames = []string{"cpu", "mem", "rx", "tx", "rd", "wr"}

const nSeries = 6

// ring keeps one fixed-size buffer of points per series. Slot i holds time
// start+i*step modulo the buffer length; missing points are NaN.
type ring struct {
	Step int64              `json:"step"`
	Last int64              `json:"last"` // unix time of the newest slot
	Data [nSeries][]float32 `json:"data"`
}

func newRing(step int64, n int) *ring {
	r := &ring{Step: step}
	for i := range r.Data {
		r.Data[i] = make([]float32, n)
		for j := range r.Data[i] {
			r.Data[i][j] = float32(math.NaN())
		}
	}
	return r
}

func (r *ring) slot(t int64) int { return int((t / r.Step) % int64(len(r.Data[0]))) }

// put writes values at time t, clearing slots skipped since the last write.
func (r *ring) put(t int64, v [nSeries]float64) {
	t = t / r.Step * r.Step
	n := int64(len(r.Data[0]))
	if r.Last != 0 && t > r.Last {
		gap := (t - r.Last) / r.Step
		for k := int64(1); k < gap && k <= n; k++ {
			s := r.slot(r.Last + k*r.Step)
			for i := range r.Data {
				r.Data[i][s] = float32(math.NaN())
			}
		}
	}
	if t >= r.Last {
		r.Last = t
	}
	s := r.slot(t)
	for i := range r.Data {
		r.Data[i][s] = float32(v[i])
	}
}

// read returns points from since to Last, oldest first.
func (r *ring) read(since int64) (start int64, out [nSeries][]float32) {
	n := int64(len(r.Data[0]))
	if r.Last == 0 {
		return 0, out
	}
	first := max(since/r.Step*r.Step, r.Last-(n-1)*r.Step)
	for t := first; t <= r.Last; t += r.Step {
		s := r.slot(t)
		for i := range out {
			out[i] = append(out[i], r.Data[i][s])
		}
	}
	return first, out
}

type instHistory struct {
	Fine   *ring `json:"fine"`
	Coarse *ring `json:"coarse"`
	// running sums for the current coarse slot
	acc   [nSeries]float64
	accN  [nSeries]int
	accAt int64
}

type sample struct {
	cpu, mem, rx, tx, rd, wr float64 // counters for cpu (seconds) and bytes; mem is a level
	at                       time.Time
}

type serverHistory struct {
	Insts map[string]*instHistory `json:"insts"` // "project/name"
	prev  map[string]sample
}

type metricStore struct {
	mu      sync.Mutex
	dir     string
	servers map[string]*serverHistory
}

func (m *metricStore) server(name string) *serverHistory {
	if m.servers == nil {
		m.servers = map[string]*serverHistory{}
	}
	h := m.servers[name]
	if h == nil {
		h = &serverHistory{Insts: map[string]*instHistory{}, prev: map[string]sample{}}
		m.load(name, h)
		m.servers[name] = h
	}
	return h
}

func (m *metricStore) path(server string) string {
	return filepath.Join(m.dir, server+".json.gz")
}

func (m *metricStore) load(server string, h *serverHistory) {
	f, err := os.Open(m.path(server))
	if err != nil {
		return
	}
	defer f.Close()
	g, err := gzip.NewReader(f)
	if err != nil {
		return
	}
	var saved serverHistory
	if json.NewDecoder(g).Decode(&saved) == nil && saved.Insts != nil {
		for k, v := range saved.Insts {
			if v.Fine != nil && v.Coarse != nil && len(v.Fine.Data[0]) == finePoints && len(v.Coarse.Data[0]) == coarsePoint {
				restoreNaN(v.Fine)
				restoreNaN(v.Coarse)
				h.Insts[k] = v
			}
		}
	}
}

// NaN can't go through JSON, so the files store it as a sentinel.
const nanSentinel = -1

func (m *metricStore) save() {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := os.MkdirAll(m.dir, 0o700); err != nil {
		return
	}
	for name, h := range m.servers {
		tmp := m.path(name) + ".tmp"
		f, err := os.Create(tmp)
		if err != nil {
			continue
		}
		g := gzip.NewWriter(f)
		err = json.NewEncoder(g).Encode(nanSafe(h))
		if cerr := g.Close(); err == nil {
			err = cerr
		}
		if cerr := f.Close(); err == nil {
			err = cerr
		}
		if err == nil {
			err = os.Rename(tmp, m.path(name))
		}
		if err != nil {
			log.Printf("metrics: saving %s: %v", name, err)
			_ = os.Remove(tmp)
		}
	}
}

// nanSafe copies the history with NaN replaced, since JSON has no NaN.
func nanSafe(h *serverHistory) *serverHistory {
	out := &serverHistory{Insts: map[string]*instHistory{}}
	cp := func(r *ring) *ring {
		c := &ring{Step: r.Step, Last: r.Last}
		for i := range r.Data {
			c.Data[i] = make([]float32, len(r.Data[i]))
			for j, v := range r.Data[i] {
				if v != v {
					v = nanSentinel
				}
				c.Data[i][j] = v
			}
		}
		return c
	}
	for k, v := range h.Insts {
		out.Insts[k] = &instHistory{Fine: cp(v.Fine), Coarse: cp(v.Coarse)}
	}
	return out
}

func restoreNaN(r *ring) {
	for i := range r.Data {
		for j, v := range r.Data[i] {
			if v == nanSentinel {
				r.Data[i][j] = float32(math.NaN())
			}
		}
	}
}

// parseMetrics reads the OpenMetrics text Incus serves into per-instance
// counters. Keys are "project/name".
func parseMetrics(body string, at time.Time) map[string]sample {
	out := map[string]sample{}
	memTotal, memAvail := map[string]float64{}, map[string]float64{}
	sc := bufio.NewScanner(strings.NewReader(body))
	sc.Buffer(make([]byte, 64*1024), 4<<20)
	for sc.Scan() {
		line := sc.Text()
		if line == "" || line[0] == '#' {
			continue
		}
		name, rest, ok := strings.Cut(line, "{")
		if !ok {
			continue
		}
		labels, val, ok := strings.Cut(rest, "} ")
		if !ok {
			continue
		}
		v, err := strconv.ParseFloat(strings.Fields(val)[0], 64)
		if err != nil {
			continue
		}
		lb := parseLabels(labels)
		inst := lb["name"]
		if inst == "" {
			continue
		}
		key := lb["project"] + "/" + inst
		s := out[key]
		s.at = at
		switch name {
		case "incus_cpu_seconds_total":
			if lb["mode"] != "idle" && lb["mode"] != "iowait" {
				s.cpu += v
			}
		case "incus_memory_MemTotal_bytes":
			memTotal[key] = v
		case "incus_memory_MemAvailable_bytes":
			memAvail[key] = v
		case "incus_network_receive_bytes_total":
			if lb["device"] != "lo" {
				s.rx += v
			}
		case "incus_network_transmit_bytes_total":
			if lb["device"] != "lo" {
				s.tx += v
			}
		case "incus_disk_read_bytes_total":
			s.rd += v
		case "incus_disk_written_bytes_total":
			s.wr += v
		}
		out[key] = s
	}
	for k, s := range out {
		if t, ok := memTotal[k]; ok {
			s.mem = t - memAvail[k]
		}
		out[k] = s
	}
	return out
}

func parseLabels(s string) map[string]string {
	out := map[string]string{}
	for s != "" {
		k, rest, ok := strings.Cut(s, `="`)
		if !ok {
			break
		}
		var v strings.Builder
		i := 0
		for ; i < len(rest); i++ {
			if rest[i] == '\\' && i+1 < len(rest) {
				i++
				v.WriteByte(rest[i])
				continue
			}
			if rest[i] == '"' {
				break
			}
			v.WriteByte(rest[i])
		}
		out[strings.TrimLeft(k, ", ")] = v.String()
		if i+1 >= len(rest) {
			break
		}
		s = rest[i+1:]
	}
	return out
}

// record turns counters into rates against the previous sample and stores them.
func (m *metricStore) record(server string, now map[string]sample) {
	m.mu.Lock()
	defer m.mu.Unlock()
	h := m.server(server)
	for key, s := range now {
		p, ok := h.prev[key]
		h.prev[key] = s
		if !ok {
			continue
		}
		dt := s.at.Sub(p.at).Seconds()
		if dt <= 0 {
			continue
		}
		rate := func(a, b float64) float64 {
			if a < b { // counter reset (instance restarted)
				return math.NaN()
			}
			return (a - b) / dt
		}
		v := [nSeries]float64{rate(s.cpu, p.cpu), s.mem, rate(s.rx, p.rx), rate(s.tx, p.tx), rate(s.rd, p.rd), rate(s.wr, p.wr)}
		ih := h.Insts[key]
		if ih == nil {
			ih = &instHistory{Fine: newRing(fineStep, finePoints), Coarse: newRing(coarseStep, coarsePoint)}
			h.Insts[key] = ih
		}
		t := s.at.Unix()
		ih.Fine.put(t, v)
		slot := t / coarseStep * coarseStep
		if ih.accAt != slot {
			ih.acc, ih.accN, ih.accAt = [nSeries]float64{}, [nSeries]int{}, slot
		}
		var avg [nSeries]float64
		for i, x := range v {
			if !math.IsNaN(x) {
				ih.acc[i] += x
				ih.accN[i]++
			}
			avg[i] = math.NaN()
			if ih.accN[i] > 0 {
				avg[i] = ih.acc[i] / float64(ih.accN[i])
			}
		}
		ih.Coarse.put(t, avg)
	}
	// Instances that are gone: forget their previous counters, keep history.
	for key := range h.prev {
		if _, ok := now[key]; !ok {
			delete(h.prev, key)
		}
	}
}

// forget drops history of instances that no longer exist on any server, a
// week after they were last seen.
func (m *metricStore) prune() {
	m.mu.Lock()
	defer m.mu.Unlock()
	cut := time.Now().Add(-7 * 24 * time.Hour).Unix()
	for _, h := range m.servers {
		for k, ih := range h.Insts {
			if ih.Fine.Last < cut && ih.Coarse.Last < cut {
				delete(h.Insts, k)
			}
		}
	}
}

func (a *App) collectMetrics(ctx context.Context) {
	tick := time.NewTicker(fineStep * time.Second)
	defer tick.Stop()
	n := 0
	for {
		for _, s := range a.store.Get().Servers {
			c, err := a.conn(s.Name)
			if err != nil {
				continue
			}
			cctx, cancel := context.WithTimeout(ctx, 20*time.Second)
			resp, err := c.do(cctx, "GET", "/1.0/metrics", "", nil, nil)
			if err == nil {
				var b strings.Builder
				if resp.StatusCode == 200 {
					_, _ = io.Copy(&b, io.LimitReader(resp.Body, 64<<20))
					a.metrics.record(s.Name, parseMetrics(b.String(), time.Now()))
				}
				resp.Body.Close()
			}
			cancel()
		}
		n++
		if n%10 == 0 {
			a.metrics.prune()
			a.metrics.save()
		}
		select {
		case <-ctx.Done():
			a.metrics.save()
			return
		case <-tick.C:
		}
	}
}

// handleMetrics answers GET /api/ui/metrics/{server}?project=p&instance=n&range=1h|24h|7d.
// Without instance it sums every instance the user may see on the server.
func (a *App) handleMetrics(w http.ResponseWriter, r *http.Request) {
	server := r.PathValue("server")
	if _, ok := a.server(server); !ok {
		jsonError(w, http.StatusNotFound, "unknown server")
		return
	}
	q := r.URL.Query()
	rng := q.Get("range")
	span := map[string]int64{"1h": 3600, "24h": 86400, "7d": 7 * 86400}[rng]
	if span == 0 {
		span, rng = 3600, "1h"
	}
	s, _ := a.currentSession(r)
	access := a.store.Get().Access
	inst, project := q.Get("instance"), q.Get("project")
	if project == "" {
		project = "default"
	}
	if inst != "" && roleFor(access, s, server, project) < RoleViewer {
		jsonError(w, http.StatusForbidden, deniedMsg(RoleViewer, project))
		return
	}
	since := time.Now().Unix() - span
	a.metrics.mu.Lock()
	h := a.metrics.server(server)
	var start, step int64
	var sum [nSeries][]float64
	count := 0
	for key, ih := range h.Insts {
		p, n, _ := strings.Cut(key, "/")
		if inst != "" && (p != project || n != inst) {
			continue
		}
		if inst == "" && roleFor(access, s, server, p) < RoleViewer {
			continue
		}
		rg := ih.Fine
		if rng == "7d" {
			rg = ih.Coarse
		}
		st, data := rg.read(since)
		if st == 0 {
			continue
		}
		start, step = alignSum(&sum, start, st, rg.Step, data)
		count++
	}
	a.metrics.mu.Unlock()
	out := map[string]any{"start": start, "step": step, "range": rng, "instances": count}
	series := map[string][]*float64{}
	for i, name := range metricNames {
		pts := make([]*float64, len(sum[i]))
		for j, v := range sum[i] {
			if !math.IsNaN(v) {
				x := v
				pts[j] = &x
			}
		}
		series[name] = pts
	}
	out["series"] = series
	writeJSON(w, out)
}

// alignSum adds data (starting at st) into sum (starting at start), both
// with the same step, growing sum as needed. Missing values stay NaN unless
// some instance has a value there.
func alignSum(sum *[nSeries][]float64, start, st, step int64, data [nSeries][]float32) (int64, int64) {
	if start == 0 {
		start = st
	}
	if st < start {
		shift := int((start - st) / step)
		for i := range sum {
			pre := make([]float64, shift)
			for j := range pre {
				pre[j] = math.NaN()
			}
			sum[i] = append(pre, sum[i]...)
		}
		start = st
	}
	off := int((st - start) / step)
	for i := range sum {
		need := off + len(data[i])
		for len(sum[i]) < need {
			sum[i] = append(sum[i], math.NaN())
		}
		for j, v := range data[i] {
			if v != v {
				continue
			}
			if math.IsNaN(sum[i][off+j]) {
				sum[i][off+j] = 0
			}
			sum[i][off+j] += float64(v)
		}
	}
	return start, step
}
