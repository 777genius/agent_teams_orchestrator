import { describe, expect, test } from 'bun:test'

import { OpenCodeActiveStatusSnapshotPublisher } from './OpenCodeActiveStatusSnapshotPublisher.js'
import { OpenCodePassiveStatusProductionReader } from './OpenCodePassiveStatusProductionReader.js'
import { encodeOpenCodeRedactedSnapshotV1, type OpenCodeRedactedSnapshotV1 } from './OpenCodeRedactedStatusSnapshot.js'
import type { OpenCodeInventorySnapshot } from './types.js'

function inventory(overrides: Partial<OpenCodeInventorySnapshot> = {}): OpenCodeInventorySnapshot {
  return {
    detected: true,
    binaryPath: '/redacted/by-publisher',
    version: '1.2.3',
    projectPath: '/project/secret-name',
    profile: null,
    connectedProviders: [{ id: 'deepinfra', authHint: 'api', source: 'credentials', credentialScopes: ['managed'] }],
    availableProviders: ['deepinfra'],
    models: ['deepinfra/llama-4'],
    modelMetadata: [], agents: [], authStorePath: '/secret/auth.json', probeError: null, diagnostics: [],
    ...overrides,
  }
}

describe('OpenCodeActiveStatusSnapshotPublisher production bridge', () => {
  test('publishes redacted active authority, retains it on transient updates, and passive status has zero write/probe effects', async () => {
    let now = 1_000
    let stored: string | null = null
    let writes = 0
    const publisher = new OpenCodeActiveStatusSnapshotPublisher({
      now: () => now,
      canonicalizePath: async () => '/canonical/project',
      readSnapshot: async () => stored,
      writer: {
        write: async (snapshot: OpenCodeRedactedSnapshotV1) => {
          writes += 1
          const encoded = encodeOpenCodeRedactedSnapshotV1(snapshot)
          if (!encoded.ok || !encoded.bytes) throw new Error('invalid snapshot')
          stored = new TextDecoder().decode(encoded.bytes)
        },
      },
    })

    await publisher.publishInventory(inventory())
    await publisher.publishProviderUpdate({
      projectPath: '/project/secret-name', providerId: 'deepinfra', executionVerified: true,
      modelIds: ['deepinfra/llama-4'],
    })
    expect(writes).toBe(2)
    expect(stored).not.toContain('/project/secret-name')
    expect(stored).not.toContain('/secret/auth.json')
    expect(stored).not.toContain('/redacted/by-publisher')

    await publisher.publishInventory(inventory({ probeError: 'transient timeout' }))
    expect(writes).toBe(2)

    now = 2_000
    const reader = new OpenCodePassiveStatusProductionReader({
      now: () => now,
      canonicalizePath: async () => '/canonical/project',
      readBoundedText: async filePath => filePath.endsWith('binary.snapshot.json') ? stored : stored,
    })
    const status = await reader.reader.read({ projectPath: '/project/secret-name', providerIds: ['deepinfra'], timeoutMs: 50 })
    expect(writes).toBe(2)
    expect(status.providers[0]).toMatchObject({
      configured: { value: 'configured', freshness: 'fresh' },
      lastConnected: { value: { state: 'connected' }, freshness: 'fresh' },
      catalogAvailable: { value: 'available', freshness: 'fresh' },
      executionVerified: { value: 'verified', freshness: 'fresh' },
    })
    expect(status.authorization).toBe('unknown')
    expect(status.launchReadiness).toBe('not_authorized')
  })
})
