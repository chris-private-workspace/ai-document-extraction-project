# TEST-REPORT-006：375 份樣本全覆蓋驗證（上傳 → 提取 → 模板匹配）

> **執行日期**: 2026-08-04
> **執行環境**: 本機（localhost:3200 + Docker PostgreSQL 5433），未動 Azure DEV
> **樣本來源**: `C:\Users\rci.ChrisLai\Downloads\SCM ai doc sample`（5 家公司 × import/export，375 份 PDF）
> **驗證工具**: `verify-instances.js`（逐列逐欄追溯，可辨識 A–G 七類徵狀）
> **衍生**: [FIX-160](../../../4-changes/bug-fixes/FIX-160-template-mapping-unreferenced-extracted-charges.md) ~ [FIX-164](../../../4-changes/bug-fixes/FIX-164-companies-without-template-mapping.md)（另有 2 項候選查證後不成立，見 §6）

---

## 1. 為什麼要做這次驗證

先前針對 FIX-150 / FIX-156 / FIX-158 的驗證**只驗到 Stage 3 提取結果那一層**，沒有真的建立 template instance 驗匹配。而 FIX-150 談的正是 mapping slot 互搶 —— 那是 instance 層的現象。當時是用 preview API 覆核，不是走完整鏈路。

驗證開始前的實際覆蓋率：

| 層級 | 份數 | 佔 375 份 |
|---|---:|---:|
| 已上傳入庫 | 230 | 61% |
| 處理完成 | 196 | 52% |
| **進過 template instance** | **4** | **1.1%** |

資料庫裡雖有 138 個 instance，但用的都是更早的歷史文件，這批樣本只沾到 4 份。且 **export 方向五家公司全部零覆蓋** —— Outbound Template 的 mapping 等於從未驗過。

---

## 2. 執行內容

### 2.1 上傳剩餘 145 份（SBS 64 + Toll 81）

| 項目 | 設定 | 結果 |
|---|---|---|
| 批次大小 | 3 份/批，共 49 批 | 145/145 成功，失敗 0 |
| 批間等待 | 25 秒 | — |
| **GPT 429** | — | **0 次** |

上傳本身不呼叫 GPT，但 `autoExtract` 會在背景觸發提取，所以上傳速率就是提取併發的上游閥門。第二批 197 份未節流時有 7 份因 429 掛在 Stage 1/2/3；本批加入節流後歸零。

### 2.2 建立 template instance

分組原則：**依系統識別出的 `companyId`，不是樣本資料夾名**。`template-matching-engine.service.ts:177-181` 對整批只套用一個 `companyId`，混合公司的實例會全部套錯規則。

同一份 PDF 可能有多筆上傳記錄（重新上傳），每個檔名只取最新且可用的一筆 —— 未去重時 Nippon 分組會算出 178 份，超過該公司樣本總數 113 份。

| 項目 | 數量 |
|---|---:|
| 分組（公司 × 方向） | 15 |
| 可執行（有適用 mapping） | 12 組 / 262 份 |
| 受阻（無任何適用 mapping） | 3 組 / 27 份 |
| 實際建立 instance | 12 個 / 262 列 |

受阻的 3 組未建立 instance —— 建了也只會 `MAPPING_NOT_FOUND`，徒留空實例。缺口本身由本報告與 [FIX-164](../../../4-changes/bug-fixes/FIX-164-companies-without-template-mapping.md) 記錄。

### 2.3 逐列追溯

12 個 instance **全部**驗出徵狀，原始 294 次。但次數會嚴重誤導 —— CEVA export 的 `D×155` 實際上只是 **5 種**問題各在 31/31 列重複。聚合後：

| 代碼 | 徵狀 | 原始次數 | 判定後 |
|---|---|---:|---|
| **E** | 合計不符 | 62 | 62 列全是真問題（VAT 差異 0 列） |
| **D** | 來源不存在 | 213（30 種） | **9 項**真缺陷，21 種為母體未覆蓋 |
| **B** | 金額遺失 | 55（19 種） | 約 **24,559** 提取到卻不進表 |

---

## 3. 最終覆蓋率

| 公司/方向 | 樣本 | 已入庫 | 處理完成 | 進 instance |
|---|---:|---:|---:|---:|
| CEVA/export | 38 | 38 | 31 | 31 |
| CEVA/import | 20 | 20 | 20 | 20 |
| DHL/export | 30 | 30 | 12 | 12 |
| DHL/import | 14 | 14 | 14 | 14 |
| Nippon/export | 60 | 60 | 54 | 43 |
| Nippon/import | 53 | 53 | 53 | 50 |
| SBS/export | 30 | 30 | 14 | 14 |
| SBS/import | 40 | 40 | 39 | 38 |
| Toll/export | 40 | 40 | 26 | 14 |
| Toll/import | 50 | 50 | 50 | 26 |
| **合計** | **375** | **375** | **313** | **262** |

進 instance 覆蓋率由 **1.1% 提升至 69.9%**。

未進 instance 的 113 份分兩類：62 份未完成處理（60 份參考編號比對中止、2 份卡在 `OCR_PROCESSING`）、27 份因該公司無 mapping、其餘為同檔名重複上傳的舊記錄。

---

## 4. 主要發現

### 4.1 合計不符 62 列全部是真問題，沒有一列是 VAT 造成

原本預期多數會是 `total_amount` 含稅、行項不含稅造成的正常差異（FIX-151 的判準）。實測 **VAT 差異 0 列** —— 多數案例的 `subtotal` 根本等於 `total_amount`（該發票不含稅），而列合計遠低於它。

| 方向 | 列數 | 金額 |
|---|---:|---:|
| 列合計 **<** 發票總額（漏帳） | 53 | 短少 **59,500.72** |
| 列合計 **>** 發票總額（重複計入） | 9 | 超出 **20,638.44** |

兩個方向根因不同，分別由 [FIX-160](../../../4-changes/bug-fixes/FIX-160-template-mapping-unreferenced-extracted-charges.md)/[FIX-161](../../../4-changes/bug-fixes/FIX-161-mapping-references-undefined-company-fields.md) 與 [FIX-162](../../../4-changes/bug-fixes/FIX-162-row-total-exceeds-invoice-amount.md) 追蹤。

### 4.2 提取到的錢沒有去處

`bl_fee` 6 筆共 **9,600** 在 Stage 3 抽得到，但 Nippon Express Logistics 的 Inbound mapping 沒有任何規則引用它 —— 錢不會進 template。同類還有 `seal_charge` 3,250、`fuel_surcharge` 2,704。

### 4.3 9 項 mapping 規則永遠落空

例如 CEVA export 的 `awb_fee` / `cfs` / `gate_charge` / `pick_up_at_origin` / `x_ray` 在 **31/31 列**全部取不到值 —— 這些 key 存在於別家公司的定義集，但不在 CEVA 自己的。

判準必須是「該公司**自己的**定義集」。若用全部 23 組定義集的聯集比對，真缺陷會從 9 項縮成 1 項。

### 4.4 檔名與資料夾不是發行方的判準（原以為的「公司誤判」查證後不成立）

`NEX_RHIM250096_28812.pdf` 放在 Nippon 資料夾、檔名帶 `NEX_` 前綴，卻被系統識別成 CEVA，一度被列為公司誤判並準備開 FIX。

實際開啟 PDF 後，發票原文寫著：

> `Cheques should be made payable to "CEVA Logistics (Hong Kong) Limited"`
> 客戶：`RICOH ASIA PACIFIC OPERATIONS LTD`

**這份發票確實是 CEVA 開立的，Stage 1 判定正確**（信心度 99）。`NEX_` 前綴與存放位置只是歸檔分類，不代表發行方。Stage 3 抽出的 `destination_gate_fee`、`destination_thc_terminal_handling_charge` 等 CEVA 特有欄位，也與發票內容一致。

連帶更正：本次驗證期間一度記下的「`Gate Fee at Destination` 跨公司出現在 Nippon 發票、可能造成欄位競爭」也不成立 —— 它本來就出現在 CEVA 發票上。（該說法未寫入 FIX-158 文件，[FIX-158](../../../4-changes/bug-fixes/FIX-158-mapping-field-definition-misalignment.md) 中的 aliases 定義是正確的，無需更動。）

🔴 **判準**：公司歸屬一律以**發票原文的發行方／付款抬頭**為準，不可用檔名前綴或樣本資料夾推論。本專案先前已因同類推論誤判過 `RCIM250001` 的兩份文件。

---

## 5. 判準修正記錄

本次分析過程中有 **5 次比對本身是錯的**。每一次若未察覺，都會產出看似乾淨、實則全錯的結論：

| # | 錯誤 | 若不修的結論 | 實際 |
|---|---|---|---|
| 1 | 重複上傳未去重 | Nippon 分組 178 份 | 樣本只有 113 份 |
| 2 | 參考編號查錯欄位（`code` vs `number`） | 「主檔完全沒有這些號碼」 | `code` 是 `REF-2026-APAC-xxx`，號碼在 `number` |
| 3 | 正則用了 `\b` | 95 份全判「解析不出號碼」 | `CEVA_RCIM…` 的 `_R` 之間沒有詞邊界 |
| 4 | [D] 用全公司定義集聯集比對 | 真缺陷 1 項 | 逐公司比對後為 9 項 |
| 5 | 把 `REF_MATCH_FAILED` 當成現行缺陷 | 「8 份該命中卻失敗」 | 以現行資料重跑 SQL，8/8 全部命中 —— 是歷史狀態殘留 |
| 6 | 用檔名前綴／資料夾推論發行方 | 「Nippon 發票被誤判為 CEVA」，已準備開 FIX | 開啟 PDF 後付款抬頭是 CEVA —— 識別正確，該 FIX 不成立 |

第 5、6 項尤其值得記：

- `REF_MATCH_FAILED` 記的是**處理當下**的結果，主檔事後補號不會回頭改狀態。判定現行缺陷必須以現行資料重跑，不能只看狀態欄位。
- 檔名與資料夾是**人為歸檔的結果**，不是事實來源。兩次都是在「準備開 FIX」的最後一步才查到真實依據，若略過該步就會產出一張根因錯誤的單。

---

## 6. 衍生的 FIX

| 編號 | 主題 | 證據 |
|---|---|---|
| [FIX-160](../../../4-changes/bug-fixes/FIX-160-template-mapping-unreferenced-extracted-charges.md) | 已提取的費用無 mapping 引用 → 金額不進表 | 19 種 / 約 24,559 |
| [FIX-161](../../../4-changes/bug-fixes/FIX-161-mapping-references-undefined-company-fields.md) | mapping 引用該公司定義集沒有的 key | 9 項規則永遠落空 |
| [FIX-162](../../../4-changes/bug-fixes/FIX-162-row-total-exceeds-invoice-amount.md) | 列合計高於發票總額 | 9 列 / 超出 20,638.44 |
| [FIX-163](../../../4-changes/bug-fixes/FIX-163-refmatch-missing-r-prefix.md) | 檔名缺前綴 `R` 導致比對不到 | 28 份 |
| [FIX-164](../../../4-changes/bug-fixes/FIX-164-companies-without-template-mapping.md) | 兩家公司無任何 template mapping | 27 份無法匹配 |

### 查證後未開單者

| 候選 | 查證結果 |
|---|---|
| 「Nippon 發票被識別為 CEVA」 | 發票原文付款抬頭為 CEVA，**識別正確**，不成立（見 §4.4） |
| 「8 份參考編號該命中卻失敗」 | 以現行資料重跑 SQL 全部命中，屬歷史狀態殘留，不成立（見 §5） |

---

## 7. 未涵蓋事項

| 項目 | 說明 |
|---|---|
| 提取值 vs 發票原文 | 本次驗證的是**內部一致性與配置正確性**，不是「提取值等於發票上的數字」。後者需要人工標註真值 |
| Azure DEV | 全程本機執行，Azure DEV 未驗證，同型問題未查證 |
| 2 份 `OCR_PROCESSING` | `CEVA_RHEX250737,0737A,0738,0738A_60229.pdf`、`RIL_RCIM250085_15670 (1).pdf` 疑似卡住，未追查 |
| 70 份參考編號主檔缺號 | 屬資料缺口，需業務端補登，非程式缺陷 |

---

**建立者**: AI 助手
**最後更新**: 2026-08-04
