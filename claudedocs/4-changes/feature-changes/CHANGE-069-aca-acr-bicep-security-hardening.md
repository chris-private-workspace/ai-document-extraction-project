# CHANGE-069: ACA / ACR Bicep 安全強化（Azure Container Apps + Container Registry Hardening）

> **狀態**: 📋 規劃中

> ## ✅ 用戶決策確認（2026-04-28）
>
> | ID | 決策 |
> |----|------|
> | **B7** | 採選項 A — **維持 Python 微服務架構並透過 Bicep 部署到 ACA**（不選擇 Node.js 重寫或外部 SaaS） |
>
> 理由：保留現有 OCR + Mapping 服務的 Python 生態系優勢（Azure DI SDK、規則引擎），透過 Bicep + ACA internal-only ingress 達成生產級部署。月成本增加 ~$50-100，**用戶 2026-04-28 已同意**。

## 變更摘要

| 項目 | 內容 |
|------|------|
| **變更編號** | CHANGE-069 |
| **變更日期** | 2026-04-28 |
| **相關模組** | Azure 部署 / Bicep IaC / CI/CD |
| **影響範圍** | `infrastructure/bicep/modules/acr.bicep`、`container-app.bicep`、`main.bicep`、新增 `python-extraction-service.bicep`、`python-mapping-service.bicep`、`.github/workflows/security.yml` 整合 Trivy |
| **優先級** | High |
| **狀態** | 📋 規劃中 |
| **類型** | Infrastructure Security Hardening |
| **依賴** | CHANGE-055（Azure deployment foundation）、CHANGE-056（Prisma migration baseline）|
| **對應安全控制項** | SDLC-13 ACR（L1 → L3）、SDLC-17 ACA 網路隔離（L1 → L3） |
| **Phase 2 報告依據** | `phase2-sdlc-assessment.md` §SDLC-13、§SDLC-17、§發現 2、§發現 5 |

---

## 問題描述

依 Phase 2 盤點 (`phase2-sdlc-assessment.md` 第 340-388、567-622 行) 結果：

### SDLC-13: ACR 安全配置 — **L1（Initial）**

> 證據（`acr.bicep`）：
> - ✅ `adminUserEnabled: false`（強制）
> - ❌ `quarantinePolicy: { status: 'disabled' }`（行 108-110）
> - ❌ `trustPolicy: { status: 'disabled' }`（行 113-117，Standard SKU 限制）
> - ❌ **無 Trivy 整合**（push 前無掃描）— STEP-04 文件全文 `grep "trivy|scan|vulnerability"` → **0 hits**

### SDLC-17: ACA 網路隔離 — **L1（Initial）**

> 證據：
> - `container-app.bicep:81-84`：`externalIngress: bool = true` 預設值（UAT 即公網暴露）
> - `container-apps-env.bicep:32-33`：`internalLoadBalancer: bool = false` 預設值
> - **Python OCR / Mapping services 未在 Bicep 中部署**（main.bicep 只有單一 containerApp 模組）
> - 委外 Infra Admin 但目前 `network-topology.md` 不存在

### 為何嚴重

- **Trivy 缺失**：任何含 CRITICAL CVE 的 base image（node:20-slim）漏洞直接帶到 prod
- **Quarantine disabled**：image push 後可立即 deploy，無人工檢查 gate
- **Python services 部署不明**：Pilot 上線時可能仍跑 docker-compose（未上 ACA）或 external ingress（攻擊面擴大）
- **Web app prod 公網暴露**：應走 internal-only + Front Door 但 Bicep 預設 external

---

## 變更方案

### 設計原則

1. **不破壞 CHANGE-055 既有規劃** — 在現有 Bicep 模組上擴增，不重寫
2. **Trivy 整合到 STEP-04**（push 前掃描）+ CI workflow（push 觸發掃描）
3. **Python services 補完 Bicep** — 兩個獨立 ACA module，internal-only
4. **環境差異化**：UAT external ingress（為 Pilot 方便）/ Prod internal-only + Private Endpoint（透過 parameters）

### 子變更 1：ACR 啟用 quarantinePolicy + Trivy 整合

**檔案**：`infrastructure/bicep/modules/acr.bicep`（既有，調整）

**變更**：
```bicep
// 行 108-110 變更
quarantinePolicy: {
  status: enableQuarantine ? 'enabled' : 'disabled'
}

@description('Enable quarantine policy (Pilot=false for fast iteration; Prod=true)')
param enableQuarantine bool = false  // UAT 預設 false，Prod=true
```

**Prod parameters**（`prod.parameters.json`）：
```json
{
  "enableQuarantine": { "value": true }
}
```

> **取捨**：quarantinePolicy 啟用後需 manual approval gate；Pilot 階段可先用 CI Trivy 替代，Prod 上線前啟用 quarantine。

### 子變更 2：CI Workflow 整合 Trivy

**檔案**：`.github/workflows/security.yml`（既有或本期新建，與 Wave 1 整合）

**新增 job**：
```yaml
trivy-image-scan:
  name: Trivy Image Scan
  runs-on: ubuntu-latest
  needs: docker-build  # 假設前置 job 是 build image
  permissions:
    contents: read
    security-events: write  # 寫入 GitHub Security tab
  steps:
    - name: Run Trivy
      uses: aquasecurity/trivy-action@0.20.0
      with:
        image-ref: '${{ needs.docker-build.outputs.image }}'
        format: 'sarif'
        output: 'trivy-results.sarif'
        severity: 'CRITICAL,HIGH'
        exit-code: '1'  # CRITICAL/HIGH 即 fail build
        ignore-unfixed: true

    - name: Upload SARIF
      uses: github/codeql-action/upload-sarif@v3
      with:
        sarif_file: 'trivy-results.sarif'
```

**STEP-04 文件擴增**：`docs/07-deployment/02-azure-deployment/uat-deployment/04-container-build-push.md`

加入 manual command：
```bash
# 本機 push 前掃描
docker build -t myimage:tag .
trivy image --severity CRITICAL,HIGH --exit-code 1 myimage:tag
# 通過後再 push
az acr login --name <acr>
docker push <acr>.azurecr.io/myimage:tag
```

### 子變更 3：Python OCR/Mapping ACA 補完

**新增檔案**：`infrastructure/bicep/modules/python-service.bicep`（共用 module）

**核心配置**：
```bicep
@description('Generic Python service ACA module (internal-only by default)')
param serviceName string  // 'extraction' or 'mapping'
param image string
param targetPort int      // 8000 (extraction) or 8001 (mapping)
param externalIngress bool = false  // 預設 internal
param environmentId string
param acrLoginServer string

resource pythonApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: 'aca-${serviceName}-${environment}'
  location: location
  identity: {
    type: 'SystemAssigned'  // MI for ACR pull
  }
  properties: {
    managedEnvironmentId: environmentId
    configuration: {
      ingress: {
        external: externalIngress  // false = internal-only
        targetPort: targetPort
        transport: 'http'
        allowInsecure: false
      }
      registries: [
        { server: acrLoginServer, identity: 'system' }
      ]
    }
    template: {
      containers: [
        {
          name: serviceName
          image: image
          resources: { cpu: json('0.5'), memory: '1Gi' }
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 3
      }
    }
  }
}

output fqdn string = pythonApp.properties.configuration.ingress.fqdn
output identityPrincipalId string = pythonApp.identity.principalId
```

**main.bicep 整合**：
```bicep
module pythonExtraction 'modules/python-service.bicep' = {
  name: 'python-extraction'
  params: {
    serviceName: 'extraction'
    image: '${acr.outputs.loginServer}/python-extraction:${imageTag}'
    targetPort: 8000
    externalIngress: false  // internal-only
    environmentId: containerAppsEnv.outputs.id
    acrLoginServer: acr.outputs.loginServer
  }
}

module pythonMapping 'modules/python-service.bicep' = {
  name: 'python-mapping'
  params: {
    serviceName: 'mapping'
    image: '${acr.outputs.loginServer}/python-mapping:${imageTag}'
    targetPort: 8001
    externalIngress: false
    environmentId: containerAppsEnv.outputs.id
    acrLoginServer: acr.outputs.loginServer
  }
}

// Web app env vars 指向 internal FQDN
module webApp 'modules/container-app.bicep' = {
  // ...
  params: {
    envVars: union(envVars, {
      OCR_SERVICE_URL: 'http://${pythonExtraction.outputs.fqdn}'
      MAPPING_SERVICE_URL: 'http://${pythonMapping.outputs.fqdn}'
    })
  }
}
```

### 子變更 4：Web app prod ingress 改為 internal-only

**檔案**：`infrastructure/bicep/parameters/prod.parameters.json`

```json
{
  "externalIngress": { "value": false },
  "internalLoadBalancer": { "value": true },
  "enableQuarantine": { "value": true }
}
```

**前提**：Prod 須搭配 Front Door 或 Application Gateway（由 Infra Admin 提供）作為 public 入口 → 內部走 ACA Environment internal LB。

> **取捨**：UAT 維持 `externalIngress: true`（Pilot 方便），Prod 強制 internal。需 Infra Admin 確認 Front Door 是否到位。

### 子變更 5：Storage `allowSharedKeyAccess` Prod 強制 false

**檔案**：`infrastructure/bicep/parameters/prod.parameters.json`

```json
{
  "allowSharedKeyAccess": { "value": false }
}
```

**前提**：應用程式須完全用 `DefaultAzureCredential` 取代 Connection String（Phase 4 規劃）。

### 子變更 6：RBAC 自動化（補 main.bicep）

**現況**：Phase 2 報告 §SDLC-14 註明「RBAC 授予未在 Bicep 自動化（依賴手動 STEP-08 Action 8.3）」

**補完**：
```bicep
// main.bicep 結尾加 RBAC roleAssignment

resource webAppAcrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(acr.outputs.id, webApp.outputs.identityPrincipalId, 'AcrPull')
  scope: acr.outputs.resource
  properties: {
    principalId: webApp.outputs.identityPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')  // AcrPull
  }
}

// 同樣 KV Secrets User、Storage Blob Data Contributor、PostgreSQL Entra Admin
// 依序為 web app + python-extraction + python-mapping 三個 identity 授權
```

### 子變更 7：Bicep 規範與文檔

**檔案**：
- `docs/07-deployment/02-azure-deployment/security-hardening-checklist.md`（新增）
- `docs/07-deployment/02-azure-deployment/uat-deployment/04-container-build-push.md`（更新加 Trivy）
- `docs/07-deployment/02-azure-deployment/uat-deployment/08-first-deployment.md`（更新 Action 8.3 改為 Bicep 自動）

---

## 修改的檔案

| 檔案 | 變更類型 | 預估行數 |
|------|----------|---------|
| `infrastructure/bicep/modules/acr.bicep` | 🔄 quarantine 條件式 | +5 -3 |
| `infrastructure/bicep/modules/python-service.bicep` | ➕ 新增（共用 module） | ~150 |
| `infrastructure/bicep/main.bicep` | 🔄 整合 python-extraction + python-mapping + RBAC | +120 |
| `infrastructure/bicep/parameters/uat.parameters.json` | 🔄 補新增參數 | +6 |
| `infrastructure/bicep/parameters/prod.parameters.json` | 🔄 補新增參數（quarantine, internal, etc）| +12 |
| `.github/workflows/security.yml` | 🔄 加 Trivy job | +40 |
| `docs/07-deployment/02-azure-deployment/uat-deployment/04-container-build-push.md` | 🔄 加 Trivy 步驟 | +50 |
| `docs/07-deployment/02-azure-deployment/uat-deployment/08-first-deployment.md` | 🔄 移除手動 RBAC（改 Bicep） | +20 -40 |
| `docs/07-deployment/02-azure-deployment/security-hardening-checklist.md` | ➕ 新增 | ~250 |
| `docs/07-deployment/02-azure-deployment/network-topology.md` | ➕ 新增（與 Infra Admin 協作）| ~200 |
| `python-services/extraction/Dockerfile` | 🔄 補 healthcheck + non-root user | +10 |
| `python-services/mapping/Dockerfile` | 🔄 同上 | +10 |

---

## 預期效果

### 安全提升

| 面向 | Before | After |
|------|--------|-------|
| SDLC-13 ACR 評分 | L1 | L2 (UAT) → L3 (Prod with quarantine) |
| SDLC-17 ACA 網路隔離 | L1 | L2 (UAT) → L3 (Prod internal) |
| Python services 部署 | 未在 Bicep | 兩個獨立 ACA + internal-only |
| Trivy 掃描 | 無 | CI + 本機 manual |
| RBAC 授予 | 手動 az CLI | Bicep 自動 |
| Web app prod 暴露 | external 預設 | internal + Front Door |

### 業務影響

- ✅ Trivy CI 阻擋 CRITICAL/HIGH CVE → 部署品質提升
- ✅ Python services 完整部署 → 不再依賴 docker-compose 或不明部署位置
- ✅ Prod web app internal → 攻擊面大幅縮小
- ⚠️ Trivy fail-on-high 可能阻擋部署 → 需 ignore.txt 機制
- ⚠️ Prod internal 需 Front Door 配套（Infra Admin 工作）
- ⚠️ Storage allowSharedKeyAccess=false 需應用層先支援 MI

---

## 測試驗證

### Bicep 驗證

- [ ] `az bicep build --file main.bicep` 無錯誤
- [ ] `az deployment group what-if` 顯示新增 python-extraction + python-mapping
- [ ] RBAC roleAssignment 正確生成
- [ ] UAT 部署成功（externalIngress=true 維持原行為）

### Trivy CI 驗證

- [ ] PR 含 CRITICAL CVE → CI fail
- [ ] PR 通過 Trivy → 進入下一 stage
- [ ] SARIF 上傳 GitHub Security tab 可見

### 整合測試

- [ ] Web app 透過 internal FQDN 呼叫 python-extraction（http://aca-extraction-uat.internal:8000）
- [ ] Python services 不可從公網存取（curl from 外部 → fail）
- [ ] ACR pull via MI（無 admin user）

### Prod 部署演練

- [ ] Prod parameters 套用後 → web app fqdn 為 internal
- [ ] Front Door routing 正確（依賴 Infra Admin）
- [ ] Storage 不接受 shared key（應用透過 MI 存取）

---

## 風險提示

- **Trivy false positive**：base image CVE 可能無 fix → 需 `ignore-unfixed: true` + 手動 review
- ✅ **Python services 部署成本**：2 個額外 ACA app（+ ~$50-100/月）— **用戶 2026-04-28 已同意此成本範圍（B7 決策）**
- **internal ingress + Front Door 依賴 Infra Admin**：若 Front Door 未 ready，Prod web app 無法被 access
- **RBAC Bicep 化在跨訂閱情境失敗**：若 ACR 在不同 subscription → 需 cross-sub deployment（本期假設同 sub）
- **既有 STEP-08 Action 8.3 文件需重寫**：手動 az CLI 改為 Bicep 自動 → 可能有 transition gap
- **quarantine policy 需手動 approval gate**：若 CI 已過 Trivy → 是否還需 manual？建議 Pilot 階段 disabled，Prod 上線前 enable

---

## 實作順序建議

1. **W1**（與 CHANGE-055 W4 對齊）：
   - 建立 `python-service.bicep` module
   - 整合 main.bicep（python-extraction + python-mapping）
   - 更新 UAT parameters
   - UAT 重新部署測試

2. **W2**：
   - Trivy CI workflow 整合
   - STEP-04 文件更新
   - 本機 manual scan 演練

3. **W3**：
   - RBAC 自動化（移除手動 az CLI）
   - STEP-08 文件 rewrite

4. **W4-W5**：
   - 撰寫 `network-topology.md`（與 Infra Admin 協作）
   - 撰寫 `security-hardening-checklist.md`

5. **Prod 上線前**（W10-W11）：
   - 啟用 quarantinePolicy
   - Web app internal ingress + Front Door 整合
   - Storage allowSharedKeyAccess=false
   - 完整安全 checklist 通過

---

## 相關文件

- **Phase 2 報告**: `docs/08-security-and-governance/phase2-sdlc-assessment.md` §SDLC-13/14/15/16/17、§發現 1/2/5
- **CHANGE-055**: Azure deployment foundation（本 CHANGE 的基礎）
- **CHANGE-056**: Prisma migration baseline（部署流程相依）
- **既有 Bicep 模板**: `infrastructure/bicep/main.bicep` + 7 modules
- **既有 UAT 部署文件**: `docs/07-deployment/02-azure-deployment/uat-deployment/`
- **Trivy 套件**: https://github.com/aquasecurity/trivy-action（GitHub Actions 免費）
- **CHANGE-070**: 三環境隔離（staging）— 本 CHANGE 完成後可用作 staging 範本

---

## 業務決策待確認

| # | 議題 | 結果 |
|---|------|------|
| 1 | **Python services 部署成本**（+2 ACA app, ~$50-100/mo）| ✅ **已同意（B7, 2026-04-28）**：採選項 A 維持 Python + Bicep 部署到 ACA |
| 2 | **Prod Front Door 是否到位**（Infra Admin 工作） | 待 Infra Admin 確認 |
| 3 | **Trivy fail-on-high 是否阻擋部署**：嚴格 vs 警告？ | 待確認 — 建議嚴格（CRITICAL/HIGH 阻擋）|
| 4 | **quarantinePolicy 啟用時機**：Prod 上線前 vs Pilot 後？ | 待確認 — 建議 Prod 上線前 |
| 5 | **Python services 是否需獨立 KV secrets**：是否共用 web app KV？ | 待確認 — 建議共用（同訂閱、同 KV）|

---

*文件建立日期: 2026-04-28*
*規劃人: Claude Opus 4.7（依 Phase 2 盤點報告產出）*
*下一步: 與 Infra Admin 協同確認網路設計 → 進入實作*
