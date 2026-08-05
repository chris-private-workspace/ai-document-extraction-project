# FIX-165: 自動模板匹配從未運作 —— 三層預設模板全空，且失敗完全無聲

> **建立日期**: 2026-08-05
> **發現方式**: 使用者質疑「你是否真的像人一樣在平台上傳文件觸發處理流程」，追查後發現先前的驗證走的是手動 API，掩蓋了自動路徑從未運作
> **影響範圍**: `auto-template-matching.service.ts` → `autoMatch` / `resolveDefaultTemplate`；呼叫端 `documents/upload/route.ts:434`、`document.service.ts:637`、`documents/[id]/process/route.ts:187`
> **優先級**: 高（提取正常完成，但文件不會進任何模板實例，且無任何錯誤提示）
> **狀態**: 📋 規劃中
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

## 實測資料（2026-08-05，本機）

### 判準

`autoMatch` 成功時會寫 `document.template_instance_id` + `template_matched_at`（第 5 步）。
手動走 `/api/v1/template-matching/execute` **不寫這兩個欄位**。據此可精確區分兩條路徑。

### 375 份樣本的自動匹配結果

| 結果 | 份數 |
|---|---:|
| ✅ 自動匹配成功 | **9** |
| 🔴 有提取結果 + 有 companyId，卻未自動匹配 | **280** |
| 無提取結果（管線更早中止） | 62 |

**自動覆蓋率 9 / 375 = 2.4%**。

未自動匹配的 280 份分佈於全部 7 家有文件的公司，無一例外：

| 公司 | 份數 |
|---|---:|
| Nippon Express Logistics | 59 |
| CEVA LOGISTICS (HONG KONG) LTD | 52 |
| RICOH INTERNATIONAL LOGISTICS (HK) LTD. | 51 |
| Toll Global Forwarder Limited | 38 |
| Nippon Express (HK) Co., Ltd. | 30 |
| DHL Express | 25 |
| Toll Global Forwarding (Hong Kong) Ltd | 25 |

### 三層預設模板配置

| 公司 | 文件 | COMPANY 級 | FORMAT 級 |
|---|---:|---|---|
| CEVA LOGISTICS (HONG KONG) LTD | 141 | 🔴 未設 | 0/2 |
| Nippon Express Logistics | 118 | 🔴 未設 | 0/1 |
| Nippon Express (HK) Co., Ltd. | 66 | 🔴 未設 | 0/1 |
| RICOH INTERNATIONAL LOGISTICS (HK) LTD. | 54 | 🔴 未設 | 0/1 |
| Toll Global Forwarder Limited | 51 | 🔴 未設 | 0/1 |
| DHL Express | 42 | 🔴 未設 | 0/3 |
| Toll Global Forwarding (Hong Kong) Ltd | 28 | 🔴 未設 | 0/1 |
| Fairate Express | 11 | 🔴 未設 | 0/1 |
| UNIT INTERNATIONAL LOGISTICS (HK) LTD. | 1 | 🔴 未設 | 0/1 |
| CARGO LINK LOGISTICS HK COMPANY LIMITED | 1 | 🔴 未設 | 0/1 |

**10 家公司、11 個格式，`default_template_id` 全部為空。**

GLOBAL 層讀 `SystemConfig` 的 `global_default_template_id`：

```
SystemConfig 沒有這一筆
key 含 "template" 的 SystemConfig 共 0 筆
```

而 `data_templates` 有 8 個可用模板（含 `Logistics Cost - Inbound / Outbound Template (Full List)`），只是沒有任何一層指向它們。

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

### 層面 B：失敗完全無聲（本 FIX 的核心）

`autoMatch` 失敗時**回傳物件、不 throw**：

```ts
return { success: false, error: '沒有配置預設模版' };
```

而呼叫端不檢查回傳值：

```ts
if (result.success && result.companyId) {
  await autoTemplateMatchingService.autoMatch(doc.id)   // ← 回傳值被丟棄
}
```

外層只有 `runInBatches(...).catch()`，而 `autoMatch` 不 throw，所以那個 catch 永遠不會觸發。

**結果：280 份文件靜默地沒有進模板，資料庫、日誌、UI 都沒有任何痕跡。** 這個狀態可以無限期存在而無人察覺。

`document.service.ts:637` 的重試路徑同樣如此（`.catch()` 只接 rejection，接不到 `{success:false}`）。

---

## 這個問題為什麼拖到現在才發現

[TEST-REPORT-006](../../5-status/testing/reports/TEST-REPORT-006-full-sample-coverage-verification.md) §1 記錄：

> 驗證開始前，進過 template instance：**4 份（1.1%）**

**那個數字本身就是本缺陷的徵狀**，當時被讀成「覆蓋率低，需要補」，於是用手動 API（`POST /api/v1/template-instances` + `POST /api/v1/template-matching/execute`，自行指定 `templateInstanceId` 與 `options.companyId`）建了 13 個實例、把覆蓋率做到 262 份。

手動路徑**繞過了** `resolveDefaultTemplate`，因此完全掩蓋了三層皆空這件事。TEST-REPORT-006 報告的 69.9%（後續重算為 75.2%）是**手動達成的**，不是系統自動達成的。

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

因此原待確認 §2「那 9 份是怎麼成功的」有了合理解釋：**很可能就是有人用這個手動流程做的**。既有 138 個非驗證用 instance 中，`CEVA_RCIM250325_17865`、`nippon outbound instance 20260803 1212pm` 等命名也支持這個推論（仍非直接證據）。

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
| **B1** | 呼叫端檢查 `autoMatch` 回傳值，失敗時 `logger.warn` 並記錄 documentId + error | 最小改動，讓問題說出名字。不改變任何行為 |
| B2 | 在 `document` 或處理階段記錄「未匹配原因」，UI 可見 | 使用者能自己看到，但需要 schema 或 UI 變更 |
| B3 | `autoMatch` 改為 throw | 會讓上傳流程的錯誤處理路徑改變，風險較高 |

**建議 B1**：本專案已有「靜默失效先讓它說出名字再修」的判準。先加日誌，重新上傳一份即可確認因果，再決定要不要做 B2。

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
**最後更新**: 2026-08-05
