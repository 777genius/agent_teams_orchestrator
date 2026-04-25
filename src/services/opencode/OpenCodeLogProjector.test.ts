import { describe, expect, test } from 'bun:test'

import { OpenCodeLogProjector } from './OpenCodeLogProjector.js'

import type { OpenCodeSessionReconcileSummary } from './types.js'

const projector = new OpenCodeLogProjector()

function buildSummary(
  patch: Partial<OpenCodeSessionReconcileSummary> = {},
): OpenCodeSessionReconcileSummary {
  return {
    sessionId: 'session-1',
    reconcileOutcome: 'reconciled',
    rawStatus: 'idle',
    durableState: 'idle',
    staleReason: null,
    profileAuthState: 'ok',
    pendingPermissionRequestIds: [],
    messageCount: 0,
    toolCallCount: 0,
    errorCount: 0,
    lastCanonicalCursor: null,
    latestUserMessageId: null,
    latestAssistantMessageId: null,
    latestAssistantText: null,
    latestAssistantPreview: null,
    replyPendingSinceMessageId: null,
    messages: [],
    diagnostics: [],
    ...patch,
  }
}

describe('OpenCodeLogProjector', () => {
  test('projects assistant tool calls into assistant and synthetic tool-result log messages', () => {
    const projection = projector.projectSummary(
      buildSummary({
        messageCount: 2,
        toolCallCount: 1,
        messages: [
          {
            id: 'msg-user-1',
            parentId: null,
            role: 'user',
            agent: null,
            providerId: 'opencode',
            modelId: 'big-pickle',
            createdAt: 100,
            completedAt: 100,
            text: 'Run pwd',
            reasoningText: '',
            previewText: 'Run pwd',
            partTypes: ['text'],
            reasoningPartCount: 0,
            toolCalls: [],
            contentBlocks: [{ type: 'text', text: 'Run pwd' }],
            finishReason: null,
            errorName: null,
            errorMessage: null,
            hasError: false,
          },
          {
            id: 'msg-assistant-1',
            parentId: 'msg-user-1',
            role: 'assistant',
            agent: 'teammate',
            providerId: 'opencode',
            modelId: 'big-pickle',
            createdAt: 101,
            completedAt: 110,
            text: '/tmp/project',
            reasoningText: 'Inspect working directory first.',
            previewText: '/tmp/project',
            partTypes: ['step-start', 'reasoning', 'tool', 'text', 'step-finish'],
            reasoningPartCount: 1,
            toolCalls: [
              {
                callId: 'call_pwd',
                toolName: 'bash',
                title: 'Print working directory',
                status: 'completed',
                input: { command: 'pwd' },
                output: '/tmp/project\n',
                outputText: '/tmp/project\n',
                outputPreview: '/tmp/project',
                startedAt: 102,
                completedAt: 109,
                isError: false,
              },
            ],
            contentBlocks: [
              { type: 'step_start' },
              { type: 'reasoning', text: 'Inspect working directory first.' },
              {
                type: 'tool_use',
                id: 'call_pwd',
                name: 'bash',
                title: 'Print working directory',
                status: 'completed',
                input: { command: 'pwd' },
                startedAt: 102,
                completedAt: 109,
              },
              {
                type: 'tool_result',
                toolUseId: 'call_pwd',
                toolName: 'bash',
                title: 'Print working directory',
                status: 'completed',
                contentText: '/tmp/project\n',
                contentPreview: '/tmp/project',
                rawContent: '/tmp/project\n',
                isError: false,
                startedAt: 102,
                completedAt: 109,
              },
              { type: 'text', text: '/tmp/project' },
            ],
            finishReason: 'stop',
            errorName: null,
            errorMessage: null,
            hasError: false,
          },
        ],
      }),
    )

    expect(projection.sourceMessageCount).toBe(2)
    expect(projection.projectedMessageCount).toBe(3)
    expect(projection.syntheticMessageCount).toBe(1)
    expect(projection.messages).toEqual([
      expect.objectContaining({
        uuid: 'msg-user-1',
        type: 'user',
        isMeta: false,
        content: [{ type: 'text', text: 'Run pwd' }],
      }),
      expect.objectContaining({
        uuid: 'msg-assistant-1',
        type: 'assistant',
        parentUuid: 'msg-user-1',
        model: 'opencode/big-pickle',
        toolCalls: [
          expect.objectContaining({
            id: 'call_pwd',
            name: 'bash',
          }),
        ],
      }),
      expect.objectContaining({
        uuid: 'msg-assistant-1::tool_results',
        type: 'user',
        isMeta: true,
        sourceToolUseID: 'call_pwd',
        sourceToolAssistantUUID: 'msg-assistant-1',
        toolResults: [
          expect.objectContaining({
            toolUseId: 'call_pwd',
            content: '/tmp/project\n',
          }),
        ],
      }),
    ])
  })

  test('truncates huge tool-result payloads in projected log messages', () => {
    const hugeOutput = 'x'.repeat(9_000)
    const projection = projector.projectSummary(
      buildSummary({
        messageCount: 1,
        toolCallCount: 1,
        messages: [
          {
            id: 'msg-assistant-huge-output',
            parentId: 'msg-user-1',
            role: 'assistant',
            agent: 'teammate',
            providerId: 'opencode',
            modelId: 'big-pickle',
            createdAt: 101,
            completedAt: 110,
            text: '',
            reasoningText: '',
            previewText: null,
            partTypes: ['tool'],
            reasoningPartCount: 0,
            toolCalls: [
              {
                callId: 'call_huge',
                toolName: 'agent-teams_member_briefing',
                title: 'Member briefing',
                status: 'completed',
                input: {},
                output: hugeOutput,
                outputText: hugeOutput,
                outputPreview: hugeOutput.slice(0, 120),
                startedAt: 102,
                completedAt: 109,
                isError: false,
              },
            ],
            contentBlocks: [
              {
                type: 'tool_use',
                id: 'call_huge',
                name: 'agent-teams_member_briefing',
                status: 'completed',
                input: {},
                startedAt: 102,
                completedAt: 109,
              },
            ],
            finishReason: 'stop',
            errorName: null,
            errorMessage: null,
            hasError: false,
          },
        ],
      }),
    )

    const synthetic = projection.messages.find(message => message.uuid.endsWith('::tool_results'))
    expect(synthetic?.toolResults[0]?.content).toContain(
      '[truncated 1000 chars from OpenCode tool result]',
    )
  })

  test('projects assistant runtime errors into synthetic system log messages', () => {
    const projection = projector.projectSummary(
      buildSummary({
        messageCount: 1,
        errorCount: 1,
        durableState: 'error',
        messages: [
          {
            id: 'msg-assistant-error',
            parentId: 'msg-user-err',
            role: 'assistant',
            agent: 'teammate',
            providerId: 'openai',
            modelId: 'gpt-5.4-mini',
            createdAt: 200,
            completedAt: 201,
            text: '',
            reasoningText: '',
            previewText: null,
            partTypes: [],
            reasoningPartCount: 0,
            toolCalls: [],
            contentBlocks: [],
            finishReason: null,
            errorName: 'UnknownError',
            errorMessage: 'Token refresh failed: 401',
            hasError: true,
          },
        ],
      }),
    )

    expect(projection.projectedMessageCount).toBe(1)
    expect(projection.syntheticMessageCount).toBe(1)
    expect(projection.messages[0]).toEqual(
      expect.objectContaining({
        uuid: 'msg-assistant-error::error',
        parentUuid: 'msg-assistant-error',
        type: 'system',
        level: 'error',
        content: 'OpenCode runtime error - UnknownError: Token refresh failed: 401',
      }),
    )
  })

  test('uses stable matching fallback tool ids when OpenCode omits call ids', () => {
    const projection = projector.projectSummary(
      buildSummary({
        messageCount: 1,
        toolCallCount: 2,
        messages: [
          {
            id: 'msg-assistant-no-call-ids',
            parentId: 'msg-user-1',
            role: 'assistant',
            agent: 'teammate',
            providerId: 'opencode',
            modelId: 'big-pickle',
            createdAt: 300,
            completedAt: 320,
            text: '',
            reasoningText: '',
            previewText: null,
            partTypes: ['tool', 'tool'],
            reasoningPartCount: 0,
            toolCalls: [
              {
                callId: null,
                toolName: 'bash',
                title: 'First command',
                status: 'completed',
                input: { command: 'pwd' },
                output: '/tmp/project\n',
                outputText: '/tmp/project\n',
                outputPreview: '/tmp/project',
                startedAt: 301,
                completedAt: 309,
                isError: false,
              },
              {
                callId: null,
                toolName: 'bash',
                title: 'Second command',
                status: 'completed',
                input: { command: 'ls' },
                output: 'package.json\n',
                outputText: 'package.json\n',
                outputPreview: 'package.json',
                startedAt: 310,
                completedAt: 319,
                isError: false,
              },
            ],
            contentBlocks: [
              {
                type: 'tool_use',
                id: null,
                name: 'bash',
                title: 'First command',
                status: 'completed',
                input: { command: 'pwd' },
                startedAt: 301,
                completedAt: 309,
              },
              {
                type: 'tool_use',
                id: null,
                name: 'bash',
                title: 'Second command',
                status: 'completed',
                input: { command: 'ls' },
                startedAt: 310,
                completedAt: 319,
              },
            ],
            finishReason: 'stop',
            errorName: null,
            errorMessage: null,
            hasError: false,
          },
        ],
      }),
    )

    const assistant = projection.messages.find(message => message.type === 'assistant')
    const toolResult = projection.messages.find(message => message.isMeta && message.type === 'user')

    expect(assistant?.toolCalls.map(toolCall => toolCall.id)).toEqual([
      'msg-assistant-no-call-ids::tool::0',
      'msg-assistant-no-call-ids::tool::1',
    ])
    expect(toolResult?.toolResults.map(result => result.toolUseId)).toEqual([
      'msg-assistant-no-call-ids::tool::0',
      'msg-assistant-no-call-ids::tool::1',
    ])
    expect(
      Array.isArray(assistant?.content)
        ? assistant.content
            .filter(block => block.type === 'tool_use')
            .map(block => block.id)
        : [],
    ).toEqual([
      'msg-assistant-no-call-ids::tool::0',
      'msg-assistant-no-call-ids::tool::1',
    ])
  })

  test('uses deterministic recent fallback timestamps when OpenCode omits message times', () => {
    const clockedProjector = new OpenCodeLogProjector({
      clock: () => Date.UTC(2026, 3, 21, 12, 0, 0),
    })
    const projection = clockedProjector.projectSummary(
      buildSummary({
        messageCount: 2,
        toolCallCount: 1,
        messages: [
          {
            id: 'msg-user-without-time',
            parentId: null,
            role: 'user',
            agent: null,
            providerId: 'opencode',
            modelId: 'big-pickle',
            createdAt: null,
            completedAt: null,
            text: 'Run pwd',
            reasoningText: '',
            previewText: 'Run pwd',
            partTypes: ['text'],
            reasoningPartCount: 0,
            toolCalls: [],
            contentBlocks: [{ type: 'text', text: 'Run pwd' }],
            finishReason: null,
            errorName: null,
            errorMessage: null,
            hasError: false,
          },
          {
            id: 'msg-assistant-without-time',
            parentId: 'msg-user-without-time',
            role: 'assistant',
            agent: 'teammate',
            providerId: 'opencode',
            modelId: 'big-pickle',
            createdAt: null,
            completedAt: null,
            text: 'Done',
            reasoningText: '',
            previewText: 'Done',
            partTypes: ['tool', 'text'],
            reasoningPartCount: 0,
            toolCalls: [
              {
                callId: 'call_pwd',
                toolName: 'bash',
                title: 'Print working directory',
                status: 'completed',
                input: { command: 'pwd' },
                output: '/tmp/project\n',
                outputText: '/tmp/project\n',
                outputPreview: '/tmp/project',
                startedAt: null,
                completedAt: null,
                isError: false,
              },
            ],
            contentBlocks: [
              {
                type: 'tool_use',
                id: 'call_pwd',
                name: 'bash',
                title: 'Print working directory',
                status: 'completed',
                input: { command: 'pwd' },
                startedAt: null,
                completedAt: null,
              },
              { type: 'text', text: 'Done' },
            ],
            finishReason: 'stop',
            errorName: null,
            errorMessage: null,
            hasError: false,
          },
        ],
      }),
    )

    expect(projection.messages.map(message => message.timestamp)).toEqual([
      '2026-04-21T12:00:00.000Z',
      '2026-04-21T12:00:00.001Z',
      '2026-04-21T12:00:00.002Z',
    ])
    expect(
      projection.messages.every(message => !message.timestamp.startsWith('1970-01-01')),
    ).toBe(true)
  })

  test('preserves slash-containing OpenCode model ids in projected logs', () => {
    const projection = projector.projectSummary(
      buildSummary({
        messageCount: 1,
        messages: [
          {
            id: 'msg-assistant-2',
            parentId: 'msg-user-2',
            role: 'assistant',
            agent: 'teammate',
            providerId: 'openrouter',
            modelId: 'moonshotai/kimi-k2',
            createdAt: 300,
            completedAt: 301,
            text: 'Using Kimi K2',
            reasoningText: '',
            previewText: 'Using Kimi K2',
            partTypes: ['text'],
            reasoningPartCount: 0,
            toolCalls: [],
            contentBlocks: [{ type: 'text', text: 'Using Kimi K2' }],
            finishReason: 'stop',
            errorName: null,
            errorMessage: null,
            hasError: false,
          },
        ],
      }),
    )

    expect(projection.messages).toEqual([
      expect.objectContaining({
        uuid: 'msg-assistant-2',
        type: 'assistant',
        model: 'openrouter/moonshotai/kimi-k2',
      }),
    ])
  })
})
