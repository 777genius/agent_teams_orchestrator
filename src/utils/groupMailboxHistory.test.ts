import { expect, test } from 'bun:test'
import { selectGroupMailboxHistory, findGroupMailboxOwnPostProofs, type GroupMailboxHistoryMessage, type GroupMailboxHostTurn } from './groupMailbox.js'
import { createAssistantMessage, createUserMessage } from './messages.js'
import { getOrdinaryInlineHandoffPrompt } from '../hooks/useInboxPoller.js'

const row = (id: string, changes: Partial<GroupMailboxHistoryMessage> = {}): GroupMailboxHistoryMessage => ({
  from: 'user', to: 'worker', text: 'After the peer answer, send DONE.', timestamp: '2026-10-26T00:00:00Z', read: true,
  messageId: id, groupMessageId: 'canonical-' + id, groupChatId: 'group', groupRunKey: 'run',
  groupChatProtocolVersion: 1, groupRecipientRunKeys: { worker: 'run' }, ...changes,
})

test('new native group turn receives only earlier finalized same-group/run/receiver context', () => {
  const human = row('human')
  const current = row('answer', { text: 'follow-up', read: false })
  const rows = [human,
    row('private', { groupChatId: undefined, text: 'private secret' }),
    row('other-group', { groupChatId: 'other', text: 'other-group secret' }),
    row('old-run', { groupRunKey: 'old', text: 'old-run secret' }),
    row('other-recipient', { groupRecipientRunKeys: { someone: 'run' }, text: 'other-recipient secret' }),
    row('wrong-to', { to: 'other', text: 'wrong-to secret' }),
    row('unread', { read: false, text: 'not processed' }), current,
    row('future', { text: 'future secret' }),
  ]
  expect(selectGroupMailboxHistory(current, 'worker', rows)).toEqual([
    { from: human.from, text: human.text, messageId: human.messageId, timestamp: human.timestamp },
  ])
  const prompt = getOrdinaryInlineHandoffPrompt({ ...current, memberName: 'worker', teamName: 'TEST', groupHistory: rows })
  expect(prompt).toContain('After the peer answer, send DONE.')
  expect(prompt).toContain('Physical inbound ID: "answer"')
  expect(prompt).not.toContain('secret')
  expect(prompt).not.toContain('not processed')
  expect(selectGroupMailboxHistory(current, 'worker', [...rows, current])).toEqual([])
  expect(selectGroupMailboxHistory(current, 'worker', [human])).toEqual([])
})

test('group context keeps whole recent rows within both count and UTF-8 budgets', () => {
  const current = row('current', { read: false })
  const rows = Array.from({ length: 20 }, (_, index) => row(String(index), { text: 'контекст'.repeat(100) }))
  const selected = selectGroupMailboxHistory(current, 'worker', [...rows, current])
  expect(selected).toHaveLength(8)
  expect(selected[0]?.messageId).toBe('12')
  expect(Buffer.byteLength(JSON.stringify(selected), 'utf8')).toBeLessThanOrEqual(16 * 1024)
  expect(selectGroupMailboxHistory(current, 'worker', [row('large', { text: 'я'.repeat(20000) }), current])).toEqual([])
})

test('history includes only own saved canonical replies linked to this receiver run, keeping pairs intact', () => {
  const human = row('human')
  const current = row('answer', { from: 'peer', text: '15', read: false, relayOfMessageId: 'question-for-peer' })
  const sent = row('own-question', { from: 'worker', to: 'user', source: 'runtime_delivery',
    groupMessageId: 'own-question', relayOfMessageId: 'human', text: 'What is 5+10?',
    groupDeliverySummary: { recipients: [{ memberName: 'peer', physicalMessageId: 'question-for-peer', status: 'queued' }] } })
  const secret = (id: string, changes: Partial<GroupMailboxHistoryMessage>) => ({ ...sent, messageId: id, groupMessageId: id, text: 'secret', ...changes })
  const selected = selectGroupMailboxHistory(current, 'worker', [row('unrelated', { text: 'unrelated old human command' }), human, current], [sent,
    secret('other-sender', { from: 'other' }), secret('private', { groupChatId: undefined }),
    secret('not-canonical', { groupMessageId: 'canonical-other' }), secret('current', { relayOfMessageId: current.messageId }),
    secret('stale', { relayOfMessageId: 'old-run-inbound' }), secret('wrong-to', { to: 'someone' }),
  ])
  expect(selected.map(row => row.text)).toEqual([human.text, sent.text])
  for (const status of ['failed', 'unknown', 'skipped', undefined]) expect(selectGroupMailboxHistory(current, 'worker', [human, current], [{ ...sent, groupDeliverySummary: { recipients: [{ memberName: 'peer', physicalMessageId: 'question-for-peer', status }] } }])).toEqual([])
  expect(selectGroupMailboxHistory({ ...current, relayOfMessageId: 'human-copy-for-peer' }, 'worker', [human, { ...current, relayOfMessageId: 'human-copy-for-peer' }], [sent])).toEqual([])
  expect(selectGroupMailboxHistory(current, 'worker', [human, current], [{ ...sent, groupDeliverySummary: { recipients: [{ memberName: 'someone', physicalMessageId: 'question-for-peer', status: 'queued' }] } }])).toEqual([])
  const tooLargeReply = { ...sent, text: 'x'.repeat(20000) }
  expect(selectGroupMailboxHistory(current, 'worker', [human, current], [tooLargeReply])).toEqual([])
})


test('a finalized host-owned turn retains its successful proactive DONE beside the causal question', () => {
  const human = row('human')
  const current = row('answer', { from: 'peer', text: '15', read: false, relayOfMessageId: 'question-for-peer' })
  const question = row('question', { from: 'worker', to: 'user', source: 'runtime_delivery',
    groupMessageId: 'question', relayOfMessageId: 'human', text: 'QUESTION: 5+10?',
    groupDeliverySummary: { recipients: [{ memberName: 'peer', physicalMessageId: 'question-for-peer', status: 'queued' }] } })
  const doneId = 'c764ac80-2996-40ef-9511-446a72abc117'
  const done = row(doneId, { from: 'worker', to: 'user', source: 'runtime_delivery',
    groupMessageId: doneId, relayOfMessageId: undefined, text: 'DONE:15' })
  const submitted = createUserMessage({ content: 'host group prompt', uuid: 'accepted-host-turn' })
  const args = { teamName: 'TEST', from: 'worker', groupChatId: 'group', messageId: doneId, text: done.text }
  const call = createAssistantMessage({ content: [{ type: 'tool_use', id: 'send-done', name: 'mcp__agent-teams__group_chat_send', input: args }] as never })
  const receipt = { saved: true, groupChatId: 'group', messageId: doneId }
  const result = (value: unknown = receipt, isError = false) => createUserMessage({ content: [{
    type: 'tool_result', tool_use_id: 'send-done', content: JSON.stringify(value), is_error: isError,
  }] as never })
  const turn: GroupMailboxHostTurn = { submitUserMessageUuid: submitted.uuid, teamName: 'TEST', memberName: 'worker',
    groupChatId: 'group', groupRunKey: 'run', physicalMessageId: human.messageId! }
  const input = { messages: [submitted, call, result()], turns: [turn], teamName: 'TEST', memberName: 'worker',
    current, history: [human, current], sentHistory: [question, done] }
  const proofs = findGroupMailboxOwnPostProofs(input)
  expect(proofs).toEqual([{ messageId: doneId, inboundMessageId: 'human' }])
  expect(selectGroupMailboxHistory(current, 'worker', input.history, input.sentHistory, proofs).map(entry => entry.text))
    .toEqual([human.text, question.text, done.text])
  expect(findGroupMailboxOwnPostProofs({ ...input, messages: [submitted, call, result({ ...receipt, relayOfMessageId: null })] })).toEqual(proofs)
  // Official MCP envelope succeeds too; model prose or a bare historical canonical row grants no proof.
  expect(findGroupMailboxOwnPostProofs({ ...input, messages: [submitted, call, result({ content: [{ type: 'text', text: JSON.stringify(receipt) }] })] })).toEqual(proofs)
  for (const badTurn of [{ ...turn, groupRunKey: 'old' }, { ...turn, memberName: 'other' },
    { ...turn, teamName: 'other' }, { ...turn, groupChatId: 'other' }, { ...turn, submitUserMessageUuid: 'unseen' }])
    expect(findGroupMailboxOwnPostProofs({ ...input, turns: [badTurn] })).toEqual([])
  expect(findGroupMailboxOwnPostProofs({ ...input, turns: [] })).toEqual([])
  expect(findGroupMailboxOwnPostProofs({ ...input, history: [{ ...human, read: false }, current] })).toEqual([])
  expect(findGroupMailboxOwnPostProofs({ ...input, history: [{ ...human, to: 'other' }, current] })).toEqual([])
  for (const badResult of [result(receipt, true), result({ ...receipt, saved: false }),
    result({ ...receipt, messageId: 'foreign' }), result({ isError: true, structuredContent: receipt })])
    expect(findGroupMailboxOwnPostProofs({ ...input, messages: [submitted, call, badResult] })).toEqual([])
  expect(findGroupMailboxOwnPostProofs({ ...input, messages: [submitted, createUserMessage({ content: 'next turn' }), call, result()] })).toEqual([])
  for (const badDone of [{ ...done, text: 'different' }, { ...done, from: 'other' },
    { ...done, groupChatId: 'other' }, { ...done, to: 'other' }])
    expect(findGroupMailboxOwnPostProofs({ ...input, sentHistory: [question, badDone] })).toEqual([])
  // The completion cannot be dropped while replaying its old human command.
  expect(selectGroupMailboxHistory(current, 'worker', input.history,
    [question, { ...done, text: 'x'.repeat(20000) }], proofs)).toEqual([])
  // Proactive proof never authorizes sibling answers to replay old human instructions.
  const sibling = { ...current, relayOfMessageId: 'human-for-peer' }
  expect(selectGroupMailboxHistory(sibling, 'worker', [human, sibling], input.sentHistory, proofs)).toEqual([])
})
