# 2026-08-06 Azure DEV 部署 — 設定落差唯讀診斷

> **環境**: Azure DEV（App Service for Containers）
> **映像**: `acrscmdocprocessingdev.azurecr.io/ai-document-extraction:dev-diag20260806-20260806`
> **ACR run**: `ck1v` → `Succeeded`
> **前一個映像**: `dev-sync20260803b-20260803164326`（≈ `31e5123`）
> **目標 commit**: `938ec7a`
> **旗標**: `RUN_CONFIG_DIAGNOSE_20260806=inspect`（唯讀，已於驗證後清空）
> **寫入**: **無** —— 本次未對資料庫做任何寫入

---

## 為什麼這次部署的實質是「查證」

依 runbook §A.0 先 diff 線上 commit 到目標 commit：

```
31e5123..938ec7a  --  src/ prisma/ Dockerfile package.json next.config.ts docker-entrypoint.sh
→ src/**/CLAUDE.md ×10、prisma/CLAUDE.md ×1
→ 零 .ts / .tsx / schema / entrypoint 變更
```

13 個 commit 全是 FIX-159~169 的**文件**與 `scripts/` 下的 tmp 腳本（後者不入 runner 映像）。
**重建映像不會改變任何執行期行為。**

真正沒到 Azure 的是那段期間的**資料層設定**（公司拆分、欄位定義集、mapping 修正），
它們不隨映像走。在決定要不要寫入之前，必須先知道目標環境的實際現況 —— 而不是拿本機狀態推論。

---

## §A.0 前置檢查

| 檢查 | 結果 |
|---|---|
| `.env.example` diff 的新 env | `AZURE_OPENAI_LUNA_DEPLOYMENT_NAME` **已設** = `gpt-5.6-luna-aidocprocessing` ✅ |
| `src/lib/constants/llm-models.ts` diff（§17 的補強檢查） | 無變更 ✅ |
| 該區間新增的 `process.env.` 讀取 | 僅診斷腳本自身 ✅ |
| `prisma/apply-schema-drift.js` 新條目 | 無 → 不需 `RUN_SCHEMA_DRIFT_FIX` ✅ |
| 一次性旗標現況 | 布林 7 個全 `false`；非布林 4 個皆已清空 ✅ |
| `scripts/docker-entrypoint.sh` CRLF（§12） | `0`，shebang `#!/bin/sh` ✅ |
| 部署前健康 | `200`，`database: connected`，uptime 2.85 天 ✅ |

---

## 執行

```bash
# 1. 建置（本機串流 exit 1 是 §11 的 cp1252 已知現象，控制面 ck1v = Succeeded）
az acr build --registry acrscmdocprocessingdev \
  --image ai-document-extraction:dev-diag20260806-20260806 --file Dockerfile .

# 2. 設旗標（唯讀）
az webapp config appsettings set ... --settings RUN_CONFIG_DIAGNOSE_20260806=inspect

# 3. 切映像 + 重啟
az webapp config container set ... --container-image-name ...:dev-diag20260806-20260806
az webapp restart ...

# 4. 讀 log（AAD bearer + Kudu vfs，見 §8；本機 DNS 解析不到 SCM，需 curl --resolve）

# 5. 清旗標（🔴 非布林，必須 delete）
az webapp config appsettings delete ... --setting-names RUN_CONFIG_DIAGNOSE_20260806
```

新程序 uptime 34 秒、`database: connected`，未進入 §4 的重啟退避。

---

## 診斷結果

### 基準計數（本機 vs Azure DEV）

| 項目 | 本機 | Azure DEV |
|---|---:|---:|
| companies | 55 | 53 |
| 　status = PENDING | 2 | **0** |
| documents | 645 | **901** |
| extraction_results | 623 | **883** |
| 　stage_1 response 可解析 | 570 | 825 |
| field_definition_sets | 24 | **30** |
| template_field_mappings | 52 | 50 |
| template_instance_rows | 928 | 864 |

🔴 **Azure 的文件比本機多 256 份。** 「把本地同步到 Azure」不是單向覆蓋 ——
Azure 有本機沒有的資料，任何同步腳本都必須是**增量、冪等、按名稱錨定**，不能整批取代。

### 🔴 Toll 跨國誤歸：確認存在，35 份

```
Toll Global Forwarder Limited     ← 唯一一筆，nameVariants = 0
      51  Toll Global Forwarding (Thailand) Limited
      29  Toll Global Forwarding (Hong Kong) Ltd
       4  Toll Global Forwarding (Hong Kong) Ltd 拓領環球貨運(香港)有限公司
       2  Toll Global Forwarding (Hong Kong) Ltd 拓環球貨運(香港)有限公司
```

FIX-159 原記「該環境是否有同型誤歸尚未查證」—— 已查證，**有**，規模與本機當時（34 份）相當。

🔴 **移植時不能照抄本機的 `nameVariants`**：後兩種中英混排印法（共 6 份）本機從未出現，
本機的四項香港 variants 涵蓋不到，直接沿用會讓這 6 份仍落到 Step 2b 而繼續誤歸。

### FIX-161 的 CEVA 缺陷：存在

```
CEVA LOGISTICS (HONG KONG) LTD  /  Outbound  /  引用 11  未定義 6
      awb_fee、pick_up_at_origin、x_ray、cfs、gate_charge（+ _ref_number）
```

另有兩組**本機 FIX 未涵蓋**的：

| 公司 / 模板 | 未定義 key |
|---|---|
| Nippon Express (HK) Co., Ltd. / Outbound | `t_h_c`、`vat_7`、`surrender_bl` |
| Nippon Express Logistics / Inbound + Outbound | `other_charge` |

### RICOH：Azure 無重複公司

只有 1 筆 `RICOH INTERNATIONAL LOGISTICS (HK) LTD.`（`ACTIVE`，2 筆 mapping，49 份文件），
無 `PENDING`、無 `suspectedDuplicateOf`。本機那筆 `PENDING` 是本機才有的。

> FIX-162（RICOH 重複欄位定義合併）在 Azure 是否已套用，**本次無法判定** ——
> Azure 的 RICOH 欄位定義集為 48 欄，但本次未取本機對應數字比對。要判定需另跑一次比對。

### 通案實體歸屬掃描

| 環境 | 底下有多種原文的公司 | 屬地區不同（真誤歸） |
|---|---:|---|
| 本機 | 5 | Nippon Express Logistics（泰國記錄底下 3 份香港原文） |
| Azure DEV | 9 | Toll（35 份）；CEVA 底下另有 `(China)` / `(Singapore)` / `(Thailand)` 各 1 份 —— **未判定**，樣本太少 |

其餘為大小寫飄移或 OCR 誤讀（`RICOH`→`RUIH`/`RITCH`/`RAPID`；`CEVA`→`Cevna`/`CEVΑ` 希臘字母）。

---

## 🔴 兩個踩到的坑

### Kudu `/api/command` 跑不到 app 容器

想直接用 Kudu 查 DB 省掉建映像 —— 行不通：

```
An error occurred trying to start process '/opt/Kudu/Scripts/starter.sh'
with working directory '/app'. No such file or directory
```

Kudu 在 sidecar，看不到 app 容器的檔案系統。§8 用它跑 `nslookup` / `curl` 可以（Kudu 容器自帶），
但 `node` + `node_modules/pg` 不行。**任何要讀 DB 的診斷都必須做成 `prisma/*.js` + gated 旗標。**

### `_ref_number` 是孤兒 key 對帳的通案誤報

50 筆 mapping 幾乎每筆都報它未定義 —— 它是系統欄位不是費用 key。
下次拿區塊 6 當判準前，要先排除底線前綴的系統欄位，否則真缺陷會被雜訊淹沒。

---

## 未處理（需拍板）

| # | 項目 | 擋門 |
|---|---|---|
| 1 | 移植 FIX-159（拆 Toll 香港 + 補 6 份中英混排 variants + 重新歸屬 35 份） | 無對帳工具依賴，**可做** |
| 2 | 修 FIX-161 的 CEVA 6 個 key + 新發現的 Nippon 4 個 key | ⚠️ 改 mapping，受 §17 通案限制 |
| 3 | 補 Toll HK 欄位定義集與 mapping | ⚠️ 同上 |
| 4 | 移植 `check-orphan-charge-keys.js` + `snapshot-template-values.js` 進 `prisma/` | 解鎖 2 與 3 |
| 5 | CEVA 的 `(China)`/`(Singapore)`/`(Thailand)` 各 1 份 | 需調原件人工判讀 |
| 6 | FIX-162 在 Azure 的套用狀態 | 需另跑本機／Azure 欄位定義集比對 |

> §17 的通案限制：**凡「規範要求先跑對帳才能改」的設定，在移植對帳工具之前都不該送進 Azure。**

---

## 相關

- [dev-deployment-runbook.md §18](../dev-deployment-runbook.md)
- [FIX-159](../../../../claudedocs/4-changes/bug-fixes/FIX-159-toll-cross-border-entities-merged-by-normalization.md) — §跨環境狀態已依本次結果更新
- [FIX-161](../../../../claudedocs/4-changes/bug-fixes/FIX-161-mapping-references-undefined-company-fields.md)
- `prisma/diagnose-config-20260806.js` — 本記錄所有數字的產生腳本（唯讀，可重跑覆核）
