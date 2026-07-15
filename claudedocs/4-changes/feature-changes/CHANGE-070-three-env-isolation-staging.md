# CHANGE-070: 三環境隔離（補 Staging Environment）

> **狀態**: 📋 規劃中

> ## ✅ 用戶決策確認（2026-04-28）
>
> | ID | 決策 |
> |----|------|
> | **B8** | Staging 環境 ~$150/月成本 **已同意** — 認可 staging 為 Pilot 上線前必要的部署緩衝區（dev / staging / prod 三套完全隔離） |
>
> 此決策已定案，本 CHANGE 進入實作階段（依賴 CHANGE-069 完成後才開始 staging 建置）。

## 變更摘要

| 項目 | 內容 |
|------|------|
| **變更編號** | CHANGE-070 |
| **變更日期** | 2026-04-28 |
| **相關模組** | Azure 部署 / Bicep IaC / 環境隔離 |
| **影響範圍** | 新增 `infrastructure/bicep/parameters/staging.parameters.json`、修改 `main.bicep`（@allowed 補 staging）、新增 staging 環境 SOP `docs/07-deployment/02-azure-deployment/staging-deployment/` |
| **優先級** | Medium |
| **狀態** | 📋 規劃中 |
| **類型** | Infrastructure / Environment Isolation |
| **依賴** | CHANGE-055（Azure deployment foundation）、CHANGE-069（ACA/ACR hardening）|
| **對應安全控制項** | SDLC-09（L1 → L3） |
| **Phase 2 報告依據** | `phase2-sdlc-assessment.md` §SDLC-09、§發現 4 |

---

## 問題描述

依 Phase 2 盤點 (`phase2-sdlc-assessment.md` 第 154-189、828-846 行) 結果：

### SDLC-09: 環境隔離 — **L1（Initial）**

> 證據：
> - Bicep parameters 只有 `uat.parameters.json` + `prod.parameters.json`
> - `main.bicep:21-27`：`@allowed: ['uat', 'prod']`
> - 規劃文件全程**無 staging 提及**
> - **重大缺口**：v1.2 矩陣 SDLC-09 要求 **dev / staging / prod 三套**完全隔離

> v1.2 重要性：
> - UAT 同時承擔開發測試 + Pilot 演練 + Prod-grade 驗證 3 種角色（容易污染）
> - Prod 部署只有 UAT → Prod 一跳（無 staging 緩衝）
> - 缺乏真實流量測試環境（Pilot 前無 dry-run）

### 為何嚴重

- **Trivy + E2E + UAT 中間測試無處可跑** — 應在 staging 跑 1 週流量驗證後才升 prod
- **Pilot Go-Live Gate 風險** — Prod 首次部署 = 第一次真實負載測試 = 高風險
- **SoD 缺失放大** — 無 staging 緩衝，Pilot 期單人開發者 hot-fix 直接打 prod

---

## 變更方案

### 設計原則

1. **保守實施** — 不破壞 CHANGE-055/069 既有 UAT/Prod 規劃
2. **Staging 為精簡版 Prod** — 同 Bicep 模板，差異在 SKU + 副本數
3. **Managed Identity 隔離** — 每個環境獨立 ACA / ACR / KV / PostgreSQL，prod 資源僅 prod ACA 可存取
4. **三套獨立 RBAC** — dev/staging/prod identity 各自只能存取對應資源
5. **Staging 用途明確**：
   - Trivy / 安全掃描深度驗證
   - E2E 測試套件執行
   - UAT 完成後、Prod 上線前的最後驗證 1 週

### 子變更 1：Bicep main.bicep 支援三環境

**檔案**：`infrastructure/bicep/main.bicep`

**變更**：
```bicep
@allowed([
  'uat'
  'staging'   // 新增
  'prod'
])
@description('Deployment environment')
param environment string
```

### 子變更 2：建立 staging.parameters.json

**檔案**：`infrastructure/bicep/parameters/staging.parameters.json`（新增）

**設計**：staging 為「精簡 Prod」— 配置與 prod 相似但 SKU 較小（節省成本）

```json
{
  "$schema": "...",
  "contentVersion": "1.0.0.0",
  "parameters": {
    "environment": { "value": "staging" },
    "location": { "value": "eastasia" },

    "acrSku": { "value": "Standard" },
    "enableQuarantine": { "value": true },          // 與 prod 一致

    "postgresSkuName": { "value": "Standard_B2s" }, // 較小，UAT 也用同 SKU
    "postgresStorageMb": { "value": 65536 },
    "postgresBackupRetention": { "value": 7 },      // staging 7 天足夠

    "containerAppMinReplicas": { "value": 1 },
    "containerAppMaxReplicas": { "value": 2 },

    "externalIngress": { "value": false },          // staging 也是 internal
    "internalLoadBalancer": { "value": true },

    "allowSharedKeyAccess": { "value": false },     // 與 prod 一致
    "blobSoftDeleteRetentionDays": { "value": 14 },

    "softDeleteRetentionDays": { "value": 30 },     // KV
    "enablePurgeProtection": { "value": false },    // staging 可重建

    "logRetentionDays": { "value": 30 }             // App Insights
  }
}
```

### 子變更 3：命名約定擴增

**檔案**：`docs/07-deployment/02-azure-deployment/manual-setup/resources-checklist.md`（既有，更新）

**新增**：
```
Staging 命名:
- Resource Group: rg-ai-document-extraction-staging
- ACR: acraidocextractstaging
- ACA Environment: cae-aidocextract-staging
- ACA Web App: aca-web-staging
- ACA Python Extraction: aca-extraction-staging
- ACA Python Mapping: aca-mapping-staging
- Key Vault: kv-aidocextract-staging
- PostgreSQL: psql-aidocextract-staging
- Storage: staidocextractstaging
- App Insights: appi-aidocextract-staging
```

### 子變更 4：RBAC 嚴格隔離（防 prod 資料外洩）

**設計**：
- staging ACA managed identity → 只有對 staging KV / staging ACR / staging Storage 的權限
- 嚴格禁止 staging identity 存取 prod 資源（透過 RBAC scope）

**檔案**：`infrastructure/bicep/main.bicep`

**動作**：每個 roleAssignment 的 `scope` 嚴格限定為當前環境 resource

```bicep
resource webAppKvAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.outputs.id, webApp.outputs.identityPrincipalId, 'KvSecretsUser')
  scope: keyVault.outputs.resource  // ← 僅當前環境的 KV，跨環境無法存取
  properties: {
    principalId: webApp.outputs.identityPrincipalId
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6')  // KV Secrets User
  }
}
```

**驗證**：staging ACA 嘗試呼叫 prod KV → 403 Forbidden（透過 RBAC enforced）

### 子變更 5：Staging 部署 SOP 文件

**新增**：`docs/07-deployment/02-azure-deployment/staging-deployment/`

```
staging-deployment/
├── 00-overview.md             # 用途說明（Trivy + E2E + 1 週驗證）
├── 01-resource-provisioning.md # az login + Bicep deploy staging
├── 02-data-seed.md            # 從 UAT seed 拷貝（脫敏資料）
├── 03-deploy.md               # CI/CD push 到 staging ACR
├── 04-validation.md           # Trivy / E2E / 7 天 monitoring
└── 05-promotion-to-prod.md    # 升級流程（image tag retag）
```

### 子變更 6：CI/CD 三環境流程

**檔案**：`.github/workflows/deploy.yml`（與 CHANGE-055 Phase 3 對齊）

**設計**：
```yaml
on:
  push:
    branches: [main]
  workflow_dispatch:
    inputs:
      target_env:
        type: choice
        options: [uat, staging, prod]

jobs:
  build:
    # ...build image
  deploy-uat:
    if: github.ref == 'refs/heads/main' || inputs.target_env == 'uat'
    # ...

  deploy-staging:
    needs: deploy-uat
    if: inputs.target_env == 'staging' || github.event.workflow_run.conclusion == 'success'
    environment: staging  # GitHub Environment（含 manual approval）
    # ...

  deploy-prod:
    needs: deploy-staging
    if: inputs.target_env == 'prod'
    environment: prod  # GitHub Environment with required reviewers
    # ...
```

**GitHub Environment 設定**：
- staging：require 1 reviewer
- prod：require 2 reviewers + 24h delay

### 子變更 7：Staging 用途文件化

**檔案**：`docs/07-deployment/02-azure-deployment/staging-deployment/00-overview.md`

```markdown
# Staging 環境用途

## 1. 主要用途
- **Trivy 深度掃描**：CI 階段已掃，staging 部署後再次驗證實際 image 在 ACR 中無 CVE drift
- **E2E 測試**：完整 Playwright 測試套件對 staging 跑（UAT 環境跑部分）
- **真實流量驗證**：Pilot 上線前 1 週，灌入測試流量（每日 1000 文件）監控
- **災難演練**：DR Plan 演練在 staging 進行（不污染 prod）
- **Hot fix 驗證**：緊急 fix 必須先過 staging 1 小時 smoke test

## 2. 與 UAT/Prod 差異

| 項目 | UAT | Staging | Prod |
|------|-----|---------|------|
| 用途 | 開發測試 + Pilot 演練 | 部署前最終驗證 | 生產 |
| Ingress | external（測試方便） | internal（與 prod 一致） | internal + Front Door |
| Replicas | 1-2 | 1-2 | 2-5 |
| KV Purge Protection | false | false | true |
| PostgreSQL backup | 7 天 | 7 天 | 14-35 天 |
| RBAC scope | UAT only | Staging only | Prod only |
| Quarantine policy | disabled | enabled | enabled |
| 資料 | 開發測試資料 | 從 UAT 脫敏拷貝 | 真實資料 |

## 3. 不應做的事
- ❌ 不從 prod 拷貝資料到 staging（合規風險）
- ❌ 不從 staging access prod 任何資源（RBAC enforced）
- ❌ 不將 staging fqdn 公開給外部用戶
- ❌ 不在 staging 跳過 review 流程

## 4. 升級到 prod 流程
1. UAT 部署成功 + 業務驗收通過
2. 推送相同 image tag 到 staging
3. Staging 跑 7 天 smoke + E2E
4. Prod environment manual approval（2 reviewers）
5. Image retag 到 prod ACR
6. Prod 部署
7. Prod 24 小時監控
```

### 子變更 8：Seed 資料脫敏腳本

**檔案**：`scripts/governance/staging-data-mask.ts`（新增）

**功能**：
- 從 UAT 匯出資料
- 脫敏：email → `staging-user-{id}@example.com`、user.name → 隨機假名、phone → null
- 匯入 staging
- 完全不接觸 prod 資料

---

## 修改的檔案

| 檔案 | 變更類型 | 預估行數 |
|------|----------|---------|
| `infrastructure/bicep/main.bicep` | 🔄 補 staging environment + 嚴格 RBAC scope | +30 |
| `infrastructure/bicep/parameters/staging.parameters.json` | ➕ 新增 | ~50 |
| `docs/07-deployment/02-azure-deployment/staging-deployment/00-overview.md` | ➕ 新增 | ~150 |
| `docs/07-deployment/02-azure-deployment/staging-deployment/01-resource-provisioning.md` | ➕ 新增 | ~120 |
| `docs/07-deployment/02-azure-deployment/staging-deployment/02-data-seed.md` | ➕ 新增 | ~150 |
| `docs/07-deployment/02-azure-deployment/staging-deployment/03-deploy.md` | ➕ 新增 | ~100 |
| `docs/07-deployment/02-azure-deployment/staging-deployment/04-validation.md` | ➕ 新增 | ~180 |
| `docs/07-deployment/02-azure-deployment/staging-deployment/05-promotion-to-prod.md` | ➕ 新增 | ~120 |
| `docs/07-deployment/02-azure-deployment/manual-setup/resources-checklist.md` | 🔄 加 staging 命名 | +20 |
| `docs/07-deployment/02-azure-deployment/azure-deployment-plan.md` | 🔄 補 staging 章節 | +60 |
| `.github/workflows/deploy.yml` | 🔄 加 staging deploy job | +50 |
| `scripts/governance/staging-data-mask.ts` | ➕ 新增 | ~200 |

---

## 預期效果

### 環境隔離提升

| 面向 | Before | After |
|------|--------|-------|
| SDLC-09 評分 | L1（缺 staging）| L3（dev/staging/prod 三套）|
| 部署緩衝 | UAT → Prod 一跳 | UAT → Staging → Prod 兩跳 |
| Prod 風險 | 首次部署即真實負載 | Staging 1 週驗證後 |
| RBAC 隔離 | UAT/Prod 兩套 | UAT/Staging/Prod 三套，scope 嚴格 |
| Pilot Go-Live Gate | UAT 通過即可 | UAT + Staging E2E 都通過 |

### 業務影響

- ✅ Prod 部署風險顯著降低（staging 1 週 dry-run）
- ✅ Hot fix 流程更穩健（staging smoke test）
- ✅ **成本增加**：新增 1 套 ACA Environment + ACR + PostgreSQL（B2s）+ KV ≈ **+$150/月（B8, 2026-04-28 用戶已同意）**
- ⚠️ 部署流程拉長（多 1 跳）— Pilot 前最後 1 週需安排

---

## 測試驗證

### Bicep 驗證

- [ ] `az bicep build --file main.bicep --parameters staging.parameters.json` 無錯誤
- [ ] What-if 顯示新增 staging RG
- [ ] 部署成功並產出所有 resource

### RBAC 隔離驗證

- [ ] Staging ACA managed identity 嘗試讀 prod KV secret → 403
- [ ] Staging ACA 嘗試 ACR pull from prod ACR → 403
- [ ] Staging Storage SAS token 不能 access prod blob

### 資料隔離驗證

- [ ] Staging seed 完全脫敏（運行腳本檢查 email pattern）
- [ ] Staging DB 不含任何 prod 真實 user / company

### CI/CD 驗證

- [ ] Push to main → 自動部署 UAT
- [ ] UAT 部署成功 → 觸發 staging（manual approval）
- [ ] Staging 部署成功 → prod environment 等待 2 reviewers
- [ ] Prod environment 24h delay 機制生效

---

## 風險提示

- ✅ **成本**：+$150/月 — **B8, 2026-04-28 用戶已同意**；不採 staging on-demand 模式（避免重建頻繁、確保 1 週驗證流量穩定）
- **Pilot 前時間壓力**：staging 1 週驗證需排入 W10 之前 → 倒推 W9 必須 staging ready
- **資料脫敏邊界**：脫敏腳本若有 bug → prod-like 資料污染 staging → 需完整單元測試
- **GitHub Environment cost**：免費 plan 限 prod environment 用 secrets，私有 repo 可能需付費 plan
- **與 CHANGE-069 順序**：CHANGE-070 必須在 CHANGE-069 完成後（依賴新 Bicep modules + 三環境 parameters）
- **Pilot 階段 staging 利用率**：若 Pilot 後 staging 利用率低 → 後續 CHANGE 再評估是否合併到 UAT

---

## 實作順序建議

1. **W4-W5**（CHANGE-069 完成後）：
   - main.bicep 支援 staging
   - staging.parameters.json 建立
   - resources-checklist.md 補 staging 命名

2. **W5**：
   - 建立 staging RG 與資源
   - 部署應用到 staging（首次驗證）

3. **W6**：
   - 撰寫 staging-deployment SOP（5 份）
   - 撰寫資料脫敏腳本

4. **W7**：
   - CI/CD workflow 補 staging stage
   - GitHub Environment 設定（reviewers + delay）

5. **W8-W9**：
   - Pilot 前 1 週：staging 跑 7 天 dry-run（Trivy + E2E + 流量）

6. **W10 Review 3 Go-Live Gate**：
   - Staging E2E pass
   - Staging 7 天 monitoring 無 critical alert
   - 進入 prod 部署

---

## 相關文件

- **Phase 2 報告**: `docs/08-security-and-governance/phase2-sdlc-assessment.md` §SDLC-09、§發現 4
- **CHANGE-055**: Azure deployment foundation
- **CHANGE-069**: ACA/ACR hardening（本 CHANGE 的前置）
- **既有 Bicep**: `infrastructure/bicep/main.bicep` + 7 modules
- **既有 UAT 部署 SOP**: `docs/07-deployment/02-azure-deployment/uat-deployment/` (13 份)
- **既有 Prod parameters**: `infrastructure/bicep/parameters/prod.parameters.json`

---

## 業務決策待確認

| # | 議題 | 結果 |
|---|------|------|
| 1 | **Staging 成本**（+$150/月）| ✅ **已同意（B8, 2026-04-28）** |
| 2 | **Staging on-demand vs 常駐**：成本敏感則 on-demand？ | ✅ 採常駐（Pilot 前後活躍，B8 預設） |
| 3 | **Staging 啟動時機**：W5 同 UAT 後續，or 等 CHANGE-069 完成？ | 待確認 — 建議等 CHANGE-069 |
| 4 | **GitHub Environment plan**：private repo 可能需 paid plan | 待 IT 確認 |
| 5 | **Prod 24h delay**：reviewers approval 後立即部署 vs 延遲 24h？ | 待確認 — 建議 0-1h（24h 太久）|

---

*文件建立日期: 2026-04-28*
*規劃人: Claude Opus 4.7（依 Phase 2 盤點報告產出）*
*下一步: 業務確認成本 → 進入實作（依賴 CHANGE-069）*
