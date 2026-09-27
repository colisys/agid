// Defensive RTS brain: same decide contract, conservative posture.
// Prefers defend/tech, only rushes on overwhelming advantage.

var ROUTES = {
  "rush": "Attack now with everything (early all-in)",
  "defend": "Pull back, repair, hold the ramp",
  "expand": "Take a new base while safe",
  "harass": "Fast units poke enemy workers, then retreat",
  "tech": "Stay safe and tech up"
};

function decide(args) {
  var snapshot = args.snapshot, memory = args.memory;
  memory = memory || { last_intent: null, tick_count: 0 };
  var tick = snapshot.tick || {};
  var me = snapshot.p0 || snapshot;
  var foe = snapshot.p1 || {};

  var state = {
    goal: "Win the game without losing the base",
    user_input: JSON.stringify({ t: tick.t || snapshot.tick, army: me.army, base_hp: me.base_hp, enemy: foe.enemy, push: foe.push }),
    context: { tick: tick, me: me, foe: foe },
    routes: Object.keys(ROUTES)
  };
  var picked = host.intent(state);
  var route = picked.route;

  if ((me.base_hp || 1000) < 400 && route !== "defend") route = "defend";
  if (route === "rush" && (me.army || 0) < (foe.enemy || 0) * 1.5) route = "tech";
  if ((picked.confidence || 0) < 0.4) route = memory.last_intent || "defend";

  memory.last_intent = route;
  memory.tick_count = (memory.tick_count || 0) + 1;

  var build = { rush: ["marine", "marine", "medic"], defend: ["bunker", "scv_repair"],
    expand: ["command_center", "scv"], harass: ["vulture"], tech: ["academy", "siege_tank"] }[route] || [];
  if ((tick.supply_used || 0) >= (tick.supply_cap || 0)) build = build.concat(["supply_depot"]);

  return {
    commands: { strategy: route, build: build },
    memory: memory
  };
}
