import { describe, expect, test } from 'bun:test'
import { APIError } from '@anthropic-ai/sdk'

import { getGeminiCapacityResetDelayMs, withRetry } from './withRetry.js'

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

describe('retry model identity', () => {
  test('keeps the exact concrete model across API retries', async () => {
    const requestedModel = 'claude-opus-5-5[1m]'
    const observedModels: string[] = []
    let attempts = 0

    const retryableError = Object.assign(new Error('temporary'), {
      status: 500,
      headers: new Headers({ 'retry-after': '0' }),
    })
    Object.setPrototypeOf(retryableError, APIError.prototype)

    const generator = withRetry(
      async () => ({}) as never,
      async (_client, _attempt, context) => {
        observedModels.push(context.model)
        attempts++
        if (attempts === 1) throw retryableError
        return context.model
      },
      {
        maxRetries: 1,
        model: requestedModel,
        thinkingConfig: { type: 'adaptive' },
      },
    )

    let result = await generator.next()
    while (!result.done) result = await generator.next()
    expect(result.done).toBe(true)
    expect(result.value).toBe(requestedModel)
    expect(observedModels).toEqual([requestedModel, requestedModel])
  })
})
