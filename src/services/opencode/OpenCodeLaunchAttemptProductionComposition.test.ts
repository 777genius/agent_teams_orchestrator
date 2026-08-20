import { describe, expect, test } from 'bun:test'

import { createOpenCodeLaunchAttemptProductionBridge } from './OpenCodeLaunchAttemptProductionComposition.js'
import type { OpenCodeLaunchAttemptBridgePort } from './OpenCodeLaunchAttemptBridge.js'
import type { OpenCodeLaunchAttemptResult } from './OpenCodeLaunchAttempt.js'
import type { OpenCodeProvisioningSnapshot } from './types.js'

const identity = (character: string) => `sha256:${character.repeat(64)}` as const
const snapshot = { detected: false } as OpenCodeProvisioningSnapshot
const result: OpenCodeLaunchAttemptResult = {
  generation: 1,
  status: 'succeeded',
  committed: [],
  pending: [],
  cleanup: 'complete',
  absoluteDeadlineAtMs: 10_000,
  workDeadlineAtMs: 9_000,
}

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
    runId: 'run', laneId: 'primary', teamId: 'team', projectPath: '/fake/project',
    selectedModel: 'openrouter/model', toolApprovalMode: 'auto', continuation: false,
    requestedBudgetMs: 10_000,
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
})
