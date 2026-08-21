import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { lstatSync } from 'node:fs'
import { chmod, lstat, opendir, readFile } from 'node:fs/promises'
import path from 'node:path'

import {
  decodeOpenCodeRedactedSnapshotV1,
  encodeOpenCodeRedactedSnapshotV1,
  OPEN_CODE_REDACTED_SNAPSHOT_MAX_BYTES,
  type OpenCodeRedactedProviderMutation,
  type OpenCodeRedactedSnapshotMutation,
  type OpenCodeRedactedSnapshotProviderV1,
  type OpenCodeRedactedSnapshotV1,
} from './OpenCodeRedactedStatusSnapshot.js'
import { parseOpenCodeExactProviderModelRef } from './OpenCodeProviderIdentity.js'
import { isOpenCodeCanonicalProviderId } from './OpenCodePassiveStatusContract.js'
import {
  decodeOpenCodePassiveSnapshotCommit,
  OPEN_CODE_PASSIVE_COMMIT_NAME_PATTERN,
  OPEN_CODE_PASSIVE_COMMIT_TEMP_PATTERN,
  OPEN_CODE_PASSIVE_COMMITS,
  OPEN_CODE_PASSIVE_GENERATION_BINARY,
  OPEN_CODE_PASSIVE_GENERATION_PROJECT,
  OPEN_CODE_PASSIVE_GENERATIONS,
  OPEN_CODE_PASSIVE_TRANSACTION_MARKER,
  OPEN_CODE_PASSIVE_TRANSACTION_MARKER_CONTENT,
} from './OpenCodePassiveSnapshotTransaction.js'
import { ensureOpenCodeSafePublicationDirectory } from './OpenCodeSafePublication.js'

export const OPEN_CODE_PASSIVE_DATABASE = 'passive-status.sqlite3'
const SCHEMA_VERSION = 1
const HISTORY_PER_SCOPE = 2
const LEGACY_SCAN_LIMIT = 128
const GLOBAL_SCOPE_LIMIT = 128
// Deployed v1/v2 generations were millisecond timestamps. A fixed fence makes
// an imported or rejected legacy store subordinate without trusting its clock.
const LEGACY_GENERATION_FENCE = 1_000_000_000_000_000

type StoreHooks = Readonly<{
  afterRootOpened?: () => void | Promise<void>
  afterTransactionMarker?: () => void | Promise<void>
  afterGenerationDirectoryCreated?: () => void | Promise<void>
  afterProjectSnapshotPublished?: () => void | Promise<void>
  afterBinarySnapshotPublished?: () => void | Promise<void>
  afterGenerationParentSynced?: () => void | Promise<void>
  beforeCommitPublished?: () => void | Promise<void>
  afterCommitPublished?: () => void | Promise<void>
  ancestorDirectorySynced?: (directory: string) => void | Promise<void>
}>

type StoreOptions = Readonly<{
  rootDirectory: string
  platform?: NodeJS.Platform
  hooks?: StoreHooks
}>

type SnapshotRow = { transactionId: number; payload: string }
type GlobalBinaryEvidence = Readonly<{
  binary: OpenCodeRedactedSnapshotV1['binary']
  fingerprint: `sha256:${string}` | null
}>
type LegacyEvidence = Readonly<{ rank: number; sequence: number; fingerprint: string }>
type LegacyProvenance = Record<string, LegacyEvidence>
type LegacyRead =
  | Readonly<{ kind: 'valid'; fingerprint: string; snapshot: OpenCodeRedactedSnapshotV1 | null; provenance: LegacyProvenance }>
  | Readonly<{ kind: 'invalid' }>

export function openCodePassiveDatabasePath(rootDirectory: string): string {
  return path.join(rootDirectory, OPEN_CODE_PASSIVE_DATABASE)
}

export async function openCodePassiveDatabaseExists(rootDirectory: string): Promise<boolean> {
  try {
    await lstat(openCodePassiveDatabasePath(rootDirectory))
    return true
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
}

export async function mutateOpenCodePassiveSnapshot(
  options: StoreOptions,
  mutation: OpenCodeRedactedSnapshotMutation,
  signal: AbortSignal,
): Promise<number> {
  validateMutation(mutation)
  return commitOpenCodePassiveSnapshot(
    options,
    mutation.projectScope,
    mutation.capturedAt,
    base => applyMutation(base, mutation),
    mutation,
    signal,
  )
}

export async function updateOpenCodePassiveSnapshot(
  options: StoreOptions,
  projectScope: `sha256:${string}`,
  capturedAt: number,
  mutate: (snapshot: OpenCodeRedactedSnapshotV1) => void,
  signal: AbortSignal,
): Promise<number> {
  if (!/^sha256:[0-9a-f]{64}$/.test(projectScope)
    || !Number.isSafeInteger(capturedAt) || capturedAt < 0) throw new TypeError('Invalid passive update')
  return commitOpenCodePassiveSnapshot(options, projectScope, capturedAt, snapshot => {
    const next = structuredClone(snapshot)
    next.capturedAt = Math.max(next.capturedAt, capturedAt)
    ageExpired(next, next.capturedAt)
    mutate(next)
    next.providers.sort((left, right) => left.providerId.localeCompare(right.providerId))
    return next
  }, undefined, signal)
}

async function commitOpenCodePassiveSnapshot(
  options: StoreOptions,
  projectScope: `sha256:${string}`,
  capturedAt: number,
  produce: (base: OpenCodeRedactedSnapshotV1) => OpenCodeRedactedSnapshotV1,
  mutation: OpenCodeRedactedSnapshotMutation | undefined,
  signal: AbortSignal,
): Promise<number> {
  rejectUnsupportedPlatform(options.platform)
  if (signal.aborted) throw cancelled()
  const root = await ensureOpenCodeSafePublicationDirectory(
    options.rootDirectory, true, options.hooks?.ancestorDirectorySynced,
  )
  let database: Database | null = null
  try {
    await options.hooks?.afterRootOpened?.()
    if (!await openCodePassiveDatabaseExists(options.rootDirectory)) {
      try { await root.publishImmutableFile(OPEN_CODE_PASSIVE_DATABASE, '', 0o600) }
      catch { /* a racing owner may have published the same managed file */ }
    }
    await assertSafeDatabaseArtifacts(options.rootDirectory, true, options.platform)
    database = openDatabase(options.rootDirectory, false)
    await ensureDatabaseReady(database, signal)
    await protectDatabaseArtifacts(options.rootDirectory, options.platform)
    await root.sync()
    await options.hooks?.afterTransactionMarker?.()
    await beginImmediate(database, signal)
    try {
      const previous = readCurrent(database, projectScope)
      let base = previous ? decodeDurable(previous.payload, previous.transactionId, projectScope) : null
      // A malformed committed value invalidates the scope. It must never be
      // merged into a later mutation or retain launch-adjacent authority.
      if (previous && !base) deleteScope(database, projectScope)
      const reconciled = await reconcileLegacy(database, options.rootDirectory, projectScope, base)
      const globalBinary = readGlobalBinary(database)
      base = withGlobalBinary(reconciled.snapshot, globalBinary)
      const logicalTime = Math.max(base?.capturedAt ?? 0, capturedAt)
      const normalized = mutation ? normalizeMutationTime(mutation, logicalTime) : undefined
      const initial = base ?? emptySnapshot(projectScope, logicalTime)
      const next = normalized ? applyMutation(initial, normalized) : produce(initial)
      database.query('INSERT INTO passive_transactions(scope, payload) VALUES (?, ?)')
        .run(projectScope, '')
      const id = Number(database.query<{ id: number }, []>('SELECT last_insert_rowid() AS id').get()!.id)
      if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Passive transaction generation exhausted')
      await options.hooks?.afterGenerationDirectoryCreated?.()
      if (signal.aborted) throw cancelled()
      const changedDomains = normalized ? mutationDomains(normalized, next) : snapshotDomains(next)
      assignChangedGenerations(next, id, new Set([...reconciled.changedDomains, ...changedDomains]))
      const encoded = encodeOpenCodeRedactedSnapshotV1(next)
      if (!encoded.ok || !encoded.bytes) throw new TypeError(`Passive snapshot mutation is invalid: ${encoded.issueCode}`)
      const payload = new TextDecoder('utf-8', { fatal: true }).decode(encoded.bytes)
      if (!decodeDurable(payload, id, projectScope)) throw new TypeError('Passive snapshot authority is invalid')
      await options.hooks?.afterProjectSnapshotPublished?.()
      if (signal.aborted) throw cancelled()
      await options.hooks?.afterBinarySnapshotPublished?.()
      if (signal.aborted) throw cancelled()
      database.query('UPDATE passive_transactions SET payload = ? WHERE id = ?').run(payload, id)
      const fingerprints = [...new Set(next.providers.map(provider => provider.binaryFingerprint).filter(Boolean))]
      const nextGlobalBinary: GlobalBinaryEvidence = {
        binary: next.binary,
        fingerprint: fingerprints.length === 1 ? fingerprints[0]! : globalBinary?.fingerprint ?? null,
      }
      if (!globalBinary || JSON.stringify(globalBinary) !== JSON.stringify(nextGlobalBinary)) {
        database.query(`INSERT INTO passive_global_binary(singleton, payload, transaction_id) VALUES (1, ?, ?)
          ON CONFLICT(singleton) DO UPDATE SET payload = excluded.payload,
          transaction_id = excluded.transaction_id`).run(JSON.stringify(nextGlobalBinary), id)
      }
      database.query(`INSERT INTO passive_current(scope, transaction_id) VALUES (?, ?)
        ON CONFLICT(scope) DO UPDATE SET transaction_id = excluded.transaction_id`).run(projectScope, id)
      database.query(`DELETE FROM passive_transactions WHERE scope = ? AND id NOT IN
        (SELECT id FROM passive_transactions WHERE scope = ? ORDER BY id DESC LIMIT ?)`)
      .run(projectScope, projectScope, HISTORY_PER_SCOPE)
      enforceGlobalBounds(database, projectScope)
      await options.hooks?.afterGenerationParentSynced?.()
      if (signal.aborted) throw cancelled()
      await options.hooks?.beforeCommitPublished?.()
      database.exec('COMMIT')
      await options.hooks?.afterCommitPublished?.()
      return id
    } catch (error) {
      rollback(database)
      throw error
    }
  } finally { database?.close(false); await root.close() }
}

export async function replaceOpenCodePassiveSnapshot(
  options: StoreOptions,
  snapshot: OpenCodeRedactedSnapshotV1,
  signal: AbortSignal,
): Promise<number> {
  const encoded = encodeOpenCodeRedactedSnapshotV1(snapshot)
  if (!encoded.ok) throw new TypeError('Passive snapshot is not a bounded redacted snapshot')
  const providers: OpenCodeRedactedProviderMutation[] = encoded.value.providers.map(provider => ({
    providerId: provider.providerId,
    configured: withoutGeneration(provider.configured),
    lastConnected: withoutGeneration(provider.lastConnected),
    catalog: { available: withoutGeneration(provider.catalogAvailable), ...(provider.modelIds ? { modelIds: provider.modelIds } : {}) },
    executionVerified: withoutGeneration(provider.executionVerified),
  }))
  return mutateOpenCodePassiveSnapshot(options, {
    projectScope: encoded.value.projectScope,
    capturedAt: encoded.value.capturedAt,
    binary: withoutGeneration(encoded.value.binary),
    providers,
  }, signal)
}

export async function readOpenCodePassiveSnapshot(
  rootDirectory: string,
  scope: `sha256:${string}`,
  signal: AbortSignal,
  options: { platform?: NodeJS.Platform; afterSelected?: () => void | Promise<void> } = {},
): Promise<{ transactionId: number; text: string; value: OpenCodeRedactedSnapshotV1 } | null> {
  rejectUnsupportedPlatform(options.platform)
  if (signal.aborted) throw cancelled()
  await assertSafeDatabaseArtifacts(rootDirectory, true, options.platform)
  const database = openDatabase(rootDirectory, true)
  try {
    verifySchema(database)
    database.exec('BEGIN')
    try {
      const legacyCapturedAt = await matchingLegacyCapturedAt(database, rootDirectory, scope)
      if (legacyCapturedAt === null) {
        database.exec('COMMIT')
        return null
      }
      const row = readCurrent(database, scope)
      if (!row) { database.exec('COMMIT'); return null }
      // SQLite has copied the selected row into owned JS memory while the read
      // transaction pins its version. Retention can now proceed independently.
      await options.afterSelected?.()
      if (signal.aborted) throw cancelled()
      let value = withGlobalBinary(decodeDurable(row.payload, row.transactionId, scope), readGlobalBinary(database))
      if (value && legacyCapturedAt !== undefined && value.capturedAt < legacyCapturedAt) {
        value = { ...value, capturedAt: legacyCapturedAt }
      }
      const encoded = value && encodeOpenCodeRedactedSnapshotV1(value)
      const text = encoded && encoded.ok && encoded.bytes
        ? new TextDecoder('utf-8', { fatal: true }).decode(encoded.bytes)
        : null
      if (text === null) value = null
      database.exec('COMMIT')
      return value && text ? { transactionId: row.transactionId, text, value } : null
    } catch (error) { rollback(database); throw error }
  } finally { database.close(false) }
}

export async function maintainOpenCodePassiveStore(rootDirectory: string, platform?: NodeJS.Platform): Promise<void> {
  rejectUnsupportedPlatform(platform)
  if (!await openCodePassiveDatabaseExists(rootDirectory)) return
  await assertSafeDatabaseArtifacts(rootDirectory, true, platform)
  const database = openDatabase(rootDirectory, false)
  try { verifySchema(database); database.exec('PRAGMA wal_checkpoint(PASSIVE)') }
  finally { database.close(false) }
}

function openDatabase(rootDirectory: string, readonly: boolean): Database {
  const databasePath = openCodePassiveDatabasePath(rootDirectory)
  const database = new Database(databasePath, readonly ? { readonly: true, strict: true } : { create: true, strict: true })
  database.exec('PRAGMA busy_timeout = 0')
  return database
}

function initializeSchema(database: Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS passive_meta (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      schema_version INTEGER NOT NULL,
      legacy_migrated INTEGER NOT NULL CHECK(legacy_migrated IN (0, 1)),
      journal_ready INTEGER NOT NULL CHECK(journal_ready IN (0, 1))
    );
    INSERT OR IGNORE INTO passive_meta VALUES (1, ${SCHEMA_VERSION}, 0, 0);
    CREATE TABLE IF NOT EXISTS passive_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS passive_transactions_scope_id ON passive_transactions(scope, id DESC);
    CREATE TABLE IF NOT EXISTS passive_current (
      scope TEXT PRIMARY KEY,
      transaction_id INTEGER NOT NULL UNIQUE REFERENCES passive_transactions(id)
    );
    CREATE TABLE IF NOT EXISTS passive_migrations (
      scope TEXT PRIMARY KEY
    );
    CREATE TABLE IF NOT EXISTS passive_legacy_state (
      scope TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL,
      provenance TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS passive_global_binary (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      payload TEXT NOT NULL,
      transaction_id INTEGER NOT NULL
    );
  `)
  verifySchema(database)
}

async function ensureDatabaseReady(database: Database, signal: AbortSignal): Promise<void> {
  let incompleteSchemaObservations = 0
  for (;;) {
    if (signal.aborted) throw cancelled()
    try {
      const ready = database.query<{ schemaVersion: number; journalReady: number }, []>(
        'SELECT schema_version AS schemaVersion, journal_ready AS journalReady FROM passive_meta WHERE singleton = 1',
      ).get()
      if (ready?.schemaVersion !== SCHEMA_VERSION) throw new Error('Passive snapshot store schema is invalid')
      if (ready.journalReady === 1) {
        const supplemental = database.query<{ count: number }, []>(`SELECT count(*) AS count FROM sqlite_master
          WHERE type = 'table' AND name IN ('passive_legacy_state', 'passive_global_binary')`).get()
        if (supplemental?.count === 2) return
        await beginImmediate(database, signal)
        try {
          database.exec(`CREATE TABLE IF NOT EXISTS passive_legacy_state (
            scope TEXT PRIMARY KEY,
            fingerprint TEXT NOT NULL,
            provenance TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS passive_global_binary (
            singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
            payload TEXT NOT NULL,
            transaction_id INTEGER NOT NULL
          )`)
          database.exec('COMMIT')
          return
        } catch (error) {
          rollback(database)
          if (!isBusy(error)) throw error
          await new Promise<void>(resolve => setImmediate(resolve))
          continue
        }
      }
    } catch (error) {
      if (!isBusy(error) && !(error instanceof Error && /no such table/i.test(error.message))) throw error
      if (isBusy(error)) { await new Promise<void>(resolve => setImmediate(resolve)); continue }
      let existingTables: number | undefined
      try {
        existingTables = database.query<{ count: number }, []>(
          "SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
        ).get()?.count
      } catch (schemaError) {
        if (!isBusy(schemaError)) throw schemaError
        await new Promise<void>(resolve => setImmediate(resolve))
        continue
      }
      if (existingTables !== 0) {
        // Another process can expose the newly created SQLite file before its
        // first EXCLUSIVE schema transaction is observable on this connection.
        // Retry only a bounded number of event-loop turns; stable partial or
        // foreign schemas still fail closed.
        incompleteSchemaObservations += 1
        if (incompleteSchemaObservations > 256) throw new Error('Passive snapshot store schema is invalid')
        await new Promise<void>(resolve => setImmediate(resolve))
        continue
      }
      await beginTransaction(database, signal, 'EXCLUSIVE')
      try { initializeSchema(database); database.exec('COMMIT') }
      catch (initializationError) { rollback(database); if (!isBusy(initializationError)) throw initializationError }
      continue
    }
    try {
      database.exec('PRAGMA journal_mode = WAL')
      database.exec('PRAGMA synchronous = FULL')
      await beginImmediate(database, signal)
      database.exec('UPDATE passive_meta SET journal_ready = 1 WHERE singleton = 1')
      database.exec('COMMIT')
    } catch (error) {
      rollback(database)
      if (!isBusy(error)) throw error
      await new Promise<void>(resolve => setImmediate(resolve))
    }
  }
}

function verifySchema(database: Database): void {
  const row = database.query<{ schemaVersion: number }, []>(
    'SELECT schema_version AS schemaVersion FROM passive_meta WHERE singleton = 1',
  ).get()
  if (!row || row.schemaVersion !== SCHEMA_VERSION) throw new Error('Passive snapshot store schema is invalid')
}

async function beginImmediate(database: Database, signal: AbortSignal): Promise<void> {
  return beginTransaction(database, signal, 'IMMEDIATE')
}

async function beginTransaction(database: Database, signal: AbortSignal, mode: 'IMMEDIATE' | 'EXCLUSIVE'): Promise<void> {
  for (;;) {
    if (signal.aborted) throw cancelled()
    try { database.exec(`BEGIN ${mode}`); return }
    catch (error) {
      if (!isBusy(error)) throw error
      await new Promise<void>(resolve => setImmediate(resolve))
    }
  }
}

function readCurrent(database: Database, scope: string): SnapshotRow | null {
  return database.query<SnapshotRow, [string]>(`SELECT t.id AS transactionId, t.payload
    FROM passive_current c JOIN passive_transactions t ON t.id = c.transaction_id
    WHERE c.scope = ?`).get(scope)
}

function readGlobalBinary(database: Database): GlobalBinaryEvidence | null {
  let row: { payload: string; transactionId: number } | null
  try {
    row = database.query<{ payload: string; transactionId: number }, []>(
      'SELECT payload, transaction_id AS transactionId FROM passive_global_binary WHERE singleton = 1',
    ).get()
  } catch (error) {
    if (error instanceof Error && /no such table/i.test(error.message)) return null
    throw error
  }
  if (!row || !Number.isSafeInteger(row.transactionId) || row.transactionId <= 0) return null
  try {
    const parsed = JSON.parse(row.payload) as Partial<GlobalBinaryEvidence> & OpenCodeRedactedSnapshotV1['binary']
    const binary = parsed.binary ?? parsed
    const fingerprint = parsed.binary === undefined ? null : parsed.fingerprint
    if (fingerprint !== null && fingerprint !== undefined && !/^sha256:[0-9a-f]{64}$/.test(fingerprint)) return null
    const capturedAt = typeof binary?.observedAt === 'number' && Number.isSafeInteger(binary.observedAt)
      ? Math.max(0, binary.observedAt)
      : 0
    const encoded = encodeOpenCodeRedactedSnapshotV1({
      schemaVersion: 1,
      projectScope: `sha256:${'0'.repeat(64)}`,
      capturedAt,
      binary,
      providers: [],
    })
    return encoded.ok ? {
      binary: structuredClone(encoded.value.binary),
      fingerprint: fingerprint ?? null,
    } : null
  } catch { return null }
}

function withGlobalBinary(
  snapshot: OpenCodeRedactedSnapshotV1 | null,
  evidence: GlobalBinaryEvidence | null,
): OpenCodeRedactedSnapshotV1 | null {
  if (!snapshot || !evidence) return snapshot
  const providers = structuredClone(snapshot.providers)
  if (evidence.fingerprint) for (const provider of providers) {
    if (provider.catalogBinaryFingerprint
      && provider.catalogBinaryFingerprint !== evidence.fingerprint) {
      provider.catalogFenceGeneration = Math.min(Number.MAX_SAFE_INTEGER,
        Math.max(provider.catalogFenceGeneration ?? 0, provider.catalogRequestGeneration ?? 0, 1))
      delete provider.catalogIdentity
      delete provider.catalogAttemptIdentity
      delete provider.catalogRequestGeneration
      delete provider.catalogStartedAt
      delete provider.catalogBinaryFingerprint
      delete provider.catalogConfigFingerprint
      delete provider.catalogAuthFingerprint
    }
    provider.binaryFingerprint = evidence.fingerprint
  }
  return {
    ...snapshot,
    binary: structuredClone(evidence.binary),
    providers,
    capturedAt: Math.max(snapshot.capturedAt, evidence.binary.observedAt ?? 0),
  }
}

function deleteScope(database: Database, scope: string): void {
  database.query('DELETE FROM passive_current WHERE scope = ?').run(scope)
  database.query('DELETE FROM passive_transactions WHERE scope = ?').run(scope)
}

function enforceGlobalBounds(database: Database, protectedScope: string): void {
  for (;;) {
    const count = database.query<{ count: number }, []>('SELECT count(*) AS count FROM passive_current').get()!.count
    if (count <= GLOBAL_SCOPE_LIMIT) break
    const victim = database.query<{ scope: string }, [string]>(`SELECT c.scope
      FROM passive_current c
      WHERE c.scope <> ?
      ORDER BY c.transaction_id ASC, c.scope ASC
      LIMIT 1`).get(protectedScope)
    if (!victim) throw new Error('Passive global scope bound cannot be enforced')
    deleteScope(database, victim.scope)
    database.query('DELETE FROM passive_legacy_state WHERE scope = ?').run(victim.scope)
    database.query('DELETE FROM passive_migrations WHERE scope = ?').run(victim.scope)
  }
}

async function reconcileLegacy(
  database: Database,
  root: string,
  scope: `sha256:${string}`,
  current: OpenCodeRedactedSnapshotV1 | null,
): Promise<{ snapshot: OpenCodeRedactedSnapshotV1 | null; changedDomains: Set<string> }> {
  const stored = database.query<{ fingerprint: string; provenance: string }, [string]>(
    'SELECT fingerprint, provenance FROM passive_legacy_state WHERE scope = ?',
  ).get(scope)
  if (stored?.fingerprint.startsWith('mirror:')) {
    try { lstatSync(path.join(root, OPEN_CODE_PASSIVE_TRANSACTION_MARKER)) }
    catch (error) {
      if (isMissing(error)) return { snapshot: current, changedDomains: new Set() }
      throw error
    }
  }
  const legacy = await readLegacySnapshot(root, scope)
  if (legacy.kind === 'invalid') throw new Error('Passive legacy snapshot store is invalid')
  const prior = stored ? decodeLegacyProvenance(stored.provenance) : null
  if (stored && !prior) throw new Error('Passive legacy migration watermark is invalid')
  if (stored?.fingerprint === legacy.fingerprint) {
    const snapshot = current && legacy.snapshot && current.capturedAt < legacy.snapshot.capturedAt
      ? { ...current, capturedAt: legacy.snapshot.capturedAt }
      : current
    return { snapshot, changedDomains: new Set() }
  }

  let result = current
  let changedDomains = new Set<string>()
  const migratedByOlderStore = !stored && current !== null && Boolean(database.query<{ present: number }, [string]>(
    'SELECT 1 AS present FROM passive_migrations WHERE scope = ?',
  ).get(scope))
  if (!migratedByOlderStore && legacy.snapshot) {
    const overlaid = overlayLegacySnapshot(current, legacy.snapshot, legacy.provenance, prior)
    result = overlaid.snapshot
    changedDomains = overlaid.changedDomains
  }

  const meta = database.query<{ migrated: number }, []>(
    'SELECT legacy_migrated AS migrated FROM passive_meta WHERE singleton = 1',
  ).get()
  if (!meta) throw new Error('Passive snapshot store schema is invalid')
  if (meta.migrated === 0) {
    if (await hasLegacyArtifacts(root)) {
      const fenced = database.query("UPDATE sqlite_sequence SET seq = max(seq, ?) WHERE name = 'passive_transactions'")
        .run(LEGACY_GENERATION_FENCE)
      if (fenced.changes === 0) database.query("INSERT INTO sqlite_sequence(name, seq) VALUES ('passive_transactions', ?)")
        .run(LEGACY_GENERATION_FENCE)
    }
    database.exec('UPDATE passive_meta SET legacy_migrated = 1 WHERE singleton = 1')
  }
  database.query(`INSERT INTO passive_legacy_state(scope, fingerprint, provenance) VALUES (?, ?, ?)
    ON CONFLICT(scope) DO UPDATE SET fingerprint = excluded.fingerprint, provenance = excluded.provenance`)
    .run(scope, legacy.fingerprint, JSON.stringify(legacy.provenance))
  database.query('INSERT OR IGNORE INTO passive_migrations(scope) VALUES (?)').run(scope)
  return { snapshot: result, changedDomains }
}

async function matchingLegacyCapturedAt(
  database: Database,
  root: string,
  scope: `sha256:${string}`,
): Promise<number | undefined | null> {
  let stored: { fingerprint: string } | null
  try {
    stored = database.query<{ fingerprint: string }, [string]>(
      'SELECT fingerprint FROM passive_legacy_state WHERE scope = ?',
    ).get(scope)
  } catch (error) {
    if (error instanceof Error && /no such table/i.test(error.message)) {
      return await hasLegacyArtifacts(root) ? null : undefined
    }
    throw error
  }
  if (!stored) return await hasLegacyArtifacts(root) ? null : undefined
  if (stored.fingerprint.startsWith('mirror:')) {
    try { lstatSync(path.join(root, OPEN_CODE_PASSIVE_TRANSACTION_MARKER)) }
    catch (error) { if (isMissing(error)) return undefined; return null }
  }
  const legacy = await readLegacySnapshot(root, scope)
  if (legacy.kind !== 'valid' || legacy.fingerprint !== stored.fingerprint) return null
  return legacy.snapshot?.capturedAt
}

async function hasLegacyArtifacts(root: string): Promise<boolean> {
  for (const name of [OPEN_CODE_PASSIVE_TRANSACTION_MARKER, 'committed.json', 'scopes', 'snapshots', 'binary.snapshot.json']) {
    try { await lstat(path.join(root, name)); return true }
    catch (error) { if (!isMissing(error)) return true }
  }
  return false
}

async function assertSafeDatabaseArtifacts(
  root: string,
  databaseRequired = false,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    try {
      const stat = await lstat(`${openCodePassiveDatabasePath(root)}${suffix}`)
      if (!stat.isFile() || stat.isSymbolicLink()
        || (platform !== 'win32' && (stat.mode & 0o077) !== 0)) {
        throw new Error('Passive snapshot database artifact is unsafe')
      }
    } catch (error) {
      if (!isMissing(error)) throw error
      if (databaseRequired && suffix === '') throw error
    }
  }
}

async function protectDatabaseArtifacts(
  root: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const artifact = `${openCodePassiveDatabasePath(root)}${suffix}`
    try {
      const stat = await lstat(artifact)
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Passive snapshot database artifact is unsafe')
      await chmod(artifact, 0o600)
    } catch (error) { if (!isMissing(error)) throw error }
  }
  await assertSafeDatabaseArtifacts(root, true, platform)
}

async function readLegacySnapshot(root: string, scope: `sha256:${string}`): Promise<LegacyRead> {
  try {
    let marker: string | null
    try { marker = await boundedRead(path.join(root, OPEN_CODE_PASSIVE_TRANSACTION_MARKER), 64) }
    catch (error) {
      if (!isMissing(error)) return { kind: 'invalid' }
      return readLegacyMirror(root, scope)
    }
    if (marker !== OPEN_CODE_PASSIVE_TRANSACTION_MARKER_CONTENT) return { kind: 'invalid' }
    const hash = createHash('sha256').update('opencode-passive-legacy-watermark-v1\0').update(marker)
    const scopesPath = path.join(root, 'scopes')
    const scoped = path.join(scopesPath, scope.slice(7))
    const commitsPath = path.join(scoped, OPEN_CODE_PASSIVE_COMMITS)
    if (!await pathMissingOrSafeDirectory(scopesPath) || !await pathMissingOrSafeDirectory(scoped)
      || !await pathMissingOrSafeDirectory(commitsPath)) return { kind: 'invalid' }
    if (!await pathExists(commitsPath)) {
      return { kind: 'valid', fingerprint: `immutable:${digest(hash.update('empty'))}`, snapshot: null, provenance: {} }
    }
    const entries: string[] = []
    // Bun closes a Dir when async iteration completes or its iterator is
    // returned early. Calling close() again is neither necessary nor portable.
    for await (const entry of await opendir(commitsPath)) {
      if (OPEN_CODE_PASSIVE_COMMIT_TEMP_PATTERN.test(entry.name)) continue
      if (entries.length >= LEGACY_SCAN_LIMIT || !entry.isFile()
        || !OPEN_CODE_PASSIVE_COMMIT_NAME_PATTERN.test(entry.name)) return { kind: 'invalid' }
      entries.push(entry.name)
    }
    entries.sort()
    const committed: Array<{ sequence: number; generation: string; value: OpenCodeRedactedSnapshotV1 }> = []
    for (const name of entries) {
      const text = await boundedRead(path.join(commitsPath, name), 4096)
      const commit = text && decodeOpenCodePassiveSnapshotCommit(text)
      if (!commit || commit.scope !== scope
        || name !== `${String(commit.domainGeneration).padStart(16, '0')}.${commit.generation}.json`) return { kind: 'invalid' }
      const generationPath = path.join(scoped, OPEN_CODE_PASSIVE_GENERATIONS, commit.generation)
      if (!await safeDirectory(path.join(scoped, OPEN_CODE_PASSIVE_GENERATIONS))
        || !await safeDirectory(generationPath)) return { kind: 'invalid' }
      const [project, binary] = await Promise.all([
        boundedRead(path.join(generationPath, OPEN_CODE_PASSIVE_GENERATION_PROJECT), OPEN_CODE_REDACTED_SNAPSHOT_MAX_BYTES),
        boundedRead(path.join(generationPath, OPEN_CODE_PASSIVE_GENERATION_BINARY), OPEN_CODE_REDACTED_SNAPSHOT_MAX_BYTES),
      ])
      if (!project || project !== binary) return { kind: 'invalid' }
      const decoded = decodeOpenCodeRedactedSnapshotV1(project)
      if (!decoded.ok || decoded.value.projectScope !== scope) return { kind: 'invalid' }
      hash.update('\0').update(name).update('\0').update(text).update('\0').update(project)
      committed.push({ sequence: commit.domainGeneration, generation: commit.generation, value: decoded.value })
    }
    if (committed.length === 0) {
      return { kind: 'valid', fingerprint: `immutable:${digest(hash.update('empty'))}`, snapshot: null, provenance: {} }
    }
    const merged = mergeLegacySnapshots(scope, committed)
    return { kind: 'valid', fingerprint: `immutable:${digest(hash)}`, snapshot: merged.snapshot, provenance: merged.provenance }
  } catch {
    return { kind: 'invalid' }
  }
}

async function readLegacyMirror(root: string, scope: `sha256:${string}`): Promise<LegacyRead> {
  try {
    const snapshots = path.join(root, 'snapshots')
    if (!await pathExists(snapshots)) {
      const hash = createHash('sha256').update('opencode-passive-legacy-mirror-v1\0empty')
      return { kind: 'valid', fingerprint: `mirror:${digest(hash)}`, snapshot: null, provenance: {} }
    }
    if (!await safeDirectory(snapshots)) return { kind: 'invalid' }
    const [project, binary] = await Promise.all([
      boundedRead(path.join(snapshots, `${scope.slice(7)}.json`), OPEN_CODE_REDACTED_SNAPSHOT_MAX_BYTES),
      boundedRead(path.join(root, 'binary.snapshot.json'), OPEN_CODE_REDACTED_SNAPSHOT_MAX_BYTES),
    ])
    if (!project || project !== binary) return { kind: 'invalid' }
    const decoded = decodeOpenCodeRedactedSnapshotV1(project)
    if (!decoded.ok || decoded.value.projectScope !== scope) return { kind: 'invalid' }
    const source = { sequence: 0, generation: 'mirror', value: decoded.value }
    const merged = mergeLegacySnapshots(scope, [source])
    const hash = createHash('sha256').update('opencode-passive-legacy-mirror-v1\0').update(project)
    return { kind: 'valid', fingerprint: `mirror:${digest(hash)}`, snapshot: merged.snapshot, provenance: merged.provenance }
  } catch (error) {
    if (isMissing(error)) {
      const hash = createHash('sha256').update('opencode-passive-legacy-mirror-v1\0empty')
      return { kind: 'valid', fingerprint: `mirror:${digest(hash)}`, snapshot: null, provenance: {} }
    }
    return { kind: 'invalid' }
  }
}

function mergeLegacySnapshots(
  scope: `sha256:${string}`,
  input: readonly { sequence: number; generation: string; value: OpenCodeRedactedSnapshotV1 }[],
): { snapshot: OpenCodeRedactedSnapshotV1; provenance: LegacyProvenance } {
  const committed = [...input].sort((left, right) => right.sequence - left.sequence
    || right.generation.localeCompare(left.generation))
  const newest = committed.reduce((selected, item) => item.sequence > selected.sequence ? item : selected)
  const snapshot = structuredClone(newest.value)
  const provenance: LegacyProvenance = {}
  snapshot.projectScope = scope
  snapshot.capturedAt = Math.max(...committed.map(item => item.value.capturedAt))
  const binary = selectLegacyEvidence(committed.map(item => ({ sequence: item.sequence, value: item.value.binary })))
  snapshot.binary = structuredClone(binary.value)
  provenance.binary = legacyEvidence(binary, binary.value)
  const providerIds = [...new Set(committed.flatMap(item => item.value.providers.map(provider => provider.providerId)))].sort()
  snapshot.providers = providerIds.map(providerId => {
    const sources = committed.flatMap(item => {
      const provider = item.value.providers.find(candidate => candidate.providerId === providerId)
      return provider ? [{ sequence: item.sequence, provider }] : []
    })
    const configured = selectLegacyEvidence(sources.map(source => ({ sequence: source.sequence, value: source.provider.configured })))
    const connected = selectLegacyEvidence(sources.map(source => ({ sequence: source.sequence, value: source.provider.lastConnected })))
    const catalog = selectLegacyEvidence(sources.map(source => ({ sequence: source.sequence,
      value: source.provider.catalogAvailable, source: source.provider })))
    const execution = selectLegacyEvidence(sources.map(source => ({ sequence: source.sequence, value: source.provider.executionVerified })))
    const newestProvider = sources.reduce((selected, item) => item.sequence > selected.sequence ? item : selected).provider
    const prefix = `provider:${providerId}:`
    provenance[`${prefix}configured`] = legacyEvidence(configured, configured.value)
    provenance[`${prefix}lastConnected`] = legacyEvidence(connected, connected.value)
    provenance[`${prefix}catalog`] = legacyEvidence(catalog, {
      observation: catalog.value,
      modelIds: catalog.source?.modelIds,
      modelIdsTotal: catalog.source?.modelIdsTotal,
      modelIdsTruncated: catalog.source?.modelIdsTruncated,
      modelIdsFingerprint: catalog.source?.modelIdsFingerprint,
    })
    provenance[`${prefix}executionVerified`] = legacyEvidence(execution, execution.value)
    return {
      providerId,
      configured: structuredClone(configured.value),
      lastConnected: structuredClone(connected.value),
      catalogAvailable: structuredClone(catalog.value),
      executionVerified: structuredClone(execution.value),
      ...(newestProvider.fingerprint === undefined ? {} : { fingerprint: newestProvider.fingerprint }),
      ...(catalog.source?.modelIds === undefined ? {} : { modelIds: [...catalog.source.modelIds] }),
      ...(catalog.source?.modelIdsTotal === undefined ? {} : {
        modelIdsTotal: catalog.source.modelIdsTotal,
        modelIdsTruncated: catalog.source.modelIdsTruncated,
        modelIdsFingerprint: catalog.source.modelIdsFingerprint,
      }),
    }
  })
  return { snapshot, provenance }
}

function selectLegacyEvidence<T, S = undefined>(
  items: readonly { sequence: number; value: T & { evidenceGeneration?: number }; source?: S }[],
): { sequence: number; value: T & { evidenceGeneration?: number }; source?: S } {
  return items.reduce((selected, item) => {
    const left = item.value.evidenceGeneration ?? item.sequence
    const right = selected.value.evidenceGeneration ?? selected.sequence
    if (left !== right) return left > right ? item : selected
    if (item.sequence !== selected.sequence) return item.sequence > selected.sequence ? item : selected
    return JSON.stringify(item.value) > JSON.stringify(selected.value) ? item : selected
  })
}

function legacyEvidence(
  selected: { sequence: number; value: { evidenceGeneration?: number } },
  fingerprintValue: unknown,
): LegacyEvidence {
  return {
    rank: selected.value.evidenceGeneration ?? selected.sequence,
    sequence: selected.sequence,
    fingerprint: createHash('sha256').update(JSON.stringify(fingerprintValue)).digest('hex'),
  }
}

function overlayLegacySnapshot(
  current: OpenCodeRedactedSnapshotV1 | null,
  legacy: OpenCodeRedactedSnapshotV1,
  provenance: LegacyProvenance,
  prior: LegacyProvenance | null,
): { snapshot: OpenCodeRedactedSnapshotV1; changedDomains: Set<string> } {
  if (prior) for (const key of Object.keys(prior)) {
    if (!provenance[key]) throw new Error('Passive legacy evidence regressed')
  }
  const next = structuredClone(current ?? emptySnapshot(legacy.projectScope, legacy.capturedAt))
  const changedDomains = new Set<string>()
  const shouldApply = (key: string): boolean => {
    const evidence = provenance[key]
    if (!evidence) throw new Error('Passive legacy evidence provenance is incomplete')
    const old = prior?.[key]
    if (!old) return true
    const order = evidence.rank - old.rank || evidence.sequence - old.sequence
    if (order < 0 || (order === 0 && evidence.fingerprint !== old.fingerprint)) {
      throw new Error('Passive legacy evidence is stale or inconsistent')
    }
    // Advancing commit membership is not itself new domain evidence. Import
    // only a newer effective fact whose owned value actually changed.
    return order > 0 && evidence.fingerprint !== old.fingerprint
  }
  if (shouldApply('binary')) {
    next.binary = withoutGeneration(legacy.binary)
    changedDomains.add('binary')
  }
  for (const source of legacy.providers) {
    let provider = next.providers.find(item => item.providerId === source.providerId)
    if (!provider) { provider = unknownProvider(source.providerId); next.providers.push(provider) }
    const prefix = `provider:${source.providerId}:`
    if (shouldApply(`${prefix}configured`)) {
      provider.configured = withoutGeneration(source.configured); changedDomains.add(`${prefix}configured`)
    }
    if (shouldApply(`${prefix}lastConnected`)) {
      provider.lastConnected = withoutGeneration(source.lastConnected); changedDomains.add(`${prefix}lastConnected`)
    }
    if (shouldApply(`${prefix}catalog`)) {
      provider.catalogAvailable = withoutGeneration(source.catalogAvailable)
      delete provider.modelIds; delete provider.modelIdsTotal; delete provider.modelIdsTruncated; delete provider.modelIdsFingerprint
      if (source.modelIds) provider.modelIds = [...source.modelIds]
      if (source.modelIdsTotal !== undefined) {
        provider.modelIdsTotal = source.modelIdsTotal
        provider.modelIdsTruncated = source.modelIdsTruncated
        provider.modelIdsFingerprint = source.modelIdsFingerprint
      }
      changedDomains.add(`${prefix}catalog`)
    }
    if (shouldApply(`${prefix}executionVerified`)) {
      provider.executionVerified = withoutGeneration(source.executionVerified); changedDomains.add(`${prefix}executionVerified`)
    }
    if (source.fingerprint !== undefined) provider.fingerprint = source.fingerprint
  }
  // A cumulative immutable publication advances its logical clock even when
  // it only republishes identical domain evidence.
  next.capturedAt = Math.max(next.capturedAt, legacy.capturedAt)
  next.providers.sort((left, right) => left.providerId.localeCompare(right.providerId))
  return { snapshot: next, changedDomains }
}

function decodeLegacyProvenance(text: string): LegacyProvenance | null {
  try {
    const value = JSON.parse(text) as Record<string, LegacyEvidence>
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 1_000) return null
    for (const evidence of Object.values(value)) {
      if (!evidence || !Number.isSafeInteger(evidence.rank) || evidence.rank < 0
        || !Number.isSafeInteger(evidence.sequence) || evidence.sequence < 0
        || !/^[0-9a-f]{64}$/.test(evidence.fingerprint)) return null
    }
    return value
  } catch { return null }
}

async function pathExists(file: string): Promise<boolean> {
  try { await lstat(file); return true } catch (error) { if (isMissing(error)) return false; throw error }
}

async function pathMissingOrSafeDirectory(directory: string): Promise<boolean> {
  try { const stat = await lstat(directory); return stat.isDirectory() && !stat.isSymbolicLink() }
  catch (error) { return isMissing(error) }
}

function digest(hash: ReturnType<typeof createHash>): string { return hash.digest('hex') }

async function safeDirectory(directory: string): Promise<boolean> {
  try { const stat = await lstat(directory); return stat.isDirectory() && !stat.isSymbolicLink() }
  catch { return false }
}

async function boundedRead(file: string, maximum: number): Promise<string | null> {
  const stat = await lstat(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum) return null
  const value = await readFile(file, 'utf8')
  return Buffer.byteLength(value, 'utf8') <= maximum ? value : null
}

function applyMutation(base: OpenCodeRedactedSnapshotV1, mutation: OpenCodeRedactedSnapshotMutation): OpenCodeRedactedSnapshotV1 {
  const next = structuredClone(base)
  next.capturedAt = mutation.capturedAt
  ageExpired(next, next.capturedAt)
  if (mutation.binary) next.binary = withoutGeneration(mutation.binary)
  if (mutation.providerDefaults) for (const provider of next.providers) applyProviderMutation(provider, mutation.providerDefaults)
  for (const delta of mutation.providers ?? []) {
    let provider = next.providers.find(item => item.providerId === delta.providerId)
    if (!provider) {
      provider = unknownProvider(delta.providerId)
      next.providers.push(provider)
    }
    applyProviderMutation(provider, delta)
  }
  next.providers.sort((a, b) => a.providerId.localeCompare(b.providerId))
  return next
}

function applyProviderMutation(provider: OpenCodeRedactedSnapshotProviderV1, delta: Omit<OpenCodeRedactedProviderMutation, 'providerId'>): void {
  if (delta.configured) provider.configured = withoutGeneration(delta.configured)
  if (delta.lastConnected) provider.lastConnected = withoutGeneration(delta.lastConnected)
  if (delta.catalog) {
    provider.catalogAvailable = withoutGeneration(delta.catalog.available)
    delete provider.modelIds; delete provider.modelIdsTotal; delete provider.modelIdsTruncated; delete provider.modelIdsFingerprint
    if (delta.catalog.modelIds) provider.modelIds = [...delta.catalog.modelIds]
  }
  if (delta.executionVerified) provider.executionVerified = withoutGeneration(delta.executionVerified)
}

function ageExpired(snapshot: OpenCodeRedactedSnapshotV1, now: number): void {
  for (const retained of [snapshot.binary, ...snapshot.providers.flatMap(provider => [
    provider.configured, provider.lastConnected, provider.catalogAvailable, provider.executionVerified,
  ])]) {
    if (retained.freshness !== 'fresh' || retained.validUntil === null || retained.validUntil >= now) continue
    retained.freshness = 'stale'; retained.condition = 'degraded'; retained.issueCode = 'expired'
  }
}

function normalizeMutationTime(
  mutation: OpenCodeRedactedSnapshotMutation,
  logicalTime: number,
): OpenCodeRedactedSnapshotMutation {
  const copy = structuredClone(mutation) as any
  const offset = logicalTime - mutation.capturedAt
  copy.capturedAt = logicalTime
  const observations = [copy.binary, ...Object.values(copy.providerDefaults ?? {}).flatMap((value: any) =>
    value && typeof value === 'object' && 'available' in value ? [value.available] : [value]),
    ...(copy.providers ?? []).flatMap((provider: any) => [provider.configured, provider.lastConnected,
      provider.catalog?.available, provider.executionVerified])].filter(Boolean)
  for (const observation of observations) {
    if (observation.authority === 'none') continue
    observation.observedAt = shiftedTimestamp(observation.observedAt, offset)
    observation.validUntil = shiftedTimestamp(observation.validUntil, offset)
    if (observation.value?.state === 'connected' && observation.value.at !== undefined) {
      observation.value.at = shiftedTimestamp(observation.value.at, offset)
    }
  }
  return copy
}

function shiftedTimestamp(value: unknown, offset: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError('Invalid passive observation clock')
  const shifted = (value as number) + offset
  if (!Number.isSafeInteger(shifted) || shifted < 0) throw new TypeError('Passive logical observation clock exhausted')
  return shifted
}

function mutationDomains(mutation: OpenCodeRedactedSnapshotMutation, snapshot: OpenCodeRedactedSnapshotV1): Set<string> {
  const domains = new Set<string>()
  if (mutation.binary) domains.add('binary')
  for (const provider of mutation.providers ?? []) {
    const prefix = `provider:${provider.providerId}:`
    if (provider.configured) domains.add(`${prefix}configured`)
    if (provider.lastConnected) domains.add(`${prefix}lastConnected`)
    if (provider.catalog) domains.add(`${prefix}catalog`)
    if (provider.executionVerified) domains.add(`${prefix}executionVerified`)
  }
  if (mutation.providerDefaults) {
    for (const provider of snapshot.providers) {
      const prefix = `provider:${provider.providerId}:`
      if (mutation.providerDefaults.configured) domains.add(`${prefix}configured`)
      if (mutation.providerDefaults.lastConnected) domains.add(`${prefix}lastConnected`)
      if (mutation.providerDefaults.catalog) domains.add(`${prefix}catalog`)
      if (mutation.providerDefaults.executionVerified) domains.add(`${prefix}executionVerified`)
    }
  }
  return domains
}

function snapshotDomains(snapshot: OpenCodeRedactedSnapshotV1): Set<string> {
  const domains = new Set<string>(['binary'])
  for (const provider of snapshot.providers) {
    const prefix = `provider:${provider.providerId}:`
    domains.add(`${prefix}configured`)
    domains.add(`${prefix}lastConnected`)
    domains.add(`${prefix}catalog`)
    domains.add(`${prefix}executionVerified`)
  }
  return domains
}

function assignChangedGenerations(snapshot: OpenCodeRedactedSnapshotV1, generation: number, domains: Set<string>): void {
  const assign = (key: string, observation: { authority: string; evidenceGeneration?: number }) => {
    if (!domains.has(key)) return
    delete observation.evidenceGeneration
    if (observation.authority !== 'none') observation.evidenceGeneration = generation
  }
  assign('binary', snapshot.binary)
  for (const provider of snapshot.providers) {
    const prefix = `provider:${provider.providerId}:`
    assign(`${prefix}configured`, provider.configured)
    assign(`${prefix}lastConnected`, provider.lastConnected)
    assign(`${prefix}catalog`, provider.catalogAvailable)
    assign(`${prefix}executionVerified`, provider.executionVerified)
  }
}

function decodeDurable(text: string, generation: number, scope: `sha256:${string}`): OpenCodeRedactedSnapshotV1 | null {
  const decoded = decodeOpenCodeRedactedSnapshotV1(text)
  if (!decoded.ok || decoded.value.projectScope !== scope) return null
  const observations = [decoded.value.binary, ...decoded.value.providers.flatMap(provider => [
    provider.configured, provider.lastConnected, provider.catalogAvailable, provider.executionVerified,
  ])]
  if (observations.some(observation => observation.authority === 'none'
    ? observation.evidenceGeneration !== undefined
    : !Number.isSafeInteger(observation.evidenceGeneration)
      || observation.evidenceGeneration! <= 0 || observation.evidenceGeneration! > generation)) return null
  return decoded.value
}

function validateMutation(mutation: OpenCodeRedactedSnapshotMutation): void {
  if (!/^sha256:[0-9a-f]{64}$/.test(mutation.projectScope)
    || !Number.isSafeInteger(mutation.capturedAt) || mutation.capturedAt < 0) throw new TypeError('Invalid passive mutation')
  const ids = new Set<string>()
  const supplied = [mutation.binary, ...Object.values(mutation.providerDefaults ?? {}).flatMap(value =>
    value && typeof value === 'object' && 'available' in value ? [value.available] : [value]),
    ...(mutation.providers ?? []).flatMap(provider => [provider.configured, provider.lastConnected,
      provider.catalog?.available, provider.executionVerified])].filter(Boolean) as Array<{ evidenceGeneration?: number }>
  if (supplied.some(observation => observation.evidenceGeneration !== undefined)) {
    throw new TypeError('Passive mutation cannot supply durable authority')
  }
  if (mutation.providerDefaults?.catalog?.modelIds) throw new TypeError('Default catalog mutation cannot own models')
  for (const provider of mutation.providers ?? []) {
    if (!isOpenCodeCanonicalProviderId(provider.providerId) || ids.has(provider.providerId)) throw new TypeError('Invalid passive provider mutation')
    ids.add(provider.providerId)
    for (const model of provider.catalog?.modelIds ?? []) {
      if (parseOpenCodeExactProviderModelRef(model)?.providerId !== provider.providerId) throw new TypeError('Passive catalog ownership mismatch')
    }
  }
}

function emptySnapshot(scope: `sha256:${string}`, capturedAt: number): OpenCodeRedactedSnapshotV1 {
  return { schemaVersion: 1, projectScope: scope, capturedAt,
    binary: unknown({ presence: 'unknown', version: null }), providers: [] }
}

function unknownProvider(providerId: string): OpenCodeRedactedSnapshotProviderV1 {
  return { providerId, configured: unknown('unknown'), lastConnected: unknown({ state: 'unknown' }),
    catalogAvailable: unknown('unknown'), executionVerified: unknown('unknown') } as OpenCodeRedactedSnapshotProviderV1
}

function unknown<T>(value: T): any {
  return { value, authority: 'none', freshness: 'unknown', condition: 'degraded', observedAt: null, validUntil: null, issueCode: 'unknown' }
}

function withoutGeneration<T extends { evidenceGeneration?: number }>(value: T): T {
  const copy = structuredClone(value)
  delete copy.evidenceGeneration
  return copy
}

function rejectUnsupportedPlatform(platform = process.platform): void {
  if (platform !== 'linux' && platform !== 'darwin' && platform !== 'win32') {
    throw new Error('Passive transactional persistence is unsupported on this platform')
  }
}
function rollback(database: Database): void { try { database.exec('ROLLBACK') } catch { /* no active transaction */ } }
function cancelled(): Error { return Object.assign(new Error('Passive snapshot update cancelled'), { code: 'ABORT_ERR' }) }
function isMissing(error: unknown): boolean { return Boolean(error && typeof error === 'object' && 'code' in error && (error as any).code === 'ENOENT') }
function isBusy(error: unknown): boolean { return Boolean(error && typeof error === 'object' && 'code' in error && (error as any).code === 'SQLITE_BUSY') || (error instanceof Error && /locked|busy/i.test(error.message)) }
