# FIX-115: Stage 2 GLOBAL prompt 未引用 `${knownFormats}`，導致格式匹配全面失效

> **日期**: 2026-07-20
> **狀態**: 🔬 根因已確認並實證，待批准實作（CEVA 已套用公司級繞法）
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

### 修復面（4 處，缺一不可）

| # | 位置 | 說明 |
|---|------|------|
| 1 | `prisma/seed-data/prompt-configs.ts:100-124` | seed 主來源；不改則新環境重新帶回壞版本 |
| 2 | `prisma/seed-data/reference/prompt-configs.json` | reference seed 副本 |
| 3 | `src/services/static-prompts.ts:92` | 靜態備援版本（註解要求與 seed 保持一致） |
| 4 | 既有 DB 資料（本地 + Azure DEV） | seed 為冪等 upsert 或需另寫 gated 更新腳本，須確認 |

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

🔴 **修改 GLOBAL prompt 會改變所有公司、所有文件的 Stage 2 行為。** UAT 期間需評估：

- 既有文件重跑後 `formatId` 可能改變（原本全部歸到單一格式，修復後會正確分流）
- 對只有單一格式的公司，行為應無實質變化（清單只有一項），但 `isNewFormat` 會由 `true` 轉為 `false`
- `isNewFormat` 影響信心度路由的智能降級（`confidence-v3-1.service.ts:459-463`：新格式會把 `AUTO_APPROVE` 降為 `QUICK_REVIEW`）—— 修復後降級觸發率會下降，**可能使更多文件自動通過**，這點需特別評估

## 驗收

| # | 項目 | 標準 | 狀態 |
|---|------|------|------|
| 1 | 4 處修復面全數更新 | seed / reference json / static-prompts / DB | ⏳ |
| 2 | GLOBAL prompt 含 `${knownFormats}` | grep 驗證 | ⏳ |
| 3 | 單一格式公司回歸 | 隨機抽樣文件重跑，formatId 不變 | ⏳ |
| 4 | 多格式公司分流 | CEVA 兩份文件分別命中 A / B | ✅ 已用 COMPANY 繞法驗證 |
| 5 | 信心度路由影響評估 | 統計修復前後 `AUTO_APPROVE` 比例變化 | ⏳ |
| 6 | Azure DEV 同步 | 見 §修復面 #4 | ⏳ |

## 關聯

- [FIX-058](FIX-058-stage2-format-jit-unique-constraint.md) — 當初處理 JIT 撞唯一鍵，是本 bug 的**症狀**而非根因；本 FIX 修好後 JIT 觸發率應大幅下降
- [FIX-049] — 先前重寫過此 Stage 2 prompt（原本誤用欄位提取 prompt），但未加入變數
- [FIX-114](FIX-114-document-format-id-uuid-validation-blocks-format-scope.md) — 同批 UAT 發現，解除 FORMAT scope 配置無法建立的阻塞
- 操作指南：[company-multi-format-setup-guide.md](../../reference/company-multi-format-setup-guide.md)（已加入「步驟 0」說明此前提）

## 已套用的臨時繞法

CEVA 專屬 COMPANY scope Stage 2 PromptConfig `cmrso9em60002bsxghuih2rx0`（本地 DB）。全域修復完成後應評估是否移除，避免重複維護。
