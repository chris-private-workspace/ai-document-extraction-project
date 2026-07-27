/**
 * @fileoverview Epic 23 Phase 0 Spike — Stage 3 跨模型比對 harness
 * @description
 *   一次性先導驗證（spike）腳本，驗證「換 LLM provider 對核心提取（Stage 3）的影響」。
 *   兩個目標（對應三輪審視的兩顆炸彈）：
 *     - Q1 準確率：不同模型對同一份發票 Stage 3 的欄位一致性（相對現行 Azure 基準）。
 *     - Q2 信心度分佈：不同模型自評 confidence 分佈 → 判斷硬編 90/70 閾值是否需 per-model 重校。
 *
 *   設計要點（見 AI-HANDOFF / senior-review）：
 *     - 不 import 深層服務（避開 @/ 別名與龐大 transitive 依賴）。
 *     - 直接讀回每份文件當初送 GPT 的完整 prompt（extraction_results.stage_3_ai_details.prompt），
 *       原封重送 → 對「相同輸入、換模型」的忠實重放。
 *     - 比對基準 = 該文件原始 GPT 回應（stage_3_ai_details.response，原始 JSON）→ 原始層比對，不需生產解析器。
 *     - callModel 抽象成可替換：現在只接 Azure（基準），非 Azure 之後裝 AI SDK 再插入 buildCaller()。
 *
 *   ⚠️ 本腳本唯讀 DB + 呼叫 Azure（預設合規基準），不寫 DB、不送任何非 Azure。
 *   ⚠️ 輸出（含發票欄位值）只寫 scratchpad，不進 repo。
 *
 * @module scripts/epic-23-spike/stage3-model-comparison
 * @since Epic 23 - Phase 0 Spike
 * @lastModified 2026-07-09
 *
 * @usage
 *   npx ts-node --project scripts/tsconfig.exec.json scripts/epic-23-spike/stage3-model-comparison.ts
 *   環境變數（皆有預設）：
 *     SPIKE_N          抽樣文件數（預設 15）
 *     SPIKE_RUNS       每份每模型重跑次數（預設 3，測非確定性）
 *     SPIKE_OUT_DIR    輸出目錄（預設用 scratchpad）
 *     AZURE_OPENAI_ENDPOINT / AZURE_OPENAI_API_KEY / AZURE_OPENAI_DEPLOYMENT_NAME（Stage 3 gpt-5.2）
 *
 *   Story 23.3 起可切非 Azure 做對比（炸彈① 的非 Azure 對照組）：
 *     SPIKE_PROVIDER              azure（預設）| anthropic
 *     ANTHROPIC_API_KEY           SPIKE_PROVIDER=anthropic 時必填（放 .env，勿寫入指令列）
 *     SPIKE_ANTHROPIC_MODEL       預設 claude-opus-5
 *     SPIKE_ANTHROPIC_MAX_TOKENS  預設 32000（thinking 與回應共用上限）
 *   ⚠️ 切 anthropic 代表真實發票內容送出至 Anthropic — 屬資料出境，需組織 sign-off（D4/§7）。
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
// AI SDK（D5）：非 Azure provider 一律經 SDK，不手寫各家 wire 格式
import { generateObject, jsonSchema as aiJsonSchema } from 'ai';
import type { ModelMessage } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';

// ============================================================
// 配置
// ============================================================

const SAMPLE_N = Number(process.env.SPIKE_N ?? 15);
const RUNS_PER_DOC = Number(process.env.SPIKE_RUNS ?? 3);
const OUT_DIR =
  process.env.SPIKE_OUT_DIR ??
  path.resolve(
    'C:\\Users\\RCI~1.CHR\\AppData\\Local\\Temp\\claude\\C--Users-rci-ChrisLai-Documents-GitHub-ai-doc-epic23\\e2d24646-464a-4a24-92ee-90e25176a5ff\\scratchpad'
  );

const AZURE_ENDPOINT = (process.env.AZURE_OPENAI_ENDPOINT ?? '').replace(/\/$/, '');
const AZURE_API_KEY = process.env.AZURE_OPENAI_API_KEY ?? '';
const AZURE_DEPLOYMENT = process.env.AZURE_OPENAI_DEPLOYMENT_NAME ?? 'gpt-5-2-vision';
const AZURE_API_VERSION = '2024-12-01-preview'; // 對齊 gpt-caller.service.ts:155
const AZURE_MAX_TOKENS = 8192; // 對齊 llm-models.ts gpt-5.2
const AZURE_TEMPERATURE = 0.1; // gpt-5.2 supportsTemperature

/** 選用的 provider：`azure`（預設、合規基準）或 `anthropic`（Story 23.3，資料出境） */
const SPIKE_PROVIDER = (process.env.SPIKE_PROVIDER ?? 'azure').toLowerCase();
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? '';
const ANTHROPIC_MODEL = process.env.SPIKE_ANTHROPIC_MODEL ?? 'claude-opus-5';
/** 需大於 Azure 的 8192：Claude 的 thinking 與回應共用此上限，太小會思考完就截斷 */
const ANTHROPIC_MAX_TOKENS = Number(process.env.SPIKE_ANTHROPIC_MAX_TOKENS ?? 32000);

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

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | Array<Record<string, unknown>>;
}

interface ModelCallResult {
  content: string; // 原始回應字串（期望為 JSON）
  usage: { input: number; output: number; total: number };
  durationMs: number;
  error?: string;
  /** true = structured output 被 provider 拒絕，改走無 schema（比對時該回合無結構約束） */
  degraded?: boolean;
}

/** callModel 抽象：現在只接 Azure；非 Azure 之後在 buildCaller() 加分支 */
type ModelCaller = (messages: ChatMessage[], jsonSchema?: Record<string, unknown>) => Promise<ModelCallResult>;

interface SampleDoc {
  id: string;
  fileName: string;
  fileType: string;
  blobName: string;
  companyId: string | null;
  processingPath: string | null;
  system: string;
  user: string;
  imageDetailMode: string;
  refResponseRaw: string; // 原始 GPT 回應（比對基準）
}

// ============================================================
// 工具：拆回 [SYSTEM]/[USER]、載圖、Azure 呼叫、JSON walker、正規化
// ============================================================

/** 把 buildAiDetails 存的 `[SYSTEM]\n...\n\n[USER]\n...` 拆回 system / user */
function splitStoredPrompt(full: string): { system: string; user: string } {
  const m = full.match(/^\[SYSTEM\]\n([\s\S]*?)\n\n\[USER\]\n([\s\S]*)$/);
  if (m) return { system: m[1], user: m[2] };
  return { system: '', user: full };
}

/** fileType → MIME（PdfConverter 需要標準 MIME） */
function toMime(fileType: string): string {
  const t = (fileType || '').toLowerCase();
  if (t.includes('pdf')) return 'application/pdf';
  if (t.includes('png')) return 'image/png';
  if (t.includes('jpeg') || t.includes('jpg')) return 'image/jpeg';
  if (t.includes('tiff')) return 'image/tiff';
  if (t.includes('webp')) return 'image/webp';
  return 'application/pdf'; // 預設當 PDF 處理
}

/** 從 Azurite / Azure Blob 下載原檔為 Buffer */
async function downloadBlobBuffer(blobName: string): Promise<Buffer> {
  const svc = BlobServiceClient.fromConnectionString(STORAGE_CONN);
  const container = svc.getContainerClient(STORAGE_CONTAINER);
  const blob = container.getBlockBlobClient(blobName);
  return blob.downloadToBuffer();
}

/**
 * 從基準原始回應推導 json_schema（只鎖定結構，不鎖定值）。
 * 生產用 generateOutputSchema 由欄位定義建 schema；此處由「該文件的原始 gpt-5.2 標準回應」推導等價結構，
 * 強制重跑對齊同一 { fields:{value,confidence}, lineItems, overallConfidence } 形狀。
 */
function deriveSchema(node: unknown): Record<string, unknown> {
  if (Array.isArray(node)) {
    return { type: 'array', items: node.length ? deriveSchema(node[0]) : { type: 'object', properties: {} } };
  }
  if (node !== null && typeof node === 'object') {
    const rec = node as Record<string, unknown>;
    if ('value' in rec && 'confidence' in rec) {
      return {
        type: 'object',
        // value 用單一 string：Anthropic 的 grammar 對 union 型別有上限（16），
        // `['string','number','null']` 會讓整份 schema 爆掉。比對不受影響——
        // normValue() 會把數字字串正規化成數值、空字串與 null 同視為空。
        properties: { value: { type: 'string' }, confidence: { type: 'number' } },
        required: ['value', 'confidence'],
      };
    }
    const properties: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rec)) properties[k] = deriveSchema(v);
    // 全標 required：基準回應本來就含這些 key，且 Anthropic 的 grammar 編譯對
    // optional 參數有上限（24）——留白會直接被拒。兩個 provider 用同一組約束才可比。
    return { type: 'object', properties, required: Object.keys(properties) };
  }
  if (typeof node === 'number') return { type: 'number' };
  if (typeof node === 'boolean') return { type: 'boolean' };
  if (node === null) return { type: ['string', 'number', 'null'] };
  return { type: 'string' };
}

/** 建 Azure 基準 caller（原始 REST，鏡射 gpt-caller.service.ts 的請求形狀） */
function buildAzureCaller(): ModelCaller {
  const url = `${AZURE_ENDPOINT}/openai/deployments/${AZURE_DEPLOYMENT}/chat/completions?api-version=${AZURE_API_VERSION}`;
  return async (messages, jsonSchema) => {
    const start = Date.now();
    try {
      const responseFormat = jsonSchema
        ? { type: 'json_schema', json_schema: { name: 'extraction_result', schema: jsonSchema, strict: false } }
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
 * OpenAI 形狀訊息 → AI SDK 的 `instructions` + `ModelMessage[]`（Anthropic caller 用）。
 *
 * @description 兩個轉換重點：
 *   - 圖片以 data URL 傳入（`data:image/png;base64,...`），需拆成 AI SDK 的 `FilePart`
 *     （`ImagePart` 已 deprecated）。`image_url.detail` 不轉發：Anthropic 無對應旋鈕
 *     （該欄是 OpenAI 專屬），忠實作法是不捏造。
 *   - **system 必須抽離 `messages`**：AI SDK v7 的 `standardizePrompt` 見到 `role: 'system'`
 *     即丟 `InvalidPromptError`，要求改用 `instructions`。
 */
function toAiSdkPrompt(messages: ChatMessage[]): {
  instructions?: string;
  messages: ModelMessage[];
} {
  const instructionTexts: string[] = [];
  const conversation: ModelMessage[] = [];

  for (const m of messages) {
    if (m.role === 'system') {
      instructionTexts.push(
        typeof m.content === 'string'
          ? m.content
          : m.content.map((p) => String(p.text ?? '')).join('\n')
      );
      continue;
    }
    if (typeof m.content === 'string') {
      conversation.push({ role: m.role, content: m.content } as ModelMessage);
      continue;
    }
    const parts = m.content.map((part) => {
      if (part.type === 'image_url') {
        const url = String((part.image_url as { url?: string } | undefined)?.url ?? '');
        const match = url.match(/^data:([^;]+);base64,(.*)$/);
        if (match) {
          return { type: 'file' as const, mediaType: match[1], data: match[2] };
        }
        return { type: 'file' as const, mediaType: 'image/png', data: url };
      }
      return { type: 'text' as const, text: String(part.text ?? '') };
    });
    conversation.push({ role: m.role, content: parts } as ModelMessage);
  }

  return {
    ...(instructionTexts.length ? { instructions: instructionTexts.join('\n\n') } : {}),
    messages: conversation,
  };
}

/**
 * 建 Anthropic (Claude) caller（Story 23.3，經 Vercel AI SDK — 對齊 D5 與生產 gateway）。
 *
 * @description 與 Azure caller 的三個關鍵差異（誤用會直接 400 或量錯）：
 *   - **不送 `temperature`**：Claude Opus 4.7 以後移除 sampling 參數，送了回 400。
 *   - **thinking 預設開啟**且與回應共用 `max_tokens` → 需較大的 `maxOutputTokens`，
 *     否則會在思考後截斷（`stop_reason: max_tokens`），把截斷誤讀成「模型較差」。
 *   - **structured output 走 native tool-mode**（`@ai-sdk/anthropic` 自動處理），
 *     不可用 OpenAI-compat 端點（在 Anthropic 上 structured output 會失效）。
 */
function buildAnthropicCaller(): ModelCaller {
  const provider = createAnthropic({ apiKey: ANTHROPIC_API_KEY });
  const model = provider.languageModel(ANTHROPIC_MODEL);
  return async (messages, schema) => {
    const start = Date.now();
    const { instructions, messages: aiMessages } = toAiSdkPrompt(messages);
    const promptParts = {
      model,
      ...(instructions ? { instructions } : {}),
      messages: aiMessages,
      maxOutputTokens: ANTHROPIC_MAX_TOKENS,
    };
    const toResult = (
      r: { object: unknown; usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } },
      degraded: boolean
    ): ModelCallResult => ({
      content: JSON.stringify(r.object),
      usage: {
        input: r.usage.inputTokens ?? 0,
        output: r.usage.outputTokens ?? 0,
        total: r.usage.totalTokens ?? 0,
      },
      durationMs: Date.now() - start,
      ...(degraded ? { degraded: true } : {}),
    });
    const toError = (e: unknown): ModelCallResult => ({
      content: '',
      usage: { input: 0, output: 0, total: 0 },
      durationMs: Date.now() - start,
      error: e instanceof Error ? e.message : String(e),
    });

    try {
      const r = schema
        ? await generateObject({ ...promptParts, schema: aiJsonSchema(schema) })
        : await generateObject({ ...promptParts, output: 'no-schema' });
      return toResult(r, false);
    } catch (e) {
      // 鏡射生產 gateway 的 G10 降級：structured output 被拒 → 改走無 schema。
      // Anthropic 的 grammar 編譯對 schema 規模有硬上限，Stage 3 的 25-30 欄位形狀
      // （generateOutputSchema）會直接超標，故此降級是常態而非例外。
      if (!schema) return toError(e);
      try {
        return toResult(await generateObject({ ...promptParts, output: 'no-schema' }), true);
      } catch (fallbackError) {
        return toError(fallbackError);
      }
    }
  };
}

/**
 * 依 `SPIKE_PROVIDER` 選 caller。
 *
 * @remarks ⚠️ 選 `anthropic` 代表**真實發票會送出至 Anthropic**（資料出境）。
 *   預設維持 `azure`（合規基準），需明確指定才會切換。
 */
function buildCaller(): ModelCaller {
  if (SPIKE_PROVIDER === 'anthropic') {
    if (!ANTHROPIC_API_KEY) {
      throw new Error('SPIKE_PROVIDER=anthropic 需設定 ANTHROPIC_API_KEY');
    }
    return buildAnthropicCaller();
  }
  return buildAzureCaller();
}

/**
 * 通用欄位 walker：收集所有「同時具 value + confidence 的物件」→ path → {value, confidence}。
 * 統一涵蓋 standardFields.* / fields.* 等各種擺法，不依賴生產解析器。
 */
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
      if (Array.isArray(v)) continue; // lineItems 另計
      recurse(v, p ? `${p}.${k}` : k);
    }
  };
  recurse(obj, prefix);
  return out;
}

/** 取頂層 overallConfidence（若模型有給） */
function getOverallConfidence(obj: unknown): number | null {
  if (obj && typeof obj === 'object' && 'overallConfidence' in (obj as Record<string, unknown>)) {
    const v = Number((obj as Record<string, unknown>).overallConfidence);
    return Number.isFinite(v) ? v : null;
  }
  return null;
}

/** 正規化欄位值以比對一致性 */
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
    // 有時模型會夾 ```json fences
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

// ============================================================
// 抽樣
// ============================================================

async function sampleDocs(n: number): Promise<SampleDoc[]> {
  // 候選：v3.1 + COMPLETED + 有 stage3AiDetails + 有 blobName
  const rows = await prisma.extractionResult.findMany({
    where: {
      status: 'COMPLETED',
      extractionVersion: 'v3.1',
    },
    select: {
      companyId: true,
      stage3AiDetails: true,
      document: { select: { id: true, fileName: true, fileType: true, blobName: true, processingPath: true } },
    },
  });

  // JS 過濾：需有 blobName + stage3AiDetails（含可重送的 prompt/response）
  const candidates = rows.filter((r) => {
    const ai = r.stage3AiDetails as { prompt?: string; response?: string } | null;
    return !!r.document?.blobName && !!ai?.prompt && !!ai?.response;
  });

  // 依 companyId 分層平均取樣，盡量涵蓋多公司
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
      processingPath: d.processingPath,
      system,
      user,
      imageDetailMode: ai.imageDetailMode ?? 'auto',
      refResponseRaw: ai.response,
    });
  }
  return docs;
}

// ============================================================
// 單份文件執行（載圖 → N 次呼叫 → 解析 → 比對基準）
// ============================================================

interface DocRunResult {
  docId: string;
  fileName: string;
  companyId: string | null;
  processingPath: string | null;
  pageCount: number;
  refFieldCount: number;
  runs: Array<{
    ok: boolean;
    error?: string;
    /** structured output 被拒、改走無 schema（見 ModelCallResult.degraded） */
    degraded?: boolean;
    overallConfidence: number | null;
    fieldConfidences: number[]; // 各欄位自評 confidence
    agreementRate: number | null; // 與基準原始回應的欄位值一致率
    matched: number;
    compared: number;
    durationMs: number;
    tokens: number;
  }>;
}

async function runDoc(doc: SampleDoc, caller: ModelCaller, runs: number): Promise<DocRunResult> {
  // 載圖（一次，供所有 run 共用）
  const buf = await downloadBlobBuffer(doc.blobName);
  const conv = await PdfConverter.convertToBase64(buf, toMime(doc.fileType));
  const images = conv.success ? conv.images : [];

  // 基準欄位（來自原始回應）+ 由基準結構推導的 json_schema（強制重跑對齊同結構）
  const refParsed = safeParse(doc.refResponseRaw);
  const refFields = refParsed ? walkFields(refParsed) : new Map();
  const refSchema = refParsed ? deriveSchema(refParsed) : undefined;

  const userContent: Array<Record<string, unknown>> = [
    ...images.map((img) => ({ type: 'image_url', image_url: { url: img, detail: doc.imageDetailMode } })),
    { type: 'text', text: doc.user },
  ];
  const messages: ChatMessage[] = [
    { role: 'system', content: doc.system },
    { role: 'user', content: userContent },
  ];

  const result: DocRunResult = {
    docId: doc.id,
    fileName: doc.fileName,
    companyId: doc.companyId,
    processingPath: doc.processingPath,
    pageCount: conv.pageCount,
    refFieldCount: refFields.size,
    runs: [],
  };

  for (let i = 0; i < runs; i++) {
    const call = await caller(messages, refSchema);
    if (process.env.SPIKE_DUMP) {
      console.log(`\n---RAW [${doc.fileName}] run ${i}---\n${(call.content || call.error || '').slice(0, 1800)}\n---END RAW---`);
    }
    if (call.error || !call.content) {
      result.runs.push({ ok: false, error: call.error ?? 'empty content', overallConfidence: null, fieldConfidences: [], agreementRate: null, matched: 0, compared: 0, durationMs: call.durationMs, tokens: call.usage.total });
      continue;
    }
    const parsed = safeParse(call.content);
    if (!parsed) {
      result.runs.push({ ok: false, error: 'unparseable JSON', overallConfidence: null, fieldConfidences: [], agreementRate: null, matched: 0, compared: 0, durationMs: call.durationMs, tokens: call.usage.total });
      continue;
    }
    const fields = walkFields(parsed);
    const fieldConfidences = [...fields.values()].map((f) => f.confidence).filter((c) => Number.isFinite(c));

    // 與基準比對一致率（只比雙方都有的 path）
    let matched = 0;
    let compared = 0;
    for (const [p, ref] of refFields.entries()) {
      const cur = fields.get(p);
      if (!cur) continue;
      compared++;
      if (normValue(ref.value) === normValue(cur.value)) matched++;
    }

    result.runs.push({
      ok: true,
      ...(call.degraded ? { degraded: true } : {}),
      overallConfidence: getOverallConfidence(parsed),
      fieldConfidences,
      agreementRate: compared > 0 ? matched / compared : null,
      matched,
      compared,
      durationMs: call.durationMs,
      tokens: call.usage.total,
    });
  }

  return result;
}

// ============================================================
// 統計彙整
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

function summarize(results: DocRunResult[]) {
  const allOverall: number[] = [];
  const allFieldConf: number[] = [];
  const allAgreement: number[] = [];
  let okRuns = 0;
  let failRuns = 0;
  let degradedRuns = 0;

  for (const r of results) {
    for (const run of r.runs) {
      if (!run.ok) {
        failRuns++;
        continue;
      }
      okRuns++;
      if (run.degraded) degradedRuns++;
      if (run.overallConfidence !== null) allOverall.push(run.overallConfidence);
      allFieldConf.push(...run.fieldConfidences);
      if (run.agreementRate !== null) allAgreement.push(run.agreementRate * 100);
    }
  }

  // 路由率模擬（用 overallConfidence 套現行硬編 90/70）
  const routing = { AUTO_APPROVE: 0, QUICK_REVIEW: 0, FULL_REVIEW: 0 };
  for (const c of allOverall) {
    if (c >= 90) routing.AUTO_APPROVE++;
    else if (c >= 70) routing.QUICK_REVIEW++;
    else routing.FULL_REVIEW++;
  }

  return {
    docs: results.length,
    okRuns,
    failRuns,
    /** 成功回合中「structured output 被拒、改走無 schema」的數量 */
    degradedRuns,
    overallConfidence: { n: allOverall.length, min: round1(Math.min(...allOverall)), avg: round1(avg(allOverall)), p50: round1(pct(allOverall, 50)), max: round1(Math.max(...allOverall)) },
    fieldConfidence: { n: allFieldConf.length, min: round1(Math.min(...allFieldConf)), avg: round1(avg(allFieldConf)), p50: round1(pct(allFieldConf, 50)), max: round1(Math.max(...allFieldConf)) },
    agreementWithBaselinePct: { n: allAgreement.length, min: round1(Math.min(...allAgreement)), avg: round1(avg(allAgreement)), p50: round1(pct(allAgreement, 50)), max: round1(Math.max(...allAgreement)) },
    routingSimByOverallConfidence: routing,
  };
}

// ============================================================
// Main
// ============================================================

async function main() {
  // 標籤須反映實際 provider：否則 anthropic 的輸出會被標成 azure，日後無從分辨
  const modelLabel =
    SPIKE_PROVIDER === 'anthropic' ? `anthropic:${ANTHROPIC_MODEL}` : `azure:${AZURE_DEPLOYMENT}`;
  console.log(`[spike] 開始 — 模型=${modelLabel}, N=${SAMPLE_N}, runs/doc=${RUNS_PER_DOC}`);

  // 前置檢查
  const missing = [
    ['AZURE_OPENAI_ENDPOINT', AZURE_ENDPOINT],
    ['AZURE_OPENAI_API_KEY', AZURE_API_KEY],
    ['AZURE_STORAGE_CONNECTION_STRING', STORAGE_CONN],
    ['DATABASE_URL', process.env.DATABASE_URL ?? ''],
  ].filter(([, v]) => !v);
  if (missing.length) {
    console.error(`[spike] 缺少環境變數: ${missing.map(([k]) => k).join(', ')}`);
    process.exit(1);
  }

  const docs = await sampleDocs(SAMPLE_N);
  console.log(`[spike] 取樣 ${docs.length} 份（跨 ${new Set(docs.map((d) => d.companyId)).size} 公司）`);
  if (docs.length === 0) {
    console.error('[spike] 無可用樣本');
    await prisma.$disconnect();
    process.exit(1);
  }

  const caller = buildCaller();
  console.log(
    `[spike] provider=${SPIKE_PROVIDER}` +
      (SPIKE_PROVIDER === 'anthropic' ? ` model=${ANTHROPIC_MODEL}（⚠️ 發票內容將送出至 Anthropic）` : '')
  );
  const results: DocRunResult[] = [];
  for (let i = 0; i < docs.length; i++) {
    const d = docs[i];
    process.stdout.write(`[spike] (${i + 1}/${docs.length}) ${d.fileName} … `);
    try {
      const r = await runDoc(d, caller, RUNS_PER_DOC);
      const okc = r.runs.filter((x) => x.ok).length;
      console.log(`ok ${okc}/${RUNS_PER_DOC}, pages=${r.pageCount}, refFields=${r.refFieldCount}`);
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
  const rawPath = path.join(OUT_DIR, `spike-baseline-${modelLabel.replace(/[:]/g, '_')}-${stamp}.json`);
  fs.writeFileSync(rawPath, JSON.stringify({ model: modelLabel, config: { SAMPLE_N, RUNS_PER_DOC }, summary, results }, null, 2), 'utf-8');

  console.log('\n===== 彙整 =====');
  console.log(JSON.stringify(summary, null, 2));
  console.log(`\n[spike] 原始結果寫入: ${rawPath}`);

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error('[spike] 未捕捉錯誤:', e);
  await prisma.$disconnect();
  process.exit(1);
});
