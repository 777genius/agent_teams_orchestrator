export type OpenCodeProviderScopedModelRef = {
  providerId: string
  modelId: string
  raw: string
}

const OPEN_CODE_PROVIDER_ID_PATTERN = /^[a-z0-9._-]+$/i

export function normalizeOpenCodeProviderId(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase() ?? ''
  return normalized && OPEN_CODE_PROVIDER_ID_PATTERN.test(normalized) ? normalized : null
}

export function parseOpenCodeProviderScopedModelRef(
  value: string | null | undefined,
): OpenCodeProviderScopedModelRef | null {
  const trimmed = value?.trim() ?? ''
  if (!trimmed || /\s/.test(trimmed)) {
    return null
  }

  const separatorIndex = trimmed.indexOf('/')
  if (separatorIndex <= 0 || separatorIndex >= trimmed.length - 1) {
    return null
  }

  const providerId = normalizeOpenCodeProviderId(trimmed.slice(0, separatorIndex))
  const modelId = trimmed.slice(separatorIndex + 1).trim()
  if (!providerId || !modelId || /\s/.test(modelId)) {
    return null
  }

  return {
    providerId,
    modelId,
    raw: `${providerId}/${modelId}`,
  }
}

export function parseFirstOpenCodeModelToken(
  value: string | null | undefined,
): OpenCodeProviderScopedModelRef | null {
  const firstToken = value?.trim().split(/\s+/g)[0] ?? ''
  return parseOpenCodeProviderScopedModelRef(firstToken)
}

export function formatOpenCodeModelRef(providerId: string, modelId: string): string {
  return `${normalizeOpenCodeProviderId(providerId) ?? providerId.trim()}/${modelId.trim()}`
}
