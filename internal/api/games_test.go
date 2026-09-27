package api

import (
	"context"
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

func gamesTestSetup(t *testing.T) (*Server, string) {
	t.Helper()
	dir := t.TempDir()
	gdir := filepath.Join(dir, "counter")
	if err := os.MkdirAll(filepath.Join(gdir, "brains"), 0o755); err != nil {
		t.Fatal(err)
	}
	rules := `
function newmatch(args) { return { state: { n: 0 } }; }
function tick(args) {
  var n = args.state.n + 1;
  return { state: { n: n }, events: [{type:"t", n: n}] };
}
function snapshot(args) { return { n: args.state.n }; }
function over(args) {
  if (args.state.n >= 3) return { over: true, result: { winner: "p0", reason: "done" } };
  return { over: null };
}
`
	brain := `
function decide(args) { return { commands: { go: 1 }, memory: {} }; }
`
	if err := os.WriteFile(filepath.Join(gdir, "rules.js"), []byte(rules), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(gdir, "brains", "b.js"), []byte(brain), 0o644); err != nil {
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
	srv.WithGames(NewGames(mgr, srv.AdminGuard))
	return srv, "adm-test-token"
}

func gamesReq(t *testing.T, srv *Server, token, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	var rdr *strings.Reader
	if body == "" {
		rdr = strings.NewReader("")
	} else {
		rdr = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, path, rdr)
	if token != "" {
		req.Header.Set("X-Admin-Token", token)
	}
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	return rec
}

func TestGamesRequiresAdminToken(t *testing.T) {
	srv, tok := gamesTestSetup(t)
	// No token -> 401 (guard rejects before routing).
	rec := gamesReq(t, srv, "", "GET", "/v1/games", "")
	if rec.Code != 401 {
		t.Fatalf("want 401 without token, got %d", rec.Code)
	}
	// Tenant-style wrong token -> 401.
	rec = gamesReq(t, srv, "gw_tenant_key", "GET", "/v1/games", "")
	if rec.Code != 401 {
		t.Fatalf("want 401 for tenant key, got %d", rec.Code)
	}
	// Admin token works.
	rec = gamesReq(t, srv, tok, "GET", "/v1/games", "")
	if rec.Code != 200 {
		t.Fatalf("want 200 with admin token, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestGamesHeadlessLifecycle(t *testing.T) {
	srv, tok := gamesTestSetup(t)
	rec := gamesReq(t, srv, tok, "POST", "/v1/games",
		`{"game":"counter","players":[{"brain":{"brain":"b"}}],"headless":true}`)
	if rec.Code != 200 {
		t.Fatalf("want 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"winner":"p0"`) {
		t.Fatalf("want p0 win in report, got %s", rec.Body.String())
	}
	// Session unloaded: list empty.
	rec = gamesReq(t, srv, tok, "GET", "/v1/games", "")
	if !strings.Contains(rec.Body.String(), `"matches":[]`) {
		t.Fatalf("want empty live list, got %s", rec.Body.String())
	}
}

func TestGamesStopUnloads(t *testing.T) {
	srv, tok := gamesTestSetup(t)
	rec := gamesReq(t, srv, tok, "POST", "/v1/games",
		`{"game":"counter","players":[{"brain":{"brain":"b"}}],"tick_ms":50}`)
	if rec.Code != 200 {
		t.Fatalf("want 200, got %d: %s", rec.Code, rec.Body.String())
	}
	id := strings.Split(strings.Split(rec.Body.String(), `"match_id":"`)[1], `"`)[0]
	rec = gamesReq(t, srv, tok, "POST", "/v1/games/"+id+"/stop", "")
	if rec.Code != 200 {
		t.Fatalf("want 200, got %d: %s", rec.Code, rec.Body.String())
	}
	rec = gamesReq(t, srv, tok, "GET", "/v1/games/"+id, "")
	if rec.Code != 404 {
		t.Fatalf("want 404 after unload, got %d", rec.Code)
	}
	rec = gamesReq(t, srv, tok, "GET", "/v1/games/"+id+"/replay", "")
	if rec.Code != 200 {
		t.Fatalf("want replay retained, got %d", rec.Code)
	}
}
