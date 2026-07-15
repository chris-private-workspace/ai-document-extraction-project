# CHANGE-066: Audit Log 中間件全面採用（Audit Log Middleware Adoption）

> **狀態**: 📋 規劃中

## 變更摘要

| 項目 | 內容 |
|------|------|
| **變更編號** | CHANGE-066 |
| **變更日期** | 2026-04-28 |
| **相關模組** | Audit Log / Middleware / API Routes（331 個） |
| **影響範圍** | `src/middlewares/audit-log.middleware.ts`、`src/app/api/**/route.ts`（331 個檔案分批處理） |
| **優先級** | High |
| **狀態** | 📋 規劃中 |
| **類型** | Security Observability / Compliance |
| **依賴** | 與 CHANGE-061（withAuth HOF）整合可組合使用 |
| **對應安全控制項** | Obs-01（L2 → L3） |
| **Phase 2 報告依據** | `phase2-appsec-obs-assessment.md` §Obs-01、§六發現 5 |

---

## 問題描述

依 Phase 2 盤點 (`phase2-appsec-obs-assessment.md` 第 275-293 行) 結果，本項目的 Audit Log 評分為 **L2（Managed）— 但 API 層採用率 0%**：

> 「`AuditLog` model 完整定義 + 14 種 AuditAction enum + `withAuditLog()` middleware 存在；**API 路由採用率 0%**（grep `withAuditLog\(` 在 API 路由中：**0 個**），audit 寫入完全靠 service 層手動 `auditLog.create()`，多處遺漏失敗路徑。」

### 量化現況

| 指標 | 數值 | 來源 |
|------|------|------|
| API 路由總數 | 331 | `src/app/api/**/route.ts` |
| 變更類路由（POST/PATCH/PUT/DELETE） | 183 | `phase2-appsec-obs-assessment.md` §九 |
| `withAuditLog()` API 採用 | **0** | grep 結果 |
| `auditLog.create` / `auditLogService` Service 採用 | 17 個服務 / 45 處 | 同上 |
| 失敗動作（403/401）audit log | 0% | 服務層只在成功路徑寫 |

### 為何嚴重

- **「文檔有 / 規範完整 / 執行為零」反模式**（Phase 2 報告 §跨領域發現 3）
- **合規風險** — 企業審計需求「100% 敏感操作可追溯」，目前無法滿足
- **遺漏失敗路徑** — 現有手動 `auditLog.create()` 集中在成功路徑，403/401 等存取拒絕無記錄
- **不一致** — 有些 service 寫 audit，有些不寫，靠開發者自律

---

## 變更方案

### 設計原則

1. **漸進式遷移** — 不要求一次改 331 個 route
2. **新 API 強制** — 從即日起，新 route 必須用 `withAuditLog()`
3. **舊 API 分批** — 按敏感度分 4 批，3 個 Sprint 內完成
4. **與 withAuth 組合** — `withAuth(withAuditLog(handler))` 模式
5. **失敗路徑覆蓋** — middleware 自動記錄 401/403/500 / 200 各種狀態
6. **零回歸** — 手動 `auditLog.create()` 不刪除（避免破壞既有），改為「並存」直到全部遷移完成

### 子變更 1：升級 `withAuditLog` middleware

**檔案**：`src/middlewares/audit-log.middleware.ts`（既有，需擴增）

**升級點**：

```typescript
/**
 * @fileoverview Audit Log middleware — 包裝 API route handler 自動記錄敏感操作
 * @module src/middlewares/audit-log.middleware
 * @lastModified 2026-04-28
 */

export interface AuditLogConfig {
  /** 操作類型（CREATE / UPDATE / DELETE / READ / EXPORT 等） */
  action: AuditAction
  /** 資源類型（自動推導：URL pattern → resourceType） */
  resourceType: string
  /** 從 params 或 body 提取 resourceId 的函數（可選） */
  extractResourceId?: (req: NextRequest, params: any) => string | undefined
  /** 是否記錄 request body 變更（敏感資料需 mask） */
  trackChanges?: boolean
  /** 失敗時是否仍記錄（預設 true — 401/403/500 都記） */
  recordFailures?: boolean
}

export function withAuditLog<P = any>(
  handler: ApiHandler<P>,
  config: AuditLogConfig
): ApiHandler<P> {
  return async (req, ctx) => {
    const startTime = Date.now()
    const session = await getAuthSession(req)
    let response: NextResponse | undefined
    let error: unknown

    try {
      response = await handler(req, ctx)
    } catch (e) {
      error = e
      response = handleApiError(e)
    }

    // 失敗也記錄
    const status = response?.status ?? 500
    const isSuccess = status < 400

    if (config.recordFailures !== false || isSuccess) {
      await prisma.auditLog.create({
        data: {
          userId: session?.user?.id ?? null,
          action: config.action,
          resourceType: config.resourceType,
          resourceId: config.extractResourceId?.(req, ctx?.params) ?? null,
          status: isSuccess ? 'SUCCESS' : 'FAILURE',
          ipAddress: getClientIp(req),
          userAgent: req.headers.get('user-agent') ?? null,
          cityCode: session?.user?.cityCode ?? null,
          metadata: {
            method: req.method,
            url: req.nextUrl.pathname,
            statusCode: status,
            durationMs: Date.now() - startTime,
            errorMessage: error instanceof Error ? error.message : undefined,
          },
        },
      })
    }

    if (error) throw error
    return response!
  }
}
```

### 子變更 2：與 `withAuth` HOF 組合

**設計**：與 CHANGE-061（withAuth HOF）相容組合：

```typescript
// 標準組合模式
export const POST = withAuth(
  withAuditLog(
    async (req, { params }) => {
      // handler logic
    },
    { action: 'CREATE', resourceType: 'Document' }
  ),
  { permissions: ['INVOICE_CREATE'] }
)
```

**注意**：`withAuth` 在外層（先檢查權限）→ `withAuditLog` 在內層（記錄結果），這樣 401/403 也會被記錄。

### 子變更 3：四批漸進式遷移

#### 批次 1（W1-W2，~30 個 routes）— 高敏感操作

**對應路由**：用戶/角色/權限變更

```
src/app/api/admin/users/**           — 8 routes
src/app/api/admin/roles/**           — 6 routes
src/app/api/admin/permissions/**     — 4 routes
src/app/api/auth/login               — 1 route（POST）
src/app/api/auth/logout              — 1 route
src/app/api/auth/register            — 1 route
src/app/api/auth/forgot-password     — 1 route
src/app/api/auth/reset-password      — 1 route
src/app/api/admin/api-keys/**        — 6 routes
```

#### 批次 2（W3-W4，~50 個 routes）— 業務 CRUD

```
src/app/api/documents/**             — 19 routes
src/app/api/companies/**             — 12 routes
src/app/api/rules/**                 — 20 routes
src/app/api/reviews/**               — ~10 routes
```

#### 批次 3（W5-W6，~50 個 routes）— Admin 管理

```
src/app/api/admin/companies/**       — N routes
src/app/api/admin/historical-data/** — N routes
src/app/api/admin/backups/**         — N routes
src/app/api/admin/restore/**         — N routes
src/app/api/admin/system-config/**   — N routes
```

#### 批次 4（W7-W8，~50 個 routes）— 整合 + 報表

```
src/app/api/admin/integrations/**    — N routes（n8n / SharePoint / Outlook）
src/app/api/reports/**               — 12 routes
src/app/api/exports/**               — N routes
其他 mutation 端點                    — 殘留
```

> **GET 路由**：原則上不強制（除非涉及敏感資料 EXPORT），預估覆蓋 GET 也 ~50 個。

### 子變更 4：自動化檢查（防止新 API 漏接）

**檔案**：`scripts/check-audit-log-coverage.ts`（新增）

**功能**：
- Glob 所有 `src/app/api/**/route.ts`
- AST parse 找出 export POST/PATCH/PUT/DELETE
- 檢查是否包在 `withAuditLog(...)` 內
- 未包者列出 → CI fail（Phase 4 + CHANGE-070 staging 後）

**加入 `package.json`**：
```json
"audit-log-check": "ts-node scripts/check-audit-log-coverage.ts"
```

### 子變更 5：服務層手動 `auditLog.create` 漸進淘汰

**動作**：
- 第一階段（本 CHANGE）：service 層 `auditLog.create` 與 middleware 並存（duplicate 寫入但對追溯無傷）
- 第二階段（後續 CHANGE）：service 層只保留商業專屬 metadata 寫入，把 actor / resourceId 交由 middleware 記錄
- 第三階段（後續 CHANGE）：徹底移除 service 層 `auditLog.create`（除非有特殊欄位需求）

> **本 CHANGE 不執行第二/三階段** — 為避免破壞既有 17 個服務的測試。

### 子變更 6：i18n 與 admin UI

**對應檔案**：`src/app/[locale]/(dashboard)/admin/audit/page.tsx`（既有）

**動作**：
- audit log 列表頁加 filter「來源：middleware vs service」（從 `metadata.source` 區分）
- 顯示 5xx / 4xx 失敗的 audit 記錄（既有可能漏記）
- i18n 補對應 `audit.source.middleware` / `audit.source.service`

---

## 修改的檔案

| 檔案 | 變更類型 | 預估行數 |
|------|----------|---------|
| `src/middlewares/audit-log.middleware.ts` | 🔄 升級（記錄失敗路徑、metadata 擴增） | +120 -30 |
| `src/middlewares/audit-log.middleware.test.ts` | ➕ 新增單元測試 | ~250 |
| `src/app/api/admin/users/[id]/route.ts` 等 30 個 | 🔄 包 withAuditLog（批次 1） | +5 -0/route |
| `src/app/api/documents/**/*.ts` 等 50 個 | 🔄 包 withAuditLog（批次 2） | 同上 |
| `src/app/api/admin/**` 等 50 個 | 🔄 包 withAuditLog（批次 3） | 同上 |
| 整合 + 報表 50 個 | 🔄 包 withAuditLog（批次 4） | 同上 |
| `scripts/check-audit-log-coverage.ts` | ➕ 新增 | ~150 |
| `package.json` | 🔄 加 `audit-log-check` script | +1 |
| `src/app/[locale]/(dashboard)/admin/audit/page.tsx` | 🔄 加 filter | +30 |
| `messages/{en,zh-TW,zh-CN}/admin.json` | 🔄 加 audit.source.* | +9 |

**總計**: ~180 個 route file 修改（每個 +5 行包 wrapper），+ middleware 升級 + 自動化檢查腳本

---

## 預期效果

### 安全提升

| 面向 | Before | After |
|------|--------|-------|
| Obs-01 評分 | L2（API 層 0%） | L3 |
| Mutation 路由 audit 覆蓋率 | 服務層手動 ~50% | Middleware ≥ 95% |
| 失敗路徑（401/403/500）記錄 | 0% | 100% |
| 401/403 嘗試紀錄 | 無 | 有（可串接 SecurityLog） |
| 自動化覆蓋檢查 | 無 | CI 強制 |

### 業務影響

- ✅ 既有 service 層 `auditLog.create` 不刪除 → 零回歸
- ⚠️ 寫入量增加 ~2×（middleware + service 並寫）— 需評估 audit_logs table 容量
  - 估算：年 450K 文件處理 × 平均 3 mutation/doc = 1.35M 寫入；+1 倍 = 2.7M。PostgreSQL 可承受
- ⚠️ Audit log retention 政策需配套（建議 90 天 hot + 1 年 cold）— 由後續 CHANGE 處理

---

## 測試驗證

### 單元測試（middleware）

- [ ] 成功路徑（200）正確寫入 audit_logs
- [ ] 失敗路徑（401 / 403 / 500）正確寫入 status='FAILURE'
- [ ] `extractResourceId` 從 params 正確提取 ID
- [ ] 與 `withAuth` 組合：權限不足時 audit 仍記錄（status='FAILURE'）
- [ ] PII 欄位（email）不寫入 metadata（呼應 FIX-055）

### 整合測試（每批次完成後）

- [ ] 觸發 30 個批次 1 的 mutation → audit_logs 出現 30 筆 SUCCESS
- [ ] 模擬無權限呼叫 admin/users → audit_logs 出現 FAILURE 記錄
- [ ] Admin UI 可篩選 middleware vs service 來源

### 自動化檢查

- [ ] `npm run audit-log-check` 列出所有未包 withAuditLog 的 mutation route
- [ ] 批次 1 完成後，30 個目標 route 全部通過檢查
- [ ] 4 批全部完成後，183 個 mutation route 通過率 ≥ 95%

---

## 風險提示

- **寫入效能影響**：每個 mutation request 增加 1 次 audit insert（~5-10ms）— 高頻 API 需評估
- **audit_logs 容量爆炸**：2.7M/年 + 中介資料 → 估算 ~10GB/年。需配 retention 政策 + index 規劃
- **與 service 層重複寫入**：本期接受 duplicate，後續 CHANGE 統一遷移
- **批次 1 的 auth/login 路由特殊**：可能涉及 NextAuth 內部，需驗證 wrapper 是否相容
- **PII 風險**：若 `extractResourceId` 從 body 取值不慎包含 email → 需與 FIX-055 maskEmail 配合

---

## 實作順序建議

1. **W1**：升級 middleware + 單元測試 + 自動化檢查腳本
2. **W1-W2**：批次 1（auth + 用戶/角色/權限，30 個）
3. **W3-W4**：批次 2（業務 CRUD，50 個）
4. **W5-W6**：批次 3（admin 管理，50 個）
5. **W7-W8**：批次 4（整合 + 報表，50 個）+ 啟用 CI 強制

---

## 相關文件

- **Phase 2 報告**: `docs/08-security-and-governance/phase2-appsec-obs-assessment.md` §Obs-01
- **既有 middleware**: `src/middlewares/audit-log.middleware.ts`
- **既有 model**: `prisma/schema.prisma` AuditLog (line 280-311) + AuditAction enum (3274-3289)
- **既有 service 層採用**: `src/services/user.service.ts`、`global-admin.service.ts`、`system-config.service.ts` 等 17 個
- **CHANGE-061**: withAuth HOF — 本 CHANGE 與其組合
- **跨領域發現 3**: 「文檔有 / 規範完整 / 執行為零」反模式（current-state-assessment.md §跨領域）

---

## 業務決策待確認

| # | 議題 | 待用戶確認 |
|---|------|-----------|
| 1 | **批次節奏**：4 批 × 2 週 vs 4 批 × 1 週？ | 建議 2 週/批（含驗證） |
| 2 | **GET 路由是否強制**：READ 大量但敏感度低 → 建議僅敏感 GET（reports/exports）強制 | 建議僅敏感 GET 強制 |
| 3 | **Audit_logs retention**：90 天 vs 1 年 vs 永久？ | 建議 90 天 hot + 1 年 cold（額外 CHANGE 處理） |
| 4 | **Service 層 auditLog.create 何時拔除**：本 CHANGE 不動，後續 CHANGE 排期？ | 建議本 CHANGE 不拔，下下個 sprint 規劃 |

---

*文件建立日期: 2026-04-28*
*規劃人: Claude Opus 4.7（依 Phase 2 盤點報告產出）*
*下一步: 用戶審閱 + 業務決策 → 進入實作*
