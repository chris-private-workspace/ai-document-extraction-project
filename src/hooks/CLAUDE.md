# Hooks 目錄 - 自定義 React Hooks

> **Hook 數量**: **111** 個 Hook 文件
> **命名風格**: kebab-case (`use-xxx.ts`) 與 camelCase (`useXxx.ts`) 混合
> **最後更新**: 2026-08-06（重新計數）
> **版本**: 1.1.0

---

## 概述

本目錄包含所有自定義 React Hooks，封裝了 API 呼叫（React Query）、表單邏輯、UI 狀態、格式化工具等功能。大部分 Hook 使用 React Query (`useQuery` / `useMutation`) 管理伺服器狀態。

### 命名約定

| 風格 | 數量 | 說明 |
|------|------|------|
| `use-xxx.ts` (kebab-case) | ~60 | 較新的 Hook，符合項目命名規範 |
| `useXxx.ts` (camelCase) | ~41 | 較早期的 Hook，仍在使用中 |

> **注意**: 兩種風格並存是歷史原因。新增 Hook 應使用 `use-xxx.ts` (kebab-case) 格式。

---

## Hook 分類

### 1. 文件處理 (Document Processing) - 12 個

| Hook | 說明 | Epic |
|------|------|------|
| `use-document.ts` | 文件單項操作 | Epic 2 |
| `use-documents.ts` | 文件列表查詢 | Epic 2 |
| `use-document-detail.ts` | 文件詳情查詢 | Epic 2 |
| `use-document-progress.ts` | 文件處理進度追蹤 | Epic 10 |
| `use-document-formats.ts` | 文件格式管理 | Epic 16 |
| `use-batch-progress.ts` | 批次處理進度 | Epic 0 |
| `use-historical-data.ts` | 歷史數據查詢 | Epic 0 |
| `use-historical-file-detail.ts` | 歷史文件詳情 | Epic 0 |
| `use-pdf-preload.ts` | PDF 預載入 | Epic 13 |
| `use-format-analysis.ts` | 格式分析 | Epic 16 |
| `use-format-detail.ts` | 格式詳情 | Epic 16 |
| `use-format-files.ts` | 格式文件列表 | Epic 16 |

### 2. 審核與升級 (Review & Escalation) - 7 個

| Hook | 說明 | Epic |
|------|------|------|
| `useApproveReview.ts` | 審核批准 | Epic 3 |
| `useReviewDetail.ts` | 審核詳情 | Epic 3 |
| `useReviewQueue.ts` | 審核佇列 | Epic 3 |
| `useEscalateReview.ts` | 升級審核 | Epic 3 |
| `useEscalationDetail.ts` | 升級詳情 | Epic 3 |
| `useEscalationList.ts` | 升級列表 | Epic 3 |
| `useResolveEscalation.ts` | 解決升級 | Epic 3 |

### 3. 規則管理 (Rules & Mapping) - 12 個

| Hook | 說明 | Epic |
|------|------|------|
| `useCreateRule.ts` | 建立規則 | Epic 4 |
| `useRuleApprove.ts` | 規則批准 | Epic 4 |
| `useRuleDetail.ts` | 規則詳情 | Epic 4 |
| `useRuleEdit.ts` | 規則編輯 | Epic 4 |
| `useRuleList.ts` | 規則列表 | Epic 4 |
| `useRulePreview.ts` | 規則預覽 | Epic 4 |
| `useRuleReject.ts` | 規則拒絕 | Epic 4 |
| `useRuleTest.ts` | 規則測試 | Epic 4 |
| `useRuleVersion.ts` | 規則版本 | Epic 4 |
| `useTestRule.ts` | 測試規則 | Epic 4 |
| `useSuggestionDetail.ts` | 建議詳情 | Epic 4 |
| `useSuggestionList.ts` | 建議列表 | Epic 4 |

### 4. 公司管理 (Company/Forwarder) - 8 個

| Hook | 說明 | Epic |
|------|------|------|
| `use-companies.ts` | 公司列表查詢 | Epic 5 |
| `use-company-detail.ts` | 公司詳情 | Epic 5 |
| `use-company-formats.ts` | 公司格式配置 | Epic 16 |
| `use-pending-companies.ts` | 待處理公司 | Epic 5 |
| `useCompanyList.ts` | 公司列表（舊版） | Epic 5 |
| `use-forwarder-detail.ts` | Forwarder 詳情（deprecated） | Epic 5 |
| `use-forwarders.ts` | Forwarder 列表（deprecated） | Epic 5 |
| `useForwarderList.ts` | Forwarder 列表（deprecated） | Epic 5 |

> **注意**: `forwarder` 相關 Hook 因 REFACTOR-001 已被 `company` 系列取代

### 5. 城市與區域 (City & Region) - 5 個

| Hook | 說明 | Epic |
|------|------|------|
| `use-cities.ts` | 城市列表 | Epic 6 |
| `use-accessible-cities.ts` | 可存取城市（權限） | Epic 6 |
| `useCityFilter.ts` | 城市篩選器 | Epic 6 |
| `useUserCity.ts` | 用戶城市設定 | Epic 6 |
| `use-regions.ts` | 區域管理 | Epic 20 |

### 6. 儀表板與統計 (Dashboard & Statistics) - 6 個

| Hook | 說明 | Epic |
|------|------|------|
| `useDashboardStatistics.ts` | 儀表板統計數據 | Epic 7 |
| `useProcessingStats.ts` | 處理統計 | Epic 7 |
| `use-accuracy.ts` | 準確度統計 | Epic 7 |
| `use-city-cost-report.ts` | 城市成本報表 | Epic 7 |
| `useCityCost.ts` | 城市成本查詢 | Epic 7 |
| `use-monthly-report.ts` | 月度報表 | Epic 7 |

### 7. 審計與追蹤 (Audit & Tracking) - 5 個

| Hook | 說明 | Epic |
|------|------|------|
| `useAuditQuery.ts` | 審計查詢 | Epic 8 |
| `useAuditReports.ts` | 審計報表 | Epic 8 |
| `useChangeHistory.ts` | 變更歷史 | Epic 8 |
| `useTraceability.ts` | 可追溯性 | Epic 8 |
| `useVersions.ts` | 版本記錄 | Epic 8 |

### 8. 系統管理 (System & Admin) - 11 個

| Hook | 說明 | Epic |
|------|------|------|
| `use-system-config.ts` | 系統配置 | Epic 12 |
| `use-health-monitoring.ts` | 健康監控 | Epic 12 |
| `use-performance.ts` | 效能監控 | Epic 12 |
| `use-alerts.ts` | 警報查詢 | Epic 12 |
| `useAlerts.ts` | 警報操作 | Epic 12 |
| `useAlertRules.ts` | 警報規則 | Epic 12 |
| `use-backup.ts` | 備份操作 | Epic 12 |
| `use-backup-schedule.ts` | 備份排程 | Epic 12 |
| `use-restore.ts` | 還原操作 | Epic 12 |
| `use-rollback.ts` | 回滾操作 | Epic 12 |
| `use-logs.ts` | 系統日誌 | Epic 12 |
| `useRetention.ts` | 資料保留 | Epic 12 |

### 9. 用戶與權限 (Auth & Users) - 3 個

| Hook | 說明 | Epic |
|------|------|------|
| `use-auth.ts` | 認證狀態 | Epic 1 |
| `use-users.ts` | 用戶管理 | Epic 1 |
| `use-roles.ts` | 角色管理 | Epic 1 |

### 10. 外部整合 (External Integration) - 7 個

| Hook | 說明 | Epic |
|------|------|------|
| `use-n8n-health.ts` | n8n 健康狀態 | Epic 10 |
| `use-outlook-config.ts` | Outlook 配置 | Epic 9 |
| `use-sharepoint-config.ts` | SharePoint 配置 | Epic 9 |
| `use-webhook-config.ts` | Webhook 配置 | Epic 11 |
| `useWorkflowError.ts` | 工作流錯誤 | Epic 10 |
| `useWorkflowExecutions.ts` | 工作流執行 | Epic 10 |
| `useWorkflowTrigger.ts` | 工作流觸發 | Epic 10 |

### 11. 配置管理 (Config & Prompt) - 3 個

| Hook | 說明 | Epic |
|------|------|------|
| `use-prompt-configs.ts` | Prompt 配置 | Epic 14 |
| `use-field-mapping-configs.ts` | 欄位映射配置 | Epic 13 |
| `use-pipeline-configs.ts` | 管線配置 | CHANGE-032 |

### 12. 術語與影響分析 (Term & Impact) - 5 個

| Hook | 說明 | Epic |
|------|------|------|
| `use-term-analysis.ts` | 術語分析 | Epic 4 |
| `use-term-aggregation.ts` | 術語聚合 | Epic 0 |
| `useImpactAnalysis.ts` | 影響分析 | Epic 4 |
| `useSaveCorrections.ts` | 儲存修正 | Epic 3 |
| `useSimulation.ts` | 規則模擬 | Epic 4 |

### 13. 模板管理 (Template Management) - 4 個

| Hook | 說明 | Epic |
|------|------|------|
| `use-data-templates.ts` | 資料模板 | Epic 19 |
| `use-template-field-mappings.ts` | 模板欄位映射 | Epic 19 |
| `use-template-instances.ts` | 模板實例 | Epic 19 |
| `use-field-label.ts` | 欄位標籤解析 | Epic 19 |

### 14. 參考編號與匯率 (Reference Number & Exchange Rate) - 2 個

| Hook | 說明 | Epic |
|------|------|------|
| `use-reference-numbers.ts` | 參考編號管理 | Epic 20 |
| `use-exchange-rates.ts` | 匯率管理 | Epic 21 |

### 15. i18n 與本地化 (Internationalization) - 5 個

| Hook | 說明 | Epic |
|------|------|------|
| `use-locale-preference.ts` | 語言偏好管理 | Epic 17 |
| `use-localized-date.ts` | 本地化日期 | Epic 17 |
| `use-localized-format.ts` | 本地化格式 | Epic 17 |
| `use-localized-toast.ts` | 本地化提示 | Epic 17 |
| `use-localized-zod.ts` | 本地化 Zod 驗證 | Epic 17 |

### 16. UI 工具 (UI Utilities) - 4 個

| Hook | 說明 | Epic |
|------|------|------|
| `use-debounce.ts` | 防抖動（kebab-case） | - |
| `useDebounce.ts` | 防抖動（camelCase） | - |
| `useMediaQuery.ts` | 媒體查詢 | - |
| `use-toast.ts` | Toast 提示 | - |

### 17. AI 成本 (AI Cost) - 1 個

| Hook | 說明 | Epic |
|------|------|------|
| `useAiCost.ts` | AI 成本追蹤 | Epic 7 |

---

## Hook 設計模式

### 標準 Query Hook

```typescript
import { useQuery } from '@tanstack/react-query';

export function useDocuments(filters: DocumentFilters) {
  return useQuery({
    queryKey: ['documents', filters],
    queryFn: () => fetch(`/api/documents?${params}`).then(r => r.json()),
  });
}
```

### 標準 Mutation Hook

```typescript
import { useMutation, useQueryClient } from '@tanstack/react-query';

export function useCreateRule() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateRuleInput) => fetch('/api/rules', { method: 'POST', body: JSON.stringify(data) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['rules'] }),
  });
}
```

---

## 新增 Hook 指南

1. **使用 kebab-case 命名**: `use-feature-name.ts`
2. **添加 JSDoc 頭部註釋**
3. **使用 React Query** 管理伺服器狀態
4. **類型安全**: 定義完整的輸入/輸出類型
5. **更新本文檔**: 將新 Hook 加入對應分類

---

## 相關文檔

- [CLAUDE.md (根目錄)](../../CLAUDE.md) - 項目總指南
- [src/types/](../types/) - 類型定義
- [src/app/api/](../app/api/) - API 端點（Hook 對應的後端）

---

**維護者**: Development Team
**最後更新**: 2026-02-09
**版本**: 1.0.0
