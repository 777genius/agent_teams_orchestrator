import { expect, test } from 'bun:test'
import { OpenCodeTurnSettledObserver } from './OpenCodeTurnSettledObserver.js'
import { OpenCodeTurnSettledEmissionCoordinator } from './OpenCodeTurnSettledEmissionCoordinator.js'
import { nativeTerminalFacts } from './OpenCodeV1TerminalFacts.test-support.js'
import type { OpenCodeMessage, OpenCodeSessionRecord } from './types.js'
import type { OpenCodeRuntimeTurnSettledEvent } from './OpenCodeRuntimeTurnSettledEmitter.js'

function retainedRecord(sessionId: string): OpenCodeSessionRecord {
  return {
    teamId: 'TEST-team', memberName: 'alice', laneId: 'lane-1', providerId: 'opencode',
    selectedModel: 'test-model/terminal-catalog', projectPath: '/tmp/TEST-project',
    profileRootKey: 'TEST-profile', hostKey: 'TEST-host', opencodeSessionId: sessionId,
    lastCanonicalCursor: null, lastKnownRawStatus: null, lastKnownDurableState: 'unknown',
    sourceAuthFingerprint: 'source', managedAuthFingerprint: 'managed', projectBehaviorFingerprint: 'behavior',
    resolvedBehaviorFingerprint: 'resolved', staleReason: null, createdAt: '2026-10-07T00:00:00Z', updatedAt: '2026-10-07T00:00:00Z',
  }
}
function controlledObservation(sessionId: string, promptId: string, initial: OpenCodeMessage[] | unknown, interaction: unknown[] = [], signal?: AbortSignal) {
  let transcript = initial
  let reads = 0
  let send!: (type: string, properties: object) => void
  const response = new Response(new ReadableStream<Uint8Array>({ start(controller) {
    send = (type, properties) => { try { controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, properties })}\n\n`)) } catch { /* Native source has been cancelled by the observer. */ } }
  } }), { headers: { 'content-type': 'text/event-stream' } })
  const observer = new OpenCodeTurnSettledObserver({ fetchImpl: async (input, init) => {
    if (init?.signal?.aborted) throw new Error('read after abort')
    if (String(input).endsWith('/event')) return response
    reads += 1
    return Response.json(String(input).endsWith('/permission') || String(input).endsWith('/question') ? interaction : transcript)
  } })
  const observation = observer.observe({ signal, authority: retainedRecord(sessionId), baseUrl: 'http://TEST-loopback', sessionId, runtimePromptMessageId: promptId, timeoutMs: 100, idleTimeoutMs: 10 })
  observation.markPromptSubmitting()
  observation.markPromptAcceptedByEndpoint()
  return { observation, send, reads: () => reads, replace: (messages: unknown) => { transcript = messages } }
}
const tick = () => new Promise(resolve => setTimeout(resolve, 20))

// Regression: idle/partial text/tool error previously emitted success or error before native completion.
for (const fact of nativeTerminalFacts) test(`${fact.version} ${fact.mode}: progress has zero Stop; qualified final emits once`, async () => {
  const runtime = controlledObservation(fact.sessionId, fact.promptId, fact.partial)
  const events: OpenCodeRuntimeTurnSettledEvent[] = []
  const coordinator = new OpenCodeTurnSettledEmissionCoordinator({ emitter: { emit: async event => { events.push(event) } } })
  const record = retainedRecord(fact.sessionId)
  await coordinator.emitDelivery({ record, runtimePromptMessageId: fact.promptId, responseObservation: {
    state: fact.mode === 'tool' ? 'tool_error' : 'responded_plain_text', deliveredUserMessageId: fact.promptId,
    assistantMessageId: 'progress', toolCallNames: [], visibleMessageToolCallId: null, visibleReplyMessageId: null,
    visibleReplyCorrelation: null, latestAssistantPreview: 'partial', reason: 'native progress',
  } })
  expect(events).toEqual([])
  let resolved = false
  const pending = runtime.observation.waitForSettled().then(summary => { resolved = true; return summary })
  runtime.send('message.part.delta', { sessionID: fact.sessionId, messageID: fact.partial.at(-1)?.info.id, delta: 'partial' })
  runtime.send('session.status', { sessionID: fact.sessionId, status: { type: 'idle' } })
  await tick()
  expect(resolved).toBe(false)
  expect(events).toEqual([])
  runtime.replace(fact.final)
  runtime.send('message.updated', { info: { sessionID: fact.sessionId, id: fact.final.at(-1)?.info.id, role: 'assistant' } })
  const summary = await pending
  expect(summary.outcome).toBe(fact.mode === 'abort' ? 'error' : 'success')
  expect(summary.terminalProof?.assistantMessageId).toBe(fact.final.at(-1)?.info.id as string)
  await coordinator.emitDelivery({ record, runtimePromptMessageId: fact.promptId, turnSettled: summary })
  expect(events).toHaveLength(1)
  expect(events[0]?.schemaVersion).toBe(1)
  expect(events[0]?.runtimePromptMessageId).toBe(fact.promptId)
  expect(events[0]?.outcome).toBe(fact.mode === 'abort' ? 'error' : 'success')
  await coordinator.emitDelivery({ record, runtimePromptMessageId: fact.promptId, turnSettled: summary })
  expect(events).toHaveLength(1)
  const reads = runtime.reads()
  runtime.send('session.idle', { sessionID: fact.sessionId })
  runtime.observation.dispose()
  await tick()
  expect(runtime.reads()).toBe(reads)
  // Independent emitter makes these identity vetoes observable before any deduplication.
  const foreignEvents: OpenCodeRuntimeTurnSettledEvent[] = []
  const guard = new OpenCodeTurnSettledEmissionCoordinator({ emitter: { emit: async event => { foreignEvents.push(event) } } })
  await guard.emitDelivery({ record: retainedRecord('foreign-session'), runtimePromptMessageId: fact.promptId, turnSettled: summary })
  await guard.emitDelivery({ record, runtimePromptMessageId: 'foreign-prompt', turnSettled: summary })
  await guard.emitDelivery({ record: { ...record, hostKey: 'foreign-host' }, runtimePromptMessageId: fact.promptId, turnSettled: summary })
  await guard.emitDelivery({ record, runtimePromptMessageId: fact.promptId, turnSettled: {
    ...summary, terminalProof: { ...summary.terminalProof!, evidence: { ...summary.terminalProof!.evidence, complete: false } },
  } })
  expect(foreignEvents).toEqual([])
  expect(events).toHaveLength(1)
})

// Regression: any assistant after the prompt, truncated lists, malformed IDs and unknown states were accepted.
const fact = nativeTerminalFacts[0]!
const invalid: Array<[string, (messages: OpenCodeMessage[]) => unknown]> = [
  ['missing transcript', () => null],
  ['missing anchor', messages => messages.slice(1)],
  ['at requested limit', messages => Array.from({ length: 50 }, () => messages[0])],
  ['duplicate IDs', messages => [...messages, messages[1]]],
  ['foreign session', messages => { messages[1]!.info.sessionID = 'foreign'; return messages }],
  ['foreign parent', messages => { messages[1]!.info.parentID = 'foreign'; return messages }],
  ['foreign user boundary', messages => [messages[0], { info: { id: 'next-user', role: 'user', sessionID: fact.sessionId, time: { created: (messages[0]!.info.time as { created: number }).created + 1 } }, parts: [] }, messages[1]]],
  ['invalid completion', messages => { messages[1]!.info.time = { created: 100, completed: 99 }; return messages }],
  ['unmeasured finish', messages => { messages[1]!.info.finish = 'length'; return messages }],
  ['malformed error', messages => { messages[1]!.info.error = {}; return messages }],
  ['conflicting parent', messages => { messages[1]!.info.parentId = 'foreign'; return messages }],
  ['unmeasured error', messages => { messages[1]!.info.error = { name: 'APIError', message: 'unqualified' }; return messages }],
  ['unknown tool', messages => { messages[1]!.parts.push({ id: 'prt_TEST_unknown', sessionID: fact.sessionId, messageID: messages[1]!.info.id as string, type: 'tool', callID: 'c', tool: 'read', state: { status: 'mystery' } }); return messages }],
  ['step finish alone', messages => { messages[1]!.info.finish = null; messages[1]!.parts.push({ id: 'prt_TEST_step', sessionID: fact.sessionId, messageID: messages[1]!.info.id as string, type: 'step-finish', reason: 'stop' }); return messages }],
]
for (const [name, corrupt] of invalid) test(`reject ${name}`, async () => {
  const runtime = controlledObservation(fact.sessionId, fact.promptId, corrupt(structuredClone(fact.final)))
  const summary = await runtime.observation.waitForSettled()
  expect(summary.terminalProof).toBeUndefined()
  expect(summary.outcome).not.toBe('success')
  const events: OpenCodeRuntimeTurnSettledEvent[] = []
  await new OpenCodeTurnSettledEmissionCoordinator({ emitter: { emit: async event => { events.push(event) } } }).emitDelivery({ record: retainedRecord(fact.sessionId), runtimePromptMessageId: fact.promptId, turnSettled: summary })
  expect(events).toEqual([])
  runtime.observation.dispose()
})

// Regression: session errors gained synthetic prompt attribution; readiness manufactured execution.
test('session-only error and silent bootstrap emit zero execution Stop', async () => {
  const runtime = controlledObservation(fact.sessionId, fact.promptId, [])
  runtime.send('session.error', { sessionID: fact.sessionId, error: { name: 'MessageAbortedError' } })
  const summary = await runtime.observation.waitForSettled()
  expect(summary.terminalProof).toBeUndefined()
  const events: OpenCodeRuntimeTurnSettledEvent[] = []
  const coordinator = new OpenCodeTurnSettledEmissionCoordinator({ emitter: { emit: async event => { events.push(event) } } })
  await coordinator.emitDelivery({ record: retainedRecord(fact.sessionId), turnSettled: summary })
  await coordinator.emitLaunch({ record: retainedRecord(fact.sessionId), runtimePromptMessageId: fact.promptId })
  expect(events).toEqual([])
  runtime.observation.dispose()
})

// Regression: completed messages could settle while a permission/question remained pending.
test('pending interaction and disposal veto terminal reads', async () => {
  const runtime = controlledObservation(fact.sessionId, fact.promptId, fact.final, [{ sessionID: fact.sessionId, id: 'question-1' }])
  const summary = await runtime.observation.waitForSettled()
  expect(summary.terminalProof).toBeUndefined()
  runtime.observation.dispose()
  const reads = runtime.reads()
  runtime.send('session.idle', { sessionID: fact.sessionId })
  await tick()
  expect(runtime.reads()).toBe(reads)
})

// Regression: a genuine native interruption must qualify without text or an invented finish.
test('native aborted assistant without visible text remains a qualified error', async () => {
  const aborted = nativeTerminalFacts.find(item => item.mode === 'abort')!
  const messages = structuredClone(aborted.final)
  messages.at(-1)!.parts = []
  const runtime = controlledObservation(aborted.sessionId, aborted.promptId, messages)
  const summary = await runtime.observation.waitForSettled()
  expect(summary.outcome).toBe('error')
  expect(summary.terminalProof?.assistantMessageId).toBe(messages.at(-1)!.info.id as string)
  const events: OpenCodeRuntimeTurnSettledEvent[] = []
  const coordinator = new OpenCodeTurnSettledEmissionCoordinator({ emitter: { emit: async event => { events.push(event) } } })
  const record = { ...retainedRecord(aborted.sessionId), bootstrapMode: 'model_tool_checkin' as const, bootstrapRuntimePromptMessageId: aborted.promptId }
  await coordinator.emitLaunch({ record, runtimePromptMessageId: 'assigned-task' })
  expect(events).toEqual([])
  await coordinator.emitLaunch({ record, runtimePromptMessageId: aborted.promptId, reconcileSummary: {
    terminalEvidence: summary.terminalProof!.evidence, sessionId: aborted.sessionId, reconcileOutcome: 'reconciled', rawStatus: 'idle', durableState: 'error', staleReason: null,
    profileAuthState: 'ok', pendingPermissionRequestIds: [], messageCount: 2, toolCallCount: 0, errorCount: 1,
    lastCanonicalCursor: null, latestUserMessageId: aborted.promptId, latestAssistantMessageId: messages.at(-1)!.info.id as string,
    latestAssistantText: null, latestAssistantPreview: null, replyPendingSinceMessageId: null,
    messages: summary.terminalProof!.evidence.messages, diagnostics: [],
  } })
  expect(events).toHaveLength(1)
  expect(events[0]?.outcome).toBe('error')
  runtime.observation.dispose()
})

// Regression: timeout/disposal must abort one bounded read rather than starting another observer.
test('operation abort cancels observation and prevents later reads', async () => {
  const controller = new AbortController()
  controller.abort()
  const runtime = controlledObservation(fact.sessionId, fact.promptId, fact.final, [], controller.signal)
  expect((await runtime.observation.waitForSettled()).outcome).toBe('unknown')
  await tick()
  expect(runtime.reads()).toBe(0)
  runtime.observation.dispose()
})

// Regression: changing a captured user window while interaction lists are read cannot qualify.
test('changing native transcript during reconciliation stays unknown', async () => {
  let messageReads = 0
  const stream = new Response(new ReadableStream<Uint8Array>({ start() {} }), { headers: { 'content-type': 'text/event-stream' } })
  const observer = new OpenCodeTurnSettledObserver({ fetchImpl: async input => {
    if (String(input).endsWith('/event')) return stream
    if (!String(input).includes('/message?')) return Response.json([])
    messageReads += 1
    return Response.json(messageReads % 2 ? fact.final : fact.partial)
  } })
  const observation = observer.observe({ baseUrl: 'http://TEST-loopback', sessionId: fact.sessionId, runtimePromptMessageId: fact.promptId, timeoutMs: 40, idleTimeoutMs: 5 })
  observation.markPromptSubmitting()
  observation.markPromptAcceptedByEndpoint()
  const summary = await observation.waitForSettled()
  expect(summary.terminalProof).toBeUndefined()
  expect(summary.diagnostics).toContain('Native user window changed during reconciliation')
  observation.dispose()
})
