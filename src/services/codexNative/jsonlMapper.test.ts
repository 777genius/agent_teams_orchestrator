import { describe, expect, test } from 'bun:test'

import {
  mapCodexNativeExecLine,
  mapCodexNativeExecOutput,
} from './jsonlMapper.js'

describe('mapCodexNativeExecLine', () => {
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
        serverName: 'agent-teams',
        toolName: 'member_briefing',
        arguments: {
          teamName: 'harbor-labs',
          memberName: 'alice',
        },
        status: 'in_progress',
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

  test('drops unsupported item lifecycle events instead of surfacing noisy warnings', () => {
    expect(
      mapCodexNativeExecLine(
        '{"type":"item.started","item":{"id":"item_9","type":"reasoning","text":"thinking"}}',
      ),
    ).toEqual([])

    expect(
      mapCodexNativeExecLine(
        '{"type":"item.completed","item":{"id":"item_9","type":"reasoning","text":"thinking done"}}',
      ),
    ).toEqual([])
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
          '{"type":"item.completed","item":{"id":"item_1","type":"mcp_tool_call","server":"agent-teams","tool":"member_briefing","arguments":{"teamName":"harbor-labs"},"result":{"content":[{"type":"text","text":"briefing ok"}],"structured_content":null},"error":null,"status":"completed"}}',
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
        serverName: 'agent-teams',
        toolName: 'member_briefing',
        arguments: {
          teamName: 'harbor-labs',
        },
        status: 'in_progress',
      },
      {
        type: 'tool_call_completed',
        itemId: 'item_1',
        serverName: 'agent-teams',
        toolName: 'member_briefing',
        arguments: {
          teamName: 'harbor-labs',
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
