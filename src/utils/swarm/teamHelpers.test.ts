import { describe, expect, it } from 'bun:test'

import type { TeamFile } from './teamHelpers.js'
import { __setTeamFileLockExchangeTestHook, __setTeamFileLockPlatformForTests, __setWindowsTeamLockBeforeMutexApiAwaitTestHook, __setWindowsTeamLockMutexApiForTests, armTeamMemberSpawnClaim, claimTeamMemberForSpawn, finalizeTeamMemberSpawnClaim, getTeamDir, readTeamFileAsync, recordArmedTeamMemberSpawnRuntime, removeTeammateFromTeamFileIfIdentityMatches, upsertTeamMember, withTeamFileLock, writeTeamFileAsync } from './teamHelpers.js'
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

function createTeamFile(): TeamFile {
  return {
    name: 'atlas-hq',
    createdAt: 0,
    leadAgentId: 'team-lead@atlas-hq',
    members: [],
  }
}

describe('teamHelpers bootstrapExpectedAfter', () => {
  it('normalizes names case-insensitively for both lookup and upsert', () => {
    const original = upsertTeamMember(createTeamFile(), {
      agentId: 'Alice@atlas-hq', name: 'Alice', joinedAt: 1,
      tmuxPaneId: 'pane-1', cwd: '/tmp/project', subscriptions: [],
    }).teamFile
    const updated = upsertTeamMember(original, {
      agentId: 'alice@atlas-hq', name: 'alice', joinedAt: 2,
      tmuxPaneId: 'pane-2', cwd: '/tmp/project', subscriptions: [],
    })
    expect(updated.teamFile.members).toHaveLength(1)
    expect(updated.teamFile.members[0]?.tmuxPaneId).toBe('pane-2')
  })

  it('respawn claim replaces old shutdown and recovery generation state', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'team-helpers-claim-'))
    const previousConfig = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = root
    try {
      const old = {
        agentId: 'alice@atlas-hq', name: 'alice', joinedAt: 1,
        tmuxPaneId: 'process:100', cwd: '/tmp/project', subscriptions: [],
        processStartedAtMs: 1, processOsIdentity: 'win32-job:old-job',
        processOwnerToken: 'old', processRunId: 'old-run',
        outstandingShutdownRequestId: 'shutdown-old',
        terminationRecovery: {
          agentId: 'alice@atlas-hq', paneId: 'process:100', recordedAt: new Date().toISOString(),
        },
      }
      await mkdir(getTeamDir('atlas-hq'), { recursive: true })
      await writeTeamFileAsync('atlas-hq', { ...createTeamFile(), members: [old] })
      const claimed = await claimTeamMemberForSpawn('atlas-hq', {
        agentId: old.agentId, name: old.name, joinedAt: 2,
        tmuxPaneId: 'spawn:pending:new', cwd: '/tmp/project', subscriptions: [],
        spawnClaimToken: 'new', spawnClaimRunId: 'new-run',
      }, old)
      expect(claimed).toBe(true)
      const persisted = JSON.parse(await readFile(path.join(getTeamDir('atlas-hq'), 'config.json'), 'utf8'))
      expect(persisted.members).toHaveLength(1)
      expect(persisted.members[0].outstandingShutdownRequestId).toBeUndefined()
      expect(persisted.members[0].terminationRecovery).toBeUndefined()
    } finally {
      if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previousConfig
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not let respawn CAS substitute a different Windows Job identity', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'team-helpers-job-cas-'))
    const previousConfig = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = root
    try {
      const current = {
        agentId: 'alice@atlas-hq', name: 'alice', joinedAt: 1,
        tmuxPaneId: 'process:100', cwd: '/tmp/project', subscriptions: [],
        processStartedAtMs: 1, processOsIdentity: 'win32-job:current-job',
        processOwnerToken: 'owner', processRunId: 'run-a',
      }
      await mkdir(getTeamDir('atlas-hq'), { recursive: true })
      await writeTeamFileAsync('atlas-hq', { ...createTeamFile(), members: [current] })
      const claimed = await claimTeamMemberForSpawn('atlas-hq', {
        agentId: current.agentId, name: current.name, joinedAt: 2,
        tmuxPaneId: 'spawn:pending:new', cwd: '/tmp/project', subscriptions: [],
        spawnClaimToken: 'new', spawnClaimRunId: 'new-run',
      }, { ...current, processOsIdentity: 'win32-job:stale-job' })
      expect(claimed).toBe(false)
      expect((await readTeamFileAsync('atlas-hq'))?.members[0]).toMatchObject({
        tmuxPaneId: 'process:100', processOsIdentity: 'win32-job:current-job',
      })
    } finally {
      if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previousConfig
      await rm(root, { recursive: true, force: true })
    }
  })

  it('durably records exact pane identity while an armed spawn is still recoverable', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'team-helpers-pane-claim-'))
    const previousConfig = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = root
    try {
      await mkdir(getTeamDir('atlas-hq'), { recursive: true })
      await writeTeamFileAsync('atlas-hq', createTeamFile())
      const reservation = {
        agentId: 'alice@atlas-hq', name: 'alice', joinedAt: Date.now(),
        tmuxPaneId: 'spawn:pending:claim-a', cwd: '/tmp/project', subscriptions: [],
        spawnClaimToken: 'claim-a', spawnClaimRunId: 'run-a',
        spawnClaimOwnerPid: process.pid,
      }
      expect(await claimTeamMemberForSpawn('atlas-hq', reservation)).toBe(true)
      expect(await armTeamMemberSpawnClaim('atlas-hq', reservation.agentId, 'claim-a')).toBe(true)
      expect(await recordArmedTeamMemberSpawnRuntime('atlas-hq', reservation.agentId, 'claim-a', {
        paneId: '%42', backendType: 'tmux',
      })).toBe(true)
      expect((await readTeamFileAsync('atlas-hq'))?.members[0]).toMatchObject({
        tmuxPaneId: '%42', backendType: 'tmux', spawnClaimToken: 'claim-a',
        spawnClaimRuntimeMayExist: true,
      })
    } finally {
      if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previousConfig
      await rm(root, { recursive: true, force: true })
    }
  })

  it('retires only the exact pre-finalized or finalized process spawn claim and permits respawn', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'team-helpers-process-exit-claim-'))
    const previousConfig = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = root
    const processIdentity = {
      agentId: 'alice@atlas-hq', paneId: 'process:4242', processStartedAtMs: 10,
      processOsIdentity: 'unix-pgid:4242:start-a', processOwnerToken: 'owner-a', processRunId: 'process-run-a',
    }
    const reservation = {
      ...processIdentity, name: 'alice', joinedAt: 1, tmuxPaneId: processIdentity.paneId,
      cwd: '/tmp/project', subscriptions: [], backendType: 'process' as const,
      spawnClaimToken: 'claim-a', spawnClaimRunId: 'claim-run-a',
    }
    try {
      await mkdir(getTeamDir('atlas-hq'), { recursive: true })
      await writeTeamFileAsync('atlas-hq', { ...createTeamFile(), members: [reservation] })
      expect(await removeTeammateFromTeamFileIfIdentityMatches('atlas-hq', {
        ...processIdentity, spawnClaimToken: 'claim-a', spawnClaimRunId: 'stale-run',
      })).toBe(false)
      expect(await removeTeammateFromTeamFileIfIdentityMatches('atlas-hq', {
        ...processIdentity, spawnClaimToken: 'claim-a', spawnClaimRunId: 'claim-run-a',
      })).toBe(true)

      await writeTeamFileAsync('atlas-hq', { ...createTeamFile(), members: [reservation] })
      expect(await finalizeTeamMemberSpawnClaim('atlas-hq', reservation.agentId, 'claim-a', 'claim-run-a')).toBe(true)
      expect(await removeTeammateFromTeamFileIfIdentityMatches('atlas-hq', {
        ...processIdentity, spawnClaimToken: undefined, spawnClaimRunId: 'claim-run-a',
      })).toBe(true)
      expect(await claimTeamMemberForSpawn('atlas-hq', {
        ...reservation, tmuxPaneId: 'spawn:pending:claim-b', spawnClaimToken: 'claim-b', spawnClaimRunId: 'claim-run-b',
      })).toBe(true)
      expect(await removeTeammateFromTeamFileIfIdentityMatches('atlas-hq', {
        ...processIdentity, spawnClaimToken: undefined, spawnClaimRunId: 'claim-run-a',
      })).toBe(false)
    } finally {
      if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previousConfig
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reclaims a non-empty dead legacy lock without deleting its successor', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'team-helpers-lock-'))
    const previousConfig = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = root
    try {
      await mkdir(getTeamDir('atlas-hq'), { recursive: true })
      await writeTeamFileAsync('atlas-hq', createTeamFile())
      const lockDir = path.join(getTeamDir('atlas-hq'), '.config.lock')
      await mkdir(lockDir)
      await writeFile(path.join(lockDir, 'metadata.json'), JSON.stringify({ pid: 2147483647 }))
      await writeFile(path.join(lockDir, 'legacy-extra'), 'non-empty')
      let entered = false
      await withTeamFileLock('atlas-hq', async () => { entered = true })
      expect(entered).toBe(true)
      expect(await readFile(path.join(getTeamDir('atlas-hq'), 'config.json'), 'utf8')).toContain('atlas-hq')
    } finally {
      if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previousConfig
      await rm(root, { recursive: true, force: true })
    }
  })

  it('never replaces an empty legacy lock during POSIX acquire publication', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'team-helpers-empty-legacy-lock-'))
    const previousConfig = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = root
    let publishAttempts = 0
    let legacySurvivedFirstAttempt = false
    try {
      await mkdir(getTeamDir('atlas-hq'), { recursive: true })
      await writeTeamFileAsync('atlas-hq', createTeamFile())
      const lockDir = path.join(getTeamDir('atlas-hq'), '.config.lock')
      __setTeamFileLockExchangeTestHook(async ({ phase }) => {
        if (phase !== 'before-acquire-publish') return
        publishAttempts += 1
        if (publishAttempts === 1) {
          // Interleave an older binary's empty live lock after candidate setup
          // but before publication. rename(2) would replace this directory.
          await mkdir(lockDir)
          return
        }
        legacySurvivedFirstAttempt = (await readdir(lockDir)).length === 0
        await rm(lockDir, { recursive: true })
        __setTeamFileLockExchangeTestHook(null)
      })

      await withTeamFileLock('atlas-hq', async () => undefined)
      expect(publishAttempts).toBe(2)
      expect(legacySurvivedFirstAttempt).toBe(true)
    } finally {
      __setTeamFileLockExchangeTestHook(null)
      if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previousConfig
      await rm(root, { recursive: true, force: true })
    }
  })

  it('restores a successor that replaces a stale lock before reclaim CAS', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'team-helpers-lock-cas-'))
    const previousConfig = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = root
    let successorRestored = false
    try {
      await mkdir(getTeamDir('atlas-hq'), { recursive: true })
      await writeTeamFileAsync('atlas-hq', createTeamFile())
      const lockDir = path.join(getTeamDir('atlas-hq'), '.config.lock')
      const displacedLegacy = `${lockDir}.displaced-legacy`
      await mkdir(lockDir)
      await writeFile(path.join(lockDir, 'metadata.json'), JSON.stringify({ pid: 2147483647 }))
      __setTeamFileLockExchangeTestHook(async ({ phase }) => {
        if (phase === 'before-reclaim-exchange') {
          await rename(lockDir, displacedLegacy)
          await mkdir(lockDir)
          await writeFile(path.join(lockDir, 'metadata.json'), JSON.stringify({
            pid: process.pid,
            generation: 'successor-generation',
          }))
        } else if (phase === 'after-reclaim-restore') {
          const metadata = JSON.parse(await readFile(path.join(lockDir, 'metadata.json'), 'utf8'))
          successorRestored = metadata.generation === 'successor-generation'
          __setTeamFileLockExchangeTestHook(null)
          await rm(lockDir, { recursive: true, force: true })
          await rm(displacedLegacy, { recursive: true, force: true })
        }
      })
      await withTeamFileLock('atlas-hq', async () => undefined)
      expect(successorRestored).toBe(true)
    } finally {
      __setTeamFileLockExchangeTestHook(null)
      if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previousConfig
      await rm(root, { recursive: true, force: true })
    }
  })

  it('restores a same-inode lock whose generation changes before reclaim CAS', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'team-helpers-lock-generation-'))
    const previousConfig = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = root
    let successorRestored = false
    try {
      await mkdir(getTeamDir('atlas-hq'), { recursive: true })
      await writeTeamFileAsync('atlas-hq', createTeamFile())
      const lockDir = path.join(getTeamDir('atlas-hq'), '.config.lock')
      await mkdir(lockDir)
      await writeFile(path.join(lockDir, 'metadata.json'), JSON.stringify({
        pid: 2147483647,
        generation: 'observed-generation',
      }))
      __setTeamFileLockExchangeTestHook(async ({ phase }) => {
        if (phase === 'before-reclaim-exchange') {
          await writeFile(path.join(lockDir, 'metadata.json'), JSON.stringify({
            pid: process.pid,
            generation: 'same-inode-successor',
          }))
        } else if (phase === 'after-reclaim-restore') {
          const metadata = JSON.parse(await readFile(path.join(lockDir, 'metadata.json'), 'utf8'))
          successorRestored = metadata.generation === 'same-inode-successor'
          __setTeamFileLockExchangeTestHook(null)
          await rm(lockDir, { recursive: true, force: true })
        }
      })
      await withTeamFileLock('atlas-hq', async () => undefined)
      expect(successorRestored).toBe(true)
    } finally {
      __setTeamFileLockExchangeTestHook(null)
      if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previousConfig
      await rm(root, { recursive: true, force: true })
    }
  })

  it('restores a same-inode successor when the observed legacy generation was absent', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'team-helpers-lock-legacy-identity-'))
    const previousConfig = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = root
    let successorRestored = false
    try {
      await mkdir(getTeamDir('atlas-hq'), { recursive: true })
      await writeTeamFileAsync('atlas-hq', createTeamFile())
      const lockDir = path.join(getTeamDir('atlas-hq'), '.config.lock')
      await mkdir(lockDir)
      await writeFile(path.join(lockDir, 'metadata.json'), JSON.stringify({ pid: 2147483647 }))
      __setTeamFileLockExchangeTestHook(async ({ phase }) => {
        if (phase === 'before-reclaim-exchange') {
          // Same directory object, but a new logical owner generation. A null
          // legacy generation must never act as a wildcard.
          await writeFile(path.join(lockDir, 'metadata.json'), JSON.stringify({
            pid: process.pid,
            generation: 'same-inode-successor-after-legacy',
          }))
        } else if (phase === 'after-reclaim-restore') {
          const metadata = JSON.parse(await readFile(path.join(lockDir, 'metadata.json'), 'utf8'))
          successorRestored = metadata.generation === 'same-inode-successor-after-legacy'
          __setTeamFileLockExchangeTestHook(null)
          await rm(lockDir, { recursive: true, force: true })
        }
      })
      await withTeamFileLock('atlas-hq', async () => undefined)
      expect(successorRestored).toBe(true)
    } finally {
      __setTeamFileLockExchangeTestHook(null)
      if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previousConfig
      await rm(root, { recursive: true, force: true })
    }
  })

  it('restores a successor that replaces the owned lock before release CAS', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'team-helpers-release-cas-'))
    const previousConfig = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = root
    let successorRestored = false
    try {
      await mkdir(getTeamDir('atlas-hq'), { recursive: true })
      await writeTeamFileAsync('atlas-hq', createTeamFile())
      const lockDir = path.join(getTeamDir('atlas-hq'), '.config.lock')
      const displacedOwned = `${lockDir}.displaced-owned`
      __setTeamFileLockExchangeTestHook(async ({ phase }) => {
        if (phase === 'before-release-exchange') {
          await rename(lockDir, displacedOwned)
          await mkdir(lockDir)
          await writeFile(path.join(lockDir, 'metadata.json'), JSON.stringify({
            pid: process.pid,
            generation: 'successor-generation',
          }))
        } else if (phase === 'after-release-restore') {
          const metadata = JSON.parse(await readFile(path.join(lockDir, 'metadata.json'), 'utf8'))
          successorRestored = metadata.generation === 'successor-generation'
          __setTeamFileLockExchangeTestHook(null)
          await rm(lockDir, { recursive: true, force: true })
          await rm(displacedOwned, { recursive: true, force: true })
        }
      })
      await withTeamFileLock('atlas-hq', async () => undefined)
      expect(successorRestored).toBe(true)
    } finally {
      __setTeamFileLockExchangeTestHook(null)
      if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previousConfig
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reclaims and releases team locks through the serialized Windows CAS path', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'team-helpers-windows-lock-'))
    const previousConfig = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = root
    __setTeamFileLockPlatformForTests('win32')
    const calls: string[] = []
    let nextHandle = 0n
    __setWindowsTeamLockMutexApiForTests({
      create: () => { calls.push('create'); nextHandle += 1n; return nextHandle },
      wait: () => { calls.push('wait'); return calls.filter(call => call === 'wait').length === 1 ? 0x80 : 0 },
      release: () => { calls.push('release'); return true },
      close: () => { calls.push('close') },
      dispose: () => { calls.push('dispose') },
    })
    try {
      await mkdir(getTeamDir('atlas-hq'), { recursive: true })
      await writeTeamFileAsync('atlas-hq', createTeamFile())
      const lockDir = path.join(getTeamDir('atlas-hq'), '.config.lock')
      await rm(lockDir, { recursive: true, force: true })
      await mkdir(lockDir)
      await writeFile(path.join(lockDir, 'metadata.json'), JSON.stringify({
        pid: 2147483647,
        generation: 'dead-windows-owner',
      }))

      await withTeamFileLock('atlas-hq', async () => undefined)
      await withTeamFileLock('atlas-hq', async () => undefined)
      expect(JSON.parse(await readFile(path.join(lockDir, 'metadata.json'), 'utf8')))
        .toMatchObject({ pid: 0 })
      expect(calls).toEqual([
        'create', 'wait', 'release', 'close', 'dispose',
        'create', 'wait', 'release', 'close', 'dispose',
      ])
    } finally {
      __setWindowsTeamLockMutexApiForTests(null)
      __setTeamFileLockPlatformForTests(null)
      if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previousConfig
      await rm(root, { recursive: true, force: true })
    }
  })

  it('publishes a Windows pending guard before the mutex API await', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'team-helpers-windows-pending-'))
    const previousConfig = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = root
    __setTeamFileLockPlatformForTests('win32')
    let createCalls = 0
    let releaseFirst!: () => void
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve })
    let pendingPublished!: () => void
    const pendingPublishedPromise = new Promise<void>(resolve => { pendingPublished = resolve })
    let firstEntered!: () => void
    const firstEnteredPromise = new Promise<void>(resolve => { firstEntered = resolve })
    let secondEntered = false
    __setWindowsTeamLockMutexApiForTests({
      create: () => { createCalls += 1; return BigInt(createCalls) },
      wait: () => 0,
      release: () => true,
      close: () => undefined,
      dispose: () => undefined,
    })
    try {
      await mkdir(getTeamDir('atlas-hq'), { recursive: true })
      await writeTeamFileAsync('atlas-hq', createTeamFile())
      __setWindowsTeamLockBeforeMutexApiAwaitTestHook(async () => {
        pendingPublished()
        await firstGate
      })
      const first = withTeamFileLock('atlas-hq', async () => { firstEntered() })
      await pendingPublishedPromise
      const second = withTeamFileLock('atlas-hq', async () => { secondEntered = true })
      await new Promise(resolve => setTimeout(resolve, 30))
      expect(createCalls).toBe(0)
      expect(secondEntered).toBe(false)
      __setWindowsTeamLockBeforeMutexApiAwaitTestHook(null)
      releaseFirst()
      await firstEnteredPromise
      await Promise.all([first, second])
      expect(createCalls).toBe(2)
      expect(secondEntered).toBe(true)
    } finally {
      releaseFirst()
      __setWindowsTeamLockBeforeMutexApiAwaitTestHook(null)
      __setWindowsTeamLockMutexApiForTests(null)
      __setTeamFileLockPlatformForTests(null)
      if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previousConfig
      await rm(root, { recursive: true, force: true })
    }
  })

  it('clears a failed Windows pending guard for a later retry', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'team-helpers-windows-pending-cleanup-'))
    const previousConfig = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = root
    __setTeamFileLockPlatformForTests('win32')
    let createCalls = 0
    __setWindowsTeamLockMutexApiForTests({
      create: () => {
        createCalls += 1
        if (createCalls === 1) throw new Error('injected create failure')
        return 2n
      },
      wait: () => 0,
      release: () => true,
      close: () => undefined,
      dispose: () => undefined,
    })
    try {
      await mkdir(getTeamDir('atlas-hq'), { recursive: true })
      await writeTeamFileAsync('atlas-hq', createTeamFile())
      let entered = false
      await withTeamFileLock('atlas-hq', async () => { entered = true })
      expect(createCalls).toBe(2)
      expect(entered).toBe(true)
    } finally {
      __setWindowsTeamLockMutexApiForTests(null)
      __setTeamFileLockPlatformForTests(null)
      if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previousConfig
      await rm(root, { recursive: true, force: true })
    }
  })
  it('writes bootstrapExpectedAfter for a new member', () => {
    const result = upsertTeamMember(createTeamFile(), {
      agentId: 'alice@atlas-hq',
      name: 'alice',
      joinedAt: 1,
      bootstrapExpectedAfter: '2026-04-08T12:00:00.000Z',
      tmuxPaneId: 'pane-1',
      cwd: '/tmp/project',
      subscriptions: [],
      backendType: 'tmux',
    })

    expect(result.changed).toBe(true)
    expect(result.teamFile.members).toHaveLength(1)
    expect(result.teamFile.members[0]?.bootstrapExpectedAfter).toBe(
      '2026-04-08T12:00:00.000Z',
    )
  })

  it('updates bootstrapExpectedAfter on respawn for an existing member', () => {
    const original = upsertTeamMember(createTeamFile(), {
      agentId: 'alice@atlas-hq',
      name: 'alice',
      joinedAt: 1,
      bootstrapExpectedAfter: '2026-04-08T12:00:00.000Z',
      tmuxPaneId: 'pane-1',
      cwd: '/tmp/project',
      subscriptions: [],
      backendType: 'tmux',
    }).teamFile

    const updated = upsertTeamMember(original, {
      agentId: 'alice@atlas-hq',
      name: 'alice',
      joinedAt: 1,
      bootstrapExpectedAfter: '2026-04-08T12:05:00.000Z',
      tmuxPaneId: 'pane-2',
      cwd: '/tmp/project',
      subscriptions: [],
      backendType: 'tmux',
    })

    expect(updated.changed).toBe(true)
    expect(updated.teamFile.members).toHaveLength(1)
    expect(updated.teamFile.members[0]?.bootstrapExpectedAfter).toBe(
      '2026-04-08T12:05:00.000Z',
    )
  })

  it('treats identical bootstrapExpectedAfter as a no-op', () => {
    const original = upsertTeamMember(createTeamFile(), {
      agentId: 'alice@atlas-hq',
      name: 'alice',
      joinedAt: 1,
      bootstrapExpectedAfter: '2026-04-08T12:00:00.000Z',
      tmuxPaneId: 'pane-1',
      cwd: '/tmp/project',
      subscriptions: [],
      backendType: 'tmux',
    }).teamFile

    const unchanged = upsertTeamMember(original, {
      agentId: 'alice@atlas-hq',
      name: 'alice',
      joinedAt: 1,
      bootstrapExpectedAfter: '2026-04-08T12:00:00.000Z',
      tmuxPaneId: 'pane-1',
      cwd: '/tmp/project',
      subscriptions: [],
      backendType: 'tmux',
    })

    expect(unchanged.changed).toBe(false)
  })

  it('persists teammate worktree cleanup metadata and treats identical metadata as a no-op', () => {
    const member = {
      agentId: 'alice@atlas-hq',
      name: 'alice',
      joinedAt: 1,
      bootstrapExpectedAfter: '2026-04-08T12:00:00.000Z',
      tmuxPaneId: 'pane-1',
      cwd: '/tmp/project/.claude/worktrees/team-atlas-alice-12345678',
      worktreePath: '/tmp/project/.claude/worktrees/team-atlas-alice-12345678',
      worktreeBranch: 'worktree-team-atlas-alice-12345678',
      worktreeHeadCommit: 'abc123',
      worktreeGitRoot: '/tmp/project',
      worktreeBaseWorkspaceRoot: '/tmp/project',
      worktreeDirtyWarning: 'Leader workspace had uncommitted changes.',
      subscriptions: [],
      backendType: 'tmux' as const,
    }
    const original = upsertTeamMember(createTeamFile(), member).teamFile

    expect(original.members[0]?.worktreePath).toBe(member.worktreePath)
    expect(original.members[0]?.worktreeBranch).toBe(member.worktreeBranch)
    expect(original.members[0]?.worktreeHeadCommit).toBe(member.worktreeHeadCommit)
    expect(original.members[0]?.worktreeGitRoot).toBe(member.worktreeGitRoot)
    expect(original.members[0]?.worktreeDirtyWarning).toBe(member.worktreeDirtyWarning)
    expect(upsertTeamMember(original, member).changed).toBe(false)
  })
})
