import { describe, expect, test } from 'bun:test'

import { evaluateAnthropicApiSmoke } from './anthropicApiSmoke.js'

describe('evaluateAnthropicApiSmoke', () => {
  const authStatus = JSON.stringify({
    status: {
      authenticated: true,
      authMethod: 'api_key',
    },
  })

  test('returns ok for a successful live Anthropic API prompt', () => {
    const report = evaluateAnthropicApiSmoke({
      hasApiKey: true,
      authStatusStdout: authStatus,
      promptStdout: JSON.stringify({
        is_error: false,
        result: 'OK',
      }),
    })

    expect(report).toMatchObject({
      verdict: 'ok',
      ok: true,
      authMethod: 'api_key',
      promptText: 'OK',
      promptErrorText: null,
    })
  })

  test('returns missing_key when ANTHROPIC_API_KEY is absent', () => {
    const report = evaluateAnthropicApiSmoke({
      hasApiKey: false,
      authStatusStdout: '',
      promptStdout: '',
    })

    expect(report).toMatchObject({
      verdict: 'missing_key',
      ok: false,
      authMethod: null,
    })
  })

  test('returns routing_error when auth status is not using api_key', () => {
    const report = evaluateAnthropicApiSmoke({
      hasApiKey: true,
      authStatusStdout: JSON.stringify({
        status: {
          authenticated: true,
          authMethod: 'oauth_token',
        },
      }),
      promptStdout: JSON.stringify({
        is_error: false,
        result: 'OK',
      }),
    })

    expect(report).toMatchObject({
      verdict: 'routing_error',
      ok: false,
      authMethod: 'oauth_token',
    })
  })

  test('returns billing_error for quota failures', () => {
    const report = evaluateAnthropicApiSmoke({
      hasApiKey: true,
      authStatusStdout: authStatus,
      promptStdout: JSON.stringify({
        is_error: true,
        result:
          'API Error: {"type":"error","error":{"type":"billing_error","message":"Credit balance is too low"}}',
      }),
    })

    expect(report).toMatchObject({
      verdict: 'billing_error',
      ok: false,
    })
  })

  test('returns auth_error for authentication failures', () => {
    const report = evaluateAnthropicApiSmoke({
      hasApiKey: true,
      authStatusStdout: authStatus,
      promptStdout: JSON.stringify({
        is_error: true,
        result:
          'API Error: {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
      }),
    })

    expect(report).toMatchObject({
      verdict: 'auth_error',
      ok: false,
    })
  })

  test('returns rate_limit_error for throttling failures', () => {
    const report = evaluateAnthropicApiSmoke({
      hasApiKey: true,
      authStatusStdout: authStatus,
      promptStdout: JSON.stringify({
        is_error: true,
        result:
          'API Error: {"type":"error","error":{"type":"rate_limit_error","message":"rate limit exceeded"}}',
      }),
    })

    expect(report).toMatchObject({
      verdict: 'rate_limit_error',
      ok: false,
    })
  })

  test('returns runtime_error when the prompt did not return parseable JSON', () => {
    const report = evaluateAnthropicApiSmoke({
      hasApiKey: true,
      authStatusStdout: authStatus,
      promptStdout: 'plain text failure',
      promptStderr: 'stack trace here',
    })

    expect(report).toMatchObject({
      verdict: 'runtime_error',
      ok: false,
      promptErrorText: 'stack trace here',
    })
  })
})
