import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import path from 'node:path'

import { OpenCodeActiveStatusSnapshotPublisher } from './OpenCodeActiveStatusSnapshotPublisher.js'
import { OpenCodePassiveStatusProductionReader, readBoundedSnapshotText } from './OpenCodePassiveStatusProductionReader.js'
import { OpenCodePassiveStatusSnapshotWriter } from './OpenCodePassiveStatusSnapshotWriter.js'
import type { OpenCodeRedactedSnapshotV1 } from './OpenCodeRedactedStatusSnapshot.js'

const canonical = '/canonical/project'
const scope = `sha256:${createHash('sha256').update('opencode-project-scope-v1\0').update(canonical).digest('hex')}` as const
const observation = <T>(value: T, authority: any, at: number) => ({ value, authority,
  freshness: 'fresh' as const, condition: 'normal' as const, observedAt: at,
  validUntil: at + 300_000, issueCode: 'none' as const })
const unknown = <T>(value: T) => ({ value, authority: 'none' as const, freshness: 'unknown' as const,
  condition: 'degraded' as const, observedAt: null, validUntil: null, issueCode: 'unknown' as const })
const digest = (character: string): `sha256:${string}` => `sha256:${character.repeat(64)}`
const catalogEvidence = (generation: number, marker: string) => ({
  providerId: 'deepinfra', requestGeneration: generation, startedAt: 1_000,
  attemptIdentity: digest(marker), binaryFingerprint: digest('b'),
  configFingerprint: digest('c'), authFingerprint: digest('d'),
})

function transaction(at: number, configured: boolean, version: string): OpenCodeRedactedSnapshotV1 {
  return { schemaVersion: 1, projectScope: scope, capturedAt: at,
    binary: observation({ presence: 'present' as const, version }, 'binary_metadata', at),
    providers: [{ providerId: 'deepinfra',
      configured: observation(configured ? 'configured' as const : 'not_configured' as const, 'config_metadata', at),
      lastConnected: unknown({ state: 'unknown' as const }), catalogAvailable: unknown('unknown' as const),
      executionVerified: unknown('unknown' as const) }] }
}

function deferred() {
  let resolve!: () => void
  return { promise: new Promise<void>(done => { resolve = done }), resolve }
}

async function status(root: string, providerIds = ['deepinfra', 'ollama']) {
  return new OpenCodePassiveStatusProductionReader({ rootDirectory: root, now: () => 10_000,
    canonicalizePath: async () => canonical }).reader.read({ projectPath: canonical, providerIds, timeoutMs: 5_000 })
}

describe('OpenCode passive append-only consistency', () => {
  test('separate production publishers preserve independent same-scope facts without a coordinator', async () => {
    const root = await mkdtemp(path.join(process.cwd(), '.passive-consistency-publishers-'))
    try {
      const make = () => new OpenCodeActiveStatusSnapshotPublisher({ rootDirectory: root, now: () => 1_000,
        canonicalizePath: async () => canonical, readSnapshot: async () => null })
      await Promise.all([
        make().publishProviderUpdate({ projectPath: canonical, providerId: 'deepinfra', connected: true }),
        make().publishProviderUpdate({ projectPath: canonical, providerId: 'ollama', configured: true }),
      ])
      const result = await status(root)
      expect(result.providers.find(provider => provider.providerId === 'deepinfra')?.lastConnected.value.state).toBe('connected')
      expect(result.providers.find(provider => provider.providerId === 'ollama')?.configured.value).toBe('configured')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  test('catalog racing an auth mutation cannot publish stale refs or erase execution rejection', async () => {
    const root = await mkdtemp(path.join(process.cwd(), '.passive-consistency-domains-'))
    try {
      const seed = new OpenCodeActiveStatusSnapshotPublisher({ rootDirectory: root, now: () => 1_000,
        canonicalizePath: async () => canonical })
      await seed.publishProviderUpdate({ projectPath: canonical, providerId: 'deepinfra', connected: true })
      await seed.publishExecutionUpdate({ projectPath: canonical, providerId: 'deepinfra', executionVerified: true })
      await seed.publishCatalogResult({ projectPath: canonical, evidence: catalogEvidence(1, 'a'),
        catalogAvailable: true, modelIds: ['deepinfra/old'] })
      const stale = await readBoundedSnapshotText(path.join(root, 'snapshots', `${scope.slice(7)}.json`), new AbortController().signal)
      const make = () => new OpenCodeActiveStatusSnapshotPublisher({ rootDirectory: root, now: () => 1_000,
        canonicalizePath: async () => canonical, readSnapshot: async () => stale })
      await Promise.all([
        make().publishCatalogResult({ projectPath: canonical, evidence: catalogEvidence(2, 'e'),
          catalogAvailable: true, modelIds: ['deepinfra/new'] }),
        (async () => {
          const publisher = make()
          await publisher.publishProviderUpdate({ projectPath: canonical, providerId: 'deepinfra', connected: false })
          await publisher.publishExecutionUpdate({ projectPath: canonical, providerId: 'deepinfra', executionVerified: false })
        })(),
      ])
      const result = await status(root, ['deepinfra'])
      expect(result.providers[0].lastConnected.value.state).toBe('not_connected')
      expect(result.providers[0].executionVerified.value).toBe('rejected')
      expect(result.providers[0].catalogAvailable.value).toBe('available')
      expect(result.providers[0].knownModelIds).toBeUndefined()
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  test('equal and backward clocks plus late completion obey claimed evidence generation', async () => {
    const root = await mkdtemp(path.join(process.cwd(), '.passive-consistency-order-'))
    const claimed = deferred(); const release = deferred()
    try {
      const oldWriter = new OpenCodePassiveStatusSnapshotWriter({ rootDirectory: root, safeStorageHooks: {
        afterGenerationDirectoryCreated: async () => { claimed.resolve(); await release.promise },
      } })
      const oldSnapshot = transaction(2_000, true, '1.0.0')
      oldSnapshot.providers[0].lastConnected = observation(
        { state: 'connected' as const, at: 2_000 }, 'auth_metadata', 2_000,
      )
      oldSnapshot.providers[0].executionVerified = observation('verified' as const, 'execution_snapshot', 2_000)
      const oldUpdate = oldWriter.write(oldSnapshot, new AbortController().signal)
      await claimed.promise
      const newer = new OpenCodeActiveStatusSnapshotPublisher({ rootDirectory: root, now: () => 1_000,
        canonicalizePath: async () => canonical, readSnapshot: async () => null })
      await newer.publishProviderUpdate({ projectPath: canonical, providerId: 'deepinfra', connected: false })
      await newer.publishExecutionUpdate({ projectPath: canonical, providerId: 'deepinfra', executionVerified: false })
      release.resolve(); await oldUpdate
      const frozen = () => new OpenCodeActiveStatusSnapshotPublisher({ rootDirectory: root, now: () => 1_000,
        canonicalizePath: async () => canonical })
      await frozen().publishProviderUpdate({ projectPath: canonical, providerId: 'deepinfra', connected: true })
      await frozen().publishExecutionUpdate({ projectPath: canonical, providerId: 'deepinfra', executionVerified: true })
      await frozen().publishProviderUpdate({ projectPath: canonical, providerId: 'deepinfra', connected: false })
      await frozen().publishExecutionUpdate({ projectPath: canonical, providerId: 'deepinfra', executionVerified: false })
      const result = await status(root, ['deepinfra'])
      expect(result.providers[0].lastConnected.value.state).toBe('not_connected')
      expect(result.providers[0].executionVerified.value).toBe('rejected')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  test('one read uses one selected transaction when publication occurs mid-read', async () => {
    const root = await mkdtemp(path.join(process.cwd(), '.passive-consistency-pair-'))
    let once = false
    try {
      await new OpenCodePassiveStatusSnapshotWriter({ rootDirectory: root })
        .write(transaction(1_000, true, '1.0.0'), new AbortController().signal)
      const reader = new OpenCodePassiveStatusProductionReader({ rootDirectory: root, now: () => 2_000,
        canonicalizePath: async () => canonical, afterCommittedTransactionSelected: async () => {
          if (once) return
          once = true
          await new OpenCodePassiveStatusSnapshotWriter({ rootDirectory: root })
            .write(transaction(2_000, false, '2.0.0'), new AbortController().signal)
        } })
      const selected = await reader.reader.read({ projectPath: canonical, providerIds: ['deepinfra'], timeoutMs: 5_000 })
      expect(selected.binary.value.version).toBe('1.0.0')
      expect(selected.providers[0].configured.value).toBe('configured')
      const latest = await status(root, ['deepinfra'])
      expect(latest.binary.value.version).toBe('2.0.0')
      expect(latest.providers[0].configured.value).toBe('not_configured')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  test('retention is bounded, grace protects selected readers, and cleanup failure is telemetry-only', async () => {
    const root = await mkdtemp(path.join(process.cwd(), '.passive-consistency-retention-'))
    const queued: Array<() => void> = []; let cleanupError = false
    const now = Date.now()
    try {
      const writer = new OpenCodePassiveStatusSnapshotWriter({ rootDirectory: root, now: () => now + 180_000,
        retentionCount: 2, readerGraceMs: 120_001, scheduleMaintenance: operation => queued.push(operation) })
      for (let index = 1; index <= 4; index += 1) {
        await writer.write(transaction(index * 1_000, index % 2 === 0, `${index}.0.0`), new AbortController().signal)
      }
      await writer.maintain(scope)
      const scoped = path.join(root, 'scopes', scope.slice(7))
      expect((await readdir(path.join(scoped, 'commits'))).length).toBe(2)
      expect((await readdir(path.join(scoped, 'generations'))).length).toBe(2)
      expect((await status(root, ['deepinfra'])).binary.value.version).toBe('4.0.0')

      const selected = deferred(); const release = deferred()
      const inFlight = new OpenCodePassiveStatusProductionReader({ rootDirectory: root, now: () => 10_000,
        canonicalizePath: async () => canonical, afterCommittedTransactionSelected: async () => {
          selected.resolve(); await release.promise
        } }).reader.read({ projectPath: canonical, providerIds: ['deepinfra'], timeoutMs: 5_000 })
      await selected.promise
      const graceWriter = new OpenCodePassiveStatusSnapshotWriter({ rootDirectory: root,
        retentionCount: 2, readerGraceMs: 120_001, scheduleMaintenance: () => undefined })
      for (let index = 5; index <= 7; index += 1) {
        await graceWriter.write(transaction(index * 1_000, true, `${index}.0.0`), new AbortController().signal)
      }
      await graceWriter.maintain(scope)
      release.resolve()
      expect((await inFlight).binary.value.version).toBe('4.0.0')
      await writer.maintain(scope)
      expect((await readdir(path.join(scoped, 'commits'))).length).toBe(2)

      const failing = new OpenCodePassiveStatusSnapshotWriter({ rootDirectory: root,
        scheduleMaintenance: operation => operation(), safeStorageHooks: {
          beforeCleanup: () => { throw new Error('cleanup unavailable') }, cleanupFailed: () => { cleanupError = true },
        } })
      await failing.write(transaction(8_000, true, '8.0.0'), new AbortController().signal)
      await Promise.resolve()
      expect(cleanupError).toBe(true)
      expect((await status(root, ['deepinfra'])).binary.value.version).toBe('8.0.0')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  test('first publication fsyncs every created POSIX ancestor before exposing the commit', async () => {
    if (process.platform === 'win32') return
    const parent = await mkdtemp(path.join(process.cwd(), '.passive-consistency-fsync-'))
    const root = path.join(parent, 'new', 'ancestry', 'store')
    const order: string[] = []
    try {
      await new OpenCodePassiveStatusSnapshotWriter({ rootDirectory: root, safeStorageHooks: {
        ancestorDirectorySynced: directory => {
          const name = path.basename(directory)
          order.push(/^[0-9]{16}\./.test(name) ? 'GENERATION' : name)
        },
        afterCommitPublished: () => { order.push('COMMIT') },
      } }).write(transaction(1_000, true, '1.0.0'), new AbortController().signal)
      expect(order).toEqual(['new', 'ancestry', 'store', 'scopes', scope.slice(7), 'generations', 'commits',
        'GENERATION', 'COMMIT'])
    } finally { await rm(parent, { recursive: true, force: true }) }
  })
})
