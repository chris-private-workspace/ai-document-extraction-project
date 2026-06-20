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

### A.1 建置映像(`az acr build`)
```bash
TAG="dev-$(date +%Y%m%d%H%M%S)"   # 用有意義前綴,如 dev-datasync4-...
az acr build --registry acrscmdocprocessingdev \
  --image ai-document-extraction:$TAG --file Dockerfile .
```
- ⚠️ 本機 log 串流會在 `npx prisma generate` 的 `✔` 上以 **cp1252 崩潰**(本機程序看似失敗,**雲端建置照常進行**)。**不要**據此判定失敗。
- 改看控制面確認:`az acr task list-runs --registry acrscmdocprocessingdev --top 1 -o table`(等 `Succeeded`);完整 log 用 SAS URL(見 §11 末)。
- 確認 tag 已就緒:`az acr repository show-tags --name acrscmdocprocessingdev --repository ai-document-extraction --orderby time_desc --top 3 -o tsv`。

### A.2 (選用)一次性資料同步 / schema 重設旗標
- 只在需要灌資料時設 `RUN_DEV_DATA_IMPORT=true`(見 §11);只在 schema 落後 main 時設 `FORCE_SCHEMA_RESET=true`(見 §11,**破壞性**)。
- **PRD 這兩個旗標永遠 false**(見 governance §3)。

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

### A.5 收尾(🔴 一次性旗標設回 false)
```bash
az webapp config appsettings set -g RG-RAPOSCM-AIDocProcessing-DEV -n WebApp-RAPOSCM-AIDocProcessing-DEV \
  --settings RUN_DEV_DATA_IMPORT=false FORCE_SCHEMA_RESET=false
```
確認:`az webapp config appsettings list ... --query "[?name=='RUN_DEV_DATA_IMPORT'||name=='FORCE_SCHEMA_RESET']" -o table`。

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

*維護者: AI 助手 + 開發團隊*
*最後更新: 2026-06-16*
