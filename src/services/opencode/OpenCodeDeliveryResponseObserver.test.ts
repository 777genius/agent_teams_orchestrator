import { describe, expect, test } from 'bun:test'

import { observeOpenCodeDeliveryResponse } from './OpenCodeDeliveryResponseObserver.js'

import type {
  OpenCodeCanonicalMessage,
  OpenCodeSessionReconcileSummary,
} from './types.js'

function message(input: Partial<OpenCodeCanonicalMessage> & { id: string; role: OpenCodeCanonicalMessage['role'] }): OpenCodeCanonicalMessage {
  return {
    id: input.id,
    parentId: input.parentId ?? null,
    role: input.role,
    agent: null,
    providerId: null,
    modelId: null,
    createdAt: null,
    completedAt: null,
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
})

