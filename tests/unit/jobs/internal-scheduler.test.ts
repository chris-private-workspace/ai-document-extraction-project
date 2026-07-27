/**
 * @fileoverview CHANGE-110 應用程式內排程器單元測試
 * @description
 *   兩個層面：
 *   - `register()`（src/instrumentation.ts）的兩道守衛：nodejs runtime + 嚴格 "true" 開關
 *   - `startInternalScheduler()`（src/jobs/internal-scheduler.ts）的排程行為：
 *     啟動 60 秒後首跑、之後每 5 分鐘、防重入、單次失敗不中斷後續週期
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
import {
  startInternalScheduler,
  SWEEP_INTERVAL_MS,
  INITIAL_DELAY_MS,
} from '@/jobs/internal-scheduler'

/** 還原 env：原本未設時必須 delete，直接指派 undefined 會變成字串 "undefined" */
function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = value
  }
}

const originalRuntime = process.env.NEXT_RUNTIME
const originalFlag = process.env.ENABLE_INTERNAL_SCHEDULER

beforeEach(() => {
  vi.useFakeTimers()
  triggerMock.mockReset()
  triggerMock.mockResolvedValue({ success: true, sweptCount: 0 })
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

describe('CHANGE-110 register() 守衛', () => {
  beforeEach(() => {
    process.env.NEXT_RUNTIME = 'nodejs'
    process.env.ENABLE_INTERNAL_SCHEDULER = 'true'
  })

  it('should not start the scheduler when runtime is not nodejs', async () => {
    process.env.NEXT_RUNTIME = 'edge'

    await register()
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS + SWEEP_INTERVAL_MS)

    expect(triggerMock).not.toHaveBeenCalled()
  })

  it('should not start the scheduler when the flag is unset', async () => {
    delete process.env.ENABLE_INTERNAL_SCHEDULER

    await register()
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS + SWEEP_INTERVAL_MS)

    expect(triggerMock).not.toHaveBeenCalled()
  })

  it('should not start the scheduler when the flag is a truthy-looking non-"true" value', async () => {
    process.env.ENABLE_INTERNAL_SCHEDULER = '1'

    await register()
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS + SWEEP_INTERVAL_MS)

    expect(triggerMock).not.toHaveBeenCalled()
  })

  it('should start the scheduler when both conditions hold', async () => {
    await register()

    expect(triggerMock).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS)
    expect(triggerMock).toHaveBeenCalledTimes(1)
  })
})

describe('CHANGE-110 startInternalScheduler() 排程行為', () => {
  it('should not run immediately', () => {
    startInternalScheduler()

    expect(triggerMock).not.toHaveBeenCalled()
  })

  it('should run the first sweep exactly after the initial delay', async () => {
    startInternalScheduler()

    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS - 1)
    expect(triggerMock).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(triggerMock).toHaveBeenCalledTimes(1)
  })

  it('should keep sweeping every 5 minutes after the first run', async () => {
    startInternalScheduler()

    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS)
    expect(triggerMock).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS)
    expect(triggerMock).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS)
    expect(triggerMock).toHaveBeenCalledTimes(3)
  })

  it('should skip a tick while the previous sweep is still running', async () => {
    let resolveFirst: (() => void) | undefined
    triggerMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveFirst = resolve
        })
    )

    startInternalScheduler()

    // 第一次開始執行但尚未結束
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS)
    expect(triggerMock).toHaveBeenCalledTimes(1)

    // 下一個週期到來時前一次仍在跑 → 跳過
    await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS)
    expect(triggerMock).toHaveBeenCalledTimes(1)

    // 前一次結束後，後續週期恢復執行
    resolveFirst?.()
    await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS)
    expect(triggerMock).toHaveBeenCalledTimes(2)
  })

  it('should continue scheduling after a sweep throws', async () => {
    triggerMock.mockRejectedValueOnce(new Error('sweep exploded'))

    startInternalScheduler()

    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS)
    expect(triggerMock).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS)
    expect(triggerMock).toHaveBeenCalledTimes(2)
  })
})
