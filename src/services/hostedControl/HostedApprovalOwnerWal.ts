import { AsyncLocalStorage } from 'node:async_hooks'
import { dlopen, FFIType, ptr, read, type Pointer } from 'bun:ffi'
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, readSync, writeSync } from 'node:fs'
import { lstat, mkdir, open, type FileHandle } from 'node:fs/promises'
import { basename, dirname, isAbsolute } from 'node:path'
import { isDeepStrictEqual, TextDecoder } from 'node:util'

import { decodeHostedApprovalIngressAuthority, type HostedApprovalIngressRecord } from './HostedApprovalWire.js'
import type { HostedApprovalRuntimeRoute } from './HostedApprovalRuntimeAdmission.js'
import { createRegularNodeAtDarwin } from './HostedApprovalOwnerWalDarwin.internal.js'
import { assertNoDuplicateJsonObjectKeys } from './ownerProof.js'
import { containsHostPath } from './hostPathSafety.js'
import {
  retainedWalImage,
  type BoundWalPublication,
  type OwnerWalMutationIntent,
  type OwnerWalNative,
  type OwnerWalPublicationProducer,
  type PreviousWalImage,
} from './HostedApprovalOwnerProvenance.js'

export type HostedApprovalDeliveryState = {
  providerDeliveryId: string
  reconciliationRef: string
  deliveryRef: string
  payloadFingerprint: string
  outboxId: string
  /** Semantic provider permission digest (legacy records retain their opaque composite value). */
  effectRef: string
  phase: 'started' | 'completed' | 'rejected'
  result: 'delivered' | 'stale_generation' | 'expired' | 'wrong_lane' | 'self_approval' | 'unavailable' | null
}

export type HostedApprovalHistoricalIngressRecord =
  Omit<HostedApprovalIngressRecord, 'outboxVersion'> & { outboxVersion: 1 | 2 }

export type HostedApprovalOwnerState = {
  schemaVersion: 3
  revision: number
  admissionGeneration: string
  admissionDigest: string
  routes: HostedApprovalRuntimeRoute[]
  actorMembers: Record<string, string>
  ingress: HostedApprovalIngressRecord[]
  /** Revoked records retained only to bind durable effect settlements/replays. */
  retiredIngress: HostedApprovalHistoricalIngressRecord[]
  /** Permanent per-run exposure ledger; legacy entries deliberately have no reconstructable digest. */
  bindings: HostedApprovalPrivateBinding[]
  deliveries: HostedApprovalDeliveryState[]
  writerFence: HostedApprovalWriterFenceIdentity
}

export type HostedApprovalPrivateBinding = {
  teamId: string
  runId: string
  requestId: string
  effectRef: string | null
  bindingDigest: string | null
  quarantined: boolean
}

export type HostedApprovalWriterFenceIdentity = {
  generation: string
  dev: string
  ino: string
}

export type HostedApprovalOwnerWalPublishResult =
  | Readonly<{ capture: 'off'; state: HostedApprovalOwnerState }>
  | Readonly<{ capture: 'bound'; state: HostedApprovalOwnerState; publication: BoundWalPublication }>

export class HostedApprovalOwnerPublicationError extends Error {
  constructor(
    readonly stage: 'definitely-not-replaced' | 'replacement-uncertain' | 'published-capture-failed',
    message: string,
    options?: ErrorOptions,
  ) { super(message, options); this.name = 'HostedApprovalOwnerPublicationError' }
}

type WalFileIdentity = { dev: number | bigint; ino: number | bigint }
type LockedWalSnapshot = {
  state: HostedApprovalOwnerState | null
  raw: Buffer | null
  stored: Record<string, unknown> | null
  identity: WalFileIdentity | null
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
  #activeSnapshot: LockedWalSnapshot | null = null
  #activePublished = false
  #publicationCaptureFailed = false
  readonly #writerContext = new AsyncLocalStorage<symbol>()
  readonly fencePath: string
  readonly lockPath: string
  constructor(readonly path: string, private readonly testHooks?: {
    afterFenceOpen?: () => Promise<void>
    afterWalRename?: () => Promise<void>
    closeWalTemp?: (fd: number) => void
    afterFenceTempFsync?: () => Promise<void>
    afterFenceLink?: () => Promise<void>
    beforeRetainedCreate?: () => void
    afterRetainedCreate?: (name: string) => void
  }, private readonly publicationProducer?: OwnerWalPublicationProducer) {
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
      const snapshot = this.#readPinnedSnapshot(parentHandle)
      const state = snapshot.state
      this.#activeSnapshot = snapshot
      this.#activePublished = false
      if (state && !isDeepStrictEqual(state.writerFence, acquired.identity)) {
        throw new Error('Hosted approval WAL writer-fence generation mismatch')
      }
      const result = await this.#writerContext.run(writer, async () => {
        const value = await operation(state)
        if (!(await this.ownsCurrentFence())) {
          this.#invalidatePublicationCapture('owner-wal-final-fence-lost')
          if (this.#activePublished) throw new HostedApprovalOwnerPublicationError(
            'replacement-uncertain', 'Hosted approval writer fence changed after publication',
          )
          throw new Error('Hosted approval writer fence changed before commit')
        }
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
      this.#activeSnapshot = null
      this.#activePublished = false
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
    return this.#readPinnedSnapshot(parent).state
  }

  #readPinnedSnapshot(parent: FileHandle): LockedWalSnapshot {
    if (!existsAt(parent.fd, basename(this.path))) return { state: null, raw: null, stored: null, identity: null }
    const fd = openAt(parent.fd, basename(this.path), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size < 2 || stat.size > MAX_BYTES ||
        (process.getuid?.() !== undefined && stat.uid !== process.getuid())) throw new Error('Unsafe hosted approval WAL')
      const raw = readExactFd(fd, stat.size)
      if (!raw || raw.byteLength < 2 || raw.byteLength > MAX_BYTES) throw new Error('Hosted approval WAL size changed')
      // Custody P before any parser or migration can transform its meaning.
      const retainedRaw = Buffer.from(raw)
      const state = parseOwnerStateSource(retainedRaw)
      return { state, raw: retainedRaw, stored: parseStoredOwnerState(retainedRaw), identity: { dev: stat.dev, ino: stat.ino } }
    } finally { closeSync(fd) }
  }

  async publish(previous: HostedApprovalOwnerState | null, next: Omit<HostedApprovalOwnerState, 'revision' | 'writerFence'> & Partial<Pick<HostedApprovalOwnerState, 'writerFence'>>): Promise<HostedApprovalOwnerState> {
    if (this.publicationProducer) throw new Error('Hosted approval typed WAL publication intent required')
    return (await this.#publish(previous, next, null)).state
  }

  async publishMutation(
    previous: HostedApprovalOwnerState | null,
    next: Omit<HostedApprovalOwnerState, 'revision' | 'writerFence'> & Partial<Pick<HostedApprovalOwnerState, 'writerFence'>>,
    intent: OwnerWalMutationIntent,
  ): Promise<HostedApprovalOwnerWalPublishResult> {
    return this.#publish(previous, next, intent)
  }

  /** Invalidates an active capture when authority fails after a real publication. */
  poisonPublicationCapture(reason: string): void {
    if (this.#activePublished) this.#invalidatePublicationCapture(reason)
  }

  /** Capture failure revokes local effect authority for this WAL's lifetime, not reconciliation reads. */
  isPublicationCaptureCurrent(): boolean { return !this.#publicationCaptureFailed }

  #invalidatePublicationCapture(reason: string): void {
    if (!this.publicationProducer) return
    this.#publicationCaptureFailed = true
    try { this.publicationProducer.poison(reason) } catch { /* local revocation survives producer/caller error handling */ }
  }

  async #publish(
    previous: HostedApprovalOwnerState | null,
    next: Omit<HostedApprovalOwnerState, 'revision' | 'writerFence'> & Partial<Pick<HostedApprovalOwnerState, 'writerFence'>>,
    intent: OwnerWalMutationIntent | null,
  ): Promise<HostedApprovalOwnerWalPublishResult> {
    if (!this.isPublicationCaptureCurrent()) {
      throw new HostedApprovalOwnerPublicationError('definitely-not-replaced', 'Hosted approval WAL capture poisoned')
    }
    if (!this.#activeWriter || !this.#activeFenceIdentity || this.#writerContext.getStore() !== this.#activeWriter) {
      throw new HostedApprovalOwnerPublicationError('definitely-not-replaced', 'Hosted approval WAL publish requires writer fence')
    }
    if (!(await this.ownsCurrentFence())) throw new HostedApprovalOwnerPublicationError('definitely-not-replaced', 'Hosted approval writer fence changed')
    const activeSnapshot = this.#activeSnapshot
    if (!activeSnapshot) throw new HostedApprovalOwnerPublicationError('definitely-not-replaced', 'Hosted approval WAL retained predecessor unavailable')
    const current = this.#readPinnedSnapshot(this.#activeParentHandle!)
    if (!isDeepStrictEqual(current.state, previous) || !sameOptionalBytes(current.raw, activeSnapshot.raw) ||
      !isDeepStrictEqual(current.identity, activeSnapshot.identity)) {
      throw new HostedApprovalOwnerPublicationError('definitely-not-replaced', 'Hosted approval WAL compare-and-swap conflict')
    }
    let state: HostedApprovalOwnerState
    let bytes: Buffer
    let prepared: ReturnType<OwnerWalPublicationProducer['prepare']> | null = null
    let native: OwnerWalNative | null = null
    let previousImage: PreviousWalImage = { kind: 'absent' }
    let nextImage: ReturnType<typeof retainedWalImage>
    try {
      state = compactOwnerState(decodeOwnerState({
        ...next,
        writerFence: this.#activeFenceIdentity,
        revision: (previous?.revision ?? 0) + 1,
      }))
      bytes = Buffer.from(`${JSON.stringify(state)}\n`)
      if (bytes.byteLength > MAX_BYTES) throw new Error('Hosted approval WAL exceeds limit')
      nextImage = retainedWalImage(bytes)
      if (this.publicationProducer) {
        if (!intent) throw new Error('Hosted approval typed WAL publication intent required')
        previousImage = activeSnapshot.raw
          ? { kind: 'retained', image: retainedWalImage(activeSnapshot.raw) }
          : { kind: 'absent' }
        validateMutationWitness(intent, previous, next)
        native = ownerWalNative(activeSnapshot, state, bytes, intent)
        try { prepared = this.publicationProducer.prepare({ intent, native, previous: previousImage, next: nextImage }) } catch (error) {
          this.#invalidatePublicationCapture('owner-wal-capture-prepare-failed')
          throw error
        }
      }
    } catch (error) {
      throw new HostedApprovalOwnerPublicationError('definitely-not-replaced',
        error instanceof Error ? error.message : 'Hosted approval WAL publication preparation failed', { cause: error })
    }
    let identity: WalFileIdentity
    try { identity = await this.#publishExact(bytes) } catch (error) {
      if (error instanceof HostedApprovalOwnerPublicationError) {
        if (error.stage === 'replacement-uncertain') {
          this.#invalidatePublicationCapture('owner-wal-replacement-uncertain')
        }
        throw error
      }
      throw new HostedApprovalOwnerPublicationError('definitely-not-replaced', 'Hosted approval WAL publication failed', { cause: error })
    }
    this.#activePublished = true
    if (!(await this.ownsCurrentFence())) {
      this.#invalidatePublicationCapture('owner-wal-final-fence-lost')
      throw new HostedApprovalOwnerPublicationError('replacement-uncertain', 'Hosted approval writer fence changed after publication')
    }
    this.#activeSnapshot = { state, raw: Buffer.from(bytes), stored: JSON.parse(bytes.toString('utf8')) as Record<string, unknown>, identity }
    let publication: BoundWalPublication | null = null
    if (prepared) {
      try { publication = prepared.emit() } catch (error) {
        this.#invalidatePublicationCapture('owner-wal-published-capture-failed')
        throw new HostedApprovalOwnerPublicationError('published-capture-failed', 'Hosted approval WAL published but native capture failed', { cause: error })
      }
    }
    return publication ? { capture: 'bound', state, publication } : { capture: 'off', state }
  }

  /**
   * Returns a single-use synchronous effect-edge token for the exact WAL image,
   * parent directory, and SQLite writer-fence incarnation owned by this writer.
   */
  async prepareEffectToken(expected: HostedApprovalOwnerState): Promise<{ consume(): boolean } | null> {
    if (!this.isPublicationCaptureCurrent() || !this.#activeWriter || !this.#activeFenceIdentity ||
      this.#writerContext.getStore() !== this.#activeWriter || !(await this.ownsCurrentFence()) ||
      !this.isPublicationCaptureCurrent()) return null
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
            if (!this.isPublicationCaptureCurrent()) return false
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

  async #publishExact(bytes: Uint8Array): Promise<WalFileIdentity> {
    const directory = dirname(this.path)
    const parent = this.#activeParentHandle
    if (!parent) throw new Error('Hosted approval WAL parent authority unavailable')
    const walName = basename(this.path)
    const tempName = `${walName}.tmp.${process.pid}.${randomUUID()}`
    let tempFd = -1
    let renamed = false
    try {
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
        try { await this.testHooks?.afterWalRename?.() } catch (error) {
          throw new HostedApprovalOwnerPublicationError('replacement-uncertain', 'Hosted approval WAL replacement uncertain', { cause: error })
        }
        const currentWritten = fstatSync(tempFd)
        const publishedFd = openAt(parent.fd, walName, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
        const linkedWal = fstatSync(publishedFd)
        closeSync(publishedFd)
        if (currentWritten.dev !== linkedWal.dev || currentWritten.ino !== linkedWal.ino) {
          throw new HostedApprovalOwnerPublicationError('replacement-uncertain', 'Hosted approval WAL publication substituted')
        }
        const exact = readExactFd(tempFd, encoded.length)
        if (!exact?.equals(encoded)) {
          throw new HostedApprovalOwnerPublicationError('replacement-uncertain', 'Hosted approval WAL publication bytes changed')
        }
        await parent.sync()
        const finalWritten = fstatSync(tempFd)
        const finalFd = openAt(parent.fd, walName, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
        const finalWal = fstatSync(finalFd)
        closeSync(finalFd)
        if (finalWritten.dev !== finalWal.dev || finalWritten.ino !== finalWal.ino) {
          throw new HostedApprovalOwnerPublicationError('replacement-uncertain', 'Hosted approval WAL durability edge substituted')
        }
        return { dev: finalWritten.dev, ino: finalWritten.ino }
      } finally {
        // Cleanup participates in the same replacement-stage boundary as I/O.
        // A close failure after rename cannot prove that N was never installed.
        try { if (tempFd >= 0) (this.testHooks?.closeWalTemp ?? closeSync)(tempFd) } finally {
          if (!renamed && existsAt(parent.fd, tempName)) {
            try { unlinkAt(parent.fd, tempName) } catch { /* best-effort cleanup in the owned namespace */ }
          }
        }
      }
    } catch (error) {
      if (renamed && !(error instanceof HostedApprovalOwnerPublicationError)) {
        throw new HostedApprovalOwnerPublicationError('replacement-uncertain', 'Hosted approval WAL replacement uncertain', { cause: error })
      }
      throw error
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
  const legacyOutbox = new Set(state.retiredIngress
    .filter(isLegacyIngress)
    .map(record => record.outboxId))
  const legacyDeliveryIds = new Set(state.deliveries
    .filter(delivery => legacyOutbox.has(delivery.outboxId))
    .map(delivery => delivery.outboxId))
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
  const retainedOutbox = new Set([...terminalDeliveryIds, ...activeDeliveryIds, ...legacyDeliveryIds, ...acknowledgedIds])
  let compacted: HostedApprovalOwnerState = {
    ...state,
    ingress: state.ingress.filter(record =>
      record.acknowledgedAtIso === null || retainedOutbox.has(record.outboxId)),
    retiredIngress: state.retiredIngress.filter(record => retainedOutbox.has(record.outboxId)),
    deliveries: state.deliveries.filter(delivery =>
      delivery.phase === 'started' || terminalDeliveryIds.has(delivery.outboxId) || legacyDeliveryIds.has(delivery.outboxId)),
  }
  // Active/ambiguous records are never discarded. If they alone exceed the
  // recovery budget, the caller receives deterministic backpressure instead of
  // growing until the 32 MiB hard failure.
  if (Buffer.byteLength(JSON.stringify(compacted)) > RETENTION_TARGET_BYTES) {
    const activeOnly = {
      ...compacted,
      ingress: compacted.ingress.filter(record => record.acknowledgedAtIso === null || activeDeliveryIds.has(record.outboxId)),
      retiredIngress: compacted.retiredIngress.filter(record =>
        activeDeliveryIds.has(record.outboxId) || legacyDeliveryIds.has(record.outboxId)),
      deliveries: compacted.deliveries.filter(delivery =>
        delivery.phase === 'started' || legacyDeliveryIds.has(delivery.outboxId)),
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

function parseStoredOwnerState(raw: Uint8Array): Record<string, unknown> {
  const source = new TextDecoder('utf-8', { fatal: true }).decode(raw)
  assertNoDuplicateJsonObjectKeys(source)
  return object(JSON.parse(source), 'stored WAL')
}

function sameOptionalBytes(left: Buffer | null, right: Buffer | null): boolean {
  return left === null ? right === null : right !== null && left.equals(right)
}

const OWNER_COLLECTIONS = ['actorMembers', 'bindings', 'deliveries', 'ingress', 'retiredIngress', 'routes'] as const
function ownerWalNative(
  previous: LockedWalSnapshot,
  next: HostedApprovalOwnerState,
  nextBytes: Uint8Array,
  intent: OwnerWalMutationIntent,
): OwnerWalNative {
  const nextStored = next as unknown as Record<string, unknown>
  const priorStored = previous.stored
  const changedFields = Object.keys(nextStored)
    .filter(key => !priorStored || !Object.prototype.hasOwnProperty.call(priorStored, key) ||
      !isDeepStrictEqual(priorStored[key], nextStored[key]))
    .sort((left, right) => Buffer.from(left).compare(Buffer.from(right))) as (keyof HostedApprovalOwnerState)[]
  const collectionSizes = Object.fromEntries(OWNER_COLLECTIONS.map(key => [key, {
    previous: storedCollectionSize(priorStored, key), next: storedCollectionSize(nextStored, key),
  }])) as OwnerWalNative['stateDelta']['collectionSizes']
  const nextHash = createHash('sha256').update(nextBytes).digest('hex')
  const previousHash = previous.raw ? createHash('sha256').update(previous.raw).digest('hex') : null
  const previousRevision = priorStored ? priorStored.revision as number : null
  return Object.freeze({
    fence: Object.freeze({ ...next.writerFence }), mutation: intent.mutation, revision: next.revision,
    stateDelta: Object.freeze({ changedFields: Object.freeze(changedFields), collectionSizes: Object.freeze(collectionSizes),
      nextRevision: next.revision, nextStateSha256: nextHash, previousRevision, previousStateSha256: previousHash }),
    wal: Object.freeze({ byteSize: nextBytes.byteLength, sha256: nextHash }),
  })
}

function storedCollectionSize(state: Record<string, unknown> | null, key: typeof OWNER_COLLECTIONS[number]): number {
  if (!state || !Object.prototype.hasOwnProperty.call(state, key)) return 0
  const value = state[key]
  if (key === 'actorMembers') return Object.keys(object(value, 'stored actor members')).length
  if (!Array.isArray(value)) throw new Error(`Invalid hosted approval stored ${key}`)
  return value.length
}

function validateMutationWitness(
  intent: OwnerWalMutationIntent,
  previous: HostedApprovalOwnerState | null,
  proposed: Omit<HostedApprovalOwnerState, 'revision' | 'writerFence'> & Partial<Pick<HostedApprovalOwnerState, 'writerFence'>>,
): void {
  if (!/^[0-9a-f]{64}$/u.test(intent.operationNonce)) throw new Error('Invalid hosted approval WAL operation nonce')
  switch (intent.mutation.kind) {
    case 'admission-reconciled': {
      if (!('admission' in intent)) throw new Error('Hosted approval admission publication witness mismatch')
      const admittedIngress = previous?.ingress.filter(record => {
        const oldRoute = previous.routes.find(route => isDeepStrictEqual(route.authority, record.authority))
        return !!oldRoute && intent.admission.routes.some(route => isDeepStrictEqual(route, oldRoute))
      }) ?? []
      const activeOutbox = new Set(admittedIngress.map(record => record.outboxId))
      const durableOutbox = new Set((previous?.deliveries ?? []).map(delivery => delivery.outboxId))
      const expectedRetired = [...new Map([...(previous?.retiredIngress ?? []), ...(previous?.ingress ?? [])]
        .filter(record => !activeOutbox.has(record.outboxId) && durableOutbox.has(record.outboxId))
        .map(record => [record.outboxId, record])).values()]
      if (proposed.admissionDigest !== intent.admission.digest || proposed.admissionGeneration !== intent.admission.admissionGeneration ||
        !isDeepStrictEqual(proposed.routes, intent.admission.routes) || !isDeepStrictEqual(proposed.actorMembers, intent.admission.actorMembers) ||
        !isDeepStrictEqual(proposed.ingress, admittedIngress) || !isDeepStrictEqual(proposed.retiredIngress, expectedRetired) ||
        !isDeepStrictEqual(proposed.bindings, previous?.bindings ?? []) || !isDeepStrictEqual(proposed.deliveries, previous?.deliveries ?? [])) {
        throw new Error('Hosted approval admission publication witness mismatch')
      }
      return
    }
    case 'ingress-admitted':
      if (!('record' in intent) || !previous || !sameProposedExcept(previous, proposed, ['bindings', 'ingress']) ||
        !isDeepStrictEqual(proposed.ingress, [...previous.ingress, intent.record]) ||
        proposed.bindings.length !== previous.bindings.length + 1 || !isDeepStrictEqual(proposed.bindings.slice(0, -1), previous.bindings) ||
        !isDeepStrictEqual(proposed.bindings.at(-1), expectedBinding(intent.record, false))) {
        throw new Error('Hosted approval ingress publication witness mismatch')
      }
      return
    case 'binding-quarantined':
      if (!('record' in intent) || !previous || !sameProposedExcept(previous, proposed, ['bindings']) ||
        proposed.bindings.length !== previous.bindings.length + 1 || !isDeepStrictEqual(proposed.bindings.slice(0, -1), previous.bindings) ||
        !isDeepStrictEqual(proposed.bindings.at(-1), expectedBinding(intent.record, true))) {
        throw new Error('Hosted approval quarantine publication witness mismatch')
      }
      return
    case 'ingress-lease-claimed':
      if (!('records' in intent) || !previous || !sameProposedExcept(previous, proposed, ['ingress']) ||
        intent.records.length === 0 || intent.records.length !== intent.mutation.claims.length ||
        new Set(intent.records.map(record => record.outboxId)).size !== intent.records.length ||
        !isDeepStrictEqual(intent.records.map(record => record.outboxId), previous.ingress
          .filter(record => intent.records.some(changed => changed.outboxId === record.outboxId)).map(record => record.outboxId)) ||
        !isDeepStrictEqual(proposed.ingress, previous.ingress.map(record =>
          intent.records.find(changed => changed.outboxId === record.outboxId) ?? record)) || intent.records.some((record, index) =>
          !validLeaseClaim(previous.ingress.find(old => old.outboxId === record.outboxId), record) || !record.lease ||
          !isDeepStrictEqual(intent.mutation.claims[index], { outboxId: record.outboxId, ...record.lease }))) {
        throw new Error('Hosted approval claim publication witness mismatch')
      }
      return
    case 'ingress-acknowledged': {
      if (!('request' in intent)) throw new Error('Hosted approval acknowledgement publication witness mismatch')
      const old = previous?.ingress.find(record => record.outboxId === intent.request.outboxId)
      const lease = old?.lease
      const acknowledgedAt = Date.parse(intent.record.acknowledgedAtIso ?? '')
      if (!previous || !old || !lease || !sameProposedExcept(previous, proposed, ['ingress']) ||
        old.acknowledgedAtIso !== null || !Number.isFinite(acknowledgedAt) ||
        lease.generation !== intent.request.generation || lease.ownerId !== intent.request.ownerId ||
        lease.leaseToken !== intent.request.leaseToken || acknowledgedAt < Date.parse(lease.claimedAtIso) ||
        acknowledgedAt >= Date.parse(lease.leaseExpiresAtIso) ||
        !isDeepStrictEqual(intent.record, { ...old, acknowledgedAtIso: intent.record.acknowledgedAtIso }) ||
        !isDeepStrictEqual(proposed.ingress, previous.ingress.map(record => record === old ? intent.record : record))) {
        throw new Error('Hosted approval acknowledgement publication witness mismatch')
      }
      return
    }
    case 'delivery-started':
      if (!('delivery' in intent) || !previous || !sameProposedExcept(previous, proposed, ['deliveries']) ||
        intent.delivery.phase !== 'started' || intent.delivery.result !== null ||
        !isDeepStrictEqual(proposed.deliveries, [...previous.deliveries, intent.delivery])) throw new Error('Hosted approval started publication witness mismatch')
      return
    case 'delivery-settled':
      if (!('delivery' in intent) || !previous || !sameProposedExcept(previous, proposed, ['deliveries']) ||
        intent.delivery.phase === 'started' || !validSettlementTransition(previous.deliveries, proposed.deliveries, intent.delivery) ||
        intent.mutation.phase !== intent.delivery.phase || intent.mutation.outcome !== intent.delivery.result) throw new Error('Hosted approval settlement publication witness mismatch')
  }
}

function expectedBinding(record: HostedApprovalIngressRecord, quarantined: boolean): HostedApprovalPrivateBinding {
  return { teamId: record.authority.teamId, runId: record.authority.runId, requestId: record.commandId,
    effectRef: record.effectRef, bindingDigest: record.outboxId.slice('runtime_permission:effect:'.length), quarantined }
}

function validSettlementTransition(
  previous: readonly HostedApprovalDeliveryState[],
  proposed: readonly HostedApprovalDeliveryState[],
  delivery: HostedApprovalDeliveryState,
): boolean {
  if (proposed.length === previous.length + 1) return delivery.phase === 'rejected' &&
    isDeepStrictEqual(proposed, [...previous, delivery])
  if (proposed.length !== previous.length) return false
  const index = previous.findIndex(item => item.providerDeliveryId === delivery.providerDeliveryId)
  if (index < 0 || previous[index]!.phase !== 'started') return false
  if (!isDeepStrictEqual(delivery, { ...previous[index]!, phase: delivery.phase, result: delivery.result })) return false
  return isDeepStrictEqual(proposed, previous.map((item, itemIndex) => itemIndex === index ? delivery : item))
}

function validLeaseClaim(previous: HostedApprovalIngressRecord | undefined, next: HostedApprovalIngressRecord): boolean {
  return !!previous && previous.acknowledgedAtIso === null && !!next.lease &&
    next.lease.generation === (previous.lease?.generation ?? 0) + 1 &&
    (!previous.lease || Date.parse(previous.lease.leaseExpiresAtIso) <= Date.parse(next.lease.claimedAtIso)) &&
    isDeepStrictEqual(next, { ...previous, lease: next.lease })
}

function sameProposedExcept(
  previous: HostedApprovalOwnerState,
  proposed: Omit<HostedApprovalOwnerState, 'revision' | 'writerFence'> & Partial<Pick<HostedApprovalOwnerState, 'writerFence'>>,
  changed: readonly (keyof HostedApprovalOwnerState)[],
): boolean {
  const fields = ['schemaVersion', 'admissionGeneration', 'admissionDigest', 'routes', 'actorMembers', 'ingress',
    'retiredIngress', 'bindings', 'deliveries'] as const
  return fields.every(field => changed.includes(field) || isDeepStrictEqual(previous[field], proposed[field]))
}

export function decodeOwnerState(value: unknown): HostedApprovalOwnerState {
  const state = object(value, 'WAL')
  if (state.schemaVersion === 1) return migrateLegacyOwnerState(state)
  if (state.schemaVersion === 2) return migrateSchema2OwnerState(state)
  exact(state, ['schemaVersion', 'revision', 'admissionGeneration', 'admissionDigest', 'routes', 'actorMembers', 'ingress', 'retiredIngress', 'bindings', 'deliveries', 'writerFence'], 'WAL')
  if (state.schemaVersion !== 3 || !Number.isSafeInteger(state.revision) || (state.revision as number) < 1 ||
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
  if (!Array.isArray(state.bindings)) throw new Error('Invalid hosted approval WAL bindings')
  const bindings = state.bindings.map(decodePrivateBinding)
  const deliveries = state.deliveries.map(value => decodeWalDelivery(value, allIngress))
  const exposed = bindings.filter(binding => !binding.quarantined)
  const legacyTuples = new Set(bindings
    .filter(binding => binding.effectRef === null && binding.bindingDigest === null)
    .map(bindingTuple))
  const exposureKeys = exposed.map(binding => [binding.teamId, binding.runId, binding.requestId, binding.effectRef].join('\0'))
  const privateDigests = bindings
    .filter(binding => binding.bindingDigest !== null)
    .map(binding => binding.bindingDigest)
  const bindingIdentities = bindings.map(binding =>
    [binding.teamId, binding.runId, binding.requestId, binding.effectRef, binding.bindingDigest].join('\0'))
  const everyIngressBound = ingress.every(record => exposed.some(binding =>
    binding.teamId === record.authority.teamId && binding.runId === record.authority.runId &&
    binding.requestId === record.commandId && binding.effectRef === record.effectRef &&
    binding.bindingDigest === record.outboxId.slice('runtime_permission:effect:'.length)))
  const everyRetiredBound = retiredIngress.every(record => isLegacyIngress(record)
    ? bindings.some(binding => binding.teamId === record.authority.teamId &&
      binding.runId === record.authority.runId && binding.requestId === record.commandId &&
      binding.effectRef === null && binding.bindingDigest === null && binding.quarantined)
    : exposed.some(binding => binding.teamId === record.authority.teamId &&
      binding.runId === record.authority.runId && binding.requestId === record.commandId &&
      binding.effectRef === record.effectRef &&
      binding.bindingDigest === record.outboxId.slice('runtime_permission:effect:'.length)))
  if (new Set(routes.map(route => route.routeId)).size !== routes.length ||
    new Set(routes.map(route => route.authority.sessionId)).size !== routes.length ||
    new Set(allIngress.map(record => record.outboxId)).size !== allIngress.length ||
    new Set(allIngress.map(record => record.deliveryRef)).size !== allIngress.length ||
    new Set(deliveries.map(record => record.providerDeliveryId)).size !== deliveries.length ||
    new Set(deliveries.map(record => record.reconciliationRef)).size !== deliveries.length ||
    new Set(deliveries.map(record => record.deliveryRef)).size !== deliveries.length ||
    new Set(deliveries.map(record => record.outboxId)).size !== deliveries.length ||
    new Set(exposureKeys).size !== exposureKeys.length ||
    new Set(privateDigests).size !== privateDigests.length ||
    new Set(bindingIdentities).size !== bindingIdentities.length ||
    exposed.some(binding => legacyTuples.has(bindingTuple(binding))) ||
    ingress.some(record => legacyTuples.has(ingressTuple(record))) ||
    !everyIngressBound || !everyRetiredBound) {
    throw new Error('Invalid duplicate hosted approval WAL identity')
  }
  return {
    schemaVersion: 3, revision: state.revision as number,
    admissionGeneration: state.admissionGeneration, admissionDigest: state.admissionDigest,
    routes, actorMembers: actors as Record<string, string>, ingress, retiredIngress, bindings, deliveries,
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
    new Set(deliveries.map(record => record.outboxId)).size !== deliveries.length) {
    throw new Error('Invalid duplicate hosted approval legacy v1 WAL identity')
  }
  const referenced = new Set(deliveries.map(delivery => delivery.outboxId))
  return {
    schemaVersion: 3,
    revision: state.revision as number,
    admissionGeneration: state.admissionGeneration,
    admissionDigest: state.admissionDigest,
    routes: [],
    actorMembers: {},
    ingress: [],
    retiredIngress: allIngress.filter(record => referenced.has(record.outboxId)),
    bindings: [...new Map(allIngress.map(record => {
      const binding = legacyPrivateBinding(record)
      return [[binding.teamId, binding.runId, binding.requestId].join('\0'), binding] as const
    })).values()],
    deliveries,
    writerFence,
  }
}

/** Schema 2 used a composite effect hash and retained no raw permission, so D cannot be recovered. */
function migrateSchema2OwnerState(state: Record<string, unknown>): HostedApprovalOwnerState {
  exact(state, ['schemaVersion', 'revision', 'admissionGeneration', 'admissionDigest', 'routes', 'actorMembers', 'ingress', 'retiredIngress', 'deliveries', 'writerFence'], 'schema2 WAL')
  if (!Number.isSafeInteger(state.revision) || (state.revision as number) < 1 ||
    typeof state.admissionGeneration !== 'string' ||
    !/^approval-admission-generation_[A-Za-z0-9][A-Za-z0-9._-]{0,223}$/.test(state.admissionGeneration) ||
    typeof state.admissionDigest !== 'string' || !/^[0-9a-f]{64}$/.test(state.admissionDigest) ||
    !Array.isArray(state.routes) || !Array.isArray(state.ingress) ||
    !Array.isArray(state.retiredIngress) || !Array.isArray(state.deliveries)) {
    throw new Error('Invalid hosted approval schema2 WAL scalar')
  }
  const actors = object(state.actorMembers, 'schema2 actor members')
  for (const [actor, member] of Object.entries(actors)) {
    if (!/^actor_[A-Za-z0-9][A-Za-z0-9._-]{0,121}$/.test(actor) ||
      typeof member !== 'string' || !/^member_[0-9a-f]{32}$/.test(member)) {
      throw new Error('Invalid hosted approval schema2 actor mapping')
    }
  }
  const writerFence = decodeWriterFence(state.writerFence)
  const routes = state.routes.map(value => decodeWalRoute(value, actors))
  const routeIds = routes.map(route => route.routeId)
  const sessionIds = routes.map(route => route.authority.sessionId)
  if (new Set(routeIds).size !== routes.length || new Set(sessionIds).size !== routes.length) {
    throw new Error('Invalid duplicate hosted approval schema2 route identity')
  }
  const routeBySession = new Map(routes.map(route => [route.authority.sessionId, route]))
  const ingress = state.ingress.map(value => decodeSchema2WalIngress(value, routeBySession))
  const retiredIngress = state.retiredIngress.map(decodeSchema2RetiredIngress)
  const allIngress = [...ingress, ...retiredIngress]
  const deliveries = state.deliveries.map(value => decodeWalDelivery(value, allIngress))
  if (new Set(allIngress.map(record => record.outboxId)).size !== allIngress.length ||
    new Set(allIngress.map(record => record.deliveryRef)).size !== allIngress.length ||
    new Set(deliveries.map(record => record.providerDeliveryId)).size !== deliveries.length ||
    new Set(deliveries.map(record => record.reconciliationRef)).size !== deliveries.length ||
    new Set(deliveries.map(record => record.deliveryRef)).size !== deliveries.length ||
    new Set(deliveries.map(record => record.outboxId)).size !== deliveries.length ||
    new Set(deliveries.map(record => record.effectRef)).size !== deliveries.length) {
    throw new Error('Invalid duplicate hosted approval schema2 WAL identity')
  }
  const referenced = new Set(deliveries.map(delivery => delivery.outboxId))
  const migrated: HostedApprovalOwnerState = {
    schemaVersion: 3, revision: state.revision as number,
    admissionGeneration: state.admissionGeneration, admissionDigest: state.admissionDigest,
    routes: [], actorMembers: {}, ingress: [],
    retiredIngress: allIngress.filter(record => referenced.has(record.outboxId)),
    bindings: [...new Map(allIngress.map(record => {
      const binding = legacyPrivateBinding(record)
      return [bindingTuple(binding), binding] as const
    })).values()],
    deliveries, writerFence,
  }
  // A migration is accepted only if the exact image it returns is itself a
  // valid schema-3 recovery state.
  return decodeOwnerState(migrated)
}

function decodeSchema2WalIngress(
  value: unknown, routes: ReadonlyMap<string, HostedApprovalRuntimeRoute>,
): HostedApprovalHistoricalIngressRecord {
  const record = object(value, 'schema2 WAL ingress')
  const authority = decodeHostedApprovalIngressAuthority(record.authority)
  const route = routes.get(authority.sessionId)
  if (!route || !isDeepStrictEqual(route.authority, authority)) {
    throw new Error('Invalid hosted approval schema2 ingress route')
  }
  return decodeLegacyIngress(record, authority)
}

function decodeSchema2RetiredIngress(value: unknown): HostedApprovalHistoricalIngressRecord {
  const record = decodeRetiredWalIngress(value)
  if (record.outboxVersion !== 1) throw new Error('Invalid hosted approval schema2 ingress version')
  return record
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
  const validOutboxId = typeof record.outboxId === 'string' &&
    /^runtime_permission:effect:[a-f0-9]{64}$/.test(record.outboxId)
  const bindingDigest = validOutboxId
    ? (record.outboxId as string).slice('runtime_permission:effect:'.length) : ''
  if (!route || !isDeepStrictEqual(route.authority, authority) || record.outboxVersion !== 2 ||
    typeof record.effectRef !== 'string' || !/^effect:[a-f0-9]{64}$/.test(record.effectRef) ||
    !validOutboxId || record.deliveryRef !== `delivery_ref_opencode-${bindingDigest}` ||
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

function decodeRetiredWalIngress(value: unknown): HostedApprovalHistoricalIngressRecord {
  const record = object(value, 'retired WAL ingress')
  const authority = decodeHostedApprovalIngressAuthority(record.authority)
  if (authority.providerId !== 'opencode') throw new Error('Invalid retired hosted approval WAL provider')
  if (record.outboxVersion === 1) return decodeLegacyIngress(record, authority)
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

function decodeLegacyIngress(record: Record<string, unknown>, authority: ReturnType<typeof decodeHostedApprovalIngressAuthority>): HostedApprovalHistoricalIngressRecord {
  exact(record, ['outboxVersion', 'outboxId', 'commandId', 'effectRef', 'deliveryRef', 'authority', 'payloadJson', 'observedAtIso', 'acceptedAtIso', 'lease', 'acknowledgedAtIso'], 'legacy WAL ingress')
  if (record.outboxVersion !== 1 || typeof record.effectRef !== 'string' || !/^effect:[a-f0-9]{64}$/.test(record.effectRef) ||
    record.outboxId !== `runtime_permission:${record.effectRef}` || !identifier(record.commandId) ||
    typeof record.deliveryRef !== 'string' || !/^delivery_ref_[A-Za-z0-9][A-Za-z0-9._-]{0,239}$/.test(record.deliveryRef) ||
    typeof record.payloadJson !== 'string' || Buffer.byteLength(record.payloadJson) > 136 * 1024 ||
    !iso(record.observedAtIso) || !iso(record.acceptedAtIso) ||
    Date.parse(record.acceptedAtIso as string) < Date.parse(record.observedAtIso as string)) {
    throw new Error('Invalid hosted approval legacy ingress')
  }
  assertNoDuplicateJsonObjectKeys(record.payloadJson)
  const payload = object(JSON.parse(record.payloadJson), 'legacy WAL ingress payload')
  exact(payload, ['schemaVersion', 'deliveryRef', 'category', 'summary', 'expiresAtMs', 'preview'], 'legacy WAL ingress payload')
  if (payload.schemaVersion !== 1 || payload.deliveryRef !== record.deliveryRef ||
    !['file_change', 'command', 'network', 'other'].includes(String(payload.category)) ||
    typeof payload.summary !== 'string' || Buffer.byteLength(payload.summary) > 2048 ||
    payload.summary.includes('\n') || containsHostPath(payload.summary) ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(payload.summary) || payload.preview !== null ||
    !(payload.expiresAtMs === null || Number.isSafeInteger(payload.expiresAtMs) &&
      (payload.expiresAtMs as number) >= 0)) throw new Error('Invalid hosted approval legacy ingress payload')
  const lease = record.lease === null ? null : decodeLease(record.lease)
  if (!(record.acknowledgedAtIso === null || iso(record.acknowledgedAtIso) && lease &&
    Date.parse(record.acknowledgedAtIso as string) >= Date.parse(record.acceptedAtIso as string))) {
    throw new Error('Invalid hosted approval legacy ingress acknowledgement')
  }
  return { ...record, authority, lease } as unknown as HostedApprovalHistoricalIngressRecord
}

function decodePrivateBinding(value: unknown): HostedApprovalPrivateBinding {
  const binding = object(value, 'private binding')
  exact(binding, ['teamId', 'runId', 'requestId', 'effectRef', 'bindingDigest', 'quarantined'], 'private binding')
  if (typeof binding.teamId !== 'string' || !/^team_[0-9a-f]{32}$/.test(binding.teamId) ||
    typeof binding.runId !== 'string' || !/^run_[0-9a-f]{32}$/.test(binding.runId) || !identifier(binding.requestId) ||
    !(binding.effectRef === null || typeof binding.effectRef === 'string' && /^effect:[a-f0-9]{64}$/.test(binding.effectRef)) ||
    !(binding.bindingDigest === null || typeof binding.bindingDigest === 'string' && /^[a-f0-9]{64}$/.test(binding.bindingDigest)) ||
    typeof binding.quarantined !== 'boolean' ||
    (binding.effectRef === null || binding.bindingDigest === null) &&
      !(binding.effectRef === null && binding.bindingDigest === null && binding.quarantined)) {
    throw new Error('Invalid hosted approval private binding')
  }
  return binding as HostedApprovalPrivateBinding
}

function legacyPrivateBinding(record: HostedApprovalHistoricalIngressRecord): HostedApprovalPrivateBinding {
  return { teamId: record.authority.teamId, runId: record.authority.runId, requestId: record.commandId,
    effectRef: null, bindingDigest: null, quarantined: true }
}

function bindingTuple(binding: Pick<HostedApprovalPrivateBinding, 'teamId' | 'runId' | 'requestId'>): string {
  return [binding.teamId, binding.runId, binding.requestId].join('\0')
}

function ingressTuple(record: HostedApprovalHistoricalIngressRecord): string {
  return [record.authority.teamId, record.authority.runId, record.commandId].join('\0')
}

function isLegacyIngress(record: HostedApprovalHistoricalIngressRecord): boolean {
  return record.outboxVersion === 1
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

function decodeWalDelivery(value: unknown, ingress: readonly HostedApprovalHistoricalIngressRecord[]): HostedApprovalDeliveryState {
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
