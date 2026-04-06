import { randomUUID } from 'crypto'
import { mkdir, readFile, rm, stat, writeFile } from 'fs/promises'
import { join } from 'path'
import { errorMessage, getErrnoCode } from 'src/utils/errors.js'
import { getTeamDir } from 'src/utils/swarm/teamHelpers.js'
import { TeamBootstrapJournal } from './teamBootstrapJournal.js'

const BOOTSTRAP_LOCK_TIMEOUT_MS = 10_000
const BOOTSTRAP_LOCK_STALE_MS = 5 * 60_000
const BOOTSTRAP_LOCK_RETRY_BASE_MS = 25
const BOOTSTRAP_LOCK_SLOW_WAIT_MS = 100

type BootstrapLockMetadata = {
  pid: number
  runId: string
  requestHash: string
  ownerStartedAt: number
  createdAt: number
  nonce: string
}

type PersistedBootstrapOwnership = {
  runId?: unknown
  requestHash?: unknown
  ownerPid?: unknown
  ownerStartedAt?: unknown
  terminal?: unknown
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false
  }
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = getErrnoCode(error)
    return code === 'EPERM'
  }
}

function getBootstrapLockDir(teamName: string): string {
  return join(getTeamDir(teamName), '.bootstrap.lock')
}

function getBootstrapLockMetadataPath(teamName: string): string {
  return join(getBootstrapLockDir(teamName), 'metadata.json')
}

function getBootstrapStatePath(teamName: string): string {
  return join(getTeamDir(teamName), 'bootstrap-state.json')
}

async function readLockMetadata(
  teamName: string,
): Promise<BootstrapLockMetadata | null> {
  try {
    const raw = JSON.parse(
      await readFile(getBootstrapLockMetadataPath(teamName), 'utf8'),
    ) as Partial<BootstrapLockMetadata>
    if (
      typeof raw.pid !== 'number' ||
      typeof raw.runId !== 'string' ||
      typeof raw.requestHash !== 'string' ||
      typeof raw.ownerStartedAt !== 'number' ||
      typeof raw.createdAt !== 'number' ||
      typeof raw.nonce !== 'string'
    ) {
      return null
    }
    return raw as BootstrapLockMetadata
  } catch {
    return null
  }
}

async function readBootstrapOwnership(
  teamName: string,
): Promise<PersistedBootstrapOwnership | null> {
  try {
    return JSON.parse(
      await readFile(getBootstrapStatePath(teamName), 'utf8'),
    ) as PersistedBootstrapOwnership
  } catch {
    return null
  }
}

function ownershipCorrelates(
  metadata: BootstrapLockMetadata | null,
  state: PersistedBootstrapOwnership | null,
): boolean {
  if (!metadata || !state) {
    return state === null
  }
  if (state.terminal && typeof state.terminal === 'object') {
    return true
  }
  return (
    state.runId === metadata.runId &&
    state.requestHash === metadata.requestHash &&
    state.ownerPid === metadata.pid &&
    state.ownerStartedAt === metadata.ownerStartedAt
  )
}

async function reclaimStaleBootstrapLock(params: {
  teamName: string
  lockDir: string
  journal: TeamBootstrapJournal
}): Promise<boolean> {
  try {
    const [lockStat, metadata, ownership] = await Promise.all([
      stat(params.lockDir),
      readLockMetadata(params.teamName),
      readBootstrapOwnership(params.teamName),
    ])
    const ageMs = Date.now() - lockStat.mtimeMs
    if (ageMs < BOOTSTRAP_LOCK_STALE_MS) {
      return false
    }

    if (metadata && isProcessAlive(metadata.pid)) {
      return false
    }

    if (!ownershipCorrelates(metadata, ownership)) {
      return false
    }

    await rm(params.lockDir, { recursive: true, force: true })
    await params.journal.append({
      ts: Date.now(),
      type: 'lock',
      runId: metadata?.runId ?? 'unknown',
      action: 'reclaimed',
      ownerPid: metadata?.pid,
      detail: 'reclaimed stale bootstrap lock after dead owner verification',
    })
    return true
  } catch (error) {
    if (getErrnoCode(error) === 'ENOENT') {
      return true
    }
    throw new Error(
      `Failed to reclaim stale bootstrap lock ${params.lockDir}: ${errorMessage(error)}`,
    )
  }
}

async function safeReleaseBootstrapLock(params: {
  teamName: string
  nonce: string
  runId: string
  journal: TeamBootstrapJournal
}): Promise<void> {
  const currentMetadata = await readLockMetadata(params.teamName)
  if (!currentMetadata || currentMetadata.nonce !== params.nonce) {
    return
  }
  const lockDir = getBootstrapLockDir(params.teamName)
  await rm(lockDir, { recursive: true, force: true }).catch(() => {})
  await params.journal.append({
    ts: Date.now(),
    type: 'lock',
    runId: params.runId,
    action: 'released',
    ownerPid: process.pid,
  })
}

export async function withBootstrapOwnershipLock<T>(params: {
  teamName: string
  runId: string
  requestHash: string
  ownerStartedAt: number
  fn: () => Promise<T>
}): Promise<T> {
  const teamDir = getTeamDir(params.teamName)
  const lockDir = getBootstrapLockDir(params.teamName)
  const start = Date.now()
  let attempt = 0
  const journal = new TeamBootstrapJournal(params.teamName)
  const nonce = randomUUID()

  await mkdir(teamDir, { recursive: true })

  while (true) {
    try {
      await mkdir(lockDir)
      try {
        await writeFile(
          getBootstrapLockMetadataPath(params.teamName),
          JSON.stringify(
            {
              pid: process.pid,
              runId: params.runId,
              requestHash: params.requestHash,
              ownerStartedAt: params.ownerStartedAt,
              createdAt: Date.now(),
              nonce,
            } satisfies BootstrapLockMetadata,
            null,
            2,
          ),
          { encoding: 'utf8', mode: 0o600 },
        )
        await journal.append({
          ts: Date.now(),
          type: 'lock',
          runId: params.runId,
          action: 'acquired',
          ownerPid: process.pid,
        })
      } catch (error) {
        await rm(lockDir, { recursive: true, force: true }).catch(() => {})
        throw error
      }
      break
    } catch (error) {
      if (getErrnoCode(error) !== 'EEXIST') {
        throw error
      }

      const reclaimed = await reclaimStaleBootstrapLock({
        teamName: params.teamName,
        lockDir,
        journal,
      })
      if (reclaimed) {
        continue
      }

      if (Date.now() - start >= BOOTSTRAP_LOCK_TIMEOUT_MS) {
        throw new Error(
          `Timed out waiting for bootstrap ownership lock for "${params.teamName}" after ${BOOTSTRAP_LOCK_TIMEOUT_MS}ms`,
        )
      }

      attempt += 1
      const waitMs = Math.min(
        BOOTSTRAP_LOCK_SLOW_WAIT_MS,
        BOOTSTRAP_LOCK_RETRY_BASE_MS * Math.max(1, attempt),
      )
      await sleep(waitMs)
    }
  }

  try {
    return await params.fn()
  } finally {
    await safeReleaseBootstrapLock({
      teamName: params.teamName,
      nonce,
      runId: params.runId,
      journal,
    })
  }
}
