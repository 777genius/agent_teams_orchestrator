import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import type { HostedLifecycleAuthority } from './HostedControlDispatcher.js'
import {
  OpenCodeTeamLifecycleLane,
  type TeamLifecycleLaneEffectPort,
} from '../teamLifecycleOwner/OpenCodeTeamLifecycleLane.js'
import { TEAM_LEAD_NAME } from '../../utils/swarm/constants.js'
import type { HostedControlRuntimePortFactory, HostedControlRuntimePorts } from './HostedControlRuntime.js'
import {
  HOSTED_OPENCODE_LAUNCH_CAPABILITY_DIRECTORY,
  HostedOpenCodeLaunchCapabilityStore,
} from './HostedOpenCodeLaunchCapabilityStore.js'
import { createHostedPersonalHostLocalPortFactory } from './HostedPersonalHostLocalComposition.js'
import type { HostedTeamLeadInboxPumpOptions } from './HostedTeamLeadInboxPump.js'
import {
  createHostedControlProductionPortFactory,
  createHostedControlProductionPorts,
  HOSTED_LIFECYCLE_EXECUTION_STATE_FILE,
  HOSTED_LIFECYCLE_PLAN_FILE,
  HOSTED_MESSAGE_DIRECTORY,
  HOSTED_APPROVAL_RUNTIME_ADMISSION_FILE,
  OPEN_CODE_HOSTED_APPROVAL_ATOMIC_REPLY_SUPPORTED,
} from './HostedControlProductionComposition.js'
import type { HostedControlRuntimePortFactoryContext } from './HostedControlRuntime.js'
import type { HostedApprovalActivationConnection } from './HostedApprovalActivationSession.js'
import { HostedApprovalActivatablePort } from './HostedApprovalActivatablePort.js'
import {
  HOSTED_APPROVAL_ACTIVATION_CAPABILITY,
  createHostedApprovalActivationV2Proof,
} from './HostedApprovalRuntimeActivation.js'

const roots: string[] = []
const teamId = `team_${'a'.repeat(32)}`
const stableAuthority = {
  deploymentId: 'deployment-a',
  bootId: 'boot-a',
  restoreGeneration: 1,
  workspaceId: 'workspace-a',
  mountBinding: { mountGeneration: 1, declaredRootHash: 'b'.repeat(64) },
  teamId,
}
const lifecycleAuthority: HostedLifecycleAuthority = {
  actorId: 'actor-a',
  workspaceId: stableAuthority.workspaceId,
  teamId,
  deploymentId: stableAuthority.deploymentId,
  bootId: stableAuthority.bootId,
  restoreGeneration: stableAuthority.restoreGeneration,
  resourceRevision: null,
  mountGeneration: stableAuthority.mountBinding.mountGeneration,
  ownerEffectFence: {
    grantRevision: '1'.repeat(64),
    identityChecksum: '2'.repeat(64),
  },
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('createHostedControlProductionPorts', () => {
  test('read-only plan admission uses the canonical private team-root file and exact digest', async () => {
    const teamRoot = await makeTeamRoot('hosted-production-plan-admission-')
    await writePlan(teamRoot, 'opencode')
    const ports = await createHostedControlProductionPorts(context(teamRoot))
    const raw = await readFile(join(teamRoot, HOSTED_LIFECYCLE_PLAN_FILE))
    const expectedPlanGeneration = `plan-generation_${createHash('sha256').update(raw).digest('hex')}`
    const input = controlStateInput()
    const planRequest = {
      ...input,
      operation: 'admit_launch_plan' as const,
      payload: { ...input.payload, request: {
        schemaVersion: 1, workspaceId: stableAuthority.workspaceId, teamId,
        workspaceRoot: join(teamRoot, 'sandbox-workspace'), expectedPlanGeneration,
      } },
    }
    await expect(ports.lifecycle.dispatch(planRequest)).resolves.toEqual({
      payload: { schemaVersion: 1, kind: 'admitted', workspaceId: stableAuthority.workspaceId,
        teamId, planGeneration: expectedPlanGeneration },
      resourceRevision: null,
    })
    await expect(ports.lifecycle.dispatch({ ...planRequest, payload: { ...planRequest.payload,
      request: { ...planRequest.payload.request, workspaceRoot: join(teamRoot, 'other-workspace') } } }))
      .resolves.toMatchObject({ payload: { kind: 'unavailable' } })
    expect(await readdir(teamRoot)).not.toContain(HOSTED_LIFECYCLE_EXECUTION_STATE_FILE)
  })

  test('normal production composition starts capability-false until trusted approval authority is published', async () => {
    const teamRoot = await makeTeamRoot('hosted-production-missing-approval-admission-')
    await writePlan(teamRoot, 'opencode')
    const ports = await createHostedControlProductionPorts(context(teamRoot))
    expect(ports.approvals).toBeUndefined()
    expect((await ports.lifecycle.dispatch(controlStateInput())).payload.kind).toBe('unavailable')
  })

  test('does not treat an ambient legacy admission file as activation authority', async () => {
    const teamRoot = await makeTeamRoot('hosted-production-malformed-approval-admission-')
    await writePlan(teamRoot, 'opencode')
    await writeFile(join(teamRoot, HOSTED_APPROVAL_RUNTIME_ADMISSION_FILE), '{}', { mode: 0o600 })
    const ports = await createHostedControlProductionPorts(context(teamRoot))
    expect(ports.approvals).toBeUndefined()
    expect(ports.activationSessionFactory).toBeUndefined()
  })

  test('keeps the pinned candidate capability-false pending the no-fake sandbox E2E', async () => {
    expect(OPEN_CODE_HOSTED_APPROVAL_ATOMIC_REPLY_SUPPORTED).toBe(false)
    const teamRoot = await makeTeamRoot('hosted-production-composition-')
    await writePlan(teamRoot, 'opencode')
    await writeApprovalAdmission(teamRoot)
    const ports = await createHostedControlProductionPorts(context(teamRoot))
    expect(ports.approvals).toBeUndefined()

    const state = await ports.lifecycle.dispatch(controlStateInput())
    expect(state.payload).toMatchObject({ kind: 'unavailable' })
    expect((await ports.lifecycle.dispatch(launchAuthorizeInput())).payload).toMatchObject({
      kind: 'unavailable',
    })

    const persisted = await ports.messages.dispatch({
      operation: 'message_persist',
      authority: { actorId: 'actor-a', ...stableAuthority },
      payload: {
        schemaVersion: 1,
        teamId,
        clientMessageId: 'client_message_production-test',
        text: 'persist me',
      },
    })
    expect(persisted.kind).toBe('persisted')
    expect(await readdir(join(teamRoot, HOSTED_MESSAGE_DIRECTORY))).toHaveLength(1)
    expect(await readdir(teamRoot)).not.toContain(HOSTED_LIFECYCLE_EXECUTION_STATE_FILE)
  })

  test('keeps native lanes capability-false and never creates a missing plan', async () => {
    const teamRoot = await makeTeamRoot('hosted-production-native-')
    await writePlan(teamRoot, 'native')
    await writeApprovalAdmission(teamRoot)
    const native = await createHostedControlProductionPorts(context(teamRoot))
    expect((await native.lifecycle.dispatch(controlStateInput())).payload.kind).toBe('unavailable')

    await rm(join(teamRoot, HOSTED_LIFECYCLE_PLAN_FILE))
    const missing = await createHostedControlProductionPorts(context(teamRoot))
    expect((await missing.lifecycle.dispatch(controlStateInput())).payload.kind).toBe('unavailable')
    expect(await readdir(teamRoot)).not.toContain(HOSTED_LIFECYCLE_PLAN_FILE)
  })

  test('does not dispatch Launch to an injected isolated lane before its own capability is ready', async () => {
    const teamRoot = await makeTeamRoot('hosted-production-isolated-unready-')
    await writePlan(teamRoot, 'opencode')
    let launches = 0
    const lane: TeamLifecycleLaneEffectPort = {
      kind: 'opencode',
      supports: () => false,
      inspect: async () => ({ phase: 'idle', recoverable: false }),
      launch: async () => {
        launches += 1
        throw new Error('unready isolated lane must not launch')
      },
      cancel: async () => ({ phase: 'idle', recoverable: false }),
      stop: async () => ({ phase: 'idle', recoverable: false }),
      recover: async () => ({ phase: 'idle', recoverable: false }),
    }
    const createPorts = createHostedControlProductionPortFactory(async received => {
      expect(received.teamRoot).toBe(teamRoot)
      expect(received.authority.teamId).toBe(teamId)
      return lane
    })
    const ports = await createPorts(context(teamRoot))
    expect((await ports.lifecycle.dispatch(controlStateInput())).payload.kind).toBe('unavailable')
    expect((await ports.lifecycle.dispatch(launchAuthorizeInput())).payload.kind).toBe('unavailable')
    expect(launches).toBe(0)
    expect(await readdir(teamRoot)).not.toContain(HOSTED_LIFECYCLE_EXECUTION_STATE_FILE)
    await ports.close()
  })

  test('requires Product reservation before a capable production lane can launch', async () => {
    const teamRoot = await makeTeamRoot('hosted-production-run-reservation-')
    await writePlan(teamRoot, 'opencode')
    const launches: string[] = []
    const lane: TeamLifecycleLaneEffectPort = {
      kind: 'opencode', supports: () => true,
      inspect: async input => ({ phase: input.runId ? 'running' : 'idle', recoverable: false }),
      launch: async input => { launches.push(input.runId); return { phase: 'running', recoverable: false } },
      cancel: async () => ({ phase: 'idle', recoverable: false }),
      stop: async () => ({ phase: 'idle', recoverable: false }),
      recover: async () => ({ phase: 'idle', recoverable: false }),
    }
    const ports = await createHostedControlProductionPortFactory(async () => lane)(context(teamRoot))
    const state = (await ports.lifecycle.dispatch(controlStateInput())).payload
    expect(state.kind).toBe('control_state')
    const command = {
      ...launchAuthorizeInput().payload.command,
      expectedRevision: state.resourceRevision as string,
    }
    const currentAuthority = { ...lifecycleAuthority, resourceRevision: command.expectedRevision }
    const commandContext = {
      ...controlStateInput().payload.context,
      authorizedScope: 'scope_hosted-lifecycle-command',
    }
    const authorized = (await ports.lifecycle.dispatch({
      operation: 'authorize', authority: currentAuthority,
      payload: { command, context: commandContext, authority: currentAuthority },
    })).payload
    expect(authorized.kind).toBe('authorized')
    const authorization = authorized.authorization as Record<string, unknown>
    const runId = `run_${'c'.repeat(32)}`
    const fingerprint = createHash('sha256').update(JSON.stringify([
      'agent-teams.hosted-lifecycle-command/v1', 1, 'launch', command.commandId,
      command.idempotencyKey, command.workspaceId, command.teamId, command.expectedRevision,
      runId, lifecycleAuthority.ownerEffectFence.grantRevision,
      lifecycleAuthority.ownerEffectFence.identityChecksum,
    ])).digest('hex')
    const durableCommand = {
      schemaVersion: 1,
      commandFingerprint: { algorithm: 'sha256', version: 1, digest: fingerprint },
      idempotency: { deploymentId: stableAuthority.deploymentId, actorId: lifecycleAuthority.actorId,
        action: 'launch', idempotencyKey: command.idempotencyKey },
      resource: { bootId: stableAuthority.bootId, workspaceId: command.workspaceId, teamId,
        runId, expectedRevision: command.expectedRevision, restoreGeneration: stableAuthority.restoreGeneration,
        mountGeneration: stableAuthority.mountBinding.mountGeneration,
        ownerEffectFence: lifecycleAuthority.ownerEffectFence },
    }
    const rejected = (await ports.lifecycle.dispatch({
      operation: 'execute', authority: currentAuthority,
      payload: { command, authorization, durableCommand, context: commandContext,
        authority: currentAuthority },
    })).payload
    expect(rejected.kind).toBe('unavailable')
    expect(launches).toEqual([])
    expect(await readdir(teamRoot)).not.toContain(HOSTED_LIFECYCLE_EXECUTION_STATE_FILE)
    expect(await readFile(join(teamRoot, 'hosted-lifecycle-authority.wal.v1.jsonl'), 'utf8'))
      .not.toContain('"kind":"started"')
    await ports.close()
  })

  test('a launch outlives its command deadline but not the owner authority that admitted it', async () => {
    for (const ownerLost of [false, true]) {
      const teamRoot = await makeTeamRoot(`hosted-production-long-launch-${ownerLost}-`)
      await writePlan(teamRoot, 'opencode')
      let ownerCurrent = true
      let deadlineAtMs = 0
      const actions: string[] = []
      const lane = fakeLane({
        launch: async () => {
          actions.push('launch')
          // Readiness plus launch outlive the command's deadline;
          // the owner may also lose its epoch meanwhile.
          await Bun.sleep(Math.max(0, deadlineAtMs - Date.now()) + 50)
          if (ownerLost) ownerCurrent = false
          return { phase: 'running', recoverable: false }
        },
        stop: async () => { actions.push('stop'); return { phase: 'idle', recoverable: false } },
      })
      const ports = await createHostedControlProductionPortFactory(async () => lane)({
        ...context(teamRoot),
        isCurrentAuthority: async () => ownerCurrent,
      })
      const { request } = await reservedLaunchRequest(ports, teamRoot)
      // Generous enough that a loaded runner still starts the effect before it expires.
      deadlineAtMs = Date.now() + 1_000
      const expiring = { ...request, payload: { ...request.payload,
        context: { ...request.payload.context, deadlineAtMs } } }
      expect((await ports.lifecycle.dispatch(expiring)).payload.kind).toBe('settled')
      const settledAt = Date.now()
      let state: Record<string, unknown> = {}
      while (Date.now() - settledAt < 3_000) {
        state = JSON.parse(await readFile(join(teamRoot, HOSTED_LIFECYCLE_EXECUTION_STATE_FILE), 'utf8')
          .catch(() => '{}'))
        if (ownerLost ? state.phase === 'failed' && actions.includes('stop') : Date.now() > deadlineAtMs + 300) break
        await Bun.sleep(25)
      }
      if (ownerLost) {
        expect(state).toMatchObject({ phase: 'failed',
          failure: { action: 'launch', message: 'Team lifecycle effect authority changed' } })
        expect(actions).toEqual(['launch', 'stop'])
      } else {
        expect(state.phase).toBe('running')
        expect(actions).toEqual(['launch'])
      }
      ownerCurrent = true
      await ports.close()
    }
  })

  test('starts and replays only the exact Product reserved run in production', async () => {
    const teamRoot = await makeTeamRoot('hosted-production-reserved-run-')
    await writePlan(teamRoot, 'opencode')
    const launches: string[] = []
    let releaseLaunch!: () => void
    const launchCompletion = new Promise<void>(resolve => { releaseLaunch = resolve })
    const lane: TeamLifecycleLaneEffectPort = {
      kind: 'opencode', supports: () => true,
      inspect: async input => ({ phase: input.runId ? 'running' : 'idle', recoverable: false }),
      launch: async input => { launches.push(input.runId); await launchCompletion;
        return { phase: 'running', recoverable: false } },
      cancel: async () => ({ phase: 'idle', recoverable: false }),
      stop: async () => ({ phase: 'idle', recoverable: false }),
      recover: async () => ({ phase: 'idle', recoverable: false }),
    }
    const ports = await createHostedControlProductionPortFactory(async () => lane)(context(teamRoot))
    const state = (await ports.lifecycle.dispatch(controlStateInput())).payload
    expect(state.kind).toBe('control_state')
    const command = { ...launchAuthorizeInput().payload.command,
      expectedRevision: state.resourceRevision as string }
    const currentAuthority = { ...lifecycleAuthority, resourceRevision: command.expectedRevision }
    const commandContext = { ...controlStateInput().payload.context,
      authorizedScope: 'scope_hosted-lifecycle-command' }
    const authorized = (await ports.lifecycle.dispatch({ operation: 'authorize', authority: currentAuthority,
      payload: { command, context: commandContext, authority: currentAuthority } })).payload
    expect(authorized.kind).toBe('authorized')
    const authorization = authorized.authorization as Record<string, unknown>
    const runId = `run_${'c'.repeat(32)}`
    const planSha256 = createHash('sha256').update(await readFile(join(teamRoot, HOSTED_LIFECYCLE_PLAN_FILE))).digest('hex')
    const runReservation = {
      schemaVersion: 1 as const, workspaceId: `workspace_${'3'.repeat(32)}`,
      runtimeWorkspaceId: stableAuthority.workspaceId, teamId,
      actorId: currentAuthority.actorId, deploymentId: stableAuthority.deploymentId,
      bootId: stableAuthority.bootId, commandId: command.commandId,
      idempotencyKey: command.idempotencyKey, expectedRevision: command.expectedRevision,
      expectedPlanGeneration: `plan-generation_${planSha256}`,
      ownerAuthority: 'owner-authority_test-owner', ownerGeneration: 1,
      ownerSessionId: 'owner-session_test-owner',
      restoreGeneration: stableAuthority.restoreGeneration,
      mountGeneration: stableAuthority.mountBinding.mountGeneration,
      ownerEffectFence: currentAuthority.ownerEffectFence,
      authorityEvidence: { userId: 'user_test-user', sessionId: 'session_test-user', grantGeneration: 1 },
      runId, promotionOperationId: `promotion_${'1'.repeat(32)}`,
      planSha256, rosterBindingSha256: '2'.repeat(64), createdAtMs: Date.now(),
    }
    const digest = createHash('sha256').update(JSON.stringify([
      'agent-teams.hosted-lifecycle-command/v1', 1, 'launch', command.commandId,
      command.idempotencyKey, command.workspaceId, command.teamId, command.expectedRevision,
      runId, currentAuthority.ownerEffectFence.grantRevision,
      currentAuthority.ownerEffectFence.identityChecksum,
    ])).digest('hex')
    const durableCommand = {
      schemaVersion: 1,
      commandFingerprint: { algorithm: 'sha256', version: 1, digest },
      idempotency: { deploymentId: stableAuthority.deploymentId, actorId: currentAuthority.actorId,
        action: 'launch', idempotencyKey: command.idempotencyKey },
      resource: { bootId: stableAuthority.bootId, workspaceId: command.workspaceId, teamId,
        runId, expectedRevision: command.expectedRevision, restoreGeneration: stableAuthority.restoreGeneration,
        mountGeneration: stableAuthority.mountBinding.mountGeneration,
        ownerEffectFence: currentAuthority.ownerEffectFence },
    }
    const request = { operation: 'execute' as const, authority: currentAuthority,
      payload: { command, authorization, durableCommand, runReservation,
        context: commandContext, authority: currentAuthority } }
    const first = (await ports.lifecycle.dispatch(request)).payload
    expect(first.kind).toBe('settled')
    expect((first.result as { runId: string }).runId).toBe(runId)
    const replay = (await ports.lifecycle.dispatch(request)).payload
    expect((replay.result as { runId: string }).runId).toBe(runId)
    expect(launches).toEqual([runId])
    releaseLaunch()
    await ports.close()
  })

  test('does not recover or wake the host-local inbox executor for a persisted hosted message', async () => {
    const teamRoot = await makeTeamRoot('hosted-production-inbox-disabled-')
    await writePlan(teamRoot, 'opencode')
    const oldPumpRoot = join(teamRoot, 'hosted-team-lead-inbox-pump')
    await mkdir(oldPumpRoot, { mode: 0o700 })
    const oldIntent = join(oldPumpRoot, 'persisted-intent.json')
    await writeFile(oldIntent, 'previous runtime intent\n', { mode: 0o600 })

    const ports = await createHostedControlProductionPorts(context(teamRoot))
    expect(ports.onReadinessLease).toBeUndefined()
    ports.onReadinessLease?.()
    const authority = { actorId: 'actor-a', ...stableAuthority }
    const text = 'A durable hosted message.'
    const persisted = await ports.messages.dispatch({
      operation: 'message_persist', authority,
      payload: { schemaVersion: 1, teamId, clientMessageId: 'client_message_inbox-disabled', text },
    })
    expect(persisted.kind).toBe('persisted')
    const receipt = persisted.receipt as { messageId: string }
    const delivered = await ports.messages.dispatch({
      operation: 'message_deliver', authority,
      payload: { teamId, messageId: receipt.messageId,
        clientMessageId: 'client_message_inbox-disabled', text },
    })
    expect(delivered.kind).toBe('delivered')
    expect(await readdir(oldPumpRoot)).toEqual(['persisted-intent.json'])
    expect(await readFile(oldIntent, 'utf8')).toBe('previous runtime intent\n')
    await ports.close()
  })

  test('composes one stable fail-closed port and exact activation-v2 session from authenticated context', async () => {
    const teamRoot = await makeTeamRoot('hosted-production-activation-v2-')
    await writePlan(teamRoot, 'opencode')
    const runtimeContext = context(teamRoot, true)
    const ports = await createHostedControlProductionPorts(runtimeContext)
    expect(ports.approvals).toBeInstanceOf(HostedApprovalActivatablePort)
    expect((ports.approvals as HostedApprovalActivatablePort).lifecycle).toEqual({
      status: 'inactive', epoch: 0,
    })
    expect(ports.activationSessionFactory).toBeFunction()

    const ownerBinding = {
      ownerAuthority: 'owner-authority_production-test',
      ownerGeneration: 4,
      ownerSessionId: 'owner-session_production-test',
      socketIdentity: { device: '1', inode: '2', uid: 1000, gid: 1000, mode: 0o600 },
    }
    let ownerReady = ''
    const connection: HostedApprovalActivationConnection = {
      ownerBinding,
      socketPath: '/sandbox/control.sock',
      isCurrent: () => true,
      prepareEffectToken: () => ({ consume: () => true }),
      receivePublicationAfterOwnerReady: async frame => {
        ownerReady = frame
        return '{}\n'
      },
    }
    const binding = {
      deploymentId: stableAuthority.deploymentId,
      bootId: stableAuthority.bootId,
      workspaceId: stableAuthority.workspaceId,
      teamId: stableAuthority.teamId,
      restoreGeneration: stableAuthority.restoreGeneration,
      mountBinding: stableAuthority.mountBinding,
      ownerBinding,
      socketPath: runtimeContext.activationV2!.expectation.socketPath,
      approvalGeneration: runtimeContext.activationV2!.expectation.approvalGeneration,
      admissionOwnerGeneration: runtimeContext.activationV2!.expectation.admissionOwnerGeneration,
      approvalDigest: runtimeContext.activationV2!.expectation.approvalDigest,
      admissionDocumentDigest: runtimeContext.activationV2!.expectation.admissionDocumentDigest,
      ownerArtifactDigest: runtimeContext.activationV2!.expectation.ownerArtifactDigest,
      activationCapability: HOSTED_APPROVAL_ACTIVATION_CAPABILITY,
      wireCapabilityDigest: runtimeContext.activationV2!.expectation.wireCapabilityDigest,
      signedManifest: runtimeContext.activationV2!.expectation.signedManifest,
    }
    const unsigned = JSON.stringify({
      schemaVersion: 2,
      operation: 'approval_activation_prepare',
      capability: HOSTED_APPROVAL_ACTIVATION_CAPABILITY,
      challenge: '9'.repeat(64),
      binding,
    })
    const proof = createHostedApprovalActivationV2Proof(
      runtimeContext.activationV2!.proofKey, 'owner-ready-request', unsigned,
    )
    const prepare = `${unsigned.slice(0, -1)},"controllerProof":"${proof}"}\n`
    const session = ports.activationSessionFactory!(connection)
    await expect(session.activate(prepare)).rejects.toThrow()
    expect(JSON.parse(ownerReady).binding).toEqual(binding)
    expect((ports.approvals as HostedApprovalActivatablePort).lifecycle.status).toBe('inactive')
    const revocation = session.revoke()
    expect((ports.approvals as HostedApprovalActivatablePort).lifecycle.status).toBe('revoked')
    await revocation
  })

  test('keeps approval and isolated-lane modules out of the static production import graph', async () => {
    // Only a signed activation or the explicit isolated-profile factory loads them, lazily.
    const source = await readFile(new URL('./HostedControlProductionComposition.ts', import.meta.url), 'utf8')
    const valueImports = [...source.matchAll(/^import\s+(?!type\b)[\s\S]*?from\s+'([^']+)'/gm)]
      .map(match => match[1])
    expect(valueImports.length).toBeGreaterThan(0)
    expect(valueImports.filter(path => /HostedApproval|OpenCodeHostedApproval|isolatedLane\//.test(path)))
      .toEqual([])
  })
})

describe('createHostedPersonalHostLocalPortFactory', () => {
  const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  beforeEach(() => { delete process.env.CLAUDE_CONFIG_DIR })
  afterEach(() => {
    if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  })

  test('launches a reserved run on the host-local lane, wakes the lead, and closes the pump before teardown', async () => {
    const teamRoot = await makePersonalTeamRoot('hosted-personal-launch-')
    const workspace = await writeAdmittedPlan(teamRoot)
    const events: string[] = []
    const launches: string[] = []
    const runtimeTeams: string[] = []
    const lane = fakeLane({
      launch: async input => {
        launches.push(input.runId)
        runtimeTeams.push(input.planTeamId)
        return { phase: 'running', recoverable: false }
      },
      stop: async input => {
        events.push('lane-stop')
        runtimeTeams.push(input.planTeamId)
        return { phase: 'idle', recoverable: false }
      },
    })
    const woken: Array<{ recipient: string; messageId: string }> = []
    const ports = await createHostedPersonalHostLocalPortFactory({
      appMcp: null,
      lanes: [() => lane],
      createInboxPump: options => {
        expect(options.canonicalTeamRoot).toBe(teamRoot)
        return {
          wake: async ({ recipient, message }) => {
            woken.push({ recipient, messageId: message.messageId })
            return { kind: 'observed' }
          },
          recover: async () => { events.push('recover'); return [] },
          start: () => { events.push('start') },
          close: async () => { events.push('pump-close') },
        }
      },
    })(personalContext(teamRoot, workspace))

    const { request, runId } = await reservedLaunchRequest(ports, teamRoot)
    expect((await ports.lifecycle.dispatch(request)).payload.kind).toBe('settled')
    expect(launches).toEqual([runId])

    ports.onReadinessLease!()
    const messageId = await deliverLeadMessage(ports, workspace)
    expect(woken).toEqual([{ recipient: TEAM_LEAD_NAME, messageId }])
    await ports.close()
    expect(events).toEqual(['recover', 'start', 'pump-close', 'lane-stop'])
    // The runtime team is the signed legacy key: the canonical team directory name.
    expect(runtimeTeams).toEqual(['legacy', 'legacy'])
  })

  test('an owner that adopts a crashed owner\'s run delivers and reconciles with its launch capability', async () => {
    const teamRoot = await makePersonalTeamRoot('hosted-personal-capability-')
    const workspace = await writeAdmittedPlan(teamRoot)
    const launchedCapability = `opencode:${'e'.repeat(32)}`
    const calls: Array<{ command: string; body: Record<string, unknown> }> = []
    const execute = (async (input: unknown) => {
      const request = input as { command: string; body: Record<string, unknown> }
      calls.push(request)
      return {
        ok: true,
        runtime: { capabilitySnapshotId: launchedCapability },
        data: request.command === 'opencode.readiness'
          ? { state: 'ready', launchAllowed: true, missing: [],
              expectedBehaviorEvidence: { expectedBehaviorFingerprint: 'f'.repeat(64) } }
          : request.command === 'opencode.stopTeam' ? { stopped: true } : { teamLaunchState: 'ready' },
      }
    }) as never
    const pumpOptions: HostedTeamLeadInboxPumpOptions[] = []
    // Each owner process builds its own lane; non-Cursor session records carry
    // no stop authority and hosted runs have no legacy manifest.
    const createOwner = () => createHostedPersonalHostLocalPortFactory({
      appMcp: null,
      lanes: [context => new OpenCodeTeamLifecycleLane(execute, 10_000, () => true, async () => null,
        new HostedOpenCodeLaunchCapabilityStore(context.teamRoot))],
      createInboxPump: options => {
        pumpOptions.push(options)
        return { wake: async () => ({ kind: 'observed' }), recover: async () => [],
          start: () => undefined, close: async () => undefined }
      },
    })(personalContext(teamRoot, workspace))
    const crashed = await createOwner()
    const { request, runId } = await reservedLaunchRequest(crashed, teamRoot)
    expect((await crashed.lifecycle.dispatch(request)).payload.kind).toBe('settled')
    const records = join(teamRoot, HOSTED_OPENCODE_LAUNCH_CAPABILITY_DIRECTORY)
    const [record] = await readdir(records)
    expect((await stat(join(records, record!))).mode & 0o777).toBe(0o600)

    // The crashed owner never shuts down; the next one knows the run only from disk.
    const adopting = await createOwner()
    const getCapability = pumpOptions[1]!.getCapability!
    const run = { teamId: 'legacy', laneId: 'opencode-primary', runId }
    expect(await getCapability(run)).toBe(launchedCapability)
    await expect(getCapability({ ...run, runId: `run_${'d'.repeat(32)}` })).rejects.toThrow()
    calls.length = 0
    expect((await adopting.lifecycle.dispatch(controlStateInput())).payload.kind).toBe('control_state')
    expect(calls.find(call => call.command === 'opencode.reconcileTeam')).toMatchObject({
      body: { expectedCapabilitySnapshotId: launchedCapability,
        preconditions: { expectedRunId: runId, expectedCapabilitySnapshotId: launchedCapability } } })

    // Graceful shutdown stops the adopted run and retires its record.
    await adopting.close()
    expect(calls.some(call => call.command === 'opencode.stopTeam')).toBe(true)
    expect(await readdir(records)).toEqual([])
    await crashed.close()
  })

  test('refuses host-local lanes when the process config root is not the admitted Claude root', async () => {
    const teamRoot = await makePersonalTeamRoot('hosted-personal-config-root-')
    const workspace = await writeAdmittedPlan(teamRoot)
    process.env.CLAUDE_CONFIG_DIR = join(dirname(dirname(dirname(teamRoot))), 'operator-desktop-claude')
    let created = false
    await expect(createHostedPersonalHostLocalPortFactory({
      appMcp: null, lanes: [() => { created = true; return fakeLane({}) }],
    })(personalContext(teamRoot, workspace))).rejects.toThrow(TypeError)
    expect(created).toBe(false)
  })

  test('never reaches the lane for a workspace that is not the exact declared mount root', async () => {
    for (const variant of ['hash', 'symlink'] as const) {
      const teamRoot = await makePersonalTeamRoot(`hosted-personal-${variant}-`)
      const workspace = await writeAdmittedPlan(teamRoot)
      let declared = workspace
      if (variant === 'symlink') {
        // The hash matches the plan path, but that path is not canonical.
        declared = join(teamRoot, 'workspace-link')
        await symlink(workspace, declared)
        await writePlan(teamRoot, 'opencode', declared)
      }
      const launches: string[] = []
      const ports = await createHostedPersonalHostLocalPortFactory({
        appMcp: null,
        lanes: [() => fakeLane({ launch: async input => {
          launches.push(input.runId)
          return { phase: 'running', recoverable: false }
        } })],
        createInboxPump: () => ({ wake: async () => ({ kind: 'observed' }), recover: async () => [],
          start: () => undefined, close: async () => undefined }),
      })(personalContext(teamRoot, variant === 'hash' ? join(teamRoot, 'other') : declared))
      const { request } = await reservedLaunchRequest(ports, teamRoot)
      await ports.lifecycle.dispatch(request)
      await ports.close()
      expect(launches).toEqual([])
    }
  })

  test('lane plan admission survives composition, and without personal-host no lane exists', async () => {
    const teamRoot = await makePersonalTeamRoot('hosted-personal-plan-admission-')
    const workspace = join(teamRoot, 'sandbox-workspace')
    await mkdir(workspace, { mode: 0o700 })
    await writePlan(teamRoot, 'native', workspace)
    const state = async (factory: HostedControlRuntimePortFactory) => {
      const ports = await factory(personalContext(teamRoot, workspace))
      try {
        return (await ports.lifecycle.dispatch(controlStateInput())).payload
      } finally { await ports.close() }
    }
    const nativeLane = (admitted: boolean) => () => fakeLane({ kind: 'native', supportsPlan: () => admitted })
    expect(await state(createHostedPersonalHostLocalPortFactory({ appMcp: null, lanes: [nativeLane(true)] })))
      .toMatchObject({ kind: 'control_state', availableActions: ['launch'] })
    expect((await state(createHostedPersonalHostLocalPortFactory({ appMcp: null, lanes: [nativeLane(false)] }))).kind)
      .toBe('unavailable')
    expect((await state(createHostedControlProductionPorts)).kind).toBe('unavailable')
  })

  test('the production OpenCode lane is launchable only with a verified pinned MCP artifact', async () => {
    const teamRoot = await makePersonalTeamRoot('hosted-personal-app-mcp-')
    const workspace = await writeAdmittedPlan(teamRoot)
    const command = join(teamRoot, 'node')
    const entry = join(teamRoot, 'index.js')
    await writeFile(command, 'node binary\n')
    await writeFile(entry, 'mcp entry\n')
    const digest = (text: string) => createHash('sha256').update(text).digest('hex')
    const appMcp = { command, commandSha256: digest('node binary\n'), entry, entrySha256: digest('mcp entry\n') }
    const actions = async (descriptor: typeof appMcp | null) => {
      const ports = await createHostedPersonalHostLocalPortFactory({ appMcp: descriptor })(
        personalContext(teamRoot, workspace))
      try {
        return (await ports.lifecycle.dispatch(controlStateInput())).payload
      } finally { await ports.close() }
    }
    expect(await actions(appMcp)).toMatchObject({ kind: 'control_state', availableActions: ['launch'] })
    expect((await actions(null)).kind).toBe('unavailable')
    expect((await actions({ ...appMcp, entrySha256: digest('other entry\n') })).kind).toBe('unavailable')
  })

  test('the native lane exists only with signed provider paths and the verified MCP artifact', async () => {
    const teamRoot = await makePersonalTeamRoot('hosted-personal-native-')
    const workspace = join(teamRoot, 'sandbox-workspace')
    await mkdir(workspace, { mode: 0o700 })
    const planPath = join(teamRoot, HOSTED_LIFECYCLE_PLAN_FILE)
    await writeFile(planPath, JSON.stringify({
      schemaVersion: 2, workspaceId: stableAuthority.workspaceId, teamId, workspaceRoot: workspace,
      toolApprovalMode: 'auto',
      lanes: [{ laneId: 'lane_native', kind: 'native', provider: 'codex', members: [
        { name: TEAM_LEAD_NAME, prompt: 'Lead the team.', model: 'gpt-5.6-sol' },
        { name: 'worker', prompt: 'Work only in the admitted sandbox.', model: 'gpt-5.6-sol' },
      ] }],
    }), { mode: 0o600 })
    await chmod(planPath, 0o600)
    const command = join(teamRoot, 'node')
    const entry = join(teamRoot, 'index.js')
    await writeFile(command, 'node binary\n')
    await writeFile(entry, 'mcp entry\n')
    const digest = (text: string) => createHash('sha256').update(text).digest('hex')
    const appMcp = { command, commandSha256: digest('node binary\n'), entry, entrySha256: digest('mcp entry\n') }
    const native = { codex: { codexHome: '/home/operator/.codex', codexCliPath: '/opt/codex/bin/codex' } }
    const actions = async (config: Parameters<typeof createHostedPersonalHostLocalPortFactory>[0]) => {
      const ports = await createHostedPersonalHostLocalPortFactory(config)(personalContext(teamRoot, workspace))
      try {
        return (await ports.lifecycle.dispatch(controlStateInput())).payload
      } finally { await ports.close() }
    }
    expect(await actions({ appMcp, native })).toMatchObject({ kind: 'control_state', availableActions: ['launch'] })
    expect((await actions({ appMcp, native: null })).kind).toBe('unavailable')
    expect((await actions({ appMcp: null, native })).kind).toBe('unavailable')
    expect((await actions({ appMcp, native: { anthropic: { oauthTokenFile: '/home/operator/token' } } })).kind)
      .toBe('unavailable')
  })
})

function fakeLane(overrides: Partial<TeamLifecycleLaneEffectPort>): TeamLifecycleLaneEffectPort {
  return {
    kind: 'opencode', supports: () => true,
    inspect: async input => ({ phase: input.runId ? 'running' : 'idle', recoverable: false }),
    launch: async () => ({ phase: 'running', recoverable: false }),
    cancel: async () => ({ phase: 'idle', recoverable: false }),
    stop: async () => ({ phase: 'idle', recoverable: false }),
    recover: async () => ({ phase: 'idle', recoverable: false }),
    ...overrides,
  }
}

/** Personal-host plans must name the canonical mount whose hash the launcher declared. */
async function writeAdmittedPlan(teamRoot: string): Promise<string> {
  const workspace = join(teamRoot, 'sandbox-workspace')
  await mkdir(workspace, { mode: 0o700 })
  await writePlan(teamRoot, 'opencode', workspace)
  return workspace
}

/** `<claudeRoot>/teams/legacy`, with the process config root pinned like Main does. */
async function makePersonalTeamRoot(prefix: string): Promise<string> {
  const claudeRoot = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  roots.push(claudeRoot)
  const teamRoot = join(claudeRoot, 'teams', 'legacy')
  await mkdir(teamRoot, { recursive: true, mode: 0o700 })
  process.env.CLAUDE_CONFIG_DIR = claudeRoot
  return teamRoot
}

function personalContext(teamRoot: string, declaredRoot: string): HostedControlRuntimePortFactoryContext {
  const base = { ...context(teamRoot), claudeRoot: dirname(dirname(teamRoot)) }
  return { ...base, authority: { ...base.authority, mountBinding: {
    ...base.authority.mountBinding,
    declaredRootHash: createHash('sha256').update(declaredRoot).digest('hex'),
  } } }
}

async function deliverLeadMessage(ports: HostedControlRuntimePorts, workspace: string): Promise<string> {
  const authority = { actorId: 'actor-a', ...stableAuthority, mountBinding: {
    ...stableAuthority.mountBinding,
    declaredRootHash: createHash('sha256').update(workspace).digest('hex'),
  } }
  const text = 'Wake the lead.'
  const persisted = await ports.messages.dispatch({
    operation: 'message_persist', authority,
    payload: { schemaVersion: 1, teamId, clientMessageId: 'client_message_personal-wake', text },
  })
  const { messageId } = persisted.receipt as { messageId: string }
  const delivered = await ports.messages.dispatch({
    operation: 'message_deliver', authority,
    payload: { teamId, messageId, clientMessageId: 'client_message_personal-wake', text },
  })
  expect(delivered.kind).toBe('delivered')
  return messageId
}

async function reservedLaunchRequest(ports: HostedControlRuntimePorts, teamRoot: string) {
  const state = (await ports.lifecycle.dispatch(controlStateInput())).payload
  expect(state.kind).toBe('control_state')
  const command = { ...launchAuthorizeInput().payload.command,
    expectedRevision: state.resourceRevision as string }
  const currentAuthority = { ...lifecycleAuthority, resourceRevision: command.expectedRevision }
  const commandContext = { ...controlStateInput().payload.context,
    authorizedScope: 'scope_hosted-lifecycle-command' }
  const authorized = (await ports.lifecycle.dispatch({ operation: 'authorize', authority: currentAuthority,
    payload: { command, context: commandContext, authority: currentAuthority } })).payload
  expect(authorized.kind).toBe('authorized')
  const runId = `run_${'c'.repeat(32)}`
  const planSha256 = createHash('sha256').update(await readFile(join(teamRoot, HOSTED_LIFECYCLE_PLAN_FILE))).digest('hex')
  const runReservation = {
    schemaVersion: 1 as const, workspaceId: `workspace_${'3'.repeat(32)}`,
    runtimeWorkspaceId: stableAuthority.workspaceId, teamId,
    actorId: currentAuthority.actorId, deploymentId: stableAuthority.deploymentId,
    bootId: stableAuthority.bootId, commandId: command.commandId,
    idempotencyKey: command.idempotencyKey, expectedRevision: command.expectedRevision,
    expectedPlanGeneration: `plan-generation_${planSha256}`,
    ownerAuthority: 'owner-authority_test-owner', ownerGeneration: 1,
    ownerSessionId: 'owner-session_test-owner',
    restoreGeneration: stableAuthority.restoreGeneration,
    mountGeneration: stableAuthority.mountBinding.mountGeneration,
    ownerEffectFence: currentAuthority.ownerEffectFence,
    authorityEvidence: { userId: 'user_test-user', sessionId: 'session_test-user', grantGeneration: 1 },
    runId, promotionOperationId: `promotion_${'1'.repeat(32)}`,
    planSha256, rosterBindingSha256: '2'.repeat(64), createdAtMs: Date.now(),
  }
  const digest = createHash('sha256').update(JSON.stringify([
    'agent-teams.hosted-lifecycle-command/v1', 1, 'launch', command.commandId,
    command.idempotencyKey, command.workspaceId, command.teamId, command.expectedRevision,
    runId, currentAuthority.ownerEffectFence.grantRevision,
    currentAuthority.ownerEffectFence.identityChecksum,
  ])).digest('hex')
  const durableCommand = {
    schemaVersion: 1,
    commandFingerprint: { algorithm: 'sha256', version: 1, digest },
    idempotency: { deploymentId: stableAuthority.deploymentId, actorId: currentAuthority.actorId,
      action: 'launch', idempotencyKey: command.idempotencyKey },
    resource: { bootId: stableAuthority.bootId, workspaceId: command.workspaceId, teamId,
      runId, expectedRevision: command.expectedRevision, restoreGeneration: stableAuthority.restoreGeneration,
      mountGeneration: stableAuthority.mountBinding.mountGeneration,
      ownerEffectFence: currentAuthority.ownerEffectFence },
  }
  return { runId, request: { operation: 'execute' as const, authority: currentAuthority,
    payload: { command, authorization: authorized.authorization as Record<string, unknown>,
      durableCommand, runReservation, context: commandContext, authority: currentAuthority } } }
}

async function makeTeamRoot(prefix: string): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), prefix))
  roots.push(parent)
  const root = join(parent, 'legacy')
  await mkdir(root, { mode: 0o700 })
  return realpath(root)
}

async function writeApprovalAdmission(teamRoot: string): Promise<void> {
  await writeFile(
    join(teamRoot, HOSTED_APPROVAL_RUNTIME_ADMISSION_FILE),
    JSON.stringify({
      schemaVersion: 1,
      admissionGeneration: 'approval-admission-generation_test',
      outerAuthority: {
        deploymentId: stableAuthority.deploymentId,
        bootId: stableAuthority.bootId,
        workspaceId: stableAuthority.workspaceId,
        teamId,
        restoreGeneration: stableAuthority.restoreGeneration,
        mountBinding: { ...stableAuthority.mountBinding },
      },
      routes: [],
      actorMembers: {},
    }),
    { mode: 0o600 },
  )
}

function context(
  teamRoot: string,
  withActivation = false,
): HostedControlRuntimePortFactoryContext {
  const activationV2 = {
    proofKey: Buffer.alloc(32, 0x31),
    expectation: {
      authority: stableAuthority,
      socketPath: '/sandbox/control.sock',
      approvalGeneration: 7,
      admissionOwnerGeneration: 11,
      approvalDigest: `sha256:${'3'.repeat(64)}` as const,
      admissionDocumentDigest: `sha256:${'4'.repeat(64)}` as const,
      ownerArtifactDigest: `sha256:${'5'.repeat(64)}` as const,
      wireCapabilityDigest: `sha256:${'6'.repeat(64)}` as const,
      signedManifest: {
        format: 'agent-teams.hosted-lifecycle-owner-admission/v4' as const,
        manifestDigest: `sha256:${'7'.repeat(64)}` as const,
        releasePinDigest: `sha256:${'8'.repeat(64)}` as const,
        launcherKeyId: 'a'.repeat(64),
      },
    },
    assertBootstrapCurrent: () => true,
    assertRootCurrent: () => true,
  }
  return {
    authority: stableAuthority,
    legacyKey: 'legacy',
    claudeRoot: dirname(teamRoot),
    teamRoot,
    isCurrentAuthority: async () => true,
    ...(withActivation ? { activationV2 } : {}),
  }
}

function controlStateInput() {
  return {
    operation: 'control_state' as const,
    payload: {
      request: {
        schemaVersion: 1,
        workspaceId: stableAuthority.workspaceId,
        teamId,
      },
      context: {
        actorId: 'actor-a',
        sessionId: 'session-a',
        deploymentId: stableAuthority.deploymentId,
        bootId: stableAuthority.bootId,
        requestId: 'request-a',
        authorizedScope: 'scope_hosted-lifecycle-control-state',
        deadlineAtMs: Date.now() + 10_000,
      },
      authority: lifecycleAuthority,
    },
    authority: lifecycleAuthority,
  }
}

function launchAuthorizeInput() {
  const query = controlStateInput()
  return {
    operation: 'authorize' as const,
    authority: lifecycleAuthority,
    payload: {
      context: { ...query.payload.context,
        authorizedScope: 'scope_hosted-lifecycle-authorize' },
      command: {
        schemaVersion: 1,
        action: 'launch',
        commandId: 'lifecycle-command_test-launch',
        idempotencyKey: 'idempotency_test-launch',
        workspaceId: stableAuthority.workspaceId,
        teamId,
        expectedRevision: `revision_${'a'.repeat(64)}`,
      },
    },
  }
}

async function writePlan(
  teamRoot: string,
  kind: 'opencode' | 'native',
  workspaceRoot = join(teamRoot, 'sandbox-workspace'),
): Promise<void> {
  await mkdir(teamRoot, { recursive: true, mode: 0o700 })
  const lane =
    kind === 'opencode'
      ? {
          laneId: 'opencode-primary',
          kind: 'opencode',
          provider: 'opencode',
          selectedModel: 'openai/gpt-5',
          members: [{ name: 'worker', prompt: 'Work only in the admitted sandbox.' }],
        }
      : {
          laneId: 'codex-primary',
          kind: 'native',
          provider: 'codex',
          members: [{ name: 'worker', prompt: 'Work only in the admitted sandbox.' }],
        }
  const path = join(teamRoot, HOSTED_LIFECYCLE_PLAN_FILE)
  await writeFile(
    path,
    JSON.stringify({
      schemaVersion: 2,
      workspaceId: stableAuthority.workspaceId,
      teamId,
      workspaceRoot,
      toolApprovalMode: 'manual',
      lanes: [lane],
    }),
    { mode: 0o600 },
  )
  await chmod(path, 0o600)
}
