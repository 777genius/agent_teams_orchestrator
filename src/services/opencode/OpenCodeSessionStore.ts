import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

import * as lockfile from '../../utils/lockfile.js'
import { writeJsonFileAtomic } from '../../utils/atomicWrite.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { resolveClaudeMultimodelPaths } from './OpenCodeManagedPaths.js'

import type { OpenCodeSessionRecord } from './types.js'
import { openCodeLogicalMemberKey } from './OpenCodeLogicalMemberKey.js'

type SessionStoreShape = {
  schemaVersion: 1
  records: Record<string, OpenCodeSessionRecord>
}

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

function buildRecordKey(record: Pick<OpenCodeSessionRecord, 'teamId' | 'laneId' | 'memberName'>): string {
  return `${record.teamId}::${record.laneId ?? 'primary'}::${record.memberName}`
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
        schemaVersion: 1,
        records: {},
      }
    }

    const content = await readFile(this.filePath, 'utf8')
    const parsed = JSON.parse(content) as SessionStoreShape
    if (parsed.schemaVersion !== 1 || typeof parsed.records !== 'object' || parsed.records === null) {
      return {
        schemaVersion: 1,
        records: {},
      }
    }

    return parsed
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
    return store.records[buildRecordKey({ teamId, laneId, memberName: normalizedMemberName })] ?? null
  }

  async upsert(record: OpenCodeSessionRecord): Promise<UpsertResult> {
    return this.withStoreLock(async () => {
      const store = await this.readStore()
      const key = buildRecordKey(record)
      const previous = store.records[key]

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
      const key = buildRecordKey({ teamId, laneId, memberName })
      const previous = store.records[key]
      if (!previous) {
        return null
      }

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
      const key = buildRecordKey({ teamId, laneId, memberName })
      const previous = store.records[key]
      if (!previous) {
        return { status: 'absent' }
      }

      if (previous.opencodeSessionId !== expectedOpencodeSessionId) {
        return { status: 'foreign', record: previous }
      }

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
      const key = buildRecordKey({ teamId, laneId, memberName: normalizedMemberName })
      if (!store.records[key]) {
        return false
      }

      delete store.records[key]
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
      const key = buildRecordKey({ teamId, laneId, memberName })
      const previous = store.records[key]
      if (!previous) {
        return { status: 'absent' }
      }

      if (previous.opencodeSessionId !== expectedOpencodeSessionId) {
        return { status: 'foreign', record: previous }
      }

      delete store.records[key]
      await this.writeStore(store)
      return { status: 'applied', record: previous }
    })
  }
}

export const openCodeSessionStore = new OpenCodeSessionStore()
