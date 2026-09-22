import { describe, expect, test } from 'bun:test'

import { OpenCodeTranscriptProjector } from './OpenCodeTranscriptProjector.js'

const projector = new OpenCodeTranscriptProjector()

describe('OpenCodeTranscriptProjector', () => {
  test('projects assistant text, reasoning, tool use, and tool result blocks', () => {
    const projection = projector.projectSessionMessages({
      sessionId: 'session-1',
      messages: [
        {
          info: {
            id: 'msg-assistant-1',
            role: 'assistant',
            agent: 'teammate',
            providerID: 'opencode',
            modelID: 'big-pickle',
            finish: 'tool-calls',
            time: {
              created: 100,
              completed: 120,
            },
          },
          parts: [
            { type: 'step-start' },
            { type: 'reasoning', text: 'Inspect current directory.' },
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
                  start: 101,
                  end: 110,
                },
              },
            },
            { type: 'text', text: '\n\n/tmp/project' },
            { type: 'step-finish', reason: 'stop' },
          ],
        },
      ],
    })

    expect(projection.messageCount).toBe(1)
    expect(projection.toolCallCount).toBe(1)
    expect(projection.errorCount).toBe(0)
    expect(projection.messages[0]).toEqual(
      expect.objectContaining({
        text: '/tmp/project',
        reasoningText: 'Inspect current directory.',
        finishReason: 'tool-calls',
      }),
    )
    expect(projection.messages[0]?.contentBlocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'step_start' }),
        expect.objectContaining({ type: 'reasoning', text: 'Inspect current directory.' }),
        expect.objectContaining({ type: 'tool_use', id: 'call_pwd', name: 'bash' }),
        expect.objectContaining({
          type: 'tool_result',
          toolUseId: 'call_pwd',
          contentText: '/tmp/project\n',
        }),
        expect.objectContaining({ type: 'text', text: '\n\n/tmp/project' }),
        expect.objectContaining({ type: 'step_finish', reason: 'stop' }),
      ]),
    )
  })

  test('projects assistant error blocks when OpenCode returns info.error', () => {
    const projection = projector.projectSessionMessages({
      sessionId: 'session-2',
      messages: [
        {
          info: {
            id: 'msg-assistant-error',
            role: 'assistant',
            providerID: 'openai',
            modelID: 'gpt-5.4-mini',
            time: {
              created: 200,
              completed: 201,
            },
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

    expect(projection.errorCount).toBe(1)
    expect(projection.messages[0]).toEqual(
      expect.objectContaining({
        hasError: true,
        errorName: 'UnknownError',
        errorMessage: 'Token refresh failed: 401',
      }),
    )
    expect(projection.messages[0]?.contentBlocks).toEqual([
      {
        type: 'error',
        name: 'UnknownError',
        message: 'Token refresh failed: 401',
      },
    ])
  })
})
