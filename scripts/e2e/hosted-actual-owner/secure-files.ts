import { randomUUID } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { lstat, open, realpath, rename, unlink, type FileHandle } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, sep } from 'node:path'

export type SecureFileIdentity = Readonly<{
  device: string
  inode: string
  size: string
  mtimeNs: string
  ctimeNs: string
}>

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

function within(root: string, candidate: string): boolean {
  const value = relative(root, candidate)
  return value === '' || value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value)
}

function same(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function stable(left: BigIntStats, right: BigIntStats): boolean {
  return same(left, right) && left.size === right.size && left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs && left.mode === right.mode && left.nlink === right.nlink &&
    left.uid === right.uid && left.gid === right.gid
}

function atomicallyPublished(left: BigIntStats, right: BigIntStats): boolean {
  return same(left, right) && left.size === right.size && left.mtimeNs === right.mtimeNs &&
    left.mode === right.mode && left.nlink === right.nlink && left.uid === right.uid &&
    left.gid === right.gid
}

export class EvidenceRefreshFence {
  private tail: Promise<void> = Promise.resolve()
  private nextGeneration = 0
  private activeGeneration: number | null = null

  run<T>(operation: (generation: number) => Promise<T>): Promise<T> {
    const generation = ++this.nextGeneration
    const scheduled: Promise<T> = this.tail.then(() => {
      if (this.activeGeneration !== null) {
        throw new Error('hosted_actual_owner_evidence_refresh_overlap')
      }
      this.activeGeneration = generation
      return Promise.resolve().then(() => operation(generation)).finally(() => {
        this.activeGeneration = null
      })
    })
    this.tail = scheduled.then(() => undefined, () => undefined)
    return scheduled
  }

  assertActive(generation: number): void {
    if (this.activeGeneration !== generation) {
      throw new Error('hosted_actual_owner_evidence_refresh_generation_stale')
    }
  }
}

async function assertExactContent(
  handle: FileHandle,
  expectedStat: BigIntStats,
  expectedBytes: Buffer,
): Promise<BigIntStats> {
  const before = await handle.stat({ bigint: true })
  if (!stable(expectedStat, before) || before.size !== BigInt(expectedBytes.byteLength)) {
    throw new Error('hosted_actual_owner_evidence_content_drift')
  }
  const observed = Buffer.alloc(expectedBytes.byteLength)
  let offset = 0
  while (offset < observed.byteLength) {
    const { bytesRead } = await handle.read(observed, offset, observed.byteLength - offset, offset)
    if (bytesRead === 0) break
    offset += bytesRead
  }
  const after = await handle.stat({ bigint: true })
  if (offset !== observed.byteLength || !observed.equals(expectedBytes) ||
    !stable(before, after)) {
    throw new Error('hosted_actual_owner_evidence_content_drift')
  }
  return after
}

function identity(stat: BigIntStats): SecureFileIdentity {
  return Object.freeze({
    device: stat.dev.toString(), inode: stat.ino.toString(), size: stat.size.toString(),
    mtimeNs: stat.mtimeNs.toString(), ctimeNs: stat.ctimeNs.toString(),
  })
}

async function anchoredDirectory(path: string, trustedRoot: string): Promise<{
  handle: FileHandle
  stat: BigIntStats
  anchoredPath: string
}> {
  if (!isAbsolute(path) || !within(trustedRoot, path)) throw new Error('hosted_actual_owner_path_escaped_sandbox')
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | NOFOLLOW)
  try {
    const [stat, linked, canonical] = await Promise.all([
      handle.stat({ bigint: true }), lstat(path, { bigint: true }), realpath(path),
    ])
    if (!stat.isDirectory() || !linked.isDirectory() || linked.isSymbolicLink() ||
      !same(stat, linked) || canonical !== path || (stat.mode & 0o022n) !== 0n ||
      (process.getuid?.() !== undefined && stat.uid !== BigInt(process.getuid()))) {
      throw new Error('hosted_actual_owner_untrusted_parent')
    }
    return { handle, stat, anchoredPath: `/proc/self/fd/${handle.fd}` }
  } catch (error) {
    await handle.close()
    throw error
  }
}

async function assertDirectoryMembership(path: string, expected: BigIntStats, handle: FileHandle): Promise<void> {
  const [descriptor, linked, canonical] = await Promise.all([
    handle.stat({ bigint: true }), lstat(path, { bigint: true }), realpath(path),
  ])
  if (!same(expected, descriptor) || descriptor.mode !== expected.mode || !same(expected, linked) ||
    linked.isSymbolicLink() || canonical !== path) {
    throw new Error('hosted_actual_owner_parent_identity_drift')
  }
}

export async function readAnchoredFile(
  path: string,
  trustedRoot: string,
  options: ReadOptions,
): Promise<{ bytes: Buffer; identity: SecureFileIdentity }> {
  const parentPath = dirname(path)
  const parent = await anchoredDirectory(parentPath, trustedRoot)
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
      await assertDirectoryMembership(parentPath, parent.stat, parent.handle)
      return { bytes, identity: identity(after) }
    } finally { await handle.close() }
  } finally { await parent.handle.close() }
}

export async function assertAnchoredIdentity(
  path: string,
  trustedRoot: string,
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
  trustedRoot: string,
  value: unknown,
  beforeRename?: (temporaryPath: string) => void | Promise<void>,
  afterRename?: () => void | Promise<void>,
): Promise<SecureFileIdentity> {
  const parentPath = dirname(path)
  const parent = await anchoredDirectory(parentPath, trustedRoot)
  const temporaryName = `.${basename(path)}.tmp-${process.pid}-${randomUUID()}`
  const temporaryPath = `${parent.anchoredPath}/${temporaryName}`
  let temporaryExists = true
  let published = false
  let handle: FileHandle | null = null
  const serialized = Buffer.from(`${JSON.stringify(value)}\n`)
  try {
    handle = await open(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | NOFOLLOW,
      0o600,
    )
    let written: BigIntStats
    try {
      await handle.writeFile(serialized)
      await handle.sync()
      written = await handle.stat({ bigint: true })
      if (!written.isFile() || written.nlink !== 1n || Number(written.mode & 0o777n) !== 0o600) {
        throw new Error('hosted_actual_owner_evidence_temp_unsafe')
      }
      await beforeRename?.(temporaryPath)
      const linked = await lstat(temporaryPath, { bigint: true })
      if (!stable(written, linked) || linked.isSymbolicLink()) {
        throw new Error('hosted_actual_owner_evidence_temp_substituted')
      }
      await assertExactContent(handle, written, serialized)
    } catch (error) {
      await handle.close()
      handle = null
      throw error
    }
    await assertDirectoryMembership(parentPath, parent.stat, parent.handle)
    await rename(temporaryPath, `${parent.anchoredPath}/${basename(path)}`)
    temporaryExists = false
    published = true
    const publishedStat = await lstat(`${parent.anchoredPath}/${basename(path)}`, { bigint: true })
    if (!atomicallyPublished(written!, publishedStat) || publishedStat.isSymbolicLink()) {
      throw new Error('hosted_actual_owner_evidence_publish_substituted')
    }
    await assertExactContent(handle, publishedStat, serialized)
    await parent.handle.sync()
    await assertDirectoryMembership(parentPath, parent.stat, parent.handle)
    const final = await lstat(path, { bigint: true })
    if (!stable(publishedStat, final)) throw new Error('hosted_actual_owner_evidence_membership_unproved')
    await afterRename?.()
    await assertDirectoryMembership(parentPath, parent.stat, parent.handle)
    const postValidated = await lstat(path, { bigint: true })
    if (!stable(publishedStat, postValidated) || postValidated.isSymbolicLink()) {
      throw new Error('hosted_actual_owner_evidence_post_validation_membership_unproved')
    }
    await assertExactContent(handle, publishedStat, serialized)
    await handle.sync()
    const contentValidated = await assertExactContent(handle, publishedStat, serialized)
    await handle.close()
    handle = null
    return identity(contentValidated)
  } catch (error) {
    if (published && handle) {
      try {
        // Invalidate the exact inode we published through its still-open descriptor. Path-based
        // unlink would be unsafe here: rename-away or RENAME_EXCHANGE may have installed an
        // unrelated file at the evidence pathname after the last membership check.
        await handle.truncate(0)
        await handle.sync()
      } catch {
        throw new Error('hosted_actual_owner_evidence_invalidation_failed', { cause: error })
      }
    }
    throw error
  } finally {
    await handle?.close().catch(() => undefined)
    if (temporaryExists) await unlink(temporaryPath).catch(() => undefined)
    await parent.handle.close()
  }
}
