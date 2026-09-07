import { describe, expect, test } from 'bun:test'

import {
  OPEN_CODE_READINESS_PHASES,
  OpenCodeRuntimeDeadline,
  OpenCodeRuntimeDeadlineError,
  waitForOpenCodeAbortableDelay,
} from './OpenCodeRuntimeDeadline.js'

type ManualTimer = { callback: () => void; timeoutMs: number; cancelled: boolean }

async function withManualTimers(run: (timers: ManualTimer[]) => Promise<void>): Promise<void> {
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  const timers: ManualTimer[] = []
  globalThis.setTimeout = ((callback: () => void, timeoutMs = 0) => {
    const timer = { callback, timeoutMs, cancelled: false }
    timers.push(timer)
    return Object.assign(timer, { unref: () => timer })
  }) as unknown as typeof setTimeout
  globalThis.clearTimeout = ((timer: ManualTimer) => { timer.cancelled = true }) as unknown as typeof clearTimeout
  try {
    await run(timers)
  } finally {
    globalThis.setTimeout = realSetTimeout
    globalThis.clearTimeout = realClearTimeout
  }
}

describe('waitForOpenCodeAbortableDelay', () => {
  test('clears its timer when cancelled and preserves the abort reason', async () => {
    await withManualTimers(async timers => {
      const controller = new AbortController()
      const reason = new Error('delay cancelled')
      const delay = waitForOpenCodeAbortableDelay(60_000, controller.signal)
      expect(timers).toHaveLength(1)
      expect(timers[0]).toMatchObject({ timeoutMs: 60_000, cancelled: false })

      controller.abort(reason)

      await expect(delay).rejects.toBe(reason)
      expect(timers[0].cancelled).toBe(true)
    })
  })

  test('does not schedule a timer when the signal is already aborted', async () => {
    await withManualTimers(async timers => {
      const controller = new AbortController()
      const reason = new Error('already cancelled')
      controller.abort(reason)

      await expect(waitForOpenCodeAbortableDelay(60_000, controller.signal)).rejects.toBe(reason)
      expect(timers).toHaveLength(0)
    })
  })

  test.each([false, true])('clears its timer after completion with signal: %s', async useSignal => {
    await withManualTimers(async timers => {
      const signal = useSignal ? new AbortController().signal : undefined
      const delay = waitForOpenCodeAbortableDelay(25, signal)
      expect(timers).toHaveLength(1)
      expect(timers[0]).toMatchObject({ timeoutMs: 25, cancelled: false })

      timers[0].callback()

      await delay
      expect(timers[0].cancelled).toBe(true)
    })
  })
})

describe('OpenCodeRuntimeDeadline', () => {
  test('includes the stop abort, verification, and cleanup phases', () => {
    expect(OPEN_CODE_READINESS_PHASES).toContain('stop_abort')
    expect(OPEN_CODE_READINESS_PHASES).toContain('stop_verify')
    expect(OPEN_CODE_READINESS_PHASES).toContain('stop_cleanup')
  })

  test('derives every phase from one monotonic command budget', async () => {
    let now = 100
    let expire: (() => void) | null = null
    const deadline = new OpenCodeRuntimeDeadline(300, {
      monotonicNow: () => now,
      setTimer: callback => {
        expire = callback
        return { unref() {} } as ReturnType<typeof setTimeout>
      },
      clearTimer: () => {},
    })

    await deadline.runPhase('host_start', async context => {
      expect(context.remainingMs()).toBe(300)
      now = 220
      expect(context.remainingMs()).toBe(180)
    })
    await deadline.runPhase('execution_submit', async context => {
      expect(context.remainingMs()).toBe(180)
    })

    now = 400
    expire?.()
    expect(() => deadline.throwIfExpired()).toThrow(OpenCodeRuntimeDeadlineError)
    expect(deadline.signal.reason).toMatchObject({
      phase: 'execution_submit',
      commandBudgetMs: 300,
      elapsedMs: 300,
      remainingMs: 0,
    })
  })

  test('rejects an in-flight phase with its exact phase', async () => {
    let expire: (() => void) | null = null
    const deadline = new OpenCodeRuntimeDeadline(50, {
      monotonicNow: () => 0,
      setTimer: callback => {
        expire = callback
        return { unref() {} } as ReturnType<typeof setTimeout>
      },
      clearTimer: () => {},
    })

    const phase = deadline.runPhase('execution_poll', () => new Promise(() => {}))
    expire?.()

    await expect(phase).rejects.toMatchObject({
      name: 'OpenCodeRuntimeDeadlineError',
      phase: 'execution_poll',
      commandBudgetMs: 50,
    })
  })

  test('uses monotonic time and rejects invalid budgets', () => {
    expect(() => new OpenCodeRuntimeDeadline(0)).toThrow(
      'OpenCode runtime deadline requires a positive finite command budget',
    )
    expect(() => new OpenCodeRuntimeDeadline(Number.NaN)).toThrow(
      'OpenCode runtime deadline requires a positive finite command budget',
    )
  })
})
