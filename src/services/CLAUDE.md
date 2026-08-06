# Services 目錄 - 業務邏輯服務層

> **服務數量**: **209** 服務文件
> **子目錄數量**: 13 個子目錄（含巢狀更多）
> **LLM 模型**: 🔴 全部 LLM 環節使用 `gpt-5.6-luna`（CHANGE-115）—— 本文件各處提到的
> GPT-5.2 / GPT-5-nano 皆為**歷史記載**，實際模型由 `LlmModelConfigService.getStageModel()` 執行時解析
> **最後更新**: 2026-08-06（重新計數；標註 CHANGE-115 模型切換）
> **版本**: 2.2.0
> **深度分析**: `docs/06-codebase-analyze/02-module-mapping/services-overview.md`

---

## 概述

本目錄包含所有業務邏輯服務，是項目的核心處理層。服務層遵循以下原則：
- **單一職責**: 每個服務專注於特定業務領域
- **依賴注入**: 透過 Prisma Client 和其他服務進行依賴
- **類型安全**: 完整的 TypeScript 類型定義
- **錯誤處理**: 統一的錯誤處理模式

---

## 目錄結構總覽

```
src/services/
├── *.ts (108 個根層級服務文件)
├── extraction-v3/          # V3 提取管線 (17 files)
│   ├── stages/             # 三階段處理器 (7 files)
│   └── utils/              # 提取工具函數 (4 files)
├── extraction-v2/          # V2 提取服務 (3 files)
├── unified-processor/      # 統一處理器框架 (21 files)
│   ├── steps/              # 處理步驟 (11 files)
│   ├── adapters/           # 適配器 (7 files)
│   ├── factory/            # 工廠 (1 file)
│   └── interfaces/         # 介面定義 (1 file)
├── mapping/                # 欄位映射引擎 (6 files)
├── transform/              # 資料轉換引擎 (7 files)
├── prompt/                 # Prompt 子目錄 (1 file)
├── document-processing/    # 文件處理管線步驟 (1 file)
├── n8n/                    # n8n 工作流整合 (9 files)
├── logging/                # 日誌服務 (2 files)
├── similarity/             # 相似度計算 (3 files)
├── rule-inference/         # 規則推斷引擎 (3 files)
└── identification/         # 文件發行方識別 (1 file)
```

---

## 服務分類

### 1. 核心處理服務 (Core Processing)

| 服務 | 說明 | Epic |
|------|------|------|
| `document.service.ts` | 文件 CRUD 操作 | Epic 2 |
| `extraction.service.ts` | 欄位提取服務 | Epic 2 |
| `batch-processor.service.ts` | 批次處理引擎 | Epic 0 |
| `batch-progress.service.ts` | 批次進度追蹤 | Epic 0 |
| `processing-router.service.ts` | 智能處理路由 | Epic 0 |
| `processing-result-persistence.service.ts` | 處理結果持久化 | Epic 0 |
| `document-progress.service.ts` | 文件處理進度 | Epic 2 |
| `document-source.service.ts` | 文件來源管理 | Epic 9 |
| `document-format.service.ts` | 文件格式處理 | Epic 0 |
| `document-issuer.service.ts` | 文件發行方識別 | Epic 0 |
| `result-retrieval.service.ts` | 結果檢索服務 | Epic 2 |

### 2. AI/OCR 服務 (AI & OCR)

| 服務 | 說明 | Epic |
|------|------|------|
| `gpt-vision.service.ts` | Azure OpenAI Vision 處理（`gpt-5.6-luna`） | Epic 2 |
| `azure-di.service.ts` | Azure Document Intelligence | Epic 2 |
| `confidence.service.ts` | 信心度計算 | Epic 2 |
| `term-classification.service.ts` | 術語分類（Tier 3） | Epic 4 |
| `term-aggregation.service.ts` | 術語聚合 | Epic 0 |
| `batch-term-aggregation.service.ts` | 批次術語聚合 | Epic 0 |
| `hierarchical-term-aggregation.service.ts` | 階層術語聚合 | Epic 0 |
| `ai-cost.service.ts` | AI 成本追蹤 | Epic 7 |
| `ai-term-validator.service.ts` | AI 術語驗證器 | Epic 4 |
| `cost-estimation.service.ts` | 成本估算 | Epic 7 |

### 3. 映射與規則服務 (Mapping & Rules)

| 服務 | 說明 | Epic |
|------|------|------|
| `mapping.service.ts` | 三層映射系統核心 | Epic 4 |
| `rule-resolver.ts` | 規則解析器 | Epic 4 |
| `rule-suggestion-generator.ts` | 規則建議生成 | Epic 4 |
| `rule-testing.service.ts` | 規則測試 | Epic 4 |
| `rule-change.service.ts` | 規則變更管理 | Epic 4 |
| `rule-accuracy.ts` | 規則準確度追蹤 | Epic 4 |
| `rule-metrics.ts` | 規則指標 | Epic 4 |
| `rule-simulation.ts` | 規則模擬 | Epic 4 |
| `impact-analysis.ts` | 影響分析 | Epic 4 |
| `pattern-analysis.ts` | 模式分析 | Epic 4 |
| `correction-recording.ts` | 修正記錄 | Epic 3 |
| `auto-rollback.ts` | 自動回滾 | Epic 4 |

**子目錄: `rule-inference/`**
| 服務 | 說明 |
|------|------|
| `keyword-inferrer.ts` | 關鍵字推斷器 |
| `position-inferrer.ts` | 位置推斷器 |
| `regex-inferrer.ts` | 正則推斷器 |

### 4. 公司/Forwarder 管理 (Company/Forwarder)

| 服務 | 說明 | Epic |
|------|------|------|
| `company.service.ts` | 公司 CRUD（重構後） | Epic 5 |
| `company-matcher.service.ts` | 公司匹配器 | Epic 0 |
| `company-auto-create.service.ts` | Just-in-Time 公司創建 | Epic 0 |
| `forwarder.service.ts` | Forwarder 服務（已棄用） | - |
| `forwarder-identifier.ts` | Forwarder 識別 | Epic 5 |
| `file-detection.service.ts` | 文件檢測（公司識別） | Epic 0 |

**子目錄: `identification/`**
| 服務 | 說明 |
|------|------|
| `identification.service.ts` | 文件發行方識別服務 |

> **注意**: `forwarder.service.ts` 因 REFACTOR-001 已被 `company.service.ts` 取代

### 5. 城市與區域 (City & Regional)

| 服務 | 說明 | Epic |
|------|------|------|
| `city.service.ts` | 城市管理 | Epic 6 |
| `city-access.service.ts` | 城市存取控制 | Epic 6 |
| `city-cost.service.ts` | 城市成本統計 | Epic 7 |
| `city-cost-report.service.ts` | 城市成本報表 | Epic 7 |
| `regional-manager.service.ts` | 區域管理員 | Epic 6 |
| `regional-report.service.ts` | 區域報表 | Epic 7 |

### 6. 報表與統計 (Reports & Statistics)

| 服務 | 說明 | Epic |
|------|------|------|
| `dashboard-statistics.service.ts` | 儀表板統計 | Epic 7 |
| `expense-report.service.ts` | 費用報表 | Epic 7 |
| `monthly-cost-report.service.ts` | 月度成本報表 | Epic 7 |
| `audit-report.service.ts` | 審計報表 | Epic 8 |
| `processing-stats.service.ts` | 處理統計 | Epic 7 |
| `historical-accuracy.service.ts` | 歷史準確度 | Epic 7 |

### 7. 審計與追蹤 (Audit & Tracking)

| 服務 | 說明 | Epic |
|------|------|------|
| `audit-log.service.ts` | 審計日誌 | Epic 8 |
| `audit-query.service.ts` | 審計查詢 | Epic 8 |
| `api-audit-log.service.ts` | API 審計日誌 | Epic 11 |
| `change-tracking.service.ts` | 變更追蹤 | Epic 8 |
| `traceability.service.ts` | 可追溯性服務 | Epic 8 |
| `security-log.ts` | 安全日誌 | Epic 8 |

### 8. 審核工作流 (Review Workflow)

| 服務 | 說明 | Epic |
|------|------|------|
| `invoice-submission.service.ts` | 發票提交 | Epic 3 |
| `routing.service.ts` | 審核路由 | Epic 3 |
| `task-status.service.ts` | 任務狀態管理 | Epic 3 |

### 9. 警報與通知 (Alerts & Notifications)

| 服務 | 說明 | Epic |
|------|------|------|
| `alert.service.ts` | 警報服務 | Epic 12 |
| `alert-rule.service.ts` | 警報規則 | Epic 12 |
| `alert-evaluation.service.ts` | 警報評估 | Epic 12 |
| `alert-evaluation-job.ts` | 警報評估任務 | Epic 12 |
| `alert-notification.service.ts` | 警報通知 | Epic 12 |
| `notification.service.ts` | 通知服務 | Epic 12 |

### 10. 備份與資料管理 (Backup & Data)

| 服務 | 說明 | Epic |
|------|------|------|
| `backup.service.ts` | 備份服務 | Epic 12 |
| `backup-scheduler.service.ts` | 備份排程 | Epic 12 |
| `restore.service.ts` | 還原服務 | Epic 12 |
| `data-retention.service.ts` | 資料保留策略 | Epic 12 |
| `encryption.service.ts` | 加密服務 | Epic 8 |

### 11. 外部整合 (External Integration)

**Outlook 整合**
| 服務 | 說明 | Epic |
|------|------|------|
| `outlook-mail.service.ts` | Outlook 郵件 | Epic 9 |
| `outlook-document.service.ts` | Outlook 文件 | Epic 9 |
| `outlook-config.service.ts` | Outlook 配置 | Epic 9 |
| `microsoft-graph.service.ts` | Microsoft Graph API | Epic 9 |

**SharePoint 整合**
| 服務 | 說明 | Epic |
|------|------|------|
| `sharepoint-document.service.ts` | SharePoint 文件 | Epic 9 |
| `sharepoint-config.service.ts` | SharePoint 配置 | Epic 9 |

**Webhook 整合**
| 服務 | 說明 | Epic |
|------|------|------|
| `webhook.service.ts` | Webhook 管理 | Epic 11 |
| `webhook-event-trigger.ts` | Webhook 事件觸發 | Epic 11 |

**子目錄: `n8n/`** (Epic 10)
| 服務 | 說明 |
|------|------|
| `n8n-api-key.service.ts` | n8n API 金鑰 |
| `n8n-document.service.ts` | n8n 文件處理 |
| `n8n-health.service.ts` | n8n 健康檢查 |
| `n8n-webhook.service.ts` | n8n Webhook |
| `webhook-config.service.ts` | Webhook 配置 |
| `workflow-definition.service.ts` | 工作流定義 |
| `workflow-error.service.ts` | 工作流錯誤處理 |
| `workflow-execution.service.ts` | 工作流執行 |
| `workflow-trigger.service.ts` | 工作流觸發 |

### 12. 系統管理 (System Management)

| 服務 | 說明 | Epic |
|------|------|------|
| `health-check.service.ts` | 健康檢查 | Epic 12 |
| `system-config.service.ts` | 系統配置 | Epic 12 |
| `performance.service.ts` | 效能監控 | Epic 12 |
| `performance-collector.service.ts` | 效能收集器 | Epic 12 |
| `global-admin.service.ts` | 全域管理員 | Epic 12 |
| `example-generator.service.ts` | 範例生成器 | Epic 4 |
| `openapi-loader.service.ts` | OpenAPI 載入器 | Epic 11 |

### 13. 用戶與權限 (User & Auth)

| 服務 | 說明 | Epic |
|------|------|------|
| `user.service.ts` | 用戶管理 | Epic 1 |
| `role.service.ts` | 角色管理 | Epic 1 |
| `api-key.service.ts` | API 金鑰管理 | Epic 11 |
| `rate-limit.service.ts` | 速率限制 | Epic 11 |

### 14. 工具服務 (Utility Services)

**子目錄: `logging/`**
| 服務 | 說明 |
|------|------|
| `logger.service.ts` | 日誌記錄器 |
| `log-query.service.ts` | 日誌查詢 |

**子目錄: `similarity/`**
| 服務 | 說明 |
|------|------|
| `levenshtein.ts` | Levenshtein 距離 |
| `date-similarity.ts` | 日期相似度 |
| `numeric-similarity.ts` | 數值相似度 |

### 15. V3 提取管線 (Extraction V3 Pipeline) - Epic 15

> **架構**: 三階段提取管線 (3-Stage Pipeline)
> **檔案總數**: 20 個服務文件（6 核心 + 8 stages + 5 utils + index）

**核心服務**
| 服務 | 說明 |
|------|------|
| `extraction-v3.service.ts` | V3 提取主服務入口 |
| `unified-gpt-extraction.service.ts` | 統一 GPT 提取 |
| `confidence-v3.service.ts` | V3 信心度計算 |
| `confidence-v3-1.service.ts` | V3.1 信心度計算（最新版） |
| `result-validation.service.ts` | 結果驗證服務 |
| `prompt-assembly.service.ts` | Prompt 組裝服務 |

**子目錄: `extraction-v3/stages/`** - 三階段處理器
| 服務 | 說明 |
|------|------|
| `stage-orchestrator.service.ts` | 階段協調器（管理 Stage 1→2→3 流程） |
| `stage-1-company.service.ts` | Stage 1: 公司識別 |
| `stage-2-format.service.ts` | Stage 2: 格式匹配 |
| `stage-3-extraction.service.ts` | Stage 3: 欄位提取 |
| `gpt-caller.service.ts` | GPT 呼叫器（統一 GPT API 調用） |
| `reference-number-matcher.service.ts` | 參考編號匹配（Epic 20） |
| `exchange-rate-converter.service.ts` | 匯率轉換（Epic 21） |

**子目錄: `extraction-v3/utils/`** - 提取工具函數
| 服務 | 說明 |
|------|------|
| `pdf-converter.ts` | PDF 轉換工具 |
| `prompt-builder.ts` | Prompt 構建器 |
| `prompt-merger.ts` | Prompt 合併器 |
| `variable-replacer.ts` | 變數替換器（支援動態 Prompt 變數） |

### 16. V2 提取服務 (Extraction V2) - Epic 13

> **說明**: V2 版本提取服務，用於文件預覽與欄位映射場景
> **檔案總數**: 3 個服務文件

| 服務 | 說明 |
|------|------|
| `azure-di-document.service.ts` | Azure DI 文件處理 |
| `data-selector.service.ts` | 資料選擇器 |
| `gpt-mini-extractor.service.ts` | GPT Mini 提取器 |

### 17. 統一處理器框架 (Unified Processor) - Epic 0

> **架構**: 步驟導向的文件處理管線，使用工廠模式和適配器模式
> **檔案總數**: 21 個服務文件（1 核心 + 11 步驟 + 7 適配器 + 1 工廠 + 1 介面）

**核心服務**
| 服務 | 說明 |
|------|------|
| `unified-document-processor.service.ts` | 統一文件處理器主服務 |

**子目錄: `unified-processor/steps/`** - 處理步驟
| 服務 | 說明 |
|------|------|
| `azure-di-extraction.step.ts` | Azure DI 提取步驟 |
| `confidence-calculation.step.ts` | 信心度計算步驟 |
| `config-fetching.step.ts` | 配置獲取步驟 |
| `field-mapping.step.ts` | 欄位映射步驟 |
| `file-type-detection.step.ts` | 文件類型偵測步驟 |
| `format-matching.step.ts` | 格式匹配步驟 |
| `gpt-enhanced-extraction.step.ts` | GPT 增強提取步驟 |
| `issuer-identification.step.ts` | 發行方識別步驟 |
| `routing-decision.step.ts` | 路由決策步驟 |
| `smart-routing.step.ts` | 智能路由步驟 |
| `term-recording.step.ts` | 術語記錄步驟 |

**子目錄: `unified-processor/adapters/`** - 適配器
| 服務 | 說明 |
|------|------|
| `confidence-calculator-adapter.ts` | 信心度計算適配器 |
| `config-fetcher-adapter.ts` | 配置獲取適配器 |
| `format-matcher-adapter.ts` | 格式匹配適配器 |
| `issuer-identifier-adapter.ts` | 發行方識別適配器 |
| `legacy-processor.adapter.ts` | 舊版處理器適配器 |
| `routing-decision-adapter.ts` | 路由決策適配器 |
| `term-recorder-adapter.ts` | 術語記錄適配器 |

**子目錄: `unified-processor/factory/`** - 工廠
| 服務 | 說明 |
|------|------|
| `step-factory.ts` | 步驟工廠（動態建立處理步驟） |

**子目錄: `unified-processor/interfaces/`** - 介面定義
| 服務 | 說明 |
|------|------|
| `step-handler.interface.ts` | 步驟處理器介面 |

### 18. 欄位映射與資料轉換 (Mapping & Transform) - Epic 16/19

> **說明**: 欄位映射引擎與資料轉換管線，支援多種轉換策略
> **檔案總數**: 13 個服務文件（mapping 6 + transform 7）

**子目錄: `mapping/`** - 欄位映射引擎
| 服務 | 說明 |
|------|------|
| `config-resolver.ts` | 映射配置解析器 |
| `dynamic-mapping.service.ts` | 動態映射服務 |
| `field-mapping-engine.ts` | 欄位映射引擎核心 |
| `mapping-cache.ts` | 映射快取 |
| `source-field.service.ts` | 來源欄位服務 |
| `transform-executor.ts` | 映射轉換執行器 |

**子目錄: `transform/`** - 資料轉換引擎
| 服務 | 說明 |
|------|------|
| `types.ts` | 轉換類型定義 |
| `transform-executor.ts` | 轉換執行器核心 |
| `direct.transform.ts` | 直接映射轉換 |
| `concat.transform.ts` | 串接轉換 |
| `split.transform.ts` | 分割轉換 |
| `formula.transform.ts` | 公式轉換 |
| `lookup.transform.ts` | 查詢轉換 |

### 19. Prompt 管理系統 (Prompt Management) - Epic 14

> **說明**: 完整的 Prompt 配置、解析、快取與動態生成系統
> **檔案總數**: 9 個服務文件（8 根層級 + 1 子目錄）

**根層級 Prompt 服務**
| 服務 | 說明 | Epic |
|------|------|------|
| `prompt-resolver.service.ts` | Prompt 解析器服務 | Epic 14 |
| `prompt-resolver.factory.ts` | Prompt 解析器工廠 | Epic 14 |
| `prompt-cache.service.ts` | Prompt 快取服務 | Epic 14 |
| `prompt-merge-engine.service.ts` | Prompt 合併引擎 | Epic 14 |
| `prompt-variable-engine.service.ts` | Prompt 變數引擎 | Epic 14 |
| `hybrid-prompt-provider.service.ts` | 混合 Prompt 提供者 | Epic 14 |
| `prompt-provider.interface.ts` | Prompt 提供者介面 | Epic 14 |
| `static-prompts.ts` | 靜態 Prompt 定義 | Epic 14 |

**子目錄: `prompt/`**
| 服務 | 說明 |
|------|------|
| `identification-rules-prompt-builder.ts` | 識別規則 Prompt 構建器 |

**子目錄: `document-processing/`**
| 服務 | 說明 |
|------|------|
| `mapping-pipeline-step.ts` | 映射管線步驟 |

### 20. 模板管理 (Template Management) - Epic 19

> **說明**: 資料模板匹配與匯出系統，包含自動匹配引擎

| 服務 | 說明 | Epic |
|------|------|------|
| `data-template.service.ts` | 資料模板 CRUD | Epic 19 |
| `template-field-mapping.service.ts` | 模板欄位映射 | Epic 19 |
| `template-instance.service.ts` | 模板實例管理 | Epic 19 |
| `template-matching-engine.service.ts` | 模板匹配引擎 | Epic 19 |
| `template-export.service.ts` | 模板匯出服務（Excel） | Epic 19 |
| `auto-template-matching.service.ts` | 自動模板匹配 | Epic 19 |

### 21. 參考編號與匯率管理 (Reference Number & Exchange Rate) - Epic 20/21

> **說明**: 參考編號主檔管理、區域管理、匯率管理

| 服務 | 說明 | Epic |
|------|------|------|
| `reference-number.service.ts` | 參考編號 CRUD 與驗證 | Epic 20 |
| `region.service.ts` | 區域管理（參考編號歸屬） | Epic 20 |
| `exchange-rate.service.ts` | 匯率 CRUD 與換算 | Epic 21 |

### 22. 管線配置 (Pipeline Configuration) - CHANGE-032

> **說明**: V3 提取管線的功能開關與配置管理

| 服務 | 說明 | Epic |
|------|------|------|
| `pipeline-config.service.ts` | 管線配置 CRUD（參考編號匹配/匯率轉換開關） | CHANGE-032 |


---

## 服務設計模式

### 標準服務結構

```typescript
/**
 * @fileoverview [服務功能描述]
 * @module src/services/[service-name]
 * @since Epic X - Story X.X
 */

import { prisma } from '@/lib/prisma';
import { ServiceError } from '@/lib/errors';

export class ExampleService {
  /**
   * [方法功能描述]
   * @param input - 輸入參數
   * @returns 返回結果
   * @throws ServiceError
   */
  async methodName(input: InputType): Promise<OutputType> {
    try {
      // 業務邏輯
    } catch (error) {
      throw new ServiceError('操作失敗', { cause: error });
    }
  }
}

// 單例導出
export const exampleService = new ExampleService();
```

### 三層映射系統架構

```
┌─────────────────────────────────────────────────────────────────┐
│ Tier 1: Universal Mapping                                       │
│ → mapping.service.ts (universalMappings)                        │
├─────────────────────────────────────────────────────────────────┤
│ Tier 2: Company-Specific Override                               │
│ → mapping.service.ts (companyMappings)                          │
├─────────────────────────────────────────────────────────────────┤
│ Tier 3: LLM Classification                                      │
│ → term-classification.service.ts (gpt-5.6-luna)                 │
└─────────────────────────────────────────────────────────────────┘
```

### 信心度路由

```
confidence.service.ts
├─ ≥ 90%  → AUTO_APPROVE
├─ 70-89% → QUICK_REVIEW
└─ < 70%  → FULL_REVIEW
```

### V3 提取管線三階段架構

```
extraction-v3.service.ts（入口）
│
├── Stage 1: 公司識別 (stage-1-company.service.ts)
│   └── 識別文件所屬公司
│
├── Stage 2: 格式匹配 (stage-2-format.service.ts)
│   └── 匹配文件格式模板
│
└── Stage 3: 欄位提取 (stage-3-extraction.service.ts)
    ├── GPT 欄位提取 (gpt-caller.service.ts)
    ├── 參考編號匹配 (reference-number-matcher.service.ts)
    └── 匯率轉換 (exchange-rate-converter.service.ts)
```

### 統一處理器管線架構

```
unified-document-processor.service.ts（入口）
│
├── step-factory.ts → 動態建立處理步驟
│
├── 處理步驟（按順序執行）
│   ├── config-fetching.step.ts
│   ├── file-type-detection.step.ts
│   ├── azure-di-extraction.step.ts
│   ├── issuer-identification.step.ts
│   ├── format-matching.step.ts
│   ├── smart-routing.step.ts
│   ├── routing-decision.step.ts
│   ├── gpt-enhanced-extraction.step.ts
│   ├── field-mapping.step.ts
│   ├── confidence-calculation.step.ts
│   └── term-recording.step.ts
│
└── 適配器層（橋接步驟與現有服務）
    ├── config-fetcher-adapter.ts
    ├── issuer-identifier-adapter.ts
    ├── format-matcher-adapter.ts
    ├── routing-decision-adapter.ts
    ├── confidence-calculator-adapter.ts
    ├── term-recorder-adapter.ts
    └── legacy-processor.adapter.ts
```

---

## 服務間依賴

### 核心依賴圖

```
batch-processor.service.ts
├── processing-router.service.ts
│   ├── azure-di.service.ts (OCR)
│   └── gpt-vision.service.ts (Vision)
├── company-matcher.service.ts
│   └── company.service.ts
├── mapping.service.ts
│   ├── confidence.service.ts
│   └── term-classification.service.ts
└── batch-progress.service.ts
```

### 審計依賴

```
audit-log.service.ts
├── change-tracking.service.ts
├── traceability.service.ts
└── security-log.ts
```

### V3 提取管線依賴圖

```
extraction-v3.service.ts
├── stages/stage-orchestrator.service.ts
│   ├── stage-1-company.service.ts
│   │   └── company.service.ts
│   ├── stage-2-format.service.ts
│   │   └── document-format.service.ts
│   └── stage-3-extraction.service.ts
│       ├── gpt-caller.service.ts
│       │   └── Azure OpenAI SDK
│       ├── reference-number-matcher.service.ts
│       │   └── reference-number.service.ts
│       └── exchange-rate-converter.service.ts
│           └── exchange-rate.service.ts
├── prompt-assembly.service.ts
│   ├── prompt-resolver.service.ts
│   └── utils/prompt-builder.ts
├── confidence-v3-1.service.ts
└── result-validation.service.ts
```

### Prompt 系統依賴圖

```
hybrid-prompt-provider.service.ts
├── prompt-resolver.service.ts
│   └── prompt-resolver.factory.ts
├── prompt-cache.service.ts
├── prompt-merge-engine.service.ts
├── prompt-variable-engine.service.ts
└── static-prompts.ts
```

### 模板管理依賴圖

```
auto-template-matching.service.ts
├── template-matching-engine.service.ts
├── data-template.service.ts
├── template-field-mapping.service.ts
└── template-instance.service.ts
    └── template-export.service.ts
```

---

## 新增服務指南

1. **確定分類**: 根據業務領域選擇正確的分類（參考上方 22 個分類）
2. **命名規範**: 使用 `[功能].service.ts` 格式
3. **文件頭部**: 必須包含標準 JSDoc 註釋
4. **更新 index.ts**: 在對應目錄的 `index.ts` 中導出新服務
5. **更新本文檔**: 將新服務加入對應分類表格
6. **子目錄**: 如新增子目錄，需建立 `index.ts` 並統一導出

---

## 相關文檔

- [CLAUDE.md (根目錄)](../../CLAUDE.md) - 項目總指南
- [.claude/rules/services.md](../../.claude/rules/services.md) - 服務開發規範
- [docs/02-architecture/](../../docs/02-architecture/) - 系統架構設計
- [docs/04-implementation/tech-specs/](../../docs/04-implementation/tech-specs/) - 各 Epic 技術規格

---

**維護者**: Development Team
**最後更新**: 2026-02-09
**版本**: 2.0.0
