import { isPrivateSupervisedProviderOperation } from './OpenCodeSupervisedOperation.js'
import { createHash } from 'node:crypto'
import { connect as connectTcp } from 'node:net'
import { encodeOpenCodeSocketHttpRequest, readOpenCodeSocketHttpResponse,
  MAX_OPENCODE_SOCKET_HTTP_BODY_BYTES, type OpenCodeSocketHttpResponse } from './OpenCodeAuthorizedSocketHttp.js'
import { assertTrustedOpenCodeCustody, type OpenCodeHostAcquisitionPolicy,
  type TrustedOpenCodeCustody, type OneUseFence } from './OpenCodeSupervisedHostCustody.js'
import type { HostedHttpOperation, RetainedRequest } from './OpenCodeHostedRawRetention.js'
import { classifySupervisedProviderOperation } from './OpenCodeSupervisedOperation.js'

import type { OpenCodeConnectedSocketIdentity } from './OpenCodeLoopbackEndpointIdentity.js'

import type {
  OpenCodeAgentResponse,
  OpenCodeApiAuthInput,
  OpenCodeConfigProvidersResponse,
  OpenCodeConfigResponse,
  OpenCodeHostedApprovalCapability,
  OpenCodeHostedApprovalObservation,
  OpenCodeHostedApprovalPermission,
  OpenCodeHostedApprovalRawPermission,
  OpenCodeMessage,
  OpenCodeMcpResponse,
  OpenCodeMcpServerConfig,
  OpenCodePendingPermission,
  OpenCodeProviderAuthMethod,
  OpenCodeProviderOAuthAuthorization,
  OpenCodeProviderOAuthAuthorizeInput,
  OpenCodeProviderOAuthCallbackInput,
  OpenCodeProviderResponse,
  OpenCodeServerDocResponse,
  OpenCodeSessionStatusInput,
  OpenCodeSessionSummary,
} from './types.js'

export type OpenCodeConnectedAuthorizationFinalizer = () => boolean

export type OpenCodeClient = {
  getHealth?(): Promise<{ healthy: boolean; version?: string }>
  getConfig(): Promise<OpenCodeConfigResponse>
  getConfigProviders(): Promise<OpenCodeConfigProvidersResponse>
  getProviders(): Promise<OpenCodeProviderResponse>
  getProviderAuth(): Promise<Record<string, OpenCodeProviderAuthMethod[]>>
  getServerDoc(): Promise<OpenCodeServerDocResponse>
  getHostedApprovalCapability?(): Promise<OpenCodeHostedApprovalCapability>
  observeHostedApprovalPermissions?(sessionId: string): Promise<OpenCodeHostedApprovalObservation>
  authorizeProviderOAuth(
    providerId: string,
    body: OpenCodeProviderOAuthAuthorizeInput,
  ): Promise<OpenCodeProviderOAuthAuthorization>
  completeProviderOAuth(
    providerId: string,
    body: OpenCodeProviderOAuthCallbackInput,
  ): Promise<boolean>
  setProviderAuth(providerId: string, body: OpenCodeApiAuthInput): Promise<boolean>
  deleteProviderAuth(providerId: string): Promise<boolean>
  listAgents(): Promise<OpenCodeAgentResponse[]>
  getMcp(): Promise<OpenCodeMcpResponse>
  addMcp?(name: string, config: OpenCodeMcpServerConfig): Promise<OpenCodeMcpResponse>
  connectMcp?(name: string): Promise<OpenCodeMcpResponse>
  createSession(body?: { parentID?: string; title?: string }): Promise<OpenCodeSessionSummary>
  getSession(id: string): Promise<OpenCodeSessionSummary>
  getSessionStatus(): Promise<Record<string, OpenCodeSessionStatusInput>>
  getSessionMessages(id: string, limit?: number): Promise<OpenCodeMessage[]>
  getSessionMessage?(id: string, messageID: string): Promise<OpenCodeMessage | null>
  getPermissions(): Promise<OpenCodePendingPermission[]>
  listExperimentalToolIds(input?: {
    directory?: string | null
    workspace?: string | null
  }): Promise<string[]>
  listExperimentalTools(input: {
    directory?: string | null
    workspace?: string | null
    provider: string
    model: string
  }): Promise<Array<{ id?: string; name?: string; parameters?: unknown }>>
  answerPermission(body: {
    requestId: string
    sessionId?: string | null
    decision: 'allow' | 'always' | 'reject'
    condition?: {
      runtimeInstanceId: string
      configGeneration: string
      sessionIncarnation: string
      requestIncarnation: string
      permissionDigest: string
      /**
       * Proves the already-connected socket asynchronously, then returns a
       * one-use synchronous fence finalizer for the transport's dispatch edge.
       */
      authorizeConnected?: (
        connection: OpenCodeConnectedSocketIdentity,
      ) => Promise<OpenCodeConnectedAuthorizationFinalizer | null>
    }
  }): Promise<unknown>
  sendSessionMessage(
    id: string,
    body: {
      messageID?: string
      agent?: string
      noReply?: boolean
      system?: string
      tools?: Record<string, boolean>
      variant?: string
      model?: {
        providerID: string
        modelID: string
      }
      parts: Array<Record<string, unknown>>
    },
  ): Promise<OpenCodeMessage>
  promptSessionAsync(
    id: string,
    body: {
      messageID?: string
      agent?: string
      noReply?: boolean
      system?: string
      tools?: Record<string, boolean>
      variant?: string
      model?: {
        providerID: string
        modelID: string
      }
      parts: Array<Record<string, unknown>>
    },
  ): Promise<void>
  abortSession(id: string): Promise<boolean>
}

export type OpenCodeClientRequestContext = {
  signal?: AbortSignal
  remainingMs?: () => number
  /** Optional shorter response deadline; supervised identity preparation has its own bound. */
  requestTimeoutMs?: number
}

type OpenCodeClientFactoryDeps = {
  fetchImpl?: typeof fetch
  acquisitionPolicy?: OpenCodeHostAcquisitionPolicy
}

export type OpenCodeHostedApprovalAuth = {
  username?: string
  password: string
  directory: string
}

/** A conditional reply was rejected before any permission effect was applied. */
export class OpenCodePermissionConditionRejectedError extends Error {
  constructor(readonly cause: unknown) {
    super('OpenCode conditional permission reply was rejected without effect')
  }
}

/** A transport preparation failure, never a provider's condition rejection. */
export class OpenCodeRequestNotDispatchedError extends Error {
  constructor() { super('OpenCode supervised request was not dispatched') }
}

class OpenCodeHttpResponseError extends Error {
  constructor(
    readonly status: number,
    statusText: string,
    responseText: string,
  ) {
    super(
      `OpenCode request failed (${status} ${statusText}): ${responseText || 'no response body'}`,
    )
  }
}

// Only the native conditional-reply contract's complete, empty 409/412 qualifies.
class OpenCodeValidatedConditionRejection extends OpenCodeHttpResponseError {}

const HOSTED_APPROVAL_PROTOCOL = 'agent-teams-hosted-approval-v2' as const
const MAX_HOSTED_APPROVAL_RESPONSE_BYTES = 16 * 1024
const MAX_HOSTED_APPROVAL_OBSERVATION_BYTES = 1024 * 1024
const HOSTED_RUNTIME_INSTANCE = /^runtime_instance_[0-9a-f]{32}$/
const HOSTED_CONFIG_GENERATION = /^config_generation_[0-9a-f]{32}$/
const HOSTED_SESSION_INCARNATION = /^session_incarnation_[0-9a-f]{32}$/
const HOSTED_REQUEST_INCARNATION = /^request_incarnation_[0-9a-f]{32}$/
const HOSTED_DIGEST = /^[0-9a-f]{64}$/

function validateHostedApprovalCapability(value: unknown): OpenCodeHostedApprovalCapability {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('OpenCode hosted approval capability response was malformed')
  }
  const response = value as Record<string, unknown>
  if (Object.keys(response).sort().join(',') !==
      'authentication,configGeneration,protocol,runtimeInstanceId,schemaVersion' ||
    response.schemaVersion !== 2 ||
    response.protocol !== HOSTED_APPROVAL_PROTOCOL ||
    response.authentication !== 'opencode-basic' ||
    typeof response.runtimeInstanceId !== 'string' ||
    !HOSTED_RUNTIME_INSTANCE.test(response.runtimeInstanceId) ||
    typeof response.configGeneration !== 'string' ||
    !HOSTED_CONFIG_GENERATION.test(response.configGeneration)) {
    throw new Error('OpenCode hosted approval capability response was malformed')
  }
  return response as OpenCodeHostedApprovalCapability
}

function validateConditionalPermissionReply(
  value: unknown,
  expected: {
    runtimeInstanceId: string
    configGeneration: string
    requestId: string
    sessionId: string
    sessionIncarnation: string
    requestIncarnation: string
    permissionDigest: string
    decision: 'allow_once' | 'reject'
  },
): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('OpenCode conditional permission reply was malformed')
  }
  const response = value as Record<string, unknown>
  if (Object.keys(response).sort().join(',') !==
    'configGeneration,decision,permissionDigest,protocol,requestId,requestIncarnation,runtimeInstanceId,schemaVersion,sessionId,sessionIncarnation,status' ||
    response.schemaVersion !== 2 ||
    response.protocol !== HOSTED_APPROVAL_PROTOCOL ||
    response.status !== 'applied' ||
    response.runtimeInstanceId !== expected.runtimeInstanceId ||
    response.configGeneration !== expected.configGeneration ||
    response.requestId !== expected.requestId ||
    response.sessionId !== expected.sessionId ||
    response.sessionIncarnation !== expected.sessionIncarnation ||
    response.requestIncarnation !== expected.requestIncarnation ||
    response.permissionDigest !== expected.permissionDigest ||
    response.decision !== expected.decision) {
    throw new Error('OpenCode conditional permission reply was malformed')
  }
  return value
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function validateHostedRawPermission(
  value: unknown,
  requestId: string,
  sessionId: string,
): OpenCodeHostedApprovalRawPermission {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('OpenCode hosted approval raw permission was malformed')
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort().join(',')
  const expectedKeys = record.tool === undefined
    ? 'always,id,metadata,patterns,permission,sessionID'
    : 'always,id,metadata,patterns,permission,sessionID,tool'
  const metadata = record.metadata
  const tool = record.tool
  const validTool = tool === undefined || (
    !!tool && typeof tool === 'object' && !Array.isArray(tool) &&
    Object.keys(tool).sort().join(',') === 'callID,messageID' &&
    typeof (tool as Record<string, unknown>).callID === 'string' &&
    typeof (tool as Record<string, unknown>).messageID === 'string'
  )
  if (keys !== expectedKeys ||
    typeof record.id !== 'string' || !record.id.startsWith('per') || record.id !== requestId ||
    typeof record.sessionID !== 'string' || !record.sessionID.startsWith('ses') ||
    record.sessionID !== sessionId ||
    typeof record.permission !== 'string' ||
    !isStringArray(record.patterns) ||
    !metadata || typeof metadata !== 'object' || Array.isArray(metadata) ||
    !isStringArray(record.always) ||
    !validTool) {
    throw new Error('OpenCode hosted approval raw permission was malformed')
  }
  return record as OpenCodeHostedApprovalRawPermission
}

function validateHostedApprovalPermission(
  value: unknown,
  sessionId: string,
): OpenCodeHostedApprovalPermission {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('OpenCode hosted approval permission was malformed')
  }
  const record = value as Record<string, unknown>
  if (Object.keys(record).sort().join(',') !==
      'permissionDigest,rawPermission,requestId,requestIncarnation,sessionId,sessionIncarnation' ||
    typeof record.requestId !== 'string' ||
    !record.requestId.startsWith('per') ||
    record.sessionId !== sessionId ||
    typeof record.sessionIncarnation !== 'string' ||
    !HOSTED_SESSION_INCARNATION.test(record.sessionIncarnation) ||
    typeof record.requestIncarnation !== 'string' ||
    !HOSTED_REQUEST_INCARNATION.test(record.requestIncarnation) ||
    typeof record.permissionDigest !== 'string' ||
    !HOSTED_DIGEST.test(record.permissionDigest) ||
    canonicalHostedApprovalDigest(record.rawPermission) !== record.permissionDigest) {
    throw new Error('OpenCode hosted approval permission was malformed')
  }
  return {
    ...record,
    rawPermission: validateHostedRawPermission(
      record.rawPermission,
      record.requestId,
      record.sessionId,
    ),
  } as OpenCodeHostedApprovalPermission
}

function validateHostedApprovalObservation(
  value: unknown,
  sessionId: string,
): OpenCodeHostedApprovalObservation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('OpenCode hosted approval observation was malformed')
  }
  const response = value as Record<string, unknown>
  if (Object.keys(response).sort().join(',') !==
      'configGeneration,permissions,protocol,runtimeInstanceId,schemaVersion,sessionId' ||
    response.schemaVersion !== 2 || response.protocol !== HOSTED_APPROVAL_PROTOCOL ||
    response.sessionId !== sessionId ||
    typeof response.runtimeInstanceId !== 'string' ||
    !HOSTED_RUNTIME_INSTANCE.test(response.runtimeInstanceId) ||
    typeof response.configGeneration !== 'string' ||
    !HOSTED_CONFIG_GENERATION.test(response.configGeneration) ||
    !Array.isArray(response.permissions) || response.permissions.length > 256) {
    throw new Error('OpenCode hosted approval observation was malformed')
  }
  return {
    ...response,
    permissions: response.permissions.map(permission =>
      validateHostedApprovalPermission(permission, sessionId)),
  } as OpenCodeHostedApprovalObservation
}

function hostedApprovalRequest(
  auth: OpenCodeHostedApprovalAuth | undefined,
  init: RequestInit = {},
): RequestInit {
  if (!auth?.password) throw new Error('OpenCode hosted approval Basic Auth unavailable')
  if (!auth.directory || auth.directory.includes('\0')) {
    throw new Error('OpenCode hosted approval directory unavailable')
  }
  const username = auth.username ?? 'opencode'
  return {
    ...init,
    redirect: 'manual',
    headers: {
      ...(init.headers ?? {}),
      authorization: `Basic ${Buffer.from(`${username}:${auth.password}`, 'utf8').toString('base64')}`,
      'x-opencode-directory': auth.directory,
    },
  }
}

export function canonicalHostedApprovalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value)
    if (encoded === undefined) throw new Error('Unsupported OpenCode hosted approval canonical value')
    return encoded
  }
  if (Array.isArray(value)) return `[${value.map(canonicalHostedApprovalJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).filter(key => record[key] !== undefined).sort((a, b) =>
    Buffer.from(a).compare(Buffer.from(b))).map(key =>
    `${JSON.stringify(key)}:${canonicalHostedApprovalJson(record[key])}`,
  ).join(',')}}`
}

export function canonicalHostedApprovalDigest(value: unknown): string {
  return createHash('sha256').update(canonicalHostedApprovalJson(value), 'utf8').digest('hex')
}

async function readBoundedUtf8Response(
  response: Response,
  maximumBytes = MAX_HOSTED_APPROVAL_RESPONSE_BYTES,
  stream?: { headers(status: number, headers: Headers): void; data(bytes: Uint8Array): void
    isObservationCancelled?(): boolean },
): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let byteLength = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      byteLength += next.value.byteLength
      if (byteLength > maximumBytes) {
        await reader.cancel().catch(() => undefined)
        throw new Error('OpenCode hosted approval response exceeded byte limit')
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(byteLength)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    // Preserve a BOM as data: three wire bytes must never validate as an empty
    // native rejection, nor disappear from a canonical JSON comparison.
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    throw new Error('OpenCode hosted approval response was not valid UTF-8')
  }
}

function rejectDuplicateJsonKeys(text: string): void {
  let offset = 0
  const skipWhitespace = () => {
    while (/\s/.test(text[offset] ?? '')) offset += 1
  }
  const parseString = (): string => {
    const start = offset
    if (text[offset++] !== '"') throw new Error('invalid JSON string')
    while (offset < text.length) {
      const char = text[offset++]
      if (char === '"') return JSON.parse(text.slice(start, offset)) as string
      if (char === '\\') offset += 1
    }
    throw new Error('unterminated JSON string')
  }
  const parseValue = (): void => {
    skipWhitespace()
    if (text[offset] === '{') {
      offset += 1
      const keys = new Set<string>()
      skipWhitespace()
      if (text[offset] === '}') { offset += 1; return }
      while (true) {
        skipWhitespace()
        const key = parseString()
        if (keys.has(key)) throw new Error('duplicate JSON object key')
        keys.add(key)
        skipWhitespace()
        if (text[offset++] !== ':') throw new Error('invalid JSON object')
        parseValue()
        skipWhitespace()
        const delimiter = text[offset++]
        if (delimiter === '}') return
        if (delimiter !== ',') throw new Error('invalid JSON object')
      }
    }
    if (text[offset] === '[') {
      offset += 1
      skipWhitespace()
      if (text[offset] === ']') { offset += 1; return }
      while (true) {
        parseValue()
        skipWhitespace()
        const delimiter = text[offset++]
        if (delimiter === ']') return
        if (delimiter !== ',') throw new Error('invalid JSON array')
      }
    }
    if (text[offset] === '"') { parseString(); return }
    const match = text.slice(offset).match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/)
    if (!match) throw new Error('invalid JSON value')
    offset += match[0].length
  }
  try {
    parseValue()
    skipWhitespace()
    if (offset !== text.length) throw new Error('trailing JSON data')
  } catch (error) {
    throw new Error('OpenCode hosted approval response was malformed JSON', { cause: error })
  }
}

async function parseStrictHostedApprovalResponse<T>(
  response: Response,
  maximumBytes = MAX_HOSTED_APPROVAL_RESPONSE_BYTES,
  supervised = false,
  conditionalReply = false,
): Promise<T> {
  let text = ''
  try {
    text = await readBoundedUtf8Response(response, maximumBytes)
  } catch (error) {
    if (!response.ok && !supervised && !conditionalReply) {
      throw new OpenCodeHttpResponseError(response.status, response.statusText, '')
    }
    throw error
  }
  if (conditionalReply && (response.status === 409 || response.status === 412)) {
    const encoding = response.headers.get('content-encoding')
    if (text === '' && (encoding === null || encoding === 'identity')) {
      throw new OpenCodeValidatedConditionRejection(response.status, response.statusText, '')
    }
    throw new Error('OpenCode conditional rejection did not match the native empty-body contract')
  }
  if (supervised) {
    // Canonical JSON validates syntax, never absence of a permission effect.
    rejectDuplicateJsonKeys(text)
    const decoded = JSON.parse(text)
    if (!decoded || typeof decoded !== 'object' || canonicalHostedApprovalJson(decoded) !== text) {
      throw new Error('OpenCode supervised response was not canonical JSON')
    }
  }
  if (!response.ok) {
    throw new OpenCodeHttpResponseError(response.status, response.statusText, text)
  }
  if (response.status === 204 || text.length === 0) {
    throw new Error('OpenCode hosted approval response was empty')
  }
  rejectDuplicateJsonKeys(text)
  return JSON.parse(text) as T
}

function awaitRequestAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', aborted)
    const aborted = () => { cleanup(); reject(signal.reason ?? new Error('OpenCode request aborted')) }
    signal.addEventListener('abort', aborted, { once: true })
    if (signal.aborted) aborted()
    void pending.then(value => { cleanup(); resolve(value) }, error => { cleanup(); reject(error) })
  })
}

export async function fetchHostedApprovalOverAuthorizedConnection(
  urlValue: string,
  init: RequestInit,
  signal: AbortSignal,
  authorizeConnected: (
    connection: OpenCodeConnectedSocketIdentity,
  ) => Promise<OpenCodeConnectedAuthorizationFinalizer | null>,
  dispatch?: { endAttempted: boolean; body: Buffer; captured: boolean },
  custody?: TrustedOpenCodeCustody,
  maximumBytes = MAX_HOSTED_APPROVAL_RESPONSE_BYTES,
  stream?: { headers(status: number, headers: Headers): void; data(bytes: Uint8Array): void },
): Promise<OpenCodeSocketHttpResponse> {
  const url = new URL(urlValue)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password) {
    throw new Error('OpenCode hosted approval endpoint was not private loopback HTTP')
  }
  const port = Number(url.port)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error('OpenCode hosted approval endpoint port was invalid')
  }
  const body = dispatch?.body ?? Buffer.from(typeof init.body === 'string' ? init.body : '')
  const wire = encodeOpenCodeSocketHttpRequest(url, init, body)
  if (signal.aborted) throw signal.reason ?? new Error('OpenCode request aborted')
  const socket = connectTcp({ host: '127.0.0.1', port })
  // Keep an error listener while asynchronous peer/custody proof is pending.
  socket.on('error', () => {
    if (dispatch?.captured) custody?.rawRetention.poison('socket_failed')
  })
  const releaseSocket = custody?.retainOwnerResource(() => { socket.destroy() })
  socket.once('close', () => releaseSocket?.())
  const abortSocket = () => { socket.destroy() }
  const cleanupAbort = () => signal.removeEventListener('abort', abortSocket)
  signal.addEventListener('abort', abortSocket, { once: true })
  socket.once('close', cleanupAbort)
  let reader: ReturnType<typeof readOpenCodeSocketHttpResponse> | undefined
  try {
    await new Promise<void>((resolve, reject) => {
      const connected = () => { cleanup(); resolve() }
      const failed = (error: Error) => { cleanup(); reject(error) }
      const closed = () => failed(new Error('OpenCode supervised connection unavailable'))
      const cleanup = () => {
        socket.off('connect', connected)
        socket.off('error', failed)
        socket.off('close', closed)
      }
      socket.once('connect', connected)
      socket.once('error', failed)
      socket.once('close', closed)
      if (socket.destroyed) failed(new Error('OpenCode supervised connection unavailable'))
      if (signal.aborted) abortSocket()
    })
    const connection = Object.freeze({
      localAddress: socket.localAddress ?? '',
      localPort: socket.localPort ?? 0,
      remoteAddress: socket.remoteAddress ?? '',
      remotePort: socket.remotePort ?? 0,
    })
    const finalizeConnected = await awaitRequestAbort(authorizeConnected(connection), signal)
    if (!finalizeConnected) {
      throw new OpenCodePermissionConditionRejectedError(
        new Error('OpenCode hosted approval connected endpoint was not authorized'),
      )
    }
    if (signal.aborted) abortSocket()
    if (socket.destroyed) throw new Error('OpenCode authorized connection closed before dispatch')

    reader = readOpenCodeSocketHttpResponse(socket, signal, maximumBytes, code => {
      // Only ordinary bounded SSE cancellation can exempt incomplete framing.
      // Parser errors and byte limits arrive under their own codes first and
      // remain sticky even if cancellation occurs during response persistence.
      if (code === 'incomplete_body' && stream?.isObservationCancelled?.()) return
      if (dispatch?.captured) custody?.rawRetention.poison(code)
    }, stream)
    let finalized = false
    try { finalized = finalizeConnected() } catch (error) {
      throw new OpenCodePermissionConditionRejectedError(error)
    }
    if (!finalized) throw new OpenCodePermissionConditionRejectedError(
      new Error('OpenCode hosted approval connected endpoint finalizer rejected dispatch'),
    )
    // A final fence can synchronously revoke/destroy this very socket.
    if (signal.aborted || socket.destroyed) throw new Error('OpenCode authorized connection closed before dispatch')
    // No HTTP API may receive authority to open a replacement connection. Bun
    // 1.3.11 ignores http.request/Agent createConnection overrides. The first
    // HTTP byte is written to the proved socket in this finalizer's sync stack.
    // Keep the existing marker: even a synchronous write throw is uncertain.
    if (dispatch) dispatch.endAttempted = true
    socket.write(wire)
    return { ...await reader.response, connectedPeer: connection }
  } finally {
    reader?.cancel()
    cleanupAbort()
    socket.destroy()
    releaseSocket?.()
  }
}

/** Retain even empty or undecodable bodies, and actual prefixes on truncation.
 * The socket reader does no decompression. No header carrying secrets is retained.
 */
async function retainSupervisedResponse(
  response: OpenCodeSocketHttpResponse, custody: TrustedOpenCodeCustody, retained: RetainedRequest | null,
): Promise<Response> {
  const { bytes, complete } = response
  const encoding = response.contentEncoding
  const encoded = encoding !== null && encoding !== 'identity'
  if (retained && encoded) custody.rawRetention.poison('unexpected_encoding')
  if (!complete && retained) custody.rawRetention.poison('incomplete_body')
  if (retained) await custody.rawRetention.retainResponse(retained, {
    status: response.status, contentEncoding: encoding,
    peerOperationNonce: null, bytes, complete,
    responseHeaders: response.responseHeaders, connectedPeer: response.connectedPeer,
  })
  if (!complete || encoded) {
    if (retained) {
      custody.rawRetention.poison('response_unusable')
      await custody.rawRetention.recordFailure(retained, {
        phase: 'response-incomplete', code: complete ? 'unexpected_encoding' : 'incomplete_body',
      }).catch(() => undefined)
    }
    throw new Error('OpenCode supervised response incomplete or encoded')
  }
  return socketHttpResponseToWeb(response)
}

function socketHttpResponseToWeb(response: OpenCodeSocketHttpResponse): Response {
  if (!response.complete || (response.contentEncoding !== null && response.contentEncoding !== 'identity')) {
    throw new Error('OpenCode HTTP response incomplete or encoded')
  }
  const bodyForbidden = [204, 205, 304].includes(response.status)
  if (bodyForbidden && response.bytes.length) throw new Error('OpenCode HTTP status forbids response body')
  return new Response(bodyForbidden ? null : response.bytes, {
    status: response.status, statusText: response.statusText, headers: response.headers,
  })
}

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000
const MCP_REQUEST_TIMEOUT_MS = 35_000
const PERMISSION_REQUEST_TIMEOUT_MS = 2_500
// Real executable hashing and connected-peer proof precede the HTTP exchange.
// Bound that work separately so it cannot consume an endpoint's response budget.
const SUPERVISED_PREPARATION_TIMEOUT_MS = 5_000
const MESSAGE_REQUEST_TIMEOUT_MS = 120_000
const PROVIDER_OAUTH_AUTHORIZE_TIMEOUT_MS = 30_000
// GitHub device authorization codes can remain valid for up to 15 minutes.
// Keep the transport alive slightly longer so Agent Teams does not abort a
// still-valid browser flow before the provider finishes polling.
const PROVIDER_OAUTH_CALLBACK_TIMEOUT_MS = 16 * 60_000

function buildQueryPath(path: string, query: Record<string, string | null | undefined>): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value && value.trim().length > 0) {
      params.set(key, value)
    }
  }
  const encoded = params.toString()
  return encoded.length > 0 ? `${path}?${encoded}` : path
}

async function parseResponse<T>(response: Response, supervised = false): Promise<T> {
  const text = supervised ? await readBoundedUtf8Response(response, MAX_HOSTED_APPROVAL_OBSERVATION_BYTES) : await response.text()
  if (!response.ok) {
    throw new OpenCodeHttpResponseError(response.status, response.statusText, supervised ? '' : text)
  }

  if (response.status === 204 || text.trim().length === 0) {
    return undefined as T
  }

  return JSON.parse(text) as T
}

function resolveRequestTimeoutMs(
  endpointTimeoutMs: number,
  context: OpenCodeClientRequestContext,
): number {
  const remainingMs = context.remainingMs?.()
  if (remainingMs === undefined || remainingMs === Number.POSITIVE_INFINITY) {
    return endpointTimeoutMs
  }
  if (!Number.isFinite(remainingMs)) {
    return 0
  }
  return Math.max(0, Math.min(endpointTimeoutMs, Math.floor(remainingMs)))
}

function resolveAbortReason(signal: AbortSignal, fallback: Error): unknown {
  return signal.reason === undefined ? fallback : signal.reason
}

const custodyFactories = new WeakMap<object, TrustedOpenCodeCustody>()
export function isOpenCodeClientFactoryBoundToCustody(value: object, custody: TrustedOpenCodeCustody): boolean {
  return custodyFactories.get(value) === custody
}

export class OpenCodeClientFactory {
  private readonly custody?: TrustedOpenCodeCustody
  private readonly deps: OpenCodeClientFactoryDeps
  constructor(deps: OpenCodeClientFactoryDeps = {}) {
    deps = { ...deps }
    this.deps = Object.freeze({ ...deps })
    const policy = deps.acquisitionPolicy
    if (policy && policy.mode !== 'desktop') {
      if (policy.mode !== 'supervisor-adopt-only') throw new Error('OpenCode acquisition policy invalid')
      const custody = policy.custody
      assertTrustedOpenCodeCustody(custody)
      if (new.target !== OpenCodeClientFactory) throw new Error('OpenCode supervised factory must use the admitted implementation')
      if (deps.fetchImpl) throw new Error('OpenCode supervised transport cannot use fetch override')
      this.deps = Object.freeze({ ...deps, acquisitionPolicy: Object.freeze({ mode: 'supervisor-adopt-only', custody }) })
      this.custody = custody
      Object.defineProperty(this, 'create', { value: OpenCodeClientFactory.prototype.create.bind(this) })
      custodyFactories.set(this, custody)
      Object.freeze(this)
    }
  }

  isBoundToCustody(custody: TrustedOpenCodeCustody): boolean { return this.custody === custody }

  create(
    baseUrl: string,
    context: OpenCodeClientRequestContext = {},
    hostedApprovalAuth?: OpenCodeHostedApprovalAuth,
  ): OpenCodeClient {
    context = { ...context, remainingMs: context.remainingMs?.bind(context) }
    const custody = this.custody
    if (custody && baseUrl !== custody.expected.endpoint.baseUrl) {
      throw new Error('OpenCode supervised origin mismatch')
    }
    const fetchImpl = this.deps.fetchImpl ?? fetch
    const hostedInit = (init: RequestInit = {}) => custody ? init : hostedApprovalRequest(hostedApprovalAuth, init)
    const validateCaptured = <T>(callback: () => T): T => {
      try { return callback() } catch (error) {
        custody?.rawRetention.poison('invalid_hosted_response')
        throw error
      }
    }

    const request = async <T>(
      path: string,
      init?: RequestInit,
      endpointTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
      strictHostedApprovalResponse = false,
      maximumResponseBytes = MAX_HOSTED_APPROVAL_RESPONSE_BYTES,
      authorizeConnected?: (
        connection: OpenCodeConnectedSocketIdentity,
      ) => Promise<OpenCodeConnectedAuthorizationFinalizer | null>,
      operation?: HostedHttpOperation,
    ): Promise<T> => {
      if (custody && !operation) {
        try { operation = classifySupervisedProviderOperation(init?.method ?? 'GET', path) }
        catch { throw new OpenCodeRequestNotDispatchedError() }
      }
      // Freeze the wire body before retention or any other asynchronous boundary.
      // Bound the UTF-8 allocation itself; a short Unicode string can exceed
      // the transport byte limit even when its character count is smaller.
      const bodyText = typeof init?.body === 'string' ? init.body : ''
      if (custody && Buffer.byteLength(bodyText, 'utf8') > MAX_OPENCODE_SOCKET_HTTP_BODY_BYTES) {
        throw new OpenCodeRequestNotDispatchedError()
      }
      const dispatch = custody ? { endAttempted: false,
        body: Buffer.from(bodyText), captured: !!operation } : undefined
      let retained: RetainedRequest | null = null
      let operationToken: OneUseFence | null = null
      let custodyToken: OneUseFence | null = null
      let finished = false
      let recoverableMissing: OpenCodeHttpResponseError | undefined
      const unconsumed = new Set<OneUseFence>()
      const preparations: Promise<unknown>[] = []
      const consume = (token: OneUseFence) => { unconsumed.delete(token); return token.consume() }
      const requestedTimeout = context.requestTimeoutMs
      const responseTimeout = requestedTimeout === undefined ? endpointTimeoutMs :
        Math.max(0, Math.min(endpointTimeoutMs, Number.isFinite(requestedTimeout) ? requestedTimeout : 0))
      const totalBudget = resolveRequestTimeoutMs(Number.POSITIVE_INFINITY, context)
      const totalDeadline = performance.now() + totalBudget
      // Never invoke caller callbacks after consuming the final fences. Carry
      // the original total deadline through both supervised phases instead.
      const remainingBudget = (limit: number) => Math.max(0, Math.min(limit, totalDeadline - performance.now()))
      const timeoutMs = Math.floor(Math.min(responseTimeout, totalBudget))
      const timeoutError = new Error(
        `OpenCode request timed out after ${timeoutMs}ms for ${path}`,
      )
      if (context.signal?.aborted) {
        throw resolveAbortReason(context.signal, timeoutError)
      }

      const controller = new AbortController()
      let completeExchange!: () => void
      const completion = new Promise<void>(resolve => { completeExchange = resolve })
      custody?.retainExchange(() => controller.abort(new Error('OpenCode custody revoked')), completion)
      if (custody && operation) controller.signal.addEventListener('abort', () => {
        custody.rawRetention.poison('exchange_aborted')
      }, { once: true })
      const abortFromContext = () => {
        if (!controller.signal.aborted && context.signal) {
          controller.abort(resolveAbortReason(context.signal, timeoutError))
        }
      }
      context.signal?.addEventListener('abort', abortFromContext, { once: true })
      let deadline = 0
      let timeout: ReturnType<typeof setTimeout>
      const armDeadline = (ms: number) => {
        clearTimeout(timeout)
        deadline = performance.now() + ms
        timeout = setTimeout(() => controller.abort(timeoutError), ms)
      }
      const deadlineCurrent = () => {
        if (performance.now() >= deadline) controller.abort(timeoutError)
        return !controller.signal.aborted
      }
      armDeadline(custody ? remainingBudget(SUPERVISED_PREPARATION_TIMEOUT_MS) : timeoutMs)
      const captureToken = (pending: Promise<OneUseFence | null>) => {
        const prepared = pending.then(token => {
        if (finished || !deadlineCurrent()) {
          try { token?.consume() } catch {}
          return null
        }
        // Register before resolving the abort race, including a token delivered
        // in the same turn as cancellation but never assigned by its caller.
        if (token) unconsumed.add(token)
        return token
        })
        preparations.push(prepared)
        return awaitRequestAbort(prepared, controller.signal)
      }

      try {
        let requestInit: RequestInit = {
          ...init,
          signal: controller.signal,
          headers: {
            'content-type': 'application/json',
            ...(init?.headers ?? {}),
          },
        }
        if (custody) {
          if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\') ||
            /[\r\n\0]/.test(path)) throw new Error('OpenCode supervised request path invalid')
          const url = new URL(baseUrl + path)
          if (url.pathname + url.search !== path ||
            (url.searchParams.has('directory') && url.searchParams.get('directory') !== custody.expected.profile.projectPath) ||
            url.searchParams.has('workspace')) throw new Error('OpenCode supervised directory substitution')
          if (operation) {
            operationToken = await captureToken(custody.prepareOperationToken(operation))
            if (!operationToken) throw new Error('OpenCode admitted HTTP operation unavailable')
            retained = await custody.rawRetention.retainRequest(custody.rawRetention.bindOperation(operation), {
              method: init?.method === 'POST' ? 'POST' : 'GET', path, bytes: dispatch!.body,
            })
          }
          requestInit = custody.authenticatedRequest(baseUrl + path, requestInit)
        }
        const connectedAuthorization = custody ? async (connection: OpenCodeConnectedSocketIdentity) => {
          custodyToken = await captureToken(custody.authorizeConnected(connection))
          if (!custodyToken) return null
          const final = await captureToken(authorizeConnected
            ? authorizeConnected(connection).then(finalize => finalize ? { consume: finalize } : null)
            : Promise.resolve({ consume: () => true }))
          if (!final) return null
          let used = false
          return () => {
            if (used) return false
            used = true
            // Consume every acquired fence even on failure; none may leak pinned fds.
            let valid = custody.rawRetention.isCurrent() && deadlineCurrent()
            try { if (operationToken) valid = consume(operationToken) && valid } catch { valid = false }
            try { valid = consume(final) && valid } catch { valid = false }
            try { valid = consume(custodyToken!) && valid } catch { valid = false }
            valid = valid && custody.rawRetention.isCurrent() && deadlineCurrent()
            if (valid) armDeadline(remainingBudget(responseTimeout))
            return valid && deadlineCurrent()
          }
        } : authorizeConnected
        // The socket reader settles on abort with any received status/entity
        // prefix. An outer abort race here could skip that terminal retention.
        const transported = custody || (connectedAuthorization && !this.deps.fetchImpl)
          ? await fetchHostedApprovalOverAuthorizedConnection(
              baseUrl + path, requestInit, controller.signal, connectedAuthorization!, dispatch, custody,
              custody && !retained ? MAX_HOSTED_APPROVAL_OBSERVATION_BYTES : maximumResponseBytes,
            )
          : await (async () => {
              if (authorizeConnected) {
                throw new OpenCodePermissionConditionRejectedError(
                  new Error('OpenCode hosted approval connected endpoint proof was unavailable'),
                )
              }
              return await fetchImpl(baseUrl + path, requestInit)
            })()
        const response = 'complete' in transported
          ? custody
            ? await retainSupervisedResponse(transported, custody, retained)
            : socketHttpResponseToWeb(transported)
          : transported
        if (custody && !deadlineCurrent()) throw timeoutError
        if (custody && response.status >= 300 && response.status < 400) {
          throw new Error('OpenCode supervised redirect rejected')
        }
        if (custody && operation?.kind === 'provider' && response.headers.has('content-encoding') &&
          response.headers.get('content-encoding') !== 'identity') throw new Error('OpenCode supervised encoding rejected')
        if (custody && operation?.kind === 'provider' && (!response.ok || ((init?.method ?? 'GET') === 'GET' && response.status !== 200))) {
          // Native framing and encoding have already been checked. Preserve the
          // authenticated status without exposing a generic failure body. Reads
          // used for admission still require exactly 200, including config.
          const failure = new OpenCodeHttpResponseError(response.status, response.statusText, '')
          // Only this locally created error follows validated framing, authenticated
          // transport and durable response retention. It is an ordinary missing read,
          // not a capture failure; recordFailure deliberately remains poisonous.
          if (response.status === 404 && operation.method === 'GET' &&
            (operation.name === 'message-read' || operation.name === 'session-read') &&
            retained && custody.rawRetention.isCurrent()) recoverableMissing = failure
          throw failure
        }
        const parsed = strictHostedApprovalResponse
          ? await parseStrictHostedApprovalResponse<T>(response, maximumResponseBytes, !!custody, operation?.kind === 'reply')
          : await parseResponse<T>(response, !!custody)
        if (custody && operation?.kind === 'provider' && operation.name === 'config') {
          custody.assertPrivateMcpConfiguration(parsed)
        }
        return parsed
      } catch (error) {
        if (custody && operation && (!recoverableMissing || error !== recoverableMissing) && !(error instanceof OpenCodeValidatedConditionRejection)) {
          custody.rawRetention.poison('exchange_failed')
          await custody.rawRetention.recordFailure(retained, {
            phase: dispatch?.endAttempted ? 'end-attempted' : 'before-end', code: 'exchange_failed',
          }).catch(() => undefined)
        }
        if (custody && !dispatch?.endAttempted) throw new OpenCodeRequestNotDispatchedError()
        if (custody && operation && isPrivateSupervisedProviderOperation(operation)) {
          if (error instanceof OpenCodeHttpResponseError) throw new OpenCodeHttpResponseError(error.status, '', '')
          throw new Error('OpenCode private HTTP exchange failed')
        }
        if (context.signal?.aborted) {
          throw resolveAbortReason(context.signal, timeoutError)
        }
        if (controller.signal.aborted) {
          throw resolveAbortReason(controller.signal, timeoutError)
        }
        throw error
      } finally {
        finished = true
        for (const token of unconsumed) { try { token.consume() } catch {} }
        unconsumed.clear()
        clearTimeout(timeout)
        context.signal?.removeEventListener('abort', abortFromContext)
        // Abort races revoke writes promptly, but cannot release bundle
        // resources while a preparation still owns a late one-use token.
        void Promise.allSettled(preparations).then(completeExchange)
      }
    }

    return {
      getHealth: () => request('/global/health'),
      getConfig: () => request<OpenCodeConfigResponse>('/config'),
      getConfigProviders: () => request<OpenCodeConfigProvidersResponse>('/config/providers'),
      getProviders: () => request<OpenCodeProviderResponse>('/provider'),
      getProviderAuth: () =>
        request<Record<string, OpenCodeProviderAuthMethod[]>>('/provider/auth'),
      getServerDoc: () => request<OpenCodeServerDocResponse>('/doc'),
      getHostedApprovalCapability: () =>
        request<OpenCodeHostedApprovalCapability>(
          '/experimental/agent-teams/hosted-approval-capability',
          hostedInit(),
          PERMISSION_REQUEST_TIMEOUT_MS,
          true,
          MAX_HOSTED_APPROVAL_RESPONSE_BYTES, undefined, { kind: 'capability' },
        ).then(value => validateCaptured(() => {
          const capability = validateHostedApprovalCapability(value)
          if (custody && canonicalHostedApprovalJson(capability) !== canonicalHostedApprovalJson(custody.expected.hosted)) {
            throw new Error('OpenCode supervised capability mismatch')
          }
          return capability
        })),
      observeHostedApprovalPermissions: sessionId => {
        return request<OpenCodeHostedApprovalObservation>(
          `/experimental/agent-teams/hosted-approval/session/${encodeURIComponent(sessionId)}/permissions`,
          hostedInit(),
          PERMISSION_REQUEST_TIMEOUT_MS,
          true,
          MAX_HOSTED_APPROVAL_OBSERVATION_BYTES,
          undefined, { kind: 'observe', sessionId },
        ).then(value => validateCaptured(() => {
          const observed = validateHostedApprovalObservation(value, sessionId)
          if (custody && (observed.runtimeInstanceId !== custody.expected.hosted.runtimeInstanceId ||
            observed.configGeneration !== custody.expected.hosted.configGeneration)) {
            throw new Error('OpenCode supervised observation mismatch')
          }
          return observed
        }))
      },
      authorizeProviderOAuth: (providerId, body) =>
        request<OpenCodeProviderOAuthAuthorization>(
          `/provider/${encodeURIComponent(providerId)}/oauth/authorize`,
          {
            method: 'POST',
            body: JSON.stringify(body),
          },
          PROVIDER_OAUTH_AUTHORIZE_TIMEOUT_MS,
        ),
      completeProviderOAuth: (providerId, body) =>
        request<boolean>(
          `/provider/${encodeURIComponent(providerId)}/oauth/callback`,
          {
            method: 'POST',
            body: JSON.stringify(body),
          },
          PROVIDER_OAUTH_CALLBACK_TIMEOUT_MS,
        ),
      setProviderAuth: (providerId, body) =>
        request<boolean>(`/auth/${encodeURIComponent(providerId)}`, {
          method: 'PUT',
          body: JSON.stringify(body),
        }),
      deleteProviderAuth: providerId =>
        request<boolean>(`/auth/${encodeURIComponent(providerId)}`, {
          method: 'DELETE',
        }),
      listAgents: () => request<OpenCodeAgentResponse[]>('/agent'),
      getMcp: () => request<OpenCodeMcpResponse>('/mcp', undefined, MCP_REQUEST_TIMEOUT_MS),
      addMcp: (name, config) =>
        request<OpenCodeMcpResponse>(
          '/mcp',
          {
            method: 'POST',
            body: JSON.stringify({
              name,
              config,
            }),
          },
          MCP_REQUEST_TIMEOUT_MS,
        ),
      connectMcp: name =>
        request<OpenCodeMcpResponse>(
          `/mcp/${encodeURIComponent(name)}/connect`,
          {
            method: 'POST',
          },
          MCP_REQUEST_TIMEOUT_MS,
        ),
      createSession: body =>
        request<OpenCodeSessionSummary>('/session', {
          method: 'POST',
          body: JSON.stringify(body ?? {}),
        }),
      getSession: id => request<OpenCodeSessionSummary>(`/session/${id}`),
      getSessionStatus: () =>
        request<Record<string, OpenCodeSessionStatusInput>>('/session/status'),
      getSessionMessages: (id, limit) =>
        request<OpenCodeMessage[]>(
          `/session/${id}/message${typeof limit === 'number' ? `?limit=${limit}` : ''}`,
        ),
      getSessionMessage: async (id, messageID) => {
        try {
          return await request<OpenCodeMessage>(
            `/session/${encodeURIComponent(id)}/message/${encodeURIComponent(messageID)}`,
          )
        } catch (error) {
          if (error instanceof OpenCodeHttpResponseError && error.status === 404) {
            const messages = await request<OpenCodeMessage[]>(
              `/session/${encodeURIComponent(id)}/message`,
            ).catch(() => [])
            return (
              messages.find(message => {
                const info = message.info && typeof message.info === 'object' ? message.info : null
                return info?.id === messageID
              }) ?? null
            )
          }
          throw error
        }
      },
      getPermissions: () =>
        request<OpenCodePendingPermission[]>(
          '/permission',
          undefined,
          PERMISSION_REQUEST_TIMEOUT_MS,
        ),
      listExperimentalToolIds: input =>
        request<string[]>(
          buildQueryPath('/experimental/tool/ids', {
            directory: input?.directory,
            workspace: input?.workspace,
          }),
        ),
      listExperimentalTools: input =>
        request<Array<{ id?: string; name?: string; parameters?: unknown }>>(
          buildQueryPath('/experimental/tool', {
            directory: input.directory,
            workspace: input.workspace,
            provider: input.provider,
            model: input.model,
          }),
        ),
      answerPermission: async body => {
        body = { ...body, condition: body.condition ? { ...body.condition } : undefined }
        if (custody && !body.condition) throw new Error('OpenCode supervised conditional reply required')
        const reply = body.decision === 'allow' ? 'once' : body.decision
        const payload = {
          requestID: body.requestId,
          requestId: body.requestId,
          sessionID: body.sessionId ?? undefined,
          sessionId: body.sessionId ?? undefined,
          reply,
          response: body.decision,
          decision: body.decision,
          allow: body.decision === 'allow' || body.decision === 'always',
          always: body.decision === 'always',
        }
        const encodedRequestId = encodeURIComponent(body.requestId)
        if (!body.condition) {
          // Preserve the existing stock-OpenCode compatibility behavior. The
          // exact-one rule applies only to the negotiated hosted conditional
          // operation below; ordinary permission handling keeps its legacy
          // endpoint fallback order.
          const candidatePaths = [
            `/permission/${encodedRequestId}`,
            `/permission/${encodedRequestId}/reply`,
            `/permission/${encodedRequestId}/respond`,
            '/permission/reply',
            '/permission/respond',
          ]
          let lastError: unknown = null
          for (const path of candidatePaths) {
            try {
              return await request<unknown>(path, {
                method: 'POST',
                body: JSON.stringify(payload),
              }, PERMISSION_REQUEST_TIMEOUT_MS)
            } catch (error) {
              lastError = error
            }
          }
          throw lastError instanceof Error
            ? lastError
            : new Error(`OpenCode permission answer failed for ${body.requestId}`)
        }
        try {
          if (!body.sessionId) throw new Error('OpenCode hosted approval session id missing')
          if (!body.condition.authorizeConnected && (custody || !this.deps.fetchImpl)) {
            throw new OpenCodePermissionConditionRejectedError(
              new Error('OpenCode hosted approval connected endpoint proof was unavailable'),
            )
          }
          if (!body.requestId.startsWith('per')) {
            throw new Error('OpenCode hosted approval request id was malformed')
          }
          const decision = body.decision === 'allow' ? 'allow_once' : 'reject'
          const conditionalPayload = {
            schemaVersion: 2,
            protocol: HOSTED_APPROVAL_PROTOCOL,
            runtimeInstanceId: body.condition.runtimeInstanceId,
            expectedConfigGeneration: body.condition.configGeneration,
            requestId: body.requestId,
            sessionId: body.sessionId,
            sessionIncarnation: body.condition.sessionIncarnation,
            requestIncarnation: body.condition.requestIncarnation,
            expectedPermissionDigest: body.condition.permissionDigest,
            decision,
          }
          if (!HOSTED_RUNTIME_INSTANCE.test(body.condition.runtimeInstanceId) ||
            !HOSTED_CONFIG_GENERATION.test(body.condition.configGeneration) ||
            !HOSTED_SESSION_INCARNATION.test(body.condition.sessionIncarnation) ||
            !HOSTED_REQUEST_INCARNATION.test(body.condition.requestIncarnation) ||
            !HOSTED_DIGEST.test(body.condition.permissionDigest) ||
            Buffer.byteLength(JSON.stringify(conditionalPayload), 'utf8') >
              MAX_HOSTED_APPROVAL_RESPONSE_BYTES) {
            throw new Error('OpenCode hosted approval conditional request was malformed')
          }
          const response = await request<unknown>(
            `/experimental/agent-teams/hosted-approval/session/${encodeURIComponent(body.sessionId)}` +
              `/permission/${encodedRequestId}/reply`,
            hostedInit({
              method: 'POST',
              body: JSON.stringify(conditionalPayload),
            }),
            PERMISSION_REQUEST_TIMEOUT_MS,
            true,
            MAX_HOSTED_APPROVAL_RESPONSE_BYTES,
            body.condition.authorizeConnected,
            { kind: 'reply', sessionId: body.sessionId, requestId: body.requestId,
              runtimeInstanceId: body.condition.runtimeInstanceId,
              configGeneration: body.condition.configGeneration,
              sessionIncarnation: body.condition.sessionIncarnation,
              requestIncarnation: body.condition.requestIncarnation,
              permissionDigest: body.condition.permissionDigest, decision },
          )
          return validateCaptured(() => validateConditionalPermissionReply(response, {
            ...body.condition,
            requestId: body.requestId,
            sessionId: body.sessionId,
            decision,
          }))
        } catch (error) {
          if (error instanceof OpenCodeValidatedConditionRejection) {
            throw new OpenCodePermissionConditionRejectedError(error)
          }
          throw error
        }
      },
      sendSessionMessage: (id, body) =>
        request<OpenCodeMessage>(
          `/session/${id}/message`,
          {
            method: 'POST',
            body: JSON.stringify(body),
          },
          MESSAGE_REQUEST_TIMEOUT_MS,
        ),
      promptSessionAsync: async (id, body) => {
        await request<void>(
          `/session/${id}/prompt_async`,
          {
            method: 'POST',
            body: JSON.stringify(body),
          },
          MESSAGE_REQUEST_TIMEOUT_MS,
        )
      },
      abortSession: id =>
        request<boolean>(`/session/${id}/abort`, {
          method: 'POST',
        }),
    }
  }
}

export const openCodeClientFactory = new OpenCodeClientFactory()
