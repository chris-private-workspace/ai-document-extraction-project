/**
 * @fileoverview 查證三個 Stage 實際生效的 LLM 模型（唯讀）
 * @description
 *   `getStageModel` 的 fallback 鏈為
 *   StageModelAssignment（Azure 白名單）→ 舊 SystemConfig key → DEFAULT_STAGE_MODELS。
 *   本腳本印出每一層的實際值 + 最終解析結果，避免只憑常數或文檔陳述機制。
 *
 * @module scripts/tmp-check-stage-models
 * @since 2026-08-06
 * @lastModified 2026-08-06
 *
 * @usage npx tsx scripts/tmp-check-stage-models.ts
 */
import * as dotenv from 'dotenv'

dotenv.config({ path: '.env.local' })
dotenv.config()

const line = (s = '') => console.log(s)
const hr = (t: string) => {
  line()
  line('='.repeat(100))
  line(t)
  line('='.repeat(100))
}

async function main() {
  const { default: prisma } = await import('../src/lib/prisma')
  const { LlmModelConfigService } = await import('../src/services/llm-model-config.service')
  const { DEFAULT_STAGE_MODELS } = await import('../src/lib/constants/llm-models')
  const { LLM_STAGE_KEYS, LLM_STAGES } = await import('../src/lib/constants/llm-stages')

  hr('1  最終解析結果（管線實際會用的）')
  for (const stage of ['stage1', 'stage2', 'stage3'] as const) {
    const key = await LlmModelConfigService.getStageModel(stage)
    line(`  ${stage}　→　${key}　（常數預設 ${DEFAULT_STAGE_MODELS[stage]}）`)
  }

  hr('2  Fallback 鏈第 1 層：StageModelAssignment')
  const assignments = await prisma.stageModelAssignment.findMany({
    select: {
      stageKey: true,
      llmModel: {
        select: {
          modelKey: true,
          label: true,
          isEnabled: true,
          provider: { select: { name: true, providerType: true, isEnabled: true } },
        },
      },
    },
    orderBy: { stageKey: 'asc' },
  })
  if (assignments.length === 0) line('  （無任何指派紀錄）')
  for (const a of assignments) {
    const m = a.llmModel
    line(
      `  ${a.stageKey.padEnd(28)} ${String(m?.modelKey).padEnd(18)} enabled=${m?.isEnabled}　provider=${m?.provider.name}/${m?.provider.providerType} enabled=${m?.provider.isEnabled}`
    )
  }

  hr('3  Fallback 鏈第 2 層：舊 SystemConfig key')
  const keys = [
    LLM_STAGE_KEYS.EXTRACTION_STAGE_1,
    LLM_STAGE_KEYS.EXTRACTION_STAGE_2,
    LLM_STAGE_KEYS.EXTRACTION_STAGE_3,
  ]
  const cfgs = await prisma.systemConfig.findMany({
    where: { key: { in: keys } },
    select: { key: true, value: true },
  })
  if (cfgs.length === 0) line('  （這三個 key 皆無 SystemConfig 紀錄）')
  cfgs.forEach((c) => line(`  ${c.key.padEnd(28)} ${c.value}`))

  hr('4  全部 9 個 LLM 環節的指派現況（Story 23.4）')
  line(`  ${'環節'.padEnd(28)} ${'預設模型'.padEnd(16)} core?`)
  for (const s of LLM_STAGES) {
    line(`  ${s.key.padEnd(28)} ${String(s.defaultModelKey).padEnd(16)} ${s.isCore ? 'core' : '-'}`)
  }

  hr('5  已註冊的 LLM 模型與 provider')
  const models = await prisma.llmModel.findMany({
    select: {
      modelKey: true,
      label: true,
      isEnabled: true,
      provider: { select: { name: true, providerType: true, isEnabled: true } },
    },
    orderBy: { modelKey: 'asc' },
  })
  if (models.length === 0) line('  （llm_models 表為空 → 走 fallback）')
  models.forEach((m) =>
    line(
      `  ${m.modelKey.padEnd(20)} ${String(m.label).slice(0, 26).padEnd(28)} enabled=${String(m.isEnabled).padEnd(5)} ${m.provider.name}/${m.provider.providerType}`
    )
  )

  await prisma.$disconnect()
}

main().catch((e) => {
  console.error('FATAL:', e)
  process.exit(1)
})
