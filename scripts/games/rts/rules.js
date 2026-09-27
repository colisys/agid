// RTS rules pack (ported from scripts/rts_sim.py combat resolution).
//
// Required exports: newmatch(args), tick(state, commands),
// snapshot(state, player), over(state). Numbers live in tuning.json;
// TUNING below is inlined for single-file hot-swap.

var TUNING = {
  income_per_tick: 60,
  army_growth: 12,
  base_regen_defend: 15,
  push_chip_vs_base: 25,
  push_chip_vs_army_div: 6,
  rush_army_loss_div: 3,
  rush_enemy_half_div: 2,
  base_max: 1000
};

function newmatch(args) {
  return { state: {
    seed: args.seed || 0, tick: 0,
    minerals: 200, supply_used: 12, supply_cap: 18,
    p0: { base_hp: 1000, army: 40 },
    p1: { base_hp: 1000, army: 40, enemy: 30, push: false, expanding: false }
  } };
}

// Opponent script for p1 slot when driven by scripted_opponent brain is
// handled brain-side; tick() only resolves combat from commands.
function tick(args) {
  var state = args.state, commands = args.commands || {};
  var T = TUNING;
  var events = [];
  var s = JSON.parse(JSON.stringify(state));
  s.tick = (s.tick || 0) + 1;
  s.minerals = (s.minerals || 0) + T.income_per_tick;

  var c0 = commands.p0 || {};
  var route = c0.strategy || "hold";
  var me = s.p0, foe = s.p1;

  if (route === "rush" || route === "attack") {
    var dmg = Math.max(0, me.army - Math.floor((foe.enemy || 0) / T.rush_enemy_half_div));
    me.army = Math.max(0, me.army - Math.floor((foe.enemy || 0) / T.rush_army_loss_div));
    if (dmg <= 0) { me.base_hp = Math.max(0, me.base_hp - 5); }
    events.push({ type: "attack", by: "p0", route: route });
  } else if (route === "defend") {
    me.base_hp = Math.min(T.base_max, me.base_hp + T.base_regen_defend);
    if (foe.push) {
      me.army = Math.max(0, me.army - Math.floor((foe.enemy || 0) / T.push_chip_vs_army_div));
      events.push({ type: "defense", under_push: true });
    }
  } else {
    me.army += T.army_growth;
    if (foe.push) {
      me.base_hp = Math.max(0, me.base_hp - T.push_chip_vs_base);
      events.push({ type: "chip", dmg: T.push_chip_vs_base });
    }
  }

  // p1 scripted pressure track (drives the demo arc; a real second brain
  // would overwrite foe fields via its own commands instead).
  var t = s.tick;
  if (t <= 6) { foe.enemy = 30 + t * 8; foe.push = t >= 4; foe.expanding = false; }
  else if (t <= 15) { foe.enemy = 70; foe.push = false; foe.expanding = true; }
  else { foe.enemy = 70 + (t - 15) * 12; foe.push = true; foe.expanding = false; }

  return { state: s, events: events };
}

function snapshot(args) {
  var state = args.state, player = args.player;
  // v1: full information for every player (fog reserved).
  return JSON.parse(JSON.stringify(state));
}

function over(args) {
  var state = args.state;
  if ((state.p0 && state.p0.base_hp) <= 0) {
    return { over: true, result: { winner: "p1", reason: "base destroyed" } };
  }
  if ((state.p1 && state.p1.base_hp) <= 0) {
    return { over: true, result: { winner: "p0", reason: "base destroyed" } };
  }
  return { over: null };
}
