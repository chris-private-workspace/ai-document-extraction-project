# CHANGE-056: Prisma Migration Baseline（重建基線）

> **狀態**: 📋 規劃中（待 CHANGE-055 Phase 1 架構評審完成後實施）

## 變更摘要

| 項目 | 內容 |
|------|------|
| **變更編號** | CHANGE-056 |
| **建立日期** | 2026-04-22 |
| **相關模組** | Prisma / Database / Deployment |
| **影響範圍** | `prisma/migrations/` 目錄、本地開發工作流、CI/CD migration 流程、生產部署安全 |
| **優先級** | High（CHANGE-055 Phase 2 前置依賴） |
| **狀態** | 📋 規劃中（待 CHANGE-055 Phase 1 架構評審完成後實施） |
| **類型** | Infrastructure / Technical Debt |
| **依賴** | CHANGE-055（Azure Production Deployment Foundation）— 父規劃決策來源 |
| **被依賴** | CHANGE-055 Phase 2 的「Schema migration 正式化」工作項 |

---

## 問題描述

### 背景

在 CHANGE-055 的 Critical 議題討論中（2026-04-22），使用者定案採用 **方案 A：重建 Migration 基線**，作為 Azure 生產部署的前置條件。由於該工作獨立性高且影響範圍跨越「本地開發工作流」與「CI/CD 生產部署」兩層，拆分為獨立 CHANGE 追蹤管理。

### 現況盤點

| 項目 | 狀態 |
|------|------|
| **Prisma Schema** | `prisma/schema.prisma`（4,354 行、122 models、113 enums） |
| **Migrations 目錄** | `prisma/migrations/` 只有 **10 個 migrations**（最後一個停留在 2025-12-19） |
| **實際 schema 同步方式** | 本地一直使用 `npx prisma db push --accept-data-loss` |
| **Schema 演化差距** | 2025-12-19 後的所有 schema 變更**從未進入 migration 歷史** |
| **生產部署**: 尚未部署，無 `migrate resolve` 狀態同步負擔 |

### 風險

1. **🔴 Prod rollback 不可能**：沒有 migration 歷史就無法 `prisma migrate resolve` 回退特定版本
2. **🔴 資料損失風險**：`db push --accept-data-loss` 在 prod 可能 drop column / index
3. **🔴 審計合規**：schema 變更缺乏 SQL diff 紀錄
4. **🟡 團隊協作**：多人開發時 `db push` 無法處理 schema 衝突

### Prisma 官方立場

> Prisma documentation explicitly warns against using `db push` for production environments. The recommended workflow is `prisma migrate dev` (local) + `prisma migrate deploy` (production).

---

## 變更方案

### 決定：方案 A — 重建 Migration 基線

**已於 CHANGE-055 討論中定案（2026-04-22）**：

| 決策項 | 決定 |
|--------|------|
| 策略 | 方案 A（重建基線），放棄方案 B（繼續 `db push`） |
| 舊 10 個 migrations 處置 | 歸檔到 `prisma/migrations/_archive/`（保留歷史不刪除） |
| 新基線命名 | `0001_initial_baseline`（從頭計數） |
| PoC 先行 | 本地完整 PoC 驗證後才實施 |
| 團隊同步 | 一次性重置所有開發者本地 migration history |

### 執行順序（詳細步驟）

#### Step 1：歸檔舊 migrations（保留歷史）
```bash
# 建立歸檔目錄
mkdir -p prisma/migrations/_archive

# 移動所有舊 migrations 至歸檔（共 10 個）
mv prisma/migrations/2025* prisma/migrations/_archive/
mv prisma/migrations/migration_lock.toml prisma/migrations/_archive/

# 或使用 git 追蹤友善方式
git mv prisma/migrations/2025*/ prisma/migrations/_archive/
```

#### Step 2：建立乾淨 DB 環境
```bash
# 停止應用、備份當前 dev DB（防呆）
pg_dump ai_document_extraction_dev > backup-pre-baseline-$(date +%Y%m%d).sql

# Drop & recreate（本地 docker-compose postgres）
docker-compose exec postgres psql -U postgres -c "DROP DATABASE IF EXISTS ai_document_extraction_dev;"
docker-compose exec postgres psql -U postgres -c "CREATE DATABASE ai_document_extraction_dev;"
```

#### Step 3：生成新基線 migration
```bash
# 從 schema.prisma 產生涵蓋 122 models 的 SQL
npx prisma migrate dev --name initial_baseline

# 預期結果：prisma/migrations/<timestamp>_initial_baseline/migration.sql
# 手動重命名為 0001_initial_baseline（若需要顯式命名）
```

#### Step 4：雙重 diff 驗證（關鍵）
```bash
# 4a. 用新 migration 建立一個 verify DB
createdb ai_document_extraction_verify
DATABASE_URL="postgresql://...verify" npx prisma migrate deploy

# 4b. 從 verify DB 抽出 schema
DATABASE_URL="postgresql://...verify" npx prisma db pull --schema=prisma/schema.verify.prisma

# 4c. 比對 schema.prisma vs schema.verify.prisma
diff prisma/schema.prisma prisma/schema.verify.prisma
# 預期：零差異

# 4d. 若原 dev DB 仍存在，額外比對
DATABASE_URL="postgresql://...old_dev" npx prisma db pull --schema=prisma/schema.old.prisma
diff prisma/schema.prisma prisma/schema.old.prisma
# 預期：零差異（或只有 Prisma 自動格式化差異）

# 4e. 清理臨時檔
rm prisma/schema.verify.prisma prisma/schema.old.prisma
dropdb ai_document_extraction_verify
```

#### Step 5：Seed 重新跑一次驗證
```bash
npx prisma db seed  # 確認 seed 腳本與新 baseline 相容
npm run verify-environment  # CHANGE-054 的自檢腳本
npm run dev  # Smoke test UI
```

#### Step 6：Staging 環境驗證（若有）
在 staging DB 完整跑一次 `migrate deploy` + seed + smoke test，確認 prod 部署流程可行。

#### Step 7：團隊同步（一次性）
發 PR + 通知所有開發者同步本地：
```bash
git pull origin main
rm -rf prisma/migrations  # 清除可能 stale 的本地 migration
git checkout prisma/migrations  # 拉回新 baseline
dropdb && createdb  # 重建本地 DB
npx prisma migrate dev  # 套用新 baseline
npx prisma db seed  # 重建 seed 資料
```

#### Step 8：防呆機制
- **CI 檢查**：在 GitHub Actions 加入 lint 步驟，禁止 PR 引入 `prisma db push` 指令
- **pre-commit hook**：偵測 `package.json` 是否含 `db:push` script，提醒改用 `migrate dev`
- **文件更新**：`docs/06-deployment/02-azure-deployment/database/migration-strategy.md` 記錄流程

---

## 本 CHANGE-056 明確範圍

| 範圍 | 納入？ |
|------|--------|
| 歸檔舊 10 個 migrations | ✅ |
| 生成 `0001_initial_baseline` | ✅ |
| 雙重 diff 驗證流程 | ✅ |
| Staging 驗證（若環境存在） | ✅ |
| 團隊同步溝通 + PR | ✅ |
| CI 防呆機制（ban `db push`） | ✅ |
| `migration-strategy.md` 文件 | ✅ |
| **生產部署執行** | ❌（屬 CHANGE-055 Phase 3） |
| **Azure DB 首次 migrate** | ❌（屬 CHANGE-055 Phase 3） |
| **CI/CD migration hook** | ❌（屬 CHANGE-055 Phase 3） |

---

## 產出文件

| 文件 | 類型 |
|------|------|
| `prisma/migrations/_archive/`（10 個舊 migrations 歸檔） | 程式碼變更 |
| `prisma/migrations/0001_initial_baseline/migration.sql` | 新基線 |
| `prisma/migrations/migration_lock.toml` | 重建 |
| `docs/06-deployment/02-azure-deployment/database/migration-strategy.md` | 策略文件 |
| `claudedocs/5-status/testing/reports/TEST-REPORT-056-migration-baseline-poc.md` | PoC 驗證報告 |
| 本文件（CHANGE-056） | 追蹤 |

---

## 預期效果

| 面向 | 本 CHANGE 完成後 |
|------|----------------|
| **Prod rollback 能力** | ✅ 具備 `migrate resolve` + migration 版本回退能力 |
| **Schema 變更追溯** | ✅ 每次變更都有 SQL diff 可審計 |
| **本地開發流程** | ✅ 禁用 `db push`，統一 `migrate dev` |
| **CI/CD 部署流程** | ✅ 可接入 `migrate deploy` 而無需 `db push --accept-data-loss` |
| **符合 Prisma 最佳實踐** | ✅ |

---

## 驗證方式

### PoC 階段
- [ ] 空 DB → `migrate dev --name initial_baseline` 成功產生 SQL
- [ ] 新 baseline 套用到 verify DB → `db pull` 出的 schema 與 `schema.prisma` **零差異**
- [ ] 新 baseline 套用到 verify DB → `prisma db seed` 成功
- [ ] 新 baseline 套用到 verify DB → `npm run verify-environment` 通過
- [ ] 新 baseline 套用到 verify DB → `npm run dev` UI smoke test 通過

### 整合階段
- [ ] 團隊所有成員本地重建成功（無資料遷移問題）
- [ ] CI 檢查成功擋住 `db push` 指令
- [ ] `migration-strategy.md` 發佈並 onboarding 到 `docs/06-deployment/02-azure-deployment/`

### 生產階段（屬 CHANGE-055 Phase 3，不在本 CHANGE 範圍）
- [ ] Azure PostgreSQL Flexible Server 首次 `migrate deploy` 成功
- [ ] GitHub Actions migration hook 執行成功

---

## 風險與緩解

| 風險 | 等級 | 緩解措施 |
|------|------|---------|
| 某些欄位 / 索引在 diff 中被遺漏 | 🔴 High | 雙重 diff 驗證（verify DB + old dev DB 各一次）+ PoC 階段手動 review |
| 本地 dev 環境重置困擾團隊 | 🟡 Medium | 一次性痛、清晰文件、PR 前先通知 |
| 舊 migrations 含 pre-seeded 資料會消失 | 🟡 Medium | 歸檔不刪除 + `db seed` 重建 + CHANGE-054 的 `exported-data.json` |
| Prisma 版本升級影響 baseline | 🟢 Low | 固定 Prisma 7.2 版本直到下一次主版本規劃 |
| CI `db push` 防呆誤殺合法腳本 | 🟢 Low | 白名單特定路徑（如 scripts/dev-only）|

---

## 關聯文件

- **父 CHANGE**：[CHANGE-055 Azure Production Deployment Foundation](./CHANGE-055-azure-deployment-foundation.md)
- **主規劃文件**：[Azure Deployment Plan §3](../../../docs/06-deployment/02-azure-deployment/azure-deployment-plan.md)
- **前置依賴**：CHANGE-054（本地部署可靠性）、FIX-054（SYSTEM_USER_ID）
- **待建文件**：`docs/06-deployment/02-azure-deployment/database/migration-strategy.md`
- **討論 session**：[20260422.md §Critical 決策結果段落](../../8-conversation-log/daily/20260422.md)

---

## 風險提示

- **不可重複執行**：baseline 重建是一次性操作，若失敗需完全重來，建議先備份
- **團隊時機協調**：需選擇所有成員可同時更新的時間窗（避免 PR 衝突）
- **Seed 資料重建時間**：`exported-data.json` 資料量大，seed 可能需 5-10 分鐘
- **決策可能回溯**：若 PoC 過程發現重大問題，可能需回到 CHANGE-055 重新討論方案

---

## 時程估算

| 階段 | Effort | 依賴 |
|------|--------|------|
| PoC 環境準備 + 新 baseline 生成 | 0.5 day | 空 DB 環境 |
| 雙重 diff 驗證 + 修補（若有差異） | 1 day | PoC 生成 |
| Staging 環境驗證（若有）| 0.5 day | PoC 通過 |
| 團隊同步 + PR + 溝通 | 0.5 day | Staging 驗證 |
| CI 防呆 + 文件化 | 1 day | 並行 |
| **小計** | **~3.5 days** | — |

---

*文件建立日期: 2026-04-22*
*最後更新: 2026-04-22（初稿，待 CHANGE-055 Phase 1 完成後實施）*
*維護者: AI 助手 + 開發團隊*
