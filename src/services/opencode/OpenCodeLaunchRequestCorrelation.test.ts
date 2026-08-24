import { describe, expect, test } from 'bun:test'

import type { OpenCodeLaunchAttemptBridgePort } from './OpenCodeLaunchAttemptBridge.js'
import {
  computeOpenCodeLaunchCommandImmutableDigest,
  computeOpenCodeLaunchCommandInputDigest,
  computeOpenCodeLaunchRequestCorrelationDigest,
  validateOpenCodeLaunchRequestCorrelation,
} from './OpenCodeLaunchAttemptBridge.js'

const opaque = (character: string) => `sha256:${character.repeat(64)}` as const

function command(): Parameters<OpenCodeLaunchAttemptBridgePort['execute']>[0] {
  return {
    request: {
      launchContractVersion: 1,
      launchAttempt: {
        attemptId: '018f47a2-4a13-7c2f-8d44-c0ffee123456',
        payloadHash: 'a'.repeat(64),
        generation: 1,
        proofNonce: 'AAECAwQFBgcICQoLDA0ODw',
        parent: { sessionIdentity: opaque('b'), messageIdentity: opaque('c') },
        providerId: 'openrouter',
        modelId: 'openrouter/model-s3',
        requiredMcpTools: ['agent-teams.message_send', 'agent-teams.task_update'],
        requireFreshRetainedHostProof: true,
      },
    },
    members: [
      { memberIdentity: opaque('d'), name: 'alice', prompt: 'Implement the wire fix', effort: 'high' },
      { memberIdentity: opaque('e'), name: 'bob' },
    ],
    runId: 'run-correlation-golden',
    laneId: 'primary',
    teamId: 'team-correlation',
    projectPath: '/workspace/link/../link/project',
    selectedModel: 'openrouter/model-s3',
    toolApprovalMode: 'manual',
    continuation: false,
    requestedBudgetMs: 45_000,
    preconditions: {
      handshakeIdentityHash: '1'.repeat(64),
      laneId: 'primary',
      expectedRunId: 'run-correlation-golden',
      expectedCapabilitySnapshotId: 'opencode:snapshot-7',
      expectedBehaviorFingerprint: '2'.repeat(64),
      expectedManifestHighWatermark: 17,
      commandLeaseId: 'lease-correlation-1',
      idempotencyKey: '018f47a2-4a13-7c2f-8d44-c0ffee123456',
    },
  }
}

describe('OpenCode launch request correlation wire contract', () => {
  test('matches the cross-repository golden vector', () => {
    expect(computeOpenCodeLaunchRequestCorrelationDigest(command()))
      .toBe('d817390bbc9170b98433fc0961cbd3f2fcc0499d321d4607fff3e94c577cae69')
  })

  test('binds path spelling, member order, nonce, every precondition, and requested budget', () => {
    const baseline = computeOpenCodeLaunchRequestCorrelationDigest(command())
    const mutations: Array<(value: ReturnType<typeof command>) => void> = [
      value => { value.projectPath = '/workspace/real/project' },
      value => { value.members = [...value.members].reverse() },
      value => { value.request.launchAttempt.proofNonce = 'AQECAwQFBgcICQoLDA0ODw' },
      value => { value.requestedBudgetMs += 1 },
      value => { value.preconditions.handshakeIdentityHash = '3'.repeat(64) },
      value => { value.preconditions.laneId = 'secondary' },
      value => { value.preconditions.expectedRunId = 'run-other' },
      value => { value.preconditions.expectedCapabilitySnapshotId = null },
      value => { value.preconditions.expectedBehaviorFingerprint = '4'.repeat(64) },
      value => { value.preconditions.expectedManifestHighWatermark = 18 },
      value => { value.preconditions.commandLeaseId = 'lease-other' },
      value => { value.preconditions.idempotencyKey = '018f47a2-4a13-7c2f-8d44-c0ffee123457' },
    ]
    for (const mutate of mutations) {
      const candidate = structuredClone(command())
      mutate(candidate)
      expect(computeOpenCodeLaunchRequestCorrelationDigest(candidate)).not.toBe(baseline)
    }
  })

  test('uses request path spelling despite realpath and plan enrichment', () => {
    const wire = command()
    const expected = computeOpenCodeLaunchRequestCorrelationDigest(wire)
    const enriched = {
      ...wire,
      requestProjectPath: wire.projectPath,
      projectPath: '/workspace/real/project',
      projectIdentity: '/workspace/real/project',
      effectiveProfilePlanDigest: 'f'.repeat(64),
    }
    expect(computeOpenCodeLaunchRequestCorrelationDigest(enriched)).toBe(expected)
    enriched.request.launchAttempt.requestCorrelationDigest = expected
    expect(() => validateOpenCodeLaunchRequestCorrelation(enriched)).not.toThrow()
  })

  test('preserves conditional legacy hash vectors without authorizing an uncorrelated launch', () => {
    const legacy = command()
    const legacyInput = computeOpenCodeLaunchCommandInputDigest(legacy)
    const legacyImmutable = computeOpenCodeLaunchCommandImmutableDigest(legacy)
    expect(legacyInput).toBe('3fb0f72921eacefb146b5c07b31d16fe1d5d6fd593785fe8cc4fb0942c503f9b')
    expect(legacyImmutable).toBe('3818a70eed21f9d073b73b89906323aa1a3c10c22860cf164254d7045f32d50d')
    expect(() => validateOpenCodeLaunchRequestCorrelation(legacy))
      .toThrow('correlation digest is required')

    const correlated = structuredClone(legacy)
    correlated.request.launchAttempt.requestCorrelationDigest =
      computeOpenCodeLaunchRequestCorrelationDigest(correlated)
    expect(computeOpenCodeLaunchCommandInputDigest(correlated)).not.toBe(legacyInput)
    expect(computeOpenCodeLaunchCommandImmutableDigest(correlated)).toBe(legacyImmutable)
  })
})
