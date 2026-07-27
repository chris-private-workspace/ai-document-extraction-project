# FIX-011: PDF Viewer Controlled Mode

> **狀態**: ✅ 已完成

## Bug 概述

| 項目 | 說明 |
|------|------|
| **Bug ID** | FIX-011 |
| **發現日期** | 2026-01-03 |
| **修復日期** | 2026-01-03 |
| **嚴重程度** | High |
| **影響範圍** | `/admin/document-preview-test` 頁面 |
| **相關 Epic** | Epic 13 - 文件預覽與欄位映射 |
| **狀態** | ✅ 已完成 |

---

## 問題描述

### 現象

在 `/admin/document-preview-test` 頁面，PDF 預覽區域底部的工具列按鈕（頁碼切換、縮放控制）無法使用。點擊按鈕後，UI 狀態會更新，但 PDF 頁面不會改變。

### 根本原因

`PDFViewer` 組件的 props 設計存在 **受控 vs 非受控模式** 的問題：

1. **DocumentPreviewTestPage** 使用外部 `PDFControls` 組件，並將 `showControls={false}` 傳給 `PDFViewer`
2. 外部工具列透過 Zustand store 更新 `currentPage` 和 `zoomLevel`
3. **問題**：`PDFViewer` 只使用 `initialPage` 和 `initialScale` 作為**初始值**，不會響應後續的 prop 變更
4. 結果：工具列按鈕更新 store → store 傳新值給 `initialPage`/`initialScale` → `PDFViewer` 忽略變更

### 問題代碼

```typescript
// DocumentPreviewTestPage.tsx (修復前)
<DynamicPDFViewer
  file={currentFile.url}
  initialPage={currentPage}     // ❌ 只用於初始化
  initialScale={zoomLevel}      // ❌ 不會響應變更
  showControls={false}
  // ...
/>
```

```typescript
// PDFViewer.tsx (修復前)
const [state, setState] = React.useState<PDFViewerState>({
  numPages: 0,
  currentPage: controlledPage ?? initialPage,  // 只在初始化時讀取
  scale: controlledScale ?? initialScale,      // 後續變更被忽略
  // ...
})
```

---

## 修復方案

### 解決策略

為 `PDFViewer` 組件添加**受控模式**支援，新增 `page` 和 `scale` props：

- 當傳入 `page` prop 時，組件進入受控模式，內部狀態會同步外部值
- 當傳入 `scale` prop 時，縮放也進入受控模式
- 保留 `initialPage`/`initialScale` 用於非受控模式（向後兼容）

### 修改文件

#### 1. `src/components/features/document-preview/PDFViewer.tsx`

```typescript
// 新增 Props
interface PDFViewerProps {
  // ...existing props
  onScaleChange?: (scale: number) => void
  /** 初始頁碼（非受控模式）*/
  initialPage?: number
  /** 初始縮放倍率（非受控模式）*/
  initialScale?: number
  /** 受控頁碼（優先於 initialPage）*/
  page?: number
  /** 受控縮放倍率（優先於 initialScale）*/
  scale?: number
}

// 受控模式檢測
const isPageControlled = controlledPage !== undefined
const isScaleControlled = controlledScale !== undefined

// 受控模式同步 (FIX-011)
React.useEffect(() => {
  if (isPageControlled && controlledPage !== state.currentPage) {
    setState((prev) => ({ ...prev, currentPage: controlledPage }))
  }
}, [controlledPage, isPageControlled, state.currentPage])

React.useEffect(() => {
  if (isScaleControlled && controlledScale !== state.scale) {
    setState((prev) => ({ ...prev, scale: controlledScale }))
  }
}, [controlledScale, isScaleControlled, state.scale])
```

#### 2. `src/components/features/document-preview/DynamicPDFViewer.tsx`

更新類型定義，添加新 props：

```typescript
interface PDFViewerProps {
  // ...existing props
  onScaleChange?: (scale: number) => void
  /** 初始頁碼（非受控模式）*/
  initialPage?: number
  /** 初始縮放倍率（非受控模式）*/
  initialScale?: number
  /** 受控頁碼（優先於 initialPage）*/
  page?: number
  /** 受控縮放倍率（優先於 initialScale）*/
  scale?: number
}
```

#### 3. `src/app/(dashboard)/admin/document-preview-test/components/DocumentPreviewTestPage.tsx`

使用受控模式 props：

```typescript
// 修復後
<DynamicPDFViewer
  file={currentFile.url}
  page={currentPage}              // ✅ 受控模式
  scale={zoomLevel}               // ✅ 受控模式
  onPageChange={handlePageChange}
  onScaleChange={handleZoomChange}
  showControls={false}
  // ...
/>
```

---

## 驗證方式

1. 啟動開發伺服器：`npm run dev`
2. 導航至 `/admin/document-preview-test`
3. 上傳或載入 PDF 文件
4. 測試工具列按鈕：
   - 頁碼導航按鈕（上一頁、下一頁）
   - 縮放按鈕（放大、縮小、適合寬度）
5. 驗證 PDF 頁面會正確響應按鈕操作

---

## 受影響的組件

| 組件 | 變更類型 |
|------|----------|
| `PDFViewer.tsx` | 新增受控模式支援 |
| `DynamicPDFViewer.tsx` | 更新類型定義 |
| `DocumentPreviewTestPage.tsx` | 使用新的受控 props |

---

## 技術債務

無。此修復是正確的組件設計模式，符合 React 受控/非受控組件的最佳實踐。

---

## 相關 Bug

- FIX-008: pdfjs-dist SSR barrel export error
- FIX-009: Zustand infinite loop with useShallow
- FIX-010: pdfjs-dist v5 worker configuration

---

**修復者**: Claude Code
**審核者**: -
**版本**: 1.0.0
