import { describe, expect, test } from 'bun:test'

import { isAllowedHostManagedProviderSettingsEnvVar } from './managedEnvConstants.js'

describe('host-managed provider settings env allowlist', () => {
  test('allows official Anthropic backend env when Anthropic is selected', () => {
    expect(
      isAllowedHostManagedProviderSettingsEnvVar(
        'CLAUDE_CODE_USE_BEDROCK',
        'anthropic',
      ),
    ).toBe(true)
    expect(
      isAllowedHostManagedProviderSettingsEnvVar('AWS_BEARER_TOKEN_BEDROCK', 'anthropic'),
    ).toBe(true)
    expect(
      isAllowedHostManagedProviderSettingsEnvVar('ANTHROPIC_DEFAULT_SONNET_MODEL', 'anthropic'),
    ).toBe(true)
    expect(
      isAllowedHostManagedProviderSettingsEnvVar('ANTHROPIC_AWS_WORKSPACE_ID', 'anthropic'),
    ).toBe(true)
    expect(
      isAllowedHostManagedProviderSettingsEnvVar('ANTHROPIC_AWS_API_KEY', 'anthropic'),
    ).toBe(true)
  })

  test('does not allow Anthropic settings to redirect Codex or Gemini launches', () => {
    expect(
      isAllowedHostManagedProviderSettingsEnvVar('CLAUDE_CODE_USE_BEDROCK', 'codex'),
    ).toBe(false)
    expect(
      isAllowedHostManagedProviderSettingsEnvVar('CLAUDE_CODE_USE_VERTEX', 'gemini'),
    ).toBe(false)
    expect(
      isAllowedHostManagedProviderSettingsEnvVar('CLAUDE_CODE_ENTRY_PROVIDER', 'anthropic'),
    ).toBe(false)
    expect(
      isAllowedHostManagedProviderSettingsEnvVar('ANTHROPIC_AWS_WORKSPACE_ID', 'codex'),
    ).toBe(false)
    expect(
      isAllowedHostManagedProviderSettingsEnvVar('ANTHROPIC_AWS_API_KEY', 'gemini'),
    ).toBe(false)
  })

  test('pins backend-specific host entries to their own backend env', () => {
    expect(
      isAllowedHostManagedProviderSettingsEnvVar('CLAUDE_CODE_USE_BEDROCK', 'bedrock'),
    ).toBe(true)
    expect(
      isAllowedHostManagedProviderSettingsEnvVar('CLAUDE_CODE_USE_VERTEX', 'bedrock'),
    ).toBe(false)
    expect(
      isAllowedHostManagedProviderSettingsEnvVar('VERTEX_REGION_CLAUDE_4_5_SONNET', 'vertex'),
    ).toBe(true)
    expect(
      isAllowedHostManagedProviderSettingsEnvVar(
        'ANTHROPIC_AWS_WORKSPACE_ID',
        'claude-platform-aws',
      ),
    ).toBe(true)
    expect(
      isAllowedHostManagedProviderSettingsEnvVar(
        'CLAUDE_CODE_USE_BEDROCK',
        'claude-platform-aws',
      ),
    ).toBe(false)
    expect(
      isAllowedHostManagedProviderSettingsEnvVar(
        'ANTHROPIC_API_KEY',
        'claude-platform-aws',
      ),
    ).toBe(false)
  })
})
