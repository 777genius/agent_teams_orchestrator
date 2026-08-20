import { describe, expect, test } from 'bun:test'

import type {
  OpenCodePassiveObservation,
  OpenCodePassiveProviderStatus,
  OpenCodePassiveStatusV1,
} from './OpenCodePassiveStatusContract.js'
import { isOpenCodeCanonicalProviderId } from './OpenCodePassiveStatusContract.js'
import {
  OPEN_CODE_PASSIVE_DIRECTORY_PROVIDER_IDS,
  readOpenCodePassiveProviderDirectory,
} from './OpenCodePassiveProviderDirectory.js'
import { getOpenCodeCuratedSubscriptionProviderIds } from './OpenCodeCuratedSubscriptionCatalog.js'

const unknown = <T>(value: T): OpenCodePassiveObservation<T> => ({
  value,
  authority: 'none',
  freshness: 'unknown',
  condition: 'degraded',
  observedAt: null,
  validUntil: null,
  issueCode: 'read_timeout',
})

function provider(providerId: string, configured = false): OpenCodePassiveProviderStatus {
  return {
    providerId,
    configured: configured
      ? { value: 'configured', authority: 'config_metadata', freshness: 'fresh', condition: 'normal', observedAt: 900, validUntil: 2_000, issueCode: 'none' }
      : unknown('unknown'),
    lastConnected: unknown({ state: 'unknown' }),
    catalogAvailable: unknown('unknown'),
    executionVerified: unknown('unknown'),
  }
}

function passive(): OpenCodePassiveStatusV1 {
  return {
    contractVersion: 1,
    projectScope: `sha256:${'a'.repeat(64)}`,
    binary: unknown({ presence: 'unknown', version: null }),
    providers: OPEN_CODE_PASSIVE_DIRECTORY_PROVIDER_IDS.map(id => provider(id, id === 'deepinfra')),
    authorization: 'unknown',
    launchReadiness: 'not_authorized',
    completedAt: 1_000,
  }
}

describe('OpenCode passive provider-directory summary route', () => {
  test('covers the complete canonical curated subscription catalog without inventory fanout', () => {
    const curated = getOpenCodeCuratedSubscriptionProviderIds()
    expect(curated).toEqual(expect.arrayContaining([
      'xiaomi-token-plan-ams',
      'minimax-coding-plan',
      'zai-coding-plan',
      'kimi-for-coding',
    ]))
    expect(OPEN_CODE_PASSIVE_DIRECTORY_PROVIDER_IDS).toEqual(expect.arrayContaining(curated))
    expect(curated.every(isOpenCodeCanonicalProviderId)).toBe(true)
    expect(new Set(OPEN_CODE_PASSIVE_DIRECTORY_PROVIDER_IDS).size)
      .toBe(OPEN_CODE_PASSIVE_DIRECTORY_PROVIDER_IDS.length)
  })

  test('derives a redacted bounded view through the passive read seam only', async () => {
    const prohibitedCalls = new Map<string, number>()
    const prohibited = [
      'prepareProfile', 'inventory', 'host', 'lock', 'spawn', 'fetch',
      'provider', 'model', 'agent', 'plugin', 'oauth', 'mkdir', 'write',
      'rename', 'unlink',
    ]
    for (const name of prohibited) prohibitedCalls.set(name, 0)
    let reads = 0
    const directory = await readOpenCodePassiveProviderDirectory({
      projectPath: '/never-returned',
      query: 'deepinfra',
      filter: 'configured',
      limit: 5,
      timeoutMs: 17,
    }, async request => {
      reads += 1
      expect(request).toMatchObject({
        projectPath: '/never-returned',
        providerIds: OPEN_CODE_PASSIVE_DIRECTORY_PROVIDER_IDS,
        timeoutMs: 17,
      })
      expect(request.signal).toBeInstanceOf(AbortSignal)
      return passive()
    })

    expect(reads).toBe(1)
    expect([...prohibitedCalls.values()]).toEqual(prohibited.map(() => 0))
    expect(directory.entries.map(entry => entry.providerId)).toEqual(['deepinfra'])
    expect(directory.entries[0]?.state).toBe('not-connected')
    expect(directory.entries[0]?.actions.every(action => !action.enabled)).toBe(true)
    expect(JSON.stringify(directory)).not.toContain('/never-returned')
  })

  test('keeps unknown observations non-connected and pagination deterministic', async () => {
    const directory = await readOpenCodePassiveProviderDirectory({
      projectPath: '/opaque',
      limit: 2,
      cursor: '1',
    }, async () => passive())
    expect(directory.totalCount).toBe(OPEN_CODE_PASSIVE_DIRECTORY_PROVIDER_IDS.length)
    expect(directory.returnedCount).toBe(2)
    expect(directory.entries.map(entry => entry.providerId)).toEqual(['anthropic', 'azure'])
    expect(directory.nextCursor).toBe('3')
    expect(directory.entries.every(entry => entry.state !== 'connected')).toBe(true)
  })

  test('route deadline bounds a never-resolving injected reader with a passive fallback', async () => {
    let fireDeadline!: () => void
    let cancelled = 0
    let signal: AbortSignal | undefined
    const pending = readOpenCodePassiveProviderDirectory({
      projectPath: '/fake-project',
      timeoutMs: 23,
      query: 'deepinfra',
    }, async input => {
      signal = input.signal
      return new Promise<OpenCodePassiveStatusV1>(() => {})
    }, {
      now: () => 1_000,
      schedule: (callback, delayMs) => {
        expect(delayMs).toBe(23)
        fireDeadline = callback
        return { cancel: () => { cancelled += 1 } }
      },
    })
    await Promise.resolve()
    fireDeadline()
    const directory = await pending
    expect(signal?.aborted).toBe(true)
    expect(cancelled).toBe(1)
    expect(directory.entries.map(entry => entry.providerId)).toEqual(['deepinfra'])
    expect(directory.entries[0]).toMatchObject({ state: 'available', modelCount: null })
    expect(directory.diagnostics).toEqual(['passive_scope_unavailable'])
  })
})
