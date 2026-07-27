# FIX-031: 歷史數據批次處理進度無法即時顯示

> **狀態**: ✅ 已修復

## 問題描述

**發現日期**: 2026-01-20
**嚴重程度**: Medium
**影響範圍**: 歷史數據管理頁面 (`/admin/historical-data`)

### 症狀

當執行歷史數據批次處理時：
- 資料庫中 `processed_files` 計數器正確遞增（經 SQL 查詢確認）
- 服務器日誌正確顯示處理進度（如 `Progress: 70/132 (53%)`）
- **但前端頁面始終顯示 `Processed: 0` 和進度 `0%`**

### 根本原因

`useHistoricalBatches` hook 缺少自動輪詢機制：

```typescript
// 修復前 - 沒有 refetchInterval
export function useHistoricalBatches(filters: BatchListFilters = {}) {
  return useQuery({
    queryKey: ['historical-batches', filters],
    queryFn: () => fetchBatches(filters),
    staleTime: 30 * 1000, // 只有 staleTime，沒有輪詢
  })
}
```

當批次處於 `PROCESSING` 狀態時，前端不會自動重新獲取數據，導致用戶必須手動刷新頁面才能看到進度更新。

## 修復方案

### 修改文件

`src/hooks/use-historical-data.ts`

### 修復內容

新增動態輪詢功能：
- 當有批次處於 `PROCESSING` 或 `AGGREGATING` 狀態時，每 3 秒自動刷新
- 當所有批次都已完成時，自動停止輪詢
- 提供可配置的輪詢選項

```typescript
// 修復後 - 新增動態 refetchInterval
export function useHistoricalBatches(
  filters: BatchListFilters = {},
  options: { enablePolling?: boolean; pollingInterval?: number } = {}
) {
  const { enablePolling = true, pollingInterval = 3000 } = options

  return useQuery({
    queryKey: ['historical-batches', filters],
    queryFn: () => fetchBatches(filters),
    staleTime: 5 * 1000,
    // 動態輪詢 - 根據當前數據決定是否繼續輪詢
    refetchInterval: enablePolling
      ? (query) => {
          const hasProcessingBatch = query.state.data?.data?.some(
            (batch: HistoricalBatch) =>
              batch.status === 'PROCESSING' || batch.status === 'AGGREGATING'
          )
          return hasProcessingBatch ? pollingInterval : false
        }
      : false,
  })
}
```

## 測試驗證

### 測試步驟

1. 啟動 Next.js 開發服務器
2. 導航到 `/admin/historical-data`
3. 選擇一個 `PENDING` 狀態的批次，點擊「開始處理」
4. 觀察頁面上的進度條和 `Processed` 計數器

### 預期結果

- 進度條每 3 秒更新一次
- `Processed` 計數器即時反映處理進度
- 當處理完成後，輪詢自動停止

### 實際結果

✅ 修復後測試通過：
- 進度從 0% → 76% → 79%... 持續更新
- `Processed` 從 0 → 100 → 104... 即時顯示
- 批次完成後進入 `COMPLETED` 狀態，輪詢停止

## 影響分析

### 正面影響
- 用戶可以即時看到批次處理進度
- 改善用戶體驗，無需手動刷新頁面

### 潛在風險
- 每 3 秒發送一次 API 請求可能增加服務器負載
- 多個用戶同時監控處理進度時需注意

### 緩解措施
- 輪詢間隔可配置（預設 3 秒）
- 只有在有處理中批次時才輪詢
- `staleTime` 設為 5 秒，避免過於頻繁的請求

## 相關資訊

### 相關文件
- `src/hooks/use-historical-data.ts` - 主要修改
- `src/components/features/historical-data/HistoricalBatchList.tsx` - 使用該 hook

### 相關功能
- CHANGE-010: 並行文件處理優化（已確認正常運作）
- Epic 0: 歷史數據初始化

### 發現背景
在驗證 CHANGE-010 並行處理是否生效時發現此問題。後端並行處理（`concurrency: 5`）正確執行，但前端無法顯示進度。

---

**修復人員**: Claude Code
**修復日期**: 2026-01-20
**驗證狀態**: ✅ 已驗證
