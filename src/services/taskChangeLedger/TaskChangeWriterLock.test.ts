import { afterEach, describe, expect, test } from 'bun:test'

import { createHash } from 'crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { acquireTaskWriterLock } from './TaskChangeWriterLock.js'

function wait(ms: number): Promise<void> {
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
  return isWindowsReservedArtifactSegment(encoded)
    ? `task-id-${createHash('sha256').update(taskId).digest('hex').slice(0, 32)}`
    : encoded
}

function buildLockDir(lockRootDir: string, taskId: string): string {
  return join(lockRootDir, `${encodeTaskId(taskId)}.lock`)
}

function buildOwnerPath(lockRootDir: string, taskId: string): string {
  return join(buildLockDir(lockRootDir, taskId), 'owner.json')
}

function buildOwnerPayload(taskId: string, ownerId: string, sessionId: string, heartbeatAt: string) {
  return {
    ownerId,
    pid: process.pid,
    sessionId,
    taskId,
    startedAt: heartbeatAt,
    heartbeatAt,
  }
}

describe('TaskChangeWriterLock', () => {
  let tempDir: string | null = null

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true })
      tempDir = null
    }
  })

  test('release does not remove a lock that is now owned by someone else', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'task-writer-lock-'))
    const lockRootDir = join(tempDir, 'locks')
    const taskId = 'task-1'
    const ownerPath = buildOwnerPath(lockRootDir, taskId)
    await mkdir(lockRootDir, { recursive: true, mode: 0o700 })

    const lock = await acquireTaskWriterLock({
      lockRootDir,
      taskId,
      sessionId: 'session-1',
      ownerId: 'owner-1',
      heartbeatIntervalMs: 1_000,
    })

    await mkdir(buildLockDir(lockRootDir, taskId), { recursive: true, mode: 0o700 })
    await writeFile(
      ownerPath,
      JSON.stringify({
        ownerId: 'owner-2',
        pid: process.pid,
        sessionId: 'session-2',
        taskId,
        startedAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
      }),
      'utf8',
    )

    await lock.release()

    const persistedOwner = JSON.parse(await readFile(ownerPath, 'utf8')) as {
      ownerId?: string
    }
    expect(persistedOwner.ownerId).toBe('owner-2')
  })

  test('creates the lock root directory when it does not exist yet', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'task-writer-lock-'))
    const lockRootDir = join(tempDir, 'nested', 'locks')
    const taskId = 'task-root'

    const lock = await acquireTaskWriterLock({
      lockRootDir,
      taskId,
      sessionId: 'session-1',
      ownerId: 'owner-1',
      heartbeatIntervalMs: 25,
    })

    const persistedOwner = JSON.parse(
      await readFile(buildOwnerPath(lockRootDir, taskId), 'utf8'),
    ) as { ownerId?: string }
    expect(persistedOwner.ownerId).toBe('owner-1')

    await lock.release()
  })

  test('uses a Windows-safe lock directory for reserved task ids', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'task-writer-lock-'))
    const lockRootDir = join(tempDir, 'locks')
    const taskId = 'CON'

    const lock = await acquireTaskWriterLock({
      lockRootDir,
      taskId,
      sessionId: 'session-1',
      ownerId: 'owner-1',
      heartbeatIntervalMs: 25,
    })

    const persistedOwner = JSON.parse(
      await readFile(buildOwnerPath(lockRootDir, taskId), 'utf8'),
    ) as { taskId?: string }
    expect(persistedOwner.taskId).toBe(taskId)
    await expect(readFile(join(lockRootDir, 'CON.lock', 'owner.json'), 'utf8')).rejects.toThrow()

    await lock.release()
  })

  test('heartbeat stops updating owner file after ownership changes', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'task-writer-lock-'))
    const lockRootDir = join(tempDir, 'locks')
    const taskId = 'task-2'
    const ownerPath = buildOwnerPath(lockRootDir, taskId)
    await mkdir(lockRootDir, { recursive: true, mode: 0o700 })

    const lock = await acquireTaskWriterLock({
      lockRootDir,
      taskId,
      sessionId: 'session-1',
      ownerId: 'owner-1',
      heartbeatIntervalMs: 25,
    })

    const replacementOwner = {
      ownerId: 'owner-2',
      pid: process.pid,
      sessionId: 'session-2',
      taskId,
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
    }
    await writeFile(ownerPath, JSON.stringify(replacementOwner), 'utf8')

    await wait(80)

    const persistedOwner = JSON.parse(await readFile(ownerPath, 'utf8')) as {
      ownerId?: string
    }
    expect(persistedOwner.ownerId).toBe('owner-2')

    await lock.release()
  })

  test('times out when another live writer already owns the lock', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'task-writer-lock-'))
    const lockRootDir = join(tempDir, 'locks')
    const taskId = 'task-contention'

    const first = await acquireTaskWriterLock({
      lockRootDir,
      taskId,
      sessionId: 'session-1',
      ownerId: 'owner-1',
      heartbeatIntervalMs: 25,
      staleThresholdMs: 250,
    })

    await expect(
      acquireTaskWriterLock({
        lockRootDir,
        taskId,
        sessionId: 'session-2',
        ownerId: 'owner-2',
        waitBudgetMs: 120,
        heartbeatIntervalMs: 25,
        staleThresholdMs: 250,
      }),
    ).rejects.toThrow('Timed out acquiring task writer lock')

    await first.release()
  })

  test('steals a stale lock and reports it to the caller', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'task-writer-lock-'))
    const lockRootDir = join(tempDir, 'locks')
    const taskId = 'task-stale'
    const staleHeartbeatAt = new Date(Date.now() - 60_000).toISOString()
    await mkdir(buildLockDir(lockRootDir, taskId), { recursive: true, mode: 0o700 })
    await writeFile(
      buildOwnerPath(lockRootDir, taskId),
      JSON.stringify(buildOwnerPayload(taskId, 'owner-1', 'session-1', staleHeartbeatAt)),
      'utf8',
    )

    const lock = await acquireTaskWriterLock({
      lockRootDir,
      taskId,
      sessionId: 'session-2',
      ownerId: 'owner-2',
      waitBudgetMs: 120,
      heartbeatIntervalMs: 25,
      staleThresholdMs: 25,
    })

    expect(lock.stoleStaleLock).toBe(true)
    const persistedOwner = JSON.parse(
      await readFile(buildOwnerPath(lockRootDir, taskId), 'utf8'),
    ) as { ownerId?: string }
    expect(persistedOwner.ownerId).toBe('owner-2')

    await lock.release()
  })

  test('heartbeat keeps a long-running owner from being treated as stale', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'task-writer-lock-'))
    const lockRootDir = join(tempDir, 'locks')
    const taskId = 'task-heartbeat'

    const first = await acquireTaskWriterLock({
      lockRootDir,
      taskId,
      sessionId: 'session-1',
      ownerId: 'owner-1',
      heartbeatIntervalMs: 20,
      staleThresholdMs: 150,
    })

    await wait(180)

    await expect(
      acquireTaskWriterLock({
        lockRootDir,
        taskId,
        sessionId: 'session-2',
        ownerId: 'owner-2',
        waitBudgetMs: 80,
        heartbeatIntervalMs: 20,
        staleThresholdMs: 150,
      }),
    ).rejects.toThrow('Timed out acquiring task writer lock')

    const persistedOwner = JSON.parse(
      await readFile(buildOwnerPath(lockRootDir, taskId), 'utf8'),
    ) as { ownerId?: string }
    expect(persistedOwner.ownerId).toBe('owner-1')

    await first.release()
  })
})
