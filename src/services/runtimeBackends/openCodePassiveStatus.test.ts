import { describe, expect, test } from 'bun:test'

import type {
  OpenCodePassiveObservation,
  OpenCodePassiveProviderStatus,
  OpenCodePassiveStatusV1,
} from '../opencode/OpenCodePassiveStatusContract.js'
import { buildOpenCodePassiveRuntimeStatus } from './openCodePassiveStatus.js'

const observation = <T>(
  value: T,
  authority: OpenCodePassiveObservation<T>['authority'],
  freshness: OpenCodePassiveObservation<T>['freshness'] = 'fresh',
): OpenCodePassiveObservation<T> => ({
  value,
  authority,
  freshness,
  condition: freshness === 'fresh' ? 'normal' : 'degraded',
  observedAt: authority === 'none' ? null : 900,
  validUntil: authority === 'none' ? null : freshness === 'fresh' ? 2_000 : 950,
  issueCode: freshness === 'fresh' ? 'none' : 'read_timeout',
})

function provider(
  providerId: string,
  values: Partial<{
    configured: 'configured' | 'not_configured' | 'unknown'
    connected: 'connected' | 'not_connected' | 'unknown'
    catalog: 'available' | 'unavailable' | 'unknown'
    execution: 'verified' | 'rejected' | 'unknown'
    freshness: 'fresh' | 'stale'
  }> = {},
): OpenCodePassiveProviderStatus {
  const freshness = values.freshness ?? 'fresh'
  return {
    providerId,
    configured: observation(values.configured ?? 'unknown', values.configured ? 'config_metadata' : 'none', freshness),
    lastConnected: observation(
      values.connected === 'connected' ? { state: 'connected', at: 800 } : { state: values.connected ?? 'unknown' },
      values.connected ? 'auth_metadata' : 'none',
      freshness,
    ),
    catalogAvailable: observation(values.catalog ?? 'unknown', values.catalog ? 'catalog_snapshot' : 'none', freshness),
    executionVerified: observation(values.execution ?? 'unknown', values.execution ? 'execution_snapshot' : 'none', freshness),
  }
}

function passive(providers: OpenCodePassiveProviderStatus[]): OpenCodePassiveStatusV1 {
  return {
    contractVersion: 1,
    projectScope: `sha256:${'a'.repeat(64)}`,
    binary: observation({ presence: 'present', version: '1.2.3' }, 'binary_metadata'),
    providers,
    authorization: 'unknown',
    launchReadiness: 'not_authorized',
    completedAt: 1_000,
  }
}

describe('OpenCode passive runtime summary wiring', () => {
  test('Moth/profile/inventory/verbose hangs are outside the dependency surface', async () => {
    let passiveCalls = 0
    const forbidden = new Proxy({}, {
      get: (_target, property) => { throw new Error(`forbidden call: ${String(property)}`) },
    })
    void forbidden
    const status = await buildOpenCodePassiveRuntimeStatus({
      openCodeProjectPath: '/project',
      getOpenCodePassiveStatus: async input => {
        passiveCalls += 1
        expect(input.projectPath).toBe('/project')
        expect(input.providerIds).toContain('deepinfra')
        expect(input.providerIds).toContain('kiro')
        expect(input.providerIds).toContain('cursor-acp')
        return passive([
          provider('kiro'),
          provider('cursor-acp'),
          provider('deepinfra', {
            configured: 'configured', connected: 'connected', catalog: 'available', execution: 'verified',
          }),
        ])
      },
    })

    expect(passiveCalls).toBe(1)
    expect(status.supported).toBe(true)
    expect(status.authenticated).toBe(false)
    expect(status.capabilities.teamLaunch).toBe(false)
    expect(status.models).toEqual([])
    expect(status.detailMessage).toContain('configured=1')
    expect(status.detailMessage).toContain('last_connected=1')
    expect(status.detailMessage).toContain('catalog_available=1')
    expect(status.detailMessage).toContain('execution_verified=1')
    expect(status.passiveStatus?.authorization).toBe('unknown')
    expect(status.passiveStatus?.launchReadiness).toBe('not_authorized')
  })

  test('timeout retains previous exact-scope display evidence as stale without granting auth or launch', async () => {
    const status = await buildOpenCodePassiveRuntimeStatus({
      getOpenCodePassiveStatus: async () => passive([
        provider('deepinfra', {
          configured: 'configured', connected: 'connected', catalog: 'available', execution: 'verified', freshness: 'stale',
        }),
      ]),
    })
    expect(status.statusMessage).toBe('OpenCode passive status is degraded')
    expect(status.detailMessage).toContain('last_connected=1')
    expect(status.authenticated).toBe(false)
    expect(status.authMethod).toBeNull()
    expect(status.capabilities.teamLaunch).toBe(false)
    expect(status.verificationState).toBe('unknown')
  })

  test('missing evidence remains unknown and never becomes available, authenticated or launch-ready', async () => {
    const unknown = passive([provider('deepinfra')])
    unknown.binary = observation({ presence: 'unknown', version: null }, 'none', 'stale')
    const status = await buildOpenCodePassiveRuntimeStatus({ getOpenCodePassiveStatus: async () => unknown })
    expect(status.supported).toBe(false)
    expect(status.authenticated).toBe(false)
    expect(status.capabilities.teamLaunch).toBe(false)
    expect(status.backend).toBeNull()
    expect(status.verificationState).toBe('unknown')
  })

  test('legacy Windows payload without passive snapshot fields remains unknown and never launch-ready', async () => {
    const legacyWindowsPayload = {
      supported: true,
      authenticated: true,
      capabilities: { teamLaunch: true },
    }
    const status = await buildOpenCodePassiveRuntimeStatus({
      getOpenCodePassiveStatus: async () => {
        // The legacy transport shape has no passive snapshot contract fields;
        // the boundary rejects it instead of translating optimistic booleans.
        throw Object.assign(new Error('legacy payload missing passive snapshot fields'), {
          payload: legacyWindowsPayload,
        })
      },
      now: () => 1_000,
      schedule: () => ({ cancel() {} }),
    })
    expect(status).toMatchObject({
      supported: false,
      authenticated: false,
      verificationState: 'unknown',
      capabilities: { teamLaunch: false },
      passiveStatus: {
        projectScope: null,
        authorization: 'unknown',
        launchReadiness: 'not_authorized',
      },
    })
    expect(status.passiveStatus?.binary).toMatchObject({
      value: { presence: 'unknown' }, authority: 'none', issueCode: 'read_failed',
    })
  })

  test('route deadline bounds a never-resolving injected passive reader and aborts it', async () => {
    let fireDeadline!: () => void
    let rejectLate!: (error: Error) => void
    let cancelled = 0
    let signal: AbortSignal | undefined
    const delayed = new Promise<OpenCodePassiveStatusV1>((_resolve, reject) => { rejectLate = reject })
    const pending = buildOpenCodePassiveRuntimeStatus({
      openCodeProjectPath: '/fake-project',
      openCodePassiveStatusTimeoutMs: 19,
      now: () => 1_000,
      schedule: (callback, delayMs) => {
        expect(delayMs).toBe(19)
        fireDeadline = callback
        return { cancel: () => { cancelled += 1 } }
      },
      getOpenCodePassiveStatus: async input => {
        signal = input.signal
        return delayed
      },
    })
    await Promise.resolve()
    fireDeadline()
    const status = await pending
    expect(signal?.aborted).toBe(true)
    expect(cancelled).toBe(1)
    expect(status).toMatchObject({
      supported: false,
      authenticated: false,
      verificationState: 'unknown',
      capabilities: { teamLaunch: false },
      passiveStatus: { projectScope: null, authorization: 'unknown', launchReadiness: 'not_authorized' },
    })
    expect(status.passiveStatus?.binary.issueCode).toBe('read_timeout')
    const returned = JSON.stringify(status)
    rejectLate(new Error('late reader rejection'))
    await Promise.resolve()
    await Promise.resolve()
    expect(JSON.stringify(status)).toBe(returned)
  })
})
