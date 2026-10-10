import path from 'node:path'
import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises'
import * as lockfile from '../../../utils/lockfile.js'
import { OpenCodeCommandOutcomeStore, type OpenCodeCommandOutcomeRecord } from '../OpenCodeCommandOutcomeStore.js'
import type { IntentIdentity } from '../execution/OpenCodeV2ExecutionContracts.js'
import { assertIntentIdentity, executionAssert, executionHash, executionRecord } from '../execution/OpenCodeV2ExecutionContracts.js'
import type { OpenCodeDeliveryResponseObservation } from '../OpenCodeDeliveryResponseObserver.js'
import { commandStatusMismatchReason, markSendMessageOutcome, type SendMessageCommandData, type SendMessageOutcomeBase } from './OpenCodeBridgeDeliveryJournal.js'
import type { RunControlResult } from './OpenCodeV2RunTypes.js'

type DeliveryResult = Extract<RunControlResult, { kind: 'send' | 'observe' }>

/** The existing app outcome store remains the sole delivery journal. Resolve
 * its established path from this bridge's managed root, including fresh CLIs;
 * no run-local replacement outcome store or native receipt can grant an outbox. */
export class OpenCodeV2DeliveryJournal {
  private readonly store: OpenCodeCommandOutcomeStore
  private readonly lockPath: string
  constructor(private readonly dataRoot: string) {
    executionAssert(path.isAbsolute(dataRoot), 'delivery_root_invalid')
    this.store = new OpenCodeCommandOutcomeStore(path.join(dataRoot, 'opencode', 'command-outcomes.json'))
    this.lockPath = path.join(dataRoot, 'opencode', 'command-outcomes.v2-observation.lock')
  }
  query(input: Parameters<OpenCodeCommandOutcomeStore['query']>[0]) { return this.store.query(input) }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    // Serialize V2 observation merge decisions across fresh CLI processes,
    // then use the unchanged shared store's own atomic identity/write lock.
    // There is still one app outcome file, including for V1 consumers.
    executionAssert(await realpath(this.dataRoot) === this.dataRoot, 'delivery_root_invalid')
    const parent = path.dirname(this.lockPath)
    await mkdir(parent, { recursive: true, mode: 0o700 })
    executionAssert(await realpath(parent) === parent, 'delivery_root_invalid')
    await writeFile(this.lockPath, '', { flag: 'ax', mode: 0o600 }).catch((error: unknown) => {
      if (executionRecord(error).code !== 'EEXIST') throw error
    })
    const stat = await lstat(this.lockPath)
    executionAssert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 &&
      stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0, 'delivery_lock_foreign')
    const release = await lockfile.lock(this.lockPath, { retries: { retries: 30, minTimeout: 5, maxTimeout: 100 } })
    try { return await operation() } finally { await release() }
  }

  async reserve(base: SendMessageOutcomeBase, sessionId: string, identity: IntentIdentity): Promise<'submit' | 'observe'> {
    assertIntentIdentity(identity)
    executionAssert(base.requestId === identity.requestId && base.body.deliveryAttemptId === identity.deliveryAttemptId &&
      base.body.messageId === identity.localMessageId && /^ses_[a-zA-Z0-9]+$/.test(sessionId), 'delivery_identity_conflict')
    return this.withLock<'submit' | 'observe'>(async () => {
      // A combined lookup deliberately treats a missing request as a conflict.
      // Fresh delivery has neither owner: inspect each index independently, then
      // require every retained owner to join the original immutable identity.
      const byRequest = await this.query({ requestId: base.requestId })
      const byAttempt = await this.query({ deliveryAttemptId: identity.deliveryAttemptId })
      executionAssert(byRequest.diagnostics.length === 0 && byAttempt.diagnostics.length === 0, 'delivery_journal_unknown')
      if (byRequest.record) this.assertOriginal(byRequest.record, base, sessionId, identity)
      if (byAttempt.record) this.assertOriginal(byAttempt.record, base, sessionId, identity)
      const found = { record: byRequest.record ?? byAttempt.record }
      if (found.record && !found.record.safeToRetry) {
        this.assertOriginal(found.record, base, sessionId, identity)
        return 'observe'
      }
      // The shared locked store arbitrates a simultaneous fresh CLI admission.
      // UNKNOWN/submitting retries never pass this fence or allocate a new ID.
      await markSendMessageOutcome(base, { status: 'received' }, this.store)
      await markSendMessageOutcome(base, { status: 'prompt_submitting', sessionId,
        runtimePromptMessageId: identity.nativeInputID }, this.store)
      return 'submit'
    })
  }

  private assertOriginal(record: OpenCodeCommandOutcomeRecord, base: SendMessageOutcomeBase,
    sessionId: string, identity: IntentIdentity): void {
    executionAssert(record.requestId === base.requestId && record.requestId === identity.requestId &&
      record.deliveryAttemptId === identity.deliveryAttemptId && record.messageId === identity.localMessageId &&
      record.runtimePromptMessageId === identity.nativeInputID && record.sessionId === sessionId &&
      record.teamId === base.teamId && record.teamName === base.teamName && record.runId === base.runId &&
      record.laneId === base.laneId && record.memberName === base.memberName && record.projectPath === base.projectPath &&
      commandStatusMismatchReason(record, base.body) === null, 'delivery_identity_conflict')
  }

  async commit(base: SendMessageOutcomeBase, sessionId: string, identity: IntentIdentity,
    result: DeliveryResult, observation: OpenCodeDeliveryResponseObservation): Promise<SendMessageCommandData> {
    return this.withLock(async () => {
      const admission = result.admission
      executionAssert(executionHash(admission.identity) === executionHash(identity) &&
        admission.authority.sessionID === sessionId && admission.authority.teamId === base.teamId &&
        admission.authority.runId === base.runId && admission.authority.laneId === base.laneId &&
        admission.authority.memberId === base.memberName && observation.deliveredUserMessageId === identity.nativeInputID,
      'original_input_conflict')
      const found = await this.query({ requestId: identity.requestId, deliveryAttemptId: identity.deliveryAttemptId })
      executionAssert(found.record && found.diagnostics.length === 0, 'delivery_journal_unknown')
      this.assertOriginal(found.record, base, sessionId, identity)
      const previous = found.record.sendMessageData?.responseObservation
      // A later partial cut cannot erase a published, correlated visible reply or
      // downgrade a previously verified terminal observation to pending.
      if (previous?.state === 'responded_visible_message') {
        if (observation.state === 'responded_visible_message') executionAssert(
          previous.visibleReplyMessageId === observation.visibleReplyMessageId &&
          previous.visibleMessageToolCallId === observation.visibleMessageToolCallId &&
          previous.assistantMessageId === observation.assistantMessageId, 'visible_reply_conflict')
        observation = previous
      } else if (previous && previous.state !== 'pending' && observation.state === 'pending') observation = previous
      const accepted = admission.state === 'accepted'
      const data: SendMessageCommandData = { accepted, runId: base.runId ?? undefined, sessionId,
        memberName: base.memberName, runtimePromptMessageId: identity.nativeInputID, responseObservation: observation, diagnostics: [] }
      if (accepted) {
        const terminal = result.turn !== null && ['succeeded', 'failed', 'cancelled'].includes(result.turn.state)
        await markSendMessageOutcome(base, { status: terminal ? 'turn_observed' : 'prompt_accepted', sessionId,
          runtimePromptMessageId: identity.nativeInputID, acceptedAt: new Date().toISOString(),
          ...(terminal ? { turnObservedAt: new Date().toISOString() } : {}), sendMessageData: data }, this.store)
      }
      // A prepared/UNKNOWN DTO is not classified pre-invocation failure evidence;
      // keep the existing prompt submission fence without making it retryable.
      return data
    })
  }

  async commitObservation(result: DeliveryResult, body: Record<string, unknown>,
    observation: OpenCodeDeliveryResponseObservation): Promise<SendMessageCommandData> {
    const identity = result.admission.identity
    const found = await this.query({ requestId: identity.requestId, deliveryAttemptId: identity.deliveryAttemptId })
    executionAssert(found.record && found.diagnostics.length === 0, 'delivery_journal_unknown')
    const record = found.record
    executionAssert(commandStatusMismatchReason(record, body) === null &&
      (body.originalRequestId === undefined || body.originalRequestId === record.requestId) &&
      (body.deliveryAttemptId === undefined || body.deliveryAttemptId === record.deliveryAttemptId), 'delivery_identity_conflict')
    return this.commit({ requestId: record.requestId, teamId: record.teamId, teamName: record.teamName,
      laneId: record.laneId, memberName: record.memberName, projectPath: record.projectPath, runId: record.runId,
      body: { ...body, deliveryAttemptId: record.deliveryAttemptId, messageId: record.messageId, payloadHash: record.payloadHash } },
    result.admission.authority.sessionID, identity, result, observation)
  }
}
