package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"strings"
	"time"

	"gateway/internal/game"
)

// Games wires the authoritative game server routes.
//
// Two tiers of credential reach it:
//   - the operator token (AdminGuard) for everything;
//   - a match's player token, returned at creation, for that one match's board,
//     event stream and commands — so a browser playing the game never holds
//     an operator credential.
type Games struct {
	mgr     *game.Manager
	guard   func(http.HandlerFunc) http.HandlerFunc
	checkTk func(string) bool
	svcTk   *ServiceTokens
}

func NewGames(mgr *game.Manager, guard func(http.HandlerFunc) http.HandlerFunc) *Games {
	return &Games{mgr: mgr, guard: guard}
}

// WithTokenCheck enables the player-token tier. Without it every route falls
// back to operator-only, which is the safe direction.
func (g *Games) WithTokenCheck(fn func(string) bool) *Games {
	g.checkTk = fn
	return g
}

// WithServiceTokens enables the service tier: a pack's backend may create and
// stop its own matches with its scoped token, so a player browser never needs
// the operator credential to start a game.
func (g *Games) WithServiceTokens(t *ServiceTokens) *Games {
	g.svcTk = t
	return g
}

func (g *Games) Register(mux *http.ServeMux) {
	// Creating and listing are operator actions — except that a pack's own
	// service may create a match of ITS game on a player's behalf.
	mux.HandleFunc("/v1/games", g.createGuard(g.dispatch))
	mux.HandleFunc("/v1/games/", g.playerGuard(g.dispatchOne))
	// The service bridge is deliberately outside both guards: it is how a
	// pack backend reaches its own match, authenticated by a per-match token
	// rather than by an operator credential.
	g.RegisterBridge(mux)
}

// createGuard admits the operator, or a pack service whose manifest declared
// create_matches. The service is then checked against the game the REQUEST
// asked for, so a dungeon service cannot create an rts match.
func (g *Games) createGuard(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if g.svcTk != nil && r.Method == http.MethodPost {
			tok := tokenFromRequest(r, ServiceTokenHeader)
			if tok != "" {
				if want, err := g.requestedGame(r); err == nil && g.svcTk.CanCreateMatch(want, tok) {
					p := principal{admin: true, service: want, viaService: true}
					next(w, r.WithContext(context.WithValue(r.Context(), principalKey, p)))
					return
				}
			}
		}
		g.guard(next)(w, r)
	}
}

// requestedGame peeks at the create body to learn which game is being asked
// for. The body is re-readable by the handler because it is buffered here.
func (g *Games) requestedGame(r *http.Request) (string, error) {
	body, err := readAndRestore(r)
	if err != nil {
		return "", err
	}
	var b struct {
		Game string `json:"game"`
	}
	if err := json.Unmarshal(body, &b); err != nil {
		return "", err
	}
	return b.Game, nil
}

// playerGuard resolves who is calling: the operator (full access) or the
// player holding one match's token (that match only). The verdict rides in the
// context so the per-action handlers can demand the operator tier where it
// matters — stopping or replaying a match is not a player's business.
func (g *Games) playerGuard(next http.HandlerFunc) http.HandlerFunc {
	if g.checkTk == nil && g.svcTk == nil {
		// No second tier configured: fall back to operator-only, and mark the
		// caller as an operator so the per-action checks still work. Failing
		// toward the stricter policy is the point.
		return g.guard(func(w http.ResponseWriter, r *http.Request) {
			ctx := context.WithValue(r.Context(), principalKey, principal{admin: true})
			next(w, r.WithContext(ctx))
		})
	}
	return func(w http.ResponseWriter, r *http.Request) {
		rest := strings.TrimPrefix(r.URL.Path, "/v1/games/")
		id, _, _ := strings.Cut(rest, "/")
		tok := r.Header.Get("X-Admin-Token")
		if tok == "" {
			tok = strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		}
		if tok == "" {
			tok = r.URL.Query().Get("token") // the SSE stream carries it here
		}
		if tok != "" && g.checkTk != nil && g.checkTk(tok) {
			ctx := context.WithValue(r.Context(), principalKey, principal{admin: true})
			next(w, r.WithContext(ctx))
			return
		}
		// Player tier: only for a live match this token actually owns.
		if id != "" && tok != "" {
			if mt, ok := g.mgr.Get(id); ok && mt.PlayerAuthorized(tok) {
				ctx := context.WithValue(r.Context(), principalKey, principal{matchID: id})
				next(w, r.WithContext(ctx))
				return
			}
		}
		// Service tier: a pack backend stopping a match of its OWN game. The
		// game comes from the live match, never from the request, so a token
		// cannot be pointed at a match it does not own.
		if g.svcTk != nil {
			stok := tokenFromRequest(r, ServiceTokenHeader)
			if id != "" && stok != "" {
				if owner := g.serviceOwnerOf(id); owner != "" && g.svcTk.CanStopMatch(owner, stok) {
					p := principal{admin: true, service: owner, viaService: true}
					next(w, r.WithContext(context.WithValue(r.Context(), principalKey, p)))
					return
				}
			}
		}
		writeJSON(w, 401, map[string]any{"error": "unauthorized"})
	}
}

// readAndRestore consumes the request body and puts it back, so a guard can
// inspect it without starving the handler.
func readAndRestore(r *http.Request) ([]byte, error) {
	if r.Body == nil {
		return nil, nil
	}
	b, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	r.Body = io.NopCloser(bytes.NewReader(b))
	return b, nil
}

type ctxKey int

const principalKey ctxKey = 1

// principal records who is calling: an operator, the player of one match, or
// a pack backend acting within its own game.
type principal struct {
	admin      bool
	matchID    string
	service    string
	viaService bool
}

func isOperator(r *http.Request) bool {
	p, _ := r.Context().Value(principalKey).(principal)
	return p.admin
}

func (g *Games) dispatch(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodPost:
		g.create(w, r)
	case http.MethodGet:
		g.list(w, r)
	default:
		writeJSON(w, 405, map[string]any{"error": "method not allowed"})
	}
}

func (g *Games) dispatchOne(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/v1/games/")
	id, tail, _ := strings.Cut(rest, "/")
	if id == "" {
		writeJSON(w, 404, map[string]any{"error": "not found"})
		return
	}
	switch {
	case tail == "" && r.Method == http.MethodGet:
		g.show(w, r, id)
	case tail == "events" && r.Method == http.MethodGet:
		g.events(w, r, id)
	case tail == "commands" && r.Method == http.MethodPost:
		g.commands(w, r, id)
	case tail == "stop" && r.Method == http.MethodPost:
		// Stopping a match ends someone's game; that stays an operator act.
		if !isOperator(r) {
			writeJSON(w, 403, map[string]any{"error": "stopping a match requires the operator token"})
			return
		}
		g.stop(w, r, id)
	case tail == "replay" && r.Method == http.MethodGet:
		if !isOperator(r) {
			writeJSON(w, 403, map[string]any{"error": "replay requires the operator token"})
			return
		}
		g.replay(w, r, id)
	default:
		writeJSON(w, 404, map[string]any{"error": "not found"})
	}
}

func decodeBody(r *http.Request, v any) error {
	return json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(v)
}

func (g *Games) create(w http.ResponseWriter, r *http.Request) {
	var opts game.CreateOptions
	if err := decodeBody(r, &opts); err != nil {
		writeJSON(w, 400, map[string]any{"error": err.Error()})
		return
	}
	mt, err := g.mgr.Create(r.Context(), opts)
	if err != nil {
		writeJSON(w, 400, map[string]any{"error": err.Error()})
		return
	}
	if opts.Headless {
		// Detached from the request context: long headless matches (e.g. RTS
		// brains calling Jev every tick) must not die when the HTTP client
		// times out. MaxTicks/replay caps bound the run.
		rep, err := g.mgr.RunHeadless(context.Background(), mt.ID)
		if err != nil {
			writeJSON(w, 500, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, 200, map[string]any{"match_id": rep.MatchID, "report": rep})
		return
	}
	go g.mgrLoop(mt.ID, opts.TickMs)
	// Hand back the credential the client needs for everything after this
	// call. Without it a browser would have to keep using the operator token
	// just to follow its own game.
	tok, _ := g.mgr.PlayerToken(mt.ID)
	writeJSON(w, 200, map[string]any{
		"match_id": mt.ID, "game": mt.Game, "player_token": tok,
	})
}

// mgrLoop runs a live match detached from the request so a long match is not
// killed by an HTTP client timeout. The loop paces real ticks and idles while
// the rules wait on a human seat (see game.Manager.Run).
func (g *Games) mgrLoop(id string, tickMs int) {
	if err := g.mgr.Run(context.Background(), id, time.Duration(tickMs)*time.Millisecond); err != nil {
		log.Printf("game %s: tick loop stopped: %v", id, err)
	}
}

func (g *Games) list(w http.ResponseWriter, r *http.Request) {
	out := []any{}
	for _, mt := range g.mgr.List() {
		out = append(out, map[string]any{
			"match_id": mt.ID, "game": mt.Game, "tick": mt.Tick(),
		})
	}
	writeJSON(w, 200, map[string]any{"matches": out})
}

func (g *Games) show(w http.ResponseWriter, r *http.Request, id string) {
	mt, ok := g.mgr.Get(id)
	if !ok {
		writeJSON(w, 404, map[string]any{"error": "match not found"})
		return
	}
	snap, err := g.mgr.SnapshotNow(r.Context(), id, "")
	if err != nil {
		writeJSON(w, 500, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{"match_id": id, "tick": mt.Tick(), "snapshot": snap})
}

func (g *Games) events(w http.ResponseWriter, r *http.Request, id string) {
	ch, unsub, err := g.mgr.Subscribe(id)
	if err != nil {
		writeJSON(w, 404, map[string]any{"error": err.Error()})
		return
	}
	defer unsub()
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	fl, _ := w.(http.Flusher)
	// Initial comment keeps proxies from buffering.
	if fl != nil {
		_, _ = w.Write([]byte(": connected\n\n"))
		fl.Flush()
	}
	for {
		select {
		case <-r.Context().Done():
			return
		case ev, ok := <-ch:
			if !ok {
				return
			}
			name := ev.Name
			if name == "" {
				name = "tick"
			}
			var b []byte
			if ev.Notice != nil {
				// A notice is not a game event: it carries no state, so the
				// payload is the notice alone. Marshalling the embedded
				// snapshot would pad every notice with state:null.
				b, _ = json.Marshal(struct {
					MatchID string `json:"match_id"`
					Notice  any    `json:"notice"`
				}{MatchID: ev.MatchID, Notice: ev.Notice})
			} else {
				b, _ = json.Marshal(ev.SnapshotMsg)
			}
			_, _ = w.Write([]byte("event: " + name + "\ndata: " + string(b) + "\n\n"))
			if fl != nil {
				fl.Flush()
			}
			if ev.Done {
				return
			}
		}
	}
}

func (g *Games) commands(w http.ResponseWriter, r *http.Request, id string) {
	var b struct {
		Player   string         `json:"player"`
		Commands map[string]any `json:"commands"`
	}
	if err := decodeBody(r, &b); err != nil {
		writeJSON(w, 400, map[string]any{"error": err.Error()})
		return
	}
	if b.Player == "" {
		writeJSON(w, 400, map[string]any{"error": "player is required"})
		return
	}
	if err := g.mgr.PostCommands(id, b.Player, b.Commands); err != nil {
		writeJSON(w, 400, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (g *Games) stop(w http.ResponseWriter, r *http.Request, id string) {
	rep, err := g.mgr.Stop(id, "stopped by operator")
	if err != nil {
		writeJSON(w, 404, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "report": rep})
}

func (g *Games) replay(w http.ResponseWriter, r *http.Request, id string) {
	rep, ok := g.mgr.Report(id)
	if !ok {
		writeJSON(w, 404, map[string]any{"error": "report not found"})
		return
	}
	writeJSON(w, 200, rep)
}
