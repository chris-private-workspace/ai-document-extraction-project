/**
 * @fileoverview key-based 呼叫端接入 LLM Gateway 的共用橋接（Epic 23 - Story 23.4 Phase 1）
 * @description
 *   Story 23.1 已讓 extraction 三階段（`gpt-caller.service.ts`）走 gateway；Phase 1 把其餘
 *   6 個生產 LLM 呼叫點也接上。這些呼叫點的共同形狀是「modelKey + 訊息（可帶圖）→ content
 *   字串（部分另需 token 用量）」，故抽出本橋接，避免每個服務各寫一份相同的
 *   「查 flag → 解析 modelId → 映射 `LlmCallInput` → 映回結果」樣板。
 *
 *   **兩種回傳語意（呼叫端據此決定行為，缺一不可）**：
 *     - 回 `null` = **本次不走 gateway**（flag 關 / 灰度未命中 / 該 modelKey 未播種）
 *       → 呼叫端回退既有直接 Azure 路徑，**行為零變**。
 *     - **throw** = 走了 gateway 但呼叫失敗 → 呼叫端既有的 `try/catch`（retry / 業務降級）
 *       照舊接手。gateway 本身回 `success:false` 而不拋，這裡轉成 throw 是為了讓 6 個呼叫點
 *       維持「API 失敗 ＝ 例外」的既有控制流（tech-spec §3.7：業務層 fallback 留在呼叫端，
 *       如 `ai-term-validator` 失敗時退回 rule-based 判斷）。
 *
 *   ⚠️ **失敗不回退舊路徑**（與回 `null` 的情況不同）：flag 開啟後 gateway 即擁有該次呼叫，
 *   失敗時由呼叫端既有降級處理。失敗才回退會造成重複計費，並掩蓋 gateway 的真實問題。
 *
 * @module src/services/llm/gateway-bridge
 * @since Epic 23 - Story 23.4
 * @lastModified 2026-07-27
 *
 * @related
 *   - src/services/extraction-v3/stages/gpt-caller.service.ts - Story 23.1 已遷移的呼叫點
 *     （自帶 `callViaGateway`，映射到該檔專屬的 `GptCallResult`，不經本橋接）
 *   - docs/04-implementation/tech-specs/epic-23-multi-llm-provider/tech-spec-epic-23-overview.md §3.6
 */

import { shouldUseLlmGateway } from '@/config/feature-flags';

import { llmGatewayService } from './llm-gateway.service';
import type {
  LlmCallInput,
  LlmCallUsage,
  LlmImagePart,
  LlmMessage,
  LlmOutputSpec,
} from './llm-gateway.types';

/**
 * 橋接輸入：`LlmCallInput` 的 key-based 子集（以白名單 `modelKey` 取代 `LlmModel.id`）。
 * 欄位語意與 `LlmCallInput` 同名欄位一致，逐一對應各呼叫點既有的請求參數。
 */
export interface GatewayBridgeInput {
  /** 白名單模型 key（如 `gpt-5.4-mini`）；解析為預設啟用 Azure provider 下的 `LlmModel.id` */
  modelKey: string;
  /** 保真訊息（忠實反映各呼叫點既有的 system/user 擺法，tech-spec §3.5） */
  messages: LlmMessage[];
  /** 可選圖片（純文字呼叫點不傳） */
  images?: LlmImagePart[];
  /** 輸出模式（對應既有 `response_format` 三態，tech-spec §3.6；省略時 gateway 預設 `text`） */
  output?: LlmOutputSpec;
  maxOutputTokens?: number;
  /** capability 不支援時由 gateway 丟棄、不報錯 */
  temperature?: number;
  /** 技術層 retry；呼叫端已有自己的重試迴圈時傳 `0`，避免重試次數相乘 */
  maxRetries?: number;
  abortTimeoutMs?: number;
  /** provider 專屬選項（如 reasoning 模型的 `{ openai: { reasoningEffort: 'low' } }`） */
  providerOptions?: LlmCallInput['providerOptions'];
}

/** 橋接結果：對齊呼叫端既有取值方式（content 字串 + token 用量） */
export interface GatewayBridgeResult {
  /** 原始 content（gateway 不代 parse，呼叫端保留既有容錯解析） */
  content: string;
  usage: LlmCallUsage;
}

/**
 * 經 `LlmGatewayService` 呼叫；不適用時回 `null` 讓呼叫端走既有直接 Azure 路徑。
 *
 * @param input 橋接輸入（見 {@link GatewayBridgeInput}）
 * @returns content + 用量；`null` 表示應回退舊路徑
 * @throws {Error} gateway 回報失敗時拋出，交由呼叫端既有的 retry / 業務降級處理
 *
 * @remarks
 *   灰度以 {@link shouldUseLlmGateway} 判斷但**不帶** fileId：這 6 個呼叫點的作用域內都沒有
 *   文件識別，且各自為單次獨立呼叫（不像 extraction 三階段需同一文件恆走同一路徑），
 *   故百分比灰度退回隨機分流即可（預設百分比 100，實務上等同硬切換）。
 */
export async function callGatewayByModelKey(
  input: GatewayBridgeInput
): Promise<GatewayBridgeResult | null> {
  if (!shouldUseLlmGateway()) {
    return null;
  }

  const { modelKey, ...callInput } = input;

  // 未播種（gateway 資料表沒有這個 modelKey）→ 回退舊路徑，播種缺失時零風險
  const modelId = await llmGatewayService.resolveModelIdByKey(modelKey);
  if (!modelId) {
    return null;
  }

  const result = await llmGatewayService.call({ modelId, ...callInput });

  if (!result.success) {
    throw new Error(result.error ?? `LLM gateway 呼叫失敗（${modelKey}）`);
  }

  return { content: result.text, usage: result.usage };
}
