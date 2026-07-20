# FIX-119: 過度具體的 identificationRules 會被排他性判斷誤判

> **日期**: 2026-07-20
> **狀態**: 🔴 **已回滾** —— 問題分析成立，但實作導致辨識準確度明顯下降，已還原至修改前狀態（見 §實作嘗試與回滾）。問題本身**尚未解決**。
> **嚴重度**: Sev3（辨識準確度風險 — 特定文件變異會導致正確格式被排除）
> **類型**: Bug Fix（Prompt 判讀指引 + 資料修正）
> **影響範圍**: Stage 2 GLOBAL prompt（全公司）、CEVA 兩個格式的 `identificationRules`

---

## 問題描述

由使用者於 UAT 檢視 CEVA 識別規則時提出。

[FIX-115](FIX-115-stage2-prompt-missing-knownformats-variable.md) 讓 `identificationRules.keywords` 得以注入 Stage 2 prompt，並加入**排他性判斷**：

> 特徵具有排他性：若某格式的特徵明確不存在於文件中，就排除該格式

這個規則對「結構性特徵」是正確的，但當 keywords 內含**隨單張文件變動的值**時會產生誤判 —— 特徵「不存在」被當成格式不符。

### 實際存在的高風險 keywords

CEVA 的兩組規則是照**各一張樣本**撰寫的，過度擬合：

| 格式 | Keyword | 失效情境 |
|------|---------|----------|
| A | 頁碼 **Page 1 of 1** 位於標題列右端 | 多頁發票顯示 `Page 1 of 3` → 特徵不符 → 排除格式 A |
| B | 頁碼 **PAGE 1 of 1** 位於頁面右下角 | 同上 |
| A | 含 **CONTAINERS 區塊**，單行列出多個櫃號與櫃型 | 空運／散貨無櫃號 → 條件性特徵被當成必要條件 |
| B | 費用表 …\| EX RATE \| **CHARGES IN HKD** | 泰銖帳單為 `CHARGES IN THB` → 特徵不符 |

### 中風險（單一樣本推論）

| 格式 | Keyword | 問題 |
|------|---------|------|
| A | 發票號為 **12 位**純數字（如 253250005808） | 位數由單張樣本推得；真正的鑑別點是「純數字、無字母前綴」 |
| B | 發票號格式為 **F + 9 位數字**（如 F260017865） | 同理，鑑別點是「F 前綴」 |
| A | 匯率內嵌於描述句中（**如 USD 2,490.00 @ 7.834661**） | 具體金額與匯率為單張發票獨有 |
| A | 深藍橫幅（INVOICE / SHIPMENT DETAILS / CHARGES / **CONTAINERS**） | 列舉中混入條件性區塊 |

## 修正內容（兩層）

### 第 1 層：Prompt 判讀指引（`prisma/seed-data/prompt-configs.ts` + `update-stage2-prompt.js`，version 3 → 4）

排他性規則限縮為僅適用**結構性**特徵，並新增「比對特徵時的重要但書」：

- 括號內的具體範例值僅供理解形態，**不要求**文件出現相同數值
- 頁碼／總頁數、帳單幣別、金額、日期、單號位數等可變內容，只比對**位置與呈現方式**
- 標示為「條件性」的特徵未出現時**不構成排除理由**
- 排除前先確認不符的是結構性特徵而非可變值

> 此層是**根治**：日後其他公司若同樣寫出過度具體的規則，模型會依但書自行折扣，而非直接排除。

### 第 2 層：修正 CEVA 兩組 keywords（DB 資料）

| 原文 | 改為 |
|------|------|
| 頁碼 Page 1 of 1 位於標題列右端 | 頁碼標示位於標題列右端 |
| 頁碼 PAGE 1 of 1 位於頁面右下角 | 頁碼標示位於頁面右下角 |
| 含 CONTAINERS 區塊，單行列出多個櫃號與櫃型 | （條件性）貨櫃運送時含 CONTAINERS 區塊列出櫃號與櫃型；非貨櫃運送則無此區塊 |
| …\| EX RATE \| CHARGES IN HKD | …EX RATE、換算後金額欄（CHARGES IN 加帳單幣別） |
| 發票號為 12 位純數字（如 253250005808），無英文字母前綴 | 發票號為純數字，無英文字母前綴 |
| 發票號格式為 F + 9 位數字（如 F260017865） | 發票號以字母 F 起首，後接一串數字 |
| 匯率內嵌於描述句中（如 USD 2,490.00 @ 7.834661） | 原幣金額與匯率內嵌於描述句中（以 @ 連接），非獨立欄位 |
| 深藍橫幅（INVOICE / SHIPMENT DETAILS / CHARGES / CONTAINERS） | 深藍橫幅（如 INVOICE、SHIPMENT DETAILS、CHARGES） |

### 放寬後仍可區分（反向風險檢查）

移除脆弱特徵後，兩格式的結構性鑑別點完整保留：

| 格式 A 專屬 | 格式 B 專屬 |
|---|---|
| 抬頭 `HONG KONG OFFICE` | 抬頭 `(HONG KONG) LTD` |
| 深藍實心橫幅 | 白底細框線、左上 QR code |
| `CONSOL NUMBER` / `PRINTED BY` | `Client Tax ID` / `Incoterm ref` / `Operations` |
| 發票號純數字無字母前綴 | 發票號 F 起首 |
| 匯率以 `@` 內嵌描述句 | 匯率為獨立 `EX RATE` 欄 |
| 無 QR code | `TOTAL TO PAY BEFORE` 列 |

## 實作嘗試與回滾（2026-07-20）

上述兩層修正均已實作並套用至本地，**重跑驗證後發現辨識準確度明顯下降，已全數回滾**。

### 實測結果

| 文件 | 應為 | 修改後實際 | 信心度變化 |
|------|------|-----------|-----------|
| `_17865`（表格式） | 格式 B | **格式 A** ❌ | 95 → 78 |
| `_05808`（深藍橫幅） | 格式 A | 格式 A（巧合，見下） | 86 → **18** |

兩份文件的 GPT 回應都出現**基本識圖錯誤**：

- 文件 B：「未觀察到左上角 QR code」「發票編號為純數字，未見以字母 F 起首」「費用明細為單欄等寬文字行，不像分欄表格」—— 三項全錯
- 文件 A：「公司抬頭為 CEVA LOGISTICS (HONG KONG) LTD」「不是以深藍色實心橫幅作為區塊標題底色」—— 兩項全錯，最終 `matchedKnownFormat: null`

> 文件 A 之所以「看起來正確」，是因為 GPT 回傳 `formatName: null` 觸發了另一個缺陷 —— 詳見 [FIX-120](FIX-120-resolve-format-id-empty-name-silent-match.md)，該次匹配實為靜默的任意回傳。

### 失敗原因（與原假設相反）

原假設：具體字串是過度擬合，抽象描述更穩健。

**實際上具體字串是弱模型的錨點。** Stage 2 使用 `gpt-5.4-nano` 搭配 `imageDetailMode: "low"`（降採樣圖像）。`F260017865`、`CHARGES IN HKD`、`Page 1 of 1` 這類獨特字串提供了明確的搜尋目標；換成「以字母 F 起首」「頁碼標示位於右下角」等抽象描述後，低解析度下模型即無法可靠辨識。

新增的「重要但書」段落使 system prompt 大幅變長，推測進一步稀釋了注意力。

### 回滾內容

| 項目 | 動作 |
|------|------|
| `prisma/seed-data/prompt-configs.ts` | `git checkout origin/main --`，還原至 version 3 |
| `prisma/update-stage2-prompt.js` | 同上 |
| 本地 DB GLOBAL prompt | 重跑腳本，version 4 → 3 |
| CEVA 兩組 `identificationRules` | PATCH 還原為原始 keywords |

## 問題仍然存在

原始風險**未解除**：多頁發票、非 HKD 計價、空運無櫃等情境仍可能因特徵「不存在」而被誤排除。

### 後續可行方向

| 方向 | 說明 | 狀態 |
|------|------|------|
| A | 保留但書、**同時保留具體範例** —— 讓範例當錨點、但書防過度排除 | ✅ 已由 [FIX-121](FIX-121-identification-rules-inline-variability-annotation.md) 實作（改良為「就地標註」而非全域但書），實測四份全數通過 |
| B | 提升 `imageDetailMode`（`low` → `high`）或 Stage 2 改用更強模型 | ⏳ 未採用 —— 治本，但影響成本與延遲，屬管線配置決策，應另開 CHANGE |
| C | 蒐集同格式的多張真實樣本後再收斂規則 | ⏳ 未採用 —— 最紮實；本次規則全部出自**各一張**樣本，這是根本弱點。FIX-121 亦因缺樣本而無法確證效益 |

> 教訓：規則的抽象程度必須與**模型能力**匹配。在弱模型 + 低解析度圖像的條件下，「寫得更通用」反而會失去可辨識性。此結論僅適用於當前的 nano + low detail 組合，若 B 方向調整後應重新評估。

## 撰寫 identificationRules 的原則（已寫入操作指南）

1. **描述結構，不描述數值** —— 「頁碼位於右下角」而非「頁碼 Page 1 of 1」
2. **範例值放括號內並保持可辨識為範例** —— 模型會依但書視為說明而非條件
3. **條件性特徵明確標示** —— 以「（條件性）」開頭並說明不出現的情形
4. **避免從單一樣本推論精確規格** —— 位數、幣別、總頁數等先寫寬鬆形態
5. **優先寫負向特徵** —— 「無 QR code」這類有無判斷最穩定，不受內容變動影響

## 關聯

- [FIX-115](FIX-115-stage2-prompt-missing-knownformats-variable.md) —— 本 FIX 修正其排他性判斷的副作用；CEVA 的過度具體規則亦是該次撰寫
- [FIX-121](FIX-121-identification-rules-inline-variability-annotation.md) —— **承接本 FIX 的第二次嘗試（已完成）**：保留具體範例作錨點，改以「就地標註可變性」取代全域但書
- [FIX-120](FIX-120-resolve-format-id-empty-name-silent-match.md) —— 本次實驗的診斷過程中發現的靜默任意匹配缺陷
- 操作指南：[company-multi-format-setup-guide.md](../../reference/company-multi-format-setup-guide.md)
