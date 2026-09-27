#!/usr/bin/env python3
"""Tic-tac-toe demo: upload the pack via admin, run a headless AI-vs-AI match.

Usage:
  python3 examples/tictactoe/demo.py [--base http://localhost:8080]
                                     [--token ADMIN] [--x blocker] [--o random]
"""
import argparse
import json
import os
import sys
import urllib.request
import urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))


def req(base, method, path, body=None, token=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(base + path, data=data, method=method,
                               headers={"Content-Type": "application/json"})
    if token:
        r.add_header("X-Admin-Token", token)
    try:
        with urllib.request.urlopen(r, timeout=30) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as e:
        print(f"{method} {path} -> {e.code}: {e.read().decode()[:200]}", file=sys.stderr)
        raise


def read(name):
    with open(os.path.join(HERE, name)) as f:
        return f.read()


def ensure_pack(base, token, brains):
    try:
        cur = req(base, "GET", "/admin/rules/tictactoe", token=token)
        stable = cur.get("version", "")
    except urllib.error.HTTPError:
        stable = ""
    if not stable:
        req(base, "PUT", "/admin/rules/tictactoe",
            {"game": "tictactoe", "version": "v1", "script": read("rules.js")}, token)
        req(base, "POST", "/admin/games/promote",
            {"kind": "rules", "game": "tictactoe", "version": "v1"}, token)
        print("uploaded rules v1 + promoted")
    for brain in brains:
        try:
            b = req(base, "GET", f"/admin/brains/{brain}?game=tictactoe", token=token)
            has = bool(b.get("version", ""))
        except urllib.error.HTTPError:
            has = False
        if not has:
            req(base, "PUT", f"/admin/brains/{brain}",
                {"game": "tictactoe", "name": brain, "version": "v1",
                 "script": read(f"brains/{brain}.js")}, token)
            req(base, "POST", "/admin/games/promote",
                {"kind": "brain", "game": "tictactoe", "name": brain, "version": "v1"}, token)
            print(f"uploaded brain {brain} v1 + promoted")


def render(board):
    return "\n---------\n".join(
        " | ".join(c or " " for c in board[i:i + 3]) for i in (0, 3, 6))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://localhost:8080")
    ap.add_argument("--token", default=os.environ.get("ADMIN_TOKEN", ""))
    ap.add_argument("--x", default="blocker")
    ap.add_argument("--o", default="random")
    args = ap.parse_args()

    ensure_pack(args.base, args.token or None, {args.x, args.o})

    m = req(args.base, "POST", "/v1/games", {
        "game": "tictactoe",
        "players": [{"brain": {"brain": args.x}}, {"brain": {"brain": args.o}}],
        "headless": True, "max_ticks": 9,
    }, args.token or None)
    rep = m["report"]
    print("match:", m.get("match_id", rep.get("match_id")), "ticks:", rep["ticks"])
    for t in rep["replay"]:
        for e in t.get("events", []):
            if e.get("type") == "move":
                print(f"tick {t['tick']}: {e['player']} plays {e['mark']} at {e['cell']}")
    final = rep["replay"][-1]["state"]
    print()
    print(render(final["board"]))
    print("winner:", final.get("winner") or "draw")


if __name__ == "__main__":
    sys.exit(main())
