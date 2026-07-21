/**
 * @fileoverview 公司合併時的「處理知識類」關聯轉移（FIX-125）
 * @description
 *   公司合併原本只轉移 documents / extractionResults / mappingRules 三類，其餘留在
 *   已設為 MERGED 的副公司名下。`autoMergeCompanies` 中有明確註解記錄該決定，假設
 *   「副公司設 MERGED 後 inert（惰性、無作用）」。
 *
 *   FIX-125 推翻該假設：**它對 documents 成立，對「公司處理知識」不成立**。
 *   格式定義、欄位定義集、模板映射、Prompt 配置等代表的是「這間公司的文件該怎麼處理」
 *   這項知識。合併後存活公司**仍會收到同樣的文件**，但處理所需的定義卻被留在一個
 *   永遠不會被查詢的公司身上 —— 它不是 inert，而是遺失。
 *
 *   實證（Azure DEV 2026-07-20）：CEVA 8 筆公司記錄中 7 筆已 MERGED，8 個格式散落在
 *   8 間公司身上，存活公司名下只有 1 個 → FIX-115 注入 ${knownFormats} 後完全沒有效果，
 *   因為清單永遠只有一個選項。
 *
 *   本模組轉移 6 類「處理知識」，歷史性質的關聯（issuedDocuments、correctionHistories、
 *   identifiedHistoricalFiles、transactionParticipations 等）**刻意留在原地** ——
 *   它們記錄「當時是哪間公司」，轉走會扭曲審計事實。
 *
 * @module src/services/company-merge-transfer.service
 * @since FIX-125
 * @lastModified 2026-07-21
 *
 * @features
 *   - 🔴 唯一鍵守門：每一類的唯一鍵都含 companyId，逐筆檢查目標是否已存在相同組合，
 *     撞鍵則**跳過並記錄**，絕不猜測改值（與 FIX-120 / FIX-124 的處置原則一致）
 *   - 配置跟隨格式：FORMAT scope 的配置若其 documentFormat 未能轉移，該配置一併跳過，
 *     避免配置轉到新公司卻指向留在舊公司的格式
 *   - 回傳完整報告供呼叫端記錄警告與人工收尾
 *
 * @dependencies
 *   - Prisma.TransactionClient - 必須在呼叫端的交易內執行
 *
 * @related
 *   - src/services/company.service.ts - mergeCompanies / confirmCompanyMerge
 *   - src/services/company-auto-create.service.ts - autoMergeCompanies
 */

import type { Prisma } from '@prisma/client'

/** 因唯一鍵衝突或依附格式未轉移而跳過的記錄 */
export interface MergeTransferSkip {
  /** 關聯名稱（如 documentFormats） */
  relation: string
  /** 被跳過的記錄 id */
  recordId: string
  /** 人可讀的識別（格式名稱、scope 等），供人工收尾時定位 */
  label: string
  /** 跳過原因 */
  reason: string
}

/** 轉移結果報告 */
export interface MergeTransferReport {
  /** 各關聯實際轉移筆數 */
  transferred: Record<string, number>
  /** 未轉移的記錄，需人工處理 */
  skipped: MergeTransferSkip[]
}

/**
 * 轉移「公司處理知識」類關聯至存活公司
 *
 * @param tx - Prisma 交易客戶端（必須由呼叫端在交易內提供）
 * @param sourceIds - 來源（副）公司 ID 列表
 * @param targetId - 目標（存活）公司 ID
 * @returns 轉移報告：各類轉移筆數 + 因衝突跳過的記錄
 */
export async function transferCompanyKnowledge(
  tx: Prisma.TransactionClient,
  sourceIds: string[],
  targetId: string
): Promise<MergeTransferReport> {
  const transferred: Record<string, number> = {}
  const skipped: MergeTransferSkip[] = []

  if (sourceIds.length === 0) {
    return { transferred, skipped }
  }

  // ==========================================================================
  // 1. documentFormats —— 唯一鍵 (companyId, documentType, documentSubtype)
  //    三個欄位皆 non-null，同 type/subtype 必然撞鍵。實測撞鍵率高
  //    （本地 3 筆孤立格式全為 INVOICE/GENERAL，轉入同一目標時 2 筆會撞）。
  // ==========================================================================
  const skippedFormatIds = new Set<string>()
  const formats = await tx.documentFormat.findMany({
    where: { companyId: { in: sourceIds } },
    select: { id: true, name: true, documentType: true, documentSubtype: true },
  })

  let formatCount = 0
  for (const format of formats) {
    const clash = await tx.documentFormat.findFirst({
      where: {
        companyId: targetId,
        documentType: format.documentType,
        documentSubtype: format.documentSubtype,
      },
      select: { id: true, name: true },
    })

    if (clash) {
      skippedFormatIds.add(format.id)
      skipped.push({
        relation: 'documentFormats',
        recordId: format.id,
        label: format.name ?? '(未命名格式)',
        reason:
          `目標公司已有 ${format.documentType}/${format.documentSubtype} 的格式` +
          `「${clash.name ?? clash.id}」；需人工判定版面後改用其他 documentSubtype`,
      })
      continue
    }

    await tx.documentFormat.update({
      where: { id: format.id },
      data: { companyId: targetId },
    })
    formatCount++
  }
  transferred.documentFormats = formatCount

  /** FORMAT scope 的配置若其格式未轉移，配置也不該轉（否則指向留在舊公司的格式） */
  const formatUnavailable = (documentFormatId: string | null): boolean =>
    documentFormatId !== null && skippedFormatIds.has(documentFormatId)

  // ==========================================================================
  // 2. fieldDefinitionSets —— 唯一鍵 (scope, companyId, documentFormatId)
  // ==========================================================================
  const fieldDefinitionSets = await tx.fieldDefinitionSet.findMany({
    where: { companyId: { in: sourceIds } },
    select: { id: true, name: true, scope: true, documentFormatId: true },
  })

  let fdsCount = 0
  for (const fds of fieldDefinitionSets) {
    if (formatUnavailable(fds.documentFormatId)) {
      skipped.push({
        relation: 'fieldDefinitionSets',
        recordId: fds.id,
        label: fds.name,
        reason: '其所屬 documentFormat 因唯一鍵衝突未能轉移，配置一併保留在原公司',
      })
      continue
    }

    const clash = await tx.fieldDefinitionSet.findFirst({
      where: {
        companyId: targetId,
        scope: fds.scope,
        documentFormatId: fds.documentFormatId,
      },
      select: { id: true, name: true },
    })

    if (clash) {
      skipped.push({
        relation: 'fieldDefinitionSets',
        recordId: fds.id,
        label: fds.name,
        reason: `目標公司已有 ${fds.scope} scope 的欄位定義集「${clash.name}」`,
      })
      continue
    }

    await tx.fieldDefinitionSet.update({
      where: { id: fds.id },
      data: { companyId: targetId },
    })
    fdsCount++
  }
  transferred.fieldDefinitionSets = fdsCount

  // ==========================================================================
  // 3. templateFieldMappings —— 唯一鍵 (dataTemplateId, scope, companyId, documentFormatId)
  // ==========================================================================
  const templateMappings = await tx.templateFieldMapping.findMany({
    where: { companyId: { in: sourceIds } },
    select: {
      id: true,
      scope: true,
      dataTemplateId: true,
      documentFormatId: true,
    },
  })

  let tfmCount = 0
  for (const mapping of templateMappings) {
    if (formatUnavailable(mapping.documentFormatId)) {
      skipped.push({
        relation: 'templateFieldMappings',
        recordId: mapping.id,
        label: `template=${mapping.dataTemplateId} scope=${mapping.scope}`,
        reason: '其所屬 documentFormat 因唯一鍵衝突未能轉移，配置一併保留在原公司',
      })
      continue
    }

    const clash = await tx.templateFieldMapping.findFirst({
      where: {
        companyId: targetId,
        scope: mapping.scope,
        dataTemplateId: mapping.dataTemplateId,
        documentFormatId: mapping.documentFormatId,
      },
      select: { id: true },
    })

    if (clash) {
      skipped.push({
        relation: 'templateFieldMappings',
        recordId: mapping.id,
        label: `template=${mapping.dataTemplateId} scope=${mapping.scope}`,
        reason: `目標公司已有相同 template/scope/format 的映射（${clash.id}）`,
      })
      continue
    }

    await tx.templateFieldMapping.update({
      where: { id: mapping.id },
      data: { companyId: targetId },
    })
    tfmCount++
  }
  transferred.templateFieldMappings = tfmCount

  // ==========================================================================
  // 4. promptConfigs —— 唯一鍵 (promptType, scope, companyId, documentFormatId)
  // ==========================================================================
  const promptConfigs = await tx.promptConfig.findMany({
    where: { companyId: { in: sourceIds } },
    select: {
      id: true,
      name: true,
      promptType: true,
      scope: true,
      documentFormatId: true,
    },
  })

  let promptCount = 0
  for (const config of promptConfigs) {
    if (formatUnavailable(config.documentFormatId)) {
      skipped.push({
        relation: 'promptConfigs',
        recordId: config.id,
        label: config.name,
        reason: '其所屬 documentFormat 因唯一鍵衝突未能轉移，配置一併保留在原公司',
      })
      continue
    }

    const clash = await tx.promptConfig.findFirst({
      where: {
        companyId: targetId,
        promptType: config.promptType,
        scope: config.scope,
        documentFormatId: config.documentFormatId,
      },
      select: { id: true, name: true },
    })

    if (clash) {
      skipped.push({
        relation: 'promptConfigs',
        recordId: config.id,
        label: config.name,
        reason: `目標公司已有 ${config.promptType} / ${config.scope} 的 Prompt 配置「${clash.name}」`,
      })
      continue
    }

    await tx.promptConfig.update({
      where: { id: config.id },
      data: { companyId: targetId },
    })
    promptCount++
  }
  transferred.promptConfigs = promptCount

  // ==========================================================================
  // 5. pipelineConfigs —— 唯一鍵 (scope, regionId, companyId, documentFormatId)
  // ==========================================================================
  const pipelineConfigs = await tx.pipelineConfig.findMany({
    where: { companyId: { in: sourceIds } },
    select: { id: true, scope: true, regionId: true, documentFormatId: true },
  })

  let pipelineCount = 0
  for (const config of pipelineConfigs) {
    if (formatUnavailable(config.documentFormatId)) {
      skipped.push({
        relation: 'pipelineConfigs',
        recordId: config.id,
        label: `scope=${config.scope}`,
        reason: '其所屬 documentFormat 因唯一鍵衝突未能轉移，配置一併保留在原公司',
      })
      continue
    }

    const clash = await tx.pipelineConfig.findFirst({
      where: {
        companyId: targetId,
        scope: config.scope,
        regionId: config.regionId,
        documentFormatId: config.documentFormatId,
      },
      select: { id: true },
    })

    if (clash) {
      skipped.push({
        relation: 'pipelineConfigs',
        recordId: config.id,
        label: `scope=${config.scope}`,
        reason: `目標公司已有相同 scope/region/format 的管線配置（${clash.id}）`,
      })
      continue
    }

    await tx.pipelineConfig.update({
      where: { id: config.id },
      data: { companyId: targetId },
    })
    pipelineCount++
  }
  transferred.pipelineConfigs = pipelineCount

  // ==========================================================================
  // 6. fieldMappingConfigs —— 唯一鍵 (scope, companyId, documentFormatId)
  // ==========================================================================
  const fieldMappingConfigs = await tx.fieldMappingConfig.findMany({
    where: { companyId: { in: sourceIds } },
    select: { id: true, name: true, scope: true, documentFormatId: true },
  })

  let fmcCount = 0
  for (const config of fieldMappingConfigs) {
    if (formatUnavailable(config.documentFormatId)) {
      skipped.push({
        relation: 'fieldMappingConfigs',
        recordId: config.id,
        label: config.name,
        reason: '其所屬 documentFormat 因唯一鍵衝突未能轉移，配置一併保留在原公司',
      })
      continue
    }

    const clash = await tx.fieldMappingConfig.findFirst({
      where: {
        companyId: targetId,
        scope: config.scope,
        documentFormatId: config.documentFormatId,
      },
      select: { id: true, name: true },
    })

    if (clash) {
      skipped.push({
        relation: 'fieldMappingConfigs',
        recordId: config.id,
        label: config.name,
        reason: `目標公司已有 ${config.scope} scope 的欄位映射配置「${clash.name}」`,
      })
      continue
    }

    await tx.fieldMappingConfig.update({
      where: { id: config.id },
      data: { companyId: targetId },
    })
    fmcCount++
  }
  transferred.fieldMappingConfigs = fmcCount

  return { transferred, skipped }
}

/**
 * 將轉移報告中的跳過項目輸出為警告日誌
 *
 * @description
 *   撞鍵時「不轉移」是刻意的處置（不猜測改值），但必須留下記錄，
 *   否則會變成另一種靜默失敗 —— 使用者以為合併完成，實際上部分知識仍留在原公司。
 *
 * @param report - transferCompanyKnowledge 的回傳值
 * @param context - 呼叫來源識別（函數名 + 公司 ID），便於追查
 */
export function logMergeTransferSkips(report: MergeTransferReport, context: string): void {
  if (report.skipped.length === 0) return

  console.warn(
    `[CompanyMerge] ${context}: ${report.skipped.length} record(s) were NOT transferred ` +
      `due to unique-key conflicts and need manual handling:`
  )
  for (const skip of report.skipped) {
    console.warn(`  - ${skip.relation} [${skip.recordId}] "${skip.label}" — ${skip.reason}`)
  }
}
