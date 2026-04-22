import { getFlagSettingsInline } from '../../bootstrap/state.js'

type CodexForcedLoginMethod = 'chatgpt' | 'api'

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return null
}

export function getCodexForcedLoginMethodForCurrentProcess(
  settingsInline: Record<string, unknown> | null = getFlagSettingsInline(),
): CodexForcedLoginMethod | null {
  const forcedLoginMethod = asRecord(asRecord(settingsInline)?.codex)?.forced_login_method
  return forcedLoginMethod === 'chatgpt' || forcedLoginMethod === 'api'
    ? forcedLoginMethod
    : null
}

export function isCodexChatGptAuthSelectedForCurrentProcess(
  settingsInline: Record<string, unknown> | null = getFlagSettingsInline(),
): boolean {
  return getCodexForcedLoginMethodForCurrentProcess(settingsInline) === 'chatgpt'
}

export function getCodexModelRuntimeDisabledReason(
  model: string,
  settingsInline: Record<string, unknown> | null = getFlagSettingsInline(),
): string | null {
  const normalizedModel = model.trim().toLowerCase()

  if (
    normalizedModel === 'gpt-5.1-codex-max' &&
    isCodexChatGptAuthSelectedForCurrentProcess(settingsInline)
  ) {
    return `The '${model}' model is not supported when using Codex with a ChatGPT account.`
  }

  return null
}

export function isCodexModelSupportedForCurrentProcess(
  model: string,
  settingsInline: Record<string, unknown> | null = getFlagSettingsInline(),
): boolean {
  return getCodexModelRuntimeDisabledReason(model, settingsInline) == null
}

export function filterCodexModelsForCurrentProcess(
  models: readonly string[],
  settingsInline: Record<string, unknown> | null = getFlagSettingsInline(),
): string[] {
  return models.filter(model =>
    isCodexModelSupportedForCurrentProcess(model, settingsInline),
  )
}
