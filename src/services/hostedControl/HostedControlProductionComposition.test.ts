import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { closeSync, fsyncSync, openSync, writeSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HostedLifecycleAuthority } from './HostedControlDispatcher.js'
import { DurableTeamLifecycleExecution } from '../teamLifecycleOwner/DurableTeamLifecycleExecution.js'
import {
  OpenCodeTeamLifecycleLane,
  type TeamLifecycleLaneEffectPort,
  type TeamLifecycleLaneObservation,
} from '../teamLifecycleOwner/OpenCodeTeamLifecycleLane.js'
import type { TeamLifecycleLaunchPlan } from '../teamLifecycleOwner/TeamLifecycleLaunchPlan.js'
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
import { HOSTED_ACTUAL_OWNER_CORPUS_FILE } from './HostedActualOwnerCaptureSession.js'
import {
  HOSTED_OWNER_PROVENANCE_CONTRACT,
  HOSTED_OWNER_PROVENANCE_CONTRACT_SHA256,
  HOSTED_OWNER_PROVENANCE_IMPLEMENTATION,
  type OwnerProvenanceOperations,
} from './HostedApprovalOwnerProvenance.js'

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
  test('normal production composition starts capability-false until trusted approval authority is published', async () => {
    const teamRoot = await makeTeamRoot('hosted-production-missing-approval-admission-')
    await writePlan(teamRoot, 'opencode')
    const ports = await createHostedControlProductionPorts(context(teamRoot))
    expect(ports.approvals).toBeUndefined()
    expect((await ports.lifecycle.dispatch(controlStateInput())).payload.kind).toBe('control_state')
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
    expect(state.payload).toMatchObject({
      kind: 'control_state',
      availableActions: ['launch'],
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

  test('keeps an admitted OpenCode plan unavailable when its live owner capability is absent', async () => {
    const teamRoot = await makeTeamRoot('hosted-production-opencode-unavailable-')
    await writePlan(teamRoot, 'opencode')
    await writeApprovalAdmission(teamRoot)
    const createPorts = createHostedControlProductionPortFactory(() => new OpenCodeTeamLifecycleLane())
    const ports = await createPorts(context(teamRoot))
    expect((await ports.lifecycle.dispatch(controlStateInput())).payload.kind).toBe('unavailable')
  })

  test('adopts a durable running plan before publishing ports and immediate close stops the exact run', async () => {
    const teamRoot = await makeTeamRoot('hosted-production-startup-running-')
    const admittedPlan = await writePlan(teamRoot, 'opencode')
    const lane = new ProductionRecoveryLane()
    const crashedExecution = new DurableTeamLifecycleExecution(
      join(teamRoot, HOSTED_LIFECYCLE_EXECUTION_STATE_FILE),
      [lane],
    )
    const idle = await crashedExecution.inspect(admittedPlan)
    const launching = await crashedExecution.launch({
      plan: admittedPlan,
      commandId: 'command-before-production-restart',
      runId: null,
      expectedProviderGeneration: idle.providerGeneration,
    })
    await waitForDurablePhase(teamRoot, 'running')

    const createPorts = createHostedControlProductionPortFactory(() => lane)
    const ports = await createPorts(context(teamRoot))
    await ports.close()

    expect(lane.inspectedRunIds).toEqual([launching.runId])
    expect(lane.stoppedRunIds).toEqual([launching.runId])
    expect(await durableState(teamRoot)).toMatchObject({
      phase: 'idle',
      runId: null,
      recoverable: false,
    })
  })

  test('fails startup closed and tears down the exact run when durable running adoption is partial', async () => {
    const teamRoot = await makeTeamRoot('hosted-production-startup-partial-')
    const admittedPlan = await writePlan(teamRoot, 'opencode')
    const lane = new ProductionRecoveryLane()
    const crashedExecution = new DurableTeamLifecycleExecution(
      join(teamRoot, HOSTED_LIFECYCLE_EXECUTION_STATE_FILE),
      [lane],
    )
    const idle = await crashedExecution.inspect(admittedPlan)
    const launching = await crashedExecution.launch({
      plan: admittedPlan,
      commandId: 'command-before-partial-recovery',
      runId: null,
      expectedProviderGeneration: idle.providerGeneration,
    })
    await waitForDurablePhase(teamRoot, 'running')
    lane.inspectResult = { phase: 'failed', recoverable: true }

    const createPorts = createHostedControlProductionPortFactory(() => lane)
    await expect(createPorts(context(teamRoot))).rejects.toThrow(
      'Unable to adopt recovered team lifecycle run',
    )
    expect(lane.inspectedRunIds).toEqual([launching.runId])
    expect(lane.stoppedRunIds).toEqual([launching.runId])
    expect(await durableState(teamRoot)).toMatchObject({
      phase: 'idle',
      runId: null,
      recoverable: false,
    })
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

  test('opens one explicit process capture after canonical composition and closes it with the ports', async () => {
    const teamRoot = await makeTeamRoot('hosted-production-live-capture-')
    await writePlan(teamRoot, 'opencode')
    let nonce = 0; let closes = 0
    const lines: Record<string, unknown>[] = []
    const operations: OwnerProvenanceOperations = {
      identity: () => ({ pid: process.pid, startTicks: '9', exeDev: '10', exeIno: '11',
        exeSha256: '4'.repeat(64), moduleSha256: '5'.repeat(64) }),
      descriptor: () => ({ device: '7', inode: '8', regular: true, append: true,
        writeOnly: true, mode: 0o600, nlink: '1', size: '0' }),
      nonce: () => (++nonce).toString(16).padStart(64, '0'),
      write: (_fd, bytes, offset) => {
        lines.push(JSON.parse(Buffer.from(bytes.subarray(offset)).toString()))
        return bytes.byteLength - offset
      },
      sync: () => {}, close: () => { closes += 1 },
    }
    const environment = { CLAUDE_TEAM_PRODUCER_PROVENANCE_V2: JSON.stringify({
      activation: { controllerNonce: '1'.repeat(64), runId: 'run_test', stackManifestSha256: '2'.repeat(64) },
      contract: HOSTED_OWNER_PROVENANCE_CONTRACT, contractSha256: HOSTED_OWNER_PROVENANCE_CONTRACT_SHA256,
      expectedProducer: { artifactManifestSha256: '3'.repeat(64), executableSha256: '4'.repeat(64),
        implementationId: HOSTED_OWNER_PROVENANCE_IMPLEMENTATION, moduleSha256: '5'.repeat(64) },
      producerRole: 'owner', streams: { ownerWalTimeline: { device: '7', fd: 9, inode: '8' } }, version: 2,
    }) }
    const createPorts = createHostedControlProductionPortFactory(undefined, undefined, {
      environment, modulePath: import.meta.path, ownerGeneration: 'owner-generation-test',
      provenanceOperations: operations,
    })
    const ports = await createPorts(context(teamRoot, true))
    expect(lines.map(line => line.recordType)).toEqual(['producer-open'])
    expect(await Bun.file(join(teamRoot, HOSTED_ACTUAL_OWNER_CORPUS_FILE)).exists()).toBe(true)
    await expect(createPorts(context(teamRoot, true))).rejects.toThrow('process_capture_already_claimed')
    await ports.close()
    expect(lines.map(line => line.recordType)).toEqual(['producer-open', 'producer-close'])
    expect(closes).toBe(1)
    expect(OPEN_CODE_HOSTED_APPROVAL_ATOMIC_REPLY_SUPPORTED).toBe(false)
  })

  test('closes capture after execution shutdown rejects and retains every cleanup error', async () => {
    const teamRoot = await makeTeamRoot('hosted-production-cleanup-errors-')
    await writePlan(teamRoot, 'opencode')
    let nonce = 0; let producerCloses = 0; let corpusCloses = 0; let failCaptureCleanup = false
    const operations: OwnerProvenanceOperations = {
      identity: () => ({ pid: process.pid, startTicks: '9', exeDev: '10', exeIno: '11',
        exeSha256: '4'.repeat(64), moduleSha256: '5'.repeat(64) }),
      descriptor: () => ({ device: '7', inode: '8', regular: true, append: true,
        writeOnly: true, mode: 0o600, nlink: '1', size: '0' }),
      nonce: () => (++nonce).toString(16).padStart(64, '0'),
      write: (_fd, bytes, offset) => bytes.byteLength - offset,
      sync: () => {}, close: () => { producerCloses += 1 },
    }
    const environment = { CLAUDE_TEAM_PRODUCER_PROVENANCE_V2: JSON.stringify({
      activation: { controllerNonce: '1'.repeat(64), runId: 'run_test', stackManifestSha256: '2'.repeat(64) },
      contract: HOSTED_OWNER_PROVENANCE_CONTRACT, contractSha256: HOSTED_OWNER_PROVENANCE_CONTRACT_SHA256,
      expectedProducer: { artifactManifestSha256: '3'.repeat(64), executableSha256: '4'.repeat(64),
        implementationId: HOSTED_OWNER_PROVENANCE_IMPLEMENTATION, moduleSha256: '5'.repeat(64) },
      producerRole: 'owner', streams: { ownerWalTimeline: { device: '7', fd: 9, inode: '8' } }, version: 2,
    }) }
    const createPorts = createHostedControlProductionPortFactory(undefined, undefined, {
      environment, modulePath: import.meta.path, ownerGeneration: 'owner-generation-test',
      provenanceOperations: operations,
      fileOperations: {
        open: openSync,
        write: (fd, bytes, offset) => writeSync(fd, bytes, offset, bytes.byteLength - offset),
        sync: fd => { if (failCaptureCleanup) throw new Error('corpus sync failed'); fsyncSync(fd) },
        close: fd => { closeSync(fd); corpusCloses += 1; if (failCaptureCleanup) throw new Error('corpus close failed') },
      },
    })
    const ports = await createPorts(context(teamRoot))
    const shutdownError = new Error('execution shutdown failed')
    const shutdown = spyOn(DurableTeamLifecycleExecution.prototype, 'shutdown')
      .mockImplementation(async () => { throw shutdownError })
    failCaptureCleanup = true
    try {
      let failure: unknown
      try { await ports.close() } catch (error) { failure = error }
      expect(failure).toBeInstanceOf(AggregateError)
      const errors = (failure as AggregateError).errors
      expect(errors).toHaveLength(2)
      expect(errors[0]).toBe(shutdownError)
      expect(errors[1]).toBeInstanceOf(AggregateError)
      expect((errors[1] as AggregateError).errors.map(error => (error as Error).message))
        .toEqual(['corpus sync failed', 'corpus close failed'])
      expect(producerCloses).toBe(1)
      expect(corpusCloses).toBe(1)
    } finally {
      shutdown.mockRestore()
    }
  })
})

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
        authorizedScope: 'scope_team-lifecycle.write',
        deadlineAtMs: Date.now() + 10_000,
      },
      authority: lifecycleAuthority,
    },
    authority: lifecycleAuthority,
  }
}

async function writePlan(
  teamRoot: string,
  kind: 'opencode' | 'native',
): Promise<TeamLifecycleLaunchPlan> {
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
  const plan: TeamLifecycleLaunchPlan = {
    schemaVersion: 2,
    workspaceId: stableAuthority.workspaceId,
    teamId,
    workspaceRoot: join(teamRoot, 'sandbox-workspace'),
    toolApprovalMode: 'manual',
    lanes: [lane],
  }
  const path = join(teamRoot, HOSTED_LIFECYCLE_PLAN_FILE)
  await writeFile(
    path,
    JSON.stringify(plan),
    { mode: 0o600 },
  )
  await chmod(path, 0o600)
  return plan
}

class ProductionRecoveryLane implements TeamLifecycleLaneEffectPort {
  readonly kind = 'opencode' as const
  inspectedRunIds: string[] = []
  stoppedRunIds: string[] = []
  inspectResult: TeamLifecycleLaneObservation = {
    phase: 'running', recoverable: false, recoveryBinding: `session-set_${'a'.repeat(64)}`,
  }

  supports(): boolean { return true }
  async inspect(input: { runId: string | null }): Promise<TeamLifecycleLaneObservation> {
    if (input.runId) this.inspectedRunIds.push(input.runId)
    return input.runId ? this.inspectResult : { phase: 'idle', recoverable: false }
  }
  async launch(): Promise<TeamLifecycleLaneObservation> {
    return { phase: 'running', recoverable: false, recoveryBinding: `session-set_${'a'.repeat(64)}` }
  }
  async cancel(): Promise<TeamLifecycleLaneObservation> {
    return { phase: 'idle', recoverable: false }
  }
  async stop(input: { runId: string }): Promise<TeamLifecycleLaneObservation> {
    this.stoppedRunIds.push(input.runId)
    return { phase: 'idle', recoverable: false }
  }
  async recover(): Promise<TeamLifecycleLaneObservation> {
    return { phase: 'idle', recoverable: false }
  }
}

async function durableState(teamRoot: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(
    join(teamRoot, HOSTED_LIFECYCLE_EXECUTION_STATE_FILE),
    'utf8',
  )) as Record<string, unknown>
}

async function waitForDurablePhase(teamRoot: string, phase: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await durableState(teamRoot)).phase === phase) return
    await Bun.sleep(5)
  }
  throw new Error(`Timed out waiting for durable phase ${phase}`)
}
