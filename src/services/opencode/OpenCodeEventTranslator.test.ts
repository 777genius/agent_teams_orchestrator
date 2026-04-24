import { describe, expect, test } from 'bun:test'

import { OpenCodeEventTranslator } from './OpenCodeEventTranslator.js'

import type { OpenCodeMessage } from './types.js'

const translator = new OpenCodeEventTranslator()

describe('OpenCodeEventTranslator', () => {
  test('builds durable assistant summary from session messages', () => {
    const messages: OpenCodeMessage[] = [
      {
        info: {
          id: 'msg-user-1',
          role: 'user',
          sessionID: 'session-1',
          time: { created: 100 },
        },
        parts: [{ type: 'text', text: 'Reply with exactly: pong' }],
      },
      {
        info: {
          id: 'msg-assistant-1',
          parentID: 'msg-user-1',
          role: 'assistant',
          agent: 'build',
          providerID: 'openai',
          modelID: 'gpt-5.4-mini',
          sessionID: 'session-1',
          time: { created: 101, completed: 110 },
        },
        parts: [
          { type: 'step-start' },
          { type: 'reasoning', text: '' },
          { type: 'text', text: 'pong' },
          { type: 'step-finish' },
        ],
      },
    ]

    const summary = translator.reconcileSessionMessages({
      sessionId: 'session-1',
      rawStatus: 'idle',
      messages,
    })

    expect(summary.durableState).toBe('idle')
    expect(summary.lastCanonicalCursor).toBe('msg-assistant-1')
    expect(summary.latestAssistantMessageId).toBe('msg-assistant-1')
    expect(summary.latestAssistantText).toBe('pong')
    expect(summary.toolCallCount).toBe(0)
    expect(summary.errorCount).toBe(0)
    expect(summary.replyPendingSinceMessageId).toBeNull()
    expect(summary.pendingPermissionRequestIds).toEqual([])
    expect(summary.messages[1]?.reasoningPartCount).toBe(0)
    expect(summary.messages[1]?.reasoningText).toBe('')
  })

  test('marks reply pending when latest user message has no assistant reply', () => {
    const summary = translator.reconcileSessionMessages({
      sessionId: 'session-1',
      rawStatus: 'idle',
      messages: [
        {
          info: {
            id: 'msg-user-2',
            role: 'user',
            sessionID: 'session-1',
            time: { created: 200 },
          },
          parts: [{ type: 'text', text: 'Are you there?' }],
        },
      ],
    })

    expect(summary.durableState).toBe('reply_pending')
    expect(summary.replyPendingSinceMessageId).toBe('msg-user-2')
    expect(summary.toolCallCount).toBe(0)
    expect(
      summary.diagnostics.some(item => item.includes('has no assistant reply while OpenCode session is idle')),
    ).toBe(true)
  })

  test('captures tool lifecycle and transcript blocks from assistant tool parts', () => {
    const summary = translator.reconcileSessionMessages({
      sessionId: 'session-1',
      rawStatus: 'idle',
      messages: [
        {
          info: {
            id: 'msg-user-3',
            role: 'user',
            model: {
              providerID: 'opencode',
              modelID: 'big-pickle',
            },
            sessionID: 'session-1',
            time: { created: 300 },
          },
          parts: [{ type: 'text', text: 'Run pwd' }],
        },
        {
          info: {
            id: 'msg-assistant-tool',
            parentID: 'msg-user-3',
            role: 'assistant',
            agent: 'teammate',
            providerID: 'opencode',
            modelID: 'big-pickle',
            finish: 'tool-calls',
            sessionID: 'session-1',
            time: { created: 301, completed: 305 },
          },
          parts: [
            { type: 'step-start' },
            { type: 'reasoning', text: 'Need to run pwd first.' },
            {
              type: 'tool',
              tool: 'bash',
              callID: 'call_pwd',
              state: {
                status: 'completed',
                title: 'Print working directory',
                input: {
                  command: 'pwd',
                },
                output: '/tmp/project\n',
                metadata: {
                  output: '/tmp/project\n',
                  exit: 0,
                },
                time: {
                  start: 302,
                  end: 304,
                },
              },
            },
            {
              type: 'step-finish',
              reason: 'tool-calls',
            },
          ],
        },
      ],
    })

    expect(summary.toolCallCount).toBe(1)
    expect(summary.errorCount).toBe(0)
    expect(summary.latestAssistantMessageId).toBe('msg-assistant-tool')
    expect(summary.latestAssistantText).toBeNull()
    expect(summary.latestAssistantPreview).toBeNull()
    expect(summary.messages[0]?.providerId).toBe('opencode')
    expect(summary.messages[0]?.modelId).toBe('big-pickle')
    expect(summary.messages[1]?.finishReason).toBe('tool-calls')
    expect(summary.messages[1]?.toolCalls).toHaveLength(1)
    expect(summary.messages[1]?.toolCalls[0]).toEqual(
      expect.objectContaining({
        callId: 'call_pwd',
        toolName: 'bash',
        status: 'completed',
        outputText: '/tmp/project\n',
      }),
    )
    expect(summary.messages[1]?.contentBlocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'tool_use',
          id: 'call_pwd',
          name: 'bash',
        }),
        expect.objectContaining({
          type: 'tool_result',
          toolUseId: 'call_pwd',
          toolName: 'bash',
          contentText: '/tmp/project\n',
        }),
      ]),
    )
  })

  test('marks latest assistant error as durable error state', () => {
    const summary = translator.reconcileSessionMessages({
      sessionId: 'session-1',
      rawStatus: 'idle',
      messages: [
        {
          info: {
            id: 'msg-user-error',
            role: 'user',
            sessionID: 'session-1',
            time: { created: 400 },
          },
          parts: [{ type: 'text', text: 'Hello' }],
        },
        {
          info: {
            id: 'msg-assistant-error',
            parentID: 'msg-user-error',
            role: 'assistant',
            providerID: 'openai',
            modelID: 'gpt-5.4-mini',
            sessionID: 'session-1',
            time: { created: 401, completed: 402 },
            error: {
              name: 'UnknownError',
              data: {
                message: 'Token refresh failed: 401',
              },
            },
          },
          parts: [],
        },
      ],
    })

    expect(summary.durableState).toBe('error')
    expect(summary.errorCount).toBe(1)
    expect(summary.latestAssistantPreview).toBe('Token refresh failed: 401')
    expect(summary.messages[1]).toEqual(
      expect.objectContaining({
        hasError: true,
        errorName: 'UnknownError',
        errorMessage: 'Token refresh failed: 401',
      }),
    )
    expect(
      summary.diagnostics.some(item => item.includes('Token refresh failed: 401')),
    ).toBe(true)
  })
})
