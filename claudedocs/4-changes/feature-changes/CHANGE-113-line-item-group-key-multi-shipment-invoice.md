# CHANGE-113: 一份發票對應多個 Shipment —— 註解可見性、行項目分組鍵與模板三模式輸出

> **日期**: 2026-07-29
> **狀態**: 🚧 進行中（階段一 A1/A2/A3 + B、階段二全部完成，本地端到端 + 穩定度 + 燃油映射 2026-07-29 通過。Azure 部署 2026-07-30 已執行但 **A2/A3 未生效** → 見 §Azure 部署執行結果 + **FIX-146**。`EXPAND` 模式未實作，見 §階段二實作範圍）
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

### 階段一 A：讓分組資訊變成模型看得到的內容（✅ 已完成 2026-07-29）

#### A1. 渲染時補畫無 appearance 的 FreeText 註解

`pdf-converter.ts` 在轉出頁面圖像後，將 `hasAppearance: false` 的 FreeText 註解文字繪製到圖像上對應的 `rect` 位置，讓 GPT 看到的畫面與使用者在 PDF 檢視器中看到的一致。

- 座標需經 `page.getViewport({ scale, rotation })` 轉換（DHL 明細頁為橫向旋轉頁）
- 疊加以 `sharp` 進行（專案既有依賴，`pdf-converter` 已用於壓縮）
- 僅補畫 `hasAppearance: false` 者；有外觀流的註解由 pdfjs 正常繪製，不重複疊加
- 空白 `contents` 直接略過

> 這是**通用修正**而非 DHL 專屬 —— 任何以註解形式補充資訊的文件都受益。原本被靜默丟失的補註資訊，此後都會進入模型視野。

#### A2. 將註解注入 Prompt 作為候選清單（✅ 已完成 2026-07-29）

抽出全部 FreeText 註解 → 去空白去重 → 作為封閉候選清單注入 Stage 3 systemPrompt，並附四條約束規則（逐字複製／判斷不出留空／全標或全不標／單一候選一律留空）。

實作：`buildGroupCandidateSection()`（`stage-3-extraction.service.ts`），透傳鏈為
`PdfConverter.convertToBase64` → `extraction-v3.service` → `StageOrchestrator` → `Stage3.execute`。

> 🔴 **與原規劃的兩點差異**（2026-07-29 實作時決定）
>
> 1. **不在注入前對主檔比對**。原規劃是「丟給 `findMatchesInText()` 對主檔 → 注入標準格式號碼」。改為直接注入註解原文，理由有二：
>    - `findMatchesInText()` 會遞增主檔的 `matchCount` / `lastMatchedAt`。提取可重跑，套用它會污染參考編號的匹配統計（與階段二 `resolveGroupReferenceNumbers` 不用它是同一個理由）
>    - **正規化在模板層做已經足夠**。`buildRowUnits` 本來就會把分組鍵正規化後對主檔換成標準號碼；在提取層再做一次是重複，且會讓「GPT 讀到的字串」與「使用者實際寫的字串」不一致，反而不利於除錯
>
>    實測結果相同：註解 `RCIM-25-0111` → 模板列 rowKey `RCIM250111`（主檔標準格式）。
>
> 2. **不過濾候選內容**。參考編號格式因區域而異，任何正則都可能濾掉真的號碼。無關註解留在清單中的代價很小（規則 2 要求判斷不出就留空；模板層對不到主檔時仍以原值成列）。

#### A3. 側躺頁面自動轉正（✅ 已完成 2026-07-29）

**這一項不在原規劃中** —— 是階段一實測發現 A1 補畫「有效但無用」之後追加的（使用者 2026-07-29 核准）。

實作：`detectTextRotation()`（文字層變換矩陣）+ `detectAnnotationRotation()`（掃描件備援）
→ `PdfConverter` 以 sharp 旋轉。順序為**補畫 → 轉正 → 壓縮**：補畫必須在轉正前（座標基準），
轉正必須在壓縮前（`maxWidth` 要套在最終方向上）。

- 保守設計，**寧可不轉不可轉錯**：方向混雜、可用字元太少、斜排一律回 0（維持原樣）
- 新增 `autoRotatePages` 旗標（預設 true）—— Azure 為手動重建映像，誤判時沒有旗標就得改碼
- 轉正結果寫入 `FILE_PREPARATION` 步驟資料（`rotatedPages`）
  > 🔴 **更正（2026-07-30）**：原文寫「可事後查證」是**錯的**。`processing-result-persistence.service.ts`
  > 的兩個步驟轉換函式都不保留 `data`，故 `annotationCount` / `rotatedPages` **從未寫進資料庫**。
  > 這使 A2/A3 在 Azure 未生效的問題只能繞道 Kudu 猜測。已開 **FIX-146** 追此事。

三者搭配的理由：A1 給 GPT **看得見的內容**，A3 給 GPT **看得懂的方向**，A2 給 GPT **合法值域**。缺任何一項本案都不成立 —— 見 §階段一實測結果。

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

### 階段二：模板層按分組展開（✅ 程式碼完成 2026-07-29，待端到端驗證）

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

實作上，`GROUP` 模式的 rowKey 由 `buildRowUnits()` 直接決定，不經 `extractRowKey()` —— 後者維持原樣供其餘模式使用。CHANGE-048 屆時只需在 `extractRowKey()` 內加入文件層級 `_ref_number` 的優先序，不會與本 CHANGE 衝突。

---

## 階段二實作範圍（2026-07-29 定案）

實作過程中對規劃做了三處修正，均為實作位置或手段的調整，行為規格不變。

### 修正 1：組層級回填改在 Stage 3 執行，而非模板層

**規劃原文**：「`processBatch()` 分組展開、組層級回填」——即在 `template-matching-engine.service.ts` 對每組重跑 `backfillLineItemCharges`。

**實際不可行**：該方法依賴 `FieldDefinitionSet` 的 label / aliases 比對規則（FIX-108 / FIX-126 / FIX-127 累積），而欄位定義集只在 Stage 3 的配置載入階段取得。模板層要重跑，就得把整套比對邏輯連同欄位定義集載入一起搬出來。

**改為**：Stage 3 在完成文件層級回填後，依 `groupKey` 切組並對**每組**再跑一次 `backfillLineItemCharges`，結果存進 `stage3Result.lineItemGroups`。模板層只讀取與展開。

**取捨**：分組資訊固化在提取當下，文件必須重新處理才會有。實際上沒有損失 —— `groupKey` 本身是階段一才加的欄位，任何要用 `GROUP` 模式的文件，本來就必須在階段一之後重新處理過。

### 修正 2：組 `_ref_number` 改用精確比對，不用 `findMatchesInText()`

**規劃原文**：「丟給既有的 `findMatchesInText()` 對主檔」。

**兩個問題**：該函數會遞增主檔的 `matchCount` / `lastMatchedAt`；模板匹配可重複執行，套用它會污染參考編號的匹配統計。且它是為「從一段文字裡找出號碼」設計的 ILIKE substring 查詢，而此處已握有完整號碼。

**改為**：正規化後對 `reference_numbers.number` 精確比對，一次查完整批（`resolveGroupReferenceNumbers()`）。無副作用、不需 `types` 參數、不逐組查詢。

**已知界限**：分組鍵帶額外後綴時（實測有 `RCEX-25-0479 PDI`）精確比對會落空，該列改用原始分組鍵作 rowKey。列不會消失，只是號碼不是主檔的標準格式。若日後發現後綴案例普遍，再改為 substring 比對。

### 修正 3：`EXPAND` 模式未實作

`lineItemMode` 的三個值都已定義於型別、Zod 值域與資料庫，但**只有 `PIVOT` 與 `GROUP` 有展開邏輯**。

原因：使用者本次交辦的是「分組展開 + 組層級回填 + 組層級 `_ref_number`」，三項皆屬 `GROUP`；`EXPAND`（驗收 13）為 Medium 優先級且無需求驅動。更關鍵的是，`EXPAND` 要讓每一列拿到**該筆費用**的欄位值，需要 Stage 3 為每筆行項目各產生一套 `fields` —— 目前只做到組層級。若硬用現有結構實作，每列的 field definition key 都會拿到文件層級的值，正是 H6 禁止的「看似差不多」的近似。

處置：UI 選單只提供 `PIVOT` 與 `GROUP`（`LINE_ITEM_MODE_CHOICES`），選不到 `EXPAND`。資料庫若已存在該值，行為等同 `PIVOT`。原 CHANGE-044 的需求出現時再另立工作項。

### 額外修補：分組結果的逐層透傳（FIX-092 同型漏接）

`stage3Result` 從 Stage 3 到資料庫之間有**兩處逐欄位重建**，任何未列出的欄位會被靜默丟棄：

| 位置 | 說明 |
|---|---|
| `extraction-v3.service.ts:661` | `result: { standardFields, fields, lineItems, … }` |
| `unified-document-processor.service.ts:506` | `stage3Result: { success, fieldCount, lineItems, … }` |

兩處都已補上 `lineItemGroups`，並在 `UnifiedExtractionResult` 與 `unified-processor.ts` 的 `stage3Result` 型別加上對應欄位。這正是 FIX-092 讓 `referenceNumberMatch` 永遠是 NULL 的同一條路徑 —— 不補的話，Stage 3 算好的分組永遠到不了模板層，且不會拋錯。

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
| 二 ✅ | `src/types/extraction-v3.types.ts` | 🔧 修改 | `LineItemGroupV3`；`Stage3ExtractionResult` / `UnifiedExtractionResult` 加 `lineItemGroups` |
| 二 ✅ | `src/services/extraction-v3/stages/stage-3-extraction.service.ts` | 🔧 修改 | `buildLineItemGroups()` —— 依 `groupKey` 切組並對每組重跑回填 |
| 二 ✅ | `src/services/extraction-v3/extraction-v3.service.ts` | 🔧 修改 | 透傳 `lineItemGroups`（逐欄位重建處） |
| 二 ✅ | `src/services/unified-processor/unified-document-processor.service.ts` | 🔧 修改 | 同上（第二處逐欄位重建） |
| 二 ✅ | `src/types/unified-processor.ts` | 🔧 修改 | `stage3Result` 型別加 `lineItemGroups` |
| 二 ✅ | `prisma/schema.prisma` + migration + `apply-schema-drift.js` | 🔧 修改 | `DataTemplate.lineItemMode`（Azure 需 gated 執行，見下） |
| 二 ✅ | `src/services/template-matching-engine.service.ts` | 🔧 修改 | `buildRowUnits()` 分組展開 + `resolveGroupReferenceNumbers()`；`processBatch()` 改吃列單元；`extractMappedFields()` 拆為 `extractFieldValues()` + `flattenChargeItems()` |
| 二 ✅ | `src/types/template-matching-engine.ts` | 🔧 修改 | 新增 `TemplateRowUnit` |
| 二 ✅ | `src/types/data-template.ts` + `src/validations/data-template.ts` | 🔧 修改 | `LineItemMode` / `LINE_ITEM_MODES` / Zod 值域 |
| 二 ✅ | `src/services/data-template.service.ts` | 🔧 修改 | CRUD 帶 `lineItemMode` |
| 二 ✅ | `DataTemplateForm.tsx` + `messages/{en,zh-TW,zh-CN}/dataTemplates.json` | 🔧 修改 | 模式選擇器 + 三語言字串 |
| 二 ✅ | `tests/unit/services/template-matching-group-expansion.test.ts` | 🆕 新增 | 展開行為 15 案例 |
| 二 ✅ | `tests/unit/services/stage-3-line-item-group-key.test.ts` | 🔧 修改 | 追加階段二分組產生 7 案例 |

**不需修改**：`src/services/transform/aggregate.transform.ts`（分組責任留在呼叫端，聚合器維持單一職責）。

### 資料庫影響

階段一無。階段二新增 `data_templates.line_item_mode`（`VARCHAR(20)`、預設 `'PIVOT'`、向後相容）。

- Migration：`prisma/migrations/20260729120000_change113_add_line_item_mode_to_data_template/`
- 本地：已以 `npx prisma db push` 套用（`prisma migrate dev` 因既有 migration 基線問題無法建立 shadow database —— 屬 CHANGE-056 待處理的 pre-existing 狀況，與本 CHANGE 無關）
- Azure：冪等 DDL 已加進 `prisma/apply-schema-drift.js` 的 `MIGRATIONS`（id `CHANGE-113 data_templates.line_item_mode`）

> ⚠️ 依 [[feedback_azure_migration_needs_schema_drift_entry]]：Azure 容器啟動流程**不執行** `migrate deploy`，PR 內的 migration 對非空的 Azure 資料庫無效。部署時必須帶 `RUN_SCHEMA_DRIFT_FIX=true` 執行一次，否則新程式碼讀取 `lineItemMode` 會出現 P2022。

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

---

## 🔴 階段一結論的重大更正（2026-07-29 晚間）

上一節「三次讀對 `groupKey`」的結論**不成立**，且據以推導的「補畫已足夠」也不成立。以下三點是後續實測釘死的：

### 更正 1：三次讀對是「複製 Prompt 範例」，不是讀圖

當時的 DHL Stage 3 Prompt（`change113-dhl-stage3-001`）把**真實號碼寫進了範例**：

```
groupKey: ... (e.g. "RCIM-25-0111", "RCIM/25/0246")
```

GPT 第一組抄第一個範例（碰巧與正解相同），第二組直接抄第二個 —— 而 `RCIM/25/0246` 屬於**另一份文件**。`groupSourceRef` 同理。移除範例後（僅描述格式、不給具體值），GPT 隨即改為**按格式編造**：`HKG-2405-0001`、`HKG-2405-0002` —— 兩個號碼不存在於任何地方。

> **通用教訓**：Prompt 裡用真實資料當範例，模型會複製它，而且複製出來的結果**看起來完全正確**，因而無法從結果分辨「讀對」與「抄對」。範例一律用明顯虛構的值。

### 更正 2：補畫生效了，但**整頁側躺**使它無用

裁切渲染圖確認：`RCIM-25-0111` 以 40px 紅色粗體清晰畫在框內，補畫本身完全正常。但**第 2 頁整頁內容旋轉 90 度**（`p.rotate = 0`、頁面 612×792 直向，是製作文件時把橫向表格側著放進直向頁面）。pdfjs 照 PDF 描述渲染完全正確，無從得知該轉正。

GPT 讀側躺的頁面不準 —— 這同時解釋了 AWB 為何六次只對一次。

### 更正 3：文字方向法對這份文件取不到訊號 —— 改用註解旋轉角

原本要用 `getTextContent()` 的變換矩陣判斷方向。實測發現該 PDF **兩頁都是純掃描圖**，`items: []`，完全沒有文字層。

改以 pdfjs 暴露的 FreeText `rotation`（此例為 `90`）作為備援：使用者在側躺頁面上補註時，會把文字方塊轉到與內容同向才寫得下去，**那個角度就是內容的方向**。文字層優先、註解角度備援。

### 更正後的實測結果（A1 + A2 + A3 全部到位）

| groupKey | groupSourceRef (AWB) | 費用組成 | 合計 | 期望值 |
|---|---|---|---|---|
| `RCIM-25-0111` | `8365573366` ✅ | 247.50 + 69.92 | **317.42** | 317.42 ✅ |
| `RCIM-25-0113` | `2407071774` ✅ | 2310.00 + 652.58 | **2962.58** | 2962.58 ✅ |

`Stage 3` 日誌：`Injected 2 PDF annotation(s) as groupKey candidates` → `built 2 line item group(s) covering 4/4 line item(s)`。

**AWB 也一併讀對了** —— 轉正把「六次只對一次」變成正確。這推翻了更正前「AWB 因小字級而不可靠」的歸因：**真正的原因是頁面側躺，不是字級**。`groupSourceRef` 目前仍不用於分組（單次正確不足以推翻先前的不穩定觀察，需要多次重跑才能改結論）。

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
| 7 | 一 ✅ | 穩定度 | 同一文件連續處理 3 次，分組結果完全一致 | High |
| 8 | 一 | 零回歸 | 非 DHL 文件重跑後輸出與先前完全相同 | High |
| 9 | 二 | 分組展開 | `DHL_RCIM250111_28699.pdf` 產生 2 列，rowKey 為 `RCIM250111` 與 `RCIM250113` | High |
| 10 | 二 | 組層級號碼 | 兩列的 `shipment_number` 分別為各自的號碼（驗證缺口 1 已解） | High |
| 11 | 二 | 組內金額 | 兩列的費用合計分別為 317.42 與 2,962.58（驗證缺口 2、3 已解） | High |
| 12 | 二 | 模式預設 | 既有 DataTemplate 未設定時為 `PIVOT`，輸出與現況一致 | High |
| 13 | 二 | ~~EXPAND 模式~~ | **本次不實作** —— 見 §階段二實作範圍 修正 3 | Medium |
| 14 | 全 ✅ | 型別 / 規範 / i18n | `type-check`、`lint`、`i18n:check` 通過 | High |

單元測試：`template-matching-group-expansion.test.ts` 15 案例 + `stage-3-line-item-group-key.test.ts` 追加 7 案例 + `pdf-text-rotation.test.ts` 18 案例（一A3）+ `stage-3-group-candidate-prompt.test.ts` 12 案例（一A2），全庫 **392 通過 / 2 跳過**。

**本地端到端已於 2026-07-29 通過**（`DHL_RCIM250111_28699.pdf`）：

| 驗收 | 實測 |
|---|---|
| 9 分組展開 | 2 列，rowKey `RCIM250111` / `RCIM250113` ✅ |
| 10 組層級號碼 | `shipment_number` 各列不同 ✅ |
| 11 組內金額 | freight 247.5 / 2310 + `fuel_surcharge_at_origin` 69.92 / 652.58 = 317.42 / 2962.58，與發票小計相符 ✅ |
| 一A2 候選清單 | `Injected 2 PDF annotation(s) as groupKey candidates` ✅ |
| 一A3 轉正 | `rotatedPages = [{pageNumber: 2, degrees: 90}]`，渲染圖目視確認正立 ✅ |

### 燃油附加費映射目標 —— 使用者 2026-07-29 決定採選項 A

原狀：DHL 映射配置只有 2 條規則（`freight ← express_worldwide_nondoc`、`shipment_number ← _ref_number`），提取出的 `fuel_surcharge` **無規則可接**，69.92 / 652.58 落空 —— 模板列金額是 247.50 而非發票的 317.42。

模板 45 欄中沒有語意完全吻合的欄位：該模板是**貨運承攬**的三段成本結構（起運地／主運／目的地），而 DHL Express 是門到門快遞，其 FUEL SURCHARGE 按運費計百分比、不專屬起運地。

| 選項 | 做法 | 取捨 |
|---|---|---|
| **A（採用）** | `fuel_surcharge_at_origin ← fuel_surcharge`（DIRECT） | 兩個金額各佔一欄、列加總正確；欄位標籤「at origin」與 DHL 語意不完全吻合 |
| B | `freight` 改 FORMULA 合併兩者 | 報表看不到燃油單獨金額 |
| C | GLOBAL 模板新增 `fuel_surcharge` 欄 | 語意最準但影響所有公司 |

**採 A 的理由**：保留兩個獨立金額比欄位標籤精準更重要 —— 標籤日後可改，資料合併了拆不回來。屬**設定變更、不動程式碼**，隨時可改回（腳本 `add-dhl-fuel-mapping.js`，快照存於 `snapshots/`）。

### `express_worldwide_doc` 也納入 freight —— 使用者 2026-07-30 核准

DHL 欄位定義集有 3 個 `lineItem` 欄位，原本只映射了 1 個，另兩個的金額會落空（驗收發票剛好只有 nondoc，故未暴露；只要有一張含**文件類**運件的 DHL 發票就會出事）。最終配置：

| 欄位 | 映射 |
|---|---|
| `express_worldwide_nondoc` | ✅ → `freight`（FORMULA 第一項） |
| `express_worldwide_doc` | ✅ → `freight`（FORMULA 第二項） |
| `fuel_surcharge` | ✅ → `fuel_surcharge_at_origin`（DIRECT） |

`freight` 規則改為 `FORMULA: {express_worldwide_nondoc} + {express_worldwide_doc}`。

**為何用 FORMULA 而非兩條 DIRECT 指向 freight**：`transformFields` 按 `order` 依序套用，同一目標欄位後者覆蓋前者，跳過條件只有 `undefined`。`DirectTransform` 原值回傳，因此結果取決於來源 key 是「缺席」還是「存在但為 null」：

| 來源 key 狀態 | 第二條 DIRECT 的效果 |
|---|---|
| 缺席 | `undefined` → 被跳過 → 安全 |
| 存在但為 null | 通過判斷 → **覆蓋掉已寫入的金額，且不報錯** |

實測本文件的 `express_worldwide_doc` 在 `stage_3_result` 是 `null`、在 `mappedFields` 則是**缺席** —— 也就是說兩條 DIRECT 在這份文件上剛好安全，但那取決於持久化細節，不該依賴。FORMULA 對缺值與 null 一律視為 0（`formula.transform.ts:351`），不受此差異影響，也是專案既有 25 條「多來源 → 單欄」規則一致採用的寫法。

> ⚠️ **副作用（非缺陷）**：`freight` 規則現在會在每列產生轉換診斷 `{"freight":["express_worldwide_doc"]}` —— FIX-128 的「來源 key 不在當次 row」提示。已建立對照組確認這是 FORMULA 慣例的既有常態：全庫 524 列中 **118 列本來就帶診斷**，其他公司的單列診斷多達 10 個目標欄位（DHL 這條只有 1 個）。列狀態仍為 `VALID`，屬資訊性提示。

**驗收 7（穩定度）已於 2026-07-29 晚間重驗通過** —— 修正後（A1+A2+A3 全到位、Prompt 已無真實號碼範例）連跑 3 次：

| 次數 | groupKey | groupSourceRef (AWB) | 組內合計 | 耗時 |
|---|---|---|---|---|
| 1 | `RCIM-25-0111` / `RCIM-25-0113` | `8365573366` / `2407071774` | 317.42 / 2962.58 | 25.0s |
| 2 | 同上 | 同上 | 同上 | 19.9s |
| 3 | 同上 | 同上 | 同上 | 18.0s |

三次的 4 筆行項目、分組、金額、AWB **逐欄位完全相同**，每次都輸出 `Injected 2 PDF annotation(s) as groupKey candidates` 與 `built 2 line item group(s) covering 4/4 line item(s)`，無警告。

> 這次的一致性與 §更正 1 的那次性質不同：當時 Prompt 帶著真實號碼範例，「一致」只證明模型穩定地複製同一段文字；現在 Prompt 無範例，一致代表**真的穩定讀對**。

### `groupSourceRef` 的觀察更新（設計不變）

轉正後 AWB **3 次 × 2 組 = 6/6 全部正確**（轉正前為 1/6）。這確認了 §更正 3 的歸因：先前的不穩定源於頁面側躺，與字級無關。

但**分組依據維持只用 `groupKey`，不改**：`groupKey` 是使用者明確標註的意圖，`groupSourceRef` 只是文件原生內容；即使兩者現在同樣可靠，用前者才符合「使用者說了算」的語意。此處僅記錄觀察，不變更設計。

端到端驗證前完成的資料設定（屬設定非程式碼）：

| # | 項目 | 狀態 |
|---|---|---|
| 1 | DHL 欄位定義集補燃油附加費欄位 | ✅ 已補 `fuel_surcharge`（含快照） |
| 2 | 燃油附加費的模板映射 | ✅ 已加 `fuel_surcharge_at_origin ← fuel_surcharge`（DIRECT，含快照）—— 見下方決策 |
| 4 | 移除 DHL Stage 3 Prompt 的真實號碼範例 | ✅ 已移除（含快照） |
| 3 | 重新處理 DHL 文件 | 分組資訊在提取時固化，舊結果沒有 `lineItemGroups` |

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
| 9 | 分組鍵缺失 | 移除部分 `groupKey` 後執行 GROUP 模式 | 未標記的行項目不歸入任何組（**不**落回 `groupSourceRef` —— 該欄位已實測不可靠）；完全沒有 `groupKey` 則整份維持一列 |
| 10 | 多文件同分組鍵 | 兩份文件含相同 shipment 號碼 | 合併為同一列（`sourceDocumentIds` 含 2 個 ID） |
| 11 | 分組鍵對不到主檔 | 分組鍵帶後綴（如 `RCEX-25-0479 PDI`） | 該列以原始分組鍵作 rowKey，列不消失、也不與他組共用 rowKey |

---

## 實施計劃

| 階段 | 內容 | 出口條件 |
|---|---|---|
| 一B ✅ | 型別 + Schema + 透傳 + 測試 | 已完成（驗收 5） |
| 一A1 ✅ | 註解補畫 | 已完成（驗收 1-2、4） |
| 一A2 ✅ | 候選清單注入 | 已完成 2026-07-29 晚間（驗收 3）。⚠️ 先前曾被誤標為已完成，實際當時**未實作** —— `PdfAnnotationInfo` 無任何呼叫端 |
| 一A3 ✅ | 側躺頁面轉正 | 已完成 2026-07-29 晚間（原規劃無此項，實測後追加並經使用者核准） |
| — ✅ | **檢查點：本地重跑 DHL 文件，確認分組正確** | 已完成 —— 但**先前那次「三次一致」的結論不成立**（Prompt 範例污染，見 §階段一結論的重大更正） |
| 二 ✅ | Prisma 欄位 + 分組展開 + 組層級回填 + UI/i18n | 程式碼完成，單元測試涵蓋驗收 9-12、14 |
| — ✅ | **本地端到端：模板實例產出兩列、金額正確** | 已完成 2026-07-29 —— 2 列、rowKey `RCIM250111` / `RCIM250113`、freight 247.5 / 2310 |
| — ⚠️ | Azure 部署 | **已執行但未達標**（2026-07-30）：映像與五項資料庫設定都上線了，但 A1/A2/A3 三項在 production build 全部失效（webpack 改寫 pdfjs 動態 import）→ 已開 **FIX-146**。見 §Azure 部署執行結果 |
| — 🔴 | **補驗：三項機制在 production build 上有效** | 未做 —— 階段一只在 `npm run dev` 驗證過，這是 FIX-146 的成因。修復後必須 `npm run build && npm start` 重驗 |

---

## Azure 部署準備（2026-07-30）

### 部署前查證結果

| 查核項 | 結果 |
|---|---|
| 線上映像 | `dev-fix142-20260729102003` → 對應 `e9a1fdb`（FIX-142，10:06 合併 → 10:20 建置） |
| 落後 main | **4 個 commit**：`dbc6afd`、`772dcb2`、`cc0300a`、`c7ebc55` —— 全部屬 CHANGE-113，無夾帶無關變更 |
| 新增 env | **無**。區間內所有 `process.env` 讀取都在 `scripts/change-113/`（診斷腳本，讀既有變數）；`autoRotatePages` / `paintRotatedAnnotations` 是程式碼層預設值，不走 env |
| Prisma migration | `20260729120000_change113_add_line_item_mode_to_data_template` —— 已確認 `apply-schema-drift.js:207` 有對應條目，部署須帶 `RUN_SCHEMA_DRIFT_FIX=true` |
| 一併上線的其他 FIX | FIX-144（已處理文件缺重新處理入口）代碼在 `dbc6afd`。FIX-145 **僅有文件、代碼未實作**，其 bug（`prompt-assembly.service.ts:258` 用不存在的 `cityCode` 欄位查 company）自 2026-01-30 引入、區間內該檔未改動 → **早已在線上**，部署不會使其變差 |

> 對照 FIX-108 的教訓（memory `feedback_deploy_check_image_lag_and_new_env`）：那次只比對工作樹 vs origin/main，結果把 7/10 以來累積的 CHANGE-099/100/102/103 + Epic 23 + FIX-106/107 一次帶上線，且 CHANGE-100/102 的新 env 未設 → 靜默 fallback → 整批 OCR_FAILED。本次兩項風險都已排除。

### 五項資料庫設定（不隨映像走）

程式碼上線**不等於**功能生效 —— 讓 CHANGE-113 真正動起來的五項設定都在資料庫裡。未套用則映像雖新、行為仍是舊的（分組鍵被編造、燃油與文件類運費金額落空、且完全不會展開成多列）。

已實作 `prisma/change113-dhl-setup.js` + entrypoint 三模式旗標 `RUN_CHANGE113_DHL_SETUP=inspect|dryrun|write`：

| 步驟 | 內容 |
|---|---|
| 1 | 解析 DHL 公司（`code='DHL'`）—— 0 筆或多筆皆停手，不猜 |
| 2 | 欄位定義集補 `fuel_surcharge` |
| 3 | Stage 3 prompt：不存在則**建立**、存在則校正（含偵測真實號碼範例） |
| 4 | 映射 `fuel_surcharge_at_origin ← fuel_surcharge`、`freight` 改 FORMULA |
| 5 | 模板 `line_item_mode` 設為 `GROUP` |

**設計要點**：

- **以名稱／code 查找，不用主鍵** —— `scripts/change-113/*` 全部寫死本地 ID，各環境主鍵獨立產生，直接搬會設到錯誤的實體上（或找不到而失敗）
- **放 `prisma/` 而非 `scripts/`** —— runner 映像只含 `prisma/*` 與 `docker-entrypoint.sh`，不含 `scripts/` 其餘檔亦無 tsx（memory `feedback_azure_runner_excludes_scripts_tsx`）
- **不寫快照檔** —— 容器無持久檔案系統。改為在寫入前把變更前的值完整印進 log，Log Analytics 的 `AppServiceConsoleLogs` 即還原依據（這幾張表都無版本歷史／rollback）
- **三模式而非布林** —— 比照 FIX-140：關閉方式是**清空**設定，設成 `false` 不算關閉
- **各步驟獨立** —— 任一前置缺失只跳過該步，不擋其餘設定
- **公司重複即停手** —— 挑錯一筆會讓設定掛在沒有文件的公司上且不報錯（memory `project_company_dup_breaks_company_mapping`）

**已驗證**：本地 `inspect` 模式正確判定五步全數「無需變更」（含 prompt 內容逐位元組相符）；prompt 的 INSERT 分支本地永遠走不到，已用交易回滾實測欄位清單對真實 schema 成立（`scripts/change-113/probe-prompt-insert.js`）。

### 部署步驟

| # | 步驟 | 驗證 |
|---|---|---|
| 1 | `az acr build --registry acrscmdocprocessingdev`（tag `dev-change113-<timestamp>`） | 輪詢 `az acr task list-runs`；完整 log 取 SAS URL（本機 log 串流會在 `npx prisma generate` 的 `✔` 字元以 cp1252 崩潰，**不影響雲端建置**） |
| 2 | 設 `RUN_SCHEMA_DRIFT_FIX=true` + `RUN_CHANGE113_DHL_SETUP=inspect` | 先唯讀看 Azure 現況 |
| 3 | `az webapp config container set` 換映像 | 觸發重啟 |
| 4 | 讀容器 log：schema drift 是否套用、inspect 回報什麼 | Log Analytics `AppServiceConsoleLogs` |
| 5 | 依 inspect 結果改 `RUN_CHANGE113_DHL_SETUP=dryrun` → 確認後 `write` | 每次改 app setting 會重啟 |
| 6 | **清空** `RUN_CHANGE113_DHL_SETUP`、`RUN_SCHEMA_DRIFT_FIX` 設回 false | 避免每次啟動重跑 |
| 7 | 上傳 DHL 多 shipment 發票端到端驗證 | 兩列、rowKey 為主檔標準號碼、金額 317.42 / 2962.58 |

> ⚠️ 重啟退避約 35 分鐘 —— `az webapp restart`、`stop`+`start`、改 app setting、`config container set` 都可能無法強制立即重啟，常需等下一次自然重試才生效。**別誤判「設定沒生效」**。

階段一若因風險 #2、#3 無法達標，**不進入階段二** —— 改回報並重新評估（例如升級為座標對應的確定性方案）。

---

## Azure 部署執行結果（2026-07-30）—— ⚠️ 未達標

### 已完成的部分

| 項目 | 結果 |
|---|---|
| 映像 | `dev-change113-20260730100145`（build run `ck1k`，08:33 完成）已切換 |
| Schema drift | 21 條全數套用、0 失敗（含 CHANGE-113 的 `line_item_mode`） |
| 五項資料庫設定 | `write` 模式全數成功；旗標事後已清空 |
| Stage 3 prompt | 新版（移除真實號碼範例）已在 Azure 生效 |

### 未達標的部分

**A1、A2、A3 三項全部未生效**（不只 A2/A3 —— 初判漏了 A1）。

| 機制 | Azure 實測 | 判讀 |
|---|---|---|
| A1 註解補畫 | 無法從輸出分辨，但根因確認後可知同樣失效 | **未生效** |
| A2 候選清單注入 | `extraction_results.gpt_prompt`（實際送出的 prompt）無候選清單段落 | **未生效** |
| A3 側躺頁轉正 | GPT 收到側躺圖，AWB 讀成 8 位（`88557336`／`24097724`，正確為 10 位 `8365573366`／`2407071774`） | **未生效** |
| 模板列產出 | 該文件 `template_instance_id` 為 **null** —— 沒有模板實例、沒有列 | **無法驗證**（Azure 上 DHL 未設預設模板，與本地同樣的設定缺口） |

提取層的分組資料仍是**正確的**：groupKey `RCIM-25-0111` / `RCIM-25-0113`、2 組、4 筆行項目、金額 247.5 + 69.92 / 2310 + 652.58。

但這正是問題所在 —— **groupKey 的正確性目前沒有任何機制保障**（A2 就是那個保障），模型只是自行從圖上讀對了。換一份文件可能就編造。

### 根因已確認：webpack 把 pdfjs 的動態 import 換成必然拋錯的 stub

`loadPdfjs()` 的 `import(pathToFileURL(url).href)` 在 `next build` 後被 webpack 改寫為 `__webpack_require__(54385)(url)`，而 module 54385 是 webpack 的 missing-module stub —— 對任何路徑無條件拋 `MODULE_NOT_FOUND`。`collectPageHints` 是 A1/A2/A3 的共同上游，其 catch 只 push warning，於是三者一起靜默失效。

🔴 **這不是 Azure 特有問題，而是 production build 特有。** 本地驗證走 `npm run dev`（原生 `import()` 保留）故三者皆有效 —— 階段一的驗證盲點就在這裡：**三項機制從未在 production build 上驗證過**。詳見 **FIX-146**。

### 兩個先前的錯誤推論（已更正）

1. 「A3 未生效，因為 AWB 與轉正前值相同」—— 結論對，但理由不成立（AWB 讀錯是側躺誤讀，轉正後也可能錯）。真正的證據是編譯產物。
2. 「A1 必定生效，否則模型看不到 RCIM」—— **錯**。在映像內渲染該頁確認：**pdfjs 自己就會繪製 FreeText 註解**，RCIM 紅字紅框清楚可見。模型讀到 groupKey 與 A1 無關。

> 🔴 **不可把本次部署記為成功。** 映像與設定上線 ≠ 功能生效。

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
