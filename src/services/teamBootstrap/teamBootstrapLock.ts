import { randomUUID } from 'crypto'
import { mkdir, rename, rm, stat, writeFile } from 'fs/promises'
import { join } from 'path'
import { errorMessage, getErrnoCode } from 'src/utils/errors.js'
import { getTeamDir } from 'src/utils/swarm/teamHelpers.js'
import { TeamBootstrapJournal } from './teamBootstrapJournal.js'
import { readBoundRegularUtf8File } from './teamBootstrapBoundFileRead.js'

const BOOTSTRAP_LOCK_TIMEOUT_MS = 10_000
const BOOTSTRAP_LOCK_STALE_MS = 5 * 60_000
const BOOTSTRAP_LOCK_RECLAIM_GUARD_STALE_MS = 30_000
const BOOTSTRAP_LOCK_RETRY_BASE_MS = 25
const BOOTSTRAP_LOCK_SLOW_WAIT_MS = 100
const BOOTSTRAP_LOCK_RENAME_RETRY_DELAYS_MS = [25, 75, 150] as const
const MAX_BOOTSTRAP_LOCK_METADATA_BYTES = 64 * 1024
const MAX_BOOTSTRAP_RECLAIM_GUARD_METADATA_BYTES = 16 * 1024
const TRANSIENT_BOOTSTRAP_LOCK_FS_ERROR_CODES = new Set([
  'EBUSY',
  'EMFILE',
  'ENFILE',
  'EPERM',
])

type BootstrapLockMetadata = {
  pid: number
  runId: string
  requestHash: string
  ownerStartedAt: number
  createdAt: number
  nonce: string
}

type BootstrapReclaimGuardMetadata = {
  pid: number
  createdAt: number
  nonce: string
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

function getBootstrapLockReclaimGuardDir(teamName: string): string {
  return join(getTeamDir(teamName), '.bootstrap.lock.reclaiming')
}

function getBootstrapLockReclaimGuardMetadataPath(teamName: string): string {
  return join(getBootstrapLockReclaimGuardDir(teamName), 'metadata.json')
}

async function readLockMetadataFile(
  filePath: string,
): Promise<BootstrapLockMetadata | null> {
  try {
    const raw = JSON.parse(
      await readBoundRegularUtf8File({
        filePath,
        maxBytes: MAX_BOOTSTRAP_LOCK_METADATA_BYTES,
        messages: {
          notRegular:
            'deterministic bootstrap lock metadata must be a regular file and must not be a symlink',
          oversized: 'deterministic bootstrap lock metadata is too large',
          invalid:
            'deterministic bootstrap lock metadata changed while being validated or could not be read safely',
        },
      }),
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

async function readLockMetadata(
  teamName: string,
): Promise<BootstrapLockMetadata | null> {
  return readLockMetadataFile(getBootstrapLockMetadataPath(teamName))
}

async function readReclaimGuardMetadata(
  teamName: string,
): Promise<BootstrapReclaimGuardMetadata | null> {
  try {
    const raw = JSON.parse(
      await readBoundRegularUtf8File({
        filePath: getBootstrapLockReclaimGuardMetadataPath(teamName),
        maxBytes: MAX_BOOTSTRAP_RECLAIM_GUARD_METADATA_BYTES,
        messages: {
          notRegular:
            'deterministic bootstrap lock reclaim guard metadata must be a regular file and must not be a symlink',
          oversized:
            'deterministic bootstrap lock reclaim guard metadata is too large',
          invalid:
            'deterministic bootstrap lock reclaim guard metadata changed while being validated or could not be read safely',
        },
      }),
    ) as Partial<BootstrapReclaimGuardMetadata>
    if (
      typeof raw.pid !== 'number' ||
      typeof raw.createdAt !== 'number' ||
      typeof raw.nonce !== 'string'
    ) {
      return null
    }
    return raw as BootstrapReclaimGuardMetadata
  } catch {
    return null
  }
}

function lockMetadataMatches(
  left: BootstrapLockMetadata,
  right: BootstrapLockMetadata | null,
): boolean {
  return (
    right !== null &&
    right.pid === left.pid &&
    right.runId === left.runId &&
    right.requestHash === left.requestHash &&
    right.ownerStartedAt === left.ownerStartedAt &&
    right.createdAt === left.createdAt &&
    right.nonce === left.nonce
  )
}

function buildReclaimedLockDir(lockDir: string): string {
  return `${lockDir}.reclaimed.${process.pid}.${Date.now()}.${randomUUID()}`
}

function isTransientBootstrapLockFsError(error: unknown): boolean {
  const code = getErrnoCode(error)
  return !!code && TRANSIENT_BOOTSTRAP_LOCK_FS_ERROR_CODES.has(code)
}

async function renameBootstrapLockDirWithRetry(
  fromPath: string,
  toPath: string,
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(fromPath, toPath)
      return
    } catch (error) {
      const retryDelayMs = BOOTSTRAP_LOCK_RENAME_RETRY_DELAYS_MS[attempt]
      if (
        retryDelayMs === undefined ||
        !isTransientBootstrapLockFsError(error)
      ) {
        throw error
      }
      await sleep(retryDelayMs)
    }
  }
}

async function isBootstrapLockReclaimGuardActive(
  teamName: string,
): Promise<boolean> {
  const guardDir = getBootstrapLockReclaimGuardDir(teamName)
  try {
    const [guardStat, metadata] = await Promise.all([
      stat(guardDir),
      readReclaimGuardMetadata(teamName),
    ])

    if (metadata && !isProcessAlive(metadata.pid)) {
      await rm(guardDir, { recursive: true, force: true })
      return false
    }

    if (Date.now() - guardStat.mtimeMs < BOOTSTRAP_LOCK_RECLAIM_GUARD_STALE_MS) {
      return true
    }

    await rm(guardDir, { recursive: true, force: true })
    return false
  } catch (error) {
    if (getErrnoCode(error) === 'ENOENT') {
      return false
    }
    throw error
  }
}

async function tryAcquireBootstrapLockReclaimGuard(
  teamName: string,
): Promise<{ nonce: string } | null> {
  const guardDir = getBootstrapLockReclaimGuardDir(teamName)
  const nonce = randomUUID()

  while (true) {
    try {
      await mkdir(guardDir)
      try {
        await writeFile(
          getBootstrapLockReclaimGuardMetadataPath(teamName),
          JSON.stringify(
            {
              pid: process.pid,
              createdAt: Date.now(),
              nonce,
            } satisfies BootstrapReclaimGuardMetadata,
            null,
            2,
          ),
          { encoding: 'utf8', mode: 0o600 },
        )
      } catch (error) {
        await rm(guardDir, { recursive: true, force: true }).catch(() => {})
        throw error
      }
      return { nonce }
    } catch (error) {
      if (getErrnoCode(error) !== 'EEXIST') {
        throw error
      }
      if (await isBootstrapLockReclaimGuardActive(teamName)) {
        return null
      }
    }
  }
}

async function releaseBootstrapLockReclaimGuard(
  teamName: string,
  nonce: string,
): Promise<void> {
  const metadata = await readReclaimGuardMetadata(teamName)
  if (!metadata || metadata.nonce !== nonce) {
    return
  }
  await rm(getBootstrapLockReclaimGuardDir(teamName), {
    recursive: true,
    force: true,
  }).catch(() => {})
}

async function reclaimStaleBootstrapLock(params: {
  teamName: string
  lockDir: string
  journal: TeamBootstrapJournal
}): Promise<boolean> {
  const guard = await tryAcquireBootstrapLockReclaimGuard(params.teamName)
  if (!guard) {
    return false
  }

  try {
    const [lockStat, metadata] = await Promise.all([
      stat(params.lockDir),
      readLockMetadata(params.teamName),
    ])
    const ageMs = Date.now() - lockStat.mtimeMs
    if (!metadata && ageMs < BOOTSTRAP_LOCK_STALE_MS) {
      return false
    }

    if (metadata && isProcessAlive(metadata.pid)) {
      return false
    }

    if (metadata) {
      const currentMetadata = await readLockMetadata(params.teamName)
      if (!currentMetadata || !lockMetadataMatches(metadata, currentMetadata)) {
        return false
      }
      if (isProcessAlive(currentMetadata.pid)) {
        return false
      }
    } else {
      const currentLockStat = await stat(params.lockDir)
      if (Date.now() - currentLockStat.mtimeMs < BOOTSTRAP_LOCK_STALE_MS) {
        return false
      }
    }

    const reclaimedLockDir = buildReclaimedLockDir(params.lockDir)
    await renameBootstrapLockDirWithRetry(params.lockDir, reclaimedLockDir)
    if (metadata) {
      const reclaimedMetadata = await readLockMetadataFile(
        join(reclaimedLockDir, 'metadata.json'),
      )
      if (!lockMetadataMatches(metadata, reclaimedMetadata)) {
        await renameBootstrapLockDirWithRetry(reclaimedLockDir, params.lockDir)
        return false
      }
    }
    await rm(reclaimedLockDir, { recursive: true, force: true }).catch(() => {})
    await params.journal.append({
      ts: Date.now(),
      type: 'lock',
      runId: metadata?.runId ?? 'unknown',
      action: 'reclaimed',
      ownerPid: metadata?.pid,
      detail: metadata
        ? 'reclaimed bootstrap lock after dead owner verification'
        : 'reclaimed stale bootstrap lock with missing or invalid metadata',
    })
    return true
  } catch (error) {
    if (getErrnoCode(error) === 'ENOENT') {
      return true
    }
    throw new Error(
      `Failed to reclaim stale bootstrap lock ${params.lockDir}: ${errorMessage(error)}`,
    )
  } finally {
    await releaseBootstrapLockReclaimGuard(params.teamName, guard.nonce)
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
  timeoutMs?: number
  fn: () => Promise<T>
}): Promise<T> {
  const teamDir = getTeamDir(params.teamName)
  const lockDir = getBootstrapLockDir(params.teamName)
  const start = Date.now()
  let attempt = 0
  const journal = new TeamBootstrapJournal(params.teamName)
  const nonce = randomUUID()
  const timeoutMs = params.timeoutMs ?? BOOTSTRAP_LOCK_TIMEOUT_MS

  await mkdir(teamDir, { recursive: true })

  const waitBeforeRetry = async (): Promise<void> => {
    if (Date.now() - start >= timeoutMs) {
      throw new Error(
        `Timed out waiting for bootstrap ownership lock for "${params.teamName}" after ${timeoutMs}ms`,
      )
    }

    attempt += 1
    const waitMs = Math.min(
      BOOTSTRAP_LOCK_SLOW_WAIT_MS,
      BOOTSTRAP_LOCK_RETRY_BASE_MS * Math.max(1, attempt),
    )
    await sleep(waitMs)
  }

  while (true) {
    try {
      if (await isBootstrapLockReclaimGuardActive(params.teamName)) {
        await waitBeforeRetry()
        continue
      }

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

      await waitBeforeRetry()
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
