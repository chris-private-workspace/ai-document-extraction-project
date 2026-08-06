# Messages 目錄 - i18n 翻譯文件

> **語言數量**: 3 種（en, zh-TW, zh-CN）
> **命名空間數量**: **41** 個/語言（共 **123** 個 JSON 文件）
> **最後更新**: 2026-08-06（重新計數；含 CHANGE-089 新增的 7 個命名空間 + `llmProviders`）
> **版本**: 1.2.0
> **深度分析**: `docs/06-codebase-analyze/06-i18n-analysis/i18n-coverage.md`

---

## 概述

本目錄包含所有 next-intl 翻譯文件。每種語言一個子目錄，每個子目錄包含相同的命名空間 JSON 文件。新增/修改翻譯時**必須同步更新所有 3 種語言**。

---

## 目錄結構

```
messages/
├── en/              # English（預設語言，fallback）
│   ├── common.json
│   ├── navigation.json
│   ├── ... (共 41 個 JSON)
│   └── systemSettings.json
├── zh-TW/           # 繁體中文（主要目標語言）
│   └── (同 en/)
└── zh-CN/           # 简体中文
    └── (同 en/)
```

---

## 命名空間完整列表（41 個）

> 🔴 **權威來源是 `src/i18n/request.ts` 的 `namespaces` 陣列**，不是本清單。新增命名空間時
> 兩處都要改，且以該陣列為準（`npm run i18n:check` 依它 gate）。
>
> **實際命名空間清單**（2026-08-06 由 `request.ts` 核對，依註冊順序）：
> `common, navigation, dialogs, auth, validation, errors, dashboard, global, escalation, review,
> documents, rules, companies, reports, admin, historicalData, termAnalysis, documentPreview,
> fieldMappingConfig, promptConfig, dataTemplates, formats, templateFieldMapping, templateInstance,
> templateMatchingTest, standardFields, referenceNumber, confidence, exchangeRate, region,
> pipelineConfig, fieldDefinitionSet, profile, systemSettings, documentSource, dataRetention,
> integrations, changeHistory, ruleSimulation, cityAccess, llmProviders`
>
> **相對於原 34 個新增 7 個**：CHANGE-089 的 `documentSource`、`dataRetention`、`integrations`、
> `changeHistory`、`ruleSimulation`、`cityAccess`，以及 Epic 23 的 `llmProviders`

### 通用基礎（6 個）

| 命名空間 | 說明 | 使用場景 |
|----------|------|----------|
| `common` | 通用詞彙（按鈕、狀態、操作） | 全域共用 |
| `navigation` | 側邊欄、頂欄、麵包屑 | 佈局組件 |
| `dialogs` | 確認對話框、提示訊息 | 全域共用 |
| `auth` | 登入、登出、認證相關 | 認證頁面 |
| `validation` | 表單驗證錯誤訊息 | 所有表單 |
| `errors` | API/系統錯誤訊息 | 錯誤處理 |

### 儀表板與統計（3 個）

| 命名空間 | 說明 | Epic |
|----------|------|------|
| `dashboard` | 儀表板統計卡片、圖表 | Epic 7 |
| `global` | 全域統計 | Epic 7 |
| `confidence` | 信心度相關顯示 | Epic 2 |

### 文件處理（3 個）

| 命名空間 | 說明 | Epic |
|----------|------|------|
| `documents` | 文件列表、詳情、上傳 | Epic 2 |
| `documentPreview` | 文件預覽功能 | Epic 13 |
| `historicalData` | 歷史數據管理 | Epic 0 |

### 審核與升級（2 個）

| 命名空間 | 說明 | Epic |
|----------|------|------|
| `review` | 審核佇列、審核操作 | Epic 3 |
| `escalation` | 升級流程 | Epic 3 |

### 規則與映射（4 個）

| 命名空間 | 說明 | Epic |
|----------|------|------|
| `rules` | 映射規則管理 | Epic 4 |
| `fieldMappingConfig` | 欄位映射配置 | Epic 13 |
| `termAnalysis` | 術語分析 | Epic 4 |
| `standardFields` | 標準欄位定義 | Epic 16 |

### 公司與格式（3 個）

| 命名空間 | 說明 | Epic |
|----------|------|------|
| `companies` | 公司管理 | Epic 5 |
| `formats` | 文件格式管理 | Epic 16 |
| `promptConfig` | Prompt 配置管理 | Epic 14 |

### 模板管理（3 個）

| 命名空間 | 說明 | Epic |
|----------|------|------|
| `dataTemplates` | 資料模板管理 | Epic 19 |
| `templateFieldMapping` | 模板欄位映射 | Epic 19 |
| `templateInstance` | 模板實例 | Epic 19 |
| `templateMatchingTest` | 模板匹配測試 | Epic 19 |

### 參考編號與匯率（3 個）

| 命名空間 | 說明 | Epic |
|----------|------|------|
| `referenceNumber` | 參考編號管理 | Epic 20 |
| `region` | 區域管理 | Epic 20 |
| `exchangeRate` | 匯率管理 | Epic 21 |

### 系統管理（3 個）

| 命名空間 | 說明 | Epic |
|----------|------|------|
| `admin` | 系統管理頁面 | Epic 12 |
| `reports` | 報表功能 | Epic 7 |
| `pipelineConfig` | 管線配置 | CHANGE-032 |

---

## 重要規則

### 必須同步更新

**新增/修改任何翻譯時，必須同時更新 3 個語言文件**：

```bash
messages/en/<namespace>.json      # 必須
messages/zh-TW/<namespace>.json   # 必須
messages/zh-CN/<namespace>.json   # 必須
```

### 新增命名空間的步驟

1. 建立 `messages/en/<namespace>.json`
2. 建立 `messages/zh-TW/<namespace>.json`
3. 建立 `messages/zh-CN/<namespace>.json`
4. **在 `src/i18n/request.ts` 的 `namespaces` 陣列中加入新命名空間** (容易遺漏!)

### 驗證命令

```bash
npm run i18n:check    # 檢查所有語言文件同步狀態
```

### ICU MessageFormat 轉義

翻譯文字中的 `{` `}` 是保留字符。如需顯示字面值，必須轉義：

| 要顯示 | 寫法 |
|--------|------|
| `{name}` | `'{'name'}'` |
| `${var}` | `$'{'var'}'` |
| `'` | `''` |

---

## 常量與 i18n 映射表

> 修改 TypeScript 常量時必須同步更新對應翻譯

| 常量文件 | i18n 命名空間 | Key 前綴 |
|----------|---------------|----------|
| `src/types/prompt-config.ts` → `PROMPT_TYPES` | `promptConfig` | `types.` |
| `src/lib/document-status.ts` → `DOCUMENT_STATUS` | `common` | `status.` |

> ⚠️ 2026-08-06 核對：原表的 `src/constants/status.ts` / `src/constants/roles.ts` **兩個檔案都不存在**，
> `USER_ROLES` 在 `src/` 中也找不到。完整表格見 `.claude/rules/i18n.md`。

---

## 相關文檔

- [CLAUDE.md (根目錄)](../CLAUDE.md) - 項目總指南（i18n 同步規則章節）
- [.claude/rules/i18n.md](../.claude/rules/i18n.md) - i18n 完整規範
- [src/i18n/](../src/i18n/) - i18n 配置文件
- [src/lib/i18n-*.ts](../src/lib/) - i18n 格式化工具

---

**維護者**: Development Team
**最後更新**: 2026-08-06
**版本**: 1.2.0
