import { describe, expect, test } from 'bun:test'

import { AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE_ENV } from './anthropicConnectionMode.js'
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
    expect(
      isAllowedHostManagedProviderSettingsEnvVar('ANTHROPIC_CUSTOM_HEADERS', 'anthropic'),
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

  test('blocks settings-sourced routing for explicit Anthropic modes', () => {
    for (const mode of ['subscription', 'api_key', 'compatible'] as const) {
      expect(
        isAllowedHostManagedProviderSettingsEnvVar(
          'CLAUDE_CODE_USE_BEDROCK',
          'anthropic',
          mode,
        ),
      ).toBe(false)
      expect(
        isAllowedHostManagedProviderSettingsEnvVar(
          'ANTHROPIC_BASE_URL',
          'anthropic',
          mode,
        ),
      ).toBe(false)
    }

    expect(
      isAllowedHostManagedProviderSettingsEnvVar(
        AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE_ENV,
        'anthropic',
        'api_key',
      ),
    ).toBe(false)
    expect(
      isAllowedHostManagedProviderSettingsEnvVar(
        'ANTHROPIC_CUSTOM_HEADERS',
        'anthropic',
        'api_key',
      ),
    ).toBe(false)
    expect(
      isAllowedHostManagedProviderSettingsEnvVar(
        'ANTHROPIC_CUSTOM_HEADERS',
        'anthropic',
        'compatible',
      ),
    ).toBe(true)
  })

  test('allows compatible model mappings without allowing cloud backend configuration', () => {
    const modelKeys = [
      'ANTHROPIC_MODEL',
      'ANTHROPIC_SMALL_FAST_MODEL',
      'CLAUDE_CODE_SUBAGENT_MODEL',
      ...['HAIKU', 'OPUS', 'SONNET'].flatMap(model => [
        `ANTHROPIC_DEFAULT_${model}_MODEL`,
        `ANTHROPIC_DEFAULT_${model}_MODEL_DESCRIPTION`,
        `ANTHROPIC_DEFAULT_${model}_MODEL_NAME`,
        `ANTHROPIC_DEFAULT_${model}_MODEL_SUPPORTED_CAPABILITIES`,
      ]),
    ]
    for (const key of modelKeys) {
      expect(isAllowedHostManagedProviderSettingsEnvVar(key, 'anthropic', 'compatible')).toBe(true)
      expect(isAllowedHostManagedProviderSettingsEnvVar(key, 'anthropic', 'api_key')).toBe(false)
      expect(isAllowedHostManagedProviderSettingsEnvVar(key, 'anthropic', 'subscription')).toBe(false)
      expect(isAllowedHostManagedProviderSettingsEnvVar(key, 'codex', 'compatible')).toBe(false)
      expect(isAllowedHostManagedProviderSettingsEnvVar(key, 'gemini', 'compatible')).toBe(false)
    }
    for (const key of [
      'ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION',
      'VERTEX_REGION_CLAUDE_4_5_SONNET',
      'ANTHROPIC_BEDROCK_BASE_URL',
      'ANTHROPIC_VERTEX_PROJECT_ID',
      'ANTHROPIC_FOUNDRY_API_KEY',
    ]) {
      expect(isAllowedHostManagedProviderSettingsEnvVar(key, 'anthropic', 'compatible')).toBe(false)
    }
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
