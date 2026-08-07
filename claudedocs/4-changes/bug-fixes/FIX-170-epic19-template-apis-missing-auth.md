# FIX-170: Epic 19 模板類 API 全數無認證 —— 22 個 route、15 個寫入端點對外開放

> **建立日期**: 2026-08-07
> **發現方式**: FIX-161 移植 Azure DEV 時，為重新匹配模板實例而呼叫 API，發現**全程不需任何憑證**即可建立實例、寫入 48 列、再刪除
> **影響範圍**: `src/app/api/v1/{template-instances,template-matching,template-field-mappings,field-definition-sets,data-templates}` → `template_instance_rows`、`template_field_mappings`、`field_definition_sets`、`data_templates`
> **優先級**: 🔴 高（15 個寫入端點無認證，其中兩張表無 audit log 也無 rollback）
> **狀態**: 📋 規劃中
> **相關**: [FIX-065](FIX-065-mapping-api-auth-and-city-scope.md)、[FIX-066](FIX-066-test-endpoints-disable-and-path-traversal.md)、[FIX-067](FIX-067-v1-confidence-prompts-classified-auth.md)（同類 auth 補強）、[FIX-073](FIX-073-page-level-authorization-gate.md)（頁面層授權閘）

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

## 尚未確認的關鍵問題（修法前必須回答）

| # | 問題 | 為何重要 |
|---|---|---|
| 1 | Epic 19 的 UI 頁面（`/admin/test/template-matching`、`/template-instances`）在 `(dashboard)` 路由組下，本身受 session 保護。加 API 認證會不會破壞既有 UI 流程？ | UI 走的是同一批端點，改動需同步驗證 |
| 2 | 是否有外部整合（n8n / 外部 API）依賴這批端點免認證？ | 貿然加認證可能中斷既有工作流 |
| 3 | 應採 session 認證還是 API key？權限層級為何（`GLOBAL_ADMIN` / `CITY_ADMIN` / `REVIEWER`）？ | Epic 19 的操作跨公司，需釐清城市範圍控制 |
| 4 | 匯出端點是否需要額外的城市範圍過濾？ | 成本資料涉及 Epic 6 的多城市隔離 |

🔴 第 2 項尤其不可略過 —— 本專案的 Azure 部署無自動化測試覆蓋這批路由，
中斷了不會立刻被發現。

---

## 建議修法（待使用者拍板）

| 選項 | 作法 | 考量 |
|---|---|---|
| **A. 逐檔加 `auth()` 檢查** | 比照 FIX-065 / FIX-067 的既有模式，每個 route 開頭加 session 檢查 + 401 RFC 7807 | 最直接；22 檔的改動量大但機械化 |
| **B. middleware 層統一攔截** | 在 middleware 加 `/api/v1/template-*` 與 `/api/v1/field-definition-sets` 的保護 | 一處收斂；但需確認 middleware 對 API 路由的既有行為，且較難做細緻的角色判定 |
| **C. 先擋寫入，讀取另議** | 15 個寫入端點優先加認證，7 個 GET 延後 | 風險收斂最快；但匯出端點的成本資料仍暴露 |

**建議 A**，並依 §尚未確認 第 3 項先定權限層級。若時間緊迫可先做 C 的寫入部分止血。

---

## 變更範圍（🔴 修法確定後須精確指名）

| 項目 | 值 |
|---|---|
| 檔案 | 上表 15 個寫入 route（+ 視決議加入 7 個 GET） |
| 不動 | 業務邏輯與 Zod schema —— 本 FIX 只加認證閘，不改行為 |
| i18n | 不涉及（401 錯誤訊息屬開發者訊息，非 UI 字串） |

---

## 驗證方式

1. 每個加了認證的端點，無憑證呼叫應回 **401**（而非 400 / 200）
2. 帶有效 session 呼叫，行為與修改前**完全一致**
3. Epic 19 的 UI 流程端到端走一次：建實例 → 匹配 → 檢視列 → 匯出
4. 確認既有整合未中斷（依 §尚未確認 第 2 項的查證結果）

⚠️ 驗證 1 必須逐一實跑，不可只看原始碼有沒有 `auth()` ——
本 FIX 正是因為「原始碼掃描」與「實際行為」一致才成立，反過來也要用同樣標準驗收。

---

**建立者**: AI 助手
**最後更新**: 2026-08-07
