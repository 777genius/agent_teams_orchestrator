export type OpenCodeProviderScopedModelRef = {
  providerId: string
  modelId: string
  raw: string
}

const OPEN_CODE_PROVIDER_ID_PATTERN = /^[a-z0-9._-]+$/i
// This mapping belongs at reference admission so model parsing, config seeding
// and selected-provider authority lookup cannot accidentally use different IDs.
const OPEN_CODE_PROVIDER_ID_ALIASES = new Map<string, string>([
  ['lm-studio', 'lmstudio'],
])

/** A malformed persisted model must fail before any runtime side effects. */
export class OpenCodeInvalidProviderModelReferenceError extends Error {
  readonly code = 'OPENCODE_INVALID_PROVIDER_MODEL_REFERENCE'

  constructor() {
    super('OpenCode selected model must be a non-empty provider-scoped reference')
    this.name = 'OpenCodeInvalidProviderModelReferenceError'
  }
}

/** A syntactically valid record can still name a route this runtime cannot own. */
export class OpenCodeUnsupportedProviderModelReferenceError extends Error {
  readonly code = 'OPENCODE_UNSUPPORTED_PROVIDER_MODEL_REFERENCE'

  constructor(reference: string, reason?: string) {
    super(`OpenCode selected provider/model reference is unsupported: ${reference}${reason ? ` (${reason})` : ''}`)
    this.name = 'OpenCodeUnsupportedProviderModelReferenceError'
  }
}

export function normalizeOpenCodeProviderId(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase() ?? ''
  if (!normalized || !OPEN_CODE_PROVIDER_ID_PATTERN.test(normalized)) return null
  return OPEN_CODE_PROVIDER_ID_ALIASES.get(normalized) ?? normalized
}

export function parseOpenCodeProviderScopedModelRef(
  value: string | null | undefined,
): OpenCodeProviderScopedModelRef | null {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  if (!trimmed || /\s/.test(trimmed)) {
    return null
  }

  const separatorIndex = trimmed.indexOf('/')
  if (separatorIndex <= 0 || separatorIndex >= trimmed.length - 1) {
    return null
  }

  const providerId = normalizeOpenCodeProviderId(trimmed.slice(0, separatorIndex))
  const modelId = trimmed.slice(separatorIndex + 1).trim()
  // Nested model ids are supported, but empty path segments are never valid.
  if (!providerId || !modelId || /\s/.test(modelId) || modelId.split('/').some(part => !part)) {
    return null
  }

  return {
    providerId,
    modelId,
    raw: `${providerId}/${modelId}`,
  }
}

export function assertOpenCodeProviderScopedModelRef(
  value: unknown,
): OpenCodeProviderScopedModelRef {
  const parsed = parseOpenCodeProviderScopedModelRef(
    typeof value === 'string' ? value : undefined,
  )
  if (!parsed) throw new OpenCodeInvalidProviderModelReferenceError()
  return parsed
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
