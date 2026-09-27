package game

import (
	"context"
	"encoding/json"
	"fmt"

	"gateway/internal/jsflow"
)

func decodeOut(s string) (map[string]any, error) {
	var m map[string]any
	if err := json.Unmarshal([]byte(s), &m); err != nil {
		return nil, err
	}
	return m, nil
}

func rulesHost(m *Manager, mt *Match) jsflow.Host {
	if m.hosts != nil {
		return jsflow.Host{Log: m.hosts(mt.ID, mt.Game, "rules").Log}
	}
	return jsflow.Host{}
}

// capsOf returns the fail-closed capability snapshot for one brain.
func capsOf(mt *Match, name string) Caps {
	mt.mu.Lock()
	defer mt.mu.Unlock()
	return mt.brainCaps[name]
}

// grantCaps zeroes out every host capability the brain did not declare in the
// pack manifest, and wraps SVC with the per-service allowlist. Nil funcs make
// the JS side throw "not available" (same pattern as the rules seat).
func grantCaps(host jsflow.Host, c Caps) jsflow.Host {
	if !c.LLM {
		host.LLM = nil
	}
	if !c.Jev {
		host.Intent = nil
	}
	switch {
	case host.SVC == nil || len(c.SVC) == 0:
		host.SVC = nil
	default:
		allow, inner := c.SVC, host.SVC
		host.SVC = func(name, path string, body any) (any, error) {
			for _, a := range allow {
				if a == name {
					return inner(name, path, body)
				}
			}
			return nil, fmt.Errorf("svc %q not permitted for this brain", name)
		}
	}
	return host
}

func rulesScriptOf(mt *Match) string {
	mt.mu.Lock()
	defer mt.mu.Unlock()
	return mt.rulesScript
}

// callRulesTick runs rules.tick(state, commands) -> {state, events, wait?}.
// wait=true means the rules asked to skip this tick (e.g. a human seat has
// no command yet): the caller must not advance state or count a tick.
func (m *Manager) callRulesTick(ctx context.Context, mt *Match, cmds map[string]any) (next map[string]any, events []any, wait bool, err error) {
	mt.mu.Lock()
	state := mt.state
	mt.mu.Unlock()
	out, err := m.pool.CallJSON(ctx, rulesScriptOf(mt), "tick",
		map[string]any{"state": state, "commands": cmds}, rulesHost(m, mt))
	if err != nil {
		return nil, nil, false, fmt.Errorf("rules.tick: %w", err)
	}
	mm, err := decodeOut(out)
	if err != nil {
		return nil, nil, false, fmt.Errorf("rules.tick: bad json: %w", err)
	}
	if b, ok := mm["wait"].(bool); ok && b {
		var ev []any
		if evv, ok := mm["events"].([]any); ok {
			ev = evv
		}
		return nil, ev, true, nil
	}
	next, _ = mm["state"].(map[string]any)
	if next == nil {
		return nil, nil, false, fmt.Errorf("rules.tick: missing state")
	}
	if ev, ok := mm["events"].([]any); ok {
		events = ev
	}
	return next, events, false, nil
}

// callRulesSnapshot runs rules.snapshot(state, player).
func (m *Manager) callRulesSnapshot(ctx context.Context, mt *Match, player string) (map[string]any, error) {
	mt.mu.Lock()
	state := mt.state
	mt.mu.Unlock()
	out, err := m.pool.CallJSON(ctx, rulesScriptOf(mt), "snapshot",
		map[string]any{"state": state, "player": player}, rulesHost(m, mt))
	if err != nil {
		return nil, fmt.Errorf("rules.snapshot: %w", err)
	}
	mm, err := decodeOut(out)
	if err != nil {
		return nil, fmt.Errorf("rules.snapshot: bad json: %w", err)
	}
	return mm, nil
}

// callRulesOver runs rules.over(state).
// The script returns {over: truthy, ...result} or {over: null}.
// Returns done=false when the game continues.
func (m *Manager) callRulesOver(ctx context.Context, mt *Match, state map[string]any) (bool, map[string]any) {
	out, err := m.pool.CallJSON(ctx, rulesScriptOf(mt), "over",
		map[string]any{"state": state}, rulesHost(m, mt))
	if err != nil {
		return false, nil
	}
	mm, err := decodeOut(out)
	if err != nil {
		return false, nil
	}
	over, ok := mm["over"]
	if !ok || over == nil {
		return false, nil
	}
	if res, ok := mm["result"].(map[string]any); ok {
		return true, res
	}
	if res, ok := over.(map[string]any); ok {
		return true, res
	}
	return true, map[string]any{}
}

// callRulesNewMatch runs rules.newmatch(args) when present.
func (m *Manager) callRulesNewMatch(ctx context.Context, mt *Match, args map[string]any) map[string]any {
	out, err := m.pool.CallJSON(ctx, rulesScriptOf(mt), "newmatch", args, rulesHost(m, mt))
	if err != nil {
		return nil
	}
	mm, err := decodeOut(out)
	if err != nil {
		return nil
	}
	if st, ok := mm["state"].(map[string]any); ok {
		return st
	}
	return nil
}

// runBrain runs brains.<name>.decide(snapshot, memory).
func (m *Manager) runBrain(ctx context.Context, mt *Match, slot string, snapshot, memory any) (map[string]any, any, error) {
	idx := -1
	for i := range mt.Options.Players {
		if itoa(i) == slot[1:] {
			idx = i
			break
		}
	}
	if idx < 0 || mt.Options.Players[idx].Brain == nil {
		return nil, memory, fmt.Errorf("slot %s is not a brain", slot)
	}
	name := mt.Options.Players[idx].Brain.Brain
	mt.mu.Lock()
	ver := mt.brainVer[name]
	mt.mu.Unlock()
	script, _, err := m.store.Brain(mt.Game, name, ver)
	if err != nil {
		return nil, memory, err
	}
	var host jsflow.Host
	if m.hosts != nil {
		host = grantCaps(m.hosts(mt.ID, mt.Game, slot), capsOf(mt, name))
	}
	out, err := m.pool.CallJSON(ctx, script, "decide",
		map[string]any{"snapshot": snapshot, "memory": memory}, host)
	if err != nil {
		return nil, memory, fmt.Errorf("brain %s: %w", name, err)
	}
	mm, err := decodeOut(out)
	if err != nil {
		return nil, memory, fmt.Errorf("brain %s: bad json: %w", name, err)
	}
	cmds, _ := mm["commands"].(map[string]any)
	if cmds == nil {
		cmds = map[string]any{}
	}
	return cmds, mm["memory"], nil
}

func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	var b [8]byte
	p := len(b)
	for i > 0 {
		p--
		b[p] = byte('0' + i%10)
		i /= 10
	}
	return string(b[p:])
}
