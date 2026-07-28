# FIX-139: essential seed 以佔位權限覆寫系統角色，Azure 上非 wildcard 角色的權限判斷全部失效

> **建立日期**: 2026-07-28
> **發現方式**: FIX-138 部署驗收（唯讀查 Azure `/api/roles`）
> **影響頁面/功能**: 所有以 `PERMISSIONS.*` 判斷的 API 與頁面守衛（Azure 環境）
> **優先級**: 中（目前 0 users 掛受影響角色，但指派即發作，且每次部署復發）
> **狀態**: ✅ 已修復並已部署 Azure DEV（2026-07-28，映像 `dev-fix139-20260728142008`；7 個角色權限實機確認全部對齊）

---

## 問題描述

Azure DEV 上系統角色的 `permissions` 使用**點號**分隔，而程式碼常量使用**冒號**分隔，兩者永遠比不中。

| 角色 | Azure 實際值 | 程式碼常量（`src/types/role-permissions.ts`）|
|------|-------------|------|
| `Auditor` | `["audit.view", "report.view"]` | `['report:view','report:export','audit:view','audit:export']` |
| `City Manager` | `["city.view","user.view","document.review","report.view"]` | 9 項，全為 `xxx:yyy` |
| `Data Processor` | `["invoice.view","invoice.create","invoice.review"]` | 3 項，全為 `xxx:yyy` |
| `Regional Manager` | `["region.view","city.manage","user.view","report.view"]` | 9 項 |
| `Super User` | `["rule.manage","company.manage","document.review"]` | 11 項 |
| `System` | `["system.internal"]` | — |
| **`System Admin`** | **`["*"]`** | 21 項 |

`'audit.view' !== 'audit:view'`，`Array.prototype.includes` 只做精確比對 → **所有非 wildcard 角色的權限判斷一律回 false**。

### 具體後果：FIX-134 對 Azure 的 Auditor 沒有生效

FIX-134 把審計端點的判斷從「角色**名稱**比對」改成「**權限**比對」，理由是後者較可靠：

```ts
sessionHasAuditAccess(user)
  = sessionHasAnyPermission(user, [PERMISSIONS.AUDIT_VIEW, PERMISSIONS.AUDIT_EXPORT])
  = ['audit.view','report.view'].includes('audit:view')   // → false
```

在**本地**有效（dev seed 寫入冒號格式），在 **Azure 無效**。Auditor 仍被 403 擋下，只是失敗原因從「角色名對不上」換成「權限字串對不上」。

> **FIX-134 本身沒有錯** —— 它修的是程式碼層的三套判斷不一致，在本地驗證通過。本問題出在**資料層**：Azure 的 seed 寫入的值與程式碼常量不同源。

### 目前無實際故障

Azure `/api/roles` 顯示 user 數：`Auditor` **0**、`City Manager` **0**、`Data Processor` **0**、`Regional Manager` **0**、`Super User` **0**、`System` 1、`System Admin` **4**。

實際在用的兩個角色中，`System Admin` 持 `["*"]` —— wildcard 分支會通過（FIX-134 的 BUG-1/BUG-2 修正對它有效）。所以**這是潛在缺陷，不是當前故障**；但只要有人被指派 Auditor 等角色，該帳號會發現自己什麼都不能做。

---

## 重現步驟

1. 在 Azure DEV 建立一個帳號，指派 `Auditor` 角色
2. 以該帳號登入，開啟 `/en/audit/query` 或呼叫 `POST /api/audit/query`
3. 觀察現象：403（`sessionHasAuditAccess` 回 false）

或唯讀確認即可：`GET /api/roles` 比對 `permissions` 與 `src/types/permissions.ts` 的常量值。

---

## 根本原因

`prisma/seed-prod-essential.ts:86-87` 有明文自白：

> permissions 為**佔位字串陣列**（系統角色實際權限由 `ROLE_PERMISSIONS` 在 dev seed 中完整定義；essential seed 只保證角色存在，避免引入 `src/` 依賴使 prod 部署可獨立執行）。

兩條 seed 路徑寫入不同的值：

| 路徑 | 使用時機 | 權限來源 |
|------|---------|---------|
| `prisma/seed.ts`（dev seed）| 本地 `npx prisma db seed` | `ROLE_PERMISSIONS`（`src/types/role-permissions.ts`）—— **冒號、完整** |
| `prisma/seed-prod-essential.ts` | Azure 容器啟動 | 檔案內硬寫的**佔位值** —— 點號、殘缺 |

**設計取捨本身合理**（prod seed 不引入 `src/`，避免 build/執行期耦合），但沒有處理「佔位值與真實常量不同源」的後果。

### 會持續復發

essential seed 每次容器啟動都 upsert。FIX-138 部署後 `updatedAt` 全部變成 `2026-07-28T04:07:35`（即本次部署時間）—— **就算有人手動把 Azure 的權限改對，下次部署又會被蓋回佔位值**。

---

## 解決方案

### 採用：複製值 + 防漂移測試（原選項 C 的強化版，2026-07-28 用戶決定）

三個原選項的成本結構在**實測後**改變了 —— 本文件原標「A（建議）」是在不知道 tsc 行為的情況下寫的。

#### 為何不選 A（實測推翻）

essential seed 之所以不 import `src/`，真正的技術原因是 `Dockerfile:109-111` 用**裸 tsc 單檔編譯**（無 `--project`，故 `@/*` alias 解析不到）：

```
node node_modules/typescript/bin/tsc prisma/seed-prod-essential.ts \
      --outDir prisma/dist --module commonjs --target es2020 ...
```

未指定 `--rootDir` 時 tsc 取所有輸入檔的 common root。**本機實測**（對既有的 `prisma/seed.ts` 跑同一條命令，該檔已 import `../src/types/role-permissions`，exit 0）：

```
<outDir>/prisma/seed.js
<outDir>/src/types/permissions.js
<outDir>/src/types/role-permissions.js
```

一旦 import `../src/**`，common root 上移至專案根，輸出變成 `prisma/dist/prisma/seed-prod-essential.js`，而 `scripts/docker-entrypoint.sh:26` 執行的是 `prisma/dist/seed-prod-essential.js` —— **該步驟在 `set -e` 下失敗即容器起不來**，且本機無法完整驗證（需真的 build 映像）。

換言之 A 的代價不是「抽個常量檔」，而是**改動容器啟動關鍵路徑**。不值得。

#### 實際做法

| # | 動作 |
|---|------|
| 1 | 權限值改為與 `PERMISSIONS` 常量**逐字相符**（含順序），7 個角色全部對齊 |
| 2 | 角色定義抽為純資料檔 `prisma/seed-prod-essential.roles.ts`（**同在 `prisma/` 下**，common root 維持不變）|
| 3 | 新增防漂移測試，任一邊改動未同步即 CI 紅 |

第 2 步是必要的：seed 主檔在 module load 時就建立 `Pool` / `PrismaClient` 並於檔尾呼叫 `main()`，測試 import 它會真的連 DB 並執行 seed。

**實測確認輸出路徑不變**（重構後跑同一條 tsc 命令，exit 0）：

```
<outDir>/seed-prod-essential.js
<outDir>/seed-prod-essential.roles.js
```

兩者都在根層 → `docker-entrypoint.sh` 路徑依然正確，`require('./seed-prod-essential.roles')` 也解析得到。**Dockerfile 與 entrypoint 零改動。**

#### 刻意保留的兩處差異

| 角色 | 值 | 理由 |
|------|-----|------|
| `System Admin` | `['*']`（非 21 項展開）| 語意等價（`sessionHasPermission` 顯式認 wildcard），但**未來新增權限自動涵蓋**；Azure 上實際在用的 4 個帳號即持此值 |
| `System` | `['system:internal']` | essential-seed-only 角色，不在 `ROLE_NAMES`（該常量只含可指派給人的 6 個），故 `PERMISSIONS` 亦無對應項；僅統一為冒號命名慣例 |

測試對這兩處有專屬斷言（wildcard 以 `permissionListHas` 驗證涵蓋全部 `PERMISSIONS`），不是跳過。

> ⚠️ 修正 seed 之後，**既有的 Azure 角色需要被 upsert 覆寫**才會生效（essential seed 每次啟動都跑，所以下次部署即自動修正，不需一次性腳本、不需 gated flag）。

---

## 修改的檔案

| 檔案 | 修改內容 |
|------|----------|
| `prisma/seed-prod-essential.roles.ts` | 🆕 純資料檔（零 import、零副作用）：`RoleSeed` 型別 + 7 個角色，權限值對齊 `PERMISSIONS` |
| `prisma/seed-prod-essential.ts` | 🔧 移除內嵌 `ROLES` 與 `RoleSeed`，改 `import { ROLES } from './seed-prod-essential.roles'`；`@lastModified` 更新 |
| `tests/unit/prisma/essential-seed-permissions.test.ts` | 🆕 13 項防漂移測試（涵蓋範圍 / 逐字對齊 / wildcard 等價 / 格式迴歸守衛）|

**未修改**（刻意）：`src/types/permissions.ts`、`src/types/role-permissions.ts`（保持權威來源不動）、`Dockerfile`、`scripts/docker-entrypoint.sh`（啟動路徑零變更）。

---

## 測試驗證

### 本地（已完成）

- [x] 決定採用哪個選項 —— 複製值 + 防漂移測試（2026-07-28）
- [x] 防漂移測試 13 項全通過（`npx vitest run tests/unit/prisma/essential-seed-permissions.test.ts`）
- [x] **紅→綠驗證**：把 `Auditor` 暫時改回 `['audit.view','report.view']` → **4 條防線同時紅**（逐字對齊 / 有效值 / 點號守衛 / 格式），錯誤訊息指名 `角色「Auditor」的「audit.view」`；還原後回綠
- [x] tsc 輸出路徑實測不變（`seed-prod-essential.js` 與 `.roles.js` 同在 outDir 根層）→ entrypoint 無須改動
- [x] 確認 `System Admin` 的 `['*']` 未被破壞（專屬斷言 + wildcard 涵蓋全部 `PERMISSIONS` 的等價驗證）
- [x] `npm run type-check` / `npm run lint` / `npm run test` 全通過

### Azure DEV（2026-07-28 已部署驗收）

| 項目 | 值 |
|------|-----|
| 映像 | `dev-fix139-20260728142008`（ACR run `ck1g` Succeeded，9m03s）|
| 前一映像 | `dev-fix138-20260728115434` |
| 變更範圍 | **僅 1 個 commit** `d736263` —— 映像與 main 僅差 FIX-139 本身 |
| 前置檢查 | `.env.example` 零變更（無新 env）；8 個 `RUN_*` / `FORCE_SCHEMA_RESET` 全 `false`（不需動）；`docker-entrypoint.sh` CR=0 |
| 健康 | ✅ 200 `{"status":"healthy","services":{"database":"connected"}}` |
| 容器 log | ✅ `Step 1/3` → `Step 2/3` → **`Upserted: Auditor`** → `Step 3/3` → `Ready in 1154ms`；無 `exec: not found`、無 `re2.wasm` ENOENT、無 P20xx |

- [x] `GET /api/roles` 的 `Auditor` 權限為 `["report:view","report:export","audit:view","audit:export"]` —— **點號值已被 upsert 覆寫**
- [x] 其餘 5 個角色同步對齊（City Manager 9 項 / Data Processor 3 項 / Regional Manager 9 項 / Super User 11 項 / System `["system:internal"]`）
- [x] `System Admin` 仍為 `["*"]`，未被破壞（驗收當時即以該角色帳號登入、dashboard 正常載入）
- [ ] 建立 Auditor 帳號登入，`/api/audit/query` 回 200（**FIX-134 BUG-3 唯一能被實機驗證的途徑** —— 本地因 dev bypass 一律 globalAdmin，驗不到）。**未執行**：需在 Azure 建測試帳號，屬資料變更，待授權

> 部署即自動生效經實機確認：essential seed 每次容器啟動都 upsert，**未使用任何 gated flag、未跑一次性腳本**。

### ⚠️ 部署時發現的既有缺陷（不屬 FIX-139，未修）

容器 log 出現 `[entrypoint] (optional) template field mapping seed: mode=false` —— 該旗標明明是 `false` 卻仍被觸發。

`scripts/docker-entrypoint.sh` 對 `RUN_TEMPLATE_MAPPING_SEED` 用 `[ -n "$X" ]`（非空即執行），而字串 `"false"` 非空；其餘旗標都用 `= "true"`。**關閉它的唯一方法是清空該 app setting，設成 `false` 不會關閉。**

嚴重性低：`prisma/seed-template-field-mappings.js:336` 有 unknown mode 保護（`未知 MODE=false…不執行`），所以只浪費一次 node 啟動、無資料變更風險。但屬「防護恰好救了它」而非設計正確，建議另開 FIX 統一為 `= "true"` 判斷。

---

## 相關

- FIX-134 —— 統一權限判斷入口；本問題使其在 Azure 上對非 wildcard 角色無效
- FIX-138 —— 本問題於該次部署驗收時發現
- FIX-140 —— 反過來，本 FIX 的部署 log 掃描又挖出該問題
- `src/lib/auth/has-permission.ts` —— `sessionHasAuditAccess` 等判斷邏輯（程式碼無誤，問題在資料）
- [部署記錄](../../../docs/07-deployment/02-azure-deployment/deployment-records/2026-07-28-dev-fix138-140.md) —— 2026-07-28 三次部署合併記錄

---

*文件建立日期: 2026-07-28*
*最後更新: 2026-07-28*
