package main

import (
	"log"
	"runtime"
	"syscall"
)

// lowPriority makes the calling goroutine's thread nice 10, so a long
// conversion doesn't slow down the rest of the UI. The goroutine stays on
// that thread, and Go ends the thread when the goroutine returns, so no other
// work inherits the lower priority.
func lowPriority() {
	runtime.LockOSThread()
	if err := syscall.Setpriority(syscall.PRIO_PROCESS, syscall.Gettid(), 10); err != nil {
		log.Printf("import: lower priority: %v", err)
	}
}
