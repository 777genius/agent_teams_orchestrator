import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { executeOpenCodeBridgeCommandEnvelope } from './OpenCodeBridgeCommandHandler.js'
import {
  installOpenCodeLaunchAttemptPortsForTests,
  resetOpenCodeLaunchAttemptProductionPortsForTests,
} from './OpenCodeLaunchAttemptBridge.js'
import { openCodeProvisioningProbe } from './OpenCodeProvisioningProbe.js'
import { openCodeSessionBridge } from './OpenCodeSessionBridge.js'
import type { OpenCodeBridgeCommandHandlerPorts } from './OpenCodeLaunchAttemptBridge.js'
import type { OpenCodeProvisioningSnapshot } from './types.js'
import { createOpenCodeLaunchAttemptProductionBridge } from './OpenCodeLaunchAttemptProductionComposition.js'

const identity = (value: string) => `sha256:${value.repeat(64).slice(0, 64)}` as const
let sandboxProject = ''
beforeAll(async () => { sandboxProject = await mkdtemp(path.join(os.tmpdir(), 'opencode-bridge-project-')) })
afterAll(async () => { await rm(sandboxProject, { recursive: true, force: true }) })

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    requestId: 'request-s3',
    command: 'opencode.launchTeam',
    cwd: sandboxProject,
    startedAt: '2026-08-19T00:00:00.000Z',
    timeoutMs: 42_000,
    body: {
      runId: 'run-s3',
      laneId: 'primary',
      teamId: 'team-s3',
      selectedModel: 'openrouter/model-s3',
      launchContractVersion: 1,
      launchAttempt: {
        attemptId: '018f47a2-4a13-7c2f-8d44-c0ffee123456',
        payloadHash: 'a'.repeat(64),
        generation: 1,
        proofNonce: 'A'.repeat(43),
        parent: { sessionIdentity: identity('b'), messageIdentity: identity('c') },
        providerId: 'openrouter',
        modelId: 'openrouter/model-s3',
        requiredMcpTools: ['agent-teams.message_send'],
        requireFreshRetainedHostProof: true,
      },
      members: [
        { name: 'alice', memberIdentity: identity('d'), prompt: 'fake prompt' },
        { name: 'bob', memberIdentity: identity('e') },
      ],
      ...overrides,
    },
  }
}

const originalProbe = openCodeProvisioningProbe.probeRetainingHost
const originalEnsure = openCodeSessionBridge.ensureSession

afterEach(() => {
  openCodeProvisioningProbe.probeRetainingHost = originalProbe
  openCodeSessionBridge.ensureSession = originalEnsure
  resetOpenCodeLaunchAttemptProductionPortsForTests()
})

describe('OpenCodeLaunchAttempt production-handler boundary', () => {
  test('absent optional version still reaches ledger-first routing for completed and unknown', async () => {
    for (const status of ['succeeded', 'reconciliation_required'] as const) {
      const calls: string[] = []
      openCodeProvisioningProbe.probeRetainingHost = (async () => {
        calls.push('legacy-host'); throw new Error('must not run')
      }) as typeof openCodeProvisioningProbe.probeRetainingHost
      openCodeSessionBridge.ensureSession = (async () => {
        calls.push('legacy-member'); throw new Error('must not run')
      }) as typeof openCodeSessionBridge.ensureSession
      const bridge = createOpenCodeLaunchAttemptProductionBridge({
        authorize: async value => { calls.push('plan'); return value },
        inspect: async () => {
          calls.push('ledger')
          return {
            snapshot: null as unknown as OpenCodeProvisioningSnapshot,
            data: { launchAttempt: { status } },
          }
        },
        executeAfterPreflight: async () => {
          calls.push('profile', 'host', 'member'); throw new Error('must not run')
        },
      })
      const candidate = envelope()
      delete (candidate.body as Record<string, unknown>).launchContractVersion
      const result = await executeOpenCodeBridgeCommandEnvelope(candidate, { launchAttempt: bridge })
      expect(result.ok).toBe(true)
      expect(calls).toEqual(['plan', 'ledger'])
    }
  })

  test('absent optional version ledger mismatch fails with zero launch effects', async () => {
    const calls: string[] = []
    const bridge = createOpenCodeLaunchAttemptProductionBridge({
      authorize: async value => { calls.push('plan'); return value },
      inspect: async () => { calls.push('ledger'); throw new Error('immutable plan mismatch') },
      executeAfterPreflight: async () => {
        calls.push('profile', 'host', 'member'); throw new Error('must not run')
      },
    })
    const candidate = envelope()
    delete (candidate.body as Record<string, unknown>).launchContractVersion
    const result = await executeOpenCodeBridgeCommandEnvelope(candidate, { launchAttempt: bridge })
    expect(result.ok).toBe(false)
    expect(calls).toEqual(['plan', 'ledger'])
  })

  test('genuinely legacy launch fails closed before legacy or S3 effects', async () => {
    let calls = 0
    const candidate = envelope({ launchContractVersion: undefined, launchAttempt: undefined })
    const result = await executeOpenCodeBridgeCommandEnvelope(candidate, {
      launchAttempt: { execute: async () => { calls += 1; throw new Error('must not run') } },
    })
    expect(result.ok).toBe(false)
    expect(calls).toBe(0)
    if (!result.ok) expect(result.error.message).toContain('unsupported/not-authorized')
  })

  test('routes an S3 launch only through the narrow injected attempt port', async () => {
    let input: Parameters<OpenCodeBridgeCommandHandlerPorts['launchAttempt']['execute']>[0] | null = null
    openCodeProvisioningProbe.probeRetainingHost = (async () => {
      throw new Error('legacy provisioning must not run')
    }) as typeof openCodeProvisioningProbe.probeRetainingHost
    openCodeSessionBridge.ensureSession = (async () => {
      throw new Error('legacy session creation must not run')
    }) as typeof openCodeSessionBridge.ensureSession
    const ports: OpenCodeBridgeCommandHandlerPorts = {
      launchAttempt: {
        execute: async value => {
          input = value
          return {
            snapshot: null as unknown as OpenCodeProvisioningSnapshot,
            data: { launchAttempt: { status: 'succeeded', generation: 1 } },
          }
        },
      },
    }

    installOpenCodeLaunchAttemptPortsForTests(ports)
    const result = await executeOpenCodeBridgeCommandEnvelope(envelope())

    expect(result.ok).toBe(true)
    expect(input).toMatchObject({
      runId: 'run-s3', laneId: 'primary', teamId: 'team-s3',
      projectPath: sandboxProject, selectedModel: 'openrouter/model-s3',
      continuation: false, requestedBudgetMs: 42_000,
      members: [
        { name: 'alice', memberIdentity: identity('d'), prompt: 'fake prompt' },
        { name: 'bob', memberIdentity: identity('e') },
      ],
    })
    expect(input!.deadlineAtMs).toBeGreaterThan(0)
    expect(input!.outerRemainingBudgetMs).toBeLessThanOrEqual(42_000)
    expect(result.data).toEqual({ launchAttempt: { status: 'succeeded', generation: 1 } })
  })

  test('fails closed before any runtime call for a different plan under the same attempt id', async () => {
    let calls = 0
    const ports: OpenCodeBridgeCommandHandlerPorts = {
      launchAttempt: {
        execute: async () => {
          calls += 1
          throw new Error('must not run')
        },
      },
    }

    const result = await executeOpenCodeBridgeCommandEnvelope(
      envelope({ selectedModel: 'other/model' }), ports,
    )

    expect(result.ok).toBe(false)
    expect(calls).toBe(0)
    if (!result.ok) expect(result.error.message).toContain('does not match')
  })

  test('requires canonical member identities before entering the S3 runtime', async () => {
    const invalid = await executeOpenCodeBridgeCommandEnvelope(envelope({
      members: [{ name: 'alice', memberIdentity: 'alice' }],
    }), {
      launchAttempt: { execute: async () => { throw new Error('must not run') } },
    })
    expect(invalid.ok).toBe(false)
    if (!invalid.ok) expect(invalid.error.message).toContain('member at index 0')
  })

  test('marks continuation from the immutable continuation token', async () => {
    let continuation = false
    const candidate = envelope()
    ;(candidate.body.launchAttempt as Record<string, unknown>).generation = 2
    ;(candidate.body.launchAttempt as Record<string, unknown>).continuationToken = 'continuation-2'
    const result = await executeOpenCodeBridgeCommandEnvelope(candidate, {
      launchAttempt: {
        execute: async input => {
          continuation = input.continuation
          return { snapshot: null as unknown as OpenCodeProvisioningSnapshot, data: { ok: true } }
        },
      },
    })

    expect(result.ok).toBe(true)
    expect(continuation).toBe(true)
  })
})
