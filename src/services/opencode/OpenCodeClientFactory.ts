import type {
  OpenCodeAgentResponse,
  OpenCodeConfigProvidersResponse,
  OpenCodeConfigResponse,
  OpenCodeMessage,
  OpenCodeMcpResponse,
  OpenCodeMcpServerConfig,
  OpenCodePendingPermission,
  OpenCodeProviderAuthMethod,
  OpenCodeProviderResponse,
  OpenCodeSessionStatus,
  OpenCodeSessionSummary,
} from './types.js'

export type OpenCodeClient = {
  getConfig(): Promise<OpenCodeConfigResponse>
  getConfigProviders(): Promise<OpenCodeConfigProvidersResponse>
  getProviders(): Promise<OpenCodeProviderResponse>
  getProviderAuth(): Promise<Record<string, OpenCodeProviderAuthMethod[]>>
  listAgents(): Promise<OpenCodeAgentResponse[]>
  getMcp(): Promise<OpenCodeMcpResponse>
  addMcp?(name: string, config: OpenCodeMcpServerConfig): Promise<OpenCodeMcpResponse>
  createSession(body?: { parentID?: string; title?: string }): Promise<OpenCodeSessionSummary>
  getSession(id: string): Promise<OpenCodeSessionSummary>
  getSessionStatus(): Promise<Record<string, OpenCodeSessionStatus>>
  getSessionMessages(id: string, limit?: number): Promise<OpenCodeMessage[]>
  getPermissions(): Promise<OpenCodePendingPermission[]>
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
      tools?: unknown[]
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
      tools?: unknown[]
      model?: {
        providerID: string
        modelID: string
      }
      parts: Array<Record<string, unknown>>
    },
  ): Promise<void>
  abortSession(id: string): Promise<boolean>
}

type OpenCodeClientFactoryDeps = {
  fetchImpl?: typeof fetch
}

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000
const PERMISSION_REQUEST_TIMEOUT_MS = 2_500

async function parseResponse<T>(response: Response): Promise<T> {
  const text = await response.text()
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

export class OpenCodeClientFactory {
  constructor(private readonly deps: OpenCodeClientFactoryDeps = {}) {}

  create(baseUrl: string): OpenCodeClient {
    const fetchImpl = this.deps.fetchImpl ?? fetch

    const request = async <T>(
      path: string,
      init?: RequestInit,
      timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    ): Promise<T> => {
      const controller = new AbortController()
      const timeout = setTimeout(() => {
        controller.abort(
          new Error(`OpenCode request timed out after ${timeoutMs}ms for ${path}`),
        )
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
        return parseResponse<T>(response)
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          throw new Error(`OpenCode request timed out after ${timeoutMs}ms for ${path}`)
        }
        throw error
      } finally {
        clearTimeout(timeout)
      }
    }

    return {
      getConfig: () => request<OpenCodeConfigResponse>('/config'),
      getConfigProviders: () => request<OpenCodeConfigProvidersResponse>('/config/providers'),
      getProviders: () => request<OpenCodeProviderResponse>('/provider'),
      getProviderAuth: () => request<Record<string, OpenCodeProviderAuthMethod[]>>('/provider/auth'),
      listAgents: () => request<OpenCodeAgentResponse[]>('/agent'),
      getMcp: () => request<OpenCodeMcpResponse>('/mcp'),
      addMcp: (name, config) =>
        request<OpenCodeMcpResponse>('/mcp', {
          method: 'POST',
          body: JSON.stringify({
            name,
            config,
          }),
        }),
      createSession: body =>
        request<OpenCodeSessionSummary>('/session', {
          method: 'POST',
          body: JSON.stringify(body ?? {}),
        }),
      getSession: id => request<OpenCodeSessionSummary>(`/session/${id}`),
      getSessionStatus: () => request<Record<string, OpenCodeSessionStatus>>('/session/status'),
      getSessionMessages: (id, limit) =>
        request<OpenCodeMessage[]>(
          `/session/${id}/message${typeof limit === 'number' ? `?limit=${limit}` : ''}`,
        ),
      getPermissions: () =>
        request<OpenCodePendingPermission[]>('/permission', undefined, PERMISSION_REQUEST_TIMEOUT_MS),
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
      },
      sendSessionMessage: (id, body) =>
        request<OpenCodeMessage>(`/session/${id}/message`, {
          method: 'POST',
          body: JSON.stringify(body),
        }),
      promptSessionAsync: async (id, body) => {
        await request<void>(`/session/${id}/prompt_async`, {
          method: 'POST',
          body: JSON.stringify(body),
        })
      },
      abortSession: id =>
        request<boolean>(`/session/${id}/abort`, {
          method: 'POST',
        }),
    }
  }
}

export const openCodeClientFactory = new OpenCodeClientFactory()
