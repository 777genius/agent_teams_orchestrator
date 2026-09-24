import { afterEach, describe, expect, test } from 'bun:test'

import { geminiApiBackend } from '../gemini/backends/apiBackend.js'
import { geminiCliBackend } from '../gemini/backends/cliBackend.js'
import { buildAnthropicRuntimeStatus } from './anthropicStatus.js'
import { getUnifiedRuntimeStatusPayload } from './registry.js'
import type { RuntimeProviderModelCatalog } from './types.js'

const originalWhich = Bun.which
const originalApiValidate = geminiApiBackend.validate
const originalCliValidate = geminiCliBackend.validate
const originalFetch = globalThis.fetch
const originalEnv = { ...process.env }

afterEach(() => {
  Bun.which = originalWhich
  geminiApiBackend.validate = originalApiValidate
  geminiCliBackend.validate = originalCliValidate
  globalThis.fetch = originalFetch
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key]
  }
  Object.assign(process.env, originalEnv)
})

describe('runtime status outcome completeness', () => {
  test('Anthropic full status distinguishes ready and degraded catalogs', () => {
    const ready = anthropicStatus(catalog('ready'))
    const degraded = anthropicStatus(catalog('degraded'))
    const unavailable = anthropicStatus(catalog('unavailable'))

    expect(ready).toMatchObject({
      statusCheckOutcome: 'authoritative',
      statusCheckErrorCode: null,
    })
    expect(degraded).toMatchObject({
      statusCheckOutcome: 'pending',
      statusCheckErrorCode: 'partial_response',
    })
    expect(unavailable).toMatchObject({
      statusCheckOutcome: 'transient_error',
      statusCheckErrorCode: 'unavailable',
    })
  })

  test('Anthropic summary status is explicitly authoritative', async () => {
    for (const key of [
      'ANTHROPIC_AWS_WORKSPACE_ID', 'ANTHROPIC_BASE_URL',
      'CLAUDE_CODE_ENTRY_PROVIDER', 'CLAUDE_CODE_USE_BEDROCK',
      'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_VERTEX',
    ]) delete process.env[key]
    process.env.ANTHROPIC_API_KEY = 'test-key'

    const payload = await getUnifiedRuntimeStatusPayload(
      'anthropic', undefined, { detailLevel: 'summary' },
    )
    expect(payload.providers.anthropic).toMatchObject({
      statusCheckOutcome: 'authoritative',
      statusCheckErrorCode: null,
    })
  })

  test('Codex summary and full ready statuses are explicitly authoritative', async () => {
    process.env.CODEX_API_KEY = 'test-key'
    Bun.which = ((name: string) => name === 'codex' ? '/test/codex' : null) as typeof Bun.which

    const summary = await getUnifiedRuntimeStatusPayload(
      'codex', undefined, { detailLevel: 'summary' },
    )
    const full = await getUnifiedRuntimeStatusPayload('codex', {
      getCodexModelCatalog: async () => catalog('ready', 'codex'),
    })
    const degraded = await getUnifiedRuntimeStatusPayload('codex', {
      getCodexModelCatalog: async () => catalog('degraded', 'codex'),
    })

    for (const status of [summary.providers.codex, full.providers.codex]) {
      expect(status).toMatchObject({
        statusCheckOutcome: 'authoritative',
        statusCheckErrorCode: null,
      })
    }
    expect(degraded.providers.codex).toMatchObject({
      statusCheckOutcome: 'transient_error',
      statusCheckErrorCode: 'unavailable',
    })
  })

  test('Codex settled catalog timeouts do not remain pending or change auth', async () => {
    process.env.CODEX_API_KEY = 'test-key'
    Bun.which = ((name: string) => name === 'codex' ? '/test/codex' : null) as typeof Bun.which

    for (const status of ['degraded', 'stale', 'unavailable'] as const) {
      const failed = catalog(status, 'codex')
      failed.diagnostics.code = 'timeout'
      failed.diagnostics.message = 'JSON-RPC request timed out: initialize'
      const payload = await getUnifiedRuntimeStatusPayload('codex', {
        getCodexModelCatalog: async () => failed,
      })
      expect(payload.providers.codex).toMatchObject({
        authenticated: true,
        verificationState: 'verified',
        statusCheckOutcome: 'transient_error',
        statusCheckErrorCode: 'timeout',
      })
    }
  })

  test('Codex configured CLI nonzero status fails closed in summary and full', async () => {
    delete process.env.CODEX_API_KEY
    delete process.env.OPENAI_API_KEY
    process.env.CODEX_CLI_PATH = '/bin/false'
    process.env.CLAUDE_CODE_CODEX_FORCED_LOGIN_METHOD = 'chatgpt'

    for (const detailLevel of ['summary', 'full'] as const) {
      const payload = await getUnifiedRuntimeStatusPayload(
        'codex',
        detailLevel === 'full'
          ? { getCodexModelCatalog: async () => catalog('ready', 'codex') }
          : undefined,
        { detailLevel },
      )
      expect(payload.providers.codex).toMatchObject({
        authenticated: false,
        authMethod: null,
        verificationState: 'error',
        resolvedBackendId: null,
        capabilities: { teamLaunch: false },
        statusCheckOutcome: 'transient_error',
        statusCheckErrorCode: 'unavailable',
      })
      expect(payload.providers.codex?.detailMessage).toContain(
        'binary=configured-env:/bin/false',
      )
      expect(payload.providers.codex?.detailMessage).toContain('login=unknown')
    }
  })

  test('Gemini summary and full current statuses are explicitly authoritative', async () => {
    geminiApiBackend.validate = async () => ({
      ok: true,
      backend: 'api',
      authMethod: 'api_key',
      endpointLabel: 'test-api',
    })
    geminiCliBackend.validate = async () => ({
      ok: false,
      backend: 'cli',
      authMethod: 'none',
      endpointLabel: 'test-cli',
      message: 'Not configured',
    })

    for (const detailLevel of ['summary', 'full'] as const) {
      const payload = await getUnifiedRuntimeStatusPayload(
        'gemini', undefined, { detailLevel },
      )
      expect(payload.providers.gemini).toMatchObject({
        statusCheckOutcome: 'authoritative',
        statusCheckErrorCode: null,
      })
    }

    geminiApiBackend.validate = async () => ({
      ok: false,
      backend: 'api',
      authMethod: 'api_key',
      endpointLabel: 'test-api',
      message: 'Validation unavailable',
    })
    const failed = await getUnifiedRuntimeStatusPayload('gemini')
    expect(failed.providers.gemini).toMatchObject({
      statusCheckOutcome: 'transient_error',
      statusCheckErrorCode: 'unavailable',
    })

    geminiApiBackend.validate = async () => ({
      ok: false,
      backend: 'api',
      authMethod: 'api_key',
      endpointLabel: 'test-api',
      message: 'Invalid API key',
      validationError: 'invalid_credentials',
    })
    for (const detailLevel of ['summary', 'full'] as const) {
      const invalid = await getUnifiedRuntimeStatusPayload(
        'gemini', undefined, { detailLevel },
      )
      expect(invalid.providers.gemini).toMatchObject({
        authenticated: false,
        verificationState: 'unknown',
        resolvedBackendId: null,
        capabilities: { teamLaunch: false },
        statusCheckOutcome: 'authoritative',
        statusCheckErrorCode: null,
      })
    }
  })

  test('Gemini API success survives unused CLI EACCES in auto and API-pinned status', async () => {
    geminiApiBackend.validate = async () => ({
      ok: true,
      backend: 'api',
      authMethod: 'api_key',
      endpointLabel: 'test-api',
    })
    geminiCliBackend.validate = async () => {
      const error = new Error('permission denied reading Gemini credential store')
      Object.assign(error, { code: 'EACCES' })
      throw error
    }

    for (const preference of ['auto', 'api'] as const) {
      process.env.CLAUDE_CODE_GEMINI_BACKEND = preference
      for (const detailLevel of ['summary', 'full'] as const) {
        const payload = await getUnifiedRuntimeStatusPayload(
          'gemini', undefined, { detailLevel },
        )
        const status = payload.providers.gemini
        expect(status).toMatchObject({
          authenticated: true,
          authMethod: 'api_key',
          verificationState: 'verified',
          resolvedBackendId: 'api',
          capabilities: { teamLaunch: true },
          statusCheckOutcome: 'authoritative',
          statusCheckErrorCode: null,
        })
        expect(
          status?.availableBackends.find(option => option.id === 'cli-sdk'),
        ).toMatchObject({
          available: false,
          detailMessage: expect.stringContaining('permission denied'),
        })
      }
    }
  })

  test('Gemini CLI-pinned success survives unused API operational failure', async () => {
    process.env.CLAUDE_CODE_GEMINI_BACKEND = 'cli'
    geminiApiBackend.validate = async () => ({
      ok: false,
      backend: 'api',
      authMethod: 'api_key',
      endpointLabel: 'test-api',
      message: 'API validation unavailable',
      validationError: 'operational',
    })
    geminiCliBackend.validate = async () => ({
      ok: true,
      backend: 'cli',
      authMethod: 'cli_oauth_personal',
      endpointLabel: 'test-cli',
    })

    const payload = await getUnifiedRuntimeStatusPayload('gemini')
    expect(payload.providers.gemini).toMatchObject({
      authenticated: true,
      authMethod: 'cli_oauth_personal',
      verificationState: 'verified',
      resolvedBackendId: 'cli-sdk',
      capabilities: { teamLaunch: true },
      statusCheckOutcome: 'authoritative',
      statusCheckErrorCode: null,
    })
  })

  test('Gemini recognizes only the explicit Google invalid-key HTTP 400', async () => {
    process.env.GEMINI_API_KEY = 'invalid-test-key'
    globalThis.fetch = async () => new Response(JSON.stringify({
      error: {
        code: 400,
        status: 'INVALID_ARGUMENT',
        message: 'API key not valid. Please pass a valid API key.',
      },
    }), { status: 400 })
    expect(await geminiApiBackend.validate()).toMatchObject({
      ok: false,
      authMethod: 'api_key',
      validationError: 'invalid_credentials',
    })

    globalThis.fetch = async () => new Response(JSON.stringify({
      error: { code: 400, status: 'INVALID_ARGUMENT', message: 'Bad request.' },
    }), { status: 400 })
    expect(await geminiApiBackend.validate()).toMatchObject({
      ok: false,
      validationError: 'operational',
    })
  })

  test('Gemini permission-denied validation fails closed in summary and full', async () => {
    geminiApiBackend.validate = async () => ({
      ok: false,
      backend: 'api',
      authMethod: 'none',
      endpointLabel: 'test-api',
      message: 'Not configured',
    })
    geminiCliBackend.validate = async () => {
      const error = new Error('permission denied reading Gemini credential store')
      Object.assign(error, { code: 'EACCES' })
      throw error
    }

    for (const detailLevel of ['summary', 'full'] as const) {
      const payload = await getUnifiedRuntimeStatusPayload(
        'gemini', undefined, { detailLevel },
      )
      expect(payload.providers.gemini).toMatchObject({
        authenticated: false,
        authMethod: null,
        verificationState: 'error',
        resolvedBackendId: null,
        capabilities: { teamLaunch: false },
        statusCheckOutcome: 'transient_error',
        statusCheckErrorCode: 'unavailable',
      })
    }
  })
})

function anthropicStatus(modelCatalog: RuntimeProviderModelCatalog) {
  return buildAnthropicRuntimeStatus({
    auth: { authenticated: true, authMethod: 'api_key' },
    modelCatalog,
    visibleModels: ['test-model'],
    reasoningEfforts: [],
    fastMode: { supported: false, available: false, reason: null, source: 'runtime' },
    extensions: {
      plugins: { status: 'supported', ownership: 'shared', reason: null },
      mcp: { status: 'supported', ownership: 'shared', reason: null },
      skills: { status: 'supported', ownership: 'shared', reason: null },
      apiKeys: { status: 'supported', ownership: 'shared', reason: null },
    },
  })
}

function catalog(
  status: RuntimeProviderModelCatalog['status'],
  providerId: 'anthropic' | 'codex' = 'anthropic',
): RuntimeProviderModelCatalog {
  return {
    schemaVersion: 1,
    providerId,
    source: 'app-server',
    status,
    fetchedAt: '2026-08-28T00:00:00.000Z',
    staleAt: '2026-08-28T00:10:00.000Z',
    defaultModelId: null,
    defaultLaunchModel: null,
    models: [],
    diagnostics: { configReadState: 'ready', appServerState: 'healthy' },
  }
}
