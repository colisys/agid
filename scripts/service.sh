#!/usr/bin/env bash
#
# gateway 用户级服务管理脚本
#
#   scripts/service.sh build                # 仅构建 bin/gateway + bin/gwadmin
#   scripts/service.sh install [--port N] [--start]
#                                           # 构建 + 停旧服务 + 安装 + 按需启动
#                                           # （服务已在运行则自动重启，确保新二进制生效）
#   scripts/service.sh uninstall [--purge]  # 停止并移除服务；--purge 连二进制/配置/密钥一起删
#   scripts/service.sh start|stop|restart|status|enable|disable
#   scripts/service.sh logs [-f]            # 查看服务日志
#   scripts/service.sh compose              # 调 /admin/compose 生成 data/compose-<主机名>.yml
#   scripts/service.sh show                 # 显示各文件位置
#
# 约定路径：
#   二进制  ~/.local/bin/gateway, ~/.local/bin/gwadmin
#   配置    ~/.config/gateway/gateway.yaml
#   密钥    ~/.config/gateway/env (600 权限：PORT / TYPESAFE_API_KEY / LLM_API_KEY / ADMIN_TOKEN)
#   服务    ~/.config/systemd/user/gateway.service
#
set -euo pipefail

SERVICE=gateway
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="$ROOT/bin"
DEST_BIN="$HOME/.local/bin"
APP_DIR="$HOME/.config/gateway"
ENV_FILE="$APP_DIR/env"
CONF_FILE="$APP_DIR/gateway.yaml"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT_FILE="$UNIT_DIR/$SERVICE.service"

die() { echo "error: $*" >&2; exit 1; }
info() { echo "--> $*"; }
need_cmd() { command -v "$1" >/dev/null 2>&1 || die "缺少命令: $1"; }
need_systemd() {
  need_cmd systemctl
  systemctl --user list-units >/dev/null 2>&1 || die "用户级 systemd 不可用（尝试 loginctl enable-linger \$USER）"
}

build() {
  need_cmd go
  info "构建 gateway + gwadmin ..."
  mkdir -p "$BIN_DIR"
  (cd "$ROOT" && go build -trimpath -ldflags="-s -w" -o "$BIN_DIR/gateway" ./cmd/gateway)
  (cd "$ROOT" && go build -trimpath -ldflags="-s -w" -o "$BIN_DIR/gwadmin" ./cmd/gwadmin)
  info "产物: $BIN_DIR/gateway $BIN_DIR/gwadmin"
}

seed_config() {
  mkdir -p "$APP_DIR"
  if [[ ! -f "$CONF_FILE" ]]; then
    cp "$ROOT/configs/gateway.yaml" "$CONF_FILE"
    chmod 644 "$CONF_FILE"
    info "已创建配置: $CONF_FILE（按需修改后 service.sh restart）"
    absolutize_config
    return
  fi
  # Backfill the games section for configs seeded before it existed; without
  # it the game server is disabled (Games.Dir empty) and /v1/games 404s.
  if ! grep -q '^games:' "$CONF_FILE"; then
    cat >> "$CONF_FILE" <<EOF

games:
  # comma-separated roots; each holds one folder per game (<root>/<game>/rules.js)
  games_dir: "$ROOT/examples,$ROOT/scripts/games"
  data_root: "$ROOT/data"
  default_tick_ms: 500
  max_matches: 100
  replay_cap: 2000
  webhook_url: ""
  webhook_secret: ""
EOF
    info "已补写 games 段到 $CONF_FILE（restart 后生效）"
  fi
  absolutize_config
}

# 相对路径依赖进程 cwd。systemd 单元没有 WorkingDirectory，用户级服务的默认
# cwd 是 $HOME —— 于是 games_dir 指向 $HOME/examples（不存在，游戏包一个都加载
# 不到），data_root 也会解析到 $HOME/data 而不是仓库。安装时把这两个键改写成
# 绝对路径，新旧配置都过一遍。
absolutize_config() {
  [[ -f "$CONF_FILE" ]] || return 0
  command -v python3 >/dev/null 2>&1 || return 0
  python3 - "$CONF_FILE" "$ROOT" <<'PY'
import re, sys
path, root = sys.argv[1], sys.argv[2]
src = open(path, encoding="utf-8").read()

def abs_roots(m):
    vals = [v.strip() for v in m.group(2).split(",") if v.strip()]
    out = ",".join(v if v.startswith("/") else root + "/" + v for v in vals)
    return m.group(1) + '"' + out + '"'

src = re.sub(r'^([ \t]*games_dir:[ \t]*)"([^"]*)"[ \t]*$', abs_roots, src, flags=re.M)

def abs_data(m):
    v = m.group(2).strip()
    if v and not v.startswith("/"):
        v = root + "/" + v
    return m.group(1) + '"' + (v or root + "/data") + '"'

src, n = re.subn(r'^([ \t]*data_root:[ \t]*)"?([^"\n]*)"?[ \t]*$', abs_data, src, flags=re.M)
if n == 0 and re.search(r'^games:', src, flags=re.M):
    # The games section exists but predates data_root.
    src = re.sub(r'^([ \t]*default_tick_ms:)', r'\1', src, flags=re.M)
    src = re.sub(r'^games:[ \t]*$', 'games:\n  data_root: "' + root + '/data"', src, flags=re.M, count=1)
open(path, "w", encoding="utf-8").write(src)
PY
  info "已把 games_dir / data_root 规范为绝对路径: $CONF_FILE"
}

seed_env() {
  # With no argument, only create the file when missing; never rewrite an
  # existing PORT (so a plain `install` does not move a running service).
  local port="${1:-8080}"
  mkdir -p "$APP_DIR"
  if [[ ! -f "$ENV_FILE" ]]; then
    local token
    token="$(openssl rand -hex 24)"
    cat > "$ENV_FILE" <<EOF
# gateway 用户级服务环境变量（请勿提交到 git）
PORT=$port
TYPESAFE_API_KEY=
LLM_API_KEY=
ADMIN_TOKEN=$token
EOF
    chmod 600 "$ENV_FILE"
    info "已创建密钥文件: $ENV_FILE"
    echo "    ADMIN_TOKEN=$token"
    echo "    请填入 TYPESAFE_API_KEY / LLM_API_KEY 后再 start"
    return
  fi
  [[ $# -eq 0 ]] && return 0
  if grep -q '^PORT=' "$ENV_FILE"; then
    local cur
    cur="$(grep '^PORT=' "$ENV_FILE" | tail -1 | cut -d= -f2 || true)"
    if [[ "$cur" != "$port" ]]; then
      sed -i "s/^PORT=.*/PORT=$port/" "$ENV_FILE"
      info "已更新端口: PORT=$cur -> $port（restart 后生效）"
    fi
  else
    echo "PORT=$port" >> "$ENV_FILE"
    info "已追加端口: PORT=$port（restart 后生效）"
  fi
}

write_unit() {
  mkdir -p "$UNIT_DIR"
  cat > "$UNIT_FILE" <<EOF
[Unit]
Description=Universal Gateway (Jev decision + multi-LLM orchestration)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$DEST_BIN/gateway --config $CONF_FILE
EnvironmentFile=-$ENV_FILE
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=default.target
EOF
  info "已写入服务单元: $UNIT_FILE"
}

install_service() {
  local port=8080 port_set=0 start_now=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --port) port="${2:?--port 需要端口号}"; port_set=1; shift 2 ;;
      --start) start_now=1; shift ;;
      *) die "install 未知参数: $1（用法: install [--port N] [--start]）" ;;
    esac
  done
  need_cmd openssl
  need_systemd
  local was_active=0
  if systemctl --user is-active --quiet "$SERVICE" 2>/dev/null; then
    was_active=1
    info "检测到服务正在运行，先停止 ..."
    systemctl --user stop "$SERVICE"
  fi
  build
  mkdir -p "$DEST_BIN"
  install -m755 "$BIN_DIR/gateway" "$DEST_BIN/gateway"
  install -m755 "$BIN_DIR/gwadmin" "$DEST_BIN/gwadmin"
  seed_config
  if [[ "$port_set" -eq 1 ]]; then
    seed_env "$port"
  else
    seed_env   # keep the existing port when --port was not given
  fi
  write_unit
  systemctl --user daemon-reload
  info "安装完成"
  show_paths
  if [[ "$start_now" -eq 1 ]]; then
    systemctl --user enable --now "$SERVICE"
    info "服务已启动"
  elif [[ "$was_active" -eq 1 ]]; then
    systemctl --user start "$SERVICE"
    info "服务已重启（新二进制生效）"
  else
    echo "用以下命令启用并启动："
    echo "  scripts/service.sh enable --now   # 或 start"
  fi
}

uninstall_service() {
  local purge=0
  [[ "${1:-}" == "--purge" ]] && purge=1
  need_systemd
  info "停止并移除用户级服务 ..."
  systemctl --user stop "$SERVICE" 2>/dev/null || true
  systemctl --user disable "$SERVICE" 2>/dev/null || true
  rm -f "$UNIT_FILE"
  systemctl --user daemon-reload
  systemctl --user reset-failed "$SERVICE" 2>/dev/null || true
  if [[ "$purge" -eq 1 ]]; then
    rm -f "$DEST_BIN/gateway" "$DEST_BIN/gwadmin"
    rm -rf "$APP_DIR"
    info "已删除二进制、配置与密钥文件（--purge）"
  else
    echo "保留: $DEST_BIN/gateway $DEST_BIN/gwadmin $APP_DIR（如需全删，用 uninstall --purge）"
  fi
  info "卸载完成"
}

usage() {
  sed -n '2,/^$/p' "$0" | sed 's/^# \?//'
  exit "${1:-0}"
}

show_paths() {
  local port="(unset)"
  [[ -f "$ENV_FILE" ]] && port="$(grep '^PORT=' "$ENV_FILE" | tail -1 | cut -d= -f2 || true)"
  echo "服务    http://localhost:${port} (gwadmin 默认直连，无需 GATEWAY_URL)"
  echo "二进制  $DEST_BIN/gateway $DEST_BIN/gwadmin"
  echo "配置    $CONF_FILE"
  echo "密钥    $ENV_FILE"
  echo "服务    $UNIT_FILE"
}

compose_file() {
  need_cmd curl
  [[ -f "$ENV_FILE" ]] || die "缺少密钥文件: $ENV_FILE（先 install）"
  local port token
  port="$(grep '^PORT=' "$ENV_FILE" | tail -1 | cut -d= -f2 || true)"
  [[ -n "$port" ]] || die "$ENV_FILE 里没有 PORT"
  token="$(grep '^ADMIN_TOKEN=' "$ENV_FILE" | tail -1 | cut -d= -f2- || true)"
  [[ -n "$token" ]] || die "$ENV_FILE 里没有 ADMIN_TOKEN"
  # 多个游戏 host 各自生成编排：按主机名落盘，互不覆盖（volume 用绝对路径，
  # compose 文件放哪个目录都能正确挂载）。
  local hostslug
  hostslug="$(hostname -s 2>/dev/null || hostname)"
  local out="${1:-$ROOT/data/compose-${hostslug}.yml}"
  mkdir -p "$(dirname "$out")"
  info "请求 http://127.0.0.1:$port/admin/compose ..."
  local resp
  resp="$(curl -sf -X POST "http://127.0.0.1:$port/admin/compose" -H "X-Admin-Token: $token")" \
    || die "请求失败（服务未启动或 token 不对）"
  need_cmd python3
  echo "$resp" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("yaml") or "", end="")' > "$out"
  # 凭据单独落 600 的 env 文件，不写进 compose（compose 是可读/可分享的产物）。
  local envdir
  envdir="$(dirname "$out")"
  echo "$resp" | ENV_DIR="$envdir" python3 -c '
import json, os, sys
d = json.load(sys.stdin)
envdir = os.environ["ENV_DIR"]
for name, body in (d.get("env_files") or {}).items():
    p = os.path.join(envdir, name)
    with open(p, "w", encoding="utf-8") as f:
        f.write(body)
    os.chmod(p, 0o600)
    print("    凭据文件(600): " + p)
'
  info "已生成 $out（$(echo "$resp" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("services", 0))') 个服务）"
  echo "    启动: docker compose -f $out up -d"
}

cmd="${1:-}"; shift || true
case "$cmd" in
  build) build ;;
  install) install_service "$@" ;;
  uninstall) uninstall_service "$@" ;;
  start|stop|restart|enable|disable)
    need_systemd
    if [[ "$cmd" == "enable" && "${1:-}" == "--now" ]]; then
      systemctl --user enable --now "$SERVICE"
    else
      systemctl --user "$cmd" "$SERVICE"
    fi ;;
  status) need_systemd; systemctl --user status "$SERVICE" --no-pager || true ;;
  logs)
    need_cmd journalctl
    if [[ "${1:-}" == "-f" ]]; then journalctl --user -u "$SERVICE" -f
    else journalctl --user -u "$SERVICE" -n 100 --no-pager; fi ;;
  show)
    show_paths ;;
  compose)
    compose_file "$@" ;;
  -h|--help|help|"") usage 0 ;;
  *) usage 1 ;;
esac
