/**
 * @fileoverview CHANGE-098 單元測試：DB transient 連線錯誤重試工具
 * @description
 *   驗證 src/lib/db-retry 的核心邏輯：
 *   - isTransientDbError：正確辨識暫時性連線錯誤（訊息 / pg SQLSTATE code）
 *   - withDbRetry：首次成功不重試、transient 重試後成功、非 transient 不重試、耗盡後上拋
 *
 * @module tests/unit/lib/db-retry.test
 * @since CHANGE-098
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { isTransientDbError, withDbRetry } from '@/lib/db-retry'

describe('isTransientDbError', () => {
  it('should return true for "Connection terminated unexpectedly"', () => {
    expect(isTransientDbError(new Error('Connection terminated unexpectedly'))).toBe(true)
  })

  it('should return true for ECONNRESET / ETIMEDOUT', () => {
    expect(isTransientDbError(new Error('read ECONNRESET'))).toBe(true)
    expect(isTransientDbError(new Error('connect ETIMEDOUT 10.0.0.4:5432'))).toBe(true)
  })

  it('should return true for transient pg SQLSTATE codes', () => {
    expect(isTransientDbError({ code: '57P01', message: 'admin shutdown' })).toBe(true)
    expect(isTransientDbError({ code: '08006', message: 'connection failure' })).toBe(true)
  })

  it('should return false for non-transient errors', () => {
    expect(
      isTransientDbError(new Error('duplicate key value violates unique constraint')),
    ).toBe(false)
    expect(isTransientDbError({ code: '23505', message: 'unique_violation' })).toBe(false)
  })

  it('should return false for null / undefined', () => {
    expect(isTransientDbError(null)).toBe(false)
    expect(isTransientDbError(undefined)).toBe(false)
  })
})

describe('withDbRetry', () => {
  // 退避設 0ms，避免測試真的等待
  const fastBackoff = { backoffMs: [0, 0, 0] }

  beforeEach(() => {
    // 靜音重試時的 console.warn，保持測試輸出乾淨
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  it('should return result on first success without retrying', async () => {
    const fn = vi.fn().mockResolvedValue('ok')
    const result = await withDbRetry(fn, fastBackoff)
    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('should retry a transient error then succeed', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('Connection terminated unexpectedly'))
      .mockResolvedValueOnce('recovered')
    const result = await withDbRetry(fn, fastBackoff)
    expect(result).toBe('recovered')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('should NOT retry a non-transient error (throws immediately)', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('unique constraint'))
    await expect(withDbRetry(fn, fastBackoff)).rejects.toThrow('unique constraint')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('should exhaust attempts on persistent transient error and throw the last error', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('Connection terminated unexpectedly'))
    await expect(
      withDbRetry(fn, { attempts: 3, backoffMs: [0, 0] }),
    ).rejects.toThrow('Connection terminated unexpectedly')
    expect(fn).toHaveBeenCalledTimes(3)
  })
})
