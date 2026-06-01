# CHANGE-073: FX 來源幣別 fallback — 由 PipelineConfig 指定

> **日期**: 2026-06-01
> **狀態**: ⏳ 待實作（僅規劃；含 H1 觸發，實作前需用戶批准）
> **優先級**: High（真實 THB→HKD 業務場景的關鍵阻塞）
> **類型**: Feature
> **影響範圍**: PipelineConfig（122 models 之一）/ FX 換算器來源幣別解析 / Pipeline Config UI / i18n
> **關聯**: CHANGE-071（FORMAT scope 條件式 FX）、CHANGE-072（覆蓋寫回 + 動態欄位）、Epic 21（匯率）

---

## 變更背景

CHANGE-072 的真實發票 E2E 測試揭露一個阻塞真實業務場景的 gap：

- FX 換算器**只從 `stage3Result.standardFields.currency.value` 取來源幣別**；取不到就略過（不換算）。
- 實測發現：用戶為多間公司建立的「純費用金額」FieldDefinitionSet（如 Fairate Express 的 6 個 `currency` 型欄位 `handling_charge` / `terminal_charge` …）**完全沒有「幣別代碼」欄位**，文件抽取結果的 `standardFields.currency` 為空 → FX **永遠略過**。
- 用戶最在意的場景「**某公司某格式的文件固定是 THB，要全部換成 HKD**」正是這種資料形態：幣別是「該格式的已知屬性」，而非從文件逐張抽取。

> 即 CHANGE-072「待釐清項 1」預留的 fallback：當抽取無來源幣別時，需可由設定指定。

---

## 變更內容

### 變更項目 1：PipelineConfig 新增「指定來源幣別」

在 PipelineConfig 新增可選欄位（暫名 `fxSourceCurrency`，3 碼幣別，nullable），語意為「**此 scope 的文件，當抽取結果無法判定來源幣別時，視為此幣別**」。

- 例：Fairate（公司 × 格式）的 `fxSourceCurrency = 'THB'`、`fxTargetCurrency = 'HKD'`。
- 與既有 `fxSourceCurrencies`（CHANGE-071，**過濾清單**：只換這些來源幣別）**語意不同**：
  - `fxSourceCurrencies` = 「只在來源幣別屬於清單時才換」（過濾）。
  - `fxSourceCurrency` = 「抽不到來源幣別時，假定為此」（補值）。
  - 兩者可並存：補值後仍套用過濾（補的幣別自然在清單內即通過）。

### 變更項目 2：換算器來源幣別解析加 fallback

`ExchangeRateConverterService.convert()` 解析來源幣別改為：

```
sourceCurrency = stage3Result.standardFields.currency?.value
                 ?? config.fxSourceCurrency        // ← 新 fallback
```

- 仍維持「來源 == 目標 → 不換」「無匯率 → 依 fallbackBehavior」等既有行為。

### 變更項目 3（待用戶決策）：fallback-only vs 強制覆蓋

| 選項 | 語意 | 取捨 |
|------|------|------|
| **A（推薦）fallback-only** | 僅當抽取**無**來源幣別時才用 `fxSourceCurrency` | 安全，不覆蓋正確抽取值；對 Fairate 純費用欄位場景即足夠 |
| B 強制覆蓋 | 一律以 `fxSourceCurrency` 為來源，忽略抽取值 | 適合「格式幣別 100% 固定」但會蓋掉文件真實幣別，誤設風險高 |

> 規劃預設採 **A**。若用戶要 B，可加一個 `fxForceSourceCurrency: boolean` 開關，預設 false。

---

## 技術設計

### 修改範圍

| 檔案 | 變更內容 |
|------|----------|
| `prisma/schema.prisma` | `PipelineConfig` 加 `fxSourceCurrency String? @map("fx_source_currency")`（nullable，向後相容；H1：純加 nullable 欄位）|
| `src/lib/validations/pipeline-config.schema.ts` | create/update 加 `fxSourceCurrency: z.string().length(3).toUpperCase().nullable().optional()` |
| `src/services/pipeline-config.service.ts` | `DEFAULT_EFFECTIVE_CONFIG` 加 `fxSourceCurrency: null`；create/update interface + 四層 merge 帶上此欄位 |
| `src/types/extraction-v3.types.ts` | `EffectivePipelineConfig` 加 `fxSourceCurrency: string | null` |
| `src/services/extraction-v3/stages/exchange-rate-converter.service.ts` | 來源幣別解析加 `?? config.fxSourceCurrency` fallback |
| `src/components/features/pipeline-config/PipelineConfigForm.tsx` | FX 區塊加「來源幣別（fallback）」選擇器（`COMMON_CURRENCIES`）|
| `src/hooks/use-pipeline-configs.ts` | interface 加 `fxSourceCurrency` |
| `messages/{en,zh-TW,zh-CN}/pipelineConfig.json` | `form.fxSourceCurrency` + `form.fxSourceCurrencyDescription` 三語 |

### 資料庫影響

- 純加 1 個 nullable 欄位 → 向後相容、零資料遷移風險。
- 本專案 dev DB 用 `npx prisma db push`（migrations 為舊 baseline）；schema 變更後**重啟 dev server**（node 快取 @prisma/client）。

### i18n 影響

| 語言 | 檔案 | Key |
|------|------|-----|
| en / zh-TW / zh-CN | `messages/{locale}/pipelineConfig.json` | `form.fxSourceCurrency`、`form.fxSourceCurrencyDescription` |

---

## 設計決策

1. **新欄位 `fxSourceCurrency`（補值）與既有 `fxSourceCurrencies`（過濾）分離** — 語意不同，不重用避免混淆。
2. **fallback-only（選項 A）為預設** — 不覆蓋正確抽取的幣別。
3. **不改 FieldDefinitionSet** — 來源幣別屬「管線設定」職責，不屬欄位定義。

---

## 影響範圍評估

### 向後兼容性
- 既有設定 `fxSourceCurrency = null` → 行為完全不變（仍只靠抽取值）。
- 不影響已處理文件。

### H1 註記（Strict Mode）
本變更**改 PipelineConfig 結構 + 換算器來源幣別解析邏輯**，屬 H1 Architectural Change（純加 nullable 欄位 + 解析 fallback）。**規劃階段不動 code，實作前需用戶 approve**，並於本文件記錄批准日期。

---

## 驗收標準

| # | 驗收項目 | 驗收標準 | 優先級 |
|---|----------|----------|--------|
| 1 | 設定指定來源幣別 | PipelineConfig 可設 `fxSourceCurrency`（如 THB）| High |
| 2 | 無幣別欄位文件可換 | Fairate 類（純 currency 動態欄位、無幣別代碼）文件 → 依設定 THB→HKD 換算成功 | High |
| 3 | 不覆蓋正確抽取值 | 文件已抽到幣別時，忽略 `fxSourceCurrency`（選項 A） | High |
| 4 | 過濾並存 | `fxSourceCurrencies` 過濾仍生效 | Medium |
| 5 | 向後相容 | 未設 `fxSourceCurrency` → 行為不變 | High |
| 6 | 品質閘 | type-check / lint / i18n:check 通過 | High |

---

## 測試場景

| # | 場景 | 步驟 | 預期 |
|---|------|------|------|
| 1 | THB fallback 換算 | 對某公司×格式設 `fxSourceCurrency=THB`、`fxTargetCurrency=HKD`、補 THB→HKD 匯率 → 上傳該格式純費用欄位文件 | 動態 currency 欄位由 THB 換成 HKD，原值入 `fxConversionResult` |
| 2 | 不覆蓋抽取值 | 文件已抽到 USD，設定 `fxSourceCurrency=THB` | 以 USD 為來源（非 THB） |
| 3 | 未設定 | `fxSourceCurrency=null`、文件無幣別 | 略過（與現狀一致） |

---

## 前置資料需求（與 CHANGE-072 E2E 同源）

- 對應幣別對的匯率須存在且 `effective_year` 對應發票年份（FIX-037 後 `convert()` 依發票年份查匯率）。例：THB→HKD 須先於 exchange-rate 模組建立對應年份匯率。

---

*文件建立日期: 2026-06-01*
*最後更新: 2026-06-01*
*狀態: ⏳ 待實作（僅規劃；H1 觸發，實作前需用戶批准）*
