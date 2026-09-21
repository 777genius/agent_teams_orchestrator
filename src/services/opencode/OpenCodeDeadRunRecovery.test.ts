import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { OpenCodeHostManager } from './OpenCodeHostManager.js'
import { OpenCodeSessionStore } from './OpenCodeSessionStore.js'
import type { OpenCodeSessionRecord } from './types.js'

let directory: string
let storePath: string
let registryPath: string
let store: OpenCodeSessionStore
let lead: OpenCodeSessionRecord

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'opencode-dead-run-recovery-test-'))
  storePath = path.join(directory, 'sessions.json')
  registryPath = path.join(directory, 'hosts.json')
  store = new OpenCodeSessionStore(storePath)
  lead = {
    teamId: 'sandbox-team', runId: 'old-run', laneId: 'primary', memberName: 'lead',
    providerId: 'opencode', selectedModel: 'synthetic/model', projectPath: directory,
    profileScope: { purpose: 'launch_runtime', providerId: 'opencode', configFingerprint: 'config',
      selectedAuthIdentity: 'absent', scopeToken: 'sandbox-scope' },
    profileRootKey: 'sandbox-profile', hostKey: 'old-host', runtimePid: 912345,
    resolvedBehaviorFingerprint: null, opencodeSessionId: 'old-lead-session',
    lastCanonicalCursor: 'cursor-7', lastKnownRawStatus: 'idle', lastKnownDurableState: null,
    sourceAuthFingerprint: null, managedAuthFingerprint: null,
    projectBehaviorFingerprint: 'old-behavior', staleReason: 'launch_failed',
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
  }
  await writeFile(registryPath, JSON.stringify({ schemaVersion: 1, hosts: {} }))
})
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

function manager(liveness: 'alive' | 'gone' | 'unknown' = 'gone') {
  return new OpenCodeHostManager({
    persistentRegistryPath: registryPath,
    inspectProcessLiveness: async () => liveness,
    spawnHostProcess: () => { throw new Error('Recovery must never spawn a runtime') },
    killProcess: () => { throw new Error('Recovery must never signal a runtime') },
  })
}

async function recover(hosts = manager()) {
  return hosts.withConfirmedAbsentHostAuthority(lead,
    () => store.retireAbsentRuntimeIfSession(lead, 'new-run'))
}

async function seedRegisteredDeadHost(overrides: Record<string, unknown> = {}) {
  const oldHost = {
    hostKey: lead.hostKey, profileRootKey: lead.profileRootKey, projectPath: directory,
    projectBehaviorFingerprint: lead.projectBehaviorFingerprint,
    baseUrl: 'http://127.0.0.1:49123', port: 49123, pid: lead.runtimePid,
    processStartedAtMs: 12345, version: 'synthetic', resolvedConfigFingerprint: null,
    updatedAt: lead.updatedAt,
    leases: Object.fromEntries(['lead', 'alice', 'bob'].map(memberName => [memberName, {
      leaseKey: memberName, teamId: lead.teamId, laneId: 'primary', memberName,
      runId: lead.runId, sessionId: `old-${memberName}-session`,
      createdAt: lead.createdAt, updatedAt: lead.updatedAt,
    }])),
    ...overrides,
  }
  const foreignHost = { ...oldHost, hostKey: 'foreign-host', pid: 912346, leases: {} }
  const before = JSON.stringify({ schemaVersion: 1, processIdentityFormat: 'platform-native-v2',
    hosts: { [lead.hostKey]: oldHost, 'foreign-host': foreignHost } })
  await writeFile(registryPath, before)
  return { before, foreignHost }
}

describe('dead previous-run recovery', () => {
  test('recovers the stranded lead of a partially stopped three-member run and admits the new run', async () => {
    await store.upsert(lead)
    const siblings = ['alice', 'bob'].map(memberName => ({
      ...lead, memberName, opencodeSessionId: `old-${memberName}-session`,
      staleReason: null, stoppedAt: '2026-09-02T00:00:00.000Z',
    }))
    for (const sibling of siblings) await store.upsert(sibling)
    expect((await store.claimMaterialization(lead, 'premature', 'new-run')).kind).toBe('existing')
    const retired = await recover()
    expect(retired).toEqual({ ...lead, staleReason: 'runtime_process_gone',
      stoppedAt: expect.any(String), updatedAt: expect.any(String) })
    expect(retired?.stopAuthority).toBeUndefined()
    for (const sibling of siblings) {
      expect(await store.get(sibling.teamId, sibling.laneId!, sibling.memberName)).toEqual(sibling)
    }
    for (const record of [lead, ...siblings]) {
      expect((await store.claimMaterialization(record, `new-${record.memberName}`, 'new-run')).kind)
        .toBe('claimed')
    }
  })

  test.each(['alive', 'unknown'] as const)('refuses %s process evidence without mutating the session', async state => {
    await store.upsert(lead)
    await expect(recover(manager(state))).rejects.toThrow()
    expect(await store.get(lead.teamId, lead.memberName)).toEqual(lead)
  })

  test.each([undefined, 0, -1, 1.5, NaN])('refuses invalid PID %s even with synthetic gone evidence', async runtimePid => {
    lead = { ...lead, runtimePid }
    await store.upsert(lead)
    await expect(recover()).rejects.toThrow()
    expect((await store.get(lead.teamId, lead.memberName))?.stoppedAt).toBeUndefined()
  })

  test.each(['cached', 'pending', 'unverified-persistent'] as const)('refuses a %s old-host authority', async kind => {
    await store.upsert(lead)
    const hosts = manager()
    // Fixtures deliberately avoid acquiring or launching a real runtime.
    const internals = hosts as unknown as {
      hosts: Map<string, unknown>; pendingHosts: Map<string, unknown>
    }
    if (kind === 'cached') internals.hosts.set(lead.hostKey, { handle: { pid: lead.runtimePid } })
    if (kind === 'pending') internals.pendingHosts.set(lead.hostKey, new Promise(() => {}))
    if (kind === 'unverified-persistent') await writeFile(registryPath, JSON.stringify({ schemaVersion: 1,
      hosts: { [lead.hostKey]: { hostKey: lead.hostKey, pid: lead.runtimePid, leases: [] } } }))
    await expect(recover(hosts)).rejects.toThrow()
    expect(await store.get(lead.teamId, lead.memberName)).toEqual(lead)
  })

  test('retires a registered dead host with three leases while preserving a foreign host', async () => {
    await store.upsert(lead)
    const { foreignHost } = await seedRegisteredDeadHost()
    const retired = await recover()
    expect(retired?.staleReason).toBe('runtime_process_gone')
    expect(retired?.stoppedAt).toEqual(expect.any(String))
    expect(retired?.stopAuthority).toBeUndefined()
    const registry = JSON.parse(await readFile(registryPath, 'utf8'))
    expect(registry.hosts).toEqual({ 'foreign-host': foreignHost })
    expect((await store.claimMaterialization(lead, 'next-lead', 'new-run')).kind).toBe('claimed')
  })

  test('rejects a registered host with a different PID despite gone evidence', async () => {
    await store.upsert(lead)
    const { before } = await seedRegisteredDeadHost({ pid: lead.runtimePid! + 1 })
    await expect(recover()).rejects.toThrow()
    expect(await readFile(registryPath, 'utf8')).toBe(before)
    expect(await store.get(lead.teamId, lead.memberName)).toEqual(lead)
  })

  test.each(['alive', 'unknown'] as const)('preserves registered hosts whose PID is %s', async state => {
    await store.upsert(lead)
    const { before } = await seedRegisteredDeadHost()
    await expect(recover(manager(state))).rejects.toThrow()
    expect(await readFile(registryPath, 'utf8')).toBe(before)
    expect(await store.get(lead.teamId, lead.memberName)).toEqual(lead)
  })

  test.each(['changed-record', 'claim', 'owner'] as const)(
    'preserves all dead host registry bytes when terminal CAS fails from %s', async blocker => {
      await store.upsert(lead)
      const { before } = await seedRegisteredDeadHost()
      if (blocker === 'changed-record') {
        await store.upsert({ ...lead, lastCanonicalCursor: 'changed-after-observation' })
      } else {
        const persisted = JSON.parse(await readFile(storePath, 'utf8'))
        const key = Object.keys(persisted.records)[0]!
        const owner = { attemptId: 'other-attempt', sessionId: lead.opencodeSessionId, version: 1 }
        persisted[blocker === 'claim' ? 'materializationClaims' : 'materializationOwners'] = {
          [key]: blocker === 'claim' ? JSON.stringify(owner) : owner,
        }
        await writeFile(storePath, JSON.stringify(persisted))
      }
      const sessionsBefore = await readFile(storePath, 'utf8')
      expect(await recover()).toBeNull()
      expect(await readFile(registryPath, 'utf8')).toBe(before)
      expect(await readFile(storePath, 'utf8')).toBe(sessionsBefore)
    },
  )

  test('preserves absent format and unrelated legacy process identity during dead host retirement', async () => {
    await store.upsert(lead)
    await seedRegisteredDeadHost()
    const before = JSON.parse(await readFile(registryPath, 'utf8'))
    delete before.processIdentityFormat
    before.hosts['foreign-host'].processStartedAtMs = 1_700_000_000_000
    await writeFile(registryPath, JSON.stringify(before))
    expect(await recover()).not.toBeNull()
    const after = JSON.parse(await readFile(registryPath, 'utf8'))
    expect(Object.hasOwn(after, 'processIdentityFormat')).toBe(false)
    expect(after.hosts).toEqual({ 'foreign-host': before.hosts['foreign-host'] })
  })

  test('preserves registered dead authority when the terminal operation throws', async () => {
    const { before } = await seedRegisteredDeadHost()
    const reason = new Error('Synthetic CAS failure')
    await expect(manager().withConfirmedAbsentHostAuthority(lead, async () => { throw reason }))
      .rejects.toBe(reason)
    expect(await readFile(registryPath, 'utf8')).toBe(before)
  })

  test.each(['{invalid-json', JSON.stringify({ schemaVersion: 2, hosts: {} })])(
    'fails closed on malformed persistent registry %s', async contents => {
      await store.upsert(lead)
      await writeFile(registryPath, contents)
      await expect(recover()).rejects.toThrow()
      expect(await store.get(lead.teamId, lead.memberName)).toEqual(lead)
    },
  )

  test('requires an available persistent registry path', async () => {
    await store.upsert(lead)
    const hosts = new OpenCodeHostManager({ persistentRegistryPath: null,
      inspectProcessLiveness: async () => 'gone' })
    await expect(recover(hosts)).rejects.toThrow()
    expect(await store.get(lead.teamId, lead.memberName)).toEqual(lead)
  })

  test('rejects a changed full record even when run, session and host IDs still match', async () => {
    await store.upsert(lead)
    const changed = { ...lead, lastCanonicalCursor: 'newer-cursor' }
    await store.upsert(changed)
    expect(await recover()).toBeNull()
    expect(await store.get(lead.teamId, lead.memberName)).toEqual(changed)
  })

  test('refuses same-run retirement', async () => {
    await store.upsert(lead)
    expect(await store.retireAbsentRuntimeIfSession(lead, 'old-run')).toBeNull()
    expect(await store.get(lead.teamId, lead.memberName)).toEqual(lead)
  })

  test.each(['materializationClaims', 'materializationOwners'] as const)(
    'preserves sessions protected by %s', async field => {
      await store.upsert(lead)
      const persisted = JSON.parse(await readFile(storePath, 'utf8'))
      const key = Object.keys(persisted.records)[0]!
      const owner = { attemptId: 'active-attempt', sessionId: lead.opencodeSessionId, version: 1 }
      persisted[field] = { [key]: field === 'materializationClaims' ? JSON.stringify(owner) : owner }
      await writeFile(storePath, JSON.stringify(persisted))
      expect(await recover()).toBeNull()
      expect(await store.get(lead.teamId, lead.memberName)).toEqual(lead)
    },
  )

  for (const field of ['materializationClaims', 'materializationOwners'] as const) {
    test.each([{ value: null }, { value: [] }, { value: 'invalid-map' }])(
      `fails closed and preserves malformed whole ${field} map %s`, async ({ value }) => {
        await store.upsert(lead)
        const persisted = JSON.parse(await readFile(storePath, 'utf8'))
        persisted[field] = value
        const before = JSON.stringify(persisted)
        await writeFile(storePath, before)
        expect(await recover()).toBeNull()
        expect(await readFile(storePath, 'utf8')).toBe(before)
      },
    )
    test.each([null, '', { invalid: true }])(
      `fails closed and preserves raw bytes for malformed ${field} value %s`, async value => {
        await store.upsert(lead)
        const persisted = JSON.parse(await readFile(storePath, 'utf8'))
        const key = Object.keys(persisted.records)[0]!
        persisted[field] = { [key]: value }
        const before = JSON.stringify(persisted)
        await writeFile(storePath, before)
        expect(await recover()).toBeNull()
        expect(await readFile(storePath, 'utf8')).toBe(before)
      },
    )
  }

  test('rejects cancellation before acquiring host authority without inspecting or writing', async () => {
    await store.upsert(lead)
    const before = await readFile(storePath, 'utf8')
    let inspections = 0
    let operations = 0
    const hosts = new OpenCodeHostManager({ persistentRegistryPath: registryPath,
      inspectProcessLiveness: async () => { inspections++; return 'gone' } })
    const controller = new AbortController()
    const reason = new Error('Recovery cancelled before locking')
    controller.abort(reason)
    await expect(hosts.withConfirmedAbsentHostAuthority(lead, async () => {
      operations++
      return store.retireAbsentRuntimeIfSession(lead, 'new-run', controller.signal)
    }, controller.signal)).rejects.toBe(reason)
    expect(inspections).toBe(0)
    expect(operations).toBe(0)
    expect(await readFile(storePath, 'utf8')).toBe(before)
  })

  test('cancellation during liveness inspection never invokes retirement, including after late evidence', async () => {
    await store.upsert(lead)
    const before = await readFile(storePath, 'utf8')
    let entered!: () => void
    let resume!: () => void
    let operations = 0
    const inspecting = new Promise<void>(resolve => { entered = resolve })
    const released = new Promise<void>(resolve => { resume = resolve })
    const controller = new AbortController()
    const reason = new Error('Recovery cancelled during liveness inspection')
    const hosts = new OpenCodeHostManager({ persistentRegistryPath: registryPath,
      inspectProcessLiveness: async () => { entered(); await released; return 'gone' } })
    const recovering = hosts.withConfirmedAbsentHostAuthority(lead, async () => {
      operations++
      return store.retireAbsentRuntimeIfSession(lead, 'new-run', controller.signal)
    }, controller.signal)
    await inspecting
    controller.abort(reason)
    try {
      await expect(recovering).rejects.toBe(reason)
      expect(operations).toBe(0)
      expect(await readFile(storePath, 'utf8')).toBe(before)
    } finally {
      resume()
    }
    // Let the previously blocked synthetic inspection and its promise continuations drain.
    await new Promise(resolve => setImmediate(resolve))
    expect(operations).toBe(0)
    expect(await readFile(storePath, 'utf8')).toBe(before)
  })

  test('rechecks the session when another coordinator claims during host absence inspection', async () => {
    await store.upsert(lead)
    let entered!: () => void
    let resume!: () => void
    const inspecting = new Promise<void>(resolve => { entered = resolve })
    const released = new Promise<void>(resolve => { resume = resolve })
    const hosts = new OpenCodeHostManager({ persistentRegistryPath: registryPath,
      inspectProcessLiveness: async () => { entered(); await released; return 'gone' } })
    const recovering = recover(hosts)
    await inspecting
    try {
      const peerStore = new OpenCodeSessionStore(storePath)
      expect(await peerStore.markStoppedIfSession(lead)).not.toBeNull()
      expect((await peerStore.claimMaterialization(lead, 'concurrent-winner', 'new-run')).kind)
        .toBe('claimed')
    } finally {
      resume()
    }
    expect(await recovering).toBeNull()
    expect((await store.claimMaterialization(lead, 'late-loser', 'new-run')).kind)
      .toBe('owned_by_other')
    expect((await store.get(lead.teamId, lead.memberName))?.staleReason).toBe('launch_failed')
  })

  test('preserves an acquired new-run claim so stale recovery cannot erase its authority', async () => {
    await store.upsert(lead)
    expect(await recover()).not.toBeNull()
    const observed = (await store.get(lead.teamId, lead.memberName))!
    const peerStore = new OpenCodeSessionStore(storePath)
    const claim = await peerStore.claimMaterialization(lead, 'winning-attempt', 'new-run')
    expect(claim.kind).toBe('claimed')
    expect(await store.retireAbsentRuntimeIfSession(observed, 'new-run')).toBeNull()
    if (claim.kind !== 'claimed') throw new Error('Expected new-run claim')
    const replacement = { ...lead, runId: 'new-run', opencodeSessionId: 'new-lead-session', staleReason: null }
    expect(await peerStore.commitMaterialization(replacement, claim.ownerToken)).not.toBeNull()
    expect(await store.retireAbsentRuntimeIfSession(lead, 'new-run')).toBeNull()
    expect(await store.get(lead.teamId, lead.memberName)).toEqual(replacement)
  })
})
