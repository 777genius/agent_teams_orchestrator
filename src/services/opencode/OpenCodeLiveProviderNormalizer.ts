import { isOpenCodeCostFree } from './OpenCodeInventoryService.js'
import { formatOpenCodeModelRef } from './OpenCodeModelRef.js'
import {
  canonicalizeOpenCodeProviderId,
  OPEN_CODE_PROVIDER_ALIAS_ENTRIES,
} from './OpenCodeProviderIdentity.js'

import type {
  OpenCodeConfigProvidersResponse,
  OpenCodeModelMetadata,
  OpenCodeProviderAuthMethod,
  OpenCodeProviderListEntry,
  OpenCodeProviderResponse,
} from './types.js'

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function canonicalProviderId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const raw = value.trim()
  if (!raw) return null
  const aliasLabel = raw.toLowerCase().replace(/\s+/g, '-')
  const isKnownAlias = OPEN_CODE_PROVIDER_ALIAS_ENTRIES.some(([alias]) => alias === aliasLabel)
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(raw) && !isKnownAlias) return null
  const canonical = canonicalizeOpenCodeProviderId(raw)
  return /^[a-z0-9][a-z0-9._-]*$/i.test(canonical) ? canonical : null
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
