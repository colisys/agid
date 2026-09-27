package api

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"

	"gateway/internal/game"
)

// Service-facing endpoints for the match bridge.
//
// These are NOT admin endpoints and are not guarded by AdminGuard: a backend
// service authenticates with a token minted for one match, which is the whole
// point of the bridge — a pack's Python can drive its own game without ever
// holding operator credentials. The token is per match AND per service, so it
// grants nothing on any other match, game, or service.
//
//	POST /v1/internal/matches/<id>/ops      {"commands": {"<channel>": …}}
//	POST /v1/internal/matches/<id>/notify   {"notice": {…}}
//
// Authorization: X-Match-Token: <token from the observe payload>

// RegisterBridge mounts the service bridge under /v1/internal. Kept separate
// from the game routes so the surface a backend can reach is easy to audit:
// two paths, both token-gated, neither touching admin.
func (g *Games) RegisterBridge(mux *http.ServeMux) {
	mux.HandleFunc("/v1/internal/matches/", g.bridgeDispatch)
}

func (g *Games) bridgeDispatch(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/v1/internal/matches/")
	id, action, _ := strings.Cut(rest, "/")
	if id == "" || (action != "ops" && action != "notify") {
		writeJSON(w, 404, map[string]any{"error": "not found"})
		return
	}
	if r.Method != http.MethodPost {
		writeJSON(w, 405, map[string]any{"error": "method not allowed"})
		return
	}
	token := r.Header.Get(game.TokenHeader)
	if token == "" {
		// 401 not 403: without a token we have not identified a service at
		// all, and saying "forbidden" would imply the token was checked.
		writeJSON(w, 401, map[string]any{"error": game.TokenHeader + " required"})
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		writeJSON(w, 400, map[string]any{"error": err.Error()})
		return
	}
	if action == "ops" {
		var b struct {
			Commands map[string]any `json:"commands"`
		}
		if err := json.Unmarshal(body, &b); err != nil {
			writeJSON(w, 400, map[string]any{"error": "bad json"})
			return
		}
		if err := g.mgr.PostServiceCommands(id, token, b.Commands); err != nil {
			writeJSON(w, bridgeStatus(err), map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true})
		return
	}
	var b struct {
		Notice map[string]any `json:"notice"`
	}
	if err := json.Unmarshal(body, &b); err != nil {
		writeJSON(w, 400, map[string]any{"error": "bad json"})
		return
	}
	if err := g.mgr.NotifyService(id, token, b.Notice); err != nil {
		writeJSON(w, bridgeStatus(err), map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

// bridgeStatus maps a bridge rejection to an HTTP code. An unknown token is
// 401; a channel the service may not use is 403 — the distinction matters to
// the service author, who otherwise cannot tell "my token expired" from "my
// manifest is wrong".
func bridgeStatus(err error) int {
	msg := err.Error()
	switch {
	case strings.HasPrefix(msg, "match not found"):
		return 404
	case strings.Contains(msg, "unknown service token"):
		return 401
	case strings.Contains(msg, "match over"):
		return 409
	default:
		return 403
	}
}
