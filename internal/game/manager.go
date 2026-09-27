// Package game provides generic match primitives for the gateway game
// server. It knows nothing about any specific game: rules and brains are
// versioned JS script packs (see scripts/games/), Go only schedules ticks,
// runs brains, broadcasts snapshots, and unloads finished sessions.
package game

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"

	"gateway/internal/jsflow"
)

// Limits (plan 4.1/4.3/6).
const (
	MaxReplayTicks = 2000
	MaxMemoryBytes = 64 * 1024
)

// BrainPlayer binds a player slot to a brain script version.
type BrainPlayer struct {
	Brain   string `json:"brain"`
	Version string `json:"version,omitempty"`
}

// PlayerSpec is one seat: either a brain or a human/external seat.
type PlayerSpec struct {
	Brain *BrainPlayer `json:"brain,omitempty"`
	Human bool         `json:"human,omitempty"`
}

// CreateOptions mirrors POST /v1/games.
type CreateOptions struct {
	Game       string            `json:"game"`
	Rules      string            `json:"rules"`
	RulesVer   string            `json:"rules_version,omitempty"`
	Players    []PlayerSpec      `json:"players"`
	BrainVers  map[string]string `json:"brain_version,omitempty"`
	TickMs     int               `json:"tick_ms,omitempty"`
	Seed       int64             `json:"seed,omitempty"`
	MaxTicks   int               `json:"max_ticks,omitempty"`
	Headless   bool              `json:"headless,omitempty"`
	WebhookURL string            `json:"webhook_url,omitempty"`
	MemoryCap  int               `json:"memory_cap_bytes,omitempty"`
	// Props is an opaque game-specific bag passed through to rules.newmatch
	// (e.g. dungeon legacy items). The gateway never interprets it.
	Props map[string]any `json:"props,omitempty"`
}

// TickRecord is one replay entry.
type TickRecord struct {
	Tick     int            `json:"tick"`
	State    map[string]any `json:"state"`
	Commands map[string]any `json:"commands"`
	Events   []any          `json:"events"`
}

// Report is the bounded post-match artifact kept after unload.
type Report struct {
	MatchID string         `json:"match_id"`
	Game    string         `json:"game"`
	Winner  string         `json:"winner,omitempty"`
	Reason  string         `json:"reason,omitempty"`
	Ticks   int            `json:"ticks"`
	Replay  []TickRecord   `json:"replay"`
	Score   map[string]any `json:"score,omitempty"`
	EndedAt time.Time      `json:"ended_at"`
}

// SnapshotMsg is broadcast per tick.
type SnapshotMsg struct {
	MatchID string         `json:"match_id"`
	Tick    int            `json:"tick"`
	State   map[string]any `json:"state"`
	Events  []any          `json:"events"`
	Done    bool           `json:"done,omitempty"`
	Result  map[string]any `json:"result,omitempty"`
}

// Event is one item on a subscriber stream. Name is "tick", "over", or
// "notice" (an out-of-band message from a backend service, which carries no
// state and therefore never appears in the replay).
type Event struct {
	Name string `json:"-"`
	SnapshotMsg
	Notice any `json:"notice,omitempty"`
}

// Store abstracts versioned script packs (rules + brains).
type Store interface {
	Rules(game, version string) (script string, resolved string, err error)
	Brain(game, name, version string) (script string, resolved string, err error)
	// Manifest exposes the pack self-description (capabilities, layout).
	// A pack without a manifest file yields the default (zero capabilities).
	Manifest(game string) (*Manifest, error)
}

// Caps is the fail-closed capability set of one brain, snapshotted from the
// pack manifest at match creation (matches keep the initial grants even if the
// manifest changes later).
type Caps struct {
	LLM bool
	Jev bool
	SVC []string // permitted host.svc service names
}

// HostFactory builds the jsflow.Host for one brain call so the caller can
// wire intent/llm/svc/tool/log. game is needed to resolve pack services.
type HostFactory func(matchID, game, player string) jsflow.Host

// Webhook posts match events to an external backend; nil disables.
type Webhook func(url string, event map[string]any)

// Match is one live session.
type Match struct {
	ID      string
	Game    string
	Options CreateOptions

	mu        sync.Mutex
	state     map[string]any
	memories  map[string]any
	commands  map[string]map[string]any
	tick      int
	done      bool
	result    map[string]any
	subs      map[chan Event]struct{}
	replay    []TickRecord
	nudge     chan struct{} // posted commands wake an idle tick loop
	closed    chan struct{}
	closeOnce sync.Once
	svcs      map[string]svcLink // backend services bound to this match
	// playerTok authorises a player browser against THIS match only: read the
	// board, follow the stream, post commands. It cannot list matches, stop
	// one, or reach another player's game — so the browser no longer needs an
	// operator credential for the live-game loop.
	playerTok string

	rulesScript string
	rulesVer    string
	brainVer    map[string]string
	brainCaps   map[string]Caps // brain 名 -> 建局时的能力快照（fail-closed）
}

func newMatchID() string {
	var b [8]byte
	_, _ = rand.Read(b[:])
	return "m_" + hex.EncodeToString(b[:])
}

// Manager owns live matches plus bounded reports.
type Manager struct {
	mu       sync.RWMutex
	matches  map[string]*Match
	reports  map[string]*Report
	order    []string
	maxKeep  int
	store    Store
	pool     *jsflow.Pool
	hosts    HostFactory
	webhook  Webhook
	capTicks int
	observe  Observer
	bridge   BridgeConfig
}

// NewManager creates a manager. maxKeep bounds stored reports.
func NewManager(store Store, pool *jsflow.Pool, hosts HostFactory, webhook Webhook, maxKeep, capTicks int) *Manager {
	if maxKeep <= 0 {
		maxKeep = 100
	}
	if capTicks <= 0 {
		capTicks = MaxReplayTicks
	}
	return &Manager{
		matches:  map[string]*Match{},
		reports:  map[string]*Report{},
		store:    store,
		pool:     pool,
		hosts:    hosts,
		webhook:  webhook,
		maxKeep:  maxKeep,
		capTicks: capTicks,
	}
}

func toMap(v any) map[string]any {
	if v == nil {
		return map[string]any{}
	}
	if m, ok := v.(map[string]any); ok {
		return m
	}
	b, err := json.Marshal(v)
	if err != nil {
		return map[string]any{}
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		return map[string]any{}
	}
	return m
}

// Create validates scripts (required exports) and registers a match.
func (m *Manager) Create(ctx context.Context, opts CreateOptions) (*Match, error) {
	if opts.Game == "" {
		return nil, fmt.Errorf("game is required")
	}
	if len(opts.Players) == 0 {
		return nil, fmt.Errorf("players is required")
	}
	rulesScript, rulesVer, err := m.store.Rules(opts.Game, opts.RulesVer)
	if err != nil {
		return nil, err
	}
	brainVer := map[string]string{}
	for i, p := range opts.Players {
		if p.Brain == nil {
			continue
		}
		if p.Brain.Brain == "" {
			return nil, fmt.Errorf("players[%d].brain.brain is required", i)
		}
		ver := p.Brain.Version
		if ver == "" && opts.BrainVers != nil {
			ver = opts.BrainVers[p.Brain.Brain]
		}
		bscript, resolved, err := m.store.Brain(opts.Game, p.Brain.Brain, ver)
		if err != nil {
			return nil, err
		}
		_ = bscript
		brainVer[p.Brain.Brain] = resolved
	}
	// Capability snapshot: fail-closed — a brain gets only what its pack
	// manifest declares, and only what was declared when the match started.
	man, err := m.store.Manifest(opts.Game)
	if err != nil {
		return nil, fmt.Errorf("manifest for game %q: %w", opts.Game, err)
	}
	brainCaps := map[string]Caps{}
	for name := range brainVer {
		var c Caps
		for _, cap := range man.Capabilities[name] {
			switch {
			case cap == "llm":
				c.LLM = true
			case cap == "jev":
				c.Jev = true
			case strings.HasPrefix(cap, "svc:"):
				c.SVC = append(c.SVC, strings.TrimPrefix(cap, "svc:"))
			}
		}
		brainCaps[name] = c
	}
	// Seed 0 = 留空随机：这里统一刷新成随机种子（同种子复现的前提是显式传非 0）。
	if opts.Seed == 0 {
		opts.Seed = time.Now().UnixNano() & 0x7fffffff
	}
	mt := &Match{
		ID:          newMatchID(),
		Game:        opts.Game,
		Options:     opts,
		state:       map[string]any{"seed": opts.Seed, "tick": 0},
		memories:    map[string]any{},
		commands:    map[string]map[string]any{},
		subs:        map[chan Event]struct{}{},
		nudge:       make(chan struct{}, 1),
		closed:      make(chan struct{}),
		rulesScript: rulesScript,
		rulesVer:    rulesVer,
		brainVer:    brainVer,
		brainCaps:   brainCaps,
		playerTok:   newBridgeToken(),
	}
	// Bind the pack's backend services, snapshotted from the same manifest
	// read: a service that gains match_access after this match started gets
	// no token for it.
	mt.attachServices(LinksFromAccess(man.ServiceNames(), man.BridgeAccess()))
	// Allow rules to seed initial state via a `newmatch` export when present.
	// Missing export is fine (ignored).
	if st := m.callRulesNewMatch(ctx, mt, map[string]any{
		"seed": opts.Seed, "players": len(opts.Players), "props": opts.Props,
	}); len(st) > 0 {
		mt.state = st
	}
	m.mu.Lock()
	m.matches[mt.ID] = mt
	m.mu.Unlock()
	m.emit(opts.WebhookURL, map[string]any{
		"match_id": mt.ID, "game": mt.Game, "type": "match_start",
		"rules_version": rulesVer,
	})
	return mt, nil
}

func (m *Manager) Get(id string) (*Match, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	mt, ok := m.matches[id]
	return mt, ok
}

// List returns live matches only; unloaded ones are gone.
func (m *Manager) List() []*Match {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]*Match, 0, len(m.matches))
	for _, mt := range m.matches {
		out = append(out, mt)
	}
	return out
}

// Report returns a stored post-match report.
func (m *Manager) Report(id string) (*Report, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	r, ok := m.reports[id]
	return r, ok
}

// Stop terminates a match early and unloads it.
func (m *Manager) Stop(id, reason string) (*Report, error) {
	m.mu.Lock()
	mt, ok := m.matches[id]
	m.mu.Unlock()
	if !ok {
		return nil, fmt.Errorf("match not found")
	}
	mt.mu.Lock()
	fresh := !mt.done
	if fresh {
		mt.done = true
		mt.result = map[string]any{"winner": "", "reason": reason}
	}
	tick, result := mt.tick, mt.result
	mt.mu.Unlock()
	// Tell the watchers before the channels close. Without this a client sees
	// its SSE connection simply drop and cannot tell "the match finished" from
	// "the network died" — it has no result to render and no signal to stop
	// reconnecting.
	if fresh {
		mt.broadcastEvent(Event{Name: "over", SnapshotMsg: SnapshotMsg{
			MatchID: mt.ID, Tick: tick, Done: true, Result: result,
		}})
	}
	return m.unload(mt), nil
}

// PostCommands merges external commands for the next tick.
func (m *Manager) PostCommands(id, player string, cmds map[string]any) error {
	m.mu.RLock()
	mt, ok := m.matches[id]
	m.mu.RUnlock()
	if !ok {
		return fmt.Errorf("match not found")
	}
	mt.mu.Lock()
	defer mt.mu.Unlock()
	if mt.done {
		return fmt.Errorf("match over")
	}
	if mt.commands == nil {
		mt.commands = map[string]map[string]any{}
	}
	cur := mt.commands[player]
	if cur == nil {
		cur = map[string]any{}
	}
	for k, v := range cmds {
		cur[k] = v
	}
	mt.commands[player] = cur
	// Wake the tick loop if it parked waiting for this seat to act.
	select {
	case mt.nudge <- struct{}{}:
	default:
	}
	return nil
}

// Tick returns the current tick number.
func (mt *Match) Tick() int {
	mt.mu.Lock()
	defer mt.mu.Unlock()
	return mt.tick
}

// SnapshotNow returns the current snapshot for a player.
func (m *Manager) SnapshotNow(ctx context.Context, id, player string) (map[string]any, error) {
	m.mu.RLock()
	mt, ok := m.matches[id]
	m.mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("match not found")
	}
	return m.callRulesSnapshot(ctx, mt, player)
}

// Subscribe attaches an SSE-style channel and queues the match's current
// snapshot on it right away. Without that first message a client joining a
// match whose rules are waiting on a human seat would never see a board at
// all (only quiet ticks follow), and a client joining mid-match would have to
// fire a follow-up GET to render anything.
func (m *Manager) Subscribe(id string) (chan Event, func(), error) {
	m.mu.RLock()
	mt, ok := m.matches[id]
	m.mu.RUnlock()
	if !ok {
		return nil, nil, fmt.Errorf("match not found")
	}
	ch := make(chan Event, 64)
	mt.mu.Lock()
	mt.subs[ch] = struct{}{}
	// Sent under the lock, into a buffered channel: it is therefore ordered
	// before any broadcast that follows, never a stale rewind.
	initial := Event{Name: "tick", SnapshotMsg: SnapshotMsg{MatchID: id, Tick: mt.tick, State: mt.state}}
	if mt.done {
		initial.Name = "over"
		initial.Done = true
		initial.Result = mt.result
	}
	ch <- initial
	mt.mu.Unlock()
	return ch, func() {
		mt.mu.Lock()
		delete(mt.subs, ch)
		mt.mu.Unlock()
	}, nil
}

func (m *Manager) match(id string) (*Match, error) {
	m.mu.RLock()
	mt, ok := m.matches[id]
	m.mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("match not found")
	}
	return mt, nil
}

// PlayerToken returns the credential a player browser uses for this match.
func (m *Manager) PlayerToken(id string) (string, bool) {
	mt, err := m.match(id)
	if err != nil {
		return "", false
	}
	mt.mu.Lock()
	defer mt.mu.Unlock()
	return mt.playerTok, mt.playerTok != ""
}

// PlayerAuthorized reports whether tok is the token of THIS match. Compared in
// constant time, and only ever against the match being addressed — a token
// for one match must not open another.
func (mt *Match) PlayerAuthorized(tok string) bool {
	if tok == "" {
		return false
	}
	mt.mu.Lock()
	defer mt.mu.Unlock()
	return subtleEqual(mt.playerTok, tok)
}

// wake nudges a tick loop parked waiting for a seat to act.
func (mt *Match) wake() {
	select {
	case mt.nudge <- struct{}{}:
	default:
	}
}

// hasExternalSeat reports whether any seat is driven from outside the server
// (a human or an external service posting commands). Only such a match can go
// idle waiting for input; brain-only matches always keep ticking.
func (mt *Match) hasExternalSeat() bool {
	for _, p := range mt.Options.Players {
		if p.Brain == nil {
			return true
		}
	}
	return false
}

func (mt *Match) broadcast(msg SnapshotMsg) {
	mt.broadcastEvent(Event{Name: "tick", SnapshotMsg: msg})
}

func (mt *Match) broadcastEvent(ev Event) {
	mt.mu.Lock()
	defer mt.mu.Unlock()
	for ch := range mt.subs {
		select {
		case ch <- ev:
		default:
		}
	}
}

func (mt *Match) closeSubs() {
	mt.mu.Lock()
	defer mt.mu.Unlock()
	for ch := range mt.subs {
		close(ch)
	}
	mt.subs = map[chan Event]struct{}{}
}

// StepResult reports the outcome of one Step.
type StepResult struct {
	Msg SnapshotMsg
	// Wait is true when the rules asked to skip this tick because a seat has
	// not acted yet: no state advanced, no tick counted, nothing broadcast.
	Wait bool
	// Done is true when the match ended here; it was unloaded and its report
	// stored, so the caller must stop stepping it.
	Done bool
}

// Step advances one tick: brains decide, rules tick, snapshot broadcast.
func (m *Manager) Step(ctx context.Context, id string) (StepResult, error) {
	m.mu.RLock()
	mt, ok := m.matches[id]
	m.mu.RUnlock()
	if !ok {
		return StepResult{}, fmt.Errorf("match not found")
	}
	mt.mu.Lock()
	if mt.done {
		mt.mu.Unlock()
		return StepResult{Done: true}, nil
	}
	tick := mt.tick + 1
	players := mt.Options.Players
	mt.mu.Unlock()

	cmds := map[string]any{}
	mt.mu.Lock()
	for player, c := range mt.commands {
		cmds[player] = c
	}
	// Consume human seats and the service slot: one-shot per tick, never
	// replay stale commands. A backend action that was not consumed by this
	// tick is dropped rather than re-applied next tick.
	for i, p := range players {
		if p.Brain == nil {
			delete(mt.commands, fmt.Sprintf("p%d", i))
		}
	}
	delete(mt.commands, SvcSlot)
	mt.mu.Unlock()

	// AI brains decide.
	for i, p := range players {
		if p.Brain == nil {
			continue
		}
		slot := fmt.Sprintf("p%d", i)
		snap, err := m.callRulesSnapshot(ctx, mt, slot)
		if err != nil {
			return StepResult{}, err
		}
		mem := mt.getMemory(slot)
		out, nmem, err := m.runBrain(ctx, mt, slot, snap, mem)
		if err != nil {
			return StepResult{}, fmt.Errorf("brain %s: %w", p.Brain.Brain, err)
		}
		mt.setMemory(slot, nmem)
		cmds[slot] = out
	}

	next, events, wait, err := m.callRulesTick(ctx, mt, cmds)
	if err != nil {
		return StepResult{}, err
	}
	// Rules asked to wait (e.g. a human seat has no command yet): skip the
	// tick entirely — no state advance, no tick count, no replay record, and
	// no broadcast. An unchanged board is not news; the caller parks until a
	// command actually arrives instead of polling.
	if wait {
		mt.mu.Lock()
		tickNow := mt.tick
		mt.mu.Unlock()
		return StepResult{Msg: SnapshotMsg{MatchID: id, Tick: tickNow}, Wait: true}, nil
	}
	done, result := m.callRulesOver(ctx, mt, next)

	mt.mu.Lock()
	mt.state = next
	mt.tick = tick
	if len(mt.replay) < m.capTicks {
		rec := TickRecord{Tick: tick, State: next, Commands: toMap(cmds), Events: events}
		mt.replay = append(mt.replay, rec)
	}
	if done {
		mt.done = true
		mt.result = result
	}
	mt.mu.Unlock()

	msg := SnapshotMsg{MatchID: id, Tick: tick, State: next, Events: events}
	if done {
		msg.Done = true
		msg.Result = result
		mt.broadcastEvent(Event{Name: "over", SnapshotMsg: msg})
		m.pushObserve(mt, tick, next)
		m.finish(mt)
		return StepResult{Msg: msg, Done: true}, nil
	}
	mt.broadcast(msg)
	m.pushObserve(mt, tick, next)
	if mt.Options.MaxTicks > 0 && tick >= mt.Options.MaxTicks {
		mt.mu.Lock()
		mt.done = true
		if mt.result == nil {
			mt.result = map[string]any{"winner": "", "reason": "max_ticks"}
		}
		mt.mu.Unlock()
		msg.Done = true
		msg.Result = mt.result
		mt.broadcastEvent(Event{Name: "over", SnapshotMsg: msg})
		m.finish(mt)
		return StepResult{Msg: msg, Done: true}, nil
	}
	return StepResult{Msg: msg}, nil
}

// Run drives one live match: real ticks are paced at interval, while a tick
// the rules asked to wait on parks the loop until an external command arrives.
// That keeps a push-only channel honest — a match sitting on a human's turn
// emits nothing at all rather than a fixed-rate stream of empty heartbeats.
// Returns when the match ends, is unloaded, ctx is cancelled, or step fails.
func (m *Manager) Run(ctx context.Context, id string, interval time.Duration) error {
	if interval <= 0 {
		interval = 500 * time.Millisecond
	}
	mt, ok := m.Get(id)
	if !ok {
		return fmt.Errorf("match not found")
	}
	// Only a match with an external seat can be woken by a command; a
	// brain-only match that waits would otherwise park forever.
	parkOnWait := mt.hasExternalSeat()
	for {
		res, err := m.Step(ctx, id)
		if err != nil {
			return err
		}
		if res.Done {
			return nil
		}
		if res.Wait && parkOnWait {
			if !mt.waitForCommand(ctx) {
				return nil
			}
			continue // a command is pending: act on it without a full delay
		}
		select {
		case <-ctx.Done():
			return nil
		case <-mt.closed:
			return nil
		case <-time.After(interval):
		}
	}
}

// waitForCommand parks until a command is posted, the match is unloaded, or
// ctx is cancelled. Reports whether a command was posted.
func (mt *Match) waitForCommand(ctx context.Context) bool {
	select {
	case <-ctx.Done():
		return false
	case <-mt.closed:
		return false
	case <-mt.nudge:
		return true
	}
}

// defaultHeadlessTicks bounds RunHeadless when the caller sets no max_ticks.
// Without it a match that can never end (e.g. a single-brain game whose
// empty seat keeps producing illegal no-op ticks) would loop forever.
const defaultHeadlessTicks = 500

// RunHeadless runs to completion without sleeping or SSE.
func (m *Manager) RunHeadless(ctx context.Context, id string) (*Report, error) {
	m.mu.RLock()
	mt, ok := m.matches[id]
	m.mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("match not found")
	}
	// Transient bound so Step's own max_ticks path finishes the match
	// with a proper report instead of looping forever.
	mt.mu.Lock()
	if mt.Options.MaxTicks <= 0 {
		mt.Options.MaxTicks = defaultHeadlessTicks
	}
	mt.mu.Unlock()
	for {
		res, err := m.Step(ctx, id)
		if err != nil {
			return nil, err
		}
		// A match that waits on a seat nobody can fill in headless mode never
		// advances (so max_ticks never fires either): fail loudly rather than
		// spinning forever.
		if res.Wait {
			return nil, fmt.Errorf("rules waited for a seat that headless mode cannot fill")
		}
		if res.Done {
			m.mu.RLock()
			rep, ok := m.reports[id]
			m.mu.RUnlock()
			if !ok {
				return nil, fmt.Errorf("match report missing")
			}
			return rep, nil
		}
	}
}

func (m *Manager) finish(mt *Match) {
	rep := m.unload(mt)
	m.emit(mt.Options.WebhookURL, map[string]any{
		"match_id": mt.ID, "game": mt.Game, "type": "match_over",
		"result": rep.ResultPayload(),
	})
}

func (m *Manager) unload(mt *Match) *Report {
	// Release anything parked on this session (e.g. an idle tick loop) before
	// the subscribers go away.
	mt.closeOnce.Do(func() { close(mt.closed) })
	mt.closeSubs()
	mt.mu.Lock()
	rep := &Report{
		MatchID: mt.ID, Game: mt.Game,
		Ticks: mt.tick, Replay: append([]TickRecord(nil), mt.replay...),
		EndedAt: time.Now(),
	}
	if mt.result != nil {
		if w, ok := mt.result["winner"].(string); ok {
			rep.Winner = w
		}
		if r, ok := mt.result["reason"].(string); ok {
			rep.Reason = r
		}
		rep.Score = toMap(mt.result["score"])
	}
	mt.mu.Unlock()
	m.mu.Lock()
	delete(m.matches, mt.ID)
	m.reports[mt.ID] = rep
	m.order = append(m.order, mt.ID)
	for len(m.order) > m.maxKeep {
		old := m.order[0]
		m.order = m.order[1:]
		delete(m.reports, old)
	}
	m.mu.Unlock()
	return rep
}

// ResultPayload returns winner/reason/score for webhook payloads.
func (r *Report) ResultPayload() map[string]any {
	return map[string]any{"winner": r.Winner, "reason": r.Reason, "score": r.Score, "ticks": r.Ticks}
}

func (m *Manager) emit(url string, event map[string]any) {
	if url == "" || m.webhook == nil {
		return
	}
	go m.webhook(url, event)
}

func (mt *Match) getMemory(slot string) any {
	mt.mu.Lock()
	defer mt.mu.Unlock()
	return mt.memories[slot]
}

func (mt *Match) setMemory(slot string, mem any) {
	b, err := json.Marshal(mem)
	if err != nil || len(b) > MaxMemoryBytes {
		return
	}
	mt.mu.Lock()
	mt.memories[slot] = mem
	mt.mu.Unlock()
}
