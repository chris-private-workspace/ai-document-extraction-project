# FIX-070: 硬編碼憑證 / 弱加密金鑰（seed 預設管理員密碼 + system-config 加密 fallback 金鑰）

> **建立日期**: 2026-06-10
> **發現方式**: 代碼審查（2026-06-10 全面安全審查，安全修復工作包 WP-7）
> **影響範圍**: `prisma/seed.ts`（新環境部署）、`src/services/system-config.service.ts`（系統配置敏感值加密）
> **優先級**: 高（P1）
> **狀態**: ✅ 核心已完成（2026-06-11）｜「強制首次改密」依用戶決策移交 [FIX-074](./FIX-074-force-first-login-password-change.md) 獨立處理
> **H4 approval**: 用戶於 2026-06-10 明確 approve 此安全改動（seed 密碼改注入 + 移除弱加密 fallback）
> **來源**: SECURITY-ASSESSMENT.md §5 主題 G（硬編碼憑證 / 弱加密）、REMEDIATION-ROADMAP.md WP-7
> **相依**: seed 改動影響新環境部署流程（`docs/07-deployment` 需同步說明，列為後續）

---

## 問題描述

本工作包涵蓋兩個 High 等級的硬編碼憑證 / 弱加密金鑰問題，外加 2 個相關 Medium 問題。

| # | 問題 | 嚴重度 | 位置 | 性質 |
|---|------|--------|------|------|
| INFRA-01 | dev seed 硬編碼預設全域管理員密碼（明文寫死於 repo），且 `console.warn` 將該明文憑證印到日誌 | High | `prisma/seed.ts:460`（hash 呼叫）、`:483`（警告印出明文） | 硬編碼憑證 |
| D-01 | 系統配置加密金鑰 fallback 用硬編碼預設值 `'default-key-for-development-only'` + 靜態鹽值 `'config-salt'` | High | `src/services/system-config.service.ts:68`（金鑰 fallback）、`:71`（靜態鹽值）、`:306`（`deriveKey`） | 弱加密金鑰 |
| INFRA-02 | dev 使用者 `dev-user-1` 建立時無 `password` 欄位（依賴 dev-bypass 登入），屬弱認證面 | Medium | `prisma/seed.ts:430-450`（`devUser` upsert 無 password） | 無密碼帳號 |
| scripts D-01 | 工具腳本中的類似硬編碼憑證 / 弱金鑰（範圍外，僅標註） | Medium | `scripts/`（SECURITY-ASSESSMENT 已列） | 文件僅提及 |

> **安全注意（H4）**：上表所引用的密碼 / 金鑰字串均為 SECURITY-ASSESSMENT.md 已公開、且明文存在於 repo 的「預設範本值」，非真實環境 secret。本文件不引用、不搜尋任何 `.env` / 真實環境的 secret。

### 程式碼現狀（已逐一 Read 驗證 2026-06-10）

**INFRA-01 — `prisma/seed.ts:454-483`**

```text
:460  const adminPassword = await hashPassword('ChangeMe@2026!')   // 明文密碼寫死
:461  const adminUser = await prisma.user.upsert({ ... password: adminPassword ... })
:482  console.warn('  ⚠️  WARNING: Change the default password immediately in production!')
:483  console.warn('  ⚠️  Default credentials: admin@... / ChangeMe@2026!')  // 明文印到日誌
```

- 密碼明文 `ChangeMe@2026!` 直接寫在 seed 原始碼中（commit 進 repo）。
- `hashPassword` 來自 `src/lib/password`（`seed.ts:63`），雜湊正確，但「來源明文」本身已洩漏。
- CLAUDE.md §跨電腦開發協作指示「新環境首次需 `npx prisma db seed`」，故此預設帳號會被實際建立到每個新環境，且密碼公開可知。
- 無「強制首次登入改密碼」機制，預設密碼可能長期留存。

**D-01 — `src/services/system-config.service.ts:64-71, 302-348`**

```text
:65  const ENCRYPTION_ALGORITHM = 'aes-256-gcm'
:68  const ENCRYPTION_KEY = process.env.CONFIG_ENCRYPTION_KEY || 'default-key-for-development-only'
:71  const ENCRYPTION_SALT = 'config-salt'   // 靜態鹽值（所有部署相同）
:306 function deriveKey(): Buffer { return scryptSync(ENCRYPTION_KEY, ENCRYPTION_SALT, 32) }
:314 function encryptValue(value: string): string { ... }  // 使用 deriveKey()
:331 function decryptValue(encrypted: string): string { ... }
```

- 當 `CONFIG_ENCRYPTION_KEY` 未設定時，**靜默 fallback** 為公開已知的硬編碼字串，等同無加密（任何持有原始碼者皆可解密敏感配置值）。
- 靜態鹽值 `'config-salt'` 全部署共用，使 scrypt 派生金鑰可預先計算 / 跨環境一致，削弱保護。
- 對比同 repo 既有 encryption 工具（見下方「對齊範本」），此處是唯一採「不安全預設 fallback」者，屬授權 / 安全寫法分歧。

**INFRA-02 — `prisma/seed.ts:430-450`**

```text
:430 const devUser = await prisma.user.upsert({ where: { id: 'dev-user-1' },
       create: { id: 'dev-user-1', email: 'dev@example.com', isGlobalAdmin: true, ... } })
       // 無 password 欄位
```

- `dev-user-1` 為全域管理員但無密碼，僅供 dev-bypass 流程使用。WP-1（CHANGE-077）已將 dev-bypass 收斂至 `NODE_ENV === 'development'`，故此帳號本身在生產不應可登入。本 FIX 僅在 seed 層補強，避免該帳號被誤建到非開發環境。

---

## 重現步驟

**INFRA-01**
1. 在任一新環境執行 `npx prisma db seed`。
2. 觀察：建立 `admin@ai-document-extraction.com`，密碼為公開可知的 `ChangeMe@2026!`；seed 日誌印出該明文憑證。
3. 以該公開憑證即可登入全域管理員帳號。

**D-01**
1. 部署環境未設定 `CONFIG_ENCRYPTION_KEY`（目前 `.env.example` 亦未列出此變數）。
2. 透過系統配置 API 寫入一筆敏感（`isEncrypted`）配置值。
3. 觀察：該值以「公開已知金鑰 + 靜態鹽值」加密，等同未受保護。

---

## 根本原因

| 問題 | 根本原因 |
|------|----------|
| INFRA-01 | 為「新環境一鍵可登入」的部署便利，將管理員密碼明文寫死於 seed 並印到日誌，犧牲了憑證機密性；缺強制改密機制。 |
| D-01 | 為「本地開發免設環境變數」的便利，採 `|| '預設金鑰'` 靜默 fallback + 靜態鹽值；未對齊 repo 既有「缺金鑰即 fail、不使用預設值」的安全基線。 |
| INFRA-02 | dev 帳號設計上依賴 dev-bypass，故未設密碼；屬弱認證面，需依賴 WP-1 的環境 gate。 |

> **共同根因**：「開發便利」凌駕「安全預設」（insecure-by-default），且 `system-config.service` 未沿用同 repo 已存在的安全金鑰處理範本。

---

## 對齊範本（既有 encryption 工具缺金鑰時的處理方式）

> 本 FIX 的 D-01 修復需「對齊既有行為」。以下為 Read 驗證後的兩個既有範本，**皆採「缺金鑰即 fail、絕不使用預設值」**：

### 範本 A — `src/lib/encryption.ts`（`getMasterKey`，第 115-133 行）

```text
function getMasterKey(): string {
  const key = process.env.ENCRYPTION_MASTER_KEY
  if (!key) {
    throw new Error('ENCRYPTION_MASTER_KEY environment variable is not set. ...')
  }
  if (key.length < 32) {
    throw new Error('ENCRYPTION_MASTER_KEY must be at least 32 characters long ...')
  }
  return key
}
```

- 未設定 → throw（**無任何預設 fallback**）。
- 金鑰長度不足 → throw。
- 鹽值：每次加密以 `crypto.randomBytes(16)` **隨機產生**並隨密文儲存（非靜態）。

### 範本 B — `src/services/encryption.service.ts`（`EncryptionService` 建構子，第 113-131 行）

```text
constructor(config?: EncryptionServiceConfig) {
  const keyHex = config?.encryptionKey ?? process.env.ENCRYPTION_KEY
  if (!keyHex) {
    throw new EncryptionError('ENCRYPTION_KEY environment variable is required', 'MISSING_KEY')
  }
  this.key = Buffer.from(keyHex, 'hex')
  if (this.key.length !== KEY_LENGTH) {
    throw new EncryptionError(`ENCRYPTION_KEY must be ${KEY_LENGTH} bytes ...`, 'INVALID_KEY')
  }
}
```

- 未設定 → throw `EncryptionError('MISSING_KEY')`。
- 長度不符 → throw `EncryptionError('INVALID_KEY')`。
- IV 每次 `randomBytes(16)` 隨機產生。

> **結論**：repo 既有基線是「**fail-closed**：缺金鑰不啟動、不降級放行**」。`system-config.service.ts` 的 `|| 'default-key-for-development-only'` 是唯一偏離者，本 FIX 將其對齊範本 B（同檔已定義 `SystemConfigError`，沿用該錯誤類別最一致）。

---

## 解決方案

### 第一部分：INFRA-01 — seed 管理員密碼改環境變數注入 + 強制首次改密

1. **改為環境變數注入**：將 `'ChangeMe@2026!'` 改為讀取 `process.env.SEED_ADMIN_PASSWORD`，不再硬編碼明文於原始碼。
2. **未設定時的行為**（二擇一，建議在實作時與用戶最終確認；預設採 (a)）：
   - (a) **產生隨機強密碼**並只印出一次（供首次登入），不寫入原始碼，不重複可得；或
   - (b) **seed 報錯中止**並提示需設定 `SEED_ADMIN_PASSWORD`。
3. **移除明文憑證日誌**：刪除 `:483` 印出明文密碼的 `console.warn`；保留「請立即修改預設密碼」的一般提示（不含密碼值）。
4. **強制首次登入改密碼**：在 admin user 建立時設定「需強制改密」旗標（依 `User` 模型既有可用欄位實作；若無對應欄位，列為相依項並於實作時與用戶確認，**不擅自新增 Prisma 欄位**——加非 nullable 欄位屬 H1）。
5. **新增環境變數說明**：在 `.env.example` 補 `SEED_ADMIN_PASSWORD`（含產生指引、預設行為說明）。

> **H1 注意**：若「強制改密」需要新增 Prisma 模型欄位，屬 H1 架構改動 → 實作時 STOP and ask；優先利用 `User` 既有欄位（如以特定 sentinel 或既有狀態欄位表達）。

### 第二部分：D-01 — system-config 加密金鑰缺失時 fail，移除弱 fallback 與靜態鹽值

1. **移除不安全 fallback**：`src/services/system-config.service.ts:68` 改為「缺 `CONFIG_ENCRYPTION_KEY` 即 fail」，對齊範本 B：
   - 將金鑰讀取封裝為函式（如 `getConfigEncryptionKey()`），未設定 → throw `SystemConfigError(..., 'MISSING_ENCRYPTION_KEY')`；長度不足（建議 ≥ 32 字元）→ throw。
   - 刪除 `'default-key-for-development-only'` 字串常量。
2. **移除靜態鹽值**：`:71` 的 `'config-salt'` 不再作為固定派生鹽。對齊範本做法，改為**每次加密隨機產生鹽值並隨密文儲存**（密文格式由現行 `IV:AuthTag:EncryptedData` 擴充為含 salt，例如 `salt:IV:AuthTag:EncryptedData`），`decryptValue` 對應解析。
   - **向後相容 / 既有資料遷移**：若既有環境已有以舊 fallback 金鑰 + 靜態鹽加密的配置值，變更金鑰 / 鹽派生方式會使舊密文無法解密。此屬資料相容性風險，依 CLAUDE.md §When in Doubt「Migration 不確定資料相容性 → STOP，先寫 dry-run 驗證 script」處理：**實作前先盤點是否存在既有加密配置值**；若存在，需先設計遷移（以舊方式解密 → 以新方式重加密）或與用戶確認可清空重設。**本 FIX 規劃階段不擅自決定，列為實作前必確認項。**
3. **`decryptIfNeeded` 錯誤處理檢視**（`:354-364`）：現行解密失敗時 `console.error` 後**回傳原值**（靜默吞錯）。檢視是否改用 logger 並讓上層感知失敗（避免把未解密的密文當明文回傳）；此為附帶加固，範圍以不擴大為原則。
4. **新增環境變數說明**：在 `.env.example` 補 `CONFIG_ENCRYPTION_KEY`（目前缺漏；含產生指引與「設定後不可變更」警告，與既有 `ENCRYPTION_KEY` 一致）。

### 第三部分（Medium）：INFRA-02 — dev-user-1 收斂

- 維持不設密碼（其安全性由 WP-1 / CHANGE-077 的 `NODE_ENV === 'development'` gate 保證）。本 FIX 在 seed 層加保護：僅在開發環境建立 `dev-user-1`（例如以 `NODE_ENV !== 'production'` 條件包裹），避免被誤建到生產 / UAT。具體條件實作時與用戶確認。

---

## 修改的檔案

| 檔案 | 修改內容 | 對應發現 |
|------|----------|----------|
| `prisma/seed.ts` | admin 密碼改讀 `SEED_ADMIN_PASSWORD`（未設則隨機產生並印一次）；移除印出明文密碼的 `console.warn`；加強制首次改密旗標（利用既有欄位）；`dev-user-1` 限開發環境建立 | INFRA-01、INFRA-02 |
| `src/services/system-config.service.ts` | 移除 `'default-key-for-development-only'` fallback，缺金鑰即 throw `SystemConfigError`；移除靜態鹽值改隨機鹽並隨密文儲存；`encryptValue`/`decryptValue`/`deriveKey` 對應調整；檢視 `decryptIfNeeded` 靜默吞錯 | D-01 |
| `.env.example` | 新增 `SEED_ADMIN_PASSWORD`、`CONFIG_ENCRYPTION_KEY` 兩個變數說明（含產生指引與警告） | INFRA-01、D-01 |

> 以上為**規劃**範圍。實作時若觸發 H1（新增 Prisma 欄位）或 Migration 資料相容性風險，依 Hard Constraints STOP and ask，不在本文件擅自定案。

---

## 對部署流程的影響（相依，後續同步）

| 影響項 | 說明 | 後續動作 |
|--------|------|----------|
| 新環境 seed | `npx prisma db seed` 前需先設定 `SEED_ADMIN_PASSWORD`（或接受隨機產生並記下一次性密碼） | `docs/07-deployment/01-local-deployment/project-initialization-guide.md` 與 SITUATION-7（Seed 數據維護）需同步更新 |
| 系統配置加密 | 各環境必須設定 `CONFIG_ENCRYPTION_KEY`，否則系統配置敏感值加解密路徑會 fail（這是預期的 fail-closed 行為） | 部署檢查清單需加入此必填環境變數；`docs/07-deployment` 環境變數參考需補列 |
| 既有加密配置值遷移 | 若既有環境已有以舊弱金鑰加密的配置值，需遷移或重設 | 實作前先 dry-run 盤點，列入部署 runbook |
| Azure DEV / UAT | 依 MEMORY 記載 Azure DEV 為 App Service for Containers，容器啟動跑 bootstrap+seed | 需確認容器啟動腳本如何注入 `SEED_ADMIN_PASSWORD` / `CONFIG_ENCRYPTION_KEY`（Azure 側改動，與本地分離，列為後續 Azure 工作） |

> 部署文件改動屬本 FIX 的下游相依，**不在本次程式碼修復範圍**，於修復完成後另行同步。

---

## 測試驗證 checklist

**程式碼層面（實作後驗證）**
- [x] `prisma/seed.ts` 已無 `'ChangeMe@2026!'` 明文（改 `resolveSeedAdminPassword()` 讀 env / 隨機產生）
- [x] seed 日誌不再印出任何硬編碼明文密碼（移除原 `:483` 公開明文 `console.warn`；隨機產生時僅印一次性密碼）
- [x] `SEED_ADMIN_PASSWORD` 注入路徑正確；未設定時採定案行為 (a)：隨機產生並印一次
- [➡️] admin user「強制首次改密」狀態 — **移交 [FIX-074](./FIX-074-force-first-login-password-change.md)**（User 模型無可用欄位，屬 H1，依用戶 2026-06-11 決策獨立處理）
- [x] `dev-user-1` 僅在非生產環境建立（`NODE_ENV !== 'production'` 包裹）
- [x] `src/services/system-config.service.ts` 已無 `'default-key-for-development-only'` fallback；`'config-salt'` 僅保留為 `LEGACY_ENCRYPTION_SALT`（舊密文向後相容解密用，新加密不再使用）
- [x] 缺 `CONFIG_ENCRYPTION_KEY` 時 `getConfigEncryptionKey()` throw `SystemConfigError`（MISSING/INVALID，對齊 `encryption.service.ts`）
- [x] 鹽值改為隨機產生並隨密文儲存（格式 `Salt:IV:AuthTag:Data`）；`decryptValue` 向後相容解析新（4 段）/舊（3 段）格式
- [x] `.env.example` 已含 `SEED_ADMIN_PASSWORD`、`CONFIG_ENCRYPTION_KEY` 說明
- [x] `npm run type-check`：`src/` + `prisma/` 零新增錯誤（僅 `tests/` 既有 jest/vitest 型別缺失，無關）
- [x] `npm run lint`：`system-config.service.ts` 零輸出；`seed.ts` 僅既有 `no-console` warning（CLI 腳本慣例）

**資料相容性（實作前必做）**
- [ ] 盤點既有環境是否存在以舊 fallback 金鑰 + 靜態鹽加密的 `SystemConfig` 敏感值
- [ ] 若存在 → 設計遷移 / dry-run 驗證 script，或與用戶確認可清空重設（依 §When in Doubt）

**執行期（待 staging 驗證）**
- [ ] 新環境以 `SEED_ADMIN_PASSWORD` seed 後可登入，且被要求首次改密
- [ ] 設定 `CONFIG_ENCRYPTION_KEY` 後，系統配置敏感值加密 / 解密往返正確
- [ ] 未設定 `CONFIG_ENCRYPTION_KEY` 時，相關路徑明確失敗（非靜默降級）

---

## Hard Constraints 自檢

| 約束 | 是否觸發 | 說明 |
|------|----------|------|
| H1（架構 / Prisma 結構） | ⚠️ 已觸發（部分子項） | 「強制首次改密」需新 Prisma 欄位（User 模型 `schema.prisma:9-83` 確認無 `mustChangePassword` 等可用欄位）→ 已 STOP，待用戶決策；其餘子項（密碼注入、弱加密移除）皆不觸發 H1 |
| H2（依賴 / vendor） | 否 | 沿用 Node.js `crypto`，無新依賴 |
| H3（task scope） | 否 | 範圍限於 WP-7 兩個 High + 兩個相關 Medium |
| H4（安全 / secrets） | ✅ 本 FIX 的核心 | 已獲用戶 2026-06-10 approve；不輸出真實 secret |
| H5（i18n） | 否 | seed 日誌與開發者錯誤訊息可用英文（非使用者可見 UI） |
| H6（設計偏離） | 否 | 屬安全 bug fix，且修復方向對齊既有 encryption 範本 |

---

## Implementation Notes（2026-06-11）

### 已實作（H4 已 approve 範圍內）

| 子項 | 檔案 | 說明 |
|------|------|------|
| INFRA-01 密碼注入 | `prisma/seed.ts` | 新增 `resolveSeedAdminPassword()`：優先讀 `SEED_ADMIN_PASSWORD`，未設則 `randomBytes(18).toString('base64url')` 產生一次性隨機強密碼（約 144 bits 熵）。移除硬編碼 `'ChangeMe@2026!'` 與印出公開明文的 `console.warn`。隨機產生時僅印一次性密碼供首次登入。 |
| INFRA-02 dev 帳號收斂 | `prisma/seed.ts` | `dev-user-1` 建立以 `if (process.env.NODE_ENV !== 'production')` 包裹；生產環境輸出 skip 訊息、不建立。 |
| D-01 弱金鑰移除 | `src/services/system-config.service.ts` | 移除 `'default-key-for-development-only'` fallback，新增 `getConfigEncryptionKey()` fail-closed（缺金鑰 → `SystemConfigError('MISSING_ENCRYPTION_KEY')`；長度 <32 → `INVALID_ENCRYPTION_KEY`），對齊 `encryption.service.ts` 基線。 |
| D-01 靜態鹽移除 | `src/services/system-config.service.ts` | `encryptValue` 改每次 `randomBytes(16)` 隨機鹽，密文格式 `Salt:IV:AuthTag:Data`（4 段）。 |
| 環境變數說明 | `.env.example` | 補 `CONFIG_ENCRYPTION_KEY`（fail-closed 警告）與 `SEED_ADMIN_PASSWORD`（注入/隨機產生說明）。 |

### ➡️ 已移交 FIX-074（H1 Triggered）— 強制首次改密

- **問題**：INFRA-01 第 4 點「強制首次登入改密碼」需要持久化「需改密」狀態，但 `User` 模型（`schema.prisma:9-83`）**無**任何可用欄位（`mustChangePassword` / `passwordChangedAt` / `forceChangePassword` 皆不存在）。
- **依立案文件 §解決方案 INFRA-01 第 4 點 + H1**：不擅自新增 Prisma 欄位，已 STOP and ask。
- **用戶決策（2026-06-11）**：另開 [FIX-074](./FIX-074-force-first-login-password-change.md) 獨立處理（新 Prisma 欄位 + migration + 認證流程跳轉 + 改密 UI + i18n），不混入本 FIX。
- **現況風險緩解（本 FIX 落地，FIX-074 前有效）**：「隨機一次性密碼（每次不同、非公開）+ `.env` 提示立即改密」已大幅降低風險；公開已知密碼的原始風險已消除。

### ⚙️ 工程決策：D-01 鹽值遷移採「向後相容解密」（零遷移）

- **背景**：移除靜態鹽改隨機鹽會變更密文格式，立案文件 §When in Doubt 提示「Migration 不確定相容性 → STOP dry-run」。
- **採用方案**：`decryptValue` 以「分割段數」區分格式 — 4 段=新（隨密文儲存的隨機鹽）、3 段=舊（`LEGACY_ENCRYPTION_SALT='config-salt'`）。舊密文可繼續解，且任何後續 `updateConfig` 寫回即自動升級為隨機鹽格式。**消除了不相容性，無需停機 dry-run 或清空重設。**
- **取捨**：`'config-salt'` 字串以 `LEGACY_ENCRYPTION_SALT` 形式保留於**解密相容路徑**（非新加密），達成「不再作為固定派生鹽」目標。

### ⚠️ 殘留相容性風險（部署前須知）

- **金鑰變更導致的舊密文不可解**：若某既有環境**曾以舊 fallback 金鑰 `'default-key-for-development-only'` 加密過真實 secret**（屬原始 misconfiguration），移除 fallback 後設定新 `CONFIG_ENCRYPTION_KEY` 將使該批舊密文無法解密（`decryptIfNeeded` catch 後回傳密文、不 crash），需於 `/admin` 系統設定**重新輸入**該些 secret。
- **盤點結論**：`config-seeds.ts` 的 5 個 `isEncrypted` SECRET 預設值全為空字串（空值不加密、不受影響）；真實密文僅存在於「曾透過 UI 寫入」的環境。**本地 dev 多為空、Azure DEV/UAT 未知**。
- **部署前建議**（執行期，待 staging 驗證）：設定 `CONFIG_ENCRYPTION_KEY` 前先確認 `SystemConfig` 是否有非空 `isEncrypted` 值（一句 SQL：`SELECT key FROM system_configs WHERE is_encrypted = true AND value <> '';`）。

### 未動項（H3 不擴大）

- `decryptIfNeeded`（靜默吞錯回傳原值）：立案文件列為「附帶加固、範圍以不擴大為原則」。保留既有 try/catch 結構，避免 `getValue`/`listConfigs` 連鎖 throw；未設金鑰 + 全空 secret 的本地環境因空值短路而不受影響。
- 部署文件（`docs/07-deployment`、SITUATION-7）：屬下游相依，修復完成後另行同步。

---

*文件建立日期: 2026-06-10*
*最後更新: 2026-06-11（核心已實作：密碼注入 + 弱加密移除 + dev 帳號收斂；強制改密待 H1 決策）*
