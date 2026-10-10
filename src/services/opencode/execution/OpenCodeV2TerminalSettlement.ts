import type { ExecutionClient, ExecutionLog, ExecutionMessage, ExecutionQueueInput } from '../transport/OpenCodeV2ExecutionClientFactory.js'
import { canonicalExecutionJSON, executionAssert, executionHash, executionRecord, type AdmissionRecord, type SessionAuthority } from './OpenCodeV2ExecutionContracts.js'
import type { QueueIntent } from './OpenCodeV2AdmissionService.js'
import { projectOpenCodeV2Turn } from './OpenCodeV2TurnProjection.js'

export type OriginalTerminalProof = Readonly<{
  authorityHash: string; identityHash: string; requestId: string; nativeInputID: string
  payloadHash: string; nativePayloadHash: string; projectedUserID: string
  expectedRevision: number; cursor: number; cutHash: string
  state: 'succeeded' | 'failed' | 'cancelled'
}>
export function verifyNativePayload(raw: unknown, input: ExecutionQueueInput): string {
  const native = executionRecord(raw)
  executionAssert(native.text === input.text, 'payload_conflict')
  for (const key of ['files', 'agents', 'skills'] as const) {
    const expected = input[key] ?? [], actual = native[key] ?? []
    executionAssert(Array.isArray(actual) && actual.length === expected.length, 'attachment_conflict')
    for (let index = 0; index < expected.length; index++) {
      const supplied = executionRecord(expected[index]), observed = executionRecord(actual[index])
      const primary = key === 'files' ? 'uri' : key === 'agents' ? 'name' : 'id'
      if (key === 'files') {
        const source = executionRecord(observed.source)
        executionAssert(source.type === 'uri' && source.uri === supplied.uri && typeof observed.data === 'string' && typeof observed.mime === 'string', 'attachment_conflict')
      } else executionAssert(observed[primary] === supplied[primary], 'attachment_conflict')
      for (const field of ['mention', ...(key === 'files' ? ['name', 'description'] : [])]) {
        if (supplied[field] !== undefined) executionAssert(canonicalExecutionJSON(observed[field]) === canonicalExecutionJSON(supplied[field]), 'attachment_conflict')
        else if (field === 'mention') executionAssert(observed[field] === undefined, 'attachment_conflict')
      }
    }
  }
  return executionHash(native)
}

export function validateCut(log: ExecutionLog, sessionID: string): void {
  executionAssert(log.synced === true && log.events.length <= 2048)
  const ids = new Set<string>(); let previous = -1
  for (const event of log.events) {
    executionAssert(!ids.has(event.id) && event.aggregateID === sessionID && event.data.sessionID === sessionID &&
      Number.isSafeInteger(event.seq) && event.seq > previous, 'incomplete_log')
    ids.add(event.id); previous = event.seq
  }
  executionAssert(log.watermark === (log.events.at(-1)?.seq ?? null), 'incomplete_log')
}
export async function readExecutionCut(client: Pick<ExecutionClient, 'log' | 'messages'>, sessionID: string): Promise<{ log: ExecutionLog; messages: ExecutionMessage[] }> {
  const before = await client.log(sessionID); validateCut(before, sessionID)
  const messages: ExecutionMessage[] = [], cursors = new Set<string>(); let cursor: string | undefined, complete = false
  for (let page = 0; page < 8; page++) {
    const result = await client.messages(sessionID, cursor)
    messages.push(...result.data)
    executionAssert(messages.length <= 1600 && new Set(messages.map(m => m.id)).size === messages.length, 'incomplete_transcript')
    if (result.data.length === 0) {
      executionAssert(result.next === null && result.previous === null, 'incomplete_transcript'); complete = true; break
    }
    executionAssert(result.next !== null && result.previous !== null, 'incomplete_transcript')
    executionAssert(!cursors.has(result.next), 'incomplete_transcript'); cursors.add(result.next); cursor = result.next
  }
  executionAssert(complete, 'incomplete_transcript')
  const after = await client.log(sessionID); validateCut(after, sessionID)
  executionAssert(executionHash(before) === executionHash(after), 'mutable_readback')
  return { log: after, messages }
}

const proofs = new WeakSet<object>()
const terminalCuts = new WeakMap<object, Awaited<ReturnType<typeof readExecutionCut>>>()
export function requireOriginalTerminalCut(proof: OriginalTerminalProof) {
  const cut = terminalCuts.get(proof); executionAssert(proofs.has(proof) && cut, 'terminal_cut_not_owned'); return structuredClone(cut)
}
export function isOriginalTerminalProof(value: OriginalTerminalProof): boolean { return proofs.has(value) }

/** Only an owned client readback can mint this process-local proof. No wire DTO is accepted. */
export async function readOriginalTerminal(client: ExecutionClient, authority: SessionAuthority,
  intent: QueueIntent, admission: AdmissionRecord): Promise<OriginalTerminalProof | null> {
  executionAssert(executionHash(client.authority) === executionHash(authority.host) &&
    executionHash(admission.authority) === executionHash(authority) &&
    executionHash(admission.identity) === executionHash(intent.identity), 'terminal_authority_conflict')
  if (admission.state !== 'accepted' || admission.disposition !== 'accepted' || !admission.complete ||
      admission.projectedUserID !== intent.identity.nativeInputID || !admission.nativePayloadHash) return null
  const session = await client.getSession(authority.sessionID)
  executionAssert(session.id === authority.sessionID && session.directory === authority.host.directory &&
    session.agent === authority.agent && executionHash(session.model) === executionHash(authority.model), 'session_selection_changed')
  const { log, messages } = await readExecutionCut(client, authority.sessionID)
  executionAssert(log.watermark !== null &&
    log.watermark >= (admission.cursor ?? 0), 'terminal_cut_unknown')
  const enqueued = log.events.filter(event => event.type === 'session.inbox.enqueued' &&
    event.data.sessionID === authority.sessionID && event.data.inboxID === intent.identity.nativeInputID)
  executionAssert(enqueued.length === 1 && enqueued[0]!.seq > (admission.beforeCursor ?? -1), 'terminal_payload_conflict')
  const item = executionRecord(enqueued[0]!.data.item)
  executionAssert(item.type === 'user' && item.delivery === 'queue' &&
    verifyNativePayload(item.payload, intent.input) === admission.nativePayloadHash, 'terminal_payload_conflict')
  const user = messages.find(row => row.id === admission.projectedUserID && row.type === 'user')
  executionAssert(user && user.data.id === intent.identity.nativeInputID && user.data.type === 'user', 'terminal_payload_conflict')
  verifyNativePayload(user.data, intent.input)
  const cut = { messages: { data: messages, previous: null, next: null }, log }
  const projected = projectOpenCodeV2Turn({ pin: authority.host.pin, sessionID: authority.sessionID, nativeInputID: intent.identity.nativeInputID,
    beforeCursor: admission.beforeCursor, originalText: intent.input.text, ...cut })
  if (!['succeeded', 'failed', 'cancelled'].includes(projected.state)) return null
  for (const id of projected.assistantMessageIds) {
    const assistant = messages.find(row => row.id === id && row.type === 'assistant')
    const starts = log.events.filter(event => event.type === 'session.step.started' && event.data.assistantMessageID === id)
    executionAssert(assistant && assistant.data.agent === authority.agent && executionHash(assistant.data.model) === executionHash(authority.model) &&
      starts.length === 1 && starts[0]!.data.agent === authority.agent && executionHash(starts[0]!.data.model) === executionHash(authority.model), 'terminal_assistant_selection_changed')
  }
  const proof = Object.freeze({ authorityHash: executionHash(authority), identityHash: executionHash(admission.identity),
    requestId: intent.identity.requestId, nativeInputID: intent.identity.nativeInputID,
    payloadHash: admission.payloadHash, nativePayloadHash: admission.nativePayloadHash,
    projectedUserID: admission.projectedUserID, expectedRevision: admission.revision, cursor: log.watermark,
    cutHash: executionHash(cut), state: projected.state as OriginalTerminalProof['state'] })
  proofs.add(proof); terminalCuts.set(proof, structuredClone({ log, messages })); return proof
}
