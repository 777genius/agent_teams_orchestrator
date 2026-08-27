import { describe, expect, test } from 'bun:test'

import {
  decodeStrictOpenCodeProductionLaunch,
  OpenCodeLaunchRoutingError,
} from './OpenCodeLaunchProductionRouting.js'

const identity = (character: string) => `sha256:${character.repeat(64)}` as const
const body = () => ({
  launchAttempt: {
    attemptId: '018f47a2-4a13-7c2f-8d44-c0ffee123456', payloadHash: 'a'.repeat(64),
    generation: 1, proofNonce: 'A'.repeat(43),
    parent: { sessionIdentity: identity('b'), messageIdentity: identity('c') },
    providerId: 'openrouter', modelId: 'openrouter/model',
    requiredMcpTools: ['agent-teams.message_send'], requireFreshRetainedHostProof: true,
  },
})

describe('OpenCode production launch routing', () => {
  test('normalizes an absent optional version only for a complete strict attempt', () => {
    expect(decodeStrictOpenCodeProductionLaunch(body()).launchContractVersion).toBe(1)
    for (const invalid of [{}, { launchAttempt: null }, { launchAttempt: {} }]) {
      expect(() => decodeStrictOpenCodeProductionLaunch(invalid)).toThrow(OpenCodeLaunchRoutingError)
    }
  })

  test('returns typed unsupported and not-authorized failures', () => {
    expect(() => decodeStrictOpenCodeProductionLaunch({ ...body(), launchContractVersion: 99 }))
      .toThrow(expect.objectContaining({ code: 'unsupported' }))
    expect(() => decodeStrictOpenCodeProductionLaunch({}))
      .toThrow(expect.objectContaining({ code: 'not_authorized' }))
  })

  test('rejects proxies and accessors without evaluating launch fields', () => {
    let reads = 0
    const accessor: Record<string, unknown> = {}
    Object.defineProperty(accessor, 'launchAttempt', {
      enumerable: true,
      get: () => { reads += 1; return body().launchAttempt },
    })
    expect(() => decodeStrictOpenCodeProductionLaunch(accessor)).toThrow(OpenCodeLaunchRoutingError)
    expect(() => decodeStrictOpenCodeProductionLaunch(new Proxy(body(), {}))).toThrow(OpenCodeLaunchRoutingError)
    expect(reads).toBe(0)
  })
})
