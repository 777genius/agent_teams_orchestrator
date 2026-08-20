import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'
import { type ChildProcess, type SpawnOptions } from 'node:child_process'
import { constants as fsConstants, type Dirent } from 'node:fs'
import { closeSync, fstatSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { lstat, mkdir, open, readlink, readdir, readFile, realpath, rm, stat, unlink, type FileHandle } from 'node:fs/promises'
import path from 'node:path'

import * as lockfile from '../../utils/lockfile.js'
import { sleep } from '../../utils/sleep.js'
import {
  killProcessTree,
  killProcessTreeAndWait,
  readProcessCommandLine,
  readProcessStartTimeMs,
} from '../../utils/processKill.js'
import { spawnPortableCli } from '../../utils/portableCli.js'
import { resolveOpenCodeBinaryPath } from './OpenCodeBinaryResolver.js'
import {
  OpenCodeSafePublicationDirectory,
  withOpenCodeSafePublicationDirectory,
} from './OpenCodeSafePublication.js'
import {
  buildManagedConfigFingerprint,
  fingerprintOpenCodeNativeCredentialBridge,
  fingerprintOpenCodeScopedExecutionEnvironment,
  fingerprintOpenCodeScopedInheritedEnvironment,
  ensureOpenCodeManagedDirectoryPath,
  OPEN_CODE_MATERIAL_PROVIDER_ENV_ALLOWLIST,
  OPEN_CODE_SCOPED_EXECUTION_ENV_ALLOWLIST,
  openCodeProfileManager,
  revalidateOpenCodeScopedPreparedProfileInputs,
} from './OpenCodeProfileManager.js'
import { resolveClaudeMultimodelPaths } from './OpenCodeManagedPaths.js'
import {
  raceOpenCodeAbortSignal,
  throwOpenCodeAbortReason,
  waitForOpenCodeAbortableDelay,
} from './OpenCodeRuntimeDeadline.js'

import type {
  OpenCodeCompatibilityPreparedProfile,
  OpenCodeHostHandle,
  OpenCodePrepareProfileOptions,
  OpenCodePreparedProfile,
  OpenCodeScopedPreparedProfile,
} from './types.js'
import {
  canonicalSerializeOpenCodePolicyIdentity,
  deriveOpenCodeScopedHostKeyFromPlanDigest,
  resolveOpenCodeOperationPolicy,
} from './OpenCodeOperationPolicy.js'

const OPEN_CODE_HOST_HEALTH_TIMEOUT_MS = 30_000
const OPEN_CODE_HOST_HEALTH_TIMEOUT_MAX_MS = 60_000
const OPEN_CODE_HOST_HEALTH_POLL_MS = 250
const OPEN_CODE_HOST_HEALTH_REQUEST_TIMEOUT_MS = 1_000
const OPEN_CODE_RESOLVED_CONFIG_FINGERPRINT_REQUEST_TIMEOUT_MS = 2_500
const OPEN_CODE_HOST_DISPOSE_TIMEOUT_MS = 2_000
const OPEN_CODE_HOST_LEASE_REFRESH_INTERVAL_MS = 60_000
const OPEN_CODE_HOST_PROCESS_TERM_TIMEOUT_MS = 750
const OPEN_CODE_HOST_PROCESS_KILL_TIMEOUT_MS = 2_500
const OPEN_CODE_HOST_PROCESS_IDENTITY_CAPTURE_ATTEMPTS = 5
const OPEN_CODE_HOST_PROCESS_IDENTITY_CAPTURE_RETRY_MS = 50
const OPEN_CODE_HOST_ADOPTION_PROTECTION_MS = 30_000
const OPEN_CODE_MANAGED_HOST_CONFIG_GENERATION = 'provider-plugins-v1'
const OPEN_CODE_STALE_TEMP_DYLIB_AGE_MS = 24 * 60 * 60 * 1000
export const OPEN_CODE_PREFLIGHT_HOST_LEASE_TEAM_ID = '__opencode_preflight__'
const OPEN_CODE_PREFLIGHT_HOST_LEASE_LANE_ID = 'preflight'
// Bun/OpenTUI temp dylib prefixes vary between builds (.bbb, .bbc, .b9dd, ...).
// Keep the match constrained to hidden hexadecimal dylibs inside the app-owned
// profile tmp directory so unrelated user files are never removed.
const OPENTUI_TEMP_DYLIB_RE = /^\.b[0-9a-f]+-[0-9a-f]+\.dylib$/i

export type OpenCodeHostLifetime = 'persistent' | 'process'
export type OpenCodeManagedPluginStartupPolicy = 'catalog-prewarm' | 'serve-startup'

export async function resolveOpenCodeBinaryHostIdentity(binaryPath: string): Promise<string> {
  let resolvedPath = path.resolve(binaryPath)
  try {
    const target = await readlink(resolvedPath)
    resolvedPath = path.resolve(path.dirname(resolvedPath), target)
  } catch {
    // The executable is not a symlink or cannot be resolved. Its absolute path
    // remains a stable part of the identity.
  }
  const metadata = await stat(resolvedPath).catch(() => null)
  const source = [
    resolvedPath,
    metadata?.size ?? 'unknown-size',
    metadata?.mtimeMs ?? 'unknown-mtime',
  ].join('\0')
  return createHash('sha256').update(source).digest('hex').slice(0, 16)
}

const PERSISTENT_REGISTRY_LOCK_OPTIONS = {
  retries: {
    retries: 30,
    minTimeout: 5,
    maxTimeout: 100,
  },
}
const PERSISTENT_HOST_STARTUP_LOCK_OPTIONS = {
  stale: 30_000,
  update: 5_000,
  retries: 0,
}
const PERSISTENT_HOST_STARTUP_LOCK_RETRIES = 120
const PERSISTENT_HOST_STARTUP_LOCK_MIN_RETRY_MS = 100
const PERSISTENT_HOST_STARTUP_LOCK_MAX_RETRY_MS = 500

type ManagedHostEntry = {
  handle: OpenCodeHostHandle
  child: ChildProcess | null
  refCount: number
  ownedByProcess: boolean
  lifetime: OpenCodeHostLifetime
  /** Exact JSON-canonical V2 record last observed/written by this adopter. */
  adoptedRegistryReceipt?: PersistentHostRegistryRecord
  /** Private immutable receipt authorizing every created-host disposal effect. */
  createdDisposalReceipt?: CreatedHostDisposalReceipt
}

type FetchJsonResult = {
  status: number
  data: unknown
}

type OpenCodeHostManagerDeps = {
  prepareProfile?: (
    projectPath?: string | null,
    options?: OpenCodePrepareProfileOptions,
  ) => Promise<OpenCodePreparedProfile>
  allocateLoopbackPort?: () => Promise<number>
  fetchJson?: (url: string, init?: RequestInit) => Promise<FetchJsonResult>
  spawnHostProcess?: (profile: OpenCodePreparedProfile, port: number) => ChildProcess
  sleepMs?: (ms: number) => Promise<void>
  isProcessAlive?: (pid: number) => boolean
  readProcessCommandLine?: (pid: number) => Promise<string | null>
  readProcessStartTimeMs?: (pid: number) => Promise<number | null>
  killProcess?: (pid: number, signal: NodeJS.Signals) => void
  now?: () => Date
  persistentRegistryPath?: string | null
  stageScopedHostBinary?: (
    profile: OpenCodeScopedPreparedProfile,
    assertCurrent?: () => void,
  ) => Promise<VerifiedScopedBinary>
  beforePersistentRegistryWrite?: () => Promise<void>
  afterPersistentRegistryWrite?: () => Promise<void>
  scopedTransportOwnerKey?: Buffer
}

export type OpenCodeHostLeaseInput = {
  teamId: string
  laneId?: string | null
  memberName: string
  runId?: string | null
  sessionId?: string | null
}

type PersistentHostLeaseRecord = {
  leaseKey: string
  teamId: string
  laneId: string
  memberName: string
  runId: string | null
  sessionId: string | null
  createdAt: string
  updatedAt: string
}

type PersistentHostRegistryRecord = {
  hostKey: string
  profileRootKey: string
  projectPath?: string
  projectBehaviorFingerprint: string
  managedConfigFingerprint?: string | null
  baseUrl?: string
  port: number
  pid: number
  processStartedAtMs?: number | null
  version: string | null
  resolvedConfigFingerprint: string | null
  updatedAt: string
  coordinationProtectedUntil?: string
  leases?: Record<string, PersistentHostLeaseRecord>
  scopedIdentity?: OpenCodeScopedHostIdentity
  scopedTransportToken?: string
}

type PersistentHostRegistryShape = {
  schemaVersion: 1 | 2
  hosts: Record<string, PersistentHostRegistryRecord>
  /** Preservation-only values. Never inspect, normalize, or execute them. */
  legacyHosts?: Record<string, unknown>
}

type PersistentHostWriteReceipt = {
  hostKey: string
  previous: PersistentHostRegistryRecord | undefined
  written: PersistentHostRegistryRecord
}

type CreatedHostDisposalReceipt = {
  record: PersistentHostRegistryRecord
  registryReceipt: PersistentHostRegistryRecord | null
  profileTmpPath: string
  profileIdentity: string
  lifetime: OpenCodeHostLifetime
  childPid: number | null
}

function canonicalPersistentHostRegistryRecord(
  record: PersistentHostRegistryRecord,
): PersistentHostRegistryRecord {
  return JSON.parse(JSON.stringify(record)) as PersistentHostRegistryRecord
}

function immutableCanonicalPersistentHostRegistryRecord(
  record: PersistentHostRegistryRecord,
): PersistentHostRegistryRecord {
  const canonical = canonicalPersistentHostRegistryRecord(record)
  const freeze = (value: unknown): void => {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child)
    Object.freeze(value)
  }
  freeze(canonical)
  return canonical
}

function immutableCreatedHostDisposalReceipt(
  receipt: CreatedHostDisposalReceipt,
): CreatedHostDisposalReceipt {
  const canonical = JSON.parse(JSON.stringify(receipt)) as CreatedHostDisposalReceipt
  const freeze = (value: unknown): void => {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child)
    Object.freeze(value)
  }
  freeze(canonical)
  return canonical
}

const publicHostHandleSnapshots = new WeakMap<OpenCodeHostHandle, OpenCodeHostHandle>()

function frozenPublicHostHandle(handle: OpenCodeHostHandle): OpenCodeHostHandle {
  const existing = publicHostHandleSnapshots.get(handle)
  if (existing) return existing
  const freeze = (value: unknown): void => {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child)
    Object.freeze(value)
  }
  const publicProfile = structuredClone(handle.profile)
  freeze(publicProfile)
  const snapshot = Object.freeze({
    ...handle,
    profile: publicProfile,
    diagnostics: Object.freeze([...handle.diagnostics]) as unknown as string[],
  })
  publicHostHandleSnapshots.set(handle, snapshot)
  return snapshot
}

function persistentHostLifecycleIdentity(
  record: PersistentHostRegistryRecord,
  scopedTransportOwnerKey?: Buffer,
): unknown {
  const {
    updatedAt: _updatedAt,
    coordinationProtectedUntil: _protected,
    leases: _leases,
    scopedTransportToken: _transportCapability,
    ...identity
  } = record
  return {
    ...identity,
    transportPort: scopedRecordPort(record, scopedTransportOwnerKey),
    transportBaseUrl: scopedRecordBaseUrl(record, scopedTransportOwnerKey),
  }
}

function createdHostProfileIdentity(profile: OpenCodePreparedProfile): string {
  return hashText(canonicalSerializeOpenCodePolicyIdentity(
    isScopedPreparedProfile(profile)
      ? buildOpenCodeScopedHostIdentity(profile)
      : {
          projectPath: profile.projectPath,
          profileRootKey: profile.profileRootKey,
          profileRootPath: profile.profileRootPath,
          projectBehaviorFingerprint: profile.projectBehaviorFingerprint,
          managedConfigFingerprint: profile.managedConfigFingerprint,
          managedAuthFingerprint: profile.managedAuthFingerprint,
          tmpPath: profile.tmpPath,
          environment: profile.env,
        },
  ))
}

export type OpenCodeScopedHostIdentity = {
  schema: 'opencode-host-identity-v2'
  planDigest: string
  canonicalProjectPathFingerprint: string
  projectBehaviorFingerprint: string
  purposeFingerprint: string
  providerFingerprint: string
  modelFingerprint: string
  operationFingerprint: string
  profileFingerprint: string
  pluginFingerprint: string
  cacheFingerprint: string
  managedConfigFingerprint: string
  selectedAuthBaselineFingerprint: string
  managedAuthFingerprint: string | null
  providerEnvironmentFingerprint: string
  nativeCredentialBridgeFingerprint: string
  nativeTargetExecutableFingerprint: string
  nativeAccountEvidenceFingerprint: string
  executionEnvironmentFingerprint: string
  entryManifestFingerprint: string
  automaticUserPluginFingerprint: string
  binaryFingerprint: string
  policyFingerprint: string
  profileLayoutFingerprint: string
  generation: string
}

type PersistentHostProcessIdentity = {
  state: 'confirmed' | 'gone' | 'changed' | 'unverified'
  startedAtMs: number | null
}

export type OpenCodePersistentHostReconcileOptions = {
  mode?: 'stale' | 'force'
  reason?: 'startup' | 'shutdown' | 'manual' | string
  projectPath?: string | null
  staleAgeMs?: number | null
  leaseStaleAgeMs?: number | null
  preflightLeaseStaleAgeMs?: number | null
}

export type OpenCodePersistentHostReconcileResult = {
  cleaned: number
  remaining: number
  hosts: Array<{
    hostKey: string
    projectPath: string
    pid: number
    port: number
    action:
      | 'disposed'
      | 'removed_dead'
      | 'kept_active'
      | 'kept_leased'
      | 'kept_recent'
      | 'kept_filtered'
      | 'failed'
    reason: string
    leaseCount: number
  }>
  diagnostics: string[]
}

function hashJson(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(value) ?? '')
    .digest('hex')
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export type VerifiedScopedBinary = {
  profile: OpenCodeScopedPreparedProfile
  fileHandle: FileHandle
  /** Close the manager-owned descriptor at most once, including after transfer failures. */
  close: () => Promise<void>
}

export function bindVerifiedScopedBinaryHandle(
  profile: OpenCodeScopedPreparedProfile,
  fileHandle: FileHandle,
): VerifiedScopedBinary {
  let ownedHandle: FileHandle | null = fileHandle
  return {
    profile,
    fileHandle,
    close: async () => {
      const handle = ownedHandle
      ownedHandle = null
      if (handle) await handle.close()
    },
  }
}

type StageScopedHostBinaryTestHooks = {
  /** @internal Deterministic failure/ownership seam; production callers omit it. */
  afterStagedHandleOpened?: (handle: FileHandle) => void
  /** @internal Allows deterministic publication-directory close rejection. */
  closePublicationDirectory?: (directory: OpenCodeSafePublicationDirectory) => Promise<void>
}

// Capability encryption key material is never serialized beside registry
// ciphertext. This process-local key is a fail-closed fallback; durable owners
// load the same owner-only capability key from their separate key store.
const scopedTransportOwnerKeys = new Map<string, Buffer>()

function loadScopedTransportOwnerKey(registryPath: string, heldParentPath?: string): Buffer {
  const cached = scopedTransportOwnerKeys.get(registryPath)
  if (cached) return cached
  if (process.platform !== 'linux' && process.platform !== 'darwin') {
    throw new Error('OpenCode scoped capability store is unsupported [redacted]')
  }
  const fdRoot = process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd'
  const registryParent = heldParentPath ?? path.dirname(registryPath)
  const parentDescriptor = openSync(
    registryParent,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY
      | (heldParentPath ? 0 : (fsConstants.O_NOFOLLOW ?? 0)),
  )
  let storeDescriptor: number | null = null
  let descriptor: number | null = null
  try {
    const parentMetadata = fstatSync(parentDescriptor)
    if (
      !parentMetadata.isDirectory() || (parentMetadata.mode & 0o022) !== 0
      || (typeof process.getuid === 'function' && parentMetadata.uid !== process.getuid())
    ) throw new Error('OpenCode scoped capability parent is not canonical [redacted]')
    const storePath = path.join(fdRoot, String(parentDescriptor), 'host-capabilities')
    try { mkdirSync(storePath, { mode: 0o700 }) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    storeDescriptor = openSync(
      storePath,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | (fsConstants.O_NOFOLLOW ?? 0),
    )
    const storeMetadata = fstatSync(storeDescriptor)
    if (
      !storeMetadata.isDirectory() || (storeMetadata.mode & 0o077) !== 0
      || (typeof process.getuid === 'function' && storeMetadata.uid !== process.getuid())
    ) throw new Error('OpenCode scoped capability store is not canonical [redacted]')
    const keyPath = path.join(fdRoot, String(storeDescriptor), `${hashText(registryPath)}.owner-key`)
    const temporaryKeyPath = path.join(
      fdRoot, String(storeDescriptor), `.owner-key.${process.pid}.${randomUUID()}`,
    )
    try {
      descriptor = openSync(
        temporaryKeyPath,
      fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
      )
      writeFileSync(descriptor, randomBytes(32))
      const createdMetadata = fstatSync(descriptor)
      if (!createdMetadata.isFile() || createdMetadata.size !== 32) {
        throw new Error('OpenCode scoped capability owner key publication failed [redacted]')
      }
      closeSync(descriptor)
      descriptor = null
      try { linkSync(temporaryKeyPath, keyPath) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      fsyncSync(storeDescriptor)
    } catch (error) {
      throw error
    } finally {
      try { unlinkSync(temporaryKeyPath) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    descriptor = openSync(keyPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
    const metadata = fstatSync(descriptor)
    const key = readFileSync(descriptor)
    if (
      !metadata.isFile() || key.length !== 32 || (metadata.mode & 0o077) !== 0
      || (typeof process.getuid === 'function' && metadata.uid !== process.getuid())
    ) throw new Error('OpenCode scoped capability owner key is invalid [redacted]')
    scopedTransportOwnerKeys.set(registryPath, key)
    return key
  } finally {
    if (descriptor !== null) closeSync(descriptor)
    if (storeDescriptor !== null) closeSync(storeDescriptor)
    closeSync(parentDescriptor)
  }
}

function encodeScopedTransportToken(hostKey: string, port: number, ownerKey: Buffer): string {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('OpenCode scoped transport endpoint is invalid [redacted]')
  }
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', ownerKey, nonce)
  cipher.setAAD(Buffer.from(hostKey))
  const encrypted = Buffer.concat([cipher.update(String(port), 'utf8'), cipher.final()])
  return `cap:v1:${nonce.toString('hex')}:${encrypted.toString('hex')}:${cipher.getAuthTag().toString('hex')}`
}

function decodeScopedTransportToken(hostKey: string, token: string, ownerKey: Buffer): number {
  const match = /^cap:v1:([a-f0-9]{24}):([a-f0-9]+):([a-f0-9]{32})$/.exec(token)
  if (!match) throw new Error('OpenCode scoped transport capability is malformed [redacted]')
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm', ownerKey, Buffer.from(match[1]!, 'hex'),
    )
    decipher.setAAD(Buffer.from(hostKey))
    decipher.setAuthTag(Buffer.from(match[3]!, 'hex'))
    const value = Buffer.concat([
      decipher.update(Buffer.from(match[2]!, 'hex')),
      decipher.final(),
    ]).toString('utf8')
    const port = Number(value)
    if (!Number.isInteger(port) || port < 1 || port > 65_535 || String(port) !== value) throw new Error()
    return port
  } catch {
    throw new Error('OpenCode scoped transport capability authentication failed [redacted]')
  }
}

function normalizeOpenCodeHealthVersion(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 64) return null
  const trimmed = value.trim()
  return /^v?\d+\.\d+\.\d+$/.test(trimmed) ? trimmed : null
}

export async function stageScopedHostBinary(
  profile: OpenCodeScopedPreparedProfile,
  assertCurrent: () => void = () => undefined,
  testHooks?: StageScopedHostBinaryTestHooks,
): Promise<VerifiedScopedBinary> {
  const sourceHandle = await open(
    profile.binaryPath,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  )
  try { assertCurrent() } catch (error) { await sourceHandle.close(); throw error }
  const sourceBytes = await sourceHandle.readFile().finally(() => sourceHandle.close())
  assertCurrent()
  const actualFingerprint = createHash('sha256').update(sourceBytes).digest('hex')
  if (actualFingerprint !== profile.binaryFingerprint) {
    throw new Error('OpenCode scoped binary fingerprint verification failed')
  }

  const resolvedProfileRoot = path.resolve(profile.profileRootPath)
  const profileRootMetadata = await lstat(resolvedProfileRoot).catch(() => null)
  assertCurrent()
  const canonicalProfileRoot = await realpath(resolvedProfileRoot).catch(() => null)
  assertCurrent()
  if (
    !profileRootMetadata?.isDirectory()
    || profileRootMetadata.isSymbolicLink()
    || canonicalProfileRoot !== resolvedProfileRoot
    || (
      typeof process.getuid === 'function'
      && typeof profileRootMetadata.uid === 'number'
      && profileRootMetadata.uid !== process.getuid()
    )
  ) {
    throw new Error('OpenCode scoped profile root is not a canonical app-owned directory')
  }

  const ownedDirectory = path.join(resolvedProfileRoot, 'host-binaries')
  const stagedPath = path.join(ownedDirectory, profile.binaryFingerprint, 'opencode')
  const stagedDirectory = path.dirname(stagedPath)
  await ensureOpenCodeManagedDirectoryPath(stagedDirectory, resolvedProfileRoot)
  assertCurrent()
  const ownedMetadata = await lstat(ownedDirectory)
  assertCurrent()
  if (!ownedMetadata.isDirectory() || ownedMetadata.isSymbolicLink()) {
    throw new Error('OpenCode scoped binary parent is not an owned directory')
  }
  const stagedDirectoryMetadata = await lstat(stagedDirectory)
  assertCurrent()
  const canonicalStagedDirectory = await realpath(stagedDirectory).catch(() => null)
  assertCurrent()
  if (
    !stagedDirectoryMetadata.isDirectory()
    || stagedDirectoryMetadata.isSymbolicLink()
    || canonicalStagedDirectory !== stagedDirectory
    || (
      typeof process.getuid === 'function'
      && typeof stagedDirectoryMetadata.uid === 'number'
      && stagedDirectoryMetadata.uid !== process.getuid()
    )
  ) {
    throw new Error('OpenCode scoped binary content directory is not app-owned')
  }
  const publicationDirectory = await OpenCodeSafePublicationDirectory.open(stagedDirectory)
  let fileHandle: FileHandle | null = null
  let stagedHandleVerified = false
  try {
    await publicationDirectory.publishImmutableFile('opencode', sourceBytes, 0o500)
    assertCurrent()
    fileHandle = await open(
      publicationDirectory.child('opencode'),
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    )
    testHooks?.afterStagedHandleOpened?.(fileHandle)
    assertCurrent()
    const publishedBytes = await fileHandle.readFile()
    assertCurrent()
    if (createHash('sha256').update(publishedBytes).digest('hex') !== profile.binaryFingerprint) {
      throw new Error('OpenCode staged binary fingerprint verification failed')
    }
    await fileHandle.chmod(0o500)
    assertCurrent()
    stagedHandleVerified = true
  } finally {
    let publicationDirectoryClosed = false
    try {
      await (testHooks?.closePublicationDirectory?.(publicationDirectory)
        ?? publicationDirectory.close())
      publicationDirectoryClosed = true
    } finally {
      // Any operation failure, including directory close rejection, leaves
      // ownership local and closes the executable exactly once.
      if (!stagedHandleVerified || !publicationDirectoryClosed) {
        await fileHandle?.close().catch(() => undefined)
        fileHandle = null
      }
    }
  }
  try {
    // Ownership transfers only after the parent directory descriptor closes
    // successfully. A close rejection therefore cannot orphan the executable.
    const transferred = bindVerifiedScopedBinaryHandle(
      { ...profile, binaryPath: stagedPath },
      fileHandle!,
    )
    fileHandle = null
    return transferred
  } finally {
    await fileHandle?.close().catch(() => undefined)
  }
}

function registryHasAnyHosts(registry: PersistentHostRegistryShape): boolean {
  return Object.keys(registry.hosts).length > 0
    || Object.keys(registry.legacyHosts ?? {}).length > 0
}

function isNonblankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function assertValidV2RegistryRecord(
  registryHostKey: string,
  value: unknown,
): asserts value is PersistentHostRegistryRecord {
  const fail = (): never => {
    throw new Error('invalid v2 host record')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail()
  const record = value as Partial<PersistentHostRegistryRecord>
  if (
    !isNonblankString(registryHostKey)
    || record.hostKey !== registryHostKey
    || !isNonblankString(record.profileRootKey)
    || !isNonblankString(record.projectBehaviorFingerprint)
    || !Number.isSafeInteger(record.pid) || record.pid! <= 0
    || (record.processStartedAtMs !== undefined && record.processStartedAtMs !== null
      && (!Number.isFinite(record.processStartedAtMs) || record.processStartedAtMs! <= 0))
    || !isNonblankString(record.updatedAt) || !Number.isFinite(Date.parse(record.updatedAt!))
    || (record.resolvedConfigFingerprint !== null && typeof record.resolvedConfigFingerprint !== 'string')
  ) fail()
  if (
    record.managedConfigFingerprint !== undefined
    && record.managedConfigFingerprint !== null
    && !isNonblankString(record.managedConfigFingerprint)
  ) fail()
  if (record.coordinationProtectedUntil !== undefined && (
    !isNonblankString(record.coordinationProtectedUntil)
    || !Number.isFinite(Date.parse(record.coordinationProtectedUntil))
  )) fail()
  if (record.leases !== undefined) {
    if (!record.leases || typeof record.leases !== 'object' || Array.isArray(record.leases)) fail()
    for (const [leaseKey, lease] of Object.entries(record.leases)) {
      if (
        !isNonblankString(leaseKey)
        || !lease || typeof lease !== 'object' || Array.isArray(lease)
        || lease.leaseKey !== leaseKey
        || !isNonblankString(lease.teamId)
        || !isNonblankString(lease.laneId)
        || !isNonblankString(lease.memberName)
        || (lease.runId !== null && typeof lease.runId !== 'string')
        || (lease.sessionId !== null && typeof lease.sessionId !== 'string')
        || !isNonblankString(lease.createdAt) || !Number.isFinite(Date.parse(lease.createdAt))
        || !isNonblankString(lease.updatedAt) || !Number.isFinite(Date.parse(lease.updatedAt))
      ) fail()
    }
  }

  if (record.scopedIdentity) {
    const opaqueLeasePattern = /^sha256:[a-f0-9]{64}$/
    for (const [leaseKey, lease] of Object.entries(record.leases ?? {})) {
      if (
        !opaqueLeasePattern.test(leaseKey)
        || lease.leaseKey !== leaseKey
        || !opaqueLeasePattern.test(lease.teamId)
        || !opaqueLeasePattern.test(lease.laneId)
        || !opaqueLeasePattern.test(lease.memberName)
        || (lease.runId !== null && !opaqueLeasePattern.test(lease.runId))
        || (lease.sessionId !== null && !opaqueLeasePattern.test(lease.sessionId))
      ) fail()
    }
    const allowedRecordKeys = [
      'coordinationProtectedUntil', 'hostKey', 'leases', 'managedConfigFingerprint',
      'pid', 'port', 'processStartedAtMs', 'profileRootKey', 'projectBehaviorFingerprint',
      'resolvedConfigFingerprint', 'scopedIdentity', 'scopedTransportToken', 'updatedAt', 'version',
    ]
    if (Object.keys(record).some(key => !allowedRecordKeys.includes(key))) fail()
    const identity = record.scopedIdentity as unknown as Record<string, unknown>
    const expectedIdentityKeys = [
      'binaryFingerprint', 'cacheFingerprint', 'generation', 'managedAuthFingerprint',
      'managedConfigFingerprint', 'modelFingerprint', 'operationFingerprint',
      'pluginFingerprint', 'policyFingerprint', 'profileFingerprint',
      'profileLayoutFingerprint', 'canonicalProjectPathFingerprint', 'projectBehaviorFingerprint',
      'providerEnvironmentFingerprint',
      'planDigest', 'providerFingerprint', 'purposeFingerprint', 'schema', 'selectedAuthBaselineFingerprint',
      'nativeCredentialBridgeFingerprint', 'nativeTargetExecutableFingerprint',
      'nativeAccountEvidenceFingerprint', 'executionEnvironmentFingerprint',
      'entryManifestFingerprint', 'automaticUserPluginFingerprint',
    ].sort()
    if (
      canonicalSerializeOpenCodePolicyIdentity(Object.keys(identity).sort())
        !== canonicalSerializeOpenCodePolicyIdentity(expectedIdentityKeys)
      || identity.schema !== 'opencode-host-identity-v2'
      || identity.generation !== OPEN_CODE_MANAGED_HOST_CONFIG_GENERATION
      || Object.entries(identity).some(([key, entry]) =>
        key !== 'schema' && key !== 'generation' && key !== 'managedAuthFingerprint'
        && (typeof entry !== 'string' || !/^[a-f0-9]{64}$/.test(entry)))
      || (identity.managedAuthFingerprint !== null
        && (typeof identity.managedAuthFingerprint !== 'string'
          || !/^[a-f0-9]{64}$/.test(identity.managedAuthFingerprint)))
      || typeof identity.planDigest !== 'string'
      || registryHostKey !== deriveOpenCodeScopedHostKeyFromPlanDigest(identity.planDigest)
      || record.port !== 0
      || record.version !== null
      || record.projectPath !== undefined
      || record.baseUrl !== undefined
      || !isNonblankString(record.scopedTransportToken)
      || !Object.prototype.hasOwnProperty.call(record, 'processStartedAtMs')
      || !Object.prototype.hasOwnProperty.call(record, 'resolvedConfigFingerprint')
      || !Object.prototype.hasOwnProperty.call(record, 'coordinationProtectedUntil')
      || !Object.prototype.hasOwnProperty.call(record, 'leases')
      || record.profileRootKey !== identity.profileLayoutFingerprint
      || hashText(record.projectBehaviorFingerprint!) !== identity.projectBehaviorFingerprint
      || record.managedConfigFingerprint !== identity.managedConfigFingerprint
      || record.resolvedConfigFingerprint !== identity.managedConfigFingerprint
    ) fail()
    if (!/^cap:v1:[a-f0-9]{24}:[a-f0-9]+:[a-f0-9]{32}$/.test(record.scopedTransportToken!)) fail()
  } else {
    const allowedRecordKeys = [
      'baseUrl', 'coordinationProtectedUntil', 'hostKey', 'leases', 'managedConfigFingerprint',
      'pid', 'port', 'processStartedAtMs', 'profileRootKey', 'projectBehaviorFingerprint',
      'projectPath', 'resolvedConfigFingerprint', 'updatedAt', 'version',
    ]
    if (Object.keys(record).some(key => !allowedRecordKeys.includes(key))) fail()
    if (
      !Number.isInteger(record.port) || record.port! < 1 || record.port! > 65_535
      || !isNonblankString(record.projectPath)
      || record.baseUrl !== `http://127.0.0.1:${record.port}`
      || (record.version !== null && typeof record.version !== 'string')
      || record.scopedTransportToken !== undefined
    ) fail()
  }
}

function scopedRecordPort(record: PersistentHostRegistryRecord, ownerKey?: Buffer): number {
  if (record.scopedIdentity) {
    if (!ownerKey) throw new Error('OpenCode scoped host capability requires owner key [redacted]')
    return decodeScopedTransportToken(record.hostKey, record.scopedTransportToken ?? '', ownerKey)
  }
  return record.port
}

function scopedRecordBaseUrl(record: PersistentHostRegistryRecord, ownerKey?: Buffer): string {
  return record.baseUrl ?? `http://127.0.0.1:${scopedRecordPort(record, ownerKey)}`
}

function scopedRecordProjectLabel(record: PersistentHostRegistryRecord): string {
  return record.projectPath ?? `<opaque:${record.scopedIdentity?.canonicalProjectPathFingerprint ?? 'unknown'}>`
}

export function buildOpenCodeScopedHostIdentity(
  profile: OpenCodeScopedPreparedProfile,
): OpenCodeScopedHostIdentity {
  return {
    schema: 'opencode-host-identity-v2',
    planDigest: profile.scopedPlanDigest,
    canonicalProjectPathFingerprint: profile.canonicalProjectPathFingerprint,
    projectBehaviorFingerprint: hashText(profile.projectBehaviorFingerprint),
    purposeFingerprint: hashText(profile.purpose),
    providerFingerprint: hashText(profile.providerId ?? ''),
    modelFingerprint: hashText(profile.modelId ?? ''),
    operationFingerprint: hashText(profile.operationKey),
    profileFingerprint: hashText(profile.profileKey),
    pluginFingerprint: hashText(profile.pluginKey),
    cacheFingerprint: hashText(profile.cacheKey),
    managedConfigFingerprint: profile.managedConfigFingerprint,
    selectedAuthBaselineFingerprint: profile.selectedAuthBaselineFingerprint,
    managedAuthFingerprint: profile.managedAuthFingerprint,
    providerEnvironmentFingerprint: profile.providerEnvironmentFingerprint,
    nativeCredentialBridgeFingerprint: profile.nativeCredentialBridgeFingerprint,
    nativeTargetExecutableFingerprint: profile.nativeTargetExecutableFingerprint,
    nativeAccountEvidenceFingerprint: profile.nativeAccountEvidenceFingerprint,
    executionEnvironmentFingerprint: profile.executionEnvironmentFingerprint,
    entryManifestFingerprint: profile.expectedEntryManifestFingerprint,
    automaticUserPluginFingerprint: profile.automaticUserPluginFingerprint,
    binaryFingerprint: profile.binaryFingerprint,
    policyFingerprint: hashText(profile.policy.identity.canonicalInput),
    // profileScopeIdentity is the profile manager's opaque layout generation.
    // Keeping it explicit prevents adoption across layout generations without
    // inventing or persisting a raw configuration field.
    profileLayoutFingerprint: profile.profileScopeIdentity,
    generation: OPEN_CODE_MANAGED_HOST_CONFIG_GENERATION,
  }
}

export function deriveOpenCodeScopedHostKey(profile: OpenCodeScopedPreparedProfile): string {
  const canonical = deriveOpenCodeScopedHostKeyFromPlanDigest(profile.scopedPlanDigest)
  if (profile.plannedHostKey !== canonical) {
    throw new Error('OpenCode scoped prepared profile host identity mismatch [redacted]')
  }
  return canonical
}

function isScopedPreparedProfile(
  profile: OpenCodePreparedProfile,
): profile is OpenCodeScopedPreparedProfile {
  return (profile as Partial<OpenCodeScopedPreparedProfile>).scopeSchema
    === 'opencode-scoped-profile-v1'
}

async function assertValidScopedPreparedProfile(profile: OpenCodeScopedPreparedProfile): Promise<void> {
  const fail = (): never => {
    throw new Error('OpenCode scoped host requires a valid policy-bearing prepared profile [redacted]')
  }
  if (!profile || profile.scopeSchema !== 'opencode-scoped-profile-v1') fail()
  if (
    !/^[a-f0-9]{64}$/.test(profile.scopedPlanDigest)
    || profile.plannedHostKey
      !== deriveOpenCodeScopedHostKeyFromPlanDigest(profile.scopedPlanDigest)
  ) fail()
  if (!profile.providerId?.trim() || profile.purpose === 'passive-status') fail()
  if (
    profile.policy?.schema !== 'opencode-operation-policy-v2'
    || profile.policy.purpose !== profile.purpose
    || profile.policy.providerScope.kind !== 'provider'
    || profile.policy.providerScope.providerId !== profile.providerId
    || !profile.policy.profile.prepared
    || !profile.policy.profile.hostRequired
  ) fail()

  const canonicalInput = profile.policy.identity?.canonicalInput
  if (typeof canonicalInput !== 'string') fail()
  let identityInput!: Record<string, unknown>
  try {
    identityInput = JSON.parse(canonicalInput) as Record<string, unknown>
  } catch {
    fail()
  }
  if (canonicalSerializeOpenCodePolicyIdentity(identityInput) !== canonicalInput) fail()
  const provider = identityInput.provider as Record<string, unknown> | undefined
  const fingerprints = identityInput.fingerprints as Record<string, unknown> | undefined
  const inheritedEnvironment = { ...profile.env }
  if (profile.nativeCredentialBridge) {
    if (inheritedEnvironment.PATH === profile.nativeCredentialBridge.binPath) {
      delete inheritedEnvironment.PATH
    } else if (inheritedEnvironment.PATH?.startsWith(
      `${profile.nativeCredentialBridge.binPath}${path.delimiter}`,
    )) {
      inheritedEnvironment.PATH = inheritedEnvironment.PATH.slice(
        profile.nativeCredentialBridge.binPath.length + path.delimiter.length,
      )
    }
  }
  const allowedEnvironmentKeys = new Set<string>([
    ...OPEN_CODE_SCOPED_EXECUTION_ENV_ALLOWLIST,
    ...OPEN_CODE_MATERIAL_PROVIDER_ENV_ALLOWLIST,
    'HOME', 'USERPROFILE', 'TMPDIR', 'TMP', 'TEMP', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
    'XDG_CACHE_HOME', 'NPM_CONFIG_CACHE', 'CLAUDE_MULTIMODEL_DATA_HOME',
    'CLAUDE_MULTIMODEL_CACHE_HOME', 'OPENCODE_DISABLE_CLAUDE_CODE',
    'OPENCODE_CONFIG_CONTENT', 'OPENCODE_DISABLE_AUTOUPDATE', 'CURSOR_AGENT_EXECUTABLE',
    'OPENCODE_CONFIG_DIR', 'OPENCODE_DISABLE_PROJECT_CONFIG',
  ])
  const expectedPreparationLockPath = path.join(
    profile.profileRootPath,
    `prepare-${profile.operationKey.split(':').at(-1)}.lock`,
  )
  const bridge = profile.nativeCredentialBridge
  const expectedBridgeBinPath = path.join(profile.profileRootPath, 'native-subscription-cli-bin')
  if (
    identityInput.schema !== profile.policy.schema
    || identityInput.purpose !== profile.purpose
    || provider?.kind !== 'provider'
    || provider.providerId !== profile.providerId
    || !fingerprints
    || fingerprints.project !== hashText(canonicalSerializeOpenCodePolicyIdentity({
      projectPath: profile.projectPath,
      projectBehaviorFingerprint: profile.projectBehaviorFingerprint,
    }))
    || profile.canonicalProjectPathFingerprint !== hashText(
      canonicalSerializeOpenCodePolicyIdentity(profile.projectPath),
    )
    || fingerprints.model !== hashText(canonicalSerializeOpenCodePolicyIdentity(profile.modelId))
    || fingerprints.policy !== hashText(canonicalSerializeOpenCodePolicyIdentity({
      purpose: profile.purpose,
      providerId: profile.providerId,
    }))
    || fingerprints.config !== profile.managedConfigFingerprint
    || profile.managedConfigFingerprint !== buildManagedConfigFingerprint(profile.managedConfig)
    || fingerprints.auth !== profile.selectedAuthBaselineFingerprint
    || fingerprints.environment !== profile.providerEnvironmentFingerprint
    || profile.providerEnvironmentFingerprint
      !== hashText(canonicalSerializeOpenCodePolicyIdentity({
        inherited: fingerprintOpenCodeScopedInheritedEnvironment(inheritedEnvironment),
        nativeBridgeInputs: profile.nativeCredentialBridgeInputFingerprint,
        finalEnvironmentInputs: {
          npmConfigCache: profile.env.NPM_CONFIG_CACHE ?? null,
          multimodelDataHome: profile.env.CLAUDE_MULTIMODEL_DATA_HOME ?? null,
          multimodelCacheHome: profile.env.CLAUDE_MULTIMODEL_CACHE_HOME ?? null,
          disableAutoUpdate: profile.env.OPENCODE_DISABLE_AUTOUPDATE ?? null,
        },
      }))
    || profile.executionEnvironmentFingerprint
      !== fingerprintOpenCodeScopedExecutionEnvironment(profile.env)
    || hashText(canonicalSerializeOpenCodePolicyIdentity(profile.expectedEntryManifest))
      !== profile.expectedEntryManifestFingerprint
    || profile.automaticUserPluginFingerprint !== hashText(
      canonicalSerializeOpenCodePolicyIdentity(profile.expectedEntryManifest.userPluginEntries),
    )
    || profile.expectedEntryManifest.projectBehaviorFingerprint
      !== profile.projectBehaviorFingerprint
    || canonicalSerializeOpenCodePolicyIdentity(profile.expectedEntryManifest.preservedPlugins)
      !== canonicalSerializeOpenCodePolicyIdentity(profile.policy.plugins
        .filter(plugin => plugin.provenance !== 'app-managed')
        .map(plugin => ({ spec: plugin.spec, provenance: plugin.provenance })))
    || fingerprints.plugin !== hashText(canonicalSerializeOpenCodePolicyIdentity({
      plugins: profile.policy.plugins,
      automaticUserPluginEntries: profile.expectedEntryManifest.userPluginEntries,
      ...(profile.expectedEntryManifest.pluginDependencyFingerprint !== undefined
        ? { dependencySnapshot: profile.expectedEntryManifest.pluginDependencyFingerprint }
        : {}),
    }))
    || Object.keys(profile.env).some(key => !allowedEnvironmentKeys.has(key))
    || profile.env.HOME !== profile.homePath
    || profile.env.USERPROFILE !== profile.homePath
    || profile.env.TMPDIR !== profile.tmpPath
    || profile.env.TMP !== profile.tmpPath
    || profile.env.TEMP !== profile.tmpPath
    || profile.env.XDG_CONFIG_HOME !== profile.xdgConfigHome
    || profile.env.XDG_DATA_HOME !== profile.xdgDataHome
    || profile.env.XDG_CACHE_HOME !== profile.xdgCacheHome
    || profile.env.OPENCODE_DISABLE_CLAUDE_CODE !== '1'
    || profile.env.OPENCODE_CONFIG !== undefined
    || profile.env.OPENCODE_CONFIG_DIR !== path.join(
      profile.profileRootPath,
      profile.expectedEntryManifest.projectBehaviorSnapshotPath,
    )
    || profile.executionProjectPath !== path.join(
      profile.profileRootPath,
      profile.expectedEntryManifest.projectBehaviorSnapshotPath,
    )
    || profile.env.OPENCODE_DISABLE_PROJECT_CONFIG !== '1'
    || profile.env.OPENCODE_CONFIG_CONTENT !== JSON.stringify(profile.managedConfig)
    || !isNonblankString(profile.env.NPM_CONFIG_CACHE)
    || profile.homePath !== path.join(profile.profileRootPath, 'home')
    || profile.tmpPath !== path.join(profile.profileRootPath, 'tmp')
    || profile.xdgConfigHome !== path.join(profile.profileRootPath, 'config')
    || profile.xdgDataHome !== path.join(profile.profileRootPath, 'data')
    || profile.managedAuthPath !== path.join(profile.xdgDataHome, 'opencode', 'auth.json')
    || profile.pluginNodeModulesPath !== path.join(profile.xdgConfigHome, 'opencode', 'node_modules')
    || profile.preparationLockPath !== expectedPreparationLockPath
    || (bridge === null) !== (profile.providerId !== 'kiro' && profile.providerId !== 'cursor-acp')
    || (bridge === null) !== (profile.nativeTargetExecutablePath === null)
    || (profile.nativeTargetExecutablePath !== null
      && path.dirname(profile.nativeTargetExecutablePath) !== path.join(
        profile.profileRootPath,
        'native-executables',
        profile.nativeTargetExecutableFingerprint,
      ))
    || (bridge !== null && (
      bridge.providerId !== profile.providerId
      || bridge.binPath !== expectedBridgeBinPath
      || path.dirname(bridge.executablePath) !== bridge.binPath
      || path.basename(bridge.executablePath) !== (bridge.providerId === 'kiro'
        ? process.platform === 'win32' ? 'kiro-cli.cmd' : 'kiro-cli'
        : process.platform === 'win32' ? 'cursor-agent.cmd' : 'cursor-agent')
    ))
    || fingerprints.binary !== profile.binaryFingerprint
    || fingerprints.layout !== hashText(canonicalSerializeOpenCodePolicyIdentity(
      profile.scopedPlanDigest
        ? { profileLayoutGeneration: profile.profileLayoutGeneration, planDigest: profile.scopedPlanDigest }
        : profile.profileLayoutGeneration,
    ))
    || !/^[a-f0-9]{64}$/.test(profile.scopedPlanDigest)
    || profile.plannedHostKey
      !== deriveOpenCodeScopedHostKeyFromPlanDigest(profile.scopedPlanDigest)
    || canonicalSerializeOpenCodePolicyIdentity(identityInput.plugins)
      !== canonicalSerializeOpenCodePolicyIdentity(profile.policy.plugins)
  ) fail()

  const authHandle = await open(
    profile.managedAuthPath,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  ).catch(() => null)
  const authBytes = authHandle
    ? await (async () => {
        try {
          return (await authHandle.stat()).isFile() ? await authHandle.readFile() : null
        } finally {
          await authHandle.close()
        }
      })()
    : null
  if (
    !authBytes
    || hashText(authBytes.toString()) !== profile.managedAuthFingerprint
    || (() => {
      try {
        return hashText(canonicalSerializeOpenCodePolicyIdentity(JSON.parse(authBytes.toString())))
          !== profile.selectedAuthBaselineFingerprint
      } catch {
        return true
      }
    })()
    || await fingerprintOpenCodeNativeCredentialBridge(bridge)
      !== profile.nativeCredentialBridgeFingerprint
  ) fail()

  const reconstructedPolicy = resolveOpenCodeOperationPolicy({
    purpose: profile.purpose,
    providerId: profile.providerId,
    preservedPlugins: profile.policy.plugins
      .filter(plugin => plugin.provenance !== 'app-managed')
      .map(plugin => ({
        spec: plugin.spec,
        provenance: plugin.provenance as 'user' | 'project',
      })),
    fingerprints: fingerprints as unknown as Parameters<typeof resolveOpenCodeOperationPolicy>[0]['fingerprints'],
  })
  if (
    canonicalSerializeOpenCodePolicyIdentity(reconstructedPolicy)
      !== canonicalSerializeOpenCodePolicyIdentity(profile.policy)
  ) fail()
  for (const [kind, actual] of [
    ['operation', profile.operationKey],
    ['profile', profile.profileKey],
    ['plugin', profile.pluginKey],
    ['cache', profile.cacheKey],
  ] as const) {
    const expected = `opencode-operation-policy-v2:${kind}:${hashText(canonicalInput)}`
    if (actual !== expected || profile.policy.identity[`${kind}Key` as keyof typeof profile.policy.identity] !== actual) fail()
  }
  if (profile.profileScopeIdentity !== hashText(canonicalSerializeOpenCodePolicyIdentity(canonicalInput))) fail()
  if (profile.profileRootKey !== profile.profileScopeIdentity) fail()
  if (profile.profileLayoutGeneration !== '1') fail()
  if (
    !/^[a-f0-9]{64}$/.test(profile.binaryFingerprint)
    || !/^[a-f0-9]{64}$/.test(profile.nativeCredentialBridgeInputFingerprint)
    || !/^[a-f0-9]{64}$/.test(profile.nativeCredentialBridgeFingerprint)
    || !/^[a-f0-9]{64}$/.test(profile.nativeTargetExecutableFingerprint)
    || !/^[a-f0-9]{64}$/.test(profile.nativeAccountEvidenceFingerprint)
    || !/^[a-f0-9]{64}$/.test(profile.executionEnvironmentFingerprint)
    || !/^[a-f0-9]{64}$/.test(profile.expectedEntryManifestFingerprint)
  ) fail()
  await revalidateOpenCodeScopedPreparedProfileInputs(profile).catch(fail)
}

async function normalizeProjectPathForComparison(projectPath: string): Promise<string> {
  const resolved = path.resolve(projectPath)
  const canonical = await realpath(resolved).catch(() => resolved)
  const normalized = path.normalize(canonical)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function normalizeResolvedFingerprintValue(
  value: unknown,
  scope: 'config' | 'configProviders' | 'agents' | 'mcp',
): unknown {
  if (scope === 'mcp') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return value
    }
    return Object.keys(value as Record<string, unknown>).sort()
  }

  if (Array.isArray(value)) {
    const normalized = value.map(item => normalizeResolvedFingerprintValue(item, scope))
    if (scope === 'configProviders' || scope === 'agents') {
      return normalized.sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right)),
      )
    }
    return normalized
  }

  if (!value || typeof value !== 'object') {
    return value
  }

  const record = value as Record<string, unknown>
  return Object.keys(record)
    .sort()
    .reduce<Record<string, unknown>>((acc, key) => {
      // Host transport details like loopback port and inherited environment
      // are expected to drift across host restarts and must not stale sessions.
      if (key === 'environment' || key === 'server') {
        return acc
      }
      acc[key] = normalizeResolvedFingerprintValue(record[key], scope)
      return acc
    }, {})
}

async function allocateLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to allocate loopback port')))
        return
      }

      const port = address.port
      server.close(error => {
        if (error) {
          reject(error)
          return
        }
        resolve(port)
      })
    })
  })
}

async function fetchJson(url: string, init?: RequestInit): Promise<FetchJsonResult> {
  const response = await fetch(url, init)
  const text = await response.text()

  let data: unknown = null
  if (text.trim().length > 0) {
    try {
      data = JSON.parse(text) as unknown
    } catch {
      data = text
    }
  }

  return {
    status: response.status,
    data,
  }
}

function defaultPersistentRegistryPath(): string {
  const paths = resolveClaudeMultimodelPaths()
  return path.join(paths.data, 'opencode', 'host-registry.json')
}

function getOpenCodeProfileTmpPath(profileRootKey: string): string {
  const paths = resolveClaudeMultimodelPaths()
  return path.join(paths.data, 'opencode', 'profiles', profileRootKey, 'tmp')
}

async function cleanupOpenTuiTempDylibs(tempPath: string): Promise<void> {
  let entries: Dirent<string>[]
  try {
    entries = await readdir(tempPath, { withFileTypes: true })
  } catch {
    return
  }

  await Promise.all(
    entries
      .filter(entry => entry.isFile() && OPENTUI_TEMP_DYLIB_RE.test(entry.name))
      .map(entry => rm(path.join(tempPath, entry.name), { force: true }).catch(() => undefined)),
  )
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false
  }
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function opaqueLeaseValue(value: string): string {
  return `sha256:${hashText(value)}`
}

function buildLeaseKey(input: OpenCodeHostLeaseInput, opaque = false): string {
  const teamId = input.teamId.trim()
  const laneId = input.laneId?.trim() || 'primary'
  const memberName = input.memberName.trim()
  if (!teamId || !memberName) {
    throw new Error('OpenCode host lease requires teamId and memberName')
  }
  const key = `${teamId}::${laneId}::${memberName}`
  return opaque ? opaqueLeaseValue(key) : key
}

function normalizeOpenCodeHostHealthTimeoutMs(timeoutMs?: number | null): number {
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs)) {
    return OPEN_CODE_HOST_HEALTH_TIMEOUT_MS
  }
  return Math.min(Math.max(Math.trunc(timeoutMs), 1), OPEN_CODE_HOST_HEALTH_TIMEOUT_MAX_MS)
}

function isExpectedPersistentOpenCodeHostCommand(
  command: string,
  record: PersistentHostRegistryRecord,
): boolean {
  const normalized = command.replace(/\s+/g, ' ').trim()
  if (
    !/(?:^|[\s/\\])opencode(?:\.exe)?(?=["'\s]|$)/i.test(normalized) ||
    !/(?:^|\s)serve(?=\s|$)/i.test(normalized)
  ) {
    return false
  }
  const hasExpectedPort = new RegExp(
    `(?:^|\\s)--port(?:=|\\s+)${scopedRecordPort(record)}(?=\\s|$)`,
    'i',
  ).test(normalized)
  const hasLoopbackHostname =
    /(?:^|\s)--hostname(?:=|\s+)(?:127\.0\.0\.1|localhost|::1)(?=\s|$)/i.test(normalized)
  return hasExpectedPort && hasLoopbackHostname
}

export function createOpenCodePreflightHostLeaseInput(scope: string): OpenCodeHostLeaseInput {
  const normalizedScope =
    scope
      .trim()
      .replace(/[^a-zA-Z0-9_.-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 96) || 'probe'
  return {
    teamId: OPEN_CODE_PREFLIGHT_HOST_LEASE_TEAM_ID,
    laneId: OPEN_CODE_PREFLIGHT_HOST_LEASE_LANE_ID,
    memberName: `${normalizedScope}-${process.pid}-${randomUUID()}`,
    runId: null,
    sessionId: null,
  }
}

function isOpenCodePreflightHostLease(lease: PersistentHostLeaseRecord): boolean {
  return lease.teamId === OPEN_CODE_PREFLIGHT_HOST_LEASE_TEAM_ID
    || lease.teamId === opaqueLeaseValue(OPEN_CODE_PREFLIGHT_HOST_LEASE_TEAM_ID)
}

type UnrefableHandle = { unref?: () => void } | null | undefined

function unrefHandle(handle: UnrefableHandle): void {
  handle?.unref?.()
}

function unrefChildProcessHandle(child: ChildProcess): void {
  unrefHandle(child)
  unrefHandle(child.stdout as UnrefableHandle)
  unrefHandle(child.stderr as UnrefableHandle)
  unrefHandle(child.stdin as UnrefableHandle)
}

export function shouldUnrefOpenCodeHostProcess(
  lifetime: OpenCodeHostLifetime,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return lifetime === 'persistent' || platform !== 'win32'
}

export function buildOpenCodeHostSpawnOptions(
  profile: OpenCodePreparedProfile,
  platform: NodeJS.Platform = process.platform,
  options: { lifetime?: OpenCodeHostLifetime } = {},
): SpawnOptions {
  const lifetime = options.lifetime ?? 'persistent'
  return {
    cwd: isScopedPreparedProfile(profile) ? profile.executionProjectPath : profile.projectPath,
    env: profile.env,
    detached: lifetime === 'persistent' || platform !== 'win32',
    stdio: 'ignore',
    windowsHide: true,
  }
}

function normalizePersistentHostLeases(value: unknown): Record<string, PersistentHostLeaseRecord> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }

  const leases: Record<string, PersistentHostLeaseRecord> = {}
  for (const [key, rawLease] of Object.entries(value as Record<string, unknown>)) {
    if (!rawLease || typeof rawLease !== 'object' || Array.isArray(rawLease)) {
      continue
    }
    const lease = rawLease as Partial<PersistentHostLeaseRecord>
    if (
      typeof lease.teamId !== 'string' ||
      typeof lease.laneId !== 'string' ||
      typeof lease.memberName !== 'string' ||
      typeof lease.createdAt !== 'string' ||
      typeof lease.updatedAt !== 'string'
    ) {
      continue
    }
    const leaseKey =
      typeof lease.leaseKey === 'string' && lease.leaseKey.trim() ? lease.leaseKey : key
    leases[leaseKey] = {
      leaseKey,
      teamId: lease.teamId,
      laneId: lease.laneId,
      memberName: lease.memberName,
      runId: typeof lease.runId === 'string' && lease.runId.trim() ? lease.runId : null,
      sessionId:
        typeof lease.sessionId === 'string' && lease.sessionId.trim() ? lease.sessionId : null,
      createdAt: lease.createdAt,
      updatedAt: lease.updatedAt,
    }
  }
  return leases
}

export class OpenCodeHostManager {
  private readonly hosts = new Map<string, ManagedHostEntry>()
  private readonly pendingHosts = new Map<string, Promise<OpenCodeHostHandle>>()
  private readonly pendingRefCounts = new Map<string, number>()
  private readonly pendingHostHealthTimeoutMs = new Map<string, number>()
  private readonly pendingHostGenerations = new Map<string, symbol>()
  private readonly scopedStagingGenerations = new Map<string, symbol>()
  private activeRegistryDirectory: OpenCodeSafePublicationDirectory | null = null

  constructor(private readonly deps: OpenCodeHostManagerDeps = {}) {}

  private get scopedTransportOwnerKey(): Buffer {
    if (this.deps.scopedTransportOwnerKey) {
      if (this.deps.scopedTransportOwnerKey.length !== 32) {
        throw new Error('OpenCode scoped capability owner key is invalid [redacted]')
      }
      return this.deps.scopedTransportOwnerKey
    }
    const registryPath = this.persistentRegistryPath
    if (!registryPath) throw new Error('OpenCode scoped durable transport is disabled [redacted]')
    return loadScopedTransportOwnerKey(
      registryPath,
      this.activeRegistryDirectory?.descriptorPath(),
    )
  }

  private assertStartupCurrent(
    hostKey: string,
    generation: symbol,
    abortSignal?: AbortSignal,
    entry?: ManagedHostEntry,
    child?: ChildProcess,
  ): void {
    if (abortSignal?.aborted) throwOpenCodeAbortReason(abortSignal)
    if (
      this.pendingHostGenerations.get(hostKey) !== generation
      || !this.pendingHosts.has(hostKey)
      || (entry !== undefined && this.hosts.get(hostKey) !== entry)
      || (child !== undefined && (
        child.pid !== entry?.handle.pid
        || typeof child.exitCode === 'number'
        || Boolean(child.signalCode)
        || (!this.deps.spawnHostProcess && (!child.pid || !this.isProcessAlive(child.pid)))
      ))
    ) throw new Error('OpenCode host startup was cancelled before publication')
  }

  private async prepareProfile(
    projectPath?: string | null,
    options?: OpenCodePrepareProfileOptions,
  ): Promise<OpenCodePreparedProfile> {
    const prepareProfile =
      this.deps.prepareProfile ?? openCodeProfileManager.prepareProfile.bind(openCodeProfileManager)
    return prepareProfile(projectPath, options)
  }

  private async fetchJson(url: string, init?: RequestInit): Promise<FetchJsonResult> {
    return (this.deps.fetchJson ?? fetchJson)(url, init)
  }

  private async fetchJsonWithTimeout(
    url: string,
    timeoutMs: number,
    init?: RequestInit,
    abortSignal?: AbortSignal,
  ): Promise<FetchJsonResult> {
    const controller = new AbortController()
    const abortFromCaller = (): void => controller.abort(abortSignal?.reason)
    abortSignal?.addEventListener('abort', abortFromCaller, { once: true })
    const timeout = setTimeout(() => {
      controller.abort()
    }, timeoutMs)

    try {
      return await this.fetchJson(url, {
        ...init,
        signal: controller.signal,
      })
    } catch (error) {
      if (abortSignal?.aborted) throwOpenCodeAbortReason(abortSignal)
      if (controller.signal.aborted) {
        throw new Error(`OpenCode host request timed out after ${timeoutMs}ms for ${url}`)
      }
      throw error
    } finally {
      clearTimeout(timeout)
      abortSignal?.removeEventListener('abort', abortFromCaller)
    }
  }

  private async allocateLoopbackPort(): Promise<number> {
    return (this.deps.allocateLoopbackPort ?? allocateLoopbackPort)()
  }

  private async sleepMs(ms: number): Promise<void> {
    return (this.deps.sleepMs ?? ((delay: number) => sleep(delay)))(ms)
  }

  private get persistentRegistryPath(): string | null {
    return this.deps.persistentRegistryPath === undefined
      ? defaultPersistentRegistryPath()
      : this.deps.persistentRegistryPath
  }

  private getPersistentProfileTmpPath(profileRootKey: string): string {
    const registryPath = this.persistentRegistryPath
    return registryPath
      ? path.join(path.dirname(registryPath), 'profiles', profileRootKey, 'tmp')
      : getOpenCodeProfileTmpPath(profileRootKey)
  }

  private isProcessAlive(pid: number): boolean {
    return (this.deps.isProcessAlive ?? isProcessAlive)(pid)
  }

  private killProcess(pid: number, signal: NodeJS.Signals): void {
    if (this.deps.killProcess) {
      this.deps.killProcess(pid, signal)
      return
    }
    killProcessTree(pid, signal)
  }

  private async readProcessStartTimeMs(pid: number): Promise<number | null> {
    if (this.deps.readProcessStartTimeMs) {
      return this.deps.readProcessStartTimeMs(pid)
    }
    return readProcessStartTimeMs(pid)
  }

  private async readProcessCommandLine(pid: number): Promise<string | null> {
    if (this.deps.readProcessCommandLine) {
      return this.deps.readProcessCommandLine(pid)
    }
    return readProcessCommandLine(pid)
  }

  private async captureProcessStartTimeMs(
    pid: number,
    abortSignal?: AbortSignal,
  ): Promise<number | null> {
    if (this.deps.spawnHostProcess && !this.deps.readProcessStartTimeMs) {
      return null
    }
    for (
      let attempt = 0;
      attempt < OPEN_CODE_HOST_PROCESS_IDENTITY_CAPTURE_ATTEMPTS;
      attempt += 1
    ) {
      if (abortSignal?.aborted) {
        throwOpenCodeAbortReason(abortSignal)
      }
      const startedAtMs = await this.readProcessStartTimeMs(pid).catch(() => null)
      if (Number.isFinite(startedAtMs) && startedAtMs !== null) {
        return startedAtMs
      }
      if (!this.isProcessAlive(pid)) {
        return null
      }
      if (attempt + 1 < OPEN_CODE_HOST_PROCESS_IDENTITY_CAPTURE_ATTEMPTS) {
        await waitForOpenCodeAbortableDelay(
          OPEN_CODE_HOST_PROCESS_IDENTITY_CAPTURE_RETRY_MS,
          abortSignal,
        )
      }
    }
    return null
  }

  private async verifyLegacyPersistentHostIdentity(
    record: PersistentHostRegistryRecord,
    startedAtMs: number | null,
  ): Promise<number> {
    if (!Number.isFinite(startedAtMs) || startedAtMs === null) {
      throw new Error(`OpenCode host pid ${record.pid} has no verifiable process start time`)
    }
    const startedAtMsBeforeProbe = await this.readProcessStartTimeMs(record.pid).catch(() => null)
    if (startedAtMsBeforeProbe !== startedAtMs) {
      throw new Error(`OpenCode host pid ${record.pid} identity changed before legacy migration`)
    }
    const command = await this.readProcessCommandLine(record.pid).catch(() => null)
    if (!command || !isExpectedPersistentOpenCodeHostCommand(command, record)) {
      throw new Error(
        `OpenCode host pid ${record.pid} command does not match the registered serve endpoint`,
      )
    }
    // Reconciliation is a process-identity boundary, not an inventory or
    // diagnostic boundary. Exact config compatibility is checked later against
    // the caller's prepared profile during adoption; startup must never probe
    // /config/providers, /agent, or /mcp.
    const startedAtMsAfterInspection = await this.readProcessStartTimeMs(record.pid).catch(() => null)
    if (startedAtMsAfterInspection !== startedAtMs) {
      throw new Error(`OpenCode host pid ${record.pid} identity changed during legacy migration`)
    }
    return startedAtMs
  }

  private async inspectPersistentHostProcessIdentity(
    record: PersistentHostRegistryRecord,
  ): Promise<PersistentHostProcessIdentity> {
    if (!this.isProcessAlive(record.pid)) {
      return { state: 'gone', startedAtMs: null }
    }

    const startedAtMs = await this.readProcessStartTimeMs(record.pid).catch(() => null)
    if (!Number.isFinite(startedAtMs) || startedAtMs === null) {
      if (!this.isProcessAlive(record.pid)) {
        return { state: 'gone', startedAtMs: null }
      }
      // Unit tests commonly inject synthetic process control without creating a
      // real OS process. Production cleanup remains fail-closed when identity
      // cannot be read.
      const syntheticProcessControl =
        !this.deps.readProcessStartTimeMs &&
        Boolean(this.deps.isProcessAlive || this.deps.killProcess)
      return {
        state: syntheticProcessControl ? 'confirmed' : 'unverified',
        startedAtMs: null,
      }
    }

    if (
      Number.isFinite(record.processStartedAtMs) &&
      record.processStartedAtMs !== null &&
      record.processStartedAtMs !== undefined
    ) {
      return {
        state: record.processStartedAtMs === startedAtMs ? 'confirmed' : 'changed',
        startedAtMs,
      }
    }

    // A legacy PID-only record has no immutable baseline. updatedAt is not a
    // safe substitute because lease refreshes can move it past a PID reuse.
    return { state: 'unverified', startedAtMs }
  }

  private async assertPersistentHostProcessIdentity(
    record: PersistentHostRegistryRecord,
    expectedStartedAtMs?: number | null,
  ): Promise<'confirmed' | 'gone'> {
    const expectedRecord = Number.isFinite(expectedStartedAtMs) && expectedStartedAtMs !== null
      ? { ...record, processStartedAtMs: expectedStartedAtMs }
      : record
    const identity = await this.inspectPersistentHostProcessIdentity(expectedRecord)
    if (identity.state === 'gone') {
      return 'gone'
    }
    if (identity.state !== 'confirmed') {
      throw new Error(
        identity.state === 'changed'
          ? `OpenCode host pid ${record.pid} identity changed; refusing to terminate a reused pid`
          : `OpenCode host pid ${record.pid} identity could not be verified; refusing unsafe termination`,
      )
    }
    return 'confirmed'
  }

  private async killProcessAndWait(
    pid: number,
    signal: NodeJS.Signals,
    timeoutMs: number,
    expectedStartedAtMs?: number | null,
  ): Promise<boolean> {
    if (this.deps.killProcess) {
      this.deps.killProcess(pid, signal)
      await this.sleepMs(Math.min(timeoutMs, 250)).catch(() => undefined)
      return !this.isProcessAlive(pid)
    }
    return killProcessTreeAndWait(pid, signal, { timeoutMs, expectedStartedAtMs })
  }

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))()
  }

  private nowMs(): number {
    return this.now().getTime()
  }

  private nowIso(): string {
    return this.now().toISOString()
  }

  private async readPersistentRegistry(): Promise<PersistentHostRegistryShape> {
    return this.readPersistentRegistryUnlocked()
  }

  private hasTrackedAliveHostUsingTempPath(tempPath: string, ignoredPid?: number): boolean {
    for (const entry of this.hosts.values()) {
      const pid = entry.handle.pid
      if (entry.handle.profile.tmpPath !== tempPath) {
        continue
      }
      if (typeof ignoredPid === 'number' && pid === ignoredPid) {
        continue
      }
      if (pid > 0 && this.isProcessAlive(pid)) {
        return true
      }
    }
    return false
  }

  private async cleanupOpenTuiTempArtifactsIfUnused(tempPath: string, pid?: number): Promise<void> {
    if (typeof pid === 'number' && pid > 0 && this.isProcessAlive(pid)) {
      return
    }
    if (this.hasTrackedAliveHostUsingTempPath(tempPath, pid)) {
      return
    }
    await cleanupOpenTuiTempDylibs(tempPath).catch(() => undefined)
  }

  private async cleanupStaleManagedProfileTempDylibs(
    activeProfileRootKeys: ReadonlySet<string>,
  ): Promise<{ removed: number; bytes: number }> {
    const registryPath = this.persistentRegistryPath
    if (!registryPath) {
      return { removed: 0, bytes: 0 }
    }
    const profilesRootPath = path.join(path.dirname(registryPath), 'profiles')
    const profiles = await readdir(profilesRootPath, { withFileTypes: true }).catch(() => [])
    const staleBeforeMs = this.nowMs() - OPEN_CODE_STALE_TEMP_DYLIB_AGE_MS
    let removed = 0
    let bytes = 0

    for (const profile of profiles) {
      if (!profile.isDirectory() || activeProfileRootKeys.has(profile.name)) {
        continue
      }
      const tmpPath = path.join(profilesRootPath, profile.name, 'tmp')
      const entries = await readdir(tmpPath, { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        if (!entry.isFile() || !OPENTUI_TEMP_DYLIB_RE.test(entry.name)) {
          continue
        }
        const filePath = path.join(tmpPath, entry.name)
        const metadata = await stat(filePath).catch(() => null)
        if (!metadata || metadata.mtimeMs > staleBeforeMs) {
          continue
        }
        await unlink(filePath).catch(() => undefined)
        const stillExists = await stat(filePath).then(() => true).catch(() => false)
        if (!stillExists) {
          removed += 1
          bytes += metadata.size
        }
      }
    }

    return { removed, bytes }
  }

  private async readPersistentRegistryUnlocked(): Promise<PersistentHostRegistryShape> {
    const registryPath = this.persistentRegistryPath
    if (!registryPath) {
      return { schemaVersion: 1, hosts: {} }
    }

    try {
      const parentPath = path.dirname(registryPath)
      if (!this.activeRegistryDirectory) {
        const parentMetadata = await lstat(parentPath).catch(error => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
          throw error
        })
        if (!parentMetadata) return { schemaVersion: 2, hosts: {} }
      }
      const readFromDirectory = async (directory: OpenCodeSafePublicationDirectory): Promise<Buffer> => {
        const handle = await open(
          directory.child(path.basename(registryPath)),
          fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
        )
        try {
          const metadata = await handle.stat()
          if (
            !metadata.isFile() || (metadata.mode & 0o022) !== 0
            || (typeof process.getuid === 'function' && metadata.uid !== process.getuid())
          ) throw new Error('invalid registry ownership or mode')
          return await handle.readFile()
        } finally { await handle.close() }
      }
      const registryBytes = this.activeRegistryDirectory
        ? await readFromDirectory(this.activeRegistryDirectory)
        : await withOpenCodeSafePublicationDirectory(parentPath, readFromDirectory)
      const parsed = JSON.parse(
        registryBytes.toString('utf8'),
      ) as Partial<PersistentHostRegistryShape>
      if (
        (parsed.schemaVersion !== 1 && parsed.schemaVersion !== 2) ||
        !parsed.hosts ||
        typeof parsed.hosts !== 'object' ||
        Array.isArray(parsed.hosts)
      ) {
        throw new Error('invalid registry shape')
      }
      if (
        Object.prototype.hasOwnProperty.call(parsed, 'legacyHosts')
        && (parsed.legacyHosts === null
          || typeof parsed.legacyHosts !== 'object'
          || Array.isArray(parsed.legacyHosts))
      ) throw new Error('invalid legacy host registry shape')
      if (parsed.schemaVersion === 1) {
        // V1 is an opaque, unowned namespace. Do not normalize any field: a
        // subsequent V2 write must preserve every raw record byte-for-byte at
        // the JSON value level under legacyHosts.
        return {
          schemaVersion: 1,
          hosts: parsed.hosts as Record<string, PersistentHostRegistryRecord>,
        }
      }
      const hosts = Object.fromEntries(
        Object.entries(parsed.hosts as Record<string, PersistentHostRegistryRecord>).map(
          ([hostKey, record]) => {
            assertValidV2RegistryRecord(hostKey, record)
            return [hostKey, {
              ...record,
              leases: normalizePersistentHostLeases(record.leases),
            }]
          },
        ),
      )
      const legacyHosts = parsed.legacyHosts as Record<string, unknown> | undefined
      return { schemaVersion: parsed.schemaVersion, hosts, legacyHosts }
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
        // Absence is not a legacy registry. New installations start directly
        // in the validated opaque v2 namespace; only an actual v1 file is
        // preservation-only and immutable.
        return { schemaVersion: 2, hosts: {} }
      }
      throw new Error(
        'OpenCode host registry is corrupt or unreadable; refusing mutation',
        { cause: error },
      )
    }
  }

  private async writePersistentRegistryUnlocked(
    registry: PersistentHostRegistryShape,
  ): Promise<void> {
    const registryPath = this.persistentRegistryPath
    if (!registryPath) {
      return
    }
    await this.deps.beforePersistentRegistryWrite?.()
    if (!this.activeRegistryDirectory) {
      await ensureOpenCodeManagedDirectoryPath(path.dirname(registryPath), path.dirname(registryPath))
    }
    const writeToDirectory = (directory: OpenCodeSafePublicationDirectory) =>
      directory.writeFileAtomic(path.basename(registryPath), `${JSON.stringify(registry, null, 2)}\n`, 0o600)
    if (this.activeRegistryDirectory) await writeToDirectory(this.activeRegistryDirectory)
    else await withOpenCodeSafePublicationDirectory(path.dirname(registryPath), writeToDirectory)
    await this.deps.afterPersistentRegistryWrite?.()
  }

  private async unlinkPersistentRegistryUnlocked(): Promise<void> {
    const registryPath = this.persistentRegistryPath
    if (!registryPath) return
    const unlinkFromDirectory = async (directory: OpenCodeSafePublicationDirectory) => {
      await unlink(directory.child(path.basename(registryPath))).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      })
    }
    if (this.activeRegistryDirectory) await unlinkFromDirectory(this.activeRegistryDirectory)
    else await withOpenCodeSafePublicationDirectory(path.dirname(registryPath), unlinkFromDirectory)
  }

  private buildPersistentHostRecord(
    handle: OpenCodeHostHandle,
    previous?: PersistentHostRegistryRecord,
  ): PersistentHostRegistryRecord {
    const updatedAt = this.nowIso()
    const common = {
      hostKey: handle.hostKey,
      profileRootKey: handle.profileRootKey,
      projectBehaviorFingerprint: handle.projectBehaviorFingerprint,
      managedConfigFingerprint: handle.profile.managedConfigFingerprint,
      port: handle.port,
      pid: handle.pid,
      processStartedAtMs: handle.processStartedAtMs,
      version: handle.version,
      resolvedConfigFingerprint: handle.resolvedConfigFingerprint,
      updatedAt,
      coordinationProtectedUntil: new Date(
        Date.parse(updatedAt) + OPEN_CODE_HOST_ADOPTION_PROTECTION_MS,
      ).toISOString(),
      leases: normalizePersistentHostLeases(previous?.leases),
    }
    return isScopedPreparedProfile(handle.profile)
      ? {
          ...common,
          port: 0,
          version: null,
          scopedTransportToken: encodeScopedTransportToken(
            handle.hostKey, handle.port, this.scopedTransportOwnerKey,
          ),
          scopedIdentity: buildOpenCodeScopedHostIdentity(handle.profile),
        }
      : { ...common, projectPath: handle.projectPath, baseUrl: handle.baseUrl }
  }

  private captureCreatedHostDisposalReceipt(
    entry: ManagedHostEntry,
    registryReceipt: PersistentHostRegistryRecord | null,
  ): void {
    const handle = entry.handle
    entry.createdDisposalReceipt = immutableCreatedHostDisposalReceipt({
      record: {
        hostKey: handle.hostKey,
        profileRootKey: handle.profileRootKey,
        projectPath: handle.projectPath,
        projectBehaviorFingerprint: handle.projectBehaviorFingerprint,
        baseUrl: handle.baseUrl,
        port: handle.port,
        pid: handle.pid,
        processStartedAtMs: handle.processStartedAtMs,
        version: handle.version,
        resolvedConfigFingerprint: handle.resolvedConfigFingerprint,
        updatedAt: this.nowIso(),
        leases: {},
      },
      registryReceipt: registryReceipt
        ? immutableCanonicalPersistentHostRegistryRecord(registryReceipt)
        : null,
      profileTmpPath: handle.profile.tmpPath,
      profileIdentity: createdHostProfileIdentity(handle.profile),
      lifetime: entry.lifetime,
      childPid: entry.child?.pid ?? null,
    })
  }

  private assertCreatedHostDisposalReceipt(
    hostKey: string,
    entry: ManagedHostEntry,
  ): CreatedHostDisposalReceipt {
    const receipt = entry.createdDisposalReceipt
    if (!receipt) {
      throw new Error('OpenCode created host disposal receipt is unavailable [redacted]')
    }
    const handle = entry.handle
    const record = receipt.record
    if (
      hostKey !== record.hostKey
      || handle.hostKey !== record.hostKey
      || handle.profileRootKey !== record.profileRootKey
      || handle.projectPath !== record.projectPath
      || handle.projectBehaviorFingerprint !== record.projectBehaviorFingerprint
      || handle.baseUrl !== record.baseUrl
      || handle.port !== record.port
      || handle.pid !== record.pid
      || handle.processStartedAtMs !== record.processStartedAtMs
      || handle.profile.tmpPath !== receipt.profileTmpPath
      || createdHostProfileIdentity(handle.profile) !== receipt.profileIdentity
      || entry.lifetime !== receipt.lifetime
      || (entry.child?.pid ?? null) !== receipt.childPid
    ) {
      throw new Error('OpenCode created host handle/receipt mismatch [redacted]')
    }
    return receipt
  }

  private async withPersistentRegistryLock<T>(callback: () => Promise<T>): Promise<T> {
    const registryPath = this.persistentRegistryPath
    if (!registryPath) {
      return callback()
    }
    const parentPath = path.dirname(registryPath)
    await ensureOpenCodeManagedDirectoryPath(parentPath, parentPath)
    return withOpenCodeSafePublicationDirectory(parentPath, async directory => {
      const lockName = `${path.basename(registryPath)}.lock`
      await directory.ensureRegularFile(lockName)
      let release: (() => Promise<void>) | undefined
      try {
        release = await lockfile.lock(directory.child(lockName), PERSISTENT_REGISTRY_LOCK_OPTIONS)
        const previousDirectory = this.activeRegistryDirectory
        this.activeRegistryDirectory = directory
        try { return await callback() } finally { this.activeRegistryDirectory = previousDirectory }
      } finally {
        if (release) await release()
      }
    })
  }

  private async withPersistentHostStartupLock<T>(
    hostKey: string,
    callback: () => Promise<T>,
    abortSignal?: AbortSignal,
  ): Promise<T> {
    const registryPath = this.persistentRegistryPath
    if (!registryPath) {
      return callback()
    }

    const lockDir = path.join(path.dirname(registryPath), 'host-startup-locks')
    await ensureOpenCodeManagedDirectoryPath(lockDir, path.dirname(registryPath))
    return withOpenCodeSafePublicationDirectory(lockDir, async directory => {
      const lockName = `${hashText(hostKey)}.lock`
      await directory.ensureRegularFile(lockName)
      let release: (() => Promise<void>) | undefined
      try {
        release = await this.acquirePersistentHostStartupLock(directory.child(lockName), abortSignal)
        if (abortSignal?.aborted) throwOpenCodeAbortReason(abortSignal)
        return await callback()
      } finally {
        if (release) await release()
      }
    })
  }

  private async acquirePersistentHostStartupLock(
    lockPath: string,
    abortSignal?: AbortSignal,
  ): Promise<() => Promise<void>> {
    let retryDelayMs = PERSISTENT_HOST_STARTUP_LOCK_MIN_RETRY_MS
    for (let attempt = 0; ; attempt += 1) {
      if (abortSignal?.aborted) {
        throwOpenCodeAbortReason(abortSignal)
      }
      try {
        return await lockfile.lock(lockPath, PERSISTENT_HOST_STARTUP_LOCK_OPTIONS)
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error
          ? (error as { code?: unknown }).code
          : undefined
        if (code !== 'ELOCKED' || attempt >= PERSISTENT_HOST_STARTUP_LOCK_RETRIES) {
          throw error
        }
      }
      await waitForOpenCodeAbortableDelay(retryDelayMs, abortSignal)
      retryDelayMs = Math.min(
        PERSISTENT_HOST_STARTUP_LOCK_MAX_RETRY_MS,
        retryDelayMs * 2,
      )
    }
  }

  private async upsertPersistentHost(
    handle: OpenCodeHostHandle,
    generation?: symbol,
    abortSignal?: AbortSignal,
  ): Promise<PersistentHostWriteReceipt | null> {
    const registryPath = this.persistentRegistryPath
    if (!registryPath || handle.pid <= 0) {
      return null
    }
    return this.withPersistentRegistryLock(async () => {
      if (generation) this.assertStartupCurrent(handle.hostKey, generation, abortSignal)
      const registry = await this.readPersistentRegistryUnlocked()
      if (registry.schemaVersion === 1) {
        // Schema v1 is an opaque preservation namespace. A new scoped host may
        // run process-locally, but it must never normalize or migrate v1 bytes.
        return null
      }
      const previous: PersistentHostRegistryRecord | undefined = registry.hosts[handle.hostKey]
      if (generation) this.assertStartupCurrent(handle.hostKey, generation, abortSignal)
      const written = this.buildPersistentHostRecord(handle, previous)
      registry.hosts[handle.hostKey] = written
      if (generation) this.assertStartupCurrent(handle.hostKey, generation, abortSignal)
      await this.writePersistentRegistryUnlocked(registry)
      // Return ownership before the caller performs its final cancellation and
      // generation checks. If cancellation won while the atomic write hook was
      // delayed, the caller can restore only this exact publication.
      return { hostKey: handle.hostKey, previous, written }
    })
  }

  private async restorePersistentHostAfterFailedStartup(
    receipt: PersistentHostWriteReceipt,
  ): Promise<void> {
    const registryPath = this.persistentRegistryPath
    if (!registryPath) return
    await this.withPersistentRegistryLock(async () => {
      const registry = await this.readPersistentRegistryUnlocked()
      if (registry.schemaVersion !== 2) return
      const current = registry.hosts[receipt.hostKey]
      if (
        !current
        || canonicalSerializeOpenCodePolicyIdentity(current)
          !== canonicalSerializeOpenCodePolicyIdentity(receipt.written)
      ) return
      if (receipt.previous) {
        registry.hosts[receipt.hostKey] = receipt.previous
      } else {
        delete registry.hosts[receipt.hostKey]
      }
      if (!registryHasAnyHosts(registry)) {
        await this.unlinkPersistentRegistryUnlocked().catch(() => undefined)
        return
      }
      await this.writePersistentRegistryUnlocked(registry)
    })
  }

  private async removePersistentHost(
    hostKey: string,
    expected: OpenCodeHostHandle,
    _ownedByProcess: boolean,
  ): Promise<void> {
    const registryPath = this.persistentRegistryPath
    if (!registryPath) {
      return
    }
    await this.withPersistentRegistryLock(async () => {
      const registry = await this.readPersistentRegistryUnlocked()
      if (registry.schemaVersion !== 2) return
      const current = registry.hosts[hostKey]
      const expectedScopedIdentity = isScopedPreparedProfile(expected.profile)
        ? buildOpenCodeScopedHostIdentity(expected.profile)
        : null
      if (
        !current
        || current.pid !== expected.pid
        || current.processStartedAtMs !== expected.processStartedAtMs
        || current.profileRootKey !== expected.profileRootKey
        || (expectedScopedIdentity !== null && (
          !current.scopedIdentity
          || canonicalSerializeOpenCodePolicyIdentity(current.scopedIdentity)
            !== canonicalSerializeOpenCodePolicyIdentity(expectedScopedIdentity)
        ))
      ) {
        return
      }
      delete registry.hosts[hostKey]
      if (!registryHasAnyHosts(registry)) {
        await this.unlinkPersistentRegistryUnlocked().catch(() => undefined)
        return
      }
      await this.writePersistentRegistryUnlocked(registry)
    })
  }

  private async removePersistentHostByReceipt(
    hostKey: string,
    expected: PersistentHostRegistryRecord,
  ): Promise<void> {
    if (!this.persistentRegistryPath) return
    await this.withPersistentRegistryLock(async () => {
      const registry = await this.readPersistentRegistryUnlocked()
      if (registry.schemaVersion !== 2) return
      const current = registry.hosts[hostKey]
      if (!current || canonicalSerializeOpenCodePolicyIdentity(
        persistentHostLifecycleIdentity(current, this.scopedTransportOwnerKey),
      ) !== canonicalSerializeOpenCodePolicyIdentity(
        persistentHostLifecycleIdentity(expected, this.scopedTransportOwnerKey),
      )) return
      delete registry.hosts[hostKey]
      if (!registryHasAnyHosts(registry)) {
        await this.unlinkPersistentRegistryUnlocked()
      } else {
        await this.writePersistentRegistryUnlocked(registry)
      }
    })
  }

  async retainHostLease(hostKey: string, input: OpenCodeHostLeaseInput): Promise<void> {
    const registryPath = this.persistentRegistryPath
    if (!registryPath) {
      return
    }

    await this.withPersistentRegistryLock(async () => {
      const registry = await this.readPersistentRegistryUnlocked()
      if (registry.schemaVersion === 1) return
      let record = registry.hosts[hostKey]
      if (!record) {
        const entry = this.hosts.get(hostKey)
        if (!entry) {
          return
        }
        if (entry.lifetime !== 'persistent') {
          return
        }
        if (entry.ownedByProcess) {
          const receipt = this.assertCreatedHostDisposalReceipt(hostKey, entry)
          if (!receipt.registryReceipt) return
          record = canonicalPersistentHostRegistryRecord(receipt.registryReceipt)
        } else if (entry.adoptedRegistryReceipt) {
          record = canonicalPersistentHostRegistryRecord(entry.adoptedRegistryReceipt)
        } else {
          return
        }
        registry.hosts[hostKey] = record
      }
      const opaque = Boolean(record.scopedIdentity)
      const leaseKey = buildLeaseKey(input, opaque)

      const nowDate = this.now()
      const now = nowDate.toISOString()
      const nowMs = nowDate.getTime()
      const leases = normalizePersistentHostLeases(record.leases)
      const previous = leases[leaseKey]
      const requestedRunId = input.runId?.trim() || null
      const requestedSessionId = input.sessionId?.trim() || null
      const runId = requestedRunId
        ? opaque ? opaqueLeaseValue(requestedRunId) : requestedRunId
        : previous?.runId ?? null
      const sessionId = requestedSessionId
        ? opaque ? opaqueLeaseValue(requestedSessionId) : requestedSessionId
        : previous?.sessionId ?? null
      const previousUpdatedAtMs = previous ? Date.parse(previous.updatedAt) : 0
      if (
        previous &&
        previous.runId === runId &&
        previous.sessionId === sessionId &&
        Number.isFinite(previousUpdatedAtMs) &&
        nowMs - previousUpdatedAtMs < OPEN_CODE_HOST_LEASE_REFRESH_INTERVAL_MS
      ) {
        return
      }
      leases[leaseKey] = {
        leaseKey,
        teamId: opaque ? opaqueLeaseValue(input.teamId.trim()) : input.teamId.trim(),
        laneId: opaque
          ? opaqueLeaseValue(input.laneId?.trim() || 'primary')
          : input.laneId?.trim() || 'primary',
        memberName: opaque ? opaqueLeaseValue(input.memberName.trim()) : input.memberName.trim(),
        runId,
        sessionId,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
      }
      const nextRecord = canonicalPersistentHostRegistryRecord({
        ...record,
        leases,
        updatedAt: now,
      })
      registry.hosts[hostKey] = nextRecord
      await this.writePersistentRegistryUnlocked(registry)
      const tracked = this.hosts.get(hostKey)
      if (tracked && !tracked.ownedByProcess && tracked.adoptedRegistryReceipt) {
        tracked.adoptedRegistryReceipt = immutableCanonicalPersistentHostRegistryRecord(nextRecord)
      }
      if (tracked?.ownedByProcess && tracked.createdDisposalReceipt) {
        tracked.createdDisposalReceipt = immutableCreatedHostDisposalReceipt({
          ...tracked.createdDisposalReceipt,
          registryReceipt: nextRecord,
        })
      }
    })
  }

  async releaseHostLease(hostKey: string, input: OpenCodeHostLeaseInput): Promise<void> {
    const registryPath = this.persistentRegistryPath
    if (!registryPath) {
      return
    }

    await this.withPersistentRegistryLock(async () => {
      const registry = await this.readPersistentRegistryUnlocked()
      if (registry.schemaVersion === 1) return
      const record = registry.hosts[hostKey]
      if (!record) {
        return
      }
      const leaseKey = buildLeaseKey(input, Boolean(record.scopedIdentity))
      const leases = normalizePersistentHostLeases(record.leases)
      if (!leases[leaseKey]) {
        return
      }
      delete leases[leaseKey]
      const nextRecord = canonicalPersistentHostRegistryRecord({
        ...record,
        leases,
        updatedAt: this.nowIso(),
      })
      registry.hosts[hostKey] = nextRecord
      await this.writePersistentRegistryUnlocked(registry)
      const tracked = this.hosts.get(hostKey)
      if (tracked && !tracked.ownedByProcess && tracked.adoptedRegistryReceipt) {
        tracked.adoptedRegistryReceipt = immutableCanonicalPersistentHostRegistryRecord(nextRecord)
      }
      if (tracked?.ownedByProcess && tracked.createdDisposalReceipt) {
        tracked.createdDisposalReceipt = immutableCreatedHostDisposalReceipt({
          ...tracked.createdDisposalReceipt,
          registryReceipt: nextRecord,
        })
      }
    })
  }

  private async checkHealthyHostOnce(baseUrl: string): Promise<{ version: string | null } | null> {
    try {
      const result = await this.fetchJsonWithTimeout(
        `${baseUrl}/global/health`,
        OPEN_CODE_HOST_HEALTH_REQUEST_TIMEOUT_MS,
      )
      const data = result.data as { healthy?: boolean; version?: string }
      if (result.status === 200 && data?.healthy === true) {
        return {
          version: normalizeOpenCodeHealthVersion(data.version),
        }
      }
      return null
    } catch {
      return null
    }
  }

  private async adoptPersistentHost(
    hostKey: string,
    profile: OpenCodePreparedProfile,
    generation: symbol,
    abortSignal?: AbortSignal,
  ): Promise<OpenCodeHostHandle | null> {
    return this.withPersistentRegistryLock(async () => {
      this.assertStartupCurrent(hostKey, generation, abortSignal)
      if (isScopedPreparedProfile(profile)) {
        await revalidateOpenCodeScopedPreparedProfileInputs(profile)
        this.assertStartupCurrent(hostKey, generation, abortSignal)
      }
      const registry = await this.readPersistentRegistryUnlocked()
      // Schema-v1 is a preservation-only namespace. Never probe, adopt, kill,
      // delete, or rewrite one of its records.
      if (registry.schemaVersion !== 2) return null
      const record = registry.hosts[hostKey]
      if (!record) return null
      if (record.scopedIdentity
        && record.resolvedConfigFingerprint !== record.scopedIdentity.managedConfigFingerprint) {
        return null
      }
      if (isScopedPreparedProfile(profile) && (
        !record.scopedIdentity ||
        canonicalSerializeOpenCodePolicyIdentity(record.scopedIdentity)
          !== canonicalSerializeOpenCodePolicyIdentity(buildOpenCodeScopedHostIdentity(profile))
      )) return null

      const removeStaleRecord = async (): Promise<void> => {
        if (registry.hosts[hostKey] !== record) return
        delete registry.hosts[hostKey]
        if (registryHasAnyHosts(registry)) {
          await this.writePersistentRegistryUnlocked(registry)
        } else {
          await this.unlinkPersistentRegistryUnlocked().catch(() => undefined)
        }
      }
      if (
        record.profileRootKey !== profile.profileRootKey ||
        record.projectBehaviorFingerprint !== profile.projectBehaviorFingerprint ||
        record.managedConfigFingerprint !== profile.managedConfigFingerprint ||
        !this.isProcessAlive(record.pid)
      ) {
        await removeStaleRecord()
        return null
      }
      const processIdentity = await this.inspectPersistentHostProcessIdentity(record)
      if (processIdentity.state === 'gone' || processIdentity.state === 'changed') {
        await removeStaleRecord()
        return null
      }
      const baseUrl = scopedRecordBaseUrl(
        record,
        record.scopedIdentity ? this.scopedTransportOwnerKey : undefined,
      )
      const health = await raceOpenCodeAbortSignal(
        this.checkHealthyHostOnce(baseUrl),
        abortSignal,
      )
      if (!health) {
        if (processIdentity.state === 'unverified') {
          throw new Error(
            `OpenCode host pid ${record.pid} is unhealthy and its process identity ` +
            'could not be verified; refusing to launch a duplicate persistent host',
          )
        }
        await this.terminatePersistentHostRecord({ ...record, baseUrl }, { force: true })
        await removeStaleRecord()
        return null
      }
      const identityAfterHealth = await this.inspectPersistentHostProcessIdentity({
        ...record,
        processStartedAtMs: processIdentity.startedAtMs ?? record.processStartedAtMs,
      })
      if (identityAfterHealth.state === 'gone' || identityAfterHealth.state === 'changed') {
        await removeStaleRecord()
        return null
      }
      if (identityAfterHealth.state !== 'confirmed') {
        throw new Error(
          `OpenCode host pid ${record.pid} identity could not be reverified after health probe; ` +
          'refusing to publish an adopted host',
        )
      }
      if (abortSignal?.aborted) throwOpenCodeAbortReason(abortSignal)

      // Membership is still protected by the registry lock here. Publication
      // and the PID-birth recheck are therefore atomic with reconciliation.
      if (
        registry.hosts[hostKey] !== record
        || this.pendingHostGenerations.get(hostKey) !== generation
        || !this.pendingHosts.has(hostKey)
      ) return null
      const handle: OpenCodeHostHandle = Object.freeze({
        hostKey,
        profileRootKey: record.profileRootKey,
        projectPath: profile.projectPath,
        projectBehaviorFingerprint: record.projectBehaviorFingerprint,
        baseUrl,
        port: scopedRecordPort(
          record,
          record.scopedIdentity ? this.scopedTransportOwnerKey : undefined,
        ),
        pid: record.pid,
        processStartedAtMs: identityAfterHealth.startedAtMs ?? record.processStartedAtMs,
        version: health.version ?? record.version,
        state: 'healthy',
        profile,
        resolvedConfigFingerprint: record.resolvedConfigFingerprint,
        diagnostics: Object.freeze(isScopedPreparedProfile(profile)
          ? ['adopted persistent OpenCode host [redacted]']
          : [`adopted persistent OpenCode host pid=${record.pid}`]) as unknown as string[],
      })
      const entry: ManagedHostEntry = {
        handle,
        child: null,
        refCount: this.pendingRefCounts.get(hostKey) ?? 1,
        ownedByProcess: false,
        lifetime: 'persistent',
      }
      let registryPublished = false
      try {
        this.assertStartupCurrent(hostKey, generation, abortSignal)
        this.hosts.set(hostKey, entry)
        this.assertStartupCurrent(hostKey, generation, abortSignal, entry)
        this.assertStartupCurrent(hostKey, generation, abortSignal, entry)
        const publishedRecord = canonicalPersistentHostRegistryRecord(
          this.buildPersistentHostRecord(handle, record),
        )
        registry.hosts[hostKey] = publishedRecord
        this.assertStartupCurrent(hostKey, generation, abortSignal, entry)
        await this.writePersistentRegistryUnlocked(registry)
        registryPublished = true
        entry.adoptedRegistryReceipt = immutableCanonicalPersistentHostRegistryRecord(publishedRecord)
        this.assertStartupCurrent(hostKey, generation, abortSignal, entry)
        this.assertStartupCurrent(hostKey, generation, abortSignal, entry)
        return handle
      } catch (error) {
        if (this.hosts.get(hostKey) === entry) this.hosts.delete(hostKey)
        if (registryPublished) {
          registry.hosts[hostKey] = record
          await this.writePersistentRegistryUnlocked(registry)
          if (error && typeof error === 'object') {
            Object.assign(error, { openCodePersistentRecordRestored: true })
          }
        }
        throw error
      }
    })
  }

  private async waitForHealthyHost(
    baseUrl: string,
    getHealthTimeoutMs: () => number = () => OPEN_CODE_HOST_HEALTH_TIMEOUT_MS,
    abortSignal?: AbortSignal,
  ): Promise<{ version: string | null }> {
    const startedAt = this.nowMs()
    let healthTimeoutMs = normalizeOpenCodeHostHealthTimeoutMs(getHealthTimeoutMs())

    while (this.nowMs() - startedAt < healthTimeoutMs) {
      if (abortSignal?.aborted) {
        throw abortSignal.reason instanceof Error
          ? abortSignal.reason
          : new Error('OpenCode host startup aborted')
      }
      try {
        const result = await this.fetchJsonWithTimeout(
          `${baseUrl}/global/health`,
          OPEN_CODE_HOST_HEALTH_REQUEST_TIMEOUT_MS,
          undefined,
          abortSignal,
        )
        const data = result.data as { healthy?: boolean; version?: string }
        if (result.status === 200 && data?.healthy === true) {
          return {
            version: normalizeOpenCodeHealthVersion(data.version),
          }
        }
      } catch {
        if (abortSignal?.aborted) throwOpenCodeAbortReason(abortSignal)
        // Retry until the deadline expires.
      }

      await raceOpenCodeAbortSignal(this.sleepMs(OPEN_CODE_HOST_HEALTH_POLL_MS), abortSignal)
      healthTimeoutMs = normalizeOpenCodeHostHealthTimeoutMs(getHealthTimeoutMs())
    }

    throw new Error(`OpenCode host did not become healthy within ${healthTimeoutMs}ms`)
  }

  private async getResolvedConfigFingerprint(baseUrl: string): Promise<string | null> {
    try {
      const [config, configProviders, agents, mcp] = await Promise.all([
        this.fetchJsonWithTimeout(
          `${baseUrl}/config`,
          OPEN_CODE_RESOLVED_CONFIG_FINGERPRINT_REQUEST_TIMEOUT_MS,
        ),
        this.fetchJsonWithTimeout(
          `${baseUrl}/config/providers`,
          OPEN_CODE_RESOLVED_CONFIG_FINGERPRINT_REQUEST_TIMEOUT_MS,
        ),
        this.fetchJsonWithTimeout(
          `${baseUrl}/agent`,
          OPEN_CODE_RESOLVED_CONFIG_FINGERPRINT_REQUEST_TIMEOUT_MS,
        ),
        this.fetchJsonWithTimeout(
          `${baseUrl}/mcp`,
          OPEN_CODE_RESOLVED_CONFIG_FINGERPRINT_REQUEST_TIMEOUT_MS,
        ),
      ])

      const fingerprintSource = {
        config:
          config.status === 200 ? normalizeResolvedFingerprintValue(config.data, 'config') : null,
        configProviders:
          configProviders.status === 200
            ? normalizeResolvedFingerprintValue(configProviders.data, 'configProviders')
            : null,
        agents:
          agents.status === 200 ? normalizeResolvedFingerprintValue(agents.data, 'agents') : null,
        mcp: mcp.status === 200 ? normalizeResolvedFingerprintValue(mcp.data, 'mcp') : null,
      }

      if (
        fingerprintSource.config === null &&
        fingerprintSource.configProviders === null &&
        fingerprintSource.agents === null &&
        fingerprintSource.mcp === null
      ) {
        return null
      }
      return hashJson(fingerprintSource)
    } catch {
      return null
    }
  }

  private spawnHost(
    profile: OpenCodePreparedProfile,
    port: number,
    lifetime: OpenCodeHostLifetime,
    verifiedScopedBinary?: VerifiedScopedBinary,
  ): ChildProcess {
    if (this.deps.spawnHostProcess) {
      return this.deps.spawnHostProcess(profile, port)
    }

    const spawnOptions = buildOpenCodeHostSpawnOptions(profile, process.platform, { lifetime })
    const binaryPath = isScopedPreparedProfile(profile)
      ? (() => {
          if (!verifiedScopedBinary || verifiedScopedBinary.profile.binaryPath !== profile.binaryPath) {
            throw new Error('OpenCode scoped host requires verified staged bytes')
          }
          if (process.platform === 'linux' || process.platform === 'darwin') {
            spawnOptions.stdio = ['pipe', 'pipe', 'pipe', verifiedScopedBinary.fileHandle.fd]
            return process.platform === 'linux' ? '/proc/self/fd/3' : '/dev/fd/3'
          }
          throw new Error('OpenCode scoped verified-handle execution is unsupported on this platform')
        })()
      : resolveOpenCodeBinaryPath() ?? 'opencode'
    return spawnPortableCli(
      binaryPath,
      ['serve', '--hostname', '127.0.0.1', '--port', String(port)],
      spawnOptions,
    )
  }

  private bindHostLifecycle(hostKey: string, entry: ManagedHostEntry): void {
    if (!entry.child) {
      return
    }
    const pushDiagnostic = (message: string): void => {
      entry.handle.diagnostics.push(message)
      if (entry.handle.diagnostics.length > 20) {
        entry.handle.diagnostics.splice(0, entry.handle.diagnostics.length - 20)
      }
    }

    entry.child.once('error', error => {
      pushDiagnostic(isScopedPreparedProfile(entry.handle.profile)
        ? 'process error: [redacted]'
        : `process error: ${error instanceof Error ? error.message : String(error)}`)
    })

    entry.child.once('exit', (code, signal) => {
      if (this.hosts.get(hostKey) !== entry) {
        return
      }

      if (entry.handle.state !== 'disposed') {
        entry.handle.state = 'degraded'
        publicHostHandleSnapshots.delete(entry.handle)
        pushDiagnostic(
          `process exited${typeof code === 'number' ? ` with code ${code}` : ''}${signal ? ` (${signal})` : ''}`,
        )
      }

      if (this.hosts.get(hostKey) === entry) this.hosts.delete(hostKey)
      this.pendingHosts.delete(hostKey)
      const receipt = entry.createdDisposalReceipt
      if (receipt?.registryReceipt) {
        void this.removePersistentHostByReceipt(hostKey, receipt.registryReceipt)
          .catch(() => undefined)
      } else if (!receipt) {
        // Startup failed before a receipt could be published to a caller.
        void this.removePersistentHost(hostKey, entry.handle, entry.ownedByProcess)
          .catch(() => undefined)
      }
      void this.cleanupOpenTuiTempArtifactsIfUnused(
        receipt?.profileTmpPath ?? entry.handle.profile.tmpPath,
      ).catch(() => undefined)
    })
  }

  private async forceKillSpawnedHostProcess(child: ChildProcess): Promise<void> {
    const pid = child.pid
    try {
      if (pid) {
        if (await this.killProcessAndWait(pid, 'SIGTERM', OPEN_CODE_HOST_PROCESS_TERM_TIMEOUT_MS)) {
          return
        }
      } else {
        child.kill('SIGTERM')
      }
    } catch {
      // Best effort.
    }

    if (!pid) {
      return
    }

    try {
      await this.killProcessAndWait(pid, 'SIGKILL', OPEN_CODE_HOST_PROCESS_KILL_TIMEOUT_MS)
    } catch {
      // Best effort.
    }
  }

  private hasOwnedChildExited(child: ChildProcess): boolean {
    if (typeof child.exitCode === 'number' || child.signalCode) {
      return true
    }
    return !child.pid || !this.isProcessAlive(child.pid)
  }

  private async killOwnedChildAndWait(
    child: ChildProcess,
    signal: NodeJS.Signals,
    timeoutMs: number,
  ): Promise<boolean> {
    if (this.hasOwnedChildExited(child)) {
      return true
    }

    return new Promise(resolve => {
      let settled = false
      let timeout: ReturnType<typeof setTimeout> | null = null
      const finish = (exited: boolean): void => {
        if (settled) {
          return
        }
        settled = true
        if (timeout) {
          clearTimeout(timeout)
        }
        child.off('exit', handleExit)
        child.off('close', handleExit)
        resolve(exited)
      }
      const handleExit = (): void => finish(true)

      child.once('exit', handleExit)
      child.once('close', handleExit)
      timeout = setTimeout(() => finish(this.hasOwnedChildExited(child)), timeoutMs)
      timeout.unref?.()

      try {
        const signalled = child.kill(signal)
        if (!signalled && this.hasOwnedChildExited(child)) {
          finish(true)
        }
      } catch {
        finish(this.hasOwnedChildExited(child))
      }
    })
  }

  private async terminateOwnedProcessHostByReceipt(
    entry: ManagedHostEntry,
    receipt: CreatedHostDisposalReceipt,
  ): Promise<void> {
    const child = entry.child
    if (!child) {
      throw new Error('Owned process-scoped OpenCode host has no child process handle')
    }

    entry.handle.state = 'disposed'
    const pid = receipt.childPid
    try {
      await this.fetchJsonWithTimeout(
        `${receipt.record.baseUrl}/global/dispose`,
        OPEN_CODE_HOST_DISPOSE_TIMEOUT_MS,
        { method: 'POST' },
      )
    } catch {
      // Best effort.
    }

    let terminated = this.hasOwnedChildExited(child)
    if (!terminated) {
      terminated = await this.killOwnedChildAndWait(
        child,
        'SIGTERM',
        OPEN_CODE_HOST_PROCESS_TERM_TIMEOUT_MS,
      )
    }
    if (!terminated) {
      terminated = await this.killOwnedChildAndWait(
        child,
        'SIGKILL',
        OPEN_CODE_HOST_PROCESS_KILL_TIMEOUT_MS,
      )
    }
    if (!terminated) {
      entry.handle.state = 'degraded'
      throw new Error(
        `OpenCode host pid ${pid ?? receipt.record.pid} did not exit through its owned child handle; ` +
        'refusing unsafe PID-based termination without verified process identity',
      )
    }

    child.stdout?.destroy()
    child.stderr?.destroy()
    child.stdin?.destroy()
    this.hosts.delete(receipt.record.hostKey)
    this.pendingHosts.delete(receipt.record.hostKey)
    // The owned child emitted/confirmed exit, so do not reclassify that known
    // fact through a PID liveness probe that could observe immediate PID reuse.
    await this.cleanupOpenTuiTempArtifactsIfUnused(receipt.profileTmpPath)
  }

  private async createHost(
    hostKey: string,
    profile: OpenCodePreparedProfile,
    lifetime: OpenCodeHostLifetime,
    generation: symbol,
    verifiedScopedBinary?: VerifiedScopedBinary,
    abortSignal?: AbortSignal,
  ): Promise<OpenCodeHostHandle> {
    const port = await this.allocateLoopbackPort()
    const baseUrl = `http://127.0.0.1:${port}`
    await this.cleanupOpenTuiTempArtifactsIfUnused(profile.tmpPath).catch(() => undefined)
    this.assertStartupCurrent(hostKey, generation, abortSignal)
    if (isScopedPreparedProfile(profile)) {
      await revalidateOpenCodeScopedPreparedProfileInputs(profile)
      this.assertStartupCurrent(hostKey, generation, abortSignal)
    }
    const child = this.spawnHost(profile, port, lifetime, verifiedScopedBinary)

    const diagnostics: string[] = []
    const captureOutput = (source: 'stdout' | 'stderr') => (chunk: Buffer | string) => {
      const message = chunk.toString('utf8').trim()
      if (!message) {
        return
      }
      diagnostics.push(isScopedPreparedProfile(profile)
        ? `${source}: [redacted]`
        : `${source}: ${message}`)
      if (diagnostics.length > 20) {
        diagnostics.splice(0, diagnostics.length - 20)
      }
    }

    child.stdout?.on('data', captureOutput('stdout'))
    child.stderr?.on('data', captureOutput('stderr'))

    const handle: OpenCodeHostHandle = {
      hostKey,
      profileRootKey: profile.profileRootKey,
      projectPath: profile.projectPath,
      projectBehaviorFingerprint: profile.projectBehaviorFingerprint,
      baseUrl,
      port,
      pid: child.pid ?? -1,
      version: null,
      state: 'starting',
      profile,
      resolvedConfigFingerprint: null,
      diagnostics,
    }

    const entry: ManagedHostEntry = {
      handle,
      child,
      refCount: this.pendingRefCounts.get(hostKey) ?? 1,
      ownedByProcess: true,
      lifetime,
    }
    // Publish a private pre-health receipt before the tracked entry becomes
    // observable. Cancellation can then dispose only the owned child/endpoint
    // even though no process-birth or registry receipt exists yet.
    this.captureCreatedHostDisposalReceipt(entry, null)
    this.assertStartupCurrent(hostKey, generation, abortSignal)
    this.hosts.set(hostKey, entry)
    this.assertStartupCurrent(hostKey, generation, abortSignal, entry, child)
    this.bindHostLifecycle(hostKey, entry)
    if (shouldUnrefOpenCodeHostProcess(lifetime)) {
      unrefChildProcessHandle(child)
    }

    let persistentWriteReceipt: PersistentHostWriteReceipt | null = null
    try {
      const health = await this.waitForHealthyHost(
        baseUrl,
        () => this.pendingHostHealthTimeoutMs.get(hostKey) ?? OPEN_CODE_HOST_HEALTH_TIMEOUT_MS,
        abortSignal,
      )
      handle.version = health.version
      handle.resolvedConfigFingerprint = profile.managedConfigFingerprint
      handle.state = 'healthy'
      handle.processStartedAtMs = await this.captureProcessStartTimeMs(handle.pid, abortSignal)
      if (
        handle.processStartedAtMs === null &&
        lifetime === 'persistent' &&
        !this.deps.spawnHostProcess
      ) {
        throw new Error(
          `OpenCode host pid ${handle.pid} process identity could not be captured after startup`,
        )
      }
      if (handle.processStartedAtMs === null && lifetime === 'process') {
        diagnostics.push(
          `OpenCode host pid ${handle.pid} process identity was unavailable; ` +
          'cleanup is restricted to the owned child process handle',
        )
      }
      if (lifetime === 'persistent') {
        persistentWriteReceipt = await this.upsertPersistentHost(handle, generation, abortSignal)
      }
      this.captureCreatedHostDisposalReceipt(entry, persistentWriteReceipt?.written ?? null)
      this.assertStartupCurrent(hostKey, generation, abortSignal, entry, child)
      return handle
    } catch (error) {
      handle.state = 'degraded'
      const message = isScopedPreparedProfile(profile)
        ? 'OpenCode scoped host startup failed'
        : error instanceof Error ? error.message : String(error)
      diagnostics.push(message)
      if (this.hosts.get(hostKey) === entry) this.hosts.delete(hostKey)
      await this.forceKillSpawnedHostProcess(child)
      if (persistentWriteReceipt) {
        await this.restorePersistentHostAfterFailedStartup(persistentWriteReceipt)
          .catch(() => undefined)
      }
      await this.cleanupOpenTuiTempArtifactsIfUnused(profile.tmpPath, child.pid)
      if (abortSignal?.aborted && abortSignal.reason instanceof Error) {
        throw abortSignal.reason
      }
      const diagnosticSuffix =
        diagnostics.length > 0 ? ` Diagnostics: ${diagnostics.join(' | ')}` : ''
      throw new Error(`${message}${diagnosticSuffix}`)
    }
  }

  private async ensurePreparedHost(
    params: {
      hostKey?: string | null
      preparedProfile: OpenCodePreparedProfile
      healthTimeoutMs?: number | null
      hostLifetime?: OpenCodeHostLifetime
      /** @deprecated Ignored. Startup is health-only; use the explicit diagnostic refresh boundary. */
      resolveConfigFingerprint?: boolean
      abortSignal?: AbortSignal
      verifiedScopedBinary?: VerifiedScopedBinary
    },
  ): Promise<OpenCodeHostHandle> {
    if (params.abortSignal?.aborted) {
      throwOpenCodeAbortReason(params.abortSignal)
    }
    const profile = params.preparedProfile
    const scopedProfile = isScopedPreparedProfile(profile)
    const binaryPath = scopedProfile ? profile.binaryPath : resolveOpenCodeBinaryPath()
    const hostLifetime = params.hostLifetime ?? 'persistent'
    const explicitHostKey = params.hostKey?.trim()
    const hostKey = explicitHostKey || await (async () => {
      const binaryHostIdentity = binaryPath
        ? await raceOpenCodeAbortSignal(
            resolveOpenCodeBinaryHostIdentity(binaryPath),
            params.abortSignal,
          )
        : 'missing-binary'
      const baseHostKey = `${profile.projectPath}::${profile.profileRootKey}::${profile.projectBehaviorFingerprint}::${profile.managedConfigFingerprint}::auth:${profile.managedAuthFingerprint}::${OPEN_CODE_MANAGED_HOST_CONFIG_GENERATION}::binary:${binaryHostIdentity}`
      return hostLifetime === 'process'
        ? `${baseHostKey}::process:${process.pid}:${randomUUID()}`
        : baseHostKey
    })()
    const healthTimeoutMs = normalizeOpenCodeHostHealthTimeoutMs(params.healthTimeoutMs)
    // Scoped identity is fully determined by the prepared profile. It must not
    // enumerate agents, models, or providers as an implicit startup side effect.
    // Compatibility and scoped startup are health-only. Inventory/config
    // surfaces are available solely through refreshResolvedConfigFingerprint.
    const existing = this.hosts.get(hostKey)
    if (existing && existing.handle.state === 'healthy') {
      if (scopedProfile) {
        await revalidateOpenCodeScopedPreparedProfileInputs(profile)
        if (
          !isScopedPreparedProfile(existing.handle.profile)
          || canonicalSerializeOpenCodePolicyIdentity(
            buildOpenCodeScopedHostIdentity(existing.handle.profile),
          ) !== canonicalSerializeOpenCodePolicyIdentity(buildOpenCodeScopedHostIdentity(profile))
        ) throw new Error('OpenCode in-memory scoped host identity mismatch [redacted]')
      }
      if (params.abortSignal?.aborted) throwOpenCodeAbortReason(params.abortSignal)
      existing.refCount += 1
      return existing.handle
    }

    const pending = this.pendingHosts.get(hostKey)
    if (pending) {
      this.pendingHostHealthTimeoutMs.set(
        hostKey,
        Math.max(this.pendingHostHealthTimeoutMs.get(hostKey) ?? 0, healthTimeoutMs),
      )
      const handle = await raceOpenCodeAbortSignal(pending, params.abortSignal)
      if (scopedProfile && (
        !isScopedPreparedProfile(handle.profile)
        || canonicalSerializeOpenCodePolicyIdentity(buildOpenCodeScopedHostIdentity(handle.profile))
          !== canonicalSerializeOpenCodePolicyIdentity(buildOpenCodeScopedHostIdentity(profile))
      )) throw new Error('OpenCode pending scoped host identity mismatch [redacted]')
      const pendingEntry = this.hosts.get(hostKey)
      if (pendingEntry) {
        pendingEntry.refCount += 1
      }
      if (params.abortSignal?.aborted) throwOpenCodeAbortReason(params.abortSignal)
      return handle
    }

    this.pendingRefCounts.set(hostKey, 1)
    this.pendingHostHealthTimeoutMs.set(hostKey, healthTimeoutMs)
    const generation = Symbol(hostKey)
    this.pendingHostGenerations.set(hostKey, generation)
    // Defer the startup body by one microtask so pending-map membership is
    // published before the first generation assertion, including when durable
    // coordination is disabled and the lock callback can otherwise run inline.
    const createPromise = Promise.resolve().then(async () => {
      return this.withPersistentHostStartupLock(hostKey, async () => {
        const adopted =
          hostLifetime === 'persistent'
            ? await this.adoptPersistentHost(
                hostKey,
                profile,
                generation,
                params.abortSignal,
              )
            : null
        return adopted ?? this.createHost(
          hostKey,
          profile,
          hostLifetime,
          generation,
          params.verifiedScopedBinary,
          params.abortSignal,
        )
      }, params.abortSignal)
    }).catch(error => {
      // Registry cleanup is performed only by the startup branch that wrote
      // the record, and each branch also removes only its own host-map entry.
      // A stale outer generation must never erase a later generation's handle.
      throw error
    }).finally(() => {
      if (this.pendingHostGenerations.get(hostKey) === generation) {
        this.pendingHosts.delete(hostKey)
        this.pendingRefCounts.delete(hostKey)
        this.pendingHostHealthTimeoutMs.delete(hostKey)
        this.pendingHostGenerations.delete(hostKey)
      }
    })
    this.pendingHosts.set(hostKey, createPromise)
    return createPromise
  }

  /** Compatibility-only host entry point. Policy-bearing profiles are rejected. */
  async ensureHost(
    params: {
      projectPath?: string | null
      hostKey?: string | null
      profileOptions?: OpenCodePrepareProfileOptions
      preparedProfile?: OpenCodeCompatibilityPreparedProfile
      healthTimeoutMs?: number | null
      hostLifetime?: OpenCodeHostLifetime
      resolveConfigFingerprint?: boolean
      abortSignal?: AbortSignal
      /** @deprecated Host startup never performs inventory/catalog prewarming. */
      managedPluginStartupPolicy?: OpenCodeManagedPluginStartupPolicy
    } = {},
  ): Promise<OpenCodeHostHandle> {
    if (params.abortSignal?.aborted) throwOpenCodeAbortReason(params.abortSignal)
    const profile = params.preparedProfile ?? await raceOpenCodeAbortSignal(
      this.prepareProfile(params.projectPath, {
        ...params.profileOptions,
        abortSignal: params.abortSignal,
      }),
      params.abortSignal,
    )
    if (isScopedPreparedProfile(profile)) {
      throw new Error('OpenCode scoped profiles require ensureScopedHost [redacted]')
    }
    return frozenPublicHostHandle(await this.ensurePreparedHost({
      preparedProfile: profile,
      hostKey: params.hostKey,
      healthTimeoutMs: params.healthTimeoutMs,
      hostLifetime: params.hostLifetime,
      resolveConfigFingerprint: false,
      abortSignal: params.abortSignal,
    }))
  }

  /** Start/adopt only from a policy-bearing S1 profile. */
  async ensureScopedHost(params: {
    preparedProfile: OpenCodeScopedPreparedProfile
    expectedHostKey: string
    healthTimeoutMs?: number | null
    abortSignal?: AbortSignal
  }): Promise<OpenCodeHostHandle> {
    const expectedHostKey = params?.expectedHostKey
    if (typeof expectedHostKey !== 'string' || !expectedHostKey.trim()) {
      throw new Error('OpenCode scoped host requires a nonblank expectedHostKey')
    }
    const profile = params?.preparedProfile
    // The expected-key gate is deliberately pure and precedes filesystem,
    // snapshot and executable validation. A caller presenting the wrong key
    // must not be able to trigger even a defensive publication or repair.
    let hostKey: string
    try {
      hostKey = deriveOpenCodeScopedHostKey(profile)
    } catch {
      throw new Error('OpenCode scoped host profile shape is invalid [redacted]')
    }
    if (expectedHostKey !== hostKey) {
      throw new Error('OpenCode expectedHostKey mismatch [redacted]')
    }
    await assertValidScopedPreparedProfile(profile)
    if (params.abortSignal?.aborted) throwOpenCodeAbortReason(params.abortSignal)
    // Install the tombstone before the first staging await. disposeHost can
    // therefore invalidate a startup even while bytes are still being copied.
    const stagingGeneration = Symbol(hostKey)
    this.scopedStagingGenerations.set(hostKey, stagingGeneration)
    let verifiedBinary: VerifiedScopedBinary | null = null
    let stageResultAbandoned = false
    let startupDelegated = false
    let stagePromise: Promise<VerifiedScopedBinary>
    try {
      stagePromise = (this.deps.stageScopedHostBinary ?? stageScopedHostBinary)(profile, () => {
        if (this.scopedStagingGenerations.get(hostKey) !== stagingGeneration) {
          throw new Error('OpenCode scoped host startup was cancelled [redacted]')
        }
        if (params.abortSignal?.aborted) throwOpenCodeAbortReason(params.abortSignal)
      })
    } catch (error) {
      if (this.scopedStagingGenerations.get(hostKey) === stagingGeneration) {
        this.scopedStagingGenerations.delete(hostKey)
      }
      throw error
    }
    // An abort can win the race before staging settles. Close any late handle
    // from this outer scope so cancellation cannot leak an executable FD.
    void stagePromise.then(async result => {
      if (stageResultAbandoned) await result.close().catch(() => undefined)
    }, () => undefined)
    try {
      verifiedBinary = await raceOpenCodeAbortSignal(
        stagePromise,
        params.abortSignal,
      )
      if (
        this.scopedStagingGenerations.get(hostKey) !== stagingGeneration
        || params.abortSignal?.aborted
      ) {
        if (params.abortSignal?.aborted) throwOpenCodeAbortReason(params.abortSignal)
        throw new Error('OpenCode scoped host startup was cancelled [redacted]')
      }
      const lifetime: OpenCodeHostLifetime = verifiedBinary.profile.policy.profile.hostLifetime
        === 'retained' ? 'persistent' : 'process'
      if (this.scopedStagingGenerations.get(hostKey) !== stagingGeneration) {
        throw new Error('OpenCode scoped host startup was cancelled [redacted]')
      }
      startupDelegated = true
      return frozenPublicHostHandle(await this.ensurePreparedHost({
        preparedProfile: verifiedBinary.profile,
        hostKey,
        hostLifetime: lifetime,
        healthTimeoutMs: params.healthTimeoutMs,
        resolveConfigFingerprint: false,
        abortSignal: params.abortSignal,
        verifiedScopedBinary: verifiedBinary,
      }))
    } catch (error) {
      if (!verifiedBinary) stageResultAbandoned = true
      if (params.abortSignal?.aborted) throwOpenCodeAbortReason(params.abortSignal)
      if (!verifiedBinary || !startupDelegated) throw error
      throw new Error('OpenCode scoped host startup failed [redacted]')
    } finally {
      await verifiedBinary?.close().catch(() => undefined)
      if (this.scopedStagingGenerations.get(hostKey) === stagingGeneration) {
        this.scopedStagingGenerations.delete(hostKey)
      }
    }
  }

  getHost(hostKey: string): OpenCodeHostHandle | null {
    const handle = this.hosts.get(hostKey)?.handle
    return handle ? frozenPublicHostHandle(handle) : null
  }

  async refreshResolvedConfigFingerprint(hostKey: string): Promise<string | null> {
    const entry = this.hosts.get(hostKey)
    if (!entry) {
      return null
    }

    if (isScopedPreparedProfile(entry.handle.profile)) {
      return entry.handle.profile.managedConfigFingerprint
    }

    const fingerprint = await this.getResolvedConfigFingerprint(entry.handle.baseUrl)
    if (fingerprint) {
      entry.handle.resolvedConfigFingerprint = fingerprint
      publicHostHandleSnapshots.delete(entry.handle)
    }
    return entry.handle.resolvedConfigFingerprint
  }

  private async terminatePersistentHostRecord(
    record: PersistentHostRegistryRecord,
    options: { force: boolean; ignoreTrackedHandle?: boolean; cleanupTempPath?: string },
  ): Promise<void> {
    const entry = options.ignoreTrackedHandle ? undefined : this.hosts.get(record.hostKey)
    const baseUrl = entry?.handle.baseUrl ?? scopedRecordBaseUrl(
      record,
      record.scopedIdentity ? this.scopedTransportOwnerKey : undefined,
    )
    const pid = entry?.handle.pid ?? record.pid
    let terminated = false

    const processIdentity = await this.inspectPersistentHostProcessIdentity({
      ...record,
      processStartedAtMs: entry?.handle.processStartedAtMs ?? record.processStartedAtMs,
    })
    if (processIdentity.state === 'gone') {
      terminated = true
    } else if (processIdentity.state !== 'confirmed') {
      throw new Error(
        processIdentity.state === 'changed'
          ? `OpenCode host pid ${pid} identity changed; refusing to terminate a reused pid`
          : `OpenCode host pid ${pid} identity could not be verified; refusing unsafe termination`,
      )
    }

    if (!terminated) {
      try {
        await this.fetchJsonWithTimeout(
          `${baseUrl}/global/dispose`,
          OPEN_CODE_HOST_DISPOSE_TIMEOUT_MS,
          {
            method: 'POST',
          },
        )
      } catch {
        // Best effort.
      }
    }

    if (!terminated && pid > 0 && this.isProcessAlive(pid)) {
      const identityBeforeKill = await this.assertPersistentHostProcessIdentity(
        record,
        processIdentity.startedAtMs,
      )
      if (identityBeforeKill === 'gone') {
        terminated = true
      } else if (entry?.child?.pid) {
        terminated = await this.killProcessAndWait(
          entry.child.pid,
          'SIGTERM',
          OPEN_CODE_HOST_PROCESS_TERM_TIMEOUT_MS,
          processIdentity.startedAtMs,
        )
      } else {
        terminated = await this.killProcessAndWait(
          pid,
          'SIGTERM',
          OPEN_CODE_HOST_PROCESS_TERM_TIMEOUT_MS,
          processIdentity.startedAtMs,
        )
      }
    } else if (!terminated && entry?.child) {
      entry.child.kill('SIGTERM')
    }

    if (options.force && pid > 0 && !terminated && this.isProcessAlive(pid)) {
      const identityBeforeForceKill = await this.assertPersistentHostProcessIdentity(
        record,
        processIdentity.startedAtMs,
      )
      terminated =
        identityBeforeForceKill === 'gone' ||
        (await this.killProcessAndWait(
          pid,
          'SIGKILL',
          OPEN_CODE_HOST_PROCESS_KILL_TIMEOUT_MS,
          processIdentity.startedAtMs,
        ))
    }

    if (pid > 0 && !terminated && this.isProcessAlive(pid)) {
      throw new Error(
        `OpenCode host pid ${pid} remained alive after ${options.force ? 'forced ' : ''}cleanup`,
      )
    }

    if (entry) {
      entry.child?.stdout?.destroy()
      entry.child?.stderr?.destroy()
      entry.child?.stdin?.destroy()
      entry.handle.state = 'disposed'
    }
    this.hosts.delete(record.hostKey)
    this.pendingHosts.delete(record.hostKey)
    await this.cleanupOpenTuiTempArtifactsIfUnused(
      options.cleanupTempPath
        ?? entry?.handle.profile.tmpPath
        ?? this.getPersistentProfileTmpPath(record.profileRootKey),
      pid,
    )
  }

  private async disposeAdoptedPersistentHost(
    hostKey: string,
    entry: ManagedHostEntry,
  ): Promise<void> {
    const receipt = entry.adoptedRegistryReceipt
    if (!receipt) {
      throw new Error('OpenCode adopted host registry receipt is unavailable [redacted]')
    }
    const receiptBaseUrl = scopedRecordBaseUrl(
      receipt,
      receipt.scopedIdentity ? this.scopedTransportOwnerKey : undefined,
    )
    const receiptPort = scopedRecordPort(
      receipt,
      receipt.scopedIdentity ? this.scopedTransportOwnerKey : undefined,
    )
    if (
      hostKey !== receipt.hostKey
      || entry.handle.hostKey !== receipt.hostKey
      || entry.handle.profileRootKey !== receipt.profileRootKey
      || entry.handle.projectBehaviorFingerprint !== receipt.projectBehaviorFingerprint
      || entry.handle.baseUrl !== receiptBaseUrl
      || entry.handle.port !== receiptPort
      || entry.handle.pid !== receipt.pid
      || entry.handle.processStartedAtMs !== receipt.processStartedAtMs
    ) {
      throw new Error('OpenCode adopted host handle/receipt mismatch [redacted]')
    }
    await this.withPersistentHostStartupLock(hostKey, () =>
      this.withPersistentRegistryLock(async () => {
        if (this.hosts.get(hostKey) !== entry) {
          throw new Error('OpenCode adopted host registry compare-and-swap failed [redacted]')
        }
        const registry = await this.readPersistentRegistryUnlocked()
        if (registry.schemaVersion !== 2) {
          throw new Error('OpenCode adopted host registry compare-and-swap failed [redacted]')
        }
        const current = registry.hosts[hostKey]
        if (!current || canonicalSerializeOpenCodePolicyIdentity(current)
          !== canonicalSerializeOpenCodePolicyIdentity(receipt)) {
          throw new Error('OpenCode adopted host registry compare-and-swap failed [redacted]')
        }
        const processIdentity = await this.inspectPersistentHostProcessIdentity(current)
        if (
          processIdentity.state !== 'confirmed'
          || processIdentity.startedAtMs !== receipt.processStartedAtMs
        ) {
          throw new Error('OpenCode adopted host process compare-and-swap failed [redacted]')
        }

        // The startup lock excludes another creator/adopter while the registry
        // lock keeps the exact receipt stable through termination and removal.
        await this.terminatePersistentHostRecord(receipt, {
          force: true,
          ignoreTrackedHandle: true,
        })
        if (canonicalSerializeOpenCodePolicyIdentity(registry.hosts[hostKey])
          !== canonicalSerializeOpenCodePolicyIdentity(receipt)) {
          throw new Error('OpenCode adopted host registry compare-and-swap failed [redacted]')
        }
        delete registry.hosts[hostKey]
        if (registryHasAnyHosts(registry)) {
          await this.writePersistentRegistryUnlocked(registry)
        } else {
          await this.unlinkPersistentRegistryUnlocked()
        }
      }),
    )
  }

  private async disposeCreatedHost(
    hostKey: string,
    entry: ManagedHostEntry,
  ): Promise<void> {
    const receipt = this.assertCreatedHostDisposalReceipt(hostKey, entry)
    if (
      receipt.childPid !== null
      && !Number.isFinite(receipt.record.processStartedAtMs)
      && receipt.registryReceipt === null
    ) {
      await this.terminateOwnedProcessHostByReceipt(entry, receipt)
      return
    }

    const terminate = async (): Promise<void> => {
      // Recheck immediately before effects so an internal/public-handle
      // redirection cannot win after the first validation.
      this.assertCreatedHostDisposalReceipt(hostKey, entry)
      await this.terminatePersistentHostRecord(receipt.record, {
        force: true,
        ignoreTrackedHandle: true,
        cleanupTempPath: receipt.profileTmpPath,
      })
      entry.child?.stdout?.destroy()
      entry.child?.stderr?.destroy()
      entry.child?.stdin?.destroy()
      entry.handle.state = 'disposed'
    }
    if (!receipt.registryReceipt) {
      await terminate()
      return
    }

    await this.withPersistentHostStartupLock(hostKey, () =>
      this.withPersistentRegistryLock(async () => {
        this.assertCreatedHostDisposalReceipt(hostKey, entry)
        const registry = await this.readPersistentRegistryUnlocked()
        if (registry.schemaVersion !== 2) {
          throw new Error('OpenCode created host registry compare-and-swap failed [redacted]')
        }
        const current = registry.hosts[hostKey]
        if (!current || canonicalSerializeOpenCodePolicyIdentity(current)
          !== canonicalSerializeOpenCodePolicyIdentity(receipt.registryReceipt)) {
          throw new Error('OpenCode created host registry compare-and-swap failed [redacted]')
        }
        const processIdentity = await this.inspectPersistentHostProcessIdentity(receipt.record)
        if (
          processIdentity.state !== 'confirmed'
          || (Number.isFinite(receipt.record.processStartedAtMs)
            ? processIdentity.startedAtMs !== receipt.record.processStartedAtMs
            : processIdentity.startedAtMs !== null)
        ) {
          throw new Error('OpenCode created host process compare-and-swap failed [redacted]')
        }

        await terminate()
        if (canonicalSerializeOpenCodePolicyIdentity(registry.hosts[hostKey])
          !== canonicalSerializeOpenCodePolicyIdentity(receipt.registryReceipt)) {
          throw new Error('OpenCode created host registry compare-and-swap failed [redacted]')
        }
        delete registry.hosts[hostKey]
        if (registryHasAnyHosts(registry)) {
          await this.writePersistentRegistryUnlocked(registry)
        } else {
          await this.unlinkPersistentRegistryUnlocked()
        }
      }),
    )
  }

  async disposeHost(hostKey: string): Promise<boolean> {
    const pending = this.pendingHosts.has(hostKey)
      || this.pendingHostGenerations.has(hostKey)
      || this.scopedStagingGenerations.has(hostKey)
    this.scopedStagingGenerations.delete(hostKey)
    this.pendingHostGenerations.delete(hostKey)
    this.pendingHosts.delete(hostKey)
    const entry = this.hosts.get(hostKey)
    if (!entry) {
      return pending
    }

    if (!entry.ownedByProcess && entry.adoptedRegistryReceipt) {
      await this.disposeAdoptedPersistentHost(hostKey, entry)
      return true
    }

    if (entry.ownedByProcess) {
      await this.disposeCreatedHost(hostKey, entry)
      return true
    }
    throw new Error('OpenCode host disposal ownership receipt is unavailable [redacted]')
  }

  async disposeUnregisteredOwnedHosts(): Promise<{
    disposed: number
    kept: number
    diagnostics: string[]
  }> {
    const registry = await this.readPersistentRegistry()
    let disposed = 0
    let kept = 0
    const diagnostics: string[] = []

    for (const [hostKey, entry] of Array.from(this.hosts.entries())) {
      if (!entry.ownedByProcess) {
        kept += 1
        continue
      }
      if (registry.schemaVersion === 2 && registry.hosts[hostKey]) {
        kept += 1
        continue
      }

      try {
        if (await this.disposeHost(hostKey)) {
          disposed += 1
        }
      } catch (error) {
        diagnostics.push(error instanceof Error ? error.message : String(error))
      }
    }

    return { disposed, kept, diagnostics }
  }

  async reconcilePersistentHosts(
    options: OpenCodePersistentHostReconcileOptions = {},
  ): Promise<OpenCodePersistentHostReconcileResult> {
    const registryPath = this.persistentRegistryPath
    if (!registryPath) {
      return {
        cleaned: 0,
        remaining: 0,
        hosts: [],
        diagnostics: ['OpenCode host registry is disabled'],
      }
    }

    return this.withPersistentRegistryLock(async () => {
      const registry = await this.readPersistentRegistryUnlocked()
      const hosts: OpenCodePersistentHostReconcileResult['hosts'] = []
      const diagnostics: string[] = []
      if (registry.schemaVersion === 1) {
        // V1 is an opaque legacy lifecycle namespace. In particular, do not
        // infer ownership from a PID, endpoint, or command line.
        return { cleaned: 0, remaining: Object.keys(registry.hosts).length, hosts, diagnostics }
      }
      let cleaned = 0
      let changed = false
      const mode = options.mode ?? 'stale'
      const force = mode === 'force'
      const nowMs = this.now().getTime()
      const projectPathFilter = options.projectPath?.trim()
      const normalizedProjectPathFilter = projectPathFilter
        ? await normalizeProjectPathForComparison(projectPathFilter)
        : null

      for (const [hostKey, record] of Object.entries(registry.hosts)) {
        const projectLabel = scopedRecordProjectLabel(record)
        const leases = normalizePersistentHostLeases(record.leases)
        let droppedStaleLeaseCount = 0
        const dropStaleLeases = (
          staleAgeMs: number | null | undefined,
          predicate: (lease: PersistentHostLeaseRecord) => boolean,
        ): number => {
          if (force || typeof staleAgeMs !== 'number' || staleAgeMs <= 0) {
            return 0
          }
          let dropped = 0
          for (const [leaseKey, lease] of Object.entries(leases)) {
            if (!predicate(lease)) {
              continue
            }
            const updatedAtMs = Date.parse(lease.updatedAt)
            const ageMs = Number.isFinite(updatedAtMs)
              ? nowMs - updatedAtMs
              : Number.POSITIVE_INFINITY
            if (ageMs > staleAgeMs) {
              delete leases[leaseKey]
              dropped += 1
            }
          }
          return dropped
        }

        const preflightDropped = dropStaleLeases(
          options.preflightLeaseStaleAgeMs,
          isOpenCodePreflightHostLease,
        )
        const genericDropped = dropStaleLeases(options.leaseStaleAgeMs, () => true)
        droppedStaleLeaseCount = preflightDropped + genericDropped

        if (droppedStaleLeaseCount > 0) {
          registry.hosts[hostKey] = {
            ...record,
            leases,
            updatedAt: this.nowIso(),
          }
          record.leases = leases
          changed = true
          diagnostics.push(
            `Dropped ${droppedStaleLeaseCount} stale OpenCode host lease(s) for ${hostKey}`,
          )
        }
        const leaseCount = Object.keys(leases).length
        const entry = this.hosts.get(hostKey)
        const normalizedRecordProjectPath = normalizedProjectPathFilter
          ? record.projectPath
            ? await normalizeProjectPathForComparison(record.projectPath)
            : record.scopedIdentity?.canonicalProjectPathFingerprint
          : null
        const normalizedFilterIdentity = normalizedProjectPathFilter
          ? record.projectPath
            ? normalizedProjectPathFilter
            : hashText(canonicalSerializeOpenCodePolicyIdentity(normalizedProjectPathFilter))
          : null
        if (
          normalizedProjectPathFilter
          && normalizedRecordProjectPath !== normalizedFilterIdentity
        ) {
          hosts.push({
            hostKey,
            projectPath: projectLabel,
            pid: record.pid,
            port: record.port,
            action: 'kept_filtered',
            reason: 'project identity does not match requested filter',
            leaseCount,
          })
          continue
        }

        if (!this.isProcessAlive(record.pid)) {
          delete registry.hosts[hostKey]
          cleaned += 1
          changed = true
          await this.cleanupOpenTuiTempArtifactsIfUnused(
            this.getPersistentProfileTmpPath(record.profileRootKey),
            record.pid,
          )
          hosts.push({
            hostKey,
            projectPath: projectLabel,
            pid: record.pid,
            port: record.port,
            action: 'removed_dead',
            reason: 'registered host process is not alive',
            leaseCount,
          })
          continue
        }

        const processIdentity = await this.inspectPersistentHostProcessIdentity(record)
        if (processIdentity.state === 'gone' || processIdentity.state === 'changed') {
          delete registry.hosts[hostKey]
          cleaned += 1
          changed = true
          await this.cleanupOpenTuiTempArtifactsIfUnused(
            this.getPersistentProfileTmpPath(record.profileRootKey),
            record.pid,
          )
          hosts.push({
            hostKey,
            projectPath: projectLabel,
            pid: record.pid,
            port: record.port,
            action: 'removed_dead',
            reason: processIdentity.state === 'changed'
              ? 'registered pid was reused by a different process'
              : 'registered host process exited during identity verification',
            leaseCount,
          })
          continue
        }
        if (processIdentity.state === 'unverified') {
          if (record.scopedIdentity) {
            const reason = 'scoped host process identity could not be verified'
            diagnostics.push(`Failed to verify OpenCode host ${hostKey}: ${reason}`)
            hosts.push({
              hostKey, projectPath: projectLabel, pid: record.pid, port: record.port,
              action: 'failed', reason, leaseCount,
            })
            continue
          }
          const health = await this.checkHealthyHostOnce(scopedRecordBaseUrl(
            record,
            record.scopedIdentity ? this.scopedTransportOwnerKey : undefined,
          ))
          if (!health) {
            const reason =
              `OpenCode host pid ${record.pid} is unhealthy and its legacy identity ` +
              'could not be verified'
            diagnostics.push(`Failed to verify OpenCode host ${hostKey}: ${reason}`)
            hosts.push({
              hostKey,
              projectPath: projectLabel,
              pid: record.pid,
              port: record.port,
              action: 'failed',
              reason,
              leaseCount,
            })
            continue
          }
          try {
            const processStartedAtMs = await this.verifyLegacyPersistentHostIdentity(
              record,
              processIdentity.startedAtMs,
            )
            record.processStartedAtMs = processStartedAtMs
            registry.hosts[hostKey] = record
            changed = true
            diagnostics.push(`Upgraded legacy OpenCode host process identity for ${hostKey}`)
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error)
            diagnostics.push(`Failed to verify OpenCode host ${hostKey}: ${reason}`)
            hosts.push({
              hostKey,
              projectPath: projectLabel,
              pid: record.pid,
              port: record.port,
              action: 'failed',
              reason,
              leaseCount,
            })
            continue
          }
        }

        const coordinationProtectedUntilMs = record.coordinationProtectedUntil
          ? Date.parse(record.coordinationProtectedUntil)
          : Number.NaN
        if (!force && Number.isFinite(coordinationProtectedUntilMs)
          && coordinationProtectedUntilMs > nowMs) {
          hosts.push({
            hostKey,
            projectPath: projectLabel,
            pid: record.pid,
            port: record.port,
            action: 'kept_active',
            reason: 'host is protected by an in-flight startup/adoption handoff',
            leaseCount,
          })
          continue
        }

        if (!force && entry && entry.refCount > 0) {
          hosts.push({
            hostKey,
            projectPath: projectLabel,
            pid: record.pid,
            port: record.port,
            action: 'kept_active',
            reason: `host has active in-process refCount=${entry.refCount}`,
            leaseCount,
          })
          continue
        }

        if (!force && leaseCount > 0) {
          hosts.push({
            hostKey,
            projectPath: projectLabel,
            pid: record.pid,
            port: record.port,
            action: 'kept_leased',
            reason: `host has ${leaseCount} active lease${leaseCount === 1 ? '' : 's'}`,
            leaseCount,
          })
          continue
        }

        if (
          !force &&
          droppedStaleLeaseCount === 0 &&
          typeof options.staleAgeMs === 'number' &&
          options.staleAgeMs > 0
        ) {
          const updatedAtMs = Date.parse(record.updatedAt)
          const ageMs = Number.isFinite(updatedAtMs)
            ? nowMs - updatedAtMs
            : Number.POSITIVE_INFINITY
          if (ageMs < options.staleAgeMs) {
            hosts.push({
              hostKey,
              projectPath: projectLabel,
              pid: record.pid,
              port: record.port,
              action: 'kept_recent',
              reason: `host updated ${Math.max(0, ageMs)}ms ago`,
              leaseCount,
            })
            continue
          }
        }

        try {
          await this.terminatePersistentHostRecord(record, { force })
          delete registry.hosts[hostKey]
          cleaned += 1
          changed = true
          hosts.push({
            hostKey,
            projectPath: projectLabel,
            pid: record.pid,
            port: record.port,
            action: 'disposed',
            reason: force
              ? `force cleanup during ${options.reason ?? 'manual'}`
              : `stale host has no active leases during ${options.reason ?? 'manual'}`,
            leaseCount,
          })
        } catch (error) {
          const message = record.scopedIdentity
            ? 'scoped host cleanup failed [redacted]'
            : error instanceof Error ? error.message : String(error)
          diagnostics.push(`Failed to dispose OpenCode host ${hostKey}: ${message}`)
          hosts.push({
            hostKey,
            projectPath: projectLabel,
            pid: record.pid,
            port: record.port,
            action: 'failed',
            reason: message,
            leaseCount,
          })
        }
      }

      if (changed) {
        if (!registryHasAnyHosts(registry)) {
          await this.unlinkPersistentRegistryUnlocked().catch(() => undefined)
        } else {
          await this.writePersistentRegistryUnlocked(registry)
        }
      }

      if (options.reason === 'startup') {
        const activeProfileRootKeys = new Set(
          Object.values(registry.hosts)
            .filter(record => this.isProcessAlive(record.pid))
            .map(record => record.profileRootKey),
        )
        const tempCleanup = await this.cleanupStaleManagedProfileTempDylibs(
          activeProfileRootKeys,
        ).catch(() => {
          diagnostics.push('Failed to clean stale OpenCode profile temp dylibs [redacted]')
          return { removed: 0, bytes: 0 }
        })
        if (tempCleanup.removed > 0) {
          diagnostics.push(
            `Removed ${tempCleanup.removed} stale OpenCode profile temp dylib(s) (${tempCleanup.bytes} bytes)`,
          )
        }
      }

      return {
        cleaned,
        remaining: Object.keys(registry.hosts).length,
        hosts,
        diagnostics,
      }
    })
  }

  async releaseHost(
    hostKey: string,
    options: { keepPersistentAlive?: boolean } = {},
  ): Promise<void> {
    const entry = this.hosts.get(hostKey)
    if (!entry) {
      return
    }

    entry.refCount = Math.max(0, entry.refCount - 1)
    if (entry.refCount === 0) {
      if (entry.lifetime === 'persistent' && options.keepPersistentAlive) {
        return
      }
      if (entry.ownedByProcess) {
        await this.disposeHost(hostKey)
      } else {
        this.hosts.delete(hostKey)
      }
    }
  }
}

export const openCodeHostManager = new OpenCodeHostManager()
