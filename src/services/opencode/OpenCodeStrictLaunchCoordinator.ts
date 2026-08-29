export type StrictPortResult<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'failure'; error: string; resources?: StrictResource[] }
  | { kind: 'unknown'; error: string; resources?: StrictResource[] }
export interface StrictAttemptIdentity {
  attemptId: string
  generation: number
}
export interface StrictResource extends StrictAttemptIdentity {
  resourceId: string
  committed: boolean
}
export interface StrictHost {
  hostId: string
}
/** A caller-owned capability which can be released even without a host result. */
export interface StrictHostLease {
  leaseId: string
  expectedHostId: string
}
export interface StrictProof extends StrictAttemptIdentity {
  nonce: string
  hostId: string
  providerId: string
  modelId: string
  behaviorFingerprint: string
  mcpTools: string[]
}
export interface StrictProofRequest extends StrictAttemptIdentity {
  nonce: string
  expectedHostId: string
  providerId: string
  modelId: string
  behaviorFingerprint: string
  readonly mcpTools: readonly string[]
}
export interface StrictMember {
  memberId: string
  memberFingerprint: string
}
export interface StrictCommittedMember<P> {
  memberId: string
  memberFingerprint: string
  behaviorFingerprint: string
  projection: P
}
export interface StrictMaterializedMember<P>
  extends StrictCommittedMember<P>, StrictAttemptIdentity {
  resource: StrictResource
}
export type StrictStopReason = 'cancelled' | 'deadline'
/** Injected so deadline tests and runtimes do not depend on global timers. */
export interface StrictLaunchScheduler {
  now(): number
  waitUntil(deadlineAt: number, signal: AbortSignal): Promise<void>
}
export interface StrictLaunchRequest<W, C> extends StrictAttemptIdentity {
  nonce: string
  providerId: string
  modelId: string
  behaviorFingerprint: string
  mcpTools: string[]
  members: StrictMember[]
  workContext: W
  cleanupContext: C
  hostLease: StrictHostLease
  deadlineAt: number
  cleanupReserveMs: number
  signal: AbortSignal
  scheduler: StrictLaunchScheduler
}
export interface StrictLaunchPorts<W, C, P> {
  /**
   * Returns a synchronous snapshot with no caller-mutable state shared with projection.
   */
  snapshotProjection(projection: P): P
  acquireHost(
    context: W,
    identity: StrictAttemptIdentity,
    lease: StrictHostLease,
    signal: AbortSignal,
  ): Promise<StrictPortResult<StrictHost>>
  requestProof(
    context: W,
    host: StrictHost,
    request: StrictProofRequest,
    signal: AbortSignal,
  ): Promise<StrictPortResult<StrictProof>>
  findCommitted(
    context: W,
    member: StrictMember,
    signal: AbortSignal,
  ): Promise<StrictPortResult<StrictCommittedMember<P> | null>>
  projectCommitted(
    context: W,
    member: StrictCommittedMember<P>,
    signal: AbortSignal,
  ): Promise<StrictPortResult<void>>
  materialize(
    context: W,
    host: StrictHost,
    member: StrictMember,
    identity: StrictAttemptIdentity,
    signal: AbortSignal,
  ): Promise<StrictPortResult<StrictMaterializedMember<P>>>
  cleanup(
    context: C,
    resources: StrictResource[],
    signal: AbortSignal,
  ): Promise<void>
  releaseHost(
    context: C,
    lease: StrictHostLease,
    keepAlive: boolean,
    signal: AbortSignal,
  ): Promise<void>
}
export type StrictLaunchStatus =
  | 'committed'
  | 'stopped'
  | 'failure'
  | 'unknown'
  | 'invalid-proof'
  | 'stale-result'
export interface StrictLaunchResult<P> {
  status: StrictLaunchStatus
  reason?: string
  projections: P[]
  committedMemberIds: string[]
}
type MutableResult<P> = StrictLaunchResult<P> & { done: boolean }
type Settled<T> =
  | { kind: 'settled'; value: StrictPortResult<T> }
  | { kind: 'stopped'; reason: StrictStopReason; started: boolean }
type SchedulerSnapshot = Readonly<{
  now: () => number
  waitUntil: (deadlineAt: number, signal: AbortSignal) => Promise<void>
}>
function sameIdentity(a: StrictAttemptIdentity, b: StrictAttemptIdentity): boolean {
  return a.attemptId === b.attemptId && a.generation === b.generation
}
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
function finish<P>(
  result: MutableResult<P>,
  status: StrictLaunchStatus,
  reason?: string,
): void {
  result.status = status
  result.reason = reason
  result.done = true
}
function publicResult<P>(result: MutableResult<P>): StrictLaunchResult<P> {
  const { done: _done, ...value } = result
  return value
}
function collectOwnedFailureResources(
  identity: StrictAttemptIdentity,
  cleanup: StrictResource[],
  resources?: StrictResource[],
): boolean {
  let committed = false
  for (const resource of resources ?? []) {
    if (!sameIdentity(identity, resource)) continue
    if (resource.committed) committed = true
    else cleanup.push({ ...resource })
  }
  return committed
}
function proofMismatch(
  expected: StrictProofRequest,
  proof: StrictProof,
): string | undefined {
  if (!sameIdentity(expected, proof)) return 'attempt identity'
  if (proof.nonce !== expected.nonce) return 'nonce'
  if (proof.hostId !== expected.expectedHostId) return 'host identity'
  if (proof.providerId !== expected.providerId) return 'provider'
  if (proof.modelId !== expected.modelId) return 'model'
  if (proof.behaviorFingerprint !== expected.behaviorFingerprint) {
    return 'behavior fingerprint'
  }
  if (
    proof.mcpTools.length !== expected.mcpTools.length ||
    expected.mcpTools.some((tool, index) => tool !== proof.mcpTools[index])
  ) return 'MCP tools'
  return undefined
}
/** Races a port with cancellation/deadline and permanently observes it. */
async function bounded<T>(
  operation: (signal: AbortSignal) => Promise<StrictPortResult<T>>,
  deadlineAt: number,
  scheduler: SchedulerSnapshot,
  externalSignal?: AbortSignal,
  finalize = false,
): Promise<Settled<T>> {
  const operationController = new AbortController()
  const timerController = new AbortController()
  let resolveStop!: (reason: StrictStopReason) => void
  let stopReason: StrictStopReason | undefined
  let started = false
  const stopped = new Promise<StrictStopReason>(resolve => { resolveStop = resolve })
  const stop = (reason: StrictStopReason) => {
    if (stopReason) return
    stopReason = reason
    operationController.abort()
    resolveStop(reason)
  }
  const cancel = () => stop('cancelled')
  externalSignal?.addEventListener('abort', cancel, { once: true })
  if (externalSignal?.aborted) cancel()
  if (scheduler.now() >= deadlineAt) stop('deadline')
  const timer = scheduler.waitUntil(deadlineAt, timerController.signal).then(
    () => stop('deadline'),
    () => {
      if (!timerController.signal.aborted) stop('deadline')
    },
  )
  const observed = Promise.resolve()
    .then(() => {
      if (!finalize && (stopReason || operationController.signal.aborted)) {
        return new Promise<StrictPortResult<T>>(() => {})
      }
      started = true
      return operation(operationController.signal)
    })
    .then<StrictPortResult<T>>(
      value => value,
      error => ({ kind: 'unknown', error: errorText(error) }),
    )
  const winner = await Promise.race([
    observed.then(value => ({ kind: 'settled', value }) as const),
    stopped.then(reason => ({ kind: 'stopped', reason, started }) as const),
  ])
  timerController.abort()
  operationController.abort()
  externalSignal?.removeEventListener('abort', cancel)
  void timer
  void observed
  if (externalSignal?.aborted) return { kind: 'stopped', reason: 'cancelled', started }
  if (scheduler.now() >= deadlineAt) return { kind: 'stopped', reason: 'deadline', started }
  return winner
}
async function boundedVoid(
  operation: (signal: AbortSignal) => Promise<void>,
  deadlineAt: number,
  scheduler: SchedulerSnapshot,
): Promise<void> {
  await bounded(
    async signal => {
      await operation(signal)
      return { kind: 'ok', value: undefined }
    },
    deadlineAt, scheduler, undefined, true,
  )
}
/** Coordinates one request-local attempt without retries or process state. */
export async function coordinateStrictLaunch<W, C, P>(
  request: StrictLaunchRequest<W, C>,
  ports: StrictLaunchPorts<W, C, P>,
): Promise<StrictLaunchResult<P>> {
  // Everything supplied by the caller which affects identity is copied before
  // the first await. Context values intentionally remain opaque references.
  const identity = Object.freeze({
    attemptId: request.attemptId,
    generation: request.generation,
  })
  const lease = Object.freeze({
    leaseId: request.hostLease.leaseId,
    expectedHostId: request.hostLease.expectedHostId,
  })
  const proofRequest: StrictProofRequest = Object.freeze({
    ...identity,
    nonce: request.nonce,
    expectedHostId: lease.expectedHostId,
    providerId: request.providerId,
    modelId: request.modelId,
    behaviorFingerprint: request.behaviorFingerprint,
    mcpTools: Object.freeze([...request.mcpTools]),
  })
  const members = request.members.map(member => Object.freeze({ ...member }))
  const workContext = request.workContext
  const cleanupContext = request.cleanupContext
  const scheduler = Object.freeze({ now: request.scheduler.now.bind(request.scheduler),
    waitUntil: request.scheduler.waitUntil.bind(request.scheduler) })
  const externalSignal = request.signal
  const deadlineAt = request.deadlineAt
  const cleanupReserveMs = Math.max(0, request.cleanupReserveMs)
  const workDeadlineAt = deadlineAt - cleanupReserveMs
  const acquireHost = ports.acquireHost.bind(ports)
  const requestProof = ports.requestProof.bind(ports)
  const findCommitted = ports.findCommitted.bind(ports)
  const snapshotProjection = ports.snapshotProjection.bind(ports)
  const projectCommitted = ports.projectCommitted.bind(ports)
  const materialize = ports.materialize.bind(ports)
  const cleanupPort = ports.cleanup.bind(ports)
  const releaseHost = ports.releaseHost.bind(ports)
  const result: MutableResult<P> = {
    status: 'committed', projections: [], committedMemberIds: [], done: false,
  }
  const cleanup: StrictResource[] = []
  let leaseUsed = false
  let uncertainIrreversible = false
  const stop = (): StrictStopReason | undefined => {
    if (externalSignal.aborted) return 'cancelled'
    if (scheduler.now() >= workDeadlineAt) return 'deadline'
    return undefined
  }
  const stopped = (): boolean => {
    const reason = stop()
    if (reason) finish(result, 'stopped', reason)
    return Boolean(reason)
  }
  const accept = (outcome: Exclude<StrictPortResult<unknown>, { kind: 'ok' }>) => {
    finish(result, outcome.kind, outcome.error)
  }
  try {
    if (stopped()) return publicResult(result)
    leaseUsed = true
    const acquired = await bounded(
      signal => acquireHost(workContext, identity, lease, signal),
      workDeadlineAt, scheduler, externalSignal,
    )
    if (acquired.kind === 'stopped' || stopped()) {
      if (acquired.kind === 'stopped' && acquired.started) uncertainIrreversible = true
      finish(result, 'stopped', acquired.kind === 'stopped' ? acquired.reason : stop())
      return publicResult(result)
    }
    if (acquired.value.kind !== 'ok') {
      if (acquired.value.kind === 'unknown') uncertainIrreversible = true
      else uncertainIrreversible = collectOwnedFailureResources(
        identity, cleanup, acquired.value.resources,
      ) || uncertainIrreversible
      accept(acquired.value)
      return publicResult(result)
    }
    const host = Object.freeze({ hostId: acquired.value.value.hostId })
    if (host.hostId !== lease.expectedHostId) {
      finish(result, 'stale-result', 'host identity')
      return publicResult(result)
    }
    if (stopped()) return publicResult(result)
    const proof = await bounded(
      signal => requestProof(workContext, host, proofRequest, signal),
      workDeadlineAt, scheduler, externalSignal,
    )
    if (proof.kind === 'stopped' || stopped()) {
      finish(result, 'stopped', proof.kind === 'stopped' ? proof.reason : stop())
      return publicResult(result)
    }
    if (proof.value.kind !== 'ok') {
      if (proof.value.kind === 'failure') uncertainIrreversible =
        collectOwnedFailureResources(identity, cleanup, proof.value.resources) || uncertainIrreversible
      accept(proof.value)
      return publicResult(result)
    }
    const mismatch = proofMismatch(proofRequest, proof.value.value)
    if (mismatch) {
      finish(result, sameIdentity(identity, proof.value.value) ? 'invalid-proof' : 'stale-result', mismatch)
      return publicResult(result)
    }
    for (const member of members) {
      if (stopped()) break
      const existing = await bounded(
        signal => findCommitted(workContext, member, signal),
        workDeadlineAt, scheduler, externalSignal,
      )
      if (existing.kind === 'stopped' || stopped()) {
        finish(result, 'stopped', existing.kind === 'stopped' ? existing.reason : stop())
        break
      }
      if (existing.value.kind !== 'ok') {
        if (existing.value.kind === 'failure') uncertainIrreversible =
          collectOwnedFailureResources(identity, cleanup, existing.value.resources) || uncertainIrreversible
        accept(existing.value)
        break
      }
      if (existing.value.value) {
        const found = existing.value.value
        const memberId = found.memberId
        const memberFingerprint = found.memberFingerprint
        if (memberId !== member.memberId || memberFingerprint !== member.memberFingerprint) {
          finish(result, 'stale-result', 'committed member identity')
          break
        }
        if (found.behaviorFingerprint !== proofRequest.behaviorFingerprint) {
          finish(result, 'stale-result', 'committed member behavior fingerprint')
          break
        }
        result.committedMemberIds.push(member.memberId)
        let retainedProjection: P
        let value: StrictCommittedMember<P>
        try {
          retainedProjection = snapshotProjection(found.projection)
          value = Object.freeze({ memberId, memberFingerprint,
            behaviorFingerprint: found.behaviorFingerprint,
            projection: snapshotProjection(retainedProjection) })
        } catch (error) {
          finish(result, 'unknown', errorText(error))
          break
        }
        if (stopped()) break
        const projected = await bounded(
          signal => projectCommitted(workContext, value, signal),
          workDeadlineAt, scheduler, externalSignal,
        )
        if (projected.kind === 'stopped' || stopped()) {
          finish(result, 'stopped', projected.kind === 'stopped' ? projected.reason : stop())
          break
        }
        if (projected.value.kind !== 'ok') {
          if (projected.value.kind === 'failure') uncertainIrreversible =
            collectOwnedFailureResources(identity, cleanup, projected.value.resources) || uncertainIrreversible
          accept(projected.value)
          break
        }
        result.projections.push(retainedProjection)
        continue
      }
      if (stopped()) break
      const created = await bounded(
        signal => materialize(workContext, host, member, identity, signal),
        workDeadlineAt, scheduler, externalSignal,
      )
      if (created.kind === 'stopped' || stopped()) {
        uncertainIrreversible = true
        finish(result, 'stopped', created.kind === 'stopped' ? created.reason : stop())
        break
      }
      if (created.value.kind !== 'ok') {
        if (created.value.kind === 'unknown') uncertainIrreversible = true
        else uncertainIrreversible = collectOwnedFailureResources(
          identity, cleanup, created.value.resources,
        ) || uncertainIrreversible
        accept(created.value)
        break
      }
      const value = created.value.value
      const exact = sameIdentity(identity, value) &&
        sameIdentity(identity, value.resource) && value.resource.committed &&
        value.memberId === member.memberId &&
        value.memberFingerprint === member.memberFingerprint &&
        value.behaviorFingerprint === proofRequest.behaviorFingerprint
      if (!exact) {
        uncertainIrreversible = collectOwnedFailureResources(identity, cleanup, [value.resource]) ||
          uncertainIrreversible
        finish(result, 'stale-result', 'materialized member identity')
        break
      }
      result.committedMemberIds.push(member.memberId)
      try {
        result.projections.push(snapshotProjection(value.projection))
      } catch (error) {
        finish(result, 'unknown', errorText(error))
        break
      }
    }
  } finally {
    await boundedVoid(signal => cleanupPort(cleanupContext, cleanup, signal), deadlineAt, scheduler)
    if (leaseUsed) {
      await boundedVoid(
        signal => releaseHost(
          cleanupContext, lease,
          uncertainIrreversible || result.committedMemberIds.length > 0,
          signal,
        ),
        deadlineAt,
        scheduler,
      )
    }
  }
  return publicResult(result)
}
