#!/bin/sh
# ============================================================================
# Container entrypoint (CHANGE-055 — Azure DEV / private-network deployment)
# ----------------------------------------------------------------------------
# 容器在 VNet 內，可直連私有 PostgreSQL。啟動順序：
#   1) bootstrap DB schema（若 public schema 為空，套用 prisma/init.sql）
#   2) essential seed（idempotent：roles / regions / cities / system user / admin / settings）
#   3) 啟動 Next.js standalone server
#
# 失敗即中止（set -e）—— 寧可開不起來也不要在 schema/seed 異常下對外服務。
# ============================================================================
set -e

echo "[entrypoint] Step 1/3: bootstrap database schema (if needed)"
node prisma/bootstrap-db.js

# (選用)一次性 schema 漂移修補 —— 由 RUN_SCHEMA_DRIFT_FIX=true 觸發,非致命(失敗不擋啟動)。
# 用途:bootstrap 只「空庫才建表」、不遷移既有 DB;schema 演進(如 CHANGE-086 加欄位)後,
# 既有 DB 需以此補上增量 DDL(冪等、保留資料)。補完後把旗標設回 false。
if [ "$RUN_SCHEMA_DRIFT_FIX" = "true" ]; then
  echo "[entrypoint] (optional) applying schema drift fixes"
  node prisma/apply-schema-drift.js || echo "[entrypoint] schema drift fix failed (non-fatal), continuing"
fi

echo "[entrypoint] Step 2/3: run essential seed (idempotent)"
node prisma/dist/seed-prod-essential.js

# (選用)一次性業務資料匯入 —— 由 RUN_DEV_DATA_IMPORT=true 觸發,非致命(失敗不擋啟動)。
# 冪等:companies 已有資料則略過。匯入成功後可把 RUN_DEV_DATA_IMPORT 移除/設 false。
if [ "$RUN_DEV_DATA_IMPORT" = "true" ]; then
  echo "[entrypoint] (optional) importing dev business data"
  node prisma/import-dev-data.js || echo "[entrypoint] dev data import failed (non-fatal), continuing"
fi

echo "[entrypoint] Step 3/3: starting Next.js server"
exec node server.js
