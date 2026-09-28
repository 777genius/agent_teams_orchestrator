import { HostedContainerOpenCodeLane, type HostedCanonicalLaneIdentityResolver,
  type HostedContainerLaneBinding, type HostedContainerLaneReadiness } from '../../teamLifecycleOwner/HostedContainerOpenCodeLane.js'
import type { TeamLifecycleLaneEffectPort, TeamLifecycleLaneInput,
  TeamLifecycleLaneObservation } from '../../teamLifecycleOwner/OpenCodeTeamLifecycleLane.js'
import type { HostedMemberNetworkRequest } from '../containerNetworkProvisioning/HostedMemberNetworkProvisioner.js'
import type { HostedOpenCodeSupervisorRpcClient } from '../container/HostedOpenCodeSupervisorRpc.js'
import { HostedDurableContainerAttemptClaims,
  HostedDurableMemberSessionClaims } from '../hostedDurableClaims/HostedDurableClaims.js'
import { HostedMemberSessionBridge } from '../hostedLaneSession/HostedMemberSessionBridge.js'
import type { HostedMemberAttempt } from '../hostedLaneSession/HostedMemberSessionBridge.js'
import { OpenCodeHostedMemberSessionTransport } from '../openCodeSessionTransport/OpenCodeHostedMemberSessionTransport.js'
import { HostedSupervisorEndpointAuthority } from '../openCodeSessionTransport/HostedSupervisorEndpointAuthority.js'
import type { HostedAgentToolBroker, HostedAgentToolPostExecProof } from '../isolatedAgentTools/HostedAgentToolBroker.js'
import type { HostedControlRuntimePortFactoryContext } from '../HostedControlRuntime.js'

type RunningInput = TeamLifecycleLaneInput & { runId: string }
type ManagedRoot = Pick<HostedOpenCodeSupervisorRpcClient,
  'prepareManagedMember' | 'startManagedMember' | 'observeManagedMember' |
  'stopManagedMember' | 'beginEndpointUse' | 'endEndpointUse'>
type Preparation = Awaited<ReturnType<ManagedRoot['prepareManagedMember']>>
type Start = Parameters<HostedOpenCodeSupervisorRpcClient['start']>[0]
type Handle = Parameters<HostedOpenCodeSupervisorRpcClient['stop']>[0]
type ToolBrokerPort = Pick<HostedAgentToolBroker, 'waitForPeer' | 'bindSession' | 'activate' | 'revoke'>

const ID = /^[a-z0-9][a-z0-9_-]{7,95}$/
const SHA = /^[a-f0-9]{64}$/
const RECEIPT = /^[a-f0-9]{32}$/
const HANDLE = /^opencode_[a-f0-9]{32}$/
const GENERATION = /^[a-f0-9]{32}$/
const FAILED: TeamLifecycleLaneObservation = { phase: 'failed', recoverable: true }

/**
 * Trusted composition supplies canonical Product pins. The default production
 * port factory never constructs this lane. Root independently checks Product
 * authority again on every managed prepare/start/observe/stop operation.
 */
export type HostedManagedOpenCodeLaneDependencies = Readonly<{
  root: ManagedRoot
  resolveCanonicalLaneIdentity: HostedCanonicalLaneIdentityResolver
  preparationRequest(binding: HostedContainerLaneBinding): Promise<HostedMemberNetworkRequest | null>
  assertCurrentProduct(input: RunningInput): Promise<boolean>
  /** Broker must exist before Start; this resolves its exact root post-exec proof. */
  toolActivation(attempt: HostedMemberAttempt, sessionId: string): Promise<{
    broker: ToolBrokerPort; proof: HostedAgentToolPostExecProof
  }>
  /** Must include independent root FD3, gateway and provider policy evidence. */
  readiness(): HostedContainerLaneReadiness & Readonly<{ gateway: boolean; product: boolean; root: boolean }>
}>

export async function activateHostedMemberTools(
  attempt: HostedMemberAttempt,
  sessionId: string,
  resolve: HostedManagedOpenCodeLaneDependencies['toolActivation'],
): Promise<void> {
  const { broker, proof } = await resolve(attempt, sessionId)
  if (!broker || !proof || proof.containerGeneration !== attempt.containerGeneration ||
    proof.runId !== attempt.runId || proof.laneId !== attempt.laneId ||
    proof.memberId !== attempt.memberId || proof.sessionID !== sessionId) {
    throw new Error('hosted-managed-tool-proof-mismatch')
  }
  try {
    await broker.waitForPeer()
    broker.bindSession(sessionId)
    await broker.activate(proof)
  } catch {
    await broker.revoke().catch(() => undefined)
    throw new Error('hosted-managed-tool-activation-failed')
  }
}

/**
 * Maps the root manager's durable prepare receipt to the existing hosted lane.
 * Handle bindings are process-local: after Owner restart, inspect/stop fail
 * closed until a future root bound-handle recovery API exists.
 */
class ManagedRootLaneAdapter {
  readonly #prepared = new Map<string, Preparation>()
  readonly #handles = new Map<string, string>()

  constructor(private readonly root: ManagedRoot,
    private readonly preparationRequest: HostedManagedOpenCodeLaneDependencies['preparationRequest']) {}

  async issueLease(binding: HostedContainerLaneBinding): Promise<string> {
    const request = await this.preparationRequest(binding)
    if (!request || request.operationId !== binding.operationId ||
      request.planTeamId !== binding.teamId || request.runId !== binding.runId ||
      request.teamId !== binding.teamId || request.laneId !== binding.laneId ||
      request.memberId !== binding.memberId || !SHA.test(request.planFingerprint)) {
      throw new Error('hosted-managed-member-product-binding-invalid')
    }
    const receipt = await this.root.prepareManagedMember(request)
    if (receipt.operationId !== binding.operationId || !RECEIPT.test(receipt.receiptId) ||
      !HANDLE.test(receipt.handle) || !GENERATION.test(receipt.generation)) {
      throw new Error('hosted-managed-member-preparation-invalid')
    }
    this.#prepared.set(binding.operationId, receipt)
    return receipt.receiptId
  }

  async start(request: Start): ReturnType<ManagedRoot['startManagedMember']> {
    const prepared = this.#prepared.get(request.operationId)
    if (!prepared || request.leaseId !== prepared.receiptId ||
      !ID.test(request.runId) || !ID.test(request.teamId) || !ID.test(request.laneId) ||
      !ID.test(request.memberId)) throw new Error('hosted-managed-member-start-unbound')
    // This map is populated only from a root-durable preparation receipt. An
    // uncertain Start is never reissued by the durable hosted lane claim.
    const result = await this.root.startManagedMember({ operationId: request.operationId,
      receiptId: prepared.receiptId })
    if (result.handle !== prepared.handle || result.generation !== prepared.generation) {
      throw new Error('hosted-managed-member-start-conflict')
    }
    this.#handles.set(`${result.handle}:${result.generation}`, request.operationId)
    return result
  }

  observe(request: Handle): ReturnType<ManagedRoot['observeManagedMember']> {
    const memberOperationId = this.#bound(request)
    return this.root.observeManagedMember({ memberOperationId, ...request })
  }

  stop(request: Handle): ReturnType<ManagedRoot['stopManagedMember']> {
    const memberOperationId = this.#bound(request)
    return this.root.stopManagedMember({ memberOperationId, ...request })
  }

  reconcile(request: Handle): ReturnType<ManagedRoot['stopManagedMember']> {
    return this.stop(request)
  }

  #bound(request: Handle): string {
    const memberOperationId = this.#handles.get(`${request.handle}:${request.generation}`)
    if (!memberOperationId) throw new Error('hosted-managed-member-handle-unbound')
    return memberOperationId
  }
}

/** Explicit activation only; the default hosted production composition has no dependencies. */
export function createHostedManagedOpenCodeLane(
  context: Readonly<HostedControlRuntimePortFactoryContext>,
  dependencies: HostedManagedOpenCodeLaneDependencies,
): TeamLifecycleLaneEffectPort {
  if (!dependencies || !dependencies.root || !dependencies.resolveCanonicalLaneIdentity ||
    !dependencies.preparationRequest || !dependencies.assertCurrentProduct ||
    !dependencies.toolActivation || !dependencies.readiness) {
    throw new Error('hosted-managed-lane-dependencies-incomplete')
  }
  const root = new ManagedRootLaneAdapter(dependencies.root, dependencies.preparationRequest)
  const sessions = new HostedMemberSessionBridge(
    new OpenCodeHostedMemberSessionTransport(new HostedSupervisorEndpointAuthority(dependencies.root)),
    new HostedDurableMemberSessionClaims(context.teamRoot),
    (attempt, sessionId) => activateHostedMemberTools(attempt, sessionId, dependencies.toolActivation),
  )
  const ready = (): HostedContainerLaneReadiness => {
    try {
      const evidence = dependencies.readiness()
      const enabled = evidence.gateway === true && evidence.product === true && evidence.root === true
      return { endpoint: enabled && evidence.endpoint === true,
        fd3Handoff: enabled && evidence.fd3Handoff === true,
        providerConfig: enabled && evidence.providerConfig === true,
        memberSessions: enabled && evidence.memberSessions === true }
    } catch {
      return { endpoint: false, fd3Handoff: false, providerConfig: false, memberSessions: false }
    }
  }
  const lane = new HostedContainerOpenCodeLane(root, binding => root.issueLease(binding),
    ready, new HostedDurableContainerAttemptClaims(context.teamRoot),
    undefined, sessions, dependencies.resolveCanonicalLaneIdentity)

  return {
    kind: 'opencode',
    supports: action => action === 'launch'
      ? Object.values(ready()).every(value => value === true) && lane.supports(action)
      : lane.supports(action),
    async inspect(input) {
      if (!input.runId) return lane.inspect(input)
      if (!Object.values(ready()).every(value => value === true) ||
        !await context.isCurrentAuthority({ actorId: 'hosted-lifecycle-owner', ...context.authority }) ||
        !await dependencies.assertCurrentProduct(input as RunningInput)) return FAILED
      return lane.inspect(input)
    },
    async launch(input) {
      if (!Object.values(ready()).every(value => value === true) ||
        !await context.isCurrentAuthority({ actorId: 'hosted-lifecycle-owner', ...context.authority }) ||
        !await dependencies.assertCurrentProduct(input)) return FAILED
      return lane.launch(input)
    },
    cancel: input => lane.cancel(input),
    stop: input => lane.stop(input),
    recover: input => lane.recover(input),
  }
}
