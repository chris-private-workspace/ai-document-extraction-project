# FIX-113: 存量孤兒合併資料回填（past admin-merge orphans）

> **日期**: 2026-07-16
> **狀態**: ✅ 已完成（本地 + Azure DEV 皆驗證無 CORE 存量孤兒，無需 WRITE；gated 腳本留作安全網工具）
> **嚴重度**: Sev2（資料完整性 — 過往 admin 合併孤兒化的 documents/extraction_results 使 COMPANY 級 template 映射失效）
> **類型**: Bug Fix（資料治理 — 存量回填，比照 FIX-105）
> **影響範圍**: 資料層（本地 DB / Azure DEV DB）；無程式碼變更（除新增一次性腳本）
> **關聯**: [[FIX-112]]（程式碼防未來）、[[FIX-105]]（CEVA 特定存量已於合併時轉移）、[[CHANGE-103]] Phase 2

---

## 問題描述

FIX-112 修正了合併路徑的程式碼缺口（未來 admin 合併會轉移 documents + extraction_results + mapping_rules）。但 **FIX-112 之前**經 admin 合併 UI（`autoMergeCompanies`，當時什麼都不轉）併過的公司，其副公司已被標 MERGED、關聯資料卻仍指向該 MERGED 副公司 → COMPANY 級 template 映射因 companyId 不相等而失效。本 FIX 回填存量。

## 方案（gated 一次性腳本，DRYRUN 優先）

`prisma/apply-fix113-orphan-backfill.js`，由 `RUN_FIX113_ORPHAN_BACKFILL=dryrun|write` 控制，**不接入 entrypoint**（破壞性、避免部署誤觸），交易原子性。

**對象發現**：自動找出所有 `status='MERGED'` 且 `merged_into_id` 非空的公司，沿 `merged_into_id` 鏈解析到「末端 canonical」（第一個非 MERGED，含環路 / 缺失 / 過深保護）。

**轉移策略**（與 FIX-112 / `confirmCompanyMerge` 一致）：
- **自動轉移（CORE）**：`documents`、`extraction_results`、`mapping_rules`（每 source → 其解析 target）。
- **回報但不轉（KEEP，MERGED 後 inert）**：`field_definition_sets`、`template_field_mappings`、`document_formats`。
- **回報但不轉（OTHER）**：其餘任何含 `company_id` 的表若仍有孤兒列，DRYRUN 會列出供人工評估（不隱藏、不靜默略過）。

## 執行紀錄

| 環境 | 模式 | 結果 |
|------|------|------|
| 本地 DB | DRYRUN（2026-07-16） | **0 筆** MERGED-with-target → 無孤兒可回填（本地 CEVA 已於 2026-06-26 直接修復，無殘留 MERGED 公司） |
| Azure DEV | DRYRUN（2026-07-16，經 Kudu） | **7 筆** MERGED（皆可解析到 canonical）；**CORE 全 0**（documents 0 / extraction_results 0 / mapping_rules 0）→ **無 CORE 孤兒、無需 WRITE** |
| Azure DEV | WRITE | ❌ 不執行（DRYRUN 顯示 CORE 存量為 0，無資料可轉） |

### Azure DRYRUN 細節

- 7 筆 MERGED 公司的 CORE 關聯（documents/extraction_results/mapping_rules）**皆已一致**：FIX-105 合併 5 筆 CEVA 時已同步轉移其 documents/extraction_results；更早的「…Office」等 MERGED 公司本就 0 文件。
- **KEEP 表 inert 殘留（刻意不轉）**：`field_definition_sets` 1、`template_field_mappings` 4、`document_formats` 7 —— 即 FIX-105 已標註「殘留（inert，可日後清）」的那批，留在 MERGED 公司下、永不被載入，不影響 template 映射。
- **OTHER 表**：無孤兒列。

## 驗收

| # | 項目 | 標準 | 狀態 |
|---|------|------|------|
| 1 | gated 腳本 | dryrun 只讀、write 交易原子性、不接 entrypoint | ✅ |
| 2 | 鏈解析安全 | 環路 / target 缺失 / 過深 → skip 並回報，不誤指 MERGED 末端 | ✅ |
| 3 | 本地驗證 | 本地 DRYRUN 正常執行 | ✅ 0 筆 |
| 4 | Azure DRYRUN | 盤點 Azure 存量孤兒 | ✅ CORE 全 0 |
| 5 | 結論 | 無 CORE 存量孤兒 → 無需 WRITE；FIX-112 + FIX-105 已使 CORE 一致 | ✅ |

## 結論與後續

- **無需 WRITE**：本地 + Azure DEV 的 CORE 關聯資料皆已一致，FIX-112（防未來）+ FIX-105（CEVA 存量）已充分。
- **腳本保留**：`prisma/apply-fix113-orphan-backfill.js` 留作安全網——未來若再出現孤兒（如尚未部署 FIX-112 的環境合併），可 DRYRUN 盤點。
- **KEEP 表 inert 殘留（選）**：Azure 的 1 field_def_set + 4 template_field_mappings + 7 document_formats 掛在 MERGED 公司下，無害、不載入；若要徹底清理可另立小型清理 FIX（非本 FIX 範圍，與 FIX-105「殘留可日後清」同一批）。
