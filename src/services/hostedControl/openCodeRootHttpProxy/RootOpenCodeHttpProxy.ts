import { createHash } from 'node:crypto'

import type { HostedProductCurrentMember, HostedProductMemberBinding } from
  '../productAuthority/HostedProductCurrentMemberDecision.js'

const ID = /^[a-z0-9][a-z0-9_-]{7,95}$/
const RUN = /^run_[0-9a-f]{32}$/
const MEMBER = /^member_[0-9a-f]{32}$/
const ATTEMPT = /^member_attempt_[0-9a-f]{64}$/
const HANDLE = /^opencode_[0-9a-f]{32}$/
const GENERATION = /^[0-9a-f]{32}$/
const SESSION = /^ses[A-Za-z0-9_-]{8,120}$/
const MESSAGE = /^msg[A-Za-z0-9_-]{8,120}$/
const SHA = /^[0-9a-f]{64}$/
const SOURCE = /^(?:task|message)_[a-z0-9_-]{8,95}$/
const MAX_TEXT = 64 * 1024
// Leaves room for the signed supervisor RPC envelope, including its two nonces and HMAC.
const MAX_RPC_RESULT_JSON_BYTES = 3000

export type RootOpenCodeActionKind = 'session_create' | 'initial_prompt' | 'session_observe' |
  'task_delivery' | 'peer_delivery' | 'delivery_observe' | 'reply_observe'

/** Owner sends selectors only. No URL, HTTP method, credential, model, or prompt can cross this boundary. */
export type RootOpenCodeAction = Readonly<{
  operationId: string
  kind: RootOpenCodeActionKind
  runId: string
  memberId: string
  attemptId: string
  containerHandle: string
  containerGeneration: string
  sourceRef: string | null
}>

export type RootOpenCodeActionResult = Readonly<
  | { outcome: 'responded'; kind: 'session_create'; sessionId: string }
  | { outcome: 'responded'; kind: 'initial_prompt' | 'task_delivery' | 'peer_delivery'; accepted: true }
  | { outcome: 'responded'; kind: 'session_observe'; sessionId: string | null;
    observedInitialMessageId: string | null }
  | { outcome: 'responded'; kind: 'delivery_observe'; observedUserMessageId: string | null }
  | { outcome: 'responded'; kind: 'reply_observe'; reply: Readonly<{
    assistantMessageId: string; parentUserMessageId: string; text: string
  }> | null }
  | { outcome: 'already_claimed' | 'claim_conflict' | 'uncertain' | 'unavailable'; reason?: string }
>

/** All fields come from root-verifiable Product/launcher state, never the Owner request. */
export type RootOpenCodeCanonicalAction = Readonly<{
  attemptId: string
  containerHandle: string
  containerGeneration: string
  model: string
  promptSha256: string
  sessionId: string | null
  messageId: string | null
  sourceRef: string | null
  text: string | null
}>

export type RootOpenCodeHttpRequest = Readonly<{
  method: 'GET' | 'POST'
  path: string
  body: string | null
  contentSha256: string
}>

export interface RootOpenCodeCanonicalSource {
  resolve(action: RootOpenCodeAction, current: HostedProductCurrentMember): RootOpenCodeCanonicalAction
}

export interface RootOpenCodeDecision {
  withCurrentMemberDecision<T>(binding: HostedProductMemberBinding, kind: 'start' | 'observe',
    callback: (current: HostedProductCurrentMember) => T): Promise<T>
}

/** Root-owned durable claim; publication and fsync complete before emitSync returns. */
export interface RootOpenCodeWriteClaims {
  claim(operationId: string, fingerprint: string): 'created' | 'already_claimed' | 'claim_conflict'
}

/** Root-owned connection. prepare attests the exact container and keeps Basic credentials private. */
export interface RootOpenCodeHttpWire {
  prepare(handle: string, generation: string): Promise<{
    emitSync(request: RootOpenCodeHttpRequest): void
    response: Promise<{ statusCode: number; body: unknown }>
    close(): void | Promise<void>
  }>
}

function sha(value: string): string { return createHash('sha256').update(value).digest('hex') }
function exact(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...fields].sort().join(',')
}

export function validateRootOpenCodeAction(value: unknown): RootOpenCodeAction {
  if (!exact(value, ['operationId', 'kind', 'runId', 'memberId', 'attemptId',
    'containerHandle', 'containerGeneration', 'sourceRef'])) throw new Error('root-opencode-action-invalid')
  const kind = value.kind
  const delivery = kind === 'task_delivery' || kind === 'peer_delivery' ||
    kind === 'delivery_observe' || kind === 'reply_observe'
  if (typeof kind !== 'string' || !['session_create', 'initial_prompt', 'session_observe', 'task_delivery',
    'peer_delivery', 'delivery_observe', 'reply_observe'].includes(kind) ||
    typeof value.operationId !== 'string' || !ID.test(value.operationId) ||
    typeof value.runId !== 'string' || !RUN.test(value.runId) ||
    typeof value.memberId !== 'string' || !MEMBER.test(value.memberId) ||
    typeof value.attemptId !== 'string' || !ATTEMPT.test(value.attemptId) ||
    typeof value.containerHandle !== 'string' || !HANDLE.test(value.containerHandle) ||
    typeof value.containerGeneration !== 'string' || !GENERATION.test(value.containerGeneration) ||
    (delivery ? typeof value.sourceRef !== 'string' || !SOURCE.test(value.sourceRef) ||
      kind === 'task_delivery' && !value.sourceRef.startsWith('task_') ||
      kind === 'peer_delivery' && !value.sourceRef.startsWith('message_') : value.sourceRef !== null)) {
    throw new Error('root-opencode-action-invalid')
  }
  return Object.freeze({ ...value }) as RootOpenCodeAction
}

function route(action: RootOpenCodeAction, canonical: RootOpenCodeCanonicalAction): RootOpenCodeHttpRequest {
  if (!exact(canonical, ['attemptId', 'containerHandle', 'containerGeneration', 'model',
    'promptSha256', 'sessionId', 'messageId', 'sourceRef', 'text']) ||
    canonical.attemptId !== action.attemptId || canonical.containerHandle !== action.containerHandle ||
    canonical.containerGeneration !== action.containerGeneration || canonical.sourceRef !== action.sourceRef ||
    typeof canonical.promptSha256 !== 'string' || !SHA.test(canonical.promptSha256) ||
    typeof canonical.model !== 'string' || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._:/\[\]-]+$/.test(canonical.model)) {
    throw new Error('root-opencode-canonical-action-invalid')
  }
  const session = canonical.sessionId
  const message = canonical.messageId
  const title = `hosted-member-attempt:${action.attemptId}`
  let method: 'GET' | 'POST' = 'GET'
  let path: string
  let body: string | null = null
  if (action.kind === 'session_create') {
    if (session !== null || message !== null || canonical.text !== null) throw new Error('root-opencode-canonical-action-invalid')
    method = 'POST'; path = '/session'; body = JSON.stringify({ title })
  } else if (action.kind === 'session_observe') {
    if (canonical.text !== null) throw new Error('root-opencode-canonical-action-invalid')
    path = session === null && message === null
      ? `/session?search=${encodeURIComponent(title)}&limit=101`
      : typeof session === 'string' && SESSION.test(session) &&
        typeof message === 'string' && MESSAGE.test(message)
        ? `/session/${session}/message/${message}`
        : (() => { throw new Error('root-opencode-canonical-action-invalid') })()
  } else if (action.kind === 'reply_observe') {
    if (typeof session !== 'string' || !SESSION.test(session) ||
      typeof message !== 'string' || !MESSAGE.test(message) ||
      typeof canonical.text !== 'string' || !canonical.text.trim() ||
      Buffer.byteLength(canonical.text) > MAX_TEXT) {
      throw new Error('root-opencode-canonical-action-invalid')
    }
    path = `/session/${session}/message?limit=100`
  } else if (action.kind === 'delivery_observe') {
    if (typeof session !== 'string' || !SESSION.test(session) ||
      typeof message !== 'string' || !MESSAGE.test(message) ||
      typeof canonical.text !== 'string' || !canonical.text.trim() ||
      Buffer.byteLength(canonical.text) > MAX_TEXT) {
      throw new Error('root-opencode-canonical-action-invalid')
    }
    path = `/session/${session}/message/${message}`
  } else {
    if (typeof session !== 'string' || !SESSION.test(session) ||
      typeof message !== 'string' || !MESSAGE.test(message) ||
      typeof canonical.text !== 'string' || !canonical.text.trim() ||
      Buffer.byteLength(canonical.text) > MAX_TEXT ||
      (action.kind === 'initial_prompt' && sha(canonical.text) !== canonical.promptSha256)) {
      throw new Error('root-opencode-canonical-action-invalid')
    }
    const slash = canonical.model.indexOf('/')
    method = 'POST'; path = `/session/${session}/prompt_async`
    body = JSON.stringify({ messageID: message, model: {
      providerID: canonical.model.slice(0, slash), modelID: canonical.model.slice(slash + 1),
    }, parts: [{ type: 'text', text: canonical.text }] })
  }
  return Object.freeze({ method, path, body, contentSha256: sha(body ?? '') })
}

function message(value: unknown): { info: Record<string, unknown>; parts: Record<string, unknown>[] } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as Record<string, unknown>
  if (!candidate.info || typeof candidate.info !== 'object' || Array.isArray(candidate.info) ||
    !Array.isArray(candidate.parts) || !candidate.parts.every(part =>
      !!part && typeof part === 'object' && !Array.isArray(part))) return null
  return candidate as { info: Record<string, unknown>; parts: Record<string, unknown>[] }
}

function observedUser(value: unknown, sessionId: string, messageId: string, textHash: string): boolean {
  const found = message(value)
  return !!found && found.info.role === 'user' && found.info.sessionID === sessionId &&
    found.info.id === messageId && found.parts.length === 1 && found.parts[0]?.type === 'text' &&
    typeof found.parts[0]?.text === 'string' && sha(found.parts[0].text) === textHash
}

/** Reduces an OpenCode response to an exact, small receipt before it reaches the 4096-byte RPC frame. */
function typedResult(action: RootOpenCodeAction, canonical: RootOpenCodeCanonicalAction,
  statusCode: number, body: unknown): RootOpenCodeActionResult {
  if (!Number.isSafeInteger(statusCode) || statusCode < 100 || statusCode > 599) {
    return { outcome: 'uncertain', reason: 'invalid-status' }
  }
  if (statusCode < 200 || statusCode >= 300) {
    if (statusCode !== 404 || action.kind === 'session_create' || action.kind === 'initial_prompt' ||
      action.kind === 'task_delivery' || action.kind === 'peer_delivery') {
      return { outcome: 'uncertain', reason: 'http-status' }
    }
  }
  if (action.kind === 'session_create') {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return { outcome: 'uncertain', reason: 'session-create-invalid' }
    }
    const created = body as Record<string, unknown>
    return typeof created.id === 'string' && SESSION.test(created.id) &&
      created.title === `hosted-member-attempt:${action.attemptId}`
      ? { outcome: 'responded', kind: action.kind, sessionId: created.id as string }
      : { outcome: 'uncertain', reason: 'session-create-invalid' }
  }
  if (action.kind === 'initial_prompt' || action.kind === 'task_delivery' || action.kind === 'peer_delivery') {
    return { outcome: 'responded', kind: action.kind, accepted: true }
  }
  const sessionId = canonical.sessionId
  const messageId = canonical.messageId
  if (action.kind === 'session_observe') {
    if (sessionId === null && messageId === null) {
      if (!Array.isArray(body) || body.length > 100) return { outcome: 'uncertain', reason: 'session-list-invalid' }
      const titled = body.filter(item => !!item && typeof item === 'object' && !Array.isArray(item) &&
        (item as Record<string, unknown>).title === `hosted-member-attempt:${action.attemptId}`)
      if (titled.some(item => typeof (item as Record<string, unknown>).id !== 'string' ||
        !SESSION.test((item as { id: string }).id))) {
        return { outcome: 'uncertain', reason: 'session-list-invalid' }
      }
      const matches = titled
      if (matches.length > 1) return { outcome: 'unavailable', reason: 'session-ambiguous' }
      return { outcome: 'responded', kind: action.kind,
        sessionId: matches.length ? (matches[0] as { id: string }).id : null,
        observedInitialMessageId: null }
    }
    if (!sessionId || !messageId) return { outcome: 'uncertain', reason: 'session-binding-invalid' }
    return { outcome: 'responded', kind: action.kind, sessionId,
      observedInitialMessageId: statusCode === 404 ||
        !observedUser(body, sessionId, messageId, canonical.promptSha256) ? null : messageId }
  }
  if (!sessionId || !messageId || typeof canonical.text !== 'string') {
    return { outcome: 'uncertain', reason: 'delivery-binding-invalid' }
  }
  const deliveryText = canonical.text
  if (action.kind === 'delivery_observe') {
    return { outcome: 'responded', kind: action.kind,
      observedUserMessageId: statusCode === 404 ||
        !observedUser(body, sessionId, messageId, sha(deliveryText)) ? null : messageId }
  }
  if (!Array.isArray(body) || body.length > 100) return { outcome: 'uncertain', reason: 'reply-list-invalid' }
  if (!body.some(item => observedUser(item, sessionId, messageId, sha(deliveryText)))) {
    return { outcome: 'responded', kind: 'reply_observe', reply: null }
  }
  const candidates = body.map(message).filter((item): item is NonNullable<typeof item> => !!item &&
    item.info.role === 'assistant' && item.info.sessionID === sessionId &&
    item.info.parentID === messageId && typeof item.info.id === 'string' &&
    MESSAGE.test(item.info.id) &&
    typeof item.info.finish === 'string' && !['tool-calls', 'unknown', 'content-filter']
      .includes(item.info.finish) && !item.info.error &&
    !!item.info.time && typeof item.info.time === 'object' &&
    typeof (item.info.time as Record<string, unknown>).completed === 'number' &&
    (item.info.time as { completed: number }).completed > 0 &&
    !item.parts.some(part => part.type === 'tool'))
  if (candidates.length > 1) return { outcome: 'unavailable', reason: 'reply-ambiguous' }
  if (candidates.length === 0) return { outcome: 'responded', kind: 'reply_observe', reply: null }
  const candidate = candidates[0]!
  const text = candidate.parts.filter(part => part.type === 'text' && typeof part.text === 'string')
    .map(part => part.text as string).join('\n')
  if (!text.trim()) return { outcome: 'responded', kind: 'reply_observe', reply: null }
  if (Buffer.byteLength(text, 'utf8') > 2048) {
    return { outcome: 'unavailable', reason: 'reply-too-large-for-rpc' }
  }
  return { outcome: 'responded', kind: 'reply_observe', reply: {
    assistantMessageId: candidate.info.id as string, parentUserMessageId: messageId, text,
  } }
}

/** The default is closed. Composition needs a root-verified source, Product fence, durable claims, and root wire. */
export class RootOpenCodeHttpProxy {
  constructor(private readonly options: {
    binding?: HostedProductMemberBinding
    decision?: RootOpenCodeDecision
    source?: RootOpenCodeCanonicalSource
    claims?: RootOpenCodeWriteClaims
    wire?: RootOpenCodeHttpWire
  } = {}) {}

  async dispatch(input: RootOpenCodeAction): Promise<RootOpenCodeActionResult> {
    const action = validateRootOpenCodeAction(input)
    const { binding, decision, source, claims, wire } = this.options
    if (!binding || !decision || !source || !claims || !wire) {
      throw new Error('root-opencode-http-proxy-inactive')
    }
    if (action.runId !== binding.runId || action.memberId !== binding.memberId) {
      throw new Error('root-opencode-member-binding-invalid')
    }
    const resolve = (current: HostedProductCurrentMember) => {
      if (current.runId !== action.runId || current.memberId !== action.memberId ||
        typeof current.model !== 'string' || !SHA.test(current.promptSha256)) {
        throw new Error('root-opencode-product-member-invalid')
      }
      const canonical = source.resolve(action, current)
      if (canonical.model !== current.model || canonical.promptSha256 !== current.promptSha256) {
        throw new Error('root-opencode-product-source-mismatch')
      }
      return { canonical, request: route(action, canonical) }
    }
    const expected = await decision.withCurrentMemberDecision(binding, 'observe', resolve)
    const connection = await wire.prepare(action.containerHandle, action.containerGeneration)
    void connection.response.catch(() => undefined)
    try {
      const result = await decision.withCurrentMemberDecision(binding,
        expected.request.method === 'POST' ? 'start' : 'observe', current => {
          const actual = resolve(current)
          if (JSON.stringify(actual) !== JSON.stringify(expected)) {
            throw new Error('root-opencode-action-changed')
          }
          if (actual.request.method === 'POST') {
            const claimId = `opencode_${sha(JSON.stringify([action.kind, action.attemptId,
              action.sourceRef])).slice(0, 64)}`
            const fingerprint = sha(JSON.stringify([action, actual.request]))
            const claim = claims.claim(claimId, fingerprint)
            if (claim !== 'created') return claim
          }
          connection.emitSync(actual.request)
          return 'issued'
        })
      if (result !== 'issued') return { outcome: result }
      const response = await connection.response
      if (Buffer.byteLength(JSON.stringify(response.body ?? null)) > 96 * 1024) {
        return { outcome: 'uncertain', reason: 'invalid-response' }
      }
      const receipt = typedResult(action, expected.canonical, response.statusCode, response.body)
      return Buffer.byteLength(JSON.stringify(receipt)) <= MAX_RPC_RESULT_JSON_BYTES
        ? receipt : { outcome: 'unavailable', reason: 'reply-too-large-for-rpc' }
    } catch {
      return { outcome: 'uncertain', reason: 'dispatch-failed' }
    } finally { await connection.close() }
  }
}
