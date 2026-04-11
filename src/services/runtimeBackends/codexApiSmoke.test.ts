import { describe, expect, test } from 'bun:test'

import { evaluateCodexApiSmoke } from './codexApiSmoke.js'

describe('evaluateCodexApiSmoke', () => {
  const authStatus = JSON.stringify({
    status: {
      authenticated: true,
      authMethod: 'api_key',
    },
  })

  const runtimeStatus = JSON.stringify({
    providers: {
      codex: {
        resolvedBackendId: 'api',
        backend: {
          endpointLabel: 'api.openai.com/v1/responses',
        },
      },
    },
  })

  test('returns ok for a successful live Codex API prompt', () => {
    const report = evaluateCodexApiSmoke({
      hasApiKey: true,
      authStatusStdout: authStatus,
      runtimeStatusStdout: runtimeStatus,
      promptStdout: JSON.stringify({
        is_error: false,
        result: 'OK',
      }),
    })

    expect(report).toMatchObject({
      verdict: 'ok',
      ok: true,
      authMethod: 'api_key',
      resolvedBackendId: 'api',
      promptText: 'OK',
      promptErrorText: null,
    })
  })

  test('returns missing_key when OPENAI_API_KEY is absent', () => {
    const report = evaluateCodexApiSmoke({
      hasApiKey: false,
      authStatusStdout: '',
      runtimeStatusStdout: '',
      promptStdout: '',
    })

    expect(report).toMatchObject({
      verdict: 'missing_key',
      ok: false,
      authMethod: null,
      resolvedBackendId: null,
    })
  })

  test('returns routing_error when auth status is not using api_key', () => {
    const report = evaluateCodexApiSmoke({
      hasApiKey: true,
      authStatusStdout: JSON.stringify({
        status: {
          authenticated: true,
          authMethod: 'oauth_token',
        },
      }),
      runtimeStatusStdout: runtimeStatus,
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

  test('returns billing_error for insufficient quota failures', () => {
    const report = evaluateCodexApiSmoke({
      hasApiKey: true,
      authStatusStdout: authStatus,
      runtimeStatusStdout: runtimeStatus,
      promptStdout: JSON.stringify({
        is_error: true,
        result:
          'API Error: {"type":"error","error":{"type":"billing_error","message":"Codex API error (insufficient_quota): quota exceeded"}}',
      }),
    })

    expect(report).toMatchObject({
      verdict: 'billing_error',
      ok: false,
    })
    expect(report.promptErrorText).toContain('billing_error')
  })

  test('returns auth_error for authentication failures', () => {
    const report = evaluateCodexApiSmoke({
      hasApiKey: true,
      authStatusStdout: authStatus,
      runtimeStatusStdout: runtimeStatus,
      promptStdout: JSON.stringify({
        is_error: true,
        result:
          'API Error: {"type":"error","error":{"type":"authentication_error","message":"invalid_api_key"}}',
      }),
    })

    expect(report).toMatchObject({
      verdict: 'auth_error',
      ok: false,
    })
  })

  test('returns rate_limit_error for throttling failures', () => {
    const report = evaluateCodexApiSmoke({
      hasApiKey: true,
      authStatusStdout: authStatus,
      runtimeStatusStdout: runtimeStatus,
      promptStdout: JSON.stringify({
        is_error: true,
        result:
          'API Error: {"type":"error","error":{"type":"rate_limit_error","message":"rate_limit_exceeded"}}',
      }),
    })

    expect(report).toMatchObject({
      verdict: 'rate_limit_error',
      ok: false,
    })
  })

  test('returns runtime_error when the prompt did not return parseable JSON', () => {
    const report = evaluateCodexApiSmoke({
      hasApiKey: true,
      authStatusStdout: authStatus,
      runtimeStatusStdout: runtimeStatus,
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
