import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

import { observeOpenCodeDeliveryResponse } from './OpenCodeDeliveryResponseObserver.js'

import type {
  OpenCodeCanonicalMessage,
  OpenCodeCanonicalToolStatus,
  OpenCodeSessionReconcileSummary,
} from './types.js'

test('named group reply proof requires exact group, sender, team and physical relay; blocked and proactive never become a private reply', () => {
  const groupChatId = '3695a573-5ad2-469a-91f2-427f90792e11'
  const physical = '0bdf10f0-3fd3-4494-a974-b394de06c181'
  const replyId = 'fae7d421-dfd0-4bd3-bc0b-2693fd24b344'
  const input = { groupChatId, from: 'alice', teamName: 'synthetic-groups', relayOfMessageId: physical, messageId: replyId }
  const receipt = { saved: true, groupChatId, groupMessageId: replyId, relayOfMessageId: physical }
  const user = message({ id: 'delivered-group', role: 'user', text: physical })
  const observe = (toolName: string, args = input, output: unknown = receipt, status: OpenCodeCanonicalToolStatus = 'completed') => observeOpenCodeDeliveryResponse({
    inboundMessageId: physical, runtimePromptMessageId: user.id, groupChatId, memberName: 'alice', teamName: 'synthetic-groups',
    summary: summary([user, message({ id: 'group-answer', parentId: user.id, role: 'assistant', text: '[[AGENT_TEAMS_NO_REPLY]]', toolCalls: [{
      callId: 'group-send', toolName, input: args, output, outputText: null, status, title: null, isError: status === 'errored', outputPreview: null, startedAt: null, completedAt: null,
    }] })]),
  })
  for (const prefix of ['', 'agent-teams_', 'agent_teams_', 'mcp__agent-teams__', 'mcp__agent_teams__', 'proxy_agent-teams_', 'proxy_agent_teams_', 'proxy_mcp__agent-teams__', 'proxy_mcp__agent_teams__']) {
    const proof = observe(`${prefix}group_chat_send`)
    expect(proof.state).toBe('responded_visible_message')
    expect(proof.visibleReplyMessageId).toBe(replyId)
  }
  for (const args of [{ ...input, groupChatId: 'ef4a2e64-ce6a-419f-9614-0f5a808762c3' }, { ...input, from: 'bob' }, { ...input, teamName: 'other-team' }, { ...input, relayOfMessageId: 'other-physical' }]) {
    expect(observe('agent-teams_group_chat_send', args).reason).toBe('group_reply_blocked')
  }
  expect(observe('agent-teams_group_chat_send', input, { code: 'GROUP_ARCHIVED' }, 'errored').state).toBe('tool_error')
  expect(observe('agent-teams_message_send', input).reason).toBe('group_reply_blocked')
})

function message(input: Partial<OpenCodeCanonicalMessage> & { id: string; role: OpenCodeCanonicalMessage['role'] }): OpenCodeCanonicalMessage {
  return {
    id: input.id,
    parentId: input.parentId ?? null,
    role: input.role,
    agent: null,
    providerId: null,
    modelId: null,
    createdAt: null,
    completedAt: input.completedAt ?? null,
    text: input.text ?? '',
    reasoningText: input.reasoningText ?? '',
    previewText: input.previewText ?? null,
    partTypes: input.partTypes ?? [],
    reasoningPartCount: input.reasoningPartCount ?? 0,
    toolCalls: input.toolCalls ?? [],
    contentBlocks: input.contentBlocks ?? [],
    finishReason: input.finishReason ?? null,
    errorName: input.errorName ?? null,
    errorMessage: input.errorMessage ?? null,
    hasError: input.hasError ?? false,
  }
}

function summary(messages: OpenCodeCanonicalMessage[], rawStatus: OpenCodeSessionReconcileSummary['rawStatus'] = 'idle'): OpenCodeSessionReconcileSummary {
  return {
    sessionId: 'session-1',
    reconcileOutcome: 'reconciled',
    rawStatus,
    durableState: rawStatus === 'busy' ? 'running' : 'idle',
    staleReason: null,
    profileAuthState: null,
    pendingPermissionRequestIds: [],
    messageCount: messages.length,
    toolCallCount: messages.reduce((count, item) => count + item.toolCalls.length, 0),
    errorCount: messages.filter(item => item.hasError).length,
    lastCanonicalCursor: messages[messages.length - 1]?.id ?? null,
    latestUserMessageId: [...messages].reverse().find(item => item.role === 'user')?.id ?? null,
    latestAssistantMessageId: [...messages].reverse().find(item => item.role === 'assistant')?.id ?? null,
    latestAssistantText: [...messages].reverse().find(item => item.role === 'assistant')?.text ?? null,
    latestAssistantPreview:
      [...messages].reverse().find(item => item.role === 'assistant')?.previewText ?? null,
    replyPendingSinceMessageId: null,
    messages,
    diagnostics: [],
  }
}

function relayWorksJackFixtureSummary(): OpenCodeSessionReconcileSummary {
  const fixture = JSON.parse(
    readFileSync(
      new URL('./fixtures/relay-works-10-jack-canonical-transcript.json', import.meta.url),
      'utf8',
    ),
  ) as {
    transcript: {
      sessionId: string
      durableState?: OpenCodeSessionReconcileSummary['durableState']
      messageCount: number
      toolCallCount: number
      errorCount: number
      messages: OpenCodeCanonicalMessage[]
    }
  }
  return {
    sessionId: fixture.transcript.sessionId,
    reconcileOutcome: 'reconciled',
    rawStatus: 'idle',
    durableState: fixture.transcript.durableState ?? 'idle',
    staleReason: null,
    profileAuthState: null,
    pendingPermissionRequestIds: [],
    messageCount: fixture.transcript.messageCount,
    toolCallCount: fixture.transcript.toolCallCount,
    errorCount: fixture.transcript.errorCount,
    lastCanonicalCursor: fixture.transcript.messages.at(-1)?.id ?? null,
    latestUserMessageId:
      [...fixture.transcript.messages].reverse().find(item => item.role === 'user')?.id ?? null,
    latestAssistantMessageId:
      [...fixture.transcript.messages].reverse().find(item => item.role === 'assistant')?.id ?? null,
    latestAssistantText:
      [...fixture.transcript.messages].reverse().find(item => item.role === 'assistant')?.text ?? null,
    latestAssistantPreview:
      [...fixture.transcript.messages].reverse().find(item => item.role === 'assistant')?.previewText ?? null,
    replyPendingSinceMessageId: null,
    messages: fixture.transcript.messages,
    diagnostics: [],
  }
}

describe('OpenCodeDeliveryResponseObserver', () => {
  test('classifies empty assistant child as unanswered', () => {
    const observed = observeOpenCodeDeliveryResponse({
      inboundMessageId: 'msg-inbound-1',
      summary: summary([
        message({
          id: 'user-1',
          role: 'user',
          text: 'The inbound app messageId is "msg-inbound-1". Please reply.',
        }),
        message({
          id: 'assistant-1',
          role: 'assistant',
          parentId: 'user-1',
        }),
      ]),
    })

    expect(observed.state).toBe('empty_assistant_turn')
    expect(observed.deliveredUserMessageId).toBe('user-1')
  })

  test.each([undefined, 'group-1'])('distinguishes an explicitly completed silent child from unanswered work (group %s)', groupChatId => {
    const user = message({ id: 'accepted-peer-prompt', role: 'user', text: 'Peer FYI' })
    const child = message({
      id: 'silent-peer-child', parentId: user.id, role: 'assistant',
      completedAt: 1791609686528, finishReason: 'stop',
    })
    const observe = (children = [child], rawStatus: OpenCodeSessionReconcileSummary['rawStatus'] = 'idle') =>
      observeOpenCodeDeliveryResponse({
        inboundMessageId: 'physical-peer', runtimePromptMessageId: user.id,
        groupChatId, memberName: 'alice', teamName: 'team',
        summary: summary([user, ...children], rawStatus),
      })
    const proof = observe()
    expect(proof.state).toBe('empty_assistant_turn')
    expect(proof.reason).toBe('assistant_child_completed_without_visible_or_meaningful_response')
    expect(proof.deliveredUserMessageId).toBe(user.id)
    expect(proof.assistantMessageId).toBe(child.id)
    // Successful provider status maps may omit this completed session.
    // Completion comes from the exact child, never from the missing entry.
    expect(observe([child], null).reason).toBe(proof.reason)
    for (const rawStatus of ['busy', 'retry'] as const) {
      expect(observe([child], rawStatus).reason).not.toBe(proof.reason)
    }
    for (const incomplete of [
      { completedAt: null }, { completedAt: 0 }, { completedAt: NaN },
      { finishReason: null }, { finishReason: 'length' },
      { hasError: true, errorMessage: 'provider failed' },
    ]) {
      expect(observe([{ ...child, ...incomplete }]).reason).not.toBe(proof.reason)
      expect(observe([{ ...child, ...incomplete }], null).reason).not.toBe(proof.reason)
    }
    expect(observe([]).reason).toBe('no_assistant_child_for_delivered_prompt')
    expect(observe([{ ...child, parentId: 'another-session-prompt' }]).reason).not.toBe(proof.reason)
    const stale = summary([user, child])
    stale.reconcileOutcome = 'stale'
    stale.staleReason = 'runtime_session_changed'
    expect(observeOpenCodeDeliveryResponse({ runtimePromptMessageId: user.id, summary: stale }).state).toBe('session_stale')
    expect(observeOpenCodeDeliveryResponse({
      runtimePromptMessageId: 'different-session-prompt', groupChatId,
      summary: summary([user, child]),
    }).reason).not.toBe(proof.reason)
  })

  test('classifies message_send with relayOfMessageId as correlated visible reply', () => {
    const observed = observeOpenCodeDeliveryResponse({
      inboundMessageId: 'msg-inbound-2',
      summary: summary([
        message({
          id: 'user-2',
          role: 'user',
          text: 'The inbound app messageId is "msg-inbound-2". Please reply.',
        }),
        message({
          id: 'assistant-2',
          role: 'assistant',
          parentId: 'user-2',
          toolCalls: [
            {
              callId: 'tool-1',
              toolName: 'agent-teams_message_send',
              title: null,
              status: 'completed',
              input: { relayOfMessageId: 'msg-inbound-2' },
              output: null,
              outputText: null,
              outputPreview: null,
              startedAt: null,
              completedAt: null,
              isError: false,
            },
          ],
        }),
      ]),
    })

    expect(observed.state).toBe('responded_visible_message')
    expect(observed.visibleReplyCorrelation).toBe('relayOfMessageId')
    expect(observed.visibleReplyMissingRelayOfMessageId).toBe(false)
  })

  test('extracts visible reply ids from completed message_send output', () => {
    const observed = observeOpenCodeDeliveryResponse({
      inboundMessageId: 'msg-inbound-output',
      summary: summary([
        message({
          id: 'user-output',
          role: 'user',
          text: 'The inbound app messageId is "msg-inbound-output". Please reply.',
        }),
        message({
          id: 'assistant-output',
          role: 'assistant',
          parentId: 'user-output',
          toolCalls: [
            {
              callId: 'tool-output',
              toolName: 'agent-teams_message_send',
              title: null,
              status: 'completed',
              input: {},
              output: {
                deliveredToInbox: true,
                message: {
                  messageId: 'reply-output-1',
                  relayOfMessageId: 'msg-inbound-output',
                },
              },
              outputText: null,
              outputPreview: null,
              startedAt: null,
              completedAt: null,
              isError: false,
            },
          ],
        }),
      ]),
    })

    expect(observed.state).toBe('responded_visible_message')
    expect(observed.visibleReplyMessageId).toBe('reply-output-1')
    expect(observed.visibleReplyCorrelation).toBe('relayOfMessageId')
    expect(observed.reason).toBeNull()
  })

  test('prefers later completed message_send over earlier MCP connection errors', () => {
    const observed = observeOpenCodeDeliveryResponse({
      inboundMessageId: 'msg-inbound-late-success',
      summary: summary([
        message({
          id: 'user-late-success',
          role: 'user',
          text: 'The inbound app messageId is "msg-inbound-late-success". Please reply.',
        }),
        message({
          id: 'assistant-late-error',
          role: 'assistant',
          parentId: 'user-late-success',
          toolCalls: [
            {
              callId: 'tool-error',
              toolName: 'agent-teams_message_send',
              title: null,
              status: 'errored',
              input: { relayOfMessageId: 'msg-inbound-late-success' },
              output: null,
              outputText: 'Not connected',
              outputPreview: null,
              startedAt: null,
              completedAt: null,
              isError: true,
            },
          ],
        }),
        message({
          id: 'assistant-late-success',
          role: 'assistant',
          parentId: 'user-late-success',
          toolCalls: [
            {
              callId: 'tool-success',
              toolName: 'agent-teams_message_send',
              title: null,
              status: 'completed',
              input: { relayOfMessageId: 'msg-inbound-late-success' },
              output: {
                deliveredToInbox: true,
                messageId: 'reply-late-success',
              },
              outputText: null,
              outputPreview: null,
              startedAt: null,
              completedAt: null,
              isError: false,
            },
          ],
        }),
      ]),
    })

    expect(observed.state).toBe('responded_visible_message')
    expect(observed.assistantMessageId).toBe('assistant-late-success')
    expect(observed.visibleReplyMessageId).toBe('reply-late-success')
    expect(observed.reason).toBeNull()
  })

  test('classifies task tool as non-visible response proof', () => {
    const observed = observeOpenCodeDeliveryResponse({
      inboundMessageId: 'msg-inbound-3',
      summary: summary([
        message({
          id: 'user-3',
          role: 'user',
          text: 'The inbound app messageId is "msg-inbound-3". Start task.',
        }),
        message({
          id: 'assistant-3',
          role: 'assistant',
          parentId: 'user-3',
          toolCalls: [
            {
              callId: 'tool-2',
              toolName: 'mcp__agent-teams__task_start',
              title: null,
              status: 'completed',
              input: { taskId: 'task-1' },
              output: null,
              outputText: null,
              outputPreview: null,
              startedAt: null,
              completedAt: null,
              isError: false,
            },
          ],
        }),
      ]),
    })

    expect(observed.state).toBe('responded_non_visible_tool')
    expect(observed.toolCallNames).toContain('task_start')
  })

  test('classifies member work sync report as non-visible response proof', () => {
    const observed = observeOpenCodeDeliveryResponse({
      inboundMessageId: 'msg-work-sync-report',
      summary: summary([
        message({
          id: 'user-work-sync-report',
          role: 'user',
          text: 'The inbound app messageId is "msg-work-sync-report". Run work sync.',
        }),
        message({
          id: 'assistant-work-sync-report',
          role: 'assistant',
          parentId: 'user-work-sync-report',
          toolCalls: [
            {
              callId: 'tool-work-sync-report',
              toolName: 'mcp__agent-teams__member_work_sync_report',
              title: null,
              status: 'completed',
              input: { reportToken: 'token-1', agendaFingerprint: 'fingerprint-1' },
              output: null,
              outputText: null,
              outputPreview: null,
              startedAt: null,
              completedAt: null,
              isError: false,
            },
          ],
        }),
      ]),
    })

    expect(observed.state).toBe('responded_non_visible_tool')
    expect(observed.toolCallNames).toContain('member_work_sync_report')
  })

  test('does not classify rejected member work sync report as response proof', () => {
    const observed = observeOpenCodeDeliveryResponse({
      inboundMessageId: 'msg-work-sync-report-rejected',
      summary: summary([
        message({
          id: 'user-work-sync-report-rejected',
          role: 'user',
          text: 'The inbound app messageId is "msg-work-sync-report-rejected". Run work sync.',
        }),
        message({
          id: 'assistant-work-sync-report-rejected',
          role: 'assistant',
          parentId: 'user-work-sync-report-rejected',
          text: 'Report rejected, retrying status.',
          toolCalls: [
            {
              callId: 'tool-work-sync-report-rejected',
              toolName: 'mcp__agent-teams__member_work_sync_report',
              title: null,
              status: 'completed',
              input: { reportToken: 'token-1', agendaFingerprint: 'fingerprint-1' },
              output: { accepted: false, code: 'stale_agenda_fingerprint' },
              outputText: null,
              outputPreview: null,
              startedAt: null,
              completedAt: null,
              isError: false,
            },
          ],
        }),
      ]),
    })

    expect(observed.state).toBe('tool_error')
    expect(observed.reason).toBe('member_work_sync_report_rejected')
    expect(observed.toolCallNames).toContain('member_work_sync_report')
  })

  test('detects nested rejected member work sync report output', () => {
    const observed = observeOpenCodeDeliveryResponse({
      inboundMessageId: 'msg-work-sync-report-nested-rejected',
      summary: summary([
        message({
          id: 'user-work-sync-report-nested-rejected',
          role: 'user',
          text: 'The inbound app messageId is "msg-work-sync-report-nested-rejected". Run work sync.',
        }),
        message({
          id: 'assistant-work-sync-report-nested-rejected',
          role: 'assistant',
          parentId: 'user-work-sync-report-nested-rejected',
          toolCalls: [
            {
              callId: 'tool-work-sync-report-nested-rejected',
              toolName: 'mcp__agent-teams__member_work_sync_report',
              title: null,
              status: 'completed',
              input: { reportToken: 'token-1', agendaFingerprint: 'fingerprint-1' },
              output: { result: { accepted: false, code: 'report_token_invalid' } },
              outputText: null,
              outputPreview: null,
              startedAt: null,
              completedAt: null,
              isError: false,
            },
          ],
        }),
      ]),
    })

    expect(observed.state).toBe('tool_error')
    expect(observed.reason).toBe('member_work_sync_report_rejected')
  })

  test('rejected member work sync report overrides a visible message_send proof', () => {
    const observed = observeOpenCodeDeliveryResponse({
      inboundMessageId: 'msg-work-sync-report-rejected-visible',
      summary: summary([
        message({
          id: 'user-work-sync-report-rejected-visible',
          role: 'user',
          text: 'The inbound app messageId is "msg-work-sync-report-rejected-visible". Run work sync.',
        }),
        message({
          id: 'assistant-work-sync-report-rejected-visible',
          role: 'assistant',
          parentId: 'user-work-sync-report-rejected-visible',
          toolCalls: [
            {
              callId: 'tool-message-send-before-rejected-report',
              toolName: 'agent-teams_message_send',
              title: null,
              status: 'completed',
              input: {
                relayOfMessageId: 'msg-work-sync-report-rejected-visible',
                text: 'I am still working.',
              },
              output: { messageId: 'reply-1' },
              outputText: null,
              outputPreview: null,
              startedAt: null,
              completedAt: null,
              isError: false,
            },
            {
              callId: 'tool-work-sync-report-rejected-visible',
              toolName: 'mcp__agent-teams__member_work_sync_report',
              title: null,
              status: 'completed',
              input: { reportToken: 'token-1', agendaFingerprint: 'fingerprint-1' },
              output: { accepted: false, code: 'report_token_invalid' },
              outputText: null,
              outputPreview: null,
              startedAt: null,
              completedAt: null,
              isError: false,
            },
          ],
        }),
      ]),
    })

    expect(observed.state).toBe('tool_error')
    expect(observed.reason).toBe('member_work_sync_report_rejected')
    expect(observed.toolCallNames).toContain('message_send')
    expect(observed.toolCallNames).toContain('member_work_sync_report')
  })

  test('later accepted member work sync report overrides an earlier rejected report', () => {
    const observed = observeOpenCodeDeliveryResponse({
      inboundMessageId: 'msg-work-sync-report-retry-accepted',
      summary: summary([
        message({
          id: 'user-work-sync-report-retry-accepted',
          role: 'user',
          text: 'The inbound app messageId is "msg-work-sync-report-retry-accepted". Run work sync.',
        }),
        message({
          id: 'assistant-work-sync-report-retry-rejected',
          role: 'assistant',
          parentId: 'user-work-sync-report-retry-accepted',
          text: 'First report was stale, retrying with fresh status.',
          toolCalls: [
            {
              callId: 'tool-work-sync-report-retry-rejected',
              toolName: 'mcp__agent-teams__member_work_sync_report',
              title: null,
              status: 'completed',
              input: { state: 'still_working' },
              output: { accepted: false, code: 'stale_agenda_fingerprint' },
              outputText: null,
              outputPreview: null,
              startedAt: null,
              completedAt: null,
              isError: false,
            },
          ],
        }),
        message({
          id: 'assistant-work-sync-report-retry-accepted',
          role: 'assistant',
          parentId: 'user-work-sync-report-retry-accepted',
          toolCalls: [
            {
              callId: 'tool-work-sync-report-retry-accepted',
              toolName: 'mcp__agent-teams__member_work_sync_report',
              title: null,
              status: 'completed',
              input: { state: 'still_working' },
              output: { accepted: true, state: 'still_working' },
              outputText: null,
              outputPreview: null,
              startedAt: null,
              completedAt: null,
              isError: false,
            },
          ],
        }),
      ]),
    })

    expect(observed.state).toBe('responded_non_visible_tool')
    expect(observed.reason).toBeNull()
    expect(observed.assistantMessageId).toBe('assistant-work-sync-report-retry-accepted')
    expect(observed.toolCallNames).toContain('member_work_sync_report')
  })

  test('detects wrapped rejected member work sync report output', () => {
    const observed = observeOpenCodeDeliveryResponse({
      inboundMessageId: 'msg-work-sync-report-wrapped-rejected',
      summary: summary([
        message({
          id: 'user-work-sync-report-wrapped-rejected',
          role: 'user',
          text: 'The inbound app messageId is "msg-work-sync-report-wrapped-rejected". Run work sync.',
        }),
        message({
          id: 'assistant-work-sync-report-wrapped-rejected',
          role: 'assistant',
          parentId: 'user-work-sync-report-wrapped-rejected',
          toolCalls: [
            {
              callId: 'tool-work-sync-report-wrapped-rejected',
              toolName: 'mcp__agent-teams__member_work_sync_report',
              title: null,
              status: 'completed',
              input: { reportToken: 'token-1', agendaFingerprint: 'fingerprint-1' },
              output: null,
              outputText: [
                'Debug context:',
                JSON.stringify({ tool: 'member_work_sync_report' }),
                'Result:',
                JSON.stringify({ accepted: false, code: 'report_token_invalid' }),
              ].join('\n'),
              outputPreview: null,
              startedAt: null,
              completedAt: null,
              isError: false,
            },
          ],
        }),
      ]),
    })

    expect(observed.state).toBe('tool_error')
    expect(observed.reason).toBe('member_work_sync_report_rejected')
  })

  test('detects plain-text rejected member work sync report output', () => {
    const observed = observeOpenCodeDeliveryResponse({
      inboundMessageId: 'msg-work-sync-report-text-rejected',
      summary: summary([
        message({
          id: 'user-work-sync-report-text-rejected',
          role: 'user',
          text: 'The inbound app messageId is "msg-work-sync-report-text-rejected". Run work sync.',
        }),
        message({
          id: 'assistant-work-sync-report-text-rejected',
          role: 'assistant',
          parentId: 'user-work-sync-report-text-rejected',
          toolCalls: [
            {
              callId: 'tool-work-sync-report-text-rejected',
              toolName: 'mcp__agent-teams__member_work_sync_report',
              title: null,
              status: 'completed',
              input: { reportToken: 'token-1', agendaFingerprint: 'fingerprint-1' },
              output: null,
              outputText: 'Report rejected. Call member_work_sync_status again.',
              outputPreview: null,
              startedAt: null,
              completedAt: null,
              isError: false,
            },
          ],
        }),
      ]),
    })

    expect(observed.state).toBe('tool_error')
    expect(observed.reason).toBe('member_work_sync_report_rejected')
  })

  test('detects plain-text stale member work sync report output', () => {
    const observed = observeOpenCodeDeliveryResponse({
      inboundMessageId: 'msg-work-sync-report-text-stale',
      summary: summary([
        message({
          id: 'user-work-sync-report-text-stale',
          role: 'user',
          text: 'The inbound app messageId is "msg-work-sync-report-text-stale". Run work sync.',
        }),
        message({
          id: 'assistant-work-sync-report-text-stale',
          role: 'assistant',
          parentId: 'user-work-sync-report-text-stale',
          toolCalls: [
            {
              callId: 'tool-work-sync-report-text-stale',
              toolName: 'mcp__agent-teams__member_work_sync_report',
              title: null,
              status: 'completed',
              input: { reportToken: 'token-1', agendaFingerprint: 'fingerprint-1' },
              output: null,
              outputText: 'Report fingerprint is stale. Read current member work sync status and retry.',
              outputPreview: null,
              startedAt: null,
              completedAt: null,
              isError: false,
            },
          ],
        }),
      ]),
    })

    expect(observed.state).toBe('tool_error')
    expect(observed.reason).toBe('member_work_sync_report_rejected')
  })

  test('normalizes underscore-prefixed member work sync report tools', () => {
    const observed = observeOpenCodeDeliveryResponse({
      inboundMessageId: 'msg-work-sync-report-underscore',
      summary: summary([
        message({
          id: 'user-work-sync-report-underscore',
          role: 'user',
          text: 'The inbound app messageId is "msg-work-sync-report-underscore". Run work sync.',
        }),
        message({
          id: 'assistant-work-sync-report-underscore',
          role: 'assistant',
          parentId: 'user-work-sync-report-underscore',
          toolCalls: [
            {
              callId: 'tool-work-sync-report-underscore',
              toolName: 'mcp__agent_teams__member_work_sync_report',
              title: null,
              status: 'completed',
              input: { reportToken: 'token-1', agendaFingerprint: 'fingerprint-1' },
              output: null,
              outputText: null,
              outputPreview: null,
              startedAt: null,
              completedAt: null,
              isError: false,
            },
          ],
        }),
      ]),
    })

    expect(observed.state).toBe('responded_non_visible_tool')
    expect(observed.toolCallNames).toContain('member_work_sync_report')
  })

  test('normalizes plain message_send as a visible reply and reports missing relay correlation', () => {
    const observed = observeOpenCodeDeliveryResponse({
      inboundMessageId: 'msg-inbound-4',
      summary: summary([
        message({
          id: 'user-4',
          role: 'user',
          text: 'The inbound app messageId is "msg-inbound-4". Please reply.',
        }),
        message({
          id: 'assistant-4',
          role: 'assistant',
          parentId: 'user-4',
          toolCalls: [
            {
              callId: 'tool-plain-message-send',
              toolName: 'message_send',
              title: null,
              status: 'completed',
              input: { to: 'user', from: 'jack', text: 'Done.' },
              output: null,
              outputText: null,
              outputPreview: null,
              startedAt: null,
              completedAt: null,
              isError: false,
            },
          ],
        }),
      ]),
    })

    expect(observed.state).toBe('responded_visible_message')
    expect(observed.visibleReplyCorrelation).toBe('direct_child_message_send')
    expect(observed.visibleReplyMissingRelayOfMessageId).toBe(true)
    expect(observed.reason).toBe('visible_reply_missing_relayOfMessageId')
  })

  test('does not count bootstrap-only tool calls as delivery response proof', () => {
    const observed = observeOpenCodeDeliveryResponse({
      inboundMessageId: 'msg-inbound-5',
      summary: summary([
        message({
          id: 'user-5',
          role: 'user',
          text: 'The inbound app messageId is "msg-inbound-5". Please answer.',
        }),
        message({
          id: 'assistant-5',
          role: 'assistant',
          parentId: 'user-5',
          toolCalls: [
            {
              callId: 'tool-bootstrap',
              toolName: 'agent-teams_member_briefing',
              title: null,
              status: 'completed',
              input: { teamName: 'team-a', memberName: 'jack' },
              output: null,
              outputText: null,
              outputPreview: null,
              startedAt: null,
              completedAt: null,
              isError: false,
            },
          ],
        }),
      ]),
    })

    expect(observed.state).toBe('empty_assistant_turn')
    expect(observed.toolCallNames).toContain('member_briefing')
  })

  test('does not mark errored message_send as a visible reply', () => {
    const observed = observeOpenCodeDeliveryResponse({
      inboundMessageId: 'msg-inbound-6',
      summary: summary([
        message({
          id: 'user-6',
          role: 'user',
          text: 'The inbound app messageId is "msg-inbound-6". Please reply.',
        }),
        message({
          id: 'assistant-6',
          role: 'assistant',
          parentId: 'user-6',
          toolCalls: [
            {
              callId: 'tool-message-error',
              toolName: 'mcp__agent-teams__message_send',
              title: null,
              status: 'errored',
              input: { relayOfMessageId: 'msg-inbound-6' },
              output: null,
              outputText: 'tool failed',
              outputPreview: null,
              startedAt: null,
              completedAt: null,
              isError: true,
            },
          ],
        }),
      ]),
    })

    expect(observed.state).toBe('tool_error')
    expect(observed.reason).toBe('meaningful_tool_call_failed')
  })

  test('classifies plain assistant continuation after errored message_send as fallback response proof', () => {
    const observed = observeOpenCodeDeliveryResponse({
      inboundMessageId: 'msg-inbound-fallback',
      summary: summary([
        message({
          id: 'user-fallback',
          role: 'user',
          text: 'The inbound app messageId is "msg-inbound-fallback". Please reply.',
        }),
        message({
          id: 'assistant-fallback-error',
          role: 'assistant',
          parentId: 'user-fallback',
          toolCalls: [
            {
              callId: 'tool-message-fallback-error',
              toolName: 'agent-teams_message_send',
              title: null,
              status: 'errored',
              input: { relayOfMessageId: 'msg-inbound-fallback' },
              output: null,
              outputText: 'Not connected',
              outputPreview: null,
              startedAt: null,
              completedAt: null,
              isError: true,
            },
          ],
        }),
        message({
          id: 'assistant-fallback-text',
          role: 'assistant',
          parentId: 'assistant-fallback-error',
          text: 'GAUNTLET_CONCURRENT_TOM_OK_1',
        }),
      ]),
    })

    expect(observed.state).toBe('responded_plain_text')
    expect(observed.assistantMessageId).toBe('assistant-fallback-text')
    expect(observed.latestAssistantPreview).toBe('GAUNTLET_CONCURRENT_TOM_OK_1')
    expect(observed.toolCallNames).toContain('message_send')
    expect(observed.visibleReplyCorrelation).toBe('plain_assistant_text')
  })

  test('classifies sibling plain assistant continuation after errored message_send as fallback response proof', () => {
    const observed = observeOpenCodeDeliveryResponse({
      inboundMessageId: 'msg-inbound-sibling-fallback',
      summary: summary([
        message({
          id: 'user-sibling-fallback',
          role: 'user',
          text: 'The inbound app messageId is "msg-inbound-sibling-fallback". Please reply.',
        }),
        message({
          id: 'assistant-sibling-fallback-error',
          role: 'assistant',
          parentId: 'user-sibling-fallback',
          toolCalls: [
            {
              callId: 'tool-message-sibling-fallback-error',
              toolName: 'agent-teams_message_send',
              title: null,
              status: 'errored',
              input: { relayOfMessageId: 'msg-inbound-sibling-fallback' },
              output: null,
              outputText: 'Not connected',
              outputPreview: null,
              startedAt: null,
              completedAt: null,
              isError: true,
            },
          ],
        }),
        message({
          id: 'assistant-sibling-fallback-text',
          role: 'assistant',
          parentId: 'user-sibling-fallback',
          text: 'GAUNTLET_CONCURRENT_TOM_OK_1',
          previewText: 'GAUNTLET_CONCURRENT_TOM_OK_1',
        }),
      ]),
    })

    expect(observed.state).toBe('responded_plain_text')
    expect(observed.assistantMessageId).toBe('assistant-sibling-fallback-text')
    expect(observed.latestAssistantPreview).toBe('GAUNTLET_CONCURRENT_TOM_OK_1')
    expect(observed.toolCallNames).toContain('message_send')
    expect(observed.visibleReplyCorrelation).toBe('plain_assistant_text')
  })

  test('does not treat assistant text after a nested user turn as fallback response proof', () => {
    const observed = observeOpenCodeDeliveryResponse({
      inboundMessageId: 'msg-inbound-nested-user',
      summary: summary([
        message({
          id: 'user-nested-root',
          role: 'user',
          text: 'The inbound app messageId is "msg-inbound-nested-user". Please reply.',
        }),
        message({
          id: 'assistant-nested-error',
          role: 'assistant',
          parentId: 'user-nested-root',
          toolCalls: [
            {
              callId: 'tool-message-nested-error',
              toolName: 'agent-teams_message_send',
              title: null,
              status: 'errored',
              input: { relayOfMessageId: 'msg-inbound-nested-user' },
              output: null,
              outputText: 'Not connected',
              outputPreview: null,
              startedAt: null,
              completedAt: null,
              isError: true,
            },
          ],
        }),
        message({
          id: 'user-nested-followup',
          role: 'user',
          parentId: 'assistant-nested-error',
          text: 'Unrelated user follow-up.',
        }),
        message({
          id: 'assistant-nested-followup-text',
          role: 'assistant',
          parentId: 'user-nested-followup',
          text: 'This belongs to the nested user follow-up.',
        }),
      ]),
    })

    expect(observed.state).toBe('tool_error')
    expect(observed.assistantMessageId).toBe('assistant-nested-error')
    expect(observed.latestAssistantPreview).toBeNull()
    expect(observed.toolCallNames).toContain('message_send')
  })

  test('treats multiple retry prompts with the same inbound message id as one logical delivery', () => {
    const observed = observeOpenCodeDeliveryResponse({
      inboundMessageId: 'msg-inbound-retry',
      summary: summary([
        message({
          id: 'user-retry-1',
          role: 'user',
          text: 'The inbound app messageId is "msg-inbound-retry". Please reply.',
        }),
        message({
          id: 'assistant-retry-1',
          role: 'assistant',
          parentId: 'user-retry-1',
        }),
        message({
          id: 'user-retry-2',
          role: 'user',
          text: 'Retry attempt for inbound app messageId "msg-inbound-retry".',
        }),
        message({
          id: 'assistant-retry-2',
          role: 'assistant',
          parentId: 'user-retry-2',
          toolCalls: [
            {
              callId: 'tool-retry-visible',
              toolName: 'agent-teams_message_send',
              title: null,
              status: 'completed',
              input: { relayOfMessageId: 'msg-inbound-retry' },
              output: null,
              outputText: null,
              outputPreview: null,
              startedAt: null,
              completedAt: null,
              isError: false,
            },
          ],
        }),
      ]),
    })

    expect(observed.state).toBe('responded_visible_message')
    expect(observed.deliveredUserMessageId).toBe('user-retry-2')
    expect(observed.visibleReplyCorrelation).toBe('relayOfMessageId')
  })

  test('classifies plain assistant text as response proof with diagnostic reason', () => {
    const observed = observeOpenCodeDeliveryResponse({
      inboundMessageId: 'msg-plain-text',
      summary: summary([
        message({
          id: 'user-plain',
          role: 'user',
          text: 'The inbound app messageId is "msg-plain-text". Please answer.',
        }),
        message({
          id: 'assistant-plain',
          role: 'assistant',
          parentId: 'user-plain',
          text: 'Я проверил контекст и отвечаю без tool call.',
        }),
      ]),
    })

    expect(observed.state).toBe('responded_plain_text')
    expect(observed.visibleReplyCorrelation).toBe('plain_assistant_text')
    expect(observed.reason).toBe('assistant_replied_with_plain_text')
  })

  test('keeps accepted delivery pending while OpenCode is still busy', () => {
    const observed = observeOpenCodeDeliveryResponse({
      inboundMessageId: 'msg-busy',
      summary: summary([
        message({
          id: 'user-busy',
          role: 'user',
          text: 'The inbound app messageId is "msg-busy". Please answer.',
        }),
      ], 'busy'),
    })

    expect(observed.state).toBe('pending')
    expect(observed.deliveredUserMessageId).toBe('user-busy')
    expect(observed.reason).toBe('assistant_response_pending')
  })

  test('classifies pending OpenCode permissions as permission blocked before prompt inspection', () => {
    const blocked = summary([
      message({
        id: 'user-permission',
        role: 'user',
        text: 'The inbound app messageId is "msg-permission". Please answer.',
      }),
    ])
    blocked.pendingPermissionRequestIds = ['perm-1']

    const observed = observeOpenCodeDeliveryResponse({
      inboundMessageId: 'msg-permission',
      summary: blocked,
    })

    expect(observed.state).toBe('permission_blocked')
    expect(observed.reason).toBe('pending_permission_request')
  })

  test('classifies stale session reconciliation as session stale without inspecting prompts', () => {
    const stale = summary([
      message({
        id: 'user-stale',
        role: 'user',
        text: 'The inbound app messageId is "msg-stale". Please answer.',
      }),
    ])
    stale.reconcileOutcome = 'stale'
    stale.staleReason = 'runtime_session_not_current'

    const observed = observeOpenCodeDeliveryResponse({
      inboundMessageId: 'msg-stale',
      summary: stale,
    })

    expect(observed.state).toBe('session_stale')
    expect(observed.reason).toBe('runtime_session_not_current')
  })

  test('reports limited history prompt misses as needing full history', () => {
    const observed = observeOpenCodeDeliveryResponse({
      inboundMessageId: 'msg-missing-from-window',
      summary: summary([
        message({
          id: 'assistant-latest-only',
          role: 'assistant',
          text: 'Latest assistant turn, but the delivered user prompt was outside this window.',
        }),
      ]),
    })

    expect(observed.state).toBe('prompt_not_indexed')
    expect(observed.needsFullHistory).toBe(true)
    expect(observed.reason).toBe('delivered_prompt_anchor_not_found_in_limited_history')
  })

  test('uses pre-prompt cursor fallback when inbound id is absent from model-visible text', () => {
    const observed = observeOpenCodeDeliveryResponse({
      inboundMessageId: 'msg-redacted-from-text',
      prePromptCursor: 'cursor-before-delivery',
      summary: summary([
        message({
          id: 'cursor-before-delivery',
          role: 'assistant',
          text: 'Previous assistant turn.',
        }),
        message({
          id: 'user-after-cursor',
          role: 'user',
          text: 'Runtime delivery prompt without the explicit app id in this transcript.',
        }),
        message({
          id: 'assistant-after-cursor',
          role: 'assistant',
          parentId: 'user-after-cursor',
          toolCalls: [
            {
              callId: 'tool-cursor-fallback-reply',
              toolName: 'agent-teams_message_send',
              title: null,
              status: 'completed',
              input: { to: 'user', from: 'jack', text: 'Done.' },
              output: null,
              outputText: null,
              outputPreview: null,
              startedAt: null,
              completedAt: null,
              isError: false,
            },
          ],
        }),
      ]),
    })

    expect(observed.state).toBe('responded_visible_message')
    expect(observed.deliveredUserMessageId).toBe('user-after-cursor')
    expect(observed.visibleReplyCorrelation).toBe('direct_child_message_send')
    expect(observed.needsFullHistory).toBeUndefined()
  })

  test('does not guess a delivered prompt when cursor fallback has multiple user candidates', () => {
    const observed = observeOpenCodeDeliveryResponse({
      inboundMessageId: 'msg-ambiguous-window',
      prePromptCursor: 'cursor-ambiguous',
      summary: summary([
        message({
          id: 'cursor-ambiguous',
          role: 'assistant',
          text: 'Previous assistant turn.',
        }),
        message({
          id: 'user-candidate-1',
          role: 'user',
          text: 'First user after cursor.',
        }),
        message({
          id: 'user-candidate-2',
          role: 'user',
          text: 'Second user after cursor.',
        }),
      ]),
    })

    expect(observed.state).toBe('prompt_not_indexed')
    expect(observed.needsFullHistory).toBe(false)
    expect(observed.reason).toBe('delivered_prompt_anchor_not_found')
  })

  test('prefers exact runtime prompt message id over ambiguous text and cursor matches', () => {
    const observed = observeOpenCodeDeliveryResponse({
      inboundMessageId: 'msg-app',
      prePromptCursor: 'cursor-before-delivery',
      runtimePromptMessageId: 'user-exact-runtime-prompt',
      summary: summary([
        message({
          id: 'cursor-before-delivery',
          role: 'assistant',
          text: 'Previous assistant turn.',
        }),
        message({
          id: 'user-wrong-text-match',
          role: 'user',
          text: 'Old retry mentions msg-app but is not the accepted prompt.',
        }),
        message({
          id: 'assistant-wrong-text-match',
          role: 'assistant',
          parentId: 'user-wrong-text-match',
          text: 'stale reply',
        }),
        message({
          id: 'user-exact-runtime-prompt',
          role: 'user',
          text: 'Runtime delivery prompt with redacted app id.',
        }),
        message({
          id: 'assistant-exact-runtime-prompt',
          role: 'assistant',
          parentId: 'user-exact-runtime-prompt',
          text: 'current reply',
        }),
      ]),
    })

    expect(observed.state).toBe('responded_plain_text')
    expect(observed.deliveredUserMessageId).toBe('user-exact-runtime-prompt')
    expect(observed.assistantMessageId).toBe('assistant-exact-runtime-prompt')
    expect(observed.latestAssistantPreview).toBe('current reply')
  })

  test('real fixture matches delivered prompt by inbound message id instead of latest user', () => {
    const observed = observeOpenCodeDeliveryResponse({
      inboundMessageId: 'a999f8e3-f0e9-407d-8680-ec9be463ea24',
      summary: relayWorksJackFixtureSummary(),
    })

    expect(observed.state).toBe('responded_visible_message')
    expect(observed.deliveredUserMessageId).toBe('msg_dc123cfdc001AwmMcHowBQfmTb')
    expect(observed.assistantMessageId).toBe('msg_dc123cfe4001kQOibIEKsAG5I4')
    expect(observed.visibleReplyCorrelation).toBe('direct_child_message_send')
    expect(observed.visibleReplyMissingRelayOfMessageId).toBe(true)
  })

  test('real fixture inspects all assistant children and ignores an earlier errored message_send', () => {
    const observed = observeOpenCodeDeliveryResponse({
      inboundMessageId: 'c1727b0c-5a77-4f40-9b93-abb74e201640',
      summary: relayWorksJackFixtureSummary(),
    })

    expect(observed.state).toBe('responded_visible_message')
    expect(observed.assistantMessageId).toBe('msg_dc1248923001BzYeYGHFXmJq6O')
    expect(observed.toolCallNames).toContain('message_send')
    expect(observed.reason).toBe('visible_reply_missing_relayOfMessageId')
  })

  test('real fixture treats task and lowercase execution tools as non-visible response proof', () => {
    const observed = observeOpenCodeDeliveryResponse({
      inboundMessageId: 'e4b37382-41eb-4ce9-8419-765995a15ae0',
      summary: relayWorksJackFixtureSummary(),
    })

    expect(observed.state).toBe('responded_non_visible_tool')
    expect(observed.deliveredUserMessageId).toBe('msg_dc12e6ed90011tbp3EYfTvMlYa')
    expect(observed.toolCallNames).toContain('task_get')
    expect(observed.toolCallNames).toContain('read')
  })

  test('real fixture does not count an errored task tool as delivery success', () => {
    const observed = observeOpenCodeDeliveryResponse({
      inboundMessageId: '1bcb39f2-464e-416e-b38c-5410220bb88e',
      summary: relayWorksJackFixtureSummary(),
    })

    expect(observed.state).toBe('tool_error')
    expect(observed.toolCallNames).toContain('task_add_comment')
    expect(observed.reason).toBe('meaningful_tool_call_failed')
  })
})

 test('certifies only a completed exact child with full non-response output, never a preview or meaningful answer', () => {
  const user = message({ id: 'accepted', role: 'user', text: 'peer FYI' })
  const child = message({ id: 'child', parentId: user.id, role: 'assistant',
    text: '[[AGENT_TEAMS_NO_REPLY]]', completedAt: 1000, finishReason: 'stop' })
  const observe = (overrides: Partial<OpenCodeCanonicalMessage> = {}, rawStatus: OpenCodeSessionReconcileSummary['rawStatus'] = 'idle', extra: OpenCodeCanonicalMessage[] = []) => observeOpenCodeDeliveryResponse({
    runtimePromptMessageId: user.id, inboundMessageId: 'physical', groupChatId: 'group',
    summary: summary([user, ...extra, { ...child, ...overrides }], rawStatus),
  })
  expect(observe().reason).toBe('assistant_child_completed_with_non_response_text')
  expect(observe({ text: 'Reading instructions first. [[AGENT_TEAMS_NO_REPLY]]' }).reason).toBe('assistant_child_completed_with_non_response_text')
  expect(observe({ text: 'No reply needed; peer status message, not a request.' }).reason).toBe('assistant_child_completed_with_non_response_text')
  for (const overrides of [
    { text: 'No reply needed; result is 42.' },
    { text: '[[AGENT_TEAMS_NO_REPLY]] real answer' },
    { text: 'No reply needed' + ' '.repeat(500) + ' result is 42.', previewText: 'No reply needed' },
    { text: '', previewText: '[[AGENT_TEAMS_NO_REPLY]]' },
    { completedAt: null }, { finishReason: null }, { parentId: 'foreign-prompt' },
    { hasError: true },
  ]) expect(observe(overrides).reason).not.toBe('assistant_child_completed_with_non_response_text')
  expect(observe({}, 'busy').reason).not.toBe('assistant_child_completed_with_non_response_text')
  expect(observe({}, 'idle', [message({ id: 'meaningful', role: 'assistant', parentId: user.id, text: 'The answer is 42' })]).reason).not.toBe('assistant_child_completed_with_non_response_text')
})

test('does not certify an earlier completed no-response before a later unfinished child', () => {
  const user = message({ id: 'prompt', role: 'user' })
  const observed = observeOpenCodeDeliveryResponse({ runtimePromptMessageId: user.id,
    summary: summary([user,
      message({ id: 'done', role: 'assistant', parentId: user.id, text: '[[AGENT_TEAMS_NO_REPLY]]', completedAt: 1000, finishReason: 'stop' }),
      message({ id: 'unfinished', role: 'assistant', parentId: user.id }),
    ], null),
  })
  expect(observed.reason).not.toBe('assistant_child_completed_with_non_response_text')
})

test('completed no-response allows only a successful read-only catalog, not failed or other tools', () => {
  const user = message({ id: 'prompt', role: 'user' })
  const tool: import('./types.js').OpenCodeCanonicalToolCall = {
    callId: 'catalog', toolName: 'agent-teams_group_chat_list', input: {}, output: [], outputText: null,
    status: 'completed', title: null, isError: false, outputPreview: null, startedAt: 1, completedAt: 2,
  }
  const observe = (changes = {}) => observeOpenCodeDeliveryResponse({ runtimePromptMessageId: user.id,
    summary: summary([user, message({ id: 'catalog-child', role: 'assistant', parentId: user.id, toolCalls: [{ ...tool, ...changes }] }),
      message({ id: 'final-child', role: 'assistant', parentId: user.id, text: '[[AGENT_TEAMS_NO_REPLY]]', completedAt: 4, finishReason: 'stop' })]),
  })
  expect(observe().reason).toBe('assistant_child_completed_with_non_response_text')
  for (const changes of [{ status: 'running' }, { isError: true }, { output: { isError: true, content: [] } },
    { toolName: 'read' }, { status: 'errored' }, { output: null }])
    expect(observe(changes).reason).not.toBe('assistant_child_completed_with_non_response_text')
})
