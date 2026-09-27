package api

import (
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"strings"
	"sync"

	"gateway/internal/services"
)

// ServiceTokens authorises pack services against the gateway's own API.
//
// This is the credential that lets a player browser start a game without
// holding an operator token: the browser asks the service (over /svc), and
// the service calls the gateway with its own scoped token. That is why the
// gateway hosts a Python runtime for packs in the first place — the backend
// is the party that can hold a credential the browser should not.
//
// The token authorises exactly what the pack's manifest declared, and only
// for the pack's own game. It is NOT the admin token, and it is deliberately
// not reachable through env_allow: a pack cannot escalate to operator by
// asking for it in the manifest.
type ServiceTokens struct {
	mu    sync.RWMutex
	byKey map[string]serviceIdentity // "<game>/<service>" -> identity
}

type serviceIdentity struct {
	token  string
	access services.GatewayAccess
}

// NewServiceTokens mints a token for every ref that declared gateway access.
// Refs without it are simply absent, which is the fail-closed default.
func NewServiceTokens(refs []services.Ref) *ServiceTokens {
	t := &ServiceTokens{byKey: map[string]serviceIdentity{}}
	for _, r := range refs {
		if !r.GatewayAccess.Any() {
			continue
		}
		t.byKey[r.Key()] = serviceIdentity{token: newServiceToken(), access: r.GatewayAccess}
	}
	return t
}

func newServiceToken() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic("gateway: no entropy for service token: " + err.Error())
	}
	return "st_" + hex.EncodeToString(b[:])
}

// TokenFor returns the token minted for one service, for injection into its
// environment. Empty when the service declared no gateway access.
func (t *ServiceTokens) TokenFor(game, name string) string {
	if t == nil {
		return ""
	}
	t.mu.RLock()
	defer t.mu.RUnlock()
	return t.byKey[game+"/"+name].token
}

// CanCreateMatch reports whether tok is a service token of the pack named
// game, and that pack may create matches. The game argument is the one the
// REQUEST asked for, so a dungeon service cannot create an rts match.
func (t *ServiceTokens) CanCreateMatch(gameName, tok string) bool {
	id, ok := t.lookup(gameName, tok)
	return ok && id.access.CreateMatches
}

// CanStopMatch reports whether tok is a service token of the pack that owns the
// given match.
func (t *ServiceTokens) CanStopMatch(gameName, tok string) bool {
	id, ok := t.lookup(gameName, tok)
	return ok && id.access.StopMatches
}

// lookup finds a service by the game it belongs to. A token is only ever
// considered within its own pack, so leaking one does not help elsewhere.
func (t *ServiceTokens) lookup(gameName, tok string) (serviceIdentity, bool) {
	if t == nil || tok == "" {
		return serviceIdentity{}, false
	}
	t.mu.RLock()
	defer t.mu.RUnlock()
	for name, id := range t.byKey {
		if !strings.HasPrefix(name, gameName+"/") {
			continue
		}
		if constantTimeEqual(id.token, tok) {
			return id, true
		}
	}
	return serviceIdentity{}, false
}

func constantTimeEqual(a, b string) bool {
	if len(a) != len(b) || a == "" {
		return false
	}
	var v byte
	for i := 0; i < len(a); i++ {
		v |= a[i] ^ b[i]
	}
	return v == 0
}

// ServiceTokenHeader carries a service's scoped gateway token.
const ServiceTokenHeader = "X-Service-Token"

func tokenFromRequest(r *http.Request, header string) string {
	tok := r.Header.Get(header)
	if tok == "" {
		tok = strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	}
	return strings.TrimSpace(tok)
}

// serviceOwnerOf reports which pack a live match belongs to, so a service
// token is checked against the match's own game rather than a claimed one.
func (g *Games) serviceOwnerOf(matchID string) string {
	mt, ok := g.mgr.Get(matchID)
	if !ok {
		return ""
	}
	return mt.Game
}
