import { describe, expect, test } from 'bun:test'

import {
  OPEN_CODE_READINESS_PHASES,
  OpenCodeRuntimeDeadline,
  OpenCodeRuntimeDeadlineError,
  OpenCodeRuntimeLateEffectFencedError,
  OpenCodeRuntimeQuiescenceGate,
  waitForOpenCodeAbortableDelay,
} from './OpenCodeRuntimeDeadline.js'
import type { OpenCodePhaseContext } from './OpenCodeRuntimeDeadline.js'

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
  test('declares the readiness phases implemented by the command contract', () => {
    expect(OPEN_CODE_READINESS_PHASES).toEqual([
      'mcp_preflight', 'host_start', 'execution_submit', 'execution_poll',
      'post_probe_refresh', 'provider_mutation', 'stop_abort', 'stop_verify', 'stop_cleanup',
    ])
  })

  test('cancels its deadline timer after normal completion without a signal', async () => {
    const timers: ManualTimer[] = []
    const deadline = new OpenCodeRuntimeDeadline(100, {
      setTimer: (callback, timeoutMs) => {
        const timer = { callback, timeoutMs, cancelled: false }
        timers.push(timer)
        return timer as unknown as ReturnType<typeof setTimeout>
      },
      clearTimer: timer => { (timer as unknown as ManualTimer).cancelled = true },
    })
    await deadline.runPhase('host_start', async () => undefined)
    deadline.dispose()
    expect(timers).toHaveLength(1)
    expect(timers[0]?.cancelled).toBe(true)
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

  test('records a receipt after grace and rejects conflicting work until settlement', async () => {
    const timers: Array<() => void> = []
    const deadline = new OpenCodeRuntimeDeadline(50, {
      monotonicNow: () => 0,
      setTimer: callback => {
        timers.push(callback)
        return { unref() {} } as ReturnType<typeof setTimeout>
      },
      clearTimer: () => {},
      quiescenceGraceMs: 5,
    })
    let release!: () => void
    const phase = deadline.runPhase('execution_poll', () => new Promise<void>(resolve => { release = resolve }))
    timers[0]()
    await Promise.resolve()
    expect(timers).toHaveLength(2)
    timers[1]()

    await expect(phase).rejects.toMatchObject({
      name: 'OpenCodeRuntimeDeadlineError',
      phase: 'execution_poll',
      commandBudgetMs: 50,
    })
    expect(deadline.unsettledOperationCount).toBe(1)
    expect(deadline.lateEffects).toMatchObject([{
      phase: 'execution_poll', graceMs: 5, safelyIsolated: false, settled: false,
    }])
    expect(() => deadline.assertCanStartConflictingWork()).toThrow(OpenCodeRuntimeLateEffectFencedError)
    release()
    await Promise.resolve()
    expect(deadline.unsettledOperationCount).toBe(0)
    expect(() => deadline.assertCanStartConflictingWork()).not.toThrow()
  })

  test('gates provider before its first effect and returns with permanently hung late work', async () => {
    const timers: Array<() => void> = []
    const gate = new OpenCodeRuntimeQuiescenceGate()
    const makeDeadline = () => new OpenCodeRuntimeDeadline(50, {
      monotonicNow: () => 0,
      setTimer: callback => {
        timers.push(callback)
        return { unref() {} } as ReturnType<typeof setTimeout>
      },
      clearTimer: () => {},
      quiescenceGraceMs: 5,
      quiescenceGate: gate,
    })
    const firstDeadline = makeDeadline()
    let release!: () => void
    const first = firstDeadline.runPhase('provider_mutation', () => new Promise<void>(resolve => { release = resolve }))
    await Promise.resolve()
    await Promise.resolve()
    let secondEffect = false
    const second = makeDeadline().runPhase('provider_mutation', async () => { secondEffect = true })
    await Promise.resolve()
    expect(secondEffect).toBe(false)

    // The first provider never settles. Its deadline plus grace completes
    // without awaiting it and leaves the second provider fenced.
    timers[0]()
    await Promise.resolve()
    timers[2]()
    await expect(first).rejects.toBeInstanceOf(OpenCodeRuntimeDeadlineError)
    expect(secondEffect).toBe(false)
    release()
    await second
    expect(secondEffect).toBe(true)
  })

  test('quarantine remains observable but does not admit later mutation before settlement', async () => {
    const timers: Array<() => void> = []
    const gate = new OpenCodeRuntimeQuiescenceGate()
    const deadline = new OpenCodeRuntimeDeadline(50, {
      monotonicNow: () => 0,
      setTimer: callback => {
        timers.push(callback)
        return { unref() {} } as ReturnType<typeof setTimeout>
      },
      clearTimer: () => {},
      quiescenceGraceMs: 5,
      quiescenceGate: gate,
    })
    let release!: () => void
    const phase = deadline.runPhase('execution_poll', context => {
      context.markLateEffectsSafelyIsolated()
      return new Promise<void>(resolve => { release = resolve })
    })
    timers[0]()
    await Promise.resolve()
    timers[1]()
    await expect(phase).rejects.toBeInstanceOf(OpenCodeRuntimeDeadlineError)

    const later = new OpenCodeRuntimeDeadline(50, {
      setTimer: () => ({ unref() {} } as ReturnType<typeof setTimeout>),
      clearTimer: () => {},
      quiescenceGate: gate,
    })
    expect(() => gate.assertCanStartConflictingWork()).toThrow(OpenCodeRuntimeLateEffectFencedError)
    release()
    await deadline.lateEffects[0]?.settlement
    await expect(later.runPhase('host_start', async () => 'admitted')).resolves.toBe('admitted')
  })

  test('updates an already-recorded late receipt when compensation is quarantined', async () => {
    const timers: Array<() => void> = []
    const gate = new OpenCodeRuntimeQuiescenceGate()
    const deadline = new OpenCodeRuntimeDeadline(50, {
      monotonicNow: () => 0,
      setTimer: callback => {
        timers.push(callback)
        return { unref() {} } as ReturnType<typeof setTimeout>
      },
      clearTimer: () => {},
      quiescenceGraceMs: 5,
      quiescenceGate: gate,
    })
    let context!: OpenCodePhaseContext
    let release!: () => void
    const phase = deadline.runPhase('execution_poll', received => {
      context = received
      return new Promise<void>(resolve => { release = resolve })
    })
    timers[0]()
    await Promise.resolve()
    timers[1]()
    await expect(phase).rejects.toBeInstanceOf(OpenCodeRuntimeDeadlineError)
    expect(deadline.lateEffects[0]?.safelyIsolated).toBe(false)

    context.markLateEffectsSafelyIsolated()
    expect(deadline.lateEffects[0]?.safelyIsolated).toBe(true)
    expect(() => deadline.assertCanStartConflictingWork()).toThrow(OpenCodeRuntimeLateEffectFencedError)
    release()
    await deadline.lateEffects[0]?.settlement
    expect(() => deadline.assertCanStartConflictingWork()).not.toThrow()
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
