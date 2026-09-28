import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HostedLifecycleAuthority } from '../hostedControl/HostedControlDispatcher.js'
import { HostedLifecycleAuthorityWal } from '../hostedControl/HostedLifecycleAuthorityWal.js'
import type { HostedLifecycleAction, HostedLifecycleProviderSnapshot } from '../hostedControl/HostedLifecycleSnapshot.js'
import { createTeamLifecycleAuthorityComposition } from './TeamLifecycleAuthorityComposition.js'
import type { TeamLifecycleLaunchPlan, TeamLifecycleLaunchPlanStore } from './TeamLifecycleLaunchPlan.js'
import type { TeamLifecycleExecutionPort, TeamLifecycleOwnerEffectInput } from './TeamLifecycleOwnerService.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

const teamId = `team_${'a'.repeat(32)}`
const ownerEffectFence = { grantRevision: '1'.repeat(64), identityChecksum: '2'.repeat(64) }
const plan: TeamLifecycleLaunchPlan = {
  schemaVersion: 2,
  workspaceId: 'workspace-a',
  teamId,
  workspaceRoot: '/private/admitted/workspace',
  toolApprovalMode: 'manual',
  lanes: [{
    laneId: 'codex-primary', kind: 'native', provider: 'codex',
    members: [{ name: 'worker', prompt: 'Work on the admitted task.' }],
  }],
}

function durableLaunchCommand(command: {
  schemaVersion: 1; action: 'launch'; commandId: string; idempotencyKey: string
  workspaceId: string; teamId: string; expectedRevision: string
}, authorization: {
  deploymentId: string; actorId: string; bootId: string; restoreGeneration: number; mountGeneration: number
  ownerEffectFence: typeof ownerEffectFence
}) {
  const digest = createHash('sha256').update(JSON.stringify([
    'agent-teams.hosted-lifecycle-command/v1', command.schemaVersion, command.action,
    command.commandId, command.idempotencyKey, command.workspaceId, command.teamId,
    command.expectedRevision, null, authorization.ownerEffectFence.grantRevision,
    authorization.ownerEffectFence.identityChecksum,
  ])).digest('hex')
  return {
    schemaVersion: 1,
    commandFingerprint: { algorithm: 'sha256', version: 1, digest },
    idempotency: { deploymentId: authorization.deploymentId, actorId: authorization.actorId, action: command.action, idempotencyKey: command.idempotencyKey },
    resource: { bootId: authorization.bootId, workspaceId: command.workspaceId, teamId: command.teamId, runId: null, expectedRevision: command.expectedRevision, restoreGeneration: authorization.restoreGeneration, mountGeneration: authorization.mountGeneration, ownerEffectFence: authorization.ownerEffectFence },
  }
}

class Store implements TeamLifecycleLaunchPlanStore {
  currentGeneration = `plan-generation_${'a'.repeat(64)}`
  replaceAfterNextLoad = false

  async load(scope: { workspaceId: string; teamId: string }) {
    if (scope.workspaceId !== plan.workspaceId || scope.teamId !== plan.teamId) return null
    const planGeneration = this.currentGeneration
    const admittedPlan = planGeneration.endsWith('a'.repeat(64))
      ? plan
      : {
          ...plan,
          lanes: [{
            laneId: 'anthropic-primary', kind: 'native' as const, provider: 'anthropic' as const,
            members: [{ name: 'worker', prompt: 'Work on the admitted task.' }],
          }],
        }
    const admission = {
      plan: admittedPlan,
      planGeneration,
      isCurrent: async () => this.currentGeneration === planGeneration,
    }
    if (this.replaceAfterNextLoad) {
      this.replaceAfterNextLoad = false
      this.currentGeneration = `plan-generation_${'b'.repeat(64)}`
    }
    return admission
  }
}

class Execution implements TeamLifecycleExecutionPort {
  launches = 0
  state: HostedLifecycleProviderSnapshot = {
    providerId: 'team-lifecycle-owner',
    providerGeneration: 'generation-1',
    phase: 'idle',
    runId: null,
    recoverable: false,
  }
  supports(_plan: TeamLifecycleLaunchPlan, _action: HostedLifecycleAction): boolean { return true }
  async inspect() { return this.state }
  async launch(_input: TeamLifecycleOwnerEffectInput) {
    this.launches += 1
    this.state = { ...this.state, providerGeneration: 'generation-2', phase: 'running', runId: 'run-created' }
    return this.state
  }
  async cancel(_input: TeamLifecycleOwnerEffectInput) { return this.state }
  async stop(_input: TeamLifecycleOwnerEffectInput) { return this.state }
  async recover(_input: TeamLifecycleOwnerEffectInput) { return this.state }
}

describe('createTeamLifecycleAuthorityComposition', () => {
  test('registers one private-plan owner behind the durable hosted authority', async () => {
    const root = await mkdtemp(join(tmpdir(), 'team-lifecycle-composition-'))
    roots.push(root)
    const execution = new Execution()
    const composition = createTeamLifecycleAuthorityComposition({
      workspaceId: plan.workspaceId,
      teamId,
      deploymentId: 'deployment-a',
      bootId: 'boot-a',
      restoreGeneration: 1,
      wal: new HostedLifecycleAuthorityWal(root, teamId),
      planStore: new Store(),
      execution,
    })
    const owner = await composition.providers.resolve({ workspaceId: plan.workspaceId, teamId })
    expect(owner.kind).toBe('owned')

    const authority: HostedLifecycleAuthority = {
      actorId: 'actor-a',
      workspaceId: plan.workspaceId,
      teamId,
      deploymentId: 'deployment-a',
      bootId: 'boot-a',
      restoreGeneration: 1,
      mountGeneration: 1,
      resourceRevision: 'revision-before-read',
      ownerEffectFence,
    }
    const state = await composition.authority.getControlState({
      request: { schemaVersion: 1, workspaceId: plan.workspaceId, teamId },
      context: {
        actorId: 'actor-a', sessionId: 'session-a', deploymentId: 'deployment-a', bootId: 'boot-a',
        requestId: 'request-a', authorizedScope: 'scope_hosted-lifecycle-control-state', deadlineAtMs: Date.now() + 1_000,
      },
      authority,
    })
    expect(state.kind).toBe('control_state')
    expect(state.availableActions).toEqual(['launch'])
  })

  test('rejects a plan replacement between authority admission and owner execution before any effect', async () => {
    const root = await mkdtemp(join(tmpdir(), 'team-lifecycle-plan-fence-'))
    roots.push(root)
    const store = new Store()
    const execution = new Execution()
    const { authority: service } = createTeamLifecycleAuthorityComposition({
      workspaceId: plan.workspaceId,
      teamId,
      deploymentId: 'deployment-a',
      bootId: 'boot-a',
      restoreGeneration: 1,
      wal: new HostedLifecycleAuthorityWal(root, teamId),
      planStore: store,
      execution,
      createId: () => 'token00000001',
    })
    const context = {
      actorId: 'actor-a', sessionId: 'session-a', deploymentId: 'deployment-a', bootId: 'boot-a',
      requestId: 'request-a', authorizedScope: 'scope_hosted-lifecycle-command', deadlineAtMs: Date.now() + 10_000,
    }
    const initialAuthority: HostedLifecycleAuthority = {
      actorId: 'actor-a', workspaceId: plan.workspaceId, teamId, deploymentId: 'deployment-a', bootId: 'boot-a',
      restoreGeneration: 1, mountGeneration: 1, resourceRevision: 'revision-before-read', ownerEffectFence,
    }
    const state = await service.getControlState({
      request: { schemaVersion: 1, workspaceId: plan.workspaceId, teamId },
      context: { ...context, authorizedScope: 'scope_hosted-lifecycle-control-state' },
      authority: initialAuthority,
    })
    if (typeof state.resourceRevision !== 'string') throw new Error('expected lifecycle revision')
    const currentAuthority = { ...initialAuthority, resourceRevision: state.resourceRevision }
    const command = {
      schemaVersion: 1 as const,
      action: 'launch' as const,
      commandId: 'lifecycle-command_plan-swap',
      idempotencyKey: 'idempotency_plan-swap',
      workspaceId: plan.workspaceId,
      teamId,
      expectedRevision: state.resourceRevision,
    }
    const authorized = await service.authorize({ command, context, authority: currentAuthority })
    if (authorized.kind !== 'authorized') throw new Error('expected authorization')

    // The authority resolve sees admission A, then the path atomically advances to B before adapter.execute.
    store.replaceAfterNextLoad = true
    await expect(service.execute({
      command, authorization: authorized.authorization,
      durableCommand: durableLaunchCommand(command, authorized.authorization),
      context, authority: currentAuthority,
    })).resolves.toEqual({ kind: 'unavailable', retryAfterMs: null })
    expect(execution.launches).toBe(0)
  })
})
