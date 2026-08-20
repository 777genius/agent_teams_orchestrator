import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rmdir, stat, unlink } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

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
      syncLeaseDirectory?: (handle: Awaited<ReturnType<typeof open>>) => Promise<void>
      beforeLeaseDirectoryRemove?: () => Promise<void>
    } = {},
  ) {
    if (!filePath) throw new TypeError('journal path is required')
  }

  async read(context?: OpenCodeLaunchStoreContext): Promise<Uint8Array | null> {
    ensureContext(context)
    const namespace = await this.getNamespace()
    await verifyNamespace(namespace)
    try {
      const markerBytes = await readNoFollow(namespace.marker, 1024)
      const marker = JSON.parse(new TextDecoder().decode(markerBytes)) as unknown
      if (!validCommitMarker(marker)) throw new OpenCodeLaunchJournalError('corrupt', 'invalid commit marker')
      const bytes = await readNoFollow(namespace.slots[marker.slot], OPEN_CODE_LAUNCH_JOURNAL_MAX_BYTES)
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
    const namespace = await this.getNamespace()
    await verifyNamespace(namespace)
    await rejectSymlink(namespace.marker)
    let currentSlot: 0 | 1 = 1
    try {
      const marker = JSON.parse(new TextDecoder().decode(await readNoFollow(namespace.marker, 1024))) as unknown
      if (!validCommitMarker(marker)) throw new OpenCodeLaunchJournalError('corrupt', 'invalid commit marker')
      currentSlot = marker.slot
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const slot = (currentSlot === 0 ? 1 : 0) as 0 | 1
    await atomicReplace(namespace, namespace.slots[slot], bytes, context)
    // A deadline/cancellation before this point only leaves an uncommitted candidate.
    ensureContext(context)
    const marker = new TextEncoder().encode(JSON.stringify({ version: 1, slot, digest: sha256(bytes) }))
    // Marker publication is the commit point. Never publish and then throw because the caller's clock advanced.
    await atomicReplace(namespace, namespace.marker, marker, context)
  }

  async readFence(context?: OpenCodeLaunchStoreContext): Promise<number | null> {
    ensureContext(context)
    const namespace = await this.getNamespace()
    await verifyNamespace(namespace)
    try {
      const bytes = await readNoFollow(namespace.fence, 128)
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
    const namespace = await this.getNamespace()
    const actual = await this.readFence(context) ?? 0
    if (actual !== expected) throw new OpenCodeLaunchJournalError('fenced', 'durable fence changed')
    await atomicReplace(namespace, namespace.fence,
      new TextEncoder().encode(JSON.stringify({ version: 1, fence: next })), context)
  }

  async acquireExclusive(context: OpenCodeLaunchStoreContext): Promise<(context?: OpenCodeLaunchStoreContext) => Promise<void>> {
    const namespace = await this.getNamespace()
    await verifyNamespace(namespace)
    await rejectSymlink(namespace.marker)
    const lock = namespace.lock
    await rejectSymlink(lock)
    while (true) {
      ensureContext(context)
      const token = randomUUID()
      const staging = `${lock}.${token}.pending`
      let published = false
      let lockHandle: Awaited<ReturnType<typeof open>> | undefined
      let stagingHandle: Awaited<ReturnType<typeof open>> | undefined
      let stagingIdentity: Awaited<ReturnType<Awaited<ReturnType<typeof open>>['stat']>> | undefined
      let ownerRecord: LockOwner | undefined
      try {
        await mkdir(staging, { mode: 0o700 })
        stagingHandle = await open(staging, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
        stagingIdentity = await stagingHandle.stat()
        const owner = join(`/proc/self/fd/${stagingHandle.fd}`, 'owner.json')
        ownerRecord = { version: 1 as const, pid: process.pid,
          processBirth: await (this.testHooks.processBirth ?? processBirth)(process.pid), token }
        const ownerHandle = await open(owner, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
        try {
          await ownerHandle.writeFile(JSON.stringify(ownerRecord))
          await ownerHandle.sync()
        } finally { await ownerHandle.close() }
        await stagingHandle.sync()
        const visibleStaging = await stat(staging)
        if (!sameFileIdentity(visibleStaging, stagingIdentity)) {
          throw new OpenCodeLaunchJournalError('foreign', 'lease staging directory identity changed')
        }
        await rename(staging, lock)
        published = true
        lockHandle = stagingHandle
        stagingHandle = undefined
        const lockIdentity = stagingIdentity
        const visibleLock = await stat(lock)
        if (!sameFileIdentity(visibleLock, lockIdentity)) {
          throw new OpenCodeLaunchJournalError('foreign', 'published lease directory identity changed')
        }
        await (this.testHooks.syncLeaseDirectory ?? (handle => handle.sync()))(namespace.handle)
        // Cancellation may win immediately after the atomic rename; explicitly reap that late acquisition.
        if (context.signal.aborted || context.monotonicNow() >= context.deadlineAtMs) {
          await releaseOwnedLock(namespace, lock, ownerRecord!, lockHandle, lockIdentity,
            this.testHooks.beforeLeaseDirectoryRemove).catch(() => undefined)
          ensureContext(context)
        }
        let released = false
        return async releaseContext => {
          if (!released) {
            released = true
            const effectiveContext = releaseContext ?? boundedReleaseContext()
            // Start token-checked physical release even when the caller's deadline just expired;
            // the deadline bounds waiting, while the operation is explicitly reaped late.
            const physicalRelease = releaseOwnedLock(namespace, lock, ownerRecord!, lockHandle!, lockIdentity,
              this.testHooks.beforeLeaseDirectoryRemove)
            try { await awaitWithContext(physicalRelease, effectiveContext) }
            catch (error) {
              // A timed-out unlink/rmdir is still reaped when the physical operation settles.
              void physicalRelease.catch(() => undefined)
              throw error
            }
          }
        }
      } catch (error) {
        if (published && lockHandle) {
          await releaseOwnedLock(namespace, lock, ownerRecord!, lockHandle, await lockHandle.stat(),
            this.testHooks.beforeLeaseDirectoryRemove).catch(() => undefined)
        }
        if (stagingHandle && stagingIdentity) {
          await unlink(join(`/proc/self/fd/${stagingHandle.fd}`, 'owner.json')).catch(() => undefined)
          await stagingHandle.close().catch(() => undefined)
          const visible = await stat(staging).catch(() => undefined)
          if (visible && sameFileIdentity(visible, stagingIdentity)) await rmdir(staging).catch(() => undefined)
        }
        if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
        await verifyNamespace(namespace)
        await rejectSymlink(lock)
        const owner = join(lock, 'owner.json')
        try {
          const parsed = JSON.parse(new TextDecoder().decode(await readNoFollow(owner, 4096))) as unknown
          if (validLockOwner(parsed)) {
            try { process.kill(parsed.pid as number, 0) }
            catch (killError) {
              if ((killError as NodeJS.ErrnoException).code === 'ESRCH') {
                await releaseOwnedLockByPath(namespace, lock, parsed,
                  this.testHooks.beforeLeaseDirectoryRemove)
                continue
              }
            }
            try {
              if (await (this.testHooks.processBirth ?? processBirth)(parsed.pid as number) !== parsed.processBirth) {
                await releaseOwnedLockByPath(namespace, lock, parsed,
                  this.testHooks.beforeLeaseDirectoryRemove); continue
              }
            } catch { /* A live process with unreadable birth identity is never reaped. */ }
          }
        } catch { /* The winner may still be publishing its owner record. */ }
        await boundedPause(context)
      }
    }
  }

  private async getNamespace(): Promise<CanonicalNamespace> {
    if (this.namespace) return this.namespace
    const suppliedDirectory = resolve(dirname(this.filePath))
    await createCanonicalPrivateDirectory(suppliedDirectory)
    const directory = await realpath(suppliedDirectory)
    // Accepting a symlinked parent would let a retarget create a second lock namespace.
    if (directory !== suppliedDirectory) {
      throw new OpenCodeLaunchJournalError('foreign', 'journal parent directory is a symlink')
    }
    const handle = await open(directory, 'r')
    const identity = await handle.stat()
    // Use the retained descriptor as the path root for every child operation. Retargeting a
    // pathname cannot redirect a held lease, candidate, marker, or fence operation.
    const descriptorDirectory = `/proc/self/fd/${handle.fd}`
    const marker = join(descriptorDirectory, basename(this.filePath))
    this.namespace = {
      directory: descriptorDirectory, canonicalDirectory: directory,
      handle, device: identity.dev, inode: identity.ino, marker,
      slots: [`${marker}.slot0`, `${marker}.slot1`], fence: `${marker}.fence`, lock: `${marker}.lease`,
    }
    return this.namespace
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
  const segments = parsed.split('/').filter(Boolean)
  let current = '/'
  for (const segment of segments) {
    const next = join(current, segment)
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
      const parent = await open(current, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      try { await parent.sync() } finally { await parent.close() }
    }
    current = next
  }
  await chmod(directory, 0o700)
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { await handle.sync() } finally { await handle.close() }
}

type CanonicalNamespace = {
  directory: string
  canonicalDirectory: string
  handle: Awaited<ReturnType<typeof open>>
  device: number | bigint
  inode: number | bigint
  marker: string
  slots: readonly [string, string]
  fence: string
  lock: string
}

async function verifyNamespace(namespace: CanonicalNamespace): Promise<void> {
  const [retained, current] = await Promise.all([namespace.handle.stat(), stat(namespace.canonicalDirectory)])
  if (retained.dev !== namespace.device || retained.ino !== namespace.inode
    || current.dev !== namespace.device || current.ino !== namespace.inode) {
    throw new OpenCodeLaunchJournalError('foreign', 'journal directory identity changed')
  }
}

function sameFileIdentity(
  left: { dev: number | bigint; ino: number | bigint },
  right: { dev: number | bigint; ino: number | bigint },
): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

async function rejectSymlink(path: string): Promise<void> {
  try { if ((await lstat(path)).isSymbolicLink()) throw new OpenCodeLaunchJournalError('foreign', 'journal path is a symlink') }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
}

async function readNoFollow(path: string, maxBytes = 4096): Promise<Uint8Array> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const metadata = await handle.stat()
    if (!metadata.isFile() || metadata.size > maxBytes) {
      throw new OpenCodeLaunchJournalError('corrupt', 'durable record exceeds size limit')
    }
    return await handle.readFile()
  } finally { await handle.close() }
}

async function atomicReplace(
  namespace: CanonicalNamespace,
  target: string,
  bytes: Uint8Array,
  context?: OpenCodeLaunchStoreContext,
): Promise<void> {
  ensureContext(context)
  await verifyNamespace(namespace)
  await rejectSymlink(target)
  const temporary = join(namespace.directory, `.${basename(target)}.${randomUUID()}.tmp`)
  let handle
  try {
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    await handle.writeFile(bytes)
    await handle.sync()
    const temporaryIdentity = await handle.stat()
    await verifyNamespace(namespace)
    await rejectSymlink(target)
    const visibleTemporary = await stat(temporary)
    if (!sameFileIdentity(visibleTemporary, temporaryIdentity)) {
      throw new OpenCodeLaunchJournalError('foreign', 'temporary durable record identity changed')
    }
    // This is the last check before the irreversible namespace publication. There is no
    // post-publication deadline check that could turn committed authority into a thrown timeout.
    ensureContext(context)
    await rename(temporary, target)
    const visibleTarget = await stat(target)
    if (!sameFileIdentity(visibleTarget, temporaryIdentity)) {
      throw new OpenCodeLaunchJournalError('foreign', 'published durable record identity changed')
    }
    await namespace.handle.sync()
    await handle.close(); handle = undefined
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined)
    await unlink(temporary).catch(() => undefined)
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
  const value = await readFile(`/proc/${pid}/stat`, 'utf8')
  const close = value.lastIndexOf(')')
  const fields = value.slice(close + 2).split(' ')
  const birth = fields[19]
  if (!birth || !/^\d+$/.test(birth)) throw new Error('process birth identity unavailable')
  return birth
}

async function releaseOwnedLockByPath(
  namespace: CanonicalNamespace,
  lock: string,
  owner: LockOwner,
  beforeDirectoryRemove?: () => Promise<void>,
): Promise<void> {
  const handle = await open(lock, 'r')
  const identity = await handle.stat()
  await releaseOwnedLock(namespace, lock, owner, handle, identity, beforeDirectoryRemove)
}

type LockOwner = { version: 1; pid: number; processBirth: string; token: string }

async function releaseOwnedLock(
  namespace: CanonicalNamespace,
  lock: string,
  expectedOwner: LockOwner,
  lockHandle: Awaited<ReturnType<typeof open>>,
  identity: Awaited<ReturnType<Awaited<ReturnType<typeof open>>['stat']>>,
  beforeDirectoryRemove?: () => Promise<void>,
): Promise<void> {
  try {
    await verifyNamespace(namespace)
    const current = await stat(lock)
    const retained = await lockHandle.stat()
    if (current.dev !== identity.dev || current.ino !== identity.ino
      || retained.dev !== identity.dev || retained.ino !== identity.ino) {
      throw new OpenCodeLaunchJournalError('fenced', 'lease directory identity changed')
    }
    const owner = join(`/proc/self/fd/${lockHandle.fd}`, 'owner.json')
    await beforeDirectoryRemove?.()
    // Re-read the complete durable owner tuple at the actual removal transition. Checking only a
    // token (or checking before an awaitable cleanup hook) can remove a replacement process's lock.
    const parsed = JSON.parse(new TextDecoder().decode(await readNoFollow(owner, 4096))) as unknown
    if (!validLockOwner(parsed) || !sameLockOwner(parsed, expectedOwner)) {
      throw new OpenCodeLaunchJournalError('fenced', 'lock ownership tuple changed')
    }
    const beforeRemove = await stat(lock)
    if (beforeRemove.dev !== identity.dev || beforeRemove.ino !== identity.ino) {
      throw new OpenCodeLaunchJournalError('fenced', 'lease directory changed during release')
    }
    await unlink(owner)
    await rmdir(lock)
  } finally {
    await lockHandle.close().catch(() => undefined)
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
