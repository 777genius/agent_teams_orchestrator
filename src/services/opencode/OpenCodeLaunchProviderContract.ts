type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
type JsonObject = { [key: string]: JsonValue }
type RecordValue = Record<string, unknown>

const invalid = (): never => { throw new TypeError('Invalid OpenCode launch provider contract') }
const own = (value: object, key: string): boolean => Object.hasOwn(value, key)

function record(value: unknown): RecordValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalid()
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return invalid()
  return value as RecordValue
}

// Define own data properties so imported IDs and SDK keys such as __proto__ stay data.
function put(target: JsonObject, key: string, value: JsonValue): void {
  Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true })
}

function read(source: RecordValue, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(source, key)
  if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return invalid()
  return descriptor.value
}

function clone(value: unknown, ancestors = new Set<object>()): JsonValue {
  if (value === null) return null
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : invalid()
  if (typeof value !== 'object' || ancestors.has(value)) return invalid()
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      if (Object.keys(value).length !== value.length) return invalid()
      return Array.from({ length: value.length }, (_, index) => clone(read(value as unknown as RecordValue, String(index)), ancestors))
    }
    const source = record(value)
    if (Object.getOwnPropertySymbols(source).length) return invalid()
    const result: JsonObject = {}
    for (const key of Object.keys(source)) put(result, key, clone(read(source, key), ancestors))
    return result
  } finally {
    ancestors.delete(value)
  }
}

type Shape = 'string' | 'boolean' | 'strings' | 'object' | 'interleaved'
function validate(value: unknown, shape: Shape): void {
  if (shape === 'string' || shape === 'boolean') {
    if (typeof value !== shape) invalid()
  } else if (shape === 'strings') {
    if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) invalid()
  } else if (shape !== 'interleaved' || (typeof value !== 'boolean' && typeof value !== 'string')) {
    record(value)
  }
}

function fields(source: RecordValue, definitions: Readonly<Record<string, Shape>>): JsonObject {
  const result: JsonObject = {}
  for (const [key, shape] of Object.entries(definitions)) {
    if (!own(source, key)) continue
    const value = read(source, key)
    validate(value, shape)
    put(result, key, clone(value))
  }
  return result
}

const providerFields = {
  api: 'string', npm: 'string', env: 'strings', id: 'string',
  whitelist: 'strings', blacklist: 'strings', options: 'object',
} as const
const modelFields = {
  id: 'string', options: 'object', headers: 'object', variants: 'object',
  limit: 'object', family: 'string', release_date: 'string', status: 'string',
  attachment: 'boolean', reasoning: 'boolean', temperature: 'boolean', tool_call: 'boolean',
  interleaved: 'interleaved', modalities: 'object', cost: 'object',
} as const

function numericDescriptor(data: RecordValue, required: string[], optional: string[]): void {
  for (const key of required) if (!own(data, key)) invalid()
  for (const key of [...required, ...optional]) {
    if (own(data, key) && (typeof data[key] !== 'number' || !Number.isFinite(data[key]))) invalid()
  }
}

function modelContract(value: unknown): JsonObject {
  const source = record(value)
  const result = fields(source, modelFields)
  // Shapes are the supported union of ConfigProviderV1.Model at the two pinned
  // conformance versions (1.18.4 / 1.18.29); extensions remain in the projection.
  if (own(result, 'limit')) {
    numericDescriptor(result.limit as JsonObject, ['context', 'output'], ['input'])
  }
  if (own(result, 'cost')) {
    const data = result.cost as JsonObject
    numericDescriptor(data, ['input', 'output'], ['cache_read', 'cache_write'])
    if (own(data, 'context_over_200k')) {
      numericDescriptor(record(data.context_over_200k), ['input', 'output'], ['cache_read', 'cache_write'])
    }
  }
  if (own(result, 'modalities')) {
    const data = result.modalities as JsonObject
    for (const key of ['input', 'output']) {
      if (!own(data, key)) continue
      validate(data[key], 'strings')
      if (!(data[key] as string[]).every(value => ['text', 'audio', 'image', 'video', 'pdf'].includes(value))) invalid()
    }
  }
  if (own(result, 'status') && !['alpha', 'beta', 'deprecated', 'active'].includes(result.status as string)) invalid()
  if (own(result, 'interleaved') && typeof result.interleaved === 'object') {
    const data = result.interleaved as JsonObject
    if (!own(data, 'field')) invalid()
    validate(data.field, 'string')
  }
  if (own(source, 'provider')) {
    put(result, 'provider', fields(record(read(source, 'provider')), { api: 'string', npm: 'string' }))
  }
  return result
}

/** A detached selected-provider snapshot; compare with isDeepStrictEqual, never identity fingerprints.
 * Unknown provider/model root metadata is deliberately outside this supported runtime contract.
 * Environment expansion is the caller's expected-only responsibility.
 */
export function buildOpenCodeLaunchProviderContract(config: unknown, providerId: string): JsonObject {
  try {
    if (typeof providerId !== 'string' || !providerId) return invalid()
    const root = record(config)
    if (!own(root, 'provider')) return { providerId, present: false }
    const providers = record(read(root, 'provider'))
    if (!own(providers, providerId)) return { providerId, present: false }
    const provider = record(read(providers, providerId))
    const result = fields(provider, providerFields)
    if (own(provider, 'models')) {
      const models = record(read(provider, 'models'))
      const projected: JsonObject = {}
      for (const key of Object.keys(models)) put(projected, key, modelContract(read(models, key)))
      put(result, 'models', projected)
    }
    return { providerId, present: true, provider: result }
  } catch {
    // Never propagate getters/proxies or source values into caller diagnostics.
    return invalid()
  }
}
