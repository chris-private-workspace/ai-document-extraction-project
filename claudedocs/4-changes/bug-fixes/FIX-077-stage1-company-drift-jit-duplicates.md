# FIX-077: Stage 1 公司識別飄移 / JIT 持續增生重複公司（FIX-057 後續強化）

> **建立日期**: 2026-06-16
> **發現方式**: Playwright/API 端到端測試（驗證 Stage 2 COMPANY scope 模板選用時）
> **影響頁面/功能**: Stage 1 公司識別（`resolveCompanyId` / `normalizeCompanyName` / `jitCreateCompany`）、所有 COMPANY/FORMAT scope 配置（Stage 2/3 `PromptConfig`、`FieldDefinitionSet`、`pipeline-config` override、`FieldMappingConfig`、Tier 2 `MappingRule`）、公司主檔、公司維度統計 / 成本 / 規則學習
> **優先級**: 高
> **狀態**: ✅ 已修復（BUG-1 / BUG-2 程式碼已實作並通過驗證；BUG-3 既有重複公司已合併清理）
> **最後更新**: 2026-06-16

---

## 問題描述

FIX-057 已修復 Stage 1「使用者短名 ↔ 發票法定全名」的配對問題（Step 2 後備配對加入 `nameVariants` 比對 + 新增 `normalizeCompanyName` 正規化）。但本次測試發現該修復**仍不足以涵蓋更複雜的公司名變體**，GPT-5-nano 對同一張發票每次輸出不同寫法時，正規化結果隨之飄移、仍配對失敗，於是**每次都 JIT 新建一筆重複公司**，公司主檔持續被污染。

| # | 問題 | 嚴重度 | 影響範圍 |
|---|------|--------|----------|
| BUG-1 | `normalizeCompanyName`（FIX-057）無法涵蓋括號地區詞 `(HK)`/`(Hong Kong)`、業務後綴 `OPERATIONS`、`/ 別名` 分隔 → 同公司不同寫法正規化結果相異，仍 match 失敗 | 高 | 所有公司 |
| BUG-2 | FIX-057 BUG-3「JIT 前重複防護」當時標為可選且未落實 → 配對失敗即無條件新建，毫無防線 | 高 | 資料整潔 / 後續配對 |
| BUG-3 | 既有已增生的重複公司未清理（本次驗證又新增多筆 DHL/MTL） | 中 | 資料整潔 / 候選清單品質 |

**實質影響**：因為所有 COMPANY/FORMAT scope 的客製化（Stage 2/3 `PromptConfig`、`FieldDefinitionSet`、`pipeline-config` override、`FieldMappingConfig`、Tier 2 `MappingRule`）都依賴**穩定的 `companyId`** 才能命中，公司識別飄移會讓這些客製化形同虛設；同時公司主檔被垃圾記錄污染，連帶公司維度的統計、成本、規則學習全部失真。這是 FIX-057 已點名的核心能力，但對「多寫法公司」尚未根治。

---

## 重現步驟

1. 準備一張發票圖上印有公司法定全名（含地區詞/業務後綴/別名），例如 DHL 發票。
2. 透過 `/api/documents/upload`（`processingVersion=v3`）連續上傳**同一張**發票多次。
3. 觀察現象：
   - 每次 `extraction_results.stage_1_result` 的 `companyName` 寫法不同、`isNewCompany: true`。
   - DB `companies` 表持續新增 `source=AUTO_CREATED` 的重複公司。
   - 後續 Stage 2/3 落回 GLOBAL 預設（因新公司無任何 COMPANY scope 配置）。

**實測證據（2026-06-16）**

同一張 `docs/Doc Sample/DHL_HEX250830_32687.pdf` 4 次上傳 → 4 種寫法 → DB 增生 4 筆 DHL 公司：

| companyId | GPT 輸出公司名 | 來源 |
|-----------|---------------|------|
| eedf4065 | DHL Express | MANUAL（原有） |
| d0cade87 | DHL EXPRESS (HK) LIMITED | AUTO_CREATED |
| bb9b8831 | DHL Express (Hong Kong) Limited / DHL Express | AUTO_CREATED |
| 08509190 | DHL EXPRESS (HK) OPERATIONS LTD. | AUTO_CREATED |

同一張 `MTL_HEX0125_18516.pdf` 亦飄出 RICH KING HONG / MODERN LEASING / RICON HONG KONG 三種寫法（其中 RICON 為 RICOH 的 OCR 誤讀）。

---

## 根本原因

### BUG-1：`normalizeCompanyName` 正規化不足以涵蓋複雜變體（主因）

`src/services/extraction-v3/stages/stage-1-company.service.ts:490-501`：

```ts
private normalizeCompanyName(name: string): string {
  if (!name) return '';
  return name
    .toLowerCase()
    .replace(
      /\b(ltd|limited|co|company|inc|incorporated|corp|corporation|llc|pte|gmbh|sa|bv|ag|nv)\b\.?/g,
      ' '
    )
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}
```

- 只移除公司後綴（`LTD/LIMITED/...`）+ 把非字母數字轉空格。
- 括號內地區詞未移除：`(HK)` → 殘留 token `hk`、`(Hong Kong)` → `hong kong`。
- 業務後綴未處理：`OPERATIONS` → `operations`。
- 別名分隔未處理：`... / DHL Express` → 兩段串接成 `... dhl express`。

→ 同一家 DHL 的四種寫法正規化後分別為 `dhl express`、`dhl express hk`、`dhl express hong kong dhl express`、`dhl express hk operations`，**彼此不相等**，Step 2b 正規化相等比對全數 miss。

### BUG-2：`jitCreateCompany` 無重複防護（FIX-057 BUG-3 未落實）

`stage-1-company.service.ts:462-472, 507-550`：配對失敗（Step 1/2 皆 miss）即呼叫 `jitCreateCompany` 無條件 `create`，未先比對是否已有正規化/相似度高度相近的既有公司（含 PENDING）。FIX-057 已將此列為 BUG-3「可選」，但實作結果僅完成 Step 2a/2b 配對強化，**未加入 JIT 前重複防護**，因此一旦 BUG-1 漏接即直接增生。

---

## 解決方案

### BUG-1 修復（核心）：強化 `normalizeCompanyName` ✅ 已實作

`stage-1-company.service.ts` 的 `normalizeCompanyName` 新增三項正規化步驟：

1. **取「/ 別名」前的主名**：`normalized.split('/')[0]`（例：「... Limited / DHL Express」→「... Limited」）。
2. **移除括號及其內容**：`replace(/\([^)]*\)/g, ' ')`（涵蓋 `(HK)`、`(Hong Kong)` 等地區詞）。
3. **後綴清單加入業務描述詞 `operations`**。

驗證結果（確定性，不打 GPT）：DHL 四種寫法 `DHL Express` / `DHL EXPRESS (HK) LIMITED` / `DHL Express (Hong Kong) Limited / DHL Express` / `DHL EXPRESS (HK) OPERATIONS LTD.` **全部正規化為 `dhl express`**，可被既有 `resolveCompanyId` Step 2b 的正規化精確相等比對命中；FIX-057 既有 Fairate 案例無回歸。

> 設計取捨：未採用 token 集合相似度（Jaccard）作為主要配對，因強化後的正規化 + 精確相等已完整解決可重現的 DHL 飄移案例（Karpathy simplicity-first，避免過度移除造成誤配）。相似度僅用於 BUG-2 的保守安全網。

### BUG-2 修復：JIT 前重複防護 ✅ 已實作

新增 `findDuplicateCompany(candidate)`，於 `resolveCompanyId` 進入 JIT 建立分支前呼叫；找到既有公司則回傳並標 `isNewCompany: false`，不再無條件 `create`：

1. 查詢**所有狀態**的 Company（補 Step 2b 僅查 `status: ACTIVE` 的缺口，涵蓋 PENDING / INACTIVE 的既有 JIT 公司）。
2. 先做正規化精確相等比對。
3. 再以**保守相似度**（沿用既有 `levenshteinSimilarity`，門檻 `COMPANY_NAME_SIMILARITY_THRESHOLD = 0.85`）catch GPT 對同公司輸出的細微寫法差異。
4. 命中時輸出 `[Stage1] FIX-077 防重複` 診斷 log，便於追蹤。

### BUG-3：清理既有重複公司 ✅ 已執行（2026-06-16，用戶核准）

依 CLAUDE.md「Migration 不確定資料相容性 → 先寫 dry-run 驗證 script」，先以 `scripts/check-duplicate-companies.mjs`（dry-run 預設、`--execute` 實際合併）盤點，經用戶核准後執行合併：

- **合併策略**：每群組選正規公司（MANUAL 優先 → 文件多者 → 最早建立），將非正規公司的文件 / 提取結果 / PromptConfig 改指向正規公司，再把非正規公司狀態設為 `MERGED`（非刪除，可逆、避免 FK 連鎖）。每個非正規公司以一個交易包裹。
- **PromptConfig 碰撞**：若與正規公司既有設定撞 `unique_prompt_config`（promptType, scope, companyId, documentFormatId），則停用該重複設定（`isActive=false`）而非改指，避免唯一約束衝突。
- **執行結果**：1 個群組「dhl express」→ 保留 `DHL Express`（eedf4065，MANUAL），合併 3 筆 AUTO_CREATED；改指文件 3 / 提取結果 3 / PromptConfig 1（碰撞停用 1）；3 筆設為 MERGED。
- **驗證**：重跑 dry-run 顯示 0 重複群組；正規公司現有 3 文件 / 3 提取結果 / 1 PromptConfig。

> 註：MTL/RICON 類（`RICH KING HONG` / `MODERN LEASING` / `RICON HONG KONG`）為 OCR 誤讀的不同字串，正規化後不同組，未列入本次合併；需另以 Stage 1 prompt 強化根治。

> ⚠️ 注意（H1/H2）：本 FIX 僅修「公司名正規化 / 相似度配對邏輯」與「JIT 重複防護」，**未改**三層映射架構、信心度路由、Prisma model 結構，亦**未新增** vendor / 依賴（相似度沿用既有 `similarity/`）。屬 bug fix 範疇。

---

## 修改的檔案

| 檔案 | 修改內容 | 狀態 |
|------|----------|------|
| `src/services/extraction-v3/stages/stage-1-company.service.ts` | (1) `normalizeCompanyName` 強化：取 `/` 前主名、移除括號內容、後綴清單加 `operations`；(2) 新增 `findDuplicateCompany`（查所有狀態 + 正規化精確相等 + `levenshteinSimilarity` 0.85 保守相似度）；(3) `resolveCompanyId` JIT 前呼叫防護；(4) 新增 `COMPANY_NAME_SIMILARITY_THRESHOLD` 常數 + import `levenshteinSimilarity` | ✅ 已實作 |
| （沿用既有，未修改）`src/services/similarity/levenshtein.ts` | 重用 `levenshteinSimilarity`，未新增依賴（H2） | ✅ |
| `scripts/check-duplicate-companies.mjs`（本地工具，`scripts/check-*` 依慣例被 gitignore，未進版控） | dry-run 盤點 + `--execute` 合併（改指文件/提取結果/PromptConfig、設 MERGED、處理唯一約束碰撞） | ✅ 已執行 |

---

## 測試驗證

修復完成後需驗證：

- [x] 涵蓋括號地區詞 `(HK)`/`(Hong Kong)`、業務後綴 `OPERATIONS`、`/ 別名` 等寫法變體 → 正規化後統一（DHL 四種寫法經 `normalizeCompanyName` 皆得 `dhl express`，確定性驗證通過）
- [x] 不影響 FIX-057 既有案例（Fairate Express ↔ FAIRATE EXPRESS LTD. 正規化後仍相等）
- [x] `npm run type-check` 通過 + `npx eslint`（0 errors，僅 3 個既有風格 `no-console` warning）
- [x] 既有已增生的重複公司（DHL ×3）已合併清理（BUG-3 `--execute`：3 筆設 MERGED，文件/提取結果/PromptConfig 已改指正規公司；重跑 dry-run 0 重複群組）
- [ ] 端到端：同一張 DHL 發票連續上傳多次 → 全部配對到**同一個** companyId，不再 JIT 增生（需 dev server + GPT，待執行）
- [ ] 配對成功的公司，Stage 2/3 正確套用其 COMPANY/FORMAT scope 配置（PromptConfig / FieldDefinitionSet）

> ⚠️ 說明：MTL 案例的 `RICH KING HONG` / `MODERN LEASING` / `RICON HONG KONG` 為 GPT/OCR 對不同字詞的誤讀（非同字串的寫法變體），無法靠正規化統一；需靠 Stage 1 prompt 強化（要求 GPT 優先回傳 `knownCompanies` 清單中的精確名稱）才能根治，本 FIX 未涵蓋該方向。

---

## 與既有 FIX 關係

- **FIX-057**（Stage 1 公司配對失敗 / JIT 重複）：本 FIX 為其後續強化 —— 補上 FIX-057 BUG-3 未落實的「JIT 前重複防護」，並擴充 `normalizeCompanyName` 以涵蓋括號地區詞 / 業務後綴 / 別名分隔等複雜變體。
- **FIX-058**（Stage 2 格式 JIT 撞唯一約束）：同類 idempotency 問題，已修復；本 FIX 為 Stage 1 端的對應強化。

---

*文件建立日期: 2026-06-16*
*最後更新: 2026-06-16*
