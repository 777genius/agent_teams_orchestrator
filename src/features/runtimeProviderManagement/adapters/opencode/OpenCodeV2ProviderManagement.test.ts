import { mkdir, mkdtemp, realpath, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { test, expect } from 'bun:test'
import { openCodeV2ModelTestMessage, openCodeV2ConnectProofFailureCode, openCodeV2ConnectFailureMessage, buildOpenCodeV2RuntimeProviderModel, openCodeV2ConnectionIDs, assertOpenCodeV2NativeV1AuthUnoccupied, assertOpenCodeV2SharedAuthMirrorSafe, requireOpenCodeV2OwnedConnection, rollbackOpenCodeV2OwnedConnection, retireOpenCodeV2CatalogOwner, recordOpenCodeV2ProviderFailure, openCodeV2CatalogFailureMessage } from './OpenCodeV2ProviderManagement.js'
import { readOpenCodeV2ConnectIntent, removeOpenCodeV2ConnectIntentIfUnchanged, writeOpenCodeV2ConnectIntent } from './OpenCodeV2ProviderConnectIntent.js'
import type { OpenCodeAuthCredential } from '../../../../services/opencode/OpenCodeAuthStore.js'
const empty = { id: 'groq', methods: [{ type: 'key' }], connections: [] }
const connection = { ...empty, connections: [{ type: 'credential', id: 'cred_original', label: 'Groq' }] }
test('V2 catalog failure messages contain only fixed phases and closed categories', () => {
  const secret = 'TEST-SECRET-do-not-report'
  const known = openCodeV2CatalogFailureMessage('models', new Error('provider_catalog_location_changed'))
  expect(known).toContain('stage: models, category: provider_catalog_location_changed')
  expect(known).toContain('no legacy CLI catalog command was invoked')
  const unknown = openCodeV2CatalogFailureMessage('profile', new Error(`private ${secret}`))
  expect(unknown).toContain('stage: profile, category: provider_operation_unknown')
  expect(unknown).not.toContain(secret)
  const cleanup = openCodeV2CatalogFailureMessage('retirement', new Error('provider_physical_cleanup_unknown', {
    cause: new Error(secret),
  }))
  expect(cleanup).toContain('stage: retirement, category: provider_physical_cleanup_unknown')
  expect(cleanup).not.toContain(secret)
})

test('V2 API-key admission preserves V1 OAuth and differing API credentials in the shared mirror', () => {
  const next = { type: 'api' as const, key: 'TEST-new' }
  expect(() => assertOpenCodeV2SharedAuthMirrorSafe(null, next)).not.toThrow()
  expect(() => assertOpenCodeV2SharedAuthMirrorSafe({ ...next }, next)).not.toThrow()
  for (const existing of [
    { type: 'oauth', access: 'TEST-v1-access', refresh: 'TEST-v1-refresh', expires: 10 },
    { type: 'api', key: 'TEST-original' },
    { type: 'api', key: 'TEST-new', metadata: { region: 'us' } },
  ]) {
    expect(() => assertOpenCodeV2SharedAuthMirrorSafe(existing, next))
      .toThrow('provider_shared_credential_conflict')
  }
  expect(openCodeV2ConnectFailureMessage(new Error('provider_shared_credential_conflict'), false))
    .toContain('Existing V1 authentication was preserved')
})

test('V2 key connect cannot shadow native V1 API or OAuth auth stored outside the app mirror', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'TEST-v1-native-auth-'))
  const home = path.join(root, 'home'), xdg = path.join(root, 'xdg')
  const homeAuth = path.join(home, '.local', 'share', 'opencode', 'auth.json')
  const xdgAuth = path.join(xdg, 'opencode', 'auth.json')
  const input = { authPath: path.join(root, 'managed', 'opencode', 'auth.json'),
    providerId: 'groq', env: { HOME: home, XDG_DATA_HOME: xdg } }
  const store = async (target: string, credential: Record<string, unknown>) => {
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, JSON.stringify({ groq: credential }))
  }
  try {
    await assertOpenCodeV2NativeV1AuthUnoccupied(input)
    await store(homeAuth, { type: 'api', key: 'TEST-v1-user-key' })
    await expect(assertOpenCodeV2NativeV1AuthUnoccupied(input)).rejects.toThrow('provider_shared_credential_conflict')
    expect(JSON.parse(await readFile(homeAuth, 'utf8'))).toEqual({ groq: { type: 'api', key: 'TEST-v1-user-key' } })
    await rm(homeAuth)
    await store(xdgAuth, { type: 'oauth', access: 'TEST-v1-access', refresh: 'TEST-v1-refresh' })
    await expect(assertOpenCodeV2NativeV1AuthUnoccupied(input)).rejects.toThrow('provider_shared_credential_conflict')
    await rm(xdgAuth)
    // Even identical keys must not be newly mirrored: a future native V1 login
    // would otherwise be hidden by the stale app-mirror key.
    await store(homeAuth, { type: 'api', key: 'TEST-new' })
    await expect(assertOpenCodeV2NativeV1AuthUnoccupied(input)).rejects.toThrow('provider_shared_credential_conflict')
    await rm(homeAuth)
    await assertOpenCodeV2NativeV1AuthUnoccupied(input)
    // A retained generation-specific scope environment must select the same
    // user stores used by real V1 profile resolution, not ambient HOME.
    await store(xdgAuth, { type: 'api', key: 'TEST-scoped-xdg-v1' })
    const scoped = { ...input, env: {
      HOME: path.join(root, 'foreign-home'), XDG_DATA_HOME: path.join(root, 'foreign-xdg'),
      CLAUDE_MULTIMODEL_OPENCODE_SCOPE_ENVIRONMENT: JSON.stringify({ HOME: home, XDG_DATA_HOME: xdg }),
    } }
    await expect(assertOpenCodeV2NativeV1AuthUnoccupied(scoped)).rejects.toThrow('provider_shared_credential_conflict')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('V2 native model mapping carries array declarations without the legacy record interpretation or text fallback', () => {
  const row = { id: 'Novel/ExactCase', name: 'Novel model', limit: { context: 32000, output: 4000 } }
  const map = (capabilities?: unknown) => buildOpenCodeV2RuntimeProviderModel({ ...row, capabilities }, 'novel-provider', 'novel-provider/Novel/ExactCase')
  expect(map({ input: ['text', 'image', 'video'] })).toMatchObject({
    modelId: 'novel-provider/Novel/ExactCase', providerId: 'novel-provider', default: true,
    declaredInputModalities: ['text', 'image', 'video'], catalogContextTokens: 32000, catalogOutputTokens: 4000,
  })
  expect(map({ input: [] }).declaredInputModalities).toEqual([])
  for (const capabilities of [undefined, null, {}, { input: ['image', 1] }, { input: { image: true } }]) {
    expect(map(capabilities).declaredInputModalities).toBeNull()
  }
})

for (const pin of ['2.0.0', '2.0.21']) test(`${pin} actual public connection readback qualifies exact new ID without a fabricated active/secret field`, () => {
  const after = pin === '2.0.0' ? connection : { ...connection, connections: connection.connections.map(row => ({ ...row, method: 'key' })) }
  expect(requireOpenCodeV2OwnedConnection(empty, after, 'groq')).toBe('cred_original')
  expect(() => requireOpenCodeV2OwnedConnection(connection, after, 'groq')).toThrow('provider_existing_credentials_unsupported')
  expect(() => requireOpenCodeV2OwnedConnection(empty, { ...after, id: 'foreign' }, 'groq')).toThrow('provider_existing_credentials_unsupported')
  expect(() => openCodeV2ConnectionIDs({ ...after, connections: [...after.connections, ...after.connections] })).toThrow('provider_credential_identity_changed')
})
function ports() {
  let native: Record<string, unknown> = connection, mirror: OpenCodeAuthCredential | null = { type: 'api', key: 'TEST-new' }
  const removed: string[] = []; let restores = 0
  return { get restores() { return restores }, removed,
    setNative(value: Record<string, unknown>) { native = value }, setMirror(value: OpenCodeAuthCredential | null) { mirror = value },
    input: { integrationID: 'groq', credentialID: 'cred_original', published: { type: 'api' as const, key: 'TEST-new' }, predecessor: null,
      readConnections: async () => native, remove: async (id: string) => { removed.push(id); native = empty },
      readMirror: async () => mirror, restoreMirror: async (prior: OpenCodeAuthCredential | null) => { restores++; mirror = prior } } }
}
test('prepublication rollback removes the owned native ID without modifying V1 auth', async () => {
  const p = ports(); p.setMirror(null)
  await rollbackOpenCodeV2OwnedConnection({ ...p.input, expectedMirror: null })
  expect(p.removed).toEqual(['cred_original'])
  expect(p.restores).toBe(0)
  expect(await p.input.readMirror()).toBeNull()
})
test('peer drift prevents prepublication native rollback', async () => {
  const p = ports(); p.setMirror(null)
  p.setNative({ ...connection, connections: [...connection.connections, { type: 'credential', id: 'cred_peer', label: 'Peer' }] })
  await expect(rollbackOpenCodeV2OwnedConnection({ ...p.input, expectedMirror: null })).rejects.toThrow('provider_rollback_peer_changed')
  expect(p.removed).toEqual([])
  expect(p.restores).toBe(0)
})
test('owned pending marker is removed only with exact unchanged identity', async () => {
  // Tests must use the canonical temp directory, including on Windows ARM64.
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'TEST-v2-connect-intent-')))
  const file = path.join(dir, 'owned.json')
  const pending = { schemaVersion: 2 as const, state: 'pending' as const, phase: 'credential-intent' as const,
    providerId: 'groq', project: '/TEST/project', profileRoot: '/TEST/private', integrationID: 'groq' }
  try {
    await writeOpenCodeV2ConnectIntent(file, pending, true)
    await expect(removeOpenCodeV2ConnectIntentIfUnchanged(file, { ...pending, providerId: 'foreign' }))
      .rejects.toThrow('provider_original_intent_changed')
    expect(await readOpenCodeV2ConnectIntent(file)).toMatchObject(pending)
    await removeOpenCodeV2ConnectIntentIfUnchanged(file, pending)
    expect(await readOpenCodeV2ConnectIntent(file)).toBeUndefined()
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('owned empty-store rollback removes only the returned ID and restores the original absent mirror', async () => {
  const p = ports(); await rollbackOpenCodeV2OwnedConnection(p.input)
  expect(p.removed).toEqual(['cred_original']); expect(p.restores).toBe(1); expect(await p.input.readMirror()).toBeNull()
})
test('native or app mirror peer changes prevent rollback mutation', async () => {
  for (const kind of ['native', 'mirror']) {
    const p = ports()
    if (kind === 'native') p.setNative({ ...connection, connections: [...connection.connections, { type: 'credential', id: 'cred_peer', label: 'peer' }] })
    else p.setMirror({ type: 'api', key: 'TEST-peer' })
    await expect(rollbackOpenCodeV2OwnedConnection(p.input)).rejects.toThrow(kind === 'native' ? 'provider_rollback_peer_changed' : 'provider_rollback_publication_changed')
    expect(p.removed).toEqual([]); expect(p.restores).toBe(0)
  }
})
test('publication drift after native removal preserves the peer mirror rather than blindly restoring it', async () => {
  const p = ports(), remove = p.input.remove
  p.input.remove = async id => { await remove(id); p.setMirror({ type: 'api', key: 'TEST-peer' }) }
  await expect(rollbackOpenCodeV2OwnedConnection(p.input)).rejects.toThrow('provider_rollback_publication_changed')
  expect(p.removed).toEqual(['cred_original']); expect(p.restores).toBe(0)
})
test('rollback restoration failure stays explicit UNKNOWN', async () => {
  const p = ports(); p.input.restoreMirror = async () => { throw new Error('TEST-restore-failed') }
  await expect(rollbackOpenCodeV2OwnedConnection(p.input)).rejects.toThrow('TEST-restore-failed')
})
test('transport failure never skips physical catalog lease retirement', async () => {
  const events: string[] = []
  await expect(retireOpenCodeV2CatalogOwner({ dispose: async () => { events.push('dispose'); throw new Error('TEST-wire') } },
    { close: async () => { events.push('retire') } }, () => { events.push('unregister') })).rejects.toThrow('provider_physical_cleanup_unknown')
  expect(events).toEqual(['dispose', 'unregister', 'retire'])
})

test('V2 catalog diagnostics preserve only allowlisted filesystem facts', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'TEST-v2-catalog-errno-'))
  const previous = process.env.CLAUDE_MULTIMODEL_DATA_HOME
  const secret = 'TEST-PRIVATE-FILE-PATH-AND-KEY'
  process.env.CLAUDE_MULTIMODEL_DATA_HOME = root
  try {
    await recordOpenCodeV2ProviderFailure('provider-model-catalog-profile',
      Object.assign(new Error(secret), { code: 'EACCES', syscall: 'open', path: secret }), true)
    await recordOpenCodeV2ProviderFailure('provider-model-catalog-models',
      Object.assign(new Error(secret), { code: 'EACCES-' + secret, syscall: 'open-' + secret, path: secret }), true)
    const directory = path.join(root, 'opencode/v2/provider-diagnostics')
    const rows = await Promise.all((await readdir(directory)).map(async name => JSON.parse(await readFile(path.join(directory, name), 'utf8'))))
    expect(rows.find(row => row.phase === 'provider-model-catalog-profile').failure).toEqual({ name: 'Error', errno: 'EACCES', operation: 'open' })
    expect(rows.find(row => row.phase === 'provider-model-catalog-models').failure).toEqual({ name: 'Error' })
    expect(JSON.stringify(rows)).not.toContain(secret)
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_MULTIMODEL_DATA_HOME
    else process.env.CLAUDE_MULTIMODEL_DATA_HOME = previous
    await rm(root, { recursive: true, force: true })
  }
})

test('private failure diagnostics preserve finite control causes and redact arbitrary secrets', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'TEST-v2-provider-diagnostics-'))
  const previous = process.env.CLAUDE_MULTIMODEL_DATA_HOME
  const secret = 'TEST-SECRET-key-and-private-payload'
  process.env.CLAUDE_MULTIMODEL_DATA_HOME = root
  try {
    await recordOpenCodeV2ProviderFailure('selected-model-execution-proof', new Error('run_control_disconnected'), true)
    await recordOpenCodeV2ProviderFailure('selected-model-execution-proof', new Error('run_control_timeout'), true)
    await recordOpenCodeV2ProviderFailure('selected-model-execution-proof', new Error('run_control_timeout ' + secret), true)
    await recordOpenCodeV2ProviderFailure('selected-model-execution-proof', new Error('provider_original_execution_failed'), true)
    await recordOpenCodeV2ProviderFailure('selected-model-execution-proof', new Error('provider_original_execution_failed ' + secret), true)
    await recordOpenCodeV2ProviderFailure('selected-model-execution-proof', new Error(secret), true)
    await recordOpenCodeV2ProviderFailure('run-owner-initialization', new Error('execution_selected_auth_existing_or_unsupported'), true)
    await recordOpenCodeV2ProviderFailure('run-owner-initialization', new Error('cleanup_unknown', { cause: new Error('selection_mismatch') }), true)
    await recordOpenCodeV2ProviderFailure('run-owner-initialization', new Error('cleanup_unknown', { cause: new Error(secret) }), true)
    await recordOpenCodeV2ProviderFailure('run-owner-initialization', new Error(secret, { cause: new Error('selection_mismatch') }), true)
    await recordOpenCodeV2ProviderFailure('run-owner-initialization', new Error('cleanup_unknown', { cause: new Error('selection_mismatch ' + secret) }), true)
    for (const code of ['execution_selected_oauth_readback_unknown', 'execution_selected_oauth_recovery_required',
      'execution_selected_oauth_windows_unqualified', 'execution_selected_oauth_provider_unknown',
      'execution_selected_oauth_integration_unknown', 'execution_selected_oauth_connection_unknown', 'execution_selected_oauth_model_unknown'])
      await recordOpenCodeV2ProviderFailure('run-owner-initialization', new Error(code), true)
    const spoofed = Object.assign(new Error(secret), { operation: { operation: 'provider-read', stage: 'decode', status: 403, body: secret } })
    await recordOpenCodeV2ProviderFailure('run-owner-initialization', spoofed, true)
    const directory = path.join(root, 'opencode/v2/provider-diagnostics')
    const rows = await Promise.all((await readdir(directory)).map(async name => {
      const file = path.join(directory, name), content = await readFile(file, 'utf8')
      expect(content.includes(secret)).toBe(false)
      // Windows stat mode bits do not describe inherited ACLs; this is a POSIX-only check.
      if (process.platform !== 'win32') expect((await stat(file)).mode & 0o077).toBe(0)
      const row = JSON.parse(content)
      expect(Object.keys(row).sort()).toEqual(['category', 'phase', 'recordedAt', 'retainedOriginal', 'schemaVersion'])
      expect(row.retainedOriginal).toBe(true)
      return row.category
    }))
    expect(rows.sort()).toEqual(['cleanup_unknown', 'cleanup_unknown', 'execution_selected_auth_existing_or_unsupported',
      'provider_original_execution_failed', 'provider_operation_unknown',
      'provider_operation_unknown', 'provider_operation_unknown', 'provider_operation_unknown', 'run_control_disconnected',
      'run_control_timeout', 'selection_mismatch', 'execution_selected_oauth_readback_unknown',
      'execution_selected_oauth_recovery_required', 'execution_selected_oauth_windows_unqualified', 'provider_operation_unknown',
      'execution_selected_oauth_provider_unknown', 'execution_selected_oauth_integration_unknown',
      'execution_selected_oauth_connection_unknown', 'execution_selected_oauth_model_unknown'].sort())
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_MULTIMODEL_DATA_HOME
    else process.env.CLAUDE_MULTIMODEL_DATA_HOME = previous
    await rm(root, { recursive: true, force: true })
  }
})

test('a provider intent marker of this user is accepted on Windows, where files report no uid and mode 0o666', async () => {
  const { isOwnedProviderIntentMarker } = await import('./OpenCodeV2ProviderManagement.js')
  const marker = (overrides: Partial<{ file: boolean; link: boolean; uid: number; mode: number; size: number }> = {}) => {
    const row = { file: true, link: false, uid: process.getuid?.() ?? 0, mode: 0o100600, size: 128, ...overrides }
    return { isFile: () => row.file, isSymbolicLink: () => row.link, uid: row.uid, mode: row.mode, size: row.size }
  }
  // Windows: uid 0 and mode 0o666 on every file; the user's ACL keeps it private.
  expect(isOwnedProviderIntentMarker(marker({ uid: 0, mode: 0o100666 }), 'win32')).toBe(true)
  for (const platform of ['win32', 'linux', 'darwin'] as const) {
    expect(isOwnedProviderIntentMarker(marker({ link: true }), platform)).toBe(false)
    expect(isOwnedProviderIntentMarker(marker({ file: false }), platform)).toBe(false)
    expect(isOwnedProviderIntentMarker(marker({ size: 64 * 1024 }), platform)).toBe(false)
  }
  if (process.getuid) {
    expect(isOwnedProviderIntentMarker(marker(), 'linux')).toBe(true)
    expect(isOwnedProviderIntentMarker(marker({ mode: 0o100644 }), 'linux')).toBe(false)
    expect(isOwnedProviderIntentMarker(marker({ uid: process.getuid() + 1 }), 'darwin')).toBe(false)
  }
})

test('model test distinguishes terminal failure from pending without exposing raw provider errors', () => {
  expect(openCodeV2ModelTestMessage(false, 'failed')).toContain('execution failed')
  expect(openCodeV2ModelTestMessage(false, 'failed')).not.toContain('is pending')
  expect(openCodeV2ModelTestMessage(false, 'pending')).toContain('pending or unverified')
  expect(openCodeV2ModelTestMessage(false, 'available')).not.toContain('verified.')
  expect(openCodeV2ModelTestMessage(true, 'available')).toBe('The model responded successfully.')
})

test('connect reports a settled model-verification failure without treating it as pending or bad authentication', () => {
  for (const reason of ['native_execution_failed', 'native_execution_cancelled']) {
    const code = openCodeV2ConnectProofFailureCode('failed', reason)
    expect(code).toBe('provider_original_execution_failed')
    const message = openCodeV2ConnectFailureMessage(new Error(code), true)
    expect(message).toContain('verification failed')
    expect(message).toContain('original attempt was retained')
    expect(message).toContain('no automatic reconnect or prompt retry was performed')
    expect(message).not.toContain('unresolved')
    expect(message).not.toContain('authentication')
  }
})

test('connect preserves unresolved wording for cleanup uncertainty, pending probes and unknown reasons', () => {
  for (const [state, reason] of [
    ['failed', 'native_execution_failed; probe_physical_cleanup_unknown'],
    ['failed', 'native_execution_cancelled; probe_physical_cleanup_unknown'],
    ['pending', 'native_execution_failed'],
    ['failed', 'TEST-PRIVATE arbitrary provider response'],
    ['failed', null],
  ] as const) {
    const code = openCodeV2ConnectProofFailureCode(state, reason)
    expect(code).toBe('provider_original_execution_pending')
    const message = openCodeV2ConnectFailureMessage(new Error(code), true)
    expect(message).toContain('remains unresolved')
    expect(message).not.toContain('TEST-PRIVATE')
  }
  expect(openCodeV2ConnectFailureMessage(new Error('provider_physical_cleanup_unknown'), true)).toContain('remains unresolved')
  expect(openCodeV2ConnectFailureMessage(new Error('provider_original_execution_failed TEST-PRIVATE'), true)).toContain('remains unresolved')
  expect(openCodeV2ConnectFailureMessage(new Error('provider_original_execution_failed'), false)).toContain('Existing credentials were preserved')
})

test('explains the confirmed OpenRouter free quota with an actionable next step', () => {
  const message = openCodeV2ModelTestMessage(false, 'failed', 'provider_free_quota_exhausted')
  expect(message).toContain('daily limit for free models')
  expect(message).toContain('choose a paid model')
  expect(openCodeV2ConnectProofFailureCode('failed', 'provider_free_quota_exhausted')).toBe('provider_original_execution_failed')
  expect(openCodeV2ModelTestMessage(false, 'pending', 'provider_free_quota_exhausted')).not.toContain('daily limit')
})
