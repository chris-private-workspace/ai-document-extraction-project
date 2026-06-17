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
      let pageCount = 0;

      // 使用 pdf-to-img 轉換
      const document = await pdf(buffer, {
        scale: mergedConfig.dpi / 72, // 72 DPI 是 PDF 基準
      });

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

        // 可選壓縮處理
        if (mergedConfig.compress) {
          imageBuffer = await this.compressImage(
            page,
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
      }

      return {
        success: true,
        images,
        pageCount,
        processingTimeMs: Date.now() - startTime,
        warnings: warnings.length > 0 ? warnings : undefined,
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
