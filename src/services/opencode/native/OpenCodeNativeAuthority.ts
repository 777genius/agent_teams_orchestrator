import { constants } from 'node:fs'
import { lstat, open, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import type { NativeCustodyReference } from './OpenCodeNativeCustody.js'
import { validateNativeProfileRoot, type NativeEpochImages } from './OpenCodeLaunchImage.js'

export type NativeAuthority = {
  schemaVersion: 1; phase: 'preparing' | 'published' | 'stopping' | 'unknown' | 'dead'
  profileRoot: string; hostKeyHash: string; scopeDigest: string; scope: unknown
  images: NativeEpochImages; reference: NativeCustodyReference | null
}
function fact(value: unknown): asserts value { if (!value) throw new Error('native_custody_authority_unknown') }
export function nativeAuthorityPath(profileRoot: string, hostKey: string): string {
  return path.join(profileRoot, 'host-authority', createHash('sha256').update(hostKey).digest('hex'), 'current-custody.json')
}
async function syncDirectory(file: string): Promise<void> {
  const directory = await open(path.dirname(file), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { await directory.sync() } finally { await directory.close() }
}
export async function readNativeAuthority(file: string): Promise<NativeAuthority> {
  const named = await lstat(file, { bigint: true })
  fact(named.isFile() && !named.isSymbolicLink() && named.nlink === 1n && named.uid === BigInt(process.getuid!()) &&
    (named.mode & 0o777n) === 0o600n && named.size > 0 && named.size <= 256000n)
  const opened = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const current = await opened.stat({ bigint: true })
    fact(current.dev === named.dev && current.ino === named.ino)
    let authority: NativeAuthority
    try { authority = JSON.parse(await opened.readFile('utf8')) as NativeAuthority }
    catch { throw new Error('native_custody_authority_unknown') }
    fact(authority && Object.keys(authority).sort().join(',') === 'hostKeyHash,images,phase,profileRoot,reference,schemaVersion,scope,scopeDigest' &&
      authority.schemaVersion === 1 && ['preparing', 'published', 'stopping', 'unknown', 'dead'].includes(authority.phase) &&
      typeof authority.profileRoot === 'string' && /^[a-f0-9]{64}$/.test(authority.hostKeyHash) &&
      /^[a-f0-9]{64}$/.test(authority.scopeDigest) && authority.images && /^[a-f0-9]{64}$/.test(authority.images.epoch))
    await validateNativeProfileRoot(authority.profileRoot)
    const host = path.join(authority.profileRoot, 'host-authority', authority.hostKeyHash)
    fact(file === path.join(host, 'current-custody.json') &&
      authority.images.root === path.join(host, 'images', authority.images.epoch) &&
      authority.images.image === path.join(authority.images.root, 'opencode') &&
      authority.images.helper === path.join(authority.images.root, 'custodian'))
    fact(createHash('sha256').update(JSON.stringify(authority.scope)).digest('hex') === authority.scopeDigest)
    const after = await opened.stat({ bigint: true })
    fact(after.mtimeNs === current.mtimeNs && after.ctimeNs === current.ctimeNs)
    return authority
  } finally { await opened.close() }
}

/** The exclusive operation file is never stolen on age, PID or lease-count guesses. */
export async function withNativeAuthorityGate<T>(file: string, work: () => Promise<T>): Promise<T> {
  const lock = `${file}.operation`
  const opened = await open(lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
  try { await opened.sync(); return await work() }
  finally { await opened.close(); await unlink(lock); await syncDirectory(file) }
}
export async function writeNativeAuthority(file: string, authority: NativeAuthority, create = false): Promise<void> {
  const bytes = Buffer.from(JSON.stringify(authority)); fact(bytes.length <= 256000)
  const temporary = create ? file : `${file}.${randomBytes(16).toString('hex')}.tmp`
  const opened = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
  try { await opened.writeFile(bytes); await opened.sync() } finally { await opened.close() }
  if (!create) await rename(temporary, file)
  await syncDirectory(file)
}

/** Only the captured custodian inherited this pre-created receipt FD. A close
 * event or absent PID alone is deliberately insufficient to retire an epoch. */
export async function nativeExitConfirmed(authority: NativeAuthority): Promise<boolean> {
  const reference = authority.reference
  if (!reference) return false
  const expected = authority.images.exitReceipt
  if (!expected || expected.file !== path.join(authority.images.root, 'native-exit.json')) return false
  try {
    const named = await lstat(expected.file, { bigint: true })
    if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1n || named.uid !== BigInt(process.getuid!()) ||
      (named.mode & 0o777n) !== 0o600n || String(named.dev) !== expected.dev || String(named.ino) !== expected.ino ||
      named.size <= 0 || named.size > 1024) return false
    const opened = await open(expected.file, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const held = await opened.stat({ bigint: true })
      if (held.dev !== named.dev || held.ino !== named.ino) return false
      const receipt = JSON.parse(await opened.readFile('utf8')) as Record<string, unknown>
      return Object.keys(receipt).sort().join(',') === 'birth,epoch,pid,protocol,status' && receipt.protocol === 1 &&
        receipt.epoch === authority.images.epoch && receipt.pid === reference.nativePid && receipt.birth === reference.nativeBirth &&
        Number.isSafeInteger(receipt.status) && Number(receipt.status) >= 0 && Number(receipt.status) <= 65535
    } finally { await opened.close() }
  } catch { return false }
}
