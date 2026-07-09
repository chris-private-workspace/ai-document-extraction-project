/**
 * @fileoverview Epic 23 Story 23.1 — 播種預設 Azure LlmProvider + 模型 + 環節指派
 * @description
 *   將 CHANGE-099 白名單（AVAILABLE_LLM_MODELS）落地為新資料模型：
 *     - 一筆 isDefault Azure `LlmProvider`（憑證留 Story 23.2/3 加密後填入，此處 apiKeyEnc=null）
 *     - 各白名單模型一筆 `LlmModel`（capability + Azure 部署解析提示）
 *     - extraction Stage 1-3 各一筆 `StageModelAssignment`（沿用現行 SystemConfig 指派，缺失 fallback 預設）
 *   idempotent（upsert）；可重跑。**不消費既有管線**（管線仍讀 SystemConfig）→ 行為零變。
 *
 * @module scripts/epic-23/seed-llm-providers
 * @since Epic 23 - Story 23.1
 *
 * @usage
 *   $env:DOTENV_CONFIG_PATH='<主 repo>/.env'; \
 *   npx ts-node --project scripts/tsconfig.exec.json scripts/epic-23/seed-llm-providers.ts
 */

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
// 相對 import：llm-models.ts 完全自足（無 @/ 依賴）
import {
  AVAILABLE_LLM_MODELS,
  DEFAULT_STAGE_MODELS,
  isValidLlmModel,
  type ExtractionStage,
} from '../../src/lib/constants/llm-models';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const PROVIDER_NAME = 'Azure OpenAI (default)';

/** 沿用 CHANGE-099 的 system_configs key，供 step 4 遷移對齊 */
const STAGE_CONFIG_KEYS: Record<ExtractionStage, string> = {
  stage1: 'extraction.model.stage1',
  stage2: 'extraction.model.stage2',
  stage3: 'extraction.model.stage3',
};

async function main() {
  console.log('[seed-llm] 開始播種預設 Azure provider + 模型 + 環節指派');

  // 1. isDefault Azure provider（憑證此階段留空，Story 23.2/3 才加密填入）
  const provider = await prisma.llmProvider.upsert({
    where: { name: PROVIDER_NAME },
    update: {
      baseUrl: process.env.AZURE_OPENAI_ENDPOINT ?? null,
      apiVersion: '2024-12-01-preview',
      isEnabled: true,
      isDefault: true,
      allowSensitiveData: true, // Azure = §7 既定合規基準
    },
    create: {
      name: PROVIDER_NAME,
      providerType: 'AZURE_OPENAI',
      baseUrl: process.env.AZURE_OPENAI_ENDPOINT ?? null,
      apiVersion: '2024-12-01-preview',
      apiKeyEnc: null,
      isEncrypted: false, // 尚無加密憑證
      keyVersion: 1,
      isEnabled: true,
      isDefault: true,
      allowSensitiveData: true,
    },
  });
  console.log(`[seed-llm] provider: ${provider.name} (${provider.id})`);

  // 2. 白名單模型 → LlmModel（capability 附 Azure 部署解析提示，供 gateway step 3 用）
  const modelIdByKey = new Map<string, string>();
  for (const m of AVAILABLE_LLM_MODELS) {
    const capability = {
      ...m.capability,
      supportsVision: true, // 4 個 Azure 模型皆供 Stage 3 圖片提取用
      deploymentEnvVar: m.deploymentEnvVar,
      defaultDeploymentName: m.defaultDeploymentName,
    };
    const row = await prisma.llmModel.upsert({
      where: { providerId_modelKey: { providerId: provider.id, modelKey: m.key } },
      update: { label: m.label, capability, isEnabled: true },
      create: { providerId: provider.id, modelKey: m.key, label: m.label, capability, isEnabled: true },
    });
    modelIdByKey.set(m.key, row.id);
    console.log(`[seed-llm]   model: ${m.key} (${row.id})`);
  }

  // 3. 讀現行 SystemConfig 指派（缺失/無效 fallback 預設）→ StageModelAssignment
  const cfgRows = await prisma.systemConfig.findMany({
    where: { key: { in: Object.values(STAGE_CONFIG_KEYS) } },
    select: { key: true, value: true },
  });
  const cfgByKey = new Map(cfgRows.map((r) => [r.key, r.value]));

  const stages = Object.keys(STAGE_CONFIG_KEYS) as ExtractionStage[];
  for (const stage of stages) {
    const raw = cfgByKey.get(STAGE_CONFIG_KEYS[stage]);
    const modelKey =
      typeof raw === 'string' && isValidLlmModel(raw) ? raw : DEFAULT_STAGE_MODELS[stage];
    const llmModelId = modelIdByKey.get(modelKey) ?? null;
    const stageKey = STAGE_CONFIG_KEYS[stage];
    await prisma.stageModelAssignment.upsert({
      where: { stageKey },
      update: { llmModelId },
      create: { stageKey, llmModelId },
    });
    console.log(`[seed-llm]   assignment: ${stageKey} -> ${modelKey} (${llmModelId ?? 'null'})`);
  }

  // 4. 摘要
  const [pCount, mCount, aCount] = await Promise.all([
    prisma.llmProvider.count(),
    prisma.llmModel.count(),
    prisma.stageModelAssignment.count(),
  ]);
  console.log(`[seed-llm] 完成 — providers=${pCount}, models=${mCount}, assignments=${aCount}`);

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error('[seed-llm] 失敗:', e);
  await prisma.$disconnect();
  process.exit(1);
});
