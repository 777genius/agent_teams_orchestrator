import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { OpenCodeActiveStatusSnapshotPublisher } from './OpenCodeActiveStatusSnapshotPublisher.js'
import {
  OPEN_CODE_PASSIVE_DATABASE,
  maintainOpenCodePassiveStore,
  openCodePassiveDatabasePath,
  readOpenCodePassiveSnapshot,
} from './OpenCodePassiveSnapshotStore.js'
import {
  OpenCodePassiveStatusProductionReader,
  readBoundedSnapshotText,
} from './OpenCodePassiveStatusProductionReader.js'
import { OpenCodePassiveStatusSnapshotWriter } from './OpenCodePassiveStatusSnapshotWriter.js'
import { OPEN_CODE_PASSIVE_TRANSACTION_MARKER_CONTENT } from './OpenCodePassiveSnapshotTransaction.js'
import {
  decodeOpenCodeRedactedSnapshotV1,
  type OpenCodeRedactedSnapshotV1,
} from './OpenCodeRedactedStatusSnapshot.js'

const canonical = '/canonical/project'
const scope = `sha256:${createHash('sha256').update('opencode-project-scope-v1\0').update(canonical).digest('hex')}` as const
const direct = <T>(value: T, authority: any, at: number, evidenceGeneration?: number) => ({
  value, authority, freshness: 'fresh' as const, condition: 'normal' as const,
  observedAt: at, validUntil: at + 300_000, issueCode: 'none' as const,
  ...(evidenceGeneration === undefined ? {} : { evidenceGeneration }),
})
const unknown = <T>(value: T) => ({ value, authority: 'none' as const, freshness: 'unknown' as const,
  condition: 'degraded' as const, observedAt: null, validUntil: null, issueCode: 'unknown' as const })
const digest = (character: string): `sha256:${string}` => `sha256:${character.repeat(64)}`
const catalogEvidence = (generation: number, marker: string) => ({
  providerId: 'deepinfra', requestGeneration: generation, startedAt: 1_000,
  attemptIdentity: digest(marker), binaryFingerprint: digest('b'),
  configFingerprint: digest('c'), authFingerprint: digest('d'),
})

function snapshot(at: number, connected: boolean, version: string, generation?: number): OpenCodeRedactedSnapshotV1 {
  return { schemaVersion: 1, projectScope: scope, capturedAt: at,
    binary: direct({ presence: 'present' as const, version }, 'binary_metadata', at, generation),
    providers: [{ providerId: 'deepinfra', configured: unknown('unknown'),
      lastConnected: direct(connected ? { state: 'connected' as const, at } : { state: 'not_connected' as const }, 'auth_metadata', at, generation),
      catalogAvailable: unknown('unknown'), executionVerified: unknown('unknown') }] }
}

function deferred() { let resolve!: () => void; return { promise: new Promise<void>(done => { resolve = done }), resolve } }
async function runBoundedBunChild(source: string, timeoutMs = 20_000) {
  const child = Bun.spawn([process.execPath, '-e', source], { stdout: 'pipe', stderr: 'pipe' })
  const stdout = new Response(child.stdout).text()
  const stderr = new Response(child.stderr).text()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      child.kill()
      reject(new Error(`bounded fake child exceeded ${timeoutMs}ms`))
    }, timeoutMs)
  })
  try {
    const [exitCode, output, error] = await Promise.all([
      Promise.race([child.exited, timeout]), stdout, stderr,
    ])
    return { exitCode, stdout: output, stderr: error }
  } finally {
    if (timer) clearTimeout(timer)
    child.kill()
    await child.exited
  }
}
async function appendLegacy(
  root: string,
  value: OpenCodeRedactedSnapshotV1,
  sequence: number,
  generation = `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
) {
  const scoped = path.join(root, 'scopes', value.projectScope.slice(7))
  await mkdir(path.join(scoped, 'commits'), { recursive: true })
  await mkdir(path.join(scoped, 'generations', generation), { recursive: true })
  await writeFile(path.join(root, 'immutable-v2.marker'), OPEN_CODE_PASSIVE_TRANSACTION_MARKER_CONTENT)
  const text = JSON.stringify(value)
  await writeFile(path.join(scoped, 'generations', generation, 'project.snapshot.json'), text)
  await writeFile(path.join(scoped, 'generations', generation, 'binary.snapshot.json'), text)
  await writeFile(path.join(scoped, 'commits', `${String(sequence).padStart(16, '0')}.${generation}.json`), JSON.stringify({
    schemaVersion: 2, scope: value.projectScope, generation, domainGeneration: sequence,
  }))
}
async function status(root: string, providerIds = ['deepinfra']) {
  return new OpenCodePassiveStatusProductionReader({ rootDirectory: root, now: () => 10_000,
    canonicalizePath: async () => canonical }).reader.read({ projectPath: canonical, providerIds, timeoutMs: 5_000 })
}

describe('OpenCode passive SQLite transaction consistency', () => {
  test.skipIf(process.platform !== 'win32')(
    'Windows production read preserves every publication entry and exact object identity', async () => {
      const root = await mkdtemp(path.join(process.cwd(), '.passive-windows-readonly-'))
      const entries = async () => Promise.all((await readdir(root)).sort().map(async name => {
        const value = await lstat(path.join(root, name), { bigint: true })
        return [name, value.dev, value.ino, value.size, value.mode] as const
      }))
      try {
        await new OpenCodePassiveStatusSnapshotWriter({
          rootDirectory: root, scheduleMaintenance: () => undefined,
        })
          .write(snapshot(1_000, true, '1.0.0'), new AbortController().signal)
        const before = await entries()
        const observed = await readOpenCodePassiveSnapshot(root, scope, new AbortController().signal)
        expect(observed?.value.binary.value.version).toBe('1.0.0')
        expect(await entries()).toEqual(before)
      } finally { await rm(root, { recursive: true, force: true }) }
    },
  )

  test('32 real processes allocate unique monotonic generations and merge same-scope mutations', async () => {
    const root = await mkdtemp(path.join(process.cwd(), '.passive-sqlite-processes-'))
    try {
      const moduleUrl = pathToFileURL(path.join(process.cwd(), 'src/services/opencode/OpenCodePassiveSnapshotStore.ts')).href
      const children = Array.from({ length: 32 }, (_, index) => {
        const providerId = `sha256:${createHash('sha256').update(`process-${index}`).digest('hex')}`
        const source = `import { mutateOpenCodePassiveSnapshot } from ${JSON.stringify(moduleUrl)};
          const observation={value:'configured',authority:'config_metadata',freshness:'fresh',condition:'normal',observedAt:1000,validUntil:301000,issueCode:'none'};
          const id=await mutateOpenCodePassiveSnapshot({rootDirectory:${JSON.stringify(root)}},{projectScope:${JSON.stringify(scope)},capturedAt:1000,providers:[{providerId:${JSON.stringify(providerId)},configured:observation}]},new AbortController().signal);
          console.log(id);`
        return runBoundedBunChild(source)
      })
      const results = await Promise.all(children)
      expect(results.every(child => child.exitCode === 0), results.map(child => child.stderr).filter(Boolean).join('\n')).toBe(true)
      const ids = results.map(child => Number(child.stdout.trim()))
      expect(new Set(ids).size).toBe(32)
      expect(ids.every(Number.isSafeInteger)).toBe(true)
      const selected = await readOpenCodePassiveSnapshot(root, scope, new AbortController().signal)
      expect(selected?.value.providers.map(provider => provider.providerId)).toHaveLength(32)
      const db = new Database(openCodePassiveDatabasePath(root), { readonly: true })
      try {
        expect(db.query<{ count: number }, []>('SELECT count(*) AS count FROM passive_transactions').get()?.count).toBe(2)
        expect(db.query<{ count: number }, []>('SELECT count(*) AS count FROM passive_current').get()?.count).toBe(1)
      } finally { db.close(false) }
    } finally { await rm(root, { recursive: true, force: true }) }
  }, 30_000)

  test('a crashed owner rolls back without a lock and restart advances authority', async () => {
    const root = await mkdtemp(path.join(process.cwd(), '.passive-sqlite-crash-'))
    try {
      const moduleUrl = pathToFileURL(path.join(process.cwd(), 'src/services/opencode/OpenCodePassiveSnapshotStore.ts')).href
      const source = `import { mutateOpenCodePassiveSnapshot } from ${JSON.stringify(moduleUrl)};
        const o={value:'configured',authority:'config_metadata',freshness:'fresh',condition:'normal',observedAt:1,validUntil:300001,issueCode:'none'};
        await mutateOpenCodePassiveSnapshot({rootDirectory:${JSON.stringify(root)},hooks:{afterGenerationDirectoryCreated(){process.exit(77)}}},{projectScope:${JSON.stringify(scope)},capturedAt:1,providers:[{providerId:'deepinfra',configured:o}]},new AbortController().signal);`
      const child = await runBoundedBunChild(source)
      expect(child.exitCode, child.stderr).toBe(77)
      await new OpenCodeActiveStatusSnapshotPublisher({ rootDirectory: root, now: () => 2_000,
        canonicalizePath: async () => canonical, publicationDeadlineMs: 5_000 }).publishProviderUpdate({ projectPath: canonical,
          providerId: 'deepinfra', connected: false })
      expect((await status(root)).providers[0].lastConnected.value.state).toBe('not_connected')
      expect((await readdir(root)).filter(name => name.startsWith(OPEN_CODE_PASSIVE_DATABASE)).length).toBeLessThanOrEqual(4)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  test('legacy generation 5000 is fenced before a disconnect and survives restart', async () => {
    const root = await mkdtemp(path.join(process.cwd(), '.passive-sqlite-legacy-'))
    const generation = '00000000-0000-4000-8000-000000000443'
    try {
      const scoped = path.join(root, 'scopes', scope.slice(7))
      await mkdir(path.join(scoped, 'commits'), { recursive: true })
      await mkdir(path.join(scoped, 'generations', generation), { recursive: true })
      await writeFile(path.join(root, 'immutable-v2.marker'), OPEN_CODE_PASSIVE_TRANSACTION_MARKER_CONTENT)
      await writeFile(path.join(scoped, 'commits', `0000000000005000.${generation}.json`), JSON.stringify({
        schemaVersion: 2, scope, generation, domainGeneration: 5000,
      }))
      const legacy = JSON.stringify(snapshot(1_000, true, '1.0.0'))
      await writeFile(path.join(scoped, 'generations', generation, 'project.snapshot.json'), legacy)
      await writeFile(path.join(scoped, 'generations', generation, 'binary.snapshot.json'), legacy)
      await new OpenCodePassiveStatusSnapshotWriter({ rootDirectory: root }).mutate({ projectScope: scope,
        capturedAt: 2_000, binary: direct({ presence: 'present' as const, version: '2.0.0' }, 'binary_metadata', 2_000),
        providers: [{ providerId: 'deepinfra', lastConnected: direct({ state: 'not_connected' as const }, 'auth_metadata', 2_000) }],
      }, new AbortController().signal)
      const restarted = await status(root)
      expect(restarted.providers[0].lastConnected.value.state).toBe('not_connected')
      expect(restarted.binary.value.version).toBe('2.0.0')
      const row = new Database(openCodePassiveDatabasePath(root), { readonly: true })
      try { expect(row.query<{ id: number }, []>('SELECT max(id) AS id FROM passive_transactions').get()!.id).toBeGreaterThan(5000) }
      finally { row.close(false) }
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  test('a failed legacy read never marks migration complete and a repaired immutable store imports on restart', async () => {
    const root = await mkdtemp(path.join(process.cwd(), '.passive-sqlite-retry-migration-'))
    const generation = '00000000-0000-4000-8000-000000000007'
    const scoped = path.join(root, 'scopes', scope.slice(7))
    try {
      await mkdir(path.join(scoped, 'commits'), { recursive: true })
      await writeFile(path.join(root, 'immutable-v2.marker'), OPEN_CODE_PASSIVE_TRANSACTION_MARKER_CONTENT)
      await writeFile(path.join(scoped, 'commits', `0000000000000007.${generation}.json`), '{broken')
      const mutation = { projectScope: scope, capturedAt: 8,
        providers: [{ providerId: 'deepinfra', lastConnected: direct({ state: 'not_connected' as const }, 'auth_metadata', 8) }],
      } as const
      await expect(new OpenCodePassiveStatusSnapshotWriter({ rootDirectory: root })
        .mutate(mutation, new AbortController().signal)).rejects.toThrow('legacy')
      const failed = new Database(openCodePassiveDatabasePath(root), { readonly: true })
      try {
        expect(failed.query<{ count: number }, []>('SELECT count(*) AS count FROM passive_migrations').get()!.count).toBe(0)
        expect(failed.query<{ migrated: number }, []>('SELECT legacy_migrated AS migrated FROM passive_meta').get()!.migrated).toBe(0)
      } finally { failed.close(false) }
      const repairedBase = snapshot(7, true, '1.0.0', 7)
      const repaired: OpenCodeRedactedSnapshotV1 = { ...repairedBase, providers: [{
        ...repairedBase.providers[0], configured: direct('configured', 'config_metadata', 7, 7),
      }] }
      await appendLegacy(root, repaired, 7)
      await new OpenCodePassiveStatusSnapshotWriter({ rootDirectory: root }).mutate(mutation, new AbortController().signal)
      const selected = await readOpenCodePassiveSnapshot(root, scope, new AbortController().signal)
      expect(selected?.value.providers[0].configured.value).toBe('configured')
      expect(selected?.value.providers[0].lastConnected.value.state).toBe('not_connected')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  test('identical cumulative evidence advances migrated logical time in both UUID orders and across replay', async () => {
    const lower = '00000000-0000-4000-8000-000000000031'
    const higher = '00000000-0000-4000-8000-000000000032'
    for (const descendingUuids of [false, true]) {
      const root = await mkdtemp(path.join(process.cwd(), `.passive-sqlite-cumulative-clock-${descendingUuids}-`))
      const firstGeneration = descendingUuids ? higher : lower
      const secondGeneration = descendingUuids ? lower : higher
      const first = snapshot(1, true, '1.0.0', 1)
      first.providers[0].configured = direct('configured', 'config_metadata', 1, 1)
      const second = structuredClone(first)
      second.capturedAt = 100
      try {
        await appendLegacy(root, first, 1, firstGeneration)
        await appendLegacy(root, second, 2, secondGeneration)
        const directText = await readBoundedSnapshotText(
          path.join(root, 'snapshots', `${scope.slice(7)}.json`), new AbortController().signal,
        )
        const directRead = directText === null ? null : decodeOpenCodeRedactedSnapshotV1(directText)
        expect(directRead?.ok && directRead.value.capturedAt).toBe(100)

        const scoped = path.join(root, 'scopes', scope.slice(7))
        await rm(path.join(scoped, 'commits', `0000000000000002.${secondGeneration}.json`))
        await rm(path.join(scoped, 'generations', secondGeneration), { recursive: true })
        const writer = new OpenCodePassiveStatusSnapshotWriter({ rootDirectory: root })
        await writer.mutate({ projectScope: scope, capturedAt: 2,
          providers: [{ providerId: 'deepinfra', lastConnected: direct({ state: 'not_connected' as const }, 'auth_metadata', 2) }],
        }, new AbortController().signal)
        const initial = (await readOpenCodePassiveSnapshot(root, scope, new AbortController().signal))!
        const binaryGeneration = initial.value.binary.evidenceGeneration
        const configuredGeneration = initial.value.providers[0].configured.evidenceGeneration

        await appendLegacy(root, second, 2, secondGeneration)
        await writer.mutate({ projectScope: scope, capturedAt: 3 }, new AbortController().signal)
        const reconciled = (await readOpenCodePassiveSnapshot(root, scope, new AbortController().signal))!
        expect(reconciled.value.capturedAt).toBeGreaterThanOrEqual(100)
        expect(reconciled.value.binary.evidenceGeneration).toBe(binaryGeneration)
        expect(reconciled.value.providers[0].configured.evidenceGeneration).toBe(configuredGeneration)

        const deployed = new Database(openCodePassiveDatabasePath(root))
        try {
          const row = deployed.query<{ id: number; payload: string }, [string]>(`SELECT t.id, t.payload
            FROM passive_current c JOIN passive_transactions t ON t.id = c.transaction_id
            WHERE c.scope = ?`).get(scope)!
          const stale = JSON.parse(row.payload) as OpenCodeRedactedSnapshotV1
          stale.capturedAt = 3
          deployed.query('UPDATE passive_transactions SET payload = ? WHERE id = ?')
            .run(JSON.stringify(stale), row.id)
        } finally { deployed.close(false) }
        const restarted = (await readOpenCodePassiveSnapshot(root, scope, new AbortController().signal))!
        expect(restarted.value.capturedAt).toBeGreaterThanOrEqual(100)

        await writer.mutate({ projectScope: scope, capturedAt: 3,
          providers: [{ providerId: 'deepinfra', executionVerified: direct('verified' as const, 'execution_snapshot', 3) }],
        }, new AbortController().signal)
        const persisted = (await readOpenCodePassiveSnapshot(root, scope, new AbortController().signal))!
        expect(persisted.value.capturedAt).toBeGreaterThanOrEqual(100)
        expect(persisted.value.providers[0].executionVerified.observedAt).toBeGreaterThanOrEqual(100)
        const executionGeneration = persisted.value.providers[0].executionVerified.evidenceGeneration

        await appendLegacy(root, second, 2, secondGeneration)
        const replayed = (await readOpenCodePassiveSnapshot(root, scope, new AbortController().signal))!
        expect(replayed.value.capturedAt).toBeGreaterThanOrEqual(100)
        expect(replayed.value.providers[0].executionVerified.evidenceGeneration).toBe(executionGeneration)
        expect(replayed.value.binary.evidenceGeneration).toBe(binaryGeneration)
        expect(replayed.value.providers[0].configured.evidenceGeneration).toBe(configuredGeneration)
      } finally { await rm(root, { recursive: true, force: true }) }
    }
  }, 15_000)

  test('migration merges independent legacy evidence and rolling writers fail closed then reconcile newer negatives', async () => {
    const root = await mkdtemp(path.join(process.cwd(), '.passive-sqlite-rolling-'))
    const legacy = (sequence: number, configured: 'configured' | 'not_configured', configuredGeneration: number,
      catalog: 'available' | 'unknown', catalogGeneration?: number): OpenCodeRedactedSnapshotV1 => ({
      schemaVersion: 1, projectScope: scope, capturedAt: sequence,
      binary: direct({ presence: 'present' as const, version: '1.0.0' }, 'binary_metadata', sequence, sequence),
      providers: [{ providerId: 'deepinfra',
        configured: direct(configured, 'config_metadata', sequence, configuredGeneration),
        lastConnected: unknown({ state: 'unknown' }),
        catalogAvailable: catalog === 'available'
          ? direct('available', 'catalog_snapshot', sequence, catalogGeneration)
          : unknown('unknown'),
        ...(catalog === 'available' ? { modelIds: ['deepinfra/llama'] } : {}),
        executionVerified: unknown('unknown') }],
    })
    try {
      await appendLegacy(root, legacy(10, 'configured', 10, 'unknown'), 10)
      await appendLegacy(root, legacy(20, 'not_configured', 5, 'available', 20), 20)
      await new OpenCodePassiveStatusSnapshotWriter({ rootDirectory: root }).mutate({
        projectScope: scope, capturedAt: 20,
        providers: [{ providerId: 'deepinfra', lastConnected: direct({ state: 'not_connected' as const }, 'auth_metadata', 20) }],
      }, new AbortController().signal)
      const migrated = await readOpenCodePassiveSnapshot(root, scope, new AbortController().signal)
      expect(migrated?.value.providers[0].configured.value).toBe('configured')
      expect(migrated?.value.providers[0].catalogAvailable.value).toBe('available')
      // Legacy catalog availability can migrate, but model authority without
      // the current project/provider/fingerprint binding must remain inert.
      expect(migrated?.value.providers[0].modelIds).toBeUndefined()

      await appendLegacy(root, legacy(30, 'not_configured', 30, 'available', 20), 30)
      expect(await readOpenCodePassiveSnapshot(root, scope, new AbortController().signal)).toBeNull()
      await new OpenCodePassiveStatusSnapshotWriter({ rootDirectory: root }).mutate({
        projectScope: scope, capturedAt: 30,
        binary: direct({ presence: 'present' as const, version: '2.0.0' }, 'binary_metadata', 30),
      }, new AbortController().signal)
      const reconciled = await readOpenCodePassiveSnapshot(root, scope, new AbortController().signal)
      expect(reconciled?.value.providers[0].configured.value).toBe('not_configured')
      expect(reconciled?.value.providers[0].catalogAvailable.value).toBe('available')
      expect(reconciled?.value.binary.value.version).toBe('2.0.0')
      expect(await readOpenCodePassiveSnapshot(root, scope, new AbortController().signal)).not.toBeNull()

      const repeatedBase = legacy(40, 'not_configured', 30, 'unknown')
      const repeated: OpenCodeRedactedSnapshotV1 = { ...repeatedBase, providers: [{
        ...repeatedBase.providers[0],
        catalogAvailable: direct('unavailable', 'catalog_snapshot', 40, 40),
      }] }
      await appendLegacy(root, repeated, 40)
      expect(await readOpenCodePassiveSnapshot(root, scope, new AbortController().signal)).toBeNull()
      await new OpenCodePassiveStatusSnapshotWriter({ rootDirectory: root }).mutate({
        projectScope: scope, capturedAt: 40,
        binary: direct({ presence: 'present' as const, version: '3.0.0' }, 'binary_metadata', 40),
      }, new AbortController().signal)
      const repeatedReconciliation = await readOpenCodePassiveSnapshot(root, scope, new AbortController().signal)
      expect(repeatedReconciliation?.value.providers[0].configured.value).toBe('not_configured')
      expect(repeatedReconciliation?.value.providers[0].catalogAvailable.value).toBe('unavailable')
    } finally { await rm(root, { recursive: true, force: true }) }
  }, 15_000)

  test('logical observation time survives backward, frozen, restart and forward clocks without reauthorizing unchanged facts', async () => {
    const root = await mkdtemp(path.join(process.cwd(), '.passive-sqlite-clock-'))
    const writer = new OpenCodePassiveStatusSnapshotWriter({ rootDirectory: root })
    try {
      await writer.mutate({ projectScope: scope, capturedAt: 1_000_000,
        providers: [{ providerId: 'deepinfra', configured: direct('configured', 'config_metadata', 1_000_000) }],
      }, new AbortController().signal)
      await writer.mutate({ projectScope: scope, capturedAt: 100,
        binary: direct({ presence: 'present' as const, version: '2.0.0' }, 'binary_metadata', 100),
      }, new AbortController().signal)
      const rolledBack = (await readOpenCodePassiveSnapshot(root, scope, new AbortController().signal))!
      expect(rolledBack.value.capturedAt).toBe(1_000_000)
      expect(rolledBack.value.binary.observedAt).toBe(1_000_000)
      expect(rolledBack.value.binary.validUntil).toBe(1_300_000)
      const configuredGeneration = rolledBack.value.providers[0].configured.evidenceGeneration
      await writer.mutate({ projectScope: scope, capturedAt: 100,
        providers: [{ providerId: 'deepinfra', lastConnected: direct({ state: 'not_connected' as const }, 'auth_metadata', 100) }],
      }, new AbortController().signal)
      const frozen = (await readOpenCodePassiveSnapshot(root, scope, new AbortController().signal))!
      expect(frozen.value.providers[0].configured.evidenceGeneration).toBe(configuredGeneration)
      expect(frozen.value.providers[0].lastConnected.observedAt).toBe(1_000_000)
      await new OpenCodePassiveStatusSnapshotWriter({ rootDirectory: root }).mutate({ projectScope: scope, capturedAt: 2_000_000,
        binary: direct({ presence: 'present' as const, version: '3.0.0' }, 'binary_metadata', 2_000_000),
      }, new AbortController().signal)
      const forward = (await readOpenCodePassiveSnapshot(root, scope, new AbortController().signal))!
      expect(forward.value.capturedAt).toBe(2_000_000)
      expect(forward.value.binary.validUntil).toBe(2_300_000)
    } finally { await rm(root, { recursive: true, force: true }) }
  }, 15_000)

  test('global scope, history and migration rows remain strictly bounded with deterministic eviction', async () => {
    const root = await mkdtemp(path.join(process.cwd(), '.passive-sqlite-global-bound-'))
    try {
      const writer = new OpenCodePassiveStatusSnapshotWriter({ rootDirectory: root, scheduleMaintenance: () => undefined })
      for (let index = 0; index < 1_024; index += 1) {
        const distinct = `sha256:${createHash('sha256').update(`scope-${index}`).digest('hex')}` as const
        await writer.mutate({ projectScope: distinct, capturedAt: index,
          binary: direct({ presence: 'present' as const, version: `${index}.0.0` }, 'binary_metadata', index),
        }, new AbortController().signal)
      }
      await maintainOpenCodePassiveStore(root)
      const db = new Database(openCodePassiveDatabasePath(root), { readonly: true })
      try {
        expect(db.query<{ count: number }, []>('SELECT count(*) AS count FROM passive_current').get()!.count).toBeLessThanOrEqual(128)
        expect(db.query<{ count: number }, []>('SELECT count(*) AS count FROM passive_transactions').get()!.count).toBeLessThanOrEqual(256)
        expect(db.query<{ count: number }, []>('SELECT count(*) AS count FROM passive_legacy_state').get()!.count).toBeLessThanOrEqual(128)
        expect(db.query<{ count: number }, []>('SELECT count(*) AS count FROM passive_migrations').get()!.count).toBeLessThanOrEqual(128)
        expect(db.query<{ page_count: number }, []>('PRAGMA page_count').get()!.page_count).toBeLessThan(1_024)
      } finally { db.close(false) }
      const active = `sha256:${createHash('sha256').update('scope-1023').digest('hex')}` as const
      expect((await readOpenCodePassiveSnapshot(root, active, new AbortController().signal))?.value.binary.value.version).toBe('1023.0.0')
      const evicted = `sha256:${createHash('sha256').update('scope-0').digest('hex')}` as const
      expect(await readOpenCodePassiveSnapshot(root, evicted, new AbortController().signal)).toBeNull()
    } finally { await rm(root, { recursive: true, force: true }) }
  }, 180_000)

  test('forged generations are replaced internally and corrupt durable authority fails closed', async () => {
    const root = await mkdtemp(path.join(process.cwd(), '.passive-sqlite-forged-'))
    try {
      await new OpenCodePassiveStatusSnapshotWriter({ rootDirectory: root })
        .write(snapshot(1_000, true, '1.0.0', Number.MAX_SAFE_INTEGER), new AbortController().signal)
      await new OpenCodeActiveStatusSnapshotPublisher({ rootDirectory: root, now: () => 500,
        canonicalizePath: async () => canonical }).publishProviderUpdate({ projectPath: canonical,
          providerId: 'deepinfra', connected: false })
      expect((await status(root)).providers[0].lastConnected.value.state).toBe('not_connected')
      const db = new Database(openCodePassiveDatabasePath(root))
      try {
        const row = db.query<{ id: number; payload: string }, []>('SELECT id, payload FROM passive_transactions ORDER BY id DESC LIMIT 1').get()!
        const malformed = JSON.parse(row.payload); malformed.providers[0].lastConnected.evidenceGeneration = Number.MAX_SAFE_INTEGER
        db.query('UPDATE passive_transactions SET payload = ? WHERE id = ?').run(JSON.stringify(malformed), row.id)
      } finally { db.close(false) }
      expect((await status(root)).providers[0].lastConnected.value.state).toBe('unknown')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  test('catalog, auth and execution publishers preserve each domain in serialized transactions', async () => {
    const root = await mkdtemp(path.join(process.cwd(), '.passive-sqlite-domains-'))
    const selected = deferred(); const release = deferred()
    try {
      const seed = new OpenCodeActiveStatusSnapshotPublisher({ rootDirectory: root, now: () => 1_000,
        canonicalizePath: async () => canonical })
      await seed.publishProviderUpdate({ projectPath: canonical, providerId: 'deepinfra', connected: true })
      await seed.publishExecutionUpdate({ projectPath: canonical, providerId: 'deepinfra', executionVerified: true })
      await seed.publishCatalogResult({ projectPath: canonical, evidence: catalogEvidence(1, 'a'),
        catalogAvailable: true, modelIds: ['deepinfra/old'] })

      const catalog = new OpenCodeActiveStatusSnapshotPublisher({ rootDirectory: root, now: () => 2_000,
        canonicalizePath: async () => canonical, writer: new OpenCodePassiveStatusSnapshotWriter({
          rootDirectory: root, safeStorageHooks: { afterGenerationDirectoryCreated: async () => {
            selected.resolve(); await release.promise
          } },
        }) })
      const catalogUpdate = catalog.publishCatalogResult({ projectPath: canonical,
        evidence: { ...catalogEvidence(2, 'e'), startedAt: 2_000 },
        catalogAvailable: true, modelIds: ['deepinfra/new'] })
      await selected.promise
      const state = new OpenCodeActiveStatusSnapshotPublisher({ rootDirectory: root, now: () => 2_001,
        canonicalizePath: async () => canonical })
      const stateUpdate = (async () => {
        await state.publishProviderUpdate({ projectPath: canonical, providerId: 'deepinfra', connected: false })
        await state.publishExecutionUpdate({ projectPath: canonical, providerId: 'deepinfra', executionVerified: false })
      })()
      release.resolve()
      await Promise.all([catalogUpdate, stateUpdate])
      const result = await status(root)
      expect(result.providers[0].lastConnected.value.state).toBe('not_connected')
      expect(result.providers[0].executionVerified.value).toBe('rejected')
      expect(result.providers[0].catalogAvailable.value).toBe('available')
      expect(result.providers[0].knownModelIds).toBeUndefined()
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  test('selected reads and paused writers remain valid across maintenance without grace clocks', async () => {
    const root = await mkdtemp(path.join(process.cwd(), '.passive-sqlite-stable-read-'))
    try {
      await new OpenCodePassiveStatusSnapshotWriter({ rootDirectory: root }).write(snapshot(1_000, true, '1.0.0'), new AbortController().signal)
      const selected = deferred(); const release = deferred()
      const held = readOpenCodePassiveSnapshot(root, scope, new AbortController().signal, { afterSelected: async () => {
        selected.resolve(); await release.promise
      } })
      await selected.promise
      await new OpenCodePassiveStatusSnapshotWriter({ rootDirectory: root }).write(snapshot(2_000, false, '2.0.0'), new AbortController().signal)
      await maintainOpenCodePassiveStore(root)
      release.resolve()
      expect((await held)?.value.binary.value.version).toBe('1.0.0')

      const paused = deferred(); const resume = deferred()
      const pending = new OpenCodePassiveStatusSnapshotWriter({ rootDirectory: root, safeStorageHooks: {
        afterGenerationDirectoryCreated: async () => { paused.resolve(); await resume.promise },
      } }).write(snapshot(3_000, true, '3.0.0'), new AbortController().signal)
      await paused.promise
      await maintainOpenCodePassiveStore(root)
      resume.resolve(); await pending
      expect((await status(root)).binary.value.version).toBe('3.0.0')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  test('shares machine-global binary evidence across project scopes without merging project providers', async () => {
    const root = await mkdtemp(path.join(process.cwd(), '.passive-sqlite-global-binary-'))
    const otherScope = `sha256:${'9'.repeat(64)}` as const
    try {
      const writer = new OpenCodePassiveStatusSnapshotWriter({ rootDirectory: root })
      await writer.write(snapshot(1_000, true, '1.0.0'), new AbortController().signal)
      await writer.update(scope, 1_000, value => {
        value.providers[0].binaryFingerprint = digest('b')
      }, new AbortController().signal)
      const other = snapshot(1_001, false, '1.0.0')
      other.projectScope = otherScope
      other.providers[0].configured = direct('configured' as const, 'config_metadata', 1_001)
      await writer.write(other, new AbortController().signal)
      await writer.update(scope, 2_000, value => {
        value.binary = direct({ presence: 'present' as const, version: '2.0.0' }, 'binary_metadata', 2_000)
        value.providers[0].binaryFingerprint = digest('e')
      }, new AbortController().signal)

      const observed = await readOpenCodePassiveSnapshot(root, otherScope, new AbortController().signal)
      expect(observed?.value.binary.value.version).toBe('2.0.0')
      expect(observed?.value.providers[0].binaryFingerprint).toBe(digest('e'))
      expect(observed?.value.providers[0].configured.value).toBe('configured')
      expect(observed?.value.providers[0].lastConnected.value.state).toBe('not_connected')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  test('one production read derives binary and provider facts from the same transaction identity', async () => {
    const root = await mkdtemp(path.join(process.cwd(), '.passive-sqlite-coherent-'))
    let published = false
    try {
      await new OpenCodePassiveStatusSnapshotWriter({ rootDirectory: root }).write(snapshot(1_000, true, '1.0.0'), new AbortController().signal)
      const reader = new OpenCodePassiveStatusProductionReader({ rootDirectory: root, now: () => 2_000,
        canonicalizePath: async () => canonical, afterCommittedTransactionSelected: async () => {
          if (published) return
          published = true
          await new OpenCodePassiveStatusSnapshotWriter({ rootDirectory: root }).write(snapshot(2_000, false, '2.0.0'), new AbortController().signal)
        } })
      const held = await reader.reader.read({ projectPath: canonical, providerIds: ['deepinfra'], timeoutMs: 5_000 })
      expect(held.binary.value.version).toBe('1.0.0')
      expect(held.providers[0].lastConnected.value.state).toBe('connected')
      const latest = await status(root)
      expect(latest.binary.value.version).toBe('2.0.0')
      expect(latest.providers[0].lastConnected.value.state).toBe('not_connected')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  test('commit-time retention stays bounded when every scheduled maintenance fails', async () => {
    const root = await mkdtemp(path.join(process.cwd(), '.passive-sqlite-bounded-'))
    let failures = 0
    try {
      const writer = new OpenCodePassiveStatusSnapshotWriter({ rootDirectory: root,
        scheduleMaintenance: operation => operation(), safeStorageHooks: {
          beforeCleanup: () => { throw new Error('checkpoint unavailable') }, cleanupFailed: () => { failures += 1 },
        } })
      for (let index = 1; index <= 40; index += 1) await writer.write(snapshot(index, index % 2 === 0, `${index}.0.0`), new AbortController().signal)
      await Promise.resolve()
      expect(failures).toBe(40)
      const db = new Database(openCodePassiveDatabasePath(root), { readonly: true })
      try { expect(db.query<{ count: number }, []>('SELECT count(*) AS count FROM passive_transactions').get()!.count).toBe(2) }
      finally { db.close(false) }
      expect((await readdir(root)).filter(name => name.startsWith(OPEN_CODE_PASSIVE_DATABASE)).length).toBeLessThanOrEqual(4)
    } finally { await rm(root, { recursive: true, force: true }) }
  }, 30_000)
})
