import { expect, spyOn, test } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as controls from './OpenCodeV2RunControl.js'
import type { RunControlRecord, RunProcessIdentity } from './OpenCodeV2RunTypes.js'
import { boundOpenCodeRead } from '../transport/OpenCodeBoundedFetch.js'

// Real owner processes and kernel process reads. Only the status transport is
// replaced where a mid-measurement failure must be reproduced deterministically.
const peer = fileURLToPath(new URL('./fixtures/OpenCodeV2RunControlPeer.ts', import.meta.url))
const providerEndpoint = fileURLToPath(new URL('./fixtures/OpenCodeV2ProviderEndpointPreload.ts', import.meta.url))
const binding = { teamId: 'TEST-team', runId: 'TEST-run', controllerInstanceId: 'controller', ownerId: 'owner' }
const target = { memberId: 'worker', originalSessionId: 'ses_TESToriginal', selectedModel: 'TEST/TEST', pin: '2.0.32' as const }
const posix = process.platform !== 'win32'

function ready(child: ChildProcess): Promise<void> {
  return boundOpenCodeRead(new Promise<void>((resolve, reject) => {
    let output = '', stderr = ''
    child.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-4096) })
    child.stdout?.on('data', chunk => { output += String(chunk); if (output.includes('ready\n')) resolve() })
    child.once('error', reject); child.once('exit', () => reject(new Error('TEST_peer_exited_before_ready: ' + stderr)))
  // Peers import the runtime graph; loaded runners need more than the 20s fixture budget.
  }), 45_000)
}
function exited(child: ChildProcess): Promise<void> {
  return child.exitCode !== null || child.signalCode !== null ? Promise.resolve()
    : new Promise<void>(resolve => child.once('exit', () => resolve()))
}
async function stopTestChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const done = exited(child); child.kill('SIGKILL'); await boundOpenCodeRead(done, 3000)
}
async function caught(work: Promise<unknown>): Promise<unknown> {
  return work.then(value => { throw new Error(`TEST_unexpected_result ${JSON.stringify(value)}`) }, (error: unknown) => error)
}
/** A published control record for an exact process, without a live listener. */
async function publishedRecord(root: string, identity: RunProcessIdentity): Promise<RunControlRecord> {
  const directory = await controls.reserveRunControlDirectory(root, binding, 'a'.repeat(64))
  const uid = process.getuid?.()
  if (uid === undefined) throw new Error('TEST_uid_required')
  const record: RunControlRecord = { schema: 1, protocol: 1, binding, process: identity, directory,
    socketPath: path.join(directory, 'control.sock'), socketDevice: 1, socketInode: 1,
    deadline: Date.now() + 60_000, uid, sourceSha256: 'a'.repeat(64) }
  await controls.writeRunControlFile(directory, 'control.json', record)
  return record
}
/** The measured identity of a process that has since exited and been reaped. */
async function exitedIdentity(): Promise<RunProcessIdentity> {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  try {
    if (!child.pid) throw new Error('TEST_child_pid_missing')
    return await controls.readRunProcessIdentity(child.pid)
  } finally { await stopTestChild(child) }
}
const ownerFailure = { category: 'provider_response_invalid', operation: { operation: 'provider-read', stage: 'decode', status: 404 } } as const

const ownerFailures = {
  // A real provider read through the wire, refused at its decode stage with 404.
  wire: { argument: 'TEST-provider-read-404', failure: ownerFailure },
  unclassified: { argument: 'provider_response_invalid SECRET /private/auth', failure: { category: 'provider_operation_unknown' } },
} as const
for (const [kind, { argument, failure: expected }] of Object.entries(ownerFailures))
  test.skipIf(!posix)(`an owner whose initialization fails with ${kind === 'wire' ? 'a provider wire' : 'an unclassified'} cause records it and readiness reports the retirement`, async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'TEST-owner-retired-')))
    const directory = await controls.reserveRunControlDirectory(root, binding, 'a'.repeat(64))
    const owner = spawn(process.execPath, ['--preload', providerEndpoint, peer, 'serve-fail', root, JSON.stringify(binding), argument],
      { stdio: ['ignore', 'pipe', 'pipe'] })
    try {
      await ready(owner)
      const record = await controls.discoverOpenCodeV2Run(root, binding.teamId, binding.runId)
      if (!record) throw new Error('TEST_record_missing')
      const waiting = caught(controls.awaitOpenCodeV2RunMemberReadiness(record, target, 15_000))
      await writeFile(path.join(directory, 'TEST-release-initialization'), '', { flag: 'wx', mode: 0o600 })
      const error = await waiting
      expect(error).toMatchObject({ message: 'run_owner_retired' })
      expect(controls.readOpenCodeV2RunOwnerRetiredError(error)).toEqual({ failure: expected })
      const text = await readFile(path.join(directory, 'owner-failure.json'), 'utf8')
      expect(JSON.parse(text)).toEqual({ binding, failure: expected })
      expect(text).not.toContain('SECRET')
      expect((await lstat(path.join(directory, 'owner-failure.json'))).mode & 0o777).toBe(0o600)
      expect(JSON.parse(await readFile(path.join(directory, 'stop.json'), 'utf8')).receipt).toEqual({ kind: 'stop', state: 'cleanup_unknown', members: [] })
      await boundOpenCodeRead(exited(owner), 5000)
      expect(await controls.readOpenCodeV2RunOwnerRetirement(record)).toEqual({ failure: expected })
      // An error that was not minted from a proven retirement carries no cause.
      expect(controls.readOpenCodeV2RunOwnerRetiredError(new Error('run_owner_retired'))).toBeUndefined()
    } finally { await stopTestChild(owner); await rm(root, { recursive: true, force: true }) }
  }, 120_000)

test.skipIf(!posix)('a requested stop during initialization is not recorded as the owner failure', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'TEST-owner-stopped-')))
  const directory = await controls.reserveRunControlDirectory(root, binding, 'a'.repeat(64))
  const owner = spawn(process.execPath, [peer, 'serve-delayed', root, JSON.stringify(binding)], { stdio: ['ignore', 'pipe', 'pipe'] })
  try {
    await ready(owner)
    const record = await controls.discoverOpenCodeV2Run(root, binding.teamId, binding.runId)
    if (!record) throw new Error('TEST_record_missing')
    await controls.requestOpenCodeV2Run(record, { operation: 'stop' }, 5000).catch((error: unknown) => {
      // The held acquisition aborts with the stop and can close the endpoint before the reply.
      if (!(error instanceof Error && error.message === 'run_control_disconnected')) throw error
    })
    await boundOpenCodeRead(exited(owner), 10_000)
    await lstat(path.join(directory, 'tombstone.json'))
    await expect(lstat(path.join(directory, 'owner-failure.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await controls.readOpenCodeV2RunOwnerRetirement(record)).toEqual({ failure: null })
  } finally { await stopTestChild(owner); await rm(root, { recursive: true, force: true }) }
}, 120_000)

test.skipIf(!posix)('an identity measurement that fails because the owner exited is an owner retirement with its cause', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'TEST-owner-exit-measure-')))
  try {
    const record = await publishedRecord(root, await exitedIdentity())
    await controls.writeRunControlFile(record.directory, 'owner-failure.json', { binding, failure: ownerFailure })
    // The process vanished between the two kernel reads of its identity.
    const request = spyOn(controls, 'requestOpenCodeV2Run').mockImplementation(async () => { throw new Error('run_process_changed') })
    try {
      const error = await caught(controls.awaitOpenCodeV2RunMemberReadiness(record, target, 5000))
      expect(error).toMatchObject({ message: 'run_owner_retired' })
      expect(controls.readOpenCodeV2RunOwnerRetiredError(error)).toEqual({ failure: ownerFailure })
      expect(request).toHaveBeenCalledTimes(1)
      // Only closed categories are read back; anything else is unknown.
      for (const category of ['TEST message with spaces', 'run_owner_retired_TEST', 'native_execution_failed']) {
        await controls.writeRunControlFile(record.directory, 'owner-failure.json', { binding, failure: { category } })
        expect(await controls.readOpenCodeV2RunOwnerRetirement(record)).toEqual({ failure: { category: 'provider_operation_unknown' } })
      }
      // The cause is observational: a malformed record never blocks the proven retirement.
      for (const failure of [{ category: 'provider_response_invalid', extra: true }, { category: 7 },
        { ...ownerFailure, operation: { ...ownerFailure.operation, operation: 'TEST-operation' } },
        { ...ownerFailure, operation: { ...ownerFailure.operation, stage: 'TEST-stage' } },
        { ...ownerFailure, operation: { ...ownerFailure.operation, status: 42 } }]) {
        await controls.writeRunControlFile(record.directory, 'owner-failure.json', { binding, failure })
        expect(await controls.readOpenCodeV2RunOwnerRetirement(record)).toEqual({ failure: null })
      }
      await controls.writeRunControlFile(record.directory, 'owner-failure.json', { binding: { ...binding, runId: 'TEST-other' }, failure: ownerFailure })
      expect(await controls.readOpenCodeV2RunOwnerRetirement(record)).toEqual({ failure: null })
    } finally { request.mockRestore() }
  } finally { await rm(root, { recursive: true, force: true }) }
}, 30_000)

test.skipIf(!posix)('a live process holding the published PID under another identity stays a process change', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'TEST-owner-pid-reuse-')))
  const live = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  try {
    if (!live.pid) throw new Error('TEST_child_pid_missing')
    const measured = await controls.readRunProcessIdentity(live.pid)
    // The published identity names an earlier instance; another process now holds the PID.
    const [unique, version] = measured.startTicks.split(':')
    const startTicks = process.platform === 'darwin' ? `${BigInt(unique!) + 1n}:${version}` : String(BigInt(measured.startTicks) + 1n)
    const record = await publishedRecord(root, { ...measured, startTicks })
    await controls.writeRunControlFile(record.directory, 'owner-failure.json', { binding, failure: ownerFailure })
    const request = spyOn(controls, 'requestOpenCodeV2Run').mockImplementation(async () => { throw new Error('run_process_changed') })
    try {
      const error = await caught(controls.awaitOpenCodeV2RunMemberReadiness(record, target, 5000))
      expect(error).toMatchObject({ message: 'run_process_changed' })
      expect(controls.readOpenCodeV2RunOwnerRetiredError(error)).toBeUndefined()
      expect(await controls.readOpenCodeV2RunOwnerRetirement(record)).toBeNull()
      // Only the owner's own retired stop archive proves retirement once the PID changed hands.
      await controls.writeRunControlFile(record.directory, 'tombstone.json', { binding })
      await controls.writeRunControlFile(record.directory, 'stop.json', { binding, receipt: { kind: 'stop', state: 'cleanup_unknown', members: [] } })
      expect(await controls.readOpenCodeV2RunOwnerRetirement(record)).toEqual({ failure: ownerFailure })
    } finally { request.mockRestore() }
  } finally { await stopTestChild(live); await rm(root, { recursive: true, force: true }) }
}, 30_000)

test.skipIf(!posix)('a live owner keeps the original error: at once without a tombstone, after the bounded window while stopping', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'TEST-owner-live-')))
  try {
    const record = await publishedRecord(root, await controls.readRunProcessIdentity())
    const missing = Object.assign(new Error('TEST endpoint missing'), { code: 'ENOENT' })
    const request = spyOn(controls, 'requestOpenCodeV2Run').mockImplementation(async () => { throw missing })
    try {
      // Without a tombstone the error returns at once, well inside the 10s stop window
      // that a stopping owner would be followed for.
      let started = Date.now()
      expect(await caught(controls.awaitOpenCodeV2RunMemberReadiness(record, target, 20_000))).toBe(missing)
      expect(Date.now() - started).toBeLessThan(9000)
      expect(await controls.readOpenCodeV2RunOwnerRetirement(record)).toBeNull()
      // With a tombstone the same live owner is followed until the readiness deadline.
      await controls.writeRunControlFile(record.directory, 'tombstone.json', { binding })
      started = Date.now()
      expect(await caught(controls.awaitOpenCodeV2RunMemberReadiness(record, target, 1500))).toBe(missing)
      expect(Date.now() - started).toBeGreaterThanOrEqual(1000)
      expect(await controls.readOpenCodeV2RunOwnerRetirement(record)).toBeNull()
    } finally { request.mockRestore() }
  } finally { await rm(root, { recursive: true, force: true }) }
}, 30_000)

test('Windows presence never proves absence: an unreadable start time stays unknown', async () => {
  const identity = { pid: 4242, startTicks: '1700000000000', bootId: 'windows', executablePath: 'windows-process', executableSha256: '0'.repeat(64) }
  // Gone, exited and access denied all read as null on Windows.
  const unknown = await caught(controls.readWindowsRunProcessPresence(identity, async () => null))
  expect(unknown).toMatchObject({ message: 'run_process_unknown' })
  expect((unknown as { code?: unknown }).code).toBeUndefined()
  expect(await controls.readWindowsRunProcessPresence(identity, async () => 1700000000000)).toBe('same')
  expect(await controls.readWindowsRunProcessPresence(identity, async () => 1700000000001)).toBe('replaced')
})
