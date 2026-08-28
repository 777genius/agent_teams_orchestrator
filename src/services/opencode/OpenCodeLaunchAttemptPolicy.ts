export const OPEN_CODE_LAUNCH_DEFAULT_BUDGET_MS = 300_000
export const OPEN_CODE_LAUNCH_MAX_BUDGET_MS = 300_000
export const OPEN_CODE_LAUNCH_MIN_BUDGET_MS = 10_000

export const OPEN_CODE_LAUNCH_PHASE_CEILINGS_MS = {
  profile_prepare: 30_000,
  retained_host_start: 60_000,
  provider_live_validate: 15_000,
  retained_host_mcp_proof: 45_000,
  execution_submit: 15_000,
  execution_poll: 120_000,
  member_materialize: 120_000,
  result_commit: 5_000,
} as const

export type OpenCodeLaunchPhase = keyof typeof OPEN_CODE_LAUNCH_PHASE_CEILINGS_MS

export type OpenCodeLaunchPhaseBudget = {
  phase: OpenCodeLaunchPhase
  startedAtMs: number
  deadlineAtMs: number
  ceilingMs: number
  remainingMs: number
}

export type OpenCodeMemberMaterializationBudget = {
  startedAtMs: number
  deadlineAtMs: number
  remainingMemberBudgetMs: number
  membersRemaining: number
  memberBudgetMs: number
  memberDeadlineAtMs: number
}

type OpenCodeLaunchAttemptPolicyOptions = {
  requestedBudgetMs?: number | null
  monotonicNow?: () => number
  /** Original start when reconstructing a durable attempt. */
  startedAtMs?: number
  /** Existing outer monotonic envelope; never extended by this policy. */
  deadlineAtMs?: number
}

export class OpenCodeLaunchAttemptBudgetError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OpenCodeLaunchAttemptBudgetError'
  }
}

/**
 * Pure deadline arithmetic for one launch attempt. This class deliberately
 * owns no timers: callers enforce the returned absolute monotonic deadlines.
 */
export class OpenCodeLaunchAttemptPolicy {
  readonly totalBudgetMs: number
  readonly cleanupReserveMs: number
  readonly startedAtMs: number
  readonly absoluteDeadlineAtMs: number
  readonly workDeadlineAtMs: number
  /** Lifetime of retained publication authority; cleanup may use the reserved tail. */
  readonly retainedAuthorityDeadlineAtMs: number

  private readonly monotonicNow: () => number

  constructor(options: OpenCodeLaunchAttemptPolicyOptions = {}) {
    const requested = options.requestedBudgetMs ?? OPEN_CODE_LAUNCH_DEFAULT_BUDGET_MS
    if (!Number.isSafeInteger(requested) || requested <= 0) {
      throw new OpenCodeLaunchAttemptBudgetError(
        'OpenCode launch budget must be a positive safe integer',
      )
    }

    const totalBudgetMs = Math.min(requested, OPEN_CODE_LAUNCH_MAX_BUDGET_MS)
    if (totalBudgetMs < OPEN_CODE_LAUNCH_MIN_BUDGET_MS) {
      throw new OpenCodeLaunchAttemptBudgetError(
        `OpenCode launch budget must be at least ${OPEN_CODE_LAUNCH_MIN_BUDGET_MS}ms`,
      )
    }
    this.totalBudgetMs = totalBudgetMs

    this.monotonicNow = options.monotonicNow ?? (() => Math.ceil(performance.now()))
    const now = this.readNow()
    if (options.deadlineAtMs !== undefined) assertSafeTimestamp(options.deadlineAtMs, 'outer deadline')
    if (options.startedAtMs !== undefined) assertSafeTimestamp(options.startedAtMs, 'attempt start')
    this.startedAtMs = options.startedAtMs ?? (options.deadlineAtMs === undefined
      ? now : Math.max(0, options.deadlineAtMs - requested))
    const naturalDeadlineAtMs = checkedSafeAdd(
      this.startedAtMs,
      this.totalBudgetMs,
      'absolute deadline',
    )
    this.absoluteDeadlineAtMs = options.deadlineAtMs === undefined
      ? naturalDeadlineAtMs : Math.min(naturalDeadlineAtMs, options.deadlineAtMs)
    if (this.absoluteDeadlineAtMs < this.startedAtMs) {
      throw new OpenCodeLaunchAttemptBudgetError('outer deadline must not precede the attempt start')
    }
    const availableEnvelopeMs = this.absoluteDeadlineAtMs - this.startedAtMs
    this.cleanupReserveMs = Math.min(
      15_000,
      Math.max(1_000, Math.floor(this.totalBudgetMs * 0.10)),
      Math.floor(this.totalBudgetMs / 3),
      Math.floor(availableEnvelopeMs / 3),
    )
    this.workDeadlineAtMs = checkedSafeSubtract(
      this.absoluteDeadlineAtMs,
      this.cleanupReserveMs,
      'work deadline',
    )
    if (checkedSafeAdd(this.workDeadlineAtMs, this.cleanupReserveMs, 'cleanup reserve')
      !== this.absoluteDeadlineAtMs) {
      throw new OpenCodeLaunchAttemptBudgetError(
        'cleanup reserve must exactly partition the absolute deadline',
      )
    }
    this.retainedAuthorityDeadlineAtMs = this.absoluteDeadlineAtMs
  }

  remainingAttemptMs(nowMs = this.readNow()): number {
    return remainingUntil(this.absoluteDeadlineAtMs, nowMs)
  }

  remainingWorkMs(nowMs = this.readNow()): number {
    return remainingUntil(this.workDeadlineAtMs, nowMs)
  }

  remainingCleanupMs(nowMs = this.readNow()): number {
    assertSafeTimestamp(nowMs, 'cleanup timestamp')
    return remainingUntil(this.absoluteDeadlineAtMs, Math.max(nowMs, this.workDeadlineAtMs))
  }

  phaseBudget(phase: OpenCodeLaunchPhase, nowMs = this.readNow()): OpenCodeLaunchPhaseBudget {
    assertSafeTimestamp(nowMs, 'phase timestamp')
    const ceilingMs = OPEN_CODE_LAUNCH_PHASE_CEILINGS_MS[phase]
    const deadlineAtMs = cappedSafeDeadline(
      this.workDeadlineAtMs,
      nowMs,
      ceilingMs,
      'phase deadline',
    )
    return {
      phase,
      startedAtMs: nowMs,
      deadlineAtMs,
      ceilingMs,
      remainingMs: remainingUntil(deadlineAtMs, nowMs),
    }
  }

  memberMaterializationBudget(
    memberPhaseStartedAtMs: number,
    membersRemaining: number,
    nowMs = this.readNow(),
  ): OpenCodeMemberMaterializationBudget {
    assertSafeTimestamp(memberPhaseStartedAtMs, 'member materialization start timestamp')
    assertSafeTimestamp(nowMs, 'member materialization timestamp')
    if (!Number.isSafeInteger(membersRemaining) || membersRemaining <= 0) {
      throw new OpenCodeLaunchAttemptBudgetError('membersRemaining must be a positive integer')
    }

    const deadlineAtMs = cappedSafeDeadline(
      this.workDeadlineAtMs,
      memberPhaseStartedAtMs,
      OPEN_CODE_LAUNCH_PHASE_CEILINGS_MS.member_materialize,
      'member phase deadline',
    )
    const remainingMemberBudgetMs = remainingUntil(deadlineAtMs, nowMs)
    const memberBudgetMs = Math.min(
      45_000,
      Math.floor(remainingMemberBudgetMs / membersRemaining),
    )
    return {
      startedAtMs: memberPhaseStartedAtMs,
      deadlineAtMs,
      remainingMemberBudgetMs,
      membersRemaining,
      memberBudgetMs,
      memberDeadlineAtMs: cappedSafeDeadline(
        deadlineAtMs,
        nowMs,
        memberBudgetMs,
        'member deadline',
      ),
    }
  }

  private readNow(): number {
    const nowMs = this.monotonicNow()
    assertSafeTimestamp(nowMs, 'monotonic timestamp')
    return nowMs
  }
}

function remainingUntil(deadlineAtMs: number, nowMs: number): number {
  assertSafeTimestamp(deadlineAtMs, 'deadline timestamp')
  assertSafeTimestamp(nowMs, 'current timestamp')
  return deadlineAtMs <= nowMs
    ? 0
    : checkedSafeSubtract(deadlineAtMs, nowMs, 'remaining time')
}

function assertSafeTimestamp(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new OpenCodeLaunchAttemptBudgetError(
      `${label} must be a finite nonnegative safe integer`,
    )
  }
}

function checkedSafeAdd(left: number, right: number, label: string): number {
  assertSafeTimestamp(left, `${label} left operand`)
  assertSafeTimestamp(right, `${label} right operand`)
  const result = left + right
  assertSafeTimestamp(result, label)
  return result
}

function checkedSafeSubtract(left: number, right: number, label: string): number {
  assertSafeTimestamp(left, `${label} left operand`)
  assertSafeTimestamp(right, `${label} right operand`)
  if (right > left) {
    throw new OpenCodeLaunchAttemptBudgetError(`${label} must not be negative`)
  }
  const result = left - right
  assertSafeTimestamp(result, label)
  return result
}

function cappedSafeDeadline(
  upperDeadlineAtMs: number,
  startedAtMs: number,
  durationMs: number,
  label: string,
): number {
  assertSafeTimestamp(upperDeadlineAtMs, `${label} upper bound`)
  assertSafeTimestamp(startedAtMs, `${label} start`)
  assertSafeTimestamp(durationMs, `${label} duration`)
  if (startedAtMs >= upperDeadlineAtMs) return upperDeadlineAtMs
  const headroomMs = checkedSafeSubtract(upperDeadlineAtMs, startedAtMs, `${label} headroom`)
  return durationMs >= headroomMs
    ? upperDeadlineAtMs
    : checkedSafeAdd(startedAtMs, durationMs, label)
}

export class OpenCodeLaunchGenerationMismatchError extends Error {
  constructor(
    readonly expectedGeneration: number,
    readonly actualGeneration: number,
  ) {
    super(
      `OpenCode launch generation changed from ${expectedGeneration} to ${actualGeneration}`,
    )
    this.name = 'OpenCodeLaunchGenerationMismatchError'
  }
}

/** A token captured before an awaited mutation must be checked after it settles. */
export class OpenCodeLaunchGenerationFence {
  private currentGeneration = 0

  beginGeneration(): number {
    this.currentGeneration += 1
    return this.currentGeneration
  }

  invalidate(): number {
    this.currentGeneration += 1
    return this.currentGeneration
  }

  capture(): number {
    return this.currentGeneration
  }

  isCurrent(generation: number): boolean {
    return generation === this.currentGeneration
  }

  assertAfterAwaitedMutation(generation: number): void {
    if (!this.isCurrent(generation)) {
      throw new OpenCodeLaunchGenerationMismatchError(generation, this.currentGeneration)
    }
  }
}

export const OPEN_CODE_MEMBER_STATES = [
  'pending',
  'creating',
  'session_created',
  'mcp_ready',
  'bootstrap_injected',
  'committed',
  'failed',
  'cancelled',
  'cleanup_pending',
] as const

export type OpenCodeLaunchMemberState = typeof OPEN_CODE_MEMBER_STATES[number]

const OPEN_CODE_MEMBER_TRANSITIONS: Readonly<
  Record<OpenCodeLaunchMemberState, ReadonlySet<OpenCodeLaunchMemberState>>
> = {
  pending: new Set(['creating', 'failed', 'cancelled']),
  creating: new Set(['session_created', 'failed', 'cancelled', 'cleanup_pending']),
  session_created: new Set(['mcp_ready', 'failed', 'cancelled', 'cleanup_pending']),
  mcp_ready: new Set(['bootstrap_injected', 'failed', 'cancelled', 'cleanup_pending']),
  bootstrap_injected: new Set(['committed', 'failed', 'cancelled', 'cleanup_pending']),
  committed: new Set(),
  failed: new Set(['cleanup_pending']),
  cancelled: new Set(['cleanup_pending']),
  cleanup_pending: new Set(),
}

export class OpenCodeLaunchMemberTransitionError extends Error {
  constructor(
    readonly from: OpenCodeLaunchMemberState,
    readonly to: OpenCodeLaunchMemberState,
  ) {
    super(`Illegal OpenCode launch member transition: ${from} -> ${to}`)
    this.name = 'OpenCodeLaunchMemberTransitionError'
  }
}

export function canTransitionOpenCodeLaunchMember(
  from: OpenCodeLaunchMemberState,
  to: OpenCodeLaunchMemberState,
): boolean {
  return OPEN_CODE_MEMBER_TRANSITIONS[from].has(to)
}

export function transitionOpenCodeLaunchMember(
  from: OpenCodeLaunchMemberState,
  to: OpenCodeLaunchMemberState,
): OpenCodeLaunchMemberState {
  if (!canTransitionOpenCodeLaunchMember(from, to)) {
    throw new OpenCodeLaunchMemberTransitionError(from, to)
  }
  return to
}

// Compatibility exports: the vocabulary and the sole policy table live in
// OpenCodeFailurePolicy so provider and launch paths cannot drift.
export {
  OPEN_CODE_LAUNCH_FAILURE_KINDS,
  OPEN_CODE_LAUNCH_FAILURE_POLICY,
  OPEN_CODE_LAUNCH_RETRY_DISPOSITIONS,
  classifyOpenCodeLaunchFailure,
} from './OpenCodeFailurePolicy.js'
export type {
  OpenCodeLaunchFailure,
  OpenCodeLaunchFailureKind,
  OpenCodeLaunchFailurePolicy,
  OpenCodeLaunchRetryDisposition,
} from './OpenCodeFailurePolicy.js'
