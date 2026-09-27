#!/usr/bin/env python3
"""Dungeon demo: upload the pack via admin, run a headless AI-vs-monsters match.

Usage:
  python3 examples/dungeon/demo.py [--base http://localhost:8080]
                                   [--token ADMIN] [--seed 42]
                                   [--max-ticks 300] [--narrate]
                                   [--brain adventurer|sage] [--verify]

--brain sage 让 Jev（host.intent）接管事件房决策与精英战战术；无 API key 时
它会自动熔断降级到确定性启发式。--verify runs the same seed twice and
compares the replayed event lines, which is the "same seed + same commands ->
same outcome" check. sage 依赖模型输出，不具备确定性，与 --verify 互斥。
"""
import argparse
import json
import os
import sys
import urllib.request
import urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
GAME = "dungeon"

# Event kind -> 中文标签（打印用）
LABELS = {
    "enter": "入场", "order": "指令", "spawn": "遇怪", "hit": "命中",
    "guard": "格挡", "potion": "喝药", "flee": "逃跑", "descend": "下潜",
    "hurt": "受伤", "kill": "击杀", "levelup": "升级", "clear": "清层",
    "illegal": "无效", "win": "通关", "death": "阵亡",
    "item": "拾取", "equip": "换装", "event": "遭遇", "buy": "购买",
    "curse": "解咒", "trap": "陷阱",
}
QUIET = {"enter", "order"}  # 这些只在 verbose 时打印


def req(base, method, path, body=None, token=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(base + path, data=data, method=method,
                               headers={"Content-Type": "application/json"})
    if token:
        r.add_header("X-Admin-Token", token)
    try:
        with urllib.request.urlopen(r, timeout=120) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as e:
        print(f"{method} {path} -> {e.code}: {e.read().decode()[:200]}", file=sys.stderr)
        raise


def read(name):
    with open(os.path.join(HERE, name)) as f:
        return f.read()


def fetch_soft(base, path, token):
    """GET that returns None instead of raising (and without printing) when the
    gateway has no such pack entry."""
    r = urllib.request.Request(base + path, headers={})
    if token:
        r.add_header("X-Admin-Token", token)
    try:
        with urllib.request.urlopen(r, timeout=30) as resp:
            return json.load(resp)
    except (urllib.error.HTTPError, urllib.error.URLError):
        return None


def ensure_pack(base, token, brains):
    """Idempotent upload: a pack shipped in examples/dungeon/ is served straight
    from the gateway's games_dir (its stable version IS the on-disk file), so a
    normal dev checkout uploads nothing here. Only when the gateway has no such
    pack at all do we push it as v1 and promote it."""
    if fetch_soft(base, f"/admin/rules/{GAME}", token) is None:
        req(base, "PUT", f"/admin/rules/{GAME}",
            {"game": GAME, "version": "v1", "script": read("rules.js")}, token)
        req(base, "POST", "/admin/games/promote",
            {"kind": "rules", "game": GAME, "version": "v1"}, token)
        print("uploaded rules v1 + promoted")
    for brain in brains:
        if fetch_soft(base, f"/admin/brains/{brain}?game={GAME}", token) is None:
            req(base, "PUT", f"/admin/brains/{brain}",
                {"game": GAME, "name": brain, "version": "v1",
                 "script": read(f"brains/{brain}.js")}, token)
            req(base, "POST", "/admin/games/promote",
                {"kind": "brain", "game": GAME, "name": brain, "version": "v1"}, token)
            print(f"uploaded brain {brain} v1 + promoted")


def run_match(base, token, seed, max_ticks, narrate, brain="adventurer"):
    players = [{"brain": {"brain": brain}}]
    if narrate:
        players.append({"brain": {"brain": "narrator"}})
    m = req(base, "POST", "/v1/games", {
        "game": GAME, "players": players,
        "headless": True, "max_ticks": max_ticks, "seed": seed,
    }, token)
    return m["report"]


def event_lines(rep, verbose=False, with_flavor=True):
    """Deterministic projection of a report: no match_id, no timestamps."""
    out = []
    for t in rep["replay"]:
        for e in t.get("events", []):
            kind = e.get("kind") or e.get("type") or "?"
            if not verbose and kind in QUIET:
                continue
            flavor = f"「{e['flavor']}」" if (with_flavor and e.get("flavor")) else ""
            out.append(f"t{t['tick']:03d} [{LABELS.get(kind, kind)}] {e.get('text', '')}{flavor}")
    return out


def render(rep, verbose=False):
    for line in event_lines(rep, verbose):
        print(line)
    last = rep["replay"][-1]["state"] if rep["replay"] else {}
    hero = last.get("hero", {})
    # 旁白写在「事实行」上，最早的行可能已被日志环覆盖；这里打印最终快照里剩下的。
    flavors = [e for e in (last.get("log") or []) if e.get("flavor")]
    if flavors:
        print(f"\n旁白（{len(flavors)} 条，来自旁白脑席）:")
        for e in flavors:
            print(f"  t{e['tick']:03d} 「{e['flavor']}」  ← {e.get('text', '')}")
    print()
    print("-" * 34)
    print(f"层数 {last.get('depth')}   等级 {last.get('level')}   "
          f"体力 {hero.get('hp')}/{hero.get('hp_max')}   攻击 {hero.get('atk')}")
    print(f"经验 {last.get('xp')}/{last.get('xp_next')}   金币 {last.get('gold')}   "
          f"药水 {last.get('potions')}   击杀 {last.get('kills')}")
    eq = last.get("equip") or {}
    print("装备 " + "  ".join(
        f"{slot}={eq.get(slot) or '-'}" for slot in ("weapon", "armor", "trinket")))
    inv = last.get("inventory") or []
    if inv:
        print("背包 " + " ".join(inv))
    print(f"回合 {rep['ticks']}   winner={rep.get('winner') or '-'}   reason={rep.get('reason') or '-'}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://localhost:8080")
    ap.add_argument("--token", default=os.environ.get("ADMIN_TOKEN", ""))
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--max-ticks", type=int, default=300)
    ap.add_argument("--narrate", action="store_true",
                    help="加上 LLM 旁白席（每局若干次模型调用，输出会多出「」短句）")
    ap.add_argument("--brain", choices=["adventurer", "sage"], default="adventurer",
                    help="决策脑：adventurer 纯确定性；sage 事件房/精英战走 Jev（可降级）")
    ap.add_argument("--verify", action="store_true",
                    help="同 seed 跑两局，比对事件行（确定性自检）")
    ap.add_argument("-v", "--verbose", action="store_true", help="连入场/指令行一起打印")
    args = ap.parse_args()
    if args.brain == "sage" and args.verify:
        ap.error("--brain sage 与 --verify 互斥：sage 的 Jev 输出不可复现")
    token = args.token or None

    brains = {args.brain} | ({"narrator"} if args.narrate else set())
    ensure_pack(args.base, token, brains)

    rep = run_match(args.base, token, args.seed, args.max_ticks, args.narrate, args.brain)
    print(f"match {rep['match_id']}  seed={args.seed}  ticks={rep['ticks']}")
    render(rep, args.verbose)

    if args.verify:
        again = run_match(args.base, token, args.seed, args.max_ticks, args.narrate, args.brain)
        # 旁白来自模型，文本本身不可复现；开了旁白就只比对规则产生的事实行。
        cmp_flavor = not args.narrate
        a = event_lines(rep, args.verbose, cmp_flavor)
        b = event_lines(again, args.verbose, cmp_flavor)
        note = "（已排除 LLM 文案）" if args.narrate else ""
        if a == b:
            print(f"\n确定性自检 OK{note}：两次同 seed 的 {len(a)} 行事件完全一致")
        else:
            print(f"\n确定性自检 FAIL{note}：事件流不一致", file=sys.stderr)
            for x, y in zip(a, b):
                if x != y:
                    print(f"  第一次: {x}\n  第二次: {y}", file=sys.stderr)
                    break
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())