/**
 * @fileoverview Prisma 資料庫種子數據腳本
 * @description
 *   創建系統預設角色、區域、城市、Company（含 Forwarder）、映射規則和初始數據。
 *   使用 upsert 確保可重複執行。
 *
 *   預定義角色：
 *   1. System Admin - 擁有所有權限
 *   2. Super User - 規則和 Company 管理
 *   3. Data Processor - 基礎發票處理（預設角色）
 *   4. City Manager - 城市級別管理
 *   5. Regional Manager - 多城市管理
 *   6. Auditor - 只讀審計存取
 *
 *   預定義區域 (Story 6.1):
 *   - APAC: Asia Pacific (UTC+8 default)
 *   - EMEA: Europe, Middle East, Africa (UTC+0 default)
 *   - AMER: Americas (UTC-5 default)
 *
 *   預定義城市：
 *   - APAC: Taipei, Hong Kong, Singapore, Tokyo, Shanghai, Sydney
 *   - EMEA: London, Frankfurt
 *   - AMER: New York, Los Angeles
 *
 *   預定義 Company（Forwarder 類型）：
 *   - Express: DHL, FedEx, UPS, TNT
 *   - Ocean: Maersk, MSC, CMA CGM, Hapag-Lloyd, Evergreen, COSCO, ONE, Yang Ming
 *   - Regional: SF Express, Kerry Logistics
 *   - Unknown: 用於無法識別的文件
 *
 *   映射規則：
 *   - Universal Rules (Tier 1): 通用映射規則
 *   - Company-Specific Rules (Tier 2): DHL, FedEx, UPS, Maersk 特定規則
 *
 * @module prisma/seed
 * @author Development Team
 * @since Epic 1 - Story 1.2 (User Database & Role Foundation)
 * @lastModified 2025-12-22
 * @refactor REFACTOR-001 (Forwarder → Company)
 *
 * @usage
 *   npx prisma db seed
 */

import 'dotenv/config'
import * as fs from 'fs'
import * as path from 'path'
import { randomBytes } from 'crypto'
import { Prisma, PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { Pool } from 'pg'
import {
  ROLE_NAMES,
  ROLE_PERMISSIONS,
  ROLE_DESCRIPTIONS,
} from '../src/types/role-permissions'
import { FORWARDER_SEED_DATA } from './seed-data/forwarders'
import { getAllMappingRules } from './seed-data/mapping-rules'
import { CONFIG_SEED_DATA } from './seed-data/config-seeds'
import { PROMPT_CONFIG_SEEDS } from './seed-data/prompt-configs'
import { FIELD_MAPPING_CONFIG_SEEDS } from './seed-data/field-mapping-configs'
import { ALERT_RULE_SEEDS } from './seed-data/alert-rules'
import { EXCHANGE_RATE_SEEDS } from './seed-data/exchange-rates'
import { hashPassword } from '../src/lib/password'

/**
 * 解析種子管理員密碼（FIX-070）
 *
 * @description
 *   不再於原始碼中硬編碼明文預設密碼。優先讀取環境變數 `SEED_ADMIN_PASSWORD`；
 *   若未設定，則產生一次性隨機強密碼（約 144 bits 熵），由呼叫端僅印出一次，
 *   供首次登入後立即修改。隨機密碼不寫入原始碼，亦不可重複取得。
 *
 * @returns 明文密碼與「是否為隨機產生」旗標（供呼叫端決定日誌輸出方式）
 */
function resolveSeedAdminPassword(): { password: string; generated: boolean } {
  const fromEnv = process.env.SEED_ADMIN_PASSWORD
  if (fromEnv && fromEnv.length > 0) {
    return { password: fromEnv, generated: false }
  }
  return { password: randomBytes(18).toString('base64url'), generated: true }
}

/**
 * 讀取導出的資料（如存在）
 * @description 用於從 prisma/seed/exported-data.json 恢復先前導出的資料
 */
function loadExportedData(): ExportedData | null {
  const exportedDataPath = path.join(__dirname, 'seed', 'exported-data.json')
  if (fs.existsSync(exportedDataPath)) {
    console.log('📂 Found exported-data.json, will restore additional data...\n')
    const rawData = fs.readFileSync(exportedDataPath, 'utf-8')
    return JSON.parse(rawData) as ExportedData
  }
  return null
}

interface ExportedData {
  exportedAt: string
  data: {
    regions: Array<{
      id: string
      code: string
      name: string
      parentId: string | null
      timezone: string
      status: string
    }>
    cities: Array<{
      id: string
      code: string
      name: string
      regionId: string
      timezone: string
      currency: string
      locale: string
      status: string
      config: unknown
    }>
    roles: Array<{
      id: string
      name: string
      description: string | null
      permissions: string[]
      isSystem: boolean
    }>
    companies: Array<{
      id: string
      name: string
      code: string | null
      displayName: string
      type: string
      status: string
      source: string
      nameVariants: string[] | null
      identificationPatterns: string[] | null
      priority: number
      defaultConfidence: number
      description: string | null
    }>
    documentFormats: Array<{
      id: string
      companyId: string
      documentType: string
      documentSubtype: string
      name: string | null
      features: unknown
      identificationRules: unknown
      commonTerms: string[] | null
      fileCount: number
    }>
    mappingRules: Array<{
      id: string
      forwarderId: string | null
      companyId: string | null
      fieldName: string
      fieldLabel: string
      extractionPattern: unknown
      priority: number
      isRequired: boolean
      isActive: boolean
      validationPattern: string | null
      defaultValue: string | null
      category: string | null
      description: string | null
      status: string
      version: number
      confidence: number
    }>
    dataTemplates: Array<{
      id: string
      name: string
      description: string | null
      scope: string
      companyId: string | null
      fields: unknown
      isActive: boolean
      isSystem: boolean
    }>
    systemConfigs: Array<{
      id: string
      key: string
      value: string
      description: string
      category: string
      valueType: string
      effectType: string
      name: string
      defaultValue: string | null
      impactNote: string | null
      validation: unknown
      isEncrypted: boolean
      isReadOnly: boolean
      sortOrder: number
      scope: string
      cityCode: string | null
      isActive: boolean
    }>
    promptConfigs: Array<{
      id: string
      promptType: string
      scope: string
      name: string
      description: string | null
      companyId: string | null
      documentFormatId: string | null
      systemPrompt: string
      userPromptTemplate: string
      mergeStrategy: string
      variables: unknown
      isActive: boolean
      version: number
    }>
  }
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
})
const adapter = new PrismaPg(pool)
const prisma = new PrismaClient({ adapter })

/**
 * 主要種子函數
 */
async function main() {
  console.log('========================================')
  console.log('Starting database seed...')
  console.log('========================================\n')

  // ===========================================
  // Seed System Roles
  // ===========================================
  console.log('📦 Creating system roles...\n')

  const roleData = Object.values(ROLE_NAMES).map((name) => ({
    name,
    description: ROLE_DESCRIPTIONS[name],
    permissions: [...ROLE_PERMISSIONS[name]],
    isSystem: true,
  }))

  let createdCount = 0
  let updatedCount = 0

  for (const role of roleData) {
    const existingRole = await prisma.role.findUnique({
      where: { name: role.name },
    })

    const result = await prisma.role.upsert({
      where: { name: role.name },
      update: {
        description: role.description,
        permissions: role.permissions,
      },
      create: {
        name: role.name,
        description: role.description,
        permissions: role.permissions,
        isSystem: role.isSystem,
      },
    })

    if (existingRole) {
      updatedCount++
      console.log(`  🔄 Updated: ${result.name} (${role.permissions.length} permissions)`)
    } else {
      createdCount++
      console.log(`  ✅ Created: ${result.name} (${role.permissions.length} permissions)`)
    }
  }

  // ===========================================
  // Seed Regions (Story 6.1, Story 20.1)
  // ===========================================
  console.log('\n🌍 Creating regions...\n')

  // Story 20.1: 新增 GLOBAL 地區和 isDefault/sortOrder 設定
  const regionData = [
    { code: 'GLOBAL', name: 'Global', timezone: 'UTC', description: '全球通用', isDefault: true, sortOrder: 0 },
    { code: 'APAC', name: 'Asia Pacific', timezone: 'Asia/Hong_Kong', description: '亞太地區', isDefault: true, sortOrder: 1 },
    { code: 'EMEA', name: 'Europe, Middle East & Africa', timezone: 'Europe/London', description: '歐洲、中東、非洲', isDefault: true, sortOrder: 2 },
    { code: 'AMER', name: 'Americas', timezone: 'America/New_York', description: '美洲', isDefault: true, sortOrder: 3 },
  ]

  const regionIdMap: Record<string, string> = {}
  let regionCreatedCount = 0
  let regionUpdatedCount = 0

  for (const region of regionData) {
    const existingRegion = await prisma.region.findUnique({
      where: { code: region.code },
    })

    const result = await prisma.region.upsert({
      where: { code: region.code },
      update: {
        name: region.name,
        timezone: region.timezone,
        description: region.description,
        isDefault: region.isDefault,
        sortOrder: region.sortOrder,
      },
      create: {
        code: region.code,
        name: region.name,
        timezone: region.timezone,
        description: region.description,
        isDefault: region.isDefault,
        sortOrder: region.sortOrder,
        status: 'ACTIVE',
      },
    })

    regionIdMap[region.code] = result.id

    if (existingRegion) {
      regionUpdatedCount++
      console.log(`  🔄 Updated: ${result.name} (${result.code})`)
    } else {
      regionCreatedCount++
      console.log(`  ✅ Created: ${result.name} (${result.code})`)
    }
  }

  // ===========================================
  // Seed Cities (Updated for Story 6.1)
  // ===========================================
  console.log('\n🏙️ Creating cities...\n')

  interface CityData {
    code: string
    name: string
    regionCode: string
    timezone: string
    currency: string
    locale: string
  }

  const cityData: CityData[] = [
    // APAC Cities
    { code: 'TPE', name: 'Taipei', regionCode: 'APAC', timezone: 'Asia/Taipei', currency: 'TWD', locale: 'zh-TW' },
    { code: 'HKG', name: 'Hong Kong', regionCode: 'APAC', timezone: 'Asia/Hong_Kong', currency: 'HKD', locale: 'zh-HK' },
    { code: 'SGP', name: 'Singapore', regionCode: 'APAC', timezone: 'Asia/Singapore', currency: 'SGD', locale: 'en-SG' },
    { code: 'TYO', name: 'Tokyo', regionCode: 'APAC', timezone: 'Asia/Tokyo', currency: 'JPY', locale: 'ja-JP' },
    { code: 'SHA', name: 'Shanghai', regionCode: 'APAC', timezone: 'Asia/Shanghai', currency: 'CNY', locale: 'zh-CN' },
    { code: 'SYD', name: 'Sydney', regionCode: 'APAC', timezone: 'Australia/Sydney', currency: 'AUD', locale: 'en-AU' },
    // EMEA Cities
    { code: 'LON', name: 'London', regionCode: 'EMEA', timezone: 'Europe/London', currency: 'GBP', locale: 'en-GB' },
    { code: 'FRA', name: 'Frankfurt', regionCode: 'EMEA', timezone: 'Europe/Berlin', currency: 'EUR', locale: 'de-DE' },
    // AMER Cities
    { code: 'NYC', name: 'New York', regionCode: 'AMER', timezone: 'America/New_York', currency: 'USD', locale: 'en-US' },
    { code: 'LAX', name: 'Los Angeles', regionCode: 'AMER', timezone: 'America/Los_Angeles', currency: 'USD', locale: 'en-US' },
  ]

  let cityCreatedCount = 0
  let cityUpdatedCount = 0

  for (const city of cityData) {
    const regionId = regionIdMap[city.regionCode]
    if (!regionId) {
      console.log(`  ⚠️ Skipped: ${city.name} - Region ${city.regionCode} not found`)
      continue
    }

    const existingCity = await prisma.city.findUnique({
      where: { code: city.code },
    })

    const result = await prisma.city.upsert({
      where: { code: city.code },
      update: {
        name: city.name,
        regionId: regionId,
        timezone: city.timezone,
        currency: city.currency,
        locale: city.locale,
      },
      create: {
        code: city.code,
        name: city.name,
        regionId: regionId,
        timezone: city.timezone,
        currency: city.currency,
        locale: city.locale,
        status: 'ACTIVE',
      },
    })

    if (existingCity) {
      cityUpdatedCount++
      console.log(`  🔄 Updated: ${result.name} (${result.code}) - ${city.regionCode}`)
    } else {
      cityCreatedCount++
      console.log(`  ✅ Created: ${result.name} (${result.code}) - ${city.regionCode}`)
    }
  }

  // ===========================================
  // Create System User for seeding
  // REFACTOR-001: Required as Company creator
  // FIX-054: 固定 ID 為 'system-user-1'（或由 SYSTEM_USER_ID env 覆蓋），
  //         讓運行時服務層（company-auto-create, batch-processor, issuer-identification 等）
  //         可安全地以常量引用系統用戶 ID，避免硬編碼 'dev-user-1' 帶來的 FK 風險。
  // ===========================================
  console.log('\n👤 Creating system user...\n')

  // Get the System Admin role
  const systemAdminRole = await prisma.role.findUnique({
    where: { name: 'System Admin' },
  })

  if (!systemAdminRole) {
    throw new Error('System Admin role not found. Roles must be seeded first.')
  }

  // FIX-054: 系統用戶使用固定 ID；允許既有環境以 env 覆蓋（指向現有 UUID 以免動 FK）
  const SYSTEM_USER_SEED_ID = process.env.SYSTEM_USER_ID ?? 'system-user-1'

  // Create or update system user（以 id 為查詢鍵，讓既有環境可透過 env 對齊現有 UUID）
  const systemUser = await prisma.user.upsert({
    where: { id: SYSTEM_USER_SEED_ID },
    update: {
      name: 'System',
      status: 'ACTIVE',
    },
    create: {
      id: SYSTEM_USER_SEED_ID,
      email: 'system@ai-document-extraction.internal',
      name: 'System',
      status: 'ACTIVE',
      // REFACTOR-001: 透過 UserRole 關聯建立角色（非直接 roleId）
      roles: {
        create: {
          roleId: systemAdminRole.id,
        },
      },
    },
  })

  console.log(`  ✅ System user ready: ${systemUser.email}`)

  // ===========================================
  // Create Development User (for dev mode auth)
  // ===========================================
  // FIX-070 (INFRA-02): dev-user-1 為無密碼的全域管理員，僅供開發環境的 dev-bypass 登入流程使用。
  // 生產環境不建立此帳號，避免弱認證面被誤帶入（其登入本身另由 CHANGE-077 的 NODE_ENV gate 阻擋）。
  if (process.env.NODE_ENV !== 'production') {
    console.log('\n👤 Creating development user...\n')

    const devUser = await prisma.user.upsert({
      where: { id: 'dev-user-1' },
      update: {
        name: 'Development User',
        status: 'ACTIVE',
        isGlobalAdmin: true,
      },
      create: {
        id: 'dev-user-1',
        email: 'dev@example.com',
        name: 'Development User',
        status: 'ACTIVE',
        isGlobalAdmin: true,
        isRegionalManager: false,
        roles: {
          create: {
            roleId: systemAdminRole.id,
          },
        },
      },
    })

    console.log(`  ✅ Development user ready: ${devUser.email} (${devUser.id})`)
  } else {
    console.log('\n👤 Skipping development user creation (NODE_ENV=production)\n')
  }

  // ===========================================
  // Create Production Admin User (CHANGE-039)
  // Credentials-based login for new deployments
  // ===========================================
  console.log('\n👤 Creating production admin user...\n')

  // FIX-070: 不再硬編碼明文密碼。優先讀 SEED_ADMIN_PASSWORD，否則隨機產生並僅印一次。
  const { password: adminPlainPassword, generated: adminPasswordGenerated } =
    resolveSeedAdminPassword()
  const adminPassword = await hashPassword(adminPlainPassword)
  const adminUser = await prisma.user.upsert({
    where: { email: 'admin@ai-document-extraction.com' },
    update: {
      status: 'ACTIVE',
    },
    create: {
      email: 'admin@ai-document-extraction.com',
      name: 'Admin',
      password: adminPassword,
      status: 'ACTIVE',
      isGlobalAdmin: true,
      emailVerified: new Date(),
      roles: {
        create: {
          roleId: systemAdminRole.id,
        },
      },
    },
  })

  console.log(`  ✅ Admin user ready: ${adminUser.email}`)
  console.warn('  ⚠️  WARNING: Change the admin password immediately after first login!')
  if (adminPasswordGenerated) {
    // 隨機一次性密碼：僅於本次 seed 輸出，且不寫入原始碼／不可重複取得
    console.warn(
      `  🔑 Generated one-time admin password (set SEED_ADMIN_PASSWORD to override): ${adminPlainPassword}`
    )
  } else {
    console.warn('  🔑 Admin password sourced from SEED_ADMIN_PASSWORD environment variable.')
  }

  // ===========================================
  // Seed Companies (Forwarder Type)
  // REFACTOR-001: Changed from Forwarder to Company model
  // ===========================================
  console.log('\n📦 Creating companies (forwarders)...\n')

  let companyCreatedCount = 0
  let companyUpdatedCount = 0

  for (const forwarder of FORWARDER_SEED_DATA) {
    const existingCompany = await prisma.company.findUnique({
      where: { code: forwarder.code },
    })

    // REFACTOR-001: Convert ForwarderIdentificationPatterns to string[] for Company model
    const patternsAsJson = [JSON.stringify(forwarder.identificationPatterns)]

    const result = await prisma.company.upsert({
      where: { code: forwarder.code },
      update: {
        name: forwarder.name,
        displayName: forwarder.displayName,
        identificationPatterns: patternsAsJson,
        priority: forwarder.priority,
      },
      create: {
        code: forwarder.code,
        name: forwarder.name,
        displayName: forwarder.displayName,
        type: 'FORWARDER', // REFACTOR-001: Specify company type
        identificationPatterns: patternsAsJson,
        priority: forwarder.priority,
        status: 'ACTIVE',
        creator: { connect: { id: systemUser.id } }, // REFACTOR-001: Required creator
      },
    })

    if (existingCompany) {
      companyUpdatedCount++
      console.log(`  🔄 Updated: ${result.displayName} (${result.code})`)
    } else {
      companyCreatedCount++
      console.log(`  ✅ Created: ${result.displayName} (${result.code})`)
    }
  }

  // ===========================================
  // Seed Mapping Rules
  // REFACTOR-001: Changed forwarderId to companyId
  // ===========================================
  console.log('\n📋 Creating mapping rules...\n')

  // 取得 Company ID 對照表
  const companies = await prisma.company.findMany({
    select: { id: true, code: true },
  })
  const companyIdMap = companies.reduce(
    (acc: Record<string, string>, c: { id: string; code: string | null }) => {
      if (c.code) {
        acc[c.code] = c.id
      }
      return acc
    },
    {} as Record<string, string>
  )

  // 取得所有映射規則（仍使用舊的 forwarderIdMap 參數名，因為 seed-data 尚未更新）
  const allMappingRules = getAllMappingRules(companyIdMap)

  let ruleCreatedCount = 0
  let ruleUpdatedCount = 0

  for (const rule of allMappingRules) {
    // 檢查是否已存在相同組合（使用 findFirst 處理 null companyId）
    // 注意：rule.forwarderId 實際上是 companyId（來自 seed-data）
    const existingRule = await prisma.mappingRule.findFirst({
      where: {
        companyId: rule.forwarderId, // seed-data 仍使用 forwarderId 名稱
        fieldName: rule.fieldName,
      },
    })

    // 由於同一欄位可能有多個規則（不同優先級），我們需要特殊處理
    if (existingRule) {
      // 如果已存在，更新它
      await prisma.mappingRule.update({
        where: { id: existingRule.id },
        data: {
          fieldLabel: rule.fieldLabel,
          extractionPattern: rule.extractionPattern as unknown as Prisma.InputJsonValue,
          priority: rule.priority,
          isRequired: rule.isRequired,
          validationPattern: rule.validationPattern || null,
          defaultValue: rule.defaultValue || null,
          category: rule.category,
          description: rule.description || null,
        },
      })
      ruleUpdatedCount++
      if (ruleUpdatedCount <= 5) {
        console.log(
          `  🔄 Updated: ${rule.fieldName} (${rule.forwarderId ? 'Company-specific' : 'Universal'})`
        )
      }
    } else {
      // 創建新規則
      await prisma.mappingRule.create({
        data: {
          companyId: rule.forwarderId, // seed-data 仍使用 forwarderId 名稱
          fieldName: rule.fieldName,
          fieldLabel: rule.fieldLabel,
          extractionPattern: rule.extractionPattern as unknown as Prisma.InputJsonValue,
          priority: rule.priority,
          isRequired: rule.isRequired,
          validationPattern: rule.validationPattern || null,
          defaultValue: rule.defaultValue || null,
          category: rule.category,
          description: rule.description || null,
          isActive: true,
        },
      })
      ruleCreatedCount++
      if (ruleCreatedCount <= 5) {
        console.log(
          `  ✅ Created: ${rule.fieldName} (${rule.forwarderId ? 'Company-specific' : 'Universal'})`
        )
      }
    }
  }

  if (ruleCreatedCount > 5) {
    console.log(`  ... and ${ruleCreatedCount - 5} more rules created`)
  }
  if (ruleUpdatedCount > 5) {
    console.log(`  ... and ${ruleUpdatedCount - 5} more rules updated`)
  }

  // ===========================================
  // Seed System Configs (Story 12-4)
  // ===========================================
  console.log('\n⚙️ Creating system configs...\n')

  let configCreatedCount = 0
  let configUpdatedCount = 0

  for (const config of CONFIG_SEED_DATA) {
    const existingConfig = await prisma.systemConfig.findUnique({
      where: { key: config.key },
    })

    if (existingConfig) {
      // 只更新元資料，不更新值
      await prisma.systemConfig.update({
        where: { key: config.key },
        data: {
          name: config.name,
          description: config.description,
          impactNote: config.impactNote || null,
          validation: config.validation
            ? (config.validation as Prisma.InputJsonValue)
            : Prisma.JsonNull,
          effectType: config.effectType,
          sortOrder: config.sortOrder,
        },
      })
      configUpdatedCount++
      if (configUpdatedCount <= 5) {
        console.log(`  🔄 Updated: ${config.name} (${config.key})`)
      }
    } else {
      await prisma.systemConfig.create({
        data: {
          key: config.key,
          value: config.defaultValue,
          defaultValue: config.defaultValue,
          category: config.category,
          valueType: config.valueType,
          effectType: config.effectType,
          name: config.name,
          description: config.description,
          impactNote: config.impactNote || null,
          validation: config.validation
            ? (config.validation as Prisma.InputJsonValue)
            : Prisma.JsonNull,
          isEncrypted: config.isEncrypted ?? false,
          isReadOnly: config.isReadOnly ?? false,
          sortOrder: config.sortOrder,
        },
      })
      configCreatedCount++
      if (configCreatedCount <= 5) {
        console.log(`  ✅ Created: ${config.name} (${config.key})`)
      }
    }
  }

  if (configCreatedCount > 5) {
    console.log(`  ... and ${configCreatedCount - 5} more configs created`)
  }
  if (configUpdatedCount > 5) {
    console.log(`  ... and ${configUpdatedCount - 5} more configs updated`)
  }

  // ===========================================
  // Seed Data Templates (Story 16-7)
  // ===========================================
  console.log('\n📋 Creating data templates...\n')

  interface DataTemplateField {
    name: string
    label: string
    dataType: 'string' | 'number' | 'date' | 'currency' | 'boolean' | 'array'
    isRequired: boolean
    order: number
    description?: string
  }

  interface DataTemplateSeed {
    id: string
    name: string
    description: string
    scope: 'GLOBAL' | 'COMPANY'
    isSystem: boolean
    fields: DataTemplateField[]
  }

  const dataTemplateSeedData: DataTemplateSeed[] = [
    {
      id: 'erp-standard-import',
      name: 'ERP 標準匯入格式',
      description: '適用於大多數 ERP 系統的標準發票匯入格式',
      scope: 'GLOBAL',
      isSystem: true,
      fields: [
        { name: 'invoice_number', label: '發票號碼', dataType: 'string', isRequired: true, order: 1 },
        { name: 'invoice_date', label: '發票日期', dataType: 'date', isRequired: true, order: 2 },
        { name: 'vendor_code', label: '供應商代碼', dataType: 'string', isRequired: true, order: 3 },
        { name: 'vendor_name', label: '供應商名稱', dataType: 'string', isRequired: false, order: 4 },
        { name: 'currency', label: '幣別', dataType: 'string', isRequired: true, order: 5 },
        { name: 'subtotal', label: '小計', dataType: 'currency', isRequired: false, order: 6 },
        { name: 'tax_amount', label: '稅額', dataType: 'currency', isRequired: false, order: 7 },
        { name: 'total_amount', label: '總金額', dataType: 'currency', isRequired: true, order: 8 },
        { name: 'due_date', label: '付款到期日', dataType: 'date', isRequired: false, order: 9 },
        { name: 'po_number', label: '採購單號', dataType: 'string', isRequired: false, order: 10 },
        { name: 'tracking_number', label: '追蹤號碼', dataType: 'string', isRequired: false, order: 11 },
        { name: 'description', label: '說明', dataType: 'string', isRequired: false, order: 12 },
      ],
    },
    {
      id: 'expense-report-format',
      name: '費用報表格式',
      description: '用於管理報表匯出的精簡格式',
      scope: 'GLOBAL',
      isSystem: true,
      fields: [
        { name: 'invoice_number', label: '發票號碼', dataType: 'string', isRequired: true, order: 1 },
        { name: 'invoice_date', label: '發票日期', dataType: 'date', isRequired: true, order: 2 },
        { name: 'vendor_name', label: '供應商', dataType: 'string', isRequired: true, order: 3 },
        { name: 'category', label: '費用類別', dataType: 'string', isRequired: false, order: 4 },
        { name: 'currency', label: '幣別', dataType: 'string', isRequired: true, order: 5 },
        { name: 'amount', label: '金額', dataType: 'currency', isRequired: true, order: 6 },
        { name: 'department', label: '部門', dataType: 'string', isRequired: false, order: 7 },
        { name: 'cost_center', label: '成本中心', dataType: 'string', isRequired: false, order: 8 },
      ],
    },
    {
      id: 'logistics-tracking-format',
      name: '物流追蹤格式',
      description: '專為物流發票設計的追蹤格式',
      scope: 'GLOBAL',
      isSystem: true,
      fields: [
        { name: 'tracking_number', label: '追蹤號碼', dataType: 'string', isRequired: true, order: 1 },
        { name: 'invoice_number', label: '發票號碼', dataType: 'string', isRequired: true, order: 2 },
        { name: 'ship_date', label: '發貨日期', dataType: 'date', isRequired: false, order: 3 },
        { name: 'delivery_date', label: '交付日期', dataType: 'date', isRequired: false, order: 4 },
        { name: 'origin', label: '起運地', dataType: 'string', isRequired: false, order: 5 },
        { name: 'destination', label: '目的地', dataType: 'string', isRequired: false, order: 6 },
        { name: 'carrier', label: '承運商', dataType: 'string', isRequired: true, order: 7 },
        { name: 'service_type', label: '服務類型', dataType: 'string', isRequired: false, order: 8 },
        { name: 'weight', label: '重量', dataType: 'number', isRequired: false, order: 9 },
        { name: 'freight_charge', label: '運費', dataType: 'currency', isRequired: true, order: 10 },
        { name: 'total_amount', label: '總金額', dataType: 'currency', isRequired: true, order: 11 },
      ],
    },
  ]

  let templateCreatedCount = 0
  let templateUpdatedCount = 0

  for (const template of dataTemplateSeedData) {
    const existingTemplate = await prisma.dataTemplate.findUnique({
      where: { id: template.id },
    })

    if (existingTemplate) {
      await prisma.dataTemplate.update({
        where: { id: template.id },
        data: {
          name: template.name,
          description: template.description,
          fields: template.fields as unknown as Prisma.InputJsonValue,
        },
      })
      templateUpdatedCount++
      console.log(`  🔄 Updated: ${template.name}`)
    } else {
      await prisma.dataTemplate.create({
        data: {
          id: template.id,
          name: template.name,
          description: template.description,
          scope: template.scope,
          isSystem: template.isSystem,
          isActive: true,
          fields: template.fields as unknown as Prisma.InputJsonValue,
        },
      })
      templateCreatedCount++
      console.log(`  ✅ Created: ${template.name}`)
    }
  }

  // ===========================================
  // Seed Template Field Mappings (CHANGE-013 Phase 1)
  // ===========================================
  console.log('\n🔗 Creating template field mappings...\n')

  // GLOBAL 範圍的 erp-standard-import 欄位映射
  const erpMappingRules = [
    { id: 'map-01', sourceField: 'invoice_number', targetField: 'invoice_number', transformType: 'DIRECT', isRequired: true, order: 1, description: '發票號碼直接映射' },
    { id: 'map-02', sourceField: 'invoice_date', targetField: 'invoice_date', transformType: 'DIRECT', isRequired: true, order: 2, description: '發票日期直接映射' },
    { id: 'map-03', sourceField: 'vendor_code', targetField: 'vendor_code', transformType: 'DIRECT', isRequired: false, order: 3, description: '供應商代碼直接映射' },
    { id: 'map-04', sourceField: 'vendor_name', targetField: 'vendor_name', transformType: 'DIRECT', isRequired: false, order: 4, description: '供應商名稱直接映射' },
    { id: 'map-05', sourceField: 'currency', targetField: 'currency', transformType: 'DIRECT', isRequired: true, order: 5, description: '幣別直接映射' },
    { id: 'map-06', sourceField: 'subtotal', targetField: 'subtotal', transformType: 'DIRECT', isRequired: false, order: 6, description: '小計直接映射' },
    { id: 'map-07', sourceField: 'tax_amount', targetField: 'tax_amount', transformType: 'DIRECT', isRequired: false, order: 7, description: '稅額直接映射' },
    { id: 'map-08', sourceField: 'total_amount', targetField: 'total_amount', transformType: 'DIRECT', isRequired: true, order: 8, description: '總金額直接映射' },
    { id: 'map-09', sourceField: 'due_date', targetField: 'due_date', transformType: 'DIRECT', isRequired: false, order: 9, description: '付款到期日直接映射' },
    { id: 'map-10', sourceField: 'po_number', targetField: 'po_number', transformType: 'DIRECT', isRequired: false, order: 10, description: '採購單號直接映射' },
    { id: 'map-11', sourceField: 'tracking_number', targetField: 'tracking_number', transformType: 'DIRECT', isRequired: false, order: 11, description: '追蹤號碼直接映射' },
    { id: 'map-12', sourceField: 'description', targetField: 'description', transformType: 'DIRECT', isRequired: false, order: 12, description: '說明直接映射' },
  ]

  const existingErpMapping = await prisma.templateFieldMapping.findFirst({
    where: {
      dataTemplateId: 'erp-standard-import',
      scope: 'GLOBAL',
      companyId: null,
      documentFormatId: null,
    },
  })

  if (existingErpMapping) {
    await prisma.templateFieldMapping.update({
      where: { id: existingErpMapping.id },
      data: {
        name: 'ERP 標準匯入 - 全域映射',
        description: '適用於所有公司的 ERP 標準匯入欄位映射規則',
        mappings: erpMappingRules as unknown as Prisma.InputJsonValue,
      },
    })
    console.log('  🔄 Updated: ERP 標準匯入 - 全域映射 (GLOBAL)')
  } else {
    await prisma.templateFieldMapping.create({
      data: {
        dataTemplateId: 'erp-standard-import',
        scope: 'GLOBAL',
        name: 'ERP 標準匯入 - 全域映射',
        description: '適用於所有公司的 ERP 標準匯入欄位映射規則',
        mappings: erpMappingRules as unknown as Prisma.InputJsonValue,
        priority: 0,
        isActive: true,
      },
    })
    console.log('  ✅ Created: ERP 標準匯入 - 全域映射 (GLOBAL)')
  }

  // ===========================================
  // Set Company.defaultTemplateId (CHANGE-013 Phase 1)
  // ===========================================
  console.log('\n🏢 Setting company default templates...\n')

  // 為 DHL Express 設置預設模版
  const dhlCompany = await prisma.company.findUnique({
    where: { code: 'DHL' },
  })

  if (dhlCompany) {
    await prisma.company.update({
      where: { code: 'DHL' },
      data: { defaultTemplateId: 'erp-standard-import' },
    })
    console.log('  ✅ Set DHL Express defaultTemplateId → erp-standard-import')
  } else {
    console.log('  ⚠️ DHL company not found, skipping defaultTemplateId')
  }

  // 也為 Maersk 設置（常見海運公司）
  const maerskCompany = await prisma.company.findUnique({
    where: { code: 'MAERSK' },
  })

  if (maerskCompany) {
    await prisma.company.update({
      where: { code: 'MAERSK' },
      data: { defaultTemplateId: 'erp-standard-import' },
    })
    console.log('  ✅ Set Maersk defaultTemplateId → erp-standard-import')
  } else {
    console.log('  ⚠️ Maersk company not found, skipping defaultTemplateId')
  }

  // ===========================================
  // Seed Prompt Configs (CHANGE-039)
  // ===========================================
  console.log('\n📝 Creating prompt configs...\n')

  let promptConfigCreatedCount = 0
  let promptConfigUpdatedCount = 0

  for (const seedConfig of PROMPT_CONFIG_SEEDS) {
    const existing = await prisma.promptConfig.findFirst({
      where: {
        promptType: seedConfig.promptType as Prisma.PromptConfigWhereInput['promptType'],
        scope: seedConfig.scope as Prisma.PromptConfigWhereInput['scope'],
        companyId: null,
        documentFormatId: null,
      },
    })

    if (existing) {
      // Only update metadata, not the actual prompt content (user may have customized)
      await prisma.promptConfig.update({
        where: { id: existing.id },
        data: {
          name: seedConfig.name,
          description: seedConfig.description,
        },
      })
      promptConfigUpdatedCount++
      console.log(`  🔄 Updated: ${seedConfig.name}`)
    } else {
      await prisma.promptConfig.create({
        data: {
          promptType: seedConfig.promptType as Prisma.PromptConfigCreateInput['promptType'],
          scope: seedConfig.scope as Prisma.PromptConfigCreateInput['scope'],
          name: seedConfig.name,
          description: seedConfig.description,
          systemPrompt: seedConfig.systemPrompt,
          userPromptTemplate: seedConfig.userPromptTemplate,
          mergeStrategy: seedConfig.mergeStrategy as Prisma.PromptConfigCreateInput['mergeStrategy'],
          variables: seedConfig.variables as Prisma.InputJsonValue,
          isActive: seedConfig.isActive,
          version: seedConfig.version,
        },
      })
      promptConfigCreatedCount++
      console.log(`  ✅ Created: ${seedConfig.name}`)
    }
  }

  // ===========================================
  // Seed Field Mapping Configs (CHANGE-039)
  // ===========================================
  console.log('\n🔗 Creating field mapping configs...\n')

  let fieldMappingConfigCreatedCount = 0
  let fieldMappingConfigUpdatedCount = 0

  for (const seedConfig of FIELD_MAPPING_CONFIG_SEEDS) {
    const existing = await prisma.fieldMappingConfig.findFirst({
      where: {
        scope: seedConfig.scope as Prisma.FieldMappingConfigWhereInput['scope'],
        companyId: null,
        documentFormatId: null,
      },
    })

    if (existing) {
      await prisma.fieldMappingConfig.update({
        where: { id: existing.id },
        data: {
          name: seedConfig.name,
          description: seedConfig.description,
        },
      })
      fieldMappingConfigUpdatedCount++
      console.log(`  🔄 Updated: ${seedConfig.name}`)
    } else {
      const config = await prisma.fieldMappingConfig.create({
        data: {
          scope: seedConfig.scope as Prisma.FieldMappingConfigCreateInput['scope'],
          name: seedConfig.name,
          description: seedConfig.description,
          isActive: seedConfig.isActive,
          version: seedConfig.version,
          dataTemplateId: seedConfig.dataTemplateId,
        },
      })

      // Create associated mapping rules
      for (const rule of seedConfig.rules) {
        await prisma.fieldMappingRule.create({
          data: {
            configId: config.id,
            sourceFields: rule.sourceFields as Prisma.InputJsonValue,
            targetField: rule.targetField,
            transformType: rule.transformType as Prisma.FieldMappingRuleCreateInput['transformType'],
            transformParams: rule.transformParams
              ? (rule.transformParams as Prisma.InputJsonValue)
              : Prisma.JsonNull,
            priority: rule.priority,
            isActive: rule.isActive,
            description: rule.description,
          },
        })
      }

      fieldMappingConfigCreatedCount++
      console.log(`  ✅ Created: ${seedConfig.name} (${seedConfig.rules.length} rules)`)
    }
  }

  // ===========================================
  // Seed Alert Rules (CHANGE-039)
  // ===========================================
  console.log('\n🔔 Creating alert rules...\n')

  let alertRuleCreatedCount = 0
  let alertRuleUpdatedCount = 0

  for (const seedRule of ALERT_RULE_SEEDS) {
    const existing = await prisma.alertRule.findFirst({
      where: { name: seedRule.name },
    })

    if (existing) {
      await prisma.alertRule.update({
        where: { id: existing.id },
        data: {
          description: seedRule.description,
          threshold: seedRule.threshold,
          duration: seedRule.duration,
          severity: seedRule.severity as Prisma.AlertRuleUpdateInput['severity'],
        },
      })
      alertRuleUpdatedCount++
      console.log(`  🔄 Updated: ${seedRule.name}`)
    } else {
      await prisma.alertRule.create({
        data: {
          name: seedRule.name,
          description: seedRule.description,
          conditionType: seedRule.conditionType as Prisma.AlertRuleCreateInput['conditionType'],
          metric: seedRule.metric,
          operator: seedRule.operator as Prisma.AlertRuleCreateInput['operator'],
          threshold: seedRule.threshold,
          duration: seedRule.duration,
          serviceName: seedRule.serviceName,
          severity: seedRule.severity as Prisma.AlertRuleCreateInput['severity'],
          channels: seedRule.channels as Prisma.InputJsonValue,
          recipients: seedRule.recipients as Prisma.InputJsonValue,
          cooldownMinutes: seedRule.cooldownMinutes,
          createdBy: { connect: { id: systemUser.id } },
        },
      })
      alertRuleCreatedCount++
      console.log(`  ✅ Created: ${seedRule.name} (${seedRule.severity})`)
    }
  }

  // ===========================================
  // Seed Exchange Rates (CHANGE-039)
  // ===========================================
  console.log('\n💱 Creating exchange rates...\n')

  let exchangeRateCreatedCount = 0
  let exchangeRateSkippedCount = 0

  for (const seedRate of EXCHANGE_RATE_SEEDS) {
    const existing = await prisma.exchangeRate.findFirst({
      where: {
        fromCurrency: seedRate.fromCurrency,
        toCurrency: seedRate.toCurrency,
        effectiveYear: seedRate.effectiveYear,
      },
    })

    if (existing) {
      exchangeRateSkippedCount++
    } else {
      await prisma.exchangeRate.create({
        data: {
          fromCurrency: seedRate.fromCurrency,
          toCurrency: seedRate.toCurrency,
          rate: seedRate.rate,
          effectiveYear: seedRate.effectiveYear,
          source: seedRate.source as Prisma.ExchangeRateCreateInput['source'],
          description: seedRate.description,
          isActive: true,
        },
      })
      exchangeRateCreatedCount++
    }
  }

  if (exchangeRateCreatedCount > 0) {
    console.log(`  ✅ Created ${exchangeRateCreatedCount} exchange rates`)
  }
  if (exchangeRateSkippedCount > 0) {
    console.log(`  🔄 Skipped ${exchangeRateSkippedCount} existing exchange rates`)
  }

  // ===========================================
  // Restore Exported Data (if available)
  // ===========================================
  const exportedData = loadExportedData()

  let exportedCompaniesCount = 0
  let exportedDocFormatsCount = 0
  let exportedPromptConfigsCount = 0

  if (exportedData) {
    console.log('\n📥 Restoring exported data...\n')

    // 1. Restore additional companies (those not in FORWARDER_SEED_DATA)
    console.log('🏢 Restoring additional companies...')
    const existingCompanyCodes = FORWARDER_SEED_DATA.map(f => f.code)
    const additionalCompanies = exportedData.data.companies.filter(
      c => c.code && !existingCompanyCodes.includes(c.code)
    )

    for (const company of additionalCompanies) {
      try {
        const existingCompany = company.code
          ? await prisma.company.findUnique({ where: { code: company.code } })
          : null

        if (!existingCompany) {
          // Map old type/source values to new schema values
          const typeMap: Record<string, string> = {
            'FORWARDER': 'FORWARDER',
            'CARRIER': 'CARRIER',
            'BROKER': 'CUSTOMS_BROKER',
            'SHIPPER': 'EXPORTER',
            'CONSIGNEE': 'OTHER',
            'OTHER': 'OTHER',
          }
          const sourceMap: Record<string, string> = {
            'SYSTEM': 'MANUAL',
            'USER_CREATED': 'MANUAL',
            'AUTO_DETECTED': 'AUTO_CREATED',
            'IMPORTED': 'IMPORTED',
          }

          await prisma.company.create({
            data: {
              name: company.name,
              code: company.code,
              displayName: company.displayName,
              type: (typeMap[company.type] || 'OTHER') as Prisma.CompanyCreateInput['type'],
              status: 'ACTIVE',
              source: (sourceMap[company.source] || 'MANUAL') as Prisma.CompanyCreateInput['source'],
              nameVariants: company.nameVariants || [],
              identificationPatterns: company.identificationPatterns || [],
              priority: company.priority,
              defaultConfidence: company.defaultConfidence,
              description: company.description,
              creator: { connect: { id: systemUser.id } },
            },
          })
          exportedCompaniesCount++
          console.log(`  ✅ Restored company: ${company.displayName} (${company.code})`)
        }
      } catch (error) {
        console.log(`  ⚠️ Skip company ${company.code}: ${(error as Error).message}`)
      }
    }

    // 2. Restore Document Formats
    console.log('\n📄 Restoring document formats...')

    // Build company ID mapping (old ID → new ID)
    const allCompanies = await prisma.company.findMany({ select: { id: true, code: true } })
    const companyCodeToNewId = new Map<string, string>()
    for (const c of allCompanies) {
      if (c.code) {
        companyCodeToNewId.set(c.code, c.id)
      }
    }

    // Find company code from exported data by old ID
    const oldCompanyIdToCode = new Map<string, string>()
    for (const c of exportedData.data.companies) {
      if (c.code) {
        oldCompanyIdToCode.set(c.id, c.code)
      }
    }

    // Map old document type/subtype values to new schema values
    const docTypeMap: Record<string, string> = {
      'FREIGHT_INVOICE': 'INVOICE',
      'COMMERCIAL_INVOICE': 'INVOICE',
      'PACKING_LIST': 'OTHER',
      'BILL_OF_LADING': 'BILL_OF_LADING',
      'AIRWAY_BILL': 'OTHER',
      'CUSTOMS_DECLARATION': 'CUSTOMS_DECLARATION',
      'CERTIFICATE_OF_ORIGIN': 'OTHER',
      'DELIVERY_NOTE': 'OTHER',
      'PURCHASE_ORDER': 'OTHER',
      'QUOTATION': 'QUOTATION',
      'CONTRACT': 'OTHER',
      'INVOICE': 'INVOICE',
      'DEBIT_NOTE': 'DEBIT_NOTE',
      'CREDIT_NOTE': 'CREDIT_NOTE',
      'STATEMENT': 'STATEMENT',
      'OTHER': 'OTHER',
    }
    const docSubtypeMap: Record<string, string> = {
      'STANDARD': 'GENERAL',
      'CONSOLIDATED': 'GENERAL',
      'DEBIT_NOTE': 'GENERAL',
      'CREDIT_NOTE': 'GENERAL',
      'PRO_FORMA': 'GENERAL',
      'FINAL': 'GENERAL',
      'DRAFT': 'GENERAL',
      'CORRECTION': 'GENERAL',
      'OCEAN_FREIGHT': 'OCEAN_FREIGHT',
      'AIR_FREIGHT': 'AIR_FREIGHT',
      'LAND_TRANSPORT': 'LAND_TRANSPORT',
      'CUSTOMS_CLEARANCE': 'CUSTOMS_CLEARANCE',
      'WAREHOUSING': 'WAREHOUSING',
      'GENERAL': 'GENERAL',
      'OTHER': 'GENERAL',
    }

    for (const docFormat of exportedData.data.documentFormats) {
      try {
        // Map old company ID to new company ID via code
        const companyCode = oldCompanyIdToCode.get(docFormat.companyId)
        const newCompanyId = companyCode ? companyCodeToNewId.get(companyCode) : null

        if (!newCompanyId) {
          // Skip silently - company mapping may not exist
          continue
        }

        const mappedDocType = docTypeMap[docFormat.documentType] || 'OTHER'
        const mappedSubtype = docSubtypeMap[docFormat.documentSubtype] || 'GENERAL'

        // Check if already exists
        const existing = await prisma.documentFormat.findFirst({
          where: {
            companyId: newCompanyId,
            documentType: mappedDocType as Prisma.DocumentFormatWhereInput['documentType'],
            documentSubtype: mappedSubtype as Prisma.DocumentFormatWhereInput['documentSubtype'],
          },
        })

        if (!existing) {
          await prisma.documentFormat.create({
            data: {
              companyId: newCompanyId,
              documentType: mappedDocType as Prisma.DocumentFormatCreateInput['documentType'],
              documentSubtype: mappedSubtype as Prisma.DocumentFormatCreateInput['documentSubtype'],
              name: docFormat.name,
              features: docFormat.features ? (docFormat.features as Prisma.InputJsonValue) : Prisma.JsonNull,
              identificationRules: docFormat.identificationRules ? (docFormat.identificationRules as Prisma.InputJsonValue) : Prisma.JsonNull,
              commonTerms: docFormat.commonTerms || [],
              fileCount: docFormat.fileCount,
            },
          })
          exportedDocFormatsCount++
        }
      } catch (error) {
        // Skip silently
      }
    }
    console.log(`  ✅ Restored ${exportedDocFormatsCount} document formats`)

    // 3. Restore Prompt Configs
    console.log('\n📝 Restoring prompt configs...')

    // Map old prompt type/scope/strategy values to new schema values
    const promptTypeMap: Record<string, string> = {
      'EXTRACTION': 'FIELD_EXTRACTION',
      'CLASSIFICATION': 'TERM_CLASSIFICATION',
      'FIELD_MAPPING': 'FIELD_EXTRACTION',
      'VALIDATION': 'VALIDATION',
      'CUSTOM': 'FIELD_EXTRACTION',
      'ISSUER_IDENTIFICATION': 'ISSUER_IDENTIFICATION',
      'TERM_CLASSIFICATION': 'TERM_CLASSIFICATION',
      'FIELD_EXTRACTION': 'FIELD_EXTRACTION',
      'STAGE_1_COMPANY_IDENTIFICATION': 'STAGE_1_COMPANY_IDENTIFICATION',
      'STAGE_2_FORMAT_IDENTIFICATION': 'STAGE_2_FORMAT_IDENTIFICATION',
      'STAGE_3_FIELD_EXTRACTION': 'STAGE_3_FIELD_EXTRACTION',
    }
    const promptScopeMap: Record<string, string> = {
      'GLOBAL': 'GLOBAL',
      'COMPANY': 'COMPANY',
      'DOCUMENT_FORMAT': 'FORMAT',
      'FORMAT': 'FORMAT',
    }
    const mergeStrategyMap: Record<string, string> = {
      'OVERRIDE': 'OVERRIDE',
      'APPEND': 'APPEND',
      'PREPEND': 'PREPEND',
      'MERGE': 'APPEND', // No MERGE in new schema, use APPEND
    }

    for (const promptConfig of exportedData.data.promptConfigs) {
      try {
        const mappedType = promptTypeMap[promptConfig.promptType] || 'FIELD_EXTRACTION'
        const mappedScope = promptScopeMap[promptConfig.scope] || 'GLOBAL'
        const mappedStrategy = mergeStrategyMap[promptConfig.mergeStrategy] || 'OVERRIDE'

        // Check if already exists by name and type
        const existing = await prisma.promptConfig.findFirst({
          where: {
            name: promptConfig.name,
            promptType: mappedType as Prisma.PromptConfigWhereInput['promptType'],
          },
        })

        if (!existing) {
          // Map company ID
          let newCompanyId: string | null = null
          if (promptConfig.companyId) {
            const companyCode = oldCompanyIdToCode.get(promptConfig.companyId)
            newCompanyId = companyCode ? companyCodeToNewId.get(companyCode) || null : null
          }

          await prisma.promptConfig.create({
            data: {
              promptType: mappedType as Prisma.PromptConfigCreateInput['promptType'],
              scope: mappedScope as Prisma.PromptConfigCreateInput['scope'],
              name: promptConfig.name,
              description: promptConfig.description,
              companyId: newCompanyId,
              // Skip documentFormatId mapping for now (complex)
              systemPrompt: promptConfig.systemPrompt,
              userPromptTemplate: promptConfig.userPromptTemplate,
              mergeStrategy: mappedStrategy as Prisma.PromptConfigCreateInput['mergeStrategy'],
              variables: promptConfig.variables ? (promptConfig.variables as Prisma.InputJsonValue) : Prisma.JsonNull,
              isActive: promptConfig.isActive,
              version: promptConfig.version,
            },
          })
          exportedPromptConfigsCount++
          console.log(`  ✅ Restored prompt config: ${promptConfig.name}`)
        }
      } catch (error) {
        console.log(`  ⚠️ Skip prompt config ${promptConfig.name}: ${(error as Error).message}`)
      }
    }

    console.log(`\n📊 Exported data restoration summary:`)
    console.log(`  - Additional companies: ${exportedCompaniesCount}`)
    console.log(`  - Document formats: ${exportedDocFormatsCount}`)
    console.log(`  - Prompt configs: ${exportedPromptConfigsCount}`)
  }

  // ===========================================
  // Seed Pipeline Config (CHANGE-032)
  // ===========================================
  console.log('\n⚙️ Creating default pipeline config...\n')

  const existingGlobalPipelineConfig = await prisma.pipelineConfig.findFirst({
    where: {
      scope: 'GLOBAL',
      regionId: null,
      companyId: null,
    },
  })

  if (existingGlobalPipelineConfig) {
    console.log('  🔄 Global pipeline config already exists, skipping')
  } else {
    await prisma.pipelineConfig.create({
      data: {
        scope: 'GLOBAL',
        regionId: null,
        companyId: null,
        refMatchEnabled: false,
        refMatchTypes: ['SHIPMENT', 'HAWB', 'MAWB', 'BL', 'CONTAINER'],
        refMatchMaxResults: 10,
        fxConversionEnabled: false,
        fxTargetCurrency: null,
        fxConvertLineItems: true,
        fxConvertExtraCharges: true,
        fxRoundingPrecision: 2,
        fxFallbackBehavior: 'skip',
        isActive: true,
        description: 'Default global pipeline configuration',
      },
    })
    console.log('  ✅ Created: Global pipeline config (both features disabled by default)')
  }

  // ===========================================
  // Summary
  // ===========================================
  const roleCount = await prisma.role.count()
  const userCount = await prisma.user.count()
  const regionCount = await prisma.region.count()
  const cityCount = await prisma.city.count()
  const companyCount = await prisma.company.count()
  const mappingRuleCount = await prisma.mappingRule.count()
  const systemConfigCount = await prisma.systemConfig.count()
  const dataTemplateCount = await prisma.dataTemplate.count()
  const templateFieldMappingCount = await prisma.templateFieldMapping.count()
  const documentFormatCount = await prisma.documentFormat.count()
  const promptConfigCount = await prisma.promptConfig.count()
  const pipelineConfigCount = await prisma.pipelineConfig.count()
  const fieldMappingConfigCount = await prisma.fieldMappingConfig.count()
  const alertRuleCount = await prisma.alertRule.count()
  const exchangeRateCount = await prisma.exchangeRate.count()

  console.log('\n========================================')
  console.log('✨ Seed completed successfully!')
  console.log('========================================')
  console.log(`  Roles created: ${createdCount}`)
  console.log(`  Roles updated: ${updatedCount}`)
  console.log(`  Regions created: ${regionCreatedCount}`)
  console.log(`  Regions updated: ${regionUpdatedCount}`)
  console.log(`  Cities created: ${cityCreatedCount}`)
  console.log(`  Cities updated: ${cityUpdatedCount}`)
  console.log(`  Companies created: ${companyCreatedCount}`)
  console.log(`  Companies updated: ${companyUpdatedCount}`)
  console.log(`  Mapping rules created: ${ruleCreatedCount}`)
  console.log(`  Mapping rules updated: ${ruleUpdatedCount}`)
  console.log(`  System configs created: ${configCreatedCount}`)
  console.log(`  System configs updated: ${configUpdatedCount}`)
  console.log(`  Data templates created: ${templateCreatedCount}`)
  console.log(`  Data templates updated: ${templateUpdatedCount}`)
  console.log(`  Prompt configs created: ${promptConfigCreatedCount}`)
  console.log(`  Prompt configs updated: ${promptConfigUpdatedCount}`)
  console.log(`  Field mapping configs created: ${fieldMappingConfigCreatedCount}`)
  console.log(`  Field mapping configs updated: ${fieldMappingConfigUpdatedCount}`)
  console.log(`  Alert rules created: ${alertRuleCreatedCount}`)
  console.log(`  Alert rules updated: ${alertRuleUpdatedCount}`)
  console.log(`  Exchange rates created: ${exchangeRateCreatedCount}`)
  console.log(`  Exchange rates skipped: ${exchangeRateSkippedCount}`)
  if (exportedData) {
    console.log(`  Exported companies restored: ${exportedCompaniesCount}`)
    console.log(`  Document formats restored: ${exportedDocFormatsCount}`)
    console.log(`  Prompt configs restored: ${exportedPromptConfigsCount}`)
  }
  console.log('----------------------------------------')
  console.log(`  Total roles: ${roleCount}`)
  console.log(`  Total regions: ${regionCount}`)
  console.log(`  Total cities: ${cityCount}`)
  console.log(`  Total companies: ${companyCount}`)
  console.log(`  Total mapping rules: ${mappingRuleCount}`)
  console.log(`  Total system configs: ${systemConfigCount}`)
  console.log(`  Total data templates: ${dataTemplateCount}`)
  console.log(`  Total template field mappings: ${templateFieldMappingCount}`)
  console.log(`  Total document formats: ${documentFormatCount}`)
  console.log(`  Total prompt configs: ${promptConfigCount}`)
  console.log(`  Total field mapping configs: ${fieldMappingConfigCount}`)
  console.log(`  Total pipeline configs: ${pipelineConfigCount}`)
  console.log(`  Total alert rules: ${alertRuleCount}`)
  console.log(`  Total exchange rates: ${exchangeRateCount}`)
  console.log(`  Total users: ${userCount}`)
  console.log('========================================\n')
}

main()
  .then(async () => {
    await prisma.$disconnect()
    await pool.end()
  })
  .catch(async (e) => {
    console.error('\n❌ Seed failed:', e)
    await prisma.$disconnect()
    await pool.end()
    process.exit(1)
  })
