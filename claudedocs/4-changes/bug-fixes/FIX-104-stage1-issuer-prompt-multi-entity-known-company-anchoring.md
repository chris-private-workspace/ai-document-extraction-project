# FIX-104: Stage 1 公司識別對同集團多實體飄移致認錯並增生重複公司

> **建立日期**: 2026-07-09
> **發現方式**: 用戶測試（同一份 `CEVA_RCIM250326_17866.PDF` 兩次處理識別成不同公司實體）
> **影響頁面/功能**: V3.1 Stage 1 公司識別（`stage-1-company.service.ts` + DB `PromptConfig` GLOBAL STAGE_1）→ 公司主檔 / 下游 COMPANY 級映射
> **優先級**: 高
> **狀態**: ✅ 已修復（2026-07-09）— Stage 1 prompt 四處副本強化 + 本地 DB 既有 2 筆 GLOBAL 記錄更新；`type-check` 通過、DB 更新已驗證（`${knownCompanies}` 變數與 `matchedKnownCompany` 欄位皆已寫入、version=2）

---

## 問題描述

同一份 `CEVA_RCIM250326_17866.PDF` 兩次處理，Stage 1 識別出**不同的公司法律實體**：

| 次序 | 時間 | 識別結果 | 信心度 / 路由 |
|------|------|----------|----------------|
| 1 | 2026-07-08 09:42 | CEVA Logistics (RICHASIA) PACIFIC OPERATIONS LIMITED | 89% Quick Review |
| 2 | 2026-07-08 16:09 | CEVA LOGISTICS (HONG KONG) LIMITED | 97% Auto Approve |

其中第 1 次很可能是**認錯**（`RICHASIA` 疑為客戶端 RCI 資訊被混入），且因識別出的名稱與現有公司主檔對不上，觸發 JIT **新建了一筆重複公司記錄**。

---

## 重現步驟

1. 對同一份含 CEVA 集團多個關聯實體的發票（`CEVA_RCIM250326_17866.PDF`）重複觸發處理
2. 觀察 Stage 1 結果：兩次得到不同的公司實體名稱
3. 其中一次識別出的名稱在公司主檔無對應 → `resolveCompanyId` 走到 JIT，`company` 表新增一筆重複記錄

---

## 根本原因

多個原因疊加，橫跨「模型」與「Prompt」兩層：

### 原因 1 — Stage 1 原用 GPT-5-nano，temperature 不可控（非確定性最大）

`gpt-caller.service.ts` 對不支援 temperature 的模型傳 `undefined`（第 253、373 行），nano 使用 API 預設值、無法強制確定性。同一張圖每次輸出可能飄移。
> **配套**：用戶已將 Stage 1 模型改為 gpt-5.2（支援 temperature，實際以 0.1 呼叫），此為本 FIX 的前置條件。

### 原因 2 — 實際生效的 DB PromptConfig（seed 中文版）缺「開票方 / 多實體判定」規則

Stage 1 實際使用的是 DB `PromptConfig`（GLOBAL、`STAGE_1_COMPANY_IDENTIFICATION`，來自 `seed-data/prompt-configs.ts`），**不是** `stage-1-company.service.ts` 的英文硬編碼 fallback。舊版 prompt 只有「發行者不是客戶/買方」一句，未處理**同一集團多個關聯法律實體**（如 HONG KONG vs RICHASIA PACIFIC OPERATIONS）該選哪一個，GPT 在候選間搖擺、甚至拼湊出不存在的名稱。

### 原因 3 — Prompt 從未把「已知公司列表」交給 GPT

`stage-orchestrator.service.ts` 的 `loadKnownCompanies()` 有載入 ACTIVE 公司、`buildStage1VariableContext()` 也備妥 `${knownCompanies}` 字串，但**舊 prompt 模板從未引用 `${knownCompanies}`**，導致列表從未進入實際發給 GPT 的內容。GPT 純自由讀取，讀出的名稱與現有主檔對不上就新建。

### 原因 4 — Prompt 輸出無 `matchedKnownCompany` → 精確匹配永不命中

`resolveCompanyId` 第一步靠 `parsed.matchedKnownCompany` 對既有公司精確匹配，但舊 prompt 的 `documentIssuer` 輸出結構**沒有這個欄位**（`extractCompanyFromParsed` 已支援讀取，只是 prompt 沒輸出），該步驟形同虛設，只能退回名稱模糊匹配。

> **與 FIX-057 / FIX-077 的關係**：兩者強化 JIT 前的防重複網（正規化 + 相似度），是**下游最後一道網**。本案兩個實體正規化後為 `ceva logistics` vs `ceva logistics pacific`（`PACIFIC` 為實詞保留），相似度約 0.64 < 門檻 0.85，攔不住。FIX-104 從**上游識別本身**補強（錨定已知公司 + 多實體判定），補上 FIX-057/077 觸及不到的根源。

---

## 解決方案

強化 Stage 1 公司識別 prompt 的**所有副本**，並更新本地既有 DB 記錄：

1. **開票方判定 + 排除 Bill To/Consignee** — 明確只認開立發票的一方（信頭/Logo/From 區塊）。
2. **同集團多實體判定**（核心）— 明示同一文件出現多個關聯法律實體時，只選實際開票的那一個完整法定名稱，**禁止混合/拼湊/改寫**成新名稱。
3. **打通 `${knownCompanies}` 已知公司列表** — DB 版 userPromptTemplate 引入 `${knownCompanies}`（`execute()` 以 `replaceVariables` 注入），讓 GPT 錨定既有公司。
4. **輸出 `matchedKnownCompany`** — `documentIssuer` 結構加入該欄位，讓 `resolveCompanyId` 精確匹配既有公司、避免增生重複。
5. **名稱逐字採用完整法定全名**；多個相似關聯實體難以區分時降低信心度以觸發人工審核。

> **本地 DB 生效方式**：`npm run db:seed` 對既有 `PromptConfig` 只更新 name/description、**不覆蓋 prompt 內容**（seed.ts 註明 "user may have customized"）。因此新增 `prisma/update-stage1-prompt.js` 直接更新既有 GLOBAL 記錄（比照 FIX-095 的 `update-stage3-prompt.js`）。執行後更新 **2 筆** GLOBAL 記錄 —— 除 seed 正式版 `V3.1 Stage 1 - Company Identification` 外，尚有一筆測試殘留 `Test Stage 1 Config`（GLOBAL + isActive），詳見「後續待辦」。

---

## 修改的檔案

| 檔案 | 修改內容 |
|------|----------|
| `prisma/seed-data/prompt-configs.ts` | STAGE_1 `systemPrompt`/`userPromptTemplate` 重寫（開票方+多實體判定、`${knownCompanies}`、`matchedKnownCompany`），`version` 1→2 |
| `src/services/static-prompts.ts` | `ISSUER_IDENTIFICATION_SYSTEM_PROMPT` / `ISSUER_IDENTIFICATION_USER_PROMPT` 同步（seed 檔明示需一致的靜態 fallback） |
| `src/services/extraction-v3/stages/stage-1-company.service.ts` | `buildCompanyIdentificationPrompt`（英文硬編碼 fallback）補多實體判定 + 排除 Bill To + 完整法定名 + `matchedKnownCompany` 說明 |
| `prisma/update-stage1-prompt.js`（新增） | 一次性更新 DB 既有 GLOBAL STAGE_1 記錄（`pg` + `dotenv`，冪等、參數化）；內容與 seed 逐字一致 |

---

## 測試驗證

- [x] `npm run type-check` 通過（seed 檔 `\${knownCompanies}` 轉義正確，實際存入 DB 為字面 `${knownCompanies}`）
- [x] `prisma/update-stage1-prompt.js` 執行成功，更新 2 筆 GLOBAL STAGE_1 記錄
- [x] DB 查詢驗證：兩筆 `system_prompt` 為新版、`user_prompt_template` 含 `${knownCompanies}` 與 `matchedKnownCompany`、`version`=2
- [ ] 重新處理 `CEVA_RCIM250326_17866.PDF`，Stage 1 穩定識別到正確實體且 `matchedKnownCompany` 有回填（待用戶端 E2E 驗證）
- [ ] 之前錯誤新建的重複公司記錄以 `mergeCompanies` 併回正確公司（資料維護，見「後續待辦」）

---

## 後續待辦（超出本 FIX code 範圍）

| 項目 | 說明 |
|------|------|
| 停用測試殘留配置 | `Test Stage 1 Config`（GLOBAL + isActive）建議設 `isActive=false`，讓 GLOBAL STAGE_1 只剩一筆權威記錄，避免 `loadStage1PromptConfig` 的 `take:1` 撈到非預期記錄 |
| 清理既有重複公司 | 用 `company.service` 的 `mergeCompanies`（**非** merge route 的 `autoMergeCompanies`，後者不轉移文件且漏轉 `extraction_results`）併回正確 CEVA 實體並重新處理文件 |

---

## 關聯背景

本 FIX 是 CEVA 系列測試的延伸，與 FIX-057（Stage 1 公司配對 JIT 重複）、FIX-077（公司識別飄移 JIT 重複防護）互補：前兩者在 JIT 前攔重複，FIX-104 從識別 prompt 本身錨定既有公司、降低飄移與拼湊。模型層面由用戶另行將 Stage 1 切換為 gpt-5.2（temperature 可控）。

---

*文件建立日期: 2026-07-09*
*最後更新: 2026-07-09*
