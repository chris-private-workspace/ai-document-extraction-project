/**
 * @fileoverview PDF 轉換工具 - V3 架構
 * @description
 *   提供 PDF 轉換為 Base64 圖片陣列的功能：
 *   - PDF 頁面轉換為 PNG 圖片
 *   - 圖片 Base64 編碼
 *   - 支援多頁 PDF 處理
 *   - 錯誤處理和重試機制
 *
 * @module src/services/extraction-v3/utils/pdf-converter
 * @since CHANGE-021 - Unified Processor V3 Refactoring
 * @lastModified 2026-01-30
 *
 * @features
 *   - PDF 轉 PNG 圖片
 *   - 多頁 PDF 支援
 *   - 圖片品質配置
 *   - Base64 編碼輸出
 *
 * @dependencies
 *   - pdf-to-img: PDF 轉圖片
 *   - sharp: 圖片處理（可選壓縮）
 *
 * @related
 *   - src/services/extraction-v3/extraction-v3.service.ts - V3 主服務
 *   - src/types/extraction-v3.types.ts - V3 類型定義
 */

// ============================================================================
// Types
// ============================================================================

/**
 * PDF 轉換配置
 */
export interface PdfConversionConfig {
  /** 輸出圖片 DPI（預設 200） */
  dpi?: number;
  /** 輸出圖片格式 */
  format?: 'png' | 'jpeg';
  /** JPEG 品質（1-100，預設 85） */
  quality?: number;
  /** 最大頁數限制（預設 20） */
  maxPages?: number;
  /** 最大圖片寬度（預設 2048） */
  maxWidth?: number;
  /** 是否壓縮圖片（預設 true） */
  compress?: boolean;
  /**
   * 是否補畫 pdfjs 無法渲染的旋轉 FreeText 註解（預設 true）
   * @see PdfConverter.paintUnrenderableAnnotations
   * @since CHANGE-113 階段一 A
   */
  paintRotatedAnnotations?: boolean;
}

/**
 * PDF 註解資訊
 *
 * @description
 *   從 PDF 抽出的 FreeText 註解內容。使用者常以此形式在文件上補充系統無法從
 *   原始內容得知的資訊（例如 DHL 發票上標註每一列對應哪個 shipment）。
 *
 * @since CHANGE-113 階段一 A
 */
export interface PdfAnnotationInfo {
  /** 頁碼（1-based） */
  pageNumber: number;
  /** 註解文字內容（已去除前後空白） */
  text: string;
  /** 本流程是否有將它補畫到圖像上（false = pdfjs 原本就畫得出來） */
  painted: boolean;
}

/**
 * PDF 轉換結果
 */
export interface PdfConversionResult {
  /** 是否成功 */
  success: boolean;
  /** Base64 圖片陣列 */
  images: string[];
  /** 頁數 */
  pageCount: number;
  /** 處理時間（毫秒） */
  processingTimeMs: number;
  /** 錯誤訊息（如失敗） */
  error?: string;
  /** 警告訊息 */
  warnings?: string[];
  /**
   * 抽出的 FreeText 註解（CHANGE-113 階段一 A）
   * @description 僅 PDF 來源會有值；供下游將使用者補註的資訊納入提取上下文
   */
  annotations?: PdfAnnotationInfo[];
}

/**
 * 單頁轉換結果
 */
interface PageConversionResult {
  pageNumber: number;
  base64: string;
  width: number;
  height: number;
}

/**
 * 收集到的 FreeText 註解（含已換算為視口像素的位置）
 * @since CHANGE-113 階段一 A
 */
interface CollectedAnnotation {
  text: string;
  /** 視口座標（像素），左上為原點 */
  left: number;
  top: number;
  width: number;
  height: number;
  /** pdfjs 是否畫不出來、需要本流程補畫 */
  needsPaint: boolean;
}

/**
 * 判斷 FreeText 註解是否需要由本流程補畫
 *
 * @description
 *   CHANGE-113 階段一 A。pdfjs 對 FreeText 一律以水平方向排版：
 *
 *   - 有 appearance stream（/AP）者，pdfjs 直接照畫，必定看得見
 *   - 沒有 /AP 但註解框是**橫向**的，pdfjs 自行排版後文字放得下，正常顯示
 *   - 沒有 /AP 且註解框是**直立**的，代表原編輯器以旋轉方向排版文字。
 *     pdfjs 不支援旋轉排版，文字排不進窄框而被裁掉 —— 只剩邊框、內容消失
 *
 *   只有第三種需要補畫。對前兩種補畫會疊字，反而蓋掉原本清楚的內容。
 *
 *   1.2 倍門檻是為了讓近正方形的框留在「不補畫」那側 —— 寧可漏畫（資訊仍可
 *   由 annotations 清單取得），也不要破壞本來就正確的畫面。
 *
 *   實測依據（2026-07-29，三份真實 DHL 文件）：
 *   | 註解 | 框(pt) | 判定 | pdfjs 實際渲染 |
 *   |---|---|---|---|
 *   | RCIM-25-0111 | 18 × 108 | 補畫 | 只有紅框、無文字 |
 *   | RCIM/25/0119 | 108 × 18 | 不補畫 | 正常顯示 |
 *   | RCIM/25/0246 | 169 × 49 | 不補畫 | 正常顯示 |
 *   | RHIM/25/0202 | 72 × 15 | 不補畫 | 正常顯示 |
 *
 * @since CHANGE-113 階段一 A
 */
export function needsAnnotationPaint(params: {
  /** 註解是否帶 appearance stream */
  hasAppearance: boolean;
  /** 註解框寬度（單位不拘，只比較比例） */
  width: number;
  /** 註解框高度 */
  height: number;
}): boolean {
  if (params.hasAppearance) return false;
  if (params.width <= 0 || params.height <= 0) return false;
  return params.height > params.width * 1.2;
}

/**
 * pdfjs 的最小介面
 *
 * @description
 *   pdfjs 以動態路徑載入（見 loadPdfjs），拿不到套件自身的型別宣告，
 *   因此在此宣告實際用到的最小子集，避免使用 any。
 *
 * @since CHANGE-113 階段一 A
 */
interface PdfjsAnnotation {
  subtype?: string;
  contents?: string;
  contentsObj?: { str?: string };
  appearance?: unknown;
  rect?: number[];
}

interface PdfjsViewport {
  convertToViewportRectangle(rect: number[]): number[];
}

interface PdfjsPage {
  getViewport(params: { scale: number }): PdfjsViewport;
  getAnnotations(params: { intent: string }): Promise<PdfjsAnnotation[]>;
}

interface PdfjsDocument {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfjsPage>;
  destroy(): Promise<void>;
}

// ============================================================================
// Constants
// ============================================================================

/** 預設轉換配置 */
export const DEFAULT_PDF_CONVERSION_CONFIG: Required<PdfConversionConfig> = {
  dpi: 200,
  format: 'png',
  quality: 85,
  maxPages: 20,
  maxWidth: 2048,
  compress: true,
  paintRotatedAnnotations: true,
};

/** 支援的 MIME 類型 */
export const SUPPORTED_PDF_MIME_TYPES = ['application/pdf'] as const;

/** 支援的圖片 MIME 類型 */
export const SUPPORTED_IMAGE_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/tiff',
  'image/webp',
] as const;

// ============================================================================
// PDF Converter Class
// ============================================================================

/**
 * PDF 轉換器
 *
 * @description 將 PDF 文件轉換為 Base64 編碼的圖片陣列
 *
 * @example
 * ```typescript
 * const result = await PdfConverter.convertToBase64Images(pdfBuffer);
 * if (result.success) {
 *   console.log(`轉換了 ${result.pageCount} 頁`);
 *   // result.images 包含 Base64 編碼的圖片
 * }
 * ```
 */
export class PdfConverter {
  /**
   * 將 PDF 轉換為 Base64 圖片陣列
   *
   * @param buffer - PDF 文件 Buffer
   * @param config - 轉換配置
   * @returns 轉換結果
   */
  static async convertToBase64Images(
    buffer: Buffer,
    config: PdfConversionConfig = {}
  ): Promise<PdfConversionResult> {
    const startTime = Date.now();
    const mergedConfig = { ...DEFAULT_PDF_CONVERSION_CONFIG, ...config };
    const warnings: string[] = [];

    try {
      // 動態導入 pdf-to-img（避免打包問題）
      const { pdf } = await import('pdf-to-img');

      const images: string[] = [];
      const annotations: PdfAnnotationInfo[] = [];
      let pageCount = 0;

      const scale = mergedConfig.dpi / 72; // 72 DPI 是 PDF 基準

      // CHANGE-113 階段一 A：抽出 FreeText 註解。使用者以此形式補充的資訊
      // （如 DHL 發票每列對應的 shipment）不在頁面內容裡，靠 OCR 取不到。
      // 失敗僅記 warning，不影響主要的轉圖流程。
      const annotationsByPage = mergedConfig.paintRotatedAnnotations
        ? await this.collectFreeTextAnnotations(buffer, scale, warnings)
        : new Map<number, CollectedAnnotation[]>();

      // 使用 pdf-to-img 轉換
      const document = await pdf(buffer, { scale });

      for await (const page of document) {
        pageCount++;

        // 檢查頁數限制
        if (pageCount > mergedConfig.maxPages) {
          warnings.push(
            `頁數超過限制 (${mergedConfig.maxPages})，僅處理前 ${mergedConfig.maxPages} 頁`
          );
          break;
        }

        // 處理圖片
        let imageBuffer = page;

        // CHANGE-113 階段一 A：補畫 pdfjs 渲染不出來的旋轉 FreeText 註解。
        // 必須在壓縮之前 —— 註解座標以未縮放的原始圖像為基準。
        const pageAnnotations = annotationsByPage.get(pageCount);
        if (pageAnnotations?.length) {
          for (const a of pageAnnotations) {
            annotations.push({
              pageNumber: pageCount,
              text: a.text,
              painted: a.needsPaint,
            });
          }
          const toPaint = pageAnnotations.filter((a) => a.needsPaint);
          if (toPaint.length > 0) {
            imageBuffer = await this.paintAnnotations(imageBuffer, toPaint, warnings);
          }
        }

        // 可選壓縮處理
        // CHANGE-113: 必須傳 imageBuffer 而非 page —— 前面可能已補畫過註解。
        // 原本兩者恆等，插入補畫步驟後傳 page 會把疊加結果整個丟掉。
        if (mergedConfig.compress) {
          imageBuffer = await this.compressImage(
            imageBuffer,
            mergedConfig.format,
            mergedConfig.quality,
            mergedConfig.maxWidth
          );
        }

        // 轉換為 Base64
        const base64 = imageBuffer.toString('base64');
        const mimeType =
          mergedConfig.format === 'jpeg' ? 'image/jpeg' : 'image/png';
        images.push(`data:${mimeType};base64,${base64}`);

        // FIX-100: 每頁處理後讓出 event loop。pdf-to-img（pdfjs）逐頁 rasterize 是同步 CPU，
        // 連續多頁會長時間阻塞單線程主 event loop，使前景請求（如上傳後的 documents 列表）
        // 被餓死。在頁與頁之間 yield，讓 pending 的前景請求能在間隙被處理（不改變輸出）。
        await new Promise<void>((resolve) => setImmediate(resolve));
      }

      return {
        success: true,
        images,
        pageCount,
        processingTimeMs: Date.now() - startTime,
        warnings: warnings.length > 0 ? warnings : undefined,
        annotations: annotations.length > 0 ? annotations : undefined,
      };
    } catch (error) {
      // 之前此錯誤被靜默吞掉（只回傳 message），導致 Azure 上 PDF→圖片失敗時
      // 容器 log 無任何線索。明確記錄完整錯誤（含 stack）以利診斷。
      console.error('[pdf-converter] convertToBase64Images failed:', error);
      return {
        success: false,
        images: [],
        pageCount: 0,
        processingTimeMs: Date.now() - startTime,
        error: error instanceof Error ? error.message : '未知錯誤',
      };
    }
  }

  /**
   * 將圖片文件轉換為 Base64
   *
   * @param buffer - 圖片文件 Buffer
   * @param mimeType - MIME 類型
   * @param config - 轉換配置
   * @returns 轉換結果
   */
  static async convertImageToBase64(
    buffer: Buffer,
    mimeType: string,
    config: PdfConversionConfig = {}
  ): Promise<PdfConversionResult> {
    const startTime = Date.now();
    const mergedConfig = { ...DEFAULT_PDF_CONVERSION_CONFIG, ...config };

    try {
      let imageBuffer = buffer;

      // 可選壓縮處理
      if (mergedConfig.compress) {
        imageBuffer = await this.compressImage(
          buffer,
          mergedConfig.format,
          mergedConfig.quality,
          mergedConfig.maxWidth
        );
      }

      // 轉換為 Base64
      const base64 = imageBuffer.toString('base64');
      const outputMimeType =
        mergedConfig.format === 'jpeg' ? 'image/jpeg' : 'image/png';
      const dataUrl = `data:${outputMimeType};base64,${base64}`;

      return {
        success: true,
        images: [dataUrl],
        pageCount: 1,
        processingTimeMs: Date.now() - startTime,
      };
    } catch (error) {
      return {
        success: false,
        images: [],
        pageCount: 0,
        processingTimeMs: Date.now() - startTime,
        error: error instanceof Error ? error.message : '未知錯誤',
      };
    }
  }

  /**
   * 根據文件類型自動選擇轉換方法
   *
   * @param buffer - 文件 Buffer
   * @param mimeType - MIME 類型
   * @param config - 轉換配置
   * @returns 轉換結果
   */
  static async convertToBase64(
    buffer: Buffer,
    mimeType: string,
    config: PdfConversionConfig = {}
  ): Promise<PdfConversionResult> {
    if (SUPPORTED_PDF_MIME_TYPES.includes(mimeType as typeof SUPPORTED_PDF_MIME_TYPES[number])) {
      return this.convertToBase64Images(buffer, config);
    }

    if (SUPPORTED_IMAGE_MIME_TYPES.includes(mimeType as typeof SUPPORTED_IMAGE_MIME_TYPES[number])) {
      return this.convertImageToBase64(buffer, mimeType, config);
    }

    return {
      success: false,
      images: [],
      pageCount: 0,
      processingTimeMs: 0,
      error: `不支援的文件類型: ${mimeType}`,
    };
  }

  /**
   * 壓縮圖片
   *
   * @param buffer - 原始圖片 Buffer
   * @param format - 輸出格式
   * @param quality - 品質（JPEG）
   * @param maxWidth - 最大寬度
   * @returns 壓縮後的圖片 Buffer
   */
  /**
   * 抽出各頁的 FreeText 註解，並判斷哪些需要補畫
   *
   * @description
   *   CHANGE-113 階段一 A。使用者常以 PDF 註解在文件上補充系統無法從原始內容
   *   得知的資訊（DHL 發票標註每一列對應哪個 shipment 即是一例）。
   *
   *   **為何需要補畫**：pdfjs 對 FreeText 一律以水平方向排版。當註解框是「直立」
   *   的（高 > 寬），代表原編輯器以旋轉方向排版文字，pdfjs 排不進去而把文字裁掉，
   *   結果只畫出邊框、內容消失。橫向框則正常渲染，不可重複補畫 —— 否則會疊字、
   *   反而蓋掉原本清楚的內容（2026-07-29 以三份真實 DHL 文件實測確認）。
   *
   *   任何失敗都只記 warning：註解是加分資訊，不該讓整份文件轉檔失敗。
   *
   * @param buffer - PDF 原始 buffer
   * @param scale - 與 pdf-to-img 相同的縮放比例，確保座標對得上
   * @param warnings - 警告收集器（就地追加）
   * @returns 頁碼（1-based）→ 該頁註解清單
   *
   * @since CHANGE-113 階段一 A
   */
  private static async collectFreeTextAnnotations(
    buffer: Buffer,
    scale: number,
    warnings: string[]
  ): Promise<Map<number, CollectedAnnotation[]>> {
    const result = new Map<number, CollectedAnnotation[]>();
    let doc: PdfjsDocument | undefined;

    try {
      const { getDocument } = await this.loadPdfjs();
      doc = (await getDocument({
        data: new Uint8Array(buffer),
        verbosity: 0,
      }).promise) as PdfjsDocument;

      for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
        const page = await doc.getPage(pageNumber);
        const rawAnnotations = await page.getAnnotations({ intent: 'display' });

        const freeTexts = rawAnnotations.filter((a) => a.subtype === 'FreeText');
        if (freeTexts.length === 0) continue;

        const viewport = page.getViewport({ scale });
        const collected: CollectedAnnotation[] = [];

        for (const annotation of freeTexts) {
          const text = (annotation.contents ?? annotation.contentsObj?.str ?? '').trim();
          // 空註解（使用者建立後未輸入內容）沒有任何資訊價值
          if (!text || !annotation.rect || annotation.rect.length < 4) continue;

          const [x1, y1, x2, y2] = viewport.convertToViewportRectangle(annotation.rect);
          const left = Math.min(x1, x2);
          const top = Math.min(y1, y2);
          const width = Math.abs(x2 - x1);
          const height = Math.abs(y2 - y1);

          collected.push({
            text,
            left,
            top,
            width,
            height,
            needsPaint: needsAnnotationPaint({
              hasAppearance: Boolean(annotation.appearance),
              width,
              height,
            }),
          });
        }

        if (collected.length > 0) result.set(pageNumber, collected);
      }
    } catch (error) {
      warnings.push(
        `讀取 PDF 註解失敗（不影響轉檔）：${error instanceof Error ? error.message : '未知錯誤'}`
      );
    } finally {
      await doc?.destroy().catch(() => undefined);
    }

    return result;
  }

  /**
   * 載入與 pdf-to-img 同一份的 pdfjs
   *
   * @description
   *   必須用 pdf-to-img 巢狀的 pdfjs-dist（5.4.x），不能用專案頂層那份（4.10.38）：
   *   兩者同進程載入會因 API/Worker 版本檢查而互相拒絕。頂層那份是前端 react-pdf v9
   *   刻意保留的降級版本，不能動。
   *
   *   Dockerfile 已整包複製 pdf-to-img（含其巢狀 pdfjs-dist，見 FIX-080），
   *   因此此解析路徑在容器中同樣成立。
   *
   * @since CHANGE-113 階段一 A
   */
  private static async loadPdfjs(): Promise<{
    getDocument: (params: { data: Uint8Array; verbosity: number }) => { promise: Promise<unknown> };
  }> {
    const { createRequire } = await import('node:module');
    const { pathToFileURL } = await import('node:url');
    const { join } = await import('node:path');
    // createRequire 需要一個實體路徑當解析基準。這裡用專案根的 package.json：
    // Next standalone 的工作目錄與本地開發都是專案根（node_modules 就在其下），
    // 且不依賴 CJS 專屬的 __filename —— 後者在 ESM 執行環境會直接 ReferenceError。
    const req = createRequire(join(process.cwd(), 'package.json'));
    const pdfjsPath = req.resolve('pdfjs-dist/legacy/build/pdf.mjs', {
      paths: [req.resolve('pdf-to-img')],
    });
    return import(pathToFileURL(pdfjsPath).href) as Promise<{
      getDocument: (params: {
        data: Uint8Array;
        verbosity: number;
      }) => { promise: Promise<unknown> };
    }>;
  }

  /**
   * 將註解文字補畫到頁面圖像上
   *
   * @description
   *   CHANGE-113 階段一 A。僅處理 collectFreeTextAnnotations 判定需補畫者。
   *   文字沿矩形長邊排列 —— 直立框轉 -90 度，與文件其餘內容方向一致。
   *
   *   使用 `@napi-rs/canvas` 而非 `canvas`：前者已是 pdfjs 的渲染後端，且
   *   Dockerfile 已為它複製 Linux prebuilt binary（FIX-080）；改用其他 canvas
   *   實作會在 Next standalone trace 中被漏掉，重演部署時才爆的問題。
   *
   * @since CHANGE-113 階段一 A
   */
  private static async paintAnnotations(
    imageBuffer: Buffer,
    annotations: CollectedAnnotation[],
    warnings: string[]
  ): Promise<Buffer> {
    try {
      const { createCanvas, loadImage } = await import('@napi-rs/canvas');
      const image = await loadImage(imageBuffer);

      const canvas = createCanvas(image.width, image.height);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(image, 0, 0);

      for (const annotation of annotations) {
        const vertical = annotation.height > annotation.width;
        const along = vertical ? annotation.height : annotation.width;
        const across = vertical ? annotation.width : annotation.height;

        // 依「跨向」尺寸推字級，再縮到不超出「沿向」長度
        let fontSize = Math.min(across * 0.8, 48);
        ctx.font = `bold ${fontSize}px sans-serif`;
        const measured = ctx.measureText(annotation.text).width;
        if (measured > along * 0.95) {
          fontSize = Math.max(6, (fontSize * along * 0.95) / measured);
          ctx.font = `bold ${fontSize}px sans-serif`;
        }

        ctx.save();
        ctx.translate(
          annotation.left + annotation.width / 2,
          annotation.top + annotation.height / 2
        );
        if (vertical) ctx.rotate(-Math.PI / 2);
        ctx.fillStyle = '#cc0000';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(annotation.text, 0, 0);
        ctx.restore();
      }

      return canvas.toBuffer('image/png');
    } catch (error) {
      warnings.push(
        `補畫 PDF 註解失敗（沿用原圖）：${error instanceof Error ? error.message : '未知錯誤'}`
      );
      return imageBuffer;
    }
  }

  private static async compressImage(
    buffer: Buffer,
    format: 'png' | 'jpeg',
    quality: number,
    maxWidth: number
  ): Promise<Buffer> {
    try {
      // 動態導入 sharp
      const sharp = (await import('sharp')).default;

      let processor = sharp(buffer);

      // 獲取圖片尺寸
      const metadata = await processor.metadata();
      const width = metadata.width || 0;

      // 如果寬度超過限制，進行縮放
      if (width > maxWidth) {
        processor = processor.resize(maxWidth, null, {
          fit: 'inside',
          withoutEnlargement: true,
        });
      }

      // 輸出為指定格式
      if (format === 'jpeg') {
        return processor.jpeg({ quality }).toBuffer();
      } else {
        return processor.png({ compressionLevel: 6 }).toBuffer();
      }
    } catch {
      // sharp 不可用時返回原始 buffer
      return buffer;
    }
  }

  /**
   * 檢查是否為支援的文件類型
   *
   * @param mimeType - MIME 類型
   * @returns 是否支援
   */
  static isSupportedType(mimeType: string): boolean {
    return (
      SUPPORTED_PDF_MIME_TYPES.includes(mimeType as typeof SUPPORTED_PDF_MIME_TYPES[number]) ||
      SUPPORTED_IMAGE_MIME_TYPES.includes(mimeType as typeof SUPPORTED_IMAGE_MIME_TYPES[number])
    );
  }

  /**
   * 估算轉換後的 Token 消耗
   *
   * @description
   *   GPT-4V 圖片 Token 計算規則：
   *   - 512x512 以下: 85 tokens
   *   - 512x512 以上: 85 + ceil(width/512) * ceil(height/512) * 170
   *
   * @param pageCount - 頁數
   * @param averageSize - 平均頁面尺寸（預設 1024x1024）
   * @returns 預估 Token 數
   */
  static estimateTokenUsage(
    pageCount: number,
    averageSize: { width: number; height: number } = { width: 1024, height: 1024 }
  ): number {
    const tilesX = Math.ceil(averageSize.width / 512);
    const tilesY = Math.ceil(averageSize.height / 512);
    const tokensPerPage = 85 + tilesX * tilesY * 170;
    return pageCount * tokensPerPage;
  }
}

// ============================================================================
// Convenience Functions
// ============================================================================

/**
 * 快速轉換 PDF 為 Base64 圖片陣列
 */
export async function convertPdfToBase64Images(
  buffer: Buffer,
  config?: PdfConversionConfig
): Promise<PdfConversionResult> {
  return PdfConverter.convertToBase64Images(buffer, config);
}

/**
 * 快速轉換圖片為 Base64
 */
export async function convertImageToBase64(
  buffer: Buffer,
  mimeType: string,
  config?: PdfConversionConfig
): Promise<PdfConversionResult> {
  return PdfConverter.convertImageToBase64(buffer, mimeType, config);
}

/**
 * 自動檢測並轉換文件為 Base64
 */
export async function convertToBase64(
  buffer: Buffer,
  mimeType: string,
  config?: PdfConversionConfig
): Promise<PdfConversionResult> {
  return PdfConverter.convertToBase64(buffer, mimeType, config);
}
