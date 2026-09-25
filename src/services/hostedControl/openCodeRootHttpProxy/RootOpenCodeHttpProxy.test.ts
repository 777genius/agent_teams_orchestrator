import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'

import type { HostedProductCurrentMember, HostedProductMemberBinding } from
  '../productAuthority/HostedProductCurrentMemberDecision.js'
import { RootOpenCodeHttpProxy, type RootOpenCodeAction, type RootOpenCodeCanonicalAction,
  type RootOpenCodeCommittedDelivery, type RootOpenCodeHttpRequest } from './RootOpenCodeHttpProxy.js'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const action: RootOpenCodeAction = {
  operationId: 'operation_12345678', kind: 'session_create', runId: `run_${'a'.repeat(32)}`,
  memberId: `member_${'b'.repeat(32)}`, attemptId: `member_attempt_${'c'.repeat(64)}`,
  containerHandle: `opencode_${'d'.repeat(32)}`, containerGeneration: 'e'.repeat(32), sourceRef: null,
}
const binding = { runId: action.runId, memberId: action.memberId } as HostedProductMemberBinding
const current = { ...binding, model: 'openai/gpt-5', promptSha256: hash('canonical prompt') } as HostedProductCurrentMember
const canonical: RootOpenCodeCanonicalAction = {
  attemptId: action.attemptId, containerHandle: action.containerHandle,
  containerGeneration: action.containerGeneration, model: current.model,
  promptSha256: current.promptSha256, sessionId: null, messageId: null,
  sourceRef: null, text: null,
}
const revision = `revision_${'4'.repeat(64)}`
function deliveryAction(kind: 'task_delivery' | 'peer_delivery' | 'delivery_observe' | 'reply_observe',
  sourceRef: string, version = revision): RootOpenCodeAction {
  const sourceKind = sourceRef.startsWith('task_') ? 'task' : 'peer'
  return { ...action, kind, sourceRef,
    operationId: `action_${hash(JSON.stringify([
      'hosted-product-delivery/v1', action.attemptId, sourceKind, sourceRef, version, kind,
    ]))}` }
}
function committed(action: RootOpenCodeAction, text: string, version = revision): RootOpenCodeCommittedDelivery {
  return { kind: action.sourceRef!.startsWith('task_') ? 'task' : 'peer', sourceRef: action.sourceRef!,
    revision: version, runId: action.runId, memberId: action.memberId,
    attemptId: action.attemptId, containerHandle: action.containerHandle,
    containerGeneration: action.containerGeneration, text }
}

function fixture(overrides: Partial<ConstructorParameters<typeof RootOpenCodeHttpProxy>[0]> = {}) {
  const events: string[] = []
  const writes: RootOpenCodeHttpRequest[] = []
  const claims = new Map<string, string>()
  let resolved: RootOpenCodeCanonicalAction = canonical
  let delivery: RootOpenCodeCommittedDelivery | null = null
  let response: { statusCode: number; body: unknown } = { statusCode: 201,
    body: { id: `ses${'f'.repeat(12)}`, title: `hosted-member-attempt:${action.attemptId}` } }
  const proxy = new RootOpenCodeHttpProxy({ binding,
    decision: { async withCurrentMemberDecision(_binding, _kind, callback) {
      events.push('product'); return callback(current)
    } },
    source: { resolve() { events.push('source'); return resolved } },
    deliverySource: { resolve() { events.push('product-delivery'); return delivery } },
    claims: { claim(id, fingerprint) {
      events.push('claim')
      const prior = claims.get(id)
      if (prior) return prior === fingerprint ? 'already_claimed' : 'claim_conflict'
      claims.set(id, fingerprint)
      return 'created'
    } },
    wire: { async prepare(handle, generation) {
      events.push('prepare')
      expect(handle).toBe(action.containerHandle)
      expect(generation).toBe(action.containerGeneration)
      return { emitSync(request) { events.push('write'); writes.push(request) },
        response: Promise.resolve(response), close() { events.push('close') } }
    } }, ...overrides })
  return { proxy, events, writes, claims,
    setCanonical(value: RootOpenCodeCanonicalAction) { resolved = value },
    setDelivery(value: RootOpenCodeCommittedDelivery | null) { delivery = value },
    setResponse(value: typeof response) { response = value },
  }
}

test('proxy is inert without a Product source, claim and root wire', async () => {
  await expect(new RootOpenCodeHttpProxy().dispatch(action)).rejects.toThrow('inactive')
})

test('Owner cannot add URL, method, body, or reusable Basic credential', async () => {
  const f = fixture()
  for (const field of ['url', 'method', 'body', 'password']) {
    await expect(f.proxy.dispatch({ ...action, [field]: 'http://evil.invalid' } as RootOpenCodeAction))
      .rejects.toThrow('action-invalid')
  }
  expect(f.events).toEqual([])
})

test('Product denial and missing canonical source produce zero HTTP bytes', async () => {
  const f = fixture({ decision: { async withCurrentMemberDecision() { throw new Error('revoked') } } })
  await expect(f.proxy.dispatch(action)).rejects.toThrow('revoked')
  expect(f.events).toEqual([])
  const missing = fixture({ source: { resolve() { throw new Error('missing-canonical-prompt') } } })
  await expect(missing.proxy.dispatch(action)).rejects.toThrow('missing-canonical-prompt')
  expect(missing.writes).toEqual([])
})

test('Product revocation after socket preparation makes no claim and sends no bytes', async () => {
  let decisions = 0
  const f = fixture({ decision: { async withCurrentMemberDecision(_binding, _kind, callback) {
    decisions++
    if (decisions === 2) throw new Error('revoked-before-write')
    return callback(current)
  } } })
  expect(await f.proxy.dispatch(action)).toEqual({ outcome: 'uncertain', reason: 'dispatch-failed' })
  expect(f.claims.size).toBe(0)
  expect(f.writes).toHaveLength(0)
})

test('session create uses fixed official route and claims durably before one write', async () => {
  const f = fixture()
  expect(await f.proxy.dispatch(action)).toEqual({ outcome: 'responded', kind: 'session_create',
    sessionId: `ses${'f'.repeat(12)}` })
  expect(f.writes).toEqual([{ method: 'POST', path: '/session',
    body: JSON.stringify({ title: `hosted-member-attempt:${action.attemptId}` }),
    contentSha256: hash(JSON.stringify({ title: `hosted-member-attempt:${action.attemptId}` })) }])
  expect(f.events.indexOf('claim')).toBeLessThan(f.events.indexOf('write'))
  expect(await f.proxy.dispatch(action)).toEqual({ outcome: 'already_claimed' })
  expect(await f.proxy.dispatch({ ...action, operationId: 'operation_87654321' }))
    .toEqual({ outcome: 'claim_conflict' })
  expect(f.writes).toHaveLength(1)
})

test('GET observation recovers an uncertain write without another POST', async () => {
  const f = fixture()
  f.setResponse({ statusCode: 503, body: { id: `ses${'f'.repeat(12)}` } })
  expect(await f.proxy.dispatch(action)).toEqual({ outcome: 'uncertain', reason: 'http-status' })
  const observed = { ...action, kind: 'session_observe' as const, operationId: 'observe_12345678' }
  f.setResponse({ statusCode: 200, body: [{ id: `ses${'f'.repeat(12)}`,
    title: `hosted-member-attempt:${action.attemptId}` }] })
  expect(await f.proxy.dispatch(observed)).toEqual({ outcome: 'responded', kind: 'session_observe',
    sessionId: `ses${'f'.repeat(12)}`, observedInitialMessageId: null })
  expect(f.writes.map(write => [write.method, write.path])).toEqual([
    ['POST', '/session'], ['GET', `/session?search=${encodeURIComponent(`hosted-member-attempt:${action.attemptId}`)}&limit=101`],
  ])
  expect(f.claims.size).toBe(1)
})

test('prompt text must match Product hash; delivery requires canonical text and fixed route', async () => {
  const f = fixture()
  const prompt = { ...action, kind: 'initial_prompt' as const }
  f.setCanonical({ ...canonical, sessionId: `ses${'1'.repeat(12)}`, messageId: `msg${'2'.repeat(12)}`,
    text: 'owner-controlled prompt' })
  await expect(f.proxy.dispatch(prompt)).rejects.toThrow('canonical-action-invalid')
  expect(f.writes).toHaveLength(0)
  const delivery = deliveryAction('task_delivery', 'task_12345678')
  f.setCanonical({ ...canonical, sessionId: `ses${'1'.repeat(12)}`, messageId: `msg${'2'.repeat(12)}`,
    sourceRef: delivery.sourceRef, text: 'canonical task text' })
  f.setDelivery(committed(delivery, 'canonical task text'))
  expect(await f.proxy.dispatch(delivery)).toEqual({ outcome: 'responded',
    kind: 'task_delivery', accepted: true })
  expect(f.writes[0]?.path).toBe(`/session/ses${'1'.repeat(12)}/prompt_async`)
  expect(JSON.parse(f.writes[0]?.body ?? '{}').parts).toEqual([{ type: 'text', text: 'canonical task text' }])
})

test('delivery has no effect without a root Product committed source', async () => {
  const delivery = deliveryAction('task_delivery', 'task_12345678')
  const f = fixture({ deliverySource: undefined })
  await expect(f.proxy.dispatch(delivery)).rejects.toThrow('delivery-source-inactive')
  expect(f.events).toEqual(['product'])
  expect(f.claims.size).toBe(0)
  expect(f.writes).toHaveLength(0)
})

test('forged revision or operation ID cannot claim or write a delivery', async () => {
  const delivery = deliveryAction('task_delivery', 'task_12345678')
  const f = fixture()
  f.setDelivery(committed(delivery, 'Product task'))
  f.setCanonical({ ...canonical, sourceRef: delivery.sourceRef,
    sessionId: `ses${'1'.repeat(12)}`, messageId: `msg${'2'.repeat(12)}`, text: 'Product task' })
  await expect(f.proxy.dispatch({ ...delivery, operationId: 'action_12345678' }))
    .rejects.toThrow('delivery-operation-invalid')
  const stale = deliveryAction('task_delivery', delivery.sourceRef!, `revision_${'5'.repeat(64)}`)
  await expect(f.proxy.dispatch(stale)).rejects.toThrow('delivery-operation-invalid')
  expect(f.events.includes('prepare')).toBe(false)
  expect(f.claims.size).toBe(0)
  expect(f.writes).toHaveLength(0)
})

test('swapped recipient and changed canonical text cannot claim or write', async () => {
  const delivery = deliveryAction('peer_delivery', 'message_12345678')
  const f = fixture()
  f.setDelivery({ ...committed(delivery, 'Product message'), memberId: `member_${'9'.repeat(32)}` })
  f.setCanonical({ ...canonical, sourceRef: delivery.sourceRef,
    sessionId: `ses${'1'.repeat(12)}`, messageId: `msg${'2'.repeat(12)}`, text: 'Product message' })
  await expect(f.proxy.dispatch(delivery)).rejects.toThrow('product-delivery-invalid')
  f.setDelivery(committed(delivery, 'Product message'))
  f.setCanonical({ ...canonical, sourceRef: delivery.sourceRef,
    sessionId: `ses${'1'.repeat(12)}`, messageId: `msg${'2'.repeat(12)}`, text: 'Owner changed message' })
  await expect(f.proxy.dispatch(delivery)).rejects.toThrow('product-source-mismatch')
  expect(f.events.includes('prepare')).toBe(false)
  expect(f.claims.size).toBe(0)
  expect(f.writes).toHaveLength(0)
})

test('Product model remains authoritative for initial prompt and delivery', async () => {
  const f = fixture()
  f.setCanonical({ ...canonical, model: 'attacker/other',
    sessionId: `ses${'1'.repeat(12)}`, messageId: `msg${'2'.repeat(12)}`,
    text: 'canonical prompt' })
  await expect(f.proxy.dispatch({ ...action, kind: 'initial_prompt' }))
    .rejects.toThrow('product-source-mismatch')
  expect(f.claims.size).toBe(0)
  expect(f.writes).toHaveLength(0)
})

test('Product revision change between preparation and write sends no bytes', async () => {
  const delivery = deliveryAction('task_delivery', 'task_12345678')
  let revisionReads = 0
  const source = { resolve() {
    revisionReads++
    return committed(delivery, 'Product task', revisionReads === 1
      ? revision : `revision_${'5'.repeat(64)}`)
  } }
  const guarded = fixture({ deliverySource: source })
  guarded.setCanonical({ ...canonical, sourceRef: delivery.sourceRef,
    sessionId: `ses${'1'.repeat(12)}`, messageId: `msg${'2'.repeat(12)}`,
    text: 'Product task' })
  expect(await guarded.proxy.dispatch(delivery)).toEqual({ outcome: 'uncertain', reason: 'dispatch-failed' })
  expect(guarded.claims.size).toBe(0)
  expect(guarded.writes).toHaveLength(0)
})

test('exact replay is one-shot while a new Product revision gets a new claim', async () => {
  const delivery = deliveryAction('task_delivery', 'task_12345678')
  const f = fixture()
  f.setDelivery(committed(delivery, 'Product task v1'))
  f.setCanonical({ ...canonical, sourceRef: delivery.sourceRef,
    sessionId: `ses${'1'.repeat(12)}`, messageId: `msg${'2'.repeat(12)}`, text: 'Product task v1' })
  expect(await f.proxy.dispatch(delivery)).toEqual({ outcome: 'responded',
    kind: 'task_delivery', accepted: true })
  expect(await f.proxy.dispatch(delivery)).toEqual({ outcome: 'already_claimed' })
  const updated = deliveryAction('task_delivery', delivery.sourceRef!, `revision_${'5'.repeat(64)}`)
  f.setDelivery(committed(updated, 'Product task v2', `revision_${'5'.repeat(64)}`))
  f.setCanonical({ ...canonical, sourceRef: delivery.sourceRef,
    sessionId: `ses${'1'.repeat(12)}`, messageId: `msg${'3'.repeat(12)}`, text: 'Product task v2' })
  await expect(f.proxy.dispatch(delivery)).rejects.toThrow('delivery-operation-invalid')
  expect(await f.proxy.dispatch(updated)).toEqual({ outcome: 'responded',
    kind: 'task_delivery', accepted: true })
  expect(f.claims.size).toBe(2)
  expect(f.writes).toHaveLength(2)
})

test('large OpenCode list is reduced to a bounded typed session receipt', async () => {
  const f = fixture()
  f.setResponse({ statusCode: 200, body: [{ id: `ses${'f'.repeat(12)}`,
    title: `hosted-member-attempt:${action.attemptId}`, unrelated: 'x'.repeat(12_000) }] })
  const result = await f.proxy.dispatch({ ...action, kind: 'session_observe' })
  expect(result).toEqual({ outcome: 'responded', kind: 'session_observe',
    sessionId: `ses${'f'.repeat(12)}`, observedInitialMessageId: null })
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(512)
})

test('nested array IDs from OpenCode are rejected before casting to typed receipts', async () => {
  const f = fixture()
  let nested: unknown = `ses${'f'.repeat(12)}`
  for (let index = 0; index < 2000; index++) nested = [nested]
  f.setResponse({ statusCode: 201, body: { id: nested,
    title: `hosted-member-attempt:${action.attemptId}` } })
  expect(await f.proxy.dispatch(action)).toEqual({ outcome: 'uncertain', reason: 'session-create-invalid' })
  const observed = { ...action, kind: 'session_observe' as const }
  f.setResponse({ statusCode: 200, body: [{ id: nested,
    title: `hosted-member-attempt:${action.attemptId}` }] })
  expect(await f.proxy.dispatch(observed)).toEqual({ outcome: 'uncertain', reason: 'session-list-invalid' })
})

test('oversized assistant reply returns a bounded unavailable receipt instead of breaking RPC framing', async () => {
  const f = fixture()
  const sessionId = `ses${'1'.repeat(12)}`
  const messageId = `msg${'2'.repeat(12)}`
  const delivery = deliveryAction('reply_observe', 'message_12345678')
  f.setCanonical({ ...canonical, sessionId, messageId, sourceRef: delivery.sourceRef,
    text: 'canonical delivery' })
  f.setDelivery(committed(delivery, 'canonical delivery'))
  f.setResponse({ statusCode: 200, body: [
    { info: { role: 'user', sessionID: sessionId, id: messageId },
      parts: [{ type: 'text', text: 'canonical delivery' }] },
    { info: { role: 'assistant', sessionID: sessionId, id: `msg${'3'.repeat(12)}`,
      parentID: messageId, finish: 'stop', time: { completed: 123 } },
      parts: [{ type: 'text', text: 'r'.repeat(8_000) }] },
  ] })
  const result = await f.proxy.dispatch(delivery)
  expect(result).toEqual({ outcome: 'unavailable', reason: 'reply-too-large-for-rpc' })
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(512)
  f.setResponse({ statusCode: 200, body: [
    { info: { role: 'user', sessionID: sessionId, id: messageId },
      parts: [{ type: 'text', text: 'canonical delivery' }] },
    { info: { role: 'assistant', sessionID: sessionId, id: `msg${'3'.repeat(12)}`,
      parentID: messageId, finish: 'stop', time: { completed: 123 } },
      parts: [{ type: 'text', text: 'r'.repeat(2048) }] },
  ] })
  const bounded = await f.proxy.dispatch(delivery)
  expect(bounded.outcome).toBe('responded')
  const signedEnvelope = { schemaVersion: 1, challenge: 'a'.repeat(64), nonce: 'b'.repeat(64),
    operation: 'sessionAction', ok: true, result: bounded, proof: 'c'.repeat(64) }
  expect(Buffer.byteLength(JSON.stringify(signedEnvelope))).toBeLessThan(4096)
  for (const escaped of ['\\'.repeat(2048), '"'.repeat(2048), '\u0000'.repeat(2048)]) {
    f.setResponse({ statusCode: 200, body: [
      { info: { role: 'user', sessionID: sessionId, id: messageId },
        parts: [{ type: 'text', text: 'canonical delivery' }] },
      { info: { role: 'assistant', sessionID: sessionId, id: `msg${'3'.repeat(12)}`,
        parentID: messageId, finish: 'stop', time: { completed: 123 } },
        parts: [{ type: 'text', text: escaped }] },
    ] })
    const escapedResult = await f.proxy.dispatch(delivery)
    expect(escapedResult).toEqual({ outcome: 'unavailable', reason: 'reply-too-large-for-rpc' })
    expect(Buffer.byteLength(JSON.stringify({ ...signedEnvelope, result: escapedResult }))).toBeLessThan(4096)
  }
})
