import { describe, expect, test } from 'bun:test'

import {
  resetAnthropicRuntimeCatalogCache,
} from '../../services/runtimeBackends/anthropicCatalog.js'
import { getUnifiedRuntimeStatusPayload } from '../../services/runtimeBackends/registry.js'
import { AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE_ENV } from '../../utils/anthropicConnectionMode.js'
import { getProviderModels } from './model.js'

const runtimeGlobal = globalThis as typeof globalThis & {
  MACRO?: {
    VERSION: string
    BUILD_TIME: string
    PACKAGE_URL: string
    FEEDBACK_CHANNEL: string
  }
}
runtimeGlobal.MACRO ??= {
  VERSION: 'test',
  BUILD_TIME: '2026-05-21T00:00:00.000Z',
  PACKAGE_URL: 'test',
  FEEDBACK_CHANNEL: 'test',
}

type CapturedRequest = {
  path: string
  authorization: string | null
  apiKey: string | null
  customHeader: string | null
}

const defaultGatewayModels: Record<string, unknown>[] = [
  {
    id: 'qwen3.6',
    object: 'model',
    display_name: 'Qwen 3.6',
    max_input_tokens: 128_000,
  },
  {
    id: 'glm-5:cloud',
    object: 'model',
    display_name: 'GLM 5 Cloud',
  },
]

function createAnthropicCompatibleServer(
  models: Record<string, unknown>[] = defaultGatewayModels,
): {
  baseUrl: string
  requests: CapturedRequest[]
  stop: () => void
} {
  const requests: CapturedRequest[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      requests.push({
        path: url.pathname,
        authorization: request.headers.get('authorization'),
        apiKey: request.headers.get('x-api-key'),
        customHeader: request.headers.get('x-test-gateway'),
      })

      if (url.pathname !== '/v1/models') {
        return new Response('not found', { status: 404 })
      }

      return Response.json({
        data: models,
      })
    },
  })

  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    requests,
    stop: () => server.stop(true),
  }
}

async function withAnthropicCompatibleEnv<T>(
  baseUrl: string,
  operation: () => Promise<T>,
): Promise<T> {
  const envKeys = [
    AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE_ENV,
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_CUSTOM_HEADERS',
    'ANTHROPIC_AWS_WORKSPACE_ID',
    'ANTHROPIC_FOUNDRY_API_KEY',
    'ANTHROPIC_FOUNDRY_RESOURCE',
    'CLAUDE_CODE_ENTRY_PROVIDER',
    'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_FOUNDRY',
    'CLAUDE_CODE_USE_VERTEX',
  ] as const
  const originalEnv = new Map<string, string | undefined>(
    envKeys.map(key => [key, process.env[key]]),
  )

  process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1'
  process.env.CLAUDE_CODE_ENTRY_PROVIDER = 'anthropic'
  process.env[AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE_ENV] = 'compatible'
  process.env.ANTHROPIC_BASE_URL = baseUrl
  process.env.ANTHROPIC_AUTH_TOKEN = 'ollama'
  process.env.ANTHROPIC_API_KEY = ''
  process.env.ANTHROPIC_CUSTOM_HEADERS = 'X-Test-Gateway: yes'
  delete process.env.ANTHROPIC_AWS_WORKSPACE_ID
  delete process.env.ANTHROPIC_FOUNDRY_API_KEY
  delete process.env.ANTHROPIC_FOUNDRY_RESOURCE
  delete process.env.CLAUDE_CODE_USE_BEDROCK
  delete process.env.CLAUDE_CODE_USE_FOUNDRY
  delete process.env.CLAUDE_CODE_USE_VERTEX
  resetAnthropicRuntimeCatalogCache()

  try {
    return await operation()
  } finally {
    resetAnthropicRuntimeCatalogCache()
    for (const key of envKeys) {
      const value = originalEnv.get(key)
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  }
}

describe('Anthropic-compatible runtime integration', () => {
  test('discovers Ollama-style models for model list and runtime status', async () => {
    const server = createAnthropicCompatibleServer()

    try {
      await withAnthropicCompatibleEnv(server.baseUrl, async () => {
        const modelList = await getProviderModels('anthropic')
        expect(modelList.defaultModel).toBe('qwen3.6')
        expect(modelList.models).toEqual([
          expect.objectContaining({ id: 'qwen3.6', label: 'Qwen 3.6' }),
          expect.objectContaining({ id: 'glm-5:cloud', label: 'GLM 5 Cloud' }),
        ])

        resetAnthropicRuntimeCatalogCache()
        let rateLimitRefreshCalls = 0
        const statusPayload = await getUnifiedRuntimeStatusPayload('anthropic', {
          getAnthropicSubscriptionRateLimits: () => {
            rateLimitRefreshCalls += 1
            return null
          },
        })
        const anthropic = statusPayload.providers.anthropic
        expect(rateLimitRefreshCalls).toBe(0)
        expect(anthropic?.authenticated).toBe(true)
        expect(anthropic?.authMethod).toBe('ollama_token')
        expect(anthropic?.selectedBackendId).toBe('ollama')
        expect(anthropic?.resolvedBackendId).toBe('ollama')
        expect(anthropic?.models).toEqual(['qwen3.6', 'glm-5:cloud'])
        expect(anthropic?.subscriptionRateLimits).toBeNull()
        expect(anthropic?.backend).toMatchObject({
          kind: 'ollama',
          authMethodDetail: 'ollama_token',
        })
        expect(anthropic?.modelCatalog).toMatchObject({
          source: 'anthropic-compatible-api',
          defaultLaunchModel: 'qwen3.6',
        })
      })

      expect(server.requests.length).toBeGreaterThanOrEqual(2)
      expect(server.requests.every(request => request.path === '/v1/models')).toBe(
        true,
      )
      expect(
        server.requests.every(
          request =>
            request.authorization === 'Bearer ollama' &&
            request.apiKey === null &&
            request.customHeader === 'yes',
        ),
      ).toBe(true)
    } finally {
      server.stop()
    }
  })

  test('does not duplicate /v1/models when the configured base URL already targets models', async () => {
    const server = createAnthropicCompatibleServer()

    try {
      await withAnthropicCompatibleEnv(`${server.baseUrl}/v1/models`, async () => {
        const modelList = await getProviderModels('anthropic')

        expect(modelList.defaultModel).toBe('qwen3.6')
        expect(modelList.models.map(model => model.id)).toEqual([
          'qwen3.6',
          'glm-5:cloud',
        ])
      })

      expect(server.requests.map(request => request.path)).toEqual([
        '/v1/models',
      ])
    } finally {
      server.stop()
    }
  })

  test('does not reuse the model catalog cache after switching compatible base URLs', async () => {
    const firstServer = createAnthropicCompatibleServer([
      {
        id: 'qwen3.6',
        object: 'model',
        display_name: 'Qwen 3.6',
      },
    ])
    const secondServer = createAnthropicCompatibleServer([
      {
        id: 'local-llama',
        object: 'model',
        display_name: 'Local Llama',
      },
    ])

    try {
      await withAnthropicCompatibleEnv(firstServer.baseUrl, async () => {
        const firstModelList = await getProviderModels('anthropic')
        expect(firstModelList.models.map(model => model.id)).toEqual(['qwen3.6'])

        process.env.ANTHROPIC_BASE_URL = secondServer.baseUrl
        const secondModelList = await getProviderModels('anthropic')
        expect(secondModelList.models.map(model => model.id)).toEqual([
          'local-llama',
        ])
      })

      expect(firstServer.requests.map(request => request.path)).toEqual([
        '/v1/models',
      ])
      expect(secondServer.requests.map(request => request.path)).toEqual([
        '/v1/models',
      ])
    } finally {
      firstServer.stop()
      secondServer.stop()
    }
  })
})
