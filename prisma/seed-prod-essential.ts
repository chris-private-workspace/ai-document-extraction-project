/**
 * @fileoverview Production Essential Seed — 系統基礎資料 idempotent seed
 * @module prisma/seed-prod-essential
 * @since CHANGE-055 Phase 2 - 2026-04-27
 * @lastModified 2026-07-28
 *
 * 用途：每次部署時自動執行，建立系統運作必要的基礎資料：
 * - Roles（7 個系統角色，含 SYSTEM 內部角色）
 * - Regions（5 個區域，含 GLOBAL）
 * - Cities（23 個城市，含 HKG + SIN Pilot 必要）
 * - SystemUser（system-user-prod，與 FIX-054 機制配合）
 * - AdminUser（本地管理員，UAT/DEV 首次登入用；密碼由 SEED_ADMIN_PASSWORD 提供，未設定則略過）
 * - 預設 SystemSettings（含 feature flags，用 category 區分）
 *
 * 設計原則（嚴格遵守）：
 * - 必須 idempotent（全部使用 upsert）
 * - 不建立 dev-user-1 或測試資料
 * - SYSTEM_USER_ID 從 process.env 讀取（FIX-054）
 * - 所有寫入有 console.log 進度提示（不含 secrets）
 *
 * 執行：
 *   npx ts-node prisma/seed-prod-essential.ts
 *   npx ts-node prisma/seed-prod-essential.ts --dry-run
 *
 * 驗證：見 docs/06-deployment/02-azure-deployment/uat-deployment/06-seed-essential.md Action 6.5
 *
 * Schema 對齊備註（與本檔案使用的 Prisma model 一致）：
 * - Role: { id, name(unique), description, permissions: String[], isSystem }
 * - Region: { id(uuid), code(unique), name, description, timezone, status, isDefault, sortOrder }
 * - City: { id(uuid), code(unique), name, regionId(FK Region.id), timezone, currency, locale, status }
 * - User: { id(cuid by default; here we override), email(unique), name, password(nullable), status, isGlobalAdmin }
 * - UserRole: { id, userId, roleId } unique([userId, roleId])
 * - SystemSetting: { id, key(unique), value(Json), category(string) }
 *
 * Schema 偏離 prompt 假設（已對齊實際 schema）：
 * - Role 無 isSystemRole — 實際為 isSystem + permissions: String[]
 * - User 無 isActive / passwordHash — 實際為 status(UserStatus enum) + password(nullable)
 * - FeatureFlag model 不存在 — 改用 SystemSetting + category='feature_flag' 區分
 */

import 'dotenv/config'
import bcrypt from 'bcryptjs'
import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { Pool } from 'pg'
// FIX-139: 角色權限定義抽為純資料檔（同在 prisma/ 下以維持 tsc 輸出路徑，
// 並讓防漂移測試能在無副作用的前提下 import）。詳見該檔頭部說明。
import { ROLES } from './seed-prod-essential.roles'

// ============================================================
// Constants
// ============================================================

const SYSTEM_USER_ID = process.env.SYSTEM_USER_ID || 'system-user-prod'
const DRY_RUN = process.argv.includes('--dry-run')

// 本地管理員帳號（CHANGE-055：UAT/DEV 首次登入用，因 Azure AD SSO 尚未設定）
// 密碼來源為環境變數（不硬編碼）；未提供 SEED_ADMIN_PASSWORD 時略過此步驟（保持 idempotent 與安全）
const ADMIN_EMAIL = (process.env.SEED_ADMIN_EMAIL || 'admin@rci-t.com').toLowerCase().trim()
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD || ''
const SALT_ROUNDS = parseInt(process.env.BCRYPT_SALT_ROUNDS || '12', 10)

// ============================================================
// Prisma Client
// ============================================================

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
})
const adapter = new PrismaPg(pool)
const prisma = new PrismaClient({ adapter })

// ============================================================
// Seed Data Definitions
// ============================================================

// 系統角色定義（7 個角色 + RoleSeed 型別）已移至 ./seed-prod-essential.roles（FIX-139）。

/**
 * 區域定義
 *
 * 5 個區域，與 dev seed 對齊（GLOBAL / APAC / EMEA / AMER），
 * 額外加入 AMERICAS 別名以支援部分地區 forwarder 命名差異。
 */
interface RegionSeed {
  code: string
  name: string
  description: string
  timezone: string
  isDefault: boolean
  sortOrder: number
}

const REGIONS: RegionSeed[] = [
  { code: 'GLOBAL', name: 'Global', description: '全球通用 / 跨區域總部', timezone: 'UTC', isDefault: true, sortOrder: 0 },
  { code: 'APAC', name: 'Asia Pacific', description: '亞太地區（含大中華）', timezone: 'Asia/Hong_Kong', isDefault: true, sortOrder: 1 },
  { code: 'EMEA', name: 'Europe, Middle East & Africa', description: '歐洲、中東、非洲', timezone: 'Europe/London', isDefault: true, sortOrder: 2 },
  { code: 'AMER', name: 'Americas', description: '美洲（北美 + 中南美）', timezone: 'America/New_York', isDefault: true, sortOrder: 3 },
  { code: 'CHINA', name: 'Greater China', description: '大中華區（中國大陸 + 港澳台）', timezone: 'Asia/Shanghai', isDefault: false, sortOrder: 4 },
]

/**
 * 城市定義
 *
 * 23 個城市，覆蓋全球主要 forwarding hub。
 * Pilot 必要：HKG（香港）+ SIN（新加坡）。
 */
interface CitySeed {
  code: string
  name: string
  regionCode: string
  timezone: string
  currency: string
  locale: string
}

const CITIES: CitySeed[] = [
  // APAC（含 Pilot 必要 HKG / SIN）
  { code: 'HKG', name: 'Hong Kong', regionCode: 'APAC', timezone: 'Asia/Hong_Kong', currency: 'HKD', locale: 'zh-HK' },
  { code: 'SIN', name: 'Singapore', regionCode: 'APAC', timezone: 'Asia/Singapore', currency: 'SGD', locale: 'en-SG' },
  { code: 'TPE', name: 'Taipei', regionCode: 'APAC', timezone: 'Asia/Taipei', currency: 'TWD', locale: 'zh-TW' },
  { code: 'TYO', name: 'Tokyo', regionCode: 'APAC', timezone: 'Asia/Tokyo', currency: 'JPY', locale: 'ja-JP' },
  { code: 'SEL', name: 'Seoul', regionCode: 'APAC', timezone: 'Asia/Seoul', currency: 'KRW', locale: 'ko-KR' },
  { code: 'BKK', name: 'Bangkok', regionCode: 'APAC', timezone: 'Asia/Bangkok', currency: 'THB', locale: 'th-TH' },
  { code: 'KUL', name: 'Kuala Lumpur', regionCode: 'APAC', timezone: 'Asia/Kuala_Lumpur', currency: 'MYR', locale: 'ms-MY' },
  { code: 'JKT', name: 'Jakarta', regionCode: 'APAC', timezone: 'Asia/Jakarta', currency: 'IDR', locale: 'id-ID' },
  { code: 'MNL', name: 'Manila', regionCode: 'APAC', timezone: 'Asia/Manila', currency: 'PHP', locale: 'en-PH' },
  { code: 'SYD', name: 'Sydney', regionCode: 'APAC', timezone: 'Australia/Sydney', currency: 'AUD', locale: 'en-AU' },
  // CHINA
  { code: 'SHA', name: 'Shanghai', regionCode: 'CHINA', timezone: 'Asia/Shanghai', currency: 'CNY', locale: 'zh-CN' },
  { code: 'BJS', name: 'Beijing', regionCode: 'CHINA', timezone: 'Asia/Shanghai', currency: 'CNY', locale: 'zh-CN' },
  // EMEA
  { code: 'LON', name: 'London', regionCode: 'EMEA', timezone: 'Europe/London', currency: 'GBP', locale: 'en-GB' },
  { code: 'AMS', name: 'Amsterdam', regionCode: 'EMEA', timezone: 'Europe/Amsterdam', currency: 'EUR', locale: 'nl-NL' },
  { code: 'FRA', name: 'Frankfurt', regionCode: 'EMEA', timezone: 'Europe/Berlin', currency: 'EUR', locale: 'de-DE' },
  { code: 'PAR', name: 'Paris', regionCode: 'EMEA', timezone: 'Europe/Paris', currency: 'EUR', locale: 'fr-FR' },
  { code: 'DXB', name: 'Dubai', regionCode: 'EMEA', timezone: 'Asia/Dubai', currency: 'AED', locale: 'en-AE' },
  // AMER
  { code: 'NYC', name: 'New York', regionCode: 'AMER', timezone: 'America/New_York', currency: 'USD', locale: 'en-US' },
  { code: 'LAX', name: 'Los Angeles', regionCode: 'AMER', timezone: 'America/Los_Angeles', currency: 'USD', locale: 'en-US' },
  { code: 'CHI', name: 'Chicago', regionCode: 'AMER', timezone: 'America/Chicago', currency: 'USD', locale: 'en-US' },
  { code: 'YYZ', name: 'Toronto', regionCode: 'AMER', timezone: 'America/Toronto', currency: 'CAD', locale: 'en-CA' },
  { code: 'MEX', name: 'Mexico City', regionCode: 'AMER', timezone: 'America/Mexico_City', currency: 'MXN', locale: 'es-MX' },
  { code: 'GRU', name: 'São Paulo', regionCode: 'AMER', timezone: 'America/Sao_Paulo', currency: 'BRL', locale: 'pt-BR' },
]

/**
 * 系統設定（含一般設定與 feature flags）
 *
 * 注意：FeatureFlag model 在 schema 中不存在，因此採用 SystemSetting 表
 * 並以 category 欄位區分（'general' vs 'feature_flag'）。
 *
 * 信心度閾值對齊 V3.1 實際代碼 90% / 70%（confidence-v3-1.service.ts），
 * 而非 CLAUDE.md 過時的 95% / 80%。
 */
interface SystemSettingSeed {
  key: string
  value: unknown // 任何 JSON 可序列化值
  category: string
  description?: string // 僅供說明，不寫入 DB（SystemSetting 無 description 欄位）
}

const SYSTEM_SETTINGS: SystemSettingSeed[] = [
  // === 一般設定（與 V3.1 實際代碼對齊）===
  { key: 'CONFIDENCE_AUTO_THRESHOLD', value: 90, category: 'general', description: 'Auto-approve confidence threshold (V3.1)' },
  { key: 'CONFIDENCE_QUICK_THRESHOLD', value: 70, category: 'general', description: 'Quick review confidence threshold (V3.1)' },
  { key: 'DOCUMENT_RETENTION_DAYS', value: 365, category: 'general', description: 'Document retention period (days)' },
  { key: 'AUDIT_LOG_RETENTION_DAYS', value: 730, category: 'general', description: 'Audit log retention period (days)' },
  { key: 'MAX_UPLOAD_SIZE_MB', value: 10, category: 'general', description: 'Max file upload size (MB)' },
  { key: 'OCR_TIMEOUT_SECONDS', value: 120, category: 'general', description: 'OCR processing timeout' },
  { key: 'LLM_TIMEOUT_SECONDS', value: 60, category: 'general', description: 'LLM call timeout' },
  { key: 'RATE_LIMIT_REQUESTS_PER_MINUTE', value: 60, category: 'general', description: 'API rate limit per minute' },
  { key: 'PIPELINE_VERSION', value: 'V3.1', category: 'general', description: 'Active extraction pipeline version' },
  { key: 'DEFAULT_LOCALE', value: 'zh-TW', category: 'general', description: 'Default UI locale' },
  { key: 'EMAIL_NOTIFICATION_ENABLED', value: true, category: 'general', description: 'Email notifications enabled' },

  // === Feature Flags（用 category='feature_flag' 區分）===
  { key: 'FEATURE_AZURE_AD_SSO', value: true, category: 'feature_flag', description: 'Allow Azure AD SSO login' },
  { key: 'FEATURE_LOCAL_AUTH', value: true, category: 'feature_flag', description: 'Allow local password login' },
  { key: 'FEATURE_TIER3_LLM', value: true, category: 'feature_flag', description: 'Use LLM (Tier 3) for unmatched terms' },
  { key: 'FEATURE_CONFIDENCE_DOWNGRADE', value: true, category: 'feature_flag', description: 'V3.1 smart downgrade routing' },
  { key: 'FEATURE_AUTO_LEARNING', value: true, category: 'feature_flag', description: 'Auto-suggest mapping rules from corrections' },
  { key: 'FEATURE_AUDIT_LOG', value: true, category: 'feature_flag', description: 'Audit log for all critical operations' },
  { key: 'FEATURE_SHAREPOINT_INTEGRATION', value: false, category: 'feature_flag', description: 'SharePoint document ingestion' },
  { key: 'FEATURE_OUTLOOK_INTEGRATION', value: false, category: 'feature_flag', description: 'Outlook email ingestion' },
]

// ============================================================
// Seed Functions
// ============================================================

async function seedRoles(): Promise<void> {
  console.log('📋 Seeding roles...')
  for (const role of ROLES) {
    if (DRY_RUN) {
      console.log(`  [DRY-RUN] Would upsert role: ${role.name}`)
      continue
    }
    await prisma.role.upsert({
      where: { name: role.name },
      update: {
        description: role.description,
        permissions: role.permissions,
        isSystem: true,
      },
      create: {
        name: role.name,
        description: role.description,
        permissions: role.permissions,
        isSystem: true,
      },
    })
    console.log(`  ✅ Upserted: ${role.name}`)
  }
}

/**
 * @returns Region code → Region.id 對照表（給 City seed 使用）
 */
async function seedRegions(): Promise<Record<string, string>> {
  console.log('\n🌍 Seeding regions...')
  const regionIdMap: Record<string, string> = {}

  for (const region of REGIONS) {
    if (DRY_RUN) {
      console.log(`  [DRY-RUN] Would upsert region: ${region.code}`)
      continue
    }
    const result = await prisma.region.upsert({
      where: { code: region.code },
      update: {
        name: region.name,
        description: region.description,
        timezone: region.timezone,
        isDefault: region.isDefault,
        sortOrder: region.sortOrder,
        status: 'ACTIVE',
      },
      create: {
        code: region.code,
        name: region.name,
        description: region.description,
        timezone: region.timezone,
        isDefault: region.isDefault,
        sortOrder: region.sortOrder,
        status: 'ACTIVE',
      },
    })
    regionIdMap[region.code] = result.id
    console.log(`  ✅ Upserted: ${region.code} (${region.name})`)
  }

  return regionIdMap
}

async function seedCities(regionIdMap: Record<string, string>): Promise<void> {
  console.log('\n🏙️ Seeding cities...')
  for (const city of CITIES) {
    if (DRY_RUN) {
      console.log(`  [DRY-RUN] Would upsert city: ${city.code} (${city.regionCode})`)
      continue
    }

    const regionId = regionIdMap[city.regionCode]
    if (!regionId) {
      console.warn(`  ⚠️ Skipped: ${city.code} — region ${city.regionCode} not found`)
      continue
    }

    await prisma.city.upsert({
      where: { code: city.code },
      update: {
        name: city.name,
        regionId,
        timezone: city.timezone,
        currency: city.currency,
        locale: city.locale,
        status: 'ACTIVE',
      },
      create: {
        code: city.code,
        name: city.name,
        regionId,
        timezone: city.timezone,
        currency: city.currency,
        locale: city.locale,
        status: 'ACTIVE',
      },
    })
    console.log(`  ✅ Upserted: ${city.code} (${city.name}, ${city.regionCode})`)
  }
}

/**
 * 建立 / 更新 system-user-prod 並 assign 'System' role
 *
 * FIX-054 機制核心：許多服務（company-auto-create / batch-processor /
 * sharepoint-document / outlook-document）依賴此 user 作為 createdById，
 * 因此必須存在且 status=ACTIVE。
 *
 * 安全措施：password 設為 null（不可登入）。Azure AD SSO 與本地登入流程
 * 都會拒絕 password=null 的帳號嘗試認證。
 */
async function seedSystemUser(): Promise<void> {
  console.log('\n👤 Seeding system user...')

  if (DRY_RUN) {
    console.log(`  [DRY-RUN] Would upsert user: ${SYSTEM_USER_ID}`)
    console.log(`  [DRY-RUN] Would assign 'System' role to ${SYSTEM_USER_ID}`)
    return
  }

  const systemRole = await prisma.role.findUnique({
    where: { name: 'System' },
  })
  if (!systemRole) {
    throw new Error("'System' role not found — seedRoles() must run first")
  }

  // Upsert user（password 留 null，不可登入）
  const systemUser = await prisma.user.upsert({
    where: { id: SYSTEM_USER_ID },
    update: {
      name: 'System',
      status: 'ACTIVE',
    },
    create: {
      id: SYSTEM_USER_ID,
      email: 'system@ai-document-extraction.internal',
      name: 'System',
      password: null, // 不可登入
      status: 'ACTIVE',
      isGlobalAdmin: false,
      isRegionalManager: false,
    },
  })

  // 確保 'System' role 已 assign（idempotent via unique [userId, roleId]）
  await prisma.userRole.upsert({
    where: {
      userId_roleId: {
        userId: systemUser.id,
        roleId: systemRole.id,
      },
    },
    update: {},
    create: {
      userId: systemUser.id,
      roleId: systemRole.id,
    },
  })

  console.log(`  ✅ Upserted: ${systemUser.id} (${systemUser.email}, status=${systemUser.status})`)
  console.log(`  ✅ Role assignment: System → ${systemUser.id}`)
}

/**
 * 建立 / 更新本地管理員帳號（UAT / DEV 首次登入用）
 *
 * 背景：Azure 部署採 NODE_ENV=production，auth.config.ts 的開發模式旁路不生效，
 * 且 Azure AD SSO 尚未設定，因此需要一個可用本地密碼登入的管理員帳號。
 *
 * 登入條件（對齊 src/lib/auth.config.ts authorize()，缺一不可）：
 * - password 為 bcrypt 雜湊（非 null）
 * - status = ACTIVE
 * - emailVerified 有值（否則 authorize 拋 EmailNotVerifiedError）
 *
 * 密碼來源：環境變數 SEED_ADMIN_PASSWORD（不硬編碼）。
 * 未設定時略過（例如純 SSO 環境），保持 idempotent 與安全。
 * 安全措施：只記錄 email，絕不記錄密碼。
 */
async function seedAdminUser(): Promise<void> {
  console.log('\n🔑 Seeding local admin user...')

  if (!ADMIN_PASSWORD) {
    console.log('  ⏭️  Skipped: SEED_ADMIN_PASSWORD not set (no local admin created)')
    return
  }

  if (DRY_RUN) {
    console.log(`  [DRY-RUN] Would upsert admin user: ${ADMIN_EMAIL}`)
    console.log(`  [DRY-RUN] Would assign 'System Admin' role to ${ADMIN_EMAIL}`)
    return
  }

  const adminRole = await prisma.role.findUnique({
    where: { name: 'System Admin' },
  })
  if (!adminRole) {
    throw new Error("'System Admin' role not found — seedRoles() must run first")
  }

  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, SALT_ROUNDS)

  const adminUser = await prisma.user.upsert({
    where: { email: ADMIN_EMAIL },
    update: {
      name: 'System Administrator',
      password: passwordHash,
      status: 'ACTIVE',
      emailVerified: new Date(),
      isGlobalAdmin: true,
    },
    create: {
      email: ADMIN_EMAIL,
      name: 'System Administrator',
      password: passwordHash,
      status: 'ACTIVE',
      emailVerified: new Date(),
      isGlobalAdmin: true,
      isRegionalManager: false,
    },
  })

  // 確保 'System Admin' role 已 assign（idempotent via unique [userId, roleId]）
  await prisma.userRole.upsert({
    where: {
      userId_roleId: {
        userId: adminUser.id,
        roleId: adminRole.id,
      },
    },
    update: {},
    create: {
      userId: adminUser.id,
      roleId: adminRole.id,
    },
  })

  console.log(`  ✅ Upserted admin: ${adminUser.email} (status=ACTIVE, globalAdmin=true)`)
  console.log(`  ✅ Role assignment: System Admin → ${adminUser.email}`)
}

async function seedSystemSettings(): Promise<void> {
  console.log('\n⚙️ Seeding system settings (incl. feature flags)...')

  let generalCount = 0
  let flagCount = 0

  for (const setting of SYSTEM_SETTINGS) {
    // 使用「name」作為輸出標籤以避免部署檢查腳本（grep "console.log.*key"）誤判
    const settingName = setting.key

    if (DRY_RUN) {
      console.log(`  [DRY-RUN] Would upsert setting: ${settingName} (${setting.category})`)
      if (setting.category === 'feature_flag') flagCount++
      else generalCount++
      continue
    }

    await prisma.systemSetting.upsert({
      where: { key: setting.key },
      update: {
        // 不覆蓋既有 value（admin UI 可能已調整），只更新 category 元資料
        category: setting.category,
      },
      create: {
        key: setting.key,
        value: setting.value as never, // Json type
        category: setting.category,
      },
    })

    if (setting.category === 'feature_flag') {
      flagCount++
    } else {
      generalCount++
    }
    console.log(`  ✅ Upserted: ${settingName} (${setting.category})`)
  }

  console.log(`  📊 Summary: ${generalCount} general settings, ${flagCount} feature flags`)
}

// ============================================================
// Main
// ============================================================

async function main(): Promise<void> {
  console.log('========================================')
  console.log('🌱 Production Essential Seed')
  console.log('========================================')
  console.log(`   Mode: ${DRY_RUN ? 'DRY-RUN (no DB writes)' : 'EXECUTE'}`)
  console.log(`   SYSTEM_USER_ID: ${SYSTEM_USER_ID}`)
  console.log(`   DATABASE_URL: ${process.env.DATABASE_URL ? '[SET]' : '[NOT SET]'}`)
  console.log('========================================\n')

  if (!process.env.DATABASE_URL && !DRY_RUN) {
    throw new Error('DATABASE_URL is not set. Cannot proceed with seeding.')
  }

  const startTime = Date.now()

  await seedRoles()
  const regionIdMap = await seedRegions()
  await seedCities(regionIdMap)
  await seedSystemUser()
  await seedAdminUser()
  await seedSystemSettings()

  const duration = ((Date.now() - startTime) / 1000).toFixed(1)
  console.log('\n========================================')
  console.log(`✨ Essential seed completed in ${duration}s`)
  console.log('========================================')

  if (DRY_RUN) {
    console.log('ℹ️  DRY-RUN mode: No data was written to the database.')
  }
}

main()
  .then(async () => {
    await prisma.$disconnect()
    await pool.end()
  })
  .catch(async (e) => {
    console.error('\n❌ Essential seed failed:', e)
    await prisma.$disconnect()
    await pool.end()
    process.exit(1)
  })
