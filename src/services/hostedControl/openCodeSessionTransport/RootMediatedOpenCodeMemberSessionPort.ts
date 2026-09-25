import { createHash, randomBytes } from 'node:crypto'

import { hostedMemberAttempt, type AuthenticatedHostedMemberSessionPort,
  type HostedMemberAttempt, type HostedMemberDelivery, type HostedMemberDeliveryReceipt,
  type HostedMemberReplyReceipt, type HostedMemberSessionReceipt } from
  '../hostedLaneSession/HostedMemberSessionBridge.js'
import type { RootOpenCodeAction, RootOpenCodeActionKind, RootOpenCodeActionResult } from
  '../openCodeRootHttpProxy/RootOpenCodeHttpProxy.js'

const RUN = /^run_[0-9a-f]{32}$/
const SESSION = /^ses[A-Za-z0-9_-]{8,120}$/
const MESSAGE = /^msg[A-Za-z0-9_-]{8,120}$/
const SOURCE = /^(?:task|message)_[a-z0-9_-]{8,95}$/

export interface RootOpenCodeSessionActionPort {
  sessionAction(action: RootOpenCodeAction): Promise<RootOpenCodeActionResult>
}

function sha(value: string): string { return createHash('sha256').update(value).digest('hex') }

function attemptOf(value: HostedMemberAttempt): HostedMemberAttempt {
  const { attemptId, ...input } = value
  if (!RUN.test(value.runId) || hostedMemberAttempt(input).attemptId !== attemptId) {
    throw new Error('hosted-root-session-attempt-invalid')
  }
  return value
}

function created(attempt: HostedMemberAttempt, sessionId: string): HostedMemberSessionReceipt {
  return { ...attempt, state: 'created', sessionId, initialMessageId: null, observedInitialMessageId: null }
}

function ready(attempt: HostedMemberAttempt, sessionId: string, messageId: string): HostedMemberSessionReceipt {
  return { ...attempt, state: 'ready', sessionId, initialMessageId: messageId,
    observedInitialMessageId: messageId }
}

function sourceRef(delivery: HostedMemberDelivery): string {
  // The committed peer wake is named wake_<canonical message id> by the tool broker.
  const ref = delivery.kind === 'task' ? delivery.taskId :
    delivery.deliveryId.startsWith('wake_') ? delivery.deliveryId.slice(5) : delivery.deliveryId
  if (typeof ref !== 'string' || !SOURCE.test(ref) ||
    !ref.startsWith(delivery.kind === 'task' ? 'task_' : 'message_')) {
    throw new Error('hosted-root-session-source-invalid')
  }
  return ref
}

/** Owner sends only selectors over the authenticated root RPC; Root resolves all effect bytes. */
export class RootMediatedOpenCodeMemberSessionPort implements AuthenticatedHostedMemberSessionPort {
  constructor(private readonly root: RootOpenCodeSessionActionPort) {
    if (typeof root?.sessionAction !== 'function') throw new Error('hosted-root-session-rpc-required')
  }

  private action(attempt: HostedMemberAttempt, kind: RootOpenCodeActionKind,
    sourceRef: string | null = null): Promise<RootOpenCodeActionResult> {
    attemptOf(attempt)
    return this.root.sessionAction({ operationId: `action_${randomBytes(16).toString('hex')}`, kind,
      runId: attempt.runId, memberId: attempt.memberId, attemptId: attempt.attemptId,
      containerHandle: attempt.containerHandle, containerGeneration: attempt.containerGeneration, sourceRef })
  }

  /** Compatibility path cannot submit a prompt before FD3 activation. */
  start(attempt: HostedMemberAttempt): Promise<HostedMemberSessionReceipt> { return this.createSession(attempt) }

  async createSession(attempt: HostedMemberAttempt): Promise<HostedMemberSessionReceipt> {
    const observed = await this.observe(attempt)
    if (observed.sessionId) throw new Error('hosted-root-session-already-created')
    const result = await this.action(attempt, 'session_create')
    if (result.outcome !== 'responded' || result.kind !== 'session_create' ||
      !SESSION.test(result.sessionId)) throw new Error('hosted-root-session-create-unconfirmed')
    return created(attempt, result.sessionId)
  }

  async submitInitial(attempt: HostedMemberAttempt, sessionId: string,
    prompt: string): Promise<HostedMemberSessionReceipt> {
    if (!SESSION.test(sessionId) || typeof prompt !== 'string' ||
      Buffer.byteLength(prompt) > 64 * 1024 || sha(prompt) !== attempt.promptSha256) {
      throw new Error('hosted-root-session-initial-invalid')
    }
    const before = await this.observe(attempt)
    if (before.sessionId !== sessionId || before.state === 'ready') {
      throw new Error('hosted-root-session-binding-invalid')
    }
    const result = await this.action(attempt, 'initial_prompt')
    if (result.outcome !== 'responded' || result.kind !== 'initial_prompt' || result.accepted !== true) {
      throw new Error('hosted-root-session-initial-unconfirmed')
    }
    const after = await this.observe(attempt)
    if (after.state !== 'ready' || after.sessionId !== sessionId) {
      throw new Error('hosted-root-session-initial-unobserved')
    }
    return after
  }

  async observe(attempt: HostedMemberAttempt): Promise<HostedMemberSessionReceipt> {
    const result = await this.action(attempt, 'session_observe')
    if (result.outcome !== 'responded' || result.kind !== 'session_observe' ||
      (result.sessionId !== null && !SESSION.test(result.sessionId)) ||
      (result.observedInitialMessageId !== null && !MESSAGE.test(result.observedInitialMessageId)) ||
      (result.sessionId === null && result.observedInitialMessageId !== null)) {
      throw new Error('hosted-root-session-observe-unconfirmed')
    }
    if (!result.sessionId) return { ...attempt, state: 'failed', sessionId: null,
      initialMessageId: null, observedInitialMessageId: null }
    return result.observedInitialMessageId
      ? ready(attempt, result.sessionId, result.observedInitialMessageId)
      : created(attempt, result.sessionId)
  }

  async post(delivery: HostedMemberDelivery, sessionId: string): Promise<HostedMemberDeliveryReceipt> {
    await this.assertSession(delivery.attempt, sessionId)
    const ref = sourceRef(delivery)
    const kind = delivery.kind === 'task' ? 'task_delivery' : 'peer_delivery'
    const result = await this.action(delivery.attempt, kind, ref)
    if (result.outcome !== 'responded' || result.kind !== kind || result.accepted !== true) {
      throw new Error('hosted-root-session-delivery-unconfirmed')
    }
    const observed = await this.observeDelivery(delivery, sessionId)
    if (!observed) throw new Error('hosted-root-session-delivery-unobserved')
    return observed
  }

  async observeDelivery(delivery: HostedMemberDelivery,
    sessionId: string): Promise<HostedMemberDeliveryReceipt | null> {
    await this.assertSession(delivery.attempt, sessionId)
    const result = await this.action(delivery.attempt, 'delivery_observe', sourceRef(delivery))
    if (result.outcome !== 'responded' || result.kind !== 'delivery_observe' ||
      (result.observedUserMessageId !== null && !MESSAGE.test(result.observedUserMessageId))) {
      throw new Error('hosted-root-session-delivery-observe-unconfirmed')
    }
    return result.observedUserMessageId ? { attemptId: delivery.attempt.attemptId,
      containerGeneration: delivery.attempt.containerGeneration, sessionId,
      deliveryId: delivery.deliveryId, observedUserMessageId: result.observedUserMessageId } : null
  }

  async observeReply(delivery: HostedMemberDelivery, sessionId: string,
    userMessageId: string): Promise<HostedMemberReplyReceipt | null> {
    if (!MESSAGE.test(userMessageId)) return null
    const observed = await this.observeDelivery(delivery, sessionId)
    if (!observed || observed.observedUserMessageId !== userMessageId) return null
    const result = await this.action(delivery.attempt, 'reply_observe', sourceRef(delivery))
    if (result.outcome !== 'responded' || result.kind !== 'reply_observe') {
      throw new Error('hosted-root-session-reply-unconfirmed')
    }
    if (!result.reply) return null
    const reply = result.reply
    if (!MESSAGE.test(reply.assistantMessageId) || reply.parentUserMessageId !== userMessageId ||
      typeof reply.text !== 'string' || !reply.text.trim() || Buffer.byteLength(reply.text) > 64_000) {
      throw new Error('hosted-root-session-reply-invalid')
    }
    return { ...observed, ...reply }
  }

  private async assertSession(attempt: HostedMemberAttempt, sessionId: string): Promise<void> {
    if (!SESSION.test(sessionId)) throw new Error('hosted-root-session-binding-invalid')
    const observed = await this.observe(attempt)
    if (observed.state !== 'ready' || observed.sessionId !== sessionId) {
      throw new Error('hosted-root-session-binding-invalid')
    }
  }
}
