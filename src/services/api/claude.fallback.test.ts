import { describe, expect, test } from 'bun:test'
import { APIError } from '@anthropic-ai/sdk/core/error'

import { shouldSkipStreamingToNonStreamingFallback } from './claude.js'

describe('shouldSkipStreamingToNonStreamingFallback', () => {
  test('skips fallback for unrecoverable billing/authentication style API errors', () => {
    const billingError = new APIError(
      undefined,
      {
        type: 'error',
        error: {
          type: 'billing_error',
          message: 'Quota exceeded',
        },
      },
      undefined,
      new Headers({ 'request-id': 'req_123' }),
    )

    const authError = new APIError(
      undefined,
      {
        type: 'error',
        error: {
          type: 'authentication_error',
          message: 'Bad key',
        },
      },
      undefined,
      undefined,
    )

    expect(shouldSkipStreamingToNonStreamingFallback(billingError)).toBe(true)
    expect(shouldSkipStreamingToNonStreamingFallback(authError)).toBe(true)
  })

  test('keeps fallback enabled for retryable or unknown streaming failures', () => {
    const rateLimitError = new APIError(
      undefined,
      {
        type: 'error',
        error: {
          type: 'rate_limit_error',
          message: 'Slow down',
        },
      },
      undefined,
      undefined,
    )

    expect(shouldSkipStreamingToNonStreamingFallback(rateLimitError)).toBe(
      false,
    )
    expect(
      shouldSkipStreamingToNonStreamingFallback(new Error('boom')),
    ).toBe(false)
  })
})
