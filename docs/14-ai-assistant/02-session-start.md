# SITUATION AI Document Extraction — Session Start Prompt（每個新 session 必用）

> **用法**：每個新 session 開始時，整份 copy 入對話框送出，**只需更新最後一節「今天的任務」一行**。其他段落係常駐 onboarding context，唔需要每次改。
>
> **適用範圍**：AI Document Extraction Project Phase 2（功能變更模式）— Strict Mode v4.0.0 開始（2026-05-26）。Phase 1 開發（22 Epic / 157+ Story / Sprints 1-N）已完成；Phase 2 進入持續性 CHANGE/FIX 模式，無明確結束日期。

---

## 第一部分：你正在加入嘅項目

你好。本項目係 **AI Document Extraction Project — Ricoh SCM Freight Invoice 自動化系統**，目前處於 **Phase 2 功能變更模式**（v4.0.0 Strict Mode 啟動，22 Epic Phase 1 開發已完成）。

### 項目為何存在（Why）

Ricoh SCM 部門每年需處理 **450K-500K 張 Freight Invoice（APAC 區域）**，人工處理效率低、錯誤率高、培訓成本大。本項目透過 **AI + 規則引擎 + 信心度路由**，提供自動化發票提取、分類、審核流程，目標：

- **自動化率**：90-95%（≥95% 信心度 AUTO_APPROVE）
- **準確率**：90-95%
- **節省人時**：35-40K 人時/年

### 本項目唔係咩（避免常見誤解）

- ❌ **唔係通用 OCR 平台** — 專注 Freight Invoice / 衍生 BOL / Packing List 等 SCM 文件類型
- ❌ **唔係 multi-tenant SaaS** — 單一 Ricoh APAC 部署，多 region / multi-city 屬 city-code RLS 而非租戶隔離
- ❌ **唔係 GraphRAG / multi-agent** — 規則引擎 + LLM fallback，唔係 agentic workflow
- ❌ **唔係 vendor 通用 ML platform** — Azure Document Intelligence + Azure OpenAI GPT-5.2 stack 已 lock，唔換
- ❌ **唔係從零起步** — Phase 1 22 Epic 已完成，Phase 2 係增量 CHANGE/FIX 模式

---

## 第二部分：最高指導原則（不可違反 — Strict Mode）

### 原則 1 — Behavioral Baseline（Karpathy Guidelines 四守則）

- **Think before coding**：assumption 明示，唔肯定就 ask，有更簡單做法就 push back
- **Simplicity first**：最少 code 解決問題，唔加未要求嘅 abstraction / flexibility / future-proofing
- **Surgical changes**：只改 user request 涉及嘅 code，唔順手 refactor / format adjacent code
- **Goal-driven execution**：task 一開始定 verifiable success criteria（寫 test → make pass）

> 來源：`andrej-karpathy-skills:karpathy-guidelines` plugin（`alwaysApply: true`）。詳細：CLAUDE.md §編碼核心原則。

### 原則 2 — 架構凍結

- **三層映射架構**（Universal → Forwarder Override → LLM）+ **信心度路由**（90%/70% 代碼實際值）係 frozen baseline
- **122 Prisma models + 113 enums** 核心結構 lock；改動 trigger H1 → STOP and ask
- **Vendor lock**（H2 trigger）：Azure Document Intelligence / Azure OpenAI GPT-5.2 / Azure AD SSO / PostgreSQL 15 / next-intl 4.7 — 唔換

### 原則 3 — Phase 2 範圍紀律（H3 trigger）

- 在當前 **CHANGE-XXX / FIX-XXX 範圍外**新增功能 = trigger H3 → STOP
- **不主動 refactor** 周邊代碼（除非屬當前 task scope）
- **不為 Tier 2 feature 預留 hook**（GraphRAG、multi-agent、workflow builder 等屬未來範圍，唔做）

完整 Hard Constraints（H1–H6）詳見 [`CLAUDE.md §Hard Constraints`](../../CLAUDE.md) + [`.claude/rules/hard-constraints.md`](../../.claude/rules/hard-constraints.md)。

---

## 第三部分：核心架構（必須遵守）

本項目嚴格按以下架構組織代碼，**禁止跨層雜湊**：

### 三層映射系統

```
TIER 1: Universal Mapping（通用層）            — 70-80% 常見術語，所有 Forwarder 通用
TIER 2: Forwarder-Specific Override（覆蓋層）  — 只記錄該 Forwarder 與通用規則的差異
TIER 3: LLM Classification（AI 智能分類）      — 以上都無法匹配時用 GPT-5.2
```

### 信心度路由機制（代碼實際值，注意 OQ-Q1）

| 信心度 | 處理方式 | 說明 |
|--------|----------|------|
| ≥ 90% | AUTO_APPROVE | 自動通過 |
| 70-89% | QUICK_REVIEW | 快速確認 |
| < 70% | FULL_REVIEW | 完整審核 |

> ⚠️ **CLAUDE.md 文檔誤差**：文檔記錄 95%/80%，但代碼實際 90%/70%（`src/services/extraction-v3/confidence-v3-1.service.ts` 第 112-119 行）。**以代碼為準**，commit message 標 `Note: depends on OQ-Q1`。詳見 `docs/open-questions.md`。

### V3.1 智能降級

- 新公司 → 強制 FULL_REVIEW
- 新格式 → 強制 QUICK_REVIEW
- DEFAULT 配置來源 → 降一級

### 22 Epic 分區（Phase 1 已完成）

| Epic | 範圍 | 狀態 |
|------|------|------|
| Epic 0 | 歷史資料 | ✅ Done |
| Epic 1 | 認證（Auth）| ✅ Done |
| Epic 2 | 發票上傳 | ✅ Done |
| Epic 3 | 發票審核 | ✅ Done |
| Epic 4 | 映射規則 | ✅ Done |
| Epic 5 | Forwarder 配置 | ✅ Done |
| Epic 6 | 多城市 | ✅ Done |
| Epic 10 | n8n Workflow | ✅ Done |
| Epic 11 | 對外 API | ✅ Done |
| Epic 12 | 系統管理 | ✅ Done |
| Epic 13 | 文件預覽 | ✅ Done |
| Epic 14 | Prompt 配置 | ✅ Done |
| Epic 15 | Unified Processor | ✅ Done |
| Epic 16 | 格式管理 | ✅ Done |
| Epic 17 | i18n（en / zh-TW / zh-CN）| ✅ Done |
| Epic 18 | 本地認證 | ✅ Done |
| Epic 19 | Template Matching | ✅ Done |
| Epic 20 | 參考編號主檔 | ✅ Done |
| Epic 21 | 匯率管理 | ✅ Done |
| Epic 22 | 企業安全 | ✅ Done |

> 完整 Story 列表 + Sprint 狀態：`docs/04-implementation/sprint-status.yaml`（**唯一真實來源**）
> Codebase 深度分析：`docs/06-codebase-analyze/00-analysis-index.md`（80 份文檔，整體驗證通過率 91.1%）

---

## 第四部分：權威排序（衝突時上位者勝）

```
docs/01-planning/prd/ v1.0 （frozen baseline）
  > docs/04-implementation/tech-specs/ （feature-level approved spec）
  > 根目錄 CLAUDE.md v4.0.0 + .claude/CLAUDE.md + .claude/rules/*.md （standing instructions）
  > docs/04-implementation/sprint-status.yaml （sprint 唯一真實來源）
  > docs/06-codebase-analyze/ （codebase 實況 80 份分析）
  > 當前 CHANGE-XXX / FIX-XXX 規劃文件
  > docs/open-questions.md （OQ 狀態）
  > claudedocs/reference/known-discrepancies.md （已知差異）
```

**任何衝突以上位者為準**。Stakeholder feedback 同 spec 衝突 → STOP，surface conflict，等 resolution。

---

## 第五部分：必讀文件（每次 session 至少讀以下）

依序讀完先對齊上下文：

1. **本 prompt**（你正在讀）— 高層 onboarding
2. **`CLAUDE.md`**（專案根目錄，v4.0.0）— Standing instructions + Strict Mode（H1-H6 hard constraints + Karpathy 四守則 + When in Doubt 決策表 + Self-Verification Checklist + Quick Reference Card）
3. **`.claude/CLAUDE.md`** + **`.claude/rules/*.md`**（11 條 detailed rules）— 服務啟動 + 端口處理 + 9 條開發規範
4. **`docs/04-implementation/sprint-status.yaml`** — Sprint 唯一真實來源
5. **`docs/open-questions.md`** — 5 條當前 OQ 狀態（信心度閾值 / Auth 覆蓋率 / RFC 7807 / Zod 覆蓋率 / console.log 清理）

按需要再讀：

- **SITUATION 提示詞**（`claudedocs/6-ai-assistant/prompts/SITUATION-*.md`）：
  - SITUATION-1 PROJECT-ONBOARDING（**新 session 必讀**）
  - SITUATION-2 FEATURE-DEV-PREP（功能開發前分析）
  - SITUATION-3 FEATURE-ENHANCEMENT（功能增強）
  - SITUATION-4 NEW-FEATURE-DEV（新功能實作）
  - SITUATION-5 SAVE-PROGRESS（保存進度）
  - SITUATION-6 SERVICE-STARTUP（服務啟動）
  - SITUATION-7 SEED-DATA-MAINTENANCE（Seed 數據維護）
- **規劃文件**（按 task 類型）：
  - 新功能 → `docs/04-implementation/tech-specs/` + Story 文件
  - 功能變更 → `claudedocs/4-changes/feature-changes/CHANGE-XXX-*.md`
  - Bug 修復 → `claudedocs/4-changes/bug-fixes/FIX-XXX-*.md`
- **Reference 文件**：
  - `claudedocs/reference/tech-stack.md` — 完整技術棧
  - `claudedocs/reference/dev-checklists.md` — 開發後檢查清單
  - `claudedocs/reference/known-discrepancies.md` — 已知差異（含已修復）
  - `claudedocs/reference/project-progress.md` — 項目進度與歷史
  - `claudedocs/reference/sub-claude-md-map.md` — Sub-CLAUDE.md 地圖
- **架構文件**：
  - `docs/02-architecture/` — 系統架構設計
  - `docs/01-planning/prd/prd.md` — PRD v1.0
  - `docs/06-codebase-analyze/00-analysis-index.md` — Codebase 80 份深度分析

---

## 第六部分：工作流模式（Phase 2 CHANGE/FIX 紀律）⭐

> **本項目核心**：與 EKP rolling JIT phase planning 不同，本項目 Phase 2 採用 **CHANGE/FIX 增量模式** — 每個變更獨立規劃 + 獨立執行 + 獨立 commit。

### ✅ 正確做法

- **任何 multi-file 變更必須先有 CHANGE-XXX 或 FIX-XXX 規劃文件**（H3 紀律）
- **CHANGE/FIX 編號搜尋必須用全量 Glob**（`CHANGE-*.md` / `FIX-*.md`，**不加數字前綴**）— 避免漏看高編號（FIX-044 事件教訓）
- **每個 CHANGE/FIX 對應獨立 commit 序列**（不混合多個 CHANGE/FIX 改動）
- **完成後必須更新規劃文件狀態為 ✅ 已完成**（dev-checklists 第 1 條 🔴 必須）
- **新功能必須有 Tech Spec + Story 文件**（`docs/04-implementation/tech-specs/`）
- **跨 Epic 修改前先讀對應 Story 文件 + tech-spec**

### ❌ 禁止做法

- **唔好擅自決定不寫規劃文件直接 code**（trivial fix < 30 min 例外）
- **唔好順手 refactor 周邊代碼**（H3 trigger — 必須開新 CHANGE/FIX）
- **唔好用「為將來預留」做加 abstraction 嘅理由**（Karpathy §1.2 simplicity first）
- **唔好在 commit 完成後忘記更新規劃文件狀態**（dev-checklists 第 1 條 🔴）
- **唔好在 Phase 2 引入 Tier 2 feature**（GraphRAG / multi-agent / workflow builder 等屬未來範圍）

### 為何用 CHANGE/FIX 模式而非 phase planning

1. Phase 1 已 ship 22 Epic — **codebase 成熟度高**，新需求多為點狀變更
2. 維運壓力 + bug fix 需要快速反應 — phase folder 太重
3. 並行 Agent 編排（CLAUDE.md §AI 開發輔助）以 CHANGE/FIX 為最小單位最 fit

→ **每個新 session 開始，AI 要先確認當前是否有 active CHANGE/FIX，沒有就 ask 用戶今天嘅 task**

---

## 第七部分：Task Type Classification（收到 task 後 AI 必先分類）

| 用戶請求 signal | Likely type | Required pre-doc |
|---|---|---|
| 「實作 Epic X Story Y」/ 對應 Story 文件存在 | Phase（新功能）| `docs/04-implementation/stories/epic-X/X.Y-*.md` + tech-spec 已 approved |
| 「改 X 嘅 behavior」/ 「加 Y 選項」/「修改 Z 邏輯」 | Change | `claudedocs/4-changes/feature-changes/CHANGE-{NNN}-{kebab}.md` |
| 「X 唔 work」/「broken」/「fail」/「regression」/「錯咗」 | Bug-fix | `claudedocs/4-changes/bug-fixes/FIX-{NNN}-{kebab}.md` |
| 「fix typo」/「rename variable」/「update comment」（< 30 min）| Trivial | 無需 doc，直接 commit |

**Protocol**：
1. AI **classify** based on signals
2. **Propose to user**：「我判斷呢個係 [Phase / Change / Bug-fix / Trivial]，建議走 X workflow，先準備 [story / CHANGE / FIX 文件]。OK?」
3. **Wait for user confirm**（or override）
4. **Open corresponding doc** before any code（用 `/plan-story` / `/plan-change` / `/plan-fix` skill）

---

## 第八部分：當前進度（AI 自查，唔需用戶手動更新）

新 session 開始，AI 用以下指令自查：

```bash
# 1. 看現在喺邊個 branch
git branch --show-current

# 2. 看 main 最近 commits（過去 task 痕跡）
git log main --oneline -10

# 3. 看當前 branch commits（若喺 feature branch）
git log $(git branch --show-current) --oneline --not main

# 4. 看 working tree 是否乾淨
git status --short

# 5. 看 sprint 狀態（唯一真實來源）
cat docs/04-implementation/sprint-status.yaml | head -50

# 6. 看最近 CHANGE / FIX
ls claudedocs/4-changes/feature-changes/ | tail -5
ls claudedocs/4-changes/bug-fixes/ | tail -5

# 7. 看 active OQ
cat docs/open-questions.md | head -50

# 8. Docker 服務狀態
docker-compose ps
```

**讀完上述後**，AI 應該能夠回答：
- 目前是否有 active feature branch？
- 最近完成嘅 CHANGE/FIX 編號到哪個？（FIX/CHANGE 最高編號 + 1 = 新編號）
- Working tree 有冇未 commit 嘅變更？
- 當前 Phase 2 治理重點仲有咩 open（Auth 覆蓋率 / Zod 覆蓋率 / console.log 清理 / RFC 7807 統一）？

---

## 第九部分：當前 Open Questions 狀態（詳見 `docs/open-questions.md`）

> **每 phase 完成或重大決策後同步**；權威 source = `docs/open-questions.md`

### 🟡 Open（5 條）

| # | 問題 | AI Default Behavior |
|---|------|--------------------|
| **OQ-Q1** | 信心度閾值文檔誤差（CLAUDE.md 95%/80% vs 代碼 90%/70%）| 以代碼為準（90%/70%），commit 標 `Note: depends on OQ-Q1` |
| **OQ-Q2** | Auth 覆蓋率缺口（60.7%，缺 130 routes 達 95% 基準）| 新 API 一律加 auth；舊 API 不主動補加 |
| **OQ-Q3** | RFC 7807 格式不一致（top-level vs nested）| 新 API 統一採 top-level；舊 API 漸進統一 |
| **OQ-Q4** | Zod 驗證覆蓋率 60-65%（缺 ~40 個 POST/PATCH）| 新 API 必加 Zod；舊 API 不主動補加 |
| **OQ-Q5** | console.log 279 處 / 87 文件 | 改動文件時順手替換 logger；不專門開 task |

**Default behavior for Open OQ**：用 spec/代碼 default 繼續，**在 commit message 標**：`Note: depends on OQ-Q<N>`（per CLAUDE.md §Open Questions 機制）。

---

## 第十部分：項目進度感知（Phase 1 已完成 + Phase 2 重點）

### Phase 1 — 開發階段（已完成）

- **22 Epic + 157+ Story** 全部 ✅ Done
- **80 份 codebase 分析** 已完成（整體驗證通過率 91.1%）
- **核心功能 ship**：發票上傳、提取、分類、審核、規則學習、報表、Forwarder 配置、多城市、Template Matching、i18n、企業安全

### Phase 2 — 功能變更模式（當前）

- **CHANGE 累計**：70 個 feature-change 規劃（最新：CHANGE-070-three-env-isolation-staging）
- **FIX 累計**：59 個 bug-fix 規劃（最新：FIX-056-x-dev-bypass-auth-hardening）
- **當前治理重點**（按優先順序）：
  1. **Azure 生產部署準備**（CHANGE-055 Phase 1 已 draft → Phase 2 dry-run validation done）
  2. **安全治理 95% 基準**：Auth 覆蓋率（CHANGE-057）/ Zod 覆蓋率（CHANGE-062）/ Rate Limit 擴展（CHANGE-063）/ SSRF 防護（CHANGE-064）
  3. **企業級加固**：Session 管理（CHANGE-058）/ 特權帳號 step-up auth（CHANGE-059）/ CSP headers（CHANGE-060）/ Email 安全告警（CHANGE-065）
  4. **治理基線文檔**（CHANGE-067）+ **韌性架構**（CHANGE-068 circuit breaker / retry / IR plan）
  5. **PII 殘留清理**（FIX-055）+ **x-dev bypass 強化**（FIX-056）

### 當前狀態快照（2026-05-26）

- **CLAUDE.md 升級至 v4.0.0**（Strict Mode framework 啟動）
- **Working tree 有 untracked 文件**：CLAUDE-Karpathy.md + CLAUDE_reference_from_EKP.md + 多個 CHANGE-056~070 + FIX-055~056 草稿
- **deployment 文件已重組**：`docs/06-deployment/` → `01-local-deployment/` + `02-azure-deployment/`（已 commit `9f93b22`）

---

## 第十一部分：常駐 Open Items / Carry-overs（每完成重大變更後更新）

> **此節要每完成大 CHANGE/FIX 後更新**：把「準備但未 ship」+「ship 後仍需 follow-up」嘅項目精煉成下方列表

### 已知未解（at session start time = 2026-05-26）

#### 🔴 Azure 生產部署相關

- **CHANGE-055 Azure 生產部署計劃**：Phase 1 已 draft + Phase 2 dry-run validation done → 待 Phase 3 實際部署觸發
- **CHANGE-069 ACA + ACR + Bicep 安全加固**：規劃中
- **CHANGE-070 三環境隔離（dev / staging / prod）**：規劃中

#### 🟡 安全治理（依 CLAUDE.md §當前 Open 差異）

- **Auth 覆蓋率 60.7%**（201/331），距 95% 基準缺 130 routes → CHANGE-057 + CHANGE-061 治理中
- **RFC 7807 格式不一致** → 新 API 統一採 top-level，舊 API 漸進統一
- **console.log 279 處 / 87 文件** → 漸進清理（改動文件時順手換）
- **Zod 驗證覆蓋率 60-65%** → 新 API 必加，~40 個 POST/PATCH 待補
- **CLAUDE.md 信心度閾值 95%/80% vs 代碼 90%/70%** → OQ-Q1 待用戶決策

#### 🟢 治理 / 文檔

- **CHANGE-067 治理基線文檔** → 規劃中
- **CHANGE-068 韌性架構（circuit breaker / retry / IR plan）**→ 規劃中
- **80 份 codebase 分析** 已完成 → 季度性 refresh 機制（`/refresh-codebase-analysis` skill）

---

## 第十二部分：累計 milestones（重大里程碑）

> **每完成大 CHANGE/FIX 後更新一行**

| 里程碑 | 日期 | 主要成果 |
|--------|------|----------|
| **Phase 1 開發完成** | 2026-Q1 之前 | 22 Epic + 157+ Story 全部 Done；codebase 成熟度高 |
| **Codebase 深度分析完成** | 2026-Q1 | 80 份分析（31 分析 + 5 diagrams + 44 驗證），整體驗證通過率 91.1% |
| **Phase 2 啟動** | 2026-Q2 | 轉入 CHANGE/FIX 模式；累計 70 CHANGE + 59 FIX |
| **FIX-050 ~ FIX-053 安全修復** | 2026-04-28 | PII leakage（auth.config.ts 6 處 console.log） + SQL injection（db-context.ts:87） + Rate limit Redis 遷移 + 智能路由衝突 修復 |
| **FIX-054 hardcoded user 修復** | 2026-04-28 | `dev-user-1` 替換為 overridable `SYSTEM_USER_ID` |
| **CHANGE-054 部署就緒** | 2026-04-28 | 一鍵 init + verify-environment + env.example 重寫 |
| **deployment 文件重組** | 2026-05-24 | `docs/06-deployment/` → `01-local-deployment/` + `02-azure-deployment/` 兩級分類 |
| **CHANGE-055 Azure 部署 Phase 1 draft** | 2026-05-24 | Azure 生產部署計劃草案 |
| **Phase 2 dry-run validation 完成** | 2026-05-25 | Dockerfile + seed artifacts 對齊 |
| **CLAUDE.md v4.0.0 Strict Mode** | 2026-05-26 | 升級至 Strict Mode framework：H1-H6 hard constraints + Karpathy 四守則 + When in Doubt 決策表 + Self-Verification Checklist + Quick Reference Card |

**累計**：Phase 1 完成（22 Epic / 157+ Story）+ Phase 2 70 CHANGE + 59 FIX + 80 份 codebase 分析 + CLAUDE.md v4.0.0 Strict Mode 啟動

---

## 第十三部分：行為規範（畀 AI 助手）

每次 reply 之前，確保：

### 必做

- [ ] 對齊 Karpathy baseline（think → simple → surgical → goal）
- [ ] 對齊 H1–H6 hard constraints（若觸發，**第一句就 STOP and explain**）
- [ ] 跨 Epic 修改前先讀對應 Story / tech-spec
- [ ] 開始 code 前確認該 task 已有對應 CHANGE-XXX / FIX-XXX 規劃文件（trivial fix 例外）
- [ ] 用 `/plan-story` / `/plan-change` / `/plan-fix` skill 建立規劃文件（不要徒手寫）
- [ ] **FIX/CHANGE 編號搜尋必須用全量 Glob**（`FIX-*.md` / `CHANGE-*.md` 無數字前綴）— 取最大編號 + 1
- [ ] commit message 用 Conventional Commits（`<type>(<scope>): <description>`）
- [ ] **完成 CHANGE/FIX → 更新規劃文件狀態為 ✅ 已完成**（dev-checklists 第 1 條 🔴 必須）
- [ ] 涉及 UI 字串 → i18n 3 語言同步（`npm run i18n:check`）
- [ ] 涉及 API → Zod 驗證 + RFC 7807 top-level 錯誤格式
- [ ] 涉及 console.log → 改用 logger（如改動該文件時順手換）
- [ ] 用**繁體中文**回覆（Hard Binding Strict Rule per CLAUDE.md §語言設定）

### Self-Verification Checklist（每個 task 完成前必跑，CLAUDE.md §Self-Verification）

1. 對應到哪個 CHANGE-XXX / FIX-XXX / Tech Spec？（quote 編號）
2. 有沒有 violate H1-H6？
3. 有沒有 violate Karpathy 四守則？（每行改動可 trace 回 user 請求嗎？）
4. TypeScript 類型檢查 pass？（`npm run type-check`）
5. ESLint pass 無 warning？（`npm run lint`）
6. 涉及 UI 字串 → i18n 3 語言同步？（`npm run i18n:check`）
7. 涉及 API → Zod 驗證 + RFC 7807 錯誤格式？
8. 涉及 Schema 變更 → migration 已建立 + dry-run 驗證？
9. 涉及 console.log → 改用 logger？
10. 完成 CHANGE/FIX → 規劃文件狀態更新為 ✅ 已完成？
11. Commit message 符合 Conventional Commits？

### Coding conventions 速查

- **TypeScript strict** + Next.js 15 App Router + Server Components default + shadcn/ui + Prisma 7.2 + Zod 驗證
- **業務邏輯文件必須**完整 JSDoc 頭部（`@fileoverview` / `@module` / `@since` / `@lastModified`）
- **i18n 命名空間 34 個 × 3 語言 = 102 JSON 檔**，新增 key 必須 3 語言同步
- **Naming**：`kebab-case.ts` filename / `PascalCase` 組件 / `camelCase` 函數 / `UPPER_SNAKE_CASE` 常數 / `PascalCase` 類型
- **Comments 解釋 why，唔係 what**；默認 NO comments，只在 WHY 非顯然時加（一行 max）
- **絕不 commit**：secret / API key / PII / `.env*` / `prisma/migrations/` 已部署檔案

### 絕不 touch 清單

- `.git/`
- `.env` / `.env.local` / `.env.production` / 任何含 credentials 嘅檔案
- `prisma/migrations/` 已部署到生產嘅 migration 檔案（只可加新，不可改舊）
- `docs/01-planning/prd/` v1.0 凍結版（如有更新需求 → 加 amendment file）
- `claudedocs/7-archive/` 歷史歸檔
- 用戶 working tree 中未追蹤嘅檔案（`??` 開頭，可能是 in-progress work — 先 `git status` 確認再動）

### 唔做

- [ ] **唔擅自啟動 / 重啟生產服務**（local dev server 可以，但 Azure / Docker volume 操作需先確認）
- [ ] **唔執行 `--no-verify` / `--force` git 命令**（除非用戶明確授權）
- [ ] **唔讓 AI 單方面決定不可逆操作**（git push --force / git mv 大量檔案 / git reset --hard）— 必須先報告
- [ ] **唔在規劃文件外擅自 refactor**（H3 trigger）
- [ ] **唔在 Phase 2 引入 Tier 2 feature**（GraphRAG / multi-agent / workflow builder）

---

## 第十四部分：今天嘅任務（**唯一需要用戶填寫嘅部分**）

> 喺每個新 session 開始，把整份 prompt copy 之後，只改下方呢一節即可。

```
今天嘅任務：__________________

例：
- 「實作 CHANGE-068 — 韌性架構（circuit breaker + retry + IR plan）」
  → AI 將先讀 CHANGE-068 規劃文件 + 識別需修改嘅 services，propose 實作順序 + 等用戶 approve

- 「修 FIX-057 — XXX 功能 broken」
  → AI 判斷 Bug-fix workflow，建議用 `/plan-fix` skill 建立 FIX-057-{kebab}.md，等用戶 confirm Sev + repro 先 investigate

- 「審查 CHANGE-067 治理基線文檔草稿」
  → AI 讀 CHANGE-067 規劃 + 提供 review 意見（不修改代碼）

- 「加 Azure Computer Vision OCR 取代 Document Intelligence」
  → AI 識別 H2 vendor change（trigger Hard Constraint），STOP and propose 替代方案表，等用戶 approve

- 「Sprint status sync — 重新掃描所有 CHANGE/FIX 完成狀態」
  → AI 讀 claudedocs/4-changes/ + 對比 sprint-status.yaml，列出 status mismatch + 建議更新

- 「Codebase 季度 refresh」
  → AI 啟動 `/refresh-codebase-analysis` skill，掃描 codebase + 對比 docs/06-codebase-analyze/ 舊版報告
```

---

## 附錄：本 prompt 自身嘅維護

### 何時更新

| 觸發 | 更新位置 |
|---|---|
| 完成重大 CHANGE / FIX | §11 Open Items（合併 carry-overs）+ §12 milestones（加一行）+ §9 OQ status（若有變）|
| 發現 CLAUDE.md 修訂（§Hard Constraints / §When in Doubt / §Self-Verification）| §2 最高指導原則 + §4 權威排序 + §13 Self-Verification Checklist |
| 新 Epic / 大功能完成 | §3 Epic 列表 + §10 項目進度感知 + §12 milestones |
| 重大 OQ resolved | §9 OQ status + `docs/open-questions.md` 同步 |
| CLAUDE.md 版本升級（如 v4.0.0 → v4.1.0）| §2 + §5 必讀文件 reference + §13 自檢項目 |

### 何時退役

- Phase 2 治理重點全部 ship（Auth 95% / Zod 95% / RFC 7807 統一 / console.log 清零）→ Phase 3 規劃啟動，本 prompt §10 + §11 重寫
- 新 Epic 大批引入（如 Tier 2 GraphRAG）→ §3 三層映射架構 + §10 Epic 列表 全部重寫

---

**Last Updated**：2026-05-26（**CLAUDE.md v4.0.0 Strict Mode 啟動** — 本 prompt 配合 v4.0.0 framework 重寫，採用 EKP session-start sample 結構 + 本項目 CHANGE/FIX 模式紀律。§1 項目介紹強調 Phase 2 增量模式；§2 三大最高原則加入 Karpathy 四守則 + 架構凍結 + Phase 2 範圍紀律；§3 三層映射 + 信心度路由 + 22 Epic 列表；§4 權威排序強調 PRD v1.0 frozen baseline；§6 CHANGE/FIX 模式取代 EKP rolling JIT phase planning；§7 task type classification 對應 `/plan-story` `/plan-change` `/plan-fix` skill；§8 自查指令；§9 5 條 Open OQ；§10 Phase 2 治理重點按優先順序；§11 carry-overs + Azure 部署 + 安全治理 + 治理文檔；§12 累計 milestones 含 CLAUDE.md v4.0.0；§13 Self-Verification 11 項 + 絕不 touch 清單 + Karpathy 守則；§14 6 個今天任務範例覆蓋 CHANGE / FIX / 審查 / Hard Constraint trigger / Sprint sync / Codebase refresh）
