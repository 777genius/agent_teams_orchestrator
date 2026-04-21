import { describe, expect, it } from 'bun:test'

import {
  buildInheritedEnvVars,
  shouldClearAnthropicApiKeyForTeammateSpawn,
} from './spawnUtils.js'

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
