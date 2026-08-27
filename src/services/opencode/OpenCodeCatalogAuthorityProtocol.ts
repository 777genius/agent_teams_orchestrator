export const OPENCODE_CATALOG_AUTHORITY_VERSION = 44307 as const
export const OPENCODE_CATALOG_MAX_ENVELOPE_BYTES = 2 * 1024 * 1024
// An envelope is nested as a JSON string on the wire, so every byte may need
// one additional escape byte. The fixed allowance covers protocol metadata.
export const OPENCODE_CATALOG_MAX_WIRE_BYTES =
  OPENCODE_CATALOG_MAX_ENVELOPE_BYTES * 2 + 262_144

export type OpenCodeCatalogAuthorityIdentity = Readonly<{
  project_path: string
  provider_id: string
  config_fingerprint: string
  auth_fingerprint: string
  binary_fingerprint: string
  cache_key: string
}>

// Relative monotonic budget captured immediately before the write. The native
// process converts it to its own absolute monotonic deadline, avoiding any
// assumption that JavaScript and Rust clocks share an epoch.
type RequestBase = Readonly<{ id: string; wait_ms: number }>

export type OpenCodeCatalogAuthorityRequest =
  | (RequestBase & Readonly<{ op: 'BEGIN_ATTEMPT'; started_at: number; scope_hash: string }>)
  | (RequestBase & Readonly<{ op: 'BIND_AND_READ'; generation: number
      attempt_identity: `sha256:${string}`; identity: OpenCodeCatalogAuthorityIdentity }>)
  | (RequestBase & Readonly<{ op: 'FINALIZE'; generation: number
      attempt_identity: `sha256:${string}`; identity: OpenCodeCatalogAuthorityIdentity
      envelope_json: string; observed_at: number; expires_at: number }>)
  | (RequestBase & Readonly<{ op: 'RESOLVE'; generation: number
      attempt_identity: `sha256:${string}`; identity: OpenCodeCatalogAuthorityIdentity }>)
  | (RequestBase & Readonly<{ op: 'CLOSE' }>)

export type OpenCodeCatalogBeginReply = Readonly<{
  generation: number
  attemptIdentity: `sha256:${string}`
}>

export type OpenCodeCatalogBindReply = Readonly<{
  previousEnvelope: string | null
  observedAt?: number
  expiresAt?: number
  catalogGeneration?: number
}>

export type OpenCodeCatalogFinalizeReply = Readonly<{
  committed: true
  generation: number
}>

export type OpenCodeCatalogResolveReply = Readonly<{
  resolved: boolean
  committed?: boolean
  generation: number
  envelopeJson?: string
}>

export type OpenCodeCatalogAuthorityReply = Readonly<{
  version: typeof OPENCODE_CATALOG_AUTHORITY_VERSION
  id: string
  ok: boolean
  value?: unknown
  error?: string
}>

export function isAuthorityIdentity(value: unknown): value is OpenCodeCatalogAuthorityIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  const keys = ['project_path', 'provider_id', 'config_fingerprint', 'auth_fingerprint',
    'binary_fingerprint', 'cache_key'] as const
  return Object.keys(record).length === keys.length
    && keys.every(key => typeof record[key] === 'string' && (record[key] as string).length > 0)
    && /^[0-9a-f]{64}$/.test(record.cache_key as string)
}

export function decodeAuthorityReply(line: string, expectedId: string): OpenCodeCatalogAuthorityReply {
  if (new TextEncoder().encode(line).byteLength > OPENCODE_CATALOG_MAX_WIRE_BYTES) {
    throw new Error('authority reply too large')
  }
  const value = JSON.parse(line) as Partial<OpenCodeCatalogAuthorityReply>
  if (!value || value.version !== OPENCODE_CATALOG_AUTHORITY_VERSION
    || value.id !== expectedId || typeof value.ok !== 'boolean'
    || (value.ok ? !Object.prototype.hasOwnProperty.call(value, 'value') : typeof value.error !== 'string')) {
    throw new Error('invalid authority reply')
  }
  return value as OpenCodeCatalogAuthorityReply
}
