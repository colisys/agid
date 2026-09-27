// Package services runs the Python backend services declared in game pack
// manifests (game.Manifest.Services). Dev mode spawns local processes and
// reverse-proxies them under /svc/<game>/<service>/; for container isolation
// the gateway only GENERATES a docker-compose.yml (EmitCompose) — it never
// runs docker itself.
package services

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

// Ref is one service to supervise, resolved from a pack manifest.
type Ref struct {
	Game         string
	Name         string
	Runtime      string
	Entry        string
	Requirements string
	Port         int
	Dir          string // pack root
	WorkDir      string // process cwd; empty means Dir
	DataDir      string // this service's writable area, passed as SVC_DATA

	GatewayURL    string        // base URL the service posts back to (match bridge)
	GatewayToken  string        // per-service token for gateway_access operations (SVC_TOKEN)
	GatewayAccess GatewayAccess // what this service may do on the gateway
	PublicRoutes  []string      // "<METHOD> <path>" entries reachable without a token
	EnvAllow      []string      // 额外放行的环境变量名（值取自 ExtraEnv）
	Limits        Limits
	ExtraEnv      []string // 网关可注入的候选变量，形如 K=V；只有 EnvAllow 点名的才进子进程
}

// GatewayAccess is what a service may do through the gateway's own API, using
// the per-service token the gateway mints and injects as SVC_TOKEN.
//
// It is deliberately far narrower than the operator token. A pack's Python can
// start a game on a player's behalf; it cannot reconfigure the gateway, rotate
// the Jev key, or reach another game. Handing a service the admin token instead
// would undo the point of the env whitelist — which is why this is a separate
// credential rather than a hole in the operator deny list.
type GatewayAccess struct {
	// CreateMatches allows POST /v1/games for THIS pack's game only.
	CreateMatches bool `json:"create_matches,omitempty"`
	// StopMatches allows POST /v1/games/<id>/stop.
	StopMatches bool `json:"stop_matches,omitempty"`
}

// Any reports whether the service asked for any gateway access at all.
func (g GatewayAccess) Any() bool { return g.CreateMatches || g.StopMatches }

func (r Ref) Key() string { return r.Game + "/" + r.Name }

// cwd is the process working directory: the declared workdir inside the pack,
// falling back to the pack root.
func (r Ref) cwd() string {
	if r.WorkDir != "" {
		return r.WorkDir
	}
	return r.Dir
}

// dataDir is the service's writable area. Created on demand: a service that
// cannot write here is broken anyway, and a missing directory at spawn time
// would surface as a confusing "No such file or directory" on first save.
func (r Ref) dataDir() string {
	if r.DataDir != "" {
		_ = os.MkdirAll(r.DataDir, 0o700)
		return r.DataDir
	}
	return r.Dir
}

// Sandbox profiles.
const (
	// ProfileStrict is the default: the service starts from a fixed minimal
	// environment and runs under resource limits. It cannot read the gateway's
	// operator credentials.
	ProfileStrict = "strict"
	// ProfileOff opts out entirely — the service inherits the gateway's whole
	// environment, ADMIN_TOKEN and Jev key included. For local debugging only;
	// spawn logs a warning.
	ProfileOff = "off"
)

// Limits are the resource caps applied under the strict profile. A zero field
// is unlimited.
type Limits struct {
	Profile    string
	MemoryMB   int
	CPUSeconds int
	MaxFileMB  int
	// MaxProcs maps to RLIMIT_NPROC, which the kernel counts PER REAL UID, not
	// per process: once the operator's whole session is past the value, every
	// fork by that user fails — including this service's. It is therefore off
	// by default; set it only when you know the user's total process count is
	// comfortably below it.
	MaxProcs int
}

func (l Limits) profile() string {
	if l.Profile == "" {
		return ProfileStrict
	}
	return l.Profile
}

// gatewayOperatorEnv are the operator's own credentials — admin API access and
// the Jev decision key. A managed service never receives them, and asking for
// one in a pack's env_allow is refused rather than silently ignored.
//
// This is a boundary on POWER, not on secrecy alone: a pack that is granted the
// derived LLM_UPSTREAM_KEY holds the same bytes as the gateway's LLM_API_KEY.
// That is deliberate — rules.js and brains/*.js already run inside the same
// trust domain as the pack. What must not leak is the ability to reconfigure
// the gateway, rotate its Jev key, or reach other tenants' games.
var gatewayOperatorEnv = map[string]bool{
	"ADMIN_TOKEN":       true,
	"TYPESAFE_API_KEY":  true,
	"JEV_API_KEY":       true,
	"LLM_API_KEY":       true,
	"OPENAI_API_KEY":    true,
	"ANTHROPIC_API_KEY": true,
	"GEMINI_API_KEY":    true,
}

var envNameRe = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

// ValidEnvName reports whether name is a syntactically valid environment
// variable name that a pack may ask to inherit.
func ValidEnvName(name string) bool {
	return envNameRe.MatchString(name)
}

// IsOperatorEnv reports whether name is a gateway operator credential that can
// never be handed to a managed service.
func IsOperatorEnv(name string) bool { return gatewayOperatorEnv[name] }

// servicePath is the minimal PATH a managed service gets. The gateway's own
// PATH is not inherited: it can point at directories holding operator tooling.
const servicePath = "/usr/local/bin:/usr/bin:/bin"

// buildEnv returns the ENTIRE environment of a managed service. Under the
// strict profile this is a fixed minimal set — the gateway's os.Environ() is
// never spread in, so a service cannot read ADMIN_TOKEN or the Jev key no
// matter what the pack asks for.
func buildEnv(r Ref) []string {
	env := []string{
		"PATH=" + servicePath,
		// HOME points at the pack's working directory, not the operator's
		// real home: ~ resolves inside the pack instead of exposing
		// ~/.config/gateway/env.
		"HOME=" + r.cwd(),
		"LANG=C.UTF-8",
		"LC_ALL=C.UTF-8",
		"PYTHONUNBUFFERED=1",
		// Without this the service writes __pycache__ back into the pack,
		// which is a read-only mount in the container deployment.
		"PYTHONDONTWRITEBYTECODE=1",
		"SVC_PORT=" + itoa(r.Port),
		"SVC_NAME=" + r.Name,
		"GAME=" + r.Game,
		"GAME_ROOT=" + r.Dir,
		// The one writable area, declared by the pack as data_dir and
		// resolved by the gateway. Always set: a service must never have to
		// infer its storage location from __file__.
		"SVC_DATA=" + r.dataDir(),
		"SVC_SANDBOX=" + r.Limits.profile(),
	}
	// Where to post back for the match bridge. This is a gateway-owned
	// endpoint, not a credential, so it needs no env_allow — and it carries
	// no secret: acting on a match still requires the per-match token that
	// only the observe payload contains.
	if r.GatewayURL != "" {
		env = append(env, "GATEWAY_URL="+r.GatewayURL)
	}
	// Scoped credential for gateway_access operations. It authorises only what
	// this service's manifest declared, and only for this service's own game —
	// so unlike the operator token it is safe to hand a pack's code.
	if r.GatewayToken != "" && r.GatewayAccess.Any() {
		env = append(env, "SVC_TOKEN="+r.GatewayToken)
	}
	if r.Limits.profile() == ProfileOff {
		return append(os.Environ(), env...)
	}
	// Only names the pack explicitly asked for, and only from the gateway's
	// candidate pool. Everything else in ExtraEnv stays in the gateway.
	return append(env, allowedEnv(r)...)
}

// command resolves the argv to launch a service, wrapping it in resource
// limits. prlimit (util-linux) is preferred because Go's SysProcAttr cannot set
// rlimits before exec; the shell fallback is best-effort.
func command(r Ref) (string, []string) {
	if r.Limits.profile() == ProfileOff {
		return "python3", []string{r.Entry}
	}
	var args []string
	if r.Limits.MemoryMB > 0 {
		args = append(args, fmt.Sprintf("--as=%d", int64(r.Limits.MemoryMB)<<20))
	}
	if r.Limits.MaxProcs > 0 {
		args = append(args, fmt.Sprintf("--nproc=%d", r.Limits.MaxProcs))
	}
	if r.Limits.CPUSeconds > 0 {
		args = append(args, fmt.Sprintf("--cpu=%d", r.Limits.CPUSeconds))
	}
	if r.Limits.MaxFileMB > 0 {
		args = append(args, fmt.Sprintf("--fsize=%d", int64(r.Limits.MaxFileMB)<<20))
	}
	if len(args) > 0 {
		if _, err := exec.LookPath("prlimit"); err == nil {
			return "prlimit", append(args, "python3", r.Entry)
		}
		// Fallback: bash ulimit. -v is KB and -t is seconds, both
		// unambiguous; file size is skipped rather than guessed at (bash and
		// POSIX disagree on its unit).
		var b strings.Builder
		if r.Limits.MemoryMB > 0 {
			fmt.Fprintf(&b, "ulimit -v %d; ", r.Limits.MemoryMB*1024)
		}
		if r.Limits.CPUSeconds > 0 {
			fmt.Fprintf(&b, "ulimit -t %d; ", r.Limits.CPUSeconds)
		}
		b.WriteString("exec python3 " + r.Entry)
		return "sh", []string{"-c", b.String()}
	}
	return "python3", []string{r.Entry}
}

const (
	maxFails       = 5
	probeTries     = 30
	probeInterval  = 200 * time.Millisecond
	maxBackoff     = 30 * time.Second
	callTimeout    = 30 * time.Second
	maxRespBytes   = 8 << 20
	maxStartupWait = probeTries * probeInterval
)

type proc struct {
	ref     Ref
	cmd     *exec.Cmd    // only touched by the supervise goroutine
	pid     atomic.Int64 // negative pgid for StopAll; written after successful Start
	up      atomic.Bool
	stopped atomic.Bool
	fails   int
}

// Supervisor owns the managed service processes.
type Supervisor struct {
	mu    sync.RWMutex
	procs map[string]*proc
	logf  func(format string, args ...any)
}

func New(logf func(format string, args ...any)) *Supervisor {
	if logf == nil {
		logf = func(string, ...any) {}
	}
	return &Supervisor{procs: map[string]*proc{}, logf: logf}
}

// StartAll spawns every declared service. Failures (bad runtime, port busy)
// are logged, never fatal to the gateway.
func (s *Supervisor) StartAll(refs []Ref) {
	for _, r := range refs {
		if r.Runtime != "python" {
			s.logf("svc %s: unsupported runtime %q, skipped", r.Key(), r.Runtime)
			continue
		}
		p := &proc{ref: r}
		s.mu.Lock()
		_, dup := s.procs[r.Key()]
		if !dup {
			s.procs[r.Key()] = p
		}
		s.mu.Unlock()
		if dup {
			s.logf("svc %s: duplicate, skipped", r.Key())
			continue
		}
		go s.supervise(p)
	}
}

// supervise runs one service until StopAll, restarting with backoff.
func (s *Supervisor) supervise(p *proc) {
	backoff := time.Second
	for {
		started := s.spawn(p)
		if started {
			s.probe(p)
		}
		err := p.cmd.Wait()
		if p.stopped.Load() {
			return
		}
		p.up.Store(false)
		p.fails++
		if started && err == nil {
			p.fails = 0 // clean exit: restart promptly
		}
		if p.fails >= maxFails {
			s.logf("svc %s: gave up after %d failures", p.ref.Key(), p.fails)
			return
		}
		s.logf("svc %s: exited (%v), retry in %s (fail %d/%d)", p.ref.Key(), err, backoff, p.fails, maxFails)
		time.Sleep(backoff)
		backoff *= 2
		if backoff > maxBackoff {
			backoff = maxBackoff
		}
	}
}

func (s *Supervisor) spawn(p *proc) bool {
	name, args := command(p.ref)
	cmd := exec.Command(name, args...)
	cmd.Dir = p.ref.cwd()
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true} // own process group
	cmd.Env = buildEnv(p.ref)
	if p.ref.Limits.profile() == ProfileOff {
		s.logf("svc %s: SANDBOX OFF — inherits the gateway environment "+
			"(ADMIN_TOKEN and the Jev key are readable). Local debugging only.", p.ref.Key())
	} else {
		s.logf("svc %s: env whitelisted, limits %s", p.ref.Key(), describeLimits(p.ref.Limits))
	}
	cmd.Stdout = &lineWriter{prefix: "svc " + p.ref.Key()}
	cmd.Stderr = &lineWriter{prefix: "svc " + p.ref.Key()}
	p.cmd = cmd
	if err := cmd.Start(); err != nil {
		s.logf("svc %s: spawn: %v", p.ref.Key(), err)
		return false
	}
	p.pid.Store(int64(cmd.Process.Pid))
	return true
}

func describeLimits(l Limits) string {
	parts := []string{"profile=" + l.profile()}
	if l.MemoryMB > 0 {
		parts = append(parts, fmt.Sprintf("mem=%dMB", l.MemoryMB))
	}
	if l.MaxProcs > 0 {
		parts = append(parts, fmt.Sprintf("nproc=%d", l.MaxProcs))
	}
	if l.CPUSeconds > 0 {
		parts = append(parts, fmt.Sprintf("cpu=%ds", l.CPUSeconds))
	}
	if l.MaxFileMB > 0 {
		parts = append(parts, fmt.Sprintf("fsize=%dMB", l.MaxFileMB))
	}
	return strings.Join(parts, " ")
}

// probe waits until the declared port accepts TCP connections.
func (s *Supervisor) probe(p *proc) {
	addr := fmt.Sprintf("127.0.0.1:%d", p.ref.Port)
	for i := 0; i < probeTries; i++ {
		conn, err := net.DialTimeout("tcp", addr, probeInterval)
		if err == nil {
			conn.Close()
			p.up.Store(true)
			p.fails = 0
			s.logf("svc %s: up on %s", p.ref.Key(), addr)
			return
		}
		time.Sleep(probeInterval)
	}
	s.logf("svc %s: not reachable after %s", p.ref.Key(), maxStartupWait)
}

// Target returns the base URL of a declared service.
func (s *Supervisor) Target(game, name string) (string, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	p, ok := s.procs[game+"/"+name]
	if !ok {
		return "", false
	}
	return fmt.Sprintf("http://127.0.0.1:%d", p.ref.Port), true
}

// Up reports whether the service port is currently reachable.
func (s *Supervisor) Up(game, name string) bool {
	s.mu.RLock()
	p, ok := s.procs[game+"/"+name]
	s.mu.RUnlock()
	if !ok {
		return false
	}
	conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", p.ref.Port), 500*time.Millisecond)
	if err != nil {
		p.up.Store(false)
		return false
	}
	conn.Close()
	p.up.Store(true)
	return true
}

// Call posts JSON to a managed service and decodes the JSON response. Used by
// the host.svc capability; blocking, so callers must keep it low-frequency.
func (s *Supervisor) Call(game, name, path string, body any) (any, error) {
	target, ok := s.Target(game, name)
	if !ok {
		return nil, fmt.Errorf("svc %q not declared for game %q", name, game)
	}
	if !s.Up(game, name) {
		return nil, fmt.Errorf("svc %s/%s is down", game, name)
	}
	path = strings.TrimPrefix(path, "/")
	payload, err := json.Marshal(body)
	if err != nil {
		return nil, fmt.Errorf("svc encode: %w", err)
	}
	req, err := http.NewRequest(http.MethodPost, target+"/"+path, bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := (&http.Client{Timeout: callTimeout}).Do(req)
	if err != nil {
		return nil, fmt.Errorf("svc %s/%s: %w", game, name, err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxRespBytes))
	if err != nil {
		return nil, fmt.Errorf("svc %s/%s: %w", game, name, err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("svc %s/%s: HTTP %d: %s", game, name, resp.StatusCode, truncate(string(raw), 200))
	}
	var out any
	if err := json.Unmarshal(raw, &out); err != nil {
		// Text responses are passed through as-is.
		return map[string]any{"text": string(raw)}, nil
	}
	return out, nil
}

// Ref returns the full declaration of a service, so callers (the /svc proxy)
// can apply the pack's own access policy before forwarding.
func (s *Supervisor) Ref(game, name string) (Ref, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	p, ok := s.procs[game+"/"+name]
	if !ok {
		return Ref{}, false
	}
	return p.ref, true
}

// Push delivers a one-way JSON POST to a managed service: the per-tick match
// snapshot push. Unlike Call it does not wait for or interpret the reply — a
// backend that is slow or wedged must cost only its own updates, never the
// tick loop. The caller is expected to run it off the hot path.
func (s *Supervisor) Push(game, name, path string, body any, timeout time.Duration) error {
	target, ok := s.Target(game, name)
	if !ok {
		return fmt.Errorf("svc %q not declared for game %q", name, game)
	}
	payload, err := json.Marshal(body)
	if err != nil {
		return fmt.Errorf("svc encode: %w", err)
	}
	req, err := http.NewRequest(http.MethodPost, target+"/"+strings.TrimPrefix(path, "/"), bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if timeout <= 0 {
		timeout = 3 * time.Second
	}
	resp, err := (&http.Client{Timeout: timeout}).Do(req)
	if err != nil {
		return fmt.Errorf("svc %s/%s: %w", game, name, err)
	}
	defer resp.Body.Close()
	// Drain so the connection can be reused rather than torn down each tick.
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, maxRespBytes))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("svc %s/%s: HTTP %d", game, name, resp.StatusCode)
	}
	return nil
}

// IsPublicRoute reports whether a service route may be reached without a
// credential. The declaration is per method AND path ("GET /top",
// "POST /save", "GET /save/*"), because a service's read and write surfaces
// rarely share a path shape — a pack that exposed /save/* would also expose
// its DELETE, which removes another player's save.
//
// Fail-closed: a route that is not declared is not public, whatever the
// service itself thinks. Previously /svc/* was entirely open and each service
// had to police itself — and two of them did not.
func (r Ref) IsPublicRoute(method, path string) bool {
	path = "/" + strings.TrimPrefix(path, "/")
	for _, entry := range r.PublicRoutes {
		m, p, ok := strings.Cut(strings.TrimSpace(entry), " ")
		if !ok || !strings.EqualFold(strings.TrimSpace(m), method) {
			continue
		}
		p = strings.TrimSpace(p)
		if p == path {
			return true
		}
		// A trailing "/*" covers the sub-paths of one collection.
		if rest, ok := strings.CutSuffix(p, "/*"); ok {
			if rest == "/" && path != "/" {
				return strings.HasPrefix(path, "/")
			}
			if strings.HasPrefix(path, rest+"/") {
				return true
			}
		}
	}
	return false
}

// StopAll terminates every managed process group.
func (s *Supervisor) StopAll() {
	s.mu.Lock()
	procs := make([]*proc, 0, len(s.procs))
	for _, p := range s.procs {
		procs = append(procs, p)
	}
	s.procs = map[string]*proc{}
	s.mu.Unlock()
	for _, p := range procs {
		p.stopped.Store(true)
		if pid := p.pid.Load(); pid > 0 {
			// Kill the whole process group (Setpgid put the child in its own).
			_ = syscall.Kill(-int(pid), syscall.SIGTERM)
		}
	}
}

// EmitCompose renders a docker-compose.yml covering all declared services.
// The gateway only generates the file; running docker is the operator's call.
// Bind-mount sources are ABSOLUTE paths: the generated file may live anywhere
// (e.g. <repo>/data/docker-compose.yml), and docker resolves relative volumes
// against the compose file's directory, which would silently break the mounts.
func EmitCompose(refs []Ref) string {
	sorted := append([]Ref(nil), refs...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].Key() < sorted[j].Key() })
	var b strings.Builder
	b.WriteString("# GENERATED by POST /admin/compose — 容器隔离编排，网关不代跑 docker。\n")
	b.WriteString("# 运行：docker compose up -d（与网关同机时，服务端口仍映射在 127.0.0.1）\n")
	b.WriteString("#\n")
	b.WriteString("# 隔离：rootfs 只读、丢弃全部 capability、no-new-privileges；\n")
	b.WriteString("#       依赖装进 /tmp 下的 venv（只读根文件系统里唯一可写处）；\n")
	b.WriteString("#       每个服务只挂自己的数据区到 /data（SVC_DATA），不共享；\n")
	b.WriteString("#       服务拿不到网关的 ADMIN_TOKEN / Jev key：下面的 environment\n")
	b.WriteString("#       是完整集合，不做继承。\n")
	b.WriteString("services:\n")
	for _, r := range sorted {
		fmt.Fprintf(&b, "  %s-%s:\n", r.Game, r.Name)
		b.WriteString("    image: python:3.12-slim\n")
		fmt.Fprintf(&b, "    working_dir: %s\n", composeWorkdir(r))
		fmt.Fprintf(&b, "    command: %s\n", composeCommand(r))
		b.WriteString("    read_only: true\n")
		b.WriteString("    cap_drop:\n      - ALL\n")
		b.WriteString("    security_opt:\n      - no-new-privileges:true\n")
		b.WriteString("    environment:\n")
		fmt.Fprintf(&b, "      SVC_PORT: %d\n", r.Port)
		b.WriteString("      GAME_ROOT: /app\n")
		fmt.Fprintf(&b, "      GAME: %s\n", r.Game)
		fmt.Fprintf(&b, "      SVC_NAME: %s\n", r.Name)
		fmt.Fprintf(&b, "      HOME: %s\n", composeWorkdir(r))
		b.WriteString("      LANG: C.UTF-8\n")
		b.WriteString("      PYTHONUNBUFFERED: \"1\"\n")
		b.WriteString("      PYTHONDONTWRITEBYTECODE: \"1\"\n")
		// 容器内的 /data 对应宿主上该服务自己的数据区，与 dev 模式的
		// SVC_DATA 落在同一相对位置。
		fmt.Fprintf(&b, "      SVC_DATA: /data\n")
		fmt.Fprintf(&b, "      SVC_SANDBOX: %s\n", r.Limits.profile())
		if len(allowedEnv(r)) > 0 {
			// Secrets (an LLM key, a pack token) are NOT inlined here. The
			// compose file is a readable, shareable artifact; writing a key
			// into it would put the credential in whatever the operator
			// commits, pastes into a ticket, or serves from /admin. The
			// values live in a sibling 600-mode env file instead.
			fmt.Fprintf(&b, "    env_file:\n      - %s\n", ComposeEnvFile(r))
		}
		b.WriteString("    volumes:\n")
		fmt.Fprintf(&b, "      - %s:/app:ro\n", composeVolume(r.Dir))
		fmt.Fprintf(&b, "      - %s:/data\n", composeVolume(r.dataDir()))
		b.WriteString("    tmpfs:\n      - /tmp\n")
		fmt.Fprintf(&b, "    ports:\n      - \"127.0.0.1:%d:%d\"\n", r.Port, r.Port)
		b.WriteString("    restart: unless-stopped\n")
	}
	return b.String()
}

// composeWorkdir is the in-container cwd: /app plus the declared workdir,
// mirroring the dev spawn where it is the pack root plus the same segment.
func composeWorkdir(r Ref) string {
	if r.WorkDir == "" {
		return "/app"
	}
	rel, err := filepath.Rel(r.Dir, r.WorkDir)
	if err != nil || rel == "." || strings.HasPrefix(rel, "..") {
		return "/app" // outside the pack: fall back rather than mount-escape
	}
	return path.Join("/app", filepath.ToSlash(rel))
}

// allowedEnv resolves the environment a service actually receives: the pool
// entries the pack named in env_allow, minus the operator credentials. Shared
// by the local spawn and by the compose env file so the two agree.
func allowedEnv(r Ref) []string {
	if r.Limits.profile() == ProfileOff {
		return nil
	}
	allow := make(map[string]bool, len(r.EnvAllow))
	for _, k := range r.EnvAllow {
		if ValidEnvName(k) && !IsOperatorEnv(k) {
			allow[k] = true
		}
	}
	var out []string
	for _, kv := range r.ExtraEnv {
		k, v, ok := strings.Cut(kv, "=")
		if !ok || !allow[k] {
			continue
		}
		out = append(out, k+"="+v)
	}
	sort.Strings(out)
	return out
}

// ComposeEnvFile is the name of the sibling env file holding a service's
// granted variables. Kept next to the compose file so `docker compose -f x.yml
// up` picks it up without extra flags.
func ComposeEnvFile(r Ref) string { return "env." + r.Game + "-" + r.Name + ".env" }

// ComposeEnvFiles returns the env-file contents for every service that has
// granted variables, keyed by ComposeEnvFile name. The caller is responsible
// for writing them with 0600 permissions; they contain credentials.
func ComposeEnvFiles(refs []Ref) map[string]string {
	out := map[string]string{}
	for _, r := range refs {
		vars := allowedEnv(r)
		if len(vars) == 0 {
			continue
		}
		body := "# GENERATED by the gateway for pack service " + r.Key() + ".\n" +
			"# 600 权限，不要提交、不要贴进工单。\n" + strings.Join(vars, "\n") + "\n"
		out[ComposeEnvFile(r)] = body
	}
	return out
}

func composeVolume(dir string) string {
	// Must be absolute: games_dir is commonly relative ("examples,scripts/games"
	// in the shipped config), and docker resolves a relative volume against the
	// COMPOSE FILE's directory — not the gateway's working directory. The
	// generated file lands wherever the operator ran the command, so a relative
	// source silently mounts the wrong path (or an empty auto-created dir).
	if abs, err := filepath.Abs(dir); err == nil {
		return filepath.Clean(abs)
	}
	return filepath.Clean(dir)
}

func composeCommand(r Ref) string {
	// The container rootfs is read-only (see EmitCompose), so site-packages is
	// unwritable and a plain `pip install` would fail. Install into a venv on
	// the /tmp tmpfs instead, which is writable and discarded on restart.
	if r.Requirements != "" {
		return fmt.Sprintf(
			"sh -c \"python -m venv /tmp/venv && /tmp/venv/bin/pip install --no-cache-dir -q -r %s && exec /tmp/venv/bin/python %s\"",
			r.Requirements, r.Entry)
	}
	return "python " + r.Entry
}

// lineWriter forwards subprocess output to the gateway log line by line.
type lineWriter struct {
	prefix string
	buf    []byte
}

func (w *lineWriter) Write(p []byte) (int, error) {
	w.buf = append(w.buf, p...)
	for {
		i := bytes.IndexByte(w.buf, '\n')
		if i < 0 {
			break
		}
		line := strings.TrimRight(string(w.buf[:i]), "\r")
		w.buf = w.buf[i+1:]
		if line != "" {
			fmt.Printf("%s: %s\n", w.prefix, line)
		}
	}
	return len(p), nil
}

func itoa(n int) string { return fmt.Sprintf("%d", n) }

func truncate(s string, n int) string {
	if len(s) > n {
		return s[:n] + "…"
	}
	return s
}
