# FIX-125: 公司合併不轉移 `documentFormats` 等關聯，格式孤立於已合併公司

> **建立日期**: 2026-07-21
> **發現方式**: Azure DEV 部署 FIX-115 後查證為何多格式辨識仍無效
> **影響頁面/功能**: 公司合併（admin 合併 UI / 疑似重複審核 / Stage 1 自動合併）→ Stage 2 已知格式清單
> **優先級**: 高
> **狀態**: ✅ 程式修復已完成（2026-07-21）；存量資料處理待執行

---

## 問題描述

公司合併只轉移 `documents` / `extractionResults` / `mappingRules` 三類關聯，`documentFormats`、`fieldDefinitionSets`、`templateFieldMappings` 等**留在已設為 `MERGED` 的副公司名下**。

由於 Stage 2 組 `${knownFormats}` 清單是**依存活公司的 `companyId` 查詢**，這些格式永遠不會進入清單 —— 該公司的多版面辨識能力等同失效。

> 🔴 **本問題不是疏漏，而是一個明示的設計假設不成立**。詳見「根本原因」。

---

## 重現步驟

1. 公司 A（存活）與公司 B（重複）各自底下已有 `DocumentFormat`。
2. 執行合併，B → A（B 狀態變 `MERGED`、`mergedIntoId = A`）。
3. 上傳一份符合「B 名下那個格式」版面的文件。
4. 觀察現象：Stage 2 的 `${knownFormats}` 只列出 A 名下的格式，B 的格式從未出現；文件無法匹配，落入 JIT。

---

## 根本原因

三個合併實作皆只轉移三類關聯：

| 函數 | 位置 | 轉移範圍 |
|------|------|----------|
| `mergeCompanies` | `company.service.ts:1539` | documents / extractionResults / mappingRules |
| `confirmCompanyMerge` | `company.service.ts:1848` | 同上 |
| `autoMergeCompanies` | `company-auto-create.service.ts:457` | 同上 |

`autoMergeCompanies` 中有明確註解記錄了這個決定（`:500-501`）：

```
// 與 company.service.ts 的 confirmCompanyMerge 一致，僅轉移這三類；
// document_formats / field_definition_sets 等刻意不轉（副公司設 MERGED 後 inert）。
```

**假設是「副公司設 MERGED 後即 inert（惰性、無作用）」。這個假設對 `documents` 成立，對 `documentFormats` 不成立** ——

格式代表的是「這間公司會寄來的版面」這項**知識**。公司合併後，存活公司**仍會收到那些版面的文件**，但辨識該版面所需的格式定義卻被留在一個永遠不會被查詢的公司身上。它不是 inert，而是**遺失**。

### 實測證據（Azure DEV，2026-07-20）

CEVA 在 Azure 有 8 筆公司記錄，其中 7 筆已 `MERGED` 至 `CEVA LOGISTICS (HONG KONG) LTD`。**8 個格式散落在 8 間公司身上，存活公司名下只有 1 個**：

| 公司 | 狀態 | 文件數 | 名下格式 |
|------|------|-------:|---------:|
| CEVA LOGISTICS (HONG KONG) LTD | ACTIVE | 212 | 1 |
| 其餘 7 間 | MERGED | 0 | 各 1 |

後果：FIX-115（注入 `${knownFormats}`）部署到 Azure 後**完全沒有效果** —— 清單永遠只有一個選項，GPT 無從選擇。必須手動把版面 B 的格式改掛到存活公司，多格式辨識才開始運作。

同時發現 `7448b7c5-…`（MERGED）名下還遺留 4 筆 `templateFieldMappings` + 1 筆 `fieldDefinitionSets`。

### 未轉移的關聯全貌

`Company` 共 18 個一對多關聯，目前只轉移 3 個，其餘 15 個未處理：

`correctionPatterns`、`dataTemplates`、**`documentFormats`**、`correctionHistories`、`fieldMappingConfigs`、`transactionParticipations`、`issuedDocuments`、`identifiedHistoricalFiles`、`promptConfigs`、`changeRequests`、`ruleSuggestions`、`testTasks`、**`templateFieldMappings`**、`pipelineConfigs`、**`fieldDefinitionSets`**

粗體三者已有實證影響，其餘需逐一評估（部分確實適合留在原地，例如歷史性質的 `issuedDocuments`）。

---

## 解決方案

### 🔴 需用戶決策：是否推翻「MERGED 後 inert」的假設

本 FIX 的核心不是寫程式，而是**改變一個已記錄在案的設計決定**。建議範圍分兩層：

| 層級 | 轉移對象 | 理由 |
|------|----------|------|
| **最小必要**（建議） | `documentFormats`、`fieldDefinitionSets`、`templateFieldMappings` | 三者皆有實證影響：格式辨識、欄位定義、模板映射在合併後失效 |
| 完整 | 其餘 12 類逐一評估 | 需個別判斷語義；部分保留在原地才正確 |

### 技術障礙：`documentFormats` 唯一鍵衝突

`DocumentFormat` 有唯一鍵 `(companyId, documentType, documentSubtype)`。若兩間公司各有一筆 `INVOICE/GENERAL` 格式，直接 `updateMany` 轉移**必然撞鍵**。

（2026-07-20 手動修復 Azure CEVA 時即遇到此情況，當時以人工判定版面後改用 `OCEAN_FREIGHT` subtype 繞開。）

處理方式需用戶選擇：

| 選項 | 做法 | 評估 |
|------|------|------|
| **A** | 撞鍵時**不轉移**、記錄警告，交由人工處理 | 安全、不猜測；但合併後仍需人工收尾 |
| B | 撞鍵時自動改用未使用的 subtype | 自動化程度高；但 subtype 具業務語義，程式無從判斷該格式是海運或空運，會污染資料 |
| C | 撞鍵時合併兩格式的 `identificationRules` | 看似聰明，實則把兩種不同版面的特徵混在一起，會**降低**辨識準確度（參考 FIX-119 的教訓） |

**建議 A** —— 與 FIX-120 / FIX-124 的處置原則一致：不確定時回報，不猜測。

### 存量資料

現有已合併公司名下的孤立格式**不會**因程式修復而自動歸位，需一次性盤點腳本（可比照 FIX-113 的做法：先 inspect、再 gated write）。

---

## 實作記錄（2026-07-21）

### 用戶決策

| 項目 | 決定 |
|------|------|
| 轉移範圍 | **公司處理知識類 6 種**：`documentFormats`、`fieldDefinitionSets`、`templateFieldMappings`、`promptConfigs`、`pipelineConfigs`、`fieldMappingConfigs` |
| 唯一鍵衝突 | **選項 A** —— 不轉移 + 記錄警告，交人工處理 |
| 存量 `mergedIntoId` 缺失 | 盤點腳本列出待辦，**不自動推斷** |

「公司處理知識」的判準是「這間公司的文件該怎麼處理」。歷史性質的關聯（`issuedDocuments`、`correctionHistories`、`identifiedHistoricalFiles`、`transactionParticipations` 等）**刻意留在原地** —— 它們記錄「當時是哪間公司」，轉走會扭曲審計事實。

### 盤點發現（實作前調查，本地環境）

**1. 6 類關聯的唯一鍵全部含 `companyId`** —— 不只 `documentFormats`，`updateMany` 對每一類都不安全：

| Model | 唯一鍵 |
|-------|--------|
| `DocumentFormat` | `(companyId, documentType, documentSubtype)` ← 三欄皆 non-null，必然撞鍵 |
| `FieldDefinitionSet` / `FieldMappingConfig` | `(scope, companyId, documentFormatId)` |
| `PromptConfig` | `(promptType, scope, companyId, documentFormatId)` |
| `TemplateFieldMapping` | `(dataTemplateId, scope, companyId, documentFormatId)` |
| `PipelineConfig` | `(scope, regionId, companyId, documentFormatId)` |

**2. 撞鍵率實測 2/3** —— 本地 3 間 MERGED 的 DHL 公司各有 1 個格式，**全部是 `INVOICE/GENERAL`**；目標 `DHL Express` 沒有該組合，故第 1 個可轉、第 2、3 個互撞。與 Azure CEVA 手動修復時遇到的情況一致。

**3. 規劃外的障礙：3 間 MERGED 公司全部 `mergedIntoId = null`** —— 程式無從得知該轉去哪，即使修好合併函數，這批存量也無法自動歸位。

**4. `promptConfigs` 也有孤立**（本地 1 筆），而規劃的「最小必要三類」中 `fieldDefinitionSets` / `templateFieldMappings` 在本地實測皆為 0 —— 這是把範圍擴為 6 類的實證依據。

### 實作內容

**新增** `src/services/company-merge-transfer.service.ts`：

- `transferCompanyKnowledge(tx, sourceIds, targetId)` —— 6 類逐筆轉移，每類依自身唯一鍵查詢目標是否已存在相同組合，撞鍵則跳過並記入 `skipped`
- **配置跟隨格式**：FORMAT scope 的配置若其 `documentFormat` 因撞鍵未能轉移，該配置一併跳過 —— 否則配置轉到新公司卻指向留在舊公司的格式，語義矛盾
- `logMergeTransferSkips(report, context)` —— 輸出警告。撞鍵不轉移是刻意處置，但若不記錄就會變成另一種靜默失敗（使用者以為合併完成，實際知識仍留在原公司）

> 🔴 **不使用 try/catch 捕捉 P2002**：PostgreSQL 中語句失敗會使交易進入 aborted 狀態，後續語句全部失敗。必須「先查詢再決定」。

**三個呼叫點統一接入**（行為一致）：

| 函數 | 檔案 | 變更 |
|------|------|------|
| `mergeCompanies` | `company.service.ts` | 轉移規則後呼叫，回傳值加 `knowledgeTransfer` |
| `confirmCompanyMerge` | `company.service.ts` | 同上 |
| `autoMergeCompanies` | `company-auto-create.service.ts` | 同上，並改寫 `:499-501` 記錄舊假設的過時註解 |

回傳型別為擴充（加欄位），API route 直接回傳 `result`、前端 hook 不解析內容，無破壞性變更。

### 測試驗證

- [x] 合併後副公司名下的 `documentFormats` 已轉移至存活公司
- [x] 唯一鍵衝突時**不轉移**且有明確警告（測試斷言 `update` 未被呼叫、`skipped` 含衝突對象名稱）
- [x] 三個合併函數行為一致（皆呼叫同一 `transferCompanyKnowledge`）
- [x] FORMAT scope 配置在其格式未轉移時一併跳過；COMPANY scope（`documentFormatId` 為 null）不受影響
- [x] `npm run type-check` 無錯誤
- [x] `npm run lint` —— 新模組與 `company-auto-create.service.ts` 零警告
- [x] 單元測試 **6 passed**（`tests/unit/services/company-merge-transfer.test.ts`）；全套 97 passed / 4 failed（失敗為 Epic 23 gateway 既有問題）
- [ ] 🚧 合併後 Stage 2 的 `${knownFormats}` 能列出原屬副公司的格式（需實跑合併驗證）
- [ ] 🚧 存量盤點腳本可在 Azure DEV 執行（現有腳本為 tsx，Azure runner 映像不含 tsx，需另寫 `prisma/*.js` 版本）

---

## 修改的檔案

| 檔案 | 修改內容 |
|------|----------|
| `src/services/company-merge-transfer.service.ts` | **新增** —— 6 類關聯轉移 + 唯一鍵守門 + 跳過報告 |
| `src/services/company.service.ts` | `mergeCompanies`、`confirmCompanyMerge`：接入轉移，回傳值加 `knowledgeTransfer` |
| `src/services/company-auto-create.service.ts` | `autoMergeCompanies`：同上，並改寫記錄舊假設的過時註解 |
| `tests/unit/services/company-merge-transfer.test.ts` | **新增** —— 6 條迴歸測試 |
| `scripts/local-inspect-merged-company-orphans.ts` | **新增** —— 唯讀存量盤點（含撞鍵模擬、`mergedIntoId` 缺失偵測） |

---

## 存量處理（待執行）

程式修復只影響**今後**的合併。現有孤立資料需一次性處理：

| 環境 | 現況 | 障礙 |
|------|------|------|
| 本地 | 3 個 `documentFormat` + 1 個 `promptConfig` 孤立於 3 間 MERGED 的 DHL 公司 | 全部 `mergedIntoId = null`，且 3 個格式同為 `INVOICE/GENERAL`（轉入同一目標會撞 2 筆） |
| Azure DEV | CEVA 曾有 8 格式散落 8 間公司（2026-07-20 已手動修復一部分）；另有 4 筆 `templateFieldMappings` + 1 筆 `fieldDefinitionSets` 遺留於 `7448b7c5-…` | 盤點腳本為 tsx，Azure runner 映像不含 tsx，需另寫 `prisma/*.js` 版本 |

依決議，盤點腳本**只列出待辦、不自動推斷目標** —— 公司名稱相似度推斷正是 CHANGE-103 在治理的問題，不應在此重蹈。

---

## 關聯

- FIX-112 — 補上 documents / extractionResults / mappingRules 的轉移，並在該次確立「其餘刻意不轉」的假設；本 FIX 質疑該假設
- FIX-113 — 存量孤兒盤點（當時只查 documents / extraction_results / rules，**範圍不含格式**，故未發現本問題）
- FIX-115 — 因本問題而在 Azure 完全無效，是本問題的發現路徑
- 部署記錄 `docs/07-deployment/02-azure-deployment/deployment-records/2026-07-20-dev-ceva-format-consolidation.md` — Azure 手動修復的完整經過與回滾資料

---

*文件建立日期: 2026-07-21*
*最後更新: 2026-07-21*
