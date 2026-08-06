# Types 目錄 - TypeScript 類型定義

> **類型文件數量**: **93** 個 `.ts` 文件（含 1 個 `index.ts` + 1 個 `.d.ts`）
> **導出管理**: `index.ts` 統一管理所有導出，處理大量命名衝突
> **最後更新**: 2026-08-06（重新計數）
> **版本**: 1.1.0

---

## 概述

本目錄包含所有 TypeScript 類型定義，是整個項目的類型基礎。由於跨 Epic 開發過程中多個文件存在同名導出，`index.ts` 使用大量命名導出和別名來避免衝突。

### 重要注意事項

- **命名衝突處理**: `index.ts` 中有多處 `as` 別名重新導出，新增類型時必須檢查衝突
- **Zod Schema**: 部分類型文件同時包含 Zod 運行時驗證 Schema
- **常量導出**: 部分文件同時導出 `const` 常量（如 `DOCUMENT_STATUS`、`EXTRACTION_METHODS`）
- **i18n 關聯**: 含 `label`/`description` 的常量必須同步更新 i18n 翻譯文件

---

## 類型分類

### 1. 核心業務類型 (Core Business) - 12 個

| 文件 | 說明 | Epic | 衝突注意 |
|------|------|------|----------|
| `extraction.ts` | OCR 提取結果類型 | Epic 2 | - |
| `extraction-v3.types.ts` | V3/V3.1 提取管線類型 | Epic 15 | 大量類型，獨立命名空間 |
| `field-mapping.ts` | 欄位映射規則類型 | Epic 4 | `ConfigScope` 與 Prisma 衝突 |
| `invoice-fields.ts` | 發票標準欄位定義 | Epic 2 | - |
| `confidence.ts` | 信心度計算類型 | Epic 2 | `ConfigSource` 來源 |
| `unified-processor.ts` | 統一處理器類型 | Epic 15 | `IssuerIdentificationResult` 衝突 |
| `format-matching.ts` | 格式匹配類型 | Epic 15 | - |
| `dynamic-config.ts` | 動態配置類型 | Epic 15 | `FieldTransformType` 衝突 |
| `issuer-identification.ts` | 發行方識別類型 | Epic 15 | `CompanyStatus` 衝突 |
| `term-learning.ts` | 術語學習類型 | Epic 15 | - |
| `term-validation.ts` | 術語驗證類型 | Epic 4 | - |
| `extracted-field.ts` | 提取欄位類型 | Epic 13 | - |

### 2. 文件管理 (Document Management) - 5 個

| 文件 | 說明 | Epic |
|------|------|------|
| `document-format.ts` | 文件格式類型 | Epic 16 |
| `document-issuer.ts` | 文件發行者類型 | Epic 0 |
| `document-progress.ts` | 文件處理進度 | Epic 10 |
| `document-source.types.ts` | 文件來源追蹤 | Epic 9 |
| `data-template.ts` | 資料模板類型 | Epic 19 |

### 3. 公司管理 (Company/Forwarder) - 5 個

| 文件 | 說明 | Epic | 衝突注意 |
|------|------|------|----------|
| `company.ts` | 公司類型（主要） | Epic 5 | REFACTOR-001 後主要使用 |
| `company-filter.ts` | 公司篩選器 | Epic 5 | - |
| `forwarder.ts` | Forwarder 類型（deprecated） | Epic 5 | 保留向後相容 |
| `forwarder-filter.ts` | Forwarder 篩選器（deprecated） | Epic 5 | - |
| `batch-company.ts` | 批次公司處理 | Epic 0 | - |

### 4. 規則管理 (Rules) - 4 個

| 文件 | 說明 | Epic | 衝突注意 |
|------|------|------|----------|
| `rule.ts` | 規則類型 | Epic 4 | `ExtractionMethod` 與 field-mapping 衝突 |
| `rule-test.ts` | 規則測試類型 | Epic 4 | `getChangeTypeConfig` 衝突 |
| `change-request.ts` | 變更請求類型 | Epic 4 | - |
| `suggestion.ts` | 規則建議類型 | Epic 4 | - |

### 5. 審核工作流 (Review) - 3 個

| 文件 | 說明 | Epic |
|------|------|------|
| `review.ts` | 審核類型 | Epic 3 |
| `escalation.ts` | 升級類型 | Epic 3 |
| `routing.ts` | 路由決策類型 | Epic 3 |

### 6. 報表與統計 (Reports & Statistics) - 7 個

| 文件 | 說明 | Epic | 衝突注意 |
|------|------|------|----------|
| `dashboard.ts` | 儀表板類型 | Epic 7 | - |
| `dashboard-filter.ts` | 儀表板篩選器 | Epic 7 | - |
| `monthly-report.ts` | 月度報表 | Epic 7 | `REPORT_EXPIRY_DAYS` 衝突 |
| `regional-report.ts` | 區域報表 | Epic 7 | `TimeGranularity` 衝突 |
| `processing-statistics.ts` | 處理統計 | Epic 7 | `TimeGranularity` 主要來源 |
| `ai-cost.ts` | AI 成本追蹤 | Epic 7 | `AnomalyType` 衝突 |
| `city-cost.ts` | 城市成本 | Epic 7 | `AnomalyType` 使用別名 |

### 7. 審計與追蹤 (Audit & Tracking) - 5 個

| 文件 | 說明 | Epic |
|------|------|------|
| `audit.ts` | 審計基礎類型 | Epic 8 |
| `audit-query.ts` | 審計查詢 | Epic 8 |
| `audit-report.ts` | 審計報表 | Epic 8 |
| `change-tracking.ts` | 變更追蹤 | Epic 8 |
| `traceability.ts` | 可追溯性 | Epic 8 |

### 8. 系統管理 (System & Admin) - 11 個

| 文件 | 說明 | Epic | 衝突注意 |
|------|------|------|----------|
| `alerts.ts` | 警報系統 | Epic 12 | `AlertSeverity`/`AlertStatus` 衝突 |
| `alert-service.ts` | 警報服務 | Epic 10 | - |
| `config.ts` | 系統配置 | Epic 12 | - |
| `backup.ts` | 備份管理 | Epic 12 | - |
| `restore.ts` | 還原管理 | Epic 12 | - |
| `retention.ts` | 資料保留 | Epic 12 | - |
| `logging.ts` | 日誌查詢 | Epic 12 | - |
| `health-monitoring.ts` | 健康監控 | Epic 10 | - |
| `monitoring.ts` | 監控 | Epic 12 | - |
| `performance.ts` | 效能監控 | Epic 12 | - |
| `accuracy.ts` | 準確度統計 | Epic 7 | - |

### 9. 外部整合 (External Integration) - 9 個

| 文件 | 說明 | Epic |
|------|------|------|
| `sharepoint.ts` | SharePoint 整合 | Epic 9 |
| `outlook.ts` | Outlook 基礎類型 | Epic 9 |
| `outlook-config.types.ts` | Outlook 配置 | Epic 9 |
| `n8n.ts` | n8n 整合 | Epic 10 |
| `workflow-execution.ts` | 工作流執行 | Epic 10 |
| `workflow-trigger.ts` | 工作流觸發 | Epic 10 |
| `workflow-error.ts` | 工作流錯誤 | Epic 10 |
| `documentation.ts` | API 文檔 | Epic 11 |
| `sdk-examples.ts` | SDK 範例 | Epic 11 |

### 10. 用戶與權限 (User & Auth) - 5 個

| 文件 | 說明 | Epic |
|------|------|------|
| `user.ts` | 用戶類型 | Epic 1 |
| `role.ts` | 角色類型 | Epic 1 |
| `permissions.ts` | 權限類型 | Epic 1 |
| `permission-categories.ts` | 權限分類 | Epic 1 |
| `role-permissions.ts` | 角色權限映射 | Epic 1 |

### 11. Prompt 配置 (Prompt Config) - 3 個

| 文件 | 說明 | Epic |
|------|------|------|
| `prompt-config.ts` | Prompt 配置類型 + `PROMPT_TYPES` 常量 | Epic 14 |
| `prompt-config-ui.ts` | Prompt 配置 UI 類型 | Epic 14 |
| `prompt-resolution.ts` | Prompt 解析類型 | Epic 14 |

### 12. 模板管理 (Template) - 3 個

| 文件 | 說明 | Epic | 衝突注意 |
|------|------|------|----------|
| `template-field-mapping.ts` | 模板欄位映射 | Epic 19 | `FieldTransformType` 衝突 |
| `template-instance.ts` | 模板實例 | Epic 19 | - |
| `template-matching-engine.ts` | 模板匹配引擎 | Epic 19 | - |

### 13. 參考編號與匯率 (Reference Number & Exchange Rate) - 3 個

| 文件 | 說明 | Epic |
|------|------|------|
| `region.ts` | 區域類型 | Epic 20 |
| `reference-number.ts` | 參考編號類型 | Epic 20 |
| `exchange-rate.ts` | 匯率類型 | Epic 21 |

### 14. 其他 (Miscellaneous) - 7 個

| 文件 | 說明 |
|------|------|
| `index.ts` | 統一導出（616 行） |
| `next-auth.d.ts` | NextAuth 類型擴展 |
| `date-range.ts` | 日期範圍 |
| `impact.ts` | 影響分析 |
| `pattern.ts` | 模式分析 |
| `version.ts` | 版本記錄 |
| `report-export.ts` | 報表匯出 |
| `batch-term-aggregation.ts` | 批次術語聚合 |

---

## 已知命名衝突清單

> **重要**: 新增類型時務必檢查 `index.ts` 中的命名衝突

| 衝突名稱 | 來源文件 | 解決方式 |
|----------|----------|----------|
| `ConfigScope` | `field-mapping.ts` vs Prisma | `MappingConfigScope` 別名 |
| `ExtractionMethod` | `field-mapping.ts` vs `rule.ts` | `RuleExtractionMethod` 別名 |
| `ExtractionPattern` | `field-mapping.ts` vs `rule.ts` | `RuleExtractionPattern` 別名 |
| `CompanyStatus` | `company.ts` vs `issuer-identification.ts` | `IssuerCompanyStatus` 別名 |
| `IssuerIdentificationResult` | `unified-processor.ts` vs `issuer-identification.ts` | `AdapterIssuerIdentificationResult` 別名 |
| `TimeGranularity` | `regional-report.ts` vs `processing-statistics.ts` | `RegionalTimeGranularity` 別名 |
| `AnomalyType` | `ai-cost.ts` vs `city-cost.ts` | `CityCostAnomalyType` 別名 |
| `AlertSeverity` | `alerts.ts` vs `health-monitoring.ts` | `RuleAlertSeverity` 別名 |
| `FieldTransformType` | `dynamic-config.ts` vs `template-field-mapping.ts` | `TemplateFieldTransformType` 別名 |
| `REPORT_EXPIRY_DAYS` | `monthly-report.ts` vs `audit-report.ts` | `AUDIT_REPORT_EXPIRY_DAYS` 別名 |
| `MAX_FILE_SIZE` | `sharepoint.ts` vs external-api | `EXTERNAL_API_MAX_FILE_SIZE` 別名 |

---

## 新增類型指南

1. **檢查命名衝突**: 在 `index.ts` 中搜尋同名導出
2. **使用命名導出**: 如有衝突，使用 `as` 別名
3. **添加 JSDoc**: 類型文件頭部使用簡化版註釋
4. **同步 i18n**: 含 `label`/`description` 的常量必須更新翻譯文件
5. **更新 index.ts**: 在對應區段中添加導出
6. **更新本文檔**: 將新文件加入對應分類

---

## 相關文檔

- [CLAUDE.md (根目錄)](../../CLAUDE.md) - 項目總指南
- [.claude/rules/typescript.md](../../.claude/rules/typescript.md) - TypeScript 規範
- [.claude/rules/i18n.md](../../.claude/rules/i18n.md) - i18n 規範（常量同步）
- [src/lib/validations/](../lib/validations/) - Zod 驗證 Schema

---

**維護者**: Development Team
**最後更新**: 2026-02-09
**版本**: 1.0.0
