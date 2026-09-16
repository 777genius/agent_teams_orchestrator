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

  test('keeps HTTP 403 Forbidden as not authenticated for execution probes', () => {
    expect(classifyOpenCodeProviderFailure('HTTP 403 Forbidden')).toBe('not_authenticated')
  })

  test('keeps UnauthorizedError as not authenticated without matching unauthorized_user', () => {
    expect(classifyOpenCodeProviderFailure('UnauthorizedError: bad credentials')).toBe(
      'not_authenticated',
    )
    expect(classifyOpenCodeProviderFailure('unauthorized_user lookup failed')).toBe('unknown')
  })

  test('leaves unknown host crashes unclassified', () => {
    expect(classifyOpenCodeProviderFailure('connect ECONNREFUSED 127.0.0.1:4096')).toBe('unknown')
  })
})

describe('classifyOpenCodeCatalogSanitizedFailure', () => {
  test('returns a reconnect catalog error without leaking the refresh payload', () => {
    const classified = classifyOpenCodeCatalogSanitizedFailure({
      displayName: 'xAI',
      rawMessage:
        'xAI token refresh failed (400): {"error":"invalid_grant","error_description":"Invalid or unknown refresh token"}',
    })
    expect(classified).toEqual({
      code: 'auth-failed',
      message: 'xAI sign-in is no longer valid. Sign in again, then refresh the OpenCode catalog.',
    })
    expect(classified.message).not.toContain('invalid_grant')
    expect(classified.message).not.toContain('SuperGrok')
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

  test('keeps HTTP 401 Unauthorized as catalog auth-failed', () => {
    expect(classifyOpenCodeCatalogSanitizedFailure({
      displayName: 'GitHub Copilot',
      rawMessage: 'HTTP 401 Unauthorized',
    })).toEqual({
      code: 'auth-failed',
      message:
        'GitHub Copilot sign-in is no longer valid. Sign in again, then refresh the OpenCode catalog.',
    })
  })

  test('treats UnauthorizedError as catalog auth-failed', () => {
    expect(classifyOpenCodeCatalogSanitizedFailure({
      displayName: 'GitHub Copilot',
      rawMessage: 'UnauthorizedError: bad credentials',
    })).toEqual({
      code: 'auth-failed',
      message:
        'GitHub Copilot sign-in is no longer valid. Sign in again, then refresh the OpenCode catalog.',
    })
  })

  test('does not treat coincidental 401/403 numbers or forbidden identifiers as catalog auth failures', () => {
    for (const rawMessage of [
      'HTTP 403 Forbidden: account not entitled',
      'HTTP 403 Forbidden',
      'exited with code 1 after writing 403 bytes',
      'missing field: forbiddenModels',
      'timed out after 401 ms',
      'unauthorized_user lookup failed',
    ]) {
      expect(classifyOpenCodeCatalogSanitizedFailure({
        displayName: 'OpenRouter',
        rawMessage,
      })).toEqual({
        code: 'runtime-unhealthy',
        message: "Couldn't load OpenRouter models from OpenCode.",
      })
    }
  })

  test('keeps unknown catalog exceptions behind a non-auth sanitized message', () => {
    const classified = classifyOpenCodeCatalogSanitizedFailure({
      displayName: 'Local',
      rawMessage: 'unprefixed-secret-violet https://private.invalid/models?token=query-secret',
    })
    expect(classified).toEqual({
      code: 'runtime-unhealthy',
      message: "Couldn't load Local models from OpenCode.",
    })
    expect(classified.message).not.toBe(OPEN_CODE_CATALOG_FAILURE_MESSAGE)
    expect(classified.message).not.toContain('query-secret')
  })
})
