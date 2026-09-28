/** Same line the desktop launch gives agents; `system` or an empty language adds none. */
export function buildAgentLanguageInstruction(agentLanguage?: string): string {
  const trimmed = agentLanguage?.trim()
  if (!trimmed || trimmed.toLowerCase() === 'system') {
    return ''
  }
  return `IMPORTANT: Communicate in ${trimmed}. All messages, summaries, and task descriptions MUST be in ${trimmed}.`
}

/** Puts the language line ahead of a prompt the runtime passes on verbatim. */
export function withAgentLanguageInstruction(agentLanguage: string | undefined, prompt: string): string {
  const instruction = buildAgentLanguageInstruction(agentLanguage)
  return instruction ? `${instruction}\n\n${prompt}` : prompt
}
