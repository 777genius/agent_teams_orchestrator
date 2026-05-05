import { randomUUID } from 'crypto'
import { afterEach, describe, expect, test } from 'bun:test'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'

import { getTeamDir } from 'src/utils/swarm/teamHelpers.js'
import { withBootstrapOwnershipLock } from './teamBootstrapLock.js'

const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR
const DEAD_TEST_PID = 999_999_999

let tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(
    tempDirs.map(dir => fs.rm(dir, { recursive: true, force: true })),
  )
  tempDirs = []
  if (originalClaudeConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir
  }
})

async function useTempConfigDir(): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bootstrap-lock-'))
  tempDirs.push(tempDir)
  process.env.CLAUDE_CONFIG_DIR = tempDir
  return tempDir
}

function getLockDir(teamName: string): string {
  return path.join(getTeamDir(teamName), '.bootstrap.lock')
}

function getLockMetadataPath(teamName: string): string {
  return path.join(getLockDir(teamName), 'metadata.json')
}

function getReclaimGuardDir(teamName: string): string {
  return path.join(getTeamDir(teamName), '.bootstrap.lock.reclaiming')
}

function getReclaimGuardMetadataPath(teamName: string): string {
  return path.join(getReclaimGuardDir(teamName), 'metadata.json')
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath)
    return true
  } catch {
    return false
  }
}

async function writeBootstrapLock(params: {
  teamName: string
  pid: number
  runId?: string
  requestHash?: string
  ownerStartedAt?: number
  createdAt?: number
  nonce?: string
  stale?: boolean
}): Promise<void> {
  const teamDir = getTeamDir(params.teamName)
  const lockDir = getLockDir(params.teamName)
  const now = Date.now()
  await fs.mkdir(lockDir, { recursive: true })
  await fs.writeFile(
    getLockMetadataPath(params.teamName),
    JSON.stringify(
      {
        pid: params.pid,
        runId: params.runId ?? 'stale-run',
        requestHash: params.requestHash ?? 'stale-request',
        ownerStartedAt: params.ownerStartedAt ?? now - 10 * 60_000,
        createdAt: params.createdAt ?? now - 10 * 60_000,
        nonce: params.nonce ?? randomUUID(),
      },
      null,
      2,
    ),
    { encoding: 'utf8', mode: 0o600 },
  )

  if (params.stale ?? true) {
    const staleTime = new Date(now - 10 * 60_000)
    await fs.utimes(lockDir, staleTime, staleTime)
  }

  await fs.mkdir(teamDir, { recursive: true })
}

async function writeInvalidBootstrapLock(params: {
  teamName: string
  stale?: boolean
}): Promise<void> {
  const lockDir = getLockDir(params.teamName)
  const now = Date.now()
  await fs.mkdir(lockDir, { recursive: true })
  await fs.writeFile(getLockMetadataPath(params.teamName), '{', {
    encoding: 'utf8',
    mode: 0o600,
  })

  if (params.stale ?? true) {
    const staleTime = new Date(now - 10 * 60_000)
    await fs.utimes(lockDir, staleTime, staleTime)
  }
}

async function writeReclaimGuard(params: {
  teamName: string
  pid: number
  stale?: boolean
}): Promise<void> {
  const guardDir = getReclaimGuardDir(params.teamName)
  const now = Date.now()
  const createdAt = (params.stale ?? true) ? now - 60_000 : now
  await fs.mkdir(guardDir, { recursive: true })
  await fs.writeFile(
    getReclaimGuardMetadataPath(params.teamName),
    JSON.stringify(
      {
        pid: params.pid,
        createdAt,
        nonce: randomUUID(),
      },
      null,
      2,
    ),
    { encoding: 'utf8', mode: 0o600 },
  )

  if (params.stale ?? true) {
    const staleTime = new Date(now - 60_000)
    await fs.utimes(guardDir, staleTime, staleTime)
  }
}

async function readJournalRecords(teamName: string): Promise<unknown[]> {
  const journalPath = path.join(getTeamDir(teamName), 'bootstrap-journal.jsonl')
  const raw = await fs.readFile(journalPath, 'utf8')
  return raw
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as unknown)
}

describe('deterministic bootstrap ownership lock recovery', () => {
  test('reclaims stale dead-owner lock when a later waiter overwrote bootstrap state', async () => {
    await useTempConfigDir()
    const teamName = `team-${randomUUID()}`
    const oldOwnerStartedAt = Date.now() - 10 * 60_000

    await writeBootstrapLock({
      teamName,
      pid: DEAD_TEST_PID,
      runId: 'old-run',
      requestHash: 'old-request',
      ownerStartedAt: oldOwnerStartedAt,
      createdAt: oldOwnerStartedAt,
      nonce: 'old-nonce',
    })
    await fs.writeFile(
      path.join(getTeamDir(teamName), 'bootstrap-state.json'),
      JSON.stringify(
        {
          version: 1,
          runId: 'later-waiter-run',
          requestHash: 'later-waiter-request',
          teamName,
          ownerPid: process.pid,
          ownerStartedAt: Date.now(),
          phase: 'acquiring_bootstrap_lock',
          terminal: null,
        },
        null,
        2,
      ),
      { encoding: 'utf8', mode: 0o600 },
    )

    await expect(
      withBootstrapOwnershipLock({
        teamName,
        runId: 'fresh-run',
        requestHash: 'fresh-request',
        ownerStartedAt: Date.now(),
        timeoutMs: 1_000,
        fn: async () => {
          const metadata = JSON.parse(
            await fs.readFile(getLockMetadataPath(teamName), 'utf8'),
          ) as { runId?: string; pid?: number }
          expect(metadata.runId).toBe('fresh-run')
          expect(metadata.pid).toBe(process.pid)
          return 'acquired'
        },
      }),
    ).resolves.toBe('acquired')

    expect(await exists(getLockDir(teamName))).toBe(false)
    const records = await readJournalRecords(teamName)
    expect(records).toContainEqual(
      expect.objectContaining({
        type: 'lock',
        action: 'reclaimed',
        runId: 'old-run',
        ownerPid: DEAD_TEST_PID,
        detail: expect.stringContaining('dead owner verification'),
      }),
    )
    expect(records).toContainEqual(
      expect.objectContaining({
        type: 'lock',
        action: 'acquired',
        runId: 'fresh-run',
        ownerPid: process.pid,
      }),
    )
  })

  test('does not reclaim a stale lock whose owner process is still alive', async () => {
    await useTempConfigDir()
    const teamName = `team-${randomUUID()}`
    let fnCalled = false

    await writeBootstrapLock({
      teamName,
      pid: process.pid,
      runId: 'alive-owner-run',
      requestHash: 'alive-owner-request',
    })

    await expect(
      withBootstrapOwnershipLock({
        teamName,
        runId: 'waiter-run',
        requestHash: 'waiter-request',
        ownerStartedAt: Date.now(),
        timeoutMs: 75,
        fn: async () => {
          fnCalled = true
        },
      }),
    ).rejects.toThrow(
      'Timed out waiting for bootstrap ownership lock for',
    )

    expect(fnCalled).toBe(false)
    const metadata = JSON.parse(
      await fs.readFile(getLockMetadataPath(teamName), 'utf8'),
    ) as { runId?: string; pid?: number }
    expect(metadata.runId).toBe('alive-owner-run')
    expect(metadata.pid).toBe(process.pid)
  })

  test('reclaims a fresh lock when its metadata owner process is already dead', async () => {
    await useTempConfigDir()
    const teamName = `team-${randomUUID()}`

    await writeBootstrapLock({
      teamName,
      pid: DEAD_TEST_PID,
      runId: 'fresh-dead-owner-run',
      requestHash: 'fresh-dead-owner-request',
      stale: false,
    })

    await expect(
      withBootstrapOwnershipLock({
        teamName,
        runId: 'fresh-retry-run',
        requestHash: 'fresh-retry-request',
        ownerStartedAt: Date.now(),
        timeoutMs: 1_000,
        fn: async () => {
          return 'acquired'
        },
      }),
    ).resolves.toBe('acquired')

    expect(await exists(getLockDir(teamName))).toBe(false)
    const records = await readJournalRecords(teamName)
    expect(records).toContainEqual(
      expect.objectContaining({
        type: 'lock',
        action: 'reclaimed',
        runId: 'fresh-dead-owner-run',
        ownerPid: DEAD_TEST_PID,
      }),
    )
  })

  test('does not reclaim a fresh lock with invalid metadata', async () => {
    await useTempConfigDir()
    const teamName = `team-${randomUUID()}`
    let fnCalled = false

    await writeInvalidBootstrapLock({ teamName, stale: false })

    await expect(
      withBootstrapOwnershipLock({
        teamName,
        runId: 'waiter-run',
        requestHash: 'waiter-request',
        ownerStartedAt: Date.now(),
        timeoutMs: 75,
        fn: async () => {
          fnCalled = true
        },
      }),
    ).rejects.toThrow('Timed out waiting for bootstrap ownership lock for')

    expect(fnCalled).toBe(false)
    expect(await exists(getLockDir(teamName))).toBe(true)
  })

  test('reclaims a stale lock with invalid metadata', async () => {
    await useTempConfigDir()
    const teamName = `team-${randomUUID()}`

    await writeInvalidBootstrapLock({ teamName })

    await expect(
      withBootstrapOwnershipLock({
        teamName,
        runId: 'invalid-metadata-retry-run',
        requestHash: 'invalid-metadata-retry-request',
        ownerStartedAt: Date.now(),
        timeoutMs: 1_000,
        fn: async () => 'acquired',
      }),
    ).resolves.toBe('acquired')

    expect(await exists(getLockDir(teamName))).toBe(false)
    const records = await readJournalRecords(teamName)
    expect(records).toContainEqual(
      expect.objectContaining({
        type: 'lock',
        action: 'reclaimed',
        runId: 'unknown',
        detail: expect.stringContaining('missing or invalid metadata'),
      }),
    )
  })

  test('does not create a fresh lock while a live reclaim guard is active', async () => {
    await useTempConfigDir()
    const teamName = `team-${randomUUID()}`
    let fnCalled = false

    await writeReclaimGuard({
      teamName,
      pid: process.pid,
      stale: false,
    })

    await expect(
      withBootstrapOwnershipLock({
        teamName,
        runId: 'waiter-run',
        requestHash: 'waiter-request',
        ownerStartedAt: Date.now(),
        timeoutMs: 75,
        fn: async () => {
          fnCalled = true
        },
      }),
    ).rejects.toThrow('Timed out waiting for bootstrap ownership lock for')

    expect(fnCalled).toBe(false)
    expect(await exists(getLockDir(teamName))).toBe(false)
    expect(await exists(getReclaimGuardDir(teamName))).toBe(true)
  })

  test('removes a stale dead reclaim guard before acquiring a fresh lock', async () => {
    await useTempConfigDir()
    const teamName = `team-${randomUUID()}`

    await writeReclaimGuard({
      teamName,
      pid: DEAD_TEST_PID,
    })

    await expect(
      withBootstrapOwnershipLock({
        teamName,
        runId: 'fresh-run-after-dead-guard',
        requestHash: 'fresh-request-after-dead-guard',
        ownerStartedAt: Date.now(),
        timeoutMs: 1_000,
        fn: async () => 'acquired',
      }),
    ).resolves.toBe('acquired')

    expect(await exists(getLockDir(teamName))).toBe(false)
    expect(await exists(getReclaimGuardDir(teamName))).toBe(false)
  })

  test('removes a stale reclaim guard even when its pid is still alive', async () => {
    await useTempConfigDir()
    const teamName = `team-${randomUUID()}`

    await writeReclaimGuard({
      teamName,
      pid: process.pid,
    })

    await expect(
      withBootstrapOwnershipLock({
        teamName,
        runId: 'fresh-run-after-stale-live-guard',
        requestHash: 'fresh-request-after-stale-live-guard',
        ownerStartedAt: Date.now(),
        timeoutMs: 1_000,
        fn: async () => 'acquired',
      }),
    ).resolves.toBe('acquired')

    expect(await exists(getLockDir(teamName))).toBe(false)
    expect(await exists(getReclaimGuardDir(teamName))).toBe(false)
  })
})
