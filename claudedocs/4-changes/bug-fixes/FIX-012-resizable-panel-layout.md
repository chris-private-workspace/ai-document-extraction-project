# FIX-012: Resizable Panel Layout Optimization

> **狀態**: ✅ 已完成

## Bug 概述

| 項目 | 說明 |
|------|------|
| **Bug ID** | FIX-012 |
| **發現日期** | 2026-01-03 |
| **修復日期** | 2026-01-03 |
| **嚴重程度** | Medium |
| **影響範圍** | `/admin/document-preview-test` 頁面 |
| **相關 Epic** | Epic 13 - 文件預覽與欄位映射 |
| **狀態** | ✅ 已完成 |

---

## 問題描述

### 現象

在 `/admin/document-preview-test` 頁面：
1. PDF 預覽區塊佔據了大部分空間
2. 左右兩個面板被擠得很小
3. 面板看起來無法調整大小（拖動手柄不明顯）

### 根本原因

1. **中間面板沒有最大尺寸限制**：`defaultSize={50} minSize={30}` 但沒有 `maxSize`，允許無限擴展
2. **拖動手柄太細**：shadcn/ui 的 `ResizableHandle` 預設寬度為 `w-px`（1px），用戶難以發現和點擊

---

## 修復方案

### 修改文件

#### `src/app/(dashboard)/admin/document-preview-test/components/DocumentPreviewTestPage.tsx`

**1. 為中間面板添加最大尺寸限制**

```typescript
// 修復前
<ResizablePanel defaultSize={50} minSize={30}>

// 修復後
<ResizablePanel defaultSize={50} minSize={30} maxSize={60}>
```

**2. 增強 ResizableHandle 可見性**

```typescript
// 修復前
<ResizableHandle withHandle />

// 修復後
<ResizableHandle
  withHandle
  className="w-2 bg-border hover:bg-primary/20 transition-colors"
/>
```

---

## 面板尺寸配置（修復後）

| 面板 | defaultSize | minSize | maxSize |
|------|-------------|---------|---------|
| 左側（提取欄位） | 20% | 15% | 30% |
| 中間（PDF 預覽） | 50% | 30% | **60%** |
| 右側（映射配置） | 30% | 20% | 40% |

**總計**: 100% (20 + 50 + 30)

---

## 驗證方式

1. 啟動開發伺服器：`npm run dev`
2. 導航至 `/admin/document-preview-test`
3. 驗證：
   - 三個面板以合理比例顯示
   - 可見的拖動手柄（灰色邊框線）
   - 滑鼠懸停時手柄顏色變化
   - 可以拖動手柄調整面板大小
   - 面板尺寸在 min/max 範圍內正確約束

---

## 技術說明

### ResizableHandle 樣式變更

| 屬性 | 修復前 | 修復後 |
|------|--------|--------|
| 寬度 | `w-px` (1px) | `w-2` (8px) |
| 背景 | 無 | `bg-border` |
| 懸停效果 | 無 | `hover:bg-primary/20` |
| 過渡動畫 | 無 | `transition-colors` |

### 為什麼不直接修改 shadcn/ui 組件

根據項目規範（`.claude/rules/components.md`），不應直接修改 `src/components/ui/` 下的 shadcn 組件。因此我們通過 `className` prop 來覆蓋樣式，這是正確的自定義方式。

---

## 相關 Bug

- FIX-011: PDF Viewer Controlled Mode

---

**修復者**: Claude Code
**審核者**: -
**版本**: 1.0.0
