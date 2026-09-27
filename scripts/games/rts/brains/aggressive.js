// Aggressive RTS brain: lean on Jev for strategy, prefer attack postures,
// keep the same hard overrides as the rts.js demo (base_hp < 250 -> defend,
// supply blocked -> depot).
//
// Contract: decide(snapshot, memory) -> {commands, memory}
// commands.p0.strategy is consumed by rules.js tick().

var ROUTES = {
  "rush": "Attack now with everything (early all-in)",
  "defend": "Pull back, repair, hold the ramp",
  "expand": "Take a new base while safe",
  "harass": "Fast units poke enemy workers, then retreat",
  "tech": "Stay safe and tech up"
};

function decide(args) {
  var snapshot = args.snapshot, memory = args.memory;
  memory = memory || { last_intent: null, last_conf: 0, tick_count: 0 };
  var tick = snapshot.tick || {};
  var me = snapshot.p0 || snapshot;
  var foe = snapshot.p1 || {};

  var state = {
    goal: "Win the game",
    user_input: JSON.stringify({ t: tick.t || snapshot.tick, army: me.army, base_hp: me.base_hp, enemy: foe.enemy, push: foe.push }),
    context: { tick: tick, me: me, foe: foe },
    routes: Object.keys(ROUTES)
  };
  var picked = host.intent(state);
  var route = picked.route;
  var conf = picked.confidence || 0;

  // Hard overrides live in the brain (code, not model):
  if ((me.base_hp || 1000) < 250 && route !== "defend") route = "defend";
  if (conf < 0.4) route = memory.last_intent || "defend"; // low confidence: hold last posture

  memory.last_intent = route;
  memory.last_conf = conf;
  memory.tick_count = (memory.tick_count || 0) + 1;

  var build = { rush: ["marine", "marine", "medic"], defend: ["bunker", "scv_repair"],
    expand: ["command_center", "scv"], harass: ["vulture"], tech: ["academy", "siege_tank"] }[route] || [];
  if ((tick.supply_used || 0) >= (tick.supply_cap || 0)) build = build.concat(["supply_depot"]);

  return {
    commands: { strategy: route, build: build },
    memory: memory
  };
}
