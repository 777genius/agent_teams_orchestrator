import { createHash } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { connect as connectTcp } from 'node:net'
import { Readable } from 'node:stream'

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

export type OpenCodeClient = {
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
      requestIncarnation: string
      permissionDigest: string
      /** Settles against the already-connected socket before any request byte is written. */
      authorizeConnected?: (connection: OpenCodeConnectedSocketIdentity) => Promise<boolean>
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
}

type OpenCodeClientFactoryDeps = {
  fetchImpl?: typeof fetch
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

const HOSTED_APPROVAL_PROTOCOL = 'agent-teams-hosted-approval-v2' as const
const MAX_HOSTED_APPROVAL_RESPONSE_BYTES = 16 * 1024
const MAX_HOSTED_APPROVAL_OBSERVATION_BYTES = 1024 * 1024
const HOSTED_RUNTIME_INSTANCE = /^runtime_instance_[0-9a-f]{32}$/
const HOSTED_CONFIG_GENERATION = /^config_generation_[0-9a-f]{32}$/
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
    'configGeneration,decision,permissionDigest,protocol,requestId,requestIncarnation,runtimeInstanceId,schemaVersion,sessionId,status' ||
    response.schemaVersion !== 2 ||
    response.protocol !== HOSTED_APPROVAL_PROTOCOL ||
    response.status !== 'applied' ||
    response.runtimeInstanceId !== expected.runtimeInstanceId ||
    response.configGeneration !== expected.configGeneration ||
    response.requestId !== expected.requestId ||
    response.sessionId !== expected.sessionId ||
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
      'permissionDigest,rawPermission,requestId,requestIncarnation,sessionId' ||
    typeof record.requestId !== 'string' ||
    !record.requestId.startsWith('per') ||
    record.sessionId !== sessionId ||
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
  return `{${Object.keys(record).filter(key => record[key] !== undefined).sort().map(key =>
    `${JSON.stringify(key)}:${canonicalHostedApprovalJson(record[key])}`,
  ).join(',')}}`
}

export function canonicalHostedApprovalDigest(value: unknown): string {
  return createHash('sha256').update(canonicalHostedApprovalJson(value), 'utf8').digest('hex')
}

async function readBoundedUtf8Response(
  response: Response,
  maximumBytes = MAX_HOSTED_APPROVAL_RESPONSE_BYTES,
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
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
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
): Promise<T> {
  let text = ''
  try {
    text = await readBoundedUtf8Response(response, maximumBytes)
  } catch (error) {
    if (!response.ok) {
      throw new OpenCodeHttpResponseError(response.status, response.statusText, '')
    }
    throw error
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

async function fetchHostedApprovalOverAuthorizedConnection(
  urlValue: string,
  init: RequestInit,
  signal: AbortSignal,
  authorizeConnected: (connection: OpenCodeConnectedSocketIdentity) => Promise<boolean>,
): Promise<Response> {
  const url = new URL(urlValue)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password) {
    throw new Error('OpenCode hosted approval endpoint was not private loopback HTTP')
  }
  const port = Number(url.port)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error('OpenCode hosted approval endpoint port was invalid')
  }
  const socket = connectTcp({ host: '127.0.0.1', port })
  const abortSocket = () => socket.destroy(signal.reason instanceof Error
    ? signal.reason
    : new Error('OpenCode hosted approval connection aborted'))
  const cleanupAbort = () => signal.removeEventListener('abort', abortSocket)
  signal.addEventListener('abort', abortSocket, { once: true })
  socket.once('close', cleanupAbort)
  let requestDispatched = false
  try {
    await new Promise<void>((resolve, reject) => {
      const connected = () => { cleanup(); resolve() }
      const failed = (error: Error) => { cleanup(); reject(error) }
      const cleanup = () => {
        socket.off('connect', connected)
        socket.off('error', failed)
      }
      socket.once('connect', connected)
      socket.once('error', failed)
      if (signal.aborted) abortSocket()
    })
    const connection = {
      localAddress: socket.localAddress ?? '',
      localPort: socket.localPort ?? 0,
      remoteAddress: socket.remoteAddress ?? '',
      remotePort: socket.remotePort ?? 0,
    }
    if (!(await authorizeConnected(connection))) {
      throw new OpenCodePermissionConditionRejectedError(
        new Error('OpenCode hosted approval connected endpoint was not authorized'),
      )
    }
    if (signal.aborted) abortSocket()

    const body = typeof init.body === 'string' ? init.body : undefined
    const headers = new Headers(init.headers)
    headers.set('connection', 'close')
    if (body !== undefined) headers.set('content-length', String(Buffer.byteLength(body, 'utf8')))
    return await new Promise<Response>((resolve, reject) => {
      const request = httpRequest({
        protocol: 'http:', hostname: '127.0.0.1', port,
        path: `${url.pathname}${url.search}`, method: init.method ?? 'GET',
        headers: Object.fromEntries(headers.entries()), agent: false,
        createConnection: () => socket,
      }, response => {
        const responseHeaders = new Headers()
        for (const [name, value] of Object.entries(response.headers)) {
          if (Array.isArray(value)) value.forEach(member => responseHeaders.append(name, member))
          else if (value !== undefined) responseHeaders.set(name, String(value))
        }
        resolve(new Response(Readable.toWeb(response) as ReadableStream, {
          status: response.statusCode ?? 500,
          statusText: response.statusMessage,
          headers: responseHeaders,
        }))
      })
      requestDispatched = true
      request.once('error', reject)
      request.end(body)
    })
  } finally {
    if (!requestDispatched) {
      cleanupAbort()
      socket.destroy()
    }
  }
}

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000
const MCP_REQUEST_TIMEOUT_MS = 35_000
const PERMISSION_REQUEST_TIMEOUT_MS = 2_500
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

async function parseResponse<T>(response: Response): Promise<T> {
  const text = await response.text()
  if (!response.ok) {
    throw new OpenCodeHttpResponseError(response.status, response.statusText, text)
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

export class OpenCodeClientFactory {
  constructor(private readonly deps: OpenCodeClientFactoryDeps = {}) {}

  create(
    baseUrl: string,
    context: OpenCodeClientRequestContext = {},
    hostedApprovalAuth?: OpenCodeHostedApprovalAuth,
  ): OpenCodeClient {
    const fetchImpl = this.deps.fetchImpl ?? fetch

    const request = async <T>(
      path: string,
      init?: RequestInit,
      endpointTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
      strictHostedApprovalResponse = false,
      maximumResponseBytes = MAX_HOSTED_APPROVAL_RESPONSE_BYTES,
      authorizeConnected?: (connection: OpenCodeConnectedSocketIdentity) => Promise<boolean>,
    ): Promise<T> => {
      const timeoutMs = resolveRequestTimeoutMs(endpointTimeoutMs, context)
      const timeoutError = new Error(
        `OpenCode request timed out after ${timeoutMs}ms for ${path}`,
      )
      if (context.signal?.aborted) {
        throw resolveAbortReason(context.signal, timeoutError)
      }

      const controller = new AbortController()
      const abortFromContext = () => {
        if (!controller.signal.aborted && context.signal) {
          controller.abort(resolveAbortReason(context.signal, timeoutError))
        }
      }
      context.signal?.addEventListener('abort', abortFromContext, { once: true })
      const timeout = setTimeout(() => {
        controller.abort(timeoutError)
      }, timeoutMs)

      try {
        const requestInit = {
          ...init,
          signal: controller.signal,
          headers: {
            'content-type': 'application/json',
            ...(init?.headers ?? {}),
          },
        }
        const response = authorizeConnected && !this.deps.fetchImpl
          ? await fetchHostedApprovalOverAuthorizedConnection(
              baseUrl + path, requestInit, controller.signal, authorizeConnected,
            )
          : await (async () => {
              if (authorizeConnected) {
                throw new OpenCodePermissionConditionRejectedError(
                  new Error('OpenCode hosted approval connected endpoint proof was unavailable'),
                )
              }
              return await fetchImpl(baseUrl + path, requestInit)
            })()
        return strictHostedApprovalResponse
          ? parseStrictHostedApprovalResponse<T>(response, maximumResponseBytes)
          : parseResponse<T>(response)
      } catch (error) {
        if (context.signal?.aborted) {
          throw resolveAbortReason(context.signal, timeoutError)
        }
        if (controller.signal.aborted) {
          throw resolveAbortReason(controller.signal, timeoutError)
        }
        throw error
      } finally {
        clearTimeout(timeout)
        context.signal?.removeEventListener('abort', abortFromContext)
      }
    }

    return {
      getConfig: () => request<OpenCodeConfigResponse>('/config'),
      getConfigProviders: () => request<OpenCodeConfigProvidersResponse>('/config/providers'),
      getProviders: () => request<OpenCodeProviderResponse>('/provider'),
      getProviderAuth: () =>
        request<Record<string, OpenCodeProviderAuthMethod[]>>('/provider/auth'),
      getServerDoc: () => request<OpenCodeServerDocResponse>('/doc'),
      getHostedApprovalCapability: () =>
        request<OpenCodeHostedApprovalCapability>(
          '/experimental/agent-teams/hosted-approval-capability',
          hostedApprovalRequest(hostedApprovalAuth),
          PERMISSION_REQUEST_TIMEOUT_MS,
          true,
        ).then(validateHostedApprovalCapability),
      observeHostedApprovalPermissions: sessionId => {
        return request<OpenCodeHostedApprovalObservation>(
          `/experimental/agent-teams/hosted-approval/session/${encodeURIComponent(sessionId)}/permissions`,
          hostedApprovalRequest(hostedApprovalAuth),
          PERMISSION_REQUEST_TIMEOUT_MS,
          true,
          MAX_HOSTED_APPROVAL_OBSERVATION_BYTES,
        ).then(value => validateHostedApprovalObservation(value, sessionId))
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
          if (error instanceof Error && error.message.includes('(404 ')) {
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
          if (!body.condition.authorizeConnected && !this.deps.fetchImpl) {
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
            requestIncarnation: body.condition.requestIncarnation,
            expectedPermissionDigest: body.condition.permissionDigest,
            decision,
          }
          if (!HOSTED_RUNTIME_INSTANCE.test(body.condition.runtimeInstanceId) ||
            !HOSTED_CONFIG_GENERATION.test(body.condition.configGeneration) ||
            !HOSTED_REQUEST_INCARNATION.test(body.condition.requestIncarnation) ||
            !HOSTED_DIGEST.test(body.condition.permissionDigest) ||
            Buffer.byteLength(JSON.stringify(conditionalPayload), 'utf8') >
              MAX_HOSTED_APPROVAL_RESPONSE_BYTES) {
            throw new Error('OpenCode hosted approval conditional request was malformed')
          }
          const response = await request<unknown>(
            `/experimental/agent-teams/hosted-approval/session/${encodeURIComponent(body.sessionId)}` +
              `/permission/${encodedRequestId}/reply`,
            hostedApprovalRequest(hostedApprovalAuth, {
              method: 'POST',
              body: JSON.stringify(conditionalPayload),
            }),
            PERMISSION_REQUEST_TIMEOUT_MS,
            true,
            MAX_HOSTED_APPROVAL_RESPONSE_BYTES,
            body.condition.authorizeConnected,
          )
          return validateConditionalPermissionReply(response, {
            ...body.condition,
            requestId: body.requestId,
            sessionId: body.sessionId,
            decision,
          })
        } catch (error) {
          if (error instanceof OpenCodeHttpResponseError &&
            (error.status === 409 || error.status === 412)) {
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
