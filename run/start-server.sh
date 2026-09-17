#!/usr/bin/env bash
# 启动本地对局服务端（Node + TS + ws，mock 鉴权）
#
#   用法: ./run/start-server.sh [选项] [端口] [Bot数量]
#
#   选项:
#     -l, --log-level LEVEL  日志级别: silent|error|warn|info|debug|trace (默认 info)
#     -h, --help             显示帮助
#
#   日志级别说明:
#     silent  - 不输出任何日志
#     error   - 仅错误（落库失败、异常）
#     warn    - 错误 + 警告（非法操作、鉴权失败）
#     info    - 警告 + 生命周期事件（连接/房间/对局/胡牌/流局）  [默认]
#     debug   - info + 每个动作执行详情、Bot 决策
#     trace   - debug + 每条消息原始负载、动作缓冲细节
#
#   示例:
#     ./run/start-server.sh                    # 默认: 端口8080, 3Bot, info日志
#     ./run/start-server.sh -l debug           # 查看每个动作细节
#     ./run/start-server.sh -l trace 8081 2    # 全量跟踪，端口8081，2个Bot
#     ./run/start-server.sh --log-level error  # 只看错误
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_LEVEL="info"
POSITIONAL=()

# ─── 参数解析 ────────────────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    -l|--log-level)
      LOG_LEVEL="${2:-info}"
      shift 2
      ;;
    -h|--help)
      sed -n '2,24p' "$0" | sed 's/^#//'
      exit 0
      ;;
    -*)
      echo "❌ 未知选项: $1"
      echo "   使用 -h 查看帮助"
      exit 1
      ;;
    *)
      POSITIONAL+=("$1")
      shift
      ;;
  esac
done

PORT="${POSITIONAL[0]:-8080}"
BOTS="${POSITIONAL[1]:-3}"

# ─── 日志级别校验 ─────────────────────────────────────────────────────────────────────
case "$LOG_LEVEL" in
  silent|error|warn|info|debug|trace) ;;
  *)
    echo "❌ 无效日志级别: $LOG_LEVEL"
    echo "   可选: silent | error | warn | info | debug | trace"
    exit 1
    ;;
esac

# ─── 端口占用检测 ───────────────────────────────────────────────────────────────────────
if lsof -iTCP:"$PORT" -sTCP:LISTEN -t >/dev/null 2>&1; then
  echo ""
  echo "❌ [start-server] 错误：端口 $PORT 已被占用！"
  echo ""
  echo "占用该端口的进程信息："
  lsof -iTCP:"$PORT" -sTCP:LISTEN -P -n 2>/dev/null | awk 'NR==1{print; next} {printf "  PID=%-8s CMD=%s\n", $2, $1}'
  echo ""
  echo "🔧 解决方案（任选其一）："
  echo ""
  # 获取占用进程的 PID 列表
  PIDS=$(lsof -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | tr '\n' ' ')
  echo "  1) 终止占用进程后重新启动："
  echo "     kill $PIDS"
  echo "     # 如果 kill 无效，可强制终止："
  echo "     kill -9 $PIDS"
  echo ""
  echo "  2) 使用其他端口启动："
  echo "     ./run/start-server.sh 8081"
  echo ""
  exit 1
fi
# ─────────────────────────────────────────────────────────────────────────────────────────

cd "$ROOT"
echo "[start-server] 端口=$PORT Bot=$BOTS 鉴权=mock 日志=$LOG_LEVEL 目录=$ROOT"
PORT="$PORT" AUTO_BOTS="$BOTS" IDENTITY=mock LOG_LEVEL="$LOG_LEVEL" pnpm --filter @ac-majong/server dev
