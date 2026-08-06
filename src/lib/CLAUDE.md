# Lib 目錄 - 工具庫與基礎設施

> **文件數量**: **83** 個 `.ts` 文件（含子目錄）
> **子目錄數量**: **17** 個子目錄
> **最後更新**: 2026-08-06（重新計數）
> **版本**: 1.1.0

---

## 概述

本目錄包含跨模組共用的工具庫、基礎設施服務、格式化工具、驗證 Schema 等。與 `src/services/` 的區別：`lib/` 提供通用基礎能力，`services/` 包含具體業務邏輯。

---

## 目錄結構

```
src/lib/
├── *.ts (22 個根層級文件)
├── audit/              # 審計日誌 (2 files)
├── auth/               # 認證工具 (3 files)
├── azure/              # Azure 整合 (2 files)
├── confidence/         # 信心度工具 (4 files)
├── constants/          # 常數定義 (3 files)
├── errors/             # 錯誤定義 (1 file)
├── learning/           # 學習引擎 (3 files)
├── metrics/            # 指標收集 (2 files)
├── middleware/         # 中間件 (1 file)
├── pdf/                # PDF 工具 (2 files)
├── prompts/            # Prompt 模板 (3 files)
├── reports/            # 報表生成 (4 files)
├── routing/            # 路由工具 (3 files)
├── upload/             # 上傳工具 (2 files)
├── utils/              # 字串工具 (1 file)
└── validations/        # Zod 驗證 Schema (7 files) ← 新標準位置
```

---

## 文件分類

### 1. 核心基礎設施 (Core Infrastructure) - 8 個

| 文件 | 說明 | 重要度 |
|------|------|--------|
| `prisma.ts` | Prisma Client 單例 | 🔴 關鍵 |
| `errors.ts` | 統一錯誤類（RFC 7807） | 🔴 關鍵 |
| `utils.ts` | 通用工具（`cn()` 等） | 🔴 關鍵 |
| `db-context.ts` | 資料庫上下文工具 | 🟡 重要 |
| `url-params.ts` | URL 參數工具 | 🟢 輔助 |
| `document-status.ts` | 文件狀態工具 | 🟡 重要 |
| `notification.ts` | 通知工具 | 🟢 輔助 |
| `date-range-utils.ts` | 日期範圍工具 | 🟢 輔助 |

### 2. 認證與安全 (Auth & Security) - 7 個

| 文件 | 說明 |
|------|------|
| `auth.ts` | NextAuth 配置（主要入口） |
| `auth.config.ts` | 認證配置 |
| `auth/index.ts` | Auth 子模組導出 |
| `auth/api-key.service.ts` | API 金鑰驗證 |
| `auth/city-permission.ts` | 城市權限檢查 |
| `password.ts` | 密碼雜湊工具 |
| `token.ts` | JWT Token 工具 |
| `hash.ts` | 通用雜湊工具 |
| `encryption.ts` | 加密/解密工具 |
| `email.ts` | Email 發送工具 |

### 3. i18n 格式化工具 (Internationalization) - 5 個

> **重要**: 這些工具是項目 i18n 系統的核心，請參考 `.claude/rules/i18n.md`

| 文件 | 說明 | 使用方式 |
|------|------|----------|
| `i18n-date.ts` | 日期格式化 | `formatShortDate(date, locale)` |
| `i18n-number.ts` | 數字格式化 | `formatNumber(value, locale)` |
| `i18n-currency.ts` | 貨幣格式化 | `formatCurrency(value, currency, locale)` |
| `i18n-zod.ts` | Zod 驗證國際化 | `createLocalizedErrorMap(locale)` |
| `i18n-api-error.ts` | API 錯誤國際化 | `localizeApiError(error, locale)` |

### 4. 信心度計算 (Confidence) - `confidence/`

| 文件 | 說明 |
|------|------|
| `calculator.ts` | 信心度計算器 |
| `utils.ts` | 信心度工具函數 |
| `thresholds.ts` | 閾值常數定義 |
| `index.ts` | 導出 |

### 5. Azure 整合 (Azure) - `azure/`

| 文件 | 說明 |
|------|------|
| `storage.ts` | Azure Blob Storage 客戶端 |
| `index.ts` | 導出 |

> **另見**: `azure-blob.ts`（根層級，舊版 Blob 工具）

### 6. 常數定義 (Constants) - `constants/`

| 文件 | 說明 |
|------|------|
| `api-auth.ts` | API 認證相關常數 |
| `error-types.ts` | 錯誤類型常數（RFC 7807 type URLs） |
| `source-types.ts` | 文件來源類型常數 |

### 7. 報表生成 (Reports) - `reports/`

| 文件 | 說明 |
|------|------|
| `excel-generator.ts` | Excel 報表生成器 |
| `excel-i18n.ts` | Excel 國際化工具 |
| `pdf-generator.ts` | PDF 報表生成器 |
| `hierarchical-terms-excel.ts` | 階層術語 Excel 匯出 |
| `index.ts` | 導出 |

### 8. 學習引擎 (Learning) - `learning/`

| 文件 | 說明 |
|------|------|
| `correctionAnalyzer.ts` | 修正分析器 |
| `ruleSuggestionTrigger.ts` | 規則建議觸發器 |
| `index.ts` | 導出 |

### 9. Prompt 模板 (Prompts) - `prompts/`

| 文件 | 說明 |
|------|------|
| `extraction-prompt.ts` | 提取 Prompt 模板 |
| `optimized-extraction-prompt.ts` | 優化版提取 Prompt |
| `index.ts` | 導出 |

### 10. PDF 工具 (PDF) - `pdf/`

| 文件 | 說明 |
|------|------|
| `coordinate-transform.ts` | PDF 座標轉換 |
| `index.ts` | 導出 |

### 11. 其他子目錄

| 子目錄 | 文件 | 說明 |
|--------|------|------|
| `audit/` | `logger.ts`, `index.ts` | 審計日誌記錄器 |
| `errors/` | `prompt-resolution-errors.ts` | Prompt 解析錯誤定義 |
| `metrics/` | `prompt-metrics.ts`, `index.ts` | Prompt 效能指標 |
| `middleware/` | `n8n-api.middleware.ts` | n8n API 中間件 |
| `routing/` | `config.ts`, `router.ts`, `index.ts` | 信心度路由配置 |
| `upload/` | `index.ts`, `constants.ts` | 文件上傳工具 |
| `utils/` | `string.ts` | 字串工具函數 |

---

## Validations 子目錄 - Zod 驗證 Schema

> **遷移說明**: Zod Schema 正從 `src/validations/`（舊位置）遷移到 `src/lib/validations/`（新標準位置）。新增 Schema 應放在此處。

```
src/lib/validations/
├── exchange-rate.schema.ts      # 匯率驗證 (Epic 21)
├── outlook-config.schema.ts     # Outlook 配置驗證 (Epic 9)
├── pipeline-config.schema.ts    # 管線配置驗證 (CHANGE-032)
├── prompt-config.schema.ts      # Prompt 配置驗證 (Epic 14)
├── reference-number.schema.ts   # 參考編號驗證 (Epic 20)
├── region.schema.ts             # 區域驗證 (Epic 20)
├── role.schema.ts               # 角色驗證 (Epic 1)
└── user.schema.ts               # 用戶驗證 (Epic 1)
```

### Schema 設計模式

```typescript
import { z } from 'zod';

// 建立 Schema
export const createExchangeRateSchema = z.object({
  sourceCurrency: z.string().length(3),
  targetCurrency: z.string().length(3),
  rate: z.number().positive(),
  effectiveDate: z.coerce.date(),
});

// 導出推導類型
export type CreateExchangeRateInput = z.infer<typeof createExchangeRateSchema>;
```

---

## 新增文件指南

1. **確定位置**: 通用基礎設施放 `lib/`，業務邏輯放 `services/`
2. **子目錄優先**: 如果功能有多個相關文件，建立子目錄 + `index.ts`
3. **Zod Schema**: 新增驗證 Schema 放在 `lib/validations/`
4. **i18n 工具**: 格式化工具命名為 `i18n-{domain}.ts`
5. **更新本文檔**: 將新文件加入對應分類

---

## 相關文檔

- [CLAUDE.md (根目錄)](../../CLAUDE.md) - 項目總指南
- [.claude/rules/typescript.md](../../.claude/rules/typescript.md) - TypeScript 規範
- [.claude/rules/api-design.md](../../.claude/rules/api-design.md) - API 設計規範（錯誤格式）
- [src/validations/](../validations/) - 舊版 Zod Schema（漸遷至 `lib/validations/`）

---

**維護者**: Development Team
**最後更新**: 2026-02-09
**版本**: 1.0.0
