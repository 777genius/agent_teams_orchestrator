import { createHash } from 'node:crypto'

import type { HostedOpenCodeContainerSupervisor } from '../hostedControl/container/HostedOpenCodeContainerSupervisor.js'
import type {
  TeamLifecycleLaneEffectPort,
  TeamLifecycleLaneInput,
  TeamLifecycleLaneObservation,
} from './OpenCodeTeamLifecycleLane.js'

type RunningInput = TeamLifecycleLaneInput & { runId: string }
type ScopedInput = TeamLifecycleLaneInput & { runId: string | null }
type SupervisorPort = {
  start(...args: Parameters<HostedOpenCodeContainerSupervisor['start']>): Promise<
    Omit<Awaited<ReturnType<HostedOpenCodeContainerSupervisor['start']>>, 'effectEnabled'> & { effectEnabled: boolean }
  >
  observe(...args: Parameters<HostedOpenCodeContainerSupervisor['observe']>): Promise<
    Omit<Awaited<ReturnType<HostedOpenCodeContainerSupervisor['observe']>>, 'effectEnabled'> & { effectEnabled: boolean }
  >
  stop: HostedOpenCodeContainerSupervisor['stop']
  reconcile: HostedOpenCodeContainerSupervisor['reconcile']
}
export type HostedContainerLaneBinding = Readonly<{
  key: string
  fingerprint: string
  operationId: string
  runId: string
  teamId: string
  laneId: string
}>
type Binding = HostedContainerLaneBinding
type Container = Readonly<{ fingerprint: string; handle: string; generation: string }>

export type HostedContainerLaneReadiness = Readonly<{
  endpoint: boolean
  fd3Handoff: boolean
  providerConfig: boolean
  memberSessions: boolean
}>

/** A trusted root issuer returns only a lease ID. Owner never supplies filesystem paths. */
export type HostedContainerLeaseIssuer = (binding: Binding) => Promise<string>

/**
 * Atomically and durably claims stable team/run/lane key before any lease or Start.
 * An existing key always returns its original fingerprint, even when a caller changed
 * member prompt/model or workspace. It must never create a second claim for that key.
 */
export interface HostedContainerAttemptClaims {
  claim(binding: Binding): Promise<{ created: boolean; fingerprint: string }>
}

const ID = /^[a-z0-9][a-z0-9_-]{7,95}$/
const HANDLE = /^opencode_[0-9a-f]{32}$/
const GENERATION = /^[0-9a-f]{32}$/
const FAILED: TeamLifecycleLaneObservation = { phase: 'failed', recoverable: true }
const IDLE: TeamLifecycleLaneObservation = { phase: 'idle', recoverable: false }

function validEndpoint(value: unknown): boolean {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' &&
      /^\d+$/.test(url.port) && Number(url.port) >= 1024 && Number(url.port) <= 65_535 &&
      !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash
  } catch { return false }
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function binding(input: RunningInput): Binding {
  if (input.lane.kind !== 'opencode') throw new Error('Hosted OpenCode lane requires an OpenCode plan')
  const lane = input.lane
  const key = hash([input.planTeamId, input.runId, lane.laneId])
  const fingerprint = hash({
    planTeamId: input.planTeamId,
    workspaceRoot: input.workspaceRoot,
    toolApprovalMode: input.toolApprovalMode,
    runId: input.runId,
    laneId: lane.laneId,
    selectedModel: lane.selectedModel,
    effort: lane.effort ?? null,
    members: lane.members.map(member => ({
      name: member.name, prompt: member.prompt, model: member.model ?? null,
      effort: member.effort ?? null,
    })),
  })
  return {
    key, fingerprint, operationId: `start_${fingerprint}`,
    runId: `run_${hash(input.runId)}`,
    teamId: `team_${hash(input.planTeamId)}`,
    laneId: `lane_${hash([input.planTeamId, lane.laneId])}`,
  }
}

/**
 * Inactive hosted-only seam. No composition imports this adapter. The current supervisor
 * always returns effectEnabled:false, and a missing in-memory handle after a crash is
 * recoverable failure until a trusted root operation lookup/atomic binding is added.
 * The durable attempt claim prevents a restart from issuing Start again for that run.
 */
export class HostedContainerOpenCodeLane implements TeamLifecycleLaneEffectPort {
  readonly kind = 'opencode' as const
  readonly #containers = new Map<string, Container>()
  readonly #attempted = new Map<string, string>()
  readonly #pending = new Map<string, { fingerprint: string; result: Promise<TeamLifecycleLaneObservation> }>()

  constructor(
    private readonly supervisor: SupervisorPort,
    private readonly issueLease: HostedContainerLeaseIssuer,
    private readonly readiness: () => HostedContainerLaneReadiness = () => ({
      endpoint: false, fd3Handoff: false, providerConfig: false, memberSessions: false,
    }),
    private readonly attempts?: HostedContainerAttemptClaims,
  ) {}

  supports(action: 'launch' | 'cancel' | 'stop' | 'recover'): boolean {
    if (action !== 'launch') return true
    return this.#capabilityReady() || this.#attempted.size > 0
  }

  #capabilityReady(): boolean {
    if (!this.attempts) return false
    try {
      const ready = this.readiness()
      return ready.endpoint === true && ready.fd3Handoff === true &&
        ready.providerConfig === true && ready.memberSessions === true
    } catch { return false }
  }

  async inspect(input: ScopedInput): Promise<TeamLifecycleLaneObservation> {
    if (input.lane.kind !== 'opencode') throw new Error('Hosted OpenCode lane requires an OpenCode plan')
    if (!input.runId) return IDLE
    const scoped = binding(input as RunningInput)
    const container = this.#containers.get(scoped.key)
    if (!container || container.fingerprint !== scoped.fingerprint) return FAILED
    try {
      const observation = await this.supervisor.observe({
        operationId: `observe_${scoped.fingerprint}`, handle: container.handle,
        generation: container.generation,
      })
      if (observation.handle !== container.handle || observation.generation !== container.generation ||
        observation.status !== 'running' || observation.effectEnabled !== true ||
        !validEndpoint(observation.endpoint) || !observation.process ||
        !Number.isSafeInteger(observation.process.pid) || observation.process.pid < 1 ||
        !/^\d+$/.test(observation.process.startTicks) ||
        !/^pid:\[\d+\]$/.test(observation.process.pidNamespace)) return FAILED
      // A healthy container is not proof that the plan's members were launched.
      return { phase: 'launching', recoverable: false }
    } catch { return FAILED }
  }

  async launch(input: RunningInput): Promise<TeamLifecycleLaneObservation> {
    if (input.toolApprovalMode !== 'auto') throw new Error('Hosted OpenCode container capability unavailable')
    const scoped = binding(input)
    const existing = this.#containers.get(scoped.key)
    if (existing) {
      if (existing.fingerprint !== scoped.fingerprint) throw new Error('Hosted OpenCode plan changed during run')
      return this.inspect(input)
    }
    const pending = this.#pending.get(scoped.key)
    if (pending) {
      if (pending.fingerprint !== scoped.fingerprint) throw new Error('Hosted OpenCode plan changed during run')
      return pending.result
    }
    const attempted = this.#attempted.get(scoped.key)
    if (attempted) {
      throw new Error(attempted === scoped.fingerprint
        ? 'Hosted OpenCode launch outcome unknown' : 'Hosted OpenCode plan changed during run')
    }
    if (!this.#capabilityReady()) throw new Error('Hosted OpenCode container capability unavailable')
    this.#attempted.set(scoped.key, scoped.fingerprint)
    const operation = this.#launch(scoped, input)
    this.#pending.set(scoped.key, { fingerprint: scoped.fingerprint, result: operation })
    return operation.finally(() => { if (this.#pending.get(scoped.key)?.result === operation) this.#pending.delete(scoped.key) })
  }

  async #launch(scoped: Binding, input: RunningInput): Promise<TeamLifecycleLaneObservation> {
    const claim = await this.attempts!.claim(scoped)
    if (claim.fingerprint !== scoped.fingerprint) {
      throw new Error('Hosted OpenCode plan changed during run')
    }
    if (claim.created !== true) {
      throw new Error('Hosted OpenCode operation already claimed')
    }
    const leaseId = await this.issueLease(scoped)
    if (!ID.test(leaseId)) throw new Error('Hosted OpenCode lease ID invalid')
    const started = await this.supervisor.start({
      operationId: scoped.operationId, leaseId,
      runId: scoped.runId, teamId: scoped.teamId, laneId: scoped.laneId,
    })
    if (!HANDLE.test(started.handle) || !GENERATION.test(started.generation)) return FAILED
    this.#containers.set(scoped.key, {
      fingerprint: scoped.fingerprint, handle: started.handle, generation: started.generation,
    })
    if (started.status !== 'started' || started.effectEnabled !== true) return FAILED
    return this.inspect(input)
  }

  cancel(input: RunningInput): Promise<TeamLifecycleLaneObservation> { return this.#end(input, false) }
  stop(input: RunningInput): Promise<TeamLifecycleLaneObservation> { return this.#end(input, false) }
  recover(input: RunningInput): Promise<TeamLifecycleLaneObservation> { return this.#end(input, true) }

  async #end(input: RunningInput, reconcile: boolean): Promise<TeamLifecycleLaneObservation> {
    const scoped = binding(input)
    const pending = this.#pending.get(scoped.key)
    if (pending) {
      if (pending.fingerprint !== scoped.fingerprint) return FAILED
      await pending.result.catch(() => FAILED)
    }
    const container = this.#containers.get(scoped.key)
    if (!container || container.fingerprint !== scoped.fingerprint) return FAILED
    try {
      const request = {
        operationId: `${reconcile ? 'reconcile' : 'stop'}_${scoped.fingerprint}`,
        handle: container.handle, generation: container.generation,
      }
      const stopped = reconcile
        ? await this.supervisor.reconcile(request)
        : await this.supervisor.stop(request)
      if (stopped.handle !== container.handle || stopped.generation !== container.generation ||
        !stopped.stopped || stopped.unresolved) return FAILED
      this.#containers.delete(scoped.key)
      return IDLE
    } catch { return FAILED }
  }
}
