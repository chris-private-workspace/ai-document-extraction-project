# FIX-112: 公司合併漏轉關聯資料（documents / extraction_results / rules 孤兒化）

> **日期**: 2026-07-16
> **狀態**: ✅ 已完成（程式碼；存量資料回填另議）
> **嚴重度**: Sev2（資料完整性 — 合併後副公司關聯資料孤兒化，COMPANY 級 template 映射失效）
> **類型**: Bug Fix（服務層 — 公司合併資料轉移缺口）
> **影響範圍**: `src/services/company-auto-create.service.ts`（`autoMergeCompanies`）、`src/services/company.service.ts`（`mergeCompanies`）
> **關聯**: [[CHANGE-103]] Phase 2（`confirmCompanyMerge` 已正確；本 FIX 補齊另兩條合併路徑）、FIX-105（CEVA 存量資料以一次性腳本補救）

---

## 問題描述

CHANGE-103 Phase 2 的 `confirmCompanyMerge`（PENDING 審核併入）已在單一 transaction 內正確轉移 documents + extraction_results + mapping_rules。但**手動合併的另兩條路徑仍有缺口**，合併後副公司的關聯資料被孤兒化，觸發已知根因（COMPANY 級 template 映射要求文件 / 提取結果的 `companyId` 與 mapping 的 `companyId` 完全相等，見 memory `company_dup_breaks_company_mapping`）。

## 根因分析（手動合併三條路徑盤點）

| 路徑 | 呼叫鏈 | FIX-112 前的轉移行為 |
|------|--------|----------------------|
| **Admin 合併 UI** | `useMergeCompanies` → `POST /api/admin/companies/merge` → **`autoMergeCompanies`** | ❌ **什麼都不轉**（只改 nameVariants + 設副公司 MERGED）——documents / extraction_results / mapping_rules 全部孤兒化 |
| 服務層 `mergeCompanies` | 目前**無呼叫者**（僅 JSDoc 提及；保留供程式化合併） | ⚠️ 轉 documents + mapping_rules，**漏 extraction_results** |
| PENDING 審核（CHANGE-103 P2） | `confirmCompanyMerge` | ✅ 三者全轉（已正確，非本 FIX 範圍） |

**關鍵矛盾**：實際被 admin 合併 UI 呼叫的是 `autoMergeCompanies`（缺口最嚴重，連 documents 都不轉），而非直覺以為的 `mergeCompanies`。`autoMergeCompanies` 的 JSDoc 原稱「用於 JIT 自動建立流程」，但實測全專案僅 admin 合併 route 呼叫它。

### 為何孤兒化會造成故障

副公司設為 MERGED 後，其 `companyId` 仍留在 documents / extraction_results 上。COMPANY 級 template field mapping（`resolveMapping`）要求文件的 `companyId` 與 mapping 的 `companyId` 完全相等；合併後文件仍指向已 MERGED 的副公司 → 找不到 canonical 主公司的 mapping → 「找不到映射配置（MAPPING_NOT_FOUND）」或費用欄位落空。

## 修正內容（使用者定案：兩者都修，只修程式碼）

### 1. `autoMergeCompanies`（實際 admin 路徑，company-auto-create.service.ts）

於 transaction 內、設副公司 MERGED **之前**，補齊三類關聯資料轉移（`companyId: { in: secondaryIds } → primaryId`）：

```typescript
await tx.document.updateMany({ where: { companyId: { in: secondaryIds } }, data: { companyId: primaryId } })
await tx.extractionResult.updateMany({ where: { companyId: { in: secondaryIds } }, data: { companyId: primaryId } })
await tx.mappingRule.updateMany({ where: { companyId: { in: secondaryIds } }, data: { companyId: primaryId } })
```

### 2. `mergeCompanies`（company.service.ts）

於轉移 documents 與 rules 之間補 extraction_results 轉移，並在回傳型別加 `extractionResultsTransferred`（此函式無呼叫者，改回傳型別安全無下游影響）。

### 一致性原則

三類轉移（documents / extraction_results / mapping_rules）與 `confirmCompanyMerge` 完全對齊。**刻意不轉** `document_formats` / `field_definition_sets` / `template_field_mappings`——canonical 保留自身定義，副公司的在 MERGED 後 inert 永不被載入（比照 FIX-105 對 CEVA 的處置，避免唯一約束衝突與重複定義）。

## 驗收

| # | 項目 | 標準 | 狀態 |
|---|------|------|------|
| 1 | `autoMergeCompanies` 補齊三轉移 | admin 合併後 documents/extraction_results/rules 全指向主公司 | ✅ |
| 2 | `mergeCompanies` 補 extraction_results | 回傳含 `extractionResultsTransferred` | ✅ |
| 3 | 與 `confirmCompanyMerge` 一致 | 三類轉移相同、format/field-def 皆不轉 | ✅ |
| 4 | 型別檢查 | `npm run type-check` pass | ✅ |
| 5 | ESLint | 兩檔 0 error（3 warning 為既有 dead code，非本 FIX 引入） | ✅ |
| 6 | UI 驗證 | 實際跑一次 admin 合併，確認文件/費用不再孤兒化 | ⏳ 待使用者 UI 驗證 |

## 待辦 / 存量資料（使用者定案：另議）

1. **存量孤兒資料**：FIX-112 前經 admin 合併 UI 併過的公司，其被孤兒化的 documents / extraction_results 仍指向 MERGED 副公司。本 FIX 只防未來、**不回填存量**。如需回填，先盤點「MERGED 公司仍綁著的 documents/extraction_results」數量與影響公司，再比照 FIX-105 另立 gated dryrun/write 腳本。
2. **UI 驗證**：跑一次 admin 合併，確認合併後主公司承接文件、費用欄位正常。
3. **Azure 部署**：純程式碼修正，隨下次 `az acr build` 部署生效（無 migration、無新 env）。
