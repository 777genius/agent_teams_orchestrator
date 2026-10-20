import path from 'node:path'
import { ownerFilesystemForWindowsPlan, windowsBirth, type WindowsLaunchPlan } from './windows/OpenCodeV2WindowsExecution.js'
import type { WindowsOwnerDirectory } from './windows/OpenCodeV2WindowsOwnerFilesystem.js'
import { isExecutionPlatformMapping, isExecutionUnboundRetirement, type ExecutionPlatformMapping, type ExecutionUnboundRetirement } from './OpenCodeV2ExecutionPlatform.js'
import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath, rename } from 'node:fs/promises'
import { executionAssert, executionHash, executionRecord } from '../execution/OpenCodeV2ExecutionContracts.js'
import { canonicalExecutionDirectory, readExecutionBirth, type ExecutionBirth, type OwnedNativeProfile } from './OpenCodeV2ExecutionBinding.js'
import { isExecutionCleanupReceipt, type ExecutionCleanupReceipt } from './OpenCodeV2ExecutionLifecycle.js'

type OwnerIdentity = Readonly<{ hostInstanceId: string; leaseOwnerId: string; graphSha256: string }>
export type ExecutionOwnerRecord = Readonly<{
  schema: 1; generation: 'v2'; profileRoot: string; databasePath: string; profileEpoch: string
  hostInstanceId: string; leaseOwnerId: string; graphSha256: string
  controller: Readonly<{ pid: number; birth: ExecutionBirth }>
}>
const OWNER_DIRECTORY = '.opencode-v2-execution-owner'
const MAX_BYTES = 16 * 1024

function isDurableBirth(birth: Record<string, unknown>): boolean {
  return Object.keys(birth).sort().join(',') === 'bootId,format,value' &&
    typeof birth.value === 'string' &&
    (birth.format === 'windows-filetime' ? /^[1-9]\d{0,19}$/.test(birth.value) && BigInt(birth.value) <= 0xffffffffffffffffn && birth.bootId === null :
      typeof birth.bootId === 'string' && (birth.format === 'linux-start-ticks' ? /^\d+$/.test(birth.value) && /^[a-f0-9-]{36}$/.test(birth.bootId) :
      birth.format === 'darwin-pidversion' && /^\d+:\d+$/.test(birth.value) && /^[a-f0-9-]{36}$/i.test(birth.bootId)))
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { await handle.sync() } finally { await handle.close() }
}
async function writeExclusive(directory: string, name: string, value: unknown): Promise<void> {
  const bytes = JSON.stringify(value) + '\n'
  executionAssert(Buffer.byteLength(bytes) <= MAX_BYTES, 'execution_owner_unknown')
  const handle = await open(path.join(directory, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
  await syncDirectory(directory)
}
async function readRecord(directory: string): Promise<ExecutionOwnerRecord> {
  const handle = await open(path.join(directory, 'owner.json'), constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await handle.stat()
    executionAssert(stat.isFile() && stat.size <= MAX_BYTES && stat.nlink === 1, 'execution_owner_unknown')
    const bytes = Buffer.alloc(MAX_BYTES + 1)
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
    executionAssert(bytesRead <= MAX_BYTES, 'execution_owner_unknown')
    return validateOwnerRecord(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead))))
  } finally { await handle.close() }
}

function validateOwnerRecord(value: unknown): ExecutionOwnerRecord {
  const row = executionRecord(value)
  const names = ['schema', 'generation', 'profileRoot', 'databasePath', 'profileEpoch', 'hostInstanceId', 'leaseOwnerId', 'graphSha256', 'controller']
  executionAssert(Object.keys(row).length === names.length && names.every(name => Object.hasOwn(row, name)) &&
    row.schema === 1 && row.generation === 'v2', 'execution_owner_unknown')
  const controller = executionRecord(row.controller), birth = executionRecord(controller.birth)
  executionAssert(Object.keys(controller).sort().join(',') === 'birth,pid' && Number.isSafeInteger(controller.pid) && Number(controller.pid) > 0 &&
    isDurableBirth(birth) && (process.platform === 'win32' ? birth.format === 'windows-filetime' : birth.format !== 'windows-filetime'), 'execution_owner_unknown')
  executionAssert(names.slice(2, 8).every(name => typeof row[name] === 'string' && String(row[name]).length > 0) &&
    typeof row.graphSha256 === 'string' && /^[a-f0-9]{64}$/.test(row.graphSha256) &&
    (process.platform === 'win32' ? path.win32 : path).isAbsolute(String(row.profileRoot)) &&
    (process.platform === 'win32' ? path.win32 : path).isAbsolute(String(row.databasePath)), 'execution_owner_unknown')
  return row as ExecutionOwnerRecord
}

/** Read retained original identities, without adoption, takeover or native mutation.
 * A missing/incomplete/future record remains UNKNOWN; no file is rewritten. */
export async function readExecutionProfileOwner(profileRoot: string, windowsPlan?: WindowsLaunchPlan): Promise<ExecutionOwnerRecord> {
  if (process.platform === 'win32') {
    executionAssert(windowsPlan && windowsPlan.writableRoots.includes(profileRoot), 'execution_owner_platform_pending')
    const filesystem = ownerFilesystemForWindowsPlan(windowsPlan)
    const root = await filesystem.openDirectory(profileRoot)
    try {
      await root.assertOwned()
      const directory = await filesystem.openDirectory(path.win32.join(profileRoot, OWNER_DIRECTORY))
      try {
        const record = validateOwnerRecord(await directory.readRecord('owner.json'))
        executionAssert(record.profileRoot === profileRoot && record.controller.birth.format === 'windows-filetime', 'execution_owner_unknown')
        await filesystem.validateSelectedProfile(record.profileRoot, record.databasePath)
        await root.assertOwned()
        return record
      } finally { await directory.close() }
    } finally { await root.close() }
  }
  executionAssert(!windowsPlan, 'execution_owner_platform_pending')
  await canonicalExecutionDirectory(profileRoot)
  const directory = path.join(profileRoot, OWNER_DIRECTORY)
  await canonicalExecutionDirectory(directory)
  return readRecord(directory)
}

/** mkdir is the interprocess acquisition transaction AND the non-expiring lifetime
 * fence. It is shared across every DB/epoch in one canonical profile. A crashed
 * writer, even before owner.json is committed, blocks acquisition indefinitely.
 * Only the exact holder can retire its own directory; there is no stale timeout. */
export async function acquireExecutionProfileOwner(requestedProfile: OwnedNativeProfile, requestedIdentity: OwnerIdentity,
  filesystem: Readonly<{ rename: typeof rename }> | Readonly<{ windowsPlan: WindowsLaunchPlan }> = { rename }) {
  // Narrow archive operation port for deterministic publication-order regression.
  const windows = 'windowsPlan' in filesystem ? ownerFilesystemForWindowsPlan(filesystem.windowsPlan) : undefined
  const archive = 'rename' in filesystem ? filesystem.rename : rename
  executionAssert(process.platform === 'win32' ? windows : !windows, 'execution_owner_platform_pending')
  // Capture authority before the first await. A caller retaining mutable inputs
  // cannot redirect validation, durable records or retirement to another owner.
  const profile = Object.freeze({ root: requestedProfile.root, databasePath: requestedProfile.databasePath, epoch: requestedProfile.epoch })
  const identity = Object.freeze({ hostInstanceId: requestedIdentity.hostInstanceId,
    leaseOwnerId: requestedIdentity.leaseOwnerId, graphSha256: requestedIdentity.graphSha256 })
  executionAssert(process.platform === 'linux' || process.platform === 'darwin' || (process.platform === 'win32' && windows), 'execution_owner_platform_pending')
  if (windows) {
    executionAssert('windowsPlan' in filesystem && filesystem.windowsPlan.writableRoots.includes(profile.root), 'execution_profile_changed')
    await windows.validateSelectedProfile(profile.root, profile.databasePath)
  }
  else {
    await canonicalExecutionDirectory(profile.root)
    executionAssert(((await lstat(profile.root)).mode & 0o077) === 0, 'execution_profile_not_private')
    await canonicalExecutionDirectory(path.dirname(profile.databasePath))
    executionAssert(profile.databasePath.startsWith(profile.root + path.sep), 'execution_profile_changed')
    const db = await lstat(profile.databasePath).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return null
    })
    // Hardlinks would let two different canonical profiles name one physical DB.
    executionAssert(!db || (db.isFile() && !db.isSymbolicLink() && db.nlink === 1 && await realpath(profile.databasePath) === profile.databasePath), 'execution_database_alias')
  }
  executionAssert(/^[a-f0-9-]{36}$/.test(identity.hostInstanceId) && /^[a-f0-9-]{36}$/.test(identity.leaseOwnerId) &&
    /^[a-f0-9]{64}$/.test(identity.graphSha256) && profile.epoch.length > 0, 'execution_owner_unknown')
  const readBirth = windows ? windowsBirth : readExecutionBirth
  const birth = await readBirth(process.pid)
  executionAssert(birth && isDurableBirth(birth) && birth.format ===
    (process.platform === 'win32' ? 'windows-filetime' : process.platform === 'darwin' ? 'darwin-pidversion' : 'linux-start-ticks'), 'execution_owner_unknown')
  const directory = path.join(profile.root, OWNER_DIRECTORY)
  const databaseDirectory = path.join(path.dirname(profile.databasePath), `.${path.basename(profile.databasePath)}.opencode-v2-execution-owner`)
  let profileHandle: WindowsOwnerDirectory | undefined, databaseHandle: WindowsOwnerDirectory | undefined
  let assertDirectories: () => Promise<void>
  if (windows) {
    profileHandle = await windows.createDirectory(directory)
    try { databaseHandle = await windows.createDirectory(databaseDirectory) }
    catch (error) { await profileHandle.close().catch(() => undefined); throw error }
    const heldProfile = profileHandle, heldDatabase = databaseHandle
    assertDirectories = async () => {
      await windows.validateSelectedProfile(profile.root, profile.databasePath)
      await heldProfile.assertOwned(); await heldDatabase.assertOwned()
    }
  } else {
    await mkdir(directory, { mode: 0o700 }).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('execution_profile_owned')
      throw error
    })
    // Never erase a partial acquisition on failure: it may have become durable.
    await syncDirectory(profile.root)
    // A nested canonical profile can name the same canonical database. Its own
    // profile fence is distinct, so the physical database needs its own fence too.
    await mkdir(databaseDirectory, { mode: 0o700 }).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('execution_database_owned')
      throw error
    })
    await syncDirectory(path.dirname(databaseDirectory))
    const inode = await lstat(directory), databaseInode = await lstat(databaseDirectory)
    assertDirectories = async () => {
      const now = await lstat(directory), databaseNow = await lstat(databaseDirectory)
      executionAssert(now.isDirectory() && !now.isSymbolicLink() && now.dev === inode.dev && now.ino === inode.ino &&
        databaseNow.isDirectory() && !databaseNow.isSymbolicLink() && databaseNow.dev === databaseInode.dev && databaseNow.ino === databaseInode.ino, 'execution_owner_unknown')
    }
  }
  const writeOwned = async (name: string, value: unknown) => {
    if (profileHandle && databaseHandle) { await profileHandle.writeExclusive(name, value); await databaseHandle.writeExclusive(name, value) }
    else { await writeExclusive(directory, name, value); await writeExclusive(databaseDirectory, name, value) }
  }
  const readOwned = async () => {
    if (profileHandle && databaseHandle) return [validateOwnerRecord(await profileHandle.readRecord('owner.json')), validateOwnerRecord(await databaseHandle.readRecord('owner.json'))]
    return [await readRecord(directory), await readRecord(databaseDirectory)]
  }
  const record: ExecutionOwnerRecord = Object.freeze({ schema: 1, generation: 'v2', profileRoot: profile.root,
    databasePath: profile.databasePath, profileEpoch: profile.epoch, ...identity,
    controller: Object.freeze({ pid: process.pid, birth }) })
  try { await writeOwned('owner.json', record) }
  catch (error) {
    // Close handles without erasing either permanent partial-acquisition fence.
    await Promise.allSettled([profileHandle?.close(), databaseHandle?.close()])
    throw error
  }
  let launchAttempted = false, child: { pid: number; birth: ExecutionBirth } | undefined, retired = false
  let transition: Promise<void> = Promise.resolve()
  const serialize = (action: () => Promise<void>): Promise<void> => {
    const work = transition.then(action)
    transition = work.catch(() => undefined)
    return work
  }
  const assertOwned = async () => {
    executionAssert(!retired, 'execution_owner_released')
    await assertDirectories()
    const records = await readOwned()
    executionAssert(records.every(value => executionHash(value) === executionHash(record)), 'execution_owner_unknown')
  }
  const retire = async (evidence: unknown) => {
    await assertOwned()
    await writeOwned('release.json', evidence)
    await assertOwned()
    // Atomic removal from the acquisition namespace, retaining ALL original
    // bytes/IDs. A late release never unlinks a subsequent owner's fence.
    // Database becomes durable/free first. Profile remains the admission fence
    // through this rename and fsync; failures retain the unproven profile fence.
    if (profileHandle && databaseHandle) {
      await databaseHandle.archive(`${databaseDirectory}.released.${identity.leaseOwnerId}`)
      await profileHandle.archive(`${directory}.released.${identity.leaseOwnerId}`)
      retired = true
      const closed = await Promise.allSettled([databaseHandle.close(), profileHandle.close()])
      executionAssert(closed.every(value => value.status === 'fulfilled'), 'execution_owner_unknown')
    } else {
      await archive(databaseDirectory, `${databaseDirectory}.released.${identity.leaseOwnerId}`)
      await syncDirectory(path.dirname(databaseDirectory))
      await archive(directory, `${directory}.released.${identity.leaseOwnerId}`)
      retired = true
      await syncDirectory(profile.root)
      await syncDirectory(path.dirname(databaseDirectory))
    }
  }
  return Object.freeze({ record,
    beforeSpawn(): Promise<void> { return serialize(async () => { await assertOwned(); executionAssert(!launchAttempted, 'execution_owner_unknown'); launchAttempted = true }) },
    bindChild(pid: number, requestedBirth: ExecutionBirth, mapping?: ExecutionPlatformMapping): Promise<void> {
      const childBirth = Object.freeze({ format: requestedBirth.format, value: requestedBirth.value, bootId: requestedBirth.bootId })
      return serialize(async () => {
        await assertOwned(); executionAssert(launchAttempted && !child && Number.isSafeInteger(pid) && pid > 0, 'execution_owner_unknown')
        executionAssert(executionHash(await readBirth(pid)) === executionHash(childBirth), 'execution_owner_unknown')
        if (mapping) {
          executionAssert(isExecutionPlatformMapping(mapping) && mapping.leaseOwnerId === record.leaseOwnerId &&
            mapping.bun.hostPID === pid && executionHash(mapping.bun.birth) === executionHash(childBirth), 'execution_owner_unknown')
          // This audit file is never read as launch/release authority. Keep the
          // complete branded mapping in its native adapter; commit every field
          // without expanding the 16KiB owner-record ceiling for anchor arrays.
          await writeOwned('containment.json', windows ? {
            schema: 1, platform: 'win32', mappingSha256: executionHash(mapping),
            child: { pid, birth: childBirth }, namespace: mapping.namespace.name,
            leaseOwnerId: mapping.leaseOwnerId,
          } : mapping)
        }
        child = { pid, birth: childBirth }
        await writeOwned('child.json', child)
      })
    },
    abandonBeforeSpawn(): Promise<void> { return serialize(async () => {
      executionAssert(!launchAttempted, 'execution_owner_unknown')
      await retire({ state: 'not_submitted', hostInstanceId: record.hostInstanceId, leaseOwnerId: record.leaseOwnerId })
    }) },
    /** A spawn was attempted but no child identity was ever committed, and the
     * launch-owned retirement proved its native scope empty with the held MAIN
     * exited. Only that branded claim may free this fence; an unbound spawn
     * without it stays UNKNOWN and blocks acquisition indefinitely. */
    abandonAfterUnboundSpawn(evidence: unknown): Promise<void> { return serialize(async () => {
      executionAssert(launchAttempted && !child, 'execution_owner_unknown')
      executionAssert(isExecutionUnboundRetirement(evidence), 'execution_owner_unknown')
      const proof = evidence as ExecutionUnboundRetirement
      executionAssert(proof.scopeEmpty === true && proof.heldProcessExited === true && typeof proof.scopeClosed === 'boolean', 'execution_owner_unknown')
      await retire({ state: 'spawn_unbound', hostInstanceId: record.hostInstanceId, leaseOwnerId: record.leaseOwnerId,
        retirement: { scopeEmpty: true, heldProcessExited: true, scopeClosed: proof.scopeClosed } })
    }) },
    release(receipt: ExecutionCleanupReceipt): Promise<void> { return serialize(async () => {
      executionAssert(isExecutionCleanupReceipt(receipt) && child && receipt.scopeClosed === true && receipt.processRetired === true && receipt.descendantsRetired === true &&
        receipt.pid === child.pid && executionHash(receipt.birth) === executionHash(child.birth), 'execution_owner_unknown')
      await retire({ state: 'retired', receipt })
    }) },
  })
}
