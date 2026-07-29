# CHANGE-113: 一份發票對應多個 Shipment —— 行項目分組鍵與模板三模式輸出

> **日期**: 2026-07-29
> **狀態**: 🚧 進行中（階段一程式碼完成 2026-07-29，待部署後實機驗證；階段二未開始）
> **優先級**: High
> **類型**: Feature Enhancement
> **影響範圍**: 提取層（LineItemV3、Stage 3 Prompt/Schema）、模板匹配引擎、DataTemplate Model、DataTemplate UI
> **合併**: 本 CHANGE 併入並取代 [CHANGE-044](CHANGE-044-line-item-hybrid-dual-mode.md)（Line Item Hybrid 雙模式，⏳ 待實作）
> **相關**: [CHANGE-043](CHANGE-043-line-item-pivot-flatten.md)（Pivot 展平，已完成）、[CHANGE-048](CHANGE-048-ref-number-as-row-key.md)（Ref Number 作 rowKey，⏳ 待實作）
> **觸發事件**: 2026-07-29 使用者回報 DHL 發票格式 —— 一份發票對應多個 shipment，明細在後頁橫向表格

---

## 變更背景

### 問題場景

DHL 的發票（範例：`DHL_RCIM250111_28699.pdf`，invoice `HKGR008328699`）第 2 頁是橫向明細表，**一份發票包含多個 shipment**：

| Air Waybill Number | 對應 shipment | Standard Charge | Fuel Surcharge | 小計 |
|---|---|---|---|---|
| 8365573366 | RCIM-25-0111 | 247.50 | 69.92 | **317.42** |
| 2407071774 | RCIM-25-0113 | 2,310.00 | 652.58 | **2,962.58** |
| | | | 合計 | 3,280.00 |

期望產出是**兩列**，各自帶自己的費用。

### 現況：四層都無法表達

| 層 | 位置 | 現況 |
|---|---|---|
| 提取 | `src/types/extraction-v3.types.ts:268-283` | `LineItemV3` 只有 `description` / `classifiedAs` / `quantity` / `unitPrice` / `amount` / `confidence` / `needsClassification` —— **沒有任何欄位可表示「這筆屬於哪個 shipment」** |
| 展平 | `src/services/transform/aggregate.transform.ts:159` | `AggregateTransform` 從 `context.lineItems` 讀**整份文件**的行項目，`li_{分類}_total` 是全文件同分類加總 |
| 參考編號 | `src/services/extraction-v3/stages/reference-number-matcher.service.ts:77-85` | 只讀**檔名**、不看內文；`_ref_number` 只取第一筆（`template-matching-engine.service.ts:776`） |
| 模板 | `src/services/template-matching-engine.service.ts:389-431` | `for (const doc of documents)` 搭配回傳單一字串的 `extractRowKey()` → **一份文件恰好一列** |

資料表同樣是單向設計：`TemplateInstanceRow.sourceDocumentIds` 是陣列（多份文件併一列），但沒有反方向的一對多；`ExtractionResult.documentId` 是 `@unique`。

### 實際後果（未修復前）

上述 DHL 文件會產生**一列**，`rowKey` = `RCIM250111`（來自檔名），金額 3,280 全數掛在 RCIM-25-0111 名下，RCIM-25-0113 整筆消失，**且不會有任何錯誤提示**。

### 與 CHANGE-044 的關係

CHANGE-044 規劃了 `DataTemplate.lineItemMode` 的雙模式（PIVOT：1 文件 = 1 列；EXPAND：1 筆費用 = 1 列）。DHL 需要的是**中間粒度**：1 個 shipment = 1 列、組內費用仍 pivot 成欄。

三種模式共用同一個欄位與同一段分列邏輯，分開實作會導致先做完的一方在後續被重構。故本 CHANGE **一次定義三模式**，CHANGE-044 標記為併入本 CHANGE。

---

## 變更內容

### 階段一：提取層帶分組鍵（不改變任何下游行為）

#### 1.1 `LineItemV3` 新增兩個可選欄位

```typescript
export interface LineItemV3 {
  // ...現有欄位不動...

  /**
   * 分組鍵（CHANGE-113）
   * @description
   *   該筆費用所屬的 shipment / 參考號。用於「一份文件含多個 shipment」的發票。
   *   一般發票不填，行為與現況完全相同。
   */
  groupKey?: string;

  /**
   * 分組的文件原生單號（CHANGE-113）
   * @description
   *   該組在文件上印刷的承運商單號（DHL = Air Waybill Number）。
   *   `groupKey` 多為人工補註、可能漏標或標錯位置；本欄位是文件原生印刷內容，
   *   供事後交叉核對，並在 `groupKey` 讀不到時作為備援分組依據。
   */
  groupSourceRef?: string;
}
```

**兩個欄位都抓的理由**：`groupKey`（RCIM 號碼）是使用者在 PDF 上另外補註的 —— 只有使用者能說明每一列對應哪個 shipment，但也因此可能漏標、位置偏移或格式不一。`groupSourceRef`（AWB）是 DHL 原生印刷、OCR 穩定度高。金額掛錯 shipment 的代價很高，多存一個原生欄位可用於核對，成本只是 Prompt 稍長。

#### 1.2 GPT 輸出結構同步

Stage 3 的 structured output schema 由 `stage-3-extraction.service.ts` 的 `generateOutputSchema()` 動態產生，在其 `lineItems.items.properties` 加入兩個欄位，**不列入 `required`** —— 舊文件與其他公司的輸出完全不受影響。

> ⚠️ 規劃初稿誤指為 `src/services/extraction-v3/utils/prompt-builder.ts` 的 `generateJsonSchema()`。該處是 **V3 單階段**路徑的 schema，現行 V3.1 三階段不走它。已於實作時更正 —— 見 §階段一實作記錄的範圍邊界。

#### 1.3 行項目轉換必須明確透傳（實作時發現）

`convertRawLineItems()` 是「逐欄位重建物件」的實作，**未明確列出的欄位一律被靜默丟棄**。新欄位若只加在型別與 schema，GPT 會回傳、但值永遠到不了資料庫 —— 這正是 FIX-092 `referenceNumberMatch` 的漏接模式（不拋錯、型別不報，直到使用者回報才發現）。

#### 1.4 Stage 3 Prompt 說明（暫緩，先驗證 schema description 是否足夠）

structured output 的 schema `description` 本身就是給模型的指示。先只靠它驗證，若實測發現 GPT 不填或亂填，才在 DHL 的 COMPANY 層 PromptConfig 補說明 —— **不動全域 Prompt**，避免其他公司的文件被誘導亂填分組鍵。

#### 1.5 階段一的邊界

此階段完成後，分組鍵只是被寫進 `ExtractionResult.stage3Result`。`li_*` 展平不讀取它，`processBatch()` 不讀取它 —— **模板匹配的輸出一個字都不會變**。

---

### 階段二：模板層按分組展開

> 前置條件：階段一驗證通過（GPT 能穩定逐列填對分組鍵）。

#### 2.1 `DataTemplate` 新增 `lineItemMode`

```prisma
model DataTemplate {
  // ...現有欄位...
  lineItemMode String @default("PIVOT") @map("line_item_mode")
}
```

| 值 | 語意 | 來源 |
|---|---|---|
| `PIVOT` | 1 份文件 = 1 列，費用按 `classifiedAs` 聚合為欄（現況） | CHANGE-043 |
| `EXPAND` | 1 筆費用 = 1 列（審計逐筆核對用） | 原 CHANGE-044 |
| `GROUP` | 1 個分組鍵 = 1 列，組內費用再 pivot 成欄 | 本 CHANGE |

#### 2.2 `processBatch()` 依模式分列

`template-matching-engine.service.ts:389-431` 目前是 `for (const doc of documents)` 一文件一列。改為先依模式把一份文件展開為 1..N 個「待寫入單元」，再逐一 upsert。

`GROUP` 模式的分組依據優先序：`groupKey` → `groupSourceRef` → 落回整份文件單一組（等同 `PIVOT`，確保任何情況都能產出結果）。

#### 2.3 `transformFields()` 接受行項目子集

`template-matching-engine.service.ts:507` 目前傳入 `lineItems: s3?.lineItems`（整份文件）。`GROUP` 模式改為傳入**該組的子集**。

`AggregateTransform` 本身**完全不需要修改** —— 它從 `context.lineItems` 讀什麼就聚合什麼，換掉輸入即可。這是本階段最重要的設計選擇：把分組責任放在呼叫端，聚合器維持單一職責。

#### 2.4 `extractRowKey()` 與 CHANGE-048 的協調

`GROUP` 模式下 rowKey 必須來自**該組自己的**分組鍵，不能用文件層級的 `_ref_number`（那是檔名匹配的單一值，DHL 檔名只含第一個 shipment 號碼）。

優先序定為：**分組鍵（GROUP 模式）> `_ref_number`（CHANGE-048）> `rowKeyField` > 時間戳**。CHANGE-048 實作時需沿用此優先序。

#### 2.5 DataTemplate UI 與 i18n

模式選擇器（三選一）+ 三語言字串。

---

## 技術設計

### 修改範圍

| 階段 | 檔案 | 動作 | 變更內容 |
|---|---|---|---|
| 一 ✅ | `src/types/extraction-v3.types.ts` | 🔧 修改 | `LineItemV3` 加 `groupKey?` / `groupSourceRef?` |
| 一 ✅ | `src/services/extraction-v3/stages/stage-3-extraction.service.ts` | 🔧 修改 | `generateOutputSchema()` 加兩欄位（非必填）；`convertRawLineItems()` 明確透傳；新增 `normalizeGroupToken()` |
| 一 ✅ | `tests/unit/services/stage-3-line-item-group-key.test.ts` | 🆕 新增 | 釘住透傳行為（7 個案例） |
| 一 ⏸️ | DHL COMPANY 層 PromptConfig（資料，非程式碼） | 🔧 修改 | 暫緩 —— 先驗證 schema description 是否足夠（§1.4） |
| 二 | `prisma/schema.prisma` | 🔧 修改 | `DataTemplate.lineItemMode` + migration |
| 二 | `src/services/template-matching-engine.service.ts` | 🔧 修改 | `processBatch()` 分列、`transformFields()` 收子集、`extractRowKey()` 優先序 |
| 二 | `src/types/template-matching-engine.ts` | 🔧 修改 | options 加模式參數 |
| 二 | `src/services/data-template.service.ts` | 🔧 修改 | CRUD 帶 `lineItemMode` |
| 二 | DataTemplate 表單組件 | 🔧 修改 | 模式選擇器 |
| 二 | `messages/{en,zh-TW,zh-CN}/*.json` | 🔧 修改 | 三模式標籤與說明 |

**不需修改**：`src/services/transform/aggregate.transform.ts`（見 §2.3）。

### 資料庫影響

階段一無。階段二新增 `data_templates.line_item_mode`（有預設值、向後相容）。

> ⚠️ 依 [[feedback_azure_migration_needs_schema_drift_entry]]：Azure 的容器啟動流程**不執行** `migrate deploy`，PR 內的 migration 對非空的 Azure 資料庫無效。階段二部署前必須把此 DDL 轉為冪等寫法加進 `prisma/apply-schema-drift.js` 的 `MIGRATIONS`，並帶 `RUN_SCHEMA_DRIFT_FIX=true` 執行一次，否則新程式碼讀取新欄位會出現 P2022。

### i18n 影響

階段一無（不涉及使用者可見字串）。階段二需三語言同步並通過 `npm run i18n:check`。

---

## 階段一實作記錄（2026-07-29）

### 本地驗證

| 檢查 | 結果 |
|---|---|
| `npm run type-check` | 通過 |
| `npx eslint`（改動檔案） | 0 error；4 個 warning 全為既有（3 處 `console`、1 處未使用的 `index`），本次未新增 |
| `npm run test` | 32 檔通過 / 1 跳過；335 案例通過 / 2 跳過，無回歸 |
| 新增測試 | 7 個案例全數通過 |

### 範圍邊界（已知、刻意不做）

**V3 單階段路徑未同步加分組欄位。** `extraction-v3.service.ts:197-204` 顯示 `processFile()` 會在 V3.1 三階段拋錯時**回退到 V3 單階段**，而 V3 走的是 `prompt-builder.ts` 的 `generateJsonSchema()` 與另一套解析邏輯，兩者都沒有分組欄位。

不跟著改的理由：那是異常降級路徑（正常處理不會走到），且要連帶修改第二套解析邏輯才有意義，屬本 CHANGE 範圍外。**後果**：若某份 DHL 文件觸發 V3.1 失敗回退，該次提取不會有分組資訊，第二階段會落回「整份文件併為一組」。這是可接受的降級，但需要時可另開 FIX 補齊。

### 待實機驗證（部署後）

1. **註解層可見性**（風險 #1）—— GPT 是否真的讀得到使用者補註的 RCIM 號碼
2. **schema description 是否足夠**（§1.4）—— 不加 Prompt 說明的情況下，GPT 會不會主動填分組欄位
3. **穩定度** —— 同一文件連跑 3 次，分組結果是否一致
4. **零回歸** —— 非 DHL 文件的 `stage3Result` 與模板匹配輸出是否與先前完全相同

---

## 設計決策

1. **分組鍵設為可選欄位** —— 只有多 shipment 的發票會填。若設為必填，所有既有文件與其他公司都要重跑，且 GPT 會被迫為單一 shipment 的發票編造分組鍵。

2. **Prompt 說明只加在 DHL COMPANY 層** —— 全域 Prompt 加分組說明會讓其他公司的文件也嘗試分組，製造不必要的雜訊與錯誤。

3. **同時抓 `groupKey` 與 `groupSourceRef`** —— 見 §1.1。使用者 2026-07-29 確認採此方案。

4. **分組責任放在呼叫端，不改聚合器** —— 見 §2.3。

5. **三模式一次定義，合併 CHANGE-044** —— 見 §變更背景。使用者 2026-07-29 確認。

6. **強制分兩階段，階段一驗證通過才動階段二** —— 依 [CHANGE-094](CHANGE-094-line-item-charge-extraction-stability.md) 的既有教訓：GPT 對「費用該放哪裡」的判斷本身就不穩定（同一份文件不同次結果不同）。分組判斷的難度只會更高，且一旦錯誤是**金額掛到錯誤的 shipment**，比欄位空白嚴重得多。先在無下游影響的狀態下驗證穩定度，是這個順序的唯一理由。

---

## 已知風險

| # | 風險 | 嚴重度 | 說明與緩解 |
|---|---|---|---|
| 1 | **PDF 註解層可能渲染不出來** | 高 | RCIM 號碼是使用者另外補上的。若以 PDF 註解（annotation）形式存在而非壓平進頁面內容，`pdf-converter.ts` 轉圖片時可能不會畫出來，GPT 就看不到。**這是階段一的第一個檢查點**，須實跑確認。若確認看不到 → 改用壓平後的 PDF，或退回以 `groupSourceRef`（AWB）分組並另建 AWB 對照 |
| 2 | GPT 分組判斷不穩定 | 高 | 同一文件連跑 3 次比對結果；不穩定則加強 Prompt 或改用確定性後處理（比照 CHANGE-094 的回填策略） |
| 3 | 人工標註格式不一致 | 中 | 需與使用者約定標註規範（每列一個號碼、寫在該列縱向範圍內）。`groupSourceRef` 提供第二個訊號以便察覺標註問題 |
| 4 | 檔名 ref match 只匹配得到第一個 shipment | 中 | DHL 檔名僅含 `RCIM250111`；`refMatchEnabled` 開啟時匹配不到即中止整個流程（`reference-number-matcher.service.ts:106`）。階段二的 rowKey 改用內文分組鍵可繞過，但「單一號碼決定生死」的判斷邏輯本身需在階段二一併評估 |
| 5 | 既有 Template Instance 混用模式 | 低 | 切換模式後既有列不會自動重算，需重新執行模板匹配 |

---

## 驗收標準

| # | 階段 | 驗收項目 | 驗收標準 | 優先級 |
|---|---|---|---|---|
| 1 | 一 | 分組鍵可見性 | DHL 範例文件重跑後，`stage3Result.lineItems` 每筆都帶正確的 `groupKey` | High |
| 2 | 一 | 原生單號 | 每筆同時帶正確的 `groupSourceRef`（AWB） | High |
| 3 | 一 | 穩定度 | 同一文件連續處理 3 次，分組結果完全一致 | High |
| 4 | 一 | 零回歸 | 非 DHL 文件重跑後，`fields` / `lineItems` / 模板匹配輸出與階段一之前完全相同 | High |
| 5 | 二 | 分組展開 | DHL 範例產生 2 列，rowKey 為 `RCIM-25-0111` 與 `RCIM-25-0113` | High |
| 6 | 二 | 組內金額 | 兩列的 EXPRESS WORLDWIDE nondoc 分別為 317.42 與 2,962.58 | High |
| 7 | 二 | 模式預設 | 既有 DataTemplate 未設定時為 `PIVOT`，輸出與現況一致 | High |
| 8 | 二 | EXPAND 模式 | 1 筆費用產生 1 列（原 CHANGE-044 需求） | Medium |
| 9 | 二 | i18n | 三語言同步，`npm run i18n:check` 通過 | High |
| 10 | 全 | 型別與規範 | `npm run type-check`、`npm run lint` 通過 | High |

---

## 測試場景

| # | 場景 | 測試步驟 | 預期結果 |
|---|---|---|---|
| 1 | DHL 多 shipment（階段一） | 重新處理 `DHL_RCIM250111_28699.pdf`，檢視 AI 詳情的 Stage 3 原始回應 | 4 筆行項目，分屬兩個 `groupKey`，各帶對應 AWB |
| 2 | 註解層可見性 | 同上，確認 GPT 回應中確實出現 RCIM 號碼 | 若完全讀不到 → 觸發風險 #1 的緩解路徑 |
| 3 | 穩定度 | 同一文件連跑 3 次 | 3 次分組結果一致 |
| 4 | 單一 shipment 回歸 | 重跑 Nippon / CEVA 既有文件 | 分組欄位為空，其餘輸出與先前一致 |
| 5 | GROUP 模式（階段二） | DataTemplate 設為 `GROUP`，加入 DHL 文件 | 產生 2 列，金額分別為 317.42 / 2,962.58 |
| 6 | PIVOT 回歸 | 既有模板實例加入文件 | 行為與現況完全相同 |
| 7 | 分組鍵缺失 | 人工移除部分 `groupKey` 後執行 GROUP 模式 | 落回 `groupSourceRef` 分組；兩者皆無則整份文件併為一組 |
| 8 | 多文件同分組鍵 | 兩份文件含相同 shipment 號碼 | 合併為同一列（`sourceDocumentIds` 含 2 個 ID） |

---

## 實施計劃

| 階段 | 內容 | 出口條件 |
|---|---|---|
| 階段一 | 型別 + Schema + DHL Prompt | 驗收標準 1-4 全數通過 |
| — | **檢查點：向使用者回報分組穩定度，確認是否續行** | 使用者確認 |
| 階段二 | Prisma 欄位 + 分列邏輯 + UI + i18n | 驗收標準 5-10 全數通過 |

階段一若因風險 #1 或 #2 無法達標，**不進入階段二** —— 改回報並重新評估方案（例如改為上傳前拆檔的自動化前處理）。

---

## 回滾計劃

| 階段 | 回滾方式 |
|---|---|
| 一 | 欄位為可選、Prompt 為 DHL 專屬。移除 Prompt 段落即回到原行為，已提取的分組資料留在 `stage3Result` 不影響任何下游 |
| 二 | 將 DataTemplate 的 `lineItemMode` 改回 `PIVOT` 並重新執行模板匹配。欄位有預設值，保留不移除亦無影響 |

---

## 相關

- CHANGE-043 — Line Item Pivot 展平（已完成，本 CHANGE 的 `PIVOT` 模式即其成果）
- CHANGE-044 — Line Item Hybrid 雙模式（⏳ 待實作，**已併入本 CHANGE**）
- CHANGE-048 — Ref Number 作 rowKey（⏳ 待實作，rowKey 優先序需與本 CHANGE §2.4 協調）
- CHANGE-094 — 費用提取穩定性（分兩階段的依據）
- FIX-144 — 已完成文件的重新處理入口（本 CHANGE 的驗證流程需要反覆重跑同一份文件）
