import { beforeEach, describe, expect, test } from 'bun:test'

import {
  __resetAnthropicSubscriptionRateLimitRefreshForTests,
  buildAnthropicSubscriptionRateLimitSnapshot,
  getAnthropicSubscriptionRateLimitSnapshotForRuntimeStatus,
} from './anthropicSubscriptionRateLimits.js'
import { isAnthropicSubscriptionAuthMethod } from './anthropicStatus.js'
import type { RawUtilization } from '../claudeAiLimits.js'

describe('anthropic subscription rate limits', () => {
  beforeEach(() => {
    __resetAnthropicSubscriptionRateLimitRefreshForTests()
  })

  test('recognizes only subscription auth methods', () => {
    expect(isAnthropicSubscriptionAuthMethod('claude.ai')).toBe(true)
    expect(isAnthropicSubscriptionAuthMethod('oauth_token')).toBe(true)
    expect(isAnthropicSubscriptionAuthMethod('api_key')).toBe(false)
    expect(isAnthropicSubscriptionAuthMethod('api_key_helper')).toBe(false)
    expect(isAnthropicSubscriptionAuthMethod(null)).toBe(false)
  })

  test('maps raw 5-hour and weekly utilization into dashboard windows', () => {
    expect(
      buildAnthropicSubscriptionRateLimitSnapshot({
        five_hour: { utilization: 0.3784, resets_at: 1_777_777_000 },
        seven_day: { utilization: 0.9, resets_at: 1_777_999_000 },
      }),
    ).toEqual({
      primary: {
        usedPercent: 37.8,
        windowDurationMins: 300,
        resetsAt: 1_777_777_000,
      },
      secondary: {
        usedPercent: 90,
        windowDurationMins: 10_080,
        resetsAt: 1_777_999_000,
      },
    })
  })

  test('drops malformed windows without failing the snapshot', () => {
    expect(
      buildAnthropicSubscriptionRateLimitSnapshot({
        five_hour: { utilization: Number.NaN, resets_at: 1_777_777_000 },
        seven_day: { utilization: 1.25, resets_at: Number.NaN },
      }),
    ).toEqual({
      primary: null,
      secondary: {
        usedPercent: 100,
        windowDurationMins: 10_080,
        resetsAt: null,
      },
    })

    expect(buildAnthropicSubscriptionRateLimitSnapshot({})).toBeNull()
  })

  test('refreshes runtime status quota checks at most once per TTL', async () => {
    let refreshCalls = 0
    const raw: RawUtilization = {
      five_hour: { utilization: 0.42, resets_at: 1_777_777_000 },
    }
    const options = {
      authMethod: 'claude.ai',
      maxAgeMs: 60_000,
      refresh: async () => {
        refreshCalls += 1
      },
      getRawUtilizationSnapshot: () => raw,
    }

    await getAnthropicSubscriptionRateLimitSnapshotForRuntimeStatus({
      ...options,
      nowMs: 1_000,
    })
    await getAnthropicSubscriptionRateLimitSnapshotForRuntimeStatus({
      ...options,
      nowMs: 30_000,
    })
    await getAnthropicSubscriptionRateLimitSnapshotForRuntimeStatus({
      ...options,
      nowMs: 61_000,
    })

    expect(refreshCalls).toBe(2)
  })

  test('does not refresh or return limits for API key auth', async () => {
    let refreshCalls = 0
    const snapshot = await getAnthropicSubscriptionRateLimitSnapshotForRuntimeStatus({
      authMethod: 'api_key',
      refresh: async () => {
        refreshCalls += 1
      },
      getRawUtilizationSnapshot: () => ({
        five_hour: { utilization: 0.42, resets_at: 1_777_777_000 },
      }),
    })

    expect(snapshot).toBeNull()
    expect(refreshCalls).toBe(0)
  })
})
