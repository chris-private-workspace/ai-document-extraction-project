# FIX-133: `unique_template_mapping` 唯一約束從未生效，需盤點既有重複配置

> **建立日期**: 2026-07-25
> **發現方式**: CHANGE-107 實作期間的 Playwright 實測（本地）
> **影響頁面/功能**: Template Field Mapping 資料完整性（`template_field_mappings` 表）；間接影響 `resolveMapping` 的映射解析結果
> **優先級**: 中 → **高**（2026-07-25 盤點後上調：Azure DEV 存在 1 組同時啟用的重複，造成 6 個 targetField 的解析結果非確定性）
> **狀態**: ✅ 已完成（2026-07-25）—— BUG-1（約束不生效）以部分唯一索引 `NULLS NOT DISTINCT WHERE is_active` 修復並在本地與 Azure DEV 驗證生效；BUG-2（存量重複）已盤點並修正；BUG-3（語意）已判定為資料污染。5 筆指向 MERGED 公司的死配置移交 [FIX-125](FIX-125-company-merge-orphans-document-formats.md)

---

## 問題描述

`prisma/schema.prisma:3104` 的唯一約束：

```prisma
@@unique([dataTemplateId, scope, companyId, documentFormatId], name: "unique_template_mapping")
```

因 PostgreSQL 預設的 `NULLS DISTINCT` 語意而**對任何範圍都不生效**。

2026-07-25 實測：複製一筆 COMPANY 範圍配置、把四個身分欄位設成與來源完全相同後儲存，API 回 **201 Created**，資料庫中出現兩筆身分完全相同的記錄。

| # | 問題 | 嚴重度 | 影響 |
|---|------|--------|------|
| BUG-1 | 唯一約束對所有範圍皆不生效，相同四元組可無聲重複建立 | 中 | 資料完整性；`resolveMapping` 面對重複時的結果取決於 `priority` 與遍歷順序 |
| BUG-2 | 正式環境（Azure DEV）可能已存在存量重複，尚未盤點 | 待確認 | 若有，映射解析可能取到非預期的那一筆 |
| BUG-3 | 「同範圍多筆配置」的語意未定義 —— 是刻意分層還是污染，文件與程式碼互相矛盾 | 中 | 決定 BUG-2 該清理或保留，也決定 CHANGE-107 的擋阻是否過嚴 |

---

## 重現步驟

1. 於 `/admin/template-field-mappings` 挑一筆 COMPANY 範圍配置，點「複製」
2. 在複製表單把 data template、範圍、公司設成與來源記錄**完全相同**
3. 按「建立」
4. 觀察現象：
   - **CHANGE-107 之前**：回 201，列表出現兩筆身分完全相同的記錄
   - **CHANGE-107 之後**：回 409（來自新加的應用層檢查，**不是** DB 約束）

> 註：步驟 4 的差異證明擋阻完全來自應用層。DB 約束在兩種情況下都沒有作用。

---

## 根本原因

SQL 標準規定 `NULL != NULL`，唯一索引因此把「含 NULL 的列」視為互不相同（PostgreSQL 預設 `NULLS DISTINCT`；`NULLS NOT DISTINCT` 為 PG 15 才引入的選項，本專案未使用）。

`TemplateFieldMapping` 的 `companyId` 與 `documentFormatId` 皆為 nullable，而**每一種範圍都必然使其中至少一欄為 NULL**：

| 範圍 | companyId | documentFormatId | 含 NULL 數 | 約束是否生效 |
|------|-----------|------------------|-----------|--------------|
| GLOBAL | NULL | NULL | 2 | ❌ |
| COMPANY | 有值 | NULL | 1 | ❌ |
| FORMAT | NULL | 有值 | 1 | ❌ |

所以這條約束**沒有任何一種情況會觸發**，是一條實務上從未發揮作用的約束。

### 既有的獨立佐證（時間更早）

`prisma/seed-template-field-mappings.js:276-277`（CHANGE-101，2026-07-09）的註解已載明：

```js
// 冪等：先刪同 (template, company, COMPANY, null format) 舊列，再插
// （null document_format_id 會使 @@unique 失效，故不用 on conflict）
```

即這個知識早在 2026-07-09 就存在於程式碼中，但被當成該腳本的局部 workaround（改用先刪後插取代 `on conflict`），從未升級為 schema／資料完整性議題，也未回寫任何文件。

### 寫入路徑盤點（決定風險範圍）

| 寫入路徑 | 會產生重複嗎 | 依據 |
|---|---|---|
| `service.create()`（UI／API 唯一入口） | ❌ 不會（CHANGE-107 起） | 前置四元組 `findFirst` → 409 |
| `prisma/seed.ts:866-873` | ❌ 不會 | 精確四元組 `findFirst` 守衛，命中則 update |
| `prisma/seed-template-field-mappings.js:278-282` | ❌ 不會 | raw SQL 先 `delete` 同四元組再 `insert`（冪等） |
| 人工 SQL / Kudu 直接操作 | ⚠️ 無防護 | 本質上不受應用層約束 |

**結論**：目前沒有任何程式路徑會產生新的重複。正式環境若存在重複，來源只可能是
(a) CHANGE-107 之前使用者在 UI 重複建立，或 (b) 人工 SQL。

⚠️ **因此本 FIX 的預期產出可能是「盤點結果為 0 筆」**。這不代表盤點無意義 —— 需要這個結論才能把 BUG-2 關掉，並據以判定 BUG-3。

---

## 待釐清的關鍵問題（決定後續走向）

`resolveMapping` 的排序邏輯（`src/services/template-field-mapping.service.ts:452-459`）：

```ts
const sortedConfigs = configs.sort((a, b) => {
  const scopePriorityA = SCOPE_PRIORITY[a.scope]
  const scopePriorityB = SCOPE_PRIORITY[b.scope]
  if (scopePriorityA !== scopePriorityB) {
    return scopePriorityB - scopePriorityA  // 跨範圍：FORMAT > COMPANY > GLOBAL
  }
  return b.priority - a.priority             // ← 同範圍內：按 priority 降序
})
```

`mergeMappings` 再由低優先級往高優先級遍歷，讓高優先級覆蓋同名 `targetField`。

**同範圍內按 `priority` 排序這件事，只有在「同範圍可以有多筆配置」時才有意義。** 這與唯一約束的意圖（同範圍只能一筆）直接矛盾。兩種可能：

| 可能 | 若成立則 |
|------|----------|
| **刻意分層** —— 同範圍允許多筆，用 `priority` 疊加（基礎層 + 覆蓋層） | 盤點出的「重複」多數是合法配置，不該清理；且 CHANGE-107 的應用層擋阻**過嚴**，應改為只擋 `priority` 也相同者 |
| **非刻意** —— 排序只是為了穩定輸出，唯一約束才是意圖 | 屬資料污染，需清理，並可考慮修 DB 約束 |

判定依據：Epic 19 tech spec（`docs/04-implementation/tech-specs/epic-19-template-matching/tech-spec-story-19-1.md`）、既有資料的 `priority` 分佈、以及是否存在同範圍多筆且 `priority` 相異的實例。

---

## 盤點結果（2026-07-25，選項 A 已執行）

全程唯讀。本地用 `scripts/local-inspect-duplicate-template-mappings.ts`；Azure DEV 用 Kudu `/api/command` 執行一次性 node 腳本（做法見本節末）。

### 總覽

| 指標 | 本地 | Azure DEV |
|------|------|-----------|
| 總筆數 | 4（啟用 4） | **36**（啟用 28 / 停用 8） |
| GLOBAL / COMPANY / FORMAT | 2 / 2 / 0 | 2 / 34 / 0 |
| 四元組重複組（BUG-2） | **0** | **2 組（4 筆）** |
| 其中多筆同時啟用 | 0 | **1 組** 🔴 |
| `resolveMapping` 同範圍多筆組（BUG-3） | 0 | **1 組** |
| ├ priority 相異（分層跡象） | 0 | **0** |
| └ priority 相同（污染跡象） | 0 | **1** |
| scope 與身分欄位不一致 | 0 | 0 |
| 非預設 priority 筆數 | **0 / 4** | **0 / 36** |

> 本地預期為 0 已驗證（CHANGE-107 測試資料同日已硬刪除）。

### Azure DEV 的 2 組四元組重複

| 組 | 模版 / 公司 | 筆數 | 啟用 | 影響 |
|---|---|---|---|---|
| 1 | Logistics Cost - Outbound Template (Full List) / Cargo Partner [ACTIVE] | 2 | **1** | ⓘ 另一筆已停用 → 不影響解析 |
| 2 | Logistics Cost - Inbound Template (Full List) / CEVA LOGISTICS (HONG KONG) LTD [ACTIVE] | 2 | **2** | 🔴 `resolveMapping` 會同時撈到兩筆 |

組 1 的停用筆（`cmrvug69v0`，2026-07-22 建立、名稱全大寫）是 CHANGE-107 之前在 UI 重複建立、事後停用的痕跡 —— 唯一約束若生效，當初就不會建得出來。

### 🔴 組 2 的實質後果：6 個 targetField 解析結果非確定性

兩筆皆 `isActive: true`、`priority` 皆為 **0**：

| 筆 | 建立時間 | 規則數 |
|---|---|---|
| `cmrimxy970` CEVA - inport to logistics template mapping (Full List) | 2026-07-13 03:00:59 | 7 |
| `cmrwu7bqb0` CEVA LOGISTICS (HONG KONG) LTD - Inbound Template (Full List) | 2026-07-23 01:33:00 | 10 |

`targetField` 聯集 11 個、各筆合計 17 個 → **重疊 6 個**。逐條比對**公式內容**（非僅 `sourceField`）後的實際差異：

| targetField | `cmrimxy970` 公式 | `cmrwu7bqb0` 公式 | 差異 |
|---|---|---|---|
| `docs_fee` | `{destination_document_processing_fee} + {delivery_order_fee}` | `{delivery_order_fee} + {destination_document_processing_fee}` | ✅ **等價**（加法可交換） |
| `handling` | `{destination_handling}`（DIRECT） | `{destination_handling} + {vat_7_percent}` | 🔴 新筆多 `vat_7_percent` |
| `freight` | `{basic_freight_charge}` | `{basic_freight_charge} + {ftl_freight_truck} + {freight_charges}` | 🔴 新筆多 2 項 |
| `others_local_charge` | `{other_destination_charge} + {cleaning_at_destination}` | 同左 | ✅ 相同 |
| `thc` / `shipment_number` | — | — | ✅ 相同 |

> ⚠️ **修正一項先前的誤判**：初次盤點只比對 `sourceField`，據此判斷 `docs_fee` 的「取值來源衝突」。實際上 `FORMULA` 型別下 `sourceField` 僅為代表性來源，真正的來源清單在 `transformParams.formula` 內 —— 兩筆的 `docs_fee` 公式數學等價，**從無衝突**。使用者亦於 2026-07-25 確認「`Destination Document Processing Fee` 與 `Delivery Order Fee` 兩者都要併入 `Docs Fee`」，與兩筆公式一致。此更正使 B-1 原本認定的業務判斷障礙消失。

`mergeMappings`（`service.ts:518-535`）以 `[...configs].reverse()` 從低往高遍歷、`targetFieldMap.set()` 後者覆蓋前者，故**排序最前者勝出**。而排序鍵在此情境下完全失效：

1. `orderBy: [{ priority: 'desc' }]` —— 兩筆 priority 皆 0，PostgreSQL **不保證** tie 時的回傳順序
2. JS `.sort()` 的比較函數對「同 scope 同 priority」返回 0，V8 穩定排序 → **原封不動沿用 DB 回傳順序**

結論：`handling` 是否含 `vat_7_percent`、`freight` 是否含 `ftl_freight_truck` 與 `freight_charges`，**取決於 PostgreSQL 的實體列順序**，會隨 `UPDATE` / `VACUUM` 改變。這不是理論風險 —— 是已在正式環境成立的非確定性，且**會直接改變匯出金額**（少算或多算費用項）。

> 另兩筆只由 `cmrwu7bqb0` 定義的 `docs_fee_at_origin` / `handling_at_origin` / `vgm_at_origin` / `clearance_at_origin`，以及只由 `cmrimxy970` 定義的 `clearance`，則不論順序都會被合併進來 —— 即實際解析結果是**兩筆的混合體**，而非任一筆的原貌。這比「其中一筆完全失效」更難察覺。

### 對照使用者提供的需求規格（2026-07-25）

使用者提供「提取費用名稱 → data template 欄位」的需求對照表，其中一組陸運費用（FTL Freight Truck／SADAO border／APDC FZ Clearance／APDC IOR／VAT 7%）揭露**兩筆配置各只對一半**：

| 需求規格 | `cmrimxy970`（舊） | `cmrwu7bqb0`（新） |
|---|---|---|
| FTL Freight Truck → `Freight` | ❌ 公式無此項 | ✅ 已含 |
| VAT 7% → `Handling` | ❌ 公式無此項 | ✅ 已含 |
| APDC FZ Clearance → `Clearance` | ✅ 對到 `clearance` | ❌ 對到 `clearance_at_origin` |
| SADAO border → `Handling` | ❌ 無此規則 | ❌ 併入 `handling_at_origin` |
| APDC IOR → `Handling` | ❌ 無此規則 | ❌ 併入 `docs_fee_at_origin` |

使用者於同日確認後三項的歸屬：**APDC FZ Clearance → `Clearance`；SADAO border 與 APDC IOR → `Handling`**（皆為 destination 側，非 `*_at_origin`）。

模版欄位驗證：`Logistics Cost - Inbound Template (Full List)` 共 45 欄，`clearance`(#16)／`clearance_at_origin`(#32)／`handling`(#20)／`handling_at_origin`(#33)／`docs_fee`(#17)／`docs_fee_at_origin`(#31) 皆存在，故兩筆的 `targetField` **全部合法**；9 筆 CEVA 配置的 `targetField` 亦無任何無效項。差異純粹是「該費用歸 destination 側或 origin 側」的歸類問題，而非欄位錯誤。

**因此 B-1 不是「二選一停用另一筆」** —— 保留 `cmrwu7bqb0` 後仍須修 3 條規則才符合需求規格（見 §解決方案 B-1）。

### 額外發現：5 筆配置指向已 MERGED 的公司（死配置）

盤點順帶查出的既有問題，**非** BUG-1 造成：

| 狀態 | 模版 | 指向的公司 | 併入 |
|---|---|---|---|
| 啟用 | Inbound Template (Full List) | CEVA LOGISTICS (HONG KONG) LIMITED（CEVA Logistics）[MERGED] | `0d02b680-1` |
| 啟用 | Inbound Template (Full List) | NIPPON EXPRESS (HK) CO., LTD.（NIPPON EXPRESS）[MERGED] | `7b6a2886-9` |
| 啟用 | Outbound Template (Full List) | CEVA LOGISTICS (HONG KONG) LIMITED [MERGED] | `0d02b680-1` |
| 停用 | Logistics Cost - Inobund Template | CEVA LOGISTICS (HONG KONG) LIMITED [MERGED] | `0d02b680-1` |
| 停用 | Logistics Cost - Outbound Template | CEVA LOGISTICS (HONG KONG) LIMITED [MERGED] | `0d02b680-1` |

`resolveMapping` 以文件的 `companyId`（＝合併後的存活公司）查詢，故這 5 筆**永遠撈不到**。根因是公司合併不轉移 `templateFieldMappings` —— 屬 **FIX-125** 的既有範圍（`autoMergeCompanies` 只轉移 documents / extractionResults / mappingRules 三類），不在本 FIX 處理，僅記錄交叉引用。

> 這也解釋了為何 CEVA 在同一模版下有 3 筆啟用配置，而四元組分組只認出 2 筆同組：第 3 筆（`cmrcxo6no0`）掛在**已 MERGED 的 CEVA 記錄**下，`companyId` 不同。

另查「同模版下公司名正規化相同但 `companyId` 不同」的隱性重複：**0 組**（MERGED 與存活的 CEVA 記錄名稱不同，正規化後不相等）。

### Azure 盤點的實際做法（未部署、零資料寫入）

```
az webapp show → 取帶隨機後綴的 SCM 主機名（本機 DNS 解析不到 SCM host，主站 host 可解析）
PowerShell Resolve-DnsName <主站host> -Server 8.8.8.8 → <公開IP>（主站與 SCM 共用同一 IP）
az account get-access-token --resource https://management.azure.com/ → ARM bearer
curl --resolve <SCMhost>:443:<公開IP> -X POST https://<SCMhost>/api/command
  → bash -c "npm install pg@8.7.3"            （Kudu sidecar 為 node v14，須釘 8.7.x）
  → bash -c "echo <base64> | base64 -d > /tmp/fix133/inspect.js && node inspect.js"
```

> 公開 IP 會隨 App Service 重建／scale 改變，每次以當下 `Resolve-DnsName` 結果為準，不要沿用舊值。

要點：
- Kudu sidecar 容器讀得到 app setting `DATABASE_URL`，可直連 VNet 內私有 PG
- 腳本以 **base64 經 `/tmp` 落地**再執行，避開多層 shell/JSON escape（直接內嵌 `node -e` 會因引號層數過深而失敗）
- 用本機 node 產生 payload JSON（`JSON.stringify`），不手工拼裝
- 產物置於 scratchpad、**未進 repo**：一次性診斷工具，且 Azure runner 映像本就不含 `scripts/` 與 `tsx`

---

## BUG-3 判定：非刻意分層（＝資料污染）

`priority` 的「同範圍分層」語意**不成立**。判定依據四條：

| # | 依據 | 內容 |
|---|------|------|
| 1 | **Tech spec 自相矛盾，但唯一約束是明確的意圖陳述** | `tech-spec-story-19-1.md:131` 寫 `priority Int @default(0) // 同範圍內的優先級`，而同一個 model 的 `:144-145` 寫 `// 確保同一模版+範圍+公司/格式的組合唯一` + `@@unique(...)`。兩者不能同時為真。後者是**針對約束本身**的意圖說明，前者只是欄位註解 —— 且若唯一約束生效，「同範圍內的優先級」永遠只有單筆可排，等於無操作 |
| 2 | **從未有人使用** | 本地 4 筆 + Azure DEV 36 筆，`priority` **全部為 0**，無任何非預設值 |
| 3 | **唯一實例不具分層特徵** | CEVA 兩筆 priority 相同（皆 0）、名稱都指同一件事（CEVA Inbound）、`targetField` 部分重疊且其中 2 個**給出互相衝突的取值來源** —— 分層設計會是「基礎層 + 覆蓋層」的互補關係，且必然使用相異 priority |
| 4 | **設計主軸是跨範圍疊加** | `resolveMapping` 的實質分層是 `SCOPE_PRIORITY`（FORMAT > COMPANY > GLOBAL），這條路徑有完整實作與測試；同範圍 priority 排序只是排序鍵的次要 tie-break |

**因此**：
- BUG-2 盤點出的重複屬**資料污染**，應清理（選項 B）
- CHANGE-107 在 `service.create()` 加的應用層擋阻（四元組 + `isActive: true` → 409）**擋阻範圍正確，無需放寬**
- Spec 的矛盾應一併澄清（見下方待決事項）

---

## 解決方案

### 方案選項

| 選項 | 內容 | 代價 / 風險 |
|------|------|------------|
| **A（本次採用）** | **只盤點 + 判定語意**：唯讀查詢統計本地與 Azure DEV 依四元組 `group by having count(*) > 1` 的組合，列出各組的 `priority` / 規則數 / 建立時間 / `is_active`，據此判定分層或污染，結論回寫本文件 | 低，**零資料風險**（全程唯讀） |
| B | A + 清理污染資料 | 需 A 的判定先成立；清理需 gated 腳本 + 前置快照（見 memory「不可逆資料操作前先快照」） |
| C | A + `NULLS NOT DISTINCT` migration | PG 15+ 支援（Azure PG 18 / 本地 PG 15，技術可行）；但需先清乾淨既有重複，且會**永久移除**同範圍分層能力 —— 在 BUG-3 未判定前不可執行 |

**A 已於 2026-07-25 完成**（見 §盤點結果）。判定結果為資料污染，故 B 成立、C 具備前提。實際做法已回寫至 §盤點結果末段。

### 待使用者決策：B 與 C

判定既為污染，B / C 皆有依據，但**都需要使用者拍板**（B 涉及不可逆資料操作、C 涉及 schema 變更）：

| 項 | 內容 | 建議 | 需要什麼 |
|---|------|------|----------|
| **B-1** | 修正並保留 `cmrwu7bqb0`（3 條規則需改）+ 停用 `cmrimxy970` | ⭐ **建議優先做** —— 這是唯一有實質影響的一組，處理後解析恢復確定性且符合需求規格 | 業務判斷**已取得**（見下方修正清單）；剩下需決定執行方式（UI 手改 or gated 腳本）+ 前置快照 |
| **B-2** | 刪除或停用 Cargo Partner 組的停用筆 `cmrvug69v0` | 可延後 —— 已停用、無功能影響，僅為清潔 | 低風險，可與 B-1 併做 |
| **B-3** | 5 筆指向 MERGED 公司的死配置 | **不在本 FIX 處理** —— 交由 FIX-125（合併時轉移關聯資料）統一解決 | — |
| **C** | 加 `NULLS NOT DISTINCT` migration 讓 DB 約束真正生效 | ⭐ 建議做，但**必須在 B-1 之後** | 需依 memory「Prisma migration 不會自動到 Azure」加 `apply-schema-drift.js` 條目 + `RUN_SCHEMA_DRIFT_FIX=true` 部署；Prisma 7.2 是否支援此語法需先驗證，若不支援則需 raw SQL migration |

#### B-1 修正清單（業務判斷已於 2026-07-25 取得）

以 `cmrwu7bqb0` 為基礎，依需求規格修 3 條規則：

| # | targetField | 現況公式 | 修正後 | 動作 |
|---|---|---|---|---|
| 1 | `handling` | `{destination_handling} + {vat_7_percent}` | `{destination_handling} + {vat_7_percent} + {sadao_border} + {apdc_ior}` | **加** 2 項 |
| 2 | `clearance_at_origin` → **`clearance`** | `{apdc_fz_clearance}` | 公式不變，**改 targetField** 為 `clearance` | 改欄位 |
| 3 | `handling_at_origin` | `{sealing_charge} + {origin_thc_terminal_handling_charge} + {sadao_border}` | 移除 `{sadao_border}` | **減** 1 項 |
| 4 | `docs_fee_at_origin` | `{origin_document_processing_fee} + {apdc_ior}` | 移除 `{apdc_ior}` | **減** 1 項 |

> 🔴 **第 3、4 項的減項與第 1 項的加項必須同一次完成**。`sadao_border` 與 `apdc_ior` 目前分別在 `handling_at_origin` 與 `docs_fee_at_origin` 的公式內；若只加不減，這兩筆費用會**同時計入 destination 與 origin 兩個欄位**，導致匯出的總成本虛增。這是本次修正中最容易漏掉、且後果最直接的一點。

`docs_fee`／`freight`／`others_local_charge`／`thc`／`shipment_number`／`vgm_at_origin` 六條維持原樣（已符合需求規格）。修畢後停用 `cmrimxy970`（其唯一獨有的 `clearance ← apdc_fz_clearance` 已由第 2 項承接，不會遺失）。

---

## 執行記錄：B-1 + Outbound 補齊（2026-07-25 已完成）

執行方式：使用者選定 gated 腳本。經 Kudu `/api/command` 執行一次性 node 腳本，`RUN_FIX133_CLEANUP=true` 才寫入，先以 dry-run 核對計畫變更與快照後才實際套用。單一交易 + 每個 `UPDATE` 的 `rowCount !== 1` 即 `ROLLBACK`。

### 實際變更（11 項，全部成功）

**[A] Inbound 保留筆 `cmrwu7bqb001101miqgc5e989`（10 條規則）**

| targetField | 變更後公式 |
|---|---|
| `handling` | `{destination_handling} + {vat_7_percent} + {sadao_border} + {apdc_ior}` |
| `clearance` | `apdc_fz_clearance`（原 `clearance_at_origin`，改 targetField） |
| `handling_at_origin` | `{sealing_charge} + {origin_thc_terminal_handling_charge}`（移除 `{sadao_border}`） |
| `docs_fee_at_origin` | `{origin_document_processing_fee}`（移除 `{apdc_ior}`） |

**[B] Inbound 舊筆 `cmrimxy97000001r6xs9s4wfy`** → `is_active = false`

**[C] Outbound 生效筆 `cmrin1af9000101r6gsv3674m`（5 → 9 條）**

| targetField | 內容 |
|---|---|
| `document_fee` | `{origin_document_processing_fee} + {delivery_order_fee}+{awb_fee}`（加 `awb_fee`） |
| `delivery` | ← `pick_up_at_origin` [DIRECT]（新增，order=5） |
| `x_ray_fee` | ← `x_ray` [DIRECT]（新增，order=6） |
| `cfs_charge` | ← `cfs` [DIRECT]（新增，order=7） |
| `gate_charge` | ← `gate_charge` [DIRECT]（新增，order=8） |

### 事前技術驗證

- **公式空白格式**：`awb_fee` 沿用來源筆的無空格寫法 `+{awb_fee}`。因該來源筆是死配置、公式從未實際執行，故先查證 `formula.transform.ts:380` —— `safeEval` 在求值前 `replace(/\s+/g, '')` 移除所有空白，空格有無完全等價。
- **缺失欄位**：`replaceVariables`（`formula.transform.ts:351-353`）將 `undefined`/`null`/非數值一律視為 `0`，故新增的來源欄位在未出現該費用的發票上不會拋錯。
- **變數命名**：`vat_7_percent` / `sadao_border` / `apdc_ior` / `ftl_freight_truck` 皆符合 `VARIABLE_PATTERN`（`/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/`）。
- **單項 FORMULA**：`docs_fee_at_origin` 移除加項後只剩單一變數，仍為合法算術式（既有 `cmrimxy970` 的 `freight` 即為同樣寫法）。

### 獨立驗證（重跑原盤點腳本，非依腳本自報）

| 指標 | 修正前 | 修正後 |
|---|---|---|
| 多筆同時啟用 | **1 組** | **0** ✅ |
| `resolveMapping` 同範圍多筆組 | **1 組** | **0** ✅ |
| 四元組重複組 | 2 | 2（不變，屬預期 —— 停用非刪除，兩組現各僅 1 筆啟用） |
| scope/身分欄位不一致 | 0 | 0 |

**解析非確定性已消除。** `resolveMapping` 有 5 分鐘 in-memory 快取（`CACHE_TTL`），最多 5 分鐘後生效，不需重啟容器。

> ⚠️ 本次修正**繞過應用層**（未經 `service.update`），故未經 Zod 驗證與 `targetField` 有效性檢查。事前已用獨立查詢確認全部 `targetField` 存在於對應模版（Inbound Full List 45 欄、Outbound Full List 37 欄），但仍建議在 UI 檢視配置顯示正常，並實際跑一次 template 匹配核對金額。

### 還原依據（前置快照）

以下為修改前的原始 `mappings` JSON，可直接用於還原：

<details>
<summary>inboundKeep <code>cmrwu7bqb001101miqgc5e989</code>（原 10 條，is_active=true）</summary>

```json
[{"id":"AblUcC0hCfSLKZVYqPc5k","order":0,"isRequired":false,"description":"","sourceField":"_ref_number","targetField":"shipment_number","transformType":"DIRECT","transformParams":null},{"id":"u6rACLIqsqRoebK5fV1H0","order":1,"isRequired":false,"description":"","sourceField":"basic_freight_charge","targetField":"freight","transformType":"FORMULA","transformParams":{"formula":"{basic_freight_charge} + {ftl_freight_truck} + {freight_charges}"}},{"id":"CdmtxGflbn-VfRJdB4uSY","order":2,"isRequired":false,"description":"","sourceField":"destination_thc_terminal_handling_charge","targetField":"thc","transformType":"DIRECT","transformParams":null},{"id":"meiL-gRwK21iyyu7QyjoA","order":3,"isRequired":false,"description":"","sourceField":"delivery_order_fee","targetField":"docs_fee","transformType":"FORMULA","transformParams":{"formula":"{delivery_order_fee} + {destination_document_processing_fee}"}},{"id":"NPUpktDIx4V8i5yDEKatd","order":4,"isRequired":false,"description":"","sourceField":"other_destination_charge","targetField":"others_local_charge","transformType":"FORMULA","transformParams":{"formula":"{other_destination_charge} + {cleaning_at_destination}"}},{"id":"Juvjn1Yvyu8GIYOkNmhPH","order":5,"isRequired":false,"description":"","sourceField":"destination_handling","targetField":"handling","transformType":"FORMULA","transformParams":{"formula":"{destination_handling} + {vat_7_percent}"}},{"id":"fOoTiFI9w-9Rdpd-2Srpo","order":6,"isRequired":false,"description":"","sourceField":"origin_document_processing_fee","targetField":"docs_fee_at_origin","transformType":"FORMULA","transformParams":{"formula":"{origin_document_processing_fee} + {apdc_ior}"}},{"id":"64MMe9IE63QnMfVorec4g","order":7,"isRequired":false,"description":"","sourceField":"sealing_charge","targetField":"handling_at_origin","transformType":"FORMULA","transformParams":{"formula":"{sealing_charge} + {origin_thc_terminal_handling_charge} + {sadao_border}"}},{"id":"ANlqMfQVOaiHOYSQ2jXbC","order":8,"isRequired":false,"description":"","sourceField":"solas_vgm_management_fee","targetField":"vgm_at_origin","transformType":"DIRECT","transformParams":null},{"id":"s8p2aHAKadz-HCOTm7vE0","order":9,"isRequired":false,"description":"","sourceField":"apdc_fz_clearance","targetField":"clearance_at_origin","transformType":"DIRECT","transformParams":null}]
```

</details>

<details>
<summary>outboundKeep <code>cmrin1af9000101r6gsv3674m</code>（原 5 條，is_active=true）</summary>

```json
[{"id":"FwZIGyKxRj1dqhlqggfns","order":0,"isRequired":false,"description":"","sourceField":"_ref_number","targetField":"shipment_number","transformType":"DIRECT","transformParams":null},{"id":"v1SHWe142-bLbsr7jIdU0","order":1,"isRequired":false,"description":"","sourceField":"origin_thc_terminal_handling_charge","targetField":"thc","transformType":"DIRECT","transformParams":null},{"id":"s9MnA9zIDKxnjkLjnnqp8","order":2,"isRequired":false,"description":"","sourceField":"origin_document_processing_fee","targetField":"document_fee","transformType":"FORMULA","transformParams":{"formula":"{origin_document_processing_fee} + {delivery_order_fee}"}},{"id":"912q0uqJRyVWl_p46We_h","order":3,"isRequired":false,"description":"","sourceField":"sealing_charge","targetField":"seal_fee","transformType":"DIRECT","transformParams":null},{"id":"lR7fAsHinv5bJ_dRQNv-m","order":4,"isRequired":false,"description":"","sourceField":"solas_vgm_management_fee","targetField":"vgm","transformType":"DIRECT","transformParams":null}]
```

</details>

> `inboundOld` `cmrimxy97000001r6xs9s4wfy` 只改 `is_active`（true → false），`mappings` 未動，還原僅需改回 `is_active = true`。

---

---

## 執行記錄：選項 C（部分唯一索引）—— 2026-07-25 已實作，待套用 Azure

### 關鍵前提修正：全表方案不可行

原記載「C 的前提已滿足（B-1 已完成）」**是錯的**。唯一索引**不看 `is_active`**，而 Azure DEV 仍有 2 組四元組重複（各 1 筆啟用 + 1 筆停用）：

| 組 | 記錄 |
|---|---|
| Cargo Partner | `5efa9e02`（啟用）+ `cmrvug69v0`（停用） |
| CEVA Inbound | `cmrwu7bqb0`（啟用）+ `cmrimxy970`（停用 ← B-1 停用的那筆） |

全表 `NULLS NOT DISTINCT` 會被這 2 組擋下，**必須先刪除**那 2 筆停用記錄。而實測確認：

```
✅ 啟用列中無四元組重複 → partial unique index (WHERE is_active) 可直接建立，無需刪除任何資料
```

### 採用方案：部分唯一索引 + `NULLS NOT DISTINCT`

```sql
DROP INDEX IF EXISTS "template_field_mappings_data_template_id_scope_company_id_d_key";

CREATE UNIQUE INDEX IF NOT EXISTS "template_field_mappings_active_unique"
  ON "template_field_mappings" ("data_template_id", "scope", "company_id", "document_format_id")
  NULLS NOT DISTINCT
  WHERE "is_active" = true;
```

選擇理由（使用者 2026-07-25 決定）：

| | 部分索引（採用） | 全表 |
|---|---|---|
| 需刪除資料 | ❌ 不需 | ✅ 需刪 2 筆停用記錄 |
| 對應應用層檢查 | ✅ 精確對應 `service.create()`（四元組 + `isActive: true`） | ⚠️ 比應用層更嚴 |
| 保留「停用舊配置」模式 | ✅ 保留（既有資料確實這樣用） | ❌ 失去 |
| Prisma 漂移 | 需移除 schema 的 `@@unique` | 最小 |

### 事前技術查證

- **Prisma 7.2 不支援 `nullsNotDistinct`** —— 實測 `prisma validate` 回 `P1012 error: No such argument`，故必須 raw SQL。亦不支援部分索引。
- **DB 上是唯一索引而非 constraint** —— `pg_constraint` 只有 `pkey`，故用 `DROP INDEX` 而非 `ALTER TABLE DROP CONSTRAINT`。索引實名為 `template_field_mappings_data_template_id_scope_company_id_d_key`（**不是** `unique_template_mapping` —— 後者只是 Prisma Client 的複合鍵名，DB 名需 `map:` 才能指定），本地與 Azure 兩邊一致。
- **無程式碼依賴該複合鍵** —— 全庫搜尋確認無任何 `findUnique`/`upsert` 使用，故移除 `@@unique` 不會破壞 Prisma Client 呼叫；`type-check` 亦通過。
- **PG 版本** —— Azure 18.4 / 本地 15.15，皆支援 `NULLS NOT DISTINCT`（PG 15 引入）。

### schema.prisma 的處理與漂移驗證

移除 `@@unique`（改為註解說明），因為保留它會讓 `prisma migrate` 持續想重建那個無效的全表唯一索引。實測漂移方向：

| schema 狀態 | `prisma migrate diff` 結果 |
|---|---|
| 保留 `@@unique` | `CREATE UNIQUE INDEX ..._d_key`（想重建全表 unique）；**但不會 DROP 部分索引** —— Prisma 忽略帶 `WHERE` 的索引 |
| 移除 `@@unique`（採用） | `-- This is an empty migration.` ✅ **漂移歸零** |

### 三處同步（各服務不同情境，缺一不可）

| 檔案 | 服務情境 | 為何必要 |
|---|---|---|
| `prisma/migrations/20260725060000_.../migration.sql` | 本地 `migrate dev` / `migrate deploy` | 本地開發環境走 migration 路徑建庫 |
| `prisma/post-init-indexes.sql` + `Dockerfile` 追加 | **全新空庫** | `init.sql` 由 `migrate diff --from-empty --to-schema` 生成、**不在版控**；Prisma 不認識部分索引 → 少了追加，新環境會**完全沒有**唯一性保護 |
| `prisma/apply-schema-drift.js` | Azure 既有非空庫 | `bootstrap-db.js` 只在空庫套 `init.sql`，既有庫需 gated 增量 DDL |

### 本地驗證

| 測試 | 結果 |
|---|---|
| `prisma validate` | ✅ |
| `prisma migrate diff` | ✅ 空 migration（無漂移） |
| `prisma generate` + `npm run type-check` | ✅ |
| `npm run lint` | ✅ exit 0 |
| 插入四元組相同的**啟用**記錄 | ✅ 被擋：`duplicate key value violates unique constraint "template_field_mappings_active_unique"`，DETAIL 顯示鍵為 `(..., GLOBAL, null, null)` —— **兩個 NULL 的 GLOBAL 範圍也受約束**，正是原本完全失效的情況 |
| 插入四元組相同的**停用**記錄 | ✅ 允許（`INSERT 0 1`） |
| 測試後資料筆數 | ✅ 未變（測試全在交易內 `ROLLBACK`） |

> migration 已用 `prisma migrate resolve --applied` 標記（本地索引為手動套用）。順帶發現本地 DB 有一個 **pre-existing** 未套用 migration `20260722020000_add_transform_diagnostics_to_template_instance_rows`（FIX-128）—— 非本次造成，未處理，僅記錄。

### Azure DEV 已套用（2026-07-25，經 Kudu 直接執行 DDL）

使用者選定 Kudu 途徑（不需部署即生效）。腳本預設 dry-run、`RUN_FIX133_INDEX=true` 才執行，含安全閘與交易內就地驗證。

```
執行前  template_field_mappings_data_template_id_scope_company_id_d_key
          UNIQUE btree (data_template_id, scope, company_id, document_format_id)     ← 從未生效

執行後  template_field_mappings_active_unique
          UNIQUE btree (data_template_id, scope, company_id, document_format_id)
          NULLS NOT DISTINCT WHERE (is_active = true)
```

| 步驟 | 結果 |
|---|---|
| 安全閘：啟用列四元組重複 | ✅ 0 組 → 可安全建立 |
| 參考：含停用列的重複組 | ⓘ **2 組** → 證實全表方案必然失敗，部分索引是唯一可行路徑 |
| DROP + CREATE（單一交易） | ✅ COMMIT；交易內驗證索引定義含 `NULLS NOT DISTINCT` 與 `is_active` 條件 |
| 約束行為：插入啟用重複 | ✅ 被擋（`duplicate key value violates unique constraint "template_field_mappings_active_unique"`） |
| 約束行為：插入停用重複 | ✅ 允許 |
| 資料筆數 | ✅ 36 → 36 未變（測試插入全部 `ROLLBACK`，無殘留） |

> 線上映像的 Prisma Client 仍是含 `@@unique` 的舊版（schema 變更尚未部署），但因無任何程式碼使用該複合鍵，不影響運行。下次部署後 schema 與 DB 即完全一致。
>
> ✅ **2026-07-27 已部署**（映像 `dev-change107-fix133-20260727115120`，對應 `origin/main` @ `fe69379`）—— schema 與 DB 現已完全一致，且 Dockerfile 追加 `post-init-indexes.sql` 後**全新空庫也有唯一性保護**（部署前空庫完全無保護）。部署**未帶** `RUN_SCHEMA_DRIFT_FIX`，因索引已於 7/25 直接套用；容器 log 確認走 `[bootstrap] public schema already has 122 tables -> skip init.sql`（無 DDL）。見 [部署記錄](../../../docs/07-deployment/02-azure-deployment/deployment-records/2026-07-27-dev-change107-fix133.md)。

### 附帶取得：B-1 資料修正的 UI 層獨立佐證（2026-07-27）

7/25 的資料修正繞過應用層，當時僅由腳本自報 + 重跑盤點腳本確認。2026-07-27 部署驗收時擷取的列表提供了 UI 層的獨立印證：

| 記錄 | 列表顯示 | 與 §執行記錄 一致？ |
|---|---|---|
| `cmrwu7bqb0` CEVA Inbound（保留筆） | 規則數 **10**、**啟用** | ✅ 改 4 條規則後仍為 10 條 |
| `cmrimxy970` CEVA Inbound（舊筆） | 規則數 7、**停用** | ✅ [B] 已將其停用 |
| `cmrin1af90` CEVA Outbound | 規則數 **9**、啟用 | ✅ [C] 補齊 5 → 9 |

仍未涵蓋：逐條**公式內容**的 UI 檢視、以及實際跑一次 template 匹配核對金額（下方「（建議）」項）。

---

### 附帶建議：澄清 spec 矛盾

`tech-spec-story-19-1.md:131` 的 `// 同範圍內的優先級` 註解與 `:144` 的唯一約束意圖矛盾（見 §BUG-3 判定依據 1）。建議在該 spec 加一則 amendment 註明「同範圍唯一，`priority` 僅作跨範圍排序的 tie-break」，避免後續開發者再次據此推論「同範圍可分層」。**未執行**，待使用者決定是否納入。

---

## 修改的檔案

> 選項 A（盤點）的實際改動如下。B / C 的改動待決策後補。

| 檔案 | 修改內容 |
|------|----------|
| `scripts/local-inspect-duplicate-template-mappings.ts`（新建） | 本地唯讀盤點；沿用 `scripts/local-inspect-merged-company-orphans.ts` 的慣例（dotenv + 動態 import `src/lib/prisma`，避免連線字串為 undefined 的空錯誤）。含四元組分組、`resolveMapping` 撈取語意分組、`targetField` 重疊分析、scope/身分欄位一致性檢查 |
| `claudedocs/4-changes/bug-fixes/FIX-133-*.md`（本檔） | 回寫盤點結論、BUG-3 判定（非刻意分層）、B/C 待決事項 |
| `claudedocs/reference/known-discrepancies.md` | 新增一條「`unique_template_mapping` 因 NULL 語意不生效」的差異記錄 |
| `claudedocs/STATUS.md` | `npm run docs:status` 重新生成（狀態由「待修復」轉「進行中」） |
| `prisma/schema.prisma`（選項 C） | 移除 `TemplateFieldMapping` 的 `@@unique` —— 唯一性改由 DB 端部分唯一索引保證；附完整理由註解與「不要加回來」警告 |
| `prisma/migrations/20260725060000_fix133_template_mapping_partial_unique_index/migration.sql`（新建） | raw SQL：DROP 無效全表唯一索引 + CREATE 部分唯一索引（`NULLS NOT DISTINCT WHERE is_active`），冪等 |
| `prisma/post-init-indexes.sql`（新建） | Prisma 無法表示的 DB 物件，由 Dockerfile 追加至 `init.sql` —— 缺此則**全新空庫完全無唯一性保護** |
| `Dockerfile` | `init.sql` 生成後追加 `cat prisma/post-init-indexes.sql >> prisma/init.sql` |
| `prisma/apply-schema-drift.js` | 新增 2 條 FIX-133 條目（DROP + CREATE），供 Azure 既有非空庫以 `RUN_SCHEMA_DRIFT_FIX=true` 套用 |
| ~~`docs/open-questions.md`~~ | **未新增 OQ** —— BUG-3 已可從 spec 條文 + `priority` 分佈 + 實例特徵判定，無需使用者拍板語意（但 B-1 的業務判斷仍需使用者決定） |
| Azure 一次性盤點腳本 | 置於 session scratchpad、**未進 repo**（一次性診斷工具；Azure runner 映像本就不含 `scripts/` 與 `tsx`）。做法已完整記錄於 §盤點結果末段，可重現 |

---

## 測試驗證

- [x] 本地盤點完成 —— 4 筆記錄、**0 組重複**，符合預期（CHANGE-107 的測試資料已於同日硬刪除）
- [x] Azure DEV 盤點完成 —— 36 筆記錄、**2 組重複（1 組同時啟用）**；全程唯讀，兩輪查詢皆只執行 `SELECT`
- [x] BUG-3 判定完成 —— **非刻意分層（資料污染）**，依據四條（spec 條文矛盾但唯一約束為明確意圖 / `priority` 全表皆 0 / 唯一實例不具分層特徵 / 設計主軸是跨範圍疊加）
- [x] 判定為污染 → 已提出清理項 B-1 / B-2，**待使用者決策**（含前置快照要求）
- [x] ~~判定為刻意分層 → 放寬 CHANGE-107 擋阻~~ —— 不成立，CHANGE-107 的擋阻範圍正確、無需修改
- [x] 結論回寫本文件 + `known-discrepancies.md`
- [x] `npm run docs:status` 已重新生成並提交
- [x] B-1 的業務判斷已取得（2026-07-25）—— `docs_fee` 兩來源皆併入（原判定為衝突係誤讀 `sourceField`，已更正）；APDC FZ Clearance → `Clearance`；SADAO border 與 APDC IOR → `Handling`
- [x] B-1 前置快照已完成並**持久化於本文件**（§執行記錄 → 還原依據），非僅存於 session 暫存
- [x] B-1 已執行：`cmrwu7bqb0` 改 4 條規則 + 停用 `cmrimxy970`；加項與減項於**同一交易**完成，`sadao_border` / `apdc_ior` 不再同時計入 destination 與 origin（無重複計算）
- [x] Outbound 補齊已執行：`cmrin1af90` 由 5 條增至 9 條（`awb_fee` + `delivery` / `x_ray_fee` / `cfs_charge` / `gate_charge`）
- [x] 獨立驗證（重跑原盤點腳本）：「多筆同時啟用」1 → **0**、「同範圍多筆組」1 → **0**，解析非確定性已消除
- [ ] **（建議）** UI 檢視配置顯示正常 + 實際跑一次 template 匹配核對金額 —— 本次繞過應用層驗證，需端到端確認
- [x] C 已實作為**部分唯一索引**（`NULLS NOT DISTINCT WHERE is_active = true`）—— 全表方案因 2 組含停用列的四元組重複而不可行，改用部分索引後無需刪除任何資料
- [x] C 三處同步完成：migration `20260725060000` / `post-init-indexes.sql` + `Dockerfile` / `apply-schema-drift.js`
- [x] C 本地驗證：約束確實生效（含 GLOBAL 兩 NULL 的情況）、停用列不受約束、`prisma migrate diff` 漂移歸零、`type-check` + `lint` 通過
- [x] C 已套用 Azure DEV（2026-07-25 經 Kudu），並就地驗證約束生效、停用列不受約束、資料筆數未變
- [x] ~~B-2：Cargo Partner 停用筆清理~~ —— **不再必要**。原本的理由是「讓全表唯一索引可建立」，改用部分索引後停用列本就不受約束，留著反而保有可還原的歷史
- [ ] **（移交 FIX-125）** 5 筆指向 MERGED 公司的死配置，含 Outbound 的 `cmrcxw6ul0`（其內容已由本次補齊承接，可安全停用）

---

## 相關文件

- [CHANGE-107](../feature-changes/CHANGE-107-template-field-mapping-copy-record.md) —— 本問題的發現來源；已加應用層重複檢查擋下新重複（PR #144）。盤點結論確認其擋阻範圍正確，無需放寬
- [CHANGE-101](../feature-changes/CHANGE-101-batch-template-field-mappings-from-excel.md) —— 其 seed 腳本註解已記載此 NULL 問題（2026-07-09），是更早的獨立佐證
- [FIX-125](FIX-125-company-merge-orphans-document-formats.md) —— 盤點發現的 5 筆「指向 MERGED 公司的死配置」屬其範圍（合併只轉移 documents / extractionResults / mappingRules 三類）
- [FIX-128](FIX-128-mapping-source-field-validation.md) —— 同一模組的「靜默失效」類問題（來源 key 側）

---

*文件建立日期: 2026-07-25*
*最後更新: 2026-07-25*
