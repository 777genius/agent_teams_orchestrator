import { normalizeOpenCodeProviderId } from './OpenCodeModelRef.js'

const OPEN_CODE_PROVIDER_ALIASES = new Map<string, string>([
  ['minimax-token-plan', 'minimax-coding-plan'],
  ['minimax-token-plan-(minimax.io)', 'minimax-coding-plan'],
  ['xiaomi-token-plan-(europe)', 'xiaomi-token-plan-ams'],
  ['xiaomi-token-plan-(singapore)', 'xiaomi-token-plan-sgp'],
  ['xiaomi-token-plan-(china)', 'xiaomi-token-plan-cn'],
  ['xiaomi-mimo-token-plan---europe', 'xiaomi-token-plan-ams'],
  ['xiaomi-mimo-token-plan---singapore', 'xiaomi-token-plan-sgp'],
  ['xiaomi-mimo-token-plan---china', 'xiaomi-token-plan-cn'],
  ['z.ai-coding-plan', 'zai-coding-plan'],
  ['kimi-code-membership', 'kimi-for-coding'],
  ['amazon-q-developer-/-kiro', 'kiro'],
])

export function canonicalizeOpenCodeProviderId(value: string): string {
  const label = value.trim().toLowerCase().replace(/\s+/g, '-')
  return (
    OPEN_CODE_PROVIDER_ALIASES.get(label)
    ?? normalizeOpenCodeProviderId(label)
    ?? label
  )
}
