# CHANGE-101: 批量建立公司 Template Field Mapping（Logistics Cost Inbound/Outbound）

> **日期**: 2026-07-09
> **狀態**: ✅ 已完成（2026-07-09 部署 Azure DEV，寫入 18 筆）
> **優先級**: Medium
> **類型**: Feature（資料建置 + 一次性維護腳本）
> **影響範圍**: `prisma/`（新增 gated 腳本）、`scripts/docker-entrypoint.sh`、Azure DEV DB `template_field_mappings` 表

---

## 變更背景

SCM 團隊提供了一份公司格式 mapping 對照表（`docs/Doc Sample/SCM_AI_processing_platform_company_format_mapping_table_20260709_v1.xlsx`），描述 **38 間 forwarder** 的出口/入口費用欄位如何對應到兩個標準 data template：

- `Logistics Cost - Outbound Template (Full List)`（出口，Excel 欄 `RCEX`/`RHEX`）
- `Logistics Cost - Inbound Template (Full List)`（入口，Excel 欄 `RCIM`/`RHIM`）

目前這些 `TemplateFieldMapping`（COMPANY scope）需逐間、逐欄位手動於後台建立，費時且易錯。本 CHANGE 以資料驅動方式批量產生，寫入 **Azure DEV** 環境。

> 本任務源自使用者 2026-07-09 交辦。因 Azure DEV 為私有端點、本機無法直連私有 PG，且使用者要求「Azure 只手動部署」，故採 **gated 容器腳本**（比照 FIX-095 A3 / `prisma/update-stage3-prompt.js`）在容器內執行。

## 變更內容

### 1. Excel → Mapping 生成邏輯

- 每列：`公司` + `情境` + `Field Definition 名`(sourceField) + 4 個方向欄的 target 值。
- 依方向分組：`RCEX`/`RHEX`(export) → Outbound Template；`RCIM`/`RHIM`(import) → Inbound Template。
- 每間公司 × 有資料的方向 → 一筆 **COMPANY-scope** `TemplateFieldMapping`（預估共約 **45 筆**）。
- 每筆內含多條 rule：
  - **1 對 1（283 條）** → `transformType: DIRECT`。
  - **多對一（53 組）**：多個 sourceField 指向同一 targetField → 合成一條加總 rule（`FORMULA` 或 `AGGREGATE`，機制待診斷後定案，見 Open Questions）。

### 2. targetField 正規化（label → name）

`template-matching-engine.service.ts` 以 template field 的 **`name`（snake_case）** 與 rule 的 `targetField` 比對；Excel 的 target 值是**顯示名**（對應 `label`）。腳本須將每個 Excel target 值在 template `fields` 中以 label（大小寫/空白不敏感）匹配，取對應 field 的 `name` 作 `targetField`；對不上的一律列入報告、**不寫入**。

### 3. gated 腳本三模式

單一 `prisma/*.js`，以環境變數切換，映像只需重建一次：

| 模式 | 行為 |
|------|------|
| `inspect` | 唯讀：印出兩個 template 的 id + 完整 `fields`(name/label)、38 間公司比對結果、一份提取結果 `sourceFields` key 樣本。**不寫入** |
| `dryrun` | 完整生成 mapping + 印出將 upsert 的內容與所有對不上（target/公司）清單。**不寫入** |
| `write` | 冪等 upsert 至 `template_field_mappings`（依 `unique_template_mapping` 唯一鍵） |

## 技術設計

### 修改範圍

| 文件 | 變更內容 |
|------|----------|
| `prisma/seed-template-field-mappings.js` | 🆕 gated 腳本（pg，三模式）。內嵌由 Excel 生成的 mapping 資料 |
| `scripts/docker-entrypoint.sh` | 🔧 新增 gated block（`RUN_TEMPLATE_MAPPING_SEED=inspect\|dryrun\|write`，非致命） |
| Azure DEV DB `template_field_mappings` | 🔧 資料寫入（約 45 筆 COMPANY-scope 記錄） |

### 資料流（執行期，供驗證 targetField/sourceField 正確性）

```
template-matching-engine.applyMapping(sourceFields):
  sourceValue = sourceFields[rule.sourceField]        // sourceField = 提取結果 key
  result[rule.targetField] = transform(sourceValue)   // targetField = template field .name
  required = templateFields.filter(isRequired).map(f => f.name)  // 與 targetField 比對
```

### 資料庫影響

- **不改 Prisma schema**。僅新增 `template_field_mappings` 資料列。
- 冪等：以 `@@unique([dataTemplateId, scope, companyId, documentFormatId])` 為衝突鍵 upsert；重跑不重複建立。

## 設計決策

1. **gated 容器腳本（非 API）** — Azure DEV 私有 PG 本機不可達；使用者要求只手動部署。腳本在容器內可連私有 PG。比照既有 `prisma/update-stage3-prompt.js` 模式（僅依賴 `pg`，不需 Prisma CLI/tsx）。
2. **三模式合一 + 先 inspect** — template 的實際 `fields` 與 sourceFields key 格式只在 Azure，本地無從得知；先唯讀診斷取得真實結構，避免對 targetField/sourceField 做錯誤假設。
3. **targetField 用 `name` 非 `label`** — 依 `template-matching-engine` 實際比對邏輯確認。
4. **對不上不寫入** — 任何 target 值/公司名對不上一律報告後略過，不猜測、不寫入髒資料。

## 影響範圍評估

### 向後兼容性

- 純新增資料，不改 schema、不改既有記錄；COMPANY scope 只在該公司文件套用，對其他公司零影響。
- `write` 冪等，可安全重跑。

### 風險評估

| 風險 | 緩解 |
|------|------|
| targetField 對不上 template 欄位 → 該費用無法映射 | inspect + dryrun 先列出所有對不上清單，人工確認後才 write |
| 公司重複/變體（Redline↔Redlines 等）對到錯 companyId | 診斷階段列出每間公司的比對候選，逐一確認 |
| 多對一 FORMULA 變數名含空格/括號不合法 | 診斷 sourceFields key 格式後，決定改用 AGGREGATE 或正規化 key |
| 誤寫入生產 | 預設 flag 不啟用；先 inspect/dryrun；write 冪等且可回滾 |

### 回滾計劃

- 記錄本次 write 建立/更新的 `template_field_mappings.id`；如需回滾，對該批 id 執行 `is_active=false`（軟刪）或 `DELETE`（硬刪）。
- 因採 upsert，回滾不影響其他既有 mapping。

## Open Questions（待 inspect 診斷後定案）

| # | 問題 | 定案依據 |
|---|------|----------|
| OQ-1 | `sourceField` 應填的實際 key 格式（field definition 名？展平 `li_{classifiedAs}_total`？） | inspect 印出的 `sourceFields` 樣本 |
| OQ-2 | 多對一用 `FORMULA` 還是 `AGGREGATE` | 視 OQ-1 key 是否含空格/括號而定 |
| OQ-3 | 公司重複/變體（Redline↔Redlines、Wang Kay↔Wangkay、Worldwide↔Worldwide Logistics）對應哪個 companyId | inspect 公司比對結果 |
| OQ-4 | 兩個 template 的 target 值大小寫/空白正規化規則 | inspect 印出的 template `fields` |

## 驗收標準

| # | 驗收項目 | 驗收標準 | 優先級 |
|---|----------|----------|--------|
| 1 | inspect 診斷 | 印出兩 template 的 id+fields、38 公司比對、sourceFields key 樣本，零寫入 | High |
| 2 | dryrun | 列出所有將 upsert 的 mapping + 完整對不上清單，零寫入 | High |
| 3 | targetField 正確 | 每條 rule 的 targetField 皆等於某 template field 的 `name` | High |
| 4 | 多對一處理 | 53 組多對一皆以單一 rule（FORMULA/AGGREGATE）表達，無重複 targetField 互相覆蓋 | High |
| 5 | write 冪等 | 重跑不新增重複記錄（依唯一鍵 upsert） | High |
| 6 | 公司對應 | 每筆 mapping 的 companyId 對到正確公司（重複/變體已人工確認） | High |

## 測試場景

| # | 場景 | 測試步驟 | 預期結果 |
|---|------|----------|----------|
| 1 | inspect 模式 | 部署後設 `RUN_TEMPLATE_MAPPING_SEED=inspect` 重啟，看容器 log | 印出診斷、DB 無變化 |
| 2 | dryrun 模式 | 改 flag=dryrun 重啟，看 log | 印出將寫入內容+對不上清單、DB 無變化 |
| 3 | write 模式 | 改 flag=write 重啟，看 log | template_field_mappings 新增約 45 筆；再跑一次 0 新增 |
| 4 | 端到端驗證 | 對某公司文件跑 template instance 匹配 | 費用正確落入對應 template 欄位 |

## 實施計劃（分階段）

1. **Phase 1 — 診斷腳本**：寫 inspect 模式 → 使用者部署跑 → 取得 template fields/公司比對/key 樣本。→ verify：log 齊全、零寫入。
2. **Phase 2 — 生成邏輯**：據 Phase 1 結果定案 OQ-1~4，完成 dryrun/write 生成邏輯（內嵌 336 rule 資料）。→ verify：本地 `node --check` + dryrun log 正確。
3. **Phase 3 — 寫入**：使用者切 write 執行 → 核對筆數 → 端到端匹配驗證。→ verify：驗收標準 3/5/6。

---

## Implementation Notes

**實作結果（2026-07-09，Azure DEV）：**

- **寫入 18 筆** COMPANY-scope mapping（14 間精確匹配公司，139 rules）：14 Outbound + 4 Inbound（DHL/NIPPON/RIL/TOLL 有 import）。
- 交付：`prisma/seed-template-field-mappings.js`（inspect/dryrun/write 三模式）+ `prisma/template-mappings-data.json`（生成資料）+ entrypoint gate `RUN_TEMPLATE_MAPPING_SEED`。
- 部署：手動 `az acr build` × 4（inspect ×3 修正 + phase2）→ dryrun（18 筆驗證、skip 0、零寫入）→ write（18 筆 commit、無失敗）→ flag 清 false。

**OQ 定案：**
- OQ-1：`sourceField` = Excel field def 名的 snake_case（取自 `ExtractionResult.fieldMappings` key），**非** `li_{classifiedAs}`。依既有 CEVA Full List mapping 範本確認。
- OQ-2：多對一用 **FORMULA** `{a}+{b}`（snake_case 變數無空格、合法），非 AGGREGATE。
- OQ-3：公司對應用 code+name 精確匹配；只做 15 精確（扣 CEVA 實做 14），模糊/變體/CEVA/Azure 無 皆跳過。
- OQ-4：`targetField` = 兩個 Full List template field 的 `name`；Excel target 以 label ci 匹配（去括號 fuzzy 救 `LSS (HKD)`）；大小寫變體合併同一 targetField。

**本批跳過（未納入）：**
- **2 個 EBS**（RIL/Yamato export）：Outbound Full List 無 EBS 欄位。
- **CEVA**：已有人工建的 Full List mapping（綁 `CEVA_LOGISTICS_HK` / id 7448b7c5），不重複。
- **模糊/變體 6 間**：Constant International、Wang Kay、Cargo Link、Redlines、Wangkay、Worldwide Logistics（使用者選只做精確）。
- **Azure 無此公司 ~16 間**：Sanco, BSI, Dongnam, Famous, Fartrans, Hua Feng, Kintetsu, Lam, MOL, Panda, Sharp, Unibest, Vinflair, WGL, Kargosmart, A2S Logistics, Profreight。

**後續（backlog）**：跳過的公司待 Azure 補建/正名後可重跑 `write`（腳本冪等）；EBS 待 Outbound Full List template 加欄位。
