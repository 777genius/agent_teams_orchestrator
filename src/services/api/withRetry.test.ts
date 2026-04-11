import { describe, expect, test } from 'bun:test'
import { APIError } from '@anthropic-ai/sdk'

import { getGeminiCapacityResetDelayMs } from './withRetry.js'

function buildApiError(message: string): APIError {
  const error = Object.assign(new Error(message), {
    status: 429,
    headers: new Headers(),
  })
  Object.setPrototypeOf(error, APIError.prototype)
  return error as APIError
}

describe('Gemini capacity reset retry parsing', () => {
  test('parses reset windows from Gemini CLI capacity messages', () => {
    const delayMs = getGeminiCapacityResetDelayMs(
      buildApiError(
        'Gemini cli backend error: You have exhausted your capacity on this model. Your quota will reset after 23s.',
      ),
    )

    expect(delayMs).not.toBeNull()
    expect(delayMs!).toBeGreaterThanOrEqual(23_000)
    expect(delayMs!).toBeLessThanOrEqual(25_000)
  })

  test('returns null for non-Gemini rate limit messages', () => {
    const delayMs = getGeminiCapacityResetDelayMs(
      buildApiError('Rate limit exceeded. Please retry later.'),
    )

    expect(delayMs).toBeNull()
  })

  test('returns null when reset window is missing from the message', () => {
    const delayMs = getGeminiCapacityResetDelayMs(
      buildApiError(
        'Gemini cli backend error: You have exhausted your capacity on this model.',
      ),
    )

    expect(delayMs).toBeNull()
  })
})
