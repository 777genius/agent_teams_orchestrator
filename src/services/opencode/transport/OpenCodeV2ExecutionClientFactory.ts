import { assertExecutionSelectedModel, type ExecutionAuthority, type ExecutionContext } from '../execution/OpenCodeV2ExecutionContracts.js'
import path from 'node:path'
import { realpath } from 'node:fs/promises'
import { hashOpenCodeFile } from '../compatibility/OpenCodeNativeIdentity.js'
import { verifyOpenCodePackage } from '../host/OpenCodeV2ServerGraph.js'
import { checkOpenCodeReadJson, boundOpenCodeRead } from './OpenCodeBoundedFetch.js'
import { requireExecutionEndpoint, requireExecutionGraph, registerExecutionDisposer, executionAuthorityIsCatalogOnly } from '../host/OpenCodeV2ExecutionHost.js'
import { executionAssert, ExecutionTransportFailure, executionSessionIsMissing, executionWasNotSubmitted,
  rejectExecutionBeforeInvocation, OpenCodeV2ExecutionFetch } from './OpenCodeV2ExecutionFetch.js'

export type ExecutionModel = { providerID: string; id: string; variant?: string }
export type ExecutionMention = { start: number; end: number; text: string }
export type ExecutionQueueInput = {
  nativeInputID: string; text: string; resume: boolean
  files?: readonly { uri: string; name?: string; description?: string; mention?: ExecutionMention }[]
  agents?: readonly { name: string; mention?: ExecutionMention }[]
  skills?: readonly { id: string; mention?: ExecutionMention }[]
}
export type ExecutionSession = {
  id: string; directory: string; agent: string; model: ExecutionModel; timeCreated: number
}
export type ExecutionInbox = {
  id: string; sessionID: string; type: string; timeCreated: number; delivery: 'queue' | 'steer'
  payload: Readonly<Record<string, unknown>>
}
export type ExecutionMessage = { id: string; type: string; timeCreated: number; data: Readonly<Record<string, unknown>> }
export type ExecutionMessagePage = { data: ExecutionMessage[]; previous: string | null; next: string | null }
export type ExecutionLogEvent = {
  id: string; type: string; aggregateID: string; seq: number; data: Readonly<Record<string, unknown>>
}
export type ExecutionLog = { events: ExecutionLogEvent[]; synced: true; watermark: number | null }
export type ExecutionClient = {
  readonly authority: ExecutionAuthority
  createSession(input: { sessionID: string; agent: string; model: ExecutionModel; title?: string }): Promise<ExecutionSession>
  getSession(sessionID: string): Promise<ExecutionSession>
  promptQueue(sessionID: string, input: ExecutionQueueInput): Promise<ExecutionInbox>
  inbox(sessionID: string): Promise<ExecutionInbox[]>
  messages(sessionID: string, cursor?: string): Promise<ExecutionMessagePage>
  log(sessionID: string, after?: number): Promise<ExecutionLog>
  dispose(): Promise<void>
}

/** Additional published V2 primitives. Authority remains the registered owning lease. */
export type ExecutionJson = null | boolean | number | string | ExecutionJson[] | { [key: string]: ExecutionJson }
export type ExecutionInstruction = { key: string; value: ExecutionJson }
export type ExecutionMcpConfig =
  | { type: 'local'; command: readonly string[]; cwd?: string; environment?: { [key: string]: string }; disabled?: boolean }
  | { type: 'remote'; url: string; headers?: { [key: string]: string }; oauth?: false; disabled?: boolean }
export type ExecutionMcpServer = { name: string; status: 'connected' | 'pending' | 'disabled' | 'failed' | 'needs_auth' }
export type ExecutionPermission = { id: string; sessionID: string; action: string; resources: string[];
  source?: { type: 'tool'; messageID: string; id: string } }
export type ExecutionBridgeClient = ExecutionClient & {
  config?(): Promise<ExecutionJson[]>
  putInstruction(sessionID: string, key: string, value: ExecutionJson): Promise<void>
  instructions(sessionID: string): Promise<ExecutionInstruction[]>
  interrupt(sessionID: string): Promise<{ interrupted: boolean }>
  cancelInbox(sessionID: string, inboxID: string): Promise<void>
  addMcp(server: string, config: ExecutionMcpConfig): Promise<void>
  connectMcp(server: string): Promise<void>
  disconnectMcp(server: string): Promise<void>
  mcp(): Promise<ExecutionMcpServer[]>
  permissions(sessionID: string): Promise<ExecutionPermission[]>
  permission(sessionID: string, requestID: string): Promise<ExecutionPermission>
  replyPermission(sessionID: string, requestID: string, decision: 'once' | 'always' | 'reject'): Promise<void>
}

/** Private generated-client operation shape. Never expose the native client. */
export type ExecutionOperations = {
  identity(): Promise<unknown>; location(): Promise<unknown>; ready(): Promise<unknown>
  config?(): Promise<unknown>
  agent(id: string): Promise<unknown>; models(): Promise<unknown>
  create(input: Parameters<ExecutionClient['createSession']>[0]): Promise<unknown>
  get(id: string): Promise<unknown>; prompt(id: string, input: ExecutionQueueInput): Promise<unknown>
  inbox(id: string): Promise<unknown>; messages(id: string, cursor?: string): Promise<unknown>
  log(id: string, after?: number): AsyncIterable<unknown>
  putInstruction(id: string, key: string, value: ExecutionJson): Promise<unknown>
  instructions(id: string): Promise<unknown>
  interrupt(id: string): Promise<unknown>; cancelInbox(id: string, inboxID: string): Promise<unknown>
  addMcp(server: string, config: ExecutionMcpConfig): Promise<unknown>
  connectMcp(server: string): Promise<unknown>; disconnectMcp(server: string): Promise<unknown>
  mcp(): Promise<unknown>
  permissions(id: string): Promise<unknown>; permission(id: string, requestID: string): Promise<unknown>
  replyPermission(id: string, requestID: string, decision: 'once' | 'always' | 'reject'): Promise<unknown>
}
function record(value: unknown): Record<string, unknown> {
  executionAssert(value !== null && typeof value === 'object' && !Array.isArray(value))
  return value as Record<string, unknown>
}
function text(value: unknown): string {
  executionAssert(typeof value === 'string' && value.length > 0 && value.length <= 4096)
  return value
}
function position(value: unknown): number {
  executionAssert(Number.isSafeInteger(value) && (value as number) >= 0)
  return value as number
}
function nativeID(value: string): void {
  executionAssert(/^[A-Za-z0-9_-]{1,256}$/.test(value), 'invalid_input')
}
function model(value: unknown): ExecutionModel {
  const raw = record(value)
  assertExecutionSelectedModel(raw as ExecutionModel)
  executionAssert(Object.keys(raw).every(key => ['providerID', 'id', 'variant'].includes(key)), 'invalid_model')
  return { providerID: text(raw.providerID), id: text(raw.id),
    ...(raw.variant === undefined ? {} : { variant: text(raw.variant) }) }
}
function session(value: unknown, authority: ExecutionAuthority, id: string): ExecutionSession {
  const raw = record(value), location = record(raw.location)
  executionAssert(raw.id === id && location.directory === authority.directory, 'authority_mismatch')
  return { id, directory: authority.directory, agent: text(raw.agent), model: model(raw.model),
    timeCreated: position(record(raw.time).created) }
}
function inbox(value: unknown, authority: ExecutionAuthority, sessionID: string): ExecutionInbox {
  const raw = record(value)
  executionAssert(raw.sessionID === sessionID && (raw.delivery === 'queue' || raw.delivery === 'steer'), 'authority_mismatch')
  return { id: text(raw.id), sessionID, type: text(raw.type), delivery: raw.delivery,
    timeCreated: position(authority.pin === '2.0.0' ? raw.timeCreated : record(raw.time).created),
    payload: record(raw.payload) }
}

function validateJson(value: unknown, depth = 0): ExecutionJson {
  executionAssert(depth <= 32, 'invalid_input')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') { executionAssert(Number.isFinite(value), 'invalid_input'); return value }
  if (Array.isArray(value)) return value.map(item => validateJson(item, depth + 1))
  const raw = record(value), entries = Object.entries(raw)
  executionAssert(Object.getPrototypeOf(raw) === Object.prototype || Object.getPrototypeOf(raw) === null, 'invalid_input')
  executionAssert(entries.length <= 4096, 'invalid_input')
  const result: { [key: string]: ExecutionJson } = Object.create(null)
  for (const [key, item] of entries) result[key] = validateJson(item, depth + 1)
  if (depth === 0) executionAssert(Buffer.byteLength(JSON.stringify(result)) <= 256 * 1024, 'invalid_input')
  return result
}
function validateMcp(config: ExecutionMcpConfig): void {
  executionAssert(config.disabled !== true, 'invalid_input')
  const raw = record(config)
  if (config.type === 'local') {
    executionAssert(config.command.length > 0 && config.command.length <= 64, 'invalid_input')
    for (const value of config.command) text(value)
    if (config.cwd !== undefined) executionAssert(path.isAbsolute(config.cwd), 'invalid_input')
    executionAssert(Object.keys(raw).every(key => ['type', 'command', 'cwd', 'environment', 'disabled'].includes(key)), 'unsupported_input')
    if (config.environment !== undefined) for (const [key, value] of Object.entries(config.environment))
      executionAssert(/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof value === 'string' && !value.includes('\0'), 'invalid_input')
  } else {
    executionAssert(config.type === 'remote' && config.oauth === false, 'invalid_input')
    const url = new URL(config.url)
    executionAssert((url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password, 'invalid_input')
    executionAssert(Object.keys(raw).every(key => ['type', 'url', 'headers', 'oauth', 'disabled'].includes(key)), 'unsupported_input')
    if (config.headers !== undefined) for (const [key, value] of Object.entries(config.headers))
      executionAssert(/^[A-Za-z0-9-]+$/.test(key) && typeof value === 'string' && !/[\r\n\0]/.test(value), 'invalid_input')
  }
}
function permission(value: unknown, sessionID: string): ExecutionPermission {
  const raw = record(value)
  executionAssert(raw.sessionID === sessionID && Array.isArray(raw.resources) && raw.resources.length <= 256, 'authority_mismatch')
  const result: ExecutionPermission = { id: text(raw.id), sessionID, action: text(raw.action), resources: raw.resources.map(text) }
  if (raw.source !== undefined) {
    const source = record(raw.source)
    executionAssert(source.type === 'tool', 'invalid_response')
    result.source = { type: 'tool', messageID: text(source.messageID), id: text(source.id) }
  }
  return result
}

/** Extension-only wire. The frozen execution wire intentionally accepts only the lower
 * session/admission seam. This private wire does not widen that seam or its authority. */
class OpenCodeV2BridgeFetch {
  private closed = false
  private readonly pending = new Set<Promise<unknown>>()
  private readonly controllers = new Set<AbortController>()
  constructor(private readonly authority: ExecutionAuthority, private readonly context: ExecutionContext,
    private readonly endpoint: { baseUrl: string; password: string; signal: AbortSignal }) {}
  private check(): void {
    executionAssert(!this.closed && Date.now() < this.context.deadline && !this.endpoint.signal.aborted &&
      !this.context.signal?.aborted, 'authority_or_deadline')
    requireExecutionEndpoint(this.authority)
  }
  private track<T>(work: Promise<T>): Promise<T> {
    this.pending.add(work); void work.finally(() => this.pending.delete(work)).catch(() => undefined); return work
  }
  fetch: typeof globalThis.fetch = Object.assign((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    this.track(this.request(input, init)),
  { preconnect(): never { rejectExecutionBeforeInvocation('unsupported_input') } })
  private async request(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> {
    let invoked = false
    const controller = new AbortController(); this.controllers.add(controller)
    let timer: ReturnType<typeof setTimeout> | undefined
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    try {
      this.check()
      let request = new Request(input, init)
      const url = new URL(request.url), segment = '[A-Za-z0-9_-]{1,256}'
      executionAssert(url.origin === this.endpoint.baseUrl && !url.username && !url.password && !url.hash, 'authority_mismatch')
      const instructionsPrefix = this.authority.pin === '2.0.0' ? '/api/session/' : '/api/experimental/session/'
      const instructionsList = new RegExp('^' + instructionsPrefix + segment + '/instructions/entries$').test(url.pathname)
      const instructionsPut = new RegExp('^' + instructionsPrefix + segment + '/instructions/entries/[a-z0-9][a-z0-9._-]{0,255}$').test(url.pathname)
      const interrupt = new RegExp('^/api/session/' + segment + '/interrupt$').test(url.pathname)
      const inboxCancel = new RegExp('^/api/session/' + segment + '/inbox/' + segment + '$').test(url.pathname)
      const permissions = new RegExp('^/api/session/' + segment + '/permission(?:/' + segment + ')?$').test(url.pathname)
      const reply = new RegExp('^/api/session/' + segment + '/permission/' + segment + '/reply$').test(url.pathname)
      const mcpPrefix = this.authority.pin === '2.0.0' ? '/api/mcp/' : '/api/experimental/mcp/'
      const mcpList = url.pathname === '/api/mcp'
      const mcpPut = new RegExp('^' + mcpPrefix + segment + '$').test(url.pathname)
      const mcpAction = new RegExp('^' + mcpPrefix + segment + '/(?:connect|disconnect)$').test(url.pathname)
      const noContent = instructionsPut || inboxCancel || reply || mcpPut || mcpAction
      executionAssert(request.method === 'GET' && (instructionsList || permissions || mcpList) ||
        request.method === 'PUT' && (instructionsPut || mcpPut) ||
        request.method === 'POST' && (interrupt || reply || mcpAction) ||
        request.method === 'DELETE' && inboxCancel, 'unsupported_input')
      const mcp = mcpList || mcpPut || mcpAction, resumeField = this.authority.pin === '2.0.0' ? 'continue' : 'resume'
      const allowedQuery = mcp ? ['location[directory]'] : interrupt ? [resumeField] : []
      for (const key of url.searchParams.keys()) executionAssert(allowedQuery.includes(key) &&
        url.searchParams.getAll(key).length === 1, 'authority_mismatch')
      if (mcp) executionAssert(url.searchParams.get('location[directory]') === this.authority.directory, 'authority_mismatch')
      if (interrupt) executionAssert(url.searchParams.get(resumeField) === 'false', 'unsupported_input')
      const signal = AbortSignal.any([controller.signal, request.signal, this.endpoint.signal,
        ...(this.context.signal ? [this.context.signal] : [])])
      const remaining = () => Math.min(30_000, this.context.deadline - Date.now())
      timer = setTimeout(() => controller.abort(), remaining())
      const consume = async (body: ReadableStream<Uint8Array> | null, maximum: number): Promise<string> => {
        if (!body) return ''
        reader = body.getReader(); let bytes = 0; const parts: Uint8Array[] = []
        for (;;) {
          const part = await boundOpenCodeRead(this.track(reader.read()), remaining(), signal)
          if (part.done) break
          executionAssert(part.value instanceof Uint8Array, 'invalid_response')
          bytes += part.value.byteLength; executionAssert(bytes <= maximum, 'body_limit'); parts.push(part.value)
        }
        reader.releaseLock(); reader = undefined
        return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts))
      }
      if (instructionsPut || mcpPut || reply) {
        const body = await consume(request.body, 1024 * 1024); checkOpenCodeReadJson(body)
        const fields = record(JSON.parse(body))
        const expected = instructionsPut ? 'value' : mcpPut ? 'config' : this.authority.pin === '2.0.0' ? 'reply' : 'decision'
        executionAssert(Object.keys(fields).length === 1 && expected in fields, 'unsupported_input')
        if (instructionsPut) validateJson(fields.value)
        if (reply) executionAssert(fields[expected] === 'once' || fields[expected] === 'always' || fields[expected] === 'reject', 'invalid_input')
        request = new Request(request.url, { method: request.method, headers: request.headers, body, signal: request.signal })
      } else executionAssert(!request.body, 'unsupported_input')
      this.check(); signal.throwIfAborted()
      const headers = new Headers(request.headers)
      headers.set('authorization', 'Basic ' + Buffer.from('opencode:' + this.endpoint.password).toString('base64'))
      invoked = true
      const response = await boundOpenCodeRead(this.track(globalThis.fetch(request, { headers, signal, redirect: 'error' })
        .then(async response => { if (signal.aborted) { await response.body?.cancel(); throw new Error('deadline') }; return response })), remaining(), signal)
      executionAssert(!response.redirected && (!response.url || new URL(response.url).origin === this.endpoint.baseUrl), 'authority_mismatch')
      const body = await consume(response.body, 8 * 1024 * 1024)
      this.check(); signal.throwIfAborted()
      if (noContent) {
        executionAssert(response.status === 204 && body === '', 'invalid_response'); return new Response(null, { status: 204 })
      }
      executionAssert(response.status >= 200 && response.status < 300 &&
        response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() === 'application/json', 'invalid_response')
      checkOpenCodeReadJson(body); JSON.parse(body)
      return new Response(body, { status: response.status, headers: response.headers })
    } catch (failure) {
      controller.abort()
      const code = failure instanceof ExecutionTransportFailure ? failure.code : 'transport_failure'
      if (!invoked) rejectExecutionBeforeInvocation(code)
      throw new ExecutionTransportFailure(code, 'unknown')
    } finally {
      clearTimeout(timer); this.controllers.delete(controller)
      if (reader) { await boundOpenCodeRead(this.track(reader.cancel()), 1000).catch(() => undefined); reader.releaseLock() }
    }
  }
  async dispose(): Promise<void> {
    this.closed = true; for (const controller of this.controllers) controller.abort()
    await boundOpenCodeRead(Promise.allSettled([...this.pending]), 2000)
    executionAssert(this.pending.size === 0, 'cleanup_unknown')
  }
}

async function operations(authority: ExecutionAuthority, context: ExecutionContext,
  endpoint: { baseUrl: string; password: string; signal: AbortSignal }) {
  executionAssert(authority.generation === 'v2' && (authority.pin === '2.0.0' || authority.pin === '2.0.21') &&
    authority.dialect === `v2-${authority.pin}`, 'unqualified_version')
  const graph = requireExecutionGraph(authority)
  executionAssert(graph.sha256 === authority.graphSha256, 'authority_mismatch')
  const name = authority.pin === '2.0.0' ? '@opencode/client-v2-floor' : '@opencode/client'
  const entry = await realpath(Bun.resolveSync(name, import.meta.dir))
  const proof = graph.files.find(file => file.path === entry)
  executionAssert(proof && await hashOpenCodeFile(entry) === proof.sha256, 'graph_mismatch')
  await verifyOpenCodePackage(entry, '@opencode/client', authority.pin)
  for (const [dependency, subpath] of [['schema', 'installation-event'], ['protocol', 'groups/pty']]) {
    const resolved = await realpath(Bun.resolveSync(`@opencode/${dependency}/${subpath}`, path.dirname(entry)))
    await verifyOpenCodePackage(resolved, `@opencode/${dependency}`, authority.pin)
    const dependencyProof = graph.files.find(file => file.path === resolved)
    executionAssert(dependencyProof && await hashOpenCodeFile(resolved) === dependencyProof.sha256, 'graph_mismatch')
  }
  const wire = new OpenCodeV2ExecutionFetch(endpoint.baseUrl, authority.pin, authority.directory, endpoint.password,
    { deadline: context.deadline, signal: AbortSignal.any([endpoint.signal, ...(context.signal ? [context.signal] : [])]) })
  const bridgeWire = new OpenCodeV2BridgeFetch(authority, context, endpoint)
  try {
    wire.check()
    const ops = authority.pin === '2.0.0'
      ? (await import('./OpenCodeV2ExecutionFloorClient.js')).executionFloorOperations(endpoint.baseUrl, authority.directory, wire, bridgeWire.fetch)
      : (await import('./OpenCodeV2ExecutionCurrentClient.js')).executionCurrentOperations(endpoint.baseUrl, authority.directory, wire, bridgeWire.fetch)
    return { ops, wire, bridgeWire }
  } catch (failure) { await Promise.allSettled([wire.dispose(), bridgeWire.dispose()]); throw failure }
}

export async function awaitOpenCodeV2CatalogReadiness(endpoint: { baseUrl: string; password: string; signal: AbortSignal },
  authority: ExecutionAuthority, context: ExecutionContext): Promise<void> {
  const { ops, wire, bridgeWire } = await operations(authority, context, endpoint)
  try {
    const identity = record(await ops.identity())
    executionAssert(identity.pid === requireExecutionEndpoint(authority).nativePID && identity.version === authority.pin &&
      (authority.pin !== '2.0.0' || identity.healthy === true), 'authority_mismatch')
    executionAssert(record(await ops.location()).directory === authority.directory, 'authority_mismatch')
    const ready = await ops.ready()
    if (authority.pin === '2.0.21') executionAssert(record(record(ready).location).directory === authority.directory, 'authority_mismatch')
    wire.check()
  } finally { await Promise.all([wire.dispose(), bridgeWire.dispose()]) }
}

export async function awaitOpenCodeV2ExecutionReadiness(endpoint: { baseUrl: string; password: string; signal: AbortSignal },
  authority: ExecutionAuthority, context: ExecutionContext,
  selection: { agent: string; model: ExecutionModel; permissions: readonly { action: string; resource: string; effect: 'allow' | 'deny' | 'ask' }[] }): Promise<void> {
  const { ops, wire, bridgeWire } = await operations(authority, context, endpoint)
  try {
    const identity = record(await ops.identity())
    executionAssert(identity.pid === requireExecutionEndpoint(authority).nativePID && identity.version === authority.pin &&
      (authority.pin !== '2.0.0' || identity.healthy === true), 'authority_mismatch')
    executionAssert(record(await ops.location()).directory === authority.directory, 'authority_mismatch')
    const ready = await ops.ready()
    if (authority.pin === '2.0.21') executionAssert(record(record(ready).location).directory === authority.directory, 'authority_mismatch')
    const agents = record(await ops.agent(selection.agent)), agent = record(agents.data)
    executionAssert(record(agents.location).directory === authority.directory && agent.id === selection.agent, 'selection_mismatch')
    executionAssert(JSON.stringify(model(agent.model)) === JSON.stringify(model(selection.model)), 'selection_mismatch')
    const expected = [...selection.permissions, ...(authority.pin === '2.0.21' ? [{ action: 'browser', resource: '*', effect: 'deny' }] : [])]
    executionAssert(Array.isArray(agent.permissions) && agent.permissions.length >= expected.length && JSON.stringify((expected.length ? agent.permissions.slice(-expected.length) : []).map(value => {
      const rule = record(value); return { action: rule.action, resource: rule.resource, effect: rule.effect }
    })) === JSON.stringify(expected.map(rule => ({ action: rule.action, resource: rule.resource, effect: rule.effect }))), 'selection_mismatch')
    const catalog = record(await ops.models())
    executionAssert(record(catalog.location).directory === authority.directory && Array.isArray(catalog.data) &&
      catalog.data.some(value => { const candidate = record(value); return candidate.id === selection.model.id &&
        candidate.providerID === selection.model.providerID && candidate.enabled !== false &&
        // Both qualified core releases resolve literal default to the base model.
        // Other variants must be advertised by this selected native catalog model.
        (selection.model.variant === undefined || selection.model.variant === 'default' ||
          (Array.isArray(candidate.variants) && candidate.variants.some(item => record(item).id === selection.model.variant))) }), 'selection_mismatch')
    wire.check()
  } finally { await Promise.all([wire.dispose(), bridgeWire.dispose()]) }
}

export async function createOpenCodeV2ExecutionClient(authority: ExecutionAuthority, context: ExecutionContext): Promise<ExecutionBridgeClient> {
  executionAssert(!executionAuthorityIsCatalogOnly(authority), 'catalog_session_mutation_forbidden')
  const endpoint = requireExecutionEndpoint(authority)
  const { ops, wire, bridgeWire } = await operations(authority, context, endpoint)
  const pending = new Set<Promise<unknown>>()
  let closed = false
  const invoke = <T>(mutation: boolean, run: () => Promise<T>, observedSessionID?: string): Promise<T> => {
    const work = (async () => {
      try { executionAssert(!closed, 'disposed'); requireExecutionEndpoint(authority); wire.check() }
      catch { rejectExecutionBeforeInvocation('authority_or_deadline') }
      try { const result = await run(); wire.check(); requireExecutionEndpoint(authority); return result }
      catch (failure) {
        if (!mutation && observedSessionID !== undefined && executionSessionIsMissing(failure, observedSessionID)) throw failure
        if (executionWasNotSubmitted(failure)) rejectExecutionBeforeInvocation('not_submitted')
        throw new ExecutionTransportFailure(failure instanceof ExecutionTransportFailure ? failure.code : 'invalid_response',
          mutation ? 'unknown' : 'not_submitted')
      }
    })()
    pending.add(work); void work.finally(() => pending.delete(work)).catch(() => undefined)
    return work
  }
  let disposing: Promise<void> | undefined
  const dispose = (): Promise<void> => disposing ??= (async () => {
    closed = true; let failed = false
    const wireCleanup = await Promise.allSettled([wire.dispose(), bridgeWire.dispose()])
    if (wireCleanup.some(result => result.status === 'rejected')) failed = true
    try { await boundOpenCodeRead(Promise.allSettled([...pending]), 2000) } catch { failed = true }
    if (failed || pending.size) throw new ExecutionTransportFailure('cleanup_unknown', 'unknown')
    unregister()
  })()
  const unregister = registerExecutionDisposer(authority, dispose)
  const validate = (run: () => void): void => { try { run() } catch { rejectExecutionBeforeInvocation('invalid_input') } }
  return {
    authority,
    createSession: input => {
      validate(() => { nativeID(input.sessionID); text(input.agent); model(input.model)
        executionAssert(Object.keys(input).every(key => ['sessionID', 'agent', 'model', 'title'].includes(key)), 'unsupported_input')
        if (input.title !== undefined) executionAssert(typeof input.title === 'string' && input.title.length <= 4096, 'invalid_input') })
      return invoke(true, async () => session(await ops.create(input), authority, input.sessionID))
    },
    getSession: id => { nativeID(id); return invoke(false, async () => session(await ops.get(id), authority, id), id) },
    promptQueue: (id, input) => {
      validate(() => { nativeID(id); nativeID(input.nativeInputID)
      executionAssert(typeof input.text === 'string' && input.text.trim().length > 0 &&
        Buffer.byteLength(input.text) <= 256 * 1024 && typeof input.resume === 'boolean', 'invalid_input')
      const allowed = new Set(['nativeInputID', 'text', 'resume', 'files', 'agents', 'skills'])
      executionAssert(Object.keys(input).every(key => allowed.has(key)), 'unsupported_input')
      for (const [key, values] of [['files', input.files], ['agents', input.agents], ['skills', input.skills]] as const) {
        if (values === undefined) continue
        executionAssert(Array.isArray(values) && values.length <= 256, 'invalid_input')
        for (const value of values) {
          const entry = record(value), required = key === 'files' ? 'uri' : key === 'agents' ? 'name' : 'id'
          text(entry[required])
          const fields = key === 'files' ? ['uri', 'name', 'description', 'mention'] : [required, 'mention']
          executionAssert(Object.keys(entry).every(field => fields.includes(field)), 'unsupported_input')
          for (const optional of ['name', 'description']) if (entry[optional] !== undefined) text(entry[optional])
          if (entry.mention !== undefined) { const mention = record(entry.mention)
            executionAssert(Object.keys(mention).sort().join(',') === 'end,start,text' &&
              Number.isSafeInteger(mention.start) && Number.isSafeInteger(mention.end) &&
              (mention.start as number) >= 0 && (mention.end as number) >= (mention.start as number) &&
              (mention.end as number) <= input.text.length && typeof mention.text === 'string', 'invalid_input') }
        }
      } })
      return invoke(true, async () => {
        const receipt = inbox(await ops.prompt(id, input), authority, id)
        executionAssert(receipt.type === 'user' && receipt.delivery === 'queue', 'receipt_mismatch')
        executionAssert(receipt.payload.text === input.text, 'receipt_mismatch')
        return receipt
      })
    },
    inbox: id => {
      nativeID(id)
      return invoke(false, async () => { const raw = await ops.inbox(id); executionAssert(Array.isArray(raw) && raw.length <= 4096)
        const values = raw.map(value => inbox(value, authority, id))
        executionAssert(new Set(values.map(value => value.id)).size === values.length)
        return values })
    },
    messages: (id, cursor) => {
      nativeID(id); if (cursor !== undefined) text(cursor)
      return invoke(false, async () => {
        const raw = record(await ops.messages(id, cursor)), cursors = record(raw.cursor)
        executionAssert(Array.isArray(raw.data) && raw.data.length <= 200)
        const data = raw.data.map(value => { const item = record(value)
          return { id: text(item.id), type: text(item.type), timeCreated: position(record(item.time).created), data: item } })
        executionAssert(new Set(data.map(value => value.id)).size === data.length)
        return { data, previous: cursors.previous == null ? null : text(cursors.previous), next: cursors.next == null ? null : text(cursors.next) }
      })
    },
    log: (id, after) => {
      nativeID(id); if (after !== undefined) position(after)
      return invoke(false, async () => {
        const events: ExecutionLogEvent[] = [], ids = new Set<string>()
        let synced = false, watermark: number | null = null, last = after ?? -1
        for await (const value of ops.log(id, after)) {
          wire.check(); executionAssert(!synced, 'incomplete_log')
          const item = record(value)
          if (item.type === 'log.synced') {
            executionAssert(item.aggregateID === id, 'authority_mismatch')
            watermark = item.seq === undefined ? null : position(item.seq)
            executionAssert(watermark === null ? last === -1 : watermark === last, 'incomplete_log')
            synced = true; continue
          }
          const durable = record(item.durable), data = record(item.data), location = item.location === undefined ? null : record(item.location)
          const seq = position(durable.seq), eventID = text(item.id), type = text(item.type)
          executionAssert(durable.aggregateID === id && data.sessionID === id &&
            (!location || location.directory === authority.directory), 'authority_mismatch')
          executionAssert(type.startsWith('session.') && seq > last && !ids.has(eventID) && events.length < 4096, 'incomplete_log')
          ids.add(eventID); last = seq; events.push({ id: eventID, type, aggregateID: id, seq, data })
        }
        executionAssert(synced, 'incomplete_log')
        return { events, synced: true, watermark }
      })
    },
    config: () => invoke(false, async () => {
      executionAssert(ops.config, 'config_readback_unavailable')
      const raw = await ops.config()
      executionAssert(Array.isArray(raw) && raw.length <= 256, 'config_readback_invalid')
      return raw.map(value => validateJson(value))
    }),
    putInstruction: (id, key, value) => {
      validate(() => { nativeID(id); executionAssert(/^[a-z0-9][a-z0-9._-]{0,255}$/.test(key), 'invalid_input')
        validateJson(value); executionAssert(Buffer.byteLength(JSON.stringify(value)) <= 256 * 1024, 'invalid_input') })
      return invoke(true, async () => { await ops.putInstruction(id, key, value) })
    },
    instructions: id => {
      nativeID(id)
      return invoke(false, async () => {
        const raw = await ops.instructions(id); executionAssert(Array.isArray(raw) && raw.length <= 256)
        const values = raw.map(value => { const entry = record(value), key = text(entry.key)
          executionAssert(/^[a-z0-9][a-z0-9._-]{0,255}$/.test(key))
          const instruction = validateJson(entry.value)
          executionAssert(Buffer.byteLength(JSON.stringify(instruction)) <= 256 * 1024, 'invalid_response')
          return { key, value: instruction } })
        executionAssert(new Set(values.map(value => value.key)).size === values.length)
        return values
      })
    },
    interrupt: id => {
      validate(() => nativeID(id))
      return invoke(true, async () => { const raw = record(await ops.interrupt(id))
        executionAssert(typeof raw.interrupted === 'boolean'); return { interrupted: raw.interrupted } })
    },
    cancelInbox: (id, inboxID) => {
      validate(() => { nativeID(id); nativeID(inboxID) })
      return invoke(true, async () => { await ops.cancelInbox(id, inboxID) })
    },
    addMcp: (server, config) => {
      validate(() => { nativeID(server); validateMcp(config) })
      return invoke(true, async () => { await ops.addMcp(server, config) })
    },
    connectMcp: server => { validate(() => nativeID(server)); return invoke(true, async () => { await ops.connectMcp(server) }) },
    disconnectMcp: server => { validate(() => nativeID(server)); return invoke(true, async () => { await ops.disconnectMcp(server) }) },
    mcp: () => invoke(false, async () => {
      const raw = record(await ops.mcp())
      executionAssert(record(raw.location).directory === authority.directory && Array.isArray(raw.data) && raw.data.length <= 256, 'authority_mismatch')
      const values: ExecutionMcpServer[] = raw.data.map(value => { const entry = record(value), status = record(entry.status).status
        executionAssert(status === 'connected' || status === 'pending' || status === 'disabled' || status === 'failed' || status === 'needs_auth')
        return { name: text(entry.name), status } satisfies ExecutionMcpServer })
      executionAssert(new Set(values.map(value => value.name)).size === values.length)
      return values
    }),
    permissions: id => { nativeID(id); return invoke(false, async () => {
      const raw = await ops.permissions(id); executionAssert(Array.isArray(raw) && raw.length <= 4096)
      const values = raw.map(value => permission(value, id))
      executionAssert(new Set(values.map(value => value.id)).size === values.length); return values
    }) },
    permission: (id, requestID) => { nativeID(id); nativeID(requestID); return invoke(false, async () => {
      const value = permission(await ops.permission(id, requestID), id)
      executionAssert(value.id === requestID, 'authority_mismatch'); return value
    }) },
    replyPermission: (id, requestID, decision) => {
      validate(() => { nativeID(id); nativeID(requestID)
        executionAssert(decision === 'once' || decision === 'always' || decision === 'reject', 'invalid_input') })
      return invoke(true, async () => { const value = permission(await ops.permission(id, requestID), id)
        executionAssert(value.id === requestID, 'authority_mismatch'); await ops.replyPermission(id, requestID, decision) })
    },
    dispose,
  }
}
