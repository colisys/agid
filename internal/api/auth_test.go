package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"gateway/internal/game"
	"gateway/internal/services"
)

// A player must be able to play without holding an operator credential, and
// the operator credential must remain the only way to do operator things.

func tierSetup(t *testing.T) (*Server, *game.Manager) {
	srv, mgr := bridgeSetup(t, bridgeManifest)
	return srv, mgr
}

func newLiveMatch(t *testing.T, mgr *game.Manager) (*game.Match, string) {
	t.Helper()
	mk, err := mgr.Create(context.Background(), game.CreateOptions{
		Game: "svcgame", Players: []game.PlayerSpec{{Human: true}}, MaxTicks: 50, TickMs: 20,
	})
	if err != nil {
		t.Fatal(err)
	}
	tok, ok := mgr.PlayerToken(mk.ID)
	if !ok || tok == "" {
		t.Fatal("no player token minted at creation")
	}
	return mk, tok
}

func do(t *testing.T, srv *Server, method, path, token string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(`{}`))
	if token != "" {
		req.Header.Set("X-Admin-Token", token)
	}
	w := httptest.NewRecorder()
	srv.Handler().ServeHTTP(w, req)
	return w
}

func TestPlayerTokenReachesTheGameButNotTheServer(t *testing.T) {
	srv, mgr := tierSetup(t)
	mk, ptok := newLiveMatch(t, mgr)
	base := "/v1/games/" + mk.ID

	// The whole live loop works on the player token alone. (SSE is exercised
	// asynchronously in TestStopBroadcastsOver — a push-only stream does not
	// return until the match ends, so it cannot be driven synchronously.)
	for _, c := range []struct{ method, path string }{
		{http.MethodGet, base},
		{http.MethodPost, base + "/commands"},
	} {
		if w := do(t, srv, c.method, c.path, ptok); w.Code == 401 {
			t.Errorf("%s %s: player token rejected: %s", c.method, c.path, w.Body.String())
		}
	}
	// Operator-only actions stay operator-only.
	if w := do(t, srv, http.MethodPost, base+"/stop", ptok); w.Code != 403 {
		t.Errorf("player stopping a match: got %d, want 403", w.Code)
	}
	if w := do(t, srv, http.MethodGet, base+"/replay", ptok); w.Code != 403 {
		t.Errorf("player reading a replay: got %d, want 403", w.Code)
	}
	// Enumerating the server is an operator act.
	if w := do(t, srv, http.MethodGet, "/v1/games", ptok); w.Code == 200 {
		t.Error("player token must not list every match")
	}
	// No token at all: nothing.
	if w := do(t, srv, http.MethodGet, base, ""); w.Code != 401 {
		t.Errorf("no token: got %d, want 401", w.Code)
	}
}

func TestPlayerTokenIsScopedToItsOwnMatch(t *testing.T) {
	srv, mgr := tierSetup(t)
	mkA, tokA := newLiveMatch(t, mgr)
	mkB, _ := newLiveMatch(t, mgr)
	if tokA == "" || mkA.ID == mkB.ID {
		t.Fatal("bad fixtures")
	}
	// A's token must not open B.
	if w := do(t, srv, http.MethodGet, "/v1/games/"+mkB.ID, tokA); w.Code != 401 {
		t.Errorf("a match token must not open another match, got %d", w.Code)
	}
	// ...nor a made-up id.
	if w := do(t, srv, http.MethodGet, "/v1/games/m_fake", tokA); w.Code != 401 {
		t.Errorf("unknown match with a valid token: got %d, want 401", w.Code)
	}
}

// Stopping a match must tell the watchers, so an SSE client can finish and
// render a result instead of just seeing its connection drop. The stream here
// authenticates with the PLAYER token in the query string, which is the only
// way EventSource can carry a credential — so it also covers the SSE tier of
// the player token.
func TestStopBroadcastsOver(t *testing.T) {
	srv, mgr := tierSetup(t)
	mk, ptok := newLiveMatch(t, mgr)

	req := httptest.NewRequest(http.MethodGet, "/v1/games/"+mk.ID+"/events?token="+ptok, nil)
	w := httptest.NewRecorder()
	done := make(chan struct{})
	go func() { srv.Handler().ServeHTTP(w, req); close(done) }()
	time.Sleep(80 * time.Millisecond)

	if r := do(t, srv, http.MethodPost, "/v1/games/"+mk.ID+"/stop", "adm-test-token"); r.Code != 200 {
		t.Fatalf("stop: %d %s", r.Code, r.Body.String())
	}
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("SSE stream did not finish after stop")
	}
	body := w.Body.String()
	if !strings.Contains(body, "event: over") {
		t.Errorf("a stopped match must emit a terminal over event:\n%s", body)
	}
	if !strings.Contains(body, `"reason":"stopped by operator"`) {
		t.Errorf("over event should carry the stop reason:\n%s", body)
	}
}

// /svc is fail-closed now: only routes a pack declares public are reachable
// without the operator token, and the declaration is per method.
func TestSvcProxyIsFailClosed(t *testing.T) {
	cases := []struct {
		routes []string
		method string
		path   string
		public bool
	}{
		{nil, http.MethodGet, "/top", false},                    // nothing declared
		{[]string{"GET /top"}, http.MethodGet, "/top", true},    // exact
		{[]string{"GET /top"}, http.MethodPost, "/top", false},  // wrong method
		{[]string{"GET /top"}, http.MethodGet, "/top/1", false}, // not a prefix match
		{[]string{"GET /save/*"}, http.MethodGet, "/save/abc", true},
		{[]string{"GET /save/*"}, http.MethodDelete, "/save/abc", false},
		{[]string{"GET /save/*"}, http.MethodPost, "/save", false},
		{[]string{"POST /save"}, http.MethodPost, "/save", true},
		{[]string{"get /top"}, http.MethodGet, "/top", true}, // case-insensitive method
	}
	for _, c := range cases {
		r := services.Ref{PublicRoutes: c.routes}
		if got := r.IsPublicRoute(c.method, c.path); got != c.public {
			t.Errorf("IsPublicRoute(%s, %s) with %v = %v, want %v",
				c.method, c.path, c.routes, got, c.public)
		}
	}
}
