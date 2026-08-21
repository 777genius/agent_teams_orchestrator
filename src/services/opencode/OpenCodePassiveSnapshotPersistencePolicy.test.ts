import { describe, expect, test } from 'bun:test'

import { OpenCodeActiveStatusSnapshotPublisher } from './OpenCodeActiveStatusSnapshotPublisher.js'
import {
  getOpenCodePassiveSnapshotPersistenceCapability,
} from './OpenCodePassiveSnapshotPersistencePolicy.js'
import { OpenCodePassiveStatusProductionReader } from './OpenCodePassiveStatusProductionReader.js'
import { buildOpenCodePassiveProviderDirectory } from './OpenCodePassiveProviderDirectory.js'
import { OpenCodePassiveStatusSnapshotWriter } from './OpenCodePassiveStatusSnapshotWriter.js'
import type { OpenCodeRedactedSnapshotV1 } from './OpenCodeRedactedStatusSnapshot.js'

const scope = `sha256:${'a'.repeat(64)}` as const
const snapshot: OpenCodeRedactedSnapshotV1 = {
  schemaVersion: 1,
  projectScope: scope,
  capturedAt: 1_000,
  binary: {
    value: { presence: 'unknown', version: null }, authority: 'none', freshness: 'unknown',
    condition: 'degraded', observedAt: null, validUntil: null, issueCode: 'unknown',
  },
  providers: [],
}

describe('OpenCode passive snapshot persistence platform policy', () => {
  test('selects descriptor roots on POSIX and verified app-owned paths on Windows', () => {
    expect(getOpenCodePassiveSnapshotPersistenceCapability('linux')).toEqual({
      supported: true, implementation: 'descriptor-root',
    })
    expect(getOpenCodePassiveSnapshotPersistenceCapability('darwin')).toEqual({
      supported: true, implementation: 'descriptor-root',
    })
    expect(getOpenCodePassiveSnapshotPersistenceCapability('win32')).toEqual({
      supported: true, implementation: 'verified-windows-path',
    })
  })

  test('win32 writer publishes only through the supplied atomic storage boundary', async () => {
    const calls: string[] = []
    const deps = Object.defineProperty({
      platform: 'win32',
      makeDirectory: async () => { calls.push('mkdir') },
      writeAtomic: async () => { calls.push('write') },
    } as const, 'rootDirectory', {
      get: () => { calls.push('root-path'); return 'C:\\sensitive\\passive' },
    })
    const writer = new OpenCodePassiveStatusSnapshotWriter(deps)
    await writer.write(snapshot, new AbortController().signal)
    expect(calls).toEqual(['root-path', 'mkdir', 'write', 'write'])
  })

  test('win32 production reader consumes verified committed evidence without active fallback', async () => {
    const calls: string[] = []
    const deps = Object.defineProperty({
      platform: 'win32',
      now: () => 1_000,
      canonicalizePath: async () => { calls.push('canonicalize'); return 'C:\\project' },
      readBoundedText: async () => { calls.push('read'); return null },
    } as const, 'rootDirectory', {
      get: () => { calls.push('root-path'); return 'C:\\sensitive\\passive' },
    })
    const adapter = new OpenCodePassiveStatusProductionReader(deps)
    const status = await adapter.reader.read({
      projectPath: 'C:\\private\\project', providerIds: ['deepinfra'], timeoutMs: 50,
    })
    expect(calls[0]).toBe('root-path')
    expect(calls).toContain('canonicalize')
    expect(calls.filter(call => call === 'read')).toHaveLength(2)
    expect(status.projectScope).not.toBeNull()
    expect(status.binary.issueCode).not.toBe('unsupported_safe_persistence')
    expect(buildOpenCodePassiveProviderDirectory(status).diagnostics)
      .not.toContain('passive_snapshot_persistence_unsupported')
  })

  test('win32 active publisher uses canonical scope and redacted snapshot writer only', async () => {
    const calls: string[] = []
    const withScopeUpdate = async <T>(
      _scope: `sha256:${string}`,
      _signal: AbortSignal,
      operation: () => Promise<T>,
    ): Promise<T> => {
      calls.push('scope-lock')
      return operation()
    }
    const deps = Object.defineProperty({
      platform: 'win32',
      canonicalizePath: async () => { calls.push('canonicalize'); return 'C:\\project' },
      readSnapshot: async () => { calls.push('read'); return null },
      withScopeUpdate,
      writer: { write: async () => { calls.push('write') } },
    } as const, 'rootDirectory', {
      get: () => { calls.push('root-path'); return 'C:\\sensitive\\passive' },
    })
    const publisher = new OpenCodeActiveStatusSnapshotPublisher(deps)
    await publisher.publishProviderUpdate({ projectPath: 'C:\\private\\project', providerId: 'deepinfra' })
    expect(calls).toEqual(['root-path', 'canonicalize', 'scope-lock', 'read', 'write'])
  })

  test('native win32 defaults expose the verified persistence capability', async () => {
    if (process.platform !== 'win32') return
    expect(getOpenCodePassiveSnapshotPersistenceCapability()).toEqual({
      supported: true, implementation: 'verified-windows-path',
    })
  })
})
