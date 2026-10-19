import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises'
import * as lockfile from '../../../utils/lockfile.js'
import { OpenCodeCommandOutcomeStore, type OpenCodeCommandOutcomeRecord } from '../OpenCodeCommandOutcomeStore.js'
import type { IntentIdentity } from '../execution/OpenCodeV2ExecutionContracts.js'
import { assertIntentIdentity, executionAssert, executionHash, executionRecord } from '../execution/OpenCodeV2ExecutionContracts.js'
import type { OpenCodeDeliveryResponseObservation } from '../OpenCodeDeliveryResponseObserver.js'
import { commandStatusMismatchReason, markSendMessageOutcome, type SendMessageCommandData, type SendMessageOutcomeBase } from './OpenCodeBridgeDeliveryJournal.js'
import type { RunControlResult } from './OpenCodeV2RunTypes.js'
import { openWindowsDeliveryJournalGuard } from './OpenCodeV2WindowsDeliveryGuard.js'

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

  private async withLock<T>(operation: () => Promise<T>, deadline?: number): Promise<T> {
    if (process.platform === 'win32') {
      const guard = await openWindowsDeliveryJournalGuard(this.dataRoot, deadline ?? Date.now() + 30_000)
      let release: (() => Promise<void>) | undefined
      let primary: unknown, failed = false
      try {
        await guard.assertOwned()
        release = await lockfile.lock(guard.path, { retries: { retries: 30, minTimeout: 5, maxTimeout: 100 } })
        await guard.assertOwned()
        const result = await operation()
        await guard.assertOwned()
        return result
      } catch (error) { primary = error; failed = true; throw error }
      finally {
        const errors: unknown[] = []
        try { if (release) await release() } catch (error) { errors.push(error) }
        try { await guard.assertOwned() } catch (error) { errors.push(error) }
        try { await guard.close() } catch (error) { errors.push(error) }
        if (errors.length) throw new AggregateError([...(failed ? [primary] : []), ...errors],
          'cleanup_unknown', { cause: failed ? primary : errors[0] })
      }
    }
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

  reserve(base: SendMessageOutcomeBase, sessionId: string, identity: IntentIdentity): Promise<'submit' | 'observe'>
  reserve(base: SendMessageOutcomeBase, sessionId: string, identity: IntentIdentity, intentHash: string, deadline?: number): Promise<{ action: 'submit' | 'observe'; submissionOwner: string }>
  async reserve(base: SendMessageOutcomeBase, sessionId: string, identity: IntentIdentity, intentHash?: string, deadline?: number): Promise<'submit' | 'observe' | { action: 'submit' | 'observe'; submissionOwner: string }> {
    assertIntentIdentity(identity)
    executionAssert(base.requestId === identity.requestId && base.body.deliveryAttemptId === identity.deliveryAttemptId &&
      base.body.messageId === identity.localMessageId && /^ses_[a-zA-Z0-9]+$/.test(sessionId), 'delivery_identity_conflict')
    return this.withLock(async () => {
      const decision = (action: 'submit' | 'observe', submissionOwner = '') => intentHash ? { action, submissionOwner } : action
      // A combined lookup deliberately treats a missing request as a conflict.
      // Fresh delivery has neither owner: inspect each index independently, then
      // require every retained owner to join the original immutable identity.
      const byRequest = await this.query({ requestId: base.requestId })
      const byAttempt = await this.query({ deliveryAttemptId: identity.deliveryAttemptId })
      executionAssert(byRequest.diagnostics.length === 0 && byAttempt.diagnostics.length === 0, 'delivery_journal_unknown')
      if (byRequest.record) this.assertOriginal(byRequest.record, base, sessionId, identity, intentHash)
      if (byAttempt.record) this.assertOriginal(byAttempt.record, base, sessionId, identity, intentHash)
      const found = { record: byRequest.record ?? byAttempt.record }
      if (found.record && !found.record.safeToRetry) {
        this.assertOriginal(found.record, base, sessionId, identity, intentHash)
        const submissionOwner = found.record.diagnostics.filter(value => value.startsWith('v2_submission_owner:')).at(-1)?.slice('v2_submission_owner:'.length) ?? ''
        // Older fenced journals have no retry metadata. Keep them read-only;
        // an empty token can never authorize a refusal transition.
        return decision('observe', submissionOwner)
      }
      const submissionOwner = randomUUID()
      if (found.record?.status === 'failed_before_accept' && intentHash) {
        await this.store.upsert({ ...found.record, status: 'prompt_submitting',
          diagnostics: [`v2_intent_sha256:${intentHash}`, `v2_unreserved_sha256:${intentHash}`, `v2_submission_owner:${submissionOwner}`] }, { requireRetryable: true,
          retryUnreservedOwner: { runtimePromptMessageId: identity.nativeInputID, intentHash } })
        return decision('submit', submissionOwner)
      }
      // The shared locked store arbitrates a simultaneous fresh CLI admission.
      // UNKNOWN/submitting retries never pass this fence or allocate a new ID.
      await markSendMessageOutcome(base, { status: 'received',
        ...(intentHash ? { diagnostics: [`v2_intent_sha256:${intentHash}`, `v2_submission_owner:${submissionOwner}`] } : {}) }, this.store)
      await markSendMessageOutcome(base, { status: 'prompt_submitting', sessionId,
        runtimePromptMessageId: identity.nativeInputID }, this.store)
      return decision('submit', submissionOwner)
    }, deadline)
  }


  async refuse(base: SendMessageOutcomeBase, sessionId: string, intent: import('../execution/OpenCodeV2AdmissionService.js').QueueIntent,
    result: Extract<RunControlResult, { kind: 'send_refused' }>, submissionOwner: string, deadline?: number): Promise<SendMessageCommandData> {
    return this.withLock(async () => {
      executionAssert(result.disposition === 'not_reserved' && result.submissionOwner === submissionOwner && executionHash(result.intent) === executionHash(intent) &&
        result.authority.sessionID === sessionId && result.authority.teamId === base.teamId &&
        result.authority.runId === base.runId && result.authority.laneId === base.laneId &&
        result.authority.memberId === base.memberName, 'original_input_conflict')
      const found = await this.query({ requestId: intent.identity.requestId, deliveryAttemptId: intent.identity.deliveryAttemptId })
      executionAssert(found.record && found.diagnostics.length === 0, 'delivery_journal_unknown')
      this.assertOriginal(found.record, base, sessionId, intent.identity, executionHash(intent))
      executionAssert(found.record.diagnostics.filter(value => value.startsWith('v2_submission_owner:')).at(-1) ===
        `v2_submission_owner:${submissionOwner}`, 'delivery_submission_changed')
      // Supply every captured owner field, including nullable process identity;
      // the shared store compares this exact owner under its own write lock.
      await this.store.upsert({ ...found.record, status: 'failed_before_accept', error: 'native_input_not_reserved',
        diagnostics: [`v2_intent_sha256:${executionHash(intent)}`, `v2_unreserved_sha256:${executionHash(intent)}`] },
        { definitelyUnsubmitted: { runtimePromptMessageId: intent.identity.nativeInputID, submissionOwner } })
      return { accepted: false, runId: base.runId ?? undefined, sessionId, memberName: base.memberName,
        runtimePromptMessageId: intent.identity.nativeInputID,
        diagnostics: [{ code: 'native_input_not_reserved', severity: 'warning', message: 'The original input was not reserved or submitted.' }] }
    }, deadline)
  }

  private assertOriginal(record: OpenCodeCommandOutcomeRecord, base: SendMessageOutcomeBase,
    sessionId: string, identity: IntentIdentity, intentHash?: string): void {
    if (intentHash) {
      const tagged = record.diagnostics.some(value => value.startsWith('v2_intent_sha256:'))
      executionAssert(tagged ? record.diagnostics.includes(`v2_intent_sha256:${intentHash}`) : !record.safeToRetry, 'delivery_identity_conflict')
    }
    executionAssert(record.requestId === base.requestId && record.requestId === identity.requestId &&
      record.deliveryAttemptId === identity.deliveryAttemptId && record.messageId === identity.localMessageId &&
      record.runtimePromptMessageId === identity.nativeInputID && record.sessionId === sessionId &&
      record.teamId === base.teamId && record.teamName === base.teamName && record.runId === base.runId &&
      record.laneId === base.laneId && record.memberName === base.memberName && record.projectPath === base.projectPath &&
      commandStatusMismatchReason(record, base.body) === null, 'delivery_identity_conflict')
  }

  async commit(base: SendMessageOutcomeBase, sessionId: string, identity: IntentIdentity,
    result: DeliveryResult, observation: OpenCodeDeliveryResponseObservation, deadline?: number): Promise<SendMessageCommandData> {
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
    }, deadline)
  }

  async commitObservation(result: DeliveryResult, body: Record<string, unknown>,
    observation: OpenCodeDeliveryResponseObservation, deadline?: number): Promise<SendMessageCommandData> {
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
    result.admission.authority.sessionID, identity, result, observation, deadline)
  }
}
