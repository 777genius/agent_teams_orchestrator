import { describe, expect, test } from 'bun:test'

import {
  OPEN_CODE_LAUNCH_PHASE_CEILINGS_MS,
  OPEN_CODE_MEMBER_STATES,
  OpenCodeLaunchAttemptBudgetError,
  OpenCodeLaunchAttemptPolicy,
  OPEN_CODE_LAUNCH_FAILURE_POLICY,
  OpenCodeLaunchGenerationFence,
  OpenCodeLaunchGenerationMismatchError,
  OpenCodeLaunchMemberTransitionError,
  canTransitionOpenCodeLaunchMember,
  classifyOpenCodeLaunchFailure,
  transitionOpenCodeLaunchMember,
} from './OpenCodeLaunchAttemptPolicy.js'

import type {
  OpenCodeLaunchFailureKind,
  OpenCodeLaunchFailurePolicy,
  OpenCodeLaunchMemberState,
  OpenCodeLaunchRetryDisposition,
} from './OpenCodeLaunchAttemptPolicy.js'

describe('OpenCodeLaunchAttemptPolicy', () => {
  test('caps one absolute budget and reserves cleanup from its absolute deadline', () => {
    let now = 12_345
    const policy = new OpenCodeLaunchAttemptPolicy({
      requestedBudgetMs: 900_000,
      monotonicNow: () => now,
    })

    expect(policy).toMatchObject({
      totalBudgetMs: 300_000,
      cleanupReserveMs: 15_000,
      startedAtMs: 12_345,
      absoluteDeadlineAtMs: 312_345,
      workDeadlineAtMs: 297_345,
    })
    now = 100_000
    expect(policy.remainingAttemptMs()).toBe(212_345)
    expect(policy.remainingWorkMs()).toBe(197_345)
  })

  test('caps valid integer budgets and rejects invalid budgets before side effects', () => {
    expect(new OpenCodeLaunchAttemptPolicy({ monotonicNow: () => 0 }).totalBudgetMs).toBe(300_000)
    let monotonicReads = 0
    const monotonicNow = () => {
      monotonicReads += 1
      return 0
    }
    for (const requestedBudgetMs of [
      Number.NEGATIVE_INFINITY,
      -1,
      0,
      9_999,
      9_999.999,
      10_000.5,
      Number.POSITIVE_INFINITY,
      Number.NaN,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(() => new OpenCodeLaunchAttemptPolicy({ requestedBudgetMs, monotonicNow })).toThrow(
        OpenCodeLaunchAttemptBudgetError,
      )
    }
    expect(monotonicReads).toBe(0)

    const boundary = new OpenCodeLaunchAttemptPolicy({
      requestedBudgetMs: 10_000,
      monotonicNow: () => 7,
    })
    expect(boundary.totalBudgetMs).toBe(10_000)
    expect(boundary.workDeadlineAtMs).toBe(9_007)

    const minimum = new OpenCodeLaunchAttemptPolicy({
      requestedBudgetMs: 10_001,
      monotonicNow: () => 7,
    })
    expect(minimum.totalBudgetMs).toBe(10_001)
    expect(minimum.cleanupReserveMs).toBe(1_000)
    expect(minimum.workDeadlineAtMs).toBe(9_008)

    const rounded = new OpenCodeLaunchAttemptPolicy({
      requestedBudgetMs: 12_349,
      monotonicNow: () => 0,
    })
    expect(rounded.cleanupReserveMs).toBe(1_234)
  })

  test('accepts only nonnegative safe-integer clocks and preserves exact arithmetic at the safe boundary', () => {
    const latestSafeStart = Number.MAX_SAFE_INTEGER - 300_000
    const policy = new OpenCodeLaunchAttemptPolicy({
      monotonicNow: () => latestSafeStart,
    })

    expect(policy.absoluteDeadlineAtMs).toBe(Number.MAX_SAFE_INTEGER)
    expect(policy.workDeadlineAtMs + policy.cleanupReserveMs).toBe(policy.absoluteDeadlineAtMs)
    expect(policy.absoluteDeadlineAtMs - policy.workDeadlineAtMs).toBe(policy.cleanupReserveMs)
    expect(policy.remainingAttemptMs(Number.MAX_SAFE_INTEGER)).toBe(0)

    for (const invalidNow of [
      -1,
      0.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(() => new OpenCodeLaunchAttemptPolicy({ monotonicNow: () => invalidNow }))
        .toThrow(OpenCodeLaunchAttemptBudgetError)
    }
    expect(() => new OpenCodeLaunchAttemptPolicy({
      monotonicNow: () => latestSafeStart + 1,
    })).toThrow('absolute deadline')
  })

  test('checks every timestamp addition and subtraction used by phase and member budgets', () => {
    const policy = new OpenCodeLaunchAttemptPolicy({ monotonicNow: () => 0 })
    const invalidTimes = [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]

    for (const invalidTime of invalidTimes) {
      expect(() => policy.remainingAttemptMs(invalidTime)).toThrow(OpenCodeLaunchAttemptBudgetError)
      expect(() => policy.remainingWorkMs(invalidTime)).toThrow(OpenCodeLaunchAttemptBudgetError)
      expect(() => policy.remainingCleanupMs(invalidTime)).toThrow(OpenCodeLaunchAttemptBudgetError)
      expect(() => policy.phaseBudget('result_commit', invalidTime)).toThrow(OpenCodeLaunchAttemptBudgetError)
      expect(() => policy.memberMaterializationBudget(invalidTime, 1, 0))
        .toThrow(OpenCodeLaunchAttemptBudgetError)
    }
    expect(policy.phaseBudget('result_commit', Number.MAX_SAFE_INTEGER).remainingMs).toBe(0)
    expect(policy.memberMaterializationBudget(Number.MAX_SAFE_INTEGER, 1, Number.MAX_SAFE_INTEGER))
      .toMatchObject({ remainingMemberBudgetMs: 0, memberBudgetMs: 0 })
    expect(() => policy.memberMaterializationBudget(0, Number.MAX_SAFE_INTEGER + 1, 0))
      .toThrow('membersRemaining')
  })

  test('applies every phase ceiling without extending the one work deadline', () => {
    const policy = new OpenCodeLaunchAttemptPolicy({ monotonicNow: () => 1_000 })

    for (const [phase, ceilingMs] of Object.entries(OPEN_CODE_LAUNCH_PHASE_CEILINGS_MS)) {
      expect(policy.phaseBudget(phase as keyof typeof OPEN_CODE_LAUNCH_PHASE_CEILINGS_MS, 2_000))
        .toEqual({
          phase: phase as keyof typeof OPEN_CODE_LAUNCH_PHASE_CEILINGS_MS,
          startedAtMs: 2_000,
          deadlineAtMs: 2_000 + ceilingMs,
          ceilingMs,
          remainingMs: ceilingMs,
        })
    }

    expect(policy.phaseBudget('execution_poll', policy.workDeadlineAtMs - 3_001)).toMatchObject({
      deadlineAtMs: policy.workDeadlineAtMs,
      remainingMs: 3_001,
    })
  })

  test('fails closed to zero for exhausted work, attempt, phase, and member budgets', () => {
    const policy = new OpenCodeLaunchAttemptPolicy({
      requestedBudgetMs: 10_000,
      monotonicNow: () => 500,
    })

    expect(policy.remainingWorkMs(policy.workDeadlineAtMs)).toBe(0)
    expect(policy.remainingAttemptMs(policy.absoluteDeadlineAtMs + 1)).toBe(0)
    expect(policy.phaseBudget('result_commit', policy.workDeadlineAtMs + 1).remainingMs).toBe(0)
    expect(policy.memberMaterializationBudget(500, 2, policy.workDeadlineAtMs + 1))
      .toMatchObject({ remainingMemberBudgetMs: 0, memberBudgetMs: 0 })
  })

  test('shares the remaining 120-second member phase budget with integer rounding', () => {
    const policy = new OpenCodeLaunchAttemptPolicy({ monotonicNow: () => 0 })

    expect(policy.memberMaterializationBudget(10_000, 2, 10_000)).toMatchObject({
      deadlineAtMs: 130_000,
      remainingMemberBudgetMs: 120_000,
      memberBudgetMs: 45_000,
      memberDeadlineAtMs: 55_000,
    })
    expect(policy.memberMaterializationBudget(10_000, 3, 30_001)).toMatchObject({
      remainingMemberBudgetMs: 99_999,
      memberBudgetMs: 33_333,
      memberDeadlineAtMs: 63_334,
    })
    expect(() => policy.memberMaterializationBudget(0, 0, 0)).toThrow(
      'membersRemaining must be a positive integer',
    )
  })
})

describe('OpenCode launch generation fencing', () => {
  test('accepts the current generation and rejects a post-await stale mutation', () => {
    const fence = new OpenCodeLaunchGenerationFence()
    const generation = fence.beginGeneration()
    expect(fence.capture()).toBe(generation)
    expect(fence.isCurrent(generation)).toBe(true)
    expect(() => fence.assertAfterAwaitedMutation(generation)).not.toThrow()

    fence.invalidate()
    expect(fence.isCurrent(generation)).toBe(false)
    expect(() => fence.assertAfterAwaitedMutation(generation)).toThrow(
      OpenCodeLaunchGenerationMismatchError,
    )
    expect(() => fence.assertAfterAwaitedMutation(generation)).toThrow(
      'OpenCode launch generation changed from 1 to 2',
    )
  })
})

describe('OpenCode launch member state machine', () => {
  const allowed: Record<OpenCodeLaunchMemberState, readonly OpenCodeLaunchMemberState[]> = {
    pending: ['creating', 'failed', 'cancelled'],
    creating: ['session_created', 'failed', 'cancelled', 'cleanup_pending'],
    session_created: ['mcp_ready', 'failed', 'cancelled', 'cleanup_pending'],
    mcp_ready: ['bootstrap_injected', 'failed', 'cancelled', 'cleanup_pending'],
    bootstrap_injected: ['committed', 'failed', 'cancelled', 'cleanup_pending'],
    committed: [],
    failed: ['cleanup_pending'],
    cancelled: ['cleanup_pending'],
    cleanup_pending: [],
  }

  test('covers the complete transition matrix and fails every illegal edge closed', () => {
    for (const from of OPEN_CODE_MEMBER_STATES) {
      for (const to of OPEN_CODE_MEMBER_STATES) {
        const shouldAllow = allowed[from].includes(to)
        expect(canTransitionOpenCodeLaunchMember(from, to)).toBe(shouldAllow)
        if (shouldAllow) {
          expect(transitionOpenCodeLaunchMember(from, to)).toBe(to)
        } else {
          expect(() => transitionOpenCodeLaunchMember(from, to)).toThrow(
            OpenCodeLaunchMemberTransitionError,
          )
        }
      }
    }
  })

  test('requires each successful materialization state in order', () => {
    const path: OpenCodeLaunchMemberState[] = [
      'pending',
      'creating',
      'session_created',
      'mcp_ready',
      'bootstrap_injected',
      'committed',
    ]
    for (let index = 1; index < path.length; index += 1) {
      expect(transitionOpenCodeLaunchMember(path[index - 1]!, path[index]!)).toBe(path[index])
    }
  })
})

describe('OpenCode launch failure retry disposition', () => {
  test('maps every typed failure exactly and preserves partial progress as continuation', () => {
    const expected = {
      pre_side_effect_transport: { retryDisposition: 'automatic', retryable: true, sideEffectsStarted: false },
      rate_limited: { retryDisposition: 'backoff', retryable: true, sideEffectsStarted: false },
      quota_exhausted: { retryDisposition: 'backoff', retryable: true, sideEffectsStarted: false },
      provider_plan_denied: { retryDisposition: 'external_change', retryable: true, sideEffectsStarted: false },
      authentication_required: { retryDisposition: 'user_action', retryable: true, sideEffectsStarted: false },
      external_dependency: { retryDisposition: 'external_change', retryable: true, sideEffectsStarted: false },
      contract_violation: { retryDisposition: 'never', retryable: false, sideEffectsStarted: false },
      candidate_budget_exhausted: { retryDisposition: 'backoff', retryable: true, sideEffectsStarted: false },
      attempt_budget_exhausted: { retryDisposition: 'never', retryable: false, sideEffectsStarted: false },
      deadline_before_partial: { retryDisposition: 'backoff', retryable: true, sideEffectsStarted: false },
      deadline_after_partial: { retryDisposition: 'continuation', retryable: true, sideEffectsStarted: true },
      unknown_transport_after_side_effect: { retryDisposition: 'never', retryable: false, sideEffectsStarted: true },
      cancelled: { retryDisposition: 'never', retryable: false, sideEffectsStarted: false },
    } as const satisfies Record<OpenCodeLaunchFailureKind, OpenCodeLaunchFailurePolicy>

    expect(OPEN_CODE_LAUNCH_FAILURE_POLICY).toEqual(expected)
    expect(Object.isFrozen(OPEN_CODE_LAUNCH_FAILURE_POLICY)).toBe(true)
    for (const [kind, policy] of Object.entries(expected)) {
      expect(Object.isFrozen(OPEN_CODE_LAUNCH_FAILURE_POLICY[kind as OpenCodeLaunchFailureKind])).toBe(true)
      const classified = classifyOpenCodeLaunchFailure(kind as OpenCodeLaunchFailureKind)
      expect(classified.kind).toBe(kind as OpenCodeLaunchFailureKind)
      expect(classified.retryDisposition).toBe(policy.retryDisposition)
      expect(classified.retryable).toBe(policy.retryable)
      expect(classified.sideEffectsStarted).toBe(policy.sideEffectsStarted)
    }
    const automaticKinds = (Object.keys(expected) as OpenCodeLaunchFailureKind[]).filter(
      kind => classifyOpenCodeLaunchFailure(kind).retryDisposition === 'automatic',
    )
    expect(automaticKinds).toEqual(['pre_side_effect_transport'])
    for (const kind of Object.keys(expected) as OpenCodeLaunchFailureKind[]) {
      expect(classifyOpenCodeLaunchFailure(kind).retryDisposition === 'automatic').toBe(
        kind === 'pre_side_effect_transport',
      )
    }
  })
})
