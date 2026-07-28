# FIX-139: essential seed 以佔位權限覆寫系統角色，Azure 上非 wildcard 角色的權限判斷全部失效

> **建立日期**: 2026-07-28
> **發現方式**: FIX-138 部署驗收（唯讀查 Azure `/api/roles`）
> **影響頁面/功能**: 所有以 `PERMISSIONS.*` 判斷的 API 與頁面守衛（Azure 環境）
> **優先級**: 中（目前 0 users 掛受影響角色，但指派即發作，且每次部署復發）
> **狀態**: 🚧 待修復

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

三個方向，**需決定後才實作**：

| 選項 | 做法 | 優點 | 代價 |
|------|------|------|------|
| **A（建議）** | 把權限常量抽到一個**零依賴**的獨立檔案（純字串常量，不 import 任何 `src/` 模組），dev seed 與 essential seed 都從它 import | 單一真實來源，不再漂移；保留 prod seed 不依賴 `src/` 的初衷 | 需確認該檔案能被 prod build 的 seed 路徑解析 |
| B | essential seed 只建角色，`permissions` 寫**空陣列** | 最小改動；空陣列至少**誠實**（不會讓人誤以為權限已設好）| 角色完全無權限，仍需其他機制填值 |
| C | 把 `ROLE_PERMISSIONS` 的值**複製**進 essential seed | 改動最小 | 維護兩份，必然再次漂移 —— 這正是當前問題的成因 |

> ⚠️ 修正 seed 之後，**既有的 Azure 角色需要被 upsert 覆寫**才會生效（essential seed 每次啟動都跑，所以下次部署即自動修正，不需一次性腳本）。

---

## 修改的檔案

| 檔案 | 修改內容 |
|------|----------|
| `prisma/seed-prod-essential.ts` | 權限來源改為共用常量（選項 A）或空陣列（選項 B）|
| （選項 A）新增零依賴常量檔 | 供兩條 seed 路徑共用 |
| `src/types/role-permissions.ts` | 可能需調整為從共用常量衍生，避免又變成兩份 |

---

## 測試驗證

- [ ] 決定採用哪個選項
- [ ] 本地 `npx prisma db seed` 後，`roles` 的權限值與 `PERMISSIONS.*` 常量逐字相符
- [ ] 模擬 essential seed 路徑執行後，寫入值與 dev seed 一致
- [ ] 部署到 Azure 後，`GET /api/roles` 的 `Auditor` 權限含 `audit:view` / `audit:export`
- [ ] 建立 Auditor 帳號登入，`/api/audit/query` 回 200（**這也是 FIX-134 BUG-3 唯一能被實機驗證的途徑** —— 本地因 dev bypass 一律 globalAdmin，驗不到）
- [ ] 確認 `System Admin` 的 `["*"]` 未被破壞（4 個帳號在用）

---

## 相關

- FIX-134 —— 統一權限判斷入口；本問題使其在 Azure 上對非 wildcard 角色無效
- FIX-138 —— 本問題於該次部署驗收時發現
- `src/lib/auth/has-permission.ts` —— `sessionHasAuditAccess` 等判斷邏輯（程式碼無誤，問題在資料）

---

*文件建立日期: 2026-07-28*
*最後更新: 2026-07-28*
