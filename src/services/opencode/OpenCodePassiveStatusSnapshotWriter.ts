import path from 'node:path'
import { randomUUID } from 'node:crypto'

import { writeFileAtomic } from '../../utils/atomicWrite.js'
import { ensureOpenCodeSafePublicationDirectory } from './OpenCodeSafePublication.js'
import {
  decodeOpenCodePassiveSnapshotCommit,
  encodeOpenCodePassiveSnapshotCommit,
  openCodePassiveCommitName,
  OPEN_CODE_PASSIVE_COMMIT_MAX_BYTES,
  OPEN_CODE_PASSIVE_COMMIT_NAME_PATTERN,
  OPEN_CODE_PASSIVE_COMMIT_TEMP_PATTERN,
  OPEN_CODE_PASSIVE_COMMITS,
  OPEN_CODE_PASSIVE_GENERATION_BINARY,
  OPEN_CODE_PASSIVE_GENERATION_PROJECT,
  OPEN_CODE_PASSIVE_GENERATION_PATTERN,
  OPEN_CODE_PASSIVE_GENERATIONS,
  OPEN_CODE_PASSIVE_READER_GRACE_MS,
  OPEN_CODE_PASSIVE_RETAIN_GENERATIONS,
  OPEN_CODE_PASSIVE_SCOPES,
  OPEN_CODE_PASSIVE_TRANSACTION_MARKER,
  OPEN_CODE_PASSIVE_TRANSACTION_MARKER_CONTENT,
  openCodePassiveGenerationSequence,
} from './OpenCodePassiveSnapshotTransaction.js'
import {
  getOpenCodePassiveSnapshotPath,
  getOpenCodePassiveStatusRootDirectory,
  readBoundedSnapshotText,
} from './OpenCodePassiveStatusProductionReader.js'
import {
  assertOpenCodePassiveSnapshotPersistenceSupported,
  getOpenCodePassiveSnapshotPersistenceCapability,
} from './OpenCodePassiveSnapshotPersistencePolicy.js'
import {
  decodeOpenCodeRedactedSnapshotV1,
  encodeOpenCodeRedactedSnapshotV1,
  OPEN_CODE_REDACTED_SNAPSHOT_MAX_BYTES,
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
  now?: () => number
  scheduleMaintenance?: (operation: () => void, delayMs: number) => void
  retentionCount?: number
  readerGraceMs?: number
}>

/**
 * Append-only publication. There is deliberately no lock, shared pointer,
 * recovery operation, or correctness-path garbage collection. Every pathname
 * this writer publishes is cryptographically unique and is never reclaimed or
 * replaced by another writer.
 */
export class OpenCodePassiveStatusSnapshotWriter implements OpenCodeRedactedSnapshotWriterPort {
  readonly #platform: NodeJS.Platform
  readonly #rootDirectory: string
  readonly #makeDirectory: (directory: string) => Promise<unknown>
  readonly #writeAtomic: (filePath: string, data: string) => Promise<void>
  readonly #legacyInjectedStorage: boolean
  readonly #hooks: NonNullable<SnapshotWriterDeps['safeStorageHooks']>
  readonly #now: () => number
  readonly #scheduleMaintenance: (operation: () => void, delayMs: number) => void
  readonly #retentionCount: number
  readonly #readerGraceMs: number
  #maintenancePublications = 0

  constructor(deps: SnapshotWriterDeps = {}) {
    if ((deps.makeDirectory === undefined) !== (deps.writeAtomic === undefined)) {
      throw new TypeError('Passive snapshot test storage requires both directory and atomic-write ports')
    }
    this.#platform = deps.platform ?? process.platform
    this.#rootDirectory = getOpenCodePassiveSnapshotPersistenceCapability(this.#platform).supported
      ? deps.rootDirectory ?? getOpenCodePassiveStatusRootDirectory()
      : ''
    this.#legacyInjectedStorage = deps.makeDirectory !== undefined
    this.#makeDirectory = deps.makeDirectory ?? (async () => undefined)
    this.#writeAtomic = deps.writeAtomic ?? ((filePath, data) => writeFileAtomic(filePath, data, { mode: 0o600 }))
    this.#hooks = deps.safeStorageHooks ?? {}
    this.#now = deps.now ?? Date.now
    this.#scheduleMaintenance = deps.scheduleMaintenance ?? ((operation, delayMs) => {
      const timer = setTimeout(operation, delayMs)
      timer.unref?.()
    })
    this.#retentionCount = deps.retentionCount ?? OPEN_CODE_PASSIVE_RETAIN_GENERATIONS
    this.#readerGraceMs = deps.readerGraceMs ?? OPEN_CODE_PASSIVE_READER_GRACE_MS
    if (!Number.isSafeInteger(this.#retentionCount) || this.#retentionCount < 2
      || !Number.isSafeInteger(this.#readerGraceMs) || this.#readerGraceMs <= 60_000) {
      throw new TypeError('Passive snapshot retention policy is invalid')
    }
  }

  async write(snapshot: OpenCodeRedactedSnapshotV1, signal: AbortSignal): Promise<void> {
    // This capability gate must remain the first operation: unsupported native
    // platforms perform no inspection, creation, publication, or cleanup I/O.
    assertOpenCodePassiveSnapshotPersistenceSupported(this.#platform)
    if (signal.aborted) throw cancelled()
    const preflight = encodeOpenCodeRedactedSnapshotV1(snapshot)
    if (!preflight.ok || !preflight.bytes || preflight.bytes.byteLength > OPEN_CODE_REDACTED_SNAPSHOT_MAX_BYTES) {
      throw new TypeError('Passive snapshot is not a bounded redacted snapshot')
    }
    const digest = preflight.value.projectScope.slice(7)
    const compatibilityOwned = new TextDecoder('utf-8', { fatal: true }).decode(preflight.bytes)
    if (this.#legacyInjectedStorage) {
      const snapshotFile = getOpenCodePassiveSnapshotPath(this.#rootDirectory, preflight.value.projectScope)
      await this.#makeDirectory(path.dirname(snapshotFile))
      if (signal.aborted) throw cancelled()
      await this.#writeAtomic(snapshotFile, compatibilityOwned)
      if (signal.aborted) throw cancelled()
      await this.#writeAtomic(path.join(this.#rootDirectory, 'binary.snapshot.json'), compatibilityOwned)
      return
    }

    const root = await ensureOpenCodeSafePublicationDirectory(
      this.#rootDirectory, true, this.#hooks.ancestorDirectorySynced,
    )
    try {
      await this.#hooks.afterRootOpened?.()
      // Marker creation is monotonic. Once it exists readers must never fall
      // back to compatibility mirrors, including after an interrupted migration.
      await root.publishImmutableFile(
        OPEN_CODE_PASSIVE_TRANSACTION_MARKER, OPEN_CODE_PASSIVE_TRANSACTION_MARKER_CONTENT, 0o600,
      )
      await root.sync()
      await this.#hooks.afterTransactionMarker?.()

      const scopes = await root.ensureChildDirectoryDurable(
        OPEN_CODE_PASSIVE_SCOPES, 0o700, this.#hooks.ancestorDirectorySynced,
      )
      const scope = await scopes.ensureChildDirectoryDurable(
        digest, 0o700, this.#hooks.ancestorDirectorySynced,
      )
      const generations = await scope.ensureChildDirectoryDurable(
        OPEN_CODE_PASSIVE_GENERATIONS, 0o700, this.#hooks.ancestorDirectorySynced,
      )
      const commits = await scope.ensureChildDirectoryDurable(
        OPEN_CODE_PASSIVE_COMMITS, 0o700, this.#hooks.ancestorDirectorySynced,
      )
      const claimed = await claimGeneration(generations, this.#hooks.ancestorDirectorySynced)
      const generationName = claimed.name
      const publicationSequence = claimed.sequence
      const generation = claimed.directory
      try {
        await this.#hooks.afterGenerationDirectoryCreated?.()
        if (signal.aborted) throw cancelled()
        const publication = assignEvidenceGeneration(snapshot, publicationSequence)
        const encoded = encodeOpenCodeRedactedSnapshotV1(publication)
        if (!encoded.ok || !encoded.bytes) throw new TypeError('Passive snapshot evidence is invalid')
        const owned = new TextDecoder('utf-8', { fatal: true }).decode(encoded.bytes)
        await generation.publishImmutableFile(OPEN_CODE_PASSIVE_GENERATION_PROJECT, owned, 0o600)
        await this.#hooks.afterProjectSnapshotPublished?.()
        if (signal.aborted) throw cancelled()
        await generation.publishImmutableFile(OPEN_CODE_PASSIVE_GENERATION_BINARY, owned, 0o600)
        await this.#hooks.afterBinarySnapshotPublished?.()
        if (signal.aborted) throw cancelled()
        await generation.sync()
        await generations.sync()
        await this.#hooks.afterGenerationParentSynced?.()
        if (signal.aborted) throw cancelled()
        const commit = encodeOpenCodePassiveSnapshotCommit({
          schemaVersion: 2,
          scope: publication.projectScope,
          generation: generationName,
          domainGeneration: publicationSequence,
        })
        await this.#hooks.beforeCommitPublished?.()
        await commits.publishImmutableFile(openCodePassiveCommitName(
          publicationSequence, generationName,
        ), commit, 0o600)
        await commits.sync()
        await this.#hooks.afterCommitPublished?.()

        if (this.#maintenancePublications === 0) {
          const maintenance = () => { void this.maintain(publication.projectScope).catch(error => {
            this.#hooks.cleanupFailed?.(error)
          }) }
          this.#scheduleMaintenance(maintenance, 0)
          this.#scheduleMaintenance(maintenance, this.#readerGraceMs + 1)
        }

        // Write-only compatibility mirrors. Failures cannot revoke a committed
        // immutable transaction and readers ignore these whenever the marker exists.
        try {
          const mirrors = await root.ensureChildDirectory('snapshots')
          try { await mirrors.writeFileAtomic(`${digest}.json`, compatibilityOwned, 0o600) }
          finally { await mirrors.close() }
          await root.writeFileAtomic('binary.snapshot.json', compatibilityOwned, 0o600)
        } catch { /* disk hygiene/compatibility only */ }
      } finally {
        await generation.close().catch(() => undefined)
        await commits.close().catch(() => undefined)
        await generations.close().catch(() => undefined)
        await scope.close().catch(() => undefined)
        await scopes.close().catch(() => undefined)
      }
    } finally { await root.close() }
  }

  /** Out-of-band hygiene; publication and readers never depend on its success. */
  async maintain(projectScope: `sha256:${string}`): Promise<void> {
    if (this.#legacyInjectedStorage) return
    await this.#hooks.beforeCleanup?.()
    const now = this.#now()
    if (!Number.isSafeInteger(now) || now < 0) return
    let root: Awaited<ReturnType<typeof ensureOpenCodeSafePublicationDirectory>> | null = null
    let scopes: typeof root = null; let scope: typeof root = null
    let commits: typeof root = null; let generations: typeof root = null
    try {
      root = await ensureOpenCodeSafePublicationDirectory(this.#rootDirectory, true)
      scopes = await root.openChildDirectory(OPEN_CODE_PASSIVE_SCOPES)
      scope = await scopes.openChildDirectory(projectScope.slice(7))
      commits = await scope.openChildDirectory(OPEN_CODE_PASSIVE_COMMITS)
      generations = await scope.openChildDirectory(OPEN_CODE_PASSIVE_GENERATIONS)
      let records = await maintenanceRecords(commits, projectScope)
      if (records.length > this.#retentionCount) {
        // Publish a cumulative immutable checkpoint before dropping evidence.
        // If this fails, deletion never starts and the prior commits stay valid.
        const text = await readBoundedSnapshotText(
          getOpenCodePassiveSnapshotPath(this.#rootDirectory, projectScope), new AbortController().signal,
        )
        const decoded = decodeOpenCodeRedactedSnapshotV1(text)
        if (!decoded.ok || decoded.value.projectScope !== projectScope) {
          throw new Error('Passive snapshot compaction input is invalid')
        }
        this.#maintenancePublications += 1
        try { await this.write(decoded.value, new AbortController().signal) }
        finally { this.#maintenancePublications -= 1 }
        records = await maintenanceRecords(commits, projectScope)
      }
      const recent = records.filter(record => record.modifiedAt >= now - this.#readerGraceMs)
      const keep = new Set(records.slice(0, this.#retentionCount).map(record => record.name))
      for (const record of recent) keep.add(record.name)
      // A reader may have selected the transaction immediately preceding the grace window.
      const oldestRecent = recent.at(-1)
      if (oldestRecent) {
        const predecessor = records.find(record => record.sequence < oldestRecent.sequence)
        if (predecessor) keep.add(predecessor.name)
      }
      for (const record of records) {
        if (keep.has(record.name)) continue
        await commits.removeRegularFile(record.name)
        await generations.retireChildDirectory(record.generation, `.retired.${randomUUID()}`).catch(() => undefined)
      }
      const referenced = new Set(records.filter(record => keep.has(record.name)).map(record => record.generation))
      for (const name of await generations.childNames()) {
        if (referenced.has(name)) continue
        if (name.startsWith('.retired.')) {
          await generations.retireChildDirectory(name, `.retired.${randomUUID()}`).catch(() => undefined)
          continue
        }
        if (!OPEN_CODE_PASSIVE_GENERATION_PATTERN.test(name)) continue
        const modifiedAt = await generations.childDirectoryModifiedAt(name)
        if (modifiedAt < now - this.#readerGraceMs) {
          await generations.retireChildDirectory(name, `.retired.${randomUUID()}`).catch(() => undefined)
        }
      }
    } finally {
      await generations?.close().catch(() => undefined); await commits?.close().catch(() => undefined)
      await scope?.close().catch(() => undefined); await scopes?.close().catch(() => undefined)
      await root?.close().catch(() => undefined)
    }
  }

}

function cancelled(): Error { return new Error('Passive snapshot update cancelled') }

async function claimGeneration(
  generations: Awaited<ReturnType<typeof ensureOpenCodeSafePublicationDirectory>>,
  afterCreatedEntrySynced?: (path: string) => void | Promise<void>,
) {
  for (;;) {
    const sequences = (await generations.childNames()).map(openCodePassiveGenerationSequence)
      .filter((value): value is number => value !== null)
    const sequence = Math.max(0, ...sequences) + 1
    if (!Number.isSafeInteger(sequence)) throw new Error('Passive snapshot generation exhausted')
    const name = `${String(sequence).padStart(16, '0')}.${randomUUID()}`
    try {
      return { sequence, name, directory: await generations.createChildDirectoryExclusive(
        name, 0o700, afterCreatedEntrySynced,
      ) }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
}

function assignEvidenceGeneration(snapshot: OpenCodeRedactedSnapshotV1, generation: number): OpenCodeRedactedSnapshotV1 {
  const owned = structuredClone(snapshot)
  const observations = [owned.binary, ...owned.providers.flatMap(provider => [provider.configured,
    provider.lastConnected, provider.catalogAvailable, provider.executionVerified])]
  for (const observation of observations) {
    if (observation.authority !== 'none' && (observation.evidenceGeneration ?? 0) === 0) {
      observation.evidenceGeneration = generation
    }
  }
  return owned
}

async function maintenanceRecords(
  commits: Awaited<ReturnType<typeof ensureOpenCodeSafePublicationDirectory>>,
  scope: `sha256:${string}`,
): Promise<Array<{ name: string; generation: string; sequence: number; modifiedAt: number }>> {
  const records: Array<{ name: string; generation: string; sequence: number; modifiedAt: number }> = []
  for (const name of await commits.childNames()) {
    if (OPEN_CODE_PASSIVE_COMMIT_TEMP_PATTERN.test(name)) continue
    if (!OPEN_CODE_PASSIVE_COMMIT_NAME_PATTERN.test(name)) throw new Error('Passive snapshot commit set is invalid')
    const text = await commits.readBoundedRegularFile(name, OPEN_CODE_PASSIVE_COMMIT_MAX_BYTES)
    if (text === null) throw new Error('Passive snapshot commit set is invalid')
    const parsed = decodeOpenCodePassiveSnapshotCommit(text)
    if (!parsed || parsed.scope !== scope || name !== openCodePassiveCommitName(
      parsed.domainGeneration, parsed.generation,
    )) throw new Error('Passive snapshot commit set is invalid')
    records.push({ name, generation: parsed.generation, sequence: parsed.domainGeneration,
      modifiedAt: await commits.regularFileModifiedAt(name) })
  }
  records.sort((a, b) => b.sequence - a.sequence || b.name.localeCompare(a.name))
  return records
}
