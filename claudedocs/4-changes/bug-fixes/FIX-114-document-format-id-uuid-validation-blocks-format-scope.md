# FIX-114: documentFormatId 誤用 uuid 驗證，阻斷所有 FORMAT scope 配置建立

> **日期**: 2026-07-20
> **狀態**: ✅ 已修復（本地；type-check / lint 通過）
> **嚴重度**: Sev2（功能阻斷 — FORMAT scope 配置完全無法透過 API/UI 建立）
> **類型**: Bug Fix（驗證 schema 與資料型別不符）
> **影響範圍**: `FieldDefinitionSet` API × 3、`FieldMappingConfig` API × 4

---

## 問題描述

UAT 期間發現「同一間公司、不同文件版面」需要不同提取規則（CEVA 兩種發票版面）。依設計應建立第 2 個 `DocumentFormat` 並掛 FORMAT scope 配置，但實測**無法建立 FORMAT scope 的 `FieldDefinitionSet`**：帶入真實的 `documentFormatId` 會被 Zod 擋在 400，訊息為 `Invalid uuid`。

## 根因分析

`DocumentFormat.id` 使用 **cuid**：

```prisma
// prisma/schema.prisma:2882-2883
model DocumentFormat {
  id String @id @default(cuid())
```

實際值例（本地 CEVA 格式）：`cmqur1q73000vpkxgx48c54jo` — 25 字元、`c` 開頭，是典型 cuid，**不是 uuid**。

但 7 處驗證 schema 把 `documentFormatId` 宣告為 `z.string().uuid()`，導致任何帶真實 format id 的請求必然驗證失敗。

> **對照**：同結構的 `companyId` 用 `.uuid()` 是**正確的** —— `Company.id` 確為 `@default(uuid())`（`schema.prisma:463`）。本次**只動 `documentFormatId`，不動 `companyId`**。

### 受影響位置（7 處）

| # | 檔案 | 行號 | 用途 |
|---|------|------|------|
| 1 | `src/lib/validations/field-definition-set.schema.ts` | 121 | 建立欄位定義集 |
| 2 | `src/lib/validations/field-definition-set.schema.ts` | 252 | 列表查詢篩選 |
| 3 | `src/lib/validations/field-definition-set.schema.ts` | 275 | `/resolve` 三層合併查詢 |
| 4 | `src/app/api/v1/field-mapping-configs/route.ts` | 31 | 列表查詢篩選 |
| 5 | `src/app/api/v1/field-mapping-configs/route.ts` | 48 | 建立映射配置 |
| 6 | `src/app/api/v1/field-mapping-configs/[id]/route.ts` | 34 | 更新映射配置 |
| 7 | `src/app/api/v1/field-mapping-configs/[id]/test/route.ts` | 31 | 測試映射配置 |

### 為何過去沒被發現

- FORMAT scope 配置多半由 `POST /api/v1/formats` 的 `autoCreateConfigs` **在服務層直接建立**（`document-format.service.ts:682-718`），**繞過了 API 層的 Zod 驗證**，因此自動建立路徑一直正常。
- 手動建立 FORMAT scope 配置是低頻操作，直到本次 UAT 需要「同公司多版面」才走到。
- `FieldDefinitionSet` 沒有 `autoCreateConfigs` 對應機制，只能手動建 → 100% 撞牆。

## 修正內容

7 處 `documentFormatId: z.string().uuid()` → `z.string().cuid()`。

採 `.cuid()` 而非 `.min(1)`，理由：對齊最接近的同類 schema `src/lib/validations/prompt-config.schema.ts:378`（同為 lib/validations 下的 FORMAT scope 配置驗證），保留實際格式驗證能力而非放棄驗證。

> 註：專案內另有 `.min(1)` 寫法（`validations/template-field-mapping.ts`、`lib/validations/pipeline-config.schema.ts`）。本次不一併統一，避免超出 task scope（H3）；若要收斂為單一慣例，另立 CHANGE。

## 驗收

| # | 項目 | 標準 | 狀態 |
|---|------|------|------|
| 1 | 7 處全數修正 | grep `documentFormatId: z.string().uuid()` 回傳 0 筆 | ✅ |
| 2 | `companyId` 未被誤改 | `companyId: z.string().uuid()` 保持原狀 | ✅ |
| 3 | 型別檢查 | `npm run type-check` 通過 | ✅ |
| 4 | Lint | `npm run lint` 無新增 warning | ✅ |
| 5 | FORMAT scope 欄位定義集可建立 | 帶 cuid 的 POST 不再回 400 | ⏳ 待 UAT 實測 |
| 6 | FORMAT scope 映射配置可建立/更新 | 同上 | ⏳ 待 UAT 實測 |

## 關聯

- 觸發情境：CEVA 同公司兩種發票版面需分別配置（UAT 2026-07-20）
- 相關：[FIX-105](FIX-105-ceva-duplicate-company-cleanup-rename.md)（CEVA 公司重複清理，連帶刪除 2 筆孤兒格式）
- 已知缺口（**未在本 FIX 範圍**，建議另立 CHANGE）：
  1. `stage-2-format.service.ts:545-546` 的 JIT 建立寫死 `INVOICE`/`GENERAL`，加上唯一鍵 `(companyId, documentType, documentSubtype)`，導致**自動偵測每間公司最多只產生 1 筆格式**，無法自動區分多版面。
  2. `Document` / `ExtractionResult` 無 `documentFormatId` 外鍵，格式僅存於 `stage2Result` JSON，無法用關聯查詢統計格式覆蓋率。
