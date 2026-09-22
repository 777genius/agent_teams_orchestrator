import {
  filterCodexModelsForCurrentProcess,
  isCodexModelSupportedForCurrentProcess,
} from './codexRuntimeAccess.js'

export const CODEX_MODELS = [
  {
    id: 'gpt-5.6-sol',
    label: 'GPT-5.6 Sol',
    description: 'Latest frontier agentic coding model',
  },
  {
    id: 'gpt-5.6-terra',
    label: 'GPT-5.6 Terra',
    description: 'Balanced agentic coding model',
  },
  {
    id: 'gpt-5.6-luna',
    label: 'GPT-5.6 Luna',
    description: 'General-purpose GPT-5.6 model',
  },
  {
    id: 'gpt-5.4',
    label: 'GPT-5.4',
    description: 'Current flagship GPT model',
  },
  {
    id: 'gpt-5.5',
    label: 'GPT-5.5',
    description: 'Latest GPT model discovered by the Codex runtime catalog',
  },
  {
    id: 'gpt-5.4-mini',
    label: 'GPT-5.4 Mini',
    description: 'Fast and efficient for lightweight tasks',
  },
  {
    id: 'gpt-5.3-codex',
    label: 'GPT-5.3 Codex',
    description: 'Optimized for coding and tool use',
  },
  {
    id: 'gpt-5.3-codex-spark',
    label: 'GPT-5.3 Codex Spark',
    description: 'Fastest Codex-oriented model',
  },
  {
    id: 'gpt-5.2-codex',
    label: 'GPT-5.2 Codex',
    description: 'Frontier agentic coding model',
  },
  {
    id: 'gpt-5.2',
    label: 'GPT-5.2',
    description: 'Balanced general-purpose GPT-5.2 model',
  },
  {
    id: 'gpt-5.1-codex-max',
    label: 'GPT-5.1 Codex Max',
    description: 'Highest-depth Codex reasoning model',
  },
  {
    id: 'gpt-5.1-codex-mini',
    label: 'GPT-5.1 Codex Mini',
    description: 'Fast Codex model',
  },
] as const

export const DEFAULT_CODEX_MODEL = 'gpt-5.6-sol'

export function isCodexModel(model: string): boolean {
  const normalized = model.trim().toLowerCase()
  return (
    CODEX_MODELS.some(candidate => candidate.id === normalized) ||
    /^gpt-[a-z0-9][a-z0-9._-]*$/.test(normalized)
  )
}

export function getCodexDisplayName(model: string): string | undefined {
  return CODEX_MODELS.find(candidate => candidate.id === model)?.label
}

export function mapClaudeModelToCodex(claudeModel: string | null): string {
  if (!claudeModel) return DEFAULT_CODEX_MODEL
  if (isCodexModel(claudeModel)) return claudeModel
  const lower = claudeModel.toLowerCase()
  const mappedModel = lower.includes('opus')
    ? 'gpt-5.1-codex-max'
    : lower.includes('haiku')
      ? 'gpt-5.1-codex-mini'
      : lower.includes('sonnet')
        ? 'gpt-5.2-codex'
        : DEFAULT_CODEX_MODEL

  if (isCodexModelSupportedForCurrentProcess(mappedModel)) {
    return mappedModel
  }

  return (
    filterCodexModelsForCurrentProcess(CODEX_MODELS.map(model => model.id))[0] ??
    DEFAULT_CODEX_MODEL
  )
}
