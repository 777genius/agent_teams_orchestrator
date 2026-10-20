import { describe, expect, spyOn, test } from 'bun:test'
import { resolveRuntimeTranscriptProjection, type RuntimeTranscriptProjection } from './runtimeTranscriptV2.js'
import { runtimeTranscript } from './handlers/runtime.js'
import { openCodeSessionStore } from '../services/opencode/OpenCodeSessionStore.js'
import { openCodeSessionBridge } from '../services/opencode/OpenCodeSessionBridge.js'
import { executeExistingOpenCodeV2TranscriptEnvelope, OpenCodeV2TeamBridge } from '../services/opencode/bridge/OpenCodeV2TeamBridge.js'
import { normalizeV2Transcript } from '../services/opencode/bridge/OpenCodeV2TranscriptProjection.js'
import { openCodeHostManager } from '../services/opencode/OpenCodeHostManager.js'
import { openCodeProfileManager } from '../services/opencode/OpenCodeProfileManager.js'
import * as launch from '../services/opencode/bridge/OpenCodeV2LaunchPlan.js'
import * as probe from '../services/opencode/bridge/OpenCodeV2ExecutionProbe.js'
import type { OpenCodeSessionRecord } from '../services/opencode/types.js'
import type { RunControlRecord, RunControlRequest, RunControlResult } from '../services/opencode/bridge/OpenCodeV2RunTypes.js'

const selection = { team: 'TEST-team', runId: 'TEST-run', lane: 'TEST-lane', member: 'TEST-worker', sessionId: 'ses_TESToriginal' }
const record: OpenCodeSessionRecord = { teamId: selection.team, runId: selection.runId, laneId: selection.lane,
  memberName: selection.member, providerId: 'opencode', selectedModel: 'TEST/model', projectPath: '/TEST-project',
  profileRootKey: 'TEST-profile', hostKey: 'TEST-host', opencodeSessionId: selection.sessionId, opencodeVersion: '1.2.18',
  resolvedBehaviorFingerprint: null, lastCanonicalCursor: null, lastKnownRawStatus: null, lastKnownDurableState: null,
  sourceAuthFingerprint: null, managedAuthFingerprint: null, projectBehaviorFingerprint: 'TEST', staleReason: null,
  createdAt: '2026-10-19T00:00:00Z', updatedAt: '2026-10-19T00:00:00Z' }
function cut(): Extract<RunControlResult, { kind: 'transcript' }> {
  const rows = [
    { id: 'msg_TESTinput', type: 'user', text: 'TEST original input', time: { created: 10 } },
    { id: 'msg_TESTassistant', type: 'assistant', agent: 'TEST-agent', model: { providerID: 'TEST', id: 'model' },
      time: { created: 20, completed: 30 }, finish: 'stop', content: [{ type: 'tool', id: 'TEST-shell', name: 'shell',
        state: { status: 'completed', input: { command: 'node C:\\TEST-project\\verify.cjs' },
          content: [{ type: 'text', text: 'TEST passed' }] }, time: { created: 21, ran: 22, completed: 29 } }] },
  ]
  return { kind: 'transcript', messages: { previous: null, next: null,
    data: rows.map(data => ({ id: data.id, type: data.type, timeCreated: data.time.created, data })) },
    log: { synced: true, watermark: null, events: [] } }
}
const normalized = () => normalizeV2Transcript(cut(), selection.sessionId)
function ports(found: OpenCodeSessionRecord | null = null) {
  const counts = { legacyResolve: 0, legacyFind: 0, legacyProject: 0, v2: 0 }
  const canonical = normalized()
  const legacyResult: RuntimeTranscriptProjection = { record, logProjection: canonical.logProjection, summary: {
    sessionId: record.opencodeSessionId, reconcileOutcome: 'reconciled', rawStatus: null, durableState: canonical.durableState,
    staleReason: null, profileAuthState: null, pendingPermissionRequestIds: [], messageCount: canonical.messages.length,
    toolCallCount: 1, errorCount: 0, lastCanonicalCursor: null, latestUserMessageId: null, latestAssistantMessageId: null,
    latestAssistantText: null, latestAssistantPreview: null, replyPendingSinceMessageId: null,
    messages: canonical.messages, diagnostics: canonical.diagnostics,
  } }
  return { counts, legacyResult, value: {
    resolveLegacy: async () => { counts.legacyResolve++; return record },
    findLegacy: async () => { counts.legacyFind++; return found },
    projectLegacy: async () => { counts.legacyProject++; return legacyResult },
    executeV2: async (input: unknown) => { counts.v2++; const envelope = input as { requestId: string; command: string }
      return { schemaVersion: 1, ok: true, requestId: envelope.requestId, command: envelope.command,
        runtime: { version: '2.0.32' }, data: normalized() } },
  } }
}

describe('runtime transcript original-owner routing', () => {
  test('no-run legacy resolver and projector remain unchanged', async () => {
    const p = ports()
    expect(await resolveRuntimeTranscriptProjection({ team: selection.team, member: selection.member }, p.value)).toBe(p.legacyResult)
    expect(p.counts).toEqual({ legacyResolve: 1, legacyFind: 0, legacyProject: 1, v2: 0 })
  })
  for (const version of [undefined, '1.2.18']) test(`exact stored V1 ${String(version)} with runId stays on old path`, async () => {
    const p = ports({ ...record, opencodeVersion: version })
    expect(await resolveRuntimeTranscriptProjection(selection, p.value)).toBe(p.legacyResult)
    expect(p.counts).toEqual({ legacyResolve: 0, legacyFind: 1, legacyProject: 1, v2: 0 })
  })
  test('positive V1 session spelling keeps the legacy exact-match contract', async () => {
    const original = { ...selection, sessionId: 'legacy-session-TEST' }
    const p = ports({ ...record, opencodeSessionId: original.sessionId })
    expect(await resolveRuntimeTranscriptProjection(original, p.value)).toBe(p.legacyResult)
    expect(p.counts.legacyProject).toBe(1)
    expect(p.counts.v2).toBe(0)
  })
  test('historical V1 absent lane retains the stored primary key semantics', async () => {
    const p = ports({ ...record, laneId: undefined })
    expect(await resolveRuntimeTranscriptProjection({ ...selection, lane: 'primary' }, p.value)).toBe(p.legacyResult)
    expect(p.counts.legacyProject).toBe(1)
    expect(p.counts.v2).toBe(0)
  })
  for (const field of ['teamId', 'runId', 'laneId', 'memberName', 'opencodeSessionId'] as const) test(`stored ${field} mismatch refuses before either route`, async () => {
    const p = ports({ ...record, [field]: 'TEST-foreign' })
    await expect(resolveRuntimeTranscriptProjection(selection, p.value)).rejects.toThrow('v2_transcript_identity_invalid')
    expect(p.counts.legacyProject + p.counts.v2).toBe(0)
  })
  for (const mutation of [{ lane: undefined }, { sessionId: undefined }, { runId: '' }, { lane: ' TEST' }]) test(`incomplete original binding refuses ${JSON.stringify(mutation)}`, async () => {
    const p = ports()
    await expect(resolveRuntimeTranscriptProjection({ ...selection, ...mutation }, p.value)).rejects.toThrow('v2_transcript_identity_invalid')
    expect(p.counts.legacyFind + p.counts.legacyProject + p.counts.v2).toBe(0)
  })
  test('stored unsupported V2 version cannot enter legacy or native read', async () => {
    const p = ports({ ...record, opencodeVersion: '2.0.99' })
    await expect(resolveRuntimeTranscriptProjection(selection, p.value)).rejects.toThrow('v2_transcript_version_unsupported')
    expect(p.counts.legacyProject + p.counts.v2).toBe(0)
  })
  test('stored unsupported V2 on the no-run route never reaches V1', async () => {
    const p = ports()
    p.value.resolveLegacy = async () => ({ ...record, opencodeVersion: '2.0.99' })
    await expect(resolveRuntimeTranscriptProjection({ team: selection.team, member: selection.member }, p.value)).rejects.toThrow('v2_transcript_version_unsupported')
    expect(p.counts.legacyProject + p.counts.v2).toBe(0)
  })
  test('stored supported V2 still requires same original reply pin', async () => {
    const p = ports({ ...record, opencodeVersion: '2.0.0' })
    await expect(resolveRuntimeTranscriptProjection(selection, p.value)).rejects.toThrow('v2_transcript_version_changed')
    expect(p.counts.legacyProject).toBe(0)
  })
  test('missing legacy record uses exact original public read and preserves parentless source markers', async () => {
    const p = ports()
    p.value.executeV2 = async input => {
      p.counts.v2++
      const envelope = input as { requestId: string; command: string; cwd: string; body: unknown }
      expect(envelope.command).toBe('opencode.getRuntimeTranscript')
      expect(envelope.cwd).toBe(process.cwd())
      expect(envelope.body).toEqual({ teamId: selection.team, runId: selection.runId, laneId: selection.lane,
        memberName: selection.member, runtimeSessionId: selection.sessionId })
      return { schemaVersion: 1, ok: true, requestId: envelope.requestId, command: envelope.command,
        runtime: { version: '2.0.32' }, data: normalized() }
    }
    const result = await resolveRuntimeTranscriptProjection(selection, p.value)
    expect(result.record).toEqual({ opencodeSessionId: selection.sessionId })
    expect(result.summary.messages.every(message => message.parentId === null)).toBe(true)
    expect(result.summary.diagnostics).toContain('v2_native_parent_ids_unavailable')
    expect(result.logProjection.diagnostics).toContain('v2_native_parent_ids_unavailable')
    expect(result.logProjection.messages.find(message => message.uuid === 'msg_TESTassistant::tool_results')?.parentUuid).toBe('msg_TESTassistant')
    expect(p.counts).toEqual({ legacyResolve: 0, legacyFind: 1, legacyProject: 0, v2: 1 })
  })
  for (const mutation of ['session', 'marker', 'projection-marker', 'version', 'echo', 'missing-owner']) test(`foreign or incomplete public ${mutation} refuses without fallback`, async () => {
    const p = ports()
    p.value.executeV2 = async input => {
      p.counts.v2++
      const envelope = input as { requestId: string; command: string }
      const data = { ...normalized() }
      if (mutation === 'session') data.sessionId = 'ses_TESTforeign'
      if (mutation === 'marker') data.diagnostics.length = 0
      if (mutation === 'projection-marker') data.logProjection.diagnostics.length = 0
      return { schemaVersion: 1, ok: mutation !== 'missing-owner', requestId: mutation === 'echo' ? 'TEST-foreign' : envelope.requestId,
        command: envelope.command, runtime: { version: mutation === 'version' ? '2.0.99' : '2.0.32' }, data }
    }
    await expect(resolveRuntimeTranscriptProjection(selection, p.value)).rejects.toThrow()
    expect(p.counts.legacyProject).toBe(0)
    expect(p.counts.v2).toBe(1)
  })
  test('the V2 read carries the latest-entry message window to the original owner', async () => {
    const p = ports()
    p.value.executeV2 = async input => {
      p.counts.v2++
      const envelope = input as { requestId: string; command: string; body: unknown }
      expect(envelope.body).toEqual({ teamId: selection.team, runId: selection.runId, laneId: selection.lane,
        memberName: selection.member, runtimeSessionId: selection.sessionId, messageLimit: 1 })
      return { schemaVersion: 1, ok: true, requestId: envelope.requestId, command: envelope.command,
        runtime: { version: '2.0.32' }, data: normalized() }
    }
    await resolveRuntimeTranscriptProjection({ ...selection, limit: 1 }, p.value)
    expect(p.counts.v2).toBe(1)
  })
  for (const invalid of [0, -1, 1.5, Number.NaN]) test(`non-positive or fractional message window ${String(invalid)} refuses before the round trip`, async () => {
    const p = ports()
    await expect(resolveRuntimeTranscriptProjection({ ...selection, limit: invalid }, p.value)).rejects.toThrow('v2_transcript_limit_invalid')
    expect(p.counts.v2).toBe(0)
  })
})

for (const pin of ['2.0.0', '2.0.32'] as const) test(`real fixed command reads normalized ${pin} owner without source/profile/host/probe`, async () => {
  const forbidden = () => { throw new Error('TEST forbidden side effect') }
  const forbiddenSpies = [spyOn(openCodeHostManager, 'ensureHost').mockImplementation(forbidden),
    spyOn(openCodeProfileManager, 'prepareProfile').mockImplementation(forbidden),
    spyOn(openCodeSessionStore, 'upsert').mockImplementation(forbidden),
    spyOn(openCodeSessionBridge, 'projectLogMessages').mockImplementation(forbidden),
    spyOn(launch, 'inspectOpenCodeV2SourceAvailability').mockImplementation(forbidden),
    spyOn(probe, 'resolveOpenCodeV2ExecutionProbe').mockImplementation(forbidden),
    spyOn(OpenCodeV2TeamBridge.prototype, 'launchExplicit').mockImplementation(forbidden)]
  const control: RunControlRecord = { schema: 1, protocol: 1, binding: { teamId: selection.team, runId: selection.runId,
    controllerInstanceId: 'TEST-controller', ownerId: 'TEST-owner' }, directory: '/TEST', deadline: Date.now() + 60_000,
    sourceSha256: 'a'.repeat(64), uid: 1000, socketPath: '/TEST/control.sock', socketDevice: 1, socketInode: 1,
    process: { pid: 123, bootId: 'TEST-boot', startTicks: '123', executablePath: '/TEST/bun', executableSha256: 'b'.repeat(64) } }
  const status: RunControlResult = { kind: 'status', state: 'active', deadline: control.deadline,
    qualification: { version: pin, binaryPath: '/TEST/opencode', binaryFingerprint: 'TEST', capabilitySnapshotId: 'TEST-cap', expectedBehaviorFingerprint: 'a'.repeat(64) },
    members: [{ memberId: selection.member, laneId: selection.lane, originalSessionId: selection.sessionId,
      runtimeSessionId: selection.sessionId, opencodeSessionId: selection.sessionId, pin, state: 'accepted', bootstrap: null,
      selectedModel: 'TEST/model', profileEpoch: 'TEST', profileRoot: '/TEST' }] }
  const operations: string[] = []
  const discover = spyOn(OpenCodeV2TeamBridge.prototype, 'discover').mockResolvedValue(control)
  const call = spyOn(OpenCodeV2TeamBridge.prototype, 'call').mockImplementation(async (request: RunControlRequest) => {
    operations.push(request.operation)
    if (request.operation === 'status') return status
    expect(request).toEqual({ operation: 'transcript', memberId: selection.member, originalSessionId: selection.sessionId })
    return cut()
  })
  try {
    const p = ports()
    const result = await resolveRuntimeTranscriptProjection(selection, { ...p.value, executeV2: executeExistingOpenCodeV2TranscriptEnvelope })
    expect(result.logProjection.toolCallCount).toBe(1)
    expect(operations).toEqual(['status', 'status', 'transcript'])
    expect(p.counts.legacyProject).toBe(0)
    for (const spy of forbiddenSpies) expect(spy).not.toHaveBeenCalled()
    const pWindow = ports()
    const windowed = await resolveRuntimeTranscriptProjection({ ...selection, limit: 1 },
      { ...pWindow.value, executeV2: executeExistingOpenCodeV2TranscriptEnvelope })
    expect(windowed.summary.messages.map(message => message.id)).toEqual(['msg_TESTassistant'])
    expect(windowed.summary.messageCount).toBe(1)
    expect(pWindow.counts.legacyProject).toBe(0)
    await expect(executeExistingOpenCodeV2TranscriptEnvelope({ schemaVersion: 1, requestId: 'TEST', command: 'opencode.sendMessage',
      cwd: '/TEST', startedAt: new Date().toISOString(), body: {} })).rejects.toThrow('v2_transcript_command_invalid')
    if (pin === '2.0.32') {
      const missing = spyOn(openCodeSessionStore, 'get').mockResolvedValue(null)
      const output: string[] = [], exit = new Error('TEST CLI exit')
      const stdout = spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => { output.push(String(chunk)); return true })
      const stop = spyOn(process, 'exit').mockImplementation(() => { throw exit })
      let thrown: unknown
      try { await runtimeTranscript({ ...selection, provider: 'opencode', projectionOnly: true }) }
      catch (error) { thrown = error }
      finally { stop.mockRestore(); stdout.mockRestore(); missing.mockRestore() }
      expect(thrown).toBe(exit)
      const payload = JSON.parse(output.join(''))
      expect(payload.transcript.sessionId).toBe(selection.sessionId)
      expect(payload.transcript.messages).toEqual([])
      expect(payload.transcript.diagnostics).toContain('v2_native_parent_ids_unavailable')
      expect(payload.transcript.logProjection.diagnostics).toContain('v2_native_parent_ids_unavailable')
      expect(payload.transcript.logProjection.toolCallCount).toBe(1)
      for (const spy of forbiddenSpies) expect(spy).not.toHaveBeenCalled()
    }
    call.mockImplementation(async () => status.kind === 'status' ? { ...status,
      qualification: { ...status.qualification!, version: '2.0.99' } } : status)
    const beforeUnsupported = operations.length
    const pUnsupported = ports()
    await expect(resolveRuntimeTranscriptProjection(selection, { ...pUnsupported.value, executeV2: executeExistingOpenCodeV2TranscriptEnvelope }))
      .rejects.toThrow('v2_transcript_original_owner_unavailable')
    expect(operations.length).toBe(beforeUnsupported)
    // A genuinely missing original owner stays a refusal from the real fixed
    // executor, without result-based selection or a legacy projector fallback.
    call.mockRestore()
    discover.mockResolvedValue(null)
    const pMissing = ports()
    await expect(resolveRuntimeTranscriptProjection(selection, { ...pMissing.value, executeV2: executeExistingOpenCodeV2TranscriptEnvelope }))
      .rejects.toThrow('v2_transcript_original_owner_unavailable')
    expect(pMissing.counts.legacyProject).toBe(0)
    for (const spy of forbiddenSpies) expect(spy).not.toHaveBeenCalled()
  } finally { call.mockRestore(); discover.mockRestore(); for (const spy of forbiddenSpies) spy.mockRestore() }
})
