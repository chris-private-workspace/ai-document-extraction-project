# 同公司多文件格式設定指南

> **用途**：當同一間公司寄來的文件有**明顯不同的版面**（但公司識別正確）時，如何建立第 2 個以上的 `DocumentFormat` 並掛上 FORMAT scope 配置，讓不同版面套用不同的提取規則。
>
> **建立日期**：2026-07-20（UAT 期間 CEVA 雙版面情境）
> **前置修復**：[FIX-114](../4-changes/bug-fixes/FIX-114-document-format-id-uuid-validation-blocks-format-scope.md)（解除 FORMAT scope 配置無法建立的阻塞）

---

## 適用情境判斷

先確認問題**不是**公司識別錯誤：

| 現象 | 判斷 |
|------|------|
| 兩份文件被判為同一公司，且**確實是**同一公司（收款帳號/法人名稱相同），但版面不同 | ✅ 適用本指南 |
| 兩份文件被判為同一公司，但**其實是不同公司** | ❌ 屬公司識別問題，見 `stage-1-company.service.ts` 與 FIX-104/105/112/113 |
| 同一公司產生多筆重複記錄 | ❌ 屬公司重複問題，見 FIX-105、`company.service.ts` 的 `mergeCompanies` |

---

## 機制概要

FORMAT 是**所有主要配置表的最高優先層級**：

| 配置表 | 優先序 | 解析位置 |
|--------|--------|----------|
| `PromptConfig`（提取指令） | FORMAT > COMPANY > GLOBAL | `prompt-assembly.service.ts:474` |
| `FieldDefinitionSet`（欄位定義） | FORMAT > COMPANY > GLOBAL | `field-definition-set.service.ts:421` |
| `TemplateFieldMapping`（模板映射） | FORMAT > COMPANY > GLOBAL | `template-field-mapping.service.ts:377` |
| `FieldMappingConfig`（欄位映射） | FORMAT > COMPANY > GLOBAL | `mapping/config-resolver.ts:40` |
| `PipelineConfig`（匯率/參考編號開關） | FORMAT > COMPANY > REGION > GLOBAL | `pipeline-config.service.ts:392` |

### 🔴 核心限制：每間公司自動只會產生 1 筆格式

`DocumentFormat` 的唯一鍵是 `(companyId, documentType, documentSubtype)`（`schema.prisma:2904`），而 Stage 2 的 JIT 建立**寫死** `INVOICE` / `GENERAL`：

```typescript
// stage-2-format.service.ts:545-546
const documentType = 'INVOICE' as const;
const documentSubtype = 'GENERAL' as const;
```

撞到既有記錄就直接沿用（`:550-560`，FIX-058 的防撞邏輯）。**所以第 2 個以上的格式必須手動建立**，並藉由改變 `documentType` 或 `documentSubtype` 避開唯一鍵。

可用組合：`documentType` 8 值 × `documentSubtype` 8 值 = 每間公司 64 種組合。

> `documentSubtype` 在此被當作「版面區分槽」使用，語意上是妥協。已確認對 V3.1 管線無副作用——Stage 2 撈格式時只用 `companyId`（`loadFormatConfig:262-273`），不按 subtype 篩選。

---

## 操作步驟

### 前置

```bash
npx prisma generate      # 若剛拉過 code 或清過快取
npm run dev -- -p 3200
```

查出目標公司的 id 與既有格式：

```sql
SELECT id, name FROM companies WHERE name ILIKE '%<關鍵字>%';

SELECT f.id, f.name, f.document_type, f.document_subtype
FROM document_formats f
JOIN companies c ON c.id = f.company_id
WHERE c.name ILIKE '%<關鍵字>%';
```

---

### 🔴 步驟 0：確認 Stage 2 prompt 有注入 `${knownFormats}`（否則以下全部白做）

**這是整份指南最關鍵的前提。** 2026-07-20 實測發現：

- Stage 2 有自訂 `PromptConfig` 時，走 DB prompt + 變數替換；**沒有**才用會自動注入格式清單的硬編碼 prompt（`stage-2-format.service.ts:152-167`）。
- 系統內建的 GLOBAL「V3.1 Stage 2 - Format Identification」配置原本**一個變數都沒用**，`${knownFormats}` 不在裡面。
- 結果：GPT 在 Stage 2 **看不到任何已知格式清單**，只能憑空猜名字 → `matchedKnownFormat` 幾乎必為 null → 模糊比對失敗 → 一律走 JIT → 撞唯一鍵 → 沿用該公司唯一那筆格式。

**所以 identificationRules 的 keywords 寫得再好，在該配置下完全不會進入 GPT。**

> ✅ **已由 [FIX-115](../4-changes/bug-fixes/FIX-115-stage2-prompt-missing-knownformats-variable.md) 修復**（GLOBAL prompt version 3 起含 `${knownFormats}`）。
> 但**既有環境不會自動更新** —— seed 對既有記錄只改 name/description、不覆寫 prompt 內容。
> 需另外執行 `node prisma/update-stage2-prompt.js`（Azure 經 Kudu ad-hoc）。下方檢查方式仍建議先跑一次確認。

檢查方式：
```sql
SELECT name, scope, system_prompt LIKE '%${knownFormats}%' AS has_var
FROM prompt_configs WHERE prompt_type='STAGE_2_FORMAT_IDENTIFICATION' AND is_active=true;
```

修法：建一個 COMPANY scope 的 Stage 2 `PromptConfig`（或修 GLOBAL，但影響全系統），system prompt 必須包含 `${knownFormats}`，並要求 GPT **逐字複製**清單中的格式名稱——因為 `resolveFormatId` 第一步是拿 `matchedKnownFormat` 與 DB `name` 做**完全相等**比對（`stage-2-format.service.ts:478-494`）。

可用變數（`buildStage2VariableContext`，`variable-replacer.ts:400`）：`${companyName}`、`${companyAliases}`、`${knownFormats}`、`${currentDate}`、`${pageCount}`、`${fileName}`。
`${knownFormats}` 會渲染成：
```
- <格式名稱>: <該格式 identificationRules.keywords 以逗號串接>
```

> CEVA 的實作範例見文末「實例」節。

---

### 🔴 步驟 1：先收窄「既有格式」的識別規則（最關鍵，別跳過）

自動建立的格式，其 keywords 通常是**通用描述**（例如「左上角有 XX 公司信頭」「有品牌 Logo」）——新版面**同樣符合**。若不先收窄，Stage 2 會把新版面也判給舊格式，後續配置全部落空。

前往 `http://localhost:3200/zh-TW/companies/<companyId>` → 「格式」分頁 → 點進既有格式 → 識別規則編輯器。

把 keywords 換成**只有該版面具備**的特徵。挑選原則：

- ✅ 具體的欄位名稱（該版面獨有的欄位標籤）
- ✅ 發票號/單號的格式特徵（純數字 vs 字母前綴、位數）
- ✅ 版面結構（深色橫幅 vs 白底細框線、分欄表 vs 純文字行）
- ✅ 特殊元素（QR code、浮水印、頁碼位置）
- ❌ 避免「有公司 Logo」「有發票標題」這類所有版面共通的描述

#### 🔴 可變值一定要就地標註（FIX-121）

Stage 2 的判斷帶**排他性** —— 特徵「明確不存在」就排除該格式。若 keywords 含**隨單張文件變動的值**，遇到稍有不同的文件就可能誤排除正確格式：

| 寫法 | 失效情境 |
|------|----------|
| 頁碼 `Page 1 of 1` 位於右下角 | 多頁發票是 `Page 1 of 3` |
| 費用表 …\| `CHARGES IN HKD` | 泰銖帳單是 `CHARGES IN THB` |
| 含 `CONTAINERS` 區塊列出櫃號 | 空運／散貨無櫃號 |
| 發票號為 **12 位**純數字 | 位數由單一樣本推得 |

**但不可以把具體字串刪掉改寫成抽象描述** —— 已實測失敗（[FIX-119](../4-changes/bug-fixes/FIX-119-stage2-overfit-identification-keywords.md)，已回滾）。Stage 2 用 `gpt-5.4-nano` + `imageDetailMode: "low"`（降採樣圖像），`F260017865`、`CHARGES IN HKD` 這類獨特字串是**弱模型的辨識錨點**；換成「以字母 F 起首」後，模型連 QR code 和分欄表格都認不出來。

**正解是兩者兼顧：保留具體範例當錨點，並在同一條 keyword 內就地標註哪一段可變**（[FIX-121](../4-changes/bug-fixes/FIX-121-identification-rules-inline-variability-annotation.md)，實測四份全數通過）：

| ❌ 純具體（會誤排除） | ❌ 純抽象（認不出） | ✅ 具體 + 就地標註 |
|---|---|---|
| 頁碼 Page 1 of 1 位於標題列右端 | 頁碼標示位於標題列右端 | 頁碼位於標題列右端（如 Page 1 of 1，頁次與總頁數可變） |
| …\| EX RATE \| CHARGES IN HKD | …EX RATE、換算後金額欄 | …\| EX RATE \| CHARGES IN ⟨帳單幣別⟩（如 CHARGES IN HKD，幣別隨帳單變動） |
| 發票號為 12 位純數字（如 253250005808） | 發票號為純數字 | 發票號為純數字、無英文字母前綴（如 253250005808，位數可能不同） |
| 含 CONTAINERS 區塊列出櫃號 | （移除該條） | （條件性）貨櫃運送時含 CONTAINERS 區塊…；空運或散貨則無此區塊，不構成排除理由 |

GLOBAL Stage 2 prompt（version 4）已配合加入一句：標明「可變」「條件性」的部分不符時不構成排除理由。因此上表右欄的措辭**會被模型正確折扣**。

**撰寫原則**：

1. **具體字串一律保留** —— 它們是錨點，刪掉就認不出
2. **可變的部分就地標註** —— 用「（如 X，Y 可變）」「（條件性）…不構成排除理由」的句式
3. **負向特徵最穩定** —— 「無 QR code」這類有無判斷不受內容變動影響，優先寫
4. **避免從單一樣本推論精確規格** —— 位數、幣別、總頁數先寫寬鬆形態 + 範例
5. **遇到誤判優先補樣本**，而不是把規則寫得更抽象

> ⚠️ FIX-121 只驗證了「沒有回歸」—— 手上無多頁／非 HKD／空運樣本，觸發原始風險的情境無從重現。真正確證仍需補樣本。
> 教訓：規則的抽象程度必須與**模型能力**匹配。此結論僅適用於當前 nano + low detail 組合；若改用更強模型或提高 `imageDetailMode`，應重新評估。

`identificationRules` 完整結構（`validations/document-format.ts:50-59`）：

```json
{
  "logoPatterns": [{ "position": "top-left", "description": "..." }],
  "keywords": ["...", "..."],
  "layoutHints": "一句話描述整體版面",
  "priority": 60
}
```

| 欄位 | 限制 |
|------|------|
| `logoPatterns` | 最多 10 個；`position` 為 `top-left` / `top-right` / `top-center` / `bottom-left` / `bottom-right` / `center`；`description` 1–200 字 |
| `keywords` | 最多 50 個，每個 1–100 字 |
| `layoutHints` | 最多 1000 字，預設 `''` |
| `priority` | 0–100，預設 50 |

> `logoPatterns` 與 `keywords` 在 schema 是**必填陣列**（可傳空陣列，但不可省略）。

---

### 步驟 2：建立新格式

同一頁面點「建立格式」：

| 欄位 | 說明 |
|------|------|
| 文件類型 | 通常維持 `INVOICE` |
| 文件子類型 | **必須不同於既有格式**，否則撞唯一鍵回 409 |
| 名稱 | 用可辨識版面特徵的描述，1–200 字 |
| 進階選項（自動建立配置） | **建議關閉**——自動建的是舊的 `FIELD_EXTRACTION` 類型，不是 V3.1 用的 `STAGE_3_FIELD_EXTRACTION` |

建立後**記下回傳的格式 id**（cuid，`c` 開頭 25 字元）。

> 入口只在公司詳情頁的「格式」分頁，**沒有獨立的 `/formats` 列表頁**；且該分頁用 `defaultValue` 非 URL query，無法用 URL 直接深連。

---

### 步驟 3：填新格式的識別規則

同步驟 1 的原則，填入只有新版面具備的特徵。

---

### 步驟 4：建立 FORMAT scope 的提取指令

前往 `http://localhost:3200/zh-TW/admin/prompt-configs/new`

| 欄位 | 值 |
|------|-----|
| Prompt 類型 | **`STAGE_3_FIELD_EXTRACTION`**（V3.1 用；不要選舊的 `FIELD_EXTRACTION`） |
| Scope | `FORMAT` |
| 公司 | 目標公司 |
| 文件格式 | 新格式 |
| 合併策略 | `OVERRIDE` |

`systemPrompt` 針對新版面的結構差異撰寫（例如費用表是分欄還是純文字行、匯率在哪一欄）。

> ⚠️ 介面在 FORMAT scope 時「公司」欄位**不顯示必填星號**，但後端會擋（`prompt-config.schema.ts:209-223`）。公司與文件格式**兩個都要選**。

---

### 步驟 5：建立 FORMAT scope 的欄位定義集

前往 `http://localhost:3200/zh-TW/admin/field-definition-sets/new`

Scope 選 `FORMAT`，公司與文件格式**都要選**，至少挑 1 個欄位。

`fields` 每筆結構（`lib/validations/field-definition-set.schema.ts:84-100`）：

| 欄位 | 必填 | 限制 |
|------|------|------|
| `key` | ✅ | snake_case，`^[a-z][a-z0-9_]*$`，≤100，不可重複 |
| `label` | ✅ | ≤200 |
| `category` | ✅ | ≥1 字 |
| `dataType` | ✅ | `string` / `number` / `date` / `currency` |
| `required` | | 預設 `false` |
| `aliases` | | ≤20 個 |
| `extractionHints` | | ≤1000 |
| `fieldType` | | `standard` / `lineItem` |

> 此步驟先前會被擋在 400（`Invalid uuid`），已由 **FIX-114** 修復。

---

### 步驟 6：驗證配置生效

```
GET /api/v1/formats/<新格式id>/configs
```

看 `inheritance.effectivePromptLevel` 是否為 `"FORMAT"`。若顯示 `COMPANY` 或 `GLOBAL`，代表沒掛上。

### 🔴 不要用 `/field-definition-sets/resolve` 驗證欄位集

```
GET /api/v1/field-definition-sets/resolve?companyId=<公司id>&documentFormatId=<格式id>
```

這個端點**不會合併三層**——它呼叫 `getResolvedFields`，只回傳「最具體那一層」（實測：FORMAT 層有 4 個欄位就只回 4 個）。但它的 JSDoc（`resolve/route.ts:8`）與服務層註解（`field-definition-set.service.ts:14`）都寫「解析**合併**欄位」，**註解與行為不符**，容易誤導。

實際提取用的是**會合併**的版本：

| 使用者 | 函式 | 語意 |
|--------|------|------|
| Stage 3 提取 | `stage-3-extraction.service.ts` 內的 `loadFieldDefinitionSet` | ✅ 合併（GLOBAL → COMPANY → FORMAT，同 key 取代） |
| 匯率轉換 | `getMergedResolvedFields` | ✅ 合併 |
| `/resolve` API | `getResolvedFields` | ❌ 只回最具體一層 |

所以 FORMAT 層只放「需要覆蓋的欄位」是安全的，其餘會從 COMPANY 層繼承——但**不能靠 `/resolve` 確認這件事**。要確認實際生效的欄位集，只能重跑文件後檢查 `stage3Result.fields` 的 key 集合。

---

### 步驟 7：重跑文件驗證

`POST /api/documents/{id}/retry` 會**先清掉舊的 `extractionResult` 再重跑**，比 `/process` 乾淨。

#### 🔴 但成功處理過的文件，UI 上沒有重跑入口

重試按鈕的顯示條件只涵蓋失敗狀態：

| 位置 | 判斷依據 | 涵蓋狀態 |
|------|----------|----------|
| 列表頁 `DocumentListTable.tsx:317` | `statusConfig.canRetry` | `OCR_FAILED` / `REF_MATCH_FAILED` / `FAILED` |
| 詳情頁 `DocumentDetailHeader.tsx:84` | 硬編碼 `['OCR_FAILED','FAILED']` | `OCR_FAILED` / `FAILED` |

而服務層 `retryProcessing`（`document.service.ts:567-608`）其實允許 `MAPPING_COMPLETED` / `UPLOADED` / `OCR_COMPLETED`。

**所以配置改完後想重跑一份已成功處理的文件，UI 上做不到。** 兩個變通方式：

1. 登入後在 DevTools Console 直接呼叫（會自動帶 session cookie）：
   ```js
   await fetch('/api/documents/<documentId>/retry', { method: 'POST' }).then(r => r.json())
   ```
2. 重新上傳同一份文件（會產生新的 document 記錄）

> 另注意：詳情頁的 [Refresh] 按鈕只是 React Query 的 `refetch`，**不會重跑處理**。
>
> 已知不一致：詳情頁沒用共用的 `canRetryStatus()` helper，導致 `REF_MATCH_FAILED` 的文件在列表頁有重試按鈕、詳情頁卻沒有。

**驗收點**：查 `extraction_results.stage_2_result`，確認 `formatId` 指向新格式、`isNewFormat` 為 `false`。

---

## 已知限制

1. **匹配靠 GPT 語意 + 名稱字串比對**，不是版面指紋（全 codebase 無 `formatSignature` / `layoutHash` 機制）。第一次跑可能不準，需迭代調整 keywords。
2. **匹配失敗會沿用既有格式**：GPT 回傳的 `formatName` 若對不上資料庫的 `name`，會走模糊比對（`name contains formatName`），再失敗就 JIT——但唯一鍵已被佔住，結果是**沿用舊格式**（`jitCreateFormat:550-560`）。這就是步驟 1 為何關鍵。
3. **格式不落外鍵**：`Document` / `ExtractionResult` 無 `documentFormatId` 欄位，格式只存在 `stage2Result` JSON 裡，無法用 SQL join 統計「某格式處理過幾份文件」。

---

## 實例：CEVA 雙版面（2026-07-20）

| 項目 | 值 |
|------|-----|
| 公司 id | `0d02b680-165b-4cfd-8c1b-7ebfa6da8424`（`CEVA LOGISTICS (HONG KONG) LTD`，62 份文件） |
| 既有格式 id | `cmqur1q73000vpkxgx48c54jo`（`INVOICE` / `GENERAL`） |
| 既有格式代表版面 | 版面 A（深藍色系） |
| 新增格式子類型 | `OCEAN_FREIGHT` |

> 以下 keywords 為 [FIX-121](../4-changes/bug-fixes/FIX-121-identification-rules-inline-variability-annotation.md) 套用**就地標註可變性**後的現況（可直接當範本抄）。

### 版面 A（深藍色系）— id `cmqur1q73000vpkxgx48c54jo`

```
標題列文字為 CEVA LOGISTICS HONG KONG OFFICE（非 (HONG KONG) LTD）
深藍色實心橫幅作為區塊標題底色（如 INVOICE、SHIPMENT DETAILS、CHARGES；CONTAINERS 僅貨櫃運送時出現）
右側成組標籤方塊：INVOICE DATE、CUSTOMER ID、SHIPMENT、REGISTRATION #、DUE DATE、TERMS
含 CONSOL NUMBER 欄位與 PRINTED BY 欄位
發票號為純數字、無英文字母前綴（如 253250005808，位數可能不同）
費用明細為等寬字體單欄文字行，匯率以 @ 內嵌於描述句中（如 USD 2,490.00 @ 7.834661，金額與匯率數值每張不同）
（條件性）貨櫃運送時含 CONTAINERS 區塊，單行列出多個櫃號與櫃型；空運或散貨則無此區塊，不構成排除理由
頁碼位於標題列右端（如 Page 1 of 1，頁次與總頁數可變）
無 QR code
無 Client Tax ID 或 Incoterm ref 欄位
```

`layoutHints`：`深色橫幅分區、右側鍵值方塊、費用為等寬字體純文字行、匯率內嵌描述句` ｜ `priority`：`60`

### 版面 B（白底表格線）— id `cmrsmg8mb0000bsxgjrqy6ksk`

```
左上角有 QR code（方形二維碼）
右上角黑色粗框方塊，內含 Original INVOICE、N°、Date、Due On、Terms、Edited by
發票號以字母 F 起首、後接一串數字（如 F260017865，位數可能不同）
含 Client Tax ID 欄位
含 Incoterm ref 欄位
含 Consol ref 與 Customer id/Account n° 欄位
含 Operations 與 Tracking ref 欄位
費用明細為分欄表格：DESCRIPTION | CUR | AMOUNT | EX RATE | CHARGES IN ⟨帳單幣別⟩（如 CHARGES IN HKD，幣別隨帳單變動）
底部含 TOTAL TO PAY BEFORE 列，並以英文大寫拼寫金額
白底細框線表格，無深色實心填充區塊
頁碼位於頁面右下角（如 PAGE 1 of 1，頁次與總頁數可變）
抬頭公司名為 CEVA LOGISTICS (HONG KONG) LTD（非 HONG KONG OFFICE）
```

`layoutHints`：`白底細框線表格、右上黑框發票資訊方塊、費用為 CUR/AMOUNT/EX RATE/CHARGES IN HKD 四欄分列、左上角 QR code` ｜ `priority`：`60`

### 版面 B 的 Stage 3 提取指令重點

費用表有獨立的 `CUR` / `AMOUNT` / `EX RATE` / `CHARGES IN HKD` 四欄——原幣金額取 `AMOUNT`、換算後取 `CHARGES IN HKD`、匯率取 `EX RATE`，**不要**像版面 A 那樣從描述句解析。
