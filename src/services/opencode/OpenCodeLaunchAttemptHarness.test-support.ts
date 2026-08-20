/**
 * Deterministic state model for the future OpenCode launch-attempt integration.
 *
 * This is deliberately test support: it never starts a process, contacts
 * OpenCode, reads a project, or waits on real time.
 */

import {
  OPEN_CODE_MEMBER_STATES,
  OpenCodeLaunchAttemptPolicy,
  classifyOpenCodeLaunchFailure,
  transitionOpenCodeLaunchMember,
} from './OpenCodeLaunchAttemptPolicy.js'

import type { OpenCodeLaunchMemberState } from './OpenCodeLaunchAttemptPolicy.js'
import {
  isOpenCodeLaunchAttemptId,
  isOpenCodeLaunchPayloadHash,
} from './OpenCodeBridgeContractV2.js'

export type RetainedOpenCodeHostIdentity = {
  hostKey: string
  pid: number
  birthIdentity: string
  providerScope: string
  profileScope: string
  cacheScope: string
}

export type OpenCodeProofChallenge = {
  ephemeral: true
  generation: number
  sessionId: string
  promptMessageId: string
  nonce: string
  providerId: string
  modelId: string
  host: RetainedOpenCodeHostIdentity
}

export type OpenCodeProofObservation = {
  generation: number
  sessionId: string
  assistantMessageId: string
  parentMessageId: string
  nonce: string
  providerId: string
  modelId: string
  host: RetainedOpenCodeHostIdentity
  mcpTools: readonly string[]
}

export type LaunchMemberSpec = {
  memberId: string
  prompt: string
}

export type LaunchAttemptJournalRecord =
  | { sequence: number; atMs: number; type: 'idempotency.accepted'; attemptId: string; payloadHash: string }
  | { sequence: number; atMs: number; type: 'idempotency.replayed'; attemptId: string; payloadHash: string; generation: number }
  | { sequence: number; atMs: number; type: 'proof.session.created'; generation: number; sessionId: string; promptMessageId: string }
  | { sequence: number; atMs: number; type: 'proof.accepted'; generation: number; sessionId: string; assistantMessageId: string; mcpTools: string[] }
  | { sequence: number; atMs: number; type: 'proof.rejected'; generation: number; reasons: string[] }
  | { sequence: number; atMs: number; type: 'continuation.started'; generation: number; memberIds: string[] }
  | { sequence: number; atMs: number; type: 'member.state.transition'; generation: number; memberId: string; from: OpenCodeLaunchMemberState; to: OpenCodeLaunchMemberState }
  | { sequence: number; atMs: number; type: 'member.session.created'; generation: number; memberId: string; sessionId: string }
  | { sequence: number; atMs: number; type: 'attempt.intent'; generation: number; memberId: string; sessionId: string; prompt: string }
  | { sequence: number; atMs: number; type: 'attempt.outcome'; generation: number; memberId: string; outcome: 'succeeded' | 'failed' | 'cancelled' | 'stale-completion-ignored'; detail?: string }
  | { sequence: number; atMs: number; type: 'store.commit'; generation: number; memberId: string; sessionId: string }
  | { sequence: number; atMs: number; type: 'cleanup.signal'; generation: number; memberId: string; signal: 'TERM' | 'KILL'; target: 'child' | 'grandchild' }
  | { sequence: number; atMs: number; type: 'cleanup.term-ignored'; generation: number; memberId: string }
  | { sequence: number; atMs: number; type: 'cleanup.child'; generation: number; memberId: string }
  | { sequence: number; atMs: number; type: 'cleanup.grandchild'; generation: number; memberId: string }
  | { sequence: number; atMs: number; type: 'cleanup.complete'; generation: number; memberId: string }

type MemberRecord = {
  spec: LaunchMemberSpec
  state: OpenCodeLaunchMemberState
  sessionId?: string
  runningGeneration?: number
  cleanupCompleteGeneration?: number
}

type JournalRecordInput = LaunchAttemptJournalRecord extends infer Record
  ? Record extends { sequence: number; atMs: number }
    ? Omit<Record, 'sequence' | 'atMs'>
    : never
  : never

export class OpenCodeLaunchContractViolationError extends Error {
  readonly kind = 'contract_violation' as const
  readonly retryDisposition = classifyOpenCodeLaunchFailure('contract_violation').retryDisposition
  readonly retryable = classifyOpenCodeLaunchFailure('contract_violation').retryable
  readonly sideEffectsStarted = classifyOpenCodeLaunchFailure('contract_violation').sideEffectsStarted

  constructor(readonly reason: 'attempt_id_mismatch' | 'payload_hash_mismatch' | 'invalid_payload_hash') {
    super(`OpenCode launch contract violation: ${reason}`)
    this.name = 'OpenCodeLaunchContractViolationError'
  }
}

export class FakeMonotonicClock {
  #nowMs: number

  constructor(nowMs = 1) {
    assertPositiveSafeInteger(nowMs, 'Monotonic clock value')
    this.#nowMs = nowMs
  }

  now(): number {
    return this.#nowMs
  }

  advanceBy(ms: number): number {
    assertPositiveSafeInteger(ms, 'Monotonic clock advance')
    this.#nowMs = checkedAdd(this.#nowMs, ms, 'Monotonic clock arithmetic')
    return this.#nowMs
  }

  advanceTo(ms: number): number {
    assertPositiveSafeInteger(ms, 'Monotonic clock value')
    if (ms < this.#nowMs) throw new Error('Monotonic time can only advance')
    this.#nowMs = ms
    return this.#nowMs
  }
}

export type DeterministicDeferred<T> = {
  promise: Promise<T>
  settled: boolean
  resolve(value: T | PromiseLike<T>): void
  reject(reason?: unknown): void
}

export function createDeterministicDeferred<T>(): DeterministicDeferred<T> {
  let resolvePromise!: (value: T | PromiseLike<T>) => void
  let rejectPromise!: (reason?: unknown) => void
  const deferred: DeterministicDeferred<T> = {
    promise: new Promise<T>((resolve, reject) => {
      resolvePromise = resolve
      rejectPromise = reject
    }),
    settled: false,
    resolve(value) {
      if (deferred.settled) return
      deferred.settled = true
      resolvePromise(value)
    },
    reject(reason) {
      if (deferred.settled) return
      deferred.settled = true
      rejectPromise(reason)
    },
  }
  return deferred
}

function equalHost(left: RetainedOpenCodeHostIdentity, right: RetainedOpenCodeHostIdentity): boolean {
  return left.hostKey === right.hostKey
    && left.pid === right.pid
    && left.birthIdentity === right.birthIdentity
    && left.providerScope === right.providerScope
    && left.profileScope === right.profileScope
    && left.cacheScope === right.cacheScope
}

export class OpenCodeLaunchAttemptHarness {
  readonly clock: FakeMonotonicClock
  readonly retainedHost: RetainedOpenCodeHostIdentity
  readonly providerId: string
  readonly modelId: string
  readonly requiredMcpTools: readonly string[]
  readonly totalBudgetMs: number
  readonly attemptId: string
  readonly payloadHash: string

  #policy: OpenCodeLaunchAttemptPolicy
  #generation = 1
  #proofCounter = 0
  #memberSessionCounter = 0
  #proofAcceptedGeneration: number | null = null
  #usedProofNonces = new Set<string>()
  #challenge: OpenCodeProofChallenge | null = null
  #schedulingStopped = false
  #stoppedGeneration: number | null = null
  #members = new Map<string, MemberRecord>()
  #journal: LaunchAttemptJournalRecord[] = []

  constructor(options: {
    clock?: FakeMonotonicClock
    retainedHost: RetainedOpenCodeHostIdentity
    providerId: string
    modelId: string
    requiredMcpTools: string[]
    totalBudgetMs: number
    attemptId: string
    payloadHash: string
    members: LaunchMemberSpec[]
  }) {
    assertPositiveSafeInteger(options.totalBudgetMs, 'Total launch budget')
    assertCanonicalPayloadHash(options.payloadHash)
    if (!isOpenCodeLaunchAttemptId(options.attemptId)) {
      throw new OpenCodeLaunchContractViolationError('attempt_id_mismatch')
    }

    this.clock = options.clock ?? new FakeMonotonicClock()
    assertPositiveSafeInteger(this.clock.now(), 'Monotonic clock value')
    this.#policy = this.#createPolicy(options.totalBudgetMs)
    this.#assertPolicyValues()
    this.totalBudgetMs = this.#policy.totalBudgetMs
    if (this.totalBudgetMs !== options.totalBudgetMs) {
      throw new Error('Total launch budget must be within the canonical policy range')
    }

    this.retainedHost = structuredClone(options.retainedHost)
    this.providerId = options.providerId
    this.modelId = options.modelId
    this.requiredMcpTools = [...options.requiredMcpTools]
    this.attemptId = options.attemptId
    this.payloadHash = options.payloadHash
    for (const spec of options.members) {
      if (this.#members.has(spec.memberId)) throw new Error(`Duplicate member ${spec.memberId}`)
      this.#members.set(spec.memberId, { spec: { ...spec }, state: OPEN_CODE_MEMBER_STATES[0] })
    }
    this.#append({ type: 'idempotency.accepted', attemptId: this.attemptId, payloadHash: this.payloadHash })
  }

  get generation(): number {
    return this.#generation
  }

  get cleanupReserveMs(): number {
    return this.#policy.cleanupReserveMs
  }

  get workDeadlineMs(): number {
    return this.#policy.workDeadlineAtMs
  }

  get absoluteDeadlineMs(): number {
    return this.#policy.absoluteDeadlineAtMs
  }

  get memberSessionCount(): number {
    return this.#journal.filter(record => record.type === 'member.session.created').length
  }

  beginProof(nonce: string): OpenCodeProofChallenge {
    if (!nonce) throw new Error('Proof nonce is required')
    if (this.#usedProofNonces.has(nonce)) throw new Error('Proof nonce must be fresh for every challenge')
    this.#usedProofNonces.add(nonce)
    this.#proofCounter = checkedAdd(this.#proofCounter, 1, 'Proof counter arithmetic')
    this.#challenge = {
      ephemeral: true,
      generation: this.#generation,
      sessionId: `proof-g${this.#generation}-${this.#proofCounter}`,
      promptMessageId: `proof-prompt-g${this.#generation}-${this.#proofCounter}`,
      nonce,
      providerId: this.providerId,
      modelId: this.modelId,
      host: structuredClone(this.retainedHost),
    }
    this.#append({
      type: 'proof.session.created',
      generation: this.#generation,
      sessionId: this.#challenge.sessionId,
      promptMessageId: this.#challenge.promptMessageId,
    })
    return structuredClone(this.#challenge)
  }

  observeProof(observation: OpenCodeProofObservation): { accepted: boolean; reasons: string[] } {
    const challenge = this.#challenge
    const reasons: string[] = []
    if (!challenge) reasons.push('missing-challenge')
    if (observation.generation !== this.#generation) reasons.push('stale-generation')
    if (challenge && observation.sessionId !== challenge.sessionId) reasons.push('wrong-session')
    if (challenge && observation.parentMessageId !== challenge.promptMessageId) reasons.push('wrong-parent')
    if (challenge && observation.nonce !== challenge.nonce) reasons.push('wrong-nonce')
    if (observation.providerId !== this.providerId) reasons.push('wrong-provider')
    if (observation.modelId !== this.modelId) reasons.push('wrong-model')
    if (!equalHost(observation.host, this.retainedHost)) reasons.push('wrong-host')
    const visibleTools = new Set(observation.mcpTools)
    if (this.requiredMcpTools.some(tool => !visibleTools.has(tool))) reasons.push('missing-mcp-tool')

    if (reasons.length > 0) {
      this.#append({ type: 'proof.rejected', generation: this.#generation, reasons: [...reasons] })
      return { accepted: false, reasons }
    }

    this.#proofAcceptedGeneration = this.#generation
    this.#challenge = null
    this.#append({
      type: 'proof.accepted',
      generation: this.#generation,
      sessionId: observation.sessionId,
      assistantMessageId: observation.assistantMessageId,
      mcpTools: [...observation.mcpTools],
    })
    return { accepted: true, reasons: [] }
  }

  createNextMemberSession(): { memberId: string; sessionId: string; generation: number } | null {
    this.#assertCurrentProof()
    if (this.clock.now() >= this.workDeadlineMs || this.#schedulingStopped) return null
    if ([...this.#members.values()].some(member => this.#isActive(member))) return null
    const member = [...this.#members.values()].find(candidate => candidate.state === 'pending')
    if (!member) return null
    this.#transition(member, 'creating')
    this.#memberSessionCounter = checkedAdd(this.#memberSessionCounter, 1, 'Member session counter arithmetic')
    const sessionId = `member-${member.spec.memberId}-g${this.#generation}-${this.#memberSessionCounter}`
    member.sessionId = sessionId
    member.runningGeneration = this.#generation
    this.#transition(member, 'session_created')
    this.#append({ type: 'member.session.created', generation: this.#generation, memberId: member.spec.memberId, sessionId })
    this.#append({ type: 'attempt.intent', generation: this.#generation, memberId: member.spec.memberId, sessionId, prompt: member.spec.prompt })
    return { memberId: member.spec.memberId, sessionId, generation: this.#generation }
  }

  markMemberMcpReady(memberId: string): void {
    const member = this.#member(memberId)
    this.#assertMemberMayAdvance(member)
    this.#transition(member, 'mcp_ready')
  }

  injectMemberBootstrap(memberId: string): void {
    const member = this.#member(memberId)
    this.#assertMemberMayAdvance(member)
    this.#transition(member, 'bootstrap_injected')
  }

  completeMember(memberId: string, generation = this.#generation): boolean {
    const member = this.#member(memberId)
    if (this.#schedulingStopped || member.state !== 'bootstrap_injected' || member.runningGeneration !== generation || generation !== this.#generation || this.clock.now() >= this.workDeadlineMs) {
      this.#append({ type: 'attempt.outcome', generation, memberId, outcome: 'stale-completion-ignored' })
      return false
    }
    this.#transition(member, 'committed')
    this.#append({ type: 'attempt.outcome', generation, memberId, outcome: 'succeeded' })
    this.#append({ type: 'store.commit', generation, memberId, sessionId: member.sessionId! })
    return true
  }

  failMember(memberId: string, detail: string, generation = this.#generation): boolean {
    const member = this.#member(memberId)
    if (!this.#isActive(member) || member.runningGeneration !== generation || generation !== this.#generation) {
      this.#append({ type: 'attempt.outcome', generation, memberId, outcome: 'stale-completion-ignored', detail })
      return false
    }
    this.#transition(member, 'failed')
    this.#transition(member, 'cleanup_pending')
    this.#append({ type: 'attempt.outcome', generation, memberId, outcome: 'failed', detail })
    this.#signalTerm(memberId, generation)
    this.#fenceStoppedGeneration(memberId, generation)
    return true
  }

  cancelMember(memberId: string): void {
    const member = this.#member(memberId)
    if (!this.#isActive(member)) return
    this.#transition(member, 'cancelled')
    this.#transition(member, 'cleanup_pending')
    this.#append({ type: 'attempt.outcome', generation: this.#generation, memberId, outcome: 'cancelled' })
    this.#signalTerm(memberId, this.#generation)
    this.#fenceStoppedGeneration(memberId, this.#generation)
  }

  noteIgnoredTerm(memberId: string): void {
    const member = this.#member(memberId)
    if (member.state !== 'cleanup_pending') throw new Error(`Member ${memberId} is not cleaning`)
    this.#append({ type: 'cleanup.term-ignored', generation: member.runningGeneration!, memberId })
  }

  enforceDeadline(): string[] {
    if (this.clock.now() < this.workDeadlineMs) return []
    const cleaning: string[] = []
    for (const [memberId, member] of this.#members) {
      if (this.#isActive(member)) {
        this.#transition(member, 'cleanup_pending')
        this.#schedulingStopped = true
        this.#stoppedGeneration = this.#generation
        this.#append({ type: 'attempt.outcome', generation: this.#generation, memberId, outcome: 'cancelled', detail: 'attempt-deadline' })
        this.#signalTerm(memberId, this.#generation)
        cleaning.push(memberId)
      } else if (member.state === 'cleanup_pending' && member.cleanupCompleteGeneration !== member.runningGeneration) {
        cleaning.push(memberId)
      }
    }
    return cleaning
  }

  finishCleanup(memberId: string, options: { force?: boolean } = {}): void {
    const member = this.#member(memberId)
    if (member.state !== 'cleanup_pending') throw new Error(`Member ${memberId} is not cleaning`)
    if (this.clock.now() >= this.absoluteDeadlineMs) throw new Error('Absolute attempt deadline leaves no time for cleanup mutation')
    const generation = member.runningGeneration!
    if (options.force) {
      this.#append({ type: 'cleanup.signal', generation, memberId, signal: 'KILL', target: 'grandchild' })
      this.#append({ type: 'cleanup.signal', generation, memberId, signal: 'KILL', target: 'child' })
    }
    this.#append({ type: 'cleanup.grandchild', generation, memberId })
    this.#append({ type: 'cleanup.child', generation, memberId })
    this.#append({ type: 'cleanup.complete', generation, memberId })
    member.cleanupCompleteGeneration = generation
  }

  beginAttempt(attemptId: string, payloadHash: string): { generation: number; memberStates: Record<string, OpenCodeLaunchMemberState> } {
    if (!isOpenCodeLaunchPayloadHash(payloadHash)) {
      throw new OpenCodeLaunchContractViolationError('invalid_payload_hash')
    }
    if (!isOpenCodeLaunchAttemptId(attemptId)) {
      throw new OpenCodeLaunchContractViolationError('attempt_id_mismatch')
    }
    if (attemptId !== this.attemptId) throw new OpenCodeLaunchContractViolationError('attempt_id_mismatch')
    if (payloadHash !== this.payloadHash) throw new OpenCodeLaunchContractViolationError('payload_hash_mismatch')
    this.#append({ type: 'idempotency.replayed', attemptId, payloadHash, generation: this.#generation })
    return { generation: this.#generation, memberStates: this.memberStates() }
  }

  continuePending(): string[] {
    if (!this.#schedulingStopped || this.#stoppedGeneration !== this.#generation) {
      throw new Error('Cannot continue without a failure or cancellation stop in the current generation')
    }
    const unsafe = [...this.#members.values()].filter(member => (
      this.#isActive(member)
      || (member.state === 'cleanup_pending'
        && member.runningGeneration === this.#stoppedGeneration
        && member.cleanupCompleteGeneration !== this.#stoppedGeneration)
    ))
    if (unsafe.length > 0) throw new Error('Cannot continue while an attempt may still mutate state')
    this.#generation = checkedAdd(this.#generation, 1, 'Generation arithmetic')
    this.#policy = this.#createPolicy(this.totalBudgetMs)
    this.#assertPolicyValues()
    this.#proofAcceptedGeneration = null
    this.#challenge = null
    this.#schedulingStopped = false
    this.#stoppedGeneration = null
    const pending: string[] = []
    for (const [memberId, member] of this.#members) {
      if (member.state === 'cleanup_pending') {
        this.#members.set(memberId, { spec: member.spec, state: 'pending' })
        pending.push(memberId)
      } else if (member.state === 'pending') {
        pending.push(memberId)
      }
    }
    this.#append({ type: 'continuation.started', generation: this.#generation, memberIds: pending })
    return pending
  }

  memberStates(): Record<string, OpenCodeLaunchMemberState> {
    return Object.fromEntries([...this.#members].map(([memberId, member]) => [memberId, member.state]))
  }

  journal(): LaunchAttemptJournalRecord[] {
    return structuredClone(this.#journal)
  }

  journalOfType<T extends LaunchAttemptJournalRecord['type']>(type: T): Array<Extract<LaunchAttemptJournalRecord, { type: T }>> {
    return this.journal().filter((record): record is Extract<LaunchAttemptJournalRecord, { type: T }> => record.type === type)
  }

  #createPolicy(totalBudgetMs: number): OpenCodeLaunchAttemptPolicy {
    return new OpenCodeLaunchAttemptPolicy({
      requestedBudgetMs: totalBudgetMs,
      monotonicNow: () => this.clock.now(),
    })
  }

  #assertPolicyValues(): void {
    assertPositiveSafeInteger(this.#policy.totalBudgetMs, 'Total launch budget')
    assertPositiveSafeInteger(this.#policy.cleanupReserveMs, 'Cleanup reserve')
    assertPositiveSafeInteger(this.#policy.startedAtMs, 'Launch start clock value')
    assertPositiveSafeInteger(this.#policy.workDeadlineAtMs, 'Work deadline')
    assertPositiveSafeInteger(this.#policy.absoluteDeadlineAtMs, 'Absolute deadline')
    if (this.#policy.workDeadlineAtMs >= this.#policy.absoluteDeadlineAtMs) {
      throw new Error('Work deadline must precede the absolute deadline')
    }
    if (checkedAdd(this.#policy.startedAtMs, this.#policy.totalBudgetMs, 'Absolute deadline arithmetic') !== this.#policy.absoluteDeadlineAtMs) {
      throw new Error('Absolute deadline arithmetic does not match the canonical total budget')
    }
    if (checkedAdd(this.#policy.workDeadlineAtMs, this.#policy.cleanupReserveMs, 'Cleanup reserve arithmetic') !== this.#policy.absoluteDeadlineAtMs) {
      throw new Error('Cleanup reserve arithmetic does not match the canonical work deadline')
    }
  }

  #member(memberId: string): MemberRecord {
    const member = this.#members.get(memberId)
    if (!member) throw new Error(`Unknown member ${memberId}`)
    return member
  }

  #isActive(member: MemberRecord): boolean {
    return member.state === 'creating'
      || member.state === 'session_created'
      || member.state === 'mcp_ready'
      || member.state === 'bootstrap_injected'
  }

  #assertMemberMayAdvance(member: MemberRecord): void {
    if (this.#schedulingStopped
      || member.runningGeneration !== this.#generation
      || !this.#isActive(member)) {
      throw new Error('Member is fenced from advancing after the generation stopped')
    }
  }

  #fenceStoppedGeneration(stoppedMemberId: string, generation: number): void {
    this.#schedulingStopped = true
    this.#stoppedGeneration = generation
    for (const [memberId, member] of this.#members) {
      if (memberId === stoppedMemberId
        || member.runningGeneration !== generation
        || !this.#isActive(member)) continue
      this.#transition(member, 'cleanup_pending')
      this.#append({
        type: 'attempt.outcome',
        generation,
        memberId,
        outcome: 'cancelled',
        detail: 'generation-fenced',
      })
      this.#signalTerm(memberId, generation)
    }
  }

  #transition(member: MemberRecord, to: OpenCodeLaunchMemberState): void {
    const from = member.state
    member.state = transitionOpenCodeLaunchMember(from, to)
    this.#append({
      type: 'member.state.transition',
      generation: this.#generation,
      memberId: member.spec.memberId,
      from,
      to,
    })
  }

  #assertCurrentProof(): void {
    if (this.#proofAcceptedGeneration !== this.#generation) {
      throw new Error('Exact retained-host proof is required before creating a member session')
    }
  }

  #signalTerm(memberId: string, generation: number): void {
    this.#append({ type: 'cleanup.signal', generation, memberId, signal: 'TERM', target: 'grandchild' })
    this.#append({ type: 'cleanup.signal', generation, memberId, signal: 'TERM', target: 'child' })
  }

  #append(record: JournalRecordInput): void {
    const atMs = this.clock.now()
    assertPositiveSafeInteger(atMs, 'Journal clock value')
    const sequence = checkedAdd(this.#journal.length, 1, 'Journal sequence arithmetic')
    this.#journal.push({ ...record, sequence, atMs } as LaunchAttemptJournalRecord)
  }
}

function assertCanonicalPayloadHash(payloadHash: string): void {
  if (!isOpenCodeLaunchPayloadHash(payloadHash)) {
    throw new OpenCodeLaunchContractViolationError('invalid_payload_hash')
  }
}

function assertPositiveSafeInteger(value: number, label: string): void {
  if (!Number.isFinite(value) || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive finite safe integer`)
  }
}

function checkedAdd(left: number, right: number, label: string): number {
  assertNonnegativeSafeInteger(left, `${label} left operand`)
  assertNonnegativeSafeInteger(right, `${label} right operand`)
  const result = left + right
  assertPositiveSafeInteger(result, label)
  return result
}

function assertNonnegativeSafeInteger(value: number, label: string): void {
  if (!Number.isFinite(value) || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative finite safe integer`)
  }
}
