import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createWindowsNativeBroker, resolveWindowsNativeArtifact } from '../../src/services/opencode/host/windows/OpenCodeV2WindowsNativeBroker.js'
import { createWindowsOwnerFilesystem, type WindowsOwnerDirectory } from '../../src/services/opencode/host/windows/OpenCodeV2WindowsOwnerFilesystem.js'
import { executionRecord } from '../../src/services/opencode/execution/OpenCodeV2ExecutionContracts.js'

// Actual native helper only. Supply a NEW TEST directory under the CI scratch
// root. Retain its fences/records after both success and failure; no adoption,
// deletion, native model, provider, credential or user-project effects.
assert.equal(process.platform, 'win32')
const requestedRoot = process.argv[2]
assert.ok(requestedRoot && path.win32.isAbsolute(requestedRoot))
assert.match(path.win32.basename(requestedRoot), /^TEST-windows-owner-[a-zA-Z0-9-]+$/)
const facts: Record<string, unknown> = { schema: 1, qualified: false, primitive: 'held-directory-rename', runRoot: requestedRoot }
const broker = createWindowsNativeBroker(await resolveWindowsNativeArtifact())
broker.events.on('error', () => {})
const request = (operation: string, input: Readonly<Record<string, unknown>>) => {
  facts.lastOperation = operation
  delete facts.lastRelativePath
  const target = typeof input.path === 'string' ? input.path : typeof input.root === 'string' ? input.root : undefined
  if (target !== undefined) {
    const relative = path.win32.relative(requestedRoot, target)
    if (relative !== '..' && !relative.startsWith('..\\') && !path.win32.isAbsolute(relative) && !/[\x00-\x1f]/.test(relative))
      facts.lastRelativePath = relative || '.'
  }
  return broker.request(operation, input)
}
const filesystem = createWindowsOwnerFilesystem(input => request(input.op, input))
const handles: WindowsOwnerDirectory[] = []
const retain = (handle: WindowsOwnerDirectory): WindowsOwnerDirectory => { handles.push(handle); return handle }
const writeOwnedFixture = async (directory: WindowsOwnerDirectory, directoryPath: string,
  name: 'opencode.json' | 'user.json' | 'other.json', bytes: string | Uint8Array) => {
  // The native record creator sets TokenUser ownership and a private DACL.
  // Rename its fresh file within this TEST directory, then truncate that same
  // inode to retain genuine zero-length, malformed, and oversized fixture bytes.
  await directory.writeExclusive('owner.json', { schema: 1, synthetic: true })
  const target = path.win32.join(directoryPath, name)
  await rename(path.win32.join(directoryPath, 'owner.json'), target)
  await writeFile(target, bytes)
}
const lease = 'b04ca87c-d84d-4b55-a89a-9c8fa7bd1f16'
let failure: unknown
try {
  const setupRoot = await filesystem.createDirectory(requestedRoot)
  // The scratch parent is setup only. Actual source fences below retain their
  // original DELETE-capable handles; the existing parent needs traversal only.
  await setupRoot.close()
  const originalPath = path.win32.join(requestedRoot, '.opencode-v2-execution-owner')
  const original = retain(await filesystem.createDirectory(originalPath))
  const originalOwnerRecord = { schema: 1, synthetic: true, leaseOwnerId: lease, marker: 'retained-original-é' }
  await original.writeExclusive('owner.json', originalOwnerRecord)
  await assert.rejects(filesystem.createDirectory(originalPath))
  await assert.rejects(original.writeExclusive('owner.json', originalOwnerRecord))
  // An uncertain/failed mutation poisons this capability, so acquire a separate
  // original directory for the successful archive instead of replaying it.
  await original.close()
  const successPath = path.win32.join(requestedRoot, '.successful-owner')
  const successArchive = successPath + '.released.' + lease
  const success = retain(await filesystem.createDirectory(successPath))
  await success.writeExclusive('owner.json', originalOwnerRecord)
  const before = success.identity
  await success.archive(successArchive)
  await success.assertOwned()
  assert.deepEqual(success.identity, before)
  assert.deepEqual(await success.readRecord('owner.json'), originalOwnerRecord)
  const archived = retain(await filesystem.openDirectory(successArchive))
  assert.deepEqual(archived.identity, before)
  assert.deepEqual(await archived.readRecord('owner.json'), originalOwnerRecord)
  await assert.rejects(archived.writeExclusive('release.json', { forbidden: true }))
  const next = retain(await filesystem.createDirectory(successPath))
  assert.notDeepEqual(next.identity, before)
  const nextRecord = { schema: 1, synthetic: true, marker: 'next-owner' }
  await next.writeExclusive('owner.json', nextRecord)
  // Target collision must retain BOTH source and preexisting destination bytes.
  await assert.rejects(next.archive(successArchive))
  assert.deepEqual(await archived.readRecord('owner.json'), originalOwnerRecord)
  const sourceAfterCollision = retain(await filesystem.openDirectory(successPath))
  assert.deepEqual(sourceAfterCollision.identity, next.identity)
  assert.deepEqual(await sourceAfterCollision.readRecord('owner.json'), nextRecord)
  await assert.rejects(filesystem.createDirectory(successPath))
  const partialPath = path.win32.join(requestedRoot, '.partial-owner')
  const partial = retain(await filesystem.createDirectory(partialPath))
  await partial.close()
  await assert.rejects(filesystem.createDirectory(partialPath))
  const retainedOriginal = retain(await filesystem.openDirectory(originalPath))
  assert.deepEqual(await retainedOriginal.readRecord('owner.json'), originalOwnerRecord)
  const inspect = async (name: string, config?: string) => {
    const profile = path.win32.join(requestedRoot, name)
    retain(await filesystem.createDirectory(profile))
    const configDirectory = path.win32.join(profile, "config")
    retain(await filesystem.createDirectory(configDirectory))
    const opencodeDirectory = path.win32.join(configDirectory, "opencode")
    const ownedConfig = retain(await filesystem.createDirectory(opencodeDirectory))
    if (config !== undefined) await writeOwnedFixture(ownedConfig, opencodeDirectory, "opencode.json", config)
    return executionRecord(await request("ownerInspectProfileConfig", {
      root: profile, databasePath: path.win32.join(profile, "data", "opencode", "opencode.db"),
    }))
  }
  const absent = await inspect("TEST-profile-absent", undefined)
  const incomplete = await inspect("TEST-profile-incomplete", "")
  const malformedComplete = await inspect("TEST-profile-malformed-complete", "{TEST-malformed")
  assert.equal(absent.state, "absent"); assert.equal(absent.configIdentity, null)
  assert.equal(incomplete.state, "incomplete"); assert.notEqual(incomplete.configIdentity, null)
  assert.equal(malformedComplete.state, "complete"); assert.notEqual(malformedComplete.configIdentity, null)
  const selectedRoot = path.win32.join(requestedRoot, "TEST-selected-profile")
  retain(await filesystem.createDirectory(selectedRoot))
  for (const name of ["home", "config", "data", "cache", "state", "tmp", "appdata", "localappdata"])
    retain(await filesystem.createDirectory(path.win32.join(selectedRoot, name)))
  const selectedConfigDirectory = path.win32.join(selectedRoot, "config", "opencode")
  const ownedSelectedConfig = retain(await filesystem.createDirectory(selectedConfigDirectory))
  const selectedDataDirectory = path.win32.join(selectedRoot, "data", "opencode")
  retain(await filesystem.createDirectory(selectedDataDirectory))
  const claudeRoot = path.win32.join(requestedRoot, "TEST-claude")
  retain(await filesystem.createDirectory(claudeRoot))
  retain(await filesystem.createDirectory(path.win32.join(claudeRoot, "teams")))
  retain(await filesystem.createDirectory(path.win32.join(claudeRoot, "teams", "TEST-team")))
  const inboxes = path.win32.join(claudeRoot, "teams", "TEST-team", "inboxes")
  const ownedInbox = retain(await filesystem.createDirectory(inboxes))
  await writeOwnedFixture(ownedInbox, inboxes, "user.json", "[]")
  const selectedContent = JSON.stringify({ mcpServers: { "agent-teams": { type: "local",
    env: { AGENT_TEAMS_MCP_CLAUDE_DIR: claudeRoot } } } })
  await writeOwnedFixture(ownedSelectedConfig, selectedConfigDirectory, "opencode.json", selectedContent)
  const databasePath = path.win32.join(selectedDataDirectory, "opencode.db")
  await request("ownerValidateSelectedProfile", { root: selectedRoot, databasePath,
    directories: [selectedRoot, selectedConfigDirectory] })
  const assertConfigOnlySelection = (value: unknown) => {
    const selected = executionRecord(value)
    assert.ok(typeof selected.selectionId === "string" && /^[1-9]\d*$/.test(selected.selectionId))
    assert.deepEqual(selected, { schema: 1, ok: true, selectionId: selected.selectionId,
      root: selectedRoot, path: path.win32.join(selectedConfigDirectory, "opencode.json"),
      sha256: createHash("sha256").update(selectedContent).digest("hex") })
  }
  // Inbox binding and reads begin only after native cohort/team join. Config
  // selection returns no controller or inbox authority for any fixture below.
  assertConfigOnlySelection(await request("ownerSelectConfig", { root: selectedRoot, databasePath,
    sha256: createHash("sha256").update(selectedContent).digest("hex"), teamId: "TEST-team" }))
  const inboxRoot = path.win32.join(claudeRoot, "teams")
  for (const [team, state] of [["TEST-empty", "empty"], ["TEST-absent", "absent"]] as const) {
    retain(await filesystem.createDirectory(path.win32.join(inboxRoot, team)))
    const directory = path.win32.join(inboxRoot, team, "inboxes")
    const ownedDirectory = retain(await filesystem.createDirectory(directory))
    if (state === "absent") await writeOwnedFixture(ownedDirectory, directory, "other.json", "[]")
    assertConfigOnlySelection(await request("ownerSelectConfig", { root: selectedRoot, databasePath,
      sha256: createHash("sha256").update(selectedContent).digest("hex"), teamId: team }))
  }
  const oversizeTeam = "TEST-oversize"
  retain(await filesystem.createDirectory(path.win32.join(inboxRoot, oversizeTeam)))
  const oversizeDirectory = path.win32.join(inboxRoot, oversizeTeam, "inboxes")
  const ownedOversize = retain(await filesystem.createDirectory(oversizeDirectory))
  await writeOwnedFixture(ownedOversize, oversizeDirectory, "user.json", Buffer.alloc(4 * 1024 * 1024 + 1))
  assertConfigOnlySelection(await request("ownerSelectConfig", { root: selectedRoot, databasePath,
    sha256: createHash("sha256").update(selectedContent).digest("hex"), teamId: oversizeTeam }))
  Object.assign(facts, { archivedIdentity: before, archivedPath: successArchive,
    originalPathFreeForNewFence: true, nextIdentity: next.identity,
    noReplaceCollisionPreserved: true, partialFenceBlocksAcquisition: true,
    existingRecordNotOverwritten: true, readOnlyReopenCannotMutate: true,
    incompleteProfileConfigSkipProof: { absent: absent.state, zeroLength: incomplete.state,
      malformedComplete: malformedComplete.state },
    configOnlySelection: { fixtures: ["regular", "empty", "absent", "oversize"],
      inboxAuthority: "deferred", postJoinInboxProof: false } })
} catch (error) {
  failure = error
  facts.failureContext = { operation: facts.lastOperation, relativePath: facts.lastRelativePath }
}
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
