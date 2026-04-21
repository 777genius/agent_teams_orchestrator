import { createHash, randomUUID } from 'crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'fs/promises'
import { dirname, join } from 'path'

type TaskWriterLockOwner = {
  ownerId: string
  pid: number
  sessionId: string
  taskId: string
  startedAt: string
  heartbeatAt: string
}

type AcquireTaskWriterLockOptions = {
  lockRootDir: string
  taskId: string
  sessionId: string
  ownerId: string
  waitBudgetMs?: number
  heartbeatIntervalMs?: number
  staleThresholdMs?: number
}

type AcquireTaskWriterLockResult = {
  release: () => Promise<void>
  stoleStaleLock: boolean
}

const DEFAULT_WAIT_BUDGET_MS = 2_000
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000
const DEFAULT_STALE_THRESHOLD_MS = 30_000
const MAX_TASK_ID_ARTIFACT_SEGMENT_LENGTH = 120
const OWNER_RENAME_RETRY_DELAYS_MS = [5, 15, 35, 75]
const RETRYABLE_OWNER_RENAME_ERROR_CODES = new Set(['EACCES', 'EBUSY', 'EPERM'])

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function isWindowsReservedArtifactSegment(segment: string): boolean {
  const stem = segment.split('.')[0]?.toUpperCase() ?? ''
  return (
    !segment ||
    stem === 'CON' ||
    stem === 'PRN' ||
    stem === 'AUX' ||
    stem === 'NUL' ||
    /^COM[1-9]$/.test(stem) ||
    /^LPT[1-9]$/.test(stem)
  )
}

function encodeTaskId(taskId: string): string {
  const encoded = encodeURIComponent(taskId)
  return isWindowsReservedArtifactSegment(encoded) ||
    encoded.length > MAX_TASK_ID_ARTIFACT_SEGMENT_LENGTH
    ? `task-id-${createHash('sha256').update(taskId).digest('hex').slice(0, 32)}`
    : encoded
}

function buildLockDir(lockRootDir: string, taskId: string): string {
  return join(lockRootDir, `${encodeTaskId(taskId)}.lock`)
}

function buildOwnerPath(lockDir: string): string {
  return join(lockDir, 'owner.json')
}

function getErrorCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : ''
}

async function renameOwnerFileWithRetry(
  tempOwnerPath: string,
  ownerPath: string,
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(tempOwnerPath, ownerPath)
      return
    } catch (error) {
      const code = getErrorCode(error)
      const retryDelayMs = OWNER_RENAME_RETRY_DELAYS_MS[attempt]
      if (
        retryDelayMs === undefined ||
        !RETRYABLE_OWNER_RENAME_ERROR_CODES.has(code)
      ) {
        throw error
      }
      await sleep(retryDelayMs)
    }
  }
}

async function writeOwnerFile(lockDir: string, owner: TaskWriterLockOwner): Promise<void> {
  const ownerPath = buildOwnerPath(lockDir)
  await mkdir(dirname(ownerPath), { recursive: true, mode: 0o700 })
  const tempOwnerPath = join(
    dirname(ownerPath),
    `.owner.${process.pid}.${Date.now()}.${randomUUID()}.tmp`,
  )
  try {
    await writeFile(tempOwnerPath, JSON.stringify(owner), {
      encoding: 'utf8',
      mode: 0o600,
    })
    await renameOwnerFileWithRetry(tempOwnerPath, ownerPath)
  } catch (error) {
    await rm(tempOwnerPath, { force: true }).catch(() => undefined)
    throw error
  }
}

async function readOwnerFile(lockDir: string): Promise<TaskWriterLockOwner | null> {
  try {
    const raw = await readFile(buildOwnerPath(lockDir), 'utf8')
    const parsed = JSON.parse(raw) as Partial<TaskWriterLockOwner>
    if (
      typeof parsed?.ownerId !== 'string' ||
      typeof parsed?.taskId !== 'string' ||
      typeof parsed?.sessionId !== 'string' ||
      typeof parsed?.startedAt !== 'string' ||
      typeof parsed?.heartbeatAt !== 'string' ||
      typeof parsed?.pid !== 'number'
    ) {
      return null
    }
    return parsed as TaskWriterLockOwner
  } catch {
    return null
  }
}

async function isOwnedBy(lockDir: string, ownerId: string): Promise<boolean> {
  const owner = await readOwnerFile(lockDir)
  return owner?.ownerId === ownerId
}

function isStaleOwner(
  owner: TaskWriterLockOwner | null,
  staleThresholdMs: number,
  nowMs: number,
): boolean {
  if (!owner) {
    return true
  }
  const heartbeatAtMs = Date.parse(owner.heartbeatAt)
  if (!Number.isFinite(heartbeatAtMs)) {
    return true
  }
  return nowMs - heartbeatAtMs > staleThresholdMs
}

async function getInvalidOwnerAgeMs(lockDir: string, nowMs: number): Promise<number> {
  let newestMtimeMs = Number.NEGATIVE_INFINITY
  for (const artifactPath of [buildOwnerPath(lockDir), lockDir]) {
    try {
      const artifactStats = await stat(artifactPath)
      newestMtimeMs = Math.max(newestMtimeMs, artifactStats.mtimeMs)
    } catch {
      // Missing or unreadable artifacts are handled by the final infinity fallback.
    }
  }
  return Number.isFinite(newestMtimeMs) ? nowMs - newestMtimeMs : Number.POSITIVE_INFINITY
}

async function isStaleLock(
  lockDir: string,
  owner: TaskWriterLockOwner | null,
  staleThresholdMs: number,
  nowMs: number,
): Promise<boolean> {
  if (owner) {
    return isStaleOwner(owner, staleThresholdMs, nowMs)
  }
  return (await getInvalidOwnerAgeMs(lockDir, nowMs)) > staleThresholdMs
}

export async function acquireTaskWriterLock(
  options: AcquireTaskWriterLockOptions,
): Promise<AcquireTaskWriterLockResult> {
  const waitBudgetMs = options.waitBudgetMs ?? DEFAULT_WAIT_BUDGET_MS
  const heartbeatIntervalMs =
    options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS
  const staleThresholdMs = options.staleThresholdMs ?? DEFAULT_STALE_THRESHOLD_MS
  await mkdir(options.lockRootDir, { recursive: true, mode: 0o700 })
  const lockDir = buildLockDir(options.lockRootDir, options.taskId)
  const startedAt = new Date().toISOString()
  const deadline = Date.now() + waitBudgetMs
  let stoleStaleLock = false

  while (true) {
    try {
      await mkdir(lockDir, { recursive: false, mode: 0o700 })
      const owner: TaskWriterLockOwner = {
        ownerId: options.ownerId,
        pid: process.pid,
        sessionId: options.sessionId,
        taskId: options.taskId,
        startedAt,
        heartbeatAt: startedAt,
      }
      await writeOwnerFile(lockDir, owner)

      let released = false
      let liveOwner = owner
      const heartbeatTimer = setInterval(() => {
        if (released) {
          return
        }
        void (async () => {
          if (!(await isOwnedBy(lockDir, owner.ownerId))) {
            released = true
            clearInterval(heartbeatTimer)
            return
          }
          liveOwner = {
            ...liveOwner,
            heartbeatAt: new Date().toISOString(),
          }
          await writeOwnerFile(lockDir, liveOwner)
        })().catch(() => undefined)
      }, heartbeatIntervalMs)
      heartbeatTimer.unref()

      return {
        stoleStaleLock,
        release: async () => {
          if (released) {
            return
          }
          released = true
          clearInterval(heartbeatTimer)
          if (!(await isOwnedBy(lockDir, owner.ownerId))) {
            return
          }
          await rm(lockDir, { recursive: true, force: true })
        },
      }
    } catch (error) {
      const code =
        error && typeof error === 'object' && 'code' in error
          ? String((error as { code?: unknown }).code)
          : ''
      if (code !== 'EEXIST') {
        throw error
      }
    }

    const owner = await readOwnerFile(lockDir)
    const nowMs = Date.now()
    if (await isStaleLock(lockDir, owner, staleThresholdMs, nowMs)) {
      await rm(lockDir, { recursive: true, force: true })
      stoleStaleLock = true
      continue
    }

    if (nowMs >= deadline) {
      throw new Error(`Timed out acquiring task writer lock for ${options.taskId}`)
    }

    await sleep(50)
  }
}
