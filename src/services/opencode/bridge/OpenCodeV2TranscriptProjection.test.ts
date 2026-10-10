import { describe, expect, test } from 'bun:test'
import type { SessionMessageAssistant as CurrentAssistant, SessionMessageUser as CurrentUser } from '@opencode/client'
import type { SessionMessageAssistant as FloorAssistant, SessionMessageUser as FloorUser } from '@opencode/client-v2-floor'
import { normalizeV2Transcript } from './OpenCodeV2TranscriptProjection.js'
import type { ExecutionLog, ExecutionMessage, ExecutionMessagePage } from '../transport/OpenCodeV2ExecutionClientFactory.js'

const sessionID = 'ses_TESTtranscript'
const user = { id: 'msg_TESTuser', type: 'user', text: 'TEST request', time: { created: 10 } } satisfies CurrentUser & FloorUser
const assistant = { id: 'msg_TESTassistant', type: 'assistant', agent: 'TEST-agent',
  model: { id: 'TEST-model', providerID: 'TEST-provider' }, finish: 'stop', time: { created: 20, completed: 30 },
  content: [
    { type: 'reasoning', text: 'TEST reasoning' },
    { type: 'text', text: 'TEST response' },
    { type: 'tool', id: 'TEST-call', name: 'agent-teams_task_done', executed: false,
      state: { status: 'completed', input: { taskId: 'TEST-task' }, content: [{ type: 'text', text: '{"accepted":true}' }] },
      time: { created: 21, ran: 22, completed: 29 } },
  ] } satisfies CurrentAssistant & FloorAssistant
function wrapped(row: Record<string, unknown>, timeCreated: number): ExecutionMessage {
  if (typeof row.id !== 'string' || typeof row.type !== 'string') throw new Error('TEST-bad-message')
  return { id: row.id, type: row.type, timeCreated, data: row }
}
function cut(): { messages: ExecutionMessagePage; log: ExecutionLog } {
  return { messages: { previous: null, next: null, data: [wrapped(user, 10), wrapped(assistant, 20),
    wrapped({ id: 'msg_TESTterminal', type: 'idle', outcome: 'succeeded', time: { created: 31 } }, 31)] },
    log: { synced: true, watermark: 2, events: [
      { id: 'evt_TESTstart', type: 'session.execution.started', aggregateID: sessionID, seq: 1, data: { sessionID } },
      { id: 'evt_TESTterminal', type: 'session.execution.succeeded', aggregateID: sessionID, seq: 2, data: { sessionID } },
    ] } }
}
describe('V2 canonical transcript protocol DTO', () => {
  test('normalizes both pinned native message shapes without a V1 wire cast', () => {
    const result = normalizeV2Transcript(cut(), sessionID)
    expect(Object.keys(result).sort()).toEqual(['diagnostics', 'durableState', 'logProjection', 'messages', 'sessionId'])
    expect(result.sessionId).toBe(sessionID)
    expect(result.durableState).toBe('idle')
    expect(result.messages.map(message => message.id)).toEqual(['msg_TESTuser', 'msg_TESTassistant', 'msg_TESTterminal'])
    expect(result.messages.every(message => message.parentId === null)).toBe(true)
    expect(result.messages[1]?.providerId).toBe('TEST-provider')
    expect(result.messages[1]?.modelId).toBe('TEST-model')
    expect(result.messages[1]?.text).toBe('TEST response')
    expect(result.messages[1]?.reasoningText).toBe('TEST reasoning')
  })
  test('retains actual tool id/name, input, native content and times in canonical and existing log projection', () => {
    const result = normalizeV2Transcript(cut(), sessionID)
    expect(result.messages[1]?.toolCalls[0]).toMatchObject({ callId: 'TEST-call', toolName: 'agent-teams_task_done',
      status: 'completed', input: { taskId: 'TEST-task' }, output: [{ type: 'text', text: '{"accepted":true}' }],
      startedAt: 22, completedAt: 29, isError: false })
    expect(result.logProjection.toolCallCount).toBe(1)
    expect(result.logProjection.syntheticMessageCount).toBe(1)
    expect(result.logProjection.messages.find(message => message.uuid === 'msg_TESTassistant')?.toolCalls[0]?.id).toBe('TEST-call')
    expect(result.logProjection.messages.find(message => message.uuid === 'msg_TESTassistant::tool_results')?.parentUuid).toBe('msg_TESTassistant')
  })
  test('assistant final text and completion do not manufacture a settled session', () => {
    const value = cut()
    const result = normalizeV2Transcript({ ...value, log: { synced: true, watermark: null, events: [] } }, sessionID)
    expect(result.durableState).toBe('unknown')
    expect(result.messages[1]?.finishReason).toBe('stop')
  })
  test('actual started execution stays running despite assistant final text', () => {
    const value = cut()
    expect(normalizeV2Transcript({ ...value, log: { ...value.log, watermark: 1, events: value.log.events.slice(0, 1) } }, sessionID).durableState).toBe('running')
  })
  test('terminal event without its actual idle projection reports unknown while preserving readable messages', () => {
    const value = cut()
    const result = normalizeV2Transcript({ ...value, messages: { ...value.messages, data: value.messages.data.slice(0, 2) } }, sessionID)
    expect(result.durableState).toBe('unknown')
    expect(result.diagnostics).toContain('v2_transcript_terminal_snapshot_mismatch:evt_TESTterminal')
    expect(result.messages[1]?.text).toBe('TEST response')
  })
  test('actual native structured errors map type/message with no guessed V1 error name', () => {
    const value = cut()
    const failedAssistant = { ...assistant, error: { type: 'TEST-provider-error', message: 'TEST failed' } }
    value.messages.data[1] = wrapped(failedAssistant, 20)
    value.messages.data[2] = wrapped({ id: 'msg_TESTterminal', type: 'idle', outcome: 'failed', time: { created: 31 } }, 31)
    value.log.events[1] = { id: 'evt_TESTterminal', type: 'session.execution.failed', aggregateID: sessionID,
      seq: 2, data: { sessionID, error: failedAssistant.error } }
    const result = normalizeV2Transcript(value, sessionID)
    expect(result.durableState).toBe('error')
    expect(result.messages[1]).toMatchObject({ errorName: 'TEST-provider-error', errorMessage: 'TEST failed', hasError: true })
    expect(result.logProjection.errorCount).toBe(1)
  })
  test('streaming native tool has running state and no fabricated tool output', () => {
    const value = cut()
    value.messages.data[1] = wrapped({ ...assistant, content: [{ type: 'tool', id: 'TEST-streaming', name: 'TEST-tool',
      state: { status: 'streaming', input: '{"unfinished"' }, time: { created: 21 } }] }, 20)
    const projected = normalizeV2Transcript(value, sessionID).messages[1]?.toolCalls[0]
    expect(projected).toMatchObject({ status: 'running', input: null, output: null, completedAt: null })
  })
  test('foreign session log, identity mismatch and incomplete pages refuse the canonical cut', () => {
    const value = cut()
    expect(() => normalizeV2Transcript(value, 'ses_TESTforeign')).toThrow('v2_transcript_foreign_or_incomplete_log')
    expect(() => normalizeV2Transcript({ ...value, messages: { ...value.messages, next: 'TEST-cursor' } }, sessionID)).toThrow('v2_transcript_incomplete_cut')
    value.messages.data[0] = { ...wrapped(user, 10), id: 'msg_TESTdifferent' }
    expect(() => normalizeV2Transcript(value, sessionID)).toThrow('v2_transcript_message_identity_mismatch')
  })
  test('unknown native message kinds preserve identity with explicit diagnostics', () => {
    const value = cut()
    value.messages.data.push(wrapped({ id: 'msg_TESTfuture', type: 'TEST-future', time: { created: 32 } }, 32))
    const result = normalizeV2Transcript(value, sessionID)
    expect(result.messages.at(-1)).toMatchObject({ id: 'msg_TESTfuture', role: 'unknown', parentId: null })
    expect(result.diagnostics).toContain('v2_transcript_unknown_message_type:msg_TESTfuture:TEST-future')
  })
  test('duplicate native messages and incomplete durable watermark cannot pass read normalization', () => {
    const value = cut()
    value.messages.data.push(wrapped(user, 10))
    expect(() => normalizeV2Transcript(value, sessionID)).toThrow('v2_transcript_duplicate_message')
    const other = cut()
    expect(() => normalizeV2Transcript({ ...other, log: { ...other.log, watermark: 3 } }, sessionID)).toThrow('v2_transcript_incomplete_watermark')
  })
})
