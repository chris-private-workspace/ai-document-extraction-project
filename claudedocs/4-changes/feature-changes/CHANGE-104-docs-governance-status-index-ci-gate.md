# CHANGE-104: 文檔治理債清理 + CHANGE/FIX 狀態索引自動化（CI gate）

> **建立日期**: 2026-07-14
> **發現方式**: 用戶要求盤點「有什麼規劃沒開始／沒完成、有什麼 carryover」→ 盤點過程本身撞上一堆過期／互相矛盾的索引文件，發現真正的問題不是「某份文件過期」而是「索引靠人手同步，必然漂移」
> **影響頁面/功能**: 開發流程與文檔（不涉及任何應用程式碼 / 資料庫 / API）
> **優先級**: 中（不影響線上功能，但直接影響「還有什麼沒做」這個判斷的可信度）
> **狀態**: ✅ 已完成（2026-07-14）
> **關聯**: OQ-Q1（信心度閾值，本 CHANGE 一併 resolved）、FIX-077 重號、`docs/04-implementation/sprint-status.yaml`（本 CHANGE 將其封存）

---

## 1. 問題：索引靠人手同步，必然漂移

盤點時發現的實際狀況：

| 文件 | 宣稱 | 實際 | 漂移幅度 |
|------|------|------|----------|
| `sprint-status.yaml` | Epic 0–21 全 done、**0 個未完成項** | Epic 22、23 根本沒被寫進去；CHANGE-084~103 / FIX-088~108 無任何對應 | 停滯 **5 個月**（最後實質更新 2026-02-06） |
| `claudedocs/reference/project-progress.md` | 「CHANGE 33 份 / FIX 35 份，下一個編號 **034 / 036**」 | 實際已到 CHANGE-103 / FIX-108 | 過期 **70 個編號** |
| `claudedocs/CLAUDE.md` | 「CHANGE 56 份 / FIX 54 份（**全部已完成**）」 | 份數遠超，且 FIX 並非全部完成 | — |
| `known-discrepancies.md` | FIX-055 / FIX-056 列在**「已修復項目」**（日期寫 `2026-XX-XX`） | **兩者從未實作**（狀態皆 📋 規劃中） | 把沒做的說成做完了 |
| `known-discrepancies.md` #11 | 列在「當前 Open 差異」 | CHANGE-090 早已完成並部署驗證（2026-06-24） | 把做完的說成還沒做 |
| `FIX-077` | — | **兩個檔案同號**（`stage1-company-drift` 與 `pipeline-config-refmatch`） | — |

### 根因

**同一事實記錄在多處、靠人手同步。** 對照組很清楚：i18n 同樣涉及大量分散檔案，卻沒有漂移 —— 因為它有 `npm run i18n:check` 且是 **CI required gate**。文檔規則只寫在 CLAUDE.md 的 checklist 裡「請記得更新」，而人（與 AI）就是會忘。

> **結論**：可機器驗證的規則 → 做成 script + CI gate；注定過期的冗餘數字 → 直接刪掉，改由腳本現算。

---

## 2. 解法

### 2.1 治本：狀態索引改為自動生成（單一來源）

| 項目 | 內容 |
|------|------|
| 新增 | `scripts/docs-consistency.js` |
| 新增 npm script | `docs:status`（生成）、`docs:check`（驗證，CI gate） |
| 產出 | `claudedocs/STATUS.md` —— CHANGE/FIX 份數、最大編號、**下一個可用編號**、以及依狀態分組的完整清單 |
| 單一來源 | 各 CHANGE/FIX 檔案自身的 `> **狀態**:` 行。改狀態 → 改該檔案，**不改索引** |

**分類邏輯**：以狀態行**開頭的 emoji** 為主判準（純關鍵字比對太脆弱 —— 「✅ Phase 5 完成」會被「Phase」誤判成進行中），再套兩條修正規則：

- `✅` 但含「尚未／仍待／待驗收／待部署」→ 實為**部分完成**（例：FIX-108 已部署但驗收未做）
- `🚧` 但只寫「待修復／待實作」、無任何完成證據 → 實為**未開始**（例：FIX-060 stub）

且 emoji 取**位置最靠前**者，而非清單順序 —— 否則「🚧 進行中（… ✅ 已實作 …）」會被內文的 `✅` 搶先命中而誤判。

### 2.2 CI gate（`quality-checks.yml` 新增 `docs-check` job，required）

| 規則 | 擋什麼 |
|------|--------|
| **R1** | 編號重複（FIX-077 撞號正是這樣長出來的） |
| **R2** | CHANGE/FIX 缺少可解析的 `> **狀態**:` 欄位 |
| **R3** | `STATUS.md` 與現況不符 —— 新增 CHANGE/FIX 或改其狀態卻沒重跑 `docs:status`（**lockfile 模式**，索引因此不可能再過期） |

> gate 有效性已實測：故意造重號 → R1 fail；故意改狀態不重生成 → R3 fail；還原後皆 pass。

### 2.3 補救（一次性清理）

| 項目 | 處理 |
|------|------|
| **FIX-077 重號** | `FIX-077-pipeline-config-refmatch-scope-guard.md`（2026-06-18 建立、程式碼零引用）→ 改編 **FIX-109**。另一份（2026-06-16、已嵌入 `stage-1-company.service.ts` 十餘處註釋、PR #38）保留 FIX-077 |
| **40 份缺狀態欄位** | 逐份 Read 後依內容證據補上標準狀態行（含 CHANGE-057~070 那批安全治理規劃 → 📋 規劃中）。**只加狀態行，未改動任何其他內容** |
| **FIX-003** | 狀態行 `已修復` 缺 emoji → 補 `✅` |
| **OQ-Q1（信心度閾值）** | **Resolved：文檔對齊代碼 90%/70%**（見 §3） |
| **`sprint-status.yaml`** | 檔頭加封存標註，明確聲明不再維護、不含 Epic 22/23，並指向新來源 |
| **手寫統計數字** | `project-progress.md`、`claudedocs/CLAUDE.md` 的份數／下一個編號 → 移除，改指向 `STATUS.md` |
| **`known-discrepancies.md`** | FIX-055/056 自「已修復」移除（從未實作）；#11 標註實為 Closed；新增「文檔一致性修正」小節 |

---

## 3. OQ-Q1 決議：信心度閾值以代碼為準（90% / 70%）

| 項目 | 內容 |
|------|------|
| 原問題 | CLAUDE.md 寫 95%/80%，代碼實際 90%/70%（`confidence-v3-1.service.ts:112-119`） |
| **決議** | **修文檔、不改代碼** |
| 理由 | 代碼是實際跑了數個月的行為，歷史資料的路由決策全部基於它。改文檔零風險；改代碼會使歷史資料與新資料的路由結果失去可比性 |
| 同步更新 | CLAUDE.md §信心度路由機制 / §When in Doubt / §當前 Open 差異、`docs/open-questions.md`（移入已解決）、`known-discrepancies.md` |
| 後續影響 | Epic 23 Story 23.3 的 per-model confidence 校準以 **90/70** 為基準閾值 |

---

## 4. 修改的檔案

| 檔案 | 修改內容 |
|------|----------|
| `scripts/docs-consistency.js` | **新增** —— 檢查（R1-R3）+ 生成 STATUS.md 雙模式 |
| `claudedocs/STATUS.md` | **新增（自動生成）** —— 狀態索引，勿手改 |
| `package.json` | 新增 `docs:status` / `docs:check` |
| `.github/workflows/quality-checks.yml` | 新增 `docs-check` job（required） |
| `CLAUDE.md` | 信心度閾值 90/70；OQ-Q1 標 resolved；§項目狀態改列三個真實來源；自驗證清單 + 開發工作流加 `docs:check` / `docs:status` |
| `docs/open-questions.md` | OQ-Q1 移入「已解決」 |
| `docs/04-implementation/sprint-status.yaml` | 檔頭加封存標註 |
| `claudedocs/CLAUDE.md`、`claudedocs/reference/project-progress.md` | 移除手寫統計，改指向 STATUS.md |
| `claudedocs/reference/known-discrepancies.md` | 兩處錯誤更正 + 新增「文檔一致性修正」小節 |
| `claudedocs/4-changes/**`（41 份） | 補狀態欄位（40 份）+ FIX-003 補 emoji；FIX-077 → FIX-109 改名 |

---

## 5. 驗證

- [x] `npm run docs:check` → 212 份、**0 錯誤 0 警告**
- [x] R1 實測：故意造重號檔 → 正確 fail
- [x] R3 實測：改狀態不重生成 → 正確 fail；還原後 pass
- [x] 分類抽驗：CHANGE-091 / 103、FIX-094 / 106 / 107 / 108 正確歸「進行中」；CHANGE-018 / 024 / 042 / 087 正確歸「已完成」；FIX-060、CHANGE-056 正確歸「未開始」；FIX-088 正確歸「已取代」
- [x] `npm run lint` 通過

---

## 6. 這次治理**沒有**解決的事（誠實記錄）

- **CHANGE-012** 狀態原為非標準的「⚠️ 需驗證」，只有實作計畫、測試 checkbox 全未勾 → 暫標「🚧 進行中」。**實際是否已實作未經查證**，需查 `historical-data/page.tsx` 的 git 歷史確認。
- **FIX-028 / FIX-029** 檔頭寫「✅ 已完成」但文末寫「驗證狀態：待驗證」，兩者矛盾 → 採檔頭值。
- 部分檔案同時存在新的標準狀態行與舊的狀態表述（摘要表格 / 文末），**未刪除舊表述**（避免在文檔治理的名義下大幅改寫他人內容）。
- 本 CHANGE **只治理 CHANGE/FIX 索引**。`docs/06-codebase-analyze/`（80 份）、Epic 22/23 的進度追蹤仍靠人手，未納入自動化。

---

*文件建立日期: 2026-07-14*
*最後更新: 2026-07-14*
