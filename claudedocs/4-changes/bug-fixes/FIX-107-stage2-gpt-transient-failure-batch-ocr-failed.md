# FIX-107: Azure OpenAI 服務端瞬斷致整批 Stage 2 失敗 → OCR_FAILED（含系統性重試弱點）

> **建立日期**: 2026-07-13
> **發現方式**: 用戶回報（Quentin Liu —— `CEVA LOGISTICS_RCEX240706_00543.pdf` 顯示 `OCR Failed / Processing Failed`）+ DB 查詢 + 容器 log
> **影響頁面/功能**: 文件處理管線（Stage 2 格式匹配）/ 文件列表頁 + 詳情頁
> **優先級**: 中（事故本身為外部瞬斷、已自行恢復；但暴露之系統性弱點值得處理）
> **狀態**: 🔍 **根因已確認（Azure OpenAI 服務端瞬斷，外部因素）；資料已由重試恢復；弱點 A（重試退避）已修並於 2026-07-14 部署至 Azure DEV，B/C 待決定**
> **最後更新**: 2026-07-14（弱點 A 已部署 —— 映像 `dev-fix108-20260714135401`）
> **關聯**: FIX-106（同為文件卡失敗但根因不同 —— 106 是應用端記憶體飽和，本 FIX 是外部 GPT 瞬斷）、FIX-094（殭屍回收）

> ⚠️ **本 FIX 與 FIX-106 無關**。FIX-106 是應用端事件迴圈飽和致「靜默卡 `OCR_PROCESSING`」；本 FIX 是 Azure OpenAI 服務端一次短暫故障致「整批 Stage 2 失敗、明確標 `OCR_FAILED`」。兩者症狀不同、根因不同、修法不同。

---

## 1. 問題描述

2026-07-13，一批 CEVA 文件在處理時顯示 `OCR Failed / Processing Failed`、`Low Confidence 0%`。用戶提供的其中一行：

| 欄位 | 值 |
|------|-----|
| 檔名 | `CEVA LOGISTICS_RCEX240706_00543.pdf` |
| 狀態 | OCR Failed / Processing Failed |
| 建立（UI，UTC+8） | Jul 13 11:04 AM |
| 開始 / 結束（UI，UTC+8） | 11:15 AM / 11:16 AM |
| 耗時 | 72.1s |
| 信心度 | 0% |

時區換算：11:15 AM (UTC+8) = **03:15 UTC**。

---

## 2. 調查方式

| 資料 | 取得方式 |
|------|----------|
| 文件 `error_message` / 狀態 / 時間戳 | Kudu 容器內純 `SELECT`（`documents` + `extraction_results` 表） |
| 同窗口失敗文件清單與狀態分佈 | 同上，時間窗 `2026-07-13 02:55–03:40 UTC` |
| 處理路徑（retry / 重試次數） | `AppServiceConsoleLogs`（Log Analytics，`03:15–03:17 UTC`） |

> 私有端點，本機不可達；經 Kudu（`<scm>/api/command`，AAD bearer + `curl --resolve`，runbook §8）在容器內以 `pg` 執行。

---

## 3. 證據（真實查詢回傳）

### 3.1 錯誤內容（9 份文件完全一致）

`documents.error_message` / `extraction_results.error_message`（逐字）：

```
Stage 2 failed: GPT API 錯誤: 400 - {
  "error": {
    "message": "{\"error\": {\"message\": \"The model was unable to complete inference due to an internal error.\"}}",
    "type": "invalid_request_error",
    "param": "prompt",
    "code": "invalid_prompt"
  }
}
```

### 3.2 同窗口（02:55–03:40 UTC）狀態分佈

| 狀態 | 份數 |
|------|------|
| `OCR_FAILED` | 9 |
| `MAPPING_COMPLETED` | 1 |

9 份失敗文件於 `03:04:13`（274 毫秒內）建立，全部在 `03:16:20–03:16:41`（約 20 秒窗口）失敗，`extraction_results.average_confidence` 皆為 0、`total_fields` 皆為 0，耗時 72–79 秒。

失敗文件（document ID）：
```
953bd931  eba98ae1  d36a4cc9  31b35ca7  2f0b9227
d8aaaac4  1e3739f6  952702ab  b4f50bd9
```

### 3.3 關鍵反證：同一檔案稍後重試即成功

| document | 檔名 | 狀態 | 信心度 | 處理時間 |
|----------|------|------|--------|----------|
| `953bd931` | `CEVA LOGISTICS_RCEX240706_00543.pdf` | `OCR_FAILED` @ 03:16 | 0% | 72.1s |
| `86395b2e` | `CEVA LOGISTICS_RCEX240706_00543 (1).pdf`（**同 93237 bytes**） | `MAPPING_COMPLETED` @ 05:29 | **95.85%** | 19.3s |

同樣的檔案內容，2.5 小時後重試即成功、11 欄位全映射。

### 3.4 容器 log：這批是「重試」觸發

`AppServiceConsoleLogs`（`03:15–03:17 UTC`）顯示全為 `[Retry] Processing completed for <id>` —— 這 9 份是透過 `/api/documents/[id]/retry` 批次重試（文件 03:04 已建立、之前已失敗過），此次重試又整批撞上 Stage 2 GPT 故障。另見 `03:15:11` 一筆 `Retry error: Cannot retry document with status: OCR_PROCESSING`（呼應 FIX-106：`OCR_PROCESSING` 不在可重試清單）。

---

## 4. 根本原因

### 4.1 直接根因：Azure OpenAI 服務端一次短暫故障（外部因素）

Stage 2（格式匹配，模型 gpt-5.4-nano）的 GPT 呼叫回 `400 invalid_prompt`，但**內層訊息是 Azure 自己的用語** `The model was unable to complete inference due to an internal error` —— 即服務端內部錯誤被包成 400 外殼回傳（Azure OpenAI 已知行為）。

判定為外部瞬斷的依據：
1. **9 份同時、同一錯誤、同一 20 秒窗口** → 服務端整體性故障，非個別文件/prompt
2. **同一檔案 2.5 小時後成功**（§3.3）→ 排除檔案或 prompt 本身問題
3. 錯誤訊息為 Azure 服務端自述的 `internal error`

**此非應用程式 bug。** 程式行為正確：有重試、失敗有記錄、`error_message` 完整（不同於 FIX-106 的靜默）。

### 4.2 為何應用端重試未能救回

`gpt-caller.service.ts`（及 `unified-gpt-extraction.service.ts`）的重試迴圈：`retryCount: 2`（共 3 次嘗試）、退避 `retryDelay * (attempt+1)` = 1s / 2s，且**對所有錯誤一律重試**（不分辨 400/429/500）。

3 次嘗試在約 3 秒內打完，而該次 Azure 降級持續整個窗口 → 3 次全撞、無一成功。

### 4.3 公開狀態頁查無此事故（已查證，屬正常）

- [Azure status history](https://azure.status.microsoft/en-us/status/history/)：7/13 無記錄；最近為 5/29
- [downforai](https://downforai.com/azure-openai)：過去 30 天無事故

**「公開查無」不等於「沒發生」**：公開狀態頁只登跨客戶/多區域/數十分鐘級的大事故；本次為單一部署、東亞區、約一分鐘的瞬斷，遠低於通報門檻。第一手證據（§3 的 9 筆一致 `internal error` + 同檔案後成功）對此規模的瞬斷比公開頁更有力。

---

## 5. 系統性弱點（非本次 bug，待決定是否修）

| # | 弱點 | 說明 | 修法方向 | 狀態 |
|---|------|------|----------|------|
| A | **重試退避太短** | 3 次、1s/2s，約 3 秒打完，無法騎過數十秒級的 provider 降級 | 拉長退避（指數 + 上限）、或失敗後延遲重新入列 | ✅ **已實作**（§5.1） |
| B | **transient GPT 失敗 → 永久 `OCR_FAILED`，只能手動重試** | 與 FIX-094/106 同主題的「無自動回收」缺口，觸發源不同（此為 Azure OpenAI） | 對 transient 分類的失敗建立延遲自動重試（需設計，H1） | ⬜ 待決定 |
| C | **對 `400 invalid_prompt` 一律重試** | 方向對（因其可能包 internal error），但程式無法區分「真非法 prompt」（不該重試）與「內部錯誤偽裝成 400」（該重試） | 依內層 message / code 細分可重試性 | ⬜ 待決定 |

> B/C 皆屬既有設計弱點、非本次事故引入。是否修、修哪些，需用戶決定（涉及重試策略調整，可能觸發 H1）。

### 5.1 已實施：弱點 A —— 指數退避 + jitter（2026-07-13）

| 項目 | 內容 |
|------|------|
| 改動 | `gpt-caller.service.ts`（Stage 1/2/3）+ `unified-gpt-extraction.service.ts`（V3 單次），兩處結構相同的直接 fetch 重試迴圈 |
| Commit | `95edb86` |
| 改法 | ① `retryCount: 2 → 4`（3 → 5 次嘗試）；② 退避由線性 `retryDelay * (attempt+1)` 改為 `min(retryDelay * 2^attempt, 15000)`，再套 equal jitter `base/2 + random(0, base/2)` |
| 效果 | 重試窗口由**約 3 秒**（1s+2s）拉長至**約 15 秒**（基準 1/2/4/8s，加 jitter） |
| jitter 理由 | 重試路徑為併發批次（事故當日 ~10 份同時重試）；無 jitter 會同步重試形成 retry storm。**Azure 5/29 跨區 8 小時大事故的官方根因正是 retry storm 打爆 inference load balancer** —— jitter 直接避免自身貢獻此放大 |
| 附帶影響 | `gpt-caller` 的 Epic 23 gateway 路徑把 `retryCount` 當 `maxRetries` 傳入（`:347`），故 gateway 路徑亦多試幾次（用 AI SDK 自帶 backoff） |
| 驗證 | `npx eslint` 通過；`npm run type-check` 剩餘 4 個錯誤全在 `src/services/llm/`（本地缺 Epic 23 套件），與本改動無關 |
| 🔴 **侷限** | **只解決短暫 blip（幾秒~十幾秒），解決不了本次那種持續 72 秒以上的降級**（每份文件全程都在故障窗口內）。若本次事故重演，此改動未必救得回 —— 那屬弱點 B（延遲重新入列）範疇 |
| 部署 | ✅ **已部署**至 Azure DEV（2026-07-14，映像 `dev-fix108-20260714135401`），現已生效 |

---

## 6. 待辦

- [x] ~~立即補救：重試 §3.2 的 9 份 `OCR_FAILED`~~（用戶已於 2026-07-13 重試成功，證實外部瞬斷已恢復）
- [x] ~~弱點 A：拉長重試退避（指數 + jitter）~~（已完成 2026-07-13，commit `95edb86`，見 §5.1；**已於 2026-07-14 部署，現已生效**）
- [ ] 決定是否處理 §5 系統性弱點 B/C（需用戶拍板；若處理，建對應 CHANGE/FIX）
- [x] ~~部署：弱點 A 改動手動部署至 Azure~~（已完成 2026-07-14，映像 `dev-fix108-20260714135401`；部署記錄 `docs/07-deployment/02-azure-deployment/deployment-records/2026-07-14-dev-fix108.md`）
- [ ] （選）覆核近期其他 `OCR_FAILED` 是否亦為同類 GPT 瞬斷（可用 `error_message ILIKE '%internal error%'` 掃描）

---

## 7. 資料來源與可信度

- §3.1／§3.2／§3.3 取自 2026-07-13 經 Kudu 在容器內執行的純 `SELECT` 查詢（`documents` + `extraction_results`），無任何寫入。
- §3.4 取自 2026-07-13 `AppServiceConsoleLogs`（Log Analytics，`03:15–03:17 UTC`）實際回傳。
- §4.2 的重試參數依 `gpt-caller.service.ts:173-174`、`unified-gpt-extraction.service.ts:158-159` 及重試迴圈（`:259-289` / `:230-272`）原始碼。
- §4.3 的公開狀態頁結論取自 2026-07-13 WebSearch / WebFetch 實際回傳。
- 本文件初為調查記錄；資料已由用戶重試恢復。已實作 **§5.1 弱點 A**（commit `95edb86`），且**已於 2026-07-14 部署**至 Azure DEV（映像 `dev-fix108-20260714135401`）；弱點 B/C 仍未執行。

---

*文件建立日期: 2026-07-13*
*最後更新: 2026-07-13*
