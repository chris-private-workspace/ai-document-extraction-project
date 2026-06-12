# Story 22.5: 單元測試框架建立

**Status:** 🚧 進行中（階段 1：Vitest 框架 + smoke test 完成 2026-06-12；6 大安全測試 + CI tests.yml + 文檔待階段 2）

---

## Story

**As a** 開發者與安全治理負責人,
**I want** 在本專案安裝 Vitest 測試框架並建立完整測試結構，補齊 auth / permission / Zod / rate limit / audit log 等安全相關邏輯的單元測試,
**So that** 任何 refactor 或新功能都不會引入安全回歸；CI 強制覆蓋率 ≥ 60% 起步，半年內提升至 80%。

---

## 背景說明

### 問題陳述

依 `phase2-sdlc-assessment.md` SDLC-10 評為 **L0**：

- `package.json` devDependencies **無** `jest` / `vitest` / `mocha` / 任何 test runner
- `package.json` scripts **無** `test` / `test:watch` / `test:coverage`
- 唯一測試文件 `tests/unit/services/batch-processor-parallel.test.ts` 用 `describe`/`it`/`expect` 但**無 runner 可執行**——孤兒測試
- `auth|permission|validation|security` 在 `tests/` 中 grep → 0 hits
- `.claude/rules/testing.md` 規範**假設使用 Vitest**，但實際未安裝——**規範與現實脫節**
- 22 個 Epic / 200 服務 / 331 API routes 全部沒有單元測試保護

### 對應風險

- **SDLC-10**（單元測試）：🟡 MED，目前 L0
- 影響後續 Story：22-3（Prompt Injection 迴歸測試）、22-4（CI 中 unit-tests check）的硬性前置依賴
- 矩陣 §7.1 SDLC-10 基準：「auth middleware、Zod schema、permission check、rate limit 邏輯有測試」

### 設計決策

- **使用 Vitest 而非 Jest**：
  - Next.js 15.0.0 + Vite 生態相容性更好（雖然 Next.js 用 webpack，但 Vitest 對 ESM / TypeScript 支援更佳）
  - `.claude/rules/testing.md` 已假設使用 Vitest（與規範對齊，避免再變動）
  - 啟動速度更快（HMR-style watch mode）
  - 與 Vite 生態的 mock / fixture 工具（如 `msw`）相容
- **使用 Istanbul（@vitest/coverage-istanbul）做覆蓋率**：c8 在 Windows 環境偶有問題
- **覆蓋率分階段**：60%（起步）→ 70%（3 個月）→ 80%（半年）
- **測試結構分層**：`tests/unit/` + `tests/integration/`（既有 `tests/e2e/` 由 Playwright 處理，不在本 story 範圍）

### 不在範圍

- ❌ E2E 測試（Playwright 已存在）
- ❌ 視覺迴歸測試
- ❌ 效能測試
- ❌ 100% 覆蓋率（不切實際，目標 80%）

---

## Acceptance Criteria

### AC1: Vitest 安裝與配置

**Given** 專案 `package.json`
**When** 執行 `npm install`
**Then** 下列 devDependencies 已安裝：
  - `vitest@^2.1.0`
  - `@vitest/coverage-istanbul@^2.1.0`
  - `@testing-library/react@^16.0.0`（為日後組件測試準備，本 story 不寫組件測試）
  - `@testing-library/jest-dom@^6.5.0`
  - `happy-dom@^15.0.0`（DOM 模擬，比 jsdom 快）
  - `vite-tsconfig-paths@^5.0.0`（解析 tsconfig path alias）
**And** `vitest.config.ts` 存在於專案根目錄
**And** `package.json` scripts 新增：
  - `test` → `vitest run`
  - `test:watch` → `vitest`
  - `test:coverage` → `vitest run --coverage`
  - `test:ui` → `vitest --ui`

### AC2: 測試結構建立

**Given** 專案 `tests/` 目錄
**When** 完成本 story
**Then** 目錄結構符合：
```
tests/
├── unit/
│   ├── services/        # 業務邏輯測試
│   ├── middlewares/     # auth / audit / rate-limit middleware 測試
│   ├── lib/             # 工具庫測試
│   └── utils/           # 共用測試工具
├── integration/
│   ├── api/             # API 端點整合測試（用 next-test-api-route-handler 或 supertest）
│   └── services/        # 多服務整合測試
├── e2e/                 # 既有，不變
├── fixtures/            # 測試固定資料
│   ├── pdf-samples/
│   └── prompt-injection-samples/
├── mocks/               # 共用 mock
│   ├── prisma.ts
│   ├── next-auth.ts
│   ├── azure-blob.ts
│   └── openai.ts
└── setup.ts             # 全域 beforeEach / afterEach
```
**And** 既有 `tests/unit/services/batch-processor-parallel.test.ts` 可被 Vitest 執行（去掉孤兒狀態）

### AC3: 測試覆蓋率報告（Istanbul）

**Given** 執行 `npm run test:coverage`
**When** Vitest 跑完所有 tests
**Then** 產生 HTML 報告於 `coverage/index.html`
**And** 產生 lcov 格式於 `coverage/lcov.info`（供 CI 上傳）
**And** terminal 輸出 summary table（lines / branches / functions / statements）
**And** `vitest.config.ts` 中 coverage thresholds：
  - 第 1-3 個月：lines ≥ 60%、branches ≥ 50%、functions ≥ 60%
  - 3-6 個月：lines ≥ 70%
  - 半年後：lines ≥ 80%
**And** 排除以下路徑（`coverage.exclude`）：
  - `**/*.test.ts`、`**/*.spec.ts`
  - `tests/**`
  - `prisma/migrations/**`
  - `.next/**`、`node_modules/**`
  - `messages/**`（純 i18n 資料）
  - 自動生成檔案（`*.gen.ts`）

### AC4: 安全測試覆蓋 — auth middleware（withAuth HOF）

**Given** 既有 auth middleware（`src/middlewares/`、`src/lib/auth/` 或 `auth.ts`）
**When** 跑 `npm run test`
**Then** 至少覆蓋以下測試 case：
  - 未 authenticated 使用者 → 回傳 401
  - 認證有效但無權限 → 回傳 403
  - 認證有效且有權限 → 通過 handler
  - `X-Dev-Bypass-Auth` 在 NODE_ENV=production 必須無效（呼應 IAM-06b）
  - Session expired → 回傳 401
  - JWT tampered → 回傳 401
**And** 測試覆蓋率：auth middleware 文件 ≥ 80%

### AC5: 安全測試覆蓋 — Permission 檢查邏輯

**Given** RBAC permission 檢查邏輯（`src/lib/auth/permissions.ts` 或同等位置）
**When** 跑測試
**Then** 至少覆蓋：
  - 角色 → permission 對應表正確（每個角色各跑一遍）
  - `hasPermission(user, 'INVOICE_CREATE')` 正向 case
  - `hasPermission(user, 'INVOICE_DELETE')` 反向 case
  - 多 permission AND / OR 組合
  - city-level permission 檢查（呼應既有 city-filter middleware）
**And** 測試覆蓋率：permission helper ≥ 90%

### AC6: 安全測試覆蓋 — Zod schema 驗證

**Given** `src/lib/validations/` 下 9 個既有 schema（exchange-rate / field-definition-set / outlook-config / pipeline-config / prompt-config / reference-number / region / role / user）
**When** 跑測試
**Then** 每個 schema 至少有：
  - 1 個 happy-path 測試（valid input → parse 成功）
  - 1 個 invalid-input 測試（每個必填欄位缺失各 1 個 case）
  - 1 個 boundary 測試（最大長度、最小長度、enum 邊界）
  - 1 個 SQL injection / XSS payload 測試（確認 schema 不會放過危險字串——雖 Zod 不防 injection，但確保 type narrow）
**And** 測試覆蓋率：`src/lib/validations/` ≥ 90%

### AC7: 安全測試覆蓋 — Rate limit 邏輯

**Given** `src/services/rate-limit.service.ts`（FIX-052 修復後的雙模式 service）
**When** 跑測試
**Then** 至少覆蓋：
  - Redis 模式：成功 increment、達到 limit 時拒絕
  - In-memory fallback 模式：Redis 連線失敗自動降級
  - TTL 行為：到期後重置
  - Edge case：concurrent requests 不會 race condition（用 `Promise.all` 模擬）
  - White list（服務帳號）跳過限制
**And** 測試覆蓋率：rate-limit.service.ts ≥ 85%

### AC8: 安全測試覆蓋 — Audit log 中間件

**Given** `src/middlewares/audit-log.middleware.ts`（withAuditLog HOF）
**When** 跑測試
**Then** 至少覆蓋：
  - 成功的 mutation → 寫入 AuditLog（CREATE / UPDATE / DELETE 三種 action）
  - 失敗的 mutation → 仍寫入 AuditLog（status=`FAILED`）
  - userId 為 null 時的處理（系統呼叫場景）
  - PII 遮罩：email、token 不會出現在 changes 欄位
  - cityCode 來自 db-context 正確傳遞
**And** 測試覆蓋率：audit-log middleware ≥ 80%

### AC9: CI 中強制執行（覆蓋率 ≥ 60% 起步）

**Given** GitHub Actions（依 Story 22-4 已建立）
**When** PR 觸發
**Then** 新增 workflow `tests.yml` 執行：
  - `npm run test`（fail 則 block merge）
  - `npm run test:coverage`（覆蓋率 < 60% 則 fail）
**And** Coverage 結果上傳至 PR comment（用 `davelosert/vitest-coverage-report-action` 或同等 action）
**And** 加入 Story 22-4 AC9 的 required status checks 列表（merge block）

---

## Tasks / Subtasks

- [ ] **Task 1: 安裝 Vitest 與相依工具** (AC: #1)
  - [ ] 1.1 `npm install -D vitest @vitest/coverage-istanbul @vitest/ui happy-dom vite-tsconfig-paths`
  - [ ] 1.2 `npm install -D @testing-library/react @testing-library/jest-dom`
  - [ ] 1.3 確認 Node.js 版本相容（Vitest 2.x 需要 Node 18.0+）

- [ ] **Task 2: vitest.config.ts 配置** (AC: #1, #3)
  - [ ] 2.1 建立 `vitest.config.ts`（含 path alias 解析、environment、coverage 設定）
  - [ ] 2.2 配置 `setupFiles: ['./tests/setup.ts']`
  - [ ] 2.3 配置 `environment: 'happy-dom'`（DOM-needing tests）+ `environmentMatchGlobs` 指定 `tests/unit/services/**` 用 `node`
  - [ ] 2.4 配置 coverage 閾值 60%（lines）

- [ ] **Task 3: package.json scripts** (AC: #1)
  - [ ] 3.1 新增 4 個 scripts（test / test:watch / test:coverage / test:ui）

- [ ] **Task 4: 測試目錄結構建立** (AC: #2)
  - [ ] 4.1 建立 `tests/unit/`、`tests/integration/`、`tests/fixtures/`、`tests/mocks/` 子目錄
  - [ ] 4.2 建立 `tests/setup.ts`（全域 beforeEach/afterEach、mock 重置）
  - [ ] 4.3 確認既有 `tests/unit/services/batch-processor-parallel.test.ts` 可被 Vitest 執行

- [ ] **Task 5: 共用 Mock 工具** (AC: #4-#8)
  - [ ] 5.1 `tests/mocks/prisma.ts`：用 `vitest-mock-extended` 或自建 deep mock
  - [ ] 5.2 `tests/mocks/next-auth.ts`：mock session 與 user
  - [ ] 5.3 `tests/mocks/azure-blob.ts`：mock Azure SDK
  - [ ] 5.4 `tests/mocks/openai.ts`：mock OpenAI SDK（為 Story 22-3 預留）
  - [ ] 5.5 `tests/mocks/redis.ts`：mock Upstash Redis

- [ ] **Task 6: Auth Middleware 測試** (AC: #4)
  - [ ] 6.1 建立 `tests/unit/middlewares/auth.test.ts`
  - [ ] 6.2 撰寫 6 個 case（依 AC4 列表）
  - [ ] 6.3 確認覆蓋率 ≥ 80%

- [ ] **Task 7: Permission 測試** (AC: #5)
  - [ ] 7.1 建立 `tests/unit/lib/auth/permissions.test.ts`
  - [ ] 7.2 跑各角色 permission 矩陣
  - [ ] 7.3 確認覆蓋率 ≥ 90%

- [ ] **Task 8: Zod Schema 測試** (AC: #6)
  - [ ] 8.1 建立 `tests/unit/lib/validations/` 下 9 個 schema 對應 test
  - [ ] 8.2 每個 schema 至少 4 個 case（happy / invalid / boundary / injection）
  - [ ] 8.3 確認覆蓋率 ≥ 90%

- [ ] **Task 9: Rate Limit 測試** (AC: #7)
  - [ ] 9.1 建立 `tests/unit/services/rate-limit.test.ts`
  - [ ] 9.2 雙模式測試（Redis + in-memory fallback）
  - [ ] 9.3 concurrent stress test（100 個 Promise.all）
  - [ ] 9.4 確認覆蓋率 ≥ 85%

- [ ] **Task 10: Audit Log Middleware 測試** (AC: #8)
  - [ ] 10.1 建立 `tests/unit/middlewares/audit-log.test.ts`
  - [ ] 10.2 涵蓋成功 / 失敗 / null userId / PII 遮罩
  - [ ] 10.3 確認覆蓋率 ≥ 80%

- [ ] **Task 11: CI 整合** (AC: #9)
  - [ ] 11.1 與 Story 22-4 的 `.github/workflows/tests.yml` 對接
  - [ ] 11.2 加入 vitest-coverage-report-action
  - [ ] 11.3 確認 60% 覆蓋率閾值在 CI 中生效

- [ ] **Task 12: 文檔更新** (AC: 全部)
  - [ ] 12.1 更新 `.claude/rules/testing.md`（從 Vitest 規範變現實）
  - [ ] 12.2 建立 `docs/08-security-and-governance/testing-strategy.md`（覆蓋率時程 60→70→80）
  - [ ] 12.3 更新 `claudedocs/CLAUDE.md`（標註測試現狀已 L0 → L2）
  - [ ] 12.4 更新 `package.json` 描述：將 `test` script 加入 README quick start

---

## Dev Notes

### 依賴項

- ⚠️ Story 22-4 CI Pipeline 同步進行（AC9 需要 GitHub Actions infrastructure）
- 既有 codebase（200 services / 331 routes）—— 不在本 story 範圍寫所有測試，只先建立框架 + 6 大安全項目

### 影響的文件

```
package.json                          # 修改：加 devDeps 與 scripts
vitest.config.ts                      # 新增
tsconfig.json                         # 可能需小幅調整（include tests/**）

tests/
├── setup.ts                          # 新增
├── unit/
│   ├── middlewares/
│   │   ├── auth.test.ts              # 新增
│   │   └── audit-log.test.ts         # 新增
│   ├── lib/
│   │   ├── auth/permissions.test.ts  # 新增
│   │   └── validations/
│   │       └── *.test.ts (×9)        # 新增（每個 Zod schema 一個）
│   └── services/
│       ├── batch-processor-parallel.test.ts  # 既有，去孤兒狀態
│       └── rate-limit.test.ts        # 新增
├── integration/
│   └── (預留，本 story 不寫)
├── fixtures/
│   ├── pdf-samples/                  # 新增（為 Story 22-3 預留）
│   └── prompt-injection-samples/     # 新增
└── mocks/
    ├── prisma.ts                     # 新增
    ├── next-auth.ts                  # 新增
    ├── azure-blob.ts                 # 新增
    ├── openai.ts                     # 新增
    └── redis.ts                      # 新增

.claude/rules/testing.md              # 修改
docs/08-security-and-governance/
└── testing-strategy.md               # 新增

.github/workflows/tests.yml           # 新增（與 Story 22-4 對接）
```

### v1.2 矩陣對齊

| ID | 項目 | 改善 |
|----|------|------|
| SDLC-10 | 安全測試（單元）| L0 → L2（達到「auth/permission/Zod/rate limit 邏輯有測試」基準） |

### 與其他 Story 的關係

- **Story 22-4 CI Pipeline**：本 story 的 `tests.yml` 是 22-4 AC9 required status checks 的一員——必須 22-5 先完成才能加入 22-4 的 required list
- **Story 22-3 Prompt Injection**：本 story 的 `tests/fixtures/prompt-injection-samples/` 是 22-3 迴歸測試的基礎——22-3 寫測試時直接用本 story 建立的 mock 工具

### 為什麼選 Vitest 而不是 Jest

| 因素 | Vitest | Jest |
|------|--------|------|
| ESM 支援 | ✅ 原生 | ⚠️ 需 ts-jest + experimental flag |
| TypeScript | ✅ 直接執行 .ts | ⚠️ 需 ts-jest |
| Watch mode 速度 | 🟢 極快 | 🟡 普通 |
| 配置複雜度 | 🟢 簡單 | 🟡 中等（需 babel.config + jest.config） |
| 與既有規範對齊 | ✅ `.claude/rules/testing.md` 已假設用 Vitest | ❌ 需改規範 |
| Next.js 15 相容 | ✅ 支援 | ✅ 支援（但需 next/jest） |
| 社群活躍度 | 🟢 增長中 | 🟡 平穩 |

### 風險與緩解

| 風險 | 緩解 |
|------|------|
| 現有 200 services 沒測試，60% 覆蓋率閾值難達成 | 第一階段只測 6 大安全項目（auth/permission/Zod/rate-limit/audit/既有 batch-processor），其餘程式碼用 `coverage.include` 排除（先不要求）；半年內逐步納入 |
| Mock Prisma 需手寫 deep mock | 用 `vitest-mock-extended` 或既有 social pattern |
| Windows 環境 happy-dom 偶有問題 | 提供 fallback 配置切換到 jsdom |
| Vitest 與 Next.js 15.0.0 相容性問題 | 已驗證社群有 success case；若有問題則 fallback 到 Jest（修改 ADR 並通知用戶） |

### 覆蓋率時程

```
Story 22-5 完成（W2-W3）：60% lines（僅 6 大安全項目區域達標，其他排除）
3 個月後：70%（逐步加入 services / API routes 測試）
半年後：80%（全 codebase 達標）
```

---

## 實作記錄（2026-06-12，階段 1：框架 + smoke test）

### 已完成

| 項目 | 產出 |
|------|------|
| Vitest 安裝（AC1）| vitest 4.1.8 + coverage-istanbul + ui + happy-dom + testing-library(react/jest-dom) + vite-tsconfig-paths + @vitejs/plugin-react + vitest-mock-extended（9 devDeps，H2 經用戶 approve）|
| 配置（AC1）| `vitest.config.ts`（環境 node、coverage istanbul、threshold 60% 留待 CI 啟用）|
| Scripts（AC1）| package.json 加 `test` / `test:watch` / `test:coverage` / `test:ui` |
| Smoke test | `tests/unit/smoke.test.ts` 驗證框架 globals + `@/` alias 解析 |
| 既有測試去孤兒（AC2 部分）| `batch-processor-parallel` + `monthly-cost-report` 兩個孤兒測試可被 Vitest 執行且 pass |

**驗證**：本地 `npm run test` → 3 檔 14 tests 全 pass；type-check / lint 不破壞（EXIT 0 / 0 error）；Docker Linux 重生 lock（補 `@rolldown/binding-linux-*` native binding）+ 乾淨 `npm ci` EXIT 0（避免 FIX-075 跨平台問題）。

### 關鍵技術調整（vs Tech Spec）

| 項目 | Tech Spec | 實際 | 原因 |
|------|-----------|------|------|
| Vitest 版本 | 2.1.0 | **4.1.8** | 2026-06 已是 4.x |
| 環境分配 | `environmentMatchGlobs` | 預設 `environment: node` + 需 DOM 者用 per-file 註解 | vitest 3.0+ 移除 environmentMatchGlobs |
| path alias | `vite-tsconfig-paths` plugin | 原生 `resolve.alias`（手動映射 `@`→src）| plugin 在 vitest 4.x 未生效 |

### 待階段 2

- **6 大安全測試（AC4-AC8）**：auth middleware / permission / 9 Zod schema / rate-limit / audit-log（各需讀對應 src 寫測試 + 建 5 個共用 mock）
- **CI `tests.yml`（AC9）**：併入 Story 22-4 的 `unit-tests` required check + 啟用 60% coverage threshold
- **文檔**：`.claude/rules/testing.md` 從規範變現實、`testing-strategy.md`
