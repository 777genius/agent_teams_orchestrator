import { effectiveAgentsFixture } from './OpenCodeEffectiveAgents.test-support.js'
import { describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { openCodeClientFactory } from './OpenCodeClientFactory.js'
import { resolveClaudeMultimodelPaths } from './OpenCodeManagedPaths.js'
import { OpenCodeRuntimeDeadlineError, type OpenCodeProvisioningStage } from './OpenCodeRuntimeDeadline.js'

import { OPEN_CODE_PREFLIGHT_HOST_LEASE_TEAM_ID } from './OpenCodeHostManager.js'
import {
  buildManagedConfigFingerprint,
  OpenCodeProfileManager,
  resolveOpenCodeProfileScope,
} from './OpenCodeProfileManager.js'
import { OpenCodeProvisioningProbe, type OpenCodeAuthorityRejection } from './OpenCodeProvisioningProbe.js'
import { buildOpenCodeExpectedBehaviorEvidence } from './OpenCodeExpectedBehaviorFingerprint.js'
import {
  removeOpenCodeAuthCredential,
  upsertOpenCodeAuthCredential,
} from './OpenCodeAuthStore.js'

import type {
  OpenCodeConfigProvidersResponse,
  OpenCodeConfigResponse,
  OpenCodeHostHandle,
  OpenCodeInventorySnapshot,
  OpenCodePreparedProfile,
  OpenCodeProviderAuthMethod,
  OpenCodeProviderResponse,
} from './types.js'

const profile: OpenCodePreparedProfile = {
  projectPath: '/tmp/project',
  canonicalProjectPath: '/tmp/project',
  workingDirectoryPath: '/tmp/project',
  scopeToken: null,
  profileRootKey: 'profile-root',
  profileRootPath: '/tmp/profile-root',
  projectBehaviorFingerprint: 'behavior-v1',
  behaviorSources: ['AGENTS.md', 'opencode.json'],
  managedConfig: {
    default_agent: 'teammate',
    share: 'disabled',
    autoupdate: false,
    snapshot: true,
  },
  managedConfigFingerprint: 'managed-config-v1',
  homePath: '/tmp/profile-root/home',
  tmpPath: '/tmp/profile-root/tmp',
  xdgConfigHome: '/tmp/profile-root/config',
  xdgDataHome: '/tmp/profile-root/data',
  xdgCacheHome: '/tmp/profile-root/cache',
  managedAuthPath: '/tmp/profile-root/data/opencode/auth.json',
  sourceAuthPath: '/Users/test/.local/share/opencode/auth.json',
  sourceAuthFingerprint: 'source-auth',
  managedAuthFingerprint: 'managed-auth',
  authState: 'ok',
  env: {},
}

const inventory: OpenCodeInventorySnapshot = {
  detected: true,
  binaryPath: '/opt/homebrew/bin/opencode',
  version: '1.4.0',
  projectPath: '/tmp/project',
  profile,
  connectedProviders: [{ id: 'openai', authHint: 'oauth', source: 'credentials' }],
  availableProviders: ['openai'],
  models: ['openai/gpt-5.4-mini'],
  agents: [{ id: 'teammate', mode: 'primary' }],
  authStorePath: profile.managedAuthPath,
  probeError: null,
  diagnostics: [],
}

const host: OpenCodeHostHandle = {
  hostKey: 'host-key',
  profileRootKey: 'profile-root',
  projectPath: '/tmp/project',
  projectBehaviorFingerprint: 'behavior-v1',
  baseUrl: 'http://127.0.0.1:4096',
  port: 4096,
  pid: 123,
  version: '1.4.0',
  state: 'healthy',
  profile,
  resolvedConfigFingerprint: 'resolved-fingerprint',
  diagnostics: [],
}

describe('OpenCodeProvisioningProbe', () => {
  test('keeps authority rejection fail-closed even if the diagnostic observer throws', async () => {
    const probe = new OpenCodeProvisioningProbe()
    for (const [selectedModel, check] of [
      ['unqualified', 'selected_model'], ['deepinfra/chosen', 'profile_scope'],
    ] as const) {
      let reported: OpenCodeAuthorityRejection | undefined
      expect(await probe.refreshSelectedProfileAuthority({
        host, selectedModel, expectedBehaviorFingerprint: 'unused',
        onRejection: diagnostic => {
          reported = diagnostic
          throw new Error('observer-secret')
        },
      })).toBeNull()
      expect(reported).toEqual({ check })
    }
  })

  for (const selectedModel of [
    'deepinfra/chosen', 'custom-provider/nested/model',
  ]) {
    test(`keeps strict ${selectedModel} provisioning selected-provider scoped`, async () => {
      const authorityEnvName = selectedModel.startsWith('deepinfra/')
        ? 'DEEPINFRA_API_KEY'
        : 'CUSTOM_PROVIDER_API_KEY'
      const previousAuthority = process.env[authorityEnvName]
      const previousMcpCommand = process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND
      const previousMcpArgs = process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ARGS_JSON
      process.env[authorityEnvName] = 'focused-test-static-authority'
      process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND = process.execPath
      process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ARGS_JSON = JSON.stringify([
        '-e', 'process.stdin.resume()',
      ])
      try {
      const commandLog: string[] = []
      const stages: OpenCodeProvisioningStage[] = []
      let inventoryInput: Record<string, unknown> | null = null
      let ensureInput: Record<string, unknown> | null = null
      const mcpUrls: string[] = []
      const releasedHosts: string[] = []
      let prepared: OpenCodePreparedProfile | null = null
      let retainedHost: OpenCodeHostHandle | null = null
      const probe = new OpenCodeProvisioningProbe({
        inventoryService: {
          probe: async (projectPath, options) => {
            inventoryInput = options
            const scope = options.profileScope!
            prepared = {
              ...profile, projectPath: projectPath!, canonicalProjectPath: projectPath!,
              scopeToken: scope.scopeToken, profileScope: scope, managedConfig: {},
              managedConfigFingerprint: buildManagedConfigFingerprint({}),
              selectedSourceAuthIdentity: scope.selectedAuthIdentity,
              selectedManagedAuthIdentity: scope.selectedAuthIdentity,
              authState: 'ok',
            }
            return {
              ...inventory, projectPath: projectPath!, profile: prepared,
              connectedProviders: [], availableProviders: [], models: [], agents: [],
            }
          },
        },
        hostManager: {
          ensureHost: async input => {
            ensureInput = input
            const preparedProfile = input.preparedProfile!
            retainedHost = {
              ...host, projectPath: preparedProfile.projectPath,
              profileRootKey: preparedProfile.profileRootKey, profile: preparedProfile,
              resolvedConfigFingerprint: preparedProfile.managedConfigFingerprint,
            }
            return retainedHost
          },
          retainHostLease: async () => {},
          releaseHostLease: async () => {},
          releaseHost: async hostKey => { releasedHosts.push(hostKey) },
          refreshResolvedConfigFingerprint: async () => { throw new Error('broad refresh') },
        },
        clientFactory: { create: () => { throw new Error('broad live client') } },
        mcpManager: {
          ensureAppMcp: async input => {
            mcpUrls.push(input.baseUrl)
            return {
              mcp: { 'agent-teams': { connected: true } },
              summary: {
                serverName: 'agent-teams', matchedServerName: 'agent-teams',
                status: 'present' as const, connected: true, launchSource: null,
                availableServerNames: ['agent-teams'], diagnostics: [],
              },
            }
          },
        },
      })

      const retained = await probe.probeRetainingHost('/tmp/project', {
        selectedModel, leaseId: 'lease-scoped',
        phaseContext: {
          phase: 'host_start', signal: new AbortController().signal,
          remainingMs: () => 10_000, throwIfExpired: () => {},
          reportProvisioningStage: stage => { stages.push(stage) },
        },
      })
      expect(stages).toEqual([
        'profile_scope', 'inventory', 'ensure_host', 'retain_lease',
        'host_operation_wait', 'host_inspect', 'app_mcp', 'host_finalize',
      ])
      expect(inventoryInput).toEqual(expect.objectContaining({
        mode: 'profile',
        profileScope: expect.objectContaining({
          purpose: 'launch_runtime',
          providerId: selectedModel.slice(0, selectedModel.indexOf('/')),
        }),
      }))
      expect(ensureInput).toEqual(expect.objectContaining({
        preparedProfile: prepared,
        prewarmManagedSubscriptionPlugins: false,
        resolveConfigFingerprint: false,
      }))
      expect(mcpUrls).toEqual([retainedHost!.baseUrl])
      expect(commandLog).toEqual([])
      await retained.release()
      expect(releasedHosts).toEqual([retainedHost!.hostKey])
      } finally {
        if (previousAuthority === undefined) delete process.env[authorityEnvName]
        else process.env[authorityEnvName] = previousAuthority
        if (previousMcpCommand === undefined) {
          delete process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND
        } else process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND = previousMcpCommand
        if (previousMcpArgs === undefined) {
          delete process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ARGS_JSON
        } else process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ARGS_JSON = previousMcpArgs
      }
    })
  }

  // This integration matrix performs many filesystem authority refreshes. On Windows,
  // the default 5 s can expire before finally restores the process-wide fixture env.
  test('refreshes selected config/project/auth/MCP authority and fails closed on each mutation', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-selected-refresh-'))
    const keys = [
      'HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
      'CLAUDE_MULTIMODEL_DATA_HOME', 'CLAUDE_MULTIMODEL_CACHE_HOME',
      'CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND',
      'CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY',
      'CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ARGS_JSON',
      'CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENV_JSON',
      'CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL',
      'OPENCODE_CONFIG_CONTENT', 'SELECTED_ROUTE_AUTHORITY', 'DEEPINFRA_API_KEY',
    ] as const
    const original = Object.fromEntries(keys.map(key => [key, process.env[key]]))
    try {
      const projectPath = path.join(tempDir, 'project')
      const mcpEntry = path.join(tempDir, 'fake-mcp.js')
      await mkdir(projectPath, { recursive: true })
      await writeFile(path.join(projectPath, 'AGENTS.md'), 'stable behavior')
      await writeFile(mcpEntry, 'process.stdin.resume()')
      process.env.HOME = path.join(tempDir, 'home')
      process.env.USERPROFILE = process.env.HOME
      process.env.XDG_CONFIG_HOME = path.join(tempDir, 'config')
      process.env.XDG_DATA_HOME = path.join(tempDir, 'data')
      process.env.CLAUDE_MULTIMODEL_DATA_HOME = path.join(tempDir, 'app-data')
      process.env.CLAUDE_MULTIMODEL_CACHE_HOME = path.join(tempDir, 'app-cache')
      process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND = process.execPath
      process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY = mcpEntry
      process.env.SELECTED_ROUTE_AUTHORITY = 'route-one'
      process.env.DEEPINFRA_API_KEY = 'focused-test-static-authority'
      process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
        provider: { deepinfra: {
          options: { route: '{env:SELECTED_ROUTE_AUTHORITY}' },
          models: { chosen: {
            name: 'Chosen', structured_output: true,
            limit: { context: 200_000, output: 65_536 },
          } },
        } },
      })
      const scope = await resolveOpenCodeProfileScope({
        projectPath, purpose: 'launch_runtime', selectedModel: 'deepinfra/chosen',
      })
      const prepared = await new OpenCodeProfileManager().prepareProfile(projectPath, {
        profileScope: scope,
      })
      const retainedHost = {
        ...host, projectPath, profileRootKey: prepared.profileRootKey, profile: prepared,
        resolvedConfigFingerprint: prepared.managedConfigFingerprint,
      }
      const livePrepared = () => JSON.parse(JSON.stringify(prepared.managedConfig)
        .replace(/\{env:([^}]+)\}/g, (_match, name: string) => prepared.env[name] || ''))
      let liveConfig = livePrepared()
      let connected = true
      let matchedServerName = 'agent-teams'
      let configError: unknown = null
      const probe = new OpenCodeProvisioningProbe({
        clientFactory: { create: () => ({ getConfig: async () => {
          if (configError) throw configError
          return liveConfig
        }, listAgents: async () => effectiveAgentsFixture(prepared.managedConfig, prepared.env.XDG_DATA_HOME) }) as never },
        mcpManager: { ensureAppMcp: async () => ({
          mcp: { 'agent-teams': { connected } },
          summary: {
            serverName: 'agent-teams', matchedServerName, status: 'present',
            connected, launchSource: null, availableServerNames: ['agent-teams'],
            diagnostics: [],
          },
        }) },
      })
      const evidence = await buildOpenCodeExpectedBehaviorEvidence({
        profile: prepared, fullModelId: 'deepinfra/chosen',
        effectiveConfigFingerprint: prepared.managedConfigFingerprint,
      })
      const diagnostics: OpenCodeAuthorityRejection[] = []
      const refresh = (contractConfigIdentity?: string) => probe.refreshSelectedProfileAuthority({
        host: retainedHost, selectedModel: 'deepinfra/chosen',
        expectedBehaviorFingerprint: evidence.expectedBehaviorFingerprint,
        contractConfigIdentity,
        onRejection: diagnostic => { diagnostics.push(diagnostic) },
      })

      const recomputedScope = await resolveOpenCodeProfileScope({
        projectPath, purpose: 'launch_runtime', selectedModel: 'deepinfra/chosen',
        env: prepared.env,
      })
      expect(prepared.appMcpLaunchSource).toBe('env-override')
      expect(recomputedScope).toEqual(scope)
      expect(await refresh()).not.toBeNull()
      expect(diagnostics).toEqual([])
      // Fixture follows OpenCode v1.18.4 core/src/v1/config/agent.ts normalize()
      // and packages/opencode/src/config/config.ts command initialization.
      const normalizedAgents = Object.fromEntries(Object.entries(
        prepared.managedConfig.agent as Record<string, Record<string, unknown>>,
      ).map(([name, agent]) => [name, { ...agent, options: {} }]))
      const normalizedLiveConfig = {
        ...livePrepared(), agent: normalizedAgents, command: {},
      }
      const preparedBeforeNormalization = structuredClone(prepared)
      liveConfig = normalizedLiveConfig
      const refreshedNormalized = await refresh()
      expect(refreshedNormalized).not.toBeNull()
      expect(prepared).toEqual(preparedBeforeNormalization)
      expect(await buildOpenCodeExpectedBehaviorEvidence({
        profile: refreshedNormalized!, fullModelId: 'deepinfra/chosen',
        effectiveConfigFingerprint: prepared.managedConfigFingerprint,
      })).toEqual(evidence)
      expect(diagnostics).toEqual([])
      // OpenCode drops model fields its config schema does not know (for example
      // structured_output) when serving GET /config; that alone must not reject.
      const liveProviders = structuredClone(
        (normalizedLiveConfig as Record<string, unknown>).provider,
      ) as Record<string, { models: Record<string, Record<string, unknown>> }>
      expect(liveProviders.deepinfra.models.chosen.structured_output).toBe(true)
      delete liveProviders.deepinfra.models.chosen.structured_output
      liveConfig = { ...normalizedLiveConfig, provider: liveProviders }
      expect(await refresh()).not.toBeNull()
      expect(diagnostics).toEqual([])
      const mutatedProviders = structuredClone(liveProviders)
      mutatedProviders.deepinfra.models.chosen.limit = { context: 1, output: 1 }
      liveConfig = { ...normalizedLiveConfig, provider: mutatedProviders }
      expect(await refresh()).toBeNull()
      expect(diagnostics.pop()).toEqual({ check: 'selected_config_match', fields: ['provider'] })
      for (const [field, value] of [
        ['command', { injected: { template: 'unexpected-command' } }],
        ['command', null],
        ['command', []],
        ['agent', { ...normalizedAgents, teammate: { ...normalizedAgents.teammate, options: { route: 'changed' } } }],
        ['agent', { ...normalizedAgents, teammate: { ...normalizedAgents.teammate, options: null } }],
        ['agent', { ...normalizedAgents, teammate: { ...normalizedAgents.teammate, permission: { '*': 'allow' } } }],
        ['agent', { ...normalizedAgents, teammate: { ...normalizedAgents.teammate, prompt: 'changed' } }],
        ['agent', { ...normalizedAgents, teammate: { ...normalizedAgents.teammate, unknown: 'changed' } }],
        ['agent', {}],
        ['agent', { ...normalizedAgents, teammate: null }],
      ] as const) {
        liveConfig = { ...normalizedLiveConfig, [field]: value }
        expect(await refresh()).toBeNull()
        expect(diagnostics.pop()).toEqual({ check: 'selected_config_match', fields: [field] })
      }
      liveConfig = livePrepared()
      matchedServerName = 'secret-server-name'
      expect(await refresh()).toBeNull()
      expect(diagnostics.pop()).toEqual({ check: 'mcp_name' })
      matchedServerName = 'agent-teams'
      expect(await refresh('secret-contract-identity')).toBeNull()
      expect(diagnostics.pop()).toEqual({ check: 'contract_config_match' })
      const configWithMcp = liveConfig
      liveConfig = { ...liveConfig, mcp: {} }
      expect(await refresh()).toBeNull()
      expect(diagnostics.pop()).toEqual({ check: 'live_mcp_present' })
      liveConfig = configWithMcp
      for (const error of [Object.assign(new TypeError('secret-auth-token'), {
        name: 'secret-provider-identity',
      }), 'secret-config-error']) {
        configError = error
        expect(await refresh()).toBeNull()
        expect(diagnostics.pop()).toEqual({
          check: 'exception', phase: 'live_config',
          errorClass: typeof error === 'string' ? 'non_error' : 'TypeError',
        })
      }
      configError = null
      for (const [field, check] of [
        ['scopeToken', 'scope_token_match'],
        ['configFingerprint', 'scope_config_match'],
        ['selectedAuthIdentity', 'selected_auth_identity_match'],
      ] as const) {
        const originalScope = retainedHost.profile.profileScope!
        retainedHost.profile.profileScope = { ...originalScope, [field]: 'secret-mutated-identity' }
        expect(await refresh()).toBeNull()
        expect(diagnostics.pop()).toEqual({ check })
        retainedHost.profile.profileScope = originalScope
      }
      const liveMcp = (liveConfig.mcp as Record<string, unknown>)['agent-teams']
      liveConfig = {
        ...liveConfig,
        mcp: {
          ...(liveConfig.mcp as object),
          'agent-teams': { ...liveMcp as object, url: 'https://mismatch.example/mcp' },
        },
      }
      expect(await refresh()).toBeNull()
      expect(diagnostics.pop()).toEqual({ check: 'mcp_config_match' })
      liveConfig = livePrepared()
      process.env.SELECTED_ROUTE_AUTHORITY = 'route-two'
      process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND = 'mutated-command'
      process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENV_JSON = JSON.stringify({ ROUTE: 'mutated' })
      process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL = 'https://mutated.example/mcp'
      expect(await refresh()).not.toBeNull()
      process.env.SELECTED_ROUTE_AUTHORITY = 'route-one'
      liveConfig = { ...liveConfig, permission: { poisoned: 'allow' } }
      expect(await refresh()).toBeNull()
      expect(diagnostics.pop()).toEqual({ check: 'selected_config_match', fields: ['permission'] })
      liveConfig = livePrepared()
      await writeFile(path.join(projectPath, 'AGENTS.md'), 'changed behavior')
      expect(await refresh()).toBeNull()
      expect(diagnostics.pop()).toMatchObject({ check: 'behavior_match', comparison: {
        initialEvidenceMatchesExpectation: false, projectBehaviorChanged: true,
        effectiveSelectedAuthChanged: null, otherEvidenceChanged: null,
        sourcesAvailable: true, changedSourceCount: 1,
        sources: [{ label: 'AGENTS.md', initial: 'present', refreshed: 'present' }],
      } })
      await writeFile(path.join(projectPath, 'AGENTS.md'), 'stable behavior')
      await upsertOpenCodeAuthCredential({
        authPath: prepared.managedAuthPath, providerId: 'deepinfra',
        credential: { type: 'api', key: 'mutated-secret' },
      })
      expect(await refresh()).toBeNull()
      await removeOpenCodeAuthCredential({
        authPath: prepared.managedAuthPath, providerId: 'deepinfra',
      })
      connected = false
      expect(await refresh()).toBeNull()
      expect(diagnostics.pop()).toEqual({ check: 'mcp_connected' })
    } finally {
      for (const key of keys) {
        if (original[key] === undefined) delete process.env[key]
        else process.env[key] = original[key]
      }
      await rm(tempDir, { recursive: true, force: true })
    }
  }, 20_000)

  for (const stage of ['startup', 'verification'] as const) {
    for (const code of ['ELOCKED', 'ECOMPROMISED'] as const) {
      test(`sanitizes ${code} provisioning ${stage} failure before snapshot strings`, async () => {
        const temp = await mkdtemp(path.join(os.tmpdir(), 'TEST-probe-lock-'))
        const savedDataHome = process.env.CLAUDE_MULTIMODEL_DATA_HOME
        process.env.CLAUDE_MULTIMODEL_DATA_HOME = temp
        try {
          const root = path.join(resolveClaudeMultimodelPaths().data, 'opencode')
          const file = path.join(root, 'profiles', 'SECRET-PROFILE', 'node_modules.prepare-lock')
          const failure = Object.assign(new Error(`SECRET-MESSAGE ${file} /private/auth.json`), {
            code, file, stack: 'SECRET-STACK', env: { TOKEN: 'SECRET-ENV' },
          })
          const fail = async () => { throw failure }
          let acquired = 0, released = 0, clients = 0
          const probe = new OpenCodeProvisioningProbe({
            inventoryService: { probe: async () => ({ ...inventory, diagnostics: ['Inventory warning'] }) },
            hostManager: {
              ensureHost: async () => { acquired++; if (stage === 'startup') throw failure; return host },
              releaseHost: async () => { released++ },
              refreshResolvedConfigFingerprint: async () => null,
            },
            clientFactory: { create: () => {
              clients++
              return { ...openCodeClientFactory.create(host.baseUrl), getConfig: fail,
                getConfigProviders: fail, getProviders: fail, getProviderAuth: fail, listAgents: fail }
            } },
          })
          const snapshot = await probe.probe('/tmp/project', { bypassCache: true })
          const message = `OpenCode lock operation failed [code=${code}, lock=profile]`
          expect(snapshot.hostHealthy).toBe(false)
          expect(snapshot.probeError).toBe(message)
          expect(snapshot.diagnostics).toEqual(['Inventory warning', message])
          expect(snapshot.host === null).toBe(stage === 'startup')
          expect(acquired).toBe(1)
          expect(released).toBe(stage === 'startup' ? 0 : 1)
          expect(clients).toBe(stage === 'startup' ? 0 : 1)
          for (const secret of ['SECRET-', root, file, '/private/auth.json', 'TOKEN']) {
            expect(JSON.stringify(snapshot)).not.toContain(secret)
          }
        } finally {
          if (savedDataHome === undefined) delete process.env.CLAUDE_MULTIMODEL_DATA_HOME
          else process.env.CLAUDE_MULTIMODEL_DATA_HOME = savedDataHome
          await rm(temp, { recursive: true, force: true })
        }
      })
    }
  }

  test('preserves provisioning deadline text ahead of lock metadata', async () => {
    const failure = Object.assign(new OpenCodeRuntimeDeadlineError('host_start', 50, 60), {
      code: 'ELOCKED', file: '/TEST/private/host-registry.json.lock',
    })
    const probe = new OpenCodeProvisioningProbe({
      inventoryService: { probe: async () => inventory },
      hostManager: {
        ensureHost: async () => { throw failure }, releaseHost: async () => {},
        refreshResolvedConfigFingerprint: async () => null,
      },
    })
    const snapshot = await probe.probe('/tmp/project', { bypassCache: true })
    expect(snapshot.probeError).toBe(failure.message)
    expect(snapshot.diagnostics).toEqual([failure.message])
    expect(JSON.stringify(snapshot)).not.toContain('lock=')
  })

  test('keeps inventory warnings diagnostic-only when host startup fails', async () => {
    const probe = new OpenCodeProvisioningProbe({
      inventoryService: {
        probe: async () => ({
          ...inventory,
          probeError: 'SuperGrok OAuth requires OpenCode 1.15.7 or newer; detected 1.15.6',
          diagnostics: [
            'SuperGrok OAuth requires OpenCode 1.15.7 or newer; detected 1.15.6',
          ],
        }),
      },
      hostManager: {
        ensureHost: async () => {
          throw new Error('OpenCode request timed out after 15000ms for /config')
        },
        releaseHost: async () => {},
      },
    })

    const snapshot = await probe.probe('/tmp/project')

    expect(snapshot.hostHealthy).toBe(false)
    expect(snapshot.probeError).toBe('OpenCode request timed out after 15000ms for /config')
    expect(snapshot.diagnostics).toEqual([
      'SuperGrok OAuth requires OpenCode 1.15.7 or newer; detected 1.15.6',
      'OpenCode request timed out after 15000ms for /config',
    ])
  })

  test.each([false, true])('releases acquired references when durable lease admission fails existing=%s', async existing => {
    const released: string[] = []
    const acquired = { hostKey: 'fixture-host', pid: 123, projectPath: '/tmp/project', profile } as OpenCodeHostHandle
    const probe = new OpenCodeProvisioningProbe({
      inventoryService: { probe: async () => inventory },
      hostManager: {
        ensureHost: async () => acquired,
        retainHostLease: async () => { throw new Error('fixture lease write rejected') },
        releaseHost: async key => { released.push(key) },
      },
    })
    const run = existing
      ? probe.probeRetainingHost('/tmp/project', { existingHostKey: 'fixture-host' })
      : probe.probe('/tmp/project')
    if (existing) await expect(run).rejects.toThrow('fixture lease write rejected')
    else expect((await run).host).toBeNull()
    expect(released).toEqual(['fixture-host'])
  })

  test.each(['operation-admission', 'configuration-abort'])('releases retained host and lease after %s rejects', async failure => {
    const controller = new AbortController()
    const releases: string[] = []
    const probe = new OpenCodeProvisioningProbe({
      inventoryService: { probe: async () => inventory },
      hostManager: {
        ensureHost: async () => host,
        retainHostLease: async () => {},
        releaseHostLease: async () => { releases.push('lease') },
        releaseHost: async () => { releases.push('host') },
        withHostOperation: async (_host, _owner, operation) => {
          if (failure === 'operation-admission') throw new Error('fixture operation rejected')
          return operation()
        },
      },
      clientFactory: { create: () => ({
        getConfig: async () => {
          controller.abort(new Error('fixture configuration cancelled'))
          throw controller.signal.reason
        },
        getConfigProviders: async () => ({}), getProviders: async () => ({}),
        getProviderAuth: async () => ({}), listAgents: async () => [],
      }) as never },
    })
    await expect(probe.probeRetainingHost('/tmp/project', {
      phaseContext: { phase: 'host_start', signal: controller.signal,
        remainingMs: () => 1000, throwIfExpired: () => {} },
    })).rejects.toThrow(failure === 'operation-admission' ? 'fixture operation rejected' : 'fixture configuration cancelled')
    expect(releases).toEqual(['lease', 'host'])
  })

  test('collects live host verification details', async () => {
    let releaseCalls = 0
    const retainedLeaseTeamIds: string[] = []
    const releasedLeaseTeamIds: string[] = []
    let createCalls = 0
    let refreshCalls = 0

    const probe = new OpenCodeProvisioningProbe({
      inventoryService: {
        probe: async () => ({
          ...inventory,
          connectedProviders: [
            ...inventory.connectedProviders,
            {
              id: 'Z.AI Coding Plan',
              authHint: 'api',
              source: 'credentials' as const,
            },
          ],
        }),
      },
      hostManager: {
        ensureHost: async () => host,
        refreshResolvedConfigFingerprint: async () => {
          refreshCalls += 1
          return 'resolved-fingerprint'
        },
        retainHostLease: async (_hostKey, input) => {
          retainedLeaseTeamIds.push(input.teamId)
        },
        releaseHostLease: async (_hostKey, input) => {
          releasedLeaseTeamIds.push(input.teamId)
        },
        releaseHost: async () => {
          releaseCalls += 1
        },
      },
      clientFactory: {
        create: () => {
          createCalls += 1
          return {
            getConfig: async () =>
              ({
                username: 'belief',
                plugin: [],
                agent: {},
                mode: {},
                command: {},
                default_agent: 'teammate',
                share: 'disabled',
                autoupdate: false,
                snapshot: true,
              }) satisfies OpenCodeConfigResponse,
            getConfigProviders: async () =>
              ({
                providers: [{ id: 'openai', name: 'OpenAI' }],
                default: { openai: 'gpt-5.4-mini' },
              }) satisfies OpenCodeConfigProvidersResponse,
            getProviders: async () =>
              ({
                all: [{ id: 'openai', name: 'OpenAI' }],
                default: { openai: 'gpt-5.4-mini' },
                connected: ['openai', 'zai-coding-plan'],
              }) satisfies OpenCodeProviderResponse,
            getProviderAuth: async () =>
              ({
                openai: [{ type: 'oauth', label: 'ChatGPT Pro/Plus (browser)' }],
              }) satisfies Record<string, OpenCodeProviderAuthMethod[]>,
            listAgents: async () => [{ name: 'teammate', mode: 'primary' }],
            getMcp: async () => ({ 'agent-teams': { connected: true } }),
            addMcp: async () => {
              throw new Error('not used')
            },
            createSession: async () => {
              throw new Error('not used')
            },
            getSession: async () => {
              throw new Error('not used')
            },
            getSessionStatus: async () => {
              throw new Error('not used')
            },
            getSessionMessages: async () => {
              throw new Error('not used')
            },
            getPermissions: async () => [],
            sendSessionMessage: async () => {
              throw new Error('not used')
            },
            promptSessionAsync: async () => {
              throw new Error('not used')
            },
            abortSession: async () => {
              throw new Error('not used')
            },
          }
        },
      },
      mcpManager: {
        ensureAppMcp: async () => ({
          mcp: {
            'agent-teams': { connected: true },
          },
          summary: {
            serverName: 'agent-teams',
            matchedServerName: 'agent-teams',
            status: 'present',
            connected: true,
            launchSource: null,
            availableServerNames: ['agent-teams'],
            diagnostics: [],
          },
        }),
      },
    })

    const snapshot = await probe.probe('/tmp/project')

    expect(snapshot.hostHealthy).toBe(true)
    expect(snapshot.config?.username).toBe('belief')
    expect(snapshot.providers?.connected).toEqual(['openai', 'zai-coding-plan'])
    expect(snapshot.diagnostics.some(item => item.includes('missing from live host'))).toBe(false)
    expect(snapshot.agents.map(agent => agent.name)).toEqual(['teammate'])
    expect(Object.keys(snapshot.mcp ?? {})).toEqual(['agent-teams'])
    expect(snapshot.appMcp?.status).toBe('present')
    expect(createCalls).toBe(1)
    expect(refreshCalls).toBe(1)
    expect(retainedLeaseTeamIds).toEqual([OPEN_CODE_PREFLIGHT_HOST_LEASE_TEAM_ID])
    expect(releasedLeaseTeamIds).toEqual([OPEN_CODE_PREFLIGHT_HOST_LEASE_TEAM_ID])
    expect(releaseCalls).toBe(1)
  })

  test('can release readiness lease without disposing the live host', async () => {
    let releaseCalls = 0
    const releasedLeaseTeamIds: string[] = []

    const probe = new OpenCodeProvisioningProbe({
      inventoryService: {
        probe: async () => inventory,
      },
      hostManager: {
        ensureHost: async () => host,
        refreshResolvedConfigFingerprint: async () => 'resolved-fingerprint',
        retainHostLease: async () => {},
        releaseHostLease: async (_hostKey, input) => {
          releasedLeaseTeamIds.push(input.teamId)
        },
        releaseHost: async () => {
          releaseCalls += 1
        },
      },
      clientFactory: {
        create: () => ({
          getConfig: async () =>
            ({
              username: 'belief',
              plugin: [],
              agent: {},
              mode: {},
              command: {},
              default_agent: 'teammate',
              share: 'disabled',
              autoupdate: false,
              snapshot: true,
            }) satisfies OpenCodeConfigResponse,
          getConfigProviders: async () =>
            ({
              providers: [{ id: 'openai', name: 'OpenAI' }],
              default: { openai: 'gpt-5.4-mini' },
            }) satisfies OpenCodeConfigProvidersResponse,
          getProviders: async () =>
            ({
              all: [{ id: 'openai', name: 'OpenAI' }],
              default: { openai: 'gpt-5.4-mini' },
              connected: ['openai'],
            }) satisfies OpenCodeProviderResponse,
          getProviderAuth: async () =>
            ({
              openai: [{ type: 'oauth', label: 'ChatGPT Pro/Plus (browser)' }],
            }) satisfies Record<string, OpenCodeProviderAuthMethod[]>,
          listAgents: async () => [{ name: 'teammate', mode: 'primary' }],
          getMcp: async () => ({ 'agent-teams': { connected: true } }),
          addMcp: async () => {
            throw new Error('not used')
          },
          createSession: async () => {
            throw new Error('not used')
          },
          getSession: async () => {
            throw new Error('not used')
          },
          getSessionStatus: async () => {
            throw new Error('not used')
          },
          getSessionMessages: async () => {
            throw new Error('not used')
          },
          getPermissions: async () => [],
          sendSessionMessage: async () => {
            throw new Error('not used')
          },
          promptSessionAsync: async () => {
            throw new Error('not used')
          },
          abortSession: async () => {
            throw new Error('not used')
          },
        }),
      },
      mcpManager: {
        ensureAppMcp: async () => ({
          mcp: {
            'agent-teams': { connected: true },
          },
          summary: {
            serverName: 'agent-teams',
            matchedServerName: 'agent-teams',
            status: 'present',
            connected: true,
            launchSource: null,
            availableServerNames: ['agent-teams'],
            diagnostics: [],
          },
        }),
      },
    })

    const snapshot = await probe.probe('/tmp/project', { disposeHostOnRelease: false })

    expect(snapshot.hostHealthy).toBe(true)
    expect(releasedLeaseTeamIds).toEqual([OPEN_CODE_PREFLIGHT_HOST_LEASE_TEAM_ID])
    expect(releaseCalls).toBe(0)
  })

  test('can retain the live host for launch session creation', async () => {
    let releaseCalls = 0
    const retainedLeaseTeamIds: string[] = []
    const releasedLeaseTeamIds: string[] = []
    const ensureHostInputs: unknown[] = []

    const probe = new OpenCodeProvisioningProbe({
      inventoryService: {
        probe: async () => inventory,
      },
      hostManager: {
        ensureHost: async (input) => {
          ensureHostInputs.push(input)
          return host
        },
        refreshResolvedConfigFingerprint: async () => 'resolved-fingerprint',
        retainHostLease: async (_hostKey, input) => {
          retainedLeaseTeamIds.push(input.teamId)
        },
        releaseHostLease: async (_hostKey, input) => {
          releasedLeaseTeamIds.push(input.teamId)
        },
        releaseHost: async () => {
          releaseCalls += 1
        },
      },
      clientFactory: {
        create: () => ({
          getConfig: async () =>
            ({
              username: 'belief',
              plugin: [],
              agent: {},
              mode: {},
              command: {},
              default_agent: 'teammate',
              share: 'disabled',
              autoupdate: false,
              snapshot: true,
            }) satisfies OpenCodeConfigResponse,
          getConfigProviders: async () =>
            ({
              providers: [{ id: 'openai', name: 'OpenAI' }],
              default: { openai: 'gpt-5.4-mini' },
            }) satisfies OpenCodeConfigProvidersResponse,
          getProviders: async () =>
            ({
              all: [{ id: 'openai', name: 'OpenAI' }],
              default: { openai: 'gpt-5.4-mini' },
              connected: ['openai'],
            }) satisfies OpenCodeProviderResponse,
          getProviderAuth: async () =>
            ({
              openai: [{ type: 'oauth', label: 'ChatGPT Pro/Plus (browser)' }],
            }) satisfies Record<string, OpenCodeProviderAuthMethod[]>,
          listAgents: async () => [{ name: 'teammate', mode: 'primary' }],
          getMcp: async () => ({ 'agent-teams': { connected: true } }),
          addMcp: async () => {
            throw new Error('not used')
          },
          createSession: async () => {
            throw new Error('not used')
          },
          getSession: async () => {
            throw new Error('not used')
          },
          getSessionStatus: async () => {
            throw new Error('not used')
          },
          getSessionMessages: async () => {
            throw new Error('not used')
          },
          getPermissions: async () => [],
          sendSessionMessage: async () => {
            throw new Error('not used')
          },
          promptSessionAsync: async () => {
            throw new Error('not used')
          },
          abortSession: async () => {
            throw new Error('not used')
          },
        }),
      },
      mcpManager: {
        ensureAppMcp: async () => ({
          mcp: {
            'agent-teams': { connected: true },
          },
          summary: {
            serverName: 'agent-teams',
            matchedServerName: 'agent-teams',
            status: 'present',
            connected: true,
            launchSource: null,
            availableServerNames: ['agent-teams'],
            diagnostics: [],
          },
        }),
      },
    })

    const retained = await probe.probeRetainingHost('/tmp/project')

    expect(retained.snapshot.hostHealthy).toBe(true)
    expect(ensureHostInputs).toEqual([
      expect.objectContaining({
        projectPath: '/tmp/project',
        preparedProfile: profile,
        hostLifetime: 'persistent',
      }),
    ])
    expect(retainedLeaseTeamIds).toEqual([OPEN_CODE_PREFLIGHT_HOST_LEASE_TEAM_ID])
    expect(releasedLeaseTeamIds).toEqual([])
    expect(releaseCalls).toBe(0)

    await retained.release()
    await retained.release()

    expect(releasedLeaseTeamIds).toEqual([OPEN_CODE_PREFLIGHT_HOST_LEASE_TEAM_ID])
    expect(releaseCalls).toBe(1)
  })

  test('surfaces provider mismatches between inventory and live host', async () => {
    const probe = new OpenCodeProvisioningProbe({
      inventoryService: {
        probe: async () => ({
          ...inventory,
          connectedProviders: [{ id: 'openai', authHint: 'oauth', source: 'credentials' }],
        }),
      },
      hostManager: {
        ensureHost: async () => host,
        refreshResolvedConfigFingerprint: async () => 'resolved-after-attach',
        releaseHost: async () => {},
      },
      clientFactory: {
        create: () => ({
          getConfig: async () => ({
            username: 'belief',
            default_agent: 'build',
            share: 'manual',
            autoupdate: true,
            snapshot: false,
          }),
          getConfigProviders: async () => ({ providers: [], default: {} }),
          getProviders: async () => ({ all: [], default: {}, connected: ['anthropic'] }),
          getProviderAuth: async () => ({}),
          listAgents: async () => [],
          getMcp: async () => ({}),
          addMcp: async () => {
            throw new Error('not used')
          },
          createSession: async () => {
            throw new Error('not used')
          },
          getSession: async () => {
            throw new Error('not used')
          },
          getSessionStatus: async () => {
            throw new Error('not used')
          },
          getSessionMessages: async () => {
            throw new Error('not used')
          },
          getPermissions: async () => [],
          sendSessionMessage: async () => {
            throw new Error('not used')
          },
          promptSessionAsync: async () => {
            throw new Error('not used')
          },
          abortSession: async () => {
            throw new Error('not used')
          },
        }),
      },
      mcpManager: {
        ensureAppMcp: async () => ({
          mcp: {},
          summary: {
            serverName: 'agent-teams',
            matchedServerName: null,
            status: 'attach_failed',
            connected: null,
            launchSource: 'workspace-dist',
            availableServerNames: [],
            diagnostics: ['agent-teams MCP attach failed'],
          },
        }),
      },
    })

    const snapshot = await probe.probe('/tmp/project')
    expect(snapshot.diagnostics.some(item => item.includes('missing from live host'))).toBe(true)
    expect(snapshot.providers?.connected).toEqual(['anthropic'])
    expect(snapshot.diagnostics.some(item => item.includes('Managed default agent mismatch'))).toBe(true)
    expect(snapshot.diagnostics.some(item => item.includes('Managed teammate primary agent is missing'))).toBe(true)
    expect(snapshot.diagnostics.some(item => item.includes('agent-teams MCP attach failed'))).toBe(true)
    expect(snapshot.appMcp?.status).toBe('attach_failed')
  })

  test('refreshes resolved host fingerprint after attaching the app MCP server', async () => {
    let refreshCalls = 0

    const probe = new OpenCodeProvisioningProbe({
      inventoryService: {
        probe: async () => inventory,
      },
      hostManager: {
        ensureHost: async () => ({ ...host, resolvedConfigFingerprint: 'before-attach' }),
        refreshResolvedConfigFingerprint: async () => {
          refreshCalls += 1
          return 'after-attach'
        },
        releaseHost: async () => {},
      },
      clientFactory: {
        create: () => ({
          getConfig: async () => ({
            default_agent: 'teammate',
            share: 'disabled',
            autoupdate: false,
            snapshot: true,
          }),
          getConfigProviders: async () => ({ providers: [], default: {} }),
          getProviders: async () => ({ all: [], default: {}, connected: ['openai'] }),
          getProviderAuth: async () => ({}),
          listAgents: async () => [{ name: 'teammate', mode: 'primary' }],
          getMcp: async () => ({}),
          addMcp: async () => {
            throw new Error('not used')
          },
          createSession: async () => {
            throw new Error('not used')
          },
          getSession: async () => {
            throw new Error('not used')
          },
          getSessionStatus: async () => {
            throw new Error('not used')
          },
          getSessionMessages: async () => {
            throw new Error('not used')
          },
          getPermissions: async () => [],
          sendSessionMessage: async () => {
            throw new Error('not used')
          },
          promptSessionAsync: async () => {
            throw new Error('not used')
          },
          abortSession: async () => {
            throw new Error('not used')
          },
        }),
      },
      mcpManager: {
        ensureAppMcp: async () => ({
          mcp: {
            'agent-teams': {
              connected: true,
            },
          },
          summary: {
            serverName: 'agent-teams',
            matchedServerName: 'agent-teams',
            status: 'attached',
            connected: true,
            launchSource: 'workspace-dist',
            availableServerNames: ['agent-teams'],
            diagnostics: [],
          },
        }),
      },
    })

    const snapshot = await probe.probe('/tmp/project')

    expect(refreshCalls).toBe(1)
    expect(snapshot.host?.resolvedConfigFingerprint).toBe('after-attach')
    expect(snapshot.appMcp?.status).toBe('attached')
  })

  test('refreshes resolved host fingerprint after verifying an existing app MCP server', async () => {
    let refreshCalls = 0

    const probe = new OpenCodeProvisioningProbe({
      inventoryService: {
        probe: async () => inventory,
      },
      hostManager: {
        ensureHost: async () => ({ ...host, resolvedConfigFingerprint: 'before-present' }),
        refreshResolvedConfigFingerprint: async () => {
          refreshCalls += 1
          return 'after-present'
        },
        releaseHost: async () => {},
      },
      clientFactory: {
        create: () => ({
          getConfig: async () => ({
            default_agent: 'teammate',
            share: 'disabled',
            autoupdate: false,
            snapshot: true,
          }),
          getConfigProviders: async () => ({ providers: [], default: {} }),
          getProviders: async () => ({ all: [], default: {}, connected: ['openai'] }),
          getProviderAuth: async () => ({}),
          listAgents: async () => [{ name: 'teammate', mode: 'primary' }],
          getMcp: async () => ({}),
          addMcp: async () => {
            throw new Error('not used')
          },
          createSession: async () => {
            throw new Error('not used')
          },
          getSession: async () => {
            throw new Error('not used')
          },
          getSessionStatus: async () => {
            throw new Error('not used')
          },
          getSessionMessages: async () => {
            throw new Error('not used')
          },
          getPermissions: async () => [],
          sendSessionMessage: async () => {
            throw new Error('not used')
          },
          promptSessionAsync: async () => {
            throw new Error('not used')
          },
          abortSession: async () => {
            throw new Error('not used')
          },
        }),
      },
      mcpManager: {
        ensureAppMcp: async () => ({
          mcp: {
            'agent-teams': {
              connected: true,
            },
          },
          summary: {
            serverName: 'agent-teams',
            matchedServerName: 'agent-teams',
            status: 'present',
            connected: true,
            launchSource: 'workspace-dist',
            availableServerNames: ['agent-teams'],
            diagnostics: [],
          },
        }),
      },
    })

    const snapshot = await probe.probe('/tmp/project')

    expect(refreshCalls).toBe(1)
    expect(snapshot.host?.resolvedConfigFingerprint).toBe('after-present')
    expect(snapshot.appMcp?.status).toBe('present')
  })
})
