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
    const providerId = asString(provider.id)
    const models = asRecord(provider.models)
    if (!providerId || !models) {
      continue
    }

    if (Object.prototype.hasOwnProperty.call(models, rawModelId)) {
      matches.push({ providerId, modelId: rawModelId })
    }
  }

  return matches
}

function getDefaultProviderMatch(
  snapshot: OpenCodeProvisioningSnapshot,
  rawModelId: string,
): { providerId: string; modelId: string } | null {
  const defaults = asRecord(snapshot.configProviders?.default)
  if (!defaults) {
    return null
  }

  for (const [providerId, modelId] of Object.entries(defaults)) {
    if (asString(modelId) === rawModelId) {
      return { providerId, modelId: rawModelId }
    }
  }

  return null
}

function splitProviderScopedModel(
  selectedModel: string,
): { providerId: string; modelId: string } | null {
  const slashIndex = selectedModel.indexOf('/')
  if (slashIndex <= 0 || slashIndex >= selectedModel.length - 1) {
    return null
  }
  return {
    providerId: selectedModel.slice(0, slashIndex),
    modelId: selectedModel.slice(slashIndex + 1),
  }
}

function hasProviderScopedModel(
  snapshot: OpenCodeProvisioningSnapshot,
  providerId: string,
  modelId: string,
): boolean {
  const providers = snapshot.configProviders?.providers ?? []
  for (const provider of providers) {
    if (asString(provider.id) !== providerId) {
      continue
    }
    const models = asRecord(provider.models)
    return Boolean(models && Object.prototype.hasOwnProperty.call(models, modelId))
  }
  return false
}

function getKnownProviderIds(snapshot: OpenCodeProvisioningSnapshot): Set<string> {
  const providerIds = new Set<string>()

  for (const provider of snapshot.configProviders?.providers ?? []) {
    const providerId = asString(provider.id)
    if (providerId) {
      providerIds.add(providerId)
    }
  }

  for (const provider of snapshot.providers?.all ?? []) {
    const providerId = asString(provider.id)
    if (providerId) {
      providerIds.add(providerId)
    }
  }

  for (const providerId of snapshot.providers?.connected ?? []) {
    const normalizedProviderId = asString(providerId)
    if (normalizedProviderId) {
      providerIds.add(normalizedProviderId)
    }
  }

  for (const providerId of Object.keys(asRecord(snapshot.configProviders?.default) ?? {})) {
    providerIds.add(providerId)
  }

  for (const providerId of Object.keys(asRecord(snapshot.providers?.default) ?? {})) {
    providerIds.add(providerId)
  }

  return providerIds
}

function formatScopedModel(providerId: string, modelId: string): string {
  return `${providerId}/${modelId}`
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
    return trimmed
  }

  const defaultMatch = getDefaultProviderMatch(snapshot, trimmed)
  if (defaultMatch) {
    return formatScopedModel(defaultMatch.providerId, defaultMatch.modelId)
  }

  const matches = getConfigProviderModelMatches(snapshot, trimmed)
  if (matches.length === 1 && matches[0]) {
    return formatScopedModel(matches[0].providerId, matches[0].modelId)
  }

  const connectedProviders = new Set(snapshot.providers?.connected ?? [])
  const connectedMatches = matches.filter(match => connectedProviders.has(match.providerId))
  if (connectedMatches.length === 1 && connectedMatches[0]) {
    return formatScopedModel(connectedMatches[0].providerId, connectedMatches[0].modelId)
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
