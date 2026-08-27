import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID,
  timingSafeEqual } from 'node:crypto'
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
  isProcessTreeContainmentAlive,
  readProcessBirthToken,
  readProcessCommandLine,
  readProcessStartTimeMs,
} from '../../utils/processKill.js'
import { spawnPortableCli } from '../../utils/portableCli.js'
import { resolveOpenCodeBinaryPath } from './OpenCodeBinaryResolver.js'
import { resolveOpenCodeCatalogSourceArtifacts } from './OpenCodeCatalogAuthorityClient.js'
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

/** Startup created native containment whose complete rollback was not proved. */
export class OpenCodeHostStartupCleanupError extends Error {
  readonly cleanupDisposition: 'complete' | 'incomplete'
  readonly cleanupIncomplete: boolean
  readonly startupCleanupReceipt?: Readonly<{
    hostKey: string
    receipt: OpenCodeHostReleaseReceipt
  }>

  constructor(cleanupDisposition: 'complete' | 'incomplete', cause?: unknown,
    startupCleanupReceipt?: Readonly<{
    hostKey: string
    receipt: OpenCodeHostReleaseReceipt
  }>, message = cleanupDisposition === 'complete'
      ? 'OpenCode host startup failed after complete cleanup'
      : 'OpenCode host startup cleanup is incomplete') {
    super(message, { cause })
    this.name = 'OpenCodeHostStartupCleanupError'
    this.cleanupDisposition = cleanupDisposition
    this.cleanupIncomplete = cleanupDisposition === 'incomplete'
    this.startupCleanupReceipt = startupCleanupReceipt
  }
}
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

class OpenCodeHostDurablyLeasedError extends Error {}

declare const openCodeHostReferenceBrand: unique symbol
/** Manager-minted, attempt-bound authority for exactly one acquired host reference. */
export type OpenCodeHostReferenceCapability = Readonly<{
  handle: OpenCodeHostHandle
  [openCodeHostReferenceBrand]: never
}>

export type OpenCodeHostReleaseReceipt = Readonly<{
  schemaVersion: 1 | 2
  receiptId: string
  hostKeyDigest: string
  pid: number
  processStartedAtMs: number
  processBirthToken?: string
  lifetime: OpenCodeHostLifetime
}>

const hostReferenceCapabilities = new WeakMap<object, {
  manager: OpenCodeHostManager
  entry: ManagedHostEntry
  receipt: OpenCodeHostReleaseReceipt
  state: 'available' | 'releasing' | 'released'
  release?: Promise<void>
}>()
const durableHostReferenceCapabilities = new Map<string, {
  manager: OpenCodeHostManager
  entry: ManagedHostEntry
  capability: OpenCodeHostReferenceCapability
  receipt: OpenCodeHostReleaseReceipt
}>()

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
  isProcessGroupAlive?: (leaderPid: number) => boolean | null
  readProcessCommandLine?: (pid: number) => Promise<string | null>
  readProcessStartTimeMs?: (pid: number) => Promise<number | null>
  readProcessBirthToken?: (pid: number) => string | null
  killProcess?: (pid: number, signal: NodeJS.Signals) => void
  now?: () => Date
  persistentRegistryPath?: string | null
  stageScopedHostBinary?: (
    profile: OpenCodeScopedPreparedProfile,
    assertCurrent?: () => void,
  ) => Promise<VerifiedScopedBinary>
  beforePersistentRegistryWrite?: () => Promise<void>
  afterPersistentRegistryWrite?: () => Promise<void>
  beforePersistentRegistryUnlink?: () => Promise<void>
  scopedTransportOwnerKey?: Buffer
  platform?: NodeJS.Platform
  windowsOwnerKeyProtection?: OpenCodeWindowsOwnerKeyProtection
}

type OpenCodeHostCleanupControls = {
  signal?: AbortSignal
  remainingMs?: () => number
  requireStableContainment?: boolean
  /** Compatibility release keeps its exact retry receipt reachable by key. */
  retainExactEntryDuringDisposal?: boolean
  /** Attempt-ledger binding for the exact immutable reservation and receipt tuple. */
  obligationIdentity?: Readonly<{
    reservationDigest: string
    hostKeyIdentity: string
    hostKeyDigest: string
    receiptIdentityDigest: string
  }>
}

export type OpenCodeWindowsOwnerKeyProtection = {
  get: (identity: { service: string; name: string }) => Promise<string | null>
  set: (identity: { service: string; name: string; value: string }) => Promise<void>
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
  processBirthToken?: string | null
  version: string | null
  resolvedConfigFingerprint: string | null
  updatedAt: string
  coordinationProtectedUntil?: string
  leases?: Record<string, PersistentHostLeaseRecord>
  scopedIdentity?: OpenCodeScopedHostIdentity
  /** Owner-authenticated binding of the immutable scoped lifecycle and containment identity. */
  scopedIdentityBinding?: string
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

function scopedHostIdentityBinding(
  record: Omit<PersistentHostRegistryRecord, 'scopedIdentityBinding'>,
  ownerKey: Buffer,
): string {
  return createHmac('sha256', ownerKey).update(canonicalSerializeOpenCodePolicyIdentity({
    schema: 'opencode-scoped-registry-lifecycle-binding-v2',
    hostKey: record.hostKey,
    profileRootKey: record.profileRootKey,
    projectBehaviorFingerprint: record.projectBehaviorFingerprint,
    managedConfigFingerprint: record.managedConfigFingerprint ?? null,
    port: record.port,
    pid: record.pid,
    processStartedAtMs: record.processStartedAtMs ?? null,
    processBirthToken: record.processBirthToken ?? null,
    version: record.version,
    resolvedConfigFingerprint: record.resolvedConfigFingerprint,
    coordinationProtectedUntil: record.coordinationProtectedUntil,
    scopedIdentity: record.scopedIdentity,
    scopedTransportToken: record.scopedTransportToken,
  })).digest('hex')
}

function hasExactScopedHostIdentityBinding(record: PersistentHostRegistryRecord, ownerKey: Buffer): boolean {
  if (record.scopedIdentity === undefined || typeof record.scopedIdentityBinding !== 'string'
    || !/^[a-f0-9]{64}$/.test(record.scopedIdentityBinding)) return false
  const { scopedIdentityBinding: _binding, ...unbound } = record
  const expected = Buffer.from(scopedHostIdentityBinding(unbound, ownerKey), 'hex')
  const observed = Buffer.from(record.scopedIdentityBinding, 'hex')
  return observed.length === expected.length && timingSafeEqual(observed, expected)
}

export function computeOpenCodeHostReleaseObligationIdentityDigest(input: Readonly<{
  reservationDigest: string
  hostKeyIdentity: string
  receipt: OpenCodeHostReleaseReceipt
}>): string {
  return createHash('sha256').update(JSON.stringify({
    schema: 'opencode-host-cleanup-receipt-identity-v1',
    reservationDigest: input.reservationDigest,
    hostKeyIdentity: input.hostKeyIdentity,
    receipt: input.receipt,
  })).digest('hex')
}

type PersistentHostProcessIdentity = {
  state: 'confirmed' | 'gone' | 'changed' | 'unverified'
  startedAtMs: number | null
  birthToken: string | null
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

function canonicalWindowsPath(value: string): string {
  return path.resolve(value).replace(/^\\\\\?\\/, '').replace(/[\\/]+$/, '').toLowerCase()
}

export type VerifiedScopedBinary = {
  profile: OpenCodeScopedPreparedProfile
  fileHandle: FileHandle
  /** Stable object identity captured from the same descriptor as verified bytes. */
  objectIdentity: Readonly<{ dev: string; ino: string; size: string }> | null
  /** Close the manager-owned descriptor at most once, including after transfer failures. */
  close: () => Promise<void>
}

export function bindVerifiedScopedBinaryHandle(
  profile: OpenCodeScopedPreparedProfile,
  fileHandle: FileHandle,
  objectIdentity: VerifiedScopedBinary['objectIdentity'] = null,
): VerifiedScopedBinary {
  let ownedHandle: FileHandle | null = fileHandle
  return {
    profile,
    fileHandle,
    objectIdentity,
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

async function loadScopedTransportOwnerKey(
  registryPath: string,
  heldParentPath?: string,
  platform: NodeJS.Platform = process.platform,
  windowsProtection?: OpenCodeWindowsOwnerKeyProtection,
): Promise<Buffer> {
  const cached = scopedTransportOwnerKeys.get(registryPath)
  if (cached && !windowsProtection) return cached
  if (platform === 'win32') {
    // Bun.secrets maps to Windows Credential Manager: the 32-byte capability
    // is protected to the current Windows account and never appears in the
    // filesystem. The app-root record is only an atomic identity binding, so
    // a copied, rotated or corrupt credential/record pair fails closed.
    const protection = windowsProtection ?? {
      get: identity => Bun.secrets.get(identity),
      set: identity => Bun.secrets.set(identity),
    }
    const registryIdentity = hashText(path.resolve(registryPath))
    const credentialIdentity = {
      service: 'claude-multimodel-opencode-host-owner-v1',
      name: registryIdentity,
    }
    const registryParent = heldParentPath ?? path.dirname(registryPath)
    const parentBefore = await lstat(registryParent, { bigint: true })
    const parentCanonical = await realpath(registryParent)
    if (!parentBefore.isDirectory() || parentBefore.isSymbolicLink()
      || canonicalWindowsPath(parentCanonical) !== canonicalWindowsPath(registryParent)
      || (parentBefore.dev === 0n && parentBefore.ino === 0n)) {
      throw new Error('OpenCode scoped capability parent is not canonical [redacted]')
    }
    const storePath = path.join(registryParent, 'host-capabilities')
    await ensureOpenCodeManagedDirectoryPath(storePath, registryParent, undefined, 'win32')
    const parentAfter = await lstat(registryParent, { bigint: true })
    if (parentAfter.dev !== parentBefore.dev || parentAfter.ino !== parentBefore.ino) {
      throw new Error('OpenCode scoped capability parent changed during creation [redacted]')
    }
    const store = await OpenCodeSafePublicationDirectory.open(storePath)
    try {
      const recordName = `${registryIdentity}.owner-key.json`
      const recordPath = store.child(recordName)
      const existing = await lstat(recordPath).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      })
      if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
        throw new Error('OpenCode scoped capability owner record is foreign or corrupt [redacted]')
      }
      let secret = await protection.get(credentialIdentity)
      if (!existing) {
        if (!secret) {
          secret = randomBytes(32).toString('base64')
          await protection.set({ ...credentialIdentity, value: secret })
        }
        const key = Buffer.from(secret, 'base64')
        if (key.length !== 32 || key.toString('base64') !== secret) {
          throw new Error('OpenCode scoped capability owner protection is invalid [redacted]')
        }
        const record = JSON.stringify({
          schema: 'opencode-windows-owner-key-v1',
          registryIdentity,
          ownerKeyFingerprint: hashText(secret),
        })
        await store.publishImmutableFile(recordName, record, 0o600)
      }
      const held = await open(recordPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
      try {
        const metadata = await held.stat({ bigint: true })
        const parsed = JSON.parse((await held.readFile()).toString('utf8')) as Record<string, unknown>
        if (!metadata.isFile() || metadata.isSymbolicLink()
          || parsed.schema !== 'opencode-windows-owner-key-v1'
          || parsed.registryIdentity !== registryIdentity
          || typeof parsed.ownerKeyFingerprint !== 'string'
          || !secret || hashText(secret) !== parsed.ownerKeyFingerprint) {
          throw new Error('OpenCode scoped capability owner record is foreign or corrupt [redacted]')
        }
        const key = Buffer.from(secret, 'base64')
        if (key.length !== 32 || key.toString('base64') !== secret) {
          throw new Error('OpenCode scoped capability owner key is invalid [redacted]')
        }
        if (!windowsProtection) scopedTransportOwnerKeys.set(registryPath, key)
        return key
      } finally { await held.close() }
    } finally { await store.close() }
  }
  if (platform !== 'linux' && platform !== 'darwin') {
    throw new Error('OpenCode scoped capability store is unsupported [redacted]')
  }
  const fdRoot = platform === 'linux' ? '/proc/self/fd' : '/dev/fd'
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
  let objectIdentity: VerifiedScopedBinary['objectIdentity'] = null
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
    const identity = await fileHandle.stat({ bigint: true })
    if (!identity.isFile() || identity.dev === 0n || identity.ino === 0n
      || identity.size !== BigInt(publishedBytes.length)) {
      throw new Error('OpenCode staged binary object identity is unavailable')
    }
    objectIdentity = Object.freeze({
      dev: identity.dev.toString(),
      ino: identity.ino.toString(),
      size: identity.size.toString(),
    })
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
      objectIdentity,
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
    || (record.processBirthToken !== undefined && record.processBirthToken !== null
      && !isNonblankString(record.processBirthToken))
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
      'pid', 'port', 'processBirthToken', 'processStartedAtMs', 'profileRootKey', 'projectBehaviorFingerprint',
      'resolvedConfigFingerprint', 'scopedIdentity', 'scopedIdentityBinding', 'scopedTransportToken',
      'updatedAt', 'version',
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
      || (record.scopedIdentityBinding !== undefined
        && !/^[a-f0-9]{64}$/.test(record.scopedIdentityBinding))
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
      'pid', 'port', 'processBirthToken', 'processStartedAtMs', 'profileRootKey', 'projectBehaviorFingerprint',
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
  const projectSnapshotPath = path.join(
    profile.profileRootPath,
    profile.expectedEntryManifest.projectBehaviorSnapshotPath,
  )
  const catalogAttemptPlan = profile.catalogAttemptPlan
  const catalogPurpose = profile.purpose === 'provider-catalog'
  const expectedConfigDirectory = catalogPurpose
    ? path.join(profile.profileRootPath, 'catalog-project-config')
    : projectSnapshotPath
  const basePlanDigest = catalogPurpose && catalogAttemptPlan
    ? catalogAttemptPlan.basePlanDigest
    : profile.scopedPlanDigest
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
    || profile.env.OPENCODE_CONFIG_DIR !== expectedConfigDirectory
    || profile.executionProjectPath !== projectSnapshotPath
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
      basePlanDigest
        ? { profileLayoutGeneration: profile.profileLayoutGeneration, planDigest: basePlanDigest }
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
  if (catalogPurpose) {
    if (
      !catalogAttemptPlan
      || catalogAttemptPlan.schema !== 'opencode-catalog-attempt-plan-v1'
      || !/^[a-f0-9]{64}$/.test(catalogAttemptPlan.basePlanDigest)
      || catalogAttemptPlan.runtimeInstanceId !== profile.runtimeInstanceId
      || catalogAttemptPlan.profileRootKey !== profile.profileRootKey
      || catalogAttemptPlan.profileRootPath !== profile.profileRootPath
      || catalogAttemptPlan.configDirectory !== expectedConfigDirectory
      || profile.profileRootKey !== `${profile.profileScopeIdentity}-catalog-${hashText(
        canonicalSerializeOpenCodePolicyIdentity(profile.runtimeInstanceId),
      )}`
      || hashText(canonicalSerializeOpenCodePolicyIdentity(catalogAttemptPlan))
        !== profile.scopedPlanDigest
    ) fail()
    const configMetadata = await lstat(expectedConfigDirectory).catch(() => null)
    const canonicalConfigDirectory = await realpath(expectedConfigDirectory).catch(() => null)
    if (!configMetadata?.isDirectory() || configMetadata.isSymbolicLink()
      || canonicalConfigDirectory !== path.resolve(expectedConfigDirectory)) fail()
  } else if (catalogAttemptPlan !== null || profile.profileRootKey !== profile.profileScopeIdentity) {
    fail()
  }
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

export function resolveOpenCodeVerifiedHostLauncherPath(): string {
  const sourceRuntime = import.meta.url.endsWith('.ts')
  if (sourceRuntime) {
    return resolveOpenCodeCatalogSourceArtifacts(path.resolve(import.meta.dir, '../../..'))
      .launcherPath
  }
  const bunHostedBundle = /(?:^|[\\/])bun(?:\.exe)?$/i.test(process.execPath)
  const packaged = bunHostedBundle ? import.meta.dir : path.dirname(process.execPath)
  return path.join(packaged, 'opencode-catalog-launcher.exe')
}

export function buildOpenCodeVerifiedScopedHostCommand(
  profile: OpenCodeScopedPreparedProfile,
  verifiedScopedBinary: VerifiedScopedBinary,
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
  windowsLauncherPath: string = resolveOpenCodeVerifiedHostLauncherPath(),
): Readonly<{ binaryPath: string; args: string[]; inheritedVerifiedFd: boolean }> {
  if (verifiedScopedBinary.profile.binaryPath !== profile.binaryPath) {
    throw new Error('OpenCode scoped host requires verified staged bytes')
  }
  const serveArgs = ['serve', '--hostname', '127.0.0.1', '--port']
  if (platform === 'linux' || platform === 'darwin') {
    return Object.freeze({
      binaryPath: platform === 'linux' ? '/proc/self/fd/3' : '/dev/fd/3',
      args: serveArgs,
      inheritedVerifiedFd: true,
    })
  }
  if (platform === 'win32' && (architecture === 'x64' || architecture === 'arm64')) {
    // The native launcher retains delete/write-denying handles for the staged
    // executable and every ancestor, compares object identity after suspended
    // CreateProcess, and owns the descendant in a kill-on-close job.
    const identity = verifiedScopedBinary.objectIdentity
    if (!identity) {
      throw new Error('OpenCode scoped Windows executable identity is unavailable')
    }
    return Object.freeze({
      binaryPath: windowsLauncherPath,
      args: [profile.binaryPath, '--verified-opencode-host-v1',
        identity.dev, identity.ino, identity.size, ...serveArgs],
      inheritedVerifiedFd: false,
    })
  }
  throw new Error('OpenCode scoped verified-handle execution is unsupported on this platform')
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
  /** Exact host generations already committed to disposal. */
  private readonly disposingHosts = new Map<ManagedHostEntry, Promise<void>>()
  /** Latest disposal for a key; newer generations queue behind older ones. */
  private readonly disposalTails = new Map<string, Readonly<{
    entry: ManagedHostEntry
    promise: Promise<void>
  }>>()
  private readonly pendingHosts = new Map<string, Promise<OpenCodeHostHandle>>()
  private readonly pendingRefCounts = new Map<string, number>()
  private readonly pendingHostHealthTimeoutMs = new Map<string, number>()
  private readonly pendingHostGenerations = new Map<string, symbol>()
  private readonly scopedStagingGenerations = new Map<string, symbol>()
  private activeRegistryDirectory: OpenCodeSafePublicationDirectory | null = null
  private durableScopedTransportOwnerKey: Buffer | null = null
  private readonly pendingExitCleanups = new Map<string, Readonly<{
    receipt: PersistentHostRegistryRecord
    entry: ManagedHostEntry
    lastError: string
  }>>()
  private readonly exitCleanupTasks = new Map<string, Promise<boolean>>()

  constructor(private readonly deps: OpenCodeHostManagerDeps = {}) {}

  private get scopedTransportOwnerKey(): Buffer {
    if (this.deps.scopedTransportOwnerKey) {
      if (this.deps.scopedTransportOwnerKey.length !== 32) {
        throw new Error('OpenCode scoped capability owner key is invalid [redacted]')
      }
      return this.deps.scopedTransportOwnerKey
    }
    if (!this.durableScopedTransportOwnerKey) {
      throw new Error('OpenCode scoped durable owner key was not loaded [redacted]')
    }
    return this.durableScopedTransportOwnerKey
  }

  private async ensureScopedTransportOwnerKeyLoaded(): Promise<void> {
    if (this.deps.scopedTransportOwnerKey || this.durableScopedTransportOwnerKey) return
    const registryPath = this.persistentRegistryPath
    if (!registryPath) throw new Error('OpenCode scoped durable transport is disabled [redacted]')
    this.durableScopedTransportOwnerKey = await loadScopedTransportOwnerKey(
      registryPath,
      (this.deps.platform ?? process.platform) === 'win32'
        ? path.dirname(registryPath)
        : this.activeRegistryDirectory?.descriptorPath(),
      this.deps.platform ?? process.platform,
      this.deps.windowsOwnerKeyProtection,
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

  private readProcessBirthToken(pid: number): string | null {
    if (this.deps.readProcessBirthToken) return this.deps.readProcessBirthToken(pid)
    // Synthetic process-control dependencies are test authority only. They do
    // not cause production to manufacture a weak token from wall-clock time.
    if (this.deps.spawnHostProcess) return null
    return readProcessBirthToken(pid, this.deps.platform ?? process.platform)
  }

  private requiresNativeBirthToken(): boolean {
    return (this.deps.platform ?? process.platform) === 'linux'
      && (this.deps.readProcessBirthToken !== undefined
        || (this.deps.spawnHostProcess === undefined
          && this.deps.readProcessStartTimeMs === undefined))
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
      return { state: 'gone', startedAtMs: null, birthToken: null }
    }

    const startedAtMs = await this.readProcessStartTimeMs(record.pid).catch(() => null)
    if (!Number.isFinite(startedAtMs) || startedAtMs === null) {
      if (!this.isProcessAlive(record.pid)) {
        return { state: 'gone', startedAtMs: null, birthToken: null }
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
        birthToken: null,
      }
    }

    const birthToken = this.readProcessBirthToken(record.pid)
    if (this.requiresNativeBirthToken()) {
      if (!birthToken || !record.processBirthToken) {
        return { state: 'unverified', startedAtMs, birthToken }
      }
      if (birthToken !== record.processBirthToken) {
        return { state: 'changed', startedAtMs, birthToken }
      }
    }

    if (
      Number.isFinite(record.processStartedAtMs) &&
      record.processStartedAtMs !== null &&
      record.processStartedAtMs !== undefined
    ) {
      return {
        state: record.processStartedAtMs === startedAtMs ? 'confirmed' : 'changed',
        startedAtMs, birthToken,
      }
    }

    // A legacy PID-only record has no immutable baseline. updatedAt is not a
    // safe substitute because lease refreshes can move it past a PID reuse.
    return { state: 'unverified', startedAtMs, birthToken }
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
    requireStableContainment = false,
    expectedBirthToken?: string | null,
  ): Promise<boolean> {
    const platform = this.deps.platform ?? process.platform
    if (requireStableContainment && platform !== 'linux' && platform !== 'win32') {
      // No exact native process-generation authority exists here. In
      // particular, never let an injected/legacy observer turn Darwin's
      // second-resolution wall clock identity into PGID mutation authority.
      return false
    }
    if (this.deps.killProcess) {
      if (requireStableContainment && !this.isProcessAlive(pid)) return false
      this.deps.killProcess(pid, signal)
      await this.sleepMs(Math.min(timeoutMs, 250)).catch(() => undefined)
      if (this.isProcessAlive(pid)) return false
      return !requireStableContainment
        || (this.deps.isProcessGroupAlive !== undefined && this.deps.isProcessGroupAlive(pid) === false)
    }
    const exited = await killProcessTreeAndWait(pid, signal, {
      timeoutMs,
      // Process birth is re-read immediately before every group mutation.
      // Never carry a prior validation across TERM observation into SIGKILL.
      expectedStartedAtMs,
      expectedBirthToken,
      birthTokenReader: candidate => this.readProcessBirthToken(candidate),
      posixProcessGroupLeader: requireStableContainment,
      windowsTaskkillTreeAuthority: requireStableContainment,
      platform: this.deps.platform,
    })
    return exited
  }

  private hasStableProcessContainmentExited(pid: number): boolean {
    if ((this.deps.platform ?? process.platform) !== 'linux') return false
    if (this.deps.isProcessGroupAlive) return this.deps.isProcessGroupAlive(pid) === false
    // A fake mutation hook without a matching strong observer is deliberately
    // unproven. Production POSIX cleanup observes the detached process group.
    if (this.deps.killProcess) return false
    return isProcessTreeContainmentAlive(pid) === false
  }

  private persistentContainmentExited(pid: number): boolean {
    if ((this.deps.platform ?? process.platform) !== 'linux') return false
    if (this.deps.isProcessGroupAlive) return this.deps.isProcessGroupAlive(pid) === false
    return isProcessTreeContainmentAlive(pid) === false
  }

  private async captureEntryContainmentAuthority(entry: ManagedHostEntry): Promise<boolean> {
    const pid = entry.handle.pid
    if (!this.isProcessAlive(pid)) return false
    const expected = entry.handle.processStartedAtMs
    if (Number.isFinite(expected) && expected !== null) {
      const observed = await this.readProcessStartTimeMs(pid).catch(() => null)
      if (observed !== expected) {
        throw new Error('OpenCode host process identity changed before containment release [redacted]')
      }
    }
    return true
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

  private assertCleanupAllowed(controls: OpenCodeHostCleanupControls): void {
    if (controls.signal?.aborted) throwOpenCodeAbortReason(controls.signal)
    if (controls.remainingMs && controls.remainingMs() <= 0) {
      throw new Error('OpenCode host cleanup absolute deadline expired')
    }
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
    await this.deps.beforePersistentRegistryUnlink?.()
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
      processBirthToken: handle.processBirthToken,
      version: handle.version,
      resolvedConfigFingerprint: handle.resolvedConfigFingerprint,
      updatedAt,
      coordinationProtectedUntil: new Date(
        Date.parse(updatedAt) + OPEN_CODE_HOST_ADOPTION_PROTECTION_MS,
      ).toISOString(),
      leases: normalizePersistentHostLeases(previous?.leases),
    }
    if (isScopedPreparedProfile(handle.profile)) {
      const unbound = {
          ...common,
          port: 0,
          version: null,
          scopedTransportToken: encodeScopedTransportToken(
            handle.hostKey, handle.port, this.scopedTransportOwnerKey,
          ),
          scopedIdentity: buildOpenCodeScopedHostIdentity(handle.profile),
        }
      return { ...unbound,
        scopedIdentityBinding: scopedHostIdentityBinding(unbound, this.scopedTransportOwnerKey) }
    }
    return { ...common, projectPath: handle.projectPath, baseUrl: handle.baseUrl }
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
        processBirthToken: handle.processBirthToken,
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
      const previousDirectory = this.activeRegistryDirectory
      this.activeRegistryDirectory = directory
      try {
        release = await lockfile.lock(directory.child(lockName), PERSISTENT_REGISTRY_LOCK_OPTIONS)
        await this.ensureScopedTransportOwnerKeyLoaded()
        return await callback()
      } finally {
        if (release) await release()
        this.activeRegistryDirectory = previousDirectory
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
      let previous: PersistentHostRegistryRecord | undefined = registry.hosts[handle.hostKey]
      const expectedScopedIdentity = isScopedPreparedProfile(handle.profile)
        ? buildOpenCodeScopedHostIdentity(handle.profile) : null
      if (previous?.scopedIdentity
        && !hasExactScopedHostIdentityBinding(previous, this.scopedTransportOwnerKey)) {
        throw new Error('OpenCode scoped host tombstone lifecycle binding is invalid [redacted]')
      }
      if (previous && expectedScopedIdentity && (
        canonicalSerializeOpenCodePolicyIdentity(previous.scopedIdentity)
          !== canonicalSerializeOpenCodePolicyIdentity(expectedScopedIdentity)
      )) {
        // A structurally valid record in this key slot is still foreign unless
        // its complete identity is cryptographically bound to the key. Never
        // overwrite the only durable containment tombstone. Linux may discard
        // it solely after a complete stable containment scan proves emptiness;
        // all other platforms and observer uncertainty fail closed.
        if (!this.persistentContainmentExited(previous.pid)) {
          throw new Error('OpenCode foreign scoped host tombstone containment is unresolved [redacted]')
        }
        delete registry.hosts[handle.hostKey]
        previous = undefined
      }
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
          || !hasExactScopedHostIdentityBinding(current, this.scopedTransportOwnerKey)
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
      if (current?.scopedIdentity
        && !hasExactScopedHostIdentityBinding(current, this.scopedTransportOwnerKey)) {
        throw new Error('OpenCode scoped host tombstone lifecycle binding is invalid [redacted]')
      }
      if (expected.scopedIdentity
        && !hasExactScopedHostIdentityBinding(expected, this.scopedTransportOwnerKey)) {
        throw new Error('OpenCode scoped host receipt lifecycle binding is invalid [redacted]')
      }
      if (!current || canonicalSerializeOpenCodePolicyIdentity(
        persistentHostLifecycleIdentity(current, this.scopedTransportOwnerKey),
      ) !== canonicalSerializeOpenCodePolicyIdentity(
        persistentHostLifecycleIdentity(expected, this.scopedTransportOwnerKey),
      )) return
      // The leader's exit is not proof that its detached descendants exited.
      // Preserve the exact durable receipt until the owned containment unit is
      // strongly observed absent (Windows returns unproven conservatively).
      if (!this.persistentContainmentExited(expected.pid)) {
        throw new Error(
          `OpenCode host pid ${expected.pid} containment cleanup remains incomplete`,
        )
      }
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
        && !hasExactScopedHostIdentityBinding(record, this.scopedTransportOwnerKey)) {
        throw new Error('OpenCode scoped host tombstone lifecycle binding is invalid [redacted]')
      }
      const removeStaleRecord = async (): Promise<void> => {
        if (registry.hosts[hostKey] !== record) return
        delete registry.hosts[hostKey]
        if (registryHasAnyHosts(registry)) {
          await this.writePersistentRegistryUnlocked(registry)
        } else {
          await this.unlinkPersistentRegistryUnlocked().catch(() => undefined)
        }
      }
      const rejectForeignUnlessContainmentEmpty = async (): Promise<null> => {
        if (!this.persistentContainmentExited(record.pid)) {
          throw new Error('OpenCode foreign scoped host tombstone containment is unresolved [redacted]')
        }
        await removeStaleRecord()
        return null
      }
      if (record.scopedIdentity
        && record.resolvedConfigFingerprint !== record.scopedIdentity.managedConfigFingerprint) {
        return rejectForeignUnlessContainmentEmpty()
      }
      if (isScopedPreparedProfile(profile)
        && !hasExactScopedHostIdentityBinding(record, this.scopedTransportOwnerKey)) {
        throw new Error('OpenCode scoped host tombstone lifecycle binding is invalid [redacted]')
      }
      if (isScopedPreparedProfile(profile) && (
        canonicalSerializeOpenCodePolicyIdentity(record.scopedIdentity)
          !== canonicalSerializeOpenCodePolicyIdentity(buildOpenCodeScopedHostIdentity(profile))
      )) return rejectForeignUnlessContainmentEmpty()
      if (
        record.profileRootKey !== profile.profileRootKey ||
        record.projectBehaviorFingerprint !== profile.projectBehaviorFingerprint ||
        record.managedConfigFingerprint !== profile.managedConfigFingerprint
      ) {
        return rejectForeignUnlessContainmentEmpty()
      }
      if (!this.isProcessAlive(record.pid)) {
        if (!this.persistentContainmentExited(record.pid)) {
          throw new Error(
            `OpenCode host pid ${record.pid} leader exited but containment cleanup is incomplete`,
          )
        }
        await removeStaleRecord()
        return null
      }
      const processIdentity = await this.inspectPersistentHostProcessIdentity(record)
      if (processIdentity.state === 'gone' || processIdentity.state === 'changed') {
        if (!this.persistentContainmentExited(record.pid)) {
          throw new Error(
            `OpenCode host pid ${record.pid} leader exited during adoption but containment cleanup is incomplete`,
          )
        }
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
        await this.terminatePersistentHostRecord({ ...record, baseUrl }, {
          force: true, requireStableContainment: true,
        })
        await removeStaleRecord()
        return null
      }
      const identityAfterHealth = await this.inspectPersistentHostProcessIdentity({
        ...record,
        processStartedAtMs: processIdentity.startedAtMs ?? record.processStartedAtMs,
      })
      if (identityAfterHealth.state === 'gone' || identityAfterHealth.state === 'changed') {
        if (!this.persistentContainmentExited(record.pid)) {
          throw new Error(
            `OpenCode host pid ${record.pid} leader identity changed during adoption but ` +
            'containment cleanup is incomplete',
          )
        }
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
        processBirthToken: record.processBirthToken,
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

    const platform = this.deps.platform ?? process.platform
    const spawnOptions = buildOpenCodeHostSpawnOptions(profile, platform, { lifetime })
    let args = ['serve', '--hostname', '127.0.0.1', '--port']
    const binaryPath = isScopedPreparedProfile(profile)
      ? (() => {
          if (!verifiedScopedBinary) {
            throw new Error('OpenCode scoped host requires verified staged bytes')
          }
          const command = buildOpenCodeVerifiedScopedHostCommand(
            profile, verifiedScopedBinary, platform, process.arch,
          )
          args = command.args
          if (command.inheritedVerifiedFd) {
            spawnOptions.stdio = ['pipe', 'pipe', 'pipe', verifiedScopedBinary.fileHandle.fd]
          }
          return command.binaryPath
        })()
      : resolveOpenCodeBinaryPath() ?? 'opencode'
    return spawnPortableCli(
      binaryPath,
      [...args, String(port)],
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
        this.schedulePersistentExitCleanup(hostKey, receipt.registryReceipt, entry)
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

  private schedulePersistentExitCleanup(
    hostKey: string,
    receipt: PersistentHostRegistryRecord,
    entry: ManagedHostEntry,
  ): void {
    const immutableReceipt = immutableCanonicalPersistentHostRegistryRecord(receipt)
    this.pendingExitCleanups.set(hostKey, { receipt: immutableReceipt, entry, lastError: 'pending' })
    const task = this.retryPersistentExitCleanup(hostKey, 3).catch(error => {
      const pending = this.pendingExitCleanups.get(hostKey)
      if (pending) this.pendingExitCleanups.set(hostKey, { ...pending,
        lastError: error instanceof Error ? error.message : String(error) })
      return false
    })
      .finally(() => { this.exitCleanupTasks.delete(hostKey) })
    this.exitCleanupTasks.set(hostKey, task)
  }

  private async retryPersistentExitCleanup(hostKey: string, attempts: number): Promise<boolean> {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const pending = this.pendingExitCleanups.get(hostKey)
      if (!pending) return true
      try {
        await this.removePersistentHostByReceipt(hostKey, pending.receipt)
        this.pendingExitCleanups.delete(hostKey)
        return true
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.pendingExitCleanups.set(hostKey, { ...pending, lastError: message })
        pending.entry.handle.diagnostics.push(
          `persistent exit cleanup pending retry: ${isScopedPreparedProfile(pending.entry.handle.profile)
            ? '[redacted]' : message}`,
        )
        if (attempt + 1 < attempts) {
          try { await (this.deps.sleepMs ?? sleep)(Math.min(50, 5 * (attempt + 1))) }
          catch (sleepError) {
            this.pendingExitCleanups.set(hostKey, { ...pending,
              lastError: sleepError instanceof Error ? sleepError.message : String(sleepError) })
          }
        }
      }
    }
    return false
  }

  /** Observable bounded retry for exit cleanup that previously could not commit. */
  async reconcilePendingExitCleanups(): Promise<Readonly<{
    cleaned: number; pending: number; diagnostics: readonly string[]
  }>> {
    let cleaned = 0
    for (const hostKey of Array.from(this.pendingExitCleanups.keys())) {
      const existing = this.exitCleanupTasks.get(hostKey)
      if (existing && await existing) cleaned += 1
      else if (this.pendingExitCleanups.has(hostKey)
        && await this.retryPersistentExitCleanup(hostKey, 3)) cleaned += 1
    }
    return Object.freeze({
      cleaned,
      pending: this.pendingExitCleanups.size,
      diagnostics: Object.freeze(Array.from(this.pendingExitCleanups.values(), value => value.lastError)),
    })
  }

  private async forceKillSpawnedHostProcess(
    child: ChildProcess,
    handle: OpenCodeHostHandle,
  ): Promise<'complete' | 'incomplete'> {
    if ((this.deps.platform ?? process.platform) === 'win32') {
      if (await this.killOwnedChildAndWait(
        child, 'SIGTERM', OPEN_CODE_HOST_PROCESS_TERM_TIMEOUT_MS,
      )) return 'complete'
      return await this.killOwnedChildAndWait(
        child, 'SIGKILL', OPEN_CODE_HOST_PROCESS_KILL_TIMEOUT_MS,
      ) ? 'complete' : 'incomplete'
    }
    const pid = child.pid
    try {
      if (pid) {
        if (await this.killProcessAndWait(pid, 'SIGTERM', OPEN_CODE_HOST_PROCESS_TERM_TIMEOUT_MS,
          handle.processStartedAtMs, true, handle.processBirthToken)) {
          return 'complete'
        }
      } else {
        child.kill('SIGTERM')
      }
    } catch {
      // Best effort.
    }

    if (!pid) {
      return 'incomplete'
    }

    try {
      if (await this.killProcessAndWait(pid, 'SIGKILL', OPEN_CODE_HOST_PROCESS_KILL_TIMEOUT_MS,
        handle.processStartedAtMs, true, handle.processBirthToken)) return 'complete'
    } catch {
      // Best effort.
    }
    return this.hasStableProcessContainmentExited(pid) ? 'complete' : 'incomplete'
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
    controls: OpenCodeHostCleanupControls = {},
  ): Promise<void> {
    const child = entry.child
    if (!child) {
      throw new Error('Owned process-scoped OpenCode host has no child process handle')
    }

    this.assertCleanupAllowed(controls)
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

    this.assertCleanupAllowed(controls)
    let terminated = this.hasOwnedChildExited(child)
      && (!controls.requireStableContainment || (pid !== null && pid !== undefined
        && this.deps.isProcessGroupAlive !== undefined && this.deps.isProcessGroupAlive(pid) === false))
    if (!terminated) {
      terminated = controls.requireStableContainment
        ? (this.deps.platform ?? process.platform) === 'win32'
          ? await this.killOwnedChildAndWait(child, 'SIGTERM', OPEN_CODE_HOST_PROCESS_TERM_TIMEOUT_MS)
          : pid !== null && pid !== undefined && await this.killProcessAndWait(
            pid, 'SIGTERM', OPEN_CODE_HOST_PROCESS_TERM_TIMEOUT_MS,
            receipt.record.processStartedAtMs, true, receipt.record.processBirthToken)
        : await this.killOwnedChildAndWait(
          child, 'SIGTERM', OPEN_CODE_HOST_PROCESS_TERM_TIMEOUT_MS)
    }
    this.assertCleanupAllowed(controls)
    if (!terminated) {
      const forceContainmentAuthority = controls.requireStableContainment
        ? await this.captureEntryContainmentAuthority(entry)
        : true
      terminated = controls.requireStableContainment
        ? (this.deps.platform ?? process.platform) === 'win32'
          ? await this.killOwnedChildAndWait(child, 'SIGKILL', OPEN_CODE_HOST_PROCESS_KILL_TIMEOUT_MS)
          : forceContainmentAuthority && pid !== null && pid !== undefined && await this.killProcessAndWait(
            pid, 'SIGKILL', OPEN_CODE_HOST_PROCESS_KILL_TIMEOUT_MS,
            receipt.record.processStartedAtMs, true, receipt.record.processBirthToken)
        : await this.killOwnedChildAndWait(
          child, 'SIGKILL', OPEN_CODE_HOST_PROCESS_KILL_TIMEOUT_MS)
    }
    this.assertCleanupAllowed(controls)
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
    if (this.hosts.get(receipt.record.hostKey) === entry) {
      this.hosts.delete(receipt.record.hostKey)
    }
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
      // Capture native generation authority before health awaits. Startup can
      // fail after the fixture has detached descendants, so rollback must not
      // fall back to leader-only ChildProcess signalling.
      const startupStartedAtMs = await this.captureProcessStartTimeMs(handle.pid)
      const startupBirthToken = this.readProcessBirthToken(handle.pid)
      handle.processStartedAtMs = startupStartedAtMs
      handle.processBirthToken = startupBirthToken
      handle.resolvedConfigFingerprint = profile.managedConfigFingerprint
      this.captureCreatedHostDisposalReceipt(entry, null)
      if (
        handle.processStartedAtMs === null &&
        lifetime === 'persistent' &&
        !this.deps.spawnHostProcess
      ) {
        throw new Error(
          `OpenCode host pid ${handle.pid} process identity could not be captured after startup`,
        )
      }
      if (this.requiresNativeBirthToken() && !handle.processBirthToken) {
        throw new Error(`OpenCode host pid ${handle.pid} native birth identity could not be captured`)
      }
      if (handle.processStartedAtMs === null && lifetime === 'process') {
        diagnostics.push(
          `OpenCode host pid ${handle.pid} process identity was unavailable; ` +
          'cleanup is restricted to the owned child process handle',
        )
      }
      // Publish exact native containment before the health await. If startup
      // fails and descendants cannot be proved gone, this registry record is
      // the restart-reconcilable receipt paired with the attempt obligation.
      if (lifetime === 'persistent') {
        persistentWriteReceipt = await this.upsertPersistentHost(handle, generation, abortSignal)
        this.captureCreatedHostDisposalReceipt(entry, persistentWriteReceipt?.written ?? null)
      }
      const health = await this.waitForHealthyHost(
        baseUrl,
        () => this.pendingHostHealthTimeoutMs.get(hostKey) ?? OPEN_CODE_HOST_HEALTH_TIMEOUT_MS,
        abortSignal,
      )
      handle.version = health.version
      handle.resolvedConfigFingerprint = profile.managedConfigFingerprint
      handle.state = 'healthy'
      if (lifetime === 'persistent') {
        const healthyWriteReceipt = await this.upsertPersistentHost(handle, generation, abortSignal)
        if (healthyWriteReceipt) {
          persistentWriteReceipt = {
            ...healthyWriteReceipt,
            previous: persistentWriteReceipt?.previous,
          }
        }
        this.captureCreatedHostDisposalReceipt(entry, healthyWriteReceipt?.written ?? null)
      }
      if (lifetime !== 'persistent') this.captureCreatedHostDisposalReceipt(entry, null)
      this.assertStartupCurrent(hostKey, generation, abortSignal, entry, child)
      return handle
    } catch (error) {
      handle.state = 'degraded'
      const message = isScopedPreparedProfile(profile)
        ? 'OpenCode scoped host startup failed'
        : error instanceof Error ? error.message : String(error)
      diagnostics.push(message)
      if (this.hosts.get(hostKey) === entry) this.hosts.delete(hostKey)
      const startupCleanup = await this.forceKillSpawnedHostProcess(child, handle)
      if (persistentWriteReceipt && startupCleanup === 'complete') {
        await this.restorePersistentHostAfterFailedStartup(persistentWriteReceipt)
          .catch(() => undefined)
      }
      await this.cleanupOpenTuiTempArtifactsIfUnused(profile.tmpPath, child.pid)
      const diagnosticSuffix = diagnostics.length > 0 ? ` Diagnostics: ${diagnostics.join(' | ')}` : ''
      if (startupCleanup === 'incomplete') {
        const startupCleanupReceipt = Number.isFinite(handle.processStartedAtMs)
          ? Object.freeze({
              hostKey: handle.hostKey,
              receipt: Object.freeze({
                schemaVersion: handle.processBirthToken ? 2 as const : 1 as const,
                receiptId: randomUUID(),
                hostKeyDigest: createHash('sha256').update(handle.hostKey).digest('hex'),
                pid: handle.pid,
                processStartedAtMs: handle.processStartedAtMs!,
                ...(handle.processBirthToken ? { processBirthToken: handle.processBirthToken } : {}),
                lifetime,
              }),
            })
          : undefined
        throw new OpenCodeHostStartupCleanupError(
          'incomplete', error, startupCleanupReceipt,
        )
      }
      throw new OpenCodeHostStartupCleanupError(
        'complete', error, undefined,
        abortSignal?.aborted && abortSignal.reason instanceof Error
          ? abortSignal.reason.message
          : isScopedPreparedProfile(profile)
            ? 'OpenCode scoped host startup failed [redacted]'
            : `${message}${diagnosticSuffix}`,
      )
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
    if (existing?.handle.state === 'disposed') {
      const disposal = this.disposingHosts.get(existing)
      if (disposal) {
        // A compatibility release retains this exact map entry as its retry
        // receipt. Wait for that generation to settle before deciding whether
        // it can be reused or a replacement may be created.
        await disposal
        return this.ensurePreparedHost(params)
      }
    }
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
        // Committing the reference and returning it are one synchronous turn.
        // An abort which won the pending race must never increment refCount.
        if (params.abortSignal?.aborted) throwOpenCodeAbortReason(params.abortSignal)
        pendingEntry.refCount += 1
      }
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
      if (error && typeof error === 'object'
        && ((error as { cleanupDisposition?: unknown }).cleanupDisposition === 'complete'
          || (error as { cleanupDisposition?: unknown }).cleanupDisposition === 'incomplete')) throw error
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

  /**
   * Acquires and immediately binds a one-shot opaque release capability to the
   * exact private entry returned by ensureScopedHost. No caller-supplied flag
   * or reconstructed host key can authorize release.
   */
  async ensureScopedHostReference(params: Parameters<OpenCodeHostManager['ensureScopedHost']>[0]):
  Promise<OpenCodeHostReferenceCapability> {
    const handle = await this.ensureScopedHost(params)
    const entry = this.hosts.get(handle.hostKey)
    if (!entry || entry.handle.pid !== handle.pid
      || entry.handle.processStartedAtMs !== handle.processStartedAtMs) {
      throw new Error('OpenCode acquired host reference changed before binding [redacted]')
    }
    const capability = Object.freeze({ handle }) as OpenCodeHostReferenceCapability
    const receipt = Object.freeze({
      schemaVersion: handle.processBirthToken ? 2 as const : 1 as const,
      receiptId: randomUUID(),
      hostKeyDigest: createHash('sha256').update(handle.hostKey).digest('hex'),
      pid: handle.pid,
      processStartedAtMs: handle.processStartedAtMs ?? Number.NaN,
      ...(handle.processBirthToken ? { processBirthToken: handle.processBirthToken } : {}),
      lifetime: entry.lifetime,
    })
    hostReferenceCapabilities.set(capability, { manager: this, entry, receipt, state: 'available' })
    // Deliberately strong until physical cleanup succeeds. This is the local
    // half of the durable attempt ledger and prevents a returned launch run
    // from making its exact one-shot authority unreachable.
    durableHostReferenceCapabilities.set(receipt.receiptId,
      { manager: this, entry, capability, receipt })
    return capability
  }

  hostReleaseReceipt(capability: OpenCodeHostReferenceCapability): OpenCodeHostReleaseReceipt {
    const authority = hostReferenceCapabilities.get(capability)
    if (!authority || authority.manager !== this || authority.state === 'released') {
      throw new Error('OpenCode host reference capability is invalid or already consumed [redacted]')
    }
    if (!Number.isFinite(authority.receipt.processStartedAtMs)) {
      throw new Error('OpenCode host release receipt birth identity is unavailable [redacted]')
    }
    if (this.requiresNativeBirthToken() && !authority.receipt.processBirthToken) {
      throw new Error('OpenCode host release receipt native birth identity is unavailable [redacted]')
    }
    return Object.freeze({ ...authority.receipt })
  }

  /** Read-only proof that this manager still holds the exact live authority for a receipt. */
  hasExactRetainedHostReleaseCapability(receipt: OpenCodeHostReleaseReceipt): boolean {
    const retained = durableHostReferenceCapabilities.get(receipt.receiptId)
    return retained?.manager === this
      && canonicalSerializeOpenCodePolicyIdentity(retained.receipt)
        === canonicalSerializeOpenCodePolicyIdentity(receipt)
  }

  async reconcileHostReleaseReceipt(
    receipt: OpenCodeHostReleaseReceipt,
    options: {
      keepPersistentAlive?: boolean
      signal?: AbortSignal
      remainingMs?: () => number
      obligationIdentity?: NonNullable<OpenCodeHostCleanupControls['obligationIdentity']>
    } = {},
  ): Promise<void> {
    if ((receipt.schemaVersion !== 1 && receipt.schemaVersion !== 2) || typeof receipt.receiptId !== 'string'
      || !/^[0-9a-f-]{36}$/i.test(receipt.receiptId)
      || typeof receipt.hostKeyDigest !== 'string' || !/^[0-9a-f]{64}$/.test(receipt.hostKeyDigest)
      || !Number.isSafeInteger(receipt.pid) || receipt.pid <= 0
      || !Number.isFinite(receipt.processStartedAtMs)
      || (receipt.schemaVersion === 2 && (typeof receipt.processBirthToken !== 'string'
        || !receipt.processBirthToken.startsWith('linux:')))
      || (receipt.lifetime !== 'process' && receipt.lifetime !== 'persistent')) {
      throw new Error('OpenCode host release receipt is corrupt [redacted]')
    }
    if (options.obligationIdentity) {
      if (options.obligationIdentity.hostKeyDigest !== receipt.hostKeyDigest) {
        throw new Error('OpenCode host release obligation host identity is mismatched [redacted]')
      }
      const expected = computeOpenCodeHostReleaseObligationIdentityDigest({
        reservationDigest: options.obligationIdentity.reservationDigest,
        hostKeyIdentity: options.obligationIdentity.hostKeyIdentity,
        receipt,
      })
      if (expected !== options.obligationIdentity.receiptIdentityDigest) {
        throw new Error('OpenCode host release obligation identity is mismatched [redacted]')
      }
    }
    const retained = durableHostReferenceCapabilities.get(receipt.receiptId)
    if (retained) {
      if (retained.manager !== this
        || canonicalSerializeOpenCodePolicyIdentity(retained.receipt)
          !== canonicalSerializeOpenCodePolicyIdentity(receipt)) {
        throw new Error('OpenCode host release receipt is foreign [redacted]')
      }
      await this.releaseHostReference(retained.capability, options)
      return
    }
    // A tokenless legacy receipt has no exact generation authority after a
    // process restart on any platform. PID plus wall-clock start time can alias
    // a recycled leader, and a current registry record belongs to the current
    // process rather than proving that the legacy receipt acquired it. Only a
    // retained live capability above may independently bind such a receipt to
    // its original generation. Keep every other legacy obligation durable and
    // perform no registry/PID/containment probe, remote disposal, mutation, or signal.
    if (receipt.schemaVersion !== 2 || !receipt.processBirthToken) {
      throw new Error('OpenCode durable host cleanup lacks exact native generation authority [redacted]')
    }
    const entry = Array.from(this.hosts.values()).find(candidate =>
      createHash('sha256').update(candidate.handle.hostKey).digest('hex') === receipt.hostKeyDigest
      && candidate.handle.pid === receipt.pid
      && candidate.handle.processStartedAtMs === receipt.processStartedAtMs)
    if (entry) {
      // A receipt id is generation authority. Never let a reconstructed or
      // foreign receipt dispose a matching-looking live entry.
      throw new Error('OpenCode host release receipt generation is foreign [redacted]')
    }
    let registryReceiptFound = false
    await this.withPersistentRegistryLock(async () => {
      const registry = await this.readPersistentRegistryUnlocked()
      if (registry.schemaVersion !== 2) return
      const matched = Object.entries(registry.hosts).find(([hostKey]) =>
        createHash('sha256').update(hostKey).digest('hex') === receipt.hostKeyDigest)
      if (!matched) return
      registryReceiptFound = true
      const [hostKey, record] = matched
      if (record.scopedIdentity
        && !hasExactScopedHostIdentityBinding(record, this.scopedTransportOwnerKey)) {
        throw new Error('OpenCode host registry lifecycle binding is invalid [redacted]')
      }
      if (record.pid !== receipt.pid || record.processStartedAtMs !== receipt.processStartedAtMs
        || (receipt.processBirthToken !== undefined
          && record.processBirthToken !== receipt.processBirthToken)) {
        throw new Error('OpenCode host release receipt process generation changed [redacted]')
      }
      const durableLeases = normalizePersistentHostLeases(record.leases)
      if (receipt.lifetime === 'persistent'
        && (options.keepPersistentAlive === true || Object.keys(durableLeases).length > 0)) {
        // Releasing an operation reference is complete without terminating the
        // persistent host. Durable member leases take precedence over a stale
        // disposal intent recovered after a crash.
        return
      }
      await this.terminatePersistentHostRecord(record, {
        force: true,
        ignoreTrackedHandle: true,
        requireStableContainment: true,
      })
      if (registry.hosts[hostKey] !== record) {
        throw new Error('OpenCode host release registry receipt changed [redacted]')
      }
      delete registry.hosts[hostKey]
      if (registryHasAnyHosts(registry)) await this.writePersistentRegistryUnlocked(registry)
      else await this.unlinkPersistentRegistryUnlocked()
    })
    if (registryReceiptFound) return
    if (!this.isProcessAlive(receipt.pid)) {
      if (this.persistentContainmentExited(receipt.pid)) return
      throw new Error('OpenCode durable host containment cleanup remains incomplete [redacted]')
    }
    const observed = await this.readProcessStartTimeMs(receipt.pid).catch(() => null)
    if (observed !== receipt.processStartedAtMs) {
      throw new Error('OpenCode host release receipt process generation changed [redacted]')
    }
    if (this.requiresNativeBirthToken()
      && (!receipt.processBirthToken
        || this.readProcessBirthToken(receipt.pid) !== receipt.processBirthToken)) {
      throw new Error('OpenCode host release receipt native process generation changed [redacted]')
    }
    // After an actual process restart no in-memory child handle remains. Exact
    // birth validation still authorizes one bounded containment attempt. The
    // caller retains the durable receipt unless the whole containment unit is
    // physically proven absent.
    const disposed = await this.killProcessAndWait(receipt.pid, 'SIGTERM',
      OPEN_CODE_HOST_PROCESS_TERM_TIMEOUT_MS, receipt.processStartedAtMs, true,
      receipt.processBirthToken)
      || await this.killProcessAndWait(receipt.pid, 'SIGKILL',
        OPEN_CODE_HOST_PROCESS_KILL_TIMEOUT_MS, receipt.processStartedAtMs, true,
        receipt.processBirthToken)
    if (!disposed) throw new Error('OpenCode durable host containment cleanup remains incomplete [redacted]')
  }

  /**
   * Consume a final operation reference while holding the same durable
   * registry lock used by member-lease writers. A stale attempt-local view may
   * never dispose a persistent generation that now serves a committed member.
   * Returning false means disposal may be attempted, but its registry CAS will
   * still fence a lease published after this inspection.
   */
  private async consumeFinalReferenceForDurableLease(
    entry: ManagedHostEntry,
    consume: () => void,
  ): Promise<boolean> {
    if (entry.lifetime !== 'persistent' || !this.persistentRegistryPath) return false
    return this.withPersistentRegistryLock(async () => {
      const registry = await this.readPersistentRegistryUnlocked()
      if (registry.schemaVersion !== 2) {
        throw new Error('OpenCode persistent host registry cannot prove release disposition [redacted]')
      }
      const record = registry.hosts[entry.handle.hostKey]
      const expectedRecord = entry.ownedByProcess
        ? entry.createdDisposalReceipt?.registryReceipt : entry.adoptedRegistryReceipt
      if (!record
        || !expectedRecord
        || record.pid !== entry.handle.pid
        || record.processStartedAtMs !== entry.handle.processStartedAtMs
        || (entry.handle.processBirthToken !== undefined
          && record.processBirthToken !== entry.handle.processBirthToken)
        || canonicalSerializeOpenCodePolicyIdentity(
          persistentHostLifecycleIdentity(record, this.scopedTransportOwnerKey),
        ) !== canonicalSerializeOpenCodePolicyIdentity(
          persistentHostLifecycleIdentity(expectedRecord, this.scopedTransportOwnerKey),
        )) {
        throw new Error('OpenCode persistent host registry generation changed before release [redacted]')
      }
      if (Object.keys(normalizePersistentHostLeases(record.leases)).length === 0) return false
      consume()
      return true
    })
  }

  async releaseHostReference(
    capability: OpenCodeHostReferenceCapability,
    options: {
      keepPersistentAlive?: boolean
      signal?: AbortSignal
      remainingMs?: () => number
    } = {},
  ): Promise<void> {
    const authority = hostReferenceCapabilities.get(capability)
    if (!authority || authority.manager !== this || authority.state === 'released') {
      throw new Error('OpenCode host reference capability is invalid or already consumed [redacted]')
    }
    if (authority.state === 'releasing') return authority.release!
    if (options.signal?.aborted || (options.remainingMs && options.remainingMs() <= 0)) {
      throw options.signal?.reason ?? new Error('OpenCode host reference release deadline expired')
    }
    const entry = authority.entry
    if (this.hosts.get(entry.handle.hostKey) !== entry) {
      throw new Error('OpenCode host reference generation changed before release [redacted]')
    }
    if (entry.refCount <= 0) {
      throw new Error('OpenCode host reference count is invalid [redacted]')
    }
    authority.state = 'releasing'
    const release = (async () => {
      // A shared reference has no physical disposal obligation and can commit
      // immediately. The final reference retains its count and capability until
      // disposal is physically proven, making a failed release retryable.
      if (entry.refCount > 1) {
        entry.refCount -= 1
        authority.state = 'released'
        durableHostReferenceCapabilities.delete(authority.receipt.receiptId)
        return
      }
      const consumeReference = (): void => {
        entry.refCount = 0
        authority.state = 'released'
        durableHostReferenceCapabilities.delete(authority.receipt.receiptId)
      }
      // Durable member/session leases outrank both a stale `dispose` intent and
      // a retained in-memory capability. Inspect and consume under the registry
      // lock on every final persistent-reference release path.
      if (entry.lifetime === 'persistent'
        && await this.consumeFinalReferenceForDurableLease(entry, consumeReference)) {
        return
      }
      if (entry.lifetime === 'persistent' && options.keepPersistentAlive) {
        consumeReference()
        return
      }
      if (entry.ownedByProcess) {
        // disposeHost revalidates the exact leader while holding the durable
        // registry generation lock. Leader loss reaches only the stable,
        // non-signalling Linux containment observer and retains the receipt
        // whenever emptiness is not proven.
        try {
          await this.disposeHost(entry.handle.hostKey, {
            restoreOnFailure: true,
            signal: options.signal,
            remainingMs: options.remainingMs,
            requireStableContainment: true,
          })
        } catch (error) {
          if (error instanceof OpenCodeHostDurablyLeasedError) {
            consumeReference()
            return
          }
          throw error
        }
      } else if (this.hosts.get(entry.handle.hostKey) === entry) {
        this.hosts.delete(entry.handle.hostKey)
      }
      consumeReference()
    })()
    authority.release = release
    try {
      await release
    } catch (error) {
      authority.state = 'available'
      authority.release = undefined
      throw error
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
    options: { force: boolean; ignoreTrackedHandle?: boolean; cleanupTempPath?: string;
      ownedEntry?: ManagedHostEntry }
      & OpenCodeHostCleanupControls,
  ): Promise<void> {
    if (record.scopedIdentity
      && !hasExactScopedHostIdentityBinding(record, this.scopedTransportOwnerKey)) {
      throw new Error('OpenCode host registry lifecycle binding is invalid [redacted]')
    }
    const entry = options.ownedEntry ?? (options.ignoreTrackedHandle ? undefined : this.hosts.get(record.hostKey))
    const baseUrl = entry?.handle.baseUrl ?? scopedRecordBaseUrl(
      record,
      record.scopedIdentity ? this.scopedTransportOwnerKey : undefined,
    )
    const pid = entry?.handle.pid ?? record.pid
    let terminated = false

    this.assertCleanupAllowed(options)

    const processIdentity = await this.inspectPersistentHostProcessIdentity({
      ...record,
      processStartedAtMs: entry?.handle.processStartedAtMs ?? record.processStartedAtMs,
    })
    if (processIdentity.state === 'gone' || processIdentity.state === 'changed') {
      // A gone or changed exact leader invalidates its numeric PGID authority. Do not
      // probe or signal the group after this point. Cleanup completes
      // only when the non-signalling containment observer proves it empty.
      if (!this.persistentContainmentExited(pid)) {
        throw new Error(`OpenCode host pid ${pid} containment remained alive or unproven after cleanup`)
      }
      terminated = true
    } else if (processIdentity.state !== 'confirmed') {
      throw new Error(`OpenCode host pid ${pid} identity could not be verified; refusing unsafe termination`)
    }

    if (!terminated && options.requireStableContainment === true
      && (this.deps.platform ?? process.platform) === 'win32' && !entry?.child) {
      throw new Error(
        `OpenCode host pid ${pid} has no owned Windows launcher/job handle; cleanup remains incomplete`,
      )
    }

    if (!terminated) {
      this.assertCleanupAllowed(options)
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
      this.assertCleanupAllowed(options)
      const identityBeforeKill = await this.assertPersistentHostProcessIdentity(
        record, processIdentity.startedAtMs)
      if (identityBeforeKill === 'gone') {
        if (!this.persistentContainmentExited(pid)) {
          throw new Error(`OpenCode host pid ${pid} containment remained alive or unproven after cleanup`)
        }
        terminated = true
      } else if (entry?.child?.pid) {
        terminated = options.requireStableContainment === true
          && (this.deps.platform ?? process.platform) === 'win32'
          ? await this.killOwnedChildAndWait(entry.child, 'SIGTERM',
            OPEN_CODE_HOST_PROCESS_TERM_TIMEOUT_MS)
          : await this.killProcessAndWait(
            entry.child.pid,
            'SIGTERM',
            OPEN_CODE_HOST_PROCESS_TERM_TIMEOUT_MS,
            processIdentity.startedAtMs,
            options.requireStableContainment === true,
            record.processBirthToken,
          )
      } else {
        terminated = await this.killProcessAndWait(
          pid,
          'SIGTERM',
          OPEN_CODE_HOST_PROCESS_TERM_TIMEOUT_MS,
          processIdentity.startedAtMs,
          options.requireStableContainment === true,
          record.processBirthToken,
        )
      }
    } else if (!terminated && entry?.child) {
      entry.child.kill('SIGTERM')
    }

    this.assertCleanupAllowed(options)
    if (options.force && pid > 0 && !terminated && this.isProcessAlive(pid)) {
      const identityBeforeForceKill = await this.assertPersistentHostProcessIdentity(
        record, processIdentity.startedAtMs)
      if (identityBeforeForceKill === 'gone') {
        if (!this.persistentContainmentExited(pid)) {
          throw new Error(`OpenCode host pid ${pid} containment remained alive or unproven after cleanup`)
        }
        terminated = true
      } else {
        terminated = entry?.child && options.requireStableContainment === true
          && (this.deps.platform ?? process.platform) === 'win32'
          ? await this.killOwnedChildAndWait(entry.child, 'SIGKILL',
            OPEN_CODE_HOST_PROCESS_KILL_TIMEOUT_MS)
          : await this.killProcessAndWait(
          pid,
          'SIGKILL',
          OPEN_CODE_HOST_PROCESS_KILL_TIMEOUT_MS,
          processIdentity.startedAtMs,
          options.requireStableContainment === true,
          record.processBirthToken,
          )
      }
    }

    this.assertCleanupAllowed(options)

    if (options.requireStableContainment && pid > 0 && !terminated) {
      // Leader loss revokes signalling authority, but Linux's complete stable
      // /proc observer may still prove that the whole containment is empty.
      // No group signal or probe occurs in this branch.
      if (this.isProcessAlive(pid) || !this.hasStableProcessContainmentExited(pid)) {
        throw new Error(
          `OpenCode host pid ${pid} containment remained alive or unproven after cleanup`,
        )
      }
      terminated = true
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
    if (entry && this.hosts.get(record.hostKey) === entry) {
      this.hosts.delete(record.hostKey)
    }
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
        if (this.hosts.get(hostKey) !== entry
          && !this.disposingHosts.has(entry)) {
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
        if (Object.keys(normalizePersistentHostLeases(current.leases)).length > 0) {
          throw new OpenCodeHostDurablyLeasedError(
            'OpenCode persistent host gained a durable lease before disposal [redacted]')
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
          requireStableContainment: true,
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
    controls: OpenCodeHostCleanupControls = {},
  ): Promise<void> {
    const receipt = this.assertCreatedHostDisposalReceipt(hostKey, entry)
    if (
      receipt.childPid !== null
      && !Number.isFinite(receipt.record.processStartedAtMs)
      && receipt.registryReceipt === null
    ) {
      await this.terminateOwnedProcessHostByReceipt(entry, receipt, controls)
      return
    }

    const terminate = async (): Promise<void> => {
      // Recheck immediately before effects so an internal/public-handle
      // redirection cannot win after the first validation.
      this.assertCreatedHostDisposalReceipt(hostKey, entry)
      await this.terminatePersistentHostRecord(receipt.record, {
        force: true,
        ignoreTrackedHandle: true,
        ownedEntry: entry,
        cleanupTempPath: receipt.profileTmpPath,
        ...controls,
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
        if (Object.keys(normalizePersistentHostLeases(current.leases)).length > 0) {
          throw new OpenCodeHostDurablyLeasedError(
            'OpenCode persistent host gained a durable lease before disposal [redacted]')
        }
        const processIdentity = await this.inspectPersistentHostProcessIdentity(receipt.record)
        const exactLeader = processIdentity.state === 'confirmed'
          && (Number.isFinite(receipt.record.processStartedAtMs)
            ? processIdentity.startedAtMs === receipt.record.processStartedAtMs
            : processIdentity.startedAtMs === null)
        const safelyEmptyAfterLeaderLoss = (processIdentity.state === 'gone'
          || processIdentity.state === 'changed')
          && this.persistentContainmentExited(receipt.record.pid)
        if (!exactLeader && !safelyEmptyAfterLeaderLoss) {
          throw new Error('OpenCode created host process compare-and-swap failed [redacted]')
        }

        if (exactLeader) {
          await terminate()
        } else {
          // The exact created generation is still CAS-bound by both the
          // immutable disposal receipt and the authenticated registry record,
          // but its leader authority is gone.  A complete stable Linux
          // containment scan proved that no member of the original process
          // group remains, so settle the retained capability without issuing
          // any signal or PID/group probe.  This is deliberately unavailable
          // on platforms whose observer cannot provide that proof.
          this.assertCleanupAllowed(controls)
          entry.child?.stdout?.destroy()
          entry.child?.stderr?.destroy()
          entry.child?.stdin?.destroy()
          entry.handle.state = 'disposed'
          if (this.hosts.get(hostKey) === entry) this.hosts.delete(hostKey)
          await this.cleanupOpenTuiTempArtifactsIfUnused(receipt.profileTmpPath, receipt.record.pid)
        }
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

  async disposeHost(
    hostKey: string,
    controls: OpenCodeHostCleanupControls & { restoreOnFailure?: boolean } = {},
  ): Promise<boolean> {
    const pending = this.pendingHosts.has(hostKey)
      || this.pendingHostGenerations.has(hostKey)
      || this.scopedStagingGenerations.has(hostKey)
    this.scopedStagingGenerations.delete(hostKey)
    this.pendingHostGenerations.delete(hostKey)
    this.pendingHosts.delete(hostKey)
    const entry = this.hosts.get(hostKey)
    if (!entry) {
      const inFlightDisposal = this.disposalTails.get(hostKey)
      if (inFlightDisposal) {
        await inFlightDisposal.promise
        return true
      }
      return pending
    }
    const exactDisposal = this.disposingHosts.get(entry)
    if (exactDisposal) {
      await exactDisposal
      return true
    }
    // Remove the zero-ref entry before the first disposal await. A concurrent
    // ensure can now only create/adopt a fresh host; it cannot reacquire bytes
    // whose process is already committed to termination.
    const previousState = entry.handle.state
    if (!controls.retainExactEntryDuringDisposal && this.hosts.get(hostKey) === entry) {
      this.hosts.delete(hostKey)
    }
    if (!Object.isFrozen(entry.handle)) entry.handle.state = 'disposed'
    publicHostHandleSnapshots.delete(entry.handle)
    const previousDisposal = this.disposalTails.get(hostKey)?.promise
    let disposal!: Promise<void>
    disposal = Promise.resolve(previousDisposal).catch(() => undefined).then(async () => {
      this.assertCleanupAllowed(controls)
      if (!entry.ownedByProcess && entry.adoptedRegistryReceipt) {
        await this.disposeAdoptedPersistentHost(hostKey, entry)
        return
      }
      if (entry.ownedByProcess) {
        await this.disposeCreatedHost(hostKey, entry, controls)
        return
      }
      throw new Error('OpenCode host disposal ownership receipt is unavailable [redacted]')
    }).finally(() => {
      if (this.disposingHosts.get(entry) === disposal) {
        this.disposingHosts.delete(entry)
      }
      if (this.disposalTails.get(hostKey)?.promise === disposal) {
        this.disposalTails.delete(hostKey)
      }
    })
    this.disposingHosts.set(entry, disposal)
    this.disposalTails.set(hostKey, { entry, promise: disposal })
    try {
      await disposal
      if (this.hosts.get(hostKey) === entry) this.hosts.delete(hostKey)
    } catch (error) {
      // Explicit administrative disposal remains retryable after a failed
      // compare-and-swap. Zero-ref release opts out: such an entry must never
      // become reusable after disposal has begun.
      if (controls.restoreOnFailure !== false
        && (this.hosts.get(hostKey) === entry || !this.hosts.has(hostKey))
        && !this.pendingHosts.has(hostKey)) {
        if (!Object.isFrozen(entry.handle)) entry.handle.state = previousState
        this.hosts.set(hostKey, entry)
      }
      throw error
    }
    return true
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
        if (record.scopedIdentity
          && !hasExactScopedHostIdentityBinding(record, this.scopedTransportOwnerKey)) {
          // The PID and containment tuple are untrusted unless the separately
          // retained owner authority authenticates the complete lifecycle.
          // Do not use a corrupt PID even for an apparent emptiness proof.
          hosts.push({ hostKey, projectPath: projectLabel, pid: record.pid, port: record.port,
            action: 'failed', reason: 'scoped lifecycle binding is absent or invalid',
            leaseCount: Object.keys(normalizePersistentHostLeases(record.leases)).length })
          diagnostics.push(`Retained OpenCode host ${hostKey}: scoped lifecycle binding is invalid`)
          continue
        }
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
          if (!this.persistentContainmentExited(record.pid)) {
            hosts.push({
              hostKey,
              projectPath: projectLabel,
              pid: record.pid,
              port: record.port,
              action: 'failed',
              reason: 'leader exited but descendant containment remains alive or unproven',
              leaseCount,
            })
            diagnostics.push(
              `Retained OpenCode host ${hostKey}: leader exited but containment cleanup is incomplete`,
            )
            continue
          }
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
          if (!this.persistentContainmentExited(record.pid)) {
            hosts.push({ hostKey, projectPath: projectLabel, pid: record.pid, port: record.port,
              action: 'failed', reason: 'leader exited during identity verification but containment remains unproven',
              leaseCount })
            diagnostics.push(
              `Retained OpenCode host ${hostKey}: containment cleanup could not be proven after leader exit`,
            )
            continue
          }
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
          await this.terminatePersistentHostRecord(record, {
            force, requireStableContainment: true,
          })
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

    if (entry.refCount <= 0) return
    if (entry.refCount > 1) {
      entry.refCount -= 1
      return
    }
    if (entry.refCount === 1) {
      if (entry.lifetime === 'persistent' && options.keepPersistentAlive) {
        entry.refCount = 0
        return
      }
      if (entry.ownedByProcess) {
        // Retain both the exact entry and its final reference until physical
        // disposal succeeds. Catalog/probe compatibility callers can retry the
        // same generation after any rejection instead of observing false
        // absence from a prematurely removed map entry.
        await this.disposeHost(hostKey, {
          restoreOnFailure: true,
          retainExactEntryDuringDisposal: true,
        })
      } else {
        // Adopted entries are reusable only while referenced. Remove them
        // synchronously so a racing ensure must revalidate durable ownership.
        if (this.hosts.get(hostKey) === entry) this.hosts.delete(hostKey)
      }
      entry.refCount = 0
    }
  }
}

export const openCodeHostManager = new OpenCodeHostManager()
