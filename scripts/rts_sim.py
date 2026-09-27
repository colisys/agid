#!/usr/bin/env python3
"""RTS demo harness: a scripted opponent vs the gateway AI.

Each tick sends the game snapshot to POST /v1/execute; the gateway's
Jev intent selector picks the strategy (rush/defend/expand/harass/tech),
the QuickJS flow attaches build orders + hard overrides, and the orders
mutate the local game state.

Usage:
  python3 scripts/rts_sim.py [--base http://localhost:6363] [--ticks 30]
                             [--commentary] [--key TOKEN]
"""
import argparse
import json
import sys
import urllib.request

ROUTES = {
    "rush": {
        "desc": "Attack now with everything (early all-in)",
        "orders": {"build": ["marine", "marine", "medic"], "move": "enemy_base", "attack": True},
    },
    "defend": {
        "desc": "Pull back, repair, hold the ramp",
        "orders": {"build": ["bunker", "scv_repair"], "move": "own_ramp", "attack": False},
    },
    "expand": {
        "desc": "Take a new base while safe",
        "orders": {"build": ["command_center", "scv", "scv"], "move": "natural", "attack": False},
    },
    "harass": {
        "desc": "Fast units poke enemy workers, then retreat",
        "orders": {"build": ["vulture"], "move": "enemy_mineral_line", "attack": "hit_and_run"},
    },
    "tech": {
        "desc": "Stay safe and tech up",
        "orders": {"build": ["academy", "siege_tank"], "move": "own_base", "attack": False},
    },
}

# Scripted opponent: rush ticks 1-6, expand 7-15, all-in push 16+.
def opponent(t):
    if t <= 6:
        return {"enemy": 30 + t * 8, "push": t >= 4, "expanding": False}
    if t <= 15:
        return {"enemy": 70, "push": False, "expanding": True}
    return {"enemy": 70 + (t - 15) * 12, "push": True, "expanding": False}


def post(base, path, body, key):
    data = json.dumps(body).encode()
    req = urllib.request.Request(base + path, data=data,
                                 headers={"Content-Type": "application/json"})
    if key:
        req.add_header("Authorization", "Bearer " + key)
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://localhost:6363")
    ap.add_argument("--ticks", type=int, default=24)
    ap.add_argument("--commentary", action="store_true",
                    help="ask the LLM for a caster line each tick")
    ap.add_argument("--key", default="")
    a = ap.parse_args()

    state = {"t": 0, "minerals": 200, "supply_used": 12, "supply_cap": 18,
             "base_hp": 1000, "army": 40}
    print(f"{'tick':>4} {'route':<8} {'conf':>5} {'army':>4} {'enemy':>5} "
          f"{'base':>4} {'orders':<42} notes")
    for t in range(1, a.ticks + 1):
        opp = opponent(t)
        state.update({"t": t, "enemy": opp["enemy"], "enemy_push": opp["push"],
                      "enemy_expanding": opp["expanding"],
                      "harass_window": 7 <= t <= 14,
                      "minerals": state["minerals"] + 60})
        try:
            res = post(a.base, "/v1/execute", {
                "goal": "Win the game",
                "context": {"tick": dict(state),
                            "routes_meta": {k: {"orders": v["orders"]} for k, v in ROUTES.items()},
                            "llm_commentary": a.commentary},
                "routes": {k: v["desc"] for k, v in ROUTES.items()},
            }, a.key)
        except Exception as e:
            print(f"tick {t}: gateway error: {e}", file=sys.stderr)
            return 1
        out = res.get("output", {}) or {}
        orders = out.get("orders", {})
        notes = "; ".join(out.get("notes", []))
        route = res.get("verdict", {}).get("Route", "?")
        conf = res.get("verdict", {}).get("Confidence", 0)

        # Resolve combat in the simulator (not the gateway).
        if route == "rush" or (orders.get("attack") is True and route != "defend"):
            dmg = max(0, state["army"] - opp["enemy"] // 2)
            state["army"] = max(0, state["army"] - opp["enemy"] // 3)
            state["base_hp"] = max(0, state["base_hp"] - (5 if dmg <= 0 else 0))
        elif route == "defend":
            state["base_hp"] = min(1000, state["base_hp"] + 15)
            state["army"] = max(0, state["army"] - opp["enemy"] // 6 if opp["push"] else state["army"])
        else:
            state["army"] += 12
            if opp["push"]:
                state["base_hp"] = max(0, state["base_hp"] - 25)
        if res.get("verdict", {}).get("Action") != "allow":
            state["army"] += 0  # escalated/confirm: hold position this tick

        builds = ",".join(orders.get("build", [])[:3])
        line = (f"{t:>4} {route:<8} {conf:>5.2f} {state['army']:>4} "
                f"{opp['enemy']:>5} {state['base_hp']:>4} "
                f"{orders.get('move','?') + '/' + builds:<42} {notes}")
        if out.get("commentary"):
            line += f"  |  {out['commentary']}"
        print(line)
        if state["base_hp"] <= 0:
            print("Base destroyed. Game over.")
            return 0
    print(f"Survived {a.ticks} ticks with base {state['base_hp']}/1000, army {state['army']}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
