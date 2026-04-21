import { describe, expect, test } from 'bun:test'

describe('runtime backend registry with agent_teams capabilities', () => {
  test('codex runtime status exposes native-only provider-aware extension capabilities', async () => {
    const originalCodexBackend = process.env.CLAUDE_CODE_CODEX_BACKEND
    const originalCodexApiKey = process.env.CODEX_API_KEY
    const originalWhich = Bun.which
    process.env.CLAUDE_CODE_CODEX_BACKEND = 'codex-native'
    process.env.CODEX_API_KEY = 'sk-native-test'
    Bun.which = ((binaryName: string) => {
      if (binaryName === 'codex') {
        return '/usr/local/bin/codex'
      }
      return originalWhich(binaryName)
    }) as typeof Bun.which

    try {
      const registryModulePath = new URL('./registry.js', import.meta.url).href
      const { getUnifiedRuntimeStatusPayload } = await import(
        `${registryModulePath}?test=${Math.random().toString(36).slice(2)}`
      )

      const payload = await getUnifiedRuntimeStatusPayload('codex')
      const codex = payload.providers.codex

      expect(payload.schemaVersion).toBe(2)
      expect(codex?.models).toContain('gpt-5.3-codex')
      expect(codex?.selectedBackendId).toBe('codex-native')
      expect(codex?.resolvedBackendId).toBe('codex-native')
      expect(codex?.capabilities.extensions.mcp.status).toBe('supported')
      expect(codex?.capabilities.extensions.mcp.ownership).toBe('shared')
      expect(codex?.capabilities.extensions.plugins.status).toBe('unsupported')
      expect(codex?.capabilities.extensions.plugins.reason).toContain('codex-native')
      expect(codex?.runtimeCapabilities).toEqual({
        modelCatalog: {
          dynamic: true,
          source: 'runtime',
        },
        reasoningEffort: {
          supported: true,
          values: ['minimal', 'low', 'medium', 'high', 'xhigh'],
          configPassthrough: true,
        },
      })
      expect(codex?.backend).toMatchObject({
        kind: 'codex-native',
        label: 'Codex native',
        endpointLabel: 'codex exec --json',
        authMethodDetail: 'api_key',
      })
      expect(codex?.availableBackends).toHaveLength(1)
      expect(codex?.availableBackends[0]).toMatchObject({
        id: 'codex-native',
        selectable: true,
        available: true,
        state: 'ready',
        audience: 'general',
        statusMessage: 'Ready',
      })
    } finally {
      if (originalCodexBackend === undefined) {
        delete process.env.CLAUDE_CODE_CODEX_BACKEND
      } else {
        process.env.CLAUDE_CODE_CODEX_BACKEND = originalCodexBackend
      }
      if (originalCodexApiKey === undefined) {
        delete process.env.CODEX_API_KEY
      } else {
        process.env.CODEX_API_KEY = originalCodexApiKey
      }
      Bun.which = originalWhich
    }
  })

  test('opencode runtime status surfaces managed inventory safely', async () => {
    const inventoryServicePath = new URL('../opencode/OpenCodeInventoryService.js', import.meta.url)
      .href
    const { openCodeInventoryService } = await import(inventoryServicePath)
    const originalProbe = openCodeInventoryService.probe.bind(openCodeInventoryService)

    openCodeInventoryService.probe = async () => ({
      detected: true,
      binaryPath: '/opt/homebrew/bin/opencode',
      version: '1.4.0',
      projectPath: '/tmp/project',
      profile: {
        projectPath: '/tmp/project',
        profileRootKey: 'abc123',
        profileRootPath: '/tmp/profile',
        projectBehaviorFingerprint: 'behavior-v1',
        behaviorSources: ['AGENTS.md', 'opencode.json'],
        homePath: '/tmp/profile/home',
        xdgConfigHome: '/tmp/profile/config',
        xdgDataHome: '/tmp/profile/data',
        xdgCacheHome: '/tmp/profile/cache',
        managedConfig: {
          default_agent: 'teammate',
          share: 'disabled',
          autoupdate: false,
          snapshot: false,
        },
        managedConfigFingerprint: 'managed-config-v1',
        managedAuthPath: '/tmp/profile/data/opencode/auth.json',
        sourceAuthPath: '/Users/test/.local/share/opencode/auth.json',
        sourceAuthFingerprint: 'source',
        managedAuthFingerprint: 'managed',
        authState: 'stale',
        env: {},
      },
      connectedProviders: [
        { id: 'openai', authHint: 'oauth', source: 'credentials' },
      ],
      availableProviders: ['openai', 'opencode'],
      models: ['openai/gpt-5.4', 'openai/gpt-5.4-mini'],
      agents: [
        { id: 'build', mode: 'primary' },
        { id: 'explore', mode: 'subagent' },
      ],
      authStorePath: '/tmp/profile/data/opencode/auth.json',
      probeError: null,
      diagnostics: [],
    })

    try {
      const registryModulePath = new URL('./registry.js', import.meta.url).href
      const { getUnifiedRuntimeStatusPayload } = await import(
        `${registryModulePath}?test=${Math.random().toString(36).slice(2)}`
      )

      const payload = await getUnifiedRuntimeStatusPayload('opencode')
      const opencode = payload.providers.opencode

      expect(payload.schemaVersion).toBe(2)
      expect(opencode?.providerId).toBe('opencode')
      expect(opencode?.supported).toBe(true)
      expect(opencode?.authenticated).toBe(true)
      expect(opencode?.models).toEqual(['openai/gpt-5.4', 'openai/gpt-5.4-mini'])
      expect(opencode?.capabilities.teamLaunch).toBe(false)
      expect(opencode?.capabilities.extensions.plugins.status).toBe('read-only')
      expect(opencode?.backend?.kind).toBe('opencode-cli')
      expect(opencode?.capabilitiesInfo?.some((item) => item.id === 'managed-profile')).toBe(true)
    } finally {
      openCodeInventoryService.probe = originalProbe
    }
  })
})
