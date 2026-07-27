/**
 * @fileoverview per-環節模型指派單元測試（Epic 23 - Story 23.4）
 * @description
 *   全程 mock Prisma，驗證三件事：
 *   - **`resolveModelIdForStage` 的 Azure 閘門**（本 Story 最關鍵的新行為）：核心提取環節
 *     指派非 Azure 模型時回 `null`（＝呼叫端強制回退 Azure 預設），低風險環節則放行。
 *     這是 D6 + OQ-E 決議的執行點，錯了會讓未經準確率回歸的模型直接跑核心提取。
 *   - **停用狀態**：模型或其 provider 停用一律回 `null`，與環節分級無關。
 *   - **`getStageAssignments` 的 fallback 鏈**：assignment → 舊 SystemConfig key →
 *     環節 `defaultModelKey`，且全部環節都有值（未指派回空字串供 UI 顯示 placeholder）。
 *
 * @module tests/unit/services/stage-model-assignment.test
 * @since Epic 23 - Story 23.4
 * @lastModified 2026-07-27
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/prisma', () => ({
  prisma: {
    stageModelAssignment: { findUnique: vi.fn(), findMany: vi.fn(), upsert: vi.fn() },
    systemConfig: { findMany: vi.fn() },
    llmModel: { findMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock('@/services/logging/logger.service', () => ({
  aiLogger: { warn: vi.fn().mockResolvedValue(undefined) },
}));

import { prisma } from '@/lib/prisma';
import { LlmModelConfigService } from '@/services/llm-model-config.service';
import { LLM_STAGES, LLM_STAGE_KEYS } from '@/lib/constants/llm-stages';

// ============================================================================
// Fixtures
// ============================================================================

/** 建構 stageModelAssignment.findUnique 的回傳（僅含 resolver 讀取的欄位） */
function assignment(opts: {
  providerType?: string;
  modelEnabled?: boolean;
  providerEnabled?: boolean;
}) {
  return {
    llmModel: {
      id: 'model-1',
      isEnabled: opts.modelEnabled ?? true,
      provider: {
        isEnabled: opts.providerEnabled ?? true,
        providerType: opts.providerType ?? 'AZURE_OPENAI',
      },
    },
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('環節目錄（LLM_STAGES）', () => {
  it('should keep the CHANGE-099 stage keys unchanged so existing assignments still resolve', () => {
    expect(LLM_STAGE_KEYS.EXTRACTION_STAGE_1).toBe('extraction.model.stage1');
    expect(LLM_STAGE_KEYS.EXTRACTION_STAGE_2).toBe('extraction.model.stage2');
    expect(LLM_STAGE_KEYS.EXTRACTION_STAGE_3).toBe('extraction.model.stage3');
  });

  it('should classify every stage and cover all nine call sites', () => {
    expect(LLM_STAGES).toHaveLength(9);
    // 核心提取＝會產出發票欄位值的環節（D6 + OQ-E 分級）
    const core = LLM_STAGES.filter((s) => s.isCore).map((s) => s.key);
    expect(core).toEqual([
      'extraction.model.stage1',
      'extraction.model.stage2',
      'extraction.model.stage3',
      'vision.extraction',
      'extraction.v3.unified',
      'extraction.v2.mini',
    ]);
    const lowRisk = LLM_STAGES.filter((s) => !s.isCore).map((s) => s.key);
    expect(lowRisk).toEqual([
      'vision.classification',
      'term.classification',
      'term.validation',
    ]);
  });

  it('should give every stage a whitelisted default model key', () => {
    for (const stage of LLM_STAGES) {
      expect(['gpt-5.4-mini', 'gpt-5.4-nano']).toContain(stage.defaultModelKey);
    }
  });
});

describe('LlmModelConfigService.resolveModelIdForStage（Azure 閘門）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return the assigned model for a core stage on Azure', async () => {
    vi.mocked(prisma.stageModelAssignment.findUnique).mockResolvedValue(
      assignment({ providerType: 'AZURE_OPENAI' }) as never
    );

    await expect(
      LlmModelConfigService.resolveModelIdForStage(LLM_STAGE_KEYS.EXTRACTION_STAGE_3)
    ).resolves.toBe('model-1');
  });

  it('should refuse a non-Azure model on a core stage so the caller falls back to Azure', async () => {
    vi.mocked(prisma.stageModelAssignment.findUnique).mockResolvedValue(
      assignment({ providerType: 'ANTHROPIC' }) as never
    );

    // 核心提取環節：指派保留在 DB，但執行期不生效（須先通過準確率回歸 + 信心度校準）
    for (const stage of LLM_STAGES.filter((s) => s.isCore)) {
      await expect(
        LlmModelConfigService.resolveModelIdForStage(stage.key)
      ).resolves.toBeNull();
    }
  });

  it('should allow a non-Azure model on low-risk stages', async () => {
    vi.mocked(prisma.stageModelAssignment.findUnique).mockResolvedValue(
      assignment({ providerType: 'ANTHROPIC' }) as never
    );

    for (const stage of LLM_STAGES.filter((s) => !s.isCore)) {
      await expect(LlmModelConfigService.resolveModelIdForStage(stage.key)).resolves.toBe(
        'model-1'
      );
    }
  });

  it('should return null when the model or its provider is disabled', async () => {
    vi.mocked(prisma.stageModelAssignment.findUnique).mockResolvedValue(
      assignment({ modelEnabled: false }) as never
    );
    await expect(
      LlmModelConfigService.resolveModelIdForStage(LLM_STAGE_KEYS.TERM_CLASSIFICATION)
    ).resolves.toBeNull();

    vi.mocked(prisma.stageModelAssignment.findUnique).mockResolvedValue(
      assignment({ providerEnabled: false }) as never
    );
    await expect(
      LlmModelConfigService.resolveModelIdForStage(LLM_STAGE_KEYS.TERM_CLASSIFICATION)
    ).resolves.toBeNull();
  });

  it('should return null when the stage is unassigned or unknown', async () => {
    vi.mocked(prisma.stageModelAssignment.findUnique).mockResolvedValue(null as never);
    await expect(
      LlmModelConfigService.resolveModelIdForStage(LLM_STAGE_KEYS.VISION_CLASSIFICATION)
    ).resolves.toBeNull();

    // 未知環節不查庫，直接回 null
    vi.clearAllMocks();
    await expect(
      LlmModelConfigService.resolveModelIdForStage('not.a.stage')
    ).resolves.toBeNull();
    expect(prisma.stageModelAssignment.findUnique).not.toHaveBeenCalled();
  });
});

describe('LlmModelConfigService.getStageAssignments（fallback 鏈）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should prefer an existing assignment over any fallback', async () => {
    vi.mocked(prisma.stageModelAssignment.findMany).mockResolvedValue([
      { stageKey: LLM_STAGE_KEYS.TERM_CLASSIFICATION, llmModelId: 'assigned-1' },
    ] as never);
    vi.mocked(prisma.systemConfig.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.llmModel.findMany).mockResolvedValue([
      { id: 'mini-id', modelKey: 'gpt-5.4-mini' },
      { id: 'nano-id', modelKey: 'gpt-5.4-nano' },
    ] as never);

    const result = await LlmModelConfigService.getStageAssignments();

    expect(result[LLM_STAGE_KEYS.TERM_CLASSIFICATION]).toBe('assigned-1');
    // 未指派者回退到環節 defaultModelKey 對應的 Azure 模型 id
    expect(result[LLM_STAGE_KEYS.EXTRACTION_STAGE_2]).toBe('nano-id');
    expect(result[LLM_STAGE_KEYS.VISION_EXTRACTION]).toBe('mini-id');
    // 涵蓋全部環節，UI 不會缺列
    expect(Object.keys(result)).toHaveLength(LLM_STAGES.length);
  });

  it('should honour the legacy SystemConfig value when no assignment exists', async () => {
    vi.mocked(prisma.stageModelAssignment.findMany).mockResolvedValue([] as never);
    // CHANGE-099 遷移前的環境：stageKey 與舊 SystemConfig key 同字串
    vi.mocked(prisma.systemConfig.findMany).mockResolvedValue([
      { key: LLM_STAGE_KEYS.EXTRACTION_STAGE_3, value: 'gpt-5.4-nano' },
    ] as never);
    vi.mocked(prisma.llmModel.findMany).mockResolvedValue([
      { id: 'mini-id', modelKey: 'gpt-5.4-mini' },
      { id: 'nano-id', modelKey: 'gpt-5.4-nano' },
    ] as never);

    const result = await LlmModelConfigService.getStageAssignments();

    // stage3 預設是 mini，但舊設定指定 nano → 以舊設定為準（行為零變）
    expect(result[LLM_STAGE_KEYS.EXTRACTION_STAGE_3]).toBe('nano-id');
    expect(result[LLM_STAGE_KEYS.EXTRACTION_STAGE_1]).toBe('mini-id');
  });

  it('should ignore a legacy value that is no longer a whitelisted model', async () => {
    vi.mocked(prisma.stageModelAssignment.findMany).mockResolvedValue([] as never);
    // CHANGE-102 已移除的模型
    vi.mocked(prisma.systemConfig.findMany).mockResolvedValue([
      { key: LLM_STAGE_KEYS.EXTRACTION_STAGE_3, value: 'gpt-5.2' },
    ] as never);
    vi.mocked(prisma.llmModel.findMany).mockResolvedValue([
      { id: 'mini-id', modelKey: 'gpt-5.4-mini' },
    ] as never);

    const result = await LlmModelConfigService.getStageAssignments();

    expect(result[LLM_STAGE_KEYS.EXTRACTION_STAGE_3]).toBe('mini-id');
  });

  it('should fall back to an empty string when nothing resolves so the UI shows a placeholder', async () => {
    vi.mocked(prisma.stageModelAssignment.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.systemConfig.findMany).mockResolvedValue([] as never);
    // 未播種：預設 Azure provider 下找不到任何模型
    vi.mocked(prisma.llmModel.findMany).mockResolvedValue([] as never);

    const result = await LlmModelConfigService.getStageAssignments();

    for (const stage of LLM_STAGES) {
      expect(result[stage.key]).toBe('');
    }
  });
});

describe('LlmModelConfigService.setStageAssignments', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.$transaction).mockResolvedValue([] as never);
  });

  it('should reject the whole batch when any model is invalid or disabled', async () => {
    vi.mocked(prisma.llmModel.findMany).mockResolvedValue([{ id: 'ok-1' }] as never);

    await expect(
      LlmModelConfigService.setStageAssignments({
        [LLM_STAGE_KEYS.TERM_CLASSIFICATION]: 'ok-1',
        [LLM_STAGE_KEYS.TERM_VALIDATION]: 'disabled-1',
      })
    ).rejects.toThrow('disabled-1');

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('should ignore unknown stage keys instead of writing them', async () => {
    vi.mocked(prisma.llmModel.findMany).mockResolvedValue([{ id: 'ok-1' }] as never);

    await LlmModelConfigService.setStageAssignments({ 'not.a.stage': 'ok-1' });

    expect(prisma.llmModel.findMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('should upsert only the stages that were sent (partial update)', async () => {
    vi.mocked(prisma.llmModel.findMany).mockResolvedValue([{ id: 'ok-1' }] as never);

    await LlmModelConfigService.setStageAssignments(
      { [LLM_STAGE_KEYS.VISION_CLASSIFICATION]: 'ok-1' },
      'user-1'
    );

    expect(prisma.stageModelAssignment.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.stageModelAssignment.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { stageKey: LLM_STAGE_KEYS.VISION_CLASSIFICATION },
        update: { llmModelId: 'ok-1', updatedBy: 'user-1' },
      })
    );
  });
});
