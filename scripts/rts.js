// RTS strategy flow (demo).
//
// Usage: gwadmin script set scripts/rts.js
//
// input.context.tick = {
//   t: tick number,
//   minerals: banked resources,
//   supply_used / supply_cap: population,
//   base_hp: base hit points (0-1000),
//   army: attacker strength (approx power),
//   enemy: spotted enemy strength near base,
//   enemy_push: true if enemy units are advancing on the base,
//   enemy_expanding: true if enemy is taking a new base,
//   harass_window: true if our fast units can hit enemy workers now.
// }
//
// Routes come from the request's routes map; each route name may carry a
// compact "orders" JSON object attached in input.routes_meta. Jev only picks
// which strategy — the numbers below (build order, thresholds) are code, not
// model output.

function orchestrate(input) {
  var steps = [];
  var state = {
    goal: input.goal || "Win the game",
    user_input: JSON.stringify((input.context || {}).tick || {}),
    context: input.context || {},
    routes: Object.keys(input.routes || {}),
  };
  var picked = host.intent(state);
  steps.push({ kind: "intent", detail: picked.route + " (" + picked.confidence.toFixed(2) + ")" });

  var route = picked.route;
  var tick = ((input.context || {}).tick) || {};
  var meta = ((input.context || {}).routes_meta || {})[route] || {};
  var orders = meta.orders || describeFallback(route);
  var notes = [];

  // Hard overrides: code owns the invariants, never the model.
  // 1. Base near death -> always defend, whatever Jev said.
  if ((tick.base_hp || 1000) < 250 && route !== "defend") {
    notes.push("override: base_hp " + tick.base_hp + " < 250, forcing defend");
    route = "defend";
    orders = (((input.context || {}).routes_meta || {})["defend"] || {}).orders || orders;
  }
  // 2. Supply blocked -> build supply no matter the strategy.
  if ((tick.supply_used || 0) >= (tick.supply_cap || 0)) {
    notes.push("append: supply blocked, adding supply depot");
    orders.build = (orders.build || []).concat(["supply_depot"]);
  }

  var commentary = null;
  if ((input.context || {}).llm_commentary) {
    commentary = host.llm("", [{
      role: "user",
      content: "One short RTS caster line (<=20 words) for: route=" + route +
        ", tick=" + JSON.stringify(tick) +
        (notes.length ? ", note: " + notes.join("; ") : "")
    }]);
    steps.push({ kind: "llm", detail: "caster line" });
  }

  steps.push({ kind: "orders", detail: route });
  return {
    route: route,
    steps: steps,
    output: { orders: orders, notes: notes, commentary: commentary },
  };
}

function describeFallback(route) {
  return { build: [], move: route, attack: false };
}
