import { afterEach, describe, expect, test } from 'bun:test'

import {
  mapCodexNativeExecLine,
  mapCodexNativeExecOutput,
} from './jsonlMapper.js'

const NATIVE_MAPPING_ENV = 'CLAUDE_CODE_CODEX_NATIVE_TOOL_MAPPING_ENABLED'

describe('mapCodexNativeExecLine', () => {
  afterEach(() => {
    delete process.env[NATIVE_MAPPING_ENV]
  })

  test('maps live codex exec JSONL events into normalized phase-0 events', () => {
    expect(
      mapCodexNativeExecLine(
        '{"type":"thread.started","thread_id":"thread-1"}',
      ),
    ).toEqual([
      {
        type: 'thread_started',
        threadId: 'thread-1',
      },
    ])

    expect(mapCodexNativeExecLine('{"type":"turn.started"}')).toEqual([
      { type: 'turn_started' },
    ])

    expect(
      mapCodexNativeExecLine(
        '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"OK"}}',
      ),
    ).toEqual([
      {
        type: 'assistant_text',
        itemId: 'item_0',
        text: 'OK',
      },
    ])

    expect(
      mapCodexNativeExecLine(
        '{"type":"item.started","item":{"id":"item_1","type":"mcp_tool_call","server":"agent-teams","tool":"member_briefing","arguments":{"teamName":"harbor-labs","memberName":"alice"},"status":"in_progress"}}',
      ),
    ).toEqual([
      {
        type: 'tool_call_started',
        itemId: 'item_1',
        toolSource: 'mcp',
        serverName: 'agent-teams',
        toolName: 'member_briefing',
        arguments: {
          teamName: 'harbor-labs',
          memberName: 'alice',
        },
        status: 'in_progress',
        rawItemType: 'mcp_tool_call',
      },
    ])

    expect(
      mapCodexNativeExecLine(
        '{"type":"item.completed","item":{"id":"item_1","type":"mcp_tool_call","server":"agent-teams","tool":"member_briefing","arguments":{"teamName":"harbor-labs","memberName":"alice"},"result":{"content":[{"type":"text","text":"briefing ok"}],"structured_content":null},"error":null,"status":"completed"}}',
      ),
    ).toEqual([
      {
        type: 'tool_call_completed',
        itemId: 'item_1',
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
          structured_content: null,
        },
        errorMessage: null,
        isError: false,
        rawItemType: 'mcp_tool_call',
      },
    ])

    expect(
      mapCodexNativeExecLine(
        '{"type":"turn.completed","usage":{"input_tokens":22559,"cached_input_tokens":3456,"output_tokens":45}}',
      ),
    ).toEqual([
      {
        type: 'usage_updated',
        inputTokens: 22559,
        cachedInputTokens: 3456,
        outputTokens: 45,
      },
      {
        type: 'turn_completed',
      },
    ])
  })

  test('maps Codex command_execution items into Bash synthetic tool events', () => {
    expect(
      mapCodexNativeExecLine(
        '{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"pwd && ls","status":"in_progress"}}',
      ),
    ).toEqual([
      {
        type: 'tool_call_started',
        itemId: 'item_1',
        toolSource: 'native',
        toolName: 'Bash',
        arguments: {
          command: 'pwd && ls',
        },
        status: 'in_progress',
        rawItemType: 'command_execution',
      },
    ])

    expect(
      mapCodexNativeExecLine(
        '{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"pwd && ls","aggregated_output":"/tmp\\nfile.txt\\n","exit_code":0,"status":"completed"}}',
      ),
    ).toEqual([
      {
        type: 'tool_call_completed',
        itemId: 'item_1',
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
          stderr: '',
          exitCode: 0,
          status: 'completed',
          toolName: 'Bash',
          toolUseId: 'item_1',
        },
        errorMessage: null,
        isError: false,
        rawItemType: 'command_execution',
      },
    ])
  })

  test('marks failed and declined command_execution results as errors', () => {
    expect(
      mapCodexNativeExecLine(
        '{"type":"item.completed","item":{"id":"item_2","type":"command_execution","command":"exit 2","aggregated_output":"boom","exit_code":2,"status":"completed"}}',
      )[0],
    ).toMatchObject({
      type: 'tool_call_completed',
      toolSource: 'native',
      toolName: 'Bash',
      isError: true,
      rawResult: {
        content: 'boom',
        exitCode: 2,
      },
    })

    expect(
      mapCodexNativeExecLine(
        '{"type":"item.completed","item":{"id":"item_3","type":"command_execution","command":"rm -rf /tmp/x","stderr":"declined","status":"declined"}}',
      )[0],
    ).toMatchObject({
      type: 'tool_call_completed',
      toolSource: 'native',
      toolName: 'Bash',
      isError: true,
      errorMessage: null,
      rawResult: {
        content: 'declined',
        stderr: 'declined',
        status: 'declined',
      },
    })
  })

  test('maps Codex file_change items into conservative Edit synthetic tool events', () => {
    expect(
      mapCodexNativeExecLine(
        '{"type":"item.started","item":{"id":"item_4","type":"file_change","changes":[{"path":"/tmp/x","kind":"update"}],"status":"in_progress"}}',
      ),
    ).toEqual([
      {
        type: 'tool_call_started',
        itemId: 'item_4',
        toolSource: 'native',
        toolName: 'Edit',
        arguments: {
          file_path: '/tmp/x',
          changes: [{ path: '/tmp/x', kind: 'update' }],
        },
        status: 'in_progress',
        rawItemType: 'file_change',
      },
    ])

    expect(
      mapCodexNativeExecLine(
        '{"type":"item.completed","item":{"id":"item_4","type":"file_change","changes":[{"path":"/tmp/x","kind":"update"},{"path":"/tmp/y","kind":"add"}],"status":"completed"}}',
      ),
    ).toEqual([
      {
        type: 'tool_call_completed',
        itemId: 'item_4',
        toolSource: 'native',
        toolName: 'Edit',
        arguments: {
          file_path: '/tmp/x',
          changes: [
            { path: '/tmp/x', kind: 'update' },
            { path: '/tmp/y', kind: 'add' },
          ],
        },
        status: 'completed',
        resultText: 'File changes:\n- /tmp/x (update)\n- /tmp/y (add)',
        rawResult: {
          content: 'File changes:\n- /tmp/x (update)\n- /tmp/y (add)',
          changes: [
            { path: '/tmp/x', kind: 'update' },
            { path: '/tmp/y', kind: 'add' },
          ],
          status: 'completed',
          toolName: 'Edit',
          toolUseId: 'item_4',
        },
        errorMessage: null,
        isError: false,
        rawItemType: 'file_change',
      },
    ])
  })

  test('supports docs-style method/params wrappers without losing raw Codex events', () => {
    expect(
      mapCodexNativeExecLine(
        '{"method":"item.completed","params":{"item":{"id":"item_5","type":"command_execution","command":"whoami","output":"belief\\n","exitCode":0,"status":"completed"}}}',
      )[0],
    ).toMatchObject({
      type: 'tool_call_completed',
      itemId: 'item_5',
      toolSource: 'native',
      toolName: 'Bash',
      rawItemType: 'command_execution',
      rawResult: {
        content: 'belief\n',
        stdout: 'belief\n',
        exitCode: 0,
      },
    })
  })

  test('does not warn for normal todo_list and reasoning item lifecycle noise', () => {
    expect(
      mapCodexNativeExecLine(
        '{"type":"item.updated","item":{"id":"todo_1","type":"todo_list","items":[]}}',
      ),
    ).toEqual([])

    expect(
      mapCodexNativeExecLine(
        '{"type":"item.completed","item":{"id":"reason_1","type":"reasoning","text":"thinking done"}}',
      ),
    ).toEqual([])
  })

  test('preserves unsupported known-future item types as compact raw warnings', () => {
    expect(
      mapCodexNativeExecLine(
        '{"type":"item.completed","item":{"id":"search_1","type":"web_search","query":"codex"}}',
      ),
    ).toEqual([
      {
        type: 'unsupported_raw_event',
        rawType: 'item.completed:web_search',
        payload: {
          type: 'item.completed',
          item: {
            id: 'search_1',
            type: 'web_search',
            query: 'codex',
          },
        },
      },
    ])
  })

  test('can disable native command/file mapping without affecting MCP mapping', () => {
    process.env[NATIVE_MAPPING_ENV] = 'false'

    expect(
      mapCodexNativeExecLine(
        '{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"pwd","aggregated_output":"/tmp","exit_code":0,"status":"completed"}}',
      ),
    ).toEqual([])

    expect(
      mapCodexNativeExecLine(
        '{"type":"item.started","item":{"id":"item_2","type":"mcp_tool_call","server":"agent-teams","tool":"task_get","arguments":{"teamName":"demo"},"status":"in_progress"}}',
      )[0],
    ).toMatchObject({
      type: 'tool_call_started',
      toolSource: 'mcp',
      serverName: 'agent-teams',
      toolName: 'task_get',
    })
  })

  test('treats stderr warnings and unparseable lines as warning events', () => {
    expect(
      mapCodexNativeExecLine(
        '2026-04-19T14:53:29.679484Z  WARN codex_exec: thread/read failed while backfilling turn items for turn completion: thread/read: thread/read failed: ephemeral threads do not support includeTurns',
      ),
    ).toEqual([
      {
        type: 'warning',
        source: 'stderr',
        text: '2026-04-19T14:53:29.679484Z  WARN codex_exec: thread/read failed while backfilling turn items for turn completion: thread/read: thread/read failed: ephemeral threads do not support includeTurns',
      },
    ])

    expect(mapCodexNativeExecLine('not-json')).toEqual([
      {
        type: 'warning',
        source: 'stderr',
        text: 'not-json',
      },
    ])
  })

  test('preserves unsupported raw JSON events without silently dropping them', () => {
    expect(
      mapCodexNativeExecLine(
        '{"type":"exec_approval_request","call_id":"call_123"}',
      ),
    ).toEqual([
      {
        type: 'unsupported_raw_event',
        rawType: 'exec_approval_request',
        payload: {
          type: 'exec_approval_request',
          call_id: 'call_123',
        },
      },
    ])
  })

  test('surfaces Codex error and turn failure messages', () => {
    expect(
      mapCodexNativeExecLine(
        '{"type":"error","message":"Quota exceeded. Check your plan and billing details."}',
      ),
    ).toEqual([
      {
        type: 'warning',
        source: 'codex',
        text: 'Codex native error: Quota exceeded. Check your plan and billing details.',
      },
    ])

    expect(
      mapCodexNativeExecLine(
        '{"type":"turn.failed","error":{"message":"Missing bearer or basic authentication in header"}}',
      ),
    ).toEqual([
      {
        type: 'warning',
        source: 'codex',
        text: 'Codex native turn failed: Missing bearer or basic authentication in header',
      },
    ])
  })
})

describe('mapCodexNativeExecOutput', () => {
  test('maps mixed stdout and stderr output in order', () => {
    expect(
      mapCodexNativeExecOutput(
        [
          '{"type":"thread.started","thread_id":"thread-1"}',
          '2026-04-19T14:53:22.412234Z  WARN codex_state::runtime: failed to open state db',
          '{"type":"turn.started"}',
          '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"OK"}}',
          '{"type":"item.started","item":{"id":"item_1","type":"mcp_tool_call","server":"agent-teams","tool":"member_briefing","arguments":{"teamName":"harbor-labs"},"status":"in_progress"}}',
          '{"type":"item.completed","item":{"id":"item_2","type":"command_execution","command":"pwd","aggregated_output":"/tmp\\n","exit_code":0,"status":"completed"}}',
          '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":2,"output_tokens":1}}',
        ].join('\n'),
      ),
    ).toEqual([
      {
        type: 'thread_started',
        threadId: 'thread-1',
      },
      {
        type: 'warning',
        source: 'stderr',
        text: '2026-04-19T14:53:22.412234Z  WARN codex_state::runtime: failed to open state db',
      },
      {
        type: 'turn_started',
      },
      {
        type: 'assistant_text',
        itemId: 'item_0',
        text: 'OK',
      },
      {
        type: 'tool_call_started',
        itemId: 'item_1',
        toolSource: 'mcp',
        serverName: 'agent-teams',
        toolName: 'member_briefing',
        arguments: {
          teamName: 'harbor-labs',
        },
        status: 'in_progress',
        rawItemType: 'mcp_tool_call',
      },
      {
        type: 'tool_call_completed',
        itemId: 'item_2',
        toolSource: 'native',
        toolName: 'Bash',
        arguments: {
          command: 'pwd',
        },
        status: 'completed',
        resultText: '/tmp\n',
        rawResult: {
          content: '/tmp\n',
          stdout: '/tmp\n',
          stderr: '',
          exitCode: 0,
          status: 'completed',
          toolName: 'Bash',
          toolUseId: 'item_2',
        },
        errorMessage: null,
        isError: false,
        rawItemType: 'command_execution',
      },
      {
        type: 'usage_updated',
        inputTokens: 10,
        cachedInputTokens: 2,
        outputTokens: 1,
      },
      {
        type: 'turn_completed',
      },
    ])
  })
})
