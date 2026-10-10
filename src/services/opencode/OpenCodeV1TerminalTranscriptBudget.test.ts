import { expect, test } from 'bun:test'
import { OpenCodeClientFactory } from './OpenCodeClientFactory.js'
import { readOpenCodeBoundedHttpResponse } from './OpenCodeBoundedHttpResponse.js'
import { readOpenCodeV1TerminalTranscript } from './OpenCodeV1TerminalTranscriptReader.js'
import { qualifyOpenCodeV1TerminalProof, type OpenCodeV1TerminalEvidence } from './OpenCodeV1TerminalProof.js'
import { OpenCodeTurnSettledEmissionCoordinator } from './OpenCodeTurnSettledEmissionCoordinator.js'
import { nativeTerminalFacts } from './OpenCodeV1TerminalFacts.test-support.js'
import type { OpenCodeMessage, OpenCodeSessionRecord, OpenCodeSessionReconcileSummary } from './types.js'
import type { OpenCodeRuntimeTurnSettledEvent } from './OpenCodeRuntimeTurnSettledEmitter.js'

const fact = nativeTerminalFacts[0]!
const record: OpenCodeSessionRecord = {
  teamId: 'TEST-team', memberName: 'alice', laneId: 'TEST-lane', providerId: 'opencode', runId: 'TEST-run',
  selectedModel: 'TEST-model', projectPath: '/tmp/TEST-project', profileRootKey: 'TEST-profile', hostKey: 'TEST-host',
  opencodeSessionId: fact.sessionId, lastCanonicalCursor: null, lastKnownRawStatus: null, lastKnownDurableState: 'unknown',
  sourceAuthFingerprint: 'source', managedAuthFingerprint: 'managed', projectBehaviorFingerprint: 'behavior',
  resolvedBehaviorFingerprint: 'resolved', staleReason: null, createdAt: '2026-10-10T00:00:00Z', updatedAt: '2026-10-10T00:00:00Z',
}

// Authored coding-session scale fixture. The current terminal facts retain their
// native-derived semantics; prior turns model repeated edit before/after + LSP
// metadata. This is a transport regression input, not new native qualification.
function codingSessionPage(includeFileText = true): OpenCodeMessage[] {
  const history: OpenCodeMessage[] = []
  for (let turn = 0; turn < 24; turn++) {
    const user = `msg_TEST_old_user_${turn}`, assistant = `msg_TEST_old_assistant_${turn}`
    history.push({ info: { id: user, sessionID: fact.sessionId, role: 'user', time: { created: turn * 2 } }, parts: [] })
    history.push({ info: { id: assistant, parentID: user, sessionID: fact.sessionId, role: 'assistant', finish: 'stop', time: { created: turn * 2 + 1, completed: turn * 2 + 1 } },
      parts: Array.from({ length: 8 }, (_, edit) => ({ id: `prt_TEST_${turn}_${edit}`, sessionID: fact.sessionId, messageID: assistant,
        type: 'tool', tool: 'edit', callID: `call_TEST_${turn}_${edit}`, state: { status: 'completed',
          input: { filePath: `/TEST/file-${edit}.ts`, oldString: 'const previous = 1\n'.repeat(includeFileText ? 450 : 0), newString: 'const changed = 2\n'.repeat(includeFileText ? 450 : 0) },
          output: 'Edit applied', metadata: { diagnostics: Array.from({ length: 20 }, (_, line) => ({ line, severity: 2, message: 'TEST type diagnostic' })) },
          time: { start: turn * 2 + 1, end: turn * 2 + 1 },
        } })),
    })
  }
  return [...history, ...structuredClone(fact.final)]
}
const fetchFor = (messages: OpenCodeMessage[]): typeof fetch => Object.assign(async (input: RequestInfo | URL) =>
  Response.json(String(input).includes('/message?') ? messages : []), { preconnect: globalThis.fetch.preconnect })

test.each(['file-text', 'metadata'] as const)('bounded reconciliation and terminal proof accept an ordinary tool-rich 50-message page: %s', async mode => {
  const messages = codingSessionPage(mode === 'file-text')
  expect(messages).toHaveLength(50)
  if (mode === 'file-text') expect(Buffer.byteLength(JSON.stringify(messages))).toBeGreaterThan(1024 * 1024)
  else expect(Buffer.byteLength(JSON.stringify(messages))).toBeLessThan(1024 * 1024)
  const signal = new AbortController().signal
  const fetchImpl = fetchFor(messages)
  const client = new OpenCodeClientFactory({ fetchImpl }).create('http://TEST-loopback', { signal, remainingMs: () => 15_000, boundedReconciliation: true })
  expect(await client.getSessionMessages(fact.sessionId, 50)).toHaveLength(50)
  const evidence = await readOpenCodeV1TerminalTranscript({ authority: record, baseUrl: 'http://TEST-loopback', sessionId: fact.sessionId,
    runtimePromptMessageId: fact.promptId, signal, remainingMs: () => 15_000, fetchImpl })
  expect(evidence.complete).toBe(true)
  expect(qualifyOpenCodeV1TerminalProof(evidence, fact.sessionId, fact.promptId).proof?.assistantMessageId).toBe(fact.final.at(-1)!.info.id as string)
})

test('transcript allowance preserves the 32MiB consumed-byte cap and narrow metadata cap', async () => {
  let cancelled = false
  const response = new Response(new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024).fill(32)) }, cancel() { cancelled = true } }), { headers: { 'content-length': '1' } })
  await expect(readOpenCodeBoundedHttpResponse(response, new AbortController().signal, 50, () => 15_000, 'transcript')).rejects.toThrow('body byte budget exceeded')
  expect(cancelled).toBe(true)
  await expect(readOpenCodeBoundedHttpResponse(new Response('[]', { headers: { 'content-length': String(1024 * 1024 + 1) } }), new AbortController().signal, 50)).rejects.toThrow('body byte budget exceeded')
})

test.each(['deadline', 'malformed', 'foreign', 'oversized'] as const)('only unavailable transport reads permit fallback classification: %s', async mode => {
  const messages = structuredClone(fact.final)
  if (mode === 'foreign') messages.at(-1)!.info.sessionID = 'ses_foreign'
  const fetchImpl: typeof fetch = Object.assign(async () => mode === 'malformed' ? new Response('{')
    : mode === 'oversized' ? new Response('[]', { headers: { 'content-length': String(32 * 1024 * 1024 + 1) } })
      : Response.json(messages), { preconnect: globalThis.fetch.preconnect })
  const evidence = await readOpenCodeV1TerminalTranscript({ authority: record, baseUrl: 'http://TEST-loopback', sessionId: fact.sessionId,
    runtimePromptMessageId: fact.promptId, signal: new AbortController().signal, remainingMs: () => mode === 'deadline' ? 0 : 15_000, fetchImpl })
  expect(evidence.complete).toBe(false)
  expect(evidence.readUnavailable).toBe(mode === 'deadline' || mode === 'oversized')
})

for (const mode of ['unavailable', 'unclassified', 'changed-window', 'foreign-authority', 'pending-permission', 'malformed-native', 'observed-pending-deadline', 'observed-window-deadline'] as const) {
  test(`independent terminal proof survives only a non-contradicting unavailable reread: ${mode}`, async () => {
    const evidence = await readOpenCodeV1TerminalTranscript({ authority: record, baseUrl: 'http://TEST-loopback', sessionId: fact.sessionId,
      runtimePromptMessageId: fact.promptId, signal: new AbortController().signal, fetchImpl: fetchFor(fact.final) })
    const proof = qualifyOpenCodeV1TerminalProof(evidence, fact.sessionId, fact.promptId).proof!
    expect(proof).not.toBeNull()
    let unavailable: OpenCodeV1TerminalEvidence = { sessionId: fact.sessionId, messages: [], messageSessionIds: [], complete: false, interactionsSettled: false,
      readUnavailable: mode !== 'unclassified' && mode !== 'malformed-native', diagnostics: ['TEST reread unavailable'] }
    if (mode === 'observed-pending-deadline' || mode === 'observed-window-deadline') {
      const controller = new AbortController()
      const fetchImpl: typeof fetch = Object.assign(async (input: RequestInfo | URL) => {
        if (String(input).includes('/message?')) return Response.json(mode === 'observed-window-deadline' ? fact.partial : fact.final)
        if (String(input).endsWith('/permission') && mode === 'observed-pending-deadline') return Response.json([{ sessionID: fact.sessionId, id: 'TEST-observed-permission' }])
        controller.abort(new Error('TEST later read expired'))
        return Response.json([])
      }, { preconnect: globalThis.fetch.preconnect })
      const failed = await readOpenCodeV1TerminalTranscript({ authority: record, baseUrl: 'http://TEST-loopback', sessionId: fact.sessionId,
        runtimePromptMessageId: fact.promptId, signal: controller.signal, fetchImpl })
      expect(failed.complete).toBe(false)
      unavailable = { ...unavailable, ...failed, readUnavailable: failed.readUnavailable === true }
    }
    const summary: OpenCodeSessionReconcileSummary = {
      sessionId: fact.sessionId, reconcileOutcome: 'reconciled', rawStatus: 'idle', durableState: 'idle', staleReason: null, profileAuthState: 'ok',
      pendingPermissionRequestIds: mode === 'pending-permission' ? ['TEST-permission'] : [], messageCount: evidence.messages.length, toolCallCount: 0, errorCount: 0,
      lastCanonicalCursor: null, latestUserMessageId: fact.promptId, latestAssistantMessageId: proof.assistantMessageId,
      latestAssistantText: null, latestAssistantPreview: null, replyPendingSinceMessageId: null, messages: structuredClone(evidence.messages), diagnostics: [], terminalEvidence: unavailable,
    }
    if (mode === 'changed-window') summary.messages.at(-1)!.completedAt = null
    if (mode === 'foreign-authority') proof.evidence = { ...proof.evidence, authority: { ...record, hostKey: 'foreign-host' } }
    const events: OpenCodeRuntimeTurnSettledEvent[] = []
    await new OpenCodeTurnSettledEmissionCoordinator({ emitter: { emit: async event => { events.push(event) } } }).emitDelivery({ record, runtimePromptMessageId: fact.promptId,
      reconcileSummary: summary, turnSettled: { outcome: 'success', sessionId: fact.sessionId, runtimePromptMessageId: fact.promptId, turnId: fact.promptId,
        endpoint: '/event', streamConnected: true, observedEventCount: 1, matchedEventCount: 1, assistantActivityCount: 1, promptPersisted: true,
        latestEventType: 'message.updated', latestAssistantMessageId: proof.assistantMessageId, diagnostics: [], terminalProof: proof } })
    expect(events).toHaveLength(mode === 'unavailable' ? 1 : 0)
    if (events.length) expect(events[0]?.runtimePromptMessageId).toBe(fact.promptId)
    if (mode === 'observed-pending-deadline' || mode === 'observed-window-deadline') expect(unavailable.readUnavailable).toBe(false)
  })
}
