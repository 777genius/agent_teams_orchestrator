import { createHash } from 'node:crypto'

const HEX = /^[0-9a-f]{64}$/
const MEMBER_ID = /^member_[0-9a-f]{32}$/
const CONTAINER = /^opencode_[0-9a-f]{32}$/
const GENERATION = /^[0-9a-f]{32}$/
const SESSION = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/
const MESSAGE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/

export type HostedMemberAttempt = Readonly<{
  teamId: string
  runId: string
  laneId: string
  memberId: string
  memberName: string
  model: string
  promptSha256: string
  planFingerprint: string
  containerHandle: string
  containerGeneration: string
  attemptId: string
}>

export type HostedMemberSessionReceipt = HostedMemberAttempt & Readonly<{
  state: 'created' | 'launching' | 'ready' | 'failed'
  sessionId: string | null
  initialMessageId: string | null
  observedInitialMessageId: string | null
}>

export type HostedMemberDelivery = Readonly<{
  attempt: HostedMemberAttempt
  deliveryId: string
  kind: 'message' | 'task'
  text: string
  taskId: string | null
  taskRevision: string | null
}>

export type HostedMemberDeliveryReceipt = Readonly<{
  attemptId: string
  containerGeneration: string
  sessionId: string
  deliveryId: string
  observedUserMessageId: string
}>

export type HostedMemberReplyReceipt = HostedMemberDeliveryReceipt & Readonly<{
  assistantMessageId: string
  parentUserMessageId: string
  text: string
}>

/** The implementation must authenticate its peer and bind every call to the exact container generation. */
export interface AuthenticatedHostedMemberSessionPort {
  start(attempt: HostedMemberAttempt, prompt: string): Promise<unknown>
  /** Session creation must have no model/prompt effect. */
  createSession?(attempt: HostedMemberAttempt): Promise<unknown>
  /** Caller must bind and activate FD3 before invoking this first prompt. */
  submitInitial?(attempt: HostedMemberAttempt, sessionId: string, prompt: string): Promise<unknown>
  observe(attempt: HostedMemberAttempt): Promise<unknown>
  post(delivery: HostedMemberDelivery, sessionId: string): Promise<unknown>
  observeDelivery(delivery: HostedMemberDelivery, sessionId: string): Promise<unknown>
  observeReply(delivery: HostedMemberDelivery, sessionId: string, userMessageId: string): Promise<unknown>
}

/** Claims must be atomic and durable. Existing claims must preserve their original fingerprint. */
export interface HostedMemberSessionClaims {
  claimStart(attempt: HostedMemberAttempt): Promise<{ created: boolean; fingerprint: string }>
  claimDelivery(delivery: HostedMemberDelivery, fingerprint: string): Promise<{
    created: boolean
    fingerprint: string
  }>
  readDelivery(deliveryId: string): Promise<{ fingerprint: string } | null>
}

export function hostedMemberAttempt(input: Omit<HostedMemberAttempt, 'attemptId'>): HostedMemberAttempt {
  if (!exactKeys(input, ['teamId', 'runId', 'laneId', 'memberId', 'memberName', 'model',
    'promptSha256', 'planFingerprint', 'containerHandle', 'containerGeneration'])) {
    throw new TypeError('Invalid hosted member binding fields')
  }
  if (!MEMBER_ID.test(input.memberId) || !CONTAINER.test(input.containerHandle) ||
    !GENERATION.test(input.containerGeneration) || !HEX.test(input.planFingerprint) ||
    !HEX.test(input.promptSha256) || !boundedModel(input.model) ||
    !boundedName(input.memberName) || !boundedName(input.teamId) ||
    !boundedName(input.runId) || !boundedName(input.laneId)) {
    throw new TypeError('Invalid hosted member binding')
  }
  return Object.freeze({
    teamId: input.teamId, runId: input.runId, laneId: input.laneId,
    memberId: input.memberId, memberName: input.memberName, model: input.model,
    promptSha256: input.promptSha256, planFingerprint: input.planFingerprint,
    containerHandle: input.containerHandle, containerGeneration: input.containerGeneration,
    attemptId: `member_attempt_${sha([input.teamId, input.runId, input.laneId,
      input.memberId, input.memberName, input.model, input.promptSha256, input.planFingerprint,
      input.containerHandle, input.containerGeneration])}`,
  })
}

/**
 * Coordinates one member/process/FD3 session. An ambiguous Start or prompt is
 * only observed, never retried under the same durable claim.
 */
export class HostedMemberSessionBridge {
  constructor(
    private readonly port: AuthenticatedHostedMemberSessionPort,
    private readonly claims: HostedMemberSessionClaims,
    private readonly activateBeforePrompt?: (attempt: HostedMemberAttempt, sessionId: string) => Promise<void>,
  ) {}

  async start(attempt: HostedMemberAttempt, prompt: string): Promise<'ready' | 'launching' | 'failed'> {
    const exact = validateAttempt(attempt)
    if (typeof prompt !== 'string' || Buffer.byteLength(prompt, 'utf8') > 64 * 1024 ||
      createHash('sha256').update(prompt).digest('hex') !== exact.promptSha256) {
      throw new TypeError('Hosted member prompt does not match admitted plan')
    }
    const claim = await this.claims.claimStart(exact)
    if (claim.fingerprint !== exact.planFingerprint) return 'failed'
    if (!claim.created) return this.observe(exact)
    try {
      if (this.activateBeforePrompt) {
        if (!this.port.createSession || !this.port.submitInitial) return 'failed'
        const created = createdSessionId(await this.port.createSession(exact), exact)
        if (!created) return 'failed'
        await this.activateBeforePrompt(exact, created)
        const initial = initialPromptDelivery(exact, prompt)
        const fingerprint = deliveryFingerprint(initial)
        const promptClaim = await this.claims.claimDelivery(initial, fingerprint)
        if (promptClaim.fingerprint !== fingerprint) return 'failed'
        if (!promptClaim.created) return this.observe(exact)
        return receiptState(await this.port.submitInitial(exact, created, prompt), exact)
      }
      return receiptState(await this.port.start(exact, prompt), exact)
    } catch {
      // A failed RPC may have created the session or submitted the first prompt.
      return 'failed'
    }
  }

  async observe(attempt: HostedMemberAttempt): Promise<'ready' | 'launching' | 'failed'> {
    const exact = validateAttempt(attempt)
    try { return receiptState(await this.port.observe(exact), exact) }
    catch { return 'failed' }
  }

  async deliver(delivery: HostedMemberDelivery): Promise<'delivered' | 'operator_required' | 'conflict' | 'unavailable'> {
    const exact = validateDelivery(delivery)
    let observed: unknown
    try { observed = await this.port.observe(exact.attempt) } catch { return 'unavailable' }
    if (receiptState(observed, exact.attempt) !== 'ready') return 'unavailable'
    const sessionId = (observed as HostedMemberSessionReceipt).sessionId!
    const fingerprint = deliveryFingerprint(exact)
    const claim = await this.claims.claimDelivery(exact, fingerprint)
    if (claim.fingerprint !== fingerprint) return 'conflict'
    try {
      const result = claim.created
        ? await this.port.post(exact, sessionId)
        : await this.port.observeDelivery(exact, sessionId)
      return validDeliveryReceipt(result, exact, sessionId) ? 'delivered' : 'operator_required'
    } catch { return 'operator_required' }
  }

  /** A delivered user prompt is distinct from a peer's observed assistant reply. */
  async observeReply(delivery: HostedMemberDelivery): Promise<HostedMemberReplyReceipt | null> {
    const exact = validateDelivery(delivery)
    try {
      const claim = await this.claims.readDelivery(exact.deliveryId)
      if (!claim || claim.fingerprint !== deliveryFingerprint(exact)) return null
      const session = await this.port.observe(exact.attempt)
      if (receiptState(session, exact.attempt) !== 'ready') return null
      const sessionId = (session as HostedMemberSessionReceipt).sessionId!
      const posted = await this.port.observeDelivery(exact, sessionId)
      if (!validDeliveryReceipt(posted, exact, sessionId)) return null
      const userMessageId = (posted as HostedMemberDeliveryReceipt).observedUserMessageId
      const reply = await this.port.observeReply(exact, sessionId, userMessageId)
      if (!validDeliveryReceipt(reply, exact, sessionId) || !record(reply) ||
        reply.parentUserMessageId !== userMessageId || !MESSAGE.test(String(reply.assistantMessageId ?? '')) ||
        typeof reply.text !== 'string' || reply.text.trim().length === 0 ||
        Buffer.byteLength(reply.text, 'utf8') > 64_000) return null
      return reply as HostedMemberReplyReceipt
    } catch { return null }
  }
}

function validateAttempt(attempt: HostedMemberAttempt): HostedMemberAttempt {
  if (!exactKeys(attempt, ['teamId', 'runId', 'laneId', 'memberId', 'memberName', 'model',
    'promptSha256', 'planFingerprint', 'containerHandle', 'containerGeneration', 'attemptId'])) {
    throw new TypeError('Invalid hosted member attempt fields')
  }
  const { attemptId, ...input } = attempt
  if (hostedMemberAttempt(input).attemptId !== attemptId) throw new TypeError('Invalid hosted member attempt')
  return attempt
}

function receiptState(value: unknown, attempt: HostedMemberAttempt): 'ready' | 'launching' | 'failed' {
  if (!record(value)) return 'failed'
  const receipt = value as Partial<HostedMemberSessionReceipt>
  for (const key of ['teamId', 'runId', 'laneId', 'memberId', 'memberName', 'model', 'promptSha256', 'planFingerprint',
    'containerHandle', 'containerGeneration', 'attemptId'] as const) {
    if (receipt[key] !== attempt[key]) return 'failed'
  }
  if (receipt.state === 'launching') return 'launching'
  if (receipt.state === 'created') return createdSessionId(receipt, attempt) ? 'launching' : 'failed'
  if (receipt.state !== 'ready' || !SESSION.test(receipt.sessionId ?? '') ||
    !MESSAGE.test(receipt.initialMessageId ?? '') ||
    receipt.observedInitialMessageId !== receipt.initialMessageId) return 'failed'
  return 'ready'
}

function createdSessionId(value: unknown, attempt: HostedMemberAttempt): string | null {
  if (!record(value)) return null
  const receipt = value as Partial<HostedMemberSessionReceipt>
  for (const key of ['teamId', 'runId', 'laneId', 'memberId', 'memberName', 'model', 'promptSha256',
    'planFingerprint', 'containerHandle', 'containerGeneration', 'attemptId'] as const) {
    if (receipt[key] !== attempt[key]) return null
  }
  return receipt.state === 'created' && SESSION.test(receipt.sessionId ?? '') &&
    receipt.initialMessageId === null && receipt.observedInitialMessageId === null
    ? receipt.sessionId! : null
}

function initialPromptDelivery(attempt: HostedMemberAttempt, prompt: string): HostedMemberDelivery {
  return { attempt, deliveryId: `initial_${sha(attempt.attemptId)}`, kind: 'message',
    text: prompt, taskId: null, taskRevision: null }
}

function validateDelivery(delivery: HostedMemberDelivery): HostedMemberDelivery {
  if (!exactKeys(delivery, ['attempt', 'deliveryId', 'kind', 'text', 'taskId', 'taskRevision'])) {
    throw new TypeError('Invalid hosted member delivery fields')
  }
  validateAttempt(delivery.attempt)
  if (!MESSAGE.test(delivery.deliveryId) || typeof delivery.text !== 'string' ||
    delivery.text.trim() !== delivery.text || Buffer.byteLength(delivery.text, 'utf8') < 1 ||
    Buffer.byteLength(delivery.text, 'utf8') > 4_000 || /[\x00\r\x7f]/.test(delivery.text)) {
    throw new TypeError('Invalid hosted member delivery')
  }
  if (delivery.kind === 'message' && (delivery.taskId !== null || delivery.taskRevision !== null)) {
    throw new TypeError('Invalid hosted message task reference')
  }
  if (delivery.kind === 'task' && (!MESSAGE.test(delivery.taskId ?? '') ||
    !MESSAGE.test(delivery.taskRevision ?? ''))) {
    throw new TypeError('Hosted task delivery needs a committed task and revision')
  }
  return delivery
}

function deliveryFingerprint(delivery: HostedMemberDelivery): string {
  return sha([delivery.attempt.attemptId, delivery.deliveryId, delivery.kind,
    delivery.text, delivery.taskId, delivery.taskRevision])
}

function validDeliveryReceipt(value: unknown, delivery: HostedMemberDelivery, sessionId: string): boolean {
  if (!record(value)) return false
  const receipt = value as Partial<HostedMemberDeliveryReceipt>
  return receipt.attemptId === delivery.attempt.attemptId &&
    receipt.containerGeneration === delivery.attempt.containerGeneration &&
    receipt.sessionId === sessionId && receipt.deliveryId === delivery.deliveryId &&
    MESSAGE.test(receipt.observedUserMessageId ?? '')
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value: unknown, expected: string[]): boolean {
  return record(value) && Reflect.ownKeys(value).length === expected.length &&
    Reflect.ownKeys(value).every(key => typeof key === 'string' && expected.includes(key))
}

function boundedName(value: string): boolean {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
}

function boundedModel(value: string): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 &&
    !/[\x00-\x1f\x7f]/.test(value)
}

function sha(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
