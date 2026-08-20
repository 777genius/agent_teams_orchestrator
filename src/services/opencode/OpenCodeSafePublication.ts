import { randomUUID } from 'node:crypto'
import { constants as fsConstants, fsyncSync, renameSync, unlinkSync } from 'node:fs'
import { link, lstat, mkdir, open, readdir, realpath, rename, rm, unlink, type FileHandle } from 'node:fs/promises'
import path from 'node:path'

export type OpenCodeSafePublicationTransaction = Readonly<{
  commit(): Promise<void>
  rollback(): Promise<void>
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
  if (!value || value === '.' || value === '..' || path.basename(value) !== value) return fail()
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

  private constructor(
    handle: FileHandle | null,
    root?: string,
    windowsIdentity: { dev: bigint; ino: bigint } | null = null,
  ) {
    this.#handle = handle
    this.#root = root ?? descriptorRoot(handle!.fd)
    this.#windowsIdentity = windowsIdentity
  }

  static async open(directoryPath: string): Promise<OpenCodeSafePublicationDirectory> {
    if (process.platform === 'win32') {
      const resolved = path.resolve(directoryPath)
      const before = await lstat(resolved, { bigint: true }).catch(fail)
      const canonical = await realpath(resolved).catch(fail)
      if (!before.isDirectory() || before.isSymbolicLink()
        || canonical.replace(/^\\\\\?\\/, '').toLowerCase()
          !== resolved.replace(/^\\\\\?\\/, '').toLowerCase()
        || (before.dev === 0n && before.ino === 0n)) fail()
      return new OpenCodeSafePublicationDirectory(null, resolved, {
        dev: before.dev,
        ino: before.ino,
      })
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

  async #assertWindowsRoot(): Promise<void> {
    if (!this.#windowsIdentity) return
    const metadata = await lstat(this.#root, { bigint: true }).catch(fail)
    const canonical = await realpath(this.#root).catch(fail)
    if (!metadata.isDirectory() || metadata.isSymbolicLink()
      || metadata.dev !== this.#windowsIdentity.dev
      || metadata.ino !== this.#windowsIdentity.ino
      || canonical.replace(/^\\\\\?\\/, '').toLowerCase()
        !== this.#root.replace(/^\\\\\?\\/, '').toLowerCase()) fail()
  }

  /** Descriptor-root path for composing additional no-follow directory operations. */
  descriptorPath(): string {
    return this.#root
  }

  /** Stable identity captured by the opened directory, even when Windows uses its shared pathname. */
  async stableIdentity(): Promise<Readonly<{ dev: bigint; ino: bigint }>> {
    if (this.#windowsIdentity) return this.#windowsIdentity
    const metadata = await this.#handle!.stat({ bigint: true }).catch(fail)
    if (!metadata.isDirectory()) fail()
    return { dev: metadata.dev, ino: metadata.ino }
  }

  async openChildDirectory(name: string): Promise<OpenCodeSafePublicationDirectory> {
    await this.#assertWindowsRoot()
    const child = this.child(name)
    if (process.platform === 'win32') return OpenCodeSafePublicationDirectory.open(child)
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
    await mkdir(this.child(name), { mode })
    await this.sync()
    await afterCreatedEntrySynced?.(this.child(name))
    return this.openChildDirectory(name)
  }

  async regularFileModifiedAt(name: string): Promise<number> {
    await this.#assertWindowsRoot()
    const metadata = await lstat(this.child(name))
    if (!metadata.isFile() || metadata.isSymbolicLink()) fail()
    return metadata.mtimeMs
  }

  async childDirectoryModifiedAt(name: string): Promise<number> {
    await this.#assertWindowsRoot()
    const metadata = await lstat(this.child(name))
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail()
    return metadata.mtimeMs
  }

  async childNames(): Promise<readonly string[]> {
    await this.#assertWindowsRoot()
    const names = await readdir(this.#root)
    await this.#assertWindowsRoot()
    return names
  }

  /** Durably records prior immutable child creation before a commit is exposed. */
  async sync(): Promise<void> {
    // Windows does not expose directory fsync through Node. Publication still
    // uses FlushFileBuffers for each file; Windows CI exercises the no-replace
    // namespace operations. POSIX additionally persists directory entries.
    await this.#handle?.sync().catch(fail)
    await this.#assertWindowsRoot()
  }

  /** Atomically detaches a proven real child directory before bounded garbage cleanup. */
  async retireChildDirectory(name: string, retiredName: string): Promise<void> {
    const opened = await this.openChildDirectory(name)
    try {
      await this.#assertWindowsRoot()
      await rename(this.child(name), this.child(retiredName))
      await this.#handle?.sync().catch(fail)
    } finally { await opened.close().catch(() => undefined) }
    // The retired name is unguessable and no publisher can reuse it. A failure
    // here is harmless unreachable garbage and is retried by a later writer.
    await rm(this.child(retiredName), { recursive: true, force: true })
    await this.#assertWindowsRoot()
  }

  async readBoundedRegularFile(
    name: string,
    maximumBytes: number,
    abortSignal?: AbortSignal,
    testHooks?: { afterPathIdentityCaptured?: () => void | Promise<void> },
  ): Promise<string | null> {
    await this.#assertWindowsRoot()
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
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, result.bytesRead))
    } finally {
      await held.close()
    }
  }

  async removeRegularFile(name: string): Promise<void> {
    await this.#assertWindowsRoot()
    const target = this.child(name)
    let metadata
    try { metadata = await lstat(target) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
    if (!metadata.isFile() || metadata.isSymbolicLink()) fail()
    await unlink(target)
    await this.#handle?.sync().catch(fail)
    await this.#assertWindowsRoot()
  }

  async ensureRegularFile(name: string, mode = 0o600, abortSignal?: AbortSignal): Promise<void> {
    if (abortSignal?.aborted) throw abortSignal.reason ?? new Error('OpenCode safe publication cancelled')
    await this.#assertWindowsRoot()
    if (abortSignal?.aborted) throw abortSignal.reason ?? new Error('OpenCode safe publication cancelled')
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
      retainTransaction?: (transaction: OpenCodeSafePublicationTransaction) => void
    },
  ): Promise<void> {
    await this.#assertWindowsRoot()
    const finalName = childName(name)
    const temporaryName = childName(`.${finalName}.tmp.${process.pid}.${randomUUID()}`)
    const temporaryPath = this.child(temporaryName)
    const backupName = childName(`.${finalName}.rollback.${process.pid}.${randomUUID()}`)
    const backupPath = this.child(backupName)
    const quarantinePath = this.child(`.${finalName}.quarantine.${process.pid}.${randomUUID()}`)
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
        const finish = async (rollback: boolean): Promise<void> => {
          if (settled) return
          settled = true
          try {
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
          } finally {
            await unlink(quarantinePath).catch(() => undefined)
            await unlink(backupPath).catch(() => undefined)
            await this.#handle?.sync().catch(fail)
          }
        }
        testHooks.retainTransaction(Object.freeze({
          commit: () => finish(false),
          rollback: () => finish(true),
        }))
      } else if (priorLinked) unlinkSync(backupPath)
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
          await this.#handle?.sync().catch(fail)
        } catch (rollbackError) {
          if ((rollbackError as NodeJS.ErrnoException).code !== 'ENOENT') throw rollbackError
        }
      }
      await unlink(quarantinePath).catch(() => undefined)
      await unlink(backupPath).catch(() => undefined)
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
        await this.#handle?.sync().catch(fail)
      } catch (error) {
        if ((error as NodeJS.ErrnoException | undefined)?.code !== 'EEXIST') throw error
      }
    } catch (error) {
      throw error
    } finally {
      if (created) await created.close().catch(() => undefined)
      await unlink(temporaryPath).catch(() => undefined)
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

  async close(): Promise<void> {
    await this.#handle?.close()
  }
}

/** Creates only missing descendants beneath the nearest canonical existing ancestor. */
export async function ensureOpenCodeSafePublicationDirectory(
  directoryPath: string,
  durableAncestors = false,
  afterCreatedEntrySynced?: (path: string) => void | Promise<void>,
): Promise<OpenCodeSafePublicationDirectory> {
  const resolved = path.resolve(directoryPath)
  const missing: string[] = []
  let cursor = resolved
  for (;;) {
    try {
      const metadata = await lstat(cursor)
      if (!metadata.isDirectory() || metadata.isSymbolicLink()
        || await realpath(cursor) !== cursor) fail()
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
