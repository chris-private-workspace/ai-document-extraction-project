# Azure 生產部署主規劃（CHANGE-055）

> **建立日期**: 2026-04-22
> **狀態**: 📋 規劃中（Phase 1：技術決策階段 — **全 10 項決策已定案**，進入 Phase 2 文件化階段）
>
> ⚠️ **部署方式現況（2026-06-27）**：本項目 Azure 部署**只用手動** `az acr build` + `az webapp config container set`（見 [`dev-deployment-runbook.md §A`](./dev-deployment-runbook.md)）。本文提及的 **GitHub Actions / CI/CD 自動部署為 Phase 3 規劃，尚未實作**，勿當現況。
> **版本**: 0.3（2026-04-22）
> **追蹤**: CHANGE-055（主規劃傘） + CHANGE-056（Prisma migration baseline 獨立追蹤）
> **前置**: CHANGE-054 + FIX-054 已完成（本地部署可靠性與 SYSTEM_USER_ID 可覆蓋機制）
>
> **v0.3 變更摘要**（剩餘 6 個議題定案 + UAT 部署文件規劃）：
> 1. ✅ IaC 工具 → 採用 **Bicep**，但定位為 **Optional Track**（與 Infra Team 配合 + Mode C 混合協作模式）
> 2. ✅ Phase 時程 → **2026 年 7 月上線**（10 週執行窗口 + 漸進式上線：7 月 Pilot → 8-10 月 Expansion）
> 3. ✅ 評審流程 → **4 方參與**（DevOps/Platform Team + Security Team + Infra Admin + App Team），會議 + 非同步混合形式，無 ADR 流程
> 4. ✅ 上線 deadline → **2026-07**（Pilot：HKG/SIN 1-2 城市、10-20 人；Full Production 後續分階段）
> 5. ✅ HA 要求 → **暫不需要 Zone-redundant**，但保留每日自動備份 + 還原 runbook
> 6. ✅ 網路架構 → **委外 Infra Admin**，本文件僅提供應用層對網路的需求清單
>
> **v0.3 新增章節**：
> - §🔵 UAT 部署流程文件規劃（12 份人 + AI 雙向可讀文件，作為核心交付物）
> - §⏰ 時程規劃（10 週 Sprint 對齊 7 月 Pilot deadline）
> - §🏛️ 架構評審流程（3 階段 Review）
>
> **v0.2 變更摘要**（保留紀錄）：
> 1. ✅ Schema Migration → 方案 A（重建基線）+ 舊 migrations 歸檔 → CHANGE-056 獨立追蹤
> 2. ✅ 運算選型 → Container Apps（<100 UI 使用者，接受工作時段外 scale to 0 cold start）
> 3. ✅ Seed 策略 → 混合模式（essential 自動 + reference 手動）+ Mapping Rules 分層處理
> 4. ✅ Azure 資源預算 → 交由 Infra Admin 決策，本規劃只提供技術選項清單

本文件是 AI Document Extraction 項目部署到 Azure 生產環境的**主規劃文件**。涵蓋所有架構決策、選型比較、風險評估、分階段實施路徑。

---

## 📐 整體目標架構（草案）

```
┌─────────────────────────────────────────────────────────────────┐
│  Azure Subscription                                              │
│                                                                   │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │  Resource Group: rg-ai-document-extraction-prod            │ │
│  │                                                              │ │
│  │  ┌─────────────┐  ┌──────────────┐  ┌──────────────────┐  │ │
│  │  │ Container   │  │ App Service  │  │ Static Web App   │  │ │
│  │  │ Apps        │◄─┤ Plan（或     │  │ （如需純前端）   │  │ │
│  │  │ (Next.js)   │  │ Container    │  └──────────────────┘  │ │
│  │  │             │  │ Apps Env）   │                         │ │
│  │  └──────┬──────┘  └──────────────┘                         │ │
│  │         │                                                    │ │
│  │         ├───────► Azure Database for PostgreSQL             │ │
│  │         │           Flexible Server                           │ │
│  │         │                                                    │ │
│  │         ├───────► Azure Blob Storage                        │ │
│  │         │                                                    │ │
│  │         ├───────► Azure OpenAI Service                      │ │
│  │         │                                                    │ │
│  │         ├───────► Document Intelligence                     │ │
│  │         │                                                    │ │
│  │         ├───────► Key Vault (secrets + encryption keys)     │ │
│  │         │                                                    │ │
│  │         ├───────► Container Registry (ACR)                  │ │
│  │         │                                                    │ │
│  │         └───────► Application Insights + Log Analytics      │ │
│  │                                                              │ │
│  │  Optional:                                                   │ │
│  │  - VNet + Private Endpoints                                  │ │
│  │  - Front Door / Application Gateway                          │ │
│  │  - Service Bus（若未來加入異步處理）                          │ │
│  └──────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘

CI/CD: GitHub Actions → ACR → Container Apps rolling update
```

---

## 1️⃣ 容器化 / 建置

### 決策 1.1：Dockerfile 架構
**目標**：multi-stage Next.js production image，minimal size

```dockerfile
# 預期結構（草案）
FROM node:20-alpine AS deps
# ...install
FROM node:20-alpine AS builder
# ...build
FROM node:20-alpine AS runner
# ...standalone output + static
```

**必須包含**：
- `next.config.ts` 開啟 `output: 'standalone'`
- Prisma Client 生成（建置時）
- 非 root user 執行
- Health check endpoint（`/api/health`）

**Effort**：~1 天實作 + 半天優化 image size

### 決策 1.2：Image Registry
| 選項 | 優點 | 缺點 |
|------|------|------|
| **Azure Container Registry (ACR)** | Azure 生態整合、Managed Identity、VNet 支援 | 額外費用 |
| Docker Hub（public） | 免費 | 🔴 私有鏡像需付費，Rate limit 風險 |
| GitHub Container Registry | GitHub Actions 整合方便 | Azure 拉取需配置 |

**推薦**：**ACR**（符合企業級需求）

---

## 2️⃣ Azure 資源選型

### 決策 2.1：應用主體運算 — ✅ 已定案（2026-04-22）

> **決定**：採用 **Azure Container Apps**。規模參數：UI 使用者 <100 人、minReplicas 0-1（工作時段 1 / 其他 0）、maxReplicas 5。接受工作時段外 scale to 0 的 cold start。

| 選項 | 適用場景 | 本專案契合度 |
|------|---------|------------|
| **Azure Container Apps** ✅ 已採用 | 容器化、自動 scale、serverless | ⭐⭐⭐⭐⭐ |
| App Service for Containers | 傳統 PaaS、簡單部署 | ⭐⭐⭐⭐ 備選 |
| AKS（Kubernetes） | 大規模、複雜拓撲 | ⭐⭐ 過度工程化 |
| Azure Functions | 短任務 / 事件驅動 | ❌ Next.js 不適合 |

**採用理由**：
- 符合 Next.js standalone build、自動 scale、無 K8s 運維負擔、支援 Revision 部署
- Revision 模式可做 blue/green 或 canary
- 本專案非 24/7 high-traffic web app，非工作時段幾乎無負載 → Container Apps 的 scale to 0 能力對成本控制最有利

### 決策 2.1.1：Container Apps 規模參數（已定）

**業務負載參數（輸入）**：
- UI 使用者規模：**< 100 人**（中小型內部系統）
- 年處理發票量：450-500K 張（平均每工作日 1,400-1,700 張）
- 工作時段：約 08:00-19:00 local time
- 非工作時段負載：幾乎為 0（僅 email ingest / 批次作業）

**Container Apps 配置（建議值，Phase 2 啟用時寫入 Bicep module）**：

| 參數 | 設定值 | 說明 |
|------|-------|------|
| `minReplicas`（工作時段） | **1** | 避免早上第一個請求 cold start |
| `minReplicas`（非工作時段） | **0** | 降低成本；接受 cold start 5-15 秒延遲 |
| `maxReplicas` | **5** | <100 使用者，3-5 足以支援併發峰值 |
| CPU | **0.5 vCPU**（初始） | 按 App Insights 實測再調 |
| Memory | **1 GiB**（初始） | Next.js + Prisma Client 初始足夠 |
| Scale rule | HTTP concurrent requests = **50 per replica** | 超過後新增 replica |
| Ingress | **External**（對 LAN/VPN） | 若啟用 VNet + Private Endpoint 則改 Internal（留待網路決策） |
| Revision mode | **Single**（先採用） | Blue/Green via new revision 觸發 |

**Scheduled Scaling 機制（TBD）**：
- 方案 A：KEDA cron scaler 在 07:30 / 19:30 調整 minReplicas
- 方案 B：Azure Function timer trigger 透過 ARM API 修改
- 方案 C：不啟用 scheduled scaling，只用 `minReplicas=0 + HTTP scale rule`（最簡單但接受早晨第一請求 cold start）
- → Phase 2 決定（預設方案 C，視 UX 需求升級）

**Cold Start 緩解策略**：
- Next.js `output: 'standalone'` 已最小化啟動時間
- Prisma Client 打包入 image（避免 runtime generate）
- Docker image 目標 < 300 MB（加速 pull）
- 預計 cold start 時間：**5-15 秒**（container pull + Next.js boot + Prisma init）

### 決策 2.2：資料庫

| 選項 | 適用場景 | 本專案契合度 |
|------|---------|------------|
| **Azure Database for PostgreSQL Flexible Server** | PostgreSQL PaaS，最新版本 | ⭐⭐⭐⭐⭐ 推薦 |
| Azure Cosmos DB (PostgreSQL API) | 水平擴展、多地區 | ⭐⭐ 成本高、本專案不需要 |
| Azure Database for PostgreSQL Single Server | Legacy，將 deprecate | ❌ 不選 |

**推薦**：**Flexible Server**
- 版本：PostgreSQL 15（與本地一致）
- Tier：依負載估算（Burstable B2s PoC / General Purpose 正式）
- High Availability：Zone-redundant（推薦正式環境）

### 決策 2.3：Blob Storage
- **Azure Blob Storage** — 與 Azurite 本地完全對應，現有代碼無需改動
- Container 命名：`documents`（與 `AZURE_STORAGE_CONTAINER` env 一致）
- Access：Private + SAS token 或 Managed Identity（推薦後者）

### 決策 2.4：Secrets / Config

| 層級 | 工具 |
|------|------|
| 一般 config（非敏感） | Container Apps env vars |
| 敏感 secrets | **Azure Key Vault**（通過 Managed Identity 讀取） |
| 引用方式 | Container Apps secret reference syntax：`@Microsoft.KeyVault(SecretUri=...)` |

**必進 Key Vault**：
- `AUTH_SECRET` / `JWT_SECRET` / `SESSION_SECRET` / `ENCRYPTION_KEY`
- `AZURE_OPENAI_API_KEY` / `AZURE_DI_KEY`
- `AZURE_STORAGE_CONNECTION_STRING`（或改用 Managed Identity + `DefaultAzureCredential`）
- 所有 Microsoft Graph credentials

### 決策 2.5：IaC 工具 — ✅ 已定案（2026-04-22，定位為 Optional Track）

> **決定**：採用 **Bicep**，但定位為**可選軌道（Optional Track）**。
> Bicep 模板作為**規格文件 + 可選資產**：
> - 若 Infra Team 願意採用 → 一鍵 `az deployment` 部署
> - 若 Infra Team 有自己的部署 pipeline → Bicep 作為**資源規格參考**（清楚記錄應建什麼、什麼 SKU、什麼配置）
> - 即使完全不執行 Bicep，也能讓 Infra Team review 應用層需要的資源規格

| 選項 | 優點 | 缺點 |
|------|------|------|
| **Bicep** ✅ 已採用 | Azure 原生、簡潔、ARM Template 升級 | 僅限 Azure |
| Terraform | 多雲、生態成熟 | 需額外學習；本專案無多雲需求 |
| ARM Templates | 原始 | JSON 冗長、難讀 |
| Pulumi（TypeScript） | 與專案語言一致 | 新工具、團隊熟悉度 |

**為何採用 Bicep（而非完全省略 IaC）**：
- 即使「可選」，仍提供寶貴價值：
  - 📐 **規格文件功能**：清楚記錄 9 大資源的配置（容器、DB、KV、Storage、ACR、AI、App Insights、Log Analytics、Network）
  - 🔄 **DR 能力**：若資源被誤刪，可一鍵重建
  - 🌐 **環境一致性**：UAT / Prod 配置漂移檢測
  - 🔐 **可審查**：Security Team 可從 Bicep code review 配置（無需登入 Portal）
- 暫不採用會發生：Portal 點擊建立、配置散落、Infra Team review 困難、未來 DR 重建需 2-3 天

**Infra Team 協作模式（Mode C 混合）**：

| 範圍 | 負責方 | Bicep 提供？ |
|------|-------|-------------|
| **基礎架構層**（Resource Group、VNet、Subnets、Hub-Spoke、Firewall、Private DNS Zones） | Infra Team | ❌ 由 Infra Team 用既有 pipeline / Bicep / Terraform 建立 |
| **共享平台服務**（Key Vault、Log Analytics workspace） | Infra Team 或 App Team | 🟡 提供 Bicep 模板作為參考 |
| **應用層資源**（Container Apps Environment、Container App、ACR、PostgreSQL Flexible、Storage、App Insights） | **App Team**（本專案） | ✅ 完整 Bicep 模板（可由 Infra Team 採用或忽略） |

**目錄結構**：
```
docs/06-deployment/02-azure-deployment/infrastructure/
├── README.md                 ← 「本資料夾為 Optional Track，與 Infra Team 配合使用」
├── bicep/                    ← Bicep 模板（可選使用）
│   ├── main.bicep            ← 應用層資源 orchestration
│   ├── parameters/
│   │   ├── uat.parameters.json
│   │   └── prod.parameters.json
│   └── modules/
│       ├── container-apps.bicep
│       ├── postgres.bicep
│       ├── key-vault.bicep
│       ├── storage.bicep
│       ├── acr.bicep
│       └── app-insights.bicep
├── manual-setup/             ← 等價手動建立流程（Mode B 後備）
│   └── resources-checklist.md
└── resources-inventory.md    ← 完整資源清單與 SKU 決策（Infra Team 必讀）
```

**Phase 2 實施重點**：
- 先寫好 `resources-inventory.md`（規格清單） — 不論 Infra Team 用什麼方式建，都需要這份規格
- Bicep 模板作為附帶交付（不阻塞時程）
- UAT 部署流程文件（見 §🔵）以 **Mode C** 為預設假設，描述「假設 Infra Team 已建好基礎架構，App Team 如何接續部署應用層」

---

## 3️⃣ 🔴 Schema Migration 策略（Critical）— ✅ 已定案（2026-04-22）

> **決定**：採用方案 A（重建基線）+ 舊 10 個 migrations 歸檔到 `prisma/migrations/_archive/` + 新基線命名 `0001_initial_baseline`。
> **追蹤**：獨立 CHANGE-056（`prisma-migration-baseline`）管理，與 CHANGE-055 平行推進（Phase 2 依賴）。

### 現況
- 本地使用 `prisma db push --accept-data-loss`
- Prisma Schema 定義 122 models / 113 enums
- `prisma/migrations/` 只有 10 個 migrations（停留在 2025-12-19）

### 方案 A：**重建 Migration 基線（✅ 已採用）**

**步驟**：
1. 從**乾淨**的資料庫執行 `prisma migrate dev --name initial_baseline`，讓 Prisma 自動生成涵蓋所有 122 models 的 migration
2. 驗證此 migration 能完整建立 schema
3. 之後所有 schema 變更都走 `prisma migrate dev`（不再 `db push`）
4. 生產部署用 `prisma migrate deploy`

**優點**：
- ✅ 有完整的 migration 歷史
- ✅ Prod 部署可追溯、可 rollback
- ✅ 符合 Prisma 官方最佳實踐

**缺點**：
- ⚠️ 既有本地開發環境需**重新初始化 migration history**
- ⚠️ 過去所有 schema 變更會被壓縮成單一 "initial baseline" migration
- ⚠️ 若已部署過某個 prod 環境，需 `prisma migrate resolve` 同步狀態

### 方案 B：**接受 `db push` 繼續使用**

- 生產部署也用 `prisma db push --skip-seed`（不用 --accept-data-loss）
- 僅在破壞性變更時手動寫 migration

**優點**：簡單
**缺點**：🔴 prod 無法可靠 rollback，資料損失風險

### 已採用：**方案 A**（2026-04-22 定案）
- 作為獨立 CHANGE 追蹤：**CHANGE-056（`prisma-migration-baseline`）**
- 先在本地驗證完整流程後，才能用在 prod
- 與 CHANGE-055 關係：CHANGE-055 Phase 2 的「Schema migration 正式化」工作項委派給 CHANGE-056 完成

### 方案 A 執行順序（已定）
1. **歸檔舊 migrations**：`prisma/migrations/*` → `prisma/migrations/_archive/`（保留歷史紀錄不刪除）
2. **建立空 DB**：`dropdb && createdb`（乾淨環境）
3. **產生新基線**：`npx prisma migrate dev --name initial_baseline`（自動生成涵蓋 122 models 的 SQL）
4. **Diff 比對**（雙重驗證）：
   - `npx prisma db pull --schema=./prisma/schema.verify.prisma` 從現有 dev DB 抽 schema
   - 比對 `schema.prisma` vs `schema.verify.prisma`，確認零差異
5. **Staging 驗證**：在 staging 環境用新 migration 重建 DB，smoke test
6. **團隊同步**：所有 dev 成員 `rm -rf prisma/migrations && git pull && npx prisma migrate dev`（一次性重置）
7. **切換工作流程**：禁用 `prisma db push`（CI 檢查），改用 `prisma migrate dev`（local）+ `prisma migrate deploy`（prod）

### 舊 migrations 處置（已定）
- **處置方式**：選項 (a) — 歸檔到 `prisma/migrations/_archive/`
- **新基線命名**：`0001_initial_baseline`（從頭計數，不繼承舊編號）
- **理由**：
  - 保留歷史不刪除（審計留痕）
  - 新基線乾淨無包袱
  - 舊 migrations 從未上 prod，無 `migrate resolve` 需求

### 風險與緩解
| 風險 | 緩解措施 |
|------|---------|
| 本地 dev 環境重置困擾 | 一次性痛，文件化於 `database/migration-strategy.md`，團隊同步 |
| Diff 遺漏某些欄位/索引 | 雙重驗證（`schema.prisma` vs `db pull` 結果）+ PoC 階段手動 review |
| CI 誤用 `db push` | 新增 ESLint / pre-commit hook 擋 `db push` 指令 |

---

## 4️⃣ 🔴 Seed 策略 — ✅ 已定案（2026-04-22）

> **決定**：採用**混合策略** — essential seed 部署時自動執行 + reference seed 首次上線手動執行。Reference data 來源為「手動重新整理一份 prod-grade JSON」。
> **Mapping Rules 採分層處理**：Tier 1 Universal 進 seed、Tier 2 Forwarder-specific **不進 seed**（透過系統學習機制建立）。

### 區分三類 seed（採用混合策略）

| 類別 | 範圍 | 是否進 prod？ | 執行時機 |
|------|------|--------------|---------|
| **Essential Seed**（自動） | Roles、Regions、Cities、System User、Default SystemSetting、FeatureFlag | ✅ 必須 | 每次部署自動（idempotent） |
| **Reference Seed**（手動一次） | Companies 基本資料、Tier 1 Universal Mappings、Prompt Configs、預設 Exchange Rates | ✅ 推薦 | 首次上線手動執行一次 |
| **Development Seed**（不進 prod） | Dev User (`dev-user-1`)、Test Companies、`exported-data.json` 測試資料 | ❌ 禁止 | 僅本地 `seed.ts` |

### 設計決策 — 檔案拆分

```
prisma/
├── seed.ts                      ← 本地/dev（現有，含 dev-user-1 + exported-data.json）
├── seed-prod-essential.ts       ← production 自動 seed（Role/Region/City/SystemUser/Settings）
├── seed-prod-reference.ts       ← production 手動 seed（Companies + Tier 1 Mappings + Prompts + Rates）
└── seed-data/
    ├── essential/               ← 共用 essential 資料（roles.json、cities.json、regions.json）
    └── reference/               ← prod-grade reference JSON（手動整理）
        ├── companies.json       ← ≤100 間公司基本資料
        ├── tier1-mappings.json  ← Universal Mapping 規則（70-80% 常見術語）
        ├── prompt-configs.json  ← 預設 GPT 提示詞配置
        └── exchange-rates.json  ← 初始匯率快照
```

`package.json`（生產用）：
```json
"scripts": {
  "seed:prod:essential": "ts-node prisma/seed-prod-essential.ts",
  "seed:prod:reference": "ts-node prisma/seed-prod-reference.ts --confirm"
}
```

### Seed 執行時機

| 階段 | 腳本 | 執行方式 | 冪等性 |
|------|------|---------|--------|
| 每次部署 | `seed-prod-essential.ts` | CI/CD 自動（migrate 後、app start 前） | ✅ 必須 idempotent（`upsert`） |
| 首次上線 | `seed-prod-reference.ts` | 手動執行一次（DBA approval） | ✅ idempotent + `--confirm` 保護 |
| 後續更新 | 不再自動 seed reference | Admin UI 變更或專用 script | N/A |

**保護機制**：
- `seed-prod-reference.ts` 必須帶 `--confirm` flag 或環境變數 `PRISMA_SEED_PROD_ALLOW=true` 才執行
- Reference data 變更透過 Admin UI（非 re-seed），避免覆寫 prod 使用者建立的資料

### 🎯 Mapping Rules 分層處理（關鍵決策）

> 使用者提問：「每間公司 5-10 個 mapping rules，還沒確定的也要做成 seed 嗎？」
> **回答：不要**。採用 Tier 1 / Tier 2 分層處理。

| 層級 | 資料範圍 | 是否進 seed | 理由 |
|------|---------|-----------|------|
| **Tier 1: Universal Mapping**（70-80% 常見 Freight Invoice 術語） | 全 Forwarder 通用、相對穩定 | ✅ **進 `seed-prod-reference.ts`** | 系統運作基礎、無公司特異性 |
| **Tier 2: Forwarder-Specific Override**（每間公司 5-10 個 override） | 尚未確定、會隨實際文件樣本演化 | ❌ **不進 seed** | 透過學習機制（`rule-suggestion-generator`）建立 |
| **Tier 3: LLM Classification** | 執行期動態產生 | ❌ 不進 seed（無資料） | 由 GPT 運行時推理 |

**Tier 2 建立流程（上線後 1-3 個月學習期）**：
1. V3.1 智能降級機制：新公司 → 強制 FULL_REVIEW（保護機制）
2. 審核員手動修正 → 系統記錄為候選 rule
3. `rule-suggestion-generator` 累積一定修正次數後提示加入 Tier 2
4. Admin 審核通過 → 寫入 `MappingRule` 表
5. 穩定後：prod 已驗證的 Tier 2 rules 可匯出成 JSON 作為**下一環境**（例如 DR 備援站）的 seed

**首次上線 Mapping 規模預估**：
- Tier 1 Universal：**約 50-200 條**（涵蓋常見 freight charge 術語：AIR_FREIGHT、FUEL_SURCHARGE、TERMINAL_HANDLING 等）
- Tier 2 Forwarder-specific：**0 條**（留空，透過學習建立）
- Companies 基本資料：**≤100 間**

### System User 建立（與 FIX-054 整合）
- FIX-054 機制已支援 `SYSTEM_USER_ID` env 覆蓋
- `seed-prod-essential.ts` 建立固定 `system-user-prod` 或由 env 指定 UUID
- Container Apps env var `SYSTEM_USER_ID` 注入（不放 Key Vault，因非敏感）
- Prod 嚴禁使用 `dev-user-1`

---

## 5️⃣ 配置注入

### 映射表：`.env` ↔ Azure

| `.env` 變數 | Azure 位置 | 機制 |
|------------|-----------|------|
| `DATABASE_URL` | Key Vault secret → Container Apps secret ref | Managed Identity |
| `AUTH_SECRET` / `JWT_SECRET` / `SESSION_SECRET` / `ENCRYPTION_KEY` | Key Vault | secret ref |
| `AZURE_OPENAI_*` / `AZURE_DI_*` | Key Vault（API keys） + Container Apps env（endpoint） | 分開 |
| `AZURE_STORAGE_*` | Managed Identity + DefaultAzureCredential | 改代碼（移除 connection string 寫法） |
| `SYSTEM_USER_ID` | Container Apps env var | 直接設 |
| `NODE_ENV` | Container Apps env var | `"production"` |
| `AUTH_TRUST_HOST` | Container Apps env var | `"false"`（已走 HTTPS） |
| `AUTH_URL` | Container Apps env var | 正式域名 |
| `NEXT_PUBLIC_APP_URL` | Container Apps env var | 正式域名 |

### Managed Identity 優先
凡是能用 Managed Identity 的地方都用（減少 secret rotation 負擔）：
- Blob Storage → System-Assigned Identity + Storage Blob Data Contributor role
- Key Vault → System-Assigned Identity + Get/List secrets policy
- Azure OpenAI → Managed Identity + Cognitive Services User role（若支援）

---

## 6️⃣ CI/CD Pipeline

### 推薦：GitHub Actions

```yaml
# .github/workflows/deploy-prod.yml
name: Deploy to Azure Production
on:
  push:
    branches: [main]
    paths:
      - 'src/**'
      - 'prisma/**'
      - 'package.json'
      - 'Dockerfile'

jobs:
  test:
    # npm run type-check + lint
  build-and-push:
    needs: test
    # docker build + push to ACR
  migrate:
    needs: build-and-push
    # prisma migrate deploy（連 prod DB 執行）
  deploy:
    needs: migrate
    # az containerapp update --image ACR/...
```

### 關鍵設計
- **Migration 在 deploy 前**：避免 app 啟動時 schema 不符
- **Migration 失敗則中止 deploy**：保護資料庫
- **Blue/Green via Container Apps Revisions**：流量切換零 downtime
- **Rollback**：`az containerapp revision set-mode --mode single --revision <previous>`

### Pull Request Preview（可選）
- 每個 PR 自動部署到獨立 revision（不同 weight）
- PR merge / close 後清理
- 成本較高，先不實施

---

## 7️⃣ 部署前自檢

### `verify-environment.ts` 改造為 Azure-aware

新增 `--production` flag：
```bash
npm run verify-environment -- --production
```

**production 模式差異**：
| 檢查項 | local | production |
|--------|-------|-----------|
| Docker 容器 | 檢查 | **跳過** |
| DATABASE_URL port | 5433 預期 | 5432 預期（Flexible Server） |
| Placeholder 偵測 | ✅ | ✅（更嚴格） |
| Key Vault 可達性 | - | **新增檢查** |
| Managed Identity | - | **新增檢查** |
| Application Insights 連線 | - | **新增檢查** |

實作方式：
- 環境變數 `NODE_ENV=production` 時自動啟用 production 模式
- 或 CLI flag `--production`

---

## 8️⃣ 運維觀測

### Application Insights 整合
```typescript
// 預期新增 src/lib/telemetry.ts
import { ApplicationInsights } from '@microsoft/applicationinsights-web'
```

**追蹤項目**：
- 所有 API route 延遲
- V3 extraction pipeline 各 stage 耗時
- Prisma query 效能
- 外部 API 失敗率（Azure OpenAI / Document Intelligence）

### 既有 `AlertRule` model 整合
- 本地 `AlertRule` / `AlertRecord` 繼續作為「業務層警報」
- Azure Monitor Alerts 做「基礎設施層警報」
- 兩者可透過 webhook 雙向同步

### Log 策略
- 應用 log → `stdout` → Container Apps log → Log Analytics
- 結構化 log（JSON）方便查詢
- PII 過濾（與 FIX-050 同樣嚴格）

---

## 9️⃣ 安全強化

### HTTPS Only / TLS 1.2+
- Container Apps 預設 HTTPS ingress
- Custom domain + managed certificate
- `AUTH_TRUST_HOST="false"`

### Azure AD 真實 SSO
- 關閉 dev mode（`NODE_ENV=production` 時 `auth.config.ts` 已跳過 dev bypass）
- Azure AD App Registration 正式設定
- Conditional Access policies

### Rate Limit 強制啟用
- Upstash Redis 正式配置（`UPSTASH_REDIS_REST_URL` / `_TOKEN`）
- 所有 API 啟用 rate limit middleware（FIX-052 已支援 Redis 優先）

### Network 層級 — 🔁 委外 Infra Admin（2026-04-22 定案）

> **決定**：網路架構**完全委外 Infra Admin 負責**。本文件僅提供**應用層對網路的需求清單**作為 Infra Admin 設計輸入。

**App Team 對網路的需求清單（給 Infra Admin）**：

| 通訊路徑 | 需求 | 說明 |
|---------|------|------|
| User → Container App | HTTPS（443）入口 | LAN/VPN 內或公網 + IP allowlist 由 Infra Admin 決定 |
| Container App → PostgreSQL | TCP 5432 | 應用必須能 reach DB（Managed Identity 認證） |
| Container App → Key Vault | HTTPS（443） | Managed Identity 讀 secrets |
| Container App → Blob Storage | HTTPS（443） | Managed Identity + DefaultAzureCredential |
| Container App → Azure OpenAI | HTTPS（443） | API key 或 Managed Identity |
| Container App → Document Intelligence | HTTPS（443） | API key |
| Container App → ACR | HTTPS（443） | Pull image，Managed Identity |
| Container App → SharePoint / Outlook | HTTPS（443） | Microsoft Graph API |
| Container App → SMTP（Email 通知）| TCP 587 / 465 | 視 SMTP server 配置 |
| GitHub Actions → ACR | HTTPS（443） | Push image |
| GitHub Actions → Container Apps | HTTPS（443） | `az containerapp update` |
| GitHub Actions → PostgreSQL | TCP 5432 | `prisma migrate deploy` |

**App Team 不關心的層**（Infra Admin 自行決定）：
- VNet topology（Hub-Spoke / Single VNet / Multi-region）
- Private Endpoint vs Service Endpoint
- NSG rules、Firewall、Web Application Firewall
- DDoS protection
- 跨 region 連通性

### HA 要求 — ✅ 已定案（2026-04-22）

> **決定**：**暫不需要 Zone-redundant HA**，但保留每日自動備份 + 還原 runbook 作為最低限度資料保護。

| 項目 | 決定 | 理由 |
|------|------|------|
| Container Apps Zone-redundant | ❌ 不需要 | Pilot 階段使用者少，可接受短暫 downtime |
| PostgreSQL Zone-redundant HA | ❌ 不需要 | 成本考量 + Pilot 階段 |
| 跨 region Geo-redundant | ❌ 不需要 | 內部系統，無跨地理需求 |
| **每日自動備份**（DB） | ✅ **必須** | 資料保護不可妥協 |
| **每日 PITR**（Point-in-time recovery）| ✅ 啟用 | Azure PostgreSQL Flexible 預設支援 |
| **Blob Storage soft-delete** | ✅ 啟用 | 防止文件誤刪 |
| **Key Vault soft-delete + purge protection** | ✅ 啟用 | 防止 secret 永久遺失 |
| **DR Runbook** | ✅ 必須建立 | 即使無 HA，需有書面還原流程 |

**未來升級路徑**（Pilot 後若必要）：
- Pilot 後若使用者規模增長或業務容忍度下降，可在 W11+ 升級 DB 為 Zone-redundant（重啟即可，無需架構變更）
- 升級成本評估留待 Infra Admin 在 Full Rollout 前重新評估

**RTO / RPO 預期**（無 HA 情境）：
- **RTO**：< 4 小時（單 AZ 故障 + 手動切換 + DB 還原）
- **RPO**：< 24 小時（每日備份）
- 若業務無法接受此 RTO/RPO，需重新討論 HA 決策

### Secret Rotation
- `AUTH_SECRET` / `JWT_SECRET` / `SESSION_SECRET`：每季輪替
- `ENCRYPTION_KEY`：🔴 **不可變更**（變更會讓加密資料無法解密）
- Azure OpenAI / DI API Keys：半年輪替
- 文件化於 `security/secret-rotation-runbook.md`（待建）

---

## 🔟 Azure 資源預算與 Tier 選型 — 🔁 委外決策（2026-04-22）

> **狀態**：由 **Infra Admin 與開發者另行討論決定**。本章節僅提供技術選項清單與估算作為討論輸入。
> **CHANGE-055 範圍**：不決定最終 tier，待 Infra Admin 討論後更新此章節。

### 技術選項清單（供討論）

| 資源 | 保守方案（PoC/低流量） | 標準方案（正式上線建議） | 企業方案（HA + 網路安全） |
|------|---------------------|-----------------------|------------------------|
| **Container Apps** | Consumption plan，0-2 replica | Consumption plan，1-5 replica（工作時段 min=1） | Dedicated workload profile，3-10 replica + Zone redundancy |
| **PostgreSQL Flexible** | B2s Burstable（2 vCore、4GB） | D2ds_v5 General Purpose（2 vCore、8GB） | D2ds_v5 + Zone-redundant HA + Read replica |
| **Blob Storage** | LRS、Hot tier | ZRS、Hot tier + Lifecycle to Cool | GZRS + Immutable blob（合規要求） |
| **Azure OpenAI** | Pay-as-you-go | Provisioned Throughput（若併發要求高）或 PAYG | PTU + Content Filter strict |
| **Document Intelligence** | F0 Free tier（1,000 頁/月上限） | S0 Standard（按頁計費） | S0 + Private Endpoint |
| **Key Vault** | Standard | Standard + Soft-delete + Purge protection | Premium（HSM-backed keys） |
| **ACR** | Basic | Standard | Premium（geo-replication、Content Trust） |
| **App Insights / Log Analytics** | 5 GB 免費額度 | 30-day retention、sampling | 90-day retention + long-term storage |
| **Front Door / WAF** | ❌ 不需要 | ⚠️ 視公開需求 | ✅ Azure Front Door Premium + WAF |
| **VNet + Private Endpoints** | ❌ 不需要 | ⚠️ 可選 | ✅ 必須（DB/Storage/KV 全走 Private） |

### 月成本估算範圍（USD，Southeast Asia region）

> ⚠️ 以下為 AI 助手粗估，**非官方報價**，Infra Admin 需以 Azure Calculator 實際試算。

| 方案 | 基礎設施 | AI 服務（450-500K 張/年） | 月總計 |
|------|---------|-----------------------|--------|
| 保守 | $120-230 | $975-1,500 | **$1,100-1,730** |
| 標準 | $420-770 | $975-1,500 | **$1,400-2,270** |
| 企業（HA+安全） | $1,000-1,900 | $975-1,500 | **$2,000-3,400** |

### AI 服務用量假設（計算依據）

| 服務 | 假設 | 月成本 |
|------|------|--------|
| Document Intelligence Prebuilt Invoice | 37.5K 張/月 × 2 頁平均 × $0.01/頁 | **$750/月** |
| Azure OpenAI GPT-5.2 (Tier 3 分類) | 37.5K × 20% 觸發 = 7.5K 次 × (3K input + 1K output tokens) × ($5/$15 per 1M) | **$225/月** |
| **AI 小計** | — | **~$975/月** |

### 討論輸入 Checklist（Infra Admin 會議用）

- [ ] 是否需要 Zone-redundant HA？（DB 成本 +50%，但避免單 AZ 故障）
- [ ] 是否啟用 VNet + Private Endpoint？（企業級標配，但增加網路複雜度）
- [ ] Azure OpenAI 是否採 Provisioned Throughput？（併發峰值需求決定）
- [ ] Log 保留週期：30 / 60 / 90 days？（合規要求）
- [ ] DR（Disaster Recovery）需求：Active-Passive / Active-Active / 無？
- [ ] 月度預算上限：？
- [ ] 上線 Deadline：？（影響可否分階段升級 tier）
- [ ] Subscription 模型：單一 sub / 多 sub（dev/staging/prod 分離）？

### Infra Admin 討論後更新位置

討論結果將更新至本文件並補充以下子文件：
- `infrastructure/resources-inventory.md` — 各資源 SKU / 規格定案
- `infrastructure/cost-estimate.md` — Azure Calculator 官方試算截圖與月成本承諾

---

## 🔵 UAT 部署流程文件（核心交付物）— ✅ 規劃定案（2026-04-22）

> **目標**：產出一套**人 + AI 雙向可讀**的 UAT 部署流程文件，作為實際部署到 Azure 的**可執行 SOP**。
> **執行模式**：AI 助手可全自動執行（含敏感操作），文件設計為「跟隨即可完成部署」。
> **協作前提**：Mode C 混合 — 假設 Infra Team 已建好基礎架構（RG/VNet/共享 KV 等），App Team 接續部署應用層。

### 為何要這份文件

| 痛點 | UAT 部署文件解決什麼 |
|------|-------------------|
| 部署知識存在腦中、易遺失 | ✅ 步驟結構化、可追溯 |
| 新人接手需 1-2 週上手 | ✅ 跟著文件即可執行 |
| AI 助手會話失憶 | ✅ 任何 session 讀文件即可繼續 |
| 部署失敗後排錯困難 | ✅ 每步有 verify + if_fails 分支 |
| Infra Team 對接資訊散落 | ✅ Prerequisites 集中說明 |
| Prod 部署無法演練 | ✅ UAT = Prod 流程預演 |

### 文件清單（12 份，命名固定）

| 編號 | 檔名 | 用途 | 預估行數 |
|------|------|------|---------|
| 00 | `00-overview.md` | UAT 環境目標、架構、Mode C 邊界、文件導讀 | ~150 |
| 01 | `01-prerequisites.md` | 執行前置條件 checklist（Azure subscription / RBAC / 工具版本 / Infra Team 已建資源清單） | ~200 |
| 02 | `02-azure-resources-setup.md` | App 層 Azure 資源建立（ACR / Container Apps Env / Container App / PostgreSQL / Storage / App Insights） | ~400 |
| 03 | `03-secrets-configuration.md` | Key Vault secrets 注入（AUTH_SECRET / ENCRYPTION_KEY / API keys 等） | ~250 |
| 04 | `04-container-build-push.md` | Docker build + push to ACR + image tag 策略 | ~200 |
| 05 | `05-database-migration.md` | Schema migration（套用 CHANGE-056 baseline）+ migration verification | ~250 |
| 06 | `06-seed-essential.md` | Essential seed 執行（Roles / Regions / Cities / SystemUser / SystemSettings） | ~200 |
| 07 | `07-seed-reference.md` | Reference seed 手動執行（Companies / Tier 1 Mappings / Prompts / Rates） | ~250 |
| 08 | `08-first-deployment.md` | Container Apps 首次 revision 部署 + Managed Identity 配置 | ~300 |
| 09 | `09-verification.md` | 部署後 smoke test（health check / login / upload / extract / Mapping Tier 1） | ~250 |
| 10 | `10-rollback-procedure.md` | 回滾流程（revision 切換 / DB 還原 / image 回退） | ~200 |
| 11 | `11-troubleshooting.md` | 常見問題排解（含錯誤訊息 → 解法對照表） | ~300 |
| 99 | `99-ai-execution-guide.md` | 🤖 AI 助手執行指南（如何依序執行、如何處理失敗、如何寫入 deployment-state） | ~250 |

**目錄位置**：`docs/06-deployment/02-azure-deployment/uat-deployment/`
**總計**：~3,200 行可執行文件

### 文件設計原則（人 + AI 雙向可讀）

| 原則 | 做法 | AI 可讀 | 人可讀 |
|------|------|--------|--------|
| **YAML Frontmatter** | 每文件含 metadata（step_id / prerequisites / outputs / requires_approval） | ✅ 程式可解析 | ✅ 快速索引 |
| **結構化步驟** | 每步有唯一 ID（STEP-02-Action-2.1） | ✅ 可被引用 | ✅ 易追蹤 |
| **可執行命令** | 所有操作為 ```bash``` / ```azurecli``` / ```powershell``` 區塊 | ✅ 可直接執行 | ✅ 可複製 |
| **驗證命令** | 每步驟有 `verify:` 區塊（執行 + 預期輸出） | ✅ 可判斷成功 | ✅ 可自檢 |
| **預期輸出** | `expected_output:` 區塊使用精確字串或 regex | ✅ 可比對 | ✅ 可確認 |
| **失敗分支** | `if_fails:` 區塊，定義錯誤訊息 → 對應行動 | ✅ 自動回退 | ✅ 排錯參考 |
| **環境變數** | 集中宣告（不散落 inline）+ `${VAR}` 引用 | ✅ 可注入 | ✅ 可調整 |
| **狀態檔** | 步驟成功後寫入 `deployment-state/uat.yaml`（記錄 outputs 如 ACR_LOGIN_SERVER） | ✅ 跨步驟讀取 | ✅ 可追溯 |
| **Approval Gates** | 敏感操作標記 `requires_approval: true`（DB migration / seed reference / first deployment） | ✅ AI 可暫停 | ✅ 安全 |
| **無模糊表達** | 不用「大約」「請耐心等待」「應該會」 | ✅ 明確可執行 | ✅ 明確 |

### 標準步驟模板（範例）

每個 STEP 文件遵循以下骨架（為避免巢狀 code block 渲染問題，以下用縮排方式呈現）：

    ---
    document_type: deployment_procedure
    step_id: STEP-NN
    title: <Step Title>
    estimated_duration: NN minutes
    requires_approval: true|false
    approver: infra-admin|app-team-lead|none
    environment: uat|prod
    prerequisites:
      - STEP-XX completed
      - <other conditions>
    outputs:
      - <key>: <description>
    ---

    # STEP-NN: <Title>

    ## 🎯 Objective
    <一句話描述目標>

    ## ✅ Prerequisites
    - [ ] <條件 1>
    - [ ] <條件 2>

    ## 📝 Environment Variables
    ```bash
    export VAR1="value1"
    export VAR2="value2"
    ```

    ## 🔧 Action NN.1: <Action Name>
    ### Command
    ```bash
    <exact command>
    ```

    ### Verify
    ```bash
    <verify command>
    ```

    ### Expected Output
    ```
    <exact expected output or regex>
    ```

    ### If Fails
    - Error: `<error pattern>` → <action>
    - Error: `<error pattern>` → <action>

    ## 🤖 AI Execution Hint
    <給 AI 的特殊指示，例如何時暫停、如何寫狀態檔>

    ## ✅ Exit Criteria
    - [ ] All Actions verified
    - [ ] State file updated
    - [ ] Proceed to STEP-(NN+1)

### AI 執行範圍（範圍 b：全自動）

| 操作類型 | AI 自動執行？ | 補充 |
|---------|------------|------|
| `az` CLI 唯讀指令（show / list） | ✅ | 用於 verify |
| Docker build / push | ✅ | 自動執行 |
| Resource creation（Container App / DB / KV） | ✅ | 但需 `requires_approval` 提示 |
| Schema migration（`prisma migrate deploy`） | ✅ | `requires_approval: true`（敏感） |
| Seed essential | ✅ | 冪等可重執行 |
| Seed reference（首次） | ✅ | `requires_approval: true`（影響 prod-grade 資料） |
| First deployment（first revision） | ✅ | `requires_approval: true`（觸發業務影響） |
| Rollback | ✅ | `requires_approval: true`（破壞性） |

> **注意**：「全自動」不等於「無人值守」。`requires_approval: true` 的步驟，AI 仍會在執行前詢問人工確認。

### 與 IaC（Bicep）的關係

| 場景 | UAT 文件如何描述 |
|------|----------------|
| Infra Team 採用我們的 Bicep | STEP-02 改為 `az deployment group create -f main.bicep` 一鍵 |
| Infra Team 用自己的 pipeline | STEP-02 列出每個 `az` CLI 指令（手動建立等價於 Bicep） |
| Infra Team 已建好部分資源 | STEP-01 prerequisites 清楚標出「以下需 Infra Team 已建：xxx」 |

文件預設**雙路徑並存**：每個 STEP-02-09 都同時提供「Bicep 一鍵」與「手動 az CLI」兩種選項，AI / 人讀者可擇一執行。

### 後續執行計劃（v0.3 後分批產出）

| 階段 | 產出 | 預估時間 |
|------|------|---------|
| **階段 B**（下個 session） | 12 份文件骨架 + 00/01/99 完整內容 | 1 day |
| **階段 C**（並行 Agent） | 02-11 詳細內容（可派發多個 agents 並行） | 2-3 days |
| **階段 D**（最後或同步） | Bicep 模板（optional track） | 2 days |
| **階段 E**（Phase 2 結束前） | 在 UAT 環境模擬執行驗證 | 1 day |

---

## ⏰ 時程規劃 — ✅ 已定案（2026-04-22）

> **上線目標**：**2026 年 7 月**（Pilot 階段）
> **今日**：2026-04-22 → 距 7/1 約 **10 週**
> **策略**：漸進式上線（Pilot → Expansion → Full Rollout）

### 10 週 Sprint 對齊 7 月 Pilot

| 週次 | 日期區間 | 階段 | 主要產出 |
|------|---------|------|---------|
| **W1** | 04/22-04/28 | Phase 1 收尾 | CHANGE-055 v0.3 + UAT 文件骨架（00/01/99）+ 評審會議約定 |
| **W2** | 04/29-05/05 | 評審 + Phase 2 開工 | 4 方架構評審 Pass + Bicep 開工 + UAT 文件 02-05 |
| **W3** | 05/06-05/12 | Phase 2 進行 | Bicep 完成 + Dockerfile + Key Vault 整合 + UAT 文件 06-08 |
| **W4** | 05/13-05/19 | Phase 2 收尾 | **🎯 首次手動部署到 Azure UAT 成功** + UAT 文件 09-11 |
| **W5** | 05/20-05/26 | Phase 3 + CHANGE-056 實施 | Schema baseline 重建（CHANGE-056） + GitHub Actions workflow |
| **W6** | 05/27-06/02 | Phase 3 收尾 | CI/CD 端對端通 + Migration hook + Pull request preview（可選） |
| **W7** | 06/03-06/09 | Phase 4 開工 | Application Insights 整合 + Alert rules |
| **W8** | 06/10-06/16 | Phase 4 進行 | Secret rotation 文件 + DR runbook + 備份策略 |
| **W9** | 06/17-06/23 | UAT + Pen-test | UAT 環境完整測試 + Security pen-test + 修復 |
| **W10** | 06/24-06/30 | Final Gate | Go-Live Review + 使用者培訓 + Runbook fina  l |
| **🚀** | **07/01** | **Pilot 上線** | HKG/SIN 1-2 城市 + 10-20 內部使用者 |
| W11+ | 07-08 月 | Expansion | 擴展到 APAC 全區 + 10+ Forwarders |
| W11+ | 09-10 月 | Full Rollout | 全部 100 個 Companies + 所有使用者 |

### Pilot 範圍（7 月上線）

| 項目 | Pilot 範圍 | Full Production 範圍 |
|------|-----------|------------------|
| 城市 | HKG + SIN（2 個） | APAC 全區（10+ 城市） |
| 使用者數 | 10-20 人（內部） | <100 人 |
| Companies | 5-10 間（核心 Forwarder） | ≤100 間 |
| Tier 1 Mappings | 50-100 條（最常用） | 50-200 條 |
| Tier 2 Mappings | 0 條（學習中） | 學習期累積 |
| 文件處理量 | 100-200 張/週 | 1,400-1,700 張/工作日 |

### 風險點與緩解

| 風險 | 機率 | 緩解 |
|------|------|------|
| 4 方評審延遲 1-2 週 | 🟡 中 | W1 內約好 W2 會議；準備非同步 review 文件 |
| Infra Team 資源建立延遲 | 🟡 中 | Mode C 並行：App Team 先用本地模擬，Infra Team 同時建 Azure 資源 |
| Schema migration（CHANGE-056）PoC 失敗 | 🟢 低 | W4 已預留 1 週 buffer，可延到 W5 |
| Pen-test 發現重大漏洞 | 🟡 中 | W9 預留 1 週修復；嚴重時延 Pilot 1 週 |
| Azure quota / 申請審批延遲 | 🟡 中 | W1 立即提交資源申請（不等評審） |
| **Phase 4 被壓縮** | 🔴 高 | 接受：Pilot 階段可降低 Observability 完整度，Full Rollout 前補齊 |

### Buffer / Slack

- 整體 10 週時程已內含 **~1 週 buffer**（W4 + W9）
- 若 Pilot 推遲 1 週至 7/8，影響可控
- 若推遲 ≥2 週至 7/15，建議**降級為 Soft Launch**（內部 demo + 不正式對外）

---

## 🏛️ 架構評審流程 — ✅ 已定案（2026-04-22）

> **參與團隊**：DevOps / Platform Team + Security Team + Infra Admin + App Team（4 方）
> **形式**：會議 + 非同步文件審查（混合）
> **ADR 流程**：無（不需遵守特定 ADR 規範）

### 3 階段 Review

| 階段 | 時機 | 參與者 | 產出 |
|------|------|--------|------|
| **Review 1：架構評審** | W1 結束（04/28 前） | 4 方全員 | 9 大類決策簽核、CHANGE-055 v1.0 文件、可開工 Phase 2 |
| **Review 2：實施前 Gate** | W4 結束（05/19 前） | DevOps + App Team + Infra Admin | Bicep 模板審查、首次部署 plan 簽核、可進 CI/CD |
| **Review 3：Go-Live Gate** | W10 結束（06/30 前） | 4 方 + 業務 Owner | Pen-test 結果、Runbook、DR 演練、可 Pilot 上線 |

### 評審形式

#### 會議部分
- **Review 1**：90 分鐘，所有 9 大決策逐項討論
- **Review 2**：60 分鐘，Bicep + Dockerfile + 部署流程
- **Review 3**：90 分鐘，Go/No-Go 決策

#### 非同步部分
- 會議前 3 個工作日：本文件 + UAT 部署流程文件 PR 開放各團隊 review
- 會議後 1 週：comments 處理 + 文件更新
- 各團隊指派 1 名 reviewer 在 GitHub PR 留 comment

### 各團隊 Review 焦點（給 reviewer 的指引）

| 團隊 | Review 焦點 |
|------|-----------|
| **DevOps / Platform Team** | IaC 規範、CI/CD pattern、Container Apps 配置、監控標準、log strategy |
| **Security Team** | Secret rotation、Managed Identity、RBAC、network 邊界、PII handling、Pen-test scope |
| **Infra Admin** | 資源 SKU、成本、subscription 結構、quota、網路架構、HA / DR、備份策略 |
| **App Team**（本專案）| 應用層需求、Schema migration、Seed 策略、Container App 配置、應用 / 業務測試 |

### 通過標準（Pass Criteria）

| Review | Pass 條件 |
|--------|---------|
| Review 1 | 各團隊代表在 PR 留 ✅ approve；無 🔴 blocker comment |
| Review 2 | UAT 首次部署演練成功 + 無 Security 🔴 阻塞項 |
| Review 3 | Pen-test 報告通過 + DR 演練通過 + Runbook 完整 |

### 評審文件 placeholder

```
docs/06-deployment/02-azure-deployment/reviews/
├── review-1-architecture/
│   ├── meeting-notes.md       ← Review 1 會議紀錄
│   ├── review-comments.md     ← 各團隊 PR comments 彙整
│   └── decisions.md           ← 評審後的決策補充
├── review-2-implementation/
│   └── ...
└── review-3-golive/
    └── ...
```

---

## 📊 Effort 估算（v0.3 對齊 10 週 Sprint）

| Phase | 子項 | Effort（Person-Day） | 對應週次 |
|-------|------|---------------------|----------|
| **1.1** 主規劃文件 v0.3 | 本文件 | 1 | W1 |
| **1.2** UAT 文件骨架（00/01/99） | 階段 B | 1 | W1 |
| **1.3** 架構評審準備 + Review 1 | 會議 + 文件 PR | 2 | W1-W2 |
| **Phase 1 total** | | **~4 days** | W1-W2 |
| **2.1** UAT 文件 02-11（並行多 agents） | 階段 C | 4-5 | W2-W3 |
| **2.2** Dockerfile + build | | 2 | W2 |
| **2.3** Bicep IaC（optional track） | 階段 D | 4-5 | W2-W4 |
| **2.4** Key Vault 整合代碼 | | 2 | W3 |
| **2.5** verify-environment --production | | 1 | W3 |
| **2.6** seed-prod-essential.ts + seed-prod-reference.ts | | 2 | W3 |
| **2.7** Reference data 整理（≤100 companies + Tier 1 mappings JSON） | | 3-5 | W3-W4 |
| **2.8** 🎯 首次手動部署到 UAT（W4 milestone） | | 1 | W4 |
| **2.9** Review 2 評審 | | 1 | W4 |
| **Phase 2 total** | | **~20-24 days** | W2-W4 |
| **3.1** Schema migration 重建（CHANGE-056） | PoC + 實施 | 3-4 | W5 |
| **3.2** GitHub Actions workflow | | 3 | W5 |
| **3.3** Migration hook | | 2 | W5-W6 |
| **3.4** Blue/Green deployment 演練 | | 2 | W6 |
| **Phase 3 total** | | **~10-11 days** | W5-W6 |
| **4.1** App Insights 整合 | | 3 | W7 |
| **4.2** Alert rules（Azure Monitor + 既有 AlertRule 整合）| | 2 | W7 |
| **4.3** Secret rotation runbook | | 1 | W8 |
| **4.4** DR / 備份還原 runbook | | 2 | W8 |
| **4.5** Rate limit Upstash Redis 正式啟用 | | 1 | W7 |
| **Phase 4 total** | | **~9 days** | W7-W8 |
| **5.1** UAT 完整測試 | | 3 | W9 |
| **5.2** Security pen-test + 修復 | | 3-5 | W9 |
| **5.3** 使用者培訓 + 文件最終化 | | 2 | W10 |
| **5.4** Review 3 + Go/No-Go 決策 | | 1 | W10 |
| **Phase 5 total** | | **~9-11 days** | W9-W10 |
| **🎯 Grand total** | | **~52-59 days（10 週 Sprint）** | W1-W10 |

> **注意 1**：Effort 為**單人估算**。10 週時程要達標需 **App Team 1-2 人全職**。
> **注意 2**：阻塞時間（評審等待、Azure 資源申請、Infra Team 配合）已內含於週次規劃中。
> **注意 3**：若需嚴格 1 人單獨完成，建議延長到 12-13 週（推遲 Pilot 至 7/15）。

---

## 🛣️ 分階段實施路徑（v0.3 對齊 7 月 Pilot deadline）

```
W1（04/22-04/28）Phase 1 收尾
  本文件 v0.3 + UAT 文件骨架 + 評審約定
        │
        ▼
W2（04/29-05/05）4 方架構評審 + Phase 2 開工
  Review 1 Pass → Bicep + Dockerfile 開工
        │
        ▼
W3-W4（05/06-05/19）Phase 2
  Bicep + Container Build + Key Vault + UAT 文件 02-11 完成
  🎯 W4 結束：首次手動部署到 Azure UAT 成功 + Review 2 Pass
        │
        ▼
W5-W6（05/20-06/02）Phase 3 + CHANGE-056
  Schema baseline 重建 + GitHub Actions CI/CD
        │
        ▼
W7-W8（06/03-06/16）Phase 4
  App Insights + Alert Rules + Secret Rotation + DR Runbook
        │
        ▼
W9-W10（06/17-06/30）UAT 測試 + Pen-test + Final Gate
  Review 3 Pass
        │
        ▼
🚀 W11（07/01）Pilot 上線（HKG/SIN 1-2 城市，10-20 人）
        │
        ▼
W12-W18（07-08 月）Expansion → APAC 全區
        │
        ▼
W19+（09-10 月）Full Rollout → 全部 Companies
```

---

## 🚦 Gate Criteria（階段轉換條件）

### Phase 1 → Phase 2
- [ ] 本文件所有決策項目有明確結論（不再是「推薦 X」，而是「已決定 X」）
- [ ] 架構評審會議紀錄歸檔
- [ ] Schema migration 策略 PoC 通過
- [ ] Effort 估算獲得核准

### Phase 2 → Phase 3
- [ ] 手動部署能從 local Docker image 推到 Container Apps 並成功啟動
- [ ] Key Vault secret reference 可成功讀取
- [ ] Managed Identity 與 Storage / DB 連線正常
- [ ] `verify-environment.ts --production` 可在 Azure 環境運作

### Phase 3 → Phase 4
- [ ] GitHub Actions workflow 端對端成功（含 migration）
- [ ] Blue/Green 部署演練通過
- [ ] Rollback 程序驗證
- [ ] 首次 smoke test 通過

### Phase 4 → Go-Live
- [ ] Application Insights 追蹤所有關鍵路徑
- [ ] Alert rules 通過演練
- [ ] Penetration test 或安全審查
- [ ] Disaster Recovery 演練
- [ ] 資料備份 / 還原 runbook

---

## 📂 預期子文件結構（v0.3 更新）

```
02-azure-deployment/
├── README.md                           ← 目錄索引（已存在）
├── azure-deployment-plan.md            ← 本文件（主規劃 v0.3）
│
├── 🔵 uat-deployment/                  ← 🆕 v0.3 核心交付：UAT 部署流程文件（人 + AI 雙向可讀）
│   ├── 00-overview.md                  ← UAT 環境目標、架構、Mode C 邊界、文件導讀
│   ├── 01-prerequisites.md             ← 前置條件（Azure / RBAC / 工具 / Infra Team 已建資源）
│   ├── 02-azure-resources-setup.md     ← App 層資源建立（ACR / Container Apps / DB / KV / Storage / App Insights）
│   ├── 03-secrets-configuration.md     ← Key Vault secrets 注入流程
│   ├── 04-container-build-push.md      ← Docker build + push to ACR
│   ├── 05-database-migration.md        ← Schema migration（套用 CHANGE-056 baseline）
│   ├── 06-seed-essential.md            ← Essential seed 執行（roles / regions / system user）
│   ├── 07-seed-reference.md            ← Reference seed 手動執行（companies / Tier 1 mappings）
│   ├── 08-first-deployment.md          ← Container Apps 首次 revision 部署
│   ├── 09-verification.md              ← 部署後 smoke test（health / login / upload / extract）
│   ├── 10-rollback-procedure.md        ← 回滾流程（revision / DB / image）
│   ├── 11-troubleshooting.md           ← 常見問題排解
│   └── 99-ai-execution-guide.md        ← 🤖 AI 助手專用執行指南
│
├── 🆕 infrastructure/                  ← v0.3 重新設計：IaC Optional Track
│   ├── README.md                       ← 「本資料夾為 Optional，與 Infra Team 配合使用」
│   ├── bicep/                          ← Bicep 模板（optional，Mode A）
│   │   ├── main.bicep                  ← 應用層資源 orchestration
│   │   ├── parameters/
│   │   │   ├── uat.parameters.json
│   │   │   └── prod.parameters.json
│   │   └── modules/
│   │       ├── container-apps.bicep
│   │       ├── postgres.bicep
│   │       ├── key-vault.bicep
│   │       ├── storage.bicep
│   │       ├── acr.bicep
│   │       └── app-insights.bicep
│   ├── manual-setup/                   ← 等價手動 az CLI 流程（Mode B）
│   │   └── resources-checklist.md
│   ├── resources-inventory.md          ← ⭐ 完整資源清單與 SKU 決策（不論 IaC 與否都需要）
│   ├── naming-conventions.md           ← 命名規範（rg- / acr / kv- 等）
│   ├── cost-estimate.md                ← Azure Calculator 試算（Infra Admin 提供）
│   └── network-topology.md             ← Infra Admin 提供（網路架構由 Infra Admin 設計）
│
├── 🏛️ reviews/                        ← 🆕 v0.3 評審流程文件
│   ├── review-1-architecture/
│   │   ├── meeting-notes.md            ← Review 1 會議紀錄
│   │   ├── review-comments.md          ← 各團隊 PR comments 彙整
│   │   └── decisions.md                ← 評審後的決策補充
│   ├── review-2-implementation/
│   └── review-3-golive/
│
├── database/                           ← Phase 1-2
│   ├── migration-strategy.md           ← Schema migration 策略（CHANGE-056 產出）
│   └── seed-strategy.md                ← production-seed 設計（v0.2 §4 詳細化）
│
├── configuration/                      ← Phase 2
│   ├── key-vault-integration.md        ← 敏感值管理
│   ├── environment-variables.md        ← prod env 對照表
│   └── managed-identity.md             ← MI 設定
│
├── pipeline/                           ← Phase 3
│   ├── github-actions.md               ← CI/CD workflow 設計
│   └── deployment-flow.md              ← 部署步驟 runbook（與 uat-deployment 配合）
│
├── observability/                      ← Phase 4
│   ├── application-insights.md         ← APM 整合
│   └── alerts-and-logs.md              ← 警報與日誌
│
├── security/                           ← Phase 4
│   ├── hardening-checklist.md          ← 生產安全強化
│   ├── secret-rotation-runbook.md      ← Secret 輪替手冊
│   └── pen-test-results.md             ← W9 Pen-test 結果
│
└── runbooks/                           ← Phase 3+
    ├── rollback-procedure.md           ← Rollback 程序（與 uat-deployment/10 對應）
    ├── incident-response.md            ← 事件回應
    ├── disaster-recovery.md            ← 災難還原（無 HA 情境必備）
    └── backup-restore.md               ← 備份還原 SOP
```

---

## ❓ 待決策項目 — ✅ 全 10 項已定案（2026-04-22）

> Phase 1 規劃階段所有 10 項決策已完成，CHANGE-055 進入 Phase 2 文件化階段。

### ✅ 已定案決策清單

| # | 項目 | 決定 | 追蹤章節 / 文件 |
|---|------|------|---------------|
| 1 | **運算選型** | Container Apps（<100 UI 使用者、scale 0-5、工作時段外 scale to 0、5-15s cold start） | §2.1 |
| 2 | **IaC 工具** | **Bicep**（定位為 Optional Track，與 Infra Team Mode C 混合協作） | §2.5 |
| 3 | **Schema migration 方案** | 方案 A（重建基線）+ 舊 migrations 歸檔到 `_archive/` | §3 + CHANGE-056 |
| 4 | **Seed 策略** | 混合（essential 自動 + reference 手動）+ Mapping Rules Tier 1 進 seed / Tier 2 學習建立 | §4 |
| 5 | **Phase 時程** | 10 週 Sprint，2026-07 Pilot 上線（漸進式：Pilot → Expansion → Full） | §⏰ 時程規劃 |
| 6 | **評審流程** | 4 方參與（DevOps + Security + Infra Admin + App Team），會議+非同步混合，無 ADR | §🏛️ 架構評審流程 |
| 7 | **預算** | 委外 Infra Admin 決策，本文件提供技術選項清單作為討論輸入 | §🔟 |
| 8 | **上線 deadline** | 2026-07-01 Pilot（HKG/SIN 1-2 城市、10-20 內部使用者）+ 8-10 月 Full Rollout | §⏰ 時程規劃 |
| 9 | **HA 要求** | 暫不需要 Zone-redundant，但啟用每日備份 + DR Runbook | §9 |
| 10 | **網路架構** | 委外 Infra Admin，本文件提供應用層對網路的需求清單 | §9 Network 層級 |

### 後續執行追蹤

| 項目 | 後續產出 | 階段 |
|------|---------|------|
| UAT 部署流程文件（12 份）| `uat-deployment/00 ~ 11 + 99` | 階段 B/C（W1-W3） |
| Bicep 模板（optional） | `infrastructure/bicep/main.bicep + modules/` | 階段 D（W2-W4） |
| Schema baseline 重建 | CHANGE-056 PoC + 實施 | W4-W5 |
| 4 方架構評審 | Review 1 會議紀錄 + decisions.md | W2 |
| Infra Admin 預算討論 | `infrastructure/cost-estimate.md` 更新 | W1-W2 |
| Infra Admin 網路設計 | `infrastructure/network-topology.md`（由 Infra Admin 撰寫或提供） | W2-W4 |

---

## 🔗 關聯文件

- **CHANGE-055 追蹤**：`claudedocs/4-changes/feature-changes/CHANGE-055-azure-deployment-foundation.md`
- **Azure 目錄 README**：`README.md`（同目錄）
- **本地部署對照**：`../01-local-deployment/`
- **FIX-054**（SYSTEM_USER_ID 可覆蓋）：`claudedocs/4-changes/bug-fixes/FIX-054-*.md`
- **CHANGE-054**（本地部署可靠性）：`claudedocs/4-changes/feature-changes/CHANGE-054-*.md`
- **討論紀錄**：`claudedocs/8-conversation-log/daily/20260422.md` §Azure 部署議題

---

## 📝 修訂歷史

| 日期 | 版本 | 變更 |
|------|------|------|
| 2026-04-22 | 0.1（初稿） | 9 大類決策架構、Phase 規劃、Effort 估算 |
| 2026-04-22 | 0.2（Critical 決策定案） | 4 個 Critical 議題定案：(1) Container Apps + 規模參數；(2) Schema migration 方案 A + CHANGE-056；(3) Seed 混合策略 + Mapping Rules 分層；(4) 預算委外 Infra Admin；新增 §🔟 |
| 2026-04-22 | **0.3（全 10 項定案 + UAT 文件規劃）** | 剩餘 6 項定案：(5) IaC = Bicep Optional Track + Mode C 混合協作；(6) 時程 = 10 週 Sprint 對齊 7 月 Pilot；(7) 評審 = 4 方混合形式無 ADR；(8) Deadline = 2026-07 Pilot；(9) HA 暫不需要 + 保留備份；(10) 網路委外 Infra Admin。新增 §🔵 UAT 部署文件規劃（12 份人 + AI 雙向可讀）、§⏰ 時程規劃、§🏛️ 架構評審流程；更新預期子文件結構、Effort 估算（10 週對齊）、分階段路徑 |
| 待定 | 1.0 | Phase 1 完成（含 4 方 Review 1 Pass），進入 Phase 2 實施階段 |

---

*文件建立日期: 2026-04-22*
*最後更新: 2026-04-22（v0.3 — 全 10 項決策定案）*
*維護者: AI 助手 + 開發團隊*
*狀態: 📋 Phase 1 規劃完成 — 進入 UAT 部署文件編寫階段（階段 B/C）*
*下一步: 建立 `uat-deployment/` 12 份文件骨架（階段 B）*
