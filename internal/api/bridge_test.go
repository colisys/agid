package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"gateway/internal/admin"
	"gateway/internal/config"
	"gateway/internal/decision"
	"gateway/internal/game"
	"gateway/internal/jsflow"
	"gateway/internal/llm"
	"gateway/internal/observability"
	"gateway/internal/orchestrator"
	"gateway/internal/tools"
)

// The bridge endpoints are the only surface a pack backend can reach, and
// they must be reachable WITHOUT an operator credential — while refusing
// anything that is not that match's token.

// bridgeSetup builds a pack whose manifest declares match_access, so the
// binding is exercised through the real path (manifest → Create → token)
// rather than by poking at internals.
func bridgeSetup(t *testing.T, manifest string) (*Server, *game.Manager) {
	t.Helper()
	dir := t.TempDir()
	gdir := filepath.Join(dir, "svcgame")
	if err := os.MkdirAll(gdir, 0o755); err != nil {
		t.Fatal(err)
	}
	rules := `
function newmatch(args) { return { state: { n: 0, svc: null } }; }
function tick(args) {
  var svc = (args.commands && args.commands["__svc__"]) || null;
  return { state: { n: args.state.n + 1, svc: svc }, events: [] };
}
function snapshot(args) { return JSON.parse(JSON.stringify(args.state)); }
function over(args) { return { over: null }; }
`
	if err := os.WriteFile(filepath.Join(gdir, "rules.js"), []byte(rules), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(gdir, "manifest.json"), []byte(manifest), 0o644); err != nil {
		t.Fatal(err)
	}
	cfg := config.Config{}
	jev := decision.NewClient("https://x", "k", 5*time.Second, decision.DefaultRetryPolicy())
	llms := llm.NewRegistry("openai")
	pool := jsflow.NewPool(1)
	t.Cleanup(pool.Close)
	decide := func(ctx context.Context, req decision.SystemOneRequest) (decision.SystemOneResult, error) {
		return decision.SystemOneResult{}, nil
	}
	engine := orchestrator.NewEngine(pool, "", decide, "jev", decision.DefaultThresholds(), llms, tools.NewRegistry())
	store := admin.NewStore(cfg, "x", "adm-test-token", jev, engine, llms)
	gs := game.NewDiskStore([]string{dir}, 5)
	store.SetGameStore(gs)
	mgr := game.NewManager(gs, pool, func(matchID, _, player string) jsflow.Host {
		return jsflow.Host{Log: func(string) {}}
	}, nil, 10, 2000)
	srv := NewServerWithAdmin(cfg, store, store, engine, llms, observability.NewMetrics(), decide, "jev")
	srv.WithGames(NewGames(mgr, srv.AdminGuard).WithTokenCheck(srv.CheckAdminToken))
	return srv, mgr
}

const bridgeManifest = `{
  "name": "svcgame",
  "capabilities": {},
  "services": {
    "pm": {
      "runtime": "python", "entry": "pm.py", "port": 8977,
      "match_access": {"observe": "digest", "commands": ["gm"], "notify": true}
    },
    "quiet": {
      "runtime": "python", "entry": "quiet.py", "port": 8978
    }
  }
}`

func postBridge(t *testing.T, srv *Server, path, token, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set(game.TokenHeader, token)
	}
	w := httptest.NewRecorder()
	srv.Handler().ServeHTTP(w, req)
	return w
}

func TestBridgeEndpointsRequireTheMatchToken(t *testing.T) {
	srv, mgr := bridgeSetup(t, bridgeManifest)
	mk, err := mgr.Create(context.Background(), game.CreateOptions{
		Game: "svcgame", Players: []game.PlayerSpec{{Human: true}}, MaxTicks: 50,
	})
	if err != nil {
		t.Fatal(err)
	}
	base := "/v1/internal/matches/" + mk.ID

	cases := []struct {
		name, path, token, body string
		want                    int
	}{
		{"no token, ops", base + "/ops", "", `{"commands":{"gm":{}}}`, 401},
		{"bogus token, ops", base + "/ops", "mt_nope", `{"commands":{"gm":{}}}`, 401},
		{"no token, notify", base + "/notify", "", `{"notice":{"a":1}}`, 401},
		{"unknown match", "/v1/internal/matches/m_nope/ops", "mt_x", `{"commands":{}}`, 404},
		{"unknown action", base + "/wipe", "mt_x", `{}`, 404},
		{"bad json", base + "/ops", "mt_x", `{`, 400},
	}
	for _, c := range cases {
		if got := postBridge(t, srv, c.path, c.token, c.body).Code; got != c.want {
			t.Errorf("%s: status = %d, want %d", c.name, got, c.want)
		}
	}
	// The admin token is not a match token: a service-facing endpoint must
	// never accept the operator credential, or the separation is moot.
	if got := postBridge(t, srv, base+"/ops", "adm-test-token", `{"commands":{"gm":{}}}`).Code; got != 401 {
		t.Errorf("admin token must not authorise the bridge, got %d", got)
	}
	// A service that declared no match_access is bound to nothing.
	if got := postBridge(t, srv, base+"/ops", "mt_"+strings.Repeat("a", 32), `{"commands":{}}`).Code; got != 401 {
		t.Errorf("unbound service token must be rejected, got %d", got)
	}
	if toks := mgr.ServiceTokens(mk.ID); len(toks) != 1 || toks["pm"] == "" {
		t.Fatalf("exactly the declaring service binds, got %v", toks)
	}
}

func TestBridgeOpsReachTheRulesAndNotifyStaysOutOfBand(t *testing.T) {
	srv, mgr := bridgeSetup(t, bridgeManifest)
	mk, err := mgr.Create(context.Background(), game.CreateOptions{
		Game: "svcgame", Players: []game.PlayerSpec{{Human: true}}, MaxTicks: 50,
	})
	if err != nil {
		t.Fatal(err)
	}
	tok := mgr.ServiceTokens(mk.ID)["pm"]
	base := "/v1/internal/matches/" + mk.ID

	if w := postBridge(t, srv, base+"/ops", tok, `{"commands":{"gm":{"ops":[{"op":"grant_gold"}]}}}`); w.Code != 200 {
		t.Fatalf("declared channel rejected: %d %s", w.Code, w.Body.String())
	}
	// An undeclared channel is 403: the service author can tell "my manifest
	// is wrong" from "my token is wrong".
	if w := postBridge(t, srv, base+"/ops", tok, `{"commands":{"action":"attack"}}`); w.Code != 403 {
		t.Fatalf("undeclared channel status = %d, want 403", w.Code)
	}
	if w := postBridge(t, srv, base+"/notify", tok, `{"notice":{"text":"hi"}}`); w.Code != 200 {
		t.Fatalf("notify rejected: %d %s", w.Code, w.Body.String())
	}

	if _, err := mgr.Step(context.Background(), mk.ID); err != nil {
		t.Fatal(err)
	}
	snap, err := mgr.SnapshotNow(context.Background(), mk.ID, "p0")
	if err != nil {
		t.Fatal(err)
	}
	svc, _ := snap["svc"].(map[string]any)
	if svc == nil || svc["gm"] == nil {
		t.Fatalf("service command did not reach the rules: %#v", snap)
	}
	if _, leaked := snap["notice"]; leaked {
		t.Error("a notice must never enter the match state")
	}
}

func TestBridgeNoticeReachesSSEAsItsOwnEvent(t *testing.T) {
	srv, mgr := bridgeSetup(t, bridgeManifest)
	mk, err := mgr.Create(context.Background(), game.CreateOptions{
		Game: "svcgame", Players: []game.PlayerSpec{{Human: true}}, MaxTicks: 50,
	})
	if err != nil {
		t.Fatal(err)
	}
	tok := mgr.ServiceTokens(mk.ID)["pm"]

	req := httptest.NewRequest(http.MethodGet, "/v1/games/"+mk.ID+"/events", nil)
	req.Header.Set("X-Admin-Token", "adm-test-token")
	w := httptest.NewRecorder()
	done := make(chan struct{})
	go func() {
		srv.Handler().ServeHTTP(w, req)
		close(done)
	}()

	// Give the subscriber time to attach before pushing the notice.
	time.Sleep(80 * time.Millisecond)
	if r := postBridge(t, srv, "/v1/internal/matches/"+mk.ID+"/notify", tok,
		`{"notice":{"text":"守主在第 5 层"}}`); r.Code != 200 {
		t.Fatalf("notify failed: %d", r.Code)
	}
	// One more step so the stream is guaranteed to be live and to have a
	// chance to close.
	if _, err := mgr.Step(context.Background(), mk.ID); err != nil {
		t.Fatal(err)
	}
	time.Sleep(120 * time.Millisecond)
	if _, err := mgr.Stop(mk.ID, "test over"); err != nil {
		t.Fatal(err)
	}
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("SSE stream did not finish")
	}
	body := w.Body.String()
	if !strings.Contains(body, "event: notice") {
		t.Errorf("no notice event on the stream:\n%s", body)
	}
	if !strings.Contains(body, "守主在第 5 层") {
		t.Errorf("notice payload missing:\n%s", body)
	}
	// NB: a manually stopped match closes the stream without an "over"
	// event — Manager.Stop unloads and closes subscribers rather than
	// broadcasting. Pre-existing, and out of scope for the bridge, but worth
	// fixing: a client watching an operator-stopped match just sees the
	// connection drop.
	_ = body
}
