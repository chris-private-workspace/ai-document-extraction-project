# AI Document Extraction Project - Claude Code 開發指引

> 本文件為 Claude Code AI 助手的 standing instructions，每個 session 自動載入。
> **採用 Strict Mode**：規則一旦 lock 不可單方面改；違反 Hard Constraints (§Hard Constraints) 必須 STOP and ask。
> 詳細規範拆分至 `.claude/rules/` 和 `claudedocs/reference/`，本文件只保留**行為規則 + 路徑索引**，不含可變動的統計記錄。

---

## 🗣️ 語言設定（🔴 必須遵守 - Binding Strict Rule）

> **核心規則**：AI 助手在所有對話中**必須全程使用繁體中文**。違反 = task 未完。

| 場景 | 語言 | 強制等級 |
|------|------|----------|
| **用戶對話與回應** | 繁體中文 | 🔴 必須（無例外） |
| **代碼註釋** | 中文或英文 | 🟡 依上下文 |
| **Commit Message** | 英文 | 🟡 Conventional Commits |
| **技術文檔** | 繁體中文為主 | 🟡 claudedocs/ docs/ |
| **代碼中的 UI 字串** | i18n key | 🔴 禁止硬編碼 |

### 唯一可保留原文的 6 類

1. 程式碼識別符（`calculateConfidenceScore`、變數名）
2. 檔案路徑（`src/services/extraction-v3/`）
3. API 端點（`/api/documents/upload`）
4. Commit hash + branch 名
5. CHANGE/FIX 編號、文檔 section 編號（CHANGE-068、§3.2、H1-H6）
6. Vendor/產品名（Azure OpenAI、Prisma、Next.js）

**Hard enforcement gate**：每段 reply 之前 + 完成後**必須自檢**——scan 全文，任何 non-code 英文 phrase（如 "Status"、"Next"、"Done"、"pending"、"verdict"）= violation，立即翻譯。

> 📋 常違反詞彙對照表 + 高風險回覆類型：`.claude/rules/language.md`

---

## 📋 項目概覽

**使命**：建立 AI 驅動的文件提取與分類系統，解決 SCM 部門 Freight Invoice 處理效率問題。

**核心目標**：450K-500K 張發票/年（APAC）| 自動化率 90-95% | 準確率 90-95% | 節省 35-40K 人時/年

### 核心架構 - 三層映射系統

```
TIER 1: Universal Mapping (通用層)           — 70-80% 常見術語，所有 Forwarder 通用
TIER 2: Forwarder-Specific Override (覆蓋層) — 只記錄該 Forwarder 與通用規則的差異
TIER 3: LLM Classification (AI 智能分類)     — 以上都無法匹配時用 GPT-5.2
```

### 信心度路由機制

| 信心度 | 處理方式 | 說明 |
|--------|----------|------|
| ≥ 95% | AUTO_APPROVE | 自動通過 |
| 80-94% | QUICK_REVIEW | 快速確認 |
| < 80% | FULL_REVIEW | 完整審核 |

**V3.1 智能降級**：新公司 → 強制 FULL_REVIEW；新格式 → 強制 QUICK_REVIEW；DEFAULT 配置來源 → 降一級

> ⚠️ **已知文檔誤差**：代碼實際閾值為 90%/70%（confidence-v3-1.service.ts 第 112-119 行），與文檔 95%/80% 不一致 — 屬 Open Question，詳見 `claudedocs/reference/known-discrepancies.md`

---

## 🛠️ 技術棧

**核心**：Next.js 15 + TypeScript 5.0 + Prisma 7.2 + PostgreSQL 15
**OCR**：Azure Document Intelligence | **AI**：Azure OpenAI GPT-5.2 | **認證**：Azure AD SSO + 本地帳號
**i18n**：next-intl 4.7（en/zh-TW/zh-CN）| **狀態**：Zustand + React Query | **驗證**：Zod | **測試**：Playwright

> 📋 完整技術棧（含版本、套件、設定）：`claudedocs/reference/tech-stack.md`
> 📋 代碼規模統計：`docs/06-codebase-analyze/00-analysis-index.md`

---

## 📁 目錄結構（精簡）

```
ai-document-extraction-project/
├── .claude/              # Claude Code 配置（rules/ + agents/ + skills/）
├── claudedocs/           # AI 助手文檔（7 層分類）
├── docs/                 # 項目正式文檔（discovery/planning/architecture/stories/codebase-analyze）
├── messages/             # i18n 翻譯（en/zh-TW/zh-CN × 34 命名空間）
├── prisma/               # Schema（122 models + 113 enums）
├── python-services/      # Python 後端（extraction/ + mapping/）
├── src/                  # 主代碼（app/ components/ services/ hooks/ lib/ types/）
└── tests/                # unit/ integration/ e2e/
```

> 📋 完整目錄結構（含 API 路由、Agent/Skill 詳表）：`claudedocs/reference/directory-structure.md`

---

## 🚨 Hard Constraints — Strict Mode（🔴 違反即 STOP and ask）

以下情況**必須**立即停止寫 code，向用戶說明並等待 approval：

### H1 — Architectural Change Constraint

**Trigger**：擅自偏離 PRD / Tech Spec / 三層映射架構 / 信心度路由邏輯 / 122 Prisma models 結構 / 既定 vendor

**Required behavior**：
1. STOP 寫 code
2. 說明 (a) 想做什麼改變 (b) 為何原設計不適用 (c) 替代方案
3. 等用戶 approve 後繼續，並記錄在對應 CHANGE-XXX 文件

**例外（可自行做）**：bug fix、內部 refactor 不改 interface、加 internal helper、UI polish

### H2 — Dependency / Vendor Constraint

**Trigger**：加新 npm 套件、換 vendor（OCR / AI / 認證 / 儲存）、改 Prisma datasource

**Required behavior**：STOP → 解釋為何現有 stack 不夠 → 等 approval

**例外**：純 utility（dev dependency / type stubs / 已通過 review 的 minor patch）

### H3 — Task Scope Constraint

**Trigger**：在當前 CHANGE/FIX 範圍**外**新增功能、refactor 周邊代碼、加用戶未要求的 flexibility / configurability

**Required behavior**：STOP → surface「這超出 task scope」→ 讓用戶決定新建 CHANGE 還是放回 backlog

**例外**：清理你自己改動造成的 orphan（unused import / variable / function）

### H4 — Security & Privacy Constraint

**禁止**：
- log PII（user email、phone、token）到 plaintext file
- commit secrets / API keys / connection strings
- hardcode tenant ID、subscription ID、resource name
- 客戶端組件直接訪問資料庫

**例外**：無

### H5 — i18n & Hard-coding Constraint

**Trigger**：代碼中硬編碼 UI 字串、新增常量但忘記更新 3 語言翻譯、新增命名空間但忘記註冊 `src/i18n/request.ts`

**Required behavior**：必須同步更新 `messages/en/`、`messages/zh-TW/`、`messages/zh-CN/`，並執行 `npm run i18n:check`

### H6 — Design Deviation Constraint

**Trigger**：實作偏離 Tech Spec / Design 規格 / 既定 UX pattern / 既定組件用法

**Required behavior**：STOP → 說明 deviation 原因 → 提供替代方案 → 等用戶決定（**絕對不可擅自 approximate**）

> 📋 完整 H1-H6 規範（trigger 細節、required behavior 步驟、技術債務記錄格式、詢問模板）：`.claude/rules/hard-constraints.md`

---

## 🎯 編碼核心原則 — Karpathy Guidelines（🔴 必須遵守）

> **來源**：`andrej-karpathy-skills:karpathy-guidelines` plugin（`alwaysApply: true`）
> **適用範圍**：**所有** code change / review / refactor — 與項目特定規則並行，優先級**僅次於 §Hard Constraints**
> **取向**：本 guideline **bias toward caution over speed**。Trivial task 可用 judgment 簡化，**non-trivial task 必須跟**

### 四守則速覽

| 守則 | 核心句 |
|------|------|
| **1. Think Before Coding** | Don't assume. Don't hide confusion. Surface tradeoffs. |
| **2. Simplicity First** | Minimum code that solves the problem. Nothing speculative. |
| **3. Surgical Changes** | Touch only what you must. Clean up only your own mess. |
| **4. Goal-Driven Execution** | Define success criteria. Loop until verified. |

---

### 1.1 Think Before Coding — 動手前先思考

**開始實作之前**：
- 把 assumption **明確陳述出來**；不確定就問，**不要估**
- 多種詮釋 → **全部 present**，不要默默選一個
- 有更簡單方案 → **講出來**，必要時 push back
- 不清楚就 STOP，**明確指出哪裡混淆**，然後問

**自我檢查**：我是否默默做了假設？是 → 浮現出來

> 與 §When in Doubt「ask, don't guess」互相強化

### 1.2 Simplicity First — 最少代碼解決問題

**禁止**：
- ❌ 不加未要求的 feature
- ❌ 不為 single-use code 做 abstraction layer
- ❌ 不加未 request 的「flexibility」「configurability」
- ❌ 不處理**不可能發生**的 error scenario
- ✅ 寫了 200 行但其實 50 行夠 → **重寫**

**自我檢查**：「senior engineer 會說這段 over-engineered 嗎？」答 yes 就簡化

> 對應 §When in Doubt「Performance vs simplicity → simplicity wins」

### 1.3 Surgical Changes — 外科手術式修改

**改 existing code 時**：
- ❌ **不要**「順手」改 adjacent code / comment / formatting
- ❌ **不要** refactor 沒壞掉的東西
- ✅ **Match existing style**，即使你 prefer 另一種寫法
- ✅ 見到無關的 dead code → **mention，但不要刪**

**改動製造的 orphan**（import / variable / function 因你的改動而 unused）：
- ✅ **要刪**（你製造的 mess 自己清）
- ❌ **不要**刪 pre-existing dead code（除非用戶要求）

**驗證標準**：**每一行改動都可以 trace 回用戶的 request**

> 強化 §絕不 touch 清單 — 此處是 mindset，§絕不 touch 是硬規則

### 1.4 Goal-Driven Execution — 目標驅動執行

**把 task 轉成 verifiable goal**：
- 「Add validation」→「寫 test for invalid input，然後 make them pass」
- 「Fix the bug」→「寫 test 重現 bug，然後 make it pass」
- 「Refactor X」→「Refactor 前後 test 都 pass」

**Multi-step task 先列 plan**：
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

**Strong success criteria** → 你可以獨立 loop 到通過
**Weak criteria**（如「make it work」）→ 會逼用戶不斷 clarify

> 與 §Self-Verification Checklist 互補 — §Self-Verification 是 task **完成的 gate**，§1.4 是 task **開始的 framing**

---

### 生效訊號（如何驗證 guideline 真的在運作）

- ✅ Diff 中 unnecessary change **變少**
- ✅ 因 over-engineering 而要重寫的情況**變少**
- ✅ Clarifying question 出現在 implementation **之前**，而不是 mistake 之後

---

## 🤔 When in Doubt — 模糊情況決策表

| 情況 | Default |
|------|---------|
| Spec 與 idea 衝突 | Spec wins，除非 explicit approval |
| Spec 缺乏 detail | **Ask user，don't guess** |
| 兩種實作都 reasonable | 揀**更接近既有 pattern** 的一個（grep 同類功能參考） |
| Stakeholder feedback 與 spec 衝突 | STOP — surface conflict 等 resolution |
| 信心度閾值邊界值（如 80.0 vs 80.1） | 跟代碼實際值（90%/70%），不跟文檔（95%/80%）— 文檔誤差待修 |
| 三層映射不確定該歸哪層 | Default 通用層（Tier 1），有公司差異才下沉 Tier 2 |
| i18n 翻譯不確定 | 3 語言都先用英文 placeholder + TODO + ask 用戶 |
| Performance vs simplicity 衝突 | 當前階段 **simplicity wins**（先 ship，profile 後再優化） |
| Tier 2 功能順手做 | 不做 — 記入 backlog，超出 task scope |
| Migration 不確定資料相容性 | STOP — 先寫 dry-run 驗證 script |
| API 錯誤格式選 top-level 或 nested | 新 API 統一採 RFC 7807 **top-level** |

---

## ✅ Self-Verification Checklist（每個 task 完成前必跑）

- [ ] 對應到哪個 CHANGE-XXX / FIX-XXX / Tech Spec？（quote 編號）
- [ ] 有沒有 violate H1-H6？（若有，task 未完）
- [ ] 有沒有 violate Karpathy 四守則？（每行改動可 trace 回 user 請求嗎？）
- [ ] TypeScript 類型檢查 pass？（`npm run type-check`）
- [ ] ESLint pass 無 warning？（`npm run lint`）
- [ ] 涉及 UI 字串 → i18n 3 語言同步？（`npm run i18n:check`）
- [ ] 涉及 API → Zod 驗證 + RFC 7807 錯誤格式？
- [ ] 涉及 Schema 變更 → migration 已建立 + dry-run 驗證？
- [ ] 涉及 console.log → 改用 logger？
- [ ] 完成 CHANGE/FIX → 規劃文件狀態更新為 ✅ 已完成？
- [ ] Commit message 符合 Conventional Commits？

---

## 🚫 絕不 touch 清單

- `.git/`
- `.env`、`.env.local`、`.env.production`、任何含 credentials 的檔案
- `prisma/migrations/` 已部署到生產的 migration 檔案（只可加新，不可改舊）
- `docs/01-planning/prd/` v1.0 凍結版（如有更新需求 → 加 amendment file）
- `claudedocs/7-archive/` 歷史歸檔
- 用戶 working tree 中未追蹤的檔案（`??` 開頭，可能是 in-progress work — 先 `git status` 確認再動）

---

## 📐 代碼規範（摘要）

### 文件頭部 JSDoc（業務邏輯文件必須）

`src/services/`、`src/app/api/`、`src/hooks/`、`src/lib/`、Feature Components → 必須完整頭部（`@fileoverview`、`@module`、`@since`、`@lastModified`）
UI Components (`src/components/ui/`) → 不需要 | Type Definitions → 簡化版

### 命名規範

| 類型 | 規範 | 範例 |
|------|------|------|
| 文件名 | kebab-case | `use-document-upload.ts` |
| 組件 | PascalCase | `DocumentUploadForm.tsx` |
| 函數 | camelCase | `calculateConfidenceScore` |
| 常數 | UPPER_SNAKE_CASE | `MAX_FILE_SIZE` |
| 類型/介面 | PascalCase | `DocumentMetadata` |
| Enum 值 | UPPER_SNAKE_CASE | `Status.PENDING_REVIEW` |

> 📋 JSDoc 模板與代碼範例：`.claude/rules/general.md`
> 📋 TypeScript 完整規範：`.claude/rules/typescript.md`
> 📋 API 設計 + RFC 7807：`.claude/rules/api-design.md`
> 📋 組件開發規範：`.claude/rules/components.md`
> 📋 資料庫規範：`.claude/rules/database.md`
> 📋 服務層規範：`.claude/rules/services.md`
> 📋 測試規範：`.claude/rules/testing.md`

---

## 🌐 i18n 同步規則（摘要）

**框架**：next-intl 4.7 | **支援**：en / zh-TW / zh-CN | **命名空間**：34 個/語言 = 102 JSON 檔

**核心規則**：
1. 修改 `src/types/*.ts`、`src/constants/*.ts` 含 `label`/`description` 的常量 → 必須同步 i18n
2. 新增命名空間 → 建立 3 個語言 JSON + 在 `src/i18n/request.ts` `namespaces` 陣列註冊
3. 完成前執行 `npm run i18n:check`

> 📋 完整 i18n 規範 + 34 命名空間列表 + 常量映射表：`.claude/rules/i18n.md`

---

## 🔧 開發工作流

```bash
# 啟動
docker-compose up -d
npm install
npx prisma generate          # ⚠️ 跨電腦/清快取後必須跑，否則 middleware 500
npx prisma migrate dev
npm run dev -- -p 3200       # 推薦備用端口

# 提交前檢查
npm run type-check
npm run lint
npm run format
npm run test
```

> 📋 服務啟動完整流程 + 端口處理 + 問題排解：`.claude/CLAUDE.md`

### 工作單元完成後的提交確認（🔴 必須主動提示）

> **核心規則**：完成一個明確的工作單元後，AI **必須主動詢問**用戶是否提交，**不可擅自**執行 git 操作。

**觸發時機**：完成一個 phase / sprint / story / CHANGE-XXX / FIX-XXX / 用戶交辦的 task，且其 verifiable goal 已達成（`type-check` / `lint` / `test` 通過，或用戶明示告一段落）。

**必須詢問的三件事**：

| 步驟 | 詢問內容 | 一併提供 |
|------|----------|----------|
| 1. Commit | 是否提交本次改動 | 改動檔案清單 + 建議的 Conventional Commits message |
| 2. Push | 是否推送到遠端分支 | 目標分支名稱 |
| 3. 建 PR | 是否建立 Pull Request | 建議的 PR 標題 + 摘要 + base 分支 |

**規則**：
- 🔴 AI **絕不擅自** commit / push / 建 PR — 除非用戶在當前對話已 explicit 授權
- 用戶可選擇全部、部分或都不做（例如只 commit 不 push）
- 提示需精簡：一段話列出三個選項 + 建議的 commit message，等用戶回應
- 此規則與 §Self-Verification Checklist 互補：先跑完自驗證，通過後才提示提交

---

## 🤖 AI 開發輔助

### 並行 Agent 編排（摘要）

**觸發**：2+ 獨立 CHANGE/FIX | 大功能可拆 ≥3 模組 | >5 文件且各自獨立 | 用戶明確要求

**流程**：探索規劃 → 並行派發（`run_in_background: true`）→ 監控彙總（TaskUpdate）→ 統一驗證 → 統一 Commit（僅用戶要求）

**Agent 選擇**：`code-implementer`（寫代碼）| `code-quality-checker`（規則檢查）| `i18n-guardian`（翻譯同步）| `architecture-reviewer`（設計驗證）| `Explore`（代碼搜尋）

**禁止**：並行修改同一文件、Agent 內 Commit、有依賴的任務並行（用 `addBlockedBy` 串接）

> 📋 完整協議（觸發條件細節、Agent 詳表、進度追蹤格式、衝突處理、worktree 隔離）：`.claude/rules/agent-orchestration.md`

### Session Start Protocol

每個 session 開始時 AI 必須：
1. 讀 `claudedocs/6-ai-assistant/prompts/SITUATION-1.md`（PROJECT-ONBOARDING）
2. 讀對應情境 SITUATION（feature dev = SITUATION-2/4；enhancement = SITUATION-3；save progress = SITUATION-5）
3. Run `git status --short` + `git log --oneline -5`

**`/compact` 後特殊處理**：必須 re-read 步驟 1-2，因為 compact 對 standing instructions retention 只有 ~60%

### 技術障礙處理

遇到技術障礙 → STOP 寫 code → 調查根因（至少 3 種方法）→ 記錄調查過程 → 仍無法解決則 ask 用戶（含替代方案表）→ 若採替代方案 → 記錄技術債務

> 📋 詳細流程 + 詢問模板 + 技術債務記錄格式：`.claude/rules/technical-obstacles.md`

---

## ❓ Open Questions 機制

當設計決策有 **未解決問題**（用戶未拍板、文檔誤差待修、規格與代碼不一致），AI 按以下處理：

| 狀態 | 行為 |
|------|------|
| **Open** | 用 spec/代碼 default 繼續，但 commit message 標註 `Note: depends on OQ-Q<N>` |
| **Resolved** | 直接用 resolved value |
| **Blocked** | STOP 對應 work item，ask user |

> 📋 當前 OQ 列表：`docs/open-questions.md`
> ⚠️ 當前主要 OQ：信心度閾值文檔誤差、Auth 覆蓋率缺口、RFC 7807 格式統一進度

---

## 📚 文檔索引

### ClaudeDocs（AI 助手文檔）
> **完整索引**：`claudedocs/CLAUDE.md`（7 層：planning / sprints / progress / changes / status / ai-assistant / archive / reference）

### 情境提示詞（SITUATION）
位置：`claudedocs/6-ai-assistant/prompts/SITUATION-*.md`
- **SITUATION-1**：項目入門 | **SITUATION-2**：功能開發前分析 | **SITUATION-3**：功能增強
- **SITUATION-4**：新功能實作 | **SITUATION-5**：保存進度 | **SITUATION-6**：服務啟動 | **SITUATION-7**：Seed 數據維護

### 按需查閱
| 需要了解 | 路徑 |
|---------|------|
| Sprint 狀態（唯一真實來源） | `docs/04-implementation/sprint-status.yaml` |
| Codebase 全面分析（80 份） | `docs/06-codebase-analyze/00-analysis-index.md` |
| PRD | `docs/01-planning/prd/prd.md` |
| Tech Specs | `docs/03-stories/tech-specs/` |
| 系統架構設計 | `docs/02-architecture/` |
| 部署文件中心 | `docs/07-deployment/README.md` |
| 本地 vs Azure 部署差異 | `docs/07-deployment/local-vs-azure-differences.md` |
| 開發後檢查清單 | `claudedocs/reference/dev-checklists.md` |
| 項目進度與歷史 | `claudedocs/reference/project-progress.md` |
| Sub-CLAUDE.md 地圖 | `claudedocs/reference/sub-claude-md-map.md` |
| 已知差異記錄（含已修復） | `claudedocs/reference/known-discrepancies.md` |
| 完整技術棧清單 | `claudedocs/reference/tech-stack.md` |
| Open Questions 列表 | `docs/open-questions.md` |

---

## 🖥️ 跨電腦開發協作

本項目在多台電腦同步開發。

| 命令 | 用途 |
|------|------|
| `/git-status` | 快速狀態檢查（Git + Docker + 開發伺服器） |
| `/git-sync` | 完整同步流程（拉取/推送 + 依賴/Schema 偵測） |

**切換電腦標準流程**：`/git-sync` → `docker-compose up -d` → `npm run dev -- -p 3300`

**關鍵注意事項**：
- DATABASE_URL 端口 **5433**（非 5432）
- 跨電腦複製後必須 `rm -rf .next`
- 拉取後可能需要 `npx prisma db push --accept-data-loss`
- 新環境首次需 `npx prisma db seed`

> 📋 完整初始化指南：`docs/07-deployment/01-local-deployment/project-initialization-guide.md`

---

## 📊 項目狀態

**進度**：22 個 Epic（157+ Stories）已完成 | **當前階段**：Phase 2 功能變更模式
> Sprint 唯一真實來源：`docs/04-implementation/sprint-status.yaml`

**Sub-CLAUDE.md 自動載入機制**：Claude Code 自動遞迴載入子目錄 CLAUDE.md（共 15 個：.claude/、claudedocs/、messages/、prisma/、src/* 等）— 修改子目錄時對應的 sub-CLAUDE.md 會自動注入 context
> 完整地圖 + 過時統計：`claudedocs/reference/sub-claude-md-map.md`

**Codebase 深度分析**：80 份文檔（31 分析 + 5 diagrams + 44 驗證），整體驗證通過率 91.1%
> 主索引：`docs/06-codebase-analyze/00-analysis-index.md`

---

## ⚠️ 當前 Open 差異（精簡）

| # | 項目 | 狀態 |
|---|------|------|
| 1 | Auth 覆蓋率 60.7%（201/331），距 95% 基準缺 130 routes | ⚠️ Phase 2 治理中 |
| 2 | RFC 7807 格式不一致（top-level vs nested）— 新 API 統一採 top-level | ⚠️ 漸進統一 |
| 3 | console.log 279 處 / 87 文件 — 逐步替換 logger | ⚠️ 漸進清理 |
| 4 | Zod 驗證覆蓋率 60-65%，~40 個 POST/PATCH 缺驗證 | ⚠️ 新 API 必加 |
| 5 | CLAUDE.md 信心度閾值 95%/80% vs 代碼 90%/70% | ⚠️ 文檔待修 |

> 📋 完整差異記錄（含已修復的 FIX-050/051/052/053）：`claudedocs/reference/known-discrepancies.md`

---

## 📌 Quick Reference Card

```
AI Document Extraction — Strict Mode
├─ 語言: 繁體中文 (6 類例外: code/path/API/hash/編號/vendor)
├─ 行為基準: Karpathy 4 守則 (think → simple → surgical → goal-driven)
├─ 核心架構: 三層映射 (Universal → Forwarder Override → LLM) + 信心度路由
├─ 技術棧: Next.js 15 + Prisma + PostgreSQL + Azure OpenAI GPT-5.2
├─ Hard Constraints (STOP+ask on trigger):
│  ├─ H1 — 擅自改設計 / 三層映射 / 信心度邏輯 / Prisma 結構
│  ├─ H2 — 加 dependency / 換 vendor
│  ├─ H3 — 超出 task scope 加功能
│  ├─ H4 — Security / PII / Secrets
│  ├─ H5 — Hard-code UI 字串 / i18n 不同步
│  └─ H6 — 偏離設計規格 (絕不擅自 approximate)
├─ 完成前必跑: Self-Verification Checklist (§Self-Verification)
└─ When in doubt: ASK, DON'T GUESS
```

---

## 📝 版本資訊

- **CLAUDE.md 版本**：4.0.0
- **最後更新**：2026-05-26
- **本版重大變更**（v3.4.1 → v4.0.0）：
  - **大幅精簡**：~570 行 → ~500 行（規則密度從 ~40% 提升到 ~70%）
  - **移除記錄類內容**（全部 redirect 到 reference）：技術棧詳細列表 / 代碼規模統計 / Sub-CLAUDE.md 完整地圖 / 開發編排協議詳情 / 已修復差異記錄 / 重複 ClaudeDocs 表 / i18n 完整命名空間列表
  - **新增**：§Hard Constraints H1-H6（Strict Mode 結構化）
  - **新增**：§When in Doubt 模糊情況決策表
  - **新增**：§Self-Verification Checklist（task 完成前 11 項自驗證）
  - **新增**：§絕不 touch 清單
  - **新增**：§Open Questions 機制
  - **新增**：§Quick Reference Card（context 壓縮時的 anchor）
  - **新增**：Session Start Protocol + `/compact` 後特殊處理
  - **強化**：語言設定 — 加 6 類唯一例外 + Hard enforcement gate
  - **強化**：Karpathy 守則 — 保留 v3.4.1 四守則表格 + 擴充每條的具體行為 / 禁止事項 / 自我檢查問題 / 交叉引用，並新增「生效訊號」自評區（參考 EKP CLAUDE.md §1 結構）

- **完整版本歷史**：`claudedocs/reference/project-progress.md`
