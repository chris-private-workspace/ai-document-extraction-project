# Azure DEV 資料修復記錄：CEVA 雙版面格式歸位（2026-07-20）

> **環境**: Azure DEV（資料面變更，未動映像）
> **範圍**: `document_formats` 2 筆記錄
> **結果**: ✅ `VERIFY_PASS` —— 主公司名下自此有 `GENERAL` + `OCEAN_FREIGHT` 兩個格式
> **關聯**: [FIX-115](../../../../claudedocs/4-changes/bug-fixes/FIX-115-stage2-prompt-missing-knownformats-variable.md)、[FIX-121](../../../../claudedocs/4-changes/bug-fixes/FIX-121-identification-rules-inline-variability-annotation.md)

---

## 1. 背景：FIX-115 在 Azure 為何沒有效果

部署 FIX-115（Stage 2 prompt 注入 `${knownFormats}`）後，查證 Azure 實際資料才發現前提不成立：

- CEVA 在 Azure 有 **8 筆公司記錄**，其中 7 筆 `status = MERGED`、`merged_into_id` 均指向主公司 `CEVA LOGISTICS (HONG KONG) LTD`（`0d02b680-…`）
- 合併**已經做過**，但 `mergeCompanies` 只轉移 `documents` / `extractionResults` / `mappingRules`，**未轉移 `documentFormat`**
- 結果：8 個格式散落在 8 間公司身上，主公司名下**只有 1 個**

Stage 2 依 `companyId` 撈 `knownFormats`，因此清單永遠只有一個選項 —— 注入了也無從選擇，FIX-115 的修復無從發揮。

> 🔴 `mergeCompanies` 漏轉關聯資料是**產品缺陷**，本記錄僅修資料，缺陷本身另行處理（另外 `7448b7c5-…` 還遺留 4 筆 `template_field_mappings` + 1 筆 `field_definition_sets` 未轉移）。

## 2. 版面歸類

讀取 8 個格式的 `identificationRules` 後，明顯分為兩種版面：

| 版面 | 特徵 | 數量 |
|------|------|-----:|
| A | 藍字 `INVOICE`、`CHARGES` 區塊、`Total Charges` | 3 |
| B | `Original INVOICE` 黑框、Vessel/Voyage、`TOTAL TO BE PAID`、QR/條碼 | 5 |

主公司持有的是 **A**，因此 B 版面文件永遠匹配不到、只能落入 JIT。

選 `cmrbtlqua…`（8 個之中唯一提到「條碼/QR 圖示」者，與本地驗證的版面 B 特徵吻合）作為 B 的代表。

## 3. 變更內容

`document_formats` 有唯一鍵 `(company_id, document_type, document_subtype)`，而 8 個格式全是 `INVOICE / GENERAL`，故 B 轉移時必須改 subtype。

| # | 對象 | 變更 |
|---|------|------|
| 1 | `cmrbtlqua034k01o3r9mg442g` | `company_id` → 主公司；`document_subtype` `GENERAL` → `OCEAN_FREIGHT`；`identification_rules` → 版面 B keywords（12 條） |
| 2 | `cmquo0p50000h01kg8hpd5sqb` | `identification_rules` → 版面 A keywords（10 條） |

keywords 取自 [FIX-121](../../../../claudedocs/4-changes/bug-fixes/FIX-121-identification-rules-inline-variability-annotation.md) 已驗證的版本（保留具體錨點、就地標註可變部位），全文見 [`company-multi-format-setup-guide.md`](../../../../claudedocs/reference/company-multi-format-setup-guide.md) §實例。

**名稱未更動** —— 嚴守核准範圍。

### 執行方式

Kudu ad-hoc（比照 FIX-105 / FIX-110）：腳本上傳至 `/home/ops-ceva`、`npm install pg@8.7.3`、先 `dryrun` 再 `write`，兩筆 UPDATE 包在單一交易內。

### 驗證結果

```
前置檢查：主公司無 INVOICE/OCEAN_FREIGHT，可安全轉移
已寫入：B=1 筆、A=1 筆
--- AFTER：主公司名下所有格式 ---
  cmquo0p50000h01kg8hpd5sqb | GENERAL       | kw_count=10
  cmrbtlqua034k01o3r9mg442g | OCEAN_FREIGHT | kw_count=12
VERIFY_PASS
```

## 4. 🔴 回滾資料（變更前原值）

若需還原，依下列原值反向 UPDATE 即可。

### `cmquo0p50000h01kg8hpd5sqb`（版面 A，原屬主公司）

- `company_id`: `0d02b680-165b-4cfd-8c1b-7ebfa6da8424`（未變動）
- `document_subtype`: `GENERAL`（未變動）
- `updated_at`: `2026-06-26T08:24:39.492Z`
- `identification_rules.keywords`（9 條）:

```json
[
  "頁首左上有 CEVA Logistics 信頭文字（公司地址/聯絡資訊），右上有 CEVA 標誌（CEVA/雙字母視覺）",
  "標題為『INVOICE』，並在標題下方顯示發票編號（格式如 2532500322484 類似長數字）",
  "右上區塊為方框/表格樣式的發票關鍵欄位：Invoice Date、Shipment/Reference 編號、Terms/Service 等，採深色標籤+白底欄位",
  "中上方有『SHIPMENT DETAILS / CONSIGNEE / GOODS DESCRIPTION』等以分段式橫向表格呈現的資訊區塊",
  "費用/收費明細以『CHARGES』區塊呈現，採多欄表格（例如 Fee/Description、Amount 類似欄位），文字以較小字體緊湊排列",
  "商品/貨品描述為段落式或小表格行，包含貨物名稱與重量/件數等欄位（如 GROSS/NET WEIGHT、PACKAGE 等）",
  "右下/下方有合計彙總表格：Subtotal、Taxes/Charges、Total Charges（並顯示 Total Charge Currency）",
  "底部/下方有收款資訊或自訂欄位（如 CUSTOMER / BANK/地址或備註），仍保持表格框線與網格版面",
  "整體版面為單頁（Page 1 of 1）且使用固定網格、框線與標籤欄位，屬物流公司標準發票版型"
]
```

### `cmrbtlqua034k01o3r9mg442g`（版面 B，已轉移）

- `company_id`: **`ee91a1cf-7cdf-4af5-8586-21ad91090dd6`**（`CEVA Logistics Hong Kong Limited`，`status=MERGED`）
- `document_subtype`: **`GENERAL`**
- `updated_at`: `2026-07-08T08:33:04.546Z`
- `identification_rules.keywords`（8 條）:

```json
[
  "右上角有方框標題 'Original INVOICE'，並包含欄位 'No'、'Date'、'Due'、'Customer' 等",
  "左上角有 CEVA LOGISTICS 標誌與 'CEVA Logistics' 信頭，且文件左上有條碼/QR 圖示",
  "信頭下方為客戶/聯絡與文件編號區塊，出現 'Client Tax ID'、'Shipment'、'Shipper'、'Consignee'、'Notify/Email' 等多行文字欄位",
  "中央/下方包含分區表格：Shipper / Consignee / Vessel / Voyage 等並行欄位（橫向表格佈局）",
  "行項目（費用明細）採用清單式表格，含列名如 'CURRENCY'、'DESCRIPTION OF CHARGES'、'QTY'、'AMOUNT'，並以多行說明文字堆疊在同一列",
  "底部有金額彙總區塊：'TOTAL TO BE PAID BEFORE'、'TOTAL TO BE PAID'，並以港幣顯示（如 'HKD'）",
  "底部包含地址/付款相關資訊的區塊，並在右下角標示 'PAGE 1 OF 1'",
  "日期格式看起來為日/月/年（例如 '30-Apr-...' 類型），金額使用一般十進位且標示貨幣代碼（HKD）"
]
```

> ⚠️ 回滾時注意：把 B 的 subtype 改回 `GENERAL` **之前**必須先把 `company_id` 改回 `ee91a1cf-…`，否則會撞主公司既有的 `INVOICE/GENERAL` 唯一鍵。

## 5. 未處理事項

| # | 項目 | 說明 |
|---|------|------|
| 1 | 6 個孤立格式 | 仍掛在 MERGED 公司名下。`DocumentFormat` 無 `isActive` 欄位，只能刪除（不可逆），故先保留觀察 |
| 2 | `7448b7c5-…` 的 4 筆 template_field_mappings + 1 筆 field_definition_sets | 主公司已有同數量，需先比對內容是重複或互補 |
| 3 | `mergeCompanies` 漏轉關聯資料 | 產品缺陷，建議另立 FIX |
| 4 | RICON / RICH ASIA 歸屬 | `RICON ASIA PACIFIC OPERATIONS LIMITED`（`cb65726b-…`）為 ACTIVE、有 3 份文件、未合併；與已併入 CEVA 的同名（帶後綴）記錄關係待業務確認 |
| 5 | 端到端驗證 | 需重跑一份 B 版面 CEVA 文件，確認命中 `OCEAN_FREIGHT` 格式且 `isNewFormat=false` |

---

*文件建立日期: 2026-07-20*
