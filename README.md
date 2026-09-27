# AGID — 决策网关 / 权威对局服

> 一个 Go 单体网关：**把 LLM 当决策器，把代码当工作流**；同时它自己就是一台
> **权威游戏服务器** —— 服务端持状态、跑 tick loop、推 SSE，AI 是 QuickJS 脑脚本。
>
> *A Go gateway that treats models as decision engines and code as the workflow —
> and doubles as an authoritative real-time game server.*

[English summary](#english-summary) · [快速开始](#快速开始) · [文档](#文档)

---

## 它是什么

两件东西，一个进程。

**① 决策网关** — 北向对外暴露统一 REST（+ OpenAI 兼容子集）接口；南向把
[Jev (TypeSafe System One)](https://api.typesafe.ai/v1/systemone) 当**决策器**
（路由 / 审批 / 评分 / 校验，返回 typed judgment + probability + confidence），
把其他 LLM 当**执行器**（任务拆解、候选生成、工具调用、文本生成）。

核心原则照搬 TypeSafe 官方的编程模型：**Code owns workflow**。
所有分支、阈值、权重、降级都在代码里，模型只提供语义判断。

```text
Client ─▶ Ingress ─▶ Orchestrator ─▶ LLM 编排（生成候选，不拍板）
                             │
                             ▼
                    Decision：Jev 一次扇出多问 ─▶ verdict{decision, probabilities, confidence}
                             │
                             ▼
                    Gate（代码里的阈值表）─▶ allow | confirm | human | deny
```

**② 权威对局服** — 游戏是「规则脚本 + 脑脚本 + 可选 Python 后端」的目录包。
网关自己跑对局：服务端持状态、跑 tick loop、SSE 推送；对局结束即卸载，只留战报。
没有脑脚本也能跑（纯确定性规则），有脑脚本就让 AI 参与。

## 为什么值得看

这不是又一个"调 LLM API 的壳"。几个不太一样的设计：

| 设计 | 说明 |
| --- | --- |
| **模型不生成，代码拍板** | Jev 只返回 typed judgment（`choice` / `noul` / `score`）和概率，不写文本。阈值、权重、fail-closed/fail-open 全在 Go 里，可运营调参。 |
| **决策与执行分离** | 同一个请求里，LLM 生成候选、Jev 选型、代码门控。风险动作不靠"再问模型一次"来兜底。 |
| **对局即一等公民** | 权威状态在服务端，确定性 PRNG（同 seed 同指令序列 → 同终局），可直接"改脑脚本 → 跑 N 局 → 看胜率"。 |
| **游戏包可携带后端** | manifest 声明包内 Python 服务，网关监管进程、反代、注入环境；后端能观察并操纵活局。 |
| **四级凭据，互不越界** | operator / service / player / match-token，每级只管自己的格子。 |
| **零重依赖** | 只有 `gopkg.in/yaml.v3` 和 `github.com/buke/quickjs-go`。 |

## 快速开始

需要 Go 1.25+ 和 Python 3（包内服务用）。

```bash
git clone git@github.com:colisys/agid.git && cd agid
go build -o bin/gateway ./cmd/gateway && go build -o bin/gwadmin ./cmd/gwadmin
```

填两个 key（都不填也能跑，只是决策/编排会退化）：

```bash
cat > ~/.config/gateway/env <<'EOF'
TYPESAFE_API_KEY=sk-...      # Jev 决策器
LLM_API_KEY=sk-...          # OpenAI 兼容上游
ADMIN_TOKEN=$(openssl rand -hex 24)
EOF
chmod 600 ~/.config/gateway/env
```

装成用户级 systemd 服务（`scripts/service.sh` 会把 `games_dir` / `data_root`
改写成绝对路径）：

```bash
./scripts/service.sh install --port 6363 --start
curl localhost:6363/healthz          # {"ok":true}
```

或直接前台跑：

```bash
ADMIN_TOKEN=dev-token go run ./cmd/gateway -config configs/gateway.yaml
```

### 跑一局地牢探险

`examples/dungeon` 是最能说明架构的示例：行为驱动的实时策略游戏，
4 个脑席（旁白 narrator / 军师 oracle / 地牢之主 dm / 后台 gm），确定性可复现。

```bash
# headless 快跑：秒级跑完、逐行可复现
python3 examples/dungeon/demo.py --base http://localhost:6363 --token "$ADMIN_TOKEN"
python3 examples/dungeon/demo.py --verify        # 同 seed 跑两局比对事件流
python3 examples/dungeon/demo.py --brain sage     # 换成 Jev 决策脑

# 打开浏览器玩
open http://localhost:6363/play/dungeon/         # Vue 3 版
open http://localhost:6363/play/dungeon/wap/      # 单文件 WAP 版
```

前端**不持有任何管理员凭据**：建局由包内 Python 后端用自己的窄权限令牌代劳，
之后全程只用本局 `player_token`。

### 跑一个决策

```bash
curl -X POST localhost:6363/v1/decide -H 'Content-Type: application/json' -d '{
  "state": {"goal":"处理这笔退款申请","user_input":"用户要求退 199 元","candidates":[{"id":"auto","plan":"原路退款 199"}]},
  "questions": {
    "is_safe": {"type":"noul","instructions":"结合 `policies` 自动执行 `candidates[0]` 安全吗？"},
    "pick":    {"type":"choice","instructions":"哪个候选最符合 `goal`？","criteria":{"auto":"原路退款","no_match":"都不合适"}}
  }
}'
# → {"answers":{"is_safe":{"noul":0.97},"pick":{"choice":"auto","confidence":0.88,...}}}
```

拿到 typed judgment 后在**代码里**门控，不在 prompt 里：

```python
if pick["choice"] == "no_match" or safe["noul"] < 0.5:  escalate_to_human()
elif high_stakes and pick["confidence"] <= 0.85:        ask_user_to_confirm()
else:                                                   execute()
```

## 仓库结构

```text
cmd/gateway/           单体入口
cmd/gwadmin/           CLI 管理端（建局、改策略、轮换密钥、热更脚本）
internal/decision/     ★ Jev 客户端 + Question Packs + 置信度门控
internal/game/         对局管理：tick loop、SSE、replay、match bridge
internal/jsflow/       QuickJS 池，跑 rules/brains 脚本
internal/orchestrator/ /v1/execute 编排引擎
internal/services/     包内 Python 服务监管 + compose 生成
internal/api/          HTTP 层
examples/dungeon/      地牢探险（主力示例：脑席 + Python 后端 + 两个前端）
examples/tictactoe/    井字棋（最小包形状，新游戏照抄）
scripts/games/rts/     RTS（Jev 选策略 + QuickJS 编排建造单）
docs/                  架构与运维文档
```

## 文档

| 文档 | 内容 |
| --- | --- |
| [architecture.md](docs/architecture.md) | 网关总设计：Jev 三原语、Question Packs、置信度路由表、门控 |
| [game-server.md](docs/game-server.md) | **对局服与游戏包**：manifest 全部字段、沙箱、`match_access` 桥接、四级凭据 |
| [orchestration.md](docs/orchestration.md) | `/v1/execute` 的 JS 编排流程 |
| [services-design.md](docs/services-design.md) | 包内后端的设计推导与实施记录（含修掉的问题） |
| [admin.md](docs/admin.md) · [proxy.md](docs/proxy.md) | 在线调参、上游代理 |
| [service.md](docs/service.md) | systemd 运维 |

## 一点说明

- 项目里的 Jev / LLM 调用需要你自己的 key；不填也能跑纯确定性对局。
- 包内 Python 服务默认 `strict` 档：白名单环境变量（拿不到网关运营凭据）+
  资源上限。容器部署用 `scripts/service.sh compose` 生成编排，网关只生成不执行。
- 示例里的 `data/` 是运行期暂存目录，已 gitignore。

## English summary

AGID is a single Go binary with two faces.

**A decision gateway.** Northbound it speaks one REST API (plus an OpenAI-compatible
subset). Southbound it uses [Jev / TypeSafe System One](https://api.typesafe.ai/v1/systemone)
purely as a *decision engine* — routing, approval, scoring, verification — returning
typed judgments with probabilities and confidence, and never prose. Other LLMs are
*executors*: they generate candidates, call tools, write text. All branching, thresholds
and degradation live in Go, not in prompts. The governing rule is **code owns workflow**.

**An authoritative game server.** Games are portable directory packs of `rules.js`
(a deterministic rules script), `brains/*.js` (AI seats with declared capabilities),
and optional in-pack Python backends the gateway supervises and proxies. The server
holds authoritative state, runs the tick loop, and pushes SSE. Deterministic PRNG means
the same seed and the same command sequence produce the same ending — so you can change
a brain script, run N matches, and compare win rates.

Standout bits: backend services can observe and operate live matches through a
**match bridge** without any brain seat relaying for them; four credential tiers
(operator / service / player / per-match) that cannot reach into each other's scope;
and managed services that never inherit the gateway's credentials.

Two dependencies only: `gopkg.in/yaml.v3` and `github.com/buke/quickjs-go`.

## License

[MIT](LICENSE) © 2026 colisys
