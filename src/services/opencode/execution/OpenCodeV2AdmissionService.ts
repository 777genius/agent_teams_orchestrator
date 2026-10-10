import { readOriginalTerminal, verifyNativePayload, readExecutionCut, validateCut } from './OpenCodeV2TerminalSettlement.js'
import type { ExecutionClient, ExecutionInbox, ExecutionLog, ExecutionMessage, ExecutionQueueInput } from '../transport/OpenCodeV2ExecutionClientFactory.js'
import { executionWasNotSubmitted } from '../transport/OpenCodeV2ExecutionFetch.js'
import { OpenCodeV2AdmissionStore } from './OpenCodeV2AdmissionStore.js'
import { verifyExecutionSession } from './OpenCodeV2SessionService.js'
import { canonicalExecutionJSON, executionAssert, executionHash, executionRecord,
  type AdmissionRecord, type IntentIdentity, type SessionAuthority } from './OpenCodeV2ExecutionContracts.js'

export type QueueIntent = { identity: IntentIdentity; input: ExecutionQueueInput; delivery: 'queue' }
function payload(input: ExecutionQueueInput): Record<string, unknown> {
  return { text: input.text, ...(input.files === undefined ? {} : { files: input.files }),
    ...(input.agents === undefined ? {} : { agents: input.agents }), ...(input.skills === undefined ? {} : { skills: input.skills }) }
}
function validateIntent(intent: QueueIntent, resumePolicy: boolean): string {
  executionAssert(Object.keys(intent).sort().join(',') === 'delivery,identity,input')
  executionAssert(intent.delivery === 'queue' && typeof resumePolicy === 'boolean' && intent.input.resume === resumePolicy)
  executionAssert(Object.keys(intent.input).every(k => ['nativeInputID', 'text', 'resume', 'files', 'agents', 'skills'].includes(k)), 'unsupported_v1_input')
  executionAssert(intent.input.nativeInputID === intent.identity.nativeInputID && typeof intent.input.text === 'string' && intent.input.text.trim().length > 0)
  executionAssert(Buffer.byteLength(canonicalExecutionJSON(intent.input)) <= 256 * 1024, 'input_too_large')
  // Generated clients validate attachment shapes again; this validation occurs
  // before journaling, so unsupported caller fields cannot become an intent.
  for (const [key, list] of [['files', intent.input.files], ['agents', intent.input.agents], ['skills', intent.input.skills]] as const) {
    if (!list) continue
    executionAssert(Array.isArray(list) && list.length <= 64)
    for (const item of list) {
      const r = executionRecord(item), name = key === 'files' ? 'uri' : key === 'agents' ? 'name' : 'id'
      executionAssert(typeof r[name] === 'string' && (r[name] as string).length > 0)
      executionAssert(Object.keys(r).every(k => [name, 'mention', ...(key === 'files' ? ['name', 'description'] : [])].includes(k)))
      if (r.mention !== undefined) {
        const m = executionRecord(r.mention)
        executionAssert(Object.keys(m).sort().join(',') === 'end,start,text' && Number.isSafeInteger(m.start) &&
          Number.isSafeInteger(m.end) && Number(m.start) >= 0 && Number(m.end) >= Number(m.start) && typeof m.text === 'string')
      }
    }
  }
  return executionHash({ input: payload(intent.input), delivery: 'queue', resume: resumePolicy })
}
function verifyReceipt(r: ExecutionInbox, intent: QueueIntent, authority: SessionAuthority): string {
  executionAssert(r.id === intent.identity.nativeInputID && r.sessionID === authority.sessionID && r.type === 'user' &&
    r.delivery === 'queue', 'receipt_conflict')
  return verifyNativePayload(r.payload, intent.input)
}
export class OpenCodeV2AdmissionService {
  constructor(private readonly client: ExecutionClient, private readonly store: OpenCodeV2AdmissionStore,
    private readonly authority: SessionAuthority) {
    store.assertAuthority(authority)
    this.authority = structuredClone(authority)
    executionAssert(executionHash(client.authority) === executionHash(authority.host), 'authority_conflict')
  }
  async admitQueue(intent: QueueIntent, resumePolicy: boolean): Promise<AdmissionRecord> {
    intent = JSON.parse(canonicalExecutionJSON(intent)) as QueueIntent
    const hash = validateIntent(intent, resumePolicy)
    // A fresh read verifies session selection; neither aliases nor recovery can
    // write selection or manufacture a new input/session.
    verifyExecutionSession(this.authority, await this.client.getSession(this.authority.sessionID))
    const existing = (await this.store.snapshot()).admissions.find(r => r.identity.requestId === intent.identity.requestId)
    let boundary = { beforeCursor: null as number | null, beforeUserIDs: [] as string[] }
    if (!existing) {
      const cut = await readExecutionCut(this.client, this.authority.sessionID)
      boundary = { beforeCursor: cut.log.watermark, beforeUserIDs: cut.messages.filter(m => m.type === 'user').map(m => m.id) }
    }
    const reserved = await this.store.reserve(intent.identity, hash, boundary)
    if (reserved.state !== 'prepared') return reserved
    const sent = await this.store.submitting(intent.identity.requestId, reserved.revision)
    try {
      const receipt = await this.client.promptQueue(this.authority.sessionID, intent.input)
      const nativePayloadHash = verifyReceipt(receipt, intent, this.authority)
      return await this.store.update(intent.identity.requestId, sent.revision, {
        state: 'accepted', disposition: 'accepted', returnedInboxID: receipt.id, nativePayloadHash, complete: false,
      })
    } catch (failure) {
      if (executionWasNotSubmitted(failure)) return this.store.update(intent.identity.requestId, sent.revision, {
        state: 'not_submitted', disposition: 'rejected', complete: false,
      })
      // No declared HTTP/native error is qualified as independent rejection in
      // this slice. Once invoked, every error is retained as UNKNOWN.
      return this.store.update(intent.identity.requestId, sent.revision, { state: 'unknown', disposition: 'unknown', complete: false })
    }
  }
  async reserveParkedSeries(intents: readonly [QueueIntent, QueueIntent, QueueIntent]): Promise<void> {
    // Explicit A/B/W experiment intent: no synthesized wake or standalone
    // resume. Ordinary admissions retain one normal execution slot.
    const snapshots = intents.map(i => JSON.parse(canonicalExecutionJSON(i)) as QueueIntent)
    for (let i = 0; i < 3; i++) validateIntent(snapshots[i]!, i === 2)
    executionAssert(new Set(snapshots.map(i => i.identity.nativeInputID)).size === 3)
    await this.store.reserveParkedSeries(snapshots.map(i => ({ identity: i.identity, payloadHash: validateIntent(i, i.input.resume) })))
  }
  readOriginalInput(intent: QueueIntent): Promise<AdmissionRecord> { return this.readOriginalEvidence(intent, true) }
  private async readOriginalEvidence(intent: QueueIntent, commit: boolean): Promise<AdmissionRecord> {
    intent = JSON.parse(canonicalExecutionJSON(intent)) as QueueIntent
    const hash = validateIntent(intent, intent.input.resume), snapshot = await this.store.snapshot()
    const original = snapshot.admissions.find(r => r.identity.requestId === intent.identity.requestId)
    executionAssert(original && original.payloadHash === hash && executionHash(original.identity) === executionHash(intent.identity), 'intent_conflict')
    // Without a durable submitting marker our operation cannot own native
    // admission. A matching foreign ID/payload must not promote an unsent
    // reservation or undo proved non-submission during read-only recovery.
    if (original.state === 'prepared' || original.state === 'not_submitted') return original
    try {
      verifyExecutionSession(this.authority, await this.client.getSession(this.authority.sessionID))
      const { log: after, messages } = await readExecutionCut(this.client, this.authority.sessionID)
      const inbox = await this.client.inbox(this.authority.sessionID)
      const final = await this.client.log(this.authority.sessionID); validateCut(final, this.authority.sessionID)
      executionAssert(executionHash(final) === executionHash(after), 'mutable_readback')
      const nativeID = intent.identity.nativeInputID
      const receipt = inbox.find(r => r.id === nativeID)
      if (receipt) verifyReceipt(receipt, intent, this.authority)
      const enqueued = after.events.find(e => e.type === 'session.inbox.enqueued' && e.data.inboxID === nativeID)
      executionAssert(enqueued && enqueued.seq > (original.beforeCursor ?? -1), 'original_admission_unproven')
      const item = executionRecord(enqueued.data.item)
      executionAssert(item.type === 'user' && item.delivery === 'queue', 'receipt_conflict')
      const nativePayloadHash = verifyNativePayload(item.payload, intent.input)
      executionAssert(original.nativePayloadHash === undefined || original.nativePayloadHash === nativePayloadHash, 'native_payload_conflict')
      if (receipt) executionAssert(executionHash(receipt.payload) === nativePayloadHash, 'native_payload_conflict')
      const delivered = after.events.find(e => e.type === 'session.inbox.delivered' && e.data.inboxID === nativeID)
      const cancelled = after.events.find(e => e.type === 'session.inbox.cancelled' && e.data.inboxID === nativeID)
      executionAssert(!(delivered && cancelled), 'conflicting_native_disposition')
      if (delivered) executionAssert(delivered.seq > enqueued.seq)
      if (cancelled) executionAssert(cancelled.seq > enqueued.seq)
      // Native delivered contains only inboxID. Learn a projected ID from
      // an independently observed USER row in the bracketed complete view,
      // never from naming alone or from a fictional delivery.messageID field.
      const candidate = delivered ? messages.find(m => m.id === nativeID && m.type === 'user' && !original.beforeUserIDs.includes(m.id)) : undefined
      executionAssert(!delivered || candidate, 'projection_incomplete')
      if (candidate) verifyNativePayload(candidate.data, intent.input)
      const patch: Parameters<OpenCodeV2AdmissionStore['update']>[2] = {
        state: 'accepted', disposition: cancelled ? 'cancelled' : receipt ? 'pending' : delivered ? 'accepted' : 'unknown',
        returnedInboxID: nativeID, nativePayloadHash, ...(candidate ? { projectedUserID: candidate.id } : {}),
        complete: true, cursor: after.watermark,
      }
      return commit ? await this.store.update(intent.identity.requestId, original.revision, patch) : { ...original, ...patch }
    } catch {
      // Keep the last committed cursor/evidence and all original IDs; an empty
      // inbox, idle or partial page cannot remove the admission fence.
      return original
    }
  }
  /** Stop may classify a consumed original, but never settle or update after its fence. */
  async terminalAfterStop(intent: QueueIntent): Promise<boolean> {
    try {
      const fenced = await this.store.snapshot()
      if (!fenced.tombstone || fenced.admissions.find(row => row.identity.requestId === intent.identity.requestId)?.state !== 'accepted') return false
      const observed = await this.readOriginalEvidence(intent, false)
      const proof = await readOriginalTerminal(this.client, this.authority, intent, observed)
      if (!proof) return false
      const current = await this.store.snapshot()
      const original = current.admissions.find(row => row.identity.requestId === proof.requestId)
      return current.tombstone && !!original && original.state === 'accepted' && original.revision === proof.expectedRevision &&
        executionHash(original.identity) === proof.identityHash && original.payloadHash === proof.payloadHash &&
        original.nativePayloadHash === proof.nativePayloadHash
    } catch { return false }
  }
  async settleOriginalInput(intent: QueueIntent): Promise<AdmissionRecord> {
    const snapshot = await this.store.snapshot()
    const original = snapshot.admissions.find(row => row.identity.requestId === intent.identity.requestId)
    executionAssert(original && executionHash(original.identity) === executionHash(intent.identity) &&
      original.payloadHash === validateIntent(intent, intent.input.resume), 'intent_conflict')
    // Read-only replay never releases an unrelated successor.
    if (snapshot.slot !== original.identity.requestId) return original
    const observed = await this.readOriginalInput(intent)
    const proof = await readOriginalTerminal(this.client, this.authority, intent, observed)
    return proof ? this.store.settleOriginalTerminal(proof) : observed
  }
  reconcileOriginalInput(intent: QueueIntent) { return this.readOriginalInput(intent) }
  fenceStop() { return this.store.fenceStop() }
}
