# FIX-129: 公司合併因唯一鍵衝突跳過的設定成為孤兒，無可見性也無處理路徑

> **建立日期**: 2026-07-22
> **發現方式**: 盤點 Azure DEV 公司記錄時發現已 MERGED 的公司仍持有欄位定義集與模板映射
> **影響頁面/功能**: 公司合併（`mergeCompanies` / `confirmCompanyMerge`）→ 公司處理知識關聯
> **優先級**: 中（不影響現有文件處理，但設定會逐步流失且無人察覺）
> **狀態**: ✅ 已完成（2026-07-22，方案 A 合併結果回報 + CEVA 時間點查證；存量清理［方案 C］由 FIX-130 承接；Azure 實機驗證於下次部署批次執行）

---

## 問題描述

[FIX-125](FIX-125-company-merge-orphans-document-formats.md) 已讓合併一併轉移「公司處理知識」類關聯（格式 / 欄位定義集 / 模板映射 / Prompt / 管線配置 / 欄位映射配置）。但該實作採**唯一鍵守門**：逐筆檢查目標公司是否已存在相同鍵，**撞鍵則跳過並記錄**（絕不猜測改值，與 FIX-120 / FIX-124 的處置原則一致）。

這個保守設計本身是對的 —— 猜測改值會製造更難查的錯誤。問題在於**跳過之後沒有下文**：

- `MergeTransferReport.skipped` 的註解明寫「需人工處理」，但目前只寫進 log
- 介面上看不到「這次合併有 N 筆設定沒轉過去」
- 沒有任何頁面能列出「掛在已 MERGED 公司底下的設定」
- 沒有工具讓人決定這些孤兒該合併、取代還是捨棄

結果：設定靜靜留在一個已停用的公司底下，等同遺失。

---

## 重現步驟

1. 公司 A（來源）與公司 B（目標）各自有一組 `INVOICE/GENERAL` 的 DocumentFormat。
2. 將 A 合併到 B。
3. A 的格式因唯一鍵 `(companyId, documentType, documentSubtype)` 撞鍵而被跳過；依附該格式的 FORMAT scope 配置一併跳過。
4. A 的狀態變為 `MERGED`、文件數歸零，**但仍持有那些設定**。
5. 介面上沒有任何地方顯示這件事。

---

## 根本原因

`company-merge-transfer.service.ts` 的守門邏輯（設計如此，非缺陷）：

```ts
// 1. documentFormats —— 唯一鍵 (companyId, documentType, documentSubtype)
//    三個欄位皆 non-null，同 type/subtype 必然撞鍵。實測撞鍵率高
//    （本地 3 筆孤立格式全為 INVOICE/GENERAL，轉入同一目標時 2 筆會撞）。
if (clash) {
  skippedFormatIds.add(format.id)
  skipped.push({ relation: 'documentFormats', recordId: format.id, ... })
}
```

`documentSubtype` 在 JIT 建立路徑被寫死為 `GENERAL`（見 [FIX-124](FIX-124-jit-create-format-silent-arbitrary-reuse.md)），**所以同一公司的 JIT 格式必然共用同一個唯一鍵** —— 撞鍵不是偶發，是常態。

缺的是「跳過之後怎麼辦」的那一段。

### 實測證據（Azure DEV，2026-07-22）

CEVA 相關公司共 8 筆，其中 7 筆已 MERGED：

| 文件數 | 欄位集 | mapping | 格式 | 狀態 | 公司名稱 |
|---:|---:|---:|---:|---|---|
| 216 | 1 | 4 | 2 | ACTIVE | CEVA LOGISTICS (HONG KONG) LTD |
| 0 | **1** | **4** | **1** | **MERGED** | CEVA LOGISTICS (HONG KONG) LIMITED（CEVA Logistics） |
| 0 | 0 | 0 | 1 | MERGED | Ceva Logistics Hong Kong Office |
| 0 | 0 | 0 | 1 | MERGED | CEVA Logistics (Hong Kong) Office |
| 0 | 0 | 0 | 1 | MERGED | CEVA Logistics (RICHASIA) PACIFIC OPERATIONS LIMITED |
| 0 | 0 | 0 | 1 | MERGED | CEVA LOGISTICS (香港) KONG LITTD |
| 0 | 0 | 0 | 1 | MERGED | RICON ASIA PACIFIC OPERATIONS LIMITED（CEVA LOGISTICS） |
| 0 | 0 | 0 | 0 | MERGED | CEVA Logistics Hong Kong Limited |

第二列是典型孤兒：文件已全數轉走（0 份），卻還握著 1 個欄位定義集、4 組模板映射、1 個格式。

✅ **已查證（2026-07-22，Kudu 唯讀 q7.js）**：該筆孤兒（`CEVA LOGISTICS (HONG KONG) LIMITED（CEVA Logistics）`）的 `updated_at = 2026-07-16T03:08:13Z`，同批 5 筆 MERGED 全部同一時刻（一次批量合併），另 2 筆為 2026-06-28 —— **全部早於 FIX-125 部署（2026-07-21）**。結論：這批是「當時根本不轉移」的**存量**，不是唯一鍵跳過。存量清理由 [FIX-130](FIX-130-existing-config-correction-checklist.md) §4 承接。

同次查證的額外發現：`RICON ASIA PACIFIC OPERATIONS LIMITED`（無 CEVA 後綴那筆）仍為 **ACTIVE**、持有 3 份文件 + 1 個格式，不在原先 8 筆盤點表內 —— 疑似 CEVA 變體但未合併，已補記入 FIX-130 §4 待使用者決策。

---

## 解決方案

| 選項 | 方案 | 優點 | 代價 |
|------|------|------|------|
| **A** | **合併結果回報**：合併完成後於介面顯示 `skipped` 明細（哪一類、幾筆、為何跳過），並提供「稍後處理」的入口 | 在事發當下就讓人知道；資料 `MergeTransferReport` 已經有了，只差顯示 | 只涵蓋「未來的合併」，對存量孤兒無效 |
| **B** | **孤立設定盤點頁**：新增一個管理頁面，列出所有掛在 `MERGED`／零文件公司底下的設定，支援逐筆決定（轉移到指定公司／捨棄／保留） | 同時涵蓋存量與未來；不限於合併場景（`SBS` 那種「設定放在無文件公司」也抓得到） | 工作量最大；需要新 API + 新頁面 + i18n 三語言 |
| **C** | **一次性存量清理**：只寫 gated 腳本處理目前這批孤兒，不做介面 | 最快；立即解決眼前問題 | 治標；下次合併還會產生新孤兒 |
| **D** | **自動合併策略**：撞鍵時自動比對內容，相同則捨棄、不同則改名後轉移 | 全自動 | ❌ **不建議** —— 違反 FIX-120/124/125 確立的「絕不猜測」原則；設定內容的等價判斷沒有可靠依據 |

### 建議

**A + C 先做，B 視情況**：
- **C** 立即處理眼前 CEVA 這批（併入 [FIX-130](FIX-130-existing-config-correction-checklist.md) 的腳本）。
- **A** 成本低（資料已具備，只差顯示），能防止未來再次無聲累積。
- **B** 是完整解，但工作量大；若 A + C 之後孤兒產生率很低，可延後。
- **D 明確排除**，理由同 FIX-124 對方案 C 的排除理由 —— 猜測會污染資料。

---

## 實作記錄（2026-07-22，方案 A）

合併回應把 `MergeTransferReport` 帶到前端，兩個合併入口都會顯示跳過明細：

| 層 | 檔案 | 改動 |
|---|---|---|
| 服務 | `src/services/company-auto-create.service.ts` | `autoMergeCompanies` 回傳改為 `{ company, knowledgeTransfer }` |
| API | `src/app/api/admin/companies/merge/route.ts` | 回應附 `knowledgeTransfer`（confirm-merge route 原本就帶，不用改） |
| Hook | `src/hooks/use-pending-companies.ts` | `MergeCompaniesResponse` 型別附 `knowledgeTransfer` |
| Hook | `src/hooks/use-duplicate-review.ts` | `confirmCompanyMerge` 解析回應、回傳 `MergeTransferReport \| null` |
| 組件 | `src/components/features/companies/MergeSkippedReportAlert.tsx`（新建） | 琥珀色警示：逐筆列出 relation（i18n 翻譯）+ label + reason |
| 組件 | `src/components/features/companies/CompanyMergeDialog.tsx` | 合併成功且有跳過項 → 切換為結果視圖（明細 + 手動關閉），不自動關閉；結果用快照避免列表刷新清掉視圖 |
| 頁面 | `admin/companies/duplicate-review/duplicate-review-content.tsx` | 合併成功且有跳過項 → 頁面頂部顯示明細警示（可關閉）+ toast 警告 |
| i18n | `messages/{en,zh-TW,zh-CN}/companies.json` | 新增 `merge.skipped.*`（title / description / toast / resultTitle / relations.6 類） |

`skip.reason` 為服務層生成的中文說明（FIX-125 既有行為），直接顯示；relation 類別名經 i18n 翻譯（未知類別 fallback 原字串）。

**rollback**：無 schema 變更、無 flag；回退＝重部署舊映像。

---

## 驗收標準

- [x] 查證 CEVA 那筆孤兒的合併時間點，確認是「FIX-125 前的存量」還是「唯一鍵跳過」→ **存量**（合併於 2026-07-16，早於 FIX-125 部署 2026-07-21；見上方查證記錄）
- [x] 合併完成後，介面能看到本次跳過的筆數與原因（方案 A，兩個合併入口皆覆蓋）
- [ ] 存量孤兒（CEVA 1 欄位集 + 4 mapping + 1 格式）處理完畢，且處理方式經使用者逐筆確認 → **移交 [FIX-130](FIX-130-existing-config-correction-checklist.md) §4**（方案 C，需業務判斷）
- [x] 迴歸：合併本身的行為（文件 / 提取結果 / 規則轉移）不變（FIX-125 單元測試 6/6 通過）
- [x] 涉及 UI 字串 → 三語言同步 + `npm run i18n:check` 通過
- [x] `npm run type-check` / `npm run lint` 通過

---

## 相關文件

- [FIX-125](FIX-125-company-merge-orphans-document-formats.md) —— 轉移機制本體（本 FIX 補其「跳過後」的缺口）
- [FIX-124](FIX-124-jit-create-format-silent-arbitrary-reuse.md) —— `documentSubtype` 寫死 `GENERAL` 是撞鍵率高的成因
- [FIX-130](FIX-130-existing-config-correction-checklist.md) —— 存量孤兒清理
- [CHANGE-103] —— 公司重複的整體治理
