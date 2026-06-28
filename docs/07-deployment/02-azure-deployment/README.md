# Azure 部署文件（🟢 DEV 已上線 → UAT/PRD 進行中）

> **狀態**: 🟢 **DEV 環境已上線**(2026-06-15,App Service for Containers)+ 機密已正規化到 Key Vault + 本地業務/設定資料已同步;UAT/PRD 文件化進行中
>
> ⚠️ **部署方式現況（2026-06-27）**：本項目 Azure 部署**只用手動** `az acr build` + `az webapp config container set`（見 [`dev-deployment-runbook.md §A`](./dev-deployment-runbook.md)）。本目錄文件提及的 **GitHub Actions / CI/CD 自動部署為 Phase 3 規劃，尚未實作**，勿當現況。
> **建立日期**: 2026-04-22 ・ **最後更新**: 2026-06-16
> **追蹤**: [CHANGE-055](../../../claudedocs/4-changes/feature-changes/CHANGE-055-azure-deployment-foundation.md) + [CHANGE-056](../../../claudedocs/4-changes/feature-changes/CHANGE-056-prisma-migration-baseline.md)
> **主規劃文件**: [`azure-deployment-plan.md`](./azure-deployment-plan.md) v0.3
> **UAT 部署流程**: [`uat-deployment/`](./uat-deployment/) — 步驟文件

本目錄存放 AI Document Extraction 項目部署到 Azure 各環境的所有相關文件。

---

## 🟢 現況與必讀(2026-06-16)

> 規劃階段(下方 §「為何還沒實施」)已被 DEV 實際上線取代。**實際部署請以下列文件為準:**

| 🔴 必讀 | 文件 | 內容 |
|--------|------|------|
| **1** | [`deployment-governance.md`](./deployment-governance.md) | **權限模型**:DEV/UAT 開發團隊用 Service Principal **自助部署**;**PRD 一律經 infra team**。app 最終轉 **private(僅內網)**。**KV 僅 DEV/UAT 由開發者建立管理**,PRD 由 infra 管理。 |
| **2** | [`dev-deployment-runbook.md`](./dev-deployment-runbook.md) | DEV 實戰:**§A 標準部署流程(可重複)** + 13 個已遇到並解決的問題(DNS 繞法、KV 搬遷、資料同步 14 表、CRLF exit 127、re2-wasm 執行期等)。 |
| 3 | [`uat-deployment/00-overview.md`](./uat-deployment/00-overview.md) | UAT 步驟文件(治理規則以文件 1 為準)。 |

---

## 🎯 立即從這裡開始

| 要做什麼 | 去哪裡 |
|---------|--------|
| **理解整體規劃** | 👉 [`azure-deployment-plan.md`](./azure-deployment-plan.md) — 全 10 項決策 + 10 週 Sprint 對齊 7 月 Pilot |
| **執行 UAT 部署** | 👉 [`uat-deployment/00-overview.md`](./uat-deployment/00-overview.md) — 12 份步驟文件入口 |
| **AI 助手協議** | 🤖 [`uat-deployment/99-ai-execution-guide.md`](./uat-deployment/99-ai-execution-guide.md) — AI 執行協議必讀 |
| **追蹤實施進度** | 👉 CHANGE-055 + CHANGE-056 追蹤文件（claudedocs/4-changes/feature-changes/） |
| **了解為何分拆 Azure / 本地** | 👉 [頂層 `../README.md`](../README.md) |

---

## ⚠️ 為何還沒實施

Azure 部署牽涉架構決策與風險評估，不適合直接動手。目前處於 **Phase 1（規劃）**。詳見 `azure-deployment-plan.md` 的待決策清單（10 項）與 Gate Criteria。

**相關討論**：2026-04-22 session — FIX-054 + CHANGE-054 完成後延伸討論（見 `claudedocs/8-conversation-log/daily/20260422.md`）。

---

## 📋 待規劃項目清單（9 大類）

| # | 類別 | 關鍵議題 |
|---|------|---------|
| 1 | **容器化 / 建置** | Dockerfile（multi-stage Next.js build）；target 為 App Service for Containers / Container Apps / AKS |
| 2 | **Azure 資源選型** | Database for PostgreSQL Flexible Server；Blob Storage；App Service / Container Apps / AKS；Key Vault；Container Registry (ACR) |
| 3 | **🔴 Schema 遷移策略** | 目前本地用 `prisma db push --accept-data-loss` — **在 prod 極度危險**。需設計正式 `prisma migrate` 流程或評估風險。122 models vs 10 migrations 的落差是歷史問題 |
| 4 | **🔴 Seed 策略** | prod 不應跑完整 seed（例：`dev-user-1` 不應在 prod 存在）。需要 `prod-seed.ts` 只建必要資料（roles / regions / system-user），或完全手動執行 |
| 5 | **配置注入** | Azure App Service / Container Apps 環境變數 ↔ `.env` 映射；Key Vault 引用（`@Microsoft.KeyVault(SecretUri=...)`）；FIX-054 的 `SYSTEM_USER_ID` 在 prod 對應真實 system user UUID |
| 6 | **CI/CD Pipeline** | GitHub Actions 或 Azure DevOps；`main` push → build → push ACR → deploy；PR → preview slot；DB migration 在部署前/中的時機 |
| 7 | **部署前自檢** | `scripts/verify-environment.ts` 改造為 Azure-aware（跳過 Docker 檢查、加入 Key Vault / Managed Identity 驗證） |
| 8 | **運維觀測** | Application Insights 整合；Log Analytics；Alerts（延用既有 `AlertRule` 模型？） |
| 9 | **安全強化** | HTTPS only / TLS 1.2+；`AUTH_TRUST_HOST` 關閉；Azure AD 真實 SSO；Rate limit 強制啟用（`UPSTASH_REDIS_*`） |

---

## 📐 預期文件結構（待實作）

```
02-azure-deployment/
├── README.md                          ← 本文件
├── azure-deployment-plan.md           ← CHANGE-055 總規劃
├── infrastructure/                    ← IaC
│   ├── bicep-or-terraform.md          ← 選型決策
│   └── resources-inventory.md         ← 所有 Azure 資源清單
├── pipeline/
│   ├── github-actions.md              ← CI/CD workflow 設計
│   └── deployment-flow.md             ← 部署步驟
├── database/
│   ├── migration-strategy.md          ← Schema migration 策略（🔴 critical）
│   └── seed-strategy.md               ← prod seed 設計
├── configuration/
│   ├── key-vault-integration.md       ← 敏感值管理
│   ├── environment-variables.md       ← prod env 對照表
│   └── managed-identity.md            ← Managed Identity 設定
├── observability/
│   ├── application-insights.md        ← APM 整合
│   └── alerts-and-logs.md             ← 警報與日誌
├── security/
│   ├── network-topology.md            ← VNet / Private Endpoint
│   └── hardening-checklist.md         ← 生產安全強化
└── runbooks/
    ├── first-deployment.md            ← 首次部署手冊
    ├── rollback-procedure.md          ← Rollback 程序
    └── incident-response.md           ← 事件回應
```

---

## 🔗 與本地部署的關係

不是所有本地部署資產都需要重寫。已可部分重用：

| 資產 | 可重用？ |
|------|---------|
| `.env.example` 結構（41 變數分級） | ✅ 作為 prod env 配置的基礎，但 placeholder 需換成真實值或 Key Vault 引用 |
| `FIX-054` 的 `SYSTEM_USER_ID` env 機制 | ✅ Azure 直接設環境變數即可 |
| `scripts/verify-environment.ts` | 🟡 部分可用（env/DB 檢查 OK）；Docker 容器檢查在 Azure 無意義，需要 `--production` 模式 |
| `scripts/init-new-environment.*` | ❌ 完全本地（假設 `docker-compose` + `pg_isready`），Azure 部署流程完全不同 |
| `project-initialization-guide.md` | ❌ 專注本地；Azure 需獨立 guide |
| Seed 腳本 `prisma/seed.ts` | ⚠️ 部分可用；dev-user-1 區塊在 prod 應移除 |

---

## 🚦 下一步

1. ✅ ~~**建立 CHANGE-055 規劃文件**~~（已完成 2026-04-22）
   - `claudedocs/4-changes/feature-changes/CHANGE-055-azure-deployment-foundation.md`
2. ✅ ~~**建立主規劃文件**~~（已完成 2026-04-22）
   - [`azure-deployment-plan.md`](./azure-deployment-plan.md)
3. ⏳ **架構評審**（待 DevOps / 安全團隊討論）
   - 確認 [`azure-deployment-plan.md`](./azure-deployment-plan.md) §待決策項目的 10 個問題
4. ⏳ **Phase 1 → Phase 2 gate**：架構評審通過後開始 Phase 2 實施（預估 ~3 週）
5. ⏳ **PoC**（Phase 2 階段）：選定最小可行組合執行首次部署
6. ⏳ **撰寫本目錄下的子文件**（infrastructure/, pipeline/, database/ 等 — 見主規劃文件的預期結構）
7. ⏳ **首次部署演練**（Phase 3 階段）
8. ⏳ **Go-Live**（完成 Phase 4 後）

---

## 📞 聯絡與討論

- 部署頂層導覽：[`../README.md`](../README.md)
- 本地部署對照：[`../01-local-deployment/README.md`](../01-local-deployment/README.md)
- 相關 session 紀錄：`claudedocs/8-conversation-log/daily/20260422.md`
