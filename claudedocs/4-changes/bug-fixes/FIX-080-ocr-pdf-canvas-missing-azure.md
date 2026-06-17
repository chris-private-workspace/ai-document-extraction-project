# FIX-080: Azure 文件處理「OCR Failed」— PDF→圖片渲染缺 `@napi-rs/canvas`

> **建立日期**: 2026-06-17
> **發現方式**: FIX-078 上傳修復後，用戶於 Azure DEV 實測：上傳成功，但處理中途回「OCR Failed / Processing Failed」；抓容器 log 定位
> **影響頁面/功能**: 文件上傳後的 V3 提取管線（`/api/documents/upload` 後置 fire-and-forget 處理）；Azure DEV 下**所有 PDF 文件處理**
> **優先級**: 高（核心上傳→處理流程在 Azure 不可用）
> **狀態**: 🚧 待修復（已記錄根因與修法；**改 code/加依賴需用戶核准後才動** — H2）

---

## 問題描述

FIX-078 解除上傳的 400 後，用戶上傳 PDF：**上傳成功（201）**，但處理管線中途失敗，前端顯示「OCR Failed / Processing Failed」。

容器 log（`*_default_docker.log`）在 V3 處理一啟動就出現以下、然後停住：

```
[CHANGE-024 DEBUG] shouldUseExtractionV3 result: true
Warning: Cannot load "@napi-rs/canvas" package: "Error: Cannot find module '@napi-rs/canvas'
Require stack:
- /app/node_modules/pdf-to-img/node_modules/pdfjs-dist/legacy/build/pdf.mjs".
Warning: Cannot polyfill `DOMMatrix`, rendering may be broken.
Warning: Cannot polyfill `ImageData`, rendering may be broken.
Warning: Cannot polyfill `Path2D`, rendering may be broken.
```

---

## 重現步驟

1. Azure DEV（映像 `dev-fix078-20260617112757` 起）登入。
2. 上傳一個 PDF → 上傳成功。
3. 等待自動處理 → 前端顯示「OCR Failed / Processing Failed」。
4. 抓容器 log → 見上述 `@napi-rs/canvas` 找不到模組，log 停在此。

> 本地 Windows 開發未必重現（本地 node_modules 解析得到 `@napi-rs/canvas` 或 fallback 可用）。屬「本地能跑、Azure 不能跑」類。

---

## 根本原因

V3 提取管線的**第一步**是 `src/services/extraction-v3/utils/pdf-converter.ts`，用 **`pdf-to-img`**（內含其**巢狀** `pdfjs-dist`，見 log 路徑 `pdf-to-img/node_modules/pdfjs-dist`）把 **PDF 轉成 PNG 圖片**，再餵給 GPT Vision 做 OCR / 三階段提取。

`pdfjs-dist` 在 Node 端渲染需要 **`@napi-rs/canvas`**。runtime 報「Cannot find module '@napi-rs/canvas'」→ PDF 轉圖失敗 → **OCR Failed**。

### 關鍵事實（已驗證）

| 事實 | 說明 |
|------|------|
| `@napi-rs/canvas` **在 `package-lock.json`**（36 處） | 是 transitive 依賴，但 runtime **找不到** → 與 [[FIX-079]] 同症：依賴有、沒進 standalone runtime 映像 |
| `package.json` 有 `canvas@^3.2.0` | 但 `pdfjs-dist` v4+ 用的是 **`@napi-rs/canvas`**（NAPI），非 Automattic 的 `canvas`；`canvas` 在此路徑幫不上 |
| `package.json` **無** `@napi-rs/canvas` 直接依賴 | 僅以 optional/transitive 存在 → npm ci 易跳過（optional、平台 binary） |
| Dockerfile 三 stage 皆 `node:26-slim`（註解仍寫 node:20） | `@napi-rs/canvas` / `canvas` / `sharp` 的 prebuilt 未必有 node 26 ABI |
| build log 大量 `npm warn allow-scripts`（canvas/sharp 等 install script 未跑） | npm 11.16 預設擋依賴 install script（無 `.npmrc`、無 lavamoat）→ native binary 沒建/沒下載 |

### 為何之前沒發現

上傳在 FIX-078 之前一直被 400 擋住，**根本走不到處理這步**。OCR 其實一直壞（runbook **§10** 早已標記 `@napi-rs/canvas` 缺失為「後續 FIX 候選」，當時誤判為僅影響預覽品質）。FIX-078 解除上傳後才暴露此既存阻塞。**非 FIX-078 造成、非部署弄壞**；新映像（上傳可用）仍嚴格優於舊映像，**不需回滾**。

---

## 解決方案（方向，實作前需用戶核准 — H2）

需綜合處理「讓 `@napi-rs/canvas`（及其平台 binary）真正存在於 runtime 映像」：

1. **明確化依賴**：將 `@napi-rs/canvas` 列為直接 `dependencies`（H2：加 npm 套件，須核准），確保被安裝與被 trace。
2. **standalone 落地**：比照 `re2-wasm`，於 `Dockerfile` runner 階段 `COPY --from=builder /app/node_modules/@napi-rs/canvas ...`（含平台 binary 子套件 `@napi-rs/canvas-linux-x64-gnu`），避免 Next standalone trace 漏掉動態載入的 native 模組。
3. **install script / prebuilt**：處理 npm 11.16 預設擋 install script 的問題（讓 native 套件取得 binary）；或確認 `@napi-rs/canvas` 用 prebuilt（NAPI，通常免編譯）即可。
4. **base image 對齊**：確認 `node:26-slim` 與各 native 套件 prebuilt 的相容性；必要時回 `node:20-slim`（與原設計一致）。
5. 驗證 PDF→圖片轉換成功、OCR 走完。

> 與 [[FIX-079]]（re2.wasm）同根：native/WASM 模組沒進 standalone runtime。建議**同一次映像重建**一併修。

---

## 修改的檔案（預估，待實作回填）

| 檔案 | 預估修改 |
|------|----------|
| `package.json` | 加 `@napi-rs/canvas`（H2，待核准） |
| `Dockerfile` | runner COPY `@napi-rs/canvas`（含平台 binary）；視情況處理 install script / base image |
| `next.config.ts` | 視調查，可能需 `serverExternalPackages` 加 `@napi-rs/canvas` / `pdf-to-img` |

---

## 測試驗證（待實作）

- [ ] 本地（Windows + Azurite）：上傳 PDF → 處理完成、有提取結果（確認未回歸）
- [ ] 重建映像部署 Azure DEV 後：上傳 PDF → 處理**成功**（非 OCR Failed）
- [ ] Azure 容器 log：無 `Cannot find module '@napi-rs/canvas'`、PDF 轉圖無錯
- [ ] `/api/health` 仍 200

---

## 關聯

- [[FIX-078]] — 上傳 400（已修復，PR #41）；本 FIX 為其解除後暴露的下一阻塞。
- [[FIX-079]] — re2.wasm runtime ENOENT；同屬 native 模組未落地 runtime，建議併同處理。
- runbook `docs/07-deployment/02-azure-deployment/dev-deployment-runbook.md` §10（canvas 警告）、§13（re2-wasm）。

---

*文件建立日期: 2026-06-17*
*最後更新: 2026-06-17*
