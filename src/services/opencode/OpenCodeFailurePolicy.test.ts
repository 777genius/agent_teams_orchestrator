import { describe, expect, test } from 'bun:test'

import {
  OPEN_CODE_LAUNCH_FAILURE_KINDS,
  OPEN_CODE_LAUNCH_FAILURE_POLICY,
  OPEN_CODE_MAX_RETRY_AFTER_MS,
  OPEN_CODE_PROVIDER_FAILURE_MESSAGES,
  classifyOpenCodeLaunchFailure,
  classifyOpenCodeProviderFailure,
  createOpenCodeContractViolationFailure,
} from './OpenCodeFailurePolicy.js'
import {
  OPEN_CODE_LAUNCH_FAILURE_POLICY as COMPATIBILITY_POLICY,
  OPEN_CODE_LAUNCH_RETRY_DISPOSITIONS as COMPATIBILITY_DISPOSITIONS,
  classifyOpenCodeLaunchFailure as compatibilityClassifier,
} from './OpenCodeLaunchAttemptPolicy.js'
import { OPEN_CODE_LAUNCH_RETRY_DISPOSITIONS } from './OpenCodeFailurePolicy.js'

describe('OpenCode shared failure policy', () => {
  test('has one exhaustive frozen table and compatibility exports preserve object identity', () => {
    expect(COMPATIBILITY_POLICY).toBe(OPEN_CODE_LAUNCH_FAILURE_POLICY)
    expect(COMPATIBILITY_DISPOSITIONS).toBe(OPEN_CODE_LAUNCH_RETRY_DISPOSITIONS)
    expect(Object.keys(OPEN_CODE_LAUNCH_FAILURE_POLICY).sort()).toEqual(
      [...OPEN_CODE_LAUNCH_FAILURE_KINDS].sort(),
    )
    for (const code of OPEN_CODE_LAUNCH_FAILURE_KINDS) {
      expect(compatibilityClassifier(code)).toEqual({
        kind: code,
        ...OPEN_CODE_LAUNCH_FAILURE_POLICY[code],
      })
      expect(Object.isFrozen(OPEN_CODE_LAUNCH_FAILURE_POLICY[code])).toBe(true)
    }
  })

  test.each([
    [{ providerCode: 'RESOURCE_EXHAUSTED', message: 'quota reached', status: 429 }, 'quota_exhausted'],
    [{ message: 'subscription limit exceeded; retry-after later', status: 429 }, 'quota_exhausted'],
    [{ message: 'balance depleted', status: 401 }, 'quota_exhausted'],
    [{ status: 429 }, 'rate_limited'],
    [{ message: 'rate_limit', status: 401 }, 'rate_limited'],
    [{ retryAfterMs: 10 }, 'rate_limited'],
    [{ status: 401 }, 'authentication_required'],
    [{ message: 'credential revoked' }, 'authentication_required'],
    [{ message: 'login required' }, 'authentication_required'],
    [{ message: 'organization policy denial' }, 'provider_plan_denied'],
    [{ message: 'model plan required' }, 'provider_plan_denied'],
    [{ status: 403 }, 'external_dependency'],
    [{ networkFailure: true }, 'pre_side_effect_transport'],
    [{ networkFailure: true, oauthOrExternalEffectStarted: true }, 'unknown_transport_after_side_effect'],
    [{ deadlineExceeded: true }, 'deadline_before_partial'],
    [{ deadlineExceeded: true, partialResult: true }, 'deadline_after_partial'],
    [{ cancelled: true, status: 429 }, 'cancelled'],
    [{ contractViolation: true, message: 'quota exceeded' }, 'contract_violation'],
  ] as const)('applies classification precedence for %#', (hints, expected) => {
    expect(classifyOpenCodeProviderFailure({
      operation: 'provider-catalog',
      ...hints,
    }).code).toBe(expected)
  })

  test('emits fixed phases and policy fields without credential deletion semantics', () => {
    for (const operation of ['provider-catalog', 'provider-connect', 'execution-probe'] as const) {
      const failure = classifyOpenCodeProviderFailure({ operation, status: 401 })
      expect(failure).toMatchObject({
        code: 'authentication_required',
        operation,
        origin: 'provider',
        retryDisposition: 'user_action',
        retryable: true,
        sideEffectsStarted: false,
        retryAfterMs: null,
      })
      expect(failure.phase).toBe({
        'provider-catalog': 'catalog-read',
        'provider-connect': 'provider-connect',
        'execution-probe': 'execution-probe',
      }[operation])
      expect(JSON.stringify(failure)).not.toMatch(/delete|remove|clear|credential/i)
    }
  })

  test('uses only fixed messages and redacts the complete unsafe corpus', () => {
    const unsafe = [
      'Bearer top-secret',
      'https://user:pass@example.invalid/path?token=secret#fragment',
      'authorization: abc123',
      '{"headers":{"cookie":"secret"}}',
      '{"env":{"API_KEY":"secret"}}',
      '{"options":{"password":"secret"}}',
      '{"cost":{"input":999}}',
    ].join(' ')
    for (const codeInput of [
      { message: unsafe, networkFailure: true },
      { message: `quota exhausted ${unsafe}` },
      { message: `login required ${unsafe}` },
    ]) {
      const failure = classifyOpenCodeProviderFailure({
        operation: 'provider-connect',
        ...codeInput,
      })
      expect(failure.message).toBe(OPEN_CODE_PROVIDER_FAILURE_MESSAGES[failure.code])
      const serialized = JSON.stringify(failure)
      for (const token of ['top-secret', 'example.invalid', 'abc123', 'API_KEY', 'password', '999']) {
        expect(serialized).not.toContain(token)
      }
      expect(Object.keys(failure).sort()).toEqual([
        'code', 'message', 'operation', 'origin', 'phase', 'retryAfterMs',
        'retryDisposition', 'retryable', 'sideEffectsStarted',
      ].sort())
    }
  })

  test.each([
    [-1, null], [Number.NaN, null], [Number.POSITIVE_INFINITY, null],
    [1.9, 1], [5000, 5000], [OPEN_CODE_MAX_RETRY_AFTER_MS + 1, OPEN_CODE_MAX_RETRY_AFTER_MS],
  ])('bounds retryAfterMs %p to %p', (input, expected) => {
    expect(classifyOpenCodeProviderFailure({
      operation: 'provider-catalog',
      status: 429,
      retryAfterMs: input,
    }).retryAfterMs).toBe(expected)
  })

  test('launch classification accepts only own enumerated policy keys and freezes the complete tuple', () => {
    for (const kind of OPEN_CODE_LAUNCH_FAILURE_KINDS) {
      const classified = classifyOpenCodeLaunchFailure(kind)
      expect(classified).toEqual({ kind, ...OPEN_CODE_LAUNCH_FAILURE_POLICY[kind] })
      expect(Object.keys(classified).sort()).toEqual([
        'kind', 'retryDisposition', 'retryable', 'sideEffectsStarted',
      ].sort())
      expect(Object.isFrozen(classified)).toBe(true)
    }
    for (const kind of ['constructor', 'prototype', '__proto__', 'unknown']) {
      expect(() => classifyOpenCodeLaunchFailure(kind as never))
        .toThrow('Invalid OpenCode launch failure kind')
      expect(() => compatibilityClassifier(kind as never))
        .toThrow('Invalid OpenCode launch failure kind')
    }
  })

  test('provider classification snapshots one inert own-data record and fails unsafe inputs fixed', () => {
    let getterReads = 0
    const accessor = { status: 429 } as Record<string, unknown>
    Object.defineProperty(accessor, 'operation', {
      enumerable: true,
      get: () => (++getterReads === 1 ? 'provider-catalog' : 'execution-probe'),
    })
    const inherited = Object.create({ operation: 'provider-catalog' })
    inherited.status = 429
    const symbolic = { operation: 'provider-catalog', [Symbol('secret')]: 'secret' }
    const dangerous = Object.create(null) as Record<string, unknown>
    dangerous.operation = 'provider-catalog'
    Object.defineProperty(dangerous, 'constructor', { enumerable: true, value: 'secret' })
    let proxyReads = 0
    const proxy = new Proxy({ operation: 'provider-catalog', status: 429 }, {
      get: () => { proxyReads += 1; throw new Error('attacker-secret') },
      getPrototypeOf: () => { proxyReads += 1; throw new Error('attacker-secret') },
    })

    for (const input of [accessor, inherited, symbolic, dangerous, proxy]) {
      let caught: unknown
      try { classifyOpenCodeProviderFailure(input as never) } catch (error) { caught = error }
      expect(caught).toBeInstanceOf(TypeError)
      expect((caught as Error).message).toBe('Invalid OpenCode provider operation')
      expect(String(caught)).not.toContain('attacker-secret')
    }
    expect(getterReads).toBe(0)
    expect(proxyReads).toBe(0)

    const hostileOperation = new Proxy({}, {
      get: () => { throw new Error('operation-secret') },
    })
    expect(() => createOpenCodeContractViolationFailure(hostileOperation as never))
      .toThrow('Invalid OpenCode provider operation')
  })
})
