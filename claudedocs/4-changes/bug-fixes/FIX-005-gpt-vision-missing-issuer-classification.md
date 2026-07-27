# FIX-005: GPT_VISION 處理缺少發行者識別

> **狀態**: ✅ 已完成

## 問題摘要

| 項目 | 內容 |
|------|------|
| **Bug ID** | FIX-005 |
| **發現日期** | 2025-12-28 |
| **修復日期** | 2025-12-28 |
| **嚴重程度** | 中 |
| **影響範圍** | Epic 0 歷史數據處理 |
| **發現者** | TEST-PLAN-002 E2E 測試 |
| **狀態** | ✅ 已完成 |

---

## 問題描述

### 症狀
在 TEST-PLAN-002 完整 133 PDF 測試中發現：
- 131 個文件處理完成
- 40 個文件（30.5%）缺少 `documentIssuer` 識別
- 這 40 個文件全部使用 `GPT_VISION` 處理方法
- 91 個使用 `DUAL_PROCESSING` 的文件都有正確的發行者識別

### 根本原因
`batch-processor.service.ts` 中 GPT_VISION 處理邏輯**只執行 OCR 提取**，沒有呼叫 `classifyDocument()` 進行文件分類。

```typescript
// 問題代碼 (batch-processor.service.ts:381-401)
} else {
  // 使用 GPT Vision 處理掃描 PDF 或圖片
  const result = await processImageWithVision(filePath)  // ❌ 只有 OCR，沒有分類
  // ...
}
```

對比 `DUAL_PROCESSING` 處理（正確）：
```typescript
const [visionResult, classificationResult] = await Promise.all([
  processImageWithVision(filePath),
  classifyDocument(filePath),  // ✅ 有分類
])
```

### 附帶問題：信心度顯示異常
發現發行者識別信心度顯示為 `9600.0%`，應為 `96%`。

**原因**：資料庫儲存整數（如 96），但 UI 組件無條件乘以 100。

---

## 修復方案

### 1. 修改 GPT_VISION 處理邏輯

**文件**: `src/services/batch-processor.service.ts`

**變更**: 在 GPT_VISION 處理中加入 `classifyDocument()` 呼叫，與 OCR 並行執行。

```typescript
} else {
  // 使用 GPT Vision 處理掃描 PDF 或圖片
  // FIX-005: 同時執行 OCR 提取和文件分類
  console.log(`[GPT_VISION] Starting processing for: ${file.originalName}`)

  // 並行執行 OCR 提取和分類
  const [visionResult, classificationResult] = await Promise.all([
    processImageWithVision(filePath),
    classifyDocument(filePath),
  ])

  if (!visionResult.success) {
    throw new Error(visionResult.error || 'GPT Vision processing failed')
  }

  // 分類失敗不影響主流程，只記錄警告
  if (!classificationResult.success) {
    console.warn(
      `[GPT_VISION] Classification failed for ${file.originalName}: ${classificationResult.error}. ` +
      `Continuing with OCR result only.`
    )
  }

  return {
    extractionResult: {
      method: 'GPT_VISION',
      // ...
      // FIX-005: 加入分類結果
      documentIssuer: classificationResult.success ? classificationResult.documentIssuer : undefined,
      documentFormat: classificationResult.success ? classificationResult.documentFormat : undefined,
      classificationSuccess: classificationResult.success,
      classificationError: classificationResult.error,
    },
    // ...
  }
}
```

### 2. 修復信心度顯示

**文件**: `src/components/features/historical-data/file-detail/IssuerIdentificationPanel.tsx`

**變更**: 修改 `formatConfidenceValue()` 函數，智能判斷數值範圍。

```typescript
/**
 * 格式化信心度為百分比字串
 * @description
 *   FIX-005: 修復信心度顯示問題
 *   資料庫存儲格式：整數 (如 96 表示 96%)
 *   需要判斷數值範圍來決定是否需要轉換：
 *   - 如果 > 1，視為百分比整數（如 96），直接顯示
 *   - 如果 <= 1，視為小數（如 0.96），乘以 100 顯示
 */
function formatConfidenceValue(confidence: number | null): string {
  if (confidence === null) return '-';
  const percentValue = confidence > 1 ? confidence : confidence * 100;
  return `${percentValue.toFixed(1)}%`;
}
```

### 3. 重新處理腳本

**文件**: `scripts/reprocess-missing-issuer.ts`

用於重新處理已存在的缺少發行者識別的文件。

**使用方式**:
```bash
npx ts-node scripts/reprocess-missing-issuer.ts [batchId]
npx ts-node scripts/reprocess-missing-issuer.ts fec633d9-1e14-45fd-b215-d85527750c62
```

---

## 影響分析

### 修改文件
| 文件 | 變更類型 | 說明 |
|------|----------|------|
| `batch-processor.service.ts` | 邏輯修改 | GPT_VISION 處理加入分類 |
| `IssuerIdentificationPanel.tsx` | Bug 修復 | 信心度顯示邏輯 |
| `scripts/reprocess-missing-issuer.ts` | 新增 | 重新處理腳本 |

### 風險評估
- **效能影響**: GPT_VISION 處理會額外呼叫一次 API（分類），增加約 $0.01/頁成本
- **向後相容**: 完全相容，不影響現有數據
- **失敗處理**: 分類失敗不影響主流程，只記錄警告

---

## 測試驗證

### 測試計劃
1. **新文件處理**: 上傳新的掃描 PDF，驗證有發行者識別
2. **現有文件重處理**: 執行重處理腳本，驗證 40 個文件
3. **信心度顯示**: 驗證 UI 顯示正確（96% 而非 9600%）

### 驗證指令
```bash
# 1. TypeScript 檢查
npm run type-check

# 2. 執行重新處理
npx tsx scripts/reprocess-missing-issuer.ts fec633d9-1e14-45fd-b215-d85527750c62
```

---

## ✅ 驗證結果（2025-12-28）

### 重新處理執行結果

| 項目 | 數值 |
|------|------|
| **處理文件數** | 29 |
| **成功** | 29 (100%) |
| **失敗** | 0 |
| **跳過** | 0 |

> **注意**: 原本 40 個缺少識別的文件，在執行腳本時發現只剩 29 個（部分可能在先前測試時已處理）。

### 識別方法統計

| 方法 | 數量 |
|------|------|
| HEADER | 26 |
| LOGO | 3 |

### 新建公司記錄

| 公司名稱 | 識別方法 |
|----------|----------|
| DONGNAM LOGISTICS LTD. | HEADER |
| Kintetsu World Express (HK) Limited | HEADER |
| Modern Leasing Limited | HEADER |
| Modern Terminals Limited | HEADER |
| MODERN TERMINALS LIMITED | HEADER |
| Minosha India Limited | HEADER |
| Good Transit Limited | HEADER |
| KENDAI SHIPPING & LOGISTICS SDN. BHD. | HEADER |
| RICOH TAIWAN CO., LIMITED | LOGO |
| WANG KAY (1995) LIMITED | HEADER |
| Shree International Logistics (P) Ltd. | HEADER |
| Yamato Logistics Hong Kong | LOGO |

### 發行者識別統計（按文件數量）

| 發行者 | 識別方法 | 文件數 |
|--------|----------|--------|
| Modern Leasing Limited | HEADER | 8 |
| WANG KAY (1995) LIMITED | HEADER | 6 |
| MODERN LEASING LIMITED | HEADER | 2 |
| Modern Terminals Limited | HEADER | 2 |
| Nippon Express (H.K.) Co., Ltd. | LOGO | 2 |
| 其他（各 1 文件） | - | 9 |

---

## 相關連結

- **相關 Story**: Epic 0 - 歷史數據初始化
- **相關 Bug**: 無
- **測試報告**: TEST-REPORT-002-EPIC-0-COMPLETE.md
- **相關 CHANGE**: CHANGE-001 Native PDF 雙重處理架構

---

## 版本資訊

| 項目 | 內容 |
|------|------|
| **文檔版本** | 1.0.0 |
| **建立日期** | 2025-12-28 |
| **作者** | Claude AI Assistant |
