import { describe, expect, test } from 'bun:test'

import { decodeHostedAgentToolRequest, hostedAgentToolResponse } from './HostedAgentToolContract.js'

const base = {
  version: 1,
  type: 'request',
  requestId: 'request_1',
  context: { sessionID: 'session_1', messageID: 'message_1', callID: 'call_1' },
}
const taskId = `task_${'a'.repeat(32)}`

describe('HostedAgentToolContract', () => {
  test('accepts only the five exact hosted tools with bounded strict arguments', () => {
    for (const tool of ['hosted_task_get', 'hosted_task_start', 'hosted_task_complete'] as const) {
      expect(decodeHostedAgentToolRequest(JSON.stringify({ ...base, tool, args: { taskId } })))
        .toMatchObject({ tool, args: { taskId } })
    }
    expect(decodeHostedAgentToolRequest(JSON.stringify({ ...base, tool: 'hosted_task_add_comment',
      args: { taskId, text: 'Result.' } }))).toMatchObject({ args: { taskId, text: 'Result.' } })
    expect(decodeHostedAgentToolRequest(JSON.stringify({ ...base, tool: 'hosted_message_send',
      args: { to: 'team-lead', text: 'Done.', taskRefs: [{ teamName: 'sandbox-team', taskId }] } })))
      .toMatchObject({ args: { to: 'team-lead', taskRefs: [{ teamName: 'sandbox-team', taskId }] } })
  })

  test('rejects caller authority, unknown tools, duplicate keys and oversized text', () => {
    for (const candidate of [
      { ...base, tool: 'hosted_task_get', args: { taskId, teamName: 'other' } },
      { ...base, tool: 'hosted_message_send', args: { to: 'user', from: 'worker', text: 'Hi' } },
      { ...base, tool: 'hosted_task_get', args: { taskId }, teamId: 'team_other' },
      { ...base, tool: 'bash', args: {} },
      { ...base, tool: 'hosted_task_get', args: { taskId: 'task_other' } },
      { ...base, tool: 'hosted_task_add_comment', args: { taskId, text: 'a'.repeat(20_001) } },
      { ...base, tool: 'hosted_message_send', args: { to: 'user', text: 'a'.repeat(4_001) } },
    ]) expect(() => decodeHostedAgentToolRequest(JSON.stringify(candidate))).toThrow()
    expect(() => decodeHostedAgentToolRequest(`{"version":1,"type":"request","requestId":"a","requestId":"b","tool":"hosted_task_get","context":{"sessionID":"s","messageID":"m","callID":"c"},"args":{"taskId":"${taskId}"}}`)).toThrow()
    expect(() => decodeHostedAgentToolRequest(JSON.stringify({ ...base, tool: 'hosted_message_send',
      args: { to: 'user', text: 'Hi', taskRefs: [{ teamName: 'sandbox', taskId, root: '/tmp' }] } }))).toThrow()
  })

  test('creates only exact response shapes', () => {
    expect(hostedAgentToolResponse('request_1', { result: '' })).toEqual({
      version: 1, type: 'response', requestId: 'request_1', ok: true, result: '',
    })
    expect(hostedAgentToolResponse('request_1', { error: 'unavailable' })).toEqual({
      version: 1, type: 'response', requestId: 'request_1', ok: false, error: 'unavailable',
    })
  })
})
