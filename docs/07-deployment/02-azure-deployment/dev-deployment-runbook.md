# Azure DEV 部署 Runbook — 標準流程 + 實戰問題與解法

> **建立日期**: 2026-06-15 ・ **最後更新**: 2026-06-16
> **狀態**: ✅ DEV 已上線 + 機密正規化到 Key Vault + 本地業務/設定資料已同步(14 表)+ CRLF / re2-wasm 建置問題已根治
> **適用**: Azure DEV 環境(App Service for Containers,**非**規劃文件假設的 Container Apps)
> **🔴 部署前必讀治理規則**: [`deployment-governance.md`](./deployment-governance.md)(DEV/UAT 自助 vs PRD 經 infra、app 轉 private、KV 管理範圍)
> **相關**: [`CHANGE-055`](../../../claudedocs/4-changes/feature-changes/CHANGE-055-azure-deployment-foundation.md)、[`local-vs-azure-differences.md`](../local-vs-azure-differences.md)、[`11-troubleshooting.md`](./uat-deployment/11-troubleshooting.md)(後者為規劃架構,部分不適用)

> **怎麼讀這份文件**:第一次部署或例行重新部署 → 直接照 **§A 標準部署流程**;遇到問題 → 查 **§1–13 實戰問題**對應條目。

---

## 0. 一句話總結

DEV 首次部署時,容器啟動**無限重啟、對外回 HTTP 503**。根因是 **VNet 自訂 DNS 連不到,導致容器解析不到私有 PostgreSQL**;以 App Service 設定 `WEBSITE_DNS_SERVER=168.63.129.16`(改用 Azure 平台 DNS)**暫時繞過**後成功上線。另有「公司內網 DNS 解析不到公開網址」「登入錯誤訊息誤導」兩個獨立議題。**同日 infra 開通 Key Vault 權限後,機密已從明文設定正規化為 Key Vault + Managed Identity(見 §7)。**

---

## 1. 最終成功狀態(基準)

| 項目 | 值 |
|------|-----|
| 健康檢查 | `GET /api/health` → `200` `{"status":"healthy","services":{"database":"connected"}}` |
| Schema | bootstrap 套用 `init.sql` → **122 表** |
| 管理員 | `admin@rci-t.com`(seed 建立,ACTIVE / globalAdmin / emailVerified) |
| 公開網址 | `https://webapp-raposcm-aidocprocessing-dev-f8dua6b5eqerbrbk.eastasia-01.azurewebsites.net` |
| 自訂網域 | `https://raposcm-aidocprocessing-dev.rci-t.com` |
| 公開 IP | `13.75.34.162` |
| 容器映像 | `acrscmdocprocessingdev.azurecr.io/ai-document-extraction:dev` |

登入帳密:email = `admin@rci-t.com`(全小寫;seed 會 `.toLowerCase().trim()`);密碼 = `SEED_ADMIN_PASSWORD` 的值(在 `.env.azure-dev.local`,**不入 git**)。

---

## A. 標準部署流程(可重複)

> 例行「改了程式 → 重新部署 DEV」照此流程。UAT 同樣適用(換對應資源名)。治理規則見 [`deployment-governance.md`](./deployment-governance.md)。
> 資源名:RG `RG-RAPOSCM-AIDocProcessing-DEV`、WebApp `WebApp-RAPOSCM-AIDocProcessing-DEV`、ACR `acrscmdocprocessingdev`。

### A.0 前置
- 已用部署 SP 登入:`az account show` 確認訂閱正確。
- Git Bash 帶 resource ID 的 az 指令前:`export MSYS_NO_PATHCONV=1`。
- 🔴 **工作樹的 shell script 必須是 LF**(見 §12)。`.gitattributes` 已強制 `*.sh eol=lf`;切換分支後仍建議 `node -e "..."` 確認 `scripts/docker-entrypoint.sh` 無 CRLF,否則容器 exit 127。
- 🔴 **確認「真正要上線的變更範圍」= 線上映像 commit → 目標 commit,不是「工作樹 vs main」**(見 §16 事故)。手動部署是低頻的,線上映像常落後 main 好幾個 PR,一次部署會把累積的變更全帶上線。
  ```bash
  # 1. 線上正在跑的 tag(對照 deployment-records/ 找對應 commit)
  az webapp config container show -g RG-RAPOSCM-AIDocProcessing-DEV -n WebApp-RAPOSCM-AIDocProcessing-DEV \
    --query "[?name=='DOCKER_CUSTOM_IMAGE_NAME'].value" -o tsv
  # 2. 這段區間有沒有新增/改名的環境變數(.env.example 是權威清單,註解常寫明缺失後果)
  git diff <線上commit>..<目標commit> -- .env.example
  # 3. 有新增項 → 逐一對照 Azure 現有設定,缺的補上(值用該環境實際的部署名/資源名,不是 example 的預設值)
  az webapp config appsettings list -g RG-RAPOSCM-AIDocProcessing-DEV -n WebApp-RAPOSCM-AIDocProcessing-DEV -o table
  ```
  ⚠️ 程式碼多用 `process.env[X] || 預設值`:**設定缺失不會報錯,只會靜默用錯值**,本地/CI 測不出來,只有真實環境才炸(§16 就是這樣整批 `OCR_FAILED`)。

### A.1 建置映像(`az acr build`)
```bash
TAG="dev-$(date +%Y%m%d%H%M%S)"   # 用有意義前綴,如 dev-datasync4-...
az acr build --registry acrscmdocprocessingdev \
  --image ai-document-extraction:$TAG --file Dockerfile .
```
- ⚠️ 本機 log 串流會在 `npx prisma generate` 的 `✔` 上以 **cp1252 崩潰**(本機程序看似失敗,**雲端建置照常進行**)。**不要**據此判定失敗。
- 改看控制面確認:`az acr task list-runs --registry acrscmdocprocessingdev --top 1 -o table`(等 `Succeeded`);完整 log 用 SAS URL(見 §11 末)。
- 確認 tag 已就緒:`az acr repository show-tags --name acrscmdocprocessingdev --repository ai-document-extraction --orderby time_desc --top 3 -o tsv`。

### A.2 (選用)一次性資料同步 / schema 重設 / DB 修補旗標
- 只在需要灌資料時設 `RUN_DEV_DATA_IMPORT=true`(見 §11);只在 schema 落後 main 時設 `FORCE_SCHEMA_RESET=true`(見 §11,**破壞性**)。
- additive schema 漂移用 `RUN_SCHEMA_DRIFT_FIX=true`(見 §14);**FIX-095** 一次性 Stage 3 prompt 修正用 `RUN_STAGE3_PROMPT_FIX=true`(見 §15,冪等、非致命)。
- 🔴 所有一次性旗標**用完即設回 false**(見 §A.5);**PRD 這些旗標永遠 false**(見 governance §3)。

### A.3 切換映像 + 重啟
```bash
az webapp config container set -g RG-RAPOSCM-AIDocProcessing-DEV -n WebApp-RAPOSCM-AIDocProcessing-DEV \
  --container-image-name acrscmdocprocessingdev.azurecr.io/ai-document-extraction:$TAG
az webapp restart -g RG-RAPOSCM-AIDocProcessing-DEV -n WebApp-RAPOSCM-AIDocProcessing-DEV
```

### A.4 驗證
- 健康:`GET /api/health` → `200` `{"services":{"database":"connected"}}`(public 時可 `curl --resolve <host>:443:13.75.34.162`;**private 後須在內網/VPN**,見 governance §4)。
- 容器 log(AAD bearer + Kudu,見 §8):確認 `[entrypoint] Step 3/3: starting Next.js server` + `✓ Ready`,且**無** `exec: ... not found`(§12)、**無** `re2.wasm` ENOENT(§13)。
- 若有跑匯入:log 應見各表 `✓ N/N inserted` + `[import] business data import done`(§11)。

### A.5 收尾(🔴 一次性旗標關閉 —— 兩類旗標關法不同)

**布林旗標(7 個)** —— 設回 `false` 即關閉。🔴 **以下為 2026-08-07 實測線上實際存在的 7 個**:
`RUN_DEV_DATA_IMPORT`、`FORCE_SCHEMA_RESET`、`RUN_SCHEMA_DRIFT_FIX`、`RUN_EMAIL_VERIFIED_BACKFILL`、
`RUN_STAGE3_PROMPT_FIX`、`RUN_AZURE_SYNC`、`RUN_INVOICE_NUMBER_BACKFILL`。

> ⚠️ 本清單原記有 `RUN_FIX110_ALIAS_BACKFILL` 與 `RUN_FIX111_DEACTIVATE_FIELD_EXTRACTION`,
> 但線上**並不存在**這兩個設定;而實際存在的 `RUN_AZURE_SYNC` 原本未列。已依實測更正。
> 清理前請一律以 `az webapp config appsettings list` 的實際結果為準,不要照抄清單。
```bash
az webapp config appsettings set -g RG-RAPOSCM-AIDocProcessing-DEV -n WebApp-RAPOSCM-AIDocProcessing-DEV \
  --settings RUN_DEV_DATA_IMPORT=false FORCE_SCHEMA_RESET=false
```

**非布林旗標(9 個)** —— 🔴 **必須清空,設 `false` 不會關閉**:
- `RUN_TEMPLATE_MAPPING_SEED`(三模式 `inspect|dryrun|write`)
- `RUN_CHANGE113_DHL_SETUP`(三模式 `inspect|dryrun|write`)
- `RUN_CONFIG_SYNC_20260803`(三模式 `inspect|dryrun|write`,見 §17)
- `RUN_CONFIG_DIAGNOSE_20260806`(單模式 `inspect`,**唯讀**,見 §18)
- `RUN_TOLL_SPLIT_20260806`(三模式 `inspect|dryrun|write`,**會寫入**,見 §19)
- `RUN_ORPHAN_CHECK`(單模式 `inspect`,**唯讀**,見 §20)
- `RUN_TEMPLATE_SNAPSHOT`(單模式 `capture`,**唯讀**,見 §20)
- `RUN_FIX161_CEVA_20260806`(三模式 `inspect|dryrun|write`,**會寫入**,見 §21)
- `RUN_ORPHAN_CAUSE`(單模式 `inspect`,**唯讀**,見 §22)
- `GRANT_GLOBAL_ADMIN_EMAIL`(值是 email)

另有三個**搭配用**的設定(非旗標,但同樣建議用完清掉,避免下次誤用舊值):
`RECONCILE_COMPANY`、`RECONCILE_BASELINE`、`RECONCILE_DOCS`。

```bash
az webapp config appsettings delete -g RG-RAPOSCM-AIDocProcessing-DEV -n WebApp-RAPOSCM-AIDocProcessing-DEV \
  --setting-names RUN_TEMPLATE_MAPPING_SEED RUN_CHANGE113_DHL_SETUP RUN_CONFIG_SYNC_20260803 \
                  RUN_CONFIG_DIAGNOSE_20260806 RUN_TOLL_SPLIT_20260806 \
                  RUN_ORPHAN_CHECK RUN_TEMPLATE_SNAPSHOT RUN_FIX161_CEVA_20260806 \
                  RECONCILE_COMPANY RECONCILE_BASELINE RECONCILE_DOCS GRANT_GLOBAL_ADMIN_EMAIL
```
> FIX-140 前這 2 個用 `[ -n "$X" ]`(非空即執行),`"false"` 非空故仍觸發 —— 2026-07-28 FIX-139 部署的 log 就出現 `template field mapping seed: mode=false`(當時該設定確實是 `false`)。FIX-140 已改為明確列舉/形狀檢查:值無法辨識時**印出 skip 訊息並跳過**,不再靜默執行。設成 `false` 現在會看到 `... skipped: mode=false not recognised`,**但那仍代表設定沒清乾淨**,請照上方 `delete` 清掉。

確認:`az webapp config appsettings list ... -o table`,兩類都檢查(布林為 `false`、非布林**不存在**)。

### A.6 回滾(部署壞掉時)
切回上一個可用 tag + 重啟即可(image tag 是回滾單位):
```bash
az webapp config container set ... --container-image-name acrscmdocprocessingdev.azurecr.io/ai-document-extraction:<上一個可用 tag>
az webapp restart ...
```
> 實戰:`dev-datasync2` 因 CRLF exit 127,即以此回滾到 `dev-datasync-202606151853` 恢復服務,再修 §12 重建。

---

## 2. 問題 1(主阻塞):容器無限重啟 → HTTP 503

### 症狀
- 外部訪問回 `503 Application Error`,`/api/health` 等數十秒才回 503。
- 容器日誌 `*_default_docker.log` 反覆出現:
  ```
  [entrypoint] Step 1/3: bootstrap database schema (if needed)
  [bootstrap] FAILED: timeout expired      ← 約 30 秒後
  Container has finished running with exit code: 1
  ```
- 平台層日誌:`Site startup probe failed` / `ContainerTimeout`。

### 根因(逐層確認)
1. `prisma/bootstrap-db.js` 用 `pg` 連線,`connectionTimeoutMillis: 30000` → 「timeout expired」就是這 30 秒**連線逾時**。
2. VNet 整合本身**正常**(整合到 `RG-RCITest-HKG-Infra` 的 `vnet-rcitest-hkg` / `Subnet-RCITest-D-WebApp-DEV`,`vnetRouteAllEnabled: true`)。
3. 容器內實測:`nslookup pgsql-...postgres.database.azure.com` → **`connection timed out; no servers could be reached`**。`/etc/resolv.conf` 顯示容器 DNS 伺服器是 VNet 配置的 **`10.160.65.4`**,但這台 DNS **從 WebApp 子網路連不到** → PG 主機名稱解析不出來 → 連線逾時。
4. 結論:**不是 DB 權限問題、不是程式問題,是網路/DNS 設定問題**(網路資源在 infra RG,app 部署身分無權限檢視/修改)。

---

## 3. 解法(暫時繞法,已套用)

在 App Service 應用程式設定加:

```
WEBSITE_DNS_SERVER = 168.63.129.16
```

(`168.63.129.16` 是 Azure 平台 DNS,VNet 內必達。)

套用後容器內實測:
- `nslookup ... 168.63.129.16` → 解析到私有端點 IP **`10.160.68.56`**(代表 `privatelink.postgres.database.azure.com` 私有 DNS 區域其實**已**連到 VNet)。
- `curl -v telnet://10.160.68.56:5432` → **`Connected`**(TCP 通)。
- 下一次容器啟動 → bootstrap 連上 DB → 建 122 表 → seed → Next.js Ready。

> ⚠️ **這是暫時繞法,不是正解。改動前請勿移除此設定。**

---

## 4. 問題 2:平台「重啟退避」會延遲修復生效

容器反覆崩潰後,App Service 進入**退避**,自然重試間隔拉長到**約 35 分鐘**(實測 04:33 → 05:08 → 05:43 → 06:17)。

實測 **`az webapp restart`、`stop`+`start`、改 appsetting、`az webapp config container set` 都無法強制立即重啟**——套了修復後,常需**等下一次自然重試**才生效。別誤判「修復沒用」。

---

## 5. 問題 3:公司內網 DNS 解析不到 app 公開網址

### 症狀
公司網路內的瀏覽器打不開 app 網址(兩個網址都一樣)。

### 根因
公司 DNS `10.160.50.4` 對 app 公開網址**回傳空(無 A 紀錄)**;公用 DNS(8.8.8.8 / 1.1.1.1)則正常解析到公開 IP `13.75.34.162`。即 app 公網可達,但**內網解析不到**。

### 暫時繞法
- 手機行動網路(走公用 DNS)直接開,或
- 編輯 hosts(`C:\Windows\System32\drivers\etc\hosts`,需系統管理員)加:
  ```
  13.75.34.162  webapp-raposcm-aidocprocessing-dev-f8dua6b5eqerbrbk.eastasia-01.azurewebsites.net
  ```
  (用預設 `azurewebsites.net` 網址,憑證一定對;`rci-t.com` 自訂網域憑證未必綁好。)

### 正解(待 infra)
讓內網 DNS `10.160.50.4` 能解析此 app 網址(回公開 IP,或建好私有端點 + 內部 DNS 紀錄 + 內網可路由到該私有 IP)。

---

## 6. 問題 4:登入「An unknown error occurred」其實是帳密錯誤

### 症狀
登入頁顯示「An unknown error occurred. Please try again later.」

### 真相
這是前端對 Auth.js **`CredentialsSignin`** 的通用訊息 = **email 或密碼不符**,**非系統錯誤**。容器日誌:
```
[Auth] Production mode - verifying credentials
[Auth] Credential check failed
[auth][error] CredentialsSignin
```
(`AUTH_URL` / `AUTH_SECRET` / `AUTH_TRUST_HOST` 設定皆正確;帳號本身 ACTIVE。)

### 解法
- Email:`admin@rci-t.com`(全小寫;**勿用**本地的 `admin@ai-document-extraction.com`)。
- 密碼:`.env.azure-dev.local` 的 `SEED_ADMIN_PASSWORD`(14 字元,**不會 trim**)→ 注意前後空格、手機鍵盤自動大寫、特殊符號。
- 若密碼遺失:更新 `SEED_ADMIN_PASSWORD` 設定 → 重跑 seed(idempotent upsert)→ 受退避影響需等重啟生效。

---

## 7. 機密已正規化到 Key Vault(2026-06-15 完成)

> 首次上線時機密是「直接放 App Service 應用程式設定」(因部署身分僅 Contributor、讀不到 RBAC 模式的 KV)。同日 infra 開通 KV `kvscmdocprocessingdev` 權限後,已改用正規的 **Key Vault + Managed Identity** 模式。

### infra 開通的權限(KV 為 RBAC 模式)
| 身分 | 角色 | 用途 |
|------|------|------|
| 部署 SP(objectId `e2824cf9…`) | `Key Vault Secrets Officer` | 寫入/讀取機密 |
| WebApp System-Assigned MI(`b3940bc7…`) | `Key Vault Secrets User` | **執行期讀取機密(KV 參考靠此)** |

### 搬遷做法
1. 逐一把機密寫進 KV:`az keyvault secret set --vault-name kvscmdocprocessingdev --name <KV名> --value <原值>`(**原值複製**;`ENCRYPTION_KEY` 等「一旦設定不可變更」者**絕不重產**;KV 名以 `-` 取代 `_`)。
2. App Service 設定改成參考:`<ENV>=@Microsoft.KeyVault(SecretUri=https://kvscmdocprocessingdev.vault.azure.net/secrets/<KV名>)`(明文即從設定移除)。
3. 重啟驗證。

### 已搬遷的 9 個機密
`DATABASE_URL`、`AUTH_SECRET`、`JWT_SECRET`、`SESSION_SECRET`、`ENCRYPTION_KEY`、`AZURE_OPENAI_API_KEY`、`AZURE_DI_KEY`、`AZURE_STORAGE_CONNECTION_STRING`、`SEED_ADMIN_PASSWORD`。
(非機密如各 `*_ENDPOINT`、模型部署名、`WEBSITES_PORT`、feature flags **留在 App Service 設定**,不進 KV。)

### 驗證方式
- KV 參考解析狀態(預期全部 `Resolved`):
  ```bash
  az rest --method get --url ".../providers/Microsoft.Web/sites/<app>/config/configreferences/appsettings?api-version=2022-09-01"
  ```
- 強制重啟後,新程序 `/api/health` 的 `uptime` 歸零且 `services.database=connected` → 證明 KV 來源的值端對端可用。

### ⚠️ 注意事項
- **把 appsetting 改成 KV 參考不一定觸發容器重啟**(實測沒重啟,舊程序續用舊值)。要 `az webapp restart` 強制切換並驗證,別停在「改了但沒生效」的狀態。
- `CONFIG_ENCRYPTION_KEY` 目前**未設定**(FIX-070 為 fail-closed:寫入加密系統設定會失敗);建議產一把、一併放 KV(同屬「不可變更」)。
- KV 連通同樣依賴 §3 的 DNS 繞法(容器需能解析 `*.vault.azure.net`;實測 DNS+TCP 皆通)。

---

## 8. 診斷技巧(本次用到,可重複使用)

對外封閉 / 私網後 / 本機 DNS 又攔截解析時:

| 需求 | 做法 |
|------|------|
| 連對外封閉的 app/SCM | `nslookup <host> 8.8.8.8` 取公開 IP,再 `curl --resolve <host>:443:<IP> https://<host>/...` |
| 抓容器 docker log(SCM basic auth 被停 → 401) | 用 AAD bearer:`TOK=$(az account get-access-token --resource https://management.azure.com --query accessToken -o tsv)`;`curl -H "Authorization: Bearer $TOK" https://<scm>/api/logs/docker`(列檔)→ `.../api/vfs/LogFiles/<file>`(抓內容)。app stdout 在 `*_default_docker.log` |
| 容器內測 DNS/TCP | Kudu `POST https://<scm>/api/command`(帶 Bearer),`{"command":"nslookup <host>","dir":"/home"}`。**不走完整 shell**(無 `&&`/`;`/`/dev/tcp`),一次一指令;TCP 用 `curl -v -m 8 telnet://<host>:<port>` |
| Git Bash 路徑陷阱 | az 帶 `/subscriptions/...` resource ID 時加 `export MSYS_NO_PATHCONV=1`,或改用 `-g/-n` |

`<scm>` = `webapp-raposcm-aidocprocessing-dev-f8dua6b5eqerbrbk.scm.eastasia-01.azurewebsites.net`

---

## 9. 待 infra 的正解 vs 目前的暫時繞法(交接清單)

| # | 議題 | 目前狀態 / 暫時繞法 | 正解(infra) |
|---|------|------------|--------------|
| 1 | 容器連不到私有 PG(VNet DNS) | 🟡 App Service 設 `WEBSITE_DNS_SERVER=168.63.129.16` | 修好自訂 DNS `10.160.65.4` 從 WebApp 子網路的可達性,或正式確認改用 Azure DNS |
| 2 | 公司內網解析不到 app 網址 | ✅ **已完成**(2026-06-15 infra 修好內網 DNS,本機/公司網路可直接開 app 網址) | — |
| 3 | 對外存取暫時開啟 | 🟡 infra 已暫時把 `publicNetworkAccess` 設 `Enabled` | 決定最終是否關回 `Disabled`,並約定驗收訪問路徑 |
| 4 | 機密管理(Key Vault) | ✅ **已完成** | infra 已授權部署 SP(`Secrets Officer`)+ WebApp MI(`Secrets User`);9 個機密已搬入 KV 並改用 KV 參考(見 §7)。UAT/PROD 沿用同模式即可 |

> 備註:本次 infra 願意為我們做**特定 role assignment**(KV 角色),代表 UAT/PROD **不必把部署身分提權成 Owner**,沿用「請 infra 做 MI→KV 接線」的乾淨模式即可。

---

## 10. 非阻塞問題(後續 FIX 候選)

容器日誌出現(不影響啟動):
```
Warning: Cannot load "@napi-rs/canvas" package ... pdf-to-img/pdfjs-dist
Warning: Cannot polyfill `DOMMatrix` / `ImageData` / `Path2D`
```
影響:PDF 轉圖/預覽渲染品質可能受限。建議列為後續 FIX(映像補 `@napi-rs/canvas` 或對應 native 依賴)。

---

## 11. DEV 業務資料同步 + schema 漂移 + build 修復(2026-06-15)

把本地 DB 的業務/設定資料同步到 Azure DEV 時連帶處理的事。對應 **PR #37**(分支 `feature/azure-dev-data-import`)。

### 連線限制(關鍵前提)
本機**無法直連** Azure PG:私有端點只在 VNet 內可達;公開端點(即使 `publicNetworkAccess: Enabled` + 放行 IP)因私有端點存在而 **SSL EOF**(只服務 VNet 內流量)。→ 寫入動作必須**在 VNet 內**執行 = 容器啟動時跑。

### 機制
- 本機匯出 → `prisma/dev-snapshot.json`(gitignored;`az acr build` 仍會上傳未追蹤檔 → bake 進映像;`.dockerignore` 排除 `prisma/seed-data`,故快照放 `prisma/` 根層)。除可匯入表外另含 `_refs.regions`(id+code)供跨環境重映射查找。
- `prisma/import-dev-data.js`(只用 `pg`,欄位型別自 `information_schema` 推斷以正確綁定 jsonb/array):owner 使用者 FK 改指目標 admin、指向未匯入表的 FK 設 null、同批 FK(`company_id` / `document_format_id` / `data_template_id` 等)保留、`region_id` 以 **code 重映射**(regions 由 essential seed 以隨機 UUID upsert,跨環境 id 不同 → 用 `_refs.regions` 把本地 id→code→目標 id);冪等(以 **`field_definition_sets`** 有無資料為哨兵 + 每筆 `ON CONFLICT DO NOTHING`)。
- `scripts/docker-entrypoint.sh` 加 **gated 非致命**步驟:`RUN_DEV_DATA_IMPORT=true` 才跑(失敗只記 log、不擋啟動)。
- 涵蓋 **14 表**(PR #37,父表先序):
  - 原 5 業務表:companies / document_formats / mapping_rules / prompt_configs / exchange_rates。
  - **設定子系統 9 表(2026-06-16 補)**:field_definition_sets / data_templates / field_mapping_configs / field_mapping_rules / template_field_mappings / template_instances / template_instance_rows / pipeline_configs / reference_numbers。
  - 實測匯入(Azure):**17 / 4 / 1 / 12 / 3 / 4 / 6 / 1 / 1**(原 5 表 `0/N` = 已存在、冪等跳過)。
- **故意排除** `system_configs`:含機密(`integration.ai.api_key`、`security.jwt_secret`、SMTP 密碼)+ 環境相關值(AI endpoint),同步會把本地機密 bake 進映像並覆蓋 Azure 的正確設定。交易類(documents / extraction_results / field_extraction_feedbacks 等)亦不同步。
- ⚠️ **補同步既有資料的陷阱**:原本冪等哨兵是「companies 有資料就整批略過」;但 Azure 已有 companies → 會連新表都跳過。故哨兵改為新批次代表表 `field_definition_sets`。

### Schema 漂移(踩坑 + 解法)
首次部署新映像時 essential seed 崩潰:`column must_change_password does not exist`(P2022)。根因:**DB schema 是舊映像(`dev-3566a49`)建的、落後 main**(bootstrap 只「空庫才建表」、不遷移),新映像帶 main 較新的 Prisma client → 對不上。
- 解法:bootstrap 加 gated **`FORCE_SCHEMA_RESET=true`** → `DROP SCHEMA public CASCADE` 重建 → 重套當前映像 init.sql(完整最新 schema)。⚠️ **破壞性、DEV 限定、成功後務必設回 false**(否則下次重啟再清庫)。
- 🔴 **通案**:只要 DB schema 落後 main,部署任何新映像都會撞;根治為 **CHANGE-056**(migration baseline)。

### re2-wasm build 回歸(連帶修復)
FIX-069 在 `src/lib/safe-regex.ts` 頂層 `import { RE2 } from 're2-wasm'`,`next build` 收集頁面資料時載入 WASM 失敗 → 凡引用 safe-regex 的 route(如 `/api/rules/[id]/preview`)都讓 build 掛、**擋住所有映像重建**。改成 `import type` + 延遲 `require`(re2-wasm 為 CJS,維持同步)。⚠️ **任何容器重建都依賴此修復**。

### 部署順序
- **首次 + schema 落後**(一次到位):`FORCE_SCHEMA_RESET=true` + `RUN_DEV_DATA_IMPORT=true` → 切新映像 → 容器:reset schema → bootstrap 122 表 → essential seed → 匯入 → server → 驗證 health 200 → **兩旗標設回 false**。
- **僅補/重跑資料同步**(schema 已正確):只設 `RUN_DEV_DATA_IMPORT=true`(`FORCE_SCHEMA_RESET` 保持 false)→ 切新映像 → 驗證匯入 log → 設回 false。
- 一般「只改程式碼」重新部署:照 **§A 標準流程**,兩旗標都不用動。

### 容器重建注意(colorama 陷阱)
`az acr build` 的本機 log 串流會在 `npx prisma generate` 的 `✔` 字元上以 cp1252 崩潰(**不影響雲端建置**)。改用控制面:輪詢 `az acr task list-runs --registry <acr> --top 1`;取完整 log 用 SAS URL —— `az rest --method post .../registries/<acr>/runs/<id>/listLogSasUrl?api-version=2019-06-01-preview` → curl `logLink`。

---

## 12. 容器 exit 127:entrypoint 的 CRLF 行尾(2026-06-16,已根治)

### 症狀
切換到新映像後容器秒崩、**exit code 127**,平台 log 只見 `Site startup probe failed`;容器 stdout(`*_default_docker.log`)關鍵行:
```
/usr/local/bin/docker-entrypoint.sh: 11: exec: ./docker-entrypoint.sh: not found
```
且**完全看不到** `[entrypoint] Step 1/3...` → 代表失敗發生在腳本執行**之前**。

### 根因
`scripts/docker-entrypoint.sh` 在 Windows 工作樹被 `core.autocrlf=true` 轉成 **CRLF**(切換分支時 git 重寫差異檔觸發)。shebang 變 `#!/bin/sh\r`,Linux 核心找不到 `/bin/sh\r` → `exec: not found` → 127。`az acr build` 上傳的是**工作樹**(非 git index),所以 CRLF 被 bake 進映像。上一個映像在 LF 狀態建置才正常。`exec: <x>: not found` 是「shebang 直譯器找不到」的典型訊號,**不是檔案本身不存在**。

### 解法(根治,PR #37)
- 新增 **`.gitattributes`**:`*.sh text eol=lf` → shell script 不論 autocrlf 一律 LF。
- 把工作樹 `docker-entrypoint.sh` 轉回 LF(index 本就是 LF,轉完即乾淨)。
- 🔴 **任何在 Windows 重建映像前**:確認 `scripts/docker-entrypoint.sh` 無 CRLF(`node -e "console.log((require('fs').readFileSync('scripts/docker-entrypoint.sh').toString().match(/\r\n/g)||[]).length)"` 應為 0)。

---

## 13. 執行期 `re2.wasm` ENOENT:WASM 被 bundle 後找不到(2026-06-16,已根治)

### 症狀
容器**正常啟動**(health 200),但 log 在啟動預載(`unstable_preloadEntries`)/ 請求正則路由時洪水般刷:
```
Error: ENOENT: no such file or directory, open '/app/.next/server/chunks/re2.wasm'
failed to compile wasm module: RuntimeError: abort(...re2.wasm)
```
影響:**所有用到正則的功能**(mapping rule test / preview)執行期失敗。健康檢查不受影響,故易漏掉。

### 根因
`re2-wasm` 的 emscripten glue 用 `wasmBinaryFile = 're2.wasm'` + `locateFile()` = `readFileSync(__dirname + '/re2.wasm')` **動態載入**。被 webpack bundle 進 `.next/server/chunks/` 後 `__dirname` = chunks 目錄,而動態路徑的 `.wasm` webpack **不會追蹤/搬移** → 缺檔。FIX-069 引入 re2-wasm 後就潛伏(dev-datasync 系列映像皆有)。

### 解法(根治,PR #37)
- `next.config.ts`:`serverExternalPackages: ['re2-wasm']` → **不 bundle**,改從 node_modules `require`(`__dirname` 回到真實套件目錄 `node_modules/re2-wasm/build/wasm/` 找到 re2.wasm)。
- `Dockerfile`:`COPY --from=builder /app/node_modules/re2-wasm ./node_modules/re2-wasm`(比照 @prisma/* 等手動 copy;**Next standalone trace 不含動態讀取的 .wasm**,實測 standalone 沒帶 → 必須手動補)。
- 驗證:本地 build 後正則路由(`api/rules/test`、`api/rules/[id]/preview`)應為 `require('re2-wasm')` external、`.next/server/chunks` 無 re2.wasm;Azure 新容器啟動段 re2.wasm 錯誤數 = 0。

> 通則:**emscripten / WASM 套件用 `readFileSync(__dirname+...)` 載入的,一律標 `serverExternalPackages` 並在 Dockerfile 手動 copy 整個套件**——不要讓 webpack bundle 它。與 §11 的「re2-wasm **build** 回歸」是同一套件的兩個不同問題(build 期 vs 執行期),兩者都需處理。

---

## 14. Schema 漂移增量修補(`apply-schema-drift.js`,2026-06-23 新增)

### 問題
`bootstrap-db.js` 只在「空庫」才套 `init.sql`、**不遷移既有 DB**。當 `schema.prisma` 演進(加欄位 / enum / index)但 Azure DB 已有表時,既有 DB 拿不到新欄位 → 凡查該表的功能執行期 **P2022**(欄位不存在)。本機又無法直連私有 PG,任何 DDL 只能在容器啟動於 VNet 內跑。

### 解法(增量、非破壞性、保留資料)
- 新增 `prisma/apply-schema-drift.js`:只用 `pg`(同 bootstrap 風格),逐條跑**冪等 DDL**(enum 用 `DO ... EXCEPTION WHEN duplicate_object`、欄位用 `ADD COLUMN IF NOT EXISTS`、索引用 `CREATE INDEX IF NOT EXISTS`),單筆失敗不影響其他筆。
- `scripts/docker-entrypoint.sh`:在 **bootstrap 之後、essential seed 之前**加 gated 步驟(`RUN_SCHEMA_DRIFT_FIX=true` 才跑,非致命),確保 seed 動到的表先補好 schema。
- 維護:未來再有漂移 → 在 `MIGRATIONS` 陣列加一筆 `{ id, sql }`(依賴在前)。通案根治仍是 **CHANGE-056**(migration baseline);本 script 為過渡補丁。

### 首例:CHANGE-086(`reference_numbers.document_sub_type`)
2026-06-22 加 `documentSubType` nullable 欄位 + `ReferenceNumberSubType` enum + 索引;Azure DB(2026-06-16 `dev-datasync` 映像建)落後 → 以本機制補。部署時設 `RUN_SCHEMA_DRIFT_FIX=true`,log 應見三筆 `[schema-drift] OK ...` + `done — 3 applied, 0 failed`,驗證後設回 false。

### 🔴 期待值看「陣列總條目數」,不是「本次新增幾條」(2026-07-28 更新)

`MIGRATIONS` **每次執行都全跑**——DDL 全部冪等(`IF NOT EXISTS` / `DO ... EXCEPTION`),已存在的條目照樣回報 `OK` 並計入 `applied`(`apply-schema-drift.js:223-233` 無 skip 分支)。所以**期待數字 = 陣列總條目數**。上方 CHANGE-086 小節的「三筆 / `3 applied`」是 2026-06-22 當時的總數,**現已過時**,照它驗會誤判。

目前共 **22 條**:

| 來源 | 條數 | 內容 |
|------|------|------|
| CHANGE-086 | 3 | enum + `reference_numbers.document_sub_type` + 索引 |
| CHANGE-103 P2 | 3 | `companies.suspected_duplicate_of_id` + 索引 + 外鍵 |
| FIX-128 | 1 | `template_instance_rows.transform_diagnostics` |
| FIX-133 | 2 | 移除無效全表唯一索引 + 建 partial `NULLS NOT DISTINCT` 索引 |
| CHANGE-109 | 2 | `extraction_results.invoice_number` + 複合索引 |
| **Epic 23** | **10** | enum `LlmProviderType` + **三張新表** + `llm_models.routing_thresholds` + 3 組索引 + 2 外鍵 |
| CHANGE-113 | 1 | `data_templates.line_item_mode` |

**期待 log**:22 筆 `[schema-drift] OK ...` + `[schema-drift] done — 22 applied, 0 failed`。**總數對但 `failed > 0` 一樣是問題**——單筆失敗不中斷其餘,必須逐筆看 `ERR`。

> 2026-08-03 實測即為 22（本處原記 21，漏了 CHANGE-113 那條）。這正是上方警語說的情況——**加條目時沒回來更新總數，下一個部署者就會拿過時數字去驗**。

> 加新條目時記得同步更新這裡的總數,否則下一個部署者又會拿過時數字去驗。

### 🔴 Epic 23 三張表:Azure 完全沒有,只能靠本機制建

`llm_providers` / `llm_models` / `stage_model_assignments` 在 Azure DEV **根本不存在**,而且兩條既有路徑都不會建它們:

- `bootstrap-db.js:57-59` 對**非空 DB 直接 skip**
- 空庫才套的 `init.sql` 裡**也沒有這三張表**

因此凡觸及這三張表的查詢一律 **P2021**(表不存在)/ **P2022**。**部署帶 Epic 23 程式碼的映像時必須設 `RUN_SCHEMA_DRIFT_FIX=true`**,驗證後設回 false。DDL 以 `prisma migrate diff --from-empty --to-schema` 生成後逐字對齊,已在臨時空庫實跑驗證(10/10 OK、重跑冪等)。背景見 `docs/04-implementation/tech-specs/epic-23-multi-llm-provider/AI-HANDOFF.md` §6。

> **vs FORCE_SCHEMA_RESET**:後者 `DROP SCHEMA CASCADE` 會清空全部資料(含交易資料),僅在 schema 大改無法增量時才用;additive 變更(加欄位/enum/index)一律優先用本機制。

---

## 15. FIX-095 一次性 Stage 3 prompt 修正(`update-stage3-prompt.js`,2026-06-29 新增)

### 問題
Stage 3 由 `stage-3-extraction.service.ts` 的 `loadPromptConfigHierarchical()` 從 **DB** `prompt_configs`(FORMAT > COMPANY > GLOBAL)讀 prompt;Azure 的 GLOBAL 記錄來自 2026-06-15「本地 DB 同步匯入」、**重新部署/容器啟動不會更新它**(essential seed 不 seed PromptConfig)。FIX-095 的程式碼(SYSTEM 注入標準欄位 + Case 1 回填)隨映像生效,但舊版 `user_prompt_template` 仍要求 GPT 輸出 `{success,confidence,invoiceData}` 包裹格式,與 SYSTEM 的 `{fields,lineItems,overallConfidence}` 互斥 → 信心度非確定。

### 為何不能用 `scripts/fix-095-update-stage3-prompt.ts`
production `runner` 映像只 `COPY scripts/docker-entrypoint.sh`(其餘 `scripts/` 與 `tsx` 不在映像),且本機連不到私有 PG。故比照 `grant-global-admin.js` 改寫為純 `pg` 的 `prisma/update-stage3-prompt.js`(Dockerfile 整包 `COPY prisma/`,自動入映像)。

### 解法(增量、冪等、保留資料)
- `prisma/update-stage3-prompt.js`:參數化 `UPDATE prompt_configs SET user_prompt_template=$1, updated_at=now() WHERE prompt_type::text = any($2) AND scope::text='GLOBAL' AND user_prompt_template IS DISTINCT FROM $1`(目標 2 筆:`STAGE_3_FIELD_EXTRACTION` / `FIELD_EXTRACTION`)。冪等:已是新版則 0 筆。
- `scripts/docker-entrypoint.sh`:在 dev-data-import 後加 gated step(`RUN_STAGE3_PROMPT_FIX=true` 才跑,非致命)。
- ⚠️ `NEW_USER_PROMPT_TEMPLATE` 必須與 `scripts/fix-095-update-stage3-prompt.ts`、`prisma/seed-data/prompt-configs.ts` 逐字一致。

### 部署
設 `RUN_STAGE3_PROMPT_FIX=true` → 切新映像 → log 應見 `[entrypoint] (optional) applying FIX-095 Stage 3 prompt update` + `[stage3-prompt] done — N GLOBAL prompt(s) updated`(首次 N=2;已修則 0)→ **驗證後設回 false**(§A.5)。

---

## 16. 事故:新程式碼的新 env 沒同步到 Azure → 整批 `OCR_FAILED`(2026-07-14)

### 症狀
部署 FIX-108 後,上傳的 10 份文件全數失敗:7 份 `OCR_FAILED`、3 份 `REF_MATCH_FAILED`(後者為既有 ref match 設計行為,無關)。部署前同一批來源的 10 份文件全部 `MAPPING_COMPLETED`。

文件 `error_message`:
```
Stage 1 failed: GPT API 錯誤: 404 - {"error":{"code":"DeploymentNotFound",
"message":"The API deployment for this resource does not exist."}}
```
另有 1 份因重試風暴的次生效應報 `Transaction API error: Unable to start a transaction in the given time`。

### 根因
1. 線上映像是 `dev-azure-sync-20260710135241`(7/10),而 main 已累積 CHANGE-099/100/102(LLM 模型選擇管理)、CHANGE-103、Epic 23、FIX-106/107。這次部署把**數週累積的變更一次帶上線**,但部署者只檢查了「工作樹 vs `origin/main` 只差 FIX-108」。
2. CHANGE-100/102 改用新 env 解析部署名(`src/lib/constants/llm-models.ts` `resolveDeploymentName`):
   - 程式讀 `AZURE_OPENAI_GPT54_MINI_DEPLOYMENT_NAME` / `AZURE_OPENAI_GPT54_NANO_DEPLOYMENT_NAME`
   - Azure DEV 只有舊名 `AZURE_OPENAI_{MINI,NANO}_DEPLOYMENT_NAME`
   - 新 env 不存在 → `process.env[X] || defaultDeploymentName` **靜默 fallback** 到 `gpt-5.4-mini` / `gpt-5.4-nano`(無後綴)
   - 但 Azure 實際部署名帶後綴:`gpt-5.4-mini-aidocprocessing` / `gpt-5.4-nano-aidocprocessing` → **404**

> `.env.example` 早已列出這兩個 env,註解甚至預告了 `DeploymentNotFound`。地雷不是沒標示,是部署前沒去 diff 它。

### 解法(不需回滾映像)
```bash
az webapp config appsettings set -g RG-RAPOSCM-AIDocProcessing-DEV -n WebApp-RAPOSCM-AIDocProcessing-DEV \
  --settings AZURE_OPENAI_GPT54_MINI_DEPLOYMENT_NAME=gpt-5.4-mini-aidocprocessing \
             AZURE_OPENAI_GPT54_NANO_DEPLOYMENT_NAME=gpt-5.4-nano-aidocprocessing
```
(自動觸發重啟)。實際部署名以此查證,勿臆測:
```bash
az cognitiveservices account deployment list -g RG-RAPOSCM-AIDocProcessing-DEV \
  -n aiservices-raposcm-aidocprocessing-dev --query "[].{name:name,model:properties.model.name}" -o table
```
失敗的文件需**重新處理**才會恢復。

### 預防
→ 已寫入 **§A.0 前置**(部署前必查「線上映像 commit → 目標 commit」的 `.env.example` diff)。UAT/PRD 首次部署務必先跑這個檢查。

---

## 17. 2026-08-03 批次:模型切換 + 設定同步(`a1eba1e` → `52d2184`,27 個 commit)

### 🔴 `.env.example` diff 這次「查不出」新 env —— §A.0 的檢查失效了

§16 之後訂的預防措施是「部署前 diff `.env.example`」。這次跑該 diff **回傳 0 行**,但 CHANGE-115 **確實引入了新 env `AZURE_OPENAI_LUNA_DEPLOYMENT_NAME`** —— 它加在 `src/lib/constants/llm-models.ts` 的 `deploymentEnvVar`,卻沒同步寫進 `.env.example`。

**教訓**:`.env.example` 是**人工維護**的清單,不是自動生成的。它只在「有人記得更新」時才是權威。改模型白名單時,`deploymentEnvVar` 必須同步登記。

**補強做法**:除了 diff `.env.example`,再 diff `src/lib/constants/llm-models.ts`(或直接 grep 該區間新增的 `process.env.` 讀取):
```bash
git diff <線上commit>..<目標commit> -- src/lib/constants/llm-models.ts
git diff <線上commit>..<目標commit> | grep -n 'deploymentEnvVar\|process\.env\.'
```
(`.env.example` 已於本次補上該 env 的條目與後果說明。)

### 🔴 兩邊用的是不同的 Azure OpenAI 資源

CHANGE-115 在**本機**驗證時,`.env` 的 `AZURE_OPENAI_ENDPOINT` 指向 `chris-mj48nnoz-eastus2`(個人資源,**不在專案訂閱內**),該處有 `gpt-5.6-luna` 部署。而 Azure DEV 指向 `aiservices-raposcm-aidocprocessing-dev`,當時只有 5.4 系列兩個部署。

直接部署 = 三個 Stage 全部解析到不存在的部署名 → **整批 `OCR_FAILED`**(§16 重演)。

**處置**(2026-08-03,使用者拍板):在**專案自己的資源**建 luna 部署,而非把線上指到個人資源。
```bash
# 先確認該資源/區域提供該模型(勿臆測)
az cognitiveservices account list-models -g RG-RAPOSCM-AIDocProcessing-DEV \
  -n aiservices-raposcm-aidocprocessing-dev --query "[?contains(name,'luna')]" -o table
# 沿用既有部署的規格與命名慣例(GlobalStandard / 250 / <model>-aidocprocessing)
az cognitiveservices account deployment create -g RG-RAPOSCM-AIDocProcessing-DEV \
  -n aiservices-raposcm-aidocprocessing-dev --deployment-name gpt-5.6-luna-aidocprocessing \
  --model-name gpt-5.6-luna --model-version 2026-07-09 --model-format OpenAI \
  --sku-name GlobalStandard --sku-capacity 250
az webapp config appsettings set -g RG-RAPOSCM-AIDocProcessing-DEV -n WebApp-RAPOSCM-AIDocProcessing-DEV \
  --settings AZURE_OPENAI_LUNA_DEPLOYMENT_NAME=gpt-5.6-luna-aidocprocessing
```

### 設定同步(`RUN_CONFIG_SYNC_20260803`)

`prisma/sync-config-20260803.js`,三模式 `inspect|dryrun|write`,五個步驟各自獨立:

| # | 來源 | 目標表 |
|---|------|--------|
| 1 | FIX-154 | `prompt_configs` GLOBAL — 移除 description 幣別註記 |
| 2 | FIX-156 | `prompt_configs` DHL COMPANY — 補 subtotal 定義 |
| 3 | FIX-158 一 | `template_field_mappings` — RIL `handling_at_origin` 改雙 key FORMULA |
| 4 | FIX-158 二 | `field_definition_sets` — CEVA LTD 補 4 欄(純 additive) |
| 5 | CHANGE-115 | `llm_providers` / `llm_models` / `stage_model_assignments` — 切 luna |

**前置**:步驟 5 需 Epic 23 三張表存在 → 同批次設 `RUN_SCHEMA_DRIFT_FIX=true`(見 §14)。表不存在時該步驟自行跳過,不影響其餘四步。

**🔴 不含 FIX-150**(VAT 獨立成欄、NEHK bl_fee alias 收窄)。CLAUDE.md §不可逆資料操作紀律要求改 mapping 前後各跑一次 `scripts/check-orphan-charge-keys.js` + `scripts/snapshot-template-values.js` 對帳,而 **runner 映像不含 `scripts/`** —— 安全網無法在容器內執行。且 FIX-150 本身仍是 🚧 進行中。要送 Azure 需先把那兩支對帳工具也移植進 `prisma/`。

> 這是個通案限制,不只影響 FIX-150:**凡「規範要求先跑對帳才能改」的設定,在移植對帳工具之前都不該送進 Azure**。

> ✅ **2026-08-06 更新:上述通案限制已解除** —— 兩支對帳工具已移植進 `prisma/`(見 §20),
> 判準與本機版驗證過逐項一致(合計漏 38946.27、多算 19656.11,兩版數字相同)。
> FIX-150 未送 Azure 的**另一個**理由(本身仍 🚧 進行中)仍然成立,不因本次解除而改變。

---

## 18. 2026-08-06:先診斷再決定寫入(`RUN_CONFIG_DIAGNOSE_20260806`)

### 這次部署的實質是「查證」,不是「上線新功能」

線上映像 `dev-sync20260803b`(≈ `31e5123`)到 `938ec7a` 累積 13 個 commit,但照 §A.0 diff 之後發現:

```bash
git diff --stat 31e5123..origin/main -- src/ prisma/ Dockerfile package.json next.config.ts scripts/docker-entrypoint.sh
# → 只有 src/**/CLAUDE.md ×10 + prisma/CLAUDE.md,零 .ts/.tsx/schema/entrypoint 變更
```

**重建映像是 no-op**。真正沒到 Azure 的是 FIX-159~169 期間的**資料層設定**,那些不隨映像走。
所以這次先建一支唯讀診斷腳本上線查現況,再決定要不要寫入。

### `prisma/diagnose-config-20260806.js`(唯讀)

六個區塊,任一失敗不影響其餘:基準計數 / 通案實體歸屬對帳 / Toll 專項 / RICOH 專項 /
欄位定義集現況 / 孤兒 key 對帳。**不寫入任何資料**,故不套用三段式 gated 流程,可安全重跑。

放 `prisma/` 而非 `scripts/` 的理由同 §15:runner 映像不含 `scripts/` 與 tsx。

### 🔴 Kudu `/api/command` 跑不到 app 容器

想省事直接用 Kudu 查 DB 是行不通的 —— Kudu 在 sidecar,看不到 app 容器的檔案系統:

```
An error occurred trying to start process '/opt/Kudu/Scripts/starter.sh'
with working directory '/app'. No such file or directory
```

§8 用它跑 `nslookup` / `curl` 可以(那是 Kudu 容器自帶的),但 `node` + `node_modules/pg` 不行。
**任何要讀 DB 的診斷,都只能做成 `prisma/*.js` + gated 旗標,在容器啟動時跑。**

### 查證結果(節錄,完整見 deployment-records/2026-08-06-dev-diagnose.md)

| 項目 | Azure DEV 現況 |
|---|---|
| Toll 跨國誤歸(FIX-159 型) | 🔴 **有,35 份**。單一 `Toll Global Forwarder Limited`、`nameVariants` 為 0 |
| Azure 獨有的印法 | 🔴 `拓領環球貨運(香港)有限公司` / `拓環球貨運(香港)有限公司` 共 6 份 —— **本機沒有**,移植不能照抄本機 variants |
| FIX-161 的 CEVA 缺陷 | 🔴 存在:`awb_fee` / `pick_up_at_origin` / `x_ray` / `cfs` / `gate_charge` |
| RICOH 重複公司 | ✅ 無(Azure 只有 1 筆 ACTIVE) |
| 資料量 | Azure `documents` **901** vs 本機 645 —— **Azure 比本機多**,不是單向覆蓋的關係 |

### 🔴 `_ref_number` 是孤兒 key 對帳的通案誤報

50 筆 mapping 幾乎每筆都報 `_ref_number` 未定義 —— 它是系統欄位不是費用 key。
下次要拿區塊 6 當判準,得先排除底線前綴的系統欄位,否則真正的缺陷會被淹沒。

### 本機串流 exit 1 ≠ 建置失敗(§11 再次應驗)

`az acr build` 的背景執行回報 `exit code 1`,但控制面顯示 `ck1v` 仍 `Running`,最後 `Succeeded`。
**判定建置成敗一律看 `az acr task show-run --run-id`,不要看本機 exit code。**

---

## 19. 2026-08-06:FIX-159 移植 —— 容器內執行不可逆寫入的範式(`RUN_TOLL_SPLIT_20260806`)

完整記錄:[`deployment-records/2026-08-06-dev-toll-split.md`](./deployment-records/2026-08-06-dev-toll-split.md)

這是第一次在 Azure 上跑**完整三段式 gated 寫入**,以下三點可作為後續同類操作的範式。

### 🔴 前置快照要印進 log,因為容器沒有可保留的檔案系統

本機腳本把快照寫成檔(`.snapshots/*.json`);容器內做不到 —— 重啟即消失。
改為在寫入前把變更前的完整值印進 stdout,以 `--- SNAPSHOT BEGIN/END ---` 包住,
**Log Analytics 的 `AppServiceConsoleLogs` 就是唯一還原依據**。

⚠️ 這個依據**有保留期限**。涉及大量筆數或關鍵資料時,write 完成後應立即把該段 log 匯出另存。

### 🔴 三個模式靠 appsetting 切換,不需要重建映像

映像建一次即可,`inspect` → `dryrun` → `write` 只改 appsetting + 重啟(改 appsetting 會自動觸發重啟)。
每一步都要**讀 log 確認再往下**,不要連續改旗標。

判斷新程序是否已起來:`/api/health` 的 `uptime` 歸零(舊程序常是數天)。

### 🔴 目標環境的資料不會等於本機,清單類設定必須現地實測

本次 Azure 有兩種本機從未出現的中英混排公司印法。若照抄本機的 `nameVariants`,
那 6 份文件仍會誤歸 —— **看起來成功、實際漏掉**。

通則:凡「列舉字串」類的設定(nameVariants / aliases / 欄位 key 清單),
移植前必須先用唯讀診斷把**目標環境的實際值**撈出來,以它為準,不要以本機清單為準。

### 執行結果摘要

| 動作 | 數量閘 |
|---|---:|
| `INSERT` 香港公司(6 項 variants) | 1 |
| `UPDATE` 泰國記錄補 2 項 variants(樂觀鎖) | 1 |
| `UPDATE documents.company_id` | 35 |
| `UPDATE extraction_results.company_id` | 35 |

事後對帳:泰國 51 筆/1 種原文、香港 35 筆/3 種原文,**殘餘 0**,51+35=86 對得上分母。

### ⚠️ 拆分不等於完成

新實體目前沒有欄位定義集、沒有 mapping。補齊要寫 `template_field_mappings`。

> 撰寫當下受 §17 的通案限制擋著;該限制已於同日解除(見 §20),對帳工具現已在映像內
> **並已在 Azure 實跑驗證**(全庫 607 份、漏 586,302.84,見 §20)。

🔴 **截至 2026-08-07 仍未補齊**:實測該公司(Azure `6df1b84d-b527-4318-b8a7-152a0a64bf5e`)
**0 組欄位定義集、0 條模板映射**(分母:全庫 30 組 / 50 條)。追蹤於 FIX-164。
注意本機拆分出的香港記錄是另一個 id(`1ce60466-…`)—— 兩環境各自拆分,**不可互抄 id**。

---

## 20. 2026-08-06:對帳工具移植進 `prisma/` —— §17 通案限制解除

### 為什麼原本卡住

§不可逆資料操作紀律要求「改 mapping 前後各跑一次對帳」,工具是
`scripts/check-orphan-charge-keys.js` + `scripts/snapshot-template-values.js`。
但 runner 映像只 COPY `prisma/` 與 `scripts/docker-entrypoint.sh` —— 安全網無法在容器內執行。
於是 §17 立了通案限制:**凡需要對帳才能改的設定,都不該送進 Azure**。

原腳本註解建議「上傳至 Kudu /home 再以 node 執行」。**那條路行不通**(見 §18):
Kudu 在 sidecar,`/app` 不存在,拿不到 app 容器的 `node_modules/pg`。

### 移植後的兩支

| 檔案 | 旗標 | 性質 |
|---|---|---|
| `prisma/check-orphan-charge-keys.js` | `RUN_ORPHAN_CHECK=inspect` | 唯讀,費用落地對帳 |
| `prisma/snapshot-template-values.js` | `RUN_TEMPLATE_SNAPSHOT=capture` | 唯讀,模板欄位值快照 |

搭配設定:`RECONCILE_COMPANY`(公司過濾)、`RECONCILE_BASELINE`(前次基線 JSON)、
`RECONCILE_DOCS=true`(逐份列出)。

### 🔴 before/after 怎麼跨執行保存

`WEBSITES_ENABLE_APP_SERVICE_STORAGE=false` → 容器 `/home` **不持久**,寫檔重啟即消失。
而且 before → after 中間夾著「重新匹配模板實例」,跨越了容器生命週期。兩支的解法不同:

**費用對帳**(findings 小,塞得進 appsetting)—— 前後比對在容器內完成:
```
1. 改動前  RUN_ORPHAN_CHECK=inspect          → log 印出 BASELINE JSON
2. 把該段 JSON 設進 RECONCILE_BASELINE
3. 改動 + 重新匹配 → 再跑一次                → 容器內直接輸出前後比對結論
```

**模板快照**(量大)—— capture 在容器、diff 在本機:
```
1. 改動前  RUN_TEMPLATE_SNAPSHOT=capture     → 從 log 取 JSON 存成 before.json
2. 改動 + 重新匹配 → 再跑一次                 → 存成 after.json
3. 本機 node scripts/snapshot-template-values.js diff before.json after.json
```

### 🔴 兩個防假綠燈的設計

**分母為 0 時明說**。掃到 0 份文件不會回報「沒有漏接」,而是明確講「沒有可對帳的對象」——
空迴圈輸出綠燈是最難發現的失敗(綠燈不會被追查)。

**快照超過上限時拒絕輸出,不截斷**。截斷的 JSON 解析不出來,而「解析失敗」比「沒有安全網」
更危險 —— 會誤以為對過帳。超過 512 KB 即拒絕並列出涵蓋的公司,要求加 `RECONCILE_COMPANY`。
同理,`RECONCILE_BASELINE` 解析失敗時會**明講「本次沒有前後比對」**,不靜默略過。

### 等價性驗證(本機同一個 DB,兩版對跑)

| 版本 | 合計 |
|---|---|
| `scripts/`(原版) | 漏 38946.27、多算 19656.11 |
| `prisma/`(新版) | 漏 38946.27、多算 19656.11 |

逐家公司數字亦相同。另驗證容器版輸出的 JSON 可被本機 `diff` 直接讀取(82 列全對上、零誤判)。

### ✅ Azure 首跑結果(2026-08-06)

`RUN_ORPHAN_CHECK=inspect` 已在 Azure 容器內實跑,輸出正常,可當安全網使用。

| 項目 | 值 |
|---|---|
| 參與對帳文件 | 607 份(分母有印出,非空迴圈) |
| 全庫漏接 | 586,302.84 |
| 全庫多算 | 8,014.58 |
| CEVA 漏接 | 189,073.28 |

此為 FIX-161 移植的 baseline,已存成 `azure-baseline.json`。

🔴 Azure 的數字比本機大一個量級(本機漏 38,946.27),因為 **Azure 資料比本機多**
(documents 901 vs 645)。不要拿本機數字當 Azure 的預期值。

---

## 21. 2026-08-06:FIX-161 移植 —— 「腳本跑完」不等於「修好了」

`prisma/fix-161-ceva-export-20260806.js`,旗標 `RUN_FIX161_CEVA_20260806=inspect|dryrun|write`,
映像 `dev-fix161-20260806`(ACR run `ck1y`)。改 CEVA export mapping 的 2 條 `sourceField`
(`cfs` → `destination_cfs_charges`、`gate_charge` → `destination_gate_fee`)。

流程與 §19 同範式(三段式 + 五項措施),不重複。以下只記這次**新學到的**。

### 🔴 改設定不回溯 —— 驗收在腳本之外

write 成功、事後對帳「殘餘 0」,看起來像修好了。**沒有。**
mapping 改了,既有模板實例列不會重算,目標欄位仍是空的。完整鏈是:

```
dryrun → write → 重新匹配模板實例 → RUN_ORPHAN_CHECK 對帳
                  ^^^^^^^^^^^^^^^^ 這步不是腳本能做的（需 API）
```

腳本的「殘餘 0」只證明**規則寫對了**,不證明**值取到了**。
FIX-161 本機驗收之所以可信,是因為它做到了「重建 instance 後 `cfs_charge = 200`」——
那才是值,不是規則。

### 🔴 COMPLETED 的模板實例改不了 —— 要重跑就建新的

本次重新匹配時實測(Azure DEV):

```
DELETE 列    → 409  「實例狀態為 COMPLETED,不可刪除行」
POST execute → 400  INVALID_INSTANCE_STATUS
```

`src/types/template-instance.ts:358-364` 的白名單:可刪只有 `DRAFT`,可寫只有 `DRAFT`/`ERROR`。
而同檔 `STATUS_TRANSITIONS`(:346-352)中 `COMPLETED → ['EXPORTED']` —— **單向,沒有回頭路**,
且 `changeStatus` 嚴格檢查(`template-instance.service.ts:1063-1069`)。
所以「退回 DRAFT → 改 → 再改回」這條路在應用層是關閉的,只有直接下 SQL 才繞得過。

**不要繞。** 實例是一次性快照 / 交付物(終點 `EXPORTED` 會輸出 Excel),設計上要重跑就建新的。
對帳腳本的 `DISTINCT ON (doc.id, ti.data_template_id) ORDER BY tir.created_at DESC` 正是配合這個
模式寫的 —— **新快照自動取代舊快照參與計算,不會重複計**。前提:新實例必須用**同一個**
`dataTemplate`,用別的模板才會兩邊都算。

正確做法:建新實例(DRAFT,同模板)→ `POST /api/v1/template-matching/execute` 帶
`options.companyId` → 驗證後刪除驗證用實例。舊實例全程不動,失敗了刪掉新的即可,零殘留。

⚠️ 別帶 `options.rowKeyField` 指向共用編號的欄位(如 `_ref_number`)—— `upsertRow` 以
`(instanceId, rowKey)` 為唯一鍵,共用編號的多份文件會被**合併成同一列**,列數對不上就無從逐列比對。
不帶則每份文件各生成 `auto_<時間戳>` key,48 份 → 48 列,與 before 一對一。

### 🔴 驗收要看「值」,而「值」可能證明修復無效果

本次最終結果:規則修對了,但目標欄位 **48/48 列仍取不到值**。
新列的 `transformDiagnostics` 直接給出原因 —— `destination_cfs_charges` / `destination_gate_fee`
在提取結果中根本不存在,即**這批發票沒有這兩項費用**(母體未覆蓋),不是映射缺陷。

所以對帳數字不會下降。若當初只看「腳本殘餘 0」就結案,會誤以為修好了並預期金額下降;
若只看「對帳沒降」就回滾,又會誤刪一個正確的修復。
**兩者都要看,而且要看 `transformDiagnostics` 才能分辨是哪一種。**

> 這也再次印證 §樣本 ≠ 母體:本機驗出 200 / 80 是因為那批樣本**有一份**收了這兩項費用;
> Azure 這 48 份沒有,不代表規則錯。

### 🔴 grep log 必須帶腳本前綴

第一次找 write 結果時用 `mode=write` 搜尋,抓到行 1836 就當成結果 ——
那其實是**同日稍早 toll-split 的 write**。多支 gated 腳本共用同一份 log、訊息格式相同,
只差前綴。改用 `[fix161-ceva] connected . mode=write` 才找到真正的行 3208。

若沒察覺,就會拿別支腳本的 `COMMIT` 當作這次的成功證據。
**同日跑多支腳本時,log 匹配一律帶 `[腳本前綴]`。**

### 🔴 清單類設定不可照抄本機

腳本 write 前逐項驗證 **Azure 自己的**欄位定義集,不符即中止。這不是多餘的謹慎:
同批移植中,Azure 的 Toll 誤歸是 **35 份**,且有兩種本機不存在的中英混排印法
(`拓領環球貨運(香港)有限公司`、`拓環球貨運(香港)有限公司`)。
另有**兩家 CEVA**,只有 `...LTD` 那家要改,`...LIMITED(CEVA Logistics)` 的寫法本來就對。

### 回滾依據

前置快照 `fix161-before.json` 存於**本機**。Azure `/home` 不持久,log 是唯一還原依據且會過期——
**跑完 write 當下就要把快照從 log 撈出來存到本機**,不能等。

---

## 22. 2026-08-07:診斷腳本的價值在於**推翻**假設(`RUN_ORPHAN_CAUSE`)

`prisma/diagnose-orphan-cause-20260807.js`,旗標 `RUN_ORPHAN_CAUSE=inspect`(唯讀),
映像 `dev-orphancause-20260807`(ACR run `ck20`)。回答「漏接的錢**為什麼**沒落地」。

### 🔴 本機與 Azure 的成因分布是相反的

| | 本機 CEVA | Azure CEVA | Azure 全庫 |
|---|---:|---:|---:|
| 漏接總額 | 8,866.71 | 217,464.03 | 614,693.59 |
| 無規則引用(FIX-160 形態) | **100%** | 37.4% | **13.7%** |
| 有規則但未落地(FIX-150 形態) | 0% | 58.0% | **95.6%** |

同一支腳本、同一套判準,三個環境三種結論。
**若照本機結論在 Azure「補 mapping」,補完錢還是進不去** —— 那些 key 本來就有規則,
問題是四個來源(`express_worldwide_nondoc` / `ocean_freight` / `freight_charges` /
`fuel_surcharge`,共 489,675.60)搶同一個 `freight` 欄位。

這是 §樣本 ≠ 母體 在**環境之間**的版本:本機測出來的成因不能外推到 Azure。

### 判準要和既有工具逐字對齊,否則數字無法互相解釋

本腳本的 A / B 定義與 `check-orphan-charge-keys.js` 逐字相同 ——
本機全庫跑出 `38946.27`,與該腳本實測值完全吻合。這個吻合本身就是正確性驗證:
若兩支對「什麼算漏接」的定義有一絲差異,總額就對不上,後續的成因拆解也就無從取信。

### 分類要標明哪一類可靠、哪一類是上限

- **無規則引用**:二元事實,不受 FORMULA 影響 → **可靠下限**
- **有規則未落地**:FORMULA 把多個 key 加總,個別金額本就不會單獨出現在欄位裡,
  會被誤判為未落地 → **高估上限**

Azure 全庫的未歸類殘額是 **−56,894.55**(負數),即分類總和超過實際漏接 —— 證實有高估。
腳本主動印出殘額並在非零時警告,而不是讓分類看起來剛好加總為 100%。

### 跨時點的數字不可直接相比

| | 08-06 baseline | 08-07 實測 |
|---|---:|---:|
| 全庫參與對帳 | 607 份 | 628 份 |
| 全庫漏接 | 586,302.84 | 614,693.59 |

期間多了 21 份文件進入實例,**分母變了**。不可據此宣稱「漏接增加了」。

### 讀 log 的兩件事

同一份 log 裡有全庫與 CEVA 兩次執行(行 311 與行 461),訊息格式完全相同,
只差 `connected` 那行末尾的 `. company~CEVA`。**必須認明該標記**,否則會把上一次的結果當成這次的。

本環境**沒有診斷設定,Log Analytics 這條路不存在**;`az webapp log download` 也會因
SCM 主機名在本機解析不到而失敗。可行途徑是 Kudu + 公用 DNS:

```bash
IP=$(nslookup <scm-host> 8.8.8.8 | awk '/^Address: /{a=$2} END{print a}')
TOKEN=$(az account get-access-token --resource https://management.azure.com --query accessToken -o tsv)
curl -s --resolve "<scm-host>:443:$IP" -H "Authorization: Bearer $TOKEN" "https://<scm-host>/api/logs/docker"
# 取回應中 machineName 以 _default 結尾那筆的 href，即容器 stdout
```

---

*維護者: AI 助手 + 開發團隊*
*最後更新: 2026-08-07*
