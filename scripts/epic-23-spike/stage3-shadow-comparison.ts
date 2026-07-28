/**
 * @fileoverview Epic 23 - Story 23.1 step 4b — Stage 3 影子模式（shadow）新舊路徑離線比對 harness
 * @description
 *   在**不改動生產、不 flip flag** 的前提下，離線並行比對「舊路徑（手寫 REST fetch）」vs
 *   「新路徑（Vercel AI SDK，鏡射 `LlmGatewayService` 的 wire）」對同一批發票 Stage 3 的：
 *     - confidence 分佈（overall + 各欄位自評）— §6.1 換路徑靜默失準的 pre-flip 哨兵。
 *     - 與原始基準回應的欄位一致率（各路徑各自對基準）。
 *     - 新舊路徑**互相**的欄位一致率（直接 shadow delta）。
 *     - 硬編 90/70 路由模擬（各路徑 + delta）。
 *   目的：在灰度切換前確認「Azure→AI SDK 的 wire 差異不會顯著移動 confidence 分佈 / 路由率」
 *   （§3.8：wire 由 AI SDK 組、非零風險；請求組裝快照保證不了逐位元相同，故須實測）。
 *
 *   設計要點（沿用 stage3-model-comparison.ts 的 harness 哲學）：
 *     - 唯讀 DB + 只呼叫 Azure（預設合規基準），不寫 DB、不送任何非 Azure。
 *     - 直接重送每份文件當初存的完整 prompt（extraction_results.stage_3_ai_details），忠實重放。
 *     - 舊路徑 = 原始 REST（鏡射 gpt-caller.service.ts）；新路徑 = 動態 import 的 AI SDK
 *       （鏡射 llm-gateway.service.ts 的 createAzure/generateObject + image detail 轉發）。
 *
 *   🔴 **鏡射會漂移——本檔不適合用來驗證 gateway 的 SDK 契約**（2026-07-27 實證）：
 *     FIX-135 修好了真 gateway 的 system→instructions，但本檔的鏡射沒同步，導致本檔對
 *     **已修好的** gateway 報出 0/2 失敗、看似 gateway 有缺陷。該漂移已於同日修正，但
 *     只要「鏡射」這個設計還在，下一次 gateway 改動就會再次漂移。
 *     → **契約層驗證改用 `tests/integration/llm-gateway-wire-contract.test.ts`**
 *       （直接呼叫真正的 `llmGatewayService`，不複製任何組裝邏輯）。
 *     → 本檔保留的價值在**語意層**：新舊路徑對同一批真實發票的 confidence 分佈與欄位
 *       一致率比對，那需要真 blob，是整合測試不做的部分。
 *     - `ai` / `@ai-sdk/azure` 為 ESM-only → 在此 CommonJS ts-node 腳本用 dynamic `import()` 載入。
 *
 *   ⚠️ 輸出（含發票欄位值）只寫 scratchpad，不進 repo。
 *   ⚠️ 需真實 Azure 憑證 + DB（含 stage3AiDetails）+ blob；本腳本產出 code、實際跑須在有憑證環境。
 *
 * @module scripts/epic-23-spike/stage3-shadow-comparison
 * @since Epic 23 - Story 23.1 step 4b
 * @lastModified 2026-07-10
 *
 * @usage
 *   npx ts-node --project scripts/tsconfig.exec.json scripts/epic-23-spike/stage3-shadow-comparison.ts
 *   環境變數（皆有預設）：
 *     SHADOW_N     抽樣文件數（預設 12）
 *     SHADOW_RUNS  每份每路徑重跑次數（預設 3，測非確定性）
 *     SHADOW_OUT_DIR 輸出目錄（預設用 scratchpad）
 *     AZURE_OPENAI_ENDPOINT / AZURE_OPENAI_API_KEY / AZURE_OPENAI_DEPLOYMENT_NAME（Stage 3 模型）
 *     AZURE_STORAGE_CONNECTION_STRING / AZURE_STORAGE_CONTAINER / DATABASE_URL
 */

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { BlobServiceClient } from '@azure/storage-blob';
import * as fs from 'fs';
import * as path from 'path';
// 相對 import：pdf-converter.ts 自身零 @/ 依賴（僅動態 import pdf-to-img / sharp），可安全直接引用
import { PdfConverter } from '../../src/services/extraction-v3/utils/pdf-converter';

// ============================================================
// 配置
// ============================================================

const SAMPLE_N = Number(process.env.SHADOW_N ?? 12);
const RUNS_PER_DOC = Number(process.env.SHADOW_RUNS ?? 3);
const OUT_DIR =
  process.env.SHADOW_OUT_DIR ??
  path.resolve(
    'C:\\Users\\RCI~1.CHR\\AppData\\Local\\Temp\\claude\\C--Users-rci-ChrisLai-Documents-GitHub-ai-doc-epic23\\e2d24646-464a-4a24-92ee-90e25176a5ff\\scratchpad'
  );

const AZURE_ENDPOINT = (process.env.AZURE_OPENAI_ENDPOINT ?? '').replace(/\/$/, '');
const AZURE_API_KEY = process.env.AZURE_OPENAI_API_KEY ?? '';
const AZURE_DEPLOYMENT = process.env.AZURE_OPENAI_DEPLOYMENT_NAME ?? 'gpt-5-2-vision';
const AZURE_API_VERSION = '2024-12-01-preview'; // 對齊 gpt-caller.service.ts + llm-gateway.service.ts
const AZURE_MAX_TOKENS = 8192; // 對齊 llm-models.ts gpt-5.2
const AZURE_TEMPERATURE = 0.1; // gpt-5.2 supportsTemperature
const AZURE_MAX_RETRIES = 2; // 對齊 gateway DEFAULT_MAX_RETRIES
const AZURE_TIMEOUT_MS = 300_000;

const STORAGE_CONN = process.env.AZURE_STORAGE_CONNECTION_STRING ?? '';
const STORAGE_CONTAINER = process.env.AZURE_STORAGE_CONTAINER ?? 'documents';

// ============================================================
// DB
// ============================================================

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// ============================================================
// 類型
// ============================================================

type ImageDetail = 'auto' | 'low' | 'high';

/** OpenAI wire 形狀訊息（舊路徑 fetch 用） */
interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | Array<Record<string, unknown>>;
}

interface ModelCallResult {
  content: string; // 原始回應字串（期望為 JSON）
  usage: { input: number; output: number; total: number };
  durationMs: number;
  error?: string;
}

/** 路徑無關的請求輸入（各 caller 各自映射成自己 SDK 的訊息形狀，忠實反映生產兩條路徑） */
interface ReplayRequest {
  system: string;
  user: string;
  images: string[]; // data URI（PdfConverter 輸出）
  imageDetail: ImageDetail;
  jsonSchema?: Record<string, unknown>;
}

type PathCaller = (req: ReplayRequest) => Promise<ModelCallResult>;

interface SampleDoc {
  id: string;
  fileName: string;
  fileType: string;
  blobName: string;
  companyId: string | null;
  system: string;
  user: string;
  imageDetail: ImageDetail;
  refResponseRaw: string; // 原始 GPT 回應（比對基準）
}

// ============================================================
// 工具（沿用 stage3-model-comparison.ts 的證實過邏輯；本腳本自足、不 import 執行中的 spike 主腳本）
// ============================================================

/** 把 buildAiDetails 存的 `[SYSTEM]\n...\n\n[USER]\n...` 拆回 system / user */
function splitStoredPrompt(full: string): { system: string; user: string } {
  const m = full.match(/^\[SYSTEM\]\n([\s\S]*?)\n\n\[USER\]\n([\s\S]*)$/);
  if (m) return { system: m[1], user: m[2] };
  return { system: '', user: full };
}

/** fileType → MIME */
function toMime(fileType: string): string {
  const t = (fileType || '').toLowerCase();
  if (t.includes('pdf')) return 'application/pdf';
  if (t.includes('png')) return 'image/png';
  if (t.includes('jpeg') || t.includes('jpg')) return 'image/jpeg';
  if (t.includes('tiff')) return 'image/tiff';
  if (t.includes('webp')) return 'image/webp';
  return 'application/pdf';
}

function normImageDetail(v: unknown): ImageDetail {
  return v === 'low' || v === 'high' ? v : 'auto';
}

async function downloadBlobBuffer(blobName: string): Promise<Buffer> {
  const svc = BlobServiceClient.fromConnectionString(STORAGE_CONN);
  const container = svc.getContainerClient(STORAGE_CONTAINER);
  const blob = container.getBlockBlobClient(blobName);
  return blob.downloadToBuffer();
}

/** 由基準原始回應推導 json_schema（只鎖結構、不鎖值），強制兩路徑對齊同結構 */
function deriveSchema(node: unknown): Record<string, unknown> {
  if (Array.isArray(node)) {
    return { type: 'array', items: node.length ? deriveSchema(node[0]) : { type: 'object', properties: {} } };
  }
  if (node !== null && typeof node === 'object') {
    const rec = node as Record<string, unknown>;
    if ('value' in rec && 'confidence' in rec) {
      return {
        type: 'object',
        properties: { value: { type: ['string', 'number', 'null'] }, confidence: { type: 'number' } },
        required: ['value', 'confidence'],
      };
    }
    const properties: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rec)) properties[k] = deriveSchema(v);
    return { type: 'object', properties };
  }
  if (typeof node === 'number') return { type: 'number' };
  if (typeof node === 'boolean') return { type: 'boolean' };
  if (node === null) return { type: ['string', 'number', 'null'] };
  return { type: 'string' };
}

/** 通用欄位 walker：收集所有「同時具 value + confidence 的物件」→ path → {value, confidence} */
function walkFields(obj: unknown, prefix = ''): Map<string, { value: unknown; confidence: number }> {
  const out = new Map<string, { value: unknown; confidence: number }>();
  const recurse = (node: unknown, p: string) => {
    if (node === null || typeof node !== 'object') return;
    const rec = node as Record<string, unknown>;
    if ('value' in rec && 'confidence' in rec) {
      out.set(p || 'value', { value: rec.value, confidence: Number(rec.confidence) });
      return;
    }
    for (const [k, v] of Object.entries(rec)) {
      if (Array.isArray(v)) continue;
      recurse(v, p ? `${p}.${k}` : k);
    }
  };
  recurse(obj, prefix);
  return out;
}

function getOverallConfidence(obj: unknown): number | null {
  if (obj && typeof obj === 'object' && 'overallConfidence' in (obj as Record<string, unknown>)) {
    const v = Number((obj as Record<string, unknown>).overallConfidence);
    return Number.isFinite(v) ? v : null;
  }
  return null;
}

function normValue(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return String(Math.round(v * 100) / 100);
  const s = String(v).trim().toLowerCase().replace(/\s+/g, ' ');
  const num = Number(s.replace(/[,$]/g, ''));
  if (s !== '' && Number.isFinite(num)) return String(Math.round(num * 100) / 100);
  return s;
}

function safeParse(raw: string): unknown | null {
  try {
    return JSON.parse(raw);
  } catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {
        return null;
      }
    }
    return null;
  }
}

/** 兩組欄位的一致率（只比雙方都有的 path） */
function agreement(
  a: Map<string, { value: unknown }>,
  b: Map<string, { value: unknown }>,
): { matched: number; compared: number; rate: number | null } {
  let matched = 0;
  let compared = 0;
  for (const [p, av] of a.entries()) {
    const bv = b.get(p);
    if (!bv) continue;
    compared++;
    if (normValue(av.value) === normValue(bv.value)) matched++;
  }
  return { matched, compared, rate: compared > 0 ? matched / compared : null };
}

// ============================================================
// 兩條路徑的 caller
// ============================================================

/** 舊路徑：原始 REST fetch（鏡射 gpt-caller.service.ts 的請求形狀） */
function buildLegacyFetchCaller(): PathCaller {
  const url = `${AZURE_ENDPOINT}/openai/deployments/${AZURE_DEPLOYMENT}/chat/completions?api-version=${AZURE_API_VERSION}`;
  return async (req) => {
    const start = Date.now();
    try {
      const messages: OpenAiMessage[] = [
        { role: 'system', content: req.system },
        {
          role: 'user',
          content: [
            ...req.images.map((img) => ({ type: 'image_url', image_url: { url: img, detail: req.imageDetail } })),
            { type: 'text', text: req.user },
          ],
        },
      ];
      const responseFormat = req.jsonSchema
        ? { type: 'json_schema', json_schema: { name: 'extraction_result', schema: req.jsonSchema, strict: false } }
        : { type: 'json_object' };
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'api-key': AZURE_API_KEY, 'content-type': 'application/json' },
        body: JSON.stringify({
          messages,
          max_completion_tokens: AZURE_MAX_TOKENS,
          response_format: responseFormat,
          temperature: AZURE_TEMPERATURE,
        }),
        signal: AbortSignal.timeout(AZURE_TIMEOUT_MS),
      });
      const durationMs = Date.now() - start;
      if (!res.ok) {
        const body = await res.text();
        return { content: '', usage: { input: 0, output: 0, total: 0 }, durationMs, error: `HTTP ${res.status}: ${body.slice(0, 300)}` };
      }
      const json = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      };
      return {
        content: json.choices?.[0]?.message?.content ?? '',
        usage: {
          input: json.usage?.prompt_tokens ?? 0,
          output: json.usage?.completion_tokens ?? 0,
          total: json.usage?.total_tokens ?? 0,
        },
        durationMs,
      };
    } catch (e) {
      return { content: '', usage: { input: 0, output: 0, total: 0 }, durationMs: Date.now() - start, error: e instanceof Error ? e.message : String(e) };
    }
  };
}

/**
 * 新路徑：Vercel AI SDK（鏡射 llm-gateway.service.ts 的 buildAzureModel + dispatch + toFilePart）。
 * `ai` / `@ai-sdk/azure` 為 ESM-only → dynamic import。圖片 detail 經 `providerOptions.openai.imageDetail`
 * 轉發（與 gateway step 4b 一致），與舊路徑 `image_url.detail` 對等。
 */
async function buildGatewayAiSdkCaller(): Promise<PathCaller> {
  const { generateObject, generateText, jsonSchema } = await import('ai');
  const { createAzure } = await import('@ai-sdk/azure');

  const trimmed = AZURE_ENDPOINT.replace(/\/+$/, '');
  const baseURL = trimmed.endsWith('/openai') ? trimmed : `${trimmed}/openai`;
  const azure = createAzure({
    baseURL,
    apiKey: AZURE_API_KEY,
    apiVersion: AZURE_API_VERSION,
    useDeploymentBasedUrls: true,
  });
  const model = azure.chat(AZURE_DEPLOYMENT);

  return async (req) => {
    const start = Date.now();
    try {
      // 鏡射 gateway toAiMessages/toFilePart：圖片在前、文字在後，附加到 user 訊息。
      // ⚠️ system **不得**放進 messages —— `ai@7` 的 standardizePrompt 見到 role:'system'
      //    即丟 InvalidPromptError（FIX-135），須改走 instructions。
      const filePartOpts = { openai: { imageDetail: req.imageDetail } };
      const messages = [
        {
          role: 'user' as const,
          content: [
            ...req.images.map((data) => ({
              type: 'file' as const,
              mediaType: 'image/png',
              data,
              providerOptions: filePartOpts,
            })),
            { type: 'text' as const, text: req.user },
          ],
        },
      ];
      const settings = {
        model,
        instructions: req.system,
        messages,
        maxOutputTokens: AZURE_MAX_TOKENS,
        maxRetries: AZURE_MAX_RETRIES,
        temperature: AZURE_TEMPERATURE,
        abortSignal: AbortSignal.timeout(AZURE_TIMEOUT_MS),
      };

      // 鏡射 gateway dispatch：有 schema → generateObject；失敗 → generateText（G10 降級）
      let content = '';
      let usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } = {};
      try {
        const r = req.jsonSchema
          ? await generateObject({ ...settings, schema: jsonSchema(req.jsonSchema), schemaName: 'extraction_result' })
          : await generateObject({ ...settings, output: 'no-schema' });
        content = JSON.stringify(r.object) ?? '';
        usage = r.usage;
      } catch {
        const r = await generateText(settings);
        content = r.text;
        usage = r.usage;
      }

      return {
        content,
        usage: {
          input: usage.inputTokens ?? 0,
          output: usage.outputTokens ?? 0,
          total: usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
        },
        durationMs: Date.now() - start,
      };
    } catch (e) {
      return { content: '', usage: { input: 0, output: 0, total: 0 }, durationMs: Date.now() - start, error: e instanceof Error ? e.message : String(e) };
    }
  };
}

// ============================================================
// 抽樣（沿用 spike：v3.1 + COMPLETED + 有 stage3AiDetails + blobName，依公司分層）
// ============================================================

async function sampleDocs(n: number): Promise<SampleDoc[]> {
  const rows = await prisma.extractionResult.findMany({
    where: { status: 'COMPLETED', extractionVersion: 'v3.1' },
    select: {
      companyId: true,
      stage3AiDetails: true,
      document: { select: { id: true, fileName: true, fileType: true, blobName: true } },
    },
  });

  const candidates = rows.filter((r) => {
    const ai = r.stage3AiDetails as { prompt?: string; response?: string } | null;
    return !!r.document?.blobName && !!ai?.prompt && !!ai?.response;
  });

  const byCompany = new Map<string, typeof candidates>();
  for (const r of candidates) {
    const key = r.companyId ?? 'none';
    if (!byCompany.has(key)) byCompany.set(key, []);
    byCompany.get(key)!.push(r);
  }
  const picked: typeof candidates = [];
  let added = true;
  while (picked.length < n && added) {
    added = false;
    for (const list of byCompany.values()) {
      if (picked.length >= n) break;
      const next = list.shift();
      if (next) {
        picked.push(next);
        added = true;
      }
    }
  }

  const docs: SampleDoc[] = [];
  for (const r of picked) {
    const d = r.document!;
    const ai = r.stage3AiDetails as { prompt?: string; response?: string; imageDetailMode?: string } | null;
    if (!ai?.prompt || !ai?.response) continue;
    const { system, user } = splitStoredPrompt(ai.prompt);
    docs.push({
      id: d.id,
      fileName: d.fileName,
      fileType: d.fileType,
      blobName: d.blobName,
      companyId: r.companyId,
      system,
      user,
      imageDetail: normImageDetail(ai.imageDetailMode),
      refResponseRaw: ai.response,
    });
  }
  return docs;
}

// ============================================================
// 單份文件執行：兩路徑各 N 次 → 各自 vs 基準 + 兩路徑互比
// ============================================================

interface PathRun {
  ok: boolean;
  error?: string;
  overallConfidence: number | null;
  fieldConfidences: number[];
  agreementVsBaseline: number | null;
  fields: Map<string, { value: unknown; confidence: number }>;
  durationMs: number;
  tokens: number;
}

interface DocShadowResult {
  docId: string;
  fileName: string;
  companyId: string | null;
  pageCount: number;
  refFieldCount: number;
  legacy: PathRun[];
  gateway: PathRun[];
  crossPathAgreement: Array<number | null>; // 每 run：gateway 欄位 vs legacy 欄位一致率
}

function runPath(
  content: string,
  error: string | undefined,
  durationMs: number,
  tokens: number,
  refFields: Map<string, { value: unknown }>,
): PathRun {
  if (error || !content) {
    return { ok: false, error: error ?? 'empty content', overallConfidence: null, fieldConfidences: [], agreementVsBaseline: null, fields: new Map(), durationMs, tokens };
  }
  const parsed = safeParse(content);
  if (!parsed) {
    return { ok: false, error: 'unparseable JSON', overallConfidence: null, fieldConfidences: [], agreementVsBaseline: null, fields: new Map(), durationMs, tokens };
  }
  const fields = walkFields(parsed);
  const fieldConfidences = [...fields.values()].map((f) => f.confidence).filter((c) => Number.isFinite(c));
  return {
    ok: true,
    overallConfidence: getOverallConfidence(parsed),
    fieldConfidences,
    agreementVsBaseline: agreement(refFields, fields).rate,
    fields,
    durationMs,
    tokens,
  };
}

async function runDoc(
  doc: SampleDoc,
  legacy: PathCaller,
  gateway: PathCaller,
  runs: number,
): Promise<DocShadowResult> {
  const buf = await downloadBlobBuffer(doc.blobName);
  const conv = await PdfConverter.convertToBase64(buf, toMime(doc.fileType));
  const images = conv.success ? conv.images : [];

  const refParsed = safeParse(doc.refResponseRaw);
  const refFields = refParsed ? walkFields(refParsed) : new Map();
  const refSchema = refParsed ? deriveSchema(refParsed) : undefined;

  const req: ReplayRequest = {
    system: doc.system,
    user: doc.user,
    images,
    imageDetail: doc.imageDetail,
    jsonSchema: refSchema,
  };

  const result: DocShadowResult = {
    docId: doc.id,
    fileName: doc.fileName,
    companyId: doc.companyId,
    pageCount: conv.pageCount,
    refFieldCount: refFields.size,
    legacy: [],
    gateway: [],
    crossPathAgreement: [],
  };

  for (let i = 0; i < runs; i++) {
    const lc = await legacy(req);
    const gc = await gateway(req);
    const lr = runPath(lc.content, lc.error, lc.durationMs, lc.usage.total, refFields);
    const gr = runPath(gc.content, gc.error, gc.durationMs, gc.usage.total, refFields);
    result.legacy.push(lr);
    result.gateway.push(gr);
    result.crossPathAgreement.push(
      lr.ok && gr.ok ? agreement(lr.fields, gr.fields).rate : null,
    );
  }

  return result;
}

// ============================================================
// 統計彙整（各路徑分佈 + 路由模擬 + delta）
// ============================================================

function pct(arr: number[], p: number): number {
  if (arr.length === 0) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.floor((p / 100) * s.length));
  return s[idx];
}
function avg(arr: number[]): number {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : NaN;
}
function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

function distOf(arr: number[]) {
  return arr.length
    ? { n: arr.length, min: round1(Math.min(...arr)), avg: round1(avg(arr)), p50: round1(pct(arr, 50)), max: round1(Math.max(...arr)) }
    : { n: 0, min: NaN, avg: NaN, p50: NaN, max: NaN };
}

function routingSim(overall: number[]) {
  const r = { AUTO_APPROVE: 0, QUICK_REVIEW: 0, FULL_REVIEW: 0 };
  for (const c of overall) {
    if (c >= 90) r.AUTO_APPROVE++;
    else if (c >= 70) r.QUICK_REVIEW++;
    else r.FULL_REVIEW++;
  }
  return r;
}

function summarizePath(runsOf: (r: DocShadowResult) => PathRun[], results: DocShadowResult[]) {
  const overall: number[] = [];
  const fieldConf: number[] = [];
  const agreementBaseline: number[] = [];
  let okRuns = 0;
  let failRuns = 0;
  for (const r of results) {
    for (const run of runsOf(r)) {
      if (!run.ok) {
        failRuns++;
        continue;
      }
      okRuns++;
      if (run.overallConfidence !== null) overall.push(run.overallConfidence);
      fieldConf.push(...run.fieldConfidences);
      if (run.agreementVsBaseline !== null) agreementBaseline.push(run.agreementVsBaseline * 100);
    }
  }
  return {
    okRuns,
    failRuns,
    overallConfidence: distOf(overall),
    fieldConfidence: distOf(fieldConf),
    agreementWithBaselinePct: distOf(agreementBaseline),
    routingSimByOverallConfidence: routingSim(overall),
  };
}

function summarize(results: DocShadowResult[]) {
  const legacy = summarizePath((r) => r.legacy, results);
  const gateway = summarizePath((r) => r.gateway, results);
  const cross: number[] = [];
  for (const r of results) for (const a of r.crossPathAgreement) if (a !== null) cross.push(a * 100);

  // 關鍵 delta（gateway − legacy）：換路徑對 confidence / 路由率的移動量
  const delta = {
    overallConfidenceAvg: round1((gateway.overallConfidence.avg || 0) - (legacy.overallConfidence.avg || 0)),
    fieldConfidenceAvg: round1((gateway.fieldConfidence.avg || 0) - (legacy.fieldConfidence.avg || 0)),
    agreementWithBaselineAvg: round1((gateway.agreementWithBaselinePct.avg || 0) - (legacy.agreementWithBaselinePct.avg || 0)),
    routing: {
      AUTO_APPROVE: gateway.routingSimByOverallConfidence.AUTO_APPROVE - legacy.routingSimByOverallConfidence.AUTO_APPROVE,
      QUICK_REVIEW: gateway.routingSimByOverallConfidence.QUICK_REVIEW - legacy.routingSimByOverallConfidence.QUICK_REVIEW,
      FULL_REVIEW: gateway.routingSimByOverallConfidence.FULL_REVIEW - legacy.routingSimByOverallConfidence.FULL_REVIEW,
    },
  };

  return {
    docs: results.length,
    legacy,
    gateway,
    crossPathFieldAgreementPct: distOf(cross),
    deltaGatewayMinusLegacy: delta,
  };
}

// ============================================================
// Main
// ============================================================

async function main() {
  console.log(`[shadow] 開始 — 部署=${AZURE_DEPLOYMENT}, N=${SAMPLE_N}, runs/doc=${RUNS_PER_DOC}`);

  const missing = [
    ['AZURE_OPENAI_ENDPOINT', AZURE_ENDPOINT],
    ['AZURE_OPENAI_API_KEY', AZURE_API_KEY],
    ['AZURE_STORAGE_CONNECTION_STRING', STORAGE_CONN],
    ['DATABASE_URL', process.env.DATABASE_URL ?? ''],
  ].filter(([, v]) => !v);
  if (missing.length) {
    console.error(`[shadow] 缺少環境變數: ${missing.map(([k]) => k).join(', ')}`);
    process.exit(1);
  }

  const docs = await sampleDocs(SAMPLE_N);
  console.log(`[shadow] 取樣 ${docs.length} 份（跨 ${new Set(docs.map((d) => d.companyId)).size} 公司）`);
  if (docs.length === 0) {
    console.error('[shadow] 無可用樣本');
    await prisma.$disconnect();
    process.exit(1);
  }

  const legacy = buildLegacyFetchCaller();
  const gateway = await buildGatewayAiSdkCaller();

  const results: DocShadowResult[] = [];
  for (let i = 0; i < docs.length; i++) {
    const d = docs[i];
    process.stdout.write(`[shadow] (${i + 1}/${docs.length}) ${d.fileName} … `);
    try {
      const r = await runDoc(d, legacy, gateway, RUNS_PER_DOC);
      const lok = r.legacy.filter((x) => x.ok).length;
      const gok = r.gateway.filter((x) => x.ok).length;
      console.log(`legacy ok ${lok}/${RUNS_PER_DOC}, gateway ok ${gok}/${RUNS_PER_DOC}, pages=${r.pageCount}`);
      results.push(r);
    } catch (e) {
      const anyE = e as { statusCode?: number; message?: string; name?: string };
      const short = anyE.statusCode === 404 ? 'blob 缺失 (404)' : (anyE.message || anyE.name || String(e)).slice(0, 100);
      console.log(`SKIP: ${short}`);
    }
  }

  const summary = summarize(results);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  // 序列化時排除 fields（Map，且含發票值）→ 只留統計 + 每 run 摘要
  const serializable = results.map((r) => ({
    ...r,
    legacy: r.legacy.map(({ fields: _f, ...rest }) => rest),
    gateway: r.gateway.map(({ fields: _f, ...rest }) => rest),
  }));
  const outPath = path.join(OUT_DIR, `shadow-compare-${AZURE_DEPLOYMENT.replace(/[:]/g, '_')}-${stamp}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ config: { SAMPLE_N, RUNS_PER_DOC, AZURE_DEPLOYMENT }, summary, results: serializable }, null, 2), 'utf-8');

  console.log('\n===== 影子比對彙整（gateway vs legacy）=====');
  console.log(JSON.stringify(summary, null, 2));
  console.log(`\n[shadow] 原始結果寫入: ${outPath}`);
  console.log('[shadow] 判讀：deltaGatewayMinusLegacy 的 confidence/routing 應接近 0；顯著非零 = wire 不等價，切換前須查因（§3.8/§6.1）。');

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error('[shadow] 未捕捉錯誤:', e);
  await prisma.$disconnect();
  process.exit(1);
});
