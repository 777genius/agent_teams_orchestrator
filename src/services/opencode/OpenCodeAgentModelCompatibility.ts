import type { OpenCodeModelMetadata } from './types.js'

export type OpenCodeAgentModelCompatibility = {
  compatible: boolean
  reason: string | null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null
  }
  const entries = value
    .filter((entry): entry is string => typeof entry === 'string')
    .map(entry => entry.trim().toLowerCase())
    .filter(Boolean)
  return entries.length > 0 ? Array.from(new Set(entries)) : null
}

export function getOpenCodeModelInputModalities(
  metadata: OpenCodeModelMetadata | null | undefined,
): string[] {
  const raw = metadata?.raw ?? null
  const modalities = asRecord(raw?.modalities)
  const declaredModalities = stringArray(modalities?.input)
  if (declaredModalities) {
    return declaredModalities
  }

  const capabilities = asRecord(raw?.capabilities)
  const inputCapabilities = asRecord(capabilities?.input)
  if (inputCapabilities) {
    const enabled = Object.entries(inputCapabilities)
      .filter(([, supported]) => supported === true)
      .map(([modality]) => modality.trim().toLowerCase())
      .filter(Boolean)
    if (enabled.length > 0) {
      return Array.from(new Set(enabled))
    }
  }

  return ['text']
}

export function evaluateOpenCodeAgentModelCompatibility(
  modelId: string,
  metadata: OpenCodeModelMetadata | null | undefined,
): OpenCodeAgentModelCompatibility {
  const normalizedModelId = modelId.trim().toLowerCase()
  const raw = metadata?.raw ?? null
  const capabilities = asRecord(raw?.capabilities)
  const outputCapabilities = asRecord(capabilities?.output)
  const modalities = asRecord(raw?.modalities)
  const outputModalities = stringArray(modalities?.output)

  if (
    outputCapabilities?.text === false
    || (outputModalities !== null && !outputModalities.includes('text'))
    || /^xai\/grok-imagine(?:-|$)/.test(normalizedModelId)
  ) {
    return {
      compatible: false,
      reason: 'This model does not produce text responses and cannot run as an Agent Teams member.',
    }
  }

  if (capabilities?.toolcall === false || raw?.tool_call === false) {
    return {
      compatible: false,
      reason: 'This model does not support tool calls required by Agent Teams.',
    }
  }

  return { compatible: true, reason: null }
}

export function filterOpenCodeAgentModels(
  models: readonly string[],
  modelMetadata: readonly OpenCodeModelMetadata[] | undefined,
): string[] {
  const metadataById = new Map(modelMetadata?.map(metadata => [metadata.id, metadata]) ?? [])
  return models.filter(model =>
    evaluateOpenCodeAgentModelCompatibility(model, metadataById.get(model)).compatible,
  )
}

const OPEN_CODE_PREFERRED_DEFAULT_AGENT_MODEL = 'opencode/big-pickle'

// Both `runtime status` (the catalog the app shows) and `model list` (what a
// launch resolves when no model was chosen) must pick the same Default.
export function selectOpenCodeDefaultAgentModel(
  agentModels: readonly string[],
): string | null {
  return (
    agentModels.find(model => model === OPEN_CODE_PREFERRED_DEFAULT_AGENT_MODEL) ??
    agentModels[0] ??
    null
  )
}
