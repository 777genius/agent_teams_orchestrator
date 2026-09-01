import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

import * as lockfile from '../../utils/lockfile.js'
import { writeJsonFileAtomic } from '../../utils/atomicWrite.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { resolveClaudeMultimodelPaths } from './OpenCodeManagedPaths.js'

import type { OpenCodeSessionRecord, OpenCodeSessionStopAuthority } from './types.js'

type SessionStoreShape = {
  schemaVersion: 1
  records: Record<string, OpenCodeSessionRecord>
  materializationClaims?: Record<string, string>
  materializationOwners?: Record<string, { attemptId: string; sessionId: string }>
}

type UpsertResult = 'created' | 'updated' | 'unchanged'
export type MaterializationClaimResult =
  | { kind: 'claimed' }
  | { kind: 'already_owned' }
  | { kind: 'existing'; record: OpenCodeSessionRecord }
  | { kind: 'owned_by_other' }

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

export function isOpenCodeSessionStopped(record: Pick<OpenCodeSessionRecord, 'stoppedAt'>): boolean {
  const value = record.stoppedAt
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value
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
      if (store.materializationClaims?.[key]) {
        throw new Error('OpenCode session write is fenced by a materialization claim')
      }
      if (previous && jsonStringify(previous) === jsonStringify(record)) return 'unchanged'
      if (previous && isOpenCodeSessionStopped(previous)) {
        throw new Error('OpenCode stopped session can only be replaced by a new launch claim')
      }
      if (previous?.profileScope?.purpose === 'launch_runtime'
        && (previous.runId !== record.runId || previous.opencodeSessionId !== record.opencodeSessionId)) {
        throw new Error('OpenCode session write does not match the committed run and session')
      }

      store.records[key] = record
      await this.writeStore(store)
      return previous ? 'updated' : 'created'
    })
  }

  async claimMaterialization(
    identity: Pick<OpenCodeSessionRecord, 'teamId' | 'laneId' | 'memberName'>,
    attemptId: string,
    requestedRunId?: string,
  ): Promise<MaterializationClaimResult> {
    return this.withStoreLock(async () => {
      const store = await this.readStore()
      const key = buildRecordKey(identity)
      const existing = store.records[key]
      const replacingStopped = existing && isOpenCodeSessionStopped(existing)
        && existing.runId && requestedRunId?.trim() && requestedRunId !== existing.runId
      if (existing && !replacingStopped) return { kind: 'existing', record: existing }
      store.materializationClaims ??= {}
      const owner = store.materializationClaims[key]
      if (owner && owner !== attemptId) return { kind: 'owned_by_other' }
      if (owner === attemptId) return { kind: 'already_owned' }
      if (replacingStopped) {
        delete store.records[key]
        if (store.materializationOwners?.[key]?.sessionId === existing.opencodeSessionId) {
          delete store.materializationOwners[key]
        }
      }
      store.materializationClaims[key] = attemptId
      await this.writeStore(store)
      return { kind: 'claimed' }
    })
  }

  async commitMaterialization(record: OpenCodeSessionRecord, attemptId: string): Promise<boolean> {
    return this.withStoreLock(async () => {
      const store = await this.readStore()
      const key = buildRecordKey(record)
      if (store.materializationClaims?.[key] !== attemptId || store.records[key]) return false
      store.records[key] = record
      delete store.materializationClaims[key]
      store.materializationOwners ??= {}
      store.materializationOwners[key] = { attemptId, sessionId: record.opencodeSessionId }
      await this.writeStore(store)
      return true
    })
  }

  async releaseMaterializationClaim(
    identity: Pick<OpenCodeSessionRecord, 'teamId' | 'laneId' | 'memberName'>,
    attemptId: string,
  ): Promise<boolean> {
    return this.withStoreLock(async () => {
      const store = await this.readStore()
      const key = buildRecordKey(identity)
      if (store.materializationClaims?.[key] !== attemptId) return false
      delete store.materializationClaims[key]
      await this.writeStore(store)
      return true
    })
  }

  async markStoppedIfSession(
    record: Pick<OpenCodeSessionRecord, 'teamId' | 'laneId' | 'memberName' | 'opencodeSessionId' | 'runId'>,
    stopAuthority?: OpenCodeSessionStopAuthority,
  ): Promise<OpenCodeSessionRecord | null> {
    return this.withStoreLock(async () => {
      const store = await this.readStore()
      const key = buildRecordKey(record)
      const previous = store.records[key]
      if (!previous || previous.opencodeSessionId !== record.opencodeSessionId
        || previous.runId !== record.runId) return null
      if (isOpenCodeSessionStopped(previous)) {
        if (stopAuthority && jsonStringify(previous.stopAuthority) !== jsonStringify(stopAuthority)) return null
        return previous
      }
      const stoppedAt = new Date().toISOString()
      const next = { ...previous, stoppedAt, ...(stopAuthority ? { stopAuthority } : {}), updatedAt: stoppedAt }
      store.records[key] = next
      await this.writeStore(store)
      return next
    })
  }

  async markStaleIfSession(
    record: Pick<OpenCodeSessionRecord, 'teamId' | 'laneId' | 'memberName' | 'opencodeSessionId' | 'runId'>,
    staleReason: string,
    attemptId?: string,
  ): Promise<OpenCodeSessionRecord | null> {
    return this.withStoreLock(async () => {
      const store = await this.readStore()
      const key = buildRecordKey(record)
      const previous = store.records[key]
      if (!previous || previous.opencodeSessionId !== record.opencodeSessionId
        || previous.runId !== record.runId || isOpenCodeSessionStopped(previous)) return null
      const owner = store.materializationOwners?.[key]
      if (attemptId && (owner?.attemptId !== attemptId || owner.sessionId !== record.opencodeSessionId)) {
        return null
      }
      const next = { ...previous, staleReason, updatedAt: new Date().toISOString() }
      store.records[key] = next
      await this.writeStore(store)
      return next
    })
  }

  async deleteIfSession(
    record: Pick<OpenCodeSessionRecord, 'teamId' | 'laneId' | 'memberName' | 'opencodeSessionId' | 'runId'>,
    attemptId?: string,
  ): Promise<boolean> {
    return this.withStoreLock(async () => {
      const store = await this.readStore()
      const key = buildRecordKey(record)
      const previous = store.records[key]
      if (!previous || previous.opencodeSessionId !== record.opencodeSessionId
        || previous.runId !== record.runId || isOpenCodeSessionStopped(previous)) return false
      const owner = store.materializationOwners?.[key]
      if (attemptId && (owner?.attemptId !== attemptId || owner.sessionId !== record.opencodeSessionId)) {
        return false
      }
      delete store.records[key]
      if (store.materializationOwners) delete store.materializationOwners[key]
      await this.writeStore(store)
      return true
    })
  }

  async releaseMaterializationOwner(
    record: Pick<OpenCodeSessionRecord, 'teamId' | 'laneId' | 'memberName' | 'opencodeSessionId'>,
    attemptId: string,
  ): Promise<boolean> {
    return this.withStoreLock(async () => {
      const store = await this.readStore()
      const key = buildRecordKey(record)
      const owner = store.materializationOwners?.[key]
      if (owner?.attemptId !== attemptId || owner.sessionId !== record.opencodeSessionId) return false
      delete store.materializationOwners[key]
      await this.writeStore(store)
      return true
    })
  }

  async markStale(
    teamId: string,
    laneIdOrMemberName: string,
    memberNameOrStaleReason: string,
    staleReasonMaybe?: string,
    expectedIdentity?: Pick<OpenCodeSessionRecord, 'runId' | 'opencodeSessionId'>,
  ): Promise<OpenCodeSessionRecord | null> {
    const laneId = staleReasonMaybe ? laneIdOrMemberName : 'primary'
    const memberName = staleReasonMaybe ? memberNameOrStaleReason : laneIdOrMemberName
    const staleReason = staleReasonMaybe ?? memberNameOrStaleReason
    return this.withStoreLock(async () => {
      const store = await this.readStore()
      const key = buildRecordKey({ teamId, laneId, memberName })
      const previous = store.records[key]
      if (!previous || isOpenCodeSessionStopped(previous)
        || (expectedIdentity && (previous.runId !== expectedIdentity.runId
          || previous.opencodeSessionId !== expectedIdentity.opencodeSessionId))) return null

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
}

export const openCodeSessionStore = new OpenCodeSessionStore()
