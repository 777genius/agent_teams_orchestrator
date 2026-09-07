/** Private structural equality. Never publish a digest, key, value or mismatch
 * path. Presence is significant, including absent versus an empty environment.
 * Inputs are parsed configuration JSON, not public /mcp status projections. */
export function privateMcpConfigEquals(expected: unknown, actual: unknown): boolean {
  if (expected === actual) return true
  if (expected === null || actual === null || typeof expected !== 'object' || typeof actual !== 'object') return false
  if (Array.isArray(expected) || Array.isArray(actual)) {
    return Array.isArray(expected) && Array.isArray(actual) && expected.length === actual.length &&
      expected.every((value, index) => privateMcpConfigEquals(value, actual[index]))
  }
  const left = expected as Record<string, unknown>, right = actual as Record<string, unknown>
  const keys = Object.keys(left), other = Object.keys(right)
  return keys.length === other.length && keys.every(key => Object.hasOwn(right, key) && privateMcpConfigEquals(left[key], right[key]))
}

export function privateMcpConfigurationMatches(expectedConfig: unknown, actualConfig: unknown): boolean {
  if (!expectedConfig || !actualConfig || typeof expectedConfig !== 'object' || typeof actualConfig !== 'object' ||
    Array.isArray(expectedConfig) || Array.isArray(actualConfig)) return false
  const expected = expectedConfig as Record<string, unknown>, actual = actualConfig as Record<string, unknown>
  return Object.hasOwn(expected, 'mcp') === Object.hasOwn(actual, 'mcp') && privateMcpConfigEquals(expected.mcp, actual.mcp)
}
