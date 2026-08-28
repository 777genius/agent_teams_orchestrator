import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

import * as lockfile from '../../utils/lockfile.js'
import { writeJsonFileAtomic } from '../../utils/atomicWrite.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { resolveClaudeMultimodelPaths } from './OpenCodeManagedPaths.js'

import type { OpenCodeSessionRecord } from './types.js'
import {
  normalizeOpenCodeLogicalMemberIdentity,
  openCodeLogicalMemberKey,
  type OpenCodeLogicalMemberIdentity,
} from './OpenCodeLogicalMemberKey.js'

type SessionStoreShape = {
  schemaVersion: 2
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

export type OpenCodeSessionPublicationResult =
  | { status: 'inserted' | 'exact'; record: OpenCodeSessionRecord }
  | { status: 'conflict'; record: OpenCodeSessionRecord }

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
  record: Pick<OpenCodeSessionRecord, 'teamId' | 'laneId' | 'memberName' | 'projectPath'>,
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

  private async readStore(): Promise<SessionStoreShape> {
    if (!(await fileExists(this.filePath))) {
      return {
        schemaVersion: 2,
        records: {},
        reservations: {},
      }
    }

    const content = await readFile(this.filePath, 'utf8')
    const parsed = JSON.parse(content) as SessionStoreShape | { schemaVersion: 1;
      records: Record<string, OpenCodeSessionRecord> }
    if (![1, 2].includes(parsed.schemaVersion) || typeof parsed.records !== 'object' || parsed.records === null) {
      throw new Error('invalid OpenCode session store')
    }
    const records: Record<string, OpenCodeSessionRecord> = {}
    for (const record of Object.values(parsed.records)) {
      if (!record || typeof record !== 'object') throw new Error('invalid OpenCode session record')
      const key = buildRecordKey(record)
      if (records[key] && jsonStringify(records[key]) !== jsonStringify(record)) {
        throw new Error('conflicting normalized OpenCode session records')
      }
      records[key] = record
    }
    if (parsed.schemaVersion === 2 && (typeof parsed.reservations !== 'object'
      || parsed.reservations === null || Array.isArray(parsed.reservations))) {
      throw new Error('invalid OpenCode session reservations')
    }
    const reservations = parsed.schemaVersion === 2 ? parsed.reservations : {}
    for (const [key, reservation] of Object.entries(reservations)) {
      validateReservation(key, reservation)
    }
    return { schemaVersion: 2, records, reservations }
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
    return Object.values(store.records).find(record =>
      sameLookupIdentity(record, teamId, laneId, normalizedMemberName)) ?? null
  }

  async upsert(record: OpenCodeSessionRecord): Promise<UpsertResult> {
    return this.withStoreLock(async () => {
      const store = await this.readStore()
      const key = buildRecordKey(record)
      const previous = store.records[key]

      const logicalKey = logicalKeyForRecord(record)
      const reservation = store.reservations[logicalKey]
      if (!previous && reservation) {
        throw new Error('OpenCode logical member requires its durable reservation authority')
      }

      if (previous && jsonStringify(previous) === jsonStringify(record)) {
        return 'unchanged'
      }

      store.records[key] = record
      await this.writeStore(store)
      return previous ? 'updated' : 'created'
    })
  }

  /** Atomic launch projection: never replaces a different session owner. */
  async publishIfAbsentOrExact(record: OpenCodeSessionRecord): Promise<OpenCodeSessionPublicationResult> {
    return this.withStoreLock(async () => {
      const store = await this.readStore()
      const key = buildRecordKey(record)
      const logicalKey = openCodeLogicalMemberKey({
        teamId: record.teamId,
        laneId: record.laneId ?? 'primary',
        projectIdentity: record.projectPath,
        memberName: record.memberName,
      })
      const reservation = store.reservations[logicalKey]
      if (reservation) {
        const reservedRecord = Object.values(store.records).find(candidate =>
          logicalKeyForRecord(candidate) === logicalKey)
        return { status: 'conflict', record: reservedRecord ?? record }
      }
      const existing = Object.values(store.records).find(candidate =>
        openCodeLogicalMemberKey({
          teamId: candidate.teamId,
          laneId: candidate.laneId ?? 'primary',
          projectIdentity: candidate.projectPath,
          memberName: candidate.memberName,
        }) === logicalKey,
      ) ?? store.records[key]
      if (existing) {
        return jsonStringify(existing) === jsonStringify(record)
          ? { status: 'exact', record: existing }
          : { status: 'conflict', record: existing }
      }
      store.records[key] = record
      await this.writeStore(store)
      return { status: 'inserted', record }
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
    const normalized = normalizeOpenCodeLogicalMemberIdentity(logicalMember)
    const logicalMemberKey = openCodeLogicalMemberKey(normalized)
    return this.withStoreLock(async () => {
      const store = await this.readStore()
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
    return this.withStoreLock(async () => {
      const store = await this.readStore()
      const logicalKey = logicalKeyForRecord(record)
      const reservation = store.reservations[logicalKey]
      const existing = Object.values(store.records).find(candidate => logicalKeyForRecord(candidate) === logicalKey)
      if (!reservation || reservation.reservationIdentity !== reservationIdentity
        || reservation.expectedOpencodeSessionId !== record.opencodeSessionId) {
        return { status: 'conflict', record: existing ?? record }
      }
      if (existing && jsonStringify(existing) !== jsonStringify(record)) {
        return { status: 'conflict', record: existing }
      }
      if (!existing) store.records[buildRecordKey(record)] = record
      delete store.reservations[logicalKey]
      await this.writeStore(store)
      return { status: existing ? 'exact' : 'inserted', record: existing ?? record }
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
      const store = await this.readStore()
      const previous = recordsForLegacyLookup(store, teamId, laneId, memberName)[0]
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

  async markStaleIfSessionMatches(
    teamId: string,
    laneId: string,
    memberName: string,
    expectedOpencodeSessionId: string,
    staleReason: string,
  ): Promise<ConditionalMarkStaleResult> {
    return this.withStoreLock(async () => {
      const store = await this.readStore()
      const candidates = recordsForLegacyLookup(store, teamId, laneId, memberName)
      const previous = candidates.find(record =>
        record.opencodeSessionId === expectedOpencodeSessionId)
      if (!previous && candidates.length === 0) {
        return { status: 'absent' }
      }

      if (!previous) {
        return { status: 'foreign', record: candidates[0]! }
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

  async delete(teamId: string, laneIdOrMemberName: string, memberName?: string): Promise<boolean> {
    const laneId = memberName ? laneIdOrMemberName : 'primary'
    const normalizedMemberName = memberName ?? laneIdOrMemberName
    return this.withStoreLock(async () => {
      const store = await this.readStore()
      const previous = recordsForLegacyLookup(store, teamId, laneId, normalizedMemberName)[0]
      if (!previous) {
        return false
      }

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
      const store = await this.readStore()
      const candidates = recordsForLegacyLookup(store, teamId, laneId, memberName)
      const previous = candidates.find(record =>
        record.opencodeSessionId === expectedOpencodeSessionId)
      if (!previous && candidates.length === 0) {
        return { status: 'absent' }
      }

      if (!previous) {
        return { status: 'foreign', record: candidates[0]! }
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
    projectIdentity: record.projectPath, memberName: record.memberName })
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
    || typeof reservation.createdAt !== 'string') {
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
