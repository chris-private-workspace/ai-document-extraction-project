# FIX-172: 模板實例列有 386 個指向已不存在文件的孤兒引用 —— `sourceDocumentIds` 無外鍵約束

> **建立日期**: 2026-08-07
> **發現方式**: 對 375 份樣本做 end-to-end 驗收、統計模板實例覆蓋率時，發現 `template_instance_rows` 引用的 document id 數量（753）遠多於現存文件數（646）
> **影響範圍**: `prisma/schema.prisma` `TemplateInstanceRow.sourceDocumentIds`、`template_instance_rows`、`src/services/template-instance.service.ts`、`src/services/template-matching-engine.service.ts`、`src/services/template-export.service.ts`
> **優先級**: 🟡 中（不影響實例既有數值，但已完成的實例失去來源追溯能力，且覆蓋率統計會被系統性低估）
> **狀態**: 📋 規劃中
> **相關**: [CHANGE-106](../feature-changes/CHANGE-106-template-instance-staleness-indicator.md)（實例快照過期偵測，已完成 —— 但該文件自身標註**無法偵測「重新上傳」造成的過期**，而重新上傳正是本問題的可能來源）、[CHANGE-114](../feature-changes/CHANGE-114-extraction-result-version-history-and-file-hash.md)（提取結果版本歷史 + 手動上傳 `file_hash`，待實作 —— 若實作後不再需要靠重新上傳保留歷史，本問題的產生速率會下降）、[FIX-160](FIX-160-template-mapping-unreferenced-extracted-charges.md)（模板映射漏接費用）

---

## 問題描述

`template_instance_rows.source_document_ids` 記錄每一列由哪些文件組成，但它是**純字串陣列，沒有外鍵關聯**。文件被刪除時：

- 資料庫**不會**阻擋刪除（無 FK 約束）
- **不會** cascade 清理實例列
- 實例列留下指向不存在文件的 id，且無任何痕跡

結果是實例本身還在、數字還在，但**追不回來源**。

---

## 資料證據（本地環境，2026-08-07）

### 一、超過半數的引用是孤兒

| 項目 | 數量 |
|---|---:|
| `template_instance_rows` 總數 | 929 |
| 其中 `source_document_ids` 為空者 | 0 |
| 被引用的相異 document id | 753 |
| 其中**對得上現存文件**者 | 367 |
| 🔴 **指向已不存在文件者** | **386** |

即 **51.3% 的引用是孤兒**。

### 二、集中在 CEVA 的 7 月實例

```
CEVA - import to inbound 5.0(7/23/2026)   COMPLETED  07-23 02:01   20 個孤兒引用
CEVA - import to inbound 7.0(7/23/2026)   COMPLETED  07-23 02:17   19
CEVA - import to Inbound 2.0(7/8/2026)    COMPLETED  07-08 03:38   18
CEVA - import to outbound 2.0(7/8/2026)   COMPLETED  07-08 08:38   12
CEVA - import to Inbound 3.0(7/8/2026)    COMPLETED  07-08 08:15   10
CEVA - import to Inbound 1.0(7/14/2026)   COMPLETED  07-14 07:35   10
CEVA - import to Inbound 7.0(7/14/2026)   COMPLETED  07-14 08:26   10
CEVA - import to Inbound 1.0(7/13/2026)   COMPLETED  07-13 05:45   10
```

這些實例狀態全是 `COMPLETED`，建立於 7 月上中旬 —— 與該期間密集的 CEVA 映射調查／重新上傳作業時間吻合。

---

## 代碼證據

`prisma/schema.prisma:3184`：

```prisma
model TemplateInstanceRow {
  id                 String   @id @default(cuid())
  templateInstanceId String   @map("template_instance_id")
  rowKey             String   @map("row_key")
  rowIndex           Int      @map("row_index")
  sourceDocumentIds  String[] @map("source_document_ids")   // ← 純陣列，無 relation
  ...
}
```

`sourceDocumentIds` 沒有對應的 `@relation`，因此資料庫層完全沒有參照完整性保護。對照同一個 model 的 `templateInstanceId`，也同樣是裸欄位。

`sourceDocumentIds` 在 7 個檔案中被使用（`template-matching-engine.service.ts`、`template-instance.service.ts`、`template-export.service.ts`、`auto-template-matching.service.ts` 等），皆假設 id 有效，**未見任何處理「引用文件已不存在」的分支**。

---

## 影響評估

| 面向 | 說明 |
|---|---|
| 追溯性 | 已完成／已匯出的實例無法回推來源文件，稽核時無法回答「這一列的數字從哪張發票來」 |
| 統計失真 | 用 `source_document_ids` JOIN `documents` 計算覆蓋率，會系統性低估。本次驗收初值 92.3% 即受此影響 |
| 匯出 | `template-export.service.ts` 若需回讀來源文件資訊，遇孤兒 id 的行為未經驗證 |
| 資料無法還原 | 文件已刪除，孤兒 id 對應的是什麼檔案**已無從得知** —— 這部分損失不可逆 |

⚠️ 實例列自身的 `field_values` 仍完整，**既有數值不受影響**，這不是數值正確性問題，是追溯性問題。

---

## 尚未查明的部分

以下需進一步調查才能定修法，目前**不作結論**：

1. **文件是怎麼消失的** —— 是使用者主動刪除、批次清理、或某個流程會取代文件記錄？尚未查證。這決定修法要防的是哪個入口。
2. **是否有刪除文件的功能路徑會連帶清理實例列** —— 已知 schema 層沒有 cascade，但服務層是否有補償邏輯尚未逐一檢查。
3. **匯出遇孤兒 id 的實際行為** —— 是靜默略過、丟錯、還是輸出空值，需實測。

---

## 待決策的修法選項

**尚未拍板**：

| 選項 | 作法 | 代價 / 風險 |
|---|---|---|
| A | 加外鍵 + `onDelete: Restrict`：有實例引用的文件不得刪除 | 需 migration；**既有 386 個孤兒會讓 migration 失敗**，必須先清理或改用 `SetNull` 類作法 |
| B | 加外鍵 + `onDelete: Cascade` | 🔴 危險：刪一份文件會連帶刪掉實例列，等於默默改動已完成的實例數值 |
| C | 不改 schema，改在服務層刪除文件時檢查並警告 | 繞不過直接對 DB 操作的情況，但改動最小 |
| D | 保留快照：實例列建立時一併存下檔名／發票號，不只存 id | 追溯性不依賴文件是否存在；需新增欄位與回填 |

⚠️ 選項 A 有個前提陷阱：既有 386 個孤兒引用會讓加 FK 的 migration 直接失敗。要走 A 就必須先決定那些孤兒怎麼處理，而它們對應的文件**已無法還原**。

⚠️ 選項 B 絕不可在未經明確批准下採用 —— 它會讓刪除文件這個動作靜默改變已完成／已匯出實例的內容，且本專案 `template_instance_rows` 無 audit log 亦無 rollback。

任何清理既有孤兒引用的動作屬不可逆資料操作，需走 CLAUDE.md §不可逆資料操作紀律的三段式流程（前置快照／單一交易／數量閘／樂觀鎖／冪等）。

---

## 驗收判準（修法確定後才適用）

- [ ] 新建立的實例列，其 `source_document_ids` 皆指向現存文件
- [ ] 刪除被實例引用的文件時，行為明確（阻擋／警告／記錄），非靜默
- [ ] 既有 386 個孤兒引用的處置已決定並記錄
- [ ] 覆蓋率統計不再因孤兒引用而低估
