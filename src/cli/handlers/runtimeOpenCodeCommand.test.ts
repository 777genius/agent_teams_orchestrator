import { describe, expect, mock, test } from 'bun:test'

import {
  OPENCODE_COMMAND_KEEPALIVE_INTERVAL_MS,
  executeRuntimeOpenCodeCommandEnvelope,
  startRuntimeCommandKeepAlive,
} from './runtimeOpenCodeCommand.js'

describe('runtimeOpenCodeCommand keepalive', () => {
  test('routes commandStatus to the passive entry without loading the active handler', async () => {
    let passiveCalls = 0
    let activeCalls = 0
    const envelope = { schemaVersion: 1, command: 'opencode.commandStatus' }
    const result = await executeRuntimeOpenCodeCommandEnvelope(envelope, {
      executePassive: async input => {
        passiveCalls += 1
        expect(input).toBe(envelope)
        return { route: 'passive' }
      },
      executeActive: async () => {
        activeCalls += 1
        throw new Error('active route must not load')
      },
    })
    expect(result).toEqual({ route: 'passive' })
    expect(passiveCalls).toBe(1)
    expect(activeCalls).toBe(0)
  })

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
