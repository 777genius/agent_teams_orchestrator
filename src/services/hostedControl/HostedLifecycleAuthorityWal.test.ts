import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { appendFile, chmod, link, lstat, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createHostedLifecycleGrantFingerprint,
  HostedLifecycleAuthorityWal,
  type HostedLifecycleDurableBinding,
  type HostedLifecycleDurableCommand,
  type HostedLifecycleWalEntry,
} from './HostedLifecycleAuthorityWal.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

const teamId = `team_${'a'.repeat(32)}`
const command: HostedLifecycleDurableCommand = {
  schemaVersion: 1,
  action: 'launch',
  commandId: 'lifecycle-command_command01',
  idempotencyKey: 'idempotency_command01',
  workspaceId: 'workspace-a',
  teamId,
  expectedRevision: 'revision_admitted',
}
const binding: HostedLifecycleDurableBinding = {
  actorId: 'actor-a',
  sessionId: 'session-a',
  deploymentId: 'deployment-a',
  bootId: 'boot-a',
  authorizedScope: 'scope_team-lifecycle.write',
  restoreGeneration: 1,
  mountGeneration: 1,
  ownerEffectFence: { grantRevision: '1'.repeat(64), identityChecksum: '2'.repeat(64) },
}
const grant: HostedLifecycleWalEntry = {
  schemaVersion: 1,
  kind: 'grant',
  fingerprint: createHostedLifecycleGrantFingerprint(command, binding),
  command,
  binding,
  authorization: {
    grantId: 'grant_command01',
    authorizationGeneration: 'authorization-generation_command01',
    deploymentId: binding.deploymentId,
    bootId: binding.bootId,
    resourceRevision: command.expectedRevision,
    actorId: binding.actorId,
    workspaceId: command.workspaceId,
    teamId,
    restoreGeneration: binding.restoreGeneration,
    mountGeneration: binding.mountGeneration,
    ownerEffectFence: binding.ownerEffectFence,
  },
}
const durableCommand = {
  schemaVersion: 1,
  commandFingerprint: {
    algorithm: 'sha256', version: 1,
    digest: createHash('sha256').update(JSON.stringify([
      'agent-teams.hosted-lifecycle-command/v1', command.schemaVersion, command.action,
      command.commandId, command.idempotencyKey, command.workspaceId, command.teamId,
      command.expectedRevision, null, binding.ownerEffectFence.grantRevision,
      binding.ownerEffectFence.identityChecksum,
    ])).digest('hex'),
  },
  idempotency: {
    deploymentId: grant.authorization.deploymentId, actorId: grant.authorization.actorId,
    action: command.action, idempotencyKey: command.idempotencyKey,
  },
  resource: {
    bootId: grant.authorization.bootId, workspaceId: command.workspaceId, teamId,
    runId: null, expectedRevision: command.expectedRevision,
    restoreGeneration: grant.authorization.restoreGeneration,
    mountGeneration: grant.authorization.mountGeneration,
    ownerEffectFence: grant.authorization.ownerEffectFence,
  },
}
const started: HostedLifecycleWalEntry = {
  schemaVersion: 1, kind: 'started', fingerprint: durableCommand.commandFingerprint.digest,
  command, durableCommand, authorization: grant.authorization,
}
const completed: HostedLifecycleWalEntry = {
  ...started,
  kind: 'completed',
  result: {
    schemaVersion: 1,
    kind: 'accepted',
    action: command.action,
    commandId: command.commandId,
    workspaceId: command.workspaceId,
    teamId,
    runId: 'run_compaction01',
    resourceRevision: command.expectedRevision,
  },
}

describe('HostedLifecycleAuthorityWal append durability', () => {
  test('rolls back an incomplete append so authorization and release are never claimed from a truncated record', async () => {
    const authorizationRoot = await mkdtemp(join(tmpdir(), 'hosted-lifecycle-short-grant-'))
    roots.push(authorizationRoot)
    const failedGrantWal = shortThenZeroWal(authorizationRoot)
    await expect(failedGrantWal.withLock(() => failedGrantWal.append(grant))).rejects.toThrow('did not complete')
    const restartedGrantState = await new HostedLifecycleAuthorityWal(authorizationRoot, teamId).load()
    expect(restartedGrantState.grants.size).toBe(0)
    expect(restartedGrantState.released.size).toBe(0)

    const releaseRoot = await mkdtemp(join(tmpdir(), 'hosted-lifecycle-short-release-'))
    roots.push(releaseRoot)
    const durableWal = new HostedLifecycleAuthorityWal(releaseRoot, teamId)
    await durableWal.withLock(() => durableWal.append(grant))
    const failedReleaseWal = shortThenZeroWal(releaseRoot)
    await expect(failedReleaseWal.withLock(() => failedReleaseWal.append({
      schemaVersion: 1,
      kind: 'released',
      grantId: grant.authorization.grantId,
    }))).rejects.toThrow('did not complete')
    const restartedReleaseState = await new HostedLifecycleAuthorityWal(releaseRoot, teamId).load()
    expect(restartedReleaseState.grants.has(grant.authorization.grantId)).toBe(true)
    expect(restartedReleaseState.released.has(grant.authorization.grantId)).toBe(false)
  })

  test('recovers the valid prefix before a torn final JSON tail without inventing completion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-lifecycle-torn-tail-')); roots.push(root)
    const wal = new HostedLifecycleAuthorityWal(root, teamId)
    await wal.withLock(() => wal.append(grant))
    await appendFile(wal.path, '{"schemaVersion":1,"kind":"completed"', { mode: 0o600 })
    const recovered = await wal.withLock(() => wal.load())
    expect(recovered?.grants.has(grant.authorization.grantId)).toBe(true)
    expect(recovered?.commands.size).toBe(0)
    expect(recovered?.released.size).toBe(0)

    const repaired = await readFile(wal.path, 'utf8')
    expect(repaired.endsWith('\n')).toBe(true)
    expect(repaired).not.toContain('"kind":"completed"')

    const restarted = new HostedLifecycleAuthorityWal(root, teamId)
    await restarted.withLock(async () => restarted.append({
      schemaVersion: 1,
      kind: 'released',
      grantId: grant.authorization.grantId,
    }))
    const afterRestart = await new HostedLifecycleAuthorityWal(root, teamId).load()
    expect(afterRestart.grants.has(grant.authorization.grantId)).toBe(true)
    expect(afterRestart.released.has(grant.authorization.grantId)).toBe(true)
  })

  test('rejects command and release records without their required durable predecessors', async () => {
    const startedRoot = await mkdtemp(join(tmpdir(), 'hosted-lifecycle-orphan-start-')); roots.push(startedRoot)
    const startedWal = new HostedLifecycleAuthorityWal(startedRoot, teamId)
    await startedWal.withLock(() => startedWal.append(started))
    await expect(startedWal.load()).rejects.toThrow('ordering')

    const releaseRoot = await mkdtemp(join(tmpdir(), 'hosted-lifecycle-orphan-release-')); roots.push(releaseRoot)
    const releaseWal = new HostedLifecycleAuthorityWal(releaseRoot, teamId)
    await releaseWal.withLock(() => releaseWal.append({
      schemaVersion: 1, kind: 'released', grantId: grant.authorization.grantId,
    }))
    await expect(releaseWal.load()).rejects.toThrow('ordering')
  })

  test('rejects a same-uid path substitution after opening the append handle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-lifecycle-substitution-')); roots.push(root)
    const initial = new HostedLifecycleAuthorityWal(root, teamId)
    await initial.withLock(() => initial.append(grant))
    const replacement = `${initial.path}.replacement`
    const wal = new HostedLifecycleAuthorityWal(root, teamId, {
      openAppend: async (path, flags, mode) => {
        const handle = await open(path, flags, mode)
        await rename(path, replacement)
        await writeFile(path, '', { mode: 0o600 })
        return handle
      },
    })

    await expect(wal.withLock(() => wal.append(started))).rejects.toThrow('path-handle correlation')
    const current = await new HostedLifecycleAuthorityWal(root, teamId).load()
    expect(current.grants.size).toBe(0)
    expect(current.commands.size).toBe(0)
  })

  test('rejects a private mode substitution after capturing the append handle identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-lifecycle-mode-substitution-')); roots.push(root)
    const wal = new HostedLifecycleAuthorityWal(root, teamId, {
      openAppend: async (path, flags, mode) => {
        const handle = await open(path, flags, mode)
        return {
          stat: async () => { const stat = await handle.stat(); await chmod(path, 0o400); return stat },
          write: (buffer, offset, length) => handle.write(buffer, offset, length),
          truncate: length => handle.truncate(length),
          sync: () => handle.sync(),
          close: () => handle.close(),
        }
      },
    })
    await expect(wal.withLock(() => wal.append(grant))).rejects.toThrow('path-handle correlation')
  })

  test('rejects parent substitution during directory sync even when the WAL inode is hardlinked', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'hosted-lifecycle-parent-substitution-')); roots.push(parent)
    const root = join(parent, 'team'); await mkdir(root, { mode: 0o700 })
    const displaced = join(parent, 'displaced-team')
    let substitute = true
    const wal = new HostedLifecycleAuthorityWal(root, teamId, {
      openDirectory: async (path, flags) => {
        const handle = await open(path, flags)
        return {
          stat: () => handle.stat(),
          sync: async () => {
            await handle.sync()
            if (!substitute) return
            substitute = false
            await rename(root, displaced)
            await mkdir(root, { mode: 0o700 })
            await link(join(displaced, 'hosted-lifecycle-authority.wal.v1.jsonl'), wal.path)
          },
          close: () => handle.close(),
        }
      },
    })
    await expect(wal.withLock(() => wal.append(grant))).rejects.toThrow()
    expect((await lstat(wal.path)).nlink).toBe(2)
  })

  test('rotates atomically at the size boundary and retains terminal idempotency across restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-lifecycle-compaction-')); roots.push(root)
    const wal = new HostedLifecycleAuthorityWal(root, teamId, {
      compactionThresholdBytes: 1_024,
      completedRetentionEntries: 4,
    })
    await wal.withLock(async () => {
      await wal.append(grant)
      await wal.append(started)
      await wal.append(completed)
      await wal.append({ schemaVersion: 1, kind: 'released', grantId: grant.authorization.grantId })
    })

    const record = JSON.parse((await readFile(wal.path, 'utf8')).trim()) as Record<string, unknown>
    expect(record.kind).toBe('snapshot')
    expect(record.retention).toEqual({ policy: 'latest-completed-v1', completedLimit: 4 })

    const recovered = await new HostedLifecycleAuthorityWal(root, teamId).load()
    expect(recovered.grants.has(grant.authorization.grantId)).toBe(true)
    expect(recovered.released.has(grant.authorization.grantId)).toBe(true)
    expect([...recovered.commands.values()]).toEqual([completed])
  })
})

function shortThenZeroWal(root: string): HostedLifecycleAuthorityWal {
  let writes = 0
  return new HostedLifecycleAuthorityWal(root, teamId, {
    openAppend: async (path, flags, mode) => {
      const handle = await open(path, flags, mode)
      return {
        stat: () => handle.stat(),
        write: async (buffer, offset, length) => {
          writes += 1
          if (writes > 1) return { bytesWritten: 0 }
          const partialLength = Math.max(1, Math.floor(length / 2))
          const { bytesWritten } = await handle.write(buffer, offset, partialLength)
          return { bytesWritten }
        },
        truncate: length => handle.truncate(length),
        sync: () => handle.sync(),
        close: () => handle.close(),
      }
    },
  })
}
