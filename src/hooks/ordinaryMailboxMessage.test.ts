import { describe, expect, test } from 'bun:test'
import { getOrdinaryInlineHandoffPrompt, getOrdinaryProcessingAction } from './useInboxPoller.js'
import { createAssistantMessage, createUserMessage } from '../utils/messages.js'
import { createPendingMailboxMirrorMessage } from './ordinaryMailboxMessage.js'

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
