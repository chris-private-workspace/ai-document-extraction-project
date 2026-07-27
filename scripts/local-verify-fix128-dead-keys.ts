/**
 * @fileoverview FIX-128 驗收：掃描 Azure DEV 全部 template field mapping 的死 key
 * @description
 *   FIX-128 驗收條件之一「對現有 mapping 執行全面掃描，產出『公式引用了
 *   不存在 key』的清單」的分析工具（清單即 FIX-130 的修正依據）。
 *
 *   輸入為 Kudu 唯讀查詢（node /home/q6.js）的輸出 —— Azure DEV 的
 *   template_field_mappings 全量 + COMPANY 欄位定義集。本腳本以與線上
 *   相同的判定邏輯（import 自 src/lib/template-mapping-source-keys）
 *   逐條規則比對，輸出死 key 報告。
 *
 *   已知集合 = 該公司所有 COMPANY 欄位定義集的 key 聯集 + 標準欄位；
 *   `li_*` / `_ref_*` 豁免；GLOBAL scope 不判定（無公司語境）。
 *
 *   🔴 本腳本純本地分析，不連任何資料庫。
 *
 * @module scripts/local-verify-fix128-dead-keys
 * @since 2026-07-22（FIX-128）
 * @lastModified 2026-07-22
 *
 * @usage npx tsx scripts/local-verify-fix128-dead-keys.ts <kudu-q6-輸出檔> [報告輸出檔]
 */
import * as fs from 'fs'
import {
  findUnknownRuleSourceKeys,
} from '../src/lib/template-mapping-source-keys'
import { STANDARD_FIELDS } from '../src/constants/standard-fields'
import type {
  FieldTransformType,
  TransformParams,
} from '../src/types/template-field-mapping'

interface ScanRule {
  sourceField: string
  targetField: string
  transformType: FieldTransformType
  transformParams?: TransformParams
}

interface ScanMapping {
  id: string
  name: string
  scope: string
  company_id: string | null
  is_active: boolean
  mappings: ScanRule[]
  company_name: string | null
}

interface ScanDefset {
  company_id: string
  name: string
  is_active: boolean
  fields: Array<{ key: string }>
}

function main() {
  const inputPath = process.argv[2]
  const outPath = process.argv[3] ?? 'fix-128-dead-keys-report.txt'
  if (!inputPath) {
    console.error('用法: npx tsx scripts/local-verify-fix128-dead-keys.ts <kudu-q6-輸出檔> [報告輸出檔]')
    process.exit(1)
  }

  // Kudu command API 回應為 {"Output": "<JSON 字串>", ...}；也接受直接的 {mappings, defsets}
  const raw = fs.readFileSync(inputPath, 'utf-8')
  let payload: { mappings: ScanMapping[]; defsets: ScanDefset[] }
  const parsed = JSON.parse(raw)
  if (typeof parsed.Output === 'string') {
    payload = JSON.parse(parsed.Output)
  } else {
    payload = parsed
  }

  // 各公司欄位定義 key 聯集（含非啟用集也納入，判定從寬、寧可少報）
  const keysByCompany = new Map<string, Set<string>>()
  for (const set of payload.defsets) {
    const keys = keysByCompany.get(set.company_id) ?? new Set<string>()
    for (const f of set.fields ?? []) keys.add(f.key)
    keysByCompany.set(set.company_id, keys)
  }
  const standardNames = STANDARD_FIELDS.map((f) => f.name)

  const lines: string[] = []
  const log = (s: string) => lines.push(s)

  log('FIX-128 死 key 全面掃描報告（Azure DEV template_field_mappings）')
  log(`資料來源: Kudu 唯讀查詢 q6.js（${new Date().toISOString()}）`)
  log('')
  log(`mapping 總數: ${payload.mappings.length}（啟用 ${payload.mappings.filter((m) => m.is_active).length}）`)
  log(`COMPANY 欄位定義集: ${payload.defsets.length} 組`)
  log('')

  let mappingsWithDeadKeys = 0
  let totalDeadRules = 0
  let skippedGlobal = 0
  let skippedNoDefs = 0

  for (const m of payload.mappings) {
    if (m.scope === 'GLOBAL') {
      skippedGlobal++
      continue
    }
    const companyKeys = m.company_id ? keysByCompany.get(m.company_id) : undefined
    if (!companyKeys) {
      skippedNoDefs++
      log(`⚠️  [無欄位定義集，無法判定] ${m.name}（company=${m.company_name ?? m.company_id}，active=${m.is_active}）`)
      log('')
      continue
    }

    const knownKeys = new Set<string>([...standardNames, ...companyKeys])
    const deadRules: string[] = []
    for (const rule of m.mappings ?? []) {
      const unknown = findUnknownRuleSourceKeys(rule, knownKeys)
      if (unknown.length > 0) {
        deadRules.push(
          `    ${rule.targetField} [${rule.transformType}] → 死 key: ${unknown.join(', ')}`
        )
      }
    }

    if (deadRules.length > 0) {
      mappingsWithDeadKeys++
      totalDeadRules += deadRules.length
      log(`❌ ${m.name}（company=${m.company_name}，active=${m.is_active}，${deadRules.length}/${m.mappings.length} 條規則有死 key）`)
      for (const l of deadRules) log(l)
      log('')
    }
  }

  log('---')
  log(`含死 key 的 mapping: ${mappingsWithDeadKeys}；受影響規則: ${totalDeadRules} 條`)
  log(`GLOBAL scope 跳過: ${skippedGlobal}；無欄位定義集無法判定: ${skippedNoDefs}`)

  fs.writeFileSync(outPath, lines.join('\n'), 'utf-8')
  console.log(`報告已寫入 ${outPath}`)
}

main()
