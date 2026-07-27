# FIX-003: 批次狀態邏輯矛盾修復

> **狀態**: ✅ 已修復
> **發現日期**: 2025-12-27
> **修復日期**: 2025-12-27
> **嚴重度**: 高
> **影響範圍**: Epic 0 - 歷史數據初始化

---

## 問題描述

### 症狀

用戶在成功完成術語聚合的批次上點擊「匯出 Excel」按鈕時，收到錯誤訊息：

```json
{
  "success": false,
  "error": "Batch not completed",
  "details": "Batch status is AGGREGATED. Export is only available for completed batches."
}
```

### 根本原因

批次狀態邏輯存在語義矛盾：

```typescript
// 原始邏輯（batch-processor.service.ts 第 948-952 行）
const finalStatus = failedCount === files.length
  ? 'FAILED'
  : termAggregationCompleted
    ? 'AGGREGATED'  // 術語聚合成功 → AGGREGATED
    : 'COMPLETED'   // 術語聚合失敗 → COMPLETED
```

| 情況 | 實際狀態 | 語義問題 |
|------|----------|----------|
| 術語聚合**成功** | `AGGREGATED` | 更完整的處理，卻不是「完成」|
| 術語聚合**失敗** | `COMPLETED` | 失敗了反而是「完成」|

這導致：
1. Excel 匯出 API 只允許 `COMPLETED` 狀態
2. 成功完成術語聚合的批次反而無法匯出報告
3. Epic 0 的核心價值（術語發現報告）無法使用

---

## 解決方案

### 設計修正

統一使用 `COMPLETED` 作為最終狀態，用 `aggregationCompletedAt` 欄位判斷是否完成了術語聚合：

```typescript
// 修正後邏輯
const finalStatus = failedCount === files.length ? 'FAILED' : 'COMPLETED'

// 術語聚合是否完成由 aggregationCompletedAt 欄位判斷
```

### 修改的文件

#### 1. `src/services/batch-processor.service.ts`

```diff
-  // 更新批次狀態為完成
-  // 注意：如果術語聚合已完成，狀態應為 AGGREGATED，否則為 COMPLETED 或 FAILED
-  const finalStatus = failedCount === files.length
-    ? 'FAILED'
-    : termAggregationCompleted
-      ? 'AGGREGATED' // 術語聚合已完成
-      : 'COMPLETED'
+  // 更新批次狀態為完成
+  // FIX-003: 統一使用 COMPLETED 作為最終狀態
+  // 術語聚合是否完成由 aggregationCompletedAt 欄位判斷，而非狀態值
+  // 原邏輯的問題：術語聚合成功 → AGGREGATED，失敗 → COMPLETED，語義矛盾
+  const finalStatus = failedCount === files.length ? 'FAILED' : 'COMPLETED'
```

#### 2. `src/services/batch-term-aggregation.service.ts`

```diff
-    // 更新狀態為聚合完成
+    // FIX-003: 更新狀態為 COMPLETED（統一終態）
+    // 術語聚合是否完成由 aggregationCompletedAt 欄位判斷
     await prisma.historicalBatch.update({
       where: { id: batchId },
       data: {
-        status: 'AGGREGATED',
+        status: 'COMPLETED',
         aggregationCompletedAt: new Date(),
       },
     });
```

### 資料遷移

將現有 `AGGREGATED` 批次更新為 `COMPLETED`：

```sql
UPDATE historical_batches
SET status = 'COMPLETED'
WHERE status = 'AGGREGATED';
-- 影響 3 行
```

遷移的批次：
| 批次名稱 | ID |
|----------|-----|
| TEST-PLAN-002 Epic-0 完整測試 | 8d8883a8-... |
| TEST-PLAN-002-v2 DUAL_PROCESSING 修復驗證 | 303b2f36-... |
| FIX-002-FK-CONSTRAINT-驗證 | 370f402b-... |

---

## 狀態機修正

### 修正前

```
PENDING → PROCESSING → AGGREGATING → AGGREGATED (終態?)
                                  ↘ COMPLETED (終態?)
                                  ↘ FAILED (終態)
```

問題：`AGGREGATED` 和 `COMPLETED` 都是終態，語義混亂。

### 修正後

```
PENDING → PROCESSING → AGGREGATING → COMPLETED (統一終態)
                                  ↘ FAILED (失敗終態)
```

- `AGGREGATING`: 術語聚合中（中間狀態）
- `COMPLETED`: 處理完成（統一終態）
- `aggregationCompletedAt IS NOT NULL`: 判斷是否完成了術語聚合

---

## 驗證步驟

1. **確認資料遷移**：所有 `AGGREGATED` 批次已更新為 `COMPLETED`
2. **測試 Excel 匯出**：之前失敗的批次現在可以匯出
3. **新批次處理**：新處理的批次會直接到達 `COMPLETED` 狀態

---

## 影響評估

| 項目 | 影響 |
|------|------|
| 現有批次 | 3 個批次狀態已遷移 |
| Excel 匯出 | 恢復正常 |
| 前端顯示 | 無影響（可用 `aggregationCompletedAt` 顯示聚合狀態）|
| API 邏輯 | 簡化（只需檢查 COMPLETED）|

---

## 相關資訊

- **Epic**: Epic 0 - 歷史數據初始化
- **發現於**: FIX-002 驗證過程中
- **前置修復**: FIX-002 (公司自動建立 FK 約束問題)

---

**修復者**: Claude Code
**審核者**: -
**最後更新**: 2025-12-27
