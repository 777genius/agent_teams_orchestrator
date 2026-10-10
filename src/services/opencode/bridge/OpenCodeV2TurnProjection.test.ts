import { describe, expect, test } from 'bun:test'
import { projectOpenCodeV2Turn, type OpenCodeV2TurnCut } from './OpenCodeV2TurnProjection.js'
import type { ExecutionLogEvent, ExecutionMessage } from '../transport/OpenCodeV2ExecutionClientFactory.js'
import type { SessionStepStarted as CurrentStepStarted, SessionStepEnded as CurrentStepEnded } from '@opencode/client'
import type { SessionStepStarted as FloorStepStarted } from '@opencode/client-v2-floor'

const sessionID = 'ses_TESToriginal', nativeInputID = 'msg_TESTinput', assistantID = 'msg_TESTassistant'
const text = 'TEST inbound app relay'
const toolName = 'agent-teams_message_send'
const toolInput = { relayOfMessageId: 'TEST-inbound', text: 'TEST visible reply' }
const result = { deliveredToInbox: true, message: { messageId: 'TEST-visible', relayOfMessageId: 'TEST-inbound' } }
const content = [{ type: 'text', text: JSON.stringify(result) }]
const floorStarted = { sessionID, assistantMessageID: assistantID, agent: 'TEST-agent',
  model: { providerID: 'TEST-provider', id: 'TEST-model' } } satisfies FloorStepStarted['data']
const currentStarted = { ...floorStarted, started: 3 } satisfies CurrentStepStarted['data']
const ended = { sessionID, assistantMessageID: assistantID, finish: 'stop', cost: 0,
  tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } } satisfies CurrentStepEnded['data']
function event(type: string, seq: number, data: Record<string, unknown> = {}): ExecutionLogEvent {
  return { id: `evt_TEST${seq}`, type, seq, aggregateID: sessionID, data: { sessionID, ...data } }
}
function message(id: string, type: string, data: Record<string, unknown>): ExecutionMessage {
  return { id, type, timeCreated: 1, data: { id, type, time: { created: 1 }, ...data } }
}
function cut(): OpenCodeV2TurnCut {
  return { pin: '2.0.21', sessionID, nativeInputID, originalText: text, beforeCursor: 0,
    inboundMessageId: 'TEST-inbound', advertisedTools: [toolName],
    messages: { previous: null, next: null, data: [
      message(nativeInputID, 'user', { text }),
      message(assistantID, 'assistant', { agent: 'TEST-agent', model: { providerID: 'TEST-provider', id: 'TEST-model' },
        finish: 'stop', time: { created: 3, completed: 8 }, content: [
          { type: 'tool', id: 'TEST-tool', name: toolName, executed: false,
            state: { status: 'completed', input: toolInput, content }, time: { created: 4, ran: 5, completed: 6 } },
        ] }),
      message('msg_TEST8', 'idle', { outcome: 'succeeded' }),
    ] }, log: { synced: true, watermark: 8, events: [
      event('session.execution.started', 1),
      event('session.inbox.delivered', 2, { inboxID: nativeInputID }),
      event('session.step.started', 3, currentStarted),
      event('session.tool.input.started', 4, { assistantMessageID: assistantID, id: 'TEST-tool', name: toolName }),
      event('session.tool.called', 5, { assistantMessageID: assistantID, id: 'TEST-tool', input: toolInput, executed: false }),
      event('session.tool.success', 6, { assistantMessageID: assistantID, id: 'TEST-tool', content, executed: false }),
      event('session.step.ended', 7, ended),
      event('session.execution.succeeded', 8),
    ] } }
}
function assistant(value: OpenCodeV2TurnCut): ExecutionMessage {
  const item = value.messages.data.find(message => message.id === assistantID)
  if (!item) throw new Error('TEST-assistant-missing')
  return item
}

describe('V2 actual durable terminal projection', () => {
  test('requires original delivery, actual step/tool success, terminal and exact relay before producing one visible receipt', () => {
    const projected = projectOpenCodeV2Turn(cut())
    expect(projected.state).toBe('succeeded')
    expect(projected.visibleReplies).toEqual([{ nativeInputId: nativeInputID, assistantMessageId: assistantID,
      toolCallId: 'TEST-tool', toolName, inboundMessageId: 'TEST-inbound', visibleReplyMessageId: 'TEST-visible' }])
  })
  test('both pinned step dialects preserve the same verified terminal outcome', () => {
    for (const started of [floorStarted, currentStarted]) {
      const value = cut()
      const events = value.log.events.map(item => item.type === 'session.step.started'
        ? event(item.type, item.seq, started) : item)
      const projected = projectOpenCodeV2Turn({ ...value, log: { ...value.log, events } })
      expect(projected.state).toBe('succeeded')
      expect(projected.visibleReplies).toHaveLength(1)
    }
  })
  test('accepted queue with empty inbox and no terminal remains pending', () => {
    const value = cut()
    const log = { ...value.log, events: value.log.events.slice(0, 2), watermark: 2 }
    const projected = projectOpenCodeV2Turn({ ...value, log, messages: { ...value.messages, data: value.messages.data.slice(0, 1) } })
    expect(projected.state).toBe('pending')
    expect(projected.visibleReplies).toHaveLength(0)
  })
  test('completed assistant/tool without execution terminal never settles or publishes', () => {
    const value = cut()
    const projected = projectOpenCodeV2Turn({ ...value, log: { ...value.log, events: value.log.events.slice(0, 7), watermark: 7 } })
    expect(projected.state).toBe('pending')
    expect(projected.visibleReplies).toHaveLength(0)
  })
  test('terminal watermark without matching terminal transcript is unknown', () => {
    const value = cut()
    const projected = projectOpenCodeV2Turn({ ...value, messages: { ...value.messages, data: value.messages.data.slice(0, 2) } })
    expect(projected.reason).toBe('terminal_snapshot_mismatch')
    expect(projected.visibleReplies).toHaveLength(0)
  })
  test('task done is a task effect and cannot assert visible DM', () => {
    const value = cut(), name = 'agent-teams_task_done'
    const item = assistant(value)
    item.data = { ...item.data, content: [{ type: 'tool', id: 'TEST-tool', name, executed: false,
      state: { status: 'completed', input: toolInput, content } }] }
    const events = value.log.events.map(event => event.type === 'session.tool.input.started' ? { ...event, data: { ...event.data, name } } : event)
    const projected = projectOpenCodeV2Turn({ ...value, advertisedTools: [name], log: { ...value.log, events } })
    expect(projected.state).toBe('succeeded')
    expect(projected.toolEffects[0]?.kind).toBe('task')
    expect(projected.visibleReplies).toHaveLength(0)
  })
  test('foreign delivered input in same execution makes terminal lineage unknown', () => {
    const value = cut()
    const events = value.log.events.map(item => ({ ...item, seq: item.seq >= 3 ? item.seq + 1 : item.seq }))
    events.splice(2, 0, { ...event('session.inbox.delivered', 3, { inboxID: 'msg_TESTforeign' }), id: 'evt_TESTforeign' })
    const projected = projectOpenCodeV2Turn({ ...value, log: { ...value.log, events, watermark: 9 } })
    expect(projected.reason).toBe('ambiguous_delivered_input_lineage')
    expect(projected.visibleReplies).toHaveLength(0)
  })
  test('synced watermark cannot hide a missing aggregate event inside lineage', () => {
    const value = cut()
    const events = value.log.events.filter(item => item.seq !== 4)
    const projected = projectOpenCodeV2Turn({ ...value, log: { ...value.log, events } })
    expect(projected.reason).toBe('foreign_or_incomplete_log')
    expect(projected.visibleReplies).toHaveLength(0)
  })
  test('wrong original session or payload never publishes', () => {
    expect(projectOpenCodeV2Turn({ ...cut(), sessionID: 'ses_TESTforeign' }).state).toBe('unknown')
    expect(projectOpenCodeV2Turn({ ...cut(), originalText: 'TEST conflicting payload' }).reason).toBe('original_input_projection_mismatch')
  })
  test('foreign assistant/tool lineage and snapshot disagreement cannot publish', () => {
    const value = cut()
    const events = value.log.events.map(event => event.type === 'session.tool.success'
      ? { ...event, data: { ...event.data, assistantMessageID: 'msg_TESTforeign' } } : event)
    expect(projectOpenCodeV2Turn({ ...value, log: { ...value.log, events } }).state).toBe('unknown')
    const mismatched = cut()
    const wrong = mismatched.log.events.map(event => event.type === 'session.tool.success'
      ? { ...event, data: { ...event.data, content: [{ type: 'text', text: 'TEST fabricated receipt' }] } } : event)
    expect(projectOpenCodeV2Turn({ ...mismatched, log: { ...mismatched.log, events: wrong } }).reason).toBe('tool_success_snapshot_mismatch')
  })
  test('unadvertised MCP name never produces a response receipt', () => {
    const projected = projectOpenCodeV2Turn({ ...cut(), advertisedTools: ['TEST-other'] })
    expect(projected.state).toBe('succeeded')
    expect(projected.visibleReplies).toHaveLength(0)
  })
  test('relay mismatch or rejected controller result cannot publish despite native success', () => {
    expect(projectOpenCodeV2Turn({ ...cut(), inboundMessageId: 'TEST-other-inbound' }).visibleReplies).toHaveLength(0)
    const value = cut()
    const rejected = [{ type: 'text', text: JSON.stringify({ ...result, accepted: false }) }]
    assistant(value).data = { ...assistant(value).data, content: [{ type: 'tool', id: 'TEST-tool', name: toolName, executed: false,
      state: { status: 'completed', input: toolInput, content: rejected } }] }
    const events = value.log.events.map(event => event.type === 'session.tool.success'
      ? { ...event, data: { ...event.data, content: rejected } } : event)
    expect(projectOpenCodeV2Turn({ ...value, log: { ...value.log, events } }).visibleReplies).toHaveLength(0)
  })
  test('incomplete message page, log, or duplicated events stay unknown', () => {
    const value = cut()
    expect(projectOpenCodeV2Turn({ ...value, messages: { ...value.messages, next: 'TEST-next' } }).state).toBe('unknown')
    expect(projectOpenCodeV2Turn({ ...value, log: { ...value.log, watermark: 9 } }).state).toBe('unknown')
    const duplicate = value.log.events[0]
    if (!duplicate) throw new Error('TEST-log-missing')
    expect(projectOpenCodeV2Turn({ ...value, log: { ...value.log, events: [...value.log.events, duplicate] } }).state).toBe('unknown')
  })
  test('native cancel of original queued input needs no successor or assistant', () => {
    const value = cut()
    const projected = projectOpenCodeV2Turn({ ...value, messages: { data: [], previous: null, next: null },
      log: { synced: true, watermark: 1, events: [event('session.inbox.cancelled', 1, { inboxID: nativeInputID })] } })
    expect(projected.state).toBe('cancelled')
    expect(projected.visibleReplies).toHaveLength(0)
  })
})


import { capturedR264TerminalCuts } from './fixtures/OpenCodeV2R264TerminalCuts.js'
import { readExecutionCut } from '../execution/OpenCodeV2TerminalSettlement.js'

for (const captured of capturedR264TerminalCuts) test(`${captured.pin} actual R264 terminal uses its pinned projection with original lineage`, async () => {
  const native = structuredClone(captured)
  const full = await readExecutionCut({ log: async () => structuredClone(native.log),
    messages: async (_sessionID, cursor) => {
      if (cursor === undefined) return structuredClone(native.messages)
      expect(cursor === native.messages.next).toBe(true)
      return { data: [], previous: null, next: null }
    } }, native.sessionID)
  const qualified = { ...native, log: full.log, messages: { data: full.messages, previous: null, next: null } }
  expect(projectOpenCodeV2Turn(qualified).state).toBe('succeeded')
  const withoutIdle = { ...qualified, messages: { ...qualified.messages, data: full.messages.filter(row => row.type !== 'idle') } }
  expect(projectOpenCodeV2Turn(withoutIdle).state).toBe(captured.pin === '2.0.0' ? 'succeeded' : 'unknown')
  const wrongUser = { ...qualified, messages: { ...qualified.messages, data: qualified.messages.data.map(row =>
    row.id === qualified.nativeInputID ? { ...row, data: { ...row.data, text: 'foreign input' } } : row) } }
  expect(projectOpenCodeV2Turn(wrongUser).state).toBe('unknown')
  expect(projectOpenCodeV2Turn({ ...qualified, messages: { ...qualified.messages, next: native.messages.next } }).state).toBe('unknown')
  const unknownPin = structuredClone(qualified); Reflect.set(unknownPin, 'pin', '2.1.0')
  expect(projectOpenCodeV2Turn(unknownPin)).toMatchObject({ state: 'unknown', reason: 'unqualified_projection_pin' })
})

const controllerBinding = { teamId: 'TEST-team', runId: 'TEST-run', memberId: 'worker', sessionID }
const nativeSend = { teamName: 'TEST-team', to: 'user', from: 'worker', source: 'runtime_delivery',
  relayOfMessageId: 'TEST-inbound', text: 'TEST visible reply' }
const inboxRow = { messageId: 'TEST-durable', from: 'worker', to: 'user', source: 'runtime_delivery',
  relayOfMessageId: 'TEST-inbound', text: 'TEST visible reply', timestamp: '2026-10-10T00:00:00Z', read: false }
function codeModeCut(): OpenCodeV2TurnCut {
  const value = cut()
  const input = { code: 'TEST native interpreter program' }
  const metadata = { truncated: false, toolCalls: [
    { tool: 'search', status: 'completed', input: { query: 'message_send', namespace: 'agent-teams', limit: 1 } },
    { tool: 'agent-teams.message_send', status: 'completed', input: nativeSend },
  ] }
  // The output deliberately contains no usable receipt. Only native metadata and canonical inbox count.
  const content = [{ type: 'text', text: 'TEST arbitrary model-composed output' }]
  assistant(value).data = { ...assistant(value).data, content: [{ type: 'tool', id: 'TEST-tool',
    name: 'execute', executed: false, state: { status: 'completed', input, content, metadata } }] }
  const events = value.log.events.map(row => row.type === 'session.tool.input.started'
    ? { ...row, data: { ...row.data, name: 'execute' } } : row.type === 'session.tool.called'
      ? { ...row, data: { ...row.data, input } } : row.type === 'session.tool.success'
        ? { ...row, data: { ...row.data, content, metadata } } : row)
  return { ...value, log: { ...value.log, events }, controllerBinding,
    controllerInbox: { binding: controllerBinding, messages: [inboxRow] } }
}
test('CodeMode actual completed subcall joins one canonical receipt without trusting composed output', () => {
  const value = projectOpenCodeV2Turn(codeModeCut())
  expect(value.state).toBe('succeeded')
  expect(value.toolEffects[0]).toMatchObject({ kind: 'visible_message', toolName: 'agent-teams.message_send', input: nativeSend })
  expect(value.visibleReplies).toEqual([{ nativeInputId: nativeInputID, assistantMessageId: assistantID,
    toolCallId: 'TEST-tool', toolName: 'agent-teams.message_send', inboundMessageId: 'TEST-inbound', visibleReplyMessageId: 'TEST-durable' }])
})
test('CodeMode forged output, absent metadata or durable record, wrong binding and duplicate receipts cannot publish', () => {
  const missingMetadata = codeModeCut()
  const part = (assistant(missingMetadata).data.content as Record<string, unknown>[])[0]!
  Reflect.deleteProperty(part.state as object, 'metadata')
  expect(projectOpenCodeV2Turn(missingMetadata).visibleReplies).toHaveLength(0)
  for (const override of [
    { controllerInbox: null },
    { controllerInbox: { binding: controllerBinding, messages: [] } },
    { controllerInbox: { binding: { ...controllerBinding, runId: 'TEST-wrong-run' }, messages: [inboxRow] } },
    { controllerInbox: { binding: controllerBinding, messages: [{ ...inboxRow, to: 'TEST-wrong-recipient' }] } },
    { controllerInbox: { binding: controllerBinding, messages: [inboxRow, { ...inboxRow, messageId: 'TEST-duplicate', text: 'TEST-different-duplicate' }] } },
    { controllerInbox: { binding: controllerBinding, messages: [inboxRow, { ...inboxRow, relayOfMessageId: 'TEST-other' }] } },
  ]) expect(projectOpenCodeV2Turn({ ...codeModeCut(), ...override }).visibleReplies).toHaveLength(0)
  const mismatch = codeModeCut()
  const events = mismatch.log.events.map(row => row.type === 'session.tool.success'
    ? { ...row, data: { ...row.data, metadata: { toolCalls: [] } } } : row)
  expect(projectOpenCodeV2Turn({ ...mismatch, log: { ...mismatch.log, events } }).visibleReplies).toHaveLength(0)
  expect(projectOpenCodeV2Turn({ ...codeModeCut(), sessionID: 'ses_TESTwrong' }).visibleReplies).toHaveLength(0)
})
