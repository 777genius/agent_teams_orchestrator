import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { spawn } from 'node:child_process'
import { chmod, link, lstat, mkdir, open, readFile, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises'
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

// Windows cannot safely share a scratch directory between processes: an
// otherwise harmless rmdir can race another writer which has just selected a
// name beneath it.  Each Windows attempt therefore owns a sealed, disposable
// directory.  The receipt is deliberately separate from the per-file
// receipts: it is the restart authority for the directory itself.
const WINDOWS_NAMESPACE_RECEIPT = '.native-cli-publication-namespace.json'
const WINDOWS_NAMESPACE_AUTHORITY = '.native-cli-publication-authority'
// Keep native recovery on the same durable namespace receipt generation as
// the shared atomic writer. Fixtures must exercise this format so a positive
// recovery reaches MAC authentication rather than failing at a legacy parser.
const WINDOWS_NAMESPACE_RECEIPT_FORMAT = 'atomic-write-namespace-v3'
const WINDOWS_AUTHORITY_CLAIM_FORMAT = 'native-cli-authority-claim-v1'
const WINDOWS_GENERATION_KEY_FORMAT = 'native-cli-generation-key-v1'
const WINDOWS_GENERATION_BOOTSTRAP_FORMAT = 'native-cli-generation-bootstrap-v1'
const WINDOWS_RECLAIMER_TAKEOVER_AGE_MS = 30_000

type WindowsAuthorityClaimRecord = {
  format: typeof WINDOWS_AUTHORITY_CLAIM_FORMAT
  role: 'lease' | 'reclaimer'
  owner: TombstoneOwner
  generation: string
  createdAt: number
  claim: { dev: string; ino: string }
  authorityMac: string
}
type WindowsGenerationKeyRecord = {
  format: typeof WINDOWS_GENERATION_KEY_FORMAT
  key: string
  owner: TombstoneOwner
  createdAt: number
  keyMac: string
}
type WindowsGenerationBootstrapRecord = {
  format: typeof WINDOWS_GENERATION_BOOTSTRAP_FORMAT
  nonce: string
  owner: TombstoneOwner
  createdAt: number
  claim: { dev: string; ino: string }
}
const windowsAuthorityFences = new Map<string, Promise<void>>()

async function withWindowsAuthorityFence<T>(authority: string, operation: () => Promise<T>): Promise<T> {
  const predecessor = windowsAuthorityFences.get(authority)
  let release!: () => void
  const fence = new Promise<void>(resolve => { release = resolve })
  windowsAuthorityFences.set(authority, fence)
  await predecessor
  try { return await operation() } finally {
    release()
    if (windowsAuthorityFences.get(authority) === fence) windowsAuthorityFences.delete(authority)
  }
}
// A namespace returned by the exclusive creator is stronger authority than a
// later pathname stat.  Keep that creation observation for the lifetime of
// this process: a replacement at the same name must never be promoted to the
// namespace that we retire after a successful publication.
const ownedWindowsNamespaces = new Map<string, { dev: bigint; ino: bigint }>()
type WindowsNamespaceReceipt = {
  format: typeof WINDOWS_NAMESPACE_RECEIPT_FORMAT
  target: string
  run: string
  owner: TombstoneOwner
  /** The exclusive mkdir inode is the provenance proof.  Names and owner JSON
   * are attacker-controlled strings; neither may authorize a restart unlink. */
  namespace: { dev: string; ino: string }
  /** Durable setup, active-publisher, and handled-failure states are all
   * authenticated with the protected namespace authority. */
  phase: 'pending' | 'active' | 'inactive'
  authorityMac: string
}

function windowsNamespaceAuthorityPath(directory: string): string {
  // Never keep the MAC key in the namespace whose receipt it authenticates.
  // The retained parent authority is independently ACL-protected and has a
  // single-link provenance check before it is used for recovery.
  return join(dirname(directory), `${WINDOWS_NAMESPACE_AUTHORITY}.parent.private`, 'authority')
}

function nativeWindowsNamespaceMac(
  authority: Buffer, receipt: Omit<WindowsNamespaceReceipt, 'authorityMac'>,
): string {
  return createHmac('sha256', authority).update(JSON.stringify({
    format: receipt.format, target: receipt.target, run: receipt.run,
    owner: receipt.owner, namespace: receipt.namespace, phase: receipt.phase,
  })).digest('base64url')
}

async function readTrustedWindowsNamespaceAuthority(directory: string): Promise<Buffer> {
  const authorityPath = windowsNamespaceAuthorityPath(directory)
  const before = await lstat(authorityPath, { bigint: true })
  if (!before.isFile() || before.isSymbolicLink() || BigInt(before.size) !== 32n || BigInt(before.nlink) !== 1n) {
    throw new Error(`native CLI publication namespace authority is invalid: ${authorityPath}`)
  }
  await validateWindowsTombstoneNamespace(authorityPath)
  const bytes = await readFile(authorityPath)
  const after = await lstat(authorityPath, { bigint: true })
  if (bytes.length !== 32 || !after.isFile() || after.isSymbolicLink() || BigInt(after.size) !== 32n
    || BigInt(after.nlink) !== 1n || BigInt(after.dev) !== BigInt(before.dev) || BigInt(after.ino) !== BigInt(before.ino)) {
    throw new Error(`native CLI publication namespace authority was replaced: ${authorityPath}`)
  }
  return bytes
}

async function hasValidNativeWindowsNamespaceMac(directory: string, receipt: WindowsNamespaceReceipt): Promise<boolean> {
  if (!['pending', 'active', 'inactive'].includes(receipt.phase) || typeof receipt.authorityMac !== 'string') return false
  let authority: Buffer
  try {
    // The key is authority independent of the disposable namespace.  A
    // regular 32-byte file alone is not enough: this helper proves the
    // protected owner-only DACL and stable provenance around its read.
    authority = await readTrustedWindowsNamespaceAuthority(directory)
  } catch { return false }
  const expected = nativeWindowsNamespaceMac(authority, {
    format: receipt.format, target: receipt.target, run: receipt.run,
    owner: receipt.owner, namespace: receipt.namespace, phase: receipt.phase,
  })
  const given = Buffer.from(receipt.authorityMac)
  const expectedBytes = Buffer.from(expected)
  return given.length === expectedBytes.length && timingSafeEqual(given, expectedBytes)
}

function nativeWindowsAuthorityClaimMac(authority: Buffer, authorityPath: string,
  record: Omit<WindowsAuthorityClaimRecord, 'authorityMac'>): string {
  return createHmac('sha256', authority).update(JSON.stringify({
    authorityPath, format: record.format, role: record.role, owner: record.owner,
    generation: record.generation, createdAt: record.createdAt, claim: record.claim,
  })).digest('base64url')
}

async function readTrustedNativeAuthority(authorityPath: string): Promise<Buffer> {
  const before = await lstat(authorityPath, { bigint: true })
  if (!before.isFile() || before.isSymbolicLink() || BigInt(before.size) !== 32n || BigInt(before.nlink) !== 1n) {
    throw new Error(`native CLI publication authority is invalid: ${authorityPath}`)
  }
  await validateWindowsTombstoneNamespace(authorityPath)
  const key = await readFile(authorityPath)
  const after = await lstat(authorityPath, { bigint: true })
  if (key.length !== 32 || !after.isFile() || after.isSymbolicLink() || BigInt(after.size) !== 32n
    || BigInt(after.nlink) !== 1n || BigInt(after.dev) !== BigInt(before.dev) || BigInt(after.ino) !== BigInt(before.ino)) {
    throw new Error(`native CLI publication authority was replaced: ${authorityPath}`)
  }
  return key
}

function nativeGenerationKeyMac(bootstrapNonce: Buffer, record: Omit<WindowsGenerationKeyRecord, 'keyMac'>): string {
  return createHmac('sha256', bootstrapNonce).update(JSON.stringify({
    format: record.format, key: record.key, owner: record.owner, createdAt: record.createdAt,
  })).digest('base64url')
}

function validNativeGenerationOwner(owner: unknown): owner is TombstoneOwner {
  return !!owner && typeof owner === 'object'
    && Number.isSafeInteger((owner as TombstoneOwner).pid) && (owner as TombstoneOwner).pid > 0
    && (typeof (owner as TombstoneOwner).instance === 'string' || (owner as TombstoneOwner).instance === null)
    && (owner as TombstoneOwner).active === true
}

/** The nonce is a separately created, claim-inode-bound owner debt.  Unlike
 * keyMac's old construction, a generation record cannot choose both its MAC
 * key and authenticated payload. */
async function readNativeAuthorityGenerationBootstrap(claim: string, expected: {
  owner: TombstoneOwner; createdAt: number
}): Promise<Buffer | null> {
  try {
    const claimStats = await lstat(claim, { bigint: true })
    if (!claimStats.isDirectory() || claimStats.isSymbolicLink()) return null
    const path = join(claim, 'generation.bootstrap')
    const before = await lstat(path, { bigint: true })
    if (!before.isFile() || before.isSymbolicLink() || BigInt(before.nlink) !== 1n) return null
    const record = JSON.parse(await readFile(path, 'utf8')) as Partial<WindowsGenerationBootstrapRecord>
    const after = await lstat(path, { bigint: true })
    if (!sameIdentity(identity(before), identity(after)) || record.format !== WINDOWS_GENERATION_BOOTSTRAP_FORMAT
      || typeof record.nonce !== 'string' || !validNativeGenerationOwner(record.owner)
      || record.owner.pid !== expected.owner.pid || record.owner.instance !== expected.owner.instance
      || record.createdAt !== expected.createdAt || !record.claim
      || BigInt(record.claim.dev) !== BigInt(claimStats.dev) || BigInt(record.claim.ino) !== BigInt(claimStats.ino)) return null
    const nonce = Buffer.from(record.nonce, 'base64url')
    return nonce.length === 32 ? nonce : null
  } catch { return null }
}

// A zero-byte/pre-ACL placeholder cannot authenticate against the old
// authority. The bootstrap artifact therefore carries both the short-lived
// key and its signed owner election. A key-only crash prefix is recoverable
// instead of being retained forever as an indistinguishable initializer.
async function readNativeAuthorityGenerationKey(path: string): Promise<Buffer | null> {
  try {
    const before = await lstat(path, { bigint: true })
    if (!before.isFile() || before.isSymbolicLink()) return null
    const bytes = await readFile(path)
    const after = await lstat(path, { bigint: true })
    if (!sameIdentity(identity(before), identity(after))) return null
    if (bytes.length === 32) return bytes // legacy key: valid only with a signed lease
    const record = JSON.parse(bytes.toString('utf8')) as Partial<WindowsGenerationKeyRecord>
    if (record.format !== WINDOWS_GENERATION_KEY_FORMAT || typeof record.key !== 'string'
      || !record.owner || !Number.isSafeInteger(record.owner.pid) || record.owner.pid <= 0
      || (typeof record.owner.instance !== 'string' && record.owner.instance !== null)
      || record.owner.active !== true || !Number.isSafeInteger(record.createdAt) || record.createdAt < 0
      || typeof record.keyMac !== 'string') return null
    const key = Buffer.from(record.key, 'base64url')
    const bootstrap = await readNativeAuthorityGenerationBootstrap(dirname(path), {
      owner: record.owner as TombstoneOwner, createdAt: record.createdAt,
    })
    const supplied = Buffer.from(record.keyMac)
    const expected = bootstrap && Buffer.from(nativeGenerationKeyMac(bootstrap, {
      format: record.format, key: record.key, owner: record.owner, createdAt: record.createdAt,
    }))
    return key.length === 32 && !!expected && supplied.length === expected.length && timingSafeEqual(supplied, expected) ? key : null
  } catch { return null }
}

async function readNativeAuthorityGenerationOwner(path: string): Promise<TombstoneOwner | null> {
  try {
    const bytes = await readFile(path)
    const record = JSON.parse(bytes.toString('utf8')) as Partial<WindowsGenerationKeyRecord>
    const key = await readNativeAuthorityGenerationKey(path)
    return key && record.format === WINDOWS_GENERATION_KEY_FORMAT && record.owner
      && Number.isSafeInteger(record.owner.pid) && record.owner.pid > 0
      && (typeof record.owner.instance === 'string' || record.owner.instance === null)
      && record.owner.active === true ? record.owner as TombstoneOwner : null
  } catch { return null }
}

async function writeNativeAuthorityGenerationKeyExclusive(path: string, key: Buffer,
  openFile: typeof open, platform: NodeJS.Platform): Promise<void> {
  const owner = { pid: process.pid, instance: await processInstance(process.pid), active: true }
  const createdAt = Date.now()
  const nonce = randomBytes(32)
  const claim = dirname(path)
  const claimStats = await lstat(claim, { bigint: true })
  const bootstrap: WindowsGenerationBootstrapRecord = { format: WINDOWS_GENERATION_BOOTSTRAP_FORMAT,
    nonce: nonce.toString('base64url'), owner, createdAt,
    claim: { dev: BigInt(claimStats.dev).toString(), ino: BigInt(claimStats.ino).toString() } }
  const bootstrapPath = join(claim, 'generation.bootstrap')
  const bootstrapStaged = `${bootstrapPath}.staged.${randomUUID()}`
  const bootstrapHandle = await openFile(bootstrapStaged, 'wx', 0o600)
  try { await bootstrapHandle.writeFile(JSON.stringify(bootstrap)); await bootstrapHandle.sync() }
  finally { await bootstrapHandle.close().catch(() => undefined) }
  await syncDirectory(claim, openFile, platform)
  try { await link(bootstrapStaged, bootstrapPath); await syncDirectory(claim, openFile, platform) }
  finally { await rm(bootstrapStaged, { force: true }).catch(() => undefined); await syncDirectory(claim, openFile, platform) }
  const unsigned: Omit<WindowsGenerationKeyRecord, 'keyMac'> = {
    format: WINDOWS_GENERATION_KEY_FORMAT, key: key.toString('base64url'),
    owner, createdAt,
  }
  const staged = `${path}.staged.${randomUUID()}`
  const handle = await openFile(staged, 'wx', 0o600)
  try { await handle.writeFile(JSON.stringify({ ...unsigned, keyMac: nativeGenerationKeyMac(nonce, unsigned) })); await handle.sync() }
  finally { await handle.close().catch(() => undefined) }
  await syncDirectory(dirname(path), openFile, platform)
  try { await link(staged, path); await syncDirectory(dirname(path), openFile, platform) }
  finally { await rm(staged, { force: true }).catch(() => undefined); await syncDirectory(dirname(path), openFile, platform) }
}

/** A collector can leave controls under a private `.collected.*` name after
 * its authenticated detach, so generation key lookup must treat that name as
 * the same durable authority. */
async function readNativeAuthorityGenerationKeyForClaim(claim: string): Promise<Buffer | null> {
  try {
    const names = await readdir(claim)
    const candidates = [
      join(claim, 'generation.key'),
      join(claim, 'recovery.key'),
      ...names.filter(name => name.startsWith('generation.key.staged.')).map(name => join(claim, name)),
      ...names.filter(name => name.startsWith('generation.key.collected.')).map(name => join(claim, name)),
      ...names.filter(name => name.startsWith('recovery.key.collected.')).map(name => join(claim, name)),
    ]
    const keys = (await Promise.all(candidates.map(readNativeAuthorityGenerationKey)))
      .filter((key): key is Buffer => key !== null)
    // During the final handoff the same inode deliberately has both the old
    // bootstrap name and an immutable recovery name. It is one authority,
    // not an ambiguity; different keys remain fail-closed.
    return keys.length > 0 && keys.every(key => key.equals(keys[0]!)) ? keys[0]! : null
  } catch { return null }
}

/** Once every signed control has been consumed, a valid final or collected
 * generation key is orphaned recovery debris.  Consume every exact inode so
 * a crash after the detach can finish rather than pinning the claim forever. */
async function removeNativeAuthorityGenerationKeys(claim: string): Promise<boolean> {
  const entries = await readdir(claim)
  for (const entry of entries) {
    if (entry !== 'generation.key' && !entry.startsWith('generation.key.collected.') && !entry.startsWith('generation.key.staged.')) continue
    const path = join(claim, entry)
    const key = await readNativeAuthorityGenerationKey(path)
    if (!key) return false
    try {
      const expected = identity(await lstat(path, { bigint: true }))
      if (await removeExactTombstone(path, expected, candidate => lstat(candidate, { bigint: true }), rm, rename) !== 'removed') return false
    } catch { return false }
  }
  return true
}

/** Move bootstrap authority into a distinguishable recovery generation before
 * retiring `generation.key`. The final election remains authenticated by the
 * recovery name through every crash boundary; a bare generation key still
 * means an in-flight initializer and is never collected by this path. */
async function handoffNativeAuthorityGenerationKey(claim: string): Promise<boolean> {
  try {
    const entries = await readdir(claim)
    const names = ['generation.key', ...entries.filter(name => name.startsWith('generation.key.collected.') || name.startsWith('generation.key.staged.'))]
    const sources = names.map(name => join(claim, name))
    const valid = (await Promise.all(sources.map(async path => {
      const key = await readNativeAuthorityGenerationKey(path)
      return key ? { path, key, identity: identity(await lstat(path, { bigint: true })) } : null
    }))).filter((entry): entry is { path: string; key: Buffer; identity: PublishedFileIdentity } => entry !== null)
    if (valid.length === 0) {
      // The elected caller already authenticated this recovery generation;
      // this is the durable state after bootstrap-key retirement, not an
      // unauthorised key-only initializer.
      if (await readNativeAuthorityGenerationKeyForClaim(claim) !== null) return true
      // Existing permanent authority generations never owned a bootstrap
      // key. The final election is already MACed by authority, so cleanup
      // must not wait forever for a generation.key that cannot exist.
      return await readTrustedNativeAuthority(claim.slice(0, -'.claim'.length)).then(() => true, () => false)
    }
    // A real crash can leave original and `.collected` names hard-linked to
    // the same inode. Treat identical aliases as a single generation.
    if (!valid.every(entry => entry.key.equals(valid[0]!.key)
      && sameIdentity(entry.identity, valid[0]!.identity))) return false
    const source = valid[0]!
    const recovery = join(claim, 'recovery.key')
    // Do not add a third hard link when a crash already left a collected
    // bootstrap alias.  Rename is an atomic one-name handoff and leaves the
    // remaining exact aliases for authenticated collection.
    try { await rename(source.path, recovery) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return false
    }
    const recoveryKey = await readNativeAuthorityGenerationKey(recovery)
    const recoveryIdentity = identity(await lstat(recovery, { bigint: true }))
    if (!recoveryKey || !recoveryKey.equals(source.key) || !sameIdentity(recoveryIdentity, source.identity)) return false
    // The recovery name must survive a power loss before bootstrap retirement.
    await syncDirectory(claim, open, process.platform)
    const removed = await removeNativeAuthorityGenerationKeys(claim)
    if (removed) await syncDirectory(claim, open, process.platform)
    return removed
  } catch { return false }
}

async function removeNativeAuthorityRecoveryKey(claim: string): Promise<boolean> {
  try {
    const entries = (await readdir(claim)).filter(entry => entry === 'recovery.key' || entry.startsWith('recovery.key.collected.'))
    for (const entry of entries) {
      const path = join(claim, entry)
      if (!await readNativeAuthorityGenerationKey(path)
        || await removeExactTombstone(path, identity(await lstat(path, { bigint: true })), candidate => lstat(candidate, { bigint: true }), rm, rename) !== 'removed') return false
    }
    // Keep the independently authenticated bootstrap nonce until every
    // recovery-key alias has been retired; otherwise a crash can turn a
    // selected recovery record into an unauthenticated pathname.
    const bootstrap = join(claim, 'generation.bootstrap')
    try {
      if (await removeExactTombstone(bootstrap, identity(await lstat(bootstrap, { bigint: true })),
        candidate => lstat(candidate, { bigint: true }), rm, rename) !== 'removed') return false
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false }
    if (entries.length > 0) await syncDirectory(claim, open, process.platform)
    return true
  } catch { return false }
}

/** A bootstrap generation contains its own signed owner election. A live
 * initializer remains protected, while an abandoned key-only crash prefix
 * can now be completed instead of pinning the authority forever. */
async function hasOnlyNativeAuthorityGenerationKeys(claim: string): Promise<boolean> {
  try {
    const entries = await readdir(claim)
    if (entries.length === 0 || !entries.every(entry => entry === 'generation.key' || entry === 'generation.bootstrap'
      || entry.startsWith('generation.key.staged.') || entry.startsWith('generation.key.collected.'))) return false
    const generations = await Promise.all(entries.filter(entry => entry !== 'generation.bootstrap').map(async entry => {
      const path = join(claim, entry)
      const [owner, key, stats, bytes] = await Promise.all([
        readNativeAuthorityGenerationOwner(path), readNativeAuthorityGenerationKey(path),
        lstat(path, { bigint: true }), readFile(path),
      ])
      return owner && key ? { owner, key, identity: identity(stats), createdAt: (JSON.parse(bytes.toString('utf8')) as WindowsGenerationKeyRecord).createdAt } : null
    }))
    if (generations.some(generation => generation === null)) return false
    const first = generations[0]
    if (!first) return false
    return Date.now() - first.createdAt >= WINDOWS_RECLAIMER_TAKEOVER_AGE_MS
      && generations.every(generation => generation !== null && generation.owner.pid === first.owner.pid
        && generation.owner.instance === first.owner.instance && generation.key.equals(first.key)
        && sameIdentity(generation.identity, first.identity))
      && !await defaultOwnerActive(first.owner)
  } catch { return false }
}

/** A bootstrap stage is independent owner debt, never an empty claim.  Its
 * complete staged/final record is reclaimed only after the recorded process
 * incarnation is gone, so a live initializer cannot lose generation.key to
 * an empty-claim fallback. */
async function hasOnlyNativeAuthorityBootstrap(claim: string): Promise<boolean> {
  try {
    const names = await readdir(claim)
    if (names.length === 0 || !names.every(name => name === 'generation.bootstrap' || name.startsWith('generation.bootstrap.staged.'))) return false
    const claimStats = await lstat(claim, { bigint: true })
    const records = await Promise.all(names.map(async name => {
      const path = join(claim, name)
      const [stats, bytes] = await Promise.all([lstat(path, { bigint: true }), readFile(path, 'utf8')])
      const record = JSON.parse(bytes) as Partial<WindowsGenerationBootstrapRecord>
      if (!stats.isFile() || stats.isSymbolicLink() || !validNativeGenerationOwner(record.owner)
        || record.format !== WINDOWS_GENERATION_BOOTSTRAP_FORMAT || !Number.isSafeInteger(record.createdAt)
        || !record.claim || BigInt(record.claim.dev) !== BigInt(claimStats.dev) || BigInt(record.claim.ino) !== BigInt(claimStats.ino)) return null
      return record as WindowsGenerationBootstrapRecord
    }))
    const first = records[0]
    return !!first && records.every(record => record && record.owner.pid === first.owner.pid
      && record.owner.instance === first.owner.instance && record.createdAt === first.createdAt && record.nonce === first.nonce)
      && Date.now() - first.createdAt >= WINDOWS_RECLAIMER_TAKEOVER_AGE_MS && !await defaultOwnerActive(first.owner)
  } catch { return false }
}

async function removeNativeAuthorityBootstraps(claim: string): Promise<boolean> {
  try {
    for (const name of await readdir(claim)) {
      if (name !== 'generation.bootstrap' && !name.startsWith('generation.bootstrap.staged.')) return false
      const path = join(claim, name)
      if (await removeExactTombstone(path, identity(await lstat(path, { bigint: true })),
        candidate => lstat(candidate, { bigint: true }), rm, rename) !== 'removed') return false
    }
    await syncDirectory(claim, open, process.platform)
    return true
  } catch { return false }
}

async function hasOnlyNativeAuthorityRecoveryKey(claim: string): Promise<boolean> {
  try { return (await readdir(claim)).every(entry => entry === 'recovery.key' || entry === 'generation.bootstrap'
    || entry.startsWith('recovery.key.collected.')) } catch { return false }
}

async function readNativeAuthorityClaim(path: string, authorityPath: string, claim: PublishedFileIdentity): Promise<{
  path: string; record: WindowsAuthorityClaimRecord; identity: PublishedFileIdentity; signingKey: Buffer
} | null> {
  try {
    const before = identity(await lstat(path, { bigint: true }))
    if (before.symbolicLink) return null
    const record = JSON.parse(await readFile(path, 'utf8')) as Partial<WindowsAuthorityClaimRecord>
    if (record.format !== WINDOWS_AUTHORITY_CLAIM_FORMAT || (record.role !== 'lease' && record.role !== 'reclaimer')
      || !record.owner || !Number.isSafeInteger(record.owner.pid) || record.owner.pid <= 0
      || (typeof record.owner.instance !== 'string' && record.owner.instance !== null) || record.owner.active !== true
      || typeof record.generation !== 'string' || record.generation.length < 8
      || !Number.isSafeInteger(record.createdAt) || record.createdAt < 0
      || !record.claim || typeof record.claim.dev !== 'string' || typeof record.claim.ino !== 'string'
      || BigInt(record.claim.dev) !== claim.dev || BigInt(record.claim.ino) !== claim.ino
      || typeof record.authorityMac !== 'string') return null
    const given = Buffer.from(record.authorityMac)
    const keys = [await readTrustedNativeAuthority(authorityPath).catch(() => null),
      await readNativeAuthorityGenerationKeyForClaim(dirname(path))].filter((key): key is Buffer => key !== null)
    const signingKey = keys.find(key => {
      const expectedBytes = Buffer.from(nativeWindowsAuthorityClaimMac(key, authorityPath, {
        format: record.format, role: record.role, owner: record.owner, generation: record.generation,
        createdAt: record.createdAt, claim: record.claim,
      }))
      return given.length === expectedBytes.length && timingSafeEqual(given, expectedBytes)
    })
    if (!signingKey) return null
    const after = identity(await lstat(path, { bigint: true }))
    return sameIdentity(before, after)
      ? { path, record: record as WindowsAuthorityClaimRecord, identity: before, signingKey }
      : null
  } catch { return null }
}

async function readNativeAuthorityClaimOrStaged(path: string, authorityPath: string, claim: PublishedFileIdentity): Promise<{
  path: string; record: WindowsAuthorityClaimRecord; identity: PublishedFileIdentity; signingKey: Buffer
} | null> {
  try {
    // A link-before-unlink collector can leave any number of names for the
    // *same* signed control.  Counting names made that harmless crash prefix
    // permanently busy.  Coalesce only exact inode-and-record aliases: two
    // distinct authenticated generations are still an election conflict.
    const candidates = (await Promise.all([
      path,
      ...(await readdir(dirname(path)))
        .filter(entry => entry.startsWith(`${basename(path)}.staged.`) || entry.startsWith(`${basename(path)}.collected.`))
        .map(entry => join(dirname(path), entry)),
    ].map(candidate => readNativeAuthorityClaim(candidate, authorityPath, claim))))
      .filter((candidate): candidate is { path: string; record: WindowsAuthorityClaimRecord; identity: PublishedFileIdentity; signingKey: Buffer } => candidate !== null)
    if (candidates.length === 0) return null
    const first = candidates[0]!
    return candidates.every(candidate => sameIdentity(candidate.identity, first.identity)
      && sameNativeAuthorityClaimRecord(candidate.record, first.record)
      && candidate.signingKey.equals(first.signingKey))
      ? (candidates.find(candidate => candidate.path === path) ?? first)
      : null
  } catch { return null }
}

async function nativeAuthorityClaimRecord(authorityPath: string, claim: PublishedFileIdentity,
  role: WindowsAuthorityClaimRecord['role'], generationKey?: Buffer): Promise<WindowsAuthorityClaimRecord> {
  const key = generationKey ?? await readTrustedNativeAuthority(authorityPath)
  const unsigned: Omit<WindowsAuthorityClaimRecord, 'authorityMac'> = {
    format: WINDOWS_AUTHORITY_CLAIM_FORMAT, role,
    owner: { pid: process.pid, instance: await processInstance(process.pid), active: true },
    generation: randomUUID(), createdAt: Date.now(), claim: { dev: claim.dev.toString(), ino: claim.ino.toString() },
  }
  return { ...unsigned, authorityMac: nativeWindowsAuthorityClaimMac(key, authorityPath, unsigned) }
}

/** Write an election record as a complete, durable, no-clobber file.  This is
 * also used for the generation claim: a crash must leave either no name or a
 * record that another process can authenticate, never a truncated authority
 * decision. */
async function writeNativeAuthorityClaimExclusive(
  path: string, record: WindowsAuthorityClaimRecord, openFile: typeof open,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  // A final `wx` write can strand an empty final name if the process dies
  // between open and sync. Stage the complete record and hard-link it into
  // the final name instead: link is an atomic no-clobber publication.
  const staged = `${path}.staged.${randomUUID()}`
  const handle = await openFile(staged, 'wx', 0o600)
  try {
    await handle.writeFile(JSON.stringify(record))
    await handle.sync()
  } finally { await handle.close().catch(() => undefined) }
  // The staged bytes and their directory entry are both durable before the
  // no-clobber link.  Otherwise a crash can leave an election that looks
  // absent to one reclaimer and half-published to another.
  await syncDirectory(dirname(path), openFile, platform)
  try { await link(staged, path); await syncDirectory(dirname(path), openFile, platform) } finally {
    // If another recovery won the final name, discard only this unique staged
    // inode. A crash here leaves a complete authenticated staged copy, which
    // stale-claim cleanup below consumes before rmdir.
    await rm(staged, { force: true }).catch(() => undefined)
    await syncDirectory(dirname(path), openFile, platform)
  }
}

async function removeNativeAuthorityClaimStaging(claim: string, claimPath: string,
  authority: string, proof: PublishedFileIdentity, selected?: { path: string }): Promise<void> {
  const prefix = `${basename(claimPath)}.`
  for (const entry of await readdir(claim)) {
    // A collected control is a resumable recovery record, not disposable
    // staging. Its selected path is authenticated and removed explicitly.
    if (!entry.startsWith(`${prefix}staged.`)) continue
    const candidate = join(claim, entry)
    if (candidate === selected?.path) continue
    // Do not turn a stage-shaped foreign file into deletion authority.
    // Complete authenticated reclaimer and election debris is collectible.
    const authenticated = await readNativeAuthorityClaim(candidate, authority, proof)
    if (authenticated && !await removeNativeAuthorityClaimExact(candidate, authenticated, authority, proof)) {
      throw new Error(`native authority staging record changed: ${candidate}`)
    }
  }
}

/** A final control must not hide private aliases from a previous collector.
 * Consume each MAC-authenticated collected sibling while leaving the final
 * election itself live as recovery authority. */
async function consumeNativeAuthorityCollectedAliases(claim: string, claimPath: string,
  authority: string, proof: PublishedFileIdentity): Promise<void> {
  const final = await readNativeAuthorityClaim(claimPath, authority, proof)
  for (const entry of await readdir(claim)) {
    if (!entry.startsWith(`${basename(claimPath)}.collected.`)) continue
    const candidate = await readNativeAuthorityClaim(join(claim, entry), authority, proof)
    if (!candidate || (final && (!sameIdentity(candidate.identity, final.identity)
      || !sameNativeAuthorityClaimRecord(candidate.record, final.record)))) {
      throw new Error(`native authority collected record is not an alias: ${entry}`)
    }
    if (!await removeNativeAuthorityClaimExact(candidate.path, candidate, authority, proof)) {
      throw new Error(`native authority collected record changed: ${entry}`)
    }
  }
}

/** Authenticate the selected final or collected control before retiring it. */
async function removeNativeAuthorityClaimExact(path: string,
  expected: { path: string; record: WindowsAuthorityClaimRecord; identity: PublishedFileIdentity },
  authority: string, proof: PublishedFileIdentity): Promise<boolean> {
  // A final control belongs to the elected, exclusive claim directory. The
  // election is the no-replace transition. A collected name is already private
  // and immutable, so it is consumed in place.
  void path
  const controlPath = expected.path
  const current = await readNativeAuthorityClaim(controlPath, authority, proof)
  if (!current || !sameIdentity(current.identity, expected.identity)
    || !sameNativeAuthorityClaimRecord(current.record, expected.record)) return false
  // A final lookup is not permission to ignore an older collected alias.
  // Every such alias is independently MAC-checked and consumed before this
  // generation can retire its reclaimer or key.
  for (const entry of await readdir(dirname(controlPath))) {
    if ((!entry.startsWith(`${basename(path)}.collected.`) && !entry.startsWith(`${basename(path)}.staged.`))
      || join(dirname(controlPath), entry) === controlPath) continue
    const sibling = await readNativeAuthorityClaim(join(dirname(controlPath), entry), authority, proof)
    if (!sibling) return false
    if (sibling.path.includes('.collected.')) {
      try { await rm(sibling.path, { force: true }); await syncDirectory(dirname(controlPath), open, process.platform) } catch { return false }
    } else if (await removeNativeAuthorityClaimExact(sibling.path, sibling, authority, proof) === false) return false
  }
  if (controlPath.includes('.collected.')) {
    try { await rm(controlPath, { force: true }); await syncDirectory(dirname(controlPath), open, process.platform); return true } catch { return false }
  }
  const collected = `${controlPath}.collected.${randomUUID()}`
  try {
    // The exclusive claim directory serializes every compliant publication.
    // Move the public control in one atomic transition; never validate a
    // reusable pathname and later unlink it through a separate ABA window.
    await rename(controlPath, collected)
    await syncDirectory(dirname(controlPath), open, process.platform)
    const captured = await readNativeAuthorityClaim(collected, authority, proof)
    if (!captured || !sameIdentity(captured.identity, expected.identity)
      || !sameNativeAuthorityClaimRecord(captured.record, expected.record)) {
      return false
    }
    await rm(collected, { force: true })
    await syncDirectory(dirname(controlPath), open, process.platform)
    return true
  } catch { return false }
}

function sameNativeAuthorityClaimRecord(
  left: WindowsAuthorityClaimRecord, right: WindowsAuthorityClaimRecord,
): boolean {
  return left.generation === right.generation
    && left.createdAt === right.createdAt
    && left.owner.pid === right.owner.pid
    && left.owner.instance === right.owner.instance
    && left.owner.active === right.owner.active
    && left.claim.dev === right.claim.dev
    && left.claim.ino === right.claim.ino
    && left.authorityMac === right.authorityMac
}

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

function windowsTombstoneNamespacePrefix(filePath: string): string {
  return `.${basename(filePath)}.native-cli-tombstones.p`
}

function windowsTombstoneNamespace(
  filePath: string, owner: TombstoneOwner, run: string,
): string {
  return join(dirname(filePath), `${windowsTombstoneNamespacePrefix(filePath)}${owner.pid}.s${owner.instance ?? 'unknown'}.r${run}`)
}

function windowsNamespaceReceiptPath(directory: string): string {
  return join(directory, WINDOWS_NAMESPACE_RECEIPT)
}

/** A final receipt that was claimed into `.collected.*` before a crash is
 * retained recovery authority. It is never renamed back over a possible
 * successor; authenticated cleanup consumes that claimed copy in place. */
async function windowsNamespaceReceiptPathForRecovery(
  directory: string, statFile: StatFile = path => lstat(path, { bigint: true }),
): Promise<string | null> {
  const finalReceipt = windowsNamespaceReceiptPath(directory)
  try { await statFile(finalReceipt); return finalReceipt } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null
  }
  try {
    const claimed = (await readdir(directory)).filter(entry => entry.startsWith(`${WINDOWS_NAMESPACE_RECEIPT}.collected.`))
    return claimed.length === 1 ? join(directory, claimed[0]) : null
  } catch { return null }
}

function windowsRetirementNamespace(directory: string, stats: FileStats): string {
  const identity = namespaceIdentityFromStats(stats)
  return `${directory}.retired.d${identity.dev}.i${identity.ino}`
}

function windowsRetirementIdentity(name: string): { dev: bigint; ino: bigint } | null {
  const match = /\.retired\.d(\d+)\.i(\d+)$/.exec(name)
  return match ? { dev: BigInt(match[1]), ino: BigInt(match[2]) } : null
}

function windowsNamespaceOwnerFromName(filePath: string, name: string): { owner: TombstoneOwner; run: string } | undefined {
  const escaped = windowsTombstoneNamespacePrefix(filePath).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`^${escaped}(\\d+)\\.s([A-Za-z0-9_-]+)\\.r([0-9a-f-]{36})(?:\\.pending\\.d(\\d+)\\.i(\\d+))?$`).exec(name)
  if (!match) return undefined
  return { owner: { pid: Number(match[1]), instance: match[2] === 'unknown' ? null : match[2], active: true }, run: match[3] }
}

function windowsPendingIdentity(name: string): { dev: bigint; ino: bigint } | null {
  const match = /\.pending\.d(\d+)\.i(\d+)$/.exec(name)
  return match ? { dev: BigInt(match[1]), ino: BigInt(match[2]) } : null
}

function tombstonePrefix(filePath: string): string {
  return `${basename(filePath)}.`
}

function tombstoneIdentityPath(path: string): string {
  return `${path}.identity.json`
}

function isTombstoneIdentitySidecar(name: string): boolean {
  return name.endsWith('.identity.json') || name.includes('.identity.json.staged.') || name.includes('.identity.json.collected.')
}

function tombstoneBodyPathForSidecar(path: string): string {
  const marker = '.identity.json'
  const index = path.indexOf(marker)
  return index === -1 ? path : path.slice(0, index)
}

/** A collector can crash after it has claimed the body but before it removes
 * it. Its durable receipt remains at the original body name, so recovery
 * must not manufacture a second, receipt-less tombstone namespace. */
function collectedTombstoneOriginalPath(path: string): string {
  const marker = '.collected.'
  const index = path.indexOf(marker)
  return index === -1 ? path : path.slice(0, index)
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
  const receipt = tombstoneIdentityPath(path)
  const serialized = JSON.stringify({ dev: owned.dev.toString(), ino: owned.ino.toString(), owner: owned.owner })
  // Initial receipt creation is also atomic.  A direct write can leave a
  // zero-length final name after a crash, which used to make an inactive
  // namespace impossible to reclaim.  A complete staged sidecar is promoted
  // by recovery only after it authenticates the still-observed body inode.
  const staged = `${receipt}.staged.${randomUUID()}`
  await writeFile(staged, serialized, { mode: 0o600 })
  const stagedHandle = await openFile(staged, 'r+')
  try { await stagedHandle.sync() } finally { await stagedHandle.close().catch(() => undefined) }
  await rename(staged, receipt)
  const sidecar = await openFile(receipt, 'r+')
  try { await sidecar.sync() } finally { await sidecar.close().catch(() => undefined) }
}

async function recordWindowsNamespaceReceipt(
  directory: string, receipt: Omit<WindowsNamespaceReceipt, 'authorityMac'>, openFile: typeof open = open,
): Promise<void> {
  const path = windowsNamespaceReceiptPath(directory)
  // Never truncate the only recovery authority in place.  In particular a
  // normal failed publisher changes `active` to false; a power loss in that
  // update must leave either the old, conservative receipt or a complete new
  // one, never a JSON prefix that can be mistaken for provenance.
  const staged = `${path}.staged.${randomUUID()}`
  const unsigned: Omit<WindowsNamespaceReceipt, 'authorityMac'> = {
    format: receipt.format, target: receipt.target, run: receipt.run,
    owner: receipt.owner, namespace: receipt.namespace, phase: receipt.phase,
  }
  const authority = await readTrustedWindowsNamespaceAuthority(directory)
  await writeFile(staged, JSON.stringify({
    ...unsigned,
    authorityMac: nativeWindowsNamespaceMac(authority, unsigned),
  } satisfies WindowsNamespaceReceipt), { mode: 0o600 })
  const handle = await openFile(staged, 'r+')
  try { await handle.sync() } finally { await handle.close().catch(() => undefined) }
  await rename(staged, path)
}

function isWindowsNamespaceControlEntry(entry: string): boolean {
  return entry === WINDOWS_NAMESPACE_RECEIPT
    || entry.startsWith(`${WINDOWS_NAMESPACE_RECEIPT}.staged.`)
    || entry.startsWith(`${WINDOWS_NAMESPACE_RECEIPT}.collected.`)
}

/** A stop after link(staged, authority) leaves the one valid key at nlink=2.
 * Recover only the matching staged hard link; any other two-link authority is
 * invalid rather than an excuse to rotate a published key. */
async function recoverWindowsAuthorityStaging(authority: string): Promise<void> {
  let publishedStats: BigIntStats
  try { publishedStats = await lstat(authority, { bigint: true }) } catch (error) {
    // First publication has no authority name yet; let the staged exclusive
    // create protocol establish it. A torn restart also reaches normal
    // placeholder reconciliation instead of failing in this observer.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  const published = identity(publishedStats)
  if (published.symbolicLink || BigInt(publishedStats.size) !== 32n || BigInt(publishedStats.nlink) !== 2n) return
  const staged = (await readdir(dirname(authority))).filter(name => name.startsWith(`${basename(authority)}.staged.`))
  for (const name of staged) {
    const candidate = join(dirname(authority), name)
    try {
      const observed = identity(await lstat(candidate, { bigint: true }))
      if (!observed.symbolicLink && sameIdentity(observed, published)
        && await removeExactTombstone(candidate, observed, path => lstat(path, { bigint: true }), rm, rename) === 'removed') return
    } catch {}
  }
}

async function establishWindowsNamespaceAuthority(
  directory: string, openFile: typeof open = open, platform: NodeJS.Platform = process.platform,
): Promise<void> {
  await ensureWindowsAuthorityDirectory(directory)
  const authority = windowsNamespaceAuthorityPath(directory)
  // The authority directory itself is part of the durable trust root.  Flush
  // its parent after exclusive creation/ACL validation before a receipt can
  // name a key beneath it.
  await syncDirectory(dirname(dirname(authority)), openFile, platform)
  await withWindowsAuthorityFence(authority, () => withNativeWindowsAuthorityClaim(authority, openFile, async () => {
    const validate = async (): Promise<boolean> => {
      try {
        const current = await lstat(authority, { bigint: true })
        if (!current.isFile() || current.isSymbolicLink() || BigInt(current.size) !== 32n || BigInt(current.nlink) !== 1n) return false
        await validateWindowsTombstoneNamespace(authority)
        return true
      } catch { return false }
    }
    if (!await validate()) await recoverWindowsAuthorityStaging(authority)
    if (!await validate()) {
      // Never complete a pre-ACL placeholder in place. An inherited handle
      // on that inode would retain read access to all later writes. Move the
      // non-secret predecessor aside and publish a separately ACLed inode.
      try {
        const old = await lstat(authority, { bigint: true })
        if (old.isFile() && !old.isSymbolicLink() && BigInt(old.size) < 32n) {
          await rename(authority, `${authority}.collected.${randomUUID()}`)
        } else if (old.isFile() && !old.isSymbolicLink()) throw new Error(`native CLI publication namespace authority is invalid: ${authority}`)
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      const staged = `${authority}.staged.${randomUUID()}`
      const create = await openFile(staged, 'wx', 0o600)
      try { await create.close() } catch {}
      const initial = await lstat(staged, { bigint: true })
      if (!initial.isFile() || initial.isSymbolicLink()) throw new Error(`native CLI publication namespace authority staging is invalid: ${staged}`)
      await secureWindowsTombstoneNamespace(staged, true)
      const secured = await lstat(staged, { bigint: true })
      if (!sameIdentity(identity(initial), identity(secured))) throw new Error(`native CLI publication namespace authority staging was replaced: ${staged}`)
      const handle = await openFile(staged, 'r+')
      try {
        if (!sameIdentity(identity(await handle.stat({ bigint: true })), identity(secured))) throw new Error(`native CLI publication namespace authority staging was replaced: ${staged}`)
        await handle.writeFile(randomBytes(32)); await handle.sync()
      } finally { await handle.close().catch(() => undefined) }
      try { await link(staged, authority) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
      // `link` deliberately leaves two names for the inode. Remove our
      // staging link before applying the published-key single-link check.
      const published = await lstat(authority, { bigint: true })
      if (sameIdentity(identity(published), identity(secured))) {
        if (await removeExactTombstone(staged, identity(secured), path => lstat(path, { bigint: true }), rm, rename) !== 'removed') {
          throw new Error(`native CLI publication namespace authority staging could not be removed: ${staged}`)
        }
      } else {
        // A concurrent initializer won the name. It must not be replaced.
        if (await removeExactTombstone(staged, identity(secured), path => lstat(path, { bigint: true }), rm, rename) !== 'removed') {
          throw new Error(`native CLI publication namespace authority staging changed: ${staged}`)
        }
      }
    }
    const verified = await lstat(authority, { bigint: true })
    if (!verified.isFile() || verified.isSymbolicLink() || BigInt(verified.size) !== 32n || BigInt(verified.nlink) !== 1n
      || !await validate()) {
      throw new Error(`native CLI publication namespace authority is invalid: ${authority}`)
    }
    await validateWindowsTombstoneNamespace(authority)
    await syncDirectory(dirname(authority), openFile, platform)
  }, {}, platform))
}

/** Serialize placeholder rotation between native processes as well as within
 * this runtime. The claim is created exclusively in the already sealed
 * authority directory, and a dead claimant is reclaimed by its exact inode. */
type NativeAuthorityClaimHooks = {
  /** Test-only scheduling seam at the last safe observation before cleanup. */
  beforeDelete?: () => Promise<void>
}

async function withNativeWindowsAuthorityClaim<T>(authority: string, openFile: typeof open,
  operation: () => Promise<T>, hooks: NativeAuthorityClaimHooks = {}, platform: NodeJS.Platform = process.platform): Promise<T> {
  const claim = `${authority}.claim`
  const lease = join(claim, 'lease.json')
  const reclaimer = join(claim, 'reclaimer.json')
  const generation = join(claim, 'generation.key')
  const generationClaim = join(claim, 'generation.claim.json')
  let claimIdentity: PublishedFileIdentity | undefined
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await mkdir(claim, { mode: 0o700 })
      claimIdentity = identity(await lstat(claim, { bigint: true }))
      const existingKey = await readTrustedNativeAuthority(authority).catch(() => null)
      const generationKey = existingKey ? undefined : randomBytes(32)
      if (generationKey) {
        await writeNativeAuthorityGenerationKeyExclusive(generation, generationKey, openFile, platform)
      }
      // Lease creation has the same staged, durable no-clobber protocol as an
      // election.  A final empty lease cannot be authenticated or recovered.
      await writeNativeAuthorityClaimExclusive(lease,
        await nativeAuthorityClaimRecord(authority, claimIdentity, 'lease', generationKey), openFile, platform)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      try {
        // A directory lease makes the handoff no-replace. A successor cannot
        // create this directory until the stale holder has been removed, and
        // the reclaimer never touches the claim pathname after rmdir.
        const first = identity(await lstat(claim, { bigint: true }))
        if (first.symbolicLink || !(await lstat(claim, { bigint: true })).isDirectory()) {
          await setTimeout(10 * (attempt + 1)); continue
        }
        const held = await readNativeAuthorityClaimOrStaged(lease, authority, first)
        if (!held || held.record.role !== 'lease') {
          const stranded = await readNativeAuthorityClaimOrStaged(reclaimer, authority, first)
          const electedOnly = !stranded
            ? await readNativeAuthorityClaimOrStaged(generationClaim, authority, first)
            : null
          // A crash after the old reclaimer was collected leaves the elected
          // generation as the sole authority. It is not an empty claim: after
          // its owner is proven gone, finish the remaining key-only phase.
          if (electedOnly && electedOnly.record.role === 'reclaimer'
            && Date.now() - electedOnly.record.createdAt >= WINDOWS_RECLAIMER_TAKEOVER_AGE_MS
            && !await defaultOwnerActive(electedOnly.record.owner)
            && sameIdentity(first, identity(await lstat(claim, { bigint: true })))) {
            try {
              await removeNativeAuthorityClaimStaging(claim, lease, authority, first)
              await removeNativeAuthorityClaimStaging(claim, reclaimer, authority, first)
              await removeNativeAuthorityClaimStaging(claim, generationClaim, authority, first, electedOnly)
              if (!await handoffNativeAuthorityGenerationKey(claim)) throw new Error('native authority generation key changed')
              if (!await removeNativeAuthorityClaimExact(generationClaim, electedOnly, authority, first)) throw new Error('native authority election changed')
              if (!await removeNativeAuthorityRecoveryKey(claim)) throw new Error('native authority recovery key changed')
              await rmdir(claim); continue
            } catch { await setTimeout(10 * (attempt + 1)); continue }
          }
          if (stranded && stranded.record.role === 'reclaimer'
            && Date.now() - stranded.record.createdAt >= WINDOWS_RECLAIMER_TAKEOVER_AGE_MS
            && !await defaultOwnerActive(stranded.record.owner)
            && sameIdentity(first, identity(await lstat(claim, { bigint: true })))) {
            // A missing lease is a distinct crash state. generation.claim is
            // a durable copy of the exact authenticated reclaimer generation,
            // not a separate anonymous lock. EEXIST after a crash can thus be
            // adopted only with matching signer, owner, and age evidence.
            // Head's direct-final writer could have died between `wx` and
            // `sync`, leaving an unreadable final generation claim. The
            // authenticated dead reclaimer is sufficient recovery authority
            // for that exact directory, so discard only that torn name and
            // republish through the staged no-clobber protocol.
            // An unauthenticated final election is retained as forensic debt.
            // Absence is not authority to delete a name another process may
            // have published after our observation.
            const ours = await nativeAuthorityClaimRecord(authority, first, 'reclaimer', stranded.signingKey)
            try {
              await writeNativeAuthorityClaimExclusive(generationClaim, ours, openFile, platform)
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
            }
            const reread = await readNativeAuthorityClaimOrStaged(reclaimer, authority, first)
            const elected = await readNativeAuthorityClaimOrStaged(generationClaim, authority, first)
            if (reread && elected && sameIdentity(reread.identity, stranded.identity)
              // The final election is exclusive ownership, not a shared
              // observation.  An EEXIST observer must never clean under the
              // winner's record (even when it has the same signing key).
              && sameNativeAuthorityClaimRecord(elected.record, ours)
              && !await defaultOwnerActive(reread.record.owner)
              && sameIdentity(first, identity(await lstat(claim, { bigint: true })))) {
              // Re-observe after a deliberately adversarial scheduling point:
              // a different directory inode is a valid successor, not input
              // to pathname cleanup by this stale reclaimer.
              const beforeDelete = identity(await lstat(claim, { bigint: true }))
              const finalReclaimer = await readNativeAuthorityClaimOrStaged(reclaimer, authority, first)
              const finalElection = await readNativeAuthorityClaimOrStaged(generationClaim, authority, first)
              if (sameIdentity(first, beforeDelete) && finalReclaimer && finalElection
                && sameIdentity(finalReclaimer.identity, stranded.identity)
                && sameNativeAuthorityClaimRecord(finalElection.record, ours)
                && !await defaultOwnerActive(finalReclaimer.record.owner)) {
                try {
                  // Test hook is deliberately after the final claim-inode
                  // validation: exact control retirement below must still
                  // refuse a successor installed in this last gap.
                  await hooks.beforeDelete?.()
                  await consumeNativeAuthorityCollectedAliases(claim, generationClaim, authority, first)
                  const finalLease = await readNativeAuthorityClaimOrStaged(lease, authority, first)
                  if (finalLease && !await removeNativeAuthorityClaimExact(lease, finalLease, authority, first)) throw new Error('native authority lease changed')
                  // A selected staged lease is its own exact consumer. Do not
                  // sweep stage-shaped names before that consumer retires it.
                  await removeNativeAuthorityClaimStaging(claim, lease, authority, first)
                  await removeNativeAuthorityClaimStaging(claim, reclaimer, authority, first, finalReclaimer)
                  // The reclaimer/election pair stays published through every
                  // other cleanup transition. A crash therefore always leaves
                  // an exclusive authenticated owner, never an empty election.
                  if (!await removeNativeAuthorityClaimExact(reclaimer, finalReclaimer, authority, first)) throw new Error('native authority reclaimer changed')
                  await removeNativeAuthorityClaimStaging(claim, generationClaim, authority, first, finalElection)
                  if (!await handoffNativeAuthorityGenerationKey(claim)) throw new Error('native authority generation key changed')
                  // The elected final remains until its authentication root
                  // has retired. A crash can therefore never expose a
                  // key-only cleanup state as a live initializer.
                  if (!await removeNativeAuthorityClaimExact(generationClaim, finalElection, authority, first)) throw new Error('native authority election changed')
                  if (!await removeNativeAuthorityRecoveryKey(claim)) throw new Error('native authority recovery key changed')
                  await rmdir(claim); continue
                } catch { await setTimeout(10 * (attempt + 1)); continue }
              }
            } else if (reread && elected && sameIdentity(reread.identity, stranded.identity)
              && Date.now() - elected.record.createdAt >= WINDOWS_RECLAIMER_TAKEOVER_AGE_MS
              && !await defaultOwnerActive(reread.record.owner)
              && !await defaultOwnerActive(elected.record.owner)
              && sameIdentity(first, identity(await lstat(claim, { bigint: true })))) {
              // Transfer an abandoned election by claiming its exact inode
              // into a private collection name.  This is the only path that
              // permits a new owner after a crashed election winner.
              if (!await removeNativeAuthorityClaimExact(generationClaim, elected, authority, first)) throw new Error('native authority election changed')
            }
          }
          let empty = false
          try { await lstat(lease, { bigint: true }) } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
              try { await lstat(reclaimer, { bigint: true }) } catch (reclaimerError) {
                if ((reclaimerError as NodeJS.ErrnoException).code === 'ENOENT') {
                  try { await lstat(generation, { bigint: true }) } catch (generationError) { empty = (generationError as NodeJS.ErrnoException).code === 'ENOENT' }
                }
              }
            }
          }
          if (await hasOnlyNativeAuthorityBootstrap(claim)
            && sameIdentity(first, identity(await lstat(claim, { bigint: true })))) {
            try { if (await removeNativeAuthorityBootstraps(claim)) { await rmdir(claim); continue } } catch {}
          }
          if (await hasOnlyNativeAuthorityGenerationKeys(claim)
            && sameIdentity(first, identity(await lstat(claim, { bigint: true })))) {
            try { if (await removeNativeAuthorityGenerationKeys(claim)) { await rmdir(claim); continue } } catch {}
          }
          if (await hasOnlyNativeAuthorityRecoveryKey(claim)
            && sameIdentity(first, identity(await lstat(claim, { bigint: true })))) {
            try { if (await removeNativeAuthorityRecoveryKey(claim)) { await rmdir(claim); continue } } catch {}
          }
          if (empty && sameIdentity(first, identity(await lstat(claim, { bigint: true })))) {
            // Enumerate every residue at the final boundary. A stage-shaped
            // generation is live owner evidence, not empty-claim debris.
            try { if ((await readdir(claim)).length === 0) { await rmdir(claim); continue } } catch {}
          }
          await setTimeout(10 * (attempt + 1)); continue
        }
        const authenticated = identity(await lstat(claim, { bigint: true }))
        if (!sameIdentity(first, authenticated)
          || await defaultOwnerActive(held.record.owner)) {
          await setTimeout(10 * (attempt + 1)); continue
        }
        // generation.key is the authentication root until the replacement
        // authority inode has been published.  A dead first-generation lease
        // must therefore be reclaimable without reading a valid authority.
        const ours = await nativeAuthorityClaimRecord(authority, first, 'reclaimer', held.signingKey)
        try { await writeNativeAuthorityClaimExclusive(reclaimer, ours, openFile, platform) } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
            const stale = await readNativeAuthorityClaimOrStaged(reclaimer, authority, first)
            if (stale && stale.record.role === 'reclaimer' && Date.now() - stale.record.createdAt >= WINDOWS_RECLAIMER_TAKEOVER_AGE_MS
              && !await defaultOwnerActive(stale.record.owner)) {
              const reread = await readNativeAuthorityClaimOrStaged(reclaimer, authority, first)
              if (reread && sameIdentity(reread.identity, stale.identity)
                && reread.record.generation === stale.record.generation && !await defaultOwnerActive(reread.record.owner)) {
                if (!await removeNativeAuthorityClaimExact(reclaimer, reread, authority, first)) throw new Error('native authority reclaimer changed')
              }
            }
            if (!stale) {
              // A malformed final reclaimer has no authenticated owner.  It
              // remains durable evidence rather than a pathname we may clear.
            }
          }
          await setTimeout(10 * (attempt + 1)); continue
        }
        const beforeRelease = identity(await lstat(claim, { bigint: true }))
        const leaseBeforeRelease = await readNativeAuthorityClaimOrStaged(lease, authority, first)
        const reclaimerBeforeRelease = await readNativeAuthorityClaimOrStaged(reclaimer, authority, first)
        if (!sameIdentity(first, beforeRelease) || !leaseBeforeRelease || leaseBeforeRelease.record.role !== 'lease'
          || leaseBeforeRelease.record.generation !== held.record.generation || await defaultOwnerActive(leaseBeforeRelease.record.owner)
          || !reclaimerBeforeRelease || reclaimerBeforeRelease.record.role !== 'reclaimer'
          || reclaimerBeforeRelease.record.generation !== ours.generation) {
          if (reclaimerBeforeRelease?.record.role === 'reclaimer'
            && reclaimerBeforeRelease.record.generation === ours.generation) {
              if (!await removeNativeAuthorityClaimExact(reclaimer, reclaimerBeforeRelease, authority, first)) throw new Error('native authority reclaimer changed')
          }
          await setTimeout(10 * (attempt + 1)); continue
        }
        try {
          // This inode check is immediately adjacent to cleanup. A stale
          // reclaimer which was descheduled after validation must leave a
          // newly installed claim directory untouched.
          if (!sameIdentity(first, identity(await lstat(claim, { bigint: true })))) {
            await setTimeout(10 * (attempt + 1)); continue
          }
          // Deliberately after the last validation. Each exact control
          // mutation re-authenticates its expected inode, so a successor
          // cannot be unlinked through the reusable public pathname.
          await hooks.beforeDelete?.()
          if (!await removeNativeAuthorityClaimExact(lease, leaseBeforeRelease, authority, first)) throw new Error('native authority lease changed')
          await removeNativeAuthorityClaimStaging(claim, lease, authority, first)
          // A reclaimer is not an election by itself: publish the durable
          // generation ownership before retiring it, so no crash exposes a
          // key-only prefix with no authenticated recovery owner.
          const cleanupElection = await nativeAuthorityClaimRecord(authority, first, 'reclaimer', reclaimerBeforeRelease.signingKey)
          await writeNativeAuthorityClaimExclusive(generationClaim, cleanupElection, openFile, platform)
          const elected = await readNativeAuthorityClaimOrStaged(generationClaim, authority, first)
          if (!elected || !sameNativeAuthorityClaimRecord(elected.record, cleanupElection)) {
            throw new Error('native authority cleanup election was not published')
          }
          await consumeNativeAuthorityCollectedAliases(claim, generationClaim, authority, first)
          await removeNativeAuthorityClaimStaging(claim, reclaimer, authority, first, reclaimerBeforeRelease)
          // The reclaimer is the exclusive election while a lease cleanup is
          // in progress. It is deliberately removed only after every other
          // authenticated control has been consumed.
          if (!await removeNativeAuthorityClaimExact(reclaimer, reclaimerBeforeRelease, authority, first)) throw new Error('native authority reclaimer changed')
          await removeNativeAuthorityClaimStaging(claim, generationClaim, authority, first, elected)
          const election = await readNativeAuthorityClaimOrStaged(generationClaim, authority, first)
          if (!election || !sameNativeAuthorityClaimRecord(election.record, cleanupElection)) throw new Error('native authority cleanup election changed')
          if (!await handoffNativeAuthorityGenerationKey(claim)) throw new Error('native authority generation key changed')
          if (election && !await removeNativeAuthorityClaimExact(generationClaim, election, authority, first)) throw new Error('native authority election changed')
          if (!await removeNativeAuthorityRecoveryKey(claim)) throw new Error('native authority recovery key changed')
          await rmdir(claim)
        } catch { await setTimeout(10 * (attempt + 1)); continue }
      } catch { await setTimeout(10 * (attempt + 1)) }
    }
  }
  if (!claimIdentity) throw new Error(`native CLI publication authority claim is busy: ${authority}`)
  let operationError: unknown
  try { return await operation() } catch (error) {
    operationError = error
    throw error
  } finally {
    let cleanupError: unknown
    try {
      if (sameIdentity(claimIdentity, identity(await lstat(claim, { bigint: true })))) {
        // Once the operation has returned, the permanent authority inode is
        // valid.  Transfer the live lease to a durable cleanup election
        // before touching it, so every crash through key collection retains
        // an exclusive authenticated owner.
        const cleanupElection = await nativeAuthorityClaimRecord(authority, claimIdentity, 'reclaimer')
        await writeNativeAuthorityClaimExclusive(generationClaim, cleanupElection, openFile, platform)
        const elected = await readNativeAuthorityClaimOrStaged(generationClaim, authority, claimIdentity)
        if (!elected || !sameNativeAuthorityClaimRecord(elected.record, cleanupElection)) {
          throw new Error('native CLI publication cleanup election was not published')
        }
        await consumeNativeAuthorityCollectedAliases(claim, generationClaim, authority, claimIdentity)
        const finalLease = await readNativeAuthorityClaimOrStaged(lease, authority, claimIdentity)
        if (finalLease && !await removeNativeAuthorityClaimExact(lease, finalLease, authority, claimIdentity)) throw new Error('native authority lease changed')
        await removeNativeAuthorityClaimStaging(claim, lease, authority, claimIdentity)
        await removeNativeAuthorityClaimStaging(claim, reclaimer, authority, claimIdentity)
        await removeNativeAuthorityClaimStaging(claim, generationClaim, authority, claimIdentity, elected)
        // The election remains live while all other signed controls and the
        // bootstrap key are consumed.  It is signed by permanent authority,
        // so generation.key is no longer needed to resume this final phase.
        const finalElection = await readNativeAuthorityClaimOrStaged(generationClaim, authority, claimIdentity)
        if (!finalElection || !sameNativeAuthorityClaimRecord(finalElection.record, cleanupElection)) {
          throw new Error('native CLI publication cleanup election changed')
        }
        if (!await handoffNativeAuthorityGenerationKey(claim)) throw new Error('native authority generation key changed')
        if (finalElection && !await removeNativeAuthorityClaimExact(generationClaim, finalElection, authority, claimIdentity)) throw new Error('native authority election changed')
        if (!await removeNativeAuthorityRecoveryKey(claim)) throw new Error('native authority recovery key changed')
        await rmdir(claim)
      }
    } catch (error) { cleanupError = error }
    // A successful publication with an unretired live lease/election is not
    // success.  Retain the on-disk evidence for recovery, but surface the
    // cleanup failure; when the body also failed, preserve both causes.
    if (cleanupError) {
      if (operationError) {
        throw new AggregateError([operationError, cleanupError], 'native CLI publication and authority cleanup both failed')
      }
      throw cleanupError
    }
  }
}

/** Direct primitive for race tests. Production callers use the process-local
 * fence in establishWindowsNamespaceAuthority; this deliberately bypasses it
 * so tests exercise genuinely competing on-disk recoverers. */
export async function __testWithNativeWindowsAuthorityClaim<T>(
  authority: string, operation: () => Promise<T>, hooks?: NativeAuthorityClaimHooks,
): Promise<T> {
  return withNativeWindowsAuthorityClaim(authority, open, operation, hooks)
}

function namespaceIdentityFromStats(stats: FileStats): { dev: string; ino: string } {
  return { dev: BigInt(stats.dev).toString(), ino: BigInt(stats.ino).toString() }
}

async function readWindowsNamespaceReceipt(
  directory: string, expectedTarget: string, expected: { owner: TombstoneOwner; run: string },
  read: typeof readFile = readFile, statFile: StatFile = path => lstat(path, { bigint: true }),
  receiptPathOverride?: string,
): Promise<WindowsNamespaceReceipt | null> {
  try {
    const receiptPath = receiptPathOverride ?? await windowsNamespaceReceiptPathForRecovery(directory, statFile)
    if (!receiptPath) return null
    const receipt = JSON.parse(await read(receiptPath, 'utf8')) as Partial<WindowsNamespaceReceipt>
    if (receipt.format !== WINDOWS_NAMESPACE_RECEIPT_FORMAT || receipt.target !== expectedTarget || receipt.run !== expected.run
      || !receipt.owner || typeof receipt.owner !== 'object') return null
    const owner = receipt.owner as TombstoneOwner
    if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0
      || (typeof owner.instance !== 'string' && owner.instance !== null) || typeof owner.active !== 'boolean'
      || owner.pid !== expected.owner.pid || owner.instance !== expected.owner.instance) return null
    if (!receipt.namespace || typeof receipt.namespace !== 'object'
      || typeof receipt.namespace.dev !== 'string' || typeof receipt.namespace.ino !== 'string'
      || !['pending', 'active', 'inactive'].includes(receipt.phase as string)
      || typeof receipt.authorityMac !== 'string') return null
    const observed = await statFile(directory)
    if (!observed.isDirectory() || observed.isSymbolicLink()
      || BigInt(receipt.namespace.dev) !== BigInt(observed.dev)
      || BigInt(receipt.namespace.ino) !== BigInt(observed.ino)) return null
    return receipt as WindowsNamespaceReceipt
  } catch { return null }
}

/** Recover a complete namespace control receipt before treating a retained
 * directory as nonempty/rejected. Its final name is claimed with link so a
 * concurrent recovered successor is never overwritten. */
async function recoverWindowsNamespaceReceiptStaging(
  directory: string, target: string, expected: { owner: TombstoneOwner; run: string }, directoryStats: FileStats,
  statFile: StatFile, read: typeof readFile, removeFile: typeof rm, renameFile: typeof rename,
  isOwnerActive: (owner: TombstoneOwner) => Promise<boolean> = defaultOwnerActive,
): Promise<boolean> {
  const staged = (await readdir(directory)).filter(entry => entry.startsWith(`${WINDOWS_NAMESPACE_RECEIPT}.staged.`))
  if (staged.length !== 1) return false
  const stagedPath = join(directory, staged[0])
  try {
    await validateWindowsTombstoneNamespace(directory)
    const stagedStats = await statFile(stagedPath)
    const stagedReceipt = JSON.parse(await read(stagedPath, 'utf8')) as WindowsNamespaceReceipt
    if (!stagedStats.isFile() || stagedStats.isSymbolicLink()
      || stagedReceipt.format !== WINDOWS_NAMESPACE_RECEIPT_FORMAT
      || stagedReceipt.target !== target || stagedReceipt.run !== expected.run
      || stagedReceipt.owner?.pid !== expected.owner.pid || stagedReceipt.owner?.instance !== expected.owner.instance
      || stagedReceipt.namespace?.dev !== BigInt(directoryStats.dev).toString()
      || stagedReceipt.namespace?.ino !== BigInt(directoryStats.ino).toString()
      || !await hasValidNativeWindowsNamespaceMac(directory, stagedReceipt)
      // A staged control record is still owned by the publisher which wrote
      // it.  In particular, do not turn a live publisher's normal final
      // rename into a recovery promotion merely because its complete staged
      // bytes are visible after a concurrent scan.
      || await isOwnerActive({ ...expected.owner, active: true })) return false
    const finalReceipt = windowsNamespaceReceiptPath(directory)
    try {
      const torn = identity(await statFile(finalReceipt))
      // A complete final is a successor. A torn final is retained under a
      // private collected name, then the authenticated staged generation is
      // published with a no-clobber hard link.
      const final = await readWindowsNamespaceReceipt(directory, target, expected, read, statFile, finalReceipt)
      if (torn.symbolicLink || (final && await hasValidNativeWindowsNamespaceMac(directory, final))) return false
      const beforeClaim = identity(await statFile(finalReceipt))
      if (!sameIdentity(torn, beforeClaim)) return false
      await renameFile(finalReceipt, `${finalReceipt}.collected.${randomUUID()}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false
    }
    // Re-probe at the mutation boundary.  A PID reuse / resumed publisher is
    // never allowed to inherit an earlier abandoned-owner observation.
    if (await isOwnerActive({ ...expected.owner, active: true })) return false
    try { await link(stagedPath, finalReceipt) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
      throw error
    }
    return await removeExactTombstone(stagedPath, identity(stagedStats), statFile, removeFile, renameFile) === 'removed'
  } catch { return false }
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
    if (!validOwner) return { kind: 'missing-or-malformed' }
    return { kind: 'valid', identity: { dev: BigInt(parsed.dev), ino: BigInt(parsed.ino), owner: owner as TombstoneOwner } }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code && (error as NodeJS.ErrnoException).code !== 'ENOENT'
      ? { kind: 'operational-failure' }
      : { kind: 'missing-or-malformed' }
  }
}

/** A sidecar is written through a synced staged name.  If power fails after
 * that sync and before rename, promote exactly one complete staged receipt
 * only while the corresponding body still has the inode it names. */
async function recoverStagedTombstoneIdentity(
  path: string, statFile: StatFile, read: typeof readFile, renameFile: typeof rename,
  isOwnerActive: (owner: TombstoneOwner) => Promise<boolean> = defaultOwnerActive,
): Promise<TombstoneIdentityRead | null> {
  const receipt = tombstoneIdentityPath(path)
  let staged: string[]
  try {
    staged = (await readdir(dirname(receipt))).filter(entry => entry.startsWith(`${basename(receipt)}.staged.`))
  } catch { return null }
  if (staged.length !== 1) return null
  const stagedPath = join(dirname(receipt), staged[0])
  try {
    const stagedStats = await statFile(stagedPath)
    if (!stagedStats.isFile() || stagedStats.isSymbolicLink()) return null
    const parsed = JSON.parse(await read(stagedPath, 'utf8')) as Partial<TombstoneIdentity>
    if ((typeof parsed.dev !== 'number' && typeof parsed.dev !== 'string')
      || (typeof parsed.ino !== 'number' && typeof parsed.ino !== 'string')) return null
    const owner = parsed.owner
    const validOwner = owner && typeof owner === 'object' && Number.isSafeInteger((owner as TombstoneOwner).pid)
      && (typeof (owner as TombstoneOwner).instance === 'string' || (owner as TombstoneOwner).instance === null)
      && typeof (owner as TombstoneOwner).active === 'boolean'
    // A staged receipt belongs to its live publisher until that publisher has
    // definitely stopped. Promoting it while live races the publisher's own
    // final rename and can turn a normal write into a recovery mutation.
    if (!validOwner || await isOwnerActive(owner as TombstoneOwner)) return null
    const identityReceipt: TombstoneIdentity = { dev: BigInt(parsed.dev), ino: BigInt(parsed.ino), owner: owner as TombstoneOwner }
    const body = identity(await statFile(path))
    // This is deliberately the final async observation before promotion: a
    // replacement body must survive rather than inherit an old receipt.
    if (body.symbolicLink || !sameInode(body, identityReceipt)) return null
    try { await statFile(receipt); return null } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null
    }
    const beforeRename = identity(await statFile(path))
    if (beforeRename.symbolicLink || !sameInode(beforeRename, identityReceipt)
      || await isOwnerActive(owner as TombstoneOwner)) return null
    // `rename` would overwrite a sidecar installed after the absence check.
    // Hard-link promotion is the cross-process no-clobber claim; cleanup of
    // the staged name is separately identity checked below.
    try { await link(stagedPath, receipt) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null
      throw error
    }
    if (await removeExactTombstone(stagedPath, identity(stagedStats), statFile, rm, renameFile) !== 'removed') return null
    return { kind: 'valid', identity: identityReceipt }
  } catch { return null }
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

async function secureWindowsTombstoneNamespace(directory: string, establish = true): Promise<void> {
  // Unit tests can model a Windows publication on another host. Only a real
  // Windows process can establish/inspect Windows ACLs.
  if (process.platform !== 'win32') return
  const literal = directory.replace(/'/g, "''")
  const program = [
    "$ErrorActionPreference='Stop'",
    `$p='${literal}'`,
    '$identity=[Security.Principal.WindowsIdentity]::GetCurrent()',
    '$sid=$identity.User',
    '$ownerSid=if($identity.Owner){$identity.Owner}else{$sid}',
    '$acl=Get-Acl -LiteralPath $p',
    'if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $ownerSid.Value){exit 61}',
    ...(establish ? [
      '$acl.SetAccessRuleProtection($true,$false)',
      'foreach($rule in @($acl.Access)){[void]$acl.RemoveAccessRuleAll($rule)}',
      // A key is a file, while a namespace needs inheritance. PowerShell
      // preserves the correct rule shape when the target is inspected first.
      "$inherit=if((Get-Item -LiteralPath $p).PSIsContainer){'ContainerInherit,ObjectInherit'}else{'None'}",
      "$rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl',$inherit,'None','Allow')",
      '$acl.AddAccessRule($rule)',
      'Set-Acl -LiteralPath $p -AclObject $acl',
    ] : []),
    '$after=Get-Acl -LiteralPath $p',
    'if(-not $after.AreAccessRulesProtected -or $after.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $ownerSid.Value){exit 62}',
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

/** The ACL belongs to CreateDirectoryW, not to a later repair. This avoids
 * even a moment in which an inherited-DACL namespace can contain a staging
 * secret. */
async function createWindowsPrivateDirectoryAtomically(directory: string): Promise<void> {
  if (process.platform !== 'win32') {
    await mkdir(directory, { mode: 0o700 })
    return
  }
  const literal = directory.replace(/'/g, "''")
  const source = 'using System;using System.Runtime.InteropServices;public static class NativePrivateDirectory{[StructLayout(LayoutKind.Sequential)]public struct SA{public int nLength;public IntPtr lpSecurityDescriptor;public bool bInheritHandle;}[DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]public static extern bool CreateDirectory(string p,ref SA sa);}'
  const program = [
    `$p='${literal}'`, `$src='${source}'`, 'Add-Type -TypeDefinition $src',
    '$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User',
    '$acl=New-Object Security.AccessControl.DirectorySecurity', '$acl.SetOwner($sid)', '$acl.SetAccessRuleProtection($true,$false)',
    "$rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')", '$acl.AddAccessRule($rule)',
    '$bytes=$acl.GetSecurityDescriptorBinaryForm()', '$pin=[Runtime.InteropServices.GCHandle]::Alloc($bytes,[Runtime.InteropServices.GCHandleType]::Pinned)',
    'try{$sa=New-Object NativePrivateDirectory+SA;$sa.nLength=[Runtime.InteropServices.Marshal]::SizeOf($sa);$sa.lpSecurityDescriptor=$pin.AddrOfPinnedObject();if(-not [NativePrivateDirectory]::CreateDirectory($p,[ref]$sa)){exit [Runtime.InteropServices.Marshal]::GetLastWin32Error()}}finally{$pin.Free()}',
  ].join(';')
  await new Promise<void>((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(program, 'utf16le').toString('base64')], { stdio: 'ignore', windowsHide: true })
    child.once('error', reject)
    child.once('close', code => {
      if (code === 0) resolve()
      else {
        const error = new Error(`native CLI publication private Windows directory creation failed: ${directory}`) as NodeJS.ErrnoException
        error.code = code === 183 ? 'EEXIST' : 'EACCES'
        reject(error)
      }
    })
  })
}

async function ensureWindowsAuthorityDirectory(directory: string): Promise<void> {
  const authorityDirectory = dirname(windowsNamespaceAuthorityPath(directory))
  try { await createWindowsPrivateDirectoryAtomically(authorityDirectory) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const stats = await lstat(authorityDirectory, { bigint: true })
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error(`native CLI publication namespace authority directory is not private: ${authorityDirectory}`)
  await validateWindowsTombstoneNamespace(authorityDirectory)
}

/** A recovery process must validate rather than repair an old namespace.
 * Repairing it would turn an attacker-owned directory into our authority. */
async function validateWindowsTombstoneNamespace(directory: string): Promise<void> {
  return secureWindowsTombstoneNamespace(directory, false)
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
  directory = tombstoneDirectory(filePath),
): Promise<string> {
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

async function createWindowsTombstoneNamespace(
  filePath: string, owner: TombstoneOwner, run: string, publication: PublicationRename,
): Promise<string> {
  const requestedDirectory = windowsTombstoneNamespace(filePath, owner, run)
  const statFile: StatFile = publication.lstat ?? (path => lstat(path, { bigint: true }))
  // A random run id is not permission to reuse an existing path.  Exclusive
  // creation is what distinguishes this implementation's namespace from a
  // merely private-looking directory placed by somebody else.
  if (process.platform === 'win32') await createWindowsPrivateDirectoryAtomically(requestedDirectory)
  else await mkdir(requestedDirectory, { mode: 0o700 })
  let initial: FileStats | undefined = await statFile(requestedDirectory)
  let directory = requestedDirectory
  try {
    // The directory's DACL was supplied to its exclusive creation primitive;
    // this is validation only, never a post-create permission repair.
    if (publication.secureNamespace) await publication.secureNamespace(requestedDirectory, 'win32')
    else await validateWindowsTombstoneNamespace(requestedDirectory)
    const stats = await statFile(requestedDirectory)
    // ACL setup is an externally visible pathname operation.  It must not
    // turn a successor installed during setup into the namespace we sign.
    if (!initial || BigInt(initial.dev) !== BigInt(stats.dev) || BigInt(initial.ino) !== BigInt(stats.ino)
      || !isPrivateTombstoneNamespace(stats, 'win32')) {
      throw new Error(`native CLI publication tombstone namespace is not private: ${requestedDirectory}`)
    }
    // The pending name makes the creation-before-receipt and torn-receipt
    // windows recoverable without treating an arbitrary run-looking path as
    // authority.  It carries the inode observed immediately after exclusive
    // mkdir/ACL establishment.
    const pendingDirectory = `${requestedDirectory}.pending.d${stats.dev}.i${stats.ino}`
    // Do not forget the only exact creation pathname until rename actually
    // succeeds. A sharing violation here used to make catch inspect the
    // not-yet-existent pending name and leave the original run unbounded.
    await rename(requestedDirectory, pendingDirectory)
    directory = pendingDirectory
    await establishWindowsNamespaceAuthority(directory, publication.open ?? open, publication.platform ?? process.platform)
    await recordWindowsNamespaceReceipt(directory, {
      format: WINDOWS_NAMESPACE_RECEIPT_FORMAT, target: filePath, run, owner, phase: 'pending',
      namespace: namespaceIdentityFromStats(stats),
    }, publication.open ?? open)
    await recordWindowsNamespaceReceipt(directory, {
      format: WINDOWS_NAMESPACE_RECEIPT_FORMAT, target: filePath, run, owner, phase: 'active',
      namespace: namespaceIdentityFromStats(stats),
    }, publication.open ?? open)
    ownedWindowsNamespaces.set(directory, { dev: BigInt(stats.dev), ino: BigInt(stats.ino) })
    return directory
  } catch (error) {
    // This invocation exclusively created the name. Setup failures therefore
    // retire only the exact, still-empty/control-only inode now, rather than
    // leaving a long-lived process able to accumulate one unbounded failed
    // run per retry. A substituted or foreign child is never removed.
    try {
      const current = await statFile(directory)
      const expected = initial && BigInt(initial.dev) === BigInt(current.dev) && BigInt(initial.ino) === BigInt(current.ino)
      const entries = expected && current.isDirectory() && !current.isSymbolicLink() ? await readdir(directory) : []
      if (expected && entries.every(isWindowsNamespaceControlEntry)) {
        for (const entry of entries) {
          const control = join(directory, entry)
          const observed = identity(await statFile(control))
          if (observed.symbolicLink || await removeExactTombstone(control, observed, statFile, rm) !== 'removed') {
            throw new Error('native CLI publication setup control was replaced')
          }
        }
        await rmdir(directory)
      }
    } catch {}
    throw error
  }
}

async function removeExactTombstone(
  path: string,
  expected: TombstoneIdentity,
  statFile: StatFile,
  removeFile: typeof rm,
  renameFile: typeof rename = rename,
): Promise<'removed' | 'identity-mismatch' | 'operational-failure'> {
  if (path.includes('.collected.')) {
    try {
      const current = identity(await statFile(path))
      if (current.symbolicLink || !sameInode(current, expected)) return 'identity-mismatch'
      await removeFile(path, { force: true })
      return 'removed'
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'identity-mismatch' : 'operational-failure'
    }
  }
  const collected = `${path}.collected.${randomUUID()}`
  try {
    // This path is in an owner-only tombstone namespace.  Claim an immutable
    // alias without detaching the reusable name, and validate the public
    // generation again before either name is removed.
    const before = identity(await statFile(path))
    if (before.symbolicLink || !sameInode(before, expected)) return 'identity-mismatch'
    await link(path, collected)
    const current = identity(await statFile(collected))
    const publicCurrent = identity(await statFile(path))
    if (current.symbolicLink || publicCurrent.symbolicLink
      || !sameInode(current, expected) || !sameInode(publicCurrent, expected)) {
      return 'identity-mismatch'
    }
    await removeFile(path, { force: true })
    await removeFile(collected, { force: true })
    return 'removed'
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? 'identity-mismatch'
      : 'operational-failure'
  }
}

/** Move an empty, receipt-authenticated namespace through a durable retired
 * name before unlinking its final receipt.  If power fails after that unlink,
 * the identity-bearing retired name is still discoverable and only an empty
 * directory with the recorded inode can be removed. */
async function retireWindowsNamespace(
  directory: string, expected: { dev: bigint; ino: bigint },
  publication: Pick<PublicationRename, 'platform' | 'rename' | 'lstat' | 'rm' | 'rmdir' | 'syncDirectory'>,
): Promise<void> {
  const statFile: StatFile = publication.lstat ?? (path => lstat(path, { bigint: true }))
  const removeFile = publication.rm ?? rm
  const directoryStats = await statFile(directory)
  if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()
    || BigInt(directoryStats.dev) !== expected.dev || BigInt(directoryStats.ino) !== expected.ino) {
    throw new Error('native CLI publication namespace replaced before retirement')
  }
  const retired = windowsRetirementNamespace(directory, directoryStats)
  await rename(directory, retired)
  const sync = publication.syncDirectory ?? (path => syncDirectory(path, open, 'win32'))
  await sync(dirname(directory))
  // Do not unlink the only restart authority merely because an earlier
  // cleanup loop *intended* to remove every body. Re-enumerate after the
  // retirement rename: a failed/unflushed body removal leaves the receipt in
  // place and the retired name is recoverable after a crash.
  const remaining = await readdir(retired)
  const recoveryReceipt = await windowsNamespaceReceiptPathForRecovery(retired, statFile)
  if (!recoveryReceipt || remaining.length !== 1 || !remaining.includes(basename(recoveryReceipt))) {
    throw new Error('native CLI publication namespace is not empty before receipt retirement')
  }
  // Node has no Windows directory durability barrier.  The first sweep only
  // claims the authenticated final receipt; a later sweep must rediscover
  // that claimed inode before consuming it.  This makes no fsync assumption
  // while still allowing authenticated abandoned runs to converge.
  if ((publication.platform ?? process.platform) === 'win32') {
    const receiptPath = recoveryReceipt
    if (basename(receiptPath) === WINDOWS_NAMESPACE_RECEIPT) {
      const receiptIdentity = identity(await statFile(receiptPath))
      const claimed = `${receiptPath}.collected.${randomUUID()}`
      await rename(receiptPath, claimed)
      if (!sameIdentity(receiptIdentity, identity(await statFile(claimed)))) {
        throw new Error('native CLI publication namespace receipt was replaced before collection')
      }
      ownedWindowsNamespaces.delete(directory)
      throw new Error('native CLI publication Windows receipt awaits a later sweep')
    }
  }
  // The receipt remains present until every non-receipt entry has been
  // durably removed. Only this final unlink may make the directory empty.
  const receiptPath = recoveryReceipt
  const receipt = identity(await statFile(receiptPath))
  if (receipt.symbolicLink || await removeExactTombstone(receiptPath, receipt, statFile, removeFile,
    publication.rename ?? rename) !== 'removed') {
    throw new Error('native CLI publication namespace receipt was replaced before retirement')
  }
  await sync(retired)
  await (publication.rmdir ?? rmdir)(retired)
  await sync(dirname(directory))
  ownedWindowsNamespaces.delete(directory)
}

/** Restart recovery for Windows run-private namespaces.  We never repair ACLs
 * here: a previous namespace is authority only when its immutable-looking
 * receipt matches its exclusive-creation name.  In particular, a name plus a
 * private DACL is not sufficient authority to delete it. */
async function scavengeWindowsNativeCliPublicationTombstones(
  filePath: string,
  publication: Partial<Pick<PublicationRename, 'rename' | 'lstat' | 'rm' | 'rmdir' | 'readFile' | 'isOwnerActive' | 'syncDirectory'>>,
): Promise<NativeCliPublicationTombstoneReport> {
  const parent = dirname(filePath)
  const statFile: StatFile = publication.lstat ?? (path => lstat(path, { bigint: true }))
  const removeFile = publication.rm ?? rm
  const renameFile = publication.rename ?? rename
  const readIdentityFile = publication.readFile ?? readFile
  const isOwnerActive = publication.isOwnerActive ?? defaultOwnerActive
  const cleanupDebt: string[] = []
  let names: string[]
  try { names = await readdir(parent) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { directory: tombstoneDirectory(filePath), retained: 0, retainedBytes: 0, removed: 0, skippedReplacements: 0 }
    }
    throw error
  }
  type Candidate = { directory: string; receiptPath: string; receipt: WindowsNamespaceReceipt; entries: Array<{ path: string; identity: PublishedFileIdentity }>; sidecars: Array<{ path: string; identity: PublishedFileIdentity }>; controls: Array<{ path: string; identity: PublishedFileIdentity }>; bytes: number; newest: number }
  const candidates: Candidate[] = []
  let retained = 0
  let retainedBytes = 0
  let skippedReplacements = 0
  let removed = 0
  // A receipt may have been unlinked just before rmdir when the machine
  // stopped. Its retirement name carries the exact directory inode, so it is
  // not an unauthenticated name-based cleanup path.
  for (const name of names) {
    const retiredIdentity = windowsRetirementIdentity(name)
    if (!retiredIdentity || !name.startsWith(windowsTombstoneNamespacePrefix(filePath))) continue
    const directory = join(parent, name)
    try {
      const stats = await statFile(directory)
      if (!stats.isDirectory() || stats.isSymbolicLink()
        || BigInt(stats.dev) !== retiredIdentity.dev || BigInt(stats.ino) !== retiredIdentity.ino) {
        skippedReplacements += 1; continue
      }
      await validateWindowsTombstoneNamespace(directory)
      let entries = await readdir(directory)
      // A retirement can stop after the namespace receipt was synced under
      // its staged name. Promote that control record before an otherwise
      // nonempty directory is rejected as opaque debris.
      const originalName = name.replace(/\.retired\.d\d+\.i\d+$/, '')
      const retirementOwner = windowsNamespaceOwnerFromName(filePath, originalName)
      if (retirementOwner && await recoverWindowsNamespaceReceiptStaging(directory, filePath, retirementOwner, stats,
        statFile, readIdentityFile, removeFile, renameFile, isOwnerActive)) entries = await readdir(directory)
      // Body sidecars are independent atomic publications. Promote an
      // authenticated interrupted generation before deciding whether this
      // inactive namespace is collectible; otherwise a staged sidecar could
      // strand an otherwise bounded run forever.
      for (const staged of entries.filter(isTombstoneIdentitySidecar)) {
        if (!staged.includes('.identity.json.staged.')) continue
        const body = join(directory, staged.slice(0, staged.indexOf('.identity.json.staged.')))
        await recoverStagedTombstoneIdentity(body, statFile, readIdentityFile, renameFile, isOwnerActive)
      }
      entries = await readdir(directory)
      if (entries.length === 0) {
        await (publication.rmdir ?? rmdir)(directory)
        removed += 1
        continue
      }
      // A crash after the retirement rename but before receipt removal leaves
      // a nonempty retired directory.  Its retirement suffix binds this exact
      // inode; the still-present receipt must additionally authenticate the
      // original run before any entry is removed.
      const parsed = retirementOwner
      const receipt = parsed
        ? await readWindowsNamespaceReceipt(directory, filePath, parsed, readIdentityFile, statFile)
        : null
      const recoveryReceiptPath = await windowsNamespaceReceiptPathForRecovery(directory, statFile)
      // A failed-attempt lease is useful immediately (it keeps a long-lived
      // publisher from pinning every failed run), but only a MAC issued by
      // this implementation can make that transition.  A forged inactive
      // JSON receipt still has to wait for the named creator to exit.
      if (!receipt || !(await hasValidNativeWindowsNamespaceMac(directory, receipt))
        || await isOwnerActive({ ...parsed!.owner, active: true })
        || entries.some(entry => !isWindowsNamespaceControlEntry(entry)
          && !entry.startsWith(tombstonePrefix(filePath)))) {
        skippedReplacements += 1
        continue
      }
      // Re-observe the directory before each pathname mutation. The suffix
      // is a retirement record, not permission to operate on a replacement.
      const current = await statFile(directory)
      if (!current.isDirectory() || current.isSymbolicLink()
        || BigInt(current.dev) !== retiredIdentity.dev || BigInt(current.ino) !== retiredIdentity.ino) {
        skippedReplacements += 1
        continue
      }
      const sync = publication.syncDirectory ?? (path => syncDirectory(path, open, 'win32'))
      for (const entry of entries.filter(entry => !isWindowsNamespaceControlEntry(entry) && !isTombstoneIdentitySidecar(entry))) {
        const body = join(directory, entry)
        const observed = identity(await statFile(body))
        const bodyReceipt = await readTombstoneIdentity(collectedTombstoneOriginalPath(body), readIdentityFile)
        if (observed.symbolicLink || bodyReceipt.kind !== 'valid' || !bodyReceipt.identity.owner
          || !sameInode(observed, bodyReceipt.identity) || await isOwnerActive(bodyReceipt.identity.owner)) {
          throw new Error('native CLI publication retirement body was replaced or is unauthenticated')
        }
        if (await removeExactTombstone(body, bodyReceipt.identity, statFile, removeFile) !== 'removed') {
          throw new Error('native CLI publication retirement body was replaced before deletion')
        }
        await sync(directory)
      }
      for (const entry of (await readdir(directory)).filter(isTombstoneIdentitySidecar)) {
        const sidecar = join(directory, entry)
        const observed = identity(await statFile(sidecar))
        if (observed.symbolicLink || !(await statFile(sidecar)).isFile()) {
          throw new Error('native CLI publication retirement sidecar was replaced')
        }
        if (await removeExactTombstone(sidecar, observed, statFile, removeFile) !== 'removed') {
          throw new Error('native CLI publication retirement sidecar was replaced')
        }
        await sync(directory)
      }
      if ((await readdir(directory)).some(entry => !isWindowsNamespaceControlEntry(entry))) {
        throw new Error('native CLI publication retirement still has non-receipt entries')
      }
      if ((publication.platform ?? process.platform) === 'win32') {
        // First observation claims the final receipt; only a subsequent
        // sweep that finds the claimed, authenticated inode reaches deletion.
        if (basename(recoveryReceiptPath) === WINDOWS_NAMESPACE_RECEIPT) {
          const receiptIdentity = identity(await statFile(recoveryReceiptPath))
          const claimed = `${recoveryReceiptPath}.collected.${randomUUID()}`
          await renameFile(recoveryReceiptPath, claimed)
          if (!sameIdentity(receiptIdentity, identity(await statFile(claimed)))) {
            throw new Error('native CLI publication namespace receipt was replaced before collection')
          }
          cleanupDebt.push(directory)
          continue
        }
      }
      // The final receipt is still MAC-authenticated and the namespace DACL
      // was verified above, so staged controls are bounded cleanup rather
      // than permanent retention blockers.
      for (const entry of (await readdir(directory)).filter(entry => join(directory, entry) !== recoveryReceiptPath)) {
        const control = join(directory, entry)
        const observed = await statFile(control)
        if (!observed.isFile() || observed.isSymbolicLink()) throw new Error('staged namespace control was replaced')
        if (await removeExactTombstone(control, identity(observed), statFile, removeFile, renameFile) !== 'removed') {
          throw new Error('staged namespace control was replaced before deletion')
        }
        await sync(directory)
      }
      if (!recoveryReceiptPath) throw new Error('native CLI publication namespace receipt disappeared before deletion')
      const receiptPath = recoveryReceiptPath
      const receiptIdentity = identity(await statFile(receiptPath))
      if (receiptIdentity.symbolicLink || await removeExactTombstone(receiptPath, receiptIdentity,
        statFile, removeFile, renameFile) !== 'removed') {
        throw new Error('native CLI publication namespace receipt was replaced before deletion')
      }
      await sync(directory)
      await (publication.rmdir ?? rmdir)(directory)
      await sync(dirname(directory))
      removed += 1
    } catch { cleanupDebt.push(directory) }
  }
  for (const name of names) {
    const parsed = windowsNamespaceOwnerFromName(filePath, name)
    if (!parsed) continue
    const directory = join(parent, name)
    try {
      const directoryStats = await statFile(directory)
      // Do not call the ACL-setting helper for an old directory.  It could be
      // attacker-created; only our receipt permits inspection as debris.
      if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) { skippedReplacements += 1; continue }
      // Reconcile a synced staged receipt before rejecting a non-pending,
      // nonempty namespace. A torn final is expected after power loss and a
      // MAC-valid staged generation is the only safe way to settle it.
      let receipt = await readWindowsNamespaceReceipt(directory, filePath, parsed, readIdentityFile, statFile)
      if (!receipt && await recoverWindowsNamespaceReceiptStaging(directory, filePath, parsed, directoryStats,
        statFile, readIdentityFile, removeFile, renameFile, isOwnerActive)) {
        receipt = await readWindowsNamespaceReceipt(directory, filePath, parsed, readIdentityFile, statFile)
      }
      if (!receipt) {
        // Only the inode-bearing pending state is creation-before-receipt
        // authority once any receipt bytes exist. The tiny mkdir-before-rename
        // window has no entries at all and can only be rmdir'd when its owner
        // incarnation is gone; a plain run-looking directory plus forged
        // active:false JSON remains fail-closed.
        const pending = windowsPendingIdentity(name)
        const pendingEntries = await readdir(directory)
        if (await isOwnerActive(parsed.owner)
          || (pending && (BigInt(directoryStats.dev) !== pending.dev || BigInt(directoryStats.ino) !== pending.ino))
          || (!pending && pendingEntries.length !== 0)) { skippedReplacements += 1; continue }
        // Control-looking bytes are mutable too.  Do not clean staged files
        // without a valid MAC and protected DACL; report the namespace as
        // skipped/debt instead of letting forged pending metadata authorize
        // removal.  Empty inode-bearing creation is the only safe exception.
        if (pendingEntries.length === 0) { await (publication.rmdir ?? rmdir)(directory); removed += 1; continue }
        skippedReplacements += 1
        continue
      }
      // Only a receipt-authenticated old namespace must pass the retained
      // DACL validation. A creator can die between exclusive mkdir and ACL
      // establishment; its exact pending/empty name is separately bounded
      // and is recoverable without ever repairing that old ACL.
      await validateWindowsTombstoneNamespace(directory)
      let entryNames = await readdir(directory)
      for (const staged of entryNames.filter(entry => entry.includes('.identity.json.staged.'))) {
        const body = join(directory, staged.slice(0, staged.indexOf('.identity.json.staged.')))
        await recoverStagedTombstoneIdentity(body, statFile, readIdentityFile, renameFile, isOwnerActive)
      }
      entryNames = await readdir(directory)
      const recoveryReceiptPath = await windowsNamespaceReceiptPathForRecovery(directory, statFile)
      if (!recoveryReceiptPath || !entryNames.includes(basename(recoveryReceiptPath))
        || entryNames.some(entry => !isWindowsNamespaceControlEntry(entry)
          && !entry.startsWith(tombstonePrefix(filePath)))) { skippedReplacements += 1; continue }
      const entries: Candidate['entries'] = []
      const sidecars: Candidate['sidecars'] = []
      const controls: Candidate['controls'] = []
      for (const entry of entryNames.filter(entry => join(directory, entry) !== recoveryReceiptPath && isWindowsNamespaceControlEntry(entry))) {
        const path = join(directory, entry)
        const observed = identity(await statFile(path))
        if (observed.symbolicLink || !((await statFile(path)).isFile())) throw new Error('unexpected staged namespace control')
        controls.push({ path, identity: observed })
      }
      for (const entry of entryNames.filter(entry => !isWindowsNamespaceControlEntry(entry) && !isTombstoneIdentitySidecar(entry))) {
        const path = join(directory, entry)
        const observed = identity(await statFile(path))
        if (observed.symbolicLink || !((await statFile(path)).isFile())) throw new Error('unexpected tombstone debris')
        // Namespace inactivity is not authority over every name beneath it.
        // Each body carries its original-path identity; without a matching
        // receipt a replacement body remains non-collectible.
        const bodyReceipt = await readTombstoneIdentity(collectedTombstoneOriginalPath(path), readIdentityFile)
        if (bodyReceipt.kind !== 'valid' || !sameInode(observed, bodyReceipt.identity)) {
          throw new Error('native CLI publication tombstone body was replaced or is unauthenticated')
        }
        entries.push({ path, identity: observed })
      }
      for (const entry of entryNames.filter(isTombstoneIdentitySidecar)) {
        const path = join(directory, entry)
        const observed = identity(await statFile(path))
        if (observed.symbolicLink || !((await statFile(path)).isFile())) throw new Error('unexpected tombstone sidecar')
        sidecars.push({ path, identity: observed })
      }
      const controlBytes = Number((await statFile(recoveryReceiptPath)).size)
      const bytes = entries.reduce((total, entry) => total + entry.identity.size, 0)
        + sidecars.reduce((total, entry) => total + entry.identity.size, 0)
        + controls.reduce((total, entry) => total + entry.identity.size, 0) + controlBytes
      const newest = entries.reduce((latest, entry) => Math.max(latest, entry.identity.mtimeMs), 0)
      retained += entries.length + sidecars.length + controls.length + 1
      retainedBytes += bytes
      candidates.push({ directory, receiptPath: recoveryReceiptPath, receipt, entries, sidecars, controls, bytes, newest })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') cleanupDebt.push(directory)
    }
  }
  for (const candidate of candidates.sort((left, right) => left.newest - right.newest)) {
    const expired = Date.now() - candidate.newest > NATIVE_PUBLICATION_TOMBSTONE_MAX_AGE_MS
    if (!expired && retained <= NATIVE_PUBLICATION_TOMBSTONE_MAX_COUNT && retainedBytes <= NATIVE_PUBLICATION_TOMBSTONE_MAX_BYTES) continue
    // This probe is both a lease and a PID-reuse check.  It is intentionally
    // immediately before mutation, rather than inferred from the directory
    // age or the process id embedded in its name.
    const creator = windowsNamespaceOwnerFromName(filePath, basename(candidate.directory))
    if (!creator || !(await hasValidNativeWindowsNamespaceMac(candidate.directory, candidate.receipt))
      || await isOwnerActive({ ...creator.owner, active: true })) { skippedReplacements += 1; continue }
    // Re-authenticate the receipt immediately before deletion.  A stale
    // parsed receipt may never authorize removal of a replacement namespace.
    const name = basename(candidate.directory)
    const parsed = windowsNamespaceOwnerFromName(filePath, name)
    const reauthenticated = parsed
      ? await readWindowsNamespaceReceipt(candidate.directory, filePath, parsed, readIdentityFile, statFile)
      : null
    if (!reauthenticated || !(await hasValidNativeWindowsNamespaceMac(candidate.directory, reauthenticated))
      || await isOwnerActive({ ...creator.owner, active: true })) {
      skippedReplacements += 1
      continue
    }
    let complete = true
    for (const entry of candidate.entries) {
      try {
        const current = identity(await statFile(entry.path))
        if (current.symbolicLink || !sameIdentity(current, entry.identity)
          || current.size !== entry.identity.size || current.mtimeMs !== entry.identity.mtimeMs) { complete = false; break }
      } catch { complete = false; break }
    }
    if (!complete) { skippedReplacements += 1; continue }
    try {
      // Remove ordinary debris first and the namespace receipt last.  A crash
      // at any earlier point leaves a valid receipt, so the next process can
      // safely resume bounded removal; without it, the directory is ignored.
      const sync = publication.syncDirectory ?? (path => syncDirectory(path, open, 'win32'))
      // A complete MAC-authenticated receipt also authorizes cleanup of its
      // interrupted staged control generations.  Their identities are
      // retained in the candidate so a replacement cannot be removed.
      for (const control of candidate.controls) {
        const current = identity(await statFile(control.path))
        if (current.symbolicLink || !sameIdentity(current, control.identity)) throw new Error('staged namespace control was replaced')
        if (await removeExactTombstone(control.path, control.identity, statFile, removeFile, renameFile) !== 'removed') {
          throw new Error('staged namespace control was replaced before deletion')
        }
        await sync(candidate.directory)
      }
      for (const entry of candidate.entries) {
        const bodyReceipt = await readTombstoneIdentity(collectedTombstoneOriginalPath(entry.path), readIdentityFile)
        if (bodyReceipt.kind !== 'valid' || !bodyReceipt.identity.owner
          || !sameInode(bodyReceipt.identity, entry.identity)
          || await isOwnerActive(bodyReceipt.identity.owner)) {
          throw new Error('native CLI publication tombstone receipt changed before deletion')
        }
        if (await removeExactTombstone(entry.path, entry.identity, statFile, removeFile) !== 'removed') {
          throw new Error('native CLI publication body was replaced before deletion')
        }
        await sync(candidate.directory)
      }
      for (const sidecar of candidate.sidecars) {
        if (await removeExactTombstone(sidecar.path, sidecar.identity, statFile, removeFile) !== 'removed') {
          throw new Error('native CLI publication sidecar was replaced')
        }
        await sync(candidate.directory)
      }
      await retireWindowsNamespace(candidate.directory, {
        dev: candidate.receipt.namespace.dev === undefined ? -1n : BigInt(candidate.receipt.namespace.dev),
        ino: candidate.receipt.namespace.ino === undefined ? -1n : BigInt(candidate.receipt.namespace.ino),
      }, publication)
      retained -= candidate.entries.length + candidate.sidecars.length + candidate.controls.length + 1
      retainedBytes -= candidate.bytes
      removed += 1
    } catch { cleanupDebt.push(candidate.directory) }
  }
  return { directory: tombstoneDirectory(filePath), retained, retainedBytes, removed, skippedReplacements,
    ...(cleanupDebt.length === 0 ? {} : { cleanupDebt: { paths: cleanupDebt } }) }
}

export async function scavengeNativeCliPublicationTombstones(
  filePath: string,
  publication: Partial<Pick<PublicationRename, 'platform' | 'rename' | 'lstat' | 'rm' | 'rmdir' | 'readFile' | 'isOwnerActive' | 'secureNamespace' | 'syncDirectory'>> = {},
): Promise<NativeCliPublicationTombstoneReport> {
  if ((publication.platform ?? process.platform) === 'win32') {
    return scavengeWindowsNativeCliPublicationTombstones(filePath, publication)
  }
  const directory = tombstoneDirectory(filePath)
  const statFile: StatFile = publication.lstat ?? (path => lstat(path, { bigint: true }))
  const removeFile = publication.rm ?? rm
  const renameFile = publication.rename ?? rename
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
  const cleanupDebt: string[] = []
  // If the body rename committed while its synced sidecar was still staged,
  // the old source name is absent but the final wrapper carries the exact
  // inode in that sidecar. Collect only that proven post-commit residue;
  // never promote it over a fresh sidecar or infer authority from the name.
  for (const name of [...names]) {
    const marker = '.identity.json.staged.'
    const index = name.indexOf(marker)
    if (index === -1) continue
    const body = join(directory, name.slice(0, index))
    const staged = join(directory, name)
    try {
      await statFile(body)
      continue
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') continue }
    try {
      const parsed = JSON.parse(await readIdentityFile(staged, 'utf8')) as Partial<TombstoneIdentity>
      const final = identity(await statFile(filePath))
      const stagedIdentity = identity(await statFile(staged))
      const owner = parsed.owner
      const validOwner = owner && typeof owner === 'object'
        && Number.isSafeInteger((owner as TombstoneOwner).pid)
        && (typeof (owner as TombstoneOwner).instance === 'string' || (owner as TombstoneOwner).instance === null)
        && typeof (owner as TombstoneOwner).active === 'boolean'
      if ((typeof parsed.dev !== 'number' && typeof parsed.dev !== 'string')
        || (typeof parsed.ino !== 'number' && typeof parsed.ino !== 'string')
        || !validOwner || final.symbolicLink || final.dev !== BigInt(parsed.dev) || final.ino !== BigInt(parsed.ino)
        // The final target is not authority over a staged receipt.  The
        // receipt remains the live publisher's until its exact process
        // incarnation has been proven absent.
        || await isOwnerActive(owner as TombstoneOwner)) continue
      if (await removeExactTombstone(staged, stagedIdentity, statFile, removeFile, renameFile) !== 'removed') {
        cleanupDebt.push(staged)
      }
    } catch {}
  }
  names = await readdir(directory)
  const bodyNames = names.filter(name => name.startsWith(tombstonePrefix(filePath)) && !isTombstoneIdentitySidecar(name))
  // A collector moves only the body. Its receipt remains at the original
  // pathname and is not an orphan while any claimed body still names it.
  const claimedBodyBases = new Set(bodyNames.filter(name => name.includes('.collected.'))
    .map(name => collectedTombstoneOriginalPath(join(directory, name))))
  const sidecars = new Set<string>()
  const candidates = (await Promise.all(bodyNames.map(async name => {
    const path = join(directory, name)
    try {
      const stats = identity(await statFile(path))
      if (stats.symbolicLink) return null
      const sidecar = tombstoneIdentityPath(collectedTombstoneOriginalPath(path))
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
      // A collector renames only the body. Its authority receipt remains at
      // the original pathname, including during crash recovery. Never let a
      // `.collected.*` suffix redirect authentication to attacker-controlled
      // metadata at the claimed name.
      const receiptPathBase = collectedTombstoneOriginalPath(path)
      let receipt = await readTombstoneIdentity(receiptPathBase, readIdentityFile)
      if (receipt.kind === 'missing-or-malformed') {
        receipt = await recoverStagedTombstoneIdentity(receiptPathBase, statFile, readIdentityFile, renameFile, isOwnerActive) ?? receipt
      }
      if (!sidecarStats && receipt.kind === 'valid') {
        try {
          const promoted = identity(await statFile(sidecar))
          if (!promoted.symbolicLink) {
            sidecarStats = promoted
            sidecars.add(sidecar)
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') cleanupDebt.push(sidecar)
        }
      }
      if (receipt.kind === 'operational-failure') cleanupDebt.push(sidecar)
      const owner = receipt.kind === 'valid' ? receipt.identity.owner : undefined
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
  const orphanSidecars = (await Promise.all(names.filter(name => name.startsWith(tombstonePrefix(filePath)) && isTombstoneIdentitySidecar(name)).map(async name => {
    const path = join(directory, name)
    if (sidecars.has(path)) return null
    const body = tombstoneBodyPathForSidecar(path)
    if (claimedBodyBases.has(body)) return null
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
    const receipt = await readTombstoneIdentity(collectedTombstoneOriginalPath(candidate.path), readIdentityFile)
    if (receipt.kind === 'operational-failure') {
      cleanupDebt.push(candidate.sidecar)
      skippedReplacements += 1
    } else {
      // The observed inode is not fallback deletion authority. A durable
      // receipt must bind this exact body and name a probeable owner.
      if (receipt.kind !== 'valid' || !receipt.identity.owner) {
        skippedReplacements += 1
        continue
      }
      // The ownership sidecar can be replaced between selection and this
      // destructive step. Re-probe the owner from the reread receipt at the
      // mutation boundary; a renewed/live successor fails closed.
      if (await isOwnerActive(receipt.identity.owner)) {
        skippedReplacements += 1
        continue
      }
      const expected = receipt.identity
      const removal = await removeExactTombstone(candidate.path, expected, statFile, removeFile, renameFile)
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
              if (await removeExactTombstone(candidate.sidecar, candidate.sidecarStats,
                statFile, removeFile, renameFile) !== 'removed') throw new Error('native CLI publication sidecar was replaced')
              retained -= 1
              retainedBytes -= candidate.sidecarStats.size
              // `removed` is the historic body-removal count for this
              // native report; receipt disposal is reflected by retained
              // count/bytes and is deliberately not a second body removal.
            } catch { cleanupDebt.push(candidate.sidecar) }
          }
        }
      } else {
        // A non-throwing identity mismatch is still a cleanup failure.  It
        // must reach a committed publication receipt just like EIO/EACCES so
        // a reconciler can distinguish retained forensic debt from success.
        cleanupDebt.push(candidate.path)
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
    const body = tombstoneBodyPathForSidecar(orphan.path)
    try {
      await statFile(body)
      skippedReplacements += 1
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        cleanupDebt.push(body)
        continue
      }
      try {
        if (await removeExactTombstone(orphan.path, orphan.stats, statFile, removeFile, renameFile) !== 'removed') {
          cleanupDebt.push(orphan.path)
          skippedReplacements += 1
          continue
        }
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
    // A restart may find the desired wrapper already published.  Do recovery
    // before the reusable fast path so that successful reuse cannot pin a
    // prior Windows run-private namespace forever.
    const windowsPrePublicationReport = resolvedPublication.platform === 'win32'
      ? await scavengeNativeCliPublicationTombstones(filePath, resolvedPublication)
      : undefined
    const reusable = await reusableDestination(
      filePath, content, mode, resolvedPublication.platform, statFile, openFile,
    )
    if (reusable) return { status: 'unchanged', destination: reusable }

    // A pre-publication sweep can discover exact receipt I/O debt. Preserve
    // it on the eventual publication receipt even if the post-commit sweep
    // sees different filesystem state.
    const prePublicationCleanupDebt = (windowsPrePublicationReport
      ?? await scavengeNativeCliPublicationTombstones(filePath, resolvedPublication)
    ).cleanupDebt?.paths ?? []
    const instance = await processInstance(process.pid)
    const owner: TombstoneOwner = { pid: process.pid, instance, active: true }
    const windowsRun = resolvedPublication.platform === 'win32' ? randomUUID() : undefined
    const namespace = resolvedPublication.platform === 'win32'
      ? await createWindowsTombstoneNamespace(filePath, owner, windowsRun!, resolvedPublication)
      : await ensurePrivateTombstoneNamespace(filePath, resolvedPublication.platform, statFile,
        resolvedPublication.secureNamespace)
    const temporaryPath = join(namespace, `${basename(filePath)}.p${owner.pid}.s${owner.instance ?? 'unknown'}.${randomUUID()}.tmp`)
    let temporaryIdentity: TemporaryIdentity | null = null
    let committed = false
    let committedReceipt: Extract<NativeCliPublicationReceipt, { status: 'committed' }> | undefined
    try {
      // Opening is itself a publication-stage failure. Keep it inside the
      // namespace lifecycle so an empty Windows run is marked inactive and
      // retired instead of being pinned behind this still-live process.
      const writable = await openFile(temporaryPath, 'wx', 0o600)
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
          resolvedPublication.secureNamespace, namespace)
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
        let sidecarRemoved = false
        try {
          const sidecarIdentity = identity(await statFile(sidecar))
          const removal = await removeExactTombstone(sidecar, sidecarIdentity, statFile, removeFile)
          sidecarRemoved = removal === 'removed'
          // A helper status is as material as a thrown error after rename:
          // callers need the exact retained path to reconcile it.
          if (!sidecarRemoved) cleanupDebt.push(sidecar)
        } catch {
          cleanupDebt.push(sidecar)
        }
        if (resolvedPublication.platform === 'win32' && sidecarRemoved) {
          // Node has no Windows directory fsync. Retiring the final namespace
          // here would discard the only crash-recovery proof while merely
          // *assuming* directory metadata reached stable storage. Retain the
          // sealed, MAC-authenticated namespace as explicit reconciliation
          // state; restart scavenging can later authenticate and bound it.
          cleanupDebt.push(windowsNamespaceReceiptPath(namespace), namespace)
        } else if (cleanupDebt.length !== 0) {
          // POSIX retains its shared namespace because another publisher may
          // already be creating a private name beneath it.
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
          // A failed rename can race a pathname successor. Only change the
          // sidecar lease when the retained name still denotes the descriptor
          // we created; otherwise a stale failure must not label a successor.
          try {
            const current = identity(await statFile(temporaryPath))
            if (!current.symbolicLink && sameInode(current, temporaryIdentity)) {
              await recordTombstoneIdentity(temporaryPath,
                { dev: temporaryIdentity.dev, ino: temporaryIdentity.ino, owner: { ...owner, active: false } }, openFile)
            }
          } catch {}
        }
        if (resolvedPublication.platform === 'win32' && windowsRun) {
          // A normal failure is definitively no longer live. A crash leaves
          // the active receipt in place; restart uses the instance-aware probe
          // rather than trusting a potentially reused PID.
          const creation = ownedWindowsNamespaces.get(namespace)
          if (creation) {
            try {
              const current = identity(await statFile(namespace))
              if (!current.symbolicLink && sameInode(current, creation)) {
                await recordWindowsNamespaceReceipt(namespace, {
                  format: WINDOWS_NAMESPACE_RECEIPT_FORMAT, target: filePath, run: windowsRun,
                  owner: { ...owner, active: false }, phase: 'inactive',
                  namespace: { dev: creation.dev.toString(), ino: creation.ino.toString() },
                }, openFile)
                // An open failure leaves no body or sidecar. Retire this
                // exact creation immediately; recovery must not be blocked by
                // the still-live publisher PID.
                if (!temporaryIdentity) await retireWindowsNamespace(namespace, creation, resolvedPublication)
              }
            } catch {
              // The original publication error remains authoritative. A
              // retained receipt/namespace is reconciled by the next run.
            }
          }
        }
        await removeOwnedTemporary(temporaryPath, temporaryIdentity, statFile, removeFile)
        await scavengeNativeCliPublicationTombstones(filePath, resolvedPublication).catch(() => undefined)
      }
    }
  })
}
