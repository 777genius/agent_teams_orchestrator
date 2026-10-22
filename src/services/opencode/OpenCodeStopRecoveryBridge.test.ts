import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { executeOpenCodeBridgeCommandEnvelope } from './OpenCodeBridgeCommandHandler.js'
import { OpenCodeSessionStore, openCodeSessionStore } from './OpenCodeSessionStore.js'
import { openCodeSessionBridge } from './OpenCodeSessionBridge.js'
import { openCodeHostManager } from './OpenCodeHostManager.js'
import { openCodeProvisioningProbe } from './OpenCodeProvisioningProbe.js'
import type { OpenCodeStopRequest } from './OpenCodeStopRecovery.js'
import type { OpenCodeSessionRecord } from './types.js'
import { parseOpenCodeStopRequest } from './OpenCodeStopRecovery.js'
import { validateEnvelope } from './bridge/OpenCodeBridgeProtocol.js'

let dir: string
let store: OpenCodeSessionStore
let record: OpenCodeSessionRecord
let request: OpenCodeStopRequest
const restores: (() => void)[] = []
const track = <T extends { mockRestore(): void }>(mock: T): T => {
  restores.push(() => mock.mockRestore())
  return mock
}
const capability = `opencode:${'a'.repeat(32)}`
const behavior = 'b'.repeat(64)
const runtime = { providerId: 'opencode' as const, binaryPath: 'opencode', binaryFingerprint: null,
  version: null, capabilitySnapshotId: capability }
function envelope(command: string, body: Record<string, unknown> = {}, timeoutMs = 20_000) {
  return { schemaVersion: 1, requestId: command === 'opencode.stopTeam' ? request.originalRequestId : 'query-request',
    command, cwd: dir, startedAt: new Date().toISOString(), timeoutMs, body }
}
function stopBody() {
  return { teamId: record.teamId, laneId: record.laneId, runId: record.runId, stopRecovery: request,
    preconditions: { handshakeIdentityHash: 'handshake', laneId: record.laneId, expectedRunId: record.runId,
      expectedCapabilitySnapshotId: capability, expectedBehaviorFingerprint: behavior,
      expectedManifestHighWatermark: 0, commandLeaseId: 'app-lease', idempotencyKey: request.idempotencyKey } }
}
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'stop-recovery-bridge-'))
  store = new OpenCodeSessionStore(path.join(dir, 'sessions.json'))
  record = { teamId: 'team', laneId: 'primary', runId: 'run', memberName: 'alice', providerId: 'opencode',
    selectedModel: 'openai/gpt-5.4', projectPath: dir, profileRootKey: 'profile', hostKey: 'shared-host',
    profileScope: { purpose: 'launch_runtime', providerId: 'openai', scopeToken: 'scope',
      configFingerprint: 'config', selectedAuthIdentity: 'absent' }, toolApprovalMode: 'auto',
    opencodeSessionId: 'original-session', expectedBehaviorFingerprint: behavior,
    stopAuthority: { runtime, expectedBehaviorFingerprint: behavior }, resolvedBehaviorFingerprint: null,
    lastCanonicalCursor: null, lastKnownRawStatus: null, lastKnownDurableState: null,
    sourceAuthFingerprint: null, managedAuthFingerprint: null, projectBehaviorFingerprint: behavior,
    staleReason: null, createdAt: '2026-09-09T00:00:00.000Z', updatedAt: '2026-09-09T00:00:00.000Z' }
  request = { contractVersion: 1, originalRequestId: 'original-request', idempotencyKey: 'original-key',
    target: { teamId: 'team', laneId: 'primary', runId: 'run', projectPath: dir, capabilitySnapshotId: capability,
      expectedBehaviorFingerprint: behavior, members: [{ memberName: 'alice', sessionId: record.opencodeSessionId }] } }
  await store.upsert(record)
  track(spyOn(openCodeSessionStore, 'list').mockImplementation(() => store.list()))
  track(spyOn(openCodeSessionStore, 'get').mockImplementation((team, lane, member) => store.get(team, lane, member)))
  track(spyOn(openCodeSessionStore, 'lookupStop').mockImplementation((input, signal) => store.lookupStop(input, signal)))
  track(spyOn(openCodeSessionStore, 'beginStop').mockImplementation((input, authority, signal) => store.beginStop(input, authority, signal)))
  track(spyOn(openCodeSessionStore, 'completeStop').mockImplementation((input, data) => store.completeStop(input, data)))
  track(spyOn(openCodeSessionStore, 'reconcileStop').mockImplementation((input, legacy, signal) => store.reconcileStop(input, legacy, signal)))
  track(spyOn(openCodeSessionStore, 'markStoppedIfSession').mockImplementation((input, authority, signal) => store.markStoppedIfSession(input, authority, signal)))
  track(spyOn(openCodeProvisioningProbe, 'probe').mockImplementation(async () => { throw new Error('Unexpected host launch/probe') }))
  track(spyOn(openCodeProvisioningProbe, 'probeRetainingHost').mockImplementation(async () => { throw new Error('Unexpected host acquire') }))
  track(spyOn(openCodeHostManager, 'resolveOwnedSessionEndpoint').mockResolvedValue({ baseUrl: 'http://127.0.0.1:1', pid: 42 }))
  track(spyOn(openCodeSessionBridge, 'observeStopIdle').mockResolvedValue({
    arm() {}, currentStatus: () => 'idle', waitForIdle: async () => true, dispose: async () => {},
  }))
  track(spyOn(openCodeSessionBridge, 'getRawStatus').mockResolvedValue({ type: 'idle' }))
  track(spyOn(openCodeSessionBridge, 'releaseSession').mockResolvedValue(undefined))
  track(spyOn(openCodeHostManager, 'reconcilePersistentHosts').mockResolvedValue({
    inspected: 1, cleaned: 0, retained: 1, diagnostics: [],
  }))
})
afterEach(async () => {
  for (const restore of restores.splice(0).reverse()) restore()
  await rm(dir, { recursive: true, force: true })
})

for (const stopped of [true, false]) test(`wire Stop retains original ${stopped} and replay bypasses host/message status`, async () => {
  const abort = track(spyOn(openCodeSessionBridge, 'abort').mockImplementation(async () => {
    if (!stopped) throw new Error('abort transport uncertain')
    return true
  }))
  const original = await executeOpenCodeBridgeCommandEnvelope(envelope('opencode.stopTeam', stopBody()))
  expect(original.ok).toBe(true)
  if (!original.ok) throw new Error(original.error.message)
  expect(original.data.stopped).toBe(stopped)
  store = new OpenCodeSessionStore(path.join(dir, 'sessions.json'))
  const lookup = await executeOpenCodeBridgeCommandEnvelope(envelope('opencode.stopOutcome', { stopRecovery: request }))
  expect(lookup.ok).toBe(true)
  if (!lookup.ok) throw new Error(lookup.error.message)
  expect(lookup.data.status).toBe('completed')
  expect(lookup.data.receipt.data).toEqual(original.data)
  const replay = await executeOpenCodeBridgeCommandEnvelope(envelope('opencode.stopTeam', stopBody()))
  expect(replay.ok).toBe(true)
  if (replay.ok) expect(replay.data).toEqual(original.data)
  expect(abort).toHaveBeenCalledTimes(1)
})

test('timeout after effect persists false instead of turning duplicate into true', async () => {
  let now = 1_000
  track(spyOn(performance, 'now').mockImplementation(() => now))
  const abort = track(spyOn(openCodeSessionBridge, 'abort').mockResolvedValue(true))
  track(spyOn(openCodeSessionStore, 'markStoppedIfSession').mockImplementation(async (input, authority) => {
    const terminal = await store.markStoppedIfSession(input, authority)
    now = 2_501
    return terminal
  }))
  const first = await executeOpenCodeBridgeCommandEnvelope(envelope('opencode.stopTeam', stopBody(), 1_500))
  expect(first.ok).toBe(true)
  if (!first.ok) throw new Error(first.error.message)
  expect(first.data.stopped).toBe(false)
  const replay = await executeOpenCodeBridgeCommandEnvelope(envelope('opencode.stopTeam', stopBody()))
  expect(replay.ok).toBe(true)
  if (replay.ok) expect(replay.data).toEqual(first.data)
  const reconciled = await executeOpenCodeBridgeCommandEnvelope(envelope('opencode.reconcileStop', { stopRecovery: request }))
  expect(reconciled.ok && reconciled.data.status).toBe('reconciled_stopped')
  expect(abort).toHaveBeenCalledTimes(1)
})

test('completion-write failure after effect is durable inflight and reconciles without replay', async () => {
  const abort = track(spyOn(openCodeSessionBridge, 'abort').mockResolvedValue(true))
  track(spyOn(openCodeSessionStore, 'completeStop').mockRejectedValue(new Error('injected completion write failure')))
  const first = await executeOpenCodeBridgeCommandEnvelope(envelope('opencode.stopTeam', stopBody()))
  expect(first.ok).toBe(false)
  store = new OpenCodeSessionStore(path.join(dir, 'sessions.json'))
  const query = await executeOpenCodeBridgeCommandEnvelope(envelope('opencode.stopOutcome', { stopRecovery: request }))
  expect(query.ok && query.data.status).toBe('inflight')
  const retry = await executeOpenCodeBridgeCommandEnvelope(envelope('opencode.stopTeam', stopBody()))
  expect(retry.ok).toBe(false)
  const reconciled = await executeOpenCodeBridgeCommandEnvelope(envelope('opencode.reconcileStop', { stopRecovery: request }))
  expect(reconciled.ok && reconciled.data.status).toBe('reconciled_stopped')
  expect(abort).toHaveBeenCalledTimes(1)
})

test('recovery handshake is host-free and explicitly advertises Stop version; unsupported request fails', async () => {
  const handshake = await executeOpenCodeBridgeCommandEnvelope(envelope('opencode.handshake', { requiredCommand: 'opencode.stopOutcome' }))
  expect(handshake.ok).toBe(true)
  if (!handshake.ok) throw new Error(handshake.error.message)
  expect(handshake.data.stopRecoveryContractVersion).toBe(1)
  expect(handshake.data.acceptedCommands).toContain('opencode.reconcileStop')
  const unsupported = await executeOpenCodeBridgeCommandEnvelope(envelope('opencode.stopOutcome', {
    stopRecovery: { ...request, contractVersion: 2 },
  }))
  expect(unsupported.ok).toBe(false)
  if (!unsupported.ok) expect(unsupported.error.message).toContain('Unsupported')
})

test('legacy retained terminal record recovers on wire without a historical receipt', async () => {
  await store.markStoppedIfSession(record, record.stopAuthority)
  const query = await executeOpenCodeBridgeCommandEnvelope(envelope('opencode.stopOutcome', { stopRecovery: request }))
  expect(query.ok && query.data.status).toBe('unknown')
  const reconciled = await executeOpenCodeBridgeCommandEnvelope(envelope('opencode.reconcileStop', { stopRecovery: request }))
  expect(reconciled.ok && reconciled.data.status).toBe('reconciled_stopped')
  if (reconciled.ok) expect(reconciled.data).not.toHaveProperty('receipt')
})

test('dead-host retirement never becomes a true Stop receipt', async () => {
  await store.upsert({ ...record, stoppedAt: '2026-09-09T01:00:00.000Z', staleReason: 'runtime_process_gone' })
  const abort = track(spyOn(openCodeSessionBridge, 'abort').mockResolvedValue(true))
  const first = await executeOpenCodeBridgeCommandEnvelope(envelope('opencode.stopTeam', stopBody()))
  expect(first.ok).toBe(true)
  if (!first.ok) throw new Error(first.error.message)
  expect(first.data.stopped).toBe(false)
  expect(first.data.members.alice.diagnostics).toContain('runtime disappeared without confirmed Stop')
  const replay = await executeOpenCodeBridgeCommandEnvelope(envelope('opencode.stopTeam', stopBody()))
  expect(replay.ok).toBe(true)
  if (replay.ok) expect(replay.data).toEqual(first.data)
  const current = await executeOpenCodeBridgeCommandEnvelope(envelope('opencode.reconcileStop', { stopRecovery: request }))
  expect(current.ok && current.data.status).toBe('unknown')
  expect(abort).not.toHaveBeenCalled()
})

test('retirement after lease release and before terminal CAS retains false across receipt, replay and reconciliation', async () => {
  const abort = track(spyOn(openCodeSessionBridge, 'abort').mockResolvedValue(true))
  let leaseReleased = false
  const release = track(spyOn(openCodeSessionBridge, 'releaseSession').mockImplementation(async () => {
    leaseReleased = true
  }))
  const restore = track(spyOn(openCodeSessionBridge, 'restoreSessionLease').mockResolvedValue(undefined))
  let retired: OpenCodeSessionRecord | null = null
  const terminalCas = track(spyOn(openCodeSessionStore, 'markStoppedIfSession').mockImplementation(async (input, authority, signal) => {
    expect(leaseReleased).toBe(true)
    expect(authority).toEqual(record.stopAuthority)
    // Pause Stop at its terminal CAS entry, after strict release has returned.
    // A separate store instance commits the successor launch's retirement first.
    const successorStore = new OpenCodeSessionStore(path.join(dir, 'sessions.json'))
    retired = await successorStore.retireAbsentRuntimeIfSession(record, 'next-run')
    expect(retired?.staleReason).toBe('runtime_process_gone')
    expect(retired?.stopAuthority).toEqual(record.stopAuthority)
    return store.markStoppedIfSession(input, authority, signal)
  }))
  const first = await executeOpenCodeBridgeCommandEnvelope(envelope('opencode.stopTeam', stopBody()))
  expect(first.ok).toBe(true)
  if (!first.ok) throw new Error(first.error.message)
  expect(first.data.stopped).toBe(false)
  expect(first.data.members.alice.stopped).toBe(false)
  expect(first.data.members.alice.diagnostics).toContain('runtime disappeared without confirmed Stop')
  expect(first.data.diagnostics).toContainEqual(expect.objectContaining({
    code: 'opencode_stop_status_unconfirmed', severity: 'warning',
  }))
  store = new OpenCodeSessionStore(path.join(dir, 'sessions.json'))
  const lookup = await executeOpenCodeBridgeCommandEnvelope(envelope('opencode.stopOutcome', { stopRecovery: request }))
  expect(lookup.ok).toBe(true)
  if (!lookup.ok) throw new Error(lookup.error.message)
  expect(lookup.data.status).toBe('completed')
  expect(lookup.data.receipt.data).toEqual(first.data)
  const replay = await executeOpenCodeBridgeCommandEnvelope(envelope('opencode.stopTeam', stopBody()))
  expect(replay.ok).toBe(true)
  if (replay.ok) expect(replay.data).toEqual(first.data)
  const current = await executeOpenCodeBridgeCommandEnvelope(envelope('opencode.reconcileStop', { stopRecovery: request }))
  expect(current.ok && current.data.status).toBe('unknown')
  expect(await store.get(record.teamId, record.laneId!, record.memberName)).toEqual(retired)
  expect(abort).toHaveBeenCalledTimes(1)
  expect(release).toHaveBeenCalledTimes(1)
  expect(release).toHaveBeenCalledWith(record, { strictLeaseRelease: true })
  expect(terminalCas).toHaveBeenCalledTimes(1)
  expect(restore).not.toHaveBeenCalled()
})

test('cancellation after terminal CAS persists the original result before rejecting transport', async () => {
  const controller = new AbortController()
  const abort = track(spyOn(openCodeSessionBridge, 'abort').mockResolvedValue(true))
  track(spyOn(openCodeSessionStore, 'markStoppedIfSession').mockImplementation(async (input, authority) => {
    const terminal = await store.markStoppedIfSession(input, authority)
    controller.abort(new Error('caller cancelled after effect'))
    return terminal
  }))
  const first = await executeOpenCodeBridgeCommandEnvelope(envelope('opencode.stopTeam', stopBody()), {
    signal: controller.signal,
  })
  expect(first.ok).toBe(false)
  const recovered = await executeOpenCodeBridgeCommandEnvelope(envelope('opencode.stopOutcome', { stopRecovery: request }))
  expect(recovered.ok && recovered.data.status).toBe('completed')
  if (recovered.ok) expect(recovered.data.receipt.data.stopped).toBe(true)
  expect(abort).toHaveBeenCalledTimes(1)
})

test('wire target mismatch performs no abort and writes no receipt', async () => {
  const abort = track(spyOn(openCodeSessionBridge, 'abort').mockResolvedValue(true))
  const body = stopBody()
  body.stopRecovery = { ...request, target: { ...request.target,
    members: [{ memberName: 'alice', sessionId: 'successor-session' }] } }
  const first = await executeOpenCodeBridgeCommandEnvelope(envelope('opencode.stopTeam', body))
  expect(first.ok).toBe(false)
  expect(abort).not.toHaveBeenCalled()
  expect((await store.lookupStop(request)).status).toBe('unknown')
})

test.skipIf(!process.env.AGENT_TEAMS_TEST_STOP_WIRE_PACKET)(
  'admits exact app-client alias Stop/recovery bytes while rejecting raw aliases and changed sessions', async () => {
    const packetPath = process.env.AGENT_TEAMS_TEST_STOP_WIRE_PACKET!
    if (!path.isAbsolute(packetPath) || !packetPath.split(path.sep).some(part => part.startsWith('TEST-'))) {
      throw new Error('App Stop wire contract requires an explicit TEST packet')
    }
    const packet = JSON.parse(await readFile(packetPath, 'utf8')) as { projectAlias: string; wires: unknown[] }
    const wires = packet.wires.map(validateEnvelope)
    expect(wires.map(wire => wire.command)).toEqual(['opencode.stopTeam', 'opencode.stopOutcome', 'opencode.reconcileStop'])
    const stop = wires[0]!
    request = parseOpenCodeStopRequest(stop.body.stopRecovery)
    expect(packet.projectAlias).not.toBe(request.target.projectPath)
    record = { ...record, teamId: request.target.teamId, laneId: request.target.laneId,
      runId: request.target.runId, projectPath: request.target.projectPath,
      memberName: request.target.members[0]!.memberName,
      opencodeSessionId: request.target.members[0]!.sessionId,
      expectedBehaviorFingerprint: request.target.expectedBehaviorFingerprint,
      stopAuthority: { runtime: { ...runtime, capabilitySnapshotId: request.target.capabilitySnapshotId },
        expectedBehaviorFingerprint: request.target.expectedBehaviorFingerprint } }
    store = new OpenCodeSessionStore(path.join(dir, 'app-wire-sessions.json'))
    for (const member of request.target.members) {
      await store.upsert({ ...record, memberName: member.memberName, opencodeSessionId: member.sessionId })
    }
    const abort = track(spyOn(openCodeSessionBridge, 'abort').mockResolvedValue(true))
    const wrongCwd = await executeOpenCodeBridgeCommandEnvelope({ ...stop, cwd: packet.projectAlias })
    expect(wrongCwd.ok).toBe(false)
    if (!wrongCwd.ok) expect(wrongCwd.error.message).toContain('Stop target project mismatch')
    const wrongBody = await executeOpenCodeBridgeCommandEnvelope({ ...stop,
      body: { ...stop.body, projectPath: packet.projectAlias } })
    expect(wrongBody.ok).toBe(false)
    if (!wrongBody.ok) expect(wrongBody.error.message).toContain('Stop original request/target mismatch')
    expect(abort).not.toHaveBeenCalled()
    expect((await store.lookupStop(request)).status).toBe('unknown')

    const original = await executeOpenCodeBridgeCommandEnvelope(stop)
    expect(original.ok).toBe(true)
    if (!original.ok) throw new Error(original.error.message)
    expect(original.data.stopped).toBe(true)
    const outcome = await executeOpenCodeBridgeCommandEnvelope(wires[1]!)
    expect(outcome.ok && outcome.data.status).toBe('completed')
    const reconciled = await executeOpenCodeBridgeCommandEnvelope(wires[2]!)
    expect(reconciled.ok && reconciled.data.status).toBe('reconciled_stopped')
    const foreignSession = await executeOpenCodeBridgeCommandEnvelope({ ...stop, body: { ...stop.body,
      stopRecovery: { ...request, target: { ...request.target,
        members: [{ memberName: record.memberName, sessionId: 'foreign-generation' }] } } } })
    expect(foreignSession.ok).toBe(false)
    expect(abort).toHaveBeenCalledTimes(request.target.members.length)
    expect(abort.mock.calls.map(call => call[0].opencodeSessionId).sort()).toEqual(
      request.target.members.map(member => member.sessionId).sort(),
    )
  }
)

test('Stop only releases the original member on a host shared with another team', async () => {
  const sibling = { ...record, teamId: 'sibling', opencodeSessionId: 'sibling-session' }
  await store.upsert(sibling)
  const abort = track(spyOn(openCodeSessionBridge, 'abort').mockResolvedValue(true))
  const release = track(spyOn(openCodeSessionBridge, 'releaseSession').mockResolvedValue(undefined))
  const first = await executeOpenCodeBridgeCommandEnvelope(envelope('opencode.stopTeam', stopBody()))
  expect(first.ok && first.data.stopped).toBe(true)
  expect(abort).toHaveBeenCalledTimes(1)
  expect(abort.mock.calls[0]?.[0].opencodeSessionId).toBe(record.opencodeSessionId)
  expect(release).toHaveBeenCalledTimes(1)
  expect(release.mock.calls[0]?.[0].opencodeSessionId).toBe(record.opencodeSessionId)
  expect(await store.get('sibling', 'primary', 'alice')).toEqual(sibling)
})
