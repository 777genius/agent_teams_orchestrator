import { randomUUID, timingSafeEqual } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { lstat, readFile, unlink } from 'node:fs/promises'
import path from 'node:path'

export const CURSOR_CONTROL_PATH = '/agent-teams/cursor/stop'
export const CURSOR_CONTROL_HEADERS = {
  token: 'x-agent-teams-cursor-token', generation: 'x-agent-teams-cursor-generation',
  scope: 'x-agent-teams-cursor-scope', session: 'x-agent-teams-cursor-session',
  message: 'x-agent-teams-cursor-message',
} as const

export type ManagedCursorDescriptor = {
  version: 1; hostPid: number; hostGeneration: string; profileScopeToken: string
  controlUrl: string; controlToken: string
}
export type ManagedCursorChild = { pid?: number; kill(): unknown; exited: Promise<unknown> }
export type ManagedCursorRequest = {
  requestId: string; signal: AbortSignal
  env: { CURSOR_OWNER_REQUEST_ID: string; CURSOR_SUPERVISOR_REPORT: string }
  attachChild(child: ManagedCursorChild): void
  neverStarted(): void
  cancel(): void
}
type Result = { cleanupCompleted: boolean; failure?: string }
type RecordState = {
  sessionId: string; request: ManagedCursorRequest; completion: Promise<Result>
}
type Stop = { stopToken: string; completion: Promise<Result> }

function same(left: string | null, right: string): boolean {
  if (left === null) return false
  const a = Buffer.from(left), b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}
function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 512
}

/** Per-plugin-host state. No global environment or native credential changes. */
export function createManagedCursorControl(input: {
  directory: string; hostGeneration?: string; profileScopeToken: string; waitTimeoutMs?: number
}) {
  if (!identifier(input.profileScopeToken) || (input.hostGeneration !== undefined && !identifier(input.hostGeneration))) {
    throw new Error('Cursor control requires a profile scope and valid host generation')
  }
  mkdirSync(input.directory, { recursive: true, mode: 0o700 })
  const directoryStat = lstatSync(input.directory)
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()
    || (process.getuid && directoryStat.uid !== process.getuid())) {
    throw new Error('Cursor control directory is not privately owned')
  }
  chmodSync(input.directory, 0o700)
  const directory = realpathSync(input.directory)
  const reports = path.join(directory, `requests-${randomUUID()}`)
  mkdirSync(reports, { mode: 0o700 })
  const hostGeneration = input.hostGeneration ?? randomUUID()
  const profileScopeToken = input.profileScopeToken
  const controlToken = randomUUID()
  const records = new Map<string, RecordState>()
  const sealed = new Map<string, Stop>()
  const stops = new Map<string, Stop>()
  const timeoutMs = input.waitTimeoutMs ?? 15_000
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid Cursor control wait timeout')

  function publish(baseURL: string): ManagedCursorDescriptor {
    const url = new URL(baseURL)
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname)
      || !url.port || url.username || url.password) throw new Error('Cursor control requires a bound loopback proxy')
    const descriptor: ManagedCursorDescriptor = {
      version: 1, hostPid: process.pid, hostGeneration, profileScopeToken, controlToken,
      controlUrl: new URL(CURSOR_CONTROL_PATH, url).href,
    }
    const temporary = path.join(directory, `.${process.pid}-${randomUUID()}.tmp`)
    writeFileSync(temporary, JSON.stringify(descriptor) + '\n', { mode: 0o600, flag: 'wx' })
    renameSync(temporary, path.join(directory, `${process.pid}.json`))
    return descriptor
  }

  function headers(ids: { sessionId: string; messageId: string }): Record<string, string> {
    if (!identifier(ids.sessionId) || !identifier(ids.messageId)) throw new Error('Missing Cursor request identity')
    return {
      [CURSOR_CONTROL_HEADERS.token]: controlToken, [CURSOR_CONTROL_HEADERS.generation]: hostGeneration,
      [CURSOR_CONTROL_HEADERS.scope]: profileScopeToken, [CURSOR_CONTROL_HEADERS.session]: ids.sessionId,
      [CURSOR_CONTROL_HEADERS.message]: ids.messageId,
    }
  }

  // Synchronous admission must run before reading/awaiting the provider request body.
  function accept(req: Request): ManagedCursorRequest {
    const get = (key: keyof typeof CURSOR_CONTROL_HEADERS) => req.headers.get(CURSOR_CONTROL_HEADERS[key])
    const sessionId = get('session'), messageId = get('message')
    if (!same(get('token'), controlToken) || !same(get('generation'), hostGeneration)
      || !same(get('scope'), profileScopeToken) || !identifier(sessionId) || !identifier(messageId)) {
      throw new Error('Cursor managed request authentication failed')
    }
    if (sealed.has(sessionId)) throw new Error('Cursor session is permanently stopped')
    const requestId = randomUUID()
    const reportPath = path.join(reports, `${requestId}.json`)
    const controller = new AbortController()
    let child: ManagedCursorChild | undefined
    let terminal = false
    let killFailed = false
    let resolve!: (result: Result) => void
    const completion = new Promise<Result>(done => { resolve = done })
    const finish = (result: Result) => {
      if (terminal) return
      terminal = true
      req.signal.removeEventListener('abort', cancel)
      // Retain failures for a later terminal Stop. Successful completed requests
      // no longer need registry space; an existing Stop keeps its promise.
      if (result.cleanupCompleted) records.delete(requestId)
      resolve(result)
    }
    const kill = () => {
      try { child?.kill() } catch { killFailed = true }
    }
    const cancel = () => {
      if (terminal || controller.signal.aborted) return
      controller.abort(new Error('Cursor request cancelled'))
      kill()
    }
    const request: ManagedCursorRequest = {
      requestId, signal: controller.signal,
      env: { CURSOR_OWNER_REQUEST_ID: requestId, CURSOR_SUPERVISOR_REPORT: reportPath },
      cancel,
      neverStarted() {
        if (child) throw new Error('Cursor child already attached')
        finish({ cleanupCompleted: true })
      },
      attachChild(value) {
        if (child || terminal) throw new Error('Cursor request child attachment is invalid')
        child = value
        if (controller.signal.aborted) kill()
        void child.exited.then(async exitCode => {
          if (typeof exitCode !== 'number' || !Number.isInteger(exitCode)
            || exitCode < 0 || exitCode > 255 || exitCode === 70) {
            finish({ cleanupCompleted: false, failure: 'child_exit_unconfirmed' })
            return
          }
          try {
            const stat = await lstat(reportPath)
            if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024
              || (stat.mode & 0o777) !== 0o600
              || (process.getuid && stat.uid !== process.getuid())) throw new Error('Invalid report')
            const ack = JSON.parse(await readFile(reportPath, 'utf8'))
            const valid = ack.version === 1 && ack.requestId === requestId && ack.cleanupCompleted === true
              && Array.isArray(ack.failures) && ack.failures.length === 0
              && Array.isArray(ack.remaining) && ack.remaining.length === 0
              && (value.pid === undefined || ack.supervisorPid === value.pid)
            if (valid && !killFailed) {
              await unlink(reportPath)
              finish({ cleanupCompleted: true })
            } else finish({ cleanupCompleted: false, failure: 'invalid_cleanup_ack' })
          } catch { finish({ cleanupCompleted: false, failure: 'missing_cleanup_ack' }) }
        }, () => finish({ cleanupCompleted: false, failure: 'child_exit_unobserved' }))
      },
    }
    records.set(requestId, { sessionId, request, completion })
    req.signal.addEventListener('abort', cancel, { once: true })
    if (req.signal.aborted) cancel()
    return request
  }

  function beginStop(sessionId: string): { stopToken: string } {
    if (!identifier(sessionId)) throw new Error('Missing Cursor stop session')
    const previous = sealed.get(sessionId)
    if (previous) return { stopToken: previous.stopToken }
    const pending = [...records.values()].filter(record => record.sessionId === sessionId)
    const stop: Stop = {
      stopToken: randomUUID(),
      completion: Promise.all(pending.map(record => record.completion)).then(results =>
        results.find(result => !result.cleanupCompleted) ?? { cleanupCompleted: true }),
    }
    // Seal before cancellation, which can synchronously trigger caller callbacks.
    sealed.set(sessionId, stop)
    stops.set(stop.stopToken, stop)
    for (const record of pending) record.request.cancel()
    return { stopToken: stop.stopToken }
  }

  async function waitStop(stopToken: string, signal?: AbortSignal): Promise<Result> {
    const stop = stops.get(stopToken)
    if (!stop) throw new Error('Unknown Cursor stop token')
    return new Promise((resolve, reject) => {
      const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(new Error('Cursor stop wait cancelled')) }
      const timer = setTimeout(abort, timeoutMs)
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) { abort(); return }
      void stop.completion.then(result => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        resolve(result)
      })
    })
  }

  function handleRequest(req: Request): Promise<Response> | null {
    if (new URL(req.url).pathname !== CURSOR_CONTROL_PATH) return null
    return (async () => {
      if (req.method !== 'POST') return new Response(null, { status: 405 })
      if (!same(req.headers.get('authorization'), `Bearer ${controlToken}`)) return new Response(null, { status: 403 })
      let body: Record<string, unknown>
      try {
        const text = await req.text()
        if (text.length > 4096) return new Response(null, { status: 413 })
        body = JSON.parse(text)
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid body')
      } catch { return new Response(null, { status: 400 }) }
      if (!same(typeof body.hostGeneration === 'string' ? body.hostGeneration : null, hostGeneration)
        || !same(typeof body.profileScopeToken === 'string' ? body.profileScopeToken : null, profileScopeToken)) {
        return new Response(null, { status: 409 })
      }
      if (body.action === 'begin' && identifier(body.sessionId)) return Response.json(beginStop(body.sessionId))
      if (body.action !== 'wait' || !identifier(body.stopToken) || !stops.has(body.stopToken)) return new Response(null, { status: 400 })
      try {
        const result = await waitStop(body.stopToken, req.signal)
        return Response.json(result, { status: result.cleanupCompleted ? 200 : 502 })
      } catch { return new Response(null, { status: 408 }) }
    })()
  }
  return { publish, headers, accept, beginStop, waitStop, handleRequest }
}
