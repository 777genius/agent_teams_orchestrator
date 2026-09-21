import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { chmod, lstat, mkdir, open, readFile, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import type { BigIntStats, Stats } from 'node:fs'
import { setTimeout } from 'node:timers/promises'
import { basename, dirname, join } from 'node:path'
import { isProcessInstanceActive, processInstance, type ProcessInstanceOwner } from '../../utils/processInstanceOwnership.js'

const NATIVE_PUBLICATION_TOMBSTONE_MAX_COUNT = 32
const NATIVE_PUBLICATION_TOMBSTONE_MAX_AGE_MS = 24 * 60 * 60 * 1_000
const NATIVE_PUBLICATION_TOMBSTONE_MAX_BYTES = 10 * 1024 * 1024

export type PublicationRename = {
  /** Defaults to the host so injected filesystem operations do not silently
   * opt into POSIX-only validation on Windows. */
  platform?: NodeJS.Platform
  rename?: typeof rename
  lstat?: typeof lstat
  rm?: typeof rm
  /** Directory removal is deliberately separate from file cleanup: `rm`
   * must never be pointed at the namespace, even with recursive:false. */
  rmdir?: typeof rmdir
  open?: typeof open
  /** Kept injectable so recovery can distinguish an unreadable receipt from
   * a malformed one without treating I/O failure as corrupt ownership. */
  readFile?: typeof readFile
  /** Injectable for deterministic durability ordering tests. */
  syncDirectory?: (path: string) => Promise<void>
  /** Injectable process-instance probe used by crash recovery. */
  isOwnerActive?: (owner: TombstoneOwner) => Promise<boolean>
  /** Establishes effective single-principal privacy for a retained namespace. */
  secureNamespace?: (path: string, platform: NodeJS.Platform) => Promise<void>
}

export type NativeCliPublicationTombstoneReport = {
  directory: string
  /** Includes both tombstone bodies and surviving identity sidecars. */
  retained: number
  retainedBytes: number
  removed: number
  skippedReplacements: number
  /** Exact cleanup that could not be completed is visible to a reconciler. */
  cleanupDebt?: { paths: string[] }
}

type TombstoneOwner = ProcessInstanceOwner
type TombstoneIdentity = Pick<PublishedFileIdentity, 'dev' | 'ino'> & { owner?: TombstoneOwner }
type TemporaryIdentity = PublishedFileIdentity & { owner: TombstoneOwner }
type TombstoneIdentityRead =
  | { kind: 'valid'; identity: TombstoneIdentity }
  | { kind: 'missing-or-malformed' }
  | { kind: 'operational-failure' }

export type PublishedFileIdentity = {
  // Filesystem APIs may expose these either as numbers or bigint. Keep the
  // proof in its lossless form so a tombstone sidecar written by one stat
  // path compares exactly with lstat/fstat observations from another.
  dev: bigint
  ino: bigint
  size: number
  mtimeMs: number
  mode: number
  symbolicLink: boolean
}

export type NativeCliPublicationReceipt =
  | { status: 'unchanged'; destination: PublishedFileIdentity }
  | {
    status: 'committed'
    /** Identity obtained from a descriptor only after rename succeeded. */
    committed: PublishedFileIdentity
    /** No-follow observation of the destination while its fence is held. */
    destination: PublishedFileIdentity | null
    destinationMatchesCommit: boolean
    /** Cleanup is best-effort only after the rename has committed. A caller
     * still receives the mutation proof and can arrange reconciliation. */
    cleanupDebt?: { paths: string[] }
  }

type FileStats = Stats | BigIntStats
type StatFile = (path: string) => Promise<FileStats>

function identity(stats: FileStats): PublishedFileIdentity {
  return { dev: BigInt(stats.dev), ino: BigInt(stats.ino), size: Number(stats.size), mtimeMs: Number(stats.mtimeMs),
    // BigIntStats exposes mode as bigint. Convert before bitwise masking or
    // receipt serialization; bigint and number operands cannot be mixed.
    mode: Number(stats.mode), symbolicLink: stats.isSymbolicLink() }
}

function sameIdentity(left: PublishedFileIdentity, right: PublishedFileIdentity): boolean {
  // dev/ino are the inode identity. Metadata can legitimately change after a
  // commit (for example a mode repair) without turning this into a replacement.
  return left.dev === right.dev && left.ino === right.ino
    && left.symbolicLink === right.symbolicLink
}

function tombstoneDirectory(filePath: string): string {
  return join(dirname(filePath), `.${basename(filePath)}.native-cli-tombstones`)
}

function tombstonePrefix(filePath: string): string {
  return `${basename(filePath)}.`
}

function tombstoneIdentityPath(path: string): string {
  return `${path}.identity.json`
}

function ownerFromName(filePath: string, name: string): TombstoneOwner | undefined {
  const match = new RegExp(`^${tombstonePrefix(filePath).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}p(\\d+)\\.s([A-Za-z0-9_-]+)\\.`).exec(name)
  if (!match) return undefined
  return { pid: Number(match[1]), instance: match[2] === 'unknown' ? null : match[2], active: true }
}

async function defaultOwnerActive(owner: TombstoneOwner): Promise<boolean> {
  return isProcessInstanceActive(owner)
}

function sameInode(left: TombstoneIdentity, right: TombstoneIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

async function recordTombstoneIdentity(path: string, owned: TombstoneIdentity, openFile: typeof open = open): Promise<void> {
  // JSON cannot encode bigint. Decimal strings preserve every inode bit and
  // accept older numeric sidecars during the transition.
  await writeFile(tombstoneIdentityPath(path), JSON.stringify({ dev: owned.dev.toString(), ino: owned.ino.toString(), owner: owned.owner }), { mode: 0o600 })
  const sidecar = await openFile(tombstoneIdentityPath(path), 'r')
  try { await sidecar.sync() } finally { await sidecar.close().catch(() => undefined) }
}

async function readTombstoneIdentity(
  path: string,
  read: typeof readFile = readFile,
): Promise<TombstoneIdentityRead> {
  try {
    const parsed = JSON.parse(await read(tombstoneIdentityPath(path), 'utf8')) as Partial<TombstoneIdentity>
    if ((typeof parsed.dev !== 'number' && typeof parsed.dev !== 'string')
      || (typeof parsed.ino !== 'number' && typeof parsed.ino !== 'string')) return { kind: 'missing-or-malformed' }
    const owner = parsed.owner
    const validOwner = owner && typeof owner === 'object' && Number.isSafeInteger((owner as TombstoneOwner).pid)
      && (typeof (owner as TombstoneOwner).instance === 'string' || (owner as TombstoneOwner).instance === null)
      && typeof (owner as TombstoneOwner).active === 'boolean'
    return { kind: 'valid', identity: { dev: BigInt(parsed.dev), ino: BigInt(parsed.ino), ...(validOwner ? { owner: owner as TombstoneOwner } : {}) } }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code && (error as NodeJS.ErrnoException).code !== 'ENOENT'
      ? { kind: 'operational-failure' }
      : { kind: 'missing-or-malformed' }
  }
}

/** The native wrapper source lives below a 0700 per-destination namespace.
 * This is the namespace protection that makes fstat + rename meaningful:
 * an outside principal cannot replace the source pathname after validation.
 * Node has no descriptor-relative rename API to provide this otherwise. */
function isPrivateTombstoneNamespace(stats: FileStats, platform: NodeJS.Platform): boolean {
  if (!stats.isDirectory() || stats.isSymbolicLink()) return false
  if (platform === 'win32') return true
  // A mode-only check accepts a directory owned by another local principal.
  // It could revoke our access or replace names after validation, so require
  // the effective publishing UID as well as no group/other access.
  const uid = process.getuid?.()
  return Number.isSafeInteger(uid) && BigInt(stats.uid) === BigInt(uid)
    && (Number(stats.mode) & 0o077) === 0
}

async function secureWindowsTombstoneNamespace(directory: string): Promise<void> {
  // Unit tests can model a Windows publication on another host. Only a real
  // Windows process can establish/inspect Windows ACLs.
  if (process.platform !== 'win32') return
  const literal = directory.replace(/'/g, "''")
  const program = [
    "$ErrorActionPreference='Stop'",
    `$p='${literal}'`,
    '$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User',
    '$acl=Get-Acl -LiteralPath $p',
    'if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value){exit 61}',
    '$acl.SetAccessRuleProtection($true,$false)',
    'foreach($rule in @($acl.Access)){[void]$acl.RemoveAccessRuleAll($rule)}',
    "$rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')",
    '$acl.AddAccessRule($rule)',
    'Set-Acl -LiteralPath $p -AclObject $acl',
    '$after=Get-Acl -LiteralPath $p',
    'if(-not $after.AreAccessRulesProtected -or $after.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value){exit 62}',
    '$rules=@($after.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))',
    'if($rules.Count -ne 1 -or $rules[0].IdentityReference.Value -ne $sid.Value -or $rules[0].AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or (($rules[0].FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -ne [Security.AccessControl.FileSystemRights]::FullControl)){exit 63}',
  ].join(';')
  const encoded = Buffer.from(program, 'utf16le').toString('base64')
  await new Promise<void>((resolve, reject) => {
    const child = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded,
    ], { stdio: 'ignore', windowsHide: true })
    child.once('error', reject)
    child.once('close', code => code === 0
      ? resolve()
      : reject(new Error(`native CLI publication namespace ACL setup failed: ${code}`)))
  })
}

/** macOS mode bits do not describe NFSv4/POSIX ACL grants. Clear every ACL
 * before relying on 0700, then query the native listing to prove no access
 * entry survived. An ACL that cannot be cleared or inspected is not private. */
async function secureDarwinTombstoneNamespace(directory: string): Promise<void> {
  if (process.platform !== 'darwin') return
  const run = async (command: string, args: string[], collect = false): Promise<string> => await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', collect ? 'pipe' : 'ignore', 'pipe'] })
    let output = ''
    child.stdout?.on('data', chunk => { output += String(chunk) })
    child.once('error', reject)
    child.once('close', code => code === 0 ? resolve(output) : reject(new Error(`native CLI publication ACL validation failed: ${code}`)))
  })
  await run('/bin/chmod', ['-N', directory])
  const listing = await run('/bin/ls', ['-lde', directory], true)
  // `ls -e` prints each ACL entry on a subsequent indented line. A single
  // pathname line is the only acceptable effective-privacy receipt.
  if (listing.split(/\r?\n/).filter(Boolean).some(line => /^\s+\d+:/.test(line))) {
    throw new Error(`native CLI publication tombstone namespace retains an ACL: ${directory}`)
  }
}

async function securePrivateTombstoneNamespace(directory: string, platform: NodeJS.Platform): Promise<void> {
  if (platform === 'win32') return secureWindowsTombstoneNamespace(directory)
  if (platform === 'darwin') return secureDarwinTombstoneNamespace(directory)
}

async function ensurePrivateTombstoneNamespace(
  filePath: string,
  platform: NodeJS.Platform,
  statFile: StatFile = path => lstat(path, { bigint: true }),
  secureNamespace: (path: string, platform: NodeJS.Platform) => Promise<void> =
    securePrivateTombstoneNamespace,
): Promise<string> {
  const directory = tombstoneDirectory(filePath)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  let stats = await statFile(directory)
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`native CLI publication tombstone namespace is not private: ${directory}`)
  }
  if (platform === 'win32' || platform === 'darwin') await secureNamespace(directory, platform)
  else {
    const uid = process.getuid?.()
    if (!Number.isSafeInteger(uid) || BigInt(stats.uid) !== BigInt(uid)) {
      throw new Error(`native CLI publication tombstone namespace is not private: ${directory}`)
    }
    // mkdir's mode is affected by umask and an older owned namespace may have
    // been created before this invariant. Establish 0700, then observe it.
    await chmod(directory, 0o700)
  }
  stats = await statFile(directory)
  if (!isPrivateTombstoneNamespace(stats, platform)) {
    throw new Error(`native CLI publication tombstone namespace is not private: ${directory}`)
  }
  return directory
}

async function removeExactTombstone(
  path: string,
  expected: TombstoneIdentity,
  statFile: StatFile,
  removeFile: typeof rm,
): Promise<'removed' | 'identity-mismatch' | 'operational-failure'> {
  try {
    const current = identity(await statFile(path))
    if (current.symbolicLink || !sameInode(current, expected)) return 'identity-mismatch'
    // The parent is the private namespace checked above. The name cannot be
    // replaced by an outside principal between this check and removal.
    await removeFile(path, { force: true })
    return 'removed'
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? 'removed'
      : 'operational-failure'
  }
}

export async function scavengeNativeCliPublicationTombstones(
  filePath: string,
  publication: Partial<Pick<PublicationRename, 'platform' | 'lstat' | 'rm' | 'readFile' | 'isOwnerActive' | 'secureNamespace'>> = {},
): Promise<NativeCliPublicationTombstoneReport> {
  const directory = tombstoneDirectory(filePath)
  const statFile: StatFile = publication.lstat ?? (path => lstat(path, { bigint: true }))
  const removeFile = publication.rm ?? rm
  const readIdentityFile = publication.readFile ?? readFile
  const isOwnerActive = publication.isOwnerActive ?? defaultOwnerActive
  let names: string[]
  try {
    names = await readdir(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { directory, retained: 0, retainedBytes: 0, removed: 0, skippedReplacements: 0 }
    }
    throw error
  }
  const platform = publication.platform ?? process.platform
  let namespace = await statFile(directory)
  if (!namespace.isDirectory() || namespace.isSymbolicLink()) {
    throw new Error(`native CLI publication tombstone namespace is not private: ${directory}`)
  }
  // Recovery mutates retained names too. Re-establish the native ACL boundary
  // before it treats a shared namespace as an authority for an unlink.
  if (platform === 'win32' || platform === 'darwin') {
    await (publication.secureNamespace ?? securePrivateTombstoneNamespace)(directory, platform)
    namespace = await statFile(directory)
  }
  if (!isPrivateTombstoneNamespace(namespace, platform)) {
    throw new Error(`native CLI publication tombstone namespace is not private: ${directory}`)
  }
  const bodyNames = names.filter(name => name.startsWith(tombstonePrefix(filePath)) && !name.endsWith('.identity.json'))
  const sidecars = new Set<string>()
  const cleanupDebt: string[] = []
  const candidates = (await Promise.all(bodyNames.map(async name => {
    const path = join(directory, name)
    try {
      const stats = identity(await statFile(path))
      if (stats.symbolicLink) return null
      const sidecar = tombstoneIdentityPath(path)
      // Observe the body before even looking at its receipt. A concurrently
      // removed body must never cause us to parse a stale sidecar as proof.
      let sidecarStats: PublishedFileIdentity | null = null
      try {
        const observed = identity(await statFile(sidecar))
        if (!observed.symbolicLink) sidecarStats = observed
      } catch (error) {
        // A partial receipt is evidence, but an I/O failure is an operational
        // debt.  Neither is authority to discard the body.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') cleanupDebt.push(sidecar)
      }
      if (sidecarStats) sidecars.add(sidecar)
      // Authenticate every stat-able receipt while the body is observable,
      // rather than only once it exceeds a retention bound.  Otherwise an
      // unreadable receipt in a small/young tombstone set escapes the debt
      // report until a later sweep happens to select it for removal.
      const receipt = await readTombstoneIdentity(path, readIdentityFile)
      if (receipt.kind === 'operational-failure') cleanupDebt.push(sidecar)
      const owner = receipt.kind === 'valid'
        ? receipt.identity.owner ?? ownerFromName(filePath, name)
        : ownerFromName(filePath, name)
      return { path, stats, sidecar, sidecarStats, receipt, owner }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') cleanupDebt.push(path)
      return null
    }
  }))).filter((candidate): candidate is { path: string; stats: PublishedFileIdentity; sidecar: string; sidecarStats: PublishedFileIdentity | null; receipt: TombstoneIdentityRead; owner: TombstoneOwner | undefined } => candidate !== null)
    .sort((left, right) => left.stats.mtimeMs - right.stats.mtimeMs)
  // Sidecars whose bodies vanished are first-class retained artifacts.  Their
  // exact source absence is established before any receipt parsing/removal;
  // this lets bounded recovery clean interrupted debris without mistaking an
  // operational absence-check error for a replacement.
  const orphanSidecars = (await Promise.all(names.filter(name => name.startsWith(tombstonePrefix(filePath)) && name.endsWith('.identity.json')).map(async name => {
    const path = join(directory, name)
    if (sidecars.has(path)) return null
    const body = path.slice(0, -'.identity.json'.length)
    let bodyInspectionFailure = false
    try { await statFile(body); return null } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        // Do not infer absence from an operational failure.  Still inspect
        // the sidecar independently: it is retained evidence whose observed
        // count and bytes must remain exact in this sweep.
        cleanupDebt.push(body)
        bodyInspectionFailure = true
      }
    }
    try {
      const stats = identity(await statFile(path))
      if (stats.symbolicLink) return null
      if (bodyInspectionFailure) return { path, stats, receipt: { kind: 'operational-failure' } as TombstoneIdentityRead, bodyInspectionFailure }
      const receipt = await readTombstoneIdentity(body, readIdentityFile)
      if (receipt.kind === 'operational-failure') cleanupDebt.push(path)
      return { path, stats, receipt }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') cleanupDebt.push(path)
      return null
    }
  }))).filter((candidate): candidate is { path: string; stats: PublishedFileIdentity; receipt: TombstoneIdentityRead; bodyInspectionFailure?: boolean } => candidate !== null)
  let retained = candidates.reduce((total, candidate) => total + 1 + (candidate.sidecarStats ? 1 : 0), orphanSidecars.length)
  let retainedBytes = candidates.reduce((total, candidate) => total + candidate.stats.size + (candidate.sidecarStats?.size ?? 0),
    orphanSidecars.reduce((total, sidecar) => total + sidecar.stats.size, 0))
  let removed = 0
  let skippedReplacements = 0
  for (const candidate of candidates) {
    const expired = Date.now() - candidate.stats.mtimeMs > NATIVE_PUBLICATION_TOMBSTONE_MAX_AGE_MS
    if (!expired && retained <= NATIVE_PUBLICATION_TOMBSTONE_MAX_COUNT
      && retainedBytes <= NATIVE_PUBLICATION_TOMBSTONE_MAX_BYTES) continue
    // This is intentionally before re-reading the receipt: an active writer
    // may have only a torn receipt, but its incarnation is also encoded in
    // the private temporary name. Never age-collect a live publisher.
    if (candidate.owner && await isOwnerActive(candidate.owner)) {
      skippedReplacements += 1
      continue
    }
    // Re-read only when removing, so the identity proof is current at the
    // destructive decision. The first read above is still retained as
    // operational debt for below-bound bodies.
    const receipt = await readTombstoneIdentity(candidate.path, readIdentityFile)
    if (receipt.kind === 'operational-failure') {
      cleanupDebt.push(candidate.sidecar)
      skippedReplacements += 1
    } else {
      // Missing/torn receipts are interrupted-write evidence.  The private
      // namespace plus an immediate lstat identity check makes the observed
      // body the safe bounded-quarantine target; do not leave it unbounded.
      const expected = receipt.kind === 'valid'
        ? receipt.identity
        : { dev: candidate.stats.dev, ino: candidate.stats.ino }
      const removal = await removeExactTombstone(candidate.path, expected, statFile, removeFile)
      if (removal === 'removed') {
        retained -= 1
        retainedBytes -= candidate.stats.size
        removed += 1
        if (candidate.sidecarStats) {
          // The just-removed body makes this a newly orphaned receipt in this
          // very sweep. Account it now and apply its age/bounds immediately.
          const sidecarExpired = Date.now() - candidate.sidecarStats.mtimeMs > NATIVE_PUBLICATION_TOMBSTONE_MAX_AGE_MS
          const overBound = retained > NATIVE_PUBLICATION_TOMBSTONE_MAX_COUNT || retainedBytes > NATIVE_PUBLICATION_TOMBSTONE_MAX_BYTES
          if (receipt.kind === 'valid' || sidecarExpired || overBound) {
            try {
              await removeFile(candidate.sidecar, { force: true })
              retained -= 1
              retainedBytes -= candidate.sidecarStats.size
              // `removed` is the historic body-removal count for this
              // native report; receipt disposal is reflected by retained
              // count/bytes and is deliberately not a second body removal.
            } catch { cleanupDebt.push(candidate.sidecar) }
          }
        }
      } else {
        if (removal === 'operational-failure') cleanupDebt.push(candidate.path)
        skippedReplacements += 1
      }
    }
  }
  // Orphan sidecars have no mutable body left to prove. Recheck absence
  // immediately before removal; EIO/EACCES is debt, never a replacement.
  for (const orphan of orphanSidecars) {
    // An unreadable receipt (or an operational failure establishing that the
    // paired body is absent) is not authority to unlink this orphan. In
    // particular, never discard unreadable forensic evidence merely because
    // its body is already absent.
    if (orphan.receipt.kind === 'operational-failure' || orphan.bodyInspectionFailure) {
      skippedReplacements += 1
      continue
    }
    const expired = Date.now() - orphan.stats.mtimeMs > NATIVE_PUBLICATION_TOMBSTONE_MAX_AGE_MS
    if (!expired && retained <= NATIVE_PUBLICATION_TOMBSTONE_MAX_COUNT
      && retainedBytes <= NATIVE_PUBLICATION_TOMBSTONE_MAX_BYTES) continue
    const body = orphan.path.slice(0, -'.identity.json'.length)
    try {
      await statFile(body)
      skippedReplacements += 1
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        cleanupDebt.push(body)
        continue
      }
      try {
        await removeFile(orphan.path, { force: true })
        retained -= 1
        retainedBytes -= orphan.stats.size
        removed += 1
      } catch { cleanupDebt.push(orphan.path) }
    }
  }
  return { directory, retained, retainedBytes, removed, skippedReplacements,
    ...(cleanupDebt.length === 0 ? {} : { cleanupDebt: { paths: cleanupDebt } }) }
}

function addCleanupDebt(receipt: Extract<NativeCliPublicationReceipt, { status: 'committed' }>, path: string): void {
  const paths = receipt.cleanupDebt?.paths ?? []
  if (!paths.includes(path)) paths.push(path)
  receipt.cleanupDebt = { paths }
}

/** Process-wide destination fence. It serializes managed publishers; the
 * no-follow observation in the receipt separately detects outside writers. */
const destinationTails = new Map<string, Promise<void>>()
async function withDestinationFence<T>(destination: string, operation: () => Promise<T>): Promise<T> {
  const predecessor = destinationTails.get(destination) ?? Promise.resolve()
  let release!: () => void
  const turn = new Promise<void>(resolve => { release = resolve })
  const queuedTurn = predecessor.then(() => turn)
  destinationTails.set(destination, queuedTurn)
  await predecessor
  try {
    return await operation()
  } finally {
    release()
    if (destinationTails.get(destination) === queuedTurn) destinationTails.delete(destination)
  }
}

async function removeOwnedTemporary(
  temporaryPath: string, owned: PublishedFileIdentity | null,
  statFile: StatFile, removeFile: typeof rm,
): Promise<void> {
  // Failure evidence is retained in the private namespace and removed only by
  // the bounded exact-identity scavenger. Never use an error path to delete a
  // mutable source pathname.
  void temporaryPath
  void owned
  void statFile
  void removeFile
}

async function syncDirectory(
  path: string,
  openFile: typeof open = open,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  // Node cannot open/fsync directory handles on Windows.  The prepared file
  // descriptor has already been synced; rename is Windows' supported atomic
  // replacement barrier.  Treat directory durability as best available on
  // that platform rather than throwing after the irreversible rename.
  if (platform === 'win32') return
  const directory = await openFile(path, 'r')
  try { await directory.sync() } finally { await directory.close() }
}

/** Read matching wrapper bytes and metadata from one descriptor.  A pathname
 * is only a name: re-check it after the read so a replacement cannot make us
 * return a reuse receipt for a mixed generation. */
async function reusableDestination(
  filePath: string,
  content: string,
  mode: number,
  platform: NodeJS.Platform,
  statFile: StatFile,
  openFile: typeof open,
): Promise<PublishedFileIdentity | null> {
  let named: PublishedFileIdentity
  try {
    const namedStats = await statFile(filePath)
    if (!namedStats.isFile()) return null
    named = identity(namedStats)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  // Never follow a link or turn an unreadable/permission-denied destination
  // into a path read fallback.  An actual descriptor is the reuse authority.
  if (named.symbolicLink) return null
  const handle = await openFile(filePath, 'r')
  try {
    const descriptor = identity(await handle.stat({ bigint: true }))
    if (!sameIdentity(named, descriptor)) return null
    if ((platform !== 'win32' && (descriptor.mode & 0o7777) !== mode)
      || await handle.readFile({ encoding: 'utf8' }) !== content) return null
    // A chmod can race after the bytes are consumed while preserving inode
    // identity. Re-read descriptor and pathname metadata before claiming a
    // no-op; on Windows the synthesized mode is deliberately not a proof.
    const afterRead = identity(await handle.stat({ bigint: true }))
    if (!sameIdentity(descriptor, afterRead)
      || (platform !== 'win32' && (afterRead.mode & 0o7777) !== mode)) return null
    const finalStats = await statFile(filePath)
    if (!finalStats.isFile()) return null
    const finalNamed = identity(finalStats)
    if (finalNamed.symbolicLink || !sameIdentity(afterRead, finalNamed)
      || (platform !== 'win32' && (finalNamed.mode & 0o7777) !== mode)
      || finalNamed.size !== afterRead.size || finalNamed.mtimeMs !== afterRead.mtimeMs) return null
    return afterRead
  } finally {
    await handle.close()
  }
}

// Never open a published wrapper for writing: another process may execute it
// (ETXTBSY on Linux), read it, or publish concurrently (EBUSY on Windows).
export async function publishNativeCliFile(
  filePath: string, content: string, mode: number,
  publication: PublicationRename = {},
): Promise<NativeCliPublicationReceipt> {
  const resolvedPublication = {
    ...publication,
    platform: publication.platform ?? process.platform,
    rename: publication.rename ?? rename,
  } as PublicationRename & { platform: NodeJS.Platform; rename: typeof rename }
  return withDestinationFence(filePath, async () => {
    const statFile: StatFile = resolvedPublication.lstat ?? (path => lstat(path, { bigint: true }))
    const removeFile = resolvedPublication.rm ?? rm
    const openFile = resolvedPublication.open ?? open
    const reusable = await reusableDestination(
      filePath, content, mode, resolvedPublication.platform, statFile, openFile,
    )
    if (reusable) return { status: 'unchanged', destination: reusable }

    const namespace = await ensurePrivateTombstoneNamespace(filePath, resolvedPublication.platform, statFile,
      resolvedPublication.secureNamespace)
    // A pre-publication sweep can discover exact receipt I/O debt. Preserve
    // it on the eventual publication receipt even if the post-commit sweep
    // sees different filesystem state.
    const prePublicationCleanupDebt = (
      await scavengeNativeCliPublicationTombstones(filePath, resolvedPublication)
    ).cleanupDebt?.paths ?? []
    const instance = await processInstance(process.pid)
    const owner: TombstoneOwner = { pid: process.pid, instance, active: true }
    const temporaryPath = join(namespace, `${basename(filePath)}.p${owner.pid}.s${owner.instance ?? 'unknown'}.${randomUUID()}.tmp`)
    const writable = await openFile(temporaryPath, 'wx', 0o600)
    let temporaryIdentity: TemporaryIdentity | null = null
    let committed = false
    let committedReceipt: Extract<NativeCliPublicationReceipt, { status: 'committed' }> | undefined
    try {
      try {
        // Persist exact descriptor ownership before body I/O. A cancelled or
        // partial write is therefore still safely collectable on restart.
        temporaryIdentity = { ...identity(await writable.stat({ bigint: true })), owner }
        await recordTombstoneIdentity(temporaryPath, temporaryIdentity, openFile)
        await writable.writeFile(content, 'utf8')
        await writable.chmod(mode)
        // Body data and metadata must be durable before its name becomes the
        // destination generation. Closing alone is not a durability barrier.
        await writable.sync()
      } finally {
        await writable.close()
      }
      // Retain a read-only descriptor across rename. fstat below is therefore
      // the post-commit identity of the committed inode, not temp metadata.
      const committedHandle = await openFile(temporaryPath, 'r')
      try {
        const descriptorIdentity = identity(await committedHandle.stat({ bigint: true }))
        if (!sameIdentity(temporaryIdentity, descriptorIdentity)) {
          throw new Error('native CLI publication source changed before rename')
        }
        // Re-establish effective namespace privacy immediately before the
        // pathname identity check and rename. On Darwin this clears any ACL
        // grant that appeared after temp creation; on Windows it rechecks the
        // protected owner-only DACL receipt.
        await ensurePrivateTombstoneNamespace(filePath, resolvedPublication.platform, statFile,
          resolvedPublication.secureNamespace)
        const namedIdentity = identity(await statFile(temporaryPath))
        if (namedIdentity.symbolicLink || !sameIdentity(descriptorIdentity, namedIdentity)) {
          throw new Error('native CLI publication source was replaced before rename')
        }
        for (let attempt = 0; ; attempt++) {
          try {
            await resolvedPublication.rename(temporaryPath, filePath)
            committed = true
            break
          } catch (error) {
            const { code, syscall } = error as NodeJS.ErrnoException
            if (resolvedPublication.platform !== 'win32' || syscall !== 'rename'
              || !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '') || attempt >= 7) throw error
            await setTimeout(10 * 2 ** attempt)
          }
        }
        // Keep this outside the retry loop: a directory fsync failure occurs
        // after the irrevocable rename and must be surfaced, never retried as
        // another publication attempt.
        const sync = resolvedPublication.syncDirectory ?? (path => syncDirectory(path, openFile, resolvedPublication.platform))
        await sync(namespace)
        if (dirname(filePath) !== namespace) await sync(dirname(filePath))
        // The rename is the commit point.  A failed post-rename descriptor
        // observation cannot revoke it; use the pre-rename descriptor proof
        // and surface the observation debt on the committed receipt.
        let committedIdentity = descriptorIdentity
        let descriptorObservationFailed = false
        try {
          const observed = identity(await committedHandle.stat({ bigint: true }))
          if (!sameIdentity(descriptorIdentity, observed)) {
            throw new Error('native CLI publication descriptor changed during rename')
          }
          committedIdentity = observed
        } catch (error) {
          if (error instanceof Error && error.message === 'native CLI publication descriptor changed during rename') throw error
          descriptorObservationFailed = true
        }
        const cleanupDebt: string[] = [
          ...prePublicationCleanupDebt,
          ...(descriptorObservationFailed ? [filePath] : []),
        ]
        let destination: PublishedFileIdentity | null = null
        try {
          destination = identity(await statFile(filePath))
        } catch (error) {
          // A genuine disappearance can be an outside replacement race. Any
          // other destination observation failure is operational debt, not a
          // claim that this commit did not happen.
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') cleanupDebt.push(filePath)
        }
        const sidecar = tombstoneIdentityPath(temporaryPath)
        try {
          await removeFile(sidecar, { force: true })
        } catch {
          cleanupDebt.push(sidecar)
        }
        // Do not recursively erase retained evidence. If the sidecar could
        // not be removed, preserve its namespace as explicit cleanup debt.
        // This namespace is intentionally retained. A separate publisher can
        // validate it and be about to create its exclusive temporary when our
        // rmdir runs; removing the shared directory at that seam strands that
        // publisher with ENOENT.  Exact tombstones are scavenged in place.
        if (cleanupDebt.length !== 0) {
          cleanupDebt.push(namespace)
        }
        const receipt: Extract<NativeCliPublicationReceipt, { status: 'committed' }> = { status: 'committed', committed: committedIdentity, destination,
          destinationMatchesCommit: destination !== null && sameIdentity(destination, committedIdentity),
          ...(cleanupDebt.length === 0 ? {} : { cleanupDebt: { paths: cleanupDebt } }) }
        // Publication is committed. A read/stat failure in best-effort
        // scavenging must not turn that success into a rejected operation.
        try {
          const report = await scavengeNativeCliPublicationTombstones(filePath, resolvedPublication)
          for (const path of report.cleanupDebt?.paths ?? []) addCleanupDebt(receipt, path)
        } catch {
          addCleanupDebt(receipt, namespace)
        }
        committedReceipt = receipt
        return receipt
      } finally {
        try {
          await committedHandle.close()
        } catch (error) {
          // Closing a descriptor after rename may fail, but cannot uncommit
          // its inode. Preserve that fact as reconciliation debt instead of
          // throwing over the only publication receipt.
          if (!committed || !committedReceipt) throw error
          addCleanupDebt(committedReceipt, filePath)
        }
      }
    } finally {
      if (!committed) {
        // A normally failed writer is no longer active. Persist that fact so
        // a same-process scavenger can bound its body; a crash leaves active
        // ownership behind and is protected by instance-aware recovery.
        if (temporaryIdentity) {
          await recordTombstoneIdentity(temporaryPath,
            { dev: temporaryIdentity.dev, ino: temporaryIdentity.ino, owner: { ...owner, active: false } }, openFile).catch(() => undefined)
        }
        await removeOwnedTemporary(temporaryPath, temporaryIdentity, statFile, removeFile)
        await scavengeNativeCliPublicationTombstones(filePath, resolvedPublication).catch(() => undefined)
      }
    }
  })
}
