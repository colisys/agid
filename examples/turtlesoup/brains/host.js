// GENERATED from src/brains/host.ts — 源码在 src/，请勿直接编辑本文件。
"use strict";
(() => {
  // src/puzzles.ts
  var PUZZLES = [
    {
      id: "turtle",
      surface: "一个男人走进海边的餐厅，点了一碗海龟汤。他喝了一口，问服务员：「这真的是海龟汤吗？」服务员说：「是的。」男人付账离开后，回到家自杀了。为什么？",
      bottom: "男人曾遭遇海难，与同伴在海上漂流，濒死时同伴喂他喝下「海龟汤」，他因此活了下来。今天他第一次喝到真正的海龟汤，发现味道完全不同——他明白了当年喝下的是同伴割下自己的肉煮的汤。他无法承受这份真相，选择了自杀。"
    },
    {
      id: "parachute",
      surface: "荒野中央躺着一个死去的男人。他背着一个完好无损、从未打开的背包，手里紧紧攥着半根火柴。发生了什么？",
      bottom: "男人和同伴乘热气球旅行，气球不断漏气下坠，眼看就要坠毁，必须减重。行李全部扔光后仍然不够，于是两人抽火柴决定谁跳下去。他抽到了短的那半根，跳下气球摔死在荒野里——背包是他始终没舍得扔的降落伞，但还没来得及背上。"
    },
    {
      id: "seaweed",
      surface: "一个男人在海里游泳，潜到深处时被水草缠住了脚踝，他用力挣脱后游回了岸。当天晚上，他自杀了。为什么？",
      bottom: "男人的妻子多年前在这片海域溺水失踪，遗体一直没被找到。他今天挣脱的并不是水草——那是妻子的长发。他意识到妻子一直沉在这片他常来游泳的海里，而自己这么多年来从未认真寻找过她。愧疚与悲痛击垮了他。"
    },
    {
      id: "lighthouse",
      surface: "深夜，灯塔守夜人关掉了灯，回家睡觉。第二天，新闻里播报了一起沉船事故，多人遇难。守夜人看完新闻，跳楼自杀了。为什么？",
      bottom: "守夜人那晚疲惫至极，违反规定熄了灯去睡觉。夜里一艘船因为看不到灯塔的光在礁石上触礁沉没。他看到新闻，知道是自己害死了船上的人，无法承受，跳楼自杀。"
    },
    {
      id: "elevator",
      surface: "一个住在高层公寓的男人，每天早上坐电梯直接下到一楼；但每天晚上回来，他只坐到 10 层，然后爬楼梯回家——只有在下雨天，他才会一路坐到底。为什么？",
      bottom: "男人是个侏儒，个子太矮，只够得到电梯里较低的按钮，最高只能按到 10 层，所以回家只能坐到 10 层再爬楼梯。下雨天他带着伞，可以用伞尖按到自家楼层的按钮，于是能一路坐到底。"
    },
    {
      id: "ice",
      surface: "两个朋友在酒吧喝酒。一个人点了加冰的酒，一口闷完就离开了；另一个人边聊边慢慢喝，喝完也离开了。当晚，慢慢喝的那个人死了，一口闷的那个安然无恙。为什么？",
      bottom: "毒药被冻在冰块里。一口闷的人在冰块还没来得及融化时就把酒喝完了，毒没有溶进酒里；慢慢喝的人的冰块逐渐融化，毒药释放进酒中，他喝下了掺毒的酒，当晚毒发身亡。"
    },
    {
      id: "icehang",
      surface: "封闭的房间里，一根绳子从房梁垂下来，一个男人吊死在上面。房间里空无一物，只有地上一滩水，他不可能够得到绳子。他是怎么吊死自己的？",
      bottom: "他站在一块巨大的冰块上，把绳子套上脖颈。冰块慢慢融化，他随着冰面下降，最终悬空吊死。地上的那滩水，就是化掉的冰。"
    },
    {
      id: "funeral",
      surface: "在一场葬礼上，一个女人遇见了一位陌生男子，一见倾心。几天后，她杀死了自己的姐姐。为什么？",
      bottom: "她一厢情愿地认为，那个男子与她家有关联，只有家里再办一场葬礼他才会再次出现。于是她杀死了姐姐，制造出另一场葬礼，盼望再次遇见他。她并不清醒——这是她的妄想。"
    },
    {
      id: "scuba",
      surface: "一场森林大火扑灭后，消防员在烧焦的树林中央发现了一具尸体。死者穿着完整的潜水服，背着氧气瓶。他为什么会在这里？",
      bottom: "消防直升机在附近的湖里取水灭火，一斗下去，把正在湖中潜水的人连同水一起舀了起来，然后洒在了着火的森林上空。死者是被「从天上浇下来的」——他至死都穿着潜水服。"
    },
    {
      id: "bald",
      surface: "大雨天，一个男人没带伞也没有避雨，在雨里走了很久。他全身都湿透了，唯独头发是干的。为什么？",
      bottom: "他是秃头，一根头发也没有，所以头发当然是干的。"
    }
  ];
  function selectPuzzle(seed) {
    var n = Math.floor(Math.abs(Number(seed) || 0));
    return PUZZLES[n % PUZZLES.length];
  }

  // src/brains/host.ts
  var Q_SYSTEM = "你是海龟汤游戏的主持人。玩家会围绕汤面提问，你必须只依据汤底的事实来判断。回答只能是一个词：是、不是、无关。「无关」表示问题与汤底核心无关。只输出这一个词，不要解释、不要标点。";
  var G_SYSTEM = "你是海龟汤游戏的主持人。玩家会给出对汤底的猜测，你判断它是否抓住了汤底的核心真相（关键因果一致即算命中，措辞不必逐字相同；细节偏差不算未中）。只输出两个字：命中 或 未中。";
  function clean(text) {
    if (typeof text !== "string") return "";
    var t = text.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
    return t.replace(/^["'「『《.,，。!？?]+/, "").replace(/["'」』》.,，。!？?]+$/, "").trim();
  }
  function parseAnswer(raw) {
    var t = clean(raw);
    if (t.indexOf("无关") >= 0) return "无关";
    if (t.indexOf("不是") >= 0 || t.indexOf("不") === 0) return "不是";
    if (t.indexOf("是") >= 0) return "是";
    return "unknown";
  }
  function parseVerdict(raw) {
    var t = clean(raw);
    if (t.indexOf("未") >= 0) return "未中";
    if (t.indexOf("命中") >= 0) return "命中";
    return "unknown";
  }
  var CACHE_CAP = 24;
  function pruneCache(c) {
    var keys = Object.keys(c);
    if (keys.length <= CACHE_CAP) return;
    keys.sort(function(a, b) {
      return (parseInt(a.replace(/\D/g, ""), 10) || 0) - (parseInt(b.replace(/\D/g, ""), 10) || 0);
    });
    var drop = keys.length - CACHE_CAP;
    for (var i = 0; i < drop; i++) delete c[keys[i]];
  }
  function askAnswer(snap, question, mem) {
    try {
      var out = host.llm("", [
        { role: "system", content: Q_SYSTEM },
        {
          role: "user",
          content: "【汤面】" + (snap.puzzle ? snap.puzzle.surface : mem.surface || "") + "\n【汤底】" + (mem.bottom || "") + "\n【玩家的问题】" + question + "\n只回答：是 / 不是 / 无关"
        }
      ]);
      return parseAnswer(out);
    } catch (err) {
      host.log("[host] LLM 提问判定失败: " + err);
      return "unknown";
    }
  }
  function askVerdict(snap, guess, mem) {
    try {
      var out = host.llm("", [
        { role: "system", content: G_SYSTEM },
        {
          role: "user",
          content: "【汤面】" + (snap.puzzle ? snap.puzzle.surface : mem.surface || "") + "\n【汤底】" + (mem.bottom || "") + "\n【玩家的竞猜】" + guess + "\n只输出：命中 或 未中"
        }
      ]);
      return parseVerdict(out);
    } catch (err) {
      host.log("[host] LLM 竞猜判定失败: " + err);
      return "unknown";
    }
  }
  function decide(args) {
    var mem = args.memory && typeof args.memory === "object" ? args.memory : {};
    var commands = {};
    try {
      var snap = args.snapshot || {};
      if (!mem.bottom) {
        var p = selectPuzzle(snap.seed || 0);
        mem.pid = p.id;
        mem.surface = p.surface;
        mem.bottom = p.bottom;
        mem.answers = {};
        mem.verdicts = {};
      }
      var pg = snap.pending_g;
      if (pg) {
        var gkey = "g" + pg.tick;
        var verdict = (mem.verdicts || {})[gkey] || "";
        if (!verdict) {
          verdict = askVerdict(snap, pg.text, mem);
          if (verdict !== "unknown") {
            mem.verdicts = mem.verdicts || {};
            mem.verdicts[gkey] = verdict;
            pruneCache(mem.verdicts);
          }
        }
        commands.judge = { g_tick: pg.tick, verdict };
        return { commands, memory: mem };
      }
      var pq = snap.pending_q;
      if (pq) {
        var qkey = "q" + pq.tick;
        var answer = (mem.answers || {})[qkey] || "";
        if (!answer) {
          answer = askAnswer(snap, pq.text, mem);
          if (answer !== "unknown") {
            mem.answers = mem.answers || {};
            mem.answers[qkey] = answer;
            pruneCache(mem.answers);
          }
        }
        if (answer) {
          commands.judge = { q_tick: pq.tick, answer };
        }
      }
    } catch (err) {
      try {
        host.log("[host] 异常降级: " + err);
      } catch (e2) {
      }
    }
    return { commands, memory: mem };
  }
  globalThis.decide = decide;
})();
