# CHANGE-068: 韌性強化（Resilience — Circuit Breaker + 統一 Retry + Incident Response Plan）

> **狀態**: 📋 規劃中

## 變更摘要

| 項目 | 內容 |
|------|------|
| **變更編號** | CHANGE-068 |
| **變更日期** | 2026-04-28 |
| **相關模組** | 外部呼叫（Azure OpenAI / Azure DI / Microsoft Graph / n8n）+ 文檔 |
| **影響範圍** | 新增 `src/lib/resilience/`（circuit breaker + retry utility）、修改 `src/services/extraction-v3/stages/gpt-caller.service.ts`、`src/services/extraction.service.ts`、`src/services/microsoft-graph.service.ts`、`src/services/n8n/*.ts`；新增 `docs/05-governance/incident-response-plan.md` |
| **優先級** | High |
| **狀態** | 📋 規劃中 |
| **類型** | Resilience / Reliability |
| **依賴** | 無（與 CHANGE-064 SSRF guard 可獨立並行） |
| **對應安全控制項** | Resi-04（L0 → L2/L3）、Resi-05（L2 → L3）、Resi-09（L0 → L2） |
| **Phase 2 報告依據** | `phase2-resi-gov-assessment.md` §Resi-04/05/09、§發現 1-2 |

---

## 問題描述

依 Phase 2 盤點 (`phase2-resi-gov-assessment.md` 第 70-106、156-172 行) 結果：

### Resi-04: Circuit Breaker — **L0（Absent）**

> 「Grep `circuit|opossum|breaker` 在 `src/` 內**零匹配**；`package.json` 全文檢視 — **無 opossum、cockatiel、@circuit/breaker 等任何斷路器套件**。外部呼叫核心位置（無 circuit breaker）：
> - `unified-gpt-extraction.service.ts:338` — `setTimeout(controller.abort)` 只有 timeout 沒斷路
> - `gpt-caller.service.ts:363` — 同上
> - `extraction.service.ts:185` — Azure DI 呼叫只有 timeout」

### Resi-05: Retry / Timeout — **L2（Managed）**

> 「Timeout 已普遍存在但 **Retry 策略不一致**：
> - linear (1s) vs exponential (1m→5m→30m) vs config-driven，沒有統一 utility / decorator
> - **Azure DI 呼叫缺 retry**（`extraction.service.ts:185` 只有 timeout 沒 retry）
> - 缺少統一文件記載「哪些外部依賴有 retry / 用什麼策略」」

### Resi-09: Incident Response Plan — **L0（Absent）**

> 「Glob `**/incident-response*.md` — **無檔案匹配**；無 Severity 分級 / escalation 路徑 / contact list / post-mortem 模板。」

### 為何嚴重

- **服務降級時持續燒錢** — Azure OpenAI 進入降級狀態時，無 circuit breaker 持續送請求消耗 quota + 拖垮 UX
- **Retry 不一致** — linear/exponential/config-driven 三套並存，新工程師不知該用哪個
- **無 IR 流程** — Pilot 上線後發生事件無 SOP，可能首次故障就釀成業務危機

---

## 變更方案

### 設計原則

1. **單一 utility** — 所有外部呼叫透過 `external-call.ts` 統一封裝（timeout + retry + circuit breaker）
2. **零成本套件** — opossum（Node-Red 廠商捐贈，npm 免費，2.6M weekly downloads）
3. **保守預設值** — 不破壞既有行為，舊呼叫漸進式遷移
4. **IR Plan 從矩陣對齊** — 嚴重度 P0-P3 + 通知模板（與 Security Officer 整合）

### 子變更 1：建立統一外部呼叫 utility

**檔案**：`src/lib/resilience/external-call.ts`（新增）

**核心 API**：

```typescript
/**
 * @fileoverview 統一外部呼叫 utility — timeout + retry + circuit breaker
 * @module src/lib/resilience/external-call
 * @since CHANGE-068
 */

import CircuitBreaker from 'opossum'

export interface ExternalCallOptions {
  /** 服務名稱（用於 logger / metrics / circuit breaker key）*/
  serviceName: string
  /** 單次呼叫 timeout（ms）— 預設 30000 */
  timeoutMs?: number
  /** 最大重試次數 — 預設 2（共 3 次） */
  maxRetries?: number
  /** 初始 delay（ms）— 預設 1000 */
  initialDelayMs?: number
  /** Backoff 策略 — exponential（預設）/ linear */
  backoff?: 'exponential' | 'linear'
  /** Jitter（避免 thundering herd）— 預設 true */
  jitter?: boolean
  /** Circuit breaker 開路門檻（連續失敗次數）— 預設 5 */
  errorThreshold?: number
  /** 開路後重試間隔（ms）— 預設 30000 */
  resetTimeoutMs?: number
  /** Fallback 函數（開路時呼叫）*/
  fallback?: () => Promise<any>
}

export class ExternalCallError extends Error {
  constructor(
    public readonly serviceName: string,
    public readonly cause: unknown,
    public readonly attemptCount: number,
    public readonly circuitState: 'closed' | 'open' | 'half-open',
  ) {
    super(`External call to ${serviceName} failed after ${attemptCount} attempts (circuit: ${circuitState})`)
    this.name = 'ExternalCallError'
  }
}

/** 主入口 — 封裝外部呼叫 */
export async function externalCall<T>(
  fn: () => Promise<T>,
  options: ExternalCallOptions,
): Promise<T>

/** 取得 circuit breaker 狀態（用於 health check） */
export function getCircuitState(serviceName: string): 'closed' | 'open' | 'half-open' | 'unknown'
```

**內部實作**：
- 每個 `serviceName` 一個 opossum 實例（singleton）
- Timeout: `AbortSignal.timeout(timeoutMs)`
- Retry: 在 fn 失敗 + circuit closed/half-open 時重試
- Backoff: `delay = initialDelayMs * Math.pow(2, attempt) + jitter`
- Circuit breaker:
  - `errorThresholdPercentage: 50`（30 秒內失敗率）
  - `volumeThreshold: 5`（最小樣本）
  - `rollingCountTimeout: 30000`
  - `resetTimeout: 30000`

### 子變更 2：替換 Azure OpenAI 呼叫

**檔案**：`src/services/extraction-v3/stages/gpt-caller.service.ts`

**原代碼（line 363 附近）**：
```typescript
const response = await client.chat.completions.create(
  { model, messages, ... },
  { timeout: 300000, maxRetries: 2 }
)
```

**變更後**：
```typescript
const response = await externalCall(
  () => client.chat.completions.create({ model, messages, ... }, { signal }),
  {
    serviceName: 'azure-openai',
    timeoutMs: 300000,
    maxRetries: 2,
    backoff: 'exponential',
    jitter: true,
    errorThreshold: 5,
    resetTimeoutMs: 60000,  // OpenAI 通常 30-60 秒可恢復
  }
)
```

### 子變更 3：替換 Azure DI 呼叫（修補 Resi-05 缺口）

**檔案**：`src/services/extraction.service.ts`

**原代碼（line 185 附近）**：
```typescript
const result = await diClient.beginAnalyzeDocument(...)
// 只有 timeout，無 retry
```

**變更後**：
```typescript
const result = await externalCall(
  () => diClient.beginAnalyzeDocument(...),
  {
    serviceName: 'azure-document-intelligence',
    timeoutMs: 120000,
    maxRetries: 2,
    backoff: 'exponential',
    errorThreshold: 5,
  }
)
```

### 子變更 4：替換 Microsoft Graph + n8n 呼叫

**檔案**：`src/services/microsoft-graph.service.ts`、`src/services/n8n/*.ts`

**動作**：所有外部 fetch 改用 `externalCall(() => safeFetch(...), { serviceName: 'microsoft-graph' })`

**整合 CHANGE-064**：`safeFetch`（SSRF guard）+ `externalCall`（resilience）可組合使用。

### 子變更 5：Health Check 整合 circuit state

**檔案**：`src/services/health-check.service.ts`、`src/app/api/health/route.ts`

**動作**：
- `/health/readiness` 額外回傳每個服務 circuit state
- 任何服務 `circuit=open` → readiness 503

```typescript
{
  status: 'healthy',
  services: {
    db: 'healthy',
    azureOpenAi: { circuit: 'closed', latencyMs: 1200 },
    azureDi: { circuit: 'open', lastFailureAt: '...' },  // 觸發 readiness 503
    msGraph: { circuit: 'closed' },
  }
}
```

### 子變更 6：Incident Response Plan 文檔

**檔案**：`docs/05-governance/incident-response-plan.md`（新增；依賴 CHANGE-067 路徑）

**內容大綱**：

```markdown
# Incident Response Plan

## 元數據
- 版本：1.0
- 建立日期：2026-04-28
- Owner：Security Officer（依 CHANGE-067 指定）
- 下次演練：W8（2026-05-26 週）

## 1. 嚴重度分級

| 級別 | 定義 | RTO 目標 | 通知時限 |
|------|------|---------|---------|
| **P0 Critical** | 系統完全無法存取 / 資料外洩 / 認證繞過 | 1 小時內恢復 | 15 分鐘 |
| **P1 High** | 核心功能（上傳/提取）失效 / Performance 嚴重退化 | 4 小時 | 1 小時 |
| **P2 Medium** | 部分功能失效 / 部分用戶受影響 | 24 小時 | 4 小時 |
| **P3 Low** | 非關鍵功能異常 / 資訊性告警 | 1 週 | 24 小時 |

## 2. 通知名單

> ✅ **IR 通知名單（B3, 2026-04-28 確認）**：目前暫由 **Chris Lai** 一人負責 Security Officer + IR Lead 全階段通知。未來團隊擴大後須擴充 Backup + DevOps Lead + Application Lead + 業務 Owner 等角色。

| 角色 | 姓名 | Email | Phone | P0 通知 | P1 通知 | P2 通知 | P3 通知 |
|------|------|-------|-------|---------|---------|---------|---------|
| Security Officer + IR Lead | **Chris Lai** | **chris.lai@rapo.com.hk** | （待補） | ✅ | ✅ | ✅ | ✅ |
| Backup Commander | TBD（後續擴充） | TBD | TBD | TBD | TBD | TBD | — |
| DevOps Lead | TBD（後續擴充） | TBD | TBD | TBD | TBD | TBD | — |
| Application Lead | TBD（後續擴充） | TBD | TBD | TBD | TBD | — | — |
| 業務 Owner | TBD（後續擴充） | TBD | TBD | TBD | TBD | — | — |
| Vendor 緊急聯絡 | Azure Support | https://portal.azure.com/Support | — | ✅ (P0/severity A) | — | — | — |

> ⚠️ **單點失敗風險注記**：目前 IR 通知名單暫由 Chris Lai 一人負責全階段，存在單點失敗風險。未來團隊擴大後需補充 Backup Commander 與其他角色，避免假期 / 病假 / 離職時 Pilot 上線後事件無人回應。

## 3. 事件回應流程（IRT - Incident Response Timeline）

### Step 1：Detect（偵測）— 0-15 分鐘
- 來源：CHANGE-065 Email 告警 / 用戶回報 / 監控系統
- 行動：Incident Commander 確認真實性，分級

### Step 2：Triage（分流）— 15-30 分鐘
- 確認影響範圍
- 啟動 Incident Channel（Teams 群組）
- 通知對應級別名單

### Step 3：Mitigate（緩解）— 視級別
- P0：立即執行 runbook（如 Resi-09 Runbook 中的 rollback 步驟）
- 必要時 disable 受影響功能（feature flag）

### Step 4：Resolve（解決）
- 根本原因修復
- 部署驗證
- 復原確認

### Step 5：Post-Mortem（事後檢討）— 5 個工作日內
- Blameless post-mortem 模板（見附錄）
- 建立 FIX-XXX / CHANGE-XXX 防範
- 更新 Risk Register

## 4. Runbook 索引（依事件類型）
- 資料庫故障 → `docs/05-governance/runbooks/db-failure.md`（待建）
- Azure OpenAI quota 耗盡 → `docs/05-governance/runbooks/openai-quota.md`（待建）
- 認證系統失效（AAD 故障）→ ...
- Storage 不可用 → ...

## 5. Post-Mortem 模板

```markdown
# Incident YYYY-NNN: [Title]

## Summary
（1 段話總結事件）

## Timeline
- HH:MM — Event 1
- HH:MM — Detection
- HH:MM — Mitigation
- HH:MM — Resolution

## Root Cause
（5-Whys 分析）

## Impact
- 影響用戶數：
- 業務影響：
- 資料影響：

## What Went Well
- （正面記錄）

## What Went Wrong
- （負面記錄）

## Action Items
- [ ] FIX-XXX: ...
- [ ] CHANGE-XXX: ...
- [ ] Update runbook: ...
- [ ] Update Risk Register: ...

## Sign-off
- Incident Commander: [name, date]
```

## 6. Tabletop Exercise（桌上演練）
首次：W8 / 2026-05-26 週
情境：
1. PostgreSQL 資料損毀（PITR 還原演練）
2. Azure OpenAI quota 耗盡
3. AAD 配置失誤導致 IAM-06b dev bypass 觸發（呼應 FIX-056）
4. 文件上傳爆量 Storage 容量

## 7. 演練排程
- Q2 2026 — Tabletop（4 情境）
- Q3 2026 — 實際 PITR 還原 drill
- Q4 2026 — DR 完整演練（multi-region）

## 8. 修訂歷史
| 日期 | 版本 | 變更 | 作者 |
|------|------|------|------|
| 2026-04-28 | 1.0 | 初版 | Claude Opus 4.7 |
```

### 子變更 7：admin UI / dashboard

**檔案**：`src/app/[locale]/(dashboard)/admin/health/page.tsx`（既有或新增）

**動作**：
- 顯示每個外部服務 circuit state（closed / open / half-open）
- 最近 24 小時 retry/circuit-open 統計
- 連結到對應 runbook

---

## 修改的檔案

| 檔案 | 變更類型 | 預估行數 |
|------|----------|---------|
| `package.json` | 🔄 加 `opossum` 依賴 | +1 |
| `src/lib/resilience/external-call.ts` | ➕ 新增（utility）| ~250 |
| `src/lib/resilience/external-call.test.ts` | ➕ 新增（單元測試）| ~300 |
| `src/lib/resilience/index.ts` | ➕ 新增（barrel export）| ~10 |
| `src/services/extraction-v3/stages/gpt-caller.service.ts` | 🔄 替換為 externalCall | +15 -8 |
| `src/services/extraction-v3/unified-gpt-extraction.service.ts` | 🔄 替換為 externalCall | +15 -8 |
| `src/services/extraction.service.ts` | 🔄 補 retry + circuit breaker | +20 -5 |
| `src/services/microsoft-graph.service.ts` | 🔄 4 處 fetch 替換 | +30 -16 |
| `src/services/n8n/*.ts` | 🔄 fetch 替換（與 CHANGE-064 整合） | +20 -10 |
| `src/services/health-check.service.ts` | 🔄 暴露 circuit states | +30 |
| `src/app/api/health/route.ts` | 🔄 readiness 整合 circuit state | +20 |
| `src/app/[locale]/(dashboard)/admin/health/page.tsx` | 🔄 顯示 circuit state | +60 |
| `messages/{en,zh-TW,zh-CN}/admin.json` | 🔄 加 circuit state 翻譯 | +9 |
| `docs/05-governance/incident-response-plan.md` | ➕ 新增 | ~600 |
| `docs/05-governance/runbooks/.gitkeep` | ➕ 子目錄 | 1 |

---

## 預期效果

### 韌性提升

| 面向 | Before | After |
|------|--------|-------|
| Resi-04 評分 | L0 | L2（部署後升 L3） |
| Resi-05 評分 | L2 | L3 |
| Resi-09 評分 | L0 | L2 |
| 外部呼叫保護 | 0/4 服務有 circuit breaker | 4/4（OpenAI / DI / Graph / n8n）|
| Retry 策略 | 3 套不一致 | 1 套統一 utility |
| Azure DI retry | 無 | 有（exponential + jitter）|
| IR 流程 | 無 | 完整 P0-P3 + 通知名單 |

### 業務影響

- ✅ 服務降級時 fail fast（30 秒內 open circuit）— 節省 Azure quota
- ✅ Retry jitter 避免 thundering herd（多 instance 同時重試）
- ✅ Health check 變得更智能（依賴掉線 → readiness 503 → ACA reload）
- ⚠️ 首次部署需驗證 circuit threshold 是否合理（staging 跑 1 週）
- ⚠️ Vendor 聯絡資訊待用戶填寫

---

## 測試驗證

### 單元測試

- [ ] Timeout 觸發 → 拋 ExternalCallError
- [ ] 連續 5 次失敗 → circuit open
- [ ] Open 狀態下立即 fail（不執行 fn）
- [ ] 30 秒後 half-open，1 次成功 → close
- [ ] Exponential backoff: 1s → 2s → 4s
- [ ] Jitter: ±25% 範圍

### 整合測試（staging）

- [ ] Mock Azure OpenAI 503 5 次 → circuit open，後續呼叫立即 fail
- [ ] Azure DI retry 3 次 → 第 3 次成功 → 流程 OK
- [ ] /health/readiness 在 OpenAI circuit=open 時回 503

### 演練

- [ ] W8 執行 Tabletop Exercise（4 情境）
- [ ] 記錄於 `docs/05-governance/reviews/2026-05-26-tabletop.md`

---

## 風險提示

- **Circuit threshold 調優**：5 次失敗門檻可能對短暫網路抖動過敏 → staging 驗證
- **opossum 套件依賴風險**：開源但長期維護 — 加入 Dependabot 後追蹤
- **既有 retry 不要拔**：本期是「並存」，舊 manual retry 仍在 → 後續 CHANGE 統一拔
- **Azure DI 加 retry 後總時間翻倍**：120s × 3 = 360s 最壞情況 → 需確認業務可接受
- ✅ **IR Plan 通知名單（B3, 2026-04-28 確認）**：Chris Lai (chris.lai@rapo.com.hk) 暫任 Security Officer + IR Lead 全階段；其他角色（Backup / DevOps Lead / Application Lead / 業務 Owner）後續團隊擴大時再補
- **PITR 還原演練成本**：CHANGE-068 不執行還原 drill（屬於 Resi-07/Phase 4 W8 範疇）

---

## 實作順序建議

1. **W1**：安裝 opossum + 建立 `external-call.ts` + 單元測試
2. **W2**：替換 Azure OpenAI（gpt-caller / unified-gpt-extraction）
3. **W2-W3**：替換 Azure DI + Microsoft Graph + n8n
4. **W3**：Health check 整合 circuit state + admin UI
5. **W3**：撰寫 IR Plan 初稿（待用戶填聯絡人）
6. **W4**：staging 驗證（1 週監控 circuit 行為）
7. **W8**：執行首次 Tabletop Exercise

---

## 相關文件

- **Phase 2 報告**: `docs/08-security-and-governance/phase2-resi-gov-assessment.md` §Resi-04/05/09
- **opossum 套件**: https://github.com/nodeshift/opossum（npm 免費）
- **既有 timeout/retry**: `phase2-resi-gov-assessment.md` §Resi-05 列出 23 個 service 的散落策略
- **CHANGE-064**: SSRF guard — 與 externalCall 組合使用
- **CHANGE-065**: Email 告警 — circuit open 觸發 SecurityLog → Email
- **CHANGE-067**: Governance baseline — IR Plan 路徑依賴
- **既有 health check**: `src/services/health-check.service.ts`、`src/app/api/health/route.ts`

---

## 業務決策確認狀態

| # | 議題 | 結果 |
|---|------|------|
| 1 | **IR Plan 通知名單** | ✅ **已確認（B3, 2026-04-28）**：Chris Lai / chris.lai@rapo.com.hk 暫任全階段；其他角色後續擴充 |
| 2 | **Azure DI retry 後總時間 360s**：業務可接受？或降為 timeout 60s × 2 retry？ | 待業務確認 |
| 3 | **首次 Tabletop 時間**：W8（2026-05-26 週）？ | 待確認 — 建議 W8 |
| 4 | **Vendor 緊急聯絡**：Azure Support tier（Standard/Pro/Premier）| 待 IT 確認 |

---

*文件建立日期: 2026-04-28*
*規劃人: Claude Opus 4.7（依 Phase 2 盤點報告產出）*
*下一步: 用戶確認業務決策 → 進入實作*
