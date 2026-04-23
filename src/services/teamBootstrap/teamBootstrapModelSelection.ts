export const PROVIDER_DEFAULT_MODEL_SELECTION = '__provider_default__'

export function normalizeBootstrapModelSelection(
  model: string | null | undefined,
): string | undefined {
  const trimmed = model?.trim()
  if (!trimmed || trimmed === PROVIDER_DEFAULT_MODEL_SELECTION) {
    return undefined
  }
  return trimmed
}
