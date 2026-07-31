# CHANGE-114: 提取結果版本歷史 + 手動上傳檔案雜湊

> **日期**: 2026-07-31
> **狀態**: ⏳ 待實作
> **優先級**: High
> **類型**: Architecture / Feature
> **影響範圍**: Prisma schema（新增 1 model）、處理結果持久化、手動上傳路徑、文件列表 UI
> **H1 批准**: 使用者 2026-07-31 批准動 Prisma 核心結構（方案 B2）

---

## 變更背景

FIX-150 的診斷過程暴露了一個結構缺口。

當時能釘死三件事，靠的全是「同一份發票在系統裡有多筆記錄」：

| 結論 | 依據 |
|---|---|
| `nehk_bl_fee` 欄位定義是哪一天開始生效的 | 7447 的 07-13 副本沒有該 key、07-14 之後的都有 680 |
| `bl_fee` 誤配早於 07-31 的 alias 收窄，不是新問題 | 8925 的三份副本全部提取於 07-13 |
| 7/25 那次映射改動打破了四份文件 | 跨時間比對模板實例列 |

但這些記錄的存在是**意外**，不是設計。實查 Azure DEV：

```
CREATE UNIQUE INDEX extraction_results_document_id_key ON extraction_results (document_id)
```

`extraction_results` 與 `documents` 是一對一，由唯一約束強制。全庫 851 份有提取記錄的文件，**每一份都只有 1 筆**，沒有任何一份有第 2 筆。寫入路徑用的是 `upsert`（`processing-result-persistence.service.ts:323`、`:664`），所以**「重新處理」會覆蓋掉上一次的結果**。

上述證據之所以還在，純粹是因為使用者用「重新上傳」代替了「重新處理」——每次上傳建立一筆新的 `documents` 記錄，各自帶一筆提取結果。副產物剛好形成了處理歷史。

代價是文件數量失真：

```
文件總數      869 份
相異檔名      337 個
屬於重複群組  731 份（84%）
```

而系統偵測不到重複：`documents.file_hash` 欄位存在，但 **869 份全部為 NULL**。查證後發現雜湊**有在算**，只是僅限 `outlook-document.service.ts:388` 與 `sharepoint-document.service.ts:188` 兩條路徑；手動上傳（`src/app/api/documents/upload/route.ts`）從未計算。

### 使用者的要求（2026-07-31）

> 「我不認為只保留最新的一份，因為每次的處理文件的記錄都應該要被保存下來，這樣才知道 AI 在處理文件時的問題，如果只留成功就反而會產生其他的問題的」

因此本變更**不刪除任何資料**。目標是讓「保存每次處理記錄」成為系統的正式能力，而不是重複上傳的副作用。

---

## 變更內容

### A. 手動上傳計算並儲存 `file_hash`

補上手動上傳路徑缺少的雜湊計算，比照 Outlook / SharePoint 既有做法（`createHash('sha256')`）。

再以雜湊為鍵，讓文件列表能把同一份檔案的多次上傳**分組呈現**為「這張發票有 N 次處理記錄」。

**不擋重複上傳** —— DEV 需要反覆測試，強制阻擋會妨礙工作。只做偵測與呈現。

### B. `extraction_results` 版本歷史

新增 `ExtractionResultVersion` 存檔表。每次 upsert 覆蓋前，先把當前列完整複製進存檔。

---

## 設計決策

### 1. 版本歷史的實作方式 —— B1 vs B2

兩案都能達成「每次處理記錄都保存下來、可依時間排列比對」。差別在「最新的那一份放哪裡」，以及隨之而來的波及範圍。

| | B1 改成一對多 | **B2 加版本存檔表（採用）** |
|---|---|---|
| 做法 | 移除 `documentId @unique`，加 `version` / `isCurrent` | `extraction_results` 維持現狀（永遠是最新），新增存檔表 |
| Prisma 關聯 | `Document.extractionResult` 由 `ExtractionResult?` 變 `ExtractionResult[]` | 不變 |
| 讀取路徑改動 | 🔴 **42 處 `include: { extractionResult }`、橫跨 29 個檔案** + 13 處直接查詢，每一處 `document.extractionResult.xxx` 都失效 | 🟢 **0 處** |
| 寫入路徑改動 | 3 處 | 3 處（`processing-result-persistence.service.ts` ×2、`mapping.service.ts:466`） |
| 風險分佈 | 分散在審核 / 報表 / 追溯的 API，改壞不易當場發現 | 集中在 3 個寫入點 |

**採用 B2**（使用者 2026-07-31 決定）。B1 的資料模型較漂亮，但它換來的好處不足以抵銷 29 個檔案的讀取路徑改動；B2 用一個存檔表達成同樣的保存目的。

> 上述 42 / 13 / 29 皆為實測數字（`Grep` 掃 `src/`），非估計。

### 2. 存檔表存**完整 JSONB 快照** + 少數可索引欄位

理由有二：

1. **診斷時要比對的是 JSON 內容**。FIX-150 全程比對的是 `stage_3_result`、`field_mappings`、`pipeline_steps` 這類 JSON 欄位，不是純量欄位。
2. **`extraction_results` 仍在長欄位**。CHANGE-109 才剛加了 `invoiceNumber`，未來還會加。若存檔表鏡像所有欄位，每次主表加欄位都要跟著改，且舊快照會缺欄位。存完整快照則不受影響。

可索引欄位只保留列表與篩選需要的：`documentId`、`versionNo`、`capturedAt`、`status`、`averageConfidence`、`extractionVersion`。

### 3. 不做重複上傳阻擋

DEV 環境反覆上傳同一份檔案是正常的測試行為。阻擋會妨礙工作，且真正的問題是「看不出哪一份是哪一份」，不是「有多份」。分組呈現即可解決。

### 4. 不刪除既有的 731 份重複文件

它們是目前僅存的處理歷史。本變更上線後，新的處理會走正式的版本機制；既有的重複文件維持原狀，由 `file_hash` 分組呈現即可。

---

## 技術設計

### Prisma Schema

```prisma
/// CHANGE-114：提取結果的歷史快照。extraction_results 由 documentId 唯一約束限制為
/// 一份文件一筆，重新處理會 upsert 覆蓋；本表在覆蓋前保存被取代的那一版，
/// 使「AI 每次處理的表現」可回溯比對。只寫不改，永不刪除。
model ExtractionResultVersion {
  id                String   @id @default(uuid())
  documentId        String   @map("document_id")
  /// 同一份文件內遞增，從 1 起算
  versionNo         Int      @map("version_no")
  /// 被取代的那一版的原始 createdAt，非本列的建立時間
  capturedAt        DateTime @map("captured_at")
  /// extraction_results 該列的完整內容。刻意存整份 JSON 而非鏡像欄位：
  /// 診斷比對的對象是 stage_*_result / field_mappings 這類 JSON，
  /// 且主表持續在加欄位（如 CHANGE-109 的 invoiceNumber），鏡像會不斷追改且舊快照缺欄位。
  snapshot          Json
  /// 以下為自 snapshot 反正規化而來的可索引副本，僅供列表與篩選
  status            String?  @map("status")
  averageConfidence Float?   @map("average_confidence")
  extractionVersion String?  @map("extraction_version")
  createdAt         DateTime @default(now()) @map("created_at")

  document          Document @relation(fields: [documentId], references: [id], onDelete: Cascade)

  @@unique([documentId, versionNo])
  @@index([documentId, capturedAt])
  @@index([createdAt])
  @@map("extraction_result_versions")
}
```

`Document` model 加一行關聯：

```prisma
extractionResultVersions ExtractionResultVersion[]
```

> `onDelete: Cascade` 與 `ExtractionResult` 既有設定一致 —— 文件被刪時歷史一併刪除，避免孤兒列。

### 寫入時機

在既有的 upsert 交易**之內**，於 upsert 之前插入存檔：

```
BEGIN
  1. 讀取 extraction_results 當前列（若存在）
  2. 若存在 → INSERT INTO extraction_result_versions（versionNo = 該文件現有最大值 + 1）
  3. UPSERT extraction_results   ← 既有邏輯不動
  4. …既有的其餘交易操作
COMMIT
```

同一交易確保「存檔成功但覆蓋失敗」或反之都不會發生。

| 檔案 | 位置 | 說明 |
|---|---|---|
| `src/services/processing-result-persistence.service.ts` | `:323` | V2 路徑的 upsert |
| `src/services/processing-result-persistence.service.ts` | `:664` | V3.1 路徑的 upsert |
| `src/services/mapping.service.ts` | `:466` | 映射階段的 upsert |

三處共用同一個新的 helper，避免邏輯分歧。

### 手動上傳計算雜湊

`src/app/api/documents/upload/route.ts` 建立 `documents` 記錄時補上：

```typescript
const fileHash = createHash('sha256').update(buffer).digest('hex')
```

比照 `outlook-document.service.ts:388` 既有寫法，不引入新依賴（`node:crypto`）。

### 既有 869 份文件的雜湊回填

以 gated 腳本自 Blob 重新讀取檔案計算雜湊。比照 FIX-150 的三段式 `inspect` / `dryrun` / `write`，node 14 相容 CommonJS。

> ⚠️ 此腳本需在 Azure 容器內執行（本機連不到私有 Blob 與 PG）。放 `prisma/` 而非 `scripts/`，並用 entrypoint gated flag 觸發 —— runner 映像不含 `scripts/` 與 tsx，見 memory `feedback_azure_runner_excludes_scripts_tsx`。

### Azure Migration

🔴 **Prisma migration 不會自動套用到 Azure**。entrypoint 只跑 bootstrap（空庫）與 gated schema-drift，不跑 `migrate deploy`。

必須把本次的 DDL 轉成冪等形式加進 `prisma/apply-schema-drift.js` 的 `MIGRATIONS` 陣列，部署時帶 `RUN_SCHEMA_DRIFT_FIX=true`。否則新程式碼讀新表會 P2022。

（依據：memory `feedback_azure_migration_needs_schema_drift_entry`，CHANGE-103 P2 曾踩過同一個坑。）

### i18n 影響

文件列表的分組呈現與版本歷史檢視需新增 UI 字串。

| 語言 | 文件 | 需要更新的 Key |
|------|------|---------------|
| en | `messages/en/documents.json` | `versionHistory.*`、`duplicates.*` |
| zh-TW | `messages/zh-TW/documents.json` | 同上 |
| zh-CN | `messages/zh-CN/documents.json` | 同上 |

複用既有 `documents` 命名空間，**不新增命名空間**，故不需改 `src/i18n/request.ts`。

---

## 影響範圍評估

### 文件影響清單

| 文件路徑 | 類型 | 說明 |
|----------|------|------|
| `prisma/schema.prisma` | 🔧 修改 | 新增 `ExtractionResultVersion` model + `Document` 加一行關聯 |
| `prisma/migrations/<ts>_add_extraction_result_versions/` | 🆕 新增 | migration |
| `prisma/apply-schema-drift.js` | 🔧 修改 | 加入冪等 DDL 條目（Azure 專用） |
| `src/services/extraction-result-version.service.ts` | 🆕 新增 | 存檔 helper + 歷史查詢 |
| `src/services/processing-result-persistence.service.ts` | 🔧 修改 | 兩處 upsert 前加存檔 |
| `src/services/mapping.service.ts` | 🔧 修改 | `:466` upsert 前加存檔 |
| `src/app/api/documents/upload/route.ts` | 🔧 修改 | 計算 `fileHash` |
| `src/app/api/documents/[id]/versions/route.ts` | 🆕 新增 | 版本歷史查詢 API（Zod + RFC 7807 top-level） |
| `src/components/features/document/detail/` | 🆕 新增 | 版本歷史檢視組件 |
| `messages/{en,zh-TW,zh-CN}/documents.json` | 🔧 修改 | 3 語言同步 |
| `prisma/backfill-file-hash.js` | 🆕 新增 | gated 回填腳本 |

### 向後兼容性

- 新增表與新增欄位值，**不改任何既有欄位語意**
- `extraction_results` 的讀取行為完全不變 —— 42 處 `include` 與 13 處查詢一行都不用動
- 既有 869 份文件在回填前 `file_hash` 為 NULL，分組功能對它們暫時無效，回填後生效
- 本變更**上線前**已存在的處理記錄無法追溯補建（舊資料已被覆蓋），歷史自上線後開始累積

### 資料量估計

存檔表每列含一份完整的 `extraction_results` 快照，其中 `stage_3_result` / `gpt_prompt` / `gpt_response` 可能較大。以目前 851 筆推估單列平均數十 KB。DEV 環境每份文件重複處理次數有限，短期不構成壓力；正式環境需在實作時評估是否要對 `gptPrompt` / `gptResponse` 設保留策略。

> ⚠️ 這是**待確認事項**，不在本變更範圍內先行決定。

---

## 驗收標準

| # | 驗收項目 | 驗收標準 | 優先級 |
|---|----------|----------|--------|
| 1 | 重新處理保存歷史 | 對同一份文件連續處理 3 次後，`extraction_result_versions` 有 2 筆（第 1 次無前值可存），`versionNo` 為 1、2 | High |
| 2 | 存檔內容完整 | 快照可還原出被覆蓋那一版的 `field_mappings`、`stage_3_result`、`pipeline_steps` | High |
| 3 | 交易一致性 | 刻意讓 upsert 失敗，存檔列不得殘留 | High |
| 4 | 既有讀取不受影響 | 42 處 `include: { extractionResult }` 全部行為不變；`type-check` 與 `lint` 通過 | High |
| 5 | 手動上傳計算雜湊 | 新上傳的文件 `file_hash` 非 NULL，且同一檔案兩次上傳雜湊相同 | High |
| 6 | 回填腳本 | `dryrun` 正確列出待回填筆數；`write` 後 869 份的 `file_hash` 皆非 NULL | Medium |
| 7 | 分組呈現 | 文件列表能顯示「此檔案有 N 次上傳」並可展開 | Medium |
| 8 | i18n | 3 語言同步，`npm run i18n:check` 通過 | High |
| 9 | Azure 部署 | `apply-schema-drift.js` 條目冪等，重複執行不報錯；部署後新表存在 | High |

---

## 測試場景

| # | 場景 | 測試步驟 | 預期結果 |
|---|------|----------|----------|
| 1 | 首次處理 | 上傳新文件並處理 | `extraction_results` 1 筆、`extraction_result_versions` 0 筆 |
| 2 | 重新處理 | 對同一文件再處理 1 次 | `extraction_results` 仍 1 筆（新值）、版本表 1 筆（舊值），`versionNo=1` |
| 3 | 多次重新處理 | 再處理 2 次 | 版本表 3 筆，`versionNo` 為 1/2/3，`capturedAt` 遞增 |
| 4 | 交易回滾 | 模擬 upsert 拋錯 | 版本表無新增列 |
| 5 | 重複上傳偵測 | 同一檔案上傳 2 次 | 2 筆 documents，`file_hash` 相同，列表分組顯示 |
| 6 | 不同檔案同名 | 同名但內容不同的檔案 | `file_hash` 不同，**不**分組 |
| 7 | 文件刪除 | 刪除一份有版本歷史的文件 | 版本列一併 cascade 刪除，無孤兒 |
| 8 | 冪等 migration | `apply-schema-drift.js` 連跑 2 次 | 第 2 次不報錯、無副作用 |

---

## 實施計劃

| 階段 | 內容 | 前置條件 |
|---|---|---|
| P1 | Schema + migration + `apply-schema-drift.js` 條目 | — |
| P2 | 存檔 helper + 3 處寫入點接上 + 單元測試 | P1 |
| P3 | 手動上傳計算 `fileHash` + 回填腳本 | P1 |
| P4 | 版本歷史 API + UI + i18n 3 語言 | P2 |
| P5 | Azure DEV 部署（帶 `RUN_SCHEMA_DRIFT_FIX=true`）+ 回填 + 驗收 | P1–P4 |

P2 與 P3 互不相依，可並行。

---

## 風險

| 風險 | 影響 | 緩解 |
|---|---|---|
| 存檔失敗導致處理中斷 | 🔴 高 —— 處理流程被新功能拖累 | 存檔在同一交易內，但實作時需確認失敗時的行為是否應降級為「記錄警告後繼續」，而非讓整份文件處理失敗。**此點需在 P2 實作前決定** |
| 快照體積成長 | 🟡 中 | 先觀察，必要時對 `gptPrompt` / `gptResponse` 設保留策略（另立變更） |
| Azure schema drift 條目寫錯 | 🔴 高 —— 新碼讀不到新表即 P2022 | 條目需冪等；部署前在本機以空庫與非空庫各驗一次 |
| 回填腳本讀 Blob 逾時 | 🟢 低 | 分批 + 可續跑（記錄已處理的 documentId） |

---

## 未納入本變更

| 項目 | 理由 |
|---|---|
| 清理既有 731 份重複文件 | 使用者明確要求保留所有處理記錄；它們是目前僅存的歷史 |
| 阻擋重複上傳 | DEV 需要反覆測試 |
| B1（`extraction_results` 直接改一對多） | 波及 29 個檔案的讀取路徑，效益不足以抵銷風險；已記錄於 §設計決策 供日後重新評估 |
| `gptPrompt` / `gptResponse` 保留策略 | 需先觀察實際體積 |

---

## 相關

- [FIX-150](../bug-fixes/FIX-150-nippon-charge-fields-lost-mapping-slot-contention.md) —— 本變更的起因；其診斷全程依賴目前意外存在的處理歷史
- [CHANGE-109](CHANGE-109-template-instance-newer-invoice-version-detection.md) —— `extraction_results` 最近一次加欄位（`invoiceNumber`），說明為何存檔採完整 JSON 快照
- [CHANGE-103](CHANGE-103-stage1-company-matching-anti-duplication.md) —— Azure schema drift 條目的前例
