import { createHash } from 'node:crypto'
function normalizeManagedConfigForFingerprint(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(item => normalizeManagedConfigForFingerprint(item))
  }
  if (!value || typeof value !== 'object') {
    return value
  }

  const record = value as Record<string, unknown>
  return Object.keys(record).sort().reduce<Record<string, unknown>>((acc, key) => {
    // Environment values like PATH, TMPDIR, and control URLs are runtime
    // transport detail, not capability identity for production proof.
    if (key === 'environment' || (key === 'url' && record.type === 'remote')) {
      return acc
    }
    acc[key] = normalizeManagedConfigForFingerprint(record[key])
    return acc
  }, {})
}

export function buildManagedConfigFingerprint(managedConfig: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(normalizeManagedConfigForFingerprint(managedConfig))).digest('hex')
}
