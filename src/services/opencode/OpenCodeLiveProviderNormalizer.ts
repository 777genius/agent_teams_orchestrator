import { formatOpenCodeModelRef } from './OpenCodeModelRef.js'
import { types as nodeUtilTypes } from 'node:util'
import {
  canonicalizeOpenCodeProviderId,
  createOpenCodeCanonicalModelId,
  isOpenCodeCredentialOrAuthorityLike,
  tryCreateOpenCodeCanonicalProviderId,
} from './OpenCodeProviderIdentity.js'
import {
  createOpenCodeCatalogRecordId,
  normalizeOpenCodeProviderCatalogSource,
  observeOpenCodeEndpoint,
} from './OpenCodeProviderCatalogContract.js'
import { createOpenCodeContractViolationFailure } from './OpenCodeFailurePolicy.js'

import type { OpenCodeProviderFailure } from './OpenCodeFailurePolicy.js'
import type {
  OpenCodeCatalogFreshness,
  OpenCodeCatalogModelBilling,
  OpenCodeCatalogModelCapabilities,
  OpenCodeCatalogModelLimits,
  OpenCodeCatalogModelStatus,
  OpenCodeSafeCatalogModel,
  OpenCodeScopedProviderCatalog,
} from './OpenCodeProviderCatalogContract.js'

import type {
  OpenCodeConfigProvidersResponse,
  OpenCodeModelMetadata,
  OpenCodeProviderAuthMethod,
  OpenCodeProviderListEntry,
  OpenCodeProviderResponse,
} from './types.js'

const OPEN_CODE_MAX_PROVIDER_ROWS = 256
const OPEN_CODE_MAX_CATALOG_MODELS = 2_048
const OPEN_CODE_MAX_INERT_RECORD_KEYS = 4_096
const OPEN_CODE_MAX_INERT_ARRAY_ITEMS = 4_096
const OPEN_CODE_MAX_METADATA_KEY_LENGTH = 256
const OPEN_CODE_MAX_CATALOG_METADATA_UNITS = 1_048_576

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

const DANGEROUS_RECORD_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

/** Accepts only inert own-data records at the untrusted scoped boundary. */
type CatalogMetadataBudget = { units: number }

function safeRecord(
  value: unknown,
  limits: { maxKeys?: number; budget?: CatalogMetadataBudget } = {},
): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || nodeUtilTypes.isProxy(value)) return null
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return null
  const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<PropertyKey, PropertyDescriptor>
  const descriptorKeys = Reflect.ownKeys(descriptors)
  if (descriptorKeys.length > (limits.maxKeys ?? OPEN_CODE_MAX_INERT_RECORD_KEYS)
    || descriptorKeys.some(key => typeof key === 'symbol'
      || key.length > OPEN_CODE_MAX_METADATA_KEY_LENGTH)) return null
  const snapshot = Object.create(null) as Record<string, unknown>
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (DANGEROUS_RECORD_KEYS.has(key) || !('value' in descriptor)) return null
    if (limits.budget) {
      limits.budget.units += key.length
        + (typeof descriptor.value === 'string' ? descriptor.value.length : 0)
      if (limits.budget.units > OPEN_CODE_MAX_CATALOG_METADATA_UNITS) return null
    }
    Object.defineProperty(snapshot, key, {
      value: descriptor.value,
      enumerable: true,
      configurable: false,
      writable: false,
    })
  }
  return Object.freeze(snapshot)
}

function own(record: Record<string, unknown>, key: string): { present: boolean; value: unknown } {
  const descriptor = Object.getOwnPropertyDescriptor(record, key)
  if (!descriptor) return { present: false, value: undefined }
  if (!('value' in descriptor)) contractViolation()
  return { present: true, value: descriptor.value }
}

/** Snapshots an untrusted array without invoking iteration or element access. */
function safeArray(
  value: unknown,
  maxItems = OPEN_CODE_MAX_INERT_ARRAY_ITEMS,
): readonly unknown[] | null {
  if (!Array.isArray(value) || nodeUtilTypes.isProxy(value)) return null
  if (Object.getPrototypeOf(value) !== Array.prototype) return null
  const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<PropertyKey, PropertyDescriptor>
  if (Reflect.ownKeys(descriptors).some(key => typeof key === 'symbol')) return null
  const lengthDescriptor = descriptors.length
  if (!lengthDescriptor || !('value' in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value)) return null
  const length = lengthDescriptor.value as number
  if (length < 0 || length > maxItems) return null
  const result = new Array<unknown>(length)
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (key === 'length') continue
    if (!/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= length || !('value' in descriptor)) return null
    result[Number(key)] = descriptor.value
  }
  if (Object.keys(descriptors).length !== length + 1) return null
  return Object.freeze(result)
}

function collectFiniteNumbers(value: unknown): number[] {
  if (typeof value === 'number' && Number.isFinite(value)) return [value]
  if (Array.isArray(value)) return value.flatMap(collectFiniteNumbers)
  const record = asRecord(value)
  return record ? Object.values(record).flatMap(collectFiniteNumbers) : []
}

function isOpenCodeCostFree(cost: unknown): boolean {
  const numbers = collectFiniteNumbers(cost)
  return numbers.length > 0 && numbers.every(value => value === 0)
}

function canonicalProviderId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    const canonical = canonicalizeOpenCodeProviderId(value)
    return /^[a-z0-9][a-z0-9._-]*$/.test(canonical) ? canonical : null
  } catch {
    return null
  }
}

function normalizeEntries(entries: readonly OpenCodeProviderListEntry[] | undefined): OpenCodeProviderListEntry[] {
  const normalized = new Map<string, OpenCodeProviderListEntry>()
  const malformed: OpenCodeProviderListEntry[] = []
  for (const entry of entries ?? []) {
    const id = canonicalProviderId(entry.id)
    if (!id) {
      malformed.push({ ...entry, id: '' })
      continue
    }
    const previous = normalized.get(id)
    normalized.set(id, {
      ...previous,
      ...entry,
      id,
      models: {
        ...(previous?.models ?? {}),
        ...(entry.models ?? {}),
      },
    })
  }
  return [...normalized.values(), ...malformed]
}

function normalizeDefaults(defaults: Record<string, string> | undefined): Record<string, string> {
  const normalized: Record<string, string> = {}
  for (const [providerId, modelId] of Object.entries(defaults ?? {})) {
    const id = canonicalProviderId(providerId)
    if (id) normalized[id] = modelId
  }
  return normalized
}

export function normalizeOpenCodeLiveProviderResponse(
  response: OpenCodeProviderResponse,
): OpenCodeProviderResponse {
  return {
    ...response,
    all: normalizeEntries(response.all),
    default: normalizeDefaults(response.default),
    connected: Array.from(new Set(
      (response.connected ?? [])
        .map(canonicalProviderId)
        .filter((id): id is string => Boolean(id)),
    )),
  }
}

export function normalizeOpenCodeLiveConfigProvidersResponse(
  response: OpenCodeConfigProvidersResponse,
): OpenCodeConfigProvidersResponse {
  return {
    ...response,
    providers: normalizeEntries(response.providers),
    default: normalizeDefaults(response.default),
  }
}

export function normalizeOpenCodeLiveProviderAuth(
  providerAuth: Record<string, OpenCodeProviderAuthMethod[]>,
): Record<string, OpenCodeProviderAuthMethod[]> {
  const normalized: Record<string, OpenCodeProviderAuthMethod[]> = {}
  for (const [providerId, methods] of Object.entries(providerAuth)) {
    const id = canonicalProviderId(providerId)
    if (id) normalized[id] = [...(normalized[id] ?? []), ...methods]
  }
  return normalized
}

export function normalizeOpenCodeLiveModelMetadata(
  providers: OpenCodeProviderResponse,
): OpenCodeModelMetadata[] {
  const metadata: OpenCodeModelMetadata[] = []
  for (const provider of providers.all ?? []) {
    const providerId = canonicalProviderId(provider.id)
    if (!providerId) continue
    for (const [modelId, value] of Object.entries(provider.models ?? {})) {
      const raw = asRecord(value)
      if (!raw) continue
      const limits = raw.limit ?? raw.limits ?? null
      const limitRecord = asRecord(limits)
      const context = typeof limitRecord?.context === 'number' && Number.isFinite(limitRecord.context)
        ? limitRecord.context
        : null
      metadata.push({
        id: formatOpenCodeModelRef(providerId, modelId),
        cost: raw.cost ?? null,
        context,
        limits,
        free: isOpenCodeCostFree(raw.cost),
        raw,
      })
    }
  }
  return metadata
}

export function mergeOpenCodeModelMetadata(
  base: readonly OpenCodeModelMetadata[],
  live: readonly OpenCodeModelMetadata[],
): OpenCodeModelMetadata[] {
  const merged = new Map(base.map(item => [item.id, item]))
  for (const item of live) merged.set(item.id, item)
  return Array.from(merged.values())
}

export type NormalizeOpenCodeScopedProviderCatalogInput = Readonly<{
  requestedProviderId: string
  response: unknown
  generation?: number
  observedAtMs?: number
  nowMs?: number
  freshForMs?: number
  maxStaleMs?: number
  endpoint?: string | null
  source?: unknown
}>

export class OpenCodeProviderCatalogContractError extends Error {
  readonly failure: OpenCodeProviderFailure

  constructor() {
    super('The provider returned an invalid response.')
    this.name = 'OpenCodeProviderCatalogContractError'
    this.failure = createOpenCodeContractViolationFailure('provider-catalog')
  }
}

function contractViolation(): never {
  throw new OpenCodeProviderCatalogContractError()
}

const OPEN_CODE_MAX_CATALOG_NUMBER = 10_000_000_000

function safeNonnegativeInteger(value: unknown): number | null {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= OPEN_CODE_MAX_CATALOG_NUMBER
    ? value
    : null
}

function safeDisplayName(value: unknown): string | null {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 160
    && value === value.trim()
    && !/[\u0000-\u001f\u007f-\u009f]/.test(value)
    && /^[\p{L}\p{N}][\p{L}\p{N} .,_+()'!:-]{0,159}$/u.test(value)
    && !/(?:[\\/@&=?#]|:\/\/|bearer|api[_ -]?key|password|secret|credential|authorization)/i.test(value)
    && !isOpenCodeCredentialOrAuthorityLike(value)
    ? value
    : null
}

function safeLimits(
  raw: Record<string, unknown>,
  budget: CatalogMetadataBudget,
): OpenCodeCatalogModelLimits {
  const plural = own(raw, 'limits')
  const singular = own(raw, 'limit')
  if (plural.present && singular.present) contractViolation()
  const selected = plural.present ? plural.value : singular.present ? singular.value : undefined
  const selectedSnapshot = selected === undefined ? null : safeRecord(selected, { maxKeys: 16, budget })
  if (selected !== undefined && !selectedSnapshot) contractViolation()
  const limits = selectedSnapshot ?? Object.create(null) as Record<string, unknown>
  for (const key of ['context', 'input', 'output'] as const) {
    const field = own(limits, key)
    if (field.present && safeNonnegativeInteger(field.value) === null) contractViolation()
  }
  return Object.freeze({
    context: safeNonnegativeInteger(limits.context),
    input: safeNonnegativeInteger(limits.input),
    output: safeNonnegativeInteger(limits.output),
  })
}

function safeStatus(value: unknown): OpenCodeCatalogModelStatus {
  return value === 'active' || value === 'alpha' || value === 'beta' || value === 'deprecated'
    ? value
    : 'unknown'
}

function safeBilling(
  raw: Record<string, unknown>,
  budget: CatalogMetadataBudget,
): OpenCodeCatalogModelBilling {
  const billingField = own(raw, 'billing')
  const freeField = own(raw, 'free')
  if (billingField.present && !['free', 'paid', 'unknown'].includes(billingField.value as string)) contractViolation()
  if (freeField.present && typeof freeField.value !== 'boolean') contractViolation()
  let derived: OpenCodeCatalogModelBilling = 'unknown'
  if (billingField.value === 'free' || freeField.value === true) derived = 'free'
  if (billingField.value === 'paid' || freeField.value === false) {
    if (derived === 'free') contractViolation()
    derived = 'paid'
  }
  const costField = own(raw, 'cost')
  if (!costField.present) return derived
  const cost = safeRecord(costField.value, { maxKeys: 16, budget })
  if (!cost) contractViolation()
  const knownPricingKeys = new Set(['input', 'output', 'cache_read', 'cache_write', 'reasoning'])
  const prices: number[] = []
  for (const [key, value] of Object.entries(cost)) {
    if (!knownPricingKeys.has(key)) continue
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > OPEN_CODE_MAX_CATALOG_NUMBER) contractViolation()
    prices.push(value)
  }
  const fromCost: OpenCodeCatalogModelBilling = prices.length === 0
    ? 'unknown' : prices.every(value => value === 0) ? 'free' : 'paid'
  if (derived !== 'unknown' && fromCost !== 'unknown' && derived !== fromCost) contractViolation()
  return derived === 'unknown' ? fromCost : derived
}

function safeBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function safeCapabilities(
  raw: Record<string, unknown>,
  budget: CatalogMetadataBudget,
): OpenCodeCatalogModelCapabilities {
  const capabilitiesField = own(raw, 'capabilities')
  const capabilitiesSnapshot = capabilitiesField.present
    ? safeRecord(capabilitiesField.value, { maxKeys: 16, budget }) : null
  if (capabilitiesField.present && !capabilitiesSnapshot) contractViolation()
  const capabilities = capabilitiesField.present
    ? capabilitiesSnapshot!
    : Object.create(null) as Record<string, unknown>
  for (const key of ['attachment', 'reasoning', 'tools', 'toolcall', 'toolCall'] as const) {
    const field = own(capabilities, key)
    if (field.present && typeof field.value !== 'boolean') contractViolation()
  }
  for (const key of ['attachment', 'reasoning', 'tool_call'] as const) {
    const field = own(raw, key)
    if (field.present && typeof field.value !== 'boolean') contractViolation()
  }
  const toolValues = ['tools', 'toolcall', 'toolCall']
    .map(key => own(capabilities, key))
    .filter(field => field.present)
    .map(field => field.value as boolean)
  const rawToolCall = own(raw, 'tool_call')
  if (rawToolCall.present && typeof rawToolCall.value !== 'boolean') contractViolation()
  if (rawToolCall.present) toolValues.push(rawToolCall.value as boolean)
  if (new Set(toolValues).size > 1) contractViolation()
  const booleanCapability = (key: 'attachment' | 'reasoning'): boolean | null => {
    const nested = own(capabilities, key)
    const topLevel = own(raw, key)
    if (nested.present && topLevel.present && nested.value !== topLevel.value) contractViolation()
    return safeBoolean(nested.present ? nested.value : topLevel.value)
  }
  return Object.freeze({
    attachment: booleanCapability('attachment'),
    reasoning: booleanCapability('reasoning'),
    tools: toolValues[0] ?? null,
  })
}

function safeModels(value: unknown): readonly OpenCodeSafeCatalogModel[] {
  const budget = { units: 0 }
  const models = safeRecord(value, { maxKeys: OPEN_CODE_MAX_CATALOG_MODELS, budget })
  if (!models) contractViolation()
  const modelEntries = Object.entries(models)
  if (modelEntries.length > OPEN_CODE_MAX_CATALOG_MODELS) contractViolation()
  const safe: OpenCodeSafeCatalogModel[] = []
  for (const [key, value] of modelEntries) {
    const raw = safeRecord(value, { maxKeys: 256, budget })
    if (!raw) contractViolation()
    let modelId: ReturnType<typeof createOpenCodeCanonicalModelId>
    try {
      modelId = createOpenCodeCanonicalModelId(key)
      const rawId = own(raw, 'id')
      if (rawId.present && (typeof rawId.value !== 'string' || rawId.value !== modelId)) contractViolation()
    } catch (error) {
      if (error instanceof OpenCodeProviderCatalogContractError) throw error
      contractViolation()
    }
    safe.push(Object.freeze({
      id: modelId,
      displayName: (() => {
        const displayName = own(raw, 'displayName')
        const name = own(raw, 'name')
        if (displayName.present && name.present && displayName.value !== name.value) contractViolation()
        return safeDisplayName(displayName.present ? displayName.value : name.value)
      })(),
      limits: safeLimits(raw, budget),
      status: (() => {
        const status = own(raw, 'status')
        if (status.present && safeStatus(status.value) === 'unknown' && status.value !== 'unknown') contractViolation()
        return safeStatus(status.value)
      })(),
      billing: safeBilling(raw, budget),
      capabilities: safeCapabilities(raw, budget),
    }))
  }
  safe.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
  return Object.freeze(safe)
}

function providerRows(response: unknown): readonly unknown[] {
  const record = safeRecord(response)
  if (!record) contractViolation()
  const all = own(record, 'all')
  const providers = own(record, 'providers')
  if (all.present && providers.present) contractViolation()
  const rows = all.present ? all.value : providers.value
  const snapshot = safeArray(rows, OPEN_CODE_MAX_PROVIDER_ROWS)
  if (!snapshot) contractViolation()
  if (snapshot.length > OPEN_CODE_MAX_PROVIDER_ROWS) contractViolation()
  return snapshot
}

function endpointCandidate(
  input: Record<string, unknown>,
  response: Record<string, unknown>,
  provider: Record<string, unknown>,
): unknown {
  const inputEndpoint = own(input, 'endpoint')
  if (inputEndpoint.present && inputEndpoint.value !== undefined) return inputEndpoint.value
  const optionsValue = own(provider, 'options')
  const options = optionsValue.present ? safeRecord(optionsValue.value) : null
  if (optionsValue.present && !options) contractViolation()
  return own(provider, 'endpoint').value
    ?? own(provider, 'baseURL').value
    ?? own(provider, 'url').value
    ?? (options ? own(options, 'baseURL').value : undefined)
    ?? (options ? own(options, 'baseUrl').value : undefined)
    ?? own(response, 'endpoint').value
}

function optionalField(record: Record<string, unknown>, key: string, fallback: number): unknown {
  const field = own(record, key)
  return !field.present || field.value === undefined ? fallback : field.value
}

function safeFreshness(input: Record<string, unknown>): OpenCodeCatalogFreshness {
  const observedAtMs = optionalField(input, 'observedAtMs', 0)
  const nowMs = optionalField(input, 'nowMs', observedAtMs as number)
  const freshForMs = optionalField(input, 'freshForMs', 30_000)
  const maxStaleMs = optionalField(input, 'maxStaleMs', 5 * 60_000)
  const safeObservedAtMs = safeNonnegativeInteger(observedAtMs)
  const safeNowMs = safeNonnegativeInteger(nowMs)
  const safeFreshForMs = safeNonnegativeInteger(freshForMs)
  const safeMaxStaleMs = safeNonnegativeInteger(maxStaleMs)
  if (safeObservedAtMs === null || safeNowMs === null || safeFreshForMs === null
    || safeMaxStaleMs === null || safeNowMs < safeObservedAtMs
    || safeFreshForMs > safeMaxStaleMs) contractViolation()
  const ageMs = safeNowMs - safeObservedAtMs
  if (ageMs > safeMaxStaleMs) contractViolation()
  return Object.freeze({
    state: ageMs <= safeFreshForMs ? 'fresh' : 'bounded-stale',
    observedAtMs: safeObservedAtMs,
    ageMs,
    maxStaleMs: safeMaxStaleMs,
  })
}

/**
 * Security boundary for a provider-scoped catalog read. The raw response is
 * reduced to a closed whitelist and is never attached to success or failure.
 */
export function normalizeOpenCodeScopedProviderCatalogResponse(
  input: NormalizeOpenCodeScopedProviderCatalogInput,
): OpenCodeScopedProviderCatalog {
  try {
    const inputSnapshot = safeRecord(input)
    if (!inputSnapshot) contractViolation()
    const requestedProviderId = tryCreateOpenCodeCanonicalProviderId(own(inputSnapshot, 'requestedProviderId').value)
    if (!requestedProviderId) contractViolation()

    const response = safeRecord(own(inputSnapshot, 'response').value)
    if (!response) contractViolation()
    const matches: Record<string, unknown>[] = []
    for (const candidate of providerRows(response)) {
      // Read only the candidate id until it is known to be in scope.
      const row = safeRecord(candidate)
      if (!row) continue
      const candidateId = tryCreateOpenCodeCanonicalProviderId(own(row, 'id').value)
      if (candidateId === requestedProviderId) matches.push(row)
    }
    if (matches.length === 0) contractViolation()

    const normalized = matches.map(row => ({
      models: safeModels(own(row, 'models').value),
      source: normalizeOpenCodeProviderCatalogSource(
        own(inputSnapshot, 'source').value ?? own(row, 'source').value ?? own(response, 'source').value,
      ),
      endpoint: observeOpenCodeEndpoint(endpointCandidate(inputSnapshot, response, row)),
    }))
    const firstSignature = JSON.stringify(normalized[0])
    if (normalized.some(value => JSON.stringify(value) !== firstSignature)) contractViolation()

    const connectedField = own(response, 'connected')
    const connectedValues = connectedField.present ? safeArray(connectedField.value) : null
    if (connectedField.present && !connectedValues) contractViolation()
    const connected = connectedValues
      ? connectedValues.some(value => tryCreateOpenCodeCanonicalProviderId(value) === requestedProviderId)
      : null
    const responseGeneration = own(response, 'generation')
    if (responseGeneration.present && safeNonnegativeInteger(responseGeneration.value) === null) contractViolation()
    const inputGeneration = own(inputSnapshot, 'generation')
    if (inputGeneration.present && inputGeneration.value !== undefined && safeNonnegativeInteger(inputGeneration.value) === null) contractViolation()
    if (inputGeneration.present && inputGeneration.value !== undefined && responseGeneration.present
      && inputGeneration.value !== responseGeneration.value) contractViolation()
    const generation = inputGeneration.present && inputGeneration.value !== undefined
      ? inputGeneration.value as number
      : responseGeneration.present ? responseGeneration.value as number : 0
    const freshness = safeFreshness(inputSnapshot)
    const identityPayload = {
      providerId: requestedProviderId,
      source: normalized[0]!.source,
      endpoint: normalized[0]!.endpoint,
      generation,
      freshness,
      connected,
      models: normalized[0]!.models,
    }
    return Object.freeze({
      schema: 'opencode-scoped-provider-catalog-v1',
      providerId: requestedProviderId,
      source: normalized[0]!.source,
      endpoint: normalized[0]!.endpoint,
      generation,
      recordId: createOpenCodeCatalogRecordId(identityPayload),
      freshness,
      connected,
      models: normalized[0]!.models,
      selectionAllowed: true,
      launchAuthorization: 'forbidden',
    })
  } catch {
    // Never inspect or rethrow an untrusted thrown value. Always allocate a
    // fresh fixed error so attacker-controlled messages and traps cannot cross.
    throw new OpenCodeProviderCatalogContractError()
  }
}
