import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { OpenCodePassiveObservation } from './OpenCodePassiveStatusContract.js'
import { FakePassiveClock, flushMicrotasks } from './OpenCodePassiveStatusReader.test-support.js'
import {
  canonicalizeOpenCodePassiveProjectPath,
  getOpenCodePassiveStatusRootDirectory,
  OpenCodePassiveStatusProductionReader,
} from './OpenCodePassiveStatusProductionReader.js'
import { OpenCodePassiveStatusSnapshotWriter } from './OpenCodePassiveStatusSnapshotWriter.js'
import { openCodePassiveDatabasePath } from './OpenCodePassiveSnapshotStore.js'
import {
  encodeOpenCodeRedactedSnapshotV1,
  type OpenCodeRedactedSnapshotV1,
} from './OpenCodeRedactedStatusSnapshot.js'

const projectScope = (canonicalPath: string): `sha256:${string}` =>
  `sha256:${createHash('sha256').update('opencode-project-scope-v1\0').update(canonicalPath).digest('hex')}`
const catalogIdentity = (marker: string): `sha256:${string}` =>
  `sha256:${createHash('sha256').update(`fake-catalog:${marker}`).digest('hex')}`

const observation = <T>(
  value: T,
  authority: OpenCodePassiveObservation<T>['authority'],
  validUntil = 2_000,
): OpenCodePassiveObservation<T> => ({
  value,
  authority,
  freshness: validUntil < 1_000 ? 'stale' : 'fresh',
  condition: validUntil < 1_000 ? 'degraded' : 'normal',
  observedAt: 900,
  validUntil,
  issueCode: validUntil < 1_000 ? 'expired' : 'none',
})

function snapshot(canonicalPath = '/canonical/a', validUntil = 2_000): OpenCodeRedactedSnapshotV1 {
  return {
    schemaVersion: 1,
    projectScope: projectScope(canonicalPath),
    capturedAt: 1_000,
    binary: observation({ presence: 'present', version: '1.2.3' }, 'binary_metadata', validUntil),
    providers: [{
      providerId: 'deepinfra',
      fingerprint: `sha256:${'b'.repeat(64)}`,
      catalogAttemptIdentity: catalogIdentity(`${canonicalPath}:${validUntil}`),
      catalogRequestGeneration: 1,
      catalogStartedAt: 800,
      catalogBinaryFingerprint: `sha256:${'c'.repeat(64)}`,
      catalogConfigFingerprint: `sha256:${'d'.repeat(64)}`,
      catalogAuthFingerprint: `sha256:${'e'.repeat(64)}`,
      modelIds: ['deepinfra/llama-4'],
      configured: observation('configured', 'config_metadata', validUntil),
      lastConnected: observation({ state: 'connected', at: 800 }, 'auth_metadata', validUntil),
      catalogAvailable: observation('available', 'catalog_snapshot', validUntil),
      executionVerified: observation('verified', 'execution_snapshot', validUntil),
    }],
  }
}

function encoded(value: OpenCodeRedactedSnapshotV1): string {
  const result = encodeOpenCodeRedactedSnapshotV1(value)
  if (!result.ok || !result.bytes) throw new Error('invalid test snapshot')
  return new TextDecoder().decode(result.bytes)
}

const describeSupportedPersistence = process.platform === 'win32' ? describe.skip : describe

describeSupportedPersistence('OpenCode passive status production adapters', () => {
  test('uses the managed data-root contract without creating directories', () => {
    expect(getOpenCodePassiveStatusRootDirectory({
      CLAUDE_MULTIMODEL_DATA_HOME: '/managed/data',
    }, 'linux')).toBe('/managed/data/opencode/passive-status/v1')
    expect(getOpenCodePassiveStatusRootDirectory({
      XDG_DATA_HOME: '/xdg/data',
    }, 'linux')).toBe('/xdg/data/claude-multimodel-nodejs/opencode/passive-status/v1')
  })

  test('reads one bounded scoped snapshot and global binary record without active runtime calls', async () => {
    const reads: string[] = []
    const writes: string[] = []
    const text = encoded(snapshot())
    const adapter = new OpenCodePassiveStatusProductionReader({
      rootDirectory: '/passive',
      now: () => 1_000,
      canonicalizePath: async () => '/canonical/a',
      readBoundedText: async filePath => {
        reads.push(filePath)
        return text
      },
    })

    const status = await adapter.reader.read({
      projectPath: '/input/a',
      providerIds: ['deepinfra'],
      timeoutMs: 100,
    })

    expect(reads).toHaveLength(2)
    expect(reads.filter(value => value.includes('/snapshots/'))).toHaveLength(1)
    expect(writes).toEqual([])
    expect(status.binary.value).toEqual({ presence: 'present', version: '1.2.3' })
    expect(status.providers[0]).toMatchObject({
      configured: { value: 'configured', authority: 'config_metadata' },
      lastConnected: { value: { state: 'connected', at: 800 }, authority: 'auth_metadata' },
      catalogAvailable: { value: 'available', authority: 'catalog_snapshot' },
      executionVerified: { value: 'verified', authority: 'execution_snapshot' },
      knownModelIds: ['deepinfra/llama-4'],
      knownModelIdsTotal: 1,
      knownModelIdsTruncated: false,
    })
    expect(status.authorization).toBe('unknown')
    expect(status.launchReadiness).toBe('not_authorized')
  })

  test('routes expired history as stale evidence without reviving it as fresh authority', async () => {
    const staleText = encoded(snapshot('/canonical/a', 950))
    const stale = new OpenCodePassiveStatusProductionReader({
      rootDirectory: '/passive',
      now: () => 1_000,
      canonicalizePath: async () => '/canonical/a',
      readBoundedText: async filePath => filePath.endsWith('binary.snapshot.json') ? null : staleText,
    })
    const staleStatus = await stale.reader.read({ projectPath: '/a', providerIds: ['deepinfra'], timeoutMs: 50 })
    expect(staleStatus.providers[0].configured).toMatchObject({
      value: 'configured', freshness: 'stale', condition: 'degraded', authority: 'config_metadata', issueCode: 'expired',
    })
    expect(staleStatus.providers[0]).toMatchObject({
      catalogAvailable: { value: 'available', freshness: 'stale', authority: 'catalog_snapshot' },
    })
    expect(staleStatus.providers[0].knownModelIds).toBeUndefined()

    expect(staleStatus.binary).toMatchObject({
      value: { presence: 'unknown', version: null }, authority: 'none', freshness: 'unknown', condition: 'degraded',
    })
  })

  test('never labels cached generation N model IDs as part of newer disk catalog evidence', async () => {
    let disk = snapshot()
    const adapter = new OpenCodePassiveStatusProductionReader({
      rootDirectory: '/passive', now: () => 1_000,
      canonicalizePath: async () => '/canonical/a',
      readBoundedText: async filePath => filePath.endsWith('binary.snapshot.json') ? null : encoded(disk),
    })
    const first = await adapter.reader.read({ projectPath: '/a', providerIds: ['deepinfra'], timeoutMs: 50 })
    expect(first.providers[0].knownModelIds).toEqual(['deepinfra/llama-4'])

    disk = structuredClone(disk)
    disk.providers[0].modelIds = ['deepinfra/qwen-2.5-coder']
    disk.providers[0].catalogAttemptIdentity = catalogIdentity('generation-n-plus-1')
    const next = await adapter.reader.read({ projectPath: '/a', providerIds: ['deepinfra'], timeoutMs: 50 })
    expect(next.providers[0].catalogAvailable.value).toBe('available')
    expect(next.providers[0].knownModelIds).toBeUndefined()
    expect(JSON.stringify(next)).not.toContain('llama-4')
  })

  test('drops cached model IDs when config or auth evidence changes identity', async () => {
    for (const change of ['config', 'auth'] as const) {
      let disk = snapshot()
      const adapter = new OpenCodePassiveStatusProductionReader({
        rootDirectory: '/passive', now: () => 1_000,
        canonicalizePath: async () => '/canonical/a',
        readBoundedText: async filePath => filePath.endsWith('binary.snapshot.json') ? null : encoded(disk),
      })
      expect((await adapter.reader.read({ projectPath: '/a', providerIds: ['deepinfra'], timeoutMs: 50 }))
        .providers[0].knownModelIds).toEqual(['deepinfra/llama-4'])
      disk = structuredClone(disk)
      if (change === 'config') disk.providers[0].configured = observation('not_configured', 'config_metadata')
      else disk.providers[0].lastConnected = observation({ state: 'not_connected' }, 'auth_metadata')
      disk.providers[0].catalogAttemptIdentity = catalogIdentity(`${change}-changed`)
      const changed = await adapter.reader.read({ projectPath: '/a', providerIds: ['deepinfra'], timeoutMs: 50 })
      expect(changed.providers[0].knownModelIds).toBeUndefined()
    }
  })

  test('legacy snapshots without catalog identity retain safe status but expose no model IDs', async () => {
    const legacy = snapshot()
    delete legacy.providers[0].catalogIdentity
    delete legacy.providers[0].catalogAttemptIdentity
    delete legacy.providers[0].catalogRequestGeneration
    delete legacy.providers[0].catalogStartedAt
    delete legacy.providers[0].catalogBinaryFingerprint
    delete legacy.providers[0].catalogConfigFingerprint
    delete legacy.providers[0].catalogAuthFingerprint
    const adapter = new OpenCodePassiveStatusProductionReader({
      rootDirectory: '/passive', now: () => 1_000,
      canonicalizePath: async () => '/canonical/a',
      readBoundedText: async filePath => filePath.endsWith('binary.snapshot.json') ? null : encoded(legacy),
    })
    const status = await adapter.reader.read({ projectPath: '/a', providerIds: ['deepinfra'], timeoutMs: 50 })
    expect(status.providers[0].catalogAvailable.value).toBe('available')
    expect(status.providers[0].configured.value).toBe('configured')
    expect(status.providers[0].knownModelIds).toBeUndefined()
  })

  test('binds the same provider independently for two project cache keys', async () => {
    const disks = new Map<string, OpenCodeRedactedSnapshotV1>([
      [projectScope('/canonical/a').slice(7), snapshot('/canonical/a')],
      [projectScope('/canonical/b').slice(7), snapshot('/canonical/b')],
    ])
    const adapter = new OpenCodePassiveStatusProductionReader({
      rootDirectory: '/passive', now: () => 1_000,
      canonicalizePath: async value => `/canonical/${value.slice(1)}`,
      readBoundedText: async filePath => {
        if (filePath.endsWith('binary.snapshot.json')) return null
        return encoded(disks.get(filePath.slice(filePath.lastIndexOf('/') + 1, -5))!)
      },
    })
    for (const project of ['/a', '/b']) {
      const initial = await adapter.reader.read({ projectPath: project, providerIds: ['deepinfra'], timeoutMs: 50 })
      expect(initial.providers[0].knownModelIds).toEqual(['deepinfra/llama-4'])
    }
    const changedA = structuredClone(disks.get(projectScope('/canonical/a').slice(7))!)
    changedA.providers[0].catalogAttemptIdentity = catalogIdentity('project-a-new-generation')
    disks.set(projectScope('/canonical/a').slice(7), changedA)
    expect((await adapter.reader.read({ projectPath: '/a', providerIds: ['deepinfra'], timeoutMs: 50 }))
      .providers[0].knownModelIds).toBeUndefined()
    expect((await adapter.reader.read({ projectPath: '/b', providerIds: ['deepinfra'], timeoutMs: 50 }))
      .providers[0].knownModelIds).toEqual(['deepinfra/llama-4'])
  })

  test('never promotes stored stale/degraded timeout evidence through direct production ports', async () => {
    const historical = snapshot()
    const observations = [
      historical.binary,
      historical.providers[0].configured,
      historical.providers[0].lastConnected,
      historical.providers[0].catalogAvailable,
      historical.providers[0].executionVerified,
    ]
    for (const item of observations) {
      item.freshness = 'stale'
      item.condition = 'degraded'
      item.issueCode = 'read_timeout'
    }
    const text = encoded(historical)
    const adapter = new OpenCodePassiveStatusProductionReader({
      rootDirectory: '/passive',
      now: () => 1_000,
      canonicalizePath: async () => '/canonical/a',
      readBoundedText: async () => text,
    })
    const status = await adapter.reader.read({ projectPath: '/a', providerIds: ['deepinfra'], timeoutMs: 50 })

    expect(status.binary).toMatchObject({
      value: { presence: 'present', version: '1.2.3' }, authority: 'binary_metadata',
      freshness: 'stale', condition: 'degraded', issueCode: 'read_timeout',
    })
    expect(status.providers[0]).toMatchObject({
      configured: { value: 'configured', authority: 'config_metadata', freshness: 'stale', condition: 'degraded', issueCode: 'read_timeout' },
      lastConnected: { value: { state: 'connected', at: 800 }, authority: 'auth_metadata', freshness: 'stale', condition: 'degraded', issueCode: 'read_timeout' },
      catalogAvailable: { value: 'available', authority: 'catalog_snapshot', freshness: 'stale', condition: 'degraded', issueCode: 'read_timeout' },
      executionVerified: { value: 'verified', authority: 'execution_snapshot', freshness: 'stale', condition: 'degraded', issueCode: 'read_timeout' },
    })
    expect(status.authorization).toBe('unknown')
    expect(status.launchReadiness).toBe('not_authorized')
  })

  test('fails corrupt and mismatched payloads closed without inventing history', async () => {

    for (const payload of ['{', JSON.stringify({ schemaVersion: 0 }), encoded(snapshot('/canonical/other'))]) {
      const corrupt = new OpenCodePassiveStatusProductionReader({
        rootDirectory: '/passive',
        now: () => 1_000,
        canonicalizePath: async () => '/canonical/a',
        readBoundedText: async () => payload,
      })
      const status = await corrupt.reader.read({ projectPath: '/a', providerIds: ['deepinfra'], timeoutMs: 50 })
      expect(status.providers[0].configured).toMatchObject({ value: 'unknown', authority: 'none' })
      expect(status.authorization).toBe('unknown')
      expect(status.launchReadiness).toBe('not_authorized')
    }
  })

  test('isolates the same provider across projects and normalizes Windows, symlink and missing paths', async () => {
    const controller = new AbortController()
    if (process.platform !== 'win32') {
      await expect(canonicalizeOpenCodePassiveProjectPath('C:\\Users\\ALICE\\Project\\', controller.signal))
        .rejects.toThrow('require Windows canonicalization')
    }

    const fixtureRoot = await mkdtemp(path.join(process.cwd(), '.opencode-passive-scope-'))
    try {
      const target = path.join(fixtureRoot, 'real-project')
      const link = path.join(fixtureRoot, 'linked-project')
      const brokenLink = path.join(fixtureRoot, 'broken-project')
      const missing = path.join(fixtureRoot, 'missing-project', '..', 'missing-project')
      await mkdir(target)
      await symlink(target, link, 'dir')
      await symlink(path.join(fixtureRoot, 'does-not-exist'), brokenLink, 'dir')
      expect(await canonicalizeOpenCodePassiveProjectPath(link, controller.signal))
        .toBe(await canonicalizeOpenCodePassiveProjectPath(target, controller.signal))
      expect(await canonicalizeOpenCodePassiveProjectPath(missing, controller.signal))
        .toBe(path.normalize(missing))
      await expect(canonicalizeOpenCodePassiveProjectPath(brokenLink, controller.signal))
        .rejects.toThrow('changed while canonicalizing')
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true })
    }

    const aliases = new Map([
      ['/link/project', '/real/project'],
      ['/real/project', '/real/project'],
      ['/missing/project', '/missing/project'],
    ])
    const seenScopes: string[] = []
    const adapter = new OpenCodePassiveStatusProductionReader({
      rootDirectory: '/passive',
      now: () => 1_000,
      canonicalizePath: async value => aliases.get(value) ?? value,
      readBoundedText: async filePath => {
        if (filePath.endsWith('binary.snapshot.json')) return null
        const digest = filePath.slice(filePath.lastIndexOf('/') + 1, -'.json'.length)
        seenScopes.push(digest)
        const canonical = digest === projectScope('/real/project').slice(7) ? '/real/project' : '/missing/project'
        return encoded(snapshot(canonical))
      },
    })
    const linked = await adapter.reader.read({ projectPath: '/link/project', providerIds: ['deepinfra'], timeoutMs: 50 })
    const real = await adapter.reader.read({ projectPath: '/real/project', providerIds: ['deepinfra'], timeoutMs: 50 })
    const missing = await adapter.reader.read({ projectPath: '/missing/project', providerIds: ['deepinfra'], timeoutMs: 50 })
    expect(linked.projectScope).toBe(real.projectScope)
    expect(missing.projectScope).not.toBe(real.projectScope)
    expect(new Set(seenScopes).size).toBe(2)
  })

  test('one deadline cancels hanging reads and fences a late producer callback', async () => {
    const clock = new FakePassiveClock(1_000)
    let release!: (value: string | null) => void
    const delayed = new Promise<string | null>(resolve => { release = resolve })
    let firstRequest = true
    const adapter = new OpenCodePassiveStatusProductionReader({
      rootDirectory: '/passive',
      now: () => clock.now(),
      schedule: clock.schedule.bind(clock),
      canonicalizePath: async () => '/canonical/a',
      readBoundedText: async () => firstRequest ? delayed : null,
    })
    const pending = adapter.reader.read({ projectPath: '/a', providerIds: ['deepinfra'], timeoutMs: 10 })
    await flushMicrotasks()
    clock.advance(10)
    const status = await pending
    expect(status.providers[0].configured.issueCode).toBe('read_timeout')
    release(encoded(snapshot()))
    await flushMicrotasks()
    expect(status.providers[0].configured).toMatchObject({ value: 'unknown', authority: 'none' })
    expect(status.providers[0].knownModelIds).toBeUndefined()
    firstRequest = false
    const later = await adapter.reader.read({ projectPath: '/a', providerIds: ['deepinfra'], timeoutMs: 10 })
    expect(later.providers[0].configured).toMatchObject({ value: 'unknown', authority: 'none' })
    expect(later.providers[0].knownModelIds).toBeUndefined()
    expect(clock.pendingTimers()).toBe(0)
  })

  test('cancellation triggered by the cache freshness clock cannot evict valid exact-scope history', async () => {
    const clock = new FakePassiveClock(1_000)
    const controller = new AbortController()
    let abortOnSnapshotFreshnessCheck = false
    let readsReturnSnapshots = true
    const forever = new Promise<string | null>(() => {})
    const adapter = new OpenCodePassiveStatusProductionReader({
      rootDirectory: '/passive',
      now: () => {
        if (abortOnSnapshotFreshnessCheck) {
          abortOnSnapshotFreshnessCheck = false
          controller.abort('test_cache_fence')
        }
        return clock.now()
      },
      schedule: clock.schedule.bind(clock),
      canonicalizePath: async value => value,
      readBoundedText: async filePath => {
        if (!readsReturnSnapshots) return forever
        if (filePath.endsWith('binary.snapshot.json')) return null
        const digest = filePath.slice(filePath.lastIndexOf('/') + 1, -'.json'.length)
        const canonicalPath = Array.from({ length: 33 }, (_, index) => `/scope-${index}`)
          .find(value => projectScope(value).slice(7) === digest)
        if (!canonicalPath) return null
        if (canonicalPath === '/scope-32') abortOnSnapshotFreshnessCheck = true
        return encoded(snapshot(canonicalPath))
      },
    })

    for (let index = 0; index < 32; index += 1) {
      const status = await adapter.reader.read({
        projectPath: `/scope-${index}`,
        providerIds: ['deepinfra'],
        timeoutMs: 50,
      })
      expect(status.providers[0]?.configured.value).toBe('configured')
    }
    await adapter.reader.read({
      projectPath: '/scope-32',
      providerIds: ['deepinfra'],
      timeoutMs: 50,
      signal: controller.signal,
    })

    readsReturnSnapshots = false
    const retainedPending = adapter.reader.read({
      projectPath: '/scope-0',
      providerIds: ['deepinfra'],
      timeoutMs: 50,
    })
    await flushMicrotasks()
    clock.advance(50)
    const retained = await retainedPending
    expect(retained.providers[0]?.configured).toMatchObject({
      value: 'configured',
      authority: 'config_metadata',
      freshness: 'stale',
      condition: 'degraded',
      issueCode: 'read_timeout',
    })
  })

  test('permission and canonicalization churn cannot select any snapshot', async () => {
    for (const code of ['EACCES', 'EPERM', 'EAGAIN']) {
      let snapshotReads = 0
      const adapter = new OpenCodePassiveStatusProductionReader({
        rootDirectory: '/passive',
        now: () => 1_000,
        canonicalizePath: async () => {
          throw Object.assign(new Error(code), { code })
        },
        readBoundedText: async filePath => {
          if (filePath.includes('/snapshots/')) snapshotReads += 1
          return null
        },
      })
      const status = await adapter.reader.read({ projectPath: '/denied', providerIds: ['deepinfra'], timeoutMs: 10 })
      expect(status.projectScope).toBeNull()
      expect(status.providers[0]?.configured).toMatchObject({ value: 'unknown', authority: 'none' })
      expect(snapshotReads).toBe(0)
    }
  })

  test('a later transient read keeps cached exact-scope evidence stale and cannot cross projects', async () => {
    const clock = new FakePassiveClock(1_000)
    const text = encoded(snapshot())
    let hang = false
    const forever = new Promise<string | null>(() => {})
    const adapter = new OpenCodePassiveStatusProductionReader({
      rootDirectory: '/passive',
      now: () => clock.now(),
      schedule: clock.schedule.bind(clock),
      canonicalizePath: async value => value === '/a' ? '/canonical/a' : '/canonical/b',
      readBoundedText: async () => hang ? forever : text,
    })
    const first = await adapter.reader.read({ projectPath: '/a', providerIds: ['deepinfra'], timeoutMs: 10 })
    expect(first.providers[0].configured.value).toBe('configured')

    hang = true
    const pending = adapter.reader.read({ projectPath: '/a', providerIds: ['deepinfra'], timeoutMs: 10 })
    await flushMicrotasks()
    clock.advance(10)
    const degraded = await pending
    expect(degraded.providers[0].configured).toMatchObject({
      value: 'configured', authority: 'config_metadata', freshness: 'stale', condition: 'degraded', issueCode: 'read_timeout',
    })
    expect(degraded.providers[0].knownModelIds).toBeUndefined()

    const otherPending = adapter.reader.read({ projectPath: '/b', providerIds: ['deepinfra'], timeoutMs: 10 })
    await flushMicrotasks()
    clock.advance(10)
    const other = await otherPending
    expect(other.providers[0].configured).toMatchObject({ value: 'unknown', authority: 'none' })
  })

  test('writer is separate, bounded, atomic-facing and never invoked by readStatus', async () => {
    const directories: string[] = []
    const writes: Array<{ path: string; text: string }> = []
    const writer = new OpenCodePassiveStatusSnapshotWriter({
      rootDirectory: '/passive',
      makeDirectory: async directory => { directories.push(directory) },
      writeAtomic: async (filePath, data) => { writes.push({ path: filePath, text: data }) },
    })
    await writer.write(snapshot(), new AbortController().signal)
    expect(directories).toEqual(['/passive/snapshots'])
    expect(writes.map(item => item.path)).toEqual([
      `/passive/snapshots/${snapshot().projectScope.slice(7)}.json`,
      '/passive/binary.snapshot.json',
    ])
    expect(writes[0].text).toBe(writes[1].text)
    for (const forbidden of ['/canonical/a', 'api-key', 'token', 'secret']) {
      expect(writes[0].text).not.toContain(forbidden)
    }
  })

  test('production writer and reader use one bounded durable transaction row', async () => {
    const root = await mkdtemp(path.join(process.cwd(), '.opencode-passive-store-'))
    try {
      const writer = new OpenCodePassiveStatusSnapshotWriter({ rootDirectory: root })
      await writer.write(snapshot(), new AbortController().signal)
      const reader = new OpenCodePassiveStatusProductionReader({
        rootDirectory: root,
        now: () => 1_000,
        canonicalizePath: async () => '/canonical/a',
      })
      const status = await reader.reader.read({ projectPath: '/a', providerIds: ['deepinfra'], timeoutMs: 1_000 })
      expect(status.providers[0].configured.value).toBe('configured')

      const db = new Database(openCodePassiveDatabasePath(root))
      try { db.exec("UPDATE passive_transactions SET payload = 'corrupt' WHERE id = (SELECT transaction_id FROM passive_current LIMIT 1)") }
      finally { db.close(false) }
      const bounded = new OpenCodePassiveStatusProductionReader({
        rootDirectory: root, now: () => 1_000, canonicalizePath: async () => '/canonical/missing',
      })
      const boundedStatus = await bounded.reader.read({ projectPath: '/a', providerIds: [], timeoutMs: 100 })
      expect(boundedStatus.binary.value.presence).toBe('unknown')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  test('returns the last committed transactional snapshot stale and degraded when refresh times out', async () => {
    const root = await mkdtemp(path.join(process.cwd(), '.opencode-passive-committed-timeout-'))
    let stall = false
    try {
      await new OpenCodePassiveStatusSnapshotWriter({ rootDirectory: root })
        .write(snapshot(), new AbortController().signal)
      const reader = new OpenCodePassiveStatusProductionReader({
        rootDirectory: root,
        now: () => 1_000,
        canonicalizePath: async () => '/canonical/a',
        afterCommittedTransactionSelected: () => stall ? new Promise<void>(() => undefined) : undefined,
      })
      const initial = await reader.reader.read({ projectPath: '/a', providerIds: ['deepinfra'], timeoutMs: 1_000 })
      expect(initial.providers[0].configured.value).toBe('configured')
      stall = true
      const degraded = await reader.reader.read({ projectPath: '/a', providerIds: ['deepinfra'], timeoutMs: 20 })
      expect(degraded.binary).toMatchObject({ freshness: 'stale', condition: 'degraded', issueCode: 'read_timeout' })
      expect(degraded.providers[0].configured).toMatchObject({
        value: 'configured', freshness: 'stale', condition: 'degraded', issueCode: 'read_timeout',
      })
      expect(degraded.launchReadiness).toBe('not_authorized')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  test('legacy component symlinks are never traversed by the SQLite store', async () => {
    if (process.platform === 'win32') return
    const root = await mkdtemp(path.join(process.cwd(), '.opencode-passive-symlink-'))
    const outside = await mkdtemp(path.join(process.cwd(), '.opencode-passive-outside-'))
    try {
      await symlink(outside, path.join(root, 'scopes'), 'dir')
      const writer = new OpenCodePassiveStatusSnapshotWriter({ rootDirectory: root })
      await writer.write(snapshot(), new AbortController().signal)
      expect(await readdir(outside)).toEqual([])
      const target = path.join(outside, 'outside.json')
      await writeFile(target, encoded(snapshot()))
      const reader = new OpenCodePassiveStatusProductionReader({
        rootDirectory: root, now: () => 1_000, canonicalizePath: async () => '/canonical/a',
      })
      const status = await reader.reader.read({ projectPath: '/a', providerIds: ['deepinfra'], timeoutMs: 100 })
      expect(status.providers[0].configured.value).toBe('configured')
      expect(await readFile(target, 'utf8')).toBe(encoded(snapshot()))
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })
})
