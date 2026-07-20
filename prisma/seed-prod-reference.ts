/**
 * @fileoverview Production Reference Seed — 業務參考資料手動執行一次
 * @module prisma/seed-prod-reference
 * @since CHANGE-055 Phase 2 - 2026-04-27
 * @lastModified 2026-04-27
 *
 * 用途：首次上線時手動執行一次，建立業務初始參考資料：
 * - Companies 基本資料（Pilot ≤10 / Full ≤100）
 * - Tier 1 Universal Mapping Rules（Pilot 50-100 / Full 50-200）
 * - Default Prompt Configs（Stage 1/2/3）
 * - 初始 Exchange Rates 快照
 *
 * ⚠️ 關鍵警告：
 * - 此 seed **永不**自動執行，必須帶 --confirm flag 或 PRISMA_SEED_PROD_ALLOW=true
 * - 後續部署絕不重複執行（會覆寫 prod admin 修改的資料）
 * - **Tier 2 Forwarder-Specific Mappings 不在此 seed 範圍**（學習機制建立）
 * - Companies / Tier1 Mappings / Exchange Rates 從 `prisma/seed-data/reference/*.json` 讀取
 *   （手動整理的 prod-grade JSON）
 * - 🔴 **Prompt Configs 例外**（FIX-118，2026-07-20）：改讀 `prisma/seed-data/prompt-configs.ts`
 *   的 `PROMPT_CONFIG_SEEDS`（單一真相來源），不再有 reference JSON 副本。
 *   原副本自建立後從未同步，內容為另一套與現行管線不相容的設計；而 seedPromptConfigs()
 *   對既有 GLOBAL prompt 是直接覆寫，執行後會讓 Stage 1/2/3 全部失效。
 *
 * 執行：
 *   PRISMA_SEED_PROD_ALLOW=true npx ts-node prisma/seed-prod-reference.ts --confirm
 *
 * 驗證：見 docs/06-deployment/02-azure-deployment/uat-deployment/07-seed-reference.md
 *
 * Schema 對齊備註（與規格 spec 的差異）:
 * - Company: 無 region/cityCode 欄位（City 才有 regionId）；upsert key 用 `code`
 * - Company.status: 使用 CompanyStatus enum {ACTIVE, INACTIVE, PENDING, MERGED}；
 *   reference seed 限制接受 [ACTIVE, INACTIVE, PENDING]
 * - MappingRule: 無 sourceTerm/targetField/scope 欄位；
 *   實際結構為 fieldName + extractionPattern(JSON)
 *   「Tier 1 UNIVERSAL」= companyId === null && forwarderId === null
 *   Unique constraint: [forwarderId, fieldName]
 * - PromptConfig: 無 stage/promptText/modelName/temperature 欄位；
 *   實際結構為 promptType(enum) + scope + systemPrompt + userPromptTemplate
 *   PromptType enum 值：STAGE_1_COMPANY_IDENTIFICATION / STAGE_2_FORMAT_IDENTIFICATION / STAGE_3_FIELD_EXTRACTION
 *   Unique constraint: [promptType, scope, companyId, documentFormatId]
 * - ExchangeRate: 用 effectiveYear (Int) 而非 effectiveDate；
 *   Unique constraint: [fromCurrency, toCurrency, effectiveYear]
 */

import 'dotenv/config'
import { PrismaClient, CompanyType, CompanyStatus, CompanySource, RuleStatus, PromptType, PromptScope, MergeStrategy, ExchangeRateSource } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { Pool } from 'pg'
import * as fs from 'fs'
import * as path from 'path'
import { PROMPT_CONFIG_SEEDS } from './seed-data/prompt-configs'

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
})
const adapter = new PrismaPg(pool)
const prisma = new PrismaClient({ adapter })

const HAS_CONFIRM_FLAG = process.argv.includes('--confirm')
const HAS_ENV_ALLOW = process.env.PRISMA_SEED_PROD_ALLOW === 'true'
const DRY_RUN = process.argv.includes('--dry-run')

const REFERENCE_DIR = path.join(__dirname, 'seed-data', 'reference')
const COMPANIES_FILE = path.join(REFERENCE_DIR, 'companies.json')
const MAPPINGS_FILE = path.join(REFERENCE_DIR, 'tier1-mappings.json')
const RATES_FILE = path.join(REFERENCE_DIR, 'exchange-rates.json')

/**
 * FIX-118: Prompt 改讀單一真相來源 `seed-data/prompt-configs.ts`，不再有
 * `seed-data/reference/prompt-configs.json` 副本。
 *
 * 原因：該 JSON 自 2026-04-27 建立後從未與 seed 主來源同步，內容是另一套設計
 * （三階段皆英文、基於 OCR 文字、輸出形狀與 parseFormatResult 不相容）。
 * 而本檔的 seedPromptConfigs() 對既有 GLOBAL prompt 是**直接覆寫**，
 * 一旦執行會讓 Stage 1/2/3 全部失效（FIX-095 曾記錄此風險但未根治）。
 *
 * 只取 3 個 V3.1 STAGE 類型，與原 JSON 涵蓋範圍一致。
 * 刻意**不含** FIELD_EXTRACTION —— FIX-111 才剛停用該型的 active GLOBAL prompt
 * （與 STAGE_3 併存會造成提取 prompt 選擇非確定性），帶進來會重新引入該問題。
 */
const PROD_PROMPT_TYPES = [
  'STAGE_1_COMPANY_IDENTIFICATION',
  'STAGE_2_FORMAT_IDENTIFICATION',
  'STAGE_3_FIELD_EXTRACTION',
] as const

// ============================================================================
// JSON Type Definitions（對齊 reference JSON 結構，與 Prisma model 透過 mapper 轉換）
// ============================================================================

interface CompanyJson {
  code: string                 // 必填：作為 upsert unique key
  name: string
  displayName: string
  type?: keyof typeof CompanyType    // 預設 UNKNOWN
  status: 'ACTIVE' | 'INACTIVE' | 'PENDING'
  source?: keyof typeof CompanySource    // 預設 MANUAL
  contactEmail?: string
  description?: string
  nameVariants?: string[]
  identificationPatterns?: string[]
  priority?: number
  defaultConfidence?: number
}

interface Tier1MappingJson {
  fieldName: string
  fieldLabel: string
  extractionPattern: any            // JSON: e.g. { keywords: ['shipper'], regex: '...' }
  scope: 'UNIVERSAL'                // 必須為 UNIVERSAL（Tier 1）
  confidence: number                // ≥ 0.8
  category?: string
  description?: string
  priority?: number
  isRequired?: boolean
  validationPattern?: string
  defaultValue?: string
}

interface PromptConfigJson {
  promptType: 'STAGE_1_COMPANY_IDENTIFICATION' | 'STAGE_2_FORMAT_IDENTIFICATION' | 'STAGE_3_FIELD_EXTRACTION'
  name: string
  description?: string
  systemPrompt: string
  userPromptTemplate: string
  variables?: any[]
  // 規格中的「stage」對應 promptType；「modelName/temperature」目前 schema 不直接支援，
  // 若需要可放入 description 或未來擴展（此 seed 不寫入這兩個欄位）
}

interface ExchangeRateJson {
  fromCurrency: string              // ISO 4217 (3 chars)
  toCurrency: string                // ISO 4217 (3 chars)
  rate: number                      // > 0
  effectiveYear: number             // e.g. 2026
  description?: string
  source?: keyof typeof ExchangeRateSource
}

// ============================================================================
// Pre-flight Safety Checks
// ============================================================================

async function safetyChecks(): Promise<void> {
  console.log('🔒 Running safety checks...')

  // Check 1: --confirm flag OR env allow（DRY_RUN 例外允許）
  if (!HAS_CONFIRM_FLAG && !HAS_ENV_ALLOW && !DRY_RUN) {
    console.error('❌ Refusing to run without --confirm flag or PRISMA_SEED_PROD_ALLOW=true env var')
    console.error('   Reference seed is for first-time production setup ONLY.')
    console.error('   Re-running will overwrite prod data created via Admin UI.')
    console.error('')
    console.error('   To proceed: PRISMA_SEED_PROD_ALLOW=true npx ts-node prisma/seed-prod-reference.ts --confirm')
    process.exit(1)
  }

  // Check 2: 讀取 deployment-state lock flag（若存在）
  // 註：在 Container App 內無 deployment-state file，此 check 主要給 local/CI 用
  const stateFile = path.join(process.cwd(), 'deployment-state', 'uat.yaml')
  if (fs.existsSync(stateFile)) {
    const stateContent = fs.readFileSync(stateFile, 'utf-8')
    if (stateContent.includes('reference_seed_executed: true')) {
      console.error('❌ Lock detected: reference_seed_executed=true in deployment-state/uat.yaml')
      console.error('   Reference seed has already been executed. Re-running may overwrite prod data.')
      console.error('   See docs/06-deployment/02-azure-deployment/uat-deployment/07-seed-reference.md Action 7.2')
      process.exit(1)
    }
  }

  // Check 3: 確認 3 份 JSON 存在（FIX-118 起 prompt 不再來自 JSON）
  for (const file of [COMPANIES_FILE, MAPPINGS_FILE, RATES_FILE]) {
    if (!fs.existsSync(file)) {
      console.error(`❌ Missing reference data file: ${file}`)
      console.error('   Reference data must be manually curated prod-grade JSON.')
      console.error('   See docs/06-deployment/02-azure-deployment/uat-deployment/07-seed-reference.md Action 7.1')
      process.exit(1)
    }
  }

  console.log('  ✅ Safety checks passed')
}

// ============================================================================
// Schema 驗證（讀取 + 驗證 4 份 JSON）
// ============================================================================

function loadAndValidate<T>(filePath: string, validator: (data: any) => string | null): T[] {
  const content = fs.readFileSync(filePath, 'utf-8')
  let data: any
  try {
    data = JSON.parse(content)
  } catch (e) {
    throw new Error(`${filePath} is not valid JSON: ${(e as Error).message}`)
  }

  if (!Array.isArray(data)) {
    throw new Error(`${filePath} is not a JSON array`)
  }

  const error = validator(data)
  if (error) {
    throw new Error(`${filePath} validation failed: ${error}`)
  }

  return data as T[]
}

function validateCompanies(data: any[]): string | null {
  if (data.length < 5 || data.length > 100) {
    return `count ${data.length} out of [5, 100]`
  }
  const seenCodes = new Set<string>()
  for (let i = 0; i < data.length; i++) {
    const item = data[i]
    if (!item.code || !item.name || !item.displayName || !item.status) {
      return `item[${i}] (${item.name || 'unnamed'}): missing required fields (code/name/displayName/status)`
    }
    if (seenCodes.has(item.code)) {
      return `duplicate code: ${item.code}`
    }
    seenCodes.add(item.code)
    if (!['ACTIVE', 'INACTIVE', 'PENDING'].includes(item.status)) {
      return `item[${i}] (${item.name}): invalid status ${item.status} (allowed: ACTIVE/INACTIVE/PENDING)`
    }
    if (item.type && !Object.keys(CompanyType).includes(item.type)) {
      return `item[${i}] (${item.name}): invalid type ${item.type}`
    }
    if (item.defaultConfidence !== undefined && (item.defaultConfidence < 0 || item.defaultConfidence > 1)) {
      return `item[${i}] (${item.name}): defaultConfidence ${item.defaultConfidence} out of [0, 1]`
    }
  }
  return null
}

function validateMappings(data: any[]): string | null {
  if (data.length < 30 || data.length > 200) {
    return `count ${data.length} out of [30, 200]`
  }
  const seenFieldNames = new Set<string>()
  for (let i = 0; i < data.length; i++) {
    const item = data[i]
    if (!item.fieldName || !item.fieldLabel || item.extractionPattern === undefined || item.confidence === undefined || !item.scope) {
      return `item[${i}] (${item.fieldName || 'unnamed'}): missing required fields (fieldName/fieldLabel/extractionPattern/confidence/scope)`
    }
    if (item.scope !== 'UNIVERSAL') {
      return `item[${i}] (${item.fieldName}): Tier 2 detected (scope=${item.scope}); Tier 2 Forwarder-Specific is FORBIDDEN in seed`
    }
    if (typeof item.confidence !== 'number' || item.confidence < 0.8 || item.confidence > 1) {
      return `item[${i}] (${item.fieldName}): confidence ${item.confidence} below 0.8 threshold or out of [0.8, 1]`
    }
    // Tier 1 (UNIVERSAL) 在 schema 中是 forwarderId=null + companyId=null
    // 因此 unique [forwarderId, fieldName] 表示 fieldName 在 UNIVERSAL 範圍內必須唯一
    if (seenFieldNames.has(item.fieldName)) {
      return `duplicate fieldName in UNIVERSAL scope: ${item.fieldName}`
    }
    seenFieldNames.add(item.fieldName)
  }
  return null
}

/**
 * FIX-118: 從單一真相來源 `seed-data/prompt-configs.ts` 取得 prod 要種的 prompt。
 *
 * 取代原本讀 `seed-data/reference/prompt-configs.json` 的做法 —— 該副本從未與
 * 主來源同步，內容是另一套與現行管線不相容的設計。改讀主來源後兩者不可能再漂移。
 *
 * 仍套用 validatePromptConfigs 作為防呆：若日後有人從 PROMPT_CONFIG_SEEDS
 * 移除任一 V3.1 階段，這裡會直接擋下而非種出殘缺的 prod 環境。
 */
function loadPromptConfigsFromSeedSource(): PromptConfigJson[] {
  const selected = PROMPT_CONFIG_SEEDS.filter((s) =>
    (PROD_PROMPT_TYPES as readonly string[]).includes(s.promptType)
  ).map<PromptConfigJson>((s) => ({
    promptType: s.promptType as PromptConfigJson['promptType'],
    name: s.name,
    description: s.description,
    systemPrompt: s.systemPrompt,
    userPromptTemplate: s.userPromptTemplate,
    variables: s.variables as any[],
  }))

  const error = validatePromptConfigs(selected)
  if (error) {
    throw new Error(
      `PROMPT_CONFIG_SEEDS (seed-data/prompt-configs.ts) validation failed: ${error}`
    )
  }
  return selected
}

function validatePromptConfigs(data: any[]): string | null {
  if (data.length < 3 || data.length > 10) {
    return `count ${data.length} out of [3, 10]`
  }
  const requiredTypes = [
    'STAGE_1_COMPANY_IDENTIFICATION',
    'STAGE_2_FORMAT_IDENTIFICATION',
    'STAGE_3_FIELD_EXTRACTION',
  ]
  const seenTypes = new Set<string>()
  for (let i = 0; i < data.length; i++) {
    const item = data[i]
    if (!item.promptType || !item.name || !item.systemPrompt || !item.userPromptTemplate) {
      return `item[${i}]: missing required fields (promptType/name/systemPrompt/userPromptTemplate)`
    }
    if (!requiredTypes.includes(item.promptType) && !Object.keys(PromptType).includes(item.promptType)) {
      return `item[${i}]: invalid promptType ${item.promptType}`
    }
    seenTypes.add(item.promptType)
  }
  for (const required of requiredTypes) {
    if (!seenTypes.has(required)) {
      return `missing required prompt: ${required}`
    }
  }
  return null
}

function validateExchangeRates(data: any[]): string | null {
  if (data.length < 5 || data.length > 30) {
    return `count ${data.length} out of [5, 30]`
  }
  for (let i = 0; i < data.length; i++) {
    const item = data[i]
    if (!item.fromCurrency || !item.toCurrency || item.rate === undefined || item.effectiveYear === undefined) {
      return `item[${i}]: missing required fields (fromCurrency/toCurrency/rate/effectiveYear)`
    }
    if (item.fromCurrency.length !== 3 || item.toCurrency.length !== 3) {
      return `item[${i}] (${item.fromCurrency}->${item.toCurrency}): currency must be ISO 4217 3-char code`
    }
    if (typeof item.rate !== 'number' || item.rate <= 0) {
      return `item[${i}] (${item.fromCurrency}->${item.toCurrency}): invalid rate ${item.rate}`
    }
    if (!Number.isInteger(item.effectiveYear) || item.effectiveYear < 2000 || item.effectiveYear > 2100) {
      return `item[${i}]: invalid effectiveYear ${item.effectiveYear}`
    }
  }
  return null
}

// ============================================================================
// Seeders
// ============================================================================

/**
 * 取得或建立 system creator user — Company / MappingRule 需要 createdById/createdBy
 * 此函數會嘗試找一個 system 級別的 admin user；若不存在則 throw
 */
async function getSystemCreatorId(): Promise<string> {
  const systemUser = await prisma.user.findFirst({
    where: {
      OR: [
        { email: 'system@internal' },
        { email: { contains: 'admin' } },
      ],
    },
    orderBy: { createdAt: 'asc' },
  })
  if (!systemUser) {
    throw new Error(
      'No system/admin user found. Reference seed requires at least one user (e.g. from seed-prod-essential.ts) before running. ' +
      'Run essential seed first: npx ts-node prisma/seed-prod-essential.ts'
    )
  }
  return systemUser.id
}

async function seedCompanies(companies: CompanyJson[], creatorId: string): Promise<void> {
  console.log(`\n🏢 Seeding ${companies.length} companies...`)

  let upserted = 0
  for (const c of companies) {
    if (DRY_RUN) {
      console.log(`  [DRY-RUN] Would upsert: ${c.code} (${c.displayName})`)
      continue
    }

    await prisma.company.upsert({
      where: { code: c.code },
      update: {
        name: c.name,
        displayName: c.displayName,
        type: (c.type as CompanyType) || CompanyType.UNKNOWN,
        status: c.status as CompanyStatus,
        source: (c.source as CompanySource) || CompanySource.MANUAL,
        contactEmail: c.contactEmail || null,
        description: c.description || null,
        nameVariants: c.nameVariants || [],
        identificationPatterns: c.identificationPatterns || [],
        priority: c.priority ?? 0,
        defaultConfidence: c.defaultConfidence ?? 0.8,
      },
      create: {
        code: c.code,
        name: c.name,
        displayName: c.displayName,
        type: (c.type as CompanyType) || CompanyType.UNKNOWN,
        status: c.status as CompanyStatus,
        source: (c.source as CompanySource) || CompanySource.MANUAL,
        contactEmail: c.contactEmail || null,
        description: c.description || null,
        nameVariants: c.nameVariants || [],
        identificationPatterns: c.identificationPatterns || [],
        priority: c.priority ?? 0,
        defaultConfidence: c.defaultConfidence ?? 0.8,
        createdById: creatorId,
      },
    })
    upserted++
    if (upserted % 10 === 0) {
      console.log(`  ... ${upserted}/${companies.length}`)
    }
  }
  console.log(`  ✅ Upserted ${DRY_RUN ? 0 : upserted} / ${companies.length} companies`)
}

async function seedTier1Mappings(mappings: Tier1MappingJson[], creatorId: string): Promise<void> {
  console.log(`\n🔗 Seeding ${mappings.length} Tier 1 Universal mappings...`)
  console.log(`   Note: UNIVERSAL = companyId=null && forwarderId=null`)

  let upserted = 0
  for (const m of mappings) {
    if (DRY_RUN) {
      console.log(`  [DRY-RUN] Would upsert: ${m.fieldName}`)
      continue
    }

    // Schema 沒有對 (forwarderId=null, fieldName) 的有效 unique（NULL 不參與 unique），
    // 因此使用 findFirst + update/create 模式
    const existing = await prisma.mappingRule.findFirst({
      where: {
        forwarderId: null,
        companyId: null,
        fieldName: m.fieldName,
      },
    })

    if (existing) {
      await prisma.mappingRule.update({
        where: { id: existing.id },
        data: {
          fieldLabel: m.fieldLabel,
          extractionPattern: m.extractionPattern,
          confidence: m.confidence,
          category: m.category || null,
          description: m.description || null,
          priority: m.priority ?? 0,
          isRequired: m.isRequired ?? false,
          validationPattern: m.validationPattern || null,
          defaultValue: m.defaultValue || null,
          status: RuleStatus.ACTIVE,
          isActive: true,
        },
      })
    } else {
      await prisma.mappingRule.create({
        data: {
          fieldName: m.fieldName,
          fieldLabel: m.fieldLabel,
          extractionPattern: m.extractionPattern,
          confidence: m.confidence,
          category: m.category || null,
          description: m.description || null,
          priority: m.priority ?? 0,
          isRequired: m.isRequired ?? false,
          validationPattern: m.validationPattern || null,
          defaultValue: m.defaultValue || null,
          status: RuleStatus.ACTIVE,
          isActive: true,
          createdBy: creatorId,
          // companyId 與 forwarderId 留 null = UNIVERSAL (Tier 1)
        },
      })
    }
    upserted++
    if (upserted % 25 === 0) {
      console.log(`  ... ${upserted}/${mappings.length}`)
    }
  }
  console.log(`  ✅ Upserted ${DRY_RUN ? 0 : upserted} / ${mappings.length} Tier 1 mappings`)
}

async function seedPromptConfigs(prompts: PromptConfigJson[]): Promise<void> {
  console.log(`\n💬 Seeding ${prompts.length} prompt configs...`)

  let upserted = 0
  for (const p of prompts) {
    if (DRY_RUN) {
      console.log(`  [DRY-RUN] Would upsert: ${p.promptType} - ${p.name}`)
      continue
    }

    // Unique constraint: [promptType, scope, companyId, documentFormatId]
    // 在 GLOBAL scope 下，companyId 與 documentFormatId 為 null
    // 由於 NULL 不參與 unique，使用 findFirst + update/create 模式
    const existing = await prisma.promptConfig.findFirst({
      where: {
        promptType: p.promptType as PromptType,
        scope: PromptScope.GLOBAL,
        companyId: null,
        documentFormatId: null,
        isActive: true,
      },
    })

    if (existing) {
      await prisma.promptConfig.update({
        where: { id: existing.id },
        data: {
          name: p.name,
          description: p.description || null,
          systemPrompt: p.systemPrompt,
          userPromptTemplate: p.userPromptTemplate,
          variables: p.variables ?? [],
          mergeStrategy: MergeStrategy.OVERRIDE,
        },
      })
    } else {
      await prisma.promptConfig.create({
        data: {
          promptType: p.promptType as PromptType,
          scope: PromptScope.GLOBAL,
          name: p.name,
          description: p.description || null,
          systemPrompt: p.systemPrompt,
          userPromptTemplate: p.userPromptTemplate,
          variables: p.variables ?? [],
          mergeStrategy: MergeStrategy.OVERRIDE,
          isActive: true,
        },
      })
    }
    upserted++
  }
  console.log(`  ✅ Upserted ${DRY_RUN ? 0 : upserted} / ${prompts.length} prompt configs`)
}

async function seedExchangeRates(rates: ExchangeRateJson[]): Promise<void> {
  console.log(`\n💱 Seeding ${rates.length} exchange rates...`)

  let upserted = 0
  for (const r of rates) {
    if (DRY_RUN) {
      console.log(`  [DRY-RUN] Would upsert: ${r.fromCurrency}->${r.toCurrency} (${r.effectiveYear}) = ${r.rate}`)
      continue
    }

    await prisma.exchangeRate.upsert({
      where: {
        fromCurrency_toCurrency_effectiveYear: {
          fromCurrency: r.fromCurrency,
          toCurrency: r.toCurrency,
          effectiveYear: r.effectiveYear,
        },
      },
      update: {
        rate: r.rate,
        description: r.description || null,
        isActive: true,
      },
      create: {
        fromCurrency: r.fromCurrency,
        toCurrency: r.toCurrency,
        rate: r.rate,
        effectiveYear: r.effectiveYear,
        description: r.description || null,
        source: (r.source as ExchangeRateSource) || ExchangeRateSource.MANUAL,
        isActive: true,
      },
    })
    upserted++
  }
  console.log(`  ✅ Upserted ${DRY_RUN ? 0 : upserted} / ${rates.length} exchange rates`)
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  console.log('🌱 Starting reference seed for production...')
  console.log(`   Mode: ${DRY_RUN ? 'DRY-RUN' : 'EXECUTE'}`)
  console.log(`   Approval: --confirm=${HAS_CONFIRM_FLAG} env=${HAS_ENV_ALLOW}`)
  console.log('')

  const startTime = Date.now()

  await safetyChecks()

  // Load + validate
  console.log('\n📋 Loading reference data...')
  const companies = loadAndValidate<CompanyJson>(COMPANIES_FILE, validateCompanies)
  const mappings = loadAndValidate<Tier1MappingJson>(MAPPINGS_FILE, validateMappings)
  const prompts = loadPromptConfigsFromSeedSource()
  const rates = loadAndValidate<ExchangeRateJson>(RATES_FILE, validateExchangeRates)
  console.log(
    `  ✅ Loaded: ${companies.length} companies / ${mappings.length} mappings / ` +
    `${prompts.length} prompts / ${rates.length} rates`
  )

  // 取得 system creator user（用於 Company.createdById 與 MappingRule.createdBy）
  let creatorId: string = ''
  if (!DRY_RUN) {
    creatorId = await getSystemCreatorId()
    console.log(`  ✅ Using system creator: ${creatorId}`)
  }

  // Seed
  await seedCompanies(companies, creatorId)
  await seedTier1Mappings(mappings, creatorId)
  await seedPromptConfigs(prompts)
  await seedExchangeRates(rates)

  const duration = ((Date.now() - startTime) / 1000).toFixed(1)
  console.log('')
  console.log(`✨ Reference seed completed in ${duration}s`)
  console.log('')
  console.log('🔒 Reminder: Set deployment-state/uat.yaml flags.reference_seed_executed = true')
  console.log('   See docs/06-deployment/02-azure-deployment/uat-deployment/07-seed-reference.md')
}

main()
  .catch((e) => {
    console.error('❌ Reference seed failed:', e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
