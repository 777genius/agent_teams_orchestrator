import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { types as nodeTypes } from 'node:util'

import {
  asRecord,
  isOpenCodeCanonicalModelId,
  isOpenCodeCanonicalProviderId,
  isOpenCodeOpaqueSha256,
  isOpenCodePassiveBinaryVersion,
  normalizeOpenCodePassiveModelRef,
  type OpenCodeBinaryStatus,
  type OpenCodeCatalogStatus,
  type OpenCodeConfiguredStatus,
  type OpenCodeExecutionStatus,
  type OpenCodeLastConnectedStatus,
  type OpenCodePassiveObservation,
  type OpenCodePassiveProviderStatus,
  OPEN_CODE_PASSIVE_MAX_PROVIDERS,
} from './OpenCodePassiveStatusContract.js'

export const OPEN_CODE_REDACTED_SNAPSHOT_MAX_BYTES = 65_536
export const OPEN_CODE_REDACTED_SNAPSHOT_MAX_PROVIDERS = OPEN_CODE_PASSIVE_MAX_PROVIDERS
export const OPEN_CODE_REDACTED_SNAPSHOT_MAX_MODELS = 256
export const OPEN_CODE_REDACTED_SNAPSHOT_MAX_CATALOG_MODELS = 16_384
export const OPEN_CODE_REDACTED_SNAPSHOT_MAX_JSON_DEPTH = 16
export const OPEN_CODE_REDACTED_SNAPSHOT_MAX_SCALAR_CODE_UNITS = 129

export type OpenCodeRedactedSnapshotProviderV1 = OpenCodePassiveProviderStatus & {
  fingerprint?: `sha256:${string}`
  modelIds?: string[]
  modelIdsTotal?: number
  modelIdsTruncated?: boolean
  modelIdsFingerprint?: `sha256:${string}`
}
export type OpenCodeRedactedSnapshotV1 = {
  schemaVersion: 1
  projectScope: `sha256:${string}`
  capturedAt: number
  binary: OpenCodePassiveObservation<OpenCodeBinaryStatus>
  providers: OpenCodeRedactedSnapshotProviderV1[]
}
export type OpenCodeRedactedSnapshotIssue =
  | 'snapshot_invalid_json'
  | 'snapshot_duplicate_key'
  | 'snapshot_depth_exceeded'
  | 'snapshot_oversized'
  | 'snapshot_invalid_schema'
  | 'snapshot_invalid_field'
  | 'snapshot_count_exceeded'
export type OpenCodeRedactedSnapshotDecodeResult =
  | { ok: true; value: OpenCodeRedactedSnapshotV1 }
  | { ok: false; issueCode: OpenCodeRedactedSnapshotIssue }

const authorities = ['binary_metadata', 'config_metadata', 'auth_metadata', 'catalog_snapshot', 'execution_snapshot', 'none'] as const
const freshness = ['fresh', 'stale', 'unknown'] as const
const conditions = ['normal', 'degraded'] as const
const issues = ['none', 'unknown', 'expired', 'read_timeout', 'read_cancelled', 'read_failed', 'invalid_payload', 'unsupported_version', 'scope_unavailable'] as const
const topKeys = ['schemaVersion', 'projectScope', 'capturedAt', 'binary', 'providers'] as const
const providerKeys = ['providerId', 'configured', 'lastConnected', 'catalogAvailable', 'executionVerified', 'fingerprint', 'modelIds', 'modelIdsTotal', 'modelIdsTruncated', 'modelIdsFingerprint'] as const
const observationKeys = ['value', 'authority', 'freshness', 'condition', 'observedAt', 'validUntil', 'issueCode'] as const
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype)
const typedArrayByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get!
const typedArrayTag = Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag)!.get!

export function decodeOpenCodeRedactedSnapshotV1(bytes: unknown): OpenCodeRedactedSnapshotDecodeResult {
  // A UTF-8 byte sequence is never shorter than its JS code-unit count. This
  // prevents allocating an encoded copy of obviously oversized attacker text.
  if (typeof bytes !== 'string') {
    if (bytes === null || typeof bytes !== 'object' || nodeTypes.isProxy(bytes) || !ArrayBuffer.isView(bytes)) return { ok: false, issueCode: 'snapshot_invalid_json' }
    try { if (typedArrayTag.call(bytes) !== 'Uint8Array') return { ok: false, issueCode: 'snapshot_invalid_json' } }
    catch { return { ok: false, issueCode: 'snapshot_invalid_json' } }
  }
  if (typeof bytes === 'string' && bytes.length > OPEN_CODE_REDACTED_SNAPSHOT_MAX_BYTES) return { ok: false, issueCode: 'snapshot_oversized' }
  let byteLength: number
  try { byteLength = typeof bytes === 'string' ? Buffer.byteLength(bytes, 'utf8') : typedArrayByteLength.call(bytes) as number }
  catch { return { ok: false, issueCode: 'snapshot_invalid_json' } }
  if (byteLength > OPEN_CODE_REDACTED_SNAPSHOT_MAX_BYTES) return { ok: false, issueCode: 'snapshot_oversized' }
  let text: string
  try { text = typeof bytes === 'string' ? bytes : new TextDecoder('utf-8', { fatal: true }).decode(bytes as Uint8Array) }
  catch { return { ok: false, issueCode: 'snapshot_invalid_json' } }
  const parsed = parseBoundedJson(text)
  if (parsed.ok === false) return { ok: false, issueCode: parsed.issueCode }
  const record = asRecord(parsed.value)
  if (!record || record.schemaVersion !== 1) return { ok: false, issueCode: 'snapshot_invalid_schema' }
  if (!exactKeys(record, topKeys) || !isOpenCodeOpaqueSha256(record.projectScope) || !timestamp(record.capturedAt)) return invalid()
  if (!Array.isArray(record.providers)) return invalid()
  if (record.providers.length > OPEN_CODE_REDACTED_SNAPSHOT_MAX_PROVIDERS) return countExceeded()

  const binary = decodeObservation(record.binary, decodeBinary, 'binary_metadata', isUnknownBinary, record.capturedAt)
  if (!binary) return invalid()
  const providers: OpenCodeRedactedSnapshotProviderV1[] = []
  let modelCount = 0
  for (const item of record.providers) {
    const provider = asRecord(item)
    if (!provider || !exactKeys(provider, providerKeys, true) || !isOpenCodeCanonicalProviderId(provider.providerId)) return invalid()
    const configured = decodeObservation(provider.configured, value => decodeMember(['configured', 'not_configured', 'unknown'] as const, value), 'config_metadata', value => value === 'unknown', record.capturedAt)
    const lastConnected = decodeObservation(provider.lastConnected, decodeLastConnected, 'auth_metadata', value => value.state === 'unknown', record.capturedAt)
    const catalogAvailable = decodeObservation(provider.catalogAvailable, value => decodeMember(['available', 'unavailable', 'unknown'] as const, value), 'catalog_snapshot', value => value === 'unknown', record.capturedAt)
    const executionVerified = decodeObservation(provider.executionVerified, value => decodeMember(['verified', 'rejected', 'unknown'] as const, value), 'execution_snapshot', value => value === 'unknown', record.capturedAt)
    if (!configured || !lastConnected || !catalogAvailable || !executionVerified) return invalid()
    if (lastConnected.value.state === 'connected' && (lastConnected.observedAt === null || lastConnected.value.at > lastConnected.observedAt)) return invalid()
    const decoded: OpenCodeRedactedSnapshotProviderV1 = {
      providerId: provider.providerId,
      configured: configured as OpenCodePassiveObservation<OpenCodeConfiguredStatus>,
      lastConnected: lastConnected as OpenCodePassiveObservation<OpenCodeLastConnectedStatus>,
      catalogAvailable: catalogAvailable as OpenCodePassiveObservation<OpenCodeCatalogStatus>,
      executionVerified: executionVerified as OpenCodePassiveObservation<OpenCodeExecutionStatus>,
    }
    if (provider.fingerprint !== undefined) {
      if (!isOpenCodeOpaqueSha256(provider.fingerprint)) return invalid()
      decoded.fingerprint = provider.fingerprint
    }
    if (provider.modelIds !== undefined) {
      if (!Array.isArray(provider.modelIds) || !provider.modelIds.every(isOpenCodeCanonicalModelId)) return invalid()
      if (new Set(provider.modelIds).size !== provider.modelIds.length) return invalid()
      modelCount += provider.modelIds.length
      if (modelCount > OPEN_CODE_REDACTED_SNAPSHOT_MAX_MODELS) return countExceeded()
      decoded.modelIds = [...provider.modelIds]
    }
    const metadataPresent = provider.modelIdsTotal !== undefined
      || provider.modelIdsTruncated !== undefined || provider.modelIdsFingerprint !== undefined
    if (metadataPresent) {
      if (!Number.isSafeInteger(provider.modelIdsTotal) || provider.modelIdsTotal < 0
        || typeof provider.modelIdsTruncated !== 'boolean'
        || !isOpenCodeOpaqueSha256(provider.modelIdsFingerprint)) return invalid()
      const retained = decoded.modelIds?.length ?? 0
      if (provider.modelIdsTotal < retained
        || provider.modelIdsTruncated !== (provider.modelIdsTotal > retained)) return invalid()
      if (!provider.modelIdsTruncated
        && provider.modelIdsFingerprint !== modelIdsFingerprint(decoded.modelIds ?? [])) return invalid()
      decoded.modelIdsTotal = provider.modelIdsTotal
      decoded.modelIdsTruncated = provider.modelIdsTruncated
      decoded.modelIdsFingerprint = provider.modelIdsFingerprint
    }
    providers.push(decoded)
  }
  if (new Set(providers.map(provider => provider.providerId)).size !== providers.length) return invalid()
  return { ok: true, value: freezeSnapshot({ schemaVersion: 1, projectScope: record.projectScope, capturedAt: record.capturedAt, binary, providers }) }
}

/** Encoder constructs one owned whitelist during preflight and never rereads caller state. */
export function encodeOpenCodeRedactedSnapshotV1(value: OpenCodeRedactedSnapshotV1): OpenCodeRedactedSnapshotDecodeResult & { bytes?: Uint8Array } {
  const preflight = preflightSnapshot(value)
  if (!preflight.ok) return preflight
  let text: string
  try { text = JSON.stringify(preflight.value) }
  catch { return invalid() }
  if (text.length > OPEN_CODE_REDACTED_SNAPSHOT_MAX_BYTES
    || Buffer.byteLength(text, 'utf8') > OPEN_CODE_REDACTED_SNAPSHOT_MAX_BYTES) {
    const fitted = fitStoredModelPrefix(preflight.value)
    if (!fitted) return { ok: false, issueCode: 'snapshot_oversized' }
    text = fitted.text
  }
  if (text.length > OPEN_CODE_REDACTED_SNAPSHOT_MAX_BYTES
    || Buffer.byteLength(text, 'utf8') > OPEN_CODE_REDACTED_SNAPSHOT_MAX_BYTES) {
    return { ok: false, issueCode: 'snapshot_oversized' }
  }
  const bytes = new TextEncoder().encode(text)
  const decoded = decodeOpenCodeRedactedSnapshotV1(bytes)
  return decoded.ok ? { ...decoded, bytes } : decoded
}

type PreflightResult = { ok: true; value: OpenCodeRedactedSnapshotV1 } | { ok: false; issueCode: OpenCodeRedactedSnapshotIssue }

function preflightSnapshot(value: OpenCodeRedactedSnapshotV1): PreflightResult {
  const top = captureRecord(value, topKeys)
  if (!top || top.schemaVersion !== 1 || !isOpenCodeOpaqueSha256(top.projectScope) || !timestamp(top.capturedAt)) return invalid()
  const providersInput = captureArray(top.providers, OPEN_CODE_REDACTED_SNAPSHOT_MAX_PROVIDERS)
  if (providersInput === 'count') return countExceeded()
  if (!providersInput) return invalid()
  const binaryCopy = copyObservation(top.binary, 'binary')
  const binary = binaryCopy && decodeObservation(binaryCopy, decodeBinary, 'binary_metadata', isUnknownBinary, top.capturedAt)
  if (!binary) return invalid()
  const providers: OpenCodeRedactedSnapshotProviderV1[] = []
  for (const providerInput of providersInput) {
    const provider = captureRecord(providerInput, providerKeys, 5)
    if (!provider || !isOpenCodeCanonicalProviderId(provider.providerId)) return invalid()
    const configuredCopy = copyObservation(provider.configured, 'scalar')
    const connectedCopy = copyObservation(provider.lastConnected, 'connected')
    const catalogCopy = copyObservation(provider.catalogAvailable, 'scalar')
    const executionCopy = copyObservation(provider.executionVerified, 'scalar')
    const configured = configuredCopy && decodeObservation(configuredCopy, value => decodeMember(['configured', 'not_configured', 'unknown'] as const, value), 'config_metadata', value => value === 'unknown', top.capturedAt)
    const lastConnected = connectedCopy && decodeObservation(connectedCopy, decodeLastConnected, 'auth_metadata', value => value.state === 'unknown', top.capturedAt)
    const catalogAvailable = catalogCopy && decodeObservation(catalogCopy, value => decodeMember(['available', 'unavailable', 'unknown'] as const, value), 'catalog_snapshot', value => value === 'unknown', top.capturedAt)
    const executionVerified = executionCopy && decodeObservation(executionCopy, value => decodeMember(['verified', 'rejected', 'unknown'] as const, value), 'execution_snapshot', value => value === 'unknown', top.capturedAt)
    if (!configured || !lastConnected || !catalogAvailable || !executionVerified) return invalid()
    const owned: OpenCodeRedactedSnapshotProviderV1 = { providerId: provider.providerId, configured, lastConnected, catalogAvailable, executionVerified }
    if (provider.fingerprint !== undefined) {
      if (!isOpenCodeOpaqueSha256(provider.fingerprint)) return invalid()
      owned.fingerprint = provider.fingerprint
    }
    if (provider.modelIds !== undefined) {
      const models = captureArray(provider.modelIds, OPEN_CODE_REDACTED_SNAPSHOT_MAX_CATALOG_MODELS)
      if (models === 'count') return countExceeded()
      if (!models) return invalid()
      const unique = new Set<string>()
      for (const model of models) {
        const normalized = normalizeOpenCodePassiveModelRef(model)
        if (normalized) unique.add(normalized)
      }
      const sorted = [...unique].sort(codeUnitCompare)
      owned.modelIds = sorted
      const suppliedMetadata = readModelMetadata(provider, sorted.length)
      if (suppliedMetadata && suppliedMetadata.modelIdsTruncated) Object.assign(owned, suppliedMetadata)
      else {
        owned.modelIdsTotal = sorted.length
        owned.modelIdsTruncated = false
        owned.modelIdsFingerprint = modelIdsFingerprint(sorted)
      }
    } else {
      const suppliedMetadata = readModelMetadata(provider, 0)
      if (suppliedMetadata) Object.assign(owned, suppliedMetadata)
    }
    providers.push(owned)
  }
  if (new Set(providers.map(provider => provider.providerId)).size !== providers.length) return invalid()
  providers.sort((left, right) => codeUnitCompare(left.providerId, right.providerId))
  retainModelPrefix(providers, OPEN_CODE_REDACTED_SNAPSHOT_MAX_MODELS)
  const ownedProviders = providers.map(provider => inertRecord({
    ...provider,
    ...(provider.modelIds ? { modelIds: inertArray(provider.modelIds) } : {}),
  } as unknown as Record<string, unknown>) as OpenCodeRedactedSnapshotProviderV1)
  return { ok: true, value: inertRecord({ schemaVersion: 1, projectScope: top.projectScope, capturedAt: top.capturedAt, binary, providers: inertArray(ownedProviders) }) as OpenCodeRedactedSnapshotV1 }
}

function copyObservation(value: unknown, kind: 'binary' | 'connected' | 'scalar'): Record<string, unknown> | null {
  const observation = captureRecord(value, observationKeys)
  if (!observation || !boundedScalar(observation.authority) || !boundedScalar(observation.freshness) || !boundedScalar(observation.condition) || !boundedScalar(observation.issueCode)) return null
  if (!nullableTimestamp(observation.observedAt) || !nullableTimestamp(observation.validUntil)) return null
  let ownedValue: unknown
  if (kind === 'scalar') {
    if (!boundedScalar(observation.value)) return null
    ownedValue = observation.value
  } else if (kind === 'binary') {
    const binary = captureRecord(observation.value, ['presence', 'version'])
    if (!binary || !boundedScalar(binary.presence) || (binary.version !== null && !boundedScalar(binary.version))) return null
    ownedValue = inertRecord({ presence: binary.presence, version: binary.version })
  } else {
    const connected = captureRecord(observation.value, ['state', 'at'], 1)
    if (!connected || !boundedScalar(connected.state)) return null
    if (connected.state === 'connected') {
      if (!timestamp(connected.at)) return null
      ownedValue = inertRecord({ state: connected.state, at: connected.at })
    } else ownedValue = inertRecord({ state: connected.state })
  }
  return inertRecord({ value: ownedValue, authority: observation.authority, freshness: observation.freshness, condition: observation.condition, observedAt: observation.observedAt, validUntil: observation.validUntil, issueCode: observation.issueCode })
}
function boundedScalar(value: unknown): value is string { return typeof value === 'string' && value.length <= OPEN_CODE_REDACTED_SNAPSHOT_MAX_SCALAR_CODE_UNITS }
function captureRecord(value: unknown, whitelist: readonly string[], requiredCount = whitelist.length): Record<string, any> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || nodeTypes.isProxy(value)) return null
  try {
    const prototype = Reflect.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return null
    if (Reflect.getOwnPropertyDescriptor(value, 'toJSON')) return null
    const descriptors = new Map<string, PropertyDescriptor>()
    for (const key of whitelist) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key)
      if (descriptor) {
        if (!('value' in descriptor)) return null
        descriptors.set(key, descriptor)
      }
    }
    const required = whitelist.slice(0, requiredCount)
    if (!required.every(key => descriptors.has(key))) return null
    const result: Record<string, unknown> = Object.create(null)
    for (const key of whitelist) if (descriptors.has(key)) result[key] = descriptors.get(key)!.value
    return result
  } catch { return null }
}
function captureArray(value: unknown, maximum: number): unknown[] | 'count' | null {
  if (!Array.isArray(value) || nodeTypes.isProxy(value)) return null
  try {
    if (Reflect.getPrototypeOf(value) !== Array.prototype) return null
    for (const reserved of ['toJSON', '__proto__', 'prototype', 'constructor']) {
      if (Reflect.getOwnPropertyDescriptor(value, reserved)) return null
    }
    const lengthDescriptor = Reflect.getOwnPropertyDescriptor(value, 'length')
    if (!lengthDescriptor || !('value' in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value)) return null
    const length = lengthDescriptor.value as number
    if (length < 0) return null
    if (length > maximum) return 'count'
    const result: unknown[] = []
    for (let index = 0; index < length; index += 1) {
      const key = String(index)
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !('value' in descriptor)) return null
      result.push(descriptor.value)
    }
    return result
  } catch { return null }
}

function inertRecord<T extends Record<string, unknown>>(fields: T): T {
  const result = Object.create(null) as T
  for (const key of Object.keys(fields)) Object.defineProperty(result, key, { value: fields[key], enumerable: true, configurable: false, writable: false })
  return result
}
function inertArray<T>(items: T[]): T[] {
  Object.setPrototypeOf(items, null)
  return items
}

function freezeSnapshot(snapshot: OpenCodeRedactedSnapshotV1): OpenCodeRedactedSnapshotV1 {
  const freezeObservation = (observation: OpenCodePassiveObservation<unknown>) => {
    if (observation.value !== null && typeof observation.value === 'object') Object.freeze(observation.value)
    Object.freeze(observation)
  }
  freezeObservation(snapshot.binary)
  for (const provider of snapshot.providers) {
    freezeObservation(provider.configured)
    freezeObservation(provider.lastConnected)
    freezeObservation(provider.catalogAvailable)
    freezeObservation(provider.executionVerified)
    if (provider.modelIds) Object.freeze(provider.modelIds)
    Object.freeze(provider)
  }
  Object.freeze(snapshot.providers)
  return Object.freeze(snapshot)
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function modelIdsFingerprint(modelIds: readonly string[]): `sha256:${string}` {
  return `sha256:${createHash('sha256').update('opencode-passive-model-ids-v1\0')
    .update(modelIds.join('\0')).digest('hex')}`
}

function readModelMetadata(
  provider: Record<string, unknown>,
  retained: number,
): Pick<OpenCodeRedactedSnapshotProviderV1, 'modelIdsTotal' | 'modelIdsTruncated' | 'modelIdsFingerprint'> | null {
  if (!Number.isSafeInteger(provider.modelIdsTotal)
    || (provider.modelIdsTotal as number) < retained
    || (provider.modelIdsTotal as number) > OPEN_CODE_REDACTED_SNAPSHOT_MAX_CATALOG_MODELS
    || typeof provider.modelIdsTruncated !== 'boolean'
    || provider.modelIdsTruncated !== ((provider.modelIdsTotal as number) > retained)
    || !isOpenCodeOpaqueSha256(provider.modelIdsFingerprint)) return null
  return {
    modelIdsTotal: provider.modelIdsTotal as number,
    modelIdsTruncated: provider.modelIdsTruncated,
    modelIdsFingerprint: provider.modelIdsFingerprint,
  }
}

/** Provider/model order is already code-unit sorted, making this a stable global prefix. */
function retainModelPrefix(providers: OpenCodeRedactedSnapshotProviderV1[], maximum: number): void {
  let remaining = maximum
  for (const provider of providers) {
    if (provider.modelIds === undefined) continue
    const retained = provider.modelIds.slice(0, remaining)
    remaining -= retained.length
    const total = provider.modelIdsTotal ?? provider.modelIds.length
    if (retained.length > 0 || total === 0) provider.modelIds = retained
    else delete provider.modelIds
    provider.modelIdsTotal = total
    provider.modelIdsTruncated = total > retained.length
    provider.modelIdsFingerprint ??= modelIdsFingerprint(provider.modelIds ?? [])
  }
}

function fitStoredModelPrefix(snapshot: OpenCodeRedactedSnapshotV1): { value: OpenCodeRedactedSnapshotV1; text: string } | null {
  const available = snapshot.providers.reduce((total, provider) => total + (provider.modelIds?.length ?? 0), 0)
  let low = 0
  let high = available
  let best: { value: OpenCodeRedactedSnapshotV1; text: string } | null = null
  while (low <= high) {
    const midpoint = Math.floor((low + high) / 2)
    const candidate: OpenCodeRedactedSnapshotV1 = {
      ...snapshot,
      providers: snapshot.providers.map(provider => ({
        ...provider,
        ...(provider.modelIds === undefined ? {} : { modelIds: [...provider.modelIds] }),
      })),
    }
    retainModelPrefix(candidate.providers, midpoint)
    let text: string
    try { text = JSON.stringify(candidate) } catch { return null }
    if (text.length <= OPEN_CODE_REDACTED_SNAPSHOT_MAX_BYTES
      && Buffer.byteLength(text, 'utf8') <= OPEN_CODE_REDACTED_SNAPSHOT_MAX_BYTES) {
      best = { value: candidate, text }
      low = midpoint + 1
    } else high = midpoint - 1
  }
  return best
}

/** Separate mutation boundary; the passive reader intentionally cannot receive this port. */
export interface OpenCodeRedactedSnapshotWriterPort {
  write(snapshot: OpenCodeRedactedSnapshotV1, signal: AbortSignal): Promise<void>
  withScopeLease?<T>(scope: `sha256:${string}`, signal: AbortSignal, operation: () => Promise<T>): Promise<T>
}

function decodeObservation<T>(
  value: unknown,
  decodeValue: (value: unknown) => T | null,
  requiredAuthority: Exclude<OpenCodePassiveObservation<unknown>['authority'], 'none'>,
  isUnknown: (value: T) => boolean,
  capturedAt: number,
): OpenCodePassiveObservation<T> | null {
  const record = asRecord(value)
  if (!record || !exactKeys(record, observationKeys)) return null
  const decodedValue = decodeValue(record.value)
  if (decodedValue === null || !member(authorities, record.authority) || !member(freshness, record.freshness) || !member(conditions, record.condition) || !member(issues, record.issueCode)) return null
  if (!nullableTimestamp(record.observedAt) || !nullableTimestamp(record.validUntil)) return null
  const unknown = isUnknown(decodedValue)
  if (unknown) {
    if (record.authority !== 'none' || record.freshness !== 'unknown' || record.condition !== 'degraded' || record.observedAt !== null || record.validUntil !== null || record.issueCode === 'none') return null
  } else {
    if (record.authority !== requiredAuthority || record.observedAt === null || record.validUntil === null) return null
    if (record.observedAt > capturedAt || record.validUntil < record.observedAt) return null
    if (record.freshness === 'fresh') {
      if (record.condition !== 'normal' || record.issueCode !== 'none' || record.validUntil < capturedAt) return null
    } else if (record.freshness === 'stale') {
      if (record.condition !== 'degraded' || record.issueCode === 'none') return null
    } else return null
  }
  return inertRecord({ value: decodedValue, authority: record.authority, freshness: record.freshness, condition: record.condition, observedAt: record.observedAt, validUntil: record.validUntil, issueCode: record.issueCode }) as OpenCodePassiveObservation<T>
}
function decodeBinary(value: unknown): OpenCodeBinaryStatus | null {
  const record = asRecord(value)
  if (!record || !exactKeys(record, ['presence', 'version']) || !member(['present', 'absent', 'unknown'] as const, record.presence)) return null
  if (record.version !== null && !isOpenCodePassiveBinaryVersion(record.version)) return null
  if (record.presence !== 'present' && record.version !== null) return null
  return inertRecord({ presence: record.presence, version: record.version as string | null }) as OpenCodeBinaryStatus
}
function isUnknownBinary(value: OpenCodeBinaryStatus): boolean { return value.presence === 'unknown' }
function decodeLastConnected(value: unknown): OpenCodeLastConnectedStatus | null {
  const record = asRecord(value)
  if (!record || !member(['connected', 'not_connected', 'unknown'] as const, record.state)) return null
  if (record.state === 'connected') return exactKeys(record, ['state', 'at']) && timestamp(record.at) ? inertRecord({ state: 'connected' as const, at: record.at }) : null
  return exactKeys(record, ['state']) ? inertRecord({ state: record.state }) as OpenCodeLastConnectedStatus : null
}
function exactKeys(record: Record<string, unknown>, allowed: readonly string[], optional = false): boolean {
  const keys = Object.keys(record)
  if (keys.some(key => !allowed.includes(key))) return false
  if (optional) return allowed.slice(0, 5).every(key => keys.includes(key))
  return keys.length === allowed.length && allowed.every(key => keys.includes(key))
}
function member<T extends string>(values: readonly T[], value: unknown): value is T { return typeof value === 'string' && values.includes(value as T) }
function decodeMember<T extends string>(values: readonly T[], value: unknown): T | null { return member(values, value) ? value : null }
function timestamp(value: unknown): value is number { return Number.isSafeInteger(value) && Number.isFinite(value) && (value as number) >= 0 }
function nullableTimestamp(value: unknown): value is number | null { return value === null || timestamp(value) }
function invalid(): OpenCodeRedactedSnapshotDecodeResult { return { ok: false, issueCode: 'snapshot_invalid_field' } }
function countExceeded(): OpenCodeRedactedSnapshotDecodeResult { return { ok: false, issueCode: 'snapshot_count_exceeded' } }

type JsonParseResult = { ok: true; value: unknown } | { ok: false; issueCode: 'snapshot_invalid_json' | 'snapshot_duplicate_key' | 'snapshot_depth_exceeded' | 'snapshot_invalid_field' }
function parseBoundedJson(text: string): JsonParseResult {
  let at = 0
  let failure: JsonParseResult | null = null
  const whitespace = () => { while (text[at] === ' ' || text[at] === '\t' || text[at] === '\r' || text[at] === '\n') at += 1 }
  const fail = (issueCode: Extract<JsonParseResult, { ok: false }>['issueCode']): undefined => { failure ??= { ok: false, issueCode }; return undefined }
  const stringValue = (): string | undefined => {
    if (text[at] !== '"') return fail('snapshot_invalid_json')
    const start = at++
    while (at < text.length) {
      const char = text[at++]
      if (char === '"') {
        try { return JSON.parse(text.slice(start, at)) as string } catch { return fail('snapshot_invalid_json') }
      }
      if (char === '\\') {
        const escaped = text[at++]
        if (escaped === 'u') at += 4
      } else if (char.charCodeAt(0) < 0x20) return fail('snapshot_invalid_json')
    }
    return fail('snapshot_invalid_json')
  }
  const value = (depth: number): unknown => {
    if (depth > OPEN_CODE_REDACTED_SNAPSHOT_MAX_JSON_DEPTH) return fail('snapshot_depth_exceeded')
    whitespace()
    if (text[at] === '{') {
      at += 1; whitespace()
      const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>; const keys = new Set<string>()
      if (text[at] === '}') { at += 1; return result }
      while (!failure) {
        const key = stringValue(); if (key === undefined) return undefined
        if (key === '__proto__' || key === 'prototype' || key === 'constructor') return fail('snapshot_invalid_field')
        if (keys.has(key)) return fail('snapshot_duplicate_key')
        keys.add(key); whitespace()
        if (text[at++] !== ':') return fail('snapshot_invalid_json')
        const child = value(depth + 1); if (failure) return undefined
        Object.defineProperty(result, key, { value: child, enumerable: true, configurable: false, writable: false })
        whitespace()
        if (text[at] === '}') { at += 1; return result }
        if (text[at++] !== ',') return fail('snapshot_invalid_json')
        whitespace()
      }
      return undefined
    }
    if (text[at] === '[') {
      at += 1; whitespace(); const result: unknown[] = []
      if (text[at] === ']') { at += 1; return result }
      while (!failure) {
        result.push(value(depth + 1)); if (failure) return undefined
        whitespace()
        if (text[at] === ']') { at += 1; return result }
        if (text[at++] !== ',') return fail('snapshot_invalid_json')
        whitespace()
      }
      return undefined
    }
    if (text[at] === '"') return stringValue()
    const rest = text.slice(at)
    const literal = /^(true|false|null)(?![A-Za-z0-9_])/.exec(rest)
    if (literal) { at += literal[0].length; return literal[1] === 'true' ? true : literal[1] === 'false' ? false : null }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(rest)
    if (!number) return fail('snapshot_invalid_json')
    at += number[0].length
    const parsed = Number(number[0])
    return Number.isFinite(parsed) ? parsed : fail('snapshot_invalid_json')
  }
  const parsed = value(1)
  whitespace()
  if (failure) return failure
  if (at !== text.length) return { ok: false, issueCode: 'snapshot_invalid_json' }
  return { ok: true, value: parsed }
}
