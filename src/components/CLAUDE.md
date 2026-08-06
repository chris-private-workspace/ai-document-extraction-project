# Components 目錄 - React 組件庫

> **組件數量**: **387** 組件文件
> **最後更新**: 2026-08-06（重新計數）
> **版本**: 2.2.0
> **深度分析**: `docs/06-codebase-analyze/02-module-mapping/components-overview.md`
> **UI 設計系統**: `docs/06-codebase-analyze/08-ui-design-system/ui-patterns.md`

---

## 概述

本目錄包含所有 React 組件，採用 Next.js 15 App Router 架構。組件層遵循以下原則：
- **組件分層**: UI 基礎組件 → 功能組件 → 頁面組件
- **Client/Server 分離**: 明確區分客戶端和伺服器組件
- **狀態管理**: Zustand (UI) + React Query (Server State)
- **樣式系統**: Tailwind CSS + shadcn/ui

---

## 目錄結構

```
src/components/
├── ui/                         # shadcn/ui 基礎組件（34 個，不可修改）
├── features/                   # 功能性業務組件（37 個子目錄）
│   ├── admin/                  #   管理員組件 (Epic 1, 12)
│   ├── audit/                  #   審計組件 (Epic 8)
│   ├── auth/                   #   認證組件 (Epic 1, 18)
│   ├── companies/              #   公司組件 (Epic 5)
│   ├── confidence/             #   信心度組件 (Epic 2)
│   ├── data-template/          #   資料模板組件 (Epic 19)
│   ├── docs/                   #   API 文檔組件 (Epic 11)
│   ├── document/               #   文件組件 (Epic 2, CHANGE-031)
│   ├── document-preview/       #   文件預覽組件 (Epic 13)
│   ├── document-source/        #   文件來源組件 (Epic 9)
│   ├── escalation/             #   升級組件 (Epic 3)
│   ├── exchange-rate/          #   匯率管理組件 (Epic 21)
│   ├── format-analysis/        #   格式分析組件 (Epic 0)
│   ├── formats/                #   文件格式管理組件 (Epic 16)
│   ├── forwarders/             #   Forwarder 組件 (Epic 5, 向後兼容)
│   ├── global/                 #   全域組件 (Epic 6, 7)
│   ├── historical-data/        #   歷史數據組件 (Epic 0)
│   ├── history/                #   歷史組件 (Epic 8)
│   ├── locale/                 #   國際化組件 (Epic 17)
│   ├── mapping-config/         #   映射配置組件 (Epic 13)
│   ├── outlook/                #   Outlook 組件 (Epic 9)
│   ├── pipeline-config/        #   管線配置組件 (CHANGE-032)
│   ├── prompt-config/          #   Prompt 配置組件 (Epic 14)
│   ├── reference-number/       #   參考編號組件 (Epic 20)
│   ├── region/                 #   區域管理組件 (Epic 20)
│   ├── reports/                #   報表組件 (Epic 7)
│   ├── retention/              #   資料保留組件 (Epic 12)
│   ├── review/                 #   審核組件 (Epic 3)
│   ├── rule-review/            #   規則審核組件 (Epic 4)
│   ├── rules/                  #   規則組件 (Epic 4)
│   ├── rule-version/           #   規則版本組件 (Epic 4)
│   ├── sharepoint/             #   SharePoint 組件 (Epic 9)
│   ├── suggestions/            #   建議組件 (Epic 4)
│   ├── template-field-mapping/ #   模板欄位映射組件 (Epic 19)
│   ├── template-instance/      #   模板實例組件 (Epic 19)
│   ├── template-match/         #   模板匹配組件 (Epic 19)
│   └── term-analysis/          #   術語分析組件 (Epic 0)
├── layout/                     # 通用佈局元件
├── admin/                      # 管理員專用組件
├── analytics/                  # 分析相關組件
├── auth/                       # 認證相關組件
├── dashboard/                  # 儀表板組件
├── export/                     # 匯出功能組件
├── filters/                    # 篩選器組件
└── reports/                    # 報表組件
```

---

## 組件分類

### 1. UI 基礎組件 (shadcn/ui) - 34 個

> **重要**: 這些組件由 shadcn/ui CLI 生成，**不可直接修改**。如需自定義，請在 `features/` 建立包裝組件。

accordion, alert, alert-dialog, avatar, badge, button, calendar, card, checkbox, collapsible, command, dialog, dropdown-menu, form, input, label, month-picker, pagination, popover, progress, radio-group, resizable, scroll-area, select, separator, skeleton, slider, switch, table, tabs, textarea, toast, toaster, tooltip

### 2. 功能組件 (Features) - 37 個子目錄

#### 2.1 `features/admin/` - Epic 1, 12 (43 組件)

**alerts/**: AlertDashboard, AlertHistory, AlertRuleManagement, AlertRuleTable, CreateAlertRuleDialog
**api-keys/**: ApiKeyManagement, ApiKeyTable, CreateApiKeyDialog
**backup/**: BackupList, BackupManagement, BackupScheduleList, BackupStatusCard, CreateBackupDialog, ScheduleDialog, StorageUsageCard
**config/**: ConfigEditDialog, ConfigHistoryDialog, ConfigItem, ConfigManagement
**logs/**: LogViewer, LogDetailDialog, LogExportDialog, LogStreamPanel
**monitoring/**: HealthDashboard
**restore/**: RestoreList, RestoreDialog, RestoreDetailDialog, RestoreManagement
**roles/**: RoleList, AddRoleDialog, DeleteRoleDialog, EditRoleDialog, PermissionSelector
**根目錄**: AddUserDialog, CitySelector, EditUserDialog, PermissionScopeIndicator, UserFilters, UserList, UserListSkeleton, UserSearchBar, UserStatusToggle, UserTable

#### 2.2 `features/audit/` - Epic 8

AuditReportExportDialog, AuditReportJobList, ReportIntegrityDialog

#### 2.3 `features/auth/` - Epic 1, 18

LoginForm (本地帳號登入), RegisterForm (用戶註冊), DevLoginForm (開發環境登入)

#### 2.4 `features/companies/` - Epic 5

CompanyForm, CompanyTable, CompanyMappingEditor, DetectCompanyDialog

> 因 REFACTOR-001，原 forwarders 組件已遷移至 companies

#### 2.5 `features/confidence/` - Epic 2

ConfidenceBadge (顏色編碼), ConfidenceBreakdown (分解詳情), ConfidenceIndicator

#### 2.6 `features/data-template/` - Epic 19

DataTemplateCard, DataTemplateFieldEditor, DataTemplateFilters, DataTemplateForm, DataTemplateList

#### 2.7 `features/docs/` - Epic 11

CodeBlock, LanguageTabs, SDKExamplesContent, SwaggerUIWrapper

#### 2.8 `features/document/` - Epic 2, CHANGE-031

> 因 CHANGE-031 (Invoice → Document 重命名)，原 invoice/ 已重組為 document/

**根目錄**: DocumentListTable, FileUploader (拖放支援), ProcessingStatus, RetryButton
**detail/**: DocumentDetailHeader, DocumentDetailStats, DocumentDetailTabs, AiDetailsTab, ProcessingTimeline, DocumentAuditLog, SmartRoutingBanner

#### 2.9 `features/document-preview/` - Epic 13

PDFViewer (react-pdf), DynamicPDFViewer (SSR 安全), PDFControls, FieldHighlightOverlay (座標轉換+信心度色碼), PDFLoadingSkeleton, PDFErrorDisplay, FieldCard (內聯編輯), FieldFilters (搜尋/篩選/排序), ExtractedFieldsPanel

#### 2.10 `features/document-source/` - Epic 9

DocumentSourceBadge (Manual/Outlook/SharePoint), DocumentSourceDetails, SourceTypeFilter, SourceTypeStats, SourceTypeTrend

#### 2.11 `features/escalation/` - Epic 3

EscalationFilters, EscalationStatusBadge, ResolveDialog

#### 2.12 `features/exchange-rate/` - Epic 21

CurrencySelect (幣別選擇), ExchangeRateCalculator (匯率換算), ExchangeRateFilters, ExchangeRateForm, ExchangeRateImportDialog (批次匯入), ExchangeRateList

#### 2.13 `features/format-analysis/` - Epic 0

FormatAnalysisPanel, FormatDistributionChart

#### 2.14 `features/formats/` - Epic 16 (17 組件)

ConfigInheritanceInfo, CreateFormatDialog, FormatBasicInfo, FormatCard, FormatConfigPanel, FormatDetailView, FormatFilesTable, FormatFilters, FormatForm, FormatList, FormatTermsTable, IdentificationRulesEditor, KeywordTagInput, LinkedMappingConfig, LinkedPromptConfig, LogoPatternEditor, SourceFieldCombobox

#### 2.15 `features/forwarders/` - Epic 5

ForwarderForm, ForwarderFilters, ForwarderRulesTable, ForwarderStatsPanel, LogoUploader

> 向後兼容組件，新開發請使用 companies 組件

#### 2.16 `features/global/` - Epic 6, 7

CityRankings, GlobalStats, GlobalTrend, RegionView

#### 2.17 `features/historical-data/` - Epic 0

BatchUploadPanel, BatchProgressTracker, TermAggregationView

#### 2.18 `features/history/` - Epic 8

ChangeHistoryTimeline, HistoryVersionCompareDialog

#### 2.19 `features/locale/` - Epic 17

LocaleSwitcher (語言切換，支援 en/zh-TW/zh-CN)

#### 2.20 `features/mapping-config/` - Epic 13 (9 組件)

ConfigSelector, MappingConfigPanel, MappingPreview, MappingRuleList, RuleEditor, SortableRuleItem (拖放支援), SourceFieldSelector, TargetFieldSelector, TransformConfigPanel

#### 2.21 `features/outlook/` - Epic 9

OutlookConfigForm, OutlookConfigList, OutlookFilterRulesEditor

#### 2.22 `features/pipeline-config/` - CHANGE-032

PipelineConfigFilters, PipelineConfigForm, PipelineConfigList, PipelineConfigScopeBadge

#### 2.23 `features/prompt-config/` - Epic 14 (10 組件)

CollapsibleControls, CollapsiblePromptGroup, PromptConfigFilters, PromptConfigForm, PromptConfigList, PromptEditor, PromptTemplateInserter, PromptTester, ShowMoreButton, TemplatePreviewDialog

#### 2.24 `features/reference-number/` - Epic 20 (8 組件)

ReferenceNumberDeleteDialog, ReferenceNumberExportButton, ReferenceNumberFilters, ReferenceNumberForm, ReferenceNumberImportDialog (批次匯入), ReferenceNumberList, ReferenceNumberStatusBadge, ReferenceNumberTypeBadge

#### 2.25 `features/region/` - Epic 20

RegionSelect (區域選擇器)

#### 2.26 `features/reports/` - Epic 7

AiCostCard, CityCostTable, CostAnomalyDialog

#### 2.27 `features/retention/` - Epic 12

ArchiveRecordList, RetentionPolicyEditor

#### 2.28 `features/review/` - Epic 3

ReviewQueue, ReviewDetailPanel, ApproveRejectButtons, FieldCorrectionForm

#### 2.29 `features/rules/` - Epic 4

RuleEditor, RuleTestPanel, ImpactAnalysisView, RuleAccuracyChart

#### 2.30 `features/rule-review/` - Epic 4

RuleSuggestionList, RuleSuggestionDetail, ApprovalWorkflow

#### 2.31 `features/rule-version/` - Epic 4

RuleVersionHistory, VersionDiffViewer

#### 2.32 `features/sharepoint/` - Epic 9

SharePointConfigForm, SharePointConfigList

#### 2.33 `features/suggestions/` - Epic 4

SuggestionCard, SuggestionSimulator

#### 2.34 `features/template-field-mapping/` - Epic 19 (10 組件)

FormulaEditor, LookupTableEditor, MappingRuleEditor, MappingRuleItem, MappingTestPanel, SourceFieldSelector, TargetFieldSelector, TemplateFieldMappingForm, TemplateFieldMappingList, TransformConfigEditor

#### 2.35 `features/template-instance/` - Epic 19 (12 組件)

BulkActionsMenu, CreateInstanceDialog, ExportDialog, ExportFieldSelector, InstanceRowsTable, InstanceStatsOverview, RowDetailDrawer, RowEditDialog, TemplateInstanceCard, TemplateInstanceDetail, TemplateInstanceFilters, TemplateInstanceList

#### 2.36 `features/template-match/` - Epic 19

BulkMatchDialog, DefaultTemplateSelector, MatchStatusBadge, MatchToTemplateDialog

#### 2.37 `features/term-analysis/` - Epic 0

TermAggregationPanel, TermClassificationView, HierarchicalTermTree

### 3. 佈局組件 (`layout/`)

CityIndicator (城市指示器), DashboardHeader (儀表板標頭), DashboardLayout (儀表板佈局), Sidebar (側邊導航欄), TopBar (頂部導航列)

### 4. 儀表板組件 (`dashboard/`) - Epic 7

AccessDeniedAlert, ControlledDateRangePicker, DashboardFilters, DashboardStats, DashboardStatsWithDateRange, DateRangePicker, DateRangeQuickSelect, ForwarderComparisonChart, ForwarderMultiSelect, StatCard

### 5. 認證組件 (`auth/`) - Epic 1

CityRestricted (城市存取限制)

> Epic 18 新增的登入/註冊表單位於 `features/auth/`

### 6. 其他組件

- `analytics/`: CityComparison
- `admin/performance/`: PerformanceDashboard
- `filters/`: CityFilter, CityMultiSelect
- `export/`: MultiCityExportDialog
- `reports/`: AiCostReportContent, CityComparisonTable, CityCostReportContent, CityDetailPanel, ExportDialog, MonthlyReportDialog, RegionalReportContent

---

## 組件設計模式

### 標準結構

```typescript
'use client';

/**
 * @fileoverview [組件功能描述]
 * @module src/components/features/[name]
 * @since Epic X - Story X.X
 */

import * as React from 'react';

interface ComponentProps {
  prop1: string;
  prop2?: number;
}

export function ComponentName({ prop1, prop2 }: ComponentProps) {
  // Hooks → Effects → Handlers → Render
  return (<div>...</div>);
}
```

### 狀態管理

- **UI 狀態**: Zustand (`@/stores/`)
- **伺服器狀態**: React Query (`@/hooks/`)
- **表單狀態**: React Hook Form + Zod

### 國際化 (i18n)

> 完整規範: `.claude/rules/i18n.md`

使用 `useTranslations('namespace')` 和 `@/i18n/routing` 的 Link/Router

---

## 注意事項

- 不要修改 `src/components/ui/` 下的 shadcn 組件
- 如需自定義，在 `src/components/features/` 建立包裝組件
- 組件保持在 300 行以內
- 使用 `useMemo` / `useCallback` 優化性能
- 所有功能組件必須包含標準 JSDoc 頭部

---

## 相關文檔

- [CLAUDE.md (根目錄)](../../CLAUDE.md) - 項目總指南
- [.claude/rules/components.md](../../.claude/rules/components.md) - 組件開發規範
- [.claude/rules/i18n.md](../../.claude/rules/i18n.md) - 國際化開發規範
- [src/hooks/CLAUDE.md](../hooks/CLAUDE.md) - 自定義 Hooks
- [src/stores/](../stores/) - Zustand 狀態管理
- [src/i18n/](../i18n/) - 國際化配置

---

**維護者**: Development Team
**最後更新**: 2026-02-09
**版本**: 2.0.0
