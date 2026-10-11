import { describe, expect, test } from 'bun:test'
import { getOrdinaryInlineHandoffPrompt, getOrdinaryProcessingAction } from './useInboxPoller.js'
import { createAssistantMessage, createUserMessage } from '../utils/messages.js'
import { createPendingMailboxMirrorMessage } from './ordinaryMailboxMessage.js'
import { getFreshGroupChatDiscoveryPrompt, relayGroupAssistantText } from '../utils/groupChatControlClient.js'

test('compaction discovery reads the fresh bound catalog, including archive state, and fails closed on unavailable', async () => {
  let archived = false
  let unavailable = false
  let requests = 0
  const canonicalIds = new Set<string>()
  const context = JSON.stringify({ appInstanceId: 'synthetic-app', dataRootFingerprint: 'synthetic-root', connectionGeneration: 1 })
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    requests++
    expect(request.headers.get('x-agent-teams-app-context')).toBe(context)
    const body = await request.json() as Record<string, string>
    const path = new URL(request.url).pathname
    if (path.endsWith('/send')) {
      expect(path).toBe('/api/teams/synthetic-groups/group-chats/send')
      expect(body.from).toBe('alice')
      expect(body.groupChatId).toBe('3695a573-5ad2-469a-91f2-427f90792e11')
      expect(body.relayOfMessageId).toBe('0bdf10f0-3fd3-4494-a974-b394de06c181')
      if (archived) return Response.json({ code: 'GROUP_ARCHIVED' }, { status: 409 })
      canonicalIds.add(body.messageId!)
      return Response.json({ saved: true, groupChatId: body.groupChatId, groupMessageId: body.messageId, relayOfMessageId: body.relayOfMessageId })
    }
    expect(body).toEqual({ from: 'alice' })
    expect(path).toBe('/api/teams/synthetic-groups/group-chats/list')
    return unavailable ? new Response('', { status: 503 }) : Response.json([{
      id: '3695a573-5ad2-469a-91f2-427f90792e11', name: 'Design', memberNames: ['alice', 'bob'],
      archivedAt: archived ? '2026-10-10T00:00:00Z' : null, canSend: !archived,
    }])
  } })
  try {
    const binding = { controlUrl: `http://127.0.0.1:${server.port}`, context }
    expect(await getFreshGroupChatDiscoveryPrompt('synthetic-groups', 'alice', binding)).toContain('"canSend":true')
    const reply = { teamName: 'synthetic-groups', from: 'alice', text: 'Plain group reply', message: {
      groupChatId: '3695a573-5ad2-469a-91f2-427f90792e11', messageId: '0bdf10f0-3fd3-4494-a974-b394de06c181',
    } }
    await relayGroupAssistantText(reply, binding)
    await relayGroupAssistantText(reply, binding)
    expect(canonicalIds.size).toBe(1)
    archived = true
    await expect(relayGroupAssistantText(reply, binding)).rejects.toThrow('HTTP 409')
    const recovered = await getFreshGroupChatDiscoveryPrompt('synthetic-groups', 'alice', binding)
    expect(recovered).toContain('"canSend":false')
    expect(recovered).toContain('After compaction, call group_chat_list')
    unavailable = true
    const failed = await getFreshGroupChatDiscoveryPrompt('synthetic-groups', 'alice', binding)
    expect(failed).toContain('Fresh group catalog unavailable')
    expect(failed).not.toContain('Fresh group catalog: []')
    expect(requests).toBe(6)
  } finally { server.stop(true) }
})

describe('ordinary mailbox source semantics', () => {
  for (const source of ['system_notification', 'user', 'mention', 'runtime_delivery', undefined]) {
    test(`preserves user reply requirement for source ${source}`, () => {
      const submitted = createUserMessage({ content: 'Task handoff', isMeta: true, uuid: 'submitted' })
      const taskAndReply = createAssistantMessage({ content: [
        { type: 'tool_use', id: 'task', name: 'TaskUpdate', input: { taskId: 'f12fdf20', status: 'completed' } },
        { type: 'tool_use', id: 'reply', name: 'SendMessage', input: { to: 'team-lead', message: 'Done', summary: 'Done' } },
      ] as never })
      const results = createUserMessage({ content: [
        { type: 'tool_result', tool_use_id: 'task', content: 'updated', is_error: false },
        { type: 'tool_result', tool_use_id: 'reply', content: 'sent', is_error: false },
      ] as never })
      const row = createPendingMailboxMirrorMessage({
        messageId: 'assignment', from: 'user', source, read: false,
        text: 'Task assigned: taskId: "f12fdf20"', timestamp: '2026-09-04T14:11:38.387Z',
      }, 'session')
      expect(row.source).toBe(source)
      expect(row.mailboxClaimedBySessionId).toBe('session')
      expect(row.messageId).toBe('assignment')
      const beforeActivity = getOrdinaryProcessingAction({
        attempt: { status: 'in_flight', submittedAt: 1, submitUserMessageUuid: 'submitted', cooldownUntil: 0, timer: null },
        messages: [submitted], processingOrdinaryMessage: row, now: 1000,
      })
      expect(beforeActivity.type).toBe('noop')
      const action = getOrdinaryProcessingAction({
        attempt: { status: 'in_flight', submittedAt: 1, submitUserMessageUuid: 'submitted', cooldownUntil: 0, timer: null },
        messages: [submitted, taskAndReply, results], processingOrdinaryMessage: row, now: 1000,
      })
      expect(action.type).toBe(source === 'system_notification' ? 'finalize' : 'schedule_cooldown')
      for (const replyProtocol of ['send_message', 'agent_teams_message_send'] as const) {
        const prompt = getOrdinaryInlineHandoffPrompt({ ...row, memberName: 'member', teamName: 'sandbox', replyProtocol })
        if (source === 'system_notification') {
          expect(prompt).toContain('This is a system notification')
          expect(prompt).not.toContain('to="user"')
        } else {
          expect(prompt).toContain('human direct message')
          expect(prompt).toContain('to="user"')
        }
      }
    })
  }
})

describe('named group mailbox routing', () => {
  const inbound = {
    messageId: '0bdf10f0-3fd3-4494-a974-b394de06c181', groupMessageId: 'b8192a4c-97c8-4f67-bccd-7b29d8131286', groupChatId: '3695a573-5ad2-469a-91f2-427f90792e11',
    groupChatName: 'Design', groupChatProtocolVersion: 1 as const, groupRunKey: 'run:123',
    from: 'user', source: 'user_sent', text: 'Review this', timestamp: '2026-10-10T00:00:00Z', read: false,
  }
  const submitted = createUserMessage({ content: 'group handoff', isMeta: true, uuid: 'group-submit' })
  const attempt = { status: 'in_flight' as const, submittedAt: 1, submitUserMessageUuid: 'group-submit', cooldownUntil: 0, timer: null }
  test('preserves group identity in mirror and never prompts a private reply', () => {
    const row = createPendingMailboxMirrorMessage(inbound, 'session')
    expect(row.groupChatId).toBe('3695a573-5ad2-469a-91f2-427f90792e11')
    expect(row.groupMessageId).toBe('b8192a4c-97c8-4f67-bccd-7b29d8131286')
    expect(row.groupRunKey).toBe('run:123')
    const prompt = getOrdinaryInlineHandoffPrompt({ ...row, memberName: 'alice', teamName: 'sandbox' })
    expect(prompt).toContain('Group name: "Design"')
    expect(prompt).toContain('group_chat_list')
    expect(prompt).toContain('"relayOfMessageId":"0bdf10f0-3fd3-4494-a974-b394de06c181"')
    expect(prompt).not.toContain('to="user"')
  })
  test('only exact group + physical relay completes reply, and admission errors stop without private fallback', () => {
    const row = createPendingMailboxMirrorMessage(inbound, 'session')
    for (const [groupChatId, relayOfMessageId, is_error, expected] of [
      ['3695a573-5ad2-469a-91f2-427f90792e11', '0bdf10f0-3fd3-4494-a974-b394de06c181', false, 'finalize'],
      ['3695a573-5ad2-469a-91f2-427f90792e11', '0bdf10f0-3fd3-4494-a974-b394de06c181', true, 'finalize'],
      ['ef4a2e64-ce6a-419f-9614-0f5a808762c3', '0bdf10f0-3fd3-4494-a974-b394de06c181', false, 'finalize'],
      ['3695a573-5ad2-469a-91f2-427f90792e11', 'other-physical', false, 'finalize'],
    ] as const) {
      const use = createAssistantMessage({ content: [{ type: 'tool_use', id: 'group-tool', name: 'mcp__agent-teams__group_chat_send', input: { teamName: 'sandbox', groupChatId, relayOfMessageId, from: 'alice', messageId: 'fae7d421-dfd0-4bd3-bc0b-2693fd24b344' } }] as never })
      const result = createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'group-tool', content: is_error ? 'GROUP_ARCHIVED' : JSON.stringify({ saved: true, groupChatId, relayOfMessageId, groupMessageId: 'fae7d421-dfd0-4bd3-bc0b-2693fd24b344' }), is_error }] as never })
      const action = getOrdinaryProcessingAction({ attempt, messages: [submitted, use, result], processingOrdinaryMessage: row, teamName: 'sandbox', memberName: 'alice', now: 1000 })
      // An unrelated proactive post completes the turn without proving a reply or initiating repair/DM.
      expect(action.type).toBe(expected)
      expect(findGroupMailboxReplyOutcome({ messages: [submitted, use, result], submitUserMessageUuid: 'group-submit', teamName: 'sandbox', memberName: 'alice', groupChatId: inbound.groupChatId, physicalMessageId: inbound.messageId })).toBe(groupChatId !== inbound.groupChatId || relayOfMessageId !== inbound.messageId ? 'none' : is_error ? 'blocked' : 'sent')
    }
    const plain = createAssistantMessage({ content: 'Plain group reply' })
    const wrongActor = createAssistantMessage({ content: [
      { type: 'tool_use', id: 'wrong-actor', name: 'group_chat_send', input: { groupChatId: inbound.groupChatId, relayOfMessageId: inbound.messageId, teamName: 'sandbox', from: 'bob', messageId: 'fae7d421-dfd0-4bd3-bc0b-2693fd24b344' } },
      { type: 'text', text: 'Do not infer a second reply from this text' },
    ] as never })
    expect(getOrdinaryProcessingAction({ attempt, messages: [submitted, wrongActor, plain], processingOrdinaryMessage: row, teamName: 'sandbox', memberName: 'alice', now: 1000 }).type).toBe('finalize')
    expect(getOrdinaryProcessingAction({ attempt, messages: [submitted, plain], processingOrdinaryMessage: row, teamName: 'sandbox', now: 1000 }).type).toBe('deliver_assistant_text')
  })
})

import { findGroupMailboxReplyOutcome, getCurrentGroupRunIdentity, isCurrentGroupMailboxMessage } from '../utils/groupMailbox.js'
test('stale run cannot consume group backlog; proactive or private post is not exact reply proof', () => {
  const group = { messageId: 'physical', groupMessageId: 'canonical', groupChatId: '3695a573-5ad2-469a-91f2-427f90792e11', groupChatProtocolVersion: 1 as const, groupRunKey: 'old:10' }
  expect(isCurrentGroupMailboxMessage(group, 'new:20')).toBe(false)
  expect(isCurrentGroupMailboxMessage(group, 'old:10')).toBe(true)
  expect(isCurrentGroupMailboxMessage({ messageId: 'legacy' }, 'new:20')).toBe(true)
  const submitted = createUserMessage({ content: 'handoff', uuid: 'submitted' })
  const use = createAssistantMessage({ content: [{ type: 'tool_use', id: 'proactive', name: 'group_chat_send', input: { teamName: 'sandbox', groupChatId: 'ef4a2e64-ce6a-419f-9614-0f5a808762c3', relayOfMessageId: 'physical' } }] as never })
  const result = createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'proactive', content: 'saved' }] as never })
  expect(findGroupMailboxReplyOutcome({ messages: [submitted, use, result], submitUserMessageUuid: 'submitted', teamName: 'sandbox', groupChatId: '3695a573-5ad2-469a-91f2-427f90792e11', physicalMessageId: 'physical' })).toBe('none')
})


describe('group reaction consumption at the mailbox completion boundary', () => {
  const inbound = {
    messageId: '0bdf10f0-3fd3-4494-a974-b394de06c181', groupMessageId: 'b8192a4c-97c8-4f67-bccd-7b29d8131286',
    groupChatId: '3695a573-5ad2-469a-91f2-427f90792e11', groupChatProtocolVersion: 1 as const,
    groupRunKey: getCurrentGroupRunIdentity().groupRunKey, from: 'user', text: 'FYI', read: false,
    timestamp: '2026-10-11T00:00:00Z',
  }
  const submitted = createUserMessage({ content: 'group handoff', isMeta: true, uuid: 'reaction-submit' })
  const attempt = { status: 'in_flight' as const, submittedAt: 1, submitUserMessageUuid: 'reaction-submit', cooldownUntil: 0, timer: null }
  const args = { teamName: 'sandbox', from: 'alice', groupChatId: inbound.groupChatId, relayOfMessageId: inbound.messageId }
  const saved = { ...args, saved: true, acknowledged: true, messageId: inbound.groupMessageId, groupRunKey: inbound.groupRunKey }
  const plain = createAssistantMessage({ content: 'OK' })
  const useReaction = (input = args) => createAssistantMessage({ content: [
    { type: 'tool_use', id: 'react', name: 'mcp__agent-teams__group_chat_react', input },
  ] as never })
  const reactionResult = (result: unknown, is_error = false) => createUserMessage({ content: [
    { type: 'tool_result', tool_use_id: 'react', content: JSON.stringify(result), is_error },
  ] as never })
  const scope = { submitUserMessageUuid: 'reaction-submit', teamName: 'sandbox', memberName: 'alice',
    groupChatId: inbound.groupChatId, physicalMessageId: inbound.messageId, canonicalMessageId: inbound.groupMessageId, groupRunKey: inbound.groupRunKey }
  const complete = (messages: Parameters<typeof getOrdinaryProcessingAction>[0]['messages']) => getOrdinaryProcessingAction({
    attempt, messages, processingOrdinaryMessage: createPendingMailboxMirrorMessage(inbound, 'session'), teamName: 'sandbox', memberName: 'alice', now: 1000,
  })

  test('a saved exact current-run acknowledgement consumes the inbound and prevents a plain OK echo', () => {
    const messages = [submitted, useReaction(), reactionResult(saved), plain]
    expect(complete(messages)).toEqual({ type: 'finalize' })
    expect(findGroupMailboxReplyOutcome({ ...scope, messages })).toBe('acknowledged')
    // Neither another canonical message nor a fresh physical delivery can reuse this proof.
    expect(findGroupMailboxReplyOutcome({ ...scope, messages, canonicalMessageId: 'fae7d421-dfd0-4bd3-bc0b-2693fd24b344' })).toBe('none')
    expect(findGroupMailboxReplyOutcome({ ...scope, messages, physicalMessageId: 'fresh-physical' })).toBe('none')
    expect(findGroupMailboxReplyOutcome({ ...scope, messages, groupRunKey: 'other-run:123' })).toBe('none')
    const staleMessages = [submitted, useReaction(), reactionResult({ ...saved, groupRunKey: 'old-run:123' }), plain]
    expect(findGroupMailboxReplyOutcome({ ...scope, messages: staleMessages, groupRunKey: 'old-run:123' })).toBe('none')
  })

  test('failed, pending, malformed and unrelated reactions retain ordinary group text fallback', () => {
    const cases = [
      [useReaction(), reactionResult(saved, true)],
      [useReaction()],
      [useReaction(), reactionResult({ ...saved, saved: false })],
      [useReaction(), reactionResult({ ...saved, acknowledged: false })],
      [useReaction(), reactionResult({ ...saved, from: 'bob' })],
      [useReaction(), reactionResult({ ...saved, teamName: 'another-team' })],
      [useReaction(), reactionResult({ ...saved, groupChatId: 'ef4a2e64-ce6a-419f-9614-0f5a808762c3' })],
      [useReaction(), reactionResult({ ...saved, relayOfMessageId: 'another-physical' })],
      [useReaction(), reactionResult({ ...saved, messageId: 'not-a-UUID' })],
      [useReaction(), reactionResult({ ...saved, groupRunKey: 'old-run:123' })],
      [useReaction({ ...args, from: 'bob' }), reactionResult(saved)],
      [useReaction(), reactionResult('unverifiable')],
    ]
    for (const toolMessages of cases) {
      const messages = [submitted, ...toolMessages, plain]
      expect(findGroupMailboxReplyOutcome({ ...scope, messages })).toBe('none')
      expect(complete(messages)).toEqual({ type: 'deliver_assistant_text', text: 'OK' })
    }
  })

  test('an explicit substantive group send remains authoritative after a successful reaction', () => {
    const messageId = 'fae7d421-dfd0-4bd3-bc0b-2693fd24b344'
    const send = createAssistantMessage({ content: [
      { type: 'tool_use', id: 'send', name: 'group_chat_send', input: { ...args, messageId, text: 'I found a blocking issue' } },
    ] as never })
    const sent = createUserMessage({ content: [
      { type: 'tool_result', tool_use_id: 'send', content: JSON.stringify({ saved: true, groupChatId: inbound.groupChatId, relayOfMessageId: inbound.messageId, groupMessageId: messageId }) },
    ] as never })
    const messages = [submitted, useReaction(), reactionResult(saved), send, sent, plain]
    expect(findGroupMailboxReplyOutcome({ ...scope, messages })).toBe('sent')
    expect(findGroupMailboxReplyOutcome({ ...scope, messages: [submitted, useReaction(), reactionResult(saved), send] })).toBe('pending')
    expect(complete(messages).type).toBe('finalize')
  })
})
