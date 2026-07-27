# CHANGE-106: Template Instance 快照過期無提示，使用者誤判「修改沒生效」

> **建立日期**: 2026-07-22
> **提出背景**: Azure DEV 測試期間，使用者反覆調整 mapping 設定並重新處理文件，但畫面上看到的仍是舊快照
> **影響頁面/功能**: Template Instance 列表與明細
> **優先級**: 中（不影響資料正確性，但嚴重影響除錯效率與對系統的信任）
> **狀態**: ✅ 已完成（2026-07-22 方案 A 唯讀標記；B 一鍵重跑視使用情況另立 CHANGE）
> **⚠️ 2026-07-27 Azure 實機驗證發現重要限制**：機制本身正確運作，但**無法偵測「重新上傳」造成的過期** —— 而本 CHANGE 的觸發事件正是這一種。詳見 §Azure 實機驗證。

---

## 背景與問題

Template Instance 產生時會把當下的欄位值寫入 `template_instance_rows.field_values`，此後**不會**因為下列事件而更新：

- 來源文件被重新處理（提取結果改變）
- Template Field Mapping 的規則或公式被修改
- Field Definition Set 被調整

介面上沒有任何標示指出「這一列的來源已經變了」。使用者調完設定後回頭看舊 instance，看到數字沒變，合理地推論「我的修改沒生效」，於是繼續調整 —— 而問題可能早就修好了。

這在本次測試中造成實際誤判。

---

## 實測證據（Azure DEV，2026-07-22）

`CEVA_RCIM250325_17865.PDF`：

| 來源 | 內容 |
|---|---|
| 目前的 `stage_3_result.lineItems` | `BASIC FREIGHT CHARGE` 1330.32、`DESTINATION THC` 712.71、`DELIVERY ORDER FEE` 628.71、`OTHER DESTINATION CHARGE` 201.34（合計 2873.08 = 發票 subtotal ✓） |
| 最新的 template instance（2026-07-14 07:36） | `freight=170`、`thc=2885`、`docs_fee=2545`、`others_local_charge=815` |

instance 的數字在目前的提取結果中**完全不存在** —— 文件於 2026-07-21 被重新處理過，instance 停留在 7 天前的快照。

同一批資料中另有正面對照：`CEVA_RCIM250004_05808.pdf` 的 instance 歷史清楚顯示修正生效的時間點：

```
7/8 – 7/14 07:36   thc=13080   freight=2490      ← 取到發票的「原幣金額」欄
7/14 08:19         thc=3075.64 freight=19508.31  ← 取到「HKD 金額」欄 ✓
```

若當時介面能標示「此 instance 的來源已更新」，使用者就不需要靠比對數字來判斷哪一版才是最新的。

---

## 需求描述

讓使用者能一眼看出某個 template instance（或其中某幾列）是否已經過期，並能便捷地重跑。

### 建議行為

1. Instance 列表／明細顯示「來源已更新」標記 —— 判斷依據為：任一來源文件的 `updated_at`（或 `processing_ended_at`）晚於該 row 的 `updated_at`
2. 標記可下鑽，顯示是哪幾份文件、更新於何時
3. 提供「重新產生」入口
4. （選用）mapping 設定被修改時，一併視為過期依據

---

## 方案選項

| 選項 | 方案 | 優點 | 代價 |
|------|------|------|------|
| **A** | **唯讀標記**：僅比對時間戳並顯示標記，不提供任何自動化 | 實作最輕；零風險（不動任何資料） | 使用者仍需手動重跑 |
| **B** | **標記 + 一鍵重跑**：A 之外提供「重新產生此 instance」按鈕 | 解決完整的使用流程 | 需釐清重跑時人工修正過的值如何處理（覆蓋？保留？提示？） |
| **C** | **自動重跑**：偵測到來源更新即自動重新產生 | 使用者永遠看到最新值 | ❌ **不建議** —— 會靜默覆蓋人工修正；且大量文件重處理時會觸發大批重算 |
| **D** | **不做標記，改為即時計算**：instance 不存快照，每次開啟都即時算 | 永遠最新 | ❌ 架構變更（H1）；且失去「當時送出的數字」這個稽核價值 |

### 建議

**A 先做，B 視情況跟進**。理由：
- A 能解決 90% 的誤判（使用者只要知道「這是舊的」就會自己重跑）
- B 的價值在便利性，但**必須先回答「人工修正過的值怎麼辦」**。目前 `template_instance_rows` 有 `status` 與 `validation_errors`，是否有人工編輯的痕跡需要先確認
- C 明確排除：靜默覆蓋人工修正是不可接受的副作用
- D 明確排除：屬架構變更，且快照本身有稽核價值（記錄「當時送出什麼」）

---

## 實作記錄（2026-07-22，方案 A）

判斷依據採 `documents.processing_ended_at`（只在重新處理完成時更新）而非 `updated_at`——後者會因審核、改公司等無關操作變動，會產生假陽性標記（違反「來源未更新不顯示標記」的驗收要求）。`processing_ended_at` 為 null 時不視為過期。

| 層 | 檔案 | 改動 |
|---|---|---|
| 型別 | `src/types/template-instance.ts` | 新增 `StaleSourceDocument`；`TemplateInstanceRow` 加 `staleSources?` |
| 服務 | `src/services/template-instance.service.ts` | `getRows` 的來源文件批量查詢（CHANGE-091 1.6 既有掛點）擴充 `processingEndedAt`，逐行計算 `staleSources`（文件處理完成時間晚於行的 `updatedAt` 者） |
| 組件 | `InstanceRowsTable.tsx` | 來源文件欄顯示琥珀色「來源已更新」badge + tooltip（含過期文件數） |
| 組件 | `RowDetailDrawer.tsx` | 頂部琥珀警示：逐份列出過期來源文件 + 重新處理時間（下鑽需求），並提示重新執行模板匹配 |
| i18n | `messages/{en,zh-TW,zh-CN}/templateInstance.json` | `rows.staleBadge` / `rows.staleTooltip` / `rowDetail.staleSources.*` |
| 測試 | `tests/unit/services/template-instance-staleness.test.ts`（新建） | 5 項：過期標記 / 早於不標 / null 不標 / 多來源僅列更新者 / 無來源不查詢 |

範圍註記：標記為 **row 級**（rows 列表 + 明細抽屜）；instance 卡片級的聚合標記需對每個 instance 掃全部 rows，成本高且方案 A 不要求，未做。「重新產生」入口為方案 B 範圍（需先釐清人工修正值的覆蓋語意），未做。

**rollback**：無 schema 變更、無 flag；回退＝重部署舊映像。

---

## 驗收標準

- [ ] ~~`CEVA_RCIM250325_17865.PDF` 的 instance 顯示「來源已更新」標記~~ → **2026-07-27 實測：不會顯示，且這不是 bug** —— 該實例的來源文件記錄從未被重新處理過（7/21 那次是**重新上傳**，產生了另一筆 document 記錄）。詳見 §Azure 實機驗證
- [x] 標記可指出來源文件的更新時間晚於 row 的更新時間 → RowDetailDrawer 逐份列出重新處理時間（2026-07-27 實機驗證渲染正確）
- [x] 來源未更新的 instance **不顯示**標記（避免噪音）→ 2026-07-27 實測 522 個 row **0 個誤標**
- [ ] 若採方案 B：重跑前明確告知將覆蓋哪些值 → 本次採方案 A，B 視使用情況另立 CHANGE
- [x] UI 字串三語言同步（`messages/{en,zh-TW,zh-CN}`）+ `npm run i18n:check` 通過
- [x] `npm run type-check` / `npm run lint` 通過（改動檔 0 新增警告）

---

## Azure 實機驗證（2026-07-27）

線上映像自 `dev-fix126-130-ch106-20260722135255`（7/22）起即含本功能；本次補做執行期驗證。

### 已驗證通過

| 項目 | 方法與結果 |
|---|---|
| 功能確實在線上 | 掃描全部 113 個有列的實例、**522 個 row，每一個都帶 `staleSources` 欄位** |
| 不誤標（負向驗收） | 522 個 row 中 **0 個**被標記 |
| 判斷式計算正確 | 對 7/14 實例 `cmrkc7ajs` 的 10 個 row **逐一取來源文件的 `processingEndedAt` 自行重算**，與 API 的 `staleSources` **10/10 完全一致** |
| Badge 渲染 | 琥珀色「來源已更新」+ `refresh-cw` 圖示（`border-amber-500/60 bg-amber-50 text-amber-700`）；同表格中未過期的列**無** badge |
| 抽屜下鑽 | 「以下來源文件在本列產生後被重新處理…」+ 逐份列出檔名與時間，時區換算正確（7/21 10:19 UTC → 顯示 18:19） |
| i18n | 三語言字串正常，無缺 key |

> Badge 與抽屜的驗證方法：由於當下無任何過期 row，改以**瀏覽器端攔截 API 回應注入 `staleSources`** 來觸發渲染。全程只改瀏覽器內的回應物件，**未寫入任何伺服器資料**。
>
> 過程中一度看到「重新處理於」後方為空 —— 查證後確認是我注入時把欄位名寫成 `processingEndedAt`（正確為 `StaleSourceDocument.processedAt`），改正後時間正常顯示。**元件無 bug。**

### 🔴 重要限制：偵測不到「重新上傳」造成的過期

`CEVA_RCIM250325_17865.PDF` 在 Azure DEV 有 **15 筆各自獨立的 document 記錄**（每次處理都新建，不是原地更新）。§實測證據 描述的兩個時間點其實分屬**不同記錄**：

| document ID | `processingEndedAt` | `templateInstanceId` |
|---|---|---|
| `714ac520` | 2026-07-14 07:28:30 | `cmrkc7ajs…`（§實測證據 的那個 7/14 實例）|
| `7c3e3981` | 2026-07-21 10:19:19 | **null** |

7/14 實例的 row 4 指向的是 `714ac520`，其 `processingEndedAt`（07:28:30）**早於** row 的 `updatedAt`（07:36:04）—— 判斷式正確地不標記。而 7/21 的「重新處理」其實是重新上傳，資料落在 `7c3e3981`，與該 row 毫無關聯，`714ac520` 自 7/14 後從未被動過。

**因此**：

| 情境 | 是否偵測得到 | 原因 |
|---|---|---|
| **原地重新處理**（文件詳情頁重試 → `POST /api/documents/[id]/process`）| ✅ 可以 | `processing-result-persistence.service.ts` 對**同一筆**記錄寫 `processingEndedAt: new Date()` |
| **重新上傳同一份發票** | ❌ 不行 | 產生新 document 記錄；舊 row 的來源文件確實沒變 |
| **Mapping 設定被修改** | ❌ 不行 | §建議行為 第 4 項（選用）未實作 |

全庫 522 個 row 皆未標記，也印證了此環境的實際工作流是「重新上傳」而非原地重試。

**這代表本 CHANGE 的觸發事件（使用者調完設定看到舊數字、誤判修改沒生效）在當前實作下仍不會得到提示。** 機制對其自身規格（`processing_ended_at > row.updatedAt`）是正確的，但那個規格涵蓋不到實際的使用方式。

### 附帶確認：`processing_ended_at` 而非 `updated_at` 的選擇是對的

7/14 實例那 10 份來源文件的 `documents.updated_at` **全部是同一個值** `2026-07-14T07:36:04.809Z`，即模板匹配回寫時一併蓋上的時間戳。若當初採 `updated_at` 判斷，每一列在產生的同一刻就會全部變「過期」—— 100% 假陽性。§實作記錄 的這個決定，現在有了實測依據。

### 建議後續（需使用者決定，未擅自實作）

| 選項 | 內容 |
|---|---|
| A | 把「同一發票存在更新的 document 記錄」納入過期依據（需先定義如何認定「同一發票」—— `fileHash`？`referenceNumber`？）|
| B | 實作 §建議行為 第 4 項：mapping / field definition set 被修改也視為過期依據 |
| C | 維持現狀，並在文件中明確記載此限制（本節已完成）|

---

## 相關文件

- [FIX-130](../bug-fixes/FIX-130-existing-config-correction-checklist.md) —— 項目 6：需重跑的既有 instance
- [CHANGE-091] —— Template Instance 流程 UX 與非同步進度（Phase 2 待實作，可評估併入）
- [CHANGE-037] —— Data Template 流程完成
