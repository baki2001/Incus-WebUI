//go:build !linux

package main

// lowPriority does nothing outside Linux, where threads have no nice value
// of their own.
func lowPriority() {}
