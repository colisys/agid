// GM brain (p4): the observer/operator seat — the bridge between the gateway
// side Python backend (services/pm.py) and the live match state.
//
// 每轮 decide：
//   1. POST /observe 把快照摘要推给 pm 服务（监听：后台实时看到每局进度）
//   2. GET  /poll    取回后台排队的 GM 操作（操纵：PM 页下发，队列化）
//   3. 有操作则发 commands.gm = {ops}，rules.tick 逐条校验执行（合法性归规则）
//
// 运行键是 seed（decide 入参只有 snapshot/memory，没有 match_id）：UI 建局时
// seed 留空自动取随机值保证唯一，resume 沿用存档 seed。同 seed 的并发局会在
// 后台视图中重叠——文档已注明，属可接受的边界。
// pm 服务挂掉 = 无观察无操作，对局完全不受影响（try/catch + 30 tick 熔断）。
// wait 轮 decide 照跑但 tick 未变，用 memory.last_tick 去重。
import type { DecideArgs, DecideResult, GmOps, Snapshot } from "../shared";

// QuickJS 注入的脑席通道；类型来自 quickjs.d.ts。
declare const host: QuickJSBrainHost;

// 快照摘要：只上报后台展示需要的字段，不上传整份 state。
function digest(snap: Snapshot): Record<string, unknown> {
  return {
    seed: snap.seed,
    tick: snap.tick,
    depth: snap.depth,
    gold: snap.gold,
    potions: snap.potions,
    kills: snap.kills,
    boss_kills: snap.boss_kills,
    hero: { hp: snap.hero?.hp, hp_max: snap.hero?.hp_max, atk: snap.hero?.atk },
    foe: snap.foe
      ? { name: snap.foe.name, hp: snap.foe.hp, hp_max: snap.foe.hp_max, boss: snap.foe.boss }
      : null,
    pending: snap.pending
      ? { title: snap.pending.title, deadline_tick: snap.pending.deadline_tick }
      : null,
    inventory: (snap.inventory || []).slice(0, 16),
    statuses: snap.statuses || {},
    resumes: snap.resumes || 0,
    log: (snap.log || []).slice(-6),
  };
}

export function decide(args: DecideArgs): DecideResult {
  // 首轮 decide 的 memory 是 null（服务端尚未有任何记忆往返）——不兜底会
  // TypeError 且直接杀死 tick loop（脑席绝不抛异常的纪律）。
  var mem = args.memory || {};
  var snap = args.snapshot;
  var tick = snap.tick || 0;
  var commands: Record<string, unknown> = {};

  // 熔断窗口内不出手（pm 服务上次调用失败）
  if (typeof mem.mute_until === "number" && tick < (mem.mute_until as number)) {
    return { commands: {}, memory: mem };
  }
  // wait 轮 decide 照跑但 tick 不变：只上报一次
  if ((mem.last_tick as number) === tick) {
    return { commands: commands, memory: mem };
  }
  mem.last_tick = tick;

  try {
    // 监听：上报最新摘要（覆盖式，pm 侧每局只留最新）
    host.svc("pm", "/observe", { key: String(snap.seed), observe: digest(snap) });
    // 操纵：取回后台排队的 GM 操作（取走即清空）
    var polled = host.svc("pm", "/poll?key=" + encodeURIComponent(String(snap.seed)), {}) as {
      ops?: unknown;
    };
    if (polled && Array.isArray(polled.ops) && polled.ops.length) {
      (commands as { gm?: GmOps }).gm = { ops: polled.ops } as GmOps;
    }
  } catch (e) {
    // pm 服务不可用：静默熔断（能力缺席不碍局）
    mem.mute_until = tick + 30;
  }
  return { commands: commands, memory: mem };
}

(globalThis as Record<string, unknown>).decide = decide;
