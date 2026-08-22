import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { HostedLifecycleAuthorityService } from './HostedLifecycleAuthorityService.js'
import { HostedLifecycleAuthorityWal } from './HostedLifecycleAuthorityWal.js'
import {
  HostedLifecycleProviderRegistry,
  type HostedLifecycleProviderAdapter,
  type HostedLifecycleProviderEffectResult,
} from './HostedLifecycleProviderRegistry.js'
import { createHostedLifecycleSnapshot, type HostedLifecycleProviderSnapshot } from './HostedLifecycleSnapshot.js'
import type { HostedLifecycleAuthority } from './HostedControlDispatcher.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

const teamId = `team_${'a'.repeat(32)}`
const incarnation = {
  workspaceId: 'workspace-a', teamId, deploymentId: 'deployment-a', bootId: 'boot-a', restoreGeneration: 3,
}
const context = {
  actorId: 'actor-a', sessionId: 'session-a', deploymentId: 'deployment-a', bootId: 'boot-a',
  requestId: 'request-a', authorizedScope: 'scope_team-lifecycle.write', deadlineAtMs: 10_000,
}

class MutableProvider implements HostedLifecycleProviderAdapter {
  readonly providerId = 'test-provider'
  executions = 0
  expectedProviderGenerations: string[] = []
  failAfterEffect = false
  effectSnapshot: HostedLifecycleProviderSnapshot | null = null
  snapshot: HostedLifecycleProviderSnapshot = {
    providerId: this.providerId, providerGeneration: 'generation-1', phase: 'idle', runId: null, recoverable: false,
  }
  async inspect() { return { kind: 'owned' as const, snapshot: this.snapshot } }
  async execute(input: {
    action: 'launch' | 'cancel' | 'stop' | 'recover'
    expectedProviderGeneration: string
  }): Promise<HostedLifecycleProviderEffectResult> {
    this.executions += 1
    this.expectedProviderGenerations.push(input.expectedProviderGeneration)
    this.snapshot = this.effectSnapshot ?? (input.action === 'launch'
      ? { ...this.snapshot, providerGeneration: `generation-${this.executions + 1}`, phase: 'running', runId: 'run_test01' }
      : { ...this.snapshot, providerGeneration: `generation-${this.executions + 1}`, phase: 'idle', runId: null })
    if (this.failAfterEffect) throw new Error('ambiguous provider completion')
    return { kind: 'applied', snapshot: this.snapshot }
  }
}

async function fixture(provider = new MutableProvider()) {
  const root = await mkdtemp(join(tmpdir(), 'hosted-lifecycle-authority-')); roots.push(root)
  let ids = 0
  const wal = new HostedLifecycleAuthorityWal(root, teamId)
  const service = new HostedLifecycleAuthorityService({
    ...incarnation,
    wal,
    providers: new HostedLifecycleProviderRegistry([provider]),
    createId: () => `token${String(++ids).padStart(8, '0')}`,
  })
  return { root, wal, service, provider }
}

function expectedRevision(provider: MutableProvider): string {
  return createHostedLifecycleSnapshot({ ...incarnation, provider: provider.snapshot }).resourceRevision
}
function authority(provider: MutableProvider): HostedLifecycleAuthority {
  return { actorId: 'actor-a', ...incarnation, resourceRevision: expectedRevision(provider) }
}
function launchCommand(provider: MutableProvider, patch: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1 as const,
    action: 'launch' as const,
    commandId: 'lifecycle-command_command01',
    idempotencyKey: 'idempotency_command01',
    workspaceId: incarnation.workspaceId,
    teamId,
    expectedRevision: expectedRevision(provider),
    ...patch,
  }
}

describe('HostedLifecycleAuthorityService', () => {
  test('computes a canonical revision and exposes only phase-valid actions', async () => {
    const { service, provider } = await fixture()
    await expect(service.getControlState({
      request: { schemaVersion: 1, workspaceId: incarnation.workspaceId, teamId }, context, authority: authority(provider),
    })).resolves.toEqual({
      schemaVersion: 1, kind: 'control_state', workspaceId: incarnation.workspaceId, teamId,
      deploymentId: incarnation.deploymentId, bootId: incarnation.bootId, runId: null,
      resourceRevision: expectedRevision(provider), availableActions: ['launch'],
    })
  })

  test('authorizes, revalidates, compare-and-commits and replays without a second effect', async () => {
    const { service, provider } = await fixture()
    const originalAuthority = authority(provider)
    const command = launchCommand(provider)
    const authorized = await service.authorize({ command, context, authority: originalAuthority })
    expect(authorized.kind).toBe('authorized')
    if (authorized.kind !== 'authorized') throw new Error('expected authorization')
    const admittedRevision = authorized.authorization.resourceRevision
    await expect(service.revalidate({ command, authorization: authorized.authorization, context, authority: originalAuthority }))
      .resolves.toEqual({ kind: 'valid', authorization: authorized.authorization })
    const executed = await service.execute({ command, authorization: authorized.authorization, context, authority: originalAuthority })
    expect(executed.kind).toBe('result')
    if (executed.kind !== 'result') throw new Error('expected result')
    expect(executed.result).toMatchObject({ kind: 'accepted', action: 'launch', runId: 'run_test01' })
    expect(executed.result.resourceRevision).toBe(admittedRevision)

    const replayAuthorization = await service.authorize({ command, context, authority: originalAuthority })
    expect(replayAuthorization).toEqual(authorized)
    const replay = await service.execute({ command, authorization: authorized.authorization, context, authority: originalAuthority })
    expect(replay).toEqual({
      kind: 'result', authorization: authorized.authorization,
      result: { ...executed.result, kind: 'idempotent_replay' },
    })
    expect(provider.executions).toBe(1)
    expect(provider.expectedProviderGenerations).toEqual(['generation-1'])
  })

  test('keeps the remote execute receipt at the admitted revision while control state advances', async () => {
    const { service, provider } = await fixture()
    const originalAuthority = authority(provider)
    const command = launchCommand(provider)
    const admitted = await service.authorize({ command, context, authority: originalAuthority })
    if (admitted.kind !== 'authorized') throw new Error('expected authorization')

    const executed = await service.execute({
      command,
      authorization: admitted.authorization,
      context,
      authority: originalAuthority,
    })
    if (executed.kind !== 'result') throw new Error('expected result')
    const currentRevision = expectedRevision(provider)
    expect(currentRevision).not.toBe(admitted.authorization.resourceRevision)
    expect(executed.result.resourceRevision).toBe(admitted.authorization.resourceRevision)
    await expect(service.getControlState({
      request: { schemaVersion: 1, workspaceId: incarnation.workspaceId, teamId },
      context,
      authority: authority(provider),
    })).resolves.toMatchObject({
      kind: 'control_state',
      runId: 'run_test01',
      resourceRevision: currentRevision,
    })

    const replay = await service.execute({
      command,
      authorization: admitted.authorization,
      context,
      authority: originalAuthority,
    })
    expect(replay).toEqual({
      kind: 'result',
      authorization: admitted.authorization,
      result: { ...executed.result, kind: 'idempotent_replay' },
    })
    expect(provider.executions).toBe(1)
  })

  test('keeps a non-launch receipt bound to the commanded run when provider state advances to another run', async () => {
    const provider = new MutableProvider()
    provider.snapshot = {
      providerId: provider.providerId,
      providerGeneration: 'generation-failed',
      phase: 'failed',
      runId: 'run_original',
      recoverable: true,
    }
    provider.effectSnapshot = {
      providerId: provider.providerId,
      providerGeneration: 'generation-recovered',
      phase: 'running',
      runId: 'run_replacement',
      recoverable: false,
    }
    const { service } = await fixture(provider)
    const currentAuthority = authority(provider)
    const command = {
      ...launchCommand(provider),
      action: 'recover' as const,
      runId: 'run_original',
    }
    const admitted = await service.authorize({ command, context, authority: currentAuthority })
    if (admitted.kind !== 'authorized') throw new Error('expected authorization')

    const executed = await service.execute({
      command,
      authorization: admitted.authorization,
      context,
      authority: currentAuthority,
    })
    if (executed.kind !== 'result') throw new Error('expected result')
    expect(executed.result).toMatchObject({
      kind: 'accepted',
      action: 'recover',
      runId: command.runId,
      resourceRevision: admitted.authorization.resourceRevision,
    })
    await expect(service.getControlState({
      request: { schemaVersion: 1, workspaceId: incarnation.workspaceId, teamId },
      context,
      authority: authority(provider),
    })).resolves.toMatchObject({
      kind: 'control_state',
      runId: 'run_replacement',
    })
  })

  test('rejects changed idempotency payload and stale revision before any effect', async () => {
    const { service, provider } = await fixture()
    const originalAuthority = authority(provider)
    const command = launchCommand(provider)
    await service.authorize({ command, context, authority: originalAuthority })
    await expect(service.authorize({
      command: { ...command, commandId: 'lifecycle-command_changed01' }, context, authority: originalAuthority,
    })).resolves.toMatchObject({ kind: 'conflict', reason: 'idempotency_conflict' })

    const other = await fixture()
    const stale = { ...authority(other.provider), resourceRevision: `revision_${'0'.repeat(64)}` }
    await expect(other.service.authorize({
      command: { ...launchCommand(other.provider), expectedRevision: stale.resourceRevision! }, context, authority: stale,
    })).resolves.toMatchObject({ kind: 'conflict', reason: 'stale_revision' })
    expect(other.provider.executions).toBe(0)
  })

  test('binds grants to actor, session, deployment, boot and restore generation', async () => {
    const { service, provider } = await fixture()
    const currentAuthority = authority(provider)
    await expect(service.authorize({
      command: launchCommand(provider), context: { ...context, actorId: 'actor-b' }, authority: currentAuthority,
    })).resolves.toEqual({ kind: 'unavailable', retryAfterMs: null })
    const sessionGrant = await service.authorize({
      command: launchCommand(provider), context: { ...context, sessionId: 'session-b' }, authority: currentAuthority,
    })
    expect(sessionGrant).toMatchObject({ kind: 'authorized' })
    await expect(service.authorize({
      command: launchCommand(provider), context, authority: currentAuthority,
    })).resolves.toMatchObject({ kind: 'conflict', reason: 'idempotency_conflict' })
    await expect(service.authorize({
      command: launchCommand(provider), context, authority: { ...currentAuthority, restoreGeneration: 4 },
    })).resolves.toEqual({ kind: 'unavailable', retryAfterMs: null })
  })

  test('persists an ambiguous started effect and never retries it after restart', async () => {
    const { root, service, provider } = await fixture()
    const originalAuthority = authority(provider); const command = launchCommand(provider)
    const authorized = await service.authorize({ command, context, authority: originalAuthority })
    if (authorized.kind !== 'authorized') throw new Error('expected authorization')
    provider.failAfterEffect = true
    await expect(service.execute({ command, authorization: authorized.authorization, context, authority: originalAuthority }))
      .resolves.toEqual({ kind: 'unavailable', retryAfterMs: null })
    expect(provider.executions).toBe(1)

    const restarted = new HostedLifecycleAuthorityService({
      ...incarnation,
      wal: new HostedLifecycleAuthorityWal(root, teamId),
      providers: new HostedLifecycleProviderRegistry([provider]),
    })
    await expect(restarted.execute({ command, authorization: authorized.authorization, context, authority: originalAuthority }))
      .resolves.toEqual({ kind: 'unavailable', retryAfterMs: null })
    await expect(restarted.getControlState({
      request: { schemaVersion: 1, workspaceId: incarnation.workspaceId, teamId }, context, authority: originalAuthority,
    })).resolves.toEqual({ schemaVersion: 1, kind: 'unavailable', retryAfterMs: null })
    expect(provider.executions).toBe(1)
  })

  test('release is durable and prevents an unexecuted grant from being used', async () => {
    const { service, provider } = await fixture()
    const currentAuthority = authority(provider); const command = launchCommand(provider)
    const authorized = await service.authorize({ command, context, authority: currentAuthority })
    if (authorized.kind !== 'authorized') throw new Error('expected authorization')
    await expect(service.release({ command, authorization: authorized.authorization, context, authority: currentAuthority }))
      .resolves.toEqual({ kind: 'released' })
    await expect(service.revalidate({ command, authorization: authorized.authorization, context, authority: currentAuthority }))
      .resolves.toMatchObject({ kind: 'conflict', reason: 'grant_revoked' })
    expect(provider.executions).toBe(0)
  })

  test('returns unavailable when release cannot durably append its WAL record', async () => {
    const { service, provider, wal } = await fixture()
    const currentAuthority = authority(provider); const command = launchCommand(provider)
    const authorized = await service.authorize({ command, context, authority: currentAuthority })
    if (authorized.kind !== 'authorized') throw new Error('expected authorization')

    const originalAppend = wal.append.bind(wal)
    wal.append = async entry => {
      if (entry.kind === 'released') throw new Error('durable release failed')
      return originalAppend(entry)
    }
    await expect(service.release({ command, authorization: authorized.authorization, context, authority: currentAuthority }))
      .resolves.toEqual({ kind: 'unavailable', retryAfterMs: null })
    await expect(service.revalidate({ command, authorization: authorized.authorization, context, authority: currentAuthority }))
      .resolves.toEqual({ kind: 'valid', authorization: authorized.authorization })

    const lockFailure = await fixture()
    const lockAuthority = authority(lockFailure.provider)
    const lockCommand = launchCommand(lockFailure.provider)
    const lockAuthorization = await lockFailure.service.authorize({
      command: lockCommand, context, authority: lockAuthority,
    })
    if (lockAuthorization.kind !== 'authorized') throw new Error('expected authorization')
    lockFailure.wal.withLock = async () => undefined
    await expect(lockFailure.service.release({
      command: lockCommand,
      authorization: lockAuthorization.authorization,
      context,
      authority: lockAuthority,
    })).resolves.toEqual({ kind: 'unavailable', retryAfterMs: null })
  })
})

describe('HostedLifecycleProviderRegistry', () => {
  test('fails closed when more than one provider claims the same team', async () => {
    const first = new MutableProvider(); const second = new MutableProvider()
    Object.defineProperty(second, 'providerId', { value: 'other-provider' })
    second.snapshot = { ...second.snapshot, providerId: 'other-provider' }
    const registry = new HostedLifecycleProviderRegistry([first, second])
    await expect(registry.resolve({ workspaceId: incarnation.workspaceId, teamId }))
      .resolves.toEqual({ kind: 'unavailable', reason: 'ambiguous_owner' })
  })
})
