import { describe, expect, test } from 'bun:test'

import type { SDKUserMessageReplay } from '../entrypoints/agentSdkTypes.js'
import { convertSDKMessage } from './sdkMessageAdapter.js'

function userReplay(
  overrides: Partial<SDKUserMessageReplay> = {},
): SDKUserMessageReplay {
  return {
    type: 'user',
    session_id: 'session-1',
    parent_tool_use_id: null,
    uuid: 'user-replay-1',
    isReplay: true,
    message: {
      role: 'user',
      content: 'Human: I tested the feature looks good',
    },
    ...overrides,
  } as SDKUserMessageReplay
}

describe('convertSDKMessage', () => {
  test('does not render synthetic user replay as human text', () => {
    const result = convertSDKMessage(userReplay({ isSynthetic: true }), {
      convertUserTextMessages: true,
    })

    expect(result).toEqual({ type: 'ignored' })
  })

  test('does not render structured non-human replay as human text without synthetic flag', () => {
    const result = convertSDKMessage(
      userReplay({
        protocolKind: 'teammate-message',
        message: {
          role: 'user',
          content:
            '<teammate-message teammate_id="alice">Looks good</teammate-message>',
        },
      }),
      {
        convertUserTextMessages: true,
      },
    )

    expect(result).toEqual({ type: 'ignored' })
  })

  test('still renders non-synthetic historical user text when requested', () => {
    const result = convertSDKMessage(userReplay(), {
      convertUserTextMessages: true,
    })

    expect(result.type).toBe('message')
    if (result.type === 'message') {
      expect(result.message.type).toBe('user')
      expect(result.message.message.content).toBe(
        'Human: I tested the feature looks good',
      )
    }
  })

  test('still renders synthetic tool results when tool-result conversion is enabled', () => {
    const result = convertSDKMessage(
      userReplay({
        isSynthetic: true,
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-1',
              content: 'result text',
            },
          ],
        },
      }),
      {
        convertToolResults: true,
        convertUserTextMessages: true,
      },
    )

    expect(result.type).toBe('message')
    if (result.type === 'message') {
      expect(result.message.type).toBe('user')
      expect(result.message.toolUseResult).toBeUndefined()
      expect(result.message.message.content).toEqual([
        {
          type: 'tool_result',
          tool_use_id: 'tool-1',
          content: 'result text',
        },
      ])
    }
  })

  test('still renders synthetic local command output when text conversion is enabled', () => {
    const result = convertSDKMessage(
      userReplay({
        isSynthetic: true,
        origin: { kind: 'coordinator' },
        protocolKind: 'teammate-message',
        message: {
          role: 'user',
          content:
            '<local-command-stdout>Set model to sonnet</local-command-stdout>',
        },
      }),
      {
        convertUserTextMessages: true,
      },
    )

    expect(result.type).toBe('message')
    if (result.type === 'message') {
      expect(result.message.type).toBe('user')
      expect(result.message.message.content).toBe(
        '<local-command-stdout>Set model to sonnet</local-command-stdout>',
      )
      expect(result.message.isSynthetic).toBe(true)
      expect(result.message.origin).toEqual({ kind: 'coordinator' })
      expect(result.message.protocolKind).toBe('teammate-message')
    }
  })
})
