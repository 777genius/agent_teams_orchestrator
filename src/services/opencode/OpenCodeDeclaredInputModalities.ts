import type { OpenCodeModelMetadata } from './types.js'

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

// Unlike the presentation getter, a declaration cannot discard malformed entries
// or invent text support when the native catalog omitted its input metadata.
function parseInputModalityArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const modalities = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== 'string' || !entry.trim()) return null
    modalities.add(entry.trim().toLowerCase())
  }
  return Array.from(modalities)
}

function parseInputCapabilityRecord(value: unknown): string[] | null {
  const record = asRecord(value)
  if (!record) return null
  const supported = new Map<string, boolean>()
  for (const [key, enabled] of Object.entries(record)) {
    const modality = key.trim().toLowerCase()
    if (!modality || typeof enabled !== 'boolean') return null
    if (supported.has(modality) && supported.get(modality) !== enabled) return null
    supported.set(modality, enabled)
  }
  return Array.from(supported).filter(([, enabled]) => enabled).map(([modality]) => modality)
}

export function getOpenCodeModelDeclaredInputModalities(
  metadata: OpenCodeModelMetadata | null | undefined,
): string[] | null {
  const rawModalities = metadata?.raw.modalities
  const rawCapabilities = metadata?.raw.capabilities
  const modalities = asRecord(rawModalities)
  const capabilities = asRecord(rawCapabilities)
  if ((rawModalities !== undefined && !modalities) || (rawCapabilities !== undefined && !capabilities)) return null
  const arrayInput = modalities?.input
  const recordInput = capabilities?.input
  const array = arrayInput === undefined ? undefined : parseInputModalityArray(arrayInput)
  const record = recordInput === undefined ? undefined : parseInputCapabilityRecord(recordInput)
  if (array === null || record === null) return null
  if (array && record && (array.length !== record.length || array.some(modality => !record.includes(modality)))) {
    return null
  }
  return array ?? record ?? null
}

export function getOpenCodeV2DeclaredInputModalities(capabilities: unknown): string[] | null {
  return parseInputModalityArray(asRecord(capabilities)?.input)
}
