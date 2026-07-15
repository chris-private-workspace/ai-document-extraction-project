# CHANGE-054: 新環境部署可靠性強化（Deployment Readiness Enhancement）

> **狀態**: ✅ 已完成（2026-04-22）

## 變更摘要

| 項目 | 內容 |
|------|------|
| **變更編號** | CHANGE-054 |
| **變更日期** | 2026-04-21 |
| **相關模組** | Deployment / DevOps / 初始化流程 |
| **影響範圍** | `.env.example`、`scripts/`、`docs/06-deployment/`、`prisma/seed/`、`.gitignore` |
| **優先級** | High |
| **狀態** | ✅ 已完成（2026-04-22） |
| **類型** | Enhancement / Reliability |
| **依賴** | FIX-054（`SYSTEM_USER_ID` 修正需併入 `.env.example` 重寫） |

---

## 問題描述

今日 session 排查 `/en/documents` 頁面崩潰（`.next` 快取損壞）時延伸討論「新環境部署會遇到的初始化問題」，透過 codebase 探查發現 **5 個部署可靠性漏洞**，讓新環境從零到能啟動需要手動執行 7-8 步，任何一步漏掉或做錯就會失敗，且錯誤通常在執行時才崩潰（而非啟動前被偵測）。

### 漏洞清單

| # | 漏洞 | 嚴重度 | 現況 | 期望 |
|---|------|--------|------|------|
| A | `.env.example` 與實際 `.env` 漂移（缺 15 個變數） | 🔴 | 新環境 copy 後啟動失敗，需逐個找 | 所有 `.env` 必要變數都在範本中 |
| B | `.env.example` `DATABASE_URL` port 預設 5432 | 🔴 | docker-compose 映射是 5433 → 連線失敗 | 預設 5433 匹配 docker-compose |
| C | Prisma schema（122 models）與 migrations（10 個）不同步 | 🟡 | 新環境 `prisma migrate deploy` 只能建 10 個遷移的內容，缺 112 個 models | 文件化 `prisma db push` 流程 |
| D | Seed 依賴 `prisma/seed/exported-data.json`（169 KB）未明確文件化 git 狀態 | 🟡 | 若檔案在 `.gitignore` 則新環境 seed 不完整 | 明確策略 |
| E | 缺一鍵初始化腳本 + 缺啟動前自檢腳本 | 🟡 | 手動 7-8 步，錯了才在 runtime 崩潰 | 一鍵腳本 + 啟動前驗證 |

### 漏洞 A 明細（缺失變數，已實測 diff）

**存在於 `.env` 但 `.env.example` 缺失的 15 個變數**：

| 變數 | 優先級 | 影響 |
|------|--------|------|
| `ENCRYPTION_KEY` | 🔴 必要 | 敏感資料加密（缺失 = 加密資料無法讀取） |
| `JWT_SECRET`, `JWT_EXPIRES_IN`, `SESSION_SECRET` | 🔴 必要 | 認證 |
| `AUTH_TRUST_HOST`, `AUTH_URL` | 🔴 必要 | NextAuth v5 運行必需 |
| `FEATURE_EXTRACTION_V3`, `FEATURE_EXTRACTION_V3_1`, `FEATURE_EXTRACTION_V3_1_FALLBACK`, `FEATURE_EXTRACTION_V3_PERCENTAGE`, `FEATURE_EXTRACTION_V3_1_PERCENTAGE` | 🟡 功能 | 提取管線 feature flags |
| `AZURE_OPENAI_MINI_DEPLOYMENT_NAME`, `AZURE_OPENAI_NANO_DEPLOYMENT_NAME` | 🟡 功能 | 多模型路由 |
| `DEBUG_EXTRACTION_V3_PROMPT`, `DEBUG_EXTRACTION_V3_RESPONSE` | 🟢 偵錯 | 開發偵錯 |
| **`SYSTEM_USER_ID`** | 🔴 必要 | FIX-054 引入，跨環境系統用戶 ID |

### 漏洞 C 明細

- `prisma/schema.prisma` 定義 **122 models** / **113 enums** / **4,354 行**
- `prisma/migrations/` 只有 **10 個遷移檔案**（停留在 2025-12-19）
- 實際開發使用 `prisma db push --accept-data-loss` 直接同步 schema
- 新環境若只跑 `prisma migrate deploy` 只能建立 10 個遷移涵蓋的內容，缺 112 個 models
- `docs/06-deployment/project-initialization-guide.md` 第 215-228 行雖已記錄 `db push`，但未在腳本層面強制

### 漏洞 D 明細

- `prisma/seed.ts:69-76` 會讀取 `prisma/seed/exported-data.json`（若存在則併入 seed）
- 檔案大小 169 KB，用途為恢復匯出的資料
- **需確認**此檔案是否已 commit 至 git（若在 `.gitignore` 則新環境會漏資料）

---

## 變更方案

### 子變更 1：重寫 `.env.example` 補齊所有變數

**檔案**：`.env.example`

**動作**：
- 新增缺失的 15 個變數（含 `SYSTEM_USER_ID`，對接 FIX-054）
- 修正 `DATABASE_URL` port 從 `5432` → `5433`
- 每個變數加上分級標記註解（🔴 必要 / 🟡 功能 / 🟢 可選）
- 按用途分區（資料庫 / 認證 / Azure / Feature flags / Debug / …）

**範本結構示意**：
```env
# ============================================================
# 🔴 必要變數（缺少則無法啟動）
# ============================================================

# Database (docker-compose 映射到 5433)
DATABASE_URL="postgresql://postgres:postgres@localhost:5433/ai_document_extraction?schema=public"

# Authentication
AUTH_SECRET="<run: npx auth secret>"
AUTH_TRUST_HOST="true"
AUTH_URL="http://localhost:3005"
JWT_SECRET="<32-char random>"
JWT_EXPIRES_IN="7d"
SESSION_SECRET="<32-char random>"
ENCRYPTION_KEY="<32-char random, used for PII encryption>"

# System User (FIX-054)
SYSTEM_USER_ID="system-user-1"

# Application
NEXT_PUBLIC_APP_URL="http://localhost:3005"
NODE_ENV="development"

# ============================================================
# 🟡 功能相關變數（缺少則對應功能不可用）
# ============================================================

# Azure OpenAI ...
# Azure Storage ...
# Feature flags ...

# ============================================================
# 🟢 可選變數
# ============================================================

# Debug flags ...
# n8n / Microsoft Graph / Upstash Redis ...
```

### 子變更 2：新增一鍵初始化腳本

**檔案**：`scripts/init-new-environment.sh`（Unix / Git Bash）+ `scripts/init-new-environment.ps1`（PowerShell）

**功能**：
1. 檢查必要軟體（node/npm/docker/git 版本）
2. 複製 `.env.example` → `.env`（若不存在）
3. 啟動 `docker-compose up -d`
4. 等待 PostgreSQL healthy（polling `pg_isready`）
5. 執行 `npm install`
6. 執行 `npx prisma generate`
7. 清除 `.next`
8. 執行 `npx prisma db push --accept-data-loss`
9. 執行 `npx prisma db seed`
10. 執行 `npm run verify-environment`（子變更 3）
11. 輸出摘要（預設帳號、下一步指令）

**安全性**：
- 不覆寫既有 `.env`
- Destructive 操作（`db push --accept-data-loss`）前詢問確認
- 失敗時輸出明確的錯誤與下一步指引

### 子變更 3：新增啟動前自檢腳本

**檔案**：`scripts/verify-environment.ts`

**檢查項目**：

| 類別 | 檢查 | 失敗處置 |
|------|------|---------|
| 環境變數 | 所有 🔴 必要變數存在且非空 / 非預設值 | ❌ 列出缺失變數，退出 1 |
| Docker 容器 | 必要容器 running + healthy（postgres, azurite） | ⚠️ 列出停機容器，建議啟動 |
| 資料庫連線 | `SELECT 1` 成功 | ❌ 退出 1 |
| Schema 同步 | 隨機抽查 3 個 models（Company, User, Document）可查詢 | ❌ 提示 `prisma db push` |
| Seed 完整性 | Roles ≥ 6, Regions ≥ 4, Cities ≥ 10, Companies ≥ 15, Users ≥ 3 | ⚠️ 提示 `prisma db seed` |
| FIX-054 相關 | `SYSTEM_USER_ID` env 值對應的 User 存在 | ❌ 關鍵檢查 |

**加入 `package.json`**：
```json
"scripts": {
  "verify-environment": "ts-node scripts/verify-environment.ts",
  "predev": "npm run verify-environment || true"  // 軟警告，不阻擋
}
```

### 子變更 4：`exported-data.json` 策略

**動作順序**：
1. 檢查 `.gitignore` 是否忽略 `prisma/seed/exported-data.json`
2. 若已 commit：保持現狀，在 guide 中說明用途
3. 若在 gitignore：決定**入 git**（資料可能含測試用內容）或**轉為 TypeScript seed-data**（`prisma/seed-data/exported-data.ts`）
4. 若決定留作可選：在 `seed.ts:69-76` 明確記錄「可選資料恢復」，並在 `init-new-environment.*` 腳本輸出「提示找不到 exported-data.json 是正常的」

### 子變更 5：更新 `project-initialization-guide.md`

**檔案**：`docs/06-deployment/project-initialization-guide.md`

**更新點**：
- 替換手動初始化流程為「推薦方式：執行 `scripts/init-new-environment.*`」
- 保留手動 10 步作為「進階／偵錯」流程（目前 Step 1-6）
- 新增「啟動前自檢」章節說明 `verify-environment` 用法
- 新增「SYSTEM_USER_ID 遷移」章節（從 FIX-054 的 Step 7 改寫）
- 新增「常見問題」補條目：
  - 一鍵腳本偵測到 Docker 未啟動怎麼辦
  - `SYSTEM_USER_ID` 指向的 User 不存在如何排查
  - `exported-data.json` 找不到是否影響部署

---

## 預期效果

### 部署時間與錯誤偵測

| 面向 | Before | After |
|------|--------|-------|
| 新環境從零到 `npm run dev` 成功 | 手動 7-10 步，平均 45-60 分鐘（含錯誤排查） | 一鍵腳本 + 自檢，平均 20-25 分鐘 |
| 錯誤偵測時機 | 執行時才崩潰（`prisma db seed` fail、API runtime FK violation） | 啟動前自檢（`verify-environment`） |
| `.env` 變數完整度 | 26 個（缺 15 個必要） | 41+ 個（含 `SYSTEM_USER_ID`） |
| 部署文件與實際一致 | 漂移（guide 手動指令 vs `.env.example` 不一致） | 一致（腳本是唯一真實流程） |

### 新手上路體驗

- 現在：讀 564 行 guide → 逐步執行 → 某步失敗 → 翻 guide 找對應章節 → 修復 → 繼續
- 未來：執行一行指令 → 失敗訊息直接包含修復步驟 → 成功後腳本輸出下一步

---

## 修改的檔案（實際）

| 檔案 | 變更類型 | 實際行數 |
|------|----------|---------|
| `.env.example` | 🔄 重寫（補 15 變數 + 分級註解 + port 修正） | 141 行（先前 89 行） |
| `scripts/init-new-environment.sh` | ➕ 新增（10 步自動化） | 195 行 |
| `scripts/init-new-environment.ps1` | ➕ 新增（PowerShell 版本） | 204 行 |
| `scripts/verify-environment.ts` | ➕ 新增（環境自檢） | 265 行 |
| `package.json` | 🔄 新增 `verify-environment` + `init-env` scripts | +2 |
| `docs/06-deployment/01-local-deployment/project-initialization-guide.md` | 🔄 更新（Section 0 一鍵腳本、Step 5.5 遷移、問題 7-9）；2026-04-22 目錄重構後新位置 | +120 行 |
| `.gitignore` | ✅ 無需調整（`exported-data.json` 已在 git 中追蹤） | 0 |
| `prisma/seed/exported-data.json` | ✅ 已在 git 中（169KB，2026-02-05 匯出） | 0 |

### 為何 `.gitignore` / `exported-data.json` 未動

探查 `git ls-files prisma/seed/exported-data.json` 確認檔案**已被 git 追蹤**。新環境 clone 後會直接拿到此檔，seed.ts 可順利讀取。CHANGE-054 只需在 guide 中記錄此行為，無需變動 gitignore 或檔案內容。

### `predev` hook 未加入的原因

原規劃 `"predev": "npm run verify-environment || true"` 會在每次 `npm run dev` 前自動執行自檢。**最終未加**，因：
- 每次啟動增加 3-5 秒 DB 查詢延遲
- `|| true` 讓自檢變成純資訊性，減少實際價值
- 使用者可依需求主動跑 `npm run verify-environment`，或靠一鍵腳本在初始化階段執行

---

## 與 FIX-054 的協調

本 CHANGE 與 FIX-054 高度耦合，需協調實施：

| 協調點 | 說明 |
|--------|------|
| **`.env.example` 的 `SYSTEM_USER_ID`** | FIX-054 的 Step 6 已規劃加入；本 CHANGE 的子變更 1 會在重寫 env 時併入該行（避免兩個 PR 互相衝突） |
| **`verify-environment.ts` 自檢** | 本 CHANGE 的子變更 3 必須加入「`SYSTEM_USER_ID` 對應的 User 存在」檢查，這是驗證 FIX-054 是否正確部署的關鍵 |
| **一鍵腳本 seed 步驟** | 本 CHANGE 的子變更 2 執行 `npx prisma db seed` 時，會建立 FIX-054 規劃的 `system-user-1` 用戶 |
| **guide 文件同步** | 本 CHANGE 的子變更 5 會整合 FIX-054 的「遷移指引」章節 |

**建議實施順序**：

1. 先合併 **FIX-054**（代碼層修正，小範圍）
2. 再合併 **CHANGE-054**（DevOps 層強化，跨多個腳本與文件）

原因：CHANGE-054 的 `verify-environment.ts` 與 `.env.example` 重寫都**依賴** FIX-054 引入的 `SYSTEM_USER_ID` 規則。

---

## 測試驗證

### 自動化檢查（已完成）

- [x] `npx tsc --noEmit` 對 CHANGE-054 新增的 `verify-environment.ts` 無 type error（2026-04-22）
  - 既存 `@types/jest` 相關錯誤不屬於本 CHANGE 範圍

### 子變更 1：`.env.example` 重寫（待實際驗證）

- [x] 包含 FIX-054 的 `SYSTEM_USER_ID` 區塊
- [x] 41 個變數 vs 實際 `.env`（diff 應僅差異在可選變數的預設值）
- [x] 所有變數有分級註解（🔴 / 🟡 / 🟢）
- [ ] 新環境 `cp .env.example .env` 後能啟動 `npm run dev`（需實際環境測試）

### 子變更 2：一鍵初始化腳本（待實際驗證）

- [x] `.sh` 腳本語法正確（bash `set -euo pipefail`、顏色輸出、中斷處理）
- [x] `.ps1` 腳本語法正確（`$ErrorActionPreference = 'Stop'`、`$LASTEXITCODE` 檢查）
- [x] 兩個腳本流程對齊（10 步驟名稱、參數、偵測邏輯一致）
- [ ] 全新 Docker volume 情境：端對端測試能從零到 `npm run dev` Ready（需實際環境測試）
- [ ] 既有環境執行：偵測到 `.env` 已存在，不覆寫（需實際環境測試）
- [ ] 既有 DB 有資料時：詢問是否跑 `db push`（需實際環境測試）

### 子變更 3：環境自檢（待實際驗證）

- [x] TypeScript 無錯誤
- [x] 依賴僅使用既有 `pg` 與 `dotenv`（不新增套件）
- [ ] 正常環境：`npm run verify-environment` 輸出「所有檢查通過」退出碼 0
- [ ] 刻意缺少 `AUTH_SECRET`：列出缺失變數退出碼 1
- [ ] 刻意停止 postgres 容器：警告提示
- [ ] 刻意刪除 `system-user-1` 用戶：FIX-054 關鍵檢查失敗

### 子變更 4：`exported-data.json`

- [x] 確認已在 git 中追蹤（`git ls-files` 驗證通過）
- [x] guide 文件準確描述該檔案的用途（Section 5 提及）
- [x] `.gitignore` 無需調整

### 子變更 5：`project-initialization-guide.md`

- [x] 新增 Section 0「快速啟動（推薦：一鍵腳本）」
- [x] 新增 Step 5.4「verify-environment 推薦用法」
- [x] 新增 Step 5.5「SYSTEM_USER_ID 遷移（FIX-054）」
- [x] 新增問題 7-9（SYSTEM_USER_ID、env.example diff、DOCKER_HOST）
- [x] 日常開發指令補入 `verify-environment` / `init-env`
- [x] 文件末尾註記更新日期與變更說明

---

## 相關文件

- **FIX-054**: SYSTEM_USER_ID 硬編碼修正（本 CHANGE 的依賴）
- **既有 guide**: `docs/06-deployment/project-initialization-guide.md`（564 行，將被擴充）
- **既有 seed**: `prisma/seed.ts`（1,456 行，FIX-054 會改動 L397 附近）
- **既有 docker-compose**: `docker-compose.yml`（驗證 port 對應）
- **既有 `.env.example`**: 26 變數，将被重寫為 41+ 變數

---

## 風險提示

- **腳本跨平台相容性**：PowerShell 與 Bash 行為差異（路徑分隔符、exit code、`trap` / `trap -p`）需仔細測試
- **`db push --accept-data-loss` 在既有環境風險**：一鍵腳本應在偵測到「非空資料庫」時跳過此步驟或改為僅檢查
- **`.env.example` 重寫影響既有開發者**：若已有本地 `.env`，下次 pull 時不會自動同步新變數。需在 release note 提醒「執行 `diff .env .env.example`」
- **`exported-data.json` 入 git 的 size 考量**：169 KB 單次影響不大，但若未來資料成長需改為分塊或動態生成
- **FIX-054 未完成前實施 CHANGE-054 的風險**：`.env.example` 會缺 `SYSTEM_USER_ID` 註解；`verify-environment` 無法實作關鍵檢查 — 因此嚴格依序

---

*文件建立日期: 2026-04-21*
*最後更新: 2026-04-22（所有 5 個子變更已完成代碼 / 文件實作，待實際環境端對端測試）*
