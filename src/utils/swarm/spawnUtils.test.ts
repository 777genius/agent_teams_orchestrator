import { describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  getFlagSettingsInline,
  getFlagSettingsPath,
  getStrictMcpConfig,
  setFlagSettingsInline,
  setFlagSettingsPath,
  setStrictMcpConfig,
} from '../../bootstrap/state.js'
import { AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE_ENV } from '../anthropicConnectionMode.js'
import { parseArguments } from '../argumentSubstitution.js'
import { eagerParseCliFlags, mergeJsonObjectCliFlagValues } from '../cliArgs.js'
import { buildCodexNativeCustomProviderConfigOverrides } from '../../services/codexNative/customProviderConfigOverrides.js'
import { CODEX_FORCED_LOGIN_METHOD_ENV_VAR } from '../../services/runtimeBackends/codexBackendResolver.js'

import {
  applyFinalMemberEnvPatch,
  buildPaneLauncherCommand,
  buildAppManagedAnthropicApiKeyHelperSettingsFlag,
  buildInheritedCliFlags,
  buildInheritedEnvObject,
  buildInheritedEnvVars,
  buildMemberCodexSettingsFragment,
  buildProviderScopedInheritedSettingsInline,
  materializeMergedMemberSettingsFile,
  shouldClearCodexApiKeysForTeammateSpawn,
  shouldClearAnthropicApiKeyForTeammateSpawn,
  stripInheritedCliFlag,
  stripProviderBoundaryInheritedRuntimeFlags,
} from './spawnUtils.js'

function unquoteLauncherPath(launcher: string): string {
  const prefix = 'sh '
  expect(launcher.startsWith(prefix)).toBe(true)

  const quotedPath = launcher.slice(prefix.length)
  if (quotedPath.startsWith("'") && quotedPath.endsWith("'")) {
    return quotedPath.slice(1, -1).replace(/'\\''/g, "'")
  }

  return quotedPath.replace(/\\ /g, ' ')
}

describe('buildPaneLauncherCommand', () => {
  it('uses portable POSIX sh for pane teammate launch scripts', async () => {
    const launcher = await buildPaneLauncherCommand("printf 'ok\\n'")
    const scriptPath = unquoteLauncherPath(launcher)

    try {
      expect(launcher.startsWith('sh ')).toBe(true)
      expect(launcher).not.toContain('zsh')
      expect(scriptPath.endsWith('launch.sh')).toBe(true)

      const script = await readFile(scriptPath, 'utf8')
      expect(script.startsWith('#!/bin/sh\n')).toBe(true)
      expect(script).toContain("printf 'ok\\n'")
      expect(script).not.toContain('#!/bin/zsh')
    } finally {
      await rm(dirname(scriptPath), { recursive: true, force: true })
    }
  })
})

describe('inherited runtime flags', () => {
  it('does not force strict MCP config for normal teammate inheritance', () => {
    const originalStrictMcpConfig = getStrictMcpConfig()
    setStrictMcpConfig(false)

    try {
      expect(buildInheritedCliFlags({ provider: 'anthropic' })).not.toContain(
        '--strict-mcp-config',
      )
      expect(
        buildInheritedCliFlags({
          provider: 'anthropic',
          strictMcpConfig: false,
        }),
      ).not.toContain('--strict-mcp-config')
    } finally {
      setStrictMcpConfig(originalStrictMcpConfig)
    }
  })

  it('preserves explicit strict MCP config inheritance', () => {
    const originalStrictMcpConfig = getStrictMcpConfig()

    try {
      setStrictMcpConfig(false)
      expect(
        buildInheritedCliFlags({
          provider: 'anthropic',
          strictMcpConfig: true,
        }),
      ).toContain('--strict-mcp-config')

      setStrictMcpConfig(true)
      expect(buildInheritedCliFlags({ provider: 'anthropic' })).toContain(
        '--strict-mcp-config',
      )
    } finally {
      setStrictMcpConfig(originalStrictMcpConfig)
    }
  })

  it('strips model and effort when crossing provider boundaries', () => {
    expect(
      stripProviderBoundaryInheritedRuntimeFlags(
        '--dangerously-skip-permissions --model gpt-5.4 --effort high --settings /tmp/settings.json',
      ),
    ).toBe('--dangerously-skip-permissions --settings /tmp/settings.json')
  })

  it('strips equals-style inherited flags too', () => {
    expect(
      stripProviderBoundaryInheritedRuntimeFlags(
        '--model=gpt-5.4 --effort=high --strict-mcp-config',
      ),
    ).toBe('--strict-mcp-config')
  })

  it('scopes inherited settings for Codex teammates without Anthropic helper settings', () => {
    const settings = buildProviderScopedInheritedSettingsInline('codex', {
      apiKeyHelper: "'/tmp/helper.sh'",
      awsCredentialExport: '/tmp/aws.sh',
      awsAuthRefresh: '/tmp/aws-refresh.sh',
      gcpAuthRefresh: '/tmp/gcp-refresh.sh',
      codex: {
        forced_login_method: 'chatgpt',
        agent_teams_workspace_trust: {
          config_overrides: ['projects."/tmp/project".trust_level="trusted"'],
        },
      },
    })

    expect(settings).toEqual({
      codex: {
        forced_login_method: 'chatgpt',
        agent_teams_workspace_trust: {
          config_overrides: ['projects."/tmp/project".trust_level="trusted"'],
        },
      },
    })
  })

  it('scopes inherited settings for Gemini teammates while keeping GCP refresh settings', () => {
    const settings = buildProviderScopedInheritedSettingsInline('gemini', {
      apiKeyHelper: "'/tmp/helper.sh'",
      awsCredentialExport: '/tmp/aws.sh',
      awsAuthRefresh: '/tmp/aws-refresh.sh',
      gcpAuthRefresh: '/tmp/gcp-refresh.sh',
      gemini: { example: true },
    })

    expect(settings).toEqual({
      gcpAuthRefresh: '/tmp/gcp-refresh.sh',
      gemini: { example: true },
    })
  })

  it('drops empty inherited helper-only settings for Codex teammates', () => {
    expect(
      buildProviderScopedInheritedSettingsInline('codex', {
        apiKeyHelper: "'/tmp/helper.sh'",
        awsCredentialExport: '/tmp/aws.sh',
        awsAuthRefresh: '/tmp/aws-refresh.sh',
        gcpAuthRefresh: '/tmp/gcp-refresh.sh',
      }),
    ).toBeNull()
  })

  it('scopes inherited settings for OpenCode teammates without Anthropic helper settings', () => {
    expect(
      buildProviderScopedInheritedSettingsInline('opencode', {
        apiKeyHelper: "'/tmp/helper.sh'",
        awsCredentialExport: '/tmp/aws.sh',
        awsAuthRefresh: '/tmp/aws-refresh.sh',
        gcpAuthRefresh: '/tmp/gcp-refresh.sh',
        opencode: { example: true },
      }),
    ).toEqual({
      opencode: { example: true },
    })
  })

  it('keeps unrelated flags when stripping one inherited flag', () => {
    expect(
      stripInheritedCliFlag(
        '--permission-mode auto --effort medium --strict-mcp-config',
        '--effort',
      ),
    ).toBe('--permission-mode auto --strict-mcp-config')
  })

  it('strips quoted inherited flag values without corrupting later MCP overrides', () => {
    const stripped = stripInheritedCliFlag(
      "--mcp-config '/tmp/config dir/stale inherited mcp.json' --setting-sources user\\,project\\,local --strict-mcp-config",
      '--mcp-config',
    )

    expect(stripped).not.toContain('stale inherited mcp')
    expect(parseArguments(stripped)).toEqual([
      '--setting-sources',
      'user,project,local',
      '--strict-mcp-config',
    ])
  })
})

describe('shouldClearAnthropicApiKeyForTeammateSpawn', () => {
  it('clears an unapproved custom API key for pane-spawned teammates', () => {
    expect(
      shouldClearAnthropicApiKeyForTeammateSpawn({
        anthropicApiKey: 'sk-ant-test-unapproved',
        customApiKeyStatus: 'new',
        isHomespace: false,
      }),
    ).toBe(true)
  })

  it('keeps an approved custom API key available to spawned teammates', () => {
    expect(
      shouldClearAnthropicApiKeyForTeammateSpawn({
        anthropicApiKey: 'sk-ant-test-approved',
        customApiKeyStatus: 'approved',
        isHomespace: false,
      }),
    ).toBe(false)
  })

  it('does not clear the key on homespace', () => {
    expect(
      shouldClearAnthropicApiKeyForTeammateSpawn({
        anthropicApiKey: 'sk-ant-test-homespace',
        customApiKeyStatus: 'new',
        isHomespace: true,
      }),
    ).toBe(false)
  })

  it('keeps an unapproved API key when the host manages an Anthropic teammate target', () => {
    expect(
      shouldClearAnthropicApiKeyForTeammateSpawn({
        anthropicApiKey: 'sk-ant-test-host-managed',
        customApiKeyStatus: 'new',
        isHostManagedAnthropicTarget: true,
        isHomespace: false,
      }),
    ).toBe(false)
  })

  it('does not clear when there is no custom API key to leak into the child env', () => {
    expect(
      shouldClearAnthropicApiKeyForTeammateSpawn({
        anthropicApiKey: undefined,
        customApiKeyStatus: 'new',
        isHomespace: false,
      }),
    ).toBe(false)
  })

  it('appends explicit per-spawn env vars after inherited teammate env', () => {
    const env = buildInheritedEnvVars({
      extraEnv: {
        CLAUDE_CODE_TEAMMATE_STARTUP_READY_SENTINEL_PATH:
          '/tmp/startup-ready.json',
      },
    })

    expect(env).toContain(
      'CLAUDE_CODE_TEAMMATE_STARTUP_READY_SENTINEL_PATH=/tmp/startup-ready.json',
    )
  })

  it('pins anthropic teammate overrides to host-managed first-party routing', () => {
    const env = buildInheritedEnvVars({ provider: 'anthropic' })

    expect(env).toContain('CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1')
    expect(env).toContain('CLAUDE_CODE_ENTRY_PROVIDER=anthropic')
    expect(env).toContain("CLAUDE_CODE_USE_OPENAI=''")
    expect(env).toContain("CLAUDE_CODE_USE_GEMINI=''")
  })

  it('forwards the native model context cap through process and tmux teammate env', () => {
    const original = process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT
    process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT = '1'
    try {
      expect(buildInheritedEnvObject({ provider: 'anthropic' })).toHaveProperty(
        'CLAUDE_CODE_DISABLE_1M_CONTEXT', '1',
      )
      expect(buildInheritedEnvVars({ provider: 'anthropic' })).toContain(
        'CLAUDE_CODE_DISABLE_1M_CONTEXT=1',
      )
    } finally {
      if (original === undefined) delete process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT
      else process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT = original
    }
  })

  it('forwards Anthropic connection intent through Anthropic and non-Anthropic teammates', () => {
    const original = process.env[AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE_ENV]
    process.env[AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE_ENV] = 'subscription'

    try {
      expect(buildInheritedEnvVars({ provider: 'anthropic' })).toContain(
        `${AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE_ENV}=subscription`,
      )
      expect(buildInheritedEnvVars({ provider: 'codex' })).toContain(
        `${AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE_ENV}=subscription`,
      )
    } finally {
      if (original === undefined) {
        delete process.env[AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE_ENV]
      } else {
        process.env[AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE_ENV] = original
      }
    }
  })

  it.each(['api_key', 'subscription'] as const)('scrubs inherited gateway models and routing for %s Anthropic teammates', mode => {
    const keys = [
      AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE_ENV,
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_CUSTOM_HEADERS',
      'ANTHROPIC_AWS_WORKSPACE_ID',
      'ANTHROPIC_MODEL',
      'ANTHROPIC_SMALL_FAST_MODEL',
      'ANTHROPIC_DEFAULT_SONNET_MODEL',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
    ] as const
    const original = new Map(keys.map(key => [key, process.env[key]]))

    try {
      process.env[AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE_ENV] = mode
      process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1'
      process.env.ANTHROPIC_API_KEY = 'sk-ant-direct'
      process.env.ANTHROPIC_AUTH_TOKEN = 'ambient-token'
      process.env.ANTHROPIC_BASE_URL = 'https://gateway.example/anthropic'
      process.env.ANTHROPIC_CUSTOM_HEADERS =
        'Authorization: Bearer ambient-token'
      process.env.ANTHROPIC_AWS_WORKSPACE_ID = 'wrkspc_should_not_win'
      process.env.ANTHROPIC_MODEL = 'gateway-main'
      process.env.ANTHROPIC_SMALL_FAST_MODEL = 'gateway-small'
      process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'bedrock-model-id'
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'ambient-oauth-token'

      const env = buildInheritedEnvObject({ provider: 'anthropic' })

      expect(env.ANTHROPIC_API_KEY).toBe(mode === 'api_key' ? 'sk-ant-direct' : '')
      expect(env.ANTHROPIC_AUTH_TOKEN).toBe('')
      expect(env.ANTHROPIC_BASE_URL).toBe('')
      expect(env.ANTHROPIC_CUSTOM_HEADERS).toBe('')
      expect(env.ANTHROPIC_AWS_WORKSPACE_ID).toBe('')
      expect(env.ANTHROPIC_MODEL).toBe('')
      expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBe('')
      expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('')
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(mode === 'api_key' ? '' : undefined)
    } finally {
      for (const key of keys) {
        const value = original.get(key)
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })

  it('preserves compatible endpoint models and auth while clearing cloud backend routing', () => {
    const keys = [
      AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE_ENV,
      'ANTHROPIC_AUTH_TOKEN',
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_CUSTOM_HEADERS',
      'ANTHROPIC_MODEL',
      'ANTHROPIC_SMALL_FAST_MODEL',
      'ANTHROPIC_DEFAULT_OPUS_MODEL',
      'ANTHROPIC_DEFAULT_OPUS_MODEL_NAME',
      'CLAUDE_CODE_SUBAGENT_MODEL',
      'ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION',
      'ANTHROPIC_AWS_WORKSPACE_ID',
    ] as const
    const original = new Map(keys.map(key => [key, process.env[key]]))

    try {
      process.env[AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE_ENV] = 'compatible'
      process.env.ANTHROPIC_AUTH_TOKEN = 'local-token'
      process.env.ANTHROPIC_BASE_URL = 'http://localhost:1234'
      process.env.ANTHROPIC_CUSTOM_HEADERS = 'X-Gateway-Tenant: team-1'
      process.env.ANTHROPIC_MODEL = 'gateway-main'
      process.env.ANTHROPIC_SMALL_FAST_MODEL = 'gateway-small'
      process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'gateway-opus'
      process.env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME = 'Gateway Opus'
      process.env.CLAUDE_CODE_SUBAGENT_MODEL = 'gateway-subagent'
      process.env.ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION = 'us-east-1'
      process.env.ANTHROPIC_AWS_WORKSPACE_ID = 'ambient-workspace'

      const env = buildInheritedEnvObject({ provider: 'anthropic' })

      expect(env.ANTHROPIC_AUTH_TOKEN).toBe('local-token')
      expect(env.ANTHROPIC_BASE_URL).toBe('http://localhost:1234')
      expect(env.ANTHROPIC_CUSTOM_HEADERS).toBe('X-Gateway-Tenant: team-1')
      expect(env.ANTHROPIC_MODEL).toBe('gateway-main')
      expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBe('gateway-small')
      expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('gateway-opus')
      expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME).toBe('Gateway Opus')
      expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBe('gateway-subagent')
      expect(env.ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION).toBe('')
      expect(env.ANTHROPIC_AWS_WORKSPACE_ID).toBe('')
    } finally {
      for (const key of keys) {
        const value = original.get(key)
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })

  it('keeps compatible model overrides ahead of inherited models, including explicit clears', () => {
    const keys = [
      AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE_ENV,
      'ANTHROPIC_MODEL',
      'ANTHROPIC_SMALL_FAST_MODEL',
      'CLAUDE_CODE_SUBAGENT_MODEL',
    ] as const
    const original = new Map(keys.map(key => [key, process.env[key]]))
    try {
      process.env[AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE_ENV] = 'compatible'
      process.env.ANTHROPIC_MODEL = 'inherited-main'
      process.env.ANTHROPIC_SMALL_FAST_MODEL = 'inherited-small'
      delete process.env.CLAUDE_CODE_SUBAGENT_MODEL

      const env = buildInheritedEnvObject({
        provider: 'anthropic',
        extraEnv: {
          ANTHROPIC_MODEL: 'overridden-main',
          ANTHROPIC_SMALL_FAST_MODEL: '',
        },
      })

      expect(env.ANTHROPIC_MODEL).toBe('overridden-main')
      expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBe('')
      expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBe('')
    } finally {
      for (const key of keys) {
        const value = original.get(key)
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })

  it('restores Auto Bedrock routing for a dynamic Anthropic teammate', () => {
    const keys = [
      AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE_ENV,
      'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
      'CLAUDE_CODE_ENTRY_PROVIDER',
      'CLAUDE_CODE_USE_BEDROCK',
      'AWS_PROFILE',
      'AWS_REGION',
      'ANTHROPIC_DEFAULT_SONNET_MODEL',
    ] as const
    const original = new Map(keys.map(key => [key, process.env[key]]))

    try {
      process.env[AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE_ENV] = 'auto'
      process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1'
      process.env.CLAUDE_CODE_ENTRY_PROVIDER = 'codex'
      process.env.CLAUDE_CODE_USE_BEDROCK = '1'
      process.env.AWS_PROFILE = 'bedrock-profile'
      process.env.AWS_REGION = 'us-east-1'
      process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'bedrock-sonnet-id'

      const env = buildInheritedEnvObject({ provider: 'anthropic' })

      expect(env.CLAUDE_CODE_ENTRY_PROVIDER).toBe('anthropic')
      expect(env.CLAUDE_CODE_USE_BEDROCK).toBe('1')
      expect(env.AWS_PROFILE).toBe('bedrock-profile')
      expect(env.AWS_REGION).toBe('us-east-1')
      expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe(
        'bedrock-sonnet-id',
      )
    } finally {
      for (const key of keys) {
        const value = original.get(key)
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })

  it('pins codex teammate overrides explicitly instead of relying on inherited host defaults', () => {
    const env = buildInheritedEnvVars({ provider: 'codex' })

    expect(env).toContain('CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1')
    expect(env).toContain('CLAUDE_CODE_ENTRY_PROVIDER=codex')
  })

  it('forwards Codex API key env vars to tmux teammates', () => {
    const originalApiKey = process.env.OPENAI_API_KEY
    const originalCodexApiKey = process.env.CODEX_API_KEY

    process.env.OPENAI_API_KEY = 'sk-openai-teammate'
    process.env.CODEX_API_KEY = 'sk-codex-teammate'

    try {
      const env = buildInheritedEnvVars({ provider: 'codex' })

      expect(env).toContain('OPENAI_API_KEY=sk-openai-teammate')
      expect(env).toContain('CODEX_API_KEY=sk-codex-teammate')
    } finally {
      if (originalApiKey === undefined) {
        delete process.env.OPENAI_API_KEY
      } else {
        process.env.OPENAI_API_KEY = originalApiKey
      }

      if (originalCodexApiKey === undefined) {
        delete process.env.CODEX_API_KEY
      } else {
        process.env.CODEX_API_KEY = originalCodexApiKey
      }
    }
  })

  it('forwards Anthropic API keys to host-managed Anthropic teammates', () => {
    const originalApiKey = process.env.ANTHROPIC_API_KEY
    const originalManagedByHost =
      process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST
    const originalEntryProvider = process.env.CLAUDE_CODE_ENTRY_PROVIDER

    process.env.ANTHROPIC_API_KEY = 'sk-ant-host-managed-teammate'
    process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1'
    process.env.CLAUDE_CODE_ENTRY_PROVIDER = 'anthropic'

    try {
      const env = buildInheritedEnvVars({ provider: 'anthropic' })

      expect(env).toContain('ANTHROPIC_API_KEY=sk-ant-host-managed-teammate')
      expect(env).not.toContain("ANTHROPIC_API_KEY=''")
    } finally {
      if (originalApiKey === undefined) {
        delete process.env.ANTHROPIC_API_KEY
      } else {
        process.env.ANTHROPIC_API_KEY = originalApiKey
      }

      if (originalManagedByHost === undefined) {
        delete process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST
      } else {
        process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST =
          originalManagedByHost
      }

      if (originalEntryProvider === undefined) {
        delete process.env.CLAUDE_CODE_ENTRY_PROVIDER
      } else {
        process.env.CLAUDE_CODE_ENTRY_PROVIDER = originalEntryProvider
      }
    }
  })

  it('uses app-managed Anthropic helper mode without forwarding competing auth carriers', () => {
    const keys = [
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
      'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
      'CLAUDE_CODE_ENTRY_PROVIDER',
      'CLAUDE_TEAM_ANTHROPIC_AUTH_MODE',
      'CLAUDE_TEAM_ANTHROPIC_API_KEY_HELPER_SETTINGS_PATH',
    ] as const
    const originals = new Map<string, string | undefined>(
      keys.map(key => [key, process.env[key]]),
    )
    const settingsPath =
      '/tmp/team-runtime-auth/demo/runtime-settings-anthropic.json'

    process.env.ANTHROPIC_API_KEY = 'sk-ant-helper-should-not-forward'
    process.env.ANTHROPIC_AUTH_TOKEN = 'proxy-token-should-not-forward'
    process.env.CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR = '3'
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-token-should-not-forward'
    process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR = '4'
    process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1'
    process.env.CLAUDE_CODE_ENTRY_PROVIDER = 'anthropic'
    process.env.CLAUDE_TEAM_ANTHROPIC_AUTH_MODE = 'api_key_helper'
    process.env.CLAUDE_TEAM_ANTHROPIC_API_KEY_HELPER_SETTINGS_PATH =
      settingsPath

    try {
      const env = buildInheritedEnvVars({ provider: 'anthropic' })

      expect(env).toContain("ANTHROPIC_API_KEY=''")
      expect(env).toContain("ANTHROPIC_AUTH_TOKEN=''")
      expect(env).toContain("CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR=''")
      expect(env).toContain("CLAUDE_CODE_OAUTH_TOKEN=''")
      expect(env).toContain("CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR=''")
      expect(env).toContain('CLAUDE_TEAM_ANTHROPIC_AUTH_MODE=api_key_helper')
      expect(env).toContain(
        `CLAUDE_TEAM_ANTHROPIC_API_KEY_HELPER_SETTINGS_PATH=${settingsPath}`,
      )
      expect(env).not.toContain('sk-ant-helper-should-not-forward')
      expect(env).not.toContain('proxy-token-should-not-forward')

      const flags = buildInheritedCliFlags({ provider: 'anthropic' })
      expect(flags).toContain('--settings')
      expect(flags).toContain(settingsPath)
      expect(buildAppManagedAnthropicApiKeyHelperSettingsFlag('codex')).toBeNull()
    } finally {
      for (const key of keys) {
        const original = originals.get(key)
        if (original === undefined) {
          delete process.env[key]
        } else {
          process.env[key] = original
        }
      }
    }
  })

  it('keeps app-managed Anthropic helper auth scrubbed after extra env merges', () => {
    const keys = [
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
      'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
      'CLAUDE_TEAM_ANTHROPIC_AUTH_MODE',
      'CLAUDE_TEAM_ANTHROPIC_API_KEY_HELPER_SETTINGS_PATH',
    ] as const
    const originals = new Map<string, string | undefined>(
      keys.map(key => [key, process.env[key]]),
    )
    const settingsPath =
      '/tmp/team-runtime-auth/demo/runtime-settings-anthropic.json'

    process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1'
    process.env.CLAUDE_TEAM_ANTHROPIC_AUTH_MODE = 'api_key_helper'
    process.env.CLAUDE_TEAM_ANTHROPIC_API_KEY_HELPER_SETTINGS_PATH =
      settingsPath

    try {
      const env = buildInheritedEnvObject({
        provider: 'anthropic',
        extraEnv: {
          ANTHROPIC_API_KEY: 'sk-ant-extra-env-should-not-win',
          ANTHROPIC_AUTH_TOKEN: 'extra-token-should-not-win',
          CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR: '9',
          CLAUDE_CODE_OAUTH_TOKEN: 'extra-oauth-token-should-not-win',
          CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: '10',
        },
      })

      expect(env.ANTHROPIC_API_KEY).toBe('')
      expect(env.ANTHROPIC_AUTH_TOKEN).toBe('')
      expect(env.CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR).toBe('')
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('')
      expect(env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR).toBe('')
      expect(env.CLAUDE_TEAM_ANTHROPIC_AUTH_MODE).toBe('api_key_helper')
      expect(env.CLAUDE_TEAM_ANTHROPIC_API_KEY_HELPER_SETTINGS_PATH).toBe(
        settingsPath,
      )
      expect(Object.values(env).join('\n')).not.toContain(
        'sk-ant-extra-env-should-not-win',
      )
      expect(Object.values(env).join('\n')).not.toContain(
        'extra-token-should-not-win',
      )
    } finally {
      for (const key of keys) {
        const original = originals.get(key)
        if (original === undefined) {
          delete process.env[key]
        } else {
          process.env[key] = original
        }
      }
    }
  })

  it('does not leak Anthropic helper markers into non-Anthropic teammate envs', () => {
    const originalManagedByHost =
      process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST
    const originalAuthMode = process.env.CLAUDE_TEAM_ANTHROPIC_AUTH_MODE
    const originalSettingsPath =
      process.env.CLAUDE_TEAM_ANTHROPIC_API_KEY_HELPER_SETTINGS_PATH

    process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1'
    process.env.CLAUDE_TEAM_ANTHROPIC_AUTH_MODE = 'api_key_helper'
    process.env.CLAUDE_TEAM_ANTHROPIC_API_KEY_HELPER_SETTINGS_PATH =
      '/tmp/team-runtime-auth/demo/runtime-settings-anthropic.json'

    try {
      const env = buildInheritedEnvVars({ provider: 'codex' })

      expect(env).not.toContain('CLAUDE_TEAM_ANTHROPIC_AUTH_MODE')
      expect(env).not.toContain(
        'CLAUDE_TEAM_ANTHROPIC_API_KEY_HELPER_SETTINGS_PATH',
      )
    } finally {
      if (originalManagedByHost === undefined) {
        delete process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST
      } else {
        process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST =
          originalManagedByHost
      }

      if (originalAuthMode === undefined) {
        delete process.env.CLAUDE_TEAM_ANTHROPIC_AUTH_MODE
      } else {
        process.env.CLAUDE_TEAM_ANTHROPIC_AUTH_MODE = originalAuthMode
      }

      if (originalSettingsPath === undefined) {
        delete process.env.CLAUDE_TEAM_ANTHROPIC_API_KEY_HELPER_SETTINGS_PATH
      } else {
        process.env.CLAUDE_TEAM_ANTHROPIC_API_KEY_HELPER_SETTINGS_PATH =
          originalSettingsPath
      }
    }
  })

  it('passes inline Codex forced-login settings instead of Anthropic helper settings to Codex teammates', () => {
    const originalManagedByHost =
      process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST
    const originalAuthMode = process.env.CLAUDE_TEAM_ANTHROPIC_AUTH_MODE
    const originalSettingsPath =
      process.env.CLAUDE_TEAM_ANTHROPIC_API_KEY_HELPER_SETTINGS_PATH
    const originalFlagSettingsPath = getFlagSettingsPath()
    const originalFlagSettingsInline = getFlagSettingsInline()
    const helperDir = '/var/folders/team-runtime-auth/mixed/runs/run-1'
    const inheritedAnthropicSettingsPath =
      `/private${helperDir}/runtime-settings-anthropic.json`

    process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1'
    process.env.CLAUDE_TEAM_ANTHROPIC_AUTH_MODE = 'api_key_helper'
    process.env.CLAUDE_TEAM_ANTHROPIC_API_KEY_HELPER_SETTINGS_PATH =
      `${helperDir}/settings.json`
    setFlagSettingsPath(inheritedAnthropicSettingsPath)
    setFlagSettingsInline({
      apiKeyHelper: "'/tmp/helper.sh'",
      awsCredentialExport: '/tmp/aws.sh',
      awsAuthRefresh: '/tmp/aws-refresh.sh',
      gcpAuthRefresh: '/tmp/gcp-refresh.sh',
      codex: {
        forced_login_method: 'chatgpt',
        agent_teams_workspace_trust: {
          config_overrides: [
            'projects."/tmp/project".trust_level="trusted"',
          ],
        },
      },
    })

    try {
      const flags = buildInheritedCliFlags({ provider: 'codex' })

      expect(flags).toContain('--settings')
      expect(flags).toContain('forced_login_method')
      expect(flags).toContain('chatgpt')
      expect(flags).toContain('agent_teams_workspace_trust')
      expect(flags).toContain('projects')
      expect(flags).not.toContain(inheritedAnthropicSettingsPath)
      expect(flags).not.toContain('apiKeyHelper')
      expect(flags).not.toContain('awsCredentialExport')
      expect(flags).not.toContain('awsAuthRefresh')
      expect(flags).not.toContain('gcpAuthRefresh')
    } finally {
      setFlagSettingsPath(originalFlagSettingsPath)
      setFlagSettingsInline(originalFlagSettingsInline)
      if (originalManagedByHost === undefined) {
        delete process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST
      } else {
        process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST =
          originalManagedByHost
      }
      if (originalAuthMode === undefined) {
        delete process.env.CLAUDE_TEAM_ANTHROPIC_AUTH_MODE
      } else {
        process.env.CLAUDE_TEAM_ANTHROPIC_AUTH_MODE = originalAuthMode
      }
      if (originalSettingsPath === undefined) {
        delete process.env.CLAUDE_TEAM_ANTHROPIC_API_KEY_HELPER_SETTINGS_PATH
      } else {
        process.env.CLAUDE_TEAM_ANTHROPIC_API_KEY_HELPER_SETTINGS_PATH =
          originalSettingsPath
      }
    }
  })

  it('omits inherited settings for Codex teammates when sanitized helper-only settings are empty', () => {
    const originalManagedByHost =
      process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST
    const originalAuthMode = process.env.CLAUDE_TEAM_ANTHROPIC_AUTH_MODE
    const originalSettingsPath =
      process.env.CLAUDE_TEAM_ANTHROPIC_API_KEY_HELPER_SETTINGS_PATH
    const originalFlagSettingsPath = getFlagSettingsPath()
    const originalFlagSettingsInline = getFlagSettingsInline()
    const helperDir = '/tmp/team-runtime-auth/helper-only/runs/run-1'
    const inheritedAnthropicSettingsPath = `${helperDir}/runtime-settings-anthropic.json`

    process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1'
    process.env.CLAUDE_TEAM_ANTHROPIC_AUTH_MODE = 'api_key_helper'
    process.env.CLAUDE_TEAM_ANTHROPIC_API_KEY_HELPER_SETTINGS_PATH =
      `${helperDir}/settings.json`
    setFlagSettingsPath(inheritedAnthropicSettingsPath)
    setFlagSettingsInline({
      apiKeyHelper: "'/tmp/helper.sh'",
      awsCredentialExport: '/tmp/aws.sh',
      awsAuthRefresh: '/tmp/aws-refresh.sh',
      gcpAuthRefresh: '/tmp/gcp-refresh.sh',
    })

    try {
      const flags = buildInheritedCliFlags({ provider: 'codex' })

      expect(flags).not.toContain('--settings')
      expect(flags).not.toContain(inheritedAnthropicSettingsPath)
      expect(flags).not.toContain('apiKeyHelper')
      expect(flags).not.toContain('awsCredentialExport')
      expect(flags).not.toContain('awsAuthRefresh')
      expect(flags).not.toContain('gcpAuthRefresh')
    } finally {
      setFlagSettingsPath(originalFlagSettingsPath)
      setFlagSettingsInline(originalFlagSettingsInline)
      if (originalManagedByHost === undefined) {
        delete process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST
      } else {
        process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST =
          originalManagedByHost
      }
      if (originalAuthMode === undefined) {
        delete process.env.CLAUDE_TEAM_ANTHROPIC_AUTH_MODE
      } else {
        process.env.CLAUDE_TEAM_ANTHROPIC_AUTH_MODE = originalAuthMode
      }
      if (originalSettingsPath === undefined) {
        delete process.env.CLAUDE_TEAM_ANTHROPIC_API_KEY_HELPER_SETTINGS_PATH
      } else {
        process.env.CLAUDE_TEAM_ANTHROPIC_API_KEY_HELPER_SETTINGS_PATH =
          originalSettingsPath
      }
    }
  })

  it('passes sanitized inline settings for app-managed Desktop runtime settings paths', () => {
    const originalAppManagedRuntimePath =
      process.env.CLAUDE_TEAM_RUNTIME_SETTINGS_PATH
    const originalFlagSettingsPath = getFlagSettingsPath()
    const originalFlagSettingsInline = getFlagSettingsInline()
    const settingsPath =
      '/var/folders/agent-teams-runtime-settings/mixed/run/runtime-settings-anthropic.json'

    process.env.CLAUDE_TEAM_RUNTIME_SETTINGS_PATH = settingsPath
    setFlagSettingsPath(`/private${settingsPath}`)
    setFlagSettingsInline({
      apiKeyHelper: "'/tmp/helper.sh'",
      awsCredentialExport: '/tmp/aws.sh',
      awsAuthRefresh: '/tmp/aws-refresh.sh',
      gcpAuthRefresh: '/tmp/gcp-refresh.sh',
      codex: {
        forced_login_method: 'chatgpt',
        agent_teams_workspace_trust: {
          config_overrides: [
            'projects."/tmp/project".trust_level="trusted"',
          ],
        },
      },
    })

    try {
      const flags = buildInheritedCliFlags({ provider: 'codex' })

      expect(flags).toContain('--settings')
      expect(flags).toContain('forced_login_method')
      expect(flags).toContain('chatgpt')
      expect(flags).toContain('agent_teams_workspace_trust')
      expect(flags).not.toContain(settingsPath)
      expect(flags).not.toContain(`/private${settingsPath}`)
      expect(flags).not.toContain('apiKeyHelper')
      expect(flags).not.toContain('awsCredentialExport')
      expect(flags).not.toContain('awsAuthRefresh')
      expect(flags).not.toContain('gcpAuthRefresh')
    } finally {
      setFlagSettingsPath(originalFlagSettingsPath)
      setFlagSettingsInline(originalFlagSettingsInline)
      if (originalAppManagedRuntimePath === undefined) {
        delete process.env.CLAUDE_TEAM_RUNTIME_SETTINGS_PATH
      } else {
        process.env.CLAUDE_TEAM_RUNTIME_SETTINGS_PATH =
          originalAppManagedRuntimePath
      }
    }
  })

  it('keeps custom path-based inherited settings authoritative for Codex teammates', () => {
    const originalFlagSettingsPath = getFlagSettingsPath()
    const originalFlagSettingsInline = getFlagSettingsInline()

    setFlagSettingsPath('/tmp/user-custom-settings.json')
    setFlagSettingsInline({
      codex: {
        forced_login_method: 'chatgpt',
      },
    })

    try {
      const flags = buildInheritedCliFlags({ provider: 'codex' })

      expect(flags).toContain('--settings /tmp/user-custom-settings.json')
      expect(flags).not.toContain('forced_login_method')
      expect(flags).not.toContain('chatgpt')
    } finally {
      setFlagSettingsPath(originalFlagSettingsPath)
      setFlagSettingsInline(originalFlagSettingsInline)
    }
  })

  it('passes sanitized inline Gemini settings while keeping GCP refresh settings', () => {
    const originalManagedByHost =
      process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST
    const originalAuthMode = process.env.CLAUDE_TEAM_ANTHROPIC_AUTH_MODE
    const originalSettingsPath =
      process.env.CLAUDE_TEAM_ANTHROPIC_API_KEY_HELPER_SETTINGS_PATH
    const originalFlagSettingsPath = getFlagSettingsPath()
    const originalFlagSettingsInline = getFlagSettingsInline()
    const helperDir = '/tmp/team-runtime-auth/gemini/runs/run-1'
    const inheritedAnthropicSettingsPath = `${helperDir}/runtime-settings-anthropic.json`

    process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1'
    process.env.CLAUDE_TEAM_ANTHROPIC_AUTH_MODE = 'api_key_helper'
    process.env.CLAUDE_TEAM_ANTHROPIC_API_KEY_HELPER_SETTINGS_PATH =
      `${helperDir}/settings.json`
    setFlagSettingsPath(inheritedAnthropicSettingsPath)
    setFlagSettingsInline({
      apiKeyHelper: "'/tmp/helper.sh'",
      awsCredentialExport: '/tmp/aws.sh',
      awsAuthRefresh: '/tmp/aws-refresh.sh',
      gcpAuthRefresh: '/tmp/gcp-refresh.sh',
      gemini: {
        runtime: 'vertex',
      },
    })

    try {
      const flags = buildInheritedCliFlags({ provider: 'gemini' })

      expect(flags).toContain('--settings')
      expect(flags).toContain('gcpAuthRefresh')
      expect(flags).toContain('/tmp/gcp-refresh.sh')
      expect(flags).toContain('gemini')
      expect(flags).toContain('vertex')
      expect(flags).not.toContain(inheritedAnthropicSettingsPath)
      expect(flags).not.toContain('apiKeyHelper')
      expect(flags).not.toContain('awsCredentialExport')
      expect(flags).not.toContain('awsAuthRefresh')
    } finally {
      setFlagSettingsPath(originalFlagSettingsPath)
      setFlagSettingsInline(originalFlagSettingsInline)
      if (originalManagedByHost === undefined) {
        delete process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST
      } else {
        process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST =
          originalManagedByHost
      }
      if (originalAuthMode === undefined) {
        delete process.env.CLAUDE_TEAM_ANTHROPIC_AUTH_MODE
      } else {
        process.env.CLAUDE_TEAM_ANTHROPIC_AUTH_MODE = originalAuthMode
      }
      if (originalSettingsPath === undefined) {
        delete process.env.CLAUDE_TEAM_ANTHROPIC_API_KEY_HELPER_SETTINGS_PATH
      } else {
        process.env.CLAUDE_TEAM_ANTHROPIC_API_KEY_HELPER_SETTINGS_PATH =
          originalSettingsPath
      }
    }
  })

  it('keeps Anthropic inherited inline settings unscoped for Anthropic teammates', () => {
    const originalFlagSettingsPath = getFlagSettingsPath()
    const originalFlagSettingsInline = getFlagSettingsInline()

    setFlagSettingsPath(null)
    setFlagSettingsInline({
      apiKeyHelper: "'/tmp/helper.sh'",
      awsCredentialExport: '/tmp/aws.sh',
      anthropic: {
        safe: true,
      },
    })

    try {
      const flags = buildInheritedCliFlags({ provider: 'anthropic' })

      expect(flags).toContain('--settings')
      expect(flags).toContain('apiKeyHelper')
      expect(flags).toContain('awsCredentialExport')
      expect(flags).toContain('anthropic')
      expect(flags).toContain('safe')
    } finally {
      setFlagSettingsPath(originalFlagSettingsPath)
      setFlagSettingsInline(originalFlagSettingsInline)
    }
  })

  it('merges inherited settings with app-managed Anthropic helper settings into one child settings file', async () => {
    const originalManagedByHost =
      process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST
    const originalAuthMode = process.env.CLAUDE_TEAM_ANTHROPIC_AUTH_MODE
    const originalSettingsPath =
      process.env.CLAUDE_TEAM_ANTHROPIC_API_KEY_HELPER_SETTINGS_PATH
    const tempDir = await mkdtemp(join(tmpdir(), 'anthropic-helper-settings-'))
    const inheritedSettingsPath = join(tempDir, 'inherited.json')
    const helperSettingsPath = join(tempDir, 'helper.json')

    await writeFile(
      inheritedSettingsPath,
      JSON.stringify({
        hooks: {
          Stop: [
            {
              matcher: '',
              hooks: [{ type: 'command', command: '/bin/sh inherited-stop.sh' }],
            },
          ],
        },
        codex: { forced_login_method: 'chatgpt' },
      }),
    )
    await writeFile(
      helperSettingsPath,
      JSON.stringify({
        apiKeyHelper: "'/tmp/team-runtime-auth/demo/helper.sh'",
      }),
    )

    process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1'
    process.env.CLAUDE_TEAM_ANTHROPIC_AUTH_MODE = 'api_key_helper'
    process.env.CLAUDE_TEAM_ANTHROPIC_API_KEY_HELPER_SETTINGS_PATH =
      helperSettingsPath

    try {
      const flag = buildAppManagedAnthropicApiKeyHelperSettingsFlag(
        'anthropic',
        inheritedSettingsPath,
      )
      expect(flag).toContain('--settings')
      expect(flag).not.toContain(inheritedSettingsPath)

      const outputPath = flag!
        .replace(/^--settings\s+/, '')
        .replace(/^'/, '')
        .replace(/'$/, '')
      const merged = JSON.parse(await readFile(outputPath, 'utf8'))

      expect(merged.apiKeyHelper).toBe("'/tmp/team-runtime-auth/demo/helper.sh'")
      expect(merged.codex.forced_login_method).toBe('chatgpt')
      expect(merged.hooks.Stop).toHaveLength(1)
    } finally {
      await rm(tempDir, { recursive: true, force: true })

      if (originalManagedByHost === undefined) {
        delete process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST
      } else {
        process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST =
          originalManagedByHost
      }

      if (originalAuthMode === undefined) {
        delete process.env.CLAUDE_TEAM_ANTHROPIC_AUTH_MODE
      } else {
        process.env.CLAUDE_TEAM_ANTHROPIC_AUTH_MODE = originalAuthMode
      }

      if (originalSettingsPath === undefined) {
        delete process.env.CLAUDE_TEAM_ANTHROPIC_API_KEY_HELPER_SETTINGS_PATH
      } else {
        process.env.CLAUDE_TEAM_ANTHROPIC_API_KEY_HELPER_SETTINGS_PATH =
          originalSettingsPath
      }
    }
  })

  it('blanks unapproved Anthropic API keys for non-host-managed teammates', () => {
    const originalApiKey = process.env.ANTHROPIC_API_KEY
    const originalManagedByHost =
      process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST
    const originalEntryProvider = process.env.CLAUDE_CODE_ENTRY_PROVIDER

    process.env.ANTHROPIC_API_KEY = 'sk-ant-new-local-teammate'
    delete process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST
    delete process.env.CLAUDE_CODE_ENTRY_PROVIDER

    try {
      const env = buildInheritedEnvVars({ provider: 'anthropic' })

      expect(env).toContain("ANTHROPIC_API_KEY=''")
      expect(env).not.toContain('ANTHROPIC_API_KEY=sk-ant-new-local-teammate')
    } finally {
      if (originalApiKey === undefined) {
        delete process.env.ANTHROPIC_API_KEY
      } else {
        process.env.ANTHROPIC_API_KEY = originalApiKey
      }

      if (originalManagedByHost === undefined) {
        delete process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST
      } else {
        process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST =
          originalManagedByHost
      }

      if (originalEntryProvider === undefined) {
        delete process.env.CLAUDE_CODE_ENTRY_PROVIDER
      } else {
        process.env.CLAUDE_CODE_ENTRY_PROVIDER = originalEntryProvider
      }
    }
  })

  it('forwards runtime turn-settled spool env vars to tmux teammates', () => {
    const originalSpoolRoot =
      process.env.AGENT_TEAMS_RUNTIME_TURN_SETTLED_SPOOL_ROOT

    process.env.AGENT_TEAMS_RUNTIME_TURN_SETTLED_SPOOL_ROOT =
      '/tmp/agent-teams-runtime-hooks'

    try {
      const env = buildInheritedEnvVars({ provider: 'codex' })

      expect(env).toContain(
        'AGENT_TEAMS_RUNTIME_TURN_SETTLED_SPOOL_ROOT=/tmp/agent-teams-runtime-hooks',
      )
    } finally {
      if (originalSpoolRoot === undefined) {
        delete process.env.AGENT_TEAMS_RUNTIME_TURN_SETTLED_SPOOL_ROOT
      } else {
        process.env.AGENT_TEAMS_RUNTIME_TURN_SETTLED_SPOOL_ROOT =
          originalSpoolRoot
      }
    }
  })

  it('forwards the test consume-hold path to tmux teammates', () => {
    const originalHold = process.env.CLAUDE_WORK_SYNC_TEST_HOLD_CONSUME_PATH
    process.env.CLAUDE_WORK_SYNC_TEST_HOLD_CONSUME_PATH = '/tmp/HOLD_CONSUME'
    try {
      const env = buildInheritedEnvVars({ provider: 'codex' })
      expect(env).toContain(
        'CLAUDE_WORK_SYNC_TEST_HOLD_CONSUME_PATH=/tmp/HOLD_CONSUME',
      )
    } finally {
      if (originalHold === undefined) {
        delete process.env.CLAUDE_WORK_SYNC_TEST_HOLD_CONSUME_PATH
      } else {
        process.env.CLAUDE_WORK_SYNC_TEST_HOLD_CONSUME_PATH = originalHold
      }
    }
  })

  it('clears Codex API key env vars for ChatGPT-auth codex teammates', () => {
    const originalApiKey = process.env.OPENAI_API_KEY
    const originalCodexApiKey = process.env.CODEX_API_KEY
    const originalCodexHome = process.env.CODEX_HOME
    const originalCodexCliPath = process.env.CODEX_CLI_PATH
    const originalRuntimeSettingsPath =
      process.env.CLAUDE_TEAM_RUNTIME_SETTINGS_PATH
    const originalEntryProvider = process.env.CLAUDE_CODE_ENTRY_PROVIDER
    const originalSettingsInline = getFlagSettingsInline()

    process.env.OPENAI_API_KEY = 'sk-openai-teammate'
    process.env.CODEX_API_KEY = 'sk-codex-teammate'
    process.env.CODEX_HOME = '/tmp/codex-connected-home'
    process.env.CODEX_CLI_PATH = '/tmp/codex-bin'
    process.env.CLAUDE_TEAM_RUNTIME_SETTINGS_PATH =
      '/tmp/runtime-settings-anthropic.json'
    process.env.CLAUDE_CODE_ENTRY_PROVIDER = 'codex'
    setFlagSettingsInline({
      codex: {
        forced_login_method: 'chatgpt',
      },
    })

    try {
      expect(shouldClearCodexApiKeysForTeammateSpawn('codex')).toBe(true)

      const env = buildInheritedEnvVars({ provider: 'codex' })

      expect(env).toContain("OPENAI_API_KEY=''")
      expect(env).toContain("CODEX_API_KEY=''")
      expect(env).toContain('CODEX_HOME=/tmp/codex-connected-home')
      expect(env).toContain('CODEX_CLI_PATH=/tmp/codex-bin')
      expect(env).toContain(
        'CLAUDE_TEAM_RUNTIME_SETTINGS_PATH=/tmp/runtime-settings-anthropic.json',
      )
      expect(env).not.toContain('OPENAI_API_KEY=sk-openai-teammate')
      expect(env).not.toContain('CODEX_API_KEY=sk-codex-teammate')
    } finally {
      if (originalApiKey === undefined) {
        delete process.env.OPENAI_API_KEY
      } else {
        process.env.OPENAI_API_KEY = originalApiKey
      }

      if (originalCodexApiKey === undefined) {
        delete process.env.CODEX_API_KEY
      } else {
        process.env.CODEX_API_KEY = originalCodexApiKey
      }

      if (originalCodexHome === undefined) {
        delete process.env.CODEX_HOME
      } else {
        process.env.CODEX_HOME = originalCodexHome
      }

      if (originalCodexCliPath === undefined) {
        delete process.env.CODEX_CLI_PATH
      } else {
        process.env.CODEX_CLI_PATH = originalCodexCliPath
      }

      if (originalRuntimeSettingsPath === undefined) {
        delete process.env.CLAUDE_TEAM_RUNTIME_SETTINGS_PATH
      } else {
        process.env.CLAUDE_TEAM_RUNTIME_SETTINGS_PATH =
          originalRuntimeSettingsPath
      }

      if (originalEntryProvider === undefined) {
        delete process.env.CLAUDE_CODE_ENTRY_PROVIDER
      } else {
        process.env.CLAUDE_CODE_ENTRY_PROVIDER = originalEntryProvider
      }

      setFlagSettingsInline(originalSettingsInline)
    }
  })

  it('forwards ANTHROPIC_AUTH_TOKEN for anthropic teammate overrides', () => {
    const originalToken = process.env.ANTHROPIC_AUTH_TOKEN

    process.env.ANTHROPIC_AUTH_TOKEN = 'anthropic-proxy-token'

    try {
      const env = buildInheritedEnvVars({ provider: 'anthropic' })

      expect(env).toContain('ANTHROPIC_AUTH_TOKEN=anthropic-proxy-token')
    } finally {
      if (originalToken === undefined) {
        delete process.env.ANTHROPIC_AUTH_TOKEN
      } else {
        process.env.ANTHROPIC_AUTH_TOKEN = originalToken
      }
    }
  })

  it('does not forward ANTHROPIC_AUTH_TOKEN for codex teammate overrides', () => {
    const originalToken = process.env.ANTHROPIC_AUTH_TOKEN

    process.env.ANTHROPIC_AUTH_TOKEN = 'anthropic-proxy-token'

    try {
      const env = buildInheritedEnvVars({ provider: 'codex' })

      expect(env).not.toContain('ANTHROPIC_AUTH_TOKEN=anthropic-proxy-token')
    } finally {
      if (originalToken === undefined) {
        delete process.env.ANTHROPIC_AUTH_TOKEN
      } else {
        process.env.ANTHROPIC_AUTH_TOKEN = originalToken
      }
    }
  })

  it('forwards ANTHROPIC_AUTH_TOKEN when inheriting an anthropic host provider', () => {
    const originalToken = process.env.ANTHROPIC_AUTH_TOKEN
    const originalEntryProvider = process.env.CLAUDE_CODE_ENTRY_PROVIDER

    process.env.ANTHROPIC_AUTH_TOKEN = 'anthropic-proxy-token'
    process.env.CLAUDE_CODE_ENTRY_PROVIDER = 'anthropic'

    try {
      const env = buildInheritedEnvVars()

      expect(env).toContain('ANTHROPIC_AUTH_TOKEN=anthropic-proxy-token')
    } finally {
      if (originalToken === undefined) {
        delete process.env.ANTHROPIC_AUTH_TOKEN
      } else {
        process.env.ANTHROPIC_AUTH_TOKEN = originalToken
      }

      if (originalEntryProvider === undefined) {
        delete process.env.CLAUDE_CODE_ENTRY_PROVIDER
      } else {
        process.env.CLAUDE_CODE_ENTRY_PROVIDER = originalEntryProvider
      }
    }
  })

  it('does not forward ANTHROPIC_AUTH_TOKEN when inheriting a codex host provider', () => {
    const originalToken = process.env.ANTHROPIC_AUTH_TOKEN
    const originalEntryProvider = process.env.CLAUDE_CODE_ENTRY_PROVIDER

    process.env.ANTHROPIC_AUTH_TOKEN = 'anthropic-proxy-token'
    process.env.CLAUDE_CODE_ENTRY_PROVIDER = 'codex'

    try {
      const env = buildInheritedEnvVars()

      expect(env).not.toContain('ANTHROPIC_AUTH_TOKEN=anthropic-proxy-token')
    } finally {
      if (originalToken === undefined) {
        delete process.env.ANTHROPIC_AUTH_TOKEN
      } else {
        process.env.ANTHROPIC_AUTH_TOKEN = originalToken
      }

      if (originalEntryProvider === undefined) {
        delete process.env.CLAUDE_CODE_ENTRY_PROVIDER
      } else {
        process.env.CLAUDE_CODE_ENTRY_PROVIDER = originalEntryProvider
      }
    }
  })
})

describe('per-member spawn customizations', () => {
  const CUSTOM_PROVIDER_OVERRIDES = [
    'model_provider="agent_teams_custom"',
    'model_providers.agent_teams_custom.name="Agent Teams Custom"',
    'model_providers.agent_teams_custom.wire_api="responses"',
    'model_providers.agent_teams_custom.env_key="CODEX_API_KEY"',
    'model_providers.agent_teams_custom.base_url="https://member.example/v1"',
  ]
  const CANONICAL_CUSTOM_PROVIDER_OVERRIDES = [
    'model_provider="agent_teams_custom"',
    'model_providers.agent_teams_custom.name="Agent Teams Custom"',
    'model_providers.agent_teams_custom.base_url="https://member.example/v1"',
    'model_providers.agent_teams_custom.wire_api="responses"',
    'model_providers.agent_teams_custom.env_key="CODEX_API_KEY"',
  ]

  function roundTripSettings(flags: string): Record<string, unknown> {
    const argv = parseArguments(flags)
    const merged = mergeJsonObjectCliFlagValues(
      eagerParseCliFlags('--settings', argv),
    )
    expect(merged).toBeTruthy()
    return JSON.parse(merged!) as Record<string, unknown>
  }

  it('applies the member env patch after all inherited auth transformations', () => {
    const keys = ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY'] as const
    const original = new Map(keys.map(key => [key, process.env[key]]))

    try {
      process.env.ANTHROPIC_AUTH_TOKEN = 'parent-token'
      process.env.ANTHROPIC_BASE_URL = 'https://parent.example'
      process.env.ANTHROPIC_API_KEY = 'parent-key'

      // Without the patch, the parent's auth token is inherited.
      expect(buildInheritedEnvObject({ provider: 'anthropic' })).toHaveProperty(
        'ANTHROPIC_AUTH_TOKEN',
        'parent-token',
      )

      const env = buildInheritedEnvObject({
        provider: 'anthropic',
        finalEnvPatch: {
          ANTHROPIC_AUTH_TOKEN: 'member-token',
          ANTHROPIC_BASE_URL: 'https://member.example',
        },
      })

      expect(env.ANTHROPIC_AUTH_TOKEN).toBe('member-token')
      expect(env.ANTHROPIC_BASE_URL).toBe('https://member.example')
      expect(env.ANTHROPIC_API_KEY).toBe('')

      const envVars = buildInheritedEnvVars({
        provider: 'anthropic',
        finalEnvPatch: {
          ANTHROPIC_AUTH_TOKEN: 'member-token',
          ANTHROPIC_BASE_URL: 'https://member.example',
        },
      })
      expect(envVars).toContain('ANTHROPIC_AUTH_TOKEN=member-token')
      expect(envVars).toContain('ANTHROPIC_BASE_URL=https\\://member.example')
      expect(envVars).not.toContain('ANTHROPIC_AUTH_TOKEN=parent-token')
    } finally {
      for (const key of keys) {
        const value = original.get(key)
        if (value === undefined) {
          delete process.env[key]
        } else {
          process.env[key] = value
        }
      }
    }
  })

  it('blanks the competing ANTHROPIC_API_KEY inside the final member env patch', () => {
    const envVars: Record<string, string> = {
      ANTHROPIC_API_KEY: 'parent-key',
      ANTHROPIC_AUTH_TOKEN: 'parent-token',
    }

    applyFinalMemberEnvPatch(envVars, {
      ANTHROPIC_AUTH_TOKEN: 'member-token',
      ANTHROPIC_BASE_URL: 'https://member.example',
    })

    expect(envVars.ANTHROPIC_AUTH_TOKEN).toBe('member-token')
    expect(envVars.ANTHROPIC_BASE_URL).toBe('https://member.example')
    expect(envVars.ANTHROPIC_API_KEY).toBe('')

    // The contracted explicit clear also survives the final layer.
    const explicitKey: Record<string, string> = {}
    applyFinalMemberEnvPatch(explicitKey, {
      ANTHROPIC_AUTH_TOKEN: 'member-token',
      ANTHROPIC_API_KEY: '',
    })
    expect(explicitKey.ANTHROPIC_API_KEY).toBe('')

    // No ANTHROPIC_AUTH_TOKEN in the patch means no implicit blanking.
    const withoutToken: Record<string, string> = {
      ANTHROPIC_API_KEY: 'parent-key',
    }
    applyFinalMemberEnvPatch(withoutToken, {
      ANTHROPIC_BASE_URL: 'https://member.example',
    })
    expect(withoutToken.ANTHROPIC_API_KEY).toBe('parent-key')
  })

  it('rejects unsafe member env patches before changing the spawn environment', () => {
    const env = { ANTHROPIC_AUTH_TOKEN: 'parent-token' }
    expect(() => applyFinalMemberEnvPatch(env, {
      ANTHROPIC_AUTH_TOKEN: 'member-token',
      NODE_OPTIONS: '--import=/tmp/untrusted.js',
    } as never)).toThrow('invalid per-member gateway environment patch')
    expect(env).toEqual({ ANTHROPIC_AUTH_TOKEN: 'parent-token' })
    expect(() => applyFinalMemberEnvPatch(env, {
      ANTHROPIC_API_KEY: 'competing-key',
    })).toThrow('invalid per-member gateway environment patch')
  })

  it('pins per-member forced Codex login to api without clearing Codex keys', () => {
    const originalApiKey = process.env.OPENAI_API_KEY
    const originalCodexApiKey = process.env.CODEX_API_KEY
    const originalSettingsInline = getFlagSettingsInline()

    process.env.OPENAI_API_KEY = 'sk-openai-teammate'
    process.env.CODEX_API_KEY = 'sk-codex-teammate'
    // Lead-level forced login stays on chatgpt.
    setFlagSettingsInline({
      codex: {
        forced_login_method: 'chatgpt',
      },
    })

    try {
      expect(shouldClearCodexApiKeysForTeammateSpawn('codex')).toBe(true)
      expect(shouldClearCodexApiKeysForTeammateSpawn('codex', 'api')).toBe(false)

      const env = buildInheritedEnvObject({
        provider: 'codex',
        forcedCodexLoginMethod: 'api',
      })
      expect(env[CODEX_FORCED_LOGIN_METHOD_ENV_VAR]).toBe('api')
      expect(env.CODEX_API_KEY).toBe('sk-codex-teammate')
      expect(env.OPENAI_API_KEY).toBe('sk-openai-teammate')

      const envVars = buildInheritedEnvVars({
        provider: 'codex',
        forcedCodexLoginMethod: 'api',
      })
      expect(envVars).toContain('CLAUDE_CODE_CODEX_FORCED_LOGIN_METHOD=api')
      expect(envVars).toContain('CODEX_API_KEY=sk-codex-teammate')
      expect(envVars).toContain('OPENAI_API_KEY=sk-openai-teammate')

      // Members without a per-member override still follow the lead's chatgpt
      // forced login and get the Codex keys cleared.
      const leadScopedEnvVars = buildInheritedEnvVars({ provider: 'codex' })
      expect(leadScopedEnvVars).toContain("CODEX_API_KEY=''")
      expect(leadScopedEnvVars).toContain("OPENAI_API_KEY=''")
      expect(leadScopedEnvVars).not.toContain(
        'CLAUDE_CODE_CODEX_FORCED_LOGIN_METHOD=api',
      )
    } finally {
      if (originalApiKey === undefined) {
        delete process.env.OPENAI_API_KEY
      } else {
        process.env.OPENAI_API_KEY = originalApiKey
      }
      if (originalCodexApiKey === undefined) {
        delete process.env.CODEX_API_KEY
      } else {
        process.env.CODEX_API_KEY = originalCodexApiKey
      }
      setFlagSettingsInline(originalSettingsInline)
    }
  })

  it('round-trips member Codex overrides through the child --settings parser', () => {
    const originalSettingsInline = getFlagSettingsInline()
    setFlagSettingsInline(null)

    try {
      const flags = buildInheritedCliFlags({
        provider: 'codex',
        memberCodex: {
          configOverrides: [...CUSTOM_PROVIDER_OVERRIDES],
          forcedLoginMethod: 'api',
        },
      })

      const settingsInline = roundTripSettings(flags)
      expect((settingsInline.codex as Record<string, unknown>)?.forced_login_method).toBe('api')

      // Both the -c form strings and the inline --settings JSON form
      // round-trip through the existing child-side parser unchanged.
      expect(
        buildCodexNativeCustomProviderConfigOverrides({ settingsInline }),
      ).toEqual(CANONICAL_CUSTOM_PROVIDER_OVERRIDES)
    } finally {
      setFlagSettingsInline(originalSettingsInline)
    }
  })

  it('replaces lead codex settings wholesale for members with Codex overrides', () => {
    const originalSettingsInline = getFlagSettingsInline()
    setFlagSettingsInline({
      apiKeyHelper: "'/tmp/helper.sh'",
      codex: {
        forced_login_method: 'chatgpt',
        agent_teams_workspace_trust: {
          config_overrides: ['projects."/tmp/project".trust_level="trusted"'],
        },
      },
    })

    try {
      const flags = buildInheritedCliFlags({
        provider: 'codex',
        memberCodex: {
          configOverrides: [...CUSTOM_PROVIDER_OVERRIDES],
          forcedLoginMethod: 'api',
        },
      })

      const settingsInline = roundTripSettings(flags)
      const codex = settingsInline.codex as Record<string, unknown>
      expect(codex?.forced_login_method).toBe('api')
      // The lead's codex namespace is never reused for gateway members.
      expect(codex).not.toHaveProperty('agent_teams_workspace_trust')
      expect(
        (
          codex?.agent_teams_custom_provider as {
            config_overrides: string[]
          }
        )?.config_overrides,
      ).toEqual(CUSTOM_PROVIDER_OVERRIDES)
    } finally {
      setFlagSettingsInline(originalSettingsInline)
    }
  })

  it('merges member Codex overrides into an inherited settings file path', async () => {
    const originalSettingsPath = getFlagSettingsPath()
    const tempRoot = await mkdtemp(join(tmpdir(), 'member-settings-merge-'))

    try {
      const basePath = join(tempRoot, 'inherited-settings.json')
      await writeFile(
        basePath,
        JSON.stringify({
          model: 'opus',
          codex: {
            forced_login_method: 'chatgpt',
            agent_teams_workspace_trust: {
              config_overrides: ['projects."/tmp/project".trust_level="trusted"'],
            },
          },
        }),
        'utf8',
      )
      setFlagSettingsPath(basePath)

      const flags = buildInheritedCliFlags({
        provider: 'codex',
        memberCodex: {
          configOverrides: [...CUSTOM_PROVIDER_OVERRIDES],
          forcedLoginMethod: 'api',
        },
      })

      const argv = parseArguments(flags)
      const settingsValues = eagerParseCliFlags('--settings', argv)
      expect(settingsValues).toHaveLength(1)
      expect(settingsValues[0]).not.toBe(basePath)

      const merged = JSON.parse(await readFile(settingsValues[0]!, 'utf8')) as Record<
        string,
        unknown
      >
      expect(merged.model).toBe('opus')
      const codex = merged.codex as Record<string, unknown>
      expect(codex?.forced_login_method).toBe('api')
      expect(codex).not.toHaveProperty('agent_teams_workspace_trust')
      expect(
        (codex?.agent_teams_custom_provider as { config_overrides: string[] })
          ?.config_overrides,
      ).toEqual(CUSTOM_PROVIDER_OVERRIDES)
    } finally {
      setFlagSettingsPath(originalSettingsPath)
      await rm(tempRoot, { recursive: true, force: true })
    }
  })

  it('materializes identical merged member settings to a stable content-hashed path', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'member-settings-hash-'))

    try {
      const basePath = join(tempRoot, 'inherited-settings.json')
      await writeFile(basePath, JSON.stringify({ model: 'opus' }), 'utf8')

      const fragment = buildMemberCodexSettingsFragment({
        configOverrides: [...CUSTOM_PROVIDER_OVERRIDES],
        forcedLoginMethod: 'api',
      })
      expect(fragment).toEqual({
        codex: {
          forced_login_method: 'api',
          agent_teams_custom_provider: {
            config_overrides: CUSTOM_PROVIDER_OVERRIDES,
          },
        },
      })

      const first = materializeMergedMemberSettingsFile(basePath, fragment!)
      const second = materializeMergedMemberSettingsFile(basePath, fragment!)
      expect(first).toBeTruthy()
      expect(second).toBe(first)

      const merged = JSON.parse(await readFile(first!, 'utf8')) as Record<string, unknown>
      expect(merged.model).toBe('opus')
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
    }
  })
})
