import { describe, expect, mock, test } from 'bun:test'

import {
  drainRuntimeOpenCodeCommandCleanup,
  OPENCODE_COMMAND_CLEANUP_TIMEOUT_MS,
  OPENCODE_COMMAND_FORCE_EXIT_RESERVE_MS,
  OPENCODE_COMMAND_FORCE_EXIT_TIMEOUT_MS,
  OPENCODE_COMMAND_KEEPALIVE_INTERVAL_MS,
  startRuntimeCommandKeepAlive,
  runtimeOpenCodeCommand,
} from './runtimeOpenCodeCommand.js'

describe('runtimeOpenCodeCommand keepalive', () => {
  test('keeps a referenced interval alive until cleared', () => {
    const timer = {
      unref: mock(() => undefined),
    } as unknown as ReturnType<typeof setInterval>
    const setIntervalMock = mock((callback: () => void, ms: number) => {
      expect(typeof callback).toBe('function')
      expect(ms).toBe(OPENCODE_COMMAND_KEEPALIVE_INTERVAL_MS)
      return timer
    })
    const clearIntervalMock = mock((actual: ReturnType<typeof setInterval>) => {
      expect(actual).toBe(timer)
    })

    const stop = startRuntimeCommandKeepAlive({
      setInterval: setIntervalMock,
      clearInterval: clearIntervalMock,
    })

    expect(setIntervalMock).toHaveBeenCalledTimes(1)
    expect(timer.unref).not.toHaveBeenCalled()

    stop()
    stop()

    expect(clearIntervalMock).toHaveBeenCalledTimes(1)
  })
})

describe('runtimeOpenCodeCommand cancellation cleanup', () => {
  test('waits for host cleanup and pending late lock releases', async () => {
    let resolveHosts!: () => void
    let resolveLateReleases!: () => void
    const hosts = new Promise<void>(resolve => { resolveHosts = resolve })
    const lateReleases = new Promise<void>(resolve => { resolveLateReleases = resolve })
    let settled = false

    const cleanup = drainRuntimeOpenCodeCommandCleanup({
      disposeUnregisteredOwnedHosts: () => hosts,
      drainPendingLateLockReleases: () => lateReleases,
      timeoutMs: 10_000,
    }).then(() => { settled = true })

    resolveHosts()
    await Promise.resolve()
    expect(settled).toBe(false)

    resolveLateReleases()
    await cleanup
    expect(settled).toBe(true)
  })

  test('drains host work queued while the parallel session drain is still pending', async () => {
    let finishHosts!: () => void, finishSession!: () => void, finishLateHost!: () => void
    const hosts = new Promise<void>(resolve => { finishHosts = resolve })
    const session = new Promise<void>(resolve => { finishSession = resolve })
    const lateHost = new Promise<void>(resolve => { finishLateHost = resolve })
    let hostsStarted = false, sessionStarted = false, lateHostQueued = false, settled = false
    const deps = {
      disposeUnregisteredOwnedHosts: async () => { hostsStarted = true; await hosts },
      drainPendingLateLockReleases: async () => {
        sessionStarted = true
        await session
        // A registered host exits while the sibling cleanup is awaiting I/O.
        lateHostQueued = true
      },
      drainPendingHostLifecycleCleanups: async () => { if (lateHostQueued) await lateHost },
      timeoutMs: 10_000,
    }
    const cleanup = drainRuntimeOpenCodeCommandCleanup(deps).then(() => { settled = true })
    expect(hostsStarted && sessionStarted).toBe(true)
    finishHosts()
    await new Promise<void>(resolve => setImmediate(resolve))
    finishSession()
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(lateHostQueued).toBe(true)
    expect(settled).toBe(false)
    finishLateHost()
    await cleanup
    expect(settled).toBe(true)
  })

  test.each(['session', 'final_host'] as const)('bounds %s cleanup before the force-exit watchdog reserve', async pending => {
    let expireTimeout!: () => void
    const timer = { unref: mock(() => undefined) } as unknown as ReturnType<typeof setTimeout>
    const clearTimeoutMock = mock((actual: ReturnType<typeof setTimeout>) => {
      expect(actual).toBe(timer)
    })
    const setTimeoutMock = mock((callback: () => void, ms: number) => {
      expireTimeout = callback
      expect(ms).toBe(OPENCODE_COMMAND_CLEANUP_TIMEOUT_MS)
      return timer
    })
    const never = new Promise<void>(() => undefined)
    let enteredFinalHost!: () => void
    const finalHostEntered = new Promise<void>(resolve => { enteredFinalHost = resolve })
    const onTimeout = mock((timeoutMs: number) => {
      expect(timeoutMs).toBe(OPENCODE_COMMAND_CLEANUP_TIMEOUT_MS)
    })

    const cleanup = drainRuntimeOpenCodeCommandCleanup({
      disposeUnregisteredOwnedHosts: () => Promise.resolve(),
      drainPendingLateLockReleases: () => pending === 'session' ? never : Promise.resolve(),
      drainPendingHostLifecycleCleanups: () => { enteredFinalHost(); return never },
      setTimeout: setTimeoutMock,
      clearTimeout: clearTimeoutMock,
      onTimeout,
    })
    if (pending === 'final_host') await finalHostEntered
    expireTimeout()
    await cleanup

    expect(OPENCODE_COMMAND_FORCE_EXIT_TIMEOUT_MS - OPENCODE_COMMAND_CLEANUP_TIMEOUT_MS)
      .toBe(OPENCODE_COMMAND_FORCE_EXIT_RESERVE_MS)
    expect(timer.unref).toHaveBeenCalledTimes(1)
    expect(clearTimeoutMock).toHaveBeenCalledTimes(1)
    expect(onTimeout).toHaveBeenCalledTimes(1)
  })

  test('reports host disposal failures without preventing the remaining drain', async () => {
    const disposalError = new Error('credential-bearing failure')
    const reported: unknown[] = []
    let lateReleasesDrained = false

    await drainRuntimeOpenCodeCommandCleanup({
      disposeUnregisteredOwnedHosts: async () => { throw disposalError },
      drainPendingLateLockReleases: async () => { lateReleasesDrained = true },
      onDisposeError: error => { reported.push(error) },
      timeoutMs: 10_000,
    })

    expect(reported).toEqual([disposalError])
    expect(lateReleasesDrained).toBe(true)
  })

  test('reports fulfilled host disposal diagnostics without exposing their details', async () => {
    const reported: unknown[] = []

    await drainRuntimeOpenCodeCommandCleanup({
      disposeUnregisteredOwnedHosts: async () => ({
        disposed: 0,
        kept: 1,
        diagnostics: ['https://example.test/private?token=secret'],
      }),
      drainPendingLateLockReleases: async () => {},
      onDisposeError: error => { reported.push(error) },
      timeoutMs: 10_000,
    })

    expect(reported).toEqual([undefined])
  })

  test('default disposal diagnostic omits error details', async () => {
    const originalWarn = console.warn
    const warnings: unknown[][] = []
    console.warn = ((...args: unknown[]) => { warnings.push(args) }) as typeof console.warn
    try {
      await drainRuntimeOpenCodeCommandCleanup({
        disposeUnregisteredOwnedHosts: async () => {
          throw new Error('https://example.test/private?token=secret')
        },
        drainPendingLateLockReleases: async () => {},
        timeoutMs: 10_000,
      })
    } finally {
      console.warn = originalWarn
    }

    expect(warnings).toEqual([[
      '[opencode-command] Failed to dispose unregistered owned OpenCode hosts',
    ]])
  })
})

describe('runtimeOpenCodeCommand terminal cleanup', () => {
  const baseDeps = () => ({
    readInput: async () => '{}',
    writePayload: async () => {},
    onSignal: () => {},
    offSignal: () => {},
  })

  test('drains exactly once before normal success exits', async () => {
    const cleanupBudgets: Array<number | undefined> = []
    const exits: number[] = []
    await runtimeOpenCodeCommand({ input: 'ignored' }, {
      ...baseDeps(),
      executeEnvelope: (async () => ({ ok: true })) as never,
      drainCleanup: async timeoutMs => { cleanupBudgets.push(timeoutMs) },
      exit: code => { exits.push(code) },
    })

    expect(cleanupBudgets).toEqual([undefined])
    expect(exits).toEqual([0])
  })

  test('drains exactly once when the internal command deadline rejects', async () => {
    const deadlineError = new Error('OpenCode command deadline exceeded')
    let cleanupCalls = 0
    const exits: number[] = []
    await expect(runtimeOpenCodeCommand({ input: 'ignored' }, {
      ...baseDeps(),
      executeEnvelope: (async () => { throw deadlineError }) as never,
      drainCleanup: async () => { cleanupCalls += 1 },
      exit: code => { exits.push(code) },
    })).rejects.toBe(deadlineError)

    expect(cleanupCalls).toBe(1)
    expect(exits).toEqual([])
  })

  test('waits for aborted command unwind to register reconciliation before signal drain starts', async () => {
    const listeners = new Map<string, () => void>()
    let notifyExecuting!: () => void
    const executing = new Promise<void>(resolve => { notifyExecuting = resolve })
    let finishLateRegistration!: () => void
    const lateRegistrationBarrier = new Promise<void>(resolve => { finishLateRegistration = resolve })
    let lateRegistrationCompleted = false
    let cleanupCalls = 0
    const exits: number[] = []

    const command = runtimeOpenCodeCommand({ input: 'ignored' }, {
      ...baseDeps(),
      onSignal: (signal, listener) => { listeners.set(signal, listener) },
      offSignal: () => {},
      executeEnvelope: (async (_envelope: unknown, options: { signal?: AbortSignal }) => {
        notifyExecuting()
        await new Promise<void>(resolve => {
          options.signal?.addEventListener('abort', () => resolve(), { once: true })
        })
        await lateRegistrationBarrier
        lateRegistrationCompleted = true
        throw options.signal?.reason
      }) as never,
      drainCleanup: async () => {
        expect(lateRegistrationCompleted).toBe(true)
        cleanupCalls += 1
      },
      exit: code => { exits.push(code) },
    })

    await executing
    listeners.get('SIGTERM')?.()
    await Promise.resolve()
    await Promise.resolve()
    expect(cleanupCalls).toBe(0)

    finishLateRegistration()
    await expect(command).rejects.toThrow('cancelled by signal (143)')
    expect(cleanupCalls).toBe(1)
    expect(exits).toEqual([143])
  })

  for (const { name, unwindMs, expectedCleanupMs } of [
    { name: 'subtracts signal unwind elapsed from cleanup budget', unwindMs: 1_500, expectedCleanupMs: 3_000 },
    { name: 'passes an exhausted signal cleanup budget as zero', unwindMs: 4_700, expectedCleanupMs: 0 },
  ]) {
    test(name, async () => {
      const listeners = new Map<string, () => void>()
      let nowMs = 10_000
      let notifyExecuting!: () => void
      const executing = new Promise<void>(resolve => { notifyExecuting = resolve })
      const cleanupBudgets: Array<number | undefined> = []
      const watchdog = { unref: mock(() => undefined) } as unknown as ReturnType<typeof setTimeout>
      const setTimeoutMock = mock((_callback: () => void, timeoutMs: number) => {
        expect(timeoutMs).toBe(OPENCODE_COMMAND_FORCE_EXIT_TIMEOUT_MS)
        return watchdog
      })
      const clearTimeoutMock = mock((timer: ReturnType<typeof setTimeout>) => {
        expect(timer).toBe(watchdog)
      })
      const exits: number[] = []
      const command = runtimeOpenCodeCommand({ input: 'ignored' }, {
        ...baseDeps(),
        now: () => nowMs,
        onSignal: (signal, listener) => { listeners.set(signal, listener) },
        executeEnvelope: (async (_envelope: unknown, options: { signal?: AbortSignal }) => {
          notifyExecuting()
          await new Promise<void>(resolve => {
            options.signal?.addEventListener('abort', () => resolve(), { once: true })
          })
          nowMs += unwindMs
          throw options.signal?.reason
        }) as never,
        drainCleanup: async timeoutMs => { cleanupBudgets.push(timeoutMs) },
        setTimeout: setTimeoutMock,
        clearTimeout: clearTimeoutMock,
        exit: code => { exits.push(code) },
      })

      await executing
      listeners.get('SIGTERM')?.()
      await expect(command).rejects.toThrow('cancelled by signal (143)')
      expect(cleanupBudgets).toEqual([expectedCleanupMs])
      expect(watchdog.unref).toHaveBeenCalledTimes(1)
      expect(clearTimeoutMock).toHaveBeenCalledTimes(1)
      expect(exits).toEqual([143])
    })
  }

  test('shares signal-owned cleanup with terminal finally without duplicate disposal', async () => {
    const listeners = new Map<string, () => void>()
    let cleanupCalls = 0
    const exits: number[] = []
    let notifyExecuting: () => void = () => {}
    const executing = new Promise<void>(resolve => { notifyExecuting = resolve })
    const command = runtimeOpenCodeCommand({ input: 'ignored' }, {
      ...baseDeps(),
      onSignal: (signal, listener) => { listeners.set(signal, listener) },
      offSignal: (signal, listener) => {
        if (listeners.get(signal) === listener) listeners.delete(signal)
      },
      executeEnvelope: (async (_envelope: unknown, options: { signal?: AbortSignal }) => {
        notifyExecuting()
        return new Promise((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true })
        })
      }) as never,
      drainCleanup: async () => { cleanupCalls += 1 },
      exit: code => { exits.push(code) },
    })
    await executing
    listeners.get('SIGTERM')?.()
    await expect(command).rejects.toThrow('cancelled by signal (143)')

    expect(cleanupCalls).toBe(1)
    expect(exits).toEqual([143])
  })

  test('keeps signal handlers active through terminal drain and selects the signal exit', async () => {
    const listeners = new Map<string, () => void>()
    let finishDrain!: () => void
    const drainGate = new Promise<void>(resolve => { finishDrain = resolve })
    let drainStarted!: () => void
    const draining = new Promise<void>(resolve => { drainStarted = resolve })
    const exits: number[] = []
    let cleanupCalls = 0
    const command = runtimeOpenCodeCommand({ input: 'ignored' }, {
      ...baseDeps(),
      onSignal: (signal, listener) => { listeners.set(signal, listener) },
      offSignal: (signal, listener) => {
        if (listeners.get(signal) === listener) listeners.delete(signal)
      },
      executeEnvelope: (async () => ({ ok: true })) as never,
      drainCleanup: async () => {
        cleanupCalls += 1
        drainStarted()
        await drainGate
      },
      exit: code => { exits.push(code) },
    })

    await draining
    listeners.get('SIGINT')?.()
    finishDrain()
    await command
    await Promise.resolve()

    expect(cleanupCalls).toBe(1)
    expect(exits).toEqual([130])
    expect(listeners.size).toBe(0)
  })
})
