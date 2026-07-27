# CHANGE-111: LLM Gateway 執行期強制 `allowSensitiveData` 資料出境護欄

> ⚠️ **本文原編號 CHANGE-110，2026-07-27 改為 CHANGE-111**：取號當下 `origin/main` 最大為 CHANGE-109，但同日 main 另行合併了 PR #153/#154 的 **CHANGE-110（in-process scheduler for stuck-processing sweeper）**，兩邊並行撞號。依「main 已合併者不動」原則改本文編號。
> 📌 已推送的 commit `2c936fd` 的 message 仍寫 CHANGE-110，無法追改；程式碼與測試中的註解引用已一併更新為 CHANGE-111。
>
> **建立日期**: 2026-07-27
> **狀態**: ✅ 已完成（2026-07-27；`type-check` / `lint` / `test` 237/237 通過。⚠️ 純政策攔截、無真實非 Azure 流量可端到端驗證——實機驗證需等 Story 23.4 打通後補）
> **優先級**: 中（今日零流量影響；但非 Azure 打通後它是唯一防線）
> **類型**: Feature（規格已要求、實作缺漏）
> **影響範圍**: `src/services/llm/llm-gateway.service.ts`（`ResolvedModel` + `prepare`）、gateway 單元測試
> **關聯**: Epic 23 Story 23.3 / D4 護欄 / tech-spec §7 資料合規

---

## 背景與問題

`LlmProvider.allowSensitiveData` 是 D4 決議的**資料出境護欄**。後台表單上呈現為：

> 允許敏感資料 —— 允許將發票資料送往此供應商。**非 Azure 供應商需經組織核准。**

2026-07-27 實機測試 Epic 23 後台時，全專案搜尋 `allowSensitiveData` 的結果如下：

| 出現位置 | 用途 |
|---|---|
| `src/lib/validations/llm-provider.schema.ts:47,60` | Zod 驗證 |
| `src/services/llm-provider.service.ts:77,174,208-209,568,603` | CRUD 寫入 / 遮罩輸出 |
| `src/hooks/use-llm-providers.ts:55,76,89` | 前端型別 |
| `src/components/features/llm-provider/LlmProviderForm.tsx` | 表單欄位 |
| `src/components/features/llm-provider/LlmProviderList.tsx:134` | 列表顯示 |
| **`src/services/llm/`（gateway 呼叫路徑）** | **零引用** |

也就是說：這個勾選框**存得進去、顯示得出來，但執行時完全不生效**。勾或不勾，gateway 都照送。

### 為何至今沒有出事

另一道閘門擋著：`llm-model-config.service.ts:202-209` 的 `getStageModel` 只在 `providerType === 'AZURE_OPENAI'` 時回傳該模型的 key，非 Azure 指派一律 fallback 回 Azure。所以目前沒有任何真實流量會走到非 Azure provider。

### 為何現在就要補

那道閘門是為了 D9（信心度校準未定案）而設的**暫時**閘門，Story 23.4 打通非 Azure 時會被移除。屆時 `allowSensitiveData` 就是阻止發票資料流向未經核准供應商的**唯一防線**——而它現在是空的。

趁現在補的成本是零：沒有任何非 Azure 流量，加上這道檢查不會改變任何現有行為。等到打通時才補，等於在最需要它的那一刻才開始寫它。

---

## 設計決策

### 決策 1：插入點選 `prepare()`

三個候選位置，關鍵差異在**熔斷器記帳**與**覆蓋範圍**：

| 候選 | 覆蓋 failover？ | 會誤記熔斷失敗？ | 判定 |
|---|---|---|---|
| `safeDispatch()` | ✅ | 🔴 **會** —— `dispatchWithResilience:377-380` 把 dispatch 失敗計入熔斷 | ❌ 政策拒絕不是 provider 健康問題 |
| `call()` Phase 1 之後 | ❌ failover 另走 `tryFailover` → 可繞過 | 否 | ❌ 有繞道 |
| **`prepare()`** | ✅ 主要與 failover 都經過它 | 否——`call():331-337` 明確歸類為「config / 解析錯誤 → **不**計入熔斷」 | ✅ **採用** |

`prepare()` 另有一個附帶好處：`tryFailover:423-427` 對 `prepare` 失敗的處理已經是「放棄 failover、維持原結果」，所以 failover 目標若未經核准會被**安靜地拒絕切換**，不需要額外程式碼。

`prepare()` 同時被 `describeCall()` 使用，意即未經核准的 provider 連「呼叫計畫」都產不出來。這是刻意的：一個必然會被拒絕的呼叫，不應該被描述成可行。已確認 `describeCall` **僅在測試中使用**（無 UI／API 依賴），不影響任何頁面。

### 決策 2：範圍限定「非 Azure」

護欄只對 `providerType !== 'AZURE_OPENAI'` 生效。理由：

- D4 與表單文案的意圖明確指向**非 Azure**（「非 Azure 供應商需經組織核准」）；Azure 是 tech-spec §7 的**既定合規基準**，`scripts/epic-23/seed-llm-providers.ts:54` 也註明 `allowSensitiveData: true // Azure = §7 既定合規基準`。
- 對 Azure 一併強制會有回歸風險：若任何環境（如 Azure DEV）存在 `allowSensitiveData=false` 的 Azure provider 列，gateway 灰度一開即全數拒絕。收益為零、風險非零。

> ⚠️ **已知的殘留不一致**：Azure provider 若在 UI 取消勾選「允許敏感資料」，執行時仍然不會被擋。這是上述取捨的已知代價，非疏漏。若日後要收斂，應與 Azure provider 列的資料盤點一起處理。

---

## 變更內容

### 1. `ResolvedModel` 新增 `allowSensitiveData`

`resolveModel` 已使用 `include: { provider: true }`（`llm-gateway.service.ts:687`），欄位本來就在查詢結果內，**不需要改任何查詢**，只需帶進回傳物件。

### 2. `prepare()` 加政策檢查

```
providerType !== 'AZURE_OPENAI' && !allowSensitiveData
  → throw LlmGatewayError(..., 'SENSITIVE_DATA_NOT_ALLOWED')
```

錯誤訊息需說明「此 provider 未經核准接收發票資料」並點名 provider，讓維運看得懂該去哪裡勾選。

### 3. 錯誤碼

新增 `SENSITIVE_DATA_NOT_ALLOWED`，與既有 `MODEL_DISABLED` / `PROVIDER_DISABLED` / `MISSING_CREDENTIAL` 同層級。

> 📌 **實作時的更正**：本文原先寫「呼叫端可依錯誤碼判斷」，實際查證後 `LlmCallResult`（`llm-gateway.types.ts:91-109`）**只有 `error?: string`、沒有錯誤碼欄位**，既有的 `MODEL_DISABLED` / `MISSING_CREDENTIAL` 同樣只以訊息呈現。
> 決定**沿用既有 pattern**、不為此擴張回傳契約（無任何呼叫端需要程式化判斷）。驗收條件已相應改為驗證錯誤訊息。

### 4. 測試

| 測試 | 驗證 |
|---|---|
| 未核准的非 Azure provider → `call()` 回 `success:false` + 錯誤訊息含「未經核准」 | 主要路徑被擋 |
| 被擋時**不曾**呼叫 `generateText` / `generateObject` | 確實在送出前攔截 |
| 被擋時**不計入**熔斷器失敗 | 政策拒絕 ≠ provider 健康問題 |
| 已核准的非 Azure provider → 正常送出 | 不誤擋 |
| Azure provider 即使 `allowSensitiveData=false` 仍放行 | 決策 2 的範圍限定 |

既有 `llm-gateway-anthropic.test.ts` 的 mock 需補 `allowSensitiveData: true`（該檔驗證的是接線正確性，非政策）。

---

## 驗收條件

- [x] `ResolvedModel` 帶 `allowSensitiveData`，且未新增任何 DB 查詢（沿用既有 `include: { provider: true }`）
- [x] 未核准的非 Azure provider 無法送出任何請求（測試斷言 `generateText` / `generateObject` 皆未被呼叫）
- [x] 政策拒絕不計入熔斷器（斷言 `snapshot()` 無該 providerId、`getState()` 為 `CLOSED`）
- [x] failover 不會切到未核准的 provider（`tryFailover` 經同一 `prepare()`，既有的「prepare 失敗 → 放棄切換」處理自動涵蓋）
- [x] Azure 行為零變更（含 `allowSensitiveData=false` 的 Azure provider 仍放行）
- [x] `npm run type-check` / `lint` / `test`（237/237）全過

---

## 不在本次範圍

| 項目 | 理由 |
|---|---|
| 移除 `getStageModel` 的 Azure 閘門（真正打通非 Azure） | Story 23.4 / D9 定案後 |
| Azure provider 也強制此旗標 | 見決策 2 的取捨與殘留不一致 |
| 在 UI 上顯示「此 provider 因未核准而被 gateway 拒絕」 | 目前無流量會觸發；有需要再議 |
| 讓 `LlmCallResult.providerType` 在設定類錯誤時仍有值 | 實作時發現：`prepare()` 拋錯 → `call()` Phase 1 以 `resolved: undefined` 組結果，故**所有**設定類錯誤（含 `MODEL_DISABLED`、`MISSING_CREDENTIAL`）都遺失 providerType，觀測記錄亦然。**非本護欄特有**，修它要動共用錯誤路徑，屬獨立議題。本護欄改以錯誤訊息攜帶 providerId 補足 |
| `scripts/tsconfig.json` 的 `paths` 設定錯誤（`baseUrl: ".."` 配 `"@/*": ["../src/*"]` 會解析到 repo 之外） | 零影響，已記入 backlog |
