# 完全透传模式：/proxy/{provider}/... 与 /v1/chat/completions

## /proxy/{provider}/...：逐字节透传

网关只做两件事：**换 endpoint**（拼到 provider 的上游地址），**换鉴权**
（下游租户 key → 服务端上游 key）。其他全部原样转发：
method、path、query、headers、body 都不动；上游的状态码、headers、body
（含 SSE 流式）也原样返回。

```bash
# OpenAI 兼容上游：path 照抄官方文档即可
curl -N -X POST localhost:8080/proxy/openai/chat/completions \
  -H "Authorization: Bearer <租户key>" -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}],"stream":true}'

# 非 OpenAI 路径也行，只要上游有：query/自定义 header 都透传
curl localhost:8080/proxy/openai/models?limit=10 \
  -H "Authorization: Bearer <租户key>" -H "X-Custom: abc"
```

## /v1/chat/completions：透传 + 条件 model 映射

body 整体透传（`stream`、`tools`、`response_format`、`temperature` 等原样），
只有一个例外——`model` 字段的条件映射：

- provider 配了 `model` → 下游的 `model` 被覆盖（网关映射生效）；
- provider 没配 `model` → 遵从下游的 `model`，直通上游。

```bash
gwadmin llm upsert name=openai model=gpt-6-luna   # 之后所有请求强制用 gpt-6-luna
gwadmin llm upsert name=openai model=-            # 清掉，回到遵从下游
```

`provider` 选择器字段（网关扩展，非 OpenAI 标准）会被剥离，不转发：
`{"model":"m","messages":[...],"provider":"anthropic"}` → 选 anthropic 上游，
转发的 body 里没有 `provider`。

## 三种模式对比

| | `/proxy/{provider}/...` | `/v1/chat/completions` | `/v1/execute` |
| --- | --- | --- | --- |
| 请求体 | 逐字节透传 | 透传 + 条件 model 映射 | 网关编排语义 |
| provider 选择 | URL 路径 | body `provider` 字段 | `llm_provider` 字段 |
| 响应 | 上游原样 | 上游原样 | 网关 verdict |

新功能、流式、`response_format`、`tools` 等上游参数用透传模式零等待；
要网关做决策/门控才走 `/v1/execute`。

## 鉴权与审计

- 下游仍用租户 key（`gwadmin keys add <name>` 签发），网关鉴权通过后才转发；
  转发时 `Authorization` 替换为服务端该 provider 的上游 key，**租户 key 永不到上游**。
- `Connection`/`Transfer-Encoding` 等逐跳头、以及双方的 `Content-Length` 由网关处理，不转发。
- 每次透传记一条审计（`action=proxy`，含 tenant/provider/method/path/状态码/字节数），
  在 `/metrics` 的 recent 和日志里可查；计数进 `proxied` / `by_provider`。
- 超时取该 provider 的配置（默认 60s）；body 上限 256MB。
