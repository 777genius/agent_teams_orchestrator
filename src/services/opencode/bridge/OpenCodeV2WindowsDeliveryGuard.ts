import { lstat, realpath } from 'node:fs/promises'
import path from 'node:path'
import { executionAssert } from '../execution/OpenCodeV2ExecutionContracts.js'
import { createWindowsNativeBroker, resolveWindowsNativeArtifact } from '../host/windows/OpenCodeV2WindowsNativeBroker.js'
import { createWindowsOwnerFilesystem, type WindowsOwnerDirectory } from '../host/windows/OpenCodeV2WindowsOwnerFilesystem.js'

/** The shared outcome JSON remains app-owned. This fixed private leaf holds
 * only its V2 observation mutex, never delivery or native execution authority. */
export async function openWindowsDeliveryJournalGuard(dataRoot: string, deadline: number) {
  executionAssert(process.platform === 'win32' && Number.isSafeInteger(deadline) && deadline > Date.now(), 'invalid_operation_deadline')
  executionAssert(await realpath(dataRoot) === dataRoot, 'delivery_root_invalid')
  const broker = createWindowsNativeBroker(await resolveWindowsNativeArtifact(deadline))
  broker.events.on('error', () => {})
  const filesystem = createWindowsOwnerFilesystem((request, requestDeadline, signal) =>
    broker.request(request.op, request, requestDeadline, signal))
  const directory = path.join(dataRoot, 'opencode', 'v2', 'delivery-journal')
  const held: WindowsOwnerDirectory[] = []
  const acquire = async (candidate: string, required: boolean): Promise<WindowsOwnerDirectory | undefined> => {
    executionAssert(Date.now() < deadline, 'operation_timeout')
    const stat = await lstat(candidate).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (stat) {
      executionAssert(stat.isDirectory() && !stat.isSymbolicLink() && await realpath(candidate) === candidate, 'delivery_root_invalid')
      // Existing shared ancestors can carry the live cohort's metadata grants.
      // The native leaf capability pins their physical identity and ancestry;
      // they are not promoted to private producer roots or repaired here.
      if (!required) return
    } else {
      const parent = path.dirname(candidate)
      executionAssert(parent !== candidate, 'delivery_root_invalid')
      await acquire(parent, false)
    }
    const handle = await filesystem.prepareDirectory(candidate, stat === null, deadline)
    held.push(handle)
    await handle.assertOwned(deadline)
    return handle
  }
  const close = async () => {
    const errors: unknown[] = []
    for (const handle of held.splice(0).reverse()) {
      try { await handle.close() } catch (error) { errors.push(error) }
    }
    try { await broker.close() } catch (error) { errors.push(error) }
    if (errors.length) throw new AggregateError(errors, 'cleanup_unknown', { cause: errors[0] })
  }
  try {
    const leaf = await acquire(directory, true)
    executionAssert(leaf, 'delivery_lock_foreign')
    await leaf.writeMetadata('DeliveryGuard', null, deadline)
    const metadata = await leaf.readMetadata('DeliveryGuard', deadline)
    const guard = path.join(directory, 'owner.lock')
    executionAssert(metadata.path === guard && metadata.bytes === 0 && metadata.fileIdentity !== null, 'delivery_lock_foreign')
    return Object.freeze({ path: guard, assertOwned: () => leaf.assertOwned(deadline), close })
  } catch (error) {
    try { await close() }
    catch (failure) { throw new AggregateError([error, failure], 'cleanup_unknown', { cause: error }) }
    throw error
  }
}
