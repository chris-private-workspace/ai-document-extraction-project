# CHANGE-067: 治理基線文檔（Governance Baseline — Risk Register + Tech Debt + Access Review + Security Officer）

> **狀態**: 📋 規劃中

> ## ✅ 用戶決策確認（2026-04-28）
>
> | ID | 決策 |
> |----|------|
> | **B2** | 治理路徑採 `docs/05-governance/` 新建（不併入 `docs/08-security-and-governance/`） |
> | **B3** | Security Officer 指派為 **Chris Lai**（chris.lai@rapo.com.hk）— Primary 暫由單人擔任，後續團隊擴大後補 Backup |
>
> 此兩項業務決策已定案，本 CHANGE 進入實作階段，無待後續確認事項。

## 變更摘要

| 項目 | 內容 |
|------|------|
| **變更編號** | CHANGE-067 |
| **變更日期** | 2026-04-28 |
| **相關模組** | 治理 / 文檔 / 半自動化腳本 |
| **影響範圍** | 新增 `docs/05-governance/`（4 份核心文檔）、`scripts/governance/`（半自動化腳本）、更新 `.claude/rules/general.md` |
| **優先級** | Medium（Quick Win — 可在 1 週內達成 ≥ 4 項 L2） |
| **狀態** | 📋 規劃中 |
| **類型** | Documentation / Governance |
| **依賴** | 無（可並行 SSRF/Email Alerts/Audit Log 變更） |
| **對應安全控制項** | Gov-04（L1 → L2）、Gov-08（L0 → L2）、Gov-10（L0 → L2）、Gov-12（L0 → L2） |
| **Phase 2 報告依據** | `phase2-resi-gov-assessment.md` §Gov-04/08/10/12、§變更管理流程現況分析 |

---

## 問題描述

依 Phase 2 盤點 (`phase2-resi-gov-assessment.md` Gov 領域) 結果，治理領域評分為 **L0.4（最低）**，12 項中 6 項 L0、5 項 L1、0 項 L2+。其中 4 項 HIGH/MED 風險可透過建立基線文檔提升至 L2：

| ID | 項目 | 現況 | 證據 |
|----|------|------|------|
| **Gov-04** | 技術債追蹤 | L1 | 42 個 TODO / 0 個 FIXME 散落代碼，無集中追蹤；`.claude/rules/technical-obstacles.md:47` 要求創建 `docs/04-implementation/technical-debt.md` 但**從未創建** |
| **Gov-08** | 安全責任人（Security Officer） | L0 | Glob `securityOfficer\|DPO\|安全責任` → 無檔案；`azure-deployment-plan.md:858` 提及 Security Team 但無 Owner |
| **Gov-10** | Access Review（每季 admin 審查） | L0 | Glob `access-review*.md` → 無檔案；admin 帳號變動無 trail |
| **Gov-12** | Risk Register | L0 | Glob `risk-register*.md` → 無檔案；113 份 CHANGE/FIX 風險散落，無集中登記 |

### 為何嚴重

- **企業合規必備** — ISO 27001 / SOC 2 都要求 Risk Register、Access Review、Security Officer
- **散落但未集中** — 既有 113 份 CHANGE/FIX 風險區塊 + 6 份 codebase analysis HIGH 風險 + MEMORY 安全審計風險都已存在，**只缺整合**
- **Quick Win** — 不需新代碼，2-3 個工作日可達 4 項 L2（最低成本最高 ROI）

---

## 變更方案

### 設計原則

1. **整合而非新建** — 從既有 CHANGE/FIX 文檔與 Phase 2 報告抽取，不要求重新評估
2. **半自動化** — 提供腳本掃描 TODO/CHANGE 風險區塊 → 自動更新表格
3. **季度更新節奏** — Risk Register / Access Review 每季更新；Tech Debt / Security Officer ad-hoc
4. **責任清晰** — 每份文件有 Owner（即使 Pilot 階段是同一人，也要明確角色名稱）

### 子變更 1：建立 `docs/05-governance/` 目錄結構

> ✅ **路徑決策（B2, 2026-04-28）**：用戶確認採 `docs/05-governance/` 新建獨立目錄，不併入既有 `08-security-and-governance/`。理由：governance（治理 / 流程 / 權責）與 security（安全評估 / 滲透 / 漏洞）關切點不同，獨立目錄便於後續 ISO 27001 / SOC 2 audit 時分類引用。

```
docs/05-governance/                   # ✅ 已決策採用此路徑
├── README.md                         # 治理文檔索引
├── risk-register.md                  # Gov-12
├── technical-debt.md                 # Gov-04
├── access-review-process.md          # Gov-10
├── security-officer.md               # Gov-08
├── document-governance.md            # Gov-11（可選）
└── reviews/                          # 季度審查記錄
    └── 2026-Q2-access-review.md      # 範本（首次 Review 後填）
```

### 子變更 2：`risk-register.md` — 風險登記簿（Gov-12）

**內容結構**：

```markdown
# Risk Register — AI Document Extraction Project

## 元數據
- 建立日期：2026-04-28
- 最後更新：2026-04-28
- 下次 Review：2026-07-28（季度）
- Owner：[Security Officer 姓名]
- Reviewer：[PM / Architect]

## 1. 風險評分模型
- **Likelihood**: Low (1) / Medium (2) / High (3)
- **Impact**: Low (1) / Medium (2) / High (3) / Critical (4)
- **Risk Score**: Likelihood × Impact

## 2. 當前風險清單

| # | ID | 風險描述 | Likelihood | Impact | Score | 緩解措施 | Owner | Status | 來源 |
|---|----|---------|------------|--------|-------|---------|-------|--------|------|
| 1 | RISK-001 | API Auth 覆蓋率僅 60.7%（130 routes 未保護）| 3 | 4 | 12 | CHANGE-061 (withAuth HOF) | Sec Owner | 🟠 In Progress | Phase 2 IAM-01 |
| 2 | RISK-002 | 檔案上傳零安全檢查（無 magic number / 病毒掃描）| 3 | 4 | 12 | CHANGE-068（規劃中）| ... | ... |
| 3 | RISK-003 | 零 CI/CD 安全閘門 | 3 | 4 | 12 | CHANGE-069 (ACR/ACA hardening) + Wave 1 GitHub Actions | ... | ... |
| 4 | RISK-004 | 460 commits 99.6% 直接 push to main | 3 | 3 | 9 | Wave 1: GitHub Branch Protection | ... | ... |
| 5 | RISK-005 | LLM Prompt Injection 零防護 | 2 | 4 | 8 | Wave 2 規劃中 | ... | ... |
| 6 | RISK-006 | X-Dev-Bypass-Auth Header 隱患 | 1 | 4 | 4 | FIX-056（本期）| ... | ✅ Mitigated |
| ... | ... | （彙整 22 項 HIGH 未達 L2 + 6 項 MEMORY 風險 + 6 項 Azure 部署風險）| | | | | | |

## 3. 已關閉風險（歷史）
- FIX-050 PII Leakage → ✅ Mitigated 2026-04-21
- FIX-051 SQL Injection → ✅ Mitigated 2026-04-21
- FIX-052 Rate Limit single-instance → ✅ Mitigated 2026-04-21
- FIX-053 Smart Routing dual logic → ✅ Mitigated 2026-04-21
- FIX-054 SYSTEM_USER_ID hardcoded → ✅ Mitigated 2026-04-22
- ...

## 4. 季度更新規則
- 每季 Review 一次（Q1/Q2/Q3/Q4 第一週）
- 每次新 CHANGE/FIX 影響風險 → ad-hoc 更新
- 變更需記錄於文末「修訂歷史」表
```

**初始填充來源**：

1. Phase 2 報告 `current-state-assessment.md` TOP 10 + 22 個 HIGH 未達 L2
2. MEMORY 2026-03-02 Security Code-Level Audit 6 個 HIGH
3. Azure 部署計畫 6 個風險點
4. 113 份 CHANGE/FIX 已標註的風險區塊（透過半自動化腳本抽取）

### 子變更 3：`technical-debt.md` — 技術債追蹤（Gov-04）

**內容結構**：

```markdown
# Technical Debt Register

## 元數據
- 建立日期：2026-04-28
- 最後更新：自動（每月由腳本掃描 TODO 更新）
- Owner：開發負責人

## 1. 統計概覽
- TODO 總數：42（src/）— 來自 phase2 grep
- FIXME 總數：0
- 高優先級：12（核心管線 + 備份服務）
- 中優先級：23
- 低優先級：7

## 2. 技術債分類

### 2.1 Critical（影響生產穩定性）

| # | 文件 | 行號 | 描述 | 預計工時 | Owner |
|---|------|------|------|---------|-------|
| 1 | `src/services/backup.service.ts` | 4 個 TODO | 備份服務未完成（直接對應 Resi-06）| 5 days | DevOps |
| 2 | `src/services/extraction-v3/prompt-assembly.service.ts` | 5 個 TODO | V3 管線核心邏輯未完成 | 3 days | AI Team |
| ...

### 2.2 Major（影響可維護性）
...

### 2.3 Minor
...

## 3. 修復路徑
- Q2 2026：完成 backup.service.ts 4 個 TODO
- Q3 2026：完成 V3 管線 12 個 TODO
- ad-hoc：其他 26 個依 sprint 排程

## 4. 從技術障礙轉化的技術債
（從 `.claude/rules/technical-obstacles.md` 規範轉錄）
- ...
```

**自動化**：`scripts/governance/scan-technical-debt.ts`

```typescript
// 每月執行：scan src/ 找出 TODO/FIXME → 比對既有 technical-debt.md → 生成 diff
// 新 TODO → 加入「待分類」section
// 已修復的 TODO（grep 後消失）→ 自動標記為 ✅ Resolved
```

### 子變更 4：`access-review-process.md` — Access Review 流程（Gov-10）

**內容結構**：

```markdown
# Access Review Process

## 元數據
- 建立日期：2026-04-28
- 政策版本：1.0
- 適用範圍：所有 admin / SystemAdmin / RegionalManager 帳號
- 審查節奏：每季 + 異動觸發

## 1. 審查範圍

### 1.1 必須審查的角色
- SystemAdmin（最高權限）
- RegionalManager（多城市存取）
- 任何擁有 `*` permission 或 `INVOICE_DELETE` / `RULE_MANAGE` 的帳號
- 所有 API Key

### 1.2 審查頻率
- 季度（Q1/Q2/Q3/Q4 第一週）
- 異動觸發（員工離職、角色變更）

## 2. 審查流程

### Step 1：Inventory 收集
腳本：`scripts/governance/admin-inventory.ts`
產出：`docs/05-governance/reviews/{YYYY-Q*}-admin-inventory.csv`

包含欄位：
- userId / email / 姓名
- 角色清單 + 權限清單
- 最後登入時間
- 帳號建立時間
- 是否 ACTIVE

### Step 2：Review Meeting
- 與會者：Security Officer + IT Lead + HR Rep（如可能）
- 每個 admin 帳號逐一審查：
  - 仍在職？
  - 角色合理？
  - 最後登入 > 90 天？→ 暫停或刪除
  - 權限是最小化原則嗎？

### Step 3：行動
- 移除離職員工帳號
- 降權過度權限
- 凍結 90 天未活動帳號
- 記錄決策於 `{YYYY-Q*}-access-review.md`

### Step 4：審計記錄
- 所有變動寫入 audit_logs（actionType=GRANT/REVOKE）
- 季度報告存檔於 `docs/05-governance/reviews/`

## 3. 範本

`{YYYY-Q*}-access-review.md` 模板（含 sign-off 簽核欄位）

## 4. 異動觸發流程
員工離職 / 角色變更 → IT Lead 收到通知 → 24 小時內處理 → 寫入 audit log
```

**自動化**：`scripts/governance/admin-inventory.ts`

```typescript
// 從 prisma 查詢所有 admin 角色 user → 輸出 CSV
// 包含 last login（從 audit_logs LAST LOGIN action 推算）
// 包含 90 天未活動 flag
```

### 子變更 5：`security-officer.md` — 安全責任人指定（Gov-08）

**內容結構**：

```markdown
# Security Officer Designation

## 元數據
- 生效日期：2026-04-28
- 版本：1.0

## 1. 指派

### Primary Security Officer ✅ 已確認（2026-04-28）
- 姓名：**Chris Lai**
- 職稱：（待補）
- Email：**chris.lai@rapo.com.hk**
- 職責：
  - 負責本系統安全策略制定與執行
  - 安全事件回應總指揮（IR Plan 中的 Incident Commander）
  - 季度 Access Review 主持
  - Risk Register 季度更新審核
  - 對外（IT / 法務 / 業務）安全溝通

### Backup Security Officer（備援）— 暫缺
- 狀態：暫由 Primary 一人擔任（2026-04-28 用戶 B3 決策）
- 補充計劃：未來團隊擴大後指定 Backup，避免單點失敗

## 2. 升級路徑

事件嚴重度 → 通知對象（2026-04-28 暫由 Chris Lai 一人負責，後續擴充）：
- P0 (Critical) — Chris Lai + IT Lead + 業務 Owner（< 15 分鐘）
- P1 (High) — Chris Lai（< 1 小時）
- P2 (Medium) — Chris Lai（< 4 小時）
- P3 (Low) — Chris Lai（< 24 小時）

## 3. 聯絡方式

- 一般詢問：chris.lai@rapo.com.hk（2026-04-28 確認）
- 緊急事件：phone / Teams（待補）
- 弱點通報：chris.lai@rapo.com.hk（暫共用 Primary email）

## 4. 與其他角色的協作

| 角色 | Security Officer 對應職責 |
|------|--------------------------|
| DevOps Lead | CI/CD 安全、部署安全 |
| DBA | 資料保護、PITR、加密 |
| Application Architect | Security by Design Review |
| HR | 員工 onboarding/offboarding 通知 |
| 法務 | 合規問題（GDPR / 員工 PII）|
```

### 子變更 6：半自動化腳本

**目錄**：`scripts/governance/`（新增）

| 腳本 | 功能 | 觸發頻率 |
|------|------|---------|
| `scan-technical-debt.ts` | 掃 src/ TODO/FIXME → 更新 technical-debt.md | 每月（手動）|
| `admin-inventory.ts` | 從 DB 匯出 admin 帳號 inventory | 每季（手動，Access Review 前）|
| `extract-risks-from-changes.ts` | 從 113 份 CHANGE/FIX 抓「風險」區塊 → 餵 risk-register.md | 季度更新時 |
| `verify-governance-docs.ts` | 檢查 4 份核心文件是否存在 + 過期（> 1 季未更新告警）| CI 每週 |

### 子變更 7：將治理規則納入 CLAUDE.md

**檔案**：`.claude/rules/general.md`（既有，擴增）

**新增章節**：

```markdown
## 治理基線文檔

每位開發者應熟悉：
- `docs/05-governance/risk-register.md` — 當前已知風險（季度更新）
- `docs/05-governance/technical-debt.md` — 技術債登記（月度更新）
- `docs/05-governance/access-review-process.md` — Admin 帳號審查（季度）
- `docs/05-governance/security-officer.md` — 安全責任人聯絡

新 CHANGE/FIX 完成後，需檢查是否影響 Risk Register（高風險變動 → 通知 Security Officer 更新）。
```

---

## 修改的檔案

| 檔案 | 變更類型 | 預估行數 |
|------|----------|---------|
| `docs/05-governance/README.md` | ➕ 新增 | ~80 |
| `docs/05-governance/risk-register.md` | ➕ 新增（含 22+ 風險） | ~400 |
| `docs/05-governance/technical-debt.md` | ➕ 新增（含 42 TODO） | ~250 |
| `docs/05-governance/access-review-process.md` | ➕ 新增（流程 + 範本）| ~300 |
| `docs/05-governance/security-officer.md` | ➕ 新增（待用戶填具體姓名）| ~150 |
| `docs/05-governance/reviews/.gitkeep` | ➕ 新增子目錄 | 1 |
| `scripts/governance/scan-technical-debt.ts` | ➕ 新增 | ~120 |
| `scripts/governance/admin-inventory.ts` | ➕ 新增 | ~150 |
| `scripts/governance/extract-risks-from-changes.ts` | ➕ 新增 | ~180 |
| `scripts/governance/verify-governance-docs.ts` | ➕ 新增 | ~100 |
| `.claude/rules/general.md` | 🔄 補治理章節 | +30 |
| `.claude/CLAUDE.md` | 🔄 引用 governance 路徑 | +10 |
| `package.json` | 🔄 加 scripts | +4 |

---

## 預期效果

### 治理提升

| 面向 | Before | After |
|------|--------|-------|
| Gov-04 評分 | L1 | L2 |
| Gov-08 評分 | L0 | L2 |
| Gov-10 評分 | L0 | L2 |
| Gov-12 評分 | L0 | L2 |
| 4 個 Quick Win | 0/4 | 4/4 |
| HIGH 未達 L2 數量 | 22 | 18（降 4 項）|

### 業務影響

- ✅ 零代碼變更 → 零回歸風險
- ✅ ISO 27001 / SOC 2 合規基礎建立
- ✅ Security Officer 已指派為 Chris Lai（chris.lai@rapo.com.hk，2026-04-28 B3 用戶決策）
- ⚠️ 季度 Review 節奏需 Security Officer 持續推動
- ⚠️ 目前由單人擔任 Primary（無 Backup），後續擴大團隊時須補 Backup

---

## 測試驗證

### 文檔完整性檢查

- [ ] 4 份核心文件存在且有實質內容（非 placeholder）
- [ ] Risk Register 包含 ≥ 22 個 HIGH 風險（呼應 Phase 2 報告）
- [ ] Technical Debt 包含 ≥ 42 個 TODO（呼應 grep 結果）
- [ ] Security Officer 文件已指定 Primary（Chris Lai / chris.lai@rapo.com.hk，2026-04-28 確認）；Backup 暫缺，後續團隊擴大後補
- [ ] Access Review Process 有可執行的 4-step 流程

### 自動化腳本驗證

- [ ] `npm run scan-technical-debt` 正確輸出 TODO 統計
- [ ] `npm run admin-inventory` 正確匯出 admin user CSV
- [ ] `npm run verify-governance-docs` 在缺失文件時 fail
- [ ] CI 每週 run verify-governance-docs

### 季度 Review 演練

- [ ] 安排首次 2026-Q2 Access Review（W4-W5）
- [ ] 產出 `docs/05-governance/reviews/2026-Q2-access-review.md`
- [ ] Security Officer sign-off

---

## 風險提示

- ✅ **Security Officer 角色已定**：Chris Lai / chris.lai@rapo.com.hk（B3, 2026-04-28）
- **單人 SoD 限制**：目前 Primary + Backup 都是同一人，後續團隊擴大後補 Backup；Phase 2 報告 §結構性問題已標註，本 CHANGE 不解決，但建立 partial SoD 框架（informal Owner）
- **Tech Debt 自動化準確性**：scan-technical-debt 需處理 false positive（如註解中的 `TODO:` 字串為說明）— 需 staging 跑過調優
- ✅ **路徑決策已定**：採 `docs/05-governance/` 新建（B2, 2026-04-28）

---

## 實作順序建議

1. **D1**：建立目錄結構 + README + Security Officer（待填）+ Access Review Process
2. **D2**：自動化腳本（scan-technical-debt + admin-inventory + extract-risks-from-changes）
3. **D2-D3**：Risk Register（用 extract-risks 腳本初填 + 人工調整）
4. **D3**：Technical Debt（scan 腳本 + 人工分類）
5. **D4**：CI 整合 verify-governance-docs（每週）
6. **W2**：首次季度 Access Review 演練

---

## 相關文件

- **Phase 2 報告**: `docs/08-security-and-governance/phase2-resi-gov-assessment.md` §Gov-04/08/10/12
- **MEMORY 風險來源**: `MEMORY.md` 2026-03-02 Security Audit 6 個 HIGH
- **既有 113 份 CHANGE/FIX**: `claudedocs/4-changes/feature-changes/` + `bug-fixes/`
- **既有規範**: `.claude/rules/technical-obstacles.md:47`（要求 technical-debt.md 但未創建）
- **CHANGE-064 ~ 070**: 本批次其他 CHANGE 將更新 risk-register.md

---

## 業務決策確認狀態

| # | 議題 | 結果 |
|---|------|------|
| 1 | **Security Officer 姓名與 Email** | ✅ **已確認（B3, 2026-04-28）**：Chris Lai / chris.lai@rapo.com.hk（Primary，Backup 暫缺） |
| 2 | **目錄路徑** | ✅ **已確認（B2, 2026-04-28）**：採 `docs/05-governance/` 新建獨立目錄 |
| 3 | **季度 Review 節奏起點**：2026-Q2（W4-W5）vs 2026-Q3 起算？ | 待確認 — 建議 Q2（W4-W5） |
| 4 | **Risk Register 更新規則**：CHANGE/FIX 完成時自動 vs 季度集中更新？ | 待確認 — 建議 ad-hoc + 季度 reconcile |

---

*文件建立日期: 2026-04-28*
*規劃人: Claude Opus 4.7（依 Phase 2 盤點報告產出）*
*下一步: ✅ B2 + B3 已確認（2026-04-28）→ 直接進入實作*
