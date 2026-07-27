# FIX-135: LLM Gateway 把 system 訊息放進 `messages`，`ai@7` 對所有 provider 拋 `InvalidPromptError`

> **建立日期**: 2026-07-27
> **發現方式**: Story 23.3 首次非 Azure provider 實跑（spike harness `scripts/epic-23-spike/stage3-model-comparison.ts`）
> **影響頁面/功能**: `LlmGatewayService` 的**所有**呼叫路徑（Epic 23 gateway）；灰度開關開啟後即影響 extraction Stage 1–3
> **優先級**: 高（缺陷嚴重度為「必然失敗」；但生產未暴露——見〈影響範圍〉）
> **狀態**: ✅ 已完成（2026-07-27）—— `toAiMessages` 抽出 system → `instructions`，補 4 個回歸測試；commit `b52bb9d`

---

## 問題描述

`LlmGatewayService` 把呼叫端傳入的 `role: 'system'` 訊息**原樣放進** AI SDK 的 `messages` 參數。實際安裝的 `ai@7.0.18` 在 `standardizePrompt` 階段會直接拒絕：

```
Invalid prompt: System messages are not allowed in the prompt or messages fields.
Use the instructions option instead.
```

這是 **AI SDK 層的通用檢查，與 provider 無關**——Azure 與 Anthropic 一樣會炸。而 extraction Stage 3 的 prompt **必定**帶 system 段（`buildAiDetails` 存的格式即為 `[SYSTEM]\n...\n\n[USER]\n...`），因此 gateway 的 feature flag 一旦開啟，**每一次提取都會失敗**。

| # | 問題 | 嚴重度 | 影響 |
|---|------|--------|------|
| BUG-1 | system 訊息混在 `messages` → `InvalidPromptError` | 高 | gateway 全部呼叫失敗（非機率性，是必然） |
| BUG-2 | 既有 gateway 單元測試無法偵測此類缺陷 | 中 | 整包 `vi.mock('ai')` 使 `standardizePrompt` 從未執行 |

---

## 重現步驟

1. 準備一個帶 system 段的呼叫：`messages: [{ role: 'system', ... }, { role: 'user', ... }]`
2. 經 `llmGatewayService.call()` 送出（**不 mock** `ai` 模組）
3. 觀察現象：AI SDK 在送出網路請求**之前**即丟 `InvalidPromptError`，`durationMs` 僅個位數毫秒

> 實測記錄（2026-07-27，spike harness，claude-opus-5）：
> `"error": "Invalid prompt: System messages are not allowed in the prompt or messages fields. Use the instructions option instead."`，`"durationMs": 5`

---

## 根本原因

`ai@7` 起，`standardizePrompt` 對 `messages` 做角色檢查（`node_modules/ai/dist/index.js:2446`）：

```js
if (!allowSystemInMessages && messages.some((message) => message.role === "system")) {
  throw new InvalidPromptError2({ ... });
}
```

system 內容改由獨立的 `instructions` 參數承載（型別為 `string | SystemModelMessage | Array<SystemModelMessage>`）。

`llm-gateway.service.ts` 的 `toAiMessages` 原本是**逐則原樣映射**，未區分 system：

```ts
return { role: m.role, content: m.content } as ModelMessage;   // system 也照樣放進 messages
```

`buildSettings` 也只帶 `messages`，完全沒有 `instructions` 欄位。

### 認知落差來源

`AI-HANDOFF.md` §6 原記載「對準 **AI SDK v6**」，而 `package.json` 實際安裝的是 `ai@7.0.18`。system 訊息的處理方式正是 v6 → v7 的破壞性變更，文件與實際版本脫節使這個變更沒有被納入考量。（已於本次一併更正該記載。）

### 為何既有測試沒抓到（BUG-2）

`tests/unit/services/llm-gateway.service.test.ts` 與 `llm-gateway-anthropic.test.ts` 皆在檔案頂端整包 mock 掉 AI SDK：

```ts
vi.mock('ai', () => ({ generateText: vi.fn(), generateObject: vi.fn(), jsonSchema: vi.fn(...) }));
```

`standardizePrompt` 因此從未執行，測試只驗證了「gateway 傳了什麼」，沒有驗證「AI SDK 是否接受」。既有測試甚至**斷言 `messageRoles` 為 `['system', 'user']`**——把錯誤的行為當成契約固定下來。

> **教訓**：涉及外部 SDK **契約**的改動，mock-only 測試不足以構成驗證；必須有一條真實呼叫路徑走過去。本次即由 spike harness 扮演此角色。

---

## 影響範圍

| 項目 | 狀態 |
|------|------|
| 生產（Azure DEV / 正式） | ❌ **未受影響** —— gateway 走 feature flag 灰度，旗標未開，主線 extraction 仍走 `gpt-caller.service.ts` 的手寫 fetch |
| Epic 23 gateway 路徑 | 🔴 **必然失敗**（修復前） |
| 受影響的 provider | **全部**（含 Azure），非 Anthropic 專屬 |
| 資料損毀風險 | 無（在送出請求前即拋錯，不會產生半套結果） |

> 因缺陷完全侷限在「尚未啟用、從未在生產執行過」的 Epic 23 程式碼中，修復隨 Story 23.3 的交付一併提交，未另做熱修部署。

---

## 修復方案

`src/services/llm/llm-gateway.service.ts`：

1. **`toAiMessages`** 改為回傳 `{ instructions?: string; messages: ModelMessage[] }`——過濾出 system 訊息、依原順序以空行（`\n\n`）合併成 `instructions`，其餘訊息留在 `messages`。圖片仍附加到**最後一則 user 訊息**（行為不變）。
2. **`PreparedCall`** 新增 `instructions?: string`；`prepare()` 解構後一併帶入。
3. **`buildSettings`** 有 `instructions` 時才帶入該鍵（無 system 段則完全不出現）。
4. **`summarizeAssembledMessages`** 加第二參數：`instructions` 存在時於快照前置一則 system 條目——system 已離開 `messages`，但 §3.8 的去敏快照仍須如實呈現它確實被送出，否則診斷畫面會看似「prompt 少了 system 段」。
5. **G10 降級路徑**（`generateObject` 失敗 → `generateText`）因沿用 `...settings` 展開，`instructions` 自動保留。

### 回歸測試（`llm-gateway.service.test.ts` 新增 4 個）

| 測試 | 驗證 |
|------|------|
| `should send system content via instructions and keep messages free of the system role` | `instructions === 'sys'` 且 `messages` 角色僅 `['user']` |
| `should merge multiple system messages in order` | 多則 system 依原順序合併為 `'first\n\nsecond'` |
| `should omit instructions entirely when no system message is present` | 無 system 段時不出現 `instructions` 鍵 |
| `should preserve instructions through the G10 text fallback` | 降級到 `generateText` 後 `instructions` 仍在、`messages` 無 system |

---

## 驗證

| 項目 | 結果 |
|------|------|
| `npm run type-check` | ✅ 通過 |
| `npm run lint` | ✅ 0 錯誤（僅既有 `console` 警告） |
| `npm run test` | ✅ 232/232 通過（本 FIX 新增 4 個） |
| 真實呼叫路徑 | ✅ spike harness 修復後成功送達 Anthropic，18/18 回合 0 失敗 |

---

## 相關

- **Story 23.3**（Epic 23 多 LLM Provider）— 本缺陷於該 Story 首次接上非 Azure provider 時發現
- `docs/04-implementation/tech-specs/epic-23-multi-llm-provider/AI-HANDOFF.md` §6 —— 已補記「system 不得放進 `messages`」與 AI SDK 實際版本（v7，非 v6）
- Commit `b52bb9d` —— 修復隨 Story 23.3 的 Anthropic 接線一併提交
