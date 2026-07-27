/**
 * @fileoverview CHANGE-110 應用程式內排程器單元測試
 * @description
 *   驗證 src/instrumentation.ts 的 register()：
 *   - 三道守衛（nodejs runtime / 嚴格 "true" 開關）
 *   - 啟動後 60 秒首次執行、之後每 5 分鐘一次
 *   - 防重入（前一次未結束時跳過本次）
 *   - 單次失敗不中斷後續週期
 *
 * @module tests/unit/jobs/internal-scheduler.test
 * @since CHANGE-110
 * @lastModified 2026-07-27
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const { triggerMock } = vi.hoisted(() => ({ triggerMock: vi.fn() }))

vi.mock('@/jobs/stuck-processing-sweeper-job', () => ({
  triggerStuckProcessingSweep: triggerMock,
}))

import { register } from '@/instrumentation'

const INITIAL_DELAY_MS = 60 * 1000
const INTERVAL_MS = 5 * 60 * 1000

/** 還原 env：原本未設時必須 delete，直接指派 undefined 會變成字串 "undefined" */
function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = value
  }
}

describe('CHANGE-110 應用程式內排程器 register()', () => {
  const originalRuntime = process.env.NEXT_RUNTIME
  const originalFlag = process.env.ENABLE_INTERNAL_SCHEDULER

  beforeEach(() => {
    vi.useFakeTimers()
    triggerMock.mockReset()
    triggerMock.mockResolvedValue({ success: true, sweptCount: 0 })
    process.env.NEXT_RUNTIME = 'nodejs'
    process.env.ENABLE_INTERNAL_SCHEDULER = 'true'
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    restoreEnv('NEXT_RUNTIME', originalRuntime)
    restoreEnv('ENABLE_INTERNAL_SCHEDULER', originalFlag)
  })

  describe('守衛條件', () => {
    it('should not schedule when runtime is not nodejs', async () => {
      process.env.NEXT_RUNTIME = 'edge'

      await register()
      await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS + INTERVAL_MS)

      expect(triggerMock).not.toHaveBeenCalled()
    })

    it('should not schedule when the flag is unset', async () => {
      delete process.env.ENABLE_INTERNAL_SCHEDULER

      await register()
      await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS + INTERVAL_MS)

      expect(triggerMock).not.toHaveBeenCalled()
    })

    it('should not schedule when the flag is a truthy-looking non-"true" value', async () => {
      process.env.ENABLE_INTERNAL_SCHEDULER = '1'

      await register()
      await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS + INTERVAL_MS)

      expect(triggerMock).not.toHaveBeenCalled()
    })
  })

  describe('排程行為', () => {
    it('should not run immediately on register', async () => {
      await register()

      expect(triggerMock).not.toHaveBeenCalled()
    })

    it('should run the first sweep exactly after the initial delay', async () => {
      await register()

      await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS - 1)
      expect(triggerMock).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(1)
      expect(triggerMock).toHaveBeenCalledTimes(1)
    })

    it('should keep sweeping every 5 minutes after the first run', async () => {
      await register()

      await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS)
      expect(triggerMock).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(INTERVAL_MS)
      expect(triggerMock).toHaveBeenCalledTimes(2)

      await vi.advanceTimersByTimeAsync(INTERVAL_MS)
      expect(triggerMock).toHaveBeenCalledTimes(3)
    })
  })

  describe('健壯性', () => {
    it('should skip a tick while the previous sweep is still running', async () => {
      let resolveFirst: (() => void) | undefined
      triggerMock.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveFirst = resolve
          })
      )

      await register()

      // 第一次開始執行但尚未結束
      await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS)
      expect(triggerMock).toHaveBeenCalledTimes(1)

      // 下一個週期到來時前一次仍在跑 → 跳過
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)
      expect(triggerMock).toHaveBeenCalledTimes(1)

      // 前一次結束後，後續週期恢復執行
      resolveFirst?.()
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)
      expect(triggerMock).toHaveBeenCalledTimes(2)
    })

    it('should continue scheduling after a sweep throws', async () => {
      triggerMock.mockRejectedValueOnce(new Error('sweep exploded'))

      await register()

      await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS)
      expect(triggerMock).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(INTERVAL_MS)
      expect(triggerMock).toHaveBeenCalledTimes(2)
    })
  })
})
