#!/usr/bin/env bash
# start-client.sh — 启动「全新独立浏览器客户端窗口」（手动登录版，封装 scripts/open-player.mjs）
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  cat <<'EOF'

start-client.sh — 启动一个全新独立浏览器客户端窗口（不自动登录/不自动入座）

用法:
  ./run/start-client.sh [窗口名] [选项]

参数:
  窗口名      可选，默认 manual；仅用于临时 profile 目录前缀与日志标识（多窗口区分）

选项:
  --port PORT   客户端页面端口（默认 7456 = Cocos 编辑器预览站，脚本改动 reimport 后即生效；
                8081 = build/web-mobile 构建产物静态站，代码改动需先跑 CLI 构建才更新）
  --page URL    直接指定 H5 地址（覆盖 --port 推导的默认地址）
  -h, --help    显示本帮助

示例:
  ./run/start-client.sh                    # 开一个独立窗口（7456 预览站，最新代码）
  ./run/start-client.sh seat2              # 窗口名 seat2（多窗口区分）
  ./run/start-client.sh --port 8081        # 指向构建产物静态站

说明:
  · 每次运行 = 全新临时 profile：无残留登录态/会话免密复登，登录与注册在窗口内手动完成
  · 脚本开窗后立即退出，浏览器继续运行；切到对应窗口即可操作
  · 7456 预览站需 Cocos 编辑器在跑；8081 静态站服务 build/web-mobile 产物（先跑 CLI 构建，带 startScene）
  · 多真人同房前提：server 以 0 Bot 启动（./run/start-server.sh 默认已是 0）；
    需要陪玩由房主在房间等待页手动加 Bot

EOF
}

if [[ $# -gt 0 && ( "$1" == "-h" || "$1" == "--help" ) ]]; then
  usage
  exit 0
fi

exec node "$ROOT/scripts/open-player.mjs" "$@"
