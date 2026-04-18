// @[MODEL LAUNCH]: Update the fallback model below.
// When the user has never set teammateDefaultModel in /config, new teammates
// default to the Opus alias instead of a pinned model ID. This preserves the
// existing "teammates default to Opus" behavior while still flowing through the
// normal alias-resolution path, so provider-specific and env-based overrides
// (for example ANTHROPIC_DEFAULT_OPUS_MODEL) apply consistently.
export function getHardcodedTeammateModelFallback(): string {
  return 'opus'
}
