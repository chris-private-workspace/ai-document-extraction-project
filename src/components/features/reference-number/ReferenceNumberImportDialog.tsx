'use client'

/**
 * @fileoverview Reference Number Excel 導入對話框
 * @description
 *   批次導入 Reference Number 的對話框（CHANGE-035 改版）：
 *   - 支援 Excel (.xlsx) 文件上傳（拖放 + 點擊）
 *   - 前端 ExcelJS 解析，支援中英文欄位名映射
 *   - 顯示前 10 筆資料預覽（含驗證狀態）
 *   - 提供標準 Excel 範本下載（含 Data + Instructions sheets）
 *   - 維持 overwriteExisting / skipInvalid 選項
 *   - 解析結果以 JSON 呼叫現有 API
 *
 * @module src/components/features/reference-number/ReferenceNumberImportDialog
 * @since Epic 20 - Story 20.6 (Management Page - Form & Import)
 * @lastModified 2026-02-10 (CHANGE-035: JSON → Excel import)
 *
 * @dependencies
 *   - next-intl - 國際化
 *   - exceljs - Excel 文件讀寫
 *   - @/components/ui/* - UI 組件
 *   - @/hooks/use-reference-numbers - Import hook
 *   - @/hooks/use-toast - Toast 通知
 */

import * as React from 'react'
import { useTranslations } from 'next-intl'
import ExcelJS from 'exceljs'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import {
  Upload,
  FileSpreadsheet,
  Loader2,
  CheckCircle,
  AlertTriangle,
  Download,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useToast } from '@/hooks/use-toast'
import {
  useImportReferenceNumbers,
} from '@/hooks/use-reference-numbers'
import type { ImportReferenceNumbersResult } from '@/hooks/use-reference-numbers'
import { useRegions } from '@/hooks/use-regions'

// ============================================================
// Constants
// ============================================================

/** Valid reference number types */
const VALID_TYPES = [
  'SHIPMENT', 'DELIVERY', 'BOOKING', 'CONTAINER',
  'HAWB', 'MAWB', 'BL', 'CUSTOMS', 'OTHER',
] as const

/** Valid reference number document sub-types (document direction) */
const VALID_SUB_TYPES = ['IMPORT', 'EXPORT', 'BOTH', 'UNKNOWN'] as const

/** Column header mapping: English → system field name */
const EN_COLUMN_MAP: Record<string, string> = {
  'number': 'number',
  'type': 'type',
  'document sub type': 'documentSubType',
  'documentsubtype': 'documentSubType',
  'sub type': 'documentSubType',
  'subtype': 'documentSubType',
  'year': 'year',
  'region code': 'regionCode',
  'regioncode': 'regionCode',
  'code': 'code',
  'description': 'description',
  'valid from': 'validFrom',
  'validfrom': 'validFrom',
  'valid until': 'validUntil',
  'validuntil': 'validUntil',
  'is active': 'isActive',
  'isactive': 'isActive',
}

/** Column header mapping: Chinese → system field name */
const ZH_COLUMN_MAP: Record<string, string> = {
  '號碼': 'number',
  '号码': 'number',
  '類型': 'type',
  '类型': 'type',
  '文件子類型': 'documentSubType',
  '文件子类型': 'documentSubType',
  '年份': 'year',
  '地區代碼': 'regionCode',
  '地区代码': 'regionCode',
  '識別碼': 'code',
  '识别码': 'code',
  '描述': 'description',
  '說明': 'description',
  '说明': 'description',
  '有效起始日': 'validFrom',
  '有效結束日': 'validUntil',
  '有效结束日': 'validUntil',
  '啟用': 'isActive',
  '启用': 'isActive',
}

/** Max rows to show in preview */
const PREVIEW_LIMIT = 10

/** Max items allowed (SI-3: 與後端 IMPORT_MAX_ITEMS 必須同步) */
const MAX_ITEMS = 5000

// ============================================================
// Types
// ============================================================

interface ReferenceNumberImportDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess: () => void
}

interface ParsedRow {
  number: string
  type: string
  documentSubType?: string
  year: number
  regionCode: string
  code?: string
  description?: string
  validFrom?: string
  validUntil?: string
  isActive?: boolean
}

interface ValidatedRow {
  data: ParsedRow
  valid: boolean
  errors: string[]
}

// ============================================================
// Helper Functions
// ============================================================

/**
 * Map a header cell value to a system field name.
 * Supports English and Chinese (Traditional + Simplified).
 */
function mapColumnHeader(header: string): string | null {
  const normalized = header.trim().toLowerCase()
  return EN_COLUMN_MAP[normalized] ?? ZH_COLUMN_MAP[header.trim()] ?? null
}

/**
 * Parse a cell value as string, handling ExcelJS cell types.
 */
function cellToString(cell: ExcelJS.CellValue): string {
  if (cell == null) return ''
  if (typeof cell === 'object' && 'text' in cell) return String(cell.text)
  if (typeof cell === 'object' && 'result' in cell) return String(cell.result ?? '')
  return String(cell)
}

/**
 * Parse date string or Excel serial number to ISO 8601 datetime.
 * The API Zod schema uses z.string().datetime() which requires full ISO format.
 */
function parseDate(value: ExcelJS.CellValue): string | undefined {
  if (value == null) return undefined
  if (value instanceof Date) {
    return value.toISOString()
  }
  const str = cellToString(value).trim()
  if (!str) return undefined
  // YYYY-MM-DD → convert to ISO 8601 datetime
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    return new Date(str + 'T00:00:00.000Z').toISOString()
  }
  // Already ISO format
  if (/^\d{4}-\d{2}-\d{2}T/.test(str)) return str
  // Try parsing as date
  const d = new Date(str)
  if (!isNaN(d.getTime())) return d.toISOString()
  return undefined
}

// ============================================================
// Component
// ============================================================

export function ReferenceNumberImportDialog({
  open,
  onOpenChange,
  onSuccess,
}: ReferenceNumberImportDialogProps) {
  const t = useTranslations('referenceNumber.import')
  const tMsg = useTranslations('referenceNumber.messages')
  const { toast } = useToast()

  const [file, setFile] = React.useState<File | null>(null)
  const [validatedRows, setValidatedRows] = React.useState<ValidatedRow[]>([])
  const [parseError, setParseError] = React.useState<string | null>(null)
  const [isDragActive, setIsDragActive] = React.useState(false)
  const [overwriteExisting, setOverwriteExisting] = React.useState(false)
  const [skipInvalid, setSkipInvalid] = React.useState(true)
  const [result, setResult] = React.useState<ImportReferenceNumbersResult | null>(null)
  const [isParsing, setIsParsing] = React.useState(false)
  // SI-3: 檔案資料列數超過 MAX_ITEMS 時記錄實際列數，顯示明確超限提示（不再靜默截斷）
  const [overLimitRows, setOverLimitRows] = React.useState<number | null>(null)

  const importMutation = useImportReferenceNumbers()

  // SI-2：載入現有地區清單，用於驗證 regionCode 是否存在
  const { data: regions } = useRegions()
  const validRegionCodes = React.useMemo(
    () => new Set((regions ?? []).map((r) => r.code.toUpperCase())),
    [regions]
  )

  // SI-2：與後端規則一致的單筆驗證（地區存在、長度限制、i18n 訊息）
  const validateRow = React.useCallback(
    (row: ParsedRow): { valid: boolean; errors: string[] } => {
      const errors: string[] = []

      if (!row.number || row.number.length === 0 || row.number.length > 100) {
        errors.push(t('validation.numberRequired'))
      }
      if (!VALID_TYPES.includes(row.type as typeof VALID_TYPES[number])) {
        errors.push(t('validation.invalidType', { type: row.type }))
      }
      if (!row.year || row.year < 2000 || row.year > 2100) {
        errors.push(t('validation.yearRange'))
      }

      const regionCode = row.regionCode?.trim() ?? ''
      if (!regionCode) {
        errors.push(t('validation.regionRequired'))
      } else if (regionCode.length < 2 || regionCode.length > 20) {
        errors.push(t('validation.regionCodeLength'))
      } else if (
        validRegionCodes.size > 0 &&
        !validRegionCodes.has(regionCode.toUpperCase())
      ) {
        // 僅在地區清單已載入時檢查存在性（未載入時不誤擋）
        errors.push(t('validation.regionNotFound', { code: regionCode }))
      }

      if (row.description && row.description.length > 500) {
        errors.push(t('validation.descriptionTooLong'))
      }
      if (row.code && row.code.length > 50) {
        errors.push(t('validation.codeTooLong'))
      }

      return { valid: errors.length === 0, errors }
    },
    [t, validRegionCodes]
  )

  // --- Derived state ---

  const totalRows = validatedRows.length
  const validCount = React.useMemo(
    () => validatedRows.filter((r) => r.valid).length,
    [validatedRows]
  )
  const invalidCount = totalRows - validCount
  const previewRows = React.useMemo(
    () => validatedRows.slice(0, PREVIEW_LIMIT),
    [validatedRows]
  )
  // SI-4：偵測檔案內重複鍵（相同 number|type|year|regionCode）
  const duplicateCount = React.useMemo(() => {
    const seen = new Set<string>()
    let dup = 0
    for (const r of validatedRows) {
      const key = `${r.data.number}|${r.data.type}|${r.data.year}|${r.data.regionCode.trim().toUpperCase()}`
      if (seen.has(key)) dup++
      else seen.add(key)
    }
    return dup
  }, [validatedRows])

  // SI-4：依原因統計跳過筆數（供結果明細顯示）
  const skipReasonCounts = React.useMemo(() => {
    const counts = {
      DUPLICATE_EXISTING: 0,
      REGION_NOT_FOUND: 0,
      VALIDATION_FAILED: 0,
    }
    for (const d of result?.skippedDetails ?? []) {
      if (d.reason in counts) {
        counts[d.reason as keyof typeof counts]++
      }
    }
    return counts
  }, [result])

  // --- Reset ---

  const resetState = React.useCallback(() => {
    setFile(null)
    setValidatedRows([])
    setParseError(null)
    setIsDragActive(false)
    setOverwriteExisting(false)
    setSkipInvalid(true)
    setResult(null)
    setIsParsing(false)
    setOverLimitRows(null)
  }, [])

  // --- Format file size ---

  const formatFileSize = React.useCallback((bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }, [])

  // --- Excel Parsing ---

  const processExcelFile = React.useCallback(async (selectedFile: File) => {
    setFile(selectedFile)
    setResult(null)
    setParseError(null)
    setValidatedRows([])
    setOverLimitRows(null)
    setIsParsing(true)

    try {
      const buffer = await selectedFile.arrayBuffer()
      const workbook = new ExcelJS.Workbook()
      await workbook.xlsx.load(buffer)

      const worksheet = workbook.worksheets[0]
      if (!worksheet || worksheet.rowCount < 2) {
        setParseError('emptyFile')
        setIsParsing(false)
        return
      }

      // Read header row (row 1)
      const headerRow = worksheet.getRow(1)
      const columnMap: Record<number, string> = {}

      headerRow.eachCell((cell, colNumber) => {
        const headerText = cellToString(cell.value)
        const fieldName = mapColumnHeader(headerText)
        if (fieldName) {
          columnMap[colNumber] = fieldName
        }
      })

      // Verify required columns are present
      const mappedFields = new Set(Object.values(columnMap))
      const requiredFields = ['number', 'type', 'year', 'regionCode']
      const missingFields = requiredFields.filter((f) => !mappedFields.has(f))
      if (missingFields.length > 0) {
        setParseError('parseError')
        setIsParsing(false)
        return
      }

      // SI-3: 明確偵測超限，不再靜默截斷
      // worksheet.rowCount 含表頭，扣除後為資料列數（可能含尾端空列，作為超限 gate 已足夠）
      const dataRowCount = worksheet.rowCount - 1
      if (dataRowCount > MAX_ITEMS) {
        setOverLimitRows(dataRowCount)
        setIsParsing(false)
        return
      }

      // Parse data rows
      const rows: ValidatedRow[] = []
      const lastRow = worksheet.rowCount

      for (let rowIdx = 2; rowIdx <= lastRow; rowIdx++) {
        const row = worksheet.getRow(rowIdx)
        // Skip completely empty rows
        if (row.cellCount === 0) continue

        const rawData: Record<string, ExcelJS.CellValue> = {}
        for (const [colNum, fieldName] of Object.entries(columnMap)) {
          rawData[fieldName] = row.getCell(Number(colNum)).value
        }

        // Convert to ParsedRow
        const yearVal = rawData.year
        let yearNum: number
        if (typeof yearVal === 'number') {
          yearNum = yearVal
        } else {
          yearNum = parseInt(cellToString(yearVal), 10)
        }

        const isActiveVal = rawData.isActive
        let isActive: boolean | undefined
        if (isActiveVal != null) {
          const str = cellToString(isActiveVal).toLowerCase().trim()
          isActive = str === 'true' || str === '1' || str === 'yes'
        }

        const subTypeRaw = rawData.documentSubType
          ? cellToString(rawData.documentSubType).trim().toUpperCase()
          : ''
        const documentSubType = VALID_SUB_TYPES.includes(
          subTypeRaw as typeof VALID_SUB_TYPES[number]
        )
          ? subTypeRaw
          : undefined

        const parsed: ParsedRow = {
          number: cellToString(rawData.number).trim(),
          type: cellToString(rawData.type).trim().toUpperCase(),
          documentSubType,
          year: yearNum,
          regionCode: cellToString(rawData.regionCode).trim(),
          code: rawData.code ? cellToString(rawData.code).trim() : undefined,
          description: rawData.description ? cellToString(rawData.description).trim() : undefined,
          validFrom: parseDate(rawData.validFrom),
          validUntil: parseDate(rawData.validUntil),
          isActive,
        }

        // Skip rows that are all empty
        if (!parsed.number && !parsed.type && isNaN(parsed.year)) continue

        const validation = validateRow(parsed)
        rows.push({ data: parsed, ...validation })
      }

      if (rows.length === 0) {
        setParseError('emptyFile')
        setIsParsing(false)
        return
      }

      setValidatedRows(rows)
    } catch {
      setParseError('parseError')
    } finally {
      setIsParsing(false)
    }
  }, [validateRow])

  // --- Template Download ---

  const handleDownloadTemplate = React.useCallback(async () => {
    const workbook = new ExcelJS.Workbook()
    workbook.creator = 'AI Document Extraction'
    workbook.created = new Date()

    // Sheet 1: Data
    const dataSheet = workbook.addWorksheet(t('template.dataSheet'))
    dataSheet.columns = [
      { header: 'Number', key: 'number', width: 20 },
      { header: 'Type', key: 'type', width: 15 },
      { header: 'Year', key: 'year', width: 10 },
      { header: 'Region Code', key: 'regionCode', width: 15 },
      { header: 'Code', key: 'code', width: 20 },
      { header: 'Description', key: 'description', width: 30 },
      { header: 'Valid From', key: 'validFrom', width: 15 },
      { header: 'Valid Until', key: 'validUntil', width: 15 },
      { header: 'Is Active', key: 'isActive', width: 12 },
      { header: 'Document Sub Type', key: 'documentSubType', width: 18 },
    ]

    // Style header row
    const headerRow = dataSheet.getRow(1)
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } }
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF4472C4' },
    }
    headerRow.alignment = { vertical: 'middle', horizontal: 'center' }

    // Add example row
    dataSheet.addRow({
      number: 'SHP-2026-001',
      type: 'SHIPMENT',
      year: 2026,
      regionCode: 'APAC',
      code: '',
      description: 'Sample shipment from HK',
      validFrom: '2026-01-01',
      validUntil: '2026-12-31',
      isActive: 'TRUE',
      documentSubType: 'IMPORT',
    })

    // Sheet 2: Instructions
    const instrSheet = workbook.addWorksheet(t('template.instructionsSheet'))
    instrSheet.columns = [
      { header: t('template.column'), key: 'column', width: 18 },
      { header: t('template.required'), key: 'required', width: 10 },
      { header: t('template.format'), key: 'format', width: 45 },
      { header: t('template.example'), key: 'example', width: 25 },
    ]

    const instrHeader = instrSheet.getRow(1)
    instrHeader.font = { bold: true, color: { argb: 'FFFFFFFF' } }
    instrHeader.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF4472C4' },
    }

    const yes = t('template.yes')
    const no = t('template.no')

    instrSheet.addRows([
      { column: 'Number', required: yes, format: 'Text, 1-100 characters', example: 'SHP-2026-001' },
      { column: 'Type', required: yes, format: VALID_TYPES.join(' / '), example: 'SHIPMENT' },
      { column: 'Year', required: yes, format: 'Integer, 2000-2100', example: '2026' },
      { column: 'Region Code', required: yes, format: 'Existing region code', example: 'APAC' },
      { column: 'Code', required: no, format: 'Alphanumeric + underscore + hyphen. Auto-generated if empty.', example: 'REF-2026-APAC-A1B2' },
      { column: 'Description', required: no, format: 'Text, max 500 characters', example: 'Shipment from HK' },
      { column: 'Valid From', required: no, format: 'YYYY-MM-DD', example: '2026-01-01' },
      { column: 'Valid Until', required: no, format: 'YYYY-MM-DD', example: '2026-12-31' },
      { column: 'Is Active', required: no, format: 'TRUE / FALSE (default: TRUE)', example: 'TRUE' },
      { column: 'Document Sub Type', required: no, format: VALID_SUB_TYPES.join(' / '), example: 'IMPORT' },
    ])

    // Generate and download
    const excelBuffer = await workbook.xlsx.writeBuffer()
    const blob = new Blob([excelBuffer], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'reference-number-import-template.xlsx'
    a.click()
    URL.revokeObjectURL(url)
  }, [t])

  // --- File Handlers ---

  const handleFileChange = React.useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const selectedFile = e.target.files?.[0]
      if (!selectedFile) return
      if (!selectedFile.name.endsWith('.xlsx')) {
        setParseError('invalidFormat')
        return
      }
      await processExcelFile(selectedFile)
    },
    [processExcelFile]
  )

  const handleDragOver = React.useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragActive(true)
  }, [])

  const handleDragLeave = React.useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragActive(false)
  }, [])

  const handleDrop = React.useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setIsDragActive(false)

      const droppedFile = e.dataTransfer.files[0]
      if (!droppedFile) return
      if (!droppedFile.name.endsWith('.xlsx')) {
        setParseError('invalidFormat')
        return
      }
      await processExcelFile(droppedFile)
    },
    [processExcelFile]
  )

  // --- Import ---

  const handleImport = React.useCallback(async () => {
    if (validatedRows.length === 0) return

    const items = validatedRows
      .filter((r) => r.valid || !skipInvalid)
      .map((r) => ({
        ...r.data,
        code: r.data.code || undefined,
        documentSubType: r.data.documentSubType || undefined,
        description: r.data.description || undefined,
        validFrom: r.data.validFrom || undefined,
        validUntil: r.data.validUntil || undefined,
      }))

    try {
      const importResult = await importMutation.mutateAsync({
        items,
        options: { overwriteExisting, skipInvalid },
      })
      setResult(importResult)
    } catch {
      toast({
        variant: 'destructive',
        title: tMsg('importFailed'),
      })
    }
  }, [validatedRows, overwriteExisting, skipInvalid, importMutation, toast, tMsg])

  const handleClose = React.useCallback(() => {
    if (result && result.imported > 0) {
      onSuccess()
    }
    resetState()
    onOpenChange(false)
  }, [result, onSuccess, resetState, onOpenChange])

  // --- Render ---

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Upload & Preview Phase */}
          {!result && (
            <>
              {/* Dropzone */}
              <div
                className={cn(
                  'border-2 border-dashed rounded-lg p-6 text-center transition-colors',
                  isDragActive
                    ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/20'
                    : 'border-border'
                )}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
              >
                <input
                  type="file"
                  accept=".xlsx"
                  onChange={handleFileChange}
                  className="hidden"
                  id="import-file"
                />
                <label htmlFor="import-file" className="cursor-pointer">
                  {isParsing ? (
                    <div className="flex items-center justify-center gap-2">
                      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                      <span className="text-sm text-muted-foreground">
                        Parsing...
                      </span>
                    </div>
                  ) : file && totalRows > 0 ? (
                    <div className="flex items-center justify-center gap-3">
                      <FileSpreadsheet className="h-8 w-8 text-green-600" />
                      <div className="text-left">
                        <p className="font-medium">{file.name}</p>
                        <p className="text-sm text-muted-foreground">
                          {formatFileSize(file.size)}
                          {' · '}
                          {totalRows} {t('items')}
                          {invalidCount > 0 && (
                            <span className="text-destructive ml-1">
                              ({invalidCount} {t('preview.invalid')})
                            </span>
                          )}
                        </p>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <Upload className="h-8 w-8 mx-auto text-muted-foreground" />
                      <p className="text-sm text-muted-foreground">{t('dropzone')}</p>
                      <p className="text-xs text-muted-foreground/70">{t('dropzoneHint')}</p>
                    </div>
                  )}
                </label>
              </div>

              {/* Template Download */}
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                onClick={handleDownloadTemplate}
              >
                <Download className="h-4 w-4 mr-2" />
                {t('downloadTemplate')}
              </Button>

              {/* Parse Error */}
              {parseError && (
                <Alert variant="destructive">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertDescription>{t(parseError)}</AlertDescription>
                </Alert>
              )}

              {/* SI-3: 超限明確提示（取代靜默截斷） */}
              {overLimitRows !== null && (
                <Alert variant="destructive">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertDescription>
                    {t('overLimit', { actual: overLimitRows, max: MAX_ITEMS })}
                  </AlertDescription>
                </Alert>
              )}

              {/* Preview Table */}
              {totalRows > 0 && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-medium">{t('preview.title')}</p>
                    <p className="text-xs text-muted-foreground">
                      {totalRows > PREVIEW_LIMIT
                        ? t('preview.showing', {
                            count: PREVIEW_LIMIT,
                            total: totalRows,
                          })
                        : t('preview.allRows', { total: totalRows })}
                    </p>
                  </div>
                  <div className="border rounded-md overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-12">#</TableHead>
                          <TableHead>{t('columns.number')}</TableHead>
                          <TableHead>{t('columns.type')}</TableHead>
                          <TableHead>{t('columns.documentSubType')}</TableHead>
                          <TableHead>{t('columns.year')}</TableHead>
                          <TableHead>{t('columns.regionCode')}</TableHead>
                          <TableHead>{t('columns.description')}</TableHead>
                          <TableHead className="w-20">{t('columns.status')}</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {previewRows.map((row, idx) => (
                          <TableRow
                            key={idx}
                            className={cn(!row.valid && 'bg-destructive/5')}
                          >
                            <TableCell className="text-muted-foreground text-xs">
                              {idx + 1}
                            </TableCell>
                            <TableCell className="font-mono text-xs">
                              {row.data.number}
                            </TableCell>
                            <TableCell className="text-xs">{row.data.type}</TableCell>
                            <TableCell className="text-xs">
                              {row.data.documentSubType ?? '-'}
                            </TableCell>
                            <TableCell className="text-xs">{row.data.year}</TableCell>
                            <TableCell className="text-xs">{row.data.regionCode}</TableCell>
                            <TableCell className="text-xs truncate max-w-[150px]">
                              {row.data.description || '-'}
                            </TableCell>
                            <TableCell>
                              {row.valid ? (
                                <Badge variant="outline" className="text-green-600 border-green-300">
                                  {t('preview.valid')}
                                </Badge>
                              ) : (
                                <Badge variant="destructive" className="text-xs">
                                  {t('preview.invalid')}
                                </Badge>
                              )}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>

                  {/* Validation Summary */}
                  <div className="flex gap-4 text-xs text-muted-foreground">
                    <span className="text-green-600">
                      {t('preview.valid')}: {validCount}
                    </span>
                    {invalidCount > 0 && (
                      <span className="text-destructive">
                        {t('preview.invalid')}: {invalidCount}
                      </span>
                    )}
                    {duplicateCount > 0 && (
                      <span className="text-amber-600">
                        {t('preview.duplicates', { count: duplicateCount })}
                      </span>
                    )}
                  </div>
                </div>
              )}

              {/* Import Options */}
              {totalRows > 0 && (
                <div className="space-y-3">
                  <label className="flex items-center gap-2">
                    <Checkbox
                      checked={overwriteExisting}
                      onCheckedChange={(v) => setOverwriteExisting(!!v)}
                    />
                    <span className="text-sm">{t('overwriteExisting')}</span>
                  </label>
                  <label className="flex items-center gap-2">
                    <Checkbox
                      checked={skipInvalid}
                      onCheckedChange={(v) => setSkipInvalid(!!v)}
                    />
                    <span className="text-sm">{t('skipInvalid')}</span>
                  </label>
                </div>
              )}
            </>
          )}

          {/* Result */}
          {result && (
            <Alert>
              <CheckCircle className="h-4 w-4" />
              <AlertTitle>{t('result.title')}</AlertTitle>
              <AlertDescription>
                <ul className="list-disc list-inside space-y-1 mt-2">
                  <li>{t('result.imported', { count: result.imported })}</li>
                  <li>{t('result.updated', { count: result.updated })}</li>
                  <li>{t('result.skipped', { count: result.skipped })}</li>
                  {result.skippedDetails && result.skippedDetails.length > 0 && (
                    <li className="list-none">
                      <ul className="list-[circle] list-inside ml-4 text-xs">
                        {skipReasonCounts.DUPLICATE_EXISTING > 0 && (
                          <li>
                            {t('result.skipReasons.duplicateExisting', {
                              count: skipReasonCounts.DUPLICATE_EXISTING,
                            })}
                          </li>
                        )}
                        {skipReasonCounts.REGION_NOT_FOUND > 0 && (
                          <li>
                            {t('result.skipReasons.regionNotFound', {
                              count: skipReasonCounts.REGION_NOT_FOUND,
                            })}
                          </li>
                        )}
                        {skipReasonCounts.VALIDATION_FAILED > 0 && (
                          <li>
                            {t('result.skipReasons.validationFailed', {
                              count: skipReasonCounts.VALIDATION_FAILED,
                            })}
                          </li>
                        )}
                      </ul>
                    </li>
                  )}
                  {result.errors.length > 0 && (
                    <li className="text-destructive">
                      {t('result.errors', { count: result.errors.length })}
                    </li>
                  )}
                </ul>
              </AlertDescription>
            </Alert>
          )}

          {/* Error Details */}
          {result && result.errors.length > 0 && (
            <div className="max-h-40 overflow-auto text-sm space-y-1">
              {result.errors.map((err, i) => (
                <div key={i} className="flex gap-2 text-destructive">
                  <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                  <span>{t('preview.rowNumber')} {err.index + 1}: {err.error}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Buttons */}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={handleClose}>
            {result ? t('close') : t('cancel')}
          </Button>
          {!result && (
            <Button
              onClick={handleImport}
              disabled={totalRows === 0 || (validCount === 0 && skipInvalid) || importMutation.isPending}
            >
              {importMutation.isPending && (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              )}
              {t('import')}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
