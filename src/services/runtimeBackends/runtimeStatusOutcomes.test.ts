import { afterEach, describe, expect, test } from 'bun:test'

import { geminiApiBackend } from '../gemini/backends/apiBackend.js'
import { geminiCliBackend } from '../gemini/backends/cliBackend.js'
import { buildAnthropicRuntimeStatus } from './anthropicStatus.js'
import { getUnifiedRuntimeStatusPayload } from './registry.js'
import type { RuntimeProviderModelCatalog } from './types.js'

const originalWhich = Bun.which
const originalApiValidate = geminiApiBackend.validate
const originalCliValidate = geminiCliBackend.validate
const originalEnv = { ...process.env }

afterEach(() => {
  Bun.which = originalWhich
  geminiApiBackend.validate = originalApiValidate
  geminiCliBackend.validate = originalCliValidate
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
      statusCheckOutcome: 'pending',
      statusCheckErrorCode: 'partial_response',
    })
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
