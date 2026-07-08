/**
 * @fileoverview 資料庫 transient 連線錯誤重試工具
 * @description
 *   針對暫時性連線錯誤（如 "Connection terminated unexpectedly"、ECONNRESET）
 *   提供有限次數的指數退避重試。
 *
 *   ⚠️ 僅用於「冪等」的 DB 操作（如 status update、upsert），避免重試造成重複寫入。
 *   非暫時性錯誤（驗證錯、唯一鍵衝突等）會立即上拋、不重試。
 *
 * @module src/lib/db-retry
 * @since CHANGE-098 - DB 連線韌性與 transient 錯誤處理強化
 * @lastModified 2026-07-08
 *
 * @related
 *   - src/lib/prisma.ts - Prisma / pg Pool 單例
 *   - claudedocs/4-changes/feature-changes/CHANGE-098-db-connection-resilience.md
 */

/** 可重試的暫時性連線錯誤訊息片段（比對時大小寫不敏感） */
const TRANSIENT_MESSAGES = [
  'connection terminated unexpectedly',
  'connection terminated due to connection timeout',
  'connection terminated',
  'econnreset',
  'etimedout',
  'server closed the connection unexpectedly',
  'terminating connection due to administrator command',
]

/** 可重試的 PostgreSQL SQLSTATE 錯誤碼 */
const TRANSIENT_PG_CODES = new Set<string>([
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
  '08000', // connection_exception
  '08001', // sqlclient_unable_to_establish_sqlconnection
  '08003', // connection_does_not_exist
  '08006', // connection_failure
])

/**
 * 判斷錯誤是否為暫時性連線錯誤（可安全重試）。
 */
export function isTransientDbError(error: unknown): boolean {
  if (!error) {
    return false
  }

  // pg / prisma 錯誤可能帶 SQLSTATE code
  const code = (error as { code?: unknown }).code
  if (typeof code === 'string' && TRANSIENT_PG_CODES.has(code)) {
    return true
  }

  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : ''
  const lower = message.toLowerCase()
  return TRANSIENT_MESSAGES.some((m) => lower.includes(m))
}

/** withDbRetry 設定 */
export interface DbRetryOptions {
  /** 最大嘗試次數（含首次），預設 3 */
  attempts?: number
  /** 各次重試前的退避毫秒數，預設 [200, 500, 1000] */
  backoffMs?: number[]
  /** 操作標籤，用於日誌 */
  label?: string
  /** 判斷是否可重試，預設 isTransientDbError */
  isRetryable?: (error: unknown) => boolean
}

const DEFAULT_BACKOFF = [200, 500, 1000]

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 以有限次數的指數退避重試一個 DB 操作。
 *
 * ⚠️ 僅用於「冪等」操作，避免重試造成重複寫入。
 * 非暫時性錯誤會立即上拋、不重試；暫時性錯誤在耗盡次數後上拋最後一次錯誤。
 *
 * @param fn - 要執行的 DB 操作（每次嘗試都會重新呼叫）
 * @param options - 重試設定
 * @returns fn 的結果
 * @throws 最後一次嘗試的錯誤，或首個非暫時性錯誤
 */
export async function withDbRetry<T>(
  fn: () => Promise<T>,
  options: DbRetryOptions = {}
): Promise<T> {
  const attempts = options.attempts ?? 3
  const backoff = options.backoffMs ?? DEFAULT_BACKOFF
  const isRetryable = options.isRetryable ?? isTransientDbError
  const label = options.label ?? 'db-operation'

  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error

      // 非暫時性錯誤：立即上拋，不重試
      if (!isRetryable(error)) {
        throw error
      }

      // 已是最後一次嘗試：跳出迴圈後上拋
      if (attempt >= attempts) {
        break
      }

      const delay = backoff[attempt - 1] ?? backoff[backoff.length - 1] ?? 1000
      console.warn(
        `[withDbRetry] transient DB error on "${label}" (attempt ${attempt}/${attempts}), retrying in ${delay}ms:`,
        error instanceof Error ? error.message : error
      )
      await sleep(delay)
    }
  }

  throw lastError
}
