import { createHash, randomUUID } from 'node:crypto'
import { constants as fsConstants, fsyncSync, renameSync, unlinkSync } from 'node:fs'
import { link, lstat, mkdir, open, readdir, realpath, rename, rm, unlink, type FileHandle } from 'node:fs/promises'
import path from 'node:path'
import {
  OpenCodeWindowsPublicationAuthorityClient,
  type OpenCodeWindowsPublicationAuthorityFactory,
} from './OpenCodeWindowsPublicationAuthorityClient.js'
import { validOpenCodePublicationLeaf,
  validOpenCodePublicationRoot } from './OpenCodeWindowsPublicationAuthorityProtocol.js'
import { OpenCodeWindowsPassiveReadAuthority } from './OpenCodeWindowsPassiveReadAuthority.js'

export type OpenCodeSafePublicationTransaction = Readonly<{
  commit(): Promise<void>
  rollback(): Promise<void>
}>

export type OpenCodeSafePublicationOpenOptions = Readonly<{
  abortSignal?: AbortSignal
  deadline?: number
  windowsAuthorityFactory?: OpenCodeWindowsPublicationAuthorityFactory
}>

/**
 * Caller-side contract for Windows operations not yet exposed by the native
 * retained namespace protocol. Implementations must resolve every name below
 * the already-open root and retain that root until the returned operation (or
 * release function) physically settles. They must never reopen an absolute
 * pathname.
 */
export type OpenCodeWindowsRetainedNamespacePort = Readonly<{
  namespaceList(path: string): Promise<readonly string[]>
  namespaceModifiedAt(path: string, kind: 'file' | 'directory'): Promise<number>
  /** Settles prior recovery records below path's retained parent before a successor publication. */
  namespaceRecoverAtomic(path: string, recoveryPrefix: string): Promise<'none' | 'recovered'>
  namespacePublishImmutable(path: string, content: Uint8Array): Promise<void>
  namespaceRemoveTree(path: string): Promise<void>
  namespaceAcquireLock(
    path: string,
    options: Readonly<{ stale: number; update: number; retries: Readonly<{ retries: number; minTimeout: number; maxTimeout: number }> }>,
    signal?: AbortSignal,
  ): Promise<() => Promise<void>>
}>

function fail(): never {
  throw new Error('OpenCode safe publication primitive is unavailable [redacted]')
}

function descriptorRoot(fd: number): string {
  if (process.platform === 'linux') return `/proc/self/fd/${fd}`
  if (process.platform === 'darwin') return `/dev/fd/${fd}`
  return fail()
}

function childName(value: string): string {
  if (!value || value === '.' || value === '..' || path.basename(value) !== value
    || (process.platform === 'win32' && !validOpenCodePublicationLeaf(value))) return fail()
  return value
}

function modeMatches(actual: number, expected: number): boolean {
  // Windows exposes only a coarse read-only bit through chmod/stat, so POSIX
  // mode equality cannot serve as a verifier at this platform boundary.
  return process.platform === 'win32' || (actual & 0o777) === expected
}

export class OpenCodeSafePublicationDirectory {
  readonly #handle: FileHandle | null
  readonly #root: string
  readonly #windowsIdentity: { dev: bigint; ino: bigint } | null
  readonly #windowsAuthority: OpenCodeWindowsPublicationAuthorityClient | null
  readonly #windowsPassiveAuthority: OpenCodeWindowsPassiveReadAuthority | null
  readonly #windowsKey: string
  readonly #ownsWindowsAuthority: boolean

  constructor(
    handle: FileHandle | null,
    root?: string,
    windowsIdentity: { dev: bigint; ino: bigint } | null = null,
    windowsAuthority: OpenCodeWindowsPublicationAuthorityClient | null = null,
    windowsKey = '.',
    ownsWindowsAuthority = true,
    windowsPassiveAuthority: OpenCodeWindowsPassiveReadAuthority | null = null,
  ) {
    this.#handle = handle
    this.#root = root ?? descriptorRoot(handle!.fd)
    this.#windowsIdentity = windowsIdentity
    this.#windowsAuthority = windowsAuthority
    this.#windowsKey = windowsKey
    this.#ownsWindowsAuthority = ownsWindowsAuthority
    this.#windowsPassiveAuthority = windowsPassiveAuthority
  }

  static async openReadOnly(directoryPath: string, options: OpenCodeSafePublicationOpenOptions = {}): Promise<OpenCodeSafePublicationDirectory> {
    if (process.platform !== 'win32') return this.open(directoryPath, options)
    const resolved = path.resolve(directoryPath)
    const passive = OpenCodeWindowsPassiveReadAuthority.open(resolved, {
      deadline: options.deadline ?? performance.now() + 10_000,
      signal: options.abortSignal,
    })
    try {
      const stable = passive.stableIdentity()
      return new OpenCodeSafePublicationDirectory(null, resolved, stable, null, '.', false, passive)
    } catch (error) { passive.close(); throw error }
  }

  static async open(directoryPath: string, options: OpenCodeSafePublicationOpenOptions = {}): Promise<OpenCodeSafePublicationDirectory> {
    if (process.platform === 'win32') {
      if (!validOpenCodePublicationRoot(directoryPath)) fail()
      const resolved = path.resolve(directoryPath)
      const authority = (options.windowsAuthorityFactory ?? (input => new OpenCodeWindowsPublicationAuthorityClient(input)))({
        deadline: options.deadline ?? performance.now() + 10_000, signal: options.abortSignal,
      })
      try {
        const identity = await authority.openRoot(resolved, false, false)
        return new OpenCodeSafePublicationDirectory(null, resolved, {
          dev: BigInt(identity.volumeSerial), ino: BigInt(identity.fileId),
        }, authority)
      } catch (error) { await authority.close(); throw error }
    }
    descriptorRoot(0)
    const resolved = path.resolve(directoryPath)
    const before = await lstat(resolved).catch(fail)
    if (!before.isDirectory() || before.isSymbolicLink()) fail()
    if (await realpath(resolved).catch(fail) !== resolved) fail()
    const handle = await open(
      resolved,
      fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0),
    ).catch(fail)
    try {
      const held = await handle.stat()
      const after = await lstat(resolved).catch(fail)
      if (
        !held.isDirectory() || !after.isDirectory() || after.isSymbolicLink()
        || held.dev !== before.dev || held.ino !== before.ino
        || held.dev !== after.dev || held.ino !== after.ino
        || (held.mode & 0o022) !== 0
        || (typeof process.getuid === 'function' && held.uid !== process.getuid())
      ) fail()
      return new OpenCodeSafePublicationDirectory(handle)
    } catch (error) {
      await handle.close().catch(() => undefined)
      throw error
    }
  }

  child(name: string): string {
    return path.join(this.#root, childName(name))
  }

  #relative(name: string): string {
    const leaf = childName(name)
    return this.#windowsKey === '.' ? leaf : `${this.#windowsKey}/${leaf}`
  }

  #namespacePort(): OpenCodeWindowsRetainedNamespacePort {
    const candidate = this.#windowsAuthority as unknown as Partial<OpenCodeWindowsRetainedNamespacePort> | null
    if (!candidate || typeof candidate.namespaceList !== 'function'
      || typeof candidate.namespacePublishImmutable !== 'function'
      || typeof candidate.namespaceRemoveTree !== 'function'
      || typeof candidate.namespaceModifiedAt !== 'function'
      || typeof candidate.namespaceRecoverAtomic !== 'function'
      || typeof candidate.namespaceAcquireLock !== 'function') fail()
    return candidate as OpenCodeWindowsRetainedNamespacePort
  }

  async #assertWindowsRoot(): Promise<void> {
    if (this.#windowsPassiveAuthority) this.#windowsPassiveAuthority.validate()
    if (!this.#windowsAuthority) return
    await this.#windowsAuthority.validateRoot().catch(fail)
  }

  /** Descriptor-root path for composing additional no-follow directory operations. */
  descriptorPath(): string {
    return this.#root
  }

  /** Stable identity captured by the opened directory, even when Windows uses its shared pathname. */
  async stableIdentity(): Promise<Readonly<{ dev: bigint; ino: bigint }>> {
    if (this.#windowsPassiveAuthority) return this.#windowsPassiveAuthority.stableIdentity()
    if (this.#windowsIdentity) return this.#windowsIdentity
    const metadata = await this.#handle!.stat({ bigint: true }).catch(fail)
    if (!metadata.isDirectory()) fail()
    return { dev: metadata.dev, ino: metadata.ino }
  }

  async validate(): Promise<void> {
    if (this.#windowsPassiveAuthority) return this.#windowsPassiveAuthority.validate()
    if (this.#windowsAuthority) return this.#assertWindowsRoot()
    const metadata = await this.#handle!.stat().catch(fail)
    if (!metadata.isDirectory()) fail()
  }

  /** Retains the primary SQLite object without delete sharing until this directory closes. */
  async pinRegularFile(name: string, denyWrites = false): Promise<void> {
    if (this.#windowsPassiveAuthority) { this.#windowsPassiveAuthority.pinRegular(childName(name)); return }
    if (this.#windowsAuthority) await this.#windowsAuthority.pinRegular(childName(name), denyWrites, this.#windowsKey).catch(fail)
  }

  async openChildDirectory(name: string): Promise<OpenCodeSafePublicationDirectory> {
    await this.#assertWindowsRoot()
    const child = this.child(name)
    if (process.platform === 'win32') {
      if (this.#windowsPassiveAuthority) {
        const passive = this.#windowsPassiveAuthority.openChild(childName(name))
        const stable = passive.stableIdentity()
        return new OpenCodeSafePublicationDirectory(null, child, stable, null, '.', false, passive)
      }
      if (!this.#windowsAuthority) fail()
      const childKey = this.#windowsKey === '.' ? childName(name) : `${this.#windowsKey}/${childName(name)}`
      const identity = await this.#windowsAuthority.openChildDirectory(this.#windowsKey, childKey, childName(name)).catch(fail)
      return new OpenCodeSafePublicationDirectory(null, child, {
        dev: BigInt(identity.volumeSerial), ino: BigInt(identity.fileId),
      }, this.#windowsAuthority, childKey, false)
    }
    let handle: FileHandle
    try {
      handle = await open(
        child,
        fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0),
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw error
      fail()
    }
    try {
      const metadata = await handle.stat()
      if (!metadata.isDirectory() || metadata.isSymbolicLink()
        || (typeof process.getuid === 'function' && metadata.uid !== process.getuid())) fail()
      await this.#assertWindowsRoot()
      return new OpenCodeSafePublicationDirectory(handle)
    } catch (error) {
      await handle.close().catch(() => undefined)
      throw error
    }
  }

  async ensureChildDirectory(name: string, mode = 0o700): Promise<OpenCodeSafePublicationDirectory> {
    await this.#assertWindowsRoot()
    const child = this.child(name)
    if (process.platform === 'win32' && this.#windowsAuthority) {
      await this.#windowsAuthority.namespaceMkdir(this.#relative(name)).catch(error => {
        if (!(error instanceof Error && 'authorityCode' in error
          && (error as { authorityCode: string }).authorityCode === 'NS_EXISTS')) throw error
      })
      return this.openChildDirectory(name)
    }
    try { await mkdir(child, { mode }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    const opened = await this.openChildDirectory(name)
    await this.#assertWindowsRoot()
    return opened
  }

  /** Passive-store seam: persist a newly-created child entry before continuing. */
  async ensureChildDirectoryDurable(
    name: string,
    mode = 0o700,
    afterCreatedEntrySynced?: (path: string) => void | Promise<void>,
  ): Promise<OpenCodeSafePublicationDirectory> {
    await this.#assertWindowsRoot()
    const child = this.child(name)
    if (process.platform === 'win32' && this.#windowsAuthority) {
      let created = false
      await this.#windowsAuthority.namespaceMkdir(this.#relative(name)).then(() => { created = true }, error => {
        if (!(error instanceof Error && 'authorityCode' in error
          && (error as { authorityCode: string }).authorityCode === 'NS_EXISTS')) throw error
      })
      await this.#windowsAuthority.namespaceSyncDirectory(this.#windowsKey)
      if (created) await afterCreatedEntrySynced?.(child)
      return this.openChildDirectory(name)
    }
    let created = false
    try { await mkdir(child, { mode }); created = true }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    // Sync even after EEXIST: a concurrent creator may not yet have persisted
    // the entry, while this publication can still be the first to return.
    await this.sync()
    if (created) await afterCreatedEntrySynced?.(child)
    const opened = await this.openChildDirectory(name)
    await this.#assertWindowsRoot()
    return opened
  }

  /** Atomically claims a never-before-used child name and persists that claim. */
  async createChildDirectoryExclusive(
    name: string,
    mode = 0o700,
    afterCreatedEntrySynced?: (path: string) => void | Promise<void>,
  ): Promise<OpenCodeSafePublicationDirectory> {
    await this.#assertWindowsRoot()
    if (process.platform === 'win32' && this.#windowsAuthority) {
      const identity = await this.#windowsAuthority.createDirectory(childName(name)).catch(fail)
      await afterCreatedEntrySynced?.(this.child(name))
      // Borrow the exact child retained by the parent authority. Opening a
      // second authority would require delete sharing and weaken the lease.
      return new OpenCodeSafePublicationDirectory(null, this.child(name), {
        dev: BigInt(identity.volumeSerial), ino: BigInt(identity.fileId),
      }, this.#windowsAuthority, childName(name), false)
    }
    await mkdir(this.child(name), { mode })
    await this.sync()
    await afterCreatedEntrySynced?.(this.child(name))
    return this.openChildDirectory(name)
  }

  /** Renames a Windows child by its retained native handle, never by reopening its path. */
  async renameRetainedChildDirectory(from: string, to: string): Promise<void> {
    if (!this.#windowsAuthority) fail()
    await this.#windowsAuthority.renameDirectory(childName(from), childName(to)).catch(fail)
    await this.#assertWindowsRoot()
  }

  /** Deletes only the exact retained attempt tree, and is safe to retry. */
  async rollbackRetainedChildDirectory(rootKey: string): Promise<void> {
    if (!this.#windowsAuthority) fail()
    await this.#windowsAuthority.rollbackDirectory(childName(rootKey)).catch(fail)
  }

  /** Creates and retains a descendant directory relative to an already-retained parent. */
  async createRetainedDescendantDirectory(parentKey: string, key: string, name: string): Promise<void> {
    if (!this.#windowsAuthority) fail()
    await this.#windowsAuthority.createChildDirectory(parentKey, key, childName(name)).catch(fail)
  }

  /** Creates and writes a descendant file entirely through its retained native handle. */
  async writeRetainedDescendantFile(parentKey: string, key: string, name: string, bytes: Uint8Array): Promise<void> {
    if (!this.#windowsAuthority) fail()
    await this.#windowsAuthority.createChildFile(parentKey, key, childName(name)).catch(fail)
    const chunkSize = 32 * 1024
    let offset = 0
    do {
      const end = Math.min(bytes.byteLength, offset + chunkSize)
      offset = await this.#windowsAuthority.writeChildFile(
        key, offset, bytes.subarray(offset, end), end === bytes.byteLength,
      ).catch(fail)
    } while (offset < bytes.byteLength)
  }

  async regularFileModifiedAt(name: string): Promise<number> {
    await this.#assertWindowsRoot()
    if (this.#windowsAuthority) return this.#namespacePort().namespaceModifiedAt(this.#relative(name), 'file')
    const metadata = await lstat(this.child(name))
    if (!metadata.isFile() || metadata.isSymbolicLink()) fail()
    return metadata.mtimeMs
  }

  async childDirectoryModifiedAt(name: string): Promise<number> {
    await this.#assertWindowsRoot()
    if (this.#windowsAuthority) return this.#namespacePort().namespaceModifiedAt(this.#relative(name), 'directory')
    const metadata = await lstat(this.child(name))
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail()
    return metadata.mtimeMs
  }

  async childNames(): Promise<readonly string[]> {
    if (this.#windowsPassiveAuthority) return this.#windowsPassiveAuthority.childNames()
    if (this.#windowsAuthority) return this.#namespacePort().namespaceList(this.#windowsKey)
    await this.#assertWindowsRoot()
    const names = await readdir(this.#root)
    await this.#assertWindowsRoot()
    return names
  }

  /** Durably records prior immutable child creation before a commit is exposed. */
  async sync(): Promise<void> {
    if (this.#windowsAuthority) await this.#windowsAuthority.syncRoot().catch(fail)
    else await this.#handle?.sync().catch(fail)
    await this.#assertWindowsRoot()
  }

  /** Atomically detaches a proven real child directory before bounded garbage cleanup. */
  async retireChildDirectory(name: string, retiredName: string): Promise<void> {
    if (this.#windowsAuthority) {
      await this.#windowsAuthority.namespaceRename(this.#relative(name), this.#relative(retiredName)).catch(fail)
      await this.#namespacePort().namespaceRemoveTree(this.#relative(retiredName)).catch(fail)
      await this.#windowsAuthority.namespaceSyncDirectory(this.#windowsKey).catch(fail)
      return
    }
    const opened = await this.openChildDirectory(name)
    try {
      await this.#assertWindowsRoot()
      await rename(this.child(name), this.child(retiredName))
      await this.sync()
    } finally { await opened.close().catch(() => undefined) }
    // The retired name is unguessable and no publisher can reuse it. A failure
    // here is harmless unreachable garbage and is retried by a later writer.
    await rm(this.child(retiredName), { recursive: true, force: true })
    await this.sync()
    await this.#assertWindowsRoot()
  }

  async readBoundedRegularBytes(
    name: string,
    maximumBytes: number,
    abortSignal?: AbortSignal,
    testHooks?: { afterPathIdentityCaptured?: () => void | Promise<void> },
  ): Promise<Uint8Array | null> {
    if (this.#windowsPassiveAuthority) {
      return this.#windowsPassiveAuthority.readBounded(childName(name), maximumBytes, abortSignal)
    }
    await this.#assertWindowsRoot()
    if (this.#windowsAuthority) {
      const relative = this.#relative(name)
      let metadata
      try { metadata = await this.#windowsAuthority.namespaceStat(relative) }
      catch (error) {
        if (error instanceof Error && 'authorityCode' in error
          && (error as { authorityCode: string }).authorityCode === 'NS_NOT_FOUND') return null
        throw error
      }
      if (metadata.kind !== 'file' || BigInt(metadata.size) > BigInt(maximumBytes)) fail()
      if (abortSignal?.aborted) throw abortSignal.reason ?? new Error('OpenCode safe publication cancelled')
      const opened = await this.#windowsAuthority.namespaceOpen(relative, 'read').catch(fail)
      try {
        if (opened.kind !== 'file' || opened.volumeSerial !== metadata.volumeSerial
          || opened.fileId !== metadata.fileId || opened.size !== metadata.size) fail()
        await testHooks?.afterPathIdentityCaptured?.()
        if (abortSignal?.aborted) throw abortSignal.reason ?? new Error('OpenCode safe publication cancelled')
        const bytes = await this.#windowsAuthority.namespaceRead(opened.token, Number(opened.size)).catch(fail)
        if (bytes.byteLength !== Number(opened.size)) fail()
        return bytes
      } finally { await this.#windowsAuthority.namespaceCloseHandle(opened.token).catch(fail) }
    }
    const target = this.child(name)
    let before
    try { before = await lstat(target, { bigint: true }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
    if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(maximumBytes)) fail()
    if (process.platform === 'win32') {
      const canonical = (await realpath(target).catch(fail)).replace(/^\\\\\?\\/, '').toLowerCase()
      const expected = path.resolve(target).replace(/^\\\\\?\\/, '').toLowerCase()
      if (canonical !== expected || (before.dev === 0n && before.ino === 0n)) fail()
    }
    await testHooks?.afterPathIdentityCaptured?.()
    const held = await open(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)).catch(fail)
    try {
      const opened = await held.stat({ bigint: true })
      if (!opened.isFile() || opened.isSymbolicLink()
        || opened.dev !== before.dev || opened.ino !== before.ino) fail()
      if (abortSignal?.aborted) throw new Error('OpenCode safe publication cancelled')
      const bytes = Buffer.alloc(maximumBytes + 1)
      const result = await held.read(bytes, 0, bytes.length, 0)
      if (result.bytesRead > maximumBytes) return null
      const afterHeld = await held.stat({ bigint: true })
      const afterPath = await lstat(target, { bigint: true }).catch(fail)
      if (!afterPath.isFile() || afterPath.isSymbolicLink()
        || afterHeld.dev !== opened.dev || afterHeld.ino !== opened.ino
        || afterPath.dev !== opened.dev || afterPath.ino !== opened.ino
        || afterHeld.size !== opened.size) fail()
      await this.#assertWindowsRoot()
      if (abortSignal?.aborted) throw new Error('OpenCode safe publication cancelled')
      return bytes.subarray(0, result.bytesRead)
    } finally {
      await held.close()
    }
  }

  async readBoundedRegularFile(
    name: string,
    maximumBytes: number,
    abortSignal?: AbortSignal,
    testHooks?: { afterPathIdentityCaptured?: () => void | Promise<void> },
  ): Promise<string | null> {
    const bytes = await this.readBoundedRegularBytes(name, maximumBytes, abortSignal, testHooks)
    return bytes && new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  }

  async removeRegularFile(name: string): Promise<void> {
    await this.#assertWindowsRoot()
    if (this.#windowsAuthority) {
      const relative = this.#relative(name)
      try {
        const metadata = await this.#windowsAuthority.namespaceStat(relative)
        if (metadata.kind !== 'file') fail()
        await this.#windowsAuthority.namespaceUnlink(relative, false)
        await this.#windowsAuthority.namespaceSyncDirectory(this.#windowsKey)
        return
      } catch (error) {
        if (error instanceof Error && 'authorityCode' in error
          && (error as { authorityCode: string }).authorityCode === 'NS_NOT_FOUND') return
        throw error
      }
    }
    const target = this.child(name)
    let metadata
    try { metadata = await lstat(target) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
    if (!metadata.isFile() || metadata.isSymbolicLink()) fail()
    await unlink(target)
    await this.sync()
    await this.#assertWindowsRoot()
  }

  async ensureRegularFile(name: string, mode = 0o600, abortSignal?: AbortSignal): Promise<void> {
    if (abortSignal?.aborted) throw abortSignal.reason ?? new Error('OpenCode safe publication cancelled')
    await this.#assertWindowsRoot()
    if (abortSignal?.aborted) throw abortSignal.reason ?? new Error('OpenCode safe publication cancelled')
    if (this.#windowsAuthority) {
      const relative = this.#relative(name)
      let token: string | null = null
      try {
        token = (await this.#windowsAuthority.namespaceOpen(relative, 'create_file')).token
        await this.#windowsAuthority.namespaceSyncHandle(token)
      } catch (error) {
        if (!(error instanceof Error && 'authorityCode' in error
          && (error as { authorityCode: string }).authorityCode === 'NS_EXISTS')) throw error
        const existing = await this.#windowsAuthority.namespaceStat(relative)
        if (existing.kind !== 'file') fail()
      } finally {
        if (token) await this.#windowsAuthority.namespaceCloseHandle(token).catch(fail)
      }
      await this.#windowsAuthority.namespaceSyncDirectory(this.#windowsKey)
      return
    }
    const handle = await open(
      this.child(name),
      fsConstants.O_RDWR | fsConstants.O_CREAT | (fsConstants.O_NOFOLLOW ?? 0),
      mode,
    ).catch(fail)
    try {
      const metadata = await handle.stat()
      if (
        !metadata.isFile() || metadata.isSymbolicLink()
        || (typeof process.getuid === 'function' && metadata.uid !== process.getuid())
      ) fail()
      await handle.chmod(mode)
      if (abortSignal?.aborted) throw abortSignal.reason ?? new Error('OpenCode safe publication cancelled')
    } finally {
      await handle.close()
    }
    await this.#assertWindowsRoot()
  }

  async writeFileAtomic(
    name: string,
    content: string | Uint8Array,
    mode = 0o600,
    abortSignal?: AbortSignal,
    testHooks?: {
      afterRenameBeforeVerification?: () => void | Promise<void>
      afterRollbackOwnershipCaptured?: () => void | Promise<void>
      beforeSettlementSync?: () => void | Promise<void>
      retainTransaction?: (transaction: OpenCodeSafePublicationTransaction) => void
      expectedPriorSha256?: string | null
    },
  ): Promise<void> {
    await this.#assertWindowsRoot()
    const finalName = childName(name)
    const temporaryName = childName(`.${finalName}.tmp.${process.pid}.${randomUUID()}`)
    const temporaryPath = this.child(temporaryName)
    const backupName = childName(`.${finalName}.rollback.${process.pid}.${randomUUID()}`)
    const backupPath = this.child(backupName)
    const quarantineName = childName(`.${finalName}.quarantine.${process.pid}.${randomUUID()}`)
    const quarantinePath = this.child(quarantineName)
    const recoveryName = childName(`.${finalName}.recovery-required.${process.pid}.${randomUUID()}`)
    if (!this.#windowsAuthority && testHooks && Object.hasOwn(testHooks, 'expectedPriorSha256')) {
      const current = await this.readBoundedRegularBytes(finalName, 1_048_576, abortSignal)
      const observed = current === null ? null : createHash('sha256').update(current).digest('hex')
      if (observed !== testHooks.expectedPriorSha256) fail()
    }
    if (process.platform === 'win32' && this.#windowsAuthority) {
      const bytes = typeof content === 'string' ? Buffer.from(content) : new Uint8Array(content)
      try {
        const recoveryPrefix = `.${finalName}.recovery-required.`.toLowerCase()
        const recovery = await this.#namespacePort()
          .namespaceRecoverAtomic(this.#relative(finalName), recoveryPrefix).catch(fail)
        if (recovery !== 'none' && recovery !== 'recovered') fail()
        await this.#assertWindowsRoot()
        await this.#windowsAuthority.prepareAtomic(
          finalName, temporaryName, backupName, quarantineName, recoveryName, bytes,
          testHooks?.expectedPriorSha256, this.#windowsKey,
        ).catch(fail)
        await testHooks?.afterRenameBeforeVerification?.()
        if (abortSignal?.aborted) throw abortSignal.reason ?? new Error('OpenCode safe publication cancelled')
        if (testHooks?.retainTransaction) {
          let settled = false
          let inFlight: Promise<void> | null = null
          const settle = (rollback: boolean): Promise<void> => {
            if (settled) return Promise.resolve()
            if (inFlight) return inFlight
            inFlight = Promise.resolve().then(() => testHooks.beforeSettlementSync?.())
              .then(() => rollback ? this.#windowsAuthority!.rollbackAtomic() : this.#windowsAuthority!.commitAtomic())
              .then(() => { settled = true })
              .finally(() => { if (!settled) inFlight = null })
            return inFlight
          }
          testHooks.retainTransaction(Object.freeze({ commit: () => settle(false), rollback: () => settle(true) }))
        } else {
          await this.#windowsAuthority.commitAtomic().catch(fail)
        }
        return
      } catch (error) {
        await this.#windowsAuthority.rollbackAtomic().catch(() => undefined)
        throw error
      }
    }
    let handle: FileHandle | null = null
    let temporaryIdentity: Awaited<ReturnType<FileHandle['stat']>> | null = null
    let priorLinked = false
    let published = false
    try {
      handle = await open(
        temporaryPath,
        fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL
          | (fsConstants.O_NOFOLLOW ?? 0),
        mode,
      ).catch(fail)
      await handle.writeFile(content)
      await handle.chmod(mode)
      await handle.sync()
      temporaryIdentity = await handle.stat()
      const expectedBytes = Buffer.from(content)
      const temporaryBytes = Buffer.alloc(expectedBytes.length + 1)
      const temporaryRead = await handle.read(temporaryBytes, 0, temporaryBytes.length, 0)
      if (!temporaryIdentity.isFile() || !modeMatches(temporaryIdentity.mode, mode)
        || temporaryRead.bytesRead !== expectedBytes.length
        || !temporaryBytes.subarray(0, temporaryRead.bytesRead).equals(expectedBytes)) fail()
      await handle.close()
      handle = null
      if (abortSignal?.aborted) {
        throw abortSignal.reason instanceof Error
          ? abortSignal.reason
          : new Error('OpenCode safe publication cancelled')
      }
      // Preserve the complete prior inode before the sole visibility
      // transition. A failed attempt can restore it without reconstructing
      // bytes or touching a successor-owned inode.
      try {
        const prior = await lstat(this.child(finalName))
        if (!prior.isFile() || prior.isSymbolicLink()
          || (typeof process.getuid === 'function' && prior.uid !== process.getuid())) fail()
        await link(this.child(finalName), backupPath)
        const backup = await lstat(backupPath)
        if (!backup.isFile() || backup.isSymbolicLink()
          || backup.dev !== prior.dev || backup.ino !== prior.ino) fail()
        priorLinked = true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') fail()
      }
      await this.#assertWindowsRoot()
      if (abortSignal?.aborted) {
        throw abortSignal.reason instanceof Error
          ? abortSignal.reason
          : new Error('OpenCode safe publication cancelled')
      }
      renameSync(temporaryPath, this.child(finalName))
      published = true
      if (this.#handle) fsyncSync(this.#handle.fd)
      else await this.sync()
      if (testHooks?.afterRenameBeforeVerification) {
        await testHooks.afterRenameBeforeVerification()
        if (abortSignal?.aborted) {
          throw abortSignal.reason instanceof Error
            ? abortSignal.reason
            : new Error('OpenCode safe publication cancelled')
        }
      }
      if (testHooks?.retainTransaction) {
        let settled = false
        let settlement: Promise<void> | null = null
        const finish = async (rollback: boolean): Promise<void> => {
          if (settled) return
          if (settlement) return settlement
          settlement = (async () => {
            if (rollback && temporaryIdentity) {
              // Capture and prove the currently named object before changing
              // its visibility. A successor or any verification failure is a
              // no-op with respect to the current auth path.
              try {
                await link(this.child(finalName), quarantinePath)
                const captured = await lstat(quarantinePath)
                if (captured.isFile() && !captured.isSymbolicLink()
                  && captured.dev === temporaryIdentity.dev && captured.ino === temporaryIdentity.ino) {
                  const current = await lstat(this.child(finalName))
                  if (current.isFile() && !current.isSymbolicLink()
                    && current.dev === temporaryIdentity.dev && current.ino === temporaryIdentity.ino) {
                    await unlink(this.child(finalName))
                    if (priorLinked) {
                      try { await link(backupPath, this.child(finalName)) }
                      catch (restoreError) {
                        if ((restoreError as NodeJS.ErrnoException).code !== 'EEXIST') fail()
                      }
                    }
                  }
                }
              } catch (rollbackError) {
                if ((rollbackError as NodeJS.ErrnoException).code !== 'ENOENT') throw rollbackError
              }
            }
            // Settlement records remain intact until every required mutation is
            // durable. A failed commit/rollback is retryable and is never
            // reported as settled merely because cleanup began.
            await unlink(quarantinePath).catch(error => {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
            })
            await unlink(backupPath).catch(error => {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
            })
            await testHooks.beforeSettlementSync?.()
            await this.sync()
            settled = true
          })()
          try { await settlement }
          finally { if (!settled) settlement = null }
        }
        testHooks.retainTransaction(Object.freeze({
          commit: () => finish(false),
          rollback: () => finish(true),
        }))
      } else if (priorLinked) {
        unlinkSync(backupPath)
        await this.sync()
      }
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined)
      await unlink(temporaryPath).catch(() => undefined)
      if (published && temporaryIdentity) {
        // Establish ownership without first renaming or removing the current
        // auth path. A hard link captures the object named at that instant;
        // lstat/link failures leave the visible name completely untouched.
        try {
          await link(this.child(finalName), quarantinePath)
          const quarantined = await lstat(quarantinePath)
          const owned = quarantined.isFile() && !quarantined.isSymbolicLink()
            && quarantined.dev === temporaryIdentity.dev && quarantined.ino === temporaryIdentity.ino
          if (owned) {
            await testHooks?.afterRollbackOwnershipCaptured?.()
            // Recheck the pathname after the deterministic/concurrent boundary.
            // A successor that won remains continuously visible and is never
            // moved merely so rollback can discover who owned it.
            const current = await lstat(this.child(finalName))
            if (current.isFile() && !current.isSymbolicLink()
              && current.dev === temporaryIdentity.dev && current.ino === temporaryIdentity.ino) {
              await unlink(this.child(finalName))
            }
          }
          if (owned && priorLinked) {
            try { await link(backupPath, this.child(finalName)) }
            catch (restoreError) {
              if ((restoreError as NodeJS.ErrnoException).code !== 'EEXIST') fail()
            }
          }
        } catch (rollbackError) {
          if ((rollbackError as NodeJS.ErrnoException).code !== 'ENOENT') throw rollbackError
        }
      }
      await unlink(quarantinePath).catch(() => undefined)
      await unlink(backupPath).catch(() => undefined)
      await this.sync()
      throw error
    }
  }

  async publishImmutableFile(
    name: string,
    content: string | Uint8Array,
    mode: number,
    testHooks?: { afterTemporaryWrite?: () => void | Promise<void> },
    abortSignal?: AbortSignal,
  ): Promise<void> {
    if (abortSignal?.aborted) throw abortSignal.reason ?? new Error('OpenCode safe publication cancelled')
    await this.#assertWindowsRoot()
    const finalName = childName(name)
    if (this.#windowsAuthority) {
      await testHooks?.afterTemporaryWrite?.()
      if (abortSignal?.aborted) throw abortSignal.reason ?? new Error('OpenCode safe publication cancelled')
      await this.#namespacePort().namespacePublishImmutable(this.#relative(finalName), Buffer.from(content)).catch(fail)
      await this.#windowsAuthority.namespaceSyncDirectory(this.#windowsKey).catch(fail)
      return
    }
    const target = this.child(finalName)
    const expected = Buffer.from(content)
    const temporaryPath = this.child(`.${finalName}.immutable.${process.pid}.${randomUUID()}`)
    let created: FileHandle | null = null
    try {
      created = await open(
        temporaryPath,
        fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL
          | (fsConstants.O_NOFOLLOW ?? 0),
        mode,
      )
      await created.writeFile(expected)
      await testHooks?.afterTemporaryWrite?.()
      if (abortSignal?.aborted) throw abortSignal.reason ?? new Error('OpenCode safe publication cancelled')
      await created.chmod(mode)
      await created.sync()
      const createdIdentity = await created.stat()
      if (!createdIdentity.isFile() || !modeMatches(createdIdentity.mode, mode)) fail()
      await created.close()
      created = null
      try {
        // link(2) is an atomic no-replace publication: the final name never
        // refers to an inode until all immutable bytes have been synchronized.
        if (abortSignal?.aborted) throw abortSignal.reason ?? new Error('OpenCode safe publication cancelled')
        await link(temporaryPath, target)
        await this.sync()
      } catch (error) {
        if ((error as NodeJS.ErrnoException | undefined)?.code !== 'EEXIST') throw error
      }
    } catch (error) {
      throw error
    } finally {
      if (created) await created.close().catch(() => undefined)
      await unlink(temporaryPath).catch(() => undefined)
      await this.sync()
    }
    const held = await open(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)).catch(fail)
    try {
      const metadata = await held.stat()
      const actual = await held.readFile()
      if (
        !metadata.isFile() || !actual.equals(expected) || !modeMatches(metadata.mode, mode)
        || (typeof process.getuid === 'function' && metadata.uid !== process.getuid())
      ) fail()
      // Flush again after the no-replace link exists. On Windows this is the
      // available durable namespace barrier: FlushFileBuffers on the linked
      // file persists its file record and link metadata. POSIX additionally
      // synchronizes the held parent directory above.
      await held.sync().catch(fail)
    } finally {
      await held.close()
    }
    await this.#assertWindowsRoot()
  }

  /** Cross-process lock whose namespace is owned by this retained authority. */
  async acquireRetainedLock(
    name: string,
    options: Readonly<{ stale: number; update: number; retries: Readonly<{ retries: number; minTimeout: number; maxTimeout: number }> }>,
    signal?: AbortSignal,
  ): Promise<() => Promise<void>> {
    if (!this.#windowsAuthority) fail()
    return this.#namespacePort().namespaceAcquireLock(this.#relative(name), options, signal)
  }

  async close(): Promise<void> {
    this.#windowsPassiveAuthority?.close()
    if (this.#windowsAuthority && this.#ownsWindowsAuthority) await this.#windowsAuthority.close()
    else await this.#handle?.close()
  }
}

/** Creates only missing descendants beneath the nearest canonical existing ancestor. */
export async function ensureOpenCodeSafePublicationDirectory(
  directoryPath: string,
  durableAncestors = false,
  afterCreatedEntrySynced?: (path: string) => void | Promise<void>,
  options: OpenCodeSafePublicationOpenOptions = {},
): Promise<OpenCodeSafePublicationDirectory> {
  const resolved = path.resolve(directoryPath)
  if (process.platform === 'win32') {
    if (!validOpenCodePublicationRoot(directoryPath)) fail()
    const authority = (options.windowsAuthorityFactory ?? (input => new OpenCodeWindowsPublicationAuthorityClient(input)))({
      deadline: options.deadline ?? performance.now() + 10_000, signal: options.abortSignal,
    })
    try {
      const identity = await authority.openRoot(resolved, true, durableAncestors)
      for (const created of identity.createdPaths) await afterCreatedEntrySynced?.(created)
      return new OpenCodeSafePublicationDirectory(null, resolved,
        { dev: BigInt(identity.volumeSerial), ino: BigInt(identity.fileId) }, authority)
    } catch (error) { await authority.close(); throw error }
  }
  const missing: string[] = []
  let cursor = resolved
  for (;;) {
    try {
      const metadata = await lstat(cursor)
      const canonical = await realpath(cursor)
      if (!metadata.isDirectory() || metadata.isSymbolicLink()
        || !sameCanonicalPath(canonical, cursor)) fail()
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = path.dirname(cursor)
      if (parent === cursor) fail()
      missing.unshift(path.basename(cursor))
      cursor = parent
    }
  }
  let directory = await OpenCodeSafePublicationDirectory.open(cursor)
  try {
    for (const component of missing) {
      const child = durableAncestors
        ? await directory.ensureChildDirectoryDurable(component, 0o700, afterCreatedEntrySynced)
        : await directory.ensureChildDirectory(component)
      await directory.close()
      directory = child
    }
    return directory
  } catch (error) {
    await directory.close().catch(() => undefined)
    throw error
  }
}

function sameCanonicalPath(left: string, right: string): boolean {
  if (process.platform !== 'win32') return left === right
  const normalize = (value: string) => path.win32.normalize(value)
    .replace(/^\\\\\?\\/, '').toLowerCase()
  return normalize(left) === normalize(right)
}

export async function withOpenCodeSafePublicationDirectory<T>(
  directoryPath: string,
  operation: (directory: OpenCodeSafePublicationDirectory) => Promise<T>,
): Promise<T> {
  const directory = await OpenCodeSafePublicationDirectory.open(directoryPath)
  try {
    return await operation(directory)
  } finally {
    await directory.close()
  }
}
