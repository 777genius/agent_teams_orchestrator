import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createOpenCodeLaunchAttemptProductionBridge } from './OpenCodeLaunchAttemptProductionComposition.js'
import {
  computeOpenCodeLaunchCommandInputDigest,
  computeOpenCodeLaunchRequestCorrelationDigest,
  type OpenCodeLaunchAttemptBridgePort,
} from './OpenCodeLaunchAttemptBridge.js'
import type { OpenCodeLaunchAttemptResult } from './OpenCodeLaunchAttempt.js'
import { OpenCodeLaunchMutationLedger } from './OpenCodeLaunchMutationLedger.js'
import type { OpenCodeProvisioningSnapshot } from './types.js'

const identity = (character: string) => `sha256:${character.repeat(64)}` as const
const snapshot = { detected: false } as OpenCodeProvisioningSnapshot
const result: OpenCodeLaunchAttemptResult = {
  attemptId: '018f47a2-4a13-7c2f-8d44-c0ffee123456', payloadHash: 'a'.repeat(64),
  generation: 1,
  inputDigest: 'b'.repeat(64), immutableDigest: 'c'.repeat(64),
  status: 'succeeded',
  committed: [],
  failed: [],
  pending: [],
  cleanupPending: [],
  cleanup: 'complete',
  absoluteDeadlineAtMs: 10_000,
  workDeadlineAtMs: 9_000,
}
let projectPath = ''
beforeAll(async () => { projectPath = await mkdtemp(path.join(os.tmpdir(), 'opencode-composition-')) })
afterAll(async () => { await rm(projectPath, { recursive: true, force: true }) })

function command(): Parameters<OpenCodeLaunchAttemptBridgePort['execute']>[0] {
  return {
    request: {
      launchContractVersion: 1,
      launchAttempt: {
        attemptId: '018f47a2-4a13-7c2f-8d44-c0ffee123456',
        payloadHash: 'a'.repeat(64),
        generation: 1,
        proofNonce: 'n'.repeat(43),
        parent: { sessionIdentity: identity('b'), messageIdentity: identity('c') },
        providerId: 'openrouter',
        modelId: 'openrouter/model',
        requiredMcpTools: ['agent-teams.message_send'],
        requireFreshRetainedHostProof: true,
      },
    },
    members: [{ name: 'alice', memberIdentity: identity('d') }],
    runId: 'run', laneId: 'primary', teamId: 'team', projectPath,
    selectedModel: 'openrouter/model', toolApprovalMode: 'auto', continuation: false,
    requestedBudgetMs: 10_000,
    preconditions: {
      handshakeIdentityHash: '1'.repeat(64), laneId: 'primary', expectedRunId: 'run',
      expectedCapabilitySnapshotId: null, expectedBehaviorFingerprint: '2'.repeat(64),
      expectedManifestHighWatermark: null, commandLeaseId: 'lease-1',
      idempotencyKey: '018f47a2-4a13-7c2f-8d44-c0ffee123456',
    },
  }
}

describe('OpenCode production launch composition', () => {
  for (const status of ['succeeded', 'reconciliation_required'] as const) {
    test(`durable ${status} gate runs before every profile, host, and member effect`, async () => {
      const calls: string[] = []
      const output = { snapshot, data: { launchAttempt: { status }, durable: true } }
      const bridge = createOpenCodeLaunchAttemptProductionBridge({
        authorize: async value => { calls.push('plan'); return value },
        inspect: async () => { calls.push('command-ledger'); return output },
        executeAfterPreflight: async () => {
          calls.push('profile', 'host', 'member')
          return { output: { snapshot, data: null }, result }
        },
      })

      await expect(bridge.execute(command())).resolves.toEqual(output)
      expect(calls).toEqual(['plan', 'command-ledger'])
    })
  }

  test('durable mismatch fails closed before launch effects', async () => {
    const calls: string[] = []
    const bridge = createOpenCodeLaunchAttemptProductionBridge({
      authorize: async value => { calls.push('plan'); return value },
      inspect: async () => { calls.push('command-ledger'); throw new Error('immutable plan mismatch') },
      executeAfterPreflight: async () => {
        calls.push('profile', 'host', 'member')
        return { output: { snapshot, data: null }, result }
      },
    })

    await expect(bridge.execute(command())).rejects.toThrow('immutable plan mismatch')
    expect(calls).toEqual(['plan', 'command-ledger'])
  })

  test('completed and unknown replay compare the exact generation input key', async () => {
    for (const status of ['succeeded', 'reconciliation_required'] as const) {
      let durableKey: { attemptId: string; payloadHash: string; generation: number; inputDigest: string } | undefined
      let effects = 0
      const output = { snapshot, data: { launchAttempt: { outcome: status } } }
      const bridge = createOpenCodeLaunchAttemptProductionBridge({
        authorize: async value => value,
        inspect: async (_value, key) => {
          durableKey ??= { ...key }
          if (JSON.stringify(key) !== JSON.stringify(durableKey)) throw new Error('exact replay mismatch')
          return output
        },
        executeAfterPreflight: async () => { effects += 1; return { output, result } },
      })
      await bridge.execute(command())
      const changedGeneration = command()
      changedGeneration.request.launchAttempt.generation = 2
      changedGeneration.request.launchAttempt.continuationToken = 'changed-token'
      changedGeneration.continuation = true
      await expect(bridge.execute(changedGeneration)).rejects.toThrow('exact replay mismatch')
      const changedMode = command(); changedMode.continuation = true
      await expect(bridge.execute(changedMode)).rejects.toThrow()
      const changedToken = command(); changedToken.request.launchAttempt.continuationToken = 'changed-token'
      await expect(bridge.execute(changedToken)).rejects.toThrow()
      expect(effects).toBe(0)
    }
  })

  test('absent ledger is the only path to the accepted core and durable projection', async () => {
    const calls: string[] = []
    const output = { snapshot, data: { launchAttempt: result } }
    const bridge = createOpenCodeLaunchAttemptProductionBridge({
      authorize: async value => { calls.push('plan'); return value },
      inspect: async () => { calls.push('command-ledger'); return null },
      executeAfterPreflight: async () => {
        calls.push('core')
        return { output, result }
      },
    })

    await expect(bridge.execute(command())).resolves.toBe(output)
    expect(calls).toEqual(['plan', 'command-ledger', 'core'])
  })

  test('a hanging authorization is bounded by the one outer absolute deadline', async () => {
    const value = { ...command(), requestedBudgetMs: 250, outerRemainingBudgetMs: 250 }
    let authorizationSignal: AbortSignal | undefined
    const bridge = createOpenCodeLaunchAttemptProductionBridge({
      authorize: async (_command, controls) => {
        authorizationSignal = controls.signal
        return new Promise<never>(() => {})
      },
      inspect: async () => { throw new Error('ledger must not run') },
      executeAfterPreflight: async () => { throw new Error('effects must not run') },
    })
    const started = performance.now()
    await expect(bridge.execute(value)).rejects.toThrow('absolute deadline')
    expect(authorizationSignal?.aborted).toBe(true)
    expect(performance.now() - started).toBeLessThan(500)
  })

  test.skipIf(process.platform === 'win32')('canonicalizes a real project and its symlink alias before authorization and digesting', async () => {
    const project = path.join(projectPath, 'canonical-project')
    const alias = path.join(projectPath, 'canonical-alias')
    await mkdir(project); await symlink(project, alias)
    const observed: Parameters<OpenCodeLaunchAttemptBridgePort['execute']>[0][] = []
    const output = { snapshot, data: { launchAttempt: { status: 'succeeded' } } }
    const bridge = createOpenCodeLaunchAttemptProductionBridge({
      authorize: async value => { observed.push(value); return value },
      inspect: async () => output,
      executeAfterPreflight: async () => { throw new Error('effects must not run') },
    })

    await bridge.execute({ ...command(), projectPath: project })
    await bridge.execute({ ...command(), projectPath: alias })
    const correlatedAlias = {
      ...command(),
      projectPath: alias,
      requestProjectPath: alias,
      effectiveProfilePlanDigest: 'f'.repeat(64),
    }
    correlatedAlias.request.launchAttempt.requestCorrelationDigest =
      computeOpenCodeLaunchRequestCorrelationDigest(correlatedAlias)
    await bridge.execute(correlatedAlias)

    expect(observed).toHaveLength(3)
    expect(observed[0]!.projectPath).toBe(project)
    expect(observed[1]!.projectPath).toBe(project)
    expect(observed[0]!.projectIdentity).toBe(observed[1]!.projectIdentity)
    expect(computeOpenCodeLaunchCommandInputDigest(observed[0]!))
      .toBe(computeOpenCodeLaunchCommandInputDigest(observed[1]!))
    expect(observed[2]).toMatchObject({
      projectPath: project,
      projectIdentity: project,
      requestProjectPath: alias,
      effectiveProfilePlanDigest: 'f'.repeat(64),
    })
    expect(observed[2]!.request.launchAttempt.requestCorrelationDigest)
      .toBe(computeOpenCodeLaunchRequestCorrelationDigest(observed[2]!))
    const targets = observed.slice(0, 2).map(value => OpenCodeLaunchMutationLedger.targetDigest({
      teamId: value.teamId,
      laneId: value.laneId,
      projectIdentity: value.projectIdentity!,
      memberIdentity: value.members[0]!.memberIdentity,
    }))
    expect(targets[0]).toBe(targets[1])
    expect(OpenCodeLaunchMutationLedger.idempotencyIdentity(targets[0]!))
      .toBe(OpenCodeLaunchMutationLedger.idempotencyIdentity(targets[1]!))
  })

  test('an 80ms durable inspection cannot reset or extend the absolute envelope', async () => {
    let now = 1_000
    let inspectedDeadline = 0
    let executed: Parameters<OpenCodeLaunchAttemptBridgePort['execute']>[0] | undefined
    const output = { snapshot, data: { launchAttempt: result } }
    const bridge = createOpenCodeLaunchAttemptProductionBridge({
      authorize: async (value, controls) => {
        expect(controls.deadlineAtMs).toBe(1_100)
        return value
      },
      inspect: async value => {
        inspectedDeadline = value.deadlineAtMs!
        now += 80
        return null
      },
      executeAfterPreflight: async value => {
        executed = value
        return { output, result }
      },
    }, { monotonicNow: () => now })
    const value = { ...command(), requestedBudgetMs: 100, outerRemainingBudgetMs: 100,
      deadlineAtMs: 1_100 }

    await expect(bridge.execute(value)).resolves.toBe(output)
    expect(inspectedDeadline).toBe(1_100)
    expect(executed?.deadlineAtMs).toBe(1_100)
    expect(executed?.outerRemainingBudgetMs).toBe(20)
    expect(executed!.deadlineAtMs! - now).toBe(20)
  })

  test('pre-cancellation bounds canonicalization and reaches no authorization or ledger work', async () => {
    const reason = new Error('caller cancelled')
    const controller = new AbortController(); controller.abort(reason)
    let canonicalCalls = 0
    const bridge = createOpenCodeLaunchAttemptProductionBridge({
      authorize: async () => { throw new Error('authorization must not run') },
      inspect: async () => { throw new Error('ledger must not run') },
      executeAfterPreflight: async () => { throw new Error('effects must not run') },
    }, { canonicalizeProject: async () => { canonicalCalls += 1; return new Promise<never>(() => {}) } })

    await expect(bridge.execute({ ...command(), signal: controller.signal })).rejects.toBe(reason)
    expect(canonicalCalls).toBe(1)
  })
})
