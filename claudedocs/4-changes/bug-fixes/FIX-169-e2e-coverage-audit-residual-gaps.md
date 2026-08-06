# FIX-169: e2e 端到端覆蓋率盤點 —— 補救紀錄與殘餘 4 份缺口

> **建立日期**: 2026-08-06
> **發現方式**: 本輪 e2e 盤點（375 份本機樣本）為推進覆蓋率做了三批**不可逆資料寫入**，事後發現這些寫入沒有任何 CHANGE/FIX 文件承載 —— 回滾依據只存在於腳本的常數裡，量測口徑只存在於當次的終端輸出裡
> **影響範圍**: `template_instances` / `template_instance_rows` / `template_field_mappings` / `field_definition_sets` / `extraction_results` 的本機資料；不涉及應用程式碼
> **優先級**: 中（資料已寫入且驗證通過，風險不在於「錯」而在於「無紀錄」—— 沒有文件則回滾依據與量測口徑會隨 session 結束而消失）
> **狀態**: 🚧 部分完成（2026-08-06 —— 補救與量測已完成並重新驗證，見 §量測結果；殘餘 4 份缺口逐份根因已查明但**皆未處理**，見 §殘餘缺口）
> **相關**: [FIX-165](FIX-165-auto-template-matching-never-ran.md)（自動匹配從未運作，是 ③ 缺口的成因）、[FIX-159](FIX-159-toll-cross-border-entities-merged-by-normalization.md)（Toll 跨國實體拆分，其設定缺口是 Toll 34 份的成因）、[FIX-164](FIX-164-companies-without-template-mapping.md)（公司無 template mapping）

---

## 問題描述

本輪以本機 375 份樣本做端到端盤點，過程中為了把覆蓋率推上去，執行了三批寫入：

| 批次 | 對象 | 規模 |
|---|---|---|
| A | `template_instances` + `template_instance_rows` | 1 實例 / 52 列 |
| B | `field_definition_sets` + `template_field_mappings` | 1 欄位集 / 2 筆映射 |
| C | `extraction_results`（重新提取覆寫）+ 實例列 | 34 筆覆寫 / 2 實例 / 32 列 |

三批都走完了 §不可逆資料操作紀律 的 inspect → dryrun → write，也都留了前置快照與可歸因標記。**但沒有任何 CHANGE/FIX 文件記下這些標記是什麼。** 標記只寫在腳本的 `RUN_TAG` 常數裡，量測的分母定義只存在於當次終端輸出裡。腳本可以被刪、終端輸出必然消失，屆時這批資料就會變成「不知道誰寫的、不知道怎麼還原」的狀態 —— 這正是本專案寫入路徑無 audit log、無 rollback 機制下最該避免的形態。

本 FIX 的作用就是把量測口徑、可歸因標記、回滾依據、殘餘缺口固化成文件。

---

## 量測方法

腳本：`scripts/tmp-e2e-coverage-audit.ts`（**唯讀**，故不套用三段式 gated 流程）

### 分母定義

分母 = 來源資料夾 PDF 以 `norm()` 去重後的**相異檔名數**。

```
375 個實體 PDF 檔  →  351 個相異檔名  （24 份為雙資料夾放置或帶 (n) 後綴的重複下載）
```

`norm()` 與 `scripts/tmp-match-remaining-documents.ts` 完全相同（去副檔名 → 去 ` (n)` 尾綴 → 去尾端數字 → 收斂空白 → 轉小寫），確保兩份報告的分母可直接對照。

### 三層收斂

| 層 | 判準 | 關係 |
|---|---|---|
| ① 入庫 | 來源檔名在 `documents` 找得到對應紀錄 | — |
| ② 提取成功 | 該文件有 `extraction_results`（唯一約束，一份文件最多一筆） | ⊆ ① |
| ③ 進實例列 | 該文件 id 出現在任一 `template_instance_rows.source_document_ids` | ⊆ ② |

逐層收斂的用意：任一層的缺口就是**該層**的待辦來源，不會把「沒進實例列」誤讀成「提取失敗」。

---

## 量測結果（2026-08-06 實測）

| 層 | 覆蓋 | 比率 |
|---|---:|---:|
| ① 入庫 | 351 / 351 | **100.0%** |
| ② 提取成功 | 350 / 351 | **99.7%** |
| ③ 進實例列 | 347 / 351 | **98.9%** |

### 本輪貢獻拆解

③ 的 347 份中，可歸因於本輪三批寫入的有 **84 份**，其餘 263 份來自本輪之前的既有實例。84 份**全部**落在 351 分母內（無檔名變體造成的分母外貢獻）。

> ⚠️ `tmp-match-remaining-documents.ts` 檔頭記載的基線為「264/351 = 75.2%」，與現測反推的 263 差 1。此差異**未逐份追查** —— 期間曾對 34 份 Toll 文件重新提取，且盤點與補救之間有其他操作，不排除基線量測當下的資料狀態已略有不同。差異不影響本文件其餘結論。

---

## 本輪補救與回滾依據

**這是唯一的還原依據。** 三批寫入皆為新增（`extraction_results` 為覆寫），無 audit log 可查。

| 批次 | 物件 | 可歸因標記 | 規模 | 前置快照 |
|---|---|---|---|---|
| A | `template_instances.name` | 前綴 `e2e-backfill 2026-08-06` | 1 實例 / **52** 列 | `match-backfill-snapshot-before-write.json` |
| C | `template_instances.name` | 前綴 `toll-hk-backfill 2026-08-06` | 2 實例 / **32** 列（Outbound 18 + Inbound 14） | 同上機制 |
| B | `template_field_mappings.description` | 前綴 `toll-hk-backfill 2026-08-06` | **2** 筆（分別含 14 / 16 條規則） | — |
| B | `field_definition_sets` | `Toll Global Forwarding (Hong Kong) Ltd - 自訂費用欄位集` | **1** 筆（37 科目），id `eb234eec-0685-46e0-9d6a-1204ecf02773` | — |
| C | `extraction_results` | 無標記（唯一約束 + upsert，**原值已被覆寫**） | **34** 筆 | `.snapshots/toll-hk-extraction-before-reprocess.json` ← **唯一還原依據** |

三個補救實例目前皆為 `DRAFT` 狀態 —— 刻意不做 `tryAutoComplete`，避免同一實例的後續批次因 `INVALID_INSTANCE_STATUS` 失敗。

### 為什麼要手動匹配

FIX-165：三層預設模板全空，`autoMatch` 對任何文件必然回傳「沒有配置預設模版」，**自動匹配從未成功過一次**。既有的 263 份與本輪補的 84 份，全部都是人手經 `/api/v1/documents/match` 或 `template-matching/execute` 做的。本輪補救**不是**繞過自動流程，而是自動流程根本不存在。

---

## 殘餘缺口（4 份，逐份實測根因，皆未處理）

### ② 的缺口：1 份

| 檔名 | 狀態 | 建立時間 | company |
|---|---|---|---|
| `RIL_RCIM250085_15670 (1).pdf` | `OCR_PROCESSING` | 2026-07-16 | NULL |

卡在 `OCR_PROCESSING` 已三週，無 `extraction_results`。同名只有這一份，沒有可替代的成功版本。這份同時也是 ③ 的缺口之一。**未查明為何卡住**（是 OCR 服務當時失敗、還是狀態機沒有推進，兩者處理方式不同）。

### ③ 的缺口：4 份（含上述 1 份）

| 檔名 | 狀態 | company | 有提取結果 |
|---|---|---|---|
| `DHL_RHEX0185_88348.pdf` | `REF_MATCH_FAILED` | NULL | 是 |
| `DHL_RHEX20250410_04388_.pdf` | `REF_MATCH_FAILED` | NULL | 是 |
| `RIL_RHEX250872_22929.pdf` | `MAPPING_COMPLETED` | RICOH INTERNATIONAL (LOGISTICS) (HK) LTD. | 是 |
| `RIL_RCIM250085_15670 (1).pdf` | `OCR_PROCESSING` | NULL | 否 |

#### 兩份 DHL —— 公司為 NULL，映射無從解析

兩份都有提取結果，但 `companyId` 是 NULL，`resolveMapping` 沒有公司可以帶入，因此拿不到任何規則。狀態停在 `REF_MATCH_FAILED`（未達 `MAPPING_COMPLETED`），補位腳本刻意跳過這類文件 —— 硬補會把一組不確定歸屬的規則套上去。

#### 一份 RICOH —— 公司是待審核的重複記錄，映射規則為 0

```
公司      RICOH INTERNATIONAL (LOGISTICS) (HK) LTD.
status                PENDING
suspectedDuplicateOf  2bad90a8-…  →  RICOH INTERNATIONAL LOGISTICS (HK) LTD.（ACTIVE）
映射規則   Outbound 0 條 / Inbound 0 條
```

規則數 0 是無法匹配的**直接原因**。治本要先在 `/admin/companies/duplicate-review` 裁決這組重複，而不是替 PENDING 記錄補一份映射。

##### 附帶發現：`normalizeCompanyName` 在此組是反向失效

實測（呼叫 `Stage1CompanyService` 的實際方法，非推論）：

```
RICOH INTERNATIONAL (LOGISTICS) (HK) LTD.  →  "ricoh international"
RICOH INTERNATIONAL LOGISTICS (HK) LTD.    →  "ricoh international logistics"
兩者正規化後相等？  false
```

FIX-077 的「移除括號及其內容」規則把 `(LOGISTICS)` 這個**實質字詞**連同地區括號一起移掉，導致本該收斂為同一家的兩個名稱正規化後不相等，落到 Step 3 的相似度判斷，被判為 suspected duplicate 而非直接命中。

這與 [FIX-159](FIX-159-toll-cross-border-entities-merged-by-normalization.md) 的 Toll 案例**方向相反**：Toll 是「該分卻併」（`(Thailand)` 與 `(Hong Kong)` 被抹平成同一個 key），RICOH 是「該併卻分」（`(LOGISTICS)` 被抹掉而分不到同一個 key）。同一條規則的兩種失效形態。

> 這只說明**規則會產生這個結果**，不代表 RICOH 這兩筆記錄就一定該合併 —— 是否同一實體要看發票原文，屬 duplicate-review 的裁決範圍，本 FIX 不預判。

---

## 未處理事項

| # | 項目 | 不處理的後果 | 建議行動 |
|---|---|---|---|
| 1 | RICOH 重複公司未裁決 | 該公司的文件持續無映射規則可用，`MAPPING_COMPLETED` 也進不了實例列 | 走 `/admin/companies/duplicate-review` 裁決 |
| 2 | 兩份 DHL 的 `companyId` 為 NULL | 提取結果無法進入任何模板實例，等同白做 | 先查 Stage 1 為何未歸屬（是發票抬頭讀不到，還是匹配四關全落空） |
| 3 | 1 份卡在 `OCR_PROCESSING` 三週 | 唯一版本，沒有可替代的成功提取 | 先查卡住原因再決定是否重跑 —— 重跑會覆寫，但此份本來就沒有結果可毀 |
| 4 | 三個補救實例停在 `DRAFT` | 不影響 ③ 的計數（列已存在），但實例未完成 | 確認是否需要收尾為 `COMPLETED` |
| 5 | 基線 264 與現測 263 差 1 | 無實質影響，僅口徑不一致 | 需要精確歷史比對時再追 |
| 6 | 反向對照：DB 有 50 個相異檔名在來源找不到 | 多為重新上傳產生的檔名變體與測試檔，會讓「DB 有 401 個相異檔名」這類數字被誤讀 | 統計時一律以來源 351 為分母，勿用 DB 檔名數 |

---

## 相關

- [FIX-165](FIX-165-auto-template-matching-never-ran.md) —— 自動匹配從未運作（③ 缺口的結構性成因）
- [FIX-159](FIX-159-toll-cross-border-entities-merged-by-normalization.md) —— Toll 跨國實體拆分後的設定缺口（批次 B / C 的起因）
- [FIX-164](FIX-164-companies-without-template-mapping.md) —— 公司無 template mapping
- [FIX-077](FIX-077-stage1-company-drift-jit-duplicates.md) —— 移除括號內容的正規化規則（RICOH 反向失效的來源）
- `scripts/tmp-e2e-coverage-audit.ts` —— 本文件所有數字的產生腳本（唯讀，可重跑覆核）
- `scripts/tmp-match-remaining-documents.ts` —— 批次 A
- `scripts/tmp-toll-hk-fielddefs.ts`、`scripts/tmp-add-toll-hk-mappings.ts` —— 批次 B / C
