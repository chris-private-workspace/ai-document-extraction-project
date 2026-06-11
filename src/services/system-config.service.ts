/**
 * @fileoverview System Configuration Service - 系統配置管理服務
 * @description
 *   本服務提供系統配置的完整管理功能，包括：
 *   - 配置 CRUD 操作
 *   - 版本控制與歷史追蹤
 *   - 配置回滾功能
 *   - 敏感值 AES-256-GCM 加密
 *   - 配置快取與熱載入
 *   - 值類型驗證
 *
 * @module src/services/system-config.service
 * @author Development Team
 * @since Epic 6 - Story 6.4 (Global Admin Full Access)
 * @lastModified 2025-12-21
 *
 * @features
 *   - 配置版本控制
 *   - 變更歷史追蹤
 *   - 支援回滾到任意版本
 *   - 敏感值加密儲存 (AES-256-GCM)
 *   - 配置快取 (60 秒 TTL)
 *   - 值類型驗證
 *   - 重置為預設值
 *   - 審計日誌記錄
 *
 * @dependencies
 *   - @prisma/client - Prisma ORM 客戶端
 *   - @/lib/prisma - Prisma 實例
 *   - crypto - Node.js 加密模組
 *
 * @related
 *   - src/services/global-admin.service.ts - 全局管理者服務
 *   - src/app/api/admin/config - 配置管理 API
 *   - prisma/schema.prisma - SystemConfig, ConfigHistory 模型
 */

import { prisma } from '@/lib/prisma'
import {
  ConfigCategory,
  ConfigScope,
  ConfigValueType,
  Prisma,
} from '@prisma/client'
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto'
import { EventEmitter } from 'events'
import type {
  ConfigValue,
  ConfigValidation,
  ConfigUpdateInput,
  ConfigUpdateResult,
  ConfigListOptions,
  ConfigHistoryOptions,
  ConfigHistoryResult,
  ConfigHistoryItem,
  GroupedConfigs,
  ConfigImportResult,
} from '@/types/config'

// ============================================================
// Constants
// ============================================================

/** 加密演算法 */
const ENCRYPTION_ALGORITHM = 'aes-256-gcm'

/**
 * 舊版靜態鹽值（FIX-070 前的固定派生鹽）
 *
 * 僅用於「向後相容解密」既有以舊格式（IV:AuthTag:Data，3 段）儲存的密文。
 * 新加密一律改用每次隨機產生的鹽並隨密文儲存（見 encryptValue），
 * 不再使用此靜態鹽進行新的金鑰派生。
 */
const LEGACY_ENCRYPTION_SALT = 'config-salt'

/** 隨機鹽位元組長度（隨密文儲存，FIX-070） */
const SALT_LENGTH = 16

/** 快取 TTL（毫秒） */
const CACHE_TTL = 60000 // 60 秒

// ============================================================
// Event Emitter
// ============================================================

/** 配置變更事件發射器 */
export const configEvents = new EventEmitter()

// ============================================================
// Legacy Types (保持向後相容 Story 6.4)
// ============================================================

/**
 * 配置值類型 (Legacy)
 */
export interface LegacyConfigValue {
  [key: string]: unknown
}

/**
 * 配置項目資訊 (Legacy)
 */
export interface ConfigInfo {
  /** 配置鍵 */
  key: string
  /** 配置值 */
  value: LegacyConfigValue
  /** 描述 */
  description: string | null
  /** 類別 */
  category: ConfigCategory
  /** 範圍 */
  scope: ConfigScope
  /** 城市代碼（如適用） */
  cityCode: string | null
  /** 版本號 */
  version: number
  /** 是否啟用 */
  isActive: boolean
  /** 更新時間 */
  updatedAt: Date
  /** 更新者 */
  updatedBy: string | null
}

/**
 * 配置歷史記錄 (Legacy)
 */
export interface ConfigHistoryInfo {
  /** 版本號 */
  version: number
  /** 變更前的值 */
  previousValue: LegacyConfigValue
  /** 變更後的值 */
  newValue: LegacyConfigValue
  /** 變更者 */
  changedBy: {
    id: string
    name: string | null
    email: string
  }
  /** 變更原因 */
  changeReason: string | null
  /** 變更時間 */
  createdAt: Date
}

/**
 * 建立配置參數 (Legacy)
 */
export interface CreateConfigParams {
  /** 配置鍵 */
  key: string
  /** 配置值 */
  value: LegacyConfigValue
  /** 描述 */
  description?: string
  /** 類別 */
  category: ConfigCategory
  /** 範圍 */
  scope?: ConfigScope
  /** 城市代碼 */
  cityCode?: string
  /** 建立者 ID */
  createdBy: string
}

/**
 * 更新配置參數 (Legacy)
 */
export interface UpdateConfigParams {
  /** 配置鍵 */
  key: string
  /** 新配置值 */
  value: LegacyConfigValue
  /** 更新者 ID */
  updatedBy: string
  /** 變更原因 */
  changeReason?: string
}

/**
 * 回滾配置參數 (Legacy)
 */
export interface RollbackConfigParams {
  /** 配置鍵 */
  key: string
  /** 目標版本號 */
  targetVersion: number
  /** 回滾者 ID */
  rolledBackBy: string
  /** 回滾原因 */
  reason: string
}

// ============================================================
// Custom Errors
// ============================================================

/**
 * 系統配置操作錯誤
 */
export class SystemConfigError extends Error {
  constructor(
    message: string,
    public code: string,
    public details?: Record<string, unknown>
  ) {
    super(message)
    this.name = 'SystemConfigError'
  }
}

// ============================================================
// Config Cache Class
// ============================================================

/**
 * 配置快取類別
 * 提供記憶體快取以減少資料庫查詢
 */
class ConfigCache {
  private cache: Map<string, unknown> = new Map()
  private lastRefresh: Date = new Date(0)
  private refreshInterval = CACHE_TTL
  private isRefreshing = false

  /**
   * 取得快取值
   */
  async get(key: string): Promise<unknown | undefined> {
    if (this.shouldRefresh() && !this.isRefreshing) {
      await this.refresh()
    }
    return this.cache.get(key)
  }

  /**
   * 設定快取值
   */
  set(key: string, value: unknown): void {
    this.cache.set(key, value)
  }

  /**
   * 清除快取
   */
  invalidate(key?: string): void {
    if (key) {
      this.cache.delete(key)
    } else {
      this.cache.clear()
    }
    this.lastRefresh = new Date(0)
  }

  /**
   * 檢查是否需要刷新
   */
  private shouldRefresh(): boolean {
    return Date.now() - this.lastRefresh.getTime() > this.refreshInterval
  }

  /**
   * 刷新所有快取
   */
  private async refresh(): Promise<void> {
    this.isRefreshing = true
    try {
      const configs = await prisma.systemConfig.findMany({
        where: { isActive: true },
      })
      this.cache.clear()

      for (const config of configs) {
        const value = decryptIfNeeded(config.value, config.isEncrypted)
        this.cache.set(config.key, parseConfigValue(value, config.valueType))
      }

      this.lastRefresh = new Date()
    } finally {
      this.isRefreshing = false
    }
  }

  /**
   * 取得所有快取的鍵
   */
  keys(): string[] {
    return Array.from(this.cache.keys())
  }

  /**
   * 取得快取大小
   */
  size(): number {
    return this.cache.size
  }
}

// 單例快取實例
const configCache = new ConfigCache()

// ============================================================
// Encryption Utilities
// ============================================================

/**
 * 取得系統配置加密金鑰（FIX-070）
 *
 * @description
 *   對齊 repo 既有 encryption 基線（`src/lib/encryption.ts`、
 *   `src/services/encryption.service.ts`）：缺金鑰或長度不足即 fail-closed，
 *   絕不使用不安全的硬編碼預設 fallback。
 *
 *   未設定時不再靜默以公開已知金鑰加密（等同無加密），而是明確拋錯，
 *   使「嘗試寫入敏感配置但未配置金鑰」的情況立即失敗而非靜默降級。
 *
 * @returns 環境變數 CONFIG_ENCRYPTION_KEY 的值
 * @throws SystemConfigError 當金鑰未設定（MISSING_ENCRYPTION_KEY）或長度不足（INVALID_ENCRYPTION_KEY）
 */
function getConfigEncryptionKey(): string {
  const key = process.env.CONFIG_ENCRYPTION_KEY
  if (!key) {
    throw new SystemConfigError(
      'CONFIG_ENCRYPTION_KEY environment variable is not set. Configure it before storing or reading encrypted system configuration values.',
      'MISSING_ENCRYPTION_KEY'
    )
  }
  if (key.length < 32) {
    throw new SystemConfigError(
      'CONFIG_ENCRYPTION_KEY must be at least 32 characters long.',
      'INVALID_ENCRYPTION_KEY'
    )
  }
  return key
}

/**
 * 使用 scrypt 衍生加密金鑰
 * @param salt 派生鹽（新密文使用隨機鹽；舊密文相容路徑使用 LEGACY_ENCRYPTION_SALT）
 */
function deriveKey(salt: string | Buffer): Buffer {
  return scryptSync(getConfigEncryptionKey(), salt, 32)
}

/**
 * 加密值
 * @param value 原始值
 * @returns 加密後的字串（格式：Salt:IV:AuthTag:EncryptedData，皆為 hex）
 * @remarks FIX-070：每次加密產生隨機鹽並隨密文儲存，取代既往的全域靜態鹽。
 */
function encryptValue(value: string): string {
  const salt = randomBytes(SALT_LENGTH)
  const key = deriveKey(salt)
  const iv = randomBytes(16)
  const cipher = createCipheriv(ENCRYPTION_ALGORITHM, key, iv)

  let encrypted = cipher.update(value, 'utf8', 'hex')
  encrypted += cipher.final('hex')
  const authTag = cipher.getAuthTag()

  return `${salt.toString('hex')}:${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`
}

/**
 * 解密值
 * @param encrypted 加密的字串
 * @returns 解密後的原始值
 * @remarks
 *   FIX-070 向後相容：同時支援兩種密文格式
 *   - 新格式 Salt:IV:AuthTag:Data（4 段）— 以隨密文儲存的隨機鹽派生金鑰
 *   - 舊格式 IV:AuthTag:Data（3 段）— 以 LEGACY_ENCRYPTION_SALT 派生金鑰
 *   舊密文一旦經由更新流程重新寫入，即自動升級為新隨機鹽格式。
 */
function decryptValue(encrypted: string): string {
  const parts = encrypted.split(':')

  let saltForKey: string | Buffer
  let ivHex: string
  let authTagHex: string
  let data: string

  if (parts.length === 4) {
    // 新格式：Salt:IV:AuthTag:Data
    ;[, ivHex, authTagHex, data] = parts
    saltForKey = Buffer.from(parts[0], 'hex')
  } else if (parts.length === 3) {
    // 舊格式：IV:AuthTag:Data（FIX-070 前，固定靜態鹽）
    ;[ivHex, authTagHex, data] = parts
    saltForKey = LEGACY_ENCRYPTION_SALT
  } else {
    throw new Error('Invalid encrypted value format')
  }

  if (!ivHex || !authTagHex || !data) {
    throw new Error('Invalid encrypted value format')
  }

  const key = deriveKey(saltForKey)
  const iv = Buffer.from(ivHex, 'hex')
  const authTag = Buffer.from(authTagHex, 'hex')

  const decipher = createDecipheriv(ENCRYPTION_ALGORITHM, key, iv)
  decipher.setAuthTag(authTag)

  let decrypted = decipher.update(data, 'hex', 'utf8')
  decrypted += decipher.final('utf8')

  return decrypted
}

/**
 * 若需要則解密值
 */
function decryptIfNeeded(value: string, isEncrypted: boolean): string {
  if (isEncrypted && value) {
    try {
      return decryptValue(value)
    } catch {
      console.error('Failed to decrypt config value')
      return value
    }
  }
  return value
}

/**
 * 解析配置值為對應的 JavaScript 型別
 */
function parseConfigValue(value: string | null, valueType: ConfigValueType): unknown {
  if (value === null || value === undefined || value === '') {
    return null
  }

  switch (valueType) {
    case 'NUMBER':
      return parseFloat(value)
    case 'BOOLEAN':
      return value === 'true' || value === '1'
    case 'JSON':
      try {
        return JSON.parse(value)
      } catch {
        return null
      }
    default:
      return value
  }
}

/**
 * 將值序列化為字串以儲存
 */
function stringifyConfigValue(value: unknown, valueType: ConfigValueType): string {
  if (value === null || value === undefined) {
    return ''
  }

  switch (valueType) {
    case 'NUMBER':
    case 'BOOLEAN':
      return String(value)
    case 'JSON':
      return JSON.stringify(value)
    default:
      return String(value)
  }
}

/**
 * 遮罩敏感值
 */
function maskSensitiveValue(value: string, showLength: number = 4): string {
  if (!value || value.length <= showLength) {
    return '••••••••'
  }
  return '••••••••' + value.slice(-showLength)
}

// ============================================================
// Service Class
// ============================================================

/**
 * 系統配置管理服務
 *
 * @description
 *   提供系統配置的完整管理功能，包括版本控制、加密和回滾機制。
 *   所有變更都會記錄到歷史表和審計日誌中。
 *
 * @example
 * ```typescript
 * // 獲取配置值（使用快取）
 * const threshold = await SystemConfigService.getValue<number>(
 *   'processing.confidence_threshold',
 *   0.7
 * )
 *
 * // 更新配置
 * await SystemConfigService.updateConfig(
 *   'processing.confidence_threshold',
 *   { value: 0.8, changeReason: 'Improve accuracy' },
 *   'user-id'
 * )
 *
 * // 回滾配置
 * await SystemConfigService.rollbackConfig(
 *   'processing.confidence_threshold',
 *   'history-id',
 *   'admin-id'
 * )
 * ```
 */
export class SystemConfigService {
  // ============================================================
  // Story 12-4: New Methods
  // ============================================================

  /**
   * 取得配置列表（依類別分組）
   */
  static async listConfigs(options: ConfigListOptions = {}): Promise<GroupedConfigs> {
    const { category, search, includeReadOnly = true } = options

    const where: Prisma.SystemConfigWhereInput = {
      isActive: true,
    }

    if (category) {
      where.category = category
    }

    if (!includeReadOnly) {
      where.isReadOnly = false
    }

    if (search) {
      where.OR = [
        { key: { contains: search, mode: 'insensitive' } },
        { name: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
      ]
    }

    const configs = await prisma.systemConfig.findMany({
      where,
      orderBy: [{ category: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
      include: {
        updater: {
          select: { id: true, name: true },
        },
      },
    })

    // 初始化分組結構
    const grouped: GroupedConfigs = {
      PROCESSING: [],
      INTEGRATION: [],
      SECURITY: [],
      NOTIFICATION: [],
      SYSTEM: [],
      DISPLAY: [],
      AI_MODEL: [],
      THRESHOLD: [],
    }

    for (const config of configs) {
      const decryptedValue = decryptIfNeeded(config.value, config.isEncrypted)
      const parsedValue = parseConfigValue(decryptedValue, config.valueType)
      const defaultValue = parseConfigValue(config.defaultValue, config.valueType)

      const configValue: ConfigValue = {
        key: config.key,
        // 敏感值以遮罩方式顯示
        value: config.isEncrypted ? maskSensitiveValue(decryptedValue) : parsedValue,
        name: config.name,
        description: config.description,
        category: config.category,
        valueType: config.valueType,
        effectType: config.effectType,
        defaultValue,
        validation: config.validation as ConfigValidation | undefined,
        impactNote: config.impactNote || undefined,
        isEncrypted: config.isEncrypted,
        isReadOnly: config.isReadOnly,
        isModified: config.value !== config.defaultValue,
        updatedAt: config.updatedAt,
        updatedBy: config.updater?.name || undefined,
      }

      if (grouped[config.category]) {
        grouped[config.category].push(configValue)
      }
    }

    return grouped
  }

  /**
   * 取得單一配置值（完整資訊）
   */
  static async getConfigByKey(key: string): Promise<ConfigValue | null> {
    const config = await prisma.systemConfig.findUnique({
      where: { key },
      include: {
        updater: {
          select: { id: true, name: true },
        },
      },
    })

    if (!config) return null

    const decryptedValue = decryptIfNeeded(config.value, config.isEncrypted)
    const parsedValue = parseConfigValue(decryptedValue, config.valueType)
    const defaultValue = parseConfigValue(config.defaultValue, config.valueType)

    return {
      key: config.key,
      value: parsedValue,
      name: config.name,
      description: config.description,
      category: config.category,
      valueType: config.valueType,
      effectType: config.effectType,
      defaultValue,
      validation: config.validation as ConfigValidation | undefined,
      impactNote: config.impactNote || undefined,
      isEncrypted: config.isEncrypted,
      isReadOnly: config.isReadOnly,
      isModified: config.value !== config.defaultValue,
      updatedAt: config.updatedAt,
      updatedBy: config.updater?.name || undefined,
    }
  }

  /**
   * 取得配置值（用於運行時，使用快取）
   */
  static async getValue<T>(key: string, defaultValue?: T): Promise<T> {
    // 先檢查快取
    const cached = await configCache.get(key)
    if (cached !== undefined) {
      return cached as T
    }

    // 從資料庫載入
    const config = await this.getConfigByKey(key)
    if (config) {
      configCache.set(key, config.value)
      return config.value as T
    }

    return defaultValue as T
  }

  /**
   * 更新配置值
   */
  static async updateConfig(
    key: string,
    input: ConfigUpdateInput,
    userId: string
  ): Promise<ConfigUpdateResult> {
    const config = await prisma.systemConfig.findUnique({
      where: { key },
    })

    if (!config) {
      return { success: false, requiresRestart: false, error: '配置不存在' }
    }

    if (config.isReadOnly) {
      return { success: false, requiresRestart: false, error: '此配置為唯讀，無法修改' }
    }

    // 驗證值
    const validation = config.validation as ConfigValidation | null
    const validationError = this.validateValue(input.value, config.valueType, validation)
    if (validationError) {
      return { success: false, requiresRestart: false, error: validationError }
    }

    // 序列化值
    let newValue = stringifyConfigValue(input.value, config.valueType)

    // 加密敏感值
    if (config.isEncrypted) {
      newValue = encryptValue(newValue)
    }

    const previousValue = config.value

    // 使用交易確保一致性
    await prisma.$transaction([
      // 更新配置
      prisma.systemConfig.update({
        where: { key },
        data: {
          value: newValue,
          version: { increment: 1 },
          updatedBy: userId,
        },
      }),
      // 記錄歷史（敏感值以遮罩顯示）
      prisma.configHistory.create({
        data: {
          configId: config.id,
          version: config.version + 1,
          previousValue: config.isEncrypted
            ? maskSensitiveValue(decryptIfNeeded(previousValue, true))
            : previousValue,
          newValue: config.isEncrypted
            ? maskSensitiveValue(stringifyConfigValue(input.value, config.valueType))
            : newValue,
          changedBy: userId,
          changeReason: input.changeReason,
        },
      }),
    ])

    // 清除快取
    configCache.invalidate(key)

    // 記錄審計日誌
    await this.logConfigChange(key, config.name, userId, 'CONFIG_UPDATE')

    // 發送配置變更事件
    configEvents.emit('config:updated', { key, effectType: config.effectType })

    return {
      success: true,
      requiresRestart: config.effectType === 'RESTART_REQUIRED',
    }
  }

  /**
   * 回滾配置到特定版本
   */
  static async rollbackConfig(
    key: string,
    historyId: string,
    userId: string,
    reason?: string
  ): Promise<{ success: boolean; requiresRestart?: boolean; error?: string }> {
    const config = await prisma.systemConfig.findUnique({
      where: { key },
    })

    if (!config) {
      return { success: false, error: '配置不存在' }
    }

    if (config.isReadOnly) {
      return { success: false, error: '此配置為唯讀，無法回滾' }
    }

    const historyRecord = await prisma.configHistory.findUnique({
      where: { id: historyId },
    })

    if (!historyRecord || historyRecord.configId !== config.id) {
      return { success: false, error: '歷史記錄不存在或不屬於此配置' }
    }

    // 執行回滾
    await prisma.$transaction([
      prisma.systemConfig.update({
        where: { key },
        data: {
          value: historyRecord.previousValue,
          version: { increment: 1 },
          updatedBy: userId,
        },
      }),
      prisma.configHistory.create({
        data: {
          configId: config.id,
          version: config.version + 1,
          previousValue: config.value,
          newValue: historyRecord.previousValue,
          changedBy: userId,
          changeReason: reason || `回滾至 ${historyRecord.createdAt.toISOString()} 的版本`,
          isRollback: true,
          rollbackFrom: historyId,
        },
      }),
    ])

    // 清除快取
    configCache.invalidate(key)

    // 記錄審計日誌
    await this.logConfigChange(key, config.name, userId, 'CONFIG_ROLLBACK')

    // 發送配置變更事件
    configEvents.emit('config:rolledback', { key, historyId })

    return {
      success: true,
      requiresRestart: config.effectType === 'RESTART_REQUIRED',
    }
  }

  /**
   * 取得配置變更歷史
   */
  static async getConfigHistory(
    key: string,
    options: ConfigHistoryOptions = {}
  ): Promise<ConfigHistoryResult> {
    const { limit = 20, offset = 0 } = options

    const config = await prisma.systemConfig.findUnique({
      where: { key },
    })

    if (!config) {
      return { history: [], total: 0 }
    }

    const [history, total] = await Promise.all([
      prisma.configHistory.findMany({
        where: { configId: config.id },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
        include: {
          changer: {
            select: { id: true, name: true },
          },
        },
      }),
      prisma.configHistory.count({
        where: { configId: config.id },
      }),
    ])

    return {
      history: history.map((h): ConfigHistoryItem => ({
        id: h.id,
        previousValue: h.previousValue,
        newValue: h.newValue,
        changedAt: h.createdAt,
        changedBy: h.changedBy,
        changedByName: h.changer?.name || undefined,
        changeReason: h.changeReason || undefined,
        isRollback: h.isRollback,
      })),
      total,
    }
  }

  /**
   * 重置配置為預設值
   */
  static async resetToDefault(
    key: string,
    userId: string,
    reason?: string
  ): Promise<{ success: boolean; requiresRestart?: boolean; error?: string }> {
    const config = await prisma.systemConfig.findUnique({
      where: { key },
    })

    if (!config) {
      return { success: false, error: '配置不存在' }
    }

    if (config.isReadOnly) {
      return { success: false, error: '此配置為唯讀，無法重置' }
    }

    // 如果已是預設值則直接返回成功
    if (config.value === config.defaultValue) {
      return { success: true, requiresRestart: false }
    }

    let defaultValue = config.defaultValue || ''
    if (config.isEncrypted && defaultValue) {
      defaultValue = encryptValue(defaultValue)
    }

    await prisma.$transaction([
      prisma.systemConfig.update({
        where: { key },
        data: {
          value: defaultValue,
          version: { increment: 1 },
          updatedBy: userId,
        },
      }),
      prisma.configHistory.create({
        data: {
          configId: config.id,
          version: config.version + 1,
          previousValue: config.isEncrypted
            ? maskSensitiveValue(decryptIfNeeded(config.value, true))
            : config.value,
          newValue: config.isEncrypted
            ? maskSensitiveValue(config.defaultValue || '')
            : config.defaultValue || '',
          changedBy: userId,
          changeReason: reason || '重置為預設值',
        },
      }),
    ])

    // 清除快取
    configCache.invalidate(key)

    // 記錄審計日誌
    await this.logConfigChange(key, config.name, userId, 'CONFIG_RESET')

    // 發送配置變更事件
    configEvents.emit('config:reset', { key, effectType: config.effectType })

    return {
      success: true,
      requiresRestart: config.effectType === 'RESTART_REQUIRED',
    }
  }

  /**
   * 驗證配置值
   */
  private static validateValue(
    value: unknown,
    valueType: ConfigValueType,
    validation?: ConfigValidation | null
  ): string | null {
    // 必填驗證
    if (validation?.required && (value === null || value === undefined || value === '')) {
      return '此配置為必填'
    }

    // 空值允許（若非必填）
    if (value === null || value === undefined || value === '') {
      return null
    }

    // 數值類型驗證
    if (valueType === 'NUMBER') {
      const numValue = Number(value)
      if (isNaN(numValue)) {
        return '必須為有效數值'
      }
      if (validation?.min !== undefined && numValue < validation.min) {
        return `最小值為 ${validation.min}`
      }
      if (validation?.max !== undefined && numValue > validation.max) {
        return `最大值為 ${validation.max}`
      }
    }

    // 字串類型驗證
    if (valueType === 'STRING' || valueType === 'SECRET') {
      const strValue = String(value)
      if (validation?.minLength !== undefined && strValue.length < validation.minLength) {
        return `最小長度為 ${validation.minLength}`
      }
      if (validation?.maxLength !== undefined && strValue.length > validation.maxLength) {
        return `最大長度為 ${validation.maxLength}`
      }
      if (validation?.pattern) {
        const regex = new RegExp(validation.pattern)
        if (!regex.test(strValue)) {
          return '格式不正確'
        }
      }
    }

    // 列舉類型驗證
    if (valueType === 'ENUM' || validation?.options) {
      if (validation?.options && !validation.options.includes(String(value))) {
        return `必須是以下選項之一: ${validation.options.join(', ')}`
      }
    }

    // JSON 類型驗證
    if (valueType === 'JSON' && typeof value === 'string') {
      try {
        JSON.parse(value)
      } catch {
        return 'JSON 格式不正確'
      }
    }

    return null
  }

  /**
   * 記錄配置變更至審計日誌
   */
  private static async logConfigChange(
    key: string,
    name: string,
    userId: string,
    action: string
  ): Promise<void> {
    const actionText =
      action === 'CONFIG_UPDATE'
        ? '更新'
        : action === 'CONFIG_ROLLBACK'
          ? '回滾'
          : '重置'

    await prisma.auditLog.create({
      data: {
        userId,
        userName: 'System',
        action: 'CONFIGURE',
        resourceType: 'SystemConfig',
        resourceId: key,
        resourceName: name,
        description: `${actionText}系統配置: ${name}`,
        status: 'SUCCESS',
      },
    })
  }

  /**
   * 重新載入所有配置（熱載入）
   */
  static async reloadAllConfigs(): Promise<void> {
    configCache.invalidate()
    configEvents.emit('config:reloaded')
  }

  /**
   * 匯出所有配置（排除敏感值）
   */
  static async exportConfigs(userId: string): Promise<Record<string, unknown>> {
    const configs = await prisma.systemConfig.findMany({
      where: { isEncrypted: false, isActive: true },
    })

    const exported: Record<string, unknown> = {}
    for (const config of configs) {
      exported[config.key] = parseConfigValue(config.value, config.valueType)
    }

    // 記錄審計日誌
    await prisma.auditLog.create({
      data: {
        userId,
        userName: 'System',
        action: 'EXPORT',
        resourceType: 'SystemConfig',
        resourceId: 'all',
        resourceName: 'System Configurations',
        description: '匯出系統配置',
        status: 'SUCCESS',
      },
    })

    return exported
  }

  /**
   * 批量匯入配置
   */
  static async importConfigs(
    configs: Record<string, unknown>,
    userId: string
  ): Promise<ConfigImportResult> {
    let imported = 0
    let skipped = 0
    const errors: string[] = []

    for (const [key, value] of Object.entries(configs)) {
      const existingConfig = await prisma.systemConfig.findUnique({
        where: { key },
      })

      if (!existingConfig) {
        skipped++
        continue
      }

      if (existingConfig.isEncrypted || existingConfig.isReadOnly) {
        skipped++
        continue
      }

      const result = await this.updateConfig(
        key,
        { value, changeReason: '批量匯入' },
        userId
      )

      if (result.success) {
        imported++
      } else {
        errors.push(`${key}: ${result.error}`)
      }
    }

    return { imported, skipped, errors }
  }

  // ============================================================
  // Legacy Methods (Story 6.4 - 保持向後相容)
  // ============================================================

  /**
   * 根據鍵獲取配置 (Legacy)
   */
  static async get<T = LegacyConfigValue>(key: string): Promise<T | null> {
    const config = await prisma.systemConfig.findFirst({
      where: { key, isActive: true },
    })

    if (!config) return null

    // 處理 Story 12-4 的新格式
    const value = parseConfigValue(
      decryptIfNeeded(config.value, config.isEncrypted),
      config.valueType
    )

    return value as T | null
  }

  /**
   * 根據鍵獲取完整配置資訊 (Legacy)
   */
  static async getByKey(key: string): Promise<ConfigInfo | null> {
    const config = await prisma.systemConfig.findFirst({
      where: { key },
    })

    if (!config) return null

    const value = parseConfigValue(
      decryptIfNeeded(config.value, config.isEncrypted),
      config.valueType
    )

    return {
      key: config.key,
      value: typeof value === 'object' ? (value as LegacyConfigValue) : { value },
      description: config.description,
      category: config.category,
      scope: config.scope,
      cityCode: config.cityCode,
      version: config.version,
      isActive: config.isActive,
      updatedAt: config.updatedAt,
      updatedBy: config.updatedBy,
    }
  }

  /**
   * 根據類別獲取配置列表 (Legacy)
   */
  static async getByCategory(category: ConfigCategory): Promise<ConfigInfo[]> {
    const configs = await prisma.systemConfig.findMany({
      where: { category, isActive: true },
      orderBy: { key: 'asc' },
    })

    return configs.map((c) => {
      const value = parseConfigValue(
        decryptIfNeeded(c.value, c.isEncrypted),
        c.valueType
      )
      return {
        key: c.key,
        value: typeof value === 'object' ? (value as LegacyConfigValue) : { value },
        description: c.description,
        category: c.category,
        scope: c.scope,
        cityCode: c.cityCode,
        version: c.version,
        isActive: c.isActive,
        updatedAt: c.updatedAt,
        updatedBy: c.updatedBy,
      }
    })
  }

  /**
   * 根據範圍獲取配置列表 (Legacy)
   */
  static async getByScope(
    scope: ConfigScope,
    cityCode?: string
  ): Promise<ConfigInfo[]> {
    const whereClause: Prisma.SystemConfigWhereInput = {
      scope,
      isActive: true,
    }

    if (scope === 'CITY' && cityCode) {
      whereClause.cityCode = cityCode
    }

    const configs = await prisma.systemConfig.findMany({
      where: whereClause,
      orderBy: { key: 'asc' },
    })

    return configs.map((c) => {
      const value = parseConfigValue(
        decryptIfNeeded(c.value, c.isEncrypted),
        c.valueType
      )
      return {
        key: c.key,
        value: typeof value === 'object' ? (value as LegacyConfigValue) : { value },
        description: c.description,
        category: c.category,
        scope: c.scope,
        cityCode: c.cityCode,
        version: c.version,
        isActive: c.isActive,
        updatedAt: c.updatedAt,
        updatedBy: c.updatedBy,
      }
    })
  }

  /**
   * 獲取所有配置 (Legacy)
   */
  static async getAll(includeInactive = false): Promise<ConfigInfo[]> {
    const whereClause: Prisma.SystemConfigWhereInput = includeInactive
      ? {}
      : { isActive: true }

    const configs = await prisma.systemConfig.findMany({
      where: whereClause,
      orderBy: [{ category: 'asc' }, { key: 'asc' }],
    })

    return configs.map((c) => {
      const value = parseConfigValue(
        decryptIfNeeded(c.value, c.isEncrypted),
        c.valueType
      )
      return {
        key: c.key,
        value: typeof value === 'object' ? (value as LegacyConfigValue) : { value },
        description: c.description,
        category: c.category,
        scope: c.scope,
        cityCode: c.cityCode,
        version: c.version,
        isActive: c.isActive,
        updatedAt: c.updatedAt,
        updatedBy: c.updatedBy,
      }
    })
  }

  /**
   * 建立新配置 (Legacy)
   */
  static async create(params: CreateConfigParams): Promise<void> {
    const {
      key,
      value,
      description,
      category,
      scope = 'GLOBAL',
      cityCode,
      createdBy,
    } = params

    // 檢查配置鍵是否已存在
    const existing = await prisma.systemConfig.findFirst({
      where: { key },
    })

    if (existing) {
      throw new SystemConfigError(
        `Configuration key already exists: ${key}`,
        'DUPLICATE_KEY',
        { key }
      )
    }

    // 驗證城市範圍配置必須有城市代碼
    if (scope === 'CITY' && !cityCode) {
      throw new SystemConfigError(
        'City code is required for CITY scope configuration',
        'MISSING_CITY_CODE',
        { key, scope }
      )
    }

    await prisma.$transaction(async (tx) => {
      // 建立配置
      const config = await tx.systemConfig.create({
        data: {
          key,
          value: JSON.stringify(value),
          name: key,
          description: description || '',
          category,
          valueType: 'JSON',
          scope,
          cityCode,
          updatedBy: createdBy,
        },
      })

      // 記錄審計日誌
      await tx.auditLog.create({
        data: {
          userId: createdBy,
          userName: 'System',
          action: 'CREATE',
          resourceType: 'system-config',
          resourceId: config.id,
          resourceName: key,
          description: `Created system configuration: ${key}`,
          metadata: {
            key,
            category,
            scope,
            cityCode,
          },
          status: 'SUCCESS',
        },
      })
    })
  }

  /**
   * 更新配置 (Legacy)
   */
  static async update(params: UpdateConfigParams): Promise<void> {
    const { key, value, updatedBy, changeReason } = params

    await prisma.$transaction(async (tx) => {
      // 獲取當前配置
      const current = await tx.systemConfig.findFirst({
        where: { key },
      })

      if (!current) {
        throw new SystemConfigError(
          `Configuration not found: ${key}`,
          'CONFIG_NOT_FOUND',
          { key }
        )
      }

      const newValueStr = JSON.stringify(value)

      // 儲存到歷史
      await tx.configHistory.create({
        data: {
          configId: current.id,
          version: current.version,
          previousValue: current.value,
          newValue: newValueStr,
          changedBy: updatedBy,
          changeReason,
        },
      })

      // 更新配置
      await tx.systemConfig.update({
        where: { id: current.id },
        data: {
          value: newValueStr,
          version: { increment: 1 },
          updatedBy,
        },
      })

      // 記錄審計日誌
      await tx.auditLog.create({
        data: {
          userId: updatedBy,
          userName: 'System',
          action: 'UPDATE',
          resourceType: 'system-config',
          resourceId: current.id,
          resourceName: key,
          description: `Updated system configuration: ${key}`,
          metadata: {
            key,
            previousVersion: current.version,
            newVersion: current.version + 1,
            changeReason,
          },
          status: 'SUCCESS',
        },
      })
    })

    // 清除快取
    configCache.invalidate(key)
  }

  /**
   * 切換配置啟用狀態 (Legacy)
   */
  static async setActive(
    key: string,
    isActive: boolean,
    updatedBy: string
  ): Promise<void> {
    const config = await prisma.systemConfig.findFirst({
      where: { key },
    })

    if (!config) {
      throw new SystemConfigError(
        `Configuration not found: ${key}`,
        'CONFIG_NOT_FOUND',
        { key }
      )
    }

    await prisma.$transaction(async (tx) => {
      await tx.systemConfig.update({
        where: { id: config.id },
        data: { isActive, updatedBy },
      })

      await tx.auditLog.create({
        data: {
          userId: updatedBy,
          userName: 'System',
          action: 'CONFIGURE',
          resourceType: 'system-config',
          resourceId: config.id,
          resourceName: key,
          description: `${isActive ? 'Enabled' : 'Disabled'} system configuration: ${key}`,
          metadata: { key, isActive },
          status: 'SUCCESS',
        },
      })
    })

    // 清除快取
    configCache.invalidate(key)
  }

  /**
   * 獲取配置歷史 (Legacy)
   */
  static async getHistory(key: string): Promise<ConfigHistoryInfo[]> {
    const config = await prisma.systemConfig.findFirst({
      where: { key },
      select: { id: true },
    })

    if (!config) return []

    const history = await prisma.configHistory.findMany({
      where: { configId: config.id },
      include: {
        changer: {
          select: { id: true, name: true, email: true },
        },
      },
      orderBy: { version: 'desc' },
    })

    return history.map((h) => ({
      version: h.version,
      previousValue: typeof h.previousValue === 'string'
        ? JSON.parse(h.previousValue)
        : h.previousValue as LegacyConfigValue,
      newValue: typeof h.newValue === 'string'
        ? JSON.parse(h.newValue)
        : h.newValue as LegacyConfigValue,
      changedBy: h.changer,
      changeReason: h.changeReason,
      createdAt: h.createdAt,
    }))
  }

  /**
   * 回滾配置到指定版本 (Legacy)
   */
  static async rollback(params: RollbackConfigParams): Promise<void> {
    const { key, targetVersion, rolledBackBy, reason } = params

    await prisma.$transaction(async (tx) => {
      // 獲取當前配置
      const config = await tx.systemConfig.findFirst({
        where: { key },
      })

      if (!config) {
        throw new SystemConfigError(
          `Configuration not found: ${key}`,
          'CONFIG_NOT_FOUND',
          { key }
        )
      }

      // 獲取目標版本的歷史記錄
      const targetHistory = await tx.configHistory.findFirst({
        where: {
          configId: config.id,
          version: targetVersion,
        },
      })

      if (!targetHistory) {
        throw new SystemConfigError(
          `Version ${targetVersion} not found for ${key}`,
          'VERSION_NOT_FOUND',
          { key, targetVersion }
        )
      }

      // 要恢復的值是目標歷史記錄的 previousValue
      const restoreValue = targetHistory.previousValue

      // 先將當前值儲存到歷史
      await tx.configHistory.create({
        data: {
          configId: config.id,
          version: config.version,
          previousValue: config.value,
          newValue: restoreValue as string,
          changedBy: rolledBackBy,
          changeReason: `Rollback to version ${targetVersion}: ${reason}`,
          isRollback: true,
        },
      })

      // 更新配置
      await tx.systemConfig.update({
        where: { id: config.id },
        data: {
          value: restoreValue as string,
          version: { increment: 1 },
          updatedBy: rolledBackBy,
        },
      })

      // 記錄審計日誌
      await tx.auditLog.create({
        data: {
          userId: rolledBackBy,
          userName: 'System',
          action: 'UPDATE',
          resourceType: 'system-config',
          resourceId: config.id,
          resourceName: key,
          description: `Rolled back system configuration: ${key} to version ${targetVersion}`,
          metadata: {
            key,
            targetVersion,
            reason,
            newVersion: config.version + 1,
            rollback: true,
          },
          status: 'SUCCESS',
        },
      })
    })

    // 清除快取
    configCache.invalidate(key)
  }

  /**
   * 刪除配置 (Legacy)
   */
  static async delete(key: string, deletedBy: string): Promise<void> {
    const config = await prisma.systemConfig.findFirst({
      where: { key },
    })

    if (!config) {
      throw new SystemConfigError(
        `Configuration not found: ${key}`,
        'CONFIG_NOT_FOUND',
        { key }
      )
    }

    await prisma.$transaction(async (tx) => {
      // 記錄審計日誌（在刪除前）
      await tx.auditLog.create({
        data: {
          userId: deletedBy,
          userName: 'System',
          action: 'DELETE',
          resourceType: 'system-config',
          resourceId: config.id,
          resourceName: key,
          description: `Deleted system configuration: ${key}`,
          metadata: {
            key,
            category: config.category,
            scope: config.scope,
            lastValue: config.value,
          },
          status: 'SUCCESS',
        },
      })

      // 刪除配置（會級聯刪除歷史）
      await tx.systemConfig.delete({
        where: { id: config.id },
      })
    })

    // 清除快取
    configCache.invalidate(key)
  }
}
