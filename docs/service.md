# 服务运维：scripts/service.sh

用户级 systemd 服务管理。要求：Linux + `systemd --user` 可用（本机已确认）。

## 命令

```bash
scripts/service.sh build                  # 仅构建到 ./bin/
scripts/service.sh install [--port N] [--start]
scripts/service.sh start|stop|restart|status|enable|disable
scripts/service.sh logs [-f]              # journalctl 看日志
scripts/service.sh show                   # 各文件位置
scripts/service.sh uninstall [--purge]    # 移除服务；--purge 连二进制/配置/密钥全删
```

## 路径约定

| 内容 | 路径 |
| --- | --- |
| 二进制 | `~/.local/bin/gateway`、`~/.local/bin/gwadmin` |
| 配置 | `~/.config/gateway/gateway.yaml`（首次 install 从仓库 `configs/gateway.yaml` 复制） |
| 密钥 | `~/.config/gateway/env`（600 权限，`PORT` / `TYPESAFE_API_KEY` / `LLM_API_KEY` / `ADMIN_TOKEN`） |
| 服务单元 | `~/.config/systemd/user/gateway.service` |

## 典型流程

```bash
scripts/service.sh install --port 8080 --start
# 首次会生成 ADMIN_TOKEN 并提示填 TYPESAFE_API_KEY / LLM_API_KEY：
vim ~/.config/gateway/env
scripts/service.sh restart
curl localhost:8080/healthz

# 日常改阈值/轮换密钥走 admin，不用动服务：
export GATEWAY_URL=http://localhost:8080 ADMIN_TOKEN=$(grep ADMIN_TOKEN ~/.config/gateway/env | cut -d= -f2)
gwadmin policies set high_risk_allow_above=0.9
gwadmin jev rotate-key sk-new

# 改了 ~/.config/gateway/gateway.yaml 才需要 restart；uninstall 默认保留配置和密钥
scripts/service.sh uninstall            # 停服+删单元，保留二进制/配置
scripts/service.sh uninstall --purge    # 全删，注意 ADMIN_TOKEN 会丢失
```

开机自启：`scripts/service.sh enable`（等价 `systemctl --user enable`，需 `loginctl enable-linger $USER` 保证注销后仍运行）。
