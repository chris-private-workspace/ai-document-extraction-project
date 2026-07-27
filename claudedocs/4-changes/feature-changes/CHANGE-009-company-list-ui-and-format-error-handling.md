# CHANGE-009: 公司列表 UI 改進與格式建立錯誤處理

> **狀態**: ✅ 已完成

## 變更摘要

| 項目 | 內容 |
|------|------|
| 變更編號 | CHANGE-009 |
| 變更日期 | 2026-01-15 |
| 完成日期 | 2026-01-15 |
| 變更類型 | UI/UX 改進 |
| 影響範圍 | 公司管理頁面、文件格式建立功能 |
| 狀態 | ✅ 已完成 |

---

## 變更原因

1. **公司列表樣式不一致**
   - 公司列表頁面使用 Server Component + Suspense
   - 與發票列表頁面的樣式風格不一致
   - 缺少統計卡片和刷新按鈕

2. **409 Conflict 錯誤提示不明確**
   - 建立重複的文件格式時，錯誤訊息過於簡單
   - 用戶無法清楚知道是哪個類型/子類型已存在
   - 缺乏明確的操作指引

---

## 變更內容

### 1. 公司列表頁面重構

**檔案**: `src/app/(dashboard)/companies/page.tsx`

**改進項目**:

| 項目 | 改進前 | 改進後 |
|------|--------|--------|
| 組件類型 | Server Component | Client Component |
| 統計卡片 | 無 | 總計/啟用/停用 三張卡片 |
| 刷新按鈕 | 無 | 帶 loading 動畫的刷新按鈕 |
| 搜尋框 | URL 狀態管理 | 本地狀態 + 帶圖標輸入框 |
| 篩選器 | 基礎下拉 | 帶圖標的下拉選擇器 |
| 分頁 | 組件式 | 按鈕式（與發票列表一致）|

**新增元素**:
- `Building2` 圖標 - 總計統計卡片
- `CheckCircle` 圖標 - 啟用統計卡片
- `XCircle` 圖標 - 停用統計卡片
- `RefreshCw` 圖標 - 刷新按鈕（帶旋轉動畫）
- `Search` 圖標 - 搜尋輸入框
- `Filter` 圖標 - 篩選下拉選擇器

### 2. 文件格式建立錯誤處理改進

**檔案**: `src/hooks/use-company-formats.ts`

**改進項目**:

#### 2.1 新增 FormatExistsError 類別

```typescript
export class FormatExistsError extends Error {
  constructor(
    message: string,
    public documentType: string,
    public documentSubtype: string
  ) {
    super(message);
    this.name = 'FormatExistsError';
  }
}
```

#### 2.2 改進 createFormat 函數

- 專門處理 HTTP 409 錯誤
- 攜帶 documentType 和 documentSubtype 資訊

#### 2.3 改進 useCreateFormat onError 處理

- 檢測 FormatExistsError 類型
- 顯示包含中文標籤的詳細錯誤訊息
- 提供明確的操作指引

**錯誤訊息範例**:
```
標題：格式已存在
訊息：此公司已存在「其他 - 一般」格式，請選擇其他類型組合或編輯現有格式。
```

---

## 修改的檔案

| 檔案路徑 | 變更類型 | 說明 |
|----------|----------|------|
| `src/app/(dashboard)/companies/page.tsx` | 重構 | 公司列表頁面 UI 重構 |
| `src/hooks/use-company-formats.ts` | 增強 | 新增錯誤類別和改進錯誤處理 |

---

## 測試驗證

### 公司列表頁面

| 測試項目 | 預期結果 | 狀態 |
|----------|----------|------|
| 統計卡片顯示 | 顯示總計/啟用/停用數量 | ✅ |
| 刷新按鈕 | 點擊後圖標旋轉，數據刷新 | ✅ |
| 搜尋功能 | 輸入後過濾列表 | ✅ |
| 篩選功能 | 切換狀態後過濾列表 | ✅ |
| 分頁功能 | 正確顯示分頁資訊和導航 | ✅ |

### 格式建立錯誤處理

| 測試項目 | 預期結果 | 狀態 |
|----------|----------|------|
| 建立重複格式 | 顯示「格式已存在」Toast | ✅ |
| 錯誤訊息內容 | 包含中文類型/子類型標籤 | ✅ |
| 操作指引 | 提示編輯現有格式或選擇其他類型 | ✅ |

---

## 相關連結

- **Commit**: `b47c238 feat(ui): improve company list page and format creation error handling`
- **相關 Epic**: Epic 5 - Forwarder 配置管理

---

## 備註

此變更是針對手動測試過程中發現的 UI/UX 問題進行的改進，確保：
1. 公司列表與發票列表的視覺一致性
2. 格式建立時的錯誤提示更加友好和明確
