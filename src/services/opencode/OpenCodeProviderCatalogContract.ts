import { createHash } from 'node:crypto'
import { types as nodeUtilTypes } from 'node:util'

import {
  createOpenCodeCanonicalModelId,
  createOpenCodeCanonicalProviderId,
  isOpenCodeCredentialOrAuthorityLike,
} from './OpenCodeProviderIdentity.js'

import type {
  OpenCodeCanonicalModelId,
  OpenCodeCanonicalProviderId,
} from './OpenCodeProviderIdentity.js'

export const OPEN_CODE_PROVIDER_CATALOG_SOURCES = [
  'live',
  'bounded-cache',
  'configured',
  'unknown',
] as const

export type OpenCodeProviderCatalogSource = typeof OPEN_CODE_PROVIDER_CATALOG_SOURCES[number]
export type OpenCodeEndpointLocation = 'none' | 'loopback' | 'remote'
export type OpenCodeEndpointProtocol = 'http' | 'https' | null

export type OpenCodeEndpointObservation = Readonly<{
  location: OpenCodeEndpointLocation
  protocol: OpenCodeEndpointProtocol
  /** SHA-256 of URL authority only. It is null when there is no valid HTTP(S) endpoint. */
  authorityFingerprint: string | null
}>

export type OpenCodeCatalogModelLimits = Readonly<{
  context: number | null
  input: number | null
  output: number | null
}>

export type OpenCodeCatalogModelCapabilities = Readonly<{
  attachment: boolean | null
  reasoning: boolean | null
  tools: boolean | null
}>

export type OpenCodeCatalogModelBilling = 'free' | 'paid' | 'unknown'
export type OpenCodeCatalogModelStatus = 'active' | 'alpha' | 'beta' | 'deprecated' | 'unknown'

export type OpenCodeSafeCatalogModel = Readonly<{
  id: OpenCodeCanonicalModelId
  displayName: string | null
  limits: OpenCodeCatalogModelLimits
  status: OpenCodeCatalogModelStatus
  billing: OpenCodeCatalogModelBilling
  capabilities: OpenCodeCatalogModelCapabilities
}>

export type OpenCodeCatalogFreshness = Readonly<{
  state: 'fresh' | 'bounded-stale'
  observedAtMs: number
  ageMs: number
  maxStaleMs: number
}>

export type OpenCodeScopedProviderCatalog = Readonly<{
  schema: 'opencode-scoped-provider-catalog-v1'
  providerId: OpenCodeCanonicalProviderId
  source: OpenCodeProviderCatalogSource
  endpoint: OpenCodeEndpointObservation
  generation: number
  recordId: `sha256:${string}`
  freshness: OpenCodeCatalogFreshness
  connected: boolean | null
  models: readonly OpenCodeSafeCatalogModel[]
  selectionAllowed: true
  launchAuthorization: 'forbidden'
}>

export type OpenCodeCatalogRecordIdentityPayload = Readonly<{
  providerId: OpenCodeCanonicalProviderId
  source: OpenCodeProviderCatalogSource
  endpoint: OpenCodeEndpointObservation
  generation: number
  freshness: OpenCodeCatalogFreshness
  connected: boolean | null
  models: readonly OpenCodeSafeCatalogModel[]
}>

export function normalizeOpenCodeProviderCatalogSource(value: unknown): OpenCodeProviderCatalogSource {
  return typeof value === 'string'
    && (OPEN_CODE_PROVIDER_CATALOG_SOURCES as readonly string[]).includes(value)
    ? value as OpenCodeProviderCatalogSource
    : 'unknown'
}

function isLoopbackHostname(hostname: string): boolean {
  const value = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (value === 'localhost' || value === '::1') return true
  const match = /^(\d{1,3})(?:\.\d{1,3}){3}$/.exec(value)
  return Boolean(match && Number(match[1]) === 127)
}

/** Reduces an endpoint immediately to non-reversible, non-routing metadata. */
export function observeOpenCodeEndpoint(value: unknown): OpenCodeEndpointObservation {
  if (typeof value !== 'string' || value.length === 0) {
    return Object.freeze({ location: 'none', protocol: null, authorityFingerprint: null })
  }
  try {
    const parsed = new URL(value)
    const protocol = parsed.protocol === 'http:'
      ? 'http'
      : parsed.protocol === 'https:'
        ? 'https'
        : null
    if (!protocol || !parsed.hostname || !parsed.host) {
      return Object.freeze({ location: 'none', protocol: null, authorityFingerprint: null })
    }
    const authorityFingerprint = createHash('sha256')
      .update(parsed.host.toLowerCase())
      .digest('hex')
    return Object.freeze({
      location: isLoopbackHostname(parsed.hostname) ? 'loopback' : 'remote',
      protocol,
      authorityFingerprint,
    })
  } catch {
    return Object.freeze({ location: 'none', protocol: null, authorityFingerprint: null })
  }
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

const CATALOG_NUMBER_MAX = 10_000_000_000
const CATALOG_IDENTITY_MAX_MODELS = 2_048
const CATALOG_IDENTITY_ERROR = 'Invalid OpenCode catalog record identity payload'
const DANGEROUS_CATALOG_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

function inertCatalogRecord(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[] = allowed,
): Readonly<Record<string, unknown>> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || nodeUtilTypes.isProxy(value)) return null
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return null
  const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<PropertyKey, PropertyDescriptor>
  if (Reflect.ownKeys(descriptors).some(key => typeof key === 'symbol')) return null
  const allowedKeys = new Set(allowed)
  const snapshot = Object.create(null) as Record<string, unknown>
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (DANGEROUS_CATALOG_KEYS.has(key) || !allowedKeys.has(key)
      || !descriptor.enumerable || !('value' in descriptor)) return null
    snapshot[key] = descriptor.value
  }
  if (required.some(key => !Object.prototype.hasOwnProperty.call(snapshot, key))) return null
  return Object.freeze(snapshot)
}

function inertCatalogArray(value: unknown, maxLength: number): readonly unknown[] | null {
  if (!Array.isArray(value) || nodeUtilTypes.isProxy(value)
    || Object.getPrototypeOf(value) !== Array.prototype) return null
  const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<PropertyKey, PropertyDescriptor>
  if (Reflect.ownKeys(descriptors).some(key => typeof key === 'symbol')) return null
  const lengthDescriptor = descriptors.length
  if (!lengthDescriptor || !('value' in lengthDescriptor)
    || typeof lengthDescriptor.value !== 'number'
    || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0
    || lengthDescriptor.value > maxLength) return null
  const length = lengthDescriptor.value
  const snapshot = new Array<unknown>(length)
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (key === 'length') continue
    if (!/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= length
      || !descriptor.enumerable || !('value' in descriptor)) return null
    snapshot[Number(key)] = descriptor.value
  }
  if (Object.keys(descriptors).length !== length + 1) return null
  return Object.freeze(snapshot)
}

function catalogInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
    && value >= 0 && value <= CATALOG_NUMBER_MAX
}

function nullableCatalogInteger(value: unknown): value is number | null {
  return value === null || catalogInteger(value)
}

function nullableBoolean(value: unknown): value is boolean | null {
  return value === null || typeof value === 'boolean'
}

function safeCatalogDisplayName(value: unknown): value is string | null {
  if (value === null) return true
  if (typeof value !== 'string' || value.length === 0 || value.length > 160
    || value !== value.trim() || /[\u0000-\u001f\u007f-\u009f]/.test(value)
    || !/^[\p{L}\p{N}][\p{L}\p{N} .,_+()'!:-]{0,159}$/u.test(value)
    || /(?:[\\/@&=?#]|:\/\/|bearer|api[_ -]?key|password|secret|credential|authorization)/i.test(value)) {
    return false
  }
  return !isOpenCodeCredentialOrAuthorityLike(value)
}

function snapshotCatalogIdentityPayload(value: unknown): OpenCodeCatalogRecordIdentityPayload | null {
  const payload = inertCatalogRecord(value, [
    'providerId', 'source', 'endpoint', 'generation', 'freshness', 'connected', 'models',
  ])
  if (!payload || typeof payload.providerId !== 'string' || typeof payload.source !== 'string'
    || !OPEN_CODE_PROVIDER_CATALOG_SOURCES.includes(payload.source as OpenCodeProviderCatalogSource)
    || !catalogInteger(payload.generation) || !nullableBoolean(payload.connected)) return null
  let providerId: OpenCodeCanonicalProviderId
  try {
    providerId = createOpenCodeCanonicalProviderId(payload.providerId)
    if (providerId !== payload.providerId) return null
  } catch { return null }

  const endpoint = inertCatalogRecord(payload.endpoint, [
    'location', 'protocol', 'authorityFingerprint',
  ])
  if (!endpoint || !['none', 'loopback', 'remote'].includes(endpoint.location as string)
    || ![null, 'http', 'https'].includes(endpoint.protocol as string | null)
    || !(endpoint.authorityFingerprint === null
      || (typeof endpoint.authorityFingerprint === 'string'
        && /^[0-9a-f]{64}$/.test(endpoint.authorityFingerprint)))) return null
  if ((endpoint.location === 'none') !== (endpoint.protocol === null && endpoint.authorityFingerprint === null)
    || (endpoint.location !== 'none'
      && (endpoint.protocol === null || endpoint.authorityFingerprint === null))) {
    return null
  }

  const freshness = inertCatalogRecord(payload.freshness, [
    'state', 'observedAtMs', 'ageMs', 'maxStaleMs',
  ])
  if (!freshness || !['fresh', 'bounded-stale'].includes(freshness.state as string)
    || !catalogInteger(freshness.observedAtMs) || !catalogInteger(freshness.ageMs)
    || !catalogInteger(freshness.maxStaleMs) || freshness.ageMs > freshness.maxStaleMs
    || freshness.observedAtMs + freshness.ageMs > CATALOG_NUMBER_MAX) return null

  const inputModels = inertCatalogArray(payload.models, CATALOG_IDENTITY_MAX_MODELS)
  if (!inputModels) return null
  const models: OpenCodeSafeCatalogModel[] = []
  for (const inputModel of inputModels) {
    const model = inertCatalogRecord(inputModel, [
      'id', 'displayName', 'limits', 'status', 'billing', 'capabilities',
    ])
    if (!model || typeof model.id !== 'string'
      || !safeCatalogDisplayName(model.displayName)
      || !['active', 'alpha', 'beta', 'deprecated', 'unknown'].includes(model.status as string)
      || !['free', 'paid', 'unknown'].includes(model.billing as string)) return null
    let id: OpenCodeCanonicalModelId
    try {
      id = createOpenCodeCanonicalModelId(model.id)
      if (id !== model.id) return null
    } catch { return null }
    const limits = inertCatalogRecord(model.limits, ['context', 'input', 'output'])
    const capabilities = inertCatalogRecord(model.capabilities, ['attachment', 'reasoning', 'tools'])
    if (!limits || !capabilities
      || !nullableCatalogInteger(limits.context) || !nullableCatalogInteger(limits.input)
      || !nullableCatalogInteger(limits.output) || !nullableBoolean(capabilities.attachment)
      || !nullableBoolean(capabilities.reasoning) || !nullableBoolean(capabilities.tools)) return null
    models.push(Object.freeze({
      id,
      displayName: model.displayName as string | null,
      limits: Object.freeze({
        context: limits.context as number | null,
        input: limits.input as number | null,
        output: limits.output as number | null,
      }),
      status: model.status as OpenCodeCatalogModelStatus,
      billing: model.billing as OpenCodeCatalogModelBilling,
      capabilities: Object.freeze({
        attachment: capabilities.attachment as boolean | null,
        reasoning: capabilities.reasoning as boolean | null,
        tools: capabilities.tools as boolean | null,
      }),
    }))
  }
  return Object.freeze({
    providerId,
    source: payload.source as OpenCodeProviderCatalogSource,
    endpoint: Object.freeze({
      location: endpoint.location as OpenCodeEndpointLocation,
      protocol: endpoint.protocol as OpenCodeEndpointProtocol,
      authorityFingerprint: endpoint.authorityFingerprint as string | null,
    }),
    generation: payload.generation,
    freshness: Object.freeze({
      state: freshness.state as OpenCodeCatalogFreshness['state'],
      observedAtMs: freshness.observedAtMs,
      ageMs: freshness.ageMs,
      maxStaleMs: freshness.maxStaleMs,
    }),
    connected: payload.connected,
    models: Object.freeze(models),
  }) as OpenCodeCatalogRecordIdentityPayload
}

/** Hashes only the closed catalog identity payload with fixed key ordering. */
export function createOpenCodeCatalogRecordId(
  value: OpenCodeCatalogRecordIdentityPayload,
): `sha256:${string}` {
  let snapshot: OpenCodeCatalogRecordIdentityPayload | null = null
  try { snapshot = snapshotCatalogIdentityPayload(value) } catch { snapshot = null }
  if (!snapshot) throw new TypeError(CATALOG_IDENTITY_ERROR)
  if (new Set(snapshot.models.map(model => model.id)).size !== snapshot.models.length) {
    throw new TypeError('Duplicate OpenCode catalog model identity')
  }
  const models = [...snapshot.models].sort((left, right) => codeUnitCompare(left.id, right.id)).map(model => ({
    id: model.id,
    displayName: model.displayName,
    limits: { context: model.limits.context, input: model.limits.input, output: model.limits.output },
    status: model.status,
    billing: model.billing,
    capabilities: {
      attachment: model.capabilities.attachment,
      reasoning: model.capabilities.reasoning,
      tools: model.capabilities.tools,
    },
  }))
  const closed = {
    providerId: snapshot.providerId,
    source: snapshot.source,
    endpoint: {
      location: snapshot.endpoint.location,
      protocol: snapshot.endpoint.protocol,
      authorityFingerprint: snapshot.endpoint.authorityFingerprint,
    },
    generation: snapshot.generation,
    freshness: {
      state: snapshot.freshness.state,
      observedAtMs: snapshot.freshness.observedAtMs,
      ageMs: snapshot.freshness.ageMs,
      maxStaleMs: snapshot.freshness.maxStaleMs,
    },
    connected: snapshot.connected,
    models,
  }
  const hash = createHash('sha256').update(JSON.stringify(closed)).digest('hex')
  return `sha256:${hash}`
}
