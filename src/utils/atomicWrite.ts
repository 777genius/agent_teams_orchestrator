import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
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
  rm: typeof fs.rm
  renameSync: typeof renameSync
  fstatSync: typeof fstatSync
  closeSync: typeof closeSync
  statSync: typeof statSync
  lstatSync: typeof lstatSync
  readFileSync: typeof readFileSync
  rmSync: typeof rmSync
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
    rm: overrides?.rm ?? fs.rm,
    renameSync: overrides?.renameSync ?? renameSync,
    fstatSync: overrides?.fstatSync ?? fstatSync,
    closeSync: overrides?.closeSync ?? closeSync,
    statSync: overrides?.statSync ?? statSync,
    lstatSync: overrides?.lstatSync ?? ((path => lstatSync(path, { bigint: true })) as typeof lstatSync),
    readFileSync: overrides?.readFileSync ?? readFileSync,
    rmSync: overrides?.rmSync ?? rmSync,
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

function tombstonePrefixFor(destination: string): string {
  return `${basename(destination)}.tmp.`
}

function tombstoneIdentityPath(path: string): string {
  return `${path}.identity.json`
}

function ownerFromTombstonePath(path: string): ProcessInstanceOwner | undefined {
  const match = /\.tmp\.p(\d+)\.s([A-Za-z0-9_-]+)\./.exec(basename(path))
  if (!match) return undefined
  return { pid: Number(match[1]), instance: match[2] === 'unknown' ? null : match[2], active: true }
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
  await deps.writeFile(tombstoneIdentityPath(path), JSON.stringify(persisted), { mode: 0o600 })
  // Do not begin body I/O until the recovery ownership receipt itself is
  // durable. The descriptor is deliberately retained by the caller too.
  const sidecar = await deps.open(tombstoneIdentityPath(path), 'r')
  try { await sidecar.sync() } finally { await sidecar.close().catch(() => undefined) }
  return owned
}

async function captureTombstoneIdentity(
  handle: Awaited<ReturnType<typeof fs.open>>,
): Promise<TombstoneIdentity> {
  const stats = await handle.stat({ bigint: true })
  return { dev: BigInt(stats.dev), ino: BigInt(stats.ino) }
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

/**
 * The tombstone directory is a namespace owned by this process/user (0700).
 * It protects the source name between fstat and rename. Node exposes no
 * renameat-by-descriptor primitive, so publishing from a shared directory
 * could otherwise only establish a racy stat-then-rename claim.
 */
async function ensureTombstoneNamespace(destination: string, deps: AtomicWriteDeps): Promise<string> {
  const directory = tombstoneDirectoryFor(destination)
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
  // An existing namespace is validation-only. In particular, do not repair a
  // foreign/public/reparse namespace merely because its path has our name.
  if (deps.platform === 'win32' && !deps.secureWindowsNamespace(directory, created)) {
    throw new Error(`atomic publication tombstone namespace is not private: ${directory}`)
  }
  const stats = deps.lstatSync(directory)
  if (!isPrivateTombstoneNamespace(stats, deps.platform)) {
    throw new Error(`atomic publication tombstone namespace is not private: ${directory}`)
  }
  return directory
}

function removeExactTombstoneSync(
  path: string,
  expected: TombstoneIdentity,
  deps: AtomicWriteDeps,
): 'removed' | 'identity-mismatch' | 'operational-failure' {
  try {
    // lstat, rather than stat, rejects a symlink substitution. With the
    // private parent namespace this synchronous comparison/removal cannot
    // delete a replacement created by an outside principal.
    const current = deps.lstatSync(path)
    if (current.isSymbolicLink()
      || BigInt(current.dev) !== expected.dev || BigInt(current.ino) !== expected.ino) return 'identity-mismatch'
  } catch (error) {
    // A disappeared body is a benign concurrent collection/replacement. Any
    // other stat failure is not identity evidence and must remain visible as
    // cleanup debt.
    return getErrorCode(error) === 'ENOENT' ? 'identity-mismatch' : 'operational-failure'
  }
  try {
    deps.rmSync(path, { force: true })
    return 'removed'
  } catch {
    return 'operational-failure'
  }
}

function scavengeAtomicWriteTombstonesSync(
  destination: string,
  deps: AtomicWriteDeps,
): AtomicWriteTombstoneReport {
  const directory = tombstoneDirectoryFor(destination)
  const prefix = tombstonePrefixFor(destination)
  let entries: string[]
  try {
    entries = readdirSync(directory)
  } catch (error) {
    if (getErrorCode(error) === 'ENOENT') return { directory, retained: 0, retainedBytes: 0, removed: 0, skippedReplacements: 0 }
    throw error
  }
  const namespace = deps.lstatSync(directory)
  if (deps.platform === 'win32' && !deps.secureWindowsNamespace(directory, false)) {
    throw new Error(`atomic publication tombstone namespace is not private: ${directory}`)
  }
  if (!isPrivateTombstoneNamespace(namespace, deps.platform)) {
    throw new Error(`atomic publication tombstone namespace is not private: ${directory}`)
  }
  const cleanupDebtPaths: string[] = []
  // `readdir` establishes that a sidecar name exists. If the first body stat
  // fails and a later check succeeds, retain that sidecar exactly once for
  // this sweep instead of silently losing it between observations.
  const bodyInspectionFailures = new Set<string>()
  const observedBodies = new Set<string>()
  const candidates = entries.flatMap(name => {
    if (!name.startsWith(prefix) || name.endsWith('.identity.json')) return []
    const path = join(directory, name)
    try {
      const stats = deps.lstatSync(path)
      if (!stats.isFile() || stats.isSymbolicLink()) return []
      observedBodies.add(path)
      let sidecarStats: ReturnType<typeof deps.lstatSync> | undefined
      let sidecarInspectionFailure = false
      try {
        const sidecar = deps.lstatSync(tombstoneIdentityPath(path))
        if (sidecar.isFile() && !sidecar.isSymbolicLink()) sidecarStats = sidecar
      } catch (error) {
        // Do not claim that a receipt is absent merely because its metadata
        // could not be inspected. The subsequent receipt read records this
        // as operational debt if it also cannot establish ownership.
        if (getErrorCode(error) !== 'ENOENT') {
          cleanupDebtPaths.push(tombstoneIdentityPath(path))
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
    if (!name.startsWith(prefix) || !name.endsWith('.identity.json')) return []
    const sidecarPath = join(directory, name)
    const sourcePath = sidecarPath.slice(0, -'.identity.json'.length)
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
      try { deps.lstatSync(candidate.path.slice(0, -'.identity.json'.length)); skippedReplacements += 1; continue } catch (error) {
        // A failed final absence check is not proof of a replacement. Keep
        // the trusted sidecar bytes in retention and surface the operation as
        // debt so a later sweep, rather than a false conflict classification,
        // decides what happened.
        if (getErrorCode(error) !== 'ENOENT') {
          cleanupDebtPaths.push(candidate.path.slice(0, -'.identity.json'.length))
          skippedReplacements += 1
          continue
        }
      }
      try {
        deps.rmSync(candidate.path, { force: true })
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
    const receipt = readTombstoneIdentitySync(candidate.path, deps)
    if (receipt.kind === 'operational-failure') {
      // Reading the ownership proof failed operationally. It is neither a
      // malformed receipt nor evidence that this body can be collected.
      cleanupDebtPaths.push(tombstoneIdentityPath(candidate.path))
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
    const owner = receipt.kind === 'valid' ? receipt.owner : ownerFromTombstonePath(candidate.path)
    if (!owner || !publisherIsVerifiablyAbandoned(owner)) {
      skippedReplacements += 1
      continue
    }
    // Missing/malformed receipts are an interrupted-creation quarantine.
    // They obey the same explicit count/byte/age bounds as owned tombstones,
    // while retaining their paired malformed receipt as forensic evidence.
    // Re-observe the body identity immediately before unlinking so a symlink
    // or replacement is never removed merely because the receipt was torn.
    const expected = receipt.kind === 'valid'
      ? receipt.identity
      : { dev: BigInt(candidate.stats.dev), ino: BigInt(candidate.stats.ino) }
    {
      const bodyRemoval = removeExactTombstoneSync(candidate.path, expected, deps)
      if (bodyRemoval === 'operational-failure') {
        cleanupDebtPaths.push(candidate.path)
        skippedReplacements += 1
        continue
      }
      if (bodyRemoval === 'identity-mismatch') {
        skippedReplacements += 1
        continue
      }
      // The body and receipt are separate files. Once the body is gone, its
      // bytes no longer count, but the retained entry must remain until its
      // receipt is actually removed.
      retained -= 1
      retainedBytes -= Number(candidate.stats.size)
      removed += 1
      const sidecarPath = tombstoneIdentityPath(candidate.path)
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
          deps.rmSync(sidecarPath, { force: true })
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
  return scavengeAtomicWriteTombstonesSync(destination, resolveDeps(depsOverride))
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
  if (deps.platform === 'win32' && !deps.secureWindowsNamespace(dirname(tempPath), false)) {
    throw new Error(`atomic publication tombstone namespace is not private: ${dirname(tempPath)}`)
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
    let namespaceCreated = false
    try {
      mkdirSync(namespace, { mode: 0o700 })
      namespaceCreated = true
    } catch (error) {
      if (getErrorCode(error) !== 'EEXIST') throw error
    }
    const initialNamespaceStats = deps.lstatSync(namespace)
    if (!isPrivateTombstoneNamespace(initialNamespaceStats, deps.platform)) {
      throw new Error(`atomic publication tombstone namespace is not private: ${namespace}`)
    }
    if (deps.platform === 'win32' && !deps.secureWindowsNamespace(namespace, namespaceCreated)) {
      throw new Error(`atomic publication tombstone namespace is not private: ${namespace}`)
    }
    const namespaceStats = deps.lstatSync(namespace)
    if (!isPrivateTombstoneNamespace(namespaceStats, deps.platform)) {
      throw new Error(`atomic publication tombstone namespace is not private: ${namespace}`)
    }
    const prePublicationReport = scavengeAtomicWriteTombstonesSync(filePath, deps)
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
      writeFileSync(tombstoneIdentityPath(tempPath), JSON.stringify({
        dev: BigInt(owned.dev).toString(), ino: BigInt(owned.ino).toString(),
        owner: { pid: process.pid, instance: processInstanceSync(process.pid), active: true },
      }), { mode: 0o600 })
      const sidecarFd = openSync(tombstoneIdentityPath(tempPath), 'r')
      try { fsyncSync(sidecarFd) } finally { deps.closeSync(sidecarFd) }
      const bytes = Buffer.from(content, options.encoding ?? 'utf8')
      for (let offset = 0; offset < bytes.length;) offset += writeSync(fd, bytes, offset, bytes.length - offset)
      if (options.mode !== undefined) chmodSync(tempPath, options.mode)
      fsyncSync(fd)
      const descriptor = deps.fstatSync(fd, { bigint: true })
      if (deps.platform === 'win32' && !deps.secureWindowsNamespace(namespace, false)) {
        throw new Error(`atomic publication tombstone namespace is not private: ${namespace}`)
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
      deps.rmSync(tombstoneIdentityPath(tempPath), { force: true })
    } catch {
      // Rename has committed. Every cleanup error (including unfamiliar
      // platform errors) is deferred debt, never a retroactive failure.
      cleanupDebt = mergeCleanupDebt(cleanupDebt, [tombstoneIdentityPath(tempPath)])
    }
    try {
      const report = scavengeAtomicWriteTombstonesSync(filePath, deps)
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
          writeFileSync(tombstoneIdentityPath(failedTempPath), JSON.stringify({
            dev: BigInt(failedOwned.dev).toString(), ino: BigInt(failedOwned.ino).toString(),
            owner: { pid: process.pid, instance: processInstanceSync(process.pid), active: false },
          }), { mode: 0o600 })
        } catch {}
      }
      try { scavengeAtomicWriteTombstonesSync(filePath, deps) } catch {}
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
    let tombstoneIdentity: TombstoneIdentity | undefined
    let prePublicationCleanupDebt: AtomicWriteReceipt['cleanupDebt']
    try {
      assertPublicationAuthority(options.context)
      await deps.mkdir(dirname(filePath), { recursive: true })
      const namespace = await ensureTombstoneNamespace(filePath, deps)
      const prePublicationReport = await scavengeAtomicWriteTombstones(filePath, deps)
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
        deps.rmSync(tombstoneIdentityPath(tempPath), { force: true })
      } catch {
        // A committed publication has a durable receipt even if cleanup uses
        // an unexpected filesystem error code.
        cleanupDebt = mergeCleanupDebt(cleanupDebt, [tombstoneIdentityPath(tempPath)])
      }
      try {
        const report = await scavengeAtomicWriteTombstones(filePath, deps)
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
          await recordTombstoneIdentity(tempPath, committedHandle, deps, tombstoneIdentity, {
            pid: process.pid, instance: processInstanceSync(process.pid), active: false,
          }).catch(() => undefined)
        }
        await leaveTemporaryTombstone(tempPath, deps, committedHandle)
        // Keep the failed transaction's error authoritative, while enforcing
        // bounds before releasing its destination fence.
        await scavengeAtomicWriteTombstones(filePath, deps).catch(() => undefined)
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
