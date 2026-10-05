#!/usr/bin/env bash
# DS峰谷钟 一键安装脚本（systemd）
#
# 用法：
#   sudo bash install.sh                       # 以 root 运行服务（默认）
#   sudo RUN_USER=dsfenggu bash install.sh     # 创建/复用专用系统用户运行（更安全）
#
# 可用环境变量：APP_DIR PORT HOST_BIND RUN_USER
#
# 设计要点：
#   1. 任何一步失败都打印可操作的诊断信息与回滚命令，而不是只抛 systemd 的原始错误；
#   2. 不吞掉 systemctl enable 的失败；
#   3. 重启后主动轮询 /healthz，确认服务真的可用（而不是 restart 返回 0 就当成功）。
#
# 说明：本脚本在开发机（Windows）无法执行验证，语法按标准 systemd 部署流程编写。
set -euo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
PORT="${PORT:-8787}"
HOST_BIND="${HOST_BIND:-0.0.0.0}"
RUN_USER="${RUN_USER:-}"
SERVICE_NAME="ds-fenggu"
UNIT="/etc/systemd/system/${SERVICE_NAME}.service"
REQUIRED=(server.js peak-valley-core.js peak-valley-feeds.js deepseek-peak-valley.html)

die(){ echo "错误：$*" >&2; exit 1; }

on_error(){
  local code=$?
  echo >&2
  echo "===== 安装失败（退出码 ${code}）—— 最近 30 行服务日志 =====" >&2
  journalctl -u "$SERVICE_NAME" -n 30 --no-pager 2>/dev/null || true
  echo >&2
  echo "排查建议：" >&2
  echo "  1) 端口是否被占用 ： ss -lntp | grep ${PORT}" >&2
  echo "  2) 前台手动试跑   ： cd ${APP_DIR} && PORT=${PORT} node server.js" >&2
  echo "  3) 彻底回滚       ： systemctl disable --now ${SERVICE_NAME}; rm -f ${UNIT}; systemctl daemon-reload" >&2
  exit "$code"
}
trap on_error ERR

[ "$(id -u)" -eq 0 ] || die "请用 root 运行：sudo bash install.sh"

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  die "未找到 node。请先安装 Node.js 18 或更高版本（低于 18 没有全局 fetch，联网校时会失效）"
fi
NODE_BIN="$(readlink -f "$NODE_BIN" 2>/dev/null || echo "$NODE_BIN")"

NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "警告：当前 Node 主版本为 ${NODE_MAJOR}（低于 18），联网校时与节假日同步将不可用，服务仍可运行。" >&2
fi

missing=0
for f in "${REQUIRED[@]}"; do
  if [ ! -f "$APP_DIR/$f" ]; then
    echo "缺少文件：$APP_DIR/$f" >&2
    missing=1
  fi
done
if [ "$missing" -ne 0 ]; then
  die "4 个运行文件必须放在同一目录（$APP_DIR）"
fi

# 可选的专用运行用户（不指定则沿用 root）
USER_LINES=""
if [ -n "$RUN_USER" ]; then
  if ! id -u "$RUN_USER" >/dev/null 2>&1; then
    useradd --system --no-create-home --shell /usr/sbin/nologin "$RUN_USER" \
      || useradd --system --no-create-home --shell /sbin/nologin "$RUN_USER"
  fi
  chown -R "$RUN_USER" "$APP_DIR"
  USER_LINES="User=${RUN_USER}
Group=${RUN_USER}"
  echo "运行用户  : ${RUN_USER}（专用系统用户）"
else
  echo "运行用户  : root（如需更安全：sudo RUN_USER=dsfenggu bash install.sh）"
fi

echo "安装目录  : $APP_DIR"
echo "Node      : $NODE_BIN ($("$NODE_BIN" -v))"
echo "监听      : ${HOST_BIND}:${PORT}"

cat > "$UNIT" <<EOF
[Unit]
Description=DS峰谷钟 (DeepSeek peak/valley clock API)
Documentation=https://github.com/XinWKX/ds-fenggu
After=network-online.target
Wants=network-online.target

[Service]
${USER_LINES}
Type=simple
WorkingDirectory=$APP_DIR
ExecStart=$NODE_BIN server.js
Environment=PORT=$PORT
Environment=HOST=$HOST_BIND
Restart=always
RestartSec=3
# 加固：本服务只需读自己的目录并监听端口，不需要写系统任何位置
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=full
ProtectHome=yes
ProtectKernelTunables=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$SERVICE_NAME"          # 不再吞掉失败：enable 出问题应当让用户看到
systemctl restart "$SERVICE_NAME"

# restart 返回 0 只代表「发出成功」，必须自己确认服务真的能响应
ready=0
for i in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1; then ready=1; break; fi
  sleep 0.5
done
if [ "$ready" -ne 1 ]; then
  die "服务已启动但 /healthz 在 10 秒内没有响应（见上方日志与排查建议）"
fi

echo
echo "===== 服务状态 ====="
systemctl --no-pager --full status "$SERVICE_NAME" | head -n 12 || true

echo
echo "===== 接口自检 ====="
curl -sS "http://127.0.0.1:${PORT}/healthz" || true
echo
curl -sS "http://127.0.0.1:${PORT}/v1/fenggu.txt" || true
echo
echo "查看日志 ：journalctl -u ${SERVICE_NAME} -f"
echo "重启服务 ：systemctl restart ${SERVICE_NAME}"
echo "下一步   ：在 1Panel 网站 → 创建网站 → 反向代理，代理地址填 127.0.0.1:${PORT}（不要带 http://）"
