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

### 層面 A：設定缺口

三層預設模板全空。這**可能**只是設定沒做完 —— 但要判斷是「使用者沒設」還是「UI 上根本沒有設定入口 / 設了存不進去」，需要實際走一次 UI 確認（見§待確認）。

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

## 待確認（動手前必查）

| # | 事項 | 為何必須先查 |
|---|------|-------------|
| 1 | UI 上有無設定預設模板的入口，設了能否存進去 | 決定這是設定缺口還是功能缺陷 |
| 2 | 那 9 份是怎麼自動匹配成功的 | 若當時三層也是空的，代表還有別的路徑，本 FIX 的因果就不完整 |
| 3 | UI 上是否有其他手動觸發匹配的入口（文件列表批量匹配等） | 決定使用者現在有無 workaround |
| 4 | `/api/v1/documents/match`（batchMatch）走的是哪條路 | 它不經 `resolveDefaultTemplate`，可能是現行實際在用的入口 |

第 2 項尤其重要 —— 現有證據只證明「三層現在是空的」，不證明「一直是空的」。若那 9 份是設定過的期間跑成功的，則本缺陷的描述要改為「設定被清掉後無人察覺」，那會更凸顯層面 B。

---

## 修法選項（待拍板）

### 層面 B（失敗無聲）—— 建議先修這個

| 選項 | 作法 | 影響 |
|---|---|---|
| **B1** | 呼叫端檢查 `autoMatch` 回傳值，失敗時 `logger.warn` 並記錄 documentId + error | 最小改動，讓問題說出名字。不改變任何行為 |
| B2 | 在 `document` 或處理階段記錄「未匹配原因」，UI 可見 | 使用者能自己看到，但需要 schema 或 UI 變更 |
| B3 | `autoMatch` 改為 throw | 會讓上傳流程的錯誤處理路徑改變，風險較高 |

**建議 B1**：本專案已有「靜默失效先讓它說出名字再修」的判準。先加日誌，重新上傳一份即可確認因果，再決定要不要做 B2。

### 層面 A（三層皆空）

| 選項 | 作法 | 風險 |
|---|---|---|
| **A1** | 為每家公司設 COMPANY 級預設模板 | 需要知道每家該用 Inbound 還是 Outbound —— **同一家公司兩個方向都有**，COMPANY 級單一值無法表達 |
| A2 | 為每個格式設 FORMAT 級預設模板 | 同樣問題：目前每家只有 1 個格式（DHL 3 個），格式沒有區分進出口 |
| A3 | 設 GLOBAL 級預設模板 | 全部文件套同一個模板，進出口會混在一起 |
| A4 | 不設，維持手動匹配 | 需確認 UI 上手動入口是否可用（待確認 §3） |

🔴 **A1–A3 都有同一個結構問題**：預設模板的三層是 FORMAT / COMPANY / GLOBAL，**沒有「方向」這一維**。而 Inbound / Outbound 是兩個不同的模板。除非文件格式本身按進出口拆開（目前沒有），否則自動匹配無法選對模板。

這可能才是三層皆空的真正原因 —— **不是沒人去設，是設不出正確答案**。需要先確認此推論（待確認 §1、§2），再決定是補設定還是要擴充解析維度（後者屬架構變更，觸發 H1）。

---

## 驗證方式

修正後：

1. 上傳 1 份已知公司的文件，確認 `document.template_instance_id` 非空
2. 確認選中的模板方向正確（Inbound 文件不可配到 Outbound 模板）
3. 失敗案例要能在日誌中找到具體原因與 documentId

⚠️ 不可只看「有沒有進 instance」——**進錯模板比沒進更難發現**。

---

**建立者**: AI 助手
**最後更新**: 2026-08-05
