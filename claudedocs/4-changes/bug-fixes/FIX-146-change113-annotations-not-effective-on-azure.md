# FIX-146: CHANGE-113 的 A1/A2/A3 在 production build 全部失效（webpack 把 pdfjs 的動態 import 換成必然拋錯的 stub）

> **建立日期**: 2026-07-30
> **發現方式**: CHANGE-113 階段一部署到 Azure DEV 後，以同一份 DHL 文件重跑，比對本地與 Azure 的結果
> **根因確認方式**: 拉下線上映像，直接讀 `.next` 編譯產物
> **影響範圍**: `src/services/extraction-v3/utils/pdf-converter.ts`（`loadPdfjs`）、`next.config.ts`、`src/services/processing-result-persistence.service.ts`
> **優先級**: 高（CHANGE-113 階段一的三項機制在任何 production build 上都無效）
> **狀態**: 🚧 已實作，待 Azure DEV 端到端驗證

---

## 根因（已確認，非推論）

`PdfConverter.loadPdfjs()` 的最後一步是動態載入 pdfjs 的 ESM 入口：

```typescript
// pdf-converter.ts:794
return import(pathToFileURL(pdfjsPath).href)
```

`next build` 後，這一行在 `.next/server/chunks/54429.js` 裡變成：

```js
static async loadPdfjs(){
  let {createRequire:a}=await Promise.resolve().then(c.t.bind(c,98995,23)),
      {pathToFileURL:b}=await Promise.resolve().then(c.t.bind(c,73136,23)),
      {join:d}=await Promise.resolve().then(c.t.bind(c,76760,23)),
      e=a(d(process.cwd(),"package.json")),
      f=e.resolve("pdfjs-dist/legacy/build/pdf.mjs",{paths:[e.resolve("pdf-to-img")]});
  return c(54385)(b(f).href)      // ← 原本是 import(url)
}
```

webpack 無法靜態分析 `import(變數)`，於是把它換成 `__webpack_require__(54385)`。而 module 54385 是 webpack 的 **missing-module stub**：

```js
54385: a => { function b(a) { return Promise.resolve().then(() => {
  var b = Error("Cannot find module '" + a + "'"); throw b.code = "MODULE_NOT_FOUND"
```

它對**任何**傳入路徑無條件拋 `MODULE_NOT_FOUND`。因此 `loadPdfjs()` 在 production build 中**每一次都失敗**，不是機率問題。

失敗後落進 `collectPageHints` 的 catch（`pdf-converter.ts:757-760`），只 push 一則 warning、回傳空 Map。轉檔本身照常成功，於是整條 pipeline 毫無異常。

---

## 影響：三項機制同時失效，且完全靜默

`collectPageHints` 是 A1／A2／A3 的**共同上游**，回空 Map 即三者一起失效：

| 機制 | 依賴 | production build 上的實際行為 |
|---|---|---|
| A1 註解補畫 | `hints.annotations` | 不補畫 |
| A2 候選清單注入 | `conversionResult.annotations` → Stage 3 | prompt 內無候選清單段落 |
| A3 側躺頁轉正 | `hints.rotation` | 不轉正，GPT 收到側躺圖 |

**這不是 Azure 特有問題。** 本地驗證走 `npm run dev`（原生 `import()` 保留，故三者皆有效），一旦 `next build` 就全部失效 —— 包含本地 `npm run build && npm start`。CHANGE-113 階段一的驗證盲點就在這裡：三項機制從未在 production build 上驗證過。

> 同類前例：memory `feedback_local_login_dev_bypass_vs_build`（dev 能登入、build 不能）。dev 與 build 的行為差異在本專案已出現第二次。

### 一個間接但明確的訊號被忽略了

映像體積從 242.5 MB 跳到 269.5 MB（+27 MB），而 `c7ebc55` **沒有動** `Dockerfile`／`package.json`／`package-lock.json`。前四版彼此只差幾百位元組。

原因：`pdfjs-dist` 不在 `serverExternalPackages`，webpack 追進去把它 bundle 進 `.next/server/chunks`（`54429.js`、`16768.js` 都含 `pdfjs-dist`）。**體積跳躍從一開始就在指向根因**，當時未追下去。

---

## 證據鏈

| # | 事實 | 取得方式 |
|---|---|---|
| 1 | 線上映像確實含 `c7ebc55` | 映像內 `.next` 含 `annotationCount`／`rotatedPages`／`autoRotatePages`（皆 `c7ebc55` 獨有） |
| 2 | 文件處理跑在新容器上 | 容器 02:16 啟動、設定 02:27 完成、02:30 重啟、**文件 02:31:42 建立**、Stage 3 於 02:32 執行 |
| 3 | A2 確實未注入 | `extraction_results.gpt_prompt`（**實際送出的 prompt**）無候選清單段落 |
| 4 | annotations 未達 Stage 3 | `[Stage3] Injected N PDF annotation(s) as groupKey candidates` 這條 log 在容器 log 中缺席，而同批其他 `[Stage3]` 訊息都抓到了（有對照組的缺席） |
| 5 | 透傳鏈代碼完整 | `extraction-v3.service.ts:463` → `stage-orchestrator:275` → `stage-3:285` 三處都接上 |
| 6 | 缺陷不在 pdfjs 環境 | 映像內實測：`import` 成功、`getAnnotations` 讀到 2 筆註解、`rect` 通過過濾、`convertToViewportRectangle` 成功、sharp 旋轉可用、canvas 可載入 |
| 7 | 根因在編譯產物 | `.next` 內 `loadPdfjs` 的 `import()` 已被換成必然拋錯的 stub（見上） |

---

## 更正三個先前的錯誤推論

| 先前說法 | 實際 | 為何錯 |
|---|---|---|
| 「A3 未生效，因為 AWB 與轉正前的錯誤值相同」 | A3 確實未生效，但**當時的理由不成立** | AWB 讀錯是側躺小字誤讀；轉正後模型仍可能讀錯。這是間接推論，不是證據。真正的證據是編譯產物 |
| 「A1 必定生效，否則模型看不到 RCIM 號碼」 | **A1 也沒生效** | 在映像內渲染該頁確認：**pdfjs 自己就會繪製 FreeText 註解**（`appearance=false` 時自行生成），RCIM 紅字紅框清楚可見。模型讀到 groupKey 與 A1 無關 |
| 「`HAS_CANDIDATES=false` 可能只是查錯了層次（候選清單是執行時注入、不寫回 `prompt_configs`）」 | 結論仍成立 | 這個自我質疑是對的，所以改查 `extraction_results.gpt_prompt`（實際送出的內容）—— 確認 A2 真的沒注入 |

---

## 併修缺陷：驗證訊號從未落地 —— 但這不是既有 bug

CHANGE-113 為「可事後查證」而寫入的 `annotationCount` / `rotatedPages`（`extraction-v3.service.ts:354-360`）**從未落地**。Azure 該筆的 `pipeline_steps` 證實了這點 —— 每個步驟只有 `step` / `success` / `durationMs`（`FILE_PREPARATION` 為 8365 ms）。

🔴 **定性更正**：這不是既有缺陷。`convertStepResultsToJson` 的 JSDoc 原本就明確寫著「**不保存 data 屬性（step-specific 大資料，會造成 JSON 過大）**」—— 丟棄 `data` 是**刻意設計**，而且理由成立：三階段步驟的 `data` 是**完整**階段結果（`stage-orchestrator.service.ts` 的 `data: stage{1,2,3}Result`），已分別存於 `stage_{1,2,3}_result` 與 `stage_{1,2,3}_ai_details`（Azure 該筆分別 3446 / 7594 字元），重複寫入會讓 pipelineSteps 膨脹數倍。

**真正的問題是 CHANGE-113 誤用了一個明確標註不會持久化的欄位，並在文件聲稱「可事後查證」。**

因此修法不是「全部透傳」（那會踩進原設計要避開的坑），而是白名單：只對**沒有專屬欄位、且 data 是小型摘要**的步驟保留。

診斷成本因此高昂：本次得拉下映像、逐一排除 7 個假設、最後讀編譯產物才定案。`conversionResult.warnings` 也只存在記憶體 —— 那則本可直接指出根因的 warning 就是這樣消失的。

---

## 修復內容（已實作）

### 1. `loadPdfjs` 改用打包器看不見的原生 import

`pdf-converter.ts` —— 把 specifier 藏進字串，webpack 無從靜態分析，便不會替換成 stub：

```typescript
const nativeImport = new Function('specifier', 'return import(specifier)') as (...);
return nativeImport(pathToFileURL(pdfjsPath).href);
```

### 2. 轉檔 warning 一併寫入 `FILE_PREPARATION` 的 data

`extraction-v3.service.ts` —— `collectPageHints` 失敗時只 push warning 而不拋錯，那則訊息先前只存在記憶體。放進既有的 `data` 即可，**不需 schema 變更**。

### 3. 步驟 `data` 白名單持久化

`processing-result-persistence.service.ts` —— 新增 `STEPS_WITH_PERSISTED_DATA`（`FILE_PREPARATION`、`REFERENCE_NUMBER_MATCHING`、`EXCHANGE_RATE_CONVERSION`），兩個轉換函式各加一行條件透傳，並更新 JSDoc 記錄白名單理由。

### 刻意**不**做的兩件事

| 項目 | 為何不做 |
|---|---|
| 加 `pdfjs-dist` 到 `serverExternalPackages` | 修復缺陷**不需要**它（改動 1 已解決）。它只能消掉那 27 MB 體積，屬副作用而非缺陷；而 `src/` 下無任何靜態 import `pdfjs-dist`，加了要另行驗證 react-pdf 的 SSR 路徑，且 Azure 映像**沒有頂層** `node_modules/pdfjs-dist`（只有 pdf-to-img 巢狀版），改 external 有踩空風險 |
| 改 `documents/[id]/route.ts` 的解析型別 | 原先評估「需同步」是多餘的 —— 那是結構型別、只讀 5 個欄位，多出 `data` 不會壞。UI 目前也沒有顯示 data 的需求 |

---

## 驗證結果

| 項目 | 結果 |
|---|---|
| `npm run type-check` | ✅ 通過 |
| `npm run lint` | ✅ 無 error（`new Function` 未被規則攔下） |
| `npm run test` | ✅ 392 通過 / 2 跳過（與基線一致，無回歸） |
| `npm run build` | ✅ 通過 |
| **編譯產物對照** | ✅ 修復前 `return c(54385)(b(f).href)`（stub）→ 修復後 `return Function("specifier","return import(specifier)")(b(f).href)`（原生 import）。minifier 把 `new Function` 簡化為 `Function`，語意相同 |
| **生產映像內執行** | ✅ 在 `dev-change113-20260730100145` 內跑同一機制：載入成功、`getDocument` 可用、讀到第 2 頁 2 筆 FreeText、`rot=90`、`rect` 通過過濾、文字經 `??` 正確取到 `RCIM-25-0111`／`RCIM-25-0113`（`contents` 為 undefined，fallback 到 `contentsObj.str` 成立） |

---

## 第一輪部署結果（2026-07-30 07:07 UTC）—— ⚠️ 未達標

映像 `dev-fix146-20260730145447`（來源 `d688d6b`）已上線，平台 log 逐行確認容器跑的就是它：

```
07:07:38  Pulling image ...:dev-fix146-20260730145447
07:07:45  Image ... is pulled from registry
07:07:45  Creating container with image ...:dev-fix146-20260730145447
07:07:46  Starting container: ee909446b484_...
07:07:50  ✓ Ready in 1167ms
```

之後（07:16–08:00）處理了 11 份 DHL 文件，含 3 次同一份 `DHL_RCIM250111_28699.pdf`（5 份檔案全部 2,203,891 bytes，確認是同一份含註解版）。結果：

| 訊號 | 實測 | 判讀 |
|---|---|---|
| `FILE_PREPARATION.data` | **不存在** | 持久化改動未生效 |
| `gpt_prompt` 含候選清單 | **false** | A2 仍未注入 |
| `groupSourceRef` | 仍是 8 位 `88557336`／`24097724` | A3 仍未生效 |
| `templateInstanceId` | **全部有值** | DHL 預設模板設定成功（與本 FIX 無關的另一項工作） |

### 🔴 第一輪修錯了層

`data` 未落地是**持久化層以外**的問題。真正的斷點在 `unified-document-processor.service.ts`：

```typescript
// 442-448（成功路徑）與 352-358（失敗路徑）
stepResults: v3Result.stepResults.map((sr) => ({
  step: sr.step as unknown as ProcessingStep,
  success: sr.success,
  skipped: sr.skipped,
  durationMs: sr.durationMs,
  error: sr.error,          // ← 沒有 data
})),
```

V3 的 stepResults 在轉成 `UnifiedProcessingResult` 時就把 `data` 丟了，**早於**持久化層。這是 FIX-092 同型漏接的**第三處**，而第一輪只查了持久化層就下手 —— 犯的正是本 FIX 記錄過的錯：只證明「可能」就當成「實際」。

後果不只是少一個欄位：`collectPageHints` 的 warning 也走同一條路，所以第一輪部署後**仍然沒有任何可見訊號**能說明 A2/A3 為何失效。文件裡自己寫的「Step 1：先讓訊號可見」沒做完整。

### A2/A3 為何仍失效 —— 目前無法回答

已排除：容器跑舊映像（平台 log 否證）、檔案不同（5 份位元組數全同）。

`FILE_PREPARATION.durationMs` 曾被考慮當替代訊號，但對照後**無法分辨**：

| 映像 | durationMs |
|---|---|
| CHANGE-113（三項全失效） | 8365 |
| FIX-146 第一輪 | 8398 / 9484 |

差異落在噪音範圍內。（07-22 那兩次的 28140 / 32232 ms 不可比 —— 當時 App Service 還是 B1 規格，7/23 才升 B3。）

---

## 第二輪修復（已實作）

| # | 檔案 | 內容 |
|---|---|---|
| 4 | `unified-document-processor.service.ts` | 兩處 `stepResults.map` 加入 `data: sr.data` 透傳（成功與失敗路徑） |
| 5 | `pdf-converter.ts` | `collectPageHints` 的 catch 加 `console.error`（帶 stack）—— warning 的落地依賴多層透傳，log 是最短路徑 |

改動 5 的用意：下一輪部署後，若 `collectPageHints` 仍失敗，容器 log 會**直接**顯示原因與 stack，不必再依賴 DB 落地、也不必再猜。

驗證：`type-check` ✅、`test` 392 通過 / 2 跳過 ✅、`build` ✅、`lint` 無新增 error（`pdf-converter.ts:122` 的 `PageConversionResult` 未使用是 `2ae2bb8`／CHANGE-021 引入的既有 dead code，依 H3 不動）。

---

## 第二輪部署結果（2026-07-30 09:19 UTC）—— 診斷目標達成

映像 `dev-fix146r2-20260730170712`（來源 `e16b5eb`）上線，平台 log 確認容器跑的就是它。

### 訊號終於可見了

容器 log：

```
09:34:22  [pdf-converter] collectPageHints failed: TypeError: a is not a function
09:34:22      at async h.collectPageHints (.next/server/chunks/54429.js:165:16672)
```

`FILE_PREPARATION.data`（已落地）：

```json
{
  "warnings": ["讀取 PDF 註解／文字方向失敗（不影響轉檔）：a is not a function"],
  "pageCount": 2, "imageCount": 2,
  "rotatedPages": [], "annotationCount": 0
}
```

`stepsWithData` = `["FILE_PREPARATION", "REFERENCE_NUMBER_MATCHING", "EXCHANGE_RATE_CONVERSION"]` —— 白名單如預期運作，三階段的完整結果沒有被重複寫進 `pipelineSteps`。

第二輪的兩項改動都生效：透傳修好了、log 也有了。A2/A3 仍未生效（本輪不聲稱修好）。

---

## 🔴 真正的根因：失敗發生在第一輪修的那一行**之前**

`TypeError: a is not a function`。對照編譯產物：

```js
let {createRequire:a}=await Promise.resolve().then(c.t.bind(c,98995,23)),
    ...
    e=a(d(process.cwd(),"package.json")),   // ← a 是 undefined
```

`a` 就是 `createRequire`。webpack 把 `await import('node:module')` 轉成 `c.t` 包裝的假 namespace，**具名解構取到 undefined**。

執行流程因此在 `createRequire(...)` 就拋錯，**根本走不到**第一輪修的 `import(pdfjsPath)`。第一輪修的 stub 確實也是真問題（產物確實是 stub），但它從來不是第一個失敗點 —— 這是「只看編譯產物的字面、沒有執行訊號」時的盲區。

> **教訓**：讀編譯產物能證明「這一行會失敗」，不能證明「這是最先失敗的那一行」。要判斷執行順序，必須有 runtime 訊號。

---

## 第三輪修復（已實作）

| # | 檔案 | 內容 |
|---|---|---|
| 6 | `pdf-converter.ts` | 三個內建模組改用 `process.getBuiltinModule('node:module'／'node:url'／'node:path')` —— 它不是 import/require 語法，打包器不會介入 |

編譯產物確認：

```js
static async loadPdfjs(){
  let {createRequire:a}=process.getBuiltinModule("node:module"),
      {pathToFileURL:b}=process.getBuiltinModule("node:url"),
      {join:c}=process.getBuiltinModule("node:path"),
      d=a(c(process.cwd(),"package.json")),
      e=d.resolve("pdfjs-dist/legacy/build/pdf.mjs",{paths:[d.resolve("pdf-to-img")]});
  return Function("specifier","return import(specifier)")(b(e).href)
}
```

`process.getBuiltinModule` 原樣保留 3 處、無 `c.t.bind` 包裝、無 stub。同一 chunk 內 `paintAnnotations` 的 `c.t.bind(c,28183,23)` 仍在，正好是對照組 —— 只有改過的三處脫離了 webpack 包裝。

環境支援：本地 Node v25.2.1、映像 Node 26 皆有 `process.getBuiltinModule`（Node 22.3+），`@types/node` 20.19.27 已含型別。

### 這一輪多做了一件事：用編譯產物的逐字形式做 runtime 實測

前兩輪的教訓是「產物看起來對」不等於「執行起來對」。所以這次把編譯後的 minified 形式逐字複製成獨立腳本，在真實 Node 中執行：

```
resolved path = ...\node_modules\pdf-to-img\node_modules\pdfjs-dist\legacy\build\pdf.mjs
getDocument   = function
numPages      = 2
  page 2: "RCIM-25-0111" rot=90
  page 2: "RCIM-25-0113" rot=90
```

整條鏈（取內建模組 → resolve → 原生 import → 讀註解）都通。

驗證：`type-check` ✅、`test` 392 通過 / 2 跳過 ✅、`build` ✅、`lint` 無 error。

### 下一輪部署後要確認

1. 容器 log **不再**出現 `[pdf-converter] collectPageHints failed:`
2. `FILE_PREPARATION.data.annotationCount` = **2**
3. `rotatedPages` 非空（第 2 頁 90 度）
4. `gpt_prompt` 含 `Shipment Group Candidates` 段落
5. `groupSourceRef` 變成 10 位（`8365573366` / `2407071774`）

---

## 附帶發現（獨立缺口，本 FIX 不處理）

Stage 3 的 Output Format 段落中，`lineItems` 的 JSON schema **沒有 `groupKey` / `groupSourceRef` 欄位**（見實際 prompt 第 58-67 行）。模型是靠 prompt 文字敘述（第 18-29 行）才填這兩個值的，schema 段落未同步。目前可運作，但缺少 schema 層的約束。

---

## 不在本 FIX 範圍

| 項目 | 為何不併 |
|---|---|
| Azure 上 DHL 沒有預設模板配置，文件不會自動建模板實例（`template_instance_id` 為 null） | 屬設定問題，非程式缺陷；本地亦同 |
| `EXPAND` 模式未實作 | CHANGE-113 階段二範圍 |
| FIX-145（`prompt-assembly.service.ts` 用不存在的 `cityCode` 查公司） | 獨立缺陷，已有文件 |

---

## 相關

- CHANGE-113 — 本缺陷所屬功能；階段一 A1/A2/A3 的驗證需補 production build 一輪
- FIX-079 / FIX-080 / FIX-081 / FIX-083 — 同一類「Next standalone／webpack 對動態依賴處理不當、部署才爆」的前例
- FIX-092 — 同類型的靜默漏接（`referenceNumberMatch` 因持久化路徑漏欄位而永遠為 null）
- FIX-145 — 同期在 CHANGE-113 實測中發現的另一個靜默降級缺陷
