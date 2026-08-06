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
# 帳號 is_global_admin 設為 true(冪等)。完成後**清空** GRANT_GLOBAL_ADMIN_EMAIL;被授權者需重新登入。
# 🔴 FIX-140:本旗標的值是 email 非布林 —— **關閉方式是清空設定,設成 false 不會關閉**。
# 原用 [ -n "$X" ] 會把 "false" 當 email 送進腳本(找不到帳號 → 非致命失敗)。改為 email
# 形狀檢查(@ 前後各至少一字元、@ 後含 . 且 . 後至少一字元)。
# ⚠️ skip 訊息刻意**不回印該值** —— 該值可能是真實 email,印出即 PII 進 plaintext log(H4)。
case "$GRANT_GLOBAL_ADMIN_EMAIL" in
  *?@?*.?*)
    echo "[entrypoint] (optional) granting global admin"
    node prisma/grant-global-admin.js || echo "[entrypoint] grant global admin failed (non-fatal), continuing"
    ;;
  "")
    : # 未設定 = 關閉(正常情況,不輸出)
    ;;
  *)
    echo "[entrypoint] (optional) grant global admin skipped: value is not an email address (clear the app setting to disable)"
    ;;
esac

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
# RUN_TEMPLATE_MAPPING_SEED=inspect|dryrun|write 觸發,非致命。
# inspect=唯讀診斷(印 template fields / 38 公司比對 / classifiedAs 樣本,不寫入);
# dryrun=印將 upsert 內容與對不上清單,不寫入;write=冪等 upsert。完成後把旗標**清空**。
# 🔴 FIX-140:本旗標是「三模式」非布林 —— **關閉方式是清空設定,設成 false 不會關閉**。
# 原用 [ -n "$X" ](非空即執行),而字串 "false" 非空故仍觸發(靠腳本的 unknown mode 保護
# 才沒造成損害)。改為明確列舉有效值,順帶擋掉打錯字(如 writte)。有效值須與
# prisma/seed-template-field-mappings.js 的 MODE 判斷保持一致。
case "$RUN_TEMPLATE_MAPPING_SEED" in
  inspect|dryrun|write)
    echo "[entrypoint] (optional) template field mapping seed: mode=$RUN_TEMPLATE_MAPPING_SEED"
    node prisma/seed-template-field-mappings.js || echo "[entrypoint] template mapping seed failed (non-fatal), continuing"
    ;;
  "")
    : # 未設定 = 關閉(正常情況,不輸出)
    ;;
  *)
    echo "[entrypoint] (optional) template field mapping seed skipped: mode=$RUN_TEMPLATE_MAPPING_SEED not recognised (expected inspect|dryrun|write; clear the app setting to disable)"
    ;;
esac

# (選用)一次性 FIX-110 aliases 補回 —— 由 RUN_FIX110_ALIAS_BACKFILL=true 觸發,非致命。
# FieldDefinitionSet 來自本地同步匯入,重新部署/re-import 不會帶入 FIX-110 直接寫入的
# 9 條針對性 aliases;此步驟冪等補回（已存在則 0 筆）。補完後把旗標設回 false。
if [ "$RUN_FIX110_ALIAS_BACKFILL" = "true" ]; then
  echo "[entrypoint] (optional) applying FIX-110 targeted charge aliases"
  node prisma/apply-fix110-aliases.js || echo "[entrypoint] FIX-110 alias backfill failed (non-fatal), continuing"
fi

# (選用)一次性 FIX-111 停用多餘 GLOBAL FIELD_EXTRACTION —— 由
# RUN_FIX111_DEACTIVATE_FIELD_EXTRACTION=true 觸發,非致命。兩型 active GLOBAL 提取 prompt
# (STAGE_3_FIELD_EXTRACTION 帶 HKD 規則 / FIELD_EXTRACTION 通用無 HKD)並存時,Stage 3 選型
# 非確定 → HKD 規則被旁路(FIX-111 根因)。此步驟停用通用 FIELD_EXTRACTION,只留
# STAGE_3_FIELD_EXTRACTION(冪等、含安全閘;legacy 路徑 fallback 到內容相同的 static prompt)。
# 程式碼修正(pickPreferredExtractionConfig)隨映像生效後即根治;本步驟為映像重建前的即時修正。補完後設回 false。
if [ "$RUN_FIX111_DEACTIVATE_FIELD_EXTRACTION" = "true" ]; then
  echo "[entrypoint] (optional) applying FIX-111 deactivate redundant GLOBAL FIELD_EXTRACTION"
  node prisma/apply-fix111-deactivate-field-extraction.js || echo "[entrypoint] FIX-111 deactivate failed (non-fatal), continuing"
fi

# (選用)一次性 CHANGE-109 invoice_number 回填 —— 由 RUN_INVOICE_NUMBER_BACKFILL=true
# 觸發,非致命。新欄位只在「之後的提取」被寫入,既有資料一律為 null;而「同一發票是否有
# 更新的文件記錄」偵測的目標正是**存量**實例 → 不回填等於功能對存量靜默無效。
# 前置:欄位需先由 apply-schema-drift.js 建立(RUN_SCHEMA_DRIFT_FIX=true)。
# 未設旗標時本 script 為 dry-run(只印統計不寫入)。回填後把旗標設回 false。
if [ "$RUN_INVOICE_NUMBER_BACKFILL" = "true" ]; then
  echo "[entrypoint] (optional) applying CHANGE-109 invoice_number backfill"
  node prisma/backfill-invoice-number.js || echo "[entrypoint] invoice_number backfill failed (non-fatal), continuing"
fi

# (選用)CHANGE-113 DHL 多 shipment 設定 —— 由
# RUN_CHANGE113_DHL_SETUP=inspect|dryrun|write 觸發,非致命。
# CHANGE-113 的程式碼隨映像上線,但**讓它生效的五項設定都在資料庫裡**:欄位定義集的
# 燃油欄位、DHL Stage 3 prompt、兩條模板映射規則、模板 line_item_mode=GROUP。
# 不套用則映像雖新、行為仍是舊的(分組鍵會被編造、燃油與文件類運費金額落空)。
# inspect=唯讀印現況;dryrun=印將改什麼不寫入;write=冪等寫入。完成後把旗標**清空**。
# 🔴 比照 FIX-140:本旗標是「三模式」非布林 —— **關閉方式是清空設定,設成 false 不會關閉**
# (腳本自身的 mode 檢查會擋下,但旗標語意仍應明確)。有效值須與 prisma/change113-dhl-setup.js
# 的 VALID_MODES 保持一致。
# 前置:line_item_mode 欄位需先由 apply-schema-drift.js 建立(RUN_SCHEMA_DRIFT_FIX=true)。
case "$RUN_CHANGE113_DHL_SETUP" in
  inspect|dryrun|write)
    echo "[entrypoint] (optional) CHANGE-113 DHL setup: mode=$RUN_CHANGE113_DHL_SETUP"
    node prisma/change113-dhl-setup.js || echo "[entrypoint] CHANGE-113 DHL setup failed (non-fatal), continuing"
    ;;
  "")
    : # 未設定 = 關閉(正常情況,不輸出)
    ;;
  *)
    echo "[entrypoint] (optional) CHANGE-113 DHL setup skipped: mode=$RUN_CHANGE113_DHL_SETUP not recognised (expected inspect|dryrun|write; clear the app setting to disable)"
    ;;
esac

# (選用)2026-08-03 設定同步 —— 由 RUN_CONFIG_SYNC_20260803=inspect|dryrun|write 觸發,非致命。
# 線上映像 dev-fix147r3(a1eba1e)到 52d2184 之間,有一部分變更**不隨映像走** —— 它們是
# 資料庫裡的設定:FIX-154 GLOBAL prompt 幣別註記、FIX-156 DHL subtotal 定義、
# FIX-158 RIL 雙 key 公式與 CEVA 欄位定義、CHANGE-115 LLM 型錄切 luna。
# 不套用則程式碼雖新、行為仍是舊的。
# inspect=唯讀印現況;dryrun=印將改什麼不寫入;write=冪等寫入。完成後把旗標**清空**。
# 🔴 比照 FIX-140:本旗標是「三模式」非布林 —— **關閉方式是清空設定,設成 false 不會關閉**。
# 有效值須與 prisma/sync-config-20260803.js 的 VALID_MODES 保持一致。
# 前置:步驟 5(LLM 型錄)需 Epic 23 三張表存在,由 apply-schema-drift.js 建立
# (RUN_SCHEMA_DRIFT_FIX=true);表不存在時該步驟自行跳過,不影響其餘四步。
case "$RUN_CONFIG_SYNC_20260803" in
  inspect|dryrun|write)
    echo "[entrypoint] (optional) config sync 20260803: mode=$RUN_CONFIG_SYNC_20260803"
    node prisma/sync-config-20260803.js || echo "[entrypoint] config sync 20260803 failed (non-fatal), continuing"
    ;;
  "")
    : # 未設定 = 關閉(正常情況,不輸出)
    ;;
  *)
    echo "[entrypoint] (optional) config sync 20260803 skipped: mode=$RUN_CONFIG_SYNC_20260803 not recognised (expected inspect|dryrun|write; clear the app setting to disable)"
    ;;
esac

# (選用)2026-08-06 設定落差診斷 —— 由 RUN_CONFIG_DIAGNOSE_20260806=inspect 觸發,非致命。
# 🔴 **唯讀**:只查詢、不寫入任何資料,可安全重複執行。
# 用途:在決定要不要把 FIX-159~169 的資料層設定同步過來之前,先看目標環境的實際現況 ——
# 本機無法直連私有 PG,任何查詢只能在容器啟動時於 VNet 內跑。
# 🔴 比照 FIX-140:本旗標是單值非布林 —— **關閉方式是清空設定,設成 false 不會關閉**。
# 有效值須與 prisma/diagnose-config-20260806.js 的 VALID_MODES 保持一致。
case "$RUN_CONFIG_DIAGNOSE_20260806" in
  inspect)
    echo "[entrypoint] (optional) config diagnose 20260806: mode=$RUN_CONFIG_DIAGNOSE_20260806 (read-only)"
    node prisma/diagnose-config-20260806.js || echo "[entrypoint] config diagnose 20260806 failed (non-fatal), continuing"
    ;;
  "")
    : # 未設定 = 關閉(正常情況,不輸出)
    ;;
  *)
    echo "[entrypoint] (optional) config diagnose 20260806 skipped: mode=$RUN_CONFIG_DIAGNOSE_20260806 not recognised (expected inspect; clear the app setting to disable)"
    ;;
esac

# (選用)FIX-159 移植:拆分 Toll 泰國 / 香港跨國實體 —— 由
# RUN_TOLL_SPLIT_20260806=inspect|dryrun|write 觸發,非致命。
# 🔴 **write 會寫入資料**(companies / documents.company_id / extraction_results.company_id)。
# 依 §不可逆資料操作紀律:單一交易 + 數量閘 + 樂觀鎖 + 冪等;容器內無可保留檔案系統,
# 故前置快照**印進 log**(Log Analytics 的 AppServiceConsoleLogs 是唯一還原依據)。
# 🔴 比照 FIX-140:本旗標是「三模式」非布林 —— **關閉方式是清空設定,設成 false 不會關閉**。
# 有效值須與 prisma/split-toll-hk-20260806.js 的 VALID_MODES 保持一致。
case "$RUN_TOLL_SPLIT_20260806" in
  inspect|dryrun|write)
    echo "[entrypoint] (optional) Toll HK split: mode=$RUN_TOLL_SPLIT_20260806"
    node prisma/split-toll-hk-20260806.js || echo "[entrypoint] Toll HK split failed (non-fatal), continuing"
    ;;
  "")
    : # 未設定 = 關閉(正常情況,不輸出)
    ;;
  *)
    echo "[entrypoint] (optional) Toll HK split skipped: mode=$RUN_TOLL_SPLIT_20260806 not recognised (expected inspect|dryrun|write; clear the app setting to disable)"
    ;;
esac

# (選用)FIX-150 對帳工具 —— 解除 runbook §17 的通案限制。兩者皆**唯讀**,非致命。
# §不可逆資料操作紀律要求「改 mapping 前後各跑一次對帳」,原工具在 scripts/、
# 不在 runner 映像內,安全網無法於容器執行 —— 這兩支是容器內可執行版,判準與本機版相同。
#
# RUN_ORPHAN_CHECK=inspect       費用落地對帳(提取總額 vs 模板總額)
#   選用 RECONCILE_BASELINE=<JSON>  設了就在容器內完成前後比對
#   選用 RECONCILE_COMPANY=<關鍵字> 公司過濾
#   選用 RECONCILE_DOCS=true        逐份文件列出
# RUN_TEMPLATE_SNAPSHOT=capture  模板欄位值快照(輸出 JSON,於本機 diff)
#   🔴 務必配 RECONCILE_COMPANY 縮小範圍,全庫快照會超過 log 輸出上限而被拒絕
#
# 🔴 比照 FIX-140:兩者皆為單值非布林旗標 —— **關閉方式是清空設定,設成 false 不會關閉**。
case "$RUN_ORPHAN_CHECK" in
  inspect)
    echo "[entrypoint] (optional) orphan charge key check: mode=$RUN_ORPHAN_CHECK (read-only)"
    node prisma/check-orphan-charge-keys.js || echo "[entrypoint] orphan check failed (non-fatal), continuing"
    ;;
  "")
    : # 未設定 = 關閉(正常情況,不輸出)
    ;;
  *)
    echo "[entrypoint] (optional) orphan charge key check skipped: mode=$RUN_ORPHAN_CHECK not recognised (expected inspect; clear the app setting to disable)"
    ;;
esac

case "$RUN_TEMPLATE_SNAPSHOT" in
  capture)
    echo "[entrypoint] (optional) template value snapshot: mode=$RUN_TEMPLATE_SNAPSHOT (read-only)"
    node prisma/snapshot-template-values.js || echo "[entrypoint] template snapshot failed (non-fatal), continuing"
    ;;
  "")
    : # 未設定 = 關閉(正常情況,不輸出)
    ;;
  *)
    echo "[entrypoint] (optional) template value snapshot skipped: mode=$RUN_TEMPLATE_SNAPSHOT not recognised (expected capture; clear the app setting to disable)"
    ;;
esac

echo "[entrypoint] Step 3/3: starting Next.js server"
exec node server.js
