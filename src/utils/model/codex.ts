export const CODEX_MODELS = [
  {
    id: 'gpt-5.4',
    label: 'GPT-5.4',
    description: 'Current flagship GPT model',
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

export const DEFAULT_CODEX_MODEL = 'gpt-5.4'

export function isCodexModel(model: string): boolean {
  return CODEX_MODELS.some(candidate => candidate.id === model)
}

export function getCodexDisplayName(model: string): string | undefined {
  return CODEX_MODELS.find(candidate => candidate.id === model)?.label
}

export function mapClaudeModelToCodex(claudeModel: string | null): string {
  if (!claudeModel) return DEFAULT_CODEX_MODEL
  if (isCodexModel(claudeModel)) return claudeModel
  const lower = claudeModel.toLowerCase()
  if (lower.includes('opus')) return 'gpt-5.1-codex-max'
  if (lower.includes('haiku')) return 'gpt-5.1-codex-mini'
  if (lower.includes('sonnet')) return 'gpt-5.2-codex'
  return DEFAULT_CODEX_MODEL
}
