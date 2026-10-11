import assert from 'node:assert/strict'
import path from 'node:path'
import { createWindowsNativeBroker, resolveWindowsNativeArtifact } from '../../src/services/opencode/host/windows/OpenCodeV2WindowsNativeBroker.js'
import { createWindowsOwnerFilesystem, type WindowsOwnerDirectory } from '../../src/services/opencode/host/windows/OpenCodeV2WindowsOwnerFilesystem.js'

// Actual native helper only. Supply a NEW TEST directory under the CI scratch
// root. Retain its fences/records after both success and failure; no adoption,
// deletion, native model, provider, credential or user-project effects.
assert.equal(process.platform, 'win32')
const requestedRoot = process.argv[2]
assert.ok(requestedRoot && path.win32.isAbsolute(requestedRoot))
assert.match(path.win32.basename(requestedRoot), /^TEST-windows-owner-[a-zA-Z0-9-]+$/)
const broker = createWindowsNativeBroker(await resolveWindowsNativeArtifact())
broker.events.on('error', () => {})
let lastOperation = 'none'
const filesystem = createWindowsOwnerFilesystem(request => { lastOperation = request.op; return broker.request(request.op, request) })
const handles: WindowsOwnerDirectory[] = []
const retain = (handle: WindowsOwnerDirectory): WindowsOwnerDirectory => { handles.push(handle); return handle }
const lease = 'b04ca87c-d84d-4b55-a89a-9c8fa7bd1f16'
const facts: Record<string, unknown> = { schema: 1, qualified: false, primitive: 'held-directory-rename', runRoot: requestedRoot }
let failure: unknown
try {
  retain(await filesystem.createDirectory(requestedRoot))
  const originalPath = path.win32.join(requestedRoot, '.opencode-v2-execution-owner')
  const original = retain(await filesystem.createDirectory(originalPath))
  const record = { schema: 1, synthetic: true, leaseOwnerId: lease, marker: 'retained-original-é' }
  await original.writeExclusive('owner.json', record)
  await assert.rejects(filesystem.createDirectory(originalPath))
  await assert.rejects(original.writeExclusive('owner.json', record))
  // An uncertain/failed mutation poisons this capability, so acquire a separate
  // original directory for the successful archive instead of replaying it.
  await original.close()
  const successPath = path.win32.join(requestedRoot, '.successful-owner')
  const successArchive = successPath + '.released.' + lease
  const success = retain(await filesystem.createDirectory(successPath))
  await success.writeExclusive('owner.json', record)
  const before = success.identity
  await success.archive(successArchive)
  await success.assertOwned()
  assert.deepEqual(success.identity, before)
  assert.deepEqual(await success.readRecord('owner.json'), record)
  const archived = retain(await filesystem.openDirectory(successArchive))
  assert.deepEqual(archived.identity, before)
  assert.deepEqual(await archived.readRecord('owner.json'), record)
  await assert.rejects(archived.writeExclusive('release.json', { forbidden: true }))
  const next = retain(await filesystem.createDirectory(successPath))
  assert.notDeepEqual(next.identity, before)
  const nextRecord = { schema: 1, synthetic: true, marker: 'next-owner' }
  await next.writeExclusive('owner.json', nextRecord)
  // Target collision must retain BOTH source and preexisting destination bytes.
  await assert.rejects(next.archive(successArchive))
  assert.deepEqual(await archived.readRecord('owner.json'), record)
  const sourceAfterCollision = retain(await filesystem.openDirectory(successPath))
  assert.deepEqual(sourceAfterCollision.identity, next.identity)
  assert.deepEqual(await sourceAfterCollision.readRecord('owner.json'), nextRecord)
  await assert.rejects(filesystem.createDirectory(successPath))
  const partialPath = path.win32.join(requestedRoot, '.partial-owner')
  const partial = retain(await filesystem.createDirectory(partialPath))
  await partial.close()
  await assert.rejects(filesystem.createDirectory(partialPath))
  const retainedOriginal = retain(await filesystem.openDirectory(originalPath))
  assert.deepEqual(await retainedOriginal.readRecord('owner.json'), record)
  Object.assign(facts, { archivedIdentity: before, archivedPath: successArchive,
    originalPathFreeForNewFence: true, nextIdentity: next.identity,
    noReplaceCollisionPreserved: true, partialFenceBlocksAcquisition: true,
    existingRecordNotOverwritten: true, readOnlyReopenCannotMutate: true })
} catch (error) { failure = error; facts.failedOperation = lastOperation }
finally {
  const closeFailures: string[] = []
  for (const handle of handles.reverse()) {
    try { await handle.close() } catch { closeFailures.push('native_handle_close_failed') }
  }
  try { await broker.close() } catch { closeFailures.push('native_broker_close_failed') }
  facts.closeFailures = closeFailures
  facts.nativeBrokerEnded = broker.ended()
  facts.qualified = failure === undefined && closeFailures.length === 0 && broker.ended()
  console.log(JSON.stringify(facts))
  if (closeFailures.length && failure === undefined) failure = new Error('windows_owner_cleanup_unknown')
}
if (failure !== undefined) throw failure
