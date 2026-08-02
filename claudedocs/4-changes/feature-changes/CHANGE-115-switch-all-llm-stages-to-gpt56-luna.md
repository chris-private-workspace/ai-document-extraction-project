# CHANGE-115: 全面切換 LLM 至 gpt-5.6-luna

> **建立日期**: 2026-08-02
> **變更類型**: 模型切換（同 vendor：Azure OpenAI，換模型版本與資源）
> **觸發原因**: 使用者要求 —— 新模型 gpt-5.6-luna 價格更便宜
> **狀態**: ✅ 已實作（本地 `type-check` / `lint` / `test` 453 通過；**實機端到端驗證通過**；⏳ 待部署 Azure DEV）
> **相關**: CHANGE-099（模型白名單機制）、CHANGE-100 / CHANGE-102（前兩次模型汰換）、FIX-137（`isReasoningModel` 漏判，本次同型再現）、Epic 23 Story 23.4（per-環節指派）

---

## 決策

使用者於 2026-08-02 選擇**方案 A：全面切換**（另兩個選項為「兩資源並存」與「在原資源建 luna」）。

代價已明確告知並接受：**沒有回退路徑**。詳見 §不可逆性。

---

## 實機探測結果（本次改動的證據基礎）

所有 capability 皆對 Azure deployment `gpt-5.6-luna` **實際發送請求**取得，非查文件推測：

| 能力 | 結果 | 與舊 `gpt-5.4-mini` 對比 |
|---|---|---|
| deployment 可用 | ✅ 模型回報 `gpt-5.6-luna-2026-07-09` | — |
| **vision（圖片輸入）** | ✅ 支援 | 相同（提取管線的必要條件） |
| **json_schema** | ✅ 支援 | 相同（Stage 3 的必要條件） |
| **temperature** | 🔴 **不支援** | **不同** —— 舊模型設 0.1 |
| `max_completion_tokens` 上限 | 128,000 | 舊為 8,192 |

temperature 的實際錯誤訊息：

```
Unsupported value: 'temperature' does not support 0.1 with this model.
Only the default (1) value is supported.
```

> `maxTokens` 白名單仍填 **8192** 而非 128000：輸出上限不影響品質，放大只在異常時多燒 token。需要更長輸出時再單獨調整。

---

## 改動清單

### 白名單與預設（3 層）

| # | 檔案 | 改動 |
|---|---|---|
| 1 | `src/lib/constants/llm-models.ts` | `AVAILABLE_LLM_MODELS` 改為只含 `gpt-5.6-luna`；`DEFAULT_STAGE_MODELS` 三個 Stage 全指向它 |
| 2 | `src/lib/constants/llm-stages.ts` | 9 個 LLM 環節的 `defaultModelKey` 全部更新 |
| 3 | `src/services/extraction-v3/stages/gpt-caller.service.ts` | `GptModelType` 型別、`nano/fullDeploymentName`、`callNano` / `callFull` 的 model 值 |

### 各服務的獨立預設

`term-classification` / `ai-term-validator` / `gpt-vision` / `unified-gpt-extraction` / `gpt-mini-extractor` 五處 `DEFAULT_MODEL_KEY`。

### 🔴 `isReasoningModel` 漏判修復

`gpt-mini-extractor.service.ts` 的 pattern 只認 `-nano` 與 `-mini`：

```js
/gpt-5(\.\d+)?-nano/i,
/gpt-5(\.\d+)?-mini/i,
```

`gpt-5.6-luna` **兩者皆不匹配** → 回 `false` → 會送 `temperature` + `max_tokens` 而非 `max_completion_tokens` → **每次呼叫都 400**。

這與 FIX-137 是**完全同型**的漏判（當時是 5.4 系列不匹配 `/gpt-5-nano/`），只是換了型號。已加 `/gpt-5(\.\d+)?-luna/i`。

> ⚠️ 該清單本質是「用名字猜能力」，每出一個新型號就會再漏判一次（FIX-137 一次、本次一次）。權威來源其實是白名單的 `capability.supportsTemperature`。已在程式碼加註「長期應改為查白名單」，本次未擴大範圍處理。

### 測試

4 個測試檔更新，並補一項防回歸：

- `llm-models.test.ts` —— 白名單斷言改為 luna；「歷代舊模型已移除」的清單加入 5.4 系列
- `stage-model-assignment.test.ts` —— 原本 `expect(['gpt-5.4-mini','gpt-5.4-nano']).toContain(...)` 把模型名硬編在測試裡，改為 `isValidLlmModel()` **動態查驗白名單**，往後換模型不會再壞
- `llm-deployment-fallback.test.ts` —— 新增 `isReasoningModel('gpt-5.6-luna')` 必須為 `true` 的斷言（釘住上述漏判）
- `gpt-caller-gateway-routing.test.ts` —— model key 更新

---

## 🔴 不可逆性：切換後無回退路徑

新 endpoint 指向**另一個 Azure 資源**（`chris-mj48nnoz-eastus2`，非專案原本的 `AIServices-RAPOSCM-AIDocProcessing-DEV`）。實測該資源上：

```
gpt-5.4-mini-aidocprocessing  → 404 DeploymentNotFound
gpt-5.4-nano-aidocprocessing  → 404 DeploymentNotFound
```

而 `llm-models.ts` 的設計是**所有模型共用同一組 endpoint + API key**（CHANGE-100 既有前提）。因此：

- 舊模型 key 保留在白名單也無法使用 → 已一併移除（與 CHANGE-102 移除 `gpt-5.2` 的理由相同：deployment 不存在、留著只會讓後台顯示選了必 404 的選項）
- **要回退必須改回舊 endpoint**，程式碼層面無法切換

若日後需要多資源並存，須讓白名單支援 per-model 的 endpoint/key —— 那是架構變更（觸及 H1），本次未做。

---

## 未處理項目

| 項目 | 原因 |
|---|---|
| **成本定價未更新** | `ai-cost.service.ts` 的 `DEFAULT_PRICING.AZURE_OPENAI` 只列 `gpt-5.2` / `gpt-4o` / `gpt-4o-mini`，**5.4 系列本來就沒列**、一直套用 `default` 價格。使用者尚未提供 luna 單價，不猜價格 → 維持現狀（仍走 `default`）。取得單價後應補一筆 |
| **模型 label 未 i18n** | `llm-models.ts` 的 `label` 是硬編碼中文（`GPT-5.6 Luna（單一主力）`），`messages/` 內查無任何模型名稱字串 → UI 直接顯示該欄位。此為 CHANGE-099 起的既有模式，非本次引入；i18n 化屬另一項工作 |
| **Azure DEV 線上環境** | App Service 讀自己的環境變數，不受本機 `.env` 影響。要讓線上也用 luna，須另外設定該處的 endpoint / API key |

---

## 驗收

- [x] `type-check` 通過
- [x] `lint` 通過（僅既有 warning，均在未改動檔案）
- [x] `test` **453 passed / 2 skipped**（原 452，+1 為新增的 reasoning 判定測試）
- [x] **實機端到端驗證**（走專案實際的 `GptCallerService`，非直接打 API）：

| 路徑 | 結果 |
|---|---|
| `callNano`（Stage 1/2，含圖片） | ✅ 回 `{"status":"ok"}` |
| `callFull` + json_schema（Stage 3） | ✅ 回 `{"invoiceNumber":"INV-001","total":1234.56}` |

  白名單解析出的部署名為 `gpt-5.6-luna`；`capability.supportsTemperature=false` 確實使
  `gpt-caller.service.ts:279` 傳入 `undefined`，未送出 temperature（否則必 400）。

- [ ] ⏳ 部署 Azure DEV 後，以真實發票重跑提取，確認三個 Stage 皆正常
- [ ] ⏳ 取得 luna 單價後補上 `DEFAULT_PRICING`
- [ ] ⏳ 準確率回歸：Epic 23 tech-spec §6.1 要求核心提取環節換模型前做準確率回歸與 per-model 信心度校準。本次為同 vendor 換版，未執行完整回歸 —— 建議部署後以一批已知結果的文件比對

---

## 相關

- CHANGE-099 — 模型白名單機制（本次沿用其「新增模型在此加一筆」的設計）
- CHANGE-100 / CHANGE-102 — 前兩次模型汰換，本次比照其移除失效 key 的處理
- FIX-137 — `isReasoningModel` 漏判的首次發生；本次同型再現
- Epic 23 Story 23.4 — per-環節模型指派；9 個環節的 `defaultModelKey` 本次一併更新
- `claudedocs/reference/data-semantic-breakpoints.md` — `extraction_results.gpt_model_used` 的值自本次部署起由 `gpt-5.4-*` 變為 `gpt-5.6-luna`，跨時間比較模型表現時需以部署日切分
