import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { OpenCodeProviderManagementAdapter } from '../../features/runtimeProviderManagement/adapters/opencode/OpenCodeProviderManagementAdapter.js'
import { parseOpenCodeProvidersOutput } from './OpenCodeInventoryService.js'

describe('OpenCode provider display labels', () => {
  test.each(['OpenCode Zen', 'OPENCODE ZEN', 'OpenCode   Zen'])(
    'uses the live catalog provider ID for %s credentials', label => {
      const parsed = parseOpenCodeProvidersOutput(`
┌  Credentials /tmp/opencode-provider-label-test/auth.json
│
●  ${label} api
│
●  OpenCode Go api
│
●  OpenRouter api
│
└  3 credentials

┌  Environment
│
●  ${label} OPENCODE_API_KEY
│
└  1 environment variable
`)

      expect(parsed.authStorePath).toBe('/tmp/opencode-provider-label-test/auth.json')
      expect(parsed.connectedProviders).toEqual([
        { id: 'opencode', authHint: 'api', source: 'credentials' },
        { id: 'opencode-go', authHint: 'api', source: 'credentials' },
        { id: 'openrouter', authHint: 'api', source: 'credentials' },
        { id: 'opencode', authHint: 'opencode_api_key', source: 'environment' },
      ])
    },
  )

  test('preserves an explicit custom provider ID that resembles the Zen label', () => {
    const parsed = parseOpenCodeProvidersOutput(`
┌  Credentials /tmp/opencode-provider-label-test/auth.json
│
●  opencode-zen api
│
●  opencode api
│
└  2 credentials
`)

    expect(parsed.connectedProviders).toEqual([
      { id: 'opencode-zen', authHint: 'api', source: 'credentials' },
      { id: 'opencode', authHint: 'api', source: 'credentials' },
    ])
  })

  test.each([
    ['OpenCode Zen', 'opencode', 'opencode-zen'],
    ['Deep Infra', 'deepinfra', 'deep-infra'],
  ])('publishes connected %s under the catalog ID without a phantom source', async (label, canonicalId, customId) => {
    const projectPath = await mkdtemp(path.join(tmpdir(), 'opencode-provider-label-test-'))
    try {
      const parsed = parseOpenCodeProvidersOutput(`
┌  Credentials ${projectPath}/auth.json
●  ${label} api
●  OpenRouter api
└  2 credentials
`)
      const adapter = new OpenCodeProviderManagementAdapter({
        inventoryService: {
          probe: async () => ({
            detected: true,
            binaryPath: path.join(projectPath, 'opencode'),
            version: '1.15.7',
            projectPath,
            profile: null,
            connectedProviders: parsed.connectedProviders,
            availableProviders: parsed.connectedProviders.map(provider => provider.id),
            models: [],
            agents: [],
            authStorePath: parsed.authStorePath,
            probeError: null,
            diagnostics: [],
          }),
        },
        hostManager: {
          ensureHost: async () => { throw new Error('Summary must not start a runtime host') },
          releaseHost: async () => {},
        },
        clientFactory: {
          create: () => { throw new Error('Summary must not query a runtime host') },
        },
      })
      const result = await adapter.loadDirectory({
        runtimeId: 'opencode', projectPath, summary: true, limit: 100,
      })

      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error(result.error.message)
      const connectedIds = result.value.entries
        .filter(entry => entry.state === 'connected')
        .map(entry => entry.providerId)
      expect(connectedIds).toEqual([canonicalId, 'openrouter'])
      expect(result.value.entries.some(entry => entry.providerId === customId)).toBe(false)
      expect(result.value.entries.filter(entry => entry.providerId === canonicalId)).toHaveLength(1)
    } finally {
      await rm(projectPath, { recursive: true, force: true })
    }
  })

  test('keeps explicit DeepInfra-like IDs distinct from the spaced CLI display label', () => {
    const parsed = parseOpenCodeProvidersOutput(`
┌  Environment
●  Deep Infra DEEPINFRA_API_KEY
●  deep-infra CUSTOM_API_KEY
●  deepinfra DEEPINFRA_API_KEY
`)
    expect(parsed.connectedProviders).toEqual([
      { id: 'deepinfra', authHint: 'deepinfra_api_key', source: 'environment' },
      { id: 'deep-infra', authHint: 'custom_api_key', source: 'environment' },
      { id: 'deepinfra', authHint: 'deepinfra_api_key', source: 'environment' },
    ])
  })
})
