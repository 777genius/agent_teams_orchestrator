import { describe, expect, spyOn, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { OpenCodeV2DeliveryJournal } from './OpenCodeV2DeliveryJournal.js'
import { OpenCodeV2TeamBridge, projectV2DeliveryObservation } from './OpenCodeV2TeamBridge.js'
import { markSendMessageOutcome, type SendMessageOutcomeBase } from './OpenCodeBridgeDeliveryJournal.js'
import { OpenCodeCommandOutcomeStore, openCodeCommandOutcomeStore } from '../OpenCodeCommandOutcomeStore.js'
import { executionHash } from '../execution/OpenCodeV2ExecutionContracts.js'
import type { AdmissionRecord } from '../execution/OpenCodeV2ExecutionContracts.js'
import type { RunControlRecord, RunControlResult } from './OpenCodeV2RunTypes.js'
import type { QueueIntent } from '../execution/OpenCodeV2AdmissionService.js'
import type { OpenCodeV2TurnProjection } from './OpenCodeV2TurnProjection.js'

// Real shared outcome store/atomic locks in a private TEST root; native facts
// below are synthetic, never official execution or outbox qualification.
const identity = { requestId: 'request', deliveryAttemptId: 'attempt', localMessageId: 'inbound', nativeInputID: 'msg_TESToriginal' }
const base: SendMessageOutcomeBase = { requestId: identity.requestId, teamId: 'TEST', teamName: 'TEST',
  runId: 'run', laneId: 'primary', memberName: 'worker', projectPath: '/TEST-project',
  body: { deliveryAttemptId: identity.deliveryAttemptId, messageId: identity.localMessageId, payloadHash: 'a'.repeat(64) } }
const intent: QueueIntent = { delivery: 'queue', identity, input: { nativeInputID: identity.nativeInputID, text: 'TEST original payload', resume: true } }
const sessionId = 'ses_TESToriginal'
function admission(state: AdmissionRecord['state']): AdmissionRecord {
  return { identity, payloadHash: 'b'.repeat(64), state, disposition: state === 'accepted' ? 'accepted' : 'unknown',
    beforeCursor: null, beforeUserIDs: [], cursor: null, complete: false, revision: 1,
    authority: { teamId: 'TEST', runId: 'run', laneId: 'primary', memberId: 'worker', sessionID: sessionId,
      agent: 'worker', model: { providerID: 'TEST', id: 'TEST' }, host: { generation: 'v2', pin: '2.0.32', dialect: 'v2-2.0.32',
        graphSha256: 'a'.repeat(64), selectedCli: { path: '/TEST-native', sha256: 'b'.repeat(64), version: '2.0.32' },
        child: { pid: 123, birth: { format: 'linux-start-ticks', value: '123', bootId: 'TEST' }, executablePath: '/TEST-bun', sha256: 'c'.repeat(64) },
        hostInstanceId: 'TEST', profileEpoch: 'TEST', profileRoot: '/TEST-profile', directory: '/TEST-project', leaseOwnerId: 'TEST' } } }
}
const terminal: OpenCodeV2TurnProjection = { state: 'succeeded', reason: 'TEST complete terminal cut', assistantMessageIds: ['assistant'],
  text: 'done', toolEffects: [], visibleReplies: [] }
const visible: OpenCodeV2TurnProjection = { ...terminal, toolEffects: [{ assistantMessageId: 'assistant', toolCallId: 'tool',
  toolName: 'agent-teams_message_send', kind: 'visible_message', input: { relayOfMessageId: 'inbound' }, content: [], result: { accepted: true } }],
  visibleReplies: [{ nativeInputId: identity.nativeInputID, assistantMessageId: 'assistant', toolCallId: 'tool',
    toolName: 'agent-teams_message_send', inboundMessageId: 'inbound', visibleReplyMessageId: 'reply' }] }
const observe = (turn: OpenCodeV2TurnProjection | null) => projectV2DeliveryObservation(turn, identity.nativeInputID, identity.localMessageId)
type Delivery = Extract<RunControlResult, { kind: 'send' | 'observe' }>
const result = (state: AdmissionRecord['state'], turn: OpenCodeV2TurnProjection | null = null): Delivery => ({ kind: 'observe', admission: admission(state), turn })

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'TEST-r249-journal-'))
  const journal = new OpenCodeV2DeliveryJournal(root)
  return { root, journal, close: () => rm(root, { recursive: true, force: true }) }
}

describe('V2 composition with the existing durable app outcome authority', () => {
  test('legacy two-argument journal helper retains the original default store and patch identity', async () => {
    const f = await fixture()
    const owned = new OpenCodeCommandOutcomeStore(path.join(f.root, 'legacy-outcomes.json'))
    const legacy = spyOn(openCodeCommandOutcomeStore, 'upsert').mockImplementation((patch, options) => owned.upsert(patch, options))
    try {
      await markSendMessageOutcome(base, { status: 'received' })
      await markSendMessageOutcome(base, { status: 'prompt_submitting', sessionId, runtimePromptMessageId: identity.nativeInputID })
      expect(legacy).toHaveBeenCalledTimes(2)
      expect(legacy.mock.calls[1]?.[1]).toEqual({ requireRetryable: true })
      expect((await owned.query({ requestId: identity.requestId })).record).toMatchObject({ teamId: 'TEST', runId: 'run',
        laneId: 'primary', memberName: 'worker', projectPath: '/TEST-project', payloadHash: 'a'.repeat(64),
        status: 'prompt_submitting', safeToRetry: false, sessionId, runtimePromptMessageId: identity.nativeInputID })
    } finally { legacy.mockRestore(); await f.close() }
  })
  test('UNKNOWN submission remains read-only across a fresh journal instance', async () => {
    const f = await fixture()
    try {
      expect(await f.journal.reserve(base, sessionId, identity)).toBe('submit')
      await f.journal.commit(base, sessionId, identity, result('unknown'), observe(null))
      const fresh = new OpenCodeV2DeliveryJournal(f.root)
      expect(await fresh.reserve(base, sessionId, identity)).toBe('observe')
      expect((await fresh.query({ requestId: identity.requestId })).record).toMatchObject({
        status: 'prompt_submitting', safeToRetry: false, runtimePromptMessageId: identity.nativeInputID, acceptedAt: null })
    } finally { await f.close() }
  })
  test('read-only original-input recovery advances acceptance and terminal facts', async () => {
    const f = await fixture()
    try {
      await f.journal.reserve(base, sessionId, identity)
      await f.journal.commitObservation(result('accepted'), {}, observe(null))
      expect((await f.journal.query({ requestId: identity.requestId })).record?.status).toBe('prompt_accepted')
      await new OpenCodeV2DeliveryJournal(f.root).commitObservation(result('accepted', terminal), {}, observe(terminal))
      const stored = (await f.journal.query({ requestId: identity.requestId })).record
      expect(stored).toMatchObject({ status: 'turn_observed', safeToRetry: false, sessionId,
        sendMessageData: { responseObservation: { state: 'responded_plain_text' } } })
      expect(stored?.turnObservedAt).not.toBeNull()
    } finally { await f.close() }
  })
  test('partial later cuts cannot overwrite a correlated visible reply, including concurrent fresh CLIs', async () => {
    const f = await fixture()
    try {
      await f.journal.reserve(base, sessionId, identity)
      await Promise.all([
        f.journal.commitObservation(result('accepted', visible), {}, observe(visible)),
        new OpenCodeV2DeliveryJournal(f.root).commitObservation(result('accepted'), {}, observe(null)),
      ])
      await f.journal.commitObservation(result('accepted', { ...terminal, state: 'unknown' }), {}, observe(null))
      expect((await f.journal.query({ requestId: identity.requestId })).record).toMatchObject({ status: 'turn_observed',
        sendMessageData: { responseObservation: { state: 'responded_visible_message', visibleReplyMessageId: 'reply' } } })
    } finally { await f.close() }
  })
  test('a contradictory visible reply cannot replace the existing once-only correlation', async () => {
    const f = await fixture()
    try {
      await f.journal.reserve(base, sessionId, identity)
      await f.journal.commitObservation(result('accepted', visible), {}, observe(visible))
      const conflicting = { ...visible, visibleReplies: visible.visibleReplies.map(reply => ({ ...reply, visibleReplyMessageId: 'foreign' })) }
      await expect(f.journal.commitObservation(result('accepted', conflicting), {}, observe(conflicting))).rejects.toThrow('visible_reply_conflict')
      expect((await f.journal.query({ requestId: identity.requestId })).record?.sendMessageData?.responseObservation?.visibleReplyMessageId).toBe('reply')
    } finally { await f.close() }
  })
  test('native acceptance without a prior app journal owner cannot mint app delivery authority', async () => {
    const f = await fixture()
    try {
      await expect(f.journal.commitObservation(result('accepted', visible), {}, observe(visible))).rejects.toThrow('delivery_journal_unknown')
      expect((await f.journal.query({ requestId: identity.requestId })).record).toBeNull()
    } finally { await f.close() }
  })
  test('a substituted observation lock leaves the foreign sentinel and outcome history untouched', async () => {
    const f = await fixture()
    try {
      await mkdir(path.join(f.root, 'opencode'), { mode: 0o700 })
      const sentinel = path.join(f.root, 'foreign-sentinel')
      await writeFile(sentinel, 'foreign survives', { mode: 0o600 })
      await symlink(sentinel, path.join(f.root, 'opencode', 'command-outcomes.v2-observation.lock'))
      await expect(f.journal.reserve(base, sessionId, identity)).rejects.toThrow('delivery_lock_foreign')
      expect(await readFile(sentinel, 'utf8')).toBe('foreign survives')
      expect((await f.journal.query({ requestId: identity.requestId })).record).toBeNull()
    } finally { await f.close() }
  })
  test('foreign native run/input and changed app request hash cannot advance the original journal', async () => {
    const f = await fixture()
    try {
      await f.journal.reserve(base, sessionId, identity)
      const foreign = result('accepted', visible)
      foreign.admission.authority = { ...foreign.admission.authority, runId: 'foreign' }
      await expect(f.journal.commitObservation(foreign, {}, observe(visible))).rejects.toThrow('original_input_conflict')
      await expect(f.journal.reserve({ ...base, body: { ...base.body, payloadHash: 'foreign' } }, sessionId, identity)).rejects.toThrow('delivery_identity_conflict')
      expect((await f.journal.query({ requestId: identity.requestId })).record?.status).toBe('prompt_submitting')
    } finally { await f.close() }
  })
  test('simultaneous fresh send requests acquire at most one app submission owner', async () => {
    const f = await fixture()
    try {
      const decisions = await Promise.all([f.journal.reserve(base, sessionId, identity),
        new OpenCodeV2DeliveryJournal(f.root).reserve(base, sessionId, identity)])
      expect(decisions.filter(value => value === 'submit')).toHaveLength(1)
      expect(decisions.filter(value => value === 'observe')).toHaveLength(1)
    } finally { await f.close() }
  })
  test('semantic send replay carries its original payload to observe and never sends again', async () => {
    const f = await fixture()
    const operations: string[] = []
    const record: RunControlRecord = { schema: 1, protocol: 1, binding: { teamId: 'TEST', runId: 'run', ownerId: 'owner', controllerInstanceId: 'controller' },
      process: { pid: 123, startTicks: '123', bootId: 'TEST', executablePath: '/TEST-bun', executableSha256: 'a'.repeat(64) },
      directory: '/TEST', socketPath: '/TEST/control.sock', socketDevice: 1, socketInode: 2, deadline: Date.now() + 10000, uid: 1000, sourceSha256: 'b'.repeat(64) }
    const bridge = () => new OpenCodeV2TeamBridge(f.root, record.binding, { discover: async () => record,
      launch: async () => { throw new Error('replacement forbidden') }, request: async (_record, request) => {
        operations.push(request.operation)
        if (request.operation === 'send') return { ...result('unknown'), kind: 'send' }
        if (request.operation !== 'observe') throw new Error('unexpected operation')
        expect(request.intent).toEqual(intent)
        return result('unknown')
      } })
    try {
      const request = { operation: 'send' as const, memberId: 'worker', originalSessionId: sessionId, intent }
      expect(await bridge().send(request, base, 5000)).toMatchObject({ accepted: false })
      expect((await bridge().send(request, base, 5000)).promptNotSubmitted).toBeUndefined()
      expect(operations).toEqual(['send', 'observe'])
    } finally { await f.close() }
  })
})


test('stale unreserved refusal cannot release a newer immutable-input submission owner', async () => {
  const f = await fixture()
  try {
    const refused = { kind: 'send_refused' as const, disposition: 'not_reserved' as const,
      authority: admission('prepared').authority, intent }
    const first = await f.journal.reserve(base, sessionId, identity, executionHash(intent))
    expect(first.action).toBe('submit')
    const refusal = await f.journal.refuse(base, sessionId, intent, { ...refused, submissionOwner: first.submissionOwner }, first.submissionOwner)
    // The desktop must retry this proven never-reserved input, not observe a
    // native input that the owner has positively proved does not exist.
    expect(refusal).toMatchObject({ accepted: false, promptNotSubmitted: true })
    expect((await f.journal.query({ requestId: identity.requestId })).record).toMatchObject({
      status: 'failed_before_accept', safeToRetry: true })
    let current = first
    // Retry metadata remains usable past the shared diagnostics retention cap.
    for (let i = 0; i < 45; i++) {
      current = await f.journal.reserve(base, sessionId, identity, executionHash(intent))
      expect(current.action).toBe('submit')
      if (i < 44) await f.journal.refuse(base, sessionId, intent, { ...refused, submissionOwner: current.submissionOwner }, current.submissionOwner)
    }
    expect(current.submissionOwner).not.toBe(first.submissionOwner)
    await expect(f.journal.refuse(base, sessionId, intent, { ...refused, submissionOwner: first.submissionOwner }, first.submissionOwner))
      .rejects.toThrow('delivery_submission_changed')
    expect((await f.journal.query({ requestId: identity.requestId })).record).toMatchObject({
      status: 'prompt_submitting', safeToRetry: false, runtimePromptMessageId: identity.nativeInputID })
    await f.journal.commit(base, sessionId, identity, result('unknown'), observe(null))
    const after = await f.journal.reserve(base, sessionId, identity, executionHash(intent))
    expect(after).toEqual({ action: 'observe', submissionOwner: current.submissionOwner })
    await expect(f.journal.refuse(base, 'ses_foreign', intent, { ...refused, submissionOwner: current.submissionOwner }, current.submissionOwner)).rejects.toThrow('original_input_conflict')
  } finally { await f.close() }
})


test('persisted untagged V2 UNKNOWN journal remains read-only across an upgrade', async () => {
  const f = await fixture()
  const operations: string[] = []
  try {
    // The previous release persisted only the original outcome identity; it
    // cannot supply the new intent-hash or private submission-generation tag.
    await f.journal.reserve(base, sessionId, identity)
    const record: RunControlRecord = { schema: 1, protocol: 1,
      binding: { teamId: 'TEST', runId: 'run', ownerId: 'owner', controllerInstanceId: 'controller' },
      process: { pid: 123, startTicks: '123', bootId: 'TEST', executablePath: '/TEST-bun', executableSha256: 'a'.repeat(64) },
      directory: '/TEST', socketPath: '/TEST/control.sock', socketDevice: 1, socketInode: 2,
      deadline: Date.now() + 10000, uid: 1000, sourceSha256: 'b'.repeat(64) }
    const bridge = new OpenCodeV2TeamBridge(f.root, record.binding, { discover: async () => record,
      launch: async () => { throw Error('TEST forbidden') }, request: async (_record, request) => {
        operations.push(request.operation)
        expect(request).toMatchObject({ operation: 'observe', nativeInputID: identity.nativeInputID, intent })
        return result('unknown')
      } })
    expect((await bridge.send({ operation: 'send', memberId: 'worker', originalSessionId: sessionId, intent }, base, 5000)).accepted).toBe(false)
    expect(operations).toEqual(['observe'])
    const retained = (await f.journal.query({ requestId: identity.requestId })).record
    expect(retained).toMatchObject({ status: 'prompt_submitting', safeToRetry: false, runtimePromptMessageId: identity.nativeInputID })
    expect(retained?.diagnostics).toEqual([])
    await expect(f.journal.refuse(base, sessionId, intent, { kind: 'send_refused', disposition: 'not_reserved', submissionOwner: '',
      authority: admission('prepared').authority, intent }, '')).rejects.toThrow('delivery_submission_changed')
    expect((await f.journal.query({ requestId: identity.requestId })).record?.safeToRetry).toBe(false)
  } finally { await f.close() }
})
