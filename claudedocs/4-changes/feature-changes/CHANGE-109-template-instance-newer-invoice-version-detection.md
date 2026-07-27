# CHANGE-109: Template Instance 過期偵測擴充 —— 同一發票存在更新的文件記錄

> **日期**: 2026-07-27
> **狀態**: ✅ 已完成（2026-07-27 本地三閘 + 10 項單元測試通過；**同日已部署 Azure DEV 並完成實機驗收** —— 映像 `dev-change109-20260727143423`，回填 483 筆，目標列列出 8 筆更新版本，見 [部署記錄](../../../docs/07-deployment/02-azure-deployment/deployment-records/2026-07-27-dev-change109.md)）
> **優先級**: Medium（不影響資料正確性，但補上 [CHANGE-106](CHANGE-106-template-instance-staleness-indicator.md) 涵蓋不到的主要情境）
> **類型**: Feature
> **影響範圍**: `ExtractionResult` schema（純加 nullable 欄位 + 索引）、提取結果寫入路徑、Template Instance 列表與明細、i18n

---

## 變更背景

[CHANGE-106](CHANGE-106-template-instance-staleness-indicator.md) 已上線「來源已更新」標記，判斷式為 `documents.processing_ended_at > row.updated_at`。**2026-07-27 Azure 實機驗證發現該機制涵蓋不到觸發它的那個情境**：

`CEVA_RCIM250325_17865.PDF` 在 Azure DEV 有 **15 筆各自獨立的 document 記錄** —— 每次處理都新建記錄，不是原地更新。CHANGE-106 §實測證據 引用的兩個時間點分屬不同記錄：

| document ID | `processingEndedAt` | `templateInstanceId` |
|---|---|---|
| `714ac520` | 2026-07-14 07:28:30 | `cmrkc7ajs…`（7/14 實例）|
| `7c3e3981` | 2026-07-21 10:19:19 | **null** |

7/14 實例的 row 指向 `714ac520`，該筆自 7/14 後從未被動過 → 判斷式正確地不標記。而使用者當時看到的「新資料」在 `7c3e3981`，與該 row 毫無關聯。

| 情境 | CHANGE-106 偵測得到？ |
|---|---|
| 原地重新處理（詳情頁重試 → `POST /api/documents/[id]/process`）| ✅ |
| **重新上傳同一份發票** | ❌ ← 本 CHANGE 要補的 |
| Mapping 設定被修改 | ❌ 不在本 CHANGE 範圍 |

全庫 522 個 row **0 個**被標記，印證此環境的實際工作流是重新上傳而非原地重試。且僅在 20 份取樣文件中就已出現 2 組重複發票（`TLHKHKG00951857` ×3、`TLHKHKG00955060` ×2）—— 這不是 CEVA 個案。

---

## 變更內容

### 1. 新增第二種過期訊號：同一發票有更新的文件

對每個 row 的來源文件，找出**同公司、同發票號、處理時間較晚**的其他文件記錄。有則於列表顯示新 badge、於明細抽屜逐份列出。

與既有訊號**並存且分開呈現** —— 因為補救動作不同：

| 訊號 | 意義 | 使用者該做什麼 |
|---|---|---|
| 「來源已更新」（CHANGE-106）| 本列的來源文件本身被重新處理 | 重新執行模板匹配 |
| 「有更新版本」（本 CHANGE）| 同一張發票另有更新的文件記錄，本列指向舊的那份 | 考慮改用新文件重建本列 |

### 2. `invoice_number` 反正規化為可索引欄位

`invoice_number` 目前埋在 `extraction_results.fields` JSON 內、無索引。新增 nullable 欄位 + 複合索引，寫入時一併填、並回填既有資料。

---

## 技術設計

### 識別鍵：`(companyId, invoice_number)`

2026-07-27 於 Azure DEV 實測的候選比較：

| 候選 | 判定 |
|---|---|
| **`invoice_number`**（提取自發票內容）| ✅ **採用**。20/20 取樣文件皆有值，橫跨 TOLL／CEVA／NEX 三家且格式各異（`TLHKHKG00951857` / `253250005808` / `EVJ-G0087` / `25NEH-HJT-E7642`）；8 筆 CEVA 重複上傳的值完全相同（`F260017865`）。鍵名為 `src/constants/standard-fields.ts` 的 `STANDARD_FIELDS` 正式常量（`isCommon: true`），不是散落的字面值 |
| `fileHash` | ❌ **全為 null**。只有 `outlook-document.service.ts` 與 `sharepoint-document.service.ts` 會計算，手動上傳路徑不算（實測 8 筆皆 `MANUAL_UPLOAD` + `fileHash: null`）。要用得先補計算 + 回填 568 筆。另一缺點：同一發票重新掃描／重新匯出會位元不同、hash 即失效，而發票號不變 |
| `fileName` | ❌ 會變（實測有 ` 1` 後綴的變體）|
| `_ref_number` / `referenceNumberMatch` | ❌ 衍生自**檔名**而非內容（檔名↔ref 主檔子字串匹配），改名即失效 |
| `fileSize` | ❌ 僅可作輔助佐證（實測 8 筆皆 193,624 bytes），單獨使用碰撞率過高 |

**判定條件（使用者 2026-07-27 決定：嚴格）**：

```
d2.company_id = d1.company_id          -- 嚴格相等，不做 merged_into_id 歸一
AND d2.invoice_number = d1.invoice_number
AND d2.invoice_number IS NOT NULL      -- 兩側皆需有值
AND d2.processing_ended_at > row.updated_at
AND d2.id <> d1.id
```

> ⚠️ **已知取捨（使用者已明確選擇）**：本專案有記錄在案的公司重複問題（[CHANGE-103](CHANGE-103-stage1-company-matching-anti-duplication.md)、[FIX-131](../bug-fixes/FIX-131-company-detail-merge-entry-active-companies.md)）。若同一張發票的兩筆文件被 Stage 1 判給了兩個重複的公司記錄，嚴格相等會**漏標**。漏標的後果是「沒提示」，與現狀相同，不會產生錯誤提示 —— 這是選擇嚴格的理由。若日後公司重複問題治理完成，可再評估是否放寬。

### 資料庫影響

| 項目 | 內容 |
|---|---|
| Schema | `ExtractionResult` 新增 `invoiceNumber String? @map("invoice_number")` + `@@index([companyId, invoiceNumber])` |
| H1 判定 | **不觸發** —— 屬「純加 nullable 欄位（向後相容）」，見 `.claude/rules/hard-constraints.md` §H1 不屬於 H1 清單 |
| Prisma 可表達性 | ✅ 欄位與複合索引 Prisma 皆可表達 → **不需** `post-init-indexes.sql`（與 FIX-133 的部分索引不同，那個 Prisma 表達不出來）|
| migration | 新增 migration（本地 `migrate dev` 路徑）|
| **Azure 既有非空庫** | 🔴 **必須**在 `prisma/apply-schema-drift.js` 加冪等條目（`add column if not exists` + `create index if not exists`），部署時帶 `RUN_SCHEMA_DRIFT_FIX=true`。否則新程式碼讀新欄位會 P2022 —— 見 memory `feedback_azure_migration_needs_schema_drift_entry` |
| 回填 | 既有 `extraction_results` 需從 `fields->>'invoice_number'` 回填，否則既有實例全部偵測不到（而那正是本 CHANGE 的目標）。冪等：只更新 `invoice_number IS NULL` 者 |
| 回填腳本位置 | 🔴 `prisma/backfill-invoice-number.js`（**純 JS**）+ entrypoint gated flag `RUN_INVOICE_NUMBER_BACKFILL=true`。Azure runner 映像不含 `scripts/` 與 `tsx` —— 見 memory `feedback_azure_runner_excludes_scripts_tsx` |

### 修改範圍

| 文件 | 變更內容 |
|------|----------|
| `prisma/schema.prisma` | 🔧 `ExtractionResult` 加 `invoiceNumber` + `@@index([companyId, invoiceNumber])` |
| `prisma/migrations/<ts>_change109_extraction_result_invoice_number/migration.sql` | 🆕 加欄位 + 索引 |
| `prisma/apply-schema-drift.js` | 🔧 加 2 條冪等 DDL（欄位 + 索引），供 Azure 既有庫套用 |
| `prisma/backfill-invoice-number.js` | 🆕 gated 回填腳本（預設 dry-run，`RUN_INVOICE_NUMBER_BACKFILL=true` 才寫入）|
| `scripts/docker-entrypoint.sh` | 🔧 加 gated 區塊（比照既有 `RUN_STAGE3_PROMPT_FIX` 寫法，非致命）|
| `src/services/processing-result-persistence.service.ts` | 🔧 寫入 `ExtractionResult` 時一併填 `invoiceNumber`（取自 stage 3 fields 的 `invoice_number`）|
| `src/services/template-instance.service.ts` | 🔧 `getRows` 的來源文件批量查詢擴充：一併取 `companyId` + `invoiceNumber`，再以單一 batch 查詢找出更新版本（沿用 CHANGE-091 1.6 / CHANGE-106 的既有掛點）|
| `src/types/template-instance.ts` | 🔧 新增 `NewerInvoiceVersion`；`TemplateInstanceRow` 加 `newerVersions?` |
| `src/components/features/template-instance/InstanceRowsTable.tsx` | 🔧 來源文件欄加第二種 badge（與既有琥珀 badge 並存，需視覺可區分）|
| `src/components/features/template-instance/RowDetailDrawer.tsx` | 🔧 加第二個警示區塊：逐份列出更新版本的檔名 + 處理時間 |
| `messages/{en,zh-TW,zh-CN}/templateInstance.json` | 🔧 新增 5 個 key（見下）|
| `tests/unit/services/template-instance-newer-version.test.ts` | 🆕 單元測試 |

### i18n 影響

| Key | zh-TW |
|---|---|
| `rows.newerVersionBadge` | 有更新版本 |
| `rows.newerVersionTooltip` | 同一發票有 {count} 份更新的文件 |
| `rowDetail.newerVersions.title` | 同一發票有更新的文件 |
| `rowDetail.newerVersions.description` | 以下文件與本列來源為同一張發票（同公司、同發票號），且處理時間較晚。本列數值來自較舊的那一份。 |
| `rowDetail.newerVersions.item` | {fileName} — 處理於 {date} |

`templateInstance` 為既有命名空間 → **不需**在 `src/i18n/request.ts` 註冊。三語言必須同步 + `npm run i18n:check`。

---

## 設計決策

1. **不與 CHANGE-106 的訊號合併** —— 兩者補救動作不同（重跑匹配 vs 改用新文件），合併會讓使用者不知該做什麼。
2. **反正規化而非 JSON path 查詢**（使用者 2026-07-27 決定）—— JSON path + functional index 雖免回填，但 Prisma 表達不出 functional index，會重演 FIX-133「raw SQL 三處同步」的維護負擔。且 [FIX-132](../bug-fixes/FIX-132-db-pool-exhaustion-transaction-p2028.md) 剛因重查詢造成連線池耗盡（P2028），此處不宜留未索引查詢。
3. **`companyId` 嚴格相等**（使用者決定）—— 見上方取捨說明。
4. **只讀不寫** —— 本 CHANGE 僅新增標記，**不提供**「一鍵改用新文件重建」。那屬 CHANGE-106 §方案選項 B 的範圍，需先釐清人工修正值的覆蓋語意。
5. **`invoice_number` 為空者不參與比對** —— 提取失敗（`UPLOADED` / `OCR_FAILED` / `REF_MATCH_FAILED`）的文件本就沒有可用的提取結果，不該被當成「更新版本」推薦給使用者。

---

## 向後兼容性

- 純加 nullable 欄位 + 新索引 → 既有查詢不受影響
- `newerVersions` 為 optional，舊前端（若有快取）不會壞
- 回填前 `invoice_number` 全為 null → 功能靜默無效，不會誤標
- 回滾：重部署舊映像即可；欄位與索引留著不影響舊程式碼

---

## 驗收標準

| # | 驗收項目 | 驗收標準 | 優先級 |
|---|----------|----------|--------|
| 1 | 回填正確 | 既有 `extraction_results` 的 `invoice_number` 與 `fields->>'invoice_number'` 一致；抽樣 20 筆比對 | High |
| 2 | **具體目標案例** | Azure DEV 上 7/14 實例 `cmrkc7ajs000001qrgyp2jzxs` 的 `RCIM250325` 那列出現「有更新版本」badge | High |
| 3 | 明細下鑽 | 該列抽屜列出更新版本的檔名 + 處理時間。**已實測確認 `invoice_number` 同為 `F260017865` 的有 `7c3e3981`（7/21 10:19）與 `d534a63f`（7/23 04:23）→ 至少 2 筆**；另有 4 筆時間更晚的同名記錄（`09521313` / `e46b47e4` / `18a485d6` / `db69c3b8`）其 `invoice_number` 尚未逐筆實測，實作後應為 6 筆，若少於 6 需查明原因 | High |
| 4 | 不誤標 | 來源文件已是最新版本的 row **不**顯示新 badge；`invoice_number` 為 null 的來源不參與比對 | High |
| 5 | 兩訊號並存可區分 | 同時具備兩種過期情形的 row，兩個 badge 皆顯示且視覺可區分 | Medium |
| 6 | 跨公司不誤判 | 不同 `companyId` 但發票號相同者**不**互相標記 | Medium |
| 7 | 查詢成本 | 實例明細載入的新增查詢為**單一 batch**（不得 N+1）；索引生效（`EXPLAIN` 確認走 `(company_id, invoice_number)`）| High |
| 8 | i18n | 三語言同步 + `npm run i18n:check` 通過 | High |
| 9 | 三閘 | `type-check` / `lint` / `test` 通過 | High |

---

## 測試場景

| # | 場景 | 測試步驟 | 預期結果 |
|---|------|----------|----------|
| 1 | 同發票有更新文件 | 建立實例 → 重新上傳同一份發票並處理完成 → 回看實例 | 該列出現「有更新版本」badge，抽屜列出新文件與時間 |
| 2 | 兩訊號並存 | 場景 1 之後，再對**原來源文件**執行原地重新處理 | 兩個 badge 同時顯示 |
| 3 | 跨公司同號 | 造兩筆不同 `companyId` 但 `invoice_number` 相同的文件 | 互不標記 |
| 4 | 無發票號 | 來源文件的 `invoice_number` 為 null | 不標記、不拋錯 |
| 5 | 回填冪等 | 連續執行回填腳本兩次 | 第二次應為 0 筆更新 |
| 6 | 索引生效 | 對 500+ 筆資料的實例明細計時 | 新增查詢走索引，載入時間無明顯退化 |

---

## Azure DEV 實機驗收（2026-07-27，映像 `dev-change109-20260727143423`）

完整部署過程見 [部署記錄](../../../docs/07-deployment/02-azure-deployment/deployment-records/2026-07-27-dev-change109.md)。

| # | 驗收項目 | 實測 |
|---|----------|------|
| 1 | 回填正確 | ✅ 550 筆候選填 **483 筆**；67 筆無可用發票號（提取失敗類文件）留 null |
| 2 | **目標案例** | ✅ 7/14 實例 `cmrkc7ajs000001qrgyp2jzxs` 的 `RCIM250325` 列出現天藍「有更新版本」badge |
| 3 | 明細下鑽 | ✅ 列出 **8 筆**（規劃預期 6，差額見下）。含手動確認過的 `7c3e3981`（7/21）與 `d534a63f`（7/23）；時區換算正確（7/23 04:23 UTC → 12:23）；依時間新到舊排序 |
| 4 | 不誤標 | ✅ 67 筆無 `invoice_number` 的來源不參與比對 |
| 5 | 兩訊號可區分 | ✅ 該實例各列**只有天藍 badge、無琥珀 badge** —— 來源本身未被原地重新處理，證實兩訊號互不干擾 |
| 6 | 跨公司不誤判 | ⚠️ 未在線上構造此情境（需造假資料）；單元測試已覆蓋 |
| 7 | 查詢成本 | ✅ 單一批次（`extractionResult.findMany` 每頁 1 次），無 N+1。實機載入無感延遲；`EXPLAIN` 未執行 |
| 8 | i18n | ✅ 三語言同步、無缺 key |
| 9 | 三閘 | ✅ `type-check` / `lint` / `test` 通過 |

### 驗收項 3 的筆數更正

原文寫「預期 6 筆，少於 6 需查明原因」，**實測為 8 筆**。多出的 2 筆是 `CEVA_RCIM250325_17865 1.PDF` 的 `2026-07-16T07:22:28Z` 與 `2026-07-15T09:25:10Z` —— 兩者確實晚於本列 `updatedAt`（`2026-07-14T07:36:04Z`），符合判斷式。**是規劃時目視 15 筆同名記錄清單漏數，不是程式多報。**

### 附帶觀察：該實例 10 個 row 全部被標記

逐列的更新版本數為 1／2／3／**8**／3／5／1／10／1／2。這是 CHANGE-106 驗證時「522 個 row 0 個被標記」的另一面 —— 過期是普遍現象，只是舊判斷式偵測不到。

---

## 部署注意（🔴 依過往事故整理）

1. **必須**帶 `RUN_SCHEMA_DRIFT_FIX=true`（本 CHANGE 有新欄位；與 CHANGE-107/FIX-133 那次不同）
2. **必須**帶 `RUN_INVOICE_NUMBER_BACKFILL=true` 一次，之後設回 `false`（runbook §A.5）
3. 部署前確認**線上映像落後 main 的完整範圍**，不是「工作樹 vs main」（runbook §A.0、§16 事故）
4. 新程式碼未新增任何 env 讀取 → 無 §16 那類靜默 fallback 風險（實作後仍應複查）

---

## 實作記錄（2026-07-27）

### 規劃前提的更正：`prisma migrate dev` 在本 repo 不可用

規劃寫「新增 migration（本地 `migrate dev` 路徑）」是**錯的假設**。實測 `migrate dev` 失敗：

```
Error: P3006
Migration `20260716113449_add_company_suspected_duplicate_of_id` failed to apply
cleanly to the shadow database. Error code: P1014
The underlying table for model `companies` does not exist.
```

根因：`prisma/migrations/` 只有 13 個 migration，2025-12 之後直接跳到 2026-07 —— 建立 `companies` 表的 migration（REFACTOR-001）**從不存在於版控**（無 `_archive` 資料夾）。因此 migration 歷史**無法從零重播**，shadow database 必然缺表。

這代表本 repo 實際上**不以 migration 為真相來源**：`schema.prisma` 是；Azure 走 `init.sql`（`migrate diff --from-empty` 生成）、本地走 `db push`。`apply-schema-drift.js` 的存在正是因為 migration 到不了 Azure。**這不是本 CHANGE 造成的，對任何新 migration 都一樣。**

採用做法（沿用 FIX-133 兩天前在同一區域建立的先例）：

| 步驟 | 指令 |
|---|---|
| 1. 手寫 migration SQL | `prisma/migrations/20260727060000_change109_.../migration.sql`（冪等）|
| 2. 直接套用本地 | `npx prisma db execute --file <該檔>`（⚠️ 此版本**不接受** `--schema`，datasource 由 `prisma.config.ts` 讀取）|
| 3. 標記為已套用 | `npx prisma migrate resolve --applied 20260727060000_...` |
| 4. 漂移驗證 | `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script` → `-- This is an empty migration.` ✅ |

> ⚠️ 步驟 4 的旗標名在 Prisma 7.2 已改：`--to-schema-datamodel` 被移除，須用 `--to-schema`；`--from-schema-datasource` 須用 `--from-config-datasource`。
>
> 另記錄一個**既有**、非本次造成的狀況：`migrate status` 顯示 `20260722020000_add_transform_diagnostics_to_template_instance_rows`（FIX-128）未套用，但該欄位已由 `apply-schema-drift.js` 補上。FIX-133 已記錄此事，本次同樣未處理。

### 🔴 實作期踩到的 bug：兩處各自寫比對鍵，分隔符分歧

寫入端與讀取端各自寫了 template literal 組比對鍵。實際落到檔案裡的是：

| 位置 | 分隔符 |
|---|---|
| 建立候選表（2 處）| **NUL**（` `）|
| 逐 row 比對（1 處）| 空白 |

後果是 `newerByKey.get(...)` **永遠落空**，功能靜默回空陣列、不拋任何錯誤。單元測試的 4 個正向案例失敗、負向案例全過 —— 若當初只寫負向測試，這個 bug 會直接上線。

診斷過程也繞了路：查詢參數正確、mock 回傳值正確、函式邏輯逐行看都對，最後靠在服務內插入臨時 `throw` 傾印中間值，才看到鍵長成 `"company-ceva F260017865"`。附帶症狀：該檔被 git 判定為 **binary**（NUL 所致），`grep` 也拒絕搜尋。

**修法不是把字元改一致，而是消除分歧的可能**：新增模組層級的 `invoiceIdentityKey(companyId, invoiceNumber)`，三處全部改用它。分隔符改為 `::`（companyId 為 cuid/uuid，字元集不含冒號，無歧義）。

### 附帶修正：6 個檔案的行尾被翻成 CRLF

編輯過程把 6 個原本 LF 的檔案整檔翻成 CRLF，使 `template-instance.service.ts` 的 diff 膨脹到 **1160 增 / 1021 刪**（實際改動僅約 160 行），會嚴重掩蓋真實變更。`.gitattributes` 目前**只保護 `*.sh`**（`text eol=lf`），故其他檔案無防護。

已全部正規化回 LF，`template-instance.service.ts` 的 diff 降回 **160 / 3**。

> 建議（未執行，超出本 CHANGE 範圍）：`.gitattributes` 增加 `* text=auto eol=lf` 或針對 `*.ts` / `*.tsx` / `*.prisma` 的規則，讓這類污染在源頭被擋掉。

### 實際改動檔案

| 檔案 | 改動 | diff |
|------|------|------|
| `prisma/schema.prisma` | 🔧 `ExtractionResult` 加 `invoiceNumber` + `@@index([companyId, invoiceNumber])` | +6 |
| `prisma/migrations/20260727060000_change109_extraction_result_invoice_number/migration.sql` | 🆕 冪等 DDL（加欄位 + 索引）| 新檔 |
| `prisma/apply-schema-drift.js` | 🔧 加 2 條 CHANGE-109 冪等 DDL；`@lastModified` 更新 | +14/-1 |
| `prisma/backfill-invoice-number.js` | 🆕 gated 回填（預設 dry-run、分批、只補 null、含欄位存在前置檢查）| 新檔 |
| `scripts/docker-entrypoint.sh` | 🔧 加 `RUN_INVOICE_NUMBER_BACKFILL` gated 區塊（非致命）| +10 |
| `src/services/processing-result-persistence.service.ts` | 🔧 加 `INVOICE_NUMBER_FIELD` 常量 + `extractInvoiceNumber()`；upsert 的 create/update 兩處填 `invoiceNumber` | +32 |
| `src/services/template-instance.service.ts` | 🔧 `invoiceIdentityKey()` 共用鍵函式；`getRows` 取識別鍵 + 單一批次候選查詢；`collectNewerVersions()` | +160/-3 |
| `src/types/template-instance.ts` | 🔧 新增 `NewerInvoiceVersion`；`TemplateInstanceRow.newerVersions?` | +23 |
| `src/components/features/template-instance/InstanceRowsTable.tsx` | 🔧 天藍色 badge + `Files` 圖示（與琥珀色的 CHANGE-106 badge 並存可區分）| +26/-2 |
| `src/components/features/template-instance/RowDetailDrawer.tsx` | 🔧 第二個警示區塊，逐份列出更新版本與處理時間 | +27/-2 |
| `messages/{en,zh-TW,zh-CN}/templateInstance.json` | 🔧 各加 5 個 key（`rows.newerVersion*` + `rowDetail.newerVersions.*`）| 各 +9/-2 |
| `tests/unit/services/template-instance-newer-version.test.ts` | 🆕 10 項單元測試 | 新檔 |

### 本地驗證

| 項目 | 結果 |
|---|---|
| `npm run type-check` | ✅ exit 0 |
| `npm run lint` | ✅ exit 0；2 個 warning 皆為**既有**（`changeStatus` 的未使用 `errorMessage`，HEAD 即存在），依 Karpathy 1.3 只提不改 |
| `npm run i18n:check` | ✅ exit 0 |
| 單元測試 | ✅ **15 passed**（本次 10 + CHANGE-106 既有 5，無回歸）|
| Prisma 漂移 | ✅ 空 migration |
| 欄位與索引落地 | ✅ `\d extraction_results` 確認 `invoice_number text` 與 `extraction_results_company_id_invoice_number_idx btree (company_id, invoice_number)` |
| i18n diff 純新增 | ✅ 三語言各 +9/-2，既有內容零改動 |

### 單元測試涵蓋

同公司同發票號較晚 → 標記｜候選較早 → 不標記｜同發票號但不同公司 → 不標記（嚴格判定）｜來源無 `invoiceNumber` → 不查候選｜來源無提取結果 → 不查候選｜兩份來源同一發票 → 候選去重｜多候選依時間新到舊排序｜**兩種訊號並存**｜候選查詢排除自身來源（`documentId: { notIn }` 契約）｜無來源文件 → 兩個查詢都不發

---

## 相關文件

- [CHANGE-106](CHANGE-106-template-instance-staleness-indicator.md) —— 本 CHANGE 補其涵蓋不到的情境；該檔 §Azure 實機驗證 有完整的限制分析
- [CHANGE-091](CHANGE-091-template-instance-flow-ux-async-progress.md) —— `getRows` 的來源文件批量查詢掛點（1.6）
- [FIX-132](../bug-fixes/FIX-132-db-pool-exhaustion-transaction-p2028.md) —— 未索引重查詢造成 P2028 的前例，本 CHANGE 加索引的理由
- [FIX-133](../bug-fixes/FIX-133-template-mapping-unique-constraint-never-enforced.md) —— raw SQL 索引需三處同步的前例；本 CHANGE 因 Prisma 可表達而**不需**
- [CHANGE-103](CHANGE-103-stage1-company-matching-anti-duplication.md) —— 公司重複治理；決定日後是否放寬 `companyId` 嚴格相等
