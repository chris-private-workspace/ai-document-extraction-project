# FIX-133: `unique_template_mapping` 唯一約束從未生效，需盤點既有重複配置

> **建立日期**: 2026-07-25
> **發現方式**: CHANGE-107 實作期間的 Playwright 實測（本地）
> **影響頁面/功能**: Template Field Mapping 資料完整性（`template_field_mappings` 表）；間接影響 `resolveMapping` 的映射解析結果
> **優先級**: 中（無立即功能損壞；新重複已由 CHANGE-107 擋下，本 FIX 屬存量清查 + 語意判定）
> **狀態**: 🚧 待修復

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

## 解決方案

### 方案選項

| 選項 | 內容 | 代價 / 風險 |
|------|------|------------|
| **A（本次採用）** | **只盤點 + 判定語意**：唯讀查詢統計本地與 Azure DEV 依四元組 `group by having count(*) > 1` 的組合，列出各組的 `priority` / 規則數 / 建立時間 / `is_active`，據此判定分層或污染，結論回寫本文件 | 低，**零資料風險**（全程唯讀） |
| B | A + 清理污染資料 | 需 A 的判定先成立；清理需 gated 腳本 + 前置快照（見 memory「不可逆資料操作前先快照」） |
| C | A + `NULLS NOT DISTINCT` migration | PG 15+ 支援（Azure PG 18 / 本地 PG 15，技術可行）；但需先清乾淨既有重複，且會**永久移除**同範圍分層能力 —— 在 BUG-3 未判定前不可執行 |

**本次只做 A。** 判定語意是後續一切的前提，且 A 零風險。B / C 待 A 有結論後另立決策。

### Azure 盤點方式（不需部署）

唯讀查詢可走 Kudu，**不必**為此做一次部署：

```
PowerShell Resolve-DnsName 取主站公開 IP
→ curl --resolve SCM:443:<IP> + ARM bearer token
→ Kudu /api/command 內 npm install pg
→ node -e '<唯讀 SQL>'
```

（做法見 memory `project_company_merge_no_rollback_unmerge` 與 `feedback_azure_locked_container_diagnostics`。）

若改走 `prisma/*.js` + entrypoint gated flag 則需一次手動部署（Azure 部署只手動 `az acr build`，且 runner 映像不含 `scripts/` 與 `tsx`）—— 對唯讀盤點而言成本過高，不採用。

---

## 修改的檔案

> 建立時為預估；完成後更新為實際改動。

| 檔案 | 修改內容 |
|------|----------|
| `scripts/local-inspect-duplicate-template-mappings.ts`（新建） | 本地唯讀盤點；沿用 `scripts/local-inspect-merged-company-orphans.ts` 的慣例（dotenv + 動態 import `src/lib/prisma`，避免連線字串為 undefined 的空錯誤） |
| `claudedocs/4-changes/bug-fixes/FIX-133-*.md`（本檔） | 回寫盤點結論與 BUG-3 的語意判定 |
| `claudedocs/reference/known-discrepancies.md` | 新增一條「`unique_template_mapping` 因 NULL 語意不生效」的差異記錄 |
| `docs/open-questions.md` | 若 BUG-3 無法從既有文件判定 → 登記為新的 OQ 待使用者拍板 |

---

## 測試驗證

- [ ] 本地盤點完成，列出所有 `count(*) > 1` 的四元組組合（預期 **0 筆** —— CHANGE-107 的測試資料已於同日硬刪除）
- [ ] Azure DEV 盤點完成，**全程唯讀、未修改任何資料**
- [ ] BUG-3 判定完成：「同範圍多筆」是刻意分層或資料污染，且結論有明確依據（tech spec 條文 / `priority` 分佈 / 實例）
- [ ] 若判定為污染 → 建立清理項（選項 B）並先做前置快照
- [ ] 若判定為刻意分層 → 檢視 CHANGE-107 的應用層擋阻是否過嚴，必要時改為只擋 `priority` 相同者，並回寫 CHANGE-107
- [ ] 結論回寫本文件 + `known-discrepancies.md`
- [ ] `npm run docs:status` 已重新生成並提交

---

## 相關文件

- [CHANGE-107](../feature-changes/CHANGE-107-template-field-mapping-copy-record.md) —— 本問題的發現來源；已加應用層重複檢查擋下新重複（PR #144）
- [CHANGE-101](../feature-changes/CHANGE-101-batch-template-field-mappings-from-excel.md) —— 其 seed 腳本註解已記載此 NULL 問題（2026-07-09），是更早的獨立佐證
- [FIX-128](FIX-128-mapping-source-field-validation.md) —— 同一模組的「靜默失效」類問題（來源 key 側）

---

*文件建立日期: 2026-07-25*
*最後更新: 2026-07-25*
