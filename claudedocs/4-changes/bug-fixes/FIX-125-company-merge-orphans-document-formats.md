# FIX-125: 公司合併不轉移 `documentFormats` 等關聯，格式孤立於已合併公司

> **建立日期**: 2026-07-21
> **發現方式**: Azure DEV 部署 FIX-115 後查證為何多格式辨識仍無效
> **影響頁面/功能**: 公司合併（admin 合併 UI / 疑似重複審核 / Stage 1 自動合併）→ Stage 2 已知格式清單
> **優先級**: 高
> **狀態**: ✅ 程式修復已完成（2026-07-21）；本地存量已清理，Azure DEV 存量待處理

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
- [x] 合併後 Stage 2 的 `${knownFormats}` 能列出原屬副公司的格式 —— **端到端驗證 11/11 通過**（見下方）
- [ ] 🚧 存量盤點腳本可在 Azure DEV 執行（現有腳本為 tsx，Azure runner 映像不含 tsx，需另寫 `prisma/*.js` 版本）

#### 端到端驗證（2026-07-21）

單元測試只證明「轉移函數改寫了 `companyId`」，但 FIX-125 的目的是讓 FIX-115 在合併過的公司身上生效 ——
中間還隔著 `loadFormatConfig` 的查詢與 `buildStage2VariableContext` 的字串組裝。
`scripts/local-verify-fix125-known-formats.ts` 串起三段**真實程式碼**（不複製查詢邏輯），
在 sandbox 公司上實跑合併並在 `finally` 清除：

| 驗證項 | 結果 |
|--------|------|
| 合併前目標公司清單不含副公司格式（基準） | ✅ |
| `documentFormats` 轉移 1 筆 | ✅ |
| 撞鍵格式被跳過並記入 `skipped`（情境 B） | ✅ |
| 🔴 合併後清單**包含**原屬副公司的格式（情境 A） | ✅ |
| 目標公司原有格式未被覆寫，清單為 2 筆 | ✅ |
| 配置來源為 `COMPANY_SPECIFIC` | ✅ |
| 🔴 `${knownFormats}` 字串含轉移過來的格式名 | ✅ |
| `${knownFormats}` 保留識別關鍵字供 GPT 判別版面 | ✅ |
| 撞鍵格式仍留在副公司名下（未被靜默改動） | ✅ |
| 轉移的是同一筆記錄（id 不變，非複製） | ✅ |
| 目標公司原有格式內容未受影響 | ✅ |

GPT 實際會看到的清單（驗證輸出）：

```
- __FIX125_VERIFY__ General Layout (target, incumbent): incumbent-keyword
- __FIX125_VERIFY__ Ocean Freight Layout (transferable): bill-of-lading, vessel
```

第二行即原屬副公司、經合併轉移而來的格式 —— **這正是 Azure CEVA 情境中缺席、導致 FIX-115 失效的那一行**。
sandbox 資料已清除（`psql` 獨立核實殘留為 0）。

---

## 修改的檔案

| 檔案 | 修改內容 |
|------|----------|
| `src/services/company-merge-transfer.service.ts` | **新增** —— 6 類關聯轉移 + 唯一鍵守門 + 跳過報告 |
| `src/services/company.service.ts` | `mergeCompanies`、`confirmCompanyMerge`：接入轉移，回傳值加 `knowledgeTransfer` |
| `src/services/company-auto-create.service.ts` | `autoMergeCompanies`：同上，並改寫記錄舊假設的過時註解 |
| `tests/unit/services/company-merge-transfer.test.ts` | **新增** —— 6 條迴歸測試 |
| `scripts/local-inspect-merged-company-orphans.ts` | **新增** —— 唯讀存量盤點（含撞鍵模擬、`mergedIntoId` 缺失偵測） |
| `scripts/local-verify-fix125-known-formats.ts` | **新增** —— 端到端驗證：sandbox 實跑合併 → 真實 `loadFormatConfig` → 真實 `${knownFormats}` 組裝 |
| `scripts/local-cleanup-test-residue.ts` | **新增** —— gated 清除本地測試殘留（安全條件驗證 + dry-run 預設） |

---

## 存量處理

程式修復只影響**今後**的合併。現有孤立資料需一次性處理：

| 環境 | 現況 |
|------|------|
| 本地 | ✅ **已處理（2026-07-21）** —— 查證後為測試殘留，非業務資料，已刪除（見下） |
| Azure DEV | 🚧 CEVA 曾有 8 格式散落 8 間公司（2026-07-20 已手動修復一部分）；另有 4 筆 `templateFieldMappings` + 1 筆 `fieldDefinitionSets` 遺留於 `7448b7c5-…`。盤點腳本為 tsx，Azure runner 映像不含 tsx，需另寫 `prisma/*.js` 版本 |

依決議，盤點腳本**只列出待辦、不自動推斷目標** —— 公司名稱相似度推斷正是 CHANGE-103 在治理的問題，不應在此重蹈。

### 🔴 本地存量的真相：不是該歸位的知識，是測試殘留

原假設是「3 個孤立格式代表 DHL 的三種版面，應歸位到存活公司」。查證後**推翻**：

| 佐證 | 內容 |
|------|------|
| 建立時間 | 3 間公司、3 個格式、4 筆 Prompt 配置全部集中在 **2026-06-16 06:22~06:32 的 10 分鐘內**，TEST 配置與 `AUTO_CREATED` 公司交錯出現 |
| 使用情況 | 3 個格式 `fileCount` **全為 0**，3 間公司文件數 0 |
| 命名 | 4 筆 Prompt 配置名稱皆以 `TEST ` 起始，`description` 標明「示範用 COMPANY scope 模板」 |
| 內容 | 3 個格式的 `identificationRules` 描述高度雷同（DHL Logo、`Type of Service / Total of Charges` 表格、`DUTY TAX PAID`、底部銀行資訊），**連舉例日期都是同一組**（24/11/2025、01/12/2025） |

即三者不是三種版面，而是**同一版面因公司被重複 `AUTO_CREATED` 三次而各建一份** —— 正是 FIX-124 所治問題的歷史遺留。轉移它們反而有害：測試用的版面描述會進入 `${knownFormats}`，讓 GPT 處理真實 DHL 文件時看到三份雷同的假版面。

### 🔴 連帶發現的現行 bug：3 筆啟用中的 TEST override

清查時發現同批的 3 筆 Prompt 配置 `is_active = true` 且掛在**有真實文件的 ACTIVE 公司**上，並非單純殘留：

| 配置 | 掛載公司 | 受影響文件 |
|------|----------|-----------|
| `TEST DHL EXPRESS HK Stage2 COMPANY override` | DHL Express | 41 份 |
| `TEST RICH KING HONG Stage2 COMPANY override` | RICH KING HONG LIMITED | 1 份 |
| `TEST MODERN LEASING Stage2 COMPANY override` | MODERN LEASING LIMITED | 1 份 |

三者 `merge_strategy = OVERRIDE`、`scope = COMPANY`，會**整個取代**全域 Stage 2 prompt，造成兩項具體損害：

1. **`${knownFormats}` 被洗掉** —— 覆蓋用的 `user_prompt_template` 僅一句「請分析這張 DHL 文件圖片，識別其格式類型，並依指定 JSON 格式輸出。」，不含該變數。FIX-115 的注入對這些公司完全失效，與 Azure CEVA 同病而異因（CEVA 是格式散落，此處是 prompt 覆蓋）。
2. **誘導 `matchedKnownFormat` 恆為 null** —— `system_prompt` 把 `"matchedKnownFormat": null` 寫死在輸出 JSON 範例裡。該欄位正是 `resolveFormatId` 的比對輸入，等於教模型不要匹配，FIX-123 的比對鏈拿不到有效輸入。

其 `system_prompt` 開頭寫「你是 **DHL EXPRESS (HK) LIMITED** 專屬的…」，指的是已 MERGED 的測試公司，並非它實際掛載的 ACTIVE `DHL Express`。

### 執行結果（2026-07-21）

`scripts/local-cleanup-test-residue.ts`，gated by `RUN_DELETE_TEST_RESIDUE=true`，預設 dry-run。刪除前逐項驗證安全條件，任一不符即中止且不刪任何資料：

- Prompt 配置：名稱須以 `TEST ` 起始、`scope = COMPANY`、`promptType = STAGE_2_FORMAT_IDENTIFICATION`
- 格式：`fileCount = 0`、5 類子關聯皆為 0、須隸屬於待刪公司
- 公司：`status = MERGED`、`source = AUTO_CREATED`、16 類關聯皆為 0

實際刪除 **4 筆 Prompt 配置、3 個格式、3 間公司**（交易內，由葉往根）。

驗證（兩個獨立來源）：盤點腳本重跑顯示 MERGED 公司 0 間、孤立 0 筆；`psql` 查詢 `TEST %` 配置 0 筆、MERGED 公司 0 間、MERGED 名下格式 0 個。三間 ACTIVE 公司的格式數維持 2 / 1 / 1 未變動，確認無誤刪。

---

## 關聯

- FIX-112 — 補上 documents / extractionResults / mappingRules 的轉移，並在該次確立「其餘刻意不轉」的假設；本 FIX 質疑該假設
- FIX-113 — 存量孤兒盤點（當時只查 documents / extraction_results / rules，**範圍不含格式**，故未發現本問題）
- FIX-115 — 因本問題而在 Azure 完全無效，是本問題的發現路徑
- 部署記錄 `docs/07-deployment/02-azure-deployment/deployment-records/2026-07-20-dev-ceva-format-consolidation.md` — Azure 手動修復的完整經過與回滾資料

---

*文件建立日期: 2026-07-21*
*最後更新: 2026-07-21*
