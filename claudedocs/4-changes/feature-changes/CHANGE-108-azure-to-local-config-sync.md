# CHANGE-108: Azure DEV → 本地開發環境 配置與測試資料單向同步

> **日期**: 2026-07-26
> **狀態**: ✅ 已完成（2026-07-26，Phase 1-3 全部執行完畢；Blob 原始檔同步未做，見「後續項」）
> **優先級**: High
> **類型**: Developer Tooling
> **影響範圍**: `prisma/`（匯出腳本）、`scripts/`（備份 + 匯入腳本）；**不改任何應用程式碼**

---

## 變更背景

用戶正在 Azure DEV 環境實測，回報的問題無法在本地重現 —— 因為兩邊的公司、文件格式、Prompt、欄位定義集、資料模板、模板欄位映射全都不一致。

**不一致並非漂移，而是累積一個多月的單向修補。** `scripts/docker-entrypoint.sh` 的 gated flag 清單本身就是證據：

| Gated Flag | 只改了 Azure |
|---|---|
| `RUN_DEV_DATA_IMPORT` | 2026-06-15 一次性把當時本地 14 張表匯入 Azure（此後兩邊各自演化） |
| `RUN_STAGE3_PROMPT_FIX` | FIX-095 Stage 3 prompt 改為消除信心度非確定性的新版 |
| `RUN_FIX110_ALIAS_BACKFILL` | FIX-110 的 9 條針對性費用 aliases |
| `RUN_FIX111_DEACTIVATE_FIELD_EXTRACTION` | FIX-111 停用多餘的 GLOBAL FIELD_EXTRACTION |
| `RUN_TEMPLATE_MAPPING_SEED` | CHANGE-101 批量建立 18 筆 / 139 條 mapping rules |
| （Kudu 直接執行） | FIX-105 CEVA 合併、FIX-113 orphan backfill、FIX-133 資料修正 |

實測差距：

| 表 | 本地 | Azure DEV |
|---|---|---|
| `template_field_mappings` | 4 | **36**（FIX-133 查證） |
| `companies` | 35 | 38+ |
| `field_definition_sets` | 18（aliases 多為空） | 18 + FIX-110 的 9 條 aliases |
| `prompt_configs` | 14（Stage 3 為舊版） | 14（Stage 3 為 FIX-095 新版） |
| `prompt_variables` | 0 | 待匯出確認 |

沒有這份同步，任何 Azure 端問題的本地重現都是猜測。

---

## 變更內容

建立一條 **Azure DEV → 本地** 的單向同步管道，三個獨立腳本，分三階段執行。

**方向嚴格單向**：本工具永不寫入 Azure。Azure 端只有 `SELECT`。

### 為什麼要新寫，不能直接反用 `import-dev-data.js`

`prisma/import-dev-data.js`（2026-06-15，本地 → Azure）已解決跨環境同步最麻煩的部分，這些邏輯**原封不動複用**：

- 14 張表的父子匯入順序
- `created_by` / `created_by_id` / `updated_by` → 改指目標 DB 的 admin
- 指向未匯入表的 FK（`default_template_id` / `first_seen_document_id` / `merged_into_id` / `forwarder_id` / `suggestion_id` / `inverse_of_id`）→ 設 null
- `region_id` → 以 `code` 重映射（跨環境 UUID 不同）
- 型別安全：以 `information_schema` 取欄位型別，jsonb 字串化、ARRAY 傳 JS 陣列

但有三處語意必須改，故不直接沿用：

1. **匯出端不存在** —— 該檔只有匯入端，且吃的是手動產生的 `prisma/dev-snapshot.json`
2. **冪等守衛相反** —— 該檔「`field_definition_sets` 已有資料就整批略過」；本地已有 18 筆，直接沿用會全程跳過
3. **寫入語意相反** —— 該檔是 `ON CONFLICT DO NOTHING`（合併）；本次需**整表取代**（見下方決策）

---

## 技術設計

### 修改範圍

| 文件 | 變更內容 |
|---|---|
| `prisma/export-azure-config-snapshot.js` | 🆕 在 Azure 容器內執行的唯讀匯出；gzip + base64 輸出到 stdout |
| `scripts/local-backup-config-tables.ts` | 🆕 匯入前備份本地現況（含連帶影響表）到 JSON |
| `scripts/local-import-azure-snapshot.ts` | 🆕 本地匯入；預設 dry-run，`--apply` 才寫入 |
| `scripts/local-diff-azure-snapshot.ts` | 🆕 逐表差異報告（Phase 1 唯讀產出） |

**不需要部署，也不需要 entrypoint gated flag。** FIX-133 已驗證可用 Kudu 把腳本 base64 寫進容器 `/tmp` 執行；本次為唯讀匯出，風險低於 FIX-133。

`Dockerfile:164` 整包 `COPY prisma/`，故若日後要常態化，把匯出腳本留在 `prisma/` 下次部署即內建。

### 同步表清單（15 張）

依 `import-dev-data.js` 的 `PLAN` 順序（父表先），加 `prompt_variables`：

```
companies → document_formats → mapping_rules → prompt_configs → prompt_variables
→ exchange_rates → field_definition_sets → data_templates → field_mapping_configs
→ field_mapping_rules → template_field_mappings → template_instances
→ template_instance_rows → pipeline_configs → reference_numbers
```

### 🔴 明確排除的表

| 表 | 排除理由 |
|---|---|
| `system_configs`（本地 37 筆） | **含環境特定值**。Azure 的模型部署名帶 `-aidocprocessing` 後綴（見 memory `feedback_deploy_check_image_lag_and_new_env`）、endpoint、儲存設定等，同步過來會污染本地環境設定，可能導致本地完全跑不動 |
| `users` / `roles` / `user_roles` | 跨環境帳號體系不同；所有 owner 欄位改指本地 admin |
| `regions` / `cities` | 由 essential seed 以 `code` upsert，跨環境 UUID 不同 → 用作重映射基準，不同步 |
| `audit_logs` / `security_logs` / 各類 metrics | 非配置，且量大無診斷價值 |

### FK 拓撲風險（已實測查證）

以 `information_schema` 查出 41 條指向配置表的 FK。整表取代前必須處理：

| 子表 | FK | 刪除規則 | 本地筆數 | 處理 |
|---|---|---|---|---|
| `file_transaction_parties` | `company_id` | **RESTRICT** | **0** | ✅ 不會擋刪 |
| `document_formats` | `company_id` | **RESTRICT** | 13 | ✅ 在同步清單內，逆序先刪 |
| `template_instances` | `data_template_id` | **RESTRICT** | 13 | ✅ 在同步清單內，逆序先刪 |
| `field_extraction_feedbacks` | `field_definition_set_id` | **CASCADE** | **408** | 🔴 **會被連帶刪除** → 必須備份 + 匯入後還原 |
| `documents` | `company_id` | SET NULL | 86 | ⚠️ 會失去公司關聯 → 匯入後依公司名稱重映射 |
| `extraction_results` | `company_id` | SET NULL | 80 | ⚠️ 同上 |
| `rollback_logs` / `rule_applications` / `rule_versions` / `rule_test_tasks` | `rule_id` | CASCADE | 全部 0 | ✅ 無損失 |
| `correction_patterns` / `field_correction_history` / `historical_files` / `rule_suggestions` / `rule_change_requests` | `company_id` | SET NULL | 全部 0 | ✅ 無影響 |

### 執行階段

#### Phase 1 — 匯出 + 差異報告（唯讀，零風險）

1. Kudu 執行 `export-azure-config-snapshot.js`
2. 一併帶回：15 張配置表全量 + `_refs`（regions `id→code`）+ **Azure documents metadata 清單**（id / 檔名 / 公司 / 狀態 / 建立日 / 是否有 template instance）
3. 本地跑 `local-diff-azure-snapshot.ts` → 逐表差異（Azure 有 / 本地有 / 兩邊都有但內容不同）
4. **不寫入本地任何資料**

documents 清單的用途：讓用戶從真實清單挑出「出問題的那幾份」，避免 Phase 3 憑猜測匯出。

#### Phase 2 — 配置表整表取代

1. `local-backup-config-tables.ts` → 本地現況存 JSON（含 `field_extraction_feedbacks` 408 筆）
2. `local-import-azure-snapshot.ts --apply`：
   - 單一交易
   - 依 FK 逆序 `DELETE`（子表先）
   - 依 `PLAN` 正序 `INSERT`，**保留 Azure 的 id**
   - FK 重映射：owner 欄位 → 本地 admin；`region_id` → 依 code
   - 還原 `field_extraction_feedbacks`（`field_definition_set_id` 重映射；對不上則捨棄並列出）
   - 本地舊 documents / extraction_results 的 `company_id` 依**公司名稱**重映射；對不上保持 null 並報告
3. 事後驗證：逐表筆數與 Azure 一致、FK 完整性、`npx prisma validate`

**保留 Azure id 是刻意的** —— 這樣 Azure 的錯誤訊息、日誌、UI 網址裡的 id 在本地能直接對上，是這份同步最主要的診斷價值。

#### Phase 3 — 指定文件的處理記錄 + Blob 檔案

1. 用戶從 Phase 1 清單指定 document ids
2. 匯出這些文件的 `documents` / `ocr_results` / `extraction_results` / `processing_queue` / `document_processing_stages`
3. Blob 原始檔：從 Azure Blob 下載 → 上傳本地 Azurite（**需先確認 SP 有 Storage 讀取權限**；memory `project_azure_dev_environment` 記載 SP 僅 Contributor，`project_azure_blob_public_access_disabled` 記載容器為 private）

---

## 設計決策

1. **整表取代而非合併** — 用戶決策（2026-07-26）。合併語意會讓同一家公司在兩邊 id 不同時變成兩筆並存，直接觸發本專案已知的公司重複問題（memory `project_company_dup_breaks_company_mapping`）→ COMPANY 級 mapping 對不上。取代則保證逐筆一致。

2. **保留 Azure id** — 見 Phase 2。代價是本地既有配置的 id 全部改變，但本地配置本來就要被取代。

3. **排除 `system_configs`** — 見上方排除表。這是本設計最重要的安全邊界：若一併同步，本地會拿到 Azure 的模型部署名與 endpoint，導致本地提取全數失敗。

4. **匯出端唯讀** — Azure 是用戶正在實測的環境，本工具不得有任何寫入路徑。腳本內不含 `INSERT` / `UPDATE` / `DELETE` / DDL。

5. **預設 dry-run** — 匯入腳本無 `--apply` 時只印計畫。遵循 FIX-133 的 gated 腳本模式。

6. **備份先行** — 不可逆資料操作前必先快照（memory `feedback_snapshot_before_irreversible_data_op`）。備份為完整 JSON，可逐表還原。

---

## 向後兼容性

- **不改應用程式碼**，不改 Prisma schema，不加依賴 → 對產品行為零影響
- 本地資料被取代，但備份 JSON 可完整還原
- Azure DEV 完全不受影響（唯讀）

---

## 驗收標準

| # | 驗收項目 | 驗收標準 | 優先級 |
|---|---|---|---|
| 1 | Azure 端唯讀 | 匯出腳本不含任何寫入 SQL；執行前後 Azure 各表筆數不變 | **High** |
| 2 | 匯出完整性 | 15 張表全量帶回，jsonb / ARRAY 欄位無失真 | High |
| 3 | 備份可還原 | 備份 JSON 能完整還原本地 Phase 2 前狀態（含 408 筆 feedbacks） | **High** |
| 4 | 筆數一致 | 匯入後本地 15 張表筆數與 Azure 逐表相符 | High |
| 5 | id 一致 | `template_field_mappings` 等表的 id 與 Azure 相同（可用 FIX-133 已知的 `cmrwu7bqb0` / `cmrin1af90` 驗證） | High |
| 6 | FK 完整 | 匯入後無 orphan FK；`prisma validate` 通過 | High |
| 7 | 環境設定未被污染 | `system_configs` 未被改動；本地提取仍能正常執行 | **High** |
| 8 | 舊文件關聯 | 本地 86 份舊文件的 `company_id` 依名稱重映射結果有明確報告 | Medium |
| 9 | 差異報告可讀 | Phase 1 報告能看出每張表的三類差異 | Medium |
| 10 | 問題可重現 | Phase 3 後，用戶回報的問題能在本地重現 | **High** |

---

## 測試場景

| # | 場景 | 測試步驟 | 預期結果 |
|---|---|---|---|
| 1 | Azure 唯讀驗證 | 匯出前後各查一次 15 表筆數 | 完全相同 |
| 2 | dry-run 不寫入 | 不帶 `--apply` 執行匯入 | 只印計畫，本地筆數不變 |
| 3 | 備份還原 | Phase 2 後用備份還原 | 回到 35 公司 / 4 mapping / 408 feedbacks |
| 4 | 交易回滾 | 匯入中途注入錯誤 | 全部回滾，本地維持原狀 |
| 5 | id 對照 | 查 `cmrwu7bqb0` | 本地查得到，`mappings` 內容與 Azure 相同 |
| 6 | 環境隔離 | 匯入後跑一次本地文件提取 | 正常完成（未被 Azure 模型名污染） |
| 7 | 費用 aliases | 查 CEVA field definition set | 含 FIX-110 的 9 條 aliases |
| 8 | Stage 3 prompt | 查 GLOBAL Stage 3 prompt_config | 為 FIX-095 新版 |

---

## 實作結果（2026-07-26）

### 實際產出的腳本

| 檔案 | 角色 |
|---|---|
| `prisma/export-azure-config-snapshot.js` | Azure 端唯讀匯出 15 張配置表（Phase 1） |
| `prisma/export-azure-documents.js` | Azure 端唯讀匯出文件處理鏈（Phase 3） |
| `scripts/local-diff-azure-snapshot.js` | 逐表差異報告（唯讀） |
| `scripts/local-backup-config-tables.js` | 本地備份（可獨立跑，亦被匯入腳本 require） |
| `scripts/local-import-azure-snapshot.js` | 配置嚴格鏡像匯入（Phase 2） |
| `scripts/local-import-azure-documents.js` | 文件記錄匯入（Phase 3） |

### 執行通道（已驗證）

Kudu `/api/command` + `curl --resolve <scm>:443:<主站公開IP>` + ARM bearer token。
腳本以 base64 寫入容器 `/tmp`、`npm install pg@8.7.3`（Kudu sidecar 為 **node v14.19.2**，與 app 容器不同）後執行，
完成即清理 `/tmp`。**不需重新部署，不需 entrypoint gated flag。**

> ⚠️ Kudu `/api/command` 對 command 字串做空白切分，**單引號不被 shell 處理**；
> 必須用 `bash -c "…"`（雙引號）形式才有完整 shell 解析。

### Phase 1 — 匯出與差異（唯讀）

Azure 資料量：JSON 4.86 MB → gzip 409.6 KB → base64 546.1 KB（單次 stdout 即可，無需分塊）。
probe 與 export 兩次讀取筆數完全一致 → **驗收 #1（Azure 唯讀）達成**。

差異報告揭露 Azure 端就地修補的完整痕跡：

| 表 | 同 id 異內容 | 對應修補 |
|---|---|---|
| `prompt_configs` | 4 筆 | FIX-095（Stage 1/3 prompt + version）、FIX-111（`Field Extraction - Global Default` 停用） |
| `field_definition_sets` | 5 筆 | FIX-110（`fields` 內 aliases） |
| `companies` | 5 筆 | CHANGE-103（`name_variants` 學習成果）、`default_template_id` |
| `template_field_mappings` | 3 筆 | FIX-133（`is_active`） |
| `pipeline_configs` | 1 筆 | FX 設定 |

### Phase 2 — 配置嚴格鏡像（已 COMMIT）

15 張表逐表筆數與 Azure 一致：

| 表 | 本地(前) | → 現在 = Azure |
|---|---|---|
| `template_field_mappings` | 4 | **36** |
| `template_instances` | 13 | **118** |
| `template_instance_rows` | 48 | **522** |
| `reference_numbers` | 4013 | **9050** |
| `companies` | 35 | **45** |
| `document_formats` | 13 | **24** |
| `field_definition_sets` | 18 | **23** |
| `data_templates` | 5 | **8** |
| `prompt_configs` | 14 | **12** |
| `exchange_rates` | 48 | **16** |
| `pipeline_configs` | 2 | **1** |
| `mapping_rules` / `field_mapping_configs` / `field_mapping_rules` / `prompt_variables` | 31 / 1 / 12 / 0 | 不變 |

驗收檢查全部通過：

- ✅ id 一致性抽樣 3/3（保留 Azure id → Azure 的日誌/網址 id 在本地可直接對上）
- ✅ **合併鏈 8/8** `merged_into_id` 指向存在的公司 + 1 筆 `suspected_duplicate_of_id`
- ✅ FIX-111 `is_active=false`、FIX-095 Stage 3 v3、FIX-110 10/23 含 aliases、FIX-133 27/36 啟用
- ✅ `field_extraction_feedbacks` 還原 346/408（62 筆因指向已移除的本地獨有欄位集而無法還原）
- ✅ 本地舊文件公司關聯重映射：`documents` 83/86、`extraction_results` 80/80

### Phase 3 — 異常文件記錄（已 COMMIT）

63 筆（40 `REF_MATCH_FAILED` + 13 `OCR_PROCESSING` + 6 `UPLOADED` + 4 `OCR_FAILED`）
+ 44 筆 `extraction_results`。`documents` 86 → 149。
`ocr_results` / `processing_queues` / `document_processing_stages` 在 Azure 對這批文件皆無資料。

**用到的 `city_code` 僅 HKG**，本地已有 → `city_code`（NOT NULL + RESTRICT）風險未實現，無需補建城市。

#### 🔴 診斷發現：40 筆 REF_MATCH_FAILED 全為同一錯誤

```
REF_MATCH_ABORT: Reference number matching enabled but no matches found
```

且這批文件 `company_id` **全為 null** —— 在公司識別完成前就被 ref match 阻斷。
與 memory `project_refmatch_scope_limitation` 記載的「ref match 啟用即阻塞」一致。
檔名樣本：`NEX_RHIM0080_G8925.pdf`、`DHL_RCIM0268_07412.pdf`、`CEVA_RCIM250326_17866.PDF`。

> 這是用戶回報問題的最可能來源，但**根因調查不屬本 CHANGE 範圍**（H3）→ 應另立 FIX。

### 關鍵技術修正（相對 `import-dev-data.js`）

`import-dev-data.js` 把 `merged_into_id` 直接設 null＝**放棄合併鏈**。反向匯入不能沿用：
Azure 的 8 家 MERGED 公司都在同批內，鏈必須保留。實作為 **defer 機制** ——
插入時設 null、全表插完後回填，並在回填前檢查目標存在性（避免 FK violation 中止交易）。

適用欄位：`companies.merged_into_id` / `suspected_duplicate_of_id` / `default_template_id`、
`document_formats.default_template_id`、`exchange_rates.inverse_of_id`。
（前兩者為 self-reference，後三者指向 PLAN 中順序在後的表。）

### 測試結果

| 檢查 | 結果 |
|---|---|
| `npm run type-check` | ✅ exit 0 |
| `npm run lint` | ✅ exit 0 |
| Phase 2 dry-run → apply | ✅ 兩次皆通過，筆數驗證 15/15 |
| Phase 3 dry-run → apply | ✅ 兩次皆通過 |
| Azure 端筆數前後對照 | ✅ 未改動 |

---

## 後續項

| # | 項目 | 狀態 |
|---|---|---|
| 1 | **40 筆 `REF_MATCH_ABORT` 根因調查** | 🚧 應另立 FIX（超出本 CHANGE scope） |
| 2 | Blob 原始檔同步到本地 Azurite | 🚧 未做。`documents.blob_name` 指向 Azure 私有容器，本地文件預覽/下載會失效（提取資料完整、診斷不受影響）。SP 僅 Contributor，需先確認 Storage 讀取權限 |
| 3 | 本地缺 `CHINA` region 與 13 個 Azure 城市 | ⚠️ 本批資料未用到，未補。若日後匯入其他城市的文件會被 RESTRICT 擋下 |
| 4 | 本地獨有的 CEVA 表格式配置（`cmrsmg8mb` 格式 + 2 prompt + 欄位集） | ⚠️ 依用戶決策「嚴格鏡像」已移除，存於備份 JSON。若要正式上線需反方向推到 Azure |

---

*文件建立日期: 2026-07-26*
*最後更新: 2026-07-26*
