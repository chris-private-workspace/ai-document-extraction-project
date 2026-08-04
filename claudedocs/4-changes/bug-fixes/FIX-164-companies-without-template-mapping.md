# FIX-164: 兩家公司沒有任何 template mapping —— 27 份文件無法匹配

> **建立日期**: 2026-08-04
> **發現方式**: 375 份樣本全覆蓋驗證，建 instance 前的適用性檢查（[TEST-REPORT-006](../../5-status/testing/reports/TEST-REPORT-006-full-sample-coverage-verification.md)）
> **影響範圍**: `template_field_mappings` 的公司覆蓋 → `/api/v1/template-matching/execute`
> **優先級**: 中（27 份已提取完成的文件無法進入模板，佔全樣本 7.2%）
> **狀態**: 📋 規劃中
> **相關**: [FIX-159](FIX-159-toll-cross-border-entities-merged-by-normalization.md)（Toll 跨境實體拆分，本問題為其直接後果）

---

## 問題描述

模板匹配引擎只套用 `scope = GLOBAL` 或 `companyId` 相符的 mapping。以下兩家公司在兩套 Full List 模板下**一筆適用 mapping 都沒有**，`execute` 會回 `MAPPING_NOT_FOUND`：

| 公司 | `companyId` | 方向 | 文件數 |
|---|---|---|---:|
| Toll Global Forwarding (Hong Kong) Ltd | `1ce60466-ecfa-4e82-aee0-13c3ccccc192` | export | 12 |
| Toll Global Forwarding (Hong Kong) Ltd | 同上 | import | 14 |
| UNIT INTERNATIONAL LOGISTICS (HK) LTD. | `923bfda2-9bc0-48c5-8fc2-3e29f9c95066` | import | 1 |
| **合計** | | | **27** |

這 27 份文件**已經提取完成**（狀態 `MAPPING_COMPLETED`、有 `extraction_results`），錢都抽出來了，只是沒有規則能把它們放進模板。

本次驗證未替這三組建立 instance —— 建了也只會 `MAPPING_NOT_FOUND`，徒留空實例。

---

## 成因

### Toll Global Forwarding (Hong Kong) Ltd —— FIX-159 的直接後果

[FIX-159](FIX-159-toll-cross-border-entities-merged-by-normalization.md) 把因 `normalizeCompanyName` 而被併成一筆的 Toll 泰國／香港實體做了資料層拆分，新建了香港記錄。但**新公司記錄沒有對應的 mapping** —— 既有的 `Toll Global Forwarder Limited - Logistics Cost - Inbound/Outbound Template (Full List)` 綁在另一個 `companyId` 上。

拆分當時未同步建立 mapping，是 FIX-159 未竟的部分。

### UNIT INTERNATIONAL LOGISTICS (HK) LTD.

僅 1 份文件（來自 SBS 樣本夾），此公司是否為既有公司的別名、或是首次出現的新 forwarder，**尚未查證**。

🔴 在確認它是不是既有公司的變體之前，不應直接建 mapping —— 若它其實是 RICOH／SBS 的另一種寫法，正確處置是合併公司而不是新增設定。

---

## 建議處置（待使用者拍板）

### Toll 香港實體

| 選項 | 作法 | 考量 |
|---|---|---|
| **A. 複製既有 Toll mapping** | 以 `Toll Global Forwarder Limited` 的 Inbound/Outbound mapping 為範本，建立指向香港 `companyId` 的新記錄 | 需先確認兩個實體的費用結構是否相同 —— 泰國與香港的收費項目可能不同 |
| **B. 改為 GLOBAL scope** | 讓既有 mapping 對兩家都適用 | 🔴 風險高：GLOBAL 會套用到**所有**公司，可能影響無關的 forwarder |
| **C. 逐一比對後客製** | 先看香港這 26 份的實際費用欄位，再決定規則 | 最穩妥，工作量最大 |

**建議 C 或 A** —— 先看資料再決定。這 26 份已有提取結果，可直接統計它們用到哪些費用 key，與泰國實體的 mapping 對照。

### UNIT INTERNATIONAL LOGISTICS

先查證公司身分，再決定是合併還是新建設定。查證方式：比對 `stage_1_result` 中的原始公司名寫法與既有公司的 `nameVariants`。

---

## 變更範圍（🔴 修法確定後須精確指名）

| 項目 | 值 |
|---|---|
| 資料表 | `template_field_mappings`（新增記錄，指定 `company_id` 與 `data_template_id`） |
| 不動 | `data_templates`（影響全部共用公司） |
| 不動 | 既有 `Toll Global Forwarder Limited` 的兩筆 mapping |

---

## 驗證方式

建立 mapping 後：

1. 以 `check-mappings.js` 確認三組都變為「有適用 mapping」
2. 建 instance 並執行 `execute`，確認不再回 `MAPPING_NOT_FOUND`
3. 以 `verify-instances.js` 追溯，確認列合計與 `total_amount` 相符

⚠️ 新增 mapping 後必須跑 `scripts/check-orphan-charge-keys.js` —— 新規則可能與既有規則競爭同一筆費用的去處。

---

**建立者**: AI 助手
**最後更新**: 2026-08-04
