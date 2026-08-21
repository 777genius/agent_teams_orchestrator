import { randomUUID } from 'node:crypto'
import { constants, type BigIntStats, type Dirent } from 'node:fs'
import { lstat, open, opendir, rename, rm } from 'node:fs/promises'
import path from 'node:path'

export const OPENCODE_CATALOG_PROFILE_MANIFEST = '.catalog-attempt.json'
const MAX_SCAN = 128
const MAX_TRASH = 32
const MAX_MANIFEST = 16 * 1024

export type OpenCodeCatalogProfileCleanupReceipt = Readonly<{
  schema: 'opencode-catalog-profile-cleanup-v1'
  profileRootPath: string
  disposition: 'removed' | 'queued' | 'absent' | 'rejected'
}>

type Manifest = Readonly<{
  schema: 'opencode-catalog-attempt-profile-v1'
  createdAt: number
  heartbeatAt: number
  leaseExpiresAt: number
  leaseId: string
  ownerPid: number
  processBirthId: string
  state: 'preparing' | 'ready' | 'closed'
  runtimeInstanceId: string
  profileRootKey: string
}>

const DEFAULT_LEASE_MS = 120_000
const PROCESS_BIRTH_ID = randomUUID()

function validManifest(value: unknown, root: string): value is Manifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const parsed = value as Partial<Manifest>
  return Object.keys(parsed).sort().join(',') ===
      'createdAt,heartbeatAt,leaseExpiresAt,leaseId,ownerPid,processBirthId,profileRootKey,runtimeInstanceId,schema,state'
    && parsed.schema === 'opencode-catalog-attempt-profile-v1'
    && typeof parsed.createdAt === 'number' && Number.isSafeInteger(parsed.createdAt)
    && parsed.createdAt >= 0
    && typeof parsed.heartbeatAt === 'number' && Number.isSafeInteger(parsed.heartbeatAt)
    && parsed.heartbeatAt >= parsed.createdAt
    && typeof parsed.leaseExpiresAt === 'number' && Number.isSafeInteger(parsed.leaseExpiresAt)
    && parsed.leaseExpiresAt >= parsed.heartbeatAt
    && typeof parsed.leaseId === 'string' && /^[0-9a-f-]{16,64}$/i.test(parsed.leaseId)
    && typeof parsed.ownerPid === 'number' && Number.isSafeInteger(parsed.ownerPid)
    && parsed.ownerPid > 0
    && typeof parsed.processBirthId === 'string'
    && /^[0-9a-f-]{16,64}$/i.test(parsed.processBirthId)
    && (parsed.state === 'preparing' || parsed.state === 'ready' || parsed.state === 'closed')
    && typeof parsed.runtimeInstanceId === 'string'
    && parsed.runtimeInstanceId.length > 0 && parsed.runtimeInstanceId.length <= 256
    && typeof parsed.profileRootKey === 'string'
    && parsed.profileRootKey.length > 0 && parsed.profileRootKey.length <= 256
    && path.basename(root) === parsed.profileRootKey
}

export async function writeOpenCodeCatalogProfileManifest(input: Readonly<{
  profileRootPath: string; runtimeInstanceId: string; profileRootKey: string; createdAt?: number
  state?: Manifest['state']; heartbeatAt?: number; leaseExpiresAt?: number
  ownerPid?: number; processBirthId?: string
}>): Promise<void> {
  const manifestPath = path.join(input.profileRootPath, OPENCODE_CATALOG_PROFILE_MANIFEST)
  const existing = await readAttemptManifest(input.profileRootPath,
    path.dirname(input.profileRootPath))
  if (!existing) {
    try {
      await lstat(manifestPath)
      throw new Error('catalog profile manifest identity replacement')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  if (existing && (existing.runtimeInstanceId !== input.runtimeInstanceId
    || existing.profileRootKey !== input.profileRootKey)) {
    throw new Error('catalog profile manifest identity replacement')
  }
  const createdAt = existing?.createdAt ?? input.createdAt ?? Date.now()
  const heartbeatAt = input.heartbeatAt ?? input.createdAt ?? Date.now()
  const manifest: Manifest = { schema: 'opencode-catalog-attempt-profile-v1', createdAt,
    heartbeatAt, leaseExpiresAt: input.leaseExpiresAt ?? heartbeatAt + DEFAULT_LEASE_MS,
    leaseId: existing?.leaseId ?? randomUUID(),
    ownerPid: existing?.ownerPid ?? input.ownerPid ?? process.pid,
    processBirthId: existing?.processBirthId ?? input.processBirthId ?? PROCESS_BIRTH_ID,
    state: input.state ?? existing?.state ?? 'ready', runtimeInstanceId: input.runtimeInstanceId,
    profileRootKey: input.profileRootKey }
  if (!path.isAbsolute(input.profileRootPath) || !validManifest(manifest, input.profileRootPath)
    || (existing?.state === 'closed' && manifest.state !== 'closed')
    || (existing?.state === 'ready' && manifest.state === 'preparing')) {
    throw new Error('invalid catalog profile manifest')
  }
  const temporary = path.join(input.profileRootPath, `.catalog-attempt-${randomUUID()}.tmp`)
  const handle = await open(temporary, 'wx', 0o600)
  try { await handle.writeFile(`${JSON.stringify(manifest)}\n`); await handle.sync() }
  finally { await handle.close() }
  try { await rename(temporary, manifestPath) } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined); throw error
  }
  // rename durability is separate from file-content durability. On POSIX the
  // attempt is not ready until its containing directory records the manifest.
  if (process.platform !== 'win32') {
    const directory = await open(input.profileRootPath,
      constants.O_RDONLY | (constants.O_DIRECTORY ?? 0))
    try { await directory.sync() } finally { await directory.close() }
  }
}

export async function heartbeatOpenCodeCatalogProfile(input: Readonly<{
  profileRootPath: string; runtimeInstanceId: string; profileRootKey: string
}>): Promise<void> {
  await writeOpenCodeCatalogProfileManifest({ ...input, state: 'ready' })
}

async function readAttemptManifest(root: string, expectedParent: string): Promise<Manifest | null> {
  try {
    if (!path.isAbsolute(root) || path.dirname(root) !== expectedParent) return null
    const rootMetadata = await lstat(root, { bigint: true })
    if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) return null
    const manifestPath = path.join(root, OPENCODE_CATALOG_PROFILE_MANIFEST)
    const named = await lstat(manifestPath, { bigint: true })
    if (!named.isFile() || named.isSymbolicLink() || named.size > BigInt(MAX_MANIFEST)) return null
    const handle = await open(manifestPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const held = await handle.stat({ bigint: true })
      if (!held.isFile() || held.dev !== named.dev || held.ino !== named.ino
        || held.size > BigInt(MAX_MANIFEST)) return null
      const parsed = JSON.parse(await handle.readFile('utf8')) as unknown
      return validManifest(parsed, root) ? parsed : null
    } finally { await handle.close() }
  } catch { return null }
}

function generationOf(manifest: Manifest): number | null {
  const encoded = /^catalog-g([1-9][0-9]*)-/.exec(manifest.runtimeInstanceId)?.[1]
  if (encoded === undefined) return null
  const generation = Number(encoded)
  return Number.isSafeInteger(generation) ? generation : null
}

export async function cleanupOpenCodeCatalogProfile(profileRootPath: string,
  attemptOwnedProfileRootKey?: string): Promise<OpenCodeCatalogProfileCleanupReceipt> {
  const parent = path.dirname(profileRootPath)
  const manifest = await readAttemptManifest(profileRootPath, parent)
  if (!manifest && (!attemptOwnedProfileRootKey
    || path.basename(profileRootPath) !== attemptOwnedProfileRootKey
    || !attemptOwnedProfileRootKey.includes('-catalog-'))) {
    return { schema: 'opencode-catalog-profile-cleanup-v1', profileRootPath, disposition: 'rejected' }
  }
  let before: BigIntStats
  try { before = await lstat(profileRootPath, { bigint: true }) } catch {
    return { schema: 'opencode-catalog-profile-cleanup-v1', profileRootPath, disposition: 'absent' }
  }
  const trash = path.join(parent, `.catalog-trash-${randomUUID()}`)
  try {
    await rename(profileRootPath, trash)
    const after = await lstat(trash, { bigint: true })
    if (!after.isDirectory() || after.isSymbolicLink()
      || before.dev !== after.dev || before.ino !== after.ino) {
      return { schema: 'opencode-catalog-profile-cleanup-v1', profileRootPath, disposition: 'queued' }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { schema: 'opencode-catalog-profile-cleanup-v1', profileRootPath, disposition: 'absent' }
    }
    return { schema: 'opencode-catalog-profile-cleanup-v1', profileRootPath, disposition: 'queued' }
  }
  try {
    await rm(trash, { recursive: true })
    return { schema: 'opencode-catalog-profile-cleanup-v1', profileRootPath, disposition: 'removed' }
  } catch {
    return { schema: 'opencode-catalog-profile-cleanup-v1', profileRootPath, disposition: 'queued' }
  }
}

/** Bounded restart janitor. A generation is ordering evidence only, never a deletion lease. */
export async function janitorOpenCodeCatalogProfiles(
  scopedProfilesRoot: string,
  protectedGeneration?: number,
): Promise<number> {
  if (!path.isAbsolute(scopedProfilesRoot)
    || (protectedGeneration !== undefined
      && (!Number.isSafeInteger(protectedGeneration) || protectedGeneration < 1))) return 0
  const entries: Dirent[] = []
  try {
    const directory = await opendir(scopedProfilesRoot)
    for await (const entry of directory) {
      entries.push(entry)
      if (entries.length >= MAX_SCAN) break
    }
  } catch { return 0 }

  const trash: Array<{ name: string; createdAt: number }> = []
  for (const entry of entries) {
    if (!entry.name.startsWith('.catalog-trash-') || !entry.isDirectory()
      || entry.isSymbolicLink()) continue
    try {
      const metadata = await lstat(path.join(scopedProfilesRoot, entry.name))
      if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
        trash.push({ name: entry.name, createdAt: metadata.mtimeMs })
      }
    } catch {}
  }
  trash.sort((left, right) => left.createdAt - right.createdAt
    || left.name.localeCompare(right.name))
  let removed = 0
  for (const entry of trash.slice(0, MAX_TRASH)) {
    try {
      const target = path.join(scopedProfilesRoot, entry.name)
      const metadata = await lstat(target)
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) continue
      await rm(target, { recursive: true }); removed += 1
    } catch {}
  }

  const profiles: Array<{ path: string; manifest: Manifest }> = []
  const abandonedPreparations: Array<{ path: string; modifiedAt: number }> = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !entry.name.includes('-catalog-')) continue
    const target = path.join(scopedProfilesRoot, entry.name)
    const manifest = await readAttemptManifest(target, scopedProfilesRoot)
    if (manifest) {
      profiles.push({ path: target, manifest })
    } else if (/^[a-z0-9:_-]{8,256}-catalog-[a-z0-9:_-]{8,256}$/i.test(entry.name)) {
      try {
        const metadata = await lstat(target)
        if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
          abandonedPreparations.push({ path: target, modifiedAt: metadata.mtimeMs })
        }
      } catch {}
    }
  }
  abandonedPreparations.sort((left, right) => left.modifiedAt - right.modifiedAt
    || left.path.localeCompare(right.path))
  for (const preparation of abandonedPreparations) {
    if (removed >= MAX_TRASH) break
    // A manifestless root can only be proven abandoned after the full lease
    // window. This also covers a crash in the mkdir-to-manifest gap without
    // racing a currently preparing process.
    if (Date.now() - preparation.modifiedAt < DEFAULT_LEASE_MS) continue
    const receipt = await cleanupOpenCodeCatalogProfile(
      preparation.path, path.basename(preparation.path),
    )
    if (receipt.disposition === 'removed') removed += 1
  }
  profiles.sort((left, right) => left.manifest.createdAt - right.manifest.createdAt
    || left.path.localeCompare(right.path))
  for (const profile of profiles) {
    if (removed >= MAX_TRASH) break
    const generation = generationOf(profile.manifest)
    if (protectedGeneration !== undefined && generation !== null
      && generation >= protectedGeneration) continue
    // Older A remains protected while its lease is live even after B begins.
    // Invalid clocks/process observations are conservative: only an explicit
    // closed state or an expired bounded lease authorizes restart cleanup.
    if (profile.manifest.state !== 'closed'
      && Date.now() < profile.manifest.leaseExpiresAt) continue
    if (profile.manifest.state !== 'closed'
      && profile.manifest.ownerPid === process.pid
      && profile.manifest.processBirthId === PROCESS_BIRTH_ID) continue
    const receipt = await cleanupOpenCodeCatalogProfile(profile.path)
    if (receipt.disposition === 'removed') removed += 1
  }
  return removed
}
