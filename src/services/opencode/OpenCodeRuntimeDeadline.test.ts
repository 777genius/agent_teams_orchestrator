import { describe, expect, test } from 'bun:test'

import {
  OpenCodeRuntimeDeadline,
  OpenCodeRuntimeDeadlineError,
} from './OpenCodeRuntimeDeadline.js'

describe('OpenCodeRuntimeDeadline', () => {
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
