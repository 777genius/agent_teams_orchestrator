import { describe, expect, test } from 'bun:test'

import {
  buildOpenCodeOpaqueIdentity,
  buildOpenCodeRetainedHostIdentity,
  decodeOpenCodeBridgeCapabilities,
  decodeOpenCodeLaunchAttemptRequest,
  decodeOpenCodeLaunchAttemptRequestJson,
  decodeOpenCodeLaunchAttemptResponse,
  encodeOpenCodeBridgeCapabilities,
  encodeOpenCodeLaunchAttemptRequest,
  encodeOpenCodeLaunchAttemptResponse,
  isOpenCodeLaunchProofNonce,
  isOpenCodeLaunchAttemptId,
  isOpenCodeLaunchPayloadHash,
  isOpenCodeOpaqueIdentity,
  OPEN_CODE_LAUNCH_ATTEMPT_CONTRACT_VERSION,
  serializeOpenCodeLaunchAttemptResponse,
  validateOpenCodeLaunchAttemptCorrelation,
} from './OpenCodeBridgeContractV2.js'
import { OPEN_CODE_LAUNCH_FAILURE_POLICY } from './OpenCodeLaunchAttemptPolicy.js'
import type {
  OpenCodeLaunchAttemptRequest,
  OpenCodeLaunchAttemptResponse,
  OpenCodeLaunchFailureKind,
} from './OpenCodeBridgeContractV2.js'

const attemptId = '018f47a2-4a13-7c2f-8d44-c0ffee123456'
const nonce = 'AAECAwQFBgcICQoLDA0ODw'
const payloadHash = 'a'.repeat(64)
const nonceHash = 'b'.repeat(64)
const identity = (character: string) => buildOpenCodeOpaqueIdentity(character.repeat(64))
const retainedHostIdentity = () => buildOpenCodeRetainedHostIdentity(
  identity('3'), 42, 1_776_600_000_001, identity('4'),
)

function request(): OpenCodeLaunchAttemptRequest {
  return {
    launchContractVersion: 1,
    launchAttempt: {
      attemptId,
      payloadHash,
      generation: 7,
      proofNonce: nonce,
      parent: { sessionIdentity: identity('1'), messageIdentity: identity('2') },
      providerId: 'xai',
      modelId: 'xai/grok-code-fast-1',
      requiredMcpTools: ['mcp.read', 'mcp.write'],
      continuationToken: 'opaque-continuation-value',
      requireFreshRetainedHostProof: true,
    },
  }
}

function response(): OpenCodeLaunchAttemptResponse {
  return {
    launchAttempt: {
      contractVersion: 1,
      attemptId,
      idempotencyKey: 'attemptId',
      payloadHash,
      generation: 7,
      inputDigest: 'd'.repeat(64),
      immutableDigest: 'e'.repeat(64),
      outcome: 'partial',
      phase: 'cleanup',
      startedAt: 1_776_600_000_000,
      workDeadlineAt: 1_776_600_060_000,
      absoluteDeadlineAt: 1_776_600_075_000,
      cleanupReserveMs: 15_000,
      elapsedMs: 2_500,
      providerId: 'xai',
      modelId: 'xai/grok-code-fast-1',
      profilePurpose: 'launch',
      projectIdentity: identity('a'),
      profileIdentity: identity('4'),
      configIdentity: identity('b'),
      authIdentity: identity('c'),
      pluginPolicyIdentity: identity('5'),
      cacheIdentity: identity('6'),
      binaryIdentity: identity('0'),
      retainedHostIdentity: retainedHostIdentity(),
      processStartedAtMs: 1_776_600_000_001,
    },
    proof: {
      generation: 7,
      attemptId,
      parent: { sessionIdentity: identity('1'), messageIdentity: identity('2') },
      providerId: 'xai',
      modelId: 'xai/grok-code-fast-1',
      retainedHostIdentity: retainedHostIdentity(),
      observedMcpTools: ['mcp.read', 'mcp.write', 'mcp.extra'],
      nonceHash,
      sessionIdentity: identity('7'),
      promptMessageIdentity: identity('8'),
      assistantMessageIdentity: identity('9'),
      verifiedAt: 1_776_600_030_000,
      authorizationSource: 'fresh_live_attempt',
      cacheUsed: false,
    },
    members: {
      committed: [{
        memberIdentity: identity('c'),
        sessionIdentity: identity('a'),
        bootstrapMessageIdentity: identity('b'),
        commitIdentity: identity('f'),
      }],
      failed: [{
        memberIdentity: identity('d'),
        failure: {
          code: 'deadline_after_partial',
          origin: 'deadline',
          retryDisposition: 'continuation',
          retryable: true,
          phase: 'member_materialize',
          sideEffectsStarted: true,
          exhaustionScope: 'member',
        },
      }],
      pending: [identity('e')],
      cleanupPending: [identity('c')],
      continuationToken: 'opaque-continuation-value',
    },
  }
}

describe('OpenCodeBridgeContractV2 negotiation and request', () => {
  test('keeps top-level negotiation optional and fails malformed advertised fields closed', () => {
    expect(decodeOpenCodeBridgeCapabilities({ futureCapability: 99 })).toEqual({
      ok: true,
      value: {
        openCodeLaunchAttemptContract: 0,
        purposeScopedProfiles: 0,
        freshRetainedHostProof: 0,
        idempotentContinuation: 0,
        typedFailureDiagnostics: 0,
      },
    })
    const advertised = {
      openCodeLaunchAttemptContract: 1,
      purposeScopedProfiles: 1,
      freshRetainedHostProof: 1,
      idempotentContinuation: 1,
      typedFailureDiagnostics: 1,
    }
    expect(decodeOpenCodeBridgeCapabilities(encodeOpenCodeBridgeCapabilities(advertised)))
      .toEqual({ ok: true, value: advertised })
    for (const legacyOrMalformed of [
      {},
      { executionProof: { reusable: true } },
      { openCodeLaunchAttemptContract: 0 },
      { openCodeLaunchAttemptContract: 2 },
      { openCodeLaunchAttemptContract: null },
      { openCodeLaunchAttemptContract: '1' },
      { openCodeLaunchAttemptContract: 1.5 },
    ]) {
      const decoded = decodeOpenCodeBridgeCapabilities(legacyOrMalformed)
      expect(decoded.ok === true
        && decoded.value.openCodeLaunchAttemptContract === OPEN_CODE_LAUNCH_ATTEMPT_CONTRACT_VERSION)
        .toBe(false)
    }
    expect(decodeOpenCodeBridgeCapabilities({ purposeScopedProfiles: 1.5 }))
      .toEqual({ ok: false, error: { code: 'invalid_field', field: 'purposeScopedProfiles' } })
  })

  test('does not promote a legacy executionProof and requires the complete v2 envelope', () => {
    expect(decodeOpenCodeLaunchAttemptRequest({ executionProof: { reusable: true } }))
      .toEqual({ ok: true, value: { kind: 'legacy' } })
    const decoded = decodeOpenCodeLaunchAttemptRequest({
      ...request(),
      launchAttempt: {
        ...request().launchAttempt,
        endpoint: 'https://secret.invalid',
        retainedHostIdentity: retainedHostIdentity(),
      },
    })
    expect(decoded).toEqual({ ok: true, value: { kind: 'v2', request: request() } })
    for (const field of ['payloadHash', 'generation', 'parent', 'providerId', 'modelId', 'requiredMcpTools']) {
      const malformed = structuredClone(request()) as unknown as { launchAttempt: Record<string, unknown> }
      delete malformed.launchAttempt[field]
      expect(decodeOpenCodeLaunchAttemptRequest(malformed)).toMatchObject({
        ok: false,
        error: { field: `launchAttempt.${field}` },
      })
    }
  })

  test('accepts only canonical lowercase UUID and payload-hash spellings', () => {
    expect(isOpenCodeLaunchAttemptId(attemptId)).toBe(true)
    expect(isOpenCodeLaunchAttemptId(attemptId.toUpperCase())).toBe(false)
    expect(isOpenCodeLaunchAttemptId('not-a-uuid')).toBe(false)
    const uppercaseRequest = request()
    uppercaseRequest.launchAttempt.attemptId = attemptId.toUpperCase()
    expect(decodeOpenCodeLaunchAttemptRequest(uppercaseRequest)).toMatchObject({
      ok: false,
      error: { field: 'launchAttempt.attemptId' },
    })
    const uppercaseResponseAttempt = response()
    uppercaseResponseAttempt.launchAttempt.attemptId = attemptId.toUpperCase()
    expect(decodeOpenCodeLaunchAttemptResponse(uppercaseResponseAttempt)).toMatchObject({
      ok: false,
      error: { field: 'launchAttempt.attemptId' },
    })
    const uppercaseProofAttempt = response()
    uppercaseProofAttempt.proof!.attemptId = attemptId.toUpperCase()
    expect(decodeOpenCodeLaunchAttemptResponse(uppercaseProofAttempt)).toMatchObject({
      ok: false,
      error: { field: 'proof.attemptId' },
    })
    expect(isOpenCodeLaunchPayloadHash(payloadHash)).toBe(true)
    for (const badHash of ['a'.repeat(63), 'A'.repeat(64), `${'a'.repeat(64)}0`, `sha256:${payloadHash}`]) {
      const malformed = request() as unknown as { launchAttempt: Record<string, unknown> }
      malformed.launchAttempt.payloadHash = badHash
      expect(decodeOpenCodeLaunchAttemptRequest(malformed)).toMatchObject({
        ok: false,
        error: { field: 'launchAttempt.payloadHash' },
      })
    }
    expect(encodeOpenCodeLaunchAttemptResponse(response()).launchAttempt.idempotencyKey)
      .toBe('attemptId')
  })

  test('validates canonical nonces and JSON parsing', () => {
    expect(isOpenCodeLaunchProofNonce(nonce)).toBe(true)
    expect(isOpenCodeLaunchProofNonce('short')).toBe(false)
    expect(decodeOpenCodeLaunchAttemptRequestJson('{')).toEqual({
      ok: false,
      error: { code: 'invalid_json', field: '$' },
    })
    expect(decodeOpenCodeLaunchAttemptRequestJson(JSON.stringify(request()))).toMatchObject({
      ok: true,
      value: { kind: 'v2' },
    })
  })

  test('requires strictly positive request, response, and proof generations', () => {
    const invalidRequest = request(); invalidRequest.launchAttempt.generation = 0
    expect(decodeOpenCodeLaunchAttemptRequest(invalidRequest)).toMatchObject({
      ok: false, error: { field: 'launchAttempt.generation' },
    })
    const invalidResponse = response(); invalidResponse.launchAttempt.generation = 0
    expect(decodeOpenCodeLaunchAttemptResponse(invalidResponse)).toMatchObject({
      ok: false, error: { field: 'launchAttempt.generation' },
    })
    const invalidProof = response(); invalidProof.proof!.generation = 0
    expect(decodeOpenCodeLaunchAttemptResponse(invalidProof)).toMatchObject({
      ok: false, error: { field: 'proof.generation' },
    })
  })
})

describe('OpenCodeBridgeContractV2 canonical failures', () => {
  test('matches every policy kind and rejects every contradictory tuple', () => {
    const expected = {
      pre_side_effect_transport: ['automatic', true, false],
      rate_limited: ['backoff', true, false],
      quota_exhausted: ['backoff', true, false],
      provider_plan_denied: ['external_change', true, false],
      authentication_required: ['user_action', true, false],
      external_dependency: ['external_change', true, false],
      contract_violation: ['never', false, false],
      candidate_budget_exhausted: ['backoff', true, false],
      attempt_budget_exhausted: ['never', false, false],
      deadline_before_partial: ['backoff', true, false],
      deadline_after_partial: ['continuation', true, true],
      unknown_transport_after_side_effect: ['never', false, true],
      cancelled: ['never', false, false],
    } as const satisfies Record<OpenCodeLaunchFailureKind, readonly [string, boolean, boolean]>
    expect(Object.keys(OPEN_CODE_LAUNCH_FAILURE_POLICY)).toEqual(Object.keys(expected))
    for (const code of Object.keys(expected) as OpenCodeLaunchFailureKind[]) {
      const [retryDisposition, retryable, sideEffectsStarted] = expected[code]
      expect(OPEN_CODE_LAUNCH_FAILURE_POLICY[code].retryDisposition).toBe(retryDisposition)
      expect(OPEN_CODE_LAUNCH_FAILURE_POLICY[code].retryable).toBe(retryable)
      expect(OPEN_CODE_LAUNCH_FAILURE_POLICY[code].sideEffectsStarted).toBe(sideEffectsStarted)
      for (const mutation of [
        { retryDisposition: retryDisposition === 'never' ? 'backoff' : 'never' },
        { retryable: !retryable },
        { sideEffectsStarted: !sideEffectsStarted },
      ]) {
        const malformed = response() as unknown as { members: { failed: Array<{ failure: Record<string, unknown> }> } }
        malformed.members.failed[0]!.failure = {
          ...malformed.members.failed[0]!.failure,
          code,
          retryDisposition,
          retryable,
          sideEffectsStarted,
          ...mutation,
        }
        expect(decodeOpenCodeLaunchAttemptResponse(malformed)).toMatchObject({ ok: false })
      }
    }
    const automatic = Object.entries(OPEN_CODE_LAUNCH_FAILURE_POLICY)
      .filter(([, tuple]) => tuple.retryDisposition === 'automatic')
    expect(automatic).toEqual([['pre_side_effect_transport', {
      retryDisposition: 'automatic', retryable: true, sideEffectsStarted: false,
    }]])
  })

  test('rejects free-form failure codes', () => {
    const malformed = response() as unknown as { members: { failed: Array<{ failure: { code: string } }> } }
    malformed.members.failed[0]!.failure.code = 'host.start_failed'
    expect(decodeOpenCodeLaunchAttemptResponse(malformed)).toMatchObject({
      ok: false,
      error: { field: 'members.failed.0.failure.code' },
    })
  })
})

describe('OpenCodeBridgeContractV2 proof correlation', () => {
  test('retains every proof field and validates exact request/current-generation/MCP correlation', () => {
    const decoded = decodeOpenCodeLaunchAttemptResponse(response())
    expect(decoded).toEqual({ ok: true, value: { kind: 'v2', response: response() } })
    expect(validateOpenCodeLaunchAttemptCorrelation(request(), response(), {
      currentGeneration: 7,
      expectedNonceHash: nonceHash,
      expectedProfilePurpose: 'launch',
      expectedProviderId: 'xai',
      expectedProjectIdentity: identity('a'),
      expectedConfigIdentity: identity('b'),
      expectedAuthIdentity: identity('c'),
      expectedPluginPolicyIdentity: identity('5'),
      expectedCacheIdentity: identity('6'),
      expectedBinaryIdentity: identity('0'),
      expectedRetainedHostIdentity: retainedHostIdentity(),
      requiredMcpTools: ['mcp.extra'],
    })).toMatchObject({ ok: true })

    const mismatches: Array<[string, (value: OpenCodeLaunchAttemptResponse) => void]> = [
      ['launchAttempt.attemptId', value => { value.launchAttempt.attemptId = '018f47a2-4a13-7c2f-8d44-c0ffee123457' }],
      ['launchAttempt.payloadHash', value => { value.launchAttempt.payloadHash = 'f'.repeat(64) }],
      ['launchAttempt.providerId', value => {
        value.launchAttempt.providerId = 'other'
        value.launchAttempt.modelId = 'other/model'
      }],
      ['launchAttempt.modelId', value => { value.launchAttempt.modelId = 'other/model' }],
      ['launchAttempt.profilePurpose', value => { value.launchAttempt.profilePurpose = 'execution_probe' }],
      ['launchAttempt.profileIdentity', value => { value.launchAttempt.profileIdentity = identity('f') }],
      ['launchAttempt.projectIdentity', value => { value.launchAttempt.projectIdentity = identity('f') }],
      ['launchAttempt.configIdentity', value => { value.launchAttempt.configIdentity = identity('f') }],
      ['launchAttempt.authIdentity', value => { value.launchAttempt.authIdentity = identity('f') }],
      ['launchAttempt.pluginPolicyIdentity', value => { value.launchAttempt.pluginPolicyIdentity = identity('f') }],
      ['launchAttempt.cacheIdentity', value => { value.launchAttempt.cacheIdentity = identity('f') }],
      ['launchAttempt.binaryIdentity', value => { value.launchAttempt.binaryIdentity = identity('f') }],
      ['launchAttempt.retainedHostIdentity', value => { value.launchAttempt.retainedHostIdentity.processId += 1 }],
      ['proof.attemptId', value => { value.proof!.attemptId = '018f47a2-4a13-7c2f-8d44-c0ffee123457' }],
      ['proof.generation', value => { value.proof!.generation = 8 }],
      ['proof.parent.sessionIdentity', value => { value.proof!.parent.sessionIdentity = identity('f') }],
      ['proof.providerId', value => {
        value.proof!.providerId = 'other'
        value.proof!.modelId = 'other/model'
      }],
      ['proof.modelId', value => { value.proof!.modelId = 'other/model' }],
      ['proof.retainedHostIdentity', value => { value.proof!.retainedHostIdentity.hostKeyIdentity = identity('f') }],
      ['proof.nonceHash', value => { value.proof!.nonceHash = 'f'.repeat(64) }],
      ['proof.observedMcpTools', value => { value.proof!.observedMcpTools = ['mcp.read'] }],
    ]
    for (const [field, mutate] of mismatches) {
      const candidate = structuredClone(response())
      mutate(candidate)
      expect(validateOpenCodeLaunchAttemptCorrelation(request(), candidate, {
        currentGeneration: 7,
        expectedNonceHash: nonceHash,
        expectedProfilePurpose: 'launch',
        expectedProviderId: 'xai',
        expectedProjectIdentity: identity('a'),
        expectedConfigIdentity: identity('b'),
        expectedAuthIdentity: identity('c'),
        expectedPluginPolicyIdentity: identity('5'),
        expectedCacheIdentity: identity('6'),
        expectedBinaryIdentity: identity('0'),
        expectedRetainedHostIdentity: retainedHostIdentity(),
      })).toMatchObject({
        ok: false,
        failure: {
          code: 'contract_violation',
          retryDisposition: 'never',
          retryable: false,
          sideEffectsStarted: false,
          field,
        },
      })
    }
    expect(validateOpenCodeLaunchAttemptCorrelation(request(), response(), {
      currentGeneration: 8,
      expectedNonceHash: nonceHash,
      expectedProfilePurpose: 'launch',
      expectedProviderId: 'xai',
      expectedProjectIdentity: identity('a'),
      expectedConfigIdentity: identity('b'),
      expectedAuthIdentity: identity('c'),
      expectedPluginPolicyIdentity: identity('5'),
      expectedCacheIdentity: identity('6'),
      expectedBinaryIdentity: identity('0'),
      expectedRetainedHostIdentity: retainedHostIdentity(),
    })).toMatchObject({ ok: false, failure: { field: 'proof.currentGeneration' } })

    const expectedIdentityMismatches = [
      ['launchAttempt.expectedProviderId', { expectedProviderId: 'other' }],
      ['launchAttempt.profilePurpose', { expectedProfilePurpose: 'execution_probe' }],
      ['launchAttempt.projectIdentity', { expectedProjectIdentity: identity('f') }],
      ['launchAttempt.configIdentity', { expectedConfigIdentity: identity('f') }],
      ['launchAttempt.authIdentity', { expectedAuthIdentity: identity('f') }],
      ['launchAttempt.pluginPolicyIdentity', { expectedPluginPolicyIdentity: identity('f') }],
      ['launchAttempt.cacheIdentity', { expectedCacheIdentity: identity('f') }],
      ['launchAttempt.binaryIdentity', { expectedBinaryIdentity: identity('f') }],
    ] as const
    const baseContext = {
      currentGeneration: 7,
      expectedNonceHash: nonceHash,
      expectedProfilePurpose: 'launch',
      expectedProviderId: 'xai',
      expectedProjectIdentity: identity('a'),
      expectedConfigIdentity: identity('b'),
      expectedAuthIdentity: identity('c'),
      expectedPluginPolicyIdentity: identity('5'),
      expectedCacheIdentity: identity('6'),
      expectedBinaryIdentity: identity('0'),
      expectedRetainedHostIdentity: retainedHostIdentity(),
    }
    for (const [field, mismatch] of expectedIdentityMismatches) {
      expect(validateOpenCodeLaunchAttemptCorrelation(request(), response(), {
        ...baseContext,
        ...mismatch,
      })).toMatchObject({ ok: false, failure: { field } })
    }
  })

  test('requires cacheUsed=false and safe-integer clocks with exact cleanup reserve arithmetic', () => {
    const cases: Array<[string, (value: OpenCodeLaunchAttemptResponse) => void]> = [
      ['proof.cacheUsed', value => { (value.proof as unknown as { cacheUsed: boolean }).cacheUsed = true }],
      ['proof.verifiedAt', value => { value.proof!.verifiedAt = 1.5 }],
      ['proof.retainedHostIdentity', value => { value.proof!.retainedHostIdentity.processId = 0 }],
      ['launchAttempt.retainedHostIdentity', value => {
        value.launchAttempt.retainedHostIdentity.processStartedAtMs = Number.MAX_SAFE_INTEGER + 1
      }],
      ['launchAttempt.startedAt', value => { value.launchAttempt.startedAt = Number.MAX_SAFE_INTEGER + 1 }],
      ['launchAttempt.elapsedMs', value => { value.launchAttempt.elapsedMs = Number.POSITIVE_INFINITY }],
      ['launchAttempt.processStartedAtMs', value => { value.launchAttempt.processStartedAtMs! += 1 }],
      ['launchAttempt.cleanupReserveMs', value => { value.launchAttempt.cleanupReserveMs += 1 }],
      ['launchAttempt.cleanupReserveMs', value => {
        value.launchAttempt.cleanupReserveMs = 0
        value.launchAttempt.workDeadlineAt = value.launchAttempt.absoluteDeadlineAt
      }],
      ['launchAttempt.workDeadlineAt', value => {
        value.launchAttempt.workDeadlineAt = value.launchAttempt.absoluteDeadlineAt
        value.launchAttempt.cleanupReserveMs = 1
      }],
    ]
    for (const [field, mutate] of cases) {
      const candidate = response()
      mutate(candidate)
      expect(decodeOpenCodeLaunchAttemptResponse(candidate)).toMatchObject({ ok: false, error: { field } })
    }
  })
})

describe('OpenCodeBridgeContractV2 noReply member linkage', () => {
  test('accepts independently-bound durable identities without fabricating an assistant response', () => {
    const decoded = decodeOpenCodeLaunchAttemptResponse(response())
    expect(decoded).toMatchObject({
      ok: true,
      value: {
        response: {
          members: {
            committed: [{
              memberIdentity: identity('c'),
              sessionIdentity: identity('a'),
              bootstrapMessageIdentity: identity('b'),
              commitIdentity: identity('f'),
            }],
            failed: [{ memberIdentity: identity('d') }],
            pending: [identity('e')],
            continuationToken: 'opaque-continuation-value',
          },
        },
      },
    })
    if (!decoded.ok) throw new Error('expected valid noReply member linkage')
    if (decoded.value.kind !== 'v2') throw new Error('expected a v2 noReply member linkage')
    expect(decoded.value.response.members.committed[0]).not.toHaveProperty('promptMessageIdentity')
    expect(decoded.value.response.members.committed[0]).not.toHaveProperty('assistantMessageIdentity')
  })

  test.each([
    'memberIdentity',
    'sessionIdentity',
    'bootstrapMessageIdentity',
    'commitIdentity',
  ] as const)('rejects missing and noncanonical %s independently', field => {
    for (const malformed of [undefined, '', `sha256:${'A'.repeat(64)}`, 'not-an-identity']) {
      const candidate = response() as unknown as { members: { committed: Array<Record<string, unknown>> } }
      candidate.members.committed[0]![field] = malformed
      expect(decodeOpenCodeLaunchAttemptResponse(candidate)).toEqual({
        ok: false,
        error: { code: 'invalid_field', field: `members.committed.0.${field}` },
      })
    }
  })

  test('rejects the unpublished prompt/assistant linkage instead of treating it as an alias', () => {
    const candidate = response() as unknown as { members: { committed: Array<Record<string, unknown>> } }
    const linkage = candidate.members.committed[0]!
    linkage.promptMessageIdentity = linkage.bootstrapMessageIdentity
    linkage.assistantMessageIdentity = identity('9')
    delete linkage.bootstrapMessageIdentity
    delete linkage.commitIdentity
    expect(decodeOpenCodeLaunchAttemptResponse(candidate)).toEqual({
      ok: false,
      error: { code: 'invalid_field', field: 'members.committed.0.bootstrapMessageIdentity' },
    })
  })

  test('rejects identity replay within and across committed linkages and outcome partitions', () => {
    const within = response()
    within.members.committed[0]!.commitIdentity = within.members.committed[0]!.bootstrapMessageIdentity
    expect(decodeOpenCodeLaunchAttemptResponse(within)).toMatchObject({
      ok: false,
      error: { field: 'members.committed.0.commitIdentity' },
    })

    const across = response()
    across.members.committed.push({
      memberIdentity: identity('0'),
      sessionIdentity: identity('a'),
      bootstrapMessageIdentity: identity('2'),
      commitIdentity: identity('3'),
    })
    expect(decodeOpenCodeLaunchAttemptResponse(across)).toMatchObject({
      ok: false,
      error: { field: 'members.committed.1.sessionIdentity' },
    })

    const wrongPartition = response()
    wrongPartition.members.pending[0] = wrongPartition.members.committed[0]!.sessionIdentity
    expect(decodeOpenCodeLaunchAttemptResponse(wrongPartition)).toMatchObject({
      ok: false,
      error: { field: 'members.pending' },
    })

    const wrongCleanupLinkage = response()
    wrongCleanupLinkage.members.cleanupPending[0] = wrongCleanupLinkage.members.committed[0]!.commitIdentity
    expect(decodeOpenCodeLaunchAttemptResponse(wrongCleanupLinkage)).toMatchObject({
      ok: false,
      error: { field: 'members.cleanupPending' },
    })
  })
})

describe('OpenCodeBridgeContractV2 opaque identities and leakage', () => {
  test('builds and validates only tagged canonical hashes', () => {
    expect(buildOpenCodeOpaqueIdentity(payloadHash)).toBe(`sha256:${payloadHash}`)
    expect(isOpenCodeOpaqueIdentity(`sha256:${payloadHash}`)).toBe(true)
    for (const unsafe of [payloadHash, `sha256:${'A'.repeat(64)}`, 'bearer-secret', 'https://private.invalid']) {
      expect(isOpenCodeOpaqueIdentity(unsafe)).toBe(false)
    }
    expect(() => buildOpenCodeOpaqueIdentity('https://private.invalid')).toThrow(TypeError)
  })

  test('credentials and endpoints are rejected from every allowed response string slot', () => {
    const setters: Array<(value: OpenCodeLaunchAttemptResponse, secret: string) => void> = [
      (v, s) => { v.launchAttempt.attemptId = s },
      (v, s) => { (v.launchAttempt as unknown as { idempotencyKey: string }).idempotencyKey = s },
      (v, s) => { v.launchAttempt.payloadHash = s },
      (v, s) => { (v.launchAttempt as unknown as { outcome: string }).outcome = s },
      (v, s) => { (v.launchAttempt as unknown as { phase: string }).phase = s },
      (v, s) => { v.launchAttempt.providerId = s },
      (v, s) => { v.launchAttempt.modelId = s },
      (v, s) => { v.launchAttempt.profilePurpose = s },
      (v, s) => { v.launchAttempt.profileIdentity = s as never },
      (v, s) => { v.launchAttempt.pluginPolicyIdentity = s as never },
      (v, s) => { v.launchAttempt.cacheIdentity = s as never },
      (v, s) => { v.launchAttempt.binaryIdentity = s as never },
      (v, s) => { v.launchAttempt.retainedHostIdentity.hostKeyIdentity = s as never },
      (v, s) => { v.launchAttempt.retainedHostIdentity.profileScopeIdentity = s as never },
      (v, s) => { v.proof!.attemptId = s },
      (v, s) => { v.proof!.parent.sessionIdentity = s as never },
      (v, s) => { v.proof!.parent.messageIdentity = s as never },
      (v, s) => { v.proof!.providerId = s },
      (v, s) => { v.proof!.modelId = s },
      (v, s) => { v.proof!.retainedHostIdentity.hostKeyIdentity = s as never },
      (v, s) => { v.proof!.retainedHostIdentity.profileScopeIdentity = s as never },
      (v, s) => { v.proof!.observedMcpTools = [s] },
      (v, s) => { v.proof!.nonceHash = s },
      (v, s) => { v.proof!.sessionIdentity = s as never },
      (v, s) => { v.proof!.promptMessageIdentity = s as never },
      (v, s) => { v.proof!.assistantMessageIdentity = s as never },
      (v, s) => { (v.proof as unknown as { authorizationSource: string }).authorizationSource = s },
      (v, s) => { v.members.committed[0]!.memberIdentity = s as never },
      (v, s) => { v.members.committed[0]!.sessionIdentity = s as never },
      (v, s) => { v.members.committed[0]!.bootstrapMessageIdentity = s as never },
      (v, s) => { v.members.committed[0]!.commitIdentity = s as never },
      (v, s) => { v.members.failed[0]!.memberIdentity = s as never },
      (v, s) => { (v.members.failed[0]!.failure as unknown as { code: string }).code = s },
      (v, s) => { (v.members.failed[0]!.failure as unknown as { origin: string }).origin = s },
      (v, s) => { (v.members.failed[0]!.failure as unknown as { retryDisposition: string }).retryDisposition = s },
      (v, s) => { (v.members.failed[0]!.failure as unknown as { phase: string }).phase = s },
      (v, s) => { (v.members.failed[0]!.failure as unknown as { exhaustionScope: string }).exhaustionScope = s },
      (v, s) => { v.members.pending[0] = s as never },
      (v, s) => { v.members.cleanupPending[0] = s as never },
      (v, s) => { v.members.continuationToken = s },
    ]
    for (const secret of ['bearer-secret-value', 'https://user:password@private.invalid/v1']) {
      for (const [index, set] of setters.entries()) {
        const candidate = response()
        set(candidate, secret)
        const decoded = decodeOpenCodeLaunchAttemptResponse(candidate)
        if (decoded.ok) throw new Error(`leakage setter ${index} accepted ${secret}`)
      }
    }
  })

  test('whitelist serialization drops unknown credential, endpoint, nonce, and diagnostic slots', () => {
    const unsafe = response() as OpenCodeLaunchAttemptResponse & Record<string, unknown>
    unsafe.credential = 'credential-secret'
    unsafe.endpoint = 'https://private.invalid'
    unsafe.proofNonce = nonce
    unsafe.diagnostics = ['diagnostic-secret']
    ;(unsafe.launchAttempt as typeof unsafe.launchAttempt & Record<string, unknown>).authorization = 'bearer-secret'
    ;(unsafe.proof! as NonNullable<typeof unsafe.proof> & Record<string, unknown>).baseUrl = 'https://proof.invalid'
    ;(unsafe.launchAttempt.retainedHostIdentity as typeof unsafe.launchAttempt.retainedHostIdentity & Record<string, unknown>)
      .credential = 'nested-host-secret'
    ;(unsafe.proof!.retainedHostIdentity as NonNullable<OpenCodeLaunchAttemptResponse['proof']>['retainedHostIdentity'] & Record<string, unknown>)
      .baseUrl = 'https://nested-host.invalid'
    ;(unsafe.members.failed[0]!.failure as typeof unsafe.members.failed[0]['failure'] & Record<string, unknown>)
      .message = 'failure-message-secret'
    const serialized = serializeOpenCodeLaunchAttemptResponse(unsafe)
    for (const secret of [
      'credential-secret', 'https://private.invalid', nonce, 'diagnostic-secret',
      'bearer-secret', 'https://proof.invalid', 'failure-message-secret',
      'nested-host-secret', 'https://nested-host.invalid',
    ]) expect(serialized).not.toContain(secret)
  })

  test('request encoder also strips unknown leakage slots', () => {
    const unsafe = request() as OpenCodeLaunchAttemptRequest & Record<string, unknown>
    unsafe.credential = 'secret'
    ;(unsafe.launchAttempt as typeof unsafe.launchAttempt & Record<string, unknown>).baseUrl = 'https://private.invalid'
    expect(JSON.stringify(encodeOpenCodeLaunchAttemptRequest(unsafe))).not.toContain('secret')
    expect(JSON.stringify(encodeOpenCodeLaunchAttemptRequest(unsafe))).not.toContain('https://private.invalid')
  })
})
