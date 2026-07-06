# CHANGE-095: 允許在公司編輯頁補填 company code

> **日期**: 2026-07-06
> **狀態**: 🔬 待 E2E 驗證（實作完成、type-check/lint 通過；使用者自行測試中）
> **依賴**: FIX-102（建立/編輯 FormData 契約修復）— 無此修復則 PUT 收不到 code、補填不會實際生效
> **優先級**: Medium
> **類型**: Feature / UI Enhancement
> **影響範圍**: 公司編輯頁表單、公司更新 API / Schema / 服務層、稽核記錄
> **Open Questions**: OQ-1（編輯政策）、OQ-2（稽核記錄）均已由用戶 2026-07-06 拍板 — 見 §設計決策

---

## 變更背景

系統會透過 Just-in-Time（`createCompanyJIT`）在 AI 識別文件時**自動建立公司**（`source = AUTO_CREATED`），這類公司**只帶 `name`、不帶 `code`**。資料庫層 `code` 定義為 `String? @unique`（可為 null），因此存在一批 `code` 為空的公司記錄。

然而原本的**公司編輯頁完全禁止修改 `code`**，形成矛盾：系統允許建立無 code 的公司，卻沒有任何介面能補上 code，導致這些空 code 記錄**永遠無法補填**。

本變更開放編輯頁的 code 補填能力，依用戶要求採「**只允許補空值**」策略（一旦 code 有值即維持鎖定），同時寫入稽核記錄以符合追蹤需求。

### 原本「不能修改 code」的三層鎖定（根因調查）

| 層 | 位置 | 鎖定方式 |
|----|------|----------|
| 前端 UI | `src/components/features/forwarders/ForwarderForm.tsx` | `disabled={isSubmitting \|\| isEditMode}` — 編輯模式 code 欄位灰化不可輸入 |
| 後端 Schema | `src/types/company.ts` | `UpdateCompanySchema` 沒有 `code` 欄位，Zod `.parse()` 直接丟棄傳入的 code |
| 服務層 | `src/services/company.service.ts` | `UpdateCompanyInput` 無 code；`updateCompany` 不寫入 code；JSDoc 明寫「不允許修改 code」 |

### 空 code 的來源

- `createCompanyJIT`（`company.service.ts`）自動建立公司只傳 `name`、`nameVariants`，不傳 code。
- `createCompany`：`code: input.code ?? null`。
- `CreateCompanySchema`：code 為 `.optional().nullable()`，連手動建立都可不填。
- `prisma/schema.prisma:465`：`code String? @unique`。

---

## 變更內容

### 1. 前端：編輯模式下解鎖「空 code」的補填

`ForwarderForm.tsx` 在編輯模式下，**僅當 code 原本為空**才解鎖 code 輸入框；已有 code 的公司維持鎖定（灰化）。

- 新增 `isCodeLocked = isEditMode && !!initialData?.code`；code 欄位 `disabled` 由 `isSubmitting || isEditMode` 改為 `isSubmitting || isCodeLocked`。
- `checkCodeAvailability` 呼叫 `/api/companies/check-code` 時，編輯模式帶 `excludeId=initialData.id`（排除自身）。
- 提交按鈕 disable 條件與 `onSubmit` 的 taken 檢查由 `!isEditMode && ...` 改為兩種模式皆擋 `taken`。
- `onSubmit` 僅在 `!isCodeLocked && data.code` 時 append `code`（已鎖定的 code 不送出）。

### 2. 後端 Schema：`UpdateCompanySchema` 加入 `code`

`src/types/company.ts` 的 `UpdateCompanySchema` 加入 `code`，沿用 `CreateCompanySchema` 的格式驗證（`min(2)`、`max(20)`、`regex(/^[A-Z0-9_]+$/)`、`transform(toUpperCase)`、`.optional().nullable()`）。

### 3. 服務層：`updateCompany` 支援 code + 「只補空值」後端防線

`src/services/company.service.ts`：

- `UpdateCompanyInput` 加 `code?: string | null`。
- `updateCompany` 於 `input.code` 有值時讀取現有 `company.code`：
  - 現有 code **已有值** 且與傳入不同 → `throw new Error('Company code cannot be modified once set')`（相同值則 no-op）。
  - 現有 code **為空** → 唯一性檢查（`findUnique({ where: { code } })`，排除自身）後寫入 `updateData.code`；衝突時 `throw ...'already exists'`。
- 更新 JSDoc：「不允許修改 code」→「僅允許對空 code 補填一次」。

### 4. API route：接上 code + 稽核記錄 + 錯誤處理

`src/app/api/companies/[id]/route.ts`（PUT）：

- `import { logAudit } from '@/lib/audit'`。
- `updateCompany` 成功且 `existingCompany.code` 為空、`updatedCompany.code` 有值時，於 route 層呼叫 `logAudit`（`action: 'FORWARDER_UPDATED'`、`entityType: 'Forwarder'`、`details: { field: 'code', before, after }`、帶 `userId` 與 `x-forwarded-for`）。
- catch 新增分支：`error.message.includes('cannot be modified')` → 回 400（RFC 7807）。既有 `already exists` → 409 分支沿用。

### 5. i18n

本次**未新增使用者可見字串**：已有 code 的鎖定以欄位灰化（disabled）表達，既有 `form.codeDescription` 已足夠。`npm run i18n:check` 通過，無翻譯漂移。

---

## 技術設計

### 修改範圍

| 文件 | 變更內容 |
|------|----------|
| `src/components/features/forwarders/ForwarderForm.tsx` | `isCodeLocked` + 解鎖空 code + check-code excludeId + 提交/taken 條件 + 條件 append code |
| `src/types/company.ts` | `UpdateCompanySchema` 加 `code`（沿用 CreateCompanySchema 驗證規則） |
| `src/services/company.service.ts` | `UpdateCompanyInput` 加 `code`；`updateCompany` 加「只補空值」guard + 唯一性檢查 + code 寫入；更新 JSDoc |
| `src/app/api/companies/[id]/route.ts` | import `logAudit`；補填成功寫稽核；`cannot be modified` → 400 分支 |

### 資料庫影響

**無 Schema 變更 / 無 migration**。`code String? @unique`（`prisma/schema.prisma:465`）已支援 nullable + 唯一，補填走既有 unique 約束。

### 複用的既有能力（不新建）

| 能力 | 位置 | 用途 |
|------|------|------|
| `GET /api/companies/check-code` | `src/app/api/companies/check-code/route.ts` | 即時唯一性檢查，已支援 `excludeId` |
| `CheckCodeSchema` | `src/types/company.ts` | 已含 `excludeId` 驗證 |
| 409 conflict 處理 | `src/app/api/companies/[id]/route.ts` | `already exists` → 409 |
| `logAudit` | `src/lib/audit/logger.ts` | 稽核記錄（既有 `FORWARDER_UPDATED` / `Forwarder`） |

---

## 設計決策

1. **編輯政策 = 只允許補空值（OQ-1，用戶 2026-07-06 拍板）** — code 為空時可補填一次；一旦有值即維持鎖定。理由：`code` 被 `getCompanyByCode`、映射規則等多處作為業務鍵引用，禁止改動既有值可避免破壞下游一致性，同時解決「空 code 補不上」的痛點，風險最低。
2. **雙重防線** — 前端 `disabled` 只是 UX，真正的「只補空值」規則由**後端 `updateCompany` guard** 強制，避免繞過前端直接打 API 改既有 code。
3. **寫入稽核記錄（OQ-2，用戶 2026-07-06 拍板）** — code 補填記錄操作者、前後值、IP。稽核寫在 route 層（可取 session/IP），沿用既有 `logAudit` 慣例，不新增稽核基礎設施。
4. **不新建 API / 不改 Schema** — 複用 check-code（含 excludeId）、既有 409 處理、既有 unique 約束，改動面最小。
5. **權限沿用 `FORWARDER_MANAGE`** — 編輯頁已要求此權限，本變更不額外新增角色限制。

---

## 向後兼容性

- 既有「已有 code」的公司行為不變（維持鎖定），無回歸風險。
- `UpdateCompanySchema` 新增的是 `.optional().nullable()` 欄位，不影響既有只更新 name/description 等的呼叫。
- 無 Schema / migration 變更，不影響資料庫既有資料。

---

## 驗收標準

| # | 驗收項目 | 驗收標準 | 優先級 | 狀態 |
|---|----------|----------|--------|------|
| 1 | 空 code 可補填 | 對 code 為空的公司，編輯頁 code 欄位可輸入並成功儲存 | High | ⏳ 待手動驗證 |
| 2 | 已有 code 維持鎖定 | 對已有 code 的公司，編輯頁 code 欄位維持灰化不可改 | High | ⏳ 待手動驗證 |
| 3 | 後端防線 | 直接對已有 code 的公司打 PUT 改 code，後端回 400 | High | ⏳ 待手動驗證 |
| 4 | 唯一性衝突 | 補填一個已被其他公司使用的 code，回 409 | High | ⏳ 待手動驗證 |
| 5 | 稽核記錄 | code 補填成功後，AuditLog 有一筆記錄（操作者 / before=null / after=新值） | High | ⏳ 待手動驗證 |
| 6 | 即時檢查排除自身 | 補填時即時唯一性檢查正常，且排除自身 | Medium | ⏳ 待手動驗證 |
| 7 | 型別 / Lint | `npm run type-check` 與 `npm run lint` 通過 | High | ✅ 通過 |
| 8 | i18n | `npm run i18n:check` 通過 | Medium | ✅ 通過 |

---

## 測試場景

| # | 場景 | 測試步驟 | 預期結果 |
|---|------|----------|----------|
| 1 | 補填空 code | 開啟一個空 code 公司編輯頁 → 輸入 `NEW_CODE` → 儲存 | 儲存成功，公司 code 變為 `NEW_CODE` |
| 2 | 已有 code 鎖定 | 開啟一個已有 code 公司編輯頁 | code 欄位灰化、不可輸入 |
| 3 | 繞過前端改既有 code | 對已有 code 公司直接 `PUT /api/companies/[id]` 帶不同 code | 回 400，code 不變 |
| 4 | 唯一衝突 | 補填一個已被占用的 code | 回 409，前端顯示「代碼已被使用」 |
| 5 | 稽核追蹤 | 完成場景 1 後查 AuditLog | 有一筆 `FORWARDER_UPDATED`，details 含 field=code / before / after |
| 6 | 自身排除 | 補填檢查時 check-code 帶 excludeId | 不會將自身既有 code 誤判為佔用 |

---

## 實作紀錄（Implementation Notes）

- **實作日期**: 2026-07-06
- **落盤核實**: 因本 session 終端輸出出現雜訊/注入干擾，所有 Edit 均以 Grep 全域搜尋 `CHANGE-095` 標記 + 讀取實際檔案內容**逐一核實落盤**（route.ts 首次三處 Edit 未落盤，已重送並確認）。
- **靜態驗證結果**:
  - `npm run type-check` → exit 0（含 route.ts audit 區塊）
  - `npx eslint`（4 檔）→ 0 errors；warnings 均為 pre-existing（`route.ts` 既有 console、`company.service.ts` 既有 unused），依 surgical 原則未清理。
  - `npm run i18n:check` → exit 0。
- **實作時已核對的規劃疑點**:
  - `getCompanyById` 回傳含 `code`（select 有 `code: true`）→ route 可取 before 值。
  - `createCompany` 既有唯一衝突用 `throw ...'already exists'` → `updateCompany` 沿用同模式，被 route 409 分支捕捉。
  - userId 取法沿用既有稽核 route 慣例 `(session.user as { id: string }).id`。
- **尚待進行**: 手動 E2E（驗收標準 #1–#6，需啟動 dev server 實測補填、鎖定、409/400、稽核記錄）。

---

## 下一步

- 手動 E2E 驗證驗收標準 #1–#6。
- 依 §工作單元完成後的提交確認，向用戶詢問 commit / push / PR。
