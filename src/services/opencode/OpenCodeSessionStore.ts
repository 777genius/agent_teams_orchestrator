import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

import * as lockfile from '../../utils/lockfile.js'
import { writeJsonFileAtomic } from '../../utils/atomicWrite.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { resolveClaudeMultimodelPaths } from './OpenCodeManagedPaths.js'
import { throwOpenCodeAbortReason } from './OpenCodeRuntimeDeadline.js'

import type { OpenCodeSessionRecord, OpenCodeSessionStopAuthority } from './types.js'

type SessionStoreShape = {
  schemaVersion: 1
  records: Record<string, OpenCodeSessionRecord>
  materializationClaims?: Record<string, string>
  materializationClaimRuns?: Record<string, string>
  materializationOwners?: Record<string, { attemptId: string; sessionId: string }>
}

type UpsertResult = 'created' | 'updated' | 'unchanged'
export type MaterializationClaimResult =
  | { kind: 'claimed' }
  | { kind: 'already_owned' }
  | { kind: 'existing'; record: OpenCodeSessionRecord }
  | { kind: 'owned_by_other' }

const LOCK_RETRY_OPTIONS = {
  retries: 30,
  minTimeout: 5,
  maxTimeout: 100,
}
const LOCK_OPTIONS = {
  retries: LOCK_RETRY_OPTIONS,
}

type OpenCodeSessionStoreDeps = {
  lock?: typeof lockfile.lock
  setTimer?: typeof setTimeout
  clearTimer?: typeof clearTimeout
  onLateLockReleaseError?: (error: unknown) => void
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

function isLockContention(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === 'object'
    && 'code' in error
    && error.code === 'ELOCKED',
  )
}

async function waitForLockRetry(
  timeoutMs: number,
  signal: AbortSignal,
  setTimer: typeof setTimeout,
  clearTimer: typeof clearTimeout,
): Promise<void> {
  if (signal.aborted) throwOpenCodeAbortReason(signal)

  await new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      clearTimer(timer)
      signal.removeEventListener('abort', onAbort)
      callback()
    }
    const onAbort = () => finish(() => {
      try {
        throwOpenCodeAbortReason(signal)
      } catch (error) {
        reject(error)
      }
    })
    const timer = setTimer(() => finish(resolve), timeoutMs)
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
}

async function waitForLockAttempt(
  attempt: Promise<() => Promise<void>>,
  signal: AbortSignal,
  trackLateLockRelease: (attempt: Promise<() => Promise<void>>) => void,
): Promise<() => Promise<void>> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      callback()
    }
    const onAbort = () => finish(() => {
      trackLateLockRelease(attempt)
      try {
        throwOpenCodeAbortReason(signal)
      } catch (error) {
        reject(error)
      }
    })

    signal.addEventListener('abort', onAbort, { once: true })
    void attempt.then(
      release => {
        if (settled) {
          return
        }
        finish(() => resolve(release))
      },
      error => finish(() => reject(error)),
    )
    if (signal.aborted) onAbort()
  })
}

export class OpenCodeSessionStore {
  private readonly filePath: string
  private readonly lockPath: string
  private readonly lock: typeof lockfile.lock
  private readonly setTimer: typeof setTimeout
  private readonly clearTimer: typeof clearTimeout
  private readonly onLateLockReleaseError: (error: unknown) => void
  private readonly pendingLateLockReleases = new Set<Promise<void>>()

  constructor(filePath?: string, deps: OpenCodeSessionStoreDeps = {}) {
    const paths = resolveClaudeMultimodelPaths()
    this.filePath = filePath ?? path.join(paths.data, 'opencode', 'session-store.json')
    this.lockPath = `${this.filePath}.lock`
    this.lock = deps.lock ?? lockfile.lock
    this.setTimer = deps.setTimer ?? setTimeout
    this.clearTimer = deps.clearTimer ?? clearTimeout
    this.onLateLockReleaseError = deps.onLateLockReleaseError ?? (error => {
      console.warn('[OpenCodeSessionStore] Late lock release failed after cancellation', error)
    })
  }

  private async ensureParentDir(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true })
  }

  private async ensureLockFile(): Promise<void> {
    await this.ensureParentDir()
    await writeFile(this.lockPath, '', { flag: 'a' })
  }

  private trackLateLockRelease(attempt: Promise<() => Promise<void>>): void {
    const pendingRelease = attempt.then(
      release => release(),
      () => undefined,
    )
    this.pendingLateLockReleases.add(pendingRelease)
    void pendingRelease.then(
      () => this.pendingLateLockReleases.delete(pendingRelease),
      error => {
        this.pendingLateLockReleases.delete(pendingRelease)
        this.onLateLockReleaseError(error)
      },
    )
  }

  async drainPendingLateLockReleases(): Promise<void> {
    while (this.pendingLateLockReleases.size > 0) {
      await Promise.allSettled([...this.pendingLateLockReleases])
    }
  }

  private async acquireStoreLock(signal?: AbortSignal): Promise<() => Promise<void>> {
    if (!signal) {
      return this.lock(this.lockPath, LOCK_OPTIONS)
    }

    let retryDelayMs = LOCK_RETRY_OPTIONS.minTimeout
    for (let attempt = 0; ; attempt += 1) {
      if (signal.aborted) throwOpenCodeAbortReason(signal)
      let release: (() => Promise<void>) | undefined
      try {
        release = await waitForLockAttempt(
          this.lock(this.lockPath, { ...LOCK_OPTIONS, retries: 0 }),
          signal,
          attempt => this.trackLateLockRelease(attempt),
        )
      } catch (error) {
        if (isLockContention(error) && signal.aborted) {
          throwOpenCodeAbortReason(signal)
        }
        if (!isLockContention(error) || attempt >= LOCK_RETRY_OPTIONS.retries) {
          throw error
        }
        await waitForLockRetry(
          retryDelayMs,
          signal,
          this.setTimer,
          this.clearTimer,
        )
        retryDelayMs = Math.min(LOCK_RETRY_OPTIONS.maxTimeout, retryDelayMs * 2)
        continue
      }
      if (signal.aborted) {
        await release()
        throwOpenCodeAbortReason(signal)
      }
      return release
    }
  }

  private async withStoreLock<T>(
    callback: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) throwOpenCodeAbortReason(signal)
    await this.ensureLockFile()

    let release: (() => Promise<void>) | undefined
    try {
      release = await this.acquireStoreLock(signal)
      if (signal?.aborted) throwOpenCodeAbortReason(signal)
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
    signal?: AbortSignal,
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
      const normalizedRunId = requestedRunId?.trim() || undefined
      const ownerRunId = store.materializationClaimRuns?.[key]
      if (owner === attemptId) {
        return ownerRunId && normalizedRunId && ownerRunId !== normalizedRunId
          ? { kind: 'owned_by_other' }
          : { kind: 'already_owned' }
      }
      store.materializationClaims[key] = attemptId
      if (normalizedRunId) {
        store.materializationClaimRuns ??= {}
        store.materializationClaimRuns[key] = normalizedRunId
      }
      await this.writeStore(store)
      return { kind: 'claimed' }
    }, signal)
  }

  async commitMaterialization(
    record: OpenCodeSessionRecord,
    attemptId: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    return this.withStoreLock(async () => {
      const store = await this.readStore()
      const key = buildRecordKey(record)
      if (store.materializationClaims?.[key] !== attemptId) {
        const existing = store.records[key]
        const owner = store.materializationOwners?.[key]
        return Boolean(
          existing
          && owner?.attemptId === attemptId
          && owner.sessionId === record.opencodeSessionId
          && jsonStringify(existing) === jsonStringify(record),
        )
      }
      const claimedRunId = store.materializationClaimRuns?.[key]
      if (claimedRunId && claimedRunId !== record.runId?.trim()) return false
      const previous = store.records[key]
      const replacingStopped = Boolean(previous && isOpenCodeSessionStopped(previous)
        && record.runId?.trim() && record.runId !== previous.runId && !record.stoppedAt)
      if (previous && !replacingStopped) return false
      store.records[key] = record
      delete store.materializationClaims[key]
      if (store.materializationClaimRuns) delete store.materializationClaimRuns[key]
      store.materializationOwners ??= {}
      store.materializationOwners[key] = { attemptId, sessionId: record.opencodeSessionId }
      await this.writeStore(store)
      return true
    }, signal)
  }

  async releaseMaterializationClaim(
    identity: Pick<OpenCodeSessionRecord, 'teamId' | 'laneId' | 'memberName'>,
    attemptId: string,
    requestedRunId?: string,
  ): Promise<boolean> {
    return this.withStoreLock(async () => {
      const store = await this.readStore()
      const key = buildRecordKey(identity)
      if (store.materializationClaims?.[key] !== attemptId) return false
      const claimedRunId = store.materializationClaimRuns?.[key]
      if (claimedRunId && requestedRunId?.trim() && claimedRunId !== requestedRunId.trim()) {
        return false
      }
      delete store.materializationClaims[key]
      if (store.materializationClaimRuns) delete store.materializationClaimRuns[key]
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
