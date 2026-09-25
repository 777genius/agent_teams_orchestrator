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
  | { outcome: 'responded'; statusCode: number; body: unknown }
  | { outcome: 'already_claimed' | 'claim_conflict' | 'uncertain'; reason?: string }
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
    close(): void
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
  if (!['session_create', 'initial_prompt', 'session_observe', 'task_delivery',
    'peer_delivery', 'delivery_observe', 'reply_observe'].includes(String(kind)) ||
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
      : SESSION.test(String(session)) && MESSAGE.test(String(message))
        ? `/session/${session}/message/${message}`
        : (() => { throw new Error('root-opencode-canonical-action-invalid') })()
  } else if (action.kind === 'reply_observe') {
    if (!SESSION.test(String(session)) || !MESSAGE.test(String(message)) || canonical.text !== null) {
      throw new Error('root-opencode-canonical-action-invalid')
    }
    path = `/session/${session}/message?limit=100`
  } else if (action.kind === 'delivery_observe') {
    if (!SESSION.test(String(session)) || !MESSAGE.test(String(message)) || canonical.text !== null) {
      throw new Error('root-opencode-canonical-action-invalid')
    }
    path = `/session/${session}/message/${message}`
  } else {
    if (!SESSION.test(String(session)) || !MESSAGE.test(String(message)) ||
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
      return route(action, canonical)
    }
    const expected = await decision.withCurrentMemberDecision(binding, 'observe', resolve)
    const connection = await wire.prepare(action.containerHandle, action.containerGeneration)
    void connection.response.catch(() => undefined)
    try {
      const result = await decision.withCurrentMemberDecision(binding,
        expected.method === 'POST' ? 'start' : 'observe', current => {
          const actual = resolve(current)
          if (JSON.stringify(actual) !== JSON.stringify(expected)) {
            throw new Error('root-opencode-action-changed')
          }
          if (actual.method === 'POST') {
            const claimId = `opencode_${sha(JSON.stringify([action.kind, action.attemptId,
              action.sourceRef])).slice(0, 64)}`
            const fingerprint = sha(JSON.stringify([action, actual]))
            const claim = claims.claim(claimId, fingerprint)
            if (claim !== 'created') return claim
          }
          connection.emitSync(actual)
          return 'issued'
        })
      if (result !== 'issued') return { outcome: result }
      const response = await connection.response
      if (!Number.isSafeInteger(response.statusCode) || response.statusCode < 100 ||
        response.statusCode > 599 || Buffer.byteLength(JSON.stringify(response.body ?? null)) > 96 * 1024) {
        return { outcome: 'uncertain', reason: 'invalid-response' }
      }
      if (expected.method === 'POST' && (response.statusCode < 200 || response.statusCode >= 300)) {
        return { outcome: 'uncertain', reason: `http-status-${response.statusCode}` }
      }
      return { outcome: 'responded', statusCode: response.statusCode, body: response.body }
    } catch {
      return { outcome: 'uncertain', reason: 'dispatch-failed' }
    } finally { connection.close() }
  }
}
