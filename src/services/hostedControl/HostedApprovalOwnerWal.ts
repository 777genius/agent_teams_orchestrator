import { AsyncLocalStorage } from 'node:async_hooks'
import { dlopen, FFIType, ptr, read, type Pointer } from 'bun:ffi'
import { randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, readSync, writeSync } from 'node:fs'
import { lstat, mkdir, open, type FileHandle } from 'node:fs/promises'
import { basename, dirname, isAbsolute } from 'node:path'
import { isDeepStrictEqual, TextDecoder } from 'node:util'

import { decodeHostedApprovalIngressAuthority, type HostedApprovalIngressRecord } from './HostedApprovalWire.js'
import type { HostedApprovalRuntimeRoute } from './HostedApprovalRuntimeAdmission.js'
import { createRegularNodeAtDarwin } from './HostedApprovalOwnerWalDarwin.internal.js'
import { assertNoDuplicateJsonObjectKeys } from './ownerProof.js'
import { containsHostPath } from './hostPathSafety.js'

export type HostedApprovalDeliveryState = {
  providerDeliveryId: string
  reconciliationRef: string
  deliveryRef: string
  payloadFingerprint: string
  outboxId: string
  /** Immutable provider-permission incarnation, including canonical raw payload. */
  effectRef: string
  phase: 'started' | 'completed' | 'rejected'
  result: 'delivered' | 'stale_generation' | 'expired' | 'wrong_lane' | 'self_approval' | 'unavailable' | null
}

export type HostedApprovalOwnerState = {
  schemaVersion: 2
  revision: number
  admissionGeneration: string
  admissionDigest: string
  routes: HostedApprovalRuntimeRoute[]
  actorMembers: Record<string, string>
  ingress: HostedApprovalIngressRecord[]
  /** Revoked records retained only to bind durable effect settlements/replays. */
  retiredIngress: HostedApprovalIngressRecord[]
  deliveries: HostedApprovalDeliveryState[]
  writerFence: HostedApprovalWriterFenceIdentity
}

export type HostedApprovalWriterFenceIdentity = {
  generation: string
  dev: string
  ino: string
}

const MAX_BYTES = 32 * 1024 * 1024
const RETENTION_TARGET_BYTES = 24 * 1024 * 1024
const TERMINAL_RETENTION_RECORDS = 2_048
const WRITER_WAIT_TIMEOUT_MS = 30_000
const WRITER_RETRY_MS = 5
const LOCK_EX = 2
const LOCK_NB = 4
const LOCK_UN = 8
const AT_SYMLINK_NOFOLLOW = process.platform === 'darwin' ? 0x0020 : 0x0100
const libcPath = process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6'
const libc = process.platform === 'win32' ? null : dlopen(libcPath, {
  // openat(2) is variadic when O_CREAT is present. Keep this declaration to
  // its fixed prefix and create nodes separately so Darwin arm64 never has to
  // marshal a variadic mode argument through Bun FFI.
  openat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  mknodat: { args: [FFIType.i32, FFIType.ptr, FFIType.u32, FFIType.u64], returns: FFIType.i32 },
  renameat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
  unlinkat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  linkat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  fstatat: { args: [FFIType.i32, FFIType.ptr, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
} as const)
const darwinSpawnLibc = process.platform === 'darwin' ? dlopen(libcPath, {
  posix_spawn_file_actions_init: { args: [FFIType.ptr], returns: FFIType.i32 },
  posix_spawn_file_actions_addfchdir_np: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  posix_spawn_file_actions_addopen: {
    args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.i32], returns: FFIType.i32,
  },
  posix_spawn_file_actions_destroy: { args: [FFIType.ptr], returns: FFIType.i32 },
  posix_spawn: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32,
  },
  waitpid: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  __error: { args: [], returns: FFIType.ptr },
} as const) : null

function cString(value: string): Buffer { return Buffer.from(`${value}\0`) }
function openAt(parentFd: number, name: string, flags: number): number {
  if (!libc) throw new Error('Hosted approval durable namespace requires POSIX dirfd support')
  const encoded = cString(name); const fd = libc.symbols.openat(parentFd, ptr(encoded), flags)
  if (fd < 0) throw new Error(`Hosted approval namespace open failed: ${name}`)
  return fd
}

function makeRegularNodeAt(parentFd: number, name: string): boolean {
  if (!libc) throw new Error('Hosted approval durable namespace requires POSIX dirfd support')
  if (darwinSpawnLibc) return makeRegularNodeAtDarwin(parentFd, name)
  const encoded = cString(name)
  return libc.symbols.mknodat(parentFd, ptr(encoded), constants.S_IFREG | 0o600, 0) === 0
}

function makeRegularNodeAtDarwin(parentFd: number, name: string): boolean {
  if (!darwinSpawnLibc || !libc) throw new Error('Hosted approval durable namespace requires Darwin spawn support')
  const errnoPointer = darwinSpawnLibc.symbols.__error()
  if (!errnoPointer) throw new Error('Hosted approval namespace errno unavailable')
  return createRegularNodeAtDarwin(parentFd, name, {
    initActions: () => {
      const actions = Buffer.alloc(8)
      return { actions, error: darwinSpawnLibc.symbols.posix_spawn_file_actions_init(ptr(actions)) }
    },
    addChdir: (actions, fd) => darwinSpawnLibc.symbols.posix_spawn_file_actions_addfchdir_np(
      ptr(actions as Buffer), fd,
    ),
    addOpen: (actions, targetFd, relativeName, flags, mode) => {
      const encoded = cString(relativeName)
      return darwinSpawnLibc.symbols.posix_spawn_file_actions_addopen(
        ptr(actions as Buffer), targetFd, ptr(encoded), flags, mode,
      )
    },
    spawn: (actions, executablePath) => {
      const executable = cString(executablePath)
      const argv = Buffer.alloc(16); argv.writeBigUInt64LE(BigInt(ptr(executable)))
      const envp = Buffer.alloc(8); const pid = Buffer.alloc(4)
      const error = darwinSpawnLibc.symbols.posix_spawn(
        ptr(pid), ptr(executable), ptr(actions as Buffer), 0, ptr(argv), ptr(envp),
      )
      return { error, pid: pid.readInt32LE() }
    },
    waitPid: child => {
      const status = Buffer.alloc(4)
      const result = darwinSpawnLibc.symbols.waitpid(child, ptr(status), 0)
      // __error() was resolved before waitpid. Bun's direct pointer read does
      // not make another libc call that could overwrite the thread-local errno.
      return { result, status: status.readInt32LE(), errno: result < 0 ? read.i32(errnoPointer as Pointer) : 0 }
    },
    destroyActions: actions => darwinSpawnLibc.symbols.posix_spawn_file_actions_destroy(ptr(actions as Buffer)),
  }, () => unlinkAt(parentFd, name))
}

function createPathInPinnedParent(
  parentFd: number, parentPath: string, childName: string, beforeCreate?: () => void, afterCreate?: (name: string) => void,
): number {
  const parent = fstatSync(parentFd); const linkedParent = lstatSync(parentPath)
  if (!safeDirectoryIdentity(parent, linkedParent)) throw new Error('Hosted approval parent namespace changed before create')
  beforeCreate?.()
  if (!makeRegularNodeAt(parentFd, childName)) throw new Error(`Hosted approval namespace create failed: ${childName}`)
  afterCreate?.(childName)
  let fd = -1
  try {
    fd = openAt(parentFd, childName, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0))
    const created = fstatSync(fd); const currentParent = lstatSync(parentPath)
    if (!safeDirectoryIdentity(parent, currentParent) || !created.isFile() ||
      (created.mode & 0o077) !== 0) throw new Error('Hosted approval child created outside pinned namespace')
    return fd
  } catch (error) {
    if (fd >= 0) closeSync(fd)
    try { unlinkAt(parentFd, childName) } catch { /* best-effort cleanup in the retained namespace */ }
    throw error
  }
}

function openOrCreatePathInPinnedParent(
  parentFd: number, parentPath: string, childName: string, beforeCreate?: () => void, afterCreate?: (name: string) => void,
): number {
  const parent = fstatSync(parentFd); const linkedParent = lstatSync(parentPath)
  if (!safeDirectoryIdentity(parent, linkedParent)) throw new Error('Hosted approval parent namespace changed before open')
  beforeCreate?.()
  const createdNode = makeRegularNodeAt(parentFd, childName)
  if (createdNode) afterCreate?.(childName)
  let fd = -1
  try {
    fd = openAt(parentFd, childName, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0))
    const opened = fstatSync(fd); const currentParent = lstatSync(parentPath)
    if (!safeDirectoryIdentity(parent, currentParent) || !opened.isFile() ||
      (opened.mode & 0o077) !== 0) throw new Error('Hosted approval child opened outside pinned namespace')
    return fd
  } catch (error) {
    if (fd >= 0) closeSync(fd)
    if (createdNode) {
      try { unlinkAt(parentFd, childName) } catch { /* best-effort cleanup in the retained namespace */ }
    }
    throw error
  }
}
function renameAt(parentFd: number, from: string, to: string): void {
  if (!libc) throw new Error('Hosted approval durable namespace requires POSIX dirfd support')
  const fromBytes = cString(from); const toBytes = cString(to)
  if (libc.symbols.renameat(parentFd, ptr(fromBytes), parentFd, ptr(toBytes)) !== 0) {
    throw new Error('Hosted approval namespace rename failed')
  }
}
function unlinkAt(parentFd: number, name: string): void {
  if (!libc) throw new Error('Hosted approval durable namespace requires POSIX dirfd support')
  const encoded = cString(name)
  if (libc.symbols.unlinkat(parentFd, ptr(encoded), 0) !== 0) throw new Error('Hosted approval namespace unlink failed')
}
function linkAt(parentFd: number, from: string, to: string): void {
  if (!libc) throw new Error('Hosted approval durable namespace requires POSIX dirfd support')
  const fromBytes = cString(from); const toBytes = cString(to)
  if (libc.symbols.linkat(parentFd, ptr(fromBytes), parentFd, ptr(toBytes), 0) !== 0) {
    throw new Error('Hosted approval namespace link failed')
  }
}
function flock(fd: number, operation: number): boolean {
  if (!libc) throw new Error('Hosted approval durable namespace requires POSIX flock support')
  return libc.symbols.flock(fd, operation) === 0
}
function existsAt(parentFd: number, name: string): boolean {
  if (!libc) throw new Error('Hosted approval durable namespace requires POSIX dirfd support')
  const encoded = cString(name); const stat = Buffer.alloc(512)
  return libc.symbols.fstatat(parentFd, ptr(encoded), ptr(stat), AT_SYMLINK_NOFOLLOW) === 0
}

export class HostedApprovalOwnerWal {
  #tail: Promise<void> = Promise.resolve()
  #activeWriter: symbol | null = null
  #activeFenceIdentity: HostedApprovalWriterFenceIdentity | null = null
  #activeFenceHandle: number | null = null
  #activeLockHandle: number | null = null
  #activeLockIdentity: { dev: number | bigint; ino: number | bigint } | null = null
  #activeParentHandle: FileHandle | null = null
  readonly #writerContext = new AsyncLocalStorage<symbol>()
  readonly fencePath: string
  readonly lockPath: string
  constructor(readonly path: string, private readonly testHooks?: {
    afterFenceOpen?: () => Promise<void>
    afterWalRename?: () => Promise<void>
    afterFenceTempFsync?: () => Promise<void>
    afterFenceLink?: () => Promise<void>
    beforeRetainedCreate?: () => void
    afterRetainedCreate?: (name: string) => void
  }) {
    if (!isAbsolute(path) || path.includes('\0')) throw new TypeError('Invalid hosted approval WAL path')
    this.fencePath = `${path}.writer-fence.sqlite`
    this.lockPath = `${path}.writer-lock`
  }

  async locked<T>(operation: (state: HostedApprovalOwnerState | null) => Promise<T>): Promise<T> {
    const prior = this.#tail; let release!: () => void
    this.#tail = new Promise(resolve => { release = resolve })
    await prior
    let fenceHandle: number | undefined
    let lockHandle: number | undefined
    let parentHandle: FileHandle | undefined
    try {
      const acquired = await this.#acquireWriterFence()
      fenceHandle = acquired.handle
      lockHandle = acquired.lockHandle
      parentHandle = acquired.parent
      this.#activeFenceIdentity = acquired.identity
      this.#activeFenceHandle = fenceHandle
      this.#activeLockHandle = lockHandle
      this.#activeLockIdentity = acquired.lockIdentity
      this.#activeParentHandle = parentHandle
      const writer = Symbol('hosted-approval-writer')
      this.#activeWriter = writer
      // Every owner instance reloads only after it owns the same interprocess
      // fence. No cached state may survive an owner handover.
      const state = await this.read()
      if (state && !isDeepStrictEqual(state.writerFence, acquired.identity)) {
        throw new Error('Hosted approval WAL writer-fence generation mismatch')
      }
      const result = await this.#writerContext.run(writer, async () => {
        const value = await operation(state)
        if (!(await this.ownsCurrentFence())) throw new Error('Hosted approval writer fence changed before commit')
        return value
      })
      return result
    } finally {
      this.#activeWriter = null
      this.#activeFenceIdentity = null
      this.#activeFenceHandle = null
      this.#activeLockHandle = null
      this.#activeLockIdentity = null
      this.#activeParentHandle = null
      try {
        if (fenceHandle !== undefined) closeSync(fenceHandle)
        if (lockHandle !== undefined) {
          flock(lockHandle, LOCK_UN)
          closeSync(lockHandle)
        }
        await parentHandle?.close()
      } finally {
        release()
      }
    }
  }

  async read(): Promise<HostedApprovalOwnerState | null> {
    const parent = this.#activeParentHandle
    if (parent) return this.#readPinned(parent)
    const handle = await open(this.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    })
    if (!handle) return null
    try {
      const [stat, current] = await Promise.all([handle.stat(), lstat(this.path)])
      if (!stat.isFile() || !current.isFile() || current.isSymbolicLink() || stat.dev !== current.dev ||
        stat.ino !== current.ino || (stat.mode & 0o077) !== 0 || stat.size < 2 || stat.size > MAX_BYTES ||
        (process.getuid?.() !== undefined && stat.uid !== process.getuid())) throw new Error('Unsafe hosted approval WAL')
      const raw = await handle.readFile()
      if (raw.byteLength < 2 || raw.byteLength > MAX_BYTES) throw new Error('Hosted approval WAL size changed')
      return parseOwnerStateSource(raw)
    } finally { await handle.close() }
  }

  #readPinned(parent: FileHandle): HostedApprovalOwnerState | null {
    if (!existsAt(parent.fd, basename(this.path))) return null
    const fd = openAt(parent.fd, basename(this.path), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size < 2 || stat.size > MAX_BYTES ||
        (process.getuid?.() !== undefined && stat.uid !== process.getuid())) throw new Error('Unsafe hosted approval WAL')
      const raw = readExactFd(fd, stat.size)
      if (!raw || raw.byteLength < 2 || raw.byteLength > MAX_BYTES) throw new Error('Hosted approval WAL size changed')
      return parseOwnerStateSource(raw)
    } finally { closeSync(fd) }
  }

  async publish(previous: HostedApprovalOwnerState | null, next: Omit<HostedApprovalOwnerState, 'revision' | 'writerFence'> & Partial<Pick<HostedApprovalOwnerState, 'writerFence'>>): Promise<HostedApprovalOwnerState> {
    if (!this.#activeWriter || !this.#activeFenceIdentity || this.#writerContext.getStore() !== this.#activeWriter) {
      throw new Error('Hosted approval WAL publish requires writer fence')
    }
    if (!(await this.ownsCurrentFence())) throw new Error('Hosted approval writer fence changed')
    const current = await this.read()
    if (!isDeepStrictEqual(current, previous)) throw new Error('Hosted approval WAL compare-and-swap conflict')
    const state = compactOwnerState(decodeOwnerState({
      ...next,
      writerFence: this.#activeFenceIdentity,
      revision: (previous?.revision ?? 0) + 1,
    }))
    const bytes = `${JSON.stringify(state)}\n`
    if (Buffer.byteLength(bytes) > MAX_BYTES) throw new Error('Hosted approval WAL exceeds limit')
    await this.#publishExact(bytes)
    if (!(await this.ownsCurrentFence())) throw new Error('Hosted approval writer fence changed after publication')
    return state
  }

  /**
   * Returns a single-use synchronous effect-edge token for the exact WAL image,
   * parent directory, and SQLite writer-fence incarnation owned by this writer.
   */
  async prepareEffectToken(expected: HostedApprovalOwnerState): Promise<{ consume(): boolean } | null> {
    if (!this.#activeWriter || !this.#activeFenceIdentity ||
      this.#writerContext.getStore() !== this.#activeWriter || !(await this.ownsCurrentFence())) return null
    const expectedBytes = Buffer.from(`${JSON.stringify(expected)}\n`)
    const activeParent = this.#activeParentHandle
    let parentFd = -1; let walFd = -1
    try {
      if (!activeParent) throw new Error('Hosted approval WAL parent authority unavailable')
      parentFd = openAt(activeParent.fd, '.', constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0))
      walFd = openAt(parentFd, basename(this.path), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      const parent = fstatSync(parentFd)
      const wal = fstatSync(walFd)
      if (!parent.isDirectory() || (parent.mode & 0o022) !== 0 || !wal.isFile() || (wal.mode & 0o077) !== 0 ||
        (process.getuid?.() !== undefined && (parent.uid !== process.getuid() || wal.uid !== process.getuid())) ||
        wal.size !== expectedBytes.length ||
        !readExactFd(walFd, expectedBytes.length)?.equals(expectedBytes)) throw new Error('Hosted approval WAL effect image changed')
      const parentIdentity = { dev: parent.dev, ino: parent.ino }
      const walIdentity = { dev: wal.dev, ino: wal.ino }
      const fenceHandle = this.#activeFenceHandle
      const fenceIdentity = this.#activeFenceIdentity
      const lockHandle = this.#activeLockHandle
      const lockIdentity = this.#activeLockIdentity
      const writer = this.#activeWriter
      if (fenceHandle === null || lockHandle === null || !lockIdentity) throw new Error('Hosted approval writer fence unavailable')
      const ownedParentFd = parentFd; const ownedWalFd = walFd
      parentFd = -1; walFd = -1
      let consumed = false
      return {
        consume: () => {
          if (consumed) return false
          consumed = true
          try {
            const currentParent = fstatSync(ownedParentFd)
            const currentLinkedParent = lstatSync(dirname(this.path))
            const currentWal = fstatSync(ownedWalFd)
            const linkedWalFd = openAt(ownedParentFd, basename(this.path), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
            const linkedWal = fstatSync(linkedWalFd); closeSync(linkedWalFd)
            const linkedFenceFd = openAt(ownedParentFd, basename(this.fencePath), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
            const openedFence = fstatSync(fenceHandle); const linkedFence = fstatSync(linkedFenceFd); closeSync(linkedFenceFd)
            const openedLock = fstatSync(lockHandle)
            // Deliberately do not open the lock inode while flock is held.
            // On platforms with surprising record-lock compatibility behavior,
            // even a probe descriptor must not participate in lock lifetime.
            const linkedLock = lstatSync(this.lockPath)
            const durable = readFenceIdentity(fenceHandle)
            return this.#activeWriter === writer && this.#writerContext.getStore() === writer &&
              safeDirectoryIdentity(currentParent, currentLinkedParent) &&
              currentParent.dev === parentIdentity.dev && currentParent.ino === parentIdentity.ino &&
              currentWal.isFile() && (currentWal.mode & 0o077) === 0 &&
              currentWal.dev === walIdentity.dev && currentWal.ino === walIdentity.ino &&
              currentWal.dev === linkedWal.dev && currentWal.ino === linkedWal.ino &&
              currentWal.size === expectedBytes.length &&
              readExactFd(ownedWalFd, expectedBytes.length)?.equals(expectedBytes) === true &&
              openedFence.dev === linkedFence.dev && openedFence.ino === linkedFence.ino &&
              String(openedFence.dev) === fenceIdentity.dev &&
              String(openedFence.ino) === fenceIdentity.ino &&
              openedLock.dev === lockIdentity.dev && openedLock.ino === lockIdentity.ino &&
              linkedLock.isFile() && !linkedLock.isSymbolicLink() &&
              openedLock.dev === linkedLock.dev && openedLock.ino === linkedLock.ino &&
              (openedLock.mode & 0o077) === 0 && !!durable &&
              isDeepStrictEqual(durable, fenceIdentity)
          } catch { return false } finally {
            closeSync(ownedWalFd); closeSync(ownedParentFd)
          }
        },
      }
    } catch {
      if (walFd >= 0) closeSync(walFd)
      if (parentFd >= 0) closeSync(parentFd)
      return null
    }
  }

  async #publishExact(bytes: string): Promise<void> {
    const directory = dirname(this.path)
    const parent = this.#activeParentHandle
    if (!parent) throw new Error('Hosted approval WAL parent authority unavailable')
    const walName = basename(this.path)
    const tempName = `${walName}.tmp.${process.pid}.${randomUUID()}`
    let tempFd = -1
    let renamed = false
    try {
      const parentIdentity = await parent.stat(); const linkedParent = await lstat(directory)
      if (!safeDirectoryIdentity(parentIdentity, linkedParent)) throw new Error('Unsafe hosted approval WAL directory')
      tempFd = createPathInPinnedParent(
        parent.fd, directory, tempName, this.testHooks?.beforeRetainedCreate, this.testHooks?.afterRetainedCreate,
      )
      const encoded = Buffer.from(bytes)
      if (writeSync(tempFd, encoded, 0, encoded.length, 0) !== encoded.length) throw new Error('Hosted approval WAL short write')
      const written = fstatSync(tempFd)
      if (!written.isFile() || (written.mode & 0o077) !== 0 || written.size !== encoded.length) {
        throw new Error('Unsafe hosted approval WAL temporary image')
      }
      fsyncSync(tempFd)
      renameAt(parent.fd, tempName, walName); renamed = true
      await this.testHooks?.afterWalRename?.()
      const currentWritten = fstatSync(tempFd)
      const publishedFd = openAt(parent.fd, walName, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      const linkedWal = fstatSync(publishedFd)
      closeSync(publishedFd)
      if (currentWritten.dev !== linkedWal.dev || currentWritten.ino !== linkedWal.ino) {
        throw new Error('Hosted approval WAL publication substituted')
      }
      const exact = readExactFd(tempFd, encoded.length)
      if (!exact?.equals(encoded)) {
        throw new Error('Hosted approval WAL publication bytes changed')
      }
      await parent.sync()
      const finalWritten = fstatSync(tempFd)
      const finalFd = openAt(parent.fd, walName, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      const finalWal = fstatSync(finalFd)
      closeSync(finalFd)
      if (finalWritten.dev !== finalWal.dev || finalWritten.ino !== finalWal.ino) {
        throw new Error('Hosted approval WAL durability edge substituted')
      }
    } finally {
      if (tempFd >= 0) closeSync(tempFd)
      if (!renamed && existsAt(parent.fd, tempName)) {
        try { unlinkAt(parent.fd, tempName) } catch { /* best-effort cleanup in the owned namespace */ }
      }
    }
  }

  /** Proves that the current locked callback still owns the exact durable fence incarnation. */
  async ownsCurrentFence(): Promise<boolean> {
    const writer = this.#activeWriter
    const identity = this.#activeFenceIdentity
    const handle = this.#activeFenceHandle
    const lockHandle = this.#activeLockHandle
    const lockIdentity = this.#activeLockIdentity
    const parent = this.#activeParentHandle
    if (!writer || !identity || handle === null || lockHandle === null || !lockIdentity || !parent || this.#writerContext.getStore() !== writer) return false
    try {
      const [openedParent, linkedParent] = await Promise.all([parent.stat(), lstat(dirname(this.path))])
      const opened = fstatSync(handle)
      const linkedFd = openAt(parent.fd, basename(this.fencePath), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      const linked = fstatSync(linkedFd); closeSync(linkedFd)
      const openedLock = fstatSync(lockHandle)
      const linkedLock = lstatSync(this.lockPath)
      if (!safeDirectoryIdentity(openedParent, linkedParent) || !opened.isFile() || !linked.isFile() ||
        String(opened.dev) !== identity.dev || String(opened.ino) !== identity.ino ||
        opened.dev !== linked.dev || opened.ino !== linked.ino || (opened.mode & 0o077) !== 0 ||
        (process.getuid?.() !== undefined && opened.uid !== process.getuid()) ||
        !openedLock.isFile() || linkedLock.isSymbolicLink() || !linkedLock.isFile() ||
        openedLock.dev !== lockIdentity.dev || openedLock.ino !== lockIdentity.ino ||
        linkedLock.dev !== lockIdentity.dev || linkedLock.ino !== lockIdentity.ino ||
        (openedLock.mode & 0o077) !== 0) return false
      return isDeepStrictEqual(readFenceIdentity(handle), identity)
    } catch { return false }
  }

  async #acquireWriterFence(): Promise<{ handle: number; lockHandle: number; lockIdentity: { dev: number | bigint; ino: number | bigint }; parent: FileHandle; identity: HostedApprovalWriterFenceIdentity }> {
    const directory = dirname(this.path)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const parent = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0))
    let parentIdentity: Awaited<ReturnType<FileHandle['stat']>>
    try {
      const [stat, current] = await Promise.all([parent.stat(), lstat(directory)])
      if (!stat.isDirectory() || !current.isDirectory() || current.isSymbolicLink() ||
        stat.dev !== current.dev || stat.ino !== current.ino || (stat.mode & 0o022) !== 0 ||
        (process.getuid?.() !== undefined && stat.uid !== process.getuid())) {
        throw new Error('Unsafe hosted approval WAL directory')
      }
      parentIdentity = stat
    } catch (error) {
      await parent.close()
      throw error
    }
    // A dedicated flock inode is the sole interprocess exclusion primitive.
    // No other descriptor for this inode is opened or closed while the lock is
    // held, so SQLite/VFS record-lock lifetime cannot be shortened by probes.
    let lockHandle = -1; let handle = -1
    try {
      lockHandle = openOrCreatePathInPinnedParent(
        parent.fd, directory, basename(this.lockPath), this.testHooks?.beforeRetainedCreate, this.testHooks?.afterRetainedCreate,
      )
      const deadline = Date.now() + WRITER_WAIT_TIMEOUT_MS
      while (!flock(lockHandle, LOCK_EX | LOCK_NB)) {
        if (Date.now() >= deadline) throw new Error('Hosted approval writer lock timeout')
        await new Promise(resolve => setTimeout(resolve, WRITER_RETRY_MS))
      }
      const lockIdentity = fstatSync(lockHandle)
      const linkedLock = lstatSync(this.lockPath)
      if (!lockIdentity.isFile() || linkedLock.isSymbolicLink() || !linkedLock.isFile() ||
        lockIdentity.dev !== linkedLock.dev || lockIdentity.ino !== linkedLock.ino ||
        (lockIdentity.mode & 0o077) !== 0) throw new Error('Hosted approval writer lock identity changed')
      // The lock pathname must survive a crash before any WAL may refer to the
      // fence it protects. An fd lock on an unlinked post-crash inode would not
      // exclude the replacement owner's newly-created pathname.
      fsyncSync(lockHandle)
      await parent.sync()

      if (existsAt(parent.fd, basename(this.fencePath))) {
        handle = openAt(parent.fd, basename(this.fencePath), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      } else {
        if (this.#readPinned(parent)) throw new Error('Hosted approval writer fence generation missing')
        handle = await this.#initializeFence(parent, directory, parentIdentity)
      }
      const opened = fstatSync(handle)
      if (!opened.isFile() || (opened.mode & 0o077) !== 0 ||
        (process.getuid?.() !== undefined && opened.uid !== process.getuid())) throw new Error('Unsafe hosted approval writer fence')
      await this.testHooks?.afterFenceOpen?.()
      const linkedFd = openAt(parent.fd, basename(this.fencePath), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      const linked = fstatSync(linkedFd); closeSync(linkedFd)
      const linkedParent = await lstat(directory)
      if (!safeDirectoryIdentity(parentIdentity, linkedParent) || opened.dev !== linked.dev || opened.ino !== linked.ino) {
        throw new Error('Hosted approval writer fence identity changed')
      }
      const identity = readFenceIdentity(handle)
      if (identity.dev !== String(opened.dev) || identity.ino !== String(opened.ino)) {
        throw new Error('Hosted approval writer fence generation invalid')
      }
      return { handle, lockHandle, lockIdentity: { dev: lockIdentity.dev, ino: lockIdentity.ino }, parent, identity }
    } catch (error) {
      if (handle >= 0) closeSync(handle)
      if (lockHandle >= 0) {
        flock(lockHandle, LOCK_UN)
        closeSync(lockHandle)
      }
      await parent.close().catch(() => undefined)
      throw error
    }
  }

  async #initializeFence(parent: FileHandle, directory: string, parentIdentity: Awaited<ReturnType<FileHandle['stat']>>): Promise<number> {
    const fenceName = basename(this.fencePath)
    const tempName = `${fenceName}.init.${process.pid}.${randomUUID()}`
    let tempFd = -1
    let linked = false
    try {
      tempFd = createPathInPinnedParent(
        parent.fd, directory, tempName, this.testHooks?.beforeRetainedCreate, this.testHooks?.afterRetainedCreate,
      )
      const stat = fstatSync(tempFd)
      const identity: HostedApprovalWriterFenceIdentity = {
        generation: `approval-writer-fence_${randomUUID().replaceAll('-', '')}`,
        dev: String(stat.dev), ino: String(stat.ino),
      }
      const bytes = Buffer.from(`${JSON.stringify(identity)}\n`)
      if (writeSync(tempFd, bytes, 0, bytes.length, 0) !== bytes.length) throw new Error('Hosted approval writer fence short write')
      fsyncSync(tempFd)
      await this.testHooks?.afterFenceTempFsync?.()
      linkAt(parent.fd, tempName, fenceName); linked = true
      await this.testHooks?.afterFenceLink?.()
      const currentParent = await parent.stat(); const linkedParent = await lstat(directory)
      if (!safeDirectoryIdentity(currentParent, linkedParent) || currentParent.dev !== parentIdentity.dev || currentParent.ino !== parentIdentity.ino) {
        throw new Error('Hosted approval writer fence directory changed')
      }
      await parent.sync()
      unlinkAt(parent.fd, tempName)
      await parent.sync()
      return tempFd
    } catch (error) {
      if (tempFd >= 0) closeSync(tempFd)
      if (!linked && existsAt(parent.fd, tempName)) {
        try { unlinkAt(parent.fd, tempName) } catch { /* crash recovery leaves only an unreferenced temp */ }
      }
      throw error
    }
  }
}

function compactOwnerState(state: HostedApprovalOwnerState): HostedApprovalOwnerState {
  const terminalDeliveryIds = new Set(state.deliveries
    .filter(delivery => delivery.phase !== 'started')
    .slice(-TERMINAL_RETENTION_RECORDS)
    .map(delivery => delivery.outboxId))
  const activeDeliveryIds = new Set(state.deliveries
    .filter(delivery => delivery.phase === 'started')
    .map(delivery => delivery.outboxId))
  const acknowledgedIds = new Set(state.ingress
    .filter(record => record.acknowledgedAtIso !== null)
    .slice(-TERMINAL_RETENTION_RECORDS)
    .map(record => record.outboxId))
  const retainedOutbox = new Set([...terminalDeliveryIds, ...activeDeliveryIds, ...acknowledgedIds])
  let compacted: HostedApprovalOwnerState = {
    ...state,
    ingress: state.ingress.filter(record =>
      record.acknowledgedAtIso === null || retainedOutbox.has(record.outboxId)),
    retiredIngress: state.retiredIngress.filter(record => retainedOutbox.has(record.outboxId)),
    deliveries: state.deliveries.filter(delivery =>
      delivery.phase === 'started' || terminalDeliveryIds.has(delivery.outboxId)),
  }
  // Active/ambiguous records are never discarded. If they alone exceed the
  // recovery budget, the caller receives deterministic backpressure instead of
  // growing until the 32 MiB hard failure.
  if (Buffer.byteLength(JSON.stringify(compacted)) > RETENTION_TARGET_BYTES) {
    const activeOnly = {
      ...compacted,
      ingress: compacted.ingress.filter(record => record.acknowledgedAtIso === null || activeDeliveryIds.has(record.outboxId)),
      retiredIngress: compacted.retiredIngress.filter(record => activeDeliveryIds.has(record.outboxId)),
      deliveries: compacted.deliveries.filter(delivery => delivery.phase === 'started'),
    }
    if (Buffer.byteLength(JSON.stringify(activeOnly)) > RETENTION_TARGET_BYTES) {
      throw new Error('Hosted approval owner active state exceeds retention budget')
    }
    compacted = activeOnly
  }
  return compacted
}

function readFenceIdentity(fd: number): HostedApprovalWriterFenceIdentity {
  const stat = fstatSync(fd)
  if (!stat.isFile() || stat.size < 2 || stat.size > 4096 || (stat.mode & 0o077) !== 0) {
    throw new Error('Unsafe hosted approval writer fence')
  }
  const raw = readExactFd(fd, stat.size)
  if (!raw) throw new Error('Hosted approval writer fence size changed')
  const source = new TextDecoder('utf-8', { fatal: true }).decode(raw)
  assertNoDuplicateJsonObjectKeys(source)
  const value = object(JSON.parse(source), 'writer fence')
  exact(value, ['generation', 'dev', 'ino'], 'writer fence')
  if (typeof value.generation !== 'string' || !/^approval-writer-fence_[0-9a-f]{32}$/.test(value.generation) ||
    typeof value.dev !== 'string' || !/^\d+$/.test(value.dev) || typeof value.ino !== 'string' || !/^\d+$/.test(value.ino)) {
    throw new Error('Hosted approval writer fence generation invalid')
  }
  return value as HostedApprovalWriterFenceIdentity
}

function safeDirectoryIdentity(opened: { dev: number | bigint; ino: number | bigint; mode: number; uid: number; isDirectory(): boolean }, linked: { dev: number | bigint; ino: number | bigint; mode: number; uid: number; isDirectory(): boolean; isSymbolicLink(): boolean }): boolean {
  return opened.isDirectory() && linked.isDirectory() && !linked.isSymbolicLink() &&
    opened.dev === linked.dev && opened.ino === linked.ino && (opened.mode & 0o022) === 0 &&
    (process.getuid?.() === undefined || opened.uid === process.getuid())
}

export function parseOwnerStateSource(raw: Uint8Array): HostedApprovalOwnerState {
  const source = new TextDecoder('utf-8', { fatal: true }).decode(raw)
  assertNoDuplicateJsonObjectKeys(source)
  return decodeOwnerState(JSON.parse(source))
}

export function decodeOwnerState(value: unknown): HostedApprovalOwnerState {
  const state = object(value, 'WAL')
  if (state.schemaVersion === 1) return migrateLegacyOwnerState(state)
  exact(state, ['schemaVersion', 'revision', 'admissionGeneration', 'admissionDigest', 'routes', 'actorMembers', 'ingress', 'retiredIngress', 'deliveries', 'writerFence'], 'WAL')
  if (state.schemaVersion !== 2 || !Number.isSafeInteger(state.revision) || (state.revision as number) < 1 ||
    typeof state.admissionGeneration !== 'string' || !/^approval-admission-generation_[A-Za-z0-9][A-Za-z0-9._-]{0,223}$/.test(state.admissionGeneration) ||
    typeof state.admissionDigest !== 'string' || !/^[0-9a-f]{64}$/.test(state.admissionDigest) ||
    !Array.isArray(state.routes) || !Array.isArray(state.ingress) || !Array.isArray(state.retiredIngress) || !Array.isArray(state.deliveries)) {
    throw new Error('Invalid hosted approval WAL scalar')
  }
  const actors = object(state.actorMembers, 'actor members')
  const writerFence = object(state.writerFence, 'writer fence')
  exact(writerFence, ['generation', 'dev', 'ino'], 'writer fence')
  if (typeof writerFence.generation !== 'string' || !/^approval-writer-fence_[0-9a-f]{32}$/.test(writerFence.generation) ||
    typeof writerFence.dev !== 'string' || !/^\d+$/.test(writerFence.dev) || typeof writerFence.ino !== 'string' || !/^\d+$/.test(writerFence.ino)) {
    throw new Error('Invalid hosted approval WAL writer fence')
  }
  for (const [actor, member] of Object.entries(actors)) {
    if (!/^actor_[A-Za-z0-9][A-Za-z0-9._-]{0,121}$/.test(actor) || typeof member !== 'string' || !/^member_[0-9a-f]{32}$/.test(member)) throw new Error('Invalid hosted approval WAL actor mapping')
  }
  const routes = state.routes.map(value => decodeWalRoute(value, actors))
  const routeBySession = new Map(routes.map(route => [route.authority.sessionId, route]))
  const ingress = state.ingress.map(value => decodeWalIngress(value, routeBySession))
  const retiredIngress = state.retiredIngress.map(decodeRetiredWalIngress)
  const allIngress = [...ingress, ...retiredIngress]
  const deliveries = state.deliveries.map(value => decodeWalDelivery(value, allIngress))
  if (new Set(routes.map(route => route.routeId)).size !== routes.length ||
    new Set(allIngress.map(record => record.outboxId)).size !== allIngress.length ||
    new Set(allIngress.map(record => record.deliveryRef)).size !== allIngress.length ||
    new Set(deliveries.map(record => record.providerDeliveryId)).size !== deliveries.length ||
    new Set(deliveries.map(record => record.reconciliationRef)).size !== deliveries.length ||
    new Set(deliveries.map(record => record.deliveryRef)).size !== deliveries.length ||
    new Set(deliveries.map(record => record.outboxId)).size !== deliveries.length ||
    new Set(deliveries.map(record => record.effectRef)).size !== deliveries.length) {
    throw new Error('Invalid duplicate hosted approval WAL identity')
  }
  return {
    schemaVersion: 2, revision: state.revision as number,
    admissionGeneration: state.admissionGeneration, admissionDigest: state.admissionDigest,
    routes, actorMembers: actors as Record<string, string>, ingress, retiredIngress, deliveries,
    writerFence: writerFence as HostedApprovalWriterFenceIdentity,
  }
}

/**
 * Legacy v1 had no executable authority. Recovery is deliberately state-only:
 * every route is revoked, and only ingress referenced by durable settlement
 * evidence survives as non-claimable history. The next fenced publication is v2.
 */
function migrateLegacyOwnerState(state: Record<string, unknown>): HostedApprovalOwnerState {
  exact(state, ['schemaVersion', 'revision', 'admissionGeneration', 'admissionDigest', 'routes', 'actorMembers', 'ingress', 'retiredIngress', 'deliveries', 'writerFence'], 'legacy v1 WAL')
  if (!Number.isSafeInteger(state.revision) || (state.revision as number) < 1 ||
    typeof state.admissionGeneration !== 'string' || !/^approval-admission-generation_[A-Za-z0-9][A-Za-z0-9._-]{0,223}$/.test(state.admissionGeneration) ||
    typeof state.admissionDigest !== 'string' || !/^[0-9a-f]{64}$/.test(state.admissionDigest) ||
    !Array.isArray(state.routes) || !Array.isArray(state.ingress) ||
    !Array.isArray(state.retiredIngress) || !Array.isArray(state.deliveries)) {
    throw new Error('Invalid hosted approval legacy v1 WAL scalar')
  }
  const actors = object(state.actorMembers, 'legacy v1 actor members')
  for (const [actor, member] of Object.entries(actors)) {
    if (!/^actor_[A-Za-z0-9][A-Za-z0-9._-]{0,121}$/.test(actor) ||
      typeof member !== 'string' || !/^member_[0-9a-f]{32}$/.test(member)) {
      throw new Error('Invalid hosted approval legacy v1 actor mapping')
    }
  }
  const writerFence = decodeWriterFence(state.writerFence)
  const legacyRoutes = state.routes.map(value => decodeLegacyWalRoute(value, actors))
  const authorities = legacyRoutes.map(route => route.authority)
  const decodeLegacyIngress = (value: unknown) => {
    const record = decodeRetiredWalIngress(value)
    if (!authorities.some(authority => isDeepStrictEqual(authority, record.authority))) {
      throw new Error('Invalid hosted approval legacy v1 ingress route')
    }
    return record
  }
  const allIngress = [...state.ingress.map(decodeLegacyIngress), ...state.retiredIngress.map(decodeLegacyIngress)]
  const deliveries = state.deliveries.map(value => decodeWalDelivery(value, allIngress))
  if (new Set(allIngress.map(record => record.outboxId)).size !== allIngress.length ||
    new Set(allIngress.map(record => record.deliveryRef)).size !== allIngress.length ||
    new Set(deliveries.map(record => record.providerDeliveryId)).size !== deliveries.length ||
    new Set(deliveries.map(record => record.reconciliationRef)).size !== deliveries.length ||
    new Set(deliveries.map(record => record.deliveryRef)).size !== deliveries.length ||
    new Set(deliveries.map(record => record.outboxId)).size !== deliveries.length ||
    new Set(deliveries.map(record => record.effectRef)).size !== deliveries.length) {
    throw new Error('Invalid duplicate hosted approval legacy v1 WAL identity')
  }
  const referenced = new Set(deliveries.map(delivery => delivery.outboxId))
  return {
    schemaVersion: 2,
    revision: state.revision as number,
    admissionGeneration: state.admissionGeneration,
    admissionDigest: state.admissionDigest,
    routes: [],
    actorMembers: {},
    ingress: [],
    retiredIngress: allIngress.filter(record => referenced.has(record.outboxId)),
    deliveries,
    writerFence,
  }
}

function decodeWriterFence(value: unknown): HostedApprovalWriterFenceIdentity {
  const writerFence = object(value, 'writer fence')
  exact(writerFence, ['generation', 'dev', 'ino'], 'writer fence')
  if (typeof writerFence.generation !== 'string' || !/^approval-writer-fence_[0-9a-f]{32}$/.test(writerFence.generation) ||
    typeof writerFence.dev !== 'string' || !/^\d+$/.test(writerFence.dev) ||
    typeof writerFence.ino !== 'string' || !/^\d+$/.test(writerFence.ino)) {
    throw new Error('Invalid hosted approval WAL writer fence')
  }
  return writerFence as unknown as HostedApprovalWriterFenceIdentity
}

function decodeLegacyWalRoute(value: unknown, actors: Record<string, unknown>): HostedApprovalRuntimeRoute {
  const route = object(value, 'legacy v1 WAL route')
  exact(route, ['routeId', 'authority', 'scope', 'memberName', 'openCodeBinding'], 'legacy v1 WAL route')
  const binding = object(route.openCodeBinding, 'legacy v1 WAL OpenCode binding')
  exact(binding, ['toolApprovalMode', 'planGeneration', 'credentialGeneration', 'credentialId', 'runtimeInstanceId', 'deliveryOwnerId', 'sessionRecordFingerprint', 'liveEffectFingerprint'], 'legacy v1 WAL OpenCode binding')
  return decodeWalRoute({
    ...route,
    openCodeBinding: { ...binding, openCodeArtifactDigest: `sha256:${'0'.repeat(64)}` },
  }, actors)
}

function decodeWalRoute(value: unknown, actors: Record<string, unknown>): HostedApprovalRuntimeRoute {
  const route = object(value, 'WAL route')
  exact(route, ['routeId', 'authority', 'scope', 'memberName', 'openCodeBinding'], 'WAL route')
  const authority = object(route.authority, 'WAL route authority')
  exact(authority, ['deploymentId', 'teamId', 'runId', 'planGeneration', 'laneId', 'providerId', 'credentialGeneration', 'credentialId', 'sessionId', 'runtimeInstanceId', 'deliveryOwnerId'], 'WAL route authority')
  const scope = object(route.scope, 'WAL route scope')
  exact(scope, ['principalId', 'workspaceId', 'teamId', 'authorityGeneration', 'restoreGeneration'], 'WAL route scope')
  const binding = object(route.openCodeBinding, 'WAL OpenCode binding')
  exact(binding, ['toolApprovalMode', 'planGeneration', 'credentialGeneration', 'credentialId', 'runtimeInstanceId', 'deliveryOwnerId', 'openCodeArtifactDigest', 'sessionRecordFingerprint', 'liveEffectFingerprint'], 'WAL OpenCode binding')
  if (!identifier(route.routeId) || !identifier(route.memberName) || authority.providerId !== 'opencode' ||
    !identifier(authority.deploymentId) || typeof authority.teamId !== 'string' || !/^team_[0-9a-f]{32}$/.test(authority.teamId) ||
    typeof authority.runId !== 'string' || !/^run_[0-9a-f]{32}$/.test(authority.runId) || !positive(authority.planGeneration) ||
    !identifier(authority.laneId) || !positive(authority.credentialGeneration) || !identifier(authority.credentialId) ||
    !identifier(authority.sessionId) || !identifier(authority.runtimeInstanceId) || typeof authority.deliveryOwnerId !== 'string' ||
    !/^member_[0-9a-f]{32}$/.test(authority.deliveryOwnerId) || typeof scope.principalId !== 'string' ||
    actors[scope.principalId] !== authority.deliveryOwnerId || binding.toolApprovalMode !== 'manual' ||
    binding.planGeneration !== authority.planGeneration ||
    binding.credentialGeneration !== authority.credentialGeneration || binding.credentialId !== authority.credentialId ||
    binding.runtimeInstanceId !== authority.runtimeInstanceId || binding.deliveryOwnerId !== authority.deliveryOwnerId ||
    typeof binding.openCodeArtifactDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(binding.openCodeArtifactDigest) ||
    typeof binding.sessionRecordFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(binding.sessionRecordFingerprint) ||
    typeof binding.liveEffectFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(binding.liveEffectFingerprint) ||
    scope.teamId !== authority.teamId || !identifier(scope.workspaceId) || typeof scope.authorityGeneration !== 'string' ||
    !/^generation_[A-Za-z0-9][A-Za-z0-9._-]{0,245}$/.test(scope.authorityGeneration) ||
    !Number.isSafeInteger(scope.restoreGeneration) || (scope.restoreGeneration as number) < 0) throw new Error('Invalid hosted approval WAL route binding')
  return route as unknown as HostedApprovalRuntimeRoute
}

function decodeWalIngress(value: unknown, routes: ReadonlyMap<string, HostedApprovalRuntimeRoute>): HostedApprovalIngressRecord {
  const record = object(value, 'WAL ingress')
  exact(record, ['outboxVersion', 'outboxId', 'commandId', 'effectRef', 'deliveryRef', 'authority', 'payloadJson', 'observedAtIso', 'acceptedAtIso', 'lease', 'acknowledgedAtIso'], 'WAL ingress')
  const authority = object(record.authority, 'WAL ingress authority')
  const route = typeof authority.sessionId === 'string' ? routes.get(authority.sessionId) : undefined
  if (!route || !isDeepStrictEqual(route.authority, authority) || record.outboxVersion !== 1 ||
    typeof record.effectRef !== 'string' || !/^effect:[a-f0-9]{64}$/.test(record.effectRef) || record.outboxId !== `runtime_permission:${record.effectRef}` ||
    !identifier(record.commandId) || typeof record.deliveryRef !== 'string' || !/^delivery_ref_[A-Za-z0-9][A-Za-z0-9._-]{0,239}$/.test(record.deliveryRef) ||
    typeof record.payloadJson !== 'string' || Buffer.byteLength(record.payloadJson) > 136 * 1024 ||
    !iso(record.observedAtIso) || !iso(record.acceptedAtIso) || Date.parse(record.acceptedAtIso as string) < Date.parse(record.observedAtIso as string)) {
    throw new Error('Invalid hosted approval WAL ingress binding')
  }
  assertNoDuplicateJsonObjectKeys(record.payloadJson as string)
  const payload = object(JSON.parse(record.payloadJson), 'WAL ingress payload')
  exact(payload, ['schemaVersion', 'deliveryRef', 'category', 'summary', 'expiresAtMs', 'preview'], 'WAL ingress payload')
  if (payload.schemaVersion !== 1 || payload.deliveryRef !== record.deliveryRef ||
    !['file_change', 'command', 'network', 'other'].includes(String(payload.category)) || typeof payload.summary !== 'string' ||
    Buffer.byteLength(payload.summary) > 2048 || payload.summary.includes('\n') || containsHostPath(payload.summary) ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(payload.summary) || payload.preview !== null ||
    !(payload.expiresAtMs === null || Number.isSafeInteger(payload.expiresAtMs) && (payload.expiresAtMs as number) >= 0)) throw new Error('Invalid hosted approval WAL ingress payload')
  const lease = record.lease === null ? null : decodeLease(record.lease)
  if (!(record.acknowledgedAtIso === null || iso(record.acknowledgedAtIso) && lease &&
    Date.parse(record.acknowledgedAtIso as string) >= Date.parse(record.acceptedAtIso as string))) {
    throw new Error('Invalid hosted approval WAL ingress acknowledgement')
  }
  return { ...record, authority: route.authority, lease } as HostedApprovalIngressRecord
}

function decodeRetiredWalIngress(value: unknown): HostedApprovalIngressRecord {
  const record = object(value, 'retired WAL ingress')
  const authority = decodeHostedApprovalIngressAuthority(record.authority)
  if (authority.providerId !== 'opencode') throw new Error('Invalid retired hosted approval WAL provider')
  return decodeWalIngress({ ...record, authority }, new Map([[authority.sessionId, {
    routeId: 'retired', memberName: 'retired', authority,
    scope: {
      principalId: 'actor_retired', workspaceId: 'workspace_retired', teamId: authority.teamId,
      authorityGeneration: 'generation_retired', restoreGeneration: 0,
    },
    openCodeBinding: {
      toolApprovalMode: 'manual',
      planGeneration: authority.planGeneration,
      credentialGeneration: authority.credentialGeneration,
      credentialId: authority.credentialId,
      runtimeInstanceId: authority.runtimeInstanceId,
      deliveryOwnerId: authority.deliveryOwnerId,
      openCodeArtifactDigest: `sha256:${'0'.repeat(64)}`,
      sessionRecordFingerprint: '0'.repeat(64),
      liveEffectFingerprint: '0'.repeat(64),
    },
  }]]))
}

function readExactFd(fd: number, length: number): Buffer | null {
  const bytes = Buffer.alloc(length)
  return readSync(fd, bytes, 0, length, 0) === length ? bytes : null
}

function decodeLease(value: unknown): HostedApprovalIngressRecord['lease'] {
  const lease = object(value, 'WAL lease')
  exact(lease, ['generation', 'ownerId', 'leaseToken', 'claimedAtIso', 'leaseExpiresAtIso'], 'WAL lease')
  if (!positive(lease.generation) || !identifier(lease.ownerId) || !identifier(lease.leaseToken) ||
    !iso(lease.claimedAtIso) || !iso(lease.leaseExpiresAtIso) || Date.parse(lease.leaseExpiresAtIso as string) <= Date.parse(lease.claimedAtIso as string)) throw new Error('Invalid hosted approval WAL lease')
  return lease as NonNullable<HostedApprovalIngressRecord['lease']>
}

function decodeWalDelivery(value: unknown, ingress: readonly HostedApprovalIngressRecord[]): HostedApprovalDeliveryState {
  const delivery = object(value, 'WAL delivery')
  exact(delivery, ['providerDeliveryId', 'reconciliationRef', 'deliveryRef', 'payloadFingerprint', 'outboxId', 'effectRef', 'phase', 'result'], 'WAL delivery')
  const record = ingress.find(record => record.outboxId === delivery.outboxId)
  if (!identifier(delivery.providerDeliveryId) || typeof delivery.reconciliationRef !== 'string' ||
    !/^approval-reconciliation_[A-Za-z0-9][A-Za-z0-9._-]{0,191}$/.test(delivery.reconciliationRef) ||
    typeof delivery.deliveryRef !== 'string' || record?.deliveryRef !== delivery.deliveryRef ||
    typeof delivery.effectRef !== 'string' || record.effectRef !== delivery.effectRef ||
    typeof delivery.payloadFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(delivery.payloadFingerprint) ||
    !['started', 'completed', 'rejected'].includes(String(delivery.phase)) ||
    !['delivered', 'stale_generation', 'expired', 'wrong_lane', 'self_approval', 'unavailable', null].includes(delivery.result as never) ||
    (delivery.phase === 'started' && delivery.result !== null) || (delivery.phase === 'completed' && delivery.result !== 'delivered') ||
    (delivery.phase === 'rejected' && (delivery.result === null || delivery.result === 'delivered'))) throw new Error('Invalid hosted approval WAL delivery binding')
  return delivery as HostedApprovalDeliveryState
}

function object(value: unknown, field: string): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid hosted approval ${field}`); return value as Record<string, unknown> }
function exact(value: Record<string, unknown>, keys: readonly string[], field: string): void { const actual = Object.keys(value).sort(); const expected = [...keys].sort(); if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error(`Invalid hosted approval ${field} keys`) }
function identifier(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(value) }
function positive(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) > 0 }
function iso(value: unknown): value is string { return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value }
