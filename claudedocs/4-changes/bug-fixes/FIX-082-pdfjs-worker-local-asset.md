# FIX-082: PDF 預覽 worker 改由本站提供（移除 unpkg CDN 依賴）

> **建立日期**: 2026-06-17
> **發現方式**: FIX-081 審計延伸（standalone 部署期風險編目中列為待辦項）
> **影響頁面/功能**: 瀏覽器端 PDF 預覽（審核並排介面、文件預覽）
> **優先級**: 中（封閉網路 / proxy 環境下會讓 PDF 預覽完全失效）
> **狀態**: ✅ 已完成（2026-07-27 Azure DEV E2E 驗證通過：worker 由本站載入、預覽正常、外部主機請求為零）

---

## 問題描述

兩個 PDF viewer 在客戶端設定 pdf.js 的 `workerSrc` 時，**從 `unpkg.com` CDN 載入** worker 腳本：

| 檔案 | 原設定 |
|------|--------|
| `src/components/features/review/PdfViewer/PdfViewer.tsx:30` | `//unpkg.com/pdfjs-dist@${pdfjs.version}/legacy/build/pdf.worker.min.mjs` |
| `src/components/features/document-preview/PDFViewer.tsx:77` | `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs` |

pdf.js 把繁重的解析/渲染放在 Web Worker（背景執行緒）執行；若瀏覽器**載不到** worker，PDF 預覽即失敗。本專案部署於 Azure VNet / 公司內網，**封閉網路 / proxy 可能擋掉 unpkg**，導致審核人員無法預覽原始 PDF。此為 [[FIX-081]] 審計中列出的待辦項。

---

## 根本原因

`workerSrc` 指向外部公開 CDN（unpkg），引入「執行期需可達外網」的隱性依賴。內部企業部署環境不應依賴外部 CDN。

### 關鍵技術細節：worker 版本必須與 react-pdf 的 pdfjs 一致

實測發現 **node_modules 內有兩份 pdfjs-dist**：

| 來源 | 版本 |
|------|------|
| 頂層直接依賴 `node_modules/pdfjs-dist` | 4.10.38 |
| **react-pdf 自帶的巢狀** `node_modules/react-pdf/node_modules/pdfjs-dist` | **4.8.69** ← react-pdf 實際使用、`pdfjs.version` 回報的版本 |

react-pdf 會比對 `pdfjs.version`（API）與 worker 的版本，不一致即拋
`The API version "X" does not match the Worker version "Y"`。因此複製 worker 時**必須**從 **react-pdf 解析到的那份 pdfjs-dist**（4.8.69）取檔，不能用頂層的 4.10.38。

---

## 解決方案

改由本站 `public/` 自身提供 worker，移除對 unpkg 的依賴。

### 1. 新增 build 期複製腳本 `scripts/copy-pdfjs-worker.mjs`

- 以 `require.resolve('react-pdf')` 為基準解析 pdfjs-dist，保證取到 react-pdf 實際使用的版本（4.8.69），版本永不 drift。
- 複製兩個 worker（保留各 viewer 原本的一般版 / legacy 版）：
  - `pdfjs-dist/build/pdf.worker.min.mjs` → `public/pdfjs/pdf.worker.min.mjs`
  - `pdfjs-dist/legacy/build/pdf.worker.min.mjs` → `public/pdfjs/legacy/pdf.worker.min.mjs`
- 來源缺檔即 `process.exit(1)`，讓 build 大聲失敗，不靜默 ship 壞掉的 worker。

### 2. 接到 npm lifecycle（`package.json`）

```json
"predev": "node scripts/copy-pdfjs-worker.mjs",
"prebuild": "node scripts/copy-pdfjs-worker.mjs",
```

- **刻意不用 `postinstall`**：deps 階段的 `npm ci` 只 COPY 了 package.json + schema、沒有 `scripts/`，postinstall 會找不到腳本而讓 `npm ci` 失敗。`prebuild`/`predev` 只在 `npm run build` / `npm run dev` 時觸發（此時 `scripts/` 與 `node_modules` 都在），Docker builder 階段的 `npm run build` 會自然帶到。

### 3. `public/pdfjs/` 加入 `.gitignore`

產生物（跟著 pdfjs-dist 版本）不入 git；Dockerfile runner 既有的 `COPY /app/public ./public` 會把 build 期產生的 worker 一併帶入映像。

### 4. 兩個 viewer 的 `workerSrc` 改為本地路徑

- `review/PdfViewer/PdfViewer.tsx` → `'/pdfjs/legacy/pdf.worker.min.mjs'`
- `document-preview/PDFViewer.tsx` → `'/pdfjs/pdf.worker.min.mjs'`

---

## 修改的檔案

| 檔案 | 修改內容 |
|------|----------|
| `scripts/copy-pdfjs-worker.mjs` | **新增**：從 react-pdf 解析的 pdfjs-dist 複製 worker 到 `public/pdfjs/` |
| `package.json` | 加 `predev` / `prebuild` 觸發複製腳本 |
| `.gitignore` | 加 `public/pdfjs/`（產生物不入 git） |
| `src/components/features/review/PdfViewer/PdfViewer.tsx` | `workerSrc` → 本地 legacy 路徑 |
| `src/components/features/document-preview/PDFViewer.tsx` | `workerSrc` → 本地一般版路徑 |

---

## 測試驗證

- [x] 腳本解析邏輯驗證：實測 react-pdf 解析到 pdfjs-dist@4.8.69，兩個 worker 來源檔存在（1337 KB / 1377 KB）且複製成功
- [x] CI：type-check + lint 通過（PR 已合併）
- [x] 映像重建：builder `npm run build` 觸發 prebuild、`public/pdfjs/` 進入映像（2026-07-27 實測）
- [x] 部署後 E2E：開啟 PDF 預覽，Network 顯示 worker 從**本站**（非 unpkg）載入、預覽正常、無版本不符錯誤（2026-07-27 實測）
- [x] （封閉網路）確認預覽不再依賴外部 CDN（2026-07-27 實測外部主機請求為空陣列）

---

## 2026-07-27 Azure DEV 執行期驗證

| 檢查 | 結果 |
|---|---|
| worker 已進入映像 | `GET /pdfjs/pdf.worker.min.mjs` → **200, 1337.7 KB**；`/pdfjs/legacy/pdf.worker.min.mjs` → **200, 1377.6 KB** |
| 實際載入來源 | 文件詳情頁的 `performance.getEntriesByType('resource')` 顯示 worker 由**本站** origin 載入（400 KB 傳輸、86 ms） |
| 預覽正常 | PDF 渲染出 2 個 canvas，無版本不符錯誤 |
| **封閉網路** | 該頁所有資源請求中，**非本站 origin 的外部主機數 = 0**（空陣列）—— unpkg / cdnjs / jsdelivr 皆無請求 |

> 「外部主機為空陣列」是封閉網路驗收項最直接的證據：不僅 worker，整個頁面都沒有任何外部依賴。

---

## 關聯

- [[FIX-081]] standalone 動態依賴審計（本項為其中列出的「pdfjs worker CDN」待辦）
- [[feedback-nextjs-standalone-native-deploy-traps]]

---

*文件建立日期: 2026-06-17*
*最後更新: 2026-06-17*
