# FIX-123: `resolveFormatId` 已知格式名稱比對脆弱，真正匹配被誤判為新格式

> **建立日期**: 2026-07-21
> **發現方式**: 批次重跑 86 份本地文件後的結果分析（FIX-115/121 rollout）
> **影響頁面/功能**: V3.1 Stage 2 格式識別（全公司、全文件）
> **優先級**: 高
> **狀態**: ✅ 已完成（2026-07-21，程式碼 + 單元測試；實機批次重跑驗證待執行）

---

## 問題描述

FIX-115 修好 `${knownFormats}` 注入後，Stage 2 已能看見已知格式清單，但 `resolveFormatId` 的名稱比對仍會失敗 —— GPT **明明匹配到了正確格式**，卻因回傳字串與 DB `name` 不逐字相等而落空，最終被當成新格式。

實證：同一份文件 `NEX_RCIM250020_8925 1.pdf` 的 3 份副本重跑，**2 份失敗、1 份成功**，三次的 `formatId` 都指向同一筆記錄，但 `isNewFormat` 不一致 —— 顯示這是非確定性的比對脆弱，而非辨識能力問題。

| # | 問題 | 嚴重度 | 影響 |
|---|------|--------|------|
| BUG-1 | `matchedKnownFormat` 夾帶 keywords 後綴 → 完全相等比對失敗 | 高 | 已知格式匹配落空 |
| BUG-2 | 模糊比對只做單向 `contains` → GPT 加前綴語時同樣落空 | 高 | 同上 |

---

## 重現步驟

1. 確保公司底下有 `DocumentFormat` 且 `identificationRules.keywords` 非空（使 `${knownFormats}` 渲染出 `名稱: 描述`）。
2. 對同一份文件重複執行 Stage 2 數次（GPT 回應具非確定性）。
3. 觀察現象：部分次數 `stage_2_ai_details.response` 的 `matchedKnownFormat` 為「格式名稱 + `: ` + keywords 全文」或「說明前綴 + 名稱」，而該次的 `stage_2_result.isNewFormat` 為 `true`。

---

## 根本原因

### BUG-1：`${knownFormats}` 的渲染格式與「逐字複製」指令互相衝突

`buildStage2VariableContext`（`variable-replacer.ts:410-415`）把清單渲染為：

```
- ${f.name}${f.description ? `: ${f.description}` : ''}
```

其中 `description` 是該格式 `identificationRules.keywords` 以 `, ` 串接（`stage-2-format.service.ts:241-244`）。所以 GPT 看到的是 **`- 名稱: 關鍵字1, 關鍵字2, …`** 這樣一整行。

而 prompt 要求「**逐字複製**清單中的格式名稱」（FIX-115 加入，因 `resolveFormatId:480-488` 是拿 `matchedKnownFormat` 與 DB `name` 做**完全相等**比對）。GPT 有時忠實地「逐字複製整行」—— 包含冒號後的描述。

實測回傳值（`NEX_RCIM250020_8925 1.pdf`，2 份副本）：

```
matchedKnownFormat = "Nippon Express（NEX）Original Invoice 標準貨運發票模板: 左上角有公司 Logo 與英文/地址信頭（…）, 中央偏上以粗體標題顯示文件類型：ORIGINAL INVOICE, …"
```

DB `name` 只有冒號前那一段，`findFirst({ where: { name } })` 自然找不到。

### BUG-2：模糊比對方向單一

第 2 段的模糊比對（`resolveFormatId:509-516`）條件是：

```ts
name: { contains: fuzzyTerm, mode: 'insensitive' }
```

語義為「**DB 名稱包含 GPT 字串**」。但實際失敗案例是**反方向** —— GPT 回傳的字串包含 DB 名稱：

```
formatName = "Nippon Express Logistics 貨運發票（Original Invoice）已知模板：Nippon Express（NEX）Original Invoice 標準貨運發票模板"
                                                                        └─ DB name 完整出現在此 ─┘
```

兩個方向都可能發生，目前只覆蓋一個。

> 補充：BUG-1 的長字串同樣是「GPT 字串 ⊃ DB 名稱」，所以修好 BUG-2 也會順帶救回 BUG-1 的多數案例；但仍建議兩者都處理，因為冒號剝離是更精準、成本更低的一步。

---

## 解決方案

在 `resolveFormatId` 的比對鏈加入**保守的正規化**，且**維持 FIX-120 的防呆原則**（寧可不匹配，也不可任意匹配）：

| 順序 | 策略 | 說明 |
|------|------|------|
| 1 | 完全相等（現況） | 最快路徑，不變 |
| 2 | 剝除描述後綴後再相等 | 取 `matchedKnownFormat` 第一個 `: ` 之前的片段（對應渲染格式），再做完全相等 |
| 3 | 雙向 `contains` | 除現有的「DB ⊃ GPT」，補上「GPT ⊃ DB」 |
| 4 | 唯一性守門 | 🔴 步驟 2、3 的候選若**命中多筆即視為不確定，不匹配**，往下走 —— 避免重蹈 FIX-120 的靜默任意匹配 |

### 刻意不做

- **全形／半形正規化**：實測失敗案例皆為後綴／前綴問題，未見全半形不一致致誤。不處理未觀察到的情境（避免過度工程）。
- **相似度演算法（Levenshtein 等）**：本問題是結構性的字串包覆，不是拼寫差異；引入模糊分數只會擴大誤匹配面。

### 替代方案（一併評估）

改渲染格式，讓名稱與描述以不易混淆的方式分行呈現（例如名稱獨立一行、描述縮排），從源頭降低 GPT 複製整行的機率。

> ⚠️ 此法會**改動 GLOBAL prompt 的渲染輸出**，影響所有公司所有文件的 Stage 2 行為，且 FIX-119 已有「動 prompt 導致辨識準確度下降而回滾」的前例。建議**先做程式碼側的容錯**（本 FIX 主方案），渲染格式的調整另案評估。

---

## 修改的檔案

| 檔案 | 修改內容 |
|------|----------|
| `src/services/extraction-v3/stages/stage-2-format.service.ts` | `resolveFormatId`：加入後綴剝離 + 反向包含 + 唯一性守門 |
| `tests/unit/services/stage-2-format-resolve-format-id.test.ts` | 補 5 條 FIX-123 迴歸測試（沿用 FIX-120 既有測試檔） |

---

## 實作記錄（2026-07-21）

### 實際的比對鏈順序

| # | 策略 | 查詢方式 | 是否為本 FIX 新增 |
|---|------|----------|------------------|
| 1 | `matchedKnownFormat` 完全相等 | `findFirst` + `orderBy` | 否（FIX-120 現況，未改動） |
| 2 | 剝除 `': '` 後綴後完全相等 | `findMany` + `take: 2` | ✅ 新增（唯一性守門） |
| 3 | 反向包含（GPT 字串 ⊃ DB 名稱） | `findMany`（該公司全部）+ 應用層比對 | ✅ 新增（唯一性守門） |
| 4 | 既有模糊比對（DB 名稱 ⊃ `formatName`） | `findFirst` + `orderBy` | 否（未改動） |
| 5 | JIT 建立 / 回傳新格式 | — | 否（未改動） |

### 兩個實作決定（與規劃表的差異）

**1. 反向包含排在既有模糊比對之前**

規劃把兩個方向並列為「步驟 3 雙向 contains」。實作時把新增的反向包含放在既有方向**之前**，因為反向包含要求 **DB 完整名稱**出現在 GPT 字串中，比「GPT 片段出現在 DB 名稱中」更嚴格 —— 讓嚴格者先判，可降低誤匹配。兩者觸發條件實際上互斥（一個要求 GPT 字串長、一個要求 GPT 字串短），不會互搶。

**2. 既有模糊比對（步驟 4）維持原行為，未加唯一性守門**

規劃的守門條文寫「步驟 2、3」，而步驟 3 標題含「除現有的『DB ⊃ GPT』」。實作**只對新增路徑加守門**，既有方向維持 FIX-120 的 `findFirst` + `orderBy`（多筆時取 `createdAt` 最早），理由：

- FIX-123 要解決的是**漏匹配**；若把既有方向改成「多筆即不匹配」，會讓原本能匹配的案例變成不匹配，**製造新的漏匹配**
- 該方向的殘餘風險（GPT 給極短字串命中多筆）屬於 FIX-120 的範疇，不在本 FIX 的實證問題內 —— 若要收斂應另開 FIX，避免 H3 scope 蔓延
- 保持既有路徑不動，FIX-120 的 6 條迴歸測試無需修改斷言即全數通過（僅擴充 `findMany` mock fixture）

> ⚠️ 殘餘風險（已知、刻意接受）：步驟 3 在該公司**只有一個格式**且其 `name` 很短（例：`Invoice`）時，長 GPT 字串會包含它而成為唯一候選 → 可能誤判為已知格式。實測資料未見此形態（現有格式名稱皆為長描述性名稱），故未加最小長度門檻以免過度工程。

---

## 測試驗證

- [x] `matchedKnownFormat` 為 `名稱: keywords…` 時可正確命中，`isNewFormat` 為 `false`
- [x] `matchedKnownFormat` 為 `前綴語：名稱` 時可正確命中
- [x] 候選命中多筆時**不匹配**（後綴剝離、反向包含各一條測試）
- [x] `matchedKnownFormat` 為空／`null` 時行為不變（FIX-120 迴歸測試覆蓋）
- [x] 既有 FIX-120 迴歸測試全數通過（6/6）
- [x] `npm run type-check` 無錯誤；`npm run lint` 無新增警告
- [x] 單元測試：11 passed（FIX-120 6 條 + FIX-123 5 條）
- [x] 重跑 `NEX_RCIM250020_8925 1.pdf` 3 份副本，3 次皆 `isNewFormat: false`

> 註：全套測試中 `tests/unit/services/gpt-caller-gateway-routing.test.ts` 有 4 條失敗，
> 已以 `git stash` 在無本 FIX 改動的 baseline 上覆核**同樣失敗** → 屬 Epic 23 既有問題，與本 FIX 無關。

---

## 實機驗證結果（2026-07-21，本地 86 份全量重跑）

驗證工具：`scripts/local-batch-reprocess.ts`（重跑）+ `scripts/local-verify-fix123-124.ts`（唯讀，
解析 `extraction_results.stage_2_ai_details.response` 取出 GPT 原始 `matchedKnownFormat`，
還原 `resolveFormatId` 實際走到哪一段）。

### 指標案例：NEX 3 份副本 —— 全數 `isNewFormat: false` ✅

| 副本 | 重跑前 | 重跑後 | 命中路徑 |
|------|--------|--------|----------|
| `1764fe4d` | `true` | **`false`** | 步驟 1 完全相等 |
| `2fd4d8b3` | `true` | **`false`** | 步驟 1 完全相等 |
| `667450af` | `false` | **`false`** | **步驟 2 剝除後綴（FIX-123 BUG-1）** |

第 3 份的 GPT 回傳正是本 FIX 要處理的形態，**修復前必然落空**：

```
matchedKnownFormat = "Nippon Express（NEX）Original Invoice 標準貨運發票模板: 左上角有公司 Logo
                      與英文/地址信頭（Nippon Express (HK) Co., Ltd. …）, 中央偏上以粗體標題顯…"
```

### 全庫比對鏈分佈（80 份有 Stage 2 結果的文件）

| 命中路徑 | 份數 | `isNewFormat` |
|----------|------|--------------|
| 步驟 1 完全相等 | 59 | `false` |
| **步驟 2 剝除後綴（本 FIX 新增）** | **1** | `false` |
| 未命中（GPT 回 `null`） | 19 | `true` |
| 步驟 3 反向包含 | 1 | — |

> ⚠️ 「步驟 3」那 1 份是 `CARGO LINK_HEX240655B_09047.pdf`，其 blob 已遺失、本次**未重跑**，
> 分類係以舊 `stage2AiDetails` 回溯推算，**不代表新邏輯的實際執行**。本次重跑中步驟 3 未被觸發。

### 最重要的一項：比對鏈**零漏接**

19 份 `isNewFormat: true` 的文件，`matchedKnownFormat` **全部為 `null`** ——
即 GPT 主動宣告「這不是已知格式」，而非「GPT 說匹配卻沒接住」。
分類中 **0 份**落入「未命中（GPT 有給名稱）」，證明本 FIX 後名稱比對鏈不再有漏接。

那 19 份屬**辨識能力／資料面**問題（CEVA 第三種版面尚未建檔），由 FIX-124 負責誠實回報、
並列為其待辦事項，不在本 FIX 範圍。

---

## 關聯

- FIX-115 — 注入 `${knownFormats}` 並加入「逐字複製」指令；本 FIX 處理該指令在實務上不可靠的後果
- FIX-120 — 同一函數的前一個修復（空名稱靜默任意匹配）；本 FIX 必須維持其防呆原則
- FIX-124 — 本 FIX 失敗後的**下游後果**（落入 JIT 被指派到任意既有格式），兩者需一併修復才完整
- FIX-119 — 動 prompt 導致準確度下降的前例，故本 FIX 主方案走程式碼側

---

*文件建立日期: 2026-07-21*
*最後更新: 2026-07-21（實作完成）*
