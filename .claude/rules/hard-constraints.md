# Hard Constraints — Strict Mode 完整規範

> **本文件為 CLAUDE.md §Hard Constraints 的詳細展開**。摘要在 CLAUDE.md，trigger 細節 / required behavior 完整步驟 / 詢問模板 / 技術債務記錄格式都在此處。

---

## 核心原則

**Hard Constraints 違反 = task 未完 = broken project signal**。任何 trigger 條件成立時，AI 必須：
1. **立即停止寫 code**
2. **明確告知用戶觸發了哪條 H 約束**
3. **提供完整資訊讓用戶決策**（替代方案 + 影響分析）
4. **等用戶 explicit approve 後才繼續**

**不可隱藏 trigger**：不可以用 workaround 繞過 + 不告知用戶；不可以在 commit message 輕描淡寫；不可以假裝沒看見。

---

## H1 — Architectural Change Constraint

### Trigger 完整定義

任何符合以下其一即觸發：
- 加 / 改 / 刪 **三層映射架構**（Universal / Forwarder Override / LLM）的核心邏輯
- 改 **信心度路由邏輯**（5 維度權重、CONFIG_SOURCE_BONUS、智能降級）
- 加 / 改 / 刪 **122 個 Prisma models** 的核心欄位或關聯（純加 nullable 欄位除外）
- 改 既定 vendor（OCR = Azure Document Intelligence / AI = Azure OpenAI GPT-5.2 / 認證 = Azure AD SSO / DB = PostgreSQL 15）
- 改 RFC 7807 錯誤格式約定（新 API 必須 top-level）
- 改 i18n 架構（移除某語言、改變命名空間規則）
- 加 Tier 2 功能（GraphRAG、multi-tenancy、workflow builder 等超出 v1.0 PRD 範圍的）

### Required Behavior

```
1. STOP 寫 code
2. 在 chat 明確說明：
   - 你想做什麼 architectural change
   - 為何 PRD / Tech Spec / 既有設計不適用
   - Proposed 替代方案（含影響分析）
3. 等用戶回應「approved」後繼續
4. 在對應 CHANGE-XXX 文件記錄此決定（含理由 + 用戶 approve 日期）
```

### 不屬於 H1（可自行做）

- Bug fix（包括 critical bug）
- 內部 refactor 而不改 public interface
- 加 internal helper function
- UI polish（spacing / typography / micro-interaction）
- 加 test / logging / observability
- 純加 nullable Prisma 欄位（向後相容）

---

## H2 — Dependency / Vendor Constraint

### Trigger 完整定義

- 加新 npm 套件到 `package.json` `dependencies` 或 `devDependencies`
- 換 vendor（任何 §技術棧 列出的服務）
- 改 Prisma `datasource` provider
- 加 Python 服務的新依賴到 `python-services/*/requirements.txt`
- 引入新的 Docker 服務到 `docker-compose.yml`

### Required Behavior

```
1. STOP and ask
2. 解釋：
   - 為何現有 stack 不夠（請具體：某個 feature 缺什麼？performance bottleneck 在哪？）
   - 提名的新依賴 / vendor 名稱 + 版本
   - License 是否與項目相容
   - Bundle size 影響（前端套件）/ 啟動時間影響（Docker 服務）
3. 等 approval
4. 在 CHANGE-XXX 記錄決定
```

### 例外（可自行加）

- 純 utility library（如 `tenacity`、`p-retry`）
- Type stub package（`@types/*`）
- Dev dependency（test framework patch / linter rule plugin）
- 既有套件的 minor / patch 版本升級（major version 升級仍需 ask）

---

## H3 — Task Scope Constraint

### Trigger 完整定義

- 在當前 CHANGE-XXX / FIX-XXX 範圍**之外**新增功能（即使「順手」）
- Refactor 與當前 task 無關的周邊代碼
- 加用戶未要求的 flexibility / configurability（「萬一將來需要」不是理由）
- 加用戶未要求的 abstraction layer
- 加未要求的 error handling 覆蓋不可能情境

### Required Behavior

```
1. STOP 寫 code
2. Surface：「我發現要做 X，但這超出當前 task scope」
3. 提出選項：
   (a) 新建 CHANGE-XXX 處理
   (b) 放回 backlog
   (c) 確認屬於當前 task 的隱含需求（請用戶確認）
4. 等用戶決定
```

### 不屬於 H3（必須清理）

- 你改動造成的 orphan（unused import / variable / function 因你的改動而 unused）— **必須清理**，這是你製造的 mess
- 修正你自己引入的 typo / 錯字
- 修正你自己引入的 linter warning

### 範例對比

| 情境 | 屬於 H3？ |
|------|-----------|
| 修 FIX-055 時順便 refactor 同一文件的另一個 unrelated 函數 | ✅ 違反 — 應 STOP |
| 修 FIX-055 時你的改動讓某個 import 變 unused，你刪掉它 | ❌ 不違反 — 你的 mess 自己清 |
| 加 CHANGE-068 時看到旁邊 console.log 順便改 logger | ✅ 違反 — 應 STOP，提建 FIX-XXX |
| 加 CHANGE-068 時加了用戶沒要求的 `?optionalParam` | ✅ 違反 — 應 STOP |

---

## H4 — Security & Privacy Constraint

### 絕對禁止

| # | 禁止行為 | 範例 |
|---|---------|------|
| 1 | log PII 到 plaintext file | `console.log(user.email)` |
| 2 | commit secrets / API keys / connection strings | `.env` 內容、`DATABASE_URL=postgres://...` |
| 3 | hardcode tenant ID / subscription ID / resource name | `const TENANT = "abc-123-..."` |
| 4 | 客戶端組件直接訪問資料庫 | `'use client'` 檔案內 `import prisma from ...` |
| 5 | log full JWT / access token / refresh token | `logger.info('token', token)` |
| 6 | 把 secret 寫進 git history（即使後來 revert） | `git reset --hard` 不夠，需要 BFG / git-filter-repo |

### Required Behavior

**禁止行為無例外** — 即使是 debug、即使是 staging、即使「只是暫時」。

如果開發過程確實需要 log 敏感資訊（如 debug 認證流程）：
1. 使用 `logger.debug()` 並確保 production 環境關閉 debug level
2. 或使用 redact pattern：`logger.info('user', { id: user.id, email: '***' })`
3. 在 commit 前 grep 確認沒有殘留

### 引用 reference

- **既往事件**：FIX-050（auth.config.ts 6 處 console.log email → 已修復）
- **既往事件**：FIX-051（db-context.ts:87 SQL injection 風險 → 已修復，加白名單正則）
- 詳見 `claudedocs/reference/known-discrepancies.md`

---

## H5 — i18n & Hard-coding Constraint

### Trigger 完整定義

- 在 `src/components/**` 或 `src/app/**` 任何 `.tsx` 文件中硬編碼**使用者可見**的 UI 字串（非 placeholder / 非 aria-label / 非 alt 也算）
- 修改 `src/types/*.ts` 或 `src/constants/*.ts` 中含 `label` / `description` / `name` 等顯示欄位的常量，但**沒有**同步更新 3 個語言的 JSON
- 新增 i18n 命名空間，但**沒有**在 `src/i18n/request.ts` 的 `namespaces` 陣列註冊
- 改變現有翻譯 key 名，但只改了一個語言的 JSON

### Required Behavior

```
1. 確認所有使用者可見文字使用 useTranslations() / getTranslations()
2. 新增 / 修改翻譯時，同步更新：
   - messages/en/<namespace>.json
   - messages/zh-TW/<namespace>.json
   - messages/zh-CN/<namespace>.json
3. 新增命名空間時，註冊到 src/i18n/request.ts 的 namespaces 陣列
4. 完成前執行：npm run i18n:check
5. 若 i18n:check 報錯 → 必須修復才能 commit
```

### 例外

- Error 訊息**僅供開發者看**（如 throw new Error('Invalid state')）可用英文
- Logger 訊息可用英文
- Code comment 可用中文或英文
- Commit message 必須英文（H5 不約束 commit message）

### 範例對比

| 代碼 | 是否違反 H5？ |
|------|--------------|
| `<Button>Save</Button>` | ✅ 違反 — 必須 `t('common.save')` |
| `throw new Error('User not found')` | ❌ 不違反 — 開發者錯誤訊息 |
| `<div aria-label="Close">` | ✅ 違反 — aria-label 也算使用者可見 |
| `console.error('DB connection failed')` | ❌ 不違反 — logger 訊息 |

---

## H6 — Design Deviation Constraint

### Trigger 完整定義

- 實作偏離已 approve 的 Tech Spec（`docs/04-implementation/tech-specs/`）
- 偏離 PRD（`docs/01-planning/prd/`）的功能定義
- 改變既定 UX pattern（例如：本來用 Modal 確認的操作改成 inline confirm）
- 改變既定組件用法（例如：本來用 shadcn `<Dialog>` 改用自製 modal）
- 改變既定 API endpoint 行為（例如：response shape、status code 約定）
- **絕對禁止**：用「看似差不多」的替代方案矇混過關（approximate / similar / inspired-by 都不可）

### Required Behavior

```
1. STOP 寫 code
2. 在 chat 說明：
   - 你發現的 deviation 是什麼
   - 為何原設計不適用（具體：技術障礙？UX 衝突？性能問題？）
   - 提供替代方案表（選項 + 影響 + 技術債務）
3. 等用戶決定 — 絕對不可自行 approximate
4. 若採替代方案 → 記錄技術債務（見下方格式）
```

### 詢問模板

```markdown
## ⚠️ 設計偏離報告（H6 Triggered）

### 原設計（per Tech Spec §X.Y）
[描述原設計]

### 實作中發現的問題
[具體描述為何無法按原設計實現]

### 已嘗試的解決方案
1. [方案 1] — 結果：[失敗原因]
2. [方案 2] — 結果：[失敗原因]

### 替代方案

| 選項 | 方案 | UX 影響 | 技術債務 |
|------|------|---------|----------|
| A | [維持原設計，繼續調查] | 無 | 無 |
| B | [替代方案 1] | [影響] | [需後續修復] |
| C | [替代方案 2] | [影響] | [需後續修復] |

### 我的建議
[推薦選項 + 理由]

請問您希望如何處理？
```

---

## 技術債務記錄格式

如果用戶 approve 採用替代方案，必須在 **3 處**同步記錄：

### 1. 對應 CHANGE-XXX / FIX-XXX 文件的 Implementation Notes

```markdown
### ⚠️ 技術債務

| 項目 | 說明 |
|------|------|
| 原設計 | [原本應該實現的方式] |
| 實際實現 | [因障礙而採用的替代方案] |
| 影響 | [對 UX / 功能 / 性能的影響] |
| 障礙原因 | [為什麼無法按原設計實現] |
| 修復計劃 | [預計何時修復，建立的後續 FIX-XXX] |
| 用戶確認 | [用戶 approve 日期] |
```

### 2. `claudedocs/reference/known-discrepancies.md`

新增一行到「當前 Open 差異」表格。

### 3. Commit Message

```
feat(scope): [implementation]

Note: deviates from Tech Spec §X.Y per H6 approval 2026-05-26.
See CHANGE-XXX Implementation Notes for technical debt details.
```

---

## 自我檢查清單

開發過程中，每個 commit 前 ask：

- [ ] 我的改動是否完全符合 Tech Spec / PRD？
- [ ] 我是否使用了規格中指定的組件 / 技術 / vendor？
- [ ] 我是否因任何原因偏離了原設計？
- [ ] 如有偏離，是否已獲用戶 explicit approval？
- [ ] 技術債務是否已在 3 處同步記錄？
- [ ] 我是否在 task scope 內？沒有「順手」做其他事？

---

## 違反 Hard Constraint 的後果

如果發現未經 approval 就違反 H1-H6：

1. **立即通知用戶**：「我意識到剛才的改動違反了 H{N}，因為 [原因]」
2. **評估修復範圍**：
   - 若改動還沒 commit → 立即修復回原設計
   - 若已 commit 但還沒 push → 修復 + amend commit
   - 若已 push → 建立補救 FIX-XXX
3. **補充記錄**：技術債務（即使是補救性的）
4. **在對應規劃文件**標註：需要 retroactive review

---

*本文件建立日期：2026-05-26（CLAUDE.md v4.0.0）*
*基於 EKP CLAUDE.md §5 Hard Constraints 結構 + 本項目特性調整*
