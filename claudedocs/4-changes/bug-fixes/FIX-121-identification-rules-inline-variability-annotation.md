# FIX-121: identificationRules 就地標註可變性（FIX-119 的第二次嘗試）

> **日期**: 2026-07-20
> **狀態**: ✅ 已完成（本地實測通過；⚠️ 驗收有固有上限，見 §驗收）
> **嚴重度**: Sev3（辨識準確度風險 — 文件變異會導致正確格式被排除）
> **類型**: Bug Fix（Prompt 判讀指引 + 資料標註）
> **影響範圍**: Stage 2 GLOBAL prompt（全公司）、CEVA 兩個格式的 `identificationRules`

---

## 問題描述

承接 [FIX-119](FIX-119-stage2-overfit-identification-keywords.md) —— 該次修正**已回滾**，問題**尚未解決**。

[FIX-115](FIX-115-stage2-prompt-missing-knownformats-variable.md) 讓 `identificationRules.keywords` 得以注入 Stage 2 prompt，並加入排他性判斷：

> 特徵具有排他性：若某格式的特徵明確不存在於文件中，就排除該格式

當 keywords 內含**隨單張文件變動的值**時，「特徵不存在」會被誤判為格式不符。CEVA 兩組規則皆出自各一張樣本，存在此風險：

| 格式 | 高風險 keyword | 失效情境 |
|------|---------------|----------|
| A | 頁碼 **Page 1 of 1** 位於標題列右端 | 多頁發票 `Page 1 of 3` → 特徵不符 → 排除格式 A |
| B | 頁碼 **PAGE 1 of 1** 位於頁面右下角 | 同上 |
| A | 含 **CONTAINERS 區塊** | 空運／散貨無櫃 → 條件性特徵被當必要條件 |
| B | 費用表 …\| EX RATE \| **CHARGES IN HKD** | 泰銖帳單為 `CHARGES IN THB` → 特徵不符 |
| A | 發票號為 **12 位**純數字 | 位數由單張樣本推得 |
| B | 發票號格式為 **F + 9 位數字** | 同上 |

## FIX-119 為何失敗

FIX-119 的做法是**移除具體字串、改寫為抽象描述**，並在 prompt 新增一整段「重要但書」。實測結果：

| 文件 | 應為 | 修改後 | 信心度 |
|------|------|--------|--------|
| `_17865` | 格式 B | **格式 A** ❌ | 95 → 78 |
| `_05808` | 格式 A | 巧合命中（實為靜默任意匹配，見 [FIX-120](FIX-120-resolve-format-id-empty-name-silent-match.md)） | 86 → **18** |

**根因與原假設相反**：Stage 2 用 `gpt-5.4-nano` + `imageDetailMode: "low"`（降採樣圖像），`F260017865`、`CHARGES IN HKD` 這類獨特字串是弱模型的**辨識錨點**。抽掉錨點後，低解析度下模型連 QR code 都認不出。新增的整段但書使 system prompt 大幅變長，推測進一步稀釋注意力。

## 本次設計

核心轉變：**不移除任何錨點，改為在同一條 keyword 內就地標註哪一段可變。**

| 面向 | FIX-119（已回滾） | FIX-121（本次） |
|------|------------------|----------------|
| 具體範例字串 | 移除 | **完整保留** |
| 可變性資訊 | 靠 prompt 全域但書 | **就地寫在同一條 keyword 內** |
| prompt 改動 | 新增整段但書 | 只在既有第 2 點加一個子句 |
| system prompt 增量 | 大幅增加 | 約 +60 字元 |
| 改動的 keyword 數 | 兩組幾乎全改 | 格式 A 改 5 條、格式 B 改 3 條，其餘不動 |

模型在讀到 `頁碼位於標題列右端（如 Page 1 of 1，頁次與總頁數可變）` 時，錨點與寬容指示同時出現在同一個上下文位置，不需要跨段落套用全域規則。

### 第 1 層：CEVA keywords 就地標註（DB 資料）

**格式 A** `cmqur1q73000vpkxgx48c54jo`（INVOICE/GENERAL）—— 改 5 條，其餘 5 條不動：

| 原 | 改為 |
|----|------|
| 深藍色實心橫幅作為區塊標題底色（INVOICE / SHIPMENT DETAILS / CHARGES / CONTAINERS） | 深藍色實心橫幅作為區塊標題底色（如 INVOICE、SHIPMENT DETAILS、CHARGES；CONTAINERS 僅貨櫃運送時出現） |
| 發票號為 12 位純數字（如 253250005808），無英文字母前綴 | 發票號為純數字、無英文字母前綴（如 253250005808，位數可能不同） |
| 費用明細為等寬字體單欄文字行，匯率內嵌於描述句中（如 USD 2,490.00 @ 7.834661） | 費用明細為等寬字體單欄文字行，匯率以 @ 內嵌於描述句中（如 USD 2,490.00 @ 7.834661，金額與匯率數值每張不同） |
| 含 CONTAINERS 區塊，單行列出多個櫃號與櫃型 | （條件性）貨櫃運送時含 CONTAINERS 區塊，單行列出多個櫃號與櫃型；空運或散貨則無此區塊，不構成排除理由 |
| 頁碼 Page 1 of 1 位於標題列右端 | 頁碼位於標題列右端（如 Page 1 of 1，頁次與總頁數可變） |

> 不動：`標題列文字為 CEVA LOGISTICS HONG KONG OFFICE（非 (HONG KONG) LTD）`、`右側成組標籤方塊：…`、`含 CONSOL NUMBER 欄位與 PRINTED BY 欄位`、`無 QR code`、`無 Client Tax ID 或 Incoterm ref 欄位`

**格式 B** `cmrsmg8mb0000bsxgjrqy6ksk`（INVOICE/OCEAN_FREIGHT）—— 改 3 條，其餘 9 條不動：

| 原 | 改為 |
|----|------|
| 發票號格式為 F + 9 位數字（如 F260017865） | 發票號以字母 F 起首、後接一串數字（如 F260017865，位數可能不同） |
| 費用明細為分欄表格：DESCRIPTION \| CUR \| AMOUNT \| EX RATE \| CHARGES IN HKD | 費用明細為分欄表格：DESCRIPTION \| CUR \| AMOUNT \| EX RATE \| CHARGES IN ⟨帳單幣別⟩（如 CHARGES IN HKD，幣別隨帳單變動） |
| 頁碼 PAGE 1 of 1 位於頁面右下角 | 頁碼位於頁面右下角（如 PAGE 1 of 1，頁次與總頁數可變） |

> 不動：QR code、右上角黑色粗框方塊、Client Tax ID、Incoterm ref、Consol ref、Operations、TOTAL TO PAY BEFORE、白底細框線、抬頭公司名 —— 皆為結構性特徵，鑑別力完整保留。

### 第 2 層：Prompt 判讀指引（version 3 → 4）

`prisma/seed-data/prompt-configs.ts` 與 `prisma/update-stage2-prompt.js` 的第 2 點（**不新增段落**）：

```diff
-2. 特徵具有排他性：若某格式的特徵明確不存在於文件中（例如清單說「左上角有 QR code」但文件沒有），就排除該格式。
+2. 特徵具有排他性：若某格式的結構性特徵明確不存在於文件中（例如清單說「左上角有 QR code」但文件沒有），就排除該格式。
+   但特徵中標明「可變」「條件性」的部分（頁次、幣別、金額、位數等）不符時，不構成排除理由 —— 括號內的數值僅為範例。
```

> 兩檔必須逐字一致（[FIX-118](FIX-118-prod-reference-seed-overwrites-prompts-with-stale-copy.md) 的單一真實來源要求）。

## 驗收

| # | 項目 | 標準 | 結果 |
|---|------|------|------|
| 1 | `_17865`（表格式）重跑 | 格式 B、`isNewFormat: false`、信心度 ≥ 85 | ✅ 88 / 95 |
| 2 | `_05808`（深藍橫幅）重跑 | 格式 A、`isNewFormat: false`、信心度 ≥ 76 | ✅ 92 / 93 |
| 3 | `matchedKnownFormat` 非 null | 排除 FIX-120 那類靜默匹配 | ✅ 四份皆有效 |
| 4 | 型別檢查 | `npm run type-check` | ✅ |
| 5 | 未達標準即回滾 | 比照 FIX-119，不硬推 | 不適用（已達標） |

### 實測結果（2026-07-20，本地）

同一份 PDF 在資料庫中有多次上傳記錄，其中兩份是 [FIX-119](FIX-119-stage2-overfit-identification-keywords.md) 失敗實驗留下的錯誤狀態，正好構成天然對照組：

| documentId | 檔案 | 重跑前 | 重跑後 | 判定 |
|-----------|------|--------|--------|------|
| `496b984d` | `_17865` | 格式 **A**、78 ❌ | 格式 **B**、88 | ✅ 修正 |
| `2d367782` | `_05808` | 格式 A、**18** ❌（FIX-120 靜默匹配） | 格式 A、92 | ✅ 修正 |
| `6513b23e` | `_17865` | 格式 B、96 ✅ | 格式 B、95 | ✅ 維持（−1） |
| `e3937f57` | `_05808` | 格式 A、88 ✅ | 格式 A、93 | ✅ 維持（+5） |

- 四份的 Stage 2 log 皆顯示 `Using custom PromptConfig (scope: GLOBAL, version: 4)`，確認走新 prompt
- 原本正確的兩份一升一降（+5 / −1），無系統性退步 —— 差異在 GPT 取樣噪音範圍內
- 重跑工具：`scripts/fix-121-reprocess-ceva.ts`（繞過 API 認證，直接呼叫統一處理管線）

> ⚠️ 撰寫該腳本時踩到的坑：ESM 的 `import` 會提升到模組頂端執行，而 `src/lib/prisma.ts` 在載入當下就以 `process.env.DATABASE_URL` 建連線池 —— 靜態 import 會早於 `dotenv.config()`，連線字串為 undefined 而失敗（錯誤訊息本體為空，不易辨認）。src/ 模組必須用動態 `await import()`。

### ⚠️ 驗收的固有上限（必須誠實記錄）

**本次改動只能驗證「無回歸」，無法驗證「問題已解決」。** 手上沒有多頁發票、非 HKD 帳單、空運無櫃的真實樣本，觸發原始風險的情境無從重現。因此：

- 通過驗收 = 錨點未被破壞、既有辨識未退步
- **不等於** 多頁／THB／空運情境已能正確辨識

真正的確證仍需 [FIX-119](FIX-119-stage2-overfit-identification-keywords.md) §後續可行方向的 **C（蒐集同格式多張真實樣本）**。本 FIX 屬基於失敗診斷的預防性改動，價值取決於「就地標註優於全域但書」這個推理是否成立。

## 未採用的方向

| 方向 | 未採用原因 |
|------|-----------|
| B：提升 `imageDetailMode` 至 `high` 或換更強模型 | 治本，但屬管線配置決策，影響全公司成本與延遲，超出本 FIX scope —— 應另開 CHANGE 評估 |
| C：蒐集多樣本後收斂規則 | 最紮實，但需使用者提供真實樣本，非程式碼可解 |

## 關聯

- [FIX-119](FIX-119-stage2-overfit-identification-keywords.md) —— 同一問題的第一次嘗試（已回滾），本 FIX 承接其失敗診斷
- [FIX-115](FIX-115-stage2-prompt-missing-knownformats-variable.md) —— 排他性判斷的來源
- [FIX-120](FIX-120-resolve-format-id-empty-name-silent-match.md) —— 修復後 `matchedKnownFormat: null` 不再被靜默偽裝成匹配，本次驗證訊號因此可信
- 操作指南：[company-multi-format-setup-guide.md](../../reference/company-multi-format-setup-guide.md)（撰寫原則需同步更新）
