/**
 * @fileoverview LLM Gateway × AI SDK 真實契約整合測試（Epic 23 - Story 23.4）
 * @description
 *   用**真實的 Stage 3 prompt**（自 DB `extraction_results.stage_3_ai_details` 取出）呼叫
 *   **真正的 `llmGatewayService`**，確認 gateway 組裝出來的請求能被 AI SDK 與 Azure 接受。
 *
 *   **為何需要這一層**（FIX-135 的直接教訓）：
 *   既有 gateway 單元測試整包 `vi.mock('ai')`，`standardizePrompt` 從未執行 → 測試只驗證了
 *   「gateway 傳了什麼」，沒有驗證「AI SDK 是否接受」。FIX-135（system 訊息放進 `messages`
 *   → `ai@7` 對所有 provider 拋 `InvalidPromptError`）因此潛伏到第一次真實呼叫才被抓到。
 *
 *   **為何不用 spike harness**：`scripts/epic-23-spike/stage3-shadow-comparison.ts` 的 gateway
 *   路徑是**鏡射**（複製一份 gateway 的組裝邏輯），不是呼叫 gateway 本身。2026-07-27 實測
 *   證實它已與真 gateway 漂移——FIX-135 修了 gateway 卻沒同步鏡射，harness 因此對「已修好的
 *   gateway」報出 0/2 失敗。鏡射永遠會漂移；只有直接呼叫生產程式碼才驗證得到生產行為。
 *   （harness 仍有其價值：語意層的新舊路徑輸出比對，需要真發票圖，屬另一層。）
 *
 *   ⚠️ **會真實呼叫 Azure OpenAI 並產生費用** → 預設 skip，需 `RUN_GATEWAY_CONTRACT_TEST=1`
 *      才執行，故 `npm run test` 與 CI 不受影響。
 *   ⚠️ 唯讀 DB；只送 Azure（tech-spec §7 既定合規基準），不送任何非 Azure provider。
 *
 * @module tests/integration/llm-gateway-wire-contract.test
 * @since Epic 23 - Story 23.4
 * @lastModified 2026-07-27
 *
 * @usage
 *   RUN_GATEWAY_CONTRACT_TEST=1 npx vitest run tests/integration/llm-gateway-wire-contract.test.ts
 *   前置：DATABASE_URL（含 stage3AiDetails 的資料）+ AZURE_OPENAI_ENDPOINT / AZURE_OPENAI_API_KEY
 *        + DB 內有 enabled 的 Azure provider 與模型（`scripts/epic-23/seed-llm-providers.ts`）
 */

// vitest 不會把 .env 載進 process.env（Vite 只暴露 VITE_ 前綴到 import.meta.env），
// 而本檔需要 DATABASE_URL / AZURE_OPENAI_*。只在本檔載入，不動全域 setup.ts。
import 'dotenv/config';

import { describe, it, expect, beforeAll } from 'vitest';

import { prisma } from '@/lib/prisma';
import { llmGatewayService } from '@/services/llm';
import type { LlmMessage } from '@/services/llm';

/** opt-in gate：未設旗標即整批跳過，避免 `npm run test` / CI 打真實 API */
const ENABLED = process.env.RUN_GATEWAY_CONTRACT_TEST === '1';

/**
 * 1×1 透明 PNG。
 * 目的是走完 gateway 的圖片組裝路徑（`LlmImagePart` → AI SDK `FilePart` + `imageDetail`
 * 轉發），驗證的是**請求結構**能否被接受，而非影像內容——故不需要真實發票 blob。
 * 這讓本測試不依賴 Azurite（本地多數 blob 已 404）。
 */
const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/**
 * 把 Stage 3 存下來的 prompt 還原成 `LlmMessage[]`。
 * 儲存格式為 `[SYSTEM]\n...\n\n[USER]\n...`（見 `buildAiDetails`）。
 * 找不到分段標記時，整段當作單一 user 訊息（仍是有效的契約測試輸入）。
 */
function parseStoredPrompt(raw: string): LlmMessage[] {
  const sysIdx = raw.indexOf('[SYSTEM]');
  const userIdx = raw.indexOf('[USER]');
  if (sysIdx === -1 || userIdx === -1 || userIdx < sysIdx) {
    return [{ role: 'user', content: raw }];
  }
  return [
    { role: 'system', content: raw.slice(sysIdx + '[SYSTEM]'.length, userIdx).trim() },
    { role: 'user', content: raw.slice(userIdx + '[USER]'.length).trim() },
  ];
}

describe.skipIf(!ENABLED)('LlmGatewayService × AI SDK 真實契約（Story 23.4）', () => {
  let modelId: string;
  let messages: LlmMessage[];

  beforeAll(async () => {
    // 取一個 enabled 的 Azure 模型（Azure = §7 既定合規基準；不取非 Azure）
    const model = await prisma.llmModel.findFirst({
      where: {
        isEnabled: true,
        provider: { isEnabled: true, providerType: 'AZURE_OPENAI' },
      },
      select: { id: true, modelKey: true },
      orderBy: { modelKey: 'asc' },
    });
    if (!model) {
      throw new Error('DB 內找不到 enabled 的 Azure 模型 —— 請先跑 seed-llm-providers');
    }
    modelId = model.id;

    // 取一份真實 Stage 3 prompt（唯讀）
    const row = await prisma.extractionResult.findFirst({
      where: { status: 'COMPLETED', stage3AiDetails: { not: null } },
      select: { stage3AiDetails: true },
      orderBy: { createdAt: 'desc' },
    });
    const prompt = (row?.stage3AiDetails as { prompt?: string } | null)?.prompt;
    if (!prompt) {
      throw new Error('DB 內找不到含 prompt 的 stage3AiDetails —— 請先跑過一次提取');
    }
    messages = parseStoredPrompt(prompt);
  });

  it('should carry a real Stage 3 prompt (with system) through to Azure without an SDK-level rejection', async () => {
    // 前置條件斷言：這份 prompt 確實帶 system 段，否則測不到 FIX-135 那一類缺陷
    expect(messages.some((m) => m.role === 'system')).toBe(true);

    const result = await llmGatewayService.call({
      modelId,
      messages,
      images: [{ data: TINY_PNG, mediaType: 'image/png', detail: 'low' }],
      output: { mode: 'json' },
      maxOutputTokens: 512, // 契約測試不需要完整輸出，壓低成本
      abortTimeoutMs: 120_000,
    });

    // 失敗時把 gateway 的錯誤原文帶進斷言訊息，省去回頭翻 log
    expect(result.error ?? '').not.toMatch(/Invalid prompt/i);
    expect(result.success, `gateway 呼叫失敗: ${result.error ?? '(無錯誤訊息)'}`).toBe(true);
    expect(result.text.length).toBeGreaterThan(0);
    expect(result.providerType).toBe('AZURE_OPENAI');
    expect(result.usage.total).toBeGreaterThan(0);
  }, 180_000);

  it('should resolve a real DB model id into a complete call plan', async () => {
    // 不打 API：describeCall 走與 call() 同一條 prepare()，驗證解析 + 組裝快照
    const plan = await llmGatewayService.describeCall({
      modelId,
      messages,
      images: [{ data: TINY_PNG, mediaType: 'image/png', detail: 'low' }],
      output: { mode: 'json' },
    });

    expect(plan.providerType).toBe('AZURE_OPENAI');
    expect(plan.deploymentName.length).toBeGreaterThan(0);
    expect(plan.imageCount).toBe(1);

    // §3.8 快照須如實呈現 system 確實被送出（`summarizeAssembledMessages` 於
    // instructions 存在時前置一則 system 條目），且圖片帶著轉發的 imageDetail。
    // ⚠️ 這條**不是** FIX-135 的回歸線：快照刻意讓「system 在 messages」與
    //    「system 在 instructions」看起來相同，故無法由此區分。真正的回歸線是上一個
    //    測試（實際送出、AI SDK 不拒絕）＋ `llm-gateway.service.test.ts` 的 4 個
    //    instructions 傳遞斷言。
    expect(plan.assembledMessages.some((m) => m.role === 'system')).toBe(true);
    const imageParts = plan.assembledMessages.flatMap((m) =>
      m.parts.filter((p) => p.kind === 'image'),
    );
    expect(imageParts).toHaveLength(1);
    expect(imageParts[0]).toMatchObject({ mediaType: 'image/png', imageDetail: 'low' });
  });
});
