# CHANGE-103: Stage 1 公司匹配防呆 — 識別/治理分離 + 學習迴路

> **日期**: 2026-07-10
> **狀態**: 🚧 進行中（Phase 1 = 組件 3 學習迴路 ✅ 已實作 + 測試；Phase 2/3 待續。2026-07-10 review 定案）
> **優先級**: High（公司主檔品質 = 三層映射 + template mapping 的根基）
> **類型**: Feature / 架構強化（Stage 1 公司識別防呆）
> **影響範圍**: `src/services/extraction-v3/stages/stage-1-company.service.ts`、`company.service.ts`、（可能）Company schema、公司管理 UI（組件 4）

---

## 變更背景

同一間公司被 Stage 1 建成多筆略不同名字的重複記錄，是**反覆發生**的問題（memory 記載 + FIX-057 + FIX-077 修過兩次仍未根治）。最新實例：Azure DEV 的 **CEVA 分裂成 7 筆**（`CEVA Logistics` 90 筆、`CEVA LOGISTICS (HONG KONG) LIMITED` 32 筆、`...(HONG KONG) LTD` 1 筆、`Hong Kong Limited` 1 筆、`(Hong Kong) Office` 0 筆、`Hong Kong Office` 0 筆、`(RICHASIA) PACIFIC OPERATIONS LIMITED` 1 筆）。最諷刺的是正確全名「CEVA LOGISTICS (HONG KONG) LTD」只有 1 筆，簡稱卻有 90 筆。

### 根因（已親自驗證 code，非推測）

| # | 根因 | 證據 |
|---|------|------|
| 1 | **源頭飄移** | Stage 1 prompt（`stage-1-company.service.ts:264-273`）主動要 GPT「逐字輸出印刷全名，含地區詞/LTD/LIMITED，不縮寫」→ 同公司每次讀出不同字串 |
| 2 | **正規化不足** | `normalizeCompanyName(:546-568)` 只去「括號內容 + 法定後綴」；`Hong Kong`（無括號）、`Office`、`Pacific` 全保留 → 7 種寫法正規化後仍分成 4 組 |
| 3 | **防重網太鬆** | 唯一模糊防護是 `findDuplicateCompany` 的 **0.85 字元級 Levenshtein**（`:74, :603`）；多一個 token 的相似度僅 0.45–0.77，全低於門檻 |
| 4 | **🔴 無學習迴路** | grep 全檔：`nameVariants` 只有讀（429/454/477/481/589/593）+ JIT 建立時 `nameVariants: []`（`:651`），**零個 update** → 變體庫永遠空、比對永遠 miss、無法自我收斂 |

### 為什麼修過兩次仍漏

FIX-057（短名↔後綴）、FIX-077（括號內差異，DHL）都採「正規化 + 精確相等優先、相似度只當保守安全網」，針對括號內或加後綴的差異。CEVA 是「**無括號地區詞 + 多描述 token**」，落在覆蓋範圍外；且兩次都**沒補上變體回寫迴路**，因此治標未治本。

> 本任務源自使用者 2026-07-10 交辦：不要一直清理症狀，要在 Stage 1 做好防呆治本。

---

## 核心設計原則：識別 ≠ 治理

> **Stage 1 只負責「認出這是誰」（識別 / identify），不負責「裁決兩間公司是不是同一間、然後合併」（治理 / govern）。**

合併是**不可逆的破壞性操作**（刪記錄、轉移文件 + mapping），又牽涉業務判斷（`RICHASIA PACIFIC OPERATIONS` 是否為獨立法律實體）。把它放進「每份文件即時處理」的 Stage 1，等於讓演算法在無人把關下不斷做不可逆裁決 — 一旦誤併，文件綁錯公司且難以回頭。

因此本 CHANGE **不在 Stage 1 做自動合併**。收斂現有重複由**獨立、有人工把關的治理流程**（`company.service.mergeCompanies` + 去重報表）處理（見 Phase 3）。

---

## 變更內容（四個組件）

### 組件 1 — Canonical 資料模型（約定，schema 影響最小）

**理念**：每間公司 = 一個「正式全名」+ 一組「變體別名」。匹配吃所有變體，顯示用正式名。

- 現狀 Company 已有 `name`（識別用）+ `displayName`（顯示）+ `nameVariants[]`（別名）。
- **本組件主要是「約定 + 治理」而非 schema 改動**：`name` 視為正式全名（canonical）、`nameVariants` 累積所有印法。現有 `name` 是「先到先得」的隨機值（簡稱），由治理階段（Phase 3）正名為正式全名。
- OQ-1：是否需要新增獨立 `legalName` 欄位以明確區分「正式全名」與「當前顯示名」，或直接用既有 `name`（正名 + `displayName`）即可。

### 組件 2 — 更聰明的配對（token-set 相似度）

**理念**：`ceva logistics` 是 `ceva logistics hong kong` 的**子集**（token containment = 1），該視為同公司強訊號；純字元 Levenshtein 抓不到。

- 在 `findDuplicateCompany`（`:582-614`）與 Step 2b 的比對，除既有正規化精確相等 + Levenshtein 外，**加 token-set 判斷**：
  - token containment（候選的 token 集合 ⊆ 既有的 token 集合，或反之）
  - 或 Jaccard 相似度（token 交集 / 聯集）達門檻
- **防誤併護欄（關鍵）**：token-set 命中後，需再過「核心 token 一致」檢查，避免把 `ceva logistics` 誤併到只是碰巧共享 token 的不同公司；`RICHASIA` / `PACIFIC` 這類**專有分支詞**不可被當雜訊忽略（OQ-4）。
- 同步強化 `normalizeCompanyName`：把常見地區/分支詞（`hong kong`/`hk`/`office`/`branch`）標準化，但**保留可能是實體核心名的詞**（`pacific`/`richasia`）。

### 組件 3 — 學習迴路（配對成功回寫 nameVariants）🥇 最高投報 ✅ 已實作（Phase 1）

**理念**：讓變體庫從「永遠空、查了白查」變成「越用越厚、越來越少 miss」。

- `resolveCompanyId` 的精確匹配路徑（Step 1 / 2a / 2b）**配對成功**後，呼叫新增的 `learnNameVariant`，把 GPT 讀到的 `parsed.companyName` 原印法 append 到該公司 `nameVariants`（去重、不覆蓋）。
- **🔴 零誤併安全閘（定案，取代原「高信心 confidence 門檻」方案）**：僅當原印法**正規化後等於**該公司 `name` / `nameVariants` 任一者的正規化值時才回寫。由於「正規化相等」本就是系統判定同一公司的條件（Step 2b），回寫只是把既有精確匹配快取為變體，**不建立任何新的匹配關係，故零誤併**。此閘同時擋掉 Step 2a「name contains」的不精確子集命中（例：`CEVA` 命中 `CEVA LOGISTICS ...` 但正規化不等 → 不學）。
- **成效範圍（誠實界定）**：組件 3 吸收的是**正規化後會相等**的印法變異（大小寫、括號地區詞 `(HK)`、`LTD/LIMITED`、標點）。CEVA 的 `ceva logistics` vs `ceva logistics hong kong`（無括號多 token）正規化**不相等** → 安全閘擋住不學 → **那種分裂要 Phase 2 組件 2（token-set）才解**。
- 回寫非致命（try/catch，失敗僅 warn，不影響已成立的匹配）。
- 直接用既有 `nameVariants[]` 欄位，**不動 schema**。
- **實作**：`stage-1-company.service.ts` 新增 `learnNameVariant`（helper）+ Step 1/2a/2b 命中處呼叫 + Step 1/2a 的 `select` 補 `nameVariants`。

### 組件 4 — 不確定性閘門（灰帶 → PENDING，不自動繁殖）

**理念**：純配對有極限——全新公司第一次出現一定得建新。關鍵是**建新那一刻有品質閘門**。

- JIT 建立前，若相似度落「灰帶」（例：token containment 高但字元相似度低，或 Levenshtein 落在 0.6–0.85）→ **建 `status: PENDING`**（而非現在硬設的 ACTIVE `:648`）+ 掛「可能重複於 X」標記，**不進 `loadKnownCompanies` 的 ACTIVE 候選**（`stage-orchestrator.service.ts:331-357` 只撈 ACTIVE）。
- 人工在公司管理頁定期審核 PENDING → 確認為新公司（升 ACTIVE）或既有公司變體（merge + 回寫變體）。
- 直接用既有 `status=PENDING` 語意（Company schema 預設本就是 PENDING，`:468`），**schema 不動**；但需要**人工審核 UI**（工程量較大，故列 Phase 2）。

---

## 現狀邏輯（供對照，確認改動點）

`resolveCompanyId`（`stage-1-company.service.ts:415-528`）：

```
Step 1 (424-443): matchedKnownCompany 完全相等（name 或 nameVariants has），ACTIVE
Step 2a (450-468): DB OR — nameVariants has / name ci-equals / name ci-contains，ACTIVE
Step 2b (473-493): normalizeCompanyName 相等（name + nameVariants），ACTIVE
Step 3 (497-521): autoCreate → findDuplicateCompany 防重 → jitCreateCompany（建 ACTIVE, nameVariants:[]）
```

本 CHANGE 改動點：Step 2/Step 3 的比對加 token-set（組件 2）；各配對成功點加回寫（組件 3）；Step 3 JIT 加灰帶判斷 → PENDING（組件 4）。

---

## Open Questions（2026-07-10 review 定案）

| # | 問題 | 定案 |
|---|------|------|
| OQ-1 | Canonical 用既有 `name` 還是新增 `legalName` 欄位 | ✅ A：用既有 `name`（不動 schema，治理階段正名） |
| OQ-2 | 組件 4（PENDING 閘門 + 審核 UI）納入本 CHANGE 還是拆 | ✅ 拆：組件 4 + UI 移 Phase 2 |
| OQ-3 | 變體回寫的護欄 | ✅ 改用**正規化-相等安全閘**（零誤併），不依賴 confidence 門檻；精確匹配才回寫、可自動 |
| OQ-4 | token-set 門檻 + 防誤併不同實體（RICHASIA）機制 | ⏳ 延至 Phase 2（隨組件 2 定義 containment/Jaccard 門檻 + 核心 token 護欄） |

---

## 影響範圍評估

| 文件 | 變更 | 分類 |
|------|------|------|
| `stage-1-company.service.ts` | `normalizeCompanyName` 增強、`findDuplicateCompany` 加 token-set、`resolveCompanyId` 加回寫 + 灰帶 PENDING | 🔧 核心必改 |
| `company.service.ts` | 變體回寫 API（append nameVariants，去重） | 🔧 修改 |
| `src/lib/utils/string.ts` / `company-matcher.service.ts` | 統一正規化 source of truth（消除三套分歧，可選/Phase 2） | 🟡 可選 |
| Company schema | 原則上**不動**（用既有 nameVariants/status）；除非 OQ-1 選 legalName | 🟢 最小/無 |
| 公司管理 UI | PENDING 審核佇列（組件 4，Phase 2） | 🔧 Phase 2 |

### 向後兼容性
- 匹配邏輯只「更容易配到既有」+「配到就學習」，不改既有正確配對行為；回寫是 append（不覆蓋）。
- 灰帶 PENDING 只影響「新建公司」的狀態（ACTIVE→PENDING），不影響既有公司。

---

## 風險評估

| 風險 | 緩解 |
|------|------|
| token-set 太鬆 → 誤併不同實體（RICHASIA / 碰巧共享 token） | 核心 token 一致護欄 + 保守門檻 + 灰帶走 PENDING 人工把關（不自動併） |
| 回寫髒變體（GPT 誤讀）污染變體庫 | 只高信心回寫 + 標 AUTO_LEARNED 供抽查 + append 不覆蓋 |
| 改 Stage 1 核心提取路徑 → 回歸風險 | 完整單元測試（CEVA 7 寫法 + DHL 既有案例 + RICHASIA 不誤併）+ 端到端；分階段上 |
| PENDING 公司導致文件卡住/無 companyId | 明確流程：PENDING 仍綁該文件 companyId（可提取），只是不進「已知公司候選」；人工審核後 merge |

## 回滾計劃
- 純邏輯改動：git revert 對應 commit。
- 組件 3 回寫的變體：可依 `AUTO_LEARNED` 標記批次清除。
- 組件 4 產生的 PENDING 公司：可批次升 ACTIVE 或走既有 merge。

---

## 分階段落地

| Phase | 內容 | 風險 | 產出 |
|-------|------|------|------|
| **Phase 1（治本核心）✅ 已實作** | 組件 3（學習迴路 + 零誤併安全閘） | 低（零誤併） | 逐步吸收「正規化相等的印法變異」，變體庫自我累積、Step 1/2a 命中率上升 |
| **Phase 2（放寬配對 + 閘門）** | 組件 2（token-set 配對 + 正規化增強 + 核心 token 護欄）+ 組件 4（灰帶 → PENDING）+ 公司管理 PENDING 審核 UI | 中（含 UI + 誤併風險，需護欄 + 觀察） | 真正解 CEVA 那種無括號多 token 分裂 + 建新品質閘門 |
| **Phase 3（治理鏈 + 收斂現有）** | 接上去重報表（`scripts/check-duplicate-companies.mjs`）→ 人工確認 → `mergeCompanies`；收斂現有 7 筆 CEVA（本地 + Azure） | 中（業務判斷） | 清掉存量 + 常態化治理 |

> 定案（2026-07-10）：Phase 1 **只上零誤併的組件 3**（先讓 nameVariants 學起來、觀察成效），把有誤併風險的組件 2 併到 Phase 2 跟審核 UI（組件 4）一起做，屆時也有真實資料校準門檻。組件 1（canonical 約定）貫穿各階段，在 Phase 3 治理時落實正名。

---

## 驗收標準

| # | 項目 | 標準 | Phase |
|---|------|------|-------|
| 1 | CEVA 收斂 | CEVA 的 7 種寫法端到端提取 → 對到**同一** companyId（RICHASIA 除外，若判定獨立實體）。⚠️ 需組件 2（token-set），非組件 3 單獨可達 | 2 |
| 2 | 學習生效 ✅ | 配對成功後該公司 `nameVariants` 累積新印法（正規化相等的變異）；單元測試已驗證回寫 + 去重 + 安全閘 | 1 |
| 3 | 不誤併 | DHL 既有案例仍正確；RICHASIA（若獨立）不被併入主 CEVA | 1 |
| 4 | 灰帶閘門 | 灰帶相似度 → 建 PENDING（非 ACTIVE）、不進已知候選 | 2 |
| 5 | 存量收斂 | 現有 7 筆 CEVA 經治理流程合併到正確主版（含正名） | 3 |
| 6 | 品質 gate | type-check / lint / 單元測試 通過 | 各 |

## 測試場景

| # | 場景 | 預期 |
|---|------|------|
| 1 | 連續上傳 CEVA 的 LTD/LIMITED/簡稱/Office 各版本 | 全對到同一 companyId；nameVariants 累積 |
| 2 | 上傳 RICHASIA PACIFIC OPERATIONS | 不被誤併入主 CEVA（獨立或灰帶 PENDING，依 OQ-4） |
| 3 | 上傳全新公司 | 高信心 → ACTIVE；灰帶 → PENDING |
| 4 | 回歸：DHL 四寫法（FIX-077 案例） | 仍對到同一 companyId |

---

## Implementation Notes

### Phase 1 — 組件 3 學習迴路（2026-07-10 實作）

| 項目 | 內容 |
|------|------|
| 改動檔 | `src/services/extraction-v3/stages/stage-1-company.service.ts`：新增 `learnNameVariant` private method + Step 1/2a/2b 命中處呼叫 + Step 1/2a 的 `select` 補 `nameVariants` |
| 測試 | `tests/unit/services/stage-1-company-learn-variant.test.ts`（4 案例：正向學習 / 去重不重複 / 零誤併安全閘擋 `contains` / 回寫失敗容錯）— 全過 |
| 品質 gate | `npm run type-check` ✅ ／ `npm run test`（本檔 4/4）✅ ／ ESLint：僅 1 個 `console.log` warning（沿用同檔 FIX-077 既有 pattern，屬全專案 console.log 漸進清理技術債，非本次新問題類型） |
| schema | 未動（用既有 `nameVariants[]`，`{ push }` atomic append） |
| Strict Mode | H1 未觸發（強化既有 FIX-057/077 方向、未改三層映射/信心度路由/122 Prisma models 結構）；H2/H4/H5/H6 N/A |
| 成效界定 | 只吸收正規化相等的印法變異；CEVA 無括號多 token 分裂待 Phase 2 組件 2 |
| 待續 | Phase 2（組件 2 + 組件 4 + PENDING 審核 UI）、Phase 3（收斂現有 7 筆 CEVA） |
