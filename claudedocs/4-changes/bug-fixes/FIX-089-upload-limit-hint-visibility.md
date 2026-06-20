# FIX-089: 上傳頁面未明確說明同時可上傳的文件數量上限

> **建立日期**: 2026-06-20
> **發現方式**: 用戶回報（Phase 1 交付前頁面檢視）
> **影響頁面/功能**: `/en/documents/upload`（文件上傳頁面）
> **優先級**: 中
> **狀態**: 🚧 待修復

---

## 問題描述

文件上傳頁面**未在顯眼位置**說明單次可同時上傳的文件數量上限（20 個）與相關限制（單檔 ≤ 10MB、支援 PDF/JPG/PNG）。

用戶在 Phase 1 交付前檢視頁面時，認為「沒看到清楚的數量上限說明」。

經調查確認：**上限早已實作於前後端**，本問題**不是缺少上限機制**，而是**現有提示文字不夠明顯／不夠完整**，導致用戶在上傳前無法一眼得知限制。

### 現況：上限已實作（前後端皆有）

| 限制項目 | 數值 | 來源 |
|----------|------|------|
| 每批次最大文件數 | 20 | `src/lib/upload/constants.ts:46`（`MAX_FILES_PER_BATCH: 20`） |
| 單檔最大大小 | 10MB | `src/lib/upload/constants.ts:40`（`MAX_FILE_SIZE: 10 * 1024 * 1024`） |
| 允許格式 | PDF / JPG / PNG | `src/lib/upload/constants.ts:30-34`（`ALLOWED_TYPES`） |

- **後端驗證**：`src/app/api/documents/upload/route.ts:240-253`（超過 20 個回傳 400 + `TOO_MANY_FILES`）、`:298-304`（單檔大小檢查）。
- **前端驗證**：`src/components/features/document/FileUploader.tsx:144-148`（拖放時的總數檢查）、`:182-188`（react-dropzone 的 `maxFiles` / `maxSize` 設定）。

### 現況：UI 已有提示但「不夠明顯」

`FileUploader.tsx:362-370` 已渲染提示文字：

- `upload.supportedFormats` → 「Supports {formats}, max {size} per file」（`messages/en/documents.json:80`）。
- `upload.maxFiles` → 「Maximum {count} files」，實際顯示「Maximum 20 files」（`messages/en/documents.json:82`）。

**問題點**：這段提示**只在 `FileUploader` 組件內部、且只在使用者已選擇城市之後**才會渲染。upload 頁的 `CardDescription`（`page.tsx:72-74`，使用 `upload.description`）**完全沒有**提及數量／大小上限，因此使用者在進入頁面、尚未選城市前看不到任何上限資訊。

---

## 重現步驟

1. 登入後前往 `/en/documents/upload`。
2. 觀察頁面標題下方的 `CardDescription` 說明文字。
3. 觀察現象：說明文字僅描述上傳用途，**未提及**「單次最多 20 個檔案／每檔 ≤ 10MB／支援 PDF·JPG·PNG」等綜合上限；上限提示僅在選擇城市後、`FileUploader` 內部才出現，使用者第一眼無法得知限制。

---

## 根本原因

屬於**文案／UX 可見性問題**，非功能缺陷：

1. **上限資訊未前置**：綜合上限（數量＋大小＋格式）只散落在 `FileUploader` 組件內部，且渲染時機在選擇城市之後，未出現在頁面最上方的 `CardDescription`。
2. **`CardDescription` 文案不完整**：`page.tsx:72-74` 使用的 `upload.description` 只描述功能用途，未納入任何上限說明。

### 用戶意圖確認（D8）

用戶意圖為「把**已存在的上限說清楚／更明顯**」，**非**調整上限數值。故本項歸類為文案／UX 微調 FIX。

> **備註**：若日後需求改為**調整上限數值**（例如把 20 改成其他值，或變更單檔大小／允許格式），則屬於功能變更，應另立 CHANGE-XXX 處理，而非沿用本 FIX。

---

## 解決方案

### 方案：在上傳頁顯眼位置補一句綜合上限說明

在 `src/app/[locale]/(dashboard)/documents/upload/page.tsx` 的 `CardDescription`（或 Dropzone 區域上方）補上一句明確、完整的綜合上限說明，例如：

> 單次最多 20 個檔案，每檔 ≤ 10MB，支援 PDF / JPG / PNG。

**🔴 實作硬性要求**：

1. **不可硬編碼數字／格式**：數量、單檔大小、允許格式必須**沿用 `UPLOAD_CONFIG`（`src/lib/upload/constants.ts`）常量插值**，與既有前後端驗證共用單一真實來源，避免文案與實際限制脫節。
   - 數量：`UPLOAD_CONFIG.MAX_FILES_PER_BATCH`
   - 單檔大小：`UPLOAD_CONFIG.MAX_FILE_SIZE_DISPLAY`（`'10MB'`）
   - 允許格式：`UPLOAD_CONFIG.ACCEPT_LABEL`（`'PDF, JPG, PNG'`）
2. **i18n 三語言同步（H5）**：新增的 UI 字串必須同步建立／更新 `messages/en/documents.json`、`messages/zh-TW/documents.json`、`messages/zh-CN/documents.json`，使用 ICU 參數插值（如 `{count}`、`{size}`、`{formats}`），完成後執行 `npm run i18n:check` 並通過。

> 既有的 `upload.supportedFormats` / `upload.maxFiles` 已提供格式與數量的參數化文案，實作時可優先**沿用或合併**這些既有 key，再決定是否需要在頁面層級新增一個整合性的 key（例如 `upload.uploadLimits`），避免重複定義。

---

## 修改的檔案

> 以下為**預估**修改範圍，修復完成後須更新為實際改動。

| 檔案 | 修改內容 |
|------|----------|
| `src/app/[locale]/(dashboard)/documents/upload/page.tsx` | 在 `CardDescription`（或 Dropzone 上方）加入綜合上限說明，數值以 `UPLOAD_CONFIG` 常量插值 |
| `messages/en/documents.json` | 新增／調整上限說明文案 key（英文） |
| `messages/zh-TW/documents.json` | 同步上限說明文案 key（繁中） |
| `messages/zh-CN/documents.json` | 同步上限說明文案 key（簡中） |

---

## 測試驗證

修復完成後需驗證：

- [ ] `/en/documents/upload` 在**未選城市時**即可在顯眼位置看到綜合上限說明（數量 20、單檔 10MB、支援 PDF/JPG/PNG）。
- [ ] 上限數值來自 `UPLOAD_CONFIG` 常量插值，**未硬編碼**任何數字／格式字串。
- [ ] 切換 `en` / `zh-TW` / `zh-CN`，三語言均正確顯示且無 `IntlError`（MISSING_MESSAGE）。
- [ ] `npm run i18n:check` 通過。
- [ ] `npm run type-check` 與 `npm run lint` 通過。

---

*文件建立日期: 2026-06-20*
*最後更新: 2026-06-20*
