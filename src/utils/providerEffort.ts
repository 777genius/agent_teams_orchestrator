import type { EffortLevel } from './effort.js'

export function getAnthropicRequestedEffortLevel(
  body: Record<string, unknown>,
): EffortLevel | undefined {
  const outputConfig =
    typeof body.output_config === 'object' && body.output_config !== null
      ? (body.output_config as Record<string, unknown>)
      : null

  const raw = outputConfig?.effort
  if (raw === 'low' || raw === 'medium' || raw === 'high') {
    return raw
  }
  if (raw === 'max') {
    return 'high'
  }
  return undefined
}

export function mapEffortToCodexReasoning(
  effort: EffortLevel | undefined,
): { effort: 'low' | 'medium' | 'high' } | undefined {
  if (!effort) {
    return undefined
  }
  return { effort: effort === 'max' ? 'high' : effort }
}

export function mapEffortToGeminiThinkingConfig(
  model: string,
  effort: EffortLevel | undefined,
): { thinkingBudget?: number; thinkingLevel?: 'LOW' | 'HIGH' } | undefined {
  if (!effort) {
    return undefined
  }

  const normalizedModel = model.trim().toLowerCase()

  // Gemini 2.5 and earlier reject thinkingLevel and require thinkingBudget.
  // Gemini 3+ supports thinkingLevel natively.
  if (!normalizedModel.startsWith('gemini-3')) {
    const isTwoPointFivePro = normalizedModel.includes('gemini-2.5-pro')
    switch (effort) {
      case 'low':
        return { thinkingBudget: isTwoPointFivePro ? 128 : 0 }
      case 'medium':
        return { thinkingBudget: 1024 }
      case 'high':
      case 'max':
        return { thinkingBudget: 8192 }
      default:
        return undefined
    }
  }

  switch (effort) {
    case 'low':
      return { thinkingLevel: 'LOW' }
    case 'medium':
    case 'high':
    case 'max':
      return { thinkingLevel: 'HIGH' }
    default:
      return undefined
  }
}
