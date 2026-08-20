import { randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { link, lstat, open, realpath, rename, unlink, type FileHandle } from 'node:fs/promises'
import path from 'node:path'

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

  async ensureRegularFile(name: string, mode = 0o600): Promise<void> {
    await this.#assertWindowsRoot()
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
  ): Promise<void> {
    await this.#assertWindowsRoot()
    const finalName = childName(name)
    const temporaryName = childName(`.${finalName}.tmp.${process.pid}.${randomUUID()}`)
    const temporaryPath = this.child(temporaryName)
    let handle: FileHandle | null = null
    try {
      handle = await open(
        temporaryPath,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL
          | (fsConstants.O_NOFOLLOW ?? 0),
        mode,
      ).catch(fail)
      await handle.writeFile(content)
      await handle.chmod(mode)
      await handle.sync()
      const temporaryIdentity = await handle.stat()
      if (!temporaryIdentity.isFile() || !modeMatches(temporaryIdentity.mode, mode)) fail()
      await handle.close()
      handle = null
      if (abortSignal?.aborted) {
        throw abortSignal.reason instanceof Error
          ? abortSignal.reason
          : new Error('OpenCode safe publication cancelled')
      }
      await rename(temporaryPath, this.child(finalName)).catch(fail)
      const publishedHandle = await open(
        this.child(finalName), fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
      ).catch(fail)
      try {
        const published = await publishedHandle.stat()
        const publishedBytes = await publishedHandle.readFile()
        if (
          !published.isFile() || published.isSymbolicLink()
          || published.dev !== temporaryIdentity.dev || published.ino !== temporaryIdentity.ino
          || !modeMatches(published.mode, mode)
          || !publishedBytes.equals(Buffer.from(content))
        ) fail()
      } finally {
        await publishedHandle.close()
      }
      await this.#handle?.sync().catch(fail)
      await this.#assertWindowsRoot()
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined)
      await unlink(temporaryPath).catch(() => undefined)
      throw error
    }
  }

  async publishImmutableFile(
    name: string,
    content: string | Uint8Array,
    mode: number,
    testHooks?: { afterTemporaryWrite?: () => void | Promise<void> },
  ): Promise<void> {
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
      await created.chmod(mode)
      await created.sync()
      const createdIdentity = await created.stat()
      if (!createdIdentity.isFile() || !modeMatches(createdIdentity.mode, mode)) fail()
      await created.close()
      created = null
      try {
        // link(2) is an atomic no-replace publication: the final name never
        // refers to an inode until all immutable bytes have been synchronized.
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
    } finally {
      await held.close()
    }
    await this.#assertWindowsRoot()
  }

  async close(): Promise<void> {
    await this.#handle?.close()
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
