# FIX-165: 自動模板匹配從未運作 —— 三層預設模板全空，且失敗完全無聲

> **建立日期**: 2026-08-05
> **發現方式**: 使用者質疑「你是否真的像人一樣在平台上傳文件觸發處理流程」，追查後發現先前的驗證走的是手動 API，掩蓋了自動路徑從未運作
> **影響範圍**: `auto-template-matching.service.ts` → `autoMatch` / `resolveDefaultTemplate`；呼叫端 `documents/upload/route.ts:434`、`document.service.ts:637`、`documents/[id]/process/route.ts:187`
> **優先級**: 高（提取正常完成，但文件不會進任何模板實例，且無任何錯誤提示）
> **狀態**: 📋 規劃中（2026-08-05 第二次修訂：**初版的統計數字全部作廢**，改以代碼演繹論證，見 §實測資料）
> **相關**: [CHANGE-037](../feature-changes/CHANGE-037-data-template-flow-completion.md)（建立三層預設模板解析）、[FIX-038](FIX-038-template-matching-formatid-autocomplete.md)（formatId 傳遞修正）、[TEST-REPORT-006](../../5-status/testing/reports/TEST-REPORT-006-full-sample-coverage-verification.md)

---

## 問題描述

上傳文件並完成提取後，系統**應該**自動把文件匹配到模板實例。`upload/route.ts` 第 434 行：

```ts
// 處理成功且已識別公司時觸發自動匹配
if (result.success && result.companyId) {
  await autoTemplateMatchingService.autoMatch(doc.id)
}
```

前置開關 `ENABLE_UNIFIED_PROCESSOR` 實測為 `"true"`，所以這行**對每一份上傳的文件都執行了**。

但 `autoMatch` 在第 2 步就退出：

```ts
const resolved = await this.resolveDefaultTemplate(document.companyId, formatId);
if (!resolved) {
  return { success: false, error: '沒有配置預設模版' };
}
```

`resolveDefaultTemplate` 依 FORMAT → COMPANY → GLOBAL 三層找預設模板。實測**三層全空**。

---

## 實測資料（2026-08-05，本機；第二次修訂）

### 🔴 初版的判準是錯的，整組統計數字作廢

初版寫：

> `autoMatch` 成功時會寫 `document.template_instance_id` + `template_matched_at`（第 5 步）。
> 手動走 `/api/v1/template-matching/execute` **不寫這兩個欄位**。據此可精確區分兩條路徑。

**這個判準有三重錯誤**，據此得出的「自動匹配成功 9 份 / 未匹配 280 份 / 樣本 375 份 / 覆蓋率 2.4%」**全部作廢**：

| # | 錯誤 | 依據 |
|---|---|---|
| 1 | **手動路徑同樣寫這兩個欄位** | `auto-template-matching.service.ts` 有 **3 個**寫入點：`autoMatch`（385 行）、`matchSingle`（452 行）、`batchMatch`（539 行）。判準只排除了 `template-matching/execute`，**沒有排除 `documents/match`（batchMatch）** —— 而初版 §手動 workaround 一節自己就記錄了該路徑「執行後確實寫入 `template_instance_id`」，**前後自相矛盾而未被發現** |
| 2 | **樣本界定未記錄** | 初版稱「375 份樣本」，但未說明如何界定。現況 `Document` 總數為 **645**，無從重現當時的篩選條件 |
| 3 | **兩個欄位並不同步** | 實測 `templateInstanceId` 非空 **20** 份，`templateMatchedAt` 非空 **53** 份 —— **33 份不一致**（詳見下方訊號） |

### ✅ 核心結論不需要統計數字 —— 它可以由代碼演繹

自動匹配成功數必然為 **0**，證明如下（三項全部為 2026-08-05 直接查證）：

| 前提 | 實測 |
|---|---|
| `resolveDefaultTemplate` 依 FORMAT → COMPANY → GLOBAL 三層解析，全部落空則回傳 `null` | 代碼 `auto-template-matching.service.ts:172-227` |
| FORMAT 層：`DocumentFormat.defaultTemplateId` | 26 筆，**0 筆有值** |
| COMPANY 層：`Company.defaultTemplateId` | 54 筆，**0 筆有值** |
| GLOBAL 層：`SystemConfig` 的全域預設 | key 含 `template` 者共 **0 筆** |
| 三層皆無**任何寫入路徑**（故不可能被設起來） | 全 `src/` 搜尋 `defaultTemplate`（含 Prisma relation 寫法）：只有 `include` / `select` 讀取、API 回應欄位、UI 顯示，**0 處寫入**；`setGlobalDefaultTemplate` **0 個呼叫者** |

∴ `resolveDefaultTemplate` 對任何文件必然回傳 `null` → `autoMatch` 必然在第 2 步 `return { success: false, error: '沒有配置預設模版' }`。

**這比初版的統計結論更強**：不是「覆蓋率 2.4%」，而是 **0%**。既有的 20 份已匹配文件**全部**來自手動路徑。

（對照：`data_templates` 有 8 個可用模板，含 `Logistics Cost - Inbound / Outbound Template (Full List)`，只是沒有任何一層指向它們。）

### 現況數字（僅供規模參考，不作為缺陷判準）

| 項目 | 份數 |
|---|---:|
| `Document` 總數 | 645 |
| 　有 `companyId` | 514 |
| 　有 `templateInstanceId` | **20** |
| 　🔴 有 `companyId` 但無 `templateInstanceId` | **494** |
| `extraction_result` 筆數（相異 document） | 623 |
| `template_instance` 總數 | 152 |

依 `status` 分佈：`MAPPING_COMPLETED` 510、`REF_MATCH_FAILED` 108、`OCR_PROCESSING` 13、`OCR_FAILED` 8、`UPLOADED` 6。

### 🔴 附帶發現：`templateInstanceId` 與 `templateMatchedAt` 不同步（33 份）

有 `templateMatchedAt` 卻無 `templateInstanceId` 的文件共 **33 份**，最早可追到 2026-06-02。樣本：

```
2026-06-02T11:11:41  Fairate_HEX260200_03186_signed.pdf   （同檔名 3 份）
2026-06-26T09:22:02  CEVA_CEX250440_52240.pdf
2026-06-26T09:22:02  CEVA LOGISTICS_CEX240464_39613.pdf
```

最可能的成因是 **template instance 被刪除時 `templateInstanceId` 被設為 null，而 `templateMatchedAt` 留著**（未查證 schema 的 `onDelete` 行為，屬推論）。

無論成因為何，後果是確定的：**「哪些文件曾經匹配過」已無法從這兩個欄位還原**。這既是初版判準失效的第三重原因，也意味著任何依賴這兩欄做歷史統計的分析都不可靠。

⚠️ 這是本次查證才發現的訊號，先前完全未注意到。是否另立 FIX 待定 —— 需先查明 `onDelete` 行為再判斷是缺陷還是預期行為。

---

## 🔴 兩個層面的缺陷

### 層面 A：三層預設模板**沒有任何寫入路徑**（2026-08-05 走 UI 查證後改寫）

初版寫的是「設定缺口，可能只是沒設完」。實際走過 UI 後確認**不是設定問題，是功能缺陷**：

| 層級 | 欄位／方法 | 設定入口 |
|---|---|---|
| FORMAT | `DocumentFormat.defaultTemplateId` | 🔴 無 UI、無 API |
| COMPANY | `Company.defaultTemplateId` | 🔴 無 UI、無 API |
| GLOBAL | `autoTemplateMatchingService.setGlobalDefaultTemplate()` | 🔴 service 有方法，**零呼叫者** |

查證依據：

- `DefaultTemplateSelector.tsx` 組件**存在**且在 `features/template-match/index.ts` 匯出，但 `src/app/` 下**沒有任何頁面 import 它** —— 組件寫好了，從未掛上任何頁面
- 全 `src/` 搜尋 `defaultTemplateId`，只出現在 `auto-template-matching.service.ts` 的註解與 `check-config` API 的**回應欄位**；**沒有任何寫入路徑**
- 全 `src/` 搜尋 `setGlobalDefaultTemplate`，只有 service 內的定義，無任何呼叫端
- UI 實測：Data Templates 頁面每張卡片的 ⋯ 選單只有 **Edit / Delete**，沒有「設為預設」

**因此 `resolveDefaultTemplate` 的三層對任何文件都必然回傳 `null`** —— autoMatch 的前提在現行程式碼下**無法被滿足**。這不是「沒人去設」，是**設不了**。

> 這也回答了初版列的待確認 §1。至於「同一家公司 Inbound / Outbound 兩個方向、而三層沒有方向維度」的推論仍然成立，且因為連寫入路徑都沒有，該推論目前無法用實測驗證。

### 層面 B：失敗在**主要路徑**上無聲（本 FIX 的核心）

`autoMatch` 失敗時**回傳物件、不 throw**：

```ts
return { success: false, error: '沒有配置預設模版' };
```

🔴 **初版寫「失敗完全無聲」，定性過強**。2026-08-05 逐一讀完三個呼叫端後修正如下：

| 呼叫端 | 觸發時機 | 是否記錄失敗 |
|---|---|---|
| `documents/upload/route.ts:435` | **使用者上傳**（主要路徑） | 🔴 **否** —— `await autoMatch(doc.id)` 回傳值直接丟棄 |
| `document.service.ts:638` | 重試處理 | 🔴 **否** —— `.catch()` 只接 rejection，接不到 `{success:false}` |
| `documents/[id]/process/route.ts:187-197` | 手動觸發處理 | ✅ **是** —— `.then()` 檢查 `matchResult.success`，`else` 分支寫 `console.log('[Process] Auto-match skipped for ${id}: ${error}')` |

第三個呼叫端**已經做對了**，初版漏看。這反而強化了修法建議：**B1 不是要發明新機制，是把 `process` 路徑既有的寫法補到另外兩處**。

至於 upload 路徑，外層只有 `runInBatches(...).catch()`，而 `autoMatch` 不 throw，所以那個 catch 永遠不會觸發。

**結果：透過上傳進來的文件靜默地沒有進模板，資料庫與 UI 沒有任何痕跡。** 這個狀態可以無限期存在而無人察覺 —— 而上傳正是使用者的主要入口，所以實務影響未因這項修正而減輕。

⚠️ 即使是 `process` 路徑，`console.log` 也只進伺服器日誌，**使用者在介面上仍然看不到**。三條路徑對使用者而言都是無聲的。

---

## 這個問題為什麼拖到現在才發現

[TEST-REPORT-006](../../5-status/testing/reports/TEST-REPORT-006-full-sample-coverage-verification.md) §1 記錄：

> 驗證開始前，進過 template instance：**4 份（1.1%）**

**那個數字本身就是本缺陷的徵狀**，當時被讀成「覆蓋率低，需要補」，於是用手動 API（`POST /api/v1/template-instances` + `POST /api/v1/template-matching/execute`，自行指定 `templateInstanceId` 與 `options.companyId`）建了 13 個實例、把覆蓋率做到 262 份。

手動路徑**繞過了** `resolveDefaultTemplate`，因此完全掩蓋了三層皆空這件事。TEST-REPORT-006 報告的 69.9%（後續重算為 75.2%）是**手動達成的**，不是系統自動達成的。

⚠️ **兩種「覆蓋率」的口徑不同，不可對照相減**：

| 口徑 | 資料來源 | 現況 |
|---|---|---|
| 進了模板**實例列** | `TemplateInstanceRow.sourceDocumentIds` | TEST-REPORT-006 記 262 份 |
| `Document` 上有**實例關聯** | `Document.templateInstanceId` | 20 份 |

差異來自 `POST /api/v1/template-matching/execute` **只建實例列、不回寫 `Document`**（這正是初版判準的立論基礎，也是它唯一成立的部分）。兩個數字並不矛盾，但**任何跨兩者的比較都是無效的**。

🔴 **判準**：把「系統沒做到的事」當成「我該幫它做的事」，會讓補位動作蓋掉缺陷本身。驗證覆蓋率時必須區分「系統自動達成」與「驗證者手動達成」，並以前者為準。

---

## UI 實測（2026-08-05，Playwright 走完整流程）

先前的驗證全程走 HTTP API，未經 UI。本節以 Playwright 實際登入、選城市、拖檔、上傳，重跑一次真實使用者流程。

### 端對端結果：缺陷在真實 UI 下完整重現

上傳 `CEVA LOGISTICS_RCEX240706_00543.pdf`（doc `ed4ee5f6-…`）：

| 項目 | 結果 |
|---|---|
| `status` | `MAPPING_COMPLETED` |
| 公司識別 | CEVA LOGISTICS (HONG KONG) LTD ✅ |
| Stage 1 / 2 / 3 | 全部有結果 |
| 平均信心度 | **98.6** → `AUTO_APPROVE` |
| 行項對帳 | ✅ 相符，差額 0 |
| **`template_instance_id`** | 🔴 **空** |

**提取一切正常、信心度 98.6、自動核准，文件仍然沒有進任何模板實例。**

### UI 上完全沒有任何線索

文件列表的欄位是：No. / Filename / Company / Status / Processing Path / Upload Time / Processing Time / Confidence / Uploader / Actions。

**沒有模板匹配狀態欄。** 該列顯示的是綠色 `Mapping Completed`、`Auto Approve`、`High Confidence 99%` —— 使用者從畫面上完全看不出這份文件沒進模板。

> ⚠️ 注意 `MAPPING_COMPLETED` 指的是**欄位映射**完成，不是模板匹配完成。這個命名本身容易讓人誤判。
> `MatchStatusBadge` 組件雖然被 `documents/page.tsx` import，但列表上並未呈現匹配狀態。

### 🔴 對照組：同一支管線裡，另一種失敗會說話

同時上傳了一份改名成 `uitest-ceva-00543.pdf` 的同一份 PDF（改名後檔名不含參考編號）：

```
status       = REF_MATCH_FAILED
errorMessage = REF_MATCH_ABORT: Reference number matching enabled but no matches
               found in filename "uitest-ceva-00543.pdf". Pipeline aborted.
```

UI 上顯示紅色 `Ref Match Failed` + `Processing Failed` + `Low Confidence 0%` + **Retry 按鈕**。

**同一支管線：參考編號失敗有 errorMessage、有紅字、有重試入口；autoMatch 失敗什麼都沒有。** 這個對照是層面 B 最直接的證據 —— 系統有能力把失敗說出來，只是這條路徑沒做。

### 手動 workaround：存在且可用（回答原待確認 §3、§4）

Documents 列表 → 勾選文件 → 底部浮出「Match to Template」→ 選 Template → 選 Instance → Match Documents。

實測 API 序列：

```
GET  /api/v1/data-templates/available
GET  /api/v1/template-instances?dataTemplateId=…&status=DRAFT    ← 只列 DRAFT
POST /api/v1/template-instances                       → 201
POST /api/v1/documents/match                          → 200
```

走的是 **`/api/v1/documents/match`（batchMatch）**，不經 `resolveDefaultTemplate`，執行後確實寫入 `template_instance_id`（實測 `cmsfhl95z008rx0xge301bcc3`，instance 名「Batch Match 2026-08-05」）。

因此原待確認 §2「已匹配的那些是怎麼成功的」有了確定答案：**全部是手動做的**（§實測資料 的演繹已排除自動路徑的可能）。

2026-08-05 查證這 20 份文件涉及的 13 個 template instance，名稱**全部呈現人手命名的形態**：

```
CHANGE-113 GROUP 驗證 DHL 28699          ← 驗證用
TOLL inbound instance test 20260803 1055am   ← 含 "test" + 人工時間戳
RIL_RCIM test instance 20260803 1057am
nippon outbound instance 20260803 1212pm
NEX_RCIM250001_202.SIGNED..pdf - 20260802 - 6:42pm   ← 直接用檔名
CEVA_RCIM250325_17865
Batch Match 2026-08-05                    ← 本次 UI 實測產生
```

`autoMatch` 走的是 `getOrCreateInstance(resolved.templateId)`，不會產生「test」、「1055am」、「驗證」這類名稱。**命名形態與演繹結論一致**。

三點使用性問題：

1. `Select Instance` 只列 `status=DRAFT` 的實例 —— 既有 151 個多為 COMPLETED，所以下拉常常只剩「+ Create New Instance」
2. 使用者必須**自己判斷** Inbound / Outbound，選錯不會有任何警告
3. 列表沒有匹配狀態欄，使用者無從得知**哪些還沒匹配**，只能逐份點進詳情

### 附帶發現

- **`/api/v1/documents/match` 的回應已含 `unresolvedSourceKeys` 診斷**，逐一列出「mapping 引用了但這份文件沒取到值的來源 key」。這正是 [FIX-161](FIX-161-mapping-references-undefined-company-fields.md) 調查時自行重建的資訊 —— 系統本來就有，先前未加利用
- `ocr_results.extracted_text` 對本次上傳仍為空，再次確認 V3.1 管線不寫該表
- 上傳頁面**強制先選城市**才能拖檔；API 回應的 `processingVersion` 為 `"auto"`（UI 未傳此參數，走 API 預設）

---

## 修法選項（待拍板）

### 層面 B（失敗無聲）—— 建議先修這個

| 選項 | 作法 | 影響 |
|---|---|---|
| **B1** | 把 `process/route.ts:188-197` **既有的**寫法（檢查 `matchResult.success`，失敗時記錄 documentId + error）補到 `upload/route.ts:435` 與 `document.service.ts:638` | 最小改動，讓問題說出名字。不改變任何行為。**有現成範本可抄，不需設計新機制** |
| B2 | 在 `document` 或處理階段記錄「未匹配原因」，UI 可見 | 使用者能自己看到，但需要 schema 或 UI 變更 |
| B3 | `autoMatch` 改為 throw | 會讓上傳流程的錯誤處理路徑改變，風險較高 |

**建議 B1**：本專案已有「靜默失效先讓它說出名字再修」的判準。先加日誌，重新上傳一份即可確認因果，再決定要不要做 B2。

⚠️ B1 只讓失敗進入**伺服器日誌**，使用者在介面上仍看不到。要讓使用者看見必須做 B2 或 A0 補強項 1（列表加匹配狀態欄）。

### 層面 A（三層無寫入路徑）

UI 實測後，原本的 A1–A3 都不再是「去設定一下」就能做的 —— **三層都沒有寫入路徑，任何一個都得先補介面**。

| 選項 | 作法 | 前置工作 | 風險 |
|---|---|---|---|
| **A0** | **不做自動匹配，正式承認手動為現行流程** | 無 | 需補列表的匹配狀態欄，否則使用者看不出哪些沒匹配（見下方 A0 補強） |
| A1 | 補 COMPANY 級設定 UI（公司編輯頁加欄位） | 新 UI + API | **同一家公司 Inbound / Outbound 都有，COMPANY 級單一值無法表達方向** |
| A2 | 補 FORMAT 級設定 UI | 新 UI + API | 同樣無方向維度；且目前每家多半只有 1 個格式 |
| A3 | 掛上既有的 `DefaultTemplateSelector` 做 GLOBAL 級 | 掛組件 + 開 API | 全部文件套同一模板，進出口混在一起 |
| A4 | 為預設模板解析加入「方向」維度 | 架構變更 | **觸發 H1，需 approval** |

🔴 **A1–A3 共同的結構問題仍然成立**：預設模板的三層是 FORMAT / COMPANY / GLOBAL，**沒有「方向」這一維**，而 Inbound / Outbound 是兩個不同模板。除非文件格式按進出口拆開（目前沒有），否則自動匹配**選不對模板**。

在此前提下，**A0 是成本最低且不會選錯的選項**：既然手動流程已可用且會正確寫入 `template_instance_id`，先把它變成「看得見、可管理」的正式流程，比匆促補一個必然選錯方向的自動匹配更安全。

#### A0 補強項（若採此選項）

| # | 項目 | 理由 |
|---|---|---|
| 1 | 文件列表加「模板匹配狀態」欄 | 目前使用者完全看不出哪些沒匹配 —— 這是本缺陷能潛伏至今的直接原因 |
| 2 | 篩選器加「未匹配」條件 | 讓使用者能一次撈出待處理的 |
| 3 | `Select Instance` 放寬 `status=DRAFT` 限制或提供搜尋 | 目前既有實例幾乎都選不到 |
| 4 | 仍要做 B1（記錄 autoMatch 失敗） | 否則哪天有人設了預設模板卻失敗，仍然無聲 |

---

## 驗證方式

修正後：

1. 上傳 1 份已知公司的文件，確認 `document.template_instance_id` 非空
2. 確認選中的模板方向正確（Inbound 文件不可配到 Outbound 模板）
3. 失敗案例要能在日誌中找到具體原因與 documentId

⚠️ 不可只看「有沒有進 instance」——**進錯模板比沒進更難發現**。

🔴 **不可用 `templateInstanceId` / `templateMatchedAt` 的計數作為驗收指標**。理由見 §實測資料：
- 兩個欄位在既有資料中已不同步（33 份）
- 手動與自動路徑寫入同樣的欄位，計數無法區分二者

驗收必須改用**可歸因的訊號**：例如在 `autoMatch` 的成功路徑寫入一個可辨識的來源標記，或直接以日誌中的 `[Process] Auto-match success` 計數。**這是初版最大的方法錯誤，不可重蹈。**

---

## 本次 UI 實測產生的資料（需清理）

| 項目 | ID / 名稱 | 說明 |
|---|---|---|
| document | `7210448b-b557-42a8-935f-f94637bc988e` | `uitest-ceva-00543.pdf`，刻意改名以致 `REF_MATCH_FAILED`，作為對照組 |
| document | `ed4ee5f6-d537-4204-9188-8a35fbe03427` | `CEVA LOGISTICS_RCEX240706_00543.pdf`，正常完成 |
| template instance | `cmsfhl95z008rx0xge301bcc3` | 「Batch Match 2026-08-05」，手動匹配時建立，含 1 列 |

三者皆為驗證產物，確認結論後可刪。刪除屬不可逆資料操作，需走三段式 gated 腳本。

---

**建立者**: AI 助手
**最後更新**: 2026-08-05（第二次修訂：判準失效、統計數字作廢、改採代碼演繹；修正「完全無聲」定性；新增欄位不同步訊號）
