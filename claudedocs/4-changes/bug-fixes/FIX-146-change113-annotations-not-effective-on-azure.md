# FIX-146: CHANGE-113 的 A1/A2/A3 在 production build 全部失效（webpack 把 pdfjs 的動態 import 換成必然拋錯的 stub）

> **建立日期**: 2026-07-30
> **發現方式**: CHANGE-113 階段一部署到 Azure DEV 後，以同一份 DHL 文件重跑，比對本地與 Azure 的結果
> **根因確認方式**: 拉下線上映像，直接讀 `.next` 編譯產物
> **影響範圍**: `src/services/extraction-v3/utils/pdf-converter.ts`（`loadPdfjs`）、`next.config.ts`、`src/services/processing-result-persistence.service.ts`
> **優先級**: 高（CHANGE-113 階段一的三項機制在任何 production build 上都無效）
> **狀態**: ⏳ 待實作

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

## 併修缺陷：`pipeline_steps` 持久化時丟棄 `data`

CHANGE-113 為「可事後查證」而寫入的 `annotationCount` / `rotatedPages`（`extraction-v3.service.ts:354-360`）**從未落地**。兩條路徑的轉換函式都只保留 4-6 個欄位、不含 `data`：

- `processing-result-persistence.service.ts:217-224`（主路徑實際使用）
- `processing-result-persistence.service.ts:528-534`（V3.1 路徑）

Azure 該筆的 `pipeline_steps` 實際內容證實了這點 —— 每個步驟只有 `step` / `success` / `durationMs`（`FILE_PREPARATION` 為 8365 ms）。

範圍比原先描述的更大：**任何步驟的 `data` 都不曾落地**，不限於 CHANGE-113 加的兩個欄位。`conversionResult.warnings` 同樣沒有持久化欄位 —— 那則本可直接指出根因的 warning，就是這樣消失的。

診斷成本因此高昂：本次得拉下映像、逐一排除 7 個假設、最後讀編譯產物才定案。

---

## 修復方向（待評估）

### 缺陷一：讓 `import()` 不被 webpack 改寫

| 選項 | 做法 | 待確認 |
|---|---|---|
| A | `new Function('u', 'return import(u)')(url)` | webpack 無法分析 `new Function` 內容，最直接對症；需確認 ESM 載入在 standalone 正常 |
| B | 加 `pdfjs-dist` 到 `serverExternalPackages` | 對**變數** specifier 的 `import()` 可能無效 —— webpack 看到的是變數，不是套件名。需實測 |
| C | 改載 pdfjs 的 CJS build，用 `createRequire().require()` | 需確認該版本有可用的 CJS 入口 |
| D | 改用 `pdf-to-img` 已載入的 pdfjs 實例 | 需確認它有對外導出 |

選項 A 最可能有效，B 應一併加上（能讓 webpack 不把 pdfjs bundle 進 chunks，順帶消掉那 27 MB）。

### 缺陷二：讓步驟 `data` 與 `warnings` 落地

| 選項 | 說明 | 待確認 |
|---|---|---|
| A | 兩個轉換函式加入 `data` 透傳 | JSON 體積成長；`documents/[id]/route.ts:259` 的解析型別需同步 |
| B | 只針對 `FILE_PREPARATION` 白名單透傳 | 較保守，但下次別的步驟要查證時又要再改 |
| C | 另加欄位存 `warnings` | 屬 schema 變更，需走 `apply-schema-drift.js` 流程 |

### 🔴 驗證要求

**必須用 production build 驗證，不可只用 `npm run dev`。** 這個缺陷在 dev 模式下完全不會出現 —— 用 dev 驗證等於沒驗證。最低標準：本地 `npm run build && npm start` 跑通同一份 DHL 文件，確認 `annotationCount` > 0 且 `rotatedPages` 非空。

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
