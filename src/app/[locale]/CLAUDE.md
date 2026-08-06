# App Router 路由結構 — [locale] 動態路由

> **頁面數量**: **85** 個 page.tsx（`(auth)` 6 + `(dashboard)` 76 + docs 2 + 首頁 1）
> **Admin 模組**: **24** 個
> **路由組**: 2 個（`(auth)` + `(dashboard)`）
> **布局層級**: 3 層
> **最後更新**: 2026-08-06（重新計數；補上 2026-02 之後新增的 4 個 admin 模組）
> **版本**: 1.1.0

---

## 概述

本目錄是 Next.js App Router 的核心路由結構，所有使用者可見頁面均在此定義。`[locale]` 動態段負責 i18n 路由（支援 `en`、`zh-TW`、`zh-CN`），透過兩個路由組分離認證頁面與儀表板頁面。

**URL 格式**: `/{locale}/(route-group)/path`
**範例**: `/zh-TW/dashboard`、`/en/admin/companies`、`/zh-CN/auth/login`

---

## 目錄結構

```
src/app/[locale]/
│
├── layout.tsx                          # 🌐 根布局（i18n Provider + HTML lang）
├── page.tsx                            # 首頁
│
├── (auth)/                             # 🔐 認證路由組（6 頁）
│   ├── layout.tsx                      # 置中卡片式布局（無 Sidebar）
│   └── auth/
│       ├── login/page.tsx
│       ├── register/page.tsx
│       ├── forgot-password/page.tsx
│       ├── reset-password/page.tsx
│       ├── verify-email/page.tsx
│       └── error/page.tsx
│
├── (dashboard)/                        # 📊 儀表板路由組（69 頁）
│   ├── layout.tsx                      # Sidebar + TopBar 布局（需認證）
│   ├── dashboard/page.tsx              # 主儀表板
│   │
│   ├── admin/                          # 🛠️ 管理區域（24 模組，見下方索引）
│   │   ├── alerts/
│   │   ├── backup/
│   │   ├── companies/                  # review/ + duplicate-review/
│   │   ├── config/
│   │   ├── data-templates/             # CRUD 模式
│   │   ├── document-preview-test/      # 含 components/ 子目錄
│   │   ├── exchange-rates/             # CRUD 模式
│   │   ├── field-definition-sets/      # CRUD 模式
│   │   ├── field-mapping-configs/      # CRUD 模式
│   │   ├── historical-data/
│   │   ├── integrations/
│   │   ├── llm-providers/              # Epic 23：Provider + models 子頁
│   │   ├── model-settings/             # Epic 23：per-環節模型指派
│   │   ├── monitoring/
│   │   ├── performance/
│   │   ├── pipeline-settings/          # CRUD 模式
│   │   ├── prompt-configs/             # CRUD 模式
│   │   ├── reference-numbers/          # CRUD 模式
│   │   ├── roles/
│   │   ├── settings/
│   │   ├── template-field-mappings/    # CRUD 模式
│   │   ├── term-analysis/
│   │   ├── test/                       # 測試工具（3 頁 + 組件）
│   │   └── users/
│   │
│   ├── audit/query/                    # 審計查詢（含 client.tsx）
│   ├── companies/                      # 公司管理（CRUD + 子路由）
│   ├── documents/                      # 文件處理（列表 + 上傳 + 詳情）
│   ├── escalations/                    # 升級處理
│   ├── global/                         # 全域統計
│   ├── reports/                        # 報表（4 種報表）
│   ├── review/                         # 文件審核
│   ├── profile/                        # 使用者個人設定
│   ├── rollback-history/               # 回滾歷史
│   ├── rules/                          # 映射規則（CRUD + 審核 + 歷史）
│   └── template-instances/             # 模板實例
│
└── docs/                               # 文檔頁面
    ├── page.tsx
    └── examples/page.tsx
```

---

## 路由組說明

### `(auth)` — 認證路由組

| 項目 | 說明 |
|------|------|
| 布局 | 置中卡片式，無 Sidebar/TopBar |
| 權限 | 公開存取（未登入可用） |
| 頁數 | 6 頁 |
| 路徑 | `/{locale}/auth/login` 等 |

### `(dashboard)` — 儀表板路由組

| 項目 | 說明 |
|------|------|
| 布局 | Sidebar（288px）+ TopBar + 內容區（最大 1600px） |
| 權限 | 需認證（NextAuth Session 驗證） |
| 頁數 | **76** 頁 |
| 路徑 | `/{locale}/dashboard`、`/{locale}/admin/*` 等 |

> **注意**: 路由組名稱 `(auth)` 和 `(dashboard)` 不會出現在 URL 中，僅用於布局分離。

### 🔴 幾個容易被忽略、但解決特定問題的頁面

| 路徑 | 用途 | 建立於 |
|------|------|--------|
| `/admin/companies/duplicate-review` | **疑似重複公司人工審核佇列** —— Stage 1 判為灰帶的 PENDING 公司（含 `suspectedDuplicateOfId`）在此裁決：確認為新公司 / 併入疑似目標。CHANGE-103 Phase 2 組件 4 | 2026-07-16 |
| `/admin/companies/review` | 公司資料審核 | — |
| `/admin/model-settings` | per-環節 LLM 模型指派（`StageModelAssignment`） | Epic 23 |
| `/admin/llm-providers` | LLM Provider 與 model 白名單管理 | Epic 23 |

> ⚠️ 本檔曾在 2026-02-09 至 2026-08-06 間未更新，`duplicate-review` 等頁面雖已上線卻未被記載，
> 導致依本檔判斷「功能不存在」。**新增頁面請同步更新本檔**；查功能是否存在時以檔案系統為準。

---

## 布局層級

```
layout.tsx                     # Layer 1: 根布局
├── NextIntlClientProvider     # i18n Provider
├── HTML lang 屬性             # 根據 locale 動態設定
│
├── (auth)/layout.tsx          # Layer 2a: 認證布局
│   └── 置中卡片 + 灰色背景    # 無導航欄
│
└── (dashboard)/layout.tsx     # Layer 2b: 儀表板布局
    ├── Session 驗證            # 未登入重定向到 /auth/login
    ├── Sidebar                 # 左側導航（可收合）
    ├── TopBar                  # 頂部工具列
    └── 主內容區                # max-w-[1600px]
```

---

## Admin 模組索引（20 個）

### CRUD 模式模組（8 個）

遵循標準 `page.tsx`（列表）+ `[id]/page.tsx`（編輯）+ `new/page.tsx`（新建）模式。

| 模組 | 路徑 | 功能 | API 端點 | i18n 命名空間 |
|------|------|------|----------|---------------|
| data-templates | `/admin/data-templates` | 資料模板管理 | `/api/admin/data-templates` | `dataTemplates` |
| exchange-rates | `/admin/exchange-rates` | 匯率管理 | `/api/exchange-rates` | `exchangeRate` |
| field-mapping-configs | `/admin/field-mapping-configs` | 欄位映射配置 | `/api/field-mappings` | `fieldMappingConfig` |
| pipeline-settings | `/admin/pipeline-settings` | 管線配置 | `/api/v1/pipeline-configs` | `pipelineConfig` |
| prompt-configs | `/admin/prompt-configs` | Prompt 配置 | `/api/prompts` | `promptConfig` |
| reference-numbers | `/admin/reference-numbers` | 參考編號管理 | `/api/reference-numbers` | `referenceNumber` |
| template-field-mappings | `/admin/template-field-mappings` | 模板欄位映射 | `/api/admin/template-field-mappings` | `templateFieldMapping` |

### 單頁模組（9 個）

| 模組 | 路徑 | 功能 | API 端點 | i18n 命名空間 |
|------|------|------|----------|---------------|
| alerts | `/admin/alerts` | 系統警報管理 | `/api/admin/alerts` | `admin` |
| backup | `/admin/backup` | 備份與恢復 | `/api/admin/backups` | `admin` |
| config | `/admin/config` | 系統配置 | `/api/admin/config` | `admin` |
| integrations | `/admin/integrations/outlook` | Outlook 整合 | `/api/admin/integrations` | `admin` |
| monitoring | `/admin/monitoring/health` | 健康監控 | `/api/admin/health` | `admin` |
| performance | `/admin/performance` | 效能監控 | `/api/admin/performance` | `admin` |
| roles | `/admin/roles` | 角色管理 | `/api/roles` | `admin` |
| term-analysis | `/admin/term-analysis` | 術語分析 | `/api/rules` | `termAnalysis` |
| users | `/admin/users` | 用戶管理 | `/api/admin/users` | `admin` |

### 特殊模組（3 個）

| 模組 | 路徑 | 功能 | 備註 |
|------|------|------|------|
| companies | `/admin/companies/review` | 公司審核 | 含 `company-review-content.tsx` Client 組件 |
| historical-data | `/admin/historical-data` | 歷史數據管理 | 列表 + `files/[fileId]` 檔案詳情 |
| document-preview-test | `/admin/document-preview-test` | 文件預覽測試 | 含 `components/` 子目錄（4 個測試組件） |

### 測試工具模組

| 路徑 | 功能 | 備註 |
|------|------|------|
| `/admin/test/extraction-compare` | 提取結果比較 | V2 vs V3 比較工具 |
| `/admin/test/extraction-v2` | V2 提取測試 | 舊版提取測試 |
| `/admin/test/template-matching` | 模板匹配測試 | 含 `components/`（9 個測試組件）+ `types.ts` |

---

## 非 Admin 功能頁面

### 核心業務頁面

| 路徑 | 功能 | 路由結構 | i18n 命名空間 |
|------|------|----------|---------------|
| `/dashboard` | 主儀表板 | 單頁 | `dashboard` |
| `/documents` | 文件處理 | 列表 + `upload` + `[id]`（含 loading.tsx） | `documents` |
| `/review` | 文件審核 | 列表 + `[id]` | `review` |
| `/escalations` | 升級處理 | 列表 + `[id]` | `escalation` |
| `/rules` | 映射規則 | 列表 + `new` + `[id]`（detail/edit/history）+ `review/[id]` | `rules` |
| `/companies` | 公司管理 | 列表 + `new` + `[id]`（detail/edit/formats/rules） | `companies` |
| `/template-instances` | 模板實例 | 列表 + `[id]` | `templateInstance` |
| `/global` | 全域統計 | 單頁 | `global` |
| `/rollback-history` | 回滾歷史 | 單頁 | `rules` |

### 報表頁面

| 路徑 | 功能 | i18n 命名空間 |
|------|------|---------------|
| `/reports/ai-cost` | AI 成本報表 | `reports` |
| `/reports/cost` | 成本分析 | `reports` |
| `/reports/monthly` | 月度報告 | `reports` |
| `/reports/regional` | 區域報表 | `reports` |

### 其他頁面

| 路徑 | 功能 |
|------|------|
| `/audit/query` | 審計日誌查詢（含 `client.tsx` Client 組件） |
| `/docs` | 系統文檔 |
| `/docs/examples` | 文檔範例 |

---

## 檔案命名規範

| 檔案名 | 用途 | 範例 |
|--------|------|------|
| `page.tsx` | 路由頁面（Server Component） | 每個目錄一個 |
| `layout.tsx` | 共用布局（嵌套繼承） | 3 個布局層級 |
| `loading.tsx` | 載入狀態 UI | 僅 `documents/[id]/` 使用 |
| `client.tsx` | Client Component 分離 | `audit/query/`、`companies/review/` |
| `components/` | 頁面專屬組件 | `document-preview-test/`、`test/template-matching/` |
| `types.ts` | 頁面專屬類型定義 | `test/template-matching/` |

### Server vs Client 分離模式

```
page.tsx (Server Component)
├── 資料獲取（Prisma 查詢）
├── 權限檢查
└── 渲染 Client Component
    └── client.tsx 或 components/*.tsx (Client Component)
        ├── 'use client' 標記
        ├── 使用者互動邏輯
        └── React Query / Zustand 整合
```

---

## 新增頁面 Checklist

### Admin CRUD 模組（標準模式）

```bash
# 1. 建立目錄結構
src/app/[locale]/(dashboard)/admin/{module-name}/
├── page.tsx          # 列表頁
├── [id]/page.tsx     # 編輯頁
└── new/page.tsx      # 新建頁
```

- [ ] 確認路由組歸屬（通常在 `(dashboard)/admin/`）
- [ ] 建立 3 個頁面文件（列表 + 編輯 + 新建）
- [ ] 確認對應 API 端點已存在（`src/app/api/` 下）
- [ ] 新增 i18n 翻譯（`messages/{en,zh-TW,zh-CN}/{namespace}.json`）
- [ ] 如新增命名空間，更新 `src/i18n/request.ts` 的 `namespaces` 陣列
- [ ] 更新 Sidebar 導航（`src/components/layout/Sidebar.tsx`）
- [ ] 更新本文件的 Admin 模組索引表

### 單頁功能頁面

- [ ] 確認路由組歸屬（`(auth)` 或 `(dashboard)`）
- [ ] 確認布局繼承正確
- [ ] 如需 Client 互動，分離為 `client.tsx`
- [ ] 新增 i18n 翻譯（3 個語言文件）
- [ ] 確認權限要求（public / authenticated / admin-only）

---

## 相關文檔

| 文件 | 用途 |
|------|------|
| [CLAUDE.md (根目錄)](../../../CLAUDE.md) | 項目總指南 |
| [src/app/api/CLAUDE.md](../api/CLAUDE.md) | API 路由結構 |
| [src/components/CLAUDE.md](../../components/CLAUDE.md) | React 組件索引 |
| [messages/CLAUDE.md](../../../messages/CLAUDE.md) | i18n 翻譯文件 |
| [src/i18n/CLAUDE.md](../../i18n/CLAUDE.md) | i18n 配置 |
| [.claude/rules/components.md](../../../.claude/rules/components.md) | 組件開發規範 |
| [.claude/rules/i18n.md](../../../.claude/rules/i18n.md) | i18n 開發規範 |

---

**維護者**: Development Team
**最後更新**: 2026-08-06
**版本**: 1.0.0
