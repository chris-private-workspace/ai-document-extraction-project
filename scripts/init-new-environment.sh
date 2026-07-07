#!/usr/bin/env bash
# =================================================================
# AI Document Extraction — 一鍵新環境初始化腳本（Unix / Git Bash）
# =================================================================
# 用法：
#   ./scripts/init-new-environment.sh
#
# 本腳本會執行 10 步：
#   1. 檢查必要軟體（node / npm / docker / git）
#   2. 複製 .env.example → .env（若不存在）
#   3. 啟動 docker-compose 服務
#   4. 等待 PostgreSQL healthy
#   5. 安裝 npm 依賴
#   6. 生成 Prisma Client
#   7. 清除 .next 快取（避免跨電腦舊路徑問題）
#   8. 同步 Schema（prisma db push）
#   9. 執行 Seed（prisma db seed）
#  10. 執行環境自檢（verify-environment）
#
# 安全性：
#   - 不覆寫既有 .env
#   - 偵測到非空資料庫時會詢問是否繼續執行 db push
#   - 失敗時立即中止並輸出明確訊息
#
# @since CHANGE-054 (2026-04-22)
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
ask()  { read -r -p "$1 [y/N] " response; [[ "$response" =~ ^[Yy]$ ]]; }

# ---- 確認當前目錄是專案根 ----
if [[ ! -f "package.json" ]] || [[ ! -f "prisma/schema.prisma" ]]; then
  fail "請在專案根目錄執行（找不到 package.json 或 prisma/schema.prisma）"
fi

echo "================================================================"
echo "🚀 AI Document Extraction — 新環境一鍵初始化"
echo "================================================================"

# =================================================================
# Step 1: 檢查必要軟體
# =================================================================
step 1 "檢查必要軟體"

check_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    fail "缺少必要軟體：$1（請先安裝）"
  fi
  ok "$1: $($1 --version 2>&1 | head -1)"
}
check_cmd node
check_cmd npm
check_cmd docker
check_cmd git

NODE_MAJOR="$(node -v | sed 's/v//' | cut -d. -f1)"
if [[ "$NODE_MAJOR" -lt 20 ]]; then
  warn "Node.js 版本 < 20，建議升級"
fi

# =================================================================
# Step 2: 複製 .env.example → .env（若不存在）
# =================================================================
step 2 "準備 .env 檔案"

if [[ -f ".env" ]]; then
  ok ".env 已存在，跳過（若新增變數請手動比對 .env.example）"
else
  cp .env.example .env
  ok "已從 .env.example 複製為 .env"
  warn "請編輯 .env 填入實際 Azure/OpenAI 憑證（🔴 必要變數的 placeholder 會被 verify-environment 偵測）"
fi

# =================================================================
# Step 3: 啟動 docker-compose
# =================================================================
step 3 "啟動 Docker 服務"

if ! docker info >/dev/null 2>&1; then
  fail "Docker 引擎無法連線；請啟動 Docker Desktop（若 DOCKER_HOST 指向錯誤可 unset DOCKER_HOST）"
fi

docker-compose up -d
ok "docker-compose up -d 執行完成"

# =================================================================
# Step 4: 等待 PostgreSQL healthy
# =================================================================
step 4 "等待 PostgreSQL healthy（最多 60 秒）"

WAIT_COUNT=0
MAX_WAIT=30
until docker exec ai-doc-extraction-db pg_isready -U postgres >/dev/null 2>&1; do
  WAIT_COUNT=$((WAIT_COUNT + 1))
  if [[ $WAIT_COUNT -ge $MAX_WAIT ]]; then
    fail "PostgreSQL 在 ${MAX_WAIT} 次輪詢後仍未 ready"
  fi
  printf '.'
  sleep 2
done
echo ""
ok "PostgreSQL ready"

# =================================================================
# Step 5: 安裝 npm 依賴
# =================================================================
step 5 "安裝 npm 依賴"

npm install
ok "依賴安裝完成"

# =================================================================
# Step 6: 生成 Prisma Client
# =================================================================
step 6 "生成 Prisma Client"

npx prisma generate
ok "Prisma Client 已生成"

# =================================================================
# Step 7: 清除 .next 快取
# =================================================================
step 7 "清除 .next 快取（避免跨電腦舊路徑問題）"

if [[ -d ".next" ]]; then
  rm -rf .next
  ok ".next 已清除"
else
  ok ".next 不存在，跳過"
fi

# =================================================================
# Step 8: 同步 Schema
# =================================================================
step 8 "同步 Prisma Schema 到資料庫"

# 偵測資料庫是否已有資料（僅檢查 users 表）
# 若已有資料，詢問是否繼續執行 db push --accept-data-loss
SKIP_DB_PUSH=0
if docker exec ai-doc-extraction-db psql -U postgres -d ai_document_extraction -tAc "SELECT 1 FROM information_schema.tables WHERE table_name = 'users';" 2>/dev/null | grep -q 1; then
  USER_COUNT="$(docker exec ai-doc-extraction-db psql -U postgres -d ai_document_extraction -tAc "SELECT COUNT(*) FROM users;" 2>/dev/null || echo 0)"
  if [[ "$USER_COUNT" -gt 0 ]]; then
    warn "資料庫已有 ${USER_COUNT} 筆 user 資料"
    if ask "是否繼續執行 prisma db push --accept-data-loss？（可能刪除欄位資料）"; then
      npx prisma db push --accept-data-loss
    else
      SKIP_DB_PUSH=1
      warn "跳過 db push（Schema 未同步；若有 schema 變更請手動執行：npx prisma db push）"
    fi
  else
    npx prisma db push --accept-data-loss
  fi
else
  npx prisma db push --accept-data-loss
fi

if [[ $SKIP_DB_PUSH -eq 0 ]]; then
  ok "Schema 同步完成"
fi

# =================================================================
# Step 9: 執行 Seed
# =================================================================
step 9 "執行 Seed"

npx prisma db seed
ok "Seed 完成"

# =================================================================
# Step 10: 環境自檢
# =================================================================
step 10 "環境自檢（verify-environment）"

if npm run verify-environment; then
  ok "自檢通過"
else
  warn "自檢發現問題，請查看上方訊息"
fi

# =================================================================
# 完成訊息
# =================================================================
echo ""
echo "================================================================"
echo -e "${GREEN}🎉 新環境初始化完成！${RESET}"
echo "================================================================"
echo ""
echo "📋 預設帳號："
echo "   管理員：  admin@ai-document-extraction.com / ChangeMe@2026!"
echo "   開發者：  dev@example.com（dev mode 登入，無需密碼）"
echo ""
echo "🚀 下一步："
echo "   ./scripts/start-dev.sh         # 統一啟動（Docker + PG 就緒檢查 + dev server，port 3200）"
echo "   npm run dev                    # 或僅啟動 dev server（預設 port 3200）"
echo ""
echo "📚 文件："
echo "   docs/06-deployment/01-local-deployment/project-initialization-guide.md"
echo "   docs/06-deployment/01-local-deployment/README.md  ← 本地部署索引"
echo ""
