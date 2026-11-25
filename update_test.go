package main

import "testing"

func TestNewerVersion(t *testing.T) {
	cases := []struct {
		a, b string
		want bool
	}{
		{"v0.2.0", "v0.1.0", true},
		{"v0.1.0", "v0.1.0", false},
		{"v0.1.0", "v0.2.0", false},
		{"v0.10.0", "v0.9.3", true},
		{"v1.0.0", "v1.0.0-rc1", true},
		{"v1.0.0-rc2", "v1.0.0-rc1", true},
		{"v1.0.0-rc1", "v1.0.0", false},
		{"v0.1.0", "dev", true},
		{"v0.1.0", "46b8253-dirty", true},
		{"garbage", "v0.1.0", false},
		{"v0.3.0", "v0.3.0-21-gd22bd77-dirty", false},
		{"v0.3.0", "v0.3.0-21-gd22bd77", false},
		{"v0.3.1", "v0.3.0-21-gd22bd77-dirty", true},
		{"v0.3.0-rc1", "v0.3.0-21-gd22bd77", false},
		{"v0.7.0-dev.5", "v0.7.0", true},
		{"v0.7.0", "v0.7.0-dev.5", false},
		{"v0.7.0-dev.12", "v0.7.0-dev.9", true},
		{"v0.7.0-dev.9", "v0.7.0-dev.12", false},
		{"v0.7.1", "v0.7.0-dev.12", true},
	}
	for _, c := range cases {
		if got := newerVersion(c.a, c.b); got != c.want {
			t.Errorf("newerVersion(%q, %q) = %v, want %v", c.a, c.b, got, c.want)
		}
	}
}

func TestOfferUpdate(t *testing.T) {
	rel := func(tag string) *releaseInfo { return &releaseInfo{Tag: tag} }
	cases := []struct {
		channel, latest, current string
		want                     bool
	}{
		{channelStable, "v0.7.1", "v0.7.0", true},
		{channelStable, "v0.7.0", "v0.7.0", false},
		{channelStable, "v0.7.0", "v0.7.0-dev.4", true}, // back to stable
		{channelStable, "v0.6.0", "v0.7.0", false},
		{channelDev, "v0.7.0-dev.5", "v0.7.0", true},
		{channelDev, "v0.7.0-dev.5", "v0.7.0-dev.5", false},
		{channelDev, "v0.7.0-dev.6", "v0.7.0-dev.5", true},
		{channelDev, "v0.7.1-dev.1", "v0.7.2", false}, // dev build older than the release
		{channelDev, "v0.7.0-dev.9", "v0.7.0-dev.12", false},
	}
	for _, c := range cases {
		if got := offerUpdate(c.channel, rel(c.latest), c.current); got != c.want {
			t.Errorf("offerUpdate(%s, %s, %s) = %v, want %v", c.channel, c.latest, c.current, got, c.want)
		}
	}
}
