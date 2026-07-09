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

# (選用)一次性 email_verified backfill —— 由 RUN_EMAIL_VERIFIED_BACKFILL=true 觸發,非致命。
# FIX-092: FIX-090 前建立的本地帳號 email_verified 為 null、又因 Azure 無 SMTP 收不到
# 驗證信而無法登入;此步驟把有密碼但未驗證的本地帳號補為已驗證(冪等)。補完後設回 false。
if [ "$RUN_EMAIL_VERIFIED_BACKFILL" = "true" ]; then
  echo "[entrypoint] (optional) backfilling email_verified for local accounts"
  node prisma/backfill-email-verified.js || echo "[entrypoint] email_verified backfill failed (non-fatal), continuing"
fi

# (選用)一次性授予 Global Admin —— 設 GRANT_GLOBAL_ADMIN_EMAIL=<email> 才跑,非致命。
# isGlobalAdmin 是 User 欄位(auth 用它判全域權限)、admin UI 的 PATCH 改不了;此步驟把指定
# 帳號 is_global_admin 設為 true(冪等)。完成後清空 GRANT_GLOBAL_ADMIN_EMAIL;被授權者需重新登入。
if [ -n "$GRANT_GLOBAL_ADMIN_EMAIL" ]; then
  echo "[entrypoint] (optional) granting global admin"
  node prisma/grant-global-admin.js || echo "[entrypoint] grant global admin failed (non-fatal), continuing"
fi

# (選用)一次性業務資料匯入 —— 由 RUN_DEV_DATA_IMPORT=true 觸發,非致命(失敗不擋啟動)。
# 冪等:companies 已有資料則略過。匯入成功後可把 RUN_DEV_DATA_IMPORT 移除/設 false。
if [ "$RUN_DEV_DATA_IMPORT" = "true" ]; then
  echo "[entrypoint] (optional) importing dev business data"
  node prisma/import-dev-data.js || echo "[entrypoint] dev data import failed (non-fatal), continuing"
fi

# (選用)一次性 FIX-095 prompt 修正 —— 由 RUN_STAGE3_PROMPT_FIX=true 觸發,非致命。
# Stage 3 從 DB 的 prompt_configs 讀 prompt;Azure 的 GLOBAL 記錄來自本地同步匯入、
# 重新部署不會更新它。此步驟把舊版「invoiceData 包裹」userPromptTemplate 改為 FIX-095
# 新版(消除信心度非確定性,冪等:已是新版則 0 筆)。補完後把旗標設回 false。
if [ "$RUN_STAGE3_PROMPT_FIX" = "true" ]; then
  echo "[entrypoint] (optional) applying FIX-095 Stage 3 prompt update"
  node prisma/update-stage3-prompt.js || echo "[entrypoint] stage3 prompt update failed (non-fatal), continuing"
fi

# (選用)一次性 CHANGE-101 Template Field Mapping 診斷/建立 —— 由
# RUN_TEMPLATE_MAPPING_SEED=inspect|dryrun|write 觸發(非空即執行),非致命。
# inspect=唯讀診斷(印 template fields / 38 公司比對 / classifiedAs 樣本,不寫入);
# dryrun=印將 upsert 內容與對不上清單,不寫入;write=冪等 upsert。完成後把旗標清空。
if [ -n "$RUN_TEMPLATE_MAPPING_SEED" ]; then
  echo "[entrypoint] (optional) template field mapping seed: mode=$RUN_TEMPLATE_MAPPING_SEED"
  node prisma/seed-template-field-mappings.js || echo "[entrypoint] template mapping seed failed (non-fatal), continuing"
fi

echo "[entrypoint] Step 3/3: starting Next.js server"
exec node server.js
