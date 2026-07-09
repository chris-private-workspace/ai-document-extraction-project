/**
 * @fileoverview LLM Gateway 統一呼叫介面型別（Epic 23 - Story 23.1 step 3）
 * @description
 *   provider-agnostic 的請求/回應型別，對應 tech-spec §3.4–3.6：
 *     - `LlmCallInput`：模型 id + 訊息 + 可選圖片 + 三態 output + 能力參數。
 *     - `LlmCallResult`：統一回應（原始 text + 可選 object + usage + 錯誤，不代呼叫端 parse）。
 *     - `LlmCallPlan`：去敏的請求組裝快照（§3.8 遷移驗證用，**不含憑證**）。
 *   型別刻意與 provider SDK 解耦；gateway 內部才映射到 Vercel AI SDK 的 `ModelMessage` 等。
 *
 * @module src/services/llm/llm-gateway.types
 * @since Epic 23 - Story 23.1
 * @lastModified 2026-07-09
 */

import type { LlmProviderType } from '@prisma/client';

/** 訊息角色（忠實對應現況 system/user/assistant 擺法，§3.5） */
export type LlmMessageRole = 'system' | 'user' | 'assistant';

/** 單則訊息（純文字；圖片走 `LlmCallInput.images`） */
export interface LlmMessage {
  role: LlmMessageRole;
  content: string;
}

/** 圖片內容（§3.5：映射 AI SDK v6 FilePart） */
export interface LlmImagePart {
  /** 圖片資料：data URI（`data:image/png;base64,...`）或純 base64 */
  data: string;
  /** MIME 類型，預設 `image/png` */
  mediaType?: string;
  /** 解析度提示（保留欄位；AI SDK 目前由 provider 預設處理） */
  detail?: 'auto' | 'low' | 'high';
}

/** 三態結構化輸出（§3.6） */
export type LlmOutputSpec =
  /** 純文字（#2/#5/#7，無 response_format） */
  | { mode: 'text' }
  /** 期待 JSON 但無 strict schema（#3/#4/#6；呼叫端自行容錯解析） */
  | { mode: 'json' }
  /** structured（#1，帶 JSON Schema） */
  | { mode: 'object'; jsonSchema: Record<string, unknown>; name?: string };

/** 統一呼叫輸入（§3.4） */
export interface LlmCallInput {
  /** `LlmModel.id`：gateway 解析 provider + 模型 + capability */
  modelId: string;
  /** 保真訊息（system/user/assistant，可多段） */
  messages: LlmMessage[];
  /** 可選圖片（純文字呼叫不傳；空值不視為錯） */
  images?: LlmImagePart[];
  /** 輸出模式（省略時預設 `text`） */
  output?: LlmOutputSpec;
  /** 上限輸出 token（省略時採 capability.maxTokens） */
  maxOutputTokens?: number;
  /** 溫度（capability 不支援則丟棄、不報錯；省略時採 capability 預設） */
  temperature?: number;
  /** 技術層 retry 次數（省略時預設 2；§3.7） */
  maxRetries?: number;
  /** provider 專屬選項（§3.4 G4，如 `{ openai: { reasoningEffort: 'low' } }`） */
  providerOptions?: Record<string, Record<string, unknown>>;
  /** 呼叫逾時（毫秒；省略時預設 5 分鐘，對齊現行 gpt-caller） */
  abortTimeoutMs?: number;
}

/** Token 使用量 */
export interface LlmCallUsage {
  input: number;
  output: number;
  total: number;
}

/** 統一呼叫結果（§3.4；gateway 不吞呼叫端業務 fallback） */
export interface LlmCallResult {
  success: boolean;
  /** 原始 content（gateway 不代 parse，保留呼叫端容錯） */
  text: string;
  /** `mode:'object'` / `mode:'json'` 成功時（AI SDK 已 parse） */
  object?: unknown;
  usage: LlmCallUsage;
  modelId: string;
  /** 解析成功後才有；解析失敗（如未知 modelId）為 undefined */
  providerType?: LlmProviderType;
  finishReason?: string;
  durationMs: number;
  error?: string;
}

/**
 * 去敏的請求組裝快照（§3.8 遷移驗證：比對 gateway 送出內容，非 LLM 回應）。
 * **刻意不含憑證 / baseURL 完整路徑**；供 step 4 遷移等價比對與單元測試。
 */
export interface LlmCallPlan {
  modelId: string;
  providerType: LlmProviderType;
  /** 實際 Azure 部署名稱（env 覆蓋 → 模型預設） */
  deploymentName: string;
  /** 僅 host（不含完整路徑 / 金鑰） */
  baseUrlHost: string;
  apiVersion: string;
  outputMode: LlmOutputSpec['mode'];
  messageRoles: LlmMessageRole[];
  imageCount: number;
  maxOutputTokens: number;
  temperature?: number;
  maxRetries: number;
}
