# CHANGE-057: API 路由認證覆蓋率提升至 95%（IAM-01 L1 → L3）

> **狀態**: 📋 規劃中（規劃日期 2026-04-28）

## 變更摘要

| 項目 | 內容 |
|------|------|
| **變更編號** | CHANGE-057 |
| **變更日期** | 2026-04-28 |
| **相關模組** | API Routes / Authentication / Middleware |
| **影響範圍** | `src/app/api/**/route.ts`（130 個未保護路由）、`src/middleware.ts`、`src/lib/auth/`、新增 `src/lib/api/with-auth.ts` HOF |
| **優先級** | HIGH |
| **狀態** | 📋 規劃中（規劃日期 2026-04-28） |
| **類型** | Security Hardening / Refactor |
| **依賴** | CHANGE-061（withAuth HOF 設計）— 兩者建議併行；Story 22-4（CI lint rule） |

---

## 問題描述

### 現況

依據 `docs/08-security-and-governance/phase2-iam-dp-assessment.md` IAM-01 章節（評分 L1，HIGH 風險），AI Document Extraction Project 目前 API 路由認證覆蓋率僅 **60.7%（201/331 routes）**，距離企業基準 L3 ≥ 95% 有 34 個百分點差距。

| 指標 | 數值 | 來源 |
|------|------|------|
| 總 route 文件數 | 331 | `phase2-iam-dp-assessment.md` IAM-01 |
| 含 auth 檢查 | 201 | grep `await auth\(\)|getAuthSession|requireAuth|api-key` |
| **覆蓋率** | **60.7%** | 201/331 |
| 目標覆蓋率 | ≥ 95% | 企業基準 L3 |
| 需補保護 routes | **130** | 331 × (95% - 60.7%) |

### 130 個未保護 routes 分類

依 `phase2-iam-dp-assessment.md` IAM-01「未保護的 HIGH 風險 routes」段落列示：

| 域 | 未保護 / 總數 | 覆蓋率 | 風險等級 | 主要敏感資料 |
|-----|-------------|--------|---------|------------|
| `/v1/*` | 63/77 | 18% | 🔴 HIGH | financial、prompt configs、template instances |
| `/companies/*` | 15/15 | 0% | 🔴 HIGH | 公司資料（曾為 forwarder） |
| `/cost/*` | 5/5 | 0% | 🔴 HIGH | 成本/定價資料 |
| `/dashboard/*` | 5/5 | 0% | 🔴 HIGH | 統計（含敏感資料） |
| `/statistics/*` | 4/4 | 0% | 🔴 HIGH | 系統統計 |
| `/mapping/*` | 2/2 | 0% | 🔴 HIGH | 映射規則 |
| `/reports/*` | 8/12 | 33% | 🔴 HIGH | 報表資料 |
| `/n8n/*` | 4/4 | 0% | 🟡 MED | webhook |
| `/workflow-exec/*` | 4/4 | 0% | 🟡 MED | n8n 工作流執行 |
| `/confidence/*` | 2/2 | 0% | 🟡 MED | 信心度查詢 |
| `/auth/*` 公開部分 | 4/7 | 43% | 🟢 LOW（公開設計） | login / register / forgot-password |
| 其他散布 | 14 | — | 🟡 MED | health、misc |

### v1 API 高敏感未保護端點（必先處理）

依 `phase2-iam-dp-assessment.md` IAM-01「v1 API 未保護端點（高敏感）」明列：

- `/v1/exchange-rates/*`（GET, POST）— 財務匯率資料
- `/v1/exchange-rates/import/`（POST）— 批次匯入
- `/v1/prompt-configs/`（GET, POST, PATCH, DELETE）— AI prompt 配置
- `/v1/field-mapping-configs/`（POST）— 建立映射配置
- `/v1/template-instances/`（POST）— 建立實例
- `/v1/pipeline-configs/`（POST）— 管線配置
- `/v1/regions/`（POST）— 區域建立
- `/v1/documents/[id]/match/`（POST）— 修改文件匹配

### 根本原因

依 `phase2-iam-dp-assessment.md` IAM-01「為何不評 L2」分析：

1. **無集中式 API auth middleware**（`src/middleware.ts` L92 跳過所有 `/api`）
2. **`auth.config.ts` `authorized` callback** 僅保護頁面，不對 API 生效
3. **每個 route 必須自行實作 auth** → 容易遺漏
4. **無強制機制**（無 lint rule、無 CI 檢查）
5. **3 套不同的權限檢查模式並存**（IAM-03，CHANGE-061 處理）

---

## 變更內容

### 子變更 1：建立公開 API 白名單

**檔案**：新增 `src/lib/api/public-routes.ts`

明列「合法不需 auth」的路由，避免一刀切誤關公開 endpoint：

```typescript
/**
 * @fileoverview 公開 API 白名單（不需要 auth 檢查）
 * @module lib/api/public-routes
 * @since CHANGE-057
 * @lastModified 2026-04-28
 */

export const PUBLIC_API_ROUTES = [
  // 認證流程（合法公開）
  '/api/auth/[...nextauth]',
  '/api/auth/login',
  '/api/auth/register',
  '/api/auth/forgot-password',
  '/api/auth/reset-password',
  '/api/auth/verify-email',
  '/api/auth/resend-verification',

  // 健康檢查（liveness / readiness）
  '/api/health',

  // 公開 webhook（用 own auth：HMAC、IP 白名單）
  '/api/n8n/webhook',
  '/api/v1/external/webhook',
] as const;

export type PublicRoute = typeof PUBLIC_API_ROUTES[number];

export function isPublicRoute(pathname: string): boolean {
  return PUBLIC_API_ROUTES.some((route) =>
    pathname === route || pathname.startsWith(route + '/')
  );
}
```

**策略**：白名單**遠少於**目前的「預設公開」狀態，所有未列入的 route 必須有 auth check。

### 子變更 2：分批補上 130 個未保護 routes 的 auth

**策略**：依風險等級分 4 批處理，每批一個 PR：

| 批次 | 範圍 | Routes 數 | 預估工時 | 風險 |
|------|------|----------|---------|------|
| **Batch 1** | `/v1/*` 高敏感（financial / configs） | 30-40 | 3-5 天 | 🔴 必先做 |
| **Batch 2** | `/cost/*` + `/dashboard/*` + `/statistics/*` + `/mapping/*` | 16 | 2 天 | 🔴 |
| **Batch 3** | `/companies/*` + `/reports/*` 補完 | 23 | 2-3 天 | 🔴 |
| **Batch 4** | `/n8n/*` + `/workflow-exec/*` + `/confidence/*` + 其他散布 | ~30 | 2 天 | 🟡 |

**每個 route 的修改模式**（採用 CHANGE-061 的 `withAuth` HOF）：

```typescript
// Before（無保護）
export async function GET(request: Request) {
  const data = await someService.getData();
  return Response.json({ success: true, data });
}

// After（CHANGE-061 withAuth HOF）
import { withAuth } from '@/lib/api/with-auth';
import { PERMISSIONS } from '@/types/permissions';

export const GET = withAuth(
  async (request, { session }) => {
    const data = await someService.getData();
    return Response.json({ success: true, data });
  },
  { permissions: [PERMISSIONS.RULE_VIEW] }
);
```

### 子變更 3：CI/Lint 強制檢查

**檔案**：新增 `scripts/check-api-auth-coverage.ts`

CI 腳本檢測所有 `src/app/api/**/route.ts`：
- 排除 `PUBLIC_API_ROUTES` 白名單
- 確認檔案內容含 `withAuth(` 或 `await auth()` 或 `apiKeyService.verify`
- 若缺失 → exit 1（阻擋 PR）

整合到 `.github/workflows/ci.yml`（依賴 Story 22-4）。

### 子變更 4：審計報告

**檔案**：新增 `docs/08-security-and-governance/iam-01-coverage-report.md`

- 記錄 130 個未保護 routes 完整清單（grep 結果輸出）
- Batch 1-4 完成日期與責任人
- 每批完成後更新覆蓋率數字

---

## 影響評估

### 正面影響

| 面向 | 改善 |
|------|------|
| **Auth 覆蓋率** | 60.7% → ≥ 95%（達企業 L3 基準）|
| **130 routes 高敏感資料保護** | 從 0 保護 → 100% 保護 |
| **未來新 route 防呆** | CI 強制 lint 阻擋無 auth 的新 route |
| **架構一致性** | 與 CHANGE-061 共用 withAuth HOF，3 套模式收斂為 1 套 |

### 風險與緩解

| 風險 | 影響 | 緩解 |
|------|------|------|
| **誤關合法公開 route** | 服務中斷 | 公開白名單明列；Batch 4 才處理灰色地帶（n8n webhook 等）|
| **n8n / SharePoint integration 中斷** | 自動化失效 | webhook 用 HMAC + IP 白名單獨立設計（不在本 CHANGE 範疇）|
| **Permission 太嚴格阻擋既有用戶** | 業務功能不可用 | 每個 route 採用「最寬鬆但合理的 permission」（如 `INVOICE_VIEW`），不擅自要求 admin |
| **批次處理間 codebase 不一致** | 開發體驗差 | 每批做完即合併；Batch 1 完成後 update CLAUDE.md 進度欄 |

### 不變範圍

- 不變動既有「已有 auth」的 201 routes 內部邏輯
- 不變動 `auth.config.ts` `authorized` callback（仍針對頁面）
- 不變動 NextAuth provider 設定

---

## 測試計劃

### 單元測試

- [ ] `isPublicRoute()` 正確識別白名單（11 個 case + 1 個非白名單路徑）
- [ ] `check-api-auth-coverage.ts` 偵測無 auth 的 route 並 exit 1
- [ ] `check-api-auth-coverage.ts` 對白名單 route 不誤報

### 整合測試（每批必跑）

- [ ] 未登入呼叫每個被保護的 route → 401
- [ ] 登入但無 permission → 403
- [ ] 登入且有 permission → 200/201
- [ ] 公開 route（health / login）未登入 → 200

### 端對端測試（Batch 1 後完整跑）

- [ ] n8n webhook 透過 own auth 仍可送資料
- [ ] SharePoint integration（自動文件抓取）不受影響
- [ ] 批量上傳 100 張發票流程不中斷
- [ ] Admin 後台所有頁面正常運作（依賴 `/admin/*` 路由）

### 覆蓋率驗證

- [ ] Batch 1 完成：覆蓋率 ≥ 70%
- [ ] Batch 2 完成：覆蓋率 ≥ 80%
- [ ] Batch 3 完成：覆蓋率 ≥ 90%
- [ ] Batch 4 完成：覆蓋率 ≥ 95%
- [ ] CI 檢查腳本 0 false positive、0 false negative

---

## Rollout 策略

### 階段化部署

| 階段 | 動作 | 驗證點 |
|------|------|--------|
| **Phase 0** | CHANGE-061 withAuth HOF 落地（前置） | HOF 單元測試通過 |
| **Phase 1** | 公開白名單 + CI 腳本（不阻擋 build） | grep 對照無漏 |
| **Phase 2** | Batch 1 — `/v1/*` 高敏感 | E2E：n8n / external 整合 |
| **Phase 3** | Batch 2 — `/cost`/`/dashboard`/`/statistics`/`/mapping` | 報表頁面正常 |
| **Phase 4** | Batch 3 — `/companies` + `/reports` 補完 | 公司管理頁面正常 |
| **Phase 5** | Batch 4 — `/n8n`/`/workflow-exec`/`/confidence`/其他 | n8n own auth 檢查 |
| **Phase 6** | CI 切換為強制阻擋 | 新 route 必須走 withAuth |

### Feature Flag

不適用（auth 為 binary 行為，無法 50/50 拆流量）。

### 回滾策略

- 每批獨立 PR、可獨立 revert
- CI 腳本初期僅 warning，1-2 週觀察後切 enforce

---

## 完成標準

- [ ] 公開白名單 `src/lib/api/public-routes.ts` 建立完成
- [ ] Batch 1-4 全部完成，CI 腳本驗證覆蓋率 ≥ 95%
- [ ] CI 強制阻擋無 auth 的新 route（與 Story 22-4 整合）
- [ ] `docs/08-security-and-governance/iam-01-coverage-report.md` 完整報告
- [ ] CLAUDE.md「已知差異」段落 IAM-01 覆蓋率更新為 ≥ 95%
- [ ] `phase2-iam-dp-assessment.md` IAM-01 評分從 L1 升 L3
- [ ] 所有 E2E 測試通過（n8n、SharePoint、Outlook 整合不中斷）

---

## 相關文件

- **Phase 2 評估**：`docs/08-security-and-governance/phase2-iam-dp-assessment.md` IAM-01 章節
- **Governance Matrix**：`docs/08-security-and-governance/enterprise-security-governance-matrix.md` v1.2 IAM-01
- **既有審計**：`docs/06-codebase-analyze/05-security-quality/security-audit.md`（2026-04-09）
- **依賴 CHANGE**：CHANGE-061（withAuth HOF 設計）
- **配套 Story**：Story 22-4（CI lint rule）
- **影響中介層**：`src/middleware.ts`（L92 排除 `/api`）

---

## 風險提示

- **`/v1/*` 公開 API 對外承諾**：若已有外部客戶依賴部分 v1 端點無 auth，需先審查是否需要新增 API key 機制（已存在 `ApiKey` model）
- **Batch 處理時間長**：130 routes 預估 9-12 工作天，期間 codebase auth 模式不一致
- **與 CHANGE-061 強耦合**：必須先完成 CHANGE-061 的 HOF 設計
- **誤改既有業務邏輯風險**：每個 route 補 auth 時應遵循「外科手術式修改」原則，不調整內部邏輯

---

*文件建立日期: 2026-04-28*
*規劃者: Claude AI（Phase 3 Security Hardening）*
*下一步: 與 Stakeholder review 後排定 Batch 1 開始日期*
