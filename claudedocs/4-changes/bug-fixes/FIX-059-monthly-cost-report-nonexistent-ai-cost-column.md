# FIX-059: 月度成本報表兩段原生 SQL 引用不存在的 `documents.ai_cost` 欄位

> **建立日期**: 2026-06-02
> **發現方式**: 代碼審查（驗證 FX 數據流下游時順帶發現，與 FX 功能無關）
> **影響頁面/功能**: 月度成本分攤報表（`/api/reports/monthly-cost` 生成流程：城市統計、每日趨勢）
> **優先級**: 高
> **狀態**: ✅ 已修復

---

## 問題描述

`src/services/monthly-cost-report.service.ts` 有兩段 Prisma `$queryRaw` 原生 SQL 對 `documents` 表執行 `SUM(ai_cost)`，但 PostgreSQL 的 `documents` 表**完全沒有 `ai_cost` 欄位**（也沒有任何 cost / amount 欄位，已用 `information_schema` 與 `prisma/schema.prisma` 雙重驗證）。

由於是 `$queryRaw` 原生 SQL，TypeScript 編譯期無法偵測；但只要月度成本報表被生成（城市統計或每日趨勢被計算），這兩段查詢就會在**執行期**拋出 `column "ai_cost" does not exist`，導致整份報表生成失敗（`generateReport` 進入 catch → 報表狀態被標記為 `FAILED`）。

| # | 問題 | 嚴重度 | 影響位置 |
|---|------|--------|----------|
| BUG-1 | `getCityStats` 用 `COALESCE(SUM(ai_cost), 0) FROM documents` 聚合城市 AI 成本 | 高 | `monthly-cost-report.service.ts` 第 277-292 行（舊） |
| BUG-2 | `getDailyTrend` 用 `COALESCE(SUM(ai_cost), 0) FROM documents` 聚合每日成本 | 高 | `monthly-cost-report.service.ts` 第 351-366 行（舊） |

> 註：`getCityStats` 同時被 `getPreviousMonthStats`（上月比較）呼叫，故 BUG-1 在「當月城市統計」與「上月城市統計」兩處皆會觸發。

---

## 重現步驟

1. 確保 `documents` 表有資料（任一城市、任一日期）。
2. 呼叫 `POST /api/reports/monthly-cost/generate`（body：`{ month: "2026-05", formats: ["excel"] }`），或內部呼叫 `monthlyCostReportService.generateReport(...)`。
3. 觀察現象：`collectReportData` → `getCityStats` / `getDailyTrend` 執行 `$queryRaw` 時拋出 `PostgresError: column "ai_cost" does not exist`，報表記錄 `status` 被更新為 `FAILED`、`errorMessage` 記錄該錯誤。

---

## 根本原因

成本資料**不存在於 `documents` 表**，而是記錄在 `ApiUsageLog` 表（DB 表名 `api_usage_logs`）的 `estimatedCost`（`@db.Decimal(10, 6)`，欄位名 `estimated_cost`）。

這是專案**既定架構**：
- 同檔的 `getApiStats`（按 provider 聚合）已正確使用 `prisma.apiUsageLog.groupBy({ _sum: { estimatedCost } })`。
- `src/services/ai-cost.service.ts`、`src/services/city-cost.service.ts` 全部以 `ApiUsageLog` 為成本來源，且 `city-cost.service.ts` 直接用 `ApiUsageLog.cityCode` 按城市聚合成本。

`ApiUsageLog` 本身具備聚合所需的全部維度欄位（皆已驗證 schema）：
- `cityCode`（非空，`@@index`）→ 可按城市聚合
- `createdAt`（`@@index`）→ 可按日期聚合
- `estimatedCost`（Decimal）→ 成本數值
- `documentId`（可空）→ 可回溯文件

因此本修正屬「**對齊既有架構**」，非偏離設計，**不觸發 H1**（H1 例外明列 bug fix）。

---

## 解決方案

成本來源由 `documents.ai_cost`（不存在）改為 `api_usage_logs.estimated_cost`。文件量（volume，即發票張數）仍正當地來自 `documents`，因此兩個維度需分別查詢後在 JS 合併。

### BUG-1 修復：`getCityStats` 改用型別安全的 `groupBy`（消除原生 SQL）

城市維度不需日期分桶，Prisma Client 可完整表達，故**徹底移除 `$queryRaw`**，改用兩個 `groupBy` 後合併：

```typescript
const [volumeByCity, costByCity] = await Promise.all([
  prisma.document.groupBy({
    by: ['cityCode'],
    where: { createdAt: { gte: startDate, lte: endDate } },
    _count: true,
  }),
  prisma.apiUsageLog.groupBy({
    by: ['cityCode'],
    where: { createdAt: { gte: startDate, lte: endDate } },
    _sum: { estimatedCost: true },
  }),
])
// 以 cityCode 為鍵合併 volume 與 aiCost（無對應成本記錄時 aiCost = 0）
```

此舉同時**根除同類 bug**：未來欄位錯誤會在編譯期被 TypeScript 攔截（原生 SQL 無此保護），並與同檔 `getApiStats` 寫法一致。

### BUG-2 修復：`getDailyTrend` 保留 `$queryRaw` 但拆成正確兩源

每日趨勢需 `GROUP BY DATE(created_at)`，Prisma Client 無法表達日期分桶，故保留 `$queryRaw`（最小外科式修正），但拆為：volume 從 `documents`、cost 從 `api_usage_logs`，再依日期鍵合併。

```sql
-- volume：documents 按日計數
SELECT DATE(created_at) AS date, COUNT(*)::bigint AS volume
FROM documents WHERE created_at >= $1 AND created_at <= $2
GROUP BY DATE(created_at)

-- cost：api_usage_logs 按日加總（正確來源）
SELECT DATE(created_at) AS date, COALESCE(SUM(estimated_cost), 0)::float AS cost
FROM api_usage_logs WHERE created_at >= $1 AND created_at <= $2
GROUP BY DATE(created_at)
```

> 行為一致性：兩段查詢的 volume / cost 仍以「文件為主軸」呈現（與原意一致）；某城市/某日有文件但無 AI 成本記錄時，成本為 0。

---

## 修改的檔案

| 檔案 | 修改內容 |
|------|----------|
| `src/services/monthly-cost-report.service.ts` | `getCityStats` 改用 `document.groupBy` + `apiUsageLog.groupBy` 合併（移除原生 SQL）；`getDailyTrend` 將成本來源由 `documents.ai_cost` 改為 `api_usage_logs.estimated_cost`，volume 仍來自 documents；更新 `@lastModified` |
| `tests/unit/services/monthly-cost-report.test.ts` | 新增：mock prisma，驗證 `getCityStats` / `getDailyTrend` 合併邏輯（成本來自 api_usage_logs、無記錄時為 0、依城市/日期正確合併） |
| `scripts/verify-fix-059-monthly-cost-sql.ts` | 新增：原生 `pg` 煙霧測試，對 dev DB 執行修正後 SQL，證明 `column "ai_cost" does not exist` 已消失（DB 不可達時優雅 SKIP） |

---

## 測試驗證

> 專案目前未安裝測試 runner（`package.json` 無 `test` script、無 vitest/jest binary）。新增 runner 屬 H2（需批准），故本次採「vitest 慣例測試（待 runner 落地即可跑）+ ts-node 可執行煙霧測試（當前可跑）」雙軌交付。

- [x] 型別檢查：`monthly-cost-report.service.ts`（修正本體）與 `scripts/verify-fix-059-monthly-cost-sql.ts` 經 `tsc --noEmit` **零錯誤**。註：repo-wide `npm run type-check` 另有**既有、與本次無關**的失敗（`CityDetailPanel.tsx` recharts 型別、既有 `batch-processor-parallel.test.ts` 無 runner 型別）；新測試檔僅剩 `Cannot find module 'vitest'`（runner 未安裝，屬 H2，待落地）
- [x] ESLint：service 與 test 檔 **0 warning**；`scripts/verify-fix-059-...ts` 僅 `no-console` warning，與既有 `scripts/`（如 `verify-environment.ts` 28 個）一致，故不另加 `eslint-disable`
- [x] `npx ts-node scripts/verify-fix-059-monthly-cost-sql.ts` 對 dev DB **全部通過**：舊 `SUM(ai_cost) FROM documents` 確認拋 `column "ai_cost" does not exist`；修正後 4 段查詢（documents 計數、api_usage_logs 加總 estimated_cost，城市與每日各一）皆成功執行
- [x] 新增 `tests/unit/services/monthly-cost-report.test.ts`（vitest 慣例，mock prisma，runner 落地後可執行）
- [ ] （待後續基礎設施）導入 vitest runner 後納入 CI

---

*文件建立日期: 2026-06-02*
*最後更新: 2026-06-02*
