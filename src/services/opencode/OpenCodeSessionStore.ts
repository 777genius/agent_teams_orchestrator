import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import * as lockfile from '../../utils/lockfile.js'
import { writeJsonFileAtomic } from '../../utils/atomicWrite.js'
import { isProcessAlive, readProcessStartTimeMs } from '../../utils/processKill.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { resolveClaudeMultimodelPaths } from './OpenCodeManagedPaths.js'
import { throwOpenCodeAbortReason } from './OpenCodeRuntimeDeadline.js'

import {
  matchesStopTarget, parseOpenCodeStopRequest, sameStopRequest, stopBinding,
  stopRequestKey, stopSessionSetToken, validateStopData, validateStopReceipt,
  type OpenCodeStopRequest, type OpenCodeStopReceipt, type OpenCodeStopOutcome,
  type OpenCodeStopReconciliation, type OpenCodeStopData,
} from './OpenCodeStopRecovery.js'

import type { OpenCodeSessionRecord, OpenCodeSessionStopAuthority } from './types.js'

type SessionStoreShape = {
  schemaVersion: 1
  records: Record<string, OpenCodeSessionRecord>
  stopReceipts?: Record<string, OpenCodeStopReceipt>
  materializationClaims?: Record<string, string>
  materializationClaimRuns?: Record<string, string>
  materializationOwners?: Record<string, MaterializationOwnerToken>
  materializationOwnerVersions?: Record<string, number>
  materializationOwnerProcesses?: Record<string, MaterializationOwnerProcessIdentity>
}

type UpsertResult = 'created' | 'updated' | 'unchanged'
const MAX_EFFECT_STORE_BYTES = 16 * 1024 * 1024
type LegacyMaterializationOwnerToken = Omit<MaterializationOwnerToken, 'version'>
export type MaterializationClaimResult =
  | { kind: 'claimed'; ownerToken: MaterializationOwnerToken }
  | { kind: 'already_owned' }
  | { kind: 'existing'; record: OpenCodeSessionRecord; ownerToken?: MaterializationOwnerToken | null }
  | { kind: 'owned_by_other' }

export type MaterializationOwnerToken = {
  attemptId: string
  sessionId: string
  version: number
}

type MaterializationOwnerProcessIdentity = {
  pid: number
  startedAtMs: number | null
}

function isMaterializationOwnerToken(value: unknown): value is MaterializationOwnerToken {
  if (!value || typeof value !== 'object') return false
  const token = value as Partial<MaterializationOwnerToken>
  return typeof token.attemptId === 'string' && typeof token.sessionId === 'string'
    && Number.isSafeInteger(token.version) && token.version > 0
}

function isLegacyMaterializationOwnerToken(
  value: unknown,
): value is LegacyMaterializationOwnerToken {
  if (!value || typeof value !== 'object') return false
  const token = value as Partial<LegacyMaterializationOwnerToken>
  return typeof token.attemptId === 'string' && typeof token.sessionId === 'string'
}

function normalizeMaterializationOwners(store: SessionStoreShape): SessionStoreShape {
  if (!store.materializationOwners) return store
  const owners = store.materializationOwners as Record<string, unknown>
  store.materializationOwnerVersions ??= {}
  for (const [key, value] of Object.entries(owners)) {
    const highWatermark = store.materializationOwnerVersions[key]
    const currentVersion = typeof highWatermark === 'number'
      && Number.isSafeInteger(highWatermark) && highWatermark > 0
      ? highWatermark
      : 0
    if (isMaterializationOwnerToken(value)) {
      store.materializationOwnerVersions[key] = Math.max(currentVersion, value.version)
    } else if (isLegacyMaterializationOwnerToken(value)) {
      const version = currentVersion + 1
      owners[key] = { ...value, version }
      store.materializationOwnerVersions[key] = version
    } else {
      delete owners[key]
    }
  }
  return store
}

function ownerTokensEqual(left: unknown, right: unknown): boolean {
  return isMaterializationOwnerToken(left) && isMaterializationOwnerToken(right)
    && left.attemptId === right.attemptId
    && left.sessionId === right.sessionId
    && left.version === right.version
}

function ownerTokenAuthorizes(owner: unknown, supplied: unknown): boolean {
  return owner === undefined
    ? supplied === undefined
    : ownerTokensEqual(owner, supplied)
}

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
  ownerPid?: number
  isProcessAlive?: typeof isProcessAlive
  readProcessStartTimeMs?: typeof readProcessStartTimeMs
}

function isMaterializationOwnerProcessIdentity(
  value: unknown,
): value is MaterializationOwnerProcessIdentity {
  if (!value || typeof value !== 'object') return false
  const identity = value as Partial<MaterializationOwnerProcessIdentity>
  return Number.isSafeInteger(identity.pid) && Number(identity.pid) > 0
    && (identity.startedAtMs === null
      || (typeof identity.startedAtMs === 'number' && Number.isFinite(identity.startedAtMs)))
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

function canReplaceOwnerlessSessionWithStrictRun(
  record: OpenCodeSessionRecord,
  requestedRunId: string | undefined,
  materializationOwner: unknown,
): boolean {
  const nextRunId = requestedRunId?.trim()
  if (isOpenCodeSessionStopped(record) || !nextRunId || materializationOwner !== undefined) {
    return false
  }

  const staleLegacySession = !record.runId?.trim()
    && record.profileScope?.purpose !== 'launch_runtime'
    && typeof record.staleReason === 'string'
    && record.staleReason.length > 0
    && record.staleReason !== 'launch_failed'
  const failedPriorStrictRun = isDifferentFailedStrictRun(record, nextRunId)

  return staleLegacySession || failedPriorStrictRun
}

function isDifferentFailedStrictRun(
  record: OpenCodeSessionRecord,
  requestedRunId: string | undefined,
): boolean {
  const nextRunId = requestedRunId?.trim()
  return Boolean(nextRunId)
    && record.profileScope?.purpose === 'launch_runtime'
    && record.staleReason === 'launch_failed'
    && Boolean(record.runId?.trim())
    && record.runId !== nextRunId
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
  private readonly ownerPid: number
  private readonly isProcessAlive: typeof isProcessAlive
  private readonly readProcessStartTimeMs: typeof readProcessStartTimeMs
  private ownerProcessIdentityPromise?: Promise<MaterializationOwnerProcessIdentity | null>
  private readonly pendingLateLockReleases = new Set<Promise<void>>()
  private readonly pendingMaterializationReconciliations = new Set<Promise<unknown>>()

  constructor(filePath?: string, deps: OpenCodeSessionStoreDeps = {}) {
    const paths = resolveClaudeMultimodelPaths()
    this.filePath = filePath ?? path.join(paths.data, 'opencode', 'session-store.json')
    this.lockPath = `${this.filePath}.lock`
    this.lock = deps.lock ?? lockfile.lock
    this.setTimer = deps.setTimer ?? setTimeout
    this.clearTimer = deps.clearTimer ?? clearTimeout
    this.ownerPid = deps.ownerPid ?? process.pid
    this.isProcessAlive = deps.isProcessAlive ?? isProcessAlive
    this.readProcessStartTimeMs = deps.readProcessStartTimeMs ?? readProcessStartTimeMs
    this.onLateLockReleaseError = deps.onLateLockReleaseError ?? (error => {
      console.warn('[OpenCodeSessionStore] Late lock release failed after cancellation', error)
    })
  }

  private currentOwnerProcessIdentity(): Promise<MaterializationOwnerProcessIdentity | null> {
    this.ownerProcessIdentityPromise ??= (async () => {
      if (!this.isProcessAlive(this.ownerPid)) return null
      const startedAtMs = await this.readProcessStartTimeMs(this.ownerPid).catch(() => null)
      if (!this.isProcessAlive(this.ownerPid)) return null
      return { pid: this.ownerPid, startedAtMs }
    })()
    return this.ownerProcessIdentityPromise
  }

  private async materializationOwnerIsActive(identity: unknown): Promise<boolean> {
    // Missing or unreadable process identity is not proof that an owner died.
    if (!isMaterializationOwnerProcessIdentity(identity)) return true
    if (!this.isProcessAlive(identity.pid)) return false
    // A persisted null start time means the original identity is unknown. PID
    // liveness is the only safe signal; a later successful read must not turn
    // this into a false PID-reuse conclusion.
    if (identity.startedAtMs === null) return true
    const startedAtMs = await this.readProcessStartTimeMs(identity.pid).catch(() => null)
    if (!Number.isFinite(startedAtMs) || startedAtMs === null) return true
    if (!this.isProcessAlive(identity.pid)) return false
    return startedAtMs === identity.startedAtMs
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
    while (this.pendingLateLockReleases.size > 0
      || this.pendingMaterializationReconciliations.size > 0) {
      await Promise.allSettled([
        ...this.pendingLateLockReleases,
        ...this.pendingMaterializationReconciliations,
      ])
    }
  }

  trackPendingMaterializationReconciliation<T>(operation: Promise<T>): Promise<T> {
    this.pendingMaterializationReconciliations.add(operation)
    void operation.then(
      () => this.pendingMaterializationReconciliations.delete(operation),
      () => this.pendingMaterializationReconciliations.delete(operation),
    )
    return operation
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

  private async readStore(preserveMaterializationFences = false): Promise<SessionStoreShape> {
    const exists = preserveMaterializationFences
      ? await stat(this.filePath).then(() => true, error => {
        if (error.code === 'ENOENT') return false
        throw error
      })
      : await fileExists(this.filePath)
    if (!exists) {
      return {
        schemaVersion: 1,
        records: {},
      }
    }

    const content = await readFile(this.filePath, 'utf8')
    const parsed = JSON.parse(content) as SessionStoreShape
    if (!parsed || parsed.schemaVersion !== 1 || typeof parsed.records !== 'object' || parsed.records === null || Array.isArray(parsed.records)) {
      if (preserveMaterializationFences) throw new Error('Invalid OpenCode session store authority')
      return {
        schemaVersion: 1,
        records: {},
      }
    }

    return preserveMaterializationFences ? parsed : normalizeMaterializationOwners(parsed)
  }

  private async writeStore(store: SessionStoreShape): Promise<void> {
    await writeJsonFileAtomic(this.filePath, store, { indent: 2 })
  }

  private stopLane(store: SessionStoreShape, request: OpenCodeStopRequest): OpenCodeSessionRecord[] {
    return Object.values(store.records).filter(record => record.teamId === request.target.teamId
      && (record.laneId ?? 'primary') === request.target.laneId
      && (record.runId === request.target.runId || !isOpenCodeSessionStopped(record)
        || request.target.members.some(member => member.memberName === record.memberName)))
  }

  private stopOutcome(store: SessionStoreShape, request: OpenCodeStopRequest): OpenCodeStopOutcome {
    if (store.stopReceipts !== undefined) {
      if (!store.stopReceipts || typeof store.stopReceipts !== 'object' || Array.isArray(store.stopReceipts)) {
        throw new Error('Corrupt Stop receipt map')
      }
      for (const [key, value] of Object.entries(store.stopReceipts)) {
        const item = validateStopReceipt(value)
        if (stopRequestKey(item.request) !== key) throw new Error('Corrupt Stop receipt index')
      }
    }
    const receipt = store.stopReceipts?.[stopRequestKey(request)]
    if (!receipt) {
      // Reusing the deterministic key with a different request is also a mismatch.
      return { status: Object.values(store.stopReceipts ?? {}).some(item =>
        item.request.idempotencyKey === request.idempotencyKey) ? 'target_mismatch' : 'unknown' }
    }
    if (!sameStopRequest(receipt.request, request)) return { status: 'target_mismatch' }
    if (receipt.status === 'completed') {
      return { status: 'completed', receipt: { ...receipt, data: validateStopData(receipt.data, request) } }
    }
    if (receipt.status !== 'inflight') throw new Error('Corrupt Stop receipt status')
    return { status: 'inflight' }
  }

  async lookupStop(input: OpenCodeStopRequest, signal?: AbortSignal): Promise<OpenCodeStopOutcome> {
    const request = parseOpenCodeStopRequest(input)
    return this.withStoreLock(async () => this.stopOutcome(await this.readStore(true), request), signal)
  }

  async beginStop(input: OpenCodeStopRequest, runtime: OpenCodeSessionStopAuthority['runtime'],
    signal?: AbortSignal): Promise<OpenCodeStopOutcome | { status: 'started'; records: OpenCodeSessionRecord[] }> {
    const request = parseOpenCodeStopRequest(input)
    const authority = structuredClone(runtime)
    return this.withStoreLock(async () => {
      const store = await this.readStore(true)
      const outcome = this.stopOutcome(store, request)
      if (outcome.status !== 'unknown') return outcome
      const records = this.stopLane(store, request)
      if (authority.capabilitySnapshotId !== request.target.capabilitySnapshotId
        || !matchesStopTarget(records, request.target)) return { status: 'target_mismatch' }
      if (this.stopHasMaterializationFence(store, request)) return { status: 'inflight' }
      const binding = stopBinding(records)
      if (Object.values(store.stopReceipts ?? {}).some(receipt => receipt.status === 'inflight'
        && receipt.request.target.teamId === request.target.teamId
        && receipt.request.target.laneId === request.target.laneId
        // A crash fence belongs to the original generation. It must neither be
        // bypassed with a new key nor poison an independently launched successor.
        && receipt.binding.some(old => binding.some(current =>
          current.memberName === old.memberName && current.sessionId === old.sessionId
          && current.hostKey === old.hostKey && current.createdAt === old.createdAt)))) return { status: 'inflight' }
      store.stopReceipts ??= {}
      store.stopReceipts[stopRequestKey(request)] = validateStopReceipt({
        request, binding, runtime: authority, status: 'inflight',
      })
      // Persist before abort. A failed or interrupted write never authorizes effects.
      await this.writeStore(store)
      return { status: 'started', records }
    }, signal)
  }

  async completeStop(input: OpenCodeStopRequest, value: OpenCodeStopData): Promise<void> {
    const request = parseOpenCodeStopRequest(input)
    const data = validateStopData(value, request)
    // Do not race this atomic write with cancellation after effects.
    await this.withStoreLock(async () => {
      const store = await this.readStore(true)
      const receipt = store.stopReceipts?.[stopRequestKey(request)]
      if (!receipt || !sameStopRequest(validateStopReceipt(receipt).request, request)) throw new Error('Stop receipt identity changed')
      if (receipt.status === 'completed') {
        if (JSON.stringify(validateStopData(receipt.data, request)) !== JSON.stringify(data)) {
          throw new Error('Stop result already completed differently')
        }
        return
      }
      if (receipt.status !== 'inflight') throw new Error('Corrupt Stop receipt status')
      store.stopReceipts![stopRequestKey(request)] = { ...receipt, status: 'completed', data }
      await this.writeStore(store)
    })
  }

  private stopHasMaterializationFence(store: SessionStoreShape, request: OpenCodeStopRequest): boolean {
    const prefix = `${request.target.teamId}::${request.target.laneId}::`
    // A claim can introduce another member not yet present in records.
    return [store.materializationClaims, store.materializationOwners].some(map => map !== undefined
      && (!map || typeof map !== 'object' || Array.isArray(map)
        || Object.keys(map).some(key => key.startsWith(prefix))))
  }

  async reconcileStop(input: OpenCodeStopRequest,
    legacyCapability: () => Promise<string>, signal?: AbortSignal): Promise<OpenCodeStopReconciliation> {
    const request = parseOpenCodeStopRequest(input)
    return this.withStoreLock(async () => {
      const store = await this.readStore(true)
      const target = request.target
      const result = (status: OpenCodeStopReconciliation['status']): OpenCodeStopReconciliation => ({ status, target })
      const outcome = this.stopOutcome(store, request)
      if (outcome.status === 'target_mismatch') return result('target_mismatch')
      const records = this.stopLane(store, request)
      if (!records.length) return result('unknown')
      if (!matchesStopTarget(records, target)) return result('target_mismatch')
      if (this.stopHasMaterializationFence(store, request)) return result('unknown')
      const binding = stopBinding(records)
      const receipt = store.stopReceipts?.[stopRequestKey(request)]
      if (receipt && JSON.stringify(receipt.binding) !== JSON.stringify(binding)) return result('target_mismatch')
      if (records.some(record => !record.stopAuthority) && !receipt) {
        // Legacy capability comes from retained launch evidence, never the caller alone.
        let capability: string
        try { capability = await legacyCapability() } catch { return result('unknown') }
        if (capability !== target.capabilitySnapshotId) return result('target_mismatch')
      }
      if (signal?.aborted) throwOpenCodeAbortReason(signal)
      if (records.some(record => record.staleReason === 'runtime_process_gone')) return result('unknown')
      if (records.some(record => !isOpenCodeSessionStopped(record))) return result('active')
      return { status: 'reconciled_stopped', target, binding, sessionSetToken: stopSessionSetToken(target, binding) }
    }, signal)
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

  /**
   * Produces a monotonic, one-use proof of the exact persisted session image.
   * The synchronous consume step is intentionally suitable for the final
   * provider invocation edge: no promise or event-loop turn separates it from
   * the caller's POST invocation.
   */
  async prepareEffectToken(
    teamId: string,
    laneId: string,
    memberName: string,
    expectedRecord: OpenCodeSessionRecord,
  ): Promise<{ consume(): boolean } | null> {
    const expectedImage = jsonStringify(expectedRecord)
    let fd = -1
    try {
      fd = openSync(this.filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      const opened = fstatSync(fd)
      const linked = lstatSync(this.filePath)
      if (!opened.isFile() || !linked.isFile() || linked.isSymbolicLink() ||
        opened.dev !== linked.dev || opened.ino !== linked.ino ||
        opened.size < 2 || opened.size > MAX_EFFECT_STORE_BYTES ||
        realpathSync(this.filePath) !== path.resolve(this.filePath)) {
        closeSync(fd)
        return null
      }
      const raw = Buffer.alloc(opened.size)
      if (readSync(fd, raw, 0, raw.length, 0) !== raw.length) {
        closeSync(fd)
        return null
      }
      const parsed = JSON.parse(raw.toString('utf8')) as SessionStoreShape
      const record = parsed.schemaVersion === 1
        ? parsed.records?.[buildRecordKey({ teamId, laneId, memberName })]
        : undefined
      if (!record || record.toolApprovalMode !== 'manual' ||
        jsonStringify(record) !== expectedImage) {
        closeSync(fd)
        return null
      }
      const expectedStoreImage = raw.toString('utf8')
      const identity = { dev: opened.dev, ino: opened.ino, size: opened.size }
      const ownedFd = fd
      fd = -1
      let consumed = false
      return {
        consume: () => {
          if (consumed) return false
          consumed = true
          try {
            const current = fstatSync(ownedFd)
            const linkedBefore = lstatSync(this.filePath)
            if (!current.isFile() || !linkedBefore.isFile() || linkedBefore.isSymbolicLink() ||
              current.dev !== identity.dev || current.ino !== identity.ino ||
              linkedBefore.dev !== identity.dev || linkedBefore.ino !== identity.ino ||
              current.size !== identity.size ||
              realpathSync(this.filePath) !== path.resolve(this.filePath)) return false
            const currentRaw = Buffer.alloc(current.size)
            const complete = readSync(ownedFd, currentRaw, 0, currentRaw.length, 0) === currentRaw.length
            const linkedAfter = lstatSync(this.filePath)
            return complete && linkedAfter.isFile() && !linkedAfter.isSymbolicLink() &&
              linkedAfter.dev === identity.dev && linkedAfter.ino === identity.ino &&
              realpathSync(this.filePath) === path.resolve(this.filePath) &&
              currentRaw.toString('utf8') === expectedStoreImage
          } catch {
            return false
          } finally {
            closeSync(ownedFd)
          }
        },
      }
    } catch {
      if (fd >= 0) closeSync(fd)
      return null
    }
  }

  async observeMaterialization(
    identity: Pick<OpenCodeSessionRecord, 'teamId' | 'laneId' | 'memberName'>,
    signal?: AbortSignal,
  ): Promise<{ record: OpenCodeSessionRecord; ownerToken: MaterializationOwnerToken | null } | null> {
    return this.withStoreLock(async () => {
      const store = await this.readStore()
      const key = buildRecordKey(identity)
      const record = store.records[key]
      return record
        ? { record, ownerToken: store.materializationOwners?.[key] ?? null }
        : null
    }, signal)
  }

  async upsert(record: OpenCodeSessionRecord, ownerToken?: MaterializationOwnerToken, expectedRecord?: OpenCodeSessionRecord): Promise<UpsertResult> {
    if (expectedRecord) {
      expectedRecord = structuredClone(expectedRecord)
      record = structuredClone(record)
    }
    return this.withStoreLock(async () => {
      const store = await this.readStore()
      const key = buildRecordKey(record)
      const previous = store.records[key]
      if (expectedRecord) {
        const authority = (value: OpenCodeSessionRecord) => {
          const { updatedAt, lastCanonicalCursor, lastKnownRawStatus, lastKnownDurableState, ...identity } = value
          return identity
        }
        if (!previous || !isDeepStrictEqual(authority(previous), authority(expectedRecord))
          || !isDeepStrictEqual(authority(record), authority(expectedRecord))) {
          throw new Error('OpenCode session authority changed before persistence')
        }
        record = { ...previous, lastCanonicalCursor: record.lastCanonicalCursor,
          lastKnownRawStatus: record.lastKnownRawStatus, lastKnownDurableState: record.lastKnownDurableState,
          updatedAt: record.updatedAt }
      }
      if (store.materializationClaims?.[key]) {
        throw new Error('OpenCode session write is fenced by a materialization claim')
      }
      const owner = store.materializationOwners?.[key]
      if (!ownerTokenAuthorizes(owner, ownerToken)) {
        throw new Error('OpenCode session write is fenced by a materialization owner')
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
      const existingOwner = store.materializationOwners?.[key]
      if (existing && existingOwner !== undefined
        && isDifferentFailedStrictRun(existing, requestedRunId)
        && !await this.materializationOwnerIsActive(store.materializationOwnerProcesses?.[key])) {
        if (signal?.aborted) throwOpenCodeAbortReason(signal)
        if (store.materializationOwners) delete store.materializationOwners[key]
        if (store.materializationOwnerProcesses) delete store.materializationOwnerProcesses[key]
      }
      const replacingExisting = existing && (
        (isOpenCodeSessionStopped(existing)
          && existing.runId && requestedRunId?.trim() && requestedRunId !== existing.runId)
        || canReplaceOwnerlessSessionWithStrictRun(
          existing,
          requestedRunId,
          store.materializationOwners?.[key],
        )
      )
      if (existing && !replacingExisting) {
        return {
          kind: 'existing',
          record: existing,
          ownerToken: store.materializationOwners?.[key] ?? null,
        }
      }
      store.materializationClaims ??= {}
      if (store.materializationClaims[key]) return { kind: 'owned_by_other' }
      const normalizedRunId = requestedRunId?.trim() || undefined
      const currentVersion = store.materializationOwnerVersions?.[key]
      const previousOwner = store.materializationOwners?.[key]
      const nextVersion = Math.max(
        typeof currentVersion === 'number' && Number.isSafeInteger(currentVersion) ? currentVersion : 0,
        isMaterializationOwnerToken(previousOwner) ? previousOwner.version : 0,
      ) + 1
      const ownerToken = { attemptId, sessionId: '', version: nextVersion }
      store.materializationClaims[key] = JSON.stringify(ownerToken)
      store.materializationOwnerVersions ??= {}
      store.materializationOwnerVersions[key] = nextVersion
      if (normalizedRunId) {
        store.materializationClaimRuns ??= {}
        store.materializationClaimRuns[key] = normalizedRunId
      }
      await this.writeStore(store)
      return { kind: 'claimed', ownerToken }
    }, signal)
  }

  async commitMaterialization(
    record: OpenCodeSessionRecord,
    ownerToken: MaterializationOwnerToken,
    signal?: AbortSignal,
  ): Promise<MaterializationOwnerToken | null> {
    const ownerProcessIdentity = await this.currentOwnerProcessIdentity()
    return this.withStoreLock(async () => {
      const store = await this.readStore()
      const key = buildRecordKey(record)
      if (store.materializationClaims?.[key] !== JSON.stringify(ownerToken)) {
        const existing = store.records[key]
        const committedOwner = store.materializationOwners?.[key]
        return existing
          && isMaterializationOwnerToken(committedOwner)
          && committedOwner.attemptId === ownerToken.attemptId
          && committedOwner.version === ownerToken.version
          && committedOwner.sessionId === record.opencodeSessionId
          && jsonStringify(existing) === jsonStringify(record)
          ? committedOwner : null
      }
      const claimedRunId = store.materializationClaimRuns?.[key]
      if (claimedRunId && claimedRunId !== record.runId?.trim()) return null
      const previous = store.records[key]
      const replacingExisting = Boolean(previous && !record.stoppedAt && (
        (isOpenCodeSessionStopped(previous)
          && record.runId?.trim() && record.runId !== previous.runId)
        || canReplaceOwnerlessSessionWithStrictRun(
          previous,
          record.runId,
          store.materializationOwners?.[key],
        )
      ))
      if (previous && !replacingExisting) return null
      const committedOwner = { ...ownerToken, sessionId: record.opencodeSessionId }
      store.records[key] = record
      delete store.materializationClaims[key]
      if (store.materializationClaimRuns) delete store.materializationClaimRuns[key]
      store.materializationOwners ??= {}
      store.materializationOwners[key] = committedOwner
      if (ownerProcessIdentity) {
        store.materializationOwnerProcesses ??= {}
        store.materializationOwnerProcesses[key] = ownerProcessIdentity
      } else if (store.materializationOwnerProcesses) {
        delete store.materializationOwnerProcesses[key]
      }
      await this.writeStore(store)
      return committedOwner
    }, signal)
  }

  async acquireMaterializationOwner(
    record: OpenCodeSessionRecord,
    attemptId: string,
    signal?: AbortSignal,
    expectedOwnerToken?: MaterializationOwnerToken | null,
  ): Promise<MaterializationOwnerToken | null> {
    const nextOwnerProcessIdentity = await this.currentOwnerProcessIdentity()
    return this.withStoreLock(async () => {
      const store = await this.readStore()
      const key = buildRecordKey(record)
      const existing = store.records[key]
      if (!existing || jsonStringify(existing) !== jsonStringify(record)) return null
      const owner = store.materializationOwners?.[key]
      if (owner !== undefined && !isMaterializationOwnerToken(owner)) return null
      if (expectedOwnerToken === undefined
        || (expectedOwnerToken !== null && !isMaterializationOwnerToken(expectedOwnerToken))) return null
      if (expectedOwnerToken === null) {
        if (owner !== undefined) return null
      } else {
        if (!ownerTokensEqual(owner, expectedOwnerToken)) return null
        const ownerIsActive = await this.materializationOwnerIsActive(
          store.materializationOwnerProcesses?.[key],
        )
        if (signal?.aborted) throwOpenCodeAbortReason(signal)
        if (ownerIsActive) return null
      }
      const currentVersion = store.materializationOwnerVersions?.[key]
      const nextVersion = Math.max(
        typeof currentVersion === 'number' && Number.isSafeInteger(currentVersion) ? currentVersion : 0,
        0,
      ) + 1
      const nextOwner = { attemptId, sessionId: record.opencodeSessionId, version: nextVersion }
      store.materializationOwners ??= {}
      store.materializationOwners[key] = nextOwner
      store.materializationOwnerVersions ??= {}
      store.materializationOwnerVersions[key] = nextVersion
      if (nextOwnerProcessIdentity) {
        store.materializationOwnerProcesses ??= {}
        store.materializationOwnerProcesses[key] = nextOwnerProcessIdentity
      } else if (store.materializationOwnerProcesses) {
        delete store.materializationOwnerProcesses[key]
      }
      await this.writeStore(store)
      return nextOwner
    }, signal)
  }

  async isMaterializationOwnerActive(
    record: OpenCodeSessionRecord,
    ownerToken: MaterializationOwnerToken,
    signal?: AbortSignal,
  ): Promise<boolean> {
    return this.withStoreLock(async () => {
      const store = await this.readStore()
      const key = buildRecordKey(record)
      const existing = store.records[key]
      if (!existing || jsonStringify(existing) !== jsonStringify(record)) return true
      if (!ownerTokensEqual(store.materializationOwners?.[key], ownerToken)) return true
      return this.materializationOwnerIsActive(store.materializationOwnerProcesses?.[key])
    }, signal)
  }

  async releaseInactiveMaterializationOwner(
    record: OpenCodeSessionRecord,
    ownerToken: MaterializationOwnerToken,
    signal?: AbortSignal,
  ): Promise<boolean> {
    return this.withStoreLock(async () => {
      const store = await this.readStore()
      const key = buildRecordKey(record)
      const existing = store.records[key]
      if (!existing || jsonStringify(existing) !== jsonStringify(record)) return false
      if (!ownerTokensEqual(store.materializationOwners?.[key], ownerToken)) return false
      // Liveness is checked while holding the same lock as the exact-token
      // removal. A concurrently replaced or still-live owner is never cleared.
      const ownerIsActive = await this.materializationOwnerIsActive(
        store.materializationOwnerProcesses?.[key],
      )
      if (signal?.aborted) throwOpenCodeAbortReason(signal)
      if (ownerIsActive) return false
      delete store.materializationOwners![key]
      if (store.materializationOwnerProcesses) delete store.materializationOwnerProcesses[key]
      await this.writeStore(store)
      return true
    }, signal)
  }

  async releaseMaterializationClaim(
    identity: Pick<OpenCodeSessionRecord, 'teamId' | 'laneId' | 'memberName'>,
    ownerToken: MaterializationOwnerToken,
    requestedRunId?: string,
  ): Promise<boolean> {
    return this.withStoreLock(async () => {
      const store = await this.readStore()
      const key = buildRecordKey(identity)
      if (store.materializationClaims?.[key] !== JSON.stringify(ownerToken)) return false
      const claimedRunId = store.materializationClaimRuns?.[key]
      if (claimedRunId && requestedRunId?.trim() && claimedRunId !== requestedRunId.trim()) return false
      delete store.materializationClaims[key]
      if (store.materializationClaimRuns) delete store.materializationClaimRuns[key]
      await this.writeStore(store)
      return true
    })
  }

  // Called only under the old host startup/registry fence after proven process
  // absence. Preserve the record as terminal evidence rather than deleting it.
  async retireAbsentRuntimeIfSession(
    record: OpenCodeSessionRecord,
    requestedRunId: string,
    signal?: AbortSignal,
  ): Promise<OpenCodeSessionRecord | null> {
    return this.withStoreLock(async () => {
      const store = await this.readStore(true)
      const key = buildRecordKey(record)
      const previous = store.records[key]
      const hasFence = (map: unknown) => map !== undefined && (
        map === null || typeof map !== 'object' || Array.isArray(map) || Object.hasOwn(map, key)
      )
      if (!previous || jsonStringify(previous) !== jsonStringify(record)
        || previous.profileScope?.purpose !== 'launch_runtime'
        || !previous.runId || !requestedRunId.trim() || previous.runId === requestedRunId.trim()
        || isOpenCodeSessionStopped(previous)
        || hasFence(store.materializationClaims) || hasFence(store.materializationOwners)) return null
      if (signal?.aborted) throwOpenCodeAbortReason(signal)
      const stoppedAt = new Date().toISOString()
      const next = { ...previous, stoppedAt, staleReason: 'runtime_process_gone', updatedAt: stoppedAt }
      store.records[key] = next
      await this.writeStore(store)
      return next
    }, signal)
  }

  async markStoppedIfSession(
    record: Pick<OpenCodeSessionRecord,
      'teamId' | 'laneId' | 'memberName' | 'opencodeSessionId' | 'runId' | 'hostKey'>
      & Partial<Pick<OpenCodeSessionRecord, 'createdAt' | 'projectPath'>>,
    stopAuthority?: OpenCodeSessionStopAuthority,
    signal?: AbortSignal,
  ): Promise<OpenCodeSessionRecord | null> {
    return this.withStoreLock(async () => {
      const store = await this.readStore()
      const key = buildRecordKey(record)
      const previous = store.records[key]
      if (!previous || previous.opencodeSessionId !== record.opencodeSessionId
        || previous.runId !== record.runId || previous.hostKey !== record.hostKey
        || (record.createdAt !== undefined && previous.createdAt !== record.createdAt)
        || (record.projectPath !== undefined && previous.projectPath !== record.projectPath)) return null
      if (isOpenCodeSessionStopped(previous)) {
        // Retirement authorizes replacement, not a confirmed Stop receipt.
        if (previous.staleReason === 'runtime_process_gone') return null
        if (stopAuthority && jsonStringify(previous.stopAuthority) !== jsonStringify(stopAuthority)) return null
        return previous
      }
      if (signal?.aborted) throwOpenCodeAbortReason(signal)
      const stoppedAt = new Date().toISOString()
      const next = { ...previous, stoppedAt, ...(stopAuthority ? { stopAuthority } : {}), updatedAt: stoppedAt }
      store.records[key] = next
      await this.writeStore(store)
      if (signal?.aborted) throwOpenCodeAbortReason(signal)
      return next
    }, signal)
  }

  async markStaleIfSession(
    record: Pick<OpenCodeSessionRecord, 'teamId' | 'laneId' | 'memberName' | 'opencodeSessionId' | 'runId'>,
    staleReason: string,
    ownerToken?: MaterializationOwnerToken,
  ): Promise<OpenCodeSessionRecord | null> {
    return this.withStoreLock(async () => {
      const store = await this.readStore()
      const key = buildRecordKey(record)
      const previous = store.records[key]
      if (!previous || previous.opencodeSessionId !== record.opencodeSessionId
        || previous.runId !== record.runId || isOpenCodeSessionStopped(previous)) return null
      const owner = store.materializationOwners?.[key]
      if (!ownerTokenAuthorizes(owner, ownerToken)) return null
      const next = { ...previous, staleReason, updatedAt: new Date().toISOString() }
      store.records[key] = next
      await this.writeStore(store)
      return next
    })
  }

  async deleteIfSession(
    record: Pick<OpenCodeSessionRecord, 'teamId' | 'laneId' | 'memberName' | 'opencodeSessionId' | 'runId'>,
    ownerToken?: MaterializationOwnerToken,
  ): Promise<boolean> {
    return this.withStoreLock(async () => {
      const store = await this.readStore()
      const key = buildRecordKey(record)
      const previous = store.records[key]
      if (!previous || previous.opencodeSessionId !== record.opencodeSessionId
        || previous.runId !== record.runId || isOpenCodeSessionStopped(previous)) return false
      const owner = store.materializationOwners?.[key]
      if (!ownerTokenAuthorizes(owner, ownerToken)) return false
      delete store.records[key]
      if (store.materializationOwners) delete store.materializationOwners[key]
      if (store.materializationOwnerProcesses) delete store.materializationOwnerProcesses[key]
      await this.writeStore(store)
      return true
    })
  }

  async releaseMaterializationOwner(
    record: Pick<OpenCodeSessionRecord, 'teamId' | 'laneId' | 'memberName' | 'opencodeSessionId'>,
    ownerToken: MaterializationOwnerToken,
  ): Promise<boolean> {
    return this.withStoreLock(async () => {
      const store = await this.readStore()
      const key = buildRecordKey(record)
      const owner = store.materializationOwners?.[key]
      if (!ownerTokensEqual(owner, ownerToken)) return false
      delete store.materializationOwners[key]
      if (store.materializationOwnerProcesses) delete store.materializationOwnerProcesses[key]
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

      const owner = store.materializationOwners?.[key]
      if (owner && await this.materializationOwnerIsActive(
        store.materializationOwnerProcesses?.[key],
      )) return null

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
