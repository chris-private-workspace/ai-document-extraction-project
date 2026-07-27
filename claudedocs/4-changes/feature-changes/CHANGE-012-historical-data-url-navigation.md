# CHANGE-012: 歷史數據頁面 URL 導航一致性

> **狀態**: 🚧 進行中（⚠️ 需驗證）

## 變更摘要

| 項目 | 內容 |
|------|------|
| **變更編號** | CHANGE-012 |
| **變更日期** | 2026-01-20 |
| **相關模組** | 歷史數據管理 (Epic 0) |
| **影響範圍** | 前端導航邏輯 |
| **優先級** | 中 |
| **狀態** | ⚠️ 需驗證 |

---

## 問題描述

### 原有行為（不一致）

| 操作 | URL 變化 | 方式 |
|------|----------|------|
| 在列表點選批次記錄 | ❌ 不變 `/historical-data` | 用 React state 管理 |
| 從文件詳情返回 | ✅ 變成 `/historical-data?batchId=xxx` | 用 URL 參數 |

這導致：
- URL 無法反映當前選中的批次
- 無法分享或書籤特定批次連結
- 瀏覽器返回/前進按鈕行為不符預期

---

## 解決方案

### 設計目標

統一使用 URL 管理批次選擇狀態：

```
/historical-data                           → 批次列表
/historical-data?batchId=xxx               → 批次詳情（查看文件列表/上傳）
/historical-data/files/{fileId}            → 文件詳情
返回 → /historical-data?batchId=xxx        → 回到批次詳情
返回 → /historical-data                    → 回到批次列表
```

### 好處

- ✅ URL 可書籤、可分享
- ✅ 瀏覽器返回/前進按鈕正常工作
- ✅ 用戶可以直接訪問特定批次
- ✅ 導航行為一致

---

## 實作計畫

### 修改文件

| 文件 | 變更內容 |
|------|----------|
| `src/app/[locale]/(dashboard)/admin/historical-data/page.tsx` | 選擇批次時更新 URL |
| `src/components/features/historical-data/HistoricalBatchList.tsx` | 確認 onSelectBatch 介面 |

### 技術細節

1. **選擇批次時**：
   - 使用 `router.push` 更新 URL 為 `?batchId=xxx`
   - 移除直接 `setSelectedBatchId` 調用
   - 讓 `useEffect` 從 URL 讀取並設置 state

2. **返回列表時**：
   - 使用 `router.push(pathname)` 清除 URL 參數
   - 觸發 state 清除

3. **頁面載入時**：
   - 從 URL 讀取 `batchId` 參數
   - 自動設置 `selectedBatchId`

---

## 測試驗證

- [ ] 點選批次 → URL 更新為 `?batchId=xxx`
- [ ] 直接訪問 `?batchId=xxx` → 自動顯示批次詳情
- [ ] 返回按鈕 → URL 清除參數，回到列表
- [ ] 瀏覽器返回按鈕 → 正常工作
- [ ] 分享連結 → 其他用戶可直接訪問特定批次

---

## 相關文件

- `src/app/[locale]/(dashboard)/admin/historical-data/page.tsx`
- `src/app/[locale]/(dashboard)/admin/historical-data/files/[fileId]/page.tsx`
- `src/components/features/historical-data/HistoricalBatchList.tsx`

---

**建立者**: Claude AI
**建立日期**: 2026-01-20
