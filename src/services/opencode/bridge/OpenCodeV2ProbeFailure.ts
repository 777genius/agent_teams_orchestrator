import type { RunProbeFailure } from './OpenCodeV2RunTypes.js'

/** Return only a closed classification; provider messages and bodies stay private. */
export function classifyOpenCodeV2ProbeFailure(providerID: string, value: unknown): RunProbeFailure {
  if (providerID !== 'openrouter' || !value || typeof value !== 'object') return 'native_execution_failed'
  const error = value as Record<string, unknown>
  if (error.type !== 'provider.rate-limit' || error.status !== 429) return 'native_execution_failed'
  const response = error.response as { body?: unknown } | undefined
  if (typeof response?.body !== 'string' || response.body.length > 64 * 1024) return 'native_execution_failed'
  try {
    const body = JSON.parse(response.body)
    if (body?.error?.code === 429 && body.error.metadata?.limit_source === 'openrouter_free_tier_daily')
      return 'provider_free_quota_exhausted'
  } catch { /* Unknown errors keep the generic classification. */ }
  return 'native_execution_failed'
}
