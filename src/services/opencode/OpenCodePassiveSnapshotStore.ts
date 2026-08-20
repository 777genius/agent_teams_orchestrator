import { Database } from 'bun:sqlite'
import { chmod, lstat, opendir, readFile } from 'node:fs/promises'
import path from 'node:path'

import {
  decodeOpenCodeRedactedSnapshotV1,
  encodeOpenCodeRedactedSnapshotV1,
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
  }, signal)
}

async function commitOpenCodePassiveSnapshot(
  options: StoreOptions,
  projectScope: `sha256:${string}`,
  capturedAt: number,
  produce: (base: OpenCodeRedactedSnapshotV1) => OpenCodeRedactedSnapshotV1,
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
    await assertSafeDatabaseArtifacts(options.rootDirectory, true)
    database = openDatabase(options.rootDirectory, false)
    await ensureDatabaseReady(database, signal)
    await protectDatabaseArtifacts(options.rootDirectory)
    await root.sync()
    await options.hooks?.afterTransactionMarker?.()
    await beginImmediate(database, signal)
    try {
      await importLegacyOnce(database, options.rootDirectory, projectScope)
      const previous = readCurrent(database, projectScope)
      const base = previous ? decodeDurable(previous.payload, previous.transactionId, projectScope) : null
      // A malformed committed value invalidates the scope. It must never be
      // merged into a later mutation or retain launch-adjacent authority.
      if (previous && !base) deleteScope(database, projectScope)
      const next = produce(base ?? emptySnapshot(projectScope, capturedAt))
      database.query('INSERT INTO passive_transactions(scope, payload) VALUES (?, ?)')
        .run(projectScope, '')
      const id = Number(database.query<{ id: number }, []>('SELECT last_insert_rowid() AS id').get()!.id)
      if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Passive transaction generation exhausted')
      await options.hooks?.afterGenerationDirectoryCreated?.()
      if (signal.aborted) throw cancelled()
      assignGeneration(next, id)
      const encoded = encodeOpenCodeRedactedSnapshotV1(next)
      if (!encoded.ok || !encoded.bytes) throw new TypeError(`Passive snapshot mutation is invalid: ${encoded.issueCode}`)
      const payload = new TextDecoder('utf-8', { fatal: true }).decode(encoded.bytes)
      if (!decodeDurable(payload, id, projectScope)) throw new TypeError('Passive snapshot authority is invalid')
      await options.hooks?.afterProjectSnapshotPublished?.()
      if (signal.aborted) throw cancelled()
      await options.hooks?.afterBinarySnapshotPublished?.()
      if (signal.aborted) throw cancelled()
      database.query('UPDATE passive_transactions SET payload = ? WHERE id = ?').run(payload, id)
      database.query(`INSERT INTO passive_current(scope, transaction_id) VALUES (?, ?)
        ON CONFLICT(scope) DO UPDATE SET transaction_id = excluded.transaction_id`).run(projectScope, id)
      database.query(`DELETE FROM passive_transactions WHERE scope = ? AND id NOT IN
        (SELECT id FROM passive_transactions WHERE scope = ? ORDER BY id DESC LIMIT ?)`)
        .run(projectScope, projectScope, HISTORY_PER_SCOPE)
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
  await assertSafeDatabaseArtifacts(rootDirectory, true)
  const database = openDatabase(rootDirectory, true)
  try {
    verifySchema(database)
    database.exec('BEGIN')
    try {
      const row = readCurrent(database, scope)
      if (!row) { database.exec('COMMIT'); return null }
      // SQLite has copied the selected row into owned JS memory while the read
      // transaction pins its version. Retention can now proceed independently.
      await options.afterSelected?.()
      if (signal.aborted) throw cancelled()
      const value = decodeDurable(row.payload, row.transactionId, scope)
      database.exec('COMMIT')
      return value ? { transactionId: row.transactionId, text: row.payload, value } : null
    } catch (error) { rollback(database); throw error }
  } finally { database.close(false) }
}

export async function maintainOpenCodePassiveStore(rootDirectory: string, platform?: NodeJS.Platform): Promise<void> {
  rejectUnsupportedPlatform(platform)
  if (!await openCodePassiveDatabaseExists(rootDirectory)) return
  await assertSafeDatabaseArtifacts(rootDirectory, true)
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
  `)
  verifySchema(database)
}

async function ensureDatabaseReady(database: Database, signal: AbortSignal): Promise<void> {
  for (;;) {
    if (signal.aborted) throw cancelled()
    try {
      const ready = database.query<{ schemaVersion: number; journalReady: number }, []>(
        'SELECT schema_version AS schemaVersion, journal_ready AS journalReady FROM passive_meta WHERE singleton = 1',
      ).get()
      if (ready?.schemaVersion !== SCHEMA_VERSION) throw new Error('Passive snapshot store schema is invalid')
      if (ready.journalReady === 1) return
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
      if (existingTables !== 0) throw new Error('Passive snapshot store schema is invalid')
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

function deleteScope(database: Database, scope: string): void {
  database.query('DELETE FROM passive_current WHERE scope = ?').run(scope)
  database.query('DELETE FROM passive_transactions WHERE scope = ?').run(scope)
}

async function importLegacyOnce(database: Database, root: string, scope: `sha256:${string}`): Promise<void> {
  const meta = database.query<{ migrated: number }, []>('SELECT legacy_migrated AS migrated FROM passive_meta WHERE singleton = 1').get()
  if (!meta || meta.migrated === 1) return
  // Migration is one bounded global attempt. Only the scope that triggered the
  // new store may be imported; subsequent scopes never rescan legacy trees.
  const legacy = await readLegacySnapshot(root, scope)
  // Fence even rejected/corrupt legacy authority. sqlite_sequence is durable,
  // and AUTOINCREMENT never reuses a rolled-back/crashed writer's committed id.
  if (await hasLegacyArtifacts(root)) {
    const fenced = database.query("UPDATE sqlite_sequence SET seq = max(seq, ?) WHERE name = 'passive_transactions'")
      .run(LEGACY_GENERATION_FENCE)
    if (fenced.changes === 0) database.query("INSERT INTO sqlite_sequence(name, seq) VALUES ('passive_transactions', ?)")
      .run(LEGACY_GENERATION_FENCE)
  }
  if (legacy) {
    database.query('INSERT INTO passive_transactions(scope, payload) VALUES (?, ?)').run(scope, '')
    const id = Number(database.query<{ id: number }, []>('SELECT last_insert_rowid() AS id').get()!.id)
    assignGeneration(legacy, id)
    const encoded = encodeOpenCodeRedactedSnapshotV1(legacy)
    if (encoded.ok && encoded.bytes) {
      const payload = new TextDecoder().decode(encoded.bytes)
      database.query('UPDATE passive_transactions SET payload = ? WHERE id = ?').run(payload, id)
      database.query('INSERT INTO passive_current(scope, transaction_id) VALUES (?, ?)').run(scope, id)
    }
  }
  database.exec('UPDATE passive_meta SET legacy_migrated = 1 WHERE singleton = 1')
}

async function hasLegacyArtifacts(root: string): Promise<boolean> {
  for (const name of [OPEN_CODE_PASSIVE_TRANSACTION_MARKER, 'committed.json', 'scopes', 'snapshots', 'binary.snapshot.json']) {
    try { await lstat(path.join(root, name)); return true }
    catch (error) { if (!isMissing(error)) return true }
  }
  return false
}

async function assertSafeDatabaseArtifacts(root: string, databaseRequired = false): Promise<void> {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    try {
      const stat = await lstat(`${openCodePassiveDatabasePath(root)}${suffix}`)
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
        throw new Error('Passive snapshot database artifact is unsafe')
      }
    } catch (error) {
      if (!isMissing(error)) throw error
      if (databaseRequired && suffix === '') throw error
    }
  }
}

async function protectDatabaseArtifacts(root: string): Promise<void> {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const artifact = `${openCodePassiveDatabasePath(root)}${suffix}`
    try {
      const stat = await lstat(artifact)
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Passive snapshot database artifact is unsafe')
      await chmod(artifact, 0o600)
    } catch (error) { if (!isMissing(error)) throw error }
  }
  await assertSafeDatabaseArtifacts(root, true)
}

async function readLegacySnapshot(root: string, scope: `sha256:${string}`): Promise<OpenCodeRedactedSnapshotV1 | null> {
  try {
    const marker = await boundedRead(path.join(root, OPEN_CODE_PASSIVE_TRANSACTION_MARKER), 64)
    if (marker !== OPEN_CODE_PASSIVE_TRANSACTION_MARKER_CONTENT) return null
    const scoped = path.join(root, 'scopes', scope.slice(7))
    const commitsPath = path.join(scoped, OPEN_CODE_PASSIVE_COMMITS)
    if (!await safeDirectory(path.join(root, 'scopes')) || !await safeDirectory(scoped)
      || !await safeDirectory(commitsPath)) return null
    const entries: string[] = []
    const directory = await opendir(commitsPath)
    try {
      for await (const entry of directory) {
        if (entries.length >= LEGACY_SCAN_LIMIT || !entry.isFile() || !OPEN_CODE_PASSIVE_COMMIT_NAME_PATTERN.test(entry.name)) return null
        entries.push(entry.name)
      }
    } finally { await directory.close().catch(() => undefined) }
    const parsed: Array<{ id: number; generation: string }> = []
    for (const name of entries) {
      const text = await boundedRead(path.join(commitsPath, name), 4096)
      const commit = text && decodeOpenCodePassiveSnapshotCommit(text)
      if (!commit || commit.scope !== scope) return null
      parsed.push({ id: commit.domainGeneration, generation: commit.generation })
    }
    parsed.sort((a, b) => b.id - a.id)
    if (!parsed[0] || parsed[1]?.id === parsed[0].id) return null
    const generation = path.join(scoped, OPEN_CODE_PASSIVE_GENERATIONS, parsed[0].generation)
    if (!await safeDirectory(path.join(scoped, OPEN_CODE_PASSIVE_GENERATIONS))
      || !await safeDirectory(generation)) return null
    const [project, binary] = await Promise.all([
      boundedRead(path.join(generation, OPEN_CODE_PASSIVE_GENERATION_PROJECT), 65_536),
      boundedRead(path.join(generation, OPEN_CODE_PASSIVE_GENERATION_BINARY), 65_536),
    ])
    if (!project || project !== binary) return null
    const decoded = decodeOpenCodeRedactedSnapshotV1(project)
    return decoded.ok && decoded.value.projectScope === scope ? structuredClone(decoded.value) : null
  } catch (error) {
    if (!isMissing(error)) return null
    try {
      if (!await safeDirectory(path.join(root, 'snapshots'))) return null
      const [project, binary] = await Promise.all([
        boundedRead(path.join(root, 'snapshots', `${scope.slice(7)}.json`), 65_536),
        boundedRead(path.join(root, 'binary.snapshot.json'), 65_536),
      ])
      if (!project || project !== binary) return null
      const decoded = decodeOpenCodeRedactedSnapshotV1(project)
      return decoded.ok && decoded.value.projectScope === scope ? structuredClone(decoded.value) : null
    } catch { return null }
  }
}

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
  next.capturedAt = Math.max(next.capturedAt, mutation.capturedAt)
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

function assignGeneration(snapshot: OpenCodeRedactedSnapshotV1, generation: number): void {
  const observations = [snapshot.binary, ...snapshot.providers.flatMap(provider => [
    provider.configured, provider.lastConnected, provider.catalogAvailable, provider.executionVerified,
  ])]
  for (const observation of observations) {
    delete observation.evidenceGeneration
    if (observation.authority !== 'none') observation.evidenceGeneration = generation
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
    : observation.evidenceGeneration !== generation)) return null
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
  if (platform === 'win32') throw new Error('Passive transactional persistence is unsupported on native Windows')
}
function rollback(database: Database): void { try { database.exec('ROLLBACK') } catch { /* no active transaction */ } }
function cancelled(): Error { return Object.assign(new Error('Passive snapshot update cancelled'), { code: 'ABORT_ERR' }) }
function isMissing(error: unknown): boolean { return Boolean(error && typeof error === 'object' && 'code' in error && (error as any).code === 'ENOENT') }
function isBusy(error: unknown): boolean { return Boolean(error && typeof error === 'object' && 'code' in error && (error as any).code === 'SQLITE_BUSY') || (error instanceof Error && /locked|busy/i.test(error.message)) }
