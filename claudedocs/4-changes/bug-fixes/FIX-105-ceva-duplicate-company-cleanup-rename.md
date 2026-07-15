# FIX-105: CEVA 公司重複記錄清理 + 主檔正名

> **日期**: 2026-07-10
> **狀態**: ✅ 本地已修復 / ⏳ Azure DEV 待同步
> **嚴重度**: Sev3（資料品質；不影響處理成功率，影響公司名顯示正確性）
> **類型**: Bug Fix（資料治理 — 公司重複）
> **影響範圍**: 本地 DB `companies` / `document_formats`（Azure DEV 待確認）

---

## 問題描述

測試文件 `CEVA_RCIM250306_20874.PDF` 重新處理後,UI 顯示識別公司含「office」字樣,與文件實際公司名「CEVA LOGISTICS (HONG KONG) LTD」不符,使用者回報「識別為錯的公司」。

## 根因分析（Stage 1 識別其實正確）

追查 `extraction_results.stage_1_ai_details` 的 GPT 原始回應:

```json
{
  "name": "CEVA LOGISTICS (HONG KONG) LTD",
  "identificationMethod": "HEADER",
  "confidence": 98,
  "matchedKnownCompany": "CEVA Logistics (Aliases: CEVA LOGISTICS (HONG KONG) OFFICE, CEVA Logistics Hong Kong Office)",
  "rawText": "CEVA LOGISTICS (HONG KONG) LTD"
}
```

**GPT 讀對了**（rawText = 正確全名）、也**綁對了主力記錄**（company_id `0d02b680`,55 文件 + 1 mapping）。問題在**公司主檔資料髒**:

| 問題 | 內容 |
|------|------|
| 主力名稱非全名 | `0d02b680` 的 `name` = 「CEVA Logistics」(簡稱,非文件全名) |
| 別名汙染 | `name_variants` = `{"CEVA LOGISTICS (HONG KONG) OFFICE","CEVA Logistics Hong Kong Office"}`（誤導的 OFFICE，是 UI 顯示 office 的來源） |
| 重複孤兒公司 | `e5c10904`「CEVA LOGISTICS (HONG KONG) OFFICE」、`e8cff6fb`「CEVA Logistics Hong Kong Office」——各 0 文件、0 mapping |
| 孤兒格式 | 上述 2 孤兒公司各綁 1 筆 `document_formats`（CEVA 發票版面），經查 0 引用（無 field def / prompt / mapping / 文件） |

> 屬 memory 記錄的反覆問題：公司重複（90% 模糊閾值 + 空 name_variants 致 AI 各建新記錄）。此次孤兒為 0 關聯，可直接清理，無需 mergeCompanies 轉移。

## 修正內容（本地已執行，交易原子性）

```sql
BEGIN;
-- 1) 正名主力 0d02b680
UPDATE companies SET
  name='CEVA LOGISTICS (HONG KONG) LTD',
  display_name='CEVA LOGISTICS (HONG KONG) LTD',
  name_variants='{"CEVA Logistics"}'
WHERE id='0d02b680-165b-4cfd-8c1b-7ebfa6da8424';
-- 2) 刪孤兒格式（子）→ 孤兒公司（父）
DELETE FROM document_formats WHERE id IN ('cmqup5sgq000mpkxgqmub3h72','cmqup5vmy000npkxgbr62ip18');
DELETE FROM companies WHERE id IN ('e5c10904-5d9d-42c4-ba0e-3aa0c969abf2','e8cff6fb-91d1-46a2-990c-599c8b6c0be3');
COMMIT;
```

結果：`UPDATE 1、DELETE 2、DELETE 2`。CEVA 只剩 1 筆乾淨記錄（name = 全名、name_variants = `{"CEVA Logistics"}`）。

## 刪除安全性驗證（執行前）

- 2 孤兒公司在全部 16 個含 `company_id` 的表：僅 `document_formats` 各 1 筆（其餘全 0）。
- 2 孤兒格式在全部 6 個含 `document_format_id` 的表：全 0 引用。
- → 整條孤兒鏈（2 公司 + 2 格式）為死資料，安全刪除。

## 回滾資訊（被刪記錄）

| 類型 | id | name |
|------|-----|------|
| company | e5c10904-5d9d-42c4-ba0e-3aa0c969abf2 | CEVA LOGISTICS (HONG KONG) OFFICE |
| company | e8cff6fb-91d1-46a2-990c-599c8b6c0be3 | CEVA Logistics Hong Kong Office |
| format | cmqup5sgq000mpkxgqmub3h72 | CEVA Logistics 版式的 Freight Invoice… |
| format | cmqup5vmy000npkxgbr62ip18 | CEVA Logistics（INV）運費/清關費用發票標準版面 |

主力 `0d02b680` 原值：name/display_name = 「CEVA Logistics」、name_variants = 上述 2 OFFICE。

## 驗收

| # | 項目 | 標準 | 狀態 |
|---|------|------|------|
| 1 | CEVA 唯一記錄 | companies 中 CEVA 只剩 0d02b680 | ✅ |
| 2 | 主力正名 | name/display_name = 「CEVA LOGISTICS (HONG KONG) LTD」 | ✅ |
| 3 | 別名清理 | name_variants = `{"CEVA Logistics"}` | ✅ |
| 4 | 文件不受影響 | 55 文件 + mapping 仍綁 0d02b680 | ✅ |
| 5 | UI 顯示正確 | 文件詳情顯示正確公司名 | ⏳ 待使用者 UI 驗證 |
| 6 | Azure DEV 同步 | Azure DB 若有同樣髒資料，比照清理 | ⏳ 待辦 |

## 待辦

1. **UI 驗證**：刷新 `CEVA_RCIM250306_20874.PDF` 詳情頁，確認公司名顯示「CEVA LOGISTICS (HONG KONG) LTD」。
2. **Azure DEV 同步**：需先 inspect Azure `companies` 的 CEVA 記錄（id 與本地不同），確認是否同樣有重複/OFFICE 別名，再以 gated 腳本比照清理。
3. **普遍性評估（選）**：其他 forwarder 是否也有 name_variants 汙染 / 重複孤兒，可另立盤點。
