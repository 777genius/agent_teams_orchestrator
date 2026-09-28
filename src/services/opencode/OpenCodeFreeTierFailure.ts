export const OPEN_CODE_FREE_TIER_RESTRICTED_FAILURE_CODE = 'free_tier_restricted' as const

export type OpenCodeFreeTierRestrictedFailureCode = typeof OPEN_CODE_FREE_TIER_RESTRICTED_FAILURE_CODE

export const OPEN_CODE_FREE_TIER_RESTRICTED_REASON =
  'OpenCode rejected this free-tier request (HTTP 403). OpenCode free models are currently restricted; choose a paid model or another provider.'

const NESTED_ERROR_KEYS = ['error', 'data', 'cause', 'responseBody', 'body', 'response'] as const

// Zen puts {"error":{"type":"FreeTierError"}} in the 403 response body; this is not an auth failure.
export function isOpenCodeFreeTierRestrictedError(value: unknown, depth = 0): boolean {
  if (depth > 8 || value === null || value === undefined) return false
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed.startsWith('{')) return false
    try {
      return isOpenCodeFreeTierRestrictedError(JSON.parse(trimmed), depth + 1)
    } catch {
      return false
    }
  }
  if (typeof value !== 'object') return false
  if (Array.isArray(value)) {
    return value.some(item => isOpenCodeFreeTierRestrictedError(item, depth + 1))
  }
  const record = value as Record<string, unknown>
  if (record.type === 'FreeTierError' || record.name === 'FreeTierError') return true
  return NESTED_ERROR_KEYS.some(key => isOpenCodeFreeTierRestrictedError(record[key], depth + 1))
}
