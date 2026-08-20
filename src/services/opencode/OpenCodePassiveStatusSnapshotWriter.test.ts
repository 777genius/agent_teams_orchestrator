import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { OpenCodeActiveStatusSnapshotPublisher } from './OpenCodeActiveStatusSnapshotPublisher.js'
import { openCodePassiveDatabasePath } from './OpenCodePassiveSnapshotStore.js'
import { OpenCodePassiveStatusSnapshotWriter } from './OpenCodePassiveStatusSnapshotWriter.js'
import type { OpenCodeRedactedSnapshotV1 } from './OpenCodeRedactedStatusSnapshot.js'

const scope = `sha256:${createHash('sha256').update('writer').digest('hex')}` as const
const observation = <T>(value: T, authority: any, evidenceGeneration?: number) => ({ value, authority,
  freshness: 'fresh' as const, condition: 'normal' as const, observedAt: 1, validUntil: 300_001,
  issueCode: 'none' as const, ...(evidenceGeneration === undefined ? {} : { evidenceGeneration }) })
const unknown = <T>(value: T) => ({ value, authority: 'none' as const, freshness: 'unknown' as const,
  condition: 'degraded' as const, observedAt: null, validUntil: null, issueCode: 'unknown' as const })
function snapshot(): OpenCodeRedactedSnapshotV1 { return { schemaVersion: 1, projectScope: scope, capturedAt: 1,
  binary: observation({ presence: 'present' as const, version: '1.0.0' }, 'binary_metadata', 999),
  providers: [{ providerId: 'deepinfra', configured: observation('configured', 'config_metadata', 999),
    lastConnected: unknown({ state: 'unknown' }), catalogAvailable: unknown('unknown'), executionVerified: unknown('unknown') }] } }

describe('OpenCode passive transaction writer boundary', () => {
  test('rejects native Windows capability before any injected storage I/O', async () => {
    let touched = false
    const writer = new OpenCodePassiveStatusSnapshotWriter({ platform: 'win32', rootDirectory: 'C:\\forbidden',
      makeDirectory: async () => { touched = true }, writeAtomic: async () => { touched = true } })
    await expect(writer.write(snapshot(), new AbortController().signal)).rejects.toThrow('unavailable on this platform')
    expect(touched).toBe(false)
  })

  test('rejects database and sidecar symlinks instead of following them', async () => {
    if (process.platform === 'win32') return
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      const root = await mkdtemp(path.join(process.cwd(), '.passive-sqlite-link-'))
      const outside = path.join(root, 'outside')
      try {
        await writeFile(outside, '')
        await symlink(outside, `${openCodePassiveDatabasePath(root)}${suffix}`)
        await expect(new OpenCodePassiveStatusSnapshotWriter({ rootDirectory: root })
          .write(snapshot(), new AbortController().signal)).rejects.toThrow('unsafe')
      } finally { await rm(root, { recursive: true, force: true }) }
    }
  })

  test('fails closed on an existing foreign schema without migrating or deleting it', async () => {
    const root = await mkdtemp(path.join(process.cwd(), '.passive-sqlite-schema-'))
    try {
      await mkdir(root, { recursive: true })
      const databasePath = openCodePassiveDatabasePath(root)
      const database = new Database(databasePath)
      try { database.exec('CREATE TABLE foreign_authority(secret TEXT); INSERT INTO foreign_authority VALUES (\'retained\')') }
      finally { database.close(false) }
      await chmod(databasePath, 0o600)
      await expect(new OpenCodePassiveStatusSnapshotWriter({ rootDirectory: root })
        .write(snapshot(), new AbortController().signal)).rejects.toThrow('schema is invalid')
      const retained = new Database(databasePath, { readonly: true })
      try { expect(retained.query<{ secret: string }, []>('SELECT secret FROM foreign_authority').get()?.secret).toBe('retained') }
      finally { retained.close(false) }
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  test('publisher omits cross-provider catalog refs from the durable transaction', async () => {
    const root = await mkdtemp(path.join(process.cwd(), '.passive-sqlite-owner-'))
    const publisher = new OpenCodeActiveStatusSnapshotPublisher({ rootDirectory: root,
      canonicalizePath: async () => '/canonical', now: () => 1 })
    try {
      await publisher.publishCatalogResult({ projectPath: '/p', catalogAvailable: true,
        modelIds: ['openai/gpt-5', 'deepinfra/llama'], evidence: {
          providerId: 'deepinfra', requestGeneration: 1, startedAt: 1,
          attemptIdentity: `sha256:${'a'.repeat(64)}`,
          binaryFingerprint: `sha256:${'b'.repeat(64)}`,
          configFingerprint: `sha256:${'c'.repeat(64)}`,
          authFingerprint: `sha256:${'d'.repeat(64)}`,
        } })
      const database = new Database(openCodePassiveDatabasePath(root), { readonly: true })
      try {
        const payload = database.query<{ payload: string }, []>('SELECT payload FROM passive_transactions ORDER BY id DESC LIMIT 1').get()!.payload
        expect(payload).toContain('deepinfra/llama')
        expect(payload).not.toContain('openai/gpt-5')
      } finally { database.close(false) }
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  test('mutation callers cannot supply durable evidence generations', async () => {
    const root = await mkdtemp(path.join(process.cwd(), '.passive-sqlite-forged-mutation-'))
    try {
      const writer = new OpenCodePassiveStatusSnapshotWriter({ rootDirectory: root })
      await expect(writer.mutate({ projectScope: scope, capturedAt: 1,
        binary: observation({ presence: 'present' as const, version: '1.0.0' }, 'binary_metadata', Number.MAX_SAFE_INTEGER),
      }, new AbortController().signal)).rejects.toThrow('cannot supply durable authority')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  test('first initialization durably syncs created ancestors before publication', async () => {
    if (process.platform === 'win32') return
    const parent = await mkdtemp(path.join(process.cwd(), '.passive-sqlite-init-'))
    const root = path.join(parent, 'new', 'nested', 'store')
    const order: string[] = []
    try {
      await new OpenCodePassiveStatusSnapshotWriter({ rootDirectory: root, safeStorageHooks: {
        ancestorDirectorySynced: directory => { order.push(path.basename(directory)) },
        afterTransactionMarker: () => { order.push('DATABASE_DURABLE') },
        afterCommitPublished: () => { order.push('COMMIT') },
      } }).write(snapshot(), new AbortController().signal)
      expect(order).toEqual(['new', 'nested', 'store', 'DATABASE_DURABLE', 'COMMIT'])
    } finally { await rm(parent, { recursive: true, force: true }) }
  })
})
