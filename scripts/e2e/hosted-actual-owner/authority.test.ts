import { createHmac } from 'node:crypto'
import { describe, expect, test } from 'bun:test'

import { AcceptanceEffectAuthority, acceptanceCapabilityPurpose, acceptanceCaptureFields,
  authenticateCapabilityEnvelope, combineEffectAuthorities } from './authority.js'

const ownerToken = 'owner-token'
const nonce = '1'.repeat(64)
const route = Object.freeze({
  routeId: 'route_test', sessionId: 'session_test', routeRunId: `run_${'2'.repeat(32)}`,
  generation: 'generation_test',
})
const config = {
  ownerToken, runtimeManifestSha256: '3'.repeat(64),
  productContract: { sha256: '4'.repeat(64) },
  runtime: {
    runId: '5'.repeat(48), ownerBinding: { ownerSessionId: `session_${'5'.repeat(48)}` },
    socketIdentity: {
      driverSocket: { endpoint: '127.0.0.1:41001', device: '1', inode: '10' },
      productSocket: { endpoint: '127.0.0.1:41002', device: '1', inode: '11' },
    },
  },
} as never
const admission = { routes: [{
  routeId: route.routeId,
  authority: { sessionId: route.sessionId, runId: route.routeRunId },
  scope: { authorityGeneration: route.generation },
}] }

function captures() {
  return Object.fromEntries(acceptanceCaptureFields.map((field, index) => [field, {
    path: `/sandbox/capture/${field}`, parentDevice: '1', parentInode: String(20 + index),
  }]))
}

function signed(overrides: Record<string, unknown> = {}) {
  const unsigned = {
    schemaVersion: 1, purpose: acceptanceCapabilityPurpose, nonce,
    harnessRunId: '5'.repeat(48), ownerSessionId: `session_${'5'.repeat(48)}`,
    contractSha256: '4'.repeat(64), runtimeManifestSha256: '3'.repeat(64),
    driverSocket: { endpoint: '127.0.0.1:41001', device: '1', inode: '10' },
    productSocket: { endpoint: '127.0.0.1:41002', device: '1', inode: '11' },
    routes: [route], captures: captures(), ...overrides,
  }
  return {
    ...unsigned,
    hmacSha256: createHmac('sha256', ownerToken).update(JSON.stringify(unsigned)).digest('hex'),
  }
}

describe('hosted actual-owner effect authority', () => {
  test('consumes adapter and acceptance authorities once at the same final edge', () => {
    const consumed: string[] = []
    const composite = combineEffectAuthorities(
      { consume: () => { consumed.push('adapter'); return false } },
      { consume: () => { consumed.push('acceptance'); return true } },
    )
    expect(composite.consume()).toBe(false)
    expect(consumed).toEqual(['adapter', 'acceptance'])
    expect(composite.consume()).toBe(false)
    expect(consumed).toEqual(['adapter', 'acceptance'])

    const cleanup: string[] = []
    const failing = combineEffectAuthorities(
      { consume: () => { cleanup.push('adapter'); throw new Error('adapter rotated') } },
      { consume: () => { cleanup.push('acceptance'); return true } },
    )
    expect(() => failing.consume()).toThrow('adapter rotated')
    expect(cleanup).toEqual(['adapter', 'acceptance'])
    expect(failing.consume()).toBe(false)
  })

  test('authenticates the exact session, sockets, routes, and seven capture namespaces', () => {
    const result = authenticateCapabilityEnvelope(signed(), config, admission as never, nonce)
    expect([...result.routes.values()]).toEqual([route])
    expect(Object.keys(result.captures).sort()).toEqual([...acceptanceCaptureFields].sort())
    const second = { ...route, routeId: 'route_second', sessionId: 'session_second' }
    const multiple = authenticateCapabilityEnvelope(signed({ routes: [route, second] }), config, {
      routes: [...admission.routes, {
        routeId: second.routeId,
        authority: { sessionId: second.sessionId, runId: second.routeRunId },
        scope: { authorityGeneration: second.generation },
      }],
    } as never, nonce)
    expect([...multiple.routes.keys()]).toEqual(['route_test', 'route_second'])
  })

  test('rejects replay, extension, socket rotation, and route substitution', () => {
    expect(() => authenticateCapabilityEnvelope(signed(), config, admission as never, '6'.repeat(64)))
      .toThrow(/capability_binding_invalid/)
    expect(() => authenticateCapabilityEnvelope({ ...signed(), extra: true }, config, admission as never, nonce))
      .toThrow(/capability_invalid/)
    expect(() => authenticateCapabilityEnvelope(signed({
      driverSocket: { endpoint: '127.0.0.1:41001', device: '1', inode: '99' },
    }), config, admission as never, nonce)).toThrow(/capability_binding_invalid/)
    expect(() => authenticateCapabilityEnvelope(signed({ routes: [{
      ...route, routeRunId: `run_${'7'.repeat(32)}`,
    }] }), config, admission as never, nonce)).toThrow(/capability_routes_invalid/)
  })

  test('makes the synchronous post-preparation effect-edge authority single-use and fail-closed', () => {
    let checks = 0
    const authority = { assertCurrentAtEffectEdge: (expected: typeof route) => {
      checks += 1
      if (expected.generation !== route.generation) throw new Error('hosted_actual_owner_effect_authority_invalid')
    } } as never
    const token = new AcceptanceEffectAuthority(authority, route)
    expect(token.consume()).toBe(true)
    expect(checks).toBe(1)
    expect(() => token.consume()).toThrow(/effect_authority_invalid/)
    expect(() => new AcceptanceEffectAuthority(authority, {
      ...route, generation: 'generation_rotated',
    }).consume()).toThrow(/effect_authority_invalid/)
  })
})
