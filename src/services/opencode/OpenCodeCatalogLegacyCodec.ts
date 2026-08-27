import { types as utilTypes } from 'node:util'

const MAX_LEGACY_BYTES = 2 * 1024 * 1024
const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor'])

/**
 * Pure, filesystem-free legacy envelope boundary. Directory walking and exact
 * 44305/44306 SQLite import belong to the native authority; main may only
 * validate bytes returned by BIND_AND_READ.
 */
export function decodeOpenCodeLegacyCatalogEnvelope(encoded: unknown): unknown | null {
  if (typeof encoded !== 'string' || new TextEncoder().encode(encoded).byteLength > MAX_LEGACY_BYTES) {
    return null
  }
  try {
    const value = JSON.parse(encoded) as unknown
    return inert(value)
  } catch { return null }
}

function inert(value: unknown, depth = 0, budget = { count: 0 }): unknown {
  if (++budget.count > 20_000 || depth > 16) throw new Error('legacy envelope bounds')
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('legacy number')
    return value
  }
  if (!value || typeof value !== 'object' || utilTypes.isProxy(value)) throw new Error('legacy object')
  if (Array.isArray(value)) return Object.freeze(value.map(item => inert(item, depth + 1, budget)))
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || FORBIDDEN.has(key))) {
    throw new Error('legacy record')
  }
  const result = Object.create(null) as Record<string, unknown>
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable || !('value' in descriptor)) throw new Error('legacy descriptor')
    result[key] = inert(descriptor.value, depth + 1, budget)
  }
  return Object.freeze(result)
}
