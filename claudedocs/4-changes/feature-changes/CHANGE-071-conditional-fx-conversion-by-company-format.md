# CHANGE-071: 條件式 FX 匯率轉換（依公司 × 格式 + 來源幣別條件）

> **日期**: 2026-06-01
> **狀態**: ✅ 已完成（2026-06-01 實作 + config 端到端驗證；文件級 E2E 待測試發票）
> **優先級**: Medium
> **類型**: Feature
> **影響範圍**: PipelineConfig 模型 / 管線配置解析 / V3.1 提取管線 FX 階段 / 管線設定 UI / i18n
> **關聯**: CHANGE-032（Pipeline Ref Match & FX Conversion 初版）、FIX-037（FX 轉換 bug 修復）、Epic 21（Exchange Rate）

---

## 實作筆記（2026-06-01）

> **DB 套用方式修正（事實校正）**：原規劃寫「新增 migration（dry-run）」，但實作時發現本專案 dev DB 的 10 個 migration 為 2025-12 舊 baseline，之後 schema 一律以 `prisma db push` 同步（122 models 遠超 baseline）。`prisma migrate dev` 會誤判 drift 並要求 reset（清空資料），故**改用 `npx prisma db push --accept-data-loss`**（本專案 CLAUDE.md 已列為正常 dev 機制）。已驗證為純增量、零資料損失（pipeline_configs 僅 1 列、新欄位皆 nullable、唯一約束置換無重複衝突）。
>
> 生產環境正式 migration baseline 屬另一範疇（見 CHANGE-056），不在本變更處理。

### 進度
- ✅ **P1 資料層**：schema 改動 + `db push` 套用 + 驗證（新欄位/enum/資料完好）
- ✅ **P2 型別 + 解析**：`EffectivePipelineConfig` 加 `fxSourceCurrencies`/`resolvedFrom.format`；`resolveEffectiveConfig` 四層化（GLOBAL→REGION→COMPANY→FORMAT）+ CRUD
- ✅ **P3 管線 + 轉換器**：`extraction-v3.service.ts` 傳 `formatId`；轉換器 `shouldConvertCurrency` 來源幣別過濾（含 extraCharges）
- ✅ **P4 驗證 schema + UI**：`pipeline-config.schema.ts` FORMAT/refine；`PipelineConfigForm` 公司→格式級聯 + 來源幣別 badge 多選；List/ScopeBadge/Filters 支援 FORMAT；hooks 型別同步
- ✅ **P5 i18n + 品質閘**：三語 `pipelineConfig.json` 新增 key；type-check（0 新錯誤，38 pre-existing）/ i18n:check / lint（本次檔案 0 問題）全通過

> **⚠️ 重要踩坑（已解決）**：`db push` + `prisma generate` 後，**正在運行的 dev server 仍持有舊 `@prisma/client`（FORMAT enum 不存在）**，建立 FORMAT-scoped config 會 500（`Invalid value for argument 'scope'`）。Node 不熱重載 node_modules 的 Prisma client → **schema 變更後必須重啟 dev server**。

### 驗證結果
- ✅ **執行期煙霧測試通過**（dev server 重啟後）：POST 建立 FORMAT config（201）→ `documentFormat` include + `fxSourceCurrencies:["THB"]` 正確序列化 → `/resolve?formatId=` 四層解析回傳 `fxConversionEnabled:true`/`fxTargetCurrency:HKD`/`fxSourceCurrencies:["THB"]`、`resolvedFrom={global, format}`（FORMAT 覆蓋 GLOBAL）→ DELETE 清理（200，DB 還原為 1 筆 GLOBAL）。驗收標準 #1、#2 通過。
- ⏳ **文件級 E2E（待測試發票）**：上傳一份 THB 發票驗證金額轉 HKD、同格式 USD 文件不動（驗收 #3）。轉換器過濾邏輯已靜態驗證（type-check + 沿用既有 pattern），待真實 THB 發票做最終端到端確認。

---

## 變更背景

目前 FX 匯率轉換已接入 V3.1 提取管線（`extraction-v3.service.ts`），由 `PipelineConfig` 控制，但有兩個限制無法滿足實際業務需求：

1. **觸發粒度不足**：`PipelineConfigScope` 只有 `GLOBAL / REGION / COMPANY` 三層，**沒有 FORMAT 層**。無法做到「同一公司、不同格式」套用不同 FX 行為（例如某公司的「空運費用發票」要轉、「海運對帳單」不轉）。

2. **無來源幣別條件**：現行 `ExchangeRateConverterService` 對「任何非目標幣別」一律轉換，無法指定「只轉特定來源幣別」。

### 用戶實際需求

> 不同公司的文件在處理時，要能依**不同條件**決定是否套用匯率轉換。匯率**數值**仍在 exchange rate 模組維護（全域），但「**什麼情況下要轉、轉成什麼幣別、只轉哪些來源幣別**」要能在 pipeline setting 中按「**公司 × 格式**」設定。
>
> 範例：某公司某格式的**泰銖（THB）**文件 → 把抽取金額全部轉成**港元（HKD）**；但同公司同格式的 **USD** 文件不轉。

### 核心設計原則（維持架構意圖）

- **`ExchangeRate` 模型完全不動** —— 匯率數值仍全域、仍由 exchange rate 模組維護。
- 本變更**只擴充 `PipelineConfig` 的觸發條件**，不改變匯率資料的儲存方式。
- **向後相容** —— 既有 config 行為不變（`fxSourceCurrencies` 空清單 = 全轉）。

---

## 變更內容

### 變更項目 1：新增 FORMAT 層級 scope（公司 × 格式）

`PipelineConfig` 新增 `FORMAT` scope，解析改為四層：

```
GLOBAL → REGION → COMPANY → FORMAT （最具體者勝，逐欄位覆蓋）
```

- 由於 `DocumentFormat` 本身已歸屬於某 `Company`，FORMAT scope 的 config 天然就是「公司 × 格式」粒度。
- 技術可行性：FX 轉換跑在 Stage 2（格式識別）**之後**，執行時 `companyId` 與 `formatId` 皆已知（`threeStageResult.stage2?.formatId`），可傳入 `resolveEffectiveConfig`。

### 變更項目 2：新增來源幣別條件 `fxSourceCurrencies`

`PipelineConfig` 新增 `fxSourceCurrencies`（幣別代碼清單）：

- **非空清單**：只有「來源幣別 ∈ 清單」的文件/費用項才轉換，其餘原封不動。
- **空清單 / null**：全轉（現行行為，向後相容）。
- 範例：`["THB"]` → 只有泰銖會被轉成目標幣別，USD 文件略過。
- 同一過濾規則套用到 `standardFields`、`lineItems`、`extraCharges`（後者依各自幣別判斷）。

### 變更項目 3：管線設定 UI 擴充

`PipelineConfigForm` 與列表/徽章組件支援上述新設定：

- Scope radio 新增 `FORMAT` 選項，選擇時顯示「公司 → 格式」級聯選擇器。
- FX 區塊新增「來源幣別清單」multi-select（空 = 全轉）。
- 列表與徽章顯示 FORMAT scope + 格式名稱。

---

## 技術設計

### 修改範圍

| 文件 | 變更內容 |
|------|----------|
| `prisma/schema.prisma` | `PipelineConfigScope` enum 加 `FORMAT`；`PipelineConfig` 加 `documentFormatId String?`（FK → `DocumentFormat`）+ `fxSourceCurrencies Json?`；`DocumentFormat` 加反向關聯 `pipelineConfigs PipelineConfig[]`；唯一約束 `@@unique([scope, regionId, companyId])` → `@@unique([scope, regionId, companyId, documentFormatId])`；加 `@@index([documentFormatId])` |
| `prisma/migrations/` | 新 migration（enum 值 + nullable 欄位 + 約束變更），**先 dry-run 驗證** |
| `src/types/extraction-v3.types.ts` | `EffectivePipelineConfig` 加 `fxSourceCurrencies: string[] \| null` + `resolvedFrom.format?: string` |
| `src/services/pipeline-config.service.ts` | `DEFAULT_EFFECTIVE_CONFIG` 加 `fxSourceCurrencies: null`；`resolveEffectiveConfig` 加 `formatId?` 參數 + 載入 FORMAT config + 四層合併 + 合併 `fxSourceCurrencies`（nullable 覆蓋，同 `fxTargetCurrency`）；CRUD 函式支援 `documentFormatId` / `fxSourceCurrencies` |
| `src/services/extraction-v3/extraction-v3.service.ts` | FX 區塊（約 line 483）`resolveEffectiveConfig` 傳入 `formatId: threeStageResult.stage2?.formatId` |
| `src/services/extraction-v3/stages/exchange-rate-converter.service.ts` | 新增來源幣別過濾：`shouldConvertCurrency(currency, config.fxSourceCurrencies)` helper；`standardFields`/`lineItems` 依文件來源幣別、`extraCharges` 依各自幣別過濾 |
| `src/lib/validations/pipeline-config.schema.ts` | `pipelineConfigScopeSchema` 加 `FORMAT`；create/update schema 加 `documentFormatId`（FORMAT 時必填）+ `fxSourceCurrencies`（3 碼幣別陣列，optional）；加 `.refine` FORMAT 需 documentFormatId |
| `src/components/features/pipeline-config/PipelineConfigForm.tsx` | scope radio 加 FORMAT；FORMAT 時顯示公司→格式級聯選擇器；FX 區塊加 `fxSourceCurrencies` multi-select |
| `src/components/features/pipeline-config/PipelineConfigList.tsx` | 顯示 FORMAT scope + 格式名 |
| `src/components/features/pipeline-config/PipelineConfigScopeBadge.tsx` | 支援 FORMAT 徽章 |
| `src/hooks/use-pipeline-configs.ts` | 型別補 `documentFormatId` / `fxSourceCurrencies`（如有需要） |

### 四層解析邏輯（`resolveEffectiveConfig`）

```
load GLOBAL  (scope=GLOBAL, regionId=null, companyId=null)
load REGION  (scope=REGION, regionId, isActive)          // if regionId
load COMPANY (scope=COMPANY, companyId, isActive)         // if companyId
load FORMAT  (scope=FORMAT, documentFormatId=formatId)    // if formatId（新增）

merge 順序：GLOBAL → REGION → COMPANY → FORMAT（逐欄位，後者覆蓋）
- 沿用 FIX-037 BUG-4 顯式覆蓋策略（GLOBAL 一律採用；非 GLOBAL 只覆蓋與 Prisma 預設不同的欄位）
- fxSourceCurrencies：nullable 欄位，僅非 null 時覆蓋（同 fxTargetCurrency 處理方式）
- resolvedFrom 加入 format 來源 ID
```

### 來源幣別過濾邏輯（`exchange-rate-converter.service.ts`）

```
shouldConvertCurrency(currency, fxSourceCurrencies):
  if !fxSourceCurrencies || fxSourceCurrencies.length === 0 → true   // 全轉（向後相容）
  return fxSourceCurrencies.map(toUpper).includes(currency.toUpperCase())

- standardFields / lineItems：依文件來源幣別（standardFields.currency）判斷一次
  → 若不通過：return enabled:true, conversions:[], warnings:['source currency X 不在 fxSourceCurrencies 過濾清單內，略過']
- extraCharges：逐筆依 charge.currency（或 fallback 來源幣別）判斷
```

### i18n 影響

| 語言 | 文件 | 需要更新的 Key |
|------|------|---------------|
| en | `messages/en/pipelineConfig.json` | `scope.FORMAT`、`form.format`、`form.selectFormat`、`form.fxSourceCurrencies`、`form.fxSourceCurrenciesPlaceholder`、`form.fxSourceCurrenciesDescription` |
| zh-TW | `messages/zh-TW/pipelineConfig.json` | 同上 |
| zh-CN | `messages/zh-CN/pipelineConfig.json` | 同上 |

> 完成後執行 `npm run i18n:check` 驗證三語同步。

### 資料庫影響

- **新增欄位（皆 nullable，向後相容）**：`pipeline_configs.document_format_id`、`pipeline_configs.fx_source_currencies`。
- **enum 擴充**：`PipelineConfigScope` 加 `FORMAT`（僅新增值，不影響既有）。
- **唯一約束變更**：`[scope, region_id, company_id]` → `[scope, region_id, company_id, document_format_id]`。既有唯一 GLOBAL 列 `[GLOBAL, null, null, null]` 仍唯一，遷移安全。
- **migration 必須先 dry-run**（`npx prisma migrate dev --create-only` 檢視 SQL 再套用）。

---

## 設計決策

1. **以 FORMAT scope 實現「公司 × 格式」，而非在 ExchangeRate 加歸屬維度** —— 匯率本質全域；「條件」屬於 pipeline 設定，符合既有架構拆分，且 `DocumentFormat` 已隸屬公司，FORMAT scope 天然涵蓋「公司 × 格式」。
2. **`fxSourceCurrencies` 空 = 全轉** —— 確保既有 GLOBAL config 升級後行為零變化，向後相容。
3. **FORMAT 選擇器用「公司 → 格式」級聯** —— `DocumentFormat` 屬於公司，級聯比攤平清單更清楚、避免誤選他公司格式。
4. **來源幣別過濾同時套用 extraCharges** —— 附加費可能有獨立幣別，需逐筆判斷，與標準欄位行為一致。
5. **沿用 FIX-037 BUG-4 顯式覆蓋策略** —— 四層合併不破壞現有「明確設定 vs Prisma 預設」的區分邏輯。

---

## 影響範圍評估

### 文件影響清單

| 文件路徑 | 類型 | 說明 |
|----------|------|------|
| `prisma/schema.prisma` | 🔧 修改 | enum + 2 nullable 欄位 + 反向關聯 + 唯一約束 + 索引 |
| `prisma/migrations/{new}/migration.sql` | 🆕 新增 | DB 遷移（dry-run 先行） |
| `src/types/extraction-v3.types.ts` | 🔧 修改 | `EffectivePipelineConfig` 加 2 欄位 |
| `src/services/pipeline-config.service.ts` | 🔧 修改 | 解析四層化 + CRUD 支援新欄位 |
| `src/services/extraction-v3/extraction-v3.service.ts` | 🔧 修改 | 傳入 formatId |
| `src/services/extraction-v3/stages/exchange-rate-converter.service.ts` | 🔧 修改 | 來源幣別過濾 |
| `src/lib/validations/pipeline-config.schema.ts` | 🔧 修改 | scope + 新欄位驗證 |
| `src/components/features/pipeline-config/PipelineConfigForm.tsx` | 🔧 修改 | FORMAT scope + 級聯 + 幣別 multi-select |
| `src/components/features/pipeline-config/PipelineConfigList.tsx` | 🔧 修改 | FORMAT 顯示 |
| `src/components/features/pipeline-config/PipelineConfigScopeBadge.tsx` | 🔧 修改 | FORMAT 徽章 |
| `src/hooks/use-pipeline-configs.ts` | 🔧 修改 | 型別補欄位（如需） |
| `messages/{en,zh-TW,zh-CN}/pipelineConfig.json` | 🔧 修改 | 三語新增 key |

### 向後兼容性

- **既有 1 筆 GLOBAL config**：升級後 `documentFormatId=null`、`fxSourceCurrencies=null` → 行為完全不變。
- **API 既有呼叫**：`resolveEffectiveConfig` 新增 `formatId` 為 optional，不傳則退化為三層（現行行為）。
- **轉換器**：`fxSourceCurrencies` 空時走原邏輯，現有已啟用 FX 的 config 不受影響。
- **唯一約束**：擴充欄位皆 nullable，既有資料不衝突。

---

## 實施計劃（分階段）

| 階段 | 內容 | 驗證 |
|------|------|------|
| **P1 資料層** | schema 改動 + migration（dry-run → 套用）；`prisma generate` | `npx prisma migrate dev` 成功、既有資料完整 |
| **P2 型別 + 解析** | `extraction-v3.types.ts` + `pipeline-config.service.ts` 四層解析 | `npm run type-check` 通過、單元驗證四層覆蓋 |
| **P3 管線 + 轉換器** | `extraction-v3.service.ts` 傳 formatId + `exchange-rate-converter.service.ts` 幣別過濾 | 端到端：THB 文件 → HKD；USD 文件略過 |
| **P4 驗證 schema + UI** | `pipeline-config.schema.ts` + Form/List/Badge | 表單可建 FORMAT config、級聯選格式、幣別清單 |
| **P5 i18n + 收尾** | 三語 json + `i18n:check` + lint | `npm run lint` / `i18n:check` 全綠 |

---

## 風險評估

| 風險 | 等級 | 緩解 |
|------|------|------|
| 唯一約束變更影響既有資料 | 低 | nullable 欄位 + dry-run 驗證；既有列仍唯一 |
| 四層合併邏輯破壞現有 REGION/COMPANY 行為 | 中 | 沿用 FIX-037 BUG-4 策略；補單元測試覆蓋 4 種 scope 組合 |
| FORMAT config 與 COMPANY config 解析優先序混淆 | 中 | 明確定義 FORMAT 最具體；文件 + 測試固定順序 |
| 來源幣別大小寫不一致導致過濾失效 | 低 | 統一 `toUpperCase()` 比對 |
| UI 級聯選擇器載入大量格式效能 | 低 | 依公司載入格式、分頁/limit |

---

## 回滾計劃

- **程式碼**：各階段獨立 commit，可逐步 revert（P5 → P1）。
- **資料庫**：migration 僅新增 nullable 欄位 + enum 值 + 約束擴充；回滾 migration 需先確認無 FORMAT-scope 資料存在，再還原唯一約束與欄位（保留 enum 值避免破壞既有列亦可）。
- **功能開關**：未建立任何 FORMAT-scope config 時，系統行為等同變更前，可「不啟用」即達成事實回滾。

---

## 驗收標準

| # | 驗收項目 | 驗收標準 | 優先級 |
|---|----------|----------|--------|
| 1 | FORMAT scope 可建立 | 在 pipeline setting 用「公司→格式」級聯建立 FORMAT-scoped config | High |
| 2 | 四層解析正確 | FORMAT config 覆蓋 COMPANY/REGION/GLOBAL；無 FORMAT 時退化三層 | High |
| 3 | 來源幣別過濾 | `fxSourceCurrencies=["THB"]` 時：THB 文件轉換、USD 文件略過並記 warning | High |
| 4 | extraCharges 過濾 | 附加費依各自幣別套用同過濾 | Medium |
| 5 | 向後相容 | 既有 GLOBAL config 行為不變；`fxSourceCurrencies` 空 = 全轉 | High |
| 6 | i18n 同步 | 三語 `pipelineConfig.json` 同步、`i18n:check` 通過 | High |
| 7 | 品質閘 | `type-check` / `lint` / migration dry-run 全通過 | High |

---

## 測試場景

| # | 場景 | 測試步驟 | 預期結果 |
|---|------|----------|----------|
| 1 | FORMAT scope FX 啟用 | 建公司 A 格式 F 的 FORMAT config（FX on, target=HKD, sources=["THB"]）→ 上傳該公司該格式 THB 發票 | 金額轉成 HKD，`fxConversionResult` 含轉換項 |
| 2 | 來源幣別不符 | 同上 config，上傳 USD 發票 | 不轉換，warnings 記「USD 不在過濾清單」 |
| 3 | 四層覆蓋 | GLOBAL FX off + COMPANY FX on(target=USD) + FORMAT FX on(target=HKD) → 處理該格式文件 | 採 FORMAT 設定（target=HKD） |
| 4 | 退化三層 | 文件無對應 FORMAT config，僅 COMPANY config | 採 COMPANY 設定（現行行為） |
| 5 | 向後相容 | 既有 GLOBAL config（未改）處理任意文件 | 行為與變更前一致 |
| 6 | extraCharges 多幣別 | 文件主幣別 THB、附加費含 USD，sources=["THB"] | 僅 THB 項轉換，USD 附加費略過 |

---

## 待釐清項（實作前可選確認）

- `fxSourceCurrencies` 的 UI 來源清單：用 exchange rate 模組現有幣別（USD/AUD/CNY/EUR/GBP/HKD/JPY/SGD/TWD）作為下拉選項，或允許自由輸入 3 碼？（建議：下拉 + 既有幣別，避免錯字）
- FORMAT scope 是否需同時保留 `companyId`（雙鍵）以利列表篩選，或僅靠 `documentFormatId`（格式已隱含公司）即可？（建議：僅 documentFormatId，避免冗餘）

---

*文件建立日期: 2026-06-01*
*最後更新: 2026-06-01*
*狀態: ⏳ 待實作（已取得用戶設計批准，本次只規劃）*
