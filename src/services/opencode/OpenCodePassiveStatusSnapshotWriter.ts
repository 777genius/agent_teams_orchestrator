import path from 'node:path'

import {
  maintainOpenCodePassiveStore,
  mutateOpenCodePassiveSnapshot,
  replaceOpenCodePassiveSnapshot,
  updateOpenCodePassiveSnapshot,
} from './OpenCodePassiveSnapshotStore.js'
import { getOpenCodePassiveSnapshotPath, getOpenCodePassiveStatusRootDirectory } from './OpenCodePassiveStatusProductionReader.js'
import {
  assertOpenCodePassiveSnapshotPersistenceSupported,
  getOpenCodePassiveSnapshotPersistenceCapability,
} from './OpenCodePassiveSnapshotPersistencePolicy.js'
import {
  encodeOpenCodeRedactedSnapshotV1,
  type OpenCodeRedactedSnapshotMutation,
  type OpenCodeRedactedSnapshotV1,
  type OpenCodeRedactedSnapshotWriterPort,
} from './OpenCodeRedactedStatusSnapshot.js'

type SnapshotWriterDeps = Readonly<{
  platform?: NodeJS.Platform
  rootDirectory?: string
  makeDirectory?: (directory: string) => Promise<unknown>
  writeAtomic?: (filePath: string, data: string) => Promise<void>
  safeStorageHooks?: {
    afterRootOpened?: () => void | Promise<void>
    afterTransactionMarker?: () => void | Promise<void>
    afterGenerationDirectoryCreated?: () => void | Promise<void>
    afterProjectSnapshotPublished?: () => void | Promise<void>
    afterBinarySnapshotPublished?: () => void | Promise<void>
    afterGenerationParentSynced?: () => void | Promise<void>
    beforeCommitPublished?: () => void | Promise<void>
    afterCommitPublished?: () => void | Promise<void>
    cleanupFailed?: (error: unknown) => void
    ancestorDirectorySynced?: (directory: string) => void | Promise<void>
    beforeCleanup?: () => void | Promise<void>
  }
  scheduleMaintenance?: (operation: () => void, delayMs: number) => void
  /** Retained only for source compatibility. SQLite has a fixed bound of two. */
  retentionCount?: number
  readerGraceMs?: number
  now?: () => number
}>

/** Crash-recoverable, cross-process serialized passive transaction writer. */
export class OpenCodePassiveStatusSnapshotWriter implements OpenCodeRedactedSnapshotWriterPort {
  readonly #platform: NodeJS.Platform
  readonly #rootDirectory: string
  readonly #makeDirectory?: (directory: string) => Promise<unknown>
  readonly #writeAtomic?: (filePath: string, data: string) => Promise<void>
  readonly #hooks: NonNullable<SnapshotWriterDeps['safeStorageHooks']>
  readonly #scheduleMaintenance: (operation: () => void, delayMs: number) => void

  constructor(deps: SnapshotWriterDeps = {}) {
    if ((deps.makeDirectory === undefined) !== (deps.writeAtomic === undefined)) {
      throw new TypeError('Passive snapshot test storage requires both directory and atomic-write ports')
    }
    this.#platform = deps.platform ?? process.platform
    this.#rootDirectory = getOpenCodePassiveSnapshotPersistenceCapability(this.#platform).supported
      ? deps.rootDirectory ?? getOpenCodePassiveStatusRootDirectory(process.env, this.#platform)
      : ''
    this.#makeDirectory = deps.makeDirectory
    this.#writeAtomic = deps.writeAtomic
    this.#hooks = deps.safeStorageHooks ?? {}
    this.#scheduleMaintenance = deps.scheduleMaintenance ?? ((operation, delayMs) => {
      const timer = setTimeout(operation, delayMs); timer.unref?.()
    })
  }

  async mutate(mutation: OpenCodeRedactedSnapshotMutation, signal: AbortSignal): Promise<void> {
    // Capability rejection deliberately precedes encoding, path resolution,
    // directory creation and database access.
    assertOpenCodePassiveSnapshotPersistenceSupported(this.#platform)
    if (this.#makeDirectory || this.#writeAtomic) throw new Error('Injected compatibility writer does not support durable mutations')
    await mutateOpenCodePassiveSnapshot({ rootDirectory: this.#rootDirectory, platform: this.#platform, hooks: this.#hooks }, mutation, signal)
    this.#scheduleMaintenance(() => { void this.maintain(mutation.projectScope).catch(error => this.#hooks.cleanupFailed?.(error)) }, 0)
  }

  async update(
    projectScope: `sha256:${string}`,
    capturedAt: number,
    mutate: (snapshot: OpenCodeRedactedSnapshotV1) => void,
    signal: AbortSignal,
  ): Promise<void> {
    // Reject unsupported native persistence before examining callback-owned data.
    assertOpenCodePassiveSnapshotPersistenceSupported(this.#platform)
    if (this.#makeDirectory || this.#writeAtomic) throw new Error('Injected compatibility writer does not support durable updates')
    await updateOpenCodePassiveSnapshot(
      { rootDirectory: this.#rootDirectory, platform: this.#platform, hooks: this.#hooks },
      projectScope,
      capturedAt,
      mutate,
      signal,
    )
    this.#scheduleMaintenance(() => { void this.maintain(projectScope).catch(error => this.#hooks.cleanupFailed?.(error)) }, 0)
  }

  /** Compatibility replacement used by focused codec/writer tests. Authority is always stripped and reassigned. */
  async write(snapshot: OpenCodeRedactedSnapshotV1, signal: AbortSignal): Promise<void> {
    // This capability gate must remain the first operation: unsupported native
    // platforms perform no inspection, creation, publication, or cleanup I/O.
    assertOpenCodePassiveSnapshotPersistenceSupported(this.#platform)
    if (signal.aborted) throw cancelled()
    if (this.#makeDirectory && this.#writeAtomic) {
      const encoded = encodeOpenCodeRedactedSnapshotV1(snapshot)
      if (!encoded.ok || !encoded.bytes) throw new TypeError('Passive snapshot is not a bounded redacted snapshot')
      const owned = new TextDecoder('utf-8', { fatal: true }).decode(encoded.bytes)
      const snapshotFile = getOpenCodePassiveSnapshotPath(this.#rootDirectory, encoded.value.projectScope)
      await this.#makeDirectory(path.dirname(snapshotFile))
      if (signal.aborted) throw cancelled()
      await this.#writeAtomic(snapshotFile, owned)
      if (signal.aborted) throw cancelled()
      await this.#writeAtomic(path.join(this.#rootDirectory, 'binary.snapshot.json'), owned)
      return
    }
    await replaceOpenCodePassiveSnapshot({ rootDirectory: this.#rootDirectory, platform: this.#platform, hooks: this.#hooks }, snapshot, signal)
    this.#scheduleMaintenance(() => { void this.maintain(snapshot.projectScope).catch(error => this.#hooks.cleanupFailed?.(error)) }, 0)
  }

  /** Telemetry/disk hygiene only; correctness and row bounds are commit-time invariants. */
  async maintain(_projectScope: `sha256:${string}`): Promise<void> {
    if (this.#makeDirectory) return
    await this.#hooks.beforeCleanup?.()
    await maintainOpenCodePassiveStore(this.#rootDirectory, this.#platform)
  }
}

function cancelled(): Error { return new Error('Passive snapshot update cancelled') }
