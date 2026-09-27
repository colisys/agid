package game

import (
	"encoding/json"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strings"

	"gateway/internal/services"
)

// Manifest is the self-description of a game pack (<root>/<game>/manifest.json).
// It is the only pack marker: a directory without a manifest is skipped by the
// gateway entirely. It declares the display name, the on-disk layout (rules
// base name, brains/ui dirs) and — fail-closed — which capabilities each brain
// may use (host.llm / host.intent / host.svc). See docs/game-server.md.
type Manifest struct {
	Name      string `json:"name,omitempty"`
	RulesBase string `json:"rules,omitempty"`      // base name, default "rules" (rules.js / rules.<ver>.js)
	BrainsDir string `json:"brains_dir,omitempty"` // default "brains"
	UIDir     string `json:"ui_dir,omitempty"`     // default "ui"

	// brain 名 -> 申请的能力（llm | jev | svc:<service>）。未声明的 brain 只拿 log。
	Capabilities map[string][]string `json:"capabilities,omitempty"`

	// 网关托管的 Python 后端服务（dev 直接 spawn，容器隔离用 compose 生成）。
	Services map[string]ServiceDef `json:"services,omitempty"`
}

// ServiceDef declares one managed backend service.
type ServiceDef struct {
	Runtime      string `json:"runtime"` // 目前仅 "python"
	Entry        string `json:"entry"`   // 相对包根，如 services/solver.py
	Port         int    `json:"port"`    // 127.0.0.1 固定端口
	Requirements string `json:"requirements,omitempty"`
	// Workdir is the process working directory, relative to the pack root
	// (default: the pack root itself). It is a single-segment-safe relative
	// path; ".." is rejected.
	Workdir string `json:"workdir,omitempty"`
	// DataDir is this service's writable area, relative to the gateway's
	// games.data_root — NOT to the pack. The gateway hands the resolved
	// absolute path to the process as SVC_DATA, so a pack never has to
	// discover where it is running from. Two services of the same game that
	// must share files declare the same data_dir. Default:
	// "<game>/<service>", i.e. per-service isolation.
	DataDir  string        `json:"data_dir,omitempty"`
	EnvAllow []string      `json:"env_allow,omitempty"` // 额外放行的环境变量名（fail-closed：不写则一个都不给）
	Sandbox  SandboxLimits `json:"sandbox,omitempty"`
	// MatchAccess lets this service observe a live match and post commands
	// into it, replacing the old "queue an op and hope a brain polls for it"
	// relay. Undeclared = no token = cannot touch any match.
	MatchAccess *MatchAccess `json:"match_access,omitempty"`
	// HTTP declares which of this service's routes are reachable through
	// /svc without a credential. Everything else needs the operator token.
	// Fail-closed: an unlisted route is not public.
	HTTP *ServiceHTTP `json:"http,omitempty"`
	// GatewayAccess lets this service act on the gateway itself — today,
	// creating a match on a player's behalf. This is how a player browser can
	// start a game without holding an operator credential: the service does
	// it with its own scoped token, not the admin one.
	GatewayAccess *services.GatewayAccess `json:"gateway_access,omitempty"`
}

// ServiceHTTP is the service's declared public surface behind /svc.
type ServiceHTTP struct {
	// Public lists "<METHOD> <path>" entries; a path may end in "/*" to cover
	// one collection's sub-paths, e.g. "GET /save/*".
	Public []string `json:"public,omitempty"`
}

var publicRouteRe = regexp.MustCompile(`^(GET|POST|PUT|PATCH|DELETE|HEAD) +\S+`)

func (sd ServiceDef) publicRoutes() []string {
	if sd.HTTP == nil {
		return nil
	}
	return sd.HTTP.Public
}

func (sd ServiceDef) gatewayAccess() services.GatewayAccess {
	if sd.GatewayAccess == nil {
		return services.GatewayAccess{}
	}
	return *sd.GatewayAccess
}

var validObserve = map[string]bool{"": true, "full": true, "digest": true}

// ServiceNames lists the declared services, sorted, for deterministic binding.
func (m *Manifest) ServiceNames() []string {
	out := make([]string, 0, len(m.Services))
	for n := range m.Services {
		out = append(out, n)
	}
	sort.Strings(out)
	return out
}

// BridgeAccess is the runtime form of the per-service match access.
func (m *Manifest) BridgeAccess() map[string]MatchAccess {
	out := make(map[string]MatchAccess, len(m.Services))
	for n, sd := range m.Services {
		if sd.MatchAccess == nil {
			continue
		}
		out[n] = MatchAccess{
			Observe:   sd.MatchAccess.Observe,
			Commands:  sd.MatchAccess.Commands,
			Notify:    sd.MatchAccess.Notify,
			TimeoutMs: sd.MatchAccess.TimeoutMs,
		}
	}
	return out
}

// SandboxLimits caps a managed service. Zero means unlimited. See
// docs/services-design.md.
type SandboxLimits struct {
	// Profile: "" 或 "strict" 为白名单环境 + 资源限制；"off" 退化为继承网关全部
	// 环境变量（含 ADMIN_TOKEN / Jev key），仅供本地调试。
	Profile    string `json:"profile,omitempty"`
	MemoryMB   int    `json:"memory_mb,omitempty"`
	CPUSeconds int    `json:"cpu_s,omitempty"`
	MaxFileMB  int    `json:"max_file_mb,omitempty"`
	// MaxProcs 对应 RLIMIT_NPROC——内核按「真实 UID」而不是按进程计数，
	// 设小了会让该用户的其他进程也 fork 失败，故默认不开。见 services.Limits。
	MaxProcs int `json:"max_procs,omitempty"`
}

// ResolvedDataDir is the service's writable area relative to the gateway's
// data root, with the per-service default applied. Separated from Ref because
// the root itself is gateway config, not pack config.
func (sd ServiceDef) ResolvedDataDir(game, name string) string {
	if sd.DataDir != "" {
		return sd.DataDir
	}
	return path.Join(game, name)
}

// Ref projects the declaration onto a supervisor Ref. Keeping this mapping in
// one place is what makes the dev spawn and the generated compose file agree —
// they used to be built separately, and the compose side silently lost the LLM
// environment. dataRoot is the gateway's resolved games.data_root.
func (sd ServiceDef) Ref(game, name, dir, dataRoot string, extraEnv []string) services.Ref {
	// workdir is a path INSIDE the pack; a "..' would escape it.
	wd := filepath.Join(dir, filepath.FromSlash(sd.Workdir))
	// data_dir is a path under the data root, never under the pack.
	data := filepath.Join(dataRoot, filepath.FromSlash(sd.ResolvedDataDir(game, name)))
	return services.Ref{
		Game: game, Name: name, Runtime: sd.Runtime, Entry: sd.Entry,
		Requirements: sd.Requirements, Port: sd.Port, Dir: dir,
		WorkDir: wd, DataDir: data,
		EnvAllow: sd.EnvAllow, ExtraEnv: extraEnv, PublicRoutes: sd.publicRoutes(),
		GatewayAccess: sd.gatewayAccess(),
		Limits: services.Limits{
			Profile:    sd.Sandbox.Profile,
			MemoryMB:   sd.Sandbox.MemoryMB,
			CPUSeconds: sd.Sandbox.CPUSeconds,
			MaxFileMB:  sd.Sandbox.MaxFileMB,
			MaxProcs:   sd.Sandbox.MaxProcs,
		},
	}
}

// DefaultManifest is used when a pack has no manifest file on disk (admin
// upload-only packs): default layout, zero capabilities (fail-closed).
func DefaultManifest() *Manifest {
	return &Manifest{RulesBase: "rules", BrainsDir: "brains", UIDir: "ui"}
}

var capRe = regexp.MustCompile(`^(llm|jev|svc:[a-z0-9_-]+)$`)

// validSeg accepts a single path segment (dir/base names): no separators,
// no "." or "..". Dots inside names are allowed (solver.v2).
func validSeg(s string) bool {
	if s == "" || s == "." || s == ".." {
		return false
	}
	return !strings.ContainsAny(s, `/\`)
}

// validRel accepts a relative path for service entry/requirements.
func validRel(p string) bool {
	if p == "" || filepath.IsAbs(p) || strings.Contains(p, `\`) {
		return false
	}
	return !slices.Contains(strings.Split(p, "/"), "..")
}

// ParseManifest validates and fills defaults. It never returns a nil Manifest
// without an error.
func ParseManifest(b []byte) (*Manifest, error) {
	var m Manifest
	if err := json.Unmarshal(b, &m); err != nil {
		return nil, fmt.Errorf("manifest: %w", err)
	}
	if m.RulesBase == "" {
		m.RulesBase = "rules"
	}
	if m.BrainsDir == "" {
		m.BrainsDir = "brains"
	}
	if m.UIDir == "" {
		m.UIDir = "ui"
	}
	for _, f := range []struct{ label, v string }{
		{"rules", m.RulesBase}, {"brains_dir", m.BrainsDir}, {"ui_dir", m.UIDir},
	} {
		if !validSeg(f.v) {
			return nil, fmt.Errorf("manifest: %s %q must be a single path segment", f.label, f.v)
		}
	}
	for brain, caps := range m.Capabilities {
		if !validSeg(brain) {
			return nil, fmt.Errorf("manifest: capabilities brain %q invalid", brain)
		}
		for _, c := range caps {
			if !capRe.MatchString(c) {
				return nil, fmt.Errorf("manifest: capability %q (brain %s) not in llm|jev|svc:<name>", c, brain)
			}
		}
	}
	for name, sd := range m.Services {
		if !validSeg(name) {
			return nil, fmt.Errorf("manifest: service %q invalid", name)
		}
		if sd.Runtime != "python" {
			return nil, fmt.Errorf("manifest: service %q runtime %q unsupported (only python)", name, sd.Runtime)
		}
		if !validRel(sd.Entry) {
			return nil, fmt.Errorf("manifest: service %q entry %q must be a relative path", name, sd.Entry)
		}
		if sd.Port <= 0 || sd.Port > 65535 {
			return nil, fmt.Errorf("manifest: service %q port must be in [1,65535]", name)
		}
		if sd.Requirements != "" && !validRel(sd.Requirements) {
			return nil, fmt.Errorf("manifest: service %q requirements %q must be a relative path", name, sd.Requirements)
		}
		// workdir is resolved inside the pack, data_dir under the gateway's
		// data root. Both are joined onto a fixed base, so a ".." or an
		// absolute path would write outside the area the operator granted.
		if sd.Workdir != "" && !validRel(sd.Workdir) {
			return nil, fmt.Errorf("manifest: service %q workdir %q must be a relative path inside the pack", name, sd.Workdir)
		}
		if sd.DataDir != "" && !validRel(sd.DataDir) {
			return nil, fmt.Errorf("manifest: service %q data_dir %q must be a relative path inside games.data_root", name, sd.DataDir)
		}
		// A public route is a deliberate widening of the service's surface, so
		// a malformed entry has to fail loudly rather than be dropped into a
		// deny-by-default policy the author did not intend.
		for _, e := range sd.publicRoutes() {
			if !publicRouteRe.MatchString(strings.TrimSpace(e)) {
				return nil, fmt.Errorf("manifest: service %q http.public %q must be \"<METHOD> <path>\" "+
					"(e.g. \"GET /top\", \"POST /save\", \"GET /save/*\")", name, e)
			}
		}
		// env_allow is a capability grant, so it is validated as strictly as
		// one: an operator credential listed here is an authoring mistake, and
		// silently dropping it would leave a pack that looks like it works but
		// does not.
		for _, k := range sd.EnvAllow {
			if !services.ValidEnvName(k) {
				return nil, fmt.Errorf("manifest: service %q env_allow %q is not a valid variable name", name, k)
			}
			if services.IsOperatorEnv(k) {
				return nil, fmt.Errorf("manifest: service %q env_allow %q is a gateway operator credential "+
					"and can never be granted to a managed service", name, k)
			}
		}
		if p := sd.Sandbox.Profile; p != "" && p != services.ProfileStrict && p != services.ProfileOff {
			return nil, fmt.Errorf("manifest: service %q sandbox profile %q unsupported (want %q or %q)",
				name, p, services.ProfileStrict, services.ProfileOff)
		}
		if ma := sd.MatchAccess; ma != nil {
			if !validObserve[ma.Observe] {
				return nil, fmt.Errorf("manifest: service %q match_access observe %q unsupported (want \"full\" or \"digest\")",
					name, ma.Observe)
			}
			// Channels become command-map keys the rules read; keep them to
			// identifiers so a pack cannot shadow a player slot or smuggle in
			// a path.
			for _, ch := range ma.Commands {
				if !validSeg(ch) {
					return nil, fmt.Errorf("manifest: service %q match_access command %q must be a single identifier", name, ch)
				}
			}
			if ma.TimeoutMs < 0 {
				return nil, fmt.Errorf("manifest: service %q match_access timeout_ms must not be negative", name)
			}
			// Declaring a channel is a request to act on a match; without a
			// way to see one first it is almost certainly a mistake.
			if len(ma.Commands) > 0 && !validObserve[ma.Observe] {
				return nil, fmt.Errorf("manifest: service %q posts commands but declares no observe mode", name)
			}
		}
		for label, v := range map[string]int{
			"memory_mb": sd.Sandbox.MemoryMB, "cpu_s": sd.Sandbox.CPUSeconds,
			"max_file_mb": sd.Sandbox.MaxFileMB, "max_procs": sd.Sandbox.MaxProcs,
		} {
			if v < 0 {
				return nil, fmt.Errorf("manifest: service %q sandbox %s must not be negative", name, label)
			}
		}
	}
	return &m, nil
}

// Manifest reads the pack manifest for game. A missing file yields the default
// manifest (upload-only packs keep working with zero capabilities); a corrupt
// one is an error.
func (s *DiskStore) Manifest(game string) (*Manifest, error) {
	p := filepath.Join(s.rootFor(game), game, "manifest.json")
	b, err := os.ReadFile(p)
	if err != nil {
		if os.IsNotExist(err) {
			return DefaultManifest(), nil
		}
		return nil, err
	}
	return ParseManifest(b)
}

// PackDir returns the on-disk directory serving game (the first root whose
// copy has a manifest), or false when the game has no disk pack.
func (s *DiskStore) PackDir(game string) (string, bool) {
	for _, r := range s.dirs {
		p := filepath.Join(r, game)
		if hasManifest(p) {
			return p, true
		}
	}
	return "", false
}

func hasManifest(dir string) bool {
	st, err := os.Stat(filepath.Join(dir, "manifest.json"))
	return err == nil && !st.IsDir()
}
