package jsflow

import _ "embed"

//go:embed scripts/default.js
var defaultScript string

// DefaultScript is the built-in orchestration flow, used when no script file
// is configured.
func DefaultScript() string { return defaultScript }
