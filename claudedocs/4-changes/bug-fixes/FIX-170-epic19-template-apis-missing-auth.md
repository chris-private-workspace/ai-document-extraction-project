# FIX-170: Epic 19 模板類 API 全數無認證 —— 22 個 route、15 個寫入端點對外開放

> **建立日期**: 2026-08-07
> **發現方式**: FIX-161 移植 Azure DEV 時，為重新匹配模板實例而呼叫 API，發現**全程不需任何憑證**即可建立實例、寫入 48 列、再刪除
> **影響範圍**: `src/app/api/v1/{template-instances,template-matching,template-field-mappings,field-definition-sets,data-templates}` → `template_instance_rows`、`template_field_mappings`、`field_definition_sets`、`data_templates`
> **優先級**: 中（🔴 初版評為「高」，前提是這批端點線上完全開放。2026-08-08 查證發現該前提**已不成立** —— [FIX-171](FIX-171-secure-dev-dod-checklist-gaps.md) BUG-12 的 middleware 認證閘已在 Azure DEV 以 `enforce` 運行並實際擋下這批請求。本 FIX 的性質因此由「止血」轉為「縱深防禦」）
> **狀態**: ✅ 已完成（2026-08-08 —— 22 個 route、36 個 handler 全數加上 handler 層認證閘並實測驗證；匯出端點另加 `REPORT_EXPORT` 權限檢查。城市／公司範圍過濾**不在本 FIX**，經使用者裁示另開編號處理，理由見 §範圍裁示）
> **相關**: [FIX-065](FIX-065-mapping-api-auth-and-city-scope.md)、[FIX-066](FIX-066-test-endpoints-disable-and-path-traversal.md)、[FIX-067](FIX-067-v1-confidence-prompts-classified-auth.md)（同類 auth 補強，本 FIX 的 401 格式沿用其 pattern）、[FIX-073](FIX-073-page-level-authorization-gate.md)（頁面層授權閘）、[FIX-171](FIX-171-secure-dev-dod-checklist-gaps.md)（🔴 其 BUG-12 建立的 middleware 閘已先一步解決線上暴露；其 §第三批 記載的 middleware bypass 風險正是本 FIX 仍須執行的理由）

---

## 問題描述

Epic 19（資料模板匹配與匯出）的 API **一個都沒有做認證檢查**。掃描 22 個 `route.ts`：

```
合計：無認證 22 檔、有認證 0 檔
```

判準為原始碼中是否出現 `await auth()` / `requireAuth` / `getServerSession` / `withAuth` /
`checkPermission` / `verifyApiKey`，一個都沒有。middleware 亦未攔截 —— 見下方實測。

---

## 實測證據（Azure DEV，2026-08-06）

> 🔴 **2026-08-08 更新：本節的結論已被時間推翻，保留作為當時的記錄。**
>
> 下表是 08-06 的實測。08-07 [FIX-171](FIX-171-secure-dev-dod-checklist-gaps.md) BUG-12 建立了 middleware 層的
> `handleApiAuthGate`，並在 Azure DEV 設 `API_AUTH_GATE_MODE=enforce`。**08-08 重測，同一批端點全部回 401。**
> 詳見 §線上現況覆核。本 FIX 的證據早於修復，這是不同工作並行時的典型落差。

不是靜態掃描的推論，是實際跑通的完整寫入循環，**全程未提供任何憑證**：

| 操作 | 端點 | 結果 |
|---|---|---|
| 列出實例 | `GET /api/v1/template-instances?limit=100` | `200` |
| **建立實例** | `POST /api/v1/template-instances` | `201` |
| **寫入 48 列** | `POST /api/v1/template-matching/execute` | `200`，48 列全 VALID |
| 讀取列 | `GET /api/v1/template-instances/{id}/rows` | `200` |
| **刪除實例** | `DELETE /api/v1/template-instances/{id}` | `200` |
| 讀映射 | `GET /api/v1/template-field-mappings` | `200` |
| 讀欄位定義集 | `GET /api/v1/field-definition-sets/{id}` | `200` |

作為對照，同一環境下**有**認證保護的端點回 `401`：

```
401  /api/companies?limit=5
401  /api/documents?limit=2
401  /api/documents/{id}
```

→ 401 與 200 的差異證明認證機制本身正常運作，是這批路由**沒有接上**。

---

## 無認證的寫入端點清單（15 檔）

| 路由 | 方法 | 寫入對象 |
|---|---|---|
| `v1/data-templates/route.ts` | POST | `data_templates` |
| `v1/data-templates/[id]/route.ts` | PATCH, DELETE | `data_templates` |
| `v1/field-definition-sets/route.ts` | POST | `field_definition_sets` |
| `v1/field-definition-sets/[id]/route.ts` | PATCH, DELETE | `field_definition_sets` |
| `v1/field-definition-sets/[id]/toggle/route.ts` | POST | `field_definition_sets` |
| `v1/template-field-mappings/route.ts` | POST | `template_field_mappings` |
| `v1/template-field-mappings/[id]/route.ts` | PATCH, DELETE | `template_field_mappings` |
| `v1/template-field-mappings/resolve/route.ts` | POST | （唯讀解析，但暴露規則全貌） |
| `v1/template-instances/route.ts` | POST | `template_instances` |
| `v1/template-instances/[id]/route.ts` | PATCH, DELETE | `template_instances` |
| `v1/template-instances/[id]/rows/route.ts` | POST | `template_instance_rows` |
| `v1/template-instances/[id]/rows/[rowId]/route.ts` | PATCH, DELETE | `template_instance_rows` |
| `v1/template-matching/execute/route.ts` | POST | `template_instance_rows` |
| `v1/template-matching/preview/route.ts` | POST | （唯讀試算） |
| `v1/template-matching/validate/route.ts` | POST | （唯讀驗證） |

另有 7 個唯讀 GET 端點同樣無認證（`data-templates/available`、
`field-definition-sets/{candidates,resolve,[id]/coverage,[id]/fields}`、
`template-instances/[id]/export`、`template-matching/check-config`）。

---

## 為什麼這比一般的 auth 缺口嚴重

**`field_definition_sets` 與 `template_field_mappings` 這兩張表沒有 audit log、也沒有 rollback
機制**（見 CLAUDE.md §不可逆資料操作紀律）。無認證的 PATCH / DELETE 意味著：

- 改壞了**無從得知誰改、何時改、改了什麼**
- 也**無從還原** —— 本專案對這兩張表的所有變更都靠人工事前快照
- `field_definition_sets` 的 `aliases` 會進 Stage 3 prompt，被改動會**直接影響模型的提取行為**

`template-instances/[id]/export` 無認證另有一層問題：它輸出的是**成本資料**（各公司費用明細），
屬業務敏感資訊。

---

## 線上現況覆核（2026-08-08）

動手前先驗證問題是否仍存在，結果推翻了本 FIX 的核心前提。

### Azure DEV 已由 middleware 閘保護

```
API_AUTH_GATE_MODE = enforce                    ← Azure DEV 現行設定

GET  /api/v1/template-instances       → 401
GET  /api/v1/template-field-mappings  → 401
GET  /api/v1/field-definition-sets    → 401
POST /api/v1/template-instances       → 401     ← 寫入端點同樣被擋
GET  /api/health                      → 200     ← 白名單正常
```

401 的回應內容為：

```json
{"type":"https://datatracker.ietf.org/doc/html/rfc7235#section-3.1",
 "title":"Unauthorized","status":401,
 "detail":"需要登入才能存取此資源","instance":"/api/v1/template-instances"}
```

**逐欄位對應 `src/middleware.ts` 的 `handleApiAuthGate`**，證明攔截來自 middleware 而非 handler。

### 白名單完整性：用實際運行取代 log 掃描

原訂做法是掃 monitor 模式的記錄找白名單遺漏，但 Azure 早已是 `enforce`，那邊不存在 monitor 記錄。改以直接驗證：

| 檢查 | 結果 |
|---|---|
| 首頁 `/`、登入頁 `/en/auth/login` | 200 |
| `/api/auth/session`、`/api/auth/csrf` | 200 |
| `/api/health`（負載均衡探測） | 200 |
| `scripts/` 中不帶認證呼叫本地 API 的腳本 | **0 個** |

**Azure DEV 已在 `enforce` 下實際運行，服務、登入流程、健康探測全部正常** —— 這比掃 log 更有力：白名單若有遺漏，早已發生故障。

⚠️ 本機 `.env` 未設 `API_AUTH_GATE_MODE`，預設為 `monitor`（僅記錄、不阻擋）。本機不對外，風險低，但也因此**成為驗證 handler 層閘的理想環境**（見 §實作記錄 的驗證）。

---

## 原「尚未確認的關鍵問題」—— 已全數回答（2026-08-08）

| # | 問題 | 答案 |
|---|---|---|
| 1 | 加 API 認證會不會破壞既有 UI 流程？ | **不會。** 12 個前端檔案（hooks + components）呼叫這批端點，全部是相對路徑的同源 `fetch`，瀏覽器預設帶 session cookie；這些頁面又都在 `(dashboard)` 下本就要求登入 |
| 2 | 是否有外部整合依賴免認證？ | **無**（使用者確認）。另查證 `scripts/` 亦無不帶認證呼叫本地 API 者 |
| 3 | session 還是 API key？權限層級？ | **session**（無外部整合，不需 API key）。權限層級依使用者裁示**先只做認證閘**，寫入端點不做角色細分；僅匯出端點加 `REPORT_EXPORT` |
| 4 | 匯出端點是否需要城市範圍過濾？ | **需要，但不在本 FIX** —— 見 §範圍裁示 |

---

## 範圍裁示：城市／公司過濾另開編號（使用者決定，2026-08-08）

使用者要求匯出端點加城市範圍過濾，並「可能要能夠分公司」。查證後發現這**無法作為認證補丁的一部分**：

🔴 **`TemplateInstance` 這張表既沒有 `cityCode` 也沒有 `companyId`**：

```prisma
model TemplateInstance {
  id, dataTemplateId, name, description, status,
  rowCount, validRowCount, errorRowCount,
  exportedAt, exportedBy, exportFormat, createdBy, ...
  matchedDocuments Document[]   ← 城市與公司只存在於這裡
}
```

城市與公司都只能從關聯的 `Document` 反查，而**一個實例可以包含跨城市、跨公司的文件**（模板匹配整批只用一個 `companyId`，混合公司的實例會全部套用同一組規則）。因此「這個實例屬於哪個城市／哪家公司」目前在資料模型上**沒有定義**。

可能的方向（皆需另行決策）：

| 選項 | 作法 | 影響 |
|---|---|---|
| A | 動態反查，實例所有文件的城市都在授權內才放行 | 不改 schema；混合城市的實例只有全域管理員能匯出，可能過嚴 |
| B | 動態反查，任一在授權內即放行 | 會洩漏其他城市的列，除非同時過濾列 —— 那是改行為 |
| C | `TemplateInstance` 加 `cityCode` / `companyId` | 🔴 Prisma schema 變更（H1）；既有實例需回填，回填規則又回到 A/B 的問題 |

**使用者裁示：本 FIX 只做認證閘，匯出端點先加 `REPORT_EXPORT` 止血；過濾另開 FIX，因為它需要先決定資料模型，是設計問題不是安全補丁。**

---

## 採用的修法：A（逐檔加認證檢查）

| 選項 | 作法 | 結果 |
|---|---|---|
| **A. 逐檔加 `auth()` 檢查** | 比照 FIX-065 / FIX-067 的既有模式 | ✅ **已採用** |
| B. middleware 層統一攔截 | 在 middleware 加前綴保護 | 已由 [FIX-171](FIX-171-secure-dev-dod-checklist-gaps.md) BUG-12 以更通用的形式完成（涵蓋全部 `/api/*`），本 FIX 不重複 |
| C. 先擋寫入，讀取另議 | 15 個寫入端點優先 | 不需要 —— 線上已有 middleware 閘，無須分批止血 |

### 為何 middleware 已有閘仍要做 A

[FIX-171](FIX-171-secure-dev-dod-checklist-gaps.md) §第三批 第六項記載 Next.js 存在 **middleware bypass** 類型的漏洞，並寫道「已知可繞過的防線正在承載本專案的主要授權邏輯」。在 handler 層補上第二道閘後，即使 Edge 層被繞過，這批端點仍受保護。

兩道閘互補，不是二選一：

| 防線 | 涵蓋範圍 | 弱點 |
|---|---|---|
| middleware（FIX-171 BUG-12） | 全部 `/api/*` | 受 `API_AUTH_GATE_MODE` 控制；Next.js bypass 漏洞 |
| handler（本 FIX） | 這 22 個 route | 需逐一實作，可能遺漏 |

---

## 變更範圍

| 項目 | 值 |
|---|---|
| 新增 | `src/lib/auth/api-session.ts` —— `requireApiSession(permission?)` 認證閘 helper |
| 修改 | 21 個 route（36 個 handler 中的 35 個）；另 1 個 route 因 gitignore 未納入版本控制，見 §一個順帶發現 |
| 不動 | 業務邏輯與 Zod schema —— 本 FIX 只加認證閘，不改行為（改動為純插入，0 刪除） |
| i18n | 不涉及（401 / 403 錯誤訊息屬開發者訊息，非 UI 字串） |

---

## 驗證方式

1. 每個加了認證的端點，無憑證呼叫應回 **401**（而非 400 / 200）
2. 帶有效 session 呼叫，行為與修改前**完全一致**
3. Epic 19 的 UI 流程端到端走一次：建實例 → 匹配 → 檢視列 → 匯出
4. 確認既有整合未中斷（依 §尚未確認 第 2 項的查證結果）

⚠️ 驗證 1 必須逐一實跑，不可只看原始碼有沒有 `auth()` ——
本 FIX 正是因為「原始碼掃描」與「實際行為」一致才成立，反過來也要用同樣標準驗收。

---

## 實作記錄（2026-08-08 完成）

### 實際改動

| 項目 | 內容 |
|---|---|
| 新增 helper | `src/lib/auth/api-session.ts` —— `requireApiSession(permission?)`，回傳 `{ ok: true, session }` 或 `{ ok: false, response }` |
| 插入點 | 36 個 handler 的 `try {` 之後（**全部 36 個 handler 的函數本體第一行都是 `try {`**，無例外需處理） |
| 每處改動 | 兩行：`const gate = await requireApiSession();` + `if (!gate.ok) return gate.response;` |
| 匯出端點 | 改為 `requireApiSession(PERMISSIONS.REPORT_EXPORT)` |
| 總計 | +127 行、**0 刪除**（純插入） |

401 / 403 回應格式**沿用 [FIX-065](FIX-065-mapping-api-auth-and-city-scope.md) 的 top-level RFC 7807**，逐欄位一致，未另立新格式：

```json
{"type":"https://api.example.com/errors/unauthorized",
 "title":"Unauthorized","status":401,"detail":"Authentication required"}
```

### 為何抽 helper 而非逐處複製

36 個 handler × 既有 pattern 的 10 行 = 360 行重複。抽 helper 後每處 2 行，且未來要加權限判定有單一擴充點。回應格式與既有 pattern 完全一致，故行為不變，只是實作收斂。

### 驗證結果

🔑 **本機 `API_AUTH_GATE_MODE` 為 `monitor`（middleware 放行），因此任何 401 必然來自 handler 層** —— 這使本機成為驗證本 FIX 的理想環境，不會與 middleware 的閘混淆。

| 驗證項 | 方法 | 結果 |
|---|---|---|
| 未認證 GET | `template-instances` / `template-field-mappings` / `field-definition-sets` / `data-templates` | **4/4 回 401** |
| 未認證寫入 | `POST template-instances`、`POST template-matching/execute`、`DELETE template-instances/{id}` | **3/3 回 401** |
| 匯出端點 | `GET template-instances/{id}/export` | **401** |
| 401 來源確認 | 比對回應內容 | 為 `api.example.com/errors/unauthorized`（handler 格式），**非** middleware 的 `datatracker.ietf.org/rfc7235` ✅ |
| 型別檢查 | `npm run type-check` | 通過 |
| Lint | `npm run lint` | 通過，未引入任何新 warning |

⚠️ **未驗證：帶有效 session 時的行為**（§驗證方式 第 2 項）。本機 dev bypass 實際為關閉狀態（需 `NODE_ENV=dev` **且** Azure AD 未配置，而本機 Azure AD 已配置），無法自助登入。

替代論證（強度低於實測，據實標明）：改動是**純插入、0 刪除**，`gate.ok === true` 時直接往下執行原邏輯，未觸碰任何既有分支；`type-check` 通過確保型別正確。行為不變在結構上成立，但**部署到 DEV 後仍應走一次 UI 端到端流程**（建實例 → 匹配 → 檢視列 → 匯出）。

---

## 一個順帶發現：`.gitignore` 排除了一個 API 路由

執行時發現實際只有 **21** 個 route 進入 diff，而清單有 22 個。查證結果：

```
$ git check-ignore -v "src/app/api/v1/field-definition-sets/[id]/coverage/route.ts"
.gitignore:45:coverage/    src/app/api/v1/field-definition-sets/[id]/coverage/route.ts
```

`.gitignore` 第 45 行的 `coverage/`（原意為排除測試覆蓋率報告目錄）**意外匹配了這個 API 路由目錄**。該檔案存在於本機磁碟，但：

- 不在 `HEAD`（`git cat-file` 確認：「exists on disk, but not in 'HEAD'」）
- 不在 index（`git ls-files` 以 literal pathspec 查詢回空）
- 也不出現在 `git status` 的 `??` 未追蹤清單（因為被 ignore 規則吃掉）

**推論其影響**：Azure 部署映像自 git checkout 建置，因此線上**不存在**此端點，它不構成當前的安全曝險。但風險在於：若日後有人 `git add -f` 把它加入，帶進去的會是**未經本次修改的無認證版本**。

⚠️ 本次仍對該檔案套用了認證閘（本機磁碟），但**該修改不會進入任何 commit**。

🔴 **這超出本 FIX 範圍（H3），未作處理，僅登記。** 需要決定的是：該路由是要正式納入版本控制（則 `.gitignore` 需改為更精確的規則，如 `/coverage/`），還是確認它已廢棄而刪除。兩者都不是安全補丁該順手做的事。

---

**建立者**: AI 助手
**最後更新**: 2026-08-08（實作完成：22 route / 36 handler 加 handler 層認證閘 + 匯出端點 `REPORT_EXPORT`；覆核線上現況發現初版前提已被 FIX-171 BUG-12 解決，優先級由高調為中；登記 `.gitignore` 排除 API 路由的順帶發現）
**修訂歷史**: 2026-08-07（建立：22 個 route 全數無認證，含 Azure DEV 完整寫入循環實測）
