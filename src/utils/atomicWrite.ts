import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import * as fs from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { basename, dirname, join } from 'node:path'
import { isProcessInstanceActiveSync, processInstanceSync, type ProcessInstanceOwner } from './processInstanceOwnership.js'

const ATOMIC_RENAME_MAX_ATTEMPTS = 20
const ATOMIC_RENAME_RETRY_BASE_DELAY_MS = 40
const ATOMIC_RENAME_RETRY_MAX_DELAY_MS = 250
const ATOMIC_RENAME_RETRY_JITTER_MS = 25
const RETRYABLE_RENAME_ERROR_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])
const ATOMIC_TOMBSTONE_DIRECTORY = '.atomic-write-tombstones'
const ATOMIC_TOMBSTONE_MAX_COUNT = 32
const ATOMIC_TOMBSTONE_MAX_AGE_MS = 24 * 60 * 60 * 1_000
const ATOMIC_TOMBSTONE_MAX_BYTES = 10 * 1024 * 1024
// A malformed identity receipt is evidence of an interrupted write, not
// authority to retain unbounded opaque data. Keep a small, independently
// bounded quarantine of the newest receipts; excess evidence is collected
// only after proving that its paired body name is absent.
const ATOMIC_MALFORMED_RECEIPT_MAX_COUNT = 8
const ATOMIC_MALFORMED_RECEIPT_MAX_AGE_MS = ATOMIC_TOMBSTONE_MAX_AGE_MS
const ATOMIC_MALFORMED_RECEIPT_MAX_BYTES = 64 * 1024

type AtomicWriteDeps = {
  platform: NodeJS.Platform
  mkdir: typeof fs.mkdir
  writeFile: typeof fs.writeFile
  open: typeof fs.open
  rename: typeof fs.rename
  link: typeof fs.link
  rm: typeof fs.rm
  renameSync: typeof renameSync
  fstatSync: typeof fstatSync
  closeSync: typeof closeSync
  statSync: typeof statSync
  lstatSync: typeof lstatSync
  readFileSync: typeof readFileSync
  rmSync: typeof rmSync
  rmdirSync: typeof rmdirSync
  sleep: (ms: number) => Promise<void>
  sleepSync: (ms: number) => void
  now: () => number
  randomId: () => string
  getRetryDelayMs: (attemptIndex: number) => number
  syncDirectory: (path: string) => void
  /** Windows DACL receipt for the private source-name namespace. `establish`
   * is true only for the directory created by this publication attempt. */
  secureWindowsNamespace: (path: string, establish: boolean) => boolean
}

/** Authority carried by publication callers. Every externally-visible effect
 * checks it immediately before and after the effect; in particular rename is
 * never entered once the owning command has expired. */
export type AtomicWriteContext = {
  signal?: AbortSignal
  remainingMs?: () => number
  throwIfExpired?: () => void
}

export type AtomicWriteCommitIdentity = {
  /** Destination as supplied by the caller; this is the mutation-fence key. */
  destination: string
  /** Unique id assigned before the temporary file is created. */
  transactionId: string
  /** Descriptor identity is intentionally lossless; inode values can exceed
   * Number.MAX_SAFE_INTEGER on supported filesystems. */
  device: bigint
  inode: bigint
  size: number
  modifiedAtMs: number
}

/** A successful rename is irrevocable.  Callers must reconcile this receipt
 * instead of treating an authority loss observed after the commit point as a
 * cancelled write. */
export type AtomicWriteReceipt = {
  committed: true
  authorityExpiredAfterCommit: boolean
  identity: AtomicWriteCommitIdentity
  cleanupDebt?: { paths: string[] }
}

type AtomicWriteOptions = {
  encoding?: BufferEncoding
  mode?: number
  deps?: Partial<AtomicWriteDeps>
  context?: AtomicWriteContext
}

type AtomicJsonWriteOptions = AtomicWriteOptions & {
  indent?: number | string
}

function getErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('code' in error)) {
    return null
  }
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : null
}

function isRetryableRenameError(error: unknown): boolean {
  const code = getErrorCode(error)
  return code ? RETRYABLE_RENAME_ERROR_CODES.has(code) : false
}

function defaultRetryDelayMs(attemptIndex: number): number {
  const attempt = attemptIndex + 1
  const backoff = Math.min(
    ATOMIC_RENAME_RETRY_MAX_DELAY_MS,
    ATOMIC_RENAME_RETRY_BASE_DELAY_MS * attempt,
  )
  return backoff + Math.floor(Math.random() * (ATOMIC_RENAME_RETRY_JITTER_MS + 1))
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function resolveDeps(overrides?: Partial<AtomicWriteDeps>): AtomicWriteDeps {
  const platform = overrides?.platform ?? process.platform
  return {
    platform,
    mkdir: overrides?.mkdir ?? fs.mkdir,
    writeFile: overrides?.writeFile ?? fs.writeFile,
    open: overrides?.open ?? fs.open,
    rename: overrides?.rename ?? fs.rename,
    link: overrides?.link ?? fs.link,
    rm: overrides?.rm ?? fs.rm,
    renameSync: overrides?.renameSync ?? renameSync,
    fstatSync: overrides?.fstatSync ?? fstatSync,
    closeSync: overrides?.closeSync ?? closeSync,
    statSync: overrides?.statSync ?? statSync,
    lstatSync: overrides?.lstatSync ?? ((path => lstatSync(path, { bigint: true })) as typeof lstatSync),
    readFileSync: overrides?.readFileSync ?? readFileSync,
    rmSync: overrides?.rmSync ?? rmSync,
    rmdirSync: overrides?.rmdirSync ?? rmdirSync,
    sleep: overrides?.sleep ?? defaultSleep,
    sleepSync: overrides?.sleepSync ?? sleepSync,
    now: overrides?.now ?? Date.now,
    randomId: overrides?.randomId ?? randomUUID,
    getRetryDelayMs: overrides?.getRetryDelayMs ?? defaultRetryDelayMs,
    syncDirectory: overrides?.syncDirectory ?? (path => syncDirectorySync(path, platform)),
    secureWindowsNamespace: overrides?.secureWindowsNamespace ?? secureWindowsAtomicNamespace,
  }
}

/**
 * This is deliberately a process-local, destination-specific fence.  All
 * writers using atomicWrite participate, so cleanup of one transaction can
 * only ever touch its private temp name and can never race another commit.
 * The filesystem rename remains the cross-process atomic commit primitive.
 */
const destinationMutationFences = new Map<string, Promise<void>>()

async function withDestinationMutationFence<T>(
  destination: string,
  operation: () => Promise<T>,
): Promise<T> {
  const predecessor = destinationMutationFences.get(destination)
  let release!: () => void
  const fence = new Promise<void>(resolve => { release = resolve })
  destinationMutationFences.set(destination, fence)
  await predecessor
  try {
    return await operation()
  } finally {
    release()
    if (destinationMutationFences.get(destination) === fence) {
      destinationMutationFences.delete(destination)
    }
  }
}

function assertPublicationAuthority(context: AtomicWriteContext | undefined): void {
  context?.throwIfExpired?.()
  if (context?.signal?.aborted) {
    const reason = context.signal.reason
    throw reason instanceof Error ? reason : new Error(typeof reason === 'string' ? reason : 'atomic publication aborted')
  }
  if (context?.remainingMs && context.remainingMs() <= 0) {
    throw new Error('atomic publication deadline exhausted')
  }
}

function authorityExpired(context: AtomicWriteContext | undefined): boolean {
  try {
    assertPublicationAuthority(context)
    return false
  } catch {
    return true
  }
}

function sameFileIdentity(
  left: { dev: number | bigint; ino: number | bigint },
  right: { dev: number | bigint; ino: number | bigint },
): boolean {
  return BigInt(left.dev) === BigInt(right.dev) && BigInt(left.ino) === BigInt(right.ino)
}

type TombstoneIdentity = {
  dev: bigint
  ino: bigint
}

/** A Windows DACL proves which account may use a directory, but cannot prove
 * which process created an already-present path.  The stable parent is only
 * a container: every runtime creates an exclusive child before it ever uses
 * a source name.  Consequently a restart (and a second process) never has to
 * bless or clean a namespace left by another runtime. */
const ownedWindowsTombstoneNamespaces = new Map<string, TombstoneIdentity>()
const WINDOWS_NAMESPACE_RECEIPT = '.namespace.identity.json'
const WINDOWS_NAMESPACE_AUTHORITY = '.namespace.authority'
const WINDOWS_NAMESPACE_RECEIPT_FORMAT = 'atomic-write-namespace-v3'
const WINDOWS_AUTHORITY_CLAIM_FORMAT = 'atomic-write-authority-claim-v1'
const WINDOWS_GENERATION_KEY_FORMAT = 'atomic-write-generation-key-v1'
const WINDOWS_GENERATION_BOOTSTRAP_FORMAT = 'atomic-write-generation-bootstrap-v1'
// A reclaimer is a lease too.  Do not immediately steal an authentically
// dead claimant: a short age floor makes a stopped/restarted process and a
// delayed filesystem observation fail closed rather than flap the claim.
const WINDOWS_RECLAIMER_TAKEOVER_AGE_MS = 30_000

type WindowsAuthorityClaimRecord = {
  format: typeof WINDOWS_AUTHORITY_CLAIM_FORMAT
  role: 'lease' | 'reclaimer'
  owner: ProcessInstanceOwner
  generation: string
  createdAt: number
  claim: { dev: string; ino: string }
  authorityMac: string
}
type WindowsGenerationKeyRecord = {
  format: typeof WINDOWS_GENERATION_KEY_FORMAT
  key: string
  owner: ProcessInstanceOwner
  createdAt: number
  keyMac: string
}
/** This is deliberately a different inode from generation.key.  A bootstrap
 * key must not authenticate the record which selects that key: the sealed
 * claim's independently-created nonce is the authentication root until a
 * permanent authority exists. */
type WindowsGenerationBootstrapRecord = {
  format: typeof WINDOWS_GENERATION_BOOTSTRAP_FORMAT
  nonce: string
  owner: ProcessInstanceOwner
  createdAt: number
  claim: { dev: string; ino: string }
}

// Authority initialization is a one-time state transition.  In particular,
// two async callers in this runtime must not both rotate the same recovered
// zero-byte placeholder and invalidate receipts signed by the first caller.
const windowsAuthorityFences = new Map<string, Promise<void>>()

async function withWindowsAuthorityFence<T>(authority: string, operation: () => Promise<T>): Promise<T> {
  const predecessor = windowsAuthorityFences.get(authority)
  let release!: () => void
  const fence = new Promise<void>(resolve => { release = resolve })
  windowsAuthorityFences.set(authority, fence)
  await predecessor
  try {
    return await operation()
  } finally {
    release()
    if (windowsAuthorityFences.get(authority) === fence) windowsAuthorityFences.delete(authority)
  }
}

type WindowsNamespaceReceipt = {
  format: typeof WINDOWS_NAMESPACE_RECEIPT_FORMAT
  target: string
  run: string
  owner: ProcessInstanceOwner
  namespace: { dev: string; ino: string }
  /** `pending` is durable setup evidence. `active` remains live until its
   * exact process incarnation exits; `inactive` is a handled failure. */
  phase: 'pending' | 'active' | 'inactive'
  /** MAC made with a random key stored in the owner-only DACL namespace.
   * Unlike a process-local key it remains verifiable after restart. */
  authorityMac: string
}

function windowsNamespaceAuthorityPath(directory: string): string {
  // The key is deliberately *not* a member of the namespace it authenticates.
  // A namespace that an attacker can replace must never carry both a receipt
  // and the secret used to bless that receipt.  The parent authority is a
  // single-principal, no-hardlink file which survives run retirement.
  return join(dirname(directory), `${ATOMIC_TOMBSTONE_DIRECTORY}${WINDOWS_NAMESPACE_AUTHORITY}.parent.private`, 'authority')
}

function windowsNamespaceMac(
  authority: Buffer, receipt: Omit<WindowsNamespaceReceipt, 'authorityMac'>,
): string {
  return createHmac('sha256', authority).update(JSON.stringify({
    format: receipt.format,
    target: receipt.target,
    run: receipt.run,
    owner: receipt.owner,
    namespace: receipt.namespace,
    phase: receipt.phase,
  })).digest('base64url')
}

function windowsAuthorityClaimMac(authority: Buffer, authorityPath: string,
  record: Omit<WindowsAuthorityClaimRecord, 'authorityMac'>): string {
  return createHmac('sha256', authority).update(JSON.stringify({
    authorityPath, format: record.format, role: record.role, owner: record.owner,
    generation: record.generation, createdAt: record.createdAt, claim: record.claim,
  })).digest('base64url')
}

function readWindowsAuthorityKeySync(authorityPath: string, deps: AtomicWriteDeps): Buffer | null {
  try {
    const before = deps.lstatSync(authorityPath)
    if (!before.isFile() || before.isSymbolicLink() || BigInt(before.size) !== 32n || BigInt(before.nlink) !== 1n
      || !deps.secureWindowsNamespace(authorityPath, false)) return null
    const key = deps.readFileSync(authorityPath)
    const after = deps.lstatSync(authorityPath)
    return after.isFile() && !after.isSymbolicLink() && BigInt(after.size) === 32n && BigInt(after.nlink) === 1n
      && sameFileIdentity(before, after) && key.length === 32 ? key : null
  } catch { return null }
}

function windowsGenerationKeyMac(bootstrapNonce: Buffer, record: Omit<WindowsGenerationKeyRecord, 'keyMac'>): string {
  return createHmac('sha256', bootstrapNonce).update(JSON.stringify({
    format: record.format, key: record.key, owner: record.owner, createdAt: record.createdAt,
  })).digest('base64url')
}

function validGenerationOwner(owner: unknown): owner is ProcessInstanceOwner {
  return !!owner && typeof owner === 'object'
    && Number.isSafeInteger((owner as ProcessInstanceOwner).pid) && (owner as ProcessInstanceOwner).pid > 0
    && (typeof (owner as ProcessInstanceOwner).instance === 'string' || (owner as ProcessInstanceOwner).instance === null)
    && (owner as ProcessInstanceOwner).active === true
}

function readWindowsAuthorityGenerationBootstrapSync(claim: string, expected: {
  owner: ProcessInstanceOwner; createdAt: number
}, deps: AtomicWriteDeps): Buffer | null {
  try {
    const claimStats = deps.lstatSync(claim)
    if (!claimStats.isDirectory() || claimStats.isSymbolicLink()) return null
    const path = join(claim, 'generation.bootstrap')
    const before = deps.lstatSync(path)
    if (!before.isFile() || before.isSymbolicLink() || BigInt(before.nlink) !== 1n) return null
    const record = JSON.parse(deps.readFileSync(path, 'utf8')) as Partial<WindowsGenerationBootstrapRecord>
    const after = deps.lstatSync(path)
    if (!sameFileIdentity(before, after) || record.format !== WINDOWS_GENERATION_BOOTSTRAP_FORMAT
      || typeof record.nonce !== 'string' || !validGenerationOwner(record.owner)
      || record.owner.pid !== expected.owner.pid || record.owner.instance !== expected.owner.instance
      || record.createdAt !== expected.createdAt || !record.claim
      || BigInt(record.claim.dev) !== BigInt(claimStats.dev) || BigInt(record.claim.ino) !== BigInt(claimStats.ino)) return null
    const nonce = Buffer.from(record.nonce, 'base64url')
    return nonce.length === 32 ? nonce : null
  } catch { return null }
}

// The bootstrap authority includes its own signed owner election. This makes
// a crash before lease.json recoverable without accepting a raw key-only
// prefix as authority to steal a live initializer.
function readWindowsAuthorityGenerationKeySync(path: string, deps: AtomicWriteDeps): Buffer | null {
  try {
    const before = deps.lstatSync(path)
    if (!before.isFile() || before.isSymbolicLink()) return null
    const bytes = deps.readFileSync(path)
    const after = deps.lstatSync(path)
    if (!sameFileIdentity(before, after)) return null
    if (bytes.length === 32) return bytes // legacy only; never a key-only recovery owner
    const record = JSON.parse(bytes.toString('utf8')) as Partial<WindowsGenerationKeyRecord>
    if (record.format !== WINDOWS_GENERATION_KEY_FORMAT || typeof record.key !== 'string'
      || !record.owner || !Number.isSafeInteger(record.owner.pid) || record.owner.pid <= 0
      || (typeof record.owner.instance !== 'string' && record.owner.instance !== null)
      || record.owner.active !== true || !Number.isSafeInteger(record.createdAt) || record.createdAt < 0
      || typeof record.keyMac !== 'string') return null
    const key = Buffer.from(record.key, 'base64url')
    const bootstrap = readWindowsAuthorityGenerationBootstrapSync(dirname(path), {
      owner: record.owner as ProcessInstanceOwner, createdAt: record.createdAt,
    }, deps)
    const actual = Buffer.from(record.keyMac)
    const expected = bootstrap && Buffer.from(windowsGenerationKeyMac(bootstrap, {
      format: record.format, key: record.key, owner: record.owner, createdAt: record.createdAt,
    }))
    return key.length === 32 && !!expected && actual.length === expected.length && timingSafeEqual(actual, expected) ? key : null
  } catch { return null }
}

function readWindowsAuthorityGenerationOwnerSync(path: string, deps: AtomicWriteDeps): ProcessInstanceOwner | null {
  try {
    const record = JSON.parse(deps.readFileSync(path, 'utf8')) as Partial<WindowsGenerationKeyRecord>
    return readWindowsAuthorityGenerationKeySync(path, deps) && record.format === WINDOWS_GENERATION_KEY_FORMAT
      && record.owner && Number.isSafeInteger(record.owner.pid) && record.owner.pid > 0
      && (typeof record.owner.instance === 'string' || record.owner.instance === null) && record.owner.active === true
      ? record.owner as ProcessInstanceOwner : null
  } catch { return null }
}

async function writeWindowsAuthorityGenerationBootstrapExclusive(claim: string, owner: ProcessInstanceOwner,
  createdAt: number, nonce: Buffer, deps: AtomicWriteDeps): Promise<void> {
  const claimStats = deps.lstatSync(claim)
  const record: WindowsGenerationBootstrapRecord = { format: WINDOWS_GENERATION_BOOTSTRAP_FORMAT,
    nonce: nonce.toString('base64url'), owner, createdAt,
    claim: { dev: BigInt(claimStats.dev).toString(), ino: BigInt(claimStats.ino).toString() } }
  const path = join(claim, 'generation.bootstrap')
  const staged = `${path}.staged.${deps.randomId()}`
  await deps.writeFile(staged, JSON.stringify(record), { mode: 0o600, flag: 'wx' })
  const handle = await deps.open(staged, 'r+')
  try { await handle.sync() } finally { await handle.close().catch(() => undefined) }
  deps.syncDirectory(claim)
  try { await deps.link(staged, path); deps.syncDirectory(claim) }
  finally { await deps.rm(staged, { force: true }).catch(() => undefined); deps.syncDirectory(claim) }
}

async function writeWindowsAuthorityGenerationKeyExclusive(path: string, key: Buffer, deps: AtomicWriteDeps): Promise<void> {
  const owner = { pid: process.pid, instance: processInstanceSync(process.pid), active: true }
  const createdAt = deps.now()
  const nonce = randomBytes(32)
  await writeWindowsAuthorityGenerationBootstrapExclusive(dirname(path), owner, createdAt, nonce, deps)
  const unsigned: Omit<WindowsGenerationKeyRecord, 'keyMac'> = {
    format: WINDOWS_GENERATION_KEY_FORMAT, key: key.toString('base64url'),
    owner, createdAt,
  }
  const staged = `${path}.staged.${deps.randomId()}`
  await deps.writeFile(staged, JSON.stringify({ ...unsigned, keyMac: windowsGenerationKeyMac(nonce, unsigned) }), { mode: 0o600, flag: 'wx' })
  const handle = await deps.open(staged, 'r+')
  try { await handle.sync() } finally { await handle.close().catch(() => undefined) }
  deps.syncDirectory(dirname(path))
  try { await deps.link(staged, path); deps.syncDirectory(dirname(path)) }
  finally { await deps.rm(staged, { force: true }).catch(() => undefined); deps.syncDirectory(dirname(path)) }
}

function writeWindowsAuthorityGenerationKeyExclusiveSync(path: string, key: Buffer, deps: AtomicWriteDeps): void {
  const owner = { pid: process.pid, instance: processInstanceSync(process.pid), active: true }
  const createdAt = deps.now()
  const nonce = randomBytes(32)
  const claimStats = deps.lstatSync(dirname(path))
  const bootstrap: WindowsGenerationBootstrapRecord = { format: WINDOWS_GENERATION_BOOTSTRAP_FORMAT,
    nonce: nonce.toString('base64url'), owner, createdAt,
    claim: { dev: BigInt(claimStats.dev).toString(), ino: BigInt(claimStats.ino).toString() } }
  const bootstrapPath = join(dirname(path), 'generation.bootstrap')
  const bootstrapStaged = `${bootstrapPath}.staged.${deps.randomId()}`
  writeFileSync(bootstrapStaged, JSON.stringify(bootstrap), { mode: 0o600, flag: 'wx' })
  const bootstrapFd = openSync(bootstrapStaged, 'r+')
  try { fsyncSync(bootstrapFd) } finally { deps.closeSync(bootstrapFd) }
  deps.syncDirectory(dirname(path))
  try { linkSync(bootstrapStaged, bootstrapPath); deps.syncDirectory(dirname(path)) }
  finally { try { deps.rmSync(bootstrapStaged, { force: true }) } catch {} deps.syncDirectory(dirname(path)) }
  const unsigned: Omit<WindowsGenerationKeyRecord, 'keyMac'> = {
    format: WINDOWS_GENERATION_KEY_FORMAT, key: key.toString('base64url'),
    owner, createdAt,
  }
  const staged = `${path}.staged.${deps.randomId()}`
  writeFileSync(staged, JSON.stringify({ ...unsigned, keyMac: windowsGenerationKeyMac(nonce, unsigned) }), { mode: 0o600, flag: 'wx' })
  const fd = openSync(staged, 'r+')
  try { fsyncSync(fd) } finally { deps.closeSync(fd) }
  deps.syncDirectory(dirname(path))
  try { linkSync(staged, path); deps.syncDirectory(dirname(path)) }
  finally { try { deps.rmSync(staged, { force: true }) } catch {} deps.syncDirectory(dirname(path)) }
}

/** A claimed control can be left at `.collected.*` by a crash. The key has
 * the same crash boundary, so recovery must find its unique collected
 * generation rather than treating the claim as unauthenticated. */
function readWindowsAuthorityGenerationKeyForClaimSync(claim: string, deps: AtomicWriteDeps): Buffer | null {
  try {
    const candidates = [
      join(claim, 'generation.key'),
      join(claim, 'recovery.key'),
      ...readdirSync(claim).filter(name => name.startsWith('generation.key.staged.')).map(name => join(claim, name)),
      ...readdirSync(claim).filter(name => name.startsWith('generation.key.collected.')).map(name => join(claim, name)),
      ...readdirSync(claim).filter(name => name.startsWith('recovery.key.collected.')).map(name => join(claim, name)),
    ]
    const keys = candidates.map(path => readWindowsAuthorityGenerationKeySync(path, deps))
      .filter((key): key is Buffer => key !== null)
    return keys.length > 0 && keys.every(key => key.equals(keys[0]!)) ? keys[0]! : null
  } catch { return null }
}

function readWindowsAuthorityClaimSync(path: string, authorityPath: string, claim: TombstoneIdentity,
  deps: AtomicWriteDeps): { path: string; record: WindowsAuthorityClaimRecord; identity: TombstoneIdentity; signingKey: Buffer } | null {
  try {
    const stats = deps.lstatSync(path)
    if (!stats.isFile() || stats.isSymbolicLink()) return null
    const record = JSON.parse(deps.readFileSync(path, 'utf8')) as Partial<WindowsAuthorityClaimRecord>
    if (record.format !== WINDOWS_AUTHORITY_CLAIM_FORMAT || (record.role !== 'lease' && record.role !== 'reclaimer')
      || !record.owner || !Number.isSafeInteger(record.owner.pid) || record.owner.pid <= 0
      || (typeof record.owner.instance !== 'string' && record.owner.instance !== null)
      || record.owner.active !== true || typeof record.generation !== 'string' || record.generation.length < 8
      || !Number.isSafeInteger(record.createdAt) || record.createdAt < 0
      || !record.claim || typeof record.claim.dev !== 'string' || typeof record.claim.ino !== 'string'
      || BigInt(record.claim.dev) !== claim.dev || BigInt(record.claim.ino) !== claim.ino
      || typeof record.authorityMac !== 'string') return null
    const supplied = Buffer.from(record.authorityMac)
    const keys = [readWindowsAuthorityKeySync(authorityPath, deps),
      readWindowsAuthorityGenerationKeyForClaimSync(dirname(path), deps)].filter((key): key is Buffer => key !== null)
    const signingKey = keys.find(key => {
      const expectedBytes = Buffer.from(windowsAuthorityClaimMac(key, authorityPath, {
        format: record.format, role: record.role, owner: record.owner, generation: record.generation,
        createdAt: record.createdAt, claim: record.claim,
      }))
      return supplied.length === expectedBytes.length && timingSafeEqual(supplied, expectedBytes)
    })
    if (!signingKey) return null
    const after = deps.lstatSync(path)
    if (!sameFileIdentity(stats, after)) return null
    return {
      path,
      record: record as WindowsAuthorityClaimRecord,
      identity: tombstoneIdentityFromStats(stats),
      signingKey,
    }
  } catch { return null }
}

/** A complete staged reclaimer is crash evidence, not disposable clutter.
 * Use it only when no final record exists; multiple candidates remain
 * fail-closed rather than letting an observer choose an owner. */
function readWindowsAuthorityClaimOrStagedSync(path: string, authorityPath: string,
  claim: TombstoneIdentity, deps: AtomicWriteDeps): ReturnType<typeof readWindowsAuthorityClaimSync> {
  let candidates: Array<NonNullable<ReturnType<typeof readWindowsAuthorityClaimSync>>> = []
  try {
    // A crash after a hard-link claim may leave several names for one exact
    // signed inode.  Those are one generation, whereas different inodes or
    // records remain an unresolvable competing election.
    for (const candidatePath of [path, ...readdirSync(dirname(path))
      .filter(entry => entry.startsWith(`${basename(path)}.staged.`) || entry.startsWith(`${basename(path)}.collected.`))
      .map(entry => join(dirname(path), entry))]) {
      const candidate = readWindowsAuthorityClaimSync(candidatePath, authorityPath, claim, deps)
      if (candidate) candidates.push(candidate)
    }
  } catch { return null }
  if (candidates.length === 0) return null
  const first = candidates[0]!
  return candidates.every(candidate => sameTombstoneIdentity(candidate.identity, first.identity)
    && sameWindowsAuthorityClaimRecord(candidate.record, first.record)
    && candidate.signingKey.equals(first.signingKey))
    ? (candidates.find(candidate => candidate.path === path) ?? first)
    : null
}

function authorityClaimRecord(authorityPath: string, claim: TombstoneIdentity,
  role: WindowsAuthorityClaimRecord['role'], deps: AtomicWriteDeps, generationKey?: Buffer): WindowsAuthorityClaimRecord {
  const key = generationKey ?? readWindowsAuthorityKeySync(authorityPath, deps)
  if (!key) throw new Error(`atomic publication authority is invalid: ${authorityPath}`)
  const unsigned: Omit<WindowsAuthorityClaimRecord, 'authorityMac'> = {
    format: WINDOWS_AUTHORITY_CLAIM_FORMAT, role,
    owner: { pid: process.pid, instance: processInstanceSync(process.pid), active: true },
    generation: deps.randomId(), createdAt: deps.now(),
    claim: { dev: claim.dev.toString(), ino: claim.ino.toString() },
  }
  return { ...unsigned, authorityMac: windowsAuthorityClaimMac(key, authorityPath, unsigned) }
}

function sameWindowsAuthorityClaimRecord(left: WindowsAuthorityClaimRecord, right: WindowsAuthorityClaimRecord): boolean {
  return left.generation === right.generation
    && left.createdAt === right.createdAt
    && left.owner.pid === right.owner.pid
    && left.owner.instance === right.owner.instance
    && left.owner.active === right.owner.active
    && left.claim.dev === right.claim.dev
    && left.claim.ino === right.claim.ino
    && left.authorityMac === right.authorityMac
}

/** A claim is a durable election, so never expose the `wx` zero-length
 * window at its final pathname.  The complete authenticated staging inode is
 * linked into the final name atomically; a crash leaves either that final
 * record or a collectible staged record. */
async function writeWindowsAuthorityClaimExclusive(
  path: string, record: WindowsAuthorityClaimRecord, deps: AtomicWriteDeps,
): Promise<void> {
  const staged = `${path}.staged.${deps.randomId()}`
  await deps.writeFile(staged, JSON.stringify(record), { mode: 0o600, flag: 'wx' })
  const stagedHandle = await deps.open(staged, 'r+')
  try { await stagedHandle.sync() } finally { await stagedHandle.close().catch(() => undefined) }
  deps.syncDirectory(dirname(path))
  try { await deps.link(staged, path); deps.syncDirectory(dirname(path)) } finally { await deps.rm(staged, { force: true }).catch(() => undefined); deps.syncDirectory(dirname(path)) }
}

function writeWindowsAuthorityClaimExclusiveSync(
  path: string, record: WindowsAuthorityClaimRecord, deps: AtomicWriteDeps,
): void {
  const staged = `${path}.staged.${deps.randomId()}`
  writeFileSync(staged, JSON.stringify(record), { mode: 0o600, flag: 'wx' })
  const fd = openSync(staged, 'r+')
  try { fsyncSync(fd) } finally { deps.closeSync(fd) }
  deps.syncDirectory(dirname(path))
  try { linkSync(staged, path); deps.syncDirectory(dirname(path)) } finally { try { deps.rmSync(staged, { force: true }) } catch {} deps.syncDirectory(dirname(path)) }
}

async function removeWindowsAuthorityClaimStaging(claim: string, claimPath: string,
  authority: string, proof: TombstoneIdentity, deps: AtomicWriteDeps, selected?: { path: string }): Promise<void> {
  const prefix = `${basename(claimPath)}.`
  for (const entry of readdirSync(claim)) {
    // A `.collected` name is the durable result of an earlier collector's
    // rename. It must be consumed through the selected control path below,
    // not removed as anonymous staging before a caller tries its final name.
    if (!entry.startsWith(`${prefix}staged.`)) continue
    const candidate = join(claim, entry)
    if (candidate === selected?.path) continue
    const authenticated = readWindowsAuthorityClaimSync(candidate, authority, proof, deps)
    if (authenticated && !await removeWindowsAuthorityClaimAuthenticatedExact(candidate, authenticated, authority, proof, deps)) {
      throw new Error(`atomic authority staging record changed: ${candidate}`)
    }
  }
}

function removeWindowsAuthorityClaimStagingSync(claim: string, claimPath: string,
  authority: string, proof: TombstoneIdentity, deps: AtomicWriteDeps, selected?: { path: string }): void {
  const prefix = `${basename(claimPath)}.`
  for (const entry of readdirSync(claim)) {
    if (!entry.startsWith(`${prefix}staged.`)) continue
    const candidate = join(claim, entry)
    if (candidate === selected?.path) continue
    const authenticated = readWindowsAuthorityClaimSync(candidate, authority, proof, deps)
    if (authenticated && !removeWindowsAuthorityClaimAuthenticatedExactSync(candidate, authenticated, authority, proof, deps)) {
      throw new Error(`atomic authority staging record changed: ${candidate}`)
    }
  }
}

async function consumeWindowsAuthorityCollectedAliases(claim: string, claimPath: string,
  authority: string, proof: TombstoneIdentity, deps: AtomicWriteDeps): Promise<void> {
  const final = readWindowsAuthorityClaimSync(claimPath, authority, proof, deps)
  for (const entry of readdirSync(claim)) {
    if (!entry.startsWith(`${basename(claimPath)}.collected.`)) continue
    const candidate = readWindowsAuthorityClaimSync(join(claim, entry), authority, proof, deps)
    if (!candidate || (final && (!sameTombstoneIdentity(candidate.identity, final.identity)
      || !sameWindowsAuthorityClaimRecord(candidate.record, final.record)))) {
      throw new Error(`atomic authority collected record is not an alias: ${entry}`)
    }
    if (!await removeWindowsAuthorityClaimAuthenticatedExact(candidate.path, candidate, authority, proof, deps)) {
      throw new Error(`atomic authority collected record changed: ${entry}`)
    }
  }
}

function consumeWindowsAuthorityCollectedAliasesSync(claim: string, claimPath: string,
  authority: string, proof: TombstoneIdentity, deps: AtomicWriteDeps): void {
  const final = readWindowsAuthorityClaimSync(claimPath, authority, proof, deps)
  for (const entry of readdirSync(claim)) {
    if (!entry.startsWith(`${basename(claimPath)}.collected.`)) continue
    const candidate = readWindowsAuthorityClaimSync(join(claim, entry), authority, proof, deps)
    if (!candidate || (final && (!sameTombstoneIdentity(candidate.identity, final.identity)
      || !sameWindowsAuthorityClaimRecord(candidate.record, final.record)))
      || !removeWindowsAuthorityClaimAuthenticatedExactSync(candidate.path, candidate, authority, proof, deps)) {
      throw new Error(`atomic authority collected record changed: ${entry}`)
    }
  }
}

async function removeWindowsAuthorityClaimExact(path: string, expected: TombstoneIdentity,
  deps: AtomicWriteDeps): Promise<boolean> {
  if (path.includes('.collected.')) {
    try {
      if (!sameTombstoneIdentity(tombstoneIdentityFromStats(deps.lstatSync(path)), expected)) return false
      await deps.rm(path, { force: true })
      deps.syncDirectory(dirname(path))
      return true
    } catch { return false }
  }
  const collected = `${path}.collected.${deps.randomId()}`
  try {
    // Claim ownership excludes replacement publication. Move the public name
    // atomically to its recovery alias rather than validating then unlinking
    // a reusable pathname through an ABA gap.
    const before = tombstoneIdentityFromStats(deps.lstatSync(path))
    if (!sameTombstoneIdentity(before, expected)) return false
    await deps.rename(path, collected)
    deps.syncDirectory(dirname(path))
    const observed = deps.lstatSync(collected)
    if (!sameTombstoneIdentity(tombstoneIdentityFromStats(observed), expected)) {
      return false
    }
    await deps.rm(collected, { force: true })
    deps.syncDirectory(dirname(path))
    return true
  } catch { return false }
}

function removeWindowsAuthorityClaimExactSync(path: string, expected: TombstoneIdentity,
  deps: AtomicWriteDeps): boolean {
  if (path.includes('.collected.')) {
    try {
      if (!sameTombstoneIdentity(tombstoneIdentityFromStats(deps.lstatSync(path)), expected)) return false
      deps.rmSync(path, { force: true })
      deps.syncDirectory(dirname(path))
      return true
    } catch { return false }
  }
  const collected = `${path}.collected.${deps.randomId()}`
  try {
    const before = tombstoneIdentityFromStats(deps.lstatSync(path))
    if (!sameTombstoneIdentity(before, expected)) return false
    deps.renameSync(path, collected)
    deps.syncDirectory(dirname(path))
    if (!sameTombstoneIdentity(tombstoneIdentityFromStats(deps.lstatSync(collected)), expected)) {
      return false
    }
    deps.rmSync(collected, { force: true })
    deps.syncDirectory(dirname(path))
    return true
  } catch { return false }
}

async function removeWindowsAuthorityClaimAuthenticatedExact(path: string,
  expected: NonNullable<ReturnType<typeof readWindowsAuthorityClaimSync>>,
  authority: string, proof: TombstoneIdentity, deps: AtomicWriteDeps): Promise<boolean> {
  // Capture an immutable private link before retirement. A delayed collector
  // can observe a successor here, but it cannot detach that successor from
  // the reusable final name.
  // Keep the requested final name in the API for callers, but a recovered
  // control may instead live at its durable collected pathname.
  void path
  const controlPath = expected.path
  const current = readWindowsAuthorityClaimSync(controlPath, authority, proof, deps)
  if (!current || !sameTombstoneIdentity(current.identity, expected.identity)
    || !sameWindowsAuthorityClaimRecord(current.record, expected.record)) return false
  // A valid final never hides an older collected control.  Consume every
  // authenticated sibling before retiring this generation or its key.
  for (const entry of readdirSync(dirname(controlPath))) {
    if ((!entry.startsWith(`${basename(path)}.collected.`) && !entry.startsWith(`${basename(path)}.staged.`))
      || join(dirname(controlPath), entry) === controlPath) continue
    const sibling = readWindowsAuthorityClaimSync(join(dirname(controlPath), entry), authority, proof, deps)
    if (!sibling || !await removeWindowsAuthorityClaimExact(sibling.path, sibling.identity, deps)) return false
  }
  return await removeWindowsAuthorityClaimExact(controlPath, expected.identity, deps)
}

function removeWindowsAuthorityClaimAuthenticatedExactSync(path: string,
  expected: NonNullable<ReturnType<typeof readWindowsAuthorityClaimSync>>,
  authority: string, proof: TombstoneIdentity, deps: AtomicWriteDeps): boolean {
  void path
  const controlPath = expected.path
  const current = readWindowsAuthorityClaimSync(controlPath, authority, proof, deps)
  if (!current || !sameTombstoneIdentity(current.identity, expected.identity)
    || !sameWindowsAuthorityClaimRecord(current.record, expected.record)) return false
  for (const entry of readdirSync(dirname(controlPath))) {
    if ((!entry.startsWith(`${basename(path)}.collected.`) && !entry.startsWith(`${basename(path)}.staged.`))
      || join(dirname(controlPath), entry) === controlPath) continue
    const sibling = readWindowsAuthorityClaimSync(join(dirname(controlPath), entry), authority, proof, deps)
    if (!sibling || !removeWindowsAuthorityClaimExactSync(sibling.path, sibling.identity, deps)) return false
  }
  return removeWindowsAuthorityClaimExactSync(controlPath, expected.identity, deps)
}

async function removeWindowsAuthorityFileExact(path: string, deps: AtomicWriteDeps): Promise<boolean> {
  try { return await removeWindowsAuthorityClaimExact(path, tombstoneIdentityFromStats(deps.lstatSync(path)), deps) } catch { return false }
}

function removeWindowsAuthorityFileExactSync(path: string, deps: AtomicWriteDeps): boolean {
  try { return removeWindowsAuthorityClaimExactSync(path, tombstoneIdentityFromStats(deps.lstatSync(path)), deps) } catch { return false }
}

/** Key collection is legal only after every signed lease/reclaimer/election
 * has been consumed. Include detached names so a power loss between rename
 * and unlink does not leave an otherwise empty claim permanently busy. */
async function removeWindowsAuthorityGenerationKeys(claim: string, deps: AtomicWriteDeps): Promise<boolean> {
  for (const entry of readdirSync(claim)) {
    if (entry !== 'generation.key' && !entry.startsWith('generation.key.collected.') && !entry.startsWith('generation.key.staged.')) continue
    const path = join(claim, entry)
    if (!readWindowsAuthorityGenerationKeySync(path, deps)) return false
    if (!await removeWindowsAuthorityFileExact(path, deps)) return false
  }
  return true
}

function removeWindowsAuthorityGenerationKeysSync(claim: string, deps: AtomicWriteDeps): boolean {
  for (const entry of readdirSync(claim)) {
    if (entry !== 'generation.key' && !entry.startsWith('generation.key.collected.') && !entry.startsWith('generation.key.staged.')) continue
    const path = join(claim, entry)
    if (!readWindowsAuthorityGenerationKeySync(path, deps)) return false
    if (!removeWindowsAuthorityFileExactSync(path, deps)) return false
  }
  return true
}

function handoffWindowsAuthorityGenerationKeySync(claim: string, deps: AtomicWriteDeps): boolean {
  try {
    const sources = ['generation.key', ...readdirSync(claim).filter(name => name.startsWith('generation.key.collected.') || name.startsWith('generation.key.staged.'))]
      .map(name => join(claim, name)).flatMap(path => {
        const key = readWindowsAuthorityGenerationKeySync(path, deps)
        return key ? [{ path, key, identity: tombstoneIdentityFromStats(deps.lstatSync(path)) }] : []
      })
    if (sources.length === 0) {
      // A crash can occur after bootstrap retirement but before final-election
      // retirement. Callers have already authenticated that election; the
      // recovery name is therefore the completed handoff, not ambiguity.
      return readWindowsAuthorityGenerationKeyForClaimSync(claim, deps) !== null
        // Existing permanent authority generations never created a bootstrap
        // key. Their elected cleanup record is authenticated by authority,
        // so requiring a nonexistent `generation.key` would strand reuse.
        || readWindowsAuthorityKeySync(claim.slice(0, -'.claim'.length), deps) !== null
    }
    // Link-before-unlink can leave several collected aliases of the same
    // generation inode. They are one authority, not an ambiguous election.
    if (!sources.every(source => source.key.equals(sources[0]!.key)
      && sameTombstoneIdentity(source.identity, sources[0]!.identity))) return false
    const source = sources[0]!
    const expected = source.identity
    const recovery = join(claim, 'recovery.key')
    // Rename, rather than link, is the handoff.  A recovered collected alias
    // can already make the bootstrap inode nlink=2; linking recovery then
    // creates an internally-generated nlink=3 state that no crash recovery
    // can safely classify.  Rename preserves one durable name at every
    // boundary and the remaining same-inode aliases are consumed below.
    try { renameSync(source.path, recovery) } catch (error) { if (getErrorCode(error) !== 'EEXIST') return false }
    const key = readWindowsAuthorityGenerationKeySync(recovery, deps)
    if (!key || !sameTombstoneIdentity(tombstoneIdentityFromStats(deps.lstatSync(recovery)), expected)) return false
    deps.syncDirectory(claim)
    const removed = removeWindowsAuthorityGenerationKeysSync(claim, deps)
    if (removed) deps.syncDirectory(claim)
    return removed
  } catch { return false }
}

async function handoffWindowsAuthorityGenerationKey(claim: string, deps: AtomicWriteDeps): Promise<boolean> {
  try {
    const sources = ['generation.key', ...readdirSync(claim).filter(name => name.startsWith('generation.key.collected.') || name.startsWith('generation.key.staged.'))]
      .map(name => join(claim, name)).flatMap(path => {
        const key = readWindowsAuthorityGenerationKeySync(path, deps)
        return key ? [{ path, key, identity: tombstoneIdentityFromStats(deps.lstatSync(path)) }] : []
      })
    if (sources.length === 0) {
      return readWindowsAuthorityGenerationKeyForClaimSync(claim, deps) !== null
        || readWindowsAuthorityKeySync(claim.slice(0, -'.claim'.length), deps) !== null
    }
    if (!sources.every(source => source.key.equals(sources[0]!.key)
      && sameTombstoneIdentity(source.identity, sources[0]!.identity))) return false
    const source = sources[0]!
    const expected = source.identity
    const recovery = join(claim, 'recovery.key')
    try { await deps.rename(source.path, recovery) } catch (error) { if (getErrorCode(error) !== 'EEXIST') return false }
    const key = readWindowsAuthorityGenerationKeySync(recovery, deps)
    if (!key || !sameTombstoneIdentity(tombstoneIdentityFromStats(deps.lstatSync(recovery)), expected)) return false
    deps.syncDirectory(claim)
    const removed = await removeWindowsAuthorityGenerationKeys(claim, deps)
    if (removed) deps.syncDirectory(claim)
    return removed
  } catch { return false }
}

function removeWindowsAuthorityRecoveryKeySync(claim: string, deps: AtomicWriteDeps): boolean {
  try {
    const names = readdirSync(claim).filter(entry => entry === 'recovery.key' || entry.startsWith('recovery.key.collected.'))
    for (const name of names) {
      const path = join(claim, name)
      if (removeExactTombstoneSync(path, tombstoneIdentityFromStats(deps.lstatSync(path)), deps) !== 'removed') return false
    }
    const bootstrap = join(claim, 'generation.bootstrap')
    try {
      if (!removeWindowsAuthorityFileExactSync(bootstrap, deps)) return false
    } catch (error) { if (getErrorCode(error) !== 'ENOENT') return false }
    if (names.length > 0) deps.syncDirectory(claim)
    return true
  } catch { return false }
}

async function removeWindowsAuthorityRecoveryKey(claim: string, deps: AtomicWriteDeps): Promise<boolean> {
  try {
    const names = readdirSync(claim).filter(entry => entry === 'recovery.key' || entry.startsWith('recovery.key.collected.'))
    for (const name of names) {
      const path = join(claim, name)
      if (removeExactTombstoneSync(path, tombstoneIdentityFromStats(deps.lstatSync(path)), deps) !== 'removed') return false
    }
    // The bootstrap nonce authenticates generation/recovery records but is
    // never itself an election. Retire it only after every such record has
    // been consumed, preserving a recoverable root at all earlier prefixes.
    const bootstrap = join(claim, 'generation.bootstrap')
    try {
      if (!await removeWindowsAuthorityFileExact(bootstrap, deps)) return false
    } catch (error) { if (getErrorCode(error) !== 'ENOENT') return false }
    if (names.length > 0) deps.syncDirectory(claim)
    return true
  } catch { return false }
}

function hasOnlyWindowsAuthorityGenerationKeysSync(claim: string, deps: AtomicWriteDeps): boolean {
  try {
    const entries = readdirSync(claim)
    if (entries.length === 0 || !entries.every(entry => entry === 'generation.key' || entry === 'generation.bootstrap'
      || entry.startsWith('generation.key.staged.') || entry.startsWith('generation.key.collected.'))) return false
    const generations = entries.filter(entry => entry !== 'generation.bootstrap').map(entry => {
      const path = join(claim, entry)
      const owner = readWindowsAuthorityGenerationOwnerSync(path, deps)
      const key = readWindowsAuthorityGenerationKeySync(path, deps)
      if (!owner || !key) return null
      const record = JSON.parse(deps.readFileSync(path, 'utf8')) as WindowsGenerationKeyRecord
      return { owner, key, identity: tombstoneIdentityFromStats(deps.lstatSync(path)), createdAt: record.createdAt }
    })
    if (generations.some(generation => generation === null)) return false
    const first = generations[0]
    if (!first) return false
    return deps.now() - first.createdAt >= WINDOWS_RECLAIMER_TAKEOVER_AGE_MS
      && generations.every(generation => generation !== null && generation.owner.pid === first.owner.pid
        && generation.owner.instance === first.owner.instance && generation.key.equals(first.key)
        && sameTombstoneIdentity(generation.identity, first.identity))
      && publisherIsVerifiablyAbandoned(first.owner)
  } catch { return false }
}

/** A crash before generation.key publication leaves an independently owned
 * bootstrap nonce, not an empty claim.  It is reclaimable only after its
 * exact owner incarnation has exited; this prevents an "empty" observer from
 * deleting a live initializer's staged root. */
function hasOnlyWindowsAuthorityBootstrapSync(claim: string, deps: AtomicWriteDeps): boolean {
  try {
    const names = readdirSync(claim)
    if (names.length === 0 || !names.every(name => name === 'generation.bootstrap' || name.startsWith('generation.bootstrap.staged.'))) return false
    const claimStats = deps.lstatSync(claim)
    const records = names.map(name => {
      const path = join(claim, name)
      const stats = deps.lstatSync(path)
      const record = JSON.parse(deps.readFileSync(path, 'utf8')) as Partial<WindowsGenerationBootstrapRecord>
      if (!stats.isFile() || stats.isSymbolicLink() || !validGenerationOwner(record.owner)
        || record.format !== WINDOWS_GENERATION_BOOTSTRAP_FORMAT || !Number.isSafeInteger(record.createdAt)
        || !record.claim || BigInt(record.claim.dev) !== BigInt(claimStats.dev) || BigInt(record.claim.ino) !== BigInt(claimStats.ino)) return null
      return record as WindowsGenerationBootstrapRecord
    })
    const first = records[0]
    return !!first && records.every(record => record && record.owner.pid === first.owner.pid
      && record.owner.instance === first.owner.instance && record.createdAt === first.createdAt && record.nonce === first.nonce)
      && deps.now() - first.createdAt >= WINDOWS_RECLAIMER_TAKEOVER_AGE_MS && publisherIsVerifiablyAbandoned(first.owner)
  } catch { return false }
}

function removeWindowsAuthorityBootstrapsSync(claim: string, deps: AtomicWriteDeps): boolean {
  try {
    for (const name of readdirSync(claim)) {
      if (name !== 'generation.bootstrap' && !name.startsWith('generation.bootstrap.staged.')) return false
      if (!removeWindowsAuthorityFileExactSync(join(claim, name), deps)) return false
    }
    deps.syncDirectory(claim)
    return true
  } catch { return false }
}

function hasOnlyWindowsAuthorityRecoveryKeySync(claim: string): boolean {
  try { return readdirSync(claim).every(entry => entry === 'recovery.key' || entry === 'generation.bootstrap'
    || entry.startsWith('recovery.key.collected.')) } catch { return false }
}

function hasValidWindowsNamespaceMac(directory: string, receipt: WindowsNamespaceReceipt, deps: AtomicWriteDeps): boolean {
  if (!['pending', 'active', 'inactive'].includes(receipt.phase) || typeof receipt.authorityMac !== 'string') return false
  let authority: Buffer
  try {
    const authorityStats = deps.lstatSync(windowsNamespaceAuthorityPath(directory))
    // BigIntStats is used by every recovery path.  Comparing its size to a
    // number makes a perfectly valid 32-byte key fail authentication; avoid
    // narrowing any authority observation and reject hard-linked key files.
    if (!authorityStats.isFile() || authorityStats.isSymbolicLink()
      || BigInt(authorityStats.size) !== 32n || BigInt(authorityStats.nlink) !== 1n) return false
    // Existing keys are validation-only. Never repair/adopt a key while
    // authenticating recovery metadata.
    if (!deps.secureWindowsNamespace(windowsNamespaceAuthorityPath(directory), false)) return false
    authority = deps.readFileSync(windowsNamespaceAuthorityPath(directory))
    const after = deps.lstatSync(windowsNamespaceAuthorityPath(directory))
    if (!after.isFile() || after.isSymbolicLink() || BigInt(after.size) !== 32n || BigInt(after.nlink) !== 1n
      || !sameFileIdentity(authorityStats, after) || authority.length !== 32) return false
  } catch { return false }
  const expected = windowsNamespaceMac(authority, {
    format: receipt.format, target: receipt.target, run: receipt.run,
    owner: receipt.owner, namespace: receipt.namespace, phase: receipt.phase,
  })
  const provided = Buffer.from(receipt.authorityMac)
  const expectedBytes = Buffer.from(expected)
  return provided.length === expectedBytes.length && timingSafeEqual(provided, expectedBytes)
}

type PersistedTombstoneIdentity = {
  dev: string
  ino: string
  /** A tombstone is collectible only after its publisher is proven gone.
   * This deliberately remains on the receipt after body I/O: an open file
   * descriptor is not a cross-process deletion fence on POSIX. */
  owner: ProcessInstanceOwner
}

export type AtomicWriteTombstoneReport = {
  directory: string
  retained: number
  retainedBytes: number
  removed: number
  skippedReplacements: number
  /** Cleanup that could not be completed after a body was safely removed. */
  cleanupDebt?: { paths: string[] }
}

function tombstoneDirectoryFor(destination: string): string {
  return join(dirname(destination), ATOMIC_TOMBSTONE_DIRECTORY)
}

function windowsRunNamespaceName(deps: AtomicWriteDeps): string {
  const instance = processInstanceSync(process.pid) ?? 'unknown'
  const run = deps.randomId()
  // randomUUID is already portable as a path component.  Keep injected IDs
  // similarly constrained: otherwise a test hook could turn an exclusive
  // mkdir into a path traversal.
  if (!/^[A-Za-z0-9_-]+$/.test(instance) || !/^[A-Za-z0-9_-]+$/.test(run)) {
    throw new Error('atomic publication generated an unsafe tombstone namespace name')
  }
  return `run.p${process.pid}.s${instance}.${run}`
}

function windowsRunNamespacePath(destination: string, deps: AtomicWriteDeps): string {
  // Do not put a newly-created ACL-repairable directory between us and the
  // destination.  The run directory itself is the private publication
  // namespace; before its DACL exists it is only ever recoverable as an empty
  // exclusive-creation attempt, never adopted as a stable parent.
  return join(dirname(destination), `${ATOMIC_TOMBSTONE_DIRECTORY}.${windowsRunNamespaceName(deps)}`)
}

function windowsNamespaceReceiptPath(directory: string): string {
  return join(directory, WINDOWS_NAMESPACE_RECEIPT)
}

/** A receipt claimed into `.collected.*` is still the final authenticated
 * recovery record.  It is deliberately not restored by pathname (that could
 * clobber a successor); cleanup consumes the claimed copy only after its MAC
 * and namespace identity are revalidated. */
function windowsNamespaceReceiptPathForRecovery(directory: string, deps: AtomicWriteDeps): string | null {
  const finalReceipt = windowsNamespaceReceiptPath(directory)
  try { deps.lstatSync(finalReceipt); return finalReceipt } catch (error) {
    if (getErrorCode(error) !== 'ENOENT') return null
  }
  try {
    const claimed = readdirSync(directory).filter(entry => entry.startsWith(`${WINDOWS_NAMESPACE_RECEIPT}.collected.`))
    return claimed.length === 1 ? join(directory, claimed[0]) : null
  } catch { return null }
}

function windowsNamespaceRunFromPath(directory: string): string | null {
  const name = basename(directory).replace(/\.retired\.d\d+\.i\d+$/, '')
  const match = /^(?:\.atomic-write-tombstones\.)?run\.p\d+\.s[A-Za-z0-9_-]+\.([A-Za-z0-9_-]+)(?:\.pending\.d\d+\.i\d+)?$/.exec(name)
  return match?.[1] ?? null
}

function windowsNamespaceOwnerFromPath(directory: string): ProcessInstanceOwner | null {
  const name = basename(directory).replace(/\.retired\.d\d+\.i\d+$/, '')
  const match = /^(?:\.atomic-write-tombstones\.)?run\.p(\d+)\.s([A-Za-z0-9_-]+)\./.exec(name)
  if (!match) return null
  return { pid: Number(match[1]), instance: match[2] === 'unknown' ? null : match[2], active: true }
}

function windowsPendingIdentity(name: string): TombstoneIdentity | null {
  const match = /\.pending\.d(\d+)\.i(\d+)$/.exec(name)
  return match ? { dev: BigInt(match[1]), ino: BigInt(match[2]) } : null
}

function windowsRetirementNamespace(directory: string, identity: TombstoneIdentity): string {
  return `${directory}.retired.d${identity.dev}.i${identity.ino}`
}

function windowsRetirementIdentity(name: string): TombstoneIdentity | null {
  const match = /\.retired\.d(\d+)\.i(\d+)$/.exec(name)
  return match ? { dev: BigInt(match[1]), ino: BigInt(match[2]) } : null
}

function tombstonePrefixFor(destination: string): string {
  return `${basename(destination)}.tmp.`
}

function tombstoneIdentityPath(path: string): string {
  return `${path}.identity.json`
}

// A collector can claim a sidecar too. Its claimed name is metadata, never a
// body, even though it no longer ends in `.identity.json`.
function isTombstoneIdentitySidecarName(name: string): boolean {
  return name.endsWith('.identity.json')
    || name.includes('.identity.json.staged.')
    || name.includes('.identity.json.collected.')
}

function tombstoneBodyPathForSidecar(path: string): string {
  const marker = '.identity.json'
  const index = path.indexOf(marker)
  return index === -1 ? path : path.slice(0, index)
}

// A collector first claims a body into a private `.collected.*` name.  Its
// receipt intentionally stays at the original name until the body deletion
// succeeds, which makes the crash window recoverable without trusting the
// collected filename as new provenance.
function collectedTombstoneOriginalPath(path: string): string {
  const index = path.indexOf('.collected.')
  return index === -1 ? path : path.slice(0, index)
}

async function recordTombstoneIdentity(
  path: string,
  handle: Awaited<ReturnType<typeof fs.open>>,
  deps: AtomicWriteDeps,
  captured?: TombstoneIdentity,
  owner: ProcessInstanceOwner = { pid: process.pid, instance: processInstanceSync(process.pid), active: true },
): Promise<TombstoneIdentity> {
  // Capture the descriptor before attempting the sidecar.  In particular, a
  // sidecar write/sync failure must still leave enough identity to mark this
  // now-failed publisher inactive; otherwise a long-lived PID pins debris.
  const owned = captured ?? await captureTombstoneIdentity(handle)
  const persisted: PersistedTombstoneIdentity = {
    dev: owned.dev.toString(), ino: owned.ino.toString(), owner,
  }
  const receipt = tombstoneIdentityPath(path)
  // Initial creation has no authority to overwrite. Later active->inactive
  // lease changes must not tear the existing receipt in place: preserve the
  // prior conservative receipt until a complete replacement is durable.
  // Initial creation must be staged too. A crash after a direct create can
  // leave a zero-byte final receipt that is indistinguishable from forged
  // metadata, whereas a synced `.staged.*` generation is recoverable.
  const staged = `${receipt}.staged.${deps.randomId()}`
  await deps.writeFile(staged, JSON.stringify(persisted), { mode: 0o600, flag: 'wx' })
  const stagedHandle = await deps.open(staged, 'r+')
  try { await stagedHandle.sync() } finally { await stagedHandle.close().catch(() => undefined) }
  deps.renameSync(staged, receipt)
  deps.syncDirectory(dirname(receipt))
  // Do not begin body I/O until the recovery ownership receipt itself is
  // durable. The descriptor is deliberately retained by the caller too.
  const sidecar = await deps.open(receipt, 'r+')
  try { await sidecar.sync() } finally { await sidecar.close().catch(() => undefined) }
  return owned
}

async function captureTombstoneIdentity(
  handle: Awaited<ReturnType<typeof fs.open>>,
): Promise<TombstoneIdentity> {
  const stats = await handle.stat({ bigint: true })
  return { dev: BigInt(stats.dev), ino: BigInt(stats.ino) }
}

/** Sync writers have the same crash boundary as async writers.  In
 * particular, never create the final receipt by truncating/writing it in
 * place: a power loss there used to leave a final zero-byte receipt that no
 * recovery path could distinguish from hostile metadata. */
function recordTombstoneIdentitySync(
  path: string,
  owned: TombstoneIdentity,
  deps: AtomicWriteDeps,
  owner: ProcessInstanceOwner = { pid: process.pid, instance: processInstanceSync(process.pid), active: true },
): void {
  const receipt = tombstoneIdentityPath(path)
  const staged = `${receipt}.staged.${deps.randomId()}`
  writeFileSync(staged, JSON.stringify({
    dev: owned.dev.toString(), ino: owned.ino.toString(), owner,
  } satisfies PersistedTombstoneIdentity), { mode: 0o600, flag: 'wx' })
  const fd = openSync(staged, 'r+')
  try { fsyncSync(fd) } finally { deps.closeSync(fd) }
  deps.renameSync(staged, receipt)
  deps.syncDirectory(dirname(receipt))
}

type TombstoneIdentityRead =
  | { kind: 'valid'; identity: TombstoneIdentity; owner: ProcessInstanceOwner }
  | { kind: 'missing-or-malformed' }
  | { kind: 'operational-failure' }

/**
 * A receipt whose bytes cannot be parsed is forensic evidence of a torn
 * write.  It is importantly different from a receipt which we were unable
 * to read: permission and I/O failures do not prove anything about the
 * owner, so they must remain observable cleanup debt rather than being
 * silently reclassified as corrupt data.
 */
function readTombstoneIdentitySync(path: string, deps: AtomicWriteDeps): TombstoneIdentityRead {
  try {
    const parsed = JSON.parse(deps.readFileSync(tombstoneIdentityPath(path), 'utf8')) as Partial<PersistedTombstoneIdentity>
    if (typeof parsed.dev !== 'string' || typeof parsed.ino !== 'string'
      || !parsed.owner || !Number.isSafeInteger(parsed.owner.pid) || parsed.owner.pid <= 0
      || (typeof parsed.owner.instance !== 'string' && parsed.owner.instance !== null)
      || typeof parsed.owner.active !== 'boolean') return { kind: 'missing-or-malformed' }
    return { kind: 'valid', identity: { dev: BigInt(parsed.dev), ino: BigInt(parsed.ino) }, owner: parsed.owner }
  } catch (error) {
    // A missing receipt and syntactically/semantically invalid data are the
    // interrupted-creation case. All coded failures other than ENOENT are
    // filesystem operations and must reach the receipt as debt.
    return getErrorCode(error) && getErrorCode(error) !== 'ENOENT'
      ? { kind: 'operational-failure' }
      : { kind: 'missing-or-malformed' }
  }
}

/** Recover exactly one complete staged initial receipt.  A live publisher
 * owns its staged generation, so recovery never promotes it while that exact
 * process incarnation can still be observed. */
function recoverStagedTombstoneIdentitySync(path: string, deps: AtomicWriteDeps): TombstoneIdentityRead | null {
  const receipt = tombstoneIdentityPath(path)
  let staged: string[]
  try { staged = readdirSync(dirname(receipt)).filter(name => name.startsWith(`${basename(receipt)}.staged.`)) } catch { return null }
  if (staged.length !== 1) return null
  const stagedPath = join(dirname(receipt), staged[0])
  try {
    const stagedStats = deps.lstatSync(stagedPath)
    if (!stagedStats.isFile() || stagedStats.isSymbolicLink()) return null
    const parsed = JSON.parse(deps.readFileSync(stagedPath, 'utf8')) as Partial<PersistedTombstoneIdentity>
    if (typeof parsed.dev !== 'string' || typeof parsed.ino !== 'string' || !parsed.owner
      || !Number.isSafeInteger(parsed.owner.pid) || parsed.owner.pid <= 0
      || (typeof parsed.owner.instance !== 'string' && parsed.owner.instance !== null)
      || typeof parsed.owner.active !== 'boolean' || !publisherIsVerifiablyAbandoned(parsed.owner)) return null
    const expected = { dev: BigInt(parsed.dev), ino: BigInt(parsed.ino) }
    const body = deps.lstatSync(path)
    if (!body.isFile() || body.isSymbolicLink() || !sameTombstoneIdentity(tombstoneIdentityFromStats(body), expected)) return null
    try { deps.lstatSync(receipt); return null } catch (error) { if (getErrorCode(error) !== 'ENOENT') return null }
    const beforePromotion = deps.lstatSync(path)
    if (!beforePromotion.isFile() || beforePromotion.isSymbolicLink()
      || !sameTombstoneIdentity(tombstoneIdentityFromStats(beforePromotion), expected)
      || !publisherIsVerifiablyAbandoned(parsed.owner)) return null
    // Claim the final receipt without overwrite. A concurrent publisher can
    // install a valid receipt after the ENOENT observation; rename would
    // silently replace it.
    try { linkSync(stagedPath, receipt) } catch (error) {
      if (getErrorCode(error) === 'EEXIST') return null
      throw error
    }
    if (removeExactTombstoneSync(stagedPath, tombstoneIdentityFromStats(stagedStats), deps) !== 'removed') return null
    deps.syncDirectory(dirname(receipt))
    return { kind: 'valid', identity: expected, owner: parsed.owner }
  } catch { return null }
}

/** `kill(pid, 0)` distinguishes a confirmed dead publisher from one which is
 * alive or cannot be inspected.  Any ambiguity is retained; that is the
 * only safe choice because unlinking an open file is permitted on POSIX. */
function publisherIsVerifiablyAbandoned(owner: ProcessInstanceOwner): boolean {
  return !isProcessInstanceActiveSync(owner)
}

function syncDirectorySync(path: string, platform: NodeJS.Platform = process.platform): void {
  // Windows does not support opening a directory for fsync through Node.
  // FileHandle.sync above is the strongest Node-exposed durability barrier;
  // rename is the documented atomic replacement primitive there.  Do not
  // retroactively reject an already-renamed generation by attempting the
  // unsupported directory operation.
  if (platform === 'win32') return
  const fd = openSync(path, 'r')
  try { fsyncSync(fd) } finally { closeSync(fd) }
}

/** Windows' mode bits are synthesized by Node from the DOS read-only flag,
 * not a POSIX ACL.  Requiring 0700 there rejects private directories whose
 * ACL is perfectly valid.  lstat/isDirectory still rejects links and other
 * path substitutions; POSIX keeps the stricter permission proof. */
function isPrivateTombstoneNamespace(
  stats: ReturnType<typeof lstatSync>,
  platform: NodeJS.Platform,
): boolean {
  return stats.isDirectory() && !stats.isSymbolicLink()
    && (platform === 'win32' || (Number(stats.mode) & 0o077) === 0)
}

function tombstoneIdentityFromStats(stats: ReturnType<typeof lstatSync>): TombstoneIdentity {
  return { dev: BigInt(stats.dev), ino: BigInt(stats.ino) }
}

function sameTombstoneIdentity(left: TombstoneIdentity, right: TombstoneIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function assertWindowsTombstoneNamespaceOwnership(
  directory: string,
  stats: ReturnType<typeof lstatSync>,
): TombstoneIdentity {
  const current = tombstoneIdentityFromStats(stats)
  const owned = ownedWindowsTombstoneNamespaces.get(directory)
  if (!owned || !sameTombstoneIdentity(owned, current)) {
    throw new Error(`atomic publication tombstone namespace is not private: ${directory}`)
  }
  return current
}

/** Node synthesizes Windows mode bits and cannot answer effective ACL rights.
 * Establish and then verify an owner-only protected DACL before a temp name is
 * trusted as the source of an atomic rename. This is deliberately synchronous
 * because writeFileAtomicSync has the same source-name security boundary. */
function secureWindowsAtomicNamespace(directory: string, establish: boolean): boolean {
  // Tests may model a Windows target on a non-Windows host; a real receipt is
  // required whenever the process can actually inspect a Windows DACL.
  if (process.platform !== 'win32') return true
  const literal = directory.replace(/'/g, "''")
  const program = [
    "$ErrorActionPreference='Stop'",
    `$p='${literal}'`,
    '$identity=[Security.Principal.WindowsIdentity]::GetCurrent()',
    '$sid=$identity.User',
    '$ownerSid=if($identity.Owner){$identity.Owner}else{$sid}',
    '$acl=Get-Acl -LiteralPath $p',
    // A process running elevated may create files owned by its token owner
    // (for example Administrators) rather than its user SID. That is still
    // this newly-created process namespace, but it must never authorize an
    // ACL repair of an already-existing namespace.
    'if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $ownerSid.Value){exit 61}',
    ...(establish ? [
      '$acl.SetAccessRuleProtection($true,$false)',
      'foreach($rule in @($acl.Access)){[void]$acl.RemoveAccessRuleAll($rule)}',
      "$rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')",
      '$acl.AddAccessRule($rule)',
      'Set-Acl -LiteralPath $p -AclObject $acl',
    ] : []),
    '$after=Get-Acl -LiteralPath $p',
    'if(-not $after.AreAccessRulesProtected -or $after.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $ownerSid.Value){exit 62}',
    '$rules=@($after.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))',
    'if($rules.Count -ne 1 -or $rules[0].IdentityReference.Value -ne $sid.Value -or $rules[0].AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or (($rules[0].FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -ne [Security.AccessControl.FileSystemRights]::FullControl)){exit 63}',
  ].join(';')
  const encoded = Buffer.from(program, 'utf16le').toString('base64')
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded,
  ], { stdio: 'ignore', windowsHide: true })
  return !result.error && result.status === 0
}

/** Create a Windows directory with its protected owner-only DACL supplied to
 * CreateDirectoryW itself. chmod/mkdir mode bits are not a security boundary
 * on Windows; repairing the inherited ACL after mkdir leaves a real exposure
 * window for a secret staging file. */
function createWindowsPrivateDirectoryAtomically(directory: string): void {
  if (process.platform !== 'win32') {
    mkdirSync(directory, { mode: 0o700 })
    return
  }
  const literal = directory.replace(/'/g, "''")
  const source = 'using System;using System.Runtime.InteropServices;public static class AtomicPrivateDirectory{[StructLayout(LayoutKind.Sequential)]public struct SA{public int nLength;public IntPtr lpSecurityDescriptor;public bool bInheritHandle;}[DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]public static extern bool CreateDirectory(string p,ref SA sa);}'
  const program = [
    `$p='${literal}'`,
    `$src='${source}'`, 'Add-Type -TypeDefinition $src',
    '$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User',
    '$acl=New-Object Security.AccessControl.DirectorySecurity', '$acl.SetOwner($sid)', '$acl.SetAccessRuleProtection($true,$false)',
    "$rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')", '$acl.AddAccessRule($rule)',
    '$bytes=$acl.GetSecurityDescriptorBinaryForm()', '$pin=[Runtime.InteropServices.GCHandle]::Alloc($bytes,[Runtime.InteropServices.GCHandleType]::Pinned)',
    'try{$sa=New-Object AtomicPrivateDirectory+SA;$sa.nLength=[Runtime.InteropServices.Marshal]::SizeOf($sa);$sa.lpSecurityDescriptor=$pin.AddrOfPinnedObject();if(-not [AtomicPrivateDirectory]::CreateDirectory($p,[ref]$sa)){exit [Runtime.InteropServices.Marshal]::GetLastWin32Error()}}finally{$pin.Free()}',
  ].join(';')
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(program, 'utf16le').toString('base64')], { stdio: 'ignore', windowsHide: true })
  if (result.error || result.status !== 0) {
    const error = new Error(`atomic publication private Windows directory creation failed: ${directory}`) as NodeJS.ErrnoException
    error.code = result.status === 183 ? 'EEXIST' : 'EACCES'
    throw error
  }
}

function ensureWindowsAuthorityDirectorySync(directory: string, deps: AtomicWriteDeps): void {
  const authorityDirectory = dirname(windowsNamespaceAuthorityPath(directory))
  try { createWindowsPrivateDirectoryAtomically(authorityDirectory) } catch (error) {
    if (getErrorCode(error) !== 'EEXIST') throw error
  }
  const stats = deps.lstatSync(authorityDirectory)
  if (!isPrivateTombstoneNamespace(stats, deps.platform) || !deps.secureWindowsNamespace(authorityDirectory, false)) {
    throw new Error(`atomic publication namespace authority directory is not private: ${authorityDirectory}`)
  }
  // Persist the parent entry before publishing a receipt that depends on a
  // key below this authority directory.
  deps.syncDirectory(dirname(authorityDirectory))
}

/** Cross-process claim for the stable authority name.  A process acquires the
 * claim before inspecting or rotating a placeholder, so a delayed initializer
 * cannot rename a key that a successor has already published. */
async function withWindowsAuthorityClaim<T>(authority: string, deps: AtomicWriteDeps, operation: () => Promise<T>): Promise<T> {
  // The lease is a directory, rather than a file renamed out of the public
  // name.  `mkdir`/`rmdir` are the no-replace handoff: while the old lease
  // directory exists no successor can be installed at its name, and after it
  // is removed a reclaimer never mutates that name again.
  const claim = `${authority}.claim`
  const lease = join(claim, 'lease.json')
  const reclaimer = join(claim, 'reclaimer.json')
  const generation = join(claim, 'generation.key')
  const generationClaim = join(claim, 'generation.claim.json')
  let claimIdentity: TombstoneIdentity | undefined
  for (let attempt = 0; attempt < ATOMIC_RENAME_MAX_ATTEMPTS; attempt += 1) {
    try {
      await deps.mkdir(claim, { mode: 0o700 })
      claimIdentity = tombstoneIdentityFromStats(deps.lstatSync(claim))
      const existingKey = readWindowsAuthorityKeySync(authority, deps)
      const generationKey = existingKey ? undefined : randomBytes(32)
      if (generationKey) {
        await writeWindowsAuthorityGenerationKeyExclusive(generation, generationKey, deps)
      }
      await writeWindowsAuthorityClaimExclusive(lease,
        authorityClaimRecord(authority, claimIdentity, 'lease', deps, generationKey), deps)
      break
    } catch (error) {
      if (getErrorCode(error) !== 'EEXIST') throw error
      try {
        const first = deps.lstatSync(claim)
        if (!first.isDirectory() || first.isSymbolicLink()) {
          await deps.sleep(deps.getRetryDelayMs(attempt)); continue
        }
        const claimProof = tombstoneIdentityFromStats(first)
        const held = readWindowsAuthorityClaimOrStagedSync(lease, authority, claimProof, deps)
        if (!held || held.record.role !== 'lease') {
          // A reclaimer can crash after consuming lease.json but before it
          // consumes its own marker.  That marker is authenticated and bound
          // to this exact directory, so an aged abandoned one may be safely
          // finished; an untrusted/missing marker remains fail-closed.
          const stranded = readWindowsAuthorityClaimOrStagedSync(reclaimer, authority, claimProof, deps)
          const electedOnly = !stranded
            ? readWindowsAuthorityClaimOrStagedSync(generationClaim, authority, claimProof, deps)
            : null
          if (electedOnly && electedOnly.record.role === 'reclaimer'
            && deps.now() - electedOnly.record.createdAt >= WINDOWS_RECLAIMER_TAKEOVER_AGE_MS
            && publisherIsVerifiablyAbandoned(electedOnly.record.owner)
            && sameFileIdentity(first, deps.lstatSync(claim))) {
            try {
              await removeWindowsAuthorityClaimStaging(claim, lease, authority, claimProof, deps)
              await removeWindowsAuthorityClaimStaging(claim, reclaimer, authority, claimProof, deps)
              await removeWindowsAuthorityClaimStaging(claim, generationClaim, authority, claimProof, deps, electedOnly)
              if (!await handoffWindowsAuthorityGenerationKey(claim, deps)) throw new Error('atomic authority generation key changed')
              if (!await removeWindowsAuthorityClaimAuthenticatedExact(generationClaim, electedOnly, authority, claimProof, deps)) throw new Error('atomic authority election changed')
              if (!await removeWindowsAuthorityRecoveryKey(claim, deps)) throw new Error('atomic authority recovery key changed')
              await fs.rmdir(claim); continue
            } catch { await deps.sleep(deps.getRetryDelayMs(attempt)); continue }
          }
          if (stranded && stranded.record.role === 'reclaimer'
            && deps.now() - stranded.record.createdAt >= WINDOWS_RECLAIMER_TAKEOVER_AGE_MS
            && publisherIsVerifiablyAbandoned(stranded.record.owner)
            && sameFileIdentity(first, deps.lstatSync(claim))) {
            // A pre-staging writer could die after creating an empty final
            // election.  Only this authenticated, abandoned reclaimer may
            // collect that exact torn inode; otherwise EEXIST would fence
            // recovery forever.
            // A malformed final election is not deletion authority.  New
            // staged elections are authenticated and recoverable; old torn
            // names remain durable debt rather than risking a live winner.
            // The old reclaimer is evidence of a crash after lease removal.
            // Elect exactly one process to finish it before unlinking any
            // controls.  `wx` on this generation-key-authenticated record is
            // the no-replace handoff; a competing observer cannot delete the
            // old paths while the elected recoverer still owns this inode.
            const ours = authorityClaimRecord(authority, claimProof, 'reclaimer', deps, stranded.signingKey)
            try {
              await writeWindowsAuthorityClaimExclusive(generationClaim, ours, deps)
              const reread = readWindowsAuthorityClaimOrStagedSync(reclaimer, authority, claimProof, deps)
              const elected = readWindowsAuthorityClaimOrStagedSync(generationClaim, authority, claimProof, deps)
              if (reread && elected && sameTombstoneIdentity(reread.identity, stranded.identity)
                && reread.record.generation === stranded.record.generation
                && publisherIsVerifiablyAbandoned(reread.record.owner)
                && sameWindowsAuthorityClaimRecord(elected.record, ours)
                && sameFileIdentity(first, deps.lstatSync(claim))) {
                // A successor can only create claim after rmdir. Every
                // pathname below is therefore still in this elected claim.
                await consumeWindowsAuthorityCollectedAliases(claim, generationClaim, authority, claimProof, deps)
                const finalLease = readWindowsAuthorityClaimOrStagedSync(lease, authority, claimProof, deps)
                if (finalLease && !await removeWindowsAuthorityClaimAuthenticatedExact(lease, finalLease, authority, claimProof, deps)) throw new Error('atomic authority lease changed')
                await removeWindowsAuthorityClaimStaging(claim, lease, authority, claimProof, deps)
                await removeWindowsAuthorityClaimStaging(claim, reclaimer, authority, claimProof, deps, reread)
                // Keep the elected recovery record visible through every
                // other cleanup transition. A crash cannot expose an empty
                // election while controls still need authentication.
                if (!await removeWindowsAuthorityClaimAuthenticatedExact(reclaimer, reread, authority, claimProof, deps)) throw new Error('atomic authority reclaimer changed')
                await removeWindowsAuthorityClaimStaging(claim, generationClaim, authority, claimProof, deps, elected)
                if (!await handoffWindowsAuthorityGenerationKey(claim, deps)) throw new Error('atomic authority generation key changed')
                if (!await removeWindowsAuthorityClaimAuthenticatedExact(generationClaim, elected, authority, claimProof, deps)) throw new Error('atomic authority election changed')
                if (!await removeWindowsAuthorityRecoveryKey(claim, deps)) throw new Error('atomic authority recovery key changed')
                await fs.rmdir(claim); continue
              }
            } catch (error) {
              if (getErrorCode(error) !== 'EEXIST') throw error
            }
            // EEXIST is an observation, never shared cleanup authority.  A
            // complete election left by a dead owner is transferred only by
            // claiming its exact inode; the next loop then publishes a new
            // exclusive election.  A live or malformed final stays fenced.
            const priorElection = readWindowsAuthorityClaimSync(generationClaim, authority, claimProof, deps)
            if (priorElection && !sameWindowsAuthorityClaimRecord(priorElection.record, ours)
              && deps.now() - priorElection.record.createdAt >= WINDOWS_RECLAIMER_TAKEOVER_AGE_MS
              && publisherIsVerifiablyAbandoned(priorElection.record.owner)
              && sameFileIdentity(first, deps.lstatSync(claim))) {
              if (!await removeWindowsAuthorityClaimAuthenticatedExact(generationClaim, priorElection, authority, claimProof, deps)) {
                throw new Error('atomic authority prior election changed')
              }
            }
          }
          // Only a genuinely empty creation fragment is harmless.  A torn or
          // forged lease/reclaimer remains evidence, never deletion authority.
          let empty = false
          try { deps.lstatSync(lease) } catch (error) {
            if (getErrorCode(error) === 'ENOENT') {
              try { deps.lstatSync(reclaimer) } catch (reclaimerError) {
                if (getErrorCode(reclaimerError) === 'ENOENT') {
                  try { deps.lstatSync(generation) } catch (generationError) { empty = getErrorCode(generationError) === 'ENOENT' }
                }
              }
            }
          }
          if (hasOnlyWindowsAuthorityBootstrapSync(claim, deps)
            && sameFileIdentity(first, deps.lstatSync(claim))) {
            try { if (removeWindowsAuthorityBootstrapsSync(claim, deps)) { await fs.rmdir(claim); continue } } catch {}
          }
          if (hasOnlyWindowsAuthorityGenerationKeysSync(claim, deps)
            && sameFileIdentity(first, deps.lstatSync(claim))) {
            try { if (await removeWindowsAuthorityGenerationKeys(claim, deps)) { await fs.rmdir(claim); continue } } catch {}
          }
          if (hasOnlyWindowsAuthorityRecoveryKeySync(claim)
            && sameFileIdentity(first, deps.lstatSync(claim))) {
            try { if (await removeWindowsAuthorityRecoveryKey(claim, deps)) { await fs.rmdir(claim); continue } } catch {}
          }
          if (empty && sameFileIdentity(first, deps.lstatSync(claim))) {
            // Final names alone do not prove emptiness: never remove a
            // staged/collected/bootstrap generation owned by an initializer.
            try { if (readdirSync(claim).length === 0) { await fs.rmdir(claim); continue } } catch {}
          }
          await deps.sleep(deps.getRetryDelayMs(attempt)); continue
        }
        const authenticated = deps.lstatSync(claim)
        if (!sameFileIdentity(first, authenticated)
          || !publisherIsVerifiablyAbandoned(held.record.owner)) {
          await deps.sleep(deps.getRetryDelayMs(attempt)); continue
        }
        // Deliberately yield at the stale-check boundary. Besides making the
        // race deterministic in tests, the reclaimer's subsequent directory
        // identity check is what prevents that pause from affecting a
        // successor.
        await deps.sleep(0)
        // `wx` elects exactly one reclaimer inside the still-present lease
        // directory. It is impossible for a successor directory to appear
        // until this reclaimer has finished and rmdir has succeeded.
        // A first-generation lease is authenticated by generation.key before
        // the authority inode exists.  Preserve that exact authentication
        // root when electing its reclaimer; falling back to authority here
        // strands a valid pre-publication crash behind an invalid placeholder.
        const ours = authorityClaimRecord(authority, claimProof, 'reclaimer', deps, held.signingKey)
        try { await writeWindowsAuthorityClaimExclusive(reclaimer, ours, deps) } catch (error) {
          if (getErrorCode(error) === 'EEXIST') {
            const stale = readWindowsAuthorityClaimOrStagedSync(reclaimer, authority, claimProof, deps)
            if (stale && stale.record.role === 'reclaimer'
              && deps.now() - stale.record.createdAt >= WINDOWS_RECLAIMER_TAKEOVER_AGE_MS
              && publisherIsVerifiablyAbandoned(stale.record.owner)) {
              const reread = readWindowsAuthorityClaimOrStagedSync(reclaimer, authority, claimProof, deps)
              if (reread && reread.identity.dev === stale.identity.dev && reread.identity.ino === stale.identity.ino
                && reread.record.generation === stale.record.generation
                && publisherIsVerifiablyAbandoned(reread.record.owner)) {
                if (!await removeWindowsAuthorityClaimAuthenticatedExact(reclaimer, reread, authority, claimProof, deps)) throw new Error('atomic authority reclaimer changed')
              }
            }
            if (!stale) {
              try {
                const leaseAgain = readWindowsAuthorityClaimSync(lease, authority, claimProof, deps)
                if (leaseAgain && sameTombstoneIdentity(leaseAgain.identity, held.identity)
                  && publisherIsVerifiablyAbandoned(leaseAgain.record.owner)
                  && sameFileIdentity(first, deps.lstatSync(claim))) {
                  // Unauthenticated final bytes are durable forensic debt,
                  // never permission to unlink a possible live successor.
                }
              } catch {}
            }
          }
          await deps.sleep(deps.getRetryDelayMs(attempt)); continue
        }
        const beforeRelease = deps.lstatSync(claim)
        const leaseBeforeRelease = readWindowsAuthorityClaimOrStagedSync(lease, authority, claimProof, deps)
        const reclaimerBeforeRelease = readWindowsAuthorityClaimOrStagedSync(reclaimer, authority, claimProof, deps)
        if (!sameFileIdentity(first, beforeRelease) || !leaseBeforeRelease || leaseBeforeRelease.record.role !== 'lease'
          || leaseBeforeRelease.record.generation !== held.record.generation || !publisherIsVerifiablyAbandoned(leaseBeforeRelease.record.owner)
          || !reclaimerBeforeRelease || reclaimerBeforeRelease.record.role !== 'reclaimer'
          || reclaimerBeforeRelease.record.generation !== ours.generation) {
          if (reclaimerBeforeRelease?.record.role === 'reclaimer'
            && reclaimerBeforeRelease.record.generation === ours.generation) {
            if (!await removeWindowsAuthorityClaimAuthenticatedExact(reclaimer, reclaimerBeforeRelease, authority, claimProof, deps)) throw new Error('atomic authority reclaimer changed')
          }
          await deps.sleep(deps.getRetryDelayMs(attempt)); continue
        }
        try {
          if (!await removeWindowsAuthorityClaimAuthenticatedExact(lease, leaseBeforeRelease, authority, claimProof, deps)) throw new Error('atomic authority lease changed')
          await removeWindowsAuthorityClaimStaging(claim, lease, authority, claimProof, deps)
          const cleanupElection = authorityClaimRecord(authority, claimProof, 'reclaimer', deps, reclaimerBeforeRelease.signingKey)
          await writeWindowsAuthorityClaimExclusive(generationClaim, cleanupElection, deps)
          const elected = readWindowsAuthorityClaimOrStagedSync(generationClaim, authority, claimProof, deps)
          if (!elected || !sameWindowsAuthorityClaimRecord(elected.record, cleanupElection)) {
            throw new Error('atomic authority cleanup election was not published')
          }
          await consumeWindowsAuthorityCollectedAliases(claim, generationClaim, authority, claimProof, deps)
          await removeWindowsAuthorityClaimStaging(claim, reclaimer, authority, claimProof, deps, reclaimerBeforeRelease)
          // The reclaimer remains the election until non-election cleanup is
          // complete, so no crash can expose an empty live claim.
          if (!await removeWindowsAuthorityClaimAuthenticatedExact(reclaimer, reclaimerBeforeRelease, authority, claimProof, deps)) throw new Error('atomic authority reclaimer changed')
          await removeWindowsAuthorityClaimStaging(claim, generationClaim, authority, claimProof, deps, electionBeforeRelease)
          const electionBeforeRelease = readWindowsAuthorityClaimOrStagedSync(generationClaim, authority, claimProof, deps)
          if (!electionBeforeRelease || !sameWindowsAuthorityClaimRecord(electionBeforeRelease.record, cleanupElection)) throw new Error('atomic authority cleanup election changed')
          if (!await handoffWindowsAuthorityGenerationKey(claim, deps)) throw new Error('atomic authority generation key changed')
          if (electionBeforeRelease && !await removeWindowsAuthorityClaimAuthenticatedExact(generationClaim, electionBeforeRelease, authority, claimProof, deps)) throw new Error('atomic authority election changed')
          if (!await removeWindowsAuthorityRecoveryKey(claim, deps)) throw new Error('atomic authority recovery key changed')
          await fs.rmdir(claim)
        } catch {
          await deps.sleep(deps.getRetryDelayMs(attempt)); continue
        }
      } catch { await deps.sleep(deps.getRetryDelayMs(attempt)) }
    }
  }
  if (!claimIdentity) throw new Error(`atomic publication authority claim is busy: ${authority}`)
  let operationError: unknown
  try { return await operation() } catch (error) {
    operationError = error
    throw error
  } finally {
    let cleanupError: unknown
    try {
      if (sameTombstoneIdentity(claimIdentity, tombstoneIdentityFromStats(deps.lstatSync(claim)))) {
        // The claimed operation has made authority durable.  Publish a
        // separate cleanup election before retiring lease.json; this keeps
        // exclusive recovery authority live through every cleanup boundary.
        const cleanupElection = authorityClaimRecord(authority, claimIdentity, 'reclaimer', deps)
        await writeWindowsAuthorityClaimExclusive(generationClaim, cleanupElection, deps)
        const elected = readWindowsAuthorityClaimOrStagedSync(generationClaim, authority, claimIdentity, deps)
        if (!elected || !sameWindowsAuthorityClaimRecord(elected.record, cleanupElection)) {
          throw new Error('atomic publication cleanup election was not published')
        }
        await consumeWindowsAuthorityCollectedAliases(claim, generationClaim, authority, claimIdentity, deps)
        const finalLease = readWindowsAuthorityClaimOrStagedSync(lease, authority, claimIdentity, deps)
        if (finalLease && !await removeWindowsAuthorityClaimAuthenticatedExact(lease, finalLease, authority, claimIdentity, deps)) throw new Error('atomic authority lease changed')
        await removeWindowsAuthorityClaimStaging(claim, reclaimer, authority, claimIdentity, deps)
        await removeWindowsAuthorityClaimStaging(claim, lease, authority, claimIdentity, deps)
        await removeWindowsAuthorityClaimStaging(claim, generationClaim, authority, claimIdentity, deps, elected)
        const finalElection = readWindowsAuthorityClaimOrStagedSync(generationClaim, authority, claimIdentity, deps)
        if (!finalElection || !sameWindowsAuthorityClaimRecord(finalElection.record, cleanupElection)) {
          throw new Error('atomic publication cleanup election changed')
        }
        if (!await handoffWindowsAuthorityGenerationKey(claim, deps)) throw new Error('atomic authority generation key changed')
        if (finalElection && !await removeWindowsAuthorityClaimAuthenticatedExact(generationClaim, finalElection, authority, claimIdentity, deps)) throw new Error('atomic authority election changed')
        if (!await removeWindowsAuthorityRecoveryKey(claim, deps)) throw new Error('atomic authority recovery key changed')
        await fs.rmdir(claim)
      }
    } catch (error) { cleanupError = error }
    if (cleanupError) {
      if (operationError) {
        throw new AggregateError([operationError, cleanupError], 'atomic publication and authority cleanup both failed')
      }
      throw cleanupError
    }
  }
}

/** The synchronous writer must participate in the same durable, cross-process
 * authority lease as the async writer.  A process-local fence cannot protect
 * a sync startup racing a second runtime. */
function withWindowsAuthorityClaimSync<T>(authority: string, deps: AtomicWriteDeps, operation: () => T): T {
  const claim = `${authority}.claim`
  const lease = join(claim, 'lease.json')
  const reclaimer = join(claim, 'reclaimer.json')
  const generation = join(claim, 'generation.key')
  const generationClaim = join(claim, 'generation.claim.json')
  let claimIdentity: TombstoneIdentity | undefined
  for (let attempt = 0; attempt < ATOMIC_RENAME_MAX_ATTEMPTS; attempt += 1) {
    try {
      mkdirSync(claim, { mode: 0o700 })
      claimIdentity = tombstoneIdentityFromStats(deps.lstatSync(claim))
      const existingKey = readWindowsAuthorityKeySync(authority, deps)
      const generationKey = existingKey ? undefined : randomBytes(32)
      if (generationKey) {
        writeWindowsAuthorityGenerationKeyExclusiveSync(generation, generationKey, deps)
      }
      writeWindowsAuthorityClaimExclusiveSync(lease,
        authorityClaimRecord(authority, claimIdentity, 'lease', deps, generationKey), deps)
      break
    } catch (error) {
      if (getErrorCode(error) !== 'EEXIST') throw error
      try {
        const first = deps.lstatSync(claim)
        if (!first.isDirectory() || first.isSymbolicLink()) {
          deps.sleepSync(deps.getRetryDelayMs(attempt)); continue
        }
        const claimProof = tombstoneIdentityFromStats(first)
        const held = readWindowsAuthorityClaimOrStagedSync(lease, authority, claimProof, deps)
        if (!held || held.record.role !== 'lease') {
          const stranded = readWindowsAuthorityClaimOrStagedSync(reclaimer, authority, claimProof, deps)
          const electedOnly = !stranded
            ? readWindowsAuthorityClaimOrStagedSync(generationClaim, authority, claimProof, deps)
            : null
          if (electedOnly && electedOnly.record.role === 'reclaimer'
            && deps.now() - electedOnly.record.createdAt >= WINDOWS_RECLAIMER_TAKEOVER_AGE_MS
            && publisherIsVerifiablyAbandoned(electedOnly.record.owner)
            && sameFileIdentity(first, deps.lstatSync(claim))) {
            try {
              removeWindowsAuthorityClaimStagingSync(claim, lease, authority, claimProof, deps)
              removeWindowsAuthorityClaimStagingSync(claim, reclaimer, authority, claimProof, deps)
              removeWindowsAuthorityClaimStagingSync(claim, generationClaim, authority, claimProof, deps)
              if (!handoffWindowsAuthorityGenerationKeySync(claim, deps)) throw new Error('atomic authority generation key changed')
              if (!removeWindowsAuthorityClaimAuthenticatedExactSync(generationClaim, electedOnly, authority, claimProof, deps)) throw new Error('atomic authority election changed')
              if (!removeWindowsAuthorityRecoveryKeySync(claim, deps)) throw new Error('atomic authority recovery key changed')
              deps.rmdirSync(claim); continue
            } catch { deps.sleepSync(deps.getRetryDelayMs(attempt)); continue }
          }
          if (stranded && stranded.record.role === 'reclaimer'
            && deps.now() - stranded.record.createdAt >= WINDOWS_RECLAIMER_TAKEOVER_AGE_MS
            && publisherIsVerifiablyAbandoned(stranded.record.owner)
            && sameFileIdentity(first, deps.lstatSync(claim))) {
            // Keep malformed final election bytes as durable debt; only an
            // authenticated exact generation may be transferred or deleted.
            const ours = authorityClaimRecord(authority, claimProof, 'reclaimer', deps, stranded.signingKey)
            try {
              writeWindowsAuthorityClaimExclusiveSync(generationClaim, ours, deps)
              const reread = readWindowsAuthorityClaimOrStagedSync(reclaimer, authority, claimProof, deps)
              const elected = readWindowsAuthorityClaimOrStagedSync(generationClaim, authority, claimProof, deps)
              if (reread && elected && sameTombstoneIdentity(reread.identity, stranded.identity)
                && reread.record.generation === stranded.record.generation
                && publisherIsVerifiablyAbandoned(reread.record.owner)
                && sameWindowsAuthorityClaimRecord(elected.record, ours)
                && sameFileIdentity(first, deps.lstatSync(claim))) {
                removeWindowsAuthorityClaimStagingSync(claim, lease, authority, claimProof, deps)
                const finalLease = readWindowsAuthorityClaimOrStagedSync(lease, authority, claimProof, deps)
                if (finalLease && !removeWindowsAuthorityClaimAuthenticatedExactSync(lease, finalLease, authority, claimProof, deps)) throw new Error('atomic authority lease changed')
                removeWindowsAuthorityClaimStagingSync(claim, reclaimer, authority, claimProof, deps)
                if (!removeWindowsAuthorityClaimAuthenticatedExactSync(reclaimer, reread, authority, claimProof, deps)) throw new Error('atomic authority reclaimer changed')
                removeWindowsAuthorityClaimStagingSync(claim, generationClaim, authority, claimProof, deps)
                if (!handoffWindowsAuthorityGenerationKeySync(claim, deps)) throw new Error('atomic authority generation key changed')
                if (!removeWindowsAuthorityClaimAuthenticatedExactSync(generationClaim, elected, authority, claimProof, deps)) throw new Error('atomic authority election changed')
                if (!removeWindowsAuthorityRecoveryKeySync(claim, deps)) throw new Error('atomic authority recovery key changed')
                deps.rmdirSync(claim); continue
              }
            } catch (error) {
              if (getErrorCode(error) !== 'EEXIST') throw error
            }
            const priorElection = readWindowsAuthorityClaimSync(generationClaim, authority, claimProof, deps)
            if (priorElection && !sameWindowsAuthorityClaimRecord(priorElection.record, ours)
              && deps.now() - priorElection.record.createdAt >= WINDOWS_RECLAIMER_TAKEOVER_AGE_MS
              && publisherIsVerifiablyAbandoned(priorElection.record.owner)
              && sameFileIdentity(first, deps.lstatSync(claim))) {
              if (!removeWindowsAuthorityClaimAuthenticatedExactSync(generationClaim, priorElection, authority, claimProof, deps)) {
                throw new Error('atomic authority prior election changed')
              }
            }
          }
          let empty = false
          try { deps.lstatSync(lease) } catch (error) {
            if (getErrorCode(error) === 'ENOENT') {
              try { deps.lstatSync(reclaimer) } catch (reclaimerError) {
                if (getErrorCode(reclaimerError) === 'ENOENT') {
                  try { deps.lstatSync(generation) } catch (generationError) { empty = getErrorCode(generationError) === 'ENOENT' }
                }
              }
            }
          }
          if (hasOnlyWindowsAuthorityBootstrapSync(claim, deps)
            && sameFileIdentity(first, deps.lstatSync(claim))) {
            try { if (removeWindowsAuthorityBootstrapsSync(claim, deps)) { rmdirSync(claim); continue } } catch {}
          }
          if (hasOnlyWindowsAuthorityGenerationKeysSync(claim, deps)
            && sameFileIdentity(first, deps.lstatSync(claim))) {
            try { if (removeWindowsAuthorityGenerationKeysSync(claim, deps)) { deps.rmdirSync(claim); continue } } catch {}
          }
          if (hasOnlyWindowsAuthorityRecoveryKeySync(claim)
            && sameFileIdentity(first, deps.lstatSync(claim))) {
            try { if (removeWindowsAuthorityRecoveryKeySync(claim, deps)) { deps.rmdirSync(claim); continue } } catch {}
          }
          if (empty && sameFileIdentity(first, deps.lstatSync(claim))) {
            try { if (readdirSync(claim).length === 0) { deps.rmdirSync(claim); continue } } catch {}
          }
          deps.sleepSync(deps.getRetryDelayMs(attempt)); continue
        }
        const authenticated = deps.lstatSync(claim)
        if (!sameFileIdentity(first, authenticated)
          || !publisherIsVerifiablyAbandoned(held.record.owner)) {
          deps.sleepSync(deps.getRetryDelayMs(attempt)); continue
        }
        deps.sleepSync(0)
        const ours = authorityClaimRecord(authority, claimProof, 'reclaimer', deps, held.signingKey)
        try { writeWindowsAuthorityClaimExclusiveSync(reclaimer, ours, deps) } catch (error) {
          if (getErrorCode(error) === 'EEXIST') {
            const stale = readWindowsAuthorityClaimOrStagedSync(reclaimer, authority, claimProof, deps)
            if (stale && stale.record.role === 'reclaimer'
              && deps.now() - stale.record.createdAt >= WINDOWS_RECLAIMER_TAKEOVER_AGE_MS
              && publisherIsVerifiablyAbandoned(stale.record.owner)) {
              const reread = readWindowsAuthorityClaimOrStagedSync(reclaimer, authority, claimProof, deps)
              if (reread && sameTombstoneIdentity(reread.identity, stale.identity)
                && reread.record.generation === stale.record.generation
                && publisherIsVerifiablyAbandoned(reread.record.owner)) {
                if (!removeWindowsAuthorityClaimAuthenticatedExactSync(reclaimer, reread, authority, claimProof, deps)) throw new Error('atomic authority reclaimer changed')
              }
            }
            if (!stale) {
              try {
                const leaseAgain = readWindowsAuthorityClaimSync(lease, authority, claimProof, deps)
                if (leaseAgain && sameTombstoneIdentity(leaseAgain.identity, held.identity)
                  && publisherIsVerifiablyAbandoned(leaseAgain.record.owner)
                  && sameFileIdentity(first, deps.lstatSync(claim))) {
                  // Unauthenticated final bytes remain recovery evidence.
                }
              } catch {}
            }
          }
          deps.sleepSync(deps.getRetryDelayMs(attempt)); continue
        }
        const beforeRelease = deps.lstatSync(claim)
        const leaseBeforeRelease = readWindowsAuthorityClaimOrStagedSync(lease, authority, claimProof, deps)
        const reclaimerBeforeRelease = readWindowsAuthorityClaimOrStagedSync(reclaimer, authority, claimProof, deps)
        if (!sameFileIdentity(first, beforeRelease) || !leaseBeforeRelease || leaseBeforeRelease.record.role !== 'lease'
          || leaseBeforeRelease.record.generation !== held.record.generation || !publisherIsVerifiablyAbandoned(leaseBeforeRelease.record.owner)
          || !reclaimerBeforeRelease || reclaimerBeforeRelease.record.role !== 'reclaimer'
          || reclaimerBeforeRelease.record.generation !== ours.generation) {
          if (reclaimerBeforeRelease?.record.role === 'reclaimer'
            && reclaimerBeforeRelease.record.generation === ours.generation) {
            if (!removeWindowsAuthorityClaimAuthenticatedExactSync(reclaimer, reclaimerBeforeRelease, authority, claimProof, deps)) throw new Error('atomic authority reclaimer changed')
          }
          deps.sleepSync(deps.getRetryDelayMs(attempt)); continue
        }
        try {
          removeWindowsAuthorityClaimStagingSync(claim, lease, authority, claimProof, deps)
          if (!removeWindowsAuthorityClaimAuthenticatedExactSync(lease, leaseBeforeRelease, authority, claimProof, deps)) throw new Error('atomic authority lease changed')
          const cleanupElection = authorityClaimRecord(authority, claimProof, 'reclaimer', deps, reclaimerBeforeRelease.signingKey)
          writeWindowsAuthorityClaimExclusiveSync(generationClaim, cleanupElection, deps)
          const elected = readWindowsAuthorityClaimOrStagedSync(generationClaim, authority, claimProof, deps)
          if (!elected || !sameWindowsAuthorityClaimRecord(elected.record, cleanupElection)) {
            throw new Error('atomic authority cleanup election was not published')
          }
          consumeWindowsAuthorityCollectedAliasesSync(claim, generationClaim, authority, claimProof, deps)
          removeWindowsAuthorityClaimStagingSync(claim, reclaimer, authority, claimProof, deps)
          if (!removeWindowsAuthorityClaimAuthenticatedExactSync(reclaimer, reclaimerBeforeRelease, authority, claimProof, deps)) throw new Error('atomic authority reclaimer changed')
          removeWindowsAuthorityClaimStagingSync(claim, generationClaim, authority, claimProof, deps)
          const electionBeforeRelease = readWindowsAuthorityClaimOrStagedSync(generationClaim, authority, claimProof, deps)
          if (!electionBeforeRelease || !sameWindowsAuthorityClaimRecord(electionBeforeRelease.record, cleanupElection)) throw new Error('atomic authority cleanup election changed')
          if (!handoffWindowsAuthorityGenerationKeySync(claim, deps)) throw new Error('atomic authority generation key changed')
          if (electionBeforeRelease && !removeWindowsAuthorityClaimAuthenticatedExactSync(generationClaim, electionBeforeRelease, authority, claimProof, deps)) throw new Error('atomic authority election changed')
          if (!removeWindowsAuthorityRecoveryKeySync(claim, deps)) throw new Error('atomic authority recovery key changed')
          deps.rmdirSync(claim)
        } catch { deps.sleepSync(deps.getRetryDelayMs(attempt)); continue }
      } catch { deps.sleepSync(deps.getRetryDelayMs(attempt)) }
    }
  }
  if (!claimIdentity) throw new Error(`atomic publication authority claim is busy: ${authority}`)
  let operationError: unknown
  try { return operation() } catch (error) {
    operationError = error
    throw error
  } finally {
    let cleanupError: unknown
    try {
      if (sameTombstoneIdentity(claimIdentity, tombstoneIdentityFromStats(deps.lstatSync(claim)))) {
        const cleanupElection = authorityClaimRecord(authority, claimIdentity, 'reclaimer', deps)
        writeWindowsAuthorityClaimExclusiveSync(generationClaim, cleanupElection, deps)
        const elected = readWindowsAuthorityClaimOrStagedSync(generationClaim, authority, claimIdentity, deps)
        if (!elected || !sameWindowsAuthorityClaimRecord(elected.record, cleanupElection)) {
          throw new Error('atomic publication cleanup election was not published')
        }
        consumeWindowsAuthorityCollectedAliasesSync(claim, generationClaim, authority, claimIdentity, deps)
        const finalLease = readWindowsAuthorityClaimOrStagedSync(lease, authority, claimIdentity, deps)
        if (finalLease && !removeWindowsAuthorityClaimAuthenticatedExactSync(lease, finalLease, authority, claimIdentity, deps)) throw new Error('atomic authority lease changed')
        removeWindowsAuthorityClaimStagingSync(claim, reclaimer, authority, claimIdentity, deps)
        removeWindowsAuthorityClaimStagingSync(claim, lease, authority, claimIdentity, deps)
        removeWindowsAuthorityClaimStagingSync(claim, generationClaim, authority, claimIdentity, deps)
        const finalElection = readWindowsAuthorityClaimOrStagedSync(generationClaim, authority, claimIdentity, deps)
        if (!finalElection || !sameWindowsAuthorityClaimRecord(finalElection.record, cleanupElection)) {
          throw new Error('atomic publication cleanup election changed')
        }
        if (!handoffWindowsAuthorityGenerationKeySync(claim, deps)) throw new Error('atomic authority generation key changed')
        if (finalElection && !removeWindowsAuthorityClaimAuthenticatedExactSync(generationClaim, finalElection, authority, claimIdentity, deps)) throw new Error('atomic authority election changed')
        if (!removeWindowsAuthorityRecoveryKeySync(claim, deps)) throw new Error('atomic authority recovery key changed')
        deps.rmdirSync(claim)
      }
    } catch (error) { cleanupError = error }
    if (cleanupError) {
      if (operationError) {
        throw new AggregateError([operationError, cleanupError], 'atomic publication and authority cleanup both failed')
      }
      throw cleanupError
    }
  }
}

/**
 * The tombstone directory is a namespace owned by this process/user (0700).
 * It protects the source name between fstat and rename. Node exposes no
 * renameat-by-descriptor primitive, so publishing from a shared directory
 * could otherwise only establish a racy stat-then-rename claim.
 */
async function ensureTombstoneNamespace(destination: string, deps: AtomicWriteDeps): Promise<string> {
  const parent = tombstoneDirectoryFor(destination)
  if (deps.platform === 'win32') return ensureWindowsTombstoneNamespace(destination, deps)
  const directory = parent
  let created = false
  try {
    // The destination parent is established before this helper runs. A
    // non-recursive create gives the DACL setup a real provenance boundary:
    // only this call may establish a new Windows namespace.
    await deps.mkdir(directory, { mode: 0o700 })
    created = true
  } catch (error) {
    if (getErrorCode(error) !== 'EEXIST') throw error
  }
  const initialStats = deps.lstatSync(directory)
  if (!isPrivateTombstoneNamespace(initialStats, deps.platform)) {
    throw new Error(`atomic publication tombstone namespace is not private: ${directory}`)
  }
  if (deps.platform === 'win32') {
    // A DACL from a prior run is not a provenance receipt.  Only the mkdir
    // winner may establish permissions; subsequent use is limited to the
    // exact identity that winner recorded after the DACL verification.
    if (!created) assertWindowsTombstoneNamespaceOwnership(directory, initialStats)
    if (!deps.secureWindowsNamespace(directory, created)) {
      throw new Error(`atomic publication tombstone namespace is not private: ${directory}`)
    }
  }
  const stats = deps.lstatSync(directory)
  if (!isPrivateTombstoneNamespace(stats, deps.platform)) {
    throw new Error(`atomic publication tombstone namespace is not private: ${directory}`)
  }
  if (deps.platform === 'win32') {
    const verified = tombstoneIdentityFromStats(stats)
    if (created) {
      // Do not register a substituted/recreated path merely because its DACL
      // looks private after setup.
      if (!sameTombstoneIdentity(tombstoneIdentityFromStats(initialStats), verified)) {
        throw new Error(`atomic publication tombstone namespace is not private: ${directory}`)
      }
      ownedWindowsTombstoneNamespaces.set(directory, verified)
    } else {
      assertWindowsTombstoneNamespaceOwnership(directory, stats)
    }
  }
  return directory
}

/** Create the protected run namespace directly beneath the destination.
 * There is deliberately no stable mkdir-then-ACL parent: a crash before ACL
 * establishment therefore leaves only a disposable run attempt, never an
 * attacker-adoptable container for later source names. */
async function ensureWindowsTombstoneNamespace(destination: string, deps: AtomicWriteDeps): Promise<string> {
  const requestedDirectory = windowsRunNamespacePath(destination, deps)
  try {
    if (process.platform === 'win32') createWindowsPrivateDirectoryAtomically(requestedDirectory)
    else await deps.mkdir(requestedDirectory, { mode: 0o700 })
  } catch (error) {
    if (getErrorCode(error) === 'EEXIST') {
      throw new Error(`atomic publication tombstone namespace is not private: ${requestedDirectory}`)
    }
    throw error
  }
  const initial = deps.lstatSync(requestedDirectory)
  let directory = requestedDirectory
  try {
    if (!isPrivateTombstoneNamespace(initial, deps.platform)
      || !deps.secureWindowsNamespace(requestedDirectory, false)) {
      throw new Error(`atomic publication tombstone namespace is not private: ${requestedDirectory}`)
    }
    const verified = deps.lstatSync(requestedDirectory)
    const identity = tombstoneIdentityFromStats(verified)
    if (!isPrivateTombstoneNamespace(verified, deps.platform)
      || !sameTombstoneIdentity(tombstoneIdentityFromStats(initial), identity)) {
      throw new Error(`atomic publication tombstone namespace is not private: ${requestedDirectory}`)
    }
    const pendingDirectory = `${requestedDirectory}.pending.d${identity.dev}.i${identity.ino}`
    // Keep the original exclusive-creation pathname as cleanup authority
    // until its rename has actually completed.
    deps.renameSync(requestedDirectory, pendingDirectory)
    directory = pendingDirectory
    await establishWindowsNamespaceAuthority(directory, deps)
    await writeWindowsNamespaceReceipt(directory, identity, destination, deps,
      { pid: process.pid, instance: processInstanceSync(process.pid), active: true }, 'pending')
    await writeWindowsNamespaceReceipt(directory, identity, destination, deps,
      { pid: process.pid, instance: processInstanceSync(process.pid), active: true }, 'active')
    ownedWindowsTombstoneNamespaces.set(directory, identity)
    return directory
  } catch (error) {
    try {
      const current = deps.lstatSync(directory)
      if (current.isDirectory() && !current.isSymbolicLink()
        && sameTombstoneIdentity(tombstoneIdentityFromStats(initial), tombstoneIdentityFromStats(current))) {
        const entries = readdirSync(directory)
        if (entries.every(isWindowsNamespaceControlEntry)) {
          for (const entry of entries) {
            const control = join(directory, entry)
            if (removeExactTombstoneSync(control, tombstoneIdentityFromStats(deps.lstatSync(control)), deps) !== 'removed') break
          }
          deps.rmdirSync(directory)
        }
      }
    } catch {}
    throw error
  }
}

function isWindowsNamespaceControlEntry(entry: string): boolean {
  return entry === WINDOWS_NAMESPACE_RECEIPT
    || entry.startsWith(`${WINDOWS_NAMESPACE_RECEIPT}.staged.`)
    || entry.startsWith(`${WINDOWS_NAMESPACE_RECEIPT}.collected.`)
}

// A crash after hard-link publication but before staged-name cleanup leaves
// the valid authority key at nlink=2. Recover only a staged name proven to be
// that exact inode; a generic two-link key is never rotated or adopted.
function recoverWindowsAuthorityStagingSync(authority: string, deps: AtomicWriteDeps): void {
  let published: ReturnType<typeof deps.lstatSync>
  try { published = deps.lstatSync(authority) } catch (error) {
    // A missing key is the ordinary first-publication state. It must reach
    // staged exclusive creation rather than be treated as a failed restart.
    if (getErrorCode(error) === 'ENOENT') return
    throw error
  }
  if (!published.isFile() || published.isSymbolicLink() || BigInt(published.size) !== 32n || BigInt(published.nlink) !== 2n) return
  for (const name of readdirSync(dirname(authority)).filter(name => name.startsWith(`${basename(authority)}.staged.`))) {
    const staged = join(dirname(authority), name)
    try {
      const observed = deps.lstatSync(staged)
      if (observed.isFile() && !observed.isSymbolicLink()
        && sameFileIdentity(observed, published)
        && removeExactTombstoneSync(staged, tombstoneIdentityFromStats(observed), deps) === 'removed') return
    } catch {}
  }
}

/** The key is anchored beside (not inside) each disposable namespace.  An
 * exclusive create plus protected DACL and nlink check make it independent
 * authority for restart recovery. */
async function establishWindowsNamespaceAuthority(directory: string, deps: AtomicWriteDeps): Promise<void> {
  const authority = windowsNamespaceAuthorityPath(directory)
  ensureWindowsAuthorityDirectorySync(directory, deps)
  await withWindowsAuthorityFence(authority, () => withWindowsAuthorityClaim(authority, deps, async () => {
    const validate = (): boolean => {
      try {
        const current = deps.lstatSync(authority)
        return current.isFile() && !current.isSymbolicLink() && BigInt(current.size) === 32n
          && BigInt(current.nlink) === 1n && deps.secureWindowsNamespace(authority, false)
      } catch { return false }
    }
    if (!validate()) recoverWindowsAuthorityStagingSync(authority, deps)
    if (!validate()) {
      // A pre-ACL placeholder is never a secret container. Claim its old
      // inode away from the authority name and leave it as collection debt;
      // an inherited handle can consequently never observe the new key.
      try {
        const old = deps.lstatSync(authority)
        if (old.isFile() && !old.isSymbolicLink() && BigInt(old.size) < 32n) {
          deps.renameSync(authority, `${authority}.collected.${deps.randomId()}`)
        } else if (old.isFile() && !old.isSymbolicLink()) {
          throw new Error(`atomic publication tombstone namespace authority is invalid: ${authority}`)
        }
      } catch (error) { if (getErrorCode(error) !== 'ENOENT') throw error }
      const staged = `${authority}.staged.${deps.randomId()}`
      await deps.writeFile(staged, '', { mode: 0o600, flag: 'wx' })
      const initial = deps.lstatSync(staged)
      if (!initial.isFile() || initial.isSymbolicLink() || !deps.secureWindowsNamespace(staged, true)) {
        throw new Error(`atomic publication tombstone namespace authority staging is invalid: ${staged}`)
      }
      const protectedInitial = deps.lstatSync(staged)
      if (!sameFileIdentity(initial, protectedInitial) || !protectedInitial.isFile() || protectedInitial.isSymbolicLink()) {
        throw new Error(`atomic publication tombstone namespace authority staging was replaced: ${staged}`)
      }
      const handle = await deps.open(staged, 'r+')
      try {
        if (!sameFileIdentity(await handle.stat({ bigint: true }), protectedInitial)) throw new Error(`atomic publication tombstone namespace authority staging was replaced: ${staged}`)
        await handle.writeFile(randomBytes(32)); await handle.sync()
      } finally { await handle.close().catch(() => undefined) }
      try { await deps.link(staged, authority) } catch (error) {
        if (getErrorCode(error) !== 'EEXIST') throw error
      }
      // Linking creates nlink=2. Validate the winner's inode first, then
      // remove only our staging name; the published authority's nlink=1
      // invariant applies after that cleanup, not during initialization.
      const publishedBeforeCleanup = deps.lstatSync(authority)
      if (sameFileIdentity(publishedBeforeCleanup, protectedInitial)) {
        if (removeExactTombstoneSync(staged, tombstoneIdentityFromStats(protectedInitial), deps) !== 'removed') {
          throw new Error(`atomic publication tombstone namespace authority staging could not be removed: ${staged}`)
        }
      } else {
        if (removeExactTombstoneSync(staged, tombstoneIdentityFromStats(protectedInitial), deps) !== 'removed') {
          throw new Error(`atomic publication tombstone namespace authority staging changed: ${staged}`)
        }
      }
      if (!validate()) throw new Error(`atomic publication tombstone namespace authority is invalid: ${authority}`)
    }
    const published = deps.lstatSync(authority)
    if (!published.isFile() || published.isSymbolicLink() || BigInt(published.size) !== 32n || BigInt(published.nlink) !== 1n
      || !deps.secureWindowsNamespace(authority, false)) throw new Error(`atomic publication tombstone namespace authority is invalid: ${authority}`)
    deps.syncDirectory(dirname(authority))
  }))
}

function establishWindowsNamespaceAuthoritySync(directory: string, deps: AtomicWriteDeps): void {
  const authority = windowsNamespaceAuthorityPath(directory)
  ensureWindowsAuthorityDirectorySync(directory, deps)
  withWindowsAuthorityClaimSync(authority, deps, () => establishWindowsNamespaceAuthoritySyncClaimed(directory, deps))
}

function establishWindowsNamespaceAuthoritySyncClaimed(directory: string, deps: AtomicWriteDeps): void {
  const authority = windowsNamespaceAuthorityPath(directory)
  const validate = (): boolean => {
    try {
      const current = deps.lstatSync(authority)
      return current.isFile() && !current.isSymbolicLink() && BigInt(current.size) === 32n
        && BigInt(current.nlink) === 1n && deps.secureWindowsNamespace(authority, false)
    } catch { return false }
  }
  if (!validate()) recoverWindowsAuthorityStagingSync(authority, deps)
  if (!validate()) {
    try {
      const old = deps.lstatSync(authority)
      if (old.isFile() && !old.isSymbolicLink() && BigInt(old.size) < 32n) {
        deps.renameSync(authority, `${authority}.collected.${deps.randomId()}`)
      } else if (old.isFile() && !old.isSymbolicLink()) throw new Error(`atomic publication tombstone namespace authority is invalid: ${authority}`)
    } catch (error) { if (getErrorCode(error) !== 'ENOENT') throw error }
    const staged = `${authority}.staged.${deps.randomId()}`
    writeFileSync(staged, '', { mode: 0o600, flag: 'wx' })
    const initial = deps.lstatSync(staged)
    if (!initial.isFile() || initial.isSymbolicLink() || !deps.secureWindowsNamespace(staged, true)) {
      throw new Error(`atomic publication tombstone namespace authority staging is invalid: ${staged}`)
    }
    const protectedInitial = deps.lstatSync(staged)
    if (!sameFileIdentity(initial, protectedInitial)) throw new Error(`atomic publication tombstone namespace authority staging was replaced: ${staged}`)
    const fd = openSync(staged, 'r+')
    try {
      if (!sameFileIdentity(fstatSync(fd, { bigint: true }), protectedInitial)) throw new Error(`atomic publication tombstone namespace authority staging was replaced: ${staged}`)
      writeSync(fd, randomBytes(32), 0, 32, 0); fsyncSync(fd)
    } finally { deps.closeSync(fd) }
    try { linkSync(staged, authority) } catch (error) { if (getErrorCode(error) !== 'EEXIST') throw error }
    const publishedBeforeCleanup = deps.lstatSync(authority)
    if (sameFileIdentity(publishedBeforeCleanup, protectedInitial)) {
      if (removeExactTombstoneSync(staged, tombstoneIdentityFromStats(protectedInitial), deps) !== 'removed') {
        throw new Error(`atomic publication tombstone namespace authority staging could not be removed: ${staged}`)
      }
    } else {
      if (removeExactTombstoneSync(staged, tombstoneIdentityFromStats(protectedInitial), deps) !== 'removed') {
        throw new Error(`atomic publication tombstone namespace authority staging changed: ${staged}`)
      }
    }
    if (!validate()) throw new Error(`atomic publication tombstone namespace authority is invalid: ${authority}`)
  }
  const published = deps.lstatSync(authority)
  if (!published.isFile() || published.isSymbolicLink() || BigInt(published.size) !== 32n || BigInt(published.nlink) !== 1n
    || !deps.secureWindowsNamespace(authority, false)) throw new Error(`atomic publication tombstone namespace authority is invalid: ${authority}`)
  deps.syncDirectory(dirname(authority))
}

async function writeWindowsNamespaceReceipt(
  directory: string, identity: TombstoneIdentity, target: string, deps: AtomicWriteDeps,
  owner: ProcessInstanceOwner = { pid: process.pid, instance: processInstanceSync(process.pid), active: true },
  phase: WindowsNamespaceReceipt['phase'] = owner.active ? 'active' : 'inactive',
): Promise<void> {
  const receipt = windowsNamespaceReceiptPath(directory)
  const run = windowsNamespaceRunFromPath(directory)
  if (!run) throw new Error(`atomic publication tombstone namespace is not private: ${directory}`)
  // `active:false` is a recovery lease transition.  Replacing its receipt
  // atomically means an interruption retains the old active lease instead of
  // manufacturing a malformed receipt that looks like abandoned provenance.
  const staged = `${receipt}.staged.${deps.randomId()}`
  const unsigned = {
    format: WINDOWS_NAMESPACE_RECEIPT_FORMAT, target, run,
    owner,
    namespace: { dev: identity.dev.toString(), ino: identity.ino.toString() },
    phase,
  } satisfies Omit<WindowsNamespaceReceipt, 'authorityMac'>
  const authority = deps.readFileSync(windowsNamespaceAuthorityPath(directory))
  if (authority.length !== 32) throw new Error(`atomic publication tombstone namespace authority is invalid: ${directory}`)
  await deps.writeFile(staged, JSON.stringify({
    ...unsigned,
    authorityMac: windowsNamespaceMac(authority, unsigned),
  } satisfies WindowsNamespaceReceipt), { mode: 0o600 })
  const handle = await deps.open(staged, 'r+')
  try { await handle.sync() } finally { await handle.close().catch(() => undefined) }
  deps.renameSync(staged, receipt)
  deps.syncDirectory(dirname(directory))
}

function writeWindowsNamespaceReceiptSync(
  directory: string, identity: TombstoneIdentity, target: string, deps: AtomicWriteDeps,
  owner: ProcessInstanceOwner,
  phase: WindowsNamespaceReceipt['phase'] = owner.active ? 'active' : 'inactive',
): void {
  const receipt = windowsNamespaceReceiptPath(directory)
  const run = windowsNamespaceRunFromPath(directory)
  if (!run) throw new Error(`atomic publication tombstone namespace is not private: ${directory}`)
  const staged = `${receipt}.staged.${deps.randomId()}`
  const unsigned = {
    format: WINDOWS_NAMESPACE_RECEIPT_FORMAT, target, run, owner, phase,
    namespace: { dev: identity.dev.toString(), ino: identity.ino.toString() },
  } satisfies Omit<WindowsNamespaceReceipt, 'authorityMac'>
  const authority = deps.readFileSync(windowsNamespaceAuthorityPath(directory))
  if (authority.length !== 32) throw new Error(`atomic publication tombstone namespace authority is invalid: ${directory}`)
  writeFileSync(staged, JSON.stringify({
    ...unsigned,
    authorityMac: windowsNamespaceMac(authority, unsigned),
  } satisfies WindowsNamespaceReceipt), { mode: 0o600 })
  const fd = openSync(staged, 'r+')
  try { fsyncSync(fd) } finally { deps.closeSync(fd) }
  deps.renameSync(staged, receipt)
  deps.syncDirectory(dirname(directory))
}

function hasWindowsNamespaceReceipt(directory: string, identity: TombstoneIdentity, target: string, deps: AtomicWriteDeps): boolean {
  try {
    const receiptPath = windowsNamespaceReceiptPathForRecovery(directory, deps)
    if (!receiptPath) return false
    const stats = deps.lstatSync(receiptPath)
    if (!stats.isFile() || stats.isSymbolicLink()) return false
    const parsed = JSON.parse(deps.readFileSync(receiptPath, 'utf8')) as Partial<WindowsNamespaceReceipt>
    const expectedOwner = windowsNamespaceOwnerFromPath(directory)
    const owner = parsed.owner
    return parsed.format === WINDOWS_NAMESPACE_RECEIPT_FORMAT && parsed.target === target
      && parsed.run === windowsNamespaceRunFromPath(directory)
      && !!expectedOwner && !!owner && Number.isSafeInteger(owner.pid) && owner.pid > 0
      && (typeof owner.instance === 'string' || owner.instance === null) && typeof owner.active === 'boolean'
      && owner.pid === expectedOwner.pid && owner.instance === expectedOwner.instance
      && typeof parsed.namespace?.dev === 'string' && typeof parsed.namespace?.ino === 'string'
      && BigInt(parsed.namespace.dev) === identity.dev && BigInt(parsed.namespace.ino) === identity.ino
      && hasValidWindowsNamespaceMac(directory, parsed as WindowsNamespaceReceipt, deps)
  } catch { return false }
}

/** Recover the one durable namespace-receipt generation that may survive a
 * crash between staged sync and final publication. A valid final receipt is
 * never clobbered. A torn final is first claimed into retained forensic debt,
 * then the MAC-valid staged generation is linked into the public name. */
function recoverWindowsNamespaceReceiptStagingSync(
  directory: string, identity: TombstoneIdentity, target: string, deps: AtomicWriteDeps,
): boolean {
  const finalReceipt = windowsNamespaceReceiptPath(directory)
  let staged: string[]
  try { staged = readdirSync(directory).filter(entry => entry.startsWith(`${WINDOWS_NAMESPACE_RECEIPT}.staged.`)) } catch { return false }
  if (staged.length !== 1 || !deps.secureWindowsNamespace(directory, false)) return false
  const stagedPath = join(directory, staged[0])
  try {
    const stagedStats = deps.lstatSync(stagedPath)
    const parsed = JSON.parse(deps.readFileSync(stagedPath, 'utf8')) as WindowsNamespaceReceipt
    const expectedOwner = windowsNamespaceOwnerFromPath(directory)
    if (!stagedStats.isFile() || stagedStats.isSymbolicLink() || !expectedOwner
      || parsed.format !== WINDOWS_NAMESPACE_RECEIPT_FORMAT || parsed.target !== target
      || parsed.run !== windowsNamespaceRunFromPath(directory)
      || parsed.owner?.pid !== expectedOwner.pid || parsed.owner?.instance !== expectedOwner.instance
      || parsed.namespace?.dev !== identity.dev.toString() || parsed.namespace?.ino !== identity.ino.toString()
      || !hasValidWindowsNamespaceMac(directory, parsed, deps)
      // A complete staged generation is still a live publisher's receipt
      // until that exact process incarnation has stopped.
      || !publisherIsVerifiablyAbandoned({ ...expectedOwner, active: true })) return false
    try {
      const torn = deps.lstatSync(finalReceipt)
      // A complete authentic final is a successor and must win. A malformed
      // final cannot become permanent authority over the staged generation.
      if (hasWindowsNamespaceReceipt(directory, identity, target, deps)
        || !torn.isFile() || torn.isSymbolicLink()) return false
      const beforeClaim = deps.lstatSync(finalReceipt)
      if (!sameFileIdentity(torn, beforeClaim)) return false
      deps.renameSync(finalReceipt, `${finalReceipt}.collected.${deps.randomId()}`)
    } catch (error) {
      if (getErrorCode(error) !== 'ENOENT') return false
    }
    if (!publisherIsVerifiablyAbandoned({ ...expectedOwner, active: true })) return false
    try { linkSync(stagedPath, finalReceipt) } catch (error) { if (getErrorCode(error) === 'EEXIST') return false; throw error }
    if (removeExactTombstoneSync(stagedPath, tombstoneIdentityFromStats(stagedStats), deps) !== 'removed') return false
    deps.syncDirectory(directory)
    return hasWindowsNamespaceReceipt(directory, identity, target, deps)
  } catch { return false }
}

/** Receipt removal is the final child mutation, never the authority for an
 * unbounded pathname cleanup.  The rename records retirement durably; an
 * interrupted final unlink leaves an identity-bearing empty directory that a
 * restart can safely rmdir after matching its inode. */
function retireWindowsTombstoneNamespaceSync(directory: string, deps: AtomicWriteDeps, receiptName = WINDOWS_NAMESPACE_RECEIPT): void {
  const stats = deps.lstatSync(directory)
  const identity = tombstoneIdentityFromStats(stats)
  if (!stats.isDirectory() || stats.isSymbolicLink()
    || !sameTombstoneIdentity(ownedWindowsTombstoneNamespaces.get(directory) ?? { dev: -1n, ino: -1n }, identity)) {
    throw new Error(`atomic publication tombstone namespace is not private: ${directory}`)
  }
  const retired = windowsRetirementNamespace(directory, identity)
  deps.renameSync(directory, retired)
  deps.syncDirectory(dirname(directory))
  // Receipt retirement is only safe after re-observing that all body and
  // staged-debris removals completed. A failed mid-loop cleanup must leave
  // this receipt as restart authority, rather than making an opaque nonempty
  // retired directory unrecoverable.
  const remaining = readdirSync(retired)
  if (remaining.length !== 1 || !remaining.includes(receiptName)) {
    throw new Error(`atomic publication tombstone namespace is not empty: ${retired}`)
  }
  // Windows offers no directory fsync contract.  First sweep claims (rather
  // than deletes) the authenticated final receipt; a later independent sweep
  // must observe that claimed inode before it may consume it.  We make no
  // durability inference from either rename, but the two persisted pathname
  // observations give recovery a conservative, eventually-completing path.
  if (deps.platform === 'win32') {
    if (receiptName === WINDOWS_NAMESPACE_RECEIPT) {
      const receipt = join(retired, receiptName)
      const receiptIdentity = tombstoneIdentityFromStats(deps.lstatSync(receipt))
      const claimed = `${receipt}.collected.${deps.randomId()}`
      deps.renameSync(receipt, claimed)
      if (!sameTombstoneIdentity(receiptIdentity, tombstoneIdentityFromStats(deps.lstatSync(claimed)))) {
        throw new Error(`atomic publication namespace receipt was replaced: ${retired}`)
      }
      ownedWindowsTombstoneNamespaces.delete(directory)
      throw new Error(`atomic publication Windows receipt awaits a later sweep: ${retired}`)
    }
  }
  const receipt = join(retired, receiptName)
  if (removeExactTombstoneSync(receipt, tombstoneIdentityFromStats(deps.lstatSync(receipt)), deps) !== 'removed') {
    throw new Error(`atomic publication tombstone namespace receipt was replaced: ${retired}`)
  }
  deps.syncDirectory(retired)
  deps.rmdirSync(retired)
  deps.syncDirectory(dirname(directory))
  ownedWindowsTombstoneNamespaces.delete(directory)
}

function ensureWindowsTombstoneNamespaceSync(destination: string, deps: AtomicWriteDeps): string {
  const requestedDirectory = windowsRunNamespacePath(destination, deps)
  try {
    if (process.platform === 'win32') createWindowsPrivateDirectoryAtomically(requestedDirectory)
    else mkdirSync(requestedDirectory, { mode: 0o700 })
  } catch (error) {
    if (getErrorCode(error) === 'EEXIST') {
      throw new Error(`atomic publication tombstone namespace is not private: ${requestedDirectory}`)
    }
    throw error
  }
  const initial = deps.lstatSync(requestedDirectory)
  let directory = requestedDirectory
  try {
    if (!isPrivateTombstoneNamespace(initial, deps.platform)
      || !deps.secureWindowsNamespace(requestedDirectory, false)) {
      throw new Error(`atomic publication tombstone namespace is not private: ${requestedDirectory}`)
    }
    const verified = deps.lstatSync(requestedDirectory)
    const identity = tombstoneIdentityFromStats(verified)
    if (!isPrivateTombstoneNamespace(verified, deps.platform)
      || !sameTombstoneIdentity(tombstoneIdentityFromStats(initial), identity)) {
      throw new Error(`atomic publication tombstone namespace is not private: ${requestedDirectory}`)
    }
    const pendingDirectory = `${requestedDirectory}.pending.d${identity.dev}.i${identity.ino}`
    // Same ordering as async setup: a failed rename must clean the exact
    // original inode, not a pending pathname that was never installed.
    deps.renameSync(requestedDirectory, pendingDirectory)
    directory = pendingDirectory
    establishWindowsNamespaceAuthoritySync(directory, deps)
    writeWindowsNamespaceReceiptSync(directory, identity, destination, deps,
      { pid: process.pid, instance: processInstanceSync(process.pid), active: true }, 'pending')
    writeWindowsNamespaceReceiptSync(directory, identity, destination, deps,
      { pid: process.pid, instance: processInstanceSync(process.pid), active: true }, 'active')
    ownedWindowsTombstoneNamespaces.set(directory, identity)
    return directory
  } catch (error) {
    try {
      const current = deps.lstatSync(directory)
      if (current.isDirectory() && !current.isSymbolicLink()
        && sameTombstoneIdentity(tombstoneIdentityFromStats(initial), tombstoneIdentityFromStats(current))) {
        const entries = readdirSync(directory)
        if (entries.every(isWindowsNamespaceControlEntry)) {
          for (const entry of entries) {
            const control = join(directory, entry)
            if (removeExactTombstoneSync(control, tombstoneIdentityFromStats(deps.lstatSync(control)), deps) !== 'removed') break
          }
          deps.rmdirSync(directory)
        }
      }
    } catch {}
    throw error
  }
}

function removeExactTombstoneSync(
  path: string,
  expected: TombstoneIdentity,
  deps: AtomicWriteDeps,
): 'removed' | 'identity-mismatch' | 'operational-failure' {
  if (path.includes('.collected.')) {
    try {
      const current = deps.lstatSync(path)
      if (current.isSymbolicLink() || BigInt(current.dev) !== expected.dev || BigInt(current.ino) !== expected.ino) return 'identity-mismatch'
      deps.rmSync(path, { force: true })
      return 'removed'
    } catch (error) {
      return getErrorCode(error) === 'ENOENT' ? 'identity-mismatch' : 'operational-failure'
    }
  }
  const collected = `${path}.collected.${deps.randomId()}`
  try {
    // Tombstone namespaces are owner-only directory protocols.  Retain a
    // private alias first and prove the public name still names that exact
    // generation before cleanup; never move a reusable name before checking
    // its inode.
    const before = deps.lstatSync(path)
    if (before.isSymbolicLink() || BigInt(before.dev) !== expected.dev || BigInt(before.ino) !== expected.ino) return 'identity-mismatch'
    linkSync(path, collected)
    deps.syncDirectory(dirname(path))
    const current = deps.lstatSync(collected)
    const publicCurrent = deps.lstatSync(path)
    if (current.isSymbolicLink() || publicCurrent.isSymbolicLink()
      || BigInt(current.dev) !== expected.dev || BigInt(current.ino) !== expected.ino
      || BigInt(publicCurrent.dev) !== expected.dev || BigInt(publicCurrent.ino) !== expected.ino) {
      return 'identity-mismatch'
    }
    deps.rmSync(path, { force: true })
    deps.rmSync(collected, { force: true })
    deps.syncDirectory(dirname(path))
    return 'removed'
  } catch (error) {
    return getErrorCode(error) === 'ENOENT' ? 'identity-mismatch' : 'operational-failure'
  }
}

function scavengeAtomicWriteTombstonesSync(
  destination: string,
  deps: AtomicWriteDeps,
  directory = tombstoneDirectoryFor(destination),
): AtomicWriteTombstoneReport {
  const prefix = tombstonePrefixFor(destination)
  let entries: string[]
  try {
    entries = readdirSync(directory)
  } catch (error) {
    if (getErrorCode(error) === 'ENOENT') return { directory, retained: 0, retainedBytes: 0, removed: 0, skippedReplacements: 0 }
    throw error
  }
  const namespace = deps.lstatSync(directory)
  if (!isPrivateTombstoneNamespace(namespace, deps.platform)) {
    throw new Error(`atomic publication tombstone namespace is not private: ${directory}`)
  }
  if (deps.platform === 'win32') {
    assertWindowsTombstoneNamespaceOwnership(directory, namespace)
    if (!deps.secureWindowsNamespace(directory, false)) {
      throw new Error(`atomic publication tombstone namespace is not private: ${directory}`)
    }
  }
  const cleanupDebtPaths: string[] = []
  // A crash between syncing an initial receipt and renaming it leaves a
  // `.identity.json.staged.*` file. Recover it before candidate enumeration;
  // otherwise Windows restart recovery mistakes the staged receipt for a
  // body and cannot bound the abandoned publication.
  for (const name of entries.filter(name => name.includes('.identity.json.staged.'))) {
    const body = join(directory, name.slice(0, name.indexOf('.identity.json.staged.')))
    recoverStagedTombstoneIdentitySync(body, deps)
  }
  try { entries = readdirSync(directory) } catch (error) { throw error }
  // A commit can win the body rename after the staged sidecar has been
  // synced but before that receipt is promoted/removed.  When the original
  // body name is absent, only the destination inode named by the staged
  // receipt proves that this is post-commit debris rather than a competing
  // in-progress write.
  for (const name of [...entries]) {
    const marker = '.identity.json.staged.'
    const index = name.indexOf(marker)
    if (index === -1) continue
    const body = join(directory, name.slice(0, index))
    const staged = join(directory, name)
    try {
      deps.lstatSync(body)
      continue
    } catch (error) { if (getErrorCode(error) !== 'ENOENT') continue }
    try {
      const parsed = JSON.parse(deps.readFileSync(staged, 'utf8')) as Partial<PersistedTombstoneIdentity>
      const destinationStats = deps.lstatSync(destination)
      const stagedStats = deps.lstatSync(staged)
      if (typeof parsed.dev !== 'string' || typeof parsed.ino !== 'string'
        || destinationStats.isSymbolicLink() || !destinationStats.isFile()
        || BigInt(destinationStats.dev) !== BigInt(parsed.dev) || BigInt(destinationStats.ino) !== BigInt(parsed.ino)) continue
      if (removeExactTombstoneSync(staged, tombstoneIdentityFromStats(stagedStats), deps) !== 'removed') {
        cleanupDebtPaths.push(staged)
      }
    } catch {}
  }
  try { entries = readdirSync(directory) } catch (error) { throw error }
  // `readdir` establishes that a sidecar name exists. If the first body stat
  // fails and a later check succeeds, retain that sidecar exactly once for
  // this sweep instead of silently losing it between observations.
  const bodyInspectionFailures = new Set<string>()
  const observedBodies = new Set<string>()
  const claimedBodyBases = new Set(entries
    .filter(name => name.startsWith(prefix) && !isTombstoneIdentitySidecarName(name) && name.includes('.collected.'))
    .map(name => collectedTombstoneOriginalPath(join(directory, name))))
  const candidates = entries.flatMap(name => {
    if (!name.startsWith(prefix) || isTombstoneIdentitySidecarName(name)) return []
    const path = join(directory, name)
    try {
      const stats = deps.lstatSync(path)
      if (!stats.isFile() || stats.isSymbolicLink()) return []
      observedBodies.add(path)
      let sidecarStats: ReturnType<typeof deps.lstatSync> | undefined
      let sidecarInspectionFailure = false
      try {
        const sidecar = deps.lstatSync(tombstoneIdentityPath(collectedTombstoneOriginalPath(path)))
        if (sidecar.isFile() && !sidecar.isSymbolicLink()) sidecarStats = sidecar
      } catch (error) {
        // Do not claim that a receipt is absent merely because its metadata
        // could not be inspected. The subsequent receipt read records this
        // as operational debt if it also cannot establish ownership.
        if (getErrorCode(error) !== 'ENOENT') {
          cleanupDebtPaths.push(tombstoneIdentityPath(collectedTombstoneOriginalPath(path)));
          sidecarInspectionFailure = true
        }
      }
      return [{ path, stats, sidecarStats, sidecarInspectionFailure }]
    } catch (error) {
      // ENOENT is a harmless concurrent collection.  Any other failed stat
      // is operational cleanup debt and must reach a post-commit receipt.
      if (getErrorCode(error) === 'ENOENT') return []
      cleanupDebtPaths.push(path)
      bodyInspectionFailures.add(path)
      return []
    }
  })
  // A rename leaves only the ownership sidecar behind.  Treat such receipts
  // as first-class retained entries too: otherwise a denied cleanup can grow
  // forever, and a later successful scan has no way to recover it.  The
  // namespace is private, names are derived from the destination, and the
  // We only inspect a receipt after proving its exact source name is absent
  // (never merely after a failed stat), so an unrelated/replaced body is left
  // alone. A torn receipt is still retained and counted: parsing it before
  // this absence check made an unrelated publication fail on stale debris.
  const orphanSidecars = entries.flatMap(name => {
    if (!name.startsWith(prefix) || !isTombstoneIdentitySidecarName(name)) return []
    const sidecarPath = join(directory, name)
    const sourcePath = tombstoneBodyPathForSidecar(sidecarPath)
    // The original body name is absent while a collector owns
    // `${sourcePath}.collected.*`; that receipt is still paired evidence.
    if (claimedBodyBases.has(sourcePath)) return []
    try {
      const stats = deps.lstatSync(sidecarPath)
      if (!stats.isFile() || stats.isSymbolicLink()) return []
      try {
        const source = deps.lstatSync(sourcePath)
        // A body which still exists is accounted with the body record; a
        // mismatched body is foreign/replaced state and is deliberately kept.
        // If the candidate pass could not inspect it, this later success does
        // not retroactively make the independently observed sidecar vanish
        // from retained accounting.
        if (source.isFile() && !source.isSymbolicLink()) {
          return bodyInspectionFailures.has(sourcePath)
            ? [{ path: sidecarPath, stats, orphan: true, bodyInspectionFailure: true }]
            : []
        }
        return []
      } catch (error) {
        if (getErrorCode(error) !== 'ENOENT') {
          // The receipt itself was observed safely, but its paired body could
          // not be checked. That is not proof of absence, so retain the
          // receipt (and its observed bytes) and defer exactly that path.
          cleanupDebtPaths.push(sourcePath)
          // This sidecar is already included with a successfully observed
          // body candidate. A later failed re-stat must not count it twice.
          if (observedBodies.has(sourcePath)) return []
          return [{ path: sidecarPath, stats, orphan: true, bodyInspectionFailure: true }]
        }
      }
      const receipt = readTombstoneIdentitySync(sourcePath, deps)
      if (receipt.kind === 'operational-failure') {
        // We have trusted no-follow metadata for the receipt and proved its
        // paired source name absent. Keep its real count/bytes in this sweep
        // even though reading its contents failed; otherwise an unreadable
        // receipt can evade every retention limit.
        cleanupDebtPaths.push(sidecarPath)
        return [{ path: sidecarPath, stats, orphan: true, unreadableIdentity: true }]
      }
      if (receipt.kind === 'missing-or-malformed') {
        return [{ path: sidecarPath, stats, orphan: true, malformedIdentity: true }]
      }
      return [{ path: sidecarPath, stats, orphan: true }]
    } catch (error) {
      // readdir told us that this exact sidecar name existed.  A concurrent
      // ENOENT is therefore harmless disappearance; EACCES/EIO leave the
      // evidence in place but must not abort a later safe publication.
      if (getErrorCode(error) !== 'ENOENT') cleanupDebtPaths.push(sidecarPath)
      return []
    }
  })
  const allCandidates = [...candidates, ...orphanSidecars]
    .sort((left, right) => Number(left.stats.mtimeMs) - Number(right.stats.mtimeMs))
  // Bodies and receipts are independent retained filesystem objects. In
  // particular, a failed receipt unlink consumes a count slot and its real
  // bytes until a later sweep removes it.
  let retained = allCandidates.reduce(
    (total, candidate) => total + 1 + ('sidecarStats' in candidate && candidate.sidecarStats ? 1 : 0),
    0,
  )
  let retainedBytes = allCandidates.reduce(
    (total, candidate) => total + Number(candidate.stats.size) + ('sidecarStats' in candidate && candidate.sidecarStats ? Number(candidate.sidecarStats.size) : 0),
    0,
  )
  let removed = 0
  let skippedReplacements = 0
  let malformedRetained = orphanSidecars.filter(
    candidate => 'malformedIdentity' in candidate && candidate.malformedIdentity,
  ).length
  let malformedRetainedBytes = orphanSidecars.reduce(
    (total, candidate) => total + (
      'malformedIdentity' in candidate && candidate.malformedIdentity ? Number(candidate.stats.size) : 0
    ),
    0,
  )
  for (const candidate of allCandidates) {
    const expired = deps.now() - Number(candidate.stats.mtimeMs) > ATOMIC_TOMBSTONE_MAX_AGE_MS
    const malformed = 'malformedIdentity' in candidate && candidate.malformedIdentity
    const malformedExpired = malformed && deps.now() - Number(candidate.stats.mtimeMs) > ATOMIC_MALFORMED_RECEIPT_MAX_AGE_MS
    const overMalformedRetention = malformed && (
      malformedRetained > ATOMIC_MALFORMED_RECEIPT_MAX_COUNT
      || malformedRetainedBytes > ATOMIC_MALFORMED_RECEIPT_MAX_BYTES
    )
    if ('orphan' in candidate) {
      // An unreadable identity receipt or an uninspectable paired body is
      // operational uncertainty, not an orphan classification. Preserve the
      // observed sidecar evidence even when normal retention bounds say it
      // would otherwise be collectible.
      if (('unreadableIdentity' in candidate && candidate.unreadableIdentity)
        || ('bodyInspectionFailure' in candidate && candidate.bodyInspectionFailure)) {
        skippedReplacements += 1
        continue
      }
      if (!expired && retained <= ATOMIC_TOMBSTONE_MAX_COUNT && retainedBytes <= ATOMIC_TOMBSTONE_MAX_BYTES
        && !malformedExpired && !overMalformedRetention) continue
      // Recheck exact absence immediately before unlinking the receipt.
      try { deps.lstatSync(tombstoneBodyPathForSidecar(candidate.path)); skippedReplacements += 1; continue } catch (error) {
        // A failed final absence check is not proof of a replacement. Keep
        // the trusted sidecar bytes in retention and surface the operation as
        // debt so a later sweep, rather than a false conflict classification,
        // decides what happened.
        if (getErrorCode(error) !== 'ENOENT') {
          cleanupDebtPaths.push(tombstoneBodyPathForSidecar(candidate.path))
          skippedReplacements += 1
          continue
        }
      }
      try {
        if (removeExactTombstoneSync(candidate.path, tombstoneIdentityFromStats(candidate.stats), deps) !== 'removed') {
          throw new Error('atomic publication orphan receipt was replaced')
        }
        retained -= 1; retainedBytes -= Number(candidate.stats.size); removed += 1
        if (malformed) {
          malformedRetained -= 1
          malformedRetainedBytes -= Number(candidate.stats.size)
        }
      } catch {
        // This opaque evidence still exceeds a configured bound. Surface the
        // exact path so a later publication can reconcile the debt.
        cleanupDebtPaths.push(candidate.path)
        skippedReplacements += 1
      }
      continue
    }
    if ('sidecarInspectionFailure' in candidate && candidate.sidecarInspectionFailure) {
      // Sidecar inspection failed before ownership could be established.
      // Do not collect the body based on a possibly stale/mutable receipt.
      skippedReplacements += 1
      continue
    }
    const receiptPathBase = collectedTombstoneOriginalPath(candidate.path)
    const receipt = readTombstoneIdentitySync(receiptPathBase, deps)
    if (receipt.kind === 'operational-failure') {
      // Reading the ownership proof failed operationally. It is neither a
      // malformed receipt nor evidence that this body can be collected.
      cleanupDebtPaths.push(tombstoneIdentityPath(receiptPathBase))
      skippedReplacements += 1
      continue
    }
    if (!expired && retained <= ATOMIC_TOMBSTONE_MAX_COUNT && retainedBytes <= ATOMIC_TOMBSTONE_MAX_BYTES) continue
    // Receipt identity alone proves that this name once belonged to us, not
    // that its publisher has stopped using its still-open descriptor.  The
    // process-local destination fence cannot cover another process, so do
    // not unlink until its receipt proves that owner has exited.  Missing or
    // torn legacy receipts are similarly retained: their ownership state is
    // unknown, even when quota pressure would otherwise collect them.
    // A missing or torn receipt has no trustworthy JSON ownership, but new
    // private names embed the same process-incarnation token. That protects
    // an active writer while allowing a confirmed abandoned body to obey
    // bounds. Legacy names remain conservatively retained.
    const owner = receipt.kind === 'valid' ? receipt.owner : undefined
    if (!owner || !publisherIsVerifiablyAbandoned(owner)) {
      skippedReplacements += 1
      continue
    }
    // A body is never collectable from an observed inode/name fallback.
    // Missing and torn receipts, including owners inferred from old names,
    // lack durable abandonment authority and remain forensic evidence.
    if (receipt.kind !== 'valid') {
      skippedReplacements += 1
      continue
    }
    const expected = receipt.identity
    {
      // The receipt is a mutable pathname. Re-read its identity and owner at
      // the deletion boundary; an earlier dead-owner observation is never
      // authority to remove a successor that renewed or replaced its lease.
      const mutationReceipt = readTombstoneIdentitySync(receiptPathBase, deps)
      if (mutationReceipt.kind !== 'valid' || !sameTombstoneIdentity(mutationReceipt.identity, expected)
        || mutationReceipt.owner.pid !== receipt.owner.pid
        || mutationReceipt.owner.instance !== receipt.owner.instance
        || mutationReceipt.owner.active !== receipt.owner.active
        || !publisherIsVerifiablyAbandoned(mutationReceipt.owner)) {
        skippedReplacements += 1
        continue
      }
      const bodyRemoval = removeExactTombstoneSync(candidate.path, expected, deps)
      if (bodyRemoval === 'operational-failure') {
        cleanupDebtPaths.push(candidate.path)
        skippedReplacements += 1
        continue
      }
      if (bodyRemoval === 'identity-mismatch') {
        // This is still a failed cleanup attempt. A committed caller must be
        // able to reconcile the retained/replaced pathname instead of seeing
        // a deceptively clean receipt merely because no exception was thrown.
        cleanupDebtPaths.push(candidate.path)
        skippedReplacements += 1
        continue
      }
      // The body and receipt are separate files. Once the body is gone, its
      // bytes no longer count, but the retained entry must remain until its
      // receipt is actually removed.
      retained -= 1
      retainedBytes -= Number(candidate.stats.size)
      removed += 1
      const sidecarPath = tombstoneIdentityPath(receiptPathBase)
      if (!candidate.sidecarStats) continue
      // A body removal makes its receipt an orphan during this sweep.  Put a
      // torn receipt through the exact same count/byte/age quarantine now,
      // rather than waiting for a future publication to notice the debris.
      const sidecarExpired = deps.now() - Number(candidate.sidecarStats.mtimeMs) > ATOMIC_MALFORMED_RECEIPT_MAX_AGE_MS
      const newlyMalformed = false
      if (newlyMalformed) {
        malformedRetained += 1
        malformedRetainedBytes += Number(candidate.sidecarStats.size)
      }
      const overNewMalformedRetention = newlyMalformed && (
        malformedRetained > ATOMIC_MALFORMED_RECEIPT_MAX_COUNT
        || malformedRetainedBytes > ATOMIC_MALFORMED_RECEIPT_MAX_BYTES
      )
      const overRetention = retained > ATOMIC_TOMBSTONE_MAX_COUNT || retainedBytes > ATOMIC_TOMBSTONE_MAX_BYTES
      if (receipt.kind === 'valid' || sidecarExpired || overNewMalformedRetention || overRetention) {
        try {
          if (removeExactTombstoneSync(sidecarPath, tombstoneIdentityFromStats(candidate.sidecarStats), deps) !== 'removed') {
            throw new Error('atomic publication receipt was replaced')
          }
          retained -= 1
          retainedBytes -= Number(candidate.sidecarStats.size)
          removed += 1
          if (newlyMalformed) {
            malformedRetained -= 1
            malformedRetainedBytes -= Number(candidate.sidecarStats.size)
          }
        } catch {
          cleanupDebtPaths.push(sidecarPath)
          skippedReplacements += 1
        }
      }
    }
  }
  return {
    directory,
    retained,
    retainedBytes,
    removed,
    skippedReplacements,
    ...(cleanupDebtPaths.length > 0 ? { cleanupDebt: { paths: cleanupDebtPaths } } : {}),
  }
}

/** Enumerate every prior Windows run child.  Recovery never adopts a child:
 * it needs the DACL validation, a receipt bound to this exact directory inode
 * and a proven-dead process incarnation before it can retire bounded debris. */
function scavengeWindowsRunNamespacesSync(destination: string, deps: AtomicWriteDeps): AtomicWriteTombstoneReport {
  // Windows run namespaces live directly beside the destination.  A stable
  // parent would have its own mkdir-before-DACL authority gap.
  const parent = dirname(destination)
  const runPrefix = `${ATOMIC_TOMBSTONE_DIRECTORY}.run.`
  let names: string[]
  try { names = readdirSync(parent) } catch (error) {
    if (getErrorCode(error) === 'ENOENT') return { directory: parent, retained: 0, retainedBytes: 0, removed: 0, skippedReplacements: 0 }
    throw error
  }
  let retained = 0; let retainedBytes = 0; let removed = 0; let skippedReplacements = 0
  const debt: string[] = []
  // Retention is per destination, not per run directory.  In particular a
  // long-lived publisher may produce many authenticated inactive failures;
  // collect those globally while leaving every active namespace untouched.
  const candidates: Array<{
    directory: string
    inode: TombstoneIdentity
    observations: Array<{ path: string; stats: ReturnType<typeof lstatSync> }>
    sidecars: Array<{ path: string; stats: ReturnType<typeof lstatSync> }>
    controls: Array<{ path: string; stats: ReturnType<typeof lstatSync> }>
    receiptBytes: number
    debrisBytes: number
    newest: number
  }> = []
  for (const name of names) {
    if (!name.startsWith(runPrefix)) continue
    const directory = join(parent, name)
    const retirement = windowsRetirementIdentity(name)
    if (retirement && name.startsWith(runPrefix)) {
      try {
        const stats = deps.lstatSync(directory)
        if (!stats.isDirectory() || stats.isSymbolicLink() || !sameTombstoneIdentity(tombstoneIdentityFromStats(stats), retirement)
          || !deps.secureWindowsNamespace(directory, false)) { skippedReplacements += 1; continue }
        let entries = readdirSync(directory)
        // The namespace control receipt is staged and synced before final
        // publication. Recover it before a nonempty retired directory is
        // rejected; link-based promotion in the helper cannot clobber a
        // final successor installed by another recoverer.
        if (recoverWindowsNamespaceReceiptStagingSync(directory, retirement, destination, deps)) entries = readdirSync(directory)
        if (entries.length === 0) { deps.rmdirSync(directory); removed += 1; continue }
        // Retirement is durable before the receipt unlink. Resume an
        // interrupted nonempty retirement only when the receipt still binds
        // this exact inode and its publisher has stopped.
        const original = name.replace(/\.retired\.d\d+\.i\d+$/, '')
        const run = windowsNamespaceRunFromPath(original)
        if (!run || !hasWindowsNamespaceReceipt(directory, retirement, destination, deps)) {
          skippedReplacements += 1; continue
        }
        const recoveryReceipt = windowsNamespaceReceiptPathForRecovery(directory, deps)
        if (!recoveryReceipt) { skippedReplacements += 1; continue }
        const parsed = JSON.parse(deps.readFileSync(recoveryReceipt, 'utf8')) as WindowsNamespaceReceipt
        const creator = windowsNamespaceOwnerFromPath(original)
        // An inactive JSON lease is not provenance. The creator is bound to
        // the exclusive namespace name, so re-probe that incarnation as live
        // before any restart deletion.
        if (!parsed.owner || !creator
          || !hasValidWindowsNamespaceMac(directory, parsed, deps)
          || !publisherIsVerifiablyAbandoned({ ...creator, active: true })
          || entries.some(entry => !isWindowsNamespaceControlEntry(entry) && !entry.startsWith(tombstonePrefixFor(destination)))) {
          skippedReplacements += 1; continue
        }
        for (const staged of entries.filter(entry => entry.includes('.identity.json.staged.'))) {
          recoverStagedTombstoneIdentitySync(join(directory, staged.slice(0, staged.indexOf('.identity.json.staged.'))), deps)
        }
        entries = readdirSync(directory)
        const current = deps.lstatSync(directory)
        if (!sameTombstoneIdentity(tombstoneIdentityFromStats(current), retirement)) { skippedReplacements += 1; continue }
        for (const entry of entries.filter(entry => !isWindowsNamespaceControlEntry(entry) && !isTombstoneIdentitySidecarName(entry))) {
          const body = join(directory, entry)
          const observed = deps.lstatSync(body)
          // A `.collected.*` body is still authenticated by its original
          // receipt; the collected suffix is only a collector lease.
          const bodyReceipt = readTombstoneIdentitySync(collectedTombstoneOriginalPath(body), deps)
          if (observed.isSymbolicLink() || bodyReceipt.kind !== 'valid'
            || !sameTombstoneIdentity(tombstoneIdentityFromStats(observed), bodyReceipt.identity)
            || !publisherIsVerifiablyAbandoned(bodyReceipt.owner)) {
            throw new Error('atomic publication retirement body was replaced or is unauthenticated')
          }
          if (removeExactTombstoneSync(body, tombstoneIdentityFromStats(observed), deps) !== 'removed') {
            throw new Error('atomic publication retirement body was replaced before deletion')
          }
          deps.syncDirectory(directory)
        }
        // The receipt MAC and protected DACL were verified before this loop;
        // staged receipt generations are therefore bounded control cleanup,
        // never permanent retention blockers.
        for (const entry of readdirSync(directory).filter(entry => join(directory, entry) !== recoveryReceipt)) {
          const control = join(directory, entry)
          const observed = deps.lstatSync(control)
          if (!observed.isFile() || observed.isSymbolicLink()) throw new Error('atomic publication staged namespace control was replaced')
          if (removeExactTombstoneSync(control, tombstoneIdentityFromStats(observed), deps) !== 'removed') {
            throw new Error('atomic publication staged namespace control was replaced before deletion')
          }
          deps.syncDirectory(directory)
        }
        const remaining = readdirSync(directory)
        if (remaining.length !== 1 || !remaining.includes(basename(recoveryReceipt))) {
          skippedReplacements += 1; continue
        }
        if (deps.platform === 'win32') {
          // Do not pretend syncDirectory is a Windows durability barrier.
          // A first sweep only claims the authenticated final receipt. A
          // later sweep must rediscover the claimed record and authenticate
          // it again before the normal exact-removal path below can finish.
          if (basename(recoveryReceipt) === WINDOWS_NAMESPACE_RECEIPT) {
            const receiptIdentity = tombstoneIdentityFromStats(deps.lstatSync(recoveryReceipt))
            const claimed = `${recoveryReceipt}.collected.${deps.randomId()}`
            deps.renameSync(recoveryReceipt, claimed)
            if (!sameTombstoneIdentity(receiptIdentity, tombstoneIdentityFromStats(deps.lstatSync(claimed)))) {
              throw new Error('atomic publication namespace receipt was replaced before collection')
            }
            debt.push(directory); skippedReplacements += 1; continue
          }
        }
        const finalReceipt = recoveryReceipt
        const finalReceiptStats = deps.lstatSync(finalReceipt)
        if (removeExactTombstoneSync(finalReceipt, tombstoneIdentityFromStats(finalReceiptStats), deps) !== 'removed') {
          throw new Error('atomic publication namespace receipt was replaced before deletion')
        }
        deps.syncDirectory(directory)
        deps.rmdirSync(directory); deps.syncDirectory(parent); removed += 1
      } catch { debt.push(directory) }
      continue
    }
    const run = windowsNamespaceRunFromPath(directory)
    if (!run) continue
    try {
      const stats = deps.lstatSync(directory)
      const inode = tombstoneIdentityFromStats(stats)
      if (!stats.isDirectory() || stats.isSymbolicLink()) { skippedReplacements += 1; continue }
      if (!hasWindowsNamespaceReceipt(directory, inode, destination, deps)) {
        // A pending identity is written by the exclusive creator before the
        // first receipt byte. It is the sole exception to fail-closed receipt
        // parsing, and only permits retirement of an empty/torn child owned
        // by a proven-dead process incarnation.
        const pending = windowsPendingIdentity(name)
        const ownerMatch = /^\.atomic-write-tombstones\.run\.p(\d+)\.s([A-Za-z0-9_-]+)\./.exec(name)
        const owner: ProcessInstanceOwner | undefined = ownerMatch
          ? { pid: Number(ownerMatch[1]), instance: ownerMatch[2] === 'unknown' ? null : ownerMatch[2], active: true }
          : undefined
        if (!owner || !publisherIsVerifiablyAbandoned(owner)) { skippedReplacements += 1; continue }
        // This also handles a torn final receipt in an otherwise regular
        // (non-pending) namespace. Its MAC-valid staged successor is bounded
        // recovery authority after the named creator has exited.
        if (recoverWindowsNamespaceReceiptStagingSync(directory, inode, destination, deps)) {
          return scavengeWindowsRunNamespacesSync(destination, deps)
        }
        const entries = readdirSync(directory)
        if ((pending && !sameTombstoneIdentity(pending, inode)) || (!pending && entries.length !== 0)) {
          skippedReplacements += 1; continue
        }
        // No MAC-bearing receipt means that even a control-looking staged
        // file is not deletion authority.  Leaving it as explicit debt is
        // safer than allowing forged pending metadata to clean a namespace.
        // A genuinely empty inode-bearing pending directory has no content
        // to authenticate and is the sole harmless exception.
        if (entries.length === 0) { deps.rmdirSync(directory); removed += 1; continue }
        // A power loss between syncing a staged pending receipt and its
        // rename leaves a complete, externally-authenticated receipt under a
        // staged name.  Promote only that exact MAC-valid, ACL-protected
        // control file; this keeps interrupted control generations bounded
        // without granting cleanup power to arbitrary pending JSON.
        skippedReplacements += 1
        continue
      }
      // A receipt-authenticated retained namespace must still have its
      // protected DACL. Creation-before-ACL crash recovery above intentionally
      // does not repair or validate an unowned, empty pending directory.
      if (!deps.secureWindowsNamespace(directory, false)) { skippedReplacements += 1; continue }
      const recoveryReceipt = windowsNamespaceReceiptPathForRecovery(directory, deps)
      if (!recoveryReceipt) { skippedReplacements += 1; continue }
      const parsed = JSON.parse(deps.readFileSync(recoveryReceipt, 'utf8')) as WindowsNamespaceReceipt
      const creator = windowsNamespaceOwnerFromPath(directory)
      if (!parsed.owner || !creator || parsed.owner.pid <= 0 || parsed.run !== run
        || !hasValidWindowsNamespaceMac(directory, parsed, deps)
        || !publisherIsVerifiablyAbandoned({ ...creator, active: true })) {
        skippedReplacements += 1; continue
      }
      let entries = readdirSync(directory)
      for (const staged of entries.filter(entry => entry.includes('.identity.json.staged.'))) {
        recoverStagedTombstoneIdentitySync(join(directory, staged.slice(0, staged.indexOf('.identity.json.staged.'))), deps)
      }
      entries = readdirSync(directory)
      const debris = entries.filter(entry => !isWindowsNamespaceControlEntry(entry) && !isTombstoneIdentitySidecarName(entry))
      const sidecars = entries.filter(entry => !isWindowsNamespaceControlEntry(entry) && isTombstoneIdentitySidecarName(entry)).map(entry => {
        const path = join(directory, entry); const entryStats = deps.lstatSync(path)
        if (!entryStats.isFile() || entryStats.isSymbolicLink() || !entry.startsWith(tombstonePrefixFor(destination))) {
          throw new Error('foreign namespace sidecar')
        }
        return { path, stats: entryStats }
      })
      const controls = entries.filter(entry => join(directory, entry) !== recoveryReceipt && isWindowsNamespaceControlEntry(entry)).map(entry => {
        const path = join(directory, entry); const entryStats = deps.lstatSync(path)
        if (!entryStats.isFile() || entryStats.isSymbolicLink()) throw new Error('unexpected staged namespace control')
        return { path, stats: entryStats }
      })
      const observations = debris.map(entry => {
        const path = join(directory, entry); const entryStats = deps.lstatSync(path)
        if (!entryStats.isFile() || entryStats.isSymbolicLink()
          || (!isWindowsNamespaceControlEntry(entry) && !entry.startsWith(tombstonePrefixFor(destination)))) throw new Error('foreign namespace debris')
        const bodyReceipt = readTombstoneIdentitySync(collectedTombstoneOriginalPath(path), deps)
        if (bodyReceipt.kind !== 'valid' || !sameTombstoneIdentity(tombstoneIdentityFromStats(entryStats), bodyReceipt.identity)) {
          throw new Error('atomic publication tombstone body was replaced or is unauthenticated')
        }
        return { path, stats: entryStats }
      })
      const receiptBytes = Number(deps.lstatSync(recoveryReceipt).size)
      const debrisBytes = observations.reduce((sum, item) => sum + Number(item.stats.size), 0)
        + sidecars.reduce((sum, item) => sum + Number(item.stats.size), 0)
      const controlBytes = controls.reduce((sum, item) => sum + Number(item.stats.size), 0)
      retained += observations.length + sidecars.length + controls.length + 1
      retainedBytes += debrisBytes + controlBytes + receiptBytes
      const newest = observations.reduce((latest, item) => Math.max(latest, Number(item.stats.mtimeMs)), 0)
      candidates.push({ directory, inode, observations, sidecars, controls, receiptBytes, debrisBytes: debrisBytes + controlBytes, newest })
    } catch (error) {
      // A malformed/untrusted child is visible but never becomes deletion
      // authority. Operational faults remain explicit reconciliation debt.
      if (getErrorCode(error) !== 'ENOENT') debt.push(directory)
      skippedReplacements += 1
    }
  }
  for (const candidate of candidates.sort((left, right) => left.newest - right.newest)) {
    const expired = deps.now() - candidate.newest > ATOMIC_TOMBSTONE_MAX_AGE_MS
    if (!expired && retained <= ATOMIC_TOMBSTONE_MAX_COUNT && retainedBytes <= ATOMIC_TOMBSTONE_MAX_BYTES) continue
    try {
      // Re-authenticate immediately before mutation; replaced directories and
      // forged active:false JSON fail closed because the inode proof is part
      // of the receipt and the process incarnation is re-probed above.
      const current = deps.lstatSync(candidate.directory)
      if (!sameTombstoneIdentity(candidate.inode, tombstoneIdentityFromStats(current))
        || !hasWindowsNamespaceReceipt(candidate.directory, candidate.inode, destination, deps)) { skippedReplacements += 1; continue }
      const rereadReceiptPath = windowsNamespaceReceiptPathForRecovery(candidate.directory, deps)
      if (!rereadReceiptPath) { skippedReplacements += 1; continue }
      const reauthenticated = JSON.parse(deps.readFileSync(rereadReceiptPath, 'utf8')) as WindowsNamespaceReceipt
      const creator = windowsNamespaceOwnerFromPath(candidate.directory)
      if (!creator || !hasValidWindowsNamespaceMac(candidate.directory, reauthenticated, deps)
        || !publisherIsVerifiablyAbandoned({ ...creator, active: true })) {
        skippedReplacements += 1
        continue
      }
      for (const control of candidate.controls) {
        const currentControl = deps.lstatSync(control.path)
        if (currentControl.isSymbolicLink() || !sameFileIdentity(currentControl, control.stats!)) {
          throw new Error('atomic publication staged namespace control was replaced')
        }
        if (removeExactTombstoneSync(control.path, tombstoneIdentityFromStats(control.stats!), deps) !== 'removed') {
          throw new Error('atomic publication staged namespace control was replaced before deletion')
        }
        deps.syncDirectory(candidate.directory)
      }
      for (const item of candidate.observations) {
        // The sidecar is mutable evidence. Re-read it at the mutation point
        // so a live successor cannot inherit an earlier dead-owner decision.
        const bodyReceipt = readTombstoneIdentitySync(collectedTombstoneOriginalPath(item.path), deps)
        if (bodyReceipt.kind !== 'valid' || !sameTombstoneIdentity(bodyReceipt.identity, tombstoneIdentityFromStats(item.stats))
          || !publisherIsVerifiablyAbandoned(bodyReceipt.owner)) {
          throw new Error('atomic publication tombstone receipt changed before deletion')
        }
        if (removeExactTombstoneSync(item.path, tombstoneIdentityFromStats(item.stats), deps) !== 'removed') {
          throw new Error('atomic publication tombstone was replaced before deletion')
        }
        deps.syncDirectory(candidate.directory)
      }
      for (const sidecar of candidate.sidecars) {
        if (removeExactTombstoneSync(sidecar.path, tombstoneIdentityFromStats(sidecar.stats), deps) !== 'removed') {
          throw new Error('atomic publication tombstone sidecar was replaced before deletion')
        }
        deps.syncDirectory(candidate.directory)
      }
      const receiptName = basename(rereadReceiptPath)
      const retired = windowsRetirementNamespace(candidate.directory, candidate.inode)
      deps.renameSync(candidate.directory, retired); deps.syncDirectory(parent)
      // The selected recovery receipt may already be a final
      // `.collected.*` name. Carry that exact name across namespace
      // retirement; recomputing the canonical path strands first sweep.
      const finalReceipt = join(retired, receiptName)
      if (deps.platform === 'win32') {
        throw new Error(`atomic publication Windows receipt durability is unproven: ${retired}`)
      }
      const finalReceiptStats = deps.lstatSync(finalReceipt)
      if (removeExactTombstoneSync(finalReceipt, tombstoneIdentityFromStats(finalReceiptStats), deps) !== 'removed') {
        throw new Error('atomic publication namespace receipt was replaced before deletion')
      }
      deps.syncDirectory(retired)
      deps.rmdirSync(retired); deps.syncDirectory(parent)
      retained -= candidate.observations.length + candidate.sidecars.length + candidate.controls.length + 1; retainedBytes -= candidate.debrisBytes + candidate.receiptBytes
      removed += 1
    } catch (error) {
      // A malformed/untrusted child is visible but never becomes deletion
      // authority. Operational faults remain explicit reconciliation debt.
      if (getErrorCode(error) !== 'ENOENT') debt.push(candidate.directory)
      skippedReplacements += 1
    }
  }
  return { directory: parent, retained, retainedBytes, removed, skippedReplacements,
    ...(debt.length ? { cleanupDebt: { paths: debt } } : {}) }
}

function mergeCleanupDebt(
  cleanupDebt: AtomicWriteReceipt['cleanupDebt'],
  additionalPaths: readonly string[] | undefined,
): AtomicWriteReceipt['cleanupDebt'] {
  if (!additionalPaths?.length) return cleanupDebt
  return { paths: [...new Set([...(cleanupDebt?.paths ?? []), ...additionalPaths])] }
}

/**
 * Scavenge only our per-destination tombstones. The result is deliberately
 * observable so operators can surface retained/unsafe replacements instead
 * of allowing failed publications to grow without bound.
 */
export async function scavengeAtomicWriteTombstones(
  destination: string,
  depsOverride: Partial<AtomicWriteDeps> = {},
): Promise<AtomicWriteTombstoneReport> {
  const deps = resolveDeps(depsOverride)
  if (deps.platform === 'win32') return scavengeWindowsRunNamespacesSync(destination, deps)
  return scavengeAtomicWriteTombstonesSync(destination, deps, tombstoneDirectoryFor(destination))
}

async function moveFileIntoPlace(
  tempPath: string,
  finalPath: string,
  deps: AtomicWriteDeps,
  transactionId: string,
  committedHandle: Awaited<ReturnType<typeof fs.open>>,
  tombstoneIdentity: TombstoneIdentity,
  context?: AtomicWriteContext,
): Promise<AtomicWriteReceipt> {
  // The temporary file is created beside the destination, so EXDEV is not a
  // recoverable condition.  A copy fallback would not be an atomic commit.
  // There is intentionally no await between this authority check and rename.
  // Keep the descriptor as the authority for the prepared inode.  A path is
  // only a name: validate it immediately before rename so a replacement made
  // after open cannot be published under this transaction's receipt.
  if (deps.platform === 'win32') {
    const namespace = dirname(tempPath)
    const namespaceStats = deps.lstatSync(namespace)
    if (!isPrivateTombstoneNamespace(namespaceStats, deps.platform)) {
      throw new Error(`atomic publication tombstone namespace is not private: ${namespace}`)
    }
    assertWindowsTombstoneNamespaceOwnership(namespace, namespaceStats)
    if (!deps.secureWindowsNamespace(namespace, false)) {
      throw new Error(`atomic publication tombstone namespace is not private: ${namespace}`)
    }
  }
  const prepared = await committedHandle.stat({ bigint: true })
  if (!sameFileIdentity(prepared, tombstoneIdentity)) {
    throw new Error('atomic publication descriptor changed before rename')
  }
  const namedPrepared = deps.lstatSync(tempPath)
  if (namedPrepared.isSymbolicLink() || !sameFileIdentity(prepared, namedPrepared)) {
    throw new Error('atomic publication temporary source was replaced before rename')
  }
  assertPublicationAuthority(context)
  renameWithRetrySync(
    tempPath,
    finalPath,
    deps.renameSync,
    () => assertPublicationAuthority(context),
    deps.sleepSync,
    deps.getRetryDelayMs,
  )
  // `rename` persists neither parent directory by itself. Both changed
  // directories must be durable before the publication receipt is returned.
  const sourceDirectory = dirname(tempPath)
  deps.syncDirectory(sourceDirectory)
  if (dirname(finalPath) !== sourceDirectory) deps.syncDirectory(dirname(finalPath))
  // A replacement can win the destination pathname immediately after rename.
  // This descriptor was opened before rename, so fstat is always the inode
  // this transaction committed rather than whichever writer owns finalPath.
  // The rename above is the commit point.  fstat is only an observation of
  // that fact; a descriptor I/O failure must not turn an already-published
  // generation into a rejected write.  The pre-rename descriptor is still a
  // lossless identity for the inode which rename committed.
  let stat = prepared
  let observationDebt = false
  try {
    stat = await committedHandle.stat({ bigint: true })
    if (!sameFileIdentity(prepared, stat)) {
      // A successful descriptor observation which contradicts the prepared
      // descriptor is materially different from an unavailable observation.
      throw new Error('atomic publication descriptor changed during rename')
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'atomic publication descriptor changed during rename') throw error
    observationDebt = true
  }
  return {
    committed: true,
    authorityExpiredAfterCommit: authorityExpired(context),
    identity: {
      destination: finalPath,
      transactionId,
      device: stat.dev,
      inode: stat.ino,
      // These are descriptive metadata rather than publication identity.
      size: Number(stat.size),
      modifiedAtMs: Number(stat.mtimeMs),
    },
    ...(observationDebt ? { cleanupDebt: { paths: [finalPath] } } : {}),
  }
}

/** Failed publications intentionally retain their source in the private
 * namespace. It is observable and bounded by scavengeAtomicWriteTombstones;
 * eager cleanup is avoided because an error path must never delete a name
 * that a caller with equivalent filesystem authority has replaced. */
async function leaveTemporaryTombstone(
  tempPath: string,
  deps: AtomicWriteDeps,
  ownedHandle: Awaited<ReturnType<typeof fs.open>> | undefined,
): Promise<void> {
  // Preserve the evidence for the next bounded scavenger. In particular, do
  // not turn an error path into a pathname delete. `ownedHandle` is accepted
  // to make that ownership decision explicit at call sites.
  void tempPath
  void deps
  void ownedHandle
}

function renameWithRetrySync(
  tempPath: string,
  finalPath: string,
  rename: typeof renameSync = renameSync,
  assertAuthority: () => void = () => {},
  sleep: (ms: number) => void = sleepSync,
  getRetryDelayMs: (attemptIndex: number) => number = defaultRetryDelayMs,
): void {
  for (let attemptIndex = 0; attemptIndex < ATOMIC_RENAME_MAX_ATTEMPTS; attemptIndex += 1) {
    try {
      assertAuthority()
      rename(tempPath, finalPath)
      return
    } catch (error) {
      const hasAttemptsLeft = attemptIndex + 1 < ATOMIC_RENAME_MAX_ATTEMPTS
      if (!hasAttemptsLeft || !isRetryableRenameError(error)) {
        throw error
      }
      sleep(getRetryDelayMs(attemptIndex))
    }
  }
}

export async function renamePathWithRetry(
  fromPath: string,
  toPath: string,
  deps: Partial<Pick<AtomicWriteDeps, 'rename' | 'sleep' | 'getRetryDelayMs'>> = {},
): Promise<void> {
  const rename = deps.rename ?? fs.rename
  const sleep = deps.sleep ?? defaultSleep
  const getRetryDelayMs = deps.getRetryDelayMs ?? defaultRetryDelayMs

  for (let attemptIndex = 0; attemptIndex < ATOMIC_RENAME_MAX_ATTEMPTS; attemptIndex += 1) {
    try {
      await rename(fromPath, toPath)
      return
    } catch (error) {
      const hasAttemptsLeft = attemptIndex + 1 < ATOMIC_RENAME_MAX_ATTEMPTS
      if (!hasAttemptsLeft || !isRetryableRenameError(error)) {
        throw error
      }
      await sleep(getRetryDelayMs(attemptIndex))
    }
  }
}

export function renamePathWithRetrySync(
  fromPath: string,
  toPath: string,
  deps: { renameSync?: typeof renameSync } = {},
): void {
  renameWithRetrySync(fromPath, toPath, deps.renameSync)
}

export function writeFileAtomicSync(
  filePath: string,
  content: string,
  options: Pick<AtomicWriteOptions, 'encoding' | 'mode' | 'deps'> = {},
): AtomicWriteReceipt {
  const deps = resolveDeps(options.deps)
  const transactionId = deps.randomId()
  let namespace = ''
  let failedTempPath = ''
  let failedOwned: ReturnType<typeof fstatSync> | undefined
  let prePublicationCleanupDebt: AtomicWriteReceipt['cleanupDebt']
  try {
    mkdirSync(dirname(filePath), { recursive: true })
    namespace = tombstoneDirectoryFor(filePath)
    if (deps.platform === 'win32') {
      const recovery = scavengeWindowsRunNamespacesSync(filePath, deps)
      prePublicationCleanupDebt = mergeCleanupDebt(prePublicationCleanupDebt, recovery.cleanupDebt?.paths)
      namespace = ensureWindowsTombstoneNamespaceSync(filePath, deps)
    } else {
      try {
        mkdirSync(namespace, { mode: 0o700 })
      } catch (error) {
        if (getErrorCode(error) !== 'EEXIST') throw error
      }
      const initialNamespaceStats = deps.lstatSync(namespace)
      if (!isPrivateTombstoneNamespace(initialNamespaceStats, deps.platform)) {
        throw new Error(`atomic publication tombstone namespace is not private: ${namespace}`)
      }
      const namespaceStats = deps.lstatSync(namespace)
      if (!isPrivateTombstoneNamespace(namespaceStats, deps.platform)) {
        throw new Error(`atomic publication tombstone namespace is not private: ${namespace}`)
      }
    }
    const prePublicationReport = scavengeAtomicWriteTombstonesSync(filePath, deps, namespace)
    prePublicationCleanupDebt = mergeCleanupDebt(
      prePublicationCleanupDebt,
      prePublicationReport.cleanupDebt?.paths,
    )
    const tempPath = failedTempPath = join(
      namespace,
      `${basename(filePath)}.tmp.p${process.pid}.s${processInstanceSync(process.pid) ?? 'unknown'}.${deps.now()}.${transactionId}`,
    )
    // O_EXCL creation, descriptor identity capture, and durable ownership
    // sidecar all happen before the first body byte is written.
    const fd = openSync(tempPath, 'wx', options.mode)
    let owned: ReturnType<typeof fstatSync>
    let committed = false
    let postCommitDebt: AtomicWriteReceipt['cleanupDebt']
    try {
      owned = deps.fstatSync(fd, { bigint: true })
      failedOwned = owned
      recordTombstoneIdentitySync(tempPath, {
        dev: BigInt(owned.dev), ino: BigInt(owned.ino),
      }, deps)
      const bytes = Buffer.from(content, options.encoding ?? 'utf8')
      for (let offset = 0; offset < bytes.length;) offset += writeSync(fd, bytes, offset, bytes.length - offset)
      if (options.mode !== undefined) chmodSync(tempPath, options.mode)
      fsyncSync(fd)
      const descriptor = deps.fstatSync(fd, { bigint: true })
      if (deps.platform === 'win32') {
        const currentNamespaceStats = deps.lstatSync(namespace)
        if (!isPrivateTombstoneNamespace(currentNamespaceStats, deps.platform)) {
          throw new Error(`atomic publication tombstone namespace is not private: ${namespace}`)
        }
        assertWindowsTombstoneNamespaceOwnership(namespace, currentNamespaceStats)
        if (!deps.secureWindowsNamespace(namespace, false)) {
          throw new Error(`atomic publication tombstone namespace is not private: ${namespace}`)
        }
      }
      const named = deps.lstatSync(tempPath)
      if (named.isSymbolicLink() || !sameFileIdentity(descriptor, named)) {
        throw new Error('atomic publication temporary source was replaced before rename')
      }
      renameWithRetrySync(tempPath, filePath, deps.renameSync, () => {}, deps.sleepSync, deps.getRetryDelayMs)
      committed = true
      // The commit changes both the private source namespace and destination
      // parent.  A directory fsync is the durability acknowledgement point.
      deps.syncDirectory(namespace)
      if (dirname(filePath) !== namespace) deps.syncDirectory(dirname(filePath))
      // Rename is irrevocable. Descriptor observation failures after it are
      // reconciliation debt, while a positive mismatching observation remains
      // a hard integrity failure.
      try {
        const committedStats = deps.fstatSync(fd, { bigint: true })
        if (!sameFileIdentity(descriptor, committedStats)) throw new Error('atomic publication descriptor changed during rename')
        owned = committedStats
      } catch (error) {
        if (error instanceof Error && error.message === 'atomic publication descriptor changed during rename') throw error
        owned = descriptor
        postCommitDebt = { paths: [filePath] }
      }
    } finally {
      try {
        deps.closeSync(fd)
      } catch (error) {
        // A close failure after rename is observational/cleanup debt.  Do not
        // throw it over the only receipt proving the committed mutation.
        if (!committed) throw error
        postCommitDebt = mergeCleanupDebt(postCommitDebt, [filePath])
      }
    }
    const receipt: AtomicWriteReceipt = {
      committed: true,
      authorityExpiredAfterCommit: false,
      identity: {
        destination: filePath,
        transactionId,
        device: BigInt(owned.dev),
        inode: BigInt(owned.ino),
        size: Number(owned.size),
        modifiedAtMs: Number(owned.mtimeMs),
      },
    }
    let cleanupDebt = mergeCleanupDebt(prePublicationCleanupDebt, postCommitDebt?.paths)
    try {
      const sidecarPath = tombstoneIdentityPath(tempPath)
      if (removeExactTombstoneSync(sidecarPath, tombstoneIdentityFromStats(deps.lstatSync(sidecarPath)), deps) !== 'removed') {
        throw new Error('atomic publication receipt was replaced after commit')
      }
    } catch {
      // Rename has committed. Every cleanup error (including unfamiliar
      // platform errors) is deferred debt, never a retroactive failure.
      cleanupDebt = mergeCleanupDebt(cleanupDebt, [tombstoneIdentityPath(tempPath)])
    }
    if (deps.platform === 'win32' && !cleanupDebt?.paths.includes(tombstoneIdentityPath(tempPath))) {
      // Node has no directory metadata barrier on Windows. Do not pretend the
      // rename/unlink sequence is durable by deleting its only recovery
      // receipt: retain the sealed run namespace as observable cleanup debt.
      // A later restart can authenticate and bound this state.
      cleanupDebt = mergeCleanupDebt(cleanupDebt, [windowsNamespaceReceiptPath(namespace), namespace])
    }
    try {
      const report = deps.platform === 'win32'
        ? scavengeWindowsRunNamespacesSync(filePath, deps)
        : scavengeAtomicWriteTombstonesSync(filePath, deps, namespace)
      cleanupDebt = mergeCleanupDebt(cleanupDebt, report.cleanupDebt?.paths)
    } catch {
      // This is after rename: retain the committed receipt and make deferred
      // collection observable instead of throwing away the commit result.
      cleanupDebt = { paths: [...(cleanupDebt?.paths ?? []), tombstoneDirectoryFor(filePath)] }
    }
    return cleanupDebt ? { ...receipt, cleanupDebt } : receipt
  } catch (error) {
    // A failed synchronous publication also retains its private tombstone.
    // Deleting by a mutable pathname could remove a replacement.
    if (namespace) {
      if (failedTempPath && failedOwned) {
        try {
          // A failed write may race a pathname substitution. Never replace an
          // ownership receipt for a successor merely because this descriptor
          // once owned the same name.
          const current = deps.lstatSync(failedTempPath)
          if (current.isSymbolicLink() || !sameFileIdentity(current, failedOwned)) throw new Error('atomic failure source was replaced')
          const receipt = tombstoneIdentityPath(failedTempPath)
          const staged = `${receipt}.staged.${deps.randomId()}`
          writeFileSync(staged, JSON.stringify({
            dev: BigInt(failedOwned.dev).toString(), ino: BigInt(failedOwned.ino).toString(),
            owner: { pid: process.pid, instance: processInstanceSync(process.pid), active: false },
          }), { mode: 0o600 })
          const receiptFd = openSync(staged, 'r+')
          try { fsyncSync(receiptFd) } finally { deps.closeSync(receiptFd) }
          deps.renameSync(staged, receipt)
          deps.syncDirectory(dirname(receipt))
        } catch {}
      }
      if (deps.platform === 'win32') {
        // The directory lease is independent of the per-file receipt. Mark a
        // handled failure inactive as well, otherwise a long-lived process
        // can keep an entire failed run namespace outside aggregate cleanup.
        try {
          const stats = deps.lstatSync(namespace)
          const creation = ownedWindowsTombstoneNamespaces.get(namespace)
          if (stats.isDirectory() && !stats.isSymbolicLink() && creation
            && sameTombstoneIdentity(tombstoneIdentityFromStats(stats), creation)) {
            writeWindowsNamespaceReceiptSync(namespace, tombstoneIdentityFromStats(stats), filePath, deps,
              { pid: process.pid, instance: processInstanceSync(process.pid), active: false })
          }
        } catch {}
      }
      try {
        if (deps.platform === 'win32') scavengeWindowsRunNamespacesSync(filePath, deps)
        else scavengeAtomicWriteTombstonesSync(filePath, deps, namespace)
      } catch {}
    }
    throw error
  }
}

export async function writeFileAtomic(
  filePath: string,
  content: string,
  options: AtomicWriteOptions = {},
): Promise<AtomicWriteReceipt> {
  const deps = resolveDeps(options.deps)
  const transactionId = deps.randomId()

  return withDestinationMutationFence(filePath, async () => {
    let committed = false
    let committedHandle: Awaited<ReturnType<typeof fs.open>> | undefined
    let committedReceipt: AtomicWriteReceipt | undefined
    let tempPath = ''
    let namespace = ''
    let tombstoneIdentity: TombstoneIdentity | undefined
    let prePublicationCleanupDebt: AtomicWriteReceipt['cleanupDebt']
    try {
      assertPublicationAuthority(options.context)
      await deps.mkdir(dirname(filePath), { recursive: true })
      if (deps.platform === 'win32') {
        const recovery = scavengeWindowsRunNamespacesSync(filePath, deps)
        prePublicationCleanupDebt = mergeCleanupDebt(prePublicationCleanupDebt, recovery.cleanupDebt?.paths)
      }
      namespace = await ensureTombstoneNamespace(filePath, deps)
      const prePublicationReport = scavengeAtomicWriteTombstonesSync(filePath, deps, namespace)
      prePublicationCleanupDebt = mergeCleanupDebt(
        prePublicationCleanupDebt,
        prePublicationReport.cleanupDebt?.paths,
      )
      tempPath = join(
        namespace,
      `${basename(filePath)}.tmp.p${process.pid}.s${processInstanceSync(process.pid) ?? 'unknown'}.${deps.now()}.${transactionId}`,
      )
      assertPublicationAuthority(options.context)
      // Create exclusively and make the descriptor identity recoverable
      // before body I/O. A cancellation/short write now always leaves an
      // exact-inode sidecar for safe later collection.
      committedHandle = await deps.open(tempPath, 'wx', options.mode)
      tombstoneIdentity = await captureTombstoneIdentity(committedHandle)
      await recordTombstoneIdentity(tempPath, committedHandle, deps, tombstoneIdentity)
      assertPublicationAuthority(options.context)
      await committedHandle.writeFile(content, {
        encoding: options.encoding ?? 'utf8',
        ...(options.context?.signal ? { signal: options.context.signal } : {}),
      })
      if (options.mode !== undefined) await committedHandle.chmod(options.mode)
      assertPublicationAuthority(options.context)
      await committedHandle.sync()
      assertPublicationAuthority(options.context)
      // The captured receipt is deliberately reused after body I/O.  Never
      // rewrite/truncate it at the rename boundary.
      const receipt = await moveFileIntoPlace(
        tempPath, filePath, deps, transactionId, committedHandle,
        tombstoneIdentity, options.context,
      )
      committed = true
      committedReceipt = receipt
      // The source was renamed, so its retained-cleanup receipt is no longer
      // needed. The namespace itself remains available for future failures.
      let cleanupDebt = prePublicationCleanupDebt
      try {
        const sidecarPath = tombstoneIdentityPath(tempPath)
        if (removeExactTombstoneSync(sidecarPath, tombstoneIdentityFromStats(deps.lstatSync(sidecarPath)), deps) !== 'removed') {
          throw new Error('atomic publication receipt was replaced after commit')
        }
      } catch {
        // A committed publication has a durable receipt even if cleanup uses
        // an unexpected filesystem error code.
        cleanupDebt = mergeCleanupDebt(cleanupDebt, [tombstoneIdentityPath(tempPath)])
      }
      if (deps.platform === 'win32' && !cleanupDebt?.paths.includes(tombstoneIdentityPath(tempPath))) {
        // Windows exposes no directory fsync. Preserve the authenticated run
        // receipt rather than acknowledging an unprovable final retirement.
        cleanupDebt = mergeCleanupDebt(cleanupDebt, [windowsNamespaceReceiptPath(namespace), namespace])
      }
      try {
        const report = deps.platform === 'win32'
          ? scavengeWindowsRunNamespacesSync(filePath, deps)
          : scavengeAtomicWriteTombstonesSync(filePath, deps, namespace)
        cleanupDebt = mergeCleanupDebt(cleanupDebt, report.cleanupDebt?.paths)
      } catch {
        // Commit has already happened.  Collection is strictly best-effort
        // and its failure must never turn an irrevocable receipt into throw.
        cleanupDebt = { paths: [...(cleanupDebt?.paths ?? []), tombstoneDirectoryFor(filePath)] }
      }
      committedReceipt = cleanupDebt ? { ...receipt, cleanupDebt: mergeCleanupDebt(receipt.cleanupDebt, cleanupDebt.paths) } : receipt
      return committedReceipt
    } finally {
      // The destination is never cleanup: after rename it may already belong
      // to a newer writer. Failed source names remain in the private
      // namespace for bounded exact-inode scavenging.
      if (!committed && tempPath) {
        // A handled failure from this still-running process is no longer an
        // active writer. Persist that fact so a long-lived process cannot pin
        // its failed body forever; a crash retains active incarnation proof.
        if (committedHandle && tombstoneIdentity) {
          // The descriptor is the old source authority, not authority over a
          // pathname that an adversary replaced after the failed rename.
          try {
            const current = deps.lstatSync(tempPath)
            if (!current.isSymbolicLink() && sameFileIdentity(current, tombstoneIdentity)) {
              await recordTombstoneIdentity(tempPath, committedHandle, deps, tombstoneIdentity, {
                pid: process.pid, instance: processInstanceSync(process.pid), active: false,
              })
            }
          } catch {}
        }
        if (deps.platform === 'win32' && namespace) {
          try {
            const stats = deps.lstatSync(namespace)
            const creation = ownedWindowsTombstoneNamespaces.get(namespace)
            if (stats.isDirectory() && !stats.isSymbolicLink() && creation
              && sameTombstoneIdentity(tombstoneIdentityFromStats(stats), creation)) {
              await writeWindowsNamespaceReceipt(namespace, tombstoneIdentityFromStats(stats), filePath, deps,
                { pid: process.pid, instance: processInstanceSync(process.pid), active: false })
            }
          } catch {}
        }
        await leaveTemporaryTombstone(tempPath, deps, committedHandle)
        // Keep the failed transaction's error authoritative, while enforcing
        // bounds before releasing its destination fence.
        if (namespace) {
          try {
            if (deps.platform === 'win32') scavengeWindowsRunNamespacesSync(filePath, deps)
            else scavengeAtomicWriteTombstonesSync(filePath, deps, namespace)
          } catch {}
        }
      }
      if (committedHandle) {
        try {
          await committedHandle.close()
        } catch (error) {
          // Once rename returned, close cannot undo it.  Preserve a mutable
          // receipt reference so the caller observes this debt rather than a
          // throw (or a silently swallowed descriptor failure).
          if (!committed || !committedReceipt) throw error
          committedReceipt.cleanupDebt = mergeCleanupDebt(committedReceipt.cleanupDebt, [filePath])
        }
      }
    }
  })
}

export async function writeJsonFileAtomic(
  filePath: string,
  value: unknown,
  options: AtomicJsonWriteOptions = {},
): Promise<AtomicWriteReceipt> {
  const serialized = JSON.stringify(value, null, options.indent)
  if (serialized === undefined) {
    throw new Error(`Cannot atomically write non-JSON value to ${filePath}`)
  }
  return writeFileAtomic(filePath, serialized, options)
}
