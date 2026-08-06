# Tests 目錄 - 測試套件

> **測試檔數量**: **45** 個測試檔（unit 41 / integration 1 / e2e 2 + `auth.setup.ts`）
> **框架**: Vitest（unit + integration）+ Playwright（e2e）
> **最後更新**: 2026-08-06（首次建立）
> **版本**: 1.0.0
> **規範**: `.claude/rules/testing.md`（⚠️ 該檔的目錄範例與覆蓋率目標與實際有出入，見下方 §與 rules 的差異）

---

## 概述

本目錄包含全部自動化測試。**單元 / 整合測試走 Vitest，E2E 走 Playwright，兩者配置完全分離**：

| 層級 | 框架 | 配置檔 | 執行指令 | 需要外部服務？ |
|------|------|--------|----------|----------------|
| unit | Vitest | `vitest.config.ts` | `npm run test` | 否（全部 mock） |
| integration | Vitest | 同上 | 同上 | 否 |
| e2e | Playwright | `playwright.config.ts` | `npm run test:e2e` | **是**（Docker PostgreSQL + dev server） |

`vitest.config.ts` 的 `exclude` 明確排除 `tests/e2e/**`，所以 `npm run test` **不會**跑到 Playwright 檔。

---

## 目錄結構

```
tests/
├── setup.ts                      # Vitest 全域設定（見下方 §全域 mock）
│
├── unit/                         # 單元測試（41 檔）
│   ├── smoke.test.ts
│   ├── api/                      # API route handler
│   ├── jobs/                     # 排程 / 背景工作
│   ├── lib/                      # src/lib/ 的工具函數
│   ├── prisma/                   # seed / schema 相關
│   └── services/                 # 主力（src/services/ 業務邏輯）
│
├── integration/                  # 整合測試（1 檔）
│   └── llm-gateway-wire-contract.test.ts
│
└── e2e/                          # Playwright E2E
    ├── auth.setup.ts             # 登入並存 storageState（其他 spec 的前置）
    ├── llm-providers.spec.ts
    └── .auth/user.json           # 由 auth.setup 產生（不進版控）
```

---

## 指令

```bash
npm run test              # vitest run —— 跑 unit + integration
npm run test:watch        # 監聽模式
npm run test:coverage     # 產生覆蓋率報告（./coverage）
npm run test:ui           # Vitest UI

npm run test:e2e          # playwright test
npm run test:e2e:ui       # Playwright UI 模式
```

---

## Vitest 配置要點（`vitest.config.ts`）

| 項目 | 值 | 理由 |
|------|-----|------|
| `environment` | `node` | 多為服務 / 安全 / middleware 測試。**需要 DOM 的測試**在檔案頂端加 `// @vitest-environment happy-dom`（vitest 3.0+ 已移除 `environmentMatchGlobs`） |
| `pool` | `forks` | Windows + Prisma mock 相容性 |
| `alias` | `@` → `./src` | 用原生 `resolve.alias`，因 `vite-tsconfig-paths` 在 vitest 4.x 未生效 |
| `coverage.provider` | `istanbul` | Windows 相容性較佳 |
| `testTimeout` / `hookTimeout` | 10 秒 | — |

### 覆蓋率門檻（實際值）

```
lines 60 / branches 50 / functions 60 / statements 60
```

⚠️ 配置檔明註：**6 大安全測試（Story 22-5 AC4–AC8）完成前覆蓋率未達標**，CI 的 `tests.yml`（AC9）待測試寫完才建立並 enforce，**目前這個 threshold 不會 block**。

計入覆蓋率的範圍：`src/services/**`、`src/middlewares/**`、`src/lib/**`、`src/app/api/**`。

---

## 全域 mock（`tests/setup.ts`）

兩個全域 mock，**寫測試前要知道它們已經存在**，不必在個別檔重複：

| Mock | 行為 |
|------|------|
| `next/navigation` | `useRouter` / `usePathname` / `useSearchParams` 皆回傳 stub，避免 server-only 導航 API 報錯 |
| `next-intl` | `useTranslations` 回傳「key 本身」，`useLocale` 回傳 `'en'` —— **所以斷言不要期待翻譯後的文字，要斷言 key** |

另外 `beforeAll` 會設 `AUTH_SECRET='test-secret-do-not-use-in-prod'`，`afterEach` 會 `vi.clearAllMocks()`。

---

## E2E 前置條件（`playwright.config.ts`）

E2E **不是**復用既有 dev server，而是自己啟一個：

| 項目 | 值 |
|------|-----|
| 端口 | `E2E_PORT` 或預設 **3319**（刻意用冷門端口，避免跑到其他 worktree 的 code） |
| 啟動方式 | `npx next dev --port <PORT>`（繞過 `package.json` 寫死 3200 的 dev script） |
| 並行 | `fullyParallel: false`、`workers: 1` —— 流程 spec 有狀態依賴（建立→操作→清理） |
| 認證 | `auth.setup.ts` 先登入，session 存 `tests/e2e/.auth/user.json` 供各 spec 復用 |

### 🔴 兩個 `.env` 陷阱（已由 `webServer.env` 解決，改動配置時勿破壞）

1. **`AUTH_URL` / `NEXTAUTH_URL`** 若沿用主 repo `.env`（指向 3200），登入後 NextAuth 會 redirect 到 E2E server 以外的位址 → `ERR_CONNECTION_REFUSED`
2. **Azure AD 憑證必須清空**（`AZURE_AD_CLIENT_ID/SECRET/TENANT_ID` 設為 `''`），才會讓 `isAzureADConfigured()` 回 false → 恢復 dev 認證模式（login 頁顯示 `DevLoginForm`，`dev-user-1` 自動獲全權限）

> `webServer.env` 注入 `process.env`，優先於 `.env` 檔（Next 不覆蓋既有 `process.env`）。

其他前置：Docker PostgreSQL（`ai-doc-extraction-db`，**port 5433**）須運行；Playwright chromium 須已安裝。

---

## 現有測試的主題分佈

`unit/services/` 是主力，集中在幾個高風險區域：

| 主題 | 代表檔案 |
|------|----------|
| **LLM gateway / provider**（Epic 23） | `llm-gateway.service`、`llm-gateway-bridge`、`llm-gateway-anthropic`、`llm-circuit-breaker`、`llm-deployment-fallback`、`llm-gateway-rollout-flag`、`llm-gateway-sensitive-data`、`llm-provider.service`、`stage-model-assignment` |
| **提取三階段** | `stage-1-company-learn-variant`、`stage-1-company-tokenset-gray`、`stage-2-format-resolve-format-id`、`stage-3-*`（charge table / group key / 行項對帳 / backfill） |
| **模板匹配** | `template-matching-engine-diagnostics`、`template-matching-group-expansion`、`template-instance-staleness`、`template-instance-newer-version` |
| **信心度路由** | `routing-thresholds-calibration`、`routing-line-item-total-mismatch` |
| **PDF 解析** | `pdf-annotation-paint-rule`、`pdf-charge-table-detection`、`pdf-text-rotation` |
| **公司比對** | `token-set`、`company-merge-transfer`、`classify-normalizer` |

新增測試時**先看同主題的既有檔**，沿用其 mock 策略與命名。

---

## 與 `.claude/rules/testing.md` 的差異（2026-08-06 核對）

該規則檔寫於較早期，以下兩點與實際不符，**以本檔與實際配置為準**：

| 項目 | rules 檔寫的 | 實際 |
|------|--------------|------|
| 目錄結構 | `unit/{services,utils}`、`integration/api/` | `unit/{api,jobs,lib,prisma,services}`、`integration/` 為平坦結構 |
| 覆蓋率目標 | 單元 ≥80%、整合 ≥70% | `vitest.config.ts` threshold 為 60/50/60/60，且尚未在 CI enforce |

規則檔的**測試撰寫規範**（命名、mock 模式、AAA 結構、i18n 測試）仍然適用。

---

## 新增測試檢查清單

- [ ] 放對層級（需要真實 DB / 瀏覽器 → e2e；跨模組但可 mock → integration；其餘 → unit）
- [ ] 檔名 `*.test.ts`（Vitest）或 `*.spec.ts`（Playwright）
- [ ] 檔案頭部 JSDoc（`@fileoverview` / `@module` / `@since`）
- [ ] 對應到哪個 CHANGE/FIX/Story（寫在 `@since` 或註釋）
- [ ] 不依賴其他測試的執行順序
- [ ] 不使用真實外部服務（Azure OpenAI / Azure DI / 生產 DB）
- [ ] `npm run test` 通過

---

## 相關文檔

- [.claude/rules/testing.md](../.claude/rules/testing.md) - 測試撰寫規範
- [vitest.config.ts](../vitest.config.ts) - Vitest 配置
- [playwright.config.ts](../playwright.config.ts) - Playwright 配置
- [CLAUDE.md (根目錄)](../CLAUDE.md) - 項目總指南
- `docs/06-codebase-analyze/09-testing/` - 測試現況深度分析

---

**維護者**: Development Team
**最後更新**: 2026-08-06
**版本**: 1.0.0
