import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import path from 'node:path'

import {
  openCodePassiveDatabasePath,
} from './OpenCodePassiveSnapshotStore.js'
import { OpenCodePassiveStatusProductionReader } from './OpenCodePassiveStatusProductionReader.js'
import { OpenCodePassiveStatusSnapshotWriter } from './OpenCodePassiveStatusSnapshotWriter.js'
import { allocateOpenCodeProviderCatalogAttempt } from './OpenCodeProviderCatalogService.js'
import type { OpenCodeRedactedSnapshotV1 } from './OpenCodeRedactedStatusSnapshot.js'

const canonical = '/canonical/transactional-isolation'
const scope = `sha256:${createHash('sha256').update('opencode-project-scope-v1\0').update(canonical).digest('hex')}` as const
const observed = <T>(value: T, authority: any) => ({ value, authority,
  freshness: 'fresh' as const, condition: 'normal' as const, observedAt: 1_000,
  validUntil: 301_000, issueCode: 'none' as const })
const unknown = <T>(value: T) => ({ value, authority: 'none' as const,
  freshness: 'unknown' as const, condition: 'degraded' as const, observedAt: null,
  validUntil: null, issueCode: 'unknown' as const })

function snapshot(): OpenCodeRedactedSnapshotV1 {
  return { schemaVersion: 1, projectScope: scope, capturedAt: 1_000,
    binary: observed({ presence: 'present' as const, version: '1.2.3' }, 'binary_metadata'),
    providers: [{ providerId: 'deepinfra', configured: observed('configured' as const, 'config_metadata'),
      lastConnected: observed({ state: 'connected' as const, at: 1_000 }, 'auth_metadata'),
      catalogAvailable: unknown('unknown'), executionVerified: unknown('unknown') }] }
}

describe('OpenCode transactional storage integration isolation', () => {
  test('missing passive status creates no filesystem artifacts', async () => {
    const parent = await mkdtemp(path.join(process.cwd(), '.passive-missing-zero-write-'))
    const root = path.join(parent, 'not-created', 'passive-status')
    try {
      const before = await readdir(parent)
      const status = await new OpenCodePassiveStatusProductionReader({ rootDirectory: root,
        now: () => 1_000, canonicalizePath: async () => canonical }).reader.read({
          projectPath: canonical, providerIds: ['deepinfra'], timeoutMs: 1_000,
        })
      expect(status.binary.value.presence).toBe('unknown')
      expect(status.providers[0].configured.value).toBe('unknown')
      expect(await readdir(parent)).toEqual(before)
    } finally { await rm(parent, { recursive: true, force: true }) }
  })

  test('existing passive read is coherent and catalog allocation cannot touch or lock its database', async () => {
    const parent = await mkdtemp(path.join(process.cwd(), '.transactional-store-isolation-'))
    const dataHome = path.join(parent, 'data')
    const cacheHome = path.join(parent, 'cache')
    const passiveRoot = path.join(dataHome, 'opencode', 'passive-status', 'v1')
    const previousData = process.env.CLAUDE_MULTIMODEL_DATA_HOME
    const previousCache = process.env.CLAUDE_MULTIMODEL_CACHE_HOME
    process.env.CLAUDE_MULTIMODEL_DATA_HOME = dataHome
    process.env.CLAUDE_MULTIMODEL_CACHE_HOME = cacheHome
    try {
      await new OpenCodePassiveStatusSnapshotWriter({ rootDirectory: passiveRoot,
        scheduleMaintenance: () => undefined }).write(snapshot(), new AbortController().signal)
      const passivePath = openCodePassiveDatabasePath(passiveRoot)
      const before = new Database(passivePath, { readonly: true })
      const durableBefore = before.query<{ count: number; payload: string }, []>(
        'SELECT count(*) AS count, (SELECT payload FROM passive_transactions ORDER BY id DESC LIMIT 1) AS payload FROM passive_transactions',
      ).get()!
      before.close(false)

      const allocation = allocateOpenCodeProviderCatalogAttempt(`${canonical}\0deepinfra`, 1_000)
      expect(allocation.requestGeneration).toBeGreaterThan(0)
      const catalogPath = path.join(cacheHome, 'opencode', 'provider-catalog-attempts-v2', 'attempts.sqlite')
      expect(catalogPath).not.toBe(passivePath)
      const catalog = new Database(catalogPath)
      catalog.exec('BEGIN EXCLUSIVE')
      try {
        const status = await new OpenCodePassiveStatusProductionReader({ rootDirectory: passiveRoot,
          now: () => 2_000, canonicalizePath: async () => canonical }).reader.read({
            projectPath: canonical, providerIds: ['deepinfra'], timeoutMs: 1_000,
          })
        expect([status.binary.value.version, status.providers[0].lastConnected.value.state])
          .toEqual(['1.2.3', 'connected'])
      } finally { catalog.exec('ROLLBACK'); catalog.close(false) }

      const after = new Database(passivePath, { readonly: true })
      try {
        expect(after.query<{ count: number; payload: string }, []>(
          'SELECT count(*) AS count, (SELECT payload FROM passive_transactions ORDER BY id DESC LIMIT 1) AS payload FROM passive_transactions',
        ).get()).toEqual(durableBefore)
      } finally { after.close(false) }
    } finally {
      if (previousData === undefined) delete process.env.CLAUDE_MULTIMODEL_DATA_HOME
      else process.env.CLAUDE_MULTIMODEL_DATA_HOME = previousData
      if (previousCache === undefined) delete process.env.CLAUDE_MULTIMODEL_CACHE_HOME
      else process.env.CLAUDE_MULTIMODEL_CACHE_HOME = previousCache
      await rm(parent, { recursive: true, force: true })
    }
  })

  test('catalog allocator rejects a foreign schema without adopting its authority', async () => {
    const parent = await mkdtemp(path.join(process.cwd(), '.catalog-schema-isolation-'))
    const previous = process.env.CLAUDE_MULTIMODEL_CACHE_HOME
    process.env.CLAUDE_MULTIMODEL_CACHE_HOME = parent
    try {
      const root = path.join(parent, 'opencode', 'provider-catalog-attempts-v2')
      await mkdir(root, { recursive: true, mode: 0o700 })
      const databasePath = path.join(root, 'attempts.sqlite')
      const database = new Database(databasePath)
      try { database.exec('CREATE TABLE foreign_allocator(value INTEGER); INSERT INTO foreign_allocator VALUES (443)') }
      finally { database.close(false) }
      await chmod(databasePath, 0o600)
      expect(() => allocateOpenCodeProviderCatalogAttempt('foreign-schema', 1_000)).toThrow('temporarily unavailable')
      const retained = new Database(databasePath, { readonly: true })
      try { expect(retained.query<{ value: number }, []>('SELECT value FROM foreign_allocator').get()?.value).toBe(443) }
      finally { retained.close(false) }
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_MULTIMODEL_CACHE_HOME
      else process.env.CLAUDE_MULTIMODEL_CACHE_HOME = previous
      await rm(parent, { recursive: true, force: true })
    }
  })
})
