# 已知差異與關鍵發現

> **本文件為 CLAUDE.md §當前 Open 差異 的完整展開**。CLAUDE.md 只列 5 條精簡 open items，本文件含完整歷史 + 已修復項目（FIX-XXX 引用）+ 安全審計記錄。
> **最後更新**：2026-06-16 | **來源**：`docs/06-codebase-analyze/` 驗證報告 R1-R15（44 份）

---

## 當前 Open 差異（待修）

### 🔴 HIGH 優先級（影響設計決策）

| # | 項目 | 文檔聲稱 | Codebase 實際 | 影響 |
|---|------|---------|--------------|------|
| 1 | **Auth 覆蓋率** | 73%（v3.3 估算）/ 59%（更舊） | **實測 60.7%**（201/331 routes，Phase 2 盤點 2026-04-28） | 距企業級 95% 基準有 ~35% 缺口（130 routes 未保護） |
| 2 | **信心度閾值文檔誤差** | CLAUDE.md 寫 95%/80% | **代碼實際 90%/70%**（confidence-v3-1.service.ts 第 112-119 行） | 文檔與代碼不一致；當前以**代碼實際值為準** |

### 🟡 MEDIUM 優先級（影響一致性）

| # | 項目 | 說明 | 處理方向 |
|---|------|------|----------|
| 3 | **RFC 7807 格式不一致** | 部分 API 用 top-level `{ type, title, status, ... }`，部分用 nested `{ error: {...} }` | 新 API 統一採 **top-level**；舊 API 漸進遷移 |
| 4 | **Prisma Model 欄位計數** | 舊報告系統性低估 | 以 `prisma/schema.prisma` 實際內容為準 |
| 5 | **依賴套件數** | 報告聲稱 89，實際 77 | 以 `package.json` 為準 |
| 6 | **console.log 總數** | 279 處 / 87 文件 | 逐步替換為 logger |
| 7 | **Zod 驗證覆蓋率** | 60-65%（~40 個 POST/PATCH/PUT/DELETE 缺驗證） | 新 API 必須加 |
| 8 | **治理矩陣 SDLC-04 vs Dependabot 實況** | 矩陣／Story 22-4 AC4 原述「Dependabot 自動 PR 啟用」 | **2026-06-12 版本更新已停用**（CHANGE-081），保留 security updates；矩陣與 Story 已加註；npm audit 53 漏洞改手動追蹤 |

---

## 已修復項目（歷史記錄）

### 安全相關修復

| FIX # | 項目 | 修復日期 | 說明 |
|-------|------|---------|------|
| **FIX-050** | PII 洩漏（auth.config.ts 6 處 console.log email） | 2026-04-21 | 移除 PII logging + `edge-logger.ts` 加 redact pattern |
| **FIX-051** | SQL Injection 風險（db-context.ts:87 cityCodes 未跳脫） | 2026-04-21 | 加白名單正則 `^[A-Z]{2,4}$` |
| **FIX-052** | Rate Limiting 實作（@upstash/redis 未配置時無 fallback） | 2026-04-21 | 改為 Redis 優先 + in-memory fallback |
| **FIX-053** | Smart Routing 衝突（單一路由 vs 統一 adapter 架構） | 2026-04-21 | 統一為 `applyRoutingStrategy` 為唯一策略核心 |
| FIX-055 | 殘留 PII alert services | 2026-XX-XX | （詳見 changes/bug-fixes/FIX-055） |
| FIX-056 | x-dev-bypass auth hardening | 2026-XX-XX | （詳見 changes/bug-fixes/FIX-056） |

### 提取管線 / 資料品質修復

| FIX # | 項目 | 修復日期 | 說明 |
|-------|------|---------|------|
| **FIX-077** | Stage 1 公司識別飄移 / JIT 增生重複公司（FIX-057 後續強化） | 2026-06-16 | 強化 `normalizeCompanyName`（取 `/` 前主名、移除括號地區詞 `(HK)`/`(Hong Kong)`、後綴加 `OPERATIONS`）+ `resolveCompanyId` JIT 前 `findDuplicateCompany` 重複防護（查所有狀態 + 正規化精確相等 + `levenshteinSimilarity` 0.85）；BUG-3 合併既有重複公司（DHL ×3 → MERGED）。PR #38；詳見 changes/bug-fixes/FIX-077 |

---

## Security Code-Level 審計結果

### 驗證結果 vs 報告聲稱

| 項目 | 驗證實測 | 報告聲稱 | 差異 |
|------|---------|---------|------|
| Auth Coverage | 200/331（60%） | 192/331（58%） | ✅ +2% |
| console.log 總數 | 279 / 87 文件 | 287 / 94 文件 | ⚠️ -8 |
| Zod 驗證 | 60-65% | 62% | ✅ 對齊 |
| SQL Injection | 2（`$executeRawUnsafe`） | 2 | ✅ Match |
| auth.config.ts console.log | 9（修復前） | 9 | ✅ Match |
| Hardcoded Secrets | 0 | 0 | ✅ Match |

### Auth Coverage 分域分析

| Domain | 覆蓋率 | 狀態 |
|--------|--------|------|
| `/admin/*` | 97%（105/108） | ✅ 優秀 |
| `/v1/*` | 78%（~60/77） | 🟡 良好 |
| `/documents/*` | 77%（20/26） | 🟡 良好 |
| `/auth/*` | 43%（3/7） | 🟡 需改善 |
| `/reports/*` | 31%（5/16） | 🔴 公開 API（待確認設計） |
| `/rules/*` | 16%（5/31） | 🔴 待確認設計意圖 |
| `/companies/*` | 0%（0/15） | 🔴 公開 API（待確認設計） |
| `/cost/*` | 0%（0/5） | 🔴 公開 API（待確認設計） |

### Overall Security Score: 6.7/10（Medium）

- Authentication Coverage: 6/10
- Input Validation: 6.5/10
- PII Protection: 4/10 ⚠️（修復 FIX-050 後改善）
- Secret Management: 9/10 ✅
- SQL Security: 8/10 ✅（修復 FIX-051 後改善）

---

## 統計差異記錄

### i18n 統計（已驗證）

- **JSON 文件**：102（精確）
- **命名空間**：34（完整）
- **3 語言 × 34 命名空間 = 102** ✅ 報告精確無誤

### 服務層統計（已驗證）

- **服務文件**：200（精確）
- **子目錄**：13 個

### API 統計（已驗證）

- **Route Files**：331 total
- **HTTP Methods**：414 methods
  - GET: 201 files (60%)
  - POST: 141 files (43%)
  - PATCH: 33 files (10%)
  - DELETE: 31 files (9%)
  - PUT: 8 files (2%)
- **估計端點數**：400+（平均每文件 1.25 methods）

---

## Blind Spots（已識別但尚未驗證）

| 項目 | 狀態 | 影響 |
|------|------|------|
| 規則學習「3 次修正觸發」 | ⚠️ 未驗證 | `rule-suggestion-generator.ts` 邏輯需確認 |
| Bundle Analyzer | ❌ 缺失 | 無法追蹤包大小增長 |
| Optimistic Locking | ❌ 缺失 | 多用戶併發編輯風險 |
| 全域 Rate Limiting | ⚠️ 部分實現 | `rate-limit.service` 存在但無全域中間件 |

---

## 處理機制（如何使用本文件）

### 開發前

- 規劃新功能時，先 scan 本文件**當前 Open 差異**，避免重複造輪子
- 修改受影響範圍時，確認是否要連帶處理 Open 差異

### 修復差異時

1. 在對應 FIX-XXX 文件記錄
2. 修復完成後**移到「已修復項目」段落**
3. 更新 CLAUDE.md §當前 Open 差異 的 5 條精簡列表（如該項在內）

### 發現新差異時

1. 加入「當前 Open 差異」相應優先級
2. 評估是否需要建立 FIX-XXX
3. 若屬 Open Question 則同步更新 `docs/open-questions.md`

---

## 變更歷史

- **2026-06-16**：FIX-077 修復（Stage 1 公司識別飄移 / JIT 重複公司 → 已修復，PR #38）
- **2026-05-26**：初版（從 CLAUDE.md v3.4.1 §已知差異與關鍵發現 完整遷移）
- **2026-04-21**：FIX-050/051/052/053 修復（4 個 HIGH 優先級 → 已修復）
- **2026-04-09**：基於 `docs/06-codebase-analyze/` 全面掃瞄建立差異記錄

---

*本文件由 CLAUDE.md v4.0.0 升級時建立，請隨修復進度同步更新*
