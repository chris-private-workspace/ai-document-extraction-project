# FIX-081: Next.js standalone「動態載入/native 依賴漏搬」全面審計（部署後才爆的潛在地雷）

> **建立日期**: 2026-06-17
> **發現方式**: FIX-080 收尾後，以「本地正常、Azure standalone 映像 runtime 才爆」為主題對 codebase 全面審計（含 2 個 Explore agent + 人工驗證過濾）
> **影響頁面/功能**: 各 runtime 動態載入 native/資產的功能（PDF 報表、PDF 文本備援、OpenAPI 文檔頁、中文 PDF 渲染品質等）
> **優先級**: 中（核心上傳→OCR 已由 FIX-078/080 修好；本單聚焦**尚未觸發/未驗證**的同類風險，主動補強）
> **狀態**: 🚧 待處理（已編目；實作需逐項驗證 + Dockerfile 改動 + 重建映像，建議集中一次處理）

---

## 背景：根本模式

`next.config.ts` 用 `output: 'standalone'`，其依賴 trace **只搬靜態分析得到的檔**。runtime 動態載入者一律漏 → 本地（完整 node_modules）正常，Azure standalone 映像 `MODULE_NOT_FOUND`/`ENOENT`。修法：`Dockerfile` runner 階段對受害套件 `COPY --from=builder /app/node_modules/<pkg> ...`（整包）。

> 已修好（本系列）：`re2-wasm`([[FIX-079]])、`@napi-rs/canvas`、`pdf-to-img`+巢狀`pdfjs-dist`([[FIX-080]])。

---

## 審計結果（人工驗證過濾後）

> agent 初報有過度宣稱，下表已用「實測事實」修正（例：`pg`/i18n 實測可用 → 非缺口）。

### 🔴 高風險（很可能真壞，但**尚未在 Azure 觸發過**，需驗證）

| 項目 | 位置 | 為何危險 | 驗證/修法 |
|------|------|---------|----------|
| **pdfkit** | `src/lib/reports/pdf-generator.ts`、`audit-report.service.ts`、`monthly-cost-report.service.ts` | pdfkit runtime 讀自帶的 `.afm` 字型 metric 檔（fs 讀套件內資產）→ standalone trace 易漏 → 產 PDF 報表時 `ENOENT` | 在 Azure 觸發一次 PDF 報表匯出；若爆 → Dockerfile `COPY .../node_modules/pdfkit` |
| **pdf-parse** | `src/services/file-detection.service.ts:176` `require('pdf-parse/lib/pdf-parse')` | require 套件**內部路徑**（非套件入口）→ trace 易漏該內部檔；pdf-parse 亦有讀檔習性 | 觸發 file-detection 走 pdf-parse 分支；若爆 → `COPY .../node_modules/pdf-parse`（或改用已有的 `unpdf`） |

### 🟡 中風險（功能受限/品質問題，非全掛）

| 項目 | 位置 | 影響 | 修法 |
|------|------|------|------|
| **OpenAPI spec** | `src/services/openapi-loader.service.ts` 讀 `process.cwd()/openapi/spec.yaml` | `openapi/` 目錄未在 Dockerfile COPY → `/docs` OpenAPI 頁可能讀不到 spec | Dockerfile `COPY .../openapi ./openapi`，或改 build 期 import |
| **CJK 字型** | `node:26-slim` base | slim 無中日韓字型 → `@napi-rs/canvas` 渲染中文 PDF→圖可能空白方框（影響 OCR 品質）、pdfkit 中文報表亂碼 | Dockerfile runner `apt-get install -y fonts-noto-cjk` |
| **pdfjs worker（CDN）** | `PDFViewer.tsx` / `PdfViewer.tsx` 從 `unpkg.com` 載 `pdf.worker` | 瀏覽器端 PDF 預覽依賴 unpkg 可達；封閉網路/proxy 擋 unpkg → 預覽失敗 | 改本地 `public/` 放 worker，`workerSrc` 指本地 |

### 🟢 低風險 / 非阻塞 / 已驗證可用（不需動作）

| 項目 | 結論 |
|------|------|
| **sharp** | `compressImage` 的 catch `return buffer` fallback → 缺它只是不壓縮（圖較大、token 較多），**非阻塞**。非 package.json 直接依賴。若要省成本可補 COPY |
| **exceljs** | 多處**靜態** import（excel-generator 等）→ 應已被 trace；另有一處動態 import（regional-report:583）會解析到同一 traced 套件。純 JS、低風險 |
| **pg** | ❌ 非缺口：seed/bootstrap 實測成功、`/api/health` `database: connected` → pg 在 runtime 可用 |
| **messages/\*.json**（i18n 動態 import）| ❌ 非缺口：Dockerfile 已 `COPY /app/messages`，且頁面翻譯實測正常 |
| **bcryptjs** | ✅ 已 COPY（Dockerfile:179）+ 登入正常 |

---

## 建議處理方式

1. **一次集中處理**（建議）：在下一次映像重建時，一併
   - 補 Dockerfile COPY：`pdfkit`、`pdf-parse`、`openapi`（待各自驗證確認後加，避免無謂膨脹）；
   - 加 `fonts-noto-cjk`（中文渲染品質，低風險高 CP 值）；
   - （選用）`sharp`（壓縮省成本）。
2. **逐項驗證優先**：高風險兩項（pdfkit / pdf-parse）先在 Azure 各觸發一次對應功能，確認是否真爆再補（避免憑空 COPY）。
3. **根治方向（治本，較大）**：評估把這些動態載入套件改靜態 import，或統一以 `serverExternalPackages` + Dockerfile COPY 列管；並建一份「runtime 動態依賴清單」隨 Dockerfile 維護。

---

## 測試驗證（待實作逐項勾選）

- [ ] PDF 報表匯出（audit / monthly / regional）在 Azure 成功產檔（pdfkit）
- [ ] file-detection 走 pdf-parse 分支不 ENOENT（pdf-parse）
- [ ] `/docs` OpenAPI 頁正常載入 spec（openapi）
- [ ] 中文 PDF 上傳 → OCR 文字正確、PDF 報表中文不亂碼（CJK 字型）
- [ ] （封閉網路）瀏覽器 PDF 預覽 worker 載入正常（pdfjs CDN）

---

## 關聯

- [[FIX-078]] 上傳 400（blob 公開存取）、[[FIX-079]] re2.wasm、[[FIX-080]] OCR/pdf-to-img — 同一部署期問題串。
- 教訓記憶：standalone trace 漏搬 + `az acr build --file` 陷阱（見 [[FIX-080]] 更新節）。

---

*文件建立日期: 2026-06-17*
*最後更新: 2026-06-17*
