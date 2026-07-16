# CHANGE-105: token-set 把 office / branch 改為「營運單位區分詞」（全域）

> **日期**: 2026-07-16
> **狀態**: ✅ 已完成（程式碼 + 測試；存量以重新處理收斂）
> **類型**: Feature Change（公司識別邏輯調整 — 修訂 CHANGE-103 Phase 2 token-set）
> **範圍**: 全域（所有 forwarder）
> **影響檔案**: `src/services/similarity/token-set.ts`、`tests/unit/services/token-set.test.ts`、`tests/unit/services/stage-1-company-tokenset-gray.test.ts`
> **關聯**: 修訂 [[CHANGE-103]] Phase 2 組件 2 的 `GENERIC_COMPANY_TOKENS`
> **H1 核可**: 使用者 2026-07-16 明確定案（見下方「決策」）

---

## 背景

CHANGE-103 Phase 2 的 token-set 配對把 `office` / `branch` 當成可剝除的「通用組織結構詞」，使「CEVA LOGISTICS **HONG KONG OFFICE**」與「CEVA LOGISTICS (HONG KONG) **LTD**」剝除後 core 都成 `{ceva, logistics}` → **AUTO 自動併為同一公司**。

本地測試發現(CEVA_RCIM250004_05808 = Office 版、CEVA_RCIM250325_17865 = Ltd 版)兩者被併到同一 canonical `CEVA LOGISTICS (HONG KONG) LTD`。使用者(業務端)判定:**它們是不同的公司實體(不同法人／計費實體)、且文件格式不同,應分開建立公司記錄**。

## 決策（H1，使用者 2026-07-16 定案）

| 問 | 定案 |
|----|------|
| 範圍 | **全域**（所有 forwarder 的「X Office」/「X Branch」都與「X Ltd」分家） |
| 哪些詞 | `office` **和** `branch` 一起改為區分詞 |
| 存量 | **重新處理**受影響文件(走真實 pipeline 自然分流) |

**原則**:法律形式後綴(ltd/limited…由 `normalizeCompanyName` 去除)+ 純地區詞(hong/kong/hk)= **同一實體**,照常吸收;**營運單位詞(office/branch)= 可能是不同法人／計費實體**,不再自動吸收。

> ⚠️ 旁註:`warehouse` / `terminal` 同屬營運單位詞、仍留在剝除清單。本次只依定案改 `office` / `branch`;warehouse/terminal 若也要區分,另立 CHANGE。

## 實作

### token-set.ts
- `GENERIC_COMPANY_TOKENS` **移除 `office`、`branch`**（其餘不動）。
- 後果:`coreTokens("... office")` 會保留 `office` → 與「... ltd」的 core 不再相等、而是**嚴格子集** → `classifyCompanyMatch` 回 **GRAY**（非 AUTO）。
- GRAY 走 CHANGE-103 P2 既有流程:Stage 1 建 **PENDING** 公司 + 填 `suspectedDuplicateOfId` → 進 `/admin/companies/duplicate-review` 審核佇列 → 人工「確認為新公司」→ 成 ACTIVE。**不需新機制**。

### 測試（反映新行為，非弱化）
- `token-set.test.ts`:`coreTokens('... office')` 改為保留 office;新增 office/branch 為區分詞的斷言;`... office` / `... branch` 的 `classifyCompanyMatch` 改斷言 GRAY;generic-only 範例改純地區詞。
- `stage-1-company-tokenset-gray.test.ts`:原「Office → AUTO」測試改為「Office → GRAY → 建 PENDING」;DHL token-set AUTO 迴歸測試改用純地區詞變體(`DHL Express Hong Kong`)以保留零回歸檢查(純地區詞照常吸收)。

## 取捨（已知影響）

- **全域影響**:任何 forwarder 的「X Office」/「X Branch」文件都不再自動併入「X」→ 落 GRAY → 進審核佇列。第一次出現需人工「確認為新公司」(之後精確命中)。這會**增加審核佇列項目**,是換取「不同營運實體不被誤併」的代價。
- **與 CHANGE-103 反向**:CHANGE-103 的目標是減少重複增生;本 CHANGE 針對 office/branch **刻意放寬**到人工把關。兩者不衝突——CHANGE-103 收斂的是 OCR 名稱飄移/純地區詞差異,本 CHANGE 區分的是營運單位。

## 存量收斂（重新處理）

現存被誤併的 Office 文件(如 CEVA_RCIM250004_05808)其 `stage_1_result.companyName` 已被記成 canonical「LTD」,**無法單靠欄位分辨**。收斂方式:
1. 部署/本地生效新 token-set 後,**重新處理**該批 Office 文件。
2. Stage 1 重跑 → office 為區分詞 → GRAY → 建 PENDING「…Office」公司(suspectedDuplicateOf = canonical)。
3. 審核佇列「確認為新公司」→ 成獨立 ACTIVE 公司,文件改綁它。

## 驗收

| # | 項目 | 標準 | 狀態 |
|---|------|------|------|
| 1 | office/branch 移出 generic | `coreTokens('x office')` 保留 office | ✅ |
| 2 | 「X Office」vs「X Ltd」→ GRAY | classifyCompanyMatch = GRAY | ✅ |
| 3 | 純地區詞零回歸 | hong/kong 仍吸收、DHL AUTO 路徑維持 | ✅ |
| 4 | 單元測試 | 22/22 pass | ✅ |
| 5 | type-check / lint | 0 error | ✅ |
| 6 | 存量 Office 文件分流 | 重新處理後進 PENDING → 確認為新公司 | ⏳ 使用者本地重新處理驗證 |
| 7 | Azure 部署 | 隨下次映像部署生效(純程式碼、無 schema/env) | ⏳ |
