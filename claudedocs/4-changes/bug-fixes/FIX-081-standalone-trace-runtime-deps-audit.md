# FIX-081: Next.js standalone「動態載入/native 依賴漏搬」全面審計（部署後才爆的潛在地雷）

> **建立日期**: 2026-06-17
> **發現方式**: FIX-080 收尾後，以「本地正常、Azure standalone 映像 runtime 才爆」為主題對 codebase 全面審計（含 2 個 Explore agent + 人工驗證過濾）
> **影響頁面/功能**: 各 runtime 動態載入 native/資產的功能（PDF 報表、PDF 文本備援、OpenAPI 文檔頁、中文 PDF 渲染品質等）
> **優先級**: 中（核心上傳→OCR 已由 FIX-078/080 修好；本單聚焦**尚未觸發/未驗證**的同類風險，主動補強）
> **狀態**: ✅ 已實作（主要三項：pdfkit / openapi / CJK 字型 — Dockerfile + .dockerignore）；🚧 餘 pdf-parse、pdfjs worker 列為監控/後續

---

## 背景：根本模式

`next.config.ts` 用 `output: 'standalone'`，其依賴 trace **只搬靜態分析得到的檔**。runtime 動態載入者一律漏 → 本地（完整 node_modules）正常，Azure standalone 映像 `MODULE_NOT_FOUND`/`ENOENT`。修法：`Dockerfile` runner 階段對受害套件 `COPY --from=builder /app/node_modules/<pkg> ...`（整包）。

> 已修好（本系列）：`re2-wasm`([[FIX-079]])、`@napi-rs/canvas`、`pdf-to-img`+巢狀`pdfjs-dist`([[FIX-080]])。

---

## 審計結果（人工驗證過濾後）

> agent 初報有過度宣稱，下表已用「實測事實」修正（例：`pg`/i18n 實測可用 → 非缺口）。

### 🔴 高風險（pdfkit 已用程式碼確認並修復；pdf-parse 經複查降級）

| 項目 | 位置 | 為何危險 | 結論 / 處置 |
|------|------|---------|----------|
| **pdfkit** ✅ 已修 | `src/lib/reports/pdf-generator.ts`、`audit-report.service.ts`、`monthly-cost-report.service.ts` | **程式碼確認**：pdfkit@0.17.2 `js/pdfkit.es5.js` 以 `fs.readFileSync(__dirname + '/data/Helvetica.afm','utf8')` 讀標準字型 metric（計算路徑 fs 讀取，非靜態 import）→ standalone trace 只搬 JS、漏 `js/data/*.afm` → 產 PDF 報表時 `ENOENT`。全專案 `.font()` 全用標準字型、**無任何 registerFont** → 所有 pdfkit 報表皆受影響 | **本次 Dockerfile `COPY .../node_modules/pdfkit`（整包含 data）** |
| **pdf-parse** 🟡 降級監控 | `src/services/file-detection.service.ts:176` `require('pdf-parse/lib/pdf-parse')` | **複查後降級**：此為**字面量字串** require（非變數動態），Next 能靜態 trace；且刻意 require `lib/pdf-parse`（非 index.js，避開測試檔讀取坑），內部對 pdfjs 亦為靜態 require → 連帶可被 trace。僅在 **admin 歷史資料批次上傳**（`/api/admin/historical-data/upload`）會走到，非主上傳流程 | **本次不修**；若日後該分支實測 ENOENT 再 `COPY pdf-parse` |

### 🟡 中風險（功能受限/品質問題，非全掛）

| 項目 | 位置 | 影響 | 處置 |
|------|------|------|------|
| **OpenAPI spec** ✅ 已修 | `src/services/openapi-loader.service.ts:92` 讀 `process.cwd()/openapi/spec.yaml`（程式碼確認；ENOENT 時拋 `OpenAPI spec file not found`），被 `/api/openapi`、`/api/docs/version`、`/api/docs/error-codes` 使用 | `openapi/` 原被 `.dockerignore` 排除 → builder 無此目錄 → 3 個 route 失敗 | **本次**：`.dockerignore` 解除排除 + Dockerfile `COPY .../openapi ./openapi` |
| **CJK 字型** 🟡 部分修 | `node:26-slim` base | slim 無中日韓字型 → `@napi-rs/canvas`/pdfjs 渲染「未內嵌 CJK 字型」的 PDF→圖呈空白方框（影響 OCR 品質） | **本次**：runner `apt-get install fonts-noto-cjk`。⚠️ **僅解 canvas/pdfjs 渲染**；pdfkit 標準字型報表的中文需另在程式碼 `registerFont(CJK TTF)` 才生效（見文末技術債） |
| **pdfjs worker（CDN）** 🚧 未修 | `PDFViewer.tsx` / `PdfViewer.tsx` 從 `unpkg.com` 載 `pdf.worker` | 瀏覽器端 PDF 預覽依賴 unpkg 可達；封閉網路/proxy 擋 unpkg → 預覽失敗 | 後續：改本地 `public/` 放 worker，`workerSrc` 指本地 |

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

## 本次實作（2026-06-17）

集中處理已用程式碼確認的三項（不再「憑空 COPY」，pdf-parse 經複查確認可 trace 故不納入）。皆為**純 Dockerfile / .dockerignore 改動，無程式碼變更**。

### 修改的檔案

| 檔案 | 修改內容 |
|------|----------|
| `Dockerfile`（runner apt-get） | 加 `fonts-noto-cjk`（CJK 渲染品質） |
| `Dockerfile`（runner COPY） | 加 `COPY .../node_modules/pdfkit`（整包含 `js/data/*.afm`）+ `COPY .../openapi ./openapi` |
| `.dockerignore` | 解除對 `openapi` 的排除（否則 builder `COPY . .` 不含 spec.yaml，runner 無從 COPY） |

### ⚠️ 技術債務（本次未解，需後續 FIX）

| 項目 | 說明 |
|------|------|
| pdfkit 中文報表 | 安裝 OS CJK 字型**不會**讓 pdfkit 標準字型（Helvetica.afm）支援中文。報表內中文（如城市名）仍會缺字/方框。治本：程式碼 `doc.registerFont('cjk', '<TTF path>')` 並改 `.font('cjk')`，且 TTF 須一併入映像。建議另開 FIX 處理 |
| pdf-parse | 降級為監控；若 admin 歷史資料批次上傳實測 ENOENT，再補 `COPY pdf-parse` |
| pdfjs worker（CDN） | 封閉網路下瀏覽器 PDF 預覽從 unpkg 載 worker 可能失敗；後續改本地 `public/` |

## 部署紀錄

| 項目 | 值 |
|------|-----|
| 映像 tag | `dev-fix081-20260617143758` |
| ACR run | `cke`（Succeeded，55 步，較 FIX-080 +2 COPY） |
| 部署 | `az webapp config container set` → 新容器 uptime 33.9s、`database: connected` |

## 測試驗證

- [x] 映像重建成功（cloud run `cke` Succeeded；55 步含 `COPY pdfkit`/`COPY openapi` + `fonts-noto-cjk`。本機 `az acr build` exit 1 為 cp1252 串流崩潰假失敗，已用 `az acr task show-run` 確認雲端 Succeeded）
- [x] 部署後新容器接手（tag `dev-fix081-…`、`uptime≈34s`）、`/api/health` `database: connected`（無啟動回歸）
- [x] **openapi 修復（live）**：`/api/openapi` + `/api/docs/version` 經 `--resolve` 實測回 `200` + `success:true` + spec（修復前應為 500 `OpenAPI spec file not found`）
- [~] **pdfkit**：映像已含 `js/data/*.afm`（`COPY pdfkit` 步驟成功＝建置 Succeeded 的前提；同類「runtime 讀 COPY 檔」的 openapi 已 live 證實生效）。**待**在 Azure 觸發一次 PDF 報表匯出做 E2E 確認（需登入，建議用戶端觸發）
- [ ] 中文 PDF OCR 品質（CJK 字型；待實測。⚠️ pdfkit 中文報表仍須 registerFont TTF，見上方技術債）
- [~] 既有上傳→OCR 未回歸：容器健康 + `database: connected` 確認無啟動回歸；`pdf-to-img`/`canvas`/`re2.wasm` 為既有 COPY 未改動。完整上傳→OCR 待實測

### 2026-07-27 後續項進度

| 原「監控/後續」項 | 現況 |
|---|---|
| **pdfjs worker** | ✅ **已由 FIX-082 解決並完成 Azure 驗證** —— worker 改為隨映像提供（`public/pdfjs/`），實測由本站載入、預覽正常、頁面外部主機請求為零 |
| openapi | 回歸確認仍正常（`/api/openapi` → 200, 22.6 KB） |
| pdfkit / CJK 字型 | 仍待實測（需在 Azure 觸發一次 PDF 報表匯出；中文報表另有 `registerFont` TTF 技術債） |
| pdf-parse | 仍列監控 |

---

## 關聯

- [[FIX-078]] 上傳 400（blob 公開存取）、[[FIX-079]] re2.wasm、[[FIX-080]] OCR/pdf-to-img — 同一部署期問題串。
- 教訓記憶：standalone trace 漏搬 + `az acr build --file` 陷阱（見 [[FIX-080]] 更新節）。

---

*文件建立日期: 2026-06-17*
*最後更新: 2026-06-17*
