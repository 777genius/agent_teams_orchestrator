import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  HostedLifecycleCommandService,
  type HostedLifecycleAuthorityEffectPort,
} from './HostedLifecycleCommandService.js'
import type { HostedLifecycleAuthority } from './HostedControlDispatcher.js'

const authority: HostedLifecycleAuthority = {
  actorId: 'actor-a',
  workspaceId: 'workspace-a',
  teamId: `team_${'a'.repeat(32)}`,
  deploymentId: 'deployment-a',
  restoreGeneration: 2,
  bootId: 'boot-a',
  resourceRevision: 'revision_1',
  mountGeneration: 1,
  ownerEffectFence: { grantRevision: '1'.repeat(64), identityChecksum: '2'.repeat(64) },
}
const command = {
  schemaVersion: 1,
  action: 'launch',
  commandId: 'lifecycle-command_command01',
  idempotencyKey: 'idempotency_command01',
  workspaceId: authority.workspaceId,
  teamId: authority.teamId,
  expectedRevision: 'revision_1',
}
const context = {
  actorId: authority.actorId,
  sessionId: 'session-a',
  deploymentId: authority.deploymentId,
  bootId: authority.bootId,
  requestId: 'request-a',
  authorizedScope: 'scope_team-lifecycle.write',
  deadlineAtMs: 10_000,
}
const authorization = {
  grantId: 'grant_command01',
  authorizationGeneration: 'authorization-generation_command01',
  deploymentId: authority.deploymentId,
  bootId: authority.bootId,
  resourceRevision: 'revision_1',
  actorId: authority.actorId,
  workspaceId: authority.workspaceId,
  teamId: authority.teamId,
  restoreGeneration: authority.restoreGeneration,
  mountGeneration: authority.mountGeneration,
  ownerEffectFence: authority.ownerEffectFence,
}
const durableCommand = {
  schemaVersion: 1,
  commandFingerprint: {
    algorithm: 'sha256', version: 1,
    digest: createHash('sha256').update(JSON.stringify([
      'agent-teams.hosted-lifecycle-command/v1', command.schemaVersion, command.action,
      command.commandId, command.idempotencyKey, command.workspaceId, command.teamId,
      command.expectedRevision, null, authority.ownerEffectFence.grantRevision,
      authority.ownerEffectFence.identityChecksum,
    ])).digest('hex'),
  },
  idempotency: { deploymentId: authority.deploymentId, actorId: authority.actorId, action: command.action, idempotencyKey: command.idempotencyKey },
  resource: { bootId: authority.bootId, workspaceId: authority.workspaceId, teamId: authority.teamId, runId: null, expectedRevision: command.expectedRevision, restoreGeneration: authority.restoreGeneration, mountGeneration: authority.mountGeneration, ownerEffectFence: authority.ownerEffectFence },
}

function effects(overrides: Partial<HostedLifecycleAuthorityEffectPort> = {}) {
  let executions = 0
  let releases = 0
  const value: HostedLifecycleAuthorityEffectPort = {
    getControlState: async () => ({ schemaVersion: 1, kind: 'not_found' }),
    authorize: async () => ({ kind: 'authorized', authorization }),
    revalidate: async () => ({ kind: 'valid', authorization }),
    execute: async () => {
      executions += 1
      return {
        kind: 'result',
        authorization,
        result: {
          schemaVersion: 1,
          kind: 'accepted',
          action: 'launch',
          commandId: command.commandId,
          workspaceId: authority.workspaceId,
          teamId: authority.teamId,
          runId: 'run_command01',
          resourceRevision: 'revision_1',
        },
      }
    },
    release: async () => { releases += 1; return { kind: 'released' } },
    ...overrides,
  }
  return { value, executions: () => executions, releases: () => releases }
}

describe('HostedLifecycleCommandService', () => {
  test('preserves a fail-closed unavailable control state without requiring a revision', async () => {
    const fixture = effects({
      getControlState: async () => ({ schemaVersion: 2, kind: 'unavailable', retryAfterMs: null }),
    })
    const service = new HostedLifecycleCommandService(fixture.value, { isCurrent: () => true }, () => 1)
    await expect(service.dispatch({
      operation: 'control_state',
      payload: {
        request: { schemaVersion: 1, workspaceId: authority.workspaceId, teamId: authority.teamId },
        context,
        authority,
      },
      authority,
    })).resolves.toEqual({
      payload: { schemaVersion: 2, kind: 'unavailable', retryAfterMs: null },
      resourceRevision: null,
    })
  })

  test('returns the exact authorization and resource revision', async () => {
    const fixture = effects()
    const service = new HostedLifecycleCommandService(fixture.value, { isCurrent: () => true }, () => 1)
    await expect(service.dispatch({
      operation: 'authorize',
      payload: { command, context, authority },
      authority,
    })).resolves.toEqual({
      payload: { schemaVersion: 2, kind: 'authorized', authorization },
      resourceRevision: 'revision_1',
    })
  })

  test('supports canonical prepare and get_status while retaining prototype aliases', async () => {
    const fixture = effects({
      prepareProvisioning: async () => ({
        schemaVersion: 1, kind: 'prepared', workspaceId: authority.workspaceId, teamId: authority.teamId,
        deploymentId: authority.deploymentId, bootId: authority.bootId, runId: null,
        resourceRevision: 'revision_1', availableActions: ['launch'],
        lanes: [{ laneKey: `owner:${authority.teamId}`, backend: 'opencode', status: 'ready' }],
      }),
      getProvisioningStatus: async () => ({
        schemaVersion: 1, kind: 'provisioning_status', workspaceId: authority.workspaceId, teamId: authority.teamId,
        deploymentId: authority.deploymentId, bootId: authority.bootId, runId: null,
        resourceRevision: 'revision_1', availableActions: ['launch'], recentCommands: [],
      }),
    })
    const service = new HostedLifecycleCommandService(fixture.value, { isCurrent: () => true }, () => 1)
    const payload = {
      request: { schemaVersion: 1, workspaceId: authority.workspaceId, teamId: authority.teamId },
      context, authority,
    }
    await expect(service.dispatch({ operation: 'prepare', payload, authority })).resolves.toMatchObject({
      payload: { kind: 'prepared' }, resourceRevision: 'revision_1',
    })
    await expect(service.dispatch({ operation: 'get_status', payload, authority })).resolves.toMatchObject({
      payload: { kind: 'status', recentCommands: [] }, resourceRevision: 'revision_1',
    })
    await expect(service.dispatch({ operation: 'get_provisioning_status', payload, authority })).resolves.toMatchObject({
      payload: { kind: 'provisioning_status' }, resourceRevision: 'revision_1',
    })
  })

  test('revalidates immediately before execute and performs no effect for a stale grant', async () => {
    const fixture = effects({
      revalidate: async () => ({
        kind: 'conflict', reason: 'authorization_changed', currentRevision: 'revision_2',
      }),
    })
    const service = new HostedLifecycleCommandService(fixture.value, { isCurrent: () => true }, () => 1)
    await expect(service.dispatch({
      operation: 'execute',
      payload: { command, authorization, durableCommand, context, authority },
      authority,
    })).resolves.toEqual({
      payload: { schemaVersion: 2, kind: 'unavailable', retryAfterMs: null },
      resourceRevision: null,
    })
    expect(fixture.executions()).toBe(0)
  })

  test('executes only after an identical fresh authorization fence', async () => {
    const fixture = effects()
    const service = new HostedLifecycleCommandService(fixture.value, { isCurrent: () => true }, () => 1)
    const result = await service.dispatch({
      operation: 'execute',
      payload: { command, authorization, durableCommand, context, authority },
      authority,
    })
    expect(result.payload).toMatchObject({ kind: 'settled', durableCommand })
    expect(result.resourceRevision).toBe('revision_1')
    expect(fixture.executions()).toBe(1)
  })

  test('releases the authority snapshot and clears the response revision', async () => {
    const fixture = effects()
    const service = new HostedLifecycleCommandService(fixture.value, { isCurrent: () => true }, () => 1)
    await expect(service.dispatch({
      operation: 'release',
      payload: { command, authorization, context, authority },
      authority,
    })).resolves.toEqual({
      payload: { schemaVersion: 2, kind: 'released', authorization },
      resourceRevision: 'revision_1',
    })
    expect(fixture.releases()).toBe(1)
  })

  test('does not claim release when durable release fails or authority changes after the effect', async () => {
    const failed = effects({ release: async () => ({ kind: 'unavailable', retryAfterMs: null }) })
    const failedService = new HostedLifecycleCommandService(failed.value, { isCurrent: () => true }, () => 1)
    await expect(failedService.dispatch({
      operation: 'release', payload: { command, authorization, context, authority }, authority,
    })).resolves.toEqual({
      payload: { schemaVersion: 2, kind: 'unavailable', retryAfterMs: null }, resourceRevision: null,
    })

    let checks = 0
    const changed = effects()
    const changedService = new HostedLifecycleCommandService(changed.value, {
      isCurrent: () => ++checks === 1,
    }, () => 1)
    await expect(changedService.dispatch({
      operation: 'release', payload: { command, authorization, context, authority }, authority,
    })).resolves.toEqual({
      payload: { schemaVersion: 2, kind: 'unavailable', retryAfterMs: null }, resourceRevision: null,
    })
    expect(changed.releases()).toBe(1)

    let now = 1
    const expired = effects({ release: async () => { now = context.deadlineAtMs; return { kind: 'released' } } })
    const expiredService = new HostedLifecycleCommandService(expired.value, { isCurrent: () => true }, () => now)
    await expect(expiredService.dispatch({
      operation: 'release', payload: { command, authorization, context, authority }, authority,
    })).resolves.toEqual({
      payload: { schemaVersion: 2, kind: 'unavailable', retryAfterMs: null }, resourceRevision: null,
    })
  })

  test('uses control-state schema v1 for pre-effect and post-effect guard failures', async () => {
    const request = {
      operation: 'control_state' as const,
      payload: {
        request: { schemaVersion: 1, workspaceId: authority.workspaceId, teamId: authority.teamId },
        context,
        authority,
      },
      authority,
    }
    const denied = new HostedLifecycleCommandService(effects().value, { isCurrent: () => false }, () => 1)
    await expect(denied.dispatch(request)).resolves.toEqual({
      payload: { schemaVersion: 1, kind: 'unavailable', retryAfterMs: null }, resourceRevision: null,
    })

    let checks = 0
    const changed = new HostedLifecycleCommandService(effects().value, {
      isCurrent: () => ++checks === 1,
    }, () => 1)
    await expect(changed.dispatch(request)).resolves.toEqual({
      payload: { schemaVersion: 1, kind: 'unavailable', retryAfterMs: null }, resourceRevision: null,
    })
  })

  test('does not call any authority effect after owner denial or deadline expiry', async () => {
    let calls = 0
    const fixture = effects({ authorize: async () => { calls += 1; return { kind: 'not_found' } } })
    const denied = new HostedLifecycleCommandService(fixture.value, { isCurrent: () => false }, () => 1)
    const expired = new HostedLifecycleCommandService(fixture.value, { isCurrent: () => true }, () => 10_000)
    for (const service of [denied, expired]) {
      const result = await service.dispatch({ operation: 'authorize', payload: { command, context, authority }, authority })
      expect(result.payload.kind).toBe('unavailable')
    }
    expect(calls).toBe(0)
  })

  test('preserves conflict and idempotent result decisions from the sole authority', async () => {
    const conflictFixture = effects({
      authorize: async () => ({ kind: 'conflict', reason: 'idempotency_mismatch', currentRevision: 'revision_1' }),
    })
    const service = new HostedLifecycleCommandService(conflictFixture.value, { isCurrent: () => true }, () => 1)
    const result = await service.dispatch({ operation: 'authorize', payload: { command, context, authority }, authority })
    expect(result).toEqual({
      payload: { schemaVersion: 2, kind: 'conflict', reason: 'idempotency_mismatch', currentRevision: 'revision_1' },
      resourceRevision: 'revision_1',
    })
  })
})
