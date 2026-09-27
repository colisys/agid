// GENERATED from src/rules.ts — 源码在 src/，请勿直接编辑本文件。
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

  // src/rules.ts
  var TUNING = {
    seats: 8,
    // 人类席位数（p0..p7）；主持人脑席固定 p8
    ask_limit: 20,
    // 每人提问次数
    guess_limit: 2,
    // 每人竞猜次数（命中即胜，不命中烧 1 次）
    ask_max_chars: 100,
    // 问题/竞猜文本长度上限
    q_deadline: 8,
    // 提问判定倒计时（拍），归零释放并返还预算
    g_deadline: 8,
    // 竞猜判定倒计时（拍）
    qa_cap: 80,
    // 已答问历史封顶
    ga_cap: 20,
    // 已判竞猜历史封顶
    log_cap: 80
  };
  var Q_ANSWERS = ["是", "不是", "无关"];
  function seatName(seat) {
    var n = parseInt(String(seat).slice(1), 10);
    return "玩家" + (isFinite(n) ? n + 1 : "?");
  }
  function truncate(t, n) {
    return String(t == null ? "" : t).slice(0, n);
  }
  function addLog(s, kind, text, events) {
    var line = { tick: s.tick, kind, text };
    s.log.push(line);
    if (s.log.length > TUNING.log_cap) s.log.shift();
    if (events) events.push(line);
  }
  function newmatch(args) {
    var seedIn = args && args.seed ? args.seed : 0;
    var p = selectPuzzle(seedIn);
    var s = {
      seed: seedIn,
      tick: 0,
      status: "play",
      puzzle: { id: p.id, surface: p.surface },
      pending_q: null,
      pending_g: null,
      qa: [],
      ga: [],
      budget: {},
      log: [],
      winner: null
    };
    for (var i = 0; i < TUNING.seats; i++) {
      s.budget["p" + i] = { asks: 0, guesses: 0, joined: false };
    }
    addLog(s, "enter", "深夜汤馆开锅。锅里的故事只有主持人知道——", null);
    addLog(s, "surface", "【汤面】" + p.surface, null);
    addLog(s, "hint", "在输入框提问，主持人只会回答「是 / 不是 / 无关」；凑齐线索后用「竞猜」报出你眼里的真相。", null);
    return { state: s };
  }
  function pickActions(commands) {
    var out = [];
    for (var i = 0; i < TUNING.seats; i++) {
      var c = commands["p" + i];
      if (c && typeof c.action === "string" && c.action) {
        out.push({ seat: "p" + i, action: c.action });
      }
    }
    return out;
  }
  function pickJudge(commands) {
    var scan = ["__svc__"];
    for (var i = 0; i <= TUNING.seats; i++) scan.push("p" + i);
    for (var k = 0; k < scan.length; k++) {
      var c = commands[scan[k]];
      if (c && c.judge && typeof c.judge === "object") {
        return c.judge;
      }
    }
    return null;
  }
  function refundAsk(s, seat) {
    var b = s.budget[seat];
    if (b && b.asks > 0) b.asks -= 1;
  }
  function refundGuess(s, seat) {
    var b = s.budget[seat];
    if (b && b.guesses > 0) b.guesses -= 1;
  }
  function allExhausted(s) {
    var any = false;
    for (var i = 0; i < TUNING.seats; i++) {
      var b = s.budget["p" + i];
      if (!b || !b.joined) continue;
      any = true;
      if (b.asks < TUNING.ask_limit || b.guesses < TUNING.guess_limit) {
        return false;
      }
    }
    return any;
  }
  function endGame(s, winnerSeat, events) {
    s.status = "ended";
    s.winner = winnerSeat;
    s.pending_q = null;
    s.pending_g = null;
    s.revealed = selectPuzzle(s.seed).bottom;
    if (winnerSeat) {
      addLog(s, "win", seatName(winnerSeat) + "猜中了汤底！", events);
    } else {
      addLog(s, "end", "所有玩家的提问与竞猜机会都耗尽了——锅盖揭开。", events);
    }
    addLog(s, "reveal", "【汤底】" + s.revealed, events);
  }
  function applyJudge(s, j, events) {
    if (typeof j.q_tick === "number" && s.pending_q && s.pending_q.tick === j.q_tick) {
      var pq = s.pending_q;
      if (j.answer === "unknown") {
        refundAsk(s, pq.seat);
        addLog(s, "release", "主持人没听清" + seatName(pq.seat) + "的问题，已退回——请换一种问法再试。", events);
      } else if (typeof j.answer === "string" && Q_ANSWERS.indexOf(j.answer) >= 0) {
        s.qa.push({ tick: pq.tick, seat: pq.seat, text: pq.text, answer: j.answer });
        if (s.qa.length > TUNING.qa_cap) s.qa.shift();
        addLog(s, "answer", seatName(pq.seat) + "问：" + pq.text + " —— 主持人：" + j.answer, events);
      } else {
        return;
      }
      s.pending_q = null;
      return;
    }
    if (typeof j.g_tick === "number" && s.pending_g && s.pending_g.tick === j.g_tick) {
      var pg = s.pending_g;
      if (j.verdict === "unknown") {
        refundGuess(s, pg.seat);
        addLog(s, "release", "主持人没核对清" + seatName(pg.seat) + "的竞猜，已退回——再试一次。", events);
      } else if (j.verdict === "命中") {
        s.ga.push({ tick: pg.tick, seat: pg.seat, text: pg.text, verdict: "命中" });
        if (s.ga.length > TUNING.ga_cap) s.ga.shift();
        addLog(s, "verdict", seatName(pg.seat) + "发起竞猜：" + pg.text + " —— 主持人：命中！", events);
        endGame(s, pg.seat, events);
      } else if (j.verdict === "未中") {
        s.ga.push({ tick: pg.tick, seat: pg.seat, text: pg.text, verdict: "未中" });
        if (s.ga.length > TUNING.ga_cap) s.ga.shift();
        addLog(s, "verdict", seatName(pg.seat) + "发起竞猜：" + pg.text + " —— 主持人：未中。", events);
      } else {
        return;
      }
      s.pending_g = null;
    }
  }
  function handleCommand(s, seat, action, events) {
    var b = s.budget[seat];
    if (!b) {
      addLog(s, "illegal", "未知席位 " + seat + "。", events);
      return;
    }
    if (action.indexOf("ask:") === 0) {
      var text = action.slice(4).replace(/\s+/g, " ").trim().slice(0, TUNING.ask_max_chars);
      if (!text) {
        addLog(s, "illegal", "问题不能为空。", events);
      } else if (s.pending_q) {
        addLog(s, "illegal", "主持人正在思考" + seatName(s.pending_q.seat) + "的问题，稍等片刻再问。", events);
      } else if (b.asks >= TUNING.ask_limit) {
        addLog(s, "illegal", seatName(seat) + "的提问次数用完了。", events);
      } else {
        b.asks += 1;
        b.joined = true;
        s.pending_q = { tick: s.tick, seat, text, left: TUNING.q_deadline };
        addLog(s, "ask", seatName(seat) + "提问（剩 " + (TUNING.ask_limit - b.asks) + " 次）：" + text, events);
      }
      return;
    }
    if (action.indexOf("guess:") === 0) {
      var gtext = action.slice(6).replace(/\s+/g, " ").trim().slice(0, TUNING.ask_max_chars);
      if (!gtext) {
        addLog(s, "illegal", "竞猜内容不能为空。", events);
      } else if (s.pending_g) {
        addLog(s, "illegal", "主持人正在核对" + seatName(s.pending_g.seat) + "的竞猜，稍等片刻。", events);
      } else if (b.guesses >= TUNING.guess_limit) {
        addLog(s, "illegal", seatName(seat) + "的竞猜机会用完了。", events);
      } else {
        b.guesses += 1;
        b.joined = true;
        s.pending_g = { tick: s.tick, seat, text: gtext, left: TUNING.g_deadline };
        addLog(s, "guess", seatName(seat) + "发起竞猜（剩 " + (TUNING.guess_limit - b.guesses) + " 次）：" + gtext, events);
      }
      return;
    }
    addLog(s, "illegal", "无法识别的指令「" + truncate(action, 30) + "」，请用 ask: / guess: 前缀。", events);
  }
  function releaseExpired(s, events) {
    if (s.pending_q) {
      s.pending_q.left -= 1;
      if (s.pending_q.left <= 0) {
        refundAsk(s, s.pending_q.seat);
        addLog(s, "release", "主持人迟迟未答，" + seatName(s.pending_q.seat) + "的问题已退回（次数返还）。", events);
        s.pending_q = null;
      }
    }
    if (s.pending_g) {
      s.pending_g.left -= 1;
      if (s.pending_g.left <= 0) {
        refundGuess(s, s.pending_g.seat);
        addLog(s, "release", "主持人迟迟未判，" + seatName(s.pending_g.seat) + "的竞猜已退回（次数返还）。", events);
        s.pending_g = null;
      }
    }
  }
  function tick(args) {
    var s = JSON.parse(JSON.stringify(args.state));
    var commands = args.commands || {};
    var events = [];
    if (!s.puzzle || !s.puzzle.surface || !s.budget) {
      return { state: s, events };
    }
    var judge = pickJudge(commands);
    var acts = pickActions(commands);
    if (!s.pending_q && !s.pending_g && acts.length === 0 && !judge) {
      return { state: s, events, wait: true };
    }
    s.tick = (s.tick || 0) + 1;
    if (judge) applyJudge(s, judge, events);
    for (var i = 0; i < acts.length && s.status === "play"; i++) {
      handleCommand(s, acts[i].seat, acts[i].action, events);
    }
    releaseExpired(s, events);
    if (s.status === "play" && allExhausted(s)) {
      endGame(s, null, events);
    }
    return { state: s, events };
  }
  function snapshot(args) {
    var s = JSON.parse(JSON.stringify(args.state));
    s.seats = TUNING.seats;
    s.ask_limit = TUNING.ask_limit;
    s.guess_limit = TUNING.guess_limit;
    s.ask_max_chars = TUNING.ask_max_chars;
    return s;
  }
  function over(args) {
    var s = args.state;
    if (s.status === "ended") {
      return {
        over: true,
        result: {
          winner: s.winner || "",
          reason: s.winner ? "puzzle_solved" : "budget_exhausted",
          puzzle_id: s.puzzle ? s.puzzle.id : "",
          revealed: s.revealed || ""
        }
      };
    }
    return { over: null };
  }
  globalThis.newmatch = newmatch;
  globalThis.tick = tick;
  globalThis.snapshot = snapshot;
  globalThis.over = over;
})();
