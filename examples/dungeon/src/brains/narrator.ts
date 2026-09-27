// Narrator brain: the only seat allowed to touch a language model.
//
// It reads the newest "notable" fact line the rules appended to state.log and
// asks host.llm for one ultra-short flavor sentence (early-WAP text-game
// style). The text goes back as commands.narrate, and the rules — which never
// call a model themselves — merge it into that log line's `flavor` field.
//
// Rules of engagement:
//   * never throws (a throwing brain stops the whole tick loop)
//   * no LLM request when there is nothing new and notable (cost control)
//   * at least MIN_GAP ticks between two narrations (latency control)
//   * any failure degrades to a built-in template, loudly (host.log)

import type { DecideArgs, DecideResult, LogLine, Snapshot } from "../shared";

// QuickJS 注入的脑席通道；类型来自 quickjs.d.ts。
declare const host: QuickJSBrainHost;

var NOTABLE = [
  "spawn",
  "kill",
  "levelup",
  "descend",
  "flee",
  "clear",
  "win",
  "event",
  "trap",
  "curse",
  "nothing",
];
var MIN_GAP = 2; // 两条旁白之间至少隔几个回合
var MAX_CHARS = 20;
var FAIL_LIMIT = 2; // 连续失败几次就暂停请求
var MUTE_TICKS = 40; // 暂停多少回合后再试一次（模型侧恢复后能自愈）

var EPITAPH_SYSTEM =
  "你是地牢里的最后一位史官。为一位死在深处的冒险者写一句不超过 18 个汉字的" +
  "墓志铭，冷峻而有余味。只输出这一句，不要引号、不要解释。";

// kind -> 兜底短句（LLM 不可用时的模板降级）
var TEMPLATES: Record<string, string> = {
  spawn: "暗处有什么在动",
  kill: "又一只怪物倒下",
  levelup: "力量涌了上来",
  descend: "石阶通向更深处",
  flee: "你退回了入口",
  clear: "这一层安静下来了",
  win: "地牢的黑暗散去了",
  event: "前方的黑暗里有什么",
  trap: "疼痛来得毫无预兆",
  curse: "有什么东西缠上了你",
  nothing: "你翻找了一阵，只有碎石和蛛网",
};
var EPITAPH_FALLBACK = "他的故事，止步于火把熄灭的地方";
var PROLOGUE_SYSTEM =
  "你是地牢探险游戏的开场旁白。根据冒险者的随机出身（骰子掷出的出身与赐福/厄运），" +
  "用不超过 40 个汉字写一段第二人称的背景故事，要点到那个出身。只输出故事本身。";
var PROLOGUE_FALLBACK = "你举着火把走进深渊——你的出身，就是你的第一件装备。";
// 文案库（v5.3）：LLM 不必每次旁白都实时调用——旁白文案按场景批量预生成，
// 存在 **state.flavor_bank**（随 SSE 每 tick 热更到前端）。补货在 pm 服务
// 后台线程异步完成（见 decide 补货分支）；实时旁白被节流/熔断时从库里取，
// 规则端顺带弹出已用句。
var NOTABLE_KINDS = [
  "spawn",
  "kill",
  "levelup",
  "descend",
  "flee",
  "clear",
  "event",
  "trap",
  "curse",
  "nothing",
  "quota",
];
// 事件房动态文案：id 与 rules.EVENTS 对齐（纯展示层，机制照旧）
var EVENT_IDS = ["merchant", "altar", "chest", "fork", "adventurer", "gambler"];

function clean(text: string, maxChars: number): string {
  if (typeof text !== "string") {
    return "";
  }
  var t = text
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  t = t
    .replace(/^["'「『《]+/, "")
    .replace(/["'」』》]+$/, "")
    .trim();
  // 只取第一句，防止模型多说
  var cut = t.search(/[。！？!?]/);
  if (cut > 0) {
    t = t.slice(0, cut);
  }
  return t.slice(0, maxChars);
}

// 统一 LLM 通道：失败计熔断，成功清零；fallback 是模板兜底文本。
function llmText(
  snap: Snapshot,
  system: string,
  userPrompt: string,
  mem: Record<string, unknown>,
  fallback: string,
  maxChars: number,
): string {
  var tick = snap.tick || 0;
  // 熔断中：不发请求，直接走模板（既省调用也不拖慢实时节奏）。
  if (typeof mem.mute_until === "number" && tick < (mem.mute_until as number)) {
    return fallback;
  }
  try {
    var out = clean(
      host.llm("", [
        { role: "system", content: system },
        { role: "user", content: userPrompt },
      ]),
      maxChars,
    );
    if (out) {
      mem.fail_streak = 0;
      return out;
    }
    host.log("[narrator] llm 返回空文本，改用模板兜底");
  } catch (err) {
    host.log("[narrator] llm 降级: " + err);
  }
  mem.fail_streak = ((mem.fail_streak as number) || 0) + 1;
  if ((mem.fail_streak as number) >= FAIL_LIMIT) {
    mem.fail_streak = 0;
    mem.mute_until = tick + MUTE_TICKS;
    host.log(
      "[narrator] 连续失败，暂停旁白请求 " +
        MUTE_TICKS +
        " 回合（模板继续兜底）",
    );
  }
  return fallback;
}

function scene(snap: Snapshot): string {
  var hero = snap.hero;
  return (
    "第" +
    snap.depth +
    "层，等级" +
    snap.level +
    "，体力 " +
    hero.hp +
    "/" +
    hero.hp_max +
    "，金币 " +
    snap.gold +
    "。"
  );
}

function template(entry: LogLine): string {
  return TEMPLATES[entry.kind] || clean(entry.text, MAX_CHARS) || "……";
}

function narrate(
  snap: Snapshot,
  entry: LogLine,
): { text: string; pop?: string } {
  // 兜底链：文案库取货（规则端弹出已用句）→ 模板。实时 LLM 已彻底移出
  // decide 同步路径（库由 pm 后台线程异步补货）——遇怪/特殊事件的旁白
  // 现在永远零阻塞，前端不再「点一下卡半分钟」。
  var bank = snap.flavor_bank || {};
  var lines = bank[entry.kind];
  if (lines && lines.length) {
    return { text: lines[0], pop: entry.kind };
  }
  return { text: template(entry) };
}

// 来历传说（v5.6 起异步化）：鉴定行（kind event，带 ids 载荷）→ 为其中一种
// 还没写过传说的装备投递后台生成（随 bankgen 走，绝不同步等 LLM）。
// 跨局已带 lore 的（props.lore 注入 s.item_lore）自动跳过。
function findLoreTarget(
  snap: Snapshot,
  mem: Record<string, unknown>,
): { entry: LogLine; base: string } | null {
  var lored = (mem.lored as Record<string, boolean>) || {};
  var have = snap.item_lore || {};
  var log = snap.log || [];
  for (var i = log.length - 1; i >= 0; i--) {
    var e = log[i];
    if (!e.ids || !e.ids.length) {
      continue;
    }
    for (var j = 0; j < e.ids.length; j++) {
      var b = e.ids[j];
      if (!have[b] && !lored[b]) {
        return { entry: e, base: b };
      }
    }
  }
  return null;
}

// lore 的上下文在投递时打包（装备名/描述/鉴定场景），生成在 pm 后台完成。
function loreAsk(
  snap: Snapshot,
  target: { entry: LogLine; base: string },
): Record<string, string> {
  var def = snap.catalog ? snap.catalog[target.base] : null;
  return {
    base: target.base,
    name: def ? def.name : target.base,
    desc: def ? def.desc || "" : "",
    scene: target.entry.text,
    where: scene(snap),
  };
}

// 墓志铭：死亡行 → LLM 写一句。整局只此一次（rules 只收第一句）。
function epitaphText(
  snap: Snapshot,
  entry: LogLine,
  mem: Record<string, unknown>,
): string {
  var ask =
    "事实：" +
    entry.text +
    "\n" +
    "场景：" +
    scene(snap) +
    "击倒守主 " +
    (snap.boss_kills || 0) +
    " 次。";
  return llmText(snap, EPITAPH_SYSTEM, ask, mem, EPITAPH_FALLBACK, 30);
}

function decide(args: DecideArgs): DecideResult {
  var snap = (args.snapshot || {}) as Snapshot;
  var mem = args.memory && typeof args.memory === "object" ? args.memory : {};
  var commands: {
    narrate?: import("../shared").Narrate;
    lore?: { base: string; text: string };
    epitaph?: { text: string };
    prologue?: { text: string };
    bank?: Record<string, string[]>;
    event_variants?: Record<string, { title: string; desc: string }[]>;
  } = {};
  try {
    // 0) 序章（最高优先）：LLM 把出身骰的结果写进背景故事。立即返回——
    //    文案库补货放到后续 decide，避免同一 tick 背两个 LLM 延迟。
    //    以 snap.prologue_text 为准（而非 mem 标记）：等待人类指令的轮次里，
    //    引擎会整轮丢弃 decide 输出（wait 分支），state 没落上就重发，天然自愈。
    if (snap.prologue_boon && !snap.prologue_text) {
      var boon = snap.prologue_boon;
      mem.prologue_done = true; // 文案库慢补以此为契机（序章发出后才开始）
      // 首次产出缓存进 mem：等待人类指令的轮次里 decide 输出会被引擎整轮
      // 丢弃（wait 分支），重发时直接复用，不重复烧 LLM 调用。
      var ptext = mem.prologue_text as string;
      if (!ptext) {
        ptext = llmText(
          snap,
          PROLOGUE_SYSTEM,
          "出身：" + boon.label + "\n场景：" + scene(snap),
          mem,
          PROLOGUE_FALLBACK,
          60,
        );
        mem.prologue_text = ptext;
      }
      return {
        commands: {
          prologue: { text: ptext },
        } as typeof commands,
        memory: mem,
      };
    }

    var log = snap.log || [];
    var last =
      typeof mem.narrated_tick === "number"
        ? (mem.narrated_tick as number)
        : -999;

    // 0-1) 异步生成通道（后台静默）：LLM 生成全部挪进 pm 服务的后台线程，
    //      脑席只做两件零阻塞的事——有需求（缺货场景/来历传说）就 POST
    //      /bankgen 投递任务（毫秒级返回）；上一单跑完就领货。绝不 host.llm
    //      同步等待（那会把结算路径卡住几十秒，前端体感「点不动」）。
    //      缺货判定：场景**被用空**才补（< CAP 是常态，不算缺）。
    var muted =
      typeof mem.mute_until === "number" &&
      snap.tick < (mem.mute_until as number);
    if ((mem.prologue_done as boolean) && !muted) {
      var bank = snap.flavor_bank || {};
      var missing: string[] = [];
      for (var bi = 0; bi < NOTABLE_KINDS.length; bi++) {
        var kind = NOTABLE_KINDS[bi];
        if ((bank[kind] || []).length === 0) missing.push(kind);
      }
      var target = findLoreTarget(snap, mem);
      // 事件动态文案需求：池里没货且本局没投过的 id
      var evpool = snap.event_variants || {};
      var evNeed: string[] = [];
      var evAsked = (mem.ev_asked as Record<string, boolean>) || {};
      for (var vi = 0; vi < EVENT_IDS.length; vi++) {
        var eid = EVENT_IDS[vi];
        if (!(evpool[eid] || []).length && !evAsked[eid]) evNeed.push(eid);
      }
      if (mem.bank_pending as boolean) {
        try {
          // 上一单还在后台跑：领一下（ready:false 就继续等，不阻塞）
          var res = host.svc("pm", "/bankgen/result", {}) as {
            ready?: boolean;
            bank?: Record<string, unknown>;
            lore?: { base?: string; text?: string };
            events?: Record<string, unknown>;
            error?: string;
          };
          if (res && res.ready) {
            mem.bank_pending = false;
            if (res.error) {
              host.log("[narrator] 后台文案生成失败: " + res.error);
            }
            if (res.bank && Object.keys(res.bank).length) {
              commands.bank = res.bank as Record<string, string[]>;
              mem.narrated_tick = snap.tick;
            }
            if (res.events && Object.keys(res.events).length) {
              commands.event_variants = res.events as Record<
                string,
                { title: string; desc: string }[]
              >;
              mem.narrated_tick = snap.tick;
            }
            // 来历传说领货：送到 rules 落 s.item_lore（跨局携带）。标记
            // mem.lored 防重复生成；wait 轮被丢弃的极端情况放弃本句（文案而已）。
            if (res.lore && res.lore.base && res.lore.text) {
              var lored = (mem.lored as Record<string, boolean>) || {};
              lored[res.lore.base] = true;
              mem.lored = lored;
              commands.lore = {
                base: res.lore.base,
                text: String(res.lore.text),
              };
              mem.narrated_tick = snap.tick;
            }
            // 本单跑完：无论成没成，池还空着的 id 不再重复投（避免烧调用）
            for (var vj = 0; vj < evNeed.length; vj++) {
              evAsked[evNeed[vj]] = true;
            }
            mem.ev_asked = evAsked;
          }
        } catch (e3) {
          host.log("[narrator] 后台文案通道异常: " + e3);
          mem.mute_until = (snap.tick || 0) + MUTE_TICKS;
        }
      } else if (missing.length || target || evNeed.length) {
        try {
          // 投新单（pm 幂等：同单未完成时重复投不再排队）。传说/事件上下文随单打包。
          host.svc("pm", "/bankgen", {
            kinds: missing,
            lore: target ? loreAsk(snap, target) : null,
            events: evNeed,
            scene: scene(snap),
          });
          mem.bank_pending = true;
          mem.narrated_tick = snap.tick; // 投递本身也算占用旁白节流额度
        } catch (e4) {
          host.log("[narrator] 后台文案投递异常: " + e4);
          mem.mute_until = (snap.tick || 0) + MUTE_TICKS;
        }
      }
    }

    // 1) 死讯（最高优先）：死亡行只走墓志铭通道，不再配旁白。
    for (var i = log.length - 1; i >= 0; i--) {
      if (log[i].kind === "death") {
        if (!(mem.epitaph_done as boolean)) {
          mem.epitaph_done = true;
          commands.epitaph = { text: epitaphText(snap, log[i], mem) };
        }
        return { commands: commands, memory: mem };
      }
    }

    // 2) 普通旁白：只给关键事件配文案（文案库/模板，零 LLM 等待），
    //    节流与上面共用 narrated_tick。
    var entry: LogLine | null = null;
    for (var i2 = log.length - 1; i2 >= 0; i2--) {
      var e2 = log[i2];
      if (e2.flavor) {
        continue;
      } // 已经配过文案
      if (NOTABLE.indexOf(e2.kind) < 0) {
        continue;
      } // 只给关键事件配文案
      // 节流：文案库里有现货就立即配（零成本零延迟，玩家点击同轮即见）；
      // 只有回落到模板时才按 MIN_GAP 节流，防止模板刷屏。
      if (
        e2.tick - last < MIN_GAP &&
        !((snap.flavor_bank || {})[e2.kind] || []).length
      ) {
        continue;
      }
      entry = e2;
      break;
    }
    if (entry) {
      // 带上 kind：同一 tick 可能有多行（遇怪/命中/受伤），规则要把它贴到对的那一行。
      var said = narrate(snap, entry);
      commands.narrate = {
        tick: entry.tick,
        kind: entry.kind,
        text: said.text,
        pop: said.pop,
      };
      mem.narrated_tick = entry.tick;
    }
  } catch (err) {
    // 兜底：绝不向上抛，否则 tick loop 会停
    try {
      host.log("[narrator] 异常降级: " + err);
    } catch (e2) {
      /* host 不可用 */
    }
  }
  return { commands: commands, memory: mem };
}

(globalThis as Record<string, unknown>).decide = decide;
