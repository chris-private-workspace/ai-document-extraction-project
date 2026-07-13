/**
 * @fileoverview 文件上傳配置和驗證常數
 * @description
 *   定義文件上傳的配置參數和驗證函數：
 *   - 允許的文件類型 (PDF, JPG, PNG)
 *   - 文件大小限制 (10MB)
 *   - 批量上傳限制 (20 files)
 *   - 驗證輔助函數
 *
 * @module src/lib/upload/constants
 * @since Epic 2 - Story 2.1 (File Upload Interface)
 * @lastModified 2025-12-18
 *
 * @related
 *   - src/app/api/documents/upload/route.ts - 使用這些常數驗證上傳
 *   - src/components/features/document/FileUploader.tsx - 使用這些常數配置 Dropzone
 */

// ===========================================
// Upload Configuration
// ===========================================

/**
 * 上傳配置常數
 *
 * @description 定義文件上傳的所有限制和配置
 */
export const UPLOAD_CONFIG = {
  /** 允許的 MIME 類型 */
  ALLOWED_TYPES: [
    'application/pdf',
    'image/jpeg',
    'image/png',
  ] as const,

  /** 允許的文件擴展名 */
  ALLOWED_EXTENSIONS: ['.pdf', '.jpg', '.jpeg', '.png'] as const,

  /** 最大文件大小 (bytes) - 10MB */
  MAX_FILE_SIZE: 10 * 1024 * 1024,

  /** 最大文件大小顯示文字 */
  MAX_FILE_SIZE_DISPLAY: '10MB',

  /**
   * 每批次最大文件數量
   *
   * FIX-106: 由 20 降為 15。上傳後所有文件會在 upload/route.ts 被同時投入處理，
   * 20 份曾使 App Service 記憶體達 95%、事件迴圈凍結，導致 pg 連線握手逾時。
   * 此值僅降低峰值，未移除觸發機制 —— 治本需限制併發處理數。
   */
  MAX_FILES_PER_BATCH: 15,

  /**
   * 自動處理管線的併發上限（FIX-106 治本）
   *
   * 上傳後文件在 upload/route.ts 分批投入處理，每批最多同時處理此數量。
   * 這才是真正綁住「同時載入記憶體的 PDF 數」的旋鈕 —— MAX_FILES_PER_BATCH
   * 只限制單次上傳份數，處理仍是全部併發。避免一次過多 buffer／圖片轉換／
   * base64 耗盡 App Service 記憶體、凍結事件迴圈。
   */
  PROCESS_CONCURRENCY: 3,

  /** UI 顯示用的接受格式標籤 */
  ACCEPT_LABEL: 'PDF, JPG, PNG',
} as const;

/**
 * 允許的 MIME 類型
 */
export type AllowedMimeType = typeof UPLOAD_CONFIG.ALLOWED_TYPES[number];

/**
 * 允許的文件擴展名
 */
export type AllowedExtension = typeof UPLOAD_CONFIG.ALLOWED_EXTENSIONS[number];

// ===========================================
// Validation Functions
// ===========================================

/**
 * 檢查 MIME 類型是否允許
 *
 * @param mimeType - 文件的 MIME 類型
 * @returns true 如果類型允許
 *
 * @example
 * ```typescript
 * isAllowedType('application/pdf'); // true
 * isAllowedType('application/doc'); // false
 * ```
 */
export function isAllowedType(mimeType: string): mimeType is AllowedMimeType {
  return UPLOAD_CONFIG.ALLOWED_TYPES.includes(mimeType as AllowedMimeType);
}

/**
 * 檢查文件大小是否在限制內
 *
 * @param sizeInBytes - 文件大小 (bytes)
 * @returns true 如果大小允許
 *
 * @example
 * ```typescript
 * isAllowedSize(5 * 1024 * 1024); // true (5MB)
 * isAllowedSize(15 * 1024 * 1024); // false (15MB > 10MB)
 * ```
 */
export function isAllowedSize(sizeInBytes: number): boolean {
  return sizeInBytes <= UPLOAD_CONFIG.MAX_FILE_SIZE;
}

/**
 * 從 MIME 類型獲取文件擴展名
 *
 * @param mimeType - 文件的 MIME 類型
 * @returns 文件擴展名 (不含點號)
 *
 * @example
 * ```typescript
 * getExtensionFromMime('application/pdf'); // 'pdf'
 * getExtensionFromMime('image/jpeg'); // 'jpg'
 * getExtensionFromMime('image/png'); // 'png'
 * ```
 */
export function getExtensionFromMime(mimeType: string): string {
  const mimeToExt: Record<string, string> = {
    'application/pdf': 'pdf',
    'image/jpeg': 'jpg',
    'image/png': 'png',
  };
  return mimeToExt[mimeType] || 'unknown';
}

/**
 * 格式化文件大小為可讀字符串
 *
 * @param bytes - 文件大小 (bytes)
 * @returns 格式化後的字符串
 *
 * @example
 * ```typescript
 * formatFileSize(1024); // '1.0 KB'
 * formatFileSize(1024 * 1024); // '1.0 MB'
 * ```
 */
export function formatFileSize(bytes: number | undefined | null): string {
  // 防禦性檢查：處理 undefined、null、NaN 的情況
  if (bytes === undefined || bytes === null || isNaN(bytes)) {
    return '未知大小';
  }
  if (bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ===========================================
// Error Messages
// ===========================================

/**
 * 上傳錯誤訊息
 *
 * @description 提供用戶友好的繁體中文錯誤訊息
 */
export const UPLOAD_ERRORS = {
  /** 不支援的文件格式 */
  INVALID_TYPE: `不支援的文件格式，請上傳 ${UPLOAD_CONFIG.ACCEPT_LABEL}`,

  /** 文件太大 */
  FILE_TOO_LARGE: `文件大小超過限制 (${UPLOAD_CONFIG.MAX_FILE_SIZE_DISPLAY})`,

  /** 文件太多 */
  TOO_MANY_FILES: `最多只能上傳 ${UPLOAD_CONFIG.MAX_FILES_PER_BATCH} 個文件`,

  /** 上傳失敗 */
  UPLOAD_FAILED: '文件上傳失敗，請重試',

  /** 沒有選擇文件 */
  NO_FILES: '請選擇要上傳的文件',

  /** 未授權 */
  UNAUTHORIZED: '請先登入',

  /** 無權限 */
  FORBIDDEN: '您沒有上傳發票的權限',
} as const;

// ===========================================
// Dropzone Configuration
// ===========================================

/**
 * react-dropzone 接受格式配置
 *
 * @description 用於 react-dropzone 的 accept 屬性
 */
export const DROPZONE_ACCEPT = {
  'application/pdf': ['.pdf'],
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/png': ['.png'],
} as const;
