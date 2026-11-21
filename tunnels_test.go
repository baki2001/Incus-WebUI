package main

import (
	"context"
	"net/netip"
	"strings"
	"testing"
)

const key1 = "YAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk="
const key2 = "xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg="

func TestValidation(t *testing.T) {
	if !validKey(key1) || validKey("abc") || validKey(key1+"A") {
		t.Fatal("key validation")
	}
	for _, h := range []string{"vpn.example.com", "203.0.113.5", "2001:db8::1"} {
		if !validHost(h) {
			t.Errorf("host %q should be valid", h)
		}
	}
	for _, h := range []string{"", "localhost", "a b.com", "x.com;rm -rf /", "a..b.com", "vpn.example.com:51820", "$(id).example.com", "-x.com"} {
		if validHost(h) {
			t.Errorf("host %q should be rejected", h)
		}
	}
	if hostPortStr("2001:db8::1", 51820) != "[2001:db8::1]:51820" || hostPortStr("a.b", 1) != "a.b:1" {
		t.Error("hostPortStr")
	}
	for _, s := range []string{"10.66.0.0/24", "192.168.77.0/28", "172.20.0.5/16"} {
		if _, err := parseTunnelSubnet(s); err != nil {
			t.Errorf("%s: %v", s, err)
		}
	}
	for _, s := range []string{"8.8.8.0/24", "10.0.0.0/8", "10.0.0.0/30", "fd00::/64", "x", "10.0.0.0/24; rm"} {
		if _, err := parseTunnelSubnet(s); err == nil {
			t.Errorf("%s should be rejected", s)
		}
	}
	for _, n := range []string{"a;b", "a b", "../x", "", "-x", strings.Repeat("a", 64)} {
		if nameRe.MatchString(n) {
			t.Errorf("name %q should be rejected", n)
		}
	}
	for _, n := range []string{"laptop", "Anna's phone", "x\ny", "# name", ""} {
		if ok := peerNameRe.MatchString(n); ok != (n == "laptop") {
			t.Errorf("peer name %q = %v", n, ok)
		}
	}
	if ifaceRe.MatchString("wg0;x") || !ifaceRe.MatchString("wg0") || ifaceRe.MatchString("0wg") {
		t.Error("iface")
	}
}

func testPlan() *plan {
	return &plan{
		req:      createReq{Kind: kindRemote, Iface: "wg0", Port: 51820},
		tunnel:   netip.MustParsePrefix("10.66.0.0/24"),
		gwAddr:   netip.MustParsePrefix("10.66.0.1/24"),
		routes:   []netip.Prefix{netip.MustParsePrefix("10.115.217.0/24")},
		hostIPs:  []netip.Addr{netip.MustParseAddr("10.115.217.1")},
		endpoint: "vpn.example.com:51820",
	}
}

func TestGatewayConfig(t *testing.T) {
	pl := testPlan()
	conf := gatewayConfig(pl)
	for _, want := range []string{"Address = 10.66.0.1/24", "ListenPort = 51820", "# endpoint: vpn.example.com:51820", "# routes: 10.115.217.0/24", "PostUp = wg set %i private-key /etc/wireguard/private.key", "nft -f /etc/wireguard/%i.nft"} {
		if !strings.Contains(conf, want) {
			t.Errorf("config lacks %q:\n%s", want, conf)
		}
	}
	if strings.Contains(conf, "PrivateKey =") {
		t.Error("the gateway private key must not be in the config")
	}
	nft := gatewayNft("wg0", pl.routes, pl.hostIPs, netip.Addr{}, nil)
	if !strings.Contains(nft, `iifname "wg0" ip daddr { 10.115.217.0/24 } accept`) || !strings.Contains(nft, "masquerade") || !strings.Contains(nft, "policy drop") {
		t.Errorf("nft:\n%s", nft)
	}
	drop, accept := strings.Index(nft, `ip daddr { 10.115.217.1 } drop`), strings.Index(nft, "10.115.217.0/24 } accept")
	if drop < 0 || drop > accept {
		t.Errorf("host ip must be dropped before the accept:\n%s", nft)
	}
	if !strings.Contains(nft, `chain input`) || !strings.Contains(nft, `iifname "wg0" drop`) {
		t.Errorf("input chain:\n%s", nft)
	}
	// vps flavour: only the VPS, only the published tuples
	rules := []publishRule{{Proto: "tcp", Port: 8080, TargetIP: "10.115.217.5", TargetPort: 80}}
	vn := gatewayNft("wg0", pl.routes, pl.hostIPs, netip.MustParseAddr("10.66.0.1"), rules)
	if !strings.Contains(vn, `iifname "wg0" ip saddr 10.66.0.1 ip daddr 10.115.217.5 tcp dport 80 accept`) || strings.Contains(vn, "10.115.217.0/24") || !strings.Contains(vn, "10.115.217.1 } drop") {
		t.Errorf("vps nft:\n%s", vn)
	}
	if got := parsePublishList(publishList(rules)); len(got) != 1 || got[0] != rules[0] {
		t.Errorf("publish round trip: %+v", got)
	}
	// the VPS flavour dials out: no ListenPort, keepalive 25, the VPS as only peer
	pl.req = createReq{Kind: kindVPS, Iface: "wg0", VPSKey: key1, PSK: key2}
	pl.gwAddr = netip.MustParsePrefix("10.66.0.2/24")
	pl.endpoint = "203.0.113.9:51820"
	pl.req.Publish = []publishRule{{Proto: "tcp", Port: 8080, TargetIP: "10.115.217.5", TargetPort: 80}}
	v := gatewayConfig(pl)
	if !strings.Contains(v, "# publish: tcp/8080>10.115.217.5:80") || !strings.Contains(v, "# hosts: 10.115.217.1") {
		t.Errorf("header lacks publish/hosts:\n%s", v)
	}
	if strings.Contains(v, "ListenPort") || !strings.Contains(v, "PersistentKeepalive = 25") || !strings.Contains(v, "Endpoint = 203.0.113.9:51820") || !strings.Contains(v, "AllowedIPs = 10.66.0.1/32") {
		t.Errorf("vps flavour:\n%s", v)
	}
}

func TestConfParseEditAndAllocate(t *testing.T) {
	text := gatewayConfig(testPlan()) + peerBlock("laptop", key1, key2, "", "10.66.0.2/32", 0) + peerBlock("phone", key2, "", "", "10.66.0.3/32", 0)
	d := parseConf(text)
	if len(d.peers) != 2 || d.peers[0].Name != "laptop" || d.peers[1].PublicKey != key2 || d.peers[1].Name != "phone" {
		t.Fatalf("peers: %+v", d.peers)
	}
	if d.header("Address") != "10.66.0.1/24" || d.header("endpoint") != "vpn.example.com:51820" || d.header("ListenPort") != "51820" {
		t.Errorf("header: %q %q", d.header("Address"), d.header("endpoint"))
	}
	tun, gw := netip.MustParsePrefix("10.66.0.0/24"), netip.MustParseAddr("10.66.0.1")
	if ip, err := nextFreeIP(tun, gw, d.peers); err != nil || ip.String() != "10.66.0.4" {
		t.Fatalf("next ip %v %v", ip, err)
	}
	if !d.remove(key1) || d.remove(key1) {
		t.Fatal("remove")
	}
	out := d.String()
	if strings.Contains(out, "laptop") || strings.Contains(out, key1) || !strings.Contains(out, "phone") || !strings.Contains(out, "PostUp = wg set") {
		t.Errorf("after remove:\n%s", out)
	}
	if d2 := parseConf(out); len(d2.peers) != 1 || d2.peers[0].Name != "phone" {
		t.Error("reparse")
	}
	// the freed address is used again
	if ip, _ := nextFreeIP(tun, gw, d.peers); ip.String() != "10.66.0.2" {
		t.Errorf("reuse: %v", ip)
	}
	// a /30 holds the gateway and one peer
	if _, err := nextFreeIP(netip.MustParsePrefix("10.66.0.0/30"), gw, []*confPeer{{AllowedIPs: []string{"10.66.0.2/32"}}}); err == nil {
		t.Error("subnet should be full")
	}
	// names written before [Peer] (hand-written configs)
	h := parseConf("[Interface]\nAddress = 10.0.0.1/24\n\n# name: office\n[Peer]\nPublicKey = " + key1 + "\nAllowedIPs = 10.0.0.2/32, 192.168.1.0/24\n")
	if len(h.peers) != 1 || h.peers[0].Name != "office" || len(h.peers[0].AllowedIPs) != 2 {
		t.Errorf("hand-written: %+v", h.peers)
	}
}

func TestClientAndVPSConfig(t *testing.T) {
	c := clientConf(netip.MustParseAddr("10.66.0.2"), key1, "vpn.example.com:51820", []netip.Prefix{netip.MustParsePrefix("10.66.0.0/24"), netip.MustParsePrefix("10.0.0.0/24")}, true)
	for _, w := range []string{"PrivateKey = @PRIVATE_KEY@", "Address = 10.66.0.2/32", "PresharedKey = @PRESHARED_KEY@", "AllowedIPs = 10.66.0.0/24, 10.0.0.0/24", "PersistentKeepalive = 25"} {
		if !strings.Contains(c, w) {
			t.Errorf("client lacks %q", w)
		}
	}
	rules := []publishRule{{Proto: "tcp", Port: 8080, TargetIP: "10.0.0.5", TargetPort: 80}}
	allowed := []netip.Prefix{netip.MustParsePrefix("10.67.0.2/32"), netip.MustParsePrefix("10.0.0.0/24")}
	v := vpsConf(netip.MustParsePrefix("10.67.0.1/24"), 51820, key1, key2, allowed, rules)
	for _, w := range []string{"ListenPort = 51820", "PrivateKey = @VPS_PRIVATE_KEY@", "-A PREROUTING -p tcp --dport 8080 ! -i %i -j DNAT --to-destination 10.0.0.5:80", "-D PREROUTING -p tcp --dport 8080", "AllowedIPs = 10.67.0.2/32, 10.0.0.0/24", "PresharedKey = " + key2} {
		if !strings.Contains(v, w) {
			t.Errorf("vps lacks %q:\n%s", w, v)
		}
	}
	for _, w := range []string{"PostUp = iptables -A FORWARD -o %i -j DROP", "PostDown = iptables -D FORWARD -o %i -j DROP", "PREROUTING -p tcp --dport 8080 ! -i %i -j DNAT", "PostUp = iptables -A FORWARD -o %i -p tcp -d 10.0.0.5 --dport 80 -j ACCEPT", "PostDown = iptables -D FORWARD -o %i -p tcp -d 10.0.0.5 --dport 80 -j ACCEPT"} {
		if !strings.Contains(v, w) {
			t.Errorf("vps lacks %q", w)
		}
	}
	if strings.Contains(v, "%!") || strings.Contains(v, "{op}") {
		t.Errorf("formatting leftovers in:\n%s", v)
	}
	if strings.Contains(vpsConf(netip.MustParsePrefix("10.67.0.1/24"), 51820, key1, key2, allowed, nil), "iptables") {
		t.Error("no iptables rules without published ports")
	}
	s := vpsScript(v, 51820)
	if !strings.HasPrefix(s, "#!/bin/sh") || !strings.Contains(s, "<<'WG_CONF_END'") || !strings.Contains(s, "systemctl enable --now wg-quick@wg0") {
		t.Errorf("script:\n%s", s)
	}
}

const sampleDump = "wg0\t(hidden)\tSRVPUB=\t51820\toff\n" +
	"wg0\t" + key1 + "\t(hidden)\t203.0.113.7:40000\t10.66.0.2/32\t1700000000\t1234\t5678\toff\n" +
	"wg0\t" + key2 + "\t(hidden)\t(none)\t10.66.0.3/32\t0\t0\t0\toff\n" +
	"wg1\t(hidden)\tPUB1=\t0\toff\n"

func TestParseDump(t *testing.T) {
	d := parseDump(sampleDump)
	if len(d) != 2 || d[0].Name != "wg0" || d[0].ListenPort != 51820 || d[0].PublicKey != "SRVPUB=" || len(d[0].Peers) != 2 || len(d[1].Peers) != 0 {
		t.Fatalf("%+v", d)
	}
	p := d[0].Peers[0]
	if p.Endpoint != "203.0.113.7:40000" || p.LatestHandshake != 1700000000 || p.Rx != 1234 || p.Tx != 5678 || p.AllowedIPs[0] != "10.66.0.2/32" {
		t.Errorf("%+v", p)
	}
	if d[0].Peers[1].Endpoint != "" {
		t.Error("(none) endpoint")
	}
	// raw output with real private and preshared keys parses the same way
	raw := "wg0\tPRIV\tPUB\t1\toff\nwg0\t" + key1 + "\tPSK\t(none)\t(none)\t0\t0\t0\t25\n"
	if r := parseDump(raw); len(r) != 1 || len(r[0].Peers) != 1 || len(r[0].Peers[0].AllowedIPs) != 0 {
		t.Errorf("%+v", r)
	}
	if len(parseDump("")) != 0 {
		t.Error("empty")
	}
}

func TestParseStatus(t *testing.T) {
	out := "###DUMP\n" + sampleDump + "###CONF\n###FILE wg0\n[Interface]\nAddress = 10.66.0.1/24\n\n[Peer]\n# name: laptop\nPublicKey = " + key1 + "\nAllowedIPs = 10.66.0.2/32\n###FILE wg9\n[Interface]\nAddress = 10.9.0.1/24\nListenPort = 1234\n"
	st := parseStatus(out)
	if st.NoWG || len(st.Dump) != 2 || len(st.Order) != 2 || st.Confs["wg0"].names()[key1] != "laptop" || st.Confs["wg9"].header("ListenPort") != "1234" {
		t.Fatalf("%+v", st)
	}
	if !parseStatus("###NOWG\n").NoWG {
		t.Error("no wg")
	}
}

func TestKernelErr(t *testing.T) {
	for _, s := range []string{"RTNETLINK answers: Operation not supported", "Error: Protocol not supported", "Failed to load kernel module \"wireguard\""} {
		if !kernelErr(s) {
			t.Errorf("%q", s)
		}
	}
	if kernelErr("nft: syntax error") {
		t.Error("false positive")
	}
	if detectDistro("NAME=\"Ubuntu\"\nID=ubuntu\n") != "ubuntu" || detectDistro("ID=\"alpine\"\n") != "alpine" {
		t.Error("distro")
	}
}

func TestValidateCreateRejectsBadInput(t *testing.T) {
	a := &App{}
	ok := createReq{Kind: kindRemote, Server: "x", Project: "default", Instance: "wg-gw", Image: "ubuntu/24.04", Networks: []string{"incusbr0"}, Host: "vpn.example.com", Port: 51820, Subnet: "10.66.0.0/24"}
	bad := map[string]func(*createReq){
		"kind":     func(r *createReq) { r.Kind = "monitor" },
		"instance": func(r *createReq) { r.Instance = "a;b" },
		"image":    func(r *createReq) { r.Image = "x y" },
		"host":     func(r *createReq) { r.Host = "a b" },
		"port":     func(r *createReq) { r.Port = 70000 },
		"networks": func(r *createReq) { r.Networks = nil },
		"subnet":   func(r *createReq) { r.Subnet = "1.2.3.0/24" },
		"iface":    func(r *createReq) { r.Iface = "wg0;id" },
		"project":  func(r *createReq) { r.Project = "../x" },
	}
	for name, mut := range bad {
		r := ok
		mut(&r)
		if _, err := a.validateCreate(context.Background(), nil, r); err == nil {
			t.Errorf("%s should be rejected", name)
		}
	}
}

func TestStatusScriptFilters(t *testing.T) {
	if !strings.Contains(statusScript, "grep -v -i -E") || !strings.Contains(statusScript, "PostUp|PreUp|PostDown|PreDown") {
		t.Error("status script must filter case-insensitively and drop hook lines")
	}
}
