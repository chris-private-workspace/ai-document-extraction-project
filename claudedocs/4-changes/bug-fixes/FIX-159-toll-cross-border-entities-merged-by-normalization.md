# FIX-159: 跨國實體被公司名正規化併成同一筆 —— Toll 泰國 / 香港

> **建立日期**: 2026-08-04
> **發現方式**: 使用者以 375 份樣本做本地端到端測試時，要求盤點「每間公司有多少種文件格式、公司名稱會否不一樣」，比對 Stage 1 讀到的發票原文與實際歸屬時發現
> **影響頁面/功能**: Stage 1 公司識別 → 公司歸屬 → 該公司的 mapping / 欄位定義集全鏈
> **優先級**: 中（資料歸屬錯誤，會使設定套用到錯誤實體；但目前僅影響 Toll 一家已知）
> **狀態**: 🚧 部分完成 —— **拆分本身兩個環境皆已完成並雙向驗證通過**（本機 2026-08-04、Azure DEV 2026-08-06，殘餘皆 0）；本機的設定缺口已於 2026-08-06 補齊；⚠️ **Azure DEV 的設定缺口仍在**（新實體無欄位定義集、無 mapping），受 runbook §17 對帳工具限制擋著，見 §Azure DEV 移植
> **最後更新**: 2026-08-06（Azure DEV 移植完成：35 份重新歸屬、殘餘 0。該環境有兩種本機沒有的中英混排印法 —— 兩環境的 variants 清單本來就不該相同，各以自身實測原文為準）

---

## 問題描述

`Toll Global Forwarding (Thailand) Limited` 與 `Toll Global Forwarding (Hong Kong) Ltd` 是兩家不同的法律實體，發票抬頭清楚可辨，但系統把兩者的文件都歸到同一筆公司記錄 `Toll Global Forwarder Limited`，因而共用同一組 template field mapping 與 field definition set。

修復前的實際分佈（本機，取每筆提取的 `stage_1_ai_details` 內 GPT 讀到的發票原文）：

| 公司記錄 | 發票原文 | 份數 |
|---|---|---:|
| `Toll Global Forwarder Limited` | `Toll Global Forwarding (Thailand) Limited` | 5 |
| `Toll Global Forwarder Limited` | `Toll Global Forwarding (Hong Kong) Ltd` | **2** ← 錯誤 |

且非歷史遺留 —— 2026-08-03、2026-08-04 以 `gpt-5.6-luna` 的提取仍在複現。

---

## 根因

### 甲、正規化移除括號，連地區一起移除

`normalizeCompanyName`（`src/services/extraction-v3/stages/stage-1-company.service.ts:618`）的步驟 3 移除括號及其內容，步驟 4 移除 `LTD` / `LIMITED` 等後綴：

```
Toll Global Forwarding (Thailand) Limited  →  toll global forwarding
Toll Global Forwarding (Hong Kong) Ltd     →  toll global forwarding
```

兩個實體正規化後**字串相等**。

這個行為本身是 [FIX-077](FIX-077-stage1-company-drift-jit-duplicates.md) 刻意加入的，用來解決「同一家公司因印法飄移而每次 JIT 新建重複公司」。它對 CEVA 有效且必要 —— 該家四種印法（`LTD` / `LIMITED` × 大小寫）全部收斂為 `ceva logistics`，95 份文件正確歸為一家。**代價是同一條規則分不開「只差地區」的跨國實體。**

### 乙、舊記錄名與發票原文不一致，使問題更隱蔽

既有記錄名為 `Toll Global Forwar**der** Limited`，而發票印的是 `Toll Global Forwar**ding**`：

```
normalizeCompanyName('Toll Global Forwarder Limited')  →  toll global forwarder    ← 不等於 forwarding
```

所以泰國文件**從來就不是**靠 Step 2b（正規化相等）歸到舊記錄的，而是靠更後面的 Step 3（`findDuplicateCompany` 的相似度／token-set）勉強命中。這一點在修復過程中造成了一次回歸，見 §執行記錄 的第一次 write。

### 丙、學習迴路把誤歸固化成規則

[CHANGE-103](../feature-changes/CHANGE-103-stage1-company-matching-anti-duplication.md) 的 `learnNameVariant` 會在匹配成立時，把 GPT 本次的印法回寫進該公司的 `nameVariants`。當文件被歸錯，錯誤印法就跟著寫進**錯誤的公司**。

實測：香港記錄建立後，一份泰國發票被誤歸過去，`Toll Global Forwarding (Thailand) Limited` 隨即被寫入香港記錄的 `nameVariants`。

危害大於原始問題 —— 一次誤歸會變成**永久的誤歸規則**：該印法之後會在 Step 2a（`nameVariants has`，精確比對）直接命中錯誤公司。

該迴路自述有「零誤併安全閘」（僅在正規化相等時才學習）。此處正規化**確實相等**，安全閘照過。**閘門擋的是「正規化後不同的公司」，擋不住「正規化規則本身分不開的兩家公司」。**

---

## 修復方案

使用者 2026-08-04 選定**方案 B：資料層拆分**。

| 選項 | 做法 | 未採用的原因 |
|---|---|---|
| A. 保留地區詞 | 正規化時不移除含國家／地區的括號 | 會動到已正常運作的 CEVA／DHL 歸併，回歸面過大 |
| **B. 資料層拆分** | 為香港實體建獨立記錄，兩邊都寫精確 `nameVariants` | ✅ 採用。規則不動，回歸面限於 Toll |

### 為何 B 有效

`resolveCompanyId` 的匹配順序：

```
Step 1   matchedKnownCompany 精確比對 name / nameVariants
Step 2a  nameVariants has <原文>  或  name equals <原文>（大小寫不敏感）  ← 精確
Step 2b  normalizeCompanyName 相等                                      ← 兩實體在此撞車
Step 3   findDuplicateCompany（Levenshtein / token-set）
```

**Step 2a 早於 2b。** 只要兩個實體的發票印法都寫進各自的 `nameVariants`，就會在 2a 完成分流，根本不進入 2b。

---

## 執行記錄

腳本：`scripts/fix-toll-hk-company-split.js`（三段式 gated `inspect|dryrun|write`，`--reassign` 為額外步驟）

### 第一次 write（2026-08-04 08:20）—— 只建香港記錄，造成回歸

僅新增 `Toll Global Forwarding (Hong Kong) Ltd` + 4 項 `nameVariants`。香港文件驗證通過，但**泰國回歸驗證失敗**：

```
上傳 TOLL_RCEX250058_57990.PDF（發票原文 = Thailand）
  → 歸到 Toll Global Forwarding (Hong Kong) Ltd   🔴
```

成因即 §乙：舊記錄名是 `Forwarder`，正規化後不等於 `forwarding`，泰國文件本來就沒有 2b 可走；新香港記錄一出現，2b 恰好命中它，於是搶在 Step 3 之前截走。

### 第二次 write（08:24）—— 補泰國側 variants

把 `Toll Global Forwarding (Thailand) Limited` / `… Ltd` 寫進既有記錄的 `nameVariants`，使泰國側也在 Step 2a 命中。

### 第三次 write --reassign（08:35）—— 清污染 + 雙向歸屬

單一交易內完成三件事，每步過數量閘：

| 步驟 | 內容 | 筆數 |
|---|---|---:|
| 清除交叉污染 | 香港記錄移除 `…(Thailand) Limited` | 1 |
| 重新歸屬 → 香港 | 發票原文為 Hong Kong 者 | 2 |
| 重新歸屬 → 既有 | 發票原文為 Thailand 者（修掉第一次 write 造成的錯誤） | 1 |

前置快照：`.tmp-toll-split/before-2026-08-04T08-35-18-078Z.json`

---

## 驗證

### 匹配行為（各上傳一份新文件，走完整 production 路徑）

| 發票原文 | 歸到 | `isNewCompany` | 判定 |
|---|---|---|---|
| `Toll Global Forwarding (Hong Kong) Ltd` | `Toll Global Forwarding (Hong Kong) Ltd` | false | ✅ |
| `Toll Global Forwarding (Thailand) Limited` | `Toll Global Forwarder Limited` | false | ✅ |

兩者皆匹配到既有記錄，未增生新公司。

### 全庫歸屬對帳

| 公司記錄 | 發票原文 | 份數 |
|---|---|---:|
| `Toll Global Forwarder Limited` | `Toll Global Forwarding (Thailand) Limited` | 7 |
| `Toll Global Forwarding (Hong Kong) Ltd` | `Toll Global Forwarding (Hong Kong) Ltd` | 3 |

一對一，待修正 0 筆。重跑 `write --reassign` 仍為 0（冪等）。

---

## ⚠️ 已知限制與技術債務

| 項目 | 說明 |
|---|---|
| **[推導] 的 variants 未經真實發票驗證** | 香港側的 `(Hong Kong) Limited` / `(HK) Ltd` / `(HK) Limited` 與泰國側的 `(Thailand) Ltd` 皆為依縮寫慣例補的，本庫**尚無**任何發票用過這些印法。依 §樣本 ≠ 母體 紀律照補，但用字是否命中真實發票待驗 |
| **未涵蓋的結構性變體仍會落回 2b** | GPT 對公司名的輸出不穩定（實測同一份文件兩次跑出 `CO., LTD.` 與 `CO.,LTD.`）。若出現本清單未涵蓋的**結構性**差異，仍會走到 Step 2b。屆時應補 `nameVariants`，**不要**放寬正規化規則。純大小寫差異不必補 —— Step 2a 的 `name equals` 為大小寫不敏感 |
| **學習迴路的污染風險未從根本解決** | §丙 的機制仍在。本 FIX 只清掉 Toll 這一組已發生的污染，並未替 `learnNameVariant` 加防線。任何「正規化規則分不開的兩家公司」都可能重演 |
| ~~**既有 3 筆的提取內容未更新**~~ | `--reassign` 只改 `company_id`，**不會**重新提取。→ ✅ **2026-08-06 已處理**，且實際範圍遠大於 3 筆，見下方 §拆分後的設定缺口 |
| **既有記錄名與發票原文不一致** | `Toll Global Forwarder Limited` vs 發票的 `Toll Global Forwarding (Thailand) Limited`。本次**未改**記錄名（超出 task scope）。若日後對齊，需一併確認 `code=TOLL` 的下游引用 |

### 🔴 拆分後的設定缺口（2026-08-06 補記，已處理）

本 FIX 原本只登記「3 筆提取內容未更新」，**低估了缺口**。真正的問題是：

> **拆出新實體時，沒有任何機制把設定帶過去。** 新建的 `Toll Global Forwarding (Hong Kong) Ltd`
> 有 34 份文件，但 `field_definition_sets` = 0、`template_field_mappings` = 0，
> 而系統**沒有 GLOBAL 級的欄位定義集**可以退回。

後果是一條完整的空轉鏈：

```
field_definition_sets = 0
  → Stage 3 沒有費用科目可注入 prompt
  → 只提取到通用發票欄位（費用塌縮成單一 freight_charge）
  → template_field_mapping 的 sourceField 全部落空
  → 補映射規則等於空轉
  → 34 份文件無法進入任何模板實例列
```

⚠️ **這個形態會誤導診斷**：表面症狀是「模板匹配失敗 / `MAPPING_NOT_FOUND`」，
看起來像缺 mapping，實際缺的是**上游的欄位定義集**。2026-08-06 的第一版修復方向
就是「複製一組 mapping 過去」，被資料推翻（規則的 sourceField 在目標文件中出現率
近乎 0，平均填入 1.2 欄 vs 對照組 4.6 欄）。

**反證**：香港 34 份中有 2 份確實有細分費用 —— 那是 Stage 1 讀到泰國抬頭、
匹配到泰國 `companyId` 的交叉樣本，因而注入了泰國的 37 個定義。同一批文件、
同一條管線，唯一差別是**當時能不能取到欄位定義集**。

#### 處理結果（2026-08-06）

| 步驟 | 結果 |
|---|---|
| 建立香港 `field_definition_set` | 37 個費用科目，複製自泰國（純 key/label/dataType，**不含 aliases**，故無公司特定用語隨之移轉） |
| 試跑 2 份驗證 | log 出現 `Injected 37 field definitions from FieldDefinitionSet`，確認生效才續行 |
| 重新提取其餘 32 份 | 0 錯誤，**34/34 提取出細分費用** |
| 建立 `template_field_mappings` | Outbound 14 條 + Inbound 16 條 |
| 模板匹配 | **32/32 進入實例列**（以 `sourceDocumentIds` 驗收，非引擎回傳值） |

腳本：`scripts/tmp-toll-hk-fielddefs.ts`（六階段 gated）、`scripts/tmp-add-toll-hk-mappings.ts`（診斷）
快照：`.snapshots/toll-hk-config-before-write.json`、`.snapshots/toll-hk-extraction-before-reprocess.json`

#### 🔴 這對「同型問題」的意義

下方 §同型問題 列出的其他跨國 forwarder，**一旦比照本 FIX 拆分，就會複製同一個缺口**。
拆分腳本只搬 `company_id`，不搬 `field_definition_sets` / `template_field_mappings`，
而新實體在補上這兩者**之前**的提取結果全部是不完整的，且**欄位定義不回溯**——
必須重新提取（會覆蓋 `extraction_results`，需前置快照）。

**拆分公司的完整程序應為**：拆 → 建欄位定義集 → **重新提取** → 建映射 → 重跑匹配。
只做第一步等於把文件搬到一個沒有任何設定的空殼公司底下。

---

## 跨環境狀態

| 環境 | 狀態 |
|---|---|
| 本機 | ✅ 已修復並驗證 |
| Azure DEV | ✅ **已於 2026-08-06 套用並雙向驗證通過**（35 份重新歸屬，殘餘 0）—— 見 §Azure DEV 移植 |

### 2026-08-06 Azure DEV 實測（`prisma/diagnose-config-20260806.js`，唯讀）

原本這一格寫的是「不等於沒有誤歸，但尚未查」。已經查了 —— **有**：

```
Toll Global Forwarder Limited     ← 唯一一筆，nameVariants = 0
      51  Toll Global Forwarding (Thailand) Limited
      29  Toll Global Forwarding (Hong Kong) Ltd
       4  Toll Global Forwarding (Hong Kong) Ltd 拓領環球貨運(香港)有限公司
       2  Toll Global Forwarding (Hong Kong) Ltd 拓環球貨運(香港)有限公司
```

86 份文件中 **35 份是香港發票**，全部歸在同一筆泰國記錄底下。本機當時是 34 份，規模相當。

🔴 **移植不能照抄本機的 `nameVariants`**。Azure 有兩種本機從未出現的**中英混排**印法
（`拓領環球貨運(香港)有限公司`、`拓環球貨運(香港)有限公司`，共 6 份）。本機的四項香港 variants
涵蓋不到它們 —— 直接沿用會讓這 6 份仍落到 Step 2b（正規化相等），也就是仍然誤歸。
補 variants 時必須以**目標環境實測到的原文**為準，不是以本機清單為準。

移植時另需注意：Azure 的公司主鍵與本機不同，腳本已以**名稱查找**、不寫死主鍵，可直接沿用。

---

## Azure DEV 移植（2026-08-06，✅ 已完成）

腳本：`prisma/split-toll-hk-20260806.js`（三模式 `inspect|dryrun|write`，依序跑完）
完整記錄：[`2026-08-06-dev-toll-split.md`](../../../docs/07-deployment/02-azure-deployment/deployment-records/2026-08-06-dev-toll-split.md)

### 單一交易內的四道數量閘

| 動作 | 筆數 |
|---|---:|
| `INSERT` 香港公司（帶 6 項 variants）→ `6df1b84d-b527-4318-b8a7-152a0a64bf5e` | 1 |
| `UPDATE` 泰國記錄補 2 項 variants（樂觀鎖 `updated_at = 2026-05-31T15:34:59.375Z`） | 1 |
| `UPDATE documents.company_id` → 香港 | 35 |
| `UPDATE extraction_results.company_id` → 香港 | 35 |

### 事後對帳

| 公司記錄 | nameVariants | 可對帳提取 | 原文種類 |
|---|---:|---:|---|
| `Toll Global Forwarder Limited` | 2 | 51 | 1（全泰國） |
| `Toll Global Forwarding (Hong Kong) Ltd` | 6 | 35 | 3（全香港） |

51 + 35 = 86，**殘餘待修正 0**，兩邊無交叉。

### 🔴 Azure 的 variants 與本機不同，這是刻意的

Azure 有兩種本機從未出現的中英混排印法（`拓領環球貨運(香港)有限公司` / `拓環球貨運(香港)有限公司`，共 6 份），
本機的四項香港 variants 涵蓋不到。**兩個環境的 variants 清單本來就不該相同** ——
它反映的是各自環境實際收到的發票印法。日後任一環境新增 variants 時，
應以**該環境的 stage_1 實測原文**為準，不要拿另一環境的清單去對齊。

### 🔴 還原依據只存在於 log

`companies` / `documents` / `extraction_results` 都沒有版本歷史，容器內也沒有可保留的檔案系統。
前置快照印在 write 那次的容器 log（`--- SNAPSHOT BEGIN/END ---` 區段），
**Log Analytics 保留期限到了就沒了** —— 需長期保存須另行匯出。

### ⚠️ 設定缺口在 Azure 同樣存在

新公司目前**沒有欄位定義集、沒有 mapping**，狀態與本機 2026-08-06 補齊前相同（見 §拆分後的設定缺口）。
補齊要寫 `template_field_mappings`，受 runbook §17 的通案限制擋著（對帳工具尚未移植進 `prisma/`）。

🔴 **2026-08-06 補充**：移植到 Azure DEV **不能只跑拆分腳本**。依 §拆分後的設定缺口，
拆完之後新實體會是一個沒有任何設定的空殼，必須接著建欄位定義集 → **重新提取** → 建映射 → 重跑匹配。
其中「重新提取」會覆蓋 `extraction_results`（`document_id` 唯一約束 + upsert），
Azure 上執行前必須先快照，且該環境的一次性腳本要放 `prisma/*.js`（runner 映像不含 `scripts/` 與 tsx）。

---

## 同型問題（未處理）

### 其他跨國 forwarder 可能有相同形態

任何「主名相同、只差括號內地區」的實體組合都會被正規化併成一筆。已知候選：

- **CEVA** —— `CEVA LOGISTICS (HONG KONG) LTD` 的 `nameVariants` 已累積 **10 項**，含 `RICON ASIA PACIFIC OPERATIONS LIMITED（CEVA LOGISTICS）`、`CEVA LOGISTICS (香港) KONG LITTD` 等。目前看來歸併正確，但 RICHASIA / RICON / RICHON 幾筆的實體關係**尚未查清**，不排除已發生同型污染
- 其餘 forwarder 未逐一盤點

判定方法（不需猜測）：比對 `stage_1_ai_details` 內 GPT 讀到的發票原文與實際 `company_id`，一個公司記錄底下出現**地區不同**的原文即為命中。查詢見本 FIX 的腳本 `loadState`，或直接用 `prisma/diagnose-config-20260806.js` 的區塊 2（通案掃描，兩個環境都可跑）。

#### 2026-08-06 通案掃描結果

| 環境 | 底下有多種原文的公司 | 其中屬地區不同（真誤歸） |
|---|---:|---|
| 本機 | 5 | **Nippon Express Logistics** —— 泰國記錄底下有 3 份 `NIPPON EXPRESS (H.K.) CO., Ltd` |
| Azure DEV | 9 | **Toll**（35 份，見 §跨環境狀態）；**CEVA LOGISTICS (HONG KONG) LTD** 底下另有 `(China) Ltd.` / `(Singapore) Pte Ltd` / `(Thailand) Co., Ltd.` / `(THAILAND) COMPANY LIMITED` **各 1 份** |

其餘皆為 (a) 大小寫／標點飄移或 (b) OCR 誤讀（`RICOH` → `RUIH` / `RITCH` / `RAPID`；`CEVA` → `Cevna` / `CEVΑ`（希臘字母 Α）），**不是**歸屬問題。

⚠️ CEVA 那四筆各只有 1 份，樣本太少 —— 可能是真的跨國實體發票，也可能是 OCR 把地區讀錯。
**未判定**，需要調出那 4 份原件人工看過才能決定。列在此處是為了不讓它再被遺忘，不是主張它就是誤歸。

### 記錄名與發票原文的系統性落差

`Toll Global Forwarder Limited`（記錄）vs `Toll Global Forwarding …`（發票）這類落差會讓 Step 2b 失效、把匹配壓到 Step 3 的相似度上，行為較不可預測。是否要有一套「記錄名對齊發票原文」的治理，待評估。

---

## 相關

- [FIX-057](FIX-057-stage1-company-matching-jit-duplicates.md) —— 正規化配對的引入
- [FIX-077](FIX-077-stage1-company-drift-jit-duplicates.md) —— 移除括號地區詞、`findDuplicateCompany` 防護
- [CHANGE-103](../feature-changes/CHANGE-103-stage1-company-matching-anti-duplication.md) —— 學習迴路與 token-set 分層
- [FIX-150](FIX-150-nippon-charge-fields-lost-mapping-slot-contention.md) —— 公司歸屬錯誤導致設定套用到錯誤實體的實例
