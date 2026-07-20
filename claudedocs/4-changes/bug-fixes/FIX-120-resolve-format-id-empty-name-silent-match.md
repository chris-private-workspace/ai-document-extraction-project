# FIX-120: `resolveFormatId` 在 GPT 未匹配時靜默回傳任意格式

> **日期**: 2026-07-20
> **狀態**: ✅ 已修復（含迴歸測試；type-check 通過）
> **嚴重度**: Sev2（資料正確性 — 未匹配被偽裝成匹配成功，且下游無從察覺）
> **類型**: Bug Fix（查詢條件恆真）
> **影響範圍**: `stage-2-format.service.ts` 的 `resolveFormatId`（所有公司、所有文件）

---

## 問題描述

當 GPT 在 Stage 2 判斷不出格式而回傳 `"formatName": null` 時，系統**不會**如預期地標記為新格式，而是**靜默回傳該公司的任意一個既有格式**，並標記 `isNewFormat: false` —— 在下游看起來與「成功匹配」完全無法區分。

### 實際觀測（2026-07-20）

文件 `CEVA_RCIM250004_05808 1.pdf` 的 Stage 2 GPT 回應：

```json
{
  "formatName": null,
  "confidence": 18,
  "matchedKnownFormat": null
}
```

GPT 明確表示什麼都沒匹配到（信心度 18）。但 `extraction_results.stage_2_result` 記錄為：

```json
{
  "formatId": "cmqur1q73000vpkxgx48c54jo",
  "isNewFormat": false,
  "confidence": 18
}
```

## 根因

兩段程式碼串起來造成條件恆真：

**第一段** —— `extractFormatFromParsed`（`stage-2-format.service.ts:458`）把 null 轉成空字串：

```typescript
formatName: String(obj.formatName || ''),   // null → ''
```

**第二段** —— `resolveFormatId` 的模糊比對未檢查是否為空即送出查詢：

```typescript
if (companyId) {
  const fuzzyMatch = await this.prisma.documentFormat.findFirst({
    where: {
      name: { contains: parsed.formatName, mode: 'insensitive' },  // contains: ''
      companyId,
    },
  })
```

**`contains: ''` 對每一筆記錄都成立** —— 空字串被包含在所有字串中。條件退化為「撈該公司任一格式」，`findFirst` 在無 `orderBy` 的情況下回傳資料庫恰好先給的那筆。

> 注意：不是 Prisma 忽略了 `undefined` 過濾條件，而是條件本身為真。因此加 `?? undefined` 之類的處理無效，必須顯式跳過該查詢。

## 影響

1. **未匹配被偽裝成匹配成功** —— `isNewFormat: false` 使下游（信心度 `FORMAT_MATCHING` 維度、Stage 3 的 FORMAT scope 配置載入）誤以為格式已確認
2. **套用錯誤的 FORMAT scope 配置** —— 該公司若有多個格式，可能載入不相干格式的 prompt 與欄位定義集
3. **掩蓋 GPT 的失敗** —— 低信心度的「沒判出來」在資料上看起來像正常匹配，難以從統計中察覺

> 此缺陷長期存在但不易顯現：在「每間公司只有一個格式」的狀態下（[FIX-115](FIX-115-stage2-prompt-missing-knownformats-variable.md) 修復前的普遍情況），任意回傳的那一筆剛好就是唯一正確的那筆，結果看起來永遠正確。公司開始有多個格式後才會錯。

## 修正內容

`src/services/extraction-v3/stages/stage-2-format.service.ts` 的 `resolveFormatId`：

| # | 變更 | 說明 |
|---|------|------|
| 1 | 模糊比對前先 `trim()` 並檢查非空 | 空字串／純空白時完全跳過該查詢，讓流程往下走到 JIT 建立或回傳 `isNewFormat: true` |
| 2 | 精確比對與模糊比對皆加 `orderBy: { createdAt: 'asc' }` | `DocumentFormat` 的唯一鍵是 `(companyId, documentType, documentSubtype)`，**name 並非唯一**，同公司可能有同名格式；無排序時 `findFirst` 選擇不具決定性（比照 CHANGE-103 Phase 2a 對 `resolveCompanyId` 的處理） |

## 驗收

| # | 項目 | 標準 | 狀態 |
|---|------|------|------|
| 1 | 空 formatName 不觸發查詢 | 迴歸測試 | ✅ |
| 2 | 純空白 formatName 不觸發查詢 | 迴歸測試 | ✅ |
| 3 | DB 有格式時空 formatName 仍不回傳 formatId | 迴歸測試 | ✅ |
| 4 | 正常 formatName 的模糊比對行為不變 | 迴歸測試 | ✅ |
| 5 | 精確比對優先且帶排序 | 迴歸測試 | ✅ |
| 6 | 測試對舊程式碼確實失敗 | 還原修正後 6 項中 5 項失敗 | ✅ |
| 7 | 型別檢查 | `npm run type-check` | ✅ |

測試檔：`tests/unit/services/stage-2-format-resolve-format-id.test.ts`（6 案例）

### 迴歸偵測驗證

新增測試後，先以 `git stash` 還原修正再跑一次，確認 **6 項中 5 項失敗**；套回修正後 6 項全過。未經此驗證的迴歸測試不具意義。

## 已知的既有測試失敗（與本 FIX 無關）

`npm run test` 目前有 4 項失敗，全在 `tests/unit/services/gpt-caller-gateway-routing.test.ts`（Epic 23 LLM gateway）。該檔 import 的是 `gpt-caller.service` / `feature-flags` / `services/llm`，與本次修改的檔案無交集。

> ⚠️ 附帶發現：CI 的 9 項檢查（type-check / lint / i18n-sync / docs-check / npm-audit / pip-audit / gitleaks / semgrep ×2）**不含單元測試**，因此測試失敗不會擋下 PR。是否將 `npm run test` 納入 CI 值得另行評估。

## 關聯

- [FIX-115](FIX-115-stage2-prompt-missing-knownformats-variable.md) —— 修復後公司才開始真正擁有多個格式，本缺陷的實際影響隨之浮現
- [FIX-119](FIX-119-stage2-overfit-identification-keywords.md) —— 本缺陷是在該次失敗實驗的診斷過程中發現
- CHANGE-103 Phase 2a —— `resolveCompanyId` 加 `orderBy` 解決同類非決定性問題的先例
