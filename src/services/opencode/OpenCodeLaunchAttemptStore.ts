import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, realpath, rename, rmdir, stat, unlink } from 'node:fs/promises'
import path, { basename, dirname, join, parse, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { dlopen, FFIType, ptr, read } from 'bun:ffi'
import type { PlatformPath } from 'node:path'
import {
  OpenCodeWindowsPublicationAuthorityClient,
  type OpenCodeWindowsPublicationAuthorityFactory,
} from './OpenCodeWindowsPublicationAuthorityClient.js'
import { OpenCodeWindowsPublicationRejectedError } from './OpenCodeWindowsPublicationAuthorityProtocol.js'

import {
  isOpenCodeLaunchAttemptId,
  isOpenCodeLaunchPayloadHash,
  isOpenCodeOpaqueIdentity,
  type OpenCodeLaunchMemberLinkage,
  type OpenCodeOpaqueIdentity,
} from './OpenCodeBridgeContractV2.js'
import {
  OPEN_CODE_LAUNCH_FAILURE_POLICY,
  classifyOpenCodeLaunchFailure,
  type OpenCodeLaunchFailureKind,
} from './OpenCodeLaunchAttemptPolicy.js'

export const OPEN_CODE_LAUNCH_JOURNAL_VERSION = 1 as const
export const OPEN_CODE_LAUNCH_JOURNAL_MAX_BYTES = 1_048_576
export const OPEN_CODE_LAUNCH_JOURNAL_MAX_EVENTS = 4_096

export function deriveOpenCodeLaunchNamespacePaths(filePath: string, pathApi: PlatformPath): {
  directory: string; trustedRoot: string; marker: string; slots: readonly [string, string]; fence: string; lock: string
} {
  const directory = pathApi.resolve(pathApi.dirname(filePath))
  const marker = pathApi.join(directory, pathApi.basename(filePath))
  const trustedRoot = pathApi.dirname(pathApi.dirname(directory))
  const resolvedLogicalPath = pathApi.resolve(filePath)
  const logicalPathIdentity = pathApi.sep === '\\' ? resolvedLogicalPath.toLowerCase() : resolvedLogicalPath
  const authorityPrefix = pathApi.join(trustedRoot,
    `.opencode-launch-${createHash('sha256').update(logicalPathIdentity).digest('hex')}`)
  return { directory, marker, slots: [`${marker}.slot0`, `${marker}.slot1`],
    trustedRoot, fence: `${authorityPrefix}.fence`, lock: `${authorityPrefix}.lease` }
}

export type OpenCodeLaunchJournalEvent = {
  sequence: number
  generation: number
  fence: number
  memberIdentity: OpenCodeOpaqueIdentity
  /** Unique to this exclusive acquisition and member mutation. */
  claimToken: string
  /** Immutable digest of the generation in which this transition was written. */
  inputDigest: string
} & (
  | { type: 'member_intent' }
  | { type: 'member_applied'; linkage: OpenCodeLaunchMemberLinkage }
  | { type: 'member_reconciled_applied'; linkage: OpenCodeLaunchMemberLinkage }
  | { type: 'member_unknown' }
  | { type: 'member_reconciled_absent' }
  | { type: 'member_failed'; failure: OpenCodeLaunchFailureKind; externalEffect: false }
  | { type: 'cleanup'; outcome: 'complete' | 'timed_out' }
)

export type OpenCodeLaunchJournal = {
  version: 1
  attemptId: string
  payloadHash: string
  /** Locally computed digest of the immutable, ordered launch input. */
  inputDigest: string
  /** Stable launch configuration and ordered-member digest across continuations. */
  immutableDigest: string
  startedAtMs: number
  totalBudgetMs: number
  generation: number
  fence: number
  /** First successfully prepared profile; immutable across every continuation. */
  profileBinding?: OpenCodeLaunchProfileBinding
  events: OpenCodeLaunchJournalEvent[]
}

export type OpenCodeLaunchProfileBinding = {
  profileIdentity: OpenCodeOpaqueIdentity
  pluginPolicyIdentity: OpenCodeOpaqueIdentity
  cacheIdentity: OpenCodeOpaqueIdentity
  authIdentity: OpenCodeOpaqueIdentity
  configIdentity: OpenCodeOpaqueIdentity
  binaryIdentity: OpenCodeOpaqueIdentity
}

export type OpenCodeLaunchJournalIdentity = {
  attemptId: string
  payloadHash: string
  inputDigest?: string
  immutableDigest?: string
  startedAtMs?: number
  totalBudgetMs?: number
  /** Optional atomic expectation; not serialized as a second identity. */
  generation?: number
}

type WithoutJournalCoordination<T> = T extends unknown
  ? T extends { type: 'member_intent' }
    ? Omit<T, 'sequence' | 'generation' | 'fence' | 'inputDigest' | 'claimToken'> & { claimToken?: string }
    : Omit<T, 'sequence' | 'generation' | 'fence' | 'inputDigest'>
  : never
export type OpenCodeLaunchJournalAppendEvent = WithoutJournalCoordination<OpenCodeLaunchJournalEvent>
export type OpenCodeLaunchJournalReconciliationEvent = Extract<OpenCodeLaunchJournalAppendEvent,
  { type: 'member_reconciled_applied' | 'member_reconciled_absent' }>

export type OpenCodeLaunchJournalPersistence = {
  read(context?: OpenCodeLaunchStoreContext): Promise<Uint8Array | null>
  /** Implementations must replace atomically and fsync both the file and parent directory. */
  replaceAndSync(bytes: Uint8Array, context?: OpenCodeLaunchStoreContext): Promise<void>
  /** Independently durable monotonic fencing authority. */
  readFence(context?: OpenCodeLaunchStoreContext): Promise<number | null>
  compareAndSwapFence(expected: number, next: number, context?: OpenCodeLaunchStoreContext): Promise<void>
  /** Cross-process exclusive lease. File persistence implements this with atomic mkdir. */
  acquireExclusive(context: OpenCodeLaunchStoreContext): Promise<(context?: OpenCodeLaunchStoreContext) => Promise<void>>
}

export type OpenCodeLaunchStoreContext = { deadlineAtMs: number; signal: AbortSignal; monotonicNow(): number }

export class OpenCodeLaunchJournalError extends Error {
  constructor(readonly code: 'corrupt' | 'foreign' | 'fenced', message: string) {
    super(message)
    this.name = 'OpenCodeLaunchJournalError'
  }
}

export class OpenCodeLaunchPoisonedLeaseError extends OpenCodeLaunchJournalError {
  readonly physicalSettlement: Promise<void>
  constructor(
    readonly persistenceFailure: unknown,
    readonly quarantineFailure: unknown,
    /** Settles only when the ambiguous physical publication has actually stopped running. */
    physicalSettlement: Promise<void> = Promise.resolve(),
  ) {
    super('fenced', 'ambiguous journal replacement could not be durably quarantined')
    // Physical completion alone is insufficient when no durable quarantine/poison marker could be
    // confirmed. In that case this process must retain the coordination lease indefinitely.
    this.physicalSettlement = quarantineFailure === undefined
      ? physicalSettlement
      : new Promise<void>(() => undefined)
  }
}

/** Crash-safe filesystem persistence. The journal never contains its filesystem path. */
export class OpenCodeLaunchFileJournalPersistence implements OpenCodeLaunchJournalPersistence {
  private namespace?: CanonicalNamespace

  constructor(
    private readonly filePath: string,
    private readonly testHooks: {
      processBirth?: (pid: number) => Promise<string>
      syncLeaseDirectory?: (handle: NamespaceHandle) => Promise<void>
      beforeLeaseDirectoryRemove?: () => Promise<void>
      afterLeaseDirectoryDetach?: () => Promise<void>
      readNoFollowAvailable?: boolean
      afterReadHandleOpened?: (path: string) => Promise<void>
      /** Test-only boundary after the selected backend has anchored or accepted its root. */
      afterNamespaceAnchored?: () => Promise<void>
      /** Test-only platform selection; production always uses process.platform. */
      platform?: NodeJS.Platform
      windowsAuthorityFactory?: OpenCodeWindowsPublicationAuthorityFactory
    } = {},
  ) {
    if (!filePath) throw new TypeError('journal path is required')
  }

  async read(context?: OpenCodeLaunchStoreContext): Promise<Uint8Array | null> {
    ensureContext(context)
    const namespace = await this.getNamespace(context)
    await verifyNamespace(namespace)
    try {
      const markerBytes = await readNoFollow(namespace.backend, namespace.marker, 1024, this.testHooks)
      const marker = JSON.parse(new TextDecoder().decode(markerBytes)) as unknown
      if (!validCommitMarker(marker)) throw new OpenCodeLaunchJournalError('corrupt', 'invalid commit marker')
      const bytes = await readNoFollow(namespace.backend, namespace.slots[marker.slot], OPEN_CODE_LAUNCH_JOURNAL_MAX_BYTES,
        this.testHooks)
      if (sha256(bytes) !== marker.digest) throw new OpenCodeLaunchJournalError('corrupt', 'candidate digest mismatch')
      ensureContext(context)
      return bytes
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  async replaceAndSync(bytes: Uint8Array, context?: OpenCodeLaunchStoreContext): Promise<void> {
    ensureContext(context)
    const namespace = await this.getNamespace(context)
    await verifyNamespace(namespace)
    await rejectSymlink(namespace.backend, namespace.marker)
    let currentSlot: 0 | 1 = 1
    try {
      const marker = JSON.parse(new TextDecoder().decode(
        await readNoFollow(namespace.backend, namespace.marker, 1024, this.testHooks),
      )) as unknown
      if (!validCommitMarker(marker)) throw new OpenCodeLaunchJournalError('corrupt', 'invalid commit marker')
      currentSlot = marker.slot
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const slot = (currentSlot === 0 ? 1 : 0) as 0 | 1
    await atomicReplace(namespace, namespace.backend, namespace.slots[slot], bytes, context)
    // A deadline/cancellation before this point only leaves an uncommitted candidate.
    ensureContext(context)
    const marker = new TextEncoder().encode(JSON.stringify({ version: 1, slot, digest: sha256(bytes) }))
    // Marker publication is the commit point. Never publish and then throw because the caller's clock advanced.
    await atomicReplace(namespace, namespace.backend, namespace.marker, marker, context)
  }

  async readFence(context?: OpenCodeLaunchStoreContext): Promise<number | null> {
    ensureContext(context)
    const namespace = await this.getNamespace(context)
    await verifyNamespace(namespace)
    try {
      const bytes = await readNoFollow(namespace.authorityBackend, namespace.fence, 128, this.testHooks)
      const value = JSON.parse(new TextDecoder().decode(bytes)) as unknown
      if (!validFenceAnchor(value)) throw new OpenCodeLaunchJournalError('corrupt', 'invalid fence anchor')
      return value.fence
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  async compareAndSwapFence(expected: number, next: number, context?: OpenCodeLaunchStoreContext): Promise<void> {
    ensureContext(context)
    if (!Number.isSafeInteger(next) || next !== expected + 1) {
      throw new OpenCodeLaunchJournalError('fenced', 'fence must advance exactly once')
    }
    const namespace = await this.getNamespace(context)
    const actual = await this.readFence(context) ?? 0
    if (actual !== expected) throw new OpenCodeLaunchJournalError('fenced', 'durable fence changed')
    await atomicReplace(namespace, namespace.authorityBackend, namespace.fence,
      new TextEncoder().encode(JSON.stringify({ version: 1, fence: next })), context)
  }

  async acquireExclusive(context: OpenCodeLaunchStoreContext): Promise<(context?: OpenCodeLaunchStoreContext) => Promise<void>> {
    const namespace = await this.getNamespace(context)
    await verifyNamespace(namespace)
    await rejectSymlink(namespace.backend, namespace.marker)
    const lock = namespace.lock
    const authority = namespace.authorityBackend
    await rejectSymlink(authority, lock)
    while (true) {
      ensureContext(context)
      const token = randomUUID()
      const staging = `${lock}.${token}.pending`
      let published = false
      let ownerHandle: NamespaceHandle | undefined
      let stagingIdentity: NamespaceStat | undefined
      let ownerRecord: LockOwner | undefined
      try {
        await authority.mkdir(staging, 0o700)
        stagingIdentity = await authority.stat(staging)
        const owner = join(staging, 'owner.json')
        ownerRecord = { version: 1 as const, pid: process.pid,
          processBirth: await (this.testHooks.processBirth ?? processBirth)(process.pid), token }
        ownerHandle = await openNoFollowExclusive(authority, owner)
        try {
          await ownerHandle.writeFile(JSON.stringify(ownerRecord))
          await ownerHandle.sync()
        } catch (error) {
          await ownerHandle.close().catch(() => undefined)
          ownerHandle = undefined
          throw error
        }
        await authority.syncDirectory(staging)
        const visibleStaging = await authority.stat(staging)
        if (!sameFileIdentity(visibleStaging, stagingIdentity)) {
          throw new OpenCodeLaunchJournalError('foreign', 'lease staging directory identity changed')
        }
        await authority.rename(staging, lock)
        published = true
        const lockIdentity = stagingIdentity
        const visibleLock = await authority.stat(lock)
        if (!sameFileIdentity(visibleLock, lockIdentity)) {
          throw new OpenCodeLaunchJournalError('foreign', 'published lease directory identity changed')
        }
        await syncNamespace(namespace, authority, this.testHooks.syncLeaseDirectory)
        // Cancellation may win immediately after the atomic rename; explicitly reap that late acquisition.
        if (context.signal.aborted || context.monotonicNow() >= context.deadlineAtMs) {
          await releaseOwnedLock(namespace, authority, lock, ownerRecord!, ownerHandle, lockIdentity,
            this.testHooks.beforeLeaseDirectoryRemove, this.testHooks.afterLeaseDirectoryDetach).catch(() => undefined)
          ensureContext(context)
        }
        let released = false
        return async releaseContext => {
          if (!released) {
            released = true
            const effectiveContext = releaseContext ?? boundedReleaseContext()
            // Start token-checked physical release even when the caller's deadline just expired;
            // the deadline bounds waiting, while the operation is explicitly reaped late.
            const physicalRelease = releaseOwnedLock(namespace, authority, lock, ownerRecord!, ownerHandle!, lockIdentity,
              this.testHooks.beforeLeaseDirectoryRemove, this.testHooks.afterLeaseDirectoryDetach)
            try {
              await awaitWithContext(physicalRelease, effectiveContext)
              await this.closeNamespace(namespace)
            }
            catch (error) {
              // A timed-out unlink/rmdir is still reaped when the physical operation settles.
              void physicalRelease.then(() => this.closeNamespace(namespace), () => undefined)
              throw error
            }
          }
        }
      } catch (error) {
        if (published && ownerHandle) {
          await releaseOwnedLock(namespace, authority, lock, ownerRecord!, ownerHandle, await authority.stat(lock),
            this.testHooks.beforeLeaseDirectoryRemove).catch(() => undefined)
        }
        if (!published && ownerHandle && stagingIdentity) {
          await ownerHandle.close().catch(() => undefined)
          await authority.unlink(join(staging, 'owner.json')).catch(() => undefined)
          const visible = await authority.stat(staging).catch(() => undefined)
          if (visible && sameFileIdentity(visible, stagingIdentity)) await authority.rmdir(staging).catch(() => undefined)
        }
        if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
        await verifyNamespace(namespace)
        await rejectSymlink(authority, lock)
        const owner = join(lock, 'owner.json')
        try {
          const parsed = JSON.parse(new TextDecoder().decode(await readNoFollow(authority, owner, 4096))) as unknown
          if (validLockOwner(parsed)) {
            try { process.kill(parsed.pid as number, 0) }
            catch (killError) {
              if ((killError as NodeJS.ErrnoException).code === 'ESRCH') {
                await releaseOwnedLockByPath(namespace, authority, lock, parsed,
                  this.testHooks.beforeLeaseDirectoryRemove)
                continue
              }
            }
            try {
              if (await (this.testHooks.processBirth ?? processBirth)(parsed.pid as number) !== parsed.processBirth) {
                await releaseOwnedLockByPath(namespace, authority, lock, parsed,
                  this.testHooks.beforeLeaseDirectoryRemove); continue
              }
            } catch { /* A live process with unreadable birth identity is never reaped. */ }
          }
        } catch { /* The winner may still be publishing its owner record. */ }
        await boundedPause(context)
      }
    }
  }

  private async getNamespace(context?: OpenCodeLaunchStoreContext): Promise<CanonicalNamespace> {
    if (this.namespace) return this.namespace
    const paths = deriveOpenCodeLaunchNamespacePaths(this.filePath, path)
    const suppliedDirectory = paths.directory
    await createCanonicalPrivateDirectory(suppliedDirectory)
    const directory = await realpath(suppliedDirectory)
    // Accepting a symlinked parent would let a retarget create a second lock namespace.
    if (directory !== suppliedDirectory) {
      throw new OpenCodeLaunchJournalError('foreign', 'journal parent directory is a symlink')
    }
    const identity = await stat(directory)
    const marker = basename(paths.marker)
    // The requested directory and its immediate parent are mutable launch state. The ancestor
    // above both is the portable trust boundary: coordination is keyed there by the complete
    // logical journal path, so a swapped/recreated pathname cannot create another lock or fence.
    const trustedRoot = paths.trustedRoot
    const canonicalTrustedRoot = await realpath(trustedRoot)
    if (canonicalTrustedRoot !== trustedRoot) {
      throw new OpenCodeLaunchJournalError('foreign', 'journal trusted ancestor is a symlink')
    }
    const trustedIdentity = await stat(trustedRoot)
    const platform = this.testHooks.platform ?? process.platform
    if (!trustedIdentity.isDirectory()) {
      throw new OpenCodeLaunchJournalError('foreign', 'journal trusted ancestor is not a directory')
    }
    if (platform !== 'win32') {
      if ((trustedIdentity.mode & 0o022) !== 0 && (trustedIdentity.mode & 0o1000) === 0) {
        throw new OpenCodeLaunchJournalError('foreign', 'journal trusted ancestor is writable by another principal')
      }
      if (typeof process.getuid === 'function' && trustedIdentity.uid !== process.getuid()
        && (trustedIdentity.mode & 0o1000) === 0) {
        throw new OpenCodeLaunchJournalError('foreign', 'journal trusted ancestor has a foreign owner')
      }
    }
    // Node does not expose openat(2). On Unix the backend retains the directory descriptor and
    // performs every child operation through *at(2). This does not use a descriptor filesystem
    // and remains attached if any pathname ancestor is renamed.
    // Windows does not give cwd the same rename-stable contract. Its backend therefore accepts
    // only the freshly canonicalized, private directory as a trusted root and revalidates that
    // root around every operation. This intentionally is not described as atomic against an
    // administrator replacing the trusted root; normal first-use is preserved.
    const retained = platform === 'linux' || platform === 'darwin'
    const nativeWindows = platform === 'win32' && process.platform === 'win32'
    const deadline = context?.deadlineAtMs ?? performance.now() + 10_000
    const signal = context?.signal
    const backend: NamespaceBackend = retained
      ? await RetainedDirectoryBackend.create(directory, identity, true)
      : nativeWindows
      ? await RetainedWindowsNamespaceBackend.create(directory, identity, true, deadline, signal,
        this.testHooks.windowsAuthorityFactory)
      : new TrustedRootPathBackend(directory, identity, true, platform)
    const authorityBackend: NamespaceBackend = retained
      ? await RetainedDirectoryBackend.create(trustedRoot, trustedIdentity, false)
      : nativeWindows
      ? await RetainedWindowsNamespaceBackend.create(trustedRoot, trustedIdentity, false, deadline, signal,
        this.testHooks.windowsAuthorityFactory)
      : new TrustedRootPathBackend(trustedRoot, trustedIdentity, false, platform)
    await this.testHooks.afterNamespaceAnchored?.()
    this.namespace = {
      backend, authorityBackend, marker,
      slots: [`${marker}.slot0`, `${marker}.slot1`],
      fence: basename(paths.fence), lock: basename(paths.lock),
    }
    return this.namespace
  }

  private async closeNamespace(expected: CanonicalNamespace): Promise<void> {
    if (this.namespace !== expected) return
    this.namespace = undefined
    await Promise.all([expected.backend.close?.(), expected.authorityBackend.close?.()])
  }
}

/**
 * Creates a fresh journal namespace without ever following an existing symlink.
 * Each newly published directory is synced through its already-verified parent;
 * the final namespace is always private, including when an older install created
 * it with a permissive umask.
 */
async function createCanonicalPrivateDirectory(directory: string): Promise<void> {
  const parsed = resolve(directory)
  const root = parse(parsed).root
  const descendants: string[] = []
  for (let current = parsed; current !== root; current = dirname(current)) descendants.push(current)
  let current = root
  for (const next of descendants.reverse()) {
    let created = false
    try {
      const metadata = await lstat(next)
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new OpenCodeLaunchJournalError('foreign', 'journal directory ancestry is not canonical')
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      try {
        await mkdir(next, { mode: 0o700 })
        created = true
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError
      }
      const metadata = await lstat(next)
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new OpenCodeLaunchJournalError('foreign', 'journal directory publication changed identity')
      }
    }
    const canonical = await realpath(next)
    if (canonical !== next) {
      throw new OpenCodeLaunchJournalError('foreign', 'journal directory ancestry contains a symlink')
    }
    if (created) {
      await syncDirectory(current)
    }
    current = next
  }
  await chmod(directory, 0o700)
  await syncDirectory(directory)
}

type CanonicalNamespace = {
  /** Journal payloads remain in the requested logical directory. */
  backend: NamespaceBackend
  /** Locks and fencing live above the renameable parent/final path components. */
  authorityBackend: NamespaceBackend
  marker: string
  slots: readonly [string, string]
  fence: string
  lock: string
}

type NamespaceStat = {
  dev: number | bigint; ino: number | bigint; mode: number; size: number
  isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean
}

type NamespaceHandle = {
  stat(): Promise<NamespaceStat>
  writeFile(data: string | Uint8Array): Promise<void>
  readFile(): Promise<Uint8Array>
  sync(): Promise<void>
  close(): Promise<void>
}

interface NamespaceBackend {
  readonly kind: 'retained-directory' | 'trusted-root'
  lstat(name: string): Promise<NamespaceStat>
  stat(name: string): Promise<NamespaceStat>
  mkdir(name: string, mode: number): Promise<void>
  open(name: string, flags: number, mode?: number): Promise<NamespaceHandle>
  rename(from: string, to: string): Promise<void>
  unlink(name: string): Promise<void>
  rmdir(name: string): Promise<void>
  syncDirectory(name?: string): Promise<void>
  displayPath(name: string): string
  verifyRoot(): Promise<void>
  close?(): Promise<void>
}

function normalizedStat(value: {
  dev: number | bigint; ino: number | bigint; mode: number; size: number
  isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean
}): NamespaceStat {
  const file = value.isFile(); const directory = value.isDirectory(); const symlink = value.isSymbolicLink()
  return { dev: value.dev, ino: value.ino, mode: value.mode, size: value.size,
    isFile: () => file, isDirectory: () => directory, isSymbolicLink: () => symlink }
}

class TrustedRootPathBackend implements NamespaceBackend {
  readonly kind = 'trusted-root' as const
  constructor(
    private readonly root: string,
    private readonly identity: { dev: number | bigint; ino: number | bigint },
    private readonly logicalNamespace: boolean,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}
  displayPath(name: string) { return join(this.root, name) }
  async verifyRoot() {
    let current: Awaited<ReturnType<typeof lstat>>
    try { current = await lstat(this.root) }
    catch (error) {
      if (this.logicalNamespace && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new OpenCodeLaunchJournalError('fenced', 'logical journal root is detached')
      }
      throw error
    }
    if (current.isSymbolicLink() || !current.isDirectory()) {
      throw new OpenCodeLaunchJournalError('foreign', 'trusted journal root is no longer canonical')
    }
    if (!sameFileIdentity(current, this.identity)) {
      throw new OpenCodeLaunchJournalError(this.logicalNamespace ? 'fenced' : 'foreign',
        'trusted journal root identity changed')
    }
  }
  async lstat(name: string) { await this.verifyRoot(); return normalizedStat(await lstat(this.displayPath(name))) }
  async stat(name: string) { await this.verifyRoot(); return normalizedStat(await stat(this.displayPath(name))) }
  async mkdir(name: string, mode: number) { await this.verifyRoot(); await mkdir(this.displayPath(name), { mode }) }
  async open(name: string, flags: number, mode?: number): Promise<NamespaceHandle> {
    await this.verifyRoot(); return await open(this.displayPath(name), flags, mode)
  }
  async rename(from: string, to: string) { await this.verifyRoot(); await rename(this.displayPath(from), this.displayPath(to)) }
  async unlink(name: string) { await this.verifyRoot(); await unlink(this.displayPath(name)) }
  async rmdir(name: string) { await this.verifyRoot(); await rmdir(this.displayPath(name)) }
  async syncDirectory(name = '.') { await this.verifyRoot(); await syncDirectory(this.displayPath(name), this.platform) }
}

function namespaceAuthorityError(error: unknown): NodeJS.ErrnoException {
  if (error instanceof OpenCodeWindowsPublicationRejectedError) {
    const code = error.authorityCode === 'NS_NOT_FOUND' ? 'ENOENT'
      : error.authorityCode === 'NS_EXISTS' ? 'EEXIST'
      : error.authorityCode === 'NS_NOT_EMPTY' ? 'ENOTEMPTY' : undefined
    if (code) { const mapped = new Error('Windows retained namespace operation failed [redacted]') as NodeJS.ErrnoException; mapped.code = code; return mapped }
  }
  return error instanceof Error ? error : new Error('Windows retained namespace operation failed [redacted]')
}

class RetainedWindowsNamespaceBackend implements NamespaceBackend {
  readonly kind = 'retained-directory' as const
  private constructor(
    private readonly root: string,
    private readonly authority: OpenCodeWindowsPublicationAuthorityClient,
    private readonly expected: { dev: number | bigint; ino: number | bigint },
    private readonly logicalNamespace: boolean,
  ) {}
  static async create(root: string, expected: { dev: number | bigint; ino: number | bigint },
    logicalNamespace: boolean, deadline: number, signal?: AbortSignal,
    factory: OpenCodeWindowsPublicationAuthorityFactory = input => new OpenCodeWindowsPublicationAuthorityClient(input)):
  Promise<RetainedWindowsNamespaceBackend> {
    const authority = factory({ deadline, signal })
    try {
      const identity = await authority.openRoot(root, false, false)
      if (BigInt(identity.volumeSerial) !== BigInt(expected.dev) || BigInt(identity.fileId) !== BigInt(expected.ino)) {
        throw new OpenCodeLaunchJournalError(logicalNamespace ? 'fenced' : 'foreign',
          'retained Windows journal root identity changed')
      }
      return new RetainedWindowsNamespaceBackend(root, authority, expected, logicalNamespace)
    } catch (error) { await authority.close().catch(() => undefined); throw error }
  }
  private name(value: string): string {
    if (value === '.') return value
    const normalized = value.replaceAll('\\', '/')
    if (!normalized || normalized.startsWith('/') || normalized.split('/').some(part => !part || part === '.' || part === '..')) {
      throw new OpenCodeLaunchJournalError('foreign', 'invalid retained Windows journal name')
    }
    return normalized
  }
  private value(input: Readonly<{ volumeSerial: string; fileId: string; size: string; kind: 'file' | 'directory' }>): NamespaceStat {
    const file = input.kind === 'file'; const directory = input.kind === 'directory'
    return { dev: BigInt(input.volumeSerial), ino: BigInt(input.fileId), size: Number(input.size),
      mode: directory ? 0o700 : 0o600, isFile: () => file, isDirectory: () => directory,
      isSymbolicLink: () => false }
  }
  displayPath(name: string) { return join(this.root, name) }
  async verifyRoot(): Promise<void> {
    try {
      const current = this.value(await this.authority.namespaceStat('.'))
      if (!sameFileIdentity(current, { ...current, dev: this.expected.dev, ino: this.expected.ino })) {
        throw new OpenCodeLaunchJournalError(this.logicalNamespace ? 'fenced' : 'foreign',
          'retained Windows journal root identity changed')
      }
    } catch (error) {
      if (error instanceof OpenCodeLaunchJournalError) throw error
      throw new OpenCodeLaunchJournalError(this.logicalNamespace ? 'fenced' : 'foreign',
        'retained Windows journal root is unavailable')
    }
  }
  async lstat(name: string) { try { return this.value(await this.authority.namespaceStat(this.name(name))) } catch (error) { throw namespaceAuthorityError(error) } }
  async stat(name: string) { return this.lstat(name) }
  async mkdir(name: string, _mode: number) { try { await this.authority.namespaceMkdir(this.name(name)) } catch (error) { throw namespaceAuthorityError(error) } }
  async open(name: string, flags: number): Promise<NamespaceHandle> {
    const mode = (flags & (constants.O_DIRECTORY ?? 0)) !== 0 ? 'directory'
      : (flags & constants.O_CREAT) !== 0 ? 'create_file'
      : (flags & (constants.O_RDWR | constants.O_WRONLY)) !== 0 ? 'readwrite' : 'read'
    try {
      const opened = await this.authority.namespaceOpen(this.name(name), mode)
      return new RetainedWindowsNamespaceHandle(this.authority, opened.token, this.value(opened))
    } catch (error) { throw namespaceAuthorityError(error) }
  }
  async rename(from: string, to: string) { try { await this.authority.namespaceRename(this.name(from), this.name(to)) } catch (error) { throw namespaceAuthorityError(error) } }
  async unlink(name: string) { try { await this.authority.namespaceUnlink(this.name(name), false) } catch (error) { throw namespaceAuthorityError(error) } }
  async rmdir(name: string) { try { await this.authority.namespaceUnlink(this.name(name), true) } catch (error) { throw namespaceAuthorityError(error) } }
  async syncDirectory(name = '.') { try { await this.authority.namespaceSyncDirectory(this.name(name)) } catch (error) { throw namespaceAuthorityError(error) } }
  async close(): Promise<void> { await this.authority.close() }
}

class RetainedWindowsNamespaceHandle implements NamespaceHandle {
  #closed = false
  constructor(private readonly authority: OpenCodeWindowsPublicationAuthorityClient,
    private readonly token: string, private metadata: NamespaceStat) {}
  async stat(): Promise<NamespaceStat> { if (this.#closed) throw new Error('retained Windows handle is closed'); return this.metadata }
  async writeFile(data: string | Uint8Array): Promise<void> {
    if (this.#closed) throw new Error('retained Windows handle is closed')
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
    await this.authority.namespaceWrite(this.token, bytes)
    this.metadata = { ...this.metadata, size: bytes.byteLength }
  }
  async readFile(): Promise<Uint8Array> {
    if (this.#closed) throw new Error('retained Windows handle is closed')
    return this.authority.namespaceRead(this.token, this.metadata.size)
  }
  async sync(): Promise<void> { if (this.#closed) throw new Error('retained Windows handle is closed'); await this.authority.namespaceSyncHandle(this.token) }
  async close(): Promise<void> { if (this.#closed) return; this.#closed = true; await this.authority.namespaceCloseHandle(this.token) }
}

type NativeSymbols = ReturnType<typeof dlopen>
let nativeSymbols: NativeSymbols | undefined

function unixSymbols(): NativeSymbols {
  if (nativeSymbols) return nativeSymbols
  const args = { openat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    mkdirat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    renameat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
    unlinkat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    fstat: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
    fstatat: { args: [FFIType.i32, FFIType.ptr, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    read: { args: [FFIType.i32, FFIType.ptr, FFIType.u64], returns: FFIType.i64 },
    write: { args: [FFIType.i32, FFIType.ptr, FFIType.u64], returns: FFIType.i64 },
    fsync: { args: [FFIType.i32], returns: FFIType.i32 },
    close: { args: [FFIType.i32], returns: FFIType.i32 },
    [process.platform === 'darwin' ? '__error' : '__errno_location']: { args: [], returns: FFIType.ptr } } as any
  const libraries = process.platform === 'darwin' ? ['/usr/lib/libSystem.B.dylib'] : ['libc.so.6', 'libc.so']
  let failure: unknown
  for (const library of libraries) {
    try { nativeSymbols = dlopen(library, args); return nativeSymbols }
    catch (error) { failure = error }
  }
  throw failure
}

const ERRNO_NAMES: Record<number, string> = process.platform === 'darwin'
  ? { 1: 'EPERM', 2: 'ENOENT', 9: 'EBADF', 13: 'EACCES', 17: 'EEXIST', 20: 'ENOTDIR', 21: 'EISDIR',
    22: 'EINVAL', 45: 'ENOTSUP', 62: 'ELOOP', 66: 'ENOTEMPTY' }
  : { 1: 'EPERM', 2: 'ENOENT', 9: 'EBADF', 13: 'EACCES', 17: 'EEXIST', 20: 'ENOTDIR', 21: 'EISDIR',
    22: 'EINVAL', 39: 'ENOTEMPTY', 40: 'ELOOP', 95: 'ENOTSUP' }
function nativeError(operation: string): NodeJS.ErrnoException {
  const symbols = unixSymbols().symbols as any
  const errnoPointer = process.platform === 'darwin' ? symbols.__error() : symbols.__errno_location()
  const errno = read.i32(errnoPointer, 0)
  const error = new Error(`${operation} failed: ${ERRNO_NAMES[errno] ?? `errno ${errno}`}`) as NodeJS.ErrnoException
  error.code = ERRNO_NAMES[errno]; error.errno = errno
  return error
}
function cPath(name: string): Buffer {
  if (!name || name.startsWith('/') || name.split(/[\\/]/).includes('..') || name.includes('\0')) {
    throw new OpenCodeLaunchJournalError('foreign', 'invalid descriptor-relative journal name')
  }
  return Buffer.from(`${name}\0`)
}

class RetainedDirectoryBackend implements NamespaceBackend {
  readonly kind = 'retained-directory' as const
  private constructor(
    private readonly root: string,
    private readonly rootHandle: Awaited<ReturnType<typeof open>>,
    private readonly expected: { dev: number | bigint; ino: number | bigint },
    private readonly logicalNamespace: boolean,
  ) {}
  static async create(
    root: string,
    expected: { dev: number | bigint; ino: number | bigint },
    logicalNamespace: boolean,
  ): Promise<RetainedDirectoryBackend> {
    const handle = await open(root, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0))
    const actual = await handle.stat()
    if (!actual.isDirectory() || !sameFileIdentity(actual, expected)) {
      await handle.close()
      throw new OpenCodeLaunchJournalError('foreign', 'journal root changed while retaining descriptor')
    }
    unixSymbols()
    return new RetainedDirectoryBackend(root, handle, expected, logicalNamespace)
  }
  displayPath(name: string) { return join(this.root, name) }
  async verifyRoot() {
    const retained = await this.rootHandle.stat()
    if (!retained.isDirectory()) throw new OpenCodeLaunchJournalError('foreign', 'retained journal root is not a directory')
    if (!this.logicalNamespace) return
    let visible: Awaited<ReturnType<typeof lstat>>
    try { visible = await lstat(this.root) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new OpenCodeLaunchJournalError('fenced', 'logical journal root is detached')
      }
      throw error
    }
    if (visible.isSymbolicLink() || !visible.isDirectory()) {
      throw new OpenCodeLaunchJournalError('foreign', 'logical journal root is no longer canonical')
    }
    if (!sameFileIdentity(visible, this.expected)) {
      throw new OpenCodeLaunchJournalError('fenced', 'logical journal root identity changed')
    }
  }
  private result(value: number | bigint, operation: string): number { const numeric = Number(value); if (numeric < 0) throw nativeError(operation); return numeric }
  private async fdStat(fd: number): Promise<NamespaceStat> {
    const buffer = Buffer.alloc(256); this.result((unixSymbols().symbols as any).fstat(fd, ptr(buffer)), 'fstat'); return decodeNativeStat(buffer)
  }
  async lstat(name: string) { return this.statAt(name, process.platform === 'darwin' ? 0x20 : 0x100) }
  async stat(name: string) { return this.statAt(name, 0) }
  private async statAt(name: string, flags: number): Promise<NamespaceStat> {
    const buffer = Buffer.alloc(256); this.result((unixSymbols().symbols as any).fstatat(this.rootHandle.fd, ptr(cPath(name)), ptr(buffer), flags), 'fstatat'); return decodeNativeStat(buffer)
  }
  async mkdir(name: string, mode: number) { this.result((unixSymbols().symbols as any).mkdirat(this.rootHandle.fd, ptr(cPath(name)), mode), 'mkdirat') }
  async open(name: string, flags: number, mode = 0): Promise<NamespaceHandle> {
    const fd = this.result((unixSymbols().symbols as any).openat(this.rootHandle.fd, ptr(cPath(name)), flags, mode), 'openat')
    return new NativeNamespaceHandle(fd, this)
  }
  async rename(from: string, to: string) { this.result((unixSymbols().symbols as any).renameat(this.rootHandle.fd, ptr(cPath(from)), this.rootHandle.fd, ptr(cPath(to))), 'renameat') }
  async unlink(name: string) { this.result((unixSymbols().symbols as any).unlinkat(this.rootHandle.fd, ptr(cPath(name)), 0), 'unlinkat') }
  async rmdir(name: string) { this.result((unixSymbols().symbols as any).unlinkat(this.rootHandle.fd, ptr(cPath(name)), process.platform === 'darwin' ? 0x80 : 0x200), 'unlinkat') }
  async syncDirectory(name = '.') {
    const handle = name === '.' ? undefined : await this.open(name, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0))
    const fd = handle ? (handle as NativeNamespaceHandle).fd : this.rootHandle.fd
    try { this.result((unixSymbols().symbols as any).fsync(fd), 'fsync') }
    catch (error) {
      if (classifyOpenCodeDirectoryDurabilityError(process.platform,
        (error as NodeJS.ErrnoException).code) !== 'explicitly_unsupported') throw error
    }
    finally { await handle?.close() }
  }
  statFd(fd: number) { return this.fdStat(fd) }
}

class NativeNamespaceHandle implements NamespaceHandle {
  constructor(readonly fd: number, private readonly backend: RetainedDirectoryBackend) {}
  stat() { return this.backend.statFd(this.fd) }
  async writeFile(data: string | Uint8Array) {
    const bytes = typeof data === 'string' ? Buffer.from(data) : Buffer.from(data)
    let offset = 0
    while (offset < bytes.length) {
      const count = Number((unixSymbols().symbols as any).write(this.fd, ptr(bytes.subarray(offset)), bytes.length - offset))
      if (count < 0) throw nativeError('write'); offset += count
    }
  }
  async readFile() {
    const chunks: Buffer[] = []
    while (true) {
      const chunk = Buffer.alloc(64 * 1024); const count = Number((unixSymbols().symbols as any).read(this.fd, ptr(chunk), chunk.length))
      if (count < 0) throw nativeError('read'); if (count === 0) break; chunks.push(chunk.subarray(0, count))
    }
    return new Uint8Array(Buffer.concat(chunks))
  }
  async sync() { if ((unixSymbols().symbols as any).fsync(this.fd) < 0) throw nativeError('fsync') }
  async close() { if ((unixSymbols().symbols as any).close(this.fd) < 0) throw nativeError('close') }
}

function decodeNativeStat(buffer: Buffer): NamespaceStat {
  let dev: bigint; let ino: bigint; let mode: number; let size: number
  if (process.platform === 'darwin') {
    dev = BigInt(buffer.readUInt32LE(0)); mode = buffer.readUInt16LE(4); ino = buffer.readBigUInt64LE(8); size = Number(buffer.readBigInt64LE(96))
  } else if (process.arch === 'arm64') {
    dev = buffer.readBigUInt64LE(0); ino = buffer.readBigUInt64LE(8); mode = buffer.readUInt32LE(16); size = Number(buffer.readBigInt64LE(48))
  } else {
    dev = buffer.readBigUInt64LE(0); ino = buffer.readBigUInt64LE(8); mode = buffer.readUInt32LE(24); size = Number(buffer.readBigInt64LE(48))
  }
  const kind = mode & 0o170000
  return { dev, ino, mode, size, isFile: () => kind === 0o100000, isDirectory: () => kind === 0o040000,
    isSymbolicLink: () => kind === 0o120000 }
}

async function verifyNamespace(namespace: CanonicalNamespace): Promise<void> {
  await namespace.authorityBackend.verifyRoot()
  await namespace.backend.verifyRoot()
}

function sameFileIdentity(
  left: { dev: number | bigint; ino: number | bigint },
  right: { dev: number | bigint; ino: number | bigint },
): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

async function rejectSymlink(backend: NamespaceBackend, name: string): Promise<void> {
  try { if ((await backend.lstat(name)).isSymbolicLink()) throw new OpenCodeLaunchJournalError('foreign', 'journal path is a symlink') }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
}

async function readNoFollow(
  backend: NamespaceBackend,
  name: string,
  maxBytes = 4096,
  hooks: {
    readNoFollowAvailable?: boolean
    afterReadHandleOpened?: (path: string) => Promise<void>
  } = {},
): Promise<Uint8Array> {
  await rejectSymlink(backend, name)
  const noFollow = hooks.readNoFollowAvailable === false ? 0 : (constants.O_NOFOLLOW ?? 0)
  const handle = await backend.open(name, constants.O_RDONLY | noFollow)
  try {
    const retained = await handle.stat()
    await hooks.afterReadHandleOpened?.(backend.displayPath(name))
    const visible = await backend.lstat(name)
    if (!retained.isFile() || visible.isSymbolicLink() || !sameFileIdentity(retained, visible)) {
      throw new OpenCodeLaunchJournalError('foreign', 'durable record identity changed while opening')
    }
    if (retained.size > maxBytes) {
      throw new OpenCodeLaunchJournalError('corrupt', 'durable record exceeds size limit')
    }
    return await handle.readFile()
  } finally { await handle.close() }
}

async function openNoFollowExclusive(backend: NamespaceBackend, name: string): Promise<NamespaceHandle> {
  await rejectSymlink(backend, name)
  const handle = await backend.open(name,
    constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
  const [retained, visible] = await Promise.all([handle.stat(), backend.lstat(name)])
  if (!retained.isFile() || visible.isSymbolicLink() || !sameFileIdentity(retained, visible)) {
    await handle.close().catch(() => undefined)
    throw new OpenCodeLaunchJournalError('foreign', 'exclusive durable record identity changed')
  }
  return handle
}

export type OpenCodeDirectoryDurabilityErrorClassification = 'explicitly_unsupported' | 'durability_failure'

export function classifyOpenCodeDirectoryDurabilityError(
  platform: NodeJS.Platform,
  code: string | undefined,
): OpenCodeDirectoryDurabilityErrorClassification {
  // Native Windows commonly reports EINVAL/ENOTSUP for directory fsync and
  // EISDIR when its open primitive cannot produce a syncable directory handle.
  // Access and permission failures are not capability signals: swallowing
  // EACCES/EPERM would falsely report a durable namespace publication.
  const explicitlyUnsupported = platform === 'win32'
    ? new Set(['EINVAL', 'EISDIR', 'ENOTSUP'])
    : new Set(['EINVAL', 'ENOTSUP'])
  return code && explicitlyUnsupported.has(code)
    ? 'explicitly_unsupported'
    : 'durability_failure'
}

async function syncDirectory(
  directory: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>>
  try { handle = await open(directory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0)) }
  catch (error) {
    if (classifyOpenCodeDirectoryDurabilityError(platform,
      (error as NodeJS.ErrnoException).code) === 'explicitly_unsupported') return
    throw error
  }
  try { await handle.sync() }
  catch (error) {
    if (classifyOpenCodeDirectoryDurabilityError(platform,
      (error as NodeJS.ErrnoException).code) !== 'explicitly_unsupported') throw error
  }
  finally { await handle.close().catch(() => undefined) }
}

async function syncNamespace(
  namespace: CanonicalNamespace,
  backend: NamespaceBackend,
  hook?: (handle: NamespaceHandle) => Promise<void>,
  verifyLogicalNamespace = true,
): Promise<void> {
  if (verifyLogicalNamespace) await verifyNamespace(namespace)
  else await backend.verifyRoot()
  if (hook) {
    const handle = await backend.open('.', constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0))
    try { await hook(handle) } finally { await handle.close().catch(() => undefined) }
  } else await backend.syncDirectory()
  if (verifyLogicalNamespace) await verifyNamespace(namespace)
  else await backend.verifyRoot()
}

async function atomicReplace(
  namespace: CanonicalNamespace,
  backend: NamespaceBackend,
  target: string,
  bytes: Uint8Array,
  context?: OpenCodeLaunchStoreContext,
): Promise<void> {
  ensureContext(context)
  await verifyNamespace(namespace)
  await rejectSymlink(backend, target)
  const temporary = `.${basename(target)}.${randomUUID()}.tmp`
  let handle: NamespaceHandle | undefined
  try {
    handle = await backend.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    await handle.writeFile(bytes)
    await handle.sync()
    const temporaryIdentity = await handle.stat()
    await verifyNamespace(namespace)
    await rejectSymlink(backend, target)
    const visibleTemporary = await backend.stat(temporary)
    if (!sameFileIdentity(visibleTemporary, temporaryIdentity)) {
      throw new OpenCodeLaunchJournalError('foreign', 'temporary durable record identity changed')
    }
    // This is the last check before the irreversible namespace publication. There is no
    // post-publication deadline check that could turn committed authority into a thrown timeout.
    ensureContext(context)
    await backend.rename(temporary, target)
    const visibleTarget = await backend.stat(target)
    if (!sameFileIdentity(visibleTarget, temporaryIdentity)) {
      throw new OpenCodeLaunchJournalError('foreign', 'published durable record identity changed')
    }
    await syncNamespace(namespace, backend)
    await handle.close(); handle = undefined
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined)
    await backend.unlink(temporary).catch(() => undefined)
    throw error
  }
}

function validCommitMarker(value: unknown): value is { version: 1; slot: 0 | 1; digest: string } {
  const item = record(value)
  return !!item && strictKeys(item, ['version', 'slot', 'digest']) && item.version === 1
    && (item.slot === 0 || item.slot === 1) && isOpenCodeLaunchPayloadHash(item.digest)
}

function validFenceAnchor(value: unknown): value is { version: 1; fence: number } {
  const item = record(value)
  return !!item && strictKeys(item, ['version', 'fence']) && item.version === 1
    && Number.isSafeInteger(item.fence) && item.fence > 0
}

function validLockOwner(value: unknown): value is {
  version: 1; pid: number; processBirth: string; token: string
} {
  const item = record(value)
  return !!item && strictKeys(item, ['version', 'pid', 'processBirth', 'token']) && item.version === 1
    && Number.isSafeInteger(item.pid) && item.pid > 0
    && typeof item.processBirth === 'string' && /^\d+$/.test(item.processBirth)
    && typeof item.token === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(item.token)
}

function sameLockOwner(left: LockOwner, right: LockOwner): boolean {
  return left.version === right.version && left.pid === right.pid
    && left.processBirth === right.processBirth && left.token === right.token
}

function sha256(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex') }

async function processBirth(pid: number): Promise<string> {
  // Portable Node APIs expose liveness, but not creation time for an arbitrary PID. Every
  // acquisition by this process publishes the same boot-relative token. A live foreign PID
  // without an injected platform identity is deliberately never reaped; an ESRCH owner is
  // still recovered before this function is consulted.
  if (pid !== process.pid) throw new Error('foreign process birth identity unavailable')
  return PORTABLE_PROCESS_BIRTH
}

const PORTABLE_PROCESS_BIRTH = String(Math.max(1, Math.floor(Date.now() - process.uptime() * 1_000)))

async function releaseOwnedLockByPath(
  namespace: CanonicalNamespace,
  backend: NamespaceBackend,
  lock: string,
  owner: LockOwner,
  beforeDirectoryRemove?: () => Promise<void>,
  afterDirectoryDetach?: () => Promise<void>,
): Promise<void> {
  const identity = await backend.stat(lock)
  const ownerHandle = await backend.open(join(lock, 'owner.json'), constants.O_RDWR | (constants.O_NOFOLLOW ?? 0))
  await releaseOwnedLock(namespace, backend, lock, owner, ownerHandle, identity, beforeDirectoryRemove, afterDirectoryDetach)
}

type LockOwner = { version: 1; pid: number; processBirth: string; token: string }

async function releaseOwnedLock(
  namespace: CanonicalNamespace,
  backend: NamespaceBackend,
  lock: string,
  expectedOwner: LockOwner,
  ownerHandle: NamespaceHandle,
  identity: NamespaceStat,
  beforeDirectoryRemove?: () => Promise<void>,
  afterDirectoryDetach?: () => Promise<void>,
): Promise<void> {
  try {
    await backend.verifyRoot()
    const current = await backend.stat(lock)
    if (!sameFileIdentity(current, identity)) {
      throw new OpenCodeLaunchJournalError('fenced', 'lease directory identity changed')
    }
    const owner = join(lock, 'owner.json')
    const [retainedOwner, visibleOwner] = await Promise.all([ownerHandle.stat(), backend.lstat(owner)])
    if (!retainedOwner.isFile() || visibleOwner.isSymbolicLink()
      || !sameFileIdentity(retainedOwner, visibleOwner)) {
      throw new OpenCodeLaunchJournalError('fenced', 'lease owner identity changed')
    }
    await beforeDirectoryRemove?.()
    // Re-read the complete durable owner tuple at the actual removal transition. Checking only a
    // token (or checking before an awaitable cleanup hook) can remove a replacement process's lock.
    const parsed = JSON.parse(new TextDecoder().decode(await readNoFollow(backend, owner, 4096))) as unknown
    if (!validLockOwner(parsed) || !sameLockOwner(parsed, expectedOwner)) {
      throw new OpenCodeLaunchJournalError('fenced', 'lock ownership tuple changed')
    }
    const beforeRemove = await backend.stat(lock)
    const ownerBeforeRemove = await backend.lstat(owner)
    if (!sameFileIdentity(beforeRemove, identity) || ownerBeforeRemove.isSymbolicLink()
      || !sameFileIdentity(ownerBeforeRemove, retainedOwner)) {
      throw new OpenCodeLaunchJournalError('fenced', 'lease directory changed during release')
    }
    // Detach the still-nonempty owned directory in one namespace transition.
    // A contender can publish immediately afterward, but cleanup below targets
    // only this acquisition's unique tombstone and retained descriptor.
    const detached = `${lock}.${expectedOwner.token}.releasing`
    await backend.rename(lock, detached)
    const visibleDetached = await backend.stat(detached)
    if (!sameFileIdentity(visibleDetached, identity)) {
      throw new OpenCodeLaunchJournalError('fenced', 'detached lease directory identity changed')
    }
    await syncNamespace(namespace, backend, undefined, false)
    await afterDirectoryDetach?.()
    const detachedOwner = join(detached, 'owner.json')
    const visibleDetachedOwner = await backend.lstat(detachedOwner)
    if (visibleDetachedOwner.isSymbolicLink() || !sameFileIdentity(visibleDetachedOwner, retainedOwner)) {
      throw new OpenCodeLaunchJournalError('fenced', 'detached lease owner identity changed')
    }
    // The detached name and complete retained identity have been verified. Release
    // the owner file before deleting it so Windows need not weaken write/delete
    // sharing to remove the exact tombstoned lease.
    await ownerHandle.close()
    await backend.unlink(detachedOwner)
    await backend.rmdir(detached)
    await syncNamespace(namespace, backend, undefined, false)
  } finally {
    await ownerHandle.close().catch(() => undefined)
  }
}

export type OpenCodeLaunchJournalLease = {
  readonly journal: OpenCodeLaunchJournal
  readonly generation: number
  readonly fence: number
  readonly acquisitionToken: string
  bindProfile(binding: OpenCodeLaunchProfileBinding, context?: OpenCodeLaunchStoreContext): Promise<void>
  claim(memberIdentity: OpenCodeOpaqueIdentity, context?: OpenCodeLaunchStoreContext): Promise<string>
  append(event: OpenCodeLaunchJournalAppendEvent, context?: OpenCodeLaunchStoreContext): Promise<void>
  /** Reconciliation is not a claimant transition and must name the historical claim explicitly. */
  reconcile(event: OpenCodeLaunchJournalReconciliationEvent, context?: OpenCodeLaunchStoreContext): Promise<void>
  /** Re-reads both durable authorities immediately before an irreversible external commit. */
  revalidate(memberIdentity: OpenCodeOpaqueIdentity, claimToken: string, context?: OpenCodeLaunchStoreContext): Promise<void>
  /**
   * Poisons this acquisition until an already-started physical operation settles. The caller is
   * still allowed to return at its deadline; the process lease and the in-process tail are not.
   */
  retainUntilPhysicalSettlement(settlement: Promise<unknown>): void
}

/**
 * Serializes every writer for an attempt. A continuation advances generation and
 * fence together, so a writer captured before an await cannot append afterward.
 */
export class OpenCodeLaunchAttemptStore {
  private tail: Promise<void> = Promise.resolve()

  constructor(private readonly persistence: OpenCodeLaunchJournalPersistence) {}

  async inspect(identity: OpenCodeLaunchJournalIdentity, context?: OpenCodeLaunchStoreContext): Promise<OpenCodeLaunchJournal | null> {
    return this.exclusive(async () => this.load(identity, context), context)
  }

  async withGeneration<T>(
    identity: OpenCodeLaunchJournalIdentity,
    mode: 'begin' | 'continue' | 'replay',
    operation: (lease: OpenCodeLaunchJournalLease) => Promise<T>,
    context?: OpenCodeLaunchStoreContext,
  ): Promise<T> {
    let retainedPhysicalSettlement: Promise<void> | undefined
    let acquisitionContext = context
    if (context) {
      const timing = await this.peekTiming(identity, context)
      if (timing) acquisitionContext = {
        ...context,
        deadlineAtMs: Math.min(context.deadlineAtMs, safeAdd(timing.startedAtMs, timing.totalBudgetMs, 'absoluteDeadlineAtMs')),
      }
    }
    return this.exclusive(async acquisitionToken => {
      const loadIdentity = {
        ...identity,
        startedAtMs: undefined,
        totalBudgetMs: undefined,
        ...(mode === 'continue' ? { inputDigest: undefined } : {}),
      }
      let journal = await this.load(loadIdentity, context)
      let effectiveContext = context
      if (journal && context) {
        const persistedDeadlineAtMs = safeAdd(journal.startedAtMs, journal.totalBudgetMs, 'absoluteDeadlineAtMs')
        effectiveContext = { ...context, deadlineAtMs: Math.min(context.deadlineAtMs, persistedDeadlineAtMs) }
        ensureContext(effectiveContext)
      }
      if (!journal) {
        if (mode !== 'begin') throw new OpenCodeLaunchJournalError('foreign', 'attempt journal does not exist')
        if (identity.generation !== undefined && identity.generation !== 1) {
          throw new OpenCodeLaunchJournalError('fenced', 'initial generation must be one')
        }
        journal = {
          version: 1, attemptId: identity.attemptId, payloadHash: identity.payloadHash,
          inputDigest: identity.inputDigest ?? identity.payloadHash,
          immutableDigest: identity.immutableDigest ?? identity.inputDigest ?? identity.payloadHash,
          startedAtMs: identity.startedAtMs ?? 0,
          totalBudgetMs: identity.totalBudgetMs ?? 300_000,
          generation: 1, fence: 1, events: [],
        }
        assertSafeNonnegative(journal.startedAtMs, 'startedAtMs')
        assertSafePositive(journal.totalBudgetMs, 'totalBudgetMs')
        await this.persist(journal, context)
      } else if (mode === 'begin') {
        // Same identity is an idempotent replay. It does not create a new writer.
        if (identity.generation !== undefined && identity.generation !== journal.generation) {
          throw new OpenCodeLaunchJournalError('fenced', 'attempt generation mismatch')
        }
      } else if (mode === 'continue') {
        if (identity.generation === journal.generation) {
          // Idempotent replay of an already-started continuation.
          if (identity.inputDigest !== undefined && identity.inputDigest !== journal.inputDigest) {
            throw new OpenCodeLaunchJournalError('foreign', 'continuation input digest mismatch')
          }
        } else {
          if (identity.generation !== undefined && identity.generation !== journal.generation + 1) {
            throw new OpenCodeLaunchJournalError('fenced', 'continuation generation is not next')
          }
          if (identity.inputDigest === undefined) {
            throw new OpenCodeLaunchJournalError('foreign', 'continuation input digest is required')
          }
          const candidate = { ...journal, inputDigest: identity.inputDigest,
            generation: journal.generation + 1, fence: journal.fence + 1 }
          assertSafePositive(candidate.generation, 'generation')
          assertSafePositive(candidate.fence, 'fence')
          await this.persist(candidate, effectiveContext)
          journal = candidate
        }
      }
      const generation = journal.generation
      const fence = journal.fence
      let active = true
      let leasePoison: OpenCodeLaunchPoisonedLeaseError | undefined
      const lease: OpenCodeLaunchJournalLease = {
        journal,
        generation,
        fence,
        acquisitionToken,
        bindProfile: async (binding, bindingContext) => {
          validateProfileBinding(binding)
          if (journal!.profileBinding) {
            if (!sameProfileBinding(journal!.profileBinding, binding)) {
              throw new OpenCodeLaunchJournalError('foreign', 'launch profile identity changed')
            }
            return
          }
          const candidate = { ...journal!, profileBinding: structuredClone(binding) }
          validateJournal(candidate, identity)
          await this.persist(candidate, bindingContext ?? effectiveContext)
          journal = candidate
          Object.assign(lease.journal, candidate)
        },
        claim: async (memberIdentity, claimContext) => {
          const claimToken = `${acquisitionToken}.${randomUUID()}`
          await lease.append({ type: 'member_intent', memberIdentity, claimToken }, claimContext)
          return claimToken
        },
        append: async (event, appendContext) => {
          if (event.type === 'member_reconciled_applied' || event.type === 'member_reconciled_absent') {
            throw new OpenCodeLaunchJournalError('fenced', 'reconciliation requires the reconciliation path')
          }
          const normalEvent = event.type === 'member_intent' && !event.claimToken
            ? { ...event, claimToken: `${acquisitionToken}.${randomUUID()}` } : event
          if (!normalEvent.claimToken || !normalEvent.claimToken.startsWith(`${acquisitionToken}.`)) {
            throw new OpenCodeLaunchJournalError('fenced', 'normal transition requires this acquisition claimant token')
          }
          await appendEvent(normalEvent, appendContext)
        },
        reconcile: async (event, reconcileContext) => {
          if (!event.claimToken) {
            throw new OpenCodeLaunchJournalError('fenced', 'reconciliation requires an explicit historical claimant token')
          }
          await appendEvent(event, reconcileContext)
        },
        revalidate: async () => { throw new OpenCodeLaunchJournalError('fenced', 'lease initialization incomplete') },
        retainUntilPhysicalSettlement: settlement => {
          const normalized = settlement.then(() => undefined, () => undefined)
          retainedPhysicalSettlement = retainedPhysicalSettlement
            ? Promise.all([retainedPhysicalSettlement, normalized]).then(() => undefined)
            : normalized
        },
      }
      const appendEvent = async (event: OpenCodeLaunchJournalAppendEvent, appendContext?: OpenCodeLaunchStoreContext) => {
          if (!active || journal!.generation !== generation || journal!.fence !== fence) {
            throw new OpenCodeLaunchJournalError('fenced', 'stale generation writer')
          }
          const priorClaim = [...journal!.events].reverse().find(candidate =>
            candidate.memberIdentity === event.memberIdentity && candidate.type !== 'cleanup')?.claimToken
          const claimToken = event.claimToken
          if (event.type !== 'member_intent' && !priorClaim) {
            throw new OpenCodeLaunchJournalError('fenced', 'member transition has no durable claim')
          }
          if (event.type !== 'member_intent' && priorClaim && claimToken !== priorClaim) {
            throw new OpenCodeLaunchJournalError('fenced', 'member claim token changed')
          }
          const next = {
            ...event,
            claimToken,
            inputDigest: journal!.inputDigest,
            sequence: journal!.events.length + 1,
            generation,
            fence,
          } as OpenCodeLaunchJournalEvent
          validateEvent(next)
          const candidate = { ...journal!, events: [...journal!.events, next] }
          validateJournal(candidate, identity)
          try { await this.persist(candidate, appendContext ?? effectiveContext) }
          catch (error) {
            active = false
            if (error instanceof OpenCodeLaunchPoisonedLeaseError) leasePoison = error
            throw error
          }
          journal = candidate
          Object.assign(lease.journal, candidate)
      }
      // Defined after appendEvent so every transition shares the exact same durable validation.
      lease.revalidate = async (memberIdentity, claimToken, revalidateContext) => {
          if (!active) throw new OpenCodeLaunchJournalError('fenced', 'stale generation writer')
          const current = await this.load({ ...identity, inputDigest: journal!.inputDigest }, revalidateContext ?? effectiveContext)
          if (!current || current.generation !== generation || current.fence !== fence) {
            active = false
            throw new OpenCodeLaunchJournalError('fenced', 'durable generation changed')
          }
          const last = current.events.filter(event => event.memberIdentity === memberIdentity
            && event.type !== 'cleanup').at(-1)
          if (!last || last.type !== 'member_intent' || last.generation !== generation || last.fence !== fence
            || last.claimToken !== claimToken) {
            throw new OpenCodeLaunchJournalError('fenced', 'member mutation is tombstoned or no longer pending')
          }
        }
      try {
        const result = await operation(lease)
        if (leasePoison) throw leasePoison
        return result
      } catch (error) {
        if (leasePoison) throw leasePoison
        throw error
      } finally { active = false }
    }, acquisitionContext, () => retainedPhysicalSettlement)
  }

  private async peekTiming(
    identity: OpenCodeLaunchJournalIdentity,
    context: OpenCodeLaunchStoreContext,
  ): Promise<{ startedAtMs: number; totalBudgetMs: number } | null> {
    const bytes = await awaitWithContext(this.persistence.read(context), context)
    if (!bytes) return null
    if (bytes.byteLength > OPEN_CODE_LAUNCH_JOURNAL_MAX_BYTES) {
      throw new OpenCodeLaunchJournalError('corrupt', 'journal exceeds size limit')
    }
    let value: unknown
    try { value = JSON.parse(new TextDecoder().decode(bytes)) }
    catch { throw new OpenCodeLaunchJournalError('corrupt', 'journal is not valid JSON') }
    const source = record(value)
    if (!source || source.attemptId !== identity.attemptId || source.payloadHash !== identity.payloadHash) {
      throw new OpenCodeLaunchJournalError('foreign', 'journal identity mismatch')
    }
    assertSafeNonnegative(source.startedAtMs, 'startedAtMs')
    assertSafePositive(source.totalBudgetMs, 'totalBudgetMs')
    return { startedAtMs: source.startedAtMs, totalBudgetMs: source.totalBudgetMs }
  }

  private async load(identity: OpenCodeLaunchJournalIdentity, context?: OpenCodeLaunchStoreContext): Promise<OpenCodeLaunchJournal | null> {
    validateIdentity(identity)
    ensureContext(context)
    const bytes = await awaitWithContext(this.persistence.read(context), context)
    ensureContext(context)
    const anchor = await this.readFence(context)
    if (!bytes) {
      if (anchor !== 0) throw new OpenCodeLaunchJournalError('fenced', 'fence anchor has no committed journal')
      return null
    }
    if (bytes.byteLength > OPEN_CODE_LAUNCH_JOURNAL_MAX_BYTES) {
      throw new OpenCodeLaunchJournalError('corrupt', 'journal exceeds size limit')
    }
    let value: unknown
    try { value = JSON.parse(new TextDecoder().decode(bytes)) }
    catch { throw new OpenCodeLaunchJournalError('corrupt', 'journal is not valid JSON') }
    const journal = validateJournal(value, identity)
    if (journal.fence !== anchor || journal.generation !== anchor) {
      throw new OpenCodeLaunchJournalError('fenced', 'journal does not match durable fence anchor')
    }
    return journal
  }

  private async persist(journal: OpenCodeLaunchJournal, context?: OpenCodeLaunchStoreContext): Promise<void> {
    if (journal.fence >= Number.MAX_SAFE_INTEGER) {
      throw new OpenCodeLaunchJournalError('fenced', 'fence space exhausted')
    }
    const bytes = new TextEncoder().encode(JSON.stringify(journal))
    if (bytes.byteLength > OPEN_CODE_LAUNCH_JOURNAL_MAX_BYTES) {
      throw new OpenCodeLaunchJournalError('corrupt', 'journal exceeds size limit')
    }
    ensureContext(context)
    const anchor = await this.readFence(context)
    if (journal.fence < anchor || journal.generation !== journal.fence || journal.fence > anchor + 1) {
      throw new OpenCodeLaunchJournalError('fenced', 'journal fence cannot roll back or skip anchor')
    }
    if (journal.fence === anchor + 1) {
      try { await this.advanceFence(anchor, journal.fence, context) }
      catch (error) {
        try { await this.quarantineAmbiguousFence(journal.fence, context) }
        catch (quarantineError) { throw new OpenCodeLaunchPoisonedLeaseError(error, quarantineError) }
        throw error
      }
    }
    const replacement = this.persistence.replaceAndSync(bytes, context)
    let replacementSettled = false
    const physicalSettlement = replacement.then(
      () => { replacementSettled = true },
      () => { replacementSettled = true },
    )
    try {
      // Do not detach an ambiguous physical replacement: the exclusive lease remains poisoned/held
      // until the persistence promise settles.
      await awaitWithContext(replacement, context, false)
    } catch (error) {
      // A backend may report an fsync error after publishing its marker. Authority is the separately
      // readable committed generation, not the throw or the in-memory candidate.
      let quarantineFailure: unknown
      try { await this.quarantineAmbiguousFence(journal.fence, context) }
      catch (quarantineError) { quarantineFailure = quarantineError }
      if (!replacementSettled || quarantineFailure !== undefined) {
        throw new OpenCodeLaunchPoisonedLeaseError(error, quarantineFailure, physicalSettlement)
      }
      throw error
    }
  }

  private async quarantineAmbiguousFence(fence: number, context?: OpenCodeLaunchStoreContext): Promise<void> {
    const quarantineContext = context && context.signal.aborted
      ? { ...context, signal: new AbortController().signal }
      : context
    let anchor = await awaitWithContext(this.persistence.readFence(quarantineContext), quarantineContext)
    if (anchor === fence - 1) {
      await awaitWithContext(this.persistence.compareAndSwapFence(fence - 1, fence, quarantineContext), quarantineContext, false)
      anchor = await awaitWithContext(this.persistence.readFence(quarantineContext), quarantineContext)
    }
    if (anchor === fence) {
      await awaitWithContext(this.persistence.compareAndSwapFence(fence, fence + 1, quarantineContext), quarantineContext, false)
      anchor = await awaitWithContext(this.persistence.readFence(quarantineContext), quarantineContext)
    }
    if (anchor !== fence + 1) {
      throw new OpenCodeLaunchJournalError('fenced', 'ambiguous generation could not be quarantined')
    }
  }

  private async exclusive<T>(
    operation: (acquisitionToken: string) => Promise<T>,
    context?: OpenCodeLaunchStoreContext,
    retainedSettlement?: () => Promise<void> | undefined,
  ): Promise<T> {
    const previous = this.tail
    let release!: () => void
    this.tail = new Promise<void>(resolve => { release = resolve })
    let releasePersistence: ((context?: OpenCodeLaunchStoreContext) => Promise<void>) | undefined
    let poisonSettlement: Promise<void> | undefined
    try {
      await waitWithContext(previous, context)
      ensureContext(context)
      const acquisition = this.persistence.acquireExclusive(context ?? infiniteContext())
      releasePersistence = await acquireWithLateReap(acquisition, context)
      ensureContext(context)
      return await operation(randomUUID())
    } catch (error) {
      if (error instanceof OpenCodeLaunchPoisonedLeaseError) poisonSettlement = error.physicalSettlement
      throw error
    } finally {
      const settlement = poisonSettlement ?? retainedSettlement?.()
      const releaseAll = async () => {
        const releaseContext = context
          ? { ...context, signal: new AbortController().signal }
          : undefined
        await releasePersistence?.(releaseContext).catch(error => {
          if (!(error instanceof OpenCodeLaunchJournalError && error.code === 'fenced')) throw error
        })
        release()
      }
      if (settlement) void settlement.then(releaseAll, releaseAll).catch(() => undefined)
      else await releaseAll()
    }
  }

  private async readFence(context?: OpenCodeLaunchStoreContext): Promise<number> {
    return await awaitWithContext(this.persistence.readFence(context), context) ?? 0
  }

  private async advanceFence(expected: number, next: number, context?: OpenCodeLaunchStoreContext): Promise<void> {
    await awaitWithContext(this.persistence.compareAndSwapFence(expected, next, context), context, false)
  }
}

async function acquireWithLateReap(
  acquisition: Promise<((context?: OpenCodeLaunchStoreContext) => Promise<void>) | undefined>,
  context?: OpenCodeLaunchStoreContext,
): Promise<(() => Promise<void>) | undefined> {
  try { return await awaitWithContext(acquisition, context) }
  catch (error) {
    // If cancellation/deadline won while an implementation was physically acquiring, reap the
    // eventual lock rather than leaking it.
    void acquisition.then(release => release?.().catch(() => undefined), () => undefined)
    throw error
  }
}

function validateIdentity(identity: OpenCodeLaunchJournalIdentity): void {
  if (!isOpenCodeLaunchAttemptId(identity.attemptId) || !isOpenCodeLaunchPayloadHash(identity.payloadHash)
    || (identity.inputDigest !== undefined && !isOpenCodeLaunchPayloadHash(identity.inputDigest))
    || (identity.immutableDigest !== undefined && !isOpenCodeLaunchPayloadHash(identity.immutableDigest))) {
    throw new OpenCodeLaunchJournalError('foreign', 'noncanonical attempt identity')
  }
  if (identity.generation !== undefined) assertSafePositive(identity.generation, 'generation')
}

function validateJournal(value: unknown, expected: OpenCodeLaunchJournalIdentity): OpenCodeLaunchJournal {
  const source = record(value)
  if (!source || source.version !== 1 || !isOpenCodeLaunchAttemptId(source.attemptId)
    || !isOpenCodeLaunchPayloadHash(source.payloadHash)) {
    throw new OpenCodeLaunchJournalError('corrupt', 'invalid journal schema')
  }
  const journalKeys = ['version', 'attemptId', 'payloadHash', 'inputDigest', 'immutableDigest',
    'startedAtMs', 'totalBudgetMs', 'generation', 'fence', 'events'] as const
  if (!(strictKeys(source, journalKeys) || strictKeys(source, [...journalKeys, 'profileBinding']))
    || !isOpenCodeLaunchPayloadHash(source.inputDigest) || !isOpenCodeLaunchPayloadHash(source.immutableDigest)) {
    throw new OpenCodeLaunchJournalError('corrupt', 'journal contains unknown fields')
  }
  assertSafeNonnegative(source.startedAtMs, 'startedAtMs')
  assertSafePositive(source.totalBudgetMs, 'totalBudgetMs')
  if ((expected.startedAtMs !== undefined && source.startedAtMs !== expected.startedAtMs)
    || (expected.totalBudgetMs !== undefined && source.totalBudgetMs !== expected.totalBudgetMs)) {
    throw new OpenCodeLaunchJournalError('foreign', 'journal timing mismatch')
  }
  if (source.attemptId !== expected.attemptId || source.payloadHash !== expected.payloadHash
    || (expected.inputDigest !== undefined && source.inputDigest !== expected.inputDigest)
    || (expected.immutableDigest !== undefined && source.immutableDigest !== expected.immutableDigest)) {
    throw new OpenCodeLaunchJournalError('foreign', 'journal identity mismatch')
  }
  assertSafePositive(source.generation, 'generation')
  assertSafePositive(source.fence, 'fence')
  if (source.generation !== source.fence) throw new OpenCodeLaunchJournalError('corrupt', 'generation must equal fence')
  if (source.profileBinding !== undefined) validateProfileBinding(source.profileBinding)
  if (!Array.isArray(source.events) || source.events.length > OPEN_CODE_LAUNCH_JOURNAL_MAX_EVENTS) {
    throw new OpenCodeLaunchJournalError('corrupt', 'invalid journal event count')
  }
  let previousSequence = 0
  let previousGeneration = 0
  let previousFence = 0
  const states = new Map<string, OpenCodeLaunchJournalEvent['type']>()
  const lastTerminal = new Map<string, OpenCodeLaunchJournalEvent>()
  const cleanedClaims = new Set<string>()
  const generationDigests = new Map<number, string>()
  const committedIdentities = new Set<string>()
  for (const candidate of source.events) {
    validateEvent(candidate)
    if (candidate.sequence !== previousSequence + 1 || candidate.generation > source.generation
      || candidate.fence > source.fence || candidate.generation < previousGeneration
      || candidate.fence < previousFence || candidate.generation !== candidate.fence) {
      throw new OpenCodeLaunchJournalError('corrupt', 'invalid journal ordering')
    }
    const generationDigest = generationDigests.get(candidate.generation)
    if ((generationDigest !== undefined && generationDigest !== candidate.inputDigest)
      || (candidate.generation === source.generation && candidate.inputDigest !== source.inputDigest)) {
      throw new OpenCodeLaunchJournalError('corrupt', 'event input digest changed within generation')
    }
    generationDigests.set(candidate.generation, candidate.inputDigest)
    const previous = states.get(candidate.memberIdentity)
    const priorEvent = [...source.events].slice(0, previousSequence).reverse()
      .find(event => event.memberIdentity === candidate.memberIdentity && event.type !== 'cleanup')
    if (candidate.type === 'member_intent' && previous && previous !== 'member_reconciled_absent') {
      throw new OpenCodeLaunchJournalError('corrupt', 'duplicate member intent')
    }
    if (candidate.type === 'member_applied' && previous !== 'member_intent') {
      throw new OpenCodeLaunchJournalError('corrupt', 'applied event lacks paired intent')
    }
    if (candidate.type === 'member_reconciled_applied' && previous !== 'member_intent' && previous !== 'member_unknown') {
      throw new OpenCodeLaunchJournalError('corrupt', 'reconciled applied event lacks intent or unknown outcome')
    }
    if ((candidate.type === 'member_unknown' || candidate.type === 'member_failed') && previous !== 'member_intent') {
      throw new OpenCodeLaunchJournalError('corrupt', 'terminal member event lacks paired intent')
    }
    if ((candidate.type === 'member_applied' || candidate.type === 'member_unknown' || candidate.type === 'member_failed')
      && priorEvent && (candidate.generation !== priorEvent.generation || candidate.fence !== priorEvent.fence)) {
      throw new OpenCodeLaunchJournalError('corrupt', 'member terminal crosses epoch')
    }
    if (candidate.type !== 'member_intent' && candidate.type !== 'cleanup'
      && priorEvent && candidate.claimToken !== priorEvent.claimToken) {
      throw new OpenCodeLaunchJournalError('corrupt', 'member transition changed durable claim token')
    }
    if (candidate.type === 'member_reconciled_absent'
      && previous !== 'member_intent' && previous !== 'member_failed') {
      throw new OpenCodeLaunchJournalError('corrupt', 'reconciliation event lacks uncertain effect')
    }
    if (candidate.type === 'member_reconciled_absent' && previous === 'member_failed') {
      const failure = priorEvent?.type === 'member_failed' ? priorEvent.failure : undefined
      if (!failure || classifyOpenCodeLaunchFailure(failure).retryDisposition !== 'automatic'
        || priorEvent!.generation >= candidate.generation) {
        throw new OpenCodeLaunchJournalError('corrupt', 'failed member is not eligible for automatic retry')
      }
    }
    if (candidate.type === 'cleanup') {
      const terminal = lastTerminal.get(candidate.memberIdentity)
      const cleanupKey = `${candidate.memberIdentity}:${candidate.claimToken}`
      if (!terminal || (terminal.type !== 'member_unknown' && terminal.type !== 'member_failed')
        || states.get(candidate.memberIdentity) !== terminal.type
        || terminal.generation !== candidate.generation || terminal.fence !== candidate.fence
        || terminal.claimToken !== candidate.claimToken || cleanedClaims.has(cleanupKey)) {
        throw new OpenCodeLaunchJournalError('corrupt', 'cleanup lacks an eligible same-epoch terminal')
      }
      cleanedClaims.add(cleanupKey)
    } else {
      states.set(candidate.memberIdentity, candidate.type)
      if (candidate.type === 'member_unknown' || candidate.type === 'member_failed') {
        lastTerminal.set(candidate.memberIdentity, candidate)
      }
    }
    if (candidate.type === 'member_applied' || candidate.type === 'member_reconciled_applied') {
      for (const value of Object.values(candidate.linkage)) {
        if (committedIdentities.has(value)) {
          throw new OpenCodeLaunchJournalError('corrupt', 'durable linkage identity is reused')
        }
        committedIdentities.add(value)
      }
    }
    previousSequence = candidate.sequence
    previousGeneration = candidate.generation
    previousFence = candidate.fence
  }
  return source as OpenCodeLaunchJournal
}

function validateProfileBinding(value: unknown): asserts value is OpenCodeLaunchProfileBinding {
  const source = record(value)
  const fields = ['profileIdentity', 'pluginPolicyIdentity', 'cacheIdentity',
    'authIdentity', 'configIdentity', 'binaryIdentity'] as const
  if (!source || !strictKeys(source, fields)
    || !fields.every(field => isOpenCodeOpaqueIdentity(source[field]))) {
    throw new OpenCodeLaunchJournalError('corrupt', 'invalid launch profile binding')
  }
}

function sameProfileBinding(left: OpenCodeLaunchProfileBinding, right: OpenCodeLaunchProfileBinding): boolean {
  return left.profileIdentity === right.profileIdentity
    && left.pluginPolicyIdentity === right.pluginPolicyIdentity
    && left.cacheIdentity === right.cacheIdentity
    && left.authIdentity === right.authIdentity
    && left.configIdentity === right.configIdentity
    && left.binaryIdentity === right.binaryIdentity
}

function infiniteContext(): OpenCodeLaunchStoreContext {
  return { deadlineAtMs: Number.MAX_SAFE_INTEGER, signal: new AbortController().signal, monotonicNow: () => 0 }
}

function boundedReleaseContext(): OpenCodeLaunchStoreContext {
  const started = Date.now()
  return { deadlineAtMs: started + 5_000, signal: new AbortController().signal, monotonicNow: Date.now }
}

function ensureContext(context?: OpenCodeLaunchStoreContext): void {
  if (context && (context.signal.aborted || context.monotonicNow() >= context.deadlineAtMs)) {
    throw context.signal.reason ?? new OpenCodeLaunchJournalError('fenced', 'store deadline exceeded')
  }
}

async function waitWithContext(operation: Promise<void>, context?: OpenCodeLaunchStoreContext): Promise<void> {
  await awaitWithContext(operation, context)
}

async function awaitWithContext<T>(
  operation: Promise<T>,
  context?: OpenCodeLaunchStoreContext,
  postcheck = true,
): Promise<T> {
  if (!context) return operation
  ensureContext(context)
  return new Promise<T>((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout>
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      context.signal.removeEventListener('abort', onAbort)
      callback()
    }
    const onAbort = () => finish(() => reject(
      context.signal.reason ?? new OpenCodeLaunchJournalError('fenced', 'store cancelled'),
    ))
    const remaining = Math.max(0, context.deadlineAtMs - context.monotonicNow())
    timer = setTimeout(() => finish(() => reject(
      new OpenCodeLaunchJournalError('fenced', 'store deadline exceeded'),
    )), Math.min(remaining, 2_147_483_647))
    context.signal.addEventListener('abort', onAbort, { once: true })
    operation.then(value => finish(() => {
      if (!postcheck) { resolve(value); return }
      try { ensureContext(context); resolve(value) } catch (error) { reject(error) }
    }), error => finish(() => reject(error)))
  })
}

async function boundedPause(context: OpenCodeLaunchStoreContext): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const delay = Math.max(0, Math.min(10, context.deadlineAtMs - context.monotonicNow()))
    const timer = setTimeout(resolve, delay)
    context.signal.addEventListener('abort', () => { clearTimeout(timer); reject(context.signal.reason) }, { once: true })
  })
  ensureContext(context)
}

function validateEvent(value: unknown): asserts value is OpenCodeLaunchJournalEvent {
  const event = record(value)
  if (!event || !Number.isSafeInteger(event.sequence) || (event.sequence as number) <= 0
    || !Number.isSafeInteger(event.generation) || (event.generation as number) <= 0
    || !Number.isSafeInteger(event.fence) || (event.fence as number) <= 0
    || !isOpenCodeOpaqueIdentity(event.memberIdentity)
    || !isOpenCodeLaunchPayloadHash(event.inputDigest)
    || typeof event.claimToken !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})?$/.test(event.claimToken)) {
    throw new OpenCodeLaunchJournalError('corrupt', 'invalid journal event')
  }
  const common = ['type', 'sequence', 'generation', 'fence', 'memberIdentity', 'claimToken', 'inputDigest']
  if (event.type === 'member_intent' || event.type === 'member_unknown'
    || event.type === 'member_reconciled_absent') {
    if (!strictKeys(event, common)) throw new OpenCodeLaunchJournalError('corrupt', 'event contains unknown fields')
    return
  }
  if (event.type === 'member_failed') {
    if (event.externalEffect !== false || typeof event.failure !== 'string'
      || !Object.hasOwn(OPEN_CODE_LAUNCH_FAILURE_POLICY, event.failure)
      || !strictKeys(event, [...common, 'failure', 'externalEffect'])) {
      throw new OpenCodeLaunchJournalError('corrupt', 'invalid failed event')
    }
    return
  }
  if (event.type === 'cleanup') {
    if (event.outcome !== 'complete' && event.outcome !== 'timed_out') {
      throw new OpenCodeLaunchJournalError('corrupt', 'invalid cleanup event')
    }
    if (!strictKeys(event, [...common, 'outcome'])) throw new OpenCodeLaunchJournalError('corrupt', 'event contains unknown fields')
    return
  }
  if ((event.type === 'member_applied' || event.type === 'member_reconciled_applied') && validLinkage(event.linkage)
    && event.linkage.memberIdentity === event.memberIdentity
    && strictKeys(event, [...common, 'linkage'])) return
  throw new OpenCodeLaunchJournalError('corrupt', 'unknown journal event')
}

function validLinkage(value: unknown): value is OpenCodeLaunchMemberLinkage {
  const item = record(value)
  if (!item) return false
  const identities = [item.memberIdentity, item.sessionIdentity, item.bootstrapMessageIdentity, item.commitIdentity]
  return strictKeys(item, ['memberIdentity', 'sessionIdentity', 'bootstrapMessageIdentity', 'commitIdentity'])
    && identities.every(isOpenCodeOpaqueIdentity) && new Set(identities).size === identities.length
}

function record(value: unknown): Record<string, any> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, any> : null
}

function strictKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys)
  return Object.keys(value).length === expected.size && Object.keys(value).every(key => expected.has(key))
}

function assertSafePositive(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new OpenCodeLaunchJournalError('corrupt', `invalid ${label}`)
  }
}

function assertSafeNonnegative(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new OpenCodeLaunchJournalError('corrupt', `invalid ${label}`)
  }
}

function safeAdd(left: number, right: number, label: string): number {
  const result = left + right
  if (!Number.isSafeInteger(result)) throw new OpenCodeLaunchJournalError('corrupt', `invalid ${label}`)
  return result
}
