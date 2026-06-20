# Azure 部署治理與權限模型（DEV / UAT / PRD）

> **建立日期**: 2026-06-16
> **狀態**: ✅ 生效中（DEV 已上線）
> **適用**: 所有 Azure 環境部署，**部署前必讀**
> **相關**: [`dev-deployment-runbook.md`](./dev-deployment-runbook.md)（DEV 實戰流程）、[`uat-deployment/`](./uat-deployment/)（UAT 步驟）、[`azure-deployment-plan.md`](./azure-deployment-plan.md)（總規劃）

---

## 0. 為何要有這份文件

不同環境的**部署權限、執行者、網路存取、Key Vault 管理範圍都不一樣**。把規則寫死在這裡，避免：
- 開發者誤以為自己能直接部署 PRD；
- 把 DEV/UAT 的「公開存取 + 開發者自建 KV」習慣帶到 PRD；
- 之後 app 轉為 private（僅內網）時驗收路徑搞錯。

**核心原則：DEV / UAT 由開發團隊用 Service Principal 自助部署；PRD 一律經 infra team。**

---

## 1. 環境權限矩陣（🔴 最重要）

| 面向 | DEV | UAT | PRD |
|------|-----|-----|-----|
| **誰執行部署** | 開發團隊（自助） | 開發團隊（自助） | **🔴 infra team（開發者不可直接部署）** |
| **部署身分** | Service Principal（權限較大） | Service Principal（權限較大） | infra team 的身分 / 受控 pipeline |
| **SP 權限範圍** | 可建/改大部分資源（見 §2） | 同 DEV | 開發者**無** PRD 部署權限 |
| **Key Vault 建立 / 管理** | **開發者自行建立與管理** | **開發者自行建立與管理** | **🔴 infra team 管理（開發者不碰）** |
| **網路存取（最終態）** | 將轉 **private（僅公司內網）** | **private（僅公司內網）** | **private（僅公司內網）** |
| **資料** | 可同步本地業務/設定資料（見 runbook §11） | 受控測試資料 | 真實資料，infra/DBA 管理 |

> **一句話**：DEV/UAT 是「我們的地盤」——可以自助跑 build、切映像、建 KV、灌資料；PRD 是「infra 的地盤」——我們只交付映像 + 部署說明，由 infra team 執行。

---

## 2. DEV / UAT 自助部署：Service Principal 能做什麼

infra team 給開發團隊的 SP 在 DEV/UAT 有**較大權限**，足以自助完成日常部署：

- `az acr build` 重建映像、推到 ACR
- `az webapp config container set` 切換容器映像 tag
- `az webapp restart`、改應用程式設定（appsettings）
- 讀寫 Key Vault 機密（infra 已授 `Key Vault Secrets Officer`）
- 抓容器 log（AAD bearer + Kudu）

**SP 權限的邊界**（仍需 infra）：
- **VNet / 私有端點 / 自訂 DNS**：屬 infra RG（如 `RG-RCITest-HKG-Infra`），SP **無權檢視/修改**。DEV 的 DNS 繞法（`WEBSITE_DNS_SERVER`）正是因為改不了 VNet DNS。
- **Key Vault 的 RBAC role assignment**：機密的讀寫權限由 infra 一次性授予（SP→`Secrets Officer`、WebApp MI→`Secrets User`），開發者不自行提權成 Owner。
- **`publicNetworkAccess` 開關 / 自訂網域憑證 / 內網 DNS A 紀錄**：infra 控制。

> 乾淨模式：需要「身分↔資源」接線（MI→KV、子網路→DNS）時，**請 infra 做 role assignment / 網路設定**，不要把部署身分提權成 Owner。此模式 UAT/PRD 一致沿用。

---

## 3. PRD 部署：交付給 infra team

開發團隊**不直接部署 PRD**。我們的職責是**交付可部署的產物 + 一致的文件流程**：

1. **映像**：在 ACR 建好、驗證過的 image tag（建議先在 UAT 驗收同一 tag）。
2. **部署說明**：環境變數清單、需放入 KV 的機密清單（**值由 infra/secret owner 提供，開發者不經手 PRD 機密**）、啟動旗標（如本專案的 `RUN_DEV_DATA_IMPORT` / `FORCE_SCHEMA_RESET` 在 PRD **必須為 false**）、schema migration 步驟。
3. **驗收路徑**：health 端點、關鍵頁面、回滾方式。

PRD 的 Key Vault、網路、資料皆由 infra/DBA 管理。schema 變更走正式 migration（見 [CHANGE-056](../../../claudedocs/4-changes/feature-changes/CHANGE-056-prisma-migration-baseline.md)），**不可**在 PRD 用 `FORCE_SCHEMA_RESET`（破壞性、僅限 DEV）。

---

## 4. 網路存取：將從 public 轉為 private（🔴 注意驗收路徑）

DEV 目前因排障**暫時開了 `publicNetworkAccess: Enabled`**。**最終態（UAT / PRD，以及 DEV 收尾）是 private——只能經公司內網存取**，不再有公開網址直連。

對部署/驗收的影響：
- **不能再用公網 IP + `curl --resolve` 從任意網路驗收**；必須**在公司內網**（或 VPN）才能打開 app。
- 內網要能解析 app 網址 → 依賴 infra 的**內網 DNS A 紀錄 / 私有端點 + 私有 DNS 區域**。
- 容器對外的診斷技巧（公用 DNS + `--resolve` 繞本機 DNS）在 private 後**只在有公網暴露時可用**；private 後抓 log 改走 Kudu（VNet 內或經授權通道）。
- 自訂網域（`*.rci-t.com`）憑證需 infra 綁好，否則用預設 `*.azurewebsites.net` 網址。

> 驗收前先確認：這個環境是 public 還是 private？private 就用內網/VPN 測，別誤判「打不開 = 部署失敗」。

---

## 5. Key Vault 管理範圍

| 環境 | KV 誰建立 / 管理 | 機密值誰提供 |
|------|-----------------|-------------|
| DEV | **開發者自建自管** | 開發者（從 `.env.azure-dev.local` 等本地來源複製） |
| UAT | **開發者自建自管** | 開發者 / 對應環境 owner |
| PRD | **🔴 infra team 管理** | secret owner / infra（**開發者不經手 PRD 機密**） |

DEV/UAT 的 KV 操作模式見 [`dev-deployment-runbook.md` §7](./dev-deployment-runbook.md)（搬機密、改 `@Microsoft.KeyVault(SecretUri=...)` 參考、驗證 `Resolved`）。**KV 名以 `-` 取代 `_`**；「一旦設定不可變更」的金鑰（如 `ENCRYPTION_KEY`）**絕不重產**，原值複製。

---

## 6. 統一部署流程入口

| 你要做什麼 | 看哪份 |
|-----------|--------|
| **DEV 自助部署 / 排障** | [`dev-deployment-runbook.md`](./dev-deployment-runbook.md) — 標準流程（§A）+ 實戰問題（§1–13） |
| **UAT 部署** | [`uat-deployment/00-overview.md`](./uat-deployment/00-overview.md) — 步驟文件；治理規則以本文件為準 |
| **PRD 部署** | 交付映像 + 說明給 infra team（見 §3） |
| **整體架構 / 決策** | [`azure-deployment-plan.md`](./azure-deployment-plan.md) |

---

*維護者: AI 助手 + 開發團隊*
*最後更新: 2026-06-16*
