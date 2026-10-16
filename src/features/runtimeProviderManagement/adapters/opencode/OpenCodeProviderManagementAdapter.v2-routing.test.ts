import { expect, mock, test } from 'bun:test'
import { OpenCodeVersionProbeCleanupError } from '../../../../services/opencode/compatibility/OpenCodeVersionProbe.js'
import type { ConnectProviderInput, LoadProviderModelsInput, TestProviderModelInput } from '../../domain/types.js'

// Run this module alone: replacement is a private transport boundary, never a production capability/proof hook.
let selectedV2 = true
let selectedIdentityError: unknown
const connectCalls: ConnectProviderInput[] = [], modelCalls: LoadProviderModelsInput[] = [], testCalls: TestProviderModelInput[] = []
const boundaryFailure = { ok: false as const, error: { code: 'runtime-unhealthy' as const, message: 'TEST owned V2 boundary reached', recoverable: true } }
mock.module('./OpenCodeV2ProviderManagement.js', () => ({
  selectedProviderUsesOpenCodeV2: async () => { if (selectedIdentityError !== undefined) throw selectedIdentityError; return selectedV2 },
  connectOpenCodeV2Provider: async (input: ConnectProviderInput) => { connectCalls.push(input); return boundaryFailure },
  loadOpenCodeV2ProviderModels: async (input: LoadProviderModelsInput) => { modelCalls.push(input); return boundaryFailure },
  testOpenCodeV2ProviderModel: async (input: TestProviderModelInput) => { testCalls.push(input); return boundaryFailure },
}))
const { OpenCodeProviderManagementAdapter } = await import('./OpenCodeProviderManagementAdapter.js')
let legacyReads = 0
const adapter = new OpenCodeProviderManagementAdapter({ inventoryService: { probe: async () => { legacyReads++; throw new Error('TEST legacy inventory must not execute for V2') } } })

test('public API-key convenience method and direct connect route reach V2 after existing validation', async () => {
  selectedV2 = true; const before = connectCalls.length
  expect(await adapter.connectWithApiKey({ runtimeId: 'opencode', providerId: ' GROQ ', apiKey: ' TEST-key ', projectPath: '/TEST/project' })).toEqual(boundaryFailure)
  expect(await adapter.connectProvider({ runtimeId: 'opencode', providerId: ' GROQ ', method: 'api', apiKey: ' TEST-key ', projectPath: '/TEST/project' })).toEqual(boundaryFailure)
  expect(connectCalls.slice(before).map(input => [input.method, input.providerId, input.apiKey, input.projectPath])).toEqual([
    ['api', 'groq', 'TEST-key', '/TEST/project'], ['api', 'groq', 'TEST-key', '/TEST/project'],
  ])
  expect(legacyReads).toBe(0)
  const count = connectCalls.length
  const invalid = await adapter.connectWithApiKey({ runtimeId: 'opencode', providerId: '', apiKey: 'TEST-key' })
  const noKey = await adapter.connectWithApiKey({ runtimeId: 'opencode', providerId: 'groq', apiKey: ' ' })
  expect(invalid.ok).toBe(false); if (!invalid.ok) expect(invalid.error.code).toBe('provider-missing')
  expect(noKey.ok).toBe(false); if (!noKey.ok) expect(noKey.error.code).toBe('auth-required')
  expect(connectCalls.length).toBe(count); expect(legacyReads).toBe(0)
})

test('public V2 OAuth routes to typed refusal boundary before legacy OAuth inventory', async () => {
  selectedV2 = true; const before = connectCalls.length
  expect(await adapter.connectProvider({ runtimeId: 'opencode', providerId: 'xai', method: 'oauth' })).toEqual(boundaryFailure)
  expect(connectCalls.length).toBe(before + 1); expect(connectCalls.at(-1)?.method).toBe('oauth'); expect(legacyReads).toBe(0)
})

test('actual public models and model-test routes preserve normalized identity before V2 transport', async () => {
  selectedV2 = true
  expect(await adapter.loadModels({ runtimeId: 'opencode', providerId: ' GROQ ', projectPath: '/TEST/project' })).toEqual(boundaryFailure)
  expect(await adapter.testModel({ runtimeId: 'opencode', providerId: ' GROQ ', modelId: ' c41-upstream ', projectPath: '/TEST/project' })).toEqual(boundaryFailure)
  expect(modelCalls.at(-1)?.providerId).toBe('groq')
  expect(testCalls.at(-1)?.providerId).toBe('groq'); expect(testCalls.at(-1)?.modelId).toBe('groq/c41-upstream'); expect(legacyReads).toBe(0)
})

test('V1 selection still enters existing managed inventory rather than V2 key transport', async () => {
  selectedV2 = false; const before = connectCalls.length
  const result = await adapter.connectWithApiKey({ runtimeId: 'opencode', providerId: 'groq', apiKey: 'TEST-key' })
  expect(result.ok).toBe(false); expect(connectCalls.length).toBe(before); expect(legacyReads).toBe(1)
})

test("public models failure retains only this invocation's bounded identity evidence", async () => {
  const beforeLegacy = legacyReads, beforeModels = modelCalls.length
  const helperCause = { stage: 'process_lookup' as const, category: 'ArgumentException' as const,
    hresult: -2147024809, nativeErrorCode: null }
  const terminal = { phase: 'anchor_identity' as const, guard: 'anchor_missing' as const,
    closed: true, ended: true, exitCode: 0, birthsCount: 1, candidatesCount: 0, pendingCount: 0,
    lastGroupCount: 3, lastSurvivorCount: null, remainingMs: 6515 }
  const helper = { operation: 'birth' as const, reason: 'helper_nonzero' as const, exitCode: 1, elapsedMs: 330,
    helperCause: Object.assign({}, helperCause, { message: 'TEST-PRIVATE helper message', path: '/TEST-PRIVATE/helper' }) }
  const input = { runtimeId: 'opencode' as const, providerId: 'kiro', projectPath: '/TEST-PRIVATE/project' }
  const readDiagnostic = async () => {
    const result = await adapter.loadModels(input)
    expect(result.ok).toBe(false)
    if (result.ok === true) throw new Error('TEST expected identity refusal')
    expect(result.error.code).toBe('runtime-unhealthy')
    expect(result.error.recoverable).toBe(true)
    const prefix = 'Selected OpenCode identity is unavailable [identityDiagnostic='
    expect(result.error.message.length).toBeLessThanOrEqual(prefix.length + 2049)
    expect(result.error.message).not.toContain('TEST-PRIVATE')
    expect(result.error.message.startsWith(prefix)).toBe(true)
    expect(result.error.message.endsWith(']')).toBe(true)
    return JSON.parse(result.error.message.slice(prefix.length, -1))
  }
  try {
    selectedIdentityError = new OpenCodeVersionProbeCleanupError(
      new Error('TEST-PRIVATE raw cause /TEST-PRIVATE/root'),
      Object.assign({}, helper, { stderr: 'TEST-PRIVATE stderr', path: '/TEST-PRIVATE/native' }),
      Object.assign({}, terminal, { path: '/TEST-PRIVATE/probe', secret: 'TEST-PRIVATE secret' }),
    )
    expect(await readDiagnostic()).toEqual({
      original: { category: 'OpenCodeVersionProbeCleanupError', code: 'cleanup_unknown' }, cause: { category: 'Error' },
      diagnostics: [
        { code: 'opencode_version_probe_helper_failed', evidence: 'last_observed', operation: 'birth', reason: 'helper_nonzero',
          exitCode: 1, elapsedMs: 330, helperCause },
        { code: 'opencode_version_probe_cleanup_unknown', ...terminal },
      ],
    })
    selectedIdentityError = new OpenCodeVersionProbeCleanupError(undefined, null, terminal)
    expect(await readDiagnostic()).toEqual({
      original: { category: 'OpenCodeVersionProbeCleanupError', code: 'cleanup_unknown' },
      diagnostics: [{ code: 'opencode_version_probe_cleanup_unknown', ...terminal }],
    })
    selectedIdentityError = Object.assign(new Error('TEST-PRIVATE failed open /TEST-PRIVATE/native'), { code: 'ENOENT', path: '/TEST-PRIVATE/native' })
    expect(await readDiagnostic()).toEqual({ original: { category: 'Error', errno: 'ENOENT' } })
    expect(legacyReads).toBe(beforeLegacy)
    expect(modelCalls.length).toBe(beforeModels)
  } finally { selectedIdentityError = undefined }
})
