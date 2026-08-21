import type {
  OpenCodeAgentResponse,
  OpenCodeApiAuthInput,
  OpenCodeConfigProvidersResponse,
  OpenCodeConfigResponse,
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
  /** Provider-scoped catalog route. It deliberately has no full-inventory fallback. */
  getProviderCatalog(providerId: string): Promise<unknown>
  getProviderAuth(): Promise<Record<string, OpenCodeProviderAuthMethod[]>>
  getServerDoc(): Promise<OpenCodeServerDocResponse>
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
  createSession(body?: OpenCodeCreateSessionInput): Promise<OpenCodeSessionSummary>
  getSession(id: string): Promise<OpenCodeSessionSummary>
  deleteSession(id: string): Promise<boolean>
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

/** Caller-supplied session IDs are authoritative launch idempotency keys. */
export type OpenCodeCreateSessionInput = {
  id?: string
  parentID?: string
  title?: string
}

const OPEN_CODE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/

export function isAuthoritativeOpenCodeSessionId(value: unknown): value is string {
  return typeof value === 'string' && OPEN_CODE_SESSION_ID.test(value)
}

export type OpenCodeClientRequestContext = {
  signal?: AbortSignal
  remainingMs?: () => number
}

type OpenCodeClientFactoryDeps = {
  fetchImpl?: typeof fetch
}

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000
const MCP_REQUEST_TIMEOUT_MS = 35_000
const PERMISSION_REQUEST_TIMEOUT_MS = 2_500
const MESSAGE_REQUEST_TIMEOUT_MS = 120_000
const PROVIDER_OAUTH_AUTHORIZE_TIMEOUT_MS = 30_000
const DEFAULT_RESPONSE_BODY_MAX_BYTES = 8 * 1024 * 1024
const PROVIDER_RESPONSE_BODY_MAX_BYTES = 2 * 1024 * 1024
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

async function readBoundedResponseText(response: Response, maxBytes: number): Promise<string> {
  const declared = response.headers.get('content-length')
  if (declared !== null) {
    const length = Number(declared)
    if (!Number.isSafeInteger(length) || length < 0 || length > maxBytes) {
      throw new Error('OpenCode response body exceeded the allowed size.')
    }
  }
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let bytes = 0
  let text = ''
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw new Error('OpenCode response body exceeded the allowed size.')
      }
      text += decoder.decode(chunk.value, { stream: true })
    }
    return text + decoder.decode()
  } finally {
    reader.releaseLock()
  }
}

async function parseResponse<T>(response: Response, maxBytes: number): Promise<T> {
  const text = await readBoundedResponseText(response, maxBytes)
  if (!response.ok) {
    throw new Error(
      `OpenCode request failed (${response.status} ${response.statusText}): ${text || 'no response body'}`,
    )
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

  create(baseUrl: string, context: OpenCodeClientRequestContext = {}): OpenCodeClient {
    const fetchImpl = this.deps.fetchImpl ?? fetch

    const request = async <T>(
      path: string,
      init?: RequestInit,
      endpointTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
      responseBodyMaxBytes = DEFAULT_RESPONSE_BODY_MAX_BYTES,
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
        const response = await fetchImpl(baseUrl + path, {
          ...init,
          signal: controller.signal,
          headers: {
            'content-type': 'application/json',
            ...(init?.headers ?? {}),
          },
        })
        return parseResponse<T>(response, responseBodyMaxBytes)
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
      getProviders: () => request<OpenCodeProviderResponse>(
        '/provider', undefined, DEFAULT_REQUEST_TIMEOUT_MS, PROVIDER_RESPONSE_BODY_MAX_BYTES,
      ),
      getProviderCatalog: providerId => request<unknown>(
        `/provider/${encodeURIComponent(providerId)}`, undefined,
        DEFAULT_REQUEST_TIMEOUT_MS, PROVIDER_RESPONSE_BODY_MAX_BYTES,
      ),
      getProviderAuth: () =>
        request<Record<string, OpenCodeProviderAuthMethod[]>>('/provider/auth'),
      getServerDoc: () => request<OpenCodeServerDocResponse>('/doc'),
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
      createSession: async body => {
        if (body?.id !== undefined && !isAuthoritativeOpenCodeSessionId(body.id)) {
          throw new TypeError('OpenCode authoritative session id is invalid')
        }
        const session = await request<OpenCodeSessionSummary>('/session', {
          method: 'POST',
          body: JSON.stringify(body ?? {}),
        })
        if (!isAuthoritativeOpenCodeSessionId(session?.id)
          || (body?.id !== undefined && session.id !== body.id)) {
          throw new Error('OpenCode create-session response did not preserve the authoritative session id')
        }
        return session
      },
      getSession: id => request<OpenCodeSessionSummary>(`/session/${id}`),
      deleteSession: id => request<boolean>(`/session/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      }),
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
        const candidatePaths = [
          `/permission/${encodedRequestId}`,
          `/permission/${encodedRequestId}/reply`,
          `/permission/${encodedRequestId}/respond`,
          `/permission/reply`,
          `/permission/respond`,
        ]
        let lastError: unknown = null
        for (const path of candidatePaths) {
          try {
            return await request<unknown>(
              path,
              {
                method: 'POST',
                body: JSON.stringify(payload),
              },
              PERMISSION_REQUEST_TIMEOUT_MS,
            )
          } catch (error) {
            lastError = error
          }
        }
        throw lastError instanceof Error
          ? lastError
          : new Error(`OpenCode permission answer failed for ${body.requestId}`)
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
