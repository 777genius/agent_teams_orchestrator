import { expect, test } from 'bun:test'
import { classifyOpenCodeV2ProbeFailure } from './OpenCodeV2ProbeFailure.js'

const quota = () => ({ type: 'provider.rate-limit', status: 429,
  response: { body: JSON.stringify({ error: { code: 429, metadata: { limit_source: 'openrouter_free_tier_daily' } } }) } })

test('classifies the structured daily free quota without returning provider text', () => {
  expect(classifyOpenCodeV2ProbeFailure('openrouter', quota())).toBe('provider_free_quota_exhausted')
})

test('does not mistake unknown errors, other providers or ordinary 429s for the daily free quota', () => {
  for (const value of [null, 'provider_free_quota_exhausted', {}, { ...quota(), status: 403 },
    { ...quota(), type: 'provider.auth' }, { ...quota(), response: { body: 'TEST_SECRET malformed' } },
    { ...quota(), response: { body: JSON.stringify({ error: { code: 429, metadata: { limit_source: 'other_limit' } } }) } },
    { ...quota(), response: { body: 'x'.repeat(65537) } }]) {
    expect(classifyOpenCodeV2ProbeFailure('openrouter', value)).toBe('native_execution_failed')
  }
  expect(classifyOpenCodeV2ProbeFailure('other-provider', quota())).toBe('native_execution_failed')
})
