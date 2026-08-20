import { describe, expect, test } from 'bun:test'

import { OpenCodeActiveStatusSnapshotPublisher } from './OpenCodeActiveStatusSnapshotPublisher.js'
import {
  getOpenCodePassiveSnapshotPersistenceCapability,
  isOpenCodeUnsupportedSafePersistenceError,
  OPEN_CODE_UNSUPPORTED_SAFE_PERSISTENCE_CODE,
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
  test('supports only descriptor-root Linux and Darwin implementations', () => {
    expect(getOpenCodePassiveSnapshotPersistenceCapability('linux')).toEqual({
      supported: true, implementation: 'descriptor-root',
    })
    expect(getOpenCodePassiveSnapshotPersistenceCapability('darwin')).toEqual({
      supported: true, implementation: 'descriptor-root',
    })
    expect(getOpenCodePassiveSnapshotPersistenceCapability('win32')).toEqual({
      supported: false, implementation: 'unavailable',
    })
  })

  test('win32 writer fails with a typed redacted transient error before storage I/O', async () => {
    const calls: string[] = []
    const deps = Object.defineProperty({
      platform: 'win32',
      makeDirectory: async () => { calls.push('mkdir') },
      writeAtomic: async () => { calls.push('write') },
    } as const, 'rootDirectory', {
      get: () => { calls.push('root-path'); return 'C:\\sensitive\\passive' },
    })
    const writer = new OpenCodePassiveStatusSnapshotWriter(deps)
    let failure: unknown
    try { await writer.write(snapshot, new AbortController().signal) }
    catch (error) { failure = error }
    expect(isOpenCodeUnsupportedSafePersistenceError(failure)).toBe(true)
    expect(failure).toMatchObject({ code: OPEN_CODE_UNSUPPORTED_SAFE_PERSISTENCE_CODE, transient: true })
    expect(String(failure)).not.toContain('sensitive')
    expect(calls).toEqual([])
  })

  test('win32 production reader returns explicit unknown evidence before every filesystem port', async () => {
    const calls: string[] = []
    const deps = Object.defineProperty({
      platform: 'win32',
      now: () => 1_000,
      canonicalizePath: async () => { calls.push('canonicalize'); return 'C:\\project' },
      readBoundedText: async () => { calls.push('read'); return JSON.stringify(snapshot) },
    } as const, 'rootDirectory', {
      get: () => { calls.push('root-path'); return 'C:\\sensitive\\passive' },
    })
    const adapter = new OpenCodePassiveStatusProductionReader(deps)
    const status = await adapter.reader.read({
      projectPath: 'C:\\private\\project', providerIds: ['deepinfra'], timeoutMs: 50,
    })
    expect(calls).toEqual([])
    expect(status).toMatchObject({
      projectScope: null,
      binary: {
        value: { presence: 'unknown', version: null }, authority: 'none', freshness: 'unknown',
        issueCode: 'unsupported_safe_persistence',
      },
      providers: [{
        providerId: 'deepinfra',
        configured: { value: 'unknown', authority: 'none', issueCode: 'unsupported_safe_persistence' },
        lastConnected: { value: { state: 'unknown' }, authority: 'none', issueCode: 'unsupported_safe_persistence' },
        catalogAvailable: { value: 'unknown', authority: 'none', issueCode: 'unsupported_safe_persistence' },
        executionVerified: { value: 'unknown', authority: 'none', issueCode: 'unsupported_safe_persistence' },
      }],
      authorization: 'unknown',
      launchReadiness: 'not_authorized',
    })
    expect(buildOpenCodePassiveProviderDirectory(status).diagnostics).toEqual([
      'passive_snapshot_persistence_unsupported',
    ])
  })

  test('win32 active publisher reports persistence unavailable before reads, writes, or scope locks', async () => {
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
    let failure: unknown
    try {
      await publisher.publishProviderUpdate({ projectPath: 'C:\\private\\project', providerId: 'deepinfra' })
    } catch (error) { failure = error }
    expect(isOpenCodeUnsupportedSafePersistenceError(failure)).toBe(true)
    expect(calls).toEqual([])
  })

  test('native win32 defaults use the same zero-I/O boundary', async () => {
    if (process.platform !== 'win32') return
    const calls: string[] = []
    const writer = new OpenCodePassiveStatusSnapshotWriter({
      rootDirectory: 'C:\\sensitive\\passive',
      makeDirectory: async () => { calls.push('mkdir') },
      writeAtomic: async () => { calls.push('write') },
    })
    await expect(writer.write(snapshot, new AbortController().signal)).rejects.toMatchObject({
      code: OPEN_CODE_UNSUPPORTED_SAFE_PERSISTENCE_CODE,
    })
    const reader = new OpenCodePassiveStatusProductionReader({
      rootDirectory: 'C:\\sensitive\\passive',
      canonicalizePath: async () => { calls.push('canonicalize'); return 'C:\\project' },
      readBoundedText: async () => { calls.push('read'); return null },
    })
    const status = await reader.reader.read({
      projectPath: 'C:\\private\\project', providerIds: ['deepinfra'], timeoutMs: 50,
    })
    const publisher = new OpenCodeActiveStatusSnapshotPublisher({
      canonicalizePath: async () => { calls.push('publisher-canonicalize'); return 'C:\\project' },
      readSnapshot: async () => { calls.push('publisher-read'); return null },
      withScopeUpdate: async (_scope, _signal, operation) => {
        calls.push('publisher-scope-lock')
        return operation()
      },
      writer: { write: async () => { calls.push('publisher-write') } },
    })
    await expect(publisher.publishProviderUpdate({
      projectPath: 'C:\\private\\project', providerId: 'deepinfra',
    })).rejects.toMatchObject({ code: OPEN_CODE_UNSUPPORTED_SAFE_PERSISTENCE_CODE })
    expect(calls).toEqual([])
    expect(status.binary).toMatchObject({
      value: { presence: 'unknown' }, authority: 'none', issueCode: 'unsupported_safe_persistence',
    })
    expect(status.launchReadiness).toBe('not_authorized')
  })
})
