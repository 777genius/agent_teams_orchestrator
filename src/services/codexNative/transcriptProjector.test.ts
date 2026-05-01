import { beforeEach, describe, expect, test } from 'bun:test'

import { getRuntimeBoardTaskExecutionStore } from '../boardTaskActivity/RuntimeBoardTaskExecutionStore.js'
import {
  clearDynamicTeamContext,
  setDynamicTeamContext,
} from '../../utils/teammate.js'
import { CodexNativeTranscriptProjector } from './transcriptProjector.js'

describe('CodexNativeTranscriptProjector', () => {
  beforeEach(() => {
    getRuntimeBoardTaskExecutionStore().clearForTests()
    clearDynamicTeamContext()
  })

  test('projects assistant text and later usage into a transcript-compatible assistant message', () => {
    const projector = new CodexNativeTranscriptProjector()

    const assistantProjection = projector.apply({
      type: 'assistant_text',
      itemId: 'item_0',
      text: 'OK',
    })

    expect(assistantProjection.turnCompleted).toBe(false)
    expect(assistantProjection.appendedMessages).toHaveLength(1)
    expect(assistantProjection.appendedMessages[0]).toMatchObject({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'text',
            text: 'OK',
          },
        ],
      },
    })

    const usageProjection = projector.apply({
      type: 'usage_updated',
      inputTokens: 12,
      cachedInputTokens: 4,
      outputTokens: 2,
    })

    expect(usageProjection.appendedMessages).toEqual([])
    expect(projector.getLastAssistantMessage()).toMatchObject({
      message: {
        usage: {
          input_tokens: 12,
          cache_read_input_tokens: 4,
          output_tokens: 2,
        },
      },
    })
    expect(projector.getTotalUsage()).toMatchObject({
      input_tokens: 12,
      cache_read_input_tokens: 4,
      output_tokens: 2,
    })
  })

  test('projects warnings and unsupported raw events into system warning messages', () => {
    const projector = new CodexNativeTranscriptProjector()

    expect(
      projector.apply({
        type: 'thread_started',
        threadId: 'thread-1',
      }),
    ).toMatchObject({
      appendedMessages: [
        {
          type: 'system',
          subtype: 'codex_native_thread_status',
          codexNativeThreadStatus: 'running',
          codexNativeThreadId: 'thread-1',
        },
      ],
      turnCompleted: false,
    })

    expect(
      projector.apply({
        type: 'warning',
        source: 'stderr',
        text: 'native stderr warning',
      }),
    ).toMatchObject({
      appendedMessages: [
        {
          type: 'system',
          subtype: 'codex_native_warning',
          level: 'warning',
          content: 'native stderr warning',
          codexNativeWarningSource: 'process',
        },
      ],
      turnCompleted: false,
    })

    expect(
      projector.apply({
        type: 'unsupported_raw_event',
        rawType: 'tool/requestUserInput',
        payload: {},
      }),
    ).toMatchObject({
      appendedMessages: [
        {
          type: 'system',
          subtype: 'codex_native_warning',
          level: 'warning',
          content:
            'Codex native emitted an unsupported raw event: tool/requestUserInput',
          codexNativeWarningSource: 'process',
        },
      ],
      turnCompleted: false,
    })
  })

  test('projects MCP tool calls into assistant tool_use and user tool_result blocks without clobbering the last text assistant', () => {
    const projector = new CodexNativeTranscriptProjector()

    projector.apply({
      type: 'assistant_text',
      itemId: 'item_0',
      text: 'Calling member_briefing now.',
    })

    expect(
      projector.apply({
        type: 'tool_call_started',
        itemId: 'tool-1',
        toolSource: 'mcp',
        serverName: 'agent-teams',
        toolName: 'member_briefing',
        arguments: {
          teamName: 'harbor-labs',
          memberName: 'alice',
        },
        status: 'in_progress',
        rawItemType: 'mcp_tool_call',
      }),
    ).toMatchObject({
      appendedMessages: [
        {
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'tool-1',
                name: 'mcp__agent-teams__member_briefing',
                input: {
                  teamName: 'harbor-labs',
                  memberName: 'alice',
                },
              },
            ],
          },
        },
      ],
      turnCompleted: false,
    })

    expect(
      projector.apply({
        type: 'tool_call_completed',
        itemId: 'tool-1',
        toolSource: 'mcp',
        serverName: 'agent-teams',
        toolName: 'member_briefing',
        arguments: {
          teamName: 'harbor-labs',
          memberName: 'alice',
        },
        status: 'completed',
        resultText: 'briefing ok',
        rawResult: {
          content: [
            {
              type: 'text',
              text: 'briefing ok',
            },
          ],
        },
        errorMessage: null,
        isError: false,
        rawItemType: 'mcp_tool_call',
      }),
    ).toMatchObject({
      appendedMessages: [
        {
          type: 'user',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tool-1',
                content: 'briefing ok',
                is_error: false,
              },
            ],
          },
        },
      ],
      turnCompleted: false,
    })

    projector.apply({
      type: 'usage_updated',
      inputTokens: 7,
      cachedInputTokens: 1,
      outputTokens: 2,
    })

    expect(projector.getLastAssistantMessage()).toMatchObject({
      message: {
        content: [
          {
            type: 'text',
            text: 'Calling member_briefing now.',
          },
        ],
        usage: {
          input_tokens: 7,
          cache_read_input_tokens: 1,
          output_tokens: 2,
        },
      },
    })
  })

  test('projects native command tools without fabricating MCP tool names', () => {
    const projector = new CodexNativeTranscriptProjector()

    const start = projector.apply({
      type: 'tool_call_started',
      itemId: 'item-command',
      toolSource: 'native',
      toolName: 'Bash',
      arguments: {
        command: 'pwd && ls',
      },
      status: 'in_progress',
      rawItemType: 'command_execution',
    })

    expect(start.appendedMessages[0]).toMatchObject({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'item-command',
            name: 'Bash',
            input: {
              command: 'pwd && ls',
            },
          },
        ],
      },
    })
    expect(JSON.stringify(start.appendedMessages[0])).not.toContain('mcp__undefined')

    const result = projector.apply({
      type: 'tool_call_completed',
      itemId: 'item-command',
      toolSource: 'native',
      toolName: 'Bash',
      arguments: {
        command: 'pwd && ls',
      },
      status: 'completed',
      resultText: '/tmp\nfile.txt\n',
      rawResult: {
        content: '/tmp\nfile.txt\n',
        stdout: '/tmp\nfile.txt\n',
        exitCode: 0,
      },
      errorMessage: null,
      isError: false,
      rawItemType: 'command_execution',
    })

    expect(result.appendedMessages[0]).toMatchObject({
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'item-command',
            content: '/tmp\nfile.txt\n',
            is_error: false,
          },
        ],
      },
      toolUseResult: {
        content: '/tmp\nfile.txt\n',
        stdout: '/tmp\nfile.txt\n',
        exitCode: 0,
      },
    })
    expect(result.appendedMessages[0]).not.toHaveProperty('boardTaskToolActions')
  })

  test('annotates Codex-native board lifecycle and ambient execution metadata for teammate sessions', () => {
    setDynamicTeamContext({
      agentId: 'alice@harbor-labs',
      agentName: 'alice',
      teamName: 'harbor-labs',
      planModeRequired: false,
    })

    const projector = new CodexNativeTranscriptProjector()

    projector.apply({
      type: 'tool_call_started',
      itemId: 'tool-start',
      toolSource: 'mcp',
      serverName: 'agent-teams',
      toolName: 'task_start',
      arguments: {
        teamName: 'harbor-labs',
        taskId: 'abcd1234',
      },
      status: 'in_progress',
      rawItemType: 'mcp_tool_call',
    })

    const startResult = projector.apply({
      type: 'tool_call_completed',
      itemId: 'tool-start',
      toolSource: 'mcp',
      serverName: 'agent-teams',
      toolName: 'task_start',
      arguments: {
        teamName: 'harbor-labs',
        taskId: 'abcd1234',
      },
      status: 'completed',
      resultText: 'started',
      rawResult: {
        id: '123e4567-e89b-12d3-a456-426614174000',
        displayId: 'abcd1234',
      },
      errorMessage: null,
      isError: false,
      rawItemType: 'mcp_tool_call',
    })

    expect(startResult.appendedMessages[0]).toMatchObject({
      type: 'user',
      boardTaskLinks: [
        {
          toolUseId: 'tool-start',
          linkKind: 'lifecycle',
          task: {
            ref: 'abcd1234',
            refKind: 'display',
            canonicalId: '123e4567-e89b-12d3-a456-426614174000',
          },
        },
      ],
      boardTaskToolActions: [
        {
          toolUseId: 'tool-start',
          canonicalToolName: 'task_start',
        },
      ],
    })

    const assistantProjection = projector.apply({
      type: 'assistant_text',
      itemId: 'item-1',
      text: 'Inspecting the task context now.',
    })

    expect(assistantProjection.appendedMessages[0]).toMatchObject({
      type: 'assistant',
      boardTaskLinks: [
        {
          linkKind: 'execution',
          task: {
            ref: 'abcd1234',
            refKind: 'display',
            canonicalId: '123e4567-e89b-12d3-a456-426614174000',
          },
          actorContext: {
            relation: 'same_task',
          },
        },
      ],
    })

    projector.apply({
      type: 'tool_call_started',
      itemId: 'tool-read',
      toolSource: 'mcp',
      serverName: 'filesystem',
      toolName: 'read_file',
      arguments: {
        path: '/tmp/spec.md',
      },
      status: 'in_progress',
      rawItemType: 'mcp_tool_call',
    })

    const readResult = projector.apply({
      type: 'tool_call_completed',
      itemId: 'tool-read',
      toolSource: 'mcp',
      serverName: 'filesystem',
      toolName: 'read_file',
      arguments: {
        path: '/tmp/spec.md',
      },
      status: 'completed',
      resultText: 'spec contents',
      rawResult: {
        content: [
          {
            type: 'text',
            text: 'spec contents',
          },
        ],
      },
      errorMessage: null,
      isError: false,
      rawItemType: 'mcp_tool_call',
    })

    expect(readResult.appendedMessages[0]).toMatchObject({
      type: 'user',
      boardTaskLinks: [
        {
          toolUseId: 'tool-read',
          linkKind: 'execution',
          task: {
            ref: 'abcd1234',
            refKind: 'display',
            canonicalId: '123e4567-e89b-12d3-a456-426614174000',
          },
        },
      ],
    })
  })
})
