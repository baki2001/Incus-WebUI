package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// WireGuard tunnels. WireGuard never runs on the Incus host: the UI creates a
// small gateway container, writes its config through the Incus file API and
// runs everything inside it with argv-array exec calls. The gateway's private
// key is generated inside the gateway and never leaves it. Client private keys
// are generated in the browser; this server only ever sees public keys (and
// the preshared key, which both ends need).

const (
	tunnelKey    = "user.incus-webui.tunnel" // "remote-access" | "vps" | "monitor"
	kindRemote   = "remote-access"
	kindVPS      = "vps"
	kindMonitor  = "monitor"
	noKernelText = "WireGuard isn't available in this kernel. Load the wireguard module on the Incus host (modprobe wireguard) and try again."
)

var (
	nameRe     = regexp.MustCompile(`^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$`)
	projectRe  = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$`)
	ifaceRe    = regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9_-]{0,14}$`)
	peerNameRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9 ._-]{0,31}$`)
	imageRe    = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9/._:-]{0,127}$`)
	hostRe     = regexp.MustCompile(`^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$`)
)

// --- validation -------------------------------------------------------------

func validKey(k string) bool {
	b, err := base64.StdEncoding.DecodeString(k)
	return err == nil && len(b) == 32 && len(k) == 44
}

func validPort(p int) bool { return p >= 1 && p <= 65535 }

// validHost accepts an IP address or a DNS name (no port, no brackets).
func validHost(h string) bool {
	if _, err := netip.ParseAddr(h); err == nil {
		return true
	}
	return hostRe.MatchString(h) && strings.Contains(h, ".") && !strings.Contains(h, "..")
}

func hostPortStr(host string, port int) string {
	if a, err := netip.ParseAddr(host); err == nil && a.Is6() {
		return "[" + host + "]:" + strconv.Itoa(port)
	}
	return host + ":" + strconv.Itoa(port)
}

// parseSubnet returns a masked IPv4 prefix.
func parseSubnet(s string) (netip.Prefix, error) {
	p, err := netip.ParsePrefix(strings.TrimSpace(s))
	if err != nil || !p.Addr().Is4() {
		return p, fmt.Errorf("%q isn't an IPv4 subnet like 10.66.0.0/24", s)
	}
	return p.Masked(), nil
}

// parseTunnelSubnet checks the subnet used inside the tunnel itself.
func parseTunnelSubnet(s string) (netip.Prefix, error) {
	p, err := parseSubnet(s)
	if err != nil {
		return p, err
	}
	if p.Bits() < 16 || p.Bits() > 29 {
		return p, errors.New("The tunnel subnet must be between /16 and /29.")
	}
	if !p.Addr().IsPrivate() {
		return p, errors.New("The tunnel subnet must be a private range such as 10.66.0.0/24.")
	}
	return p, nil
}

func overlaps(a, b netip.Prefix) bool { return a.Overlaps(b) }

func hostN(p netip.Prefix, n int) netip.Addr {
	a := p.Addr()
	for i := 0; i < n; i++ {
		a = a.Next()
	}
	return a
}

// --- config text -----------------------------------------------------------

type confOpts struct {
	Kind     string
	Iface    string
	Address  netip.Prefix // gateway address inside the tunnel, e.g. 10.66.0.1/24
	Port     int          // listen port, 0 = none
	Endpoint string       // public host:port clients dial (remote access)
	Routes   []netip.Prefix
	Tunnel   netip.Prefix
	HostIPs  []netip.Addr  // Incus host's own bridge addresses, never reachable from the tunnel
	Publish  []publishRule // vps kind: the ports published on the VPS
}

func addrList(as []netip.Addr) string {
	s := make([]string, len(as))
	for i, a := range as {
		s[i] = a.String()
	}
	return strings.Join(s, ", ")
}

// publishList is the "proto/port>ip:port" form kept in the conf header.
func publishList(rs []publishRule) string {
	s := make([]string, len(rs))
	for i, r := range rs {
		s[i] = fmt.Sprintf("%s/%d>%s:%d", r.Proto, r.Port, r.TargetIP, r.TargetPort)
	}
	return strings.Join(s, ", ")
}

// parsePublishList reads publishList back; bad entries are skipped.
func parsePublishList(s string) []publishRule {
	var out []publishRule
	for _, e := range strings.Split(s, ",") {
		left, right, ok := strings.Cut(strings.TrimSpace(e), ">")
		if !ok {
			continue
		}
		proto, ps, ok1 := strings.Cut(left, "/")
		ip, tps, ok2 := strings.Cut(right, ":")
		port, err1 := strconv.Atoi(ps)
		tp, err2 := strconv.Atoi(tps)
		if !ok1 || !ok2 || err1 != nil || err2 != nil {
			continue
		}
		if _, err := netip.ParseAddr(ip); err != nil || (proto != "tcp" && proto != "udp") {
			continue
		}
		out = append(out, publishRule{Proto: proto, Port: port, TargetIP: ip, TargetPort: tp})
	}
	return out
}

func prefixList(ps []netip.Prefix) string {
	s := make([]string, len(ps))
	for i, p := range ps {
		s[i] = p.String()
	}
	return strings.Join(s, ", ")
}

// gatewayConf is the [Interface] part of the gateway config. The private key
// is not in the file: PostUp loads it from a key file that was generated in
// the gateway.
func gatewayConf(o confOpts) string {
	var b strings.Builder
	b.WriteString("[Interface]\n")
	b.WriteString("# Managed by Incus WebUI. Peers can be changed in the UI.\n")
	fmt.Fprintf(&b, "# kind: %s\n", o.Kind)
	if o.Endpoint != "" {
		fmt.Fprintf(&b, "# endpoint: %s\n", o.Endpoint)
	}
	fmt.Fprintf(&b, "# routes: %s\n", prefixList(o.Routes))
	if len(o.HostIPs) > 0 {
		fmt.Fprintf(&b, "# hosts: %s\n", addrList(o.HostIPs))
	}
	if len(o.Publish) > 0 {
		fmt.Fprintf(&b, "# publish: %s\n", publishList(o.Publish))
	}
	fmt.Fprintf(&b, "Address = %s\n", o.Address)
	if o.Port > 0 {
		fmt.Fprintf(&b, "ListenPort = %d\n", o.Port)
	}
	b.WriteString("PostUp = wg set %i private-key /etc/wireguard/private.key\n")
	b.WriteString("PostUp = sysctl -w net.ipv4.ip_forward=1\n")
	b.WriteString("PostUp = nft -f /etc/wireguard/%i.nft\n")
	b.WriteString("PostDown = nft delete table inet wg_gateway\n")
	return b.String()
}

// peerBlock is one [Peer] section. The name is a comment so that plain
// wg-quick tools ignore it.
func peerBlock(name, pub, psk, endpoint, allowed string, keepalive int) string {
	var b strings.Builder
	b.WriteString("\n[Peer]\n")
	fmt.Fprintf(&b, "# name: %s\n", name)
	fmt.Fprintf(&b, "PublicKey = %s\n", pub)
	if psk != "" {
		fmt.Fprintf(&b, "PresharedKey = %s\n", psk)
	}
	if endpoint != "" {
		fmt.Fprintf(&b, "Endpoint = %s\n", endpoint)
	}
	fmt.Fprintf(&b, "AllowedIPs = %s\n", allowed)
	if keepalive > 0 {
		fmt.Fprintf(&b, "PersistentKeepalive = %d\n", keepalive)
	}
	return b.String()
}

// gatewayNft forwards only from the tunnel to the chosen subnets and
// masquerades, so the chosen networks need no route back to the tunnel. The
// Incus host's own bridge addresses are dropped first. For a VPS tunnel
// (vpsIP valid) only the VPS may reach only the published ip/port tuples.
// Nothing coming in through the tunnel may talk to the gateway itself, except
// replies and ping.
func gatewayNft(iface string, routes []netip.Prefix, hostIPs []netip.Addr, vpsIP netip.Addr, publish []publishRule) string {
	var fwd strings.Builder
	if len(hostIPs) > 0 {
		fmt.Fprintf(&fwd, "\t\tiifname \"%s\" ip daddr { %s } drop\n", iface, addrList(hostIPs))
	}
	if vpsIP.IsValid() {
		for _, r := range publish {
			fmt.Fprintf(&fwd, "\t\tiifname \"%s\" ip saddr %s ip daddr %s %s dport %d accept\n", iface, vpsIP, r.TargetIP, r.Proto, r.TargetPort)
		}
	} else {
		fmt.Fprintf(&fwd, "\t\tiifname \"%s\" ip daddr { %s } accept\n", iface, prefixList(routes))
	}
	return fmt.Sprintf(`add table inet wg_gateway
delete table inet wg_gateway
table inet wg_gateway {
	chain input {
		type filter hook input priority 0; policy accept;
		iifname "%[1]s" ct state established,related accept
		iifname "%[1]s" icmp type echo-request accept
		iifname "%[1]s" drop
	}
	chain forward {
		type filter hook forward priority 0; policy drop;
		ct state established,related accept
%[2]s	}
	chain postrouting {
		type nat hook postrouting priority 100; policy accept;
		iifname "%[1]s" oifname != "%[1]s" masquerade
	}
}
`, iface, fwd.String())
}

// clientConf is what a laptop or phone imports. The two secrets are
// placeholders: the browser holds them and fills them in.
const (
	phPrivate = "@PRIVATE_KEY@"
	phPSK     = "@PRESHARED_KEY@"
	phVPSKey  = "@VPS_PRIVATE_KEY@"
)

func clientConf(addr netip.Addr, serverPub, endpoint string, allowed []netip.Prefix, withPSK bool) string {
	var b strings.Builder
	b.WriteString("[Interface]\n")
	fmt.Fprintf(&b, "PrivateKey = %s\n", phPrivate)
	fmt.Fprintf(&b, "Address = %s/32\n\n", addr)
	b.WriteString("[Peer]\n")
	fmt.Fprintf(&b, "PublicKey = %s\n", serverPub)
	if withPSK {
		fmt.Fprintf(&b, "PresharedKey = %s\n", phPSK)
	}
	fmt.Fprintf(&b, "Endpoint = %s\n", endpoint)
	fmt.Fprintf(&b, "AllowedIPs = %s\n", prefixList(allowed))
	b.WriteString("PersistentKeepalive = 25\n")
	return b.String()
}

type publishRule struct {
	Proto      string `json:"proto"`
	Port       int    `json:"port"`
	TargetIP   string `json:"targetIP"`
	TargetPort int    `json:"targetPort"`
}

// vpsConf is the config for the VPS end. Only the VPS private key is left as
// a placeholder.
func vpsConf(address netip.Prefix, port int, gwPub, psk string, allowed []netip.Prefix, rules []publishRule) string {
	var b strings.Builder
	b.WriteString("[Interface]\n")
	fmt.Fprintf(&b, "Address = %s\n", address)
	fmt.Fprintf(&b, "ListenPort = %d\n", port)
	fmt.Fprintf(&b, "PrivateKey = %s\n", phVPSKey)
	if len(rules) > 0 {
		b.WriteString("PostUp = sysctl -w net.ipv4.ip_forward=1\n")
		b.WriteString("PostUp = iptables -t nat -A POSTROUTING -o %i -j MASQUERADE\n")
		b.WriteString("PostDown = iptables -t nat -D POSTROUTING -o %i -j MASQUERADE\n")
		for _, r := range rules {
			// {op} becomes -A when the interface comes up and -D when it goes down
			dnat := fmt.Sprintf("iptables -t nat {op} PREROUTING -p %s --dport %d ! -i %%i -j DNAT --to-destination %s:%d", r.Proto, r.Port, r.TargetIP, r.TargetPort)
			fwd := fmt.Sprintf("iptables {op} FORWARD -o %%i -p %s -d %s --dport %d -j ACCEPT", r.Proto, r.TargetIP, r.TargetPort)
			for _, rule := range []string{dnat, fwd} {
				fmt.Fprintf(&b, "PostUp = %s\n", strings.ReplaceAll(rule, "{op}", "-A"))
				fmt.Fprintf(&b, "PostDown = %s\n", strings.ReplaceAll(rule, "{op}", "-D"))
			}
		}
		// nothing else may be forwarded into the tunnel, so the homelab stays closed
		b.WriteString("PostUp = iptables -A FORWARD -o %i -j DROP\n")
		b.WriteString("PostDown = iptables -D FORWARD -o %i -j DROP\n")
		b.WriteString("PostUp = iptables -I FORWARD -i %i -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT\n")
		b.WriteString("PostDown = iptables -D FORWARD -i %i -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT\n")
	}
	b.WriteString(peerBlock("homelab", gwPub, psk, "", prefixList(allowed), 0))
	return b.String()
}

func vpsScript(conf string, port int) string {
	return fmt.Sprintf(`#!/bin/sh
# Sets up the VPS end of the tunnel on Debian or Ubuntu. Run as root.
set -e
apt-get update
apt-get install -y wireguard-tools iptables
umask 077
mkdir -p /etc/wireguard
cat > /etc/wireguard/wg0.conf <<'WG_CONF_END'
%sWG_CONF_END
systemctl enable --now wg-quick@wg0
# Allow the tunnel through the VPS firewall, for example: ufw allow %d/udp
`, conf, port)
}

// --- parsing ---------------------------------------------------------------

type confPeer struct {
	Name, PublicKey string
	AllowedIPs      []string
	lines           []string
}

type confDoc struct {
	head  []string
	peers []*confPeer
}

var nameCommentRe = regexp.MustCompile(`^#\s*name:\s*(.+?)\s*$`)

// parseConf splits a wg config into its header and peer blocks. A name
// comment right after [Peer] belongs to that peer; one before it belongs to
// the next one.
func parseConf(text string) *confDoc {
	d := &confDoc{}
	var cur *confPeer
	pending := ""
	justOpened := false
	for _, ln := range strings.Split(strings.TrimRight(text, "\n"), "\n") {
		t := strings.TrimSpace(ln)
		if strings.EqualFold(t, "[peer]") {
			cur = &confPeer{Name: pending}
			pending = ""
			d.peers = append(d.peers, cur)
			cur.lines = append(cur.lines, ln)
			justOpened = true
			continue
		}
		if strings.HasPrefix(t, "[") {
			cur = nil
		}
		if m := nameCommentRe.FindStringSubmatch(t); m != nil {
			if cur != nil && justOpened {
				cur.Name = m[1]
				cur.lines = append(cur.lines, ln)
			} else {
				// before a [Peer] line it names the next peer
				pending = m[1]
				if cur != nil {
					cur.lines = append(cur.lines, ln)
				} else {
					d.head = append(d.head, ln)
				}
			}
			continue
		}
		if t != "" {
			justOpened = false
		}
		if cur == nil {
			d.head = append(d.head, ln)
			continue
		}
		cur.lines = append(cur.lines, ln)
		k, v, ok := strings.Cut(t, "=")
		if !ok {
			continue
		}
		switch strings.ToLower(strings.TrimSpace(k)) {
		case "publickey":
			cur.PublicKey = strings.TrimSpace(v)
		case "allowedips":
			for _, p := range strings.Split(v, ",") {
				if p = strings.TrimSpace(p); p != "" {
					cur.AllowedIPs = append(cur.AllowedIPs, p)
				}
			}
		}
	}
	return d
}

func (d *confDoc) String() string {
	var out []string
	out = append(out, strings.TrimRight(strings.Join(d.head, "\n"), "\n"))
	for _, p := range d.peers {
		out = append(out, "", strings.TrimRight(strings.Join(p.lines, "\n"), "\n"))
	}
	return strings.Join(out, "\n") + "\n"
}

func (d *confDoc) remove(pub string) bool {
	for i, p := range d.peers {
		if p.PublicKey == pub {
			d.peers = append(d.peers[:i], d.peers[i+1:]...)
			return true
		}
	}
	return false
}

// header returns a value from the header: "Address", "ListenPort", or a
// "# key: value" comment.
func (d *confDoc) header(key string) string {
	for _, ln := range d.head {
		t := strings.TrimSpace(ln)
		if rest, ok := strings.CutPrefix(t, "# "+key+":"); ok {
			return strings.TrimSpace(rest)
		}
		if k, v, ok := strings.Cut(t, "="); ok && strings.EqualFold(strings.TrimSpace(k), key) {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

func (d *confDoc) names() map[string]string {
	m := map[string]string{}
	for _, p := range d.peers {
		if p.Name != "" && p.PublicKey != "" {
			m[p.PublicKey] = p.Name
		}
	}
	return m
}

// nextFreeIP picks the first unused host address in the tunnel subnet.
func nextFreeIP(tunnel netip.Prefix, gateway netip.Addr, peers []*confPeer) (netip.Addr, error) {
	used := map[netip.Addr]bool{gateway: true}
	for _, p := range peers {
		for _, a := range p.AllowedIPs {
			if pf, err := netip.ParsePrefix(a); err == nil {
				used[pf.Addr()] = true
			}
		}
	}
	for a := tunnel.Addr().Next(); tunnel.Contains(a); a = a.Next() {
		if !tunnel.Contains(a.Next()) { // broadcast address
			break
		}
		if !used[a] {
			return a, nil
		}
	}
	return netip.Addr{}, errors.New("The tunnel subnet is full. Remove an old device first.")
}

type tunnelPeer struct {
	Name            string   `json:"name"`
	PublicKey       string   `json:"publicKey"`
	Endpoint        string   `json:"endpoint"`
	AllowedIPs      []string `json:"allowedIPs"`
	LatestHandshake int64    `json:"latestHandshake"`
	Rx              int64    `json:"rx"`
	Tx              int64    `json:"tx"`
}

type dumpIface struct {
	Name       string
	PublicKey  string
	ListenPort int
	Peers      []tunnelPeer
}

// parseDump reads `wg show all dump`. Interface lines have 5 tab-separated
// fields (name, private key, public key, port, fwmark), peer lines 9. Secrets
// in the output are ignored.
func parseDump(s string) []dumpIface {
	var out []dumpIface
	idx := map[string]int{}
	for _, ln := range strings.Split(s, "\n") {
		f := strings.Split(strings.TrimRight(ln, "\r"), "\t")
		switch {
		case len(f) == 5:
			port, _ := strconv.Atoi(f[3])
			idx[f[0]] = len(out)
			out = append(out, dumpIface{Name: f[0], PublicKey: f[2], ListenPort: port})
		case len(f) >= 9:
			i, ok := idx[f[0]]
			if !ok {
				continue
			}
			p := tunnelPeer{PublicKey: f[1], AllowedIPs: []string{}}
			if f[3] != "(none)" {
				p.Endpoint = f[3]
			}
			if f[4] != "(none)" && f[4] != "" {
				p.AllowedIPs = strings.Split(f[4], ",")
			}
			p.LatestHandshake, _ = strconv.ParseInt(f[5], 10, 64)
			p.Rx, _ = strconv.ParseInt(f[6], 10, 64)
			p.Tx, _ = strconv.ParseInt(f[7], 10, 64)
			out[i].Peers = append(out[i].Peers, p)
		}
	}
	return out
}

// The status script is fixed text: no user input goes into it. Private and
// preshared keys are stripped inside the instance, so they never reach us.
const statusScript = `command -v wg >/dev/null 2>&1 || { echo '###NOWG'; exit 0; }
echo '###DUMP'
wg show all dump 2>/dev/null | awk 'BEGIN{FS=OFS="\t"} NF==5{$2="(hidden)"} NF>=9{$3="(hidden)"} {print}'
echo '###CONF'
for f in /etc/wireguard/*.conf; do
  [ -f "$f" ] || continue
  echo "###FILE $(basename "$f" .conf)"
  grep -v -i -E '^[[:space:]]*(PrivateKey|PresharedKey|PostUp|PreUp|PostDown|PreDown)[[:space:]]*=' "$f"
done
exit 0
`

type statusOut struct {
	NoWG  bool
	Dump  []dumpIface
	Confs map[string]*confDoc
	Order []string
}

func parseStatus(s string) statusOut {
	st := statusOut{Confs: map[string]*confDoc{}}
	if strings.Contains(s, "###NOWG") {
		st.NoWG = true
		return st
	}
	_, rest, _ := strings.Cut(s, "###DUMP\n")
	dump, confs, _ := strings.Cut(rest, "###CONF\n")
	st.Dump = parseDump(dump)
	var name string
	var buf []string
	flush := func() {
		if name != "" {
			st.Confs[name] = parseConf(strings.Join(buf, "\n"))
			st.Order = append(st.Order, name)
		}
	}
	for _, ln := range strings.Split(confs, "\n") {
		if n, ok := strings.CutPrefix(ln, "###FILE "); ok {
			flush()
			name, buf = n, nil
			continue
		}
		buf = append(buf, ln)
	}
	flush()
	return st
}

// --- Incus access ----------------------------------------------------------

type incusConn struct {
	be *backend
}

func (a *App) conn(name string) (*incusConn, error) {
	s, ok := a.server(name)
	if !ok {
		return nil, errors.New("unknown server")
	}
	be, err := a.backends.get(s)
	if err != nil {
		return nil, err
	}
	return &incusConn{be: be}, nil
}

func (c *incusConn) do(ctx context.Context, method, p, project string, body io.Reader, hdr map[string]string) (*http.Response, error) {
	u := *c.be.base
	pu, _ := url.Parse(p)
	u.Path = pu.Path
	q := pu.Query()
	if project != "" {
		q.Set("project", project)
	}
	u.RawQuery = q.Encode()
	req, err := http.NewRequestWithContext(ctx, method, u.String(), body)
	if err != nil {
		return nil, err
	}
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	return c.be.transport.RoundTrip(req)
}

type incusErr struct {
	Status int
	Msg    string
}

func (e *incusErr) Error() string { return e.Msg }

type incusResp struct {
	Type       string          `json:"type"`
	StatusCode int             `json:"status_code"`
	Error      string          `json:"error"`
	Metadata   json.RawMessage `json:"metadata"`
}

// call sends a JSON request, waits for an async operation and returns the
// final metadata.
func (c *incusConn) call(ctx context.Context, method, p, project string, body any) (json.RawMessage, error) {
	var rd io.Reader
	hdr := map[string]string{}
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
		hdr["Content-Type"] = "application/json"
	}
	resp, err := c.do(ctx, method, p, project, rd, hdr)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var r incusResp
	if err := json.NewDecoder(io.LimitReader(resp.Body, 64<<20)).Decode(&r); err != nil {
		return nil, fmt.Errorf("unexpected reply from Incus (%s)", resp.Status)
	}
	if r.Type == "error" || resp.StatusCode >= 400 {
		return nil, &incusErr{resp.StatusCode, r.Error}
	}
	if r.Type != "async" {
		return r.Metadata, nil
	}
	var op struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(r.Metadata, &op)
	wresp, err := c.do(ctx, "GET", "/1.0/operations/"+url.PathEscape(op.ID)+"/wait?timeout=-1", "", nil, nil)
	if err != nil {
		return nil, err
	}
	defer wresp.Body.Close()
	var w incusResp
	if err := json.NewDecoder(io.LimitReader(wresp.Body, 64<<20)).Decode(&w); err != nil {
		return nil, err
	}
	var fin struct {
		StatusCode int             `json:"status_code"`
		Err        string          `json:"err"`
		Metadata   json.RawMessage `json:"metadata"`
	}
	_ = json.Unmarshal(w.Metadata, &fin)
	if w.Type == "error" {
		return nil, &incusErr{wresp.StatusCode, w.Error}
	}
	if fin.StatusCode != 200 {
		return nil, &incusErr{400, fin.Err}
	}
	return fin.Metadata, nil
}

func instPath(name, sub string) string { return "/1.0/instances/" + url.PathEscape(name) + sub }

type execResult struct {
	Out, Err string
	Code     int
}

// exec runs argv inside an instance and records its output. Nothing is passed
// through a shell unless the caller passes a fixed `sh -c` script.
func (c *incusConn) exec(ctx context.Context, project, inst string, env map[string]string, argv ...string) (execResult, error) {
	return c.execCap(ctx, 8<<20, project, inst, env, argv...)
}

// execCap is exec with a limit on how much output is read back.
func (c *incusConn) execCap(ctx context.Context, limit int64, project, inst string, env map[string]string, argv ...string) (execResult, error) {
	e := map[string]string{"HOME": "/root", "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"}
	for k, v := range env {
		e[k] = v
	}
	md, err := c.call(ctx, "POST", instPath(inst, "/exec"), project, map[string]any{
		"command": argv, "environment": e, "record-output": true, "wait-for-websocket": false, "interactive": false,
	})
	if err != nil {
		return execResult{}, err
	}
	var m struct {
		Return int               `json:"return"`
		Output map[string]string `json:"output"`
	}
	_ = json.Unmarshal(md, &m)
	read := func(key string) string {
		p := m.Output[key]
		if p == "" {
			return ""
		}
		resp, err := c.do(ctx, "GET", p, project, nil, nil)
		if err != nil {
			return ""
		}
		b, _ := io.ReadAll(io.LimitReader(resp.Body, limit))
		resp.Body.Close()
		if r, err := c.do(ctx, "DELETE", p, project, nil, nil); err == nil {
			r.Body.Close()
		}
		return string(b)
	}
	return execResult{Out: read("1"), Err: read("2"), Code: m.Return}, nil
}

func (c *incusConn) readFile(ctx context.Context, project, inst, path string) (string, error) {
	resp, err := c.do(ctx, "GET", instPath(inst, "/files?path="+url.QueryEscape(path)), project, nil, nil)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if resp.StatusCode >= 400 {
		return "", &incusErr{resp.StatusCode, "can't read " + path}
	}
	return string(b), nil
}

func (c *incusConn) writeFile(ctx context.Context, project, inst, path, content string, mode string) error {
	resp, err := c.do(ctx, "POST", instPath(inst, "/files?path="+url.QueryEscape(path)), project, strings.NewReader(content), map[string]string{
		"X-Incus-type": "file", "X-Incus-mode": mode, "X-Incus-uid": "0", "X-Incus-gid": "0", "X-Incus-write": "overwrite",
	})
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		var r incusResp
		_ = json.NewDecoder(resp.Body).Decode(&r)
		return fmt.Errorf("can't write %s: %s", path, r.Error)
	}
	return nil
}

func (c *incusConn) deleteFile(ctx context.Context, project, inst, path string) {
	if r, err := c.do(ctx, "DELETE", instPath(inst, "/files?path="+url.QueryEscape(path)), project, nil, nil); err == nil {
		r.Body.Close()
	}
}

type instInfo struct {
	Name    string            `json:"name"`
	Project string            `json:"project"`
	Status  string            `json:"status"`
	Config  map[string]string `json:"config"`
}

func (c *incusConn) instance(ctx context.Context, project, name string) (*instInfo, error) {
	md, err := c.call(ctx, "GET", instPath(name, ""), project, nil)
	if err != nil {
		return nil, err
	}
	var i instInfo
	_ = json.Unmarshal(md, &i)
	if i.Project == "" {
		i.Project = project
	}
	return &i, nil
}

// --- tunnel list ------------------------------------------------------------

type tunnelOut struct {
	Server     string       `json:"server"`
	Project    string       `json:"project"`
	Instance   string       `json:"instance"`
	Iface      string       `json:"iface"`
	ListenPort int          `json:"listenPort"`
	Managed    bool         `json:"managed"`
	Kind       string       `json:"kind"`
	Status     string       `json:"status"`
	Up         bool         `json:"up"`
	Error      string       `json:"error,omitempty"`
	Endpoint   string       `json:"endpoint,omitempty"`
	Address    string       `json:"address,omitempty"`
	Routes     []string     `json:"routes,omitempty"`
	PublicKey  string       `json:"publicKey,omitempty"`
	Peers      []tunnelPeer `json:"peers"`
}

var tunnelOpMu sync.Mutex // serialises config edits

func (a *App) user(r *http.Request) string {
	if s, ok := a.currentSession(r); ok {
		return s.User
	}
	return "?"
}

func (a *App) handleTunnels(w http.ResponseWriter, r *http.Request) {
	servers := a.store.Get().Servers
	var mu sync.Mutex
	out := []tunnelOut{}
	var wg sync.WaitGroup
	for _, s := range servers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
			defer cancel()
			c, err := a.conn(s.Name)
			if err != nil {
				return
			}
			md, err := c.call(ctx, "GET", "/1.0/instances?recursion=1&all-projects=true", "", nil)
			if err != nil {
				return
			}
			var list []instInfo
			_ = json.Unmarshal(md, &list)
			var inner sync.WaitGroup
			defer inner.Wait()
			for _, in := range list {
				kind := in.Config[tunnelKey]
				if kind != kindRemote && kind != kindVPS && kind != kindMonitor {
					continue
				}
				inner.Add(1)
				go func() {
					defer inner.Done()
					res := a.tunnelStatus(ctx, c, s.Name, in, kind)
					mu.Lock()
					out = append(out, res...)
					mu.Unlock()
				}()
			}
		}()
	}
	wg.Wait()
	sort.Slice(out, func(i, j int) bool {
		x, y := out[i], out[j]
		if x.Server != y.Server {
			return x.Server < y.Server
		}
		if x.Instance != y.Instance {
			return x.Instance < y.Instance
		}
		return x.Iface < y.Iface
	})
	writeJSON(w, out)
}

// statusCache keeps one instance's status for a few seconds, so several open
// pages don't each run a root exec in every gateway.
type statusCacheT struct {
	mu sync.Mutex
	m  map[string]statusEntry
}

type statusEntry struct {
	at  time.Time
	out []tunnelOut
}

const statusTTL = 10 * time.Second

var statusCache = &statusCacheT{m: map[string]statusEntry{}}

func (c *statusCacheT) get(key string) ([]tunnelOut, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.m[key]
	if !ok || time.Since(e.at) > statusTTL {
		return nil, false
	}
	return append([]tunnelOut(nil), e.out...), true
}

func (c *statusCacheT) put(key string, out []tunnelOut) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for k, e := range c.m {
		if time.Since(e.at) > statusTTL {
			delete(c.m, k)
		}
	}
	c.m[key] = statusEntry{time.Now(), append([]tunnelOut(nil), out...)}
}

func (c *statusCacheT) clear() {
	c.mu.Lock()
	c.m = map[string]statusEntry{}
	c.mu.Unlock()
}

func (a *App) tunnelStatus(ctx context.Context, c *incusConn, server string, in instInfo, kind string) []tunnelOut {
	key := server + "\x00" + in.Project + "\x00" + in.Name + "\x00" + in.Status + "\x00" + kind
	if out, ok := statusCache.get(key); ok {
		return out
	}
	out := a.tunnelStatusLive(ctx, c, server, in, kind)
	statusCache.put(key, out)
	return out
}

func (a *App) tunnelStatusLive(ctx context.Context, c *incusConn, server string, in instInfo, kind string) []tunnelOut {
	base := tunnelOut{Server: server, Project: in.Project, Instance: in.Name, Managed: kind != kindMonitor, Kind: kind, Status: in.Status, Peers: []tunnelPeer{}}
	if in.Status != "Running" {
		base.Error = "The gateway instance is stopped."
		if kind == kindMonitor {
			base.Error = "The instance is stopped."
		}
		return []tunnelOut{base}
	}
	res, err := c.execCap(ctx, 256<<10, in.Project, in.Name, nil, "sh", "-c", statusScript)
	if err != nil {
		base.Error = "Can't run commands in the instance: " + friendlyIncusErr(err)
		return []tunnelOut{base}
	}
	st := parseStatus(res.Out)
	if st.NoWG {
		base.Error = "WireGuard tools aren't installed in this instance."
		return []tunnelOut{base}
	}
	var out []tunnelOut
	seen := map[string]bool{}
	build := func(name string, d *dumpIface) tunnelOut {
		t := base
		t.Iface = name
		t.Peers = []tunnelPeer{}
		var names map[string]string
		if cf := st.Confs[name]; cf != nil {
			names = cf.names()
			t.Endpoint = cf.header("endpoint")
			t.Address = cf.header("Address")
			if rt := cf.header("routes"); rt != "" {
				for _, x := range strings.Split(rt, ",") {
					t.Routes = append(t.Routes, strings.TrimSpace(x))
				}
			}
		}
		if d != nil {
			t.Up, t.ListenPort, t.PublicKey = true, d.ListenPort, d.PublicKey
			if cf := st.Confs[name]; cf != nil && t.ListenPort == 0 {
				// userspace WireGuard doesn't always report its port
				t.ListenPort, _ = strconv.Atoi(cf.header("ListenPort"))
			}
			for _, p := range d.Peers {
				p.Name = names[p.PublicKey]
				t.Peers = append(t.Peers, p)
			}
		} else if cf := st.Confs[name]; cf != nil {
			t.Error = "The interface is down."
			if p, err := strconv.Atoi(cf.header("ListenPort")); err == nil {
				t.ListenPort = p
			}
			for _, p := range cf.peers {
				t.Peers = append(t.Peers, tunnelPeer{Name: p.Name, PublicKey: p.PublicKey, AllowedIPs: p.AllowedIPs})
			}
		}
		return t
	}
	for i := range st.Dump {
		seen[st.Dump[i].Name] = true
		out = append(out, build(st.Dump[i].Name, &st.Dump[i]))
	}
	for _, n := range st.Order {
		if !seen[n] {
			out = append(out, build(n, nil))
		}
	}
	if len(out) == 0 {
		base.Error = "No WireGuard interface found in this instance."
		return []tunnelOut{base}
	}
	return out
}

func friendlyIncusErr(err error) string {
	var ie *incusErr
	if errors.As(err, &ie) {
		return ie.Msg
	}
	return err.Error()
}

// --- create ------------------------------------------------------------------

type createReq struct {
	Kind     string        `json:"kind"`
	Server   string        `json:"server"`
	Project  string        `json:"project"`
	Instance string        `json:"instance"`
	Image    string        `json:"image"`
	Networks []string      `json:"networks"`
	Host     string        `json:"host"` // public IP or DNS name (remote access) / VPS address (vps)
	Port     int           `json:"port"`
	Subnet   string        `json:"subnet"`
	Iface    string        `json:"iface"`
	VPSKey   string        `json:"vpsPublicKey"`
	PSK      string        `json:"presharedKey"`
	Publish  []publishRule `json:"publish"`
}

type plan struct {
	req      createReq
	tunnel   netip.Prefix
	gwAddr   netip.Prefix
	routes   []netip.Prefix
	hostIPs  []netip.Addr
	endpoint string
}

// validateCreate checks everything the browser sent; network subnets come from
// Incus, never from the request.
func (a *App) validateCreate(ctx context.Context, c *incusConn, req createReq) (*plan, error) {
	if req.Kind != kindRemote && req.Kind != kindVPS {
		return nil, errors.New("Unknown tunnel type.")
	}
	if req.Iface == "" {
		req.Iface = "wg0"
	}
	if req.Project == "" {
		req.Project = "default"
	}
	switch {
	case !projectRe.MatchString(req.Project):
		return nil, errors.New("That project name isn't valid.")
	case !nameRe.MatchString(req.Instance):
		return nil, errors.New("The gateway name can use letters, numbers and dashes.")
	case !ifaceRe.MatchString(req.Iface):
		return nil, errors.New("The interface name can use letters, numbers, dashes and underscores (up to 15).")
	case !imageRe.MatchString(req.Image):
		return nil, errors.New("Pick an image for the gateway.")
	case !validHost(req.Host):
		return nil, errors.New("Enter a public IP address or a DNS name like vpn.example.com.")
	case !validPort(req.Port):
		return nil, errors.New("The port must be between 1 and 65535.")
	case len(req.Networks) == 0 || len(req.Networks) > 8:
		return nil, errors.New("Choose at least one network.")
	}
	tunnel, err := parseTunnelSubnet(req.Subnet)
	if err != nil {
		return nil, err
	}
	p := &plan{req: req, tunnel: tunnel, endpoint: hostPortStr(req.Host, req.Port)}
	seenNet := map[string]bool{}
	for _, n := range req.Networks {
		if !nameRe.MatchString(n) || seenNet[n] {
			return nil, errors.New("A network name isn't valid.")
		}
		seenNet[n] = true
		md, err := c.call(ctx, "GET", "/1.0/networks/"+url.PathEscape(n), req.Project, nil)
		if err != nil {
			return nil, fmt.Errorf("Can't read network %s: %s", n, friendlyIncusErr(err))
		}
		var net struct {
			Type    string            `json:"type"`
			Managed bool              `json:"managed"`
			Config  map[string]string `json:"config"`
		}
		_ = json.Unmarshal(md, &net)
		pf, err := netip.ParsePrefix(net.Config["ipv4.address"])
		if !net.Managed || net.Type != "bridge" || err != nil {
			return nil, fmt.Errorf("Network %s needs to be a managed bridge with an IPv4 address.", n)
		}
		p.hostIPs = append(p.hostIPs, pf.Addr())
		pf = pf.Masked()
		if overlaps(pf, tunnel) {
			return nil, fmt.Errorf("The tunnel subnet %s overlaps network %s (%s). Pick another tunnel subnet.", tunnel, n, pf)
		}
		p.routes = append(p.routes, pf)
	}
	if req.Kind == kindRemote {
		p.gwAddr = netip.PrefixFrom(hostN(tunnel, 1), tunnel.Bits())
		return p, nil
	}
	if !validKey(req.VPSKey) || !validKey(req.PSK) {
		return nil, errors.New("The VPS keys aren't valid. Reload the wizard to generate new ones.")
	}
	p.gwAddr = netip.PrefixFrom(hostN(tunnel, 2), tunnel.Bits())
	for _, r := range req.Publish {
		ip, err := netip.ParseAddr(r.TargetIP)
		inRoutes := false
		for _, rt := range p.routes {
			inRoutes = inRoutes || (err == nil && rt.Contains(ip))
		}
		switch {
		case r.Proto != "tcp" && r.Proto != "udp":
			return nil, errors.New("A published port must be TCP or UDP.")
		case !validPort(r.Port) || !validPort(r.TargetPort):
			return nil, errors.New("A published port must be between 1 and 65535.")
		case r.Port == 22 && r.Proto == "tcp", r.Port == req.Port && r.Proto == "udp":
			return nil, fmt.Errorf("%s port %d is used by the VPS itself. Pick another public port.", strings.ToUpper(r.Proto), r.Port)
		case !inRoutes:
			return nil, fmt.Errorf("%s isn't in one of the chosen networks.", r.TargetIP)
		}
	}
	if len(req.Publish) > 32 {
		return nil, errors.New("Publish at most 32 ports.")
	}
	return p, nil
}

func detectDistro(osRelease string) string {
	for _, ln := range strings.Split(osRelease, "\n") {
		if v, ok := strings.CutPrefix(ln, "ID="); ok {
			return strings.Trim(strings.TrimSpace(v), `"'`)
		}
	}
	return ""
}

func gatewayDistro(ctx context.Context, c *incusConn, project, inst string) string {
	res, _ := c.exec(ctx, project, inst, nil, "cat", "/etc/os-release")
	return detectDistro(res.Out)
}

// kernelErr maps wg-quick and Incus errors that mean "no WireGuard in this kernel".
func kernelErr(s string) bool {
	for _, m := range []string{"Protocol not supported", "Operation not supported", "Unknown device type", "kernel module"} {
		if strings.Contains(s, m) {
			return true
		}
	}
	return false
}

func (a *App) handleTunnelCreate(w http.ResponseWriter, r *http.Request) {
	var req createReq
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&req); err != nil {
		jsonError(w, http.StatusBadRequest, "bad request")
		return
	}
	c, err := a.conn(req.Server)
	if err != nil {
		jsonError(w, http.StatusNotFound, err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Minute)
	defer cancel()
	pl, err := a.validateCreate(ctx, c, req)
	if err != nil {
		jsonError(w, http.StatusBadRequest, err.Error())
		return
	}
	req = pl.req
	if _, err := c.instance(ctx, req.Project, req.Instance); err == nil {
		jsonError(w, http.StatusConflict, "An instance called "+req.Instance+" already exists. Pick another gateway name.")
		return
	}
	user := a.user(r)
	log.Printf("tunnels: %s creates %s gateway %s/%s on %s (networks %v, port %d)", user, req.Kind, req.Project, req.Instance, req.Server, req.Networks, req.Port)

	res, err := a.createGateway(ctx, c, pl)
	if err != nil {
		log.Printf("tunnels: %s: creating gateway %s failed: %v", user, req.Instance, err)
		jsonError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, res)
}

func gatewayConfig(pl *plan) string {
	o := confOpts{Kind: pl.req.Kind, Iface: pl.req.Iface, Address: pl.gwAddr, Routes: pl.routes, Tunnel: pl.tunnel, HostIPs: pl.hostIPs}
	var conf string
	if pl.req.Kind == kindRemote {
		o.Port, o.Endpoint = pl.req.Port, pl.endpoint
		conf = gatewayConf(o)
	} else {
		o.Endpoint, o.Publish = pl.endpoint, pl.req.Publish
		conf = gatewayConf(o)
		vpsIP := hostN(pl.tunnel, 1)
		conf += peerBlock("vps", pl.req.VPSKey, pl.req.PSK, pl.endpoint, vpsIP.String()+"/32", 25)
	}
	return conf
}

func (a *App) createGateway(ctx context.Context, c *incusConn, pl *plan) (map[string]any, error) {
	req := pl.req
	cfg := map[string]string{tunnelKey: req.Kind, "user.incus-webui.managed": "wireguard gateway"}
	devices := map[string]map[string]string{}
	for i, n := range req.Networks {
		devices[fmt.Sprintf("eth%d", i)] = map[string]string{"type": "nic", "name": fmt.Sprintf("eth%d", i), "network": n}
	}
	userspace := os.Getenv("INCUS_WEBUI_WG_TEST") // test setups without the kernel module only
	if userspace == "" {
		cfg["linux.kernel_modules"] = "wireguard"
	} else {
		devices["tun"] = map[string]string{"type": "unix-char", "path": "/dev/net/tun"}
	}
	if req.Kind == kindRemote {
		devices["wg-udp"] = map[string]string{
			"type": "proxy", "listen": fmt.Sprintf("udp:0.0.0.0:%d", req.Port), "connect": fmt.Sprintf("udp:127.0.0.1:%d", req.Port),
		}
	}
	src := map[string]string{"type": "image"}
	if regexp.MustCompile(`^[0-9a-f]{12,64}$`).MatchString(req.Image) {
		src["fingerprint"] = req.Image
	} else {
		src["alias"] = req.Image
	}
	if _, err := c.call(ctx, "POST", "/1.0/instances", req.Project, map[string]any{
		"name": req.Instance, "type": "container", "source": src, "config": cfg, "devices": devices, "start": false,
	}); err != nil {
		return nil, fmt.Errorf("Can't create the gateway: %s", friendlyIncusErr(err))
	}
	rollback := func(cause error) (map[string]any, error) {
		_, _ = c.call(context.Background(), "PUT", instPath(req.Instance, "/state"), req.Project, map[string]any{"action": "stop", "force": true, "timeout": 10})
		_, _ = c.call(context.Background(), "DELETE", instPath(req.Instance, ""), req.Project, nil)
		return nil, cause
	}
	if _, err := c.call(ctx, "PUT", instPath(req.Instance, "/state"), req.Project, map[string]any{"action": "start", "timeout": 60}); err != nil {
		msg := friendlyIncusErr(err)
		if kernelErr(msg) {
			return rollback(errors.New(noKernelText))
		}
		return rollback(fmt.Errorf("The gateway didn't start: %s", msg))
	}
	run := func(argv ...string) (execResult, error) {
		return c.exec(ctx, req.Project, req.Instance, map[string]string{"DEBIAN_FRONTEND": "noninteractive"}, argv...)
	}
	// wait for the container to accept commands
	var ready bool
	for i := 0; i < 30 && !ready; i++ {
		if res, err := run("true"); err == nil && res.Code == 0 {
			ready = true
		} else {
			time.Sleep(time.Second)
		}
	}
	if !ready {
		return rollback(errors.New("The gateway started but doesn't accept commands."))
	}
	id := gatewayDistro(ctx, c, req.Project, req.Instance)
	var install [][]string
	switch id {
	case "debian", "ubuntu":
		install = [][]string{{"apt-get", "update"}, {"apt-get", "install", "-y", "--no-install-recommends", "wireguard-tools", "nftables", "iproute2"}}
	case "alpine":
		install = [][]string{{"apk", "update"}, {"apk", "add", "--no-cache", "wireguard-tools", "nftables", "iproute2"}}
	default:
		return rollback(fmt.Errorf("This image (%q) isn't supported. Use an Alpine, Debian or Ubuntu image.", id))
	}
	for _, step := range install {
		var res execResult
		var err error
		for try := 0; try < 6; try++ { // the network may need a moment after start
			if res, err = run(step...); err == nil && res.Code == 0 {
				break
			}
			time.Sleep(5 * time.Second)
		}
		if err != nil || res.Code != 0 {
			return rollback(fmt.Errorf("Installing WireGuard in the gateway failed. The gateway needs internet access through its network (%s): %s", step[0], tail(res.Err+res.Out, 300)))
		}
	}
	// Keys are made inside the gateway; only the public key comes back. The
	// script is fixed text with no user input.
	if res, err := run("sh", "-c", "umask 077; mkdir -p /etc/wireguard; wg genkey > /etc/wireguard/private.key; wg pubkey < /etc/wireguard/private.key > /etc/wireguard/public.key"); err != nil || res.Code != 0 {
		return rollback(fmt.Errorf("Can't create the gateway key: %s", tail(res.Err, 200)))
	}
	pub, _ := c.readFile(ctx, req.Project, req.Instance, "/etc/wireguard/public.key")
	pub = strings.TrimSpace(pub)
	if !validKey(pub) {
		return rollback(errors.New("The gateway didn't produce a valid public key."))
	}
	var vpsAddr netip.Addr
	if req.Kind == kindVPS {
		vpsAddr = hostN(pl.tunnel, 1)
	}
	files := map[string]string{
		"/etc/wireguard/" + req.Iface + ".conf": gatewayConfig(pl),
		"/etc/wireguard/" + req.Iface + ".nft":  gatewayNft(req.Iface, pl.routes, pl.hostIPs, vpsAddr, req.Publish),
	}
	for p, content := range files {
		if err := c.writeFile(ctx, req.Project, req.Instance, p, content, "0600"); err != nil {
			return rollback(err)
		}
	}
	res := map[string]any{
		"server": req.Server, "project": req.Project, "instance": req.Instance, "iface": req.Iface,
		"publicKey": pub, "endpoint": pl.endpoint,
	}
	if err := a.gatewayEnable(ctx, c, req.Project, req.Instance, req.Iface, id); err != nil {
		res["up"], res["error"] = false, err.Error()
	} else {
		res["up"] = true
	}
	if req.Kind == kindVPS {
		vconf := vpsConf(netip.PrefixFrom(hostN(pl.tunnel, 1), pl.tunnel.Bits()), req.Port, pub, req.PSK, append([]netip.Prefix{netip.PrefixFrom(pl.gwAddr.Addr(), 32)}, pl.routes...), req.Publish)
		res["vpsConfig"], res["vpsScript"] = vconf, vpsScript(vconf, req.Port)
	}
	return res, nil
}

func tail(s string, n int) string {
	s = strings.TrimSpace(s)
	if len(s) > n {
		s = "…" + s[len(s)-n:]
	}
	return s
}

// gatewayEnable starts the interface now and at boot, and turns wg-quick's
// failure into a readable message.
func (a *App) gatewayEnable(ctx context.Context, c *incusConn, project, inst, iface, id string) error {
	var logs execResult
	if id == "alpine" {
		_, _ = c.exec(ctx, project, inst, nil, "ln", "-sf", "/etc/init.d/wg-quick", "/etc/init.d/wg-quick."+iface)
		_, _ = c.exec(ctx, project, inst, nil, "rc-update", "add", "wg-quick."+iface, "default")
		logs, _ = c.exec(ctx, project, inst, nil, "rc-service", "wg-quick."+iface, "restart")
	} else {
		logs, _ = c.exec(ctx, project, inst, nil, "systemctl", "enable", "--now", "wg-quick@"+iface)
	}
	// systemctl doesn't always report a failed start, so look at the interface.
	if res, err := c.exec(ctx, project, inst, nil, "wg", "show", iface, "public-key"); err != nil {
		return err
	} else if res.Code == 0 {
		return nil
	}
	if id != "alpine" {
		j, _ := c.exec(ctx, project, inst, nil, "journalctl", "-u", "wg-quick@"+iface, "-n", "20", "--no-pager", "-o", "cat")
		logs.Out += j.Out
	}
	all := logs.Err + logs.Out
	if kernelErr(all) {
		return errors.New(noKernelText)
	}
	return fmt.Errorf("The tunnel didn't come up: %s", tail(all, 400))
}

// --- peers ---------------------------------------------------------------------

type tunnelRef struct {
	server, project, instance string
	c                         *incusConn
	info                      *instInfo
}

// target loads a tunnel's instance and checks it's one this feature manages
// (any of the given kinds).
func (a *App) target(ctx context.Context, r *http.Request, kinds ...string) (*tunnelRef, int, error) {
	t := &tunnelRef{server: r.PathValue("server"), project: r.PathValue("project"), instance: r.PathValue("instance")}
	if !projectRe.MatchString(t.project) || !nameRe.MatchString(t.instance) {
		return nil, http.StatusBadRequest, errors.New("bad request")
	}
	c, err := a.conn(t.server)
	if err != nil {
		return nil, http.StatusNotFound, err
	}
	t.c = c
	in, err := c.instance(ctx, t.project, t.instance)
	if err != nil {
		return nil, http.StatusNotFound, errors.New("That instance doesn't exist.")
	}
	t.info = in
	k := in.Config[tunnelKey]
	for _, want := range kinds {
		if k == want {
			return t, 0, nil
		}
	}
	return nil, http.StatusBadRequest, errors.New("This instance isn't a tunnel gateway made by the UI.")
}

func ifaceParam(r *http.Request) (string, error) {
	i := r.URL.Query().Get("iface")
	if i == "" {
		i = "wg0"
	}
	if !ifaceRe.MatchString(i) {
		return "", errors.New("bad interface name")
	}
	return i, nil
}

func (a *App) handlePeerAdd(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name      string `json:"name"`
		PublicKey string `json:"publicKey"`
		PSK       string `json:"presharedKey"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
		jsonError(w, http.StatusBadRequest, "bad request")
		return
	}
	iface, err := ifaceParam(r)
	switch {
	case err != nil:
		jsonError(w, http.StatusBadRequest, err.Error())
		return
	case !peerNameRe.MatchString(req.Name):
		jsonError(w, http.StatusBadRequest, "The device name can use letters, numbers, spaces, dots and dashes (up to 32).")
		return
	case !validKey(req.PublicKey):
		jsonError(w, http.StatusBadRequest, "The public key isn't valid.")
		return
	case req.PSK != "" && !validKey(req.PSK):
		jsonError(w, http.StatusBadRequest, "The preshared key isn't valid.")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()
	t, code, err := a.target(ctx, r, kindRemote)
	if err != nil {
		jsonError(w, code, err.Error())
		return
	}
	tunnelOpMu.Lock()
	defer tunnelOpMu.Unlock()
	confPath := "/etc/wireguard/" + iface + ".conf"
	text, err := t.c.readFile(ctx, t.project, t.instance, confPath)
	if err != nil {
		jsonError(w, http.StatusBadGateway, "Can't read the gateway config. Is the gateway running?")
		return
	}
	doc := parseConf(text)
	for _, p := range doc.peers {
		if p.PublicKey == req.PublicKey {
			jsonError(w, http.StatusConflict, "That key is already a peer.")
			return
		}
		if strings.EqualFold(p.Name, req.Name) {
			jsonError(w, http.StatusConflict, "A device called "+req.Name+" already exists.")
			return
		}
	}
	addr, err := netip.ParsePrefix(doc.header("Address"))
	if err != nil {
		jsonError(w, http.StatusBadGateway, "The gateway config has no tunnel address.")
		return
	}
	var routes []netip.Prefix
	for _, x := range strings.Split(doc.header("routes"), ",") {
		if p, err := netip.ParsePrefix(strings.TrimSpace(x)); err == nil {
			routes = append(routes, p)
		}
	}
	endpoint := doc.header("endpoint")
	pub, _ := t.c.readFile(ctx, t.project, t.instance, "/etc/wireguard/public.key")
	pub = strings.TrimSpace(pub)
	if endpoint == "" || !validKey(pub) {
		jsonError(w, http.StatusBadGateway, "The gateway config is incomplete.")
		return
	}
	ip, err := nextFreeIP(addr.Masked(), addr.Addr(), doc.peers)
	if err != nil {
		jsonError(w, http.StatusConflict, err.Error())
		return
	}
	block := peerBlock(req.Name, req.PublicKey, req.PSK, "", ip.String()+"/32", 0)
	if err := t.c.writeFile(ctx, t.project, t.instance, confPath, strings.TrimRight(text, "\n")+"\n"+block, "0600"); err != nil {
		jsonError(w, http.StatusBadGateway, err.Error())
		return
	}
	// Apply to the running interface. The preshared key goes through a
	// short-lived 0600 file because wg only reads it from a file.
	args := []string{"wg", "set", iface, "peer", req.PublicKey, "allowed-ips", ip.String() + "/32"}
	tmp := "/run/wg-psk-" + randHex(6)
	if req.PSK != "" {
		if err := t.c.writeFile(ctx, t.project, t.instance, tmp, req.PSK+"\n", "0600"); err == nil {
			args = append(args, "preshared-key", tmp)
		}
	}
	res, err := t.c.exec(ctx, t.project, t.instance, nil, args...)
	if req.PSK != "" {
		t.c.deleteFile(ctx, t.project, t.instance, tmp)
	}
	live := err == nil && res.Code == 0
	log.Printf("tunnels: %s adds peer %q (%s) to %s/%s %s, live=%v", a.user(r), req.Name, ip, t.project, t.instance, iface, live)
	allowed := append([]netip.Prefix{addr.Masked()}, routes...)
	out := map[string]any{
		"address": ip.String() + "/32", "serverPublicKey": pub, "endpoint": endpoint, "allowedIPs": prefixStrings(allowed),
		"config": clientConf(ip, pub, endpoint, allowed, req.PSK != ""), "live": live,
	}
	if !live {
		out["warning"] = "The device is saved but the interface is down, so it can't connect until the tunnel is up."
	}
	writeJSON(w, out)
}

func prefixStrings(ps []netip.Prefix) []string {
	s := make([]string, len(ps))
	for i, p := range ps {
		s[i] = p.String()
	}
	return s
}

func (a *App) handlePeerRemove(w http.ResponseWriter, r *http.Request) {
	key := r.URL.Query().Get("key")
	iface, err := ifaceParam(r)
	if err != nil || !validKey(key) {
		jsonError(w, http.StatusBadRequest, "bad request")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()
	t, code, err := a.target(ctx, r, kindRemote, kindVPS)
	if err != nil {
		jsonError(w, code, err.Error())
		return
	}
	tunnelOpMu.Lock()
	defer tunnelOpMu.Unlock()
	confPath := "/etc/wireguard/" + iface + ".conf"
	text, err := t.c.readFile(ctx, t.project, t.instance, confPath)
	if err != nil {
		jsonError(w, http.StatusBadGateway, "Can't read the gateway config. Is the gateway running?")
		return
	}
	doc := parseConf(text)
	inConf := doc.remove(key)
	if inConf {
		if err := t.c.writeFile(ctx, t.project, t.instance, confPath, doc.String(), "0600"); err != nil {
			jsonError(w, http.StatusBadGateway, err.Error())
			return
		}
	}
	res, err := t.c.exec(ctx, t.project, t.instance, nil, "wg", "set", iface, "peer", key, "remove")
	live := err == nil && res.Code == 0
	if !inConf && !live {
		jsonError(w, http.StatusNotFound, "That device isn't a peer of this tunnel.")
		return
	}
	log.Printf("tunnels: %s revokes peer %s on %s/%s %s (conf=%v, live=%v)", a.user(r), key, t.project, t.instance, iface, inConf, live)
	w.WriteHeader(http.StatusNoContent)
}

// --- restart, watch, delete -----------------------------------------------------

func (a *App) handleTunnelRestart(w http.ResponseWriter, r *http.Request) {
	iface, err := ifaceParam(r)
	if err != nil {
		jsonError(w, http.StatusBadRequest, err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 90*time.Second)
	defer cancel()
	t, code, err := a.target(ctx, r, kindRemote, kindVPS)
	if err != nil {
		jsonError(w, code, err.Error())
		return
	}
	if t.info.Status != "Running" {
		if _, err := t.c.call(ctx, "PUT", instPath(t.instance, "/state"), t.project, map[string]any{"action": "start", "timeout": 60}); err != nil {
			jsonError(w, http.StatusBadGateway, friendlyIncusErr(err))
			return
		}
		time.Sleep(3 * time.Second)
	}
	log.Printf("tunnels: %s restarts %s on %s/%s", a.user(r), iface, t.project, t.instance)
	if err := a.gatewayEnable(ctx, t.c, t.project, t.instance, iface, gatewayDistro(ctx, t.c, t.project, t.instance)); err != nil {
		jsonError(w, http.StatusBadGateway, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleWatch marks an existing instance as monitored, after checking that
// it really has WireGuard.
func (a *App) handleWatch(w http.ResponseWriter, r *http.Request) {
	var req struct{ Server, Project, Instance string }
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil || !projectRe.MatchString(req.Project) || !nameRe.MatchString(req.Instance) {
		jsonError(w, http.StatusBadRequest, "bad request")
		return
	}
	c, err := a.conn(req.Server)
	if err != nil {
		jsonError(w, http.StatusNotFound, err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	in, err := c.instance(ctx, req.Project, req.Instance)
	if err != nil {
		jsonError(w, http.StatusNotFound, "That instance doesn't exist.")
		return
	}
	if in.Status != "Running" {
		jsonError(w, http.StatusBadRequest, "Start the instance first, then try again.")
		return
	}
	if k := in.Config[tunnelKey]; k == kindRemote || k == kindVPS {
		jsonError(w, http.StatusConflict, "This is already a managed gateway.")
		return
	}
	res, err := c.exec(ctx, req.Project, req.Instance, nil, "sh", "-c", statusScript)
	if err != nil {
		jsonError(w, http.StatusBadGateway, "Can't run commands in the instance: "+friendlyIncusErr(err))
		return
	}
	st := parseStatus(res.Out)
	if st.NoWG {
		jsonError(w, http.StatusBadRequest, "WireGuard tools aren't installed in this instance.")
		return
	}
	if len(st.Dump) == 0 && len(st.Order) == 0 {
		jsonError(w, http.StatusBadRequest, "No WireGuard interface found in this instance.")
		return
	}
	if _, err := c.call(ctx, "PATCH", instPath(req.Instance, ""), req.Project, map[string]any{"config": map[string]string{tunnelKey: kindMonitor}}); err != nil {
		jsonError(w, http.StatusBadGateway, friendlyIncusErr(err))
		return
	}
	log.Printf("tunnels: %s starts monitoring %s/%s on %s", a.user(r), req.Project, req.Instance, req.Server)
	writeJSON(w, a.tunnelStatus(ctx, c, req.Server, *in, kindMonitor))
}

// handleTunnelDelete deletes a gateway made by the UI, or stops monitoring an
// instance (the instance itself is never touched then).
func (a *App) handleTunnelDelete(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 90*time.Second)
	defer cancel()
	t, code, err := a.target(ctx, r, kindRemote, kindVPS, kindMonitor)
	if err != nil {
		jsonError(w, code, err.Error())
		return
	}
	user := a.user(r)
	if t.info.Config[tunnelKey] == kindMonitor {
		if _, err := t.c.call(ctx, "PATCH", instPath(t.instance, ""), t.project, map[string]any{"config": map[string]string{tunnelKey: ""}}); err != nil {
			jsonError(w, http.StatusBadGateway, friendlyIncusErr(err))
			return
		}
		log.Printf("tunnels: %s stops monitoring %s/%s", user, t.project, t.instance)
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if t.info.Status != "Stopped" {
		if _, err := t.c.call(ctx, "PUT", instPath(t.instance, "/state"), t.project, map[string]any{"action": "stop", "force": true, "timeout": 30}); err != nil {
			jsonError(w, http.StatusBadGateway, friendlyIncusErr(err))
			return
		}
	}
	if _, err := t.c.call(ctx, "DELETE", instPath(t.instance, ""), t.project, nil); err != nil {
		jsonError(w, http.StatusBadGateway, friendlyIncusErr(err))
		return
	}
	log.Printf("tunnels: %s deletes gateway %s/%s on %s", user, t.project, t.instance, t.server)
	w.WriteHeader(http.StatusNoContent)
}

func (a *App) registerTunnelRoutes(mux *http.ServeMux, auth func(http.HandlerFunc) http.Handler) {
	// changes drop the cached status so the page shows them right away
	mut := func(h http.HandlerFunc) http.Handler {
		return auth(func(w http.ResponseWriter, r *http.Request) {
			h(w, r)
			statusCache.clear()
		})
	}
	mux.Handle("GET /api/ui/tunnels", auth(a.handleTunnels))
	mux.Handle("POST /api/ui/tunnels", mut(a.handleTunnelCreate))
	mux.Handle("POST /api/ui/tunnels/watch", mut(a.handleWatch))
	mux.Handle("POST /api/ui/tunnels/{server}/{project}/{instance}/peers", mut(a.handlePeerAdd))
	mux.Handle("DELETE /api/ui/tunnels/{server}/{project}/{instance}/peers", mut(a.handlePeerRemove))
	mux.Handle("POST /api/ui/tunnels/{server}/{project}/{instance}/restart", mut(a.handleTunnelRestart))
	mux.Handle("DELETE /api/ui/tunnels/{server}/{project}/{instance}", mut(a.handleTunnelDelete))
}
