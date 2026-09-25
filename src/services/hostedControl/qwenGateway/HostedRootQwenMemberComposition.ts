import type { HostedProductCurrentMember, HostedProductMemberBinding } from
  '../productAuthority/HostedProductCurrentMemberDecision.js'
import { HostedQwenGateway, type HostedQwenAdmission, type HostedQwenContainerBinding,
  type HostedQwenGatewayDispatchAuthority } from './HostedQwenGateway.js'
import { HostedQwenNetworkPolicy, type HostedQwenCommandRunner } from './HostedQwenNetworkPolicy.js'

const MODEL = 'local-llama/qwen3-8b'
const SHA = /^[a-f0-9]{64}$/
const GENERATION = /^[a-f0-9]{32}$/
const BINDING_KEYS = ['runId', 'memberId', 'teamId', 'laneId', 'deploymentId',
  'runtimeWorkspaceId', 'planSha256', 'rosterBindingSha256', 'restoreGeneration',
  'mountGeneration'] as const

type Gateway = Pick<HostedQwenGateway, 'start' | 'admitClient' | 'revokeClient' | 'stop'>
type CleanupPhase = 'client' | 'revoke' | 'container' | 'listener' | 'policy'

export interface HostedRootQwenMemberAuthority extends HostedQwenGatewayDispatchAuthority {
  withCurrentMemberDecision<T>(binding: HostedProductMemberBinding, kind: 'start' | 'observe',
    callback: (current: HostedProductCurrentMember) => T): Promise<T>
}

/** Root-owned Docker operations. A rejected start must leave no running container. */
export interface HostedRootQwenContainerLifecycle {
  start(): Promise<string>
  /** Independently proves the exact running Docker identity after start. */
  prove(containerId: string): Promise<HostedQwenContainerBinding>
  /** Stops and removes only the pinned container; safe to retry. */
  stopAndRemove(containerId: string): Promise<void>
}

export type HostedRootQwenMemberOptions = Readonly<{
  member: HostedProductMemberBinding
  networkId: string
  generation: string
  gatewayPort: number
  stateDirectory: string
  authority: HostedRootQwenMemberAuthority
  container: HostedRootQwenContainerLifecycle
  /** Synthetic firewall and listener fixtures only. */
  testOnly?: Readonly<{ runner: HostedQwenCommandRunner;
    gateway: (address: string, policy: HostedQwenNetworkPolicy) => Gateway }>
}>

function sameMember(current: HostedProductCurrentMember, binding: HostedProductMemberBinding): boolean {
  return BINDING_KEYS.every(key => current[key] === binding[key]) && current.model === MODEL
}

function sameContainer(left: HostedQwenContainerBinding | null,
  right: HostedQwenContainerBinding): boolean {
  return !!left && left.containerId === right.containerId && left.networkId === right.networkId &&
    left.containerGeneration === right.containerGeneration && left.containerIp === right.containerIp
}

/**
 * One exact Product member owns one firewall lease and one gateway listener.
 * No production caller constructs this until root config and Docker admission are wired.
 */
export class HostedRootQwenMemberComposition {
  private readonly policy: HostedQwenNetworkPolicy
  private readonly member: HostedProductMemberBinding
  private gateway: Gateway | null = null
  private containerId: string | null = null
  private cleanup: { id: string | null; grantAttempted: boolean; phase: CleanupPhase } | null = null
  private state: 'new' | 'starting' | 'active' | 'stopping' | 'cleanup-pending' | 'closed' = 'new'

  constructor(private readonly options: HostedRootQwenMemberOptions) {
    if (!options.member || !SHA.test(options.networkId) || !GENERATION.test(options.generation) ||
      !options.authority || typeof options.authority.withCurrentMemberDecision !== 'function' ||
      typeof options.authority.currentContainer !== 'function' ||
      !options.container || typeof options.container.start !== 'function' ||
      typeof options.container.prove !== 'function' ||
      typeof options.container.stopAndRemove !== 'function' ||
      options.testOnly && process.env.NODE_ENV !== 'test') {
      throw new Error('hosted-root-qwen-options-invalid')
    }
    this.member = Object.freeze({ ...options.member })
    this.policy = new HostedQwenNetworkPolicy({ networkId: options.networkId,
      generation: options.generation, gatewayPort: options.gatewayPort,
      stateDirectory: options.stateDirectory, runner: options.testOnly?.runner,
      testOnlyAllowNonRoot: !!options.testOnly })
  }

  private async current(kind: 'start' | 'observe'): Promise<void> {
    const allowed = await this.options.authority.withCurrentMemberDecision(this.member, kind,
      current => sameMember(current, this.member))
    if (!allowed) throw new Error('hosted-root-qwen-member-not-current')
  }

  private beginCleanup(id: string | null, grantAttempted: boolean): void {
    this.cleanup = { id, grantAttempted, phase: 'client' }
  }

  private async continueCleanup(): Promise<void> {
    const cleanup = this.cleanup
    if (!cleanup) throw new Error('hosted-root-qwen-state-invalid')
    // Advance only after each effect is proven. A failed Docker removal must
    // not replay revocation after the container has disappeared on a later try.
    if (cleanup.phase === 'client') {
      this.gateway?.revokeClient()
      cleanup.phase = 'revoke'
    }
    if (cleanup.phase === 'revoke') {
      if (cleanup.grantAttempted) {
        try { await this.policy.revokeContainer() }
        catch (error) {
          if (!(error instanceof Error) || error.message !== 'hosted-qwen-admission-invalid') throw error
        }
      }
      cleanup.phase = 'container'
    }
    if (cleanup.phase === 'container') {
      if (cleanup.id) await this.options.container.stopAndRemove(cleanup.id)
      cleanup.phase = 'listener'
    }
    if (cleanup.phase === 'listener') {
      await this.gateway?.stop()
      cleanup.phase = 'policy'
    }
    if (cleanup.phase === 'policy') await this.policy.close()
    this.cleanup = null
    this.containerId = null
    this.state = 'closed'
  }

  async start(): Promise<HostedQwenAdmission> {
    if (this.state !== 'new') throw new Error('hosted-root-qwen-state-invalid')
    this.state = 'starting'
    let id: string | null = null
    let grantAttempted = false
    let prepared = false
    try {
      await this.current('start')
      const bridge = await this.policy.prepare()
      prepared = true
      this.gateway = this.options.testOnly
        ? this.options.testOnly.gateway(bridge.gateway, this.policy)
        : new HostedQwenGateway({ bindAddress: bridge.gateway, port: this.options.gatewayPort,
          generation: this.options.generation, bridgeAuthority: this.policy,
          dispatchAuthority: this.options.authority })
      await this.gateway.start()
      // The deny rule and an unattested listener are in place before Docker Start.
      await this.current('start')
      id = await this.options.container.start()
      if (!SHA.test(id)) throw new Error('hosted-root-qwen-container-invalid')
      const proven = await this.options.container.prove(id)
      if (!proven || proven.containerId !== id || proven.networkId !== this.options.networkId ||
        !Number.isSafeInteger(proven.containerGeneration) || proven.containerGeneration < 1 ||
        !sameContainer(this.options.authority.currentContainer(), proven)) {
        throw new Error('hosted-root-qwen-container-proof-invalid')
      }
      await this.current('observe')
      grantAttempted = true
      const ip = await this.policy.admitContainer(id)
      if (ip !== proven.containerIp) throw new Error('hosted-root-qwen-container-proof-invalid')
      const admission = Object.freeze({ member: this.member, container: Object.freeze({ ...proven }),
        model: MODEL })
      this.gateway.admitClient(admission)
      await this.policy.attest()
      this.containerId = id
      this.state = 'active'
      return admission
    } catch (error) {
      if (prepared) {
        this.beginCleanup(id, grantAttempted)
        this.state = 'stopping'
        try { await this.continueCleanup() }
        catch (cleanupError) {
          this.state = 'cleanup-pending'
          throw new AggregateError([error, cleanupError], 'hosted-root-qwen-cleanup-unresolved')
        }
      }
      this.state = 'closed'
      throw error
    }
  }

  async stop(): Promise<void> {
    if (this.state === 'active' && this.containerId) {
      this.beginCleanup(this.containerId, true)
    } else if (this.state !== 'cleanup-pending') {
      throw new Error('hosted-root-qwen-state-invalid')
    }
    this.state = 'stopping'
    try {
      // Revoke and attest the exact source while it still exists. Never remove
      // the container first or delete the deny rule before the grant is gone.
      await this.continueCleanup()
    } catch (error) {
      // Retain the root claim on uncertainty; the caller must reconcile it.
      this.state = 'cleanup-pending'
      throw error
    }
  }
}
