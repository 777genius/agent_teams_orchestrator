import { describe, expect, mock, test } from 'bun:test'

import {
  drainRuntimeOpenCodeCommandCleanup,
  OPENCODE_COMMAND_CLEANUP_TIMEOUT_MS,
  OPENCODE_COMMAND_FORCE_EXIT_RESERVE_MS,
  OPENCODE_COMMAND_FORCE_EXIT_TIMEOUT_MS,
  OPENCODE_COMMAND_KEEPALIVE_INTERVAL_MS,
  startRuntimeCommandKeepAlive,
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

  test('bounds cleanup before the force-exit watchdog reserve', async () => {
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
    const onTimeout = mock((timeoutMs: number) => {
      expect(timeoutMs).toBe(OPENCODE_COMMAND_CLEANUP_TIMEOUT_MS)
    })

    const cleanup = drainRuntimeOpenCodeCommandCleanup({
      disposeUnregisteredOwnedHosts: () => Promise.resolve(),
      drainPendingLateLockReleases: () => never,
      setTimeout: setTimeoutMock,
      clearTimeout: clearTimeoutMock,
      onTimeout,
    })
    expireTimeout()
    await cleanup

    expect(OPENCODE_COMMAND_FORCE_EXIT_TIMEOUT_MS - OPENCODE_COMMAND_CLEANUP_TIMEOUT_MS)
      .toBe(OPENCODE_COMMAND_FORCE_EXIT_RESERVE_MS)
    expect(timer.unref).toHaveBeenCalledTimes(1)
    expect(clearTimeoutMock).toHaveBeenCalledTimes(1)
    expect(onTimeout).toHaveBeenCalledTimes(1)
  })
})
