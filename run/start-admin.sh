#!/usr/bin/env bash
# start-admin.sh — 一键启动 AC 麻将 Admin 后台（前端 admin-web + 后端 admin-server）
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_LEVEL="info"
API_PORT="8090"
WEB_PORT="5173"
DO_MIGRATE=0

usage() {
  cat <<'EOF'

start-admin.sh — 一键启动 Admin 后台（后端 admin-server + 前端 admin-web）

用法:
  ./run/start-admin.sh [选项]

选项:
  -l, --log-level LEVEL  后端日志级别: silent|error|warn|info|debug|trace (默认 info)
      --api-port PORT    后端 admin-server 端口 (默认 8090)
      --web-port PORT    前端 admin-web 端口 (默认 5173)
      --migrate          启动前先跑 db:migrate 建/更新 admin 表（drizzle，幂等）
  -h, --help             显示本帮助

日志级别说明（仅作用于后端 admin-server，与 start-server.sh 一致）:
  silent  - 不输出任何日志
  error   - 仅错误
  warn    - 错误 + 警告
  info    - 警告 + 生命周期事件（启动/请求）  [默认]
  debug   - info + 细节
  trace   - 最高粒度

前置依赖:
  1) MySQL + Redis 已启动:   cd deploy && docker compose up -d
  2) 后端配置已就绪:         cp apps/admin-server/.env.example apps/admin-server/.env
  3) 首次建 admin 表:        ./run/start-admin.sh --migrate
     （或手动 pnpm --filter @ac-majong/persistence db:migrate）

示例:
  ./run/start-admin.sh                     # 前后端一起起（8090 + 5173，info 日志）
  ./run/start-admin.sh -l debug            # 后端 debug 日志
  ./run/start-admin.sh --migrate           # 先建表再启动
  ./run/start-admin.sh --web-port 5174     # 前端换端口

说明:
  · 前端 admin-web 通过 vite 代理 /api → 127.0.0.1:8090（vite.config.ts 硬编码）；
    若用 --api-port 改了后端端口，需同步改 apps/admin-web/vite.config.ts 的 proxy target。
  · 登录账号来自 .env 的 ADMIN_BOOTSTRAP_USERNAME / ADMIN_BOOTSTRAP_PASSWORD（首次自动建超管）。
  · Ctrl+C 一并停止前后端；后端启动失败（如 DB 未就绪）会自动收尾前端。

EOF
}

# ─── 参数解析 ────────────────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    -l|--log-level) LOG_LEVEL="${2:-info}"; shift 2 ;;
    --api-port)     API_PORT="${2:-8090}";  shift 2 ;;
    --web-port)     WEB_PORT="${2:-5173}";  shift 2 ;;
    --migrate)      DO_MIGRATE=1;           shift   ;;
    -h|--help)      usage; exit 0 ;;
    *) echo "❌ 未知选项: $1"; echo "   使用 -h 查看帮助"; exit 1 ;;
  esac
done

# ─── 日志级别校验 ─────────────────────────────────────────────────────────────────────
case "$LOG_LEVEL" in
  silent|error|warn|info|debug|trace) ;;
  *)
    echo "❌ 无效日志级别: $LOG_LEVEL"
    echo "   可选: silent | error | warn | info | debug | trace"
    exit 1
    ;;
esac

# ─── 端口占用检测（前后端两个端口都查）─────────────────────────────────────────────────
check_port() {
  local port="$1" label="$2" hint="$3" pids
  if lsof -iTCP:"$port" -sTCP:LISTEN -t >/dev/null 2>&1; then
    echo ""
    echo "❌ [start-admin] 错误：${label} 端口 $port 已被占用！"
    echo ""
    echo "占用该端口的进程信息："
    lsof -iTCP:"$port" -sTCP:LISTEN -P -n 2>/dev/null | awk 'NR==1{print; next} {printf "  PID=%-8s CMD=%s\n", $2, $1}'
    echo ""
    pids=$(lsof -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | tr '\n' ' ')
    echo "🔧 解决方案（任选其一）："
    echo "  1) 终止占用进程：  kill ${pids}  （无效则 kill -9 ${pids}）"
    echo "  2) 换端口启动：    $hint"
    echo ""
    exit 1
  fi
}
check_port "$API_PORT" "后端 admin-server" "./run/start-admin.sh --api-port 8091"
check_port "$WEB_PORT" "前端 admin-web"    "./run/start-admin.sh --web-port 5174"

# ─── 后端 .env 检查（admin-server 无内存回退，缺配置会直接崩）──────────────────────────
ADMIN_ENV="$ROOT/apps/admin-server/.env"
if [[ ! -f "$ADMIN_ENV" ]]; then
  echo ""
  echo "❌ [start-admin] 缺少后端配置: apps/admin-server/.env"
  echo "   admin-server 需要 DATABASE_URL / SESSION_SECRET（无内存回退），请先执行："
  echo "     cp apps/admin-server/.env.example apps/admin-server/.env"
  echo "   然后按需修改其中的数据库 / 密钥配置。"
  echo ""
  exit 1
fi

cd "$ROOT"

# ─── 可选：建 / 更新 admin 表（drizzle-kit migrate，幂等）──────────────────────────────
if [[ "$DO_MIGRATE" == "1" ]]; then
  echo "[start-admin] 执行 db:migrate（drizzle-kit）..."
  pnpm --filter @ac-majong/persistence db:migrate
fi

# ─── --api-port 改了但 vite 代理硬编码 8090 → 提示 ─────────────────────────────────────
if [[ "$API_PORT" != "8090" ]]; then
  echo "⚠️  [start-admin] 后端端口改为 ${API_PORT}，但 admin-web 的 /api 代理在 vite.config.ts 中硬编码为 8090；"
  echo "    如需前端正常调后端，请同步修改 apps/admin-web/vite.config.ts 的 proxy target。"
fi

echo "[start-admin] 后端=$API_PORT 前端=$WEB_PORT 日志=$LOG_LEVEL migrate=$([[ "$DO_MIGRATE" == "1" ]] && echo on || echo off) 目录=$ROOT"
echo "[start-admin] 前端访问: http://localhost:$WEB_PORT    （Ctrl+C 一并停止前后端）"

# ─── 启动前后端（后台并行 + 退出清理）────────────────────────────────────────────────────
BACK_PID=""
FRONT_PID=""
cleanup() {
  trap - INT TERM EXIT
  if [[ -n "$BACK_PID" ]];  then kill "$BACK_PID"  2>/dev/null || true; fi
  if [[ -n "$FRONT_PID" ]]; then kill "$FRONT_PID" 2>/dev/null || true; fi
  wait 2>/dev/null || true
}
trap cleanup INT TERM EXIT

# 后端：PORT / LOG_LEVEL 走命令行（优先级高于 .env），其余配置由 apps/admin-server/.env 提供
PORT="$API_PORT" LOG_LEVEL="$LOG_LEVEL" \
  pnpm --filter @ac-majong/admin-server start &
BACK_PID=$!

# 前端：vite 指定端口（--strictPort 端口被占则直接报错，不自动跳号）
pnpm --filter @ac-majong/admin-web exec vite --port "$WEB_PORT" --strictPort &
FRONT_PID=$!

# 后端退出（多为启动失败：DB 未就绪 / 配置缺失 / 端口冲突）即触发整体收尾；
# 正常运行时 wait 阻塞，Ctrl+C 由 trap 统一清理前后端。
wait "$BACK_PID" || true
echo ""
echo "[start-admin] 后端进程已退出，正在停止前端..."
