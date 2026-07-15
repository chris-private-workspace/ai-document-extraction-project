# 已知差異與關鍵發現

> **本文件為 CLAUDE.md §當前 Open 差異 的完整展開**。CLAUDE.md 只列 5 條精簡 open items，本文件含完整歷史 + 已修復項目（FIX-XXX 引用）+ 安全審計記錄。
> **最後更新**：2026-07-14（CHANGE-104 文檔治理：OQ-Q1 resolved、FIX-077 重號修正、FIX-055/056 誤列已修復更正、索引改自動生成） | **來源**：`docs/06-codebase-analyze/` 驗證報告 R1-R15（44 份）

---

## 當前 Open 差異（待修）

### 🔴 HIGH 優先級（影響設計決策）

| # | 項目 | 文檔聲稱 | Codebase 實際 | 影響 |
|---|------|---------|--------------|------|
| 1 | **Auth 覆蓋率** | 73%（v3.3 估算）/ 59%（更舊） | **實測 60.7%**（201/331 routes，Phase 2 盤點 2026-04-28） | 距企業級 95% 基準有 ~35% 缺口（130 routes 未保護） |

> ℹ️ 原 #2「信心度閾值文檔誤差」已於 **2026-07-14** 解決（OQ-Q1：文檔對齊代碼 90%/70%），移至下方「已修復項目」。

### 🟡 MEDIUM 優先級（影響一致性）

| # | 項目 | 說明 | 處理方向 |
|---|------|------|----------|
| 3 | **RFC 7807 格式不一致** | 部分 API 用 top-level `{ type, title, status, ... }`，部分用 nested `{ error: {...} }` | 新 API 統一採 **top-level**；舊 API 漸進遷移 |
| 4 | **Prisma Model 欄位計數** | 舊報告系統性低估 | 以 `prisma/schema.prisma` 實際內容為準 |
| 5 | **依賴套件數** | 報告聲稱 89，實際 77 | 以 `package.json` 為準 |
| 6 | **console.log 總數** | 279 處 / 87 文件 | 逐步替換為 logger |
| 7 | **Zod 驗證覆蓋率** | 60-65%（~40 個 POST/PATCH/PUT/DELETE 缺驗證） | 新 API 必須加 |
| 8 | **治理矩陣 SDLC-04 vs Dependabot 實況** | 矩陣／Story 22-4 AC4 原述「Dependabot 自動 PR 啟用」 | **2026-06-12 版本更新已停用**（CHANGE-081），保留 security updates；矩陣與 Story 已加註；npm audit 53 漏洞改手動追蹤 |
| 9 | **MappingRule Tier1/2 術語注入（V3.1 半退役）** | Stage 3 原將 `MappingRule.fieldName→fieldLabel` 注入 prompt（`extractionPattern`/`validationPattern` 在 V3.1 完全未用） | **2026-06-20 已停用注入**（CHANGE-083）：DB 實查 31 筆中 30 筆為直譯冗餘、與 FieldDefinitionSet 重複；唯一有效的 Maersk 海運提單號別名已遷至 `invoice-fields.ts tracking_number.aliases`；`MappingRule` 表／`/rules`／`/api/rules/*` 不受影響；整體去留見 OQ-Q4 |
| 10 | **EN 介面顯示中文（組件級硬編碼）** | 全站約 **86 組件** JSX render 中文（原估 88）；另有 zod schema 驗證訊息、資料層中文（DB seed）、page metadata title | **CHANGE-088** 修顯示常量洩漏（7 組件，2026-06-22）；**CHANGE-089 Batch A**（2026-06-22）修 10 個完全未 i18n 模組共 **36 組件**（新增 5 namespace `documentSource`/`dataRetention`/`integrations`/`changeHistory`/`ruleSimulation`、677 leaf key×3、`i18n:check` 治理 +9 條，namespace 34→39）；**Batch B/C/D（波 1）**（2026-06-22）再修 5 個既有 namespace 殘留共 **40 組件**（admin 14/review 3/rules 11/historicalData 5/documentPreview 7，全複用既有 namespace、`LOCALE_SYNC_CHECKS` +5 條整檔；累計已修 **83 組件**）；**波 2（Batch E/F）+ 補遺 G**（2026-06-22）修 29 組件（escalation/companies/formats/reports/dashboard/navigation/systemSettings + 新 `cityAccess` + 盤點遺漏的 `components/audit/`+`components/admin/performance/`）。**CHANGE-089 全批次完成：共 105 組件、新增 6 namespace（34→40）、`LOCALE_SYNC_CHECKS` 22 條、組件級 JSX render 中文清零（剩 9 處全 JSDoc/註釋）**；剩 **zod schema 訊息（需 `useLocalizedZod`）+ page 層(`src/app`) + 資料層 + `RecentDocumentsTable` 用不存在的 `invoice` ns（pre-existing bug）** 另立後續 |
| ~~11~~ | ⚠️ **本條已完成，保留於此僅為脈絡；實質應視為 Closed**（CHANGE-090 已實作並於 2026-06-24 部署驗證） **城市權限管理 UI/API 缺失 + `UserRole.cityId` 誤導** | `withCityFilter` / 403 判斷的 `cityCodes` 來自 **`UserCityAccess`** 表（`auth.ts:225` `CityAccessService.getUserCityCodes`），但 admin 用戶管理 UI 的「城市」下拉寫的是 **`UserRole.cityId`**（不同表、**不影響 403**）；`UserCityAccess` 唯一寫入路徑 `CityAccessService.grantAccess/revokeAccess` **無任何對外 API/UI**（僅 `regional-manager.service` 內部呼叫）→ 非 globalAdmin 用戶要城市資料存取權限只能直接改 DB；UI「城市」欄位誤導管理者以為「設城市＝給權限」 | **✅ CHANGE-090 已實作並部署驗證（2026-06-24）**：補城市/區域存取權限管理 UI/API + globalAdmin 切換（admin 用戶編輯對話框 `UserAccessManagementSection`）；釐清 `UserRole.cityId`〔City Manager 範圍〕vs `UserCityAccess`/`UserRegionAccess`〔資料存取〕雙軌（城市欄位重新標籤「City Manager 管理範圍」+ 強化說明）。新 API 統一要求 `USER_MANAGE` 全域權限（globalAdmin 切換另要求操作者本身 `isGlobalAdmin`）。**Azure DEV 已部署映像 `dev-change090-20260624111833`，UI 端到端驗證 globalAdmin 切換可用**（`corrielai@rapo.com.hk` 於 UI 改為 globalAdmin，重登後 dashboard 403 解除）。註：原 grant script 用 `corrie.lai`（有點）≠ 實際帳號 `corrielai`（無點）故未生效，CHANGE-090 UI 不靠 email 字串匹配（用 user id）已根治此類問題 |

---

## 已修復項目（歷史記錄）

### 安全相關修復

| FIX # | 項目 | 修復日期 | 說明 |
|-------|------|---------|------|
| **FIX-050** | PII 洩漏（auth.config.ts 6 處 console.log email） | 2026-04-21 | 移除 PII logging + `edge-logger.ts` 加 redact pattern |
| **FIX-051** | SQL Injection 風險（db-context.ts:87 cityCodes 未跳脫） | 2026-04-21 | 加白名單正則 `^[A-Z]{2,4}$` |
| **FIX-052** | Rate Limiting 實作（@upstash/redis 未配置時無 fallback） | 2026-04-21 | 改為 Redis 優先 + in-memory fallback |
| **FIX-053** | Smart Routing 衝突（單一路由 vs 統一 adapter 架構） | 2026-04-21 | 統一為 `applyRoutingStrategy` 為唯一策略核心 |

> 🔴 **更正（2026-07-14，CHANGE-104）**：本表原列有 `FIX-055`（殘留 PII alert services）與 `FIX-056`（x-dev-bypass auth hardening），修復日期寫 `2026-XX-XX` —— 實際上**兩者從未實作**（狀態皆為 📋 規劃中）。已自「已修復項目」移除，避免誤導。當前狀態一律以 `claudedocs/STATUS.md`（自動生成）為準。

### 提取管線 / 資料品質修復

| FIX # | 項目 | 修復日期 | 說明 |
|-------|------|---------|------|
| **FIX-077** | Stage 1 公司識別飄移 / JIT 增生重複公司（FIX-057 後續強化） | 2026-06-16 | 強化 `normalizeCompanyName`（取 `/` 前主名、移除括號地區詞 `(HK)`/`(Hong Kong)`、後綴加 `OPERATIONS`）+ `resolveCompanyId` JIT 前 `findDuplicateCompany` 重複防護（查所有狀態 + 正規化精確相等 + `levenshteinSimilarity` 0.85）；BUG-3 合併既有重複公司（DHL ×3 → MERGED）。PR #38；詳見 changes/bug-fixes/FIX-077 |

### 文檔一致性修正

| 項目 | 解決日期 | 說明 |
|------|---------|------|
| **OQ-Q1 信心度閾值文檔誤差** | 2026-07-14 | CLAUDE.md 原寫 95%/80%，代碼實際 90%/70%。決議**修文檔、不改代碼**（代碼是實際跑了數個月的行為，改它會使歷史資料的路由結果失去可比性）。已同步 CLAUDE.md §信心度路由／§When in Doubt／§當前 Open 差異、`docs/open-questions.md` |
| **FIX-077 編號重複** | 2026-07-14 | `FIX-077-pipeline-config-refmatch-scope-guard.md`（2026-06-18 建立、無程式碼引用）與 `FIX-077-stage1-company-drift-jit-duplicates.md`（2026-06-16、已嵌入 `stage-1-company.service.ts`）撞號 → 前者改編為 **FIX-109**。新增 `npm run docs:check` R1 規則防止再犯 |
| **索引過期（治本）** | 2026-07-14 | CHANGE/FIX 狀態改由 `claudedocs/STATUS.md` 自動生成（`npm run docs:status`），CI `docs:check` 驗證其與現況相符 → 索引不可能再過期。`sprint-status.yaml` 降級為歷史封存 |

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

- **2026-06-24**：Open 差異 #11 更新 → CHANGE-090 已實作（代碼層完成、待 Azure 部署驗證）：補城市/區域存取權限管理 UI/API + globalAdmin 切換，城市欄位重新標籤釐清雙軌語意
- **2026-06-23**：新增 Open 差異 #11（城市權限管理 UI/API 缺失 + `UserRole.cityId` 誤導 → CHANGE-090 規劃；`corrie.lai` 登入後 dashboard 403 案例觸發，當前靠 grant globalAdmin 繞過）
- **2026-06-16**：FIX-077 修復（Stage 1 公司識別飄移 / JIT 重複公司 → 已修復，PR #38）
- **2026-05-26**：初版（從 CLAUDE.md v3.4.1 §已知差異與關鍵發現 完整遷移）
- **2026-04-21**：FIX-050/051/052/053 修復（4 個 HIGH 優先級 → 已修復）
- **2026-04-09**：基於 `docs/06-codebase-analyze/` 全面掃瞄建立差異記錄

---

*本文件由 CLAUDE.md v4.0.0 升級時建立，請隨修復進度同步更新*
