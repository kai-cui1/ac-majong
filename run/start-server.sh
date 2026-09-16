#!/usr/bin/env bash
# 启动本地对局服务端（Node + TS + ws，mock 鉴权）
#   用法: ./run/start-server.sh [端口] [Bot数量]
#   默认端口 8080，3 个陪打 Bot，鉴权模式 mock（token 即 userId）
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${1:-8080}"
BOTS="${2:-3}"

cd "$ROOT"
echo "[start-server] 端口=$PORT Bot=$BOTS 鉴权=mock  目录=$ROOT"
PORT="$PORT" AUTO_BOTS="$BOTS" IDENTITY=mock pnpm --filter @ac-majong/server dev
