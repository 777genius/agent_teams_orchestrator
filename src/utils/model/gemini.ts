import type { ModelOption } from './modelOptions.js'

export const GEMINI_MODELS = [
  {
    id: 'gemini-2.5-pro',
    label: 'Gemini 2.5 Pro',
    description: 'Most capable Gemini model for complex coding work',
  },
  {
    id: 'gemini-2.5-flash',
    label: 'Gemini 2.5 Flash',
    description: 'Fast Gemini model for everyday coding tasks',
  },
  {
    id: 'gemini-2.5-flash-lite',
    label: 'Gemini 2.5 Flash Lite',
    description: 'Fastest Gemini model for simple tasks',
  },
] as const

export const DEFAULT_GEMINI_MODEL = 'gemini-2.5-pro'
export const DEFAULT_GEMINI_FAST_MODEL = 'gemini-2.5-flash'
export const DEFAULT_GEMINI_SMALL_MODEL = 'gemini-2.5-flash-lite'

function hasGeminiApiCredentialsConfigured(): boolean {
  return Boolean(
    process.env.GEMINI_API_KEY ||
      process.env.GOOGLE_APPLICATION_CREDENTIALS ||
      process.env.GOOGLE_CLOUD_PROJECT ||
      process.env.GCLOUD_PROJECT ||
      process.env.GOOGLE_CLOUD_PROJECT_ID,
  )
}

export function getDefaultGeminiMainModel(): string {
  const backendPreference = process.env.CLAUDE_CODE_GEMINI_BACKEND
  if (backendPreference === 'cli') {
    return DEFAULT_GEMINI_FAST_MODEL
  }
  if (backendPreference === 'api') {
    return DEFAULT_GEMINI_MODEL
  }
  return hasGeminiApiCredentialsConfigured()
    ? DEFAULT_GEMINI_MODEL
    : DEFAULT_GEMINI_FAST_MODEL
}

export function getDefaultGeminiMainModelDescription(): string {
  return getDefaultGeminiMainModel() === DEFAULT_GEMINI_MODEL
    ? 'Use Gemini 2.5 Pro by default'
    : 'Use Gemini 2.5 Flash by default for Gemini CLI compatibility'
}

export function isGeminiModel(model: string): boolean {
  return GEMINI_MODELS.some(candidate => candidate.id === model)
}

export function mapModelAliasToGemini(model: string): string {
  const normalized = model.trim().toLowerCase()
  switch (normalized) {
    case 'best':
    case 'opus':
      return DEFAULT_GEMINI_MODEL
    case 'sonnet':
      return DEFAULT_GEMINI_FAST_MODEL
    case 'haiku':
      return DEFAULT_GEMINI_SMALL_MODEL
    default:
      return model
  }
}

export function getGeminiModelOptions(): ModelOption[] {
  return [
    {
      value: null,
      label: 'Default (recommended)',
      description: getDefaultGeminiMainModelDescription(),
    },
    ...GEMINI_MODELS.map(model => ({
      value: model.id,
      label: model.label,
      description: model.description,
    })),
  ]
}

export function getGeminiDisplayName(model: string): string | undefined {
  return GEMINI_MODELS.find(candidate => candidate.id === model)?.label
}
