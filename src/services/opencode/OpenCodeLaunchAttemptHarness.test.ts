import { describe, expect, test } from 'bun:test'

import {
  createDeterministicDeferred,
  FakeMonotonicClock,
  OpenCodeLaunchAttemptHarness,
  OpenCodeLaunchContractViolationError,
} from './OpenCodeLaunchAttemptHarness.test-support.js'

import { OPEN_CODE_MEMBER_STATES } from './OpenCodeLaunchAttemptPolicy.js'

import type {
  OpenCodeProofChallenge,
  OpenCodeProofObservation,
  RetainedOpenCodeHostIdentity,
} from './OpenCodeLaunchAttemptHarness.test-support.js'

const retainedHost: RetainedOpenCodeHostIdentity = {
  hostKey: 'opencode-host/profile-a/cache-a',
  pid: 43601,
  birthIdentity: 'pid-43601-born-991',
  providerScope: 'anthropic/subscription',
  profileScope: 'profile-a',
  cacheScope: 'cache-a',
}

const payloadHash = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

function createHarness(clock = new FakeMonotonicClock()) {
  return new OpenCodeLaunchAttemptHarness({
    clock,
    retainedHost,
    providerId: 'anthropic',
    modelId: 'claude-sonnet-4-5',
    requiredMcpTools: ['mcp__team__send_message', 'mcp__team__task_update'],
    totalBudgetMs: 10_000,
    attemptId: '123e4567-e89b-42d3-a456-426614174000',
    payloadHash,
    members: [
      { memberId: 'member-1', prompt: 'launch one' },
      { memberId: 'member-2', prompt: 'launch two' },
      { memberId: 'member-3', prompt: 'launch three' },
    ],
  })
}

function exactObservation(
  challenge: OpenCodeProofChallenge,
  overrides: Partial<OpenCodeProofObservation> = {},
): OpenCodeProofObservation {
  return {
    generation: challenge.generation,
    sessionId: challenge.sessionId,
    assistantMessageId: `assistant-${challenge.generation}`,
    parentMessageId: challenge.promptMessageId,
    nonce: challenge.nonce,
    providerId: challenge.providerId,
    modelId: challenge.modelId,
    host: challenge.host,
    mcpTools: ['mcp__team__send_message', 'mcp__team__task_update'],
    ...overrides,
  }
}

function prove(harness: OpenCodeLaunchAttemptHarness, nonce = `nonce-g${harness.generation}`) {
  const challenge = harness.beginProof(nonce)
  expect(challenge.ephemeral).toBe(true)
  expect(harness.observeProof(exactObservation(challenge))).toEqual({ accepted: true, reasons: [] })
  return challenge
}

function makeMemberCommittable(harness: OpenCodeLaunchAttemptHarness, memberId: string) {
  harness.markMemberMcpReady(memberId)
  harness.injectMemberBootstrap(memberId)
}

describe('OpenCodeLaunchAttemptHarness retained-host proof gate', () => {
  test('creates zero member sessions until exact proof and same-host MCP visibility are established', () => {
    const harness = createHarness()

    expect(() => harness.createNextMemberSession()).toThrow('Exact retained-host proof')
    expect(harness.memberSessionCount).toBe(0)

    const challenge = harness.beginProof('proof-nonce-436')
    expect(challenge).toMatchObject({
      ephemeral: true,
      generation: 1,
      nonce: 'proof-nonce-436',
      providerId: 'anthropic',
      modelId: 'claude-sonnet-4-5',
      host: retainedHost,
    })
    expect(harness.memberSessionCount).toBe(0)

    expect(harness.observeProof(exactObservation(challenge))).toEqual({ accepted: true, reasons: [] })
    expect(harness.journalOfType('proof.accepted')[0]).toMatchObject({
      sessionId: challenge.sessionId,
      assistantMessageId: 'assistant-1',
      mcpTools: ['mcp__team__send_message', 'mcp__team__task_update'],
    })

    expect(harness.createNextMemberSession()).toEqual({
      memberId: 'member-1',
      sessionId: 'member-member-1-g1-1',
      generation: 1,
    })
  })

  test.each([
    ['nonce', { nonce: 'wrong' }, 'wrong-nonce'],
    ['provider', { providerId: 'openai' }, 'wrong-provider'],
    ['model', { modelId: 'wrong-model' }, 'wrong-model'],
    ['parent', { parentMessageId: 'wrong-parent' }, 'wrong-parent'],
    ['host key', { host: { ...retainedHost, hostKey: 'other-host' } }, 'wrong-host'],
    ['host pid', { host: { ...retainedHost, pid: 43602 } }, 'wrong-host'],
    ['host birth', { host: { ...retainedHost, birthIdentity: 'reused-pid' } }, 'wrong-host'],
    ['host provider scope', { host: { ...retainedHost, providerScope: 'other/provider' } }, 'wrong-host'],
    ['host profile scope', { host: { ...retainedHost, profileScope: 'profile-b' } }, 'wrong-host'],
    ['host cache scope', { host: { ...retainedHost, cacheScope: 'cache-b' } }, 'wrong-host'],
    ['generation', { generation: 0 }, 'stale-generation'],
    ['MCP visibility', { mcpTools: ['mcp__team__send_message'] }, 'missing-mcp-tool'],
  ] as const)('rejects wrong %s proof without creating a member session', (_label, override, reason) => {
    const harness = createHarness()
    const challenge = harness.beginProof('exact-nonce')

    expect(harness.observeProof(exactObservation(challenge, override))).toEqual({
      accepted: false,
      reasons: [reason],
    })
    expect(() => harness.createNextMemberSession()).toThrow('Exact retained-host proof')
    expect(harness.memberSessionCount).toBe(0)
  })
})

describe('OpenCodeLaunchAttemptHarness deadline and generation fencing', () => {
  test('exposes separate work and absolute deadlines and fences each boundary', () => {
    const clock = new FakeMonotonicClock(100)
    const harness = createHarness(clock)
    prove(harness)
    const attempt = harness.createNextMemberSession()!

    expect(harness.cleanupReserveMs).toBe(1_000)
    expect(harness.workDeadlineMs).toBe(9_100)
    expect(harness.absoluteDeadlineMs).toBe(10_100)
    for (const value of [
      harness.totalBudgetMs,
      harness.cleanupReserveMs,
      harness.workDeadlineMs,
      harness.absoluteDeadlineMs,
    ]) {
      expect(Number.isSafeInteger(value)).toBe(true)
      expect(value).toBeGreaterThan(0)
    }
    clock.advanceTo(9_099)
    expect(harness.enforceDeadline()).toEqual([])
    clock.advanceTo(9_100)
    expect(harness.enforceDeadline()).toEqual(['member-1'])
    expect(harness.completeMember('member-1', attempt.generation)).toBe(false)
    expect(harness.createNextMemberSession()).toBeNull()
    harness.noteIgnoredTerm('member-1')
    clock.advanceTo(10_099)
    harness.finishCleanup('member-1', { force: true })

    expect(clock.now()).toBe(10_099)
    expect(harness.journalOfType('cleanup.signal').map(record => [record.signal, record.target])).toEqual([
      ['TERM', 'grandchild'],
      ['TERM', 'child'],
      ['KILL', 'grandchild'],
      ['KILL', 'child'],
    ])
    expect(harness.journal().filter(record => record.type === 'cleanup.grandchild' || record.type === 'cleanup.child').map(record => record.type)).toEqual([
      'cleanup.grandchild',
      'cleanup.child',
    ])
    expect(harness.memberStates()['member-1']).toBe('cleanup_pending')

    expect(harness.continuePending()).toEqual(['member-1', 'member-2', 'member-3'])
    expect(harness.completeMember('member-1', attempt.generation)).toBe(false)
    expect(harness.memberStates()['member-1']).toBe('pending')
    expect(harness.journalOfType('attempt.outcome').at(-1)).toMatchObject({
      generation: 1,
      memberId: 'member-1',
      outcome: 'stale-completion-ignored',
    })

    const absoluteClock = new FakeMonotonicClock(100)
    const absoluteHarness = createHarness(absoluteClock)
    prove(absoluteHarness)
    absoluteHarness.createNextMemberSession()
    absoluteClock.advanceTo(absoluteHarness.workDeadlineMs)
    absoluteHarness.enforceDeadline()
    absoluteClock.advanceTo(absoluteHarness.absoluteDeadlineMs)
    expect(() => absoluteHarness.finishCleanup('member-1', { force: true })).toThrow('Absolute attempt deadline')
    expect(absoluteHarness.memberStates()['member-1']).toBe('cleanup_pending')
    expect(absoluteHarness.journalOfType('cleanup.complete')).toHaveLength(0)
  })

  test('offers deferred phases without timers or wall-clock sleeps', async () => {
    const phase = createDeterministicDeferred<'proof-observed'>()
    expect(phase.settled).toBe(false)
    phase.resolve('proof-observed')
    expect(phase.settled).toBe(true)
    expect(await phase.promise).toBe('proof-observed')
  })
})

describe('OpenCodeLaunchAttemptHarness replay and continuation', () => {
  test('allows only one nonterminal materialization and fences it from a concurrent commit after stop', () => {
    const harness = createHarness()
    prove(harness, 'single-active-member')
    const first = harness.createNextMemberSession()!

    expect(harness.createNextMemberSession()).toBeNull()
    harness.markMemberMcpReady(first.memberId)
    expect(harness.createNextMemberSession()).toBeNull()
    harness.injectMemberBootstrap(first.memberId)
    expect(harness.createNextMemberSession()).toBeNull()

    expect(harness.failMember(first.memberId, 'stop-before-concurrent-commit')).toBe(true)
    expect(harness.completeMember(first.memberId, first.generation)).toBe(false)
    expect(harness.createNextMemberSession()).toBeNull()
    expect(harness.journalOfType('store.commit')).toHaveLength(0)
    expect(harness.memberStates()).toEqual({
      'member-1': 'cleanup_pending',
      'member-2': 'pending',
      'member-3': 'pending',
    })
  })

  test('rejects continuation unless this generation actually stopped and completed its cleanup', () => {
    const harness = createHarness()
    expect(() => harness.continuePending()).toThrow('without a failure or cancellation stop')

    prove(harness, 'successful-generation')
    for (const memberId of ['member-1', 'member-2', 'member-3']) {
      expect(harness.createNextMemberSession()!.memberId).toBe(memberId)
      makeMemberCommittable(harness, memberId)
      expect(harness.completeMember(memberId)).toBe(true)
    }
    expect(() => harness.continuePending()).toThrow('without a failure or cancellation stop')
    expect(harness.journalOfType('store.commit')).toHaveLength(3)

    const pendingOnly = createHarness()
    prove(pendingOnly, 'pending-only-generation')
    expect(() => pendingOnly.continuePending()).toThrow('without a failure or cancellation stop')
  })

  test('stops scheduling on member 2 failure and requires cleanup-complete, freshly-proven continuation', () => {
    const harness = createHarness()
    const firstProof = prove(harness, 'generation-one-nonce')

    expect(harness.createNextMemberSession()!.memberId).toBe('member-1')
    makeMemberCommittable(harness, 'member-1')
    expect(harness.completeMember('member-1')).toBe(true)
    expect(harness.createNextMemberSession()!.memberId).toBe('member-2')
    expect(harness.failMember('member-2', 'injected member 2 failure')).toBe(true)
    expect(harness.journalOfType('member.state.transition').slice(-2).map(record => [record.from, record.to])).toEqual([
      ['session_created', 'failed'],
      ['failed', 'cleanup_pending'],
    ])
    expect(harness.memberStates()).toEqual({
      'member-1': 'committed',
      'member-2': 'cleanup_pending',
      'member-3': 'pending',
    })
    expect(harness.createNextMemberSession()).toBeNull()
    expect(() => harness.continuePending()).toThrow('may still mutate state')
    harness.finishCleanup('member-2')

    expect(harness.memberStates()).toEqual({
      'member-1': 'committed',
      'member-2': 'cleanup_pending',
      'member-3': 'pending',
    })
    expect(harness.createNextMemberSession()).toBeNull()
    expect(harness.continuePending()).toEqual(['member-2', 'member-3'])
    expect(harness.generation).toBe(2)
    expect(harness.memberStates()['member-1']).toBe('committed')
    expect(harness.journalOfType('store.commit')).toHaveLength(1)

    expect(harness.observeProof(exactObservation(firstProof))).toEqual(expect.objectContaining({
      accepted: false,
      reasons: expect.arrayContaining(['stale-generation']),
    }))
    expect(() => harness.createNextMemberSession()).toThrow('Exact retained-host proof')
    expect(() => harness.beginProof(firstProof.nonce)).toThrow('Proof nonce must be fresh')
    const secondProof = prove(harness, 'fresh-generation-two-nonce')
    expect(secondProof.generation).toBe(2)
    expect(secondProof.nonce).not.toBe(firstProof.nonce)
    expect(harness.createNextMemberSession()!.memberId).toBe('member-2')
    makeMemberCommittable(harness, 'member-2')
    expect(harness.completeMember('member-2')).toBe(true)
    expect(harness.createNextMemberSession()!.memberId).toBe('member-3')
    expect(() => harness.continuePending()).toThrow('without a failure or cancellation stop')

    expect(harness.journalOfType('member.session.created').map(record => record.memberId)).toEqual([
      'member-1',
      'member-2',
      'member-2',
      'member-3',
    ])
    expect(harness.journalOfType('continuation.started')).toEqual([
      expect.objectContaining({ generation: 2, memberIds: ['member-2', 'member-3'] }),
    ])
  })

  test('also stops scheduling after cancellation until cleanup and a newly-proven continuation', () => {
    const harness = createHarness()
    prove(harness, 'before-cancel')
    harness.createNextMemberSession()
    harness.cancelMember('member-1')

    expect(harness.journalOfType('member.state.transition').slice(-2).map(record => [record.from, record.to])).toEqual([
      ['session_created', 'cancelled'],
      ['cancelled', 'cleanup_pending'],
    ])

    expect(harness.memberStates()['member-1']).toBe('cleanup_pending')
    expect(harness.createNextMemberSession()).toBeNull()
    harness.finishCleanup('member-1')
    expect(harness.createNextMemberSession()).toBeNull()
    expect(harness.continuePending()).toEqual(['member-1', 'member-2', 'member-3'])
    expect(() => harness.createNextMemberSession()).toThrow('Exact retained-host proof')
    prove(harness, 'after-cancel')
    expect(harness.createNextMemberSession()!.memberId).toBe('member-1')
  })

  test('uses attemptId as the idempotency key and rejects contract drift before side effects', () => {
    const harness = createHarness()
    prove(harness)
    harness.createNextMemberSession()
    makeMemberCommittable(harness, 'member-1')
    harness.completeMember('member-1')
    const sessionCount = harness.memberSessionCount

    expect(harness.beginAttempt('123e4567-e89b-42d3-a456-426614174000', payloadHash)).toEqual({
      generation: 1,
      memberStates: {
        'member-1': 'committed',
        'member-2': 'pending',
        'member-3': 'pending',
      },
    })
    expect(harness.memberSessionCount).toBe(sessionCount)
    expect(harness.journalOfType('store.commit')).toHaveLength(1)
    expect(harness.journalOfType('idempotency.replayed')).toEqual([
      expect.objectContaining({
        attemptId: '123e4567-e89b-42d3-a456-426614174000',
        payloadHash,
        generation: 1,
      }),
    ])

    const journalBeforeMismatch = harness.journal()
    let mismatch: unknown
    try {
      harness.beginAttempt('123e4567-e89b-42d3-a456-426614174000', 'f'.repeat(64))
    } catch (error) {
      mismatch = error
    }
    expect(mismatch).toBeInstanceOf(OpenCodeLaunchContractViolationError)
    expect(mismatch).toMatchObject({
      kind: 'contract_violation',
      retryDisposition: 'never',
      reason: 'payload_hash_mismatch',
    })
    expect(harness.journal()).toEqual(journalBeforeMismatch)
    expect(harness.memberSessionCount).toBe(sessionCount)
    expect(harness.journalOfType('store.commit')).toHaveLength(1)

    for (const [attemptId, candidateHash, reason] of [
      ['123e4567-e89b-42d3-a456-426614174001', payloadHash, 'attempt_id_mismatch'],
      ['123E4567-E89B-42D3-A456-426614174000', payloadHash, 'attempt_id_mismatch'],
      ['123e4567-e89b-42d3-a456-426614174000', 'A'.repeat(64), 'invalid_payload_hash'],
    ] as const) {
      expect(() => harness.beginAttempt(attemptId, candidateHash)).toThrow(OpenCodeLaunchContractViolationError)
      try {
        harness.beginAttempt(attemptId, candidateHash)
      } catch (error) {
        expect(error).toMatchObject({
          kind: 'contract_violation',
          retryDisposition: 'never',
          retryable: false,
          sideEffectsStarted: false,
          reason,
        })
      }
      expect(harness.journal()).toEqual(journalBeforeMismatch)
    }
  })

  test('uses canonical member states and transitions through the complete launch sequence', () => {
    const harness = createHarness()
    prove(harness, 'journal-nonce')
    harness.createNextMemberSession()
    makeMemberCommittable(harness, 'member-1')
    expect(harness.completeMember('member-1')).toBe(true)

    const transitions = harness.journalOfType('member.state.transition')
      .filter(record => record.memberId === 'member-1')
      .map(record => [record.from, record.to])
    expect(transitions).toEqual([
      ['pending', 'creating'],
      ['creating', 'session_created'],
      ['session_created', 'mcp_ready'],
      ['mcp_ready', 'bootstrap_injected'],
      ['bootstrap_injected', 'committed'],
    ])
    expect(OPEN_CODE_MEMBER_STATES).toContain(harness.memberStates()['member-1'])
    expect(harness.journalOfType('store.commit')).toEqual([
      expect.objectContaining({ memberId: 'member-1', sessionId: 'member-member-1-g1-1' }),
    ])
  })
})

describe('OpenCodeLaunchAttemptHarness numeric and contract validation', () => {
  test.each([0, -1, 10_000.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid total budget %p',
    totalBudgetMs => {
      expect(() => new OpenCodeLaunchAttemptHarness({
        clock: new FakeMonotonicClock(1),
        retainedHost,
        providerId: 'anthropic',
        modelId: 'claude-sonnet-4-5',
        requiredMcpTools: [],
        totalBudgetMs,
        attemptId: '123e4567-e89b-42d3-a456-426614174000',
        payloadHash,
        members: [],
      })).toThrow('positive finite safe integer')
    },
  )

  test.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid clock value %p',
    nowMs => expect(() => new FakeMonotonicClock(nowMs)).toThrow('positive finite safe integer'),
  )

  test('rejects unsafe deadline arithmetic and invalid clock advances', () => {
    expect(() => createHarness(new FakeMonotonicClock(Number.MAX_SAFE_INTEGER - 1))).toThrow(
      'absolute deadline',
    )
    const clock = new FakeMonotonicClock(10)
    expect(() => clock.advanceBy(0)).toThrow('positive finite safe integer')
    expect(() => clock.advanceBy(Number.MAX_SAFE_INTEGER)).toThrow('positive finite safe integer')
  })

  test.each([
    'a'.repeat(63),
    'a'.repeat(65),
    'A'.repeat(64),
    `sha256:${'a'.repeat(64)}`,
    'g'.repeat(64),
  ])('rejects non-canonical payload hash %p before creating the harness', invalidHash => {
    expect(() => new OpenCodeLaunchAttemptHarness({
      clock: new FakeMonotonicClock(1),
      retainedHost,
      providerId: 'anthropic',
      modelId: 'claude-sonnet-4-5',
      requiredMcpTools: [],
      totalBudgetMs: 10_000,
      attemptId: '123e4567-e89b-42d3-a456-426614174000',
      payloadHash: invalidHash,
      members: [],
    })).toThrow(OpenCodeLaunchContractViolationError)
  })

  test('rejects a noncanonical UUID spelling before harness side effects', () => {
    expect(() => new OpenCodeLaunchAttemptHarness({
      clock: new FakeMonotonicClock(1),
      retainedHost,
      providerId: 'anthropic',
      modelId: 'claude-sonnet-4-5',
      requiredMcpTools: [],
      totalBudgetMs: 10_000,
      attemptId: '123E4567-E89B-42D3-A456-426614174000',
      payloadHash,
      members: [],
    })).toThrow(OpenCodeLaunchContractViolationError)
  })
})
