# FIX-118: Prod reference seed 會用陳舊副本覆寫三階段 GLOBAL prompt

> **日期**: 2026-07-20
> **狀態**: ✅ 已修復（dry-run 驗證通過；type-check 通過）
> **嚴重度**: Sev2（潛在功能全毀 — 執行後 Stage 1/2/3 提取皆失效；但需手動觸發）
> **類型**: Bug Fix（資料副本漂移 → 改為單一真相來源）
> **影響範圍**: `prisma/seed-prod-reference.ts`、`prisma/seed-data/reference/prompt-configs.json`（已刪除）

---

## 問題描述

`prisma/seed-data/reference/prompt-configs.json` 自 2026-04-27 建立後，**從未與 seed 主來源 `prisma/seed-data/prompt-configs.ts` 同步**。兩者不是副本關係，而是**兩套不同設計**：

| | seed 主來源（現行管線使用） | reference JSON（陳舊） |
|---|---|---|
| 語言 | 中文 | 英文 |
| 輸入假設 | 文件圖片（GPT Vision） | OCR 文字 |
| Stage 2 輸出 | `{formatName, confidence, matchedKnownFormat, formatCharacteristics}` | `{formatId, category}`（TABLE / FORM / MIXED） |
| Stage 3 輸出 | `{fields, lineItems, overallConfidence}` | `[{fieldName, value, confidence}]` + `{{ocrText}}` 變數 |
| 變數語法 | `${var}` | `{{var}}` |

而 `seedPromptConfigs()`（`seed-prod-reference.ts:452-463`）對既有 GLOBAL prompt 是**直接覆寫** `systemPrompt` / `userPromptTemplate` —— 不像 dev seed 會刻意保留使用者自訂內容。

**後果**：任何人執行 `seed-prod-reference.ts`，三個階段的 GLOBAL prompt 會同時被換成與 `parseFormatResult` / Stage 3 解析器不相容的版本，提取管線全面失效。且會直接抹掉 [FIX-115](FIX-115-stage2-prompt-missing-knownformats-variable.md) 剛修好的 `${knownFormats}` 注入。

## 既有的部分記錄

[FIX-095](FIX-095-stage3-prompt-format-conflict-confidence-nondeterminism.md) 已針對 **STAGE_3** 記錄過此風險：

> 🔴 警告：勿在 Azure 跑 `seed-prod-reference.ts`——其 `prompt-configs.json` 的 STAGE_3 是另一套不相干的英文 `fields` 陣列格式，會覆蓋現用 prompt 並引發更嚴重問題

當時以「警告」處理、未根治，且未涵蓋 Stage 1 / Stage 2 同樣有問題。本 FIX 根治。

## 觸發條件（為何至今未爆）

`seed-prod-reference.ts` **永不自動執行**：
- 需 `--confirm` flag 或 `PRISMA_SEED_PROD_ALLOW=true`
- 容器 entrypoint 跑的是 `bootstrap-db.js` + `seed-prod-essential.js`，**不含** reference seed
- `seed-prod-essential.ts` 不處理 prompt

所以風險只存在於「首次上線時手動執行」這個情境 —— 但那正是它被設計來用的時機。

## 修正內容

**改為單一真相來源**：`seed-prod-reference.ts` 直接讀 `seed-data/prompt-configs.ts` 的 `PROMPT_CONFIG_SEEDS`，刪除 reference JSON 副本。漂移在結構上不再可能發生。

| # | 變更 | 說明 |
|---|------|------|
| 1 | 新增 `loadPromptConfigsFromSeedSource()` | 從 `PROMPT_CONFIG_SEEDS` 篩選 prod 需要的類型，仍套用既有的 `validatePromptConfigs` 作防呆 |
| 2 | 移除 `PROMPTS_FILE` 常量與其存在性檢查 | Check 3 由檢查 4 份 JSON 改為 3 份 |
| 3 | 刪除 `prisma/seed-data/reference/prompt-configs.json` | 9.5 KB 陳舊副本 |
| 4 | 更新檔案頂部說明 | 標明 prompt 為 reference JSON 的例外 |

### 為何只取 3 個 STAGE 類型

`PROMPT_CONFIG_SEEDS` 有 5 筆，但 `PROD_PROMPT_TYPES` 只取 3 個 V3.1 階段，與原 JSON 涵蓋範圍一致。

🔴 **刻意不含 `FIELD_EXTRACTION`**：[FIX-111](FIX-111-stage3-global-prompt-selection-nondeterminism-hkd-bypass.md) 才剛停用該型的 active GLOBAL prompt（與 `STAGE_3_FIELD_EXTRACTION` 併存會造成 Stage 3 prompt 選擇非確定性）。若一併帶入會重新引入該已修復的問題。

`TERM_CLASSIFICATION` 同樣不含，維持與修正前一致，不擴大範圍。

## 驗收

| # | 項目 | 標準 | 狀態 |
|---|------|------|------|
| 1 | prompt 改讀單一真相來源 | 無 reference JSON 副本 | ✅ |
| 2 | 無殘留引用 | grep `PROMPTS_FILE` / `reference/prompt-configs` 僅剩說明註解 | ✅ |
| 3 | 型別檢查 | `npm run type-check` | ✅ |
| 4 | Dry-run 可執行 | 載入 3 prompts、0 寫入、無檔案缺失錯誤 | ✅ |
| 5 | 載入的是正確版本 | 名稱為 `V3.1 Stage N - ...`（原 JSON 為 `Stage N - ... (Default)`） | ✅ |
| 6 | 實際執行驗證 | 於乾淨環境跑 `--confirm` 後檢查 prompt 內容 | ⏳ 需真實上線情境 |

Dry-run 輸出節錄：

```
📋 Loading reference data...
  ✅ Loaded: 10 companies / 41 mappings / 3 prompts / 15 rates

💬 Seeding 3 prompt configs...
  [DRY-RUN] Would upsert: STAGE_1_COMPANY_IDENTIFICATION - V3.1 Stage 1 - Company Identification
  [DRY-RUN] Would upsert: STAGE_2_FORMAT_IDENTIFICATION - V3.1 Stage 2 - Format Identification
  [DRY-RUN] Would upsert: STAGE_3_FIELD_EXTRACTION - V3.1 Stage 3 - Field Extraction
```

## 關聯

- [FIX-095](FIX-095-stage3-prompt-format-conflict-confidence-nondeterminism.md) — 曾記錄 STAGE_3 的同一風險但未根治；其「勿在 Azure 跑 seed-prod-reference.ts」的警告至此已解除
- [FIX-115](FIX-115-stage2-prompt-missing-knownformats-variable.md) — 本 FIX 在調查 FIX-115 修復面時發現；若未修，FIX-115 的成果會被 reference seed 抹掉
- [FIX-111](FIX-111-stage3-global-prompt-selection-nondeterminism-hkd-bypass.md) — `FIELD_EXTRACTION` 排除的理由

## 未處理（建議另行評估）

`reference/` 下另外 3 份 JSON（`companies.json` / `tier1-mappings.json` / `exchange-rates.json`）同為 2026-04-27 建立，本次**未查證**其內容是否仍與現況相符。它們是純業務參考資料、不像 prompt 那樣會破壞管線，但上線前仍建議逐份複核。
