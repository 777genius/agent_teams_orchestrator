import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

import * as lockfile from '../../utils/lockfile.js'
import { writeJsonFileAtomic } from '../../utils/atomicWrite.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { resolveClaudeMultimodelPaths } from './OpenCodeManagedPaths.js'
import {
  canonicalizeOpenCodeProjectIdentity,
  normalizeOpenCodeProjectIdentity,
} from './OpenCodeProjectIdentity.js'

import type { OpenCodeSessionRecord } from './types.js'
import {
  normalizeOpenCodeLogicalMemberIdentity,
  openCodeLogicalMemberKey,
  type OpenCodeLogicalMemberIdentity,
} from './OpenCodeLogicalMemberKey.js'

type SessionStoreShape = {
  schemaVersion: 3
  records: Record<string, OpenCodeSessionRecord>
  reservations: Record<string, OpenCodeSessionReservation>
}

export type OpenCodeSessionReservation = OpenCodeLogicalMemberIdentity & {
  version: 1
  logicalMemberKey: string
  reservationIdentity: string
  expectedOpencodeSessionId: string
  createdAt: string
}

export type OpenCodeSessionReservationResult =
  | { status: 'reserved' | 'exact'; reservation: OpenCodeSessionReservation }
  | { status: 'conflict'; reservation?: OpenCodeSessionReservation; record?: OpenCodeSessionRecord }

type UpsertResult = 'created' | 'updated' | 'unchanged'

export type ConditionalUpsertResult =
  | { status: 'applied' | 'already-satisfied'; record: OpenCodeSessionRecord }
  | { status: 'absent' }
  | { status: 'foreign'; record: OpenCodeSessionRecord }

export type OpenCodeSessionPublicationResult =
  | { status: 'inserted' | 'exact'; record: OpenCodeSessionRecord }
  | { status: 'conflict'; record: OpenCodeSessionRecord }

export type OpenCodeSessionSuccessorPublicationResult =
  | { status: 'replaced' | 'exact'; record: OpenCodeSessionRecord }
  | { status: 'absent' }
  | { status: 'conflict'; record?: OpenCodeSessionRecord; reservation?: OpenCodeSessionReservation }

export type OpenCodeSessionSuccessorTransitionResult =
  | { status: 'applied' | 'already-satisfied'; record: OpenCodeSessionRecord }
  | { status: 'absent' }
  | { status: 'foreign'; record: OpenCodeSessionRecord }

export type ConditionalMarkStaleResult =
  | { status: 'applied'; record: OpenCodeSessionRecord }
  | { status: 'already-satisfied'; record: OpenCodeSessionRecord }
  | { status: 'absent' }
  | { status: 'foreign'; record: OpenCodeSessionRecord }

export type ConditionalDeleteResult =
  | { status: 'applied'; record: OpenCodeSessionRecord }
  | { status: 'absent' }
  | { status: 'foreign'; record: OpenCodeSessionRecord }

const LOCK_OPTIONS = {
  retries: {
    retries: 30,
    minTimeout: 5,
    maxTimeout: 100,
  },
}
const RESERVATION_TOKEN = /^[A-Za-z0-9._:-]{1,256}$/

function buildRecordKey(
  record: Pick<OpenCodeSessionRecord, 'teamId' | 'laneId' | 'memberName' | 'projectIdentity'>,
): string {
  // A projection has exactly the same identity domain as its reservation. In
  // particular, project identity is not metadata: omitting it here lets a
  // publication for another project overwrite the first project atomically
  // and leaves no evidence that the first projection ever existed.
  return logicalKeyForRecord(record)
}

function sameLookupIdentity(record: Pick<OpenCodeSessionRecord, 'teamId' | 'laneId' | 'memberName'>,
  teamId: string, laneId: string, memberName: string): boolean {
  return record.teamId.trim() === teamId.trim()
    && (record.laneId ?? 'primary').trim() === laneId.trim()
    && record.memberName.trim().toLowerCase() === memberName.trim().toLowerCase()
}

function recordsForLegacyLookup(store: SessionStoreShape, teamId: string, laneId: string,
  memberName: string): OpenCodeSessionRecord[] {
  return Object.values(store.records).filter(record =>
    sameLookupIdentity(record, teamId, laneId, memberName))
}

function recordForLogicalMember(store: SessionStoreShape,
  logicalMember: OpenCodeLogicalMemberIdentity): OpenCodeSessionRecord | undefined {
  const logicalKey = openCodeLogicalMemberKey(logicalMember)
  return store.records[logicalKey]
    ?? Object.values(store.records).find(record => logicalKeyForRecord(record) === logicalKey)
}

function unambiguousLegacyRecord(store: SessionStoreShape, teamId: string, laneId: string,
  memberName: string): OpenCodeSessionRecord | undefined {
  const candidates = recordsForLegacyLookup(store, teamId, laneId, memberName)
  return candidates.length === 1 ? candidates[0] : undefined
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath)
    return true
  } catch {
    return false
  }
}

export class OpenCodeSessionStore {
  private readonly filePath: string
  private readonly lockPath: string

  constructor(filePath?: string) {
    const paths = resolveClaudeMultimodelPaths()
    this.filePath = filePath ?? path.join(paths.data, 'opencode', 'session-store.json')
    this.lockPath = `${this.filePath}.lock`
  }

  private async ensureParentDir(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true })
  }

  private async ensureLockFile(): Promise<void> {
    await this.ensureParentDir()
    await writeFile(this.lockPath, '', { flag: 'a' })
  }

  private async withStoreLock<T>(callback: () => Promise<T>): Promise<T> {
    await this.ensureLockFile()

    let release: (() => Promise<void>) | undefined
    try {
      release = await lockfile.lock(this.lockPath, LOCK_OPTIONS)
      return await callback()
    } finally {
      if (release) {
        await release()
      }
    }
  }

  private async readStore(persistMigration = false): Promise<SessionStoreShape> {
    if (!(await fileExists(this.filePath))) {
      return {
        schemaVersion: 3,
        records: {},
        reservations: {},
      }
    }

    const content = await readFile(this.filePath, 'utf8')
    const parsed = JSON.parse(content) as Record<string, unknown>
    if (![1, 2, 3].includes(Number(parsed.schemaVersion))
      || !isRecordMap(parsed.records)) {
      throw new Error('invalid OpenCode session store')
    }
    const allowedStoreKeys = Number(parsed.schemaVersion) === 1
      ? ['records', 'schemaVersion'] : ['records', 'reservations', 'schemaVersion']
    if (Object.keys(parsed).sort().join(',') !== allowedStoreKeys.sort().join(',')) {
      throw new Error('invalid OpenCode session store shape')
    }
    const records: Record<string, OpenCodeSessionRecord> = {}
    for (const [persistedKey, value] of Object.entries(parsed.records)) {
      const record = await migrateAndValidateRecord(Number(parsed.schemaVersion), persistedKey, value)
      const key = buildRecordKey(record)
      if (records[key] && jsonStringify(records[key]) !== jsonStringify(record)) {
        throw new Error('conflicting normalized OpenCode session records')
      }
      records[key] = record
    }
    if (Number(parsed.schemaVersion) >= 2 && !isRecordMap(parsed.reservations)) {
      throw new Error('invalid OpenCode session reservations')
    }
    const reservations = Number(parsed.schemaVersion) >= 2
      ? await migrateAndValidateReservations(
        Number(parsed.schemaVersion), parsed.reservations as Record<string, unknown>)
      : {}
    const store: SessionStoreShape = { schemaVersion: 3, records, reservations }
    if (persistMigration && Number(parsed.schemaVersion) !== 3) await this.writeStore(store)
    return store
  }

  private async writeStore(store: SessionStoreShape): Promise<void> {
    await writeJsonFileAtomic(this.filePath, store, { indent: 2 })
  }

  async list(): Promise<OpenCodeSessionRecord[]> {
    const store = await this.readStore()
    return Object.values(store.records)
  }

  async get(teamId: string, laneIdOrMemberName: string, memberName?: string): Promise<OpenCodeSessionRecord | null> {
    const laneId = memberName ? laneIdOrMemberName : 'primary'
    const normalizedMemberName = memberName ?? laneIdOrMemberName
    const store = await this.readStore()
    // Compatibility lookup is intentionally usable only while its old
    // team/lane/member identity identifies one project. Returning an arbitrary
    // candidate here would cross the project authority boundary.
    return unambiguousLegacyRecord(store, teamId, laneId, normalizedMemberName) ?? null
  }

  async getByLogicalMember(
    logicalMember: OpenCodeLogicalMemberIdentity,
  ): Promise<OpenCodeSessionRecord | null> {
    const canonicalLogicalMember = await canonicalizeLogicalMember(logicalMember)
    const store = await this.readStore()
    return recordForLogicalMember(store, canonicalLogicalMember) ?? null
  }

  async upsert(record: OpenCodeSessionRecord): Promise<UpsertResult> {
    const validatedRecord = await validateCanonicalRecordForWrite(record)
    return this.withStoreLock(async () => {
      const store = await this.readStore(true)
      const validated = validatedRecord
      const key = buildRecordKey(validated)
      const previous = store.records[key]

      const logicalKey = logicalKeyForRecord(validated)
      const reservation = store.reservations[logicalKey]
      if (!previous && reservation) {
        throw new Error('OpenCode logical member requires its durable reservation authority')
      }

      if (previous && jsonStringify(previous) === jsonStringify(validated)) {
        return 'unchanged'
      }

      store.records[key] = validated
      await this.writeStore(store)
      return previous ? 'updated' : 'created'
    })
  }

  /** Updates metadata only while the exact project/run/session owner is current. */
  async upsertIfSessionMatches(
    record: OpenCodeSessionRecord,
    expectedOpencodeSessionId: string,
    expectedRunId: string | null,
  ): Promise<ConditionalUpsertResult> {
    const validatedRecord = await validateCanonicalRecordForWrite(record)
    return this.withStoreLock(async () => {
      const store = await this.readStore(true)
      const validated = validatedRecord
      const previous = recordForLogicalMember(store, validated)
      if (!previous) return { status: 'absent' }
      if (!hasExpectedOwner(previous, expectedOpencodeSessionId, expectedRunId)) {
        return { status: 'foreign', record: previous }
      }
      if (jsonStringify(previous) === jsonStringify(validated)) {
        return { status: 'already-satisfied', record: previous }
      }
      store.records[buildRecordKey(validated)] = validated
      await this.writeStore(store)
      return { status: 'applied', record: validated }
    })
  }

  /** Atomic launch projection: never replaces a different session owner. */
  async publishIfAbsentOrExact(record: OpenCodeSessionRecord): Promise<OpenCodeSessionPublicationResult> {
    const validatedRecord = await validateCanonicalRecordForWrite(record)
    return this.withStoreLock(async () => {
      const store = await this.readStore(true)
      const validated = validatedRecord
      const key = buildRecordKey(validated)
      const logicalKey = openCodeLogicalMemberKey({
        teamId: validated.teamId,
        laneId: validated.laneId ?? 'primary',
        projectIdentity: validated.projectIdentity,
        memberName: validated.memberName,
      })
      const reservation = store.reservations[logicalKey]
      if (reservation) {
        const reservedRecord = Object.values(store.records).find(candidate =>
          logicalKeyForRecord(candidate) === logicalKey)
        return { status: 'conflict', record: reservedRecord ?? validated }
      }
      const existing = Object.values(store.records).find(candidate =>
        openCodeLogicalMemberKey({
          teamId: candidate.teamId,
          laneId: candidate.laneId ?? 'primary',
          projectIdentity: candidate.projectIdentity,
          memberName: candidate.memberName,
        }) === logicalKey,
      ) ?? store.records[key]
      if (existing) {
        return jsonStringify(existing) === jsonStringify(validated)
          ? { status: 'exact', record: existing }
          : { status: 'conflict', record: existing }
      }
      store.records[key] = validated
      await this.writeStore(store)
      return { status: 'inserted', record: validated }
    })
  }

  /** Atomically replaces only the exact predecessor projection for refresh. */
  async publishSuccessorIfExact(
    record: OpenCodeSessionRecord,
    expectedOldSessionId: string,
    expectedOldRunId: string | null,
  ): Promise<OpenCodeSessionSuccessorPublicationResult> {
    const validated = await validateCanonicalRecordForWrite(record)
    requiredString(expectedOldSessionId, 'expectedOldSessionId')
    if (expectedOldRunId !== null) requiredString(expectedOldRunId, 'expectedOldRunId')
    return this.withStoreLock(async () => {
      const store = await this.readStore(true)
      const logicalKey = logicalKeyForRecord(validated)
      const existing = recordForLogicalMember(store, validated)
      const reservation = store.reservations[logicalKey]
      if (reservation) return { status: 'conflict', record: existing, reservation }
      if (!existing) return { status: 'absent' }
      if (jsonStringify(existing) === jsonStringify(validated)) {
        return { status: 'exact', record: existing }
      }
      if (!hasExpectedOwner(existing, expectedOldSessionId, expectedOldRunId)) {
        return { status: 'conflict', record: existing }
      }
      store.records[logicalKey] = validated
      await this.writeStore(store)
      return { status: 'replaced', record: validated }
    })
  }

  /** Advances or clears one exact published successor hand-off. */
  async advanceSuccessorTransitionIfExact(
    logicalMember: OpenCodeLogicalMemberIdentity,
    expectedOpencodeSessionId: string,
    expectedRunId: string | null,
    attemptIdentity: string,
    expectedPhase: NonNullable<OpenCodeSessionRecord['successorTransition']>['phase'],
    nextPhase: NonNullable<OpenCodeSessionRecord['successorTransition']>['phase'] | null,
  ): Promise<OpenCodeSessionSuccessorTransitionResult> {
    requiredString(expectedOpencodeSessionId, 'expectedOpencodeSessionId')
    if (expectedRunId !== null) requiredString(expectedRunId, 'expectedRunId')
    requiredTransitionIdentity(attemptIdentity)
    if (nextPhase === null && expectedPhase !== 'transition_complete') {
      throw new Error('OpenCode successor transition may clear only after completion')
    }
    const canonicalLogicalMember = await canonicalizeLogicalMember(logicalMember)
    return this.withStoreLock(async () => {
      const store = await this.readStore(true)
      const existing = recordForLogicalMember(store, canonicalLogicalMember)
      if (!existing) return { status: 'absent' }
      if (!hasExpectedOwner(existing, expectedOpencodeSessionId, expectedRunId)) {
        return { status: 'foreign', record: existing }
      }
      const transition = existing.successorTransition
      if (!transition || transition.attemptIdentity !== attemptIdentity) {
        return { status: 'foreign', record: existing }
      }
      if (transition.phase !== expectedPhase) {
        return { status: 'already-satisfied', record: existing }
      }
      const next: OpenCodeSessionRecord = nextPhase === null
        ? (() => {
          const { successorTransition: _transition, ...record } = existing
          return record
        })()
        : { ...existing, successorTransition: { ...transition, phase: nextPhase } }
      store.records[buildRecordKey(next)] = next
      await this.writeStore(store)
      return { status: 'applied', record: next }
    })
  }

  /**
   * Reserves the normalized logical member under the same durable store lock as
   * publication. This transition must complete before provider/session effects.
   */
  async reserveLogicalMember(logicalMember: OpenCodeLogicalMemberIdentity,
    reservationIdentity: string, expectedOpencodeSessionId: string): Promise<OpenCodeSessionReservationResult> {
    if (!RESERVATION_TOKEN.test(reservationIdentity)
      || !RESERVATION_TOKEN.test(expectedOpencodeSessionId)) {
      throw new TypeError('invalid OpenCode session reservation identity')
    }
    const normalized = await canonicalizeLogicalMember(logicalMember)
    const logicalMemberKey = openCodeLogicalMemberKey(normalized)
    return this.withStoreLock(async () => {
      const store = await this.readStore(true)
      const record = Object.values(store.records).find(candidate => logicalKeyForRecord(candidate) === logicalMemberKey)
      if (record) {
        return record.opencodeSessionId === expectedOpencodeSessionId
          ? { status: 'exact', reservation: store.reservations[logicalMemberKey] ?? {
            version: 1, logicalMemberKey, ...normalized, reservationIdentity,
            expectedOpencodeSessionId, createdAt: record.createdAt,
          } }
          : { status: 'conflict', record }
      }
      const previous = store.reservations[logicalMemberKey]
      if (previous) {
        return previous.reservationIdentity === reservationIdentity
          && previous.expectedOpencodeSessionId === expectedOpencodeSessionId
          ? { status: 'exact', reservation: previous }
          : { status: 'conflict', reservation: previous }
      }
      const reservation: OpenCodeSessionReservation = {
        version: 1, logicalMemberKey, ...normalized, reservationIdentity,
        expectedOpencodeSessionId, createdAt: new Date().toISOString(),
      }
      store.reservations[logicalMemberKey] = reservation
      await this.writeStore(store)
      return { status: 'reserved', reservation }
    })
  }

  /** Publish only through the exact durable reservation and consume it atomically. */
  async publishReserved(record: OpenCodeSessionRecord,
    reservationIdentity: string): Promise<OpenCodeSessionPublicationResult> {
    const validatedRecord = await validateCanonicalRecordForWrite(record)
    return this.withStoreLock(async () => {
      const store = await this.readStore(true)
      const validated = validatedRecord
      const logicalKey = logicalKeyForRecord(validated)
      const reservation = store.reservations[logicalKey]
      const existing = Object.values(store.records).find(candidate => logicalKeyForRecord(candidate) === logicalKey)
      if (!reservation || reservation.reservationIdentity !== reservationIdentity
        || reservation.expectedOpencodeSessionId !== validated.opencodeSessionId) {
        return { status: 'conflict', record: existing ?? validated }
      }
      if (existing && jsonStringify(existing) !== jsonStringify(validated)) {
        return { status: 'conflict', record: existing }
      }
      if (!existing) store.records[buildRecordKey(validated)] = validated
      delete store.reservations[logicalKey]
      await this.writeStore(store)
      return { status: existing ? 'exact' : 'inserted', record: existing ?? validated }
    })
  }

  async markStale(
    teamId: string,
    laneIdOrMemberName: string,
    memberNameOrStaleReason: string,
    staleReasonMaybe?: string,
  ): Promise<OpenCodeSessionRecord | null> {
    const laneId = staleReasonMaybe ? laneIdOrMemberName : 'primary'
    const memberName = staleReasonMaybe ? memberNameOrStaleReason : laneIdOrMemberName
    const staleReason = staleReasonMaybe ?? memberNameOrStaleReason
    return this.withStoreLock(async () => {
      const store = await this.readStore(true)
      const previous = unambiguousLegacyRecord(store, teamId, laneId, memberName)
      if (!previous) {
        return null
      }
      const key = buildRecordKey(previous)

      if (previous.staleReason === staleReason) {
        return previous
      }

      const next: OpenCodeSessionRecord = {
        ...previous,
        staleReason,
        updatedAt: new Date().toISOString(),
      }

      store.records[key] = next
      await this.writeStore(store)
      return next
    })
  }

  async markStaleByLogicalMember(
    logicalMember: OpenCodeLogicalMemberIdentity,
    staleReason: string,
  ): Promise<OpenCodeSessionRecord | null> {
    const canonicalLogicalMember = await canonicalizeLogicalMember(logicalMember)
    return this.withStoreLock(async () => {
      const store = await this.readStore(true)
      const previous = recordForLogicalMember(store, canonicalLogicalMember)
      if (!previous) return null
      if (previous.staleReason === staleReason) return previous
      const next = { ...previous, staleReason, updatedAt: new Date().toISOString() }
      store.records[buildRecordKey(previous)] = next
      await this.writeStore(store)
      return next
    })
  }

  async markStaleIfSessionMatches(
    teamId: string,
    laneId: string,
    memberName: string,
    expectedOpencodeSessionId: string,
    staleReason: string,
  ): Promise<ConditionalMarkStaleResult> {
    return this.withStoreLock(async () => {
      const store = await this.readStore(true)
      const candidates = recordsForLegacyLookup(store, teamId, laneId, memberName)
      if (candidates.length > 1) throw new Error('ambiguous OpenCode legacy session mutation')
      const previous = candidates[0]
      if (!previous) {
        return { status: 'absent' }
      }
      if (previous.opencodeSessionId !== expectedOpencodeSessionId) {
        return { status: 'foreign', record: previous }
      }

      const key = buildRecordKey(previous)

      if (previous.staleReason === staleReason) {
        return { status: 'already-satisfied', record: previous }
      }

      const next: OpenCodeSessionRecord = {
        ...previous,
        staleReason,
        updatedAt: new Date().toISOString(),
      }

      store.records[key] = next
      await this.writeStore(store)
      return { status: 'applied', record: next }
    })
  }

  async markStaleIfSessionMatchesLogicalMember(
    logicalMember: OpenCodeLogicalMemberIdentity,
    expectedOpencodeSessionId: string,
    staleReason: string,
    expectedRunId?: string | null,
  ): Promise<ConditionalMarkStaleResult> {
    const canonicalLogicalMember = await canonicalizeLogicalMember(logicalMember)
    return this.withStoreLock(async () => {
      const store = await this.readStore(true)
      const previous = recordForLogicalMember(store, canonicalLogicalMember)
      if (!previous) return { status: 'absent' }
      if (!hasExpectedOwner(previous, expectedOpencodeSessionId, expectedRunId)) {
        return { status: 'foreign', record: previous }
      }
      if (previous.staleReason === staleReason) {
        return { status: 'already-satisfied', record: previous }
      }
      const next = { ...previous, staleReason, updatedAt: new Date().toISOString() }
      store.records[buildRecordKey(previous)] = next
      await this.writeStore(store)
      return { status: 'applied', record: next }
    })
  }

  async delete(teamId: string, laneIdOrMemberName: string, memberName?: string): Promise<boolean> {
    const laneId = memberName ? laneIdOrMemberName : 'primary'
    const normalizedMemberName = memberName ?? laneIdOrMemberName
    return this.withStoreLock(async () => {
      const store = await this.readStore(true)
      const previous = unambiguousLegacyRecord(store, teamId, laneId, normalizedMemberName)
      if (!previous) {
        return false
      }

      delete store.records[buildRecordKey(previous)]
      await this.writeStore(store)
      return true
    })
  }

  async deleteByLogicalMember(logicalMember: OpenCodeLogicalMemberIdentity): Promise<boolean> {
    const canonicalLogicalMember = await canonicalizeLogicalMember(logicalMember)
    return this.withStoreLock(async () => {
      const store = await this.readStore(true)
      const previous = recordForLogicalMember(store, canonicalLogicalMember)
      if (!previous) return false
      delete store.records[buildRecordKey(previous)]
      await this.writeStore(store)
      return true
    })
  }

  /**
   * Deletes only the record currently owned by `expectedOpencodeSessionId`.
   *
   * `absent` is an idempotent cleanup result, but it does not prove that this
   * session was previously stored at the key. A durable cleanup journal may
   * treat it as satisfied only for the exact cleanup entry it is replaying.
   */
  async deleteIfSessionMatches(
    teamId: string,
    laneId: string,
    memberName: string,
    expectedOpencodeSessionId: string,
  ): Promise<ConditionalDeleteResult> {
    return this.withStoreLock(async () => {
      const store = await this.readStore(true)
      const candidates = recordsForLegacyLookup(store, teamId, laneId, memberName)
      if (candidates.length > 1) throw new Error('ambiguous OpenCode legacy session mutation')
      const previous = candidates[0]
      if (!previous) {
        return { status: 'absent' }
      }
      if (previous.opencodeSessionId !== expectedOpencodeSessionId) {
        return { status: 'foreign', record: previous }
      }

      delete store.records[buildRecordKey(previous)]
      await this.writeStore(store)
      return { status: 'applied', record: previous }
    })
  }

  async deleteIfSessionMatchesLogicalMember(
    logicalMember: OpenCodeLogicalMemberIdentity,
    expectedOpencodeSessionId: string,
    expectedRunId?: string | null,
  ): Promise<ConditionalDeleteResult> {
    const canonicalLogicalMember = await canonicalizeLogicalMember(logicalMember)
    return this.withStoreLock(async () => {
      const store = await this.readStore(true)
      const previous = recordForLogicalMember(store, canonicalLogicalMember)
      if (!previous) return { status: 'absent' }
      if (!hasExpectedOwner(previous, expectedOpencodeSessionId, expectedRunId)) {
        return { status: 'foreign', record: previous }
      }
      delete store.records[buildRecordKey(previous)]
      await this.writeStore(store)
      return { status: 'applied', record: previous }
    })
  }
}

export const openCodeSessionStore = new OpenCodeSessionStore()

function logicalKeyForRecord(record: OpenCodeSessionRecord): string {
  return openCodeLogicalMemberKey({ teamId: record.teamId, laneId: record.laneId ?? 'primary',
    projectIdentity: record.projectIdentity, memberName: record.memberName })
}

const RECORD_REQUIRED_KEYS = [
  'createdAt', 'hostKey', 'lastCanonicalCursor', 'lastKnownDurableState', 'lastKnownRawStatus',
  'managedAuthFingerprint', 'memberName', 'opencodeSessionId', 'profileRootKey', 'projectBehaviorFingerprint',
  'projectIdentity', 'projectPath', 'providerId', 'resolvedBehaviorFingerprint', 'runId', 'selectedModel',
  'sourceAuthFingerprint', 'staleReason', 'teamId', 'updatedAt', 'version',
] as const
const RECORD_OPTIONAL_KEYS = [
  'appManagedBootstrap', 'bootstrapEvidenceSource', 'bootstrapMode', 'laneId', 'managedConfigFingerprint',
  'opencodeVersion', 'runtimePid', 'selectedVariant', 'successorTransition', 'toolApprovalMode',
] as const
const RECORD_ALLOWED_KEYS = new Set<string>([...RECORD_REQUIRED_KEYS, ...RECORD_OPTIONAL_KEYS])
const LEGACY_RECORD_ALLOWED_KEYS = new Set<string>([
  ...RECORD_REQUIRED_KEYS.filter(key => !['projectIdentity', 'runId', 'version'].includes(key)),
  ...RECORD_OPTIONAL_KEYS,
])

function isRecordMap(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

async function migrateAndValidateRecord(
  storeVersion: number,
  persistedKey: string,
  value: unknown,
): Promise<OpenCodeSessionRecord> {
  if (!isRecordMap(value)) throw new Error('invalid OpenCode session record')
  if (value.version === 2) {
    const record = validateRecordForWrite(value as OpenCodeSessionRecord)
    if (persistedKey !== logicalKeyForRecord(record)) {
      throw new Error('OpenCode session record key mismatch')
    }
    const canonical = await canonicalizeOpenCodeProjectIdentity(record.projectIdentity, {
      allowMissing: true,
    })
    if (canonical !== record.projectIdentity) {
      throw new Error('OpenCode session project identity is not canonical')
    }
    return record
  }
  if (storeVersion === 3) throw new Error('invalid OpenCode session record version')
  for (const key of Object.keys(value)) {
    if (!LEGACY_RECORD_ALLOWED_KEYS.has(key)) throw new Error('invalid legacy OpenCode session record shape')
  }
  for (const key of RECORD_REQUIRED_KEYS) {
    if (!['projectIdentity', 'runId', 'version'].includes(key) && !(key in value)) {
      throw new Error('invalid legacy OpenCode session record shape')
    }
  }
  const legacyProjectPath = requiredString(value.projectPath, 'projectPath')
  const projectPath = await canonicalizeOpenCodeProjectIdentity(
    legacyProjectPath, { allowMissing: true })
  const migrated = validateRecordForWrite({
    ...value,
    version: 2,
    projectIdentity: projectPath,
    projectPath,
    runId: null,
  } as OpenCodeSessionRecord)
  const canonicalKey = logicalKeyForRecord(migrated)
  const laneId = migrated.laneId ?? 'primary'
  const legacyKeys = new Set([
    canonicalKey,
    openCodeLogicalMemberKey({
      teamId: migrated.teamId, laneId, projectIdentity: legacyProjectPath,
      memberName: migrated.memberName,
    }),
    `${migrated.teamId}::${laneId}::${migrated.memberName}`,
    `${migrated.teamId}::${migrated.memberName}`,
  ])
  if (!legacyKeys.has(persistedKey)) throw new Error('ambiguous legacy OpenCode session record key')
  return migrated
}

function validateRecordForWrite(value: OpenCodeSessionRecord): OpenCodeSessionRecord {
  if (!isRecordMap(value)) throw new Error('invalid OpenCode session record')
  for (const key of Object.keys(value)) {
    if (!RECORD_ALLOWED_KEYS.has(key)) throw new Error('invalid OpenCode session record shape')
  }
  for (const key of RECORD_REQUIRED_KEYS) {
    if (!(key in value)) throw new Error('invalid OpenCode session record shape')
  }
  if (value.version !== 2 || value.providerId !== 'opencode') {
    throw new Error('invalid OpenCode session record version')
  }
  const projectIdentity = requiredString(value.projectIdentity, 'projectIdentity')
  const projectPath = requiredString(value.projectPath, 'projectPath')
  if (projectIdentity !== projectPath
    || normalizeOpenCodeProjectIdentity(projectIdentity) !== projectIdentity) {
    throw new Error('OpenCode session project identity mismatch')
  }
  normalizeOpenCodeLogicalMemberIdentity({
    teamId: requiredString(value.teamId, 'teamId'),
    laneId: requiredString(value.laneId ?? 'primary', 'laneId'),
    projectIdentity,
    memberName: requiredString(value.memberName, 'memberName'),
  })
  for (const field of ['selectedModel', 'profileRootKey', 'hostKey', 'opencodeSessionId',
    'projectBehaviorFingerprint', 'createdAt', 'updatedAt'] as const) requiredString(value[field], field)
  if (value.runId !== null) requiredString(value.runId, 'runId')
  for (const field of ['lastCanonicalCursor', 'lastKnownRawStatus', 'resolvedBehaviorFingerprint',
    'sourceAuthFingerprint', 'managedAuthFingerprint', 'staleReason'] as const) {
    validateNullableString(value[field], field)
  }
  for (const field of ['selectedVariant', 'managedConfigFingerprint', 'opencodeVersion'] as const) {
    if (value[field] !== undefined) requiredString(value[field], field)
  }
  if (value.runtimePid !== undefined
    && (!Number.isSafeInteger(value.runtimePid) || value.runtimePid <= 0)) {
    throw new Error('invalid OpenCode session record runtimePid')
  }
  if (value.toolApprovalMode !== undefined
    && value.toolApprovalMode !== 'auto' && value.toolApprovalMode !== 'manual') {
    throw new Error('invalid OpenCode session record toolApprovalMode')
  }
  if (value.bootstrapMode !== undefined
    && value.bootstrapMode !== 'app_managed_context' && value.bootstrapMode !== 'model_tool_checkin') {
    throw new Error('invalid OpenCode session record bootstrapMode')
  }
  if (value.bootstrapEvidenceSource !== undefined
    && value.bootstrapEvidenceSource !== 'app_managed_bootstrap'
    && value.bootstrapEvidenceSource !== 'runtime_bootstrap_checkin') {
    throw new Error('invalid OpenCode session record bootstrapEvidenceSource')
  }
  const durableStates = new Set(['idle', 'running', 'retrying', 'blocked', 'error', 'reply_pending', 'unknown'])
  if (value.lastKnownDurableState !== null && !durableStates.has(String(value.lastKnownDurableState))) {
    throw new Error('invalid OpenCode session record lastKnownDurableState')
  }
  if (value.appManagedBootstrap !== undefined) validateAppManagedBootstrap(value.appManagedBootstrap)
  if (value.successorTransition !== undefined) validateSuccessorTransition(value.successorTransition)
  if (!Number.isFinite(Date.parse(value.createdAt)) || !Number.isFinite(Date.parse(value.updatedAt))) {
    throw new Error('invalid OpenCode session record timestamp')
  }
  return value
}

function requiredTransitionIdentity(value: unknown): string {
  const identity = requiredString(value, 'successorTransition.attemptIdentity')
  if (!/^[a-f0-9]{64}$/u.test(identity)) {
    throw new Error('invalid OpenCode successor transition identity')
  }
  return identity
}

function validateSuccessorTransition(value: unknown): void {
  if (!isRecordMap(value)) throw new Error('invalid OpenCode successor transition')
  const allowed = ['attemptIdentity', 'phase', 'predecessorHostKey',
    'predecessorOpencodeSessionId', 'predecessorRunId', 'version']
  if (Object.keys(value).sort().join(',') !== allowed.sort().join(',') || value.version !== 1
    || !['successor_lease_pending', 'predecessor_release_pending', 'transition_complete']
      .includes(String(value.phase))) {
    throw new Error('invalid OpenCode successor transition')
  }
  requiredTransitionIdentity(value.attemptIdentity)
  requiredString(value.predecessorHostKey, 'successorTransition.predecessorHostKey')
  requiredString(value.predecessorOpencodeSessionId,
    'successorTransition.predecessorOpencodeSessionId')
  if (value.predecessorRunId !== null) {
    requiredString(value.predecessorRunId, 'successorTransition.predecessorRunId')
  }
}

async function validateCanonicalRecordForWrite(
  value: OpenCodeSessionRecord,
): Promise<OpenCodeSessionRecord> {
  const record = validateRecordForWrite(value)
  const canonical = await canonicalizeOpenCodeProjectIdentity(record.projectIdentity, {
    allowMissing: true,
  })
  if (canonical !== record.projectIdentity) {
    throw new Error('OpenCode session project identity is not canonical')
  }
  return record
}

async function canonicalizeLogicalMember(
  value: OpenCodeLogicalMemberIdentity,
): Promise<OpenCodeLogicalMemberIdentity> {
  return normalizeOpenCodeLogicalMemberIdentity({
    ...value,
    projectIdentity: await canonicalizeOpenCodeProjectIdentity(value.projectIdentity, {
      allowMissing: true,
    }),
  })
}

function validateNullableString(value: unknown, field: string): void {
  if (value !== null) requiredString(value, field)
}

function validateAppManagedBootstrap(value: unknown): void {
  if (!isRecordMap(value)) throw new Error('invalid OpenCode app-managed bootstrap record')
  const required = ['briefingHash', 'contextHash', 'injectionVerifiedAt', 'messageID', 'schemaVersion']
  const allowed = new Set([...required, 'agent', 'model'])
  if (Object.keys(value).some(key => !allowed.has(key))
    || required.some(key => !(key in value)) || value.schemaVersion !== 1) {
    throw new Error('invalid OpenCode app-managed bootstrap record')
  }
  for (const field of ['briefingHash', 'contextHash', 'injectionVerifiedAt', 'messageID'] as const) {
    requiredString(value[field], field)
  }
  if (value.agent !== undefined) requiredString(value.agent, 'agent')
  if (value.model !== undefined) requiredString(value.model, 'model')
  if (!Number.isFinite(Date.parse(String(value.injectionVerifiedAt)))) {
    throw new Error('invalid OpenCode app-managed bootstrap timestamp')
  }
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()
    || value.length > 4_096 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`invalid OpenCode session record ${field}`)
  }
  return value
}

function hasExpectedOwner(
  record: OpenCodeSessionRecord,
  expectedOpencodeSessionId: string,
  expectedRunId: string | null | undefined,
): boolean {
  return record.opencodeSessionId === expectedOpencodeSessionId
    && (expectedRunId === undefined || record.runId === expectedRunId)
}

async function migrateAndValidateReservations(
  storeVersion: number,
  persisted: Record<string, unknown>,
): Promise<Record<string, OpenCodeSessionReservation>> {
  const normalized: Record<string, OpenCodeSessionReservation> = {}
  for (const [persistedKey, value] of Object.entries(persisted).sort(([a], [b]) => a.localeCompare(b))) {
    validateReservation(persistedKey, value)
    const canonicalProjectIdentity = await canonicalizeOpenCodeProjectIdentity(value.projectIdentity, {
      allowMissing: true,
    })
    if (storeVersion === 3 && canonicalProjectIdentity !== value.projectIdentity) {
      throw new Error('OpenCode session reservation project identity is not canonical')
    }
    const logical = normalizeOpenCodeLogicalMemberIdentity({
      teamId: value.teamId,
      laneId: value.laneId,
      projectIdentity: canonicalProjectIdentity,
      memberName: value.memberName,
    })
    const logicalMemberKey = openCodeLogicalMemberKey(logical)
    const reservation: OpenCodeSessionReservation = {
      version: 1,
      logicalMemberKey,
      ...logical,
      reservationIdentity: value.reservationIdentity,
      expectedOpencodeSessionId: value.expectedOpencodeSessionId,
      createdAt: value.createdAt,
    }
    const collision = normalized[logicalMemberKey]
    if (collision && !sameReservationAuthority(collision, reservation)) {
      throw new Error('conflicting normalized OpenCode session reservations')
    }
    normalized[logicalMemberKey] = collision && collision.createdAt <= reservation.createdAt
      ? collision : reservation
  }
  return normalized
}

function sameReservationAuthority(
  left: OpenCodeSessionReservation,
  right: OpenCodeSessionReservation,
): boolean {
  const { createdAt: _leftCreatedAt, ...leftAuthority } = left
  const { createdAt: _rightCreatedAt, ...rightAuthority } = right
  return jsonStringify(leftAuthority) === jsonStringify(rightAuthority)
}

function validateReservation(key: string, value: unknown): asserts value is OpenCodeSessionReservation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid OpenCode session reservation')
  }
  const reservation = value as Record<string, unknown>
  const allowed = ['createdAt', 'expectedOpencodeSessionId', 'laneId', 'logicalMemberKey', 'memberName',
    'projectIdentity', 'reservationIdentity', 'teamId', 'version']
  if (Object.keys(reservation).sort().join(',') !== allowed.sort().join(',') || reservation.version !== 1
    || reservation.logicalMemberKey !== key
    || !RESERVATION_TOKEN.test(String(reservation.reservationIdentity))
    || !RESERVATION_TOKEN.test(String(reservation.expectedOpencodeSessionId))
    || typeof reservation.createdAt !== 'string'
    || !Number.isFinite(Date.parse(reservation.createdAt))) {
    throw new Error('invalid OpenCode session reservation')
  }
  const logical = normalizeOpenCodeLogicalMemberIdentity({
    teamId: String(reservation.teamId), laneId: String(reservation.laneId),
    projectIdentity: String(reservation.projectIdentity), memberName: String(reservation.memberName),
  })
  if (JSON.stringify(logical) !== JSON.stringify({ teamId: reservation.teamId, laneId: reservation.laneId,
    projectIdentity: reservation.projectIdentity, memberName: reservation.memberName })
    || openCodeLogicalMemberKey(logical) !== key) throw new Error('invalid OpenCode session reservation')
}
