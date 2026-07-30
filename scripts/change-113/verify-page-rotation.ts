/**
 * @fileoverview CHANGE-113 階段一 A3：以真實文件驗證頁面轉正（唯讀）
 * @description
 *   直接跑**正式路徑** `PdfConverter.convertToBase64Images`，把每頁輸出成 PNG，
 *   再肉眼確認側躺頁是否已轉正、補畫的註解是否仍然正立可讀。
 *
 *   刻意不重寫一份轉換邏輯：單元測試釘住的是 `detectTextRotation` 的判定，
 *   這支腳本要驗的是「整條轉檔路徑接起來之後，GPT 實際收到的那張圖」——
 *   複製一份算法就驗不到接線錯誤（正是 FIX-092 那類漏接的溫床）。
 *
 *   用法：
 *     npx tsx scripts/change-113/verify-page-rotation.ts <檔名前綴> <輸出目錄>
 *   例：
 *     npx tsx scripts/change-113/verify-page-rotation.ts DHL_RCIM250111 ./out
 *
 * @module scripts/change-113/verify-page-rotation
 * @since CHANGE-113 階段一 A3
 * @lastModified 2026-07-29
 */
import 'dotenv/config'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from 'pg'

const FILE_NAME_PREFIX = process.argv[2]
const OUT_DIR = process.argv[3]

async function main(): Promise<void> {
  if (!FILE_NAME_PREFIX || !OUT_DIR) {
    throw new Error('用法：npx tsx verify-page-rotation.ts <檔名前綴> <輸出目錄>')
  }

  // 動態 import：src/ 模組在頂層 import 會早於 dotenv 生效（見 memory
  // feedback_script_dotenv_dynamic_import）。此處雖未用到 Prisma，仍沿用同一紀律。
  const { PdfConverter } = await import(
    '../../src/services/extraction-v3/utils/pdf-converter'
  )
  const { BlobServiceClient } = await import('@azure/storage-blob')

  const client = new Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()

  const { rows } = await client.query(
    `select id, file_name, blob_name, file_path
       from documents
      where file_name ilike $1
      order by created_at desc
      limit 1`,
    [`${FILE_NAME_PREFIX}%`]
  )
  await client.end()

  if (rows.length === 0) throw new Error(`找不到檔名以 ${FILE_NAME_PREFIX} 開頭的文件`)
  const doc = rows[0]
  console.log(`文件：${doc.file_name}`)
  console.log(`  documentId = ${doc.id}`)
  console.log(`  blobName   = ${doc.blob_name}`)

  const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING
  if (!connectionString) throw new Error('AZURE_STORAGE_CONNECTION_STRING 未設定')

  const blobService = BlobServiceClient.fromConnectionString(connectionString)
  const containerName = process.env.AZURE_STORAGE_CONTAINER_NAME || 'documents'
  const blob = blobService
    .getContainerClient(containerName)
    .getBlobClient(doc.blob_name)
  const buffer = await blob.downloadToBuffer()
  console.log(`  已下載 ${buffer.length} bytes`)

  // 正式路徑
  const result = await PdfConverter.convertToBase64Images(buffer)
  if (!result.success) throw new Error(`轉換失敗：${result.error}`)

  console.log(`\n轉換結果：`)
  console.log(`  頁數       = ${result.pageCount}`)
  console.log(`  註解       = ${result.annotations?.length ?? 0} 筆`)
  for (const annotation of result.annotations ?? []) {
    console.log(
      `    第 ${annotation.pageNumber} 頁 "${annotation.text}"（補畫=${annotation.painted}）`
    )
  }
  console.log(`  轉正頁面   = ${JSON.stringify(result.rotatedPages ?? [])}`)
  for (const warning of result.warnings ?? []) console.log(`  ⚠ ${warning}`)

  mkdirSync(OUT_DIR, { recursive: true })
  // 一併留下來源 PDF：後續要重跑方向診斷時不必再連一次 blob
  writeFileSync(join(OUT_DIR, 'source.pdf'), buffer)
  result.images.forEach((dataUrl, index) => {
    const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
    const outPath = join(OUT_DIR, `page-${index + 1}.png`)
    writeFileSync(outPath, Buffer.from(base64, 'base64'))
    console.log(`  已寫出 ${outPath}`)
  })
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : error)
  process.exit(1)
})
