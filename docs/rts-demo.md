# RTS demo：Jev 做策略选择，QuickJS 做编排

一个可跑的最小闭环：模拟器每 tick 把战况发给网关，Jev 选策略，
JS 脚本挂建造单 + 硬覆盖，模拟器结算战斗。

## 跑起来

```bash
# 1. 把 RTS 脚本热更到网关（线上 6363 已装好）
go run ./cmd/gwadmin script set scripts/rts.js

# 2. 跑 24 tick（对手剧本：rush 1-6 → 运营 7-15 → 总攻 16+）
python3 scripts/rts_sim.py --base http://localhost:6363 --ticks 24

# 3. 加 LLM 解说（需要网关配好 LLM provider）
python3 scripts/rts_sim.py --commentary
```

## 链路

```
rts_sim.py --tick state--> POST /v1/execute --routes--> Jev intent 选择
   ↑                                                    (rush/defend/expand/harass/tech)
   │                                              QuickJS rts.js: 挂 orders + 硬覆盖
   └──────── orders (build/move/attack) <──────── verdict + output
```

- 每 tick 一次 `/v1/decide`（Choice 选 5 策略其一 + 复杂度 Score），高频便宜。
- 两个硬覆盖写在 JS 里，不经模型：基地血量 <250 强制 defend；人口卡死追加补给站。
- LLM 只在 `--commentary` 时调一次，出解说词，不参与决策。

## 实测 24 tick（2026-09-24，线上 Jev）

前期 rush 试探 → 中期 harass 运营攒兵（army 0→96）→ 敌方总攻转 defend 保基地，
基地 1000/1000 存活。典型行：`16 defend 0.93`（敌方 82 压境，果断回防）。

## 已知边界

- 低置信意图（如某 tick defend 0.20）仍被执行：当前门控是事后 verdict 标注，
  不是事前拦截——脚本已经跑完。如需"低置信不执行"，要在 rts.js 里读
  `picked.confidence` 后自行降级（示例见 docs/orchestration.md）。
- 剧本还没压到残血/人口卡边界，两个 override 未触发；加压剧本可验证。
