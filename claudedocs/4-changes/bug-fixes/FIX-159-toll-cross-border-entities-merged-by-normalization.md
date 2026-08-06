# FIX-159: 跨國實體被公司名正規化併成同一筆 —— Toll 泰國 / 香港

> **建立日期**: 2026-08-04
> **發現方式**: 使用者以 375 份樣本做本地端到端測試時，要求盤點「每間公司有多少種文件格式、公司名稱會否不一樣」，比對 Stage 1 讀到的發票原文與實際歸屬時發現
> **影響頁面/功能**: Stage 1 公司識別 → 公司歸屬 → 該公司的 mapping / 欄位定義集全鏈
> **優先級**: 中（資料歸屬錯誤，會使設定套用到錯誤實體；但目前僅影響 Toll 一家已知）
> **狀態**: 🚧 部分完成 —— **本機已修復並雙向驗證通過**（gated 腳本，見 §驗證）；拆分後的設定缺口已於 **2026-08-06** 補齊（見 §拆分後的設定缺口）；⚠️ **Azure DEV 仍未套用**，且該環境是否有同型誤歸尚未查證，見 §跨環境狀態
> **最後更新**: 2026-08-06（補記拆分後的設定缺口 —— 原「3 筆提取內容未更新」低估了範圍，實為新實體完全沒有欄位定義集與映射）

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
| Azure DEV | ⚠️ **未套用**。該環境僅有一筆 `Toll Global Forwarder Limited`，無香港記錄。**但這不等於該環境沒有香港發票被誤歸** —— 查證需讀提取結果，而文件端點需認證，尚未查 |

移植時需注意：Azure 的公司主鍵與本機不同，腳本已以**名稱查找**、不寫死主鍵，可直接沿用。

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

判定方法（不需猜測）：比對 `stage_1_ai_details` 內 GPT 讀到的發票原文與實際 `company_id`，一個公司記錄底下出現**地區不同**的原文即為命中。查詢見本 FIX 的腳本 `loadState`。

### 記錄名與發票原文的系統性落差

`Toll Global Forwarder Limited`（記錄）vs `Toll Global Forwarding …`（發票）這類落差會讓 Step 2b 失效、把匹配壓到 Step 3 的相似度上，行為較不可預測。是否要有一套「記錄名對齊發票原文」的治理，待評估。

---

## 相關

- [FIX-057](FIX-057-stage1-company-matching-jit-duplicates.md) —— 正規化配對的引入
- [FIX-077](FIX-077-stage1-company-drift-jit-duplicates.md) —— 移除括號地區詞、`findDuplicateCompany` 防護
- [CHANGE-103](../feature-changes/CHANGE-103-stage1-company-matching-anti-duplication.md) —— 學習迴路與 token-set 分層
- [FIX-150](FIX-150-nippon-charge-fields-lost-mapping-slot-contention.md) —— 公司歸屬錯誤導致設定套用到錯誤實體的實例
