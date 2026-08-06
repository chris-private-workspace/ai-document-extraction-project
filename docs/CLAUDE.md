# Docs 目錄 - 項目正式文檔

> **子目錄數量**: 15 個 + 根層 5 個檔案
> **文檔總數**: 約 **760** 個檔案（.md 為主，另有 .xlsx 主資料、.bicep 部署範本、.pdf 樣本）
> **最後更新**: 2026-08-06（首次建立本文件）
> **版本**: 1.0.0

---

## 概述

`docs/` 是**項目正式文檔**（PRD、架構、Epic、Tech Spec、部署、codebase 分析），
與 `claudedocs/`（AI 助手協作產出：CHANGE/FIX、測試報告、情境提示詞）分工如下：

| 目錄 | 性質 | 誰維護 |
|------|------|--------|
| `docs/` | 項目正式文檔、規格、分析報告、主資料 | 團隊 + AI |
| `claudedocs/` | CHANGE/FIX 變更記錄、測試報告、AI 工作流 | 主要由 AI |

---

## 🔴 三個必須先知道的事

### 1. `docs/12-development-log/` 絕對不讀

該目錄是**使用者的私人開發日誌**。即使 IDE 開著、即使被要求「看看專案進度」，
**都不得讀取其內容**，也不同步到 GitHub。本文件只記錄它存在。

### 2. `docs/03-stories/` 不存在

大量舊文檔（含曾經的根 CLAUDE.md）引用 `docs/03-stories/tech-specs/`，**該路徑從未存在**。
`docs/06-codebase-analyze/verification/` 的 R12 / R13 / R18 / R19 四份報告各自獨立確認過這件事。

| 錯誤引用 | 正確位置 |
|---|---|
| `docs/03-stories/tech-specs/` | **`docs/04-implementation/tech-specs/`** |
| `docs/03-stories/`（Story 文件） | `docs/04-implementation/stories/` |
| Epic 文件 | `docs/03-epics/` |

活躍文檔已於 2026-08-06 修正，但歷史 CHANGE/FIX 與 archive 內仍有殘留 —— 那些是歷史記錄，不改。

### 3. 多數子目錄是**歷史快照**，不隨代碼更新

`00-discovery` / `01-planning` / `02-architecture` / `02-solutioning` / `03-epics` / `_backup`
最後修改都停在 **2025-12 ~ 2026-01**。它們反映的是規劃當時的意圖，**不是當下實況**。
要查「現在系統實際怎麼運作」，看 `06-codebase-analyze/` 或直接讀代碼。

---

## 目錄索引

| 目錄 | 檔數 | 最近更新 | 內容 | 時效性 |
|------|-----:|----------|------|--------|
| `00-discovery/` | 8 | 2025-12-24 | Product brief、早期策略討論 | 歷史 |
| `01-planning/` | 27 | 2025-12-15 | **PRD v1.0（凍結）** + UX 設計規格 | 🔒 凍結基準 |
| `02-architecture/` | 11 | 2025-12-24 | 系統架構設計、信心度閾值設計 | 歷史意圖 |
| `02-solutioning/` | 1 | 2025-12-14 | README | 歷史 |
| `03-epics/` | 23 | 2026-01-02 | Epic 0–21 定義（`sections/` 分檔） | 歷史 |
| **`04-implementation/`** | **334** | 2026-07-28 | **Tech Specs / Stories / sprint-status.yaml / api-registry / dev-checklist** | ✅ 活躍 |
| `05-analysis/` | 29 | 2026-04-09 | 架構分析報告（ARCH-*，按日期命名） | 時點分析 |
| **`06-codebase-analyze/`** | **104** | 2026-05-31 | **Codebase 深度分析 + verification 驗證報告** | ✅ 查實況首選 |
| **`07-deployment/`** | 53 | 2026-08-04 | **本地 + Azure 部署**（含 8 個 `.bicep`） | ✅ 活躍 |
| `08-security-and-governance/` | 10 | 2026-06-14 | Epic 22 安全治理評估（IAM/DP、AppSec/Obs、Resi/Gov） | ✅ 活躍 |
| `12-development-log/` | 10 | 2026-07-08 | 🔴 **私人日誌，不讀** | — |
| `14-ai-assistant/` | 4 | 2026-08-06 | Session start / compact 的指引與範例 | ✅ 活躍 |
| `15-master-data/` | 8 | 2026-06-30 | **主資料 Excel**（公司 / 參考編號 / 匯率 / 格式 / 報表映射矩陣） | ✅ 活躍 |
| `Doc Sample/` | 138 | 2026-07-15 | 樣本 PDF（137 份）+ Excel | 測試資料 |
| `Doc template/` | 1 | 2026-04-09 | 報表範本 Excel | — |
| `_backup/` | 4 | 2025-12-15 | PRD / architecture / epics 的舊版備份 | 歷史 |

### 根層檔案

| 檔案 | 用途 |
|------|------|
| `open-questions.md` | **OQ 列表**（未解決的設計決策；CLAUDE.md §Open Questions 機制引用此檔） |
| `coding-standards.md` | 編碼標準 |
| `bmm-workflow-status.yaml` | 工作流狀態 |
| `MIGRATION-GUIDE.md` | 遷移指南 |
| `implementation-readiness-report-2025-12-15.md` | 實作就緒評估（歷史） |

---

## 常用路徑速查

| 要找什麼 | 路徑 |
|---|---|
| PRD | `01-planning/prd/prd.md`（分節在 `prd/sections/`） |
| 系統架構 | `02-architecture/architecture.md` |
| **Tech Specs** | `04-implementation/tech-specs/` |
| **Story 文件** | `04-implementation/stories/` |
| Epic 22 安全治理 | `04-implementation/stories/epic-22-enterprise-security/` |
| Epic 23 多 LLM Provider | `04-implementation/tech-specs/epic-23-multi-llm-provider/AI-HANDOFF.md` |
| Sprint 狀態 | `04-implementation/sprint-status.yaml`（⚠️ **已封存**，只到 Epic 21） |
| **Codebase 分析主索引** | `06-codebase-analyze/00-analysis-index.md` |
| 驗證報告（含已知文檔錯誤） | `06-codebase-analyze/verification/` |
| 部署文件中心 | `07-deployment/README.md` |
| 本地 vs Azure 差異 | `07-deployment/local-vs-azure-differences.md` |
| Azure Bicep 範本 | `07-deployment/02-azure-deployment/` |
| Open Questions | `open-questions.md` |

---

## `04-implementation/` 展開（最大的活躍目錄）

```
04-implementation/
├── sprint-status.yaml        # ⚠️ 已封存（Epic 0–21），Epic 22/23 不在內
├── api-registry.md
├── component-registry.md
├── dev-checklist.md
├── implementation-context.md
├── lessons-learned.md
├── prompt-templates/
├── stories/                  # Story 文件（含 epic-22-enterprise-security/）
└── tech-specs/               # ⭐ Tech Spec 權威位置（含 epic-23-multi-llm-provider/）
```

## `06-codebase-analyze/` 展開（查系統實況的首選）

```
06-codebase-analyze/
├── 00-analysis-index.md          # ⭐ 主索引，先讀這份
├── 00-conversation-log/
├── 01-project-overview/          # 架構模式、AI 開發基礎設施、開發工具
├── 02-module-mapping/            # services / components / api-routes overview
├── 03-database/                  # Prisma model / enum inventory、migration history
├── 04-diagrams/
├── 05-security-quality/
├── 06-i18n-analysis/
├── 07-external-integrations/
├── 08-ui-design-system/
├── 09-testing/
└── verification/                 # ⭐ R12–R19 驗證報告（記錄了多項文檔與實況的落差）
```

> `verification/` 的價值：它是**已經做過的事實查核**。懷疑某份文檔是否過時時，先看這裡有沒有查過。

---

## 維護規則

1. **PRD v1.0 已凍結**（`01-planning/prd/`）—— 屬 CLAUDE.md §絕不 touch 清單。有更新需求 → 另加 amendment 檔
2. **歷史目錄不追改**（`00-discovery` / `02-*` / `03-epics` / `_backup`）—— 它們記錄當時決策，不是當下狀態
3. **新增 Tech Spec / Story** → `04-implementation/` 之下，不要建 `03-stories/`
4. **主資料變更**（`15-master-data/`）→ 涉及資料庫寫入時走 CLAUDE.md §不可逆資料操作紀律的三段式流程
5. **引用路徑前先確認存在** —— 本目錄的路徑錯誤有前例（`docs/03-stories/` 存活超過半年）

---

## 相關文檔

- [CLAUDE.md (根目錄)](../CLAUDE.md) - 項目總指南（§按需查閱 表指向本目錄多處）
- [claudedocs/CLAUDE.md](../claudedocs/CLAUDE.md) - AI 助手文檔中心
- [.claude/CLAUDE.md](../.claude/CLAUDE.md) - 服務啟動與問題排解

---

**維護者**: Development Team
**最後更新**: 2026-08-06
**版本**: 1.0.0
