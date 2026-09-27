package game

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"strings"
	"time"
)

// SvcSlot is the reserved commands-map key that backend services post into.
// A service never impersonates a human seat (p0, p1, …): pack rules read
// service channels through this slot, so an operator watching the replay can
// always tell "the player did this" from "the backend did this".
const SvcSlot = "__svc__"

// ObservePath is where the gateway pushes a post-tick payload to a service
// that declared match_access.observe. It is a service-side path: the service
// owns the handler, the gateway only decides when to call it.
const ObservePath = "/observe"

// MatchAccess is what one pack service may do with a live match. It is
// fail-closed like brain capabilities: an undeclared service binds to nothing,
// and a channel that is not listed cannot be posted.
//
// It replaces relaying service state through a brain seat. Previously a
// backend could only act by queuing an operation that some brain happened to
// poll for — so it needed a brain to exist, it paid a tick of latency, and it
// could only see whatever that brain chose to forward.
type MatchAccess struct {
	// Observe: "" (off) | "full" (the whole post-tick state) | "digest"
	// (a bounded summary: the gateway truncates and reports the size).
	Observe string `json:"observe,omitempty"`
	// Commands lists the channel names this service may post, e.g. ["gm"].
	// The gateway rejects anything else before it can reach the rules.
	Commands []string `json:"commands,omitempty"`
	// Notify allows out-of-band messages onto the match's SSE stream. They
	// never enter the state, so they cannot perturb a deterministic replay.
	Notify bool `json:"notify,omitempty"`
	// TimeoutMs caps one push to the service. Short by design: a slow or dead
	// backend must never hold up the tick loop.
	TimeoutMs int `json:"timeout_ms,omitempty"`
}

func (a MatchAccess) observes() bool { return a.Observe == "full" || a.Observe == "digest" }

func (a MatchAccess) timeout() time.Duration {
	if a.TimeoutMs > 0 {
		return time.Duration(a.TimeoutMs) * time.Millisecond
	}
	return 3 * time.Second
}

// ServiceLink is the manager-facing description of one service that wants
// match access, derived from the pack manifest at match creation.
type ServiceLink struct {
	Name   string
	Access MatchAccess
}

func (a MatchAccess) channels() map[string]bool {
	out := make(map[string]bool, len(a.Commands))
	for _, c := range a.Commands {
		out[c] = true
	}
	return out
}

// svcLink is one service bound to one match, with the token that authorises
// it. The token is per match and per service: leaking one backend's token
// does not let it act on another match, another game, or another service.
type svcLink struct {
	name     string
	token    string
	access   MatchAccess
	channels map[string]bool
}

func newSvcLink(name string, access MatchAccess) svcLink {
	return svcLink{
		name:     name,
		token:    newBridgeToken(),
		access:   access,
		channels: access.channels(),
	}
}

func newBridgeToken() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		// crypto/rand failing is not recoverable for an auth token; a
		// time-derived value would be worse than a hard failure.
		panic("gateway: no entropy for match token: " + err.Error())
	}
	return "mt_" + hex.EncodeToString(b[:])
}

// BridgeConfig is the gateway-side context a bound service needs in order to
// talk back.
type BridgeConfig struct {
	// GatewayURL is the base URL services post to. Injected into every
	// observe payload so a service never has to be configured with it.
	GatewayURL string
}

// Observer is called once per real tick for every bound service that asked to
// observe. Implementations must not block: the tick loop dispatches in a
// goroutine and a hung backend may only ever cost that backend its updates.
type Observer func(game, service, matchID, token string, payload map[string]any)

// attachServices binds the services of the pack this match runs. Called once
// at creation, so a manifest edited mid-match cannot widen an existing
// match's reach — the same snapshot rule as brain capabilities.
func (mt *Match) attachServices(links []ServiceLink) {
	mt.mu.Lock()
	defer mt.mu.Unlock()
	mt.svcs = make(map[string]svcLink, len(links))
	for _, l := range links {
		if l.Name == "" {
			continue
		}
		mt.svcs[l.Name] = newSvcLink(l.Name, l.Access)
	}
}

// svcByToken finds the service a token belongs to. Compared in constant time
// so a caller cannot recover a valid token byte by byte from response
// timing.
func (mt *Match) svcByToken(token string) (svcLink, bool) {
	if token == "" {
		return svcLink{}, false
	}
	mt.mu.Lock()
	defer mt.mu.Unlock()
	for _, l := range mt.svcs {
		if subtleEqual(l.token, token) {
			return l, true
		}
	}
	return svcLink{}, false
}

func subtleEqual(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	var v byte
	for i := 0; i < len(a); i++ {
		v |= a[i] ^ b[i]
	}
	return v == 0
}

// PostServiceCommands hands commands from a backend service to the rules for
// the next tick, exactly as a human seat's POST /commands would. Legality
// still belongs to the rules: the gateway only enforces WHICH channels the
// service may use, never what the values mean.
func (m *Manager) PostServiceCommands(matchID, token string, cmds map[string]any) error {
	mt, err := m.match(matchID)
	if err != nil {
		return err
	}
	link, ok := mt.svcByToken(token)
	if !ok {
		return fmt.Errorf("unknown service token for this match")
	}
	if len(cmds) == 0 {
		return fmt.Errorf("commands required")
	}
	for ch := range cmds {
		if !link.channels[ch] {
			return fmt.Errorf("service %q may not post channel %q (allowed: %s)",
				link.name, ch, strings.Join(link.access.Commands, ", "))
		}
	}
	mt.mu.Lock()
	if mt.done {
		mt.mu.Unlock()
		return fmt.Errorf("match over")
	}
	if mt.commands == nil {
		mt.commands = map[string]map[string]any{}
	}
	cur := mt.commands[SvcSlot]
	if cur == nil {
		cur = map[string]any{}
	}
	for k, v := range cmds {
		cur[k] = v
	}
	mt.commands[SvcSlot] = cur
	mt.mu.Unlock()
	// Wake a tick loop parked on a human seat: a backend action is as good a
	// reason to advance as a player move, and otherwise it would sit idle
	// until the next scheduled tick.
	mt.wake()
	return nil
}

// NotifyService pushes an out-of-band message to everyone watching the match.
// It is deliberately not part of the state: the replay stays a faithful record
// of the rules' own decisions, and a chatty backend cannot desync determinism.
func (m *Manager) NotifyService(matchID, token string, payload map[string]any) error {
	mt, err := m.match(matchID)
	if err != nil {
		return err
	}
	link, ok := mt.svcByToken(token)
	if !ok {
		return fmt.Errorf("unknown service token for this match")
	}
	if !link.access.Notify {
		return fmt.Errorf("service %q may not send notices", link.name)
	}
	mt.broadcastEvent(Event{
		Name:        "notice",
		SnapshotMsg: SnapshotMsg{MatchID: mt.ID},
		Notice:      payload,
	})
	return nil
}

// pushObserve hands the post-tick state to every bound observer. Fire and
// forget: a service that is slow, wedged or gone costs only its own updates.
func (m *Manager) pushObserve(mt *Match, tick int, state map[string]any) {
	if m.observe == nil {
		return
	}
	mt.mu.Lock()
	targets := make([]svcLink, 0, len(mt.svcs))
	for _, l := range mt.svcs {
		if l.access.observes() {
			targets = append(targets, l)
		}
	}
	bridge := m.bridge
	mt.mu.Unlock()
	if len(targets) == 0 {
		return
	}
	base := map[string]any{
		"match_id":     mt.ID,
		"game":         mt.Game,
		"tick":         tick,
		"gateway":      bridge.GatewayURL,
		"observe_path": ObservePath,
		"ops_path":     OpsPath(mt.ID),
		"notify_path":  NotifyPath(mt.ID),
		"token_header": TokenHeader,
	}
	for _, l := range targets {
		l := l
		payload := make(map[string]any, len(base)+3)
		for k, v := range base {
			payload[k] = v
		}
		// The service needs its own token to act; it caches it per match.
		payload["token"] = l.token
		payload["service"] = l.name
		payload["state"] = observeState(l.access.Observe, state)
		go m.observe(mt.Game, l.name, mt.ID, l.token, payload)
	}
}

// observeState projects the post-tick state per the service's declared mode.
// "digest" is a bounded summary: a backend that wants the whole board can ask
// for "full", but the default keeps the push small enough that a chatty
// backend cannot turn into a bandwidth problem.
func observeState(mode string, state map[string]any) any {
	if mode == "full" {
		return state
	}
	digest := map[string]any{}
	for _, k := range []string{"tick", "seed", "depth", "gold", "hp", "level", "phase", "over"} {
		if v, ok := state[k]; ok {
			digest[k] = v
		}
	}
	// Player lists stay useful but are capped.
	for _, k := range []string{"players", "units", "inventory", "heroes"} {
		v, ok := state[k]
		if !ok {
			continue
		}
		if arr, ok := v.([]any); ok {
			if len(arr) > 8 {
				arr = arr[:8]
			}
			digest[k] = arr
		} else {
			digest[k] = v
		}
	}
	return digest
}

// OpsPath and NotifyPath are where a service posts back for one match.
func OpsPath(matchID string) string    { return "/v1/internal/matches/" + matchID + "/ops" }
func NotifyPath(matchID string) string { return "/v1/internal/matches/" + matchID + "/notify" }

// TokenHeader carries the per-match service token. A header rather than a
// body field so it never lands in an access log or a body dump.
const TokenHeader = "X-Match-Token"

// ServiceTokens reports the live match->service bindings, for diagnostics and
// tests. Values are tokens: do not log this.
func (m *Manager) ServiceTokens(matchID string) map[string]string {
	mt, err := m.match(matchID)
	if err != nil {
		return nil
	}
	mt.mu.Lock()
	defer mt.mu.Unlock()
	out := make(map[string]string, len(mt.svcs))
	for name, l := range mt.svcs {
		out[name] = l.token
	}
	return out
}

// SetObserver installs the per-tick delivery hook. Optional: without it a
// match runs exactly as before, and services that declare observe simply
// receive nothing.
func (m *Manager) SetObserver(o Observer) {
	m.mu.Lock()
	m.observe = o
	m.mu.Unlock()
}

// SetBridge supplies the callback context services need to post back.
func (m *Manager) SetBridge(b BridgeConfig) {
	m.mu.Lock()
	m.bridge = b
	m.mu.Unlock()
}

// LinksFromAccess turns a pack's declared per-service match access into
// ServiceLinks, dropping the services that declared nothing. A service with
// no match_access binds to no token and can do nothing to a match.
func LinksFromAccess(names []string, access map[string]MatchAccess) []ServiceLink {
	var out []ServiceLink
	for _, n := range names {
		a, ok := access[n]
		if !ok {
			continue
		}
		if a.Observe == "" && len(a.Commands) == 0 && !a.Notify {
			continue
		}
		out = append(out, ServiceLink{Name: n, Access: a})
	}
	return out
}
