import { describe, expect, test } from 'bun:test'

import { isHumanTurn } from './messagePredicates.js'

function userRoleMessage(
  overrides: Partial<Parameters<typeof isHumanTurn>[0]> = {},
): Parameters<typeof isHumanTurn>[0] {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: 'Please fix the bug',
    },
    isMeta: false,
    ...overrides,
  } as Parameters<typeof isHumanTurn>[0]
}

describe('isHumanTurn', () => {
  test('accepts ordinary user turns with no explicit origin', () => {
    const message = userRoleMessage()

    expect(isHumanTurn(message)).toBe(true)
  })

  test('accepts ordinary user turns with explicit human origin', () => {
    const message = userRoleMessage({
      origin: { kind: 'human' },
    })

    expect(isHumanTurn(message)).toBe(true)
  })

  test('rejects user-role tool result messages even with human origin', () => {
    const message = userRoleMessage({
      origin: { kind: 'human' },
      toolUseResult: {},
    })

    expect(isHumanTurn(message)).toBe(false)
  })

  test('rejects user-role tool result content even without toolUseResult metadata', () => {
    const message = userRoleMessage({
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
    } as Partial<Parameters<typeof isHumanTurn>[0]>)

    expect(isHumanTurn(message)).toBe(false)
  })

  test('rejects synthetic user-role replay text even without meta flag', () => {
    const message = userRoleMessage({
      isSynthetic: true,
      origin: { kind: 'human' },
    } as Partial<Parameters<typeof isHumanTurn>[0]>)

    expect(isHumanTurn(message)).toBe(false)
  })

  test('rejects non-human user-role task notifications', () => {
    const message = userRoleMessage({
      origin: { kind: 'task-notification' },
    })

    expect(isHumanTurn(message)).toBe(false)
  })

  test('rejects coordinator-origin user-role messages', () => {
    const message = userRoleMessage({
      origin: { kind: 'coordinator' },
    })

    expect(isHumanTurn(message)).toBe(false)
  })

  test('rejects structured teammate protocol user-role messages', () => {
    const message = userRoleMessage({
      protocolKind: 'teammate-message',
    } as Partial<Parameters<typeof isHumanTurn>[0]>)

    expect(isHumanTurn(message)).toBe(false)
  })

  test('keeps replay-only user text human-compatible', () => {
    const message = userRoleMessage({
      isReplay: true,
      message: {
        role: 'user',
        content: 'Human: I tested the feature looks good',
      },
    } as Partial<Parameters<typeof isHumanTurn>[0]>)

    expect(isHumanTurn(message)).toBe(true)
  })

  test('rejects compact summary user-role messages', () => {
    const message = userRoleMessage({
      isCompactSummary: true,
    } as Partial<Parameters<typeof isHumanTurn>[0]>)

    expect(isHumanTurn(message)).toBe(false)
  })
})
