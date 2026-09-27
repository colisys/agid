package game

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"gateway/internal/jsflow"
)

func testStore(t *testing.T) *DiskStore {
	t.Helper()
	dir := t.TempDir()
	gdir := filepath.Join(dir, "counter")
	if err := os.MkdirAll(filepath.Join(gdir, "brains"), 0o755); err != nil {
		t.Fatal(err)
	}
	rules := `
function newmatch(args) { return { state: { n: 0 } }; }
function tick(args) {
  var commands = args.commands || {};
  var inc = (commands.p0 && commands.p0.inc) || 1;
  var n = args.state.n + inc;
  return { state: { n: n }, events: [{type:"ticked", n: n}] };
}
function snapshot(args) { return { n: args.state.n }; }
function over(args) {
  if (args.state.n >= 5) return { over: true, result: { winner: "p0", reason: "reached 5" } };
  return { over: null };
}
`
	brain := `
function decide(args) {
  var memory = args.memory || { calls: 0 };
  memory.calls = memory.calls + 1;
  return { commands: { inc: 1 }, memory: memory };
}
`
	if err := os.WriteFile(filepath.Join(gdir, "rules.js"), []byte(rules), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(gdir, "brains", "adder.js"), []byte(brain), 0o644); err != nil {
		t.Fatal(err)
	}
	return NewDiskStore([]string{dir}, 5)
}

func testManager(t *testing.T) (*Manager, *DiskStore) {
	t.Helper()
	pool := jsflow.NewPool(1)
	t.Cleanup(pool.Close)
	hosts := func(matchID, _, player string) jsflow.Host {
		return jsflow.Host{Log: func(string) {}}
	}
	st := testStore(t)
	return NewManager(st, pool, hosts, nil, 10, 2000), st
}

func TestHeadlessDeterministic(t *testing.T) {
	m, _ := testManager(t)
	ctx := context.Background()
	mt, err := m.Create(ctx, CreateOptions{
		Game:     "counter",
		Players:  []PlayerSpec{{Brain: &BrainPlayer{Brain: "adder"}}},
		Headless: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	rep, err := m.RunHeadless(ctx, mt.ID)
	if err != nil {
		t.Fatal(err)
	}
	if rep.Winner != "p0" || rep.Ticks != 5 {
		t.Fatalf("want p0 win in 5 ticks, got %+v", rep)
	}
	if len(rep.Replay) != 5 {
		t.Fatalf("want 5 replay ticks, got %d", len(rep.Replay))
	}
	// Session unloaded but report retained.
	if _, ok := m.Get(mt.ID); ok {
		t.Fatal("match should be unloaded after finish")
	}
	if _, ok := m.Report(mt.ID); !ok {
		t.Fatal("report should be retained")
	}
	if len(m.List()) != 0 {
		t.Fatal("list should be empty after unload")
	}
}

func TestMemoryRoundTrip(t *testing.T) {
	m, _ := testManager(t)
	ctx := context.Background()
	mt, err := m.Create(ctx, CreateOptions{
		Game:     "counter",
		Players:  []PlayerSpec{{Brain: &BrainPlayer{Brain: "adder"}}},
		Headless: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	rep, err := m.RunHeadless(ctx, mt.ID)
	if err != nil {
		t.Fatal(err)
	}
	last := rep.Replay[len(rep.Replay)-1]
	_ = last
	// Memory accumulates calls across ticks: verify via a fresh 2-step run.
	m2, _ := testManager(t)
	mt2, err := m2.Create(ctx, CreateOptions{Game: "counter", Players: []PlayerSpec{{Brain: &BrainPlayer{Brain: "adder"}}}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := m2.Step(ctx, mt2.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := m2.Step(ctx, mt2.ID); err != nil {
		t.Fatal(err)
	}
	mt2obj, _ := m2.Get(mt2.ID)
	mt2obj.mu.Lock()
	mem := mt2obj.memories["p0"]
	mt2obj.mu.Unlock()
	mm, ok := mem.(map[string]any)
	if !ok {
		t.Fatalf("want memory map, got %T", mem)
	}
	if mm["calls"] != float64(2) {
		t.Fatalf("want 2 brain calls in memory, got %v", mm["calls"])
	}
}

func TestVersionPinning(t *testing.T) {
	m, st := testManager(t)
	// Upload candidate brain version v2 that increments by 10.
	v2 := `
function decide(args) { return { commands: { inc: 10 }, memory: {} }; }
`
	if err := st.UploadBrain("counter", "adder", "v2", v2); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	// Stable still v1 behavior.
	mt, err := m.Create(ctx, CreateOptions{Game: "counter", Players: []PlayerSpec{{Brain: &BrainPlayer{Brain: "adder"}}}, Headless: true})
	if err != nil {
		t.Fatal(err)
	}
	rep, err := m.RunHeadless(ctx, mt.ID)
	if err != nil {
		t.Fatal(err)
	}
	if rep.Ticks != 5 {
		t.Fatalf("stable should still take 5 ticks, got %d", rep.Ticks)
	}
	// Explicit v2 finishes in 1 tick.
	mt2, err := m.Create(ctx, CreateOptions{Game: "counter", Players: []PlayerSpec{{Brain: &BrainPlayer{Brain: "adder", Version: "v2"}}}, Headless: true})
	if err != nil {
		t.Fatal(err)
	}
	rep2, err := m.RunHeadless(ctx, mt2.ID)
	if err != nil {
		t.Fatal(err)
	}
	if rep2.Ticks != 1 {
		t.Fatalf("v2 should finish in 1 tick, got %d", rep2.Ticks)
	}
	// Promote v2 -> new matches use it.
	if err := st.Promote("brain", "counter", "adder", "v2"); err != nil {
		t.Fatal(err)
	}
	mt3, err := m.Create(ctx, CreateOptions{Game: "counter", Players: []PlayerSpec{{Brain: &BrainPlayer{Brain: "adder"}}}, Headless: true})
	if err != nil {
		t.Fatal(err)
	}
	rep3, err := m.RunHeadless(ctx, mt3.ID)
	if err != nil {
		t.Fatal(err)
	}
	if rep3.Ticks != 1 {
		t.Fatalf("after promote, want 1 tick, got %d", rep3.Ticks)
	}
}

// waitStore serves a "waiter" game whose rules park until the seat whose turn
// it is posts a command — the shape of a human-vs-human match.
func waitStore(t *testing.T) *DiskStore {
	t.Helper()
	dir := t.TempDir()
	gdir := filepath.Join(dir, "waiter")
	if err := os.MkdirAll(gdir, 0o755); err != nil {
		t.Fatal(err)
	}
	rules := `
function newmatch(args) { return { state: { turn: "p0", moves: 0 } }; }
function tick(args) {
  var cmds = args.commands || {};
  var mv = cmds[args.state.turn] || {};
  if (typeof mv.cell !== "number") { return { wait: true, state: args.state, events: [] }; }
  var next = { turn: args.state.turn === "p0" ? "p1" : "p0", moves: args.state.moves + 1 };
  return { state: next, events: [{ type: "move", cell: mv.cell }] };
}
function snapshot(args) { return JSON.parse(JSON.stringify(args.state)); }
function over(args) { return { over: null }; }
`
	if err := os.WriteFile(filepath.Join(gdir, "rules.js"), []byte(rules), 0o644); err != nil {
		t.Fatal(err)
	}
	return NewDiskStore([]string{dir}, 5)
}

// A match sitting on a human's turn must stay completely silent — no heartbeat
// spam, no ticks burned — and a posted command must wake it for one real tick.
func TestWaitingMatchStaysQuietUntilCommand(t *testing.T) {
	pool := jsflow.NewPool(1)
	t.Cleanup(pool.Close)
	m := NewManager(waitStore(t), pool,
		func(matchID, _, player string) jsflow.Host { return jsflow.Host{Log: func(string) {}} },
		nil, 10, 2000)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	mt, err := m.Create(ctx, CreateOptions{
		Game:    "waiter",
		Players: []PlayerSpec{{Human: true}, {Human: true}},
		TickMs:  10,
	})
	if err != nil {
		t.Fatal(err)
	}
	ch, unsub, err := m.Subscribe(mt.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer unsub()

	// Subscribing hands over the current snapshot up front, otherwise a client
	// would have no board to render (and nothing to click) while it waits.
	first := recvMsg(t, ch)
	if first.State == nil || first.State["turn"] != "p0" {
		t.Fatalf("want initial state with turn p0, got %+v", first)
	}
	if first.Tick != 0 {
		t.Fatalf("want initial tick 0, got %d", first.Tick)
	}

	runDone := make(chan error, 1)
	go func() { runDone <- m.Run(ctx, mt.ID, 10*time.Millisecond) }()

	// Nobody has acted: the push channel must stay quiet.
	assertQuiet(t, ch)

	if err := m.PostCommands(mt.ID, "p0", map[string]any{"cell": 1}); err != nil {
		t.Fatal(err)
	}
	msg := recvMsg(t, ch)
	if msg.State == nil || msg.State["moves"] != float64(1) {
		t.Fatalf("want exactly one applied move, got %+v", msg)
	}
	if len(msg.Events) != 1 {
		t.Fatalf("want the move event, got %+v", msg.Events)
	}

	// Now parked on p1: quiet again, with no further state pushed.
	assertQuiet(t, ch)

	// Unloading must release the parked loop instead of leaking it.
	if _, err := m.Stop(mt.ID, "test"); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-runDone:
		if err != nil {
			t.Fatalf("Run returned error: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("Run stayed parked after the match was unloaded")
	}
}

func recvMsg(t *testing.T, ch chan Event) SnapshotMsg {
	t.Helper()
	select {
	case ev, ok := <-ch:
		if !ok {
			t.Fatal("channel closed")
		}
		return ev.SnapshotMsg
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for a push")
	}
	return SnapshotMsg{}
}

// assertQuiet fails if anything is pushed. The window is many tick intervals
// wide, so a fixed-rate poller cannot slip through unnoticed.
func assertQuiet(t *testing.T, ch chan Event) {
	t.Helper()
	select {
	case ev := <-ch:
		t.Fatalf("idle match must not push, got %+v", ev)
	case <-time.After(150 * time.Millisecond):
	}
}

// Headless matches have no external seats, so a wait would never resolve:
// RunHeadless must report it instead of spinning forever.
func TestHeadlessWaitFails(t *testing.T) {
	pool := jsflow.NewPool(1)
	t.Cleanup(pool.Close)
	m := NewManager(waitStore(t), pool,
		func(matchID, _, player string) jsflow.Host { return jsflow.Host{Log: func(string) {}} },
		nil, 10, 2000)
	mt, err := m.Create(context.Background(), CreateOptions{
		Game:    "waiter",
		Players: []PlayerSpec{{Human: true}, {Human: true}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := m.RunHeadless(context.Background(), mt.ID); err == nil {
		t.Fatal("want an error when headless rules wait for external input")
	}
}
