# FIX-150: Nippon 費用在模板上消失 —— 單一映射格位被兩種費用互搶

> **建立日期**: 2026-07-31
> **發現方式**: 使用者 Azure DEV 回測回報「之前修好的問題又出現了」（Nippon Inbound 四項）
> **影響頁面/功能**: Template Field Mapping、Data Template 欄位定義 → 模板實例欄位值
> **優先級**: 高（使用者回測受阻；且屬設定回歸，非提取缺陷）
> **狀態**: 🚧 進行中（防護腳本、NEHK B/L fee、VAT 獨立成欄皆已完成並驗證；待重新匹配實例驗收，Outbound seal fee 待使用者決定）

---

## 問題描述

使用者回報四項，全部標記為未解決：

| # | 回報 | 文件 |
|---|------|------|
| 1 | Seal fee、B/L fee、VGM 無法顯示 | `NEX_RCIM250001_7447.pdf` |
| 2 | VAT 7% 取不到 | `NEX_RCIM250001_202.pdf` |
| 3 | VGM、seal fee、B/L fee 取不到 | `NEX_RCIM250007_7642.pdf`、`NEX_RCIM250060_0400.pdf`、`NEX_RCIM250082_1222.pdf` |
| 4 | 取到錯誤的欄位（NEHK DO FEE） | `NEX_RHIM250003_7632.pdf` |

使用者補充：「明明之前 NEHK B/L FEE - FCL 這個 line item 是能夠被正常地提取的，但現在最新的處理又變成了 B/L fee」。

---

## 查證結果：提取層正常，問題在模板映射

Azure DEV 實查（2026-07-31）。以 `NEX_RCIM250001_7447.pdf` 今日最新一次提取（`7766b50a`，06:25:58Z）為例：

```
LI: "NEHK B/L FEE - FCL"        680
LI: "CONTAINER SEAL FEE - FCL"  110 + 330
LI: "VGM ADMIN. CHARGE - FCL"   936
FM nehk_bl_fee        = 680  src=unified
FM container_seal_fee = 440  src=unified
FM vgm_admin_charge   = 936  src=unified
```

三項費用**全部提取成功**，`description` 原文完整保留，欄位值皆已落地。VAT 亦然：`NEX_RCIM250001_202` 今日 06:19 那次 `vat_7 = 1617`，與 [FIX-143](FIX-143-summary-area-vat-field-typed-as-lineitem.md) 驗證時一致 —— **FIX-143 沒有失效**。

使用者的用詞是 *cannot display*，指向下游。

---

## 根本原因

### 主因：`docs_fee_at_origin` 的來源在 2026-07-25 被替換

NEHK Inbound mapping 的 `updated_at` = **2026-07-25T06:50:33.721Z**。同一份 `NEX_RCIM250001_7447.pdf` 的模板實例值變化：

| 實例產生時間 | `docs_fee_at_origin` | `transform_diagnostics` 記錄的缺失來源 |
|---|---|---|
| 07-24 14:59 / 15:08 | **680** ✓ | — |
| 07-25 06:47:28 | 未填 | `["nehk_bl_fee"]` |
| ← **06:50:33 mapping 被改** | | |
| 07-25 06:50:46（7632） | **680** ✓ | — |
| 07-30 / 07-31 | 未填 | `["nehk_do_fee"]` |

改動內容為 `docs_fee_at_origin` 的 `sourceField`：`nehk_bl_fee` → `nehk_do_fee`。

該改動使 `NEX_RHIM250003_7632.pdf`（有 NEHK DO FEE）得以正確取值。但 `docs_fee_at_origin` 只有一個格位，而 NEHK 發票的 **B/L fee** 與 **DO fee** 是兩種不同費用：換上 DO fee 之後，只有 B/L fee 的文件（7447 / 7642 / 1222 / 0400）失去唯一去處，`nehk_bl_fee` 不再被任何規則引用。

> `docs_fee <- bl_fee` 這條規則一直存在，但接不住 —— NEHK 發票原文為 `NEHK B/L FEE - FCL`，會被 `nehk_bl_fee` 的 alias 精確命中，永遠填不到 `bl_fee`。

### 次因：VAT 在 Inbound 模板沒有欄位可放

`Logistics Cost - Inbound Template (Full List)` 的 45 個欄位中**沒有** VAT 欄位。現行規則只能把它併入他欄：

```
NEL  handling <- {handling_charge}+{empty_container_placement}+{vat_7}   → 2117 = 500 + 1617
```

數值在，但混在 handling 裡，使用者在模板上找不到獨立的 VAT 欄 —— 因而判定為「取不到」。

---

## 為什麼「已經處理並測試過」的問題會重現

四條回報並非同一種情況，混在一起才顯得像「修好的又壞了」。拆開後是三種不同的機制：

### 甲、真回歸 —— 修 A 的動作打破了 B（#1、#3）

7/25 那次改動的時間序列（全部取自 Azure DEV 實際記錄）：

```
06:47:21  建立實例「NEX_RHIM250003_7632」
06:47:28  該列 docs_fee_at_origin 未填，診斷記錄缺 nehk_bl_fee
06:50:33  NEHK Inbound mapping 被改（updated_at）
06:50:41  再次建立同名實例「NEX_RHIM250003_7632」
06:50:46  該列 docs_fee_at_origin = 680  ✓
```

這是一次**針對 7632 的定點修復並當場驗證通過**的完整動作。問題在於驗證只跑了 7632 這一份 —— 而被換掉的那個來源 `nehk_bl_fee`，正是 7447 / 7642 / 1222 / 0400 唯一的落點。這四份沒有被重新檢查，所以「打破」這件事沒有在當下被看見。

三個環節讓它得以無聲發生：

| 環節 | 現況 |
|------|------|
| 改 mapping 時 | UI 不會警告「`nehk_bl_fee` 改完後將不再被任何規則引用」 |
| 改完之後 | `template_field_mappings` 無 audit log，無法得知誰改、為何改（本節的改動意圖係由時間序列推斷，非系統記錄） |
| 驗證時 | 只重跑當下那份文件，沒有跨文件回歸 |

**結構性根因**：一個目標欄位只綁一組來源，但同一家公司的不同發票版面會產生不同的來源 key。兩種費用搶同一個格位時，無論怎麼設定都只能滿足一種。這與 [FIX-149](FIX-149-dhl-charge-field-mapping.md)（DHL doc / nondoc 互搶 freight）是同一型問題。

### 乙、驗證層級落差 —— 修的是提取層，看的是模板層（#2）

VAT 7% 這條「之前測試過」是真的，但驗的不是同一件事：

| | FIX-143 當時驗證的 | 使用者現在看的 |
|---|---|---|
| 層級 | 提取結果 | 模板實例 |
| 判準 | `vat_7 = 1617` ✓ | 模板上有沒有 VAT 欄 |
| 結論 | 通過 | 看不到 |

兩者都成立且互不矛盾 —— FIX-143 解決的是「提取不到」，而模板層從頭到尾就沒有 VAT 欄位可放。**這一條不是回歸，是修復範圍沒有涵蓋到模板層。**

### 丙、從未損壞 —— VGM（#1、#3 的一部分）

`vgm_at_origin <- vgm_admin_charge` 這條規則自始未變，值一直是 936 / 702。列入回報應是與同組的 B/L fee、Seal fee 一併觀察所致。

### 小結

| # | 之前是否真的修好過 | 修在哪一層 | 現在的狀況 |
|---|---|---|---|
| 1 · 3 B/L fee | **是**（7/24 模板上 = 680） | 模板層 | 被 7/25 改動打破 —— 真回歸 |
| 1 · 3 VGM | 一直正常 | — | 未損壞 |
| 1 · 3 Seal fee | 一直併在 `handling_at_origin` | — | 依使用者 7/31 決定，Inbound 不需獨立欄位 |
| 2 VAT | **是**，但只在提取層 | 提取層 | 模板層從未有欄位 —— 範圍落差 |
| 4 DO fee | 7/25 改動後修好 | 模板層 | 正常；它就是造成甲類回歸的那次改動 |

---

## 第一層防護（✅ 已完成並驗證，2026-07-31）

> 依使用者 2026-07-31 指示，在動任何設定之前先建立防護網。

### 判準的兩次修正（重要）

初版以「該公司的映射有沒有引用此 key」為判準，掃出 5 個孤兒共 127,402.25。**其中 4 個是誤判**，以模板實例的實際值驗證後推翻：

| 初版宣稱 | 有值 | 金額實際出現在模板列 | 結論 |
|---|---:|---:|---|
| NEL `bl_fee` | 43 | 31（其餘 12 份無模板列） | ✅ 誤判 |
| NEL `seal_charge` | 43 | 31 | ✅ 誤判 |
| NEL `surrender_bl` | 5 | 5 | ✅ 誤判 |
| RICOH `air_local_charge_usa_origin` | 10 | 10 | ✅ 誤判 |
| NEHK `nehk_bl_fee` | 26 | 7（14 份未落地） | 🔴 真問題 |

誤判根因：**映射的 `company_id` 不是套用與否的決定因素**。掛在 NEHK 名下、名稱卻是「Nippon Express **Logistics** - Outbound」的那組映射，實際套用在 NEL 的出口文件上，`bl_fee` 一路落到 `document_fee`（實測值 1600 / 1650），`seal_charge` → `seal_fee`、`surrender_bl` → `telex_release` 亦然。用 `company_id` 推論等於憑結構猜測。

第二版改按「文件實際落在的模板」收集規則，NEL 與 RICOH 的誤判消除，但又**太寬鬆**：已合併公司（`NIPPON EXPRESS（NIPPON EXPRESS）`，MERGED）留下的 active 映射仍引用 `nehk_bl_fee`，使真正的孤兒被判為「有人要」。同時「金額是否單獨出現在某欄位」這個事實訊號，對加總型規則（`handling_at_origin = {seal_charge}+{handling_charge}+{container_seal_fee}`）系統性失效，冒出數十項假警報。

**最終判準：總額對帳**，不再嘗試推斷哪組規則生效：

```
A = 該文件提取結果中「已定義為費用欄位」且有值的金額總和
B = 該文件模板實例列上所有數值欄位的總和
A − B = 未落地金額
```

被加總的錢仍在 B 裡，沒落地的錢一定不在。金額恰等於差額的 key 標為「可定位」。

### 全域對帳結果（2026-07-31）

對帳 603 份文件（另有 168 份尚未加入任何實例，無從判定）：

| 公司 | 有差額份數 | 漏 | 可定位的最大項 |
|---|---:|---:|---|
| CEVA LOGISTICS (HONG KONG) LTD | 49 | 189,073.28 | `freight_charges` 8 份 / 110,666.76 |
| DHL Express | 19 | 183,856.74 | `express_worldwide_nondoc` 2 份 / 547.00 |
| Nippon Express Logistics | 6 | 148,238.00 | `do_fee` 1 份 / 1,650.00 |
| Toll Global Forwarder | 40 | 61,711.28 | `document_fee_destination` 11 份 / 7,150.00 |
| RICOH INTERNATIONAL | 24 | 33,132.82 | `dryage_charge` 2 份 / 8,500.00 |
| **Nippon Express (HK)** | 14 | **17,432.00** | **`nehk_bl_fee` 4 份 / 2,720.00** |
| DSV Air & Sea | 5 | 2,551.30 | `vgm_administration_fee` 3 份 / 1,735.00 |
| | | **漏 635,995.42 / 多算 8,014.58** | |

NEL 68 份文件中僅 6 份有差額、NEHK 41 份中 14 份，其餘全數吻合 —— 可見對帳並非把所有文件一律標記。

> ⚠️ 此數字包含「設定已改但實例尚未重新匹配」的過期快照（DHL 的 183,856 極可能屬此類，FIX-149 剛改完映射、106 列實例尚未重跑）。差額反映實例列當下的內容，不等於映射規則現在錯誤。

**同日稍晚重跑的數字不同，成因即為上述限制**：08:51 建立 VAT 變更的基線時，總額為漏 645,645.42（NEL 由 6 份 / 148,238 上升為 12 份 / 157,888，`surrender_bl` 5 份 / 7,500 被標為可定位的漏接）。查證後並非新的破壞 —— NEL Outbound 映射於當日 08:29:39Z 被改為 `document_fee <- {nehk_do_fee} + {do_fee} + {bl_fee} + {surrender_bl}`，該 key **仍被引用**，只是實例列尚未重新匹配。引用本節數字時務必連同擷取時間一起看。

逐份對帳精確命中本案目標：

```
NEX_RCIM250007_7642.pdf  差額=680   nehk_bl_fee=680 ←恰等於差額
NEX_RCIM250001_7447.pdf  差額=680   nehk_bl_fee=680 ←恰等於差額
差額 2056 = vgm 936 + bl 680 + seal 440（三者皆未落地的實例列）
```

### 交付的兩支腳本

| 腳本 | 用途 |
|---|---|
| `scripts/check-orphan-charge-keys.js` | 費用落地對帳；支援 `--company=` 篩選、`--save=` 存基線、`--baseline=` 比對、`--docs` 逐份列出 |
| `scripts/snapshot-template-values.js` | `capture` 擷取模板欄位值快照、`diff` 前後對照，標示「有值變空白」 |

兩者皆唯讀（後者唯一寫入為輸出 JSON），本機與 Azure 共用同一份程式碼（SSL 依連線目標自動判斷、dotenv 以 try/catch 包住）。

### 改設定的標準流程

```bash
# 1. 動手前建立基線
node scripts/check-orphan-charge-keys.js --save=before-orphans.json
node scripts/snapshot-template-values.js capture before-values.json

# 2. 改動映射 → 在介面重新匹配模板實例

# 3. 事後比對：任一支回報 🔴 即代表打破了既有映射
node scripts/check-orphan-charge-keys.js --baseline=before-orphans.json
node scripts/snapshot-template-values.js capture after-values.json
node scripts/snapshot-template-values.js diff before-values.json after-values.json
```

`diff` 的關鍵輸出是「欄位由有值變為空白」—— 那正是 7/25 那次改動未被察覺的損失形態。兩支腳本在偵測到問題時 exit code 皆為 `1`，可供自動化串接。

### 驗證方式（雙向）

在 Azure DEV 實機執行，同時驗證「不誤報」與「確實會報」：

| 驗證項 | 方法 | 結果 |
|---|---|---|
| 對帳不過度標記 | 觀察吻合比例 | NEL 68 份僅 6 份有差額、NEHK 41 份中 14 份，其餘全數吻合 ✓ |
| 精確定位 | 逐份對帳本案目標文件 | `7642` / `7447` 差額 680，恰等於 `nehk_bl_fee` ✓ |
| 誤判修正 | 以模板實例實際值反查初版的 5 個宣稱孤兒 | 4 個推翻、1 個確認，判準已依此重寫 ✓ |
| 不誤報（負向） | 連續擷取兩次快照、期間不做任何改動；對帳連跑兩次比對基線 | 變空 0、值改變 0、新增 0；「與基線一致」✓ |
| 確實會報（正向） | 竄改快照將 `thc=4300` 清空、從基線移除一個項目 | 🔴 正確報出 `thc: 4300 → 空`、🔴 正確報出新增項 ✓ |
| exit code | 竄改情境 vs 乾淨情境 | `1` vs `0` ✓ |

> 正向驗證是刻意加的：只證明「無變化時不響」不足以說明警報器有用，必須同時證明「有變化時會響」。
>
> 判準之所以改寫兩次，正是因為初版通過了上述「不誤報／會報」的驗證卻仍給出錯誤結論 —— 那些驗證只證明比對邏輯自洽，不證明**判準本身**對應事實。分辨兩者的唯一方法是拿實際資料反查每一筆宣稱。

四閘：`npm run lint` 通過、`npm run type-check` 通過。

---

## 費用命名的實際分佈（決定方案的關鍵事實）

依發票**原文**（非依填入的 key）統計兩家公司所有文件：

| 公司 | 發票印出的費用 | 份數 |
|---|---|---:|
| NEHK | `NEHK B/L FEE` | 33 |
| NEHK | `NEHK DO FEE` | 8 |
| NEL | `B/L FEE` | 44 |
| NEL | `D/O FEE` | 24 |

三項關鍵結論：

1. **完全互斥** —— 沒有任何一張發票同時印出兩種以上，一份組合都沒有。
2. **兩家公司各用一套命名，從不交叉**。NEHK 一律帶 `NEHK` 前綴，NEL 一律不帶。份數加總（41 / 68）與各自的文件總數完全吻合。
3. 因此「三種費用配兩個格位」的困境**在單一公司內並不存在** —— 每家各自只有兩種，正好兩格。

> 這也推翻了規劃初期的一項顧慮：「若 NEHK 出現純 `B/L FEE` 將無去處」。41 份文件中一份都沒有，且 NEHK 的命名規則就是一律帶前綴。NEHK 欄位集中的 `bl_fee`（3 份有值全為誤配）與 `do_fee`（0 份有值）對該公司屬多餘定義，其存在只製造混淆。

---

## 修復方案

> **使用者決定（2026-07-31）**：Seal fee 只需在 Outbound 模板呈現，Inbound **不需要**。故 Inbound 不新增 `seal_fee` 欄位，`handling_at_origin` 維持現行公式（seal 金額續併於其中）。

### A. 兩張共用模板各新增一個欄位（✅ 已執行，2026-07-31）

附加於現有欄位之後（**不動既有 `order`**，避免改變匯出欄序）：

| `data_templates` | 原欄位數 | 新增 |
|---|---:|---|
| `Logistics Cost - Inbound Template (Full List)` | 45 | `{"name":"vat","label":"VAT","order":46,"dataType":"number","isRequired":false}` |
| `Logistics Cost - Outbound Template (Full List)` | 37 | 同上，`"order":38` |

**為何兩張都要動**：帶 `vat_7` 的 89 份 NEL 文件分佈於兩張模板 —— Outbound 59 份、Inbound 13 份，另 17 份尚未加入任何實例。只加 Inbound 會漏掉較大的那一半。

> 刻意命名為 `vat` 而非 `vat_7`：FIX-143 已查證該發票 `1617 / 65323 ≈ 2.5%`，標籤與實際稅率並不一致，欄位名不宜綁定特定稅率。

### B. NEHK 欄位定義集 + Inbound mapping（✅ 已執行，2026-07-31）

**不採用**規劃初期的 `{bl_fee} + {nehk_bl_fee}` 加總 —— 使用者指出 `bl_fee`「B/L fee」與 `nehk_bl_fee`「NEHK B/L fee」經常混淆，加總會讓兩者永久無法分辨；且實測有 1 份文件同一筆 680 被同時填入兩個 key，加總將使其翻倍為 1360。改為斷絕誤配來源：

| 對象 | 現行 | 修正後 |
|---|---|---|
| 欄位集 `bl_fee.aliases` | `["B/L FEE","BL FEE"]` | `[]` |
| mapping `docs_fee` | `bl_fee` [DIRECT] | `nehk_bl_fee` [DIRECT] |
| mapping `docs_fee_at_origin` | `nehk_do_fee` [DIRECT] | **維持不動** |
| mapping `handling_at_origin` | `{seal_charge}+{handling_charge}+{container_seal_fee}` | **維持不動** |

**為何收窄 alias 有效**：aliases 直接注入 Stage 3 prompt（`stage-3-extraction.service.ts:1279-1301`，格式為 `[Also known as: ...]`）。GPT 面對發票上的 `NEHK B/L FEE - FCL` 時，看到兩個都帶「B/L FEE」字樣的候選而搖擺 —— 28 份中 2 份錯填 `bl_fee`、1 份兩者都填，`source` 全為 `unified`（GPT 直填）。清空 `bl_fee` 的 aliases 後，只有 `nehk_bl_fee` 具備精確對應的別名。

**確定性回填並非兇手**：`matchLabel`（`classify-normalizer.ts:161-173`）對子字串比對設有長度閘 `b.length >= 8`，而 `"B/L fee"` 正規化後為 `"bl fee"`（6 字元），不會命中 `NEHK B/L FEE - FCL`。該保護來自 FIX-126。

> ⚠️ 殘留風險：`bl_fee` 的 **label 本身**仍是「B/L fee」且仍在 prompt 中，GPT 選錯的機率大幅下降但無法保證歸零。若日後仍見誤配，下一步是移除 NEHK 欄位集中的 `bl_fee` 定義（該公司用不到）。

**兩項變更必須同一次完成**：僅收窄 alias 而不改 mapping，會使 `docs_fee` 完全空轉且 `nehk_bl_fee` 仍無去處，比現況更差。

#### 執行記錄

以 gated 腳本 `scripts/fix-150/narrow-nehk-blfee-alias.js`（`inspect` / `dryrun` / `write` 三段式）執行，帶前置快照、各 1 筆數量閘、樂觀鎖（`WHERE updated_at = 讀取當下值`）、單一交易。

| 環境 | 結果 |
|---|---|
| Azure DEV | ✅ 已寫入，回查確認 `bl_fee.aliases=[]`、`docs_fee <- nehk_bl_fee` |
| 本機 | ✅ 已寫入（兩環境設定資料獨立，比照 FIX-149 同步處理） |

前置快照（唯一還原依據）：

```
bl_fee.aliases       = ["B/L FEE","BL FEE"]
docs_fee.sourceField = "bl_fee"
```

### C. NEL 的兩組 mapping（✅ 已執行，2026-07-31）

| `template_field_mappings` | 目標欄位 | 現行 | 修正後 |
|---|---|---|---|
| NEL Inbound | `vat` | （無此規則） | `vat_7` [DIRECT] |
| NEL Inbound | `handling` | `{handling_charge} + {empty_container_placement}+{vat_7}` | `{handling_charge} + {empty_container_placement}` |
| NEL Outbound | `vat` | （無此規則） | `vat_7` [DIRECT] |
| NEL Outbound | `handling_charge` | `{handling_charge} + {empty_container_placement}+{vat_7}` | `{handling_charge} + {empty_container_placement}` |

**新增規則與自公式移除必須同一次完成**：只新增而不移除，同一筆 VAT 會在 `vat` 與 `handling` 兩處重複計算；只移除而不新增，VAT 金額會完全消失 —— 兩者都比現況更差。

**為何只改 NEL**（使用者 2026-07-31 決定，並以資料驗證）：

| 查證項 | 結果 |
|---|---|
| 帶 `vat_7` 的文件屬於哪家公司 | 89 份**全部**為 `Nippon Express Logistics`，NEHK 一份都沒有 |
| 實際生效的是不是 NEL 名下那兩組映射 | 是 —— Inbound `handling = 2117 = 500 + 0 + 1617`、Outbound `handling_charge = 969 = 500 + 0 + 469`，算式吻合 NEL 公式 |
| NEHK 名下 Outbound 的 `handling_charge <- {vat_7}+{handling_charge}` | NEHK 欄位集無 `vat_7`，屬 FIX-128 同型死 key，本次不處理 |

> 第二列是刻意查的：本文件 §第一層防護 已記載「映射的 `company_id` 不決定套用對象」，掛在 NEHK 名下的 Outbound 映射實際服務 NEL 的出口文件。若不以數值反算，就無法排除「改了 NEL 名下那組卻不生效」的可能。VAT 這條經查證**不屬**該情況。

#### 執行記錄

以 gated 腳本 `scripts/fix-150/add-vat-column-nel.js`（`inspect` / `dryrun` / `write` 三段式）執行，帶前置快照、逐筆樂觀鎖（`WHERE updated_at = 讀取當下值`）、單一交易。

| 環境 | 資料模板 | 映射 | 備註 |
|---|---|---|---|
| Azure DEV | ✅ 2 張 | ✅ 2 組 | 回查：Inbound 46 欄 / Outbound 38 欄、兩組映射各 14 條規則 |
| 本機 | ✅ 2 張 | ✅ 1 組 | 本機**沒有** NEL Outbound 映射，腳本明確印出「跳過（該環境尚未建立）」；本機 `vat_7` 文件數為 0 |

前置快照（唯一還原依據）：

```
Inbound  模板原有 45 欄、無 vat        → 還原方式：移除該欄位
Outbound 模板原有 37 欄、無 vat        → 還原方式：移除該欄位
NEL Inbound  handling.formula        = "{handling_charge} + {empty_container_placement}+{vat_7}"
NEL Outbound handling_charge.formula = "{handling_charge} + {empty_container_placement}+{vat_7}"
兩組映射皆無 vat 規則                  → 還原方式：移除該規則並還原上述公式
```

**數量閘的判準修正**：初版要求「剛好 2 組 NEL 映射」，在本機被擋下。真正危險的是**同一張模板有多組啟用映射**（無從得知哪組生效），而非少了一組 —— 兩環境的設定資料本來就獨立。已改為逐模板判斷「至多 1 組」，缺的那組明白印出而非靜默略過。

#### 防護腳本前後比對

| 檢查 | Azure DEV | 本機 |
|---|---|---|
| 對帳（`check-orphan-charge-keys.js --baseline=`） | 漏 645,645.42，**與基線一致** | 漏 2,627.42，**與基線一致** |
| 模板值對照（`snapshot-template-values.js diff`） | 665 列：變空 0 / 值改變 0 / 新增 0 | 4 列：同上 |
| 冪等（再跑一次 `inspect`） | 無待變更項目 | 無待變更項目 |

> 差額與快照維持不變是**預期結果**：改設定不回溯既有實例列，數值要重新匹配後才會變動。此處驗的是「沒有打破任何既有落點」。

### 預期數值變化

`NEX_RCIM250001_7447.pdf`（NEHK 規則）：

```
docs_fee            空    → 680
handling_at_origin  540   → 540   (不變)
vgm_at_origin       936   → 936   (不變)
```

`NEX_RCIM250001_202.SIGNED..pdf`（NEL Inbound 規則）：

```
vat       —     → 1617
handling  2117  → 500
```

`NEX_RCEX240692,0692A,0692B_9898.pdf`（NEL Outbound 規則）：

```
vat              —    → 469
handling_charge  969  → 500
```

> `handling` / `handling_charge` 數值變小是預期的 —— VAT 從公式移出、獨立成欄，不是漏接。

---

## 影響範圍

| 項目 | Inbound 模板 | Outbound 模板 |
|---|---:|---:|
| 綁定該模板的 mapping | 13 組 | 30 組 |
| 使用該模板的實例 | 113 個 | 54 個 |
| 既有實例列 | 474 列 | 285 列 |

本次改動的 mapping 共 3 組：NEHK Inbound（§B）、NEL Inbound、NEL Outbound（§C）。既有實例列不會自動取得新欄位，需重新匹配。

**新增模板欄位會讓所有共用公司的匯出各多出 `VAT` 一欄**（未設對應規則者值為空）。加空欄位向後相容、不破壞既有資料，但若下游有固定欄位的接收端，欄位數變化需先確認。

改設定**不需重新提取**（提取結果皆正常），但需**重新匹配模板實例**才會反映。

---

## 執行方式

比照 FIX-149：`scripts/fix-150/` 下的 gated 腳本，三段式 `inspect` / `dryrun` / `write`。node 14 相容 CommonJS（Azure runner 映像不含 tsx，見 memory `feedback_azure_runner_excludes_scripts_tsx`）。

保護措施（`template_field_mappings` 與 `data_templates` 皆無 rollback 機制）：

- **前置快照**：寫入前完整輸出現值，作為唯一還原依據
- **數量閘**：公司剛好 1 間、模板各剛好 1 張、**每張模板至多 1 組啟用中的映射**（多於 1 組即中止，因為無從得知哪組生效）
- **防呆**：引用 `vat_7` 的規則必須剛好 1 條且目標符合預期；公式只接受純加總語法（`^[\s{}\w+]+$`），出現其他運算子即拒絕字串手術；移除後仍殘留 token 即中止
- **冪等**：已是目標狀態則跳過
- **樂觀鎖**：每筆 `UPDATE ... WHERE updated_at = 讀取當下值`，`rowCount ≠ 1` 即拋錯
- **單一交易**：任一步失敗即 ROLLBACK

在 Azure DEV 與本機各執行一次（兩環境設定資料獨立）。

---

## 驗收標準

- [ ] `NEX_RCIM250001_7447.pdf` 重新匹配後：`docs_fee` = 680、`handling_at_origin` = 540、`vgm_at_origin` = 936
- [ ] `NEX_RCIM250007_7642.pdf`、`NEX_RCIM250082_1222.pdf` 的 `docs_fee` 有值
- [ ] `NEX_RHIM250003_7632.pdf` 的 `docs_fee_at_origin` 仍為 680（不因本次改動而退化）
- [ ] `NEX_RCIM250001_202.SIGNED..pdf`：`vat` = 1617、`handling` = 500
- [ ] `NEX_RCEX240692,0692A,0692B_9898.pdf`（Outbound）：`vat` = 469、`handling_charge` = 500
- [ ] `transform_diagnostics` 中不再出現 `nehk_bl_fee` 缺失
- [ ] 其他共用公司的既有實例重新匹配後，原有欄位值不變（新增 `vat` 欄為空）

---

## 同型問題（未處理）

### Outbound 的 `seal_fee` 可能接不住 NEHK 的實際寫法

使用者確認 Seal fee 應在 Outbound 呈現。但現行 NEHK Outbound mapping 為：

```
seal_fee <- seal_charge [DIRECT]
```

而 NEHK 發票原文 `CONTAINER SEAL FEE - FCL` 會被 `container_seal_fee` 的 alias 精確命中，填入的是 `container_seal_fee` 而非 `seal_charge` —— 與 Inbound `docs_fee <- bl_fee` 接不住 `nehk_bl_fee` 是同一個成因。若 Outbound 需正確顯示 Seal fee，應一併改為 `{seal_charge} + {container_seal_fee}`。**待使用者確認是否納入本次範圍**（目前回報的四項皆屬 Inbound）。

### 模板實例套用了非該文件公司的 mapping

今日建立的兩個實例，同一份 `NEX_RCIM250001_7447.pdf`（公司為 NEHK）得到不同結果：

```
NEX - import to Inbound Template 1.0(06:19) → thc=8700, handling=100
    診斷欄位出現 t_h_c / status_charge / empty_container_placement —— 皆為 NEL 專有 key
NEX - import to Inbound Template 2.0(06:26) → terminal_fees_at_origin=8700,
                                               handling_at_origin=540, vgm_at_origin=936
    診斷欄位出現 container_seal_fee / vgm_admin_charge —— 皆為 NEHK 專有 key
```

1.0 實例中四份文件（其中三份屬 NEHK）**全部**套用 NEL 規則；該實例混入了一份 NEL 文件（`202`）。此為觀察到的現象，**機制尚未經代碼查證**，本次不處理 —— 但它意味著把兩家 Nippon 的文件混入同一實例，結果不可信。建議另開 FIX 追查 mapping 解析與實例的綁定關係。

### NEHK Outbound mapping 的死 key 與公司歸屬錯置

掛在 NEHK 公司下的 Outbound mapping，名稱為「Nippon Express **Logistics** - …」，且 `handling_charge <- {vat_7}+{handling_charge}` 引用了 NEHK 欄位集不存在的 `vat_7`。屬 [FIX-128](FIX-128-mapping-source-field-validation.md) 同型問題，本次不處理。

---

## 相關

- [FIX-143](FIX-143-summary-area-vat-field-typed-as-lineitem.md) —— `vat_7` 改為 `standard` 型，本次確認其未失效
- [FIX-149](FIX-149-dhl-charge-field-mapping.md) —— 同款「一個目標欄位被多種費用互搶」，gated 腳本模式來源
- [FIX-130](FIX-130-existing-config-correction-checklist.md) —— Nippon 三筆公司並存、NEHK aliases 作為正面範例
- [FIX-128](FIX-128-mapping-source-field-validation.md) —— mapping 死 key 掃描；`transform_diagnostics` 為本次診斷的關鍵證據
