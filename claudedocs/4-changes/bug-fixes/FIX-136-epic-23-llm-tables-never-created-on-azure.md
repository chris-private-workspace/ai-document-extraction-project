# FIX-136: Epic 23 的三張 LLM 表在 Azure 永遠不會被建立（部署即 P2021）

> **建立日期**: 2026-07-27
> **發現方式**: 依 `AI-HANDOFF.md` 的待辦「上 Azure 前需補 `apply-schema-drift.js` 的 `routing_thresholds` 條目」動手時，發現前置條件不成立——表本身不存在
> **影響頁面/功能**: `admin/llm-providers`（Provider / Model 管理）、`admin/model-settings` 的環節指派、`LlmGatewayService` 的模型解析——凡查 `llm_providers` / `llm_models` / `stage_model_assignments` 者
> **優先級**: 高（部署阻斷級；但生產未暴露——見〈影響範圍〉）
> **狀態**: ✅ 已完成（2026-07-27）—— `apply-schema-drift.js` 補上完整 10 條冪等 DDL，臨時空庫實跑驗證；commit `4178384`

---

## 問題描述

Epic 23 Story 23.1 以 `prisma db push` 在本地建了三張新表，**沒有產生對應的 migration**。而本專案的 Azure 容器啟動流程**不執行** `prisma migrate deploy`，改由 `bootstrap-db.js` 處理 schema。結果是這三張表在 Azure 的**兩條路徑上都不會被建立**：

| 路徑 | `bootstrap-db.js` 的行為 | 三張表 |
|---|---|---|
| 既有 DB（Azure DEV，非空） | `:57-59` 偵測到 `tableCount > 0` → **直接 skip `init.sql`** | ❌ 不建 |
| 全新空庫 | 套用 `init.sql` | ❌ 不建（**`init.sql` 本身就不含這三張表**） |

第二列是本次調查中最反直覺的一點：即使是乾淨部署也不會有這三張表，因為 `init.sql` 是較早的 baseline 產物，Epic 23 的 model 從未被納入。

| # | 問題 | 嚴重度 | 影響 |
|---|------|--------|------|
| BUG-1 | 三張表在 Azure 兩條路徑皆不建立 | 高 | 任何觸及該三表的查詢回 P2021（relation does not exist） |
| BUG-2 | 既有待辦只記「缺 `routing_thresholds` 欄位」，低估了缺口 | 中 | 依該記載動手會寫出一條**必然失敗**的 `ALTER TABLE`（表不存在） |

---

## 重現步驟

1. 取任一非空的 PostgreSQL（模擬 Azure DEV），或任一空庫（模擬乾淨部署）
2. 依 `scripts/docker-entrypoint.sh` 的順序執行 `node prisma/bootstrap-db.js`
3. 查詢 `select * from llm_providers;`
4. 觀察現象：`relation "llm_providers" does not exist`

> 修復前若只補 `routing_thresholds` 欄位條目，`apply-schema-drift.js` 會輸出
> `ERR ... relation "llm_models" does not exist`——欄位補丁本身也無法生效。

---

## 根本原因

三個獨立事實疊加，單看任何一個都不會察覺：

1. **Prisma migration 不會自動到 Azure** —— entrypoint 只跑 `bootstrap-db.js` + gated `apply-schema-drift.js`，沒有 `migrate deploy`。這是既有的已知機制（見 CHANGE-086 的設計說明），非本次新增。
2. **`bootstrap-db.js` 只「空庫才建表」** —— 對非空 DB 直接 return，這是它刻意的設計（避免對既有資料做破壞性操作）。
3. **`init.sql` 未包含 Epic 23 的 model** —— 因此連「空庫」這條退路也失效。

`apply-schema-drift.js` 正是為了填補第 1、2 點而存在的過渡補丁，但 Epic 23 的結構從未被登記進去。

---

## 影響範圍

| 項目 | 狀態 |
|------|------|
| 生產（Azure DEV / 正式） | ❌ **未受影響** —— Epic 23 分支尚未合併、尚未部署，線上不存在會查這三張表的程式碼 |
| 本分支一旦部署（修復前） | 🔴 **必然失敗** —— `admin/llm-providers` 頁面、model-settings 的 id-based 指派、gateway 模型解析全數 P2021 |
| 本地開發 | ✅ 不受影響（`db push` 已建表） |
| 資料損毀風險 | 無（純結構缺失，不會寫入錯誤資料） |

---

## 修復方案

`prisma/apply-schema-drift.js` 的 `MIGRATIONS` 陣列新增 **10 條**冪等 DDL，依依賴順序排列：

| # | 條目 | 冪等手法 |
|---|---|---|
| 1 | enum `LlmProviderType` | `do $$ ... exception when duplicate_object then null` |
| 2–4 | `llm_providers` / `llm_models` / `stage_model_assignments` | `create table if not exists` |
| 5 | `llm_models.routing_thresholds` 欄位 | `add column if not exists` |
| 6–8 | 7 個 index（含 3 個 unique） | `create [unique] index if not exists` |
| 9–10 | 2 個 FK | `do $$ ... exception when duplicate_object then null` |

第 5 條看似與第 3 條重複，實際必要：`create table if not exists` 在表已存在時**整句 skip**，若某環境已有舊版 `llm_models`（無 `routing_thresholds`），只靠建表語句補不到該欄位。

### DDL 來源

不是手寫。由官方工具生成後逐字對齊：

```
npx prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script
```

僅將關鍵字轉小寫以配合該檔既有風格；型別名 `"LlmProviderType"` 大小寫敏感，保留原樣。

---

## 驗證

在臨時空庫 `drift_verify_tmp` 實跑（非推論），驗畢即刪除，未碰任何既有資料：

| 項目 | 結果 |
|------|------|
| 空庫首次執行 | ✅ Epic-23 條目 **10/10 OK**（前面 7 條既有條目 ERR 屬預期——空庫沒有那些表） |
| 重跑一次 | ✅ 輸出**逐字相同**，10/10 OK → 冪等成立 |
| 反向 `migrate diff`（臨時庫 → schema） | ✅ 殘餘差異中**無任何 `llm_*` 項目** → 結構與 `schema.prisma` 完全一致 |
| `npm run type-check` | ✅ 通過 |
| `npm run lint` | ✅ 0 錯誤 |
| `npm run docs:check` | ✅ 243 份 0 錯誤 |

---

## 部署時的必要前提

**必須帶 `RUN_SCHEMA_DRIFT_FIX=true`**（`scripts/docker-entrypoint.sh:20-23`），否則這 10 條不會執行、缺陷原封不動。補完後依既有慣例把旗標設回 false。

---

## 不在本次範圍

| 項目 | 理由 |
|------|------|
| 三張表的**資料** seed | 建表 ≠ 可用。essential seed 不含 LLM provider，`scripts/epic-23/seed-llm-providers.ts` 是 `.ts`、不在 runner 映像內。表建好後皆空 → `getStageModel` 走既有 fallback 鏈（SystemConfig → 硬編 Azure 預設），**行為零變、不會炸**，但後台列表會是空的。需另比照 `prisma/grant-global-admin.js` 寫 `.js` seed + entrypoint gated flag（Story 23.4 或另開 CHANGE） |
| `llm_providers.isDefault` 的 partial unique index | `schema.prisma:4427` 註解寫「唯一性由 partial unique index 保證」，但全 repo 搜不到任何地方建它 → 目前可存在多筆 `is_default = true`。本地與 Azure 同樣缺，屬 Story 23.1 的驗收缺口，修它超出本 FIX 的 scope（H3） |
| 把 Epic 23 的 model 補進 `init.sql` | `init.sql` 是 CHANGE-056（migration baseline）的範疇；drift script 對空庫與非空庫都有效，已足以解決本問題 |

---

## 相關

- **Story 23.1**（Epic 23 資料模型）— 缺失的結構來自該 Story 的 `db push` 未產生 migration
- **Story 23.3 P1** — `routing_thresholds` 欄位（migration `20260727030000`）同樣受此問題影響
- `docs/04-implementation/tech-specs/epic-23-multi-llm-provider/AI-HANDOFF.md` §6 —— 已補記完整發現與部署前提
- CHANGE-086 —— `apply-schema-drift.js` 的建立背景與設計原則
- Commit `4178384`
