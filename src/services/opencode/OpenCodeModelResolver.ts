import {
  formatOpenCodeModelRef,
  normalizeOpenCodeProviderId,
  parseOpenCodeProviderScopedModelRef,
} from './OpenCodeModelRef.js'
import { evaluateOpenCodeAgentModelCompatibility } from './OpenCodeAgentModelCompatibility.js'

import type { OpenCodeProvisioningSnapshot } from './types.js'

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function getConfigProviderModelMatches(
  snapshot: OpenCodeProvisioningSnapshot,
  rawModelId: string,
): Array<{ providerId: string; modelId: string }> {
  const providers = snapshot.configProviders?.providers ?? []
  const matches: Array<{ providerId: string; modelId: string }> = []

  for (const provider of providers) {
    const providerId = normalizeOpenCodeProviderId(asString(provider.id))
    const models = asRecord(provider.models)
    if (!providerId || !models) {
      continue
    }

    if (Object.prototype.hasOwnProperty.call(models, rawModelId)) {
      matches.push({ providerId, modelId: rawModelId })
    }
  }

  for (const model of snapshot.models ?? []) {
    const scoped = splitProviderScopedModel(model)
    if (!scoped || scoped.modelId !== rawModelId) {
      continue
    }
    matches.push(scoped)
  }

  return dedupeModelMatches(matches)
}

function getLiveProviderModelMatches(
  snapshot: OpenCodeProvisioningSnapshot,
  rawModelId: string,
): Array<{ providerId: string; modelId: string }> {
  const matches: Array<{ providerId: string; modelId: string }> = []

  for (const provider of snapshot.providers?.all ?? []) {
    const providerId = normalizeOpenCodeProviderId(asString(provider.id))
    const models = asRecord(provider.models)
    if (!providerId || !models) {
      continue
    }

    if (Object.prototype.hasOwnProperty.call(models, rawModelId)) {
      matches.push({ providerId, modelId: rawModelId })
    }
  }

  return dedupeModelMatches(matches)
}

function dedupeModelMatches(
  matches: Array<{ providerId: string; modelId: string }>,
): Array<{ providerId: string; modelId: string }> {
  const seen = new Set<string>()
  return matches.filter(match => {
    const key = formatScopedModel(match.providerId, match.modelId)
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
    return true
  })
}

function getDefaultProviderMatch(
  snapshot: OpenCodeProvisioningSnapshot,
  rawModelId: string,
): { providerId: string; modelId: string } | null {
  const defaultSources = [
    asRecord(snapshot.configProviders?.default),
    asRecord(snapshot.providers?.default),
  ]

  for (const defaults of defaultSources) {
    if (!defaults) {
      continue
    }
    for (const [providerId, modelId] of Object.entries(defaults)) {
      if (asString(modelId) === rawModelId) {
        return { providerId, modelId: rawModelId }
      }
    }
  }

  return null
}

function splitProviderScopedModel(
  selectedModel: string,
): { providerId: string; modelId: string } | null {
  return parseOpenCodeProviderScopedModelRef(selectedModel)
}

function hasProviderScopedModel(
  snapshot: OpenCodeProvisioningSnapshot,
  providerId: string,
  modelId: string,
): boolean {
  const scopedModel = formatScopedModel(providerId, modelId)
  if ((snapshot.models ?? []).some(model => parseOpenCodeProviderScopedModelRef(model)?.raw === scopedModel)) {
    return true
  }

  const providers = snapshot.configProviders?.providers ?? []
  for (const provider of providers) {
    if (normalizeOpenCodeProviderId(asString(provider.id)) !== providerId) {
      continue
    }
    const models = asRecord(provider.models)
    if (models && Object.prototype.hasOwnProperty.call(models, modelId)) {
      return true
    }
  }

  for (const provider of snapshot.providers?.all ?? []) {
    if (normalizeOpenCodeProviderId(asString(provider.id)) !== providerId) {
      continue
    }
    const models = asRecord(provider.models)
    if (models && Object.prototype.hasOwnProperty.call(models, modelId)) {
      return true
    }
  }
  return false
}

function getKnownProviderIds(snapshot: OpenCodeProvisioningSnapshot): Set<string> {
  const providerIds = new Set<string>()

  for (const provider of snapshot.configProviders?.providers ?? []) {
    const providerId = normalizeOpenCodeProviderId(asString(provider.id))
    if (providerId) {
      providerIds.add(providerId)
    }
  }

  for (const provider of snapshot.providers?.all ?? []) {
    const providerId = normalizeOpenCodeProviderId(asString(provider.id))
    if (providerId) {
      providerIds.add(providerId)
    }
  }

  for (const providerId of snapshot.providers?.connected ?? []) {
    const normalizedProviderId = normalizeOpenCodeProviderId(asString(providerId))
    if (normalizedProviderId) {
      providerIds.add(normalizedProviderId)
    }
  }

  for (const providerId of Object.keys(asRecord(snapshot.configProviders?.default) ?? {})) {
    const normalizedProviderId = normalizeOpenCodeProviderId(providerId)
    if (normalizedProviderId) {
      providerIds.add(normalizedProviderId)
    }
  }

  for (const providerId of Object.keys(asRecord(snapshot.providers?.default) ?? {})) {
    const normalizedProviderId = normalizeOpenCodeProviderId(providerId)
    if (normalizedProviderId) {
      providerIds.add(normalizedProviderId)
    }
  }

  for (const model of snapshot.models ?? []) {
    const scoped = splitProviderScopedModel(model)
    if (scoped) {
      providerIds.add(scoped.providerId)
    }
  }

  return providerIds
}

function formatScopedModel(providerId: string, modelId: string): string {
  return formatOpenCodeModelRef(providerId, modelId)
}

function assertAgentCompatibleModel(
  resolvedModel: string,
  snapshot: OpenCodeProvisioningSnapshot,
): string {
  const metadata = snapshot.modelMetadata?.find(item => item.id === resolvedModel)
  const compatibility = evaluateOpenCodeAgentModelCompatibility(resolvedModel, metadata)
  if (!compatibility.compatible) {
    throw new Error(
      `OpenCode model "${resolvedModel}" cannot be used by Agent Teams: ${compatibility.reason}`,
    )
  }
  return resolvedModel
}

export function resolveOpenCodeProviderScopedModel(
  selectedModel: string,
  snapshot: OpenCodeProvisioningSnapshot,
): string {
  const trimmed = selectedModel.trim()
  const scoped = splitProviderScopedModel(trimmed)
  if (scoped && getKnownProviderIds(snapshot).has(scoped.providerId)) {
    if (!hasProviderScopedModel(snapshot, scoped.providerId, scoped.modelId)) {
      throw new Error(
        `OpenCode provider-scoped model "${trimmed}" was not found in the live provider catalog`,
      )
    }
    return assertAgentCompatibleModel(scoped.raw, snapshot)
  }

  const defaultMatch = getDefaultProviderMatch(snapshot, trimmed)
  if (defaultMatch) {
    return assertAgentCompatibleModel(
      formatScopedModel(defaultMatch.providerId, defaultMatch.modelId),
      snapshot,
    )
  }

  const matches = dedupeModelMatches([
    ...getConfigProviderModelMatches(snapshot, trimmed),
    ...getLiveProviderModelMatches(snapshot, trimmed),
  ])
  if (matches.length === 1 && matches[0]) {
    return assertAgentCompatibleModel(
      formatScopedModel(matches[0].providerId, matches[0].modelId),
      snapshot,
    )
  }

  const connectedProviders = new Set(
    (snapshot.providers?.connected ?? [])
      .map(providerId => normalizeOpenCodeProviderId(providerId))
      .filter((providerId): providerId is string => Boolean(providerId)),
  )
  const connectedMatches = matches.filter(match => connectedProviders.has(match.providerId))
  if (connectedMatches.length === 1 && connectedMatches[0]) {
    return assertAgentCompatibleModel(
      formatScopedModel(connectedMatches[0].providerId, connectedMatches[0].modelId),
      snapshot,
    )
  }

  if (matches.length > 1) {
    const candidates = matches
      .map(match => formatScopedModel(match.providerId, match.modelId))
      .join(', ')
    throw new Error(
      `OpenCode raw model id "${trimmed}" is ambiguous. Use a provider-scoped id. Candidates: ${candidates}`,
    )
  }

  throw new Error(
    `OpenCode raw model id "${trimmed}" was not found in the live provider catalog`,
  )
}
