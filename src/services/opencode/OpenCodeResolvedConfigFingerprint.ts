import { createHash } from 'node:crypto'

function normalizeResolvedFingerprintValue(
  value: unknown,
  scope: 'config' | 'configProviders' | 'agents' | 'mcp',
): unknown {
  if (scope === 'mcp') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return value
    }
    return Object.keys(value as Record<string, unknown>).sort()
  }

  if (Array.isArray(value)) {
    const normalized = value.map(item => normalizeResolvedFingerprintValue(item, scope))
    if (scope === 'configProviders' || scope === 'agents') {
      return normalized.sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right)),
      )
    }
    return normalized
  }

  if (!value || typeof value !== 'object') {
    return value
  }

  const record = value as Record<string, unknown>
  return Object.keys(record)
    .sort()
    .reduce<Record<string, unknown>>((acc, key) => {
      // Host transport details like loopback port and inherited environment
      // are expected to drift across host restarts and must not stale sessions.
      if (key === 'environment' || key === 'server') {
        return acc
      }
      acc[key] = normalizeResolvedFingerprintValue(record[key], scope)
      return acc
    }, {})
}

export type OpenCodeResolvedConfigObservations = Readonly<Record<'config' | 'configProviders' | 'agents' | 'mcp',
  Readonly<{ status: number; data: unknown }>>>

/** Same normalization for supervisor observations and Owner's independent reads.
 * This intentionally lossy identity never substitutes for private profile custody. */
export function buildResolvedConfigFingerprint(observations: OpenCodeResolvedConfigObservations,
  requireComplete = true): string | null {
  const { config, configProviders, agents, mcp } = observations
  if (requireComplete && (
    !config.data || typeof config.data !== 'object' || Array.isArray(config.data) ||
    !configProviders.data || typeof configProviders.data !== 'object' || Array.isArray(configProviders.data) ||
    !Array.isArray(agents.data) || !mcp.data || typeof mcp.data !== 'object' || Array.isArray(mcp.data)
  )) return null
  const source = {
    config: config.status === 200 ? normalizeResolvedFingerprintValue(config.data, 'config') : null,
    configProviders: configProviders.status === 200 ? normalizeResolvedFingerprintValue(configProviders.data, 'configProviders') : null,
    agents: agents.status === 200 ? normalizeResolvedFingerprintValue(agents.data, 'agents') : null,
    mcp: mcp.status === 200 ? normalizeResolvedFingerprintValue(mcp.data, 'mcp') : null,
  }
  const values = Object.values(source)
  if (requireComplete && values.some(value => value === null || value === undefined)) return null
  if (values.every(value => value === null)) return null
  return createHash('sha256').update(JSON.stringify(source)).digest('hex')
}
