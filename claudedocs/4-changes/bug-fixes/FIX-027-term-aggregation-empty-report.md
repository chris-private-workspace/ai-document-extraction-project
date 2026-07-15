# FIX-027: 術語聚合報告導出為空

> **狀態**: ✅ 已修復

## 問題描述

**發現日期**: 2026-01-15
**影響範圍**: 歷史數據管理頁面的術語報告導出功能
**嚴重程度**: 高

### 症狀
在 `/admin/historical-data` 頁面點擊「匯出術語」按鈕後，下載的 Excel 報告顯示：
- 公司數量: 0
- 格式數量: 0
- 術語數量: 0

## 根本原因分析

### 問題 1: documentIssuerId 為 NULL

所有已處理完成（COMPLETED）的文件，其 `documentIssuerId` 和 `documentFormatId` 都是 NULL。

原始查詢邏輯只處理有 `documentIssuerId` 的文件：
```typescript
// 第一層: 有 documentIssuerId 的文件
// 第二層: 無 documentIssuerId 但有 documentFormatId 的文件
// ❌ 缺少: 無 documentIssuerId 且無 documentFormatId 的文件
```

### 問題 2: extractionResult 路徑不匹配

原始代碼只檢查以下路徑：
```typescript
result.lineItems ??
result.items ??
result.invoiceData?.lineItems ??
result.extractedData?.lineItems
```

實際資料結構：
```json
{
  "gptExtraction": {
    "invoiceData": {
      "lineItems": [
        { "description": "BASE RATE HKD 620.00" },
        ...
      ]
    }
  }
}
```

## 修復內容

### 修改文件
`src/services/hierarchical-term-aggregation.service.ts`

### 修復 1: 擴展 ExtractionResultJson 介面
```typescript
interface ExtractionResultJson {
  // ... existing fields ...
  gptExtraction?: {
    invoiceData?: { lineItems?: Array<{ description?: string | null }> };
  };
}
```

### 修復 2: 新增 gptExtraction 路徑支援
```typescript
const items =
  result.lineItems ??
  result.items ??
  result.invoiceData?.lineItems ??
  result.extractedData?.lineItems ??
  result.gptExtraction?.invoiceData?.lineItems ??  // 新增
  [];
```

### 修復 3: 新增第三層 Fallback（未識別公司）
```typescript
const UNIDENTIFIED_COMPANY_ID = 'unidentified-company';
const UNIDENTIFIED_COMPANY_NAME = '未識別公司';

// 第三層: 沒有 documentIssuerId 且沒有 documentFormatId 的文件
// 使用「未識別公司」作為佔位符
```

## 驗證結果

修復後導出的 Excel 報告：
- **摘要**: 批次資訊正確顯示
- **公司列表**: 1 個公司（未識別公司），14 個術語
- **格式列表**: 1 個格式（Default Format）
- **術語列表**: 14 個術語

範例術語：
- BASE RATE HKD 620.00
- BASE RATE HKD 400.00
- BASE RATE USD 25.00
- HANDLING CHARGES

## 相關文件

- 修改文件: `src/services/hierarchical-term-aggregation.service.ts`
- 導出 API: `src/app/api/v1/batches/[batchId]/hierarchical-terms/export/route.ts`
- 導出組件: `src/components/features/historical-data/HierarchicalTermsExportButton.tsx`

## 後續建議

1. **改善文件處理流程**: 確保處理完成的文件正確設置 `documentIssuerId`
2. **資料品質監控**: 新增監控確保 extractionResult 結構一致
3. **測試覆蓋**: 新增單元測試覆蓋各種 extractionResult 路徑

---

**修復者**: Claude AI
**修復日期**: 2026-01-15
**驗證狀態**: ✅ 已驗證
