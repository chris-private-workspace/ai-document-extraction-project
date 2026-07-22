# FIX-131: 公司詳情頁缺合併入口 — 兩間 ACTIVE 公司無法透過 UI 合併

> **建立日期**: 2026-07-22
> **發現方式**: 用戶回報（FIX-130 §4 Nippon 收斂：頁面上找不到任何合併按鈕）
> **影響頁面/功能**: 公司詳情頁（/companies/[id]）、公司管理合併流程
> **優先級**: 中
> **狀態**: 🚧 進行中（代碼實作完成 2026-07-22；type-check / lint / i18n:check 通過；待瀏覽器/部署驗證）

---

## 問題描述

系統的公司合併能力只在 UI 上暴露給 **PENDING 狀態**的公司：

- `/admin/companies/review`（待審核公司）— 清單來自 `/api/admin/companies/pending`，只列 PENDING
- `/admin/companies/duplicate-review`（疑似重複審核）— 只列 PENDING 且有 suspectedDuplicateOf

一旦重複公司已被提升為 **ACTIVE**（JIT 建立後經審核或自動轉正），就從所有合併 UI 的清單中消失，導致**兩間 ACTIVE 重複公司無法透過任何頁面合併**。

合併能力本身沒有這個限制：`POST /api/admin/companies/merge` → `autoMergeCompanies` 對任意公司 ID 都可執行（無狀態前置條件），並已含 FIX-125 的唯一鍵安全知識轉移。**缺的純粹是 UI 入口**。

### 實際觸發案例
Nippon Express (HK) 有兩筆 ACTIVE 重複公司（`Nippon Express (HK) Co., Ltd.` 16 份文件 + `NIPPON EXPRESS (HK) CO., LTD.（NIPPON EXPRESS）` 1 份），需合併但頁面上無按鈕，只能靠瀏覽器 console 直接呼叫 API 暫時處理。

---

## 重現步驟

1. 進入任一 ACTIVE 公司詳情頁 `/companies/[id]`
2. 嘗試將它與另一間 ACTIVE 重複公司合併
3. 觀察現象：頁面無任何合併入口；兩個既有合併頁面也不列出 ACTIVE 公司

---

## 根本原因

合併 UI 的設計假設是「治理 JIT 新建的待審 PENDING 公司」，清單一律取自 PENDING 來源，未提供「對既有 ACTIVE 公司主動發起合併」的入口。CompanyMergeDialog 的輸入型別也綁死 `PendingCompany[]`，無法直接餵入任意兩間公司。

---

## 解決方案

在公司詳情頁補合併入口，全程複用既有 API / hook / 撞鍵報告組件，不動後端。

### 1. 公司搜尋選擇器
新增搜尋型 combobox，查 `/api/companies?search=&status=ACTIVE`，排除當前公司自己與已 MERGED 公司。

### 2. 詳情頁合併按鈕
在 `ForwarderDetailView` 操作區加「合併公司」按鈕，`canManage` gate（權限 `FORWARDER_MANAGE`，與合併 API 一致）。

### 3. 放寬 CompanyMergeDialog 輸入型別
將 `companies: PendingCompany[]` 放寬為通用最小型別 `{ id: string; name: string; documentCount: number }[]`，用「當前公司 + 選中公司」組成兩筆傳入；保留 RadioGroup 讓用戶選哪筆存活（預設當前公司為主）。沿用 `useMergeCompanies` + `MergeSkippedReportAlert`（FIX-129 撞鍵報告）。

### 4. i18n
`companies.json` 三語言（en / zh-TW / zh-CN）新增按鈕、選擇器、對話框相關 key，執行 `npm run i18n:check`。

---

## 修改的檔案

| 檔案 | 修改內容 |
|------|----------|
| `src/components/features/companies/MergeCompanyButton.tsx` | **新建**：合併按鈕 + 公司搜尋選擇器（Dialog + Input + ScrollArea，查 `status=ACTIVE`、排除當前公司）+ 串接 CompanyMergeDialog |
| `src/components/features/companies/CompanyMergeDialog.tsx` | 匯出並改用最小型別 `MergeableCompany = {id,name,documentCount?}`（取代綁死的 `PendingCompany[]`）；`documentCount` 顯示改為選填安全 |
| `src/components/features/companies/index.ts` | 匯出 `MergeCompanyButton` + `MergeableCompany` 型別 |
| `src/components/features/forwarders/ForwarderDetailView.tsx` | 加 `canManage` prop；操作區在 canManage 時渲染合併按鈕（當前公司文件數取 `stats.totalDocuments`） |
| `src/app/[locale]/(dashboard)/companies/[id]/page.tsx` | server component 以 `auth()` + `hasPermission(FORWARDER_MANAGE)` 計算 `canManage` 傳入 |
| `messages/{en,zh-TW,zh-CN}/companies.json` | `merge.fromDetail.*`（button / pickerTitle / pickerDescription / searchPlaceholder / searchHint / searching / noResults / loadError） |

> 無 schema 變更、無新 API、無新 npm 依賴、無 vendor 變更。沿用 `useMergeCompanies` + `autoMergeCompanies` + `MergeSkippedReportAlert`。

---

## 測試驗證

修復完成後需驗證：

- [x] `npm run type-check` 通過（2026-07-22）
- [x] `npm run lint` 無 warning（改動 5 檔，0 warning）
- [x] `npm run i18n:check` 三語言同步通過
- [x] 既有兩個 PENDING 合併頁面行為不受影響（`CompanyMergeDialog` 型別放寬後 `PendingCompany` 結構相容，type-check 通過即證回歸安全）
- [ ] ACTIVE 公司詳情頁出現「合併公司」按鈕（僅 canManage 時）— 待瀏覽器驗證
- [ ] 選擇器能搜尋 ACTIVE 公司且不含當前公司自己、不含 MERGED 公司 — 待瀏覽器驗證
- [ ] 合併後副公司轉 MERGED、文件/提取結果轉移到主公司 — 待瀏覽器/部署驗證
- [ ] 撞鍵情境（如 Nippon 兩筆的 INVOICE/GENERAL 格式）正確顯示 MergeSkippedReportAlert，不刪除格式 — 待瀏覽器/部署驗證

---

*文件建立日期: 2026-07-22*
*最後更新: 2026-07-22*
