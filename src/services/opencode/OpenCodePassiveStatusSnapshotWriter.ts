import path from 'node:path'
import { lstat, mkdir, rmdir, utimes } from 'node:fs/promises'

import { writeFileAtomic } from '../../utils/atomicWrite.js'
import { ensureOpenCodeSafePublicationDirectory } from './OpenCodeSafePublication.js'
import {
  getOpenCodePassiveSnapshotPath,
  getOpenCodePassiveStatusRootDirectory,
} from './OpenCodePassiveStatusProductionReader.js'
import {
  encodeOpenCodeRedactedSnapshotV1,
  OPEN_CODE_REDACTED_SNAPSHOT_MAX_BYTES,
  type OpenCodeRedactedSnapshotV1,
  type OpenCodeRedactedSnapshotWriterPort,
} from './OpenCodeRedactedStatusSnapshot.js'

type SnapshotWriterDeps = Readonly<{
  rootDirectory?: string
  makeDirectory?: (directory: string) => Promise<unknown>
  writeAtomic?: (filePath: string, data: string) => Promise<void>
  safeStorageHooks?: {
    afterRootOpened?: () => void | Promise<void>
    afterProjectSnapshotPublished?: () => void | Promise<void>
  }
  leaseWaitTimeoutMs?: number
  leaseStaleMs?: number
}>

/** Explicit update-path writer. It is intentionally never owned or called by readStatus. */
export class OpenCodePassiveStatusSnapshotWriter implements OpenCodeRedactedSnapshotWriterPort {
  readonly #rootDirectory: string
  readonly #makeDirectory: (directory: string) => Promise<unknown>
  readonly #writeAtomic: (filePath: string, data: string) => Promise<void>
  readonly #legacyInjectedStorage: boolean
  readonly #safeStorageHooks: NonNullable<SnapshotWriterDeps['safeStorageHooks']>
  readonly #leaseWaitTimeoutMs: number
  readonly #leaseStaleMs: number

  constructor(deps: SnapshotWriterDeps = {}) {
    if ((deps.makeDirectory === undefined) !== (deps.writeAtomic === undefined)) {
      throw new TypeError('Passive snapshot test storage requires both directory and atomic-write ports')
    }
    for (const value of [deps.leaseWaitTimeoutMs, deps.leaseStaleMs]) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
        throw new TypeError('Passive snapshot lease bounds must be positive safe integers')
      }
    }
    this.#rootDirectory = deps.rootDirectory ?? getOpenCodePassiveStatusRootDirectory()
    this.#legacyInjectedStorage = deps.makeDirectory !== undefined || deps.writeAtomic !== undefined
    this.#makeDirectory = deps.makeDirectory ?? (async () => undefined)
    this.#writeAtomic = deps.writeAtomic ?? ((filePath, data) => writeFileAtomic(filePath, data, { mode: 0o600 }))
    this.#safeStorageHooks = deps.safeStorageHooks ?? {}
    this.#leaseWaitTimeoutMs = deps.leaseWaitTimeoutMs ?? 2_000
    this.#leaseStaleMs = deps.leaseStaleMs ?? 30_000
  }

  async write(snapshot: OpenCodeRedactedSnapshotV1, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new Error('Passive snapshot update cancelled')
    const encoded = encodeOpenCodeRedactedSnapshotV1(snapshot)
    if (!encoded.ok || !encoded.bytes || encoded.bytes.byteLength > OPEN_CODE_REDACTED_SNAPSHOT_MAX_BYTES) {
      throw new TypeError('Passive snapshot is not a bounded redacted snapshot')
    }
    // Own the exact immutable bounded payload before any asynchronous filesystem boundary.
    const owned = new TextDecoder('utf-8', { fatal: true }).decode(encoded.bytes)
    const snapshotFile = getOpenCodePassiveSnapshotPath(this.#rootDirectory, encoded.value.projectScope)
    if (this.#legacyInjectedStorage) {
      await this.#makeDirectory(path.dirname(snapshotFile))
      if (signal.aborted) throw new Error('Passive snapshot update cancelled')
      await this.#writeAtomic(snapshotFile, owned)
      if (signal.aborted) throw new Error('Passive snapshot update cancelled')
      await this.#writeAtomic(path.join(this.#rootDirectory, 'binary.snapshot.json'), owned)
      return
    }
    const root = await ensureOpenCodeSafePublicationDirectory(this.#rootDirectory)
    try {
      await this.#safeStorageHooks.afterRootOpened?.()
      const snapshots = await root.ensureChildDirectory('snapshots')
      try {
        const snapshotName = `${encoded.value.projectScope.slice(7)}.json`
        const previousSnapshot = await snapshots.readBoundedRegularFile(snapshotName, OPEN_CODE_REDACTED_SNAPSHOT_MAX_BYTES)
        const previousBinary = await root.readBoundedRegularFile('binary.snapshot.json', OPEN_CODE_REDACTED_SNAPSHOT_MAX_BYTES)
        try {
          if (signal.aborted) throw new Error('Passive snapshot update cancelled')
          await snapshots.writeFileAtomic(snapshotName, owned, 0o600, signal)
          await this.#safeStorageHooks.afterProjectSnapshotPublished?.()
          if (signal.aborted) throw new Error('Passive snapshot update cancelled')
          await root.writeFileAtomic('binary.snapshot.json', owned, 0o600, signal)
        } catch (error) {
          await restorePublishedFile(snapshots, snapshotName, previousSnapshot)
          await restorePublishedFile(root, 'binary.snapshot.json', previousBinary)
          throw error
        }
      } finally { await snapshots.close() }
    } finally { await root.close() }
  }

  async withScopeLease<T>(
    scope: `sha256:${string}`,
    signal: AbortSignal,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (this.#legacyInjectedStorage) return operation()
    const root = await ensureOpenCodeSafePublicationDirectory(this.#rootDirectory)
    let locks
    try {
      locks = await root.ensureChildDirectory('locks')
      const name = `${scope.slice(7)}.lease`
      const leasePath = locks.child(`${name}.lock`)
      const deadline = Date.now() + this.#leaseWaitTimeoutMs
      let acquired = false
      while (!acquired) {
        if (signal.aborted) throw new Error('Passive snapshot update cancelled')
        try {
          await mkdir(leasePath, { mode: 0o700 })
          acquired = true
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
          const metadata = await lstat(leasePath).catch(() => null)
          if (metadata && metadata.isDirectory() && !metadata.isSymbolicLink()
            && metadata.mtimeMs < Date.now() - this.#leaseStaleMs) {
            await rmdir(leasePath).catch(() => undefined)
            continue
          }
          if (Date.now() >= deadline) throw Object.assign(new Error('Passive snapshot scope lease is held by a live owner'), { code: 'ELOCKED' })
          await waitForLease(signal, 25)
        }
      }
      let leaseDirectory
      try { leaseDirectory = await locks.openChildDirectory(`${name}.lock`) }
      catch (error) { await rmdir(leasePath).catch(() => undefined); throw error }
      const heartbeat = setInterval(() => {
        const now = new Date()
        void utimes(leaseDirectory.descriptorPath(), now, now).catch(() => undefined)
      }, 1_000)
      heartbeat.unref?.()
      try {
        if (signal.aborted) throw new Error('Passive snapshot update cancelled')
        return await operation()
      } finally {
        clearInterval(heartbeat)
        await leaseDirectory.close()
        await rmdir(leasePath).catch(() => undefined)
      }
    } finally {
      await locks?.close().catch(() => undefined)
      await root.close()
    }
  }
}

async function restorePublishedFile(
  directory: Awaited<ReturnType<typeof ensureOpenCodeSafePublicationDirectory>>,
  name: string,
  previous: string | null,
): Promise<void> {
  if (previous === null) await directory.removeRegularFile(name)
  else await directory.writeFileAtomic(name, previous, 0o600)
}

function waitForLease(signal: AbortSignal, delayMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('Passive snapshot update cancelled')); return }
    const timer = setTimeout(done, delayMs)
    const cancelled = () => done(new Error('Passive snapshot update cancelled'))
    function done(error?: Error): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', cancelled)
      if (error) reject(error); else resolve()
    }
    signal.addEventListener('abort', cancelled, { once: true })
  })
}
