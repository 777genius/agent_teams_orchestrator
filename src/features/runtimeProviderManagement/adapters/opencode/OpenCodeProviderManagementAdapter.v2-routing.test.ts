import { expect, mock, test } from 'bun:test'
import { OpenCodeVersionProbeCleanupError } from '../../../../services/opencode/compatibility/OpenCodeVersionProbe.js'
import { requireOpenCodeProviderRoute } from './OpenCodeProviderRoute.js'
import { openCodeV2Dialect } from '../../../../services/opencode/compatibility/OpenCodeV2Registry.js'
import type { ConnectProviderInput, LoadProviderModelsInput, LoadProviderSetupFormInput, TestProviderModelInput } from '../../domain/types.js'

// Run this module alone: replacement is a private transport boundary, never a production capability/proof hook.
let selectedV2 = true
let overrideSelection: 'v2-missing-native' | 'unsupported' | 'v2-version-mismatch' | null = null
let selectedIdentityError: unknown
let selectionReads = 0
let lastReadSelection: unknown
const modelSelections: unknown[] = []
const setupCalls: LoadProviderSetupFormInput[] = [], setupSelections: unknown[] = []
const connectCalls: ConnectProviderInput[] = [], modelCalls: LoadProviderModelsInput[] = [], testCalls: TestProviderModelInput[] = []
const boundaryFailure = { ok: false as const, error: { code: 'runtime-unhealthy' as const, message: 'TEST owned V2 boundary reached', recoverable: true } }
mock.module('./OpenCodeV2ProviderManagement.js', () => ({
  buildOpenCodeV2KeySetupForm: () => null,
  inspectOpenCodeReadSelection: async () => {
    selectionReads++
    if (selectedIdentityError !== undefined) throw selectedIdentityError
    lastReadSelection = overrideSelection === 'v2-missing-native'
      ? { policy: { generation: 'v2', version: '2.1.4' }, native: null }
      : overrideSelection === 'unsupported'
        ? { policy: { generation: 'unsupported', version: null }, native: null }
        : overrideSelection === 'v2-version-mismatch'
          ? { policy: { generation: 'v2', version: '2.1.4' }, native: { generation: 'v2', version: '2.0.32' } }
          : selectedV2
            ? { policy: { generation: 'v2', version: '2.1.4' }, native: { generation: 'v2', version: '2.1.4' } }
            : { policy: { generation: 'v1', version: '1.19.4' }, native: null }
    return lastReadSelection
  },
  connectOpenCodeV2Provider: async (input: ConnectProviderInput) => { connectCalls.push(input); return boundaryFailure },
  loadOpenCodeV2ProviderModels: async (input: LoadProviderModelsInput, selection?: unknown) => { modelCalls.push(input); modelSelections.push(selection); return boundaryFailure },
  loadOpenCodeV2ProviderSetupForm: async (input: LoadProviderSetupFormInput, selection?: unknown) => { setupCalls.push(input); setupSelections.push(selection); return boundaryFailure },
  testOpenCodeV2ProviderModel: async (input: TestProviderModelInput) => { testCalls.push(input); return boundaryFailure },
}))
const { OpenCodeProviderManagementAdapter } = await import('./OpenCodeProviderManagementAdapter.js')
let legacyReads = 0
const adapter = new OpenCodeProviderManagementAdapter({ inventoryService: { probe: async () => { legacyReads++; throw new Error('TEST legacy inventory must not execute for V2') } } })

test('first-time and curated V2 setup use the native reader before every V1 setup fallback', async () => {
  selectedV2 = true
  const before = setupCalls.length, readsBefore = legacyReads
  for (const providerId of ['opencode-go', 'openai', 'deepseek', 'kimi-code-plan-global', 'minimax-coding-plan']) {
    expect(await adapter.loadSetupForm({ runtimeId: 'opencode', providerId, projectPath: '/TEST/project' })).toEqual(boundaryFailure)
    expect(setupSelections.at(-1)).toBe(lastReadSelection)
  }
  expect(setupCalls.length).toBe(before + 5)
  expect(legacyReads).toBe(readsBefore)
  selectedIdentityError = new Error('TEST selection failed')
  try {
    const failure = await adapter.loadSetupForm({ runtimeId: 'opencode', providerId: 'minimax-coding-plan' })
    expect(failure).toMatchObject({ ok: false, error: { code: 'runtime-unhealthy' } })
    expect(setupCalls.length).toBe(before + 5)
  } finally { selectedIdentityError = undefined }
})

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
  const readsBefore = selectionReads
  expect(await adapter.loadModels({ runtimeId: 'opencode', providerId: ' GROQ ', projectPath: '/TEST/project' })).toEqual(boundaryFailure)
  expect(selectionReads).toBe(readsBefore + 1)
  expect(modelSelections.at(-1)).toBe(lastReadSelection)
  expect(await adapter.testModel({ runtimeId: 'opencode', providerId: ' GROQ ', modelId: ' c41-upstream ', projectPath: '/TEST/project' })).toEqual(boundaryFailure)
  expect(modelCalls.at(-1)?.providerId).toBe('groq')
  expect(testCalls.at(-1)?.providerId).toBe('groq'); expect(testCalls.at(-1)?.modelId).toBe('groq/c41-upstream'); expect(legacyReads).toBe(0)
})

test('V1 model selection keeps the existing provider validation and does not enter the V2 catalog', async () => {
  selectedV2 = false
  const beforeModels = modelCalls.length, beforeReads = selectionReads
  const result = await adapter.loadModels({ runtimeId: 'opencode', providerId: '', projectPath: '/TEST/project' })
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.error.code).toBe('provider-missing')
  expect(modelCalls.length).toBe(beforeModels)
  expect(selectionReads).toBe(beforeReads + 1)
})

test('V1 selection still enters existing managed inventory rather than V2 key transport', async () => {
  selectedV2 = false; const before = connectCalls.length
  const result = await adapter.connectWithApiKey({ runtimeId: 'opencode', providerId: 'groq', apiKey: 'TEST-key' })
  expect(result.ok).toBe(false); expect(connectCalls.length).toBe(before); expect(legacyReads).toBe(1)
})


test('the selected native identity is the only V1/V2 routing authority', () => {
  const dialect = openCodeV2Dialect('2.1.4')
  const native = {
    generation: 'v2' as const, version: '2.1.4' as const,
    dialect, executablePath: '/TEST/native/opencode',
    executableSha256: 'a'.repeat(64), packageName: null,
  }
  const v2Policy = { generation: 'v2' as const, version: '2.1.4' as const, dialect }
  expect(requireOpenCodeProviderRoute({ policy: v2Policy, native })).toBe('v2')
  expect(requireOpenCodeProviderRoute({ policy: { generation: 'v1', version: '1.19.4' }, native: null })).toBe('v1')
  expect(() => requireOpenCodeProviderRoute({ policy: v2Policy, native: null })).toThrow('opencode_provider_generation_unavailable')
  expect(() => requireOpenCodeProviderRoute({ policy: { generation: 'unsupported', version: null }, native: null })).toThrow('opencode_provider_generation_unavailable')
  // OpenCode V1 below the selected-authority minimum (1.16) is unsupported, not a V1 plugin fallback.
  expect(() => requireOpenCodeProviderRoute({ policy: { generation: 'unsupported', version: '1.15.7' }, native: null })).toThrow('opencode_provider_generation_unavailable')
  expect(() => requireOpenCodeProviderRoute({ policy: { generation: 'v1', version: '1.19.4' }, native })).toThrow('opencode_provider_generation_unavailable')
  expect(() => requireOpenCodeProviderRoute({ policy: v2Policy, native: { ...native, version: '2.0.32' } })).toThrow('opencode_provider_generation_unavailable')
})

test('missing and mismatched V2 identities never enter V1 setup, credentials or model reads', async () => {
  const input = { runtimeId: 'opencode' as const, providerId: 'groq' }
  const readsBefore = legacyReads
  const beforeSetup = setupCalls.length, beforeModels = modelCalls.length
  const beforeConnect = connectCalls.length, beforeTests = testCalls.length
  try {
    for (const scenario of ['v2-missing-native', 'unsupported', 'v2-version-mismatch'] as const) {
      overrideSelection = scenario
      const outcomes = await Promise.all([
        adapter.loadSetupForm(input),
        adapter.loadModels(input),
        adapter.connectProvider({ ...input, method: 'api', apiKey: 'TEST-key' }),
        adapter.connectProvider({ ...input, method: 'oauth' }),
        adapter.testModel({ ...input, modelId: 'c41-upstream' }),
      ])
      for (const outcome of outcomes) {
        expect(outcome.ok).toBe(false)
        if (!outcome.ok) expect(outcome.error.code).toBe('runtime-unhealthy')
      }
    }
  } finally { overrideSelection = null }
  expect(legacyReads).toBe(readsBefore)
  expect(setupCalls.length).toBe(beforeSetup)
  expect(modelCalls.length).toBe(beforeModels)
  expect(connectCalls.length).toBe(beforeConnect)
  expect(testCalls.length).toBe(beforeTests)
})

test('V1 to V2 to V1 retains the native generation boundary across calls', async () => {
  const v1Before = legacyReads, v2Before = connectCalls.length
  try {
    selectedV2 = false
    const first = await adapter.connectWithApiKey({ runtimeId: 'opencode', providerId: 'groq', apiKey: 'TEST-key' })
    expect(first.ok).toBe(false)
    expect(legacyReads).toBe(v1Before + 1)
    expect(connectCalls.length).toBe(v2Before)

    selectedV2 = true
    const second = await adapter.connectWithApiKey({ runtimeId: 'opencode', providerId: 'groq', apiKey: 'TEST-key' })
    expect(second).toEqual(boundaryFailure)
    expect(legacyReads).toBe(v1Before + 1)
    expect(connectCalls.length).toBe(v2Before + 1)

    selectedV2 = false
    const third = await adapter.connectWithApiKey({ runtimeId: 'opencode', providerId: 'groq', apiKey: 'TEST-key' })
    expect(third.ok).toBe(false)
    expect(legacyReads).toBe(v1Before + 2)
    expect(connectCalls.length).toBe(v2Before + 1)
  } finally { selectedV2 = true }
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
