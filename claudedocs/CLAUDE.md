# ClaudeDocs - AI 助手文檔目錄

> **相關規則**: 請參閱 `.claude/rules/` 獲取開發規範（9 個規則文件）
> **自定義 Agent**: `.claude/agents/`（8 個 AI Agent）
> **自定義 Skill**: `.claude/skills/`（4 個 Skill）

## 目錄用途

此目錄是 AI 助手（Claude）與開發團隊協作產出的項目文檔中心，採用結構化的 7 層分類方式組織，涵蓋從規劃、開發到維運的完整生命週期文檔。這些文檔用於：

- **項目規劃**: Epic 架構設計、功能規劃、路線圖
- **進度追蹤**: 每日/每週進度報告、Sprint 計劃
- **變更管理**: Bug 修復記錄（54 份，FIX-050~054 全數完成）、功能變更追蹤（56 份，最新 CHANGE-056）
- **AI 協作**: 情境提示詞、工作流程指南、分析報告
- **知識傳承**: 開發經驗、故障排查、部署指南

---

## 項目概覽 - AI Document Extraction

### 核心目標
- **年處理量**: 450,000-500,000 張發票（APAC 地區）
- **自動化率**: 90-95%
- **準確率**: 90-95%
- **節省人時**: 35,000-40,000 人時/年

### 核心架構 - 三層映射系統

```
TIER 1: Universal Mapping（通用層）
  覆蓋 70-80% 常見術語，所有 Forwarder 通用

TIER 2: Forwarder-Specific Override（特定覆蓋層）
  只記錄該 Forwarder 與通用規則「不同」的映射

TIER 3: LLM Classification（AI 智能分類）
  當以上都無法匹配時，使用 GPT-5.2 智能分類
```

### 信心度路由機制

| 信心度範圍 | 處理方式 | 說明 |
|-----------|---------|------|
| >= 90% | AUTO_APPROVE | 自動通過，無需人工介入 |
| 70-89% | QUICK_REVIEW | 快速人工確認 |
| < 70% | FULL_REVIEW | 完整人工審核 |

---

## 目錄結構詳解

```
claudedocs/
├── 1-planning/                  # 規劃文檔
│   ├── architecture/            # 架構設計文檔
│   │   ├── THREE-TIER-MAPPING-SYSTEM.md   # 三層映射系統設計
│   │   └── CONFIDENCE-ROUTING.md          # 信心度路由機制
│   ├── epics/                   # Epic 規劃 (epic-0 ~ epic-16)
│   │   ├── epic-0/              # 歷史數據初始化
│   │   ├── epic-1/              # 用戶認證與存取控制
│   │   ├── epic-2/              # 手動發票上傳與 AI 處理
│   │   ├── epic-3/              # 發票審核與修正工作流
│   │   ├── epic-4/              # 映射規則管理與自動學習
│   │   ├── epic-5/              # Forwarder 配置管理
│   │   ├── epic-6/              # 多城市數據隔離
│   │   ├── epic-7/              # 報表儀表板與成本追蹤
│   │   ├── epic-8/              # 審計追溯與合規
│   │   ├── epic-9/              # 自動化文件獲取
│   │   ├── epic-10/             # n8n 工作流整合
│   │   ├── epic-11/             # 對外 API 服務
│   │   ├── epic-12/             # 系統管理與監控
│   │   ├── epic-13/             # 文件預覽與欄位映射
│   │   ├── epic-14/             # Prompt 配置與動態生成
│   │   ├── epic-15/             # 統一 3 層機制到日常處理流程
│   │   └── epic-16/             # 文件格式管理
│   │   # 注意：Epic 17-21 無獨立目錄，進度追蹤於下方進度表
│   ├── plan-docs/               # CHANGE/FIX 規劃文件
│   │   └── change-032-plan.md   # CHANGE-032 規劃文件
│   ├── features/                # Feature 規劃
│   └── roadmap/                 # 產品路線圖
│
├── 2-sprints/                   # Sprint 文檔
│   └── sprint-planning/         # Sprint 計劃記錄
│
├── 3-progress/                  # 進度追蹤
│   ├── daily/                   # 每日進度
│   └── weekly/                  # 每週進度報告
│
├── 4-changes/                   # 變更記錄
│   ├── bug-fixes/               # Bug 修復記錄 (35 份: FIX-001 ~ FIX-035)
│   └── feature-changes/         # 功能變更記錄 (33 份: CHANGE-001 ~ CHANGE-033)
│
├── 5-status/                    # 狀態報告
│   └── testing/                 # 測試文檔
│       ├── plans/               # 測試計劃 (TEST-PLAN-*)
│       ├── reports/             # 測試報告 (TEST-REPORT-*)
│       ├── e2e/                 # E2E 測試文檔
│       ├── manual/              # 手動測試文檔
│       └── TESTING-FRAMEWORK.md # 測試框架說明
│
├── 6-ai-assistant/              # AI 助手相關
│   ├── analysis/                # 分析報告
│   ├── prompts/                 # 情境提示詞 (SITUATION-1 ~ SITUATION-7)
│   │   ├── SITUATION-1-PROJECT-ONBOARDING.md   # 項目入門
│   │   ├── SITUATION-2-FEATURE-DEV-PREP.md     # 功能開發準備
│   │   ├── SITUATION-3-FEATURE-ENHANCEMENT.md  # 功能增強
│   │   ├── SITUATION-4-NEW-FEATURE-DEV.md      # 新功能開發
│   │   ├── SITUATION-5-SAVE-PROGRESS.md        # 保存進度
│   │   ├── SITUATION-6-SERVICE-STARTUP.md      # 服務啟動
│   │   └── SITUATION-7-SEED-DATA-MAINTENANCE.md # Seed 數據維護
│   └── session-guides/          # 會話指南
│
├── 7-archive/                   # 歸檔文檔
│   └── templates/               # 文檔範本
│
├── reference/                   # 參考資料（CHANGE-033 新增）
│   ├── directory-structure.md   # 完整目錄結構 + API 路由 + Agents/Skills/Rules
│   ├── dev-checklists.md        # 開發後文檔更新檢查清單
│   └── project-progress.md      # 22 Epic 進度表 + 版本記錄
│
└── CLAUDE.md                    # 本文件 - 目錄索引
```

---

## 項目進度追蹤

### Epic 完成狀態 (2026-02-09)

全部 22 個 Epic（157+ 個 Stories）已完成。

| Epic | 名稱 | 狀態 | 完成日期 |
|------|------|------|----------|
| Epic 0 | 歷史數據初始化 | ✅ 已完成 | 2025-12-26 |
| Epic 1 | 用戶認證與存取控制 | ✅ 已完成 | 2025-12-18 |
| Epic 2 | 手動發票上傳與 AI 處理 | ✅ 已完成 | 2025-12-18 |
| Epic 3 | 發票審核與修正工作流 | ✅ 已完成 | 2025-12-19 |
| Epic 4 | 映射規則管理與自動學習 | ✅ 已完成 | 2025-12-19 |
| Epic 5 | Forwarder 配置管理 | ✅ 已完成 | 2025-12-19 |
| Epic 6 | 多城市數據隔離 | ✅ 已完成 | 2025-12-19 |
| Epic 7 | 報表儀表板與成本追蹤 | ✅ 已完成 | 2025-12-20 |
| Epic 8 | 審計追溯與合規 | ✅ 已完成 | 2025-12-20 |
| Epic 9 | 自動化文件獲取 | ✅ 已完成 | 2025-12-20 |
| Epic 10 | n8n 工作流整合 | ✅ 已完成 | 2025-12-21 |
| Epic 11 | 對外 API 服務 | ✅ 已完成 | 2025-12-21 |
| Epic 12 | 系統管理與監控 | ✅ 已完成 | 2025-12-21 |
| Epic 13 | 文件預覽與欄位映射 | ✅ 已完成 | 2026-01-18 |
| Epic 14 | Prompt 配置與動態生成 | ✅ 已完成 | 2026-01-03 |
| Epic 15 | 統一 3 層機制到日常處理流程 | ✅ 已完成 | 2026-01-03 |
| Epic 16 | 文件格式管理 | ✅ 已完成 | 2026-01-14 |
| Epic 17 | 國際化 (i18n) 多語言支援 | ✅ 已完成 | 2026-01-17 |
| Epic 18 | 本地帳號認證系統 | ✅ 已完成 | 2026-01-19 |
| Epic 19 | 資料模板匹配與匯出 | ✅ 已完成 | 2026-01-23 |
| Epic 20 | 參考編號主檔管理 | ✅ 已完成 | 2026-02-05 |
| Epic 21 | 匯率管理 | ✅ 已完成 | 2026-02-06 |

### 變更管理統計（2026-04-22 更新）

| 類型 | 數量 | 最新編號 | 路徑 |
|------|------|---------|------|
| 功能變更 (CHANGE) | **56 份** | CHANGE-056 | `4-changes/feature-changes/` |
| Bug 修復 (FIX) | **54 份**（全部已完成）| FIX-054 | `4-changes/bug-fixes/` |

### FIX-050 ~ FIX-054（Codebase 品質與部署可靠性系列）✅ 全數完成

| 編號 | 名稱 | 狀態 |
|------|------|------|
| FIX-050 | auth.config.ts PII Leakage | ✅ 已修復（2026-04-21） |
| FIX-051 | db-context.ts SQL Injection Risk | ✅ 已修復（2026-04-21） |
| FIX-052 | Rate Limit in-memory → Upstash Redis | ✅ 已修復（2026-04-21） |
| FIX-053 | Smart Routing Dual Logic Conflict | ✅ 已修復（2026-04-21） |
| FIX-054 | SYSTEM_USER_ID 硬編碼 'dev-user-1' 為生產依賴 | ✅ 已修復（2026-04-22） |

### CHANGE-054 / 055 / 056（部署系列）

| 編號 | 名稱 | 狀態 |
|------|------|------|
| CHANGE-054 | Local Deployment Readiness：一鍵 init 腳本 + verify-environment + .env.example 全面重寫 | ✅ 已完成（2026-04-22） |
| CHANGE-055 | Azure Production Deployment Foundation | 📋 Phase 1 規劃中（2026-04-22 v0.2：4 個 Critical 議題已定案） |
| CHANGE-056 | Prisma Migration Baseline（重建基線 + 歸檔舊 migrations） | 📋 規劃中（2026-04-22 規劃文件已建，CHANGE-055 分支獨立追蹤） |

### 重要重構記錄

| 記錄 | 說明 | 狀態 |
|------|------|------|
| REFACTOR-001 | Forwarder -> Company 模型重構 | ✅ 已完成 |
| CHANGE-031 | Frontend Invoice -> Document 重命名 | ✅ 已完成 |

### 主要功能變更（近期）

| 編號 | 名稱 | 狀態 | 描述 |
|------|------|------|------|
| CHANGE-032 | Pipeline 參考編號匹配 + 匯率轉換 | ✅ 已完成 | 提取管線新增 `pipeline-config.service.ts` 及參考編號/匯率階段 |
| CHANGE-033 | CLAUDE.md Token 優化 | ✅ 已完成 | 精簡系統提示至 ~350 行，移出參考資料 |
| CHANGE-044 ~ 053 | Line item / Field definition / User profile / System settings / Role unification 等 | ✅ 已完成 | 多項後續增強（詳見 feature-changes/） |
| CHANGE-054 | Deployment Readiness Enhancement | ✅ 已完成 | 新環境一鍵腳本 + verify-environment + .env.example 全面重寫（與 FIX-054 配對） |

> CHANGE-034 ~ 054 共 21 份近期變更未全部列於此表，請查閱 `4-changes/feature-changes/` 獲取完整清單。

---

## 文檔命名約定

### Epic 規劃

**Epic 目錄**: epic-0 ~ epic-16（共 17 個目錄），Epic 17-21 無獨立目錄
**Epic 總數**: 0-21（共 22 個 Epic，157+ Stories）

每個 Epic 目錄包含：
- `epic-{N}-overview.md` - Epic 概述
- `architecture.md` - 技術架構（部分 Epic）
- `story-{N}-{M}-*.md` - 個別 Story 文檔（部分 Epic）

### 規劃文件 (plan-docs)

位於 `claudedocs/1-planning/plan-docs/`，使用命名格式 `change-{NNN}-plan.md`

### 功能變更 (CHANGE-*)

位於 `claudedocs/4-changes/feature-changes/`，命名格式 `CHANGE-{NNN}-{description}.md`

**CHANGE 編號範圍**: 001-056（共 56 份；CHANGE-055/056 規劃中）

### Bug 修復 (FIX-*)

位於 `claudedocs/4-changes/bug-fixes/`，命名格式 `FIX-{NNN}-{description}.md`

**FIX 編號範圍**: 001-054（共 54 份；FIX-050~054 全數完成）

### 進度報告

- 日報: `claudedocs/3-progress/daily/{YYYY}-{MM}/{YYYY}-{MM}-{DD}.md`
- 週報: `claudedocs/3-progress/weekly/{YYYY}-W{WW}.md`

### 測試文檔 (TEST-PLAN-* / TEST-REPORT-*)

位於 `claudedocs/5-status/testing/`，包含 plans/、reports/、e2e/、manual/ 子目錄

### 情境提示詞 (SITUATION-*)

位於 `claudedocs/6-ai-assistant/prompts/`，SITUATION-1 ~ SITUATION-7

---

## 技術棧

### 核心框架
- **前端**: Next.js 15.0.0 (App Router) + TypeScript 5.0 + React 18.3
- **樣式**: Tailwind CSS 3.4 + shadcn/ui (Radix UI 20+ primitives)
- **資料庫**: PostgreSQL 15 + Prisma ORM 7.2 (122 models, 113 enums)
- **狀態管理**: Zustand 5.x (UI) + React Query 5.x (Server State)
- **表單**: React Hook Form 7.x + Zod 4.x 驗證
- **國際化**: next-intl 4.7（支援 en, zh-TW, zh-CN，34 個命名空間）
- **快取**: @upstash/redis（⚠️ Rate limit 實作使用 in-memory Map，見主 CLAUDE.md §已知差異）
- **拖放**: @dnd-kit (sortable UI)

### 外部服務
- **OCR**: Azure Document Intelligence
- **AI**: Azure OpenAI GPT-5.2 (含 GPT Vision) + OpenAI SDK
- **認證**: Azure AD (Entra ID) SSO + 本地帳號認證
- **工作流**: n8n
- **文件來源**: SharePoint / Outlook / Azure Blob Storage
- **Office 365**: Microsoft Graph Client

### 代碼規模（同步 codebase-analyze 2026-04-09）

| 指標 | 數量 | 說明 |
|------|------|------|
| React 組件 | **371** | src/components/ 下所有 .tsx（~98K LOC） |
| 業務服務 | **200** | src/services/ 下所有 .ts（~100K LOC） |
| API 路由文件 | **331** | 414 HTTP methods，約 **400+ 端點** |
| 自定義 Hooks | **104** | src/hooks/ |
| Types | **93** | src/types/ |
| Prisma Models | **122** | 資料庫模型定義 |
| Prisma Enums | **113** | 列舉類型 |
| i18n 命名空間 | **34/語言** | 3 種語言各 34 個 JSON 文件（共 102 個） |

> **完整深度分析**: `docs/06-codebase-analyze/00-analysis-index.md`（80 份：31 分析 + 5 diagrams + 44 驗證報告）

---

## 重要文檔索引

### AI 助手工作流程

| 文檔路徑 | 用途 |
|----------|------|
| `6-ai-assistant/prompts/SITUATION-1-PROJECT-ONBOARDING.md` | 項目入門、新會話啟動 |
| `6-ai-assistant/prompts/SITUATION-2-FEATURE-DEV-PREP.md` | 功能開發準備、任務分析 |
| `6-ai-assistant/prompts/SITUATION-3-FEATURE-ENHANCEMENT.md` | 功能增強、代碼優化 |
| `6-ai-assistant/prompts/SITUATION-4-NEW-FEATURE-DEV.md` | 新功能開發、實作執行 |
| `6-ai-assistant/prompts/SITUATION-5-SAVE-PROGRESS.md` | 保存進度、會話結束 |
| `6-ai-assistant/prompts/SITUATION-6-SERVICE-STARTUP.md` | 服務啟動、環境重啟 |
| `6-ai-assistant/prompts/SITUATION-7-SEED-DATA-MAINTENANCE.md` | Seed 數據維護、新環境部署 |

### 分析報告

| 文檔路徑 | 用途 |
|----------|------|
| `6-ai-assistant/analysis/ANALYSIS-001-HISTORICAL-DATA-FLOW.md` | Epic 0 歷史數據初始化流程架構分析 |

### 測試計劃

| 文檔路徑 | 用途 |
|----------|------|
| `5-status/testing/plans/TEST-PLAN-001-dual-processing.md` | CHANGE-001 雙重處理專用測試 |
| `5-status/testing/plans/TEST-PLAN-002-EPIC-0-COMPLETE.md` | Epic 0 Stories 0-1~0-9 測試 |
| `5-status/testing/plans/TEST-PLAN-003-EPIC-0-FULL-FEATURE.md` | Epic 0 完整功能測試 |

### 核心文檔

| 文檔路徑 | 用途 |
|----------|------|
| `CLAUDE.md` (根目錄) | 專案總指南 (v3.0.0) |
| `.claude/CLAUDE.md` | 詳細操作指引（服務啟動等） |
| `docs/01-planning/prd/` | 產品需求文檔 |
| `docs/02-architecture/` | 系統架構設計 |
| `docs/03-stories/` | User Stories |
| `docs/04-implementation/sprint-status.yaml` | Sprint 狀態追蹤 |

---

## Claude Code 自定義基礎設施

### `.claude/agents/` - 8 個自定義 AI Agent

| Agent | 模型 | 用途 | 修改代碼？ |
|-------|------|------|------------|
| `project-analyst` | sonnet | 文檔審計與差距分析 | 否（文檔） |
| `requirement-analyst` | sonnet | 需求探索與影響分析 | 否（唯讀） |
| `architecture-reviewer` | sonnet | 架構設計驗證 | 否（唯讀） |
| `i18n-guardian` | haiku | 翻譯同步檢查 | 否（建議修復） |
| `code-quality-checker` | sonnet | 項目品質審查 | 否（唯讀） |
| `fullstack-scaffolder` | sonnet | 全端代碼骨架生成 | 是（新文件） |
| `test-strategist` | sonnet | 測試計劃文檔 | 否（文檔） |
| `session-manager` | haiku | SITUATION-5 自動化 | 否（文檔） |

### `.claude/skills/` - 4 個自定義 Skill

| Skill | 觸發命令 | 用途 |
|-------|----------|------|
| `quickcompact` | `/quickcompact` | 快速 compact 並保留執行狀態 |
| `plan-story` | `/plan-story` | 新功能規劃 |
| `plan-change` | `/plan-change` | 功能變更規劃 |
| `plan-fix` | `/plan-fix` | Bug 修復規劃 |

### `.claude/rules/` - 9 個規則文件

| 規則文件 | 用途 |
|----------|------|
| `general.md` | 通用開發規範 |
| `typescript.md` | TypeScript 規範 |
| `services.md` | 服務層規範 |
| `api-design.md` | API 設計規範 |
| `components.md` | 組件開發規範 |
| `database.md` | 資料庫規範 |
| `testing.md` | 測試規範 |
| `i18n.md` | 國際化開發規範 |
| `technical-obstacles.md` | 技術障礙處理 |

---

## 使用指南

### 查找文檔

| 需求 | 路徑 |
|------|------|
| Epic 規劃 | `1-planning/epics/epic-{N}/` |
| 功能規劃 | `1-planning/plan-docs/` |
| 功能變更 | `4-changes/feature-changes/CHANGE-{NNN}-*` |
| Bug 修復 | `4-changes/bug-fixes/FIX-{NNN}-*` |
| 測試計劃 | `5-status/testing/plans/TEST-PLAN-{NNN}-*` |
| 測試報告 | `5-status/testing/reports/TEST-REPORT-{NNN}-*` |
| 週報 | `3-progress/weekly/` |
| AI 工作流程 | `6-ai-assistant/prompts/` |
| 範本 | `7-archive/templates/` |
| 完整目錄結構 | `reference/directory-structure.md` |
| 開發後檢查清單 | `reference/dev-checklists.md` |
| Epic 進度與版本記錄 | `reference/project-progress.md` |

### 創建新文檔

1. **確定文檔類型和目錄** - 功能規劃用 plan-docs/，變更用 feature-changes/，修復用 bug-fixes/
2. **使用正確的命名約定** - CHANGE 下一個編號 034，FIX 下一個編號 036
3. **遵循格式範本** - 參考 `7-archive/templates/` 下的範本

> **下一個可用編號**: CHANGE-057、FIX-055（建立前請 Glob `CHANGE-*.md` / `FIX-*.md` 確認最新編號）

---

## 重要約定

1. **命名一致性** - UPPERCASE-WITH-DASHES，三位數編號，kebab-case 描述
2. **語言規範** - 文檔繁體中文，代碼英文，日期 YYYY-MM-DD
3. **狀態標記** - ✅已完成 🚧進行中 📋規劃中 ⏸️暫停 ❌已取消 ⚠️有風險
4. **禁止事項** - 不要在錯誤目錄建檔，不要用不一致命名，不要遺漏 frontmatter

---

## 相關文件

### 項目級文檔
- `CLAUDE.md` - 根目錄專案總指南 (v3.0.0)
- `.claude/CLAUDE.md` - 詳細操作指引
- `docs/04-implementation/sprint-status.yaml` - Sprint 狀態追蹤

### 規則文件
- `.claude/rules/general.md` - 通用開發規範
- `.claude/rules/components.md` - 組件開發規範
- `.claude/rules/typescript.md` - TypeScript 規範
- `.claude/rules/i18n.md` - 國際化開發規範
- `.claude/rules/api-design.md` - API 設計規範
- `.claude/rules/services.md` - 服務層規範
- `.claude/rules/database.md` - 資料庫規範
- `.claude/rules/testing.md` - 測試規範
- `.claude/rules/technical-obstacles.md` - 技術障礙處理

---

**維護者**: AI 助手 + 開發團隊
**最後更新**: 2026-04-22（v3.3.0：CHANGE-055 v0.2 Critical 決策定案 + 新增 CHANGE-056 Prisma migration baseline）
**文檔版本**: 3.3.0
