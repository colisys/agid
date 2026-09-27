package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"gateway/internal/services"
)

// A pack's backend creates the match on a player's behalf, so the browser
// never needs the operator token. The service credential must be narrow
// enough that this stays safe.

func TestServiceTokenCreatesOnlyItsOwnGame(t *testing.T) {
	refs := []services.Ref{{
		Game: "svcgame", Name: "pm", Runtime: "python", Entry: "pm.py", Port: 8977,
		GatewayAccess: services.GatewayAccess{CreateMatches: true, StopMatches: true},
	}, {
		// A second pack that asked for nothing: it must get no token at all.
		Game: "other", Name: "quiet", Runtime: "python", Entry: "q.py", Port: 8978,
	}}
	tk := NewServiceTokens(refs)
	tok := tk.TokenFor("svcgame", "pm")
	if tok == "" {
		t.Fatal("no token minted for a service that declared gateway_access")
	}
	if got := tk.TokenFor("other", "quiet"); got != "" {
		t.Errorf("a service that declared nothing must get no token, got %q", got)
	}
	if !tk.CanCreateMatch("svcgame", tok) {
		t.Error("the declared operation must be permitted")
	}
	// Scoping: a token only works within its own pack.
	if tk.CanCreateMatch("other", tok) {
		t.Error("a service token must not create another pack's game")
	}
	if tk.CanCreateMatch("svcgame", "st_wrong") {
		t.Error("a bogus token must be rejected")
	}
	if tk.CanCreateMatch("svcgame", "") {
		t.Error("an empty token must be rejected")
	}
}

func TestServiceCannotCreateGamesItWasNotGranted(t *testing.T) {
	// Declared stop-only: creating must not be implied by it.
	tk := NewServiceTokens([]services.Ref{{
		Game: "svcgame", Name: "pm", GatewayAccess: services.GatewayAccess{StopMatches: true},
	}})
	tok := tk.TokenFor("svcgame", "pm")
	if tk.CanCreateMatch("svcgame", tok) {
		t.Error("stop_matches must not imply create_matches")
	}
	if !tk.CanStopMatch("svcgame", tok) {
		t.Error("the declared stop operation must work")
	}
}

// End to end: the service token creates a match, and the caller gets back a
// player token it can play with — no operator credential anywhere.
func TestServiceCreatesMatchAndPlayerUsesIt(t *testing.T) {
	refs := []services.Ref{{
		Game: "svcgame", Name: "pm", Runtime: "python", Entry: "pm.py", Port: 8977,
		GatewayAccess: services.GatewayAccess{CreateMatches: true, StopMatches: true},
	}}
	srv, mgr := bridgeSetup(t, bridgeManifest)
	srv.games.WithServiceTokens(NewServiceTokens(refs))
	tok := srv.games.svcTk.TokenFor("svcgame", "pm")
	if tok == "" {
		t.Fatal("service token not registered on the server")
	}

	// A live match, not headless: headless returns a report and there is no
	// player to hand a token to.
	body := `{"game":"svcgame","players":[{"human":true}],"max_ticks":5,"tick_ms":600}`
	req := httptest.NewRequest(http.MethodPost, "/v1/games", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(ServiceTokenHeader, tok)
	w := httptest.NewRecorder()
	srv.Handler().ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("service could not create its own match: %d %s", w.Code, w.Body.String())
	}
	var out struct {
		MatchID     string `json:"match_id"`
		PlayerToken string `json:"player_token"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if out.MatchID == "" || out.PlayerToken == "" {
		t.Fatalf("create must return both ids: %s", w.Body.String())
	}
	// The player token from a service-created match is a real credential.
	if _, ok := mgr.PlayerToken(out.MatchID); !ok {
		t.Error("player token not registered for the service-created match")
	}

	// It may also stop its own match, using the same scoped token.
	sreq := httptest.NewRequest(http.MethodPost, "/v1/games/"+out.MatchID+"/stop", strings.NewReader("{}"))
	sreq.Header.Set(ServiceTokenHeader, tok)
	sw := httptest.NewRecorder()
	srv.Handler().ServeHTTP(sw, sreq)
	if sw.Code != 200 {
		t.Errorf("service could not stop its own match: %d %s", sw.Code, sw.Body.String())
	}

	// The same service token must NOT be able to list every match.
	lreq := httptest.NewRequest(http.MethodGet, "/v1/games", nil)
	lreq.Header.Set(ServiceTokenHeader, tok)
	lw := httptest.NewRecorder()
	srv.Handler().ServeHTTP(lw, lreq)
	if lw.Code == 200 {
		t.Error("a service token must not enumerate the server")
	}
}

// A service token must not be accepted where the operator token is expected,
// and must not be usable on another pack's match.
func TestServiceTokenIsNotAnOperatorToken(t *testing.T) {
	srv, mgr := bridgeSetup(t, bridgeManifest)
	srv.games.WithServiceTokens(NewServiceTokens([]services.Ref{{
		Game: "svcgame", Name: "pm", GatewayAccess: services.GatewayAccess{CreateMatches: true},
	}}))
	tok := srv.games.svcTk.TokenFor("svcgame", "pm")

	// Creating another pack's game with this token must fall through to the
	// operator guard, which rejects it.
	body := `{"game":"someothergame","players":[{"human":true}]}`
	req := httptest.NewRequest(http.MethodPost, "/v1/games", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(ServiceTokenHeader, tok)
	w := httptest.NewRecorder()
	srv.Handler().ServeHTTP(w, req)
	if w.Code != 401 {
		t.Errorf("service token created another pack's game: status %d", w.Code)
	}
	_ = mgr
}
