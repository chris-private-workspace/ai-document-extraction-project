# CHANGE-107: Template Field Mapping 複製記錄功能

> **建立日期**: 2026-07-25
> **狀態**: ✅ 已完成（2026-07-25 本地實機驗證 10/10 驗收項通過；**2026-07-27 已部署 Azure DEV 並完成實機驗收** —— 映像 `dev-change107-fix133-20260727115120`，見 [部署記錄](../../../docs/07-deployment/02-azure-deployment/deployment-records/2026-07-27-dev-change107-fix133.md)）
> **優先級**: 中（不影響資料正確性，但嚴重影響設定效率）
> **類型**: Feature
> **影響範圍**: Template Field Mapping 列表、新建頁、表單、目標欄位選擇器、建立 API + 服務層

> ⚠️ **規劃前提已被實測推翻**：原文假設「相同四元組在 DB 層必被擋」，實測為**不成立**（PostgreSQL 的 NULL 語意）。
> 詳見 §實作記錄 → 「規劃前提的更正」。結論是 §變更內容 的設計方向仍然正確，但理由不同、且必須額外加應用層重複檢查。

---

## 背景與問題

Template Field Mapping 目前只能從空白表單逐筆建立。實際使用上，同一批配置的映射規則高度重複，卻要一條一條重建：

| 使用情境 | 重複程度 |
|---|---|
| 同一間公司要對多份 data template 各建一筆 | 規則幾乎相同，只有輸出模版不同 |
| 新增的 forwarder 費用結構與既有公司相近 | 規則可整套沿用，只需換公司 |
| 同一公司的多個文件格式各需一筆 FORMAT 範圍配置 | 規則相同，只有格式不同 |

以 CHANGE-101 的實績為參考：從 SCM Excel 批量建立 14 間公司的 mapping 共 **139 條規則**，正是因為 UI 逐筆建立成本過高而改用腳本處理。日常維運無法每次都寫腳本。

### 為何四個身分欄位在編輯時被鎖住（現況調查）

使用者提出「複製之後不能修改這些欄位就沒有意義」，調查後確認鎖定**有明確技術根據**，並非疏漏：

根因在 DB 層 —— `prisma/schema.prisma:3104`：

```prisma
@@unique([dataTemplateId, scope, companyId, documentFormatId], name: "unique_template_mapping")
```

這四個欄位構成記錄的**身分鍵**，不是普通屬性。整條鏈一致地跟著鎖：

| 層級 | 位置 | 現況 |
|---|---|---|
| Zod 驗證 | `src/validations/template-field-mapping.ts:281-310` | `updateTemplateFieldMappingSchema` 只收 name / description / mappings / priority / isActive，四個身分欄位**不在更新 schema 內** |
| API | `src/app/api/v1/template-field-mappings/[id]/route.ts:99` | JSDoc 明載「不能更改範圍和關聯」 |
| 服務層 | `src/services/template-field-mapping.service.ts:261-277` | `update()` 只組上述 5 個欄位 |
| 表單 | `TemplateFieldMappingForm.tsx:384 / 415 / 447 / 480` | `disabled={isSubmitting \|\| isEditing}`，與後端一致 |

同架構的 Field Definition Set 亦採同一做法（`FieldDefinitionSetForm.tsx:271 / 307 / 339`），屬專案對「範圍鍵配置」的既有 pattern。

### 由此推導出的設計約束

~~因為那條唯一約束，同一組 (dataTemplateId, scope, companyId, documentFormatId) **只能存在一筆**。因此「原地複製一份完全相同的記錄」在 DB 層必然被擋（409）。~~

🔴 **上段已於 2026-07-25 實測推翻**（見 §實作記錄 → 規劃前提的更正）。該唯一約束因 PostgreSQL 的 NULL 語意而**實務上從未生效**，相同四元組可以無聲重複建立。

修正後的結論：複製的價值仍然是「規則照抄、換一個目標」，**清空身分欄位讓使用者重選仍是正確設計** —— 但理由從「DB 會擋所以必須改」變成「**沒有任何機制會擋，所以更需要強制重選**」。缺口另以應用層重複檢查補上。

---

## 變更內容

### 1. 列表新增「複製」動作

`TemplateFieldMappingList.tsx` 的動作欄（第 280-304 行）加入複製按鈕，置於編輯與刪除之間，導向 `/admin/template-field-mappings/new?copyFrom=<id>`。

### 2. 新建頁支援複製來源預填

`new/page.tsx` 讀取 `searchParams.copyFrom`，以既有 prisma 存取撈取來源記錄，傳入表單。

**照抄**：全部 N 條映射規則、說明、優先級、啟用狀態；名稱＝原名 + 「（複製）」後綴。
**清空**：`dataTemplateId`、`scope`、`companyId`、`documentFormatId` 四個身分欄位，強制重選。

### 3. 表單的複製模式支援

`TemplateFieldMappingForm.tsx` 新增 `copySource` prop。以**新建模式**運作（`isEditing = false`，走既有 POST 路徑、既有 Zod 驗證、既有唯一約束），僅初始值來自來源記錄。

模版未選時，現行邏輯（第 555-568 行）整個規則編輯器不 render，只顯示「請先選擇數據模版」—— 複製後會看到看似空白的畫面，而 N 條規則其實已在 state 中。需加提示「已從『X』複製 N 條規則，請選擇數據模版與範圍後儲存」。

### 4. 目標欄位有效性防護（本次改動引入的必要防護）

`TargetFieldSelector.tsx:90-93` 以 `templateFields.find(f => f.name === value)` 找當前選中欄位。若複製來的 `targetField` 不存在於**新選的**模版欄位清單中：

- trigger 會 render 成 placeholder「選擇目標欄位」（第 132-134 行），看似未選
- 但 `rule.targetField` 底下仍留著舊值
- `templateFieldMappingRuleInputSchema`（`validations:137-145`）只驗「非空、≤100 字元」，不驗欄位是否屬於該模版 → **存得進去**
- 結果：存出一筆 `targetField` 在該模版不存在的規則，匹配時該欄位靜默無值 —— 與 FIX-128 處理的「拼錯 key 靜默變空」同型態

另有顯示不一致：`MappingRuleItem.tsx:302-308` 在折疊狀態下 render `rule.targetField` **原字串**（看得到舊值），展開時才變 placeholder（看不到）。

此弱點目前流程碰不到（編輯時模版鎖死、新建時規則從空白開始），但**清空模版後會成為常態路徑**，故屬本次改動造成的後果，由本 CHANGE 收掉：

- `TargetFieldSelector` 值不在清單中時，trigger 顯示該值 + 無效標示（取代靜默 placeholder），折疊與展開狀態一致
- 表單 `onSubmit` 前驗證所有 `targetField` 屬於所選模版，不通過則擋下並以 toast 指出條數

### 5. 唯一衝突判斷改用 Prisma error code

`src/app/api/v1/template-field-mappings/route.ts:177` 現以 `error.message.includes('unique')` 判斷唯一約束違反。此比對**大小寫敏感**，而 Prisma P2002 的訊息為 `Unique constraint failed on the fields: (...)`，有落空風險 → 會回 500「Unknown error」而非 409。

複製流程會頻繁走到這條路徑（使用者若沒改身分欄位就直接儲存），500 讓人完全不知道該改公司或範圍。改為 `error.code === 'P2002'` 正規判斷。

---

## 技術設計

### 修改範圍

| 檔案 | 類型 | 變更內容 |
|------|------|----------|
| `src/components/features/template-field-mapping/TemplateFieldMappingList.tsx` | 🔧 修改 | 動作欄加複製按鈕（`Copy` icon），導向 `new?copyFrom=<id>` |
| `src/app/[locale]/(dashboard)/admin/template-field-mappings/new/page.tsx` | 🔧 修改 | 讀 `searchParams.copyFrom` → prisma 抓來源記錄 → 傳 `copySource` prop；標題切換為複製版文案 |
| `src/components/features/template-field-mapping/TemplateFieldMappingForm.tsx` | 🔧 修改 | 加 `copySource` prop：初始化 `mappingRules` 與 name／description／priority／isActive，身分欄位留空；模版未選時顯示複製提示；submit 前驗 `targetField` 有效性 |
| `src/components/features/template-field-mapping/TargetFieldSelector.tsx` | 🔧 修改 | 值不在 `templateFields` 中時顯示該值 + 無效標示 |
| `src/app/api/v1/template-field-mappings/route.ts` | 🔧 修改 | 唯一衝突判斷改 `error.code === 'P2002'` |
| `messages/en/templateFieldMapping.json` | 🔧 修改 | 7 個新 key |
| `messages/zh-TW/templateFieldMapping.json` | 🔧 修改 | 同上 |
| `messages/zh-CN/templateFieldMapping.json` | 🔧 修改 | 同上 |

**不需修改**：`MappingRuleItem.tsx`（折疊態本就 render 原字串，修在 `TargetFieldSelector` 一處即可讓兩態一致）、`use-template-field-mappings.ts`（複製走既有 `createMapping`）、`template-field-mapping.service.ts`、`validations/template-field-mapping.ts`、Prisma schema。

### i18n 影響

| Key | en | zh-TW | zh-CN |
|-----|----|-------|-------|
| `actions.copy` | Copy | 複製 | 复制 |
| `page.copyTitle` | Copy Mapping Configuration | 複製映射配置 | 复制映射配置 |
| `page.copyDescription` | Copy rules from an existing configuration, then choose a new template and scope | 從現有配置複製規則，重新選擇模版與範圍 | 从现有配置复制规则，重新选择模版与范围 |
| `form.copyBanner` | Copied {count} rules from "{name}". Select a data template and scope before saving. | 已從「{name}」複製 {count} 條規則。請選擇數據模版與範圍後儲存。 | 已从「{name}」复制 {count} 条规则。请选择数据模版与范围后保存。 |
| `form.copyNameSuffix` | (Copy) | （複製） | （复制） |
| `form.errors.invalidTargetFields` | {count} rules have a target field that does not belong to the selected template | {count} 條規則的目標欄位不屬於所選模版，請修正後再儲存 | {count} 条规则的目标字段不属于所选模版，请修正后再保存 |
| `targetField.invalidValue` | Not in selected template | 不存在於所選模版 | 不存在于所选模板 |
| `form.scopePlaceholder` 🆕 | Select a scope | 選擇範圍 | 选择范围 |

> 🆕 `form.scopePlaceholder` 為實作時新增（規劃原列 7 組，實際 **8** 組）—— 讓 `scope` 有真正的未選狀態所必需，理由見 §實作記錄 → 規劃判斷有誤的兩點 #2。
> `form.copyNameSuffix` 的 en 值刻意含前導空格（` (Copy)`），中文用全形括號故不需空格。
> zh-CN 一律沿用該檔既有的「模板／字段」用語（非 zh-TW 的「模版／欄位」）。

命名空間 `templateFieldMapping` 已存在並已註冊於 `src/i18n/request.ts`，無需新增命名空間。

### 資料庫影響

**無**。不改 Prisma schema、不需 migration、不需 `apply-schema-drift.js` 條目。複製產生的是一筆普通的新記錄，走既有 `create()`。

---

## 設計決策

1. **預填走 URL 參數 + Server Component 載入，不用 client fetch**
   `TemplateFieldMappingForm.tsx:6-9` 的檔頭已記載過這個坑 —— Radix Select 無法顯示異步載入的值，因此才拆成「外層負責數據載入、內層負責表單邏輯」。`new/page.tsx` 是 Server Component 且已有 prisma 存取，server 端載入等於第一次 render 就有值，零異步、無需 loading 狀態。

2. **四個身分欄位全清（使用者 2026-07-25 決定）**
   亦是唯一約束的必然結果：完全同值的複製在 DB 層必被擋。三種使用情境（換模版／換公司／換格式）各自要變動的欄位不同，全清最一致。

3. **不解鎖既有記錄的身分欄位編輯（使用者 2026-07-25 決定）**
   PATCH 契約不變，全部改動落在新增路徑，既有編輯頁行為零變化。建錯歸屬的情況可用「複製到正確歸屬 + 刪掉錯的」處理，且不會讓已匹配過的 template instance 產生歷史歸屬歧義。若日後確實常需改歸屬，另立 CHANGE 處理（需同時處理 P2002 友善錯誤與 resolve 快取的雙邊失效 —— 快取鍵以 `dataTemplateId` 開頭，見 `service.ts:515-532`）。

4. **`targetField` 對不上時「保留值 + 標示 + 儲存前擋」，不自動清空**
   自動清空會靜默丟掉複製來的設定，使用者看不到丟了什麼；保留並標示則能明確指出要處理哪幾條。

5. **名稱後綴走 i18n（跟隨當前介面語言）**
   後綴出現在輸入框內、使用者會立刻改寫，用統一英文對中文使用者突兀。副作用：不同語言下複製產生的預設名稱不同 —— 無害且可接受。

---

## 明確排除（不在本次範圍）

| 項目 | 排除理由 |
|---|---|
| 解鎖既有記錄的 data template / scope / company 編輯 | 使用者決定不做（見設計決策 3） |
| 409 錯誤訊息的 i18n | `route.ts:185` 的 `detail` 是後端硬編碼中文，en 介面會露中文。屬全站 API `detail` 未 i18n 的既有狀況，非本次引入；要改需動 hook 的錯誤傳遞結構（目前 `use-template-field-mappings.ts:207-212` 只 throw `new Error(detail)`，不帶 status），會擴大範圍 |
| `targetField` 的後端驗證 | 只加前端擋。後端要驗需在 Zod 之外查 DataTemplate 欄位定義，屬 FIX-128「未知來源 key 警告」機制的同類延伸，另議 |
| 批量複製（一次複製到多間公司） | 本次先解決單筆複製。若批量需求成立，宜比照 CHANGE-101 的腳本路徑或另立 CHANGE |
| **修 DB 約束（`NULLS NOT DISTINCT` migration）** | 🔴 實測發現 `unique_template_mapping` 實務上從未生效（見 §實作記錄）。本次以應用層檢查補上缺口，未改 DB。改約束需先清理既有重複資料，且 `resolveMapping` 同範圍按 `priority` 合併暗示多筆同範圍配置可能是刻意分層 —— 風險高於收益，留作獨立資料完整性議題 |
| 既有重複資料的盤點與清理 | 因約束從未生效，正式環境可能已存在重複配置（本地驗證前無）。盤點屬獨立議題，需先確認「同範圍多筆」是否為刻意設計 |
| PATCH 路徑的重複檢查 | PATCH 不能改身分欄位，但可把停用的重複記錄改回 `isActive: true`。此邊緣情境未處理 |

---

## 實作記錄（2026-07-25）

### 規劃前提的更正 🔴

規劃時斷定「相同四元組在 DB 層必被擋（409）」。實測（複製 CEVA 配置並把身分欄位設成與來源完全相同）回的是 **201 Created**，成功建出兩筆身分完全相同的記錄。

根因：**PostgreSQL 的唯一約束把 NULL 視為互不相同**（預設 `NULLS DISTINCT`）。`unique_template_mapping` 的四欄組合在每一種範圍下都必然含至少一個 NULL：

| 範圍 | companyId | documentFormatId | 約束是否生效 |
|------|-----------|------------------|--------------|
| GLOBAL | NULL | NULL | ❌ 不生效 |
| COMPANY | 有值 | NULL | ❌ 不生效 |
| FORMAT | NULL | 有值 | ❌ 不生效 |

即 `unique_template_mapping` **對任何範圍都不生效**，是一條實務上從未發揮作用的約束。這是既有的資料完整性缺口，非本次改動造成，但複製功能會讓「無聲建出重複」變成日常路徑。

**處置（使用者 2026-07-25 決定：加應用層檢查，真的回 409）**：於 `service.create()` 前置 `findFirst` 比對四元組（Prisma 的 `companyId: null` 會產生 `IS NULL`，NULL 處理正確），命中則丟 `createConflictError`（既有 `AppError`，409 + RFC 7807）。

兩個設計細節：
- **只比對 `isActive: true`** —— API 的 DELETE 是軟刪除，若把停用記錄也算重複，使用者將無法重建。且 `resolveMapping` 只撈啟用配置，不會產生解析歧義。
- **未改 DB 約束** —— 曾評估 `NULLS NOT DISTINCT` migration，但那需先清理既有重複資料，且 `resolveMapping`／`mergeMappings`（`service.ts:452-459`）在**同範圍內**按 `priority` 排序合併，暗示多筆同範圍配置可能是刻意的分層設計。改 DB 約束會消滅該能力，風險高於收益，故留作獨立議題。

### 規劃判斷有誤的兩點（實作時修正）

| # | 規劃寫的 | 實際 | 修正 |
|---|----------|------|------|
| 1 | `MappingRuleItem.tsx` 不需修改 | **錯**。一次只有一條規則展開（`MappingRuleEditor` 的 `expandedId`），若無效標示只在展開時出現，使用者需逐條展開才找得到壞規則 —— 實測 5 條無效規則有 4 條處於折疊狀態 | 折疊態也加無效標示（`hasInvalidTargetField`，以 `templateFields.length > 0` 防止模版未解析時誤標全部） |
| 2 | 清空 `scope` | **不可能**。表單 schema 是 `z.enum(['GLOBAL','COMPANY','FORMAT'])`，沒有空狀態；落回預設 `GLOBAL` 有實質危害 —— GLOBAL 是唯一不需再填任何欄位就能存檔的範圍，從 COMPANY 配置複製後未察覺即會建出套用到**所有公司**的映射 | 讓 `''` 成為合法未選狀態 + `請選擇範圍` 驗證 + 新增 `form.scopePlaceholder`（故 i18n 為 **8** 組 key 而非規劃的 7 組）。僅複製模式產生 `''`，一般新建仍預設 `GLOBAL`（不改既有行為） |

另有一個型別陷阱：`scope` 型別放寬後，`onSubmit` 內 `if (!values.scope) return` 的窄化**不會**透過 `...values` 展開傳遞（TS 展開用原始宣告型別），`npm run type-check` 抓到後改為先解構 `const { scope: selectedScope, ...restValues } = values`。

### 改動清單

| 層 | 檔案 | 改動 |
|---|---|---|
| 列表 | `TemplateFieldMappingList.tsx` | `Copy` icon 按鈕（編輯與刪除之間）+ `handleCopyClick` → `new?copyFrom=<id>` |
| 頁面 | `admin/template-field-mappings/new/page.tsx` | `searchParams.copyFrom` → `getCopySource()`（server 端載入，找不到則退化為一般新建）+ 標題／metadata 切換 |
| 表單 | `TemplateFieldMappingForm.tsx` | 匯出 `TemplateFieldMappingCopySource` 型別；`copySource` prop 初始化規則與 name／description／priority／isActive；`scope: ''` 未選狀態 + 驗證；複製橫幅（Alert）；submit 前 `targetField` 有效性擋存 |
| 組件 | `TargetFieldSelector.tsx` | `hasInvalidValue` → trigger 顯示原值 + 紅框 + 「不存在於所選模版」徽章（取代靜默 placeholder） |
| 組件 | `MappingRuleItem.tsx` | 折疊態的無效標示（見上表 #1） |
| 服務 | `template-field-mapping.service.ts` | `create()` 前置應用層重複檢查 → `createConflictError`（409） |
| API | `api/v1/template-field-mappings/route.ts` | `isAppError` → 409 分支；唯一約束判斷改 `Prisma.PrismaClientKnownRequestError` + `code === 'P2002'`（保留為 defence in depth） |
| 匯出 | `template-field-mapping/index.ts` | 一併匯出 `TemplateFieldMappingCopySource` |
| i18n | `messages/{en,zh-TW,zh-CN}/templateFieldMapping.json` | 8 組 key（見 §i18n 影響，另加 `form.scopePlaceholder`） |
| 腳本 | `scripts/local-cleanup-change107-test-records.ts`（新建） | 驗證期間 2 筆測試配置的 gated 硬刪除（API DELETE 只軟刪除）；已執行，本地資料庫回復原狀 |

### 本地實機驗證（Playwright，localhost:3200）

以既有 `CEVA outbound to logistics outbound template - v1`（COMPANY / CEVA / 5 條規則）為來源：

- **正向**：複製 → 改選 DHL Express（同模版）→ 建立成功，來源記錄完全未變；列表 4→5 筆
- **無效目標欄位**：改選 `ERP 標準匯入格式` → 5 條規則全部顯示「不存在於所選模版」（1 條展開 + 4 條折疊皆標示）→ 按建立被擋，toast「5 條規則的目標欄位不屬於所選模版」；改回原模版後標示歸零
- **重複**：身分欄位設成與來源完全相同 → 修正前回 **201**（建出重複）；加應用層檢查後回 **409**，toast 指出撞到哪一筆
- **回歸**：既有記錄編輯頁三個身分欄位仍 `disabled`、無複製橫幅；一般新建（不帶 `?copyFrom=`）行為不變
- 全程 console 0 錯誤（僅 favicon 404 與預期的 409）

附帶觀察：跨公司複製會觸發 FIX-128 的「來源欄位未知」警告（來源欄位屬 CEVA 的 field definition set，換公司後對不上）。這是正確且有價值的行為 —— 兩道防護互補：本次加的管**目標**側，FIX-128 管**來源**側。

**rollback**：無 schema 變更、無 migration、無 feature flag；回退＝還原這批 commit。

---

## 向後兼容性

- 既有記錄的檢視、編輯、刪除行為**完全不變**（PATCH 契約與四欄 disabled 皆未動）
- 新增的 `copySource` prop 為選填；不帶 `?copyFrom=` 時 `new` 頁面行為與現況一致
- `TargetFieldSelector` 的改動只影響「值不在清單中」這一分支 —— 現有流程不會進入該分支（編輯時模版鎖死、新建時從空白開始），故對既有畫面無視覺變化
- `P2002` 判斷改動只影響錯誤路徑，成功路徑不變；改後原本可能回 500 的情境會正確回 409

---

## 驗收標準

| # | 驗收項目 | 驗收標準 | 優先級 |
|---|----------|----------|--------|
| 1 | 複製入口 | 列表每列有「複製」按鈕，點擊導向 `new?copyFrom=<id>` | High |
| 2 | 規則照抄 | 名稱＝原名＋後綴；說明／優先級／啟用照抄；N 條規則全數帶入（含 transformType 與 transformParams） | High |
| 3 | 身分欄位清空 | data template / scope / company / format 四欄皆為空 | High |
| 4 | 複製提示 | 模版未選時顯示「已從『X』複製 N 條規則」，而非看似空白的畫面 | High |
| 5 | 無效目標欄位標示 | 選定模版後，`targetField` 不屬於該模版者顯示無效標示（折疊與展開狀態一致） | High |
| 6 | 無效目標欄位擋存 | 存在無效 `targetField` 時無法儲存，toast 指出條數 | High |
| 7 | 儲存成功 | 四欄選妥後儲存成功，產生新記錄，**來源記錄內容不變** | High |
| 8 | 唯一衝突 | 四元組與既有記錄相同時回 **409** + toast 說明已存在（非 500 Unknown error） | High |
| 9 | 既有行為不變 | 既有記錄編輯頁四欄仍 disabled，PATCH 契約未變 | High |
| 10 | 品質閘 | `npm run i18n:check` / `npm run type-check` / `npm run lint` 通過（改動檔 0 新增警告） | High |

### 驗收結果（2026-07-25 本地 Playwright 實測）

- [x] 1 —— 4 列皆有複製按鈕，導向 `new?copyFrom=<id>`，頁面標題切換為「複製映射配置」
- [x] 2 —— `…v1（複製）`；5 條規則全帶入，含 rule 2 的「公式計算」transformType
- [x] 3 —— 模版與範圍皆顯示 placeholder；公司／格式依範圍條件顯示且為空。**Radix Select 收到 `defaultValue=""` 正常顯示 placeholder，無錯誤**
- [x] 4 —— 橫幅正確帶出來源名稱與 5 條；同時規則卡顯示「請先選擇數據模版」，證實橫幅正是避免誤判「複製失敗」的關鍵
- [x] 5 —— 改選 `ERP 標準匯入格式` 後 5 條全標示（1 展開 + 4 折疊）；改回原模版後標示歸零
- [x] 6 —— toast「5 條規則的目標欄位不屬於所選模版，請修正後再儲存」，`type=error`，未提交
- [x] 7 —— 建立成功，列表 4→5 筆，來源 CEVA 記錄完全未變
- [x] 8 —— **修正前回 201（建出重複）**；加應用層重複檢查後回 **409** + toast 指出撞到哪一筆
- [x] 9 —— 編輯頁三個身分欄位 `disabled: true`、無複製橫幅、規則層照常可編輯
- [x] 10 —— 三閘全綠；`lint` exit 0、0 錯誤、改動檔 0 新增警告

驗證期間建立的 2 筆測試配置已用 `scripts/local-cleanup-change107-test-records.ts` 硬刪除，本地資料庫回復為原始 4 筆。

**提報但未處理**（非本次改動造成，依 Karpathy 1.3／H3 只提不刪）：`MappingRuleItem.tsx` 有 4 個既有 dead import —— `Collapsible`／`CollapsibleContent`／`CollapsibleTrigger`（第 35-37 行）與 `TargetFieldDisplay`（第 41 行）。

### 驗收結果（2026-07-27 Azure DEV 實機驗證）

映像 `dev-change107-fix133-20260727115120`（對應 `origin/main` @ `fe69379`）部署後以 Playwright 實測。完整部署過程見 [部署記錄](../../../docs/07-deployment/02-azure-deployment/deployment-records/2026-07-27-dev-change107-fix133.md)。

| 驗收項 | 實測 |
|---|---|
| 1 列表出現「複製」動作 | ✅ 每列動作由部署前的「編輯」「刪除」變為「編輯」「**複製**」「刪除」（共 36 個配置） |
| 2 導向與規則預填 | ✅ → `/new?copyFrom=cmrwu7bqb001101miqgc5e989`、標題「複製映射配置」；提示「已複製 **10 條規則**」與列表「規則數 10」一致 |
| 3 四個身分欄位清空 | ✅ 數據模版「選擇數據模版」、範圍「選擇範圍」→ 強制重選 |
| 4 橫幅提示（防護 2） | ✅ 橫幅帶出來源名稱與條數；規則區同時顯示「請先選擇數據模版」 |
| 名稱後綴 | ✅ `…（複製）` |
| 說明／優先級／啟用狀態沿用 | ✅ 優先級 `0`、啟用開關已勾 |
| i18n | ✅ 全繁體中文、無缺 key、無 raw key 外露 |

> **未涵蓋**：驗收項 5-8（改選模版後的無效欄位標示、儲存前擋下、實際建立、409 重複擋阻）—— 這些需要**寫入資料**或多次改選，為避免在使用者測試環境產生資料而未執行。本地已於 2026-07-25 全數驗證通過（見上一節），Azure 端留給實際使用時自然驗證。

---

## 測試場景

| # | 場景 | 測試步驟 | 預期結果 |
|---|------|----------|----------|
| 1 | 同公司換模版 | 複製 CEVA 的 COMPANY 範圍配置 → 選另一份 data template → 範圍 COMPANY → 同一間公司 → 儲存 | 建立成功；規則照抄；`targetField` 若在新模版不存在則先被標示並擋存 |
| 2 | 換公司同模版 | 複製 CEVA 配置 → 保持同一份 data template → 範圍 COMPANY → 換另一間公司 → 儲存 | 建立成功；規則完全照抄；無效欄位標示不應出現（同模版） |
| 3 | 同公司換格式 | 複製配置 → 選 data template → 範圍 FORMAT → 選該公司的另一個文件格式 → 儲存 | 建立成功；FORMAT 範圍生效 |
| 4 | 撞重複（負向） | 複製配置 → 四欄選成與來源記錄完全相同 → 儲存 | 回 409，toast 顯示「相同範圍和關聯的映射配置已存在：「<名稱>」」，**不是** 500，也**不是**無聲建出重複。攔阻來自**應用層檢查**而非 DB 約束（後者因 NULL 語意不生效） |
| 5 | 無效目標欄位（負向） | 複製配置 → 選一份欄位定義不同的 data template → 直接儲存 | 擋下儲存；toast 指出無效條數；對應規則有無效標示 |
| 6 | 未選模版直接儲存（負向） | 複製配置 → 不選任何身分欄位 → 儲存 | Zod 擋下（`dataTemplateId` 必填、範圍需對應 company／format） |
| 7 | 既有編輯不受影響（回歸） | 開啟任一既有記錄的編輯頁 | 四個身分欄位仍為 disabled；儲存規則變更正常 |
| 8 | 一般新建不受影響（回歸） | 直接進 `new`（不帶 `?copyFrom=`） | 行為與現況完全一致，無複製提示 |

---

## 相關文件

- [CHANGE-101](CHANGE-101-batch-template-field-mappings-from-excel.md) —— 從 SCM Excel 批量建立 mapping（18 筆／139 條規則），本 CHANGE 的動機來源
- [FIX-128](../bug-fixes/FIX-128-mapping-source-field-validation.md) —— 來源 key 未知時的儲存警告機制（本次的目標欄位防護為其同型態問題的另一側）
- [CHANGE-075](CHANGE-075-mapping-rule-reorder-buttons-and-dnd.md) —— 映射規則排序（`order` 重編索引的正確性要求，複製時需保留）
- [CHANGE-045](CHANGE-045-field-definition-type-and-dynamic-line-items.md) —— `resolveByContext` 的 FieldDefinitionSet 解析上下文（複製後範圍變更會改變可用來源欄位集合）
