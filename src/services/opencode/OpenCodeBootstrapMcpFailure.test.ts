import { describe, expect, test } from 'bun:test'

import {
  hasOpenCodeBootstrapMcpNotConnectedFailure,
  summarizeOpenCodeBootstrapMcpFailure,
} from './OpenCodeBootstrapMcpFailure.js'

import type {
  OpenCodeCanonicalMessage,
  OpenCodeCanonicalToolCall,
  OpenCodeSessionReconcileSummary,
} from './types.js'

function buildToolCall(overrides: Partial<OpenCodeCanonicalToolCall>): OpenCodeCanonicalToolCall {
  return {
    callId: 'tool-1',
    toolName: 'agent-teams_runtime_bootstrap_checkin',
    title: null,
    status: 'completed',
    input: null,
    output: null,
    outputText: null,
    outputPreview: null,
    startedAt: null,
    completedAt: null,
    isError: false,
    ...overrides,
  }
}

function buildMessage(toolCalls: OpenCodeCanonicalToolCall[]): OpenCodeCanonicalMessage {
  return {
    id: 'msg-1',
    parentId: null,
    role: 'assistant',
    agent: null,
    providerId: null,
    modelId: null,
    createdAt: null,
    completedAt: null,
    text: '',
    reasoningText: '',
    previewText: null,
    partTypes: [],
    reasoningPartCount: 0,
    toolCalls,
    contentBlocks: [],
    finishReason: null,
    errorName: null,
    errorMessage: null,
    hasError: false,
  }
}

function buildSummary(messages: OpenCodeCanonicalMessage[]): OpenCodeSessionReconcileSummary {
  return {
    sessionId: 'session-1',
    reconcileOutcome: 'reconciled',
    rawStatus: 'idle',
    durableState: 'idle',
    staleReason: null,
    profileAuthState: 'ok',
    pendingPermissionRequestIds: [],
    messageCount: messages.length,
    toolCallCount: messages.reduce((count, message) => count + message.toolCalls.length, 0),
    errorCount: 0,
    lastCanonicalCursor: 'msg-1',
    latestUserMessageId: 'msg-user-1',
    latestAssistantMessageId: 'msg-1',
    latestAssistantText: null,
    latestAssistantPreview: null,
    replyPendingSinceMessageId: null,
    messages,
    diagnostics: [],
  }
}

describe('OpenCodeBootstrapMcpFailure', () => {
  test('detects failed bootstrap tools from nested object output text', () => {
    const summary = buildSummary([
      buildMessage([
        buildToolCall({
          status: 'completed',
          output: { error: { message: 'MCP Not connected' } },
        }),
      ]),
    ])

    expect(summarizeOpenCodeBootstrapMcpFailure(summary)).toEqual({
      failedTools: ['runtime_bootstrap_checkin'],
      missingTools: ['runtime_bootstrap_checkin', 'member_briefing'],
      message:
        'OpenCode bootstrap MCP tool failed before required attach completed: runtime_bootstrap_checkin (runtime_bootstrap_checkin: MCP Not connected)',
    })
    expect(hasOpenCodeBootstrapMcpNotConnectedFailure(summary)).toBe(true)
  })

  test('detects assistant completion without required bootstrap tool calls', () => {
    const summary = buildSummary([
      buildMessage([]),
    ])

    expect(summarizeOpenCodeBootstrapMcpFailure(summary)).toEqual({
      failedTools: [],
      missingTools: ['runtime_bootstrap_checkin', 'member_briefing'],
      message:
        'OpenCode bootstrap MCP did not complete required tools before assistant response: runtime_bootstrap_checkin, member_briefing',
    })
  })

  test('ignores a failed bootstrap tool after the same tool later succeeds', () => {
    const summary = buildSummary([
      buildMessage([
        buildToolCall({
          status: 'errored',
          outputText: 'Not connected',
          isError: true,
        }),
        buildToolCall({
          callId: 'tool-2',
          status: 'completed',
          output: { ok: true },
        }),
        buildToolCall({
          callId: 'tool-3',
          toolName: 'agent-teams_member_briefing',
          status: 'completed',
          output: { ok: true },
        }),
      ]),
    ])

    expect(summarizeOpenCodeBootstrapMcpFailure(summary)).toBeNull()
    expect(hasOpenCodeBootstrapMcpNotConnectedFailure(summary)).toBe(false)
  })
})
