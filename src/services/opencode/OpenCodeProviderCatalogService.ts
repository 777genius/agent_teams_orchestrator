import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync, constants as fsConstants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
  realpathSync, writeFileSync,
} from 'node:fs'
import { open } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { types as nodeUtilTypes } from 'node:util'
import { Database } from 'bun:sqlite'

import { normalizeOpenCodeScopedProviderCatalogResponse } from './OpenCodeLiveProviderNormalizer.js'
import {
  createOpenCodeCatalogRecordId,
  type OpenCodeCatalogRecordIdentityPayload,
  type OpenCodeScopedProviderCatalog,
} from './OpenCodeProviderCatalogContract.js'
import { canonicalizeOpenCodeProviderId } from './OpenCodeProviderIdentity.js'
import { canonicalizeOpenCodePassiveProjectPath } from './OpenCodePassiveStatusProductionReader.js'
import {
  prepareOpenCodeProviderCatalogProductionProfile,
  type OpenCodeProviderCatalogProductionProfileManager,
} from './OpenCodeProviderCatalogProduction.js'

import type { OpenCodeScopedPreparedProfile } from './types.js'

const DEFAULT_TTL_MS = 30_000
const DEFAULT_MAX_STALE_MS = 5 * 60_000
const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MAX_ENTRIES = 64
const MAX_TIME_MS = 10_000_000_000
const MAX_EPOCH_MS = 8_640_000_000_000_000
const MAX_TIMEOUT_MS = 2_147_483_647
const MAX_ENTRIES = 1_024
const MAX_PERSISTED_BYTES = 2 * 1024 * 1024
const MAX_IDENTITY_STRING = 16_384
const FIXED_FAILURE = 'OpenCode provider catalog is temporarily unavailable.'
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
const customPersistenceCommitQueues = new WeakMap<Function, Map<string, Promise<boolean>>>()
const defaultPersistenceCommitQueues = new Map<string, Promise<boolean>>()
type AdmissionHead = Readonly<{ generation: number; scopeHash: string; cacheKey?: string }>
const customAdmissionHeads = new WeakMap<Function, AdmissionHead>()
const customAuthorityNamespaces = new WeakMap<Function, string>()
const defaultAdmissionHeads = new Map<string, AdmissionHead>()
const ATTEMPT_SCHEMA_VERSION = 44306
const ATTEMPT_ROW_CAPACITY = 64
const ATTEMPT_TABLE_SQL = `CREATE TABLE allocation_ticket (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope_hash TEXT NOT NULL CHECK(length(scope_hash) = 64),
      started_at INTEGER NOT NULL CHECK(started_at >= 0),
      cache_key TEXT CHECK(cache_key IS NULL OR length(cache_key) = 64)
    )`
const ATTEMPT_STATE_SQL = `CREATE TABLE allocation_state (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      generation INTEGER NOT NULL CHECK(generation >= 0)
    )`
const CATALOG_ENTRY_SQL = `CREATE TABLE catalog_entry (
      cache_key TEXT PRIMARY KEY CHECK(length(cache_key) = 64),
      request_generation INTEGER NOT NULL CHECK(request_generation > 0),
      attempt_identity TEXT NOT NULL CHECK(length(attempt_identity) = 71),
      attempt_id TEXT NOT NULL,
      pointer_json TEXT NOT NULL,
      envelope_json TEXT NOT NULL,
      retained_order INTEGER NOT NULL CHECK(retained_order > 0)
    )`
let durableAttemptDatabase: {
  filePath: string
  database: Database
  rootReceipt: ManagedRootReceipt
  rootDescriptor: number | null
  databaseDescriptor: number
  journalDescriptor: number
  schemaVersion: number
} | null = null

export type OpenCodeProviderCatalogLoadInput = Readonly<{
  providerId: string
  projectPath?: string | null
  abortSignal?: AbortSignal
}>

export type OpenCodeProviderCatalogLoadResult = Readonly<{
  catalog: OpenCodeScopedProviderCatalog
  /** Redacted identity created before this scoped catalog attempt starts. */
  catalogEvidence: OpenCodeCatalogPublicationEvidence
  /** Original evidence time range; cache/fallback results never extend it. */
  catalogObservedAt: number
  catalogExpiresAt: number
  catalogProvenance: 'fresh-live' | 'cache-hit' | 'bounded-stale'
  profileRootPath: string
  projectPath: string
  diagnostics: readonly string[]
}>

export type OpenCodeCatalogPublicationEvidence = Readonly<{
  providerId: string
  requestGeneration: number
  startedAt: number
  attemptIdentity: `sha256:${string}`
  binaryFingerprint: `sha256:${string}`
  configFingerprint: `sha256:${string}`
  authFingerprint: `sha256:${string}`
}>

export type OpenCodeProviderCatalogPort = {
  loadCatalog(input: OpenCodeProviderCatalogLoadInput): Promise<OpenCodeProviderCatalogLoadResult>
}

type CatalogHost = Readonly<{ hostKey: string; baseUrl: string }>

export type OpenCodeProviderCatalogServiceDeps = {
  /** Production profile-manager seam; omission loads the process singleton. */
  profileManager?: OpenCodeProviderCatalogProductionProfileManager
  prepareProfile?: (input: {
    purpose: 'provider-catalog'
    providerId: string
    runtimeInstanceId: string
    projectPath?: string | null
    abortSignal?: AbortSignal
  }) => Promise<OpenCodeScopedPreparedProfile>
  /** Transaction hooks paired with prepareProfile; deterministic fakes may inject cleanup stalls. */
  finalizePreparedProfile?: (profile: OpenCodeScopedPreparedProfile) => Promise<void>
  rollbackPreparedProfile?: (profile: OpenCodeScopedPreparedProfile) => Promise<void>
  ensureHost?: (input: {
    preparedProfile: OpenCodeScopedPreparedProfile
    resolveConfigFingerprint: false
    abortSignal?: AbortSignal
  }) => Promise<CatalogHost>
  releaseHost?: (hostKey: string) => Promise<void>
  fetchProviderCatalog?: (input: {
    baseUrl: string
    abortSignal: AbortSignal
  }) => Promise<unknown>
  readPersisted?: (cacheKey: string) => Promise<unknown | null>
  writePersisted?: (cacheKey: string, value: unknown) => Promise<void>
  deletePersisted?: (cacheKey: string) => Promise<void>
  now?: () => number
  timeoutMs?: number
  ttlMs?: number
  maxStaleMs?: number
  maxEntries?: number
  canonicalizeProjectPath?: (projectPath: string, signal: AbortSignal) => Promise<string>
  setTimer?: typeof setTimeout
  clearTimer?: typeof clearTimeout
  /** Deterministic fake-only barrier immediately before the durable finalization gate. */
  beforeFinalPublication?: () => void | Promise<void>
  /** Deterministic fake-only barrier after commit bytes are written, before sync/rename. */
  beforeVisibilitySync?: () => void | Promise<void>
  /** Deterministic fake-only stage-directory sync fault boundary. */
  beforeStageDirectorySync?: () => void | Promise<void>
  /** Deterministic fake-only post-rename fault boundary. */
  afterCommitVisibility?: () => void | Promise<void>
  allocateAttempt?: (scope: string, startedAt: number) => Readonly<{
    requestGeneration: number
    attemptIdentity: `sha256:${string}`
  }> | Promise<Readonly<{
    requestGeneration: number
    attemptIdentity: `sha256:${string}`
  }>>
}

type CacheIdentity = Readonly<{
  projectPath: string
  providerId: string
  binaryFingerprint: string
  managedConfigFingerprint: string
  selectedAuthBaselineFingerprint: string
}>

type CacheEntry = {
  key: string
  identity: CacheIdentity
  profileRootPath: string
  projectPath: string
  catalog: OpenCodeScopedProviderCatalog
  catalogEvidence: OpenCodeCatalogPublicationEvidence
  catalogObservedAt: number
  catalogExpiresAt: number
  lastUsedAt: number
}

type Options = Readonly<{
  ttlMs: number
  maxStaleMs: number
  timeoutMs: number
  maxEntries: number
}>

type Flight = {
  controller: AbortController
  deadline: number
  abortKind: 'no-waiters' | 'timeout' | null
  settled: boolean
  waiters: Set<symbol>
  promise: Promise<OpenCodeProviderCatalogLoadResult>
  visibleCommit: boolean
}

export class OpenCodeProviderCatalogUnavailableError extends Error {
  readonly code = 'OPENCODE_PROVIDER_CATALOG_UNAVAILABLE' as const
  constructor(readonly outcome: 'superseded' | 'transient' = 'transient') {
    super(FIXED_FAILURE)
    this.name = 'OpenCodeProviderCatalogUnavailableError'
  }
}

function fixedCatalogFailure(
  outcome: 'superseded' | 'transient' = 'transient',
): OpenCodeProviderCatalogUnavailableError {
  return new OpenCodeProviderCatalogUnavailableError(outcome)
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function snapshotRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || nodeUtilTypes.isProxy(value)) return null
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return null
  const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<PropertyKey, PropertyDescriptor>
  if (Reflect.ownKeys(descriptors).some(key => typeof key === 'symbol')) return null
  const result = Object.create(null) as Record<string, unknown>
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (DANGEROUS_KEYS.has(key) || !descriptor.enumerable || !('value' in descriptor)) return null
    result[key] = descriptor.value
  }
  return Object.freeze(result)
}

function closedRecord(
  value: unknown,
  keys: readonly string[],
): Readonly<Record<string, unknown>> | null {
  const record = snapshotRecord(value)
  if (!record || Object.keys(record).length !== keys.length
    || keys.some(key => !Object.prototype.hasOwnProperty.call(record, key))) return null
  return record
}

function boundedString(value: unknown, max = MAX_IDENTITY_STRING): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
}

function inertOwnedClone(value: unknown, budget = { nodes: 0 }, depth = 0): unknown {
  budget.nodes += 1
  if (budget.nodes > 20_000 || depth > 16) throw fixedCatalogFailure()
  if (value === null || value === undefined || typeof value === 'boolean') return value
  if (typeof value === 'string') {
    if (value.length > MAX_IDENTITY_STRING) throw fixedCatalogFailure()
    return value
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw fixedCatalogFailure()
    return value
  }
  if (typeof value !== 'object' || nodeUtilTypes.isProxy(value)) throw fixedCatalogFailure()
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) throw fixedCatalogFailure()
    const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<PropertyKey, PropertyDescriptor>
    if (Reflect.ownKeys(descriptors).some(key => typeof key === 'symbol')) throw fixedCatalogFailure()
    const lengthDescriptor = descriptors.length
    if (!lengthDescriptor || !('value' in lengthDescriptor)
      || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0
      || lengthDescriptor.value > 10_000) throw fixedCatalogFailure()
    const result = new Array<unknown>(lengthDescriptor.value)
    for (let index = 0; index < lengthDescriptor.value; index += 1) {
      const descriptor = descriptors[String(index)]
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw fixedCatalogFailure()
      result[index] = inertOwnedClone(descriptor.value, budget, depth + 1)
    }
    if (Object.keys(descriptors).length !== lengthDescriptor.value + 1) throw fixedCatalogFailure()
    return Object.freeze(result)
  }
  const record = snapshotRecord(value)
  if (!record || Object.keys(record).length > 10_000) throw fixedCatalogFailure()
  const result = Object.create(null) as Record<string, unknown>
  for (const [key, nested] of Object.entries(record)) {
    result[key] = inertOwnedClone(nested, budget, depth + 1)
  }
  return Object.freeze(result)
}

function safeOption(value: unknown, fallback: number, cap: number, allowZero: boolean): number {
  const selected = value === undefined ? fallback : value
  if (typeof selected !== 'number' || !Number.isSafeInteger(selected)
    || selected < (allowZero ? 0 : 1) || selected > cap) throw fixedCatalogFailure()
  return selected
}

function options(deps: OpenCodeProviderCatalogServiceDeps): Options {
  const result = Object.freeze({
    ttlMs: safeOption(deps.ttlMs, DEFAULT_TTL_MS, MAX_TIME_MS, true),
    maxStaleMs: safeOption(deps.maxStaleMs, DEFAULT_MAX_STALE_MS, MAX_TIME_MS, true),
    timeoutMs: safeOption(deps.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, true),
    maxEntries: safeOption(deps.maxEntries, DEFAULT_MAX_ENTRIES, MAX_ENTRIES, true),
  })
  if (result.ttlMs > result.maxStaleMs) throw fixedCatalogFailure()
  return result
}

function snapshotInput(value: unknown): {
  providerId: string
  projectPath?: string | null
  abortSignal?: AbortSignal
} {
  const record = snapshotRecord(value)
  if (!record || !Object.prototype.hasOwnProperty.call(record, 'providerId')
    || Object.keys(record).some(key => !['providerId', 'projectPath', 'abortSignal'].includes(key))
    || typeof record.providerId !== 'string'
    || !(record.projectPath === undefined || record.projectPath === null
      || typeof record.projectPath === 'string')
    || !(record.abortSignal === undefined || record.abortSignal instanceof AbortSignal)) {
    throw fixedCatalogFailure()
  }
  return Object.freeze({
    providerId: record.providerId,
    ...(record.projectPath !== undefined ? { projectPath: record.projectPath as string | null } : {}),
    ...(record.abortSignal !== undefined ? { abortSignal: record.abortSignal as AbortSignal } : {}),
  })
}

function snapshotProfile(value: unknown, providerId: string, expectedProjectPath?: string): {
  preparedProfile: OpenCodeScopedPreparedProfile
  identity: CacheIdentity
  profileRootPath: string
  projectPath: string
} {
  const owned = inertOwnedClone(value)
  const record = snapshotRecord(owned)
  const policy = record ? snapshotRecord(record.policy) : null
  if (!record || !policy || record.scopeSchema !== 'opencode-scoped-profile-v1'
    || record.purpose !== 'provider-catalog' || record.providerId !== providerId
    || policy.inventory !== 'selected-provider-only'
    || policy.inventoryFallback !== 'forbidden'
    || policy.launchAuthorization !== 'forbidden'
    || !boundedString(record.projectPath) || !boundedString(record.profileRootPath)
    || !boundedString(record.binaryFingerprint, 512)
    || !boundedString(record.managedConfigFingerprint, 512)
    || !boundedString(record.selectedAuthBaselineFingerprint, 512)
    || (expectedProjectPath !== undefined && record.projectPath !== expectedProjectPath)) throw fixedCatalogFailure()
  const identity = Object.freeze({
    projectPath: record.projectPath,
    providerId,
    binaryFingerprint: record.binaryFingerprint,
    managedConfigFingerprint: record.managedConfigFingerprint,
    selectedAuthBaselineFingerprint: record.selectedAuthBaselineFingerprint,
  })
  // The manager needs its full object, but every value used by this boundary is
  // the inert snapshot above and is never re-read from the returned object.
  return Object.freeze({
    preparedProfile: owned as OpenCodeScopedPreparedProfile,
    identity,
    profileRootPath: record.profileRootPath,
    projectPath: record.projectPath,
  })
}

function cacheKeyFor(identity: CacheIdentity): string {
  return hash(JSON.stringify([
    identity.projectPath,
    identity.providerId,
    identity.binaryFingerprint,
    identity.managedConfigFingerprint,
    identity.selectedAuthBaselineFingerprint,
  ]))
}

function identityHash(identity: CacheIdentity): string {
  return `sha256:${cacheKeyFor(identity)}`
}

function redactedFingerprint(domain: string, value: string): `sha256:${string}` {
  return `sha256:${hash(`${domain}\0${value}`)}`
}

function boundedIdentityMaterial(values: readonly (string | number)[]): string {
  return values.map(value => `${String(value).length}:${String(value)}`).join('|')
}

function createCatalogPublicationEvidence(
  identity: CacheIdentity,
  allocation: Readonly<{ requestGeneration: number; attemptIdentity: `sha256:${string}` }>,
  startedAt: number,
): OpenCodeCatalogPublicationEvidence {
  const binaryFingerprint = redactedFingerprint('opencode-catalog-binary-v1', identity.binaryFingerprint)
  const configFingerprint = redactedFingerprint('opencode-catalog-config-v1', identity.managedConfigFingerprint)
  const authFingerprint = redactedFingerprint('opencode-catalog-auth-v1', identity.selectedAuthBaselineFingerprint)
  return Object.freeze({
    providerId: identity.providerId,
    requestGeneration: allocation.requestGeneration,
    startedAt,
    attemptIdentity: allocation.attemptIdentity,
    binaryFingerprint,
    configFingerprint,
    authFingerprint,
  })
}

type ManagedRootReceipt = Readonly<{
  path: string
  identities: readonly Readonly<{ path: string; dev: bigint; ino: bigint }>[]
}>

function assertAbsoluteManagedPath(value: string, label: string): string {
  if (!value || value !== value.trim() || !path.isAbsolute(value)) {
    void label
    throw fixedCatalogFailure()
  }
  return path.normalize(value)
}

function captureManagedRootSync(rootPath: string): ManagedRootReceipt {
  const absolute = assertAbsoluteManagedPath(rootPath, 'OpenCode catalog cache root')
  const parsed = path.parse(absolute)
  const relativeParts = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)
  let cursor = parsed.root
  const identities: Array<{ path: string; dev: bigint; ino: bigint }> = []
  for (const [index, part] of relativeParts.entries()) {
    cursor = path.join(cursor, part)
    try {
      const metadata = lstatSync(cursor, { bigint: true })
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw fixedCatalogFailure()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw fixedCatalogFailure()
      mkdirSync(cursor, { mode: 0o700 })
    }
    const metadata = lstatSync(cursor, { bigint: true })
    const currentUid = typeof process.getuid === 'function' ? BigInt(process.getuid()) : null
    const ownedByCurrent = currentUid === null || metadata.uid === currentUid
    const safeAncestorOwner = ownedByCurrent || metadata.uid === 0n
    const unsafeForeignWritable = !ownedByCurrent
      && (metadata.mode & 0o022n) !== 0n && (metadata.mode & 0o1000n) === 0n
    if (!metadata.isDirectory() || metadata.isSymbolicLink()
      || realpathSync(cursor) !== path.resolve(cursor)
      || !safeAncestorOwner || unsafeForeignWritable
      || (index === relativeParts.length - 1 && !ownedByCurrent)) {
      throw fixedCatalogFailure()
    }
    identities.push({ path: cursor, dev: metadata.dev, ino: metadata.ino })
  }
  const receipt = Object.freeze({ path: absolute, identities: Object.freeze(identities) })
  assertManagedRootReceiptSync(receipt)
  return receipt
}

function assertManagedRootReceiptSync(receipt: ManagedRootReceipt): void {
  const expected = receipt.identities.at(-1)
  if (!expected) throw fixedCatalogFailure()
  const actual = lstatSync(expected.path, { bigint: true })
  if (!actual.isDirectory() || actual.isSymbolicLink()
    || actual.dev !== expected.dev || actual.ino !== expected.ino) throw fixedCatalogFailure()
}

function openManagedRootDescriptor(receipt: ManagedRootReceipt): { fd: number | null; path: string } {
  assertManagedRootReceiptSync(receipt)
  if (process.platform === 'win32') return { fd: null, path: receipt.path }
  if (process.platform !== 'linux' && process.platform !== 'darwin') throw fixedCatalogFailure()
  const fd = openSync(receipt.path,
    fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0))
  try {
    const actual = fstatSync(fd, { bigint: true })
    const expected = receipt.identities.at(-1)
    if (!expected || !actual.isDirectory() || actual.dev !== expected.dev || actual.ino !== expected.ino) {
      throw fixedCatalogFailure()
    }
    return { fd, path: `${process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd'}/${fd}` }
  } catch (error) {
    closeSync(fd)
    throw error
  }
}

function isSqliteBusy(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const code = Object.getOwnPropertyDescriptor(error, 'code')?.value
  return code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED'
}

function normalizeSqliteSchema(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().replace(/;$/, '')
}

function assertAttemptDatabaseChildren(rootReceipt: ManagedRootReceipt): void {
  assertManagedRootReceiptSync(rootReceipt)
  for (const name of ['attempts.sqlite', 'attempts.sqlite-journal']) {
    const child = path.join(rootReceipt.path, name)
    try {
      const metadata = lstatSync(child)
      if (!metadata.isFile() || metadata.isSymbolicLink()
        || (typeof process.getuid === 'function' && metadata.uid !== process.getuid())) {
        throw fixedCatalogFailure()
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  for (const forbidden of ['attempts.sqlite-wal', 'attempts.sqlite-shm']) {
    if (existsSync(path.join(rootReceipt.path, forbidden))) throw fixedCatalogFailure()
  }
}

function latestDurableAdmission(): AdmissionHead | null {
  const root = captureManagedRootSync(path.join(
    catalogCacheHome(), 'opencode', 'provider-catalog-attempts-v2',
  ))
  const database = openAttemptDatabase(root)
  validateAttemptDatabase(database)
  const latest = database.query<{ id: number; scope_hash: string; cache_key: string | null }, []>(
    'SELECT id, scope_hash, cache_key FROM allocation_ticket ORDER BY id DESC LIMIT 1',
  ).get()
  if (!latest || !Number.isSafeInteger(latest.id) || latest.id < 1
    || !/^[0-9a-f]{64}$/.test(latest.scope_hash)) return null
  if (latest.cache_key !== null && !/^[0-9a-f]{64}$/.test(latest.cache_key)) {
    throw fixedCatalogFailure()
  }
  return { generation: latest.id, scopeHash: latest.scope_hash,
    ...(latest.cache_key ? { cacheKey: latest.cache_key } : {}) }
}

function bindDurableAdmission(generation: number, scopeHash: string, cacheKey: string): void {
  const receipt = captureManagedRootSync(path.join(
    catalogCacheHome(), 'opencode', 'provider-catalog-attempts-v2',
  ))
  const database = openAttemptDatabase(receipt)
  try {
    database.exec('BEGIN IMMEDIATE')
    validateAttemptDatabase(database)
    const changed = database.query(`UPDATE allocation_ticket SET cache_key = ?1
      WHERE id = ?2 AND scope_hash = ?3 AND (cache_key IS NULL OR cache_key = ?1)`)
      .run(cacheKey, generation, scopeHash)
    if (changed.changes !== 1) throw fixedCatalogFailure()
    database.exec('COMMIT')
  } catch (error) {
    try { database.exec('ROLLBACK') } catch {}
    throw error
  }
}

function validateAttemptDatabase(database: Database): number {
  const version = database.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version
  const objects = database.query<{ type: string; name: string; tbl_name: string; sql: string | null }, []>(`
    SELECT type, name, tbl_name, sql FROM sqlite_schema
    WHERE name NOT LIKE 'sqlite_autoindex_%' ORDER BY type, name
  `).all()
  if (version === 0 && objects.length === 0) {
    try {
      database.exec('BEGIN IMMEDIATE')
      const currentVersion = database.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version
      const currentObjects = database.query<{ count: number }, []>(`
        SELECT count(*) AS count FROM sqlite_schema WHERE name NOT LIKE 'sqlite_autoindex_%'
      `).get()?.count
      if (currentVersion !== 0 || currentObjects !== 0) throw fixedCatalogFailure()
      database.exec(`${ATTEMPT_TABLE_SQL}; ${ATTEMPT_STATE_SQL}; ${CATALOG_ENTRY_SQL};
        INSERT INTO allocation_state(singleton, generation) VALUES (1, 0);
        PRAGMA user_version = ${ATTEMPT_SCHEMA_VERSION}; COMMIT`)
    } catch (error) {
      try { database.exec('ROLLBACK') } catch {}
      throw error
    }
  } else if (version !== ATTEMPT_SCHEMA_VERSION) {
    throw fixedCatalogFailure()
  }
  const validatedObjects = database.query<{ type: string; name: string; tbl_name: string; sql: string | null }, []>(`
    SELECT type, name, tbl_name, sql FROM sqlite_schema
    WHERE name NOT LIKE 'sqlite_autoindex_%' ORDER BY type, name
  `).all()
  if (validatedObjects.length !== 4) throw fixedCatalogFailure()
  const allocation = validatedObjects.find(object => object.name === 'allocation_ticket')
  const state = validatedObjects.find(object => object.name === 'allocation_state')
  const sequence = validatedObjects.find(object => object.name === 'sqlite_sequence')
  const catalog = validatedObjects.find(object => object.name === 'catalog_entry')
  if (!allocation || allocation.type !== 'table' || allocation.tbl_name !== 'allocation_ticket'
    || typeof allocation.sql !== 'string'
    || normalizeSqliteSchema(allocation.sql) !== normalizeSqliteSchema(ATTEMPT_TABLE_SQL)
    || !state || state.type !== 'table' || state.tbl_name !== 'allocation_state'
    || typeof state.sql !== 'string'
    || normalizeSqliteSchema(state.sql) !== normalizeSqliteSchema(ATTEMPT_STATE_SQL)
    || !catalog || catalog.type !== 'table' || catalog.tbl_name !== 'catalog_entry'
    || typeof catalog.sql !== 'string'
    || normalizeSqliteSchema(catalog.sql) !== normalizeSqliteSchema(CATALOG_ENTRY_SQL)
    || !sequence || sequence.type !== 'table' || sequence.tbl_name !== 'sqlite_sequence'
    || sequence.sql !== 'CREATE TABLE sqlite_sequence(name,seq)'
    || validatedObjects.some(object => object.type === 'trigger' || object.type === 'index')) {
    throw fixedCatalogFailure()
  }
  const columns = database.query<{
    name: string; type: string; notnull: number; pk: number
  }, []>('PRAGMA table_info(allocation_ticket)').all()
  if (JSON.stringify(columns.map(column => [column.name, column.type, column.notnull, column.pk]))
    !== JSON.stringify([['id', 'INTEGER', 0, 1], ['scope_hash', 'TEXT', 1, 0],
      ['started_at', 'INTEGER', 1, 0], ['cache_key', 'TEXT', 0, 0]])) {
    throw fixedCatalogFailure()
  }
  const stateColumns = database.query<{
    name: string; type: string; notnull: number; pk: number
  }, []>('PRAGMA table_info(allocation_state)').all()
  if (JSON.stringify(stateColumns.map(column => [column.name, column.type, column.notnull, column.pk]))
    !== JSON.stringify([['singleton', 'INTEGER', 0, 1], ['generation', 'INTEGER', 1, 0]])) {
    throw fixedCatalogFailure()
  }
  const catalogColumns = database.query<{
    name: string; type: string; notnull: number; pk: number
  }, []>('PRAGMA table_info(catalog_entry)').all()
  if (JSON.stringify(catalogColumns.map(column => [column.name, column.type, column.notnull, column.pk]))
    !== JSON.stringify([['cache_key', 'TEXT', 0, 1], ['request_generation', 'INTEGER', 1, 0],
      ['attempt_identity', 'TEXT', 1, 0], ['attempt_id', 'TEXT', 1, 0],
      ['pointer_json', 'TEXT', 1, 0], ['envelope_json', 'TEXT', 1, 0],
      ['retained_order', 'INTEGER', 1, 0]])) throw fixedCatalogFailure()
  const ledger = database.query<{
    generation: number; count: number; minimum: number | null; maximum: number | null; total: number | null
  }, []>(`SELECT s.generation, count(t.id) AS count, min(t.id) AS minimum,
      max(t.id) AS maximum, sum(t.id) AS total
    FROM allocation_state s LEFT JOIN allocation_ticket t ON true
    WHERE s.singleton = 1 GROUP BY s.generation`).get()
  const sequences = database.query<{ name: string; seq: number }, []>(
    'SELECT name, seq FROM sqlite_sequence ORDER BY name',
  ).all()
  if (!ledger || !Number.isSafeInteger(ledger.generation) || ledger.generation < 0
    || sequences.some(sequenceRow => sequenceRow.name !== 'allocation_ticket')
    || (ledger.generation === 0
      ? ledger.count !== 0 || sequences.length !== 0
      : (() => {
        const expectedCount = Math.min(ATTEMPT_ROW_CAPACITY, ledger.generation)
        const expectedMinimum = ledger.generation - expectedCount + 1
        const expectedTotal = expectedCount * (expectedMinimum + ledger.generation) / 2
        return ledger.count !== expectedCount || ledger.minimum !== expectedMinimum
          || ledger.maximum !== ledger.generation || ledger.total !== expectedTotal
          || sequences.length !== 1 || sequences[0]?.seq !== ledger.generation
      })())) throw fixedCatalogFailure()
  const integrity = database.query<{ quick_check: string }, []>('PRAGMA quick_check(1)').get()?.quick_check
  if (integrity !== 'ok') throw fixedCatalogFailure()
  const schemaVersion = database.query<{ schema_version: number }, []>('PRAGMA schema_version').get()?.schema_version
  if (!Number.isSafeInteger(schemaVersion) || (schemaVersion as number) < 1) throw fixedCatalogFailure()
  return schemaVersion as number
}

function openAttemptDatabase(rootReceipt: ManagedRootReceipt): Database {
  const databasePath = path.join(rootReceipt.path, 'attempts.sqlite')
  if (durableAttemptDatabase?.filePath === databasePath) {
    assertManagedRootReceiptSync(durableAttemptDatabase.rootReceipt)
    const held = fstatSync(durableAttemptDatabase.databaseDescriptor, { bigint: true })
    const named = lstatSync(databasePath, { bigint: true })
    if (!held.isFile() || !named.isFile() || named.isSymbolicLink()
      || held.dev !== named.dev || held.ino !== named.ino) throw fixedCatalogFailure()
    const heldJournal = fstatSync(durableAttemptDatabase.journalDescriptor, { bigint: true })
    const namedJournal = lstatSync(`${databasePath}-journal`, { bigint: true })
    if (!heldJournal.isFile() || !namedJournal.isFile() || namedJournal.isSymbolicLink()
      || heldJournal.dev !== namedJournal.dev || heldJournal.ino !== namedJournal.ino) {
      throw fixedCatalogFailure()
    }
    assertAttemptDatabaseChildren(rootReceipt)
    return durableAttemptDatabase.database
  }
  durableAttemptDatabase?.database.close()
  if (durableAttemptDatabase) closeSync(durableAttemptDatabase.databaseDescriptor)
  if (durableAttemptDatabase) closeSync(durableAttemptDatabase.journalDescriptor)
  if (durableAttemptDatabase?.rootDescriptor !== null
    && durableAttemptDatabase?.rootDescriptor !== undefined) closeSync(durableAttemptDatabase.rootDescriptor)
  durableAttemptDatabase = null
  assertManagedRootReceiptSync(rootReceipt)
  assertAttemptDatabaseChildren(rootReceipt)
  const descriptor = openManagedRootDescriptor(rootReceipt)
  let databaseDescriptor: number | null = null
  let journalDescriptor: number | null = null
  let database: Database | null = null
  try {
    databaseDescriptor = openSync(path.join(descriptor.path, 'attempts.sqlite'),
      fsConstants.O_RDWR | fsConstants.O_CREAT | (fsConstants.O_NOFOLLOW ?? 0), 0o600)
    const heldBefore = fstatSync(databaseDescriptor, { bigint: true })
    if (!heldBefore.isFile() || (typeof process.getuid === 'function'
      && heldBefore.uid !== BigInt(process.getuid()))) throw fixedCatalogFailure()
    journalDescriptor = openSync(path.join(descriptor.path, 'attempts.sqlite-journal'),
      fsConstants.O_RDWR | fsConstants.O_CREAT | (fsConstants.O_NOFOLLOW ?? 0), 0o600)
    const heldJournal = fstatSync(journalDescriptor, { bigint: true })
    if (!heldJournal.isFile() || (typeof process.getuid === 'function'
      && heldJournal.uid !== BigInt(process.getuid()))) throw fixedCatalogFailure()
    // SQLite opens the exact already-held inode. Its VFS canonicalizes this
    // descriptor reference for WAL/journal siblings beneath the held root.
    database = new Database(
      `${process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd'}/${databaseDescriptor}`,
      { create: false, strict: true },
    )
    const namedAfterOpen = lstatSync(databasePath, { bigint: true })
    if (!namedAfterOpen.isFile() || namedAfterOpen.isSymbolicLink()
      || namedAfterOpen.dev !== heldBefore.dev || namedAfterOpen.ino !== heldBefore.ino) {
      throw fixedCatalogFailure()
    }
    assertAttemptDatabaseChildren(rootReceipt)
    database.exec('PRAGMA busy_timeout = 0')
    const journalMode = database.query<{ journal_mode: string }, []>('PRAGMA journal_mode = PERSIST')
      .get()?.journal_mode
    if (journalMode?.toLowerCase() !== 'persist') throw fixedCatalogFailure()
    database.exec('PRAGMA synchronous = FULL')
    assertAttemptDatabaseChildren(rootReceipt)
    const schemaVersion = validateAttemptDatabase(database)
    durableAttemptDatabase = {
      filePath: databasePath, database, rootReceipt, rootDescriptor: descriptor.fd,
      databaseDescriptor, journalDescriptor, schemaVersion,
    }
    return database
  } catch (error) {
    database?.close()
    if (databaseDescriptor !== null) closeSync(databaseDescriptor)
    if (journalDescriptor !== null) closeSync(journalDescriptor)
    if (descriptor.fd !== null) closeSync(descriptor.fd)
    throw error
  }
}

/**
 * Cross-process monotonic allocation backed by one bounded global sequence.
 * SQLite lock waits are disabled; contention retries yield to the event loop
 * and are bounded by the caller's exact remaining attempt budget.
 */
export async function runOpenCodeProviderCatalogAttemptAllocationWorkerOperation(
  scope: string,
  startedAt: number,
  controls: Readonly<{
    deadline?: number
    abortSignal?: AbortSignal
    cacheHome?: string
    windowsPlatformAuthority?: boolean
    testStallPhase?: 'open' | 'commit' | 'after-commit'
    testGate?: Readonly<{ phase: 'open' | 'commit' | 'after-commit'; path: string }>
  }> = {},
): Promise<Readonly<{
  requestGeneration: number
  attemptIdentity: `sha256:${string}`
}>> {
  const deadline = controls.deadline ?? Number.POSITIVE_INFINITY
  if (!boundedString(scope) || !Number.isSafeInteger(startedAt) || startedAt < 0) throw fixedCatalogFailure()
  const cacheHome = controls.cacheHome ?? catalogCacheHome()
  const root = path.join(cacheHome, 'opencode', 'provider-catalog-attempts-v2')
  const expectedDatabasePath = path.join(root, 'attempts.sqlite')
  const rootReceipt = durableAttemptDatabase?.filePath === expectedDatabasePath
    ? durableAttemptDatabase.rootReceipt
    : captureManagedRootSync(root)
  const workerBoundary = (phase: 'open' | 'commit' | 'after-commit'): void => {
    if (controls.testStallPhase === phase) {
      const state = new Int32Array(new SharedArrayBuffer(4))
      Atomics.wait(state, 0, 0)
    }
    if (controls.testGate?.phase === phase) {
      writeFileSync(`${controls.testGate.path}.entered`, '', { flag: 'wx', mode: 0o600 })
      const sleeper = new Int32Array(new SharedArrayBuffer(4))
      while (!existsSync(`${controls.testGate.path}.release`)) Atomics.wait(sleeper, 0, 0, 1)
    }
  }
  for (;;) {
    if (controls.abortSignal?.aborted || performance.now() >= deadline) throw fixedCatalogFailure()
    let database: Database | null = null
    try {
      workerBoundary('open')
      // The deterministic race hook above is before the final child check, so
      // a path swap is rejected before SQLite is allowed to open or mutate it.
      assertAttemptDatabaseChildren(rootReceipt)
      database = openAttemptDatabase(rootReceipt)
      const current = database.query<{ user_version: number; schema_version: number }, []>(`
        SELECT user_version, schema_version FROM pragma_user_version(), pragma_schema_version()
      `).get()
      if (current?.user_version !== ATTEMPT_SCHEMA_VERSION) throw fixedCatalogFailure()
      if (current.schema_version !== durableAttemptDatabase?.schemaVersion) {
        const validated = validateAttemptDatabase(database)
        if (durableAttemptDatabase) durableAttemptDatabase.schemaVersion = validated
      }
      if (performance.now() >= deadline) throw fixedCatalogFailure()
      database.exec('BEGIN IMMEDIATE')
      // Revalidate inside the same write transaction that advances the
      // allocator. A reset sequence, deleted ticket or forged retained row can
      // never be accepted between the outer validation and commit.
      validateAttemptDatabase(database)
      const state = database.query<{ generation: number }, []>(
        'SELECT generation FROM allocation_state WHERE singleton = 1',
      ).get()
      if (!state || !Number.isSafeInteger(state.generation) || state.generation < 0) {
        throw fixedCatalogFailure()
      }
      const row = database.query<{ id: number }, [string, number]>(`
        INSERT INTO allocation_ticket(scope_hash, started_at) VALUES (?1, ?2)
        RETURNING id
      `).get(hash(scope), startedAt)
      if (!row || !Number.isSafeInteger(row.id) || row.id !== state.generation + 1) {
        throw fixedCatalogFailure()
      }
      const advanced = database.query(
        'UPDATE allocation_state SET generation = ?1 WHERE singleton = 1 AND generation = ?2',
      ).run(row.id, state.generation)
      if (advanced.changes !== 1) throw fixedCatalogFailure()
      database.query('DELETE FROM allocation_ticket WHERE id <= ?1').run(
        Math.max(0, row.id - ATTEMPT_ROW_CAPACITY),
      )
      validateAttemptDatabase(database)
      workerBoundary('commit')
      // This is the last path boundary before the SQLite commit can create or
      // update a journal/WAL sidecar. Reject a child or managed-root swap here;
      // POSIX then continues through the held descriptor-root path.
      assertManagedRootReceiptSync(rootReceipt)
      assertAttemptDatabaseChildren(rootReceipt)
      if (controls.abortSignal?.aborted || performance.now() >= deadline) {
        throw fixedCatalogFailure()
      }
      database.exec('COMMIT')
      workerBoundary('after-commit')
      const attemptIdentity = redactedFingerprint('opencode-catalog-attempt-v3', boundedIdentityMaterial([
        scope, row.id, startedAt, randomUUID(),
      ]))
      return Object.freeze({ requestGeneration: row.id, attemptIdentity })
    } catch (error) {
      try { database?.exec('ROLLBACK') } catch { /* transaction was not open */ }
      if (!isSqliteBusy(error) || controls.abortSignal?.aborted || performance.now() >= deadline) {
        throw fixedCatalogFailure()
      }
      await new Promise<void>(resolve => setTimeout(resolve, 0))
    }
  }
}

type AllocationWorkerReply = Readonly<{
  id: string
  result?: Readonly<{ requestGeneration: number; attemptIdentity: `sha256:${string}` }>
  failed?: true
}>

type AllocationWorkerProcess = Readonly<{
  pid: number
  stdin: { write(value: string): number; end(): void }
  stdout: ReadableStream<Uint8Array>
  exited: Promise<number>
  kill(signal?: number | NodeJS.Signals): void
  unref(): void
  executableFds?: readonly number[]
}>

let allocationWorker: AllocationWorkerProcess | null = null
let allocationWorkerTermination: Promise<void> = Promise.resolve()
let allocationWorkerTerminating = false
let allocationWorkerTerminationEpoch = 0
let allocationWorkerActiveId: string | null = null
let allocationWorkerIdleTimer: ReturnType<typeof setTimeout> | null = null
const allocationWorkerRequests = new Map<string, {
  resolve(value: Readonly<{ requestGeneration: number; attemptIdentity: `sha256:${string}` }>): void
  reject(): void
  timer: ReturnType<typeof setTimeout>
  abortSignal?: AbortSignal
  abortListener?: () => void
  payload: Readonly<{
    id: string
    scope: string
    startedAt: number
    budgetMs: number
    cacheHome: string
    windowsPlatformAuthority: boolean
    testStallPhase?: 'open' | 'commit' | 'after-commit'
    testGate?: Readonly<{ phase: 'open' | 'commit' | 'after-commit'; path: string }>
  }>
}>()

function terminateAllocationWorker(): void {
  if (allocationWorkerIdleTimer) clearTimeout(allocationWorkerIdleTimer)
  allocationWorkerIdleTimer = null
  const worker = allocationWorker
  allocationWorker = null
  const activeId = allocationWorkerActiveId
  allocationWorkerActiveId = null
  if (worker) {
    allocationWorkerTerminating = true
    allocationWorkerTerminationEpoch += 1
    try { worker.stdin.end() } catch {}
    try { worker.kill('SIGKILL') } catch {}
    const terminated = new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        try { process.kill(worker.pid, 'SIGKILL') } catch {}
        resolve()
      }, 250)
      timer.unref?.()
      void worker.exited.then(
        () => { clearTimeout(timer); resolve() },
        () => { clearTimeout(timer); resolve() },
      )
    })
    allocationWorkerTermination = Promise.all([
      allocationWorkerTermination.catch(() => undefined), terminated,
    ]).then(() => undefined)
  }
  if (activeId) {
    const request = allocationWorkerRequests.get(activeId)
    if (request) {
      allocationWorkerRequests.delete(activeId)
      clearTimeout(request.timer)
      if (request.abortSignal && request.abortListener) {
        request.abortSignal.removeEventListener('abort', request.abortListener)
      }
      request.reject()
    }
  }
  const terminationEpoch = allocationWorkerTerminationEpoch
  void allocationWorkerTermination.then(() => {
    if (terminationEpoch !== allocationWorkerTerminationEpoch) return
    allocationWorkerTerminating = false
    pumpAllocationWorker()
  })
}

function pumpAllocationWorker(): void {
  if (allocationWorkerIdleTimer) clearTimeout(allocationWorkerIdleTimer)
  allocationWorkerIdleTimer = null
  if (allocationWorkerActiveId || allocationWorkerTerminating) return
  const next = allocationWorkerRequests.entries().next().value as
    | [string, (typeof allocationWorkerRequests extends Map<string, infer V> ? V : never)]
    | undefined
  if (!next) return
  const [id, request] = next
  allocationWorkerActiveId = id
  try {
    getAllocationWorker().stdin.write(`${JSON.stringify(request.payload)}\n`)
  } catch {
    terminateAllocationWorker()
  }
}

function acceptAllocationWorkerReply(unsafeReply: unknown): void {
  const reply = snapshotRecord(unsafeReply) as AllocationWorkerReply | null
  if (!reply || typeof reply.id !== 'string') return terminateAllocationWorker()
  const request = allocationWorkerRequests.get(reply.id)
  if (!request || allocationWorkerActiveId !== reply.id) return terminateAllocationWorker()
  if (reply.failed || !reply.result) {
    // A failed native/schema operation cannot leave a cached SQLite handle
    // or transaction in the authority process. SIGKILL is the preemptible
    // cleanup boundary; a repaired request starts in a fresh authority.
    terminateAllocationWorker()
    return
  }
  allocationWorkerRequests.delete(reply.id)
  allocationWorkerActiveId = null
  clearTimeout(request.timer)
  if (request.abortSignal && request.abortListener) {
    request.abortSignal.removeEventListener('abort', request.abortListener)
  }
  request.resolve(reply.result)
  if (allocationWorkerRequests.size > 0) pumpAllocationWorker()
  else {
    allocationWorkerIdleTimer = setTimeout(terminateAllocationWorker, 25)
    allocationWorkerIdleTimer.unref?.()
  }
}

function getAllocationWorker(): AllocationWorkerProcess {
  if (allocationWorker) return allocationWorker
  const sourceRuntime = /(?:^|[\\/])bun(?:\.exe)?$/i.test(process.execPath)
  const workerPath = fileURLToPath(new URL(
    import.meta.url.endsWith('.ts')
      ? './OpenCodeProviderCatalogAllocationWorker.ts'
      : './OpenCodeProviderCatalogAllocationWorker.js',
    import.meta.url,
  ))
  const executableFds: number[] = []
  let workerCommand: string[]
  if (sourceRuntime) {
    workerCommand = [process.execPath, workerPath]
  } else {
    if (process.platform !== 'linux' && process.platform !== 'darwin' && process.platform !== 'win32') {
      throw fixedCatalogFailure()
    }
    const packagedWorker = path.join(path.dirname(process.execPath),
      `opencode-catalog-allocation-worker${process.platform === 'win32' ? '.exe' : ''}`)
    const workerFd = openSync(packagedWorker,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
    try {
      const held = fstatSync(workerFd, { bigint: true })
      const named = lstatSync(packagedWorker, { bigint: true })
      if (!held.isFile() || !named.isFile() || named.isSymbolicLink()
        || held.dev !== named.dev || held.ino !== named.ino
        || (typeof process.getuid === 'function' && held.uid !== BigInt(process.getuid()))) {
        throw fixedCatalogFailure()
      }
      executableFds.push(workerFd)
      workerCommand = process.platform === 'win32'
        ? [packagedWorker]
        : [`${process.platform === 'linux' ? `/proc/${process.pid}/fd` : '/dev/fd'}/${workerFd}`]
    } catch (error) {
      closeSync(workerFd)
      throw error
    }
  }
  const worker = Bun.spawn({
    cmd: workerCommand,
    stdin: 'pipe', stdout: 'pipe', stderr: 'ignore',
  }) as unknown as AllocationWorkerProcess
  ;(worker as { executableFds?: number[] }).executableFds = executableFds
  worker.unref()
  allocationWorker = worker
  void (async () => {
    const reader = worker.stdout.getReader()
    const decoder = new TextDecoder()
    let pending = ''
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        pending += decoder.decode(chunk.value, { stream: true })
        for (;;) {
          const newline = pending.indexOf('\n')
          if (newline < 0) break
          const line = pending.slice(0, newline)
          pending = pending.slice(newline + 1)
          if (!line) continue
          try { acceptAllocationWorkerReply(JSON.parse(line)) }
          catch { terminateAllocationWorker() }
        }
      }
    } catch {}
  })()
  void worker.exited.then(() => {
    for (const fd of worker.executableFds ?? []) {
      try { closeSync(fd) } catch {}
    }
    if (allocationWorker === worker) terminateAllocationWorker()
  })
  return worker
}

/**
 * Runs every synchronous SQLite open/schema/check/transaction/commit in a
 * terminable worker. The caller's event loop retains ownership of the absolute
 * deadline and can preempt a native call instead of checking elapsed time only
 * after that call eventually returns.
 */
export function allocateOpenCodeProviderCatalogAttempt(
  scope: string,
  startedAt: number,
  controls: Readonly<{
    deadline?: number
    abortSignal?: AbortSignal
    /** Deterministic worker-boundary fault injection; test code only. */
    testStallPhase?: 'open' | 'commit' | 'after-commit'
    /** Deterministic no-follow swap gate; test code only. */
    testGate?: Readonly<{ phase: 'open' | 'commit' | 'after-commit'; path: string }>
    /** Explicit deterministic sandbox authority; test code only. */
    cacheHome?: string
  }> = {},
): Promise<Readonly<{
  requestGeneration: number
  attemptIdentity: `sha256:${string}`
}>> {
  if (!boundedString(scope) || !Number.isSafeInteger(startedAt) || startedAt < 0
    || controls.abortSignal?.aborted) return Promise.reject(fixedCatalogFailure())
  let cacheHome: string
  try {
    cacheHome = controls.cacheHome === undefined
      ? catalogCacheHome()
      : assertAbsoluteManagedPath(controls.cacheHome, 'OpenCode catalog test cache home')
  } catch { return Promise.reject(fixedCatalogFailure()) }
  const remaining = Math.max(0, Math.min(
    MAX_TIMEOUT_MS,
    (controls.deadline ?? performance.now() + DEFAULT_TIMEOUT_MS) - performance.now(),
  ))
  if (remaining <= 0) return Promise.reject(fixedCatalogFailure())
  return new Promise((resolve, reject) => {
    const id = randomUUID()
    const rejectFixed = () => reject(fixedCatalogFailure())
    const timer = setTimeout(() => {
      if (!allocationWorkerRequests.has(id)) return
      // A native call may have stalled the worker. Termination is the bounded,
      // preemptible cleanup boundary and rejects every queued owner safely.
      if (allocationWorkerActiveId === id) terminateAllocationWorker()
      else {
        const queued = allocationWorkerRequests.get(id)
        allocationWorkerRequests.delete(id)
        if (queued?.abortSignal && queued.abortListener) {
          queued.abortSignal.removeEventListener('abort', queued.abortListener)
        }
        queued?.reject()
      }
    }, remaining)
    timer.unref?.()
    const request = {
      resolve,
      reject: rejectFixed,
      timer,
      abortSignal: controls.abortSignal,
      abortListener: undefined as (() => void) | undefined,
      payload: {
        id, scope, startedAt, budgetMs: remaining, cacheHome,
        windowsPlatformAuthority: controls.cacheHome === undefined,
        testStallPhase: controls.testStallPhase,
        testGate: controls.testGate,
      },
    }
    if (controls.abortSignal) {
      request.abortListener = () => {
        if (!allocationWorkerRequests.has(id)) return
        if (allocationWorkerActiveId === id) terminateAllocationWorker()
        else {
          allocationWorkerRequests.delete(id)
          clearTimeout(request.timer)
          request.reject()
        }
      }
      controls.abortSignal.addEventListener('abort', request.abortListener, { once: true })
    }
    allocationWorkerRequests.set(id, request)
    pumpAllocationWorker()
  })
}

function catalogCacheHome(): string {
  const explicit = Object.prototype.hasOwnProperty.call(process.env, 'CLAUDE_MULTIMODEL_CACHE_HOME')
    ? process.env.CLAUDE_MULTIMODEL_CACHE_HOME : undefined
  if (explicit !== undefined) return assertAbsoluteManagedPath(explicit, 'CLAUDE_MULTIMODEL_CACHE_HOME')
  const selected = process.platform === 'win32'
      ? path.join(process.env.LOCALAPPDATA ?? os.tmpdir(), 'claude-multimodel-nodejs', 'Cache')
      : process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Caches', 'claude-multimodel-nodejs')
        : path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache'), 'claude-multimodel-nodejs')
  return assertAbsoluteManagedPath(selected, 'OpenCode catalog cache home')
}

// Uncommitted catalog bytes are deliberately attempt-local. The only durable
// representation is the catalog_entry row committed together with its global
// admission fence in the allocator database.
const stagedCatalogEnvelopes = new Map<string, string>()

function catalogAuthorityDatabase(): Database {
  const root = captureManagedRootSync(path.join(
    catalogCacheHome(), 'opencode', 'provider-catalog-attempts-v2',
  ))
  const database = openAttemptDatabase(root)
  validateAttemptDatabase(database)
  return database
}

function pathContains(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function assertCatalogRootOutsideProject(projectPath: string): void {
  const cacheHome = catalogCacheHome()
  if (pathContains(projectPath, cacheHome)) throw fixedCatalogFailure()
}

function stageStorageKey(cacheKey: string, attemptId: string): string {
  return `${cacheKey}.stage.${attemptId}`
}

function pointerStorageKey(cacheKey: string): string {
  return `${cacheKey}.current`
}

async function defaultReadPointer(cacheKey: string): Promise<unknown | null> {
  const row = catalogAuthorityDatabase().query<{ pointer_json: string }, [string]>(
    'SELECT pointer_json FROM catalog_entry WHERE cache_key = ?1',
  ).get(cacheKey)
  if (!row) return null
  try { return JSON.parse(row.pointer_json) as unknown } catch { return null }
}

async function defaultReadStage(cacheKey: string, attemptId: string): Promise<unknown | null> {
  const local = stagedCatalogEnvelopes.get(`${cacheKey}\0${attemptId}`)
  if (local !== undefined) {
    try { return JSON.parse(local) as unknown } catch { return null }
  }
  const row = catalogAuthorityDatabase().query<{ envelope_json: string }, [string, string]>(
    'SELECT envelope_json FROM catalog_entry WHERE cache_key = ?1 AND attempt_id = ?2',
  ).get(cacheKey, attemptId)
  if (!row) return null
  try { return JSON.parse(row.envelope_json) as unknown } catch { return null }
}

async function defaultStagePersisted(
  cacheKey: string,
  attemptId: string,
  value: unknown,
  beforeDirectorySync?: () => void | Promise<void>,
): Promise<void> {
  const encoded = JSON.stringify(value)
  if (new TextEncoder().encode(encoded).byteLength > MAX_PERSISTED_BYTES) throw fixedCatalogFailure()
  await beforeDirectorySync?.()
  stagedCatalogEnvelopes.set(`${cacheKey}\0${attemptId}`, encoded)
}

/**
 * The allocator row and the complete immutable catalog value are committed by
 * one SQLite transaction. There is no pathname lock, stage file, pointer file,
 * rollback rename, or allocator marker to recover after a crash.
 */
async function publishCatalogAuthority(
  cacheKey: string,
  value: unknown,
  maxEntries: number,
  abortSignal?: AbortSignal,
  deadline = Number.POSITIVE_INFINITY,
  beforeVisibility?: () => void | Promise<void>,
  afterCommitVisibility?: () => void | Promise<void>,
  onVisibleCommit?: () => void,
  validateDurableAdmission = true,
): Promise<boolean> {
  const pointer = decodeCommittedPointer(value)
  if (!pointer) throw fixedCatalogFailure()
  const stageKey = `${cacheKey}\0${pointer.attemptId}`
  const envelope = stagedCatalogEnvelopes.get(stageKey)
  if (envelope === undefined || new TextEncoder().encode(envelope).byteLength > MAX_PERSISTED_BYTES) {
    throw fixedCatalogFailure()
  }
  // Every injected/fallible/awaited phase is complete before BEGIN. The COMMIT
  // below is the only visibility point and its success is never revoked.
  await beforeVisibility?.()
  if (abortSignal?.aborted || performance.now() >= deadline) throw fixedCatalogFailure()
  const encodedPointer = JSON.stringify(pointer)
  for (;;) {
    if (abortSignal?.aborted || performance.now() >= deadline) throw fixedCatalogFailure()
    const database = catalogAuthorityDatabase()
    try {
      database.exec('BEGIN IMMEDIATE')
      validateAttemptDatabase(database)
      const head = database.query<{ generation: number }, []>(
        'SELECT generation FROM allocation_state WHERE singleton = 1',
      ).get()
      const latest = database.query<{ id: number; cache_key: string | null }, []>(
        'SELECT id, cache_key FROM allocation_ticket ORDER BY id DESC LIMIT 1',
      ).get()
      if (validateDurableAdmission && (!head || !latest || head.generation !== latest.id
        || pointer.requestGeneration > head.generation)) throw fixedCatalogFailure()
      if (validateDurableAdmission && pointer.requestGeneration < head!.generation
        && latest!.cache_key !== cacheKey) {
        database.exec('ROLLBACK')
        return false
      }
      const prior = database.query<{
        request_generation: number; attempt_identity: string
      }, [string]>('SELECT request_generation, attempt_identity FROM catalog_entry WHERE cache_key = ?1')
        .get(cacheKey)
      if (prior && (prior.request_generation > pointer.requestGeneration
        || (prior.request_generation === pointer.requestGeneration
          && prior.attempt_identity !== pointer.attemptIdentity))) {
        database.exec('ROLLBACK')
        return false
      }
      database.query(`INSERT INTO catalog_entry(
          cache_key, request_generation, attempt_identity, attempt_id,
          pointer_json, envelope_json, retained_order
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?2)
        ON CONFLICT(cache_key) DO UPDATE SET
          request_generation=excluded.request_generation,
          attempt_identity=excluded.attempt_identity,
          attempt_id=excluded.attempt_id,
          pointer_json=excluded.pointer_json,
          envelope_json=excluded.envelope_json,
          retained_order=excluded.retained_order`)
        .run(cacheKey, pointer.requestGeneration, pointer.attemptIdentity,
          pointer.attemptId, encodedPointer, envelope)
      database.query(`DELETE FROM catalog_entry WHERE cache_key IN (
        SELECT cache_key FROM catalog_entry ORDER BY retained_order DESC, cache_key
        LIMIT -1 OFFSET ?1
      )`).run(Math.max(1, maxEntries))
      if (abortSignal?.aborted || performance.now() >= deadline) throw fixedCatalogFailure()
      database.exec('COMMIT')
      stagedCatalogEnvelopes.delete(stageKey)
      onVisibleCommit?.()
      if (afterCommitVisibility) {
        void Promise.resolve().then(afterCommitVisibility).catch(() => undefined)
      }
      return true
    } catch (error) {
      try { database.exec('ROLLBACK') } catch {}
      if (!isSqliteBusy(error)) throw error
      await new Promise<void>(resolve => setTimeout(resolve, 0))
    }
  }
}

async function defaultCleanupStages(cacheKey: string, currentAttemptId: string): Promise<void> {
  const winner = decodeCommittedPointer(await defaultReadPointer(cacheKey))
  for (const key of stagedCatalogEnvelopes.keys()) {
    if (!key.startsWith(`${cacheKey}\0`)) continue
    if (key === `${cacheKey}\0${winner?.attemptId ?? currentAttemptId}`) continue
    stagedCatalogEnvelopes.delete(key)
  }
}

function identityPayload(catalog: OpenCodeScopedProviderCatalog): OpenCodeCatalogRecordIdentityPayload {
  return {
    providerId: catalog.providerId,
    source: catalog.source,
    endpoint: catalog.endpoint,
    generation: catalog.generation,
    freshness: catalog.freshness,
    connected: catalog.connected,
    models: catalog.models,
  }
}

function persistedEnvelope(identity: CacheIdentity, entry: Pick<CacheEntry,
  'catalog' | 'catalogEvidence' | 'catalogObservedAt' | 'catalogExpiresAt'>): unknown {
  const fingerprints = Object.freeze({
    providerId: identity.providerId,
    binaryFingerprint: identity.binaryFingerprint,
    managedConfigFingerprint: identity.managedConfigFingerprint,
    selectedAuthBaselineFingerprint: identity.selectedAuthBaselineFingerprint,
  })
  return Object.freeze({
    schema: 'opencode-provider-catalog-cache-v4',
    identityHash: identityHash(identity),
    fingerprints,
    catalog: entry.catalog,
    catalogEvidence: entry.catalogEvidence,
    catalogObservedAt: entry.catalogObservedAt,
    catalogExpiresAt: entry.catalogExpiresAt,
    envelopeHash: `sha256:${hash(`${identityHash(identity)}\0${entry.catalog.recordId}\0${JSON.stringify(entry.catalogEvidence)}\0${entry.catalogObservedAt}\0${entry.catalogExpiresAt}`)}`,
  })
}

type CommittedPointer = Readonly<{
  schema: 'opencode-provider-catalog-committed-pointer-v3'
  attemptId: string
  generation: number
  requestGeneration: number
  attemptIdentity: `sha256:${string}`
  attemptStartedAt: number
  catalogExpiresAt: number
  finalization: 'complete'
  envelopeHash: string
}>

function committedPointer(attemptId: string, catalog: OpenCodeScopedProviderCatalog,
  evidence: OpenCodeCatalogPublicationEvidence, catalogExpiresAt: number): CommittedPointer {
  return Object.freeze({
    schema: 'opencode-provider-catalog-committed-pointer-v3',
    attemptId,
    generation: catalog.generation,
    requestGeneration: evidence.requestGeneration,
    attemptIdentity: evidence.attemptIdentity,
    attemptStartedAt: evidence.startedAt,
    catalogExpiresAt,
    finalization: 'complete',
    envelopeHash: `sha256:${hash(catalog.recordId)}`,
  })
}

function compareCommittedPointers(left: CommittedPointer, right: CommittedPointer): number {
  return left.requestGeneration - right.requestGeneration
}

function sameCommittedPointer(left: CommittedPointer, right: CommittedPointer): boolean {
  return left.requestGeneration === right.requestGeneration
    && left.attemptIdentity === right.attemptIdentity
    && left.attemptId === right.attemptId
    && left.attemptStartedAt === right.attemptStartedAt
    && left.catalogExpiresAt === right.catalogExpiresAt
    && left.finalization === right.finalization
    && left.envelopeHash === right.envelopeHash
}

function decodeCommittedPointer(value: unknown): CommittedPointer | null {
  try {
    const pointer = closedRecord(value, ['schema', 'attemptId', 'generation', 'requestGeneration',
      'attemptIdentity', 'attemptStartedAt', 'catalogExpiresAt', 'finalization', 'envelopeHash'])
    if (!pointer || pointer.schema !== 'opencode-provider-catalog-committed-pointer-v3'
      || !boundedString(pointer.attemptId, 128)
      || !/^[1-9]\d{0,15}-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(pointer.attemptId)
      || !Number.isSafeInteger(pointer.generation) || (pointer.generation as number) < 1
      || !Number.isSafeInteger(pointer.requestGeneration) || (pointer.requestGeneration as number) < 1
      || typeof pointer.attemptIdentity !== 'string'
      || !/^sha256:[0-9a-f]{64}$/.test(pointer.attemptIdentity)
      || !Number.isSafeInteger(pointer.attemptStartedAt) || (pointer.attemptStartedAt as number) < 0
      || !Number.isSafeInteger(pointer.catalogExpiresAt)
      || (pointer.catalogExpiresAt as number) < (pointer.attemptStartedAt as number)
      || pointer.finalization !== 'complete'
      || typeof pointer.envelopeHash !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(pointer.envelopeHash)) return null
    return Object.freeze({
      schema: 'opencode-provider-catalog-committed-pointer-v3',
      attemptId: pointer.attemptId,
      generation: pointer.generation,
      requestGeneration: pointer.requestGeneration,
      attemptIdentity: pointer.attemptIdentity,
      attemptStartedAt: pointer.attemptStartedAt,
      catalogExpiresAt: pointer.catalogExpiresAt,
      finalization: 'complete',
      envelopeHash: pointer.envelopeHash,
    }) as CommittedPointer
  } catch {
    return null
  }
}

function decodePersistedCatalog(value: unknown, expectedIdentity: CacheIdentity): Pick<CacheEntry,
  'catalog' | 'catalogEvidence' | 'catalogObservedAt' | 'catalogExpiresAt'> | null {
  try {
    const envelope = closedRecord(value, ['schema', 'identityHash', 'fingerprints', 'catalog',
      'catalogEvidence', 'catalogObservedAt', 'catalogExpiresAt', 'envelopeHash'])
    const fingerprints = envelope && closedRecord(envelope.fingerprints, [
      'providerId', 'binaryFingerprint', 'managedConfigFingerprint',
      'selectedAuthBaselineFingerprint',
    ])
    if (!envelope || !fingerprints || envelope.schema !== 'opencode-provider-catalog-cache-v4'
      || envelope.identityHash !== identityHash(expectedIdentity)
      || fingerprints.providerId !== expectedIdentity.providerId
      || fingerprints.binaryFingerprint !== expectedIdentity.binaryFingerprint
      || fingerprints.managedConfigFingerprint !== expectedIdentity.managedConfigFingerprint
      || fingerprints.selectedAuthBaselineFingerprint !== expectedIdentity.selectedAuthBaselineFingerprint) return null
    const catalogOwned = inertOwnedClone(envelope.catalog)
    const catalogRecord = closedRecord(catalogOwned, [
      'schema', 'providerId', 'source', 'endpoint', 'generation', 'recordId',
      'freshness', 'connected', 'models', 'selectionAllowed', 'launchAuthorization',
    ])
    if (!catalogRecord || catalogRecord.schema !== 'opencode-scoped-provider-catalog-v1'
      || catalogRecord.selectionAllowed !== true
      || catalogRecord.launchAuthorization !== 'forbidden'
      || typeof catalogRecord.recordId !== 'string') return null
    if (!Array.isArray(catalogRecord.models) || catalogRecord.models.length > 2_048
      || new TextEncoder().encode(JSON.stringify(catalogOwned)).byteLength > MAX_PERSISTED_BYTES) return null
    const expectedRecordId = createOpenCodeCatalogRecordId({
      providerId: catalogRecord.providerId,
      source: catalogRecord.source,
      endpoint: catalogRecord.endpoint,
      generation: catalogRecord.generation,
      freshness: catalogRecord.freshness,
      connected: catalogRecord.connected,
      models: catalogRecord.models,
    } as OpenCodeCatalogRecordIdentityPayload)
    const evidence = closedRecord(envelope.catalogEvidence, ['providerId', 'requestGeneration',
      'startedAt', 'attemptIdentity', 'binaryFingerprint', 'configFingerprint', 'authFingerprint'])
    if (!evidence || evidence.providerId !== expectedIdentity.providerId
      || !Number.isSafeInteger(evidence.requestGeneration) || (evidence.requestGeneration as number) < 1
      || !Number.isSafeInteger(evidence.startedAt) || (evidence.startedAt as number) < 0
      || !/^sha256:[0-9a-f]{64}$/.test(String(evidence.attemptIdentity))
      || evidence.binaryFingerprint !== redactedFingerprint('opencode-catalog-binary-v1', expectedIdentity.binaryFingerprint)
      || evidence.configFingerprint !== redactedFingerprint('opencode-catalog-config-v1', expectedIdentity.managedConfigFingerprint)
      || evidence.authFingerprint !== redactedFingerprint('opencode-catalog-auth-v1', expectedIdentity.selectedAuthBaselineFingerprint)
      || !Number.isSafeInteger(envelope.catalogObservedAt) || (envelope.catalogObservedAt as number) < 0
      || !Number.isSafeInteger(envelope.catalogExpiresAt)
      || (envelope.catalogExpiresAt as number) < (envelope.catalogObservedAt as number)
      || expectedRecordId !== catalogRecord.recordId
      || envelope.envelopeHash !== `sha256:${hash(`${identityHash(expectedIdentity)}\0${expectedRecordId}\0${JSON.stringify(evidence)}\0${envelope.catalogObservedAt}\0${envelope.catalogExpiresAt}`)}`) return null
    // The identity contract creates a complete inert deep snapshot. Rebuild the
    // catalog only from that snapshot so custom persistence objects never escape.
    const payload = JSON.parse(JSON.stringify(identityPayload(catalogRecord as unknown as OpenCodeScopedProviderCatalog))) as OpenCodeCatalogRecordIdentityPayload
    const models = payload.models.map(model => Object.freeze({
      ...model,
      limits: Object.freeze({ ...model.limits }),
      capabilities: Object.freeze({ ...model.capabilities }),
    }))
    const owned = {
      schema: 'opencode-scoped-provider-catalog-v1' as const,
      ...payload,
      endpoint: Object.freeze({ ...payload.endpoint }),
      freshness: Object.freeze({ ...payload.freshness }),
      models: Object.freeze(models),
      recordId: expectedRecordId,
      selectionAllowed: true as const,
      launchAuthorization: 'forbidden' as const,
    }
    return Object.freeze({
      catalog: Object.freeze(owned),
      catalogEvidence: Object.freeze({ ...evidence }) as OpenCodeCatalogPublicationEvidence,
      catalogObservedAt: envelope.catalogObservedAt as number,
      catalogExpiresAt: envelope.catalogExpiresAt as number,
    })
  } catch {
    return null
  }
}

function refreshCatalog(
  catalog: OpenCodeScopedProviderCatalog,
  now: number,
  ttlMs: number,
  maxStaleMs: number,
): OpenCodeScopedProviderCatalog | null {
  const ageMs = now - catalog.freshness.observedAtMs
  if (!Number.isSafeInteger(ageMs) || ageMs < 0 || ageMs > maxStaleMs) return null
  const payload: OpenCodeCatalogRecordIdentityPayload = {
    ...identityPayload(catalog),
    source: 'bounded-cache',
    freshness: Object.freeze({
      state: ageMs <= ttlMs ? 'fresh' : 'bounded-stale',
      observedAtMs: catalog.freshness.observedAtMs,
      ageMs,
      maxStaleMs,
    }),
  }
  return Object.freeze({
    schema: 'opencode-scoped-provider-catalog-v1',
    ...payload,
    recordId: createOpenCodeCatalogRecordId(payload),
    selectionAllowed: true,
    launchAuthorization: 'forbidden',
  })
}

function snapshotHostRecord(record: Readonly<Record<string, unknown>> | null): CatalogHost {
  if (!record || !boundedString(record.hostKey, 1_024) || !boundedString(record.baseUrl, 2_048)) {
    throw fixedCatalogFailure()
  }
  try {
    const url = new URL(record.baseUrl)
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
    const loopback = hostname === 'localhost' || hostname === '::1'
      || /^127(?:\.\d{1,3}){3}$/.test(hostname)
    const port = Number(url.port)
    if (url.protocol !== 'http:' || !loopback || url.username || url.password
      || url.pathname !== '/' || url.search || url.hash || !url.port
      || !Number.isInteger(port) || port < 1 || port > 65_535) throw fixedCatalogFailure()
    return Object.freeze({ hostKey: record.hostKey, baseUrl: url.origin })
  } catch {
    throw fixedCatalogFailure()
  }
}

function potentialHostKey(value: unknown): string | null {
  if (value === null || typeof value !== 'object' || nodeUtilTypes.isProxy(value)) return null
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, 'hostKey')
    return descriptor?.enumerable && 'value' in descriptor && boundedString(descriptor.value, 1_024)
      ? descriptor.value : null
  } catch {
    return null
  }
}

export class OpenCodeProviderCatalogService implements OpenCodeProviderCatalogPort {
  private readonly cache = new Map<string, CacheEntry>()
  private readonly generations = new Map<string, number>()
  private readonly inFlight = new Map<string, Flight>()
  private readonly commitQueues = new Map<string, Promise<unknown>>()
  private lastClockSample: number | null = null

  constructor(private readonly deps: OpenCodeProviderCatalogServiceDeps = {}) {}

  private durableKey(key: string): string {
    if (!this.deps.allocateAttempt) return key
    let namespace = customAuthorityNamespaces.get(this.deps.allocateAttempt)
    if (!namespace) {
      namespace = Object.prototype.hasOwnProperty.call(process.env, 'CLAUDE_MULTIMODEL_CACHE_HOME')
        ? hash(`${catalogCacheHome()}\0${Function.prototype.toString.call(this.deps.allocateAttempt)}`)
        : randomUUID()
      customAuthorityNamespaces.set(this.deps.allocateAttempt, namespace)
    }
    return hash(`${namespace}\0${key}`)
  }

  private admit(requestGeneration: number, scopeHash: string): void {
    const admission = Object.freeze({ generation: requestGeneration, scopeHash })
    if (this.deps.allocateAttempt) {
      const current = customAdmissionHeads.get(this.deps.allocateAttempt)
      if (!current || current.generation < requestGeneration) {
        customAdmissionHeads.set(this.deps.allocateAttempt, admission)
      }
    } else {
      const authority = catalogCacheHome()
      const current = defaultAdmissionHeads.get(authority)
      if (!current || current.generation < requestGeneration) defaultAdmissionHeads.set(authority, admission)
    }
  }

  private bindAdmission(requestGeneration: number, scopeHash: string, key: string): void {
    if (this.deps.allocateAttempt) {
      const current = customAdmissionHeads.get(this.deps.allocateAttempt)
      if (current?.generation === requestGeneration && current.scopeHash === scopeHash) {
        customAdmissionHeads.set(this.deps.allocateAttempt,
          Object.freeze({ ...current, cacheKey: key }))
      }
      return
    }
    bindDurableAdmission(requestGeneration, scopeHash, key)
    const authority = catalogCacheHome()
    const current = defaultAdmissionHeads.get(authority)
    if (current?.generation === requestGeneration && current.scopeHash === scopeHash) {
      defaultAdmissionHeads.set(authority, Object.freeze({ ...current, cacheKey: key }))
    }
  }

  private newestAdmission(): AdmissionHead | null {
    if (this.deps.allocateAttempt) return customAdmissionHeads.get(this.deps.allocateAttempt) ?? null
    const authority = catalogCacheHome()
    let durable: AdmissionHead | null = null
    try { durable = latestDurableAdmission() } catch { throw fixedCatalogFailure() }
    const memory = defaultAdmissionHeads.get(authority) ?? null
    return (memory?.generation ?? 0) >= (durable?.generation ?? 0) ? memory : durable
  }

  private admissionIsCurrent(key: string, requestGeneration: number): boolean {
    const head = this.newestAdmission()
    return !head || head.generation <= requestGeneration || head.cacheKey === key
  }

  private sampleClock(previous?: number): number {
    let value: unknown
    try { value = this.deps.now?.() ?? Date.now() } catch { throw fixedCatalogFailure() }
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0
      || value > MAX_EPOCH_MS || (previous !== undefined && value < previous)
      || (this.lastClockSample !== null && value < this.lastClockSample)) throw fixedCatalogFailure()
    this.lastClockSample = value
    return value
  }

  private remember(entry: CacheEntry, maxEntries: number): void {
    this.cache.delete(entry.key)
    if (maxEntries > 0) this.cache.set(entry.key, entry)
    this.generations.set(entry.key, Math.max(this.generations.get(entry.key) ?? 0, entry.catalog.generation))
    while (this.cache.size > maxEntries) {
      const oldest = this.cache.keys().next().value as string | undefined
      if (!oldest) break
      this.cache.delete(oldest)
    }
  }

  private async release(hostKey: string): Promise<void> {
    const releaseHost = this.deps.releaseHost ?? (async (key: string) => {
      const { openCodeHostManager } = await import('./OpenCodeHostManager.js')
      return openCodeHostManager.releaseHost(key)
    })
    await releaseHost(hostKey).catch(() => undefined)
  }

  private readPointer(key: string): Promise<unknown | null> {
    return this.deps.readPersisted
      ? this.deps.readPersisted(pointerStorageKey(key))
      : defaultReadPointer(this.durableKey(key))
  }

  private readStage(key: string, attemptId: string): Promise<unknown | null> {
    return this.deps.readPersisted
      ? this.deps.readPersisted(stageStorageKey(key, attemptId))
      : defaultReadStage(this.durableKey(key), attemptId)
  }

  private stage(key: string, attemptId: string, envelope: unknown): Promise<void> {
    return this.deps.writePersisted
      ? this.deps.writePersisted(stageStorageKey(key, attemptId), envelope)
      : defaultStagePersisted(this.durableKey(key), attemptId, envelope, this.deps.beforeStageDirectorySync)
  }

  private publish(
    key: string,
    pointer: CommittedPointer,
  ): Promise<boolean> {
    if (!this.deps.writePersisted) return Promise.reject(fixedCatalogFailure())
    return this.deps.writePersisted(pointerStorageKey(key), pointer).then(() => true)
  }

  private publishAuthority(
    key: string,
    pointer: CommittedPointer,
    maxEntries: number,
    abortSignal?: AbortSignal,
    deadline?: number,
    beforeVisibility?: () => void | Promise<void>,
    afterCommitVisibility?: () => void | Promise<void>,
    onVisibleCommit?: () => void,
  ): Promise<boolean> {
    return publishCatalogAuthority(
          this.durableKey(key), pointer, maxEntries, abortSignal, deadline, beforeVisibility,
          afterCommitVisibility,
          onVisibleCommit,
          !this.deps.allocateAttempt,
        )
  }

  private async revokePublishedPointer(
    key: string,
    previous: CommittedPointer | null,
  ): Promise<void> {
    if (previous) {
      try {
        await this.publish(key, previous)
        return
      } catch {
        // Fall through to invalidation. Restoring the prior pointer is nicer,
        // but an absent/non-decodable pointer is also a safe restart state.
      }
    }
    if (this.deps.deletePersisted) {
      await this.deps.deletePersisted(pointerStorageKey(key)).catch(() => undefined)
      return
    }
    if (this.deps.writePersisted) {
      await this.deps.writePersisted(pointerStorageKey(key), null).catch(() => undefined)
      return
    }
    throw fixedCatalogFailure()
  }

  private hasCommitAuthority(params: {
    key: string
    catalog: OpenCodeScopedProviderCatalog
    signal: AbortSignal
    flight: Flight
  }): boolean {
    return !params.signal.aborted
      && this.generations.get(params.key) === params.catalog.generation
      && this.inFlight.get(params.key) === params.flight
      && params.flight.waiters.size > 0
      && this.admissionIsCurrent(params.key, params.catalogEvidence.requestGeneration)
  }

  private cleanupStages(key: string, currentAttemptId: string): void {
    if (this.deps.deletePersisted && this.deps.readPersisted) {
      // Custom stores own their enumeration policy; the committed stage is
      // retained for restart and known obsolete attempts are removed on abort.
      return
    }
    void (async () => {
      const durableKey = this.durableKey(key)
      const winner = decodeCommittedPointer(await defaultReadPointer(durableKey))
      await defaultCleanupStages(durableKey, winner?.attemptId ?? currentAttemptId)
    })().catch(() => undefined)
  }

  private discardStage(key: string, attemptId: string): void {
    if (this.deps.deletePersisted) {
      void this.deps.deletePersisted(stageStorageKey(key, attemptId)).catch(() => undefined)
      return
    }
    if (!this.deps.writePersisted) {
      stagedCatalogEnvelopes.delete(`${this.durableKey(key)}\0${attemptId}`)
    }
  }

  private async commitCatalog(params: {
    key: string
    identity: CacheIdentity
    profileRootPath: string
    projectPath: string
    catalog: OpenCodeScopedProviderCatalog
    catalogEvidence: OpenCodeCatalogPublicationEvidence
    catalogExpiresAt: number
    observedAtMs: number
    maxEntries: number
    signal: AbortSignal
    flight: Flight
  }): Promise<boolean> {
    const sharedQueues = this.deps.writePersisted
      ? (customPersistenceCommitQueues.get(this.deps.writePersisted)
        ?? (() => {
          const queues = new Map<string, Promise<boolean>>()
          customPersistenceCommitQueues.set(this.deps.writePersisted!, queues)
          return queues
        })())
      : defaultPersistenceCommitQueues
    const sharedQueueKey = this.deps.writePersisted ? params.key : catalogCacheHome()
    const previous = sharedQueues.get(sharedQueueKey)
      ?? this.commitQueues.get(params.key)
      ?? Promise.resolve()
    const commit = previous.catch(() => undefined).then(async () => {
      if (!this.hasCommitAuthority(params)) return false
      const admitted = this.newestAdmission()
      if (admitted && params.catalogEvidence.requestGeneration < admitted.generation
        && admitted.cacheKey !== params.key) return false
      const envelope = persistedEnvelope(params.identity, {
        catalog: params.catalog,
        catalogEvidence: params.catalogEvidence,
        catalogObservedAt: params.observedAtMs,
        catalogExpiresAt: params.catalogExpiresAt,
      })
      const attemptId = `${params.catalog.generation}-${randomUUID()}`
      let previousPointer: CommittedPointer | null = null
      try {
        previousPointer = decodeCommittedPointer(await this.readPointer(params.key))
      } catch {
        previousPointer = null
      }
      const candidatePointer = committedPointer(
        attemptId, params.catalog, params.catalogEvidence, params.catalogExpiresAt,
      )
      if (previousPointer && (compareCommittedPointers(previousPointer, candidatePointer) > 0
        || (previousPointer.requestGeneration === candidatePointer.requestGeneration
          && previousPointer.attemptIdentity !== candidatePointer.attemptIdentity))) {
        return false
      }
      try {
        await this.stage(params.key, attemptId, envelope)
      } catch {
        // A pointer must never be published for a missing or partial stage.
        // Persistence-thrown values are not observed by callers.
        this.discardStage(params.key, attemptId)
        return false
      }
      // A generation may have become obsolete while an abort-ignoring
      // persistence adapter was completing. It must never enter memory; the
      // newer per-key queued commit, if any, is necessarily written after it.
      if (!this.hasCommitAuthority(params)) {
        this.discardStage(params.key, attemptId)
        return false
      }
      const admittedAfterStage = this.newestAdmission()
      if (admittedAfterStage
        && params.catalogEvidence.requestGeneration < admittedAfterStage.generation
        && admittedAfterStage.cacheKey !== params.key) {
        this.discardStage(params.key, attemptId)
        return false
      }
      // Another service instance may have published while this stage write was
      // pending. Revalidate durable order before adding our commit record.
      const winnerAfterStage = decodeCommittedPointer(
        await this.readPointer(params.key).catch(() => null),
      )
      if (winnerAfterStage && (compareCommittedPointers(winnerAfterStage, candidatePointer) > 0
        || (winnerAfterStage.requestGeneration === candidatePointer.requestGeneration
          && winnerAfterStage.attemptIdentity !== candidatePointer.attemptIdentity))) {
        this.discardStage(params.key, attemptId)
        return false
      }
      if (!this.deps.writePersisted) {
        await this.deps.beforeFinalPublication?.()
        if (!this.hasCommitAuthority(params)) {
          this.discardStage(params.key, attemptId)
          return false
        }
        const durableStage = decodePersistedCatalog(
          await this.readStage(params.key, attemptId).catch(() => null),
          params.identity,
        )
        if (!durableStage
          || durableStage.catalog.generation !== candidatePointer.generation
          || durableStage.catalogEvidence.requestGeneration !== candidatePointer.requestGeneration
          || durableStage.catalogEvidence.attemptIdentity !== candidatePointer.attemptIdentity
          || !this.hasCommitAuthority(params)) {
          this.discardStage(params.key, attemptId)
          return false
        }
        try {
          const retained = await this.publishAuthority(
            params.key, candidatePointer, params.maxEntries, params.signal, params.flight.deadline,
            this.deps.beforeVisibilitySync,
            this.deps.afterCommitVisibility,
            () => { params.flight.visibleCommit = true },
          )
          if (!retained) {
            this.discardStage(params.key, attemptId)
            return false
          }
        } catch {
          this.discardStage(params.key, attemptId)
          return false
        }
        // The authority transaction revalidated cancellation, the global head,
        // and retention immediately before COMMIT. Success is linearized and
        // must not be revoked by a later timer, clock sample, or waiter change.
        this.remember({
          key: params.key,
          identity: params.identity,
          profileRootPath: params.profileRootPath,
          projectPath: params.projectPath,
          catalog: params.catalog,
          catalogEvidence: params.catalogEvidence,
          catalogObservedAt: params.observedAtMs,
          catalogExpiresAt: params.catalogExpiresAt,
          lastUsedAt: params.observedAtMs,
        }, params.maxEntries)
        return true
      }
      // Atomic publication is the sole durable commit point. The immediately
      // preceding guard prevents a withdrawn, timed-out, or superseded flight
      // whose stage write ignored cancellation from becoming current.
      try {
        await this.publish(params.key, candidatePointer)
      } catch {
        this.discardStage(params.key, attemptId)
        return false
      }
      // Publication adapters are allowed to ignore cancellation while their
      // atomic write is pending. Authority is therefore checked again after
      // the await. A withdrawn/expired/superseded flight revokes what it just
      // published before the per-key commit queue can advance.
      if (!this.hasCommitAuthority(params)) {
        const durableWinner = decodeCommittedPointer(await this.readPointer(params.key).catch(() => null))
        if (!durableWinner || compareCommittedPointers(durableWinner, candidatePointer) <= 0) {
          await this.revokePublishedPointer(params.key, previousPointer)
        }
        this.discardStage(params.key, attemptId)
        return false
      }
      const durableWinner = decodeCommittedPointer(await this.readPointer(params.key).catch(() => null))
      const durableStage = decodePersistedCatalog(
        await this.readStage(params.key, attemptId).catch(() => null),
        params.identity,
      )
      if (!durableWinner || !sameCommittedPointer(durableWinner, candidatePointer)
        || !durableStage
        || durableStage.catalog.generation !== candidatePointer.generation
        || durableStage.catalogEvidence.requestGeneration !== candidatePointer.requestGeneration
        || durableStage.catalogEvidence.attemptIdentity !== candidatePointer.attemptIdentity) {
        if (durableWinner && sameCommittedPointer(durableWinner, candidatePointer)) {
          await this.revokePublishedPointer(params.key, previousPointer)
        }
        this.discardStage(params.key, attemptId)
        return false
      }
      this.remember({
        key: params.key,
        identity: params.identity,
        profileRootPath: params.profileRootPath,
        projectPath: params.projectPath,
        catalog: params.catalog,
        catalogEvidence: params.catalogEvidence,
        catalogObservedAt: params.observedAtMs,
        catalogExpiresAt: params.catalogExpiresAt,
        lastUsedAt: params.observedAtMs,
      }, params.maxEntries)
      if (previousPointer && previousPointer.attemptId !== attemptId) {
        this.discardStage(params.key, previousPointer.attemptId)
      }
      this.cleanupStages(params.key, attemptId)
      return true
    })
    this.commitQueues.set(params.key, commit)
    sharedQueues.set(sharedQueueKey, commit)
    try {
      return await commit
    } finally {
      if (this.commitQueues.get(params.key) === commit) this.commitQueues.delete(params.key)
      if (sharedQueues.get(sharedQueueKey) === commit) sharedQueues.delete(sharedQueueKey)
    }
  }

  private async runExactLoad(params: {
    key: string
    identity: CacheIdentity
    preparedProfile: OpenCodeScopedPreparedProfile
    profileRootPath: string
    projectPath: string
    providerId: string
    options: Options
    startedAt: number
    flight: Flight
    catalogEvidence: OpenCodeCatalogPublicationEvidence
  }): Promise<OpenCodeProviderCatalogLoadResult> {
    const { key, identity, preparedProfile, profileRootPath, projectPath, providerId } = params
    const { ttlMs, maxStaleMs, maxEntries } = params.options
    const signal = params.flight.controller.signal
    let clock = params.startedAt
    let prior = this.cache.get(key) ?? null
    const assertCurrent = (): void => {
      if (signal.aborted
        || !this.admissionIsCurrent(key, params.catalogEvidence.requestGeneration)) {
        throw fixedCatalogFailure('superseded')
      }
    }
    const awaitCurrent = async (): Promise<void> => {
      for (;;) {
        const head = this.newestAdmission()
        if (!head || head.generation <= params.catalogEvidence.requestGeneration
          || head.cacheKey !== undefined) break
        if (signal.aborted || performance.now() >= params.flight.deadline) {
          throw fixedCatalogFailure('superseded')
        }
        await new Promise<void>(resolve => setTimeout(resolve, 0))
      }
      assertCurrent()
    }
    await awaitCurrent()
    if (prior) {
      const refreshed = refreshCatalog(prior.catalog, clock, ttlMs, maxStaleMs)
      if (refreshed?.freshness.state === 'fresh') {
        await awaitCurrent()
        prior = { ...prior, catalog: refreshed, lastUsedAt: clock }
        this.remember(prior, maxEntries)
        const result = Object.freeze({ catalog: refreshed, catalogEvidence: prior.catalogEvidence,
          catalogObservedAt: prior.catalogObservedAt, catalogExpiresAt: prior.catalogExpiresAt,
          catalogProvenance: 'cache-hit' as const, profileRootPath, projectPath, diagnostics: Object.freeze([]) })
        await awaitCurrent()
        return result
      }
    } else {
      let persisted: Pick<CacheEntry, 'catalog' | 'catalogEvidence' | 'catalogObservedAt' | 'catalogExpiresAt'> | null = null
      try {
        const pointer = decodeCommittedPointer(await this.readPointer(key))
        await awaitCurrent()
        if (pointer) {
          let staged: unknown = null
          try {
            staged = await this.readStage(key, pointer.attemptId)
            await awaitCurrent()
          } catch {
            // A committed pointer can outlive an unreadable stage. Treat that
            // candidate as absent and continue through the one live refresh.
          }
          let decoded: ReturnType<typeof decodePersistedCatalog> = null
          try {
            decoded = decodePersistedCatalog(staged, identity)
          } catch {
            // Persistence values are untrusted. Never inspect or stringify a
            // decode failure; discard the candidate and refresh normally.
          }
          if (decoded && decoded.catalog.generation === pointer.generation
            && decoded.catalogEvidence.requestGeneration === pointer.requestGeneration
            && decoded.catalogEvidence.attemptIdentity === pointer.attemptIdentity
            && decoded.catalogEvidence.startedAt === pointer.attemptStartedAt
            && decoded.catalogExpiresAt === pointer.catalogExpiresAt
            && `sha256:${hash(decoded.catalog.recordId)}` === pointer.envelopeHash) persisted = decoded
        }
      } catch (error) {
        if (error instanceof OpenCodeProviderCatalogUnavailableError) throw error
        throw fixedCatalogFailure()
      }
      if (!this.admissionIsCurrent(key, params.catalogEvidence.requestGeneration)) {
        throw fixedCatalogFailure('superseded')
      }
      clock = this.sampleClock(clock)
      if (persisted) {
        const refreshed = refreshCatalog(persisted.catalog, clock, ttlMs, maxStaleMs)
        if (refreshed) {
          prior = { key, identity, profileRootPath, projectPath, catalog: refreshed,
            catalogEvidence: persisted.catalogEvidence, catalogObservedAt: persisted.catalogObservedAt,
            catalogExpiresAt: persisted.catalogExpiresAt, lastUsedAt: clock }
          this.generations.set(key, Math.max(this.generations.get(key) ?? 0, refreshed.generation))
          if (refreshed.freshness.state === 'fresh') {
            await awaitCurrent()
            this.remember(prior, maxEntries)
            const result = Object.freeze({ catalog: refreshed, catalogEvidence: persisted.catalogEvidence,
              catalogObservedAt: persisted.catalogObservedAt, catalogExpiresAt: persisted.catalogExpiresAt,
              catalogProvenance: 'cache-hit' as const, profileRootPath, projectPath, diagnostics: Object.freeze([]) })
            await awaitCurrent()
            return result
          }
        }
      }
    }

    const generation = (this.generations.get(key) ?? 0) + 1
    this.generations.set(key, generation)
    let acquiredHostKey: string | null = null
    const operation = (async () => {
      try {
        const ensureHost = this.deps.ensureHost ?? (async request => {
          const { openCodeHostManager } = await import('./OpenCodeHostManager.js')
          return openCodeHostManager.ensureScopedHost(request)
        })
        const rawHost = await ensureHost({
          preparedProfile,
          resolveConfigFingerprint: false,
          abortSignal: signal,
        })
        acquiredHostKey = potentialHostKey(rawHost)
        await awaitCurrent()
        const hostRecord = snapshotRecord(rawHost)
        if (hostRecord && boundedString(hostRecord.hostKey, 1_024)) {
          acquiredHostKey = hostRecord.hostKey
        }
        const host = snapshotHostRecord(hostRecord)
        if (signal.aborted) throw fixedCatalogFailure()
        const fetchProviderCatalog = this.deps.fetchProviderCatalog ?? (async request => {
          const { openCodeClientFactory } = await import('./OpenCodeClientFactory.js')
          return openCodeClientFactory.create(request.baseUrl, { signal: request.abortSignal }).getProviders()
        })
        const response = await fetchProviderCatalog({ baseUrl: host.baseUrl, abortSignal: signal })
        await awaitCurrent()
        const observedAtMs = this.sampleClock(clock)
        const catalog = normalizeOpenCodeScopedProviderCatalogResponse({
          requestedProviderId: providerId,
          response,
          generation,
          observedAtMs,
          nowMs: observedAtMs,
          freshForMs: ttlMs,
          maxStaleMs,
          source: 'live',
        })
        // Host ownership is part of the refresh operation. It must be fully
        // released before the durable commit point so a timeout while release
        // is pending can only leave the previous generation current.
        const hostKey = acquiredHostKey
        acquiredHostKey = null
        if (hostKey) await this.release(hostKey)
        await awaitCurrent()
        const committed = await this.commitCatalog({
          key,
          identity,
          profileRootPath,
          projectPath,
          catalog,
          catalogEvidence: params.catalogEvidence,
          catalogExpiresAt: Math.min(MAX_EPOCH_MS, observedAtMs + ttlMs),
          observedAtMs,
          maxEntries,
          signal,
          flight: params.flight,
        })
        if (!params.flight.visibleCommit) await awaitCurrent()
        if (!committed) {
          // Publication is authoritative. If this candidate lost, it may only
          // return the durable winner for this exact cache identity; it must
          // never return or remember its own non-retained bytes.
          const winnerPointer = decodeCommittedPointer(await this.readPointer(key).catch(() => null))
          const winner = winnerPointer
            ? decodePersistedCatalog(
                await this.readStage(key, winnerPointer.attemptId).catch(() => null), identity,
              )
            : null
          if (winnerPointer && winner
            && winner.catalog.generation === winnerPointer.generation
            && winner.catalogEvidence.requestGeneration === winnerPointer.requestGeneration
            && winner.catalogEvidence.attemptIdentity === winnerPointer.attemptIdentity
            && winner.catalogEvidence.startedAt === winnerPointer.attemptStartedAt
            && winner.catalogExpiresAt === winnerPointer.catalogExpiresAt
            && `sha256:${hash(winner.catalog.recordId)}` === winnerPointer.envelopeHash) {
            const durableCatalog = refreshCatalog(
              winner.catalog, Math.max(observedAtMs, winner.catalogObservedAt), ttlMs, maxStaleMs,
            )
            if (durableCatalog) {
              this.remember({
                key, identity, profileRootPath, projectPath, catalog: durableCatalog,
                catalogEvidence: winner.catalogEvidence,
                catalogObservedAt: winner.catalogObservedAt,
                catalogExpiresAt: winner.catalogExpiresAt,
                lastUsedAt: observedAtMs,
              }, maxEntries)
              const result = Object.freeze({
                catalog: durableCatalog,
                catalogEvidence: winner.catalogEvidence,
                catalogObservedAt: winner.catalogObservedAt,
                catalogExpiresAt: winner.catalogExpiresAt,
                catalogProvenance: 'cache-hit' as const,
                profileRootPath,
                projectPath,
                diagnostics: Object.freeze([]),
              })
              await awaitCurrent()
              return result
            }
          }
          throw fixedCatalogFailure('superseded')
        }
        const result = Object.freeze({ catalog, catalogEvidence: params.catalogEvidence,
          catalogObservedAt: observedAtMs, catalogExpiresAt: Math.min(MAX_EPOCH_MS, observedAtMs + ttlMs),
          catalogProvenance: 'fresh-live' as const, profileRootPath, projectPath, diagnostics: Object.freeze([]) })
        return result
      } finally {
        if (acquiredHostKey) await this.release(acquiredHostKey)
      }
    })()
    // The operation deliberately remains observed after a timeout so a host
    // acquired by an abort-ignoring dependency is always eventually released.
    operation.catch(() => undefined)
    try {
      const aborted = new Promise<never>((_resolve, reject) => {
        if (signal.aborted) return reject(fixedCatalogFailure())
        signal.addEventListener('abort', () => reject(fixedCatalogFailure()), { once: true })
      })
      return await Promise.race([operation, aborted])
    } catch (error) {
      if (params.flight.abortKind === 'no-waiters') throw fixedCatalogFailure()
      clock = this.sampleClock(clock)
      const stale = prior ? refreshCatalog(prior.catalog, clock, ttlMs, maxStaleMs) : null
      if (!stale) {
        if (error instanceof OpenCodeProviderCatalogUnavailableError) throw error
        throw fixedCatalogFailure()
      }
      if (!this.admissionIsCurrent(key, params.catalogEvidence.requestGeneration)) {
        throw fixedCatalogFailure('superseded')
      }
      const result = Object.freeze({
        catalog: stale,
        catalogEvidence: prior!.catalogEvidence,
        catalogObservedAt: prior!.catalogObservedAt,
        catalogExpiresAt: prior!.catalogExpiresAt,
        catalogProvenance: 'bounded-stale' as const,
        profileRootPath,
        projectPath,
        diagnostics: Object.freeze(['OpenCode provider catalog refresh failed; using bounded stale data.']),
      })
      if (!this.admissionIsCurrent(key, params.catalogEvidence.requestGeneration)) {
        throw fixedCatalogFailure('superseded')
      }
      return result
    }
  }

  async loadCatalog(unsafeInput: OpenCodeProviderCatalogLoadInput): Promise<OpenCodeProviderCatalogLoadResult> {
    let deadlineTimer: ReturnType<typeof setTimeout> | null = null
    let externalAbort: (() => void) | null = null
    let ownedFlight: Flight | null = null
    let rawPreparedProfile: OpenCodeScopedPreparedProfile | null = null
    let profileAuthFinalized = false
    let attemptController: AbortController | null = null
    try {
      const selectedOptions = options(this.deps)
      const input = snapshotInput(unsafeInput)
      if (input.abortSignal?.aborted) throw fixedCatalogFailure()
      // The one attempt deadline is armed before canonicalization, durable
      // allocation, profile preparation, cache hydration, or native/provider
      // work. A small cleanup reserve aborts owned work before the public
      // timeout boundary; no retry or fallback creates another budget.
      attemptController = new AbortController()
      const reserveMs = Math.min(250, Math.floor(selectedOptions.timeoutMs / 10))
      const workBudgetMs = Math.max(0, selectedOptions.timeoutMs - reserveMs)
      const monotonicDeadline = performance.now() + workBudgetMs
      const setTimer = this.deps.setTimer ?? setTimeout
      const clearTimer = this.deps.clearTimer ?? clearTimeout
      const deadline = new Promise<never>((_resolve, reject) => {
        deadlineTimer = setTimer(() => {
          if (ownedFlight?.visibleCommit) return
          // Publication remains revocable at its attempt-owned visibility
          // edge; the one-shot deadline is authoritative through retention.
          if (ownedFlight) ownedFlight.abortKind = 'timeout'
          attemptController.abort(fixedCatalogFailure())
          reject(fixedCatalogFailure())
        }, workBudgetMs)
        deadlineTimer.unref?.()
      })
      externalAbort = () => attemptController.abort(fixedCatalogFailure())
      input.abortSignal?.addEventListener('abort', externalAbort, { once: true })
      const withinDeadline = <T>(operation: Promise<T>): Promise<T> =>
        Promise.race([operation, deadline])
      const startedAt = this.sampleClock()
      const providerId = canonicalizeOpenCodeProviderId(input.providerId)
      if (!providerId) throw fixedCatalogFailure()
      const requestedPath = path.resolve(input.projectPath ?? process.cwd())
      const canonicalize = this.deps.canonicalizeProjectPath
        ?? canonicalizeOpenCodePassiveProjectPath
      const canonicalProjectPath = await withinDeadline(canonicalize(
        requestedPath,
        attemptController.signal,
      ))
      if (attemptController.signal.aborted) throw fixedCatalogFailure()
      assertCatalogRootOutsideProject(canonicalProjectPath)
      const requestScope = boundedIdentityMaterial([
        canonicalProjectPath, providerId,
      ])
      const allocation = await withinDeadline(Promise.resolve(this.deps.allocateAttempt
        ? this.deps.allocateAttempt(requestScope, startedAt)
        : allocateOpenCodeProviderCatalogAttempt(requestScope, startedAt, {
          deadline: monotonicDeadline,
          abortSignal: attemptController.signal,
        })))
      if (performance.now() >= monotonicDeadline) {
        attemptController.abort(fixedCatalogFailure())
        throw fixedCatalogFailure()
      }
      if (attemptController.signal.aborted) throw fixedCatalogFailure()
      if (!Number.isSafeInteger(allocation.requestGeneration) || allocation.requestGeneration < 1
        || !/^sha256:[0-9a-f]{64}$/.test(allocation.attemptIdentity)) throw fixedCatalogFailure()
      this.admit(allocation.requestGeneration, hash(requestScope))
      const prepareProfile = this.deps.prepareProfile ?? (async plan => {
        const manager = this.deps.profileManager ?? (await import('./OpenCodeProfileManager.js'))
          .openCodeProfileManager as unknown as OpenCodeProviderCatalogProductionProfileManager
        return prepareOpenCodeProviderCatalogProductionProfile(
          manager,
          plan,
        )
      })
      const rawProfile = await withinDeadline(prepareProfile({
        purpose: 'provider-catalog',
        providerId,
        runtimeInstanceId: `catalog-${randomUUID()}`,
        projectPath: canonicalProjectPath,
        abortSignal: attemptController.signal,
      }))
      rawPreparedProfile = rawProfile
      if (attemptController.signal.aborted) throw fixedCatalogFailure()
      const afterProfile = this.sampleClock(startedAt)
      const profile = snapshotProfile(rawProfile, providerId, canonicalProjectPath)
      const key = cacheKeyFor(profile.identity)
      this.bindAdmission(allocation.requestGeneration, hash(requestScope), key)
      // Production catalog auth lives in the unique attempt profile. Settle its
      // publication before cache/host work so no fallible auth finalizer exists
      // after catalog visibility. Later failure never rolls back a canonical
      // authorization pathname because none was mutated.
      if (!this.deps.prepareProfile) {
        const publication = await import('./OpenCodeScopedProfileAuthPublication.js')
        await withinDeadline(publication.finalizeOpenCodeScopedProfileAuth(rawProfile))
        profileAuthFinalized = true
        if (!this.admissionIsCurrent(key, allocation.requestGeneration)) {
          throw fixedCatalogFailure('superseded')
        }
      }
      let flight = this.inFlight.get(key)
      if (flight?.controller.signal.aborted) {
        if (this.inFlight.get(key) === flight) this.inFlight.delete(key)
        flight = undefined
      }
      if (!flight) {
        const catalogEvidence = createCatalogPublicationEvidence(
          profile.identity, allocation, startedAt,
        )
        const created = {
          controller: attemptController,
          deadline: monotonicDeadline,
          abortKind: null,
          settled: false,
          waiters: new Set<symbol>(),
          promise: Promise.resolve(null as unknown as OpenCodeProviderCatalogLoadResult),
          visibleCommit: false,
        }
        created.promise = this.runExactLoad({
          key,
          identity: profile.identity,
          preparedProfile: profile.preparedProfile,
          profileRootPath: profile.profileRootPath,
          projectPath: profile.projectPath,
          providerId,
          options: selectedOptions,
          startedAt: afterProfile,
          flight: created,
          catalogEvidence,
        }).finally(() => {
          created.settled = true
          if (this.inFlight.get(key) === created) this.inFlight.delete(key)
        })
        flight = created
        ownedFlight = created
        this.inFlight.set(key, flight)
      }
      const activeFlight = flight
      // From here caller cancellation is waiter-local. It must not abort a
      // coalesced flight while another caller still owns it.
      if (externalAbort) {
        input.abortSignal?.removeEventListener('abort', externalAbort)
        externalAbort = null
      }
      const waiter = Symbol('catalog-waiter')
      activeFlight.waiters.add(waiter)
      let callerCancelled = false
      let rejectLocalCancellation: (() => void) | null = null
      const localCancellation = new Promise<never>((_resolve, reject) => {
        rejectLocalCancellation = () => reject(fixedCatalogFailure())
      })
      const cancel = () => {
        if (callerCancelled) return
        callerCancelled = true
        activeFlight.waiters.delete(waiter)
        rejectLocalCancellation?.()
        if (!activeFlight.settled && activeFlight.waiters.size === 0) {
          activeFlight.abortKind = 'no-waiters'
          activeFlight.controller.abort(fixedCatalogFailure())
        }
      }
      input.abortSignal?.addEventListener('abort', cancel, { once: true })
      try {
        if (input.abortSignal?.aborted) cancel()
        const result = await Promise.race([
          activeFlight.promise,
          localCancellation,
          ...(ownedFlight ? [] : [deadline]),
        ])
        if (input.abortSignal?.aborted && !activeFlight.visibleCommit) throw fixedCatalogFailure()
        if (!profileAuthFinalized) {
          const finalizeProfile = this.deps.finalizePreparedProfile ?? (async () => {})
          await finalizeProfile(rawProfile)
          profileAuthFinalized = true
          if (!this.admissionIsCurrent(key, allocation.requestGeneration)) {
            throw fixedCatalogFailure('superseded')
          }
        }
        return result
      } finally {
        rejectLocalCancellation = null
        input.abortSignal?.removeEventListener('abort', cancel)
        activeFlight.waiters.delete(waiter)
      }
    } catch (error) {
      if (!this.deps.prepareProfile && attemptController) {
        const publication = await import('./OpenCodeScopedProfileAuthPublication.js')
        await publication.rollbackOpenCodeScopedProfileAuthSignal(attemptController.signal)
      }
      if (!profileAuthFinalized && rawPreparedProfile) {
        // Rejecting the enclosing catalog attempt owns rollback. Abort first so
        // no later host/publication phase can regain authority while cleanup
        // is stalled; then await ownership-safe auth restoration before the
        // public rejection becomes observable.
        if (ownedFlight && ownedFlight.waiters.size === 0) {
          ownedFlight.controller.abort(fixedCatalogFailure())
        }
        const rollbackProfile = this.deps.rollbackPreparedProfile ?? (async prepared => {
          if (this.deps.prepareProfile) return
          const publication = await import('./OpenCodeScopedProfileAuthPublication.js')
          await publication.rollbackOpenCodeScopedProfileAuth(prepared)
        })
        await rollbackProfile(rawPreparedProfile)
      }
      if (error instanceof OpenCodeProviderCatalogUnavailableError) throw error
      throw fixedCatalogFailure()
    } finally {
      const input = snapshotRecord(unsafeInput)
      if (externalAbort && input?.abortSignal instanceof AbortSignal) {
        input.abortSignal.removeEventListener('abort', externalAbort)
      }
      if (deadlineTimer) (this.deps.clearTimer ?? clearTimeout)(deadlineTimer)
    }
  }
}

export const openCodeProviderCatalogService = new OpenCodeProviderCatalogService()
