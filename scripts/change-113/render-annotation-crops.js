/**
 * @fileoverview CHANGE-113：把註解區域裁出來，肉眼確認 GPT 到底看得到什麼
 * @description
 *   分組鍵讀錯時，必須先分清楚三種可能：
 *     (a) pdfjs 根本沒畫出註解文字
 *     (b) 畫出來了但太小／太糊，模型讀不出
 *     (c) 畫得清楚，模型卻沒讀（那就是 prompt 的問題）
 *   只看提取結果分不出來 —— 得看圖。
 *
 *   輸出三種圖供比對：
 *     page-N-raw.png     pdfjs 原生渲染（無補畫）
 *     page-N-painted.png 照 pdf-converter.paintAnnotations 的算法補畫後
 *     page-N-annot-K.png 補畫後、註解位置的裁切放大
 *
 *   **注意**：`pdf-to-img` 必須在 `pdfjs-dist` 之前載入 —— 兩者各自帶一份 pdfjs，
 *   反序會讓 pdf-to-img 內部的 pdfjs 初始化失敗。
 *
 * @module scripts/change-113/render-annotation-crops
 * @since CHANGE-113 階段二
 * @lastModified 2026-07-29
 */
const fs = require('fs')
const path = require('path')

// `pdfjs-dist` 與 `pdf-to-img` 各自帶一份 pdfjs，同一個 process 只能載入其中一個
// （第二次載入必定拋 BaseExceptionClosure，與載入順序無關）。因此拆成兩階段，
// 用 JSON 檔傳遞註解座標。
const MODE = process.argv[2] // 'annotations' | 'render'
const PDF_PATH = process.argv[3]
const JSON_PATH = process.argv[4]
const OUT_DIR = process.argv[5]
const DPI = 200
const MAX_WIDTH = 2048 // 與 DEFAULT_PDF_CONVERSION_CONFIG.maxWidth 一致

/** 與 pdf-converter.ts 的 needsAnnotationPaint 相同的判定 */
function needsAnnotationPaint({ hasAppearance, width, height }) {
  if (hasAppearance) return false
  if (width <= 0 || height <= 0) return false
  return height > width * 1.2
}

/** 與 pdf-converter.ts 的 paintAnnotations 相同的算法 */
async function paintAnnotations(imageBuffer, annotations) {
  const { createCanvas, loadImage } = await import('@napi-rs/canvas')
  const image = await loadImage(imageBuffer)
  const canvas = createCanvas(image.width, image.height)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(image, 0, 0)

  for (const a of annotations) {
    const vertical = a.height > a.width
    const along = vertical ? a.height : a.width
    const across = vertical ? a.width : a.height

    let fontSize = Math.min(across * 0.8, 48)
    ctx.font = `bold ${fontSize}px sans-serif`
    const measured = ctx.measureText(a.text).width
    if (measured > along * 0.95) {
      fontSize = Math.max(6, (fontSize * along * 0.95) / measured)
      ctx.font = `bold ${fontSize}px sans-serif`
    }

    ctx.save()
    ctx.translate(a.left + a.width / 2, a.top + a.height / 2)
    if (vertical) ctx.rotate(-Math.PI / 2)
    ctx.fillStyle = '#cc0000'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(a.text, 0, 0)
    ctx.restore()
    console.log(`    補畫 "${a.text}" fontSize=${fontSize.toFixed(1)} vertical=${vertical}`)
  }

  return canvas.toBuffer('image/png')
}

/** 階段一：只用 pdfjs-dist 讀註解座標，輸出 JSON */
async function collectAnnotations() {
  const buffer = fs.readFileSync(PDF_PATH)
  const scale = DPI / 72

  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    verbosity: 0,
  }).promise

  const byPage = {}
  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
    const page = await doc.getPage(pageNumber)
    const rawAnnotations = await page.getAnnotations({ intent: 'display' })
    const freeTexts = rawAnnotations.filter((a) => a.subtype === 'FreeText')
    if (freeTexts.length === 0) continue

    const viewport = page.getViewport({ scale })
    const collected = []
    for (const a of freeTexts) {
      const text = (a.contents ?? a.contentsObj?.str ?? '').trim()
      if (!text || !a.rect || a.rect.length < 4) continue

      const [x1, y1, x2, y2] = viewport.convertToViewportRectangle(a.rect)
      collected.push({
        text,
        left: Math.min(x1, x2),
        top: Math.min(y1, y2),
        width: Math.abs(x2 - x1),
        height: Math.abs(y2 - y1),
        needsPaint: needsAnnotationPaint({
          hasAppearance: Boolean(a.appearance),
          width: Math.abs(a.rect[2] - a.rect[0]),
          height: Math.abs(a.rect[3] - a.rect[1]),
        }),
      })
    }
    if (collected.length > 0) byPage[pageNumber] = collected
  }

  fs.writeFileSync(JSON_PATH, JSON.stringify(byPage, null, 2))
  console.log(`註解座標已寫入：${JSON_PATH}`)
  for (const [pageNumber, list] of Object.entries(byPage)) {
    console.log(`第 ${pageNumber} 頁：`)
    for (const a of list) {
      console.log(
        `  "${a.text}"  位置=(${Math.round(a.left)},${Math.round(a.top)}) ${Math.round(a.width)}×${Math.round(a.height)}  需補畫=${a.needsPaint}`
      )
    }
  }
}

/** 階段二：只用 pdf-to-img 渲染，套用階段一的座標補畫並裁切 */
async function renderCrops() {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const buffer = fs.readFileSync(PDF_PATH)
  const scale = DPI / 72
  const sharp = require('sharp')
  const byPage = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'))

  const { pdf } = await import('pdf-to-img')
  const document = await pdf(buffer, { scale })
  const pageBuffers = []
  for await (const pageBuffer of document) {
    pageBuffers.push(pageBuffer)
  }
  console.log(`渲染完成：${pageBuffers.length} 頁`)

  for (const [pageNumberStr, collected] of Object.entries(byPage)) {
    const pageNumber = Number(pageNumberStr)
    const pageBuffer = pageBuffers[pageNumber - 1]
    if (!pageBuffer) continue
    const meta = await sharp(pageBuffer).metadata()
    console.log(`\n第 ${pageNumber} 頁（渲染 ${meta.width}×${meta.height}）：`)
    for (const a of collected) {
      console.log(
        `  "${a.text}"  影像位置=(${Math.round(a.left)},${Math.round(a.top)}) ${Math.round(a.width)}×${Math.round(a.height)}  需補畫=${a.needsPaint}`
      )
    }

    await sharp(pageBuffer).resize({ width: 1400 }).toFile(
      path.join(OUT_DIR, `page-${pageNumber}-raw.png`)
    )

    const toPaint = collected.filter((a) => a.needsPaint)
    let painted = pageBuffer
    if (toPaint.length > 0) {
      painted = await paintAnnotations(pageBuffer, toPaint)
    }
    await sharp(painted).resize({ width: 1400 }).toFile(
      path.join(OUT_DIR, `page-${pageNumber}-painted.png`)
    )

    // 模擬 compressImage 的降寬，確認 GPT 實際收到的解析度下仍可讀
    const compressed = await sharp(painted)
      .resize({ width: Math.min(MAX_WIDTH, meta.width), withoutEnlargement: true })
      .png()
      .toBuffer()
    const compressedMeta = await sharp(compressed).metadata()
    const ratio = compressedMeta.width / meta.width
    console.log(`  壓縮後：${compressedMeta.width}×${compressedMeta.height}（比例 ${ratio.toFixed(3)}）`)

    for (let i = 0; i < collected.length; i++) {
      const a = collected[i]
      const pad = 80
      const left = Math.max(0, Math.round((a.left - pad) * ratio))
      const top = Math.max(0, Math.round((a.top - pad) * ratio))
      const width = Math.min(
        compressedMeta.width - left,
        Math.round((a.width + pad * 2) * ratio)
      )
      const height = Math.min(
        compressedMeta.height - top,
        Math.round((a.height + pad * 2) * ratio)
      )
      if (width <= 0 || height <= 0) continue

      await sharp(compressed)
        .extract({ left, top, width, height })
        .resize({ width: Math.min(600, width * 2) })
        .toFile(path.join(OUT_DIR, `page-${pageNumber}-annot-${i}.png`))
      console.log(`  裁切 ${i} "${a.text}" → page-${pageNumber}-annot-${i}.png`)
    }
  }

  console.log(`\n輸出目錄：${OUT_DIR}`)
}

async function main() {
  if (MODE === 'annotations') {
    if (!PDF_PATH || !JSON_PATH) {
      throw new Error('用法：node render-annotation-crops.js annotations <pdf> <outJson>')
    }
    await collectAnnotations()
    return
  }
  if (MODE === 'render') {
    if (!PDF_PATH || !JSON_PATH || !OUT_DIR) {
      throw new Error('用法：node render-annotation-crops.js render <pdf> <inJson> <outDir>')
    }
    await renderCrops()
    return
  }
  throw new Error('第一個參數必須是 annotations 或 render')
}

main().catch((err) => {
  console.error(err.stack || err.message)
  process.exit(1)
})
