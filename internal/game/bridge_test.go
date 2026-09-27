package game

import (
	"context"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"gateway/internal/jsflow"
)

// The bridge's central promise: a backend service can act on a live match
// WITHOUT a brain seat relaying for it. These tests pin the four properties
// that make that safe — per-match tokens, an explicit channel allow-list,
// one-shot consumption, and notices that never touch the state.

// bridgeStore serves a game whose rules always advance, record what arrived in
// the service slot, and never end on their own.
func bridgeStore(t *testing.T) *DiskStore {
	t.Helper()
	dir := t.TempDir()
	gdir := filepath.Join(dir, "g")
	if err := os.MkdirAll(gdir, 0o755); err != nil {
		t.Fatal(err)
	}
	rules := `
function newmatch(args) { return { state: { tick: 0, depth: 0, gold: 0, svc: null } }; }
function tick(args) {
  var s = args.state;
  var svc = (args.commands && args.commands["__svc__"]) || null;
  return { state: { tick: s.tick + 1, depth: s.depth + 1, gold: s.gold, svc: svc },
           events: [] };
}
function snapshot(args) { return JSON.parse(JSON.stringify(args.state)); }
function over(args) { return { over: null }; }
`
	if err := os.WriteFile(filepath.Join(gdir, "rules.js"), []byte(rules), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(gdir, "manifest.json"), []byte(`{"name":"g"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	return NewDiskStore([]string{dir}, 5)
}

func newBridgeMatch(t *testing.T, links ...ServiceLink) (*Manager, *Match) {
	t.Helper()
	pool := jsflow.NewPool(1)
	t.Cleanup(pool.Close)
	m := NewManager(bridgeStore(t), pool,
		func(matchID, _, player string) jsflow.Host { return jsflow.Host{Log: func(string) {}} },
		nil, 10, 2000)
	mt, err := m.Create(context.Background(), CreateOptions{
		Game: "g", Players: []PlayerSpec{{Human: true}},
		Seed: 7, MaxTicks: 3,
	})
	if err != nil {
		t.Fatal(err)
	}
	// Create binds from the manifest (which declares no services); the tests
	// attach explicitly so they can assert on the binding itself.
	mt.attachServices(links)
	return m, mt
}

func bridgeLinks() []ServiceLink {
	return []ServiceLink{{
		Name: "pm",
		Access: MatchAccess{
			Observe: "digest", Commands: []string{"gm"}, Notify: true, TimeoutMs: 500,
		},
	}}
}

func TestBridgeTokenIsPerMatchAndPerService(t *testing.T) {
	m, mt := newBridgeMatch(t, bridgeLinks()...)
	tok := m.ServiceTokens(mt.ID)["pm"]
	if tok == "" {
		t.Fatal("no token minted for a service that declared match_access")
	}
	// A token is scoped to one match.
	if err := m.PostServiceCommands("m_nonexistent", tok, map[string]any{"gm": map[string]any{}}); err == nil {
		t.Error("a valid token must not work on another match")
	}
	// ...and it is not the operator credential: a bogus token is rejected.
	if err := m.PostServiceCommands(mt.ID, "mt_deadbeef", map[string]any{"gm": map[string]any{}}); err == nil {
		t.Error("unknown token accepted")
	}
	if err := m.PostServiceCommands(mt.ID, "", map[string]any{"gm": map[string]any{}}); err == nil {
		t.Error("empty token accepted")
	}
	// A second match gets a different token for the same service.
	mt2, err := m.Create(context.Background(), CreateOptions{
		Game: "g", Players: []PlayerSpec{{Human: true}}, Seed: 8,
	})
	if err != nil {
		t.Fatal(err)
	}
	mt2.attachServices(bridgeLinks())
	if m.ServiceTokens(mt2.ID)["pm"] == tok {
		t.Error("tokens must not be reused across matches")
	}
}

func TestBridgeRefusesUndeclaredChannel(t *testing.T) {
	m, mt := newBridgeMatch(t, bridgeLinks()...)
	tok := m.ServiceTokens(mt.ID)["pm"]
	// The manifest allow-listed "gm" only.
	err := m.PostServiceCommands(mt.ID, tok, map[string]any{"action": "attack"})
	if err == nil {
		t.Fatal("posting an undeclared channel must fail")
	}
	// A declared one goes through.
	if err := m.PostServiceCommands(mt.ID, tok, map[string]any{"gm": map[string]any{"ops": []any{}}}); err != nil {
		t.Fatalf("declared channel rejected: %v", err)
	}
}

// A service that declared no match_access gets no token and therefore cannot
// act — the fail-closed default that keeps a stray Python script harmless.
func TestBridgeBindsNothingWithoutMatchAccess(t *testing.T) {
	m, mt := newBridgeMatch(t)
	if got := m.ServiceTokens(mt.ID); len(got) != 0 {
		t.Fatalf("services must bind nothing without match_access, got %v", got)
	}
	if err := m.PostServiceCommands(mt.ID, "anything", map[string]any{"gm": map[string]any{}}); err == nil {
		t.Error("a match with no bound service must reject every token")
	}
	if err := m.NotifyService(mt.ID, "anything", map[string]any{"x": 1}); err == nil {
		t.Error("notify must be rejected too")
	}
}

func TestBridgeCommandsAreOneShotAndDoNotImpersonateASeat(t *testing.T) {
	m, mt := newBridgeMatch(t, bridgeLinks()...)
	tok := m.ServiceTokens(mt.ID)["pm"]
	if err := m.PostServiceCommands(mt.ID, tok, map[string]any{"gm": map[string]any{"n": 1}}); err != nil {
		t.Fatal(err)
	}
	// The command lands in the reserved service slot, never in a player seat.
	if _, ok := mt.commands[SvcSlot]; !ok {
		t.Fatalf("command not stored under %s: %#v", SvcSlot, mt.commands)
	}
	for k := range mt.commands {
		if k != SvcSlot {
			t.Errorf("service wrote into a player slot %q", k)
		}
	}
	// One Step consumes it, exactly like a human seat's command.
	if _, err := m.Step(context.Background(), mt.ID); err != nil {
		t.Fatal(err)
	}
	if _, ok := mt.commands[SvcSlot]; ok {
		t.Error("service commands must be one-shot per tick, not replayed")
	}
}

// The observe push must reach the service every tick, carry the token it needs
// to act, and tell it where to post.
func TestBridgeObservePushesEveryTick(t *testing.T) {
	m, mt := newBridgeMatch(t, bridgeLinks()...)

	var mu sync.Mutex
	var got []map[string]any
	ready := make(chan struct{}, 8)
	m.SetBridge(BridgeConfig{GatewayURL: "http://127.0.0.1:6363"})
	m.SetObserver(func(gname, service, matchID, token string, payload map[string]any) {
		mu.Lock()
		got = append(got, payload)
		mu.Unlock()
		ready <- struct{}{}
	})
	// Read the token up front: RunHeadless unloads the match, after which the
	// manager no longer resolves it.
	tok := m.ServiceTokens(mt.ID)["pm"]
	if _, err := m.RunHeadless(context.Background(), mt.ID); err != nil {
		t.Fatal(err)
	}
	deadline := time.After(2 * time.Second)
	want := mt.Options.MaxTicks
	for i := 0; i < want; i++ {
		select {
		case <-ready:
		case <-deadline:
			t.Fatalf("only %d/%d observe pushes arrived", i, want)
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if len(got) < want {
		t.Fatalf("observe fired %d times, want at least one per tick (%d)", len(got), want)
	}
	p := got[0]
	if p["token"] != tok {
		t.Errorf("observe payload token = %v, want the match token", p["token"])
	}
	if p["match_id"] != mt.ID || p["service"] != "pm" {
		t.Errorf("observe payload does not identify the match/service: %#v", p)
	}
	if p["gateway"] != "http://127.0.0.1:6363" {
		t.Errorf("observe payload must tell the service where to post back, got %v", p["gateway"])
	}
	if p["ops_path"] != OpsPath(mt.ID) {
		t.Errorf("ops_path = %v", p["ops_path"])
	}
	if p["state"] == nil {
		t.Error("observe payload carries no state")
	}
}

// "digest" must stay bounded; "full" hands over the whole board.
func TestBridgeObserveModes(t *testing.T) {
	state := map[string]any{"tick": 3, "depth": 2, "gold": 9, "secret_blob": "x"}
	for i := 0; i < 40; i++ {
		state["junk"] = i
	}
	d := observeState("digest", state).(map[string]any)
	if _, ok := d["secret_blob"]; ok {
		t.Error("digest must not copy arbitrary state keys")
	}
	if d["depth"] != 2 {
		t.Errorf("digest dropped a whitelisted key: %#v", d)
	}
	full := observeState("full", state).(map[string]any)
	if full["secret_blob"] != "x" {
		t.Error(`observe "full" must hand over the whole state`)
	}
}

// A notice reaches watchers as an out-of-band event and never enters the
// state — otherwise a chatty backend could desync a deterministic replay.
func TestBridgeNotifyIsOutOfBand(t *testing.T) {
	m, mt := newBridgeMatch(t, bridgeLinks()...)
	tok := m.ServiceTokens(mt.ID)["pm"]
	ch, unsub, err := m.Subscribe(mt.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer unsub()
	<-ch // initial snapshot

	if err := m.NotifyService(mt.ID, tok, map[string]any{"text": "守主在第 5 层"}); err != nil {
		t.Fatal(err)
	}
	select {
	case ev := <-ch:
		if ev.Name != "notice" {
			t.Fatalf("event name = %q, want notice", ev.Name)
		}
		n, ok := ev.Notice.(map[string]any)
		if !ok || n["text"] != "守主在第 5 层" {
			t.Fatalf("notice payload lost: %#v", ev.Notice)
		}
	case <-time.After(time.Second):
		t.Fatal("no notice delivered")
	}
	// A second step must not carry the notice into the state.
	if _, err := m.Step(context.Background(), mt.ID); err != nil {
		t.Fatal(err)
	}
	mt.mu.Lock()
	_, leaked := mt.state["notice"]
	mt.mu.Unlock()
	if leaked {
		t.Error("a notice must not be written into the match state")
	}
}

func TestBridgeNotifyRequiresPermission(t *testing.T) {
	m, mt := newBridgeMatch(t, ServiceLink{Name: "quiet", Access: MatchAccess{Observe: "digest"}})
	tok := m.ServiceTokens(mt.ID)["quiet"]
	if err := m.NotifyService(mt.ID, tok, map[string]any{"x": 1}); err == nil {
		t.Error("a service without notify must be refused")
	}
	// It may still act through its declared channels.
	if err := m.PostServiceCommands(mt.ID, tok, map[string]any{"gm": map[string]any{}}); err == nil {
		t.Error("a service with no declared channels must not post")
	}
}

func TestLinksFromAccessSkipsSilentServices(t *testing.T) {
	links := LinksFromAccess(
		[]string{"a", "b", "c"},
		map[string]MatchAccess{
			"a": {Observe: "full", Commands: []string{"gm"}},
			"b": {},
			// Not declared at all.
		})
	if len(links) != 1 || links[0].Name != "a" {
		t.Fatalf("only a service that asked for something binds, got %+v", links)
	}
}
