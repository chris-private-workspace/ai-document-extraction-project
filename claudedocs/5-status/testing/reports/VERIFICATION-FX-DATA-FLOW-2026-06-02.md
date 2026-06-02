# 驗證記錄：FX 換算數據流端到端追蹤（提取 → 換算 → 持久化 → 下游）

> **日期**：2026-06-02
> **類型**：架構數據流驗證（read-only，無代碼修改）
> **關聯**：CHANGE-071（條件式 FX）、CHANGE-072（覆蓋寫回 + 動態欄位）、CHANGE-073（來源幣別 fallback）
> **方法**：代碼追蹤（標行號）+ dev DB 實證（PostgreSQL @5433）
> **結論**：核心數據流閉環成立；浮現 2 個缺口（data template 投影、monthly-cost-report ai_cost）

---

## 1. 目的

驗證一張發票從 Stage 3 提取，經 FX 匯率換算後處理、持久化，到三條下游（審核 UI / 匯出 / 報表）的完整數據流，並確認 CHANGE-071/072/073 的 FX 換算值與審計原值各自如何流動、被誰消費。

---

## 2. 完整數據流總覽

```
【LLM 邊界內 — Stage 3】              【LLM 邊界外 — 系統後處理】
GPT-5.2 照發票抽「原始數字」    →   ExchangeRateConverterService（純數學，零 GPT）
 currency 欄位 schema=number          ① 定來源幣別：抽不到 → fxSourceCurrency 補（CHANGE-073）
 → 結構上吐不出幣別代碼               ② 查 exchange_rates（依發票年份，FIX-037）
                                      ③ amount × rate（round）
                                      ④ 覆蓋寫回 + 原值存審計（CHANGE-072）
                                          │
                                          ▼
                              持久化 extraction_results（Prisma $transaction）
                                  field_mappings        = 換算後最終值
                                  fx_conversion_result  = 換算前原值 + rate/path（審計）
                                          │
              ┌───────────────────────────┼───────────────────────────┐
              ▼                            ▼                            ▼
        審核 UI                        匯出                         報表 / 統計
   讀 field_mappings（換算後值）   讀 field_mappings（換算後值）   多走衍生表，不碰提取金額
   fx_conversion_result 不可見    fx_conversion_result 不匯出     fx_conversion_result 零消費
```

---

## 3. 分階段驗證（代碼證據）

### 階段 A：Stage 3 提取 — LLM 只吐純數字，不碰換算

- `stage-3-extraction.service.ts` `buildPrompt`（第 698-745 行）：stage 3 prompt = PromptConfig（system/user）+ FieldDefinitionSet 欄位清單 + 三層映射術語 + 圖片 + 輸出 Schema。
- **FX 設定不在 prompt 內**：grep `fxTarget/fxSource/fxConversion/exchangeRate` 於該檔零命中；傳給 GPT 的 `ExtractionConfig` 介面（第 110-127 行）結構上無任何 fx 欄位。
- `generateOutputSchema`（第 636-640 行）：`currency` 型欄位輸出 schema = `['number','null']` → **LLM 對 currency 欄位只能回純數字，連幣別字串都無欄位可放**。
- ⟹ 這是 Fairate 類「抽取判不到來源幣別」的根因，也是 CHANGE-073 fallback 的存在理由。

### 階段 B：FX 後處理 — 系統換算（零 LLM）

- `extraction-v3.service.ts`（第 483-497 行）：Stage 3 跑完**之後**才 `resolveEffectiveConfig({ companyId, formatId })` 取出 PipelineConfig，僅交給 `converter.convert()`，**不回注 stage 3**。
- `exchange-rate-converter.service.ts`（第 82-84 行，CHANGE-073）：`sourceCurrency = extractedCurrency || config.fxSourceCurrency || undefined`（fallback-only，抽取有值不覆蓋）。
- 換算為純數學（`amount × rate`），CHANGE-072 覆蓋寫回欄位、原值存 conversions[]。

### 階段 C：持久化 — `extraction_results` 雙寫

- `processing-result-persistence.service.ts` `persistV3_1ProcessingResult`（第 504+ 行）：Prisma `$transaction` 寫 3 表。
- `extraction_results`（39 欄位，已用 information_schema 驗證）關鍵欄位：
  - `field_mappings`（jsonb）= 動態 `fields`／`standardFields`，**FX 覆蓋寫回後的最終值**（第 590 行）
  - `stage_3_result`（jsonb）= 完整 stage3 快照（含 lineItems/extraCharges，換算後值）
  - `fx_conversion_result`（jsonb）= **換算前原值 + rate/rateId/path（唯一審計留底）**（第 622 行）
  - 另：`confidence_scores`、`average_confidence`、`reference_number_match`、token 統計、`pipeline_steps`
- `documents`（update 狀態）、`processing_queues`（條件 upsert，需審核才建）同交易。

> **設計要點（雙寫）**：換算後值進 `field_mappings`（給下游用）、換算前原值進 `fx_conversion_result`（審計）。兩者分離。

---

## 4. 三條下游消費全景（並行探查 + 交叉驗證）

| 下游 | 主要數據源 | `field_mappings`（換算後值） | `fx_conversion_result`（審計原值） | `stage_3_result` |
|------|-----------|:---:|:---:|:---:|
| 審核 UI | `extraction_results` | ✅ 直讀→`ExtractedField[]`（`api/review/[id]/route.ts`） | ❌ 不讀 | ❌ |
| 匯出·費用報表 | `extraction_results` | ✅ 直讀 `.value`（`expense-report.service.ts:288`） | ❌ | ❌ |
| 匯出·模板 | `TemplateInstanceRow`（隔一層） | ✅ 間接（見 §6 缺口） | ❌ | 部分（展平 li_*） |
| 報表·儀表板 | `ProcessingQueue`+`documents.status` | ❌ | ❌ | ❌ |
| 報表·AI 成本 | `ApiUsageLog`（獨立表） | ❌ | ❌ | ❌ |
| 報表·準確率 | `FieldCorrectionHistory`（專用表） | ❌ | ❌ | ❌ |

### 修正寫回（審核）
`api/review/[id]/correct/route.ts`：改 `field_mappings[欄位].value` + confidence=100 + 建 `Correction` 記錄；**不動** `fx_conversion_result`。

---

## 5. 核心結論（已驗證）

1. **FX 雙寫設計必要性 — 由下游反向證明**：審核 / 匯出 / 費用展示**全部只讀 `field_mappings`**。正因如此，FX 換算**必須覆蓋寫回 `field_mappings`**，下游才拿得到換算後值；若只存 `fx_conversion_result` 不覆蓋，下游全拿原值，換算等於白做。CHANGE-072「覆蓋寫回 + 另存審計」是對的。
2. **`fx_conversion_result` 三條下游零前台消費**：純後台審計（誰、原值、哪筆匯率），不出現在任何介面。符合設計意圖。
3. **報表/統計多繞過 `extraction_results`**：走 `ProcessingQueue`（路由/時間）、`ApiUsageLog`（成本）、`FieldCorrectionHistory`（準確率）等衍生表 + 預聚合 + 5 分鐘快取（效能考量）。`extraction_results` 主要服務「審核 + 匯出」。
4. **FX 換算後金額目前只在單張發票層級被消費**，尚無「跨發票換算後總金額聚合統計」。

---

## 6. 缺口 1：Stage 3 動態欄位「投影不到」data template（mapping 驅動）

### 機制（代碼）
`template-matching-engine.service.ts`：
- `extractMappedFields`（第 664-717 行）：**完整**把 `field_mappings` 所有欄位（含動態 currency 欄位）攤平進 sourceFields 中間池 + 展平 lineItems/extraCharges 成 `li_*_total/li_*_count`（CHANGE-043）+ 注入 `_ref_*`（CHANGE-047）。
- `transformFields`（第 453-473 行）：`for (const mapping of mappings)` → `result[mapping.targetField] = sourceFields[mapping.sourceField]` —— **僅輸出有 TemplateFieldMapping 規則的欄位**，沒配規則的來源欄位不會進 `fieldValues`。

⟹ 「stage 3 → data template 帶過去多少」由**模板的 mapping 規則配置**決定，不由 stage 3 決定。

### dev DB 實證
| 項目 | 實際值 |
|------|--------|
| `data_templates` | 3 |
| `template_field_mappings` | **1 條**（GLOBAL「ERP 標準匯入 - 全域映射」） |
| 該 mapping 涵蓋欄位 | 12 個**標準欄位**：`invoice_number`、`invoice_date`、`vendor_code`、`vendor_name`、`currency`、`subtotal`、`tax_amount`、`total_amount`、`due_date`、`po_number`、`tracking_number`、`description`（全 DIRECT） |
| 涵蓋動態費用欄位（`handling_charge` 等 6 個）？ | **否，零涵蓋** |
| `template_instances` / `template_instance_rows` | **0 / 0**（此鏈從未實際執行過） |
| Fairate 真實 `field_mappings` | **只有** 6 個動態 currency 欄位、**無**標準欄位 |

### 判定
- 拿 Fairate 文件投影到現有 GLOBAL template → `sourceField`（invoice_number/total_amount…）對 Fairate 全 miss、動態欄位（handling_charge…）又無 mapping 規則 → `fieldValues` **幾乎全空**。
- **根因（架構張力）**：data template mapping 用「固定標準欄位名」（ERP 匯入概念，Epic 19 早期設計）；CHANGE-042 動態欄位讓每格式有自訂欄位名。兩者需靠「每格式各配 FORMAT scope template mapping」橋接，現況只有一條 GLOBAL 標準映射。
- **性質**：配置缺口（非代碼 bug）。但這是「FX 換算後值能否進 data template 匯出」的真實依賴點 —— 現況下動態欄位格式的 FX 結果**到不了** data template。

### 對 FX 的影響
- FX 換算後值**到得了**：審核 UI、費用報表（前提 key 對得上）。
- FX 換算後值**到不了**：data template 匯出（Fairate 等動態欄位格式缺 FORMAT scope template mapping）。
- 需補 FORMAT scope `TemplateFieldMapping` 才能接通。

### 補充：`fieldType=lineItem` 落點深挖（2026-06-02）
- **DB 實證**：Fairate 6 個費用欄位在 `stage_3_result` **同時存在**於 `fields`（6 個 snake_case key，如 `handling_charge`）與 `lineItems`（6 筆，`classifiedAs` 為 Title Case 如 "Handling Charge"，`amount` 一一對應）—— 兩種視圖並存。
- **根因**：`generateOutputSchema`（第 600-629 行）`required: ['fields','lineItems']` **不看 `fieldType`**，所有 FieldDefinitionEntry 都進 `fields`；`parseExtractionResult`（第 971-1001 行）`fields` 與 `lineItems` 各自獨立解析、不依 `fieldType` 分流。故「雙重表示」是正常結果，**非落錯位置**。
- **確定的正確配法**：template mapping 用 **`sourceField=<fields 的 snake_case key>`（如 `handling_charge`）DIRECT 映射**。不建議 `li_*_total`（`classifiedAs` 含空格 → key 變 `li_Handling Charge_total` 不友善）。
- **順帶技術債（非阻塞）**：① 同一費用在 `fields`+`lineItems` 各一份 → CHANGE-072 FX 各換一次、審計記兩筆（冗餘非錯誤：物件不同、`Set<FieldValue>` 去重不跨兩處）；② `lineItems.quantity` 抽取不可靠（如 Container `quantity=147` 但 `amount=unitPrice=160`），`amount` 仍正確。

---

## 7. 缺口 2（附帶）：monthly-cost-report 引用不存在的 `documents.ai_cost`

- `monthly-cost-report.service.ts:287/:361` 原生 SQL `SUM(ai_cost) FROM documents`。
- DB `documents` 表**無 `ai_cost` 欄位**（information_schema 0 列）→ 城市統計 / 每日趨勢一旦被呼叫即報 `column "ai_cost" does not exist`（原生 SQL，編譯期抓不到）。
- 真實 AI 成本在 `ApiUsageLog`（`ai-cost.service.ts` 用此表）。疑似寫錯數據源。
- **✅ 已由 FIX-059 修復（2026-06-02）**：`getCityStats` 改 `document.groupBy` + `apiUsageLog.groupBy` 合併、`getDailyTrend` 成本改讀 `api_usage_logs.estimated_cost`，並補 `tests/unit/services/monthly-cost-report.test.ts` + 煙霧測試腳本。修法與本記錄獨立調查一致。

---

## 8. 真實資料佐證（dev DB 現存，最新一筆）

`extraction_results.field_mappings`（Fairate 格式，confidence 74→QUICK_REVIEW）：
```
handling_charge:{value:350}  terminal_charge:{value:288.2}  x_ray_screening_charge:{value:147}
airline_document_charge:{value:15}  container_field_station_charge:{value:160}  customs_electronic_data_charge:{value:40}
```
6 欄全純數字、零幣別代碼 → 印證 §3-A「LLM 結構上吐不出幣別」。此筆 `fx_conversion_result` 為 NULL（未啟用 FX）。

---

## 9. 後續建議

| # | 項目 | 性質 | 建議 |
|---|------|------|------|
| 1 | monthly-cost-report `ai_cost` 執行期錯誤 | 缺陷 | ✅ 已由 **FIX-059** 修復（改聚合 `ApiUsageLog` + 補測試） |
| 2 | 動態欄位格式缺 FORMAT scope template mapping | 配置缺口（**✅ 已釐清·文件化收尾**） | 2026-06-02 釐清：代碼層 FIX-044/045 已通；落點疑點已解（`fields`+`lineItems` 雙重表示、非落錯，詳 §6 補充）；正確配法 = `sourceField=<fields snake_case key>`（如 `handling_charge`）DIRECT。目前 data template **零使用**（`template_instances=0`）→ 不改代碼。**Backlog**（待 data template 真正啟用再評估）：(i) UX 防護「投影全空警示」；(ii) 技術債 FX 雙換審計兩筆（CHANGE-072 副作用）；(iii) 技術債 `lineItems.quantity` 抽取不可靠 |
| 3 | 無「換算後總金額聚合統計」 | 功能缺口（**已評估·不做**） | 2026-06-02 評估：超出 v1.0 PRD 範圍 + 系統職責邊界。證據：PRD 零提匯率/金額聚合（0 命中）、`totalAmount` 僅在提取層出現、從不被任何報表聚合（屬**一致設計非遺漏**）；FX 真實目的是「單張金額一致化」非「財務聚合」。無明確業務需求 → 記 backlog，不動代碼。日後若有財務視圖需求再立 CHANGE，並建議用**正規化金額欄位**（`normalized_total`+`normalized_currency`）而非聚合 `field_mappings` JSON |
| 4 | FX 換算後值落 data template 的真實 E2E | 驗證缺口 | 待備妥 THB 發票 + Fairate FORMAT template mapping 後實證 |

---

*記錄建立：2026-06-02 | 方法：代碼追蹤 + DB 實證 | 無代碼修改*
