# Scripts 目錄 - 工具腳本

> **腳本數量**: **162** 個文件
> **主要類型**: 測試腳本、調試工具、資料檢查、管理操作
> **最後更新**: 2026-08-06（重新計數）
> **版本**: 1.1.0

---

## 概述

本目錄包含開發與運維過程中建立的各類工具腳本。大部分是一次性調試或測試用途，部分是持續使用的工具。

> **注意**: 許多腳本是開發過程中的臨時工具，可能引用已變更的 API 或資料庫結構。使用前請先檢查相容性。

---

## 腳本分類

### 1. 資料庫管理 (Database)

| 腳本 | 說明 |
|------|------|
| `init-db.sql` | 資料庫初始化 SQL |
| `create-admin.ts` | 建立管理員帳號 |
| `grant-admin-access.ts` | 授予管理員權限 |
| `fix-user-permissions.ts` | 修復用戶權限 |
| `check-user.ts` | 檢查用戶狀態 |
| `activate-company.ts` | 啟用公司 |
| `create-test-companies.ts` | 建立測試公司資料 |

### 2. i18n 驗證 (Internationalization)

| 腳本 | 說明 | 持續使用 |
|------|------|----------|
| `check-i18n.ts` | **i18n 同步檢查工具** | ✅ 是 (`npm run i18n:check`) |
| `e2e-i18n-check.ts` | i18n E2E 檢查 | ✅ 是 |

### 3. 批次處理調試 (Batch Processing)

| 腳本 | 說明 |
|------|------|
| `check-batch-status.mjs` | 檢查批次狀態 |
| `check-batch-status-now.mjs` | 即時批次狀態 |
| `check-batch-config.mjs` | 批次配置檢查 |
| `monitor-batch-progress.mjs` | 監控批次進度 |
| `reset-and-trigger-batch.mjs` | 重設並觸發批次 |
| `list-batches.mjs` | 列出所有批次 |
| `query-batches.mjs` | 查詢批次 |
| `analyze-batch-results.*` | 分析批次結果（.mjs/.cjs/.ts 多版本） |
| `verify-batch-results.ts` | 驗證批次結果 |

### 4. 提取分析與調試 (Extraction Debug)

| 腳本 | 說明 |
|------|------|
| `analyze-dhl-extraction.mjs` | 分析 DHL 提取結果 |
| `analyze-dhl-lineitems.mjs` | 分析 DHL 行項目 |
| `analyze-dhl-problem.mjs` | 分析 DHL 問題 |
| `check-dhl-details.mjs` | 檢查 DHL 詳情 |
| `check-dhl-extraction.mjs` | 檢查 DHL 提取 |
| `check-dhl-lineitems.mjs` | 檢查 DHL 行項目 |
| `check-extraction-structure.mjs` | 檢查提取結構 |
| `check-full-extraction.mjs` | 檢查完整提取 |
| `check-gpt-extraction-detail.mjs` | GPT 提取詳情 |
| `check-gpt-and-terms.mjs` | GPT 與術語檢查 |

### 5. V3 管線測試 (V3 Pipeline Testing)

| 腳本 | 說明 |
|------|------|
| `test-v3-upload.ts` | V3 上傳測試 |
| `test-e2e-pipeline.ts` | E2E 管線測試 |
| `test-multi-stage-extraction.ts` | 多階段提取測試 |
| `test-model-capabilities.ts` | GPT 模型能力測試 |
| `test-gpt5-nano-extraction.ts` | GPT-5-nano 提取測試 |
| `test-gpt-vision-service.mjs` | GPT Vision 服務測試 |
| `test-pdf-conversion.mjs` | PDF 轉換測試 |

### 6. Bug 修復驗證 (Fix Verification)

| 腳本 | 說明 |
|------|------|
| `test-fix-004b.ts` | FIX-004b 測試 |
| `test-fix-005.ts` / `verify-fix-005.ts` | FIX-005 測試與驗證 |
| `test-fix-006.mjs` | FIX-006 測試 |
| `test-fix-008-e2e.mjs` / `validate-fix-008-batch.mjs` | FIX-008 測試 |

### 7. CHANGE 驗證 (Change Verification)

| 腳本 | 說明 |
|------|------|
| `verify-change-006.mjs` / `verify-change-006-db.mjs` | CHANGE-006 驗證 |
| `check-change006-result.mjs` / `check-change006-batch.mjs` | CHANGE-006 結果檢查 |
| `test-change-010.ts` | CHANGE-010 測試 |

### 8. 格式與公司調試 (Format & Company Debug)

| 腳本 | 說明 |
|------|------|
| `check-format-id.ts` / `check-format-id.mjs` | 格式 ID 檢查 |
| `debug-format-issue.mjs` | 格式問題調試 |
| `check-company-config.mjs` | 公司配置檢查 |
| `test-company-matching.mjs` | 公司匹配測試 |
| `debug-company-matching.mjs` | 公司匹配調試 |

### 9. 術語與 Prompt (Term & Prompt)

| 腳本 | 說明 |
|------|------|
| `analyze-term-structure.mjs` | 術語結構分析 |
| `check-term-structure.mjs` | 術語結構檢查 |
| `check-prompt-config.mjs` | Prompt 配置檢查 |
| `create-dhl-prompt-config.mjs` | 建立 DHL Prompt 配置 |

### 10. 測試計劃執行 (Test Plans)

| 腳本 | 說明 |
|------|------|
| `e2e-test-plan-002.ts` | 測試計劃 002 |
| `test-plan-003-e2e.ts` | 測試計劃 003 E2E |
| `run-test-plan-003-*.mjs` | 執行測試計劃 003 |
| `verify-test-plan-003.mjs` | 驗證測試計劃 003 |
| `run-test-plan-005*.mjs` / `*.ts` | 執行測試計劃 005 |

### 11. 匯出與報表 (Export & Report)

| 腳本 | 說明 |
|------|------|
| `test-excel-export.ts` | Excel 匯出測試 |
| `export-hierarchical-terms.ts` | 階層術語匯出 |
| `test-hierarchical-export.mjs` | 階層匯出測試 |
| `check-export-issue.mjs` | 匯出問題檢查 |

### 12. 其他工具 (Miscellaneous)

| 腳本 | 說明 |
|------|------|
| `check-index-sync.js` | 索引同步檢查 |
| `check-status.mjs` | 系統狀態檢查 |
| `reset-stuck-files.mjs` | 重設卡住的文件 |
| `check-fields.ts` | 欄位檢查 |
| `check-resultdata.mjs` | 結果資料檢查 |
| `check-issuer-stats.mjs` | 發行方統計 |
| `backfill-document-format-id.mjs` | 回填文件格式 ID |

---

## 腳本命名約定

| 前綴 | 用途 | 範例 |
|------|------|------|
| `test-*` | 功能測試 | `test-v3-upload.ts` |
| `check-*` | 資料檢查 | `check-batch-status.mjs` |
| `analyze-*` | 資料分析 | `analyze-batch-results.mjs` |
| `debug-*` | 問題調試 | `debug-format-issue.mjs` |
| `verify-*` | 結果驗證 | `verify-fix-005.ts` |
| `run-*` | 執行任務 | `run-test-plan-003-full.mjs` |
| `fix-*` | 修復操作 | `fix-file-detected-type.mjs` |

---

## 相關文檔

- [CLAUDE.md (根目錄)](../CLAUDE.md) - 項目總指南

---

**維護者**: Development Team
**最後更新**: 2026-02-09
**版本**: 1.0.0
