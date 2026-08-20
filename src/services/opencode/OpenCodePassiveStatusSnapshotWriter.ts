import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { constants as fsConstants, readFileSync } from 'node:fs'
import { lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises'

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
    afterBinarySnapshotRenamed?: () => void | Promise<void>
    afterLeaseDirectoryCreated?: (leaseName: string) => void | Promise<void>
    afterLeaseWait?: (leaseName: string) => void | Promise<void>
  }
  leaseWaitTimeoutMs?: number
  leaseNow?: () => number
  leaseWait?: (signal: AbortSignal, delayMs: number) => Promise<void>
  leaseOwner?: Readonly<{ pid: number; birthIdentity: string }>
  leaseOwnerIsAlive?: (owner: Readonly<{ pid: number; birthIdentity: string }>) => boolean | Promise<boolean>
  leaseCleanupRename?: (source: string, destination: string) => Promise<void>
}>

type LeaseOwner = Readonly<{ pid: number; birthIdentity: string; token: string }>
const PROCESS_BIRTH_IDENTITY = readLinuxProcessBirthIdentity(process.pid)
  ?? `${process.pid}:${Math.floor(Date.now() - process.uptime() * 1_000)}`

/** Explicit update-path writer. It is intentionally never owned or called by readStatus. */
export class OpenCodePassiveStatusSnapshotWriter implements OpenCodeRedactedSnapshotWriterPort {
  readonly #rootDirectory: string
  readonly #makeDirectory: (directory: string) => Promise<unknown>
  readonly #writeAtomic: (filePath: string, data: string) => Promise<void>
  readonly #legacyInjectedStorage: boolean
  readonly #safeStorageHooks: NonNullable<SnapshotWriterDeps['safeStorageHooks']>
  readonly #leaseWaitTimeoutMs: number
  readonly #leaseNow: () => number
  readonly #leaseWait: (signal: AbortSignal, delayMs: number) => Promise<void>
  readonly #leaseOwner: Readonly<{ pid: number; birthIdentity: string }>
  readonly #leaseOwnerIsAlive: NonNullable<SnapshotWriterDeps['leaseOwnerIsAlive']>
  readonly #leaseCleanupRename: NonNullable<SnapshotWriterDeps['leaseCleanupRename']>

  constructor(deps: SnapshotWriterDeps = {}) {
    if ((deps.makeDirectory === undefined) !== (deps.writeAtomic === undefined)) {
      throw new TypeError('Passive snapshot test storage requires both directory and atomic-write ports')
    }
    for (const value of [deps.leaseWaitTimeoutMs]) {
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
    this.#leaseNow = deps.leaseNow ?? Date.now
    this.#leaseWait = deps.leaseWait ?? waitForLease
    this.#leaseOwner = deps.leaseOwner ?? { pid: process.pid, birthIdentity: processBirthIdentity() }
    this.#leaseOwnerIsAlive = deps.leaseOwnerIsAlive ?? isLeaseOwnerAlive
    this.#leaseCleanupRename = deps.leaseCleanupRename ?? rename
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
      // Publishers always acquire their scope lease first. Taking the single
      // shared-binary lease only here gives every writer the same scope ->
      // binary acquisition order and makes verification plus rollback one
      // cross-process transaction without placing a lock on passive reads.
      await this.#withLease(root, 'binary.snapshot.lease', 'binary', signal, async () => {
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
            await root.writeFileAtomic('binary.snapshot.json', owned, 0o600, signal, {
              afterRenameBeforeVerification: this.#safeStorageHooks.afterBinarySnapshotRenamed,
            })
          } catch (error) {
            await restorePublishedFile(snapshots, snapshotName, previousSnapshot)
            await restorePublishedFile(root, 'binary.snapshot.json', previousBinary)
            throw error
          }
        } finally { await snapshots.close() }
      })
    } finally { await root.close() }
  }

  async withScopeLease<T>(
    scope: `sha256:${string}`,
    signal: AbortSignal,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (this.#legacyInjectedStorage) return operation()
    const root = await ensureOpenCodeSafePublicationDirectory(this.#rootDirectory)
    try {
      return await this.#withLease(root, `${scope.slice(7)}.lease`, 'scope', signal, operation)
    } finally {
      await root.close()
    }
  }

  async #withLease<T>(
    root: Awaited<ReturnType<typeof ensureOpenCodeSafePublicationDirectory>>,
    name: string,
    kind: 'scope' | 'binary',
    signal: AbortSignal,
    operation: () => Promise<T>,
  ): Promise<T> {
    const locks = await root.ensureChildDirectory('locks')
    try {
      const lockName = `${name}.lock`
      const leasePath = locks.child(lockName)
      const deadline = this.#leaseNow() + this.#leaseWaitTimeoutMs
      const owner: LeaseOwner = { ...this.#leaseOwner, token: randomUUID() }
      for (;;) {
        if (signal.aborted) throw new Error('Passive snapshot update cancelled')
        try {
          await createInitializedLeaseDirectory(leasePath, owner)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
          await this.#recoverLeaseIfSafe(locks.descriptorPath(), lockName)
          if (this.#leaseNow() >= deadline) throw Object.assign(
            new Error(`Passive snapshot ${kind} lease is held by a live owner`), { code: 'ELOCKED' },
          )
          await this.#safeStorageHooks.afterLeaseWait?.(name)
          await this.#leaseWait(signal, 25)
          continue
        }
        await this.#safeStorageHooks.afterLeaseDirectoryCreated?.(name)
        break
      }
      let leaseDirectory
      try { leaseDirectory = await locks.openChildDirectory(lockName) }
      catch (error) {
        await this.#recoverLeaseIfSafe(locks.descriptorPath(), lockName).catch(() => undefined)
        throw error
      }
      const ownedLeasePath = leaseDirectory.descriptorPath()
      try {
        if (signal.aborted) throw new Error('Passive snapshot update cancelled')
        return await operation()
      } finally {
        await rename(
          path.join(ownedLeasePath, 'active.json'), path.join(ownedLeasePath, 'released.json'),
        ).catch(() => undefined)
        await leaseDirectory.close().catch(() => undefined)
        await this.#recoverLeaseIfSafe(locks.descriptorPath(), lockName)
      }
    } finally {
      await locks.close().catch(() => undefined)
    }
  }

  async #recoverLeaseIfSafe(locksPath: string, lockName: string): Promise<void> {
    const leasePath = path.join(locksPath, lockName)
    let marker = 'released.json'
    let owner = await readLeaseOwner(path.join(leasePath, marker))
    if (!owner) {
      marker = 'active.json'
      owner = await readLeaseOwner(path.join(leasePath, marker))
      if (owner && await this.#leaseOwnerIsAlive(owner)) return
    }
    if (!owner) {
      const cleanup = (await readdir(leasePath).catch(() => []))
        .find(entry => /^cleanup\.[0-9a-f-]+\.json$/.test(entry))
      if (!cleanup) return
      marker = cleanup
      owner = await readLeaseOwner(path.join(
        leasePath, `claimant.${cleanup.slice('cleanup.'.length, -'.json'.length)}.json`,
      ))
      if (!owner || await this.#leaseOwnerIsAlive(owner)) return
    }

    // Moving the one extant state marker is the fencing operation. Exactly one
    // cleaner can win it; no check-then-delete path is allowed to race a new
    // lease generation at the shared name.
    const cleaner: LeaseOwner = { ...this.#leaseOwner, token: randomUUID() }
    const claim = `cleanup.${cleaner.token}.json`
    const claimant = `claimant.${cleaner.token}.json`
    await createLeaseOwner(path.join(leasePath, claimant), cleaner)
    try { await rename(path.join(leasePath, marker), path.join(leasePath, claim)) }
    catch (error) {
      await rm(path.join(leasePath, claimant), { force: true }).catch(() => undefined)
      if (['ENOENT', 'EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) return
      throw error
    }
    const tombstone = path.join(locksPath, `.${lockName}.retired.${cleaner.token}`)
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await this.#leaseCleanupRename(leasePath, tombstone)
          await rm(tombstone, { recursive: true, force: true }).catch(() => undefined)
          return
        } catch (error) {
          if (!['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '') || attempt === 2) {
            throw error
          }
        }
      }
    } catch (error) {
      await rename(path.join(leasePath, claim), path.join(leasePath, 'released.json')).catch(() => undefined)
      throw error
    }
  }
}

async function createInitializedLeaseDirectory(leasePath: string, owner: LeaseOwner): Promise<void> {
  const temporary = `${leasePath}.candidate.${owner.token}`
  await mkdir(temporary, { mode: 0o700 })
  try {
    await createLeaseOwner(path.join(temporary, 'active.json'), owner)
    if (await lstat(leasePath).then(() => true, error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    })) throw Object.assign(new Error('lease exists'), { code: 'EEXIST' })
    await rename(temporary, leasePath)
  } catch (error) {
    await rm(temporary, { recursive: true, force: true }).catch(() => undefined)
    if (['ENOTEMPTY', 'EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      throw Object.assign(error as Error, { code: 'EEXIST' })
    }
    throw error
  }
}

async function createLeaseOwner(filePath: string, owner: LeaseOwner): Promise<void> {
  const handle = await open(filePath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL
    | (fsConstants.O_NOFOLLOW ?? 0), 0o600)
  try { await handle.writeFile(`${JSON.stringify(owner)}\n`); await handle.sync() }
  finally { await handle.close() }
}

async function readLeaseOwner(filePath: string): Promise<LeaseOwner | null> {
  try {
    const before = await lstat(filePath, { bigint: true })
    if (!before.isFile() || before.isSymbolicLink() || before.size > 1_024n) return null
    const handle = await open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
    try {
      const metadata = await handle.stat({ bigint: true })
      if (!metadata.isFile() || metadata.dev !== before.dev || metadata.ino !== before.ino) return null
      const value = JSON.parse(await handle.readFile('utf8')) as Partial<LeaseOwner>
      if (!Number.isSafeInteger(value.pid) || (value.pid ?? 0) <= 0
        || typeof value.birthIdentity !== 'string' || !value.birthIdentity
        || typeof value.token !== 'string' || !/^[0-9a-f-]+$/.test(value.token)) return null
      return value as LeaseOwner
    } finally { await handle.close() }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function processBirthIdentity(): string {
  return PROCESS_BIRTH_IDENTITY
}

function isLeaseOwnerAlive(owner: Readonly<{ pid: number; birthIdentity: string }>): boolean {
  if (owner.pid === process.pid) return owner.birthIdentity === PROCESS_BIRTH_IDENTITY
  try { process.kill(owner.pid, 0) }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH' }
  if (owner.birthIdentity.startsWith('linux:')) {
    const actual = readLinuxProcessBirthIdentity(owner.pid)
    return actual === null || actual === owner.birthIdentity
  }
  return true
}

function readLinuxProcessBirthIdentity(pid: number): string | null {
  if (process.platform !== 'linux') return null
  try {
    // The comm field may contain spaces and parentheses. Fields after its last
    // ')' begin with state; starttime is field 22, therefore index 19 here.
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)
    return fields[19] ? `linux:${fields[19]}` : null
  } catch { return null }
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
