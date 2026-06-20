# FIX-087: EN 介面顯示中文 — ForwarderForm 欄位標籤硬編碼中文（companies edit 頁）

> **建立日期**: 2026-06-20
> **發現方式**: 用戶回報（Phase 1 交付前頁面檢視）
> **影響頁面/功能**: `/en/companies/[id]/edit`（及所有共用 `ForwarderForm` 的頁面）
> **優先級**: 高
> **狀態**: 🚧 待修復

---

## 問題描述

在英文介面下進入公司編輯頁 `/en/companies/[id]/edit`，表單出現「半中半英」現象：

- **標題、按鈕、代碼即時檢查（codeCheck）訊息**：正確顯示英文（這些走 `t('form.*')`）。
- **欄位標籤（label）、佔位文字（placeholder）、欄位描述（description）**：仍顯示繁體中文（例：「Forwarder 名稱」「輸入 Forwarder 的描述...」「唯一識別碼（大寫字母、數字、底線）」）。

對 EN 使用者而言，同一張表單上半部分英文、欄位區塊中文，屬明顯的 i18n 缺陷。

### 路徑鏈

```
/en/companies/[id]/edit
  → EditCompanyPage  (src/app/[locale]/(dashboard)/companies/[id]/edit/page.tsx)
    → 渲染 ForwarderForm  (src/components/features/forwarders/ForwarderForm.tsx)
```

> 註：`CompanyForm.tsx` 已不存在，companies edit 頁實際渲染的是 forwarders 目錄下的 `ForwarderForm`。

---

## 重現步驟

1. 將介面語言切換為 English（URL 前綴 `/en`）。
2. 進入任一公司詳情頁，點選「Edit」進入 `/en/companies/[id]/edit`。
3. 觀察現象：標題／按鈕為英文，但「名稱／代碼／描述／聯絡電子郵件／預設信心度／Logo」等欄位的標籤、佔位文字、描述仍為**繁體中文**。

---

## 根本原因

本問題屬「**組件硬編碼中文常量、未走 i18n**」，**並非** i18n key 缺失導致 fallback。

### 原因 1 — ForwarderForm 欄位區塊改用硬編碼常量

`src/components/features/forwarders/ForwarderForm.tsx` 中：

- 標題／按鈕／codeCheck 訊息**有**走 `t('form.*')`（因此 EN 正確）。
- 但欄位的 label／placeholder／description **改用硬編碼常量 `FORWARDER_FORM_LABELS`**，出現於以下約 12 處：

| 行號（約） | 引用 |
|-----------|------|
| 315 | `FORWARDER_FORM_LABELS.name.label` |
| 318 | `FORWARDER_FORM_LABELS.name.placeholder` |
| 329 | `FORWARDER_FORM_LABELS.code.label` |
| 332 | `FORWARDER_FORM_LABELS.code.placeholder` |
| 348 | `FORWARDER_FORM_LABELS.code.description` |
| 355 | `FORWARDER_FORM_LABELS.description.label` |
| 358 | `FORWARDER_FORM_LABELS.description.placeholder` |
| 370 | `FORWARDER_FORM_LABELS.contactEmail.label` |
| 374 | `FORWARDER_FORM_LABELS.contactEmail.placeholder` |
| 386 | `FORWARDER_FORM_LABELS.defaultConfidence.label` |
| 401 | `FORWARDER_FORM_LABELS.defaultConfidence.description` |
| 407 | `FORWARDER_FORM_LABELS.logo.label` |

### 原因 2 — 常量本身為繁體中文硬編碼

`FORWARDER_FORM_LABELS` 定義於 `src/types/forwarder.ts:794-823`，內容全為繁體中文硬編碼，例如：

```typescript
export const FORWARDER_FORM_LABELS = {
  name: {
    label: 'Forwarder 名稱',
    placeholder: '例如：DHL Express',
    description: '用於顯示的完整名稱',
  },
  description: {
    label: '描述',
    placeholder: '輸入 Forwarder 的描述...',
    description: '選填，最多 500 個字符',
  },
  // ... code / contactEmail / defaultConfidence / logo 同理
}
```

由於這是 `render` 時直接輸出的顯示用常量，無論 locale 為何都會固定顯示中文。

### 關鍵利好 — EN 翻譯早已存在

對應的 EN 翻譯**早已存在**於 `messages/en/companies.json` 的 `form` 區塊，可直接套用：

| 顯示內容 | 既有 EN key（`companies.form.*`） | EN 值 |
|----------|----------------------------------|-------|
| 名稱 label | `form.name` | "Company Name" |
| 名稱 placeholder | `form.namePlaceholder` | "Enter company name" |
| 代碼 label | `form.code` | "Company Code" |
| 代碼 placeholder | `form.codePlaceholder` | "Enter unique identifier code" |
| 代碼 description | `form.codeDescription` | "Only uppercase letters, numbers, and underscores allowed" |
| 描述 label | `form.descriptionField` | "Description" |
| 描述 placeholder | `form.descriptionPlaceholder` | "Enter company description (optional)" |
| 聯絡信箱 label | `form.contactEmail` | "Contact Email" |
| 聯絡信箱 placeholder | `form.contactEmailPlaceholder` | "Enter contact email" |
| 預設信心度 label | `form.defaultConfidence` | "Default Confidence" |
| 預設信心度 description | `form.defaultConfidenceDescription` | "Confidence threshold below this requires manual review" |
| Logo label | `form.logo` | "Logo" |

zh-TW／zh-CN 對應的 `form` 區塊亦應同步存在（修復時一併核對）。

---

## 解決方案

### 修復：將硬編碼常量改回 i18n `t('form.*')`

把 `ForwarderForm.tsx` 約 12 處的 `FORWARDER_FORM_LABELS.*` 引用，改為對應的 `t('form.*')` 呼叫（命名空間 `companies`，組件應已有 `const t = useTranslations('companies')` 或相應取得方式 — 修復時確認，若無則補上）。

修復後**單一組件檔即可修好 companies edit 頁**，幾乎不需新增 key。

#### ⚠️ key 名需逐一核對（重點）

既有 `companies.json` 的 `form` 區塊**並非**與 `FORWARDER_FORM_LABELS` 一對一同名映射，修復時必須逐欄核對，避免套錯 key：

- 名稱／代碼／聯絡信箱的 placeholder 是**扁平 key**（`namePlaceholder`、`codePlaceholder`、`contactEmailPlaceholder`），而非 `name.placeholder` 這類巢狀結構。
- 描述欄位 label／placeholder 對應的是 `descriptionField`／`descriptionPlaceholder`（**不是** `description`，後者在 `companies.json` 另作他用 = 表單區塊說明文字）。
- 以下 description 在 `companies.json` 目前**可能缺對應 key**，需確認後決定取捨：
  - `name.description`（"用於顯示的完整名稱"）
  - `contactEmail.description`（"選填，用於接收通知"）
  - `logo.description`（"選填，建議 200x200 像素"）

  原 UI 是否需要顯示這些 description，請於修復時確認；**若決定保留且 key 不存在 → 必須在 en/zh-TW/zh-CN 三語言同步新增**（見下方 H5）。

#### Hard Constraint — H5（i18n 同步）

> 修復後若需補任何 key（如上述缺失的 description），**必須** en/zh-TW/zh-CN 三語言同步新增，並執行 `npm run i18n:check` 確認通過後才可提交。

#### 關於硬編碼常量 `FORWARDER_FORM_LABELS` 本身

本 FIX 只負責讓 `ForwarderForm.tsx` 改走 i18n。是否一併移除／清理 `src/types/forwarder.ts` 中已不再被引用的 `FORWARDER_FORM_LABELS` 常量，視修復後該常量是否仍有其他引用而定：

- 若改完後 `FORWARDER_FORM_LABELS` 在全專案已無任何引用 → 屬「你改動造成的 orphan」，可於本 FIX 內一併清除。
- 若仍有其他檔案引用 → **不在本 FIX scope 內處理**，併入 FIX-088（見下）。

---

## 與 FIX-088 的關係

本 FIX（FIX-087）是**已確認的 P0 立即案例**，特性為「單一組件檔即可修好 companies edit 頁」，範圍明確收斂。

至於**全站系統性**的「顯示用常量被直接 render（繞過 i18n）」盤點、以及 `i18n:check` 的治理擴充（例如將「含 label/description 的 `export const` 是否被 render」納入檢查），另立 **FIX-088** 處理，避免本 FIX 範圍膨脹。

---

## 修改的檔案

| 檔案 | 修改內容 |
|------|----------|
| `src/components/features/forwarders/ForwarderForm.tsx` | 將約 12 處 `FORWARDER_FORM_LABELS.*` 改為 `t('form.*')`（命名空間 `companies`）；確認／補上 `useTranslations('companies')` |
| `messages/en/companies.json`（如需補 key） | 補上缺失的 description key（如有保留需求） |
| `messages/zh-TW/companies.json`（如需補 key） | 同步補上對應 key |
| `messages/zh-CN/companies.json`（如需補 key） | 同步補上對應 key |
| `src/types/forwarder.ts`（選擇性） | 若 `FORWARDER_FORM_LABELS` 改完後已無任何引用 → 一併移除 orphan |

> 上表為依分析預填，修復後須更新為實際修改的檔案清單。

---

## 測試驗證

修復完成後需驗證：

- [ ] `/en/companies/[id]/edit` 全表單欄位 label／placeholder／description 皆顯示英文，無中文殘留
- [ ] `/zh-TW/companies/[id]/edit` 顯示繁體中文、`/zh-CN/...` 顯示簡體中文，皆正常
- [ ] 切換語言後欄位文字即時切換，無 IntlError（瀏覽器 console 無 `MISSING_MESSAGE` 等錯誤）
- [ ] 代碼即時檢查（codeCheck）訊息維持各語言正確（不應因本次改動受影響）
- [ ] 若有補 key → `npm run i18n:check` 通過
- [ ] `npm run type-check` 與 `npm run lint` 通過
- [ ] 確認新增公司頁（共用 `ForwarderForm` 的其他入口）一併恢復正確語言顯示

---

*文件建立日期: 2026-06-20*
*最後更新: 2026-06-20*
