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

  test('treats stale busy status as idle when transcript has a completed assistant response', () => {
    const summary = translator.reconcileSessionMessages({
      sessionId: 'session-1',
      rawStatus: 'busy',
      messages: [
        {
          info: {
            id: 'msg-user-busy-stale',
            role: 'user',
            sessionID: 'session-1',
            time: { created: 120 },
          },
          parts: [{ type: 'text', text: 'Reply with exactly: pong' }],
        },
        {
          info: {
            id: 'msg-assistant-busy-stale',
            parentID: 'msg-user-busy-stale',
            role: 'assistant',
            sessionID: 'session-1',
            time: { created: 121, completed: 125 },
          },
          parts: [
            { type: 'step-start' },
            { type: 'text', text: 'pong' },
            { type: 'step-finish' },
          ],
        },
      ],
    })

    expect(summary.rawStatus).toBe('busy')
    expect(summary.durableState).toBe('idle')
    expect(summary.replyPendingSinceMessageId).toBeNull()
    expect(summary.latestAssistantMessageId).toBe('msg-assistant-busy-stale')
    expect(summary.diagnostics.join('\n')).toContain('status was busy')
  })

  test('tracks a following tool response without settling busy when OpenCode keeps the bootstrap parent id', () => {
    const summary = translator.reconcileSessionMessages({
      sessionId: 'session-1',
      rawStatus: 'busy',
      messages: [
        {
          info: {
            id: 'msg-bootstrap',
            role: 'user',
            sessionID: 'session-1',
            time: { created: 100 },
          },
          parts: [{ type: 'text', text: 'bootstrap context' }],
        },
        {
          info: {
            id: 'msg-delivery',
            role: 'user',
            sessionID: 'session-1',
            time: { created: 200 },
          },
          parts: [{ type: 'text', text: 'Reply using message_send' }],
        },
        {
          info: {
            id: 'msg-assistant-bootstrap-parent',
            parentID: 'msg-bootstrap',
            role: 'assistant',
            sessionID: 'session-1',
            time: { created: 201, completed: 205 },
            finish: 'tool-calls',
          },
          parts: [
            { type: 'step-start' },
            {
              type: 'tool',
              tool: 'agent-teams_message_send',
              callID: 'call-message-send',
              state: {
                status: 'completed',
                input: { text: 'visible reply' },
                output: '{"deliveredToInbox":true}',
              },
            },
            { type: 'step-finish', reason: 'tool-calls' },
          ],
        },
      ],
    })

    expect(summary.latestUserMessageId).toBe('msg-delivery')
    expect(summary.latestAssistantMessageId).toBe('msg-assistant-bootstrap-parent')
    expect(summary.replyPendingSinceMessageId).toBeNull()
    expect(summary.durableState).toBe('running')
    expect(summary.diagnostics.join('\n')).not.toContain('status was busy')
  })

  test('keeps a busy multi-step task running through completed tools until the final assistant response', () => {
    const messages: OpenCodeMessage[] = [{
      info: { id: 'msg-task', role: 'user', time: { created: 100 } },
      parts: [{ type: 'text', text: 'Read the task, write and verify the result, complete it, then report.' }],
    }]

    for (const [index, tool] of ['agent-teams_task_get', 'write', 'read', 'agent-teams_task_complete', 'agent-teams_message_send'].entries()) {
      messages.push({
        info: {
          id: `msg-step-${index}`,
          parentID: 'msg-task',
          role: 'assistant',
          time: { created: 101 + index, completed: 102 + index },
          finish: 'tool-calls',
        },
        parts: [
          { type: 'text', text: `Executing ${tool}` },
          {
            type: 'tool', tool, callID: `call-${index}`,
            state: { status: 'completed', input: {}, output: 'ok' },
          },
          { type: 'step-finish', reason: 'tool-calls' },
        ],
      })
      const summary = translator.reconcileSessionMessages({ sessionId: 'session-1', rawStatus: 'busy', messages })
      expect(summary.durableState).toBe('running')
      expect(summary.replyPendingSinceMessageId).toBeNull()
      expect(summary.diagnostics.join('\n')).not.toContain('treating session as idle')
    }

    messages.push({
      info: { id: 'msg-final', parentID: 'msg-task', role: 'assistant', finish: 'stop', time: { created: 110, completed: 115 } },
      parts: [{ type: 'text', text: 'Task completed and report sent.' }, { type: 'step-finish', reason: 'stop' }],
    })
    expect(translator.reconcileSessionMessages({ sessionId: 'session-1', rawStatus: 'busy', messages }).durableState).toBe('idle')
  })

  test('does not use an earlier completed response when a newer assistant step is unfinished', () => {
    const summary = translator.reconcileSessionMessages({
      sessionId: 'session-1', rawStatus: 'busy', messages: [
        { info: { id: 'msg-user', role: 'user' }, parts: [{ type: 'text', text: 'Continue the task.' }] },
        {
          info: { id: 'msg-earlier', role: 'assistant', parentID: 'msg-user', finish: 'stop', time: { completed: 100 } },
          parts: [{ type: 'text', text: 'Earlier response' }],
        },
        { info: { id: 'msg-newer', role: 'assistant', parentID: 'msg-user' }, parts: [{ type: 'step-start' }] },
      ],
    })
    expect(summary.durableState).toBe('running')
    expect(summary.latestAssistantMessageId).toBe('msg-newer')
  })

  test.each(['tool-calls', 'unknown'])('does not settle a completed %s step without tool parts', finish => {
    const summary = translator.reconcileSessionMessages({
      sessionId: 'session-1', rawStatus: 'busy', messages: [
        { info: { id: 'msg-user', role: 'user' }, parts: [{ type: 'text', text: 'Continue.' }] },
        {
          info: { id: 'msg-step', role: 'assistant', parentID: 'msg-user', time: { completed: 100 } },
          parts: [{ type: 'step-finish', reason: finish }],
        },
      ],
    })
    expect(summary.durableState).toBe('running')
  })

  test('does not treat completed tools without a finish reason as terminal', () => {
    const summary = translator.reconcileSessionMessages({
      sessionId: 'session-1', rawStatus: 'busy', messages: [
        { info: { id: 'msg-user', role: 'user' }, parts: [] },
        {
          info: { id: 'msg-tool', role: 'assistant', parentID: 'msg-user', time: { completed: 100 } },
          parts: [{ type: 'tool', tool: 'write', state: { status: 'completed', input: {}, output: 'ok' } }],
        },
      ],
    })
    expect(summary.durableState).toBe('running')
  })

  test('keeps busy state when the latest assistant response is not complete', () => {
    const summary = translator.reconcileSessionMessages({
      sessionId: 'session-1',
      rawStatus: 'busy',
      messages: [
        {
          info: {
            id: 'msg-user-busy-active',
            role: 'user',
            sessionID: 'session-1',
            time: { created: 130 },
          },
          parts: [{ type: 'text', text: 'Reply with exactly: pong' }],
        },
        {
          info: {
            id: 'msg-assistant-busy-active',
            parentID: 'msg-user-busy-active',
            role: 'assistant',
            sessionID: 'session-1',
            time: { created: 131 },
          },
          parts: [
            { type: 'step-start' },
            { type: 'text', text: 'po' },
          ],
        },
      ],
    })

    expect(summary.rawStatus).toBe('busy')
    expect(summary.durableState).toBe('running')
    expect(summary.replyPendingSinceMessageId).toBeNull()
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

  test('keeps reply pending for a step-start-only assistant shell', () => {
    const summary = translator.reconcileSessionMessages({
      sessionId: 'session-1',
      rawStatus: 'idle',
      messages: [
        {
          info: {
            id: 'msg-user-step-start-only',
            role: 'user',
            sessionID: 'session-1',
            time: { created: 200 },
          },
          parts: [{ type: 'text', text: 'Reply with exactly: pong' }],
        },
        {
          info: {
            id: 'msg-assistant-step-start-only',
            parentID: 'msg-user-step-start-only',
            role: 'assistant',
            sessionID: 'session-1',
            time: { created: 201 },
          },
          parts: [{ type: 'step-start' }],
        },
      ],
    })

    expect(summary.durableState).toBe('reply_pending')
    expect(summary.replyPendingSinceMessageId).toBe('msg-user-step-start-only')
    expect(summary.latestAssistantMessageId).toBe('msg-assistant-step-start-only')
  })

  test('preserves OpenCode retry status messages as diagnostics', () => {
    const summary = translator.reconcileSessionMessages({
      sessionId: 'session-retry',
      rawStatus: {
        type: 'retry',
        attempt: 1,
        message: 'Free usage exceeded, subscribe to Go https://opencode.ai/go',
        next: 1779062400267,
      },
      messages: [
        {
          info: {
            id: 'msg-user-retry',
            role: 'user',
            sessionID: 'session-retry',
            time: { created: 250 },
          },
          parts: [{ type: 'text', text: 'Check your task' }],
        },
        {
          info: {
            id: 'msg-assistant-empty',
            parentID: 'msg-user-retry',
            role: 'assistant',
            sessionID: 'session-retry',
            time: { created: 251, completed: 252 },
          },
          parts: [],
        },
      ],
    })

    expect(summary.rawStatus).toBe('retry')
    expect(summary.durableState).toBe('retrying')
    expect(summary.diagnostics).toContain(
      'OpenCode session status retry - attempt=1 - Free usage exceeded, subscribe to Go https://opencode.ai/go - next=2026-05-18T00:00:00.267Z',
    )
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
