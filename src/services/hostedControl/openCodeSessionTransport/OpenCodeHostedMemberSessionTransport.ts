import { createHash } from 'node:crypto'

import { hostedMemberAttempt, type AuthenticatedHostedMemberSessionPort,
  type HostedMemberAttempt, type HostedMemberDelivery,
  type HostedMemberDeliveryReceipt, type HostedMemberReplyReceipt, type HostedMemberSessionReceipt,
} from '../hostedLaneSession/HostedMemberSessionBridge.js'

const HANDLE = /^opencode_[0-9a-f]{32}$/
const GENERATION = /^[0-9a-f]{32}$/
const SESSION = /^ses[A-Za-z0-9_-]{8,120}$/
const MESSAGE = /^msg[A-Za-z0-9_-]{8,120}$/
const MAX_RESPONSE_BYTES = 256 * 1024
const REQUEST_TIMEOUT_MS = 10_000
const TITLE_PREFIX = 'hosted-member-attempt:'

export type OpenCodeEndpointProof = Readonly<{
  handle: string
  generation: string
  endpoint: string
  username: string
  password: string
  expiresAt: number
  signal: AbortSignal
}>

/**
 * Implemented by the supervisor boundary. It must attest the exact running
 * container/generation, hold its endpoint binding for the callback lifetime,
 * and supply the per-container server credential without exposing Docker to Owner.
 * The Basic credential grants reusable HTTP effect authority, so production
 * must mediate exact actions in root instead of composing this direct adapter.
 */
export interface OpenCodeEndpointAuthority {
  withAttestedEndpoint<T>(handle: string, generation: string,
    operation: (proof: OpenCodeEndpointProof) => Promise<T>): Promise<T>
}

type WireMessage = { info: Record<string, unknown>; parts: Record<string, unknown>[] }

/**
 * Official OpenCode v1.18.32 (tag 545f51d26cc39a907d2867492d498d9607ea5fa4)
 * /session HTTP transport. All uncertain writes are observed, never retried.
 */
export class OpenCodeHostedMemberSessionTransport implements AuthenticatedHostedMemberSessionPort {
  constructor(private readonly authority: OpenCodeEndpointAuthority,
    private readonly http: typeof fetch = fetch) {}

  async start(attempt: HostedMemberAttempt, prompt: string): Promise<HostedMemberSessionReceipt> {
    checkAttempt(attempt)
    if (!boundedText(prompt, 64 * 1024) || sha(prompt) !== attempt.promptSha256) {
      throw new TypeError('hosted-opencode-initial-prompt-invalid')
    }
    return this.withEndpoint(attempt, async proof => {
      const title = titleFor(attempt)
      // A prior ambiguous create is never followed by a second create or prompt.
      if (await this.findSession(proof, title)) throw new Error('hosted-opencode-start-already-issued')
      const created = await this.request(proof, 'POST', '/session', { title })
      if (!object(created) || !SESSION.test(String(created.id ?? '')) || created.title !== title) {
        throw new Error('hosted-opencode-created-session-invalid')
      }
      const sessionId = created.id as string
      const initialMessageId = initialId(attempt)
      await this.sendPrompt(proof, sessionId, initialMessageId, prompt, attempt.model)
      const observed = await this.getMessage(proof, sessionId, initialMessageId)
      if (!isUserText(observed, sessionId, initialMessageId, prompt)) {
        throw new Error('hosted-opencode-initial-prompt-unobserved')
      }
      return sessionReceipt(attempt, sessionId, initialMessageId)
    })
  }

  async observe(attempt: HostedMemberAttempt): Promise<HostedMemberSessionReceipt> {
    checkAttempt(attempt)
    return this.withEndpoint(attempt, async proof => {
      const session = await this.findSession(proof, titleFor(attempt))
      if (!session) return { ...attempt, state: 'failed', sessionId: null,
        initialMessageId: null, observedInitialMessageId: null }
      const id = initialId(attempt)
      const observed = await this.getMessage(proof, session.id, id)
      if (!isUserHash(observed, session.id, id, attempt.promptSha256)) {
        return { ...attempt, state: 'failed', sessionId: null,
          initialMessageId: null, observedInitialMessageId: null }
      }
      return sessionReceipt(attempt, session.id, id)
    })
  }

  async post(delivery: HostedMemberDelivery, sessionId: string): Promise<HostedMemberDeliveryReceipt> {
    checkDelivery(delivery, sessionId)
    return this.withEndpoint(delivery.attempt, async proof => {
      await this.assertSession(proof, delivery.attempt, sessionId)
      const id = deliveryMessageId(delivery)
      if (await this.getMessage(proof, sessionId, id)) throw new Error('hosted-opencode-delivery-already-issued')
      await this.sendPrompt(proof, sessionId, id, delivery.text, delivery.attempt.model)
      const observed = await this.getMessage(proof, sessionId, id)
      if (!isUserText(observed, sessionId, id, delivery.text)) {
        throw new Error('hosted-opencode-delivery-unobserved')
      }
      return deliveryReceipt(delivery, sessionId, id)
    })
  }

  async observeDelivery(delivery: HostedMemberDelivery, sessionId: string): Promise<HostedMemberDeliveryReceipt | null> {
    checkDelivery(delivery, sessionId)
    return this.withEndpoint(delivery.attempt, async proof => {
      await this.assertSession(proof, delivery.attempt, sessionId)
      const id = deliveryMessageId(delivery)
      const observed = await this.getMessage(proof, sessionId, id)
      return isUserText(observed, sessionId, id, delivery.text)
        ? deliveryReceipt(delivery, sessionId, id) : null
    })
  }

  async observeReply(delivery: HostedMemberDelivery, sessionId: string,
    userMessageId: string): Promise<HostedMemberReplyReceipt | null> {
    checkDelivery(delivery, sessionId)
    if (userMessageId !== deliveryMessageId(delivery)) return null
    return this.withEndpoint(delivery.attempt, async proof => {
      await this.assertSession(proof, delivery.attempt, sessionId)
      const user = await this.getMessage(proof, sessionId, userMessageId)
      if (!isUserText(user, sessionId, userMessageId, delivery.text)) return null
      const messages = await this.request(proof, 'GET', `/session/${sessionId}/message?limit=100`)
      if (!Array.isArray(messages) || messages.length > 100) throw new Error('hosted-opencode-message-list-invalid')
      const candidates = messages.filter(item => {
        const msg = wireMessage(item)
        return msg?.info.role === 'assistant' && msg.info.sessionID === sessionId &&
          msg.info.parentID === userMessageId && MESSAGE.test(String(msg.info.id ?? ''))
      })
      // Multiple assistant messages can be intermediate tool turns. Only one
      // completed, error-free reply is accepted; ambiguity stays unresolved.
      const complete = candidates.map(wireMessage).filter((msg): msg is WireMessage =>
        !!msg && isTerminalAssistant(msg))
      if (complete.length !== 1) return null
      const assistant = complete[0]!
      const text = assistant.parts.filter(p => p.type === 'text' && typeof p.text === 'string')
        .map(p => p.text as string).join('\n')
      if (!boundedText(text, 64_000)) return null
      return { ...deliveryReceipt(delivery, sessionId, userMessageId),
        assistantMessageId: assistant.info.id as string, parentUserMessageId: userMessageId, text }
    })
  }

  private async withEndpoint<T>(attempt: HostedMemberAttempt,
    work: (proof: OpenCodeEndpointProof) => Promise<T>): Promise<T> {
    return this.authority.withAttestedEndpoint(attempt.containerHandle, attempt.containerGeneration, async proof => {
      if (proof.handle !== attempt.containerHandle || proof.generation !== attempt.containerGeneration ||
        !/^http:\/\/127\.0\.0\.1:(?:[1-9][0-9]{3,4})$/.test(proof.endpoint) ||
        Number(proof.endpoint.slice(proof.endpoint.lastIndexOf(':') + 1)) > 65535 ||
        typeof proof.username !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(proof.username) ||
        typeof proof.password !== 'string' || proof.password.length < 32 || proof.password.length > 256 ||
        /[\x00-\x1f\x7f]/.test(proof.password) ||
        !Number.isSafeInteger(proof.expiresAt) || !(proof.signal instanceof AbortSignal)) {
        throw new Error('hosted-opencode-endpoint-proof-invalid')
      }
      assertLease(proof)
      const result = await work(proof)
      assertLease(proof)
      return result
    })
  }

  private async request(proof: OpenCodeEndpointProof, method: 'GET' | 'POST', path: string,
    body?: object): Promise<unknown> {
    assertLease(proof)
    const signal = AbortSignal.any([proof.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
    let response: Response
    try { response = await this.http(`${proof.endpoint}${path}`, {
      method, signal, redirect: 'error',
      headers: { authorization: `Basic ${Buffer.from(`${proof.username}:${proof.password}`).toString('base64')}`,
        ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }) } catch { throw new Error('hosted-opencode-http-failed') }
    assertLease(proof)
    if (!response.ok) throw new Error('hosted-opencode-http-failed')
    if (response.status === 204) return null
    try {
      const value = await boundedJson(response)
      assertLease(proof)
      return value
    } catch { throw new Error('hosted-opencode-response-invalid') }
  }

  private async findSession(proof: OpenCodeEndpointProof, title: string): Promise<{ id: string } | null> {
    const value = await this.request(proof, 'GET', `/session?search=${encodeURIComponent(title)}&limit=101`)
    if (!Array.isArray(value) || value.length > 100) throw new Error('hosted-opencode-session-list-unbounded')
    const matches = value.filter(item => object(item) && item.title === title && SESSION.test(String(item.id ?? '')))
    if (matches.length > 1) throw new Error('hosted-opencode-session-ambiguous')
    return matches.length === 1 ? { id: (matches[0] as { id: string }).id } : null
  }

  private async assertSession(proof: OpenCodeEndpointProof, attempt: HostedMemberAttempt,
    sessionId: string): Promise<void> {
    const found = await this.findSession(proof, titleFor(attempt))
    if (found?.id !== sessionId) throw new Error('hosted-opencode-session-binding-invalid')
    const initial = await this.getMessage(proof, sessionId, initialId(attempt))
    if (!isUserHash(initial, sessionId, initialId(attempt), attempt.promptSha256)) {
      throw new Error('hosted-opencode-initial-prompt-binding-invalid')
    }
  }

  private async getMessage(proof: OpenCodeEndpointProof, sessionId: string,
    messageId: string): Promise<WireMessage | null> {
    // Official endpoint returns 404 for a missing message; unlike writes this
    // read may use a direct scoped lookup without scanning another session.
    assertLease(proof)
    let response: Response
    try { response = await this.http(`${proof.endpoint}/session/${sessionId}/message/${messageId}`, {
      method: 'GET', signal: AbortSignal.any([proof.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]), redirect: 'error',
      headers: { authorization: `Basic ${Buffer.from(`${proof.username}:${proof.password}`).toString('base64')}` },
    }) } catch { throw new Error('hosted-opencode-message-read-failed') }
    assertLease(proof)
    if (response.status === 404) return null
    if (!response.ok) throw new Error('hosted-opencode-message-read-failed')
    try {
      const value = wireMessage(await boundedJson(response))
      assertLease(proof)
      return value
    } catch { throw new Error('hosted-opencode-message-read-failed') }
  }

  private async sendPrompt(proof: OpenCodeEndpointProof, sessionId: string,
    messageId: string, text: string, model: string): Promise<void> {
    const slash = model.indexOf('/')
    if (slash < 1 || slash === model.length - 1) throw new TypeError('hosted-opencode-model-invalid')
    await this.request(proof, 'POST', `/session/${sessionId}/prompt_async`, {
      messageID: messageId, model: { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) },
      parts: [{ type: 'text', text }],
    })
  }
}

function assertLease(proof: OpenCodeEndpointProof): void {
  if (proof.signal.aborted || Date.now() >= proof.expiresAt) {
    throw new Error('hosted-opencode-endpoint-lease-expired')
  }
}

function sessionReceipt(attempt: HostedMemberAttempt, sessionId: string,
  initialMessageId: string): HostedMemberSessionReceipt {
  return { ...attempt, state: 'ready', sessionId, initialMessageId,
    observedInitialMessageId: initialMessageId }
}

function deliveryReceipt(delivery: HostedMemberDelivery, sessionId: string,
  observedUserMessageId: string): HostedMemberDeliveryReceipt {
  return { attemptId: delivery.attempt.attemptId,
    containerGeneration: delivery.attempt.containerGeneration, sessionId,
    deliveryId: delivery.deliveryId, observedUserMessageId }
}

function wireMessage(value: unknown): WireMessage | null {
  return object(value) && object(value.info) && Array.isArray(value.parts) &&
    value.parts.every(object) ? value as WireMessage : null
}

function isUserHash(message: WireMessage | null, sessionId: string,
  messageId: string, expectedHash: string): boolean {
  return !!message && message.info.role === 'user' && message.info.sessionID === sessionId &&
    message.info.id === messageId && message.parts.length === 1 &&
    message.parts[0]?.type === 'text' && typeof message.parts[0]?.text === 'string' &&
    sha(message.parts[0].text) === expectedHash
}

function isUserText(message: WireMessage | null, sessionId: string,
  messageId: string, text: string): boolean {
  return isUserHash(message, sessionId, messageId, sha(text))
}

function isTerminalAssistant(message: WireMessage): boolean {
  const finish = message.info.finish
  const time = message.info.time
  if (typeof finish !== 'string' || finish.length === 0 ||
    finish === 'tool-calls' || finish === 'unknown' || finish === 'content-filter' ||
    message.info.error || !object(time) || typeof time.completed !== 'number' ||
    !Number.isFinite(time.completed) || time.completed <= 0) return false
  // processor.ts writes finish before cleanup persists time.completed. The
  // early snapshot can still fail or retry, so it cannot authorize a reply.
  // Match OpenCode v1.18.32 prompt loop's exit condition. Providers can report
  // `stop` while a local tool call remains pending, so finish alone is unsafe.
  return !message.parts.some(part => {
    if (part.type !== 'tool') return false
    if (object(part.metadata) && part.metadata.providerExecuted === true) return false
    if (object(part.state) && part.state.status === 'error' &&
      object(part.state.metadata) && part.state.metadata.interrupted === true) return false
    return true
  })
}

function titleFor(attempt: HostedMemberAttempt): string { return `${TITLE_PREFIX}${attempt.attemptId}` }
function initialId(attempt: HostedMemberAttempt): string { return `msg_${sha(attempt.attemptId).slice(0, 32)}` }
function deliveryMessageId(delivery: HostedMemberDelivery): string {
  return `msg_${sha([delivery.attempt.attemptId, delivery.deliveryId, delivery.text]).slice(0, 32)}`
}
function sha(value: unknown): string {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')
}
async function boundedJson(response: Response): Promise<unknown> {
  const length = response.headers.get('content-length')
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)) {
    throw new Error('hosted-opencode-response-too-large')
  }
  if (!response.body) throw new Error('hosted-opencode-response-empty')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel()
        throw new Error('hosted-opencode-response-too-large')
      }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }
  catch { throw new Error('hosted-opencode-response-invalid-json') }
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
function boundedText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && Buffer.byteLength(value, 'utf8') <= max
}
function checkAttempt(attempt: HostedMemberAttempt): void {
  if (!object(attempt) || !HANDLE.test(String(attempt.containerHandle ?? '')) ||
    !GENERATION.test(String(attempt.containerGeneration ?? '')) ||
    !/^member_attempt_[0-9a-f]{64}$/.test(String(attempt.attemptId ?? '')) ||
    !/^[0-9a-f]{64}$/.test(String(attempt.promptSha256 ?? '')) ||
    typeof attempt.model !== 'string' || attempt.model.length > 256 ||
    !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._:/-]+$/.test(attempt.model)) {
    throw new TypeError('hosted-opencode-attempt-invalid')
  }
  const { attemptId, ...input } = attempt
  if (hostedMemberAttempt(input).attemptId !== attemptId) {
    throw new TypeError('hosted-opencode-attempt-invalid')
  }
}
function checkDelivery(delivery: HostedMemberDelivery, sessionId: string): void {
  if (!object(delivery) || !object(delivery.attempt)) throw new TypeError('hosted-opencode-delivery-invalid')
  checkAttempt(delivery.attempt)
  if (!SESSION.test(sessionId) || typeof delivery.deliveryId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(delivery.deliveryId) ||
    !boundedText(delivery.text, 4_000) || delivery.text.trim() !== delivery.text ||
    /[\x00\r\x7f]/.test(delivery.text)) throw new TypeError('hosted-opencode-delivery-invalid')
}
