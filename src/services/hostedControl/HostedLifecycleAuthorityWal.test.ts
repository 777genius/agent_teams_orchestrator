import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, open, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
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
}
const grant: HostedLifecycleWalEntry = {
  schemaVersion: 1,
  kind: 'grant',
  fingerprint: createHash('sha256').update(JSON.stringify({ command, binding })).digest('hex'),
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
  },
}

describe('HostedLifecycleAuthorityWal append durability', () => {
  test('rolls back an incomplete append so authorization and release are never claimed from a truncated record', async () => {
    const authorizationRoot = await mkdtemp(join(tmpdir(), 'hosted-lifecycle-short-grant-'))
    roots.push(authorizationRoot)
    const failedGrantWal = shortThenZeroWal(authorizationRoot)
    await expect(failedGrantWal.append(grant)).rejects.toThrow('did not complete')
    const restartedGrantState = await new HostedLifecycleAuthorityWal(authorizationRoot, teamId).load()
    expect(restartedGrantState.grants.size).toBe(0)
    expect(restartedGrantState.released.size).toBe(0)

    const releaseRoot = await mkdtemp(join(tmpdir(), 'hosted-lifecycle-short-release-'))
    roots.push(releaseRoot)
    const durableWal = new HostedLifecycleAuthorityWal(releaseRoot, teamId)
    await durableWal.append(grant)
    const failedReleaseWal = shortThenZeroWal(releaseRoot)
    await expect(failedReleaseWal.append({
      schemaVersion: 1,
      kind: 'released',
      grantId: grant.authorization.grantId,
    })).rejects.toThrow('did not complete')
    const restartedReleaseState = await new HostedLifecycleAuthorityWal(releaseRoot, teamId).load()
    expect(restartedReleaseState.grants.has(grant.authorization.grantId)).toBe(true)
    expect(restartedReleaseState.released.has(grant.authorization.grantId)).toBe(false)
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
