import type {
  OpenCodePassiveIssueCode,
  OpenCodePassiveObservation,
  OpenCodePassiveStatusV1,
} from './OpenCodePassiveStatusContract.js'

export type OpenCodePassiveRouteRead = (input: {
  projectPath: string
  providerIds: readonly string[]
  timeoutMs: number
  signal?: AbortSignal
}) => Promise<OpenCodePassiveStatusV1>

export type OpenCodePassiveRouteDeadlineDeps = Readonly<{
  now?: () => number
  schedule?: (callback: () => void, delayMs: number) => { cancel(): void }
}>

export async function readOpenCodePassiveStatusWithinRouteDeadline(
  read: OpenCodePassiveRouteRead,
  request: Omit<Parameters<OpenCodePassiveRouteRead>[0], 'signal'>,
  deps: OpenCodePassiveRouteDeadlineDeps = {},
): Promise<OpenCodePassiveStatusV1> {
  const timeoutMs = normalizeTimeout(request.timeoutMs)
  const controller = new AbortController()
  const schedule = deps.schedule ?? ((callback, delayMs) => {
    const timer = setTimeout(callback, delayMs)
    return { cancel: () => clearTimeout(timer) }
  })
  let settled = false
  let resolveDeadline!: (value: OpenCodePassiveStatusV1) => void
  const deadline = new Promise<OpenCodePassiveStatusV1>(resolve => { resolveDeadline = resolve })
  const timer = schedule(() => {
    if (settled) return
    settled = true
    controller.abort('passive_route_timeout')
    resolveDeadline(createOpenCodePassiveRouteFallback(request.providerIds, safeNow(deps.now), 'read_timeout'))
  }, timeoutMs)

  const readPromise = Promise.resolve().then(() => read({
    ...request,
    timeoutMs,
    signal: controller.signal,
  })).catch(() => createOpenCodePassiveRouteFallback(
    request.providerIds,
    safeNow(deps.now),
    controller.signal.aborted ? 'read_timeout' : 'read_failed',
  ))

  const result = await Promise.race([readPromise, deadline])
  settled = true
  timer.cancel()
  controller.abort('passive_route_complete')
  return result
}

export function createOpenCodePassiveRouteFallback(
  providerIds: readonly string[],
  completedAt: number,
  issueCode: Extract<OpenCodePassiveIssueCode, 'read_timeout' | 'read_failed'>,
): OpenCodePassiveStatusV1 {
  const unknown = <T>(value: T): OpenCodePassiveObservation<T> => ({
    value,
    authority: 'none',
    freshness: 'unknown',
    condition: 'degraded',
    observedAt: null,
    validUntil: null,
    issueCode,
  })
  return {
    contractVersion: 1,
    projectScope: null,
    binary: unknown({ presence: 'unknown', version: null }),
    providers: [...new Set(providerIds)].map(providerId => ({
      providerId,
      configured: unknown('unknown'),
      lastConnected: unknown({ state: 'unknown' }),
      catalogAvailable: unknown('unknown'),
      executionVerified: unknown('unknown'),
    })),
    authorization: 'unknown',
    launchReadiness: 'not_authorized',
    completedAt,
  }
}

function normalizeTimeout(timeoutMs: number): number {
  return Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : 250
}

function safeNow(now: (() => number) | undefined): number {
  try {
    const value = (now ?? Date.now)()
    return Number.isSafeInteger(value) && value >= 0 ? value : 0
  } catch {
    return 0
  }
}
