#!/usr/bin/env bash
# =================================================================
# AI Document Extraction — 統一開發啟動腳本（Unix / Git Bash）
# =================================================================
# 用法：
#   ./scripts/start-dev.sh                 # 預設 port 3200
#   ./scripts/start-dev.sh -p 3300         # 指定端口
#   ./scripts/start-dev.sh --generate      # 強制重新生成 Prisma Client
#   ./scripts/start-dev.sh --clean         # 啟動前清除 .next 快取
#   ./scripts/start-dev.sh --skip-docker   # Docker 已在運行時跳過啟動
#
# 本腳本會執行：
#   1. 檢查 Docker 引擎並啟動 docker-compose 服務（除非 --skip-docker）
#   2. 等待 PostgreSQL healthy
#   3. 視需要生成 Prisma Client（偵測未生成 或 --generate 時）
#   4. 可選清除 .next 快取（--clean）
#   5. 檢查目標端口是否被佔用（僅提示，不自動終止進程）
#   6. 前景啟動 Next.js dev server（Ctrl+C 可停止）
#
# 說明：
#   - 供開發者在終端手動執行；dev server 以前景方式啟動。
#   - 首次/新環境完整初始化（含 npm install / db push / seed）請改用
#     scripts/init-new-environment.sh。
#
# @since CHANGE-096 (2026-07-07)
# =================================================================

set -euo pipefail

# ---- 顏色輸出 ----
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
RESET='\033[0m'

step() { echo -e "\n${BLUE}==▶ Step $1: $2${RESET}"; }
ok()   { echo -e "${GREEN}  ✅ $1${RESET}"; }
warn() { echo -e "${YELLOW}  ⚠️  $1${RESET}"; }
fail() { echo -e "${RED}  ❌ $1${RESET}" >&2; exit 1; }

# ---- 參數解析 ----
PORT=3200
GENERATE=0
CLEAN=0
SKIP_DOCKER=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    -p|--port)      PORT="$2"; shift 2;;
    --generate)     GENERATE=1; shift;;
    --clean)        CLEAN=1; shift;;
    --skip-docker)  SKIP_DOCKER=1; shift;;
    *)              fail "未知參數：$1";;
  esac
done

# ---- 確認當前目錄是專案根 ----
if [[ ! -f "package.json" ]] || [[ ! -f "prisma/schema.prisma" ]]; then
  fail "請在專案根目錄執行（找不到 package.json 或 prisma/schema.prisma）"
fi

echo "================================================================"
echo "🚀 AI Document Extraction — 統一開發啟動（port ${PORT}）"
echo "================================================================"

# =================================================================
# Step 1: 檢查 Docker 並啟動服務
# =================================================================
if [[ $SKIP_DOCKER -eq 1 ]]; then
  step 1 "跳過 Docker 啟動（--skip-docker）"
  ok "假設 docker-compose 服務已在運行"
else
  step 1 "啟動 Docker 服務"

  if ! docker info >/dev/null 2>&1; then
    fail "Docker 引擎無法連線；請啟動 Docker Desktop（若 DOCKER_HOST 指向錯誤可 unset DOCKER_HOST）"
  fi

  docker-compose up -d
  ok "docker-compose up -d 執行完成"
fi

# =================================================================
# Step 2: 等待 PostgreSQL healthy
# =================================================================
step 2 "等待 PostgreSQL healthy（最多 60 秒）"

WAIT_COUNT=0
MAX_WAIT=30
until docker exec ai-doc-extraction-db pg_isready -U postgres >/dev/null 2>&1; do
  WAIT_COUNT=$((WAIT_COUNT + 1))
  if [[ $WAIT_COUNT -ge $MAX_WAIT ]]; then
    fail "PostgreSQL 在 ${MAX_WAIT} 次輪詢後仍未 ready（請確認容器 ai-doc-extraction-db 狀態）"
  fi
  printf '.'
  sleep 2
done
echo ""
ok "PostgreSQL ready"

# =================================================================
# Step 3: 視需要生成 Prisma Client
# =================================================================
step 3 "檢查 Prisma Client"

if [[ $GENERATE -eq 1 ]] || [[ ! -d "node_modules/.prisma/client" ]]; then
  if [[ $GENERATE -eq 1 ]]; then
    warn "指定 --generate，強制重新生成"
  else
    warn "未偵測到已生成的 Prisma Client（node_modules/.prisma/client），自動生成中"
  fi
  npx prisma generate
  ok "Prisma Client 已生成"
else
  ok "Prisma Client 已存在（如 schema 有變更請加 --generate）"
fi

# =================================================================
# Step 4: 清除 .next 快取（可選）
# =================================================================
if [[ $CLEAN -eq 1 ]]; then
  step 4 "清除 .next 快取（--clean）"
  if [[ -d ".next" ]]; then
    rm -rf .next
    ok ".next 已清除"
  else
    ok ".next 不存在，跳過"
  fi
fi

# =================================================================
# Step 5: 檢查端口佔用（best-effort）
# =================================================================
step 5 "檢查端口 ${PORT}"

PORT_PID=""
if command -v lsof >/dev/null 2>&1; then
  PORT_PID="$(lsof -tiTCP:"${PORT}" -sTCP:LISTEN 2>/dev/null | head -1 || true)"
elif command -v netstat >/dev/null 2>&1; then
  # Windows netstat（Git Bash）：擷取 LISTENING 行的最後一欄 PID
  PORT_PID="$(netstat -ano 2>/dev/null | grep ":${PORT} " | grep -i 'LISTENING' | awk '{print $NF}' | head -1 || true)"
fi

if [[ -n "$PORT_PID" ]]; then
  warn "端口 ${PORT} 已被進程佔用（PID ${PORT_PID}）"
  fail "請先停止該進程，或改用其他端口（-p <其他>）"
fi
ok "端口 ${PORT} 可用"

# =================================================================
# Step 6: 啟動 Next.js dev server（前景）
# =================================================================
step 6 "啟動 Next.js dev server（port ${PORT}，Ctrl+C 可停止）"
echo ""

exec npm run dev -- -p "${PORT}"
