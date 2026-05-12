import { describe, expect, test } from 'bun:test'

describe('runtime backend registry with agent_teams capabilities', () => {
  test('anthropic runtime status treats Bedrock as external runtime auth', async () => {
    const envKeys = [
      'ANTHROPIC_AWS_WORKSPACE_ID',
      'AWS_PROFILE',
      'AWS_REGION',
      'CLAUDE_CODE_ENTRY_PROVIDER',
      'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
      'CLAUDE_CODE_USE_BEDROCK',
    ] as const
    const originalEnv = new Map<string, string | undefined>(
      envKeys.map(key => [key, process.env[key]]),
    )

    process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1'
    process.env.CLAUDE_CODE_ENTRY_PROVIDER = 'anthropic'
    process.env.CLAUDE_CODE_USE_BEDROCK = '1'
    process.env.ANTHROPIC_AWS_WORKSPACE_ID = 'wrkspc_should_not_win'
    process.env.AWS_PROFILE = 'cc'
    process.env.AWS_REGION = 'us-east-1'

    try {
      const registryModulePath = new URL('./registry.js', import.meta.url).href
      const { getUnifiedRuntimeStatusPayload } = await import(
        `${registryModulePath}?test=${Math.random().toString(36).slice(2)}`
      )

      const payload = await getUnifiedRuntimeStatusPayload('anthropic')
      const anthropic = payload.providers.anthropic

      expect(anthropic?.authenticated).toBe(true)
      expect(anthropic?.authMethod).toBe('aws_credentials')
      expect(anthropic?.canLoginFromUi).toBe(false)
      expect(anthropic?.selectedBackendId).toBe('bedrock')
      expect(anthropic?.resolvedBackendId).toBe('bedrock')
      expect(anthropic?.backend).toMatchObject({
        kind: 'bedrock',
        label: 'Amazon Bedrock',
        endpointLabel: 'AWS region us-east-1',
        authMethodDetail: 'aws_credentials',
      })
      expect(anthropic?.statusMessage).toBe('Configured for Amazon Bedrock')
      expect(anthropic?.subscriptionRateLimits).toBeNull()
    } finally {
      for (const key of envKeys) {
        const value = originalEnv.get(key)
        if (value === undefined) {
          delete process.env[key]
        } else {
          process.env[key] = value
        }
      }
    }
  })

  test('anthropic runtime status detects Claude Platform on AWS without prompting login', async () => {
    const envKeys = [
      'ANTHROPIC_AWS_API_KEY',
      'ANTHROPIC_AWS_WORKSPACE_ID',
      'AWS_DEFAULT_REGION',
      'AWS_REGION',
      'CLAUDE_CODE_ENTRY_PROVIDER',
      'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
      'CLAUDE_CODE_USE_BEDROCK',
    ] as const
    const originalEnv = new Map<string, string | undefined>(
      envKeys.map(key => [key, process.env[key]]),
    )

    process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1'
    process.env.CLAUDE_CODE_ENTRY_PROVIDER = 'claude-platform-aws'
    process.env.ANTHROPIC_AWS_WORKSPACE_ID = 'wrkspc_123'
    process.env.AWS_REGION = 'us-west-2'
    delete process.env.ANTHROPIC_AWS_API_KEY
    delete process.env.AWS_DEFAULT_REGION
    delete process.env.CLAUDE_CODE_USE_BEDROCK

    try {
      const registryModulePath = new URL('./registry.js', import.meta.url).href
      const { getUnifiedRuntimeStatusPayload } = await import(
        `${registryModulePath}?test=${Math.random().toString(36).slice(2)}`
      )

      const payload = await getUnifiedRuntimeStatusPayload('anthropic')
      const anthropic = payload.providers.anthropic

      expect(anthropic?.authenticated).toBe(false)
      expect(anthropic?.authMethod).toBe('aws_platform_sigv4_transport_unavailable')
      expect(anthropic?.canLoginFromUi).toBe(false)
      expect(anthropic?.selectedBackendId).toBe('claude-platform-aws')
      expect(anthropic?.resolvedBackendId).toBe('claude-platform-aws')
      expect(anthropic?.backend).toMatchObject({
        kind: 'claude-platform-aws',
        label: 'Claude Platform on AWS',
        endpointLabel: 'AWS region us-west-2',
        projectId: 'wrkspc_123',
        authMethodDetail: 'aws_platform_sigv4_transport_unavailable',
      })
      expect(anthropic?.statusMessage).toBe(
        'Claude Platform on AWS transport is not enabled',
      )
      expect(anthropic?.detailMessage).toContain('AnthropicAws request transport')
      expect(anthropic?.subscriptionRateLimits).toBeNull()
    } finally {
      for (const key of envKeys) {
        const value = originalEnv.get(key)
        if (value === undefined) {
          delete process.env[key]
        } else {
          process.env[key] = value
        }
      }
    }
  })

  test('anthropic runtime status detects Claude Platform on AWS API key env', async () => {
    const envKeys = [
      'ANTHROPIC_AWS_API_KEY',
      'ANTHROPIC_AWS_WORKSPACE_ID',
      'AWS_DEFAULT_REGION',
      'AWS_REGION',
      'CLAUDE_CODE_ENTRY_PROVIDER',
      'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
      'CLAUDE_CODE_USE_BEDROCK',
    ] as const
    const originalEnv = new Map<string, string | undefined>(
      envKeys.map(key => [key, process.env[key]]),
    )

    process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1'
    process.env.CLAUDE_CODE_ENTRY_PROVIDER = 'claude-platform-aws'
    process.env.ANTHROPIC_AWS_WORKSPACE_ID = 'wrkspc_123'
    process.env.ANTHROPIC_AWS_API_KEY = 'aws-platform-key'
    process.env.AWS_DEFAULT_REGION = 'us-east-2'
    delete process.env.AWS_REGION
    delete process.env.CLAUDE_CODE_USE_BEDROCK

    try {
      const registryModulePath = new URL('./registry.js', import.meta.url).href
      const { getUnifiedRuntimeStatusPayload } = await import(
        `${registryModulePath}?test=${Math.random().toString(36).slice(2)}`
      )

      const payload = await getUnifiedRuntimeStatusPayload('anthropic')
      const anthropic = payload.providers.anthropic

      expect(anthropic?.authenticated).toBe(false)
      expect(anthropic?.authMethod).toBe('aws_platform_api_key_transport_unavailable')
      expect(anthropic?.backend).toMatchObject({
        kind: 'claude-platform-aws',
        endpointLabel: 'AWS region us-east-2',
        authMethodDetail: 'aws_platform_api_key_transport_unavailable',
      })
    } finally {
      for (const key of envKeys) {
        const value = originalEnv.get(key)
        if (value === undefined) {
          delete process.env[key]
        } else {
          process.env[key] = value
        }
      }
    }
  })

  test('anthropic runtime status reports missing Claude Platform on AWS region without prompting login', async () => {
    const envKeys = [
      'ANTHROPIC_AWS_WORKSPACE_ID',
      'AWS_DEFAULT_REGION',
      'AWS_REGION',
      'CLAUDE_CODE_ENTRY_PROVIDER',
      'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
      'CLAUDE_CODE_USE_BEDROCK',
    ] as const
    const originalEnv = new Map<string, string | undefined>(
      envKeys.map(key => [key, process.env[key]]),
    )

    process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1'
    process.env.CLAUDE_CODE_ENTRY_PROVIDER = 'claude-platform-aws'
    process.env.ANTHROPIC_AWS_WORKSPACE_ID = 'wrkspc_123'
    delete process.env.AWS_DEFAULT_REGION
    delete process.env.AWS_REGION
    delete process.env.CLAUDE_CODE_USE_BEDROCK

    try {
      const registryModulePath = new URL('./registry.js', import.meta.url).href
      const { getUnifiedRuntimeStatusPayload } = await import(
        `${registryModulePath}?test=${Math.random().toString(36).slice(2)}`
      )

      const payload = await getUnifiedRuntimeStatusPayload('anthropic')
      const anthropic = payload.providers.anthropic

      expect(anthropic?.authenticated).toBe(false)
      expect(anthropic?.canLoginFromUi).toBe(false)
      expect(anthropic?.selectedBackendId).toBe('claude-platform-aws')
      expect(anthropic?.backend).toMatchObject({
        kind: 'claude-platform-aws',
        label: 'Claude Platform on AWS',
        endpointLabel: 'AWS region not configured',
        projectId: 'wrkspc_123',
        authMethodDetail: 'aws_platform_configuration_incomplete',
      })
      expect(anthropic?.statusMessage).toContain('AWS_REGION')
      expect(anthropic?.detailMessage).toContain('AWS_REGION')
    } finally {
      for (const key of envKeys) {
        const value = originalEnv.get(key)
        if (value === undefined) {
          delete process.env[key]
        } else {
          process.env[key] = value
        }
      }
    }
  })

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

      const payload = await getUnifiedRuntimeStatusPayload('codex', {
        getCodexModelCatalog: async () => ({
          schemaVersion: 1,
          providerId: 'codex',
          source: 'app-server',
          status: 'ready',
          fetchedAt: '2026-04-28T00:00:00.000Z',
          staleAt: '2026-04-28T00:10:00.000Z',
          defaultModelId: 'gpt-5.4',
          defaultLaunchModel: 'gpt-5.4',
          models: [
            {
              id: 'gpt-5.4',
              launchModel: 'gpt-5.4',
              displayName: 'GPT-5.4',
              hidden: false,
              supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
              defaultReasoningEffort: 'medium',
              inputModalities: ['text', 'image'],
              supportsPersonality: false,
              supportsFastMode: true,
              isDefault: true,
              upgrade: false,
              source: 'app-server',
            },
            {
              id: 'gpt-5.5',
              launchModel: 'gpt-5.5',
              displayName: 'GPT-5.5',
              hidden: false,
              supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
              defaultReasoningEffort: 'high',
              inputModalities: ['text', 'image'],
              supportsPersonality: false,
              supportsFastMode: false,
              isDefault: false,
              upgrade: false,
              source: 'app-server',
            },
            {
              id: 'gpt-5.3-codex',
              launchModel: 'gpt-5.3-codex',
              displayName: 'GPT-5.3 Codex',
              hidden: false,
              supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
              defaultReasoningEffort: 'medium',
              inputModalities: ['text', 'image'],
              supportsPersonality: false,
              supportsFastMode: false,
              isDefault: false,
              upgrade: false,
              source: 'app-server',
            },
          ],
          diagnostics: {
            configReadState: 'skipped',
            appServerState: 'healthy',
            message: null,
            code: null,
          },
        }),
      })
      const codex = payload.providers.codex

      expect(payload.schemaVersion).toBe(2)
      expect(codex?.models).toContain('gpt-5.3-codex')
      expect(codex?.models).toContain('gpt-5.5')
      expect(codex?.modelCatalog?.source).toBe('app-server')
      expect(codex?.selectedBackendId).toBe('codex-native')
      expect(codex?.resolvedBackendId).toBe('codex-native')
      expect(codex?.capabilities.extensions.mcp.status).toBe('supported')
      expect(codex?.capabilities.extensions.mcp.ownership).toBe('shared')
      expect(codex?.capabilities.extensions.plugins.status).toBe('unsupported')
      expect(codex?.capabilities.extensions.plugins.reason).toContain('codex-native')
      expect(codex?.runtimeCapabilities).toEqual({
        modelCatalog: {
          dynamic: true,
          source: 'app-server',
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

  test(
    'opencode runtime status surfaces managed inventory safely',
    async () => {
      const registryModulePath = new URL('./registry.js', import.meta.url).href
      const { getUnifiedRuntimeStatusPayload } = await import(
        `${registryModulePath}?test=${Math.random().toString(36).slice(2)}`
      )

      const payload = await getUnifiedRuntimeStatusPayload('opencode', {
        getOpenCodeInventorySnapshot: async () => ({
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
          models: ['opencode/big-pickle', 'openai/gpt-5.4', 'openai/gpt-5.4-mini'],
          modelMetadata: [
            {
              id: 'opencode/big-pickle',
              cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
              context: 200000,
              limits: { context: 200000, output: 128000 },
              free: true,
              raw: {
                cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
                limit: { context: 200000, output: 128000 },
              },
            },
            {
              id: 'openai/gpt-5.4',
              cost: { input: 1.25, output: 10 },
              context: 1050000,
              limits: { context: 1050000 },
              free: false,
              raw: { cost: { input: 1.25, output: 10 }, limit: { context: 1050000 } },
            },
          ],
          agents: [
            { id: 'build', mode: 'primary' },
            { id: 'explore', mode: 'subagent' },
          ],
          authStorePath: '/tmp/profile/data/opencode/auth.json',
          probeError: null,
          diagnostics: [],
        }),
      })
      const opencode = payload.providers.opencode

      expect(payload.schemaVersion).toBe(2)
      expect(opencode?.providerId).toBe('opencode')
      expect(opencode?.supported).toBe(true)
      expect(opencode?.authenticated).toBe(true)
      expect(opencode?.models).toEqual([
        'opencode/big-pickle',
        'openai/gpt-5.4',
        'openai/gpt-5.4-mini',
      ])
      expect(
        opencode?.modelCatalog?.models.find(model => model.id === 'opencode/big-pickle')
          ?.badgeLabel,
      ).toBe('Free')
      expect(
        opencode?.modelCatalog?.models.find(model => model.id === 'opencode/big-pickle')
          ?.metadata,
      ).toEqual({
        cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
        context: 200000,
        limits: { context: 200000, output: 128000 },
        free: true,
      })
      expect(
        opencode?.modelCatalog?.models.find(model => model.id === 'openai/gpt-5.4')
          ?.badgeLabel,
      ).toBeNull()
      expect(opencode?.capabilities.teamLaunch).toBe(true)
      expect(opencode?.capabilities.extensions.plugins.status).toBe('read-only')
      expect(opencode?.backend?.kind).toBe('opencode-cli')
      expect(opencode?.capabilitiesInfo?.some((item) => item.id === 'managed-profile')).toBe(true)
    },
    15_000,
  )
})
