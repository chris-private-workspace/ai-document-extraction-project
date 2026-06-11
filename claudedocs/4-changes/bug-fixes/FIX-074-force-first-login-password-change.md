# FIX-074: 強制首次登入改密（seed 預設管理員 / 重設密碼帳號）

> **建立日期**: 2026-06-11
> **來源**: FIX-070 INFRA-01 第 4 點移交（強制改密觸發 H1，依用戶 2026-06-11 決策另開獨立 FIX 處理）
> **影響範圍**: `prisma/schema.prisma`（User 模型）、認證流程（`src/lib/auth.ts` / `src/middleware.ts`）、改密 UI 與端點、i18n
> **優先級**: 中（P2，安全強化；P1 核心「移除硬編碼明文」已由 FIX-070 完成）
> **狀態**: ✅ 已完成（2026-06-11，H1/H5 已 approve）
> **相依**: FIX-070（已實作隨機一次性密碼，作為本 FIX 落地前的緩解）、CHANGE-077（dev-bypass NODE_ENV gate）

---

## 問題描述

FIX-070 已消除「硬編碼公開明文預設密碼」的核心風險（改為環境變數注入 / 隨機一次性密碼）。但仍缺一道縱深防禦：

- seed 建立的預設管理員（`admin@ai-document-extraction.com`）或任何由管理流程重設密碼的帳號，**首次登入後無強制改密機制**。
- 結果：一次性密碼若被記下、轉貼、或操作員未主動更換，可能長期留存，仍構成弱認證面。

> **本 FIX 目標**：在「持有有效密碼可登入」之上，增加「首次登入必須先改密才能使用系統」的強制門檻。

---

## H1 / H5 影響分析（為何需 approve）

| 約束 | 觸發點 | 說明 |
|------|--------|------|
| **H1（Prisma 結構）** | 新增 `User.mustChangePassword` 欄位 + migration | User 模型（`schema.prisma:9-83`）現無任何可表達「需改密」狀態的欄位（`mustChangePassword` / `passwordChangedAt` 皆不存在）。新增 nullable / 有預設值欄位向後相容，但仍屬 Prisma 結構變更，需 approve。 |
| **H1（認證邏輯）** | 登入後流程新增「需改密 → 強制跳轉」分支 | 改動既定認證流程，屬架構層級。 |
| **H5（i18n）** | 強制改密頁 / 提示文案 | 新增使用者可見 UI 字串，需同步 en / zh-TW / zh-CN 3 語言。 |

---

## 既有可重用基礎設施（降低範圍）

> 已 Glob 驗證（2026-06-11），改密能力已存在，本 FIX **不需從零建改密 UI / API**：

| 既有資產 | 路徑 | 重用方式 |
|----------|------|----------|
| 改密 API（已登入用戶改自己密碼） | `src/app/api/v1/users/me/password/route.ts` | 改密成功後清除 `mustChangePassword` flag |
| 改密 UI | `src/app/[locale]/(dashboard)/profile/client.tsx` | 作為改密入口；或抽出「首次改密」精簡頁 |
| 忘記密碼 / 重設流程 | `src/app/[locale]/(auth)/auth/{forgot,reset}-password/` + 對應 API | 設計參考；重設密碼亦可順帶設定 `mustChangePassword` |

---

## 解決方案（規劃，待 approve）

### 1. Prisma 欄位（H1）

```prisma
// User 模型新增（向後相容，預設 false）
mustChangePassword Boolean @default(false) @map("must_change_password")
```

- migration：`add_must_change_password_to_users`，純加欄位、無資料破壞。
- 可選：同時加 `passwordChangedAt DateTime?` 供未來密碼到期策略（**範圍外，本 FIX 不加，避免 scope 擴大**）。

### 2. seed 設定旗標（接續 FIX-070）

- `prisma/seed.ts` admin 建立時設 `mustChangePassword: true`（無論密碼來自 env 或隨機產生）。

### 3. 認證流程強制門檻（H1）

- 登入成功後，於 session callback / middleware 讀 `mustChangePassword`。
- 為 `true` 時：除「改密端點」與「登出」外，一律強制跳轉至改密頁（避免繞過）。
- 掛載點待實作時定案（候選：`src/lib/auth.ts` session/jwt callback 帶旗標 + `src/middleware.ts` 攔截；對齊 CHANGE-078 既有 middleware 結構）。

### 4. 改密端點清除旗標

- `src/app/api/v1/users/me/password/route.ts` 改密成功 → `mustChangePassword: false`。

### 5. i18n（H5）

- 改密頁標題、強制改密提示、成功訊息 → en / zh-TW / zh-CN 同步；`npm run i18n:check` 通過。

---

## 修改的檔案（規劃）

| 檔案 | 修改內容 | 約束 |
|------|----------|------|
| `prisma/schema.prisma` | User 加 `mustChangePassword` | H1 |
| `prisma/migrations/<ts>_add_must_change_password_to_users/` | 新 migration | H1 |
| `prisma/seed.ts` | admin 建立設 `mustChangePassword: true` | — |
| `src/lib/auth.ts` | session/jwt 帶 `mustChangePassword` | H1 |
| `src/middleware.ts` | 為 true 時強制跳轉改密頁 | H1 |
| `src/app/api/v1/users/me/password/route.ts` | 改密成功清旗標 | — |
| 改密頁（重用或新增精簡頁） | 首次改密入口 | H5 |
| `messages/{en,zh-TW,zh-CN}/*.json` | 改密相關文案 | H5 |

---

## 測試驗證 checklist（實作後）

**程式碼 / Schema 層面**
- [x] migration dry-run：純加欄位（`ALTER TABLE "users" ADD COLUMN "must_change_password" BOOLEAN NOT NULL DEFAULT false`）、既有資料自動填 false 不受影響
- [x] seed admin `create` 設 `mustChangePassword = true`
- [x] 改密 API 成功一併 `mustChangePassword = false`（程式碼已實作）
- [x] middleware 強制改密頁面攔截已實作（已登入 + 旗標 + 非 `/profile` → redirect `/profile`）
- [x] `npm run i18n:check` 通過（3 語言同步 `forceChange`）
- [x] `npm run type-check` 本批檔案零錯誤 / `npm run lint` 無新增 warning/error

**執行期（待 staging 驗證）**
- [ ] 持一次性密碼登入 → 被強制導向改密頁，無法存取其他頁面
- [ ] 改密成功後重新登入 → 恢復正常存取
- [ ] 無法繞過（改 URL 導航皆被攔）

---

## Hard Constraints 自檢

| 約束 | 是否觸發 | 說明 |
|------|----------|------|
| H1（架構 / Prisma 結構） | ✅ 是 | 新 Prisma 欄位 + 認證流程改動 → **已 approve（2026-06-11）** |
| H2（依賴 / vendor） | 否 | 無新依賴 |
| H3（task scope） | 否 | 範圍限「強制首次改密」；`passwordChangedAt` / 密碼到期策略明確排除 |
| H4（安全 / secrets） | ➖ 本 FIX 屬安全強化，不輸出 secret |
| H5（i18n） | ✅ 是 | 改密頁文案 3 語言同步 |
| H6（設計偏離） | 否 | 標準強制改密 pattern，重用既有改密端點 |

---

## 實作筆記（2026-06-11）

### 採用方案：A（重用 profile + banner + 重登），用戶 2026-06-11 拍板

### Migration 策略（重要）
- migration 歷史在 `20251219` 後斷裂（後續 schema 全靠 `db push`，CHANGE-056 baseline 重建未完成），故改用專案既有標準 `prisma db push` 套用，而非 `migrate dev`（後者會偵測巨大 drift 要求 reset DB → 清資料）。
- dry-run（`prisma migrate diff --from-config-datasource --to-schema`）確認變更僅單一 `ALTER TABLE "users" ADD COLUMN "must_change_password" BOOLEAN NOT NULL DEFAULT false`，既有列自動填 false，零資料破壞。
- 正式 migration 待 CHANGE-056 baseline 完成後統一補（用戶 2026-06-11 知情同意此策略）。

### 旗標流轉鏈
1. **DB**：`User.mustChangePassword Boolean @default(false)`（db push + generate）。
2. **seed**：admin `create` 設 `mustChangePassword: true`（接續 FIX-070 隨機一次性密碼）。
3. **auth.ts jwt callback**：DB select 加 `mustChangePassword` → `token.mustChangePassword`（dev-user-1 分支設 false）。
4. **auth.ts session callback**：`token` → `session.user.mustChangePassword`（API / Server Component 用）。
5. **auth.config.ts session callback（新增）**：`token` → `session.user.mustChangePassword`（Edge / middleware 用；不查 DB，只搬 token 欄位）。
6. **middleware.ts**：已登入 + `mustChangePassword` 且非 `/profile` → redirect `/profile`（登出走 `/api/auth` 已於 API 閘放行）。
7. **改密 API**：成功 update 一併 `mustChangePassword: false`。
8. **前端 profile**：banner（讀 `session.user.mustChangePassword`）；改密成功若強制模式 → `signOut` 重新登入（避開 JWT edge token 即時刷新不可靠）。
9. **i18n**：`profile.json` 加 `forceChange.{title,description}`（en / zh-TW / zh-CN）。

### 修改檔案
| 檔案 | 改動 |
|------|------|
| `prisma/schema.prisma` | User 加 `mustChangePassword`（db push） |
| `prisma/seed.ts` | admin create 設 `true` |
| `src/types/next-auth.d.ts` | Session.user + JWT 加型別 |
| `src/lib/auth.ts` | jwt callback（select + 賦值 + dev 分支）、session callback |
| `src/lib/auth.config.ts` | 新增 Edge session callback（middleware 用） |
| `src/middleware.ts` | 強制改密頁面攔截 |
| `src/app/api/v1/users/me/password/route.ts` | 清旗標 |
| `src/app/[locale]/(dashboard)/profile/client.tsx` | banner + 重登 |
| `messages/{en,zh-TW,zh-CN}/profile.json` | `forceChange` 文案 |

### 殘留風險 / 相依
- middleware 攔截為**頁面層**；API 不在攔截範圍（避免 profile 頁自身 API 失效）。僅限制頁面導航即足以強制使用者停留改密頁。
- `session.user.mustChangePassword` 可信前提同 FIX-072：依賴 CHANGE-077/078 上線後 session 可信。
- Azure AD 使用者無密碼（改密 API 既有邏輯已擋）；強制改密僅對本地帳號有效，seed admin 為本地帳號。
- 執行期（一次性密碼登入被攔、改密後重登恢復、無法繞過）待 staging 驗證（專案無單元測試框架）。

---

*文件建立日期: 2026-06-11*
*最後更新: 2026-06-11（方案 A 實作完成，狀態：✅ 已完成）*
