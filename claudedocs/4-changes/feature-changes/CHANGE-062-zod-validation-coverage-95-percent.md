# CHANGE-062: Zod 驗證覆蓋率提升至 95%（AppSec-01 L1 → L3）

> **狀態**: 📋 規劃中（規劃日期 2026-04-28）

## 變更摘要

| 項目 | 內容 |
|------|------|
| **變更編號** | CHANGE-062 |
| **變更日期** | 2026-04-28 |
| **相關模組** | API Routes / Input Validation / Zod Schemas |
| **影響範圍** | `src/lib/validations/`（schema 集中化）、`src/app/api/**/route.ts`（36 個未驗證 mutation 端點）、新增 `src/lib/api/with-validation.ts` |
| **優先級** | HIGH |
| **狀態** | 📋 規劃中（規劃日期 2026-04-28） |
| **類型** | Security Hardening / Refactor |
| **依賴** | CHANGE-061（withAuth HOF）— 整合 withValidation；CHANGE-067（如有）— RFC 7807 對齊 |

---

## 問題描述

### 現況

依據 `docs/08-security-and-governance/phase2-appsec-obs-assessment.md` AppSec-01 章節（評分 L1，HIGH 風險）：

| 指標 | 數值 | 來源 |
|------|------|------|
| 變更類路由文件（POST/PATCH/PUT/DELETE） | **183 個** | grep `export\s+async\s+function\s+(POST|PATCH|PUT|DELETE)` |
| 含 Zod 驗證的 API（含 GET query） | 212 個 | grep `z.object` / `.parse(` / `.safeParse(` |
| **mutation 路由 Zod 覆蓋率** | **159/195 = 82%** | `security-audit.md` §4 |
| **未驗證的變更類端點** | **36 個** | `security-audit.md` §4 |
| 已建立的 schema | 9 個 | `src/lib/validations/`（exchange-rate / field-definition-set / outlook-config / pipeline-config / prompt-config / reference-number / region / role / user）|
| 目標覆蓋率 | ≥ 95% | 企業基準 L3 |

### 36 個高風險未驗證端點（依評估報告）

依 `phase2-appsec-obs-assessment.md` AppSec-01 證據：

> 仍未驗證的高風險端點：`/documents/upload`、`/documents/[id]/process`、`/admin/historical-data/upload`、`/admin/backups/[id]`、`/admin/restore/[id]` 等（security-audit.md 第 152-167 行明列 36 個）

### 額外問題

依 `phase2-appsec-obs-assessment.md` AppSec-01「缺口」段落：

1. **Validation schema 散布兩處**：`src/lib/validations/`（新位置）+ `src/validations/`（舊位置）混用
2. **部分路由使用 `JSON.parse()` 直接解析 FormData / body 無 Zod 包裝**：
   - `companies/[id]/route.ts:149`
   - `admin/config/[key]/reset/route.ts:100`
   - `v1/invoices/route.ts:370`

### 與 RFC 7807 不一致的關聯（AppSec-11）

依 `phase2-appsec-obs-assessment.md` AppSec-11：

> top-level vs nested 兩種格式並存於 codebase 中
> 無統一的 `createApiError()` helper 強制執行格式

→ Validation 失敗時錯誤格式也應統一（與 CHANGE-061 共用 helper）。

---

## 變更內容

### 子變更 1：Schema 集中化遷移

**目標**：所有 Zod schema 統一遷移到 `src/lib/validations/`

**動作**：
1. 列出 `src/validations/` 中所有檔案
2. 逐一遷移到 `src/lib/validations/`，更新 import 路徑
3. 刪除空目錄 `src/validations/`
4. 在 `.eslintrc.cjs` 加 `no-restricted-imports` 規則禁止 `src/validations/`

### 子變更 2：建立 withValidation HOF

**新檔案**：`src/lib/api/with-validation.ts`

```typescript
/**
 * @fileoverview 統一 API 輸入驗證 HOF
 * @module lib/api/with-validation
 * @since CHANGE-062
 * @lastModified 2026-04-28
 */
import { NextRequest, NextResponse } from 'next/server';
import { z, ZodError, ZodSchema } from 'zod';
import { validationError } from '@/lib/api/response';

interface WithValidationOptions<TBody, TQuery, TParams> {
  body?: ZodSchema<TBody>;
  query?: ZodSchema<TQuery>;
  params?: ZodSchema<TParams>;
}

interface ValidatedContext<TBody, TQuery, TParams> {
  body: TBody;
  query: TQuery;
  params: TParams;
}

export function withValidation<TBody = unknown, TQuery = unknown, TParams = unknown>(
  handler: (
    request: NextRequest,
    ctx: { params: any; auth?: any; validated: ValidatedContext<TBody, TQuery, TParams> }
  ) => Promise<NextResponse>,
  options: WithValidationOptions<TBody, TQuery, TParams>
) {
  return async (request: NextRequest, ctx: any) => {
    try {
      const validated: any = {};

      // 1. Body validation
      if (options.body) {
        const contentType = request.headers.get('content-type') ?? '';
        let body: any;
        if (contentType.includes('application/json')) {
          body = await request.json();
        } else if (contentType.includes('multipart/form-data')) {
          // 對 FormData，由 caller 在 schema 中處理（File 對象用 z.instanceof(File)）
          body = await request.formData();
          // 若 schema 要求 plain object，先轉換
          body = Object.fromEntries(body.entries());
        } else {
          body = await request.text();
          try {
            body = JSON.parse(body);
          } catch {
            // 非 JSON 留原樣
          }
        }
        validated.body = options.body.parse(body);
      }

      // 2. Query validation
      if (options.query) {
        const query = Object.fromEntries(request.nextUrl.searchParams.entries());
        validated.query = options.query.parse(query);
      }

      // 3. Params validation
      if (options.params && ctx.params) {
        validated.params = options.params.parse(await ctx.params);
      }

      return handler(request, { ...ctx, validated });
    } catch (error) {
      if (error instanceof ZodError) {
        const errors: Record<string, string[]> = {};
        for (const issue of error.issues) {
          const key = issue.path.join('.');
          if (!errors[key]) errors[key] = [];
          errors[key].push(issue.message);
        }
        return validationError(request, errors);
      }
      throw error;  // 由 withAuth 的 error handler 處理
    }
  };
}
```

### 子變更 3：搭配 withAuth 組合使用

**範例**：

```typescript
// src/app/api/admin/users/route.ts
import { withAuth } from '@/lib/api/with-auth';
import { withValidation } from '@/lib/api/with-validation';
import { createUserSchema, listUsersQuerySchema } from '@/lib/validations/user';
import { PERMISSIONS } from '@/types/permissions';

export const GET = withAuth(
  withValidation(
    async (request, { auth, validated }) => {
      const users = await userService.list({
        page: validated.query.page,
        pageSize: validated.query.pageSize,
        cityCodes: auth.cityCodes,
      });
      return apiSuccess(users);
    },
    { query: listUsersQuerySchema }
  ),
  { permissions: [PERMISSIONS.USER_VIEW], cityScope: true }
);

export const POST = withAuth(
  withValidation(
    async (request, { auth, validated }) => {
      const user = await userService.create(validated.body);
      return apiSuccess(user, { status: 201 });
    },
    { body: createUserSchema }
  ),
  { permissions: [PERMISSIONS.USER_CREATE] }
);
```

### 子變更 4：補完 36 個未驗證 mutation 端點

**策略**：依優先級分批

| 批次 | 範圍 | 端點數 | 預估工時 |
|------|------|--------|---------|
| **Batch 1** | 高風險：`/documents/upload`、`/documents/[id]/process`、`/admin/historical-data/upload` | 8 | 3 天 |
| **Batch 2** | Admin：`/admin/backups/[id]`、`/admin/restore/[id]` 系列 | 10 | 2 天 |
| **Batch 3** | 散布的 v1：未列在 CHANGE-057 但仍需 schema | 12 | 2 天 |
| **Batch 4** | 其他低風險 mutation | 6 | 1 天 |

**每個端點需建立**：
1. Schema 檔案（在 `src/lib/validations/` 對應分類）
2. Route.ts 套用 `withValidation`
3. 單元測試覆蓋（valid + invalid input cases）

### 子變更 5：取代裸 JSON.parse 用法

**檔案**：
- `src/app/api/companies/[id]/route.ts:149`
- `src/app/api/admin/config/[key]/reset/route.ts:100`
- `src/app/api/v1/invoices/route.ts:370`

**替換**：用 Zod schema + `withValidation` 取代 `JSON.parse()`。

**新增 helper**：`src/lib/utils/safe-json-parse.ts`（與 AppSec-06 子變更共用）：
```typescript
export function safeJsonParse<T>(text: string, schema: z.ZodSchema<T>): T {
  const parsed = JSON.parse(text);
  return schema.parse(parsed);
}
```

### 子變更 6：Schema 命名規範

**新文件**：`docs/08-security-and-governance/zod-schema-conventions.md`

```
1. 檔案：src/lib/validations/<resource>.ts
2. 命名：
   - createXxxSchema：POST 建立
   - updateXxxSchema：PATCH/PUT 更新
   - listXxxQuerySchema：GET 列表 query
   - xxxParamsSchema：URL params（[id] 等）
3. 共用 schema：src/lib/validations/common.ts
   - paginationSchema、cuidSchema、cityCodeSchema、isoDateSchema
4. 必須 export TypeScript type（推導而非手寫）：
   export type CreateXxxInput = z.infer<typeof createXxxSchema>;
```

### 子變更 7：CI 強制覆蓋率檢查

**新檔案**：`scripts/check-zod-coverage.ts`

CI 腳本：
1. 列出所有 mutation route（POST/PATCH/PUT/DELETE）
2. 排除「設計上無 body 的 DELETE」白名單
3. 確認每個 route 包含 `withValidation` 或顯式 schema 引用
4. 覆蓋率 < 95% → exit 1

### 子變更 8：審計報告

**新檔案**：`docs/08-security-and-governance/appsec-01-coverage-report.md`
- 完整 36 個未驗證端點清單與處理狀態
- Batch 1-4 完成日期
- 最終覆蓋率達成證明

---

## 影響評估

### 正面影響

| 面向 | 改善 |
|------|------|
| **AppSec-01 評分** | L1 → L3（達企業基準）|
| **覆蓋率** | 82% → ≥ 95% |
| **防注入攻擊** | 36 個端點從「無驗證」→ 「強型別 schema」|
| **TypeScript 型別安全** | `z.infer` 自動推導，不再手動維護 type |
| **錯誤訊息一致性** | RFC 7807 + 422 + field-level errors |
| **重複代碼消除** | schema 集中化，減少散布 |

### 風險與緩解

| 風險 | 影響 | 緩解 |
|------|------|------|
| **過嚴 schema 阻擋既有合法資料** | 業務功能中斷 | Phase 1 對抽樣資料 dry-run；保留 graceful warnings 1 週 |
| **FormData / multipart 處理複雜** | upload 端點驗證困難 | 子變更 2 中 withValidation 處理 multipart；File 用 `z.instanceof(File)` |
| **既有 schema 散布兩處遷移衝突** | merge 衝突 | Schema 集中化獨立 PR 先做 |
| **大量 schema 撰寫工作量** | 7-8 工作天 | 與 CHANGE-061 共用 testing 設施減少重工 |
| **GET endpoint query schema 漏網** | 部分 query 仍可注入 | 本 CHANGE 聚焦 mutation；GET query 列為下一階段 |

### 不變範圍

- 不變動既有已驗證 routes 的 schema 內容
- 不變動 Prisma schema（驗證在 application layer）
- 不變動 NextAuth flow

---

## 測試計劃

### 單元測試

- [ ] `withValidation` body schema 解析正確
- [ ] `withValidation` query schema 處理多重值（searchParams.getAll）
- [ ] `withValidation` params schema 處理 dynamic routes
- [ ] ZodError 轉換為 RFC 7807 422 格式
- [ ] FormData / multipart 正確解析
- [ ] 非 JSON content-type 不誤吞錯誤

### 整合測試（每個端點）

- [ ] Valid input → 成功
- [ ] 缺欄位 → 422 + field 名稱
- [ ] 型別錯誤（string vs number）→ 422
- [ ] 範圍超出（min/max）→ 422
- [ ] enum 不在白名單 → 422
- [ ] SQL injection / script injection 攻擊 payload → 被 schema 拒絕

### E2E 測試

- [ ] Document upload 流程：合法 PDF → 通過；惡意 payload → 422
- [ ] Historical data import：合法 Excel → 通過；超大 file → 422 size limit
- [ ] Admin user create：合法資料 → 201；email 格式錯誤 → 422

### 覆蓋率驗證

- [ ] Batch 1 完成：覆蓋率 ≥ 86%
- [ ] Batch 2 完成：覆蓋率 ≥ 90%
- [ ] Batch 3 完成：覆蓋率 ≥ 93%
- [ ] Batch 4 完成：覆蓋率 ≥ 95%
- [ ] CI 腳本驗證通過

---

## Rollout 策略

### 階段化部署

| 階段 | 動作 | 驗證點 |
|------|------|--------|
| **Phase 1** | Schema 集中化遷移（`src/validations/` → `src/lib/validations/`）| import 路徑全部更新 |
| **Phase 2** | `withValidation` HOF + `safeJsonParse` helper | 單元測試通過 |
| **Phase 3** | Batch 1 — 高風險上傳端點 8 個 | E2E：上傳流程 |
| **Phase 4** | Batch 2 — Admin 端點 10 個 | E2E：admin 流程 |
| **Phase 5** | Batch 3 — v1 散布端點 12 個 | E2E：對外 API |
| **Phase 6** | Batch 4 — 剩餘 6 個 + 取代 3 處裸 JSON.parse | 整合測試 |
| **Phase 7** | CI 切換為強制阻擋 | 新 PR 必須 ≥ 95% |

### Feature Flag

不適用（驗證為 binary 行為）。

### 回滾策略

- 每個 batch 獨立 PR、可獨立 revert
- Schema 不過嚴：先用 `.passthrough()` 寬鬆模式 1 週收集 false positive

---

## 完成標準

- [ ] `withValidation` HOF 完成並有 ≥ 90% 單元測試覆蓋
- [ ] Schema 全部集中於 `src/lib/validations/`，舊 `src/validations/` 刪除
- [ ] 36 個未驗證 mutation 端點全部補完
- [ ] 3 處裸 JSON.parse 用法替換為 schema validation
- [ ] CI 腳本 `scripts/check-zod-coverage.ts` 完成並 enforce
- [ ] `docs/08-security-and-governance/zod-schema-conventions.md` 完成
- [ ] `docs/08-security-and-governance/appsec-01-coverage-report.md` 完成
- [ ] `phase2-appsec-obs-assessment.md` AppSec-01 評分 L1 → L3
- [ ] 與 CHANGE-061 整合：所有 withAuth route 可選用 withValidation

---

## 相關文件

- **Phase 2 評估**：`docs/08-security-and-governance/phase2-appsec-obs-assessment.md` AppSec-01 章節
- **既有審計**：`docs/06-codebase-analyze/05-security-quality/security-audit.md` §4（36 個未驗證端點清單）
- **依賴 CHANGE**：CHANGE-061（withAuth HOF）— withValidation 設計與其對齊
- **配套 CHANGE**：CHANGE-060（CSP）、CHANGE-057（Auth 覆蓋率）— 共同目標 L3
- **既有 Schema**：`src/lib/validations/`（9 個現存）

---

## 風險提示

- **FormData / multipart 處理**：upload 端點 schema 撰寫複雜度較高；File 對象用 `z.instanceof(File)` 後 fall back 處理 buffer
- **既有 client 端可能依賴寬鬆驗證**：嚴格化後既有 frontend 可能 422，需 frontend team 同步調整
- **GET query schema 不在範疇**：本 CHANGE 聚焦 mutation；GET 留待 future CHANGE（風險較低）
- **與 CHANGE-061 強耦合**：建議併行 review；若 withAuth 設計變動，withValidation 跟進

---

*文件建立日期: 2026-04-28*
*規劃者: Claude AI（Phase 3 Security Hardening）*
*下一步: Phase 1 Schema 集中化遷移（先做，獨立 PR）*
