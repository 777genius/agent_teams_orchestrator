import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync, constants as fsConstants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { link, open, readFile, readdir, unlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { types as nodeUtilTypes } from 'node:util'
import { Database } from 'bun:sqlite'

import { writeJsonFileAtomic } from '../../utils/atomicWrite.js'
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
const ATTEMPT_SCHEMA_VERSION = 44305
const ATTEMPT_ROW_CAPACITY = 64
const ATTEMPT_TABLE_SQL = `CREATE TABLE allocation_ticket (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope_hash TEXT NOT NULL CHECK(length(scope_hash) = 64),
      started_at INTEGER NOT NULL CHECK(started_at >= 0)
    )`
const ATTEMPT_STATE_SQL = `CREATE TABLE allocation_state (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      generation INTEGER NOT NULL CHECK(generation >= 0)
    )`
let durableAttemptDatabase: {
  filePath: string
  database: Database
  rootReceipt: ManagedRootReceipt
  rootDescriptor: number | null
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
  /** Deterministic fake-only barrier after retention authority removal and sync. */
  afterRetentionAuthorityRemoval?: () => void | Promise<void>
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
  if (process.platform !== 'linux' && process.platform !== 'darwin') {
    return { fd: null, path: receipt.path }
  }
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

async function allocateWindowsCatalogAttempt(
  scope: string,
  startedAt: number,
  deadline: number,
): Promise<Readonly<{ requestGeneration: number; attemptIdentity: `sha256:${string}` }>> {
  const systemRoot = process.env.SystemRoot
  if (!systemRoot || !path.win32.isAbsolute(systemRoot)) throw fixedCatalogFailure()
  const executable = path.win32.join(
    systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
  )
  const executableMetadata = lstatSync(executable)
  if (!executableMetadata.isFile() || executableMetadata.isSymbolicLink()
    || realpathSync(executable).toLowerCase() !== path.win32.resolve(executable).toLowerCase()) {
    throw fixedCatalogFailure()
  }
  const budgetMs = Math.floor(Math.max(0, deadline - performance.now()))
  if (budgetMs <= 0) throw fixedCatalogFailure()
  // Windows cannot safely hand SQLite a descriptor-relative mutable database
  // and sidecars. Use a kernel named mutex plus HKCU registry QWORD instead:
  // neither authority is pathname-following, and the redundant digest rejects
  // partial writes or external state tampering before the next mutation.
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$schema = 44305
function Get-StateDigest([long]$generation) {
  $bytes = [Text.Encoding]::UTF8.GetBytes("$($schema):$($generation)")
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant() }
  finally { $sha.Dispose() }
}
$mutex = [Threading.Mutex]::new($false, 'Local\777genius.AgentTeamsOrchestrator.CatalogAllocation.v44305')
$owned = $false
try {
  $owned = $mutex.WaitOne([int]$env:CATALOG_ALLOCATION_BUDGET_MS)
  if (-not $owned) { exit 4 }
  $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey(
    'Software\777genius\AgentTeamsOrchestrator\CatalogAllocation', $true)
  try {
    $storedSchema = $key.GetValue('SchemaVersion', $null)
    $storedGeneration = $key.GetValue('Generation', $null)
    $storedDigest = $key.GetValue('StateDigest', $null)
    if ($null -eq $storedSchema -and $null -eq $storedGeneration -and $null -eq $storedDigest) {
      $generation = [long]0
    } elseif ([int]$storedSchema -eq $schema -and $storedGeneration -is [long] -and
      [long]$storedGeneration -ge 0 -and $storedDigest -is [string]) {
      $generation = [long]$storedGeneration
      $expected = Get-StateDigest $generation
      if ($storedDigest -ne $expected) { exit 5 }
    } else { exit 5 }
    if ($generation -ge 9007199254740990) { exit 5 }
    $generation += 1
    $digest = Get-StateDigest $generation
    $key.SetValue('SchemaVersion', $schema, [Microsoft.Win32.RegistryValueKind]::DWord)
    $key.SetValue('Generation', $generation, [Microsoft.Win32.RegistryValueKind]::QWord)
    $key.SetValue('StateDigest', $digest, [Microsoft.Win32.RegistryValueKind]::String)
    $key.Flush()
    [Console]::Out.WriteLine($generation)
  } finally { $key.Dispose() }
} finally {
  if ($owned) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}`
  const child = Bun.spawn({
    cmd: [executable, '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    env: { SystemRoot: systemRoot, CATALOG_ALLOCATION_BUDGET_MS: String(budgetMs) },
    stdin: 'ignore', stdout: 'pipe', stderr: 'ignore',
  })
  const timer = setTimeout(() => child.kill('SIGKILL'), budgetMs)
  timer.unref?.()
  const [exitCode, stdout] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
  ]).finally(() => clearTimeout(timer))
  const requestGeneration = Number(stdout.trim())
  if (exitCode !== 0 || !Number.isSafeInteger(requestGeneration) || requestGeneration < 1
    || performance.now() >= deadline) throw fixedCatalogFailure()
  return Object.freeze({
    requestGeneration,
    attemptIdentity: redactedFingerprint(
      'opencode-catalog-attempt-windows-v1',
      boundedIdentityMaterial([scope, requestGeneration, startedAt, randomUUID()]),
    ),
  })
}

function normalizeSqliteSchema(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().replace(/;$/, '')
}

function assertAttemptDatabaseChildren(rootReceipt: ManagedRootReceipt): void {
  assertManagedRootReceiptSync(rootReceipt)
  for (const name of ['attempts.sqlite', 'attempts.sqlite-wal', 'attempts.sqlite-shm', 'attempts.sqlite-journal']) {
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
  for (const name of readdirSync(rootReceipt.path)) {
    if (!/^\.allocation-generation-[1-9]\d*$/.test(name)) continue
    const metadata = lstatSync(path.join(rootReceipt.path, name))
    if (!metadata.isFile() || metadata.isSymbolicLink()
      || (typeof process.getuid === 'function' && metadata.uid !== process.getuid())) throw fixedCatalogFailure()
  }
}

function attemptGenerationMarkers(rootReceipt: ManagedRootReceipt): number[] {
  assertAttemptDatabaseChildren(rootReceipt)
  return readdirSync(rootReceipt.path).flatMap(name => {
    const matched = /^\.allocation-generation-([1-9]\d*)$/.exec(name)
    if (!matched) return []
    const generation = Number(matched[1])
    if (!Number.isSafeInteger(generation)) throw fixedCatalogFailure()
    return [generation]
  }).sort((left, right) => left - right)
}

function validateAttemptGenerationMarker(rootReceipt: ManagedRootReceipt, generation: number): void {
  const markers = attemptGenerationMarkers(rootReceipt)
  if (generation === 0 ? markers.length !== 0 : markers.at(-1) !== generation) throw fixedCatalogFailure()
}

function stageAttemptGenerationMarker(rootReceipt: ManagedRootReceipt, generation: number): void {
  const descriptor = openManagedRootDescriptor(rootReceipt)
  try {
    const marker = path.join(descriptor.path, `.allocation-generation-${generation}`)
    let fd: number
    try {
      fd = openSync(marker, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL
        | (fsConstants.O_NOFOLLOW ?? 0), 0o600)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const metadata = lstatSync(marker)
      if (!metadata.isFile() || metadata.isSymbolicLink()) throw fixedCatalogFailure()
      return
    }
    closeSync(fd)
  } finally {
    if (descriptor.fd !== null) closeSync(descriptor.fd)
  }
}

function cleanupAttemptGenerationMarkers(rootReceipt: ManagedRootReceipt, generation: number): void {
  const descriptor = openManagedRootDescriptor(rootReceipt)
  try {
    for (const marker of attemptGenerationMarkers(rootReceipt)) {
      if (marker >= generation) continue
      try { unlinkSync(path.join(descriptor.path, `.allocation-generation-${marker}`)) } catch {}
    }
  } finally {
    if (descriptor.fd !== null) closeSync(descriptor.fd)
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
      database.exec(`${ATTEMPT_TABLE_SQL}; ${ATTEMPT_STATE_SQL};
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
  if (validatedObjects.length !== 3) throw fixedCatalogFailure()
  const allocation = validatedObjects.find(object => object.name === 'allocation_ticket')
  const state = validatedObjects.find(object => object.name === 'allocation_state')
  const sequence = validatedObjects.find(object => object.name === 'sqlite_sequence')
  if (!allocation || allocation.type !== 'table' || allocation.tbl_name !== 'allocation_ticket'
    || typeof allocation.sql !== 'string'
    || normalizeSqliteSchema(allocation.sql) !== normalizeSqliteSchema(ATTEMPT_TABLE_SQL)
    || !state || state.type !== 'table' || state.tbl_name !== 'allocation_state'
    || typeof state.sql !== 'string'
    || normalizeSqliteSchema(state.sql) !== normalizeSqliteSchema(ATTEMPT_STATE_SQL)
    || !sequence || sequence.type !== 'table' || sequence.tbl_name !== 'sqlite_sequence'
    || sequence.sql !== 'CREATE TABLE sqlite_sequence(name,seq)'
    || validatedObjects.some(object => object.type === 'trigger' || object.type === 'index')) {
    throw fixedCatalogFailure()
  }
  const columns = database.query<{
    name: string; type: string; notnull: number; pk: number
  }, []>('PRAGMA table_info(allocation_ticket)').all()
  if (JSON.stringify(columns.map(column => [column.name, column.type, column.notnull, column.pk]))
    !== JSON.stringify([['id', 'INTEGER', 0, 1], ['scope_hash', 'TEXT', 1, 0], ['started_at', 'INTEGER', 1, 0]])) {
    throw fixedCatalogFailure()
  }
  const stateColumns = database.query<{
    name: string; type: string; notnull: number; pk: number
  }, []>('PRAGMA table_info(allocation_state)').all()
  if (JSON.stringify(stateColumns.map(column => [column.name, column.type, column.notnull, column.pk]))
    !== JSON.stringify([['singleton', 'INTEGER', 0, 1], ['generation', 'INTEGER', 1, 0]])) {
    throw fixedCatalogFailure()
  }
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
    return durableAttemptDatabase.database
  }
  durableAttemptDatabase?.database.close()
  if (durableAttemptDatabase?.rootDescriptor !== null
    && durableAttemptDatabase?.rootDescriptor !== undefined) closeSync(durableAttemptDatabase.rootDescriptor)
  durableAttemptDatabase = null
  assertManagedRootReceiptSync(rootReceipt)
  assertAttemptDatabaseChildren(rootReceipt)
  const descriptor = openManagedRootDescriptor(rootReceipt)
  const database = new Database(path.join(descriptor.path, 'attempts.sqlite'), { create: true, strict: true })
  try {
    database.exec('PRAGMA busy_timeout = 0')
    database.exec('PRAGMA journal_mode = WAL')
    database.exec('PRAGMA synchronous = NORMAL')
    assertAttemptDatabaseChildren(rootReceipt)
    const schemaVersion = validateAttemptDatabase(database)
    durableAttemptDatabase = {
      filePath: databasePath, database, rootReceipt, rootDescriptor: descriptor.fd, schemaVersion,
    }
    return database
  } catch (error) {
    database.close()
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
    testStallPhase?: 'open' | 'commit'
    testGate?: Readonly<{ phase: 'open' | 'commit'; path: string }>
  }> = {},
): Promise<Readonly<{
  requestGeneration: number
  attemptIdentity: `sha256:${string}`
}>> {
  const deadline = controls.deadline ?? Number.POSITIVE_INFINITY
  if (!boundedString(scope) || !Number.isSafeInteger(startedAt) || startedAt < 0) throw fixedCatalogFailure()
  if (process.platform === 'win32') {
    if (!controls.windowsPlatformAuthority || controls.testGate || controls.testStallPhase) {
      // Deterministic file-sandbox controls never downgrade the production
      // Windows registry authority to a raw-path test fallback.
      throw fixedCatalogFailure()
    }
    return allocateWindowsCatalogAttempt(scope, startedAt, deadline)
  }
  const cacheHome = controls.cacheHome ?? catalogCacheHome()
  const root = path.join(cacheHome, 'opencode', 'provider-catalog-attempts-v2')
  const expectedDatabasePath = path.join(root, 'attempts.sqlite')
  const rootReceipt = durableAttemptDatabase?.filePath === expectedDatabasePath
    ? durableAttemptDatabase.rootReceipt
    : captureManagedRootSync(root)
  const workerBoundary = (phase: 'open' | 'commit'): void => {
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
      validateAttemptGenerationMarker(rootReceipt, state.generation)
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
      stageAttemptGenerationMarker(rootReceipt, row.id)
      database.exec('COMMIT')
      cleanupAttemptGenerationMarkers(rootReceipt, row.id)
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
    testStallPhase?: 'open' | 'commit'
    testGate?: Readonly<{ phase: 'open' | 'commit'; path: string }>
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
  const workerCommand = sourceRuntime
    ? [process.execPath, workerPath]
    : [path.join(path.dirname(process.execPath),
      `opencode-catalog-allocation-worker${process.platform === 'win32' ? '.exe' : ''}`)]
  const worker = Bun.spawn({
    cmd: workerCommand,
    stdin: 'pipe', stdout: 'pipe', stderr: 'ignore',
  }) as unknown as AllocationWorkerProcess
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
    testStallPhase?: 'open' | 'commit'
    /** Deterministic no-follow swap gate; test code only. */
    testGate?: Readonly<{ phase: 'open' | 'commit'; path: string }>
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

async function cacheRootPath(): Promise<string> {
  return captureManagedRootSync(
    path.join(catalogCacheHome(), 'opencode', 'provider-catalog-v2'),
  ).path
}

function pathContains(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function assertCatalogRootOutsideProject(projectPath: string): void {
  const cacheHome = catalogCacheHome()
  if (pathContains(projectPath, cacheHome)) throw fixedCatalogFailure()
}

async function cacheFilePath(cacheKey: string): Promise<string> {
  return path.join(await cacheRootPath(), `${hash(cacheKey)}.current.json`)
}

function stageStorageKey(cacheKey: string, attemptId: string): string {
  return `${cacheKey}.stage.${attemptId}`
}

function pointerStorageKey(cacheKey: string): string {
  return `${cacheKey}.current`
}

async function stagedFilePath(cacheKey: string, attemptId: string): Promise<string> {
  return path.join(await cacheRootPath(), `${hash(cacheKey)}.${attemptId}.stage.json`)
}

async function readJsonFile(filePath: string): Promise<unknown | null> {
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    handle = await open(filePath, 'r')
    const bytes = new Uint8Array(MAX_PERSISTED_BYTES + 1)
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
    if (bytesRead > MAX_PERSISTED_BYTES) return null
    return JSON.parse(new TextDecoder().decode(bytes.subarray(0, bytesRead))) as unknown
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function defaultReadPointer(cacheKey: string): Promise<unknown | null> {
  const root = await cacheRootPath()
  const prefix = `${hash(cacheKey)}.`
  const candidates = (await readdir(root).catch(() => []))
    .filter(file => file.startsWith(prefix) && file.endsWith('.commit.json'))
  let winner: CommittedPointer | null = null
  for (const file of candidates) {
    const candidate = decodeCommittedPointer(await readJsonFile(path.join(root, file)))
    if (!candidate) continue
    if (winner && candidate.requestGeneration === winner.requestGeneration
      && candidate.attemptIdentity !== winner.attemptIdentity) return null
    if (!winner || compareCommittedPointers(candidate, winner) > 0) winner = candidate
  }
  return winner ?? readJsonFile(await cacheFilePath(cacheKey))
}

async function defaultReadStage(cacheKey: string, attemptId: string): Promise<unknown | null> {
  return readJsonFile(await stagedFilePath(cacheKey, attemptId))
}

async function defaultStagePersisted(cacheKey: string, attemptId: string, value: unknown): Promise<void> {
  const encoded = JSON.stringify(value)
  if (new TextEncoder().encode(encoded).byteLength > MAX_PERSISTED_BYTES) throw fixedCatalogFailure()
  const root = captureManagedRootSync(await cacheRootPath())
  const descriptor = openManagedRootDescriptor(root)
  try {
    await writeJsonFileAtomic(
      path.join(descriptor.path, `${hash(cacheKey)}.${attemptId}.stage.json`), value, { mode: 0o600 },
    )
  } finally {
    if (descriptor.fd !== null) closeSync(descriptor.fd)
  }
  assertManagedRootReceiptSync(root)
}

async function defaultPublishPointer(
  cacheKey: string,
  value: unknown,
  maxEntries: number,
  abortSignal?: AbortSignal,
  deadline = Number.POSITIVE_INFINITY,
  beforeVisibility?: () => void | Promise<void>,
  afterRetentionAuthorityRemoval?: () => void | Promise<void>,
): Promise<boolean> {
  const encoded = JSON.stringify(value)
  if (new TextEncoder().encode(encoded).byteLength > MAX_PERSISTED_BYTES) throw fixedCatalogFailure()
  const pointer = decodeCommittedPointer(value)
  if (!pointer) throw fixedCatalogFailure()
  const receipt = captureManagedRootSync(await cacheRootPath())
  const descriptor = openManagedRootDescriptor(receipt)
  const root = descriptor.path
  const lockPath = path.join(root, '.publication.lock')
  const ownerToken = randomUUID()
  const ownerPath = path.join(root, `.publication.owner.${process.pid}.${ownerToken}.json`)
  let ownsLock = false
  const processIdentity = async (pid: number): Promise<string | null> => {
    if (process.platform !== 'linux') return pid === process.pid
      ? `${process.pid}:${process.uptime()}`
      : null
    try {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
      const close = stat.lastIndexOf(')')
      const fields = stat.slice(close + 2).split(' ')
      const startTime = fields[19]
      return /^\d+$/.test(startTime ?? '') ? `linux:${pid}:${startTime}` : null
    } catch { return null }
  }
  const thisProcessIdentity = await processIdentity(process.pid)
  if (!thisProcessIdentity) throw fixedCatalogFailure()
  const ownerHandle = await open(ownerPath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
    0o600)
  try {
    await ownerHandle.writeFile(JSON.stringify({
      pid: process.pid, token: ownerToken, processIdentity: thisProcessIdentity,
    }))
    await ownerHandle.sync()
  } finally { await ownerHandle.close() }
  try {
  // The hard link is an atomic no-replace mutex whose owner bytes are already
  // complete and durable. There is no mkdir -> owner.json crash window.
  for (;;) {
    if (abortSignal?.aborted || performance.now() >= deadline) throw fixedCatalogFailure()
    try {
      await link(ownerPath, lockPath)
      const [ownerMetadata, lockMetadata] = [lstatSync(ownerPath), lstatSync(lockPath)]
      if (!ownerMetadata.isFile() || !lockMetadata.isFile()
        || ownerMetadata.isSymbolicLink() || lockMetadata.isSymbolicLink()
        || ownerMetadata.dev !== lockMetadata.dev || ownerMetadata.ino !== lockMetadata.ino) {
        throw fixedCatalogFailure()
      }
      ownsLock = true
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw fixedCatalogFailure()
      try {
        const lockMetadata = lstatSync(lockPath)
        if (!lockMetadata.isFile() || lockMetadata.isSymbolicLink()) throw fixedCatalogFailure()
        const held = await open(lockPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
        let owner: { pid?: unknown; token?: unknown; processIdentity?: unknown }
        try {
          const heldMetadata = await held.stat()
          if (heldMetadata.dev !== lockMetadata.dev || heldMetadata.ino !== lockMetadata.ino) {
            throw fixedCatalogFailure()
          }
          owner = JSON.parse((await held.readFile()).toString())
        } finally { await held.close() }
        if (!Number.isSafeInteger(owner.pid) || (owner.pid as number) < 1
          || typeof owner.token !== 'string' || typeof owner.processIdentity !== 'string') {
          throw fixedCatalogFailure()
        }
        const liveIdentity = await processIdentity(owner.pid as number)
        let alive = true
        try { process.kill(owner.pid as number, 0) }
        catch (killError) {
          if ((killError as NodeJS.ErrnoException).code === 'ESRCH') alive = false
          else throw fixedCatalogFailure()
        }
        // A matching birth identity is a live owner. A dead PID or a reused
        // PID with a different birth identity is a provably stale lock.
        if (alive && (liveIdentity === null || liveIdentity === owner.processIdentity)) {
          await new Promise<void>(resolve => setTimeout(resolve, 1))
          continue
        }
        const current = lstatSync(lockPath)
        if (current.dev !== lockMetadata.dev || current.ino !== lockMetadata.ino) continue
        await unlink(lockPath)
        const staleOwnerPath = path.join(
          root, `.publication.owner.${owner.pid as number}.${owner.token}.json`,
        )
        try {
          const staleOwner = lstatSync(staleOwnerPath)
          if (staleOwner.isFile() && !staleOwner.isSymbolicLink()
            && staleOwner.dev === lockMetadata.dev && staleOwner.ino === lockMetadata.ino) {
            await unlink(staleOwnerPath)
          }
        } catch (cleanupError) {
          if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') throw fixedCatalogFailure()
        }
        if (descriptor.fd !== null) fsyncSync(descriptor.fd)
        continue
      } catch (lockError) {
        if ((lockError as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw fixedCatalogFailure()
      }
    }
  }
  if (abortSignal?.aborted || performance.now() >= deadline) throw fixedCatalogFailure()
  let allFiles = await readdir(root).catch(() => [])
  // A retention crash may leave a non-authoritative reclaim marker after the
  // commit name was removed. Finish that exact attempt-owned cleanup before
  // considering current winners.
  for (const file of allFiles.filter(file => /^[0-9a-f]{64}\..+\.reclaim\.json$/.test(file))) {
    const pointerToReclaim = decodeCommittedPointer(await readJsonFile(path.join(root, file)))
    if (!pointerToReclaim) throw fixedCatalogFailure()
    await unlink(path.join(root,
      `${file.slice(0, 64)}.${pointerToReclaim.attemptId}.stage.json`)).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw fixedCatalogFailure()
    })
    await unlink(path.join(root, file))
    if (descriptor.fd !== null) fsyncSync(descriptor.fd)
  }
  allFiles = await readdir(root).catch(() => [])
  const decoded = (await Promise.all(allFiles
    .filter(file => /^[0-9a-f]{64}\..+\.commit\.json$/.test(file))
    .map(async file => ({ file, keyHash: file.slice(0, 64),
      pointer: decodeCommittedPointer(await readJsonFile(path.join(root, file))) }))))
    .filter((entry): entry is { file: string; keyHash: string; pointer: CommittedPointer } => entry.pointer !== null)
  const existingForKey = decoded
    .filter(entry => entry.keyHash === hash(cacheKey))
    .sort((left, right) => compareCommittedPointers(right.pointer, left.pointer))[0]
  if (existingForKey && (compareCommittedPointers(existingForKey.pointer, pointer) > 0
    || (existingForKey.pointer.requestGeneration === pointer.requestGeneration
      && existingForKey.pointer.attemptIdentity !== pointer.attemptIdentity))) {
    throw fixedCatalogFailure()
  }
  const unlinkRequired = async (filePath: string): Promise<void> => {
    try { await unlink(filePath) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw fixedCatalogFailure()
    }
  }
  const unlinkRequiredSync = (filePath: string): void => {
    try { unlinkSync(filePath) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw fixedCatalogFailure()
    }
  }
  // An uncommitted stage can belong to a live publisher in another process.
  // Never infer it obsolete from this candidate's generation. Only retention
  // of a proven committed loser may remove its exactly named stage below.
  for (const file of allFiles.filter(file => /^[0-9a-f]{64}\..+\.stage\.json$/.test(file))) {
    const envelope = snapshotRecord(await readJsonFile(path.join(root, file)))
    const evidence = envelope && snapshotRecord(envelope.catalogEvidence)
    if (evidence && Number.isSafeInteger(evidence.requestGeneration)) continue
    await unlinkRequired(path.join(root, file))
  }
  const target = defaultCommitFilePath(root, cacheKey, pointer)
  const published = [...decoded.filter(entry => entry.file !== path.basename(target)), {
    file: path.basename(target), keyHash: hash(cacheKey), pointer,
  }].sort((left, right) => compareCommittedPointers(right.pointer, left.pointer))
  const evicted = published.slice(Math.max(1, maxEntries))
  // Decide retention before the candidate has any authoritative name. An
  // already-superseded global-capacity loser is never visible, even briefly.
  if (evicted.some(entry => entry.file === path.basename(target))) return false
  const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`
  const temporaryHandle = await open(temporary, 'wx', 0o600)
  try {
    await temporaryHandle.writeFile(encoded)
    await beforeVisibility?.()
    await temporaryHandle.sync()
  } finally {
    await temporaryHandle.close()
  }
  assertManagedRootReceiptSync(receipt)
  // A synchronous time/cancellation fence immediately precedes the sole
  // visibility transition. A native sync that overruns the attempt budget can
  // therefore never rename a commit after the public deadline wins.
  if (abortSignal?.aborted || performance.now() >= deadline) {
    try { unlinkSync(temporary) } catch {}
    throw fixedCatalogFailure()
  }
  try { renameSync(temporary, target) } catch (error) {
    try { unlinkSync(temporary) } catch { /* descriptor-owned temporary may already be absent */ }
    throw error
  }
  if (descriptor.fd !== null) fsyncSync(descriptor.fd)
  // Only after the successor is durable and visible may capacity reclaim old
  // winners. Recompute from the authority while holding the same lock.
  for (const entry of evicted) {
    try {
      // Remove authority first and make that loss durable. A crash can leave an
      // reclaim marker, but can never leave an authoritative commit with no stage.
      const commitPath = path.join(root, entry.file)
      const reclaimPath = commitPath.replace(/\.commit\.json$/, '.reclaim.json')
      renameSync(commitPath, reclaimPath)
      if (descriptor.fd !== null) fsyncSync(descriptor.fd)
      if (afterRetentionAuthorityRemoval) await afterRetentionAuthorityRemoval()
      unlinkRequiredSync(path.join(root, `${entry.keyHash}.${entry.pointer.attemptId}.stage.json`))
      unlinkRequiredSync(reclaimPath)
    } catch {
      // Publication is already committed. Any reclaim marker is restart-safe;
      // stop at the first I/O failure and finish it under the next lock owner.
      break
    }
  }
  if (descriptor.fd !== null) fsyncSync(descriptor.fd)
  return true
  } finally {
    if (ownsLock) {
      try {
        const [ownerMetadata, lockMetadata] = [lstatSync(ownerPath), lstatSync(lockPath)]
        if (ownerMetadata.isFile() && lockMetadata.isFile()
          && ownerMetadata.dev === lockMetadata.dev && ownerMetadata.ino === lockMetadata.ino) {
          unlinkSync(lockPath)
        }
      } catch {}
    }
    try { unlinkSync(ownerPath) } catch {}
    if (descriptor.fd !== null) {
      try { closeSync(descriptor.fd) } catch { /* publication outcome is already determined */ }
    }
  }
}

function defaultCommitFilePath(root: string, cacheKey: string, pointer: CommittedPointer): string {
  return path.join(root,
    `${hash(cacheKey)}.${pointer.requestGeneration}.${pointer.attemptIdentity.slice(7, 23)}.commit.json`)
}

async function defaultDiscardPointer(cacheKey: string, pointer: CommittedPointer): Promise<void> {
  await defaultUnlinkCacheFile(path.basename(defaultCommitFilePath('', cacheKey, pointer)))
}

async function defaultUnlinkCacheFile(fileName: string): Promise<void> {
  const receipt = captureManagedRootSync(await cacheRootPath())
  const descriptor = openManagedRootDescriptor(receipt)
  try { await unlink(path.join(descriptor.path, path.basename(fileName))).catch(() => undefined) }
  finally { if (descriptor.fd !== null) closeSync(descriptor.fd) }
}

async function defaultCleanupStages(cacheKey: string, currentAttemptId: string): Promise<void> {
  const root = await cacheRootPath()
  const prefix = `${hash(cacheKey)}.`
  const allFiles = await readdir(root).catch(() => [])
  const files = allFiles
    .filter(file => file.startsWith(prefix) && file.endsWith('.stage.json'))
  const winner = decodeCommittedPointer(await defaultReadPointer(cacheKey))
  if (!winner) return
  const orphans = files.filter(file => file !== `${prefix}${currentAttemptId}.stage.json`)
  let removed = 0
  for (const file of orphans) {
    if (removed >= 32) break
    const envelope = snapshotRecord(await readJsonFile(path.join(root, file)))
    const evidence = envelope && snapshotRecord(envelope.catalogEvidence)
    if (!evidence || !Number.isSafeInteger(evidence.requestGeneration)
      || (evidence.requestGeneration as number) >= winner.requestGeneration) continue
    // Re-read immediately before deletion. A concurrent/future stage is never
    // inferred obsolete from the old winner snapshot.
    const currentWinner = decodeCommittedPointer(await defaultReadPointer(cacheKey))
    if (!currentWinner
      || (evidence.requestGeneration as number) >= currentWinner.requestGeneration) continue
    await unlink(path.join(root, file)).catch(() => undefined)
    removed += 1
  }
  const obsoleteCommits: string[] = []
  for (const file of allFiles.filter(file => file.startsWith(prefix) && file.endsWith('.commit.json'))) {
    const candidate = decodeCommittedPointer(await readJsonFile(path.join(root, file)))
    if (candidate && compareCommittedPointers(candidate, winner) < 0) obsoleteCommits.push(file)
  }
  for (const file of obsoleteCommits.slice(0, 32)) {
    const candidate = decodeCommittedPointer(await readJsonFile(path.join(root, file)))
    const currentWinner = decodeCommittedPointer(await defaultReadPointer(cacheKey))
    if (candidate && currentWinner && compareCommittedPointers(candidate, currentWinner) < 0) {
      await unlink(path.join(root, file)).catch(() => undefined)
    }
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
      : defaultReadPointer(key)
  }

  private readStage(key: string, attemptId: string): Promise<unknown | null> {
    return this.deps.readPersisted
      ? this.deps.readPersisted(stageStorageKey(key, attemptId))
      : defaultReadStage(key, attemptId)
  }

  private stage(key: string, attemptId: string, envelope: unknown): Promise<void> {
    return this.deps.writePersisted
      ? this.deps.writePersisted(stageStorageKey(key, attemptId), envelope)
      : defaultStagePersisted(key, attemptId, envelope)
  }

  private publish(
    key: string,
    pointer: CommittedPointer,
    maxEntries: number,
    abortSignal?: AbortSignal,
    deadline?: number,
    beforeVisibility?: () => void | Promise<void>,
    afterRetentionAuthorityRemoval?: () => void | Promise<void>,
  ): Promise<boolean> {
    return this.deps.writePersisted
      ? this.deps.writePersisted(pointerStorageKey(key), pointer).then(() => true)
      : defaultPublishPointer(
          key, pointer, maxEntries, abortSignal, deadline, beforeVisibility,
          afterRetentionAuthorityRemoval,
        )
  }

  private async revokePublishedPointer(
    key: string,
    previous: CommittedPointer | null,
    maxEntries: number,
  ): Promise<void> {
    if (previous) {
      try {
        await this.publish(key, previous, maxEntries)
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
    await unlink(await cacheFilePath(key)).catch(() => undefined)
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
  }

  private cleanupStages(key: string, currentAttemptId: string): void {
    if (this.deps.deletePersisted && this.deps.readPersisted) {
      // Custom stores own their enumeration policy; the committed stage is
      // retained for restart and known obsolete attempts are removed on abort.
      return
    }
    void (async () => {
      const winner = decodeCommittedPointer(await defaultReadPointer(key))
      await defaultCleanupStages(key, winner?.attemptId ?? currentAttemptId)
    })().catch(() => undefined)
  }

  private discardStage(key: string, attemptId: string): void {
    if (this.deps.deletePersisted) {
      void this.deps.deletePersisted(stageStorageKey(key, attemptId)).catch(() => undefined)
      return
    }
    if (!this.deps.writePersisted) {
      void defaultUnlinkCacheFile(`${hash(key)}.${attemptId}.stage.json`).catch(() => undefined)
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
          const retained = await this.publish(
            params.key, candidatePointer, params.maxEntries, params.signal, params.flight.deadline,
            this.deps.beforeVisibilitySync,
            this.deps.afterRetentionAuthorityRemoval,
          )
          if (!retained) {
            this.discardStage(params.key, attemptId)
            return false
          }
        } catch {
          this.discardStage(params.key, attemptId)
          return false
        }
        if (!this.hasCommitAuthority(params)) {
          await defaultDiscardPointer(params.key, candidatePointer)
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
        return true
      }
      // Atomic publication is the sole durable commit point. The immediately
      // preceding guard prevents a withdrawn, timed-out, or superseded flight
      // whose stage write ignored cancellation from becoming current.
      try {
        await this.publish(params.key, candidatePointer, params.maxEntries)
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
        if (!this.deps.writePersisted) {
          await defaultDiscardPointer(params.key, candidatePointer)
        } else if (!durableWinner || compareCommittedPointers(durableWinner, candidatePointer) <= 0) {
          await this.revokePublishedPointer(params.key, previousPointer, params.maxEntries)
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
        if (!this.deps.writePersisted) {
          await defaultDiscardPointer(params.key, candidatePointer)
        } else if (durableWinner && sameCommittedPointer(durableWinner, candidatePointer)) {
          await this.revokePublishedPointer(params.key, previousPointer, params.maxEntries)
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
    if (prior) {
      const refreshed = refreshCatalog(prior.catalog, clock, ttlMs, maxStaleMs)
      if (refreshed?.freshness.state === 'fresh') {
        prior = { ...prior, catalog: refreshed, lastUsedAt: clock }
        this.remember(prior, maxEntries)
        return Object.freeze({ catalog: refreshed, catalogEvidence: prior.catalogEvidence,
          catalogObservedAt: prior.catalogObservedAt, catalogExpiresAt: prior.catalogExpiresAt,
          catalogProvenance: 'cache-hit' as const, profileRootPath, projectPath, diagnostics: Object.freeze([]) })
      }
    } else {
      let persisted: Pick<CacheEntry, 'catalog' | 'catalogEvidence' | 'catalogObservedAt' | 'catalogExpiresAt'> | null = null
      try {
        const pointer = decodeCommittedPointer(await this.readPointer(key))
        if (pointer) {
          let staged: unknown = null
          try {
            staged = await this.readStage(key, pointer.attemptId)
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
      } catch {
        throw fixedCatalogFailure()
      }
      if (signal.aborted) throw fixedCatalogFailure()
      clock = this.sampleClock(clock)
      if (persisted) {
        const refreshed = refreshCatalog(persisted.catalog, clock, ttlMs, maxStaleMs)
        if (refreshed) {
          prior = { key, identity, profileRootPath, projectPath, catalog: refreshed,
            catalogEvidence: persisted.catalogEvidence, catalogObservedAt: persisted.catalogObservedAt,
            catalogExpiresAt: persisted.catalogExpiresAt, lastUsedAt: clock }
          this.generations.set(key, Math.max(this.generations.get(key) ?? 0, refreshed.generation))
          if (refreshed.freshness.state === 'fresh') {
            this.remember(prior, maxEntries)
            return Object.freeze({ catalog: refreshed, catalogEvidence: persisted.catalogEvidence,
              catalogObservedAt: persisted.catalogObservedAt, catalogExpiresAt: persisted.catalogExpiresAt,
              catalogProvenance: 'cache-hit' as const, profileRootPath, projectPath, diagnostics: Object.freeze([]) })
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
        if (signal.aborted) throw fixedCatalogFailure()
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
        if (signal.aborted) throw fixedCatalogFailure()
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
              return Object.freeze({
                catalog: durableCatalog,
                catalogEvidence: winner.catalogEvidence,
                catalogObservedAt: winner.catalogObservedAt,
                catalogExpiresAt: winner.catalogExpiresAt,
                catalogProvenance: 'cache-hit' as const,
                profileRootPath,
                projectPath,
                diagnostics: Object.freeze([]),
              })
            }
          }
          throw fixedCatalogFailure('superseded')
        }
        this.sampleClock(observedAtMs)
        return Object.freeze({ catalog, catalogEvidence: params.catalogEvidence,
          catalogObservedAt: observedAtMs, catalogExpiresAt: Math.min(MAX_EPOCH_MS, observedAtMs + ttlMs),
          catalogProvenance: 'fresh-live' as const, profileRootPath, projectPath, diagnostics: Object.freeze([]) })
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
      return Object.freeze({
        catalog: stale,
        catalogEvidence: prior!.catalogEvidence,
        catalogObservedAt: prior!.catalogObservedAt,
        catalogExpiresAt: prior!.catalogExpiresAt,
        catalogProvenance: 'bounded-stale' as const,
        profileRootPath,
        projectPath,
        diagnostics: Object.freeze(['OpenCode provider catalog refresh failed; using bounded stale data.']),
      })
    }
  }

  async loadCatalog(unsafeInput: OpenCodeProviderCatalogLoadInput): Promise<OpenCodeProviderCatalogLoadResult> {
    let deadlineTimer: ReturnType<typeof setTimeout> | null = null
    let externalAbort: (() => void) | null = null
    let ownedFlight: Flight | null = null
    try {
      const selectedOptions = options(this.deps)
      const input = snapshotInput(unsafeInput)
      if (input.abortSignal?.aborted) throw fixedCatalogFailure()
      // The one attempt deadline is armed before canonicalization, durable
      // allocation, profile preparation, cache hydration, or native/provider
      // work. A small cleanup reserve aborts owned work before the public
      // timeout boundary; no retry or fallback creates another budget.
      const attemptController = new AbortController()
      const reserveMs = Math.min(250, Math.floor(selectedOptions.timeoutMs / 10))
      const workBudgetMs = Math.max(0, selectedOptions.timeoutMs - reserveMs)
      const monotonicDeadline = performance.now() + workBudgetMs
      const setTimer = this.deps.setTimer ?? setTimeout
      const clearTimer = this.deps.clearTimer ?? clearTimeout
      const deadline = new Promise<never>((_resolve, reject) => {
        deadlineTimer = setTimer(() => {
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
      if (attemptController.signal.aborted) throw fixedCatalogFailure()
      const afterProfile = this.sampleClock(startedAt)
      const profile = snapshotProfile(rawProfile, providerId, canonicalProjectPath)
      const key = cacheKeyFor(profile.identity)
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
        if (input.abortSignal?.aborted) throw fixedCatalogFailure()
        this.sampleClock(afterProfile)
        return result
      } finally {
        rejectLocalCancellation = null
        input.abortSignal?.removeEventListener('abort', cancel)
        activeFlight.waiters.delete(waiter)
      }
    } catch (error) {
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
