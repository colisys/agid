# Admin：动态控制网关配置

Admin 默认关闭。设置 `ADMIN_TOKEN` 环境变量即启用全部 `/admin/*` 接口，
鉴权方式：`X-Admin-Token: <token>` 或 `Authorization: Bearer <token>`。

```bash
ADMIN_TOKEN=$(openssl rand -hex 24) go run ./cmd/gateway
```

## gwadmin CLI

```bash
export GATEWAY_URL=http://localhost:8080 ADMIN_TOKEN=...
go run ./cmd/gwadmin config            # 全量快照（密钥脱敏，只露首尾）
go run ./cmd/gwadmin secrets           # 各密钥 set/unset 状态
go run ./cmd/gwadmin changes           # 管理操作审计（最近500条）
go run ./cmd/gwadmin policies get
go run ./cmd/gwadmin policies set high_risk_allow_above=0.9 intent_human_below=0.6
go run ./cmd/gwadmin jev set endpoint=https://api.typesafe.ai/v1/systemone model_pin=jev-1.13.0 timeout_ms=15000
go run ./cmd/gwadmin jev set retry_max_attempts=4 retry_base_backoff_ms=300 retry_honor_retry_after=true
go run ./cmd/gwadmin jev rotate-key sk-new-key        # 即时生效，不重启
go run ./cmd/gwadmin llm list
go run ./cmd/gwadmin llm upsert [name=...] k=v ... # name 省略=改默认 provider
go run ./cmd/gwadmin llm remove old-provider          # 默认 provider 必须先切走
go run ./cmd/gwadmin keys list                        # 租户列表：name + 脱敏 key + 创建时间
go run ./cmd/gwadmin keys add acme                    # 给租户 acme 签发（自动生成，明文只显示一次）
go run ./cmd/gwadmin keys add acme gw_custom_1        # 或指定 key 明文
go run ./cmd/gwadmin keys revoke acme                 # 按名吊销（也支持按 key）
go run ./cmd/gwadmin reload                           # 从磁盘 yaml 重载（阈值/Jev/租户 keys）
```

字段接受 snake_case（`high_risk_allow_above`）或 Go 原名（`HighRiskAllowAbove`）。

## REST 接口

| 方法与路径 | 说明 |
| --- | --- |
| `GET /admin/config` | 全量快照：Jev 设置+模型pin、阈值、providers、网关 keys（全部脱敏） |
| `GET/PUT /admin/policies` | 阈值查看/热更新（带校验：范围[0,1]、高风险≥低风险） |
| `PATCH /admin/jev` | endpoint、model_pin、timeout_ms、retry（max_attempts 1–10） |
| `POST /admin/jev/key {api_key}` | 轮换 Jev key，即时生效 |
| `GET/POST/PUT/DELETE /admin/llm/providers` | provider 增删改查；`default:true` 切换默认 |
| `POST /admin/llm/keys {name, api_key}` | 轮换某 provider key |
| `POST/DELETE /admin/keys` | 租户 key 列表/签发/吊销（`{name, key?}`；revoke 按 `?name=` 或 `?key=`；明文只返回一次） |
| `GET /admin/secrets` | 各密钥状态（set(abcd***12)/unset，不返回明文） |
| `GET /admin/changes` | 管理审计日志 |
| `POST /admin/reload` | 从磁盘重载配置 |
| `GET /admin/packs` | 沿用旧路径：packs 列表（走北向鉴权，非 admin token） |

## 租户 key

- yaml 两种写法都支持：`tenants: [{name: acme, key: gw_...}]`（具名，推荐）和旧 `api_keys: [...]`（启动时自动转为 `legacy-xxxx` 租户）。
- 下游调用带 `Authorization: Bearer <租户key>`，网关按名鉴权；每次 `/v1/execute` 的审计（`/metrics` recent + 日志）都会带 `tenant` 名，方便按租户对账。
- 空租户列表 = 开放模式（legacy 行为），生产建议至少建一个租户 key 把门关上。

## 安全说明

- 默认 `server.listen: "127.0.0.1:8080"`（仅 loopback）。配合**空租户列表 = 开放模式**，
  本地 IDE/agent 调 `/v1/decide` 无需任何 Authorization 头——请求路径里没有密钥可泄露。
- 上游 Jev/LLM 密钥 + `ADMIN_TOKEN` 只存在于 systemd 服务的 600 权限 env 文件
  （`~/.config/gateway/env`），**不要**把它们 export 进 agent 可读的交互 shell；
  agent 若需 eval 环境确认，只能检查 `/healthz`，不能读密钥。
- 网关要暴露到局域网/公网时：把 `listen` 改为绑定到具体网卡，并配租户 key 关门；
  但此时 agent 不该自己带 key 发 curl——应走 MCP/IDE 工具让运行时注入鉴权。
- 密钥只进内存：snapshot/secrets/changes 一律脱敏（首4+尾2，其余 `***`）；`keys add` 生成的明文只返回一次。
- 变更全部记入审计（action+detail+时间），可在 `/admin/changes` 回溯。
