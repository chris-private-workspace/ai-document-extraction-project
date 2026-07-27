/**
 * @fileoverview Document Status Configuration
 * @description
 *   定義文件處理狀態的顯示配置：
 *   - 狀態標籤（中英文）
 *   - 圖標和顏色
 *   - 狀態屬性（是否處理中、是否錯誤、是否可重試）
 *
 * @module src/lib/document-status
 * @author Development Team
 * @since Epic 2 - Story 2.7 (Processing Status Tracking & Display)
 * @lastModified 2026-07-20 (FIX-117: 補齊 APPROVED / ESCALATED 狀態)
 *
 * @features
 *   - 14 種文件狀態配置（與 Prisma DocumentStatus enum 一一對應）
 *   - 狀態查詢輔助函數
 *   - 處理階段計算
 *
 * @related
 *   - prisma/schema.prisma - DocumentStatus enum
 *   - src/components/features/document/ProcessingStatus.tsx - 狀態顯示組件
 */

import {
  Upload,
  Check,
  Scan,
  GitMerge,
  Clock,
  Eye,
  CheckCircle,
  XCircle,
  AlertCircle,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

// ============================================================
// Types
// ============================================================

/**
 * 文件狀態鍵值
 */
export type DocumentStatusKey =
  | 'UPLOADING'
  | 'UPLOADED'
  | 'OCR_PROCESSING'
  | 'OCR_COMPLETED'
  | 'OCR_FAILED'
  | 'MAPPING_PROCESSING'
  | 'MAPPING_COMPLETED'
  | 'PENDING_REVIEW'
  | 'IN_REVIEW'
  | 'REF_MATCH_FAILED'
  | 'APPROVED'
  | 'ESCALATED'
  | 'COMPLETED'
  | 'FAILED'

/**
 * 狀態配置
 */
export interface StatusConfig {
  /** 英文標籤 */
  label: string
  /** 中文標籤 */
  labelZh: string
  /** 圖標組件 */
  icon: LucideIcon
  /** 顏色名稱 */
  color: string
  /** 背景色 class */
  bgColor: string
  /** 文字色 class */
  textColor: string
  /** 是否處理中 */
  isProcessing: boolean
  /** 是否錯誤狀態 */
  isError: boolean
  /** 是否可重試 */
  canRetry: boolean
  /** 排序順序 */
  order: number
}

// ============================================================
// Constants
// ============================================================

/**
 * 文件狀態配置表
 */
export const DOCUMENT_STATUS_CONFIG: Record<DocumentStatusKey, StatusConfig> = {
  UPLOADING: {
    label: 'Uploading',
    labelZh: '上傳中',
    icon: Upload,
    color: 'blue',
    bgColor: 'bg-blue-100',
    textColor: 'text-blue-700',
    isProcessing: true,
    isError: false,
    canRetry: false,
    order: 1,
  },
  UPLOADED: {
    label: 'Uploaded',
    labelZh: '已上傳',
    icon: Check,
    color: 'green',
    bgColor: 'bg-green-100',
    textColor: 'text-green-700',
    isProcessing: false,
    isError: false,
    canRetry: false,
    order: 2,
  },
  OCR_PROCESSING: {
    label: 'OCR Processing',
    labelZh: 'OCR 處理中',
    icon: Scan,
    color: 'blue',
    bgColor: 'bg-blue-100',
    textColor: 'text-blue-700',
    isProcessing: true,
    isError: false,
    canRetry: false,
    order: 3,
  },
  OCR_COMPLETED: {
    label: 'OCR Completed',
    labelZh: 'OCR 完成',
    icon: Check,
    color: 'green',
    bgColor: 'bg-green-100',
    textColor: 'text-green-700',
    isProcessing: false,
    isError: false,
    canRetry: false,
    order: 4,
  },
  OCR_FAILED: {
    label: 'OCR Failed',
    labelZh: 'OCR 失敗',
    icon: AlertCircle,
    color: 'red',
    bgColor: 'bg-red-100',
    textColor: 'text-red-700',
    isProcessing: false,
    isError: true,
    canRetry: true,
    order: 5,
  },
  MAPPING_PROCESSING: {
    label: 'Mapping',
    labelZh: '映射中',
    icon: GitMerge,
    color: 'blue',
    bgColor: 'bg-blue-100',
    textColor: 'text-blue-700',
    isProcessing: true,
    isError: false,
    canRetry: false,
    order: 6,
  },
  MAPPING_COMPLETED: {
    label: 'Mapping Completed',
    labelZh: '映射完成',
    icon: Check,
    color: 'green',
    bgColor: 'bg-green-100',
    textColor: 'text-green-700',
    isProcessing: false,
    isError: false,
    canRetry: false,
    order: 7,
  },
  REF_MATCH_FAILED: {
    label: 'Ref Match Failed',
    labelZh: '參考編號匹配失敗',
    icon: AlertCircle,
    color: 'orange',
    bgColor: 'bg-orange-100',
    textColor: 'text-orange-700',
    isProcessing: false,
    isError: true,
    canRetry: true,
    order: 8,
  },
  PENDING_REVIEW: {
    label: 'Pending Review',
    labelZh: '待審核',
    icon: Clock,
    color: 'yellow',
    bgColor: 'bg-yellow-100',
    textColor: 'text-yellow-700',
    isProcessing: false,
    isError: false,
    canRetry: false,
    order: 9,
  },
  IN_REVIEW: {
    label: 'In Review',
    labelZh: '審核中',
    icon: Eye,
    color: 'blue',
    bgColor: 'bg-blue-100',
    textColor: 'text-blue-700',
    isProcessing: true,
    isError: false,
    canRetry: false,
    order: 10,
  },
  COMPLETED: {
    label: 'Completed',
    labelZh: '已完成',
    icon: CheckCircle,
    color: 'green',
    bgColor: 'bg-green-100',
    textColor: 'text-green-700',
    isProcessing: false,
    isError: false,
    canRetry: false,
    order: 11,
  },
  FAILED: {
    label: 'Failed',
    labelZh: '處理失敗',
    icon: XCircle,
    color: 'red',
    bgColor: 'bg-red-100',
    textColor: 'text-red-700',
    isProcessing: false,
    isError: true,
    canRetry: true,
    order: 12,
  },
  // FIX-117: APPROVED / ESCALATED 存在於 Prisma DocumentStatus 但先前漏在本表外。
  //          getStatusConfig 對未知狀態回退到 FAILED 配置，導致這兩種狀態
  //          被顯示成紅色「處理失敗」徽章並帶出重試按鈕。
  APPROVED: {
    label: 'Approved',
    labelZh: '已核准',
    icon: Check,
    color: 'green',
    bgColor: 'bg-green-100',
    textColor: 'text-green-700',
    isProcessing: false,
    isError: false,
    canRetry: false,
    order: 13,
  },
  ESCALATED: {
    label: 'Escalated',
    labelZh: '已升級',
    icon: AlertCircle,
    color: 'orange',
    bgColor: 'bg-orange-100',
    textColor: 'text-orange-700',
    isProcessing: false,
    isError: false,
    canRetry: false,
    order: 14,
  },
}

// ============================================================
// Helper Functions
// ============================================================

/**
 * 根據狀態鍵獲取配置
 *
 * @param status - 狀態鍵值
 * @returns 狀態配置，未找到時返回 FAILED 配置
 *
 * @example
 * ```typescript
 * const config = getStatusConfig('OCR_PROCESSING')
 * console.log(config.labelZh) // 'OCR 處理中'
 * ```
 */
export function getStatusConfig(status: string): StatusConfig {
  return (
    DOCUMENT_STATUS_CONFIG[status as DocumentStatusKey] ||
    DOCUMENT_STATUS_CONFIG.FAILED
  )
}

/**
 * 檢查是否有處理中的文件
 *
 * @param statuses - 狀態列表
 * @returns 是否有處理中的文件
 *
 * @example
 * ```typescript
 * const hasProcessing = hasProcessingDocuments(['UPLOADING', 'COMPLETED'])
 * console.log(hasProcessing) // true
 * ```
 */
export function hasProcessingDocuments(statuses: string[]): boolean {
  return statuses.some((status) => {
    const config = getStatusConfig(status)
    return config.isProcessing
  })
}

/**
 * 獲取處理階段編號（用於進度顯示）
 *
 * @param status - 狀態鍵值
 * @returns 階段編號（1-5），失敗返回 0
 *
 * @example
 * ```typescript
 * const stage = getProcessingStage('MAPPING_PROCESSING')
 * console.log(stage) // 3
 * ```
 */
export function getProcessingStage(status: string): number {
  const stages: Record<string, number> = {
    UPLOADING: 1,
    UPLOADED: 1,
    OCR_PROCESSING: 2,
    OCR_COMPLETED: 2,
    OCR_FAILED: 2,
    MAPPING_PROCESSING: 3,
    MAPPING_COMPLETED: 3,
    REF_MATCH_FAILED: 3,
    PENDING_REVIEW: 4,
    IN_REVIEW: 4,
    COMPLETED: 5,
    FAILED: 0,
  }
  return stages[status] || 0
}

/**
 * 檢查狀態是否可重試
 *
 * @param status - 狀態鍵值
 * @returns 是否可重試
 */
export function canRetryStatus(status: string): boolean {
  const config = getStatusConfig(status)
  return config.canRetry
}

/**
 * 獲取所有處理中的狀態
 *
 * @returns 處理中狀態列表
 */
export function getProcessingStatuses(): DocumentStatusKey[] {
  return (Object.keys(DOCUMENT_STATUS_CONFIG) as DocumentStatusKey[]).filter(
    (key) => DOCUMENT_STATUS_CONFIG[key].isProcessing
  )
}

/**
 * 獲取所有錯誤狀態
 *
 * @returns 錯誤狀態列表
 */
export function getErrorStatuses(): DocumentStatusKey[] {
  return (Object.keys(DOCUMENT_STATUS_CONFIG) as DocumentStatusKey[]).filter(
    (key) => DOCUMENT_STATUS_CONFIG[key].isError
  )
}
