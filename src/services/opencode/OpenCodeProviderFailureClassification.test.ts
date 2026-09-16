import { describe, expect, test } from 'bun:test'

import {
  OPEN_CODE_CATALOG_FAILURE_MESSAGE,
  classifyOpenCodeCatalogSanitizedFailure,
  classifyOpenCodeProviderFailure,
} from './OpenCodeProviderFailureClassification.js'

describe('classifyOpenCodeProviderFailure', () => {
  test('classifies expired OAuth refresh as not authenticated for any provider', () => {
    expect(classifyOpenCodeProviderFailure(
      'xAI token refresh failed (400): {"error":"invalid_grant","error_description":"Invalid or unknown refresh token"}',
    )).toBe('not_authenticated')
    expect(classifyOpenCodeProviderFailure('invalid_grant')).toBe('not_authenticated')
    expect(classifyOpenCodeProviderFailure('Please run `kiro-cli login`')).toBe('not_authenticated')
    expect(classifyOpenCodeProviderFailure('HTTP 401 Unauthorized')).toBe('not_authenticated')
  })

  test('keeps quota ahead of a wrapping 403', () => {
    expect(classifyOpenCodeProviderFailure('HTTP 403 Forbidden: grpc_code=RESOURCE_EXHAUSTED')).toBe(
      'unavailable',
    )
  })

  test('leaves unknown host crashes unclassified', () => {
    expect(classifyOpenCodeProviderFailure('connect ECONNREFUSED 127.0.0.1:4096')).toBe('unknown')
  })
})

describe('classifyOpenCodeCatalogSanitizedFailure', () => {
  test('returns a reconnect catalog error without leaking the refresh payload', () => {
    const classified = classifyOpenCodeCatalogSanitizedFailure({
      displayName: 'SuperGrok',
      rawMessage:
        'xAI token refresh failed (400): {"error":"invalid_grant","error_description":"Invalid or unknown refresh token"}',
    })
    expect(classified).toEqual({
      code: 'auth-failed',
      message: 'SuperGrok sign-in is no longer valid. Sign in again, then refresh the OpenCode catalog.',
    })
    expect(classified.message).not.toContain('invalid_grant')
  })

  test('explains a rejected API key without exposing the secret', () => {
    expect(classifyOpenCodeCatalogSanitizedFailure({
      displayName: 'OpenRouter',
      rawMessage: 'invalid api key sk-secret',
    })).toEqual({
      code: 'auth-failed',
      message: 'OpenRouter rejected this API key. Check the key, then refresh the OpenCode catalog.',
    })
  })

  test('keeps unknown catalog exceptions behind the generic sanitized message', () => {
    const classified = classifyOpenCodeCatalogSanitizedFailure({
      displayName: 'Local',
      rawMessage: 'unprefixed-secret-violet https://private.invalid/models?token=query-secret',
    })
    expect(classified).toEqual({
      code: 'runtime-unhealthy',
      message: OPEN_CODE_CATALOG_FAILURE_MESSAGE,
    })
    expect(classified.message).not.toContain('query-secret')
  })
})
