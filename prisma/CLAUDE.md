# Prisma 目錄 - 資料庫 Schema 與遷移

> **Models**: **125** 個資料模型
> **Enums**: **115** 個列舉類型
> **Schema 行數**: 4,095 行
> **最後更新**: 2026-08-06（重新計數）
> **版本**: 1.2.0
> **深度分析**: `docs/06-codebase-analyze/03-database/prisma-model-inventory.md`、`enum-inventory.md`、`migration-history.md`

---

## 概述

本目錄包含 Prisma ORM 的 Schema 定義、資料庫遷移腳本和種子資料。Schema 定義了整個系統的資料模型，是所有服務層和 API 的資料基礎。

---

## 目錄結構

```
prisma/
├── schema.prisma          # 主 Schema（125 models, 115 enums, 4095 行）
├── seed.ts                # 種子資料入口
├── seed-data/             # 種子資料模組
│   ├── forwarders.ts      # 公司/Forwarder 種子
│   ├── mapping-rules.ts   # 映射規則種子
│   └── config-seeds.ts    # 系統配置種子
├── seed/
│   └── exported-data.json # 匯出的種子資料
├── migrations/            # 資料庫遷移腳本
│   ├── migration_lock.toml
│   └── YYYYMMDDHHMMSS_*/  # 各版本遷移 SQL
└── sql/
    └── audit_log_immutability.sql  # 審計日誌不可變性觸發器
```

---

## 模型分類概覽（122 個 Models）

### 1. 用戶與權限 (User & Auth) - 8 個

| Model | 說明 | Epic |
|-------|------|------|
| `User` | 用戶帳號 | Epic 1 |
| `Account` | OAuth 帳號（NextAuth） | Epic 1 |
| `Session` | 登入會話 | Epic 1 |
| `VerificationToken` | 驗證令牌 | Epic 1 |
| `Role` | 角色定義 | Epic 1 |
| `UserRole` | 用戶角色關聯 | Epic 1 |
| `UserCityAccess` | 城市存取權限 | Epic 6 |
| `UserRegionAccess` | 區域存取權限 | Epic 20 |

### 2. 區域與城市 (Region & City) - 2 個

| Model | 說明 | Epic |
|-------|------|------|
| `Region` | 區域定義 | Epic 20 |
| `City` | 城市定義 | Epic 6 |

### 3. 文件處理核心 (Document Core) - 7 個

| Model | 說明 | Epic |
|-------|------|------|
| `Document` | 文件主體 | Epic 2 |
| `OcrResult` | OCR 提取結果 | Epic 2 |
| `ExtractionResult` | 欄位提取結果 | Epic 2 |
| `ProcessingQueue` | 處理佇列 | Epic 2 |
| `DocumentProcessingStage` | 處理階段追蹤 | Epic 10 |
| `DocumentFormat` | 文件格式定義 | Epic 16 |
| `BulkOperation` | 批次操作記錄 | Epic 0 |

### 4. 公司管理 (Company) - 3 個

| Model | 說明 | Epic |
|-------|------|------|
| `Company` | 公司主體（REFACTOR-001 後主要使用） | Epic 5 |
| `Forwarder` | Forwarder（deprecated，向後相容） | Epic 5 |
| `ForwarderIdentification` | Forwarder 識別記錄 | Epic 5 |

### 5. 映射與規則 (Mapping & Rules) - 12 個

| Model | 說明 | Epic |
|-------|------|------|
| `MappingRule` | 映射規則 | Epic 4 |
| `RuleSuggestion` | 規則建議 | Epic 4 |
| `SuggestionSample` | 建議樣本 | Epic 4 |
| `RuleVersion` | 規則版本 | Epic 4 |
| `RuleApplication` | 規則應用記錄 | Epic 4 |
| `RollbackLog` | 回滾日誌 | Epic 4 |
| `RuleChangeRequest` | 規則變更請求 | Epic 4 |
| `RuleTestTask` | 規則測試任務 | Epic 4 |
| `RuleTestDetail` | 規則測試詳情 | Epic 4 |
| `RuleCacheVersion` | 規則快取版本 | Epic 4 |
| `FieldMappingConfig` | 欄位映射配置 | Epic 13 |
| `FieldMappingRule` | 欄位映射規則 | Epic 13 |

### 6. 審核工作流 (Review) - 5 個

| Model | 說明 | Epic |
|-------|------|------|
| `ReviewRecord` | 審核記錄 | Epic 3 |
| `Correction` | 修正記錄 | Epic 3 |
| `FieldCorrectionHistory` | 欄位修正歷史 | Epic 3 |
| `CorrectionPattern` | 修正模式 | Epic 3 |
| `Escalation` | 升級記錄 | Epic 3 |
| `PatternAnalysisLog` | 模式分析日誌 | Epic 4 |
| `Notification` | 通知記錄 | Epic 3 |

### 7. 審計與安全 (Audit & Security) - 5 個

| Model | 說明 | Epic |
|-------|------|------|
| `AuditLog` | 審計日誌 | Epic 8 |
| `SecurityLog` | 安全日誌 | Epic 8 |
| `DataChangeHistory` | 資料變更歷史 | Epic 8 |
| `TraceabilityReport` | 追溯報告 | Epic 8 |
| `StatisticsAuditLog` | 統計審計日誌 | Epic 7 |

### 8. 報表與統計 (Reports) - 6 個

| Model | 說明 | Epic |
|-------|------|------|
| `ReportJob` | 報表任務 | Epic 7 |
| `MonthlyReport` | 月度報告 | Epic 7 |
| `AuditReportJob` | 審計報告任務 | Epic 8 |
| `AuditReportDownload` | 審計報告下載 | Epic 8 |
| `ProcessingStatistics` | 處理統計 | Epic 7 |
| `HourlyProcessingStats` | 每小時統計 | Epic 7 |

### 9. AI 成本追蹤 (AI Cost) - 3 個

| Model | 說明 | Epic |
|-------|------|------|
| `ApiUsageLog` | API 使用日誌 | Epic 7 |
| `ApiPricingConfig` | API 定價配置 | Epic 7 |
| `ApiPricingHistory` | API 定價歷史 | Epic 7 |

### 10. 系統配置 (System Config) - 3 個

| Model | 說明 | Epic |
|-------|------|------|
| `SystemConfig` | 系統配置 | Epic 12 |
| `ConfigHistory` | 配置歷史 | Epic 12 |
| `PipelineConfig` | 管線配置 | CHANGE-032 |

### 11. 資料保留 (Data Retention) - 4 個

| Model | 說明 | Epic |
|-------|------|------|
| `DataRetentionPolicy` | 保留策略 | Epic 8 |
| `DataArchiveRecord` | 歸檔記錄 | Epic 8 |
| `DataDeletionRequest` | 刪除請求 | Epic 8 |
| `DataRestoreRequest` | 還原請求 | Epic 8 |

### 12. 外部整合 - SharePoint (3 個)

| Model | 說明 | Epic |
|-------|------|------|
| `SharePointConfig` | SharePoint 配置 | Epic 9 |
| `SharePointFetchLog` | SharePoint 抓取日誌 | Epic 9 |
| `ApiKey` | API 金鑰 | Epic 11 |

### 13. 外部整合 - Outlook (3 個)

| Model | 說明 | Epic |
|-------|------|------|
| `OutlookConfig` | Outlook 配置 | Epic 9 |
| `OutlookFilterRule` | Outlook 篩選規則 | Epic 9 |
| `OutlookFetchLog` | Outlook 抓取日誌 | Epic 9 |

### 14. 外部整合 - n8n (4 個)

| Model | 說明 | Epic |
|-------|------|------|
| `N8nApiKey` | n8n API 金鑰 | Epic 10 |
| `N8nApiCall` | n8n API 呼叫日誌 | Epic 10 |
| `N8nWebhookEvent` | n8n Webhook 事件 | Epic 10 |
| `N8nIncomingWebhook` | n8n 入站 Webhook | Epic 10 |

### 15. 工作流 (Workflow) - 4 個

| Model | 說明 | Epic |
|-------|------|------|
| `WorkflowExecution` | 工作流執行 | Epic 10 |
| `WorkflowExecutionStep` | 工作流步驟 | Epic 10 |
| `WorkflowDefinition` | 工作流定義 | Epic 10 |
| `WebhookConfig` | Webhook 配置 | Epic 11 |
| `WebhookConfigHistory` | Webhook 配置歷史 | Epic 11 |

### 16. 外部 API (External API) - 6 個

| Model | 說明 | Epic |
|-------|------|------|
| `ExternalApiTask` | 外部 API 任務 | Epic 11 |
| `ExternalWebhookDelivery` | 外部 Webhook 投遞 | Epic 11 |
| `ExternalWebhookConfig` | 外部 Webhook 配置 | Epic 11 |
| `ExternalApiKey` | 外部 API 金鑰 | Epic 11 |
| `ApiAuthAttempt` | API 認證嘗試 | Epic 11 |
| `ApiAuditLog` | API 審計日誌 | Epic 11 |

### 17. 效能監控 (Performance) - 8 個

| Model | 說明 | Epic |
|-------|------|------|
| `ServiceHealthCheck` | 服務健康檢查 | Epic 12 |
| `ServiceAvailability` | 服務可用性 | Epic 12 |
| `SystemOverallStatus` | 系統總體狀態 | Epic 12 |
| `ApiPerformanceMetric` | API 效能指標 | Epic 12 |
| `SystemResourceMetric` | 系統資源指標 | Epic 12 |
| `AiServiceMetric` | AI 服務指標 | Epic 12 |
| `DatabaseQueryMetric` | 資料庫查詢指標 | Epic 12 |
| `PerformanceHourlySummary` | 效能每小時摘要 | Epic 12 |
| `PerformanceThreshold` | 效能閾值 | Epic 12 |
| `SystemHealthLog` | 系統健康日誌 | Epic 10 |
| `N8nConnectionStats` | n8n 連線統計 | Epic 10 |

### 18. 警報系統 (Alert) - 3 個

| Model | 說明 | Epic |
|-------|------|------|
| `AlertRule` | 警報規則 | Epic 12 |
| `Alert` | 警報記錄 | Epic 12 |
| `AlertRuleNotification` | 警報通知配置 | Epic 12 |
| `AlertRecord` | 警報記錄（舊版） | Epic 12 |
| `AlertNotificationConfig` | 警報通知配置（舊版） | Epic 12 |

### 19. 備份與還原 (Backup & Restore) - 7 個

| Model | 說明 | Epic |
|-------|------|------|
| `Backup` | 備份記錄 | Epic 12 |
| `BackupSchedule` | 備份排程 | Epic 12 |
| `BackupConfig` | 備份配置 | Epic 12 |
| `BackupStorageUsage` | 備份儲存用量 | Epic 12 |
| `RestoreRecord` | 還原記錄 | Epic 12 |
| `RestoreDrill` | 還原演練 | Epic 12 |
| `RestoreLog` | 還原日誌 | Epic 12 |

### 20. 系統日誌 (System Log) - 3 個

| Model | 說明 | Epic |
|-------|------|------|
| `SystemLog` | 系統日誌 | Epic 12 |
| `LogRetentionPolicy` | 日誌保留策略 | Epic 12 |
| `LogExport` | 日誌匯出 | Epic 12 |

### 21. 歷史批次處理 (Historical Batch) - 4 個

| Model | 說明 | Epic |
|-------|------|------|
| `HistoricalBatch` | 歷史批次 | Epic 0 |
| `HistoricalFile` | 歷史文件 | Epic 0 |
| `TermAggregationResult` | 術語聚合結果 | Epic 0 |
| `FileTransactionParty` | 文件交易方 | Epic 0 |

### 22. Prompt 配置 (Prompt Config) - 2 個

| Model | 說明 | Epic |
|-------|------|------|
| `PromptConfig` | Prompt 配置 | Epic 14 |
| `PromptVariable` | Prompt 變數 | Epic 14 |

### 23. 模板管理 (Template) - 4 個

| Model | 說明 | Epic |
|-------|------|------|
| `DataTemplate` | 資料模板 | Epic 19 |
| `TemplateFieldMapping` | 模板欄位映射 | Epic 19 |
| `TemplateInstance` | 模板實例 | Epic 19 |
| `TemplateInstanceRow` | 模板實例行 | Epic 19 |

### 24. 參考編號與匯率 (Reference Number & Exchange Rate) - 2 個

| Model | 說明 | Epic |
|-------|------|------|
| `ReferenceNumber` | 參考編號主檔 | Epic 20 |
| `ExchangeRate` | 匯率記錄 | Epic 21 |

---

## ID 策略

| 策略 | 說明 | 適用 |
|------|------|------|
| `@default(uuid())` | **新標準** — UUID v4 | 新建模型 |
| `@default(cuid())` | **舊版** — CUID | 早期模型（逐步遷移中） |

---

## 常用命令

```bash
# 生成 Prisma Client
npx prisma generate

# 執行遷移
npx prisma migrate dev --name <description>

# 查看資料庫
npx prisma studio

# 重設資料庫（危險！）
npx prisma migrate reset

# 種子資料
npx prisma db seed
```

---

## 相關文檔

- [CLAUDE.md (根目錄)](../CLAUDE.md) - 項目總指南
- [.claude/rules/database.md](../.claude/rules/database.md) - 資料庫規範
- [src/lib/prisma.ts](../src/lib/prisma.ts) - Prisma Client 單例

---

**維護者**: Development Team
**最後更新**: 2026-02-09
**版本**: 1.0.0
