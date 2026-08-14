import { createHash, randomUUID } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { lstat, open, realpath, rename, unlink, type FileHandle } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, sep } from 'node:path'

export type SecureFileIdentity = Readonly<{
  device: string
  inode: string
  size: string
  mtimeNs: string
  ctimeNs: string
  mode: string
  nlink: string
  uid: string
}>

export type TrustedRoot = Readonly<{ path: string; device: string; inode: string }>

type ReadOptions = {
  maximumBytes: number
  minimumBytes?: number
  mode?: number
  executable?: boolean
  ownerOnly?: boolean
  afterRead?: () => void | Promise<void>
}

const NOFOLLOW = constants.O_NOFOLLOW
if (typeof NOFOLLOW !== 'number') throw new Error('hosted_actual_owner_nofollow_unavailable')

function rootPath(root: string | TrustedRoot): string { return typeof root === 'string' ? root : root.path }

function within(root: string | TrustedRoot, candidate: string): boolean {
  const value = relative(rootPath(root), candidate)
  return value === '' || value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value)
}

function same(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function stable(left: BigIntStats, right: BigIntStats): boolean {
  return same(left, right) && left.size === right.size && left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs && left.mode === right.mode && left.nlink === right.nlink
}

function identity(stat: BigIntStats): SecureFileIdentity {
  return Object.freeze({
    device: stat.dev.toString(), inode: stat.ino.toString(), size: stat.size.toString(),
    mtimeNs: stat.mtimeNs.toString(), ctimeNs: stat.ctimeNs.toString(),
    mode: (stat.mode & 0o777n).toString(), nlink: stat.nlink.toString(), uid: stat.uid.toString(),
  })
}

export async function openTrustedDirectory(path: string, trustedRoot: string | TrustedRoot): Promise<{
  handle: FileHandle
  stat: BigIntStats
  anchoredPath: string
  rootHandle: FileHandle
  rootStat: BigIntStats
}> {
  const root = rootPath(trustedRoot)
  if (!isAbsolute(path) || !within(trustedRoot, path)) throw new Error('hosted_actual_owner_path_escaped_sandbox')
  const rootHandle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | NOFOLLOW)
  let descendant: FileHandle | null = null
  try {
    const [rootStat, rootLinked, rootCanonical] = await Promise.all([
      rootHandle.stat({ bigint: true }), lstat(root, { bigint: true }), realpath(root),
    ])
    if (!rootStat.isDirectory() || !rootLinked.isDirectory() || rootLinked.isSymbolicLink() ||
      !same(rootStat, rootLinked) || rootCanonical !== root ||
      typeof trustedRoot !== 'string' && (rootStat.dev.toString() !== trustedRoot.device ||
        rootStat.ino.toString() !== trustedRoot.inode) ||
      (rootStat.mode & 0o022n) !== 0n ||
      (process.getuid?.() !== undefined && rootStat.uid !== BigInt(process.getuid()))) {
      throw new Error('hosted_actual_owner_untrusted_parent')
    }
    let handle = rootHandle
    let stat = rootStat
    const components = relative(root, path).split(sep).filter(Boolean)
    for (const component of components) {
      const next = await open(`/proc/self/fd/${handle.fd}/${component}`,
        constants.O_RDONLY | constants.O_DIRECTORY | NOFOLLOW)
      const nextStat = await next.stat({ bigint: true })
      if (!nextStat.isDirectory() || (nextStat.mode & 0o022n) !== 0n ||
        (process.getuid?.() !== undefined && nextStat.uid !== BigInt(process.getuid()))) {
        await next.close(); throw new Error('hosted_actual_owner_untrusted_parent')
      }
      if (handle !== rootHandle) await handle.close()
      handle = next; descendant = next; stat = nextStat
    }
    const linked = await lstat(path, { bigint: true })
    if (!same(stat, linked) || linked.isSymbolicLink() || await realpath(path) !== path) {
      if (handle !== rootHandle) await handle.close()
      throw new Error('hosted_actual_owner_untrusted_parent')
    }
    return { handle, stat, anchoredPath: `/proc/self/fd/${handle.fd}`, rootHandle, rootStat }
  } catch (error) {
    await descendant?.close().catch(() => undefined)
    await rootHandle.close()
    throw error
  }
}

async function assertDirectoryMembership(path: string, expected: BigIntStats, handle: FileHandle,
  trustedRoot: string | TrustedRoot, rootExpected: BigIntStats, rootHandle: FileHandle): Promise<void> {
  const root = rootPath(trustedRoot)
  const [descriptor, linked, canonical, rootDescriptor, rootLinked, rootCanonical] = await Promise.all([
    handle.stat({ bigint: true }), lstat(path, { bigint: true }), realpath(path),
    rootHandle.stat({ bigint: true }), lstat(root, { bigint: true }), realpath(root),
  ])
  if (!same(expected, descriptor) || descriptor.mode !== expected.mode || !same(expected, linked) ||
    linked.isSymbolicLink() || canonical !== path || !same(rootExpected, rootDescriptor) ||
    !same(rootDescriptor, rootLinked) || rootLinked.isSymbolicLink() || rootCanonical !== root) {
    throw new Error('hosted_actual_owner_parent_identity_drift')
  }
}

export async function readAnchoredFile(
  path: string,
  trustedRoot: string | TrustedRoot,
  options: ReadOptions,
): Promise<{ bytes: Buffer; identity: SecureFileIdentity }> {
  const parentPath = dirname(path)
  const parent = await openTrustedDirectory(parentPath, trustedRoot)
  try {
    const anchoredPath = `${parent.anchoredPath}/${basename(path)}`
    const handle = await open(anchoredPath, constants.O_RDONLY | NOFOLLOW)
    try {
      const before = await handle.stat({ bigint: true })
      const minimum = BigInt(options.minimumBytes ?? 1)
      if (!before.isFile() || before.nlink !== 1n || before.size < minimum ||
        before.size > BigInt(options.maximumBytes) ||
        options.ownerOnly !== false && (before.mode & 0o077n) !== 0n ||
        options.ownerOnly === false && (before.mode & 0o022n) !== 0n ||
        options.mode !== undefined && Number(before.mode & 0o777n) !== options.mode ||
        options.executable && (before.mode & 0o111n) === 0n ||
        (process.getuid?.() !== undefined && before.uid !== BigInt(process.getuid()))) {
        throw new Error('hosted_actual_owner_private_file_invalid')
      }
      const bytes = await handle.readFile()
      await options.afterRead?.()
      const [after, linked, canonical] = await Promise.all([
        handle.stat({ bigint: true }), lstat(anchoredPath, { bigint: true }), realpath(path),
      ])
      if (!stable(before, after) || !same(after, linked) || linked.isSymbolicLink() ||
        canonical !== path || bytes.byteLength !== Number(after.size)) {
        throw new Error('hosted_actual_owner_file_identity_drift')
      }
      await assertDirectoryMembership(parentPath, parent.stat, parent.handle,
        trustedRoot, parent.rootStat, parent.rootHandle)
      return { bytes, identity: identity(after) }
    } finally { await handle.close() }
  } finally {
    if (parent.handle !== parent.rootHandle) await parent.handle.close()
    await parent.rootHandle.close()
  }
}

export async function assertAnchoredIdentity(
  path: string,
  trustedRoot: string | TrustedRoot,
  expected: SecureFileIdentity,
  options: Omit<ReadOptions, 'afterRead'>,
): Promise<Buffer> {
  const current = await readAnchoredFile(path, trustedRoot, options)
  if (JSON.stringify(current.identity) !== JSON.stringify(expected)) {
    throw new Error('hosted_actual_owner_admitted_file_rotated')
  }
  return current.bytes
}

export async function assertControlCleanupAuthority(
  socketPath: string,
  identity: { device: number; inode: number },
  parentIdentity: { device: number; inode: number },
): Promise<void> {
  const [socketStat, parentStat] = await Promise.all([lstat(socketPath), lstat(dirname(socketPath))])
  if (!socketStat.isSocket() || !parentStat.isDirectory() || parentStat.isSymbolicLink() ||
    (socketStat.mode & 0o077) !== 0 || socketStat.dev !== identity.device ||
    socketStat.ino !== identity.inode || parentStat.dev !== parentIdentity.device ||
    parentStat.ino !== parentIdentity.inode) {
    throw new Error('hosted_actual_owner_control_cleanup_unproved')
  }
}

export async function atomicPrivateJson(
  path: string,
  trustedRoot: string | TrustedRoot,
  value: unknown,
  beforeRename?: (temporaryPath: string) => void | Promise<void>,
): Promise<SecureFileIdentity> {
  const parentPath = dirname(path)
  const parent = await openTrustedDirectory(parentPath, trustedRoot)
  const temporaryName = `.${basename(path)}.tmp-${process.pid}-${randomUUID()}`
  const temporaryPath = `${parent.anchoredPath}/${temporaryName}`
  let temporaryExists = true
  try {
    const expectedBytes = Buffer.from(`${JSON.stringify(value)}\n`)
    const expectedDigest = createHash('sha256').update(expectedBytes).digest('hex')
    const handle = await open(temporaryPath, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | NOFOLLOW, 0o600)
    let written: BigIntStats
    try {
      await handle.writeFile(expectedBytes)
      await handle.sync()
      written = await handle.stat({ bigint: true })
      if (!written.isFile() || written.nlink !== 1n || Number(written.mode & 0o777n) !== 0o600) {
        throw new Error('hosted_actual_owner_evidence_temp_unsafe')
      }
      await beforeRename?.(temporaryPath)
      const linked = await lstat(temporaryPath, { bigint: true })
      const afterCallback = await handle.stat({ bigint: true })
      const currentBytes = Buffer.alloc(Number(afterCallback.size))
      const currentRead = await handle.read(currentBytes, 0, currentBytes.byteLength, 0)
      if (!stable(written, afterCallback) || !stable(afterCallback, linked) || linked.isSymbolicLink() ||
        afterCallback.nlink !== 1n || Number(afterCallback.mode & 0o777n) !== 0o600 ||
        currentRead.bytesRead !== expectedBytes.byteLength || currentBytes.byteLength !== expectedBytes.byteLength ||
        createHash('sha256').update(currentBytes).digest('hex') !== expectedDigest) {
        throw new Error('hosted_actual_owner_evidence_temp_substituted')
      }
    } finally { await handle.close() }
    await assertDirectoryMembership(parentPath, parent.stat, parent.handle,
      trustedRoot, parent.rootStat, parent.rootHandle)
    await rename(temporaryPath, `${parent.anchoredPath}/${basename(path)}`)
    temporaryExists = false
    const publishedPath = `${parent.anchoredPath}/${basename(path)}`
    const publishedHandle = await open(publishedPath, constants.O_RDONLY | NOFOLLOW)
    let published: BigIntStats
    try {
      published = await publishedHandle.stat({ bigint: true })
      const publishedBytes = await publishedHandle.readFile()
      const publishedAfter = await publishedHandle.stat({ bigint: true })
      if (!same(written!, published) || written!.size !== published.size || written!.mode !== published.mode ||
        !stable(published, publishedAfter) || published.nlink !== 1n ||
        Number(published.mode & 0o777n) !== 0o600 || publishedBytes.byteLength !== expectedBytes.byteLength ||
        createHash('sha256').update(publishedBytes).digest('hex') !== expectedDigest) {
        throw new Error('hosted_actual_owner_evidence_publish_substituted')
      }
    } finally { await publishedHandle.close() }
    await parent.handle.sync()
    await assertDirectoryMembership(parentPath, parent.stat, parent.handle,
      trustedRoot, parent.rootStat, parent.rootHandle)
    const [final, publicFinal] = await Promise.all([
      lstat(publishedPath, { bigint: true }), lstat(path, { bigint: true }),
    ])
    if (!stable(published!, final) || !stable(final, publicFinal) || final.nlink !== 1n ||
      Number(final.mode & 0o777n) !== 0o600) {
      throw new Error('hosted_actual_owner_evidence_membership_unproved')
    }
    return identity(final)
  } finally {
    if (temporaryExists) await unlink(temporaryPath).catch(() => undefined)
    if (parent.handle !== parent.rootHandle) await parent.handle.close()
    await parent.rootHandle.close()
  }
}

/** Appends one line without ever resolving the child through an unpinned parent. */
export async function appendPrivateNdjson(
  path: string,
  trustedRoot: string | TrustedRoot,
  value: unknown,
): Promise<SecureFileIdentity> {
  const parentPath = dirname(path)
  const parent = await openTrustedDirectory(parentPath, trustedRoot)
  const child = `${parent.anchoredPath}/${basename(path)}`
  let handle: FileHandle | null = null
  try {
    try {
      handle = await open(child, constants.O_RDWR | constants.O_APPEND | NOFOLLOW)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      handle = await open(child,
        constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600)
    }
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || before.nlink !== 1n || Number(before.mode & 0o777n) !== 0o600 ||
      (process.getuid?.() !== undefined && before.uid !== BigInt(process.getuid()))) {
      throw new Error('hosted_actual_owner_timeline_unsafe')
    }
    const beforeBytes = Buffer.alloc(Number(before.size))
    const beforeRead = await handle.read(beforeBytes, 0, beforeBytes.length, 0)
    if (beforeRead.bytesRead !== beforeBytes.length) throw new Error('hosted_actual_owner_timeline_short_read')
    const appended = Buffer.from(`${JSON.stringify(value)}\n`)
    await handle.writeFile(appended)
    await handle.sync()
    const [after, linked] = await Promise.all([
      handle.stat({ bigint: true }), lstat(child, { bigint: true }),
    ])
    const finalBytes = Buffer.alloc(Number(after.size))
    const finalRead = await handle.read(finalBytes, 0, finalBytes.length, 0)
    const expectedBytes = Buffer.concat([beforeBytes, appended])
    if (!same(before, after) || !same(after, linked) || linked.isSymbolicLink() || after.nlink !== 1n ||
      Number(after.mode & 0o777n) !== 0o600 || after.size !== BigInt(expectedBytes.length) ||
      finalRead.bytesRead !== expectedBytes.length || !finalBytes.equals(expectedBytes)) {
      throw new Error('hosted_actual_owner_timeline_identity_drift')
    }
    await assertDirectoryMembership(parentPath, parent.stat, parent.handle,
      trustedRoot, parent.rootStat, parent.rootHandle)
    const [final, publicFinal] = await Promise.all([
      lstat(child, { bigint: true }), lstat(path, { bigint: true }),
    ])
    if (!stable(after, final) || !stable(final, publicFinal) || final.isSymbolicLink() || final.nlink !== 1n) {
      throw new Error('hosted_actual_owner_timeline_membership_unproved')
    }
    return identity(final)
  } finally {
    await handle?.close()
    if (parent.handle !== parent.rootHandle) await parent.handle.close()
    await parent.rootHandle.close()
  }
}
