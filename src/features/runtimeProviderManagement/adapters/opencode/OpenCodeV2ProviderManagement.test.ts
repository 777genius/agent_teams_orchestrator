import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { test, expect } from 'bun:test'
import { openCodeV2ConnectionIDs, requireOpenCodeV2OwnedConnection, rollbackOpenCodeV2OwnedConnection, retireOpenCodeV2CatalogOwner, recordOpenCodeV2ProviderFailure } from './OpenCodeV2ProviderManagement.js'
import type { OpenCodeAuthCredential } from '../../../../services/opencode/OpenCodeAuthStore.js'
const empty = { id: 'groq', methods: [{ type: 'key' }], connections: [] }
const connection = { ...empty, connections: [{ type: 'credential', id: 'cred_original', label: 'Groq' }] }
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

test('private failure diagnostics preserve finite control causes and redact arbitrary secrets', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'TEST-v2-provider-diagnostics-'))
  const previous = process.env.CLAUDE_MULTIMODEL_DATA_HOME
  const secret = 'TEST-SECRET-key-and-private-payload'
  process.env.CLAUDE_MULTIMODEL_DATA_HOME = root
  try {
    await recordOpenCodeV2ProviderFailure('selected-model-execution-proof', new Error('run_control_disconnected'), true)
    await recordOpenCodeV2ProviderFailure('selected-model-execution-proof', new Error('run_control_timeout'), true)
    await recordOpenCodeV2ProviderFailure('selected-model-execution-proof', new Error('run_control_timeout ' + secret), true)
    await recordOpenCodeV2ProviderFailure('selected-model-execution-proof', new Error(secret), true)
    await recordOpenCodeV2ProviderFailure('run-owner-initialization', new Error('execution_selected_auth_existing_or_unsupported'), true)
    await recordOpenCodeV2ProviderFailure('run-owner-initialization', new Error('cleanup_unknown', { cause: new Error('selection_mismatch') }), true)
    await recordOpenCodeV2ProviderFailure('run-owner-initialization', new Error('cleanup_unknown', { cause: new Error(secret) }), true)
    await recordOpenCodeV2ProviderFailure('run-owner-initialization', new Error(secret, { cause: new Error('selection_mismatch') }), true)
    await recordOpenCodeV2ProviderFailure('run-owner-initialization', new Error('cleanup_unknown', { cause: new Error('selection_mismatch ' + secret) }), true)
    const directory = path.join(root, 'opencode/v2/provider-diagnostics')
    const rows = await Promise.all((await readdir(directory)).map(async name => {
      const file = path.join(directory, name), content = await readFile(file, 'utf8')
      expect(content.includes(secret)).toBe(false)
      expect((await stat(file)).mode & 0o077).toBe(0)
      const row = JSON.parse(content)
      expect(Object.keys(row).sort()).toEqual(['category', 'phase', 'recordedAt', 'retainedOriginal', 'schemaVersion'])
      expect(row.retainedOriginal).toBe(true)
      return row.category
    }))
    expect(rows.sort()).toEqual(['cleanup_unknown', 'cleanup_unknown', 'execution_selected_auth_existing_or_unsupported',
      'provider_operation_unknown', 'provider_operation_unknown', 'provider_operation_unknown', 'run_control_disconnected',
      'run_control_timeout', 'selection_mismatch'].sort())
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_MULTIMODEL_DATA_HOME
    else process.env.CLAUDE_MULTIMODEL_DATA_HOME = previous
    await rm(root, { recursive: true, force: true })
  }
})
