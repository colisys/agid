package services

import (
	"encoding/json"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestSupervisorCallAndProxyLifecycle(t *testing.T) {
	if _, err := exec.LookPath("python3"); err != nil {
		t.Skip("python3 not available")
	}
	dir := t.TempDir()
	// Fake service: stdlib POST -> JSON.
	port := freePort(t)
	script := "import os, json\n" +
		"from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer\n" +
		"class H(BaseHTTPRequestHandler):\n" +
		"    def do_POST(self):\n" +
		"        n = int(self.headers.get('Content-Length', 0)); self.rfile.read(n)\n" +
		"        b = json.dumps({'ok': True}).encode()\n" +
		"        self.send_response(200); self.send_header('Content-Type', 'application/json')\n" +
		"        self.send_header('Content-Length', str(len(b))); self.end_headers(); self.wfile.write(b)\n" +
		"    def log_message(self, *a): pass\n" +
		"ThreadingHTTPServer(('127.0.0.1', int(os.environ['SVC_PORT'])), H).serve_forever()\n"
	if err := os.WriteFile(filepath.Join(dir, "svc.py"), []byte(script), 0o644); err != nil {
		t.Fatal(err)
	}
	sup := New(func(string, ...any) {})
	sup.StartAll([]Ref{{
		Game: "g", Name: "fake", Runtime: "python", Entry: "svc.py", Port: port, Dir: dir,
	}})
	defer sup.StopAll()

	waitUp(t, sup, "g", "fake")

	out, err := sup.Call("g", "fake", "/hello", map[string]any{"a": 1})
	if err != nil {
		t.Fatalf("Call: %v", err)
	}
	if m, ok := out.(map[string]any); !ok || m["ok"] != true {
		t.Fatalf("unexpected response: %#v", out)
	}
	if _, err := sup.Call("g", "nope", "/x", nil); err == nil {
		t.Fatal("undeclared service must error")
	}
	sup.StopAll()
	if sup.Up("g", "fake") {
		t.Fatal("service must be down after StopAll")
	}
}

func TestEmitCompose(t *testing.T) {
	cwd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	refs := []Ref{
		{Game: "dungeon", Name: "solver", Runtime: "python", Entry: "services/solver.py",
			Requirements: "services/requirements.txt", Port: 8901, Dir: "/repo/examples/dungeon",
			EnvAllow: []string{"LLM_UPSTREAM_KEY"},
			ExtraEnv: []string{"LLM_UPSTREAM_KEY=sk-pooled", "ADMIN_TOKEN=admin-pooled"},
			Limits:   Limits{MemoryMB: 256}},
		{Game: "rts", Name: "ai", Runtime: "python", Entry: "ai/main.py", Port: 8902, Dir: "/repo/scripts/games/rts"},
	}
	out := EmitCompose(refs)
	for _, want := range []string{
		"dungeon-solver:", "rts-ai:",
		"127.0.0.1:8901:8901", "python:3.12-slim",
		// Absolute volumes: the compose file may live anywhere (e.g.
		// data/compose-<host>.yml) and docker resolves relative volumes
		// against its own directory, which would silently break the mounts.
		"/repo/examples/dungeon:/app:ro", "/repo/scripts/games/rts:/app:ro",
		// Hardening.
		"read_only: true", "cap_drop:", "- ALL", "no-new-privileges:true",
		"tmpfs:", "- /tmp",
		"python -m venv /tmp/venv",
		"SVC_SANDBOX: strict",
		// A granted credential is referenced, never inlined.
		"env_file:", "env.dungeon-solver.env",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("compose missing %q:\n%s", want, out)
		}
	}
	// Neither the granted key nor the operator credential may appear in the
	// YAML — the compose file is a readable, shareable artifact.
	for _, leak := range []string{"sk-pooled", "admin-pooled"} {
		if strings.Contains(out, leak) {
			t.Errorf("credential %q inlined into compose:\n%s", leak, out)
		}
	}
	// The values still reach the service, via the env file.
	files := ComposeEnvFiles(refs)
	body, ok := files["env.dungeon-solver.env"]
	if !ok {
		t.Fatalf("env file missing, got %v", files)
	}
	if !strings.Contains(body, `LLM_UPSTREAM_KEY="sk-pooled"`) && !strings.Contains(body, "LLM_UPSTREAM_KEY=sk-pooled") {
		t.Errorf("granted value missing from env file:\n%s", body)
	}
	if strings.Contains(body, "admin-pooled") {
		t.Errorf("operator credential reached the env file:\n%s", body)
	}
	if _, ok := files["env.rts-ai.env"]; ok {
		t.Error("a service with no env_allow must not get an env file")
	}
	// The default venv-free command for a pack with no requirements.
	if !strings.Contains(out, "command: python ai/main.py") {
		t.Errorf("plain command missing:\n%s", out)
	}
	// Regression: games_dir is usually RELATIVE ("examples,scripts/games" in
	// the shipped config). A relative volume source is resolved by docker
	// against the compose file's directory, not the gateway's cwd, so the
	// mount would silently point at the wrong path.
	rel := EmitCompose([]Ref{{Game: "d", Name: "pm", Runtime: "python", Entry: "pm.py",
		Port: 8902, Dir: "examples/dungeon", DataDir: filepath.Join(cwd, "data", "dungeon")}})
	want := "      - " + filepath.Join(cwd, "examples/dungeon") + ":/app:ro\n"
	if !strings.Contains(rel, want) {
		t.Errorf("relative games_dir must be emitted as an absolute volume:\ngot  %q\nwant %q", rel, want)
	}
	// Per-service data mount, and no shared volume any more: dev and compose
	// now put SVC_DATA at the same relative position.
	if !strings.Contains(rel, "      - "+filepath.Join(cwd, "data", "dungeon")+":/data\n") {
		t.Errorf("per-service data mount missing:\n%s", rel)
	}
	if strings.Contains(rel, "gateway_data") {
		t.Errorf("shared data volume should be gone:\n%s", rel)
	}
}

// The service must be told where to persist and where it runs, rather than
// having to infer either from its own file location.
func TestWorkdirAndSVCData(t *testing.T) {
	pack := t.TempDir()
	data := t.TempDir()
	os.MkdirAll(filepath.Join(pack, "svc"), 0o755)

	r := Ref{Game: "g", Name: "s", Port: 1, Dir: pack, WorkDir: filepath.Join(pack, "svc"),
		DataDir: filepath.Join(data, "g", "s")}
	if r.cwd() != filepath.Join(pack, "svc") {
		t.Errorf("cwd = %q", r.cwd())
	}
	// The data dir is created for the service: a first save failing with
	// "No such file or directory" is a confusing way to learn this.
	if got := r.dataDir(); got != filepath.Join(data, "g", "s") {
		t.Fatalf("dataDir = %q", got)
	}
	if _, err := os.Stat(filepath.Join(data, "g", "s")); err != nil {
		t.Errorf("data dir not created: %v", err)
	}
	env := map[string]string{}
	for _, kv := range buildEnv(r) {
		if k, v, ok := strings.Cut(kv, "="); ok {
			env[k] = v
		}
	}
	if env["SVC_DATA"] != filepath.Join(data, "g", "s") {
		t.Errorf("SVC_DATA = %q", env["SVC_DATA"])
	}
	if env["HOME"] != filepath.Join(pack, "svc") {
		t.Errorf("HOME should follow workdir, got %q", env["HOME"])
	}
	// Undeclared workdir falls back to the pack root.
	def := Ref{Game: "g", Name: "s", Port: 1, Dir: pack}
	if def.cwd() != pack {
		t.Errorf("default cwd = %q, want the pack root", def.cwd())
	}
	if _, ok := env["SVC_DATA"]; !ok {
		t.Error("SVC_DATA must always be set, even without a declared data dir")
	}
	// The container workdir mirrors the dev one under /app.
	if got := composeWorkdir(r); got != "/app/svc" {
		t.Errorf("composeWorkdir = %q, want /app/svc", got)
	}
	if got := composeWorkdir(Ref{Dir: pack}); got != "/app" {
		t.Errorf("default composeWorkdir = %q, want /app", got)
	}
	// A workdir outside the pack must not become a container path escape.
	out := composeWorkdir(Ref{Dir: pack, WorkDir: "/elsewhere"})
	if out != "/app" {
		t.Errorf("escaping workdir = %q, want the /app fallback", out)
	}
}

// The gateway's own environment must never reach a managed service: that is
// the whole point of the whitelist (an inherited ADMIN_TOKEN would let a pack
// reconfigure the gateway, rotate its Jev key, and reach other games).
func TestBuildEnvIsWhitelisted(t *testing.T) {
	t.Setenv("ADMIN_TOKEN", "admin-secret")
	t.Setenv("TYPESAFE_API_KEY", "jev-secret")
	t.Setenv("LLM_API_KEY", "llm-secret")
	t.Setenv("SOME_UNRELATED", "noise")

	r := Ref{
		Game: "dungeon", Name: "pm", Port: 8902, Dir: "/packs/dungeon",
		EnvAllow: []string{"LLM_UPSTREAM_URL", "LLM_UPSTREAM_KEY", "ADMIN_TOKEN", "TYPESAFE_API_KEY", "bad name"},
		ExtraEnv: []string{
			"LLM_UPSTREAM_URL=https://up", "LLM_UPSTREAM_KEY=sk-pk",
			"LLM_UPSTREAM_MODEL=gpt-x",
		},
	}
	env := buildEnv(r)
	got := map[string]string{}
	for _, kv := range env {
		if k, v, ok := strings.Cut(kv, "="); ok {
			got[k] = v
		}
	}

	for _, secret := range []string{"admin-secret", "jev-secret", "llm-secret", "noise"} {
		for k, v := range got {
			if strings.Contains(v, secret) {
				t.Errorf("secret %q leaked into service env as %s", secret, k)
			}
		}
	}
	// Names the pack asked for are passed; the rest of the pool is not.
	if got["LLM_UPSTREAM_URL"] != "https://up" || got["LLM_UPSTREAM_KEY"] != "sk-pk" {
		t.Errorf("env_allow not honoured: %#v", got)
	}
	if _, ok := got["LLM_UPSTREAM_MODEL"]; ok {
		t.Error("a pool variable the pack did not request must not be passed")
	}
	if _, ok := got["ADMIN_TOKEN"]; ok {
		t.Error("operator credential present in service env")
	}
	// Fixed set.
	for k, want := range map[string]string{
		"SVC_PORT": "8902", "SVC_NAME": "pm", "GAME": "dungeon",
		"GAME_ROOT": "/packs/dungeon", "HOME": "/packs/dungeon",
		"SVC_SANDBOX": ProfileStrict, "PYTHONDONTWRITEBYTECODE": "1",
	} {
		if got[k] != want {
			t.Errorf("%s = %q, want %q", k, got[k], want)
		}
	}
}

func TestBuildEnvProfileOffInherits(t *testing.T) {
	t.Setenv("ADMIN_TOKEN", "admin-secret")
	r := Ref{Game: "g", Name: "s", Port: 1, Dir: "/d", Limits: Limits{Profile: ProfileOff}}
	found := false
	for _, kv := range buildEnv(r) {
		if kv == "ADMIN_TOKEN=admin-secret" {
			found = true
		}
	}
	if !found {
		t.Error(`profile "off" must inherit the gateway environment (that is its documented meaning)`)
	}
}

func TestCommandWrapsLimits(t *testing.T) {
	plain := Ref{Entry: "s.py"}
	if name, args := command(plain); name != "python3" || args[0] != "s.py" {
		t.Errorf("no limits should run python3 directly, got %s %v", name, args)
	}
	limited := Ref{Entry: "s.py", Limits: Limits{MemoryMB: 256, CPUSeconds: 30, MaxFileMB: 64}}
	name, args := command(limited)
	if _, err := exec.LookPath("prlimit"); err != nil {
		if name != "sh" {
			t.Fatalf("without prlimit, expected the sh fallback, got %s", name)
		}
		return
	}
	if name != "prlimit" {
		t.Fatalf("expected prlimit, got %s", name)
	}
	joined := strings.Join(args, " ")
	for _, want := range []string{"--as=268435456", "--cpu=30", "--fsize=67108864", "python3 s.py"} {
		if !strings.Contains(joined, want) {
			t.Errorf("prlimit args missing %q: %s", want, joined)
		}
	}
	// A pack that opts out of the sandbox must not be wrapped.
	off := Ref{Entry: "s.py", Limits: Limits{Profile: ProfileOff, MemoryMB: 256}}
	if name, _ := command(off); name != "python3" {
		t.Errorf(`profile "off" must not be wrapped, got %s`, name)
	}
}

func TestManifestEnvAllowGuardsOperatorCredentials(t *testing.T) {
	// Same rule, enforced at the manifest layer so a pack that asks for the
	// wrong thing fails loudly at load instead of silently losing the var.
	for _, name := range []string{"ADMIN_TOKEN", "TYPESAFE_API_KEY", "LLM_API_KEY", "OPENAI_API_KEY"} {
		if !IsOperatorEnv(name) {
			t.Errorf("%s must be an operator credential", name)
		}
	}
	for _, name := range []string{"LLM_UPSTREAM_KEY", "LLM_UPSTREAM_URL", "PM_TOKEN"} {
		if IsOperatorEnv(name) {
			t.Errorf("%s is a pack-level credential and must be grantable", name)
		}
	}
	for _, bad := range []string{"", "has space", "has=equals", "1LEADING_DIGIT", "a-b"} {
		if ValidEnvName(bad) {
			t.Errorf("%q must be rejected as a variable name", bad)
		}
	}
}

// End-to-end proof of the isolation: a service spawned by the supervisor must
// not be able to see the gateway's operator credentials, even though the
// gateway process has them in its own environment.
func TestSpawnedServiceCannotReadOperatorCredentials(t *testing.T) {
	if _, err := exec.LookPath("python3"); err != nil {
		t.Skip("python3 not available")
	}
	t.Setenv("ADMIN_TOKEN", "admin-secret")
	t.Setenv("TYPESAFE_API_KEY", "jev-secret")

	dir := t.TempDir()
	script := "import os, json\n" +
		"from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer\n" +
		"class H(BaseHTTPRequestHandler):\n" +
		"    def do_POST(self):\n" +
		"        n = int(self.headers.get('Content-Length', 0)); self.rfile.read(n)\n" +
		"        b = json.dumps(dict(os.environ)).encode()\n" +
		"        self.send_response(200); self.send_header('Content-Type', 'application/json')\n" +
		"        self.send_header('Content-Length', str(len(b))); self.end_headers(); self.wfile.write(b)\n" +
		"    def log_message(self, *a): pass\n" +
		"ThreadingHTTPServer(('127.0.0.1', int(os.environ['SVC_PORT'])), H).serve_forever()\n"
	if err := os.WriteFile(filepath.Join(dir, "echo_env.py"), []byte(script), 0o644); err != nil {
		t.Fatal(err)
	}
	sup := New(func(string, ...any) {})
	sup.StartAll([]Ref{{
		Game: "g", Name: "probe", Runtime: "python", Entry: "echo_env.py",
		Port: freePort(t), Dir: dir,
		EnvAllow: []string{"LLM_UPSTREAM_KEY"},
		ExtraEnv: []string{"LLM_UPSTREAM_KEY=sk-pk"},
		Limits:   Limits{MemoryMB: 256},
	}})
	defer sup.StopAll()
	waitUp(t, sup, "g", "probe")

	out, err := sup.Call("g", "probe", "/env", nil)
	if err != nil {
		t.Fatal(err)
	}
	env, ok := out.(map[string]any)
	if !ok {
		t.Fatalf("unexpected response: %#v", out)
	}
	if _, leaked := env["ADMIN_TOKEN"]; leaked {
		t.Error("spawned service can read ADMIN_TOKEN")
	}
	if _, leaked := env["TYPESAFE_API_KEY"]; leaked {
		t.Error("spawned service can read the Jev key")
	}
	if env["LLM_UPSTREAM_KEY"] != "sk-pk" {
		t.Errorf("env_allow variable missing from the service env: %#v", env)
	}
	if env["SVC_NAME"] != "probe" || env["SVC_PORT"] == "" {
		t.Errorf("fixed service env missing: %#v", env)
	}
}

func TestJSONDecode(t *testing.T) {
	var m map[string]any
	if err := json.Unmarshal([]byte(`{"a":1}`), &m); err != nil || m["a"].(float64) != 1 {
		t.Fatal("json sanity")
	}
}

func waitUp(t *testing.T, sup *Supervisor, game, name string) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if sup.Up(game, name) {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("service %s/%s never came up", game, name)
}

func freePort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}
