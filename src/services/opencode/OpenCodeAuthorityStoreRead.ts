import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { stopRequestKey, validateStopReceipt } from './OpenCodeStopRecovery.js'
import type { OpenCodeSessionRecord } from './types.js'
import type { OpenCodeStopReceipt } from './OpenCodeStopRecovery.js'
import type { MaterializationOwnerToken } from './OpenCodeSessionStore.js'

type MaterializationOwnerProcessIdentity = { pid: number; startedAtMs: number | null }

/** V1 paths stay with their existing owners. This boundary never selects a V2 writer. */
export type OpenCodeAuthorityRead<T> =
  | { kind: 'missing' }
  | { kind: 'known'; value: T; bytes: string }
  | { kind: 'preserved_unknown'; reason: 'unreadable' | 'nonregular' | 'invalid' }

export class OpenCodeAuthorityVetoError extends Error {
  readonly kind = 'preserved_unknown' as const
  constructor(readonly store: 'host' | 'session', readonly reason: 'unreadable' | 'nonregular' | 'invalid') {
    super('OpenCode authority is unknown; operation vetoed and store preserved (' + store + '/' + reason + ')')
    this.name = 'OpenCodeAuthorityVetoError'
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
const text = (v: unknown): v is string => typeof v === 'string'
const nullableText = (v: unknown): v is string | null => v === null || text(v)
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
function fields(v: Record<string, unknown>, names: string[], valid: (v: unknown) => boolean): boolean {
  return names.every(name => valid(v[name]))
}
function optional(v: Record<string, unknown>, name: string, valid: (v: unknown) => boolean): boolean {
  return !Object.hasOwn(v, name) || valid(v[name])
}
function map(v: unknown, valid: (v: unknown, key: string) => boolean): boolean {
  return object(v) && Object.entries(v).every(([key, value]) => valid(value, key))
}
function envelope(v: unknown): v is Record<string, unknown> {
  // A mixed future envelope must not be mistaken for an extension to legacy V1.
  return object(v) && v.schemaVersion === 1 && !Object.hasOwn(v, 'version')
    && (!Object.hasOwn(v, 'generation') || v.generation === 'v1')
}

/** Only initial lstat ENOENT means missing. Do not follow links or open devices/FIFOs. */
export async function readOpenCodeAuthority<T>(
  file: string, validate: (value: unknown) => value is T,
): Promise<OpenCodeAuthorityRead<T>> {
  // Atomic writers replace regular files by rename. A raced inode is never
  // admitted: close it and restart the complete no-follow check, at most twice.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let metadata
    try { metadata = await lstat(file, { bigint: true }) } catch (error) {
      return attempt === 0 && error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'
        ? { kind: 'missing' } : { kind: 'preserved_unknown', reason: 'unreadable' }
    }
    if (!metadata.isFile() || metadata.isSymbolicLink()) return { kind: 'preserved_unknown', reason: 'nonregular' }
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      const current = await handle.stat({ bigint: true })
      if (!current.isFile()) return { kind: 'preserved_unknown', reason: 'nonregular' }
      if (current.ino !== metadata.ino || current.dev !== metadata.dev) {
        if (attempt < 2) continue
        return { kind: 'preserved_unknown', reason: 'nonregular' }
      }
      const bytes = await handle.readFile('utf8')
      let value: unknown
      try { value = JSON.parse(bytes) } catch { return { kind: 'preserved_unknown', reason: 'invalid' } }
      try {
        return validate(value) ? { kind: 'known', value, bytes } : { kind: 'preserved_unknown', reason: 'invalid' }
      } catch { return { kind: 'preserved_unknown', reason: 'invalid' } }
    } catch { return { kind: 'preserved_unknown', reason: 'unreadable' } }
    finally { await handle?.close() }
  }
  return { kind: 'preserved_unknown', reason: 'nonregular' }
}

export function requireOpenCodeAuthority<T>(read: OpenCodeAuthorityRead<T>, store: 'host' | 'session', empty: () => T): T {
  if (read.kind === 'preserved_unknown') throw new OpenCodeAuthorityVetoError(store, read.reason)
  return read.kind === 'missing' ? empty() : read.value
}

export type PersistentHostLeaseRecord = {
  leaseKey: string
  teamId: string
  laneId: string
  memberName: string
  runId: string | null
  sessionId: string | null
  createdAt: string
  updatedAt: string
}

export type PersistentHostRegistryRecord = {
  cursorAgentReapContractVersion?: 1
  hostKey: string
  profileRootKey: string
  projectPath: string
  projectBehaviorFingerprint: string
  managedConfigFingerprint?: string | null
  baseUrl: string
  port: number
  pid: number
  processStartedAtMs?: number | null
  attributionId?: string | null
  version: string | null
  resolvedConfigFingerprint: string | null
  updatedAt: string
  leases?: Record<string, PersistentHostLeaseRecord>
}

export type PersistentHostRegistryShape = {
  schemaVersion: 1
  processIdentityFormat?: 'platform-native-v2'
  hosts: Record<string, PersistentHostRegistryRecord>
}

export type SessionStoreShape = {
  schemaVersion: 1
  records: Record<string, OpenCodeSessionRecord>
  stopReceipts?: Record<string, OpenCodeStopReceipt>
  materializationClaims?: Record<string, string>
  materializationClaimRuns?: Record<string, string>
  materializationOwners?: Record<string, MaterializationOwnerToken>
  materializationOwnerVersions?: Record<string, number>
  materializationOwnerProcesses?: Record<string, MaterializationOwnerProcessIdentity>
}


function lease(v: unknown, key: string): boolean {
  return object(v) && fields(v, ['teamId', 'laneId', 'memberName', 'createdAt', 'updatedAt'], text)
    && optional(v, 'leaseKey', value => text(value) && (!value || value === key))
    && optional(v, 'runId', nullableText) && optional(v, 'sessionId', nullableText)
}
export function isKnownHostRegistry(v: unknown): v is PersistentHostRegistryShape {
  return envelope(v) && optional(v, 'processIdentityFormat', value => value === 'platform-native-v2')
    && map(v.hosts, (host, key) => object(host)
      && fields(host, ['hostKey', 'profileRootKey', 'projectPath', 'projectBehaviorFingerprint', 'baseUrl', 'updatedAt'], text)
      && host.hostKey === key && positive(host.pid) && positive(host.port) && host.port <= 65535
      && optional(host, 'version', nullableText) && optional(host, 'resolvedConfigFingerprint', nullableText)
      && optional(host, 'managedConfigFingerprint', nullableText) && optional(host, 'attributionId', nullableText)
      && optional(host, 'processStartedAtMs', value => value === null || (finite(value) && Number(value) > 0))
      && optional(host, 'cursorAgentReapContractVersion', value => value === 1)
      && optional(host, 'leases', value => map(value, lease)))
}
function owner(v: unknown): boolean {
  // Absence of version is the historical V1 migration. Invalid present versions are never legacy.
  return object(v) && fields(v, ['attemptId', 'sessionId'], text) && optional(v, 'version', positive)
}
function claim(v: unknown): boolean {
  if (!text(v) || !v) return false
  // Historical claims are opaque attempt strings. JSON-shaped claims must be complete tokens.
  if (!(v as string).trimStart().startsWith('{')) return true
  try { const parsed = JSON.parse(v as string); return owner(parsed) && positive(parsed.version) } catch { return false }
}
function storedStatus(v: unknown): boolean {
  if (nullableText(v)) return true
  // Older schema1 writers retained API payloads, not a scalar status.
  return object(v) && ['idle', 'busy', 'retry'].includes(v.type as string)
    && Object.keys(v).every(name => ['type', 'attempt', 'message', 'next'].includes(name))
    && optional(v, 'message', text)
    && optional(v, 'attempt', value => Number.isSafeInteger(value) && Number(value) >= 0)
    && optional(v, 'next', value => finite(value) && value >= 0 && Number.isFinite(new Date(value).getTime()))
}
function sessionIndex(v: Record<string, unknown>, key: string): boolean {
  if (key === `${v.teamId}::${v.laneId ?? 'primary'}::${v.memberName}`) return true
  // Pre-lane indexes are retained as archives; never assign them a lane.
  return !Object.hasOwn(v, 'laneId') && key.split('::').length === 2
    && key === `${v.teamId}::${v.memberName}`
}
function sessionRecord(v: unknown, key: string): boolean {
  if (!object(v) || v.providerId !== 'opencode'
    || !fields(v, ['teamId', 'memberName', 'selectedModel', 'projectPath', 'profileRootKey', 'hostKey',
      'opencodeSessionId', 'projectBehaviorFingerprint', 'createdAt', 'updatedAt'], text)
    || !sessionIndex(v, key)) return false
  if (!['runId', 'laneId', 'selectedVariant', 'expectedBehaviorFingerprint', 'managedConfigFingerprint', 'opencodeVersion']
    .every(name => optional(v, name, text))) return false
  if (!['resolvedBehaviorFingerprint', 'lastCanonicalCursor', 'lastKnownDurableState',
    'sourceAuthFingerprint', 'managedAuthFingerprint', 'staleReason'].every(name => optional(v, name, nullableText))) return false
  if (!optional(v, 'lastKnownRawStatus', storedStatus)) return false
  if (!optional(v, 'toolApprovalMode', value => value === 'auto' || value === 'manual')) return false
  if (!optional(v, 'runtimePid', positive) || !optional(v, 'stoppedAt', text)) return false
  if (!optional(v, 'profileScope', value => value === null || (object(value)
    && fields(value, ['purpose', 'providerId', 'configFingerprint', 'selectedAuthIdentity', 'scopeToken'], text)
    && ['catalog', 'execution_probe', 'launch_runtime'].includes(value.purpose as string)
    && (value.selectedAuthIdentity === 'absent' || value.selectedAuthIdentity === 'error'
      || (text(value.selectedAuthIdentity) && value.selectedAuthIdentity.startsWith('known:')))))) return false
  if (!optional(v, 'stopAuthority', value => object(value) && text(value.expectedBehaviorFingerprint)
    && object(value.runtime) && value.runtime.providerId === 'opencode' && text(value.runtime.capabilitySnapshotId)
    && fields(value.runtime, ['binaryPath', 'binaryFingerprint', 'version'], nullableText))) return false
  return true
}
export function isKnownSessionStore(v: unknown): v is SessionStoreShape {
  return envelope(v) && map(v.records, sessionRecord)
    && optional(v, 'materializationOwners', value => map(value, owner))
    && optional(v, 'materializationClaims', value => map(value, claim))
    && optional(v, 'materializationClaimRuns', value => map(value, text))
    && optional(v, 'materializationOwnerVersions', value => map(value, positive))
    && optional(v, 'materializationOwnerProcesses', value => map(value, identity => object(identity)
      && positive(identity.pid) && (identity.startedAtMs === null || finite(identity.startedAtMs))))
    && optional(v, 'stopReceipts', value => map(value, (receipt, key) => stopRequestKey(validateStopReceipt(receipt).request) === key))
}

export function normalizePersistentHostLeases(value: unknown): Record<string, PersistentHostLeaseRecord> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }

  // JSON indexes such as __proto__ are own authority entries, not setters.
  const leases: Record<string, PersistentHostLeaseRecord> = Object.create(null)
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
      ...lease,
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

export function normalizeKnownHostRegistry(parsed: PersistentHostRegistryShape): PersistentHostRegistryShape {
  const hosts = Object.fromEntries(
    Object.entries(parsed.hosts as Record<string, PersistentHostRegistryRecord>).map(
      ([hostKey, record]) => [
        hostKey,
        {
          ...record,
          // Before Linux switched to /proc start ticks, this field held
          // ps lstart epoch milliseconds. Treat that old value as a
          // legacy PID-only identity so command, health, fingerprint and
          // stable tick checks can migrate it without orphaning the host.
          ...(process.platform === 'linux'
            && parsed.processIdentityFormat !== 'platform-native-v2'
            && Number(record.processStartedAtMs) > 1_000_000_000_000
            ? { processStartedAtMs: undefined } : {}),
          // Normalization must never manufacture destructive cleanup authority.
          cursorAgentReapContractVersion:
            parsed.processIdentityFormat === 'platform-native-v2'
            && record.cursorAgentReapContractVersion === 1
            && record.leases !== null && typeof record.leases === 'object'
            && !Array.isArray(record.leases)
            && Object.keys(record.leases).every(key =>
              Object.prototype.hasOwnProperty.call(normalizePersistentHostLeases(record.leases), key))
              ? 1 as const : undefined,
          leases: normalizePersistentHostLeases(record.leases),
        },
      ],
    ),
  )
  return { ...parsed, hosts }
}
