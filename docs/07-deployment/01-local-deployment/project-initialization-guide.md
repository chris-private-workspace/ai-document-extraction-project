# 項目初始化指南（本地開發環境）

> 本文件記錄 AI Document Extraction 項目在**本地開發環境**中初始化時需要檢查和準備的所有事項。
> 適用於：新機器部署、從 GitHub 克隆、跨電腦複製項目等場景。
>
> 🔗 **本地部署其他文件**：
> - [`README.md`](./README.md) — 本地部署索引
> - [`environment-variables-reference.md`](./environment-variables-reference.md) — 41 個 env 變數詳解
> - [`docker-services-architecture.md`](./docker-services-architecture.md) — Docker 服務與進階操作
> - [`cross-computer-workflow.md`](./cross-computer-workflow.md) — 跨電腦開發流程
> - [`onboarding-checklist.md`](./onboarding-checklist.md) — 新開發者 Day-1 checklist
>
> ☁️ **Azure 生產部署**：見 [`../02-azure-deployment/README.md`](../02-azure-deployment/README.md)（規劃中）

---

## 目錄

0. [快速啟動（推薦：一鍵腳本）](#0-快速啟動推薦一鍵腳本)
1. [前置條件](#1-前置條件)
2. [環境變數配置](#2-環境變數配置)
3. [Docker 服務啟動](#3-docker-服務啟動)
4. [依賴安裝與 Prisma 設定](#4-依賴安裝與-prisma-設定)
5. [資料庫初始化](#5-資料庫初始化)
6. [應用程式啟動](#6-應用程式啟動)
7. [啟動後驗證清單](#7-啟動後驗證清單)
8. [預設帳號](#8-預設帳號)
9. [常見問題排解](#9-常見問題排解)
10. [快速指令參考](#10-快速指令參考)

---

## 0. 快速啟動（推薦：一鍵腳本）

> **新增於 CHANGE-054（2026-04-22）**

自 CHANGE-054 起，建議使用一鍵初始化腳本，10 步自動化流程：

### 前置

1. 確認 Docker Desktop 已啟動
2. clone 專案並 cd 到根目錄

### 執行

```bash
# Unix / macOS / Git Bash
./scripts/init-new-environment.sh

# Windows PowerShell
.\scripts\init-new-environment.ps1

# 或透過 npm
npm run init-env
```

### 腳本流程

| 步驟 | 動作 | 失敗時提示 |
|------|------|-----------|
| 1 | 檢查 node / npm / docker / git | 明確指出缺少的軟體 |
| 2 | 複製 `.env.example` → `.env`（若不存在） | 既有 .env 不覆寫 |
| 3 | `docker-compose up -d` | 檢查 Docker Desktop 是否啟動 |
| 4 | 等待 PostgreSQL healthy | 最多 60 秒超時 |
| 5 | `npm install` | — |
| 6 | `npx prisma generate` | — |
| 7 | 清除 `.next` 快取 | — |
| 8 | `npx prisma db push --accept-data-loss` | **偵測到非空 DB 會詢問**是否繼續 |
| 9 | `npx prisma db seed` | — |
| 10 | `npm run verify-environment` 環境自檢 | 列出所有 critical / warning |
| 11 | 安裝 git hooks（pre-push → `docs:check`） | 非致命；可隨時補跑 `.\scripts\install-git-hooks.ps1` |

> **既有環境要補裝 hook**（不必重跑整個初始化）：直接執行 `.\scripts\install-git-hooks.ps1`。
> hook 會在 `git push` 前跑 `npm run docs:check`（約 11 秒），攔截「改了 CHANGE/FIX 狀態卻忘記
> `npm run docs:status`」——那是 CI 的 required gate，本地先擋可省一輪往返。
> 需要略過時用 `git push --no-verify`。詳見 CHANGE-112。

### 執行後

- 填入 `.env` 的實際 Azure / OpenAI 憑證
- 🔴 必要變數若保留 placeholder 會被 `verify-environment` 偵測為錯誤

### 不想用腳本？

下方 Section 1-6 為完整的手動初始化流程，保留作為偵錯 / 進階參考。

---

## 1. 前置條件

### 必要軟體

| 軟體 | 最低版本 | 說明 |
|------|----------|------|
| **Node.js** | 20.x | JavaScript 運行環境 |
| **npm** | 10.x | 套件管理器（隨 Node.js 安裝） |
| **Docker Desktop** | 4.x | 容器化平台（含 Docker Compose） |
| **Git** | 2.x | 版本控制 |

### 版本檢查指令

```bash
node -v          # 預期: v20.x 或更高
npm -v           # 預期: 10.x 或更高
docker --version # 預期: Docker version 24.x 或更高
git --version    # 預期: git version 2.x 或更高
```

### 系統需求

- **磁碟空間**: 至少 5 GB（含 node_modules、Docker images、資料庫）
- **記憶體**: 建議 8 GB 以上（Docker 服務 + Next.js 開發伺服器）
- **網路**: 首次安裝需要網路下載 Docker images 和 npm 套件

---

## 2. 環境變數配置

### Step 2.1: 建立 .env 文件

```bash
# 從範本複製
cp .env.example .env
```

### Step 2.2: 修改關鍵配置

打開 `.env` 文件，依需求修改以下區段：

#### 資料庫連線（必須）

```env
# ⚠️ 注意: docker-compose 將 PostgreSQL 對外映射到 5433 端口
# .env.example 中預設是 5432，必須改為 5433
DATABASE_URL="postgresql://postgres:postgres@localhost:5433/ai_document_extraction?schema=public"
```

> **重要**: `docker-compose.yml` 定義的端口映射為 `5433:5432`，主機端連線必須使用 **5433**。
> 這是最常見的初始化錯誤來源。

#### NextAuth 認證（必須）

```env
# 生成 AUTH_SECRET（首次設定時執行一次）
# npx auth secret
AUTH_SECRET="<替換為生成的密鑰>"

NEXT_PUBLIC_APP_URL="http://localhost:3005"
NODE_ENV="development"
```

#### Azure Blob Storage（文件上傳功能需要）

```env
# 開發環境使用 Azurite 模擬器（標準開發金鑰，可安全使用）
AZURE_STORAGE_CONNECTION_STRING="DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=http://127.0.0.1:10010/devstoreaccount1;"
AZURE_STORAGE_CONTAINER="documents"
```

#### Azure AD / Entra ID（SSO 登入，可選）

```env
# 如未配置，系統會啟用開發模式簡化認證
# 開發模式下接受任何含 @ 的 email 登入
AZURE_AD_CLIENT_ID="your-azure-ad-client-id"
AZURE_AD_CLIENT_SECRET="your-azure-ad-client-secret"
AZURE_AD_TENANT_ID="your-azure-ad-tenant-id"
```

#### Azure OpenAI（AI 處理功能需要）

```env
AZURE_OPENAI_API_KEY="your-azure-openai-subscription-key"
AZURE_OPENAI_ENDPOINT="https://your-resource.cognitiveservices.azure.com/"
AZURE_OPENAI_DEPLOYMENT_NAME="gpt-5.2"
AZURE_OPENAI_API_VERSION="2025-03-01-preview"
```

### 環境變數分級

| 分級 | 說明 | 範例 |
|------|------|------|
| 🔴 **必須** | 缺少則無法啟動 | `DATABASE_URL`, `AUTH_SECRET` |
| 🟡 **功能相關** | 缺少則特定功能不可用 | `AZURE_STORAGE_*`, `AZURE_OPENAI_*` |
| 🟢 **可選** | 缺少不影響基本運行 | `UPSTASH_REDIS_*`, `N8N_*`, `MICROSOFT_GRAPH_*` |

---

## 3. Docker 服務啟動

### Step 3.1: 啟動所有容器

```bash
docker-compose up -d
```

### Step 3.2: 確認服務狀態

```bash
docker-compose ps
```

預期輸出：

| 容器名稱 | 服務 | 端口 | 預期狀態 |
|----------|------|------|----------|
| `ai-doc-extraction-db` | PostgreSQL 15 | 5433 → 5432 | Up (healthy) |
| `ai-doc-extraction-azurite` | Azure Storage 模擬器 | 10010/10011/10012 | Up |
| `ai-doc-extraction-pgadmin` | pgAdmin（可選） | 5050 | Up |

> **注意**: Python OCR 服務（端口 8000）和 Mapping 服務（端口 8001）需要額外的 Azure 配置才能正常運行，
> 基本開發和 UI 預覽不需要這些服務。

### Step 3.3: 驗證 PostgreSQL 連線

```bash
# 方法 1: 透過 Docker 測試
docker exec ai-doc-extraction-db pg_isready -U postgres

# 方法 2: 透過主機端測試（需安裝 psql）
psql -h localhost -p 5433 -U postgres -d ai_document_extraction -c "SELECT 1"
```

### Docker 服務端口總覽

| 服務 | 主機端口 | 容器端口 | 用途 |
|------|----------|----------|------|
| PostgreSQL | **5433** | 5432 | 主資料庫 |
| pgAdmin | 5050 | 80 | 資料庫管理 UI |
| Azurite Blob | 10010 | 10000 | Azure Blob Storage 模擬 |
| Azurite Queue | 10011 | 10001 | Azure Queue Storage 模擬 |
| Azurite Table | 10012 | 10002 | Azure Table Storage 模擬 |

---

## 4. 依賴安裝與 Prisma 設定

### Step 4.1: 安裝 npm 套件

```bash
npm install
```

> 安裝過程中可能出現 peer dependency 警告（如 `nodemailer` 版本衝突），這不影響功能運行。

### Step 4.2: 生成 Prisma Client

```bash
npx prisma generate
```

> Prisma Client 是根據 `prisma/schema.prisma` 生成的類型安全資料庫客戶端。
> 每次 schema 變更後都需要重新生成。

### Step 4.3: 清除舊的建置快取

```bash
# 如果是從其他電腦複製的項目，.next 快取可能包含舊路徑
# 清除後會在下次啟動時自動重新編譯
rm -rf .next
```

> **為什麼需要清除？** `.next` 目錄包含編譯快取，其中可能硬編碼了前一台電腦的絕對路徑。
> 不清除可能導致 500 錯誤：`Cannot find module '#main-entry-point'`。

---

## 5. 資料庫初始化

這是最關鍵的步驟，也是最容易出問題的地方。

### Step 5.1: 檢查遷移狀態

```bash
npx prisma migrate status
```

- 如果顯示 `Database schema is up to date!`，表示遷移已應用
- 如果有未應用的遷移，執行 `npx prisma migrate dev`

### Step 5.2: 同步 Schema（重要！）

```bash
npx prisma db push --accept-data-loss
```

> **為什麼需要 `db push`？**
>
> 本項目的 Prisma Schema（119 個模型）遠超過現有遷移檔案（10 個初始遷移）所涵蓋的範圍。
> 在開發過程中，大量的 Schema 變更是透過 `prisma db push` 直接同步到資料庫的，
> 而非每次都建立遷移檔案。因此，僅執行 `prisma migrate dev` 無法建立完整的資料庫結構。
>
> `--accept-data-loss` 在空資料庫上是安全的。如果資料庫已有資料，請先評估影響。

### Step 5.3: 執行種子腳本

```bash
npx prisma db seed
```

種子腳本會建立以下基礎資料：

| 資料類型 | 數量 | 說明 |
|----------|------|------|
| 系統角色 | 6 | System Admin, Super User, Data Processor, City Manager, Regional Manager, Auditor |
| 區域 | 4 | GLOBAL, APAC, EMEA, AMER |
| 城市 | 10 | TPE, HKG, SGP, TYO, SHA, SYD, LON, FRA, NYC, LAX |
| 公司 | 15 | DHL, FedEx, UPS, Maersk 等物流公司 |
| 映射規則 | 31 | Tier 1 通用規則 + Tier 2 公司特定規則 |
| 系統配置 | 34 | 信心度閾值、檔案大小限制等 |
| 資料模板 | 3 | ERP 標準匯入、費用報表、物流追蹤 |
| Prompt 配置 | 8 | V3.1 三階段提取 + 通用配置 |
| 警報規則 | 4 | AI 服務、OCR 逾時、佇列積壓、錯誤率 |
| 匯率 | 16 | 主要幣別對美元匯率 |
| 用戶 | 3 | 系統用戶、開發用戶、管理員用戶 |

### Step 5.4: 驗證種子資料（推薦使用 verify-environment）

```bash
# 推薦（CHANGE-054）：一次完成所有環境檢查
npm run verify-environment
```

`verify-environment.ts` 會檢查：
- 所有 🔴 必要環境變數（不能是 placeholder）
- Docker 容器狀態（postgres / azurite）
- 資料庫連線
- Schema 同步（核心 tables 可查詢）
- Seed 完整性（roles / regions / cities / companies / users 數量）
- **FIX-054 關鍵檢查**：`SYSTEM_USER_ID` 對應的 User 存在

退出碼：`0`（通過或僅警告） / `1`（critical 錯誤）

---

### Step 5.5: SYSTEM_USER_ID 遷移（FIX-054）

> **僅既有開發環境需要**。全新環境保持 `.env.example` 預設的 `SYSTEM_USER_ID="system-user-1"` 即可。

FIX-054 起，`company-auto-create` / `batch-processor` / `issuer-identification` 等服務讀取 `process.env.SYSTEM_USER_ID`（預設 `"system-user-1"`）。若既有 DB 的 system user 已有不同 UUID（早期版本遷移），建議覆蓋 env 而非動資料庫。

#### 既有環境遷移步驟

```bash
# Step 1: 查詢現有 systemUser UUID
node -e "
require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.query(\"SELECT id, email FROM users WHERE email = 'system@ai-document-extraction.internal';\")
  .then(r => { console.log(r.rows); pool.end(); });
"

# Step 2: 將查到的 UUID 寫入 .env
# 手動編輯 .env，加入或修改：
# SYSTEM_USER_ID="<查到的 UUID>"

# Step 3: 重啟服務，驗證
npm run verify-environment   # 應看到 FIX-054 check 通過
```

---

### Step 5.6: 驗證種子資料（手動查詢，選用）

```bash
# 直接查詢 Node.js（verify-environment 已包含此檢查）
node -e "
const { Pool } = require('pg');
const pool = new Pool({ connectionString: 'postgresql://postgres:postgres@localhost:5433/ai_document_extraction' });
Promise.all([
  pool.query('SELECT count(*) FROM roles'),
  pool.query('SELECT count(*) FROM regions'),
  pool.query('SELECT count(*) FROM cities'),
  pool.query('SELECT count(*) FROM users'),
  pool.query('SELECT count(*) FROM companies'),
]).then(([roles, regions, cities, users, companies]) => {
  console.log('Roles:', roles.rows[0].count);
  console.log('Regions:', regions.rows[0].count);
  console.log('Cities:', cities.rows[0].count);
  console.log('Users:', users.rows[0].count);
  console.log('Companies:', companies.rows[0].count);
  pool.end();
});
"
```

預期結果：Roles=6, Regions=4, Cities=10, Users≥3, Companies=15

---

## 6. 應用程式啟動

### Step 6.1: 檢查端口佔用

```bash
# Windows
netstat -ano | findstr LISTENING | findstr ":30"

# Linux/Mac
lsof -i :3005
```

### Step 6.2: 啟動開發伺服器

```bash
# 預設端口 3005
npm run dev

# 如果 3005 被佔用，使用備用端口
npm run dev -- -p 3200
npm run dev -- -p 3300
```

> **⚠️ Windows 注意**: 不要終止不明的 node.exe 進程，它可能是 Claude Code 或其他開發工具的進程。
> 直接使用備用端口是更安全的做法。

### Step 6.3: 等待編譯完成

- **首次啟動**: 約 45-60 秒（需完整編譯）
- **後續熱重載**: 約 5-10 秒
- 看到 `✓ Ready in X.Xs` 訊息表示就緒

### Step 6.4: 驗證服務

```bash
# 檢查端口是否監聽
netstat -ano | findstr ":3005" | findstr LISTENING

# 測試 HTTP 回應（預期 307 重導向到 /en/）
curl -s -o /dev/null -w "%{http_code}" http://localhost:3005
```

### 備用端口建議

| 端口 | 推薦度 | 備註 |
|------|--------|------|
| 3005 | ⭐⭐⭐ | npm 腳本預設端口 |
| 3200 | ⭐⭐⭐ | 推薦備用，較少衝突 |
| 3300 | ⭐⭐ | 備用 |
| 3500 | ⭐⭐ | 備用 |
| 3000 | ⭐ | 常被其他工具佔用 |

---

## 7. 啟動後驗證清單

### 核心頁面檢查

訪問以下頁面確認功能正常（以端口 3005 為例）：

| 頁面 | URL | 預期結果 |
|------|-----|----------|
| 登入頁 | `http://localhost:3005` | 自動導向登入頁面 |
| 儀表板 | 登入後自動導向 | 顯示概覽資訊 |
| 公司管理 | `/zh-TW/companies` | 顯示 15 家公司列表 |
| 文件上傳 | `/zh-TW/documents/upload` | 城市下拉選單有 10 個城市可選 |
| 資料模板 | `/zh-TW/admin/data-templates` | 顯示 3 個預設模板 |
| 規則管理 | `/zh-TW/rules` | 顯示映射規則列表 |
| 用戶管理 | `/zh-TW/admin/users` | 顯示已建立的用戶 |

### 功能驗證

- [ ] **登入功能**: 使用預設帳號成功登入
- [ ] **語言切換**: en / zh-TW / zh-CN 三種語言正常切換
- [ ] **頁面導航**: 側邊欄選單點擊正常，無 500 錯誤
- [ ] **公司列表**: 顯示 DHL, FedEx, UPS 等 15 家公司
- [ ] **城市選擇**: 文件上傳頁面可選擇 Taipei, Hong Kong 等城市
- [ ] **資料模板**: 顯示 ERP 標準匯入、費用報表、物流追蹤 3 個模板

### 外部服務功能（需額外配置）

以下功能需要對應的 Azure 服務配置後才能使用：

- [ ] **文件上傳與儲存**: 需要 Azurite 或 Azure Blob Storage
- [ ] **OCR 文字識別**: 需要 Azure Document Intelligence
- [ ] **AI 欄位提取**: 需要 Azure OpenAI GPT-5.2
- [ ] **SSO 登入**: 需要 Azure AD (Entra ID)

---

## 8. 預設帳號

### 種子腳本建立的帳號

| 帳號 | Email | 密碼 | 角色 | 用途 |
|------|-------|------|------|------|
| **管理員** | `admin@ai-document-extraction.com` | `ChangeMe@2026!` | System Admin | 最高權限管理帳號 |
| **開發用戶** | `dev@example.com` | （無密碼） | System Admin | 開發測試用，透過 dev bypass 登入 |
| **系統用戶** | `system@ai-document-extraction.internal` | （無密碼） | System Admin | 系統內部操作用 |

### 手動建立管理員帳號

如需建立額外的管理員帳號，可使用 bcrypt 加密密碼後直接插入資料庫：

```bash
# 1. 生成密碼雜湊
node -e "const bcrypt = require('bcryptjs'); console.log(bcrypt.hashSync('YourPassword@123', 12));"

# 2. 插入用戶並分配角色（替換 <HASH> 為上一步的輸出）
node -e "
const { Pool } = require('pg');
const pool = new Pool({ connectionString: 'postgresql://postgres:postgres@localhost:5433/ai_document_extraction' });
async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const role = await client.query(\"SELECT id FROM roles WHERE name = 'System Admin'\");
    const user = await client.query(
      \"INSERT INTO users (id, email, name, password, status, is_global_admin, email_verified, created_at, updated_at) VALUES (gen_random_uuid()::text, 'your@email.com', 'Your Name', '<HASH>', 'ACTIVE', true, NOW(), NOW(), NOW()) RETURNING id\"
    );
    await client.query(
      'INSERT INTO user_roles (id, user_id, role_id, created_at) VALUES (gen_random_uuid()::text, \$1, \$2, NOW())',
      [user.rows[0].id, role.rows[0].id]
    );
    await client.query('COMMIT');
    console.log('Admin created successfully');
  } catch(e) { await client.query('ROLLBACK'); console.error(e); }
  finally { client.release(); pool.end(); }
}
run();
"
```

### 開發模式認證

當 `NODE_ENV=development` 且 Azure AD 未配置時，系統自動啟用開發模式認證：
- 接受任何含 `@` 的 email 登入
- 不需要真實密碼驗證
- 適合快速開發和測試

---

## 9. 常見問題排解

### 問題 1: `prisma db seed` 失敗 — `ColumnNotFound`

**症狀**:
```
The column `(not available)` does not exist in the current database.
```

**原因**: Prisma Schema 有 119 個模型，但資料庫只應用了 10 個初始遷移，缺少大量欄位和表。

**解決方案**:
```bash
npx prisma db push --accept-data-loss
npx prisma generate
npx prisma db seed
```

---

### 問題 2: Next.js 啟動報 500 — `Cannot find module '#main-entry-point'`

**症狀**: 瀏覽器頁面顯示 500 錯誤，錯誤訊息包含舊電腦的路徑。

**原因**: `.next` 快取包含前一台電腦的絕對路徑。

**解決方案**:
```bash
rm -rf .next
npm run dev
```

---

### 問題 3: `EADDRINUSE: address already in use`

**症狀**: 啟動開發伺服器時端口被佔用。

**解決方案**:
```bash
# 方法 1: 使用其他端口
npm run dev -- -p 3200

# 方法 2: 查找並終止佔用進程（Windows，注意不要終止 Claude Code 進程）
netstat -ano | findstr :3005 | findstr LISTENING
# 確認 PID 後
taskkill /F /PID <PID>
```

---

### 問題 4: Prisma 連線失敗 — `PrismaClientInitializationError`

**症狀**: 應用程式啟動後報資料庫連線錯誤。

**排查步驟**:
1. 確認 Docker PostgreSQL 容器運行中: `docker-compose ps`
2. 確認 `.env` 中 `DATABASE_URL` 端口為 **5433**（不是 5432）
3. 重新生成 Prisma Client: `npx prisma generate`

---

### 問題 5: 頁面顯示空資料（無公司、無城市）

**症狀**: 公司列表空白、文件上傳頁面無城市可選。

**原因**: 種子資料未執行或執行失敗。

**解決方案**:
```bash
# 先確認 Schema 已同步
npx prisma db push --accept-data-loss
npx prisma generate

# 再執行種子
npx prisma db seed
```

---

### 問題 6: Azure Storage 未配置

**症狀**: 上傳文件時報 `Azure Storage 未配置` 錯誤。

**解決方案**:
1. 確認 Azurite 容器運行中: `docker-compose ps | grep azurite`
2. 確認 `.env` 中 `AZURE_STORAGE_CONNECTION_STRING` 已設定
3. 如未運行: `docker-compose up -d azurite`

---

### 問題 7: SYSTEM_USER_ID 對應的 User 不存在（FIX-054）

**症狀**: `npm run verify-environment` 報錯：
```
❌ SYSTEM_USER_ID="system-user-1" does not exist in users table
```
或執行批次處理 / 公司自動建立時拋 FK 違規：`companies_created_by_id_fkey`

**原因**: 既有環境的 `systemUser` UUID 與預設 `"system-user-1"` 不符，或 seed 尚未執行。

**解決方案**（擇一）:
- **既有環境**：查出現有 UUID 並設到 `.env`（見 Section 5.5 遷移指引）
- **全新環境**：`npx prisma db seed`（會建立 id=`'system-user-1'` 的系統用戶）

---

### 問題 8: .env.example 和 .env 變數對不上（CHANGE-054）

**症狀**: 從 GitHub pull 後，應用啟動失敗，抱怨某個 env 變數未定義。

**原因**: CHANGE-054（2026-04-22）補齊了 15 個先前缺失的變數（如 `JWT_SECRET`、`ENCRYPTION_KEY`、`AUTH_TRUST_HOST` 等）。既有本機 `.env` 可能缺少這些新變數。

**解決方案**:
```bash
# 比對本機 .env 與範本
diff <(grep -oE '^[A-Z_]+' .env | sort) <(grep -oE '^[A-Z_]+' .env.example | sort)

# 若有差異，參考 .env.example 補齊缺失變數
npm run verify-environment   # 確認所有必要變數就位
```

---

### 問題 9: Docker Desktop 運行中但 docker 指令失敗

**症狀**:
```
error during connect: Get "http://localhost:2375/v1.xx/containers/json":
  dial tcp [::1]:2375: connectex: No connection could be made ...
```

**原因**: `DOCKER_HOST` 環境變數指向舊式 TCP 位址（`tcp://localhost:2375`），但 Docker Desktop 實際使用 named pipe。

**解決方案**:
```bash
# 方法 1: 當前 shell 臨時取消
unset DOCKER_HOST                 # Unix / Git Bash
$env:DOCKER_HOST=$null            # PowerShell

# 方法 2: 切換至 desktop-linux context
docker context use desktop-linux

# 方法 3: 永久移除環境變數（Windows）
# 控制台 → 系統 → 進階系統設定 → 環境變數，刪除 DOCKER_HOST
```

---

## 10. 快速指令參考

### 完整初始化流程（一鍵參考）

```bash
# === Step 1: 環境準備 ===
cp .env.example .env
# 編輯 .env，修改 DATABASE_URL 端口為 5433

# === Step 2: Docker 服務 ===
docker-compose up -d
docker-compose ps                    # 確認所有容器 Up

# === Step 3: 依賴與建置 ===
npm install
npx prisma generate
rm -rf .next                         # 清除舊快取（跨電腦複製時）

# === Step 4: 資料庫初始化 ===
npx prisma migrate dev               # 應用遷移
npx prisma db push --accept-data-loss # 同步完整 Schema
npx prisma generate                  # 重新生成 Client
npx prisma db seed                   # 建立種子資料

# === Step 5: 啟動 ===
npm run dev                          # 或 npm run dev -- -p 3200
```

### 日常開發指令

```bash
npm run dev                  # 啟動開發伺服器
npm run type-check           # TypeScript 類型檢查
npm run lint                 # ESLint 代碼檢查
npm run i18n:check           # i18n 翻譯同步檢查
npm run verify-environment   # 環境自檢（CHANGE-054）
npm run init-env             # 一鍵新環境初始化（CHANGE-054）
npx prisma studio            # 開啟 Prisma 資料庫管理 UI
npx prisma generate          # Schema 變更後重新生成 Client
```

### Docker 管理指令

```bash
docker-compose up -d         # 啟動所有服務
docker-compose down          # 停止所有服務
docker-compose ps            # 查看服務狀態
docker-compose logs -f db    # 查看 PostgreSQL 日誌
docker-compose restart db    # 重啟 PostgreSQL
```

---

*文件建立日期: 2026-03-14*
*最後更新: 2026-04-22（CHANGE-054 新增 Section 0 一鍵腳本、5.5 SYSTEM_USER_ID 遷移、問題 7-9；FIX-054 修復）*
*適用版本: AI Document Extraction Project v3.1+*
