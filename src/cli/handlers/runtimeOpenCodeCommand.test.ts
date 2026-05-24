import { describe, expect, mock, test } from 'bun:test'

import {
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
