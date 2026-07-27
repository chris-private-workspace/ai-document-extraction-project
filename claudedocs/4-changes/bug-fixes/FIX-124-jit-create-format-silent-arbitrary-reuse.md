# FIX-124: `jitCreateFormat` 撞唯一鍵時靜默沿用任意既有格式，文件被指派到錯誤格式

> **建立日期**: 2026-07-21
> **發現方式**: 批次重跑 86 份本地文件後的結果分析（FIX-115/121 rollout）
> **影響頁面/功能**: V3.1 Stage 2 格式識別 → 下游 FORMAT scope 配置（prompt / 欄位定義集 / 模板映射）
> **優先級**: 高
> **狀態**: ✅ 已完成（2026-07-21，採方案 A；實機批次重跑驗證待執行）

---

## 問題描述

當 GPT **明確判定「這不是任何已知格式」**（`matchedKnownFormat: null`）時，`resolveFormatId` 會走 JIT 建立分支。而 `jitCreateFormat` 為了避開唯一鍵，會先以 `(companyId, INVOICE, GENERAL)` 撈既有記錄 —— **一旦撈到就直接沿用它的 `id`**，完全不檢查該格式是否真的與文件相符。

結果：文件拿到一個**與自己版面無關**的 `formatId`，而 `isNewFormat` 被標為 `true`。下游任何依 `formatId` 解析的 FORMAT scope 配置都會**套錯設定**。

這與 [FIX-120](FIX-120-resolve-format-id-empty-name-silent-match.md) 是**同一類缺陷**（靜默匹配到任意格式），只是發生在 JIT 路徑而非模糊比對路徑。

---

## 重現步驟

1. 某公司底下已有至少一筆 `DocumentFormat`，其 `documentType/documentSubtype` 為 `INVOICE/GENERAL`。
2. 上傳一份該公司的**第三種版面**文件（與所有已登記格式皆不符）。
3. Stage 2 的 GPT 回傳 `matchedKnownFormat: null`，`formatName` 為自創的新名稱。
4. 觀察現象：`stage_2_result.formatId` 指向**既有的那筆格式**，`isNewFormat: true`。

---

## 根本原因

`jitCreateFormat`（`stage-2-format.service.ts:552-599`）：

```ts
// FIX-058: 先以唯一鍵 (companyId, documentType, documentSubtype) 查找既有格式，
//          避免重複 create 撞唯一約束（同公司同 type/subtype 的第 2+ 份文件）
const existing = await this.prisma.documentFormat.findFirst({
  where: { companyId, documentType, documentSubtype },
  select: { id: true, name: true },
});

if (existing) {
  return { id: existing.id, name: existing.name || formatName };   // ← 與文件無關的格式
}
```

`documentType` / `documentSubtype` 在此**寫死**為 `INVOICE` / `GENERAL`（`:557-558`），所以同一公司所有 JIT 建立都會撞同一個唯一鍵，第 2 筆之後**必然**落入 `existing` 分支。

[FIX-058](FIX-058-stage2-format-jit-unique-constraint.md) 當初加這段是為了解決唯一鍵衝突崩潰，屬正確處置；但它把「避免崩潰」實作成「沿用任意既有格式」，代價是**靜默的錯誤指派**。在 FIX-115 之前這個代價被掩蓋（那時所有文件都走 JIT、公司多半只有一個格式，看起來剛好正確）；FIX-115 讓多格式真正生效後，錯誤才浮現。

### 實測證據（本地，2026-07-21）

`CEVA LOGISTICS_CEX240464_39613.pdf`（CEVA 第三種版面，清關型）：

| 文件副本 | GPT `matchedKnownFormat` | GPT `formatName` | 實際寫入 `formatId` | `isNewFormat` |
|---|---|---|---|---|
| `7c3a75e8` | `null` | `CEVA_LOGISTICS_HONG_KONG_MIXED_LAYOUT_Invoice_(no_QR)_…` | `cmqur1q73000…`（版面 A） | `true` |
| `71d9ed62` | `null` | `CEVA Logistics (HONG KONG) LTD 貨運/清關型 Invoice（**非已知格式**）` | `cmqur1q73000…`（版面 A） | `true` |
| `29bce5aa` | `null` | `新格式：CEVA Logistics（HONG KONG）非 QR 的清關/運費彙總型 Invoice…` | `cmqur1q73000…`（版面 A） | `true` |

GPT 三次都明說「非已知格式」，系統三次都把它指派給版面 A。

**影響規模**：本地 86 份重跑後仍 `isNewFormat: true` 的 25 份中，22 份屬此類（CEVA 清關型版面）。

---

## 解決方案

需在「避免唯一鍵崩潰」與「不做錯誤指派」之間取捨。以下三案**需用戶決定**（各有 blast radius）：

| 選項 | 方案 | 優點 | 代價 |
|------|------|------|------|
| **A** | `existing` 命中時回傳 `formatId: undefined` + `isNewFormat: true` | 誠實：不指派錯誤格式，下游不會套錯 FORMAT scope 配置 | 這些文件將**沒有** `formatId`；若下游有非空假設需一併檢視 |
| **B** | `existing` 命中時仍沿用，但**明確標記**（如 `formatMatchQuality: 'FALLBACK'`）供下游與 UI 判讀 | 改動小、向後相容 | 錯誤指派仍存在，只是變得可見；下游需逐一改為尊重該旗標 |
| **C** | 依 GPT 特徵自動挑一個未使用的 `documentSubtype` 建真正的新格式 | 多版面自動成長 | `documentSubtype` 是**業務語義**（OCEAN_FREIGHT / AIR_FREIGHT…），由 AI 亂挑會污染資料，且 enum 有限（8 個）會耗盡 |

**建議 A**，理由：與 FIX-120 的處置原則一致（寧可回報「不確定」，也不要靜默給出看似成功的錯誤結果），且 `formatId` 本就是 optional（`resolveFormatId` 末段既有 `formatId: undefined` 的回傳路徑）。

---

## 下游容忍度盤點（2026-07-21 完成，選項 A 的前置條件）

追蹤 `Stage2FormatResult.formatId` 的全部下游消費點，**結論：選項 A 不會造成任何崩潰**。

### 關鍵發現（三項降低風險的事實）

| # | 發現 | 意義 |
|---|------|------|
| 1 | `ExtractionResult` 與 `Document` 兩張表**都沒有獨立的 formatId 欄位** —— 只巢狀在 `ExtractionResult.stage2Result`（`Json?`）內 | 無 FK、無 not-null 約束，持久化天生容忍空值 |
| 2 | `confidence-v3-1.service.ts` **完全不讀 formatId**，只讀 `isNewFormat`（`:397-398`）與 `configSource`（`:273`） | 信心度計算與智能路由**不受影響**，且這兩個值在本情境下本來就是 `true` / 不變 |
| 3 | `isNewFormat` 與 `formatId` 是**彼此獨立**的欄位，貫穿 JIT 標記、信心度、路由 | 選項 A 只動 `formatId`，不牽動任何依賴 `isNewFormat` 的邏輯 |

### 安全降級（13 處，無需改動）

全部已用 `if (formatId)` 或條件展開語法守門，一致地退回 COMPANY / GLOBAL 層：

| 消費點 | 位置 | 降級行為 |
|--------|------|----------|
| Stage 3 FORMAT scope PromptConfig | `stage-3-extraction.service.ts:359` | 跳過 FORMAT，退 COMPANY→GLOBAL |
| Stage 3 FieldDefinitionSet | `stage-3-extraction.service.ts:473` | 同上，最終 fallback 到 `invoice-fields.ts` |
| Prompt 階層解析 | `prompt-assembly.service.ts:474/533/585` | FORMAT 分支不進 Prisma `OR` 陣列 |
| 欄位定義集解析 | `field-definition-set.service.ts:389/461` | 少合併一層，仍回傳 GLOBAL+COMPANY |
| 模板預設值 | `auto-template-matching.service.ts:177` | 退 COMPANY→GLOBAL 預設模板 |
| 映射規則解析 | `template-field-mapping.service.ts:377` | 退 COMPANY/GLOBAL 映射 |
| Pipeline 配置 | `pipeline-config.service.ts:382` | 退 COMPANY→REGION→GLOBAL→DEFAULT |
| 匯率動態欄位 | `exchange-rate-converter.service.ts:192-204` | 同 FieldDefinitionSet |
| 持久化 | `processing-result-persistence.service.ts:295/337/619/668` | 整包 JSON 寫入，key 省略即可 |
| 主服務輸出 / orchestrator / unified-processor | 多處 | 純轉發，optional chaining |
| 批次統計 | `batch-processor.service.ts:704-716`（僅 V2 舊分支） | 該次不計入 `formatsIdentified`，統計失真而已 |

### 功能性降級（2 處，需決定是否一併處理）

| # | 位置 | 現象 | 性質 |
|---|------|------|------|
| D1 | `src/app/api/documents/[id]/route.ts:372-381` | `formatStillNeedsConfig`（偵測「格式記錄事後被刪除」）的 `if` 恆為 false，該偵測失效 | 非新引入 —— FIX-120 後已有部分路徑回傳空值；但選項 A 會**擴大**其發生範圍 |
| D2 | `src/components/features/document/detail/SmartRoutingBanner.tsx:129-142` | 新格式且無 `formatId` 時，橫幅只剩 badge 與說明，**沒有任何操作按鈕**。公司側有 fallback（`:144-157`），格式側沒有 | UI 體驗降級 |

> 🔴 D2 的**既有 bug**（與本 FIX 無關）：呼叫端 `src/app/[locale]/(dashboard)/documents/[id]/page.tsx:107-111` **根本沒有傳入 `formatId` prop**，所以那顆「設定格式」按鈕**現在就已經永遠不會顯示**。若要修 D2，須連同呼叫端一起補。

### 盤點方法

以 `Explore` agent 從 `resolveFormatId` 回傳值出發，逐層追蹤至持久化、信心度、模板匹配、API/UI；排除「使用者主動選格式」的管理介面路徑（該場景 `formatId` 必然有值）。

---

## 實作記錄（2026-07-21）

**用戶決策**：採 **方案 A**；D1 / D2 兩處功能性降級**不在本 FIX 處理**，另開 FIX。

### 實際改動

`jitCreateFormat` 的回傳型別由 `Promise<{ id: string; name: string }>` 放寬為 `Promise<{ id?: string; name: string }>`，`existing` 命中時：

```ts
if (existing) {
  // FIX-124: 不沿用 existing.id。仍需留下記錄，否則只是把「靜默錯誤指派」換成「靜默不指派」。
  console.warn(`[Stage2] JIT format creation hit the unique key (…existing="${existing.name}"). ` +
    `Returning no formatId for "${formatName}" — this layout is not registered yet.`);
  return { name: formatName };
}
```

三點說明：

1. **呼叫端無需改動** —— `resolveFormatId` 步驟 5 的 `formatId: newFormat.id` 自然帶出 `undefined`，`isNewFormat: true` 維持不變（與盤點發現 3 一致：兩者本就獨立）。
2. **`formatName` 用 GPT 給的新名稱**，不是既有格式的名稱 —— 文件本來就不屬於那個格式。
3. **FIX-058 的唯一鍵防護仍完整** —— 撞鍵時一樣不執行 `create`，不會回歸唯一約束崩潰。

> 日誌選用 `console.warn` 而非 `logger`：本檔既有輸出全為 `console.*`（match existing style），且專案 ESLint 的 `no-console` 允許 `warn`/`error`，故未新增任何 lint 警告。

---

## 修改的檔案

| 檔案 | 修改內容 |
|------|----------|
| `src/services/extraction-v3/stages/stage-2-format.service.ts` | `jitCreateFormat`：`existing` 命中時回傳無 id + `console.warn` 記錄；回傳型別放寬 |
| `tests/unit/services/stage-2-format-resolve-format-id.test.ts` | 補 2 條 FIX-124 迴歸測試 |
| `scripts/local-verify-fix123-124.ts` | 新增（唯讀驗證工具）：解析 Stage 2 GPT 原始回應，還原比對鏈命中路徑 |

---

## 測試驗證

- [x] 下游對 `formatId` 為空的容忍度盤點完成（修復前置）—— 見上方盤點段落，13 處安全降級 / 2 處功能性降級 / 0 處崩潰
- [x] `matchedKnownFormat: null` 且公司已有 `INVOICE/GENERAL` 格式時，**不再**沿用該格式的 id
- [x] 公司**尚無**任何格式時，JIT 仍正常建立新格式（不得回歸 FIX-058 的唯一鍵崩潰）
- [x] 真正匹配到已知格式的路徑不受影響（`isNewFormat: false`）—— FIX-120 / FIX-123 測試覆蓋
- [x] `npm run type-check` 無錯誤；`npm run lint` 該檔警告數維持 2 個（皆為既有 `console.log`）
- [x] 單元測試：13 passed（FIX-120 6 + FIX-123 5 + FIX-124 2）
- [x] 重跑 CEVA 清關型文件，確認不再被指派為版面 A

---

## 實機驗證結果（2026-07-21，本地 86 份全量重跑）

### 核心成效：錯誤指派清零

| 指標 | 重跑前 | 重跑後 |
|------|--------|--------|
| CEVA 版面 A（`cmqur1q73…`）被指派數 | 50 | **31** |
| CEVA 版面 B（`cmrsmg8mb…`）被指派數 | 15 | 16 |
| 全庫 `isNewFormat: true` | 25 | **19** |
| 全庫 `isNewFormat: false` | 55 | **60** |

**17 份**原本被錯誤指派為版面 A 的 CEVA 文件，重跑後 `formatId` 為空、`isNewFormat: true`
—— 即由「靜默錯誤指派」轉為「誠實回報未登記」。

### 佐證：這 19 份確實不屬於任何已知格式

解析 Stage 2 的 GPT 原始回應（`scripts/local-verify-fix123-124.ts`）確認：
**19 份的 `matchedKnownFormat` 全部為 `null`**，且 `formatName` 皆為 GPT 自行宣告的新名稱，例如

```
"CEVA Logistics (HONG KONG) LTD 其他/未知版面 Invoice（無法歸入已知兩類）"
"新格式：CEVA LOGISTICS（HONG KONG OFFICE）清關/貨運型（非已知兩種版面）"
"CEVA LOGISTICS (HONG KONG) LTD 清關/貨運型 Invoice（深藍標題條+單行費用明細，含 CONSOL/CONTAINERS）"
```

GPT 明確表示「非已知格式」，系統修復前卻把它們全指派給版面 A —— 與 FIX-124 問題描述完全吻合。

### 觀察到但**非本 FIX 造成**的現象：GPT 判斷漂移

有 8 份文件由 `isNewFormat: false` 變為 `true`（看似退步）。查證後其 `matchedKnownFormat`
同樣全為 `null`，屬 **GPT 對 CEVA 版面的判斷本身不穩定**，而非比對邏輯退步。

同一份文件的不同副本可得到彼此不同的結論（例：`CEVA LOGISTICS_CEX240464_39613.pdf` 的
6 份副本中，3 份判為版面 A、3 份判為各不相同的「新格式」）。

> 🔴 根因指向**待辦 1（CEVA 第三種版面未建檔）**：清單裡沒有對應項目時，GPT 只能在
> 「勉強歸入版面 A」與「宣告新格式」之間擺盪。建檔後此漂移應大幅收斂。
> 本 FIX 的價值在於：漂移發生時**不再被靜默轉換成錯誤的 formatId**。

---

## 關聯

- FIX-058 — 本問題的來源；其唯一鍵防護是必要的，但沿用既有格式的副作用未被考慮
- FIX-120 — 同類缺陷（靜默任意匹配）在模糊比對路徑的修復，處置原則可直接沿用
- FIX-123 — 名稱比對脆弱使更多文件**不必要地**落入 JIT，放大本問題；兩者需一併修復才完整
- FIX-115 — 讓多格式辨識真正生效，本問題因此才浮現

---

## 待辦（本 FIX 範圍外）

### 1. ~~CEVA 第三種版面建檔~~ → 改為修正既有兩個格式的 identificationRules ✅ 已完成（2026-07-21）

> 🔴 **原規劃的前提經實機資料推翻**。原本要建立第三種版面（`CUSTOMS_CLEARANCE` subtype），
> 但解析那 19 份文件的 GPT 特徵描述後確認：**它們不是新版面，而是既有格式的比對門檻過嚴**。

#### 推翻原規劃的三項證據

| # | 證據 |
|---|------|
| 1 | 其中 1 份（`CEVA_RCIM250326_17866.PDF`）**根本是第二類** —— QR code、`Original INVOICE / N° / Edited by` 框、F 起首發票號、`Client Tax ID`、分欄費率表、`TOTAL TO PAY BEFORE`、頁碼右下角全部命中，GPT 卻因「清晰度不足以完全排除清單差異」而不敢確認 |
| 2 | 多份幾乎逐項符合第一類（如 `CEVA_HEX250447,0448_45585.pdf` 命中深藍橫幅、右側六欄標籤、純數字發票號、`@` 內嵌匯率、`CONSOL NUMBER`、`PRINTED BY`、`CONTAINERS`），**唯一不符是抬頭寫成 `(HONG KONG) LTD`** |
| 3 | **同一份 PDF 的不同副本描述互相矛盾** —— `CEVA LOGISTICS_CEX240471_41608.pdf` 三份副本對費用明細的描述分別是「單行文字/等寬排版」「網格/表格樣式多欄」「多欄欄位表格式」。歸納不出一致的第三版面特徵 |

#### 兩層根因

1. **抬頭被寫成排他措辭**（第一類「非 `(HONG KONG) LTD`」／第二類「非 `HONG KONG OFFICE`」），
   但 GPT 對抬頭的讀法有三種變體：`HONG KONG OFFICE` 8 份、`(HONG KONG) LTD` 6 份、`(HONG KONG) OFFICE` 4 份。
   讀成非指定寫法即被規則自己排除。
2. **條列式 keywords 誘導「逐項全符才算匹配」**——19 份中有 8 份抬頭其實符合卻仍被判新格式，
   連原本已標註「不構成排除理由」的條件性 `CONTAINERS` 都被當成必要條件。

#### v1 修正與其失誤（已修正，記錄為教訓）

v1 把 keywords 改為【核心】/【輔助】分層 + 【匹配指引】。結果 `isNewFormat` 歸零，
但**造成 13 份跨類誤判**（11 份第二類被判成第一類）。兩個失誤：

| # | 失誤 | 說明 |
|---|------|------|
| a | **拿掉了冗餘** | 把所有次要特徵降為「不構成排除理由」後，判定全押在單一視覺特徵（有無 QR code），而 GPT 對它的判讀本身不可靠 —— 實測同一份文件時而說有時而說無，甚至寫出 `F260027…` 卻聲稱「並未以字母 F 起首」 |
| b | **第一類侵蝕第二類** | v1 加了「費用明細亦可能是多欄表格」，而分欄表格原是第二類的識別特徵 |

> 🔴 **最重要的教訓**：v1 的【匹配指引】逼 GPT 二選一，把「可見的失敗（宣告新格式）」
> 換成「隱藏的錯誤（錯誤指派）」—— 正是 FIX-124 要避免的事，只是換了發生位置。

#### v2 修正（現行）

| # | 改動 | 目的 |
|---|------|------|
| 1 | **主要錨點由視覺改為文字** —— QR code 降為【輔助】並註明「可能漏看或誤判，不得單獨作為判定依據」 | 文字辨識比圖形辨識穩定 |
| 2 | 第一類加**【排除】條款**：出現 `Original INVOICE`／`N°`／`Edited by`／`TOTAL TO PAY BEFORE`／`Client Tax ID`／`Incoterm ref`／`Consol ref`／`Operations 或 Tracking ref` 任一，或分欄費率表 → 改判第二類 | 恢復冗餘校驗 |
| 3 | 第二類加**【核心-替代認定】**：上述獨有欄位命中任兩項即判定為本格式 | 不依賴 QR code 判讀 |
| 4 | 【匹配指引】改為三段式判定順序，**不再逼二選一** | 兩類皆不符時仍應回報新格式 |
| 5 | 保留 v1 的抬頭放寬 | 該排他措辭確實是錯的 |

#### 三輪實機數據對照（本地 86 份全量重跑 ×3）

| 指標 | 修正前 | v1 | **v2（現行）** |
|------|--------|----|----------------|
| `isNewFormat: true` | 19 | 0 | **5** |
| 版面 A 指派數 | 31 | 58 | **44** |
| 版面 B 指派數 | 16 | 8 | **17** |
| 跨類誤判 | — | **13** | **0** |

v2 的 12 份跨類跳動經逐份查證**全部是正確修正**：11 份 `CEVA_RCIM*` 回到第二類，
1 份（`CEVA LOGISTICS_CEX240464_39613.pdf`）回到第一類 —— 該份 GPT 明確寫出
「左上角未清楚辨識到 QR code（**但此為輔助特徵，且不影響主要判斷**）」，證實新措辭生效。

#### 殘留 5 份的成因（判定為可接受）

5 份仍回報新格式，全部集中在 2 個檔案的副本（`CEX240471_41608` ×3、`CEX240464_39613` ×2），
原因一致：**費用明細被讀成「多欄表格」**，不符第一類核心第 3 條（等寬單欄 + `@` 內嵌匯率）。

GPT 的說明顯示規則正確運作 —— 它逐條檢查了第二類的替代認定欄位與分欄費率結構，
確認兩類皆不符才宣告新格式，符合【匹配指引】第 (3) 步的設計意圖。

> 判定為**可接受**：5 份誠實的「未登記」優於 13 份隱藏的錯誤指派，與 FIX-124 的核心原則一致。
> 若要再收斂，可考慮把「多欄表格」加回第一類的【輔助】（非核心）—— 因 v2 已有【排除】條款保護第二類，
> 風險低於 v1，但仍需再次全量驗證。**未執行，留待決定。**

#### 修改工具

| 檔案 | 用途 |
|------|------|
| `scripts/local-update-ceva-format-rules.ts` | gated 寫入（預設 dry-run，需 `RUN_CEVA_FORMAT_RULES_UPDATE=true`） |
| `scripts/local-inspect-ceva-formats.ts` | 唯讀檢視格式定義與 GPT 版面特徵（可傳 documentId 前綴指定文件） |

> 🔴 **僅套用於本地環境**。腳本內的格式 id 是本地值，Azure 的 `DocumentFormat` id 不同，
> 套用前必須先查出 Azure 對應的 id。

### 2. D1 / D2 兩處功能性降級（用戶 2026-07-21 決定另開 FIX）

| # | 位置 | 待處理內容 |
|---|------|-----------|
| D1 | `src/app/api/documents/[id]/route.ts:372-381` | `formatStillNeedsConfig` 偵測失效。若需保留該複查能力，可在 `stage2Result` 另存 `collidedWithFormatId`（語義與「本文件的 formatId」區分），供此類邏輯使用 |
| D2 | `src/components/features/document/detail/SmartRoutingBanner.tsx:129-142` | 新格式且無 `formatId` 時橫幅無操作入口。仿公司側（`:144-157`）補 `newFormatDetected && !formatId` 的通用 `/formats` fallback 連結；**須連同呼叫端** `src/app/[locale]/(dashboard)/documents/[id]/page.tsx:107-111` 一起修（該處目前根本沒傳 `formatId` prop，屬既有 bug，與本 FIX 無關）。涉及 UI 字串 → 需 i18n 3 語言同步 |

---

*文件建立日期: 2026-07-21*
*最後更新: 2026-07-21（實作完成，採方案 A）*
