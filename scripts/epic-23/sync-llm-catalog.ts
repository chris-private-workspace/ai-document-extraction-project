/**
 * @fileoverview CHANGE-115 — 將 LLM 模型白名單同步到資料庫目錄（三段式 gated）
 * @description
 *   後台「LLM 模型設定」頁的下拉**不讀** `AVAILABLE_LLM_MODELS` 常量，而是讀資料庫的
 *   `llm_models`（Epic 23 Story 23.2 起改為 id-based）。CHANGE-115 只改了常量，
 *   資料庫仍停留在 CHANGE-102 時期播種的 4 個舊模型，因此 gpt-5.6-luna 不會出現在下拉。
 *
 *   本腳本等同重跑 `seed-llm-providers.ts`，但依 CLAUDE.md §不可逆資料操作紀律改為
 *   inspect / dryrun / write 三段式，且 write 具備前置快照、單一交易、數量閘、樂觀鎖、冪等。
 *
 *   **涵蓋的寫入**（與原 seed 相同範圍）：
 *     1. 預設 Azure provider 的 baseUrl / apiVersion（對齊 `AZURE_OPENAI_ENDPOINT`）
 *     2. 白名單模型 → `LlmModel`（新增或更新 label / capability）
 *     3. extraction stage1-3 的 `StageModelAssignment`（依舊 SystemConfig → 白名單 fallback）
 *
 *     4. 停用白名單外的殘留模型（`isEnabled = false`；使用者 2026-08-02 授權）
 *
 *   第 4 項採**停用而非刪除**：後台下拉過濾的就是 `isEnabled`，停用即達成「不出現在選項」，
 *   但保留列以便回復，也不影響 `stage_model_assignments` 的外鍵。與第 3 項同交易執行，
 *   確保不會出現「舊模型已停用、指派卻還指著它」的中間狀態。
 *
 * @module scripts/epic-23/sync-llm-catalog
 * @since CHANGE-115 - 全面切換至 gpt-5.6-luna
 * @lastModified 2026-08-02
 *
 * @usage
 *   npx ts-node --project scripts/tsconfig.exec.json scripts/epic-23/sync-llm-catalog.ts inspect
 *   npx ts-node --project scripts/tsconfig.exec.json scripts/epic-23/sync-llm-catalog.ts dryrun
 *   npx ts-node --project scripts/tsconfig.exec.json scripts/epic-23/sync-llm-catalog.ts write
 *
 * @related
 *   - scripts/epic-23/seed-llm-providers.ts - 原始（無閘門）播種腳本
 *   - src/lib/constants/llm-models.ts - 白名單單一真實來源
 *   - src/services/llm-model-config.service.ts - 讀取端 fallback 鏈
 */

import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
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
const AZURE_API_VERSION = '2024-12-01-preview';

/** 沿用 CHANGE-099 的 system_configs key（＝ StageModelAssignment.stageKey） */
const STAGE_CONFIG_KEYS: Record<ExtractionStage, string> = {
  stage1: 'extraction.model.stage1',
  stage2: 'extraction.model.stage2',
  stage3: 'extraction.model.stage3',
};

type Mode = 'inspect' | 'dryrun' | 'write';

/** 單一待執行動作（dryrun 印出、write 逐項套用並驗數量） */
interface PlannedAction {
  kind:
    | 'provider.update'
    | 'model.create'
    | 'model.update'
    | 'model.disable'
    | 'assignment.upsert';
  target: string;
  before: unknown;
  after: unknown;
  /** 樂觀鎖比對值（該列讀取當下的 updatedAt）；create 無此值 */
  lockUpdatedAt?: Date;
}

// ============================================================
// 讀取現況
// ============================================================

async function readCurrentState() {
  const provider = await prisma.llmProvider.findUnique({
    where: { name: PROVIDER_NAME },
  });

  const models = provider
    ? await prisma.llmModel.findMany({
        where: { providerId: provider.id },
        orderBy: { modelKey: 'asc' },
      })
    : [];

  // 查**全部**環節（非只 stage1-3）：停用舊模型前需確認沒有任何環節仍指向它
  const assignments = await prisma.stageModelAssignment.findMany();

  const legacyConfigs = await prisma.systemConfig.findMany({
    where: { key: { in: Object.values(STAGE_CONFIG_KEYS) } },
    select: { key: true, value: true },
  });

  return { provider, models, assignments, legacyConfigs };
}

type CurrentState = Awaited<ReturnType<typeof readCurrentState>>;

// ============================================================
// 規劃動作
// ============================================================

/**
 * 順序無關的 JSON 正規化，供 capability 比對。
 *
 * @description
 *   PostgreSQL 的 `jsonb` **不保留鍵順序**（依鍵長度 + 字典序重排），因此直接
 *   `JSON.stringify` 比對會把「內容相同、順序不同」誤判為有異動 —— 每次重跑都
 *   多一次無謂寫入並推進 `updatedAt`，破壞冪等。此處遞迴排序鍵後再序列化。
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** 白名單模型應寫入的 capability（附 Azure 部署解析提示，與原 seed 一致） */
function buildCapability(m: (typeof AVAILABLE_LLM_MODELS)[number]) {
  return {
    ...m.capability,
    supportsVision: true,
    deploymentEnvVar: m.deploymentEnvVar,
    defaultDeploymentName: m.defaultDeploymentName,
  };
}

function planActions(state: CurrentState): PlannedAction[] {
  const actions: PlannedAction[] = [];
  const { provider, models, assignments, legacyConfigs } = state;

  if (!provider) {
    throw new Error(
      `找不到 provider「${PROVIDER_NAME}」。此腳本只同步既有 provider 的模型目錄，` +
        `建立 provider 請先跑 scripts/epic-23/seed-llm-providers.ts`,
    );
  }

  // --- 1. provider 的 baseUrl / apiVersion ---
  const desiredBaseUrl = process.env.AZURE_OPENAI_ENDPOINT ?? null;
  if (provider.baseUrl !== desiredBaseUrl || provider.apiVersion !== AZURE_API_VERSION) {
    actions.push({
      kind: 'provider.update',
      target: provider.name,
      before: { baseUrl: provider.baseUrl, apiVersion: provider.apiVersion },
      after: { baseUrl: desiredBaseUrl, apiVersion: AZURE_API_VERSION },
      lockUpdatedAt: provider.updatedAt,
    });
  }

  // --- 2. 白名單模型 → LlmModel ---
  const modelByKey = new Map(models.map((m) => [m.modelKey, m]));
  for (const wanted of AVAILABLE_LLM_MODELS) {
    const capability = buildCapability(wanted);
    const existing = modelByKey.get(wanted.key);

    if (!existing) {
      actions.push({
        kind: 'model.create',
        target: wanted.key,
        before: null,
        after: { modelKey: wanted.key, label: wanted.label, capability, isEnabled: true },
      });
      continue;
    }

    const labelChanged = existing.label !== wanted.label;
    const capabilityChanged =
      canonicalJson(existing.capability) !== canonicalJson(capability);
    const enabledChanged = existing.isEnabled !== true;

    if (labelChanged || capabilityChanged || enabledChanged) {
      actions.push({
        kind: 'model.update',
        target: wanted.key,
        before: {
          label: existing.label,
          capability: existing.capability,
          isEnabled: existing.isEnabled,
        },
        after: { label: wanted.label, capability, isEnabled: true },
        lockUpdatedAt: existing.updatedAt,
      });
    }
  }

  // --- 3. stage1-3 指派 ---
  const legacyByKey = new Map(legacyConfigs.map((r) => [r.key, r.value]));
  const assignmentByKey = new Map(assignments.map((a) => [a.stageKey, a]));
  const modelKeyById = new Map(models.map((m) => [m.id, m.modelKey]));

  for (const stage of Object.keys(STAGE_CONFIG_KEYS) as ExtractionStage[]) {
    const stageKey = STAGE_CONFIG_KEYS[stage];
    const raw = legacyByKey.get(stageKey);
    // 與 getStageAssignments / 原 seed 相同的 fallback：舊 config 有效才用，否則白名單預設
    const targetModelKey =
      typeof raw === 'string' && isValidLlmModel(raw) ? raw : DEFAULT_STAGE_MODELS[stage];

    const existing = assignmentByKey.get(stageKey);
    const currentModelKey = existing?.llmModelId
      ? (modelKeyById.get(existing.llmModelId) ?? '(未知模型 id)')
      : null;

    if (currentModelKey === targetModelKey) continue; // 冪等：已是目標狀態

    actions.push({
      kind: 'assignment.upsert',
      target: stageKey,
      before: { modelKey: currentModelKey, llmModelId: existing?.llmModelId ?? null },
      after: { modelKey: targetModelKey },
      lockUpdatedAt: existing?.updatedAt,
    });
  }

  // --- 4. 停用白名單外的殘留模型 ---
  //   放在指派之後：同一交易內先讓 stage1-3 指向白名單模型，再停用舊的，
  //   避免任何時點出現「指派指著已停用模型」的狀態。
  for (const m of models) {
    if (isValidLlmModel(m.modelKey) || !m.isEnabled) continue; // 冪等：已停用則跳過
    actions.push({
      kind: 'model.disable',
      target: m.modelKey,
      before: { isEnabled: true },
      after: { isEnabled: false },
      lockUpdatedAt: m.updatedAt,
    });
  }

  return actions;
}

// ============================================================
// 輸出
// ============================================================

function printState(state: CurrentState) {
  const { provider, models, assignments, legacyConfigs } = state;

  console.log('--- llm_providers（預設 Azure provider）---');
  if (!provider) {
    console.log('  (查無)');
  } else {
    console.log(`  name        : ${provider.name}`);
    console.log(`  id          : ${provider.id}`);
    console.log(`  providerType: ${provider.providerType}`);
    console.log(`  baseUrl     : ${provider.baseUrl ?? '(null)'}`);
    console.log(`  apiVersion  : ${provider.apiVersion ?? '(null)'}`);
    console.log(`  isEnabled   : ${provider.isEnabled} / isDefault: ${provider.isDefault}`);
    console.log(`  updatedAt   : ${provider.updatedAt.toISOString()}`);
  }

  console.log('');
  console.log(`--- llm_models（共 ${models.length} 筆；★ = 現行白名單）---`);
  for (const m of models) {
    const mark = isValidLlmModel(m.modelKey) ? '★' : ' ';
    console.log(
      `  ${mark} ${m.modelKey.padEnd(16)} isEnabled=${String(m.isEnabled).padEnd(5)} ` +
        `label="${m.label}" id=${m.id}`,
    );
  }
  const missing = AVAILABLE_LLM_MODELS.filter(
    (w) => !models.some((m) => m.modelKey === w.key),
  );
  for (const w of missing) {
    console.log(`  ✗ ${w.key.padEnd(16)} (白名單有、資料庫無 → 下拉不會出現)`);
  }

  console.log('');
  console.log('--- stage_model_assignments（extraction stage1-3）---');
  const modelKeyById = new Map(models.map((m) => [m.id, m.modelKey]));
  for (const stageKey of Object.values(STAGE_CONFIG_KEYS)) {
    const a = assignments.find((x) => x.stageKey === stageKey);
    const key = a?.llmModelId ? (modelKeyById.get(a.llmModelId) ?? '(未知 id)') : '(未指派)';
    const valid = isValidLlmModel(key) ? '有效' : '⚠ 不在白名單 → 執行期被拒，落 fallback';
    console.log(`  ${stageKey.padEnd(24)} -> ${key.padEnd(16)} [${valid}]`);
  }

  console.log('');
  console.log('--- system_configs（舊 CHANGE-099 key，fallback 鏈第 2 層）---');
  for (const stageKey of Object.values(STAGE_CONFIG_KEYS)) {
    const c = legacyConfigs.find((x) => x.key === stageKey);
    const v = typeof c?.value === 'string' ? c.value : JSON.stringify(c?.value ?? null);
    const valid = c && isValidLlmModel(String(c.value)) ? '有效' : '⚠ 不在白名單 → 被拒';
    console.log(`  ${stageKey.padEnd(24)} = ${String(v).padEnd(16)} [${valid}]`);
  }
}

function printPlan(actions: PlannedAction[], state: CurrentState) {
  if (actions.length === 0) {
    console.log('  (無待寫入動作 — 資料庫已是目標狀態)');
    return;
  }
  for (const [i, a] of actions.entries()) {
    console.log(`  [${i + 1}] ${a.kind} :: ${a.target}`);
    console.log(`      before: ${JSON.stringify(a.before)}`);
    console.log(`      after : ${JSON.stringify(a.after)}`);
    if (a.lockUpdatedAt) {
      console.log(`      樂觀鎖比對 updated_at = ${a.lockUpdatedAt.toISOString()}`);
    }
  }

  // 寫入後後台下拉會長什麼樣
  console.log('');
  console.log('--- write 之後後台下拉的選項（已啟用 provider 的已啟用模型）---');
  const afterKeys = new Set(state.models.filter((m) => m.isEnabled).map((m) => m.modelKey));
  for (const a of actions) {
    if (a.kind === 'model.create' || a.kind === 'model.update') afterKeys.add(a.target);
    if (a.kind === 'model.disable') afterKeys.delete(a.target);
  }
  if (afterKeys.size === 0) {
    console.log('  ⚠ 下拉將沒有任何可選模型 —— 這會讓後台無法指派，請中止並檢查');
  }
  for (const key of [...afterKeys].sort()) {
    const inWhitelist = isValidLlmModel(key);
    console.log(
      `  ${inWhitelist ? '★' : '⚠'} ${key.padEnd(16)}` +
        (inWhitelist
          ? ' (現行白名單，deployment 存在)'
          : ' (白名單外殘留 — 核心環節會被拒並落 fallback；gateway 開啟後低風險環節會 404)'),
    );
  }
}

// ============================================================
// 寫入
// ============================================================

/** 前置快照：寫入前把三張表的現值完整輸出，作為唯一還原依據 */
function writeSnapshot(state: CurrentState): string {
  const dir = path.resolve(__dirname, '../../.snapshots');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `llm-catalog-before-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(state, null, 2), 'utf8');
  return file;
}

async function applyActions(actions: PlannedAction[], providerId: string) {
  await prisma.$transaction(async (tx) => {
    for (const a of actions) {
      switch (a.kind) {
        case 'provider.update': {
          const after = a.after as { baseUrl: string | null; apiVersion: string };
          const r = await tx.llmProvider.updateMany({
            // 樂觀鎖：讀取當下的 updated_at 必須未變
            where: { id: providerId, updatedAt: a.lockUpdatedAt },
            data: { baseUrl: after.baseUrl, apiVersion: after.apiVersion },
          });
          assertCount(r.count, 1, a);
          break;
        }
        case 'model.create': {
          const after = a.after as {
            modelKey: string;
            label: string;
            capability: unknown;
            isEnabled: boolean;
          };
          await tx.llmModel.create({
            data: {
              providerId,
              modelKey: after.modelKey,
              label: after.label,
              capability: after.capability as never,
              isEnabled: true,
            },
          });
          break;
        }
        case 'model.update': {
          const after = a.after as { label: string; capability: unknown; isEnabled: boolean };
          const r = await tx.llmModel.updateMany({
            where: { providerId, modelKey: a.target, updatedAt: a.lockUpdatedAt },
            data: {
              label: after.label,
              capability: after.capability as never,
              isEnabled: true,
            },
          });
          assertCount(r.count, 1, a);
          break;
        }
        case 'model.disable': {
          const model = await tx.llmModel.findUnique({
            where: { providerId_modelKey: { providerId, modelKey: a.target } },
            select: { id: true },
          });
          if (!model) {
            throw new Error(`欲停用的模型不存在：${a.target} —— 交易中止`);
          }
          // 安全閘：交易內重查，確認沒有任何環節仍指向它（含 stage1-3 以外的 6 個環節）
          const stillReferenced = await tx.stageModelAssignment.findMany({
            where: { llmModelId: model.id },
            select: { stageKey: true },
          });
          if (stillReferenced.length > 0) {
            throw new Error(
              `模型 ${a.target} 仍被環節指派引用：` +
                `${stillReferenced.map((r) => r.stageKey).join(', ')} —— 交易中止`,
            );
          }
          const r = await tx.llmModel.updateMany({
            where: { id: model.id, updatedAt: a.lockUpdatedAt },
            data: { isEnabled: false },
          });
          assertCount(r.count, 1, a);
          break;
        }
        case 'assignment.upsert': {
          const after = a.after as { modelKey: string };
          const model = await tx.llmModel.findUnique({
            where: { providerId_modelKey: { providerId, modelKey: after.modelKey } },
            select: { id: true },
          });
          if (!model) {
            throw new Error(
              `指派目標模型不存在：${after.modelKey}（環節 ${a.target}）—— 交易中止`,
            );
          }
          if (a.lockUpdatedAt) {
            const r = await tx.stageModelAssignment.updateMany({
              where: { stageKey: a.target, updatedAt: a.lockUpdatedAt },
              data: { llmModelId: model.id },
            });
            assertCount(r.count, 1, a);
          } else {
            await tx.stageModelAssignment.create({
              data: { stageKey: a.target, llmModelId: model.id },
            });
          }
          break;
        }
      }
      console.log(`  ✓ ${a.kind} :: ${a.target}`);
    }
  });
}

/** 數量閘：每筆影響列數必須完全等於預期，否則中止整個交易 */
function assertCount(actual: number, expected: number, a: PlannedAction): void {
  if (actual !== expected) {
    throw new Error(
      `數量閘失敗：${a.kind} :: ${a.target} 影響 ${actual} 列（預期 ${expected}）。` +
        `可能是併發修改導致樂觀鎖不匹配 —— 交易回滾，請重跑 inspect 後再試。`,
    );
  }
}

// ============================================================
// Main
// ============================================================

async function main() {
  const mode = (process.argv[2] ?? '') as Mode;
  if (!['inspect', 'dryrun', 'write'].includes(mode)) {
    console.error('用法: sync-llm-catalog.ts <inspect|dryrun|write>');
    process.exit(2);
  }

  console.log(`=== CHANGE-115 LLM 目錄同步 — 模式: ${mode} ===`);
  console.log(`白名單模型數: ${AVAILABLE_LLM_MODELS.length}（${AVAILABLE_LLM_MODELS.map((m) => m.key).join(', ')}）`);
  console.log('');

  const state = await readCurrentState();

  console.log('=== 現況 ===');
  printState(state);
  console.log('');

  if (mode === 'inspect') {
    console.log('=== inspect 完成（未做任何寫入）===');
    return;
  }

  const actions = planActions(state);

  console.log('=== 待執行動作 ===');
  printPlan(actions, state);
  console.log('');

  if (mode === 'dryrun') {
    console.log(`=== dryrun 完成（未做任何寫入）— 共 ${actions.length} 個動作 ===`);
    return;
  }

  if (actions.length === 0) {
    console.log('=== write: 無動作可執行，結束 ===');
    return;
  }

  const snapshotFile = writeSnapshot(state);
  console.log(`=== 前置快照已寫入: ${snapshotFile} ===`);
  console.log('=== 開始單一交易寫入 ===');
  await applyActions(actions, state.provider!.id);
  console.log('=== 交易提交完成 ===');
  console.log('');

  console.log('=== 寫入後現況 ===');
  printState(await readCurrentState());
}

main()
  .catch((e) => {
    console.error('FAILED:', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
