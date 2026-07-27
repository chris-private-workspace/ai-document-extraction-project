# CHANGE-065: Email 安全告警 5 條（Email Security Alerts — 5 Critical Rules）

> **狀態**: 📋 規劃中

## 變更摘要

| 項目 | 內容 |
|------|------|
| **變更編號** | CHANGE-065 |
| **變更日期** | 2026-04-28 |
| **相關模組** | Alert / Notification / Health Check / Auth / DB |
| **影響範圍** | `src/services/alert-rule.service.ts`、`src/services/alert-evaluation.service.ts`、`prisma/seed.ts`（seed 5 條告警規則）、新增 `src/services/security-alert-evaluator.service.ts` |
| **優先級** | High |
| **狀態** | 📋 規劃中 |
| **類型** | Security Observability |
| **依賴** | 無（複用既有 Nodemailer + Alert Rule Service） |
| **對應安全控制項** | Obs-05-lite（L1 → L3） |
| **Phase 2 報告依據** | `phase2-appsec-obs-assessment.md` §Obs-05-lite、`enterprise-security-governance-matrix.md` v1.2 §4.3 |

---

## 問題描述

依 Phase 2 盤點 (`phase2-appsec-obs-assessment.md` 第 318-333 行) 結果，本項目的告警機制評分為 **L1（Initial）**：

> 「Nodemailer 已整合 + Alert system（Epic 12）已存在；但目前用於業務告警（如成本異常），**未配置安全告警規則**。矩陣 §4.3 列出的 5 條關鍵告警 — **0/5 已實作**。」

### 5 條關鍵安全告警（v1.2 矩陣 §4.3 必須項）

| # | 告警 | 觸發條件 | 嚴重度 | 收件人 |
|---|------|---------|--------|-------|
| 1 | **Auth Failure Spike** | 5 分鐘內失敗登入 > 50 次 | HIGH | Security Owner + DevOps |
| 2 | **API Error Rate** | 5 分鐘內 5xx 回應佔比 > 5% | HIGH | DevOps |
| 3 | **DB Connection Failure** | 連續 3 次 health check `prisma.$queryRaw\`SELECT 1\`` 失敗 | CRITICAL | DevOps + DBA |
| 4 | **Disk Usage** | 持久卷 / Blob storage 使用 > 85% | MEDIUM | DevOps |
| 5 | **Critical Service Health** | `/health/readiness` 連續 3 次失敗（任一關鍵依賴掉線） | CRITICAL | DevOps |

### 為何嚴重

- **無實時告警** — Pilot 上線後若認證端點被暴力破解，5 分鐘內 50 次失敗無人察覺
- **既有設施未利用** — Alert Rule Service / Nodemailer / SecurityLog 都已存在，缺的是 5 條 seed rule + 評估邏輯
- **零成本 Quick Win** — v1.2 矩陣標註「複用既有 Nodemailer + alert-rule.service.ts 框架」

---

## 變更方案

### 設計原則

1. **複用既有 Alert Rule 框架**（Epic 12）— 不另建系統
2. **Report-Only 一週調優閾值** — 避免初期誤報疲勞
3. **多通道告警** — Email（必須） + 未來可擴 Teams/Slack
4. **去重 + 抑制** — 同類告警 5 分鐘內最多 1 封 Email（避免轟炸）

### 子變更 1：Seed 5 條安全告警規則

**檔案**：`prisma/seed.ts`（擴增）

**動作**：在既有 `alertRules.upsert` 區塊後，加入 5 條告警規則：

```typescript
const securityAlertRules = [
  {
    code: 'SEC_AUTH_FAILURE_SPIKE',
    name: 'Auth Failure Spike',
    category: 'SECURITY',
    severity: 'HIGH',
    metric: 'auth_failure_count',
    operator: 'GT',
    threshold: 50,
    window: '5m',
    enabled: false,  // 預設關閉，Report-Only 一週後啟用
    description: '5 分鐘內失敗登入次數超過閾值（暴力破解防護）',
  },
  {
    code: 'SEC_API_ERROR_RATE',
    name: 'API Error Rate',
    category: 'SECURITY',
    severity: 'HIGH',
    metric: 'api_5xx_rate',
    operator: 'GT',
    threshold: 0.05,  // 5%
    window: '5m',
    enabled: false,
    description: 'API 5xx 回應佔比過高（系統異常或攻擊跡象）',
  },
  {
    code: 'SEC_DB_CONNECTION_FAILURE',
    name: 'DB Connection Failure',
    category: 'INFRASTRUCTURE',
    severity: 'CRITICAL',
    metric: 'db_health_check_consecutive_failures',
    operator: 'GTE',
    threshold: 3,
    window: '3m',
    enabled: true,  // 立即啟用（極關鍵）
    description: '資料庫連線連續 3 次健康檢查失敗',
  },
  {
    code: 'SEC_DISK_USAGE',
    name: 'Disk Usage High',
    category: 'INFRASTRUCTURE',
    severity: 'MEDIUM',
    metric: 'disk_usage_percent',
    operator: 'GT',
    threshold: 85,
    window: '15m',
    enabled: false,
    description: '持久卷或 Blob 容器使用率超過 85%',
  },
  {
    code: 'SEC_SERVICE_HEALTH_FAILURE',
    name: 'Critical Service Health Failure',
    category: 'INFRASTRUCTURE',
    severity: 'CRITICAL',
    metric: 'readiness_consecutive_failures',
    operator: 'GTE',
    threshold: 3,
    window: '3m',
    enabled: true,  // 立即啟用
    description: '/health/readiness 連續 3 次失敗（關鍵依賴掉線）',
  },
]
```

**對應 enum 補完**（若不存在）：`prisma/schema.prisma`

```prisma
enum AlertCategory {
  COST
  PERFORMANCE
  ERROR
  SECURITY      // 新增
  INFRASTRUCTURE // 新增
}
```

### 子變更 2：建立 Security Alert Evaluator

**檔案**：`src/services/security-alert-evaluator.service.ts`（新增）

**職責**：從多個資料源聚合安全指標，與 alert-rule 比對後觸發 evaluation。

**核心方法**：

```typescript
/**
 * @fileoverview 安全告警評估器 — 從 SecurityLog / API metrics / health check 聚合指標
 * @module src/services/security-alert-evaluator
 * @since CHANGE-065
 */

export class SecurityAlertEvaluatorService {
  /** 計算過去 N 分鐘 auth failure 次數（從 SecurityLog） */
  async getAuthFailureCount(windowMinutes: number): Promise<number>

  /** 計算過去 N 分鐘 5xx 比例（需先建立 api-metrics 服務或查 audit log） */
  async getApiErrorRate(windowMinutes: number): Promise<number>

  /** 連續 N 次 DB health check 失敗計數（從 health-check.service 暴露） */
  async getDbHealthFailureStreak(): Promise<number>

  /** 持久卷使用率（dev: fs.statfs；prod: Azure Storage SDK quota） */
  async getDiskUsagePercent(): Promise<number>

  /** /health/readiness 連續失敗計數 */
  async getReadinessFailureStreak(): Promise<number>

  /** 主入口 — 由 alert-evaluation-job 定期呼叫 */
  async evaluateAll(): Promise<AlertEvaluationResult[]>
}
```

### 子變更 3：擴增 Auth 失敗事件寫入 SecurityLog

**對應**：Phase 2 報告 Obs-03 「沒記錄 Auth 失敗」缺口

**檔案**：`src/lib/auth.config.ts`

**動作**：在既有 `authorize` callback failure 路徑（FIX-050 已修為 logger）補充：

```typescript
// authorize() 失敗時除既有 logger 外，補寫 SecurityLog
await prisma.securityLog.create({
  data: {
    eventType: 'UNAUTHORIZED_ACCESS_ATTEMPT',
    severity: 'MEDIUM',
    userId: null,
    ipAddress: getClientIp(req),
    userAgent: req.headers.get('user-agent') ?? null,
    metadata: {
      reason: 'invalid_credentials',
      // 不存 email PII（呼應 FIX-050 / FIX-055 PII 規則）
    },
  },
})
```

### 子變更 4：擴增 alert-evaluation-job 定期任務

**檔案**：`src/services/alert-evaluation-job.ts`

**動作**：在既有 cron 任務中加入 `SecurityAlertEvaluatorService.evaluateAll()` 呼叫：

```typescript
// 每分鐘執行
async function alertEvaluationJob() {
  const businessAlerts = await alertEvaluationService.evaluateAll()
  const securityAlerts = await securityAlertEvaluator.evaluateAll()  // 新增

  for (const alert of [...businessAlerts, ...securityAlerts]) {
    if (alert.triggered) {
      await alertNotificationService.dispatch(alert)
    }
  }
}
```

### 子變更 5：去重抑制邏輯

**檔案**：`src/services/alert-notification.service.ts`（既有）

**動作**：新增「同 ruleCode + 相同收件人」5 分鐘內最多 1 封的限流邏輯：

```typescript
private async shouldSuppress(ruleCode: string, recipient: string): Promise<boolean> {
  const lastSent = await prisma.alertEvent.findFirst({
    where: {
      ruleCode,
      recipient,
      sentAt: { gte: new Date(Date.now() - 5 * 60 * 1000) },
    },
    orderBy: { sentAt: 'desc' },
  })
  return Boolean(lastSent)
}
```

> **注意**：FIX-055 將同步修復 `alert-notification.service.ts:408` 的 PII log。本 CHANGE 與 FIX-055 應協調實施，避免分開修改造成衝突。

### 子變更 6：i18n 翻譯（告警 Email 主旨/內文）

**檔案**：`messages/{en,zh-TW,zh-CN}/alerts.json`（新增命名空間或併入既有）

```json
{
  "security": {
    "authFailureSpike": {
      "subject": "[安全告警] 登入失敗激增 — {count} 次/{window}",
      "body": "在過去 {window} 內偵測到 {count} 次失敗登入嘗試，超過閾值 {threshold}。請立即檢查 SecurityLog。"
    },
    "apiErrorRate": { ... },
    "dbConnectionFailure": { ... },
    "diskUsage": { ... },
    "serviceHealth": { ... }
  }
}
```

> **i18n 規則**：依 `.claude/rules/i18n.md` 必須同步 3 語言，並加入 `src/i18n/request.ts` 的 namespace 陣列（若是新命名空間）。

### 子變更 7：admin UI 告警規則管理

**檔案**：`src/app/[locale]/(dashboard)/admin/alerts/page.tsx`（既有）

**動作**：
- 新增「Security」分類 tab，列出 5 條規則
- 提供「啟用/停用」toggle
- 顯示「最近 7 天觸發次數」（用於 Report-Only 階段判斷誤報率）

---

## 修改的檔案

| 檔案 | 變更類型 | 預估行數 |
|------|----------|---------|
| `prisma/seed.ts` | 🔄 新增 5 條 seed rule | +60 |
| `prisma/schema.prisma` | 🔄 補 enum SECURITY/INFRASTRUCTURE | +2 |
| `src/services/security-alert-evaluator.service.ts` | ➕ 新增 | ~200 |
| `src/services/alert-evaluation-job.ts` | 🔄 整合 securityAlertEvaluator | +10 |
| `src/services/alert-notification.service.ts` | 🔄 加去重抑制 | +25 |
| `src/lib/auth.config.ts` | 🔄 失敗時寫 SecurityLog | +15 |
| `src/services/health-check.service.ts` | 🔄 暴露連續失敗計數 | +20 |
| `src/services/alert-evaluation.service.ts` | 🔄 支援新 metric type | +15 |
| `messages/{en,zh-TW,zh-CN}/alerts.json` | ➕ 新增 5 條翻譯（×3 語言） | +120 |
| `src/i18n/request.ts` | 🔄 註冊 alerts namespace（若新增） | +1 |
| `src/app/[locale]/(dashboard)/admin/alerts/page.tsx` | 🔄 新增 Security tab | +60 |
| `src/app/api/admin/alerts/security/route.ts` | ➕ 新增（管理 + Report-Only 統計） | ~120 |

---

## 預期效果

### 安全提升

| 面向 | Before | After |
|------|--------|-------|
| Obs-05-lite 評分 | L1 | L3 |
| 5 條安全告警 | 0/5 | 5/5 |
| Auth failure 偵測 | 無 | < 5 分鐘內告警 |
| DB 失敗偵測 | 無 | < 3 分鐘內 CRITICAL 告警 |
| 服務健康監控 | 僅 /health 端點 | 連續失敗 → 告警 |

### 業務影響

- ✅ 既有業務告警不受影響（Alert framework 完全相容）
- ⚠️ Email volume 預估每月 < 100 封（含誤報）— 不會造成 SMTP 配額問題
- ⚠️ 初期 1 週 Report-Only 階段需追蹤誤報率，調整閾值

---

## 測試驗證

### 單元測試

- [ ] `SecurityAlertEvaluatorService.getAuthFailureCount()` 正確計算 5 分鐘窗口
- [ ] DB health check streak 連續 3 次失敗觸發 CRITICAL
- [ ] 去重抑制：5 分鐘內同 rule 同 recipient 最多 1 封
- [ ] i18n：3 語言都能正確渲染告警 email

### 整合測試（staging）

- [ ] 模擬 50+ 次 auth failure → 5 分鐘內收到 Email
- [ ] 強制 DB stop → 3 分鐘內收到 CRITICAL Email
- [ ] /health/readiness 模擬失敗（mock OpenAI down）→ 收到告警
- [ ] 同類告警不會 5 分鐘內重複收到

### Report-Only 驗證（一週）

- [ ] 5 條 rule 觸發次數記錄於 `AlertEvent` table
- [ ] 誤報率 < 5%（若高則調整閾值）
- [ ] 1 週後啟用 enabled=true 進入 enforce 模式

---

## 風險提示

- **誤報疲勞**：閾值需依 Pilot 實際流量調整（如初期用戶少時 50/5min 可能合理，但低流量時應該降低）
- **DB connection failure 自我循環**：若 alert evaluator 自己也依賴 DB → 需 fallback 寫 stderr / 文件
- **Disk usage 在 ACA 環境取值困難**：Container Apps 持久卷需走 Azure Storage SDK quota — 部署 ACA 後驗證
- **Email PII 風險**：本 CHANGE 必須與 FIX-055 協調，告警 Email body 不可包含 user email（用 maskEmail）
- **告警 Email 安全性**：SMTP 認證若洩漏則告警通道失守 — 已透過 Key Vault 管理（CHANGE-055 SDLC-15）

---

## 實作順序建議

1. **W1**：Schema migration（補 enum）+ seed 5 rules（all enabled=false）
2. **W1**：實作 `SecurityAlertEvaluatorService` + 單元測試
3. **W2**：整合 `alert-evaluation-job` + auth failure 寫 SecurityLog
4. **W2**：i18n 翻譯 + admin UI Security tab
5. **W3**：staging 啟用 enabled=true + Report-Only 監控（DB / readiness 兩條立即啟用，其他 3 條 Report-Only）
6. **W4**：依誤報率調整閾值 → 全部 enable=true

---

## 相關文件

- **Phase 2 報告**: `docs/08-security-and-governance/phase2-appsec-obs-assessment.md` §Obs-05-lite、§Obs-03
- **企業矩陣 v1.2**: `enterprise-security-governance-matrix.md` §4.3 「5 條關鍵告警」
- **CHANGE-064**: SSRF 阻擋事件可寫入 SecurityLog → 觸發本 CHANGE 的 evaluator
- **FIX-055**: 殘留 PII 修復 — 本 CHANGE 的 alert-notification.service.ts 同檔案，需協調
- **既有 Email**: `src/lib/email.ts` Nodemailer 整合
- **既有 SecurityLog**: `prisma/schema.prisma:1010-1034`
- **既有 Alert framework**: `src/services/alert*.service.ts`、`prisma/schema.prisma` AlertRule/AlertEvent

---

## 業務決策待確認

| # | 議題 | 待用戶確認 |
|---|------|-----------|
| 1 | **預設 enabled 狀態**：5 條全部 false（Report-Only）vs DB/Service 立即 true？ | 建議 DB+Service 立即 true，其他 Report-Only 一週 |
| 2 | **告警 Email recipient**：固定 env var `SECURITY_ALERT_RECIPIENTS=` vs DB user role 動態查詢？ | 建議一期 env var |
| 3 | **去重視窗**：5 分鐘 vs 15 分鐘？ | 建議 5 分鐘（CRITICAL 不去重） |
| 4 | **Disk usage 在 ACA 如何取值**：Azure Storage Quota API vs Application Insights metric？ | 待 CHANGE-055 部署後驗證 |

---

*文件建立日期: 2026-04-28*
*規劃人: Claude Opus 4.7（依 Phase 2 盤點報告產出）*
*下一步: 用戶審閱 + 業務決策 → 進入實作*
