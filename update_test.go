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
	}
	for _, c := range cases {
		if got := newerVersion(c.a, c.b); got != c.want {
			t.Errorf("newerVersion(%q, %q) = %v, want %v", c.a, c.b, got, c.want)
		}
	}
}
