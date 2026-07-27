# CHANGE-109: Template Instance 過期偵測擴充 —— 同一發票存在更新的文件記錄

> **日期**: 2026-07-27
> **狀態**: ⏳ 待實作
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

## 部署注意（🔴 依過往事故整理）

1. **必須**帶 `RUN_SCHEMA_DRIFT_FIX=true`（本 CHANGE 有新欄位；與 CHANGE-107/FIX-133 那次不同）
2. **必須**帶 `RUN_INVOICE_NUMBER_BACKFILL=true` 一次，之後設回 `false`（runbook §A.5）
3. 部署前確認**線上映像落後 main 的完整範圍**，不是「工作樹 vs main」（runbook §A.0、§16 事故）
4. 新程式碼未新增任何 env 讀取 → 無 §16 那類靜默 fallback 風險（實作後仍應複查）

---

## 相關文件

- [CHANGE-106](CHANGE-106-template-instance-staleness-indicator.md) —— 本 CHANGE 補其涵蓋不到的情境；該檔 §Azure 實機驗證 有完整的限制分析
- [CHANGE-091](CHANGE-091-template-instance-flow-ux-async-progress.md) —— `getRows` 的來源文件批量查詢掛點（1.6）
- [FIX-132](../bug-fixes/FIX-132-db-pool-exhaustion-transaction-p2028.md) —— 未索引重查詢造成 P2028 的前例，本 CHANGE 加索引的理由
- [FIX-133](../bug-fixes/FIX-133-template-mapping-unique-constraint-never-enforced.md) —— raw SQL 索引需三處同步的前例；本 CHANGE 因 Prisma 可表達而**不需**
- [CHANGE-103](CHANGE-103-stage1-company-matching-anti-duplication.md) —— 公司重複治理；決定日後是否放寬 `companyId` 嚴格相等
