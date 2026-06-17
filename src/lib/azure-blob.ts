/**
 * @fileoverview Azure Blob Storage 服務
 * @description
 *   提供 Azure Blob Storage 的上傳、刪除和 SAS URL 生成功能
 *   - 用於 Forwarder Logo 上傳（File 上傳）
 *   - 用於報表檔案上傳（Buffer 上傳）
 *   - 支援圖片檔案上傳
 *   - 提供刪除和 SAS URL 生成
 *
 * @module src/lib/azure-blob
 * @since Epic 5 - Story 5.5
 * @lastModified 2025-12-19
 *
 * @features
 *   - File 上傳（圖片）
 *   - Buffer 上傳（報表）
 *   - 刪除 Blob
 *   - 生成 SAS URL（時間或日期過期）
 */

import { BlobServiceClient, BlobSASPermissions, ContainerClient } from '@azure/storage-blob'
import { v4 as uuidv4 } from 'uuid'

// =====================
// Configuration
// =====================

const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING
const containerName = process.env.AZURE_STORAGE_CONTAINER || 'documents'

let containerClient: ContainerClient | null = null

// =====================
// Helper Functions
// =====================

/**
 * 獲取或初始化 Container Client
 * @returns Container Client 實例
 */
async function getContainerClient(): Promise<ContainerClient> {
  if (!containerClient) {
    if (!connectionString) {
      throw new Error('AZURE_STORAGE_CONNECTION_STRING is not configured')
    }

    const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString)
    containerClient = blobServiceClient.getContainerClient(containerName)

    // 確保 container 存在（private container，不要求匿名公開存取）。
    // 鎖定環境的 Storage 帳號已停用公開 blob 存取，帶 access:'blob' 會被回
    // PublicAccessNotPermitted；文件一律透過伺服器端串流服務（FIX-078）。
    await containerClient.createIfNotExists()
  }
  return containerClient
}

/**
 * 驗證檔案類型是否為允許的圖片格式
 * @param contentType - MIME type
 * @returns 是否為允許的圖片格式
 */
function isAllowedImageType(contentType: string): boolean {
  const allowedTypes = [
    'image/png',
    'image/jpeg',
    'image/jpg',
    'image/webp',
    'image/gif',
    'image/svg+xml'
  ]
  return allowedTypes.includes(contentType.toLowerCase())
}

// =====================
// Public Functions
// =====================

/**
 * 上傳檔案到 Azure Blob Storage
 * @param file - 要上傳的檔案
 * @param path - 路徑前綴（例如 'forwarders/DHL/logo'）
 * @returns 上傳後的 Blob URL
 * @throws Error 如果上傳失敗或檔案類型不允許
 */
export async function uploadToBlob(file: File, path: string): Promise<string> {
  // 驗證檔案類型
  if (!isAllowedImageType(file.type)) {
    throw new Error(`不支援的檔案類型: ${file.type}。只允許 PNG、JPG、WebP、GIF、SVG 格式`)
  }

  // 驗證檔案大小（最大 5MB）
  const maxSize = 5 * 1024 * 1024
  if (file.size > maxSize) {
    throw new Error(`檔案大小超過限制。最大允許 5MB，實際大小 ${(file.size / 1024 / 1024).toFixed(2)}MB`)
  }

  const container = await getContainerClient()

  // 生成唯一的 blob 名稱
  const extension = file.name.split('.').pop()?.toLowerCase() || 'png'
  const blobName = `${path}/${uuidv4()}.${extension}`

  // 獲取 blob client
  const blockBlobClient = container.getBlockBlobClient(blobName)

  // 將檔案轉換為 buffer
  const arrayBuffer = await file.arrayBuffer()
  const buffer = Buffer.from(arrayBuffer)

  // 上傳並設定 content type
  await blockBlobClient.uploadData(buffer, {
    blobHTTPHeaders: {
      blobContentType: file.type || 'image/png'
    }
  })

  return blockBlobClient.url
}

/**
 * 從 Azure Blob Storage 刪除檔案
 * @param url - 要刪除的 Blob 完整 URL
 * @description 刪除失敗時不會拋出錯誤，只會記錄到 console
 */
export async function deleteFromBlob(url: string): Promise<void> {
  try {
    const container = await getContainerClient()

    // 從 URL 提取 blob 名稱
    const urlObj = new URL(url)
    // URL 格式: https://account.blob.core.windows.net/container/path/to/blob
    // pathname 格式: /container/path/to/blob
    const pathParts = urlObj.pathname.split('/')
    // 移除開頭的空字串和 container 名稱
    const blobName = pathParts.slice(2).join('/')

    const blockBlobClient = container.getBlockBlobClient(blobName)
    await blockBlobClient.deleteIfExists()
  } catch (error) {
    // 刪除失敗不應該影響主要操作
    console.error('Error deleting blob:', error)
  }
}

/**
 * 生成 SAS URL 用於暫時訪問
 * @param blobName - Blob 名稱
 * @param expiresInMinutes - 過期時間（分鐘）
 * @returns SAS URL
 */
export async function generateSasUrl(
  blobName: string,
  expiresInMinutes: number = 60
): Promise<string> {
  const container = await getContainerClient()
  const blockBlobClient = container.getBlockBlobClient(blobName)

  const expiresOn = new Date()
  expiresOn.setMinutes(expiresOn.getMinutes() + expiresInMinutes)

  const sasUrl = await blockBlobClient.generateSasUrl({
    permissions: BlobSASPermissions.parse('r'),
    expiresOn
  })

  return sasUrl
}

/**
 * 從 Azure Blob Storage 下載文件為 Buffer
 * @description
 *   用於統一處理管線（Epic 15）：從 Blob 下載文件供處理器消費。
 *   將 Azure Blob 的 ReadableStream 轉換為 Node.js Buffer。
 *
 * @param blobName - Blob 名稱/路徑
 * @returns 文件內容的 Buffer
 * @throws Error 如果 blob 不存在或下載失敗
 *
 * @since CHANGE-014 Phase 2
 */
export async function downloadBlob(blobName: string): Promise<Buffer> {
  const container = await getContainerClient()
  const blobClient = container.getBlobClient(blobName)

  // 檢查 blob 是否存在
  const exists = await blobClient.exists()
  if (!exists) {
    throw new Error(`Blob not found: ${blobName}`)
  }

  const response = await blobClient.download(0)

  if (!response.readableStreamBody) {
    throw new Error(`Failed to get readable stream for blob: ${blobName}`)
  }

  // 將 ReadableStream 轉換為 Buffer
  const chunks: Buffer[] = []
  for await (const chunk of response.readableStreamBody) {
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

/**
 * 檢查 Azure Blob Storage 是否已配置
 * @returns 是否已配置
 */
export function isBlobStorageConfigured(): boolean {
  return !!connectionString
}

/**
 * 從 URL 提取 Blob 名稱
 * @param url - Blob URL
 * @returns Blob 名稱
 */
export function extractBlobNameFromUrl(url: string): string {
  try {
    const urlObj = new URL(url)
    const pathParts = urlObj.pathname.split('/')
    return pathParts.slice(2).join('/')
  } catch {
    return ''
  }
}

// =====================
// Report Functions (Story 7.4)
// =====================

/**
 * 上傳 Buffer 到 Azure Blob Storage（用於報表檔案）
 * @param buffer - 要上傳的 Buffer 數據
 * @param blobName - Blob 完整路徑名稱（例如 'reports/expense-report-xxx.xlsx'）
 * @param contentType - MIME type（例如 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'）
 * @returns 上傳後的 Blob 路徑名稱
 * @throws Error 如果上傳失敗
 */
export async function uploadBufferToBlob(
  buffer: Buffer,
  blobName: string,
  contentType: string
): Promise<string> {
  // 驗證 buffer 大小（最大 50MB）
  const maxSize = 50 * 1024 * 1024
  if (buffer.length > maxSize) {
    throw new Error(`檔案大小超過限制。最大允許 50MB，實際大小 ${(buffer.length / 1024 / 1024).toFixed(2)}MB`)
  }

  const container = await getContainerClient()
  const blockBlobClient = container.getBlockBlobClient(blobName)

  // 上傳並設定 content type
  await blockBlobClient.uploadData(buffer, {
    blobHTTPHeaders: {
      blobContentType: contentType
    }
  })

  return blobName
}

/**
 * 生成帶有指定過期時間的簽名 URL
 * @param blobName - Blob 名稱/路徑
 * @param expiresAt - 過期時間（Date 物件）
 * @returns 簽名後的 URL
 */
export async function generateSignedUrl(
  blobName: string,
  expiresAt: Date
): Promise<string> {
  const container = await getContainerClient()
  const blockBlobClient = container.getBlockBlobClient(blobName)

  const sasUrl = await blockBlobClient.generateSasUrl({
    permissions: BlobSASPermissions.parse('r'),
    expiresOn: expiresAt
  })

  return sasUrl
}

/**
 * 刪除 Blob（通過路徑名稱）
 * @param blobName - Blob 路徑名稱
 * @returns 是否刪除成功
 */
export async function deleteBlob(blobName: string): Promise<boolean> {
  try {
    const container = await getContainerClient()
    const blockBlobClient = container.getBlockBlobClient(blobName)
    await blockBlobClient.deleteIfExists()
    return true
  } catch (error) {
    console.error('Error deleting blob:', error)
    return false
  }
}

// =====================
// Traceability Functions (Story 8.4)
// =====================

/**
 * 儲存層級類型
 */
export type StorageLocation = 'active' | 'archive' | 'cold'

/**
 * 獲取檔案的儲存位置層級
 * @description
 *   根據 Blob 的存取層 (Access Tier) 判斷儲存位置：
 *   - Hot/Cool → active (一般存取)
 *   - Archive → archive (歸檔層)
 *   - 其他 → cold (冷儲存)
 *
 * @param blobPath - Blob 路徑名稱
 * @returns 儲存位置層級
 */
export async function getStorageLocation(blobPath: string): Promise<StorageLocation> {
  try {
    const container = await getContainerClient()
    const blockBlobClient = container.getBlockBlobClient(blobPath)

    // 獲取 Blob 屬性
    const properties = await blockBlobClient.getProperties()
    const accessTier = properties.accessTier?.toLowerCase()

    // 根據 Access Tier 判斷儲存層級
    if (accessTier === 'archive') {
      return 'archive'
    } else if (accessTier === 'cool' || accessTier === 'hot') {
      return 'active'
    } else if (accessTier === 'cold') {
      return 'cold'
    }

    // 預設為 active（如果沒有設定 tier）
    return 'active'
  } catch (error) {
    console.error('Error getting storage location:', error)
    // 如果無法獲取，假設為 active
    return 'active'
  }
}

/**
 * 從歸檔層恢復檔案
 * @description
 *   將 Archive 層級的 Blob 解凍到 Hot 層級。
 *   Azure Archive 層級的檔案需要解凍才能讀取，
 *   解凍通常需要數小時到 15 小時不等。
 *
 * @param blobPath - Blob 路徑名稱
 * @param priority - 解凍優先級 ('High' = 1-15小時, 'Standard' = 最多15小時)
 * @returns 是否成功發起解凍請求
 */
export async function retrieveFromArchive(
  blobPath: string,
  priority: 'High' | 'Standard' = 'High'
): Promise<boolean> {
  try {
    const container = await getContainerClient()
    const blockBlobClient = container.getBlockBlobClient(blobPath)

    // 檢查當前層級
    const properties = await blockBlobClient.getProperties()
    const accessTier = properties.accessTier?.toLowerCase()

    // 如果不是 archive 層級，不需要解凍
    if (accessTier !== 'archive') {
      return true
    }

    // 檢查是否已經在解凍中
    if (properties.archiveStatus === 'rehydrate-pending-to-hot' ||
        properties.archiveStatus === 'rehydrate-pending-to-cool') {
      // 已經在解凍中
      return true
    }

    // 發起解凍請求 - 將 Archive 層級的 Blob 移動到 Hot 層級
    await blockBlobClient.setAccessTier('Hot', {
      rehydratePriority: priority
    })

    return true
  } catch (error) {
    console.error('Error retrieving from archive:', error)
    return false
  }
}

/**
 * 檢查 Blob 是否正在解凍中
 * @param blobPath - Blob 路徑名稱
 * @returns 解凍狀態資訊
 */
export async function getRehydrationStatus(blobPath: string): Promise<{
  isRehydrating: boolean
  archiveStatus?: string
}> {
  try {
    const container = await getContainerClient()
    const blockBlobClient = container.getBlockBlobClient(blobPath)

    const properties = await blockBlobClient.getProperties()

    return {
      isRehydrating: properties.archiveStatus === 'rehydrate-pending-to-hot' ||
                     properties.archiveStatus === 'rehydrate-pending-to-cool',
      archiveStatus: properties.archiveStatus
    }
  } catch (error) {
    console.error('Error checking rehydration status:', error)
    return { isRehydrating: false }
  }
}

/**
 * 檢查 Blob 是否存在
 * @param blobPath - Blob 路徑名稱
 * @returns 是否存在
 */
export async function blobExists(blobPath: string): Promise<boolean> {
  try {
    const container = await getContainerClient()
    const blockBlobClient = container.getBlockBlobClient(blobPath)
    return await blockBlobClient.exists()
  } catch (error) {
    console.error('Error checking blob existence:', error)
    return false
  }
}
