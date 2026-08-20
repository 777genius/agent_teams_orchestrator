import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { OpenCodeActiveStatusSnapshotPublisher } from './OpenCodeActiveStatusSnapshotPublisher.js'
import { OpenCodePassiveStatusSnapshotWriter } from './OpenCodePassiveStatusSnapshotWriter.js'
import { decodeOpenCodeRedactedSnapshotV1, encodeOpenCodeRedactedSnapshotV1, type OpenCodeRedactedSnapshotV1 } from './OpenCodeRedactedStatusSnapshot.js'
import { readBoundedSnapshotText } from './OpenCodePassiveStatusProductionReader.js'

const canonical = '/canonical/project'
const scope = `sha256:${createHash('sha256').update('opencode-project-scope-v1\0').update(canonical).digest('hex')}` as const
const observation = <T>(value: T, authority: any, at: number) => ({
  value, authority, freshness: 'fresh' as const, condition: 'normal' as const,
  observedAt: at, validUntil: at + 1_000, issueCode: 'none' as const,
})
function snapshot(at: number): OpenCodeRedactedSnapshotV1 {
  return {
    schemaVersion: 1, projectScope: scope, capturedAt: at,
    binary: observation({ presence: 'present' as const, version: '1.2.3' }, 'binary_metadata', at),
    providers: [{
      providerId: 'deepinfra',
      configured: observation('configured' as const, 'config_metadata', at),
      lastConnected: observation({ state: 'connected' as const, at }, 'auth_metadata', at),
      catalogAvailable: observation('available' as const, 'catalog_snapshot', at),
      executionVerified: observation('verified' as const, 'execution_snapshot', at),
    }],
  }
}
function encoded(value: OpenCodeRedactedSnapshotV1): string {
  const result = encodeOpenCodeRedactedSnapshotV1(value)
  if (!result.ok || !result.bytes) throw new Error('invalid fixture')
  return new TextDecoder().decode(result.bytes)
}

describe('OpenCode passive snapshot writer lease', () => {
  test('two production publisher instances retain independent observations under one scope lease', async () => {
    const root = await mkdtemp(path.join(process.cwd(), '.opencode-passive-lease-'))
    try {
      const make = () => new OpenCodeActiveStatusSnapshotPublisher({
        rootDirectory: root,
        canonicalizePath: async () => canonical,
      })
      await Promise.all([
        make().publishProviderUpdate({ projectPath: '/a', providerId: 'deepinfra', connected: true }),
        make().publishProviderUpdate({ projectPath: '/a', providerId: 'ollama', configured: true }),
      ])
      const text = await readBoundedSnapshotText(
        path.join(root, 'snapshots', `${scope.slice(7)}.json`), new AbortController().signal,
      )
      const decoded = decodeOpenCodeRedactedSnapshotV1(text)
      expect(decoded.ok).toBe(true)
      if (!decoded.ok) throw new Error(decoded.issueCode)
      expect(decoded.value.providers.map(provider => provider.providerId)).toEqual(['deepinfra', 'ollama'])
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  test('recovers an abandoned stale owner but cancellation cannot enter a foreign live lease', async () => {
    const root = await mkdtemp(path.join(process.cwd(), '.opencode-passive-stale-'))
    const leaseName = `${scope.slice(7)}.lease`
    const leasePath = path.join(root, 'locks', leaseName)
    try {
      await mkdir(path.join(root, 'locks'))
      await writeFile(leasePath, '')
      await mkdir(`${leasePath}.lock`)
      const stale = new Date(Date.now() - 60_000)
      await utimes(`${leasePath}.lock`, stale, stale)
      const writer = new OpenCodePassiveStatusSnapshotWriter({ rootDirectory: root })
      let recovered = false
      await writer.withScopeLease(scope, new AbortController().signal, async () => { recovered = true })
      expect(recovered).toBe(true)

      await mkdir(`${leasePath}.lock`)
      const controller = new AbortController()
      let entered = false
      const pending = writer.withScopeLease(scope, controller.signal, async () => { entered = true })
      setTimeout(() => controller.abort('cancelled'), 25)
      await expect(pending).rejects.toThrow('cancelled')
      expect(entered).toBe(false)

      const boundedWriter = new OpenCodePassiveStatusSnapshotWriter({
        rootDirectory: root,
        leaseWaitTimeoutMs: 1,
      })
      await expect(boundedWriter.withScopeLease(
        scope, new AbortController().signal, async () => { entered = true },
      )).rejects.toMatchObject({ code: 'ELOCKED' })
      expect(entered).toBe(false)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  test('rolls project and binary publication back together after an injected cancellation', async () => {
    const root = await mkdtemp(path.join(process.cwd(), '.opencode-passive-rollback-'))
    try {
      await new OpenCodePassiveStatusSnapshotWriter({ rootDirectory: root })
        .write(snapshot(1_000), new AbortController().signal)
      const controller = new AbortController()
      const writer = new OpenCodePassiveStatusSnapshotWriter({
        rootDirectory: root,
        safeStorageHooks: { afterProjectSnapshotPublished: () => controller.abort('injected') },
      })
      await expect(writer.write(snapshot(2_000), controller.signal)).rejects.toThrow('cancelled')
      expect(await readFile(path.join(root, 'snapshots', `${scope.slice(7)}.json`), 'utf8'))
        .toBe(encoded(snapshot(1_000)))
      expect(await readFile(path.join(root, 'binary.snapshot.json'), 'utf8'))
        .toBe(encoded(snapshot(1_000)))
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  test('a root swap after descriptor acquisition causes no outside mutation', async () => {
    if (process.platform === 'win32') return
    const parent = await mkdtemp(path.join(process.cwd(), '.opencode-passive-swap-'))
    const root = path.join(parent, 'owned')
    const displaced = path.join(parent, 'displaced')
    const outside = path.join(parent, 'outside')
    try {
      await Promise.all([mkdir(root), mkdir(outside)])
      const writer = new OpenCodePassiveStatusSnapshotWriter({
        rootDirectory: root,
        safeStorageHooks: { afterRootOpened: async () => {
          await rename(root, displaced)
          await symlink(outside, root, 'dir')
        } },
      })
      await writer.write(snapshot(1_000), new AbortController().signal)
      expect(await readdir(outside)).toEqual([])
      expect(await readFile(path.join(displaced, 'snapshots', `${scope.slice(7)}.json`), 'utf8'))
        .toBe(encoded(snapshot(1_000)))
    } finally { await rm(parent, { recursive: true, force: true }) }
  })
})
