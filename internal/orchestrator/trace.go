package orchestrator

import (
	"crypto/rand"
	"fmt"
)

func newTraceID() string {
	var b [8]byte
	_, _ = rand.Read(b[:])
	return fmt.Sprintf("tr_%x", b)
}
