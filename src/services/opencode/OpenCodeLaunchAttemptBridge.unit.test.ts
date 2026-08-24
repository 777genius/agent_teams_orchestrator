import { describe, expect, test } from 'bun:test'

import {
  getOpenCodeLaunchAttemptProductionPorts,
  computeOpenCodeLaunchCommandInputDigest,
  computeOpenCodeLaunchCommandImmutableDigest,
  computeOpenCodeLaunchRequestCorrelationDigest,
  installOpenCodeLaunchAttemptPortsForTests,
  OpenCodeLaunchAttemptBridge,
  resetOpenCodeLaunchAttemptProductionPortsForTests,
  type OpenCodeLaunchAttemptBridgeDependencies,
  type OpenCodeLaunchAttemptBridgePort,
} from './OpenCodeLaunchAttemptBridge.js'
import type { OpenCodeLaunchAttemptInput, OpenCodeLaunchAttemptResult } from './OpenCodeLaunchAttempt.js'
import type { OpenCodeLaunchAttemptRequest } from './OpenCodeBridgeContractV2.js'
import type { OpenCodeProvisioningSnapshot } from './types.js'

const opaque = (character: string) => `sha256:${character.repeat(64)}` as const
const request: OpenCodeLaunchAttemptRequest = {
  launchContractVersion: 1,
  launchAttempt: {
    attemptId: '018f47a2-4a13-7c2f-8d44-c0ffee123456',
    payloadHash: 'a'.repeat(64),
    generation: 1,
    proofNonce: 'n'.repeat(43),
    parent: { sessionIdentity: opaque('b'), messageIdentity: opaque('c') },
    providerId: 'openrouter',
    modelId: 'openrouter/model-s3',
    requiredMcpTools: ['agent-teams.message_send'],
    requireFreshRetainedHostProof: true,
  },
}
const result: OpenCodeLaunchAttemptResult = {
  attemptId: request.launchAttempt.attemptId, payloadHash: request.launchAttempt.payloadHash,
  generation: 1,
  inputDigest: 'b'.repeat(64), immutableDigest: 'c'.repeat(64),
  status: 'succeeded',
  committed: [{
    memberIdentity: opaque('d'),
    sessionIdentity: opaque('e'),
    bootstrapMessageIdentity: opaque('f'),
    commitIdentity: opaque('1'),
  }],
  failed: [],
  pending: [],
  cleanupPending: [],
  cleanup: 'complete',
  absoluteDeadlineAtMs: 43_000,
  workDeadlineAtMs: 38_000,
}
const snapshot = null as unknown as OpenCodeProvisioningSnapshot

function command(): Parameters<OpenCodeLaunchAttemptBridgePort['execute']>[0] {
  return {
    request,
    members: [{ name: 'alice', memberIdentity: opaque('d') }],
    runId: 'run-s3',
    laneId: 'primary',
    teamId: 'team-s3',
    projectPath: '/fake/project',
    selectedModel: 'openrouter/model-s3',
    toolApprovalMode: 'auto',
    continuation: false,
    requestedBudgetMs: 42_000,
    preconditions: {
      handshakeIdentityHash: '1'.repeat(64), laneId: 'primary', expectedRunId: 'run-s3',
      expectedCapabilitySnapshotId: null, expectedBehaviorFingerprint: '2'.repeat(64),
      expectedManifestHighWatermark: null, commandLeaseId: 'lease-1',
      idempotencyKey: request.launchAttempt.attemptId,
    },
  }
}

describe('OpenCodeLaunchAttemptBridge', () => {
  test('installs production handler ports once and rejects replacement', () => {
    resetOpenCodeLaunchAttemptProductionPortsForTests()
    const bridge = new OpenCodeLaunchAttemptBridge({
      commandLedger: { read: async () => ({ status: 'absent' }) },
      attempt: { run: async () => result },
      projection: { fromDurableResult: async () => ({ snapshot, data: null }) },
    })
    const ports = { launchAttempt: bridge }

    installOpenCodeLaunchAttemptPortsForTests(ports)

    expect(getOpenCodeLaunchAttemptProductionPorts()).toBe(ports)
    expect(() => installOpenCodeLaunchAttemptPortsForTests({ launchAttempt: bridge }))
      .toThrow('already installed')
    resetOpenCodeLaunchAttemptProductionPortsForTests()
  })

  test('reads the command ledger first and maps the exact member identities into the core', async () => {
    const order: string[] = []
    let coreInput: unknown
    let projected: unknown
    const dependencies: OpenCodeLaunchAttemptBridgeDependencies = {
      commandLedger: {
        read: async identity => {
          order.push('ledger')
          expect(identity).toEqual({
            attemptId: request.launchAttempt.attemptId,
            payloadHash: request.launchAttempt.payloadHash,
            generation: 1,
            inputDigest: computeOpenCodeLaunchCommandInputDigest(command()),
          })
          return { status: 'absent' }
        },
      },
      attempt: {
        run: async input => {
          order.push('core')
          coreInput = input
          return result
        },
      },
      projection: {
        fromDurableResult: async input => {
          order.push('projection')
          projected = input
          return { snapshot, data: { status: input.result.status } }
        },
      },
    }

    const output = await new OpenCodeLaunchAttemptBridge(dependencies).execute(command())

    expect(order).toEqual(['ledger', 'core', 'projection'])
    expect(coreInput).toMatchObject({
      request,
      members: [opaque('d')],
      requestedBudgetMs: 42_000,
      continuation: false,
    })
    expect(projected).toMatchObject({ result })
    expect(output.data).toEqual({ status: 'succeeded' })
  })

  test('recomputes all command mutations locally and passes only the consumed outer budget', async () => {
    const baseline = command()
    const changed = command()
    changed.members = [{ ...changed.members[0]!, prompt: 'altered continuation plan' }]
    expect(computeOpenCodeLaunchCommandInputDigest(changed))
      .not.toBe(computeOpenCodeLaunchCommandInputDigest(baseline))

    let coreInput: OpenCodeLaunchAttemptInput | undefined
    baseline.outerRemainingBudgetMs = 12_345
    await new OpenCodeLaunchAttemptBridge({
      commandLedger: { read: async () => ({ status: 'absent' }) },
      attempt: { run: async input => { coreInput = input; return result } },
      projection: { fromDurableResult: async () => ({ snapshot, data: null }) },
    }).execute(baseline)
    expect(coreInput?.requestedBudgetMs).toBe(12_345)
    expect(coreInput?.signal).toBe(baseline.signal)
    expect(coreInput?.commandInputDigest).toBe(computeOpenCodeLaunchCommandInputDigest(baseline))
  })

  test('rejects request-correlation mismatch before ledger, core, or projection', async () => {
    const candidate = command()
    candidate.request = structuredClone(candidate.request)
    candidate.request.launchAttempt.requestCorrelationDigest =
      computeOpenCodeLaunchRequestCorrelationDigest(candidate)
    candidate.members = [{ ...candidate.members[0]!, prompt: 'mutated after caller digest' }]
    const calls: string[] = []
    const bridge = new OpenCodeLaunchAttemptBridge({
      commandLedger: { read: async () => { calls.push('ledger'); return { status: 'absent' } } },
      attempt: { run: async () => { calls.push('core'); return result } },
      projection: { fromDurableResult: async () => {
        calls.push('projection'); return { snapshot, data: null }
      } },
    })

    await expect(bridge.execute(candidate)).rejects.toThrow('request correlation digest mismatch')
    expect(calls).toEqual([])
  })

  test('binds the proof nonce only into the exact-generation input authority', () => {
    const baseline = command()
    const changed = command()
    changed.request = structuredClone(changed.request)
    changed.request.launchAttempt.proofNonce = `${'m'.repeat(42)}o`
    expect(computeOpenCodeLaunchCommandInputDigest(changed))
      .not.toBe(computeOpenCodeLaunchCommandInputDigest(baseline))
    expect(computeOpenCodeLaunchCommandImmutableDigest(changed))
      .toBe(computeOpenCodeLaunchCommandImmutableDigest(baseline))
  })

  test.each(['handshakeIdentityHash', 'expectedBehaviorFingerprint', 'commandLeaseId', 'idempotencyKey'] as const)(
    'binds and authoritatively validates strict %s', async field => {
      const baseline = command()
      const changed = command()
      changed.preconditions = { ...changed.preconditions, [field]: `${field}-changed` }
      expect(computeOpenCodeLaunchCommandInputDigest(changed))
        .not.toBe(computeOpenCodeLaunchCommandInputDigest(baseline))
      if (field === 'expectedBehaviorFingerprint' || field === 'idempotencyKey') {
        expect(computeOpenCodeLaunchCommandImmutableDigest(changed))
          .not.toBe(computeOpenCodeLaunchCommandImmutableDigest(baseline))
      } else {
        expect(computeOpenCodeLaunchCommandImmutableDigest(changed))
          .toBe(computeOpenCodeLaunchCommandImmutableDigest(baseline))
      }
      const invalid = command()
      invalid.preconditions = { ...invalid.preconditions,
        [field]: field === 'idempotencyKey' ? 'wrong-attempt' : null } as typeof invalid.preconditions
      let calls = 0
      await expect(new OpenCodeLaunchAttemptBridge({
        commandLedger: { read: async () => { calls += 1; return { status: 'absent' } } },
        attempt: { run: async () => { calls += 1; return result } },
        projection: { fromDurableResult: async () => ({ snapshot, data: null }) },
      }).execute(invalid)).rejects.toThrow()
      expect(calls).toBe(0)
    },
  )

  test('passes an absolute deadline unchanged while preserving the original policy budget', async () => {
    const value = { ...command(), requestedBudgetMs: 42_000, outerRemainingBudgetMs: 8_000,
      deadlineAtMs: 50_000 }
    let coreInput: OpenCodeLaunchAttemptInput | undefined
    await new OpenCodeLaunchAttemptBridge({
      commandLedger: { read: async () => ({ status: 'absent' }) },
      attempt: { run: async input => { coreInput = input; return result } },
      projection: { fromDurableResult: async () => ({ snapshot, data: null }) },
    }).execute(value)
    expect(coreInput?.deadlineAtMs).toBe(50_000)
    expect(coreInput?.requestedBudgetMs).toBe(42_000)
  })

  test('keeps only generation metadata mutable across continuation and rejects altered plans', () => {
    const first = command()
    const continuation = command()
    continuation.request = structuredClone(continuation.request)
    continuation.request.launchAttempt.generation = 2
    continuation.request.launchAttempt.continuationToken = 'continuation-two'
    continuation.continuation = true
    expect(computeOpenCodeLaunchCommandInputDigest(continuation))
      .not.toBe(computeOpenCodeLaunchCommandInputDigest(first))
    expect(computeOpenCodeLaunchCommandImmutableDigest(continuation))
      .toBe(computeOpenCodeLaunchCommandImmutableDigest(first))

    continuation.members = [{ ...continuation.members[0]!, effort: 'high' }]
    expect(computeOpenCodeLaunchCommandImmutableDigest(continuation))
      .not.toBe(computeOpenCodeLaunchCommandImmutableDigest(first))

    const plannedFirst = { ...command(), effectiveProfilePlanDigest: '1'.repeat(64) }
    const plannedContinuation = { ...continuation, members: first.members,
      effectiveProfilePlanDigest: '2'.repeat(64) }
    expect(computeOpenCodeLaunchCommandImmutableDigest(plannedContinuation))
      .not.toBe(computeOpenCodeLaunchCommandImmutableDigest(plannedFirst))
  })

  test('rejects tokenless continuation and initial token before ledger or effects', async () => {
    let calls = 0
    const bridge = new OpenCodeLaunchAttemptBridge({
      commandLedger: { read: async () => { calls += 1; return { status: 'absent' } } },
      attempt: { run: async () => { calls += 1; return result } },
      projection: { fromDurableResult: async () => { calls += 1; return { snapshot, data: null } } },
    })
    const tokenless = command(); tokenless.request = structuredClone(tokenless.request)
    tokenless.request.launchAttempt.generation = 2; tokenless.continuation = true
    await expect(bridge.execute(tokenless)).rejects.toMatchObject({
      field: 'launchAttempt.continuationToken',
    })
    const initialToken = command(); initialToken.request = structuredClone(initialToken.request)
    initialToken.request.launchAttempt.continuationToken = 'forged'
    await expect(bridge.execute(initialToken)).rejects.toMatchObject({
      field: 'launchAttempt.continuationToken',
    })
    expect(calls).toBe(0)
  })

  for (const status of ['unknown', 'completed'] as const) {
    test(`replays ${status} durable command evidence without starting the core`, async () => {
      let coreCalls = 0
      let projectionCalls = 0
      const bridge = new OpenCodeLaunchAttemptBridge({
        commandLedger: {
          read: async () => ({ status, snapshot, data: { durable: status } }),
        },
        attempt: {
          run: async () => { coreCalls += 1; return result },
        },
        projection: {
          fromDurableResult: async () => {
            projectionCalls += 1
            return { snapshot, data: null }
          },
        },
      })

      const output = await bridge.execute(command())

      expect(output.data).toEqual({ durable: status })
      expect(coreCalls).toBe(0)
      expect(projectionCalls).toBe(0)
    })
  }
})
