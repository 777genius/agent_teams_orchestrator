import {
  getOpenCodeSseSessionId,
  getOpenCodeSseSessionStatusType,
  readOpenCodeSseEndpoint,
  type OpenCodeSseFetch,
} from './OpenCodeSseEventStream.js'
import {
  raceOpenCodeAbortSignal,
  waitForOpenCodeAbortableDelay,
} from './OpenCodeRuntimeDeadline.js'

export type OpenCodeStopObserver = {
  arm(): void
  currentStatus(): 'idle' | 'busy' | 'retry' | null
  waitForIdle(timeoutMs: number): Promise<boolean>
  dispose(): Promise<void>
}

export async function startOpenCodeStopObserver(params: {
  requestOwner?: object
  baseUrl: string
  sessionId: string
  signal?: AbortSignal
  fetchImpl?: OpenCodeSseFetch
}): Promise<OpenCodeStopObserver> {
  const controller = new AbortController()
  const signal = params.signal
    ? AbortSignal.any([controller.signal, params.signal])
    : controller.signal
  let ready = false
  let armed = false
  let currentStatus: 'idle' | 'busy' | 'retry' | null = null
  let settled = false
  let resolveReady!: () => void
  let rejectReady!: (error: Error) => void
  const readyPromise = new Promise<void>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  let resolveIdle!: (idle: boolean) => void
  const idlePromise = new Promise<boolean>(resolve => { resolveIdle = resolve })
  const settleIdle = (idle: boolean) => {
    if (settled) return
    settled = true
    resolveIdle(idle)
  }

  const stream = readOpenCodeSseEndpoint({
    baseUrl: params.baseUrl, requestOwner: params.requestOwner,
    endpoint: '/event',
    fetchImpl: params.fetchImpl,
    signal,
    onEvent: event => {
      if (event.type === 'server.connected') {
        if (!ready) {
          ready = true
          resolveReady()
        }
        return
      }
      const sessionId = getOpenCodeSseSessionId(event.properties)
      if (sessionId !== params.sessionId) return
      if (!armed) return
      if (event.type === 'session.idle') {
        currentStatus = 'idle'
        settleIdle(true)
        return
      }
      if (event.type === 'session.status') {
        const status = getOpenCodeSseSessionStatusType(event.properties.status, params.sessionId)
        if (status === 'idle' || status === 'busy' || status === 'retry') {
          currentStatus = status
          if (status === 'idle') settleIdle(true)
        }
      }
    },
  }).then(result => {
    if (!ready) {
      rejectReady(new Error(
        result.diagnostics[0] ?? 'OpenCode stop event stream closed before server.connected',
      ))
    }
    settleIdle(false)
    return result
  })

  try {
    await raceOpenCodeAbortSignal(readyPromise, signal)
  } catch (error) {
    controller.abort(error)
    await stream
    throw error
  }

  return {
    arm(): void {
      armed = true
      currentStatus = null
    },
    currentStatus: () => currentStatus,
    async waitForIdle(timeoutMs: number): Promise<boolean> {
      if (timeoutMs <= 0) return Promise.race([idlePromise, Promise.resolve(false)])
      return Promise.race([
        idlePromise,
        waitForOpenCodeAbortableDelay(timeoutMs, signal).then(() => false),
      ])
    },
    async dispose(): Promise<void> {
      controller.abort(new Error('OpenCode stop observer disposed'))
      await stream
    },
  }
}
