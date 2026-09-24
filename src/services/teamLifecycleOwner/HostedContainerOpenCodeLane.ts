import { createHash } from 'node:crypto'

import type { HostedOpenCodeContainerSupervisor } from '../hostedControl/container/HostedOpenCodeContainerSupervisor.js'
import { hostedMemberAttempt, type HostedMemberSessionBridge } from '../hostedControl/hostedLaneSession/HostedMemberSessionBridge.js'
import type {
  TeamLifecycleLaneEffectPort,
  TeamLifecycleLaneInput,
  TeamLifecycleLaneObservation,
} from './OpenCodeTeamLifecycleLane.js'
import type { TeamLifecycleLaunchMember } from './TeamLifecycleLaunchPlan.js'

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
  memberId: string
  memberName: string
  model: string
  promptSha256: string
}>
type Binding = HostedContainerLaneBinding
type Container = Readonly<{ fingerprint: string; handle: string; generation: string }>
type Members = ReadonlyArray<{ binding: Binding; prompt: string }>
type PendingLaunch = { fingerprint: string; cancelRequested: boolean; result: Promise<TeamLifecycleLaneObservation> }

/** Trusted Product roster pins for one frozen lane, supplied only by hosted composition. */
export type HostedCanonicalLaneIdentity = Readonly<{
  operationId: string
  planSha256: string
  teamId: string
  runId: string
  laneOrdinal: number
  laneId: string
  members: ReadonlyArray<Readonly<{
    memberOrdinal: number
    memberId: string
    name: string
    model: string
    promptSha256: string
  }>>
}>

export type HostedCanonicalLaneIdentityResolver =
  (input: RunningInput) => Promise<HostedCanonicalLaneIdentity | null>

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
  claimLane(input: { key: string; fingerprint: string }): Promise<{ created: boolean; fingerprint: string }>
  /** Atomically tombstones a lane key, including one that never reached claimLane. */
  closeLane(input: { key: string; fingerprint: string }): Promise<{ closed: boolean; fingerprint: string }>
  readLane(key: string): Promise<string | null>
  claim(binding: Binding): Promise<{ created: boolean; fingerprint: string }>
  read(binding: Binding): Promise<{ state: 'absent' } | { state: 'claimed' | 'stopped'; fingerprint: string }>
  /** Persist terminal evidence only after an exact supervisor Stop/Reconcile receipt. */
  markStopped(binding: Binding, container: Container): Promise<boolean>
}

const ID = /^[a-z0-9][a-z0-9_-]{7,95}$/
const HANDLE = /^opencode_[0-9a-f]{32}$/
const GENERATION = /^[0-9a-f]{32}$/
const CANONICAL_TEAM = /^team_[0-9a-f]{32}$/
const CANONICAL_RUN = /^run_[0-9a-f]{32}$/
const CANONICAL_LANE = /^lane_[0-9a-f]{32}$/
const CANONICAL_MEMBER = /^member_[0-9a-f]{32}$/
const SHA256 = /^[0-9a-f]{64}$/
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

function planFingerprint(input: RunningInput): string {
  if (input.lane.kind !== 'opencode') throw new Error('Hosted OpenCode lane requires an OpenCode plan')
  const lane = input.lane
  return hash({
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
}

function binding(
  input: RunningInput,
  memberId: string,
  member: TeamLifecycleLaunchMember,
  canonical?: HostedCanonicalLaneIdentity,
  memberOrdinal?: number,
): Binding {
  if (input.lane.kind !== 'opencode') throw new Error('Hosted OpenCode lane requires an OpenCode plan')
  const lane = input.lane
  // The durable claim key cannot change if admission substitutes an ID for the
  // same planned member name. The original fingerprint then rejects the change.
  const key = hash([input.planTeamId, input.runId, lane.laneId, member.name.toLowerCase()])
  const fingerprint = hash(canonical
    ? [planFingerprint(input), canonical.operationId, canonical.planSha256,
      canonical.laneOrdinal, canonical.laneId, memberOrdinal, memberId, member.name,
      member.model ?? lane.selectedModel, createHash('sha256').update(member.prompt).digest('hex')]
    : [planFingerprint(input), memberId])
  return {
    key, fingerprint, operationId: `start_${hash([fingerprint, memberId])}`,
    runId: canonical ? input.runId : `run_${hash(input.runId)}`,
    teamId: canonical ? input.planTeamId : `team_${hash(input.planTeamId)}`,
    laneId: canonical ? canonical.laneId : `lane_${hash([input.planTeamId, lane.laneId])}`,
    memberId, memberName: member.name,
    model: member.model ?? lane.selectedModel,
    promptSha256: createHash('sha256').update(member.prompt).digest('hex'),
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
  readonly #pending = new Map<string, PendingLaunch>()
  readonly #closing = new Set<string>()

  constructor(
    private readonly supervisor: SupervisorPort,
    private readonly issueLease: HostedContainerLeaseIssuer,
    private readonly readiness: () => HostedContainerLaneReadiness = () => ({
      endpoint: false, fd3Handoff: false, providerConfig: false, memberSessions: false,
    }),
    private readonly attempts?: HostedContainerAttemptClaims,
    private readonly resolveMemberId?: (input: RunningInput, memberName: string) => Promise<string | null>,
    private readonly sessions?: HostedMemberSessionBridge,
    private readonly resolveCanonicalLaneIdentity?: HostedCanonicalLaneIdentityResolver,
  ) {}

  supports(action: 'launch' | 'cancel' | 'stop' | 'recover'): boolean {
    if (action !== 'launch') return true
    return this.#capabilityReady() || this.#attempted.size > 0
  }

  #capabilityReady(): boolean {
    if (!this.attempts || (!this.resolveMemberId && !this.resolveCanonicalLaneIdentity) ||
      (this.resolveMemberId && this.resolveCanonicalLaneIdentity) || !this.sessions) return false
    try {
      const ready = this.readiness()
      return ready.endpoint === true && ready.fd3Handoff === true &&
        ready.providerConfig === true && ready.memberSessions === true
    } catch { return false }
  }

  async inspect(input: ScopedInput): Promise<TeamLifecycleLaneObservation> {
    if (input.lane.kind !== 'opencode') throw new Error('Hosted OpenCode lane requires an OpenCode plan')
    if (!input.runId) return IDLE
    const members = await this.#members(input as RunningInput)
    if (!members) return FAILED
    let allReady = true
    for (const { binding: scoped } of members) {
      const container = this.#containers.get(scoped.key)
      if (!container || container.fingerprint !== scoped.fingerprint) return FAILED
      try {
        const observation = await this.supervisor.observe({
          operationId: `observe_${hash([scoped.fingerprint, scoped.memberId])}`, handle: container.handle,
          generation: container.generation,
        })
        if (observation.handle !== container.handle || observation.generation !== container.generation ||
          observation.status !== 'running' || observation.effectEnabled !== true ||
          !validEndpoint(observation.endpoint) || !observation.process ||
          !Number.isSafeInteger(observation.process.pid) || observation.process.pid < 1 ||
          !/^\d+$/.test(observation.process.startTicks) ||
          !/^pid:\[\d+\]$/.test(observation.process.pidNamespace)) return FAILED
        // The authenticated session port must observe the initial prompt in the
        // exact member/container generation before lifecycle can become running.
        if (!this.sessions) { allReady = false; continue }
        const state = await this.sessions.observe(hostedMemberAttempt({
          teamId: scoped.teamId, runId: scoped.runId, laneId: scoped.laneId,
          memberId: scoped.memberId, memberName: scoped.memberName,
          model: scoped.model, promptSha256: scoped.promptSha256,
          planFingerprint: scoped.fingerprint, containerHandle: container.handle,
          containerGeneration: container.generation,
        }))
        if (state === 'failed') return FAILED
        if (state !== 'ready') allReady = false
      } catch { return FAILED }
    }
    return allReady ? { phase: 'running', recoverable: false } : { phase: 'launching', recoverable: false }
  }

  async launch(input: RunningInput): Promise<TeamLifecycleLaneObservation> {
    if (input.toolApprovalMode !== 'auto') throw new Error('Hosted OpenCode container capability unavailable')
    const key = hash([input.planTeamId, input.runId, input.lane.laneId])
    const fingerprint = planFingerprint(input)
    if (this.#closing.has(key)) throw new Error('Hosted OpenCode run already closing')
    const existingPending = this.#pending.get(key)
    if (existingPending) {
      if (existingPending.fingerprint !== fingerprint) throw new Error('Hosted OpenCode plan changed during run')
      return existingPending.result
    }
    const pending: PendingLaunch = { fingerprint, cancelRequested: false, result: Promise.resolve(FAILED) }
    const operation = this.#launchAdmitted(input, pending)
    pending.result = operation
    this.#pending.set(key, pending)
    return operation.finally(() => { if (this.#pending.get(key) === pending) this.#pending.delete(key) })
  }

  async #launchAdmitted(input: RunningInput, pending: PendingLaunch): Promise<TeamLifecycleLaneObservation> {
    const members = await this.#members(input)
    if (!members) throw new Error('Hosted OpenCode member admission unavailable')
    if (pending.cancelRequested) return FAILED
    const existing = members.map(member => this.#containers.get(member.binding.key))
    if (existing.some((container, index) => container &&
      container.fingerprint !== members[index].binding.fingerprint)) {
      throw new Error('Hosted OpenCode plan changed during run')
    }
    if (existing.every(Boolean)) {
      const observed = await this.inspect(input)
      return pending.cancelRequested ? FAILED : observed
    }
    for (const { binding: scoped } of members) {
      const attempted = this.#attempted.get(scoped.key)
      if (attempted && !this.#containers.has(scoped.key)) {
        throw new Error(attempted === scoped.fingerprint
          ? 'Hosted OpenCode launch outcome unknown' : 'Hosted OpenCode plan changed during run')
      }
    }
    if (!this.#capabilityReady()) throw new Error('Hosted OpenCode container capability unavailable')
    if (pending.cancelRequested) return FAILED
    return this.#launch(members, input, pending)
  }

  async #launch(members: Members, input: RunningInput, pending: PendingLaunch): Promise<TeamLifecycleLaneObservation> {
    const laneClaim = await this.attempts!.claimLane({
      key: hash([input.planTeamId, input.runId, input.lane.laneId]),
      fingerprint: hash(members.map(member => member.binding.fingerprint)),
    })
    if (laneClaim.fingerprint !== hash(members.map(member => member.binding.fingerprint))) {
      throw new Error('Hosted OpenCode plan changed during run')
    }
    if (!laneClaim.created) throw new Error('Hosted OpenCode operation already claimed')
    if (pending.cancelRequested) return FAILED
    for (const { binding: scoped, prompt } of members) {
      if (pending.cancelRequested) return FAILED
      if (this.#containers.has(scoped.key)) continue
      this.#attempted.set(scoped.key, scoped.fingerprint)
      const claim = await this.attempts!.claim(scoped)
      if (claim.fingerprint !== scoped.fingerprint) {
        throw new Error('Hosted OpenCode plan changed during run')
      }
      if (claim.created !== true) {
        throw new Error('Hosted OpenCode operation already claimed')
      }
      if (pending.cancelRequested) return FAILED
      const leaseId = await this.issueLease(scoped)
      if (!ID.test(leaseId)) throw new Error('Hosted OpenCode lease ID invalid')
      if (pending.cancelRequested) return FAILED
      const started = await this.supervisor.start({
        operationId: scoped.operationId, leaseId,
        runId: scoped.runId, teamId: scoped.teamId, laneId: scoped.laneId, memberId: scoped.memberId,
      })
      if (!HANDLE.test(started.handle) || !GENERATION.test(started.generation)) return FAILED
      this.#containers.set(scoped.key, {
        fingerprint: scoped.fingerprint, handle: started.handle, generation: started.generation,
      })
      if (pending.cancelRequested) return FAILED
      if (started.status !== 'started' || started.effectEnabled !== true) return FAILED
      const session = await this.sessions!.start(hostedMemberAttempt({
        teamId: scoped.teamId, runId: scoped.runId, laneId: scoped.laneId,
        memberId: scoped.memberId, memberName: scoped.memberName,
        model: scoped.model, promptSha256: scoped.promptSha256,
        planFingerprint: scoped.fingerprint, containerHandle: started.handle,
        containerGeneration: started.generation,
      }), prompt)
      if (session === 'failed') return FAILED
      if (pending.cancelRequested) return FAILED
    }
    const observed = await this.inspect(input)
    return pending.cancelRequested ? FAILED : observed
  }

  cancel(input: RunningInput): Promise<TeamLifecycleLaneObservation> { return this.#end(input, false) }
  stop(input: RunningInput): Promise<TeamLifecycleLaneObservation> { return this.#end(input, false) }
  recover(input: RunningInput): Promise<TeamLifecycleLaneObservation> { return this.#end(input, true) }

  async #end(input: RunningInput, reconcile: boolean): Promise<TeamLifecycleLaneObservation> {
    const key = hash([input.planTeamId, input.runId, input.lane.laneId])
    this.#closing.add(key)
    const pending = this.#pending.get(key)
    if (pending) {
      if (pending.fingerprint !== planFingerprint(input)) return FAILED
      pending.cancelRequested = true
      await pending.result.catch(() => FAILED)
    }
    const members = await this.#members(input)
    if (!members) return FAILED
    const expectedFingerprint = hash(members.map(member => member.binding.fingerprint))
    let closed: { closed: boolean; fingerprint: string } | undefined
    try { closed = await this.attempts?.closeLane({ key, fingerprint: expectedFingerprint }) }
    catch { return FAILED }
    if (!closed?.closed || closed.fingerprint !== expectedFingerprint) return FAILED
    let claimedFingerprint: string | null
    try { claimedFingerprint = await this.attempts?.readLane(key) ?? null }
    catch { return FAILED }
    if (claimedFingerprint !== expectedFingerprint) return FAILED
    let allStopped = true
    for (const { binding: scoped } of members) {
      const container = this.#containers.get(scoped.key)
      let status: Awaited<ReturnType<HostedContainerAttemptClaims['read']>> | undefined
      try { status = await this.attempts?.read(scoped) } catch { allStopped = false; continue }
      if (!status || status.state !== 'absent' && status.fingerprint !== scoped.fingerprint) {
        allStopped = false
        continue
      }
      if (status.state === 'stopped') {
        this.#containers.delete(scoped.key)
        continue
      }
      if (status.state === 'absent' && !container) continue
      if (status.state !== 'claimed' || !container || container.fingerprint !== scoped.fingerprint) {
        allStopped = false
        continue
      }
      try {
        const request = {
          operationId: `${reconcile ? 'reconcile' : 'stop'}_${hash([scoped.fingerprint, scoped.memberId])}`,
          handle: container.handle, generation: container.generation,
        }
        const stopped = reconcile
          ? await this.supervisor.reconcile(request)
          : await this.supervisor.stop(request)
        if (stopped.handle !== container.handle || stopped.generation !== container.generation ||
          !stopped.stopped || stopped.unresolved) { allStopped = false; continue }
        if (!(await this.attempts!.markStopped(scoped, container))) { allStopped = false; continue }
        this.#containers.delete(scoped.key)
      } catch { allStopped = false }
    }
    return allStopped ? IDLE : FAILED
  }

  async #members(input: RunningInput): Promise<Members | null> {
    if (input.lane.kind !== 'opencode') return null
    if (this.resolveCanonicalLaneIdentity) {
      if (this.resolveMemberId) return null
      const canonical = await this.resolveCanonicalLaneIdentity(input)
      if (!canonical || !CANONICAL_TEAM.test(input.planTeamId) ||
        !CANONICAL_RUN.test(input.runId) || !CANONICAL_LANE.test(canonical.laneId) ||
        canonical.teamId !== input.planTeamId || canonical.runId !== input.runId ||
        canonical.laneId !== input.lane.laneId ||
        !SHA256.test(canonical.planSha256) || !/^promotion_[0-9a-f]{32}$/.test(canonical.operationId) ||
        !Number.isSafeInteger(canonical.laneOrdinal) || canonical.laneOrdinal < 0 ||
        canonical.laneOrdinal >= 32 || !Array.isArray(canonical.members) ||
        canonical.members.length !== input.lane.members.length ||
        canonical.members.length === 0 || canonical.members.length > 32) return null
      const ids = new Set<string>()
      const members: Array<{ binding: Binding; prompt: string }> = []
      for (const [ordinal, member] of input.lane.members.entries()) {
        const pinned = canonical.members[ordinal]
        const promptSha256 = createHash('sha256').update(member.prompt).digest('hex')
        if (!pinned || pinned.memberOrdinal !== ordinal || !CANONICAL_MEMBER.test(pinned.memberId) ||
          ids.has(pinned.memberId) || pinned.name !== member.name ||
          pinned.model !== (member.model ?? input.lane.selectedModel) ||
          pinned.promptSha256 !== promptSha256) return null
        ids.add(pinned.memberId)
        members.push({ binding: binding(input, pinned.memberId, member, canonical, ordinal), prompt: member.prompt })
      }
      return members
    }
    if (!this.resolveMemberId) return null
    const members: Array<{ binding: Binding; prompt: string }> = []
    const ids = new Set<string>()
    for (const member of input.lane.members) {
      const memberId = await this.resolveMemberId(input, member.name)
      if (!memberId || !/^member_[0-9a-f]{32}$/.test(memberId) || ids.has(memberId)) return null
      ids.add(memberId)
      members.push({ binding: binding(input, memberId, member), prompt: member.prompt })
    }
    return members.length === input.lane.members.length && members.length > 0 ? members : null
  }
}
