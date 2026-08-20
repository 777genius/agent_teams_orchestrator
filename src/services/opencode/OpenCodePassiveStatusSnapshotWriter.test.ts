import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { OpenCodeActiveStatusSnapshotPublisher } from './OpenCodeActiveStatusSnapshotPublisher.js'
import { OpenCodePassiveStatusSnapshotWriter } from './OpenCodePassiveStatusSnapshotWriter.js'
import { decodeOpenCodeRedactedSnapshotV1, encodeOpenCodeRedactedSnapshotV1, type OpenCodeRedactedSnapshotV1 } from './OpenCodeRedactedStatusSnapshot.js'
import { readBoundedSnapshotText } from './OpenCodePassiveStatusProductionReader.js'

const canonical = '/canonical/project'
const scope = `sha256:${createHash('sha256').update('opencode-project-scope-v1\0').update(canonical).digest('hex')}` as const
const otherScope = `sha256:${createHash('sha256').update('opencode-project-scope-v1\0').update('/other/project').digest('hex')}` as const
const observation = <T>(value: T, authority: any, at: number) => ({
  value, authority, freshness: 'fresh' as const, condition: 'normal' as const,
  observedAt: at, validUntil: at + 1_000, issueCode: 'none' as const,
})
function snapshot(at: number, projectScope: `sha256:${string}` = scope): OpenCodeRedactedSnapshotV1 {
  return {
    schemaVersion: 1, projectScope, capturedAt: at,
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

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  return { promise: new Promise<void>(done => { resolve = done }), resolve }
}
function encoded(value: OpenCodeRedactedSnapshotV1): string {
  const result = encodeOpenCodeRedactedSnapshotV1(value)
  if (!result.ok || !result.bytes) throw new Error('invalid fixture')
  return new TextDecoder().decode(result.bytes)
}

describe('OpenCode passive snapshot writer lease', () => {
  test('reclaims a simulated crashed binary owner and completes the next publication', async () => {
    const root = await mkdtemp(path.join(process.cwd(), '.opencode-passive-crashed-'))
    const lease = path.join(root, 'locks', 'binary.snapshot.lease.lock')
    try {
      await mkdir(lease, { recursive: true })
      await writeFile(path.join(lease, 'active.json'), JSON.stringify({
        pid: 991_443, birthIdentity: 'dead-process-birth',
        token: '00000000-0000-4000-8000-000000000443',
      }))
      const writer = new OpenCodePassiveStatusSnapshotWriter({
        rootDirectory: root,
        leaseOwnerIsAlive: owner => owner.birthIdentity !== 'dead-process-birth',
        leaseWait: async () => undefined,
      })
      await writer.write(snapshot(4_430), new AbortController().signal)
      expect(await readFile(path.join(root, 'binary.snapshot.json'), 'utf8'))
        .toBe(encoded(snapshot(4_430)))
      expect(await readdir(path.join(root, 'locks'))).toEqual([])
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  test('retries transient Windows-style cleanup failures without deleting a successor', async () => {
    const root = await mkdtemp(path.join(process.cwd(), '.opencode-passive-eperm-'))
    try {
      let cleanupAttempts = 0
      const writer = new OpenCodePassiveStatusSnapshotWriter({
        rootDirectory: root,
        leaseCleanupRename: async (source, destination) => {
          cleanupAttempts += 1
          if (cleanupAttempts < 3) throw Object.assign(new Error('injected Windows cleanup denial'), { code: 'EPERM' })
          await rename(source, destination)
        },
      })
      await writer.write(snapshot(4_431), new AbortController().signal)
      expect(cleanupAttempts).toBe(3)
      let persistentAttempts = 0
      await expect(new OpenCodePassiveStatusSnapshotWriter({
        rootDirectory: root,
        leaseCleanupRename: async () => {
          persistentAttempts += 1
          throw Object.assign(new Error('injected persistent Windows cleanup denial'), { code: 'EPERM' })
        },
      }).write(snapshot(4_432), new AbortController().signal)).rejects.toMatchObject({ code: 'EPERM' })
      expect(persistentAttempts).toBe(3)
      await new OpenCodePassiveStatusSnapshotWriter({ rootDirectory: root })
        .write(snapshot(4_433), new AbortController().signal)
      expect(await readFile(path.join(root, 'binary.snapshot.json'), 'utf8'))
        .toBe(encoded(snapshot(4_433)))
      expect(await readdir(path.join(root, 'locks'))).toEqual([])
    } finally { await rm(root, { recursive: true, force: true }) }
  })

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

  test('never displaces an aged owner, so it cannot resume over a newer publication', async () => {
    const root = await mkdtemp(path.join(process.cwd(), '.opencode-passive-stale-'))
    try {
      const signal = new AbortController().signal
      const acquired = deferred()
      const resume = deferred()
      const writerA = new OpenCodePassiveStatusSnapshotWriter({ rootDirectory: root })
      const publicationA = writerA.withScopeLease(scope, signal, async () => {
        acquired.resolve()
        await resume.promise
        await writerA.write(snapshot(2_000), signal)
      })
      await acquired.promise

      let now = 60_000
      let writerBEntered = false
      const writerB = new OpenCodePassiveStatusSnapshotWriter({
        rootDirectory: root,
        leaseNow: () => now,
        leaseWaitTimeoutMs: 10,
        leaseWait: async () => { now = 60_010 },
      })
      await expect(writerB.withScopeLease(scope, signal, async () => {
        writerBEntered = true
        await writerB.write(snapshot(3_000), signal)
      })).rejects.toMatchObject({ code: 'ELOCKED' })
      expect(writerBEntered).toBe(false)

      resume.resolve()
      await publicationA
      await writerB.withScopeLease(scope, signal, () => writerB.write(snapshot(3_000), signal))
      expect(await readFile(path.join(root, 'snapshots', `${scope.slice(7)}.json`), 'utf8'))
        .toBe(encoded(snapshot(3_000)))
      expect(await readFile(path.join(root, 'binary.snapshot.json'), 'utf8'))
        .toBe(encoded(snapshot(3_000)))
      expect(await readdir(path.join(root, 'locks'))).toEqual([])
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  test('cleanup uses the acquired identity and cannot delete a replacement lease', async () => {
    const parent = await mkdtemp(path.join(process.cwd(), '.opencode-passive-lease-cleanup-'))
    const root = path.join(parent, 'owned')
    const displaced = path.join(parent, 'displaced-lease')
    const leasePath = path.join(root, 'locks', `${scope.slice(7)}.lease.lock`)
    try {
      await mkdir(root)
      const writer = new OpenCodePassiveStatusSnapshotWriter({ rootDirectory: root })
      await writer.withScopeLease(scope, new AbortController().signal, async () => {
        await rename(leasePath, displaced)
        await mkdir(leasePath)
      })
      expect(await readdir(path.join(root, 'locks'))).toEqual([`${scope.slice(7)}.lease.lock`])
    } finally { await rm(parent, { recursive: true, force: true }) }
  })

  test('serializes the same scope and cancels or times out waiters without real sleeps', async () => {
    const root = await mkdtemp(path.join(process.cwd(), '.opencode-passive-lease-wait-'))
    try {
      const held = deferred()
      const release = deferred()
      const first = new OpenCodePassiveStatusSnapshotWriter({ rootDirectory: root })
        .withScopeLease(scope, new AbortController().signal, async () => {
          held.resolve()
          await release.promise
        })
      await held.promise

      const waiting = deferred()
      const retry = deferred()
      let secondEntered = false
      const secondWriter = new OpenCodePassiveStatusSnapshotWriter({
        rootDirectory: root,
        safeStorageHooks: { afterLeaseWait: name => {
          if (name === `${scope.slice(7)}.lease`) waiting.resolve()
        } },
        leaseWait: async () => retry.promise,
      })
      const second = secondWriter.withScopeLease(scope, new AbortController().signal, async () => {
        secondEntered = true
      })
      await waiting.promise
      expect(secondEntered).toBe(false)
      release.resolve()
      await first
      retry.resolve()
      await second
      expect(secondEntered).toBe(true)

      const liveLease = `${path.join(root, 'locks', `${scope.slice(7)}.lease`)}.lock`
      await mkdir(liveLease)
      const controller = new AbortController()
      const cancellationObserved = deferred()
      const enterCancellationWait = deferred()
      let entered = false
      const cancellingWriter = new OpenCodePassiveStatusSnapshotWriter({
        rootDirectory: root,
        safeStorageHooks: { afterLeaseWait: async () => {
          cancellationObserved.resolve()
          await enterCancellationWait.promise
        } },
        leaseWait: signal => signal.aborted
          ? Promise.reject(new Error('Passive snapshot update cancelled'))
          : new Promise((_, reject) => signal.addEventListener(
            'abort', () => reject(new Error('Passive snapshot update cancelled')), { once: true },
          )),
      })
      const pending = cancellingWriter.withScopeLease(scope, controller.signal, async () => { entered = true })
      await cancellationObserved.promise
      controller.abort('cancelled')
      enterCancellationWait.resolve()
      await expect(pending).rejects.toThrow('cancelled')
      expect(entered).toBe(false)

      let now = 0
      const boundedWriter = new OpenCodePassiveStatusSnapshotWriter({
        rootDirectory: root,
        leaseWaitTimeoutMs: 10,
        leaseNow: () => now,
        leaseWait: async () => { now = 10 },
      })
      await expect(boundedWriter.withScopeLease(
        scope, new AbortController().signal, async () => { entered = true },
      )).rejects.toMatchObject({ code: 'ELOCKED' })
      expect(entered).toBe(false)
      await rm(liveLease, { recursive: true, force: true })
      expect(await readdir(path.join(root, 'locks'))).toEqual([])
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  test('a failed binary verification rolls back before another scope publishes', async () => {
    const root = await mkdtemp(path.join(process.cwd(), '.opencode-passive-binary-lease-'))
    try {
      const signal = new AbortController().signal
      await new OpenCodePassiveStatusSnapshotWriter({ rootDirectory: root }).write(snapshot(1_000), signal)
      const renamed = deferred()
      const failVerification = deferred()
      const writerA = new OpenCodePassiveStatusSnapshotWriter({
        rootDirectory: root,
        safeStorageHooks: { afterBinarySnapshotRenamed: async () => {
          renamed.resolve()
          await failVerification.promise
          throw new Error('injected binary verification failure')
        } },
      })
      const publicationA = writerA.withScopeLease(scope, signal, () => writerA.write(snapshot(2_000), signal))
      await renamed.promise

      const binaryLeaseBlocked = deferred()
      const retryBinaryLease = deferred()
      const writerB = new OpenCodePassiveStatusSnapshotWriter({
        rootDirectory: root,
        safeStorageHooks: { afterLeaseWait: name => {
          if (name === 'binary.snapshot.lease') binaryLeaseBlocked.resolve()
        } },
        leaseWait: async () => retryBinaryLease.promise,
      })
      const publicationB = writerB.withScopeLease(
        otherScope, signal, () => writerB.write(snapshot(3_000, otherScope), signal),
      )
      await binaryLeaseBlocked.promise

      failVerification.resolve()
      await expect(publicationA).rejects.toThrow('injected binary verification failure')
      retryBinaryLease.resolve()
      await publicationB

      expect(await readFile(path.join(root, 'snapshots', `${scope.slice(7)}.json`), 'utf8'))
        .toBe(encoded(snapshot(1_000)))
      expect(await readFile(path.join(root, 'snapshots', `${otherScope.slice(7)}.json`), 'utf8'))
        .toBe(encoded(snapshot(3_000, otherScope)))
      expect(await readFile(path.join(root, 'binary.snapshot.json'), 'utf8'))
        .toBe(encoded(snapshot(3_000, otherScope)))
      expect(await readdir(path.join(root, 'locks'))).toEqual([])
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

  test('rejects a binary lease symlink swap without publishing outside the root', async () => {
    if (process.platform === 'win32') return
    const parent = await mkdtemp(path.join(process.cwd(), '.opencode-passive-lease-swap-'))
    const root = path.join(parent, 'owned')
    const outside = path.join(parent, 'outside')
    const displaced = path.join(parent, 'displaced-lease')
    const leasePath = path.join(root, 'locks', 'binary.snapshot.lease.lock')
    try {
      await Promise.all([mkdir(root), mkdir(outside)])
      const writer = new OpenCodePassiveStatusSnapshotWriter({
        rootDirectory: root,
        safeStorageHooks: { afterLeaseDirectoryCreated: async name => {
          if (name !== 'binary.snapshot.lease') return
          await rename(leasePath, displaced)
          await symlink(outside, leasePath, 'dir')
        } },
      })
      await expect(writer.write(snapshot(1_000), new AbortController().signal)).rejects.toThrow(
        'safe publication primitive is unavailable',
      )
      expect(await readdir(outside)).toEqual([])
      expect((await readdir(root)).sort()).toEqual(['locks'])
    } finally { await rm(parent, { recursive: true, force: true }) }
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
