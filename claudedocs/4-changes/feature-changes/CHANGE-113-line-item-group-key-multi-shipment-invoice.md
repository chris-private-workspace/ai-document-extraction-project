# CHANGE-113: 一份發票對應多個 Shipment —— 註解可見性、行項目分組鍵與模板三模式輸出

> **日期**: 2026-07-29
> **狀態**: 🚧 進行中（階段一 A + B 完成並通過本地實測 2026-07-29；階段二待實作）
> **優先級**: High
> **類型**: Feature Enhancement
> **影響範圍**: PDF 轉換層、提取層（LineItemV3、Stage 3 Schema）、模板匹配引擎、DataTemplate Model、DataTemplate UI
> **合併**: 本 CHANGE 併入並取代 [CHANGE-044](CHANGE-044-line-item-hybrid-dual-mode.md)（Line Item Hybrid 雙模式，⏳ 待實作）
> **相關**: [CHANGE-043](CHANGE-043-line-item-pivot-flatten.md)（Pivot 展平，已完成）、[CHANGE-048](CHANGE-048-ref-number-as-row-key.md)（Ref Number 作 rowKey，⏳ 待實作）
> **觸發事件**: 2026-07-29 使用者回報 DHL 發票格式 —— 一份發票對應多個 shipment，明細在後頁橫向表格

---

## 變更背景

### 問題場景

DHL 的發票第 2 頁是橫向明細表，**一份發票包含多個 shipment**。以 `DHL_RCIM250111_28699.pdf`（invoice `HKGR008328699`）為例：

| Air Waybill Number | 對應 shipment | Standard Charge | Fuel Surcharge | 小計 |
|---|---|---|---|---|
| 8365573366 | RCIM-25-0111 | 247.50 | 69.92 | **317.42** |
| 2407071774 | RCIM-25-0113 | 2,310.00 | 652.58 | **2,962.58** |
| | | | 合計 | 3,280.00 |

期望產出是**兩列**，各自帶自己的費用合計。

### 五個阻斷點

| # | 層 | 位置 | 現況 |
|---|---|---|---|
| 1 | **可見性** | `pdf-converter.ts` | shipment 號碼是**無 appearance stream 的 FreeText 註解**，渲染成圖像時只畫出紅框、不畫文字 —— GPT 根本看不到（詳見下節實測） |
| 2 | 提取 | `extraction-v3.types.ts:268` | `LineItemV3` 沒有任何欄位可表示「這筆屬於哪個 shipment」 |
| 3 | 展平 | `transform/aggregate.transform.ts:159` | `AggregateTransform` 從 `context.lineItems` 讀**整份文件**的行項目 |
| 4 | 參考編號 | `reference-number-matcher.service.ts:77-85` | 只讀**檔名**、不看內文；`_ref_number` 只取第一筆 |
| 5 | 模板 | `template-matching-engine.service.ts:389-431` | `for (const doc of documents)` 搭配回傳單一字串的 `extractRowKey()` → **一份文件恰好一列** |

資料表同樣是單向設計：`TemplateInstanceRow.sourceDocumentIds` 是陣列（多份文件併一列），但沒有反方向的一對多；`ExtractionResult.documentId` 是 `@unique`。

**未修復前的實際後果**：該文件會產生**一列**，`rowKey` = `RCIM250111`（來自檔名），金額 3,280 全數掛在 RCIM-25-0111 名下，RCIM-25-0113 整筆消失，且不會有任何錯誤提示。

---

## 實測證據（2026-07-29）

使用者提供三份真實 DHL 文件。以系統實際使用的 `pdf-to-img`（dpi 200）渲染 + pdfjs 讀取註解結構，結果如下。

### 阻斷點 1 的直接證據

`DHL_RCIM250111_28699.pdf` 第 2 頁渲染出的圖像上，兩個紅色方框都在，**框內文字完全不存在**。註解結構顯示：

```
subtype: "FreeText", contents: "RCIM-25-0111", hasAppearance: false, titleObj: "LLi01"
subtype: "FreeText", contents: "RCIM-25-0113", hasAppearance: false, titleObj: "LLi01"
文字層項目數: 0
```

`hasAppearance: false` 是關鍵 —— 註解沒有外觀流（/AP），pdfjs 在 canvas 上不知道該怎麼繪製文字，只畫了邊框。Chrome 的 PDF 檢視器會自行生成外觀，所以使用者看得到、系統看不到。

該頁**文字層為 0 項**（整張表格都是圖像），所以號碼既不在圖像裡、也不在文字層 —— **OCR 與視覺辨識都不可能取得**。

### 三份文件的註解實況

| 檔案 | FreeText 註解內容 | 文字層項目 |
|---|---|---|
| `DHL_RCIM250111_28699.pdf` | `RCIM-25-0111`、`RCIM-25-0113` | 0 |
| `DHL_RCIM250119_13447.pdf` | `RHIM/25/0097`、`（空字串）`、`RCIM/25/0119` | 102 |
| `DHL_RCIM250246_94867.pdf` | `RHIM/25/0202\r`、`RCEX-25-0479 PDI`、`RCIM/25/0246\r`、`RCEX-25-0483\r` | 171 |

全部 `hasAppearance: false`。格式差異整理：

| 面向 | 觀察到的變體 |
|---|---|
| 前綴 | `RCIM` / `RHIM` / `RCEX` |
| 分隔符 | 連字號 `RCIM-25-0111`、斜線 `RCIM/25/0246` |
| 雜訊 | 結尾 `\r`、後綴 ` PDI`、完全空白的註解 |
| 註解作者 | `LLi01`、`FLo01`、`KLam06`、`GIp`（四人各自補註，格式自然不統一） |

**參考編號主檔的格式是統一的**（`RCIM250111`、`RCIM250113`、`RCIM250119`、`RCIM250246` 均存在且為 `SHIPMENT` 型、`ACTIVE`）。因此只要把註解文字去除非英數字元後丟給既有的 `findMatchesInText()`，即可對到主檔並取回標準格式 —— 格式不一致的問題由既有機制順帶解決，不需要在程式裡寫死格式規則。

### 本地 DHL 設定現況

| 項目 | 現況 |
|---|---|
| 公司 | `DHL Express`（`eedf4065-…`，ACTIVE） |
| 欄位定義集 | `DHL Express - 自訂費用欄位集`，**僅 2 欄**：`express_worldwide_doc`、`express_worldwide_nondoc`（皆 `fieldType: lineItem`） |
| 模板映射 | Inbound / Outbound 各 **2 條規則** |
| 已上傳文件 | 5 份，**全部失敗**（2 份 `OCR_FAILED`、3 份 `REF_MATCH_FAILED`），無成功樣本 |

現有 Inbound 映射規則：

```
_ref_number              → shipment_number   (DIRECT)
express_worldwide_nondoc → freight           (DIRECT)
```

---

## 變更內容

### 階段一 A：讓分組資訊變成模型看得到的內容（待實作）

#### A1. 渲染時補畫無 appearance 的 FreeText 註解

`pdf-converter.ts` 在轉出頁面圖像後，將 `hasAppearance: false` 的 FreeText 註解文字繪製到圖像上對應的 `rect` 位置，讓 GPT 看到的畫面與使用者在 PDF 檢視器中看到的一致。

- 座標需經 `page.getViewport({ scale, rotation })` 轉換（DHL 明細頁為橫向旋轉頁）
- 疊加以 `sharp` 進行（專案既有依賴，`pdf-converter` 已用於壓縮）
- 僅補畫 `hasAppearance: false` 者；有外觀流的註解由 pdfjs 正常繪製，不重複疊加
- 空白 `contents` 直接略過

> 這是**通用修正**而非 DHL 專屬 —— 任何以註解形式補充資訊的文件都受益。原本被靜默丟失的補註資訊，此後都會進入模型視野。

#### A2. 將註解對應到的主檔號碼注入 Prompt 作為候選清單

抽出全部 FreeText 註解 → 去除非英數字元 → 丟給 `findMatchesInText()` 對主檔 → 把命中的**標準格式號碼**作為候選清單注入 Stage 3 Prompt。

- **不在程式中寫死前綴白名單**：`RCIM` / `RHIM` / `RCEX` 全部拿去對主檔，對得到就是合法候選。主檔已是權威來源且已區分 type，日後新增前綴不需要改程式（使用者 2026-07-29 決定）
- GPT 因此**只能從合法清單中選**，不會自行編造或原樣寫回 `RCIM/25/0246` 這類非標準格式

兩者搭配的理由：A1 給 GPT **視覺位置**（判斷哪個框對應哪一列），A2 給 GPT **合法值域**（保證輸出格式正確）。單靠任一項都不夠。

### 階段一 B：提取層帶分組鍵（✅ 已完成 2026-07-29）

#### B1. `LineItemV3` 新增兩個可選欄位

```typescript
groupKey?: string;        // 該筆費用所屬的 shipment / 參考號
groupSourceRef?: string;  // 該組的文件原生單號（DHL = Air Waybill Number）
```

**兩個都抓的原始理由**：`groupKey` 來自人工補註，可能漏標或標錯位置；`groupSourceRef`（AWB）是 DHL 原生印刷，推測 OCR 穩定度較高，可在 `groupKey` 讀不到時作為備援分組依據。

> 🔴 **2026-07-29 實測推翻了這個推測**，見 §階段一實測結果。`groupSourceRef` 三次讀出三個不同的值、且多數錯誤；`groupKey` 三次完全一致且正確。**`groupSourceRef` 不得用於自動分組**，僅保留作為人工核對線索。

#### B2. GPT 輸出結構同步

Stage 3 的 structured output schema 由 `stage-3-extraction.service.ts` 的 `generateOutputSchema()` 動態產生，在其 `lineItems.items.properties` 加入兩個欄位，**不列入 `required`**。

> ⚠️ 規劃初稿誤指為 `prompt-builder.ts` 的 `generateJsonSchema()` —— 該處是 **V3 單階段**路徑的 schema，現行 V3.1 三階段不走它。已於實作時更正。

#### B3. 行項目轉換必須明確透傳

`convertRawLineItems()` 是「逐欄位重建物件」的實作，**未明確列出的欄位一律被靜默丟棄**。新欄位若只加在型別與 schema，GPT 會回傳、值卻永遠到不了資料庫 —— 這正是 FIX-092 `referenceNumberMatch` 的漏接模式（不拋錯、型別不報）。已加上透傳與 `normalizeGroupToken()`，並以單元測試釘死。

---

### 階段二：模板層按分組展開（設計已修正，待實作）

> 前置條件：階段一 A + B 驗證通過（GPT 能穩定逐列填對分組鍵）。

#### 原規劃的三個缺口

2026-07-29 查閱本地 DHL 實際設定後發現，原規劃的「只把 `lineItems` 換成該組子集」**不足以產出正確結果**：

| # | 缺口 | 後果 |
|---|---|---|
| 1 | 映射規則 `_ref_number → shipment_number` 引用的是**檔名匹配的單一值** | 拆成兩列後，兩列的 `shipment_number` 都會是 `RCIM250111` |
| 2 | 欄位定義集沒有 fuel surcharge 欄位，映射為 `DIRECT` | `freight` 只會拿到 247.50，少了燃油 69.92，達不到期望的 317.42 |
| 3 | `DIRECT` 映射引用的 field def key（`express_worldwide_nondoc`）取自 `fields` —— 那是 `backfillLineItemCharges` 產生的**文件層級**回填結果 | 兩列拿到同一個文件層級數字。只換 `lineItems` 子集僅對 `AGGREGATE` 型映射有效 |

#### 修正後的設計：分組提前到回填之前

`GROUP` 模式下，每一組都走完整的「組 lineItems → 組 fields → 映射」流程，而不是只在映射時替換 `lineItems`：

```
文件
 └─ 依 groupKey 分組 lineItems（缺 groupKey → 整份視為一組；**不得**改用 groupSourceRef）
     └─ 每組產生一個待寫入單元：
         ├─ 組 fields   = 文件層級的非費用欄位（invoice_number / invoice_date / currency …）
         │                + 對「該組 lineItems」重跑 backfillLineItemCharges 得到的費用欄位
         ├─ 組 _ref_*   = 該組分組鍵正規化後對主檔命中的標準號碼
         ├─ 組 lineItems = 該組子集（供 AGGREGATE 型映射）
         └─ rowKey      = 組 _ref_number
```

這個順序一次解決三個缺口：

- **缺口 1**：`_ref_number` 在 `GROUP` 模式下變成**組層級**的值，既有映射規則 `_ref_number → shipment_number` **完全不用改**，自動變成每列各自的號碼
- **缺口 3**：費用欄位在組層級重新回填，`DIRECT` 映射引用 field def key 時取到的就是該組的值
- **缺口 2**：屬資料設定範疇（見下），但組層級回填讓 `AGGREGATE` 型映射也能正確運作

> `AggregateTransform` 本身**完全不需要修改** —— 它從 `context.lineItems` 讀什麼就聚合什麼。分組責任留在呼叫端，聚合器維持單一職責。

#### 缺口 2 的處理（資料設定，非程式碼）

DHL 欄位定義集需補上燃油附加費欄位，且 `freight` 的映射需改為涵蓋「標準費用 + 燃油」的加總（`FORMULA` 或組層級 `AGGREGATE`）。此項不論階段二怎麼實作都必須做，與程式碼無關。

#### `DataTemplate` 新增 `lineItemMode`

```prisma
lineItemMode String @default("PIVOT") @map("line_item_mode")
```

| 值 | 語意 | 來源 |
|---|---|---|
| `PIVOT` | 1 份文件 = 1 列，費用按 `classifiedAs` 聚合為欄（現況） | CHANGE-043 |
| `EXPAND` | 1 筆費用 = 1 列（審計逐筆核對用） | 原 CHANGE-044 |
| `GROUP` | 1 個分組鍵 = 1 列，組內費用再 pivot 成欄 | 本 CHANGE |

#### `extractRowKey()` 與 CHANGE-048 的協調

優先序：**組 `_ref_number`（GROUP 模式）> 文件 `_ref_number`（CHANGE-048）> `rowKeyField` > 時間戳**。CHANGE-048 實作時需沿用。

---

## 技術設計

### 修改範圍

| 階段 | 檔案 | 動作 | 變更內容 |
|---|---|---|---|
| 一A | `src/services/extraction-v3/utils/pdf-converter.ts` | 🔧 修改 | 補畫 `hasAppearance: false` 的 FreeText 註解；輸出註解清單 |
| 一A | Stage 3 Prompt 組裝路徑 | 🔧 修改 | 注入對到主檔的候選號碼清單 |
| 一B ✅ | `src/types/extraction-v3.types.ts` | 🔧 修改 | `LineItemV3` 加 `groupKey?` / `groupSourceRef?` |
| 一B ✅ | `src/services/extraction-v3/stages/stage-3-extraction.service.ts` | 🔧 修改 | `generateOutputSchema()` 加兩欄位；`convertRawLineItems()` 透傳；`normalizeGroupToken()` |
| 一B ✅ | `tests/unit/services/stage-3-line-item-group-key.test.ts` | 🆕 新增 | 釘住透傳行為（7 案例） |
| 二 | `prisma/schema.prisma` | 🔧 修改 | `DataTemplate.lineItemMode` + migration |
| 二 | `src/services/template-matching-engine.service.ts` | 🔧 修改 | `processBatch()` 分組展開、組層級回填與 `_ref_*` 注入、`extractRowKey()` 優先序 |
| 二 | `src/types/template-matching-engine.ts` | 🔧 修改 | options 加模式參數 |
| 二 | `src/services/data-template.service.ts` | 🔧 修改 | CRUD 帶 `lineItemMode` |
| 二 | DataTemplate 表單組件 + `messages/{en,zh-TW,zh-CN}/*.json` | 🔧 修改 | 模式選擇器 + 三語言字串 |

**不需修改**：`src/services/transform/aggregate.transform.ts`。

### 資料庫影響

階段一無。階段二新增 `data_templates.line_item_mode`（有預設值、向後相容）。

> ⚠️ 依 [[feedback_azure_migration_needs_schema_drift_entry]]：Azure 容器啟動流程**不執行** `migrate deploy`，PR 內的 migration 對非空的 Azure 資料庫無效。階段二部署前必須把此 DDL 轉為冪等寫法加進 `prisma/apply-schema-drift.js` 的 `MIGRATIONS`，並帶 `RUN_SCHEMA_DRIFT_FIX=true` 執行一次，否則新程式碼讀取新欄位會出現 P2022。

---

## 階段一實測結果（2026-07-29，本地真實提取）

對 `DHL_RCIM250111_28699.pdf` 跑完整 V3.1 三階段、連續三次。

### 分組成功

| groupKey | 費用組成 | 合計 | 期望值 |
|---|---|---|---|
| `RCIM-25-0111` | EXPRESS WORLDWIDE nondoc 247.50 + FUEL SURCHARGE 69.92 | **317.42** | 317.42 ✅ |
| `RCIM-25-0113` | EXPRESS WORLDWIDE nondoc 2310.00 + FUEL SURCHARGE 652.58 | **2962.58** | 2962.58 ✅ |

四筆行項目全部帶對 `groupKey`，且未把「Service Sub Total」「Total: HKD」等彙總列誤當成行項目。三次結果完全一致。

### 🔴 `groupSourceRef` 不可靠 —— 原假設被推翻

| 次數 | 第一組 AWB | 第二組 AWB |
|---|---|---|
| 1 | `88557336` | `24097724` |
| 2 | `8365573366` ✅ | `240977124` |
| 3 | `88557336` | `24097724` |

正確值為 `8365573366` 與 `2407071774`，六次讀取僅一次正確，且三次結果互不相同。

**原因**：AWB 是 10 位數字、小字級、帶超連結底線；`groupKey` 經階段一 A 補畫為 40px 粗體紅字，清晰度遠高於原生印刷內容。**人工補註反而比原生印刷更容易被正確辨識** —— 與規劃時的推測完全相反。

**設計影響**：`groupSourceRef` 若用於分組，同一份文件每次重跑會分出不同的組，比不分組更糟。因此階段二的分組只依 `groupKey`，缺失時整份視為一組。`groupSourceRef` 僅保留供人工核對。

### 需要 DHL 專屬 Prompt —— §1.4 的問題已有答案

只靠 structured output 的 schema `description`（未建 DHL Prompt 前）：

| 嘗試 | lineItems | 說明 |
|---|---|---|
| 1 | 1 筆，amount 2557.50 | 讀成 Service Sub Total 的標準費用合計 |
| 2 | 1 筆，amount 3280.00 | 改讀 Total: HKD |
| 3 | 1 筆，amount 2557.50 | 又跳回小計 |

不但沒有分組，連明細表都沒逐列拆，且在兩個錯誤答案間跳動。**schema description 不足**，必須有 DHL COMPANY 層的 Stage 3 Prompt 明確指示「逐列提取、排除彙總列、填寫分組鍵」。

Prompt 已建立於本地：`prompt_configs.id = 'change113-dhl-stage3-001'`（COMPANY scope、`OVERRIDE`）。**Azure 尚未建立，部署前必須一併套用。**

### ⚠️ 測試陷阱：ExtractionV3Service 的 flags 不讀環境變數

```typescript
// extraction-v3.service.ts:152
this.flags = { ...DEFAULT_EXTRACTION_V3_FLAGS, ...config.flags };
// DEFAULT_EXTRACTION_V3_FLAGS.useExtractionV3_1 === false
```

env 的 `FEATURE_EXTRACTION_V3_1=true` **不會**被這裡讀到 —— 生產是由 `unified-document-processor` 讀 env 後傳入 `config.flags`。直接呼叫 `processFileV3()` 而不傳 flags，會靜默跑 **V3 單階段**，且照樣回報 `success=true`。

本次前四輪實測都因此測在錯誤路徑上（V3 單階段不走 Stage 3，本 CHANGE 的 schema 與 Prompt 全部沒生效）。任何繞過 `unified-document-processor` 的提取測試都必須明確傳入 flags。

---

## 設計決策

1. **分組鍵設為可選欄位** —— 只有多 shipment 的發票會填。設為必填會迫使 GPT 為單一 shipment 的發票編造分組鍵。

2. **補畫註解採通用實作，不做 DHL 專屬判斷** —— 「註解沒有 appearance stream 就畫不出來」是渲染層的普遍缺陷，不是 DHL 的特殊需求。

3. **候選清單來自主檔比對，不寫死前綴白名單** —— 使用者 2026-07-29 決定。主檔是權威來源且已區分 type，新增前綴不需改程式。

4. **同時抓 `groupKey` 與 `groupSourceRef`** —— 見 §B1。使用者 2026-07-29 確認。

5. **分組提前到回填之前，而非只替換 `lineItems`** —— 見階段二。原設計只對 `AGGREGATE` 有效，對實際在用的 `DIRECT` + field def key 無效。

6. **三模式一次定義，合併 CHANGE-044** —— 三種模式共用同一個欄位與同一段分列邏輯，分開實作會導致先做完的一方被重構。

7. **強制分階段，前階段驗證通過才動後階段** —— 依 [CHANGE-094](CHANGE-094-line-item-charge-extraction-stability.md) 的教訓：GPT 對費用歸戶的判斷本身就不確定。分組判斷難度更高，且錯誤後果是**金額掛到錯誤的 shipment**，比欄位空白嚴重得多。

---

## 已知風險

| # | 風險 | 嚴重度 | 說明與緩解 |
|---|---|---|---|
| 1 | ~~PDF 註解層可能渲染不出來~~ | — | **已於 2026-07-29 證實成真**，並確立解法（階段一 A）。不再是未知風險 |
| 2 | 補畫座標對不準（頁面旋轉 / 座標系轉換） | 高 | 以 `getViewport({ scale, rotation })` 轉換；實作後逐份目視比對渲染圖與 PDF 檢視器畫面 |
| 3 | GPT 分組判斷不穩定 | 高 | 同一文件連跑 3 次比對；不穩定則加強 Prompt 或改用座標對應的確定性後處理 |
| 4 | 人工標註格式不一致 | 中 | **已實測確認存在**（4 位作者、3 種前綴、2 種分隔符、`\r` 與後綴雜訊）。以正規化 + 主檔比對吸收 |
| 5 | 註解與表格列的對應關係不明確 | 中 | 檔案 3 有 4 個註解、混含 `RHIM`/`RCEX`，非單純順序對應。靠 A1 的視覺位置 + A2 的候選清單交由 GPT 判斷；若不穩定則升級為座標對應 |
| 6 | 檔名 ref match 只匹配得到第一個 shipment | 中 | `refMatchEnabled` 開啟時匹配不到即中止流程（`reference-number-matcher.service.ts:106`）。階段二改用組層級分組鍵可繞過，但該判斷邏輯本身需一併評估 |
| 7 | 既有 Template Instance 混用模式 | 低 | 切換模式後既有列不會自動重算，需重新執行模板匹配 |

---

## 驗收標準

| # | 階段 | 驗收項目 | 驗收標準 | 優先級 |
|---|---|---|---|---|
| 1 | 一A | 註解可見 | `DHL_RCIM250111_28699.pdf` 渲染圖上，紅框內可見 `RCIM-25-0111` / `RCIM-25-0113` | High |
| 2 | 一A | 位置正確 | 補畫文字落在原 `rect` 範圍內，未覆蓋表格其他內容 | High |
| 3 | 一A | 候選清單 | 三份文件的註解正規化後皆能對到主檔標準號碼；空註解被略過 | High |
| 4 | 一A | 通用性不回歸 | 無註解的文件渲染結果與修改前逐位元組相同 | High |
| 5 | 一B ✅ | 透傳 | `convertRawLineItems` 保留分組欄位；空字串收斂為 undefined | High |
| 6 | 一 | 分組正確 | `stage3Result.lineItems` 每筆帶正確 `groupKey` 與 `groupSourceRef` | High |
| 7 | 一 | 穩定度 | 同一文件連續處理 3 次，分組結果完全一致 | High |
| 8 | 一 | 零回歸 | 非 DHL 文件重跑後輸出與先前完全相同 | High |
| 9 | 二 | 分組展開 | `DHL_RCIM250111_28699.pdf` 產生 2 列，rowKey 為 `RCIM250111` 與 `RCIM250113` | High |
| 10 | 二 | 組層級號碼 | 兩列的 `shipment_number` 分別為各自的號碼（驗證缺口 1 已解） | High |
| 11 | 二 | 組內金額 | 兩列的費用合計分別為 317.42 與 2,962.58（驗證缺口 2、3 已解） | High |
| 12 | 二 | 模式預設 | 既有 DataTemplate 未設定時為 `PIVOT`，輸出與現況一致 | High |
| 13 | 二 | EXPAND 模式 | 1 筆費用產生 1 列（原 CHANGE-044 需求） | Medium |
| 14 | 全 | 型別 / 規範 / i18n | `type-check`、`lint`、`i18n:check` 通過 | High |

---

## 測試場景

| # | 場景 | 測試步驟 | 預期結果 |
|---|---|---|---|
| 1 | 註解補畫 | 渲染三份 DHL PDF，目視檢查 | 全部 FreeText 內容可見且位置正確 |
| 2 | 空註解 | `DHL_RCIM250119_13447.pdf`（含一個空 `contents`） | 不產生空白疊加、不報錯 |
| 3 | 混合前綴 | `DHL_RCIM250246_94867.pdf`（`RHIM`/`RCEX`/`RCIM`） | 全部對到主檔者皆入候選清單 |
| 4 | 分組提取 | 重新處理 `DHL_RCIM250111_28699.pdf`，檢視 Stage 3 原始回應 | 4 筆行項目分屬兩個 `groupKey`，各帶對應 AWB |
| 5 | 穩定度 | 同一文件連跑 3 次 | 3 次分組結果一致 |
| 6 | 單一 shipment 回歸 | 重跑 Nippon / CEVA 既有文件 | 分組欄位為空，其餘輸出與先前一致 |
| 7 | GROUP 模式 | DataTemplate 設為 `GROUP`，加入 DHL 文件 | 2 列，shipment_number 與金額均正確 |
| 8 | PIVOT 回歸 | 既有模板實例加入文件 | 行為與現況完全相同 |
| 9 | 分組鍵缺失 | 移除部分 `groupKey` 後執行 GROUP 模式 | 落回 `groupSourceRef`；兩者皆無則整份併為一組 |
| 10 | 多文件同分組鍵 | 兩份文件含相同 shipment 號碼 | 合併為同一列（`sourceDocumentIds` 含 2 個 ID） |

---

## 實施計劃

| 階段 | 內容 | 出口條件 |
|---|---|---|
| 一B ✅ | 型別 + Schema + 透傳 + 測試 | 已完成（驗收 5） |
| 一A | 註解補畫 + 候選清單注入 | 驗收 1-4 通過 |
| — | **檢查點：本地重跑 DHL 文件，確認分組穩定度** | 驗收 6-8 通過，使用者確認 |
| 二 | Prisma 欄位 + 分組展開 + 組層級回填 + UI/i18n | 驗收 9-14 通過 |
| — | **本地端到端：模板實例產出兩列、金額正確** | 使用者確認後才部署 |

階段一若因風險 #2、#3 無法達標，**不進入階段二** —— 改回報並重新評估（例如升級為座標對應的確定性方案）。

---

## 回滾計劃

| 階段 | 回滾方式 |
|---|---|
| 一A | 註解補畫為渲染層的附加步驟，移除即回到原輸出（無註解文件本就不受影響） |
| 一B | 欄位為可選。已提取的分組資料留在 `stage3Result`，不影響任何下游 |
| 二 | 將 `lineItemMode` 改回 `PIVOT` 並重新執行模板匹配。欄位有預設值，保留不移除亦無影響 |

---

## 相關

- CHANGE-043 — Line Item Pivot 展平（已完成，本 CHANGE 的 `PIVOT` 模式即其成果）
- CHANGE-044 — Line Item Hybrid 雙模式（**已併入本 CHANGE**）
- CHANGE-048 — Ref Number 作 rowKey（rowKey 優先序需協調）
- CHANGE-094 — 費用提取穩定性（分階段的依據）
- FIX-092 — `referenceNumberMatch` 未持久化（§B3 漏接模式的前例）
- FIX-144 — 已完成文件的重新處理入口（驗證流程需反覆重跑同一份文件）
