---
document_type: deployment_overview
step_id: STEP-00
title: UAT Deployment Overview（環境目標 + 架構 + Mode C 邊界 + 文件導讀）
estimated_duration: 10 minutes（閱讀）
requires_approval: false
approver: none
environment: uat
status: ✅ 完整內容（v0.3 階段 B）
audience: human + ai_assistant
related_documents:
  - ../azure-deployment-plan.md
  - ../../../claudedocs/4-changes/feature-changes/CHANGE-055-azure-deployment-foundation.md
  - ../../../claudedocs/4-changes/feature-changes/CHANGE-056-prisma-migration-baseline.md
---

# STEP-00: UAT Deployment Overview

> ⚠️ **部署方式現況（2026-06-27）**：本項目 Azure 部署**只用手動** `az acr build` + `az webapp config container set`。本文提及的 **GitHub Actions 自動部署到 UAT 為 Phase 3 規劃，尚未實作**，勿當現況。

> **本文件作用**：UAT 環境部署的**入口導讀**。任何人或 AI 助手在執行部署前必須先讀完本文件。
>
> **適用對象**：人類工程師（DevOps / App Team）+ AI 助手（Claude Code 等 LLM）

---

## 🎯 1. UAT 環境目標

### 1.1 為什麼要部署 UAT 環境？

| 目的 | 說明 |
|------|------|
| **Production 預演** | UAT 流程 = Prod 流程，先在 UAT 驗證所有部署步驟 |
| **內部測試** | 業務 stakeholder + Pilot 使用者測試端對端業務流程 |
| **Pen-test 環境** | Security Team 在 UAT 執行 penetration test |
| **培訓基地** | 上線前使用者培訓的環境 |
| **CI/CD 觸發點** | GitHub Actions push to main → 自動部署到 UAT |

### 1.2 UAT 與 Prod 的差異

| 項目 | UAT | Production |
|------|-----|-----------|
| 資源 SKU | 較低 tier（成本考量） | 標準 tier |
| Replica | 0-2 | 1-5（工作時段 min=1）|
| 資料 | 測試資料 + 部分 prod-grade reference | Prod 真實資料 |
| Domain | `uat.<domain>` 或 Container Apps 預設 FQDN | 正式域名 |
| Pilot 範圍 | 全功能 | 漸進式（HKG/SIN → APAC → Full）|
| 監控嚴格度 | 標準 | 完整 + Alert |

### 1.3 Pilot 規模對齊（W11+ 7/1 上線）

| 維度 | UAT 配置 | Pilot Production |
|------|---------|------------------|
| 城市 | HKG + SIN | HKG + SIN |
| 使用者 | 5-10 內部測試員 | 10-20 業務使用者 |
| Companies | 5-10 間（測試） | 5-10 間（同步） |
| Tier 1 Mappings | 50-100 條 | 50-100 條 |
| Tier 2 Mappings | 0（學習中） | 0（學習中） |
| 處理量 | 50-100 張/週 | 100-200 張/週 |

---

## 🏗️ 2. 整體架構（UAT 環境）

```
┌──────────────────────────────────────────────────────────────────┐
│  Azure Subscription                                               │
│                                                                    │
│  ┌─── Infra Team Domain ────────────────────────────────────┐   │
│  │  • Resource Group: rg-ai-document-extraction-uat          │   │
│  │  • VNet + Subnets                                         │   │
│  │  • 共享 Key Vault（若採用）                                │   │
│  │  • Network 邊界（NSG / Private DNS）                      │   │
│  │  • Log Analytics workspace                                │   │
│  └────────────────────────────────────────────────────────────┘   │
│                          ▲                                          │
│                          │ 邊界（Mode C 切分）                       │
│                          ▼                                          │
│  ┌─── App Team Domain ──────────────────────────────────────┐   │
│  │  ┌────────────────┐    ┌──────────────────┐              │   │
│  │  │  Container App │◄───┤ Container Apps   │              │   │
│  │  │  (Next.js +    │    │ Environment      │              │   │
│  │  │   Prisma +     │    └──────────────────┘              │   │
│  │  │   Managed ID)  │                                       │   │
│  │  └───────┬────────┘                                       │   │
│  │          │                                                  │   │
│  │          ├─► PostgreSQL Flexible Server                   │   │
│  │          ├─► Blob Storage（documents）                    │   │
│  │          ├─► App Insights（telemetry）                    │   │
│  │          ├─► ACR（image pull）                            │   │
│  │          │                                                  │   │
│  │          ├─► [Infra Team] Key Vault（secrets）            │   │
│  │          ├─► [外部] Azure OpenAI                          │   │
│  │          └─► [外部] Document Intelligence                  │   │
│  └────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────┘
```

### 2.1 資源歸屬清單

| 資源 | 歸屬 | UAT 命名 |
|------|------|---------|
| Resource Group | Infra Team 建立 | `rg-ai-document-extraction-uat` |
| VNet / Subnets | Infra Team | 由 Infra Team 命名 |
| Key Vault（共享） | Infra Team | 由 Infra Team 提供 URI |
| Log Analytics | Infra Team | 由 Infra Team 提供 ID |
| Container Apps Environment | App Team | `cae-aidocextract-uat` |
| Container App | App Team | `ca-aidocextract-uat` |
| ACR | App Team | `acraidocextractuat` |
| PostgreSQL Flexible | App Team | `psql-aidocextract-uat` |
| Blob Storage Account | App Team | `staidocextractuat` |
| App Insights | App Team | `appi-aidocextract-uat` |
| Managed Identity | App Team（System-Assigned） | 自動命名 |

> **命名規範**：詳見 `../infrastructure/naming-conventions.md`

---

## 🤝 3. Mode C 混合協作邊界

> **參考**：`../azure-deployment-plan.md` §2.5 IaC 工具章節

### 3.1 職責分工

| 範疇 | 由誰負責 | 部署文件涵蓋？ |
|------|---------|-------------|
| **基礎架構**（RG / VNet / Subnets / NSG / DNS） | Infra Team | ❌ 不涵蓋（前提假設） |
| **共享平台**（共享 Key Vault / Log Analytics / Bastion） | Infra Team | 🟡 提供需求清單 |
| **應用層資源**（Container Apps / ACR / DB / Storage / App Insights） | **App Team**（本文件涵蓋）| ✅ 完整流程 |
| **Image build + push** | App Team | ✅ STEP-04 |
| **Schema migration** | App Team | ✅ STEP-05 |
| **Seed**（essential + reference）| App Team | ✅ STEP-06/07 |
| **First deployment**（revision）| App Team | ✅ STEP-08 |
| **Smoke test** | App Team + 業務 owner | ✅ STEP-09 |
| **Rollback** | App Team（諮詢 Infra Team） | ✅ STEP-10 |
| **Network troubleshoot** | Infra Team | 🟡 STEP-11 內含基本指引 |
| **Security incident** | Security Team | ❌ 不涵蓋 |

### 3.2 邊界協作協議

**App Team 在執行 STEP-02 前必須確認**：
- [ ] Infra Team 已建好 Resource Group `rg-ai-document-extraction-uat`
- [ ] App Team 在 RG 上有 `Contributor` 角色
- [ ] 共享 Key Vault URI 已提供（或 App Team 在自有 RG 建立 KV）
- [ ] Log Analytics workspace ID 已提供
- [ ] App Team 有 Azure OpenAI / DI 服務的存取憑證
- [ ] Subscription quota 足夠（CPU / Memory / Public IP / DB instances）

**Infra Team 完成基礎架構後，必須交付給 App Team 一份「資源清單」**，建議包含：
```yaml
# infra-handoff/uat.yaml
resource_group:
  name: rg-ai-document-extraction-uat
  location: southeastasia
  app_team_role: Contributor
shared_key_vault:
  name: kv-shared-uat
  uri: https://kv-shared-uat.vault.azure.net
  app_team_secret_permissions: [Get, List]
log_analytics:
  workspace_id: <id>
  workspace_key: <secret>
network:
  vnet_id: <id>
  subnet_id_for_container_apps: <id>
  ingress_type: external | internal
private_dns:
  postgres: privatelink.postgres.database.azure.com
  blob: privatelink.blob.core.windows.net
```

---

## 📚 4. 文件導讀（12 份結構）

### 4.1 文件清單與依賴

```
00-overview.md (本文件)
  │
  ▼
01-prerequisites.md ────────────────────► 環境檢查 + Infra Team handoff 確認
  │
  ▼
02-azure-resources-setup.md ─────────────► App 層 6 大資源建立
  │
  ▼
03-secrets-configuration.md ─────────────► Key Vault secrets 注入
  │
  ▼
04-container-build-push.md ──────────────► Docker build + push ACR
  │
  ▼
05-database-migration.md ────────────────► Schema migration（CHANGE-056）
  │
  ▼
06-seed-essential.md ────────────────────► 系統基礎資料 seed
  │
  ▼
07-seed-reference.md ────────────────────► 業務參考資料 seed（手動一次）
  │
  ▼
08-first-deployment.md ──────────────────► Container Apps 首次部署
  │
  ▼
09-verification.md ──────────────────────► Smoke test
  │
  ├──► 失敗 ──► 10-rollback-procedure.md
  │
  └──► 成功 ──► 🎉 UAT 部署完成

   參考工具書（隨時可查）：
   - 11-troubleshooting.md
   - 99-ai-execution-guide.md（AI 助手必讀）
```

### 4.2 文件閱讀建議

| 角色 | 必讀順序 |
|------|---------|
| **第一次部署的人類工程師** | 00 → 01 → 02 → 03 → ... → 09（依序執行）|
| **熟悉部署的工程師** | 01（檢查環境）→ 直接跳到目標 STEP |
| **AI 助手** | 99（執行協議）→ 00（理解架構）→ 01 → 依任務跳對應 STEP |
| **Code Reviewer** | 00 → 11（瞭解風險）→ 各 STEP（review 邏輯）|
| **Pen-tester** | 00 → 02 → 03 → 08 → 09（瞭解攻擊面）|

---

## 🔧 5. 通用環境變數（所有 STEP 共用）

> 各 STEP 的 `Environment Variables` 區塊會基於以下基礎 + 增補。

```bash
# === Subscription 與身分 ===
export SUBSCRIPTION_ID="<azure-subscription-id>"
export TENANT_ID="<azure-tenant-id>"

# === 基礎架構（Infra Team 提供）===
export RG_NAME="rg-ai-document-extraction-uat"
export LOCATION="southeastasia"
export SHARED_KV_URI="<from infra handoff>"  # 若採用共享 KV
export LOG_ANALYTICS_WORKSPACE_ID="<from infra handoff>"

# === App 層資源命名 ===
export ACR_NAME="acraidocextractuat"
export CAE_NAME="cae-aidocextract-uat"          # Container Apps Environment
export CA_NAME="ca-aidocextract-uat"            # Container App
export POSTGRES_NAME="psql-aidocextract-uat"
export STORAGE_NAME="staidocextractuat"
export APP_INSIGHTS_NAME="appi-aidocextract-uat"
export KV_NAME="kv-aidocextract-uat"            # 若 App Team 自建 KV

# === Image Tagging ===
export IMAGE_REPO="ai-document-extraction"
export IMAGE_TAG="$(git rev-parse --short HEAD)-uat"

# === 應用配置 ===
export NODE_ENV="production"
export AUTH_TRUST_HOST="false"                  # 已走 HTTPS
export SYSTEM_USER_ID="system-user-prod"        # 與 FIX-054 配合

# === 部署狀態檔 ===
export DEPLOYMENT_STATE_FILE="${PROJECT_ROOT}/deployment-state/uat.yaml"
```

---

## 📝 6. Deployment State File 規格

### 6.1 路徑與用途

- **路徑**：`${PROJECT_ROOT}/deployment-state/uat.yaml`（不入 git，加入 .gitignore）
- **用途**：跨 STEP / 跨 session 保留執行狀態與資源 outputs
- **Owner**：每個 STEP 完成後寫入自己的 outputs

### 6.2 標準結構

```yaml
# deployment-state/uat.yaml
metadata:
  environment: uat
  started_at: 2026-05-13T09:00:00+08:00
  last_updated: 2026-05-13T11:30:00+08:00
  executed_by: <human-name | ai-assistant-session-id>

steps_completed:
  - step_id: STEP-01
    completed_at: 2026-05-13T09:15:00+08:00
    status: success
  - step_id: STEP-02
    completed_at: 2026-05-13T10:30:00+08:00
    status: success

resources:
  acr:
    name: acraidocextractuat
    login_server: acraidocextractuat.azurecr.io
  postgres:
    name: psql-aidocextract-uat
    fqdn: psql-aidocextract-uat.postgres.database.azure.com
    version: "15"
  container_app:
    name: ca-aidocextract-uat
    fqdn: ca-aidocextract-uat.<random>.southeastasia.azurecontainerapps.io
    revision_active: <revision-name>
  # ... 其他資源

flags:
  reference_seed_executed: false  # STEP-07 完成後改 true
  smoke_test_passed: false        # STEP-09 完成後改 true

failures: []  # 失敗紀錄

next_step: STEP-03
```

### 6.3 寫入規則

- **每個 STEP 完成後**：append 一筆 `steps_completed` + 更新 `resources` + 更新 `next_step`
- **失敗時**：append 到 `failures`，`next_step` 保持當前 STEP
- **AI 助手**：必須讀取 state file 決定下一步，不可從零開始猜測進度

---

## 🚦 7. 何時 Pause / Approval

| 情境 | 是否需要 Approval | Approver |
|------|----------------|---------|
| Resource creation（建立 DB / Storage / Container App）| ✅ | infra-admin |
| Secret 注入（含 ENCRYPTION_KEY）| ✅ | app-team-lead |
| Schema migration（`prisma migrate deploy`）| ✅ | app-team-lead |
| Reference seed（首次） | ✅ | app-team-lead |
| First deployment（first revision）| ✅ | app-team-lead |
| Rollback Layer 2/3 | ✅ | app-team-lead |
| Build / push image | ❌ | none |
| Health check / smoke test | ❌ | none |
| Essential seed（idempotent） | ❌ | none |

> **AI 助手**：`requires_approval: true` 的步驟必須在執行前提示人類確認，**不可自行決定執行**。詳見 `99-ai-execution-guide.md`。

---

## ✅ 8. 開始執行

確認你已：
- [ ] 讀完本文件
- [ ] 理解 Mode C 邊界
- [ ] 確認 Infra Team handoff 資料齊全
- [ ] 知道 deployment state file 機制
- [ ] AI 助手：已讀 `99-ai-execution-guide.md`

→ 進入 **`01-prerequisites.md`** 進行環境檢查。

---

*文件版本: v1.0（階段 B 完成）*
*最後更新: 2026-04-27*
*維護者: AI 助手 + 開發團隊*
