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
  /**
   * 是否依內容文字方向自動把側躺頁面轉正（預設 true）
   *
   * @description
   *   保留開關是因為轉正是**啟發式**判斷，且它改變的是送進 GPT 的圖像本身。
   *   若某類文件被誤判，可用此旗標即時關閉（Azure 部署為手動重建映像，
   *   沒有旗標就得改碼重建）。
   *
   * @see detectTextRotation
   * @since CHANGE-113 階段一 A3
   */
  autoRotatePages?: boolean;
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
  /**
   * 實際被轉正的頁面（CHANGE-113 階段一 A3）
   *
   * @description
   *   只列出真的有旋轉的頁；沒有任何頁需要轉正時為 undefined。
   *   供上層記入處理步驟資料，讓「這份文件到底有沒有轉正」可事後查證 ——
   *   否則轉正是否生效只能靠重新渲染比對。
   */
  rotatedPages?: Array<{ pageNumber: number; degrees: number }>;
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
 * 單頁從 pdfjs 取得的輔助資訊
 *
 * @description
 *   註解與文字方向都來自同一次 pdfjs 解析 —— 分兩次開檔會重複付出 parse 成本。
 *
 * @since CHANGE-113 階段一 A3
 */
interface PageHints {
  annotations: CollectedAnnotation[];
  /** 內容文字方向（PDF 空間，逆時針角度）；0 代表已是正的 */
  rotation: PageRotation;
}

/**
 * 頁面內容方向（PDF 空間逆時針角度）
 * @since CHANGE-113 階段一 A3
 */
export type PageRotation = 0 | 90 | 180 | 270;

/** 文字方向偏離 90 度倍數超過此角度即視為斜排，不列入統計 */
const TEXT_DIRECTION_TOLERANCE_DEG = 10;

/** 主方向須佔比多少才採信（低於此值代表方向混雜，寧可不轉） */
const ROTATION_DOMINANCE_RATIO = 0.6;

/** 可據以判斷方向的最少字元數（太少不足以代表整頁） */
const ROTATION_MIN_WEIGHT = 20;

/**
 * 從文字項目的變換矩陣推斷整頁內容方向
 *
 * @description
 *   CHANGE-113 階段一 A3。有些 PDF 的 `/Rotate` 是 0、頁面尺寸也是直向，但**內容
 *   本身**是橫向表格側著排進去的（實測 DHL 發票第 2 頁即如此：612×792 直向、
 *   `p.rotate=0`，但整頁文字躺著）。pdfjs 照 PDF 描述渲染完全正確，無從得知該轉正，
 *   於是送進 GPT 的是一張側躺的圖 —— 實測 GPT 讀側躺小字會出錯（AWB `8365573366`
 *   被讀成 `88557336`），也讀不準每列對應的 shipment。
 *
 *   判斷依據是每個文字項目變換矩陣的 `[a, b]`（書寫方向向量），取其角度後歸入
 *   0/90/180/270 四個方向，以字元數加權統計主方向。
 *
 *   **保守設計**（寧可不轉，不可轉錯）：
 *   - 斜排文字（偏離 90 度倍數超過 {@link TEXT_DIRECTION_TOLERANCE_DEG}）不計入
 *   - 主方向佔比未達 {@link ROTATION_DOMINANCE_RATIO} → 回 0（方向混雜）
 *   - 可用字元數少於 {@link ROTATION_MIN_WEIGHT} → 回 0
 *   - 掃描件（無文字層）items 為空 → 回 0，行為與改動前完全一致
 *
 * @param items - pdfjs `getTextContent()` 的文字項目
 * @returns 內容方向；0 代表不需轉正
 *
 * @since CHANGE-113 階段一 A3
 */
export function detectTextRotation(
  items: Array<{ transform?: number[]; str?: string }>
): PageRotation {
  const weights = new Map<PageRotation, number>([
    [0, 0],
    [90, 0],
    [180, 0],
    [270, 0],
  ]);
  let total = 0;

  for (const item of items) {
    const transform = item.transform;
    if (!transform || transform.length < 4) continue;

    // 以字元數加權：一頁的方向該由「多數文字」決定，而非項目個數
    // （一個長句與一個孤立字元對版面的代表性差很多）
    const weight = (item.str ?? '').trim().length;
    if (weight === 0) continue;

    const [a, b] = transform;
    if (a === 0 && b === 0) continue;

    const degrees = normalizeDegrees((Math.atan2(b, a) * 180) / Math.PI);
    const bucket = (Math.round(degrees / 90) * 90) % 360;
    if (circularDistance(degrees, bucket) > TEXT_DIRECTION_TOLERANCE_DEG) continue;

    const key = bucket as PageRotation;
    weights.set(key, (weights.get(key) ?? 0) + weight);
    total += weight;
  }

  if (total < ROTATION_MIN_WEIGHT) return 0;

  let best: PageRotation = 0;
  let bestWeight = 0;
  for (const [bucket, weight] of weights) {
    if (weight > bestWeight) {
      bestWeight = weight;
      best = bucket;
    }
  }

  return bestWeight / total >= ROTATION_DOMINANCE_RATIO ? best : 0;
}

/**
 * 由 FreeText 註解的旋轉角推斷頁面內容方向
 *
 * @description
 *   CHANGE-113 階段一 A3 的**備援**訊號，用於掃描件。
 *
 *   實測（2026-07-29，DHL_RCIM250111_28699.pdf）：該 PDF 兩頁都是純掃描圖，
 *   `getTextContent()` 回傳 `items: []` —— {@link detectTextRotation} 完全取不到
 *   訊號。但同一份文件的 FreeText 註解帶著 `rotation: 90`：使用者在側躺的頁面上
 *   補註時，會把文字方塊轉到與內容同向才寫得下去。**那個角度就是內容的方向。**
 *
 *   訊號強度不如文字層（是使用者行為的間接證據，而非內容本身），因此只在
 *   文字層取不到方向時才採用。
 *
 *   保守設計：採信的方向必須由**過半**註解共同支持，否則回 0。單一註解與
 *   其他註解方向不一致時（例如一橫一直）視為無法判斷，寧可不轉。
 *
 * @param annotations - 該頁的 FreeText 註解
 * @returns 內容方向；0 代表不需轉正
 *
 * @since CHANGE-113 階段一 A3
 */
export function detectAnnotationRotation(
  annotations: Array<{ rotation?: number }>
): PageRotation {
  if (annotations.length === 0) return 0;

  const counts = new Map<PageRotation, number>();
  for (const annotation of annotations) {
    const raw = annotation.rotation ?? 0;
    if (!Number.isFinite(raw)) continue;
    const bucket = normalizeDegrees(Math.round(raw / 90) * 90) as PageRotation;
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }

  let best: PageRotation = 0;
  let bestCount = 0;
  for (const [bucket, count] of counts) {
    if (count > bestCount) {
      bestCount = count;
      best = bucket;
    }
  }

  return bestCount * 2 > annotations.length ? best : 0;
}

/** 角度正規化到 [0, 360) */
function normalizeDegrees(degrees: number): number {
  return ((degrees % 360) + 360) % 360;
}

/** 兩角度之間的最短距離（度），處理 359 與 0 只差 1 度的環狀情形 */
function circularDistance(a: number, b: number): number {
  const diff = Math.abs(a - b) % 360;
  return Math.min(diff, 360 - diff);
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
  /**
   * 註解本身的旋轉角度（PDF `/Rotate`，逆時針度數）
   * @since CHANGE-113 階段一 A3
   */
  rotation?: number;
}

interface PdfjsViewport {
  convertToViewportRectangle(rect: number[]): number[];
}

/**
 * pdfjs `getTextContent()` 的文字項目（僅取用到的欄位）
 * @since CHANGE-113 階段一 A3
 */
interface PdfjsTextItem {
  /** 文字變換矩陣 [a, b, c, d, e, f]，`[a, b]` 為書寫方向向量 */
  transform?: number[];
  str?: string;
}

interface PdfjsTextContent {
  items: PdfjsTextItem[];
}

interface PdfjsPage {
  getViewport(params: { scale: number }): PdfjsViewport;
  getAnnotations(params: { intent: string }): Promise<PdfjsAnnotation[]>;
  getTextContent(): Promise<PdfjsTextContent>;
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
  autoRotatePages: true,
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
      const rotatedPages: Array<{ pageNumber: number; degrees: number }> = [];
      let pageCount = 0;

      const scale = mergedConfig.dpi / 72; // 72 DPI 是 PDF 基準

      // CHANGE-113 階段一：從 pdfjs 取兩項輔助資訊 ——
      //   A. FreeText 註解：使用者以此補充的資訊（如 DHL 發票每列對應的 shipment）
      //      不在頁面內容裡，靠 OCR 取不到
      //   B. 內容文字方向：判斷整頁是否側躺、需要轉正
      // 兩者共用同一次解析。失敗僅記 warning，不影響主要的轉圖流程。
      const hintsByPage =
        mergedConfig.paintRotatedAnnotations || mergedConfig.autoRotatePages
          ? await this.collectPageHints(buffer, scale, warnings)
          : new Map<number, PageHints>();

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

        const hints = hintsByPage.get(pageCount);
        const pageRotation = mergedConfig.autoRotatePages
          ? (hints?.rotation ?? 0)
          : 0;

        // CHANGE-113 階段一 A：補畫 pdfjs 渲染不出來的旋轉 FreeText 註解。
        // 必須在轉正與壓縮之前 —— 註解座標以未縮放、未旋轉的原始圖像為基準。
        const pageAnnotations = mergedConfig.paintRotatedAnnotations
          ? hints?.annotations
          : undefined;
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
            imageBuffer = await this.paintAnnotations(
              imageBuffer,
              toPaint,
              pageRotation,
              warnings
            );
          }
        }

        // CHANGE-113 階段一 A3：把側躺的頁面轉正。必須在補畫之後（座標基準）、
        // 壓縮之前（maxWidth 要套用在最終送給 GPT 的那個方向上）。
        if (pageRotation !== 0) {
          const rotated = await this.rotateImage(imageBuffer, pageRotation, warnings);
          if (rotated !== imageBuffer) {
            imageBuffer = rotated;
            rotatedPages.push({ pageNumber: pageCount, degrees: pageRotation });
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
        rotatedPages: rotatedPages.length > 0 ? rotatedPages : undefined,
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
   * 抽出各頁的 FreeText 註解與內容文字方向
   *
   * @description
   *   CHANGE-113 階段一。一次 pdfjs 解析同時取得兩項資訊：
   *
   *   **A. FreeText 註解**（階段一 A）：使用者常以 PDF 註解在文件上補充系統無法從
   *   原始內容得知的資訊（DHL 發票標註每一列對應哪個 shipment 即是一例）。
   *   pdfjs 對 FreeText 一律以水平方向排版：當註解框是「直立」的（高 > 寬），代表
   *   原編輯器以旋轉方向排版文字，pdfjs 排不進去而把文字裁掉，結果只畫出邊框、
   *   內容消失。橫向框則正常渲染，不可重複補畫 —— 否則會疊字、反而蓋掉原本清楚
   *   的內容（2026-07-29 以三份真實 DHL 文件實測確認）。
   *
   *   **B. 內容文字方向**（階段一 B）：見 {@link detectTextRotation}。
   *
   *   任何失敗都只記 warning：兩者都是加分資訊，不該讓整份文件轉檔失敗。
   *
   * @param buffer - PDF 原始 buffer
   * @param scale - 與 pdf-to-img 相同的縮放比例，確保座標對得上
   * @param warnings - 警告收集器（就地追加）
   * @returns 頁碼（1-based）→ 該頁輔助資訊
   *
   * @since CHANGE-113 階段一 A（階段一 B 加入方向偵測）
   */
  private static async collectPageHints(
    buffer: Buffer,
    scale: number,
    warnings: string[]
  ): Promise<Map<number, PageHints>> {
    const result = new Map<number, PageHints>();
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

        // 方向訊號優先序：內容文字層 > 註解旋轉角。
        // 前者是內容本身，後者是使用者行為的間接證據 —— 但掃描件只有後者。
        const textContent = await page.getTextContent();
        const rotation =
          detectTextRotation(textContent.items) || detectAnnotationRotation(freeTexts);

        if (freeTexts.length === 0) {
          // 沒有註解但方向不正時仍要記錄 —— 轉正與註解是獨立的兩件事
          if (rotation !== 0) result.set(pageNumber, { annotations: [], rotation });
          continue;
        }

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

        if (collected.length > 0 || rotation !== 0) {
          result.set(pageNumber, { annotations: collected, rotation });
        }
      }
    } catch (error) {
      warnings.push(
        `讀取 PDF 註解／文字方向失敗（不影響轉檔）：${error instanceof Error ? error.message : '未知錯誤'}`
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
    // FIX-146: 最後這一步必須是「打包器看不見的」原生 import。
    // 直接寫 `import(變數)` 時 webpack 判定無法靜態分析，會把整個呼叫替換成
    // missing-module stub（`__webpack_require__(54385)`），它對任何傳入路徑
    // 無條件拋 MODULE_NOT_FOUND —— 上面的 req.resolve 仍然成功，只有載入這一步
    // 失效，而錯誤又被 collectPageHints 的 catch 收成 warning，於是 A1/A2/A3
    // 三項一起靜默失效。dev 模式保留原生 import，所以此缺陷只在 next build 後出現。
    const nativeImport = new Function('specifier', 'return import(specifier)') as (
      specifier: string
    ) => Promise<{
      getDocument: (params: {
        data: Uint8Array;
        verbosity: number;
      }) => { promise: Promise<unknown> };
    }>;
    return nativeImport(pathToFileURL(pdfjsPath).href);
  }

  /**
   * 將註解文字補畫到頁面圖像上
   *
   * @description
   *   CHANGE-113 階段一 A。僅處理 collectPageHints 判定需補畫者。
   *   文字沿矩形長邊排列，與文件其餘內容方向一致。
   *
   *   `pageRotation` 決定直立框該往哪一邊轉：頁面內容方向 270 度時往 +90 度轉，
   *   其餘往 -90 度轉。若不看頁面方向一律 -90 度，270 度的頁面轉正之後補畫的
   *   文字會上下顛倒 —— 補了等於沒補（階段一 B 加入轉正後才會遇到的情形）。
   *   橫向框不在補畫範圍內（`needsPaint` 恆為 false），故不需處理 0 / 180 度。
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
    pageRotation: PageRotation,
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
        if (vertical) {
          ctx.rotate(pageRotation === 270 ? Math.PI / 2 : -Math.PI / 2);
        }
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

  /**
   * 依偵測到的內容方向把頁面圖像轉正
   *
   * @description
   *   CHANGE-113 階段一 A3。PDF 空間為 y 軸向上、渲染後的圖像為 y 軸向下，因此
   *   內容方向為「逆時針 θ 度」時，圖像要**順時針轉 θ 度**才會正 ——
   *   sharp 的 `rotate(角度)` 正值即為順時針，可直接傳入。
   *
   *   sharp 不可用時（與 compressImage 同樣的既有情形）回傳原圖，不阻斷轉檔。
   *
   * @param buffer - 頁面圖像（已補畫註解）
   * @param degrees - 內容方向，必為 90 / 180 / 270
   * @param warnings - 警告收集器（就地追加）
   * @returns 轉正後的圖像；失敗時為傳入的原圖（呼叫端以此判斷是否真的轉過）
   *
   * @since CHANGE-113 階段一 A3
   */
  private static async rotateImage(
    buffer: Buffer,
    degrees: PageRotation,
    warnings: string[]
  ): Promise<Buffer> {
    try {
      const sharp = (await import('sharp')).default;
      return await sharp(buffer).rotate(degrees).toBuffer();
    } catch (error) {
      warnings.push(
        `頁面轉正失敗（沿用原方向）：${error instanceof Error ? error.message : '未知錯誤'}`
      );
      return buffer;
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
