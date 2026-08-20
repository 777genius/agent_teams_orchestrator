import { types as nodeTypes } from 'node:util'

import { isOpenCodeCredentialOrAuthorityLike } from './OpenCodeProviderIdentity.js'

export const OPEN_CODE_PASSIVE_STATUS_CONTRACT_VERSION = 1 as const
export const OPEN_CODE_PASSIVE_CAPABILITY_VERSION = 1 as const
/** Shared request, directory and stored-snapshot provider capacity. */
export const OPEN_CODE_PASSIVE_MAX_PROVIDERS = 64 as const
/** Exact provider/model refs retained by passive evidence are ASCII and bounded. */
export const OPEN_CODE_PASSIVE_MODEL_REF_MAX_CODE_UNITS = 256 as const
export const OPEN_CODE_PASSIVE_MODEL_REF_MAX_SEGMENTS = 8 as const
export const OPEN_CODE_PASSIVE_MODEL_REF_MAX_SEGMENT_CODE_UNITS = 128 as const

export type OpenCodePassiveFreshness = 'fresh' | 'stale' | 'unknown'
export type OpenCodePassiveCondition = 'normal' | 'degraded'
export type OpenCodePassiveAuthority =
  | 'binary_metadata'
  | 'config_metadata'
  | 'auth_metadata'
  | 'catalog_snapshot'
  | 'execution_snapshot'
  | 'none'
export type OpenCodePassiveIssueCode =
  | 'none'
  | 'unknown'
  | 'expired'
  | 'read_timeout'
  | 'read_cancelled'
  | 'read_failed'
  | 'invalid_payload'
  | 'unsupported_version'
  | 'scope_unavailable'
  | 'unsupported_safe_persistence'

export type OpenCodePassiveObservation<T> = {
  value: T
  authority: OpenCodePassiveAuthority
  freshness: OpenCodePassiveFreshness
  condition: OpenCodePassiveCondition
  observedAt: number | null
  validUntil: number | null
  issueCode: OpenCodePassiveIssueCode
}

export type OpenCodeBinaryStatus = {
  presence: 'present' | 'absent' | 'unknown'
  version: string | null
}
export type OpenCodeConfiguredStatus = 'configured' | 'not_configured' | 'unknown'
export type OpenCodeLastConnectedStatus = { state: 'connected'; at: number } | { state: 'not_connected' | 'unknown' }
export type OpenCodeCatalogStatus = 'available' | 'unavailable' | 'unknown'
export type OpenCodeExecutionStatus = 'verified' | 'rejected' | 'unknown'
export type OpenCodePassiveProviderStatus = {
  providerId: string
  configured: OpenCodePassiveObservation<OpenCodeConfiguredStatus>
  lastConnected: OpenCodePassiveObservation<OpenCodeLastConnectedStatus>
  catalogAvailable: OpenCodePassiveObservation<OpenCodeCatalogStatus>
  executionVerified: OpenCodePassiveObservation<OpenCodeExecutionStatus>
  /** Redacted, bounded catalog projection. Absent means no searchable evidence. */
  knownModelIds?: readonly string[]
  knownModelIdsTotal?: number
  knownModelIdsTruncated?: boolean
}
export type OpenCodePassiveStatusV1 = {
  contractVersion: 1
  projectScope: `sha256:${string}` | null
  binary: OpenCodePassiveObservation<OpenCodeBinaryStatus>
  providers: OpenCodePassiveProviderStatus[]
  authorization: 'unknown'
  launchReadiness: 'not_authorized'
  completedAt: number
}

export type OpenCodePassiveCapabilityVersions = {
  passiveStatusContract: number
  redactedSnapshot: number
}

const capabilityRecords = new WeakSet<object>()

/** Trusted registry boundary: callers pass only primitive version claims and the core owns the inert record. */
export function createOpenCodePassiveCapabilityVersions(
  passiveStatusContract: unknown,
  redactedSnapshot: unknown,
): OpenCodePassiveCapabilityVersions {
  const record = Object.freeze({
    passiveStatusContract: decodeVersion(passiveStatusContract),
    redactedSnapshot: decodeVersion(redactedSnapshot),
  })
  capabilityRecords.add(record)
  return record
}

/** Fail-closed additive decoder. Legacy booleans/arrays are deliberately ignored. */
export function decodeOpenCodePassiveCapabilityVersions(value: unknown): OpenCodePassiveCapabilityVersions {
  if (value === null || typeof value !== 'object' || !capabilityRecords.has(value)) return { passiveStatusContract: 0, redactedSnapshot: 0 }
  try {
    const passive = Reflect.getOwnPropertyDescriptor(value, 'passiveStatusContract')
    const snapshot = Reflect.getOwnPropertyDescriptor(value, 'redactedSnapshot')
    if (!passive || !snapshot || !('value' in passive) || !('value' in snapshot)) return { passiveStatusContract: 0, redactedSnapshot: 0 }
    return { passiveStatusContract: decodeVersion(passive.value), redactedSnapshot: decodeVersion(snapshot.value) }
  } catch { return { passiveStatusContract: 0, redactedSnapshot: 0 } }
}

function decodeVersion(value: unknown): number {
  return Number.isSafeInteger(value) && value === OPEN_CODE_PASSIVE_CAPABILITY_VERSION ? value : 0
}

export function isOpenCodeCanonicalProviderId(value: unknown): value is string {
  return isOpenCodeOpaqueSha256(value) || (typeof value === 'string' && trustedProviderIds.has(value) && canonicalIdentifierPart(value))
}

export function isOpenCodeCanonicalModelId(value: unknown): value is string {
  return normalizeOpenCodePassiveModelRef(value) !== null
}

/**
 * Shared redaction boundary for searchable exact launch refs. It validates but
 * never case-folds: passive search owns any display-only normalization.
 * Model segments allow ASCII alphanumerics separated by `.`, `_`, `:`, `+`,
 * `@`, or `-`; `/` separates bounded provider/model namespace segments.
 * Malformed catalog entries return null so publishers/encoders can omit that
 * entry without discarding unrelated, already-redacted status evidence.
 */
export function normalizeOpenCodePassiveModelRef(value: unknown): string | null {
  if (typeof value !== 'string'
    || value.length === 0
    || value.length > OPEN_CODE_PASSIVE_MODEL_REF_MAX_CODE_UNITS
    || value !== value.trim()
    || /[^\x21-\x7e]/.test(value)
    || /[\\?#=%&]/.test(value)) return null
  const parts = value.split('/')
  if (parts.length < 2 || parts.length > OPEN_CODE_PASSIVE_MODEL_REF_MAX_SEGMENTS
    || !isOpenCodeCanonicalProviderId(parts[0])) return null
  // Bedrock inference-profile/model identifiers legitimately end in `:0`.
  // Authority detection is applied to the model portion with that one
  // provider-aware exception, never to the enclosing exact ref as a URL.
  if (isOpenCodeCredentialOrAuthorityLike(parts.slice(1).join('/'), {
    allowHostPort: parts[0] === 'amazon-bedrock' && /(?:^|[-.])v\d+:\d+$/.test(parts.at(-1)!),
  })) return null
  for (const part of parts.slice(1)) {
    if (parts[0] === 'amazon-bedrock'
      && /(?:^|[-.])v\d+:\d+$/.test(part)
      && /^[A-Za-z0-9]+(?:[._+-][A-Za-z0-9]+)*:[0-9]+$/.test(part)) continue
    if (!safeModelRefSegment(part)) return null
  }
  return value
}

// Raw provider names are accepted only from this reviewed registry. Custom
// registry entries cross the boundary as sha256:<digest>, never as raw text.
const trustedProviderIds = new Set([
  'amazon-bedrock', 'anthropic', 'azure', 'cerebras', 'cloudflare-ai-gateway',
  'cohere', 'cursor', 'cursor-acp', 'deepinfra', 'fireworks-ai', 'github-copilot',
  'google', 'groq', 'kiro', 'llama.cpp', 'llmgateway', 'lmstudio', 'mistral',
  'ollama', 'openai', 'opencode', 'openrouter', 'perplexity', 'togetherai',
  'venice', 'vertexai', 'xai',
  'xiaomi-token-plan-ams', 'xiaomi-token-plan-sgp', 'xiaomi-token-plan-cn',
  'minimax-coding-plan', 'zai-coding-plan', 'kimi-for-coding',
])

const identifierSeparators = /[./_+:-]+/
const sensitiveIdentifierPart = /(?:^|[./_+:-])(api(?:[-_]?key)?|authorization|auth(?:entication)?|bearer|credential|ghp|passwd|password|private[-_]?key|rk[-_]?live|secret|session|sk|token|xoxb)(?:$|[./_+:-])/i
const credentialPrefix = /^(?:ghp|rk(?:live)?|sk|xoxb)[a-z0-9]/i
const concatenatedSensitiveTerm = /(?:api(?:key)?|authorization|authentication|auth|bearer|credential|ghp|passwd|password|privatekey|rklive|secret|session|sk|token|xoxb)([a-z0-9]+)/ig
const explicitlySafeIdentifiers = new Set([
  'anthropic',
  // Reviewed provider ids whose official product name contains "token"; only
  // these exact allowlisted identifiers bypass the generic credential-word
  // rejection below.
  'xiaomi-token-plan-ams', 'xiaomi-token-plan-sgp', 'xiaomi-token-plan-cn',
])
const pathLikeModelSegments = new Set([
  '.', '..', 'etc', 'home', 'passwd', 'root', 'tmp', 'usr', 'var', 'users',
])
function safeModelRefSegment(value: string): boolean {
  if (value.length === 0 || value.length > OPEN_CODE_PASSIVE_MODEL_REF_MAX_SEGMENT_CODE_UNITS) return false
  if (!/^[A-Za-z0-9]+(?:[._:+@-][A-Za-z0-9]+)*$/.test(value)) return false
  if (pathLikeModelSegments.has(value.toLowerCase()) || containsSensitiveComponent(value)) return false
  const components = value.split(identifierSeparators)
  return !looksLikeCredential(value.replace(/[._+:@-]/g, ''), false)
    && components.every(component => !looksLikeCredential(component))
}
function canonicalIdentifierPart(value: string): boolean {
  if (value.length === 0 || value.length > 64) return false
  return /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(value)
    && !containsSensitiveComponent(value)
    && !looksLikeCredential(value.replace(/[._-]/g, ''), false)
    && value.split(identifierSeparators).every(component => !looksLikeCredential(component))
}

function containsSensitiveComponent(value: string): boolean {
  if (explicitlySafeIdentifiers.has(value.toLowerCase())) return false
  if (sensitiveIdentifierPart.test(value) || value.split(identifierSeparators).some(component => credentialPrefix.test(component))) return true
  concatenatedSensitiveTerm.lastIndex = 0
  if (concatenatedSensitiveTerm.test(value.replace(/[-_]/g, ''))) return true
  return false
}

function looksLikeCredential(value: string, detectLowercaseScalar = true): boolean {
  // Canonical registry words are deliberately bounded. Long uninterrupted
  // custom identifiers must cross the registry boundary as an opaque SHA-256.
  if (value.length >= 24 && /^[a-z0-9]+$/i.test(value)) return true
  // Lowercase bearer material is common and defeats character-class checks.
  // Reject sufficiently long, unique/entropy-dense uninterrupted scalars while
  // retaining ordinary registry words and segmented model/SemVer components.
  if (detectLowercaseScalar && value.length >= 16 && /^[a-z]+$/.test(value)) {
    const frequencies = new Map<string, number>()
    for (const character of value) frequencies.set(character, (frequencies.get(character) ?? 0) + 1)
    let entropyPerCharacter = 0
    for (const count of frequencies.values()) {
      const probability = count / value.length
      entropyPerCharacter -= probability * Math.log2(probability)
    }
    const totalEntropy = entropyPerCharacter * value.length
    const uniqueness = frequencies.size / value.length
    if (frequencies.size >= 12 && uniqueness >= 0.7 && entropyPerCharacter >= 3.5 && totalEntropy >= 56) return true
  }
  if (value.length < 16 || !/^[a-z0-9]+$/i.test(value)) return false
  const classes = Number(/[a-z]/.test(value)) + Number(/[A-Z]/.test(value)) + Number(/\d/.test(value))
  return classes >= 2 && new Set(value.toLowerCase()).size >= 10
}

export function isOpenCodeOpaqueSha256(value: unknown): value is `sha256:${string}` {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value)
}

export function isOpenCodePassiveBinaryVersion(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) return false
  if (/[/\\\u0000-\u001f\u007f]/.test(value) || containsSensitiveComponent(value)) return false
  if (value.split(/[.+-]/).some(component => looksLikeCredential(component))) return false
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value)
  if (!match || match.slice(1, 4).some(segment => segment.length > 16)) return false
  const prerelease = match[4]
  if (prerelease && (looksLikeCredential(prerelease.replace(/[.-]/g, '')) || prerelease.split('.').some(component => (/^\d+$/.test(component) && component.length > 1 && component.startsWith('0')) || containsSensitiveComponent(component)))) return false
  const build = match[5]
  return !build || (!looksLikeCredential(build.replace(/[.-]/g, '')) && build.split('.').every(component => !containsSensitiveComponent(component)))
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || nodeTypes.isProxy(value)) return null
  try {
    const prototype = Reflect.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null ? value as Record<string, unknown> : null
  } catch { return null }
}

function ownDataValue(record: Record<string, unknown> | null, key: string): unknown {
  if (!record) return undefined
  const descriptor = Object.getOwnPropertyDescriptor(record, key)
  return descriptor && 'value' in descriptor ? descriptor.value : undefined
}
