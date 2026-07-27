# CHANGE-064: SSRF 防護白名單（Server-Side Request Forgery Whitelist）

> **狀態**: 📋 規劃中

## 變更摘要

| 項目 | 內容 |
|------|------|
| **變更編號** | CHANGE-064 |
| **變更日期** | 2026-04-28 |
| **相關模組** | Webhook / n8n / Microsoft Graph / Azure Blob / 外部 fetch |
| **影響範圍** | `src/services/webhook.service.ts`、`src/services/n8n/*.ts`、`src/services/microsoft-graph.service.ts`、新增 `src/lib/security/ssrf-guard.ts` |
| **優先級** | High |
| **狀態** | 📋 規劃中 |
| **類型** | Security Hardening |
| **依賴** | 無（與 CHANGE-061 withAuth HOF 並行可獨立實施） |
| **對應安全控制項** | AppSec-10（L0 → L3） |
| **Phase 2 報告依據** | `phase2-appsec-obs-assessment.md` §AppSec-10、§五、§六發現 7 |

---

## 問題描述

依 Phase 2 盤點 (`phase2-appsec-obs-assessment.md` 第 215-235 行) 結果，本項目的 SSRF（Server-Side Request Forgery）防護評分為 **L0（Absent）**：

> 「全 codebase 搜尋外部 fetch / URL 呼叫，找到 16 個服務檔有 `await fetch()` 或 `axios`。Webhook URL 沒有任何驗證限制（admin 可填任意 URL，包含 `http://localhost:5432` 內網探測）。全 codebase 搜尋白名單 / `isAllowedHost` / `allowed.*domain`：**0 個**。」

### 5 個高風險外部 URL 入口（盤點實證）

| # | 服務 | 檔案 / 行號 | URL 來源 | 風險級別 |
|---|------|------------|---------|---------|
| 1 | **Webhook 派送** | `src/services/webhook.service.ts:278` | `delivery.targetUrl`（admin UI 設定） | 🔴 HIGH |
| 2 | **n8n Webhook 通知** | `src/services/n8n/n8n-webhook.service.ts:169` | `event.webhookUrl`（DB 設定） | 🔴 HIGH |
| 3 | **n8n Webhook 測試** | `src/services/n8n/webhook-config.service.ts:521` | `testUrl`（admin 直接傳入） | 🔴 HIGH |
| 4 | **n8n Workflow Trigger** | `src/services/n8n/workflow-trigger.service.ts:499` | `workflow.triggerUrl`（DB 設定） | 🔴 HIGH |
| 5 | **Microsoft Graph (SharePoint)** | `src/services/microsoft-graph.service.ts:233/281/415/570` | `siteUrl` / `downloadUrl`（部分使用者輸入） | 🟡 MEDIUM |

> 完整清單見 `phase2-appsec-obs-assessment.md` §五「外部 URL 呼叫清單」。

### 攻擊情境

1. **內網探測**: admin 在 webhook 設定 UI 填寫 `http://169.254.169.254/metadata`（Azure Metadata Service），應用層發送請求 → 洩漏 IMDS token，可能升級為訂閱層級權限竊取
2. **內部服務攻擊**: webhook URL 設為 `http://10.0.0.5:5432`（內網 PostgreSQL）→ 探測內網拓撲
3. **localhost 滲透**: webhook URL 設為 `http://127.0.0.1:6379`（Redis）→ 嘗試非授權存取
4. **DNS Rebinding**: 攻擊者控制的 hostname 第一次解析合法 IP，第二次解析內網 IP（需配 TTL=0 防護）

### 為何嚴重

- **5 個入口完全可控** — admin UI 填表即可發起 fetch
- **無內網阻擋名單** — 169.254.x、10.x、127.x、172.16.x、192.168.x 等私有網段全可呼叫
- **無 hostname 白名單** — 即使知道服務白名單範圍（Azure / SharePoint / n8n），也未在程式中強制
- **MEDIUM/HIGH 帳號被入侵時放大攻擊面** — 即使 admin 帳號被釣魚，也不該能透過 webhook 探測 Azure Metadata

---

## 變更方案

### 設計原則（依 Phase 2 報告 §5.2 緩解策略）

採用 **白名單為主 + 黑名單為輔** 的雙層防禦：

1. **白名單**：明確列出允許的 hostname pattern（Azure / SharePoint / Outlook / DB-stored 動態名單）
2. **黑名單**：強制阻擋私有網段、metadata service、loopback
3. **DNS resolution check**：在 fetch 前 resolve hostname，比對解析後的 IP 是否在黑名單
4. **開發環境例外**：Azurite localhost 等 dev-only URL 透過 `NODE_ENV` guard 例外處理

### 子變更 1：建立 SSRF Guard 工具庫

**檔案**：`src/lib/security/ssrf-guard.ts`（新增）

**核心 API**：

```typescript
/**
 * @fileoverview SSRF 防護工具 — 驗證外部 URL 在發起 fetch 前是否符合白名單與黑名單規則
 * @module src/lib/security/ssrf-guard
 * @since CHANGE-064
 */

export interface SsrfGuardOptions {
  /** 動態白名單（從 DB 讀取的 webhook hostname / n8n hostname） */
  dynamicAllowedHosts?: string[]
  /** 是否允許開發環境 localhost（Azurite / pg） */
  allowDevLocalhost?: boolean
  /** 是否強制 HTTPS（webhook / n8n 預設 true，sharePoint 也應 true） */
  requireHttps?: boolean
}

export class SsrfBlockedError extends Error {
  constructor(public readonly url: string, public readonly reason: string) {
    super(`SSRF blocked: ${reason} (url=${url})`)
    this.name = 'SsrfBlockedError'
  }
}

/** 驗證 URL — 不通過則 throw SsrfBlockedError */
export async function assertSafeUrl(url: string, options?: SsrfGuardOptions): Promise<void>

/** Fetch wrapper — 驗證後呼叫 fetch，否則 throw */
export async function safeFetch(input: string, init?: RequestInit, options?: SsrfGuardOptions): Promise<Response>
```

**白名單預設**（依 Phase 2 §5.2）：

```
ALWAYS_ALLOWED_PATTERNS = [
  /^[a-z0-9-]+\.azurewebsites\.net$/i,
  /^[a-z0-9-]+\.blob\.core\.windows\.net$/i,
  /^[a-z0-9-]+\.openai\.azure\.com$/i,
  /^[a-z0-9-]+\.cognitiveservices\.azure\.com$/i,
  /^graph\.microsoft\.com$/i,
  /^login\.microsoftonline\.com$/i,
  /^[a-z0-9-]+\.sharepoint\.com$/i,
  /^outlook\.office\.com$/i,
]
```

**黑名單**（強制 + 不可關閉）：

```
BLOCKED_HOSTS = [
  '169.254.169.254',     // Azure IMDS
  '169.254.0.0/16',       // Link-local
  '127.0.0.0/8',          // Loopback
  '10.0.0.0/8',           // Private
  '172.16.0.0/12',        // Private
  '192.168.0.0/16',       // Private
  '0.0.0.0',
  '::1',
  'fe80::/10',            // IPv6 link-local
]
```

**開發環境例外**（僅在 `NODE_ENV !== 'production'` 且 `allowDevLocalhost: true`）：

```
DEV_ALLOWED_LOCALHOST_PORTS = [10010, 10011, 10012, 5433]
```

### 子變更 2：DB 增加動態白名單表（可選，一期實作）

**檔案**：`prisma/schema.prisma`（新增 model）

```prisma
model WebhookAllowedHost {
  id          String   @id @default(uuid())
  hostname    String   @unique
  description String?
  enabled     Boolean  @default(true)
  createdAt   DateTime @default(now())
  createdBy   String

  @@index([enabled])
  @@map("webhook_allowed_hosts")
}
```

**Migration**：`npx prisma migrate dev --name add_webhook_allowed_hosts`

> 取捨：本期可暫不引入 DB 表，動態名單從環境變數 `SSRF_ALLOWED_DYNAMIC_HOSTS=hosta.com,hostb.com` 讀取（部署簡單）。下期視運維需求再升級為 DB 管理 UI。

### 子變更 3：替換 5 個 fetch 點為 safeFetch

| 檔案 | 行號 | 變更 |
|------|------|------|
| `src/services/webhook.service.ts` | 278 | `await fetch(delivery.targetUrl, ...)` → `await safeFetch(delivery.targetUrl, ..., { dynamicAllowedHosts: webhookHosts, requireHttps: true })` |
| `src/services/n8n/n8n-webhook.service.ts` | 169 | `await fetch(event.webhookUrl, ...)` → `await safeFetch(...)` |
| `src/services/n8n/webhook-config.service.ts` | 521 | webhook 測試端點同上 |
| `src/services/n8n/workflow-trigger.service.ts` | 499 | workflow trigger 同上 |
| `src/services/microsoft-graph.service.ts` | 233/281/415/570 | 限制 `*.microsoftonline.com` / `graph.microsoft.com` / `*.sharepoint.com` |

### 子變更 4：Admin UI 設定時做 sync 白名單檢查

**檔案**：`src/app/api/admin/integrations/webhook/route.ts` 等管理端點

**動作**：
- 新增 webhook config / n8n config 時，呼叫 `assertSafeUrl(url, { dynamicAllowedHosts })`
- 不通過則回傳 RFC 7807 錯誤 `400 SSRF_HOST_BLOCKED`

### 子變更 5：開發環境 Azurite 例外處理

**檔案**：`src/lib/azure/storage.ts`（既有）

**動作**：
- Azure Blob SDK 內部呼叫無需 SSRF guard（環境變數固定，非使用者輸入）
- 若 `BlobEndpoint=http://127.0.0.1:10010/devstoreaccount1`（Azurite）+ `NODE_ENV=development` → 維持原行為
- 確保 `NODE_ENV=production` 時 BlobEndpoint 強制為 `*.blob.core.windows.net`

### 子變更 6：日誌與告警

**檔案**：`src/lib/security/ssrf-guard.ts`

**動作**：
- 阻擋的 URL 寫入 `securityLog.create({ eventType: 'SUSPICIOUS_ACTIVITY', severity: 'HIGH', metadata: { url, reason } })`
- 對應 Obs-03 SecurityLog 補完，並可串接 CHANGE-065 告警機制

---

## 修改的檔案

| 檔案 | 變更類型 | 預估行數 |
|------|----------|---------|
| `src/lib/security/ssrf-guard.ts` | ➕ 新增（白名單 + 黑名單 + DNS check + safeFetch wrapper） | ~280 行 |
| `src/lib/security/ssrf-guard.test.ts` | ➕ 新增（單元測試） | ~200 行 |
| `src/services/webhook.service.ts` | 🔄 替換 fetch → safeFetch | +5 -2 |
| `src/services/n8n/n8n-webhook.service.ts` | 🔄 同上 | +5 -2 |
| `src/services/n8n/webhook-config.service.ts` | 🔄 同上 | +5 -2 |
| `src/services/n8n/workflow-trigger.service.ts` | 🔄 同上 | +5 -2 |
| `src/services/microsoft-graph.service.ts` | 🔄 4 處 fetch 替換 | +12 -8 |
| `src/app/api/admin/integrations/webhook/route.ts` | 🔄 加 sync 驗證 | +10 |
| `src/app/api/admin/integrations/n8n/route.ts` | 🔄 加 sync 驗證 | +10 |
| `.env.example` | ➕ 新增 `SSRF_ALLOWED_DYNAMIC_HOSTS=` | +3 |
| `messages/{en,zh-TW,zh-CN}/errors.json` | ➕ 新增 `ssrfHostBlocked` key | +9 |
| `prisma/schema.prisma` | 🔄 新增 `WebhookAllowedHost` model（可選） | +12 |

---

## 預期效果

### 安全提升

| 面向 | Before | After |
|------|--------|-------|
| AppSec-10 評分 | L0（Absent） | L3（Defined） |
| 內網探測攻擊面 | 5 個入口完全開放 | 5 個入口黑名單阻擋 + IMDS 強制 deny |
| Hostname 白名單 | 無 | Azure / SharePoint / Graph / Outlook 強制白名單 |
| Admin UI 設定錯誤偵測 | 無（runtime fail） | 設定時即拒絕（400） |
| DNS Rebinding 防護 | 無 | resolve 後比對 IP（黑名單再次驗證） |

### 業務影響

- ✅ Webhook / n8n / SharePoint 既有設定**不受影響**（皆在白名單內）
- ⚠️ Admin 若曾設定內網 webhook（用於 dev/test）→ 需改用 `NODE_ENV=development` 環境
- ⚠️ Microsoft Graph downloadUrl 部分動態 — 需在 staging 驗證 `*.sharepoint.com` 白名單未誤擋

---

## 測試驗證

### 單元測試（`ssrf-guard.test.ts`）

- [ ] 白名單 hostname 通過（`*.blob.core.windows.net`、`graph.microsoft.com`）
- [ ] 黑名單 IP 阻擋（`169.254.169.254`、`127.0.0.1`、`10.0.0.5`）
- [ ] DNS rebinding：hostname 解析到內網 IP 也被阻擋
- [ ] 開發環境 Azurite localhost:10010 通過（`NODE_ENV=development`）
- [ ] 生產環境 localhost 阻擋（即使 `allowDevLocalhost: true`）
- [ ] 動態白名單（`dynamicAllowedHosts`）通過 + 不在名單者阻擋
- [ ] 強制 HTTPS：`http://` URL 阻擋（`requireHttps: true`）
- [ ] 阻擋時寫入 SecurityLog

### 整合測試

- [ ] Webhook 設定 UI 填 `http://169.254.169.254` → 400 錯誤
- [ ] Webhook 設定 UI 填 `https://valid-host.com` → 通過
- [ ] n8n webhook 測試 API 拒絕 `http://10.0.0.5`
- [ ] SharePoint downloadUrl 解析正常（白名單 `*.sharepoint.com`）

### E2E 測試（既有功能不退化）

- [ ] 既有所有有效 webhook 派送成功（不受白名單誤擋）
- [ ] n8n workflow 觸發成功
- [ ] SharePoint 文件下載成功（含 multi-hop redirect）

---

## 風險提示

- **DNS resolution 增加延遲**：每次 fetch 前 resolve hostname 增加約 5-50ms（可用 cache 緩解）
- **白名單覆蓋不全的回歸風險**：若實際 SharePoint 文件下載走 CDN 域（如 `*.svc.ms`），需動態加入。建議在 staging report-only 模式跑 1 週收集實際 hostname 後再 enforce
- **動態白名單管理 UI 暫缺**：本期靠環境變數，運維每次調整需重啟 ACA → 後續需 admin UI 補完
- **DB-stored webhook URL 已含內網位址的歷史資料**：upgrade 後會破壞 → 需提前掃描 `webhook_configs` table 並 alert admin 修正

---

## 實作順序建議

1. **W1**：建立 `ssrf-guard.ts` + 單元測試（不接 fetch 點）
2. **W1-W2**：在 staging 環境用 report-only 模式（log but allow）跑 1 週，收集實際呼叫的 hostname
3. **W2**：依收集結果調整白名單 / 動態名單
4. **W3**：替換 5 個 fetch 點 + admin UI sync 驗證
5. **W3**：對接 SecurityLog + CHANGE-065 Email 告警
6. **W4**：移除 report-only 進入 enforce 模式

---

## 相關文件

- **Phase 2 報告**: `docs/08-security-and-governance/phase2-appsec-obs-assessment.md` §AppSec-10、§五、§六發現 7
- **企業安全治理矩陣**: `docs/08-security-and-governance/enterprise-security-governance-matrix.md` v1.2 §3.3 SSRF 緩解策略
- **CHANGE-065**: Email 告警 — SSRF 阻擋事件可串接 SecurityLog → 告警
- **既有 SecurityLog**: `prisma/schema.prisma` line 1010-1034 / `src/services/security-log.ts`
- **既有 fetch 盤點**: `phase2-appsec-obs-assessment.md` §5.1 完整清單

---

## 業務決策待確認

| # | 議題 | 待用戶確認 |
|---|------|-----------|
| 1 | **動態白名單管理機制**：環境變數（簡單）vs DB + admin UI（彈性）？ | 建議一期環境變數 |
| 2 | **既有歷史 webhook URL 含內網位址**：強制清理 vs Soft-deprecate？ | 建議掃描後 admin 主動修正 |
| 3 | **Microsoft Graph downloadUrl CDN 域處理**：白名單擴增 vs 走 SDK 不檢查？ | 建議 staging 驗證後再決 |

---

*文件建立日期: 2026-04-28*
*規劃人: Claude Opus 4.7（依 Phase 2 盤點報告產出）*
*下一步: 用戶審閱 + 業務決策 → 進入實作*
