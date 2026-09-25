import { createHash } from 'node:crypto'

import { hostedMemberAttempt, type HostedMemberAttempt } from
  '../hostedLaneSession/HostedMemberSessionBridge.js'
import type { RootOpenCodeAction, RootOpenCodeActionResult } from
  '../openCodeRootHttpProxy/RootOpenCodeHttpProxy.js'

const SOURCE = /^(?:task|message)_[a-z0-9_-]{8,95}$/
const REVISION = /^[a-z0-9][a-z0-9_-]{7,127}$/
const MESSAGE = /^msg[A-Za-z0-9_-]{8,120}$/
const MAX_REPLY_BYTES = 64_000

export type HostedCommittedDeliveryRef = Readonly<{
  kind: 'task' | 'peer'
  sourceRef: string
}>

/** Product's committed version and target. This port must not read Owner task/inbox files. */
export type HostedCommittedDelivery = HostedCommittedDeliveryRef & Readonly<{
  revision: string
  runId: string
  memberId: string
  attemptId: string
  containerHandle: string
  containerGeneration: string
}>

export interface HostedCommittedDeliverySource {
  /** Return null for missing, uncommitted, superseded, or revoked references. */
  resolve(ref: HostedCommittedDeliveryRef): Promise<HostedCommittedDelivery | null>
}

export interface HostedOwnerRootSessionActions {
  sessionAction(action: RootOpenCodeAction): Promise<RootOpenCodeActionResult>
}

export type HostedObservedDelivery = Readonly<{
  sourceRef: string
  revision: string
  observedUserMessageId: string
}>

export type HostedObservedReply = HostedObservedDelivery & Readonly<{
  assistantMessageId: string
  parentUserMessageId: string
  text: string
}>

type DeliveryState = 'delivered' | 'operator_required' | 'unavailable'

/**
 * Inactive Owner-side adapter. Product selects a committed immutable version;
 * root must independently resolve and check that same version from operationId
 * before any effect. No task/message text enters this Owner-facing API.
 */
export class HostedOwnerCommittedDeliveryBridge {
  readonly #attempt: HostedMemberAttempt

  constructor(
    attempt: HostedMemberAttempt,
    private readonly product: HostedCommittedDeliverySource,
    private readonly root: HostedOwnerRootSessionActions,
  ) {
    const { attemptId, ...input } = attempt
    const canonical = hostedMemberAttempt(input)
    if (canonical.attemptId !== attemptId) throw new TypeError('hosted-delivery-attempt-invalid')
    this.#attempt = canonical
  }

  async deliver(ref: HostedCommittedDeliveryRef): Promise<DeliveryState> {
    const committed = await this.#resolve(ref)
    if (!committed) return 'unavailable'
    const action = this.#action(committed, committed.kind === 'task' ? 'task_delivery' : 'peer_delivery')
    let result: RootOpenCodeActionResult
    try { result = await this.root.sessionAction(action) }
    catch { return 'operator_required' }
    if (result.outcome === 'claim_conflict') return 'operator_required'
    // A timeout or an existing root-durable claim may already have emitted the
    // prompt. Root must suppress a second write; Owner requires observation.
    return await this.#observe(committed) ? 'delivered' :
      result.outcome === 'unavailable' ? 'unavailable' : 'operator_required'
  }

  async observeDelivery(ref: HostedCommittedDeliveryRef): Promise<HostedObservedDelivery | null> {
    const committed = await this.#resolve(ref)
    return committed ? this.#observe(committed) : null
  }

  async observeReply(ref: HostedCommittedDeliveryRef): Promise<HostedObservedReply | null> {
    const committed = await this.#resolve(ref)
    if (!committed) return null
    const delivered = await this.#observe(committed)
    if (!delivered || !await this.#stillCurrent(committed)) return null
    try {
      const reply = await this.root.sessionAction(this.#action(committed, 'reply_observe'))
      if (reply.outcome !== 'responded' || reply.kind !== 'reply_observe' || !reply.reply ||
        !MESSAGE.test(reply.reply.assistantMessageId) ||
        reply.reply.parentUserMessageId !== delivered.observedUserMessageId ||
        typeof reply.reply.text !== 'string' || !reply.reply.text.trim() ||
        Buffer.byteLength(reply.reply.text, 'utf8') > MAX_REPLY_BYTES ||
        !await this.#stillCurrent(committed)) return null
      return Object.freeze({ ...delivered, ...reply.reply })
    } catch { return null }
  }

  async #observe(committed: HostedCommittedDelivery): Promise<HostedObservedDelivery | null> {
    if (!await this.#stillCurrent(committed)) return null
    try {
      const result = await this.root.sessionAction(this.#action(committed, 'delivery_observe'))
      if (result.outcome !== 'responded' || result.kind !== 'delivery_observe' ||
        !MESSAGE.test(result.observedUserMessageId ?? '') ||
        !await this.#stillCurrent(committed)) return null
      return Object.freeze({ sourceRef: committed.sourceRef, revision: committed.revision,
        observedUserMessageId: result.observedUserMessageId! })
    } catch { return null }
  }

  async #resolve(ref: HostedCommittedDeliveryRef): Promise<HostedCommittedDelivery | null> {
    if (!validRef(ref)) return null
    try {
      const value = await this.product.resolve(ref)
      const committed = value && Object.freeze({ ...value })
      return matches(committed, ref, this.#attempt) ? committed : null
    } catch { return null }
  }

  async #stillCurrent(committed: HostedCommittedDelivery): Promise<boolean> {
    try {
      return matches(await this.product.resolve({ kind: committed.kind, sourceRef: committed.sourceRef }),
        committed, this.#attempt, committed.revision)
    } catch { return false }
  }

  #action(committed: HostedCommittedDelivery, kind: RootOpenCodeAction['kind']): RootOpenCodeAction {
    return Object.freeze({
      operationId: `action_${createHash('sha256').update(JSON.stringify([
        'hosted-product-delivery/v1', this.#attempt.attemptId, committed.kind,
        committed.sourceRef, committed.revision, kind,
      ])).digest('hex')}`,
      kind, runId: this.#attempt.runId, memberId: this.#attempt.memberId,
      attemptId: this.#attempt.attemptId, containerHandle: this.#attempt.containerHandle,
      containerGeneration: this.#attempt.containerGeneration, sourceRef: committed.sourceRef,
    })
  }
}

function validRef(value: unknown): value is HostedCommittedDeliveryRef {
  return exact(value, ['kind', 'sourceRef']) &&
    (value.kind === 'task' && typeof value.sourceRef === 'string' &&
      SOURCE.test(value.sourceRef) && value.sourceRef.startsWith('task_') ||
      value.kind === 'peer' && typeof value.sourceRef === 'string' &&
      SOURCE.test(value.sourceRef) && value.sourceRef.startsWith('message_'))
}

function matches(value: unknown, ref: HostedCommittedDeliveryRef,
  attempt: HostedMemberAttempt, revision?: string): value is HostedCommittedDelivery {
  return exact(value, ['kind', 'sourceRef', 'revision', 'runId', 'memberId',
    'attemptId', 'containerHandle', 'containerGeneration']) &&
    value.kind === ref.kind && value.sourceRef === ref.sourceRef &&
    typeof value.revision === 'string' && REVISION.test(value.revision) &&
    (revision === undefined || value.revision === revision) &&
    value.runId === attempt.runId && value.memberId === attempt.memberId &&
    value.attemptId === attempt.attemptId &&
    value.containerHandle === attempt.containerHandle &&
    value.containerGeneration === attempt.containerGeneration
}

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    Reflect.ownKeys(value).length === keys.length &&
    Reflect.ownKeys(value).every(key => typeof key === 'string' && keys.includes(key))
}
