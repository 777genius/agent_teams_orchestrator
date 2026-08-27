import { describe, expect, test } from 'bun:test'

import type {
  OpenCodePassiveObservation,
  OpenCodePassiveProviderStatus,
  OpenCodePassiveStatusV1,
} from './OpenCodePassiveStatusContract.js'
import { isOpenCodeCanonicalProviderId } from './OpenCodePassiveStatusContract.js'
import {
  buildOpenCodePassiveProviderDirectory,
  OPEN_CODE_PASSIVE_DIRECTORY_PROVIDER_IDS,
  readOpenCodePassiveProviderDirectory,
} from './OpenCodePassiveProviderDirectory.js'
import { getOpenCodeCuratedSubscriptionProviderIds } from './OpenCodeCuratedSubscriptionCatalog.js'
import type { OpenCodePassiveRouteRead } from './OpenCodePassiveRouteDeadline.js'

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

const fact = <T>(
  value: T,
  authority: OpenCodePassiveObservation<T>['authority'],
  freshness: OpenCodePassiveObservation<T>['freshness'] = 'fresh',
): OpenCodePassiveObservation<T> => ({
  value,
  authority,
  freshness,
  condition: freshness === 'stale' ? 'degraded' : 'normal',
  observedAt: 900,
  validUntil: freshness === 'stale' ? 950 : 2_000,
  issueCode: freshness === 'stale' ? 'expired' : 'none',
})

function status(providers: OpenCodePassiveProviderStatus[]): OpenCodePassiveStatusV1 {
  return { ...passive(), providers }
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

  test('filters configured evidence independently from authentication state', () => {
    const authOnly = provider('anthropic')
    authOnly.configured = fact('not_configured', 'config_metadata')
    authOnly.lastConnected = fact({ state: 'connected', at: 800 }, 'auth_metadata')
    const configuredDisconnected = provider('deepinfra', true)
    configuredDisconnected.lastConnected = fact({ state: 'not_connected' }, 'auth_metadata')
    const legacyUnknown = provider('openai')
    legacyUnknown.lastConnected = fact({ state: 'connected', at: 800 }, 'auth_metadata')

    const directory = buildOpenCodePassiveProviderDirectory(
      status([authOnly, configuredDisconnected, legacyUnknown]),
      { filter: 'configured' },
    )

    expect(directory.entries.map(entry => entry.providerId)).toEqual(['deepinfra'])
    expect(directory.entries[0]).toMatchObject({
      state: 'not-connected',
      metadata: { configuredEvidence: 'configured' },
    })
    const all = buildOpenCodePassiveProviderDirectory(status([authOnly, legacyUnknown]))
    expect(all.entries.map(entry => [entry.providerId, entry.state, entry.metadata.configuredEvidence])).toEqual([
      ['anthropic', 'connected', 'not_configured'],
      ['openai', 'connected', 'unknown'],
    ])
  })

  test('queries provider labels and exact, partial, case-normalized known model ids', () => {
    const deepinfra = provider('deepinfra')
    deepinfra.catalogAvailable = fact('available', 'catalog_snapshot')
    deepinfra.knownModelIds = ['deepinfra/meta-llama-4', 'deepinfra/qwen-2.5-coder']
    deepinfra.knownModelIdsTotal = 2
    deepinfra.knownModelIdsTruncated = false
    const view = status([deepinfra, provider('amazon-bedrock')])

    expect(buildOpenCodePassiveProviderDirectory(view, { query: 'DEEPINFRA/META-LLAMA-4' }).entries.map(e => e.providerId)).toEqual(['deepinfra'])
    expect(buildOpenCodePassiveProviderDirectory(view, { query: 'QwEn-2.5' }).entries.map(e => e.providerId)).toEqual(['deepinfra'])
    expect(buildOpenCodePassiveProviderDirectory(view, { query: 'deepINFRA' }).entries.map(e => e.providerId)).toEqual(['deepinfra'])
    expect(buildOpenCodePassiveProviderDirectory(view, { query: 'Amazon Bedrock' }).entries.map(e => e.providerId)).toEqual(['amazon-bedrock'])
  })

  test('searches stale catalog ids without granting configuration or launch authority', () => {
    const stale = provider('deepinfra')
    stale.configured = fact('not_configured', 'config_metadata')
    stale.catalogAvailable = fact('available', 'catalog_snapshot', 'stale')
    stale.knownModelIds = ['deepinfra/stale-model']
    stale.knownModelIdsTotal = 1
    stale.knownModelIdsTruncated = false

    const directory = buildOpenCodePassiveProviderDirectory(status([stale]), { query: 'stale-model' })
    expect(directory.entries).toHaveLength(1)
    expect(directory.entries[0]).toMatchObject({
      state: 'available',
      metadata: { configuredEvidence: 'not_configured', knownModelIds: ['deepinfra/stale-model'] },
    })
    expect(directory.entries[0]?.actions.every(action => !action.enabled)).toBe(true)
    expect(buildOpenCodePassiveProviderDirectory(status([stale]), { filter: 'configured' }).entries).toEqual([])
  })

  test('bounds and deduplicates projected ids while preserving truncation metadata', () => {
    const deepinfra = provider('deepinfra')
    deepinfra.catalogAvailable = fact('available', 'catalog_snapshot')
    deepinfra.knownModelIds = [
      'deepinfra/model-0',
      'deepinfra/model-0',
      ...Array.from({ length: 300 }, (_, index) => `deepinfra/model-${index + 1}`),
      'deepinfra/not/a-model-id',
    ]
    deepinfra.knownModelIdsTotal = 500
    deepinfra.knownModelIdsTruncated = true

    const entry = buildOpenCodePassiveProviderDirectory(status([deepinfra])).entries[0]!
    expect(entry.metadata.knownModelIds).toHaveLength(256)
    expect(new Set(entry.metadata.knownModelIds).size).toBe(256)
    expect(entry.metadata).toMatchObject({ knownModelIdsTotal: 500, knownModelIdsTruncated: true })
    expect(entry.metadata.knownModelIds).not.toContain('deepinfra/not/a-model-id')
    expect(buildOpenCodePassiveProviderDirectory(status([deepinfra]), { query: 'model-256' }).entries).toEqual([])

    deepinfra.knownModelIds = []
    const metadataOnly = buildOpenCodePassiveProviderDirectory(status([deepinfra])).entries[0]!
    expect(metadataOnly.metadata).toMatchObject({
      knownModelIds: [], knownModelIdsTotal: 500, knownModelIdsTruncated: true,
    })
  })

  test('keeps model search evidence isolated for two projects sharing a provider id', async () => {
    const forProject = (modelId: string) => {
      const deepinfra = provider('deepinfra')
      deepinfra.catalogAvailable = fact('available', 'catalog_snapshot')
      deepinfra.knownModelIds = [modelId]
      return status([deepinfra])
    }
    const read: OpenCodePassiveRouteRead = async request => request.projectPath === '/project-a'
      ? forProject('deepinfra/project-a-model')
      : forProject('deepinfra/project-b-model')

    const a = await readOpenCodePassiveProviderDirectory({ projectPath: '/project-a', query: 'project-a-model' }, read)
    const b = await readOpenCodePassiveProviderDirectory({ projectPath: '/project-b', query: 'project-a-model' }, read)
    expect(a.entries.map(entry => entry.providerId)).toEqual(['deepinfra'])
    expect(b.entries).toEqual([])
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
