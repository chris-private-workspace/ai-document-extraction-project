# FIX-115: Stage 2 GLOBAL prompt 未引用 `${knownFormats}`，導致格式匹配全面失效

> **日期**: 2026-07-20
> **狀態**: ✅ 已實作並端到端驗證（2026-07-20，本地）。✅ Azure DEV 已套用（2026-07-20，`VERIFY_PASS`）
> **嚴重度**: Sev2（功能失效 — 所有公司的多格式辨識在 V3.1 下不可用）
> **類型**: Bug Fix（Prompt 配置缺變數）
> **影響範圍**: 所有走 V3.1 Stage 2 的文件（全公司）

---

## 問題描述

Stage 2（格式識別）的 GPT prompt 宣稱「如果提供了已知格式列表，優先嘗試匹配已知格式」，但**清單從未被注入**。GPT 在毫無已知格式資訊的情況下憑空生成格式名稱，導致：

1. `matchedKnownFormat` 幾乎恆為 `null`
2. `resolveFormatId` 的精確比對與模糊比對雙雙落空
3. 一律落入 JIT 建立分支 → 撞唯一鍵 `(companyId, INVOICE, GENERAL)` → **沿用該公司既有的唯一格式**
4. 結果：`isNewFormat` 恆為 `true`，且**同一公司的不同版面全部被歸到同一個格式**

`DocumentFormat.identificationRules.keywords` 因此完全不會進入 GPT —— 使用者把辨識特徵寫得再精確也無效。

## 根因分析

Stage 2 的 prompt 有兩條路徑（`stage-2-format.service.ts:152-167`）：

| 路徑 | 條件 | 是否注入格式清單 |
|------|------|-----------------|
| 自訂 `PromptConfig` + 變數替換 | 找得到 Stage 2 PromptConfig | 只有 prompt 寫了 `${knownFormats}` 才會 |
| 硬編碼 `buildFormatIdentificationPrompt()` | 找不到任何 PromptConfig | ✅ 一定會（`:329-336`） |

seed 會建立一個 **GLOBAL scope 的 Stage 2 PromptConfig**，所以硬編碼路徑**永遠不會被執行**。而該 GLOBAL prompt **一個變數都沒用**。

變數基礎設施本身是完整的 —— `buildVariableContextForConfig`（`:234-244`）確實把 `knownFormats` 組好傳進去，內容為各格式的 `name` + `identificationRules.keywords`（`variable-replacer.ts:400-421`）。**只差 prompt 沒有引用。**

實測全系統 5 筆 Stage 2 PromptConfig（1 GLOBAL + 4 TEST COMPANY override），**沒有任何一筆使用 `${knownFormats}`**。

### 修復面（實際為 2 處）

> ⚠️ 本節於 2026-07-20 實作時修正。原先列的 4 處中有 2 處經查證**不是**修復面，詳見下方「排除」說明。

| # | 位置 | 說明 | 狀態 |
|---|------|------|------|
| 1 | `prisma/seed-data/prompt-configs.ts` | seed 主來源；只對**全新環境**生效 | ✅ |
| 2 | 既有 DB 記錄 → `prisma/update-stage2-prompt.js` | seed 對既有記錄**只更新 name/description、不覆寫 prompt 內容**（`seed.ts:953-963`，註明「user may have customized」），故必須另寫腳本 | ✅ 本地已套用 |

#### 排除項 A：`prisma/seed-data/reference/prompt-configs.json`

**不是 seed 主來源的副本，而是另一套設計。** 三個階段的 prompt 全為英文、基於 OCR 文字，Stage 2 輸出 `{formatId, category}`（TABLE / FORM / MIXED 分類），與 `parseFormatResult` 期待的 `{formatName, matchedKnownFormat, ...}` **形狀不符**。

它僅供 `prisma/seed-prod-reference.ts` 使用（CHANGE-055 Phase 2，2026-04-27，需 `--confirm` 或 `PRISMA_SEED_PROD_ALLOW=true`，永不自動執行）。

> 🔴 **獨立問題**：該檔自 2026-04-27 起未與 FIX-049 之後的 seed 主來源同步。若真的執行 prod reference seed，三個階段都會裝上與現行管線不相容的 prompt。建議另立 FIX 評估整檔。本 FIX 不處理。

#### 排除項 B：`src/services/static-prompts.ts`

**不在 V3.1 Stage 2 路徑上。** 它由 `hybrid-prompt-provider.service.ts` 消費，服務的是 legacy `gpt-vision.service.ts` 路徑；且其 `interpolatePrompt` 使用 `{{varName}}` 語法（`static-prompts.ts:378`），與 Stage 2 的 `${varName}`（`variable-replacer.ts:152-153`）不同，也不提供 `knownFormats` 變數 —— 複製過去只會把佔位符原樣送進 prompt。

seed 檔原本註明「與 static-prompts.ts 一致」，已於本次更新該註解說明 Stage 2 為刻意例外。

## 實證（CEVA 雙版面，2026-07-20）

CEVA 有兩種版面明顯不同的發票，但長期被判為同一格式。建立第 2 個 `DocumentFormat` 並填妥 `identificationRules` 後，**單靠格式設定無效**；額外建立一個帶 `${knownFormats}` 的 COMPANY scope Stage 2 PromptConfig 後才生效。

| 文件 | 版面 | 修復前 | 修復後 |
|------|------|--------|--------|
| `CEVA_RCIM250325_17865 1.PDF` | 表格式（QR code + 分欄費率表） | 格式 A，`isNewFormat: true`，信心度 93 | **格式 B**，`isNewFormat: false`，信心度 **98** |
| `CEVA_RCIM250004_05808 1.pdf` | 深藍橫幅式 | 格式 A，`isNewFormat: true`，信心度 86 | 格式 A（不變），`isNewFormat: **false**`，信心度 86 |

> 注意文件 A 修復前雖然「答案正確」，但 `isNewFormat: true` 顯示它是 JIT 撞回既有格式而非真正匹配 —— 在只有一個格式時會碰巧正確，一旦公司有多個格式就會失準。

修復後 GPT 的判斷依據明確引用了各格式的專屬特徵，並做出排他性判斷，例如文件 A 的回應：

> 「未見左上角 QR code；也未見清單第二種格式要求的『F + 9 位數字』發票編號格式」

## 建議修正內容

Stage 2 的 system prompt 需包含：

1. `${knownFormats}` 佔位符（渲染為 `- <格式名稱>: <keywords 逗號串接>` 的多行清單）
2. 明確要求**逐字複製**清單中的格式名稱 —— 因 `resolveFormatId:478-494` 是拿 `matchedKnownFormat` 與 DB `name` 做**完全相等**比對，任何改寫／翻譯／截短都會導致匹配失敗
3. 排他性判斷指引（某格式的特徵明確不存在即排除）
4. 提示勿依賴公司名稱或 Logo 判斷（同公司不同版面共用 Logo，不具鑑別力）

CEVA 的 COMPANY scope 配置 `cmrso9em60002bsxghuih2rx0` 可作為實作範本（已實證有效）。

## 風險與 blast radius

> ⚠️ 本節於 2026-07-20 實測後**大幅修正**。原先對信心度影響的機制描述是錯的。

修改 GLOBAL prompt 會改變所有公司、所有文件的 Stage 2 行為：

- 既有文件重跑後 `formatId` 可能改變（原本全部歸到單一格式，修復後會正確分流）
- 對只有單一格式的公司，格式歸屬應無實質變化（清單只有一項），但 `isNewFormat` 會由 `true` 轉為 `false`

### 信心度影響（已量化）

**原先的錯誤說法**：`isNewFormat` 觸發 `confidence-v3-1.service.ts:459-463` 的智能降級，把 `AUTO_APPROVE` 降為 `QUICK_REVIEW`，修復後「可能使明顯更多文件自動通過」。

**實測更正**：持久化到 `documents.routing_decision` 的路由**不走** `ConfidenceV3_1Service.applyRoutingStrategy`。系統存在**兩套並存的路由計算**：

| 來源 | 輸出形狀 | 是否持久化 | 是否套用 isNewFormat 硬降級 |
|------|----------|-----------|------------------------|
| `ConfidenceV3_1Service`（extraction-v3 內） | `{decision, score, threshold, reasons}` | ❌ | ✅ |
| 統一處理器 `RoutingDecisionAdapter` | `{decision, confidence}` | ✅ 寫入 `documents.routing_decision` | ❌ |

實際生效的是後者。`isNewFormat` 在其中只影響 `FORMAT_MATCHING` 維度的原始分數（`confidence-calculation.step.ts:264`：`isNewFormat ? 70 : 90`），該維度權重 **15%**（`confidence-calculator-adapter.ts:274`）。

因此修復後綜合分數上升 **(90−70) × 0.15 = +3 分**（0-1 標度為 +0.03）。

**本地實際影響**：82 份文件中，目前為 `QUICK_REVIEW` 的有 12 份，其中分數 ≥ 0.87 的 **5 份**會跨過 0.90 門檻轉為 `AUTO_APPROVE`（約 6%）。其餘文件早已是 `AUTO_APPROVE`——證實硬降級本來就沒有作用於持久化路由。

> 附帶發現：**兩套路由並存**（其中一套的 `reasons` 從未被持久化）本身是值得單獨檢視的架構問題，不在本 FIX 範圍。

## 驗收

| # | 項目 | 標準 | 狀態 |
|---|------|------|------|
| 1 | 修復面全數更新 | seed 主來源 + DB 更新腳本 | ✅ |
| 2 | 腳本與 seed 逐字一致 | 逐行比對（僅行尾 CRLF/LF 差異，內容相同） | ✅ |
| 3 | 本地 GLOBAL prompt 含 `${knownFormats}` | 腳本讀回驗證 `VERIFY_PASS`；version 2→3 | ✅ |
| 4 | 腳本冪等 | 第二次執行回報 0 筆 | ✅ |
| 5 | 型別檢查 / Lint | `npm run type-check`、`npx eslint` | ✅ |
| 6 | 信心度影響量化 | 見 §風險（+3 分，本地約 5/82 份可能轉 AUTO_APPROVE） | ✅ |
| 7 | 多格式公司分流 | CEVA 兩份文件分別命中 A / B | ✅ 已用 COMPANY 繞法驗證 |
| 8 | **GLOBAL prompt 端到端驗證** | 停用 CEVA COMPANY 繞法後重跑，仍應命中格式 B | ✅ 見下 |
| 9 | 單一格式公司回歸 | 抽樣其他公司文件重跑，formatId 不變 | ⏳ |
| 10 | Azure DEV 套用 | Kudu ad-hoc 執行 `update-stage2-prompt.js` | ✅ 2026-07-20：`version 2 → 4`、`hasKnownFormatsVar false → true`、1 筆更新、`VERIFY_PASS`（見部署記錄） |

## 端到端驗證結果（2026-07-20 05:06，本地）

把 CEVA 的 COMPANY scope 繞法 `cmrso9em60002bsxghuih2rx0` 設為 `isActive = false`，使 Stage 2 只能行使修好的 GLOBAL prompt，重跑文件 `CEVA_RCIM250325_17865 1.PDF`：

```
formatId    : cmrsmg8mb0000bsxgjrqy6ksk   ← 格式 B（表格式版面）
formatName  : CEVA Logistics 表格式 Invoice（QR code + CUR/EX RATE 分欄費率表）
isNewFormat : false                        ← 真正匹配，未落入 JIT
confidence  : 95
```

`stage_2_ai_details.prompt` 讀回確認變數已正確渲染：

```
你是一位專業的文件格式識別專家，專門分析 CEVA LOGISTICS (HONG KONG) LTD 的…   ← ${companyName}
已知格式清單（…）：
- CEVA Logistics 貨運/清關型 Invoice（…）: 標題列文字為 CEVA LOGISTICS HONG KONG OFFICE…   ← ${knownFormats}
- CEVA Logistics 表格式 Invoice（…）: 左上角有 QR code…
```

### 三次重跑的演進（同一份文件）

| 時點 | Stage 2 配置 | 結果 |
|------|------------|------|
| 修復前 | GLOBAL（無變數） | 格式 A ❌、`isNewFormat: true`、93 |
| CEVA 繞法 | COMPANY（含變數） | 格式 B ✅、`isNewFormat: false`、98 |
| **GLOBAL 修復後** | **GLOBAL（含變數）** | **格式 B ✅、`isNewFormat: false`、95** |

### CEVA 繞法的處置

`cmrso9em60002bsxghuih2rx0` 已證實冗餘，目前保留為 `isActive = false`（未刪除，便於回溯）。其 description 描述的問題已由本 FIX 根治，內容已過時；確認 Azure 套用無虞後可刪除。

## 關聯

- [FIX-058](FIX-058-stage2-format-jit-unique-constraint.md) — 當初處理 JIT 撞唯一鍵，是本 bug 的**症狀**而非根因；本 FIX 修好後 JIT 觸發率應大幅下降
- [FIX-049] — 先前重寫過此 Stage 2 prompt（原本誤用欄位提取 prompt），但未加入變數
- [FIX-114](FIX-114-document-format-id-uuid-validation-blocks-format-scope.md) — 同批 UAT 發現，解除 FORMAT scope 配置無法建立的阻塞
- 操作指南：[company-multi-format-setup-guide.md](../../reference/company-multi-format-setup-guide.md)（已加入「步驟 0」說明此前提）

## 已套用的臨時繞法

CEVA 專屬 COMPANY scope Stage 2 PromptConfig `cmrso9em60002bsxghuih2rx0`（本地 DB）。全域修復完成後應評估是否移除，避免重複維護。
