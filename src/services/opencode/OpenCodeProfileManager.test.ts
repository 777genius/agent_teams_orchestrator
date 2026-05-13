import { lstat, mkdtemp, mkdir, readlink, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import {
  buildManagedConfig,
  buildManagedConfigFingerprint,
  collectProjectBehaviorMetadata,
  OpenCodeProfileManager,
  orderOpenCodeAuthSyncSources,
} from './OpenCodeProfileManager.js'
import { resolveOpenCodeAppMcpLaunchConfig } from './OpenCodeMcpManager.js'
import { applyOpenCodeAutoUpdatePolicy } from './OpenCodeAutoUpdatePolicy.js'
import {
  CLAUDE_MULTIMODEL_CACHE_HOME_ENV,
  CLAUDE_MULTIMODEL_DATA_HOME_ENV,
} from './OpenCodeManagedPaths.js'

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/')
}

describe('OpenCodeProfileManager project behavior contract', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-profile-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  test('tracks project plugin sources without shadowing plugin config in managed overrides', async () => {
    await mkdir(path.join(tempDir, '.opencode', 'plugins'), { recursive: true })
    await writeFile(
      path.join(tempDir, 'opencode.json'),
      JSON.stringify({ plugin: ['opencode-helicone-session'] }),
      'utf8',
    )
    await writeFile(
      path.join(tempDir, '.opencode', 'package.json'),
      JSON.stringify({ dependencies: { shescape: '^2.1.0' } }),
      'utf8',
    )
    await writeFile(
      path.join(tempDir, '.opencode', 'plugins', 'team-hooks.ts'),
      'export const TeamHooks = async () => ({})\n',
      'utf8',
    )

    const first = await collectProjectBehaviorMetadata(tempDir)
    await writeFile(
      path.join(tempDir, '.opencode', 'plugins', 'team-hooks.ts'),
      'export const TeamHooks = async () => ({ "session.updated": async () => {} })\n',
      'utf8',
    )
    const second = await collectProjectBehaviorMetadata(tempDir)
    const managedConfig = buildManagedConfig()

    expect(first.behaviorSources.map(normalizePath)).toEqual([
      '.opencode/package.json',
      '.opencode/plugins/team-hooks.ts',
      'opencode.json',
    ])
    expect(second.projectBehaviorFingerprint).not.toBe(first.projectBehaviorFingerprint)
    expect('plugin' in managedConfig).toBe(false)
    expect(managedConfig).toMatchObject({
      default_agent: 'teammate',
      share: 'disabled',
      autoupdate: false,
      snapshot: true,
      agent: {
        teammate: {
          permission: {
            '*': 'deny',
            'agent-teams_*': 'allow',
            'agent_teams_*': 'allow',
          },
        },
        'teammate-bootstrap': {
          tools: {
            '*': false,
            'agent-teams_*': true,
            'agent_teams_*': true,
            'mcp__agent-teams__*': true,
            'mcp__agent_teams__*': true,
          },
          permission: {
            '*': 'deny',
            'agent-teams_*': 'allow',
            'agent_teams_*': 'allow',
            'mcp__agent-teams__*': 'allow',
            'mcp__agent_teams__*': 'allow',
          },
        },
      },
    })
  })

  test('can embed the app-owned MCP server without shadowing plugins', () => {
    const managedConfig = buildManagedConfig({
      type: 'local',
      command: ['node', '/tmp/agent-teams-mcp.js'],
      environment: {
        HOME: '/tmp/profile-home',
      },
      enabled: true,
      timeout: 8000,
    })

    expect('plugin' in managedConfig).toBe(false)
    expect(managedConfig.mcp).toEqual({
      'agent-teams': {
        type: 'local',
        command: ['node', '/tmp/agent-teams-mcp.js'],
        environment: {
          HOME: '/tmp/profile-home',
        },
        enabled: true,
        timeout: 8000,
      },
    })
  })

  test('exposes an app-owned global auth path separate from the real OpenCode auth store', () => {
    const previousXdgDataHome = process.env.XDG_DATA_HOME
    process.env.XDG_DATA_HOME = tempDir
    try {
      const manager = new OpenCodeProfileManager()
      const realOpenCodeAuthPath = path.join(tempDir, 'opencode', 'auth.json')
      const globalAuthPath = manager.getGlobalAuthPath()
      expect(globalAuthPath).not.toBe(realOpenCodeAuthPath)
      expect(globalAuthPath.endsWith(path.join('opencode', 'auth.json'))).toBe(true)
    } finally {
      if (previousXdgDataHome === undefined) {
        delete process.env.XDG_DATA_HOME
      } else {
        process.env.XDG_DATA_HOME = previousXdgDataHome
      }
    }
  })

  test('keeps generated OpenCode dependency caches outside per-profile HOME', async () => {
    const previousDataHome = process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV]
    const previousCacheHome = process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV]
    const appDataHome = path.join(tempDir, 'app-data')
    const appCacheHome = path.join(tempDir, 'app-cache')
    process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV] = appDataHome
    process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV] = appCacheHome
    try {
      const manager = new OpenCodeProfileManager()
      const profile = await manager.prepareProfile(path.join(tempDir, 'project'))
      const profileNodeModulesPath = path.join(profile.xdgConfigHome, 'opencode', 'node_modules')
      const sharedNodeModulesPath = path.join(profile.xdgCacheHome, 'config-node_modules')
      const nodeModulesStat = await lstat(profileNodeModulesPath)
      const nodeModulesTarget = await readlink(profileNodeModulesPath)
      const appMcpConfig = (
        profile.managedConfig.mcp as Record<string, { environment?: Record<string, string> }>
      )?.['agent-teams']

      expect(profile.profileRootPath.startsWith(path.join(appDataHome, 'opencode', 'profiles'))).toBe(true)
      expect(profile.xdgCacheHome).toBe(path.join(appCacheHome, 'opencode', 'shared-cache'))
      expect(profile.env.NPM_CONFIG_CACHE).toBe(path.join(profile.xdgCacheHome, 'npm'))
      expect(profile.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV]).toBe(appDataHome)
      expect(profile.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV]).toBe(appCacheHome)
      expect(appMcpConfig?.environment?.[CLAUDE_MULTIMODEL_DATA_HOME_ENV]).toBe(appDataHome)
      expect(appMcpConfig?.environment?.[CLAUDE_MULTIMODEL_CACHE_HOME_ENV]).toBe(appCacheHome)
      expect(nodeModulesStat.isSymbolicLink()).toBe(true)
      expect(path.resolve(path.dirname(profileNodeModulesPath), nodeModulesTarget)).toBe(sharedNodeModulesPath)
    } finally {
      if (previousDataHome === undefined) {
        delete process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV]
      } else {
        process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV] = previousDataHome
      }
      if (previousCacheHome === undefined) {
        delete process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV]
      } else {
        process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV] = previousCacheHome
      }
    }
  })

  test('repairs profile node_modules when a real directory was left behind', async () => {
    const previousDataHome = process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV]
    const previousCacheHome = process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV]
    const appDataHome = path.join(tempDir, 'app-data-repair')
    const appCacheHome = path.join(tempDir, 'app-cache-repair')
    const projectPath = path.join(tempDir, 'project-repair')
    process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV] = appDataHome
    process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV] = appCacheHome
    try {
      await mkdir(projectPath, { recursive: true })
      const manager = new OpenCodeProfileManager()
      const firstProfile = await manager.prepareProfile(projectPath)
      const profileNodeModulesPath = path.join(
        firstProfile.xdgConfigHome,
        'opencode',
        'node_modules',
      )
      await rm(profileNodeModulesPath, { recursive: true, force: true })
      await mkdir(profileNodeModulesPath, { recursive: true })
      await writeFile(path.join(profileNodeModulesPath, 'stale.txt'), 'stale directory\n', 'utf8')

      const repairedProfile = await manager.prepareProfile(projectPath)
      const repairedStat = await lstat(profileNodeModulesPath)
      const repairedTarget = await readlink(profileNodeModulesPath)

      expect(repairedProfile.profileRootKey).toBe(firstProfile.profileRootKey)
      expect(repairedStat.isSymbolicLink()).toBe(true)
      expect(path.resolve(path.dirname(profileNodeModulesPath), repairedTarget)).toBe(
        path.join(repairedProfile.xdgCacheHome, 'config-node_modules'),
      )
    } finally {
      if (previousDataHome === undefined) {
        delete process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV]
      } else {
        process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV] = previousDataHome
      }
      if (previousCacheHome === undefined) {
        delete process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV]
      } else {
        process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV] = previousCacheHome
      }
    }
  })

  test('serializes concurrent profile preparation for the same project profile', async () => {
    const previousDataHome = process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV]
    const previousCacheHome = process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV]
    const appDataHome = path.join(tempDir, 'app-data-concurrent')
    const appCacheHome = path.join(tempDir, 'app-cache-concurrent')
    const projectPath = path.join(tempDir, 'project-concurrent')
    process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV] = appDataHome
    process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV] = appCacheHome
    try {
      await mkdir(projectPath, { recursive: true })
      const manager = new OpenCodeProfileManager()
      const firstProfile = await manager.prepareProfile(projectPath)
      const profileNodeModulesPath = path.join(
        firstProfile.xdgConfigHome,
        'opencode',
        'node_modules',
      )
      await rm(profileNodeModulesPath, { recursive: true, force: true })
      await mkdir(profileNodeModulesPath, { recursive: true })

      const profiles = await Promise.all(
        Array.from({ length: 8 }, () => manager.prepareProfile(projectPath)),
      )
      const repairedStat = await lstat(profileNodeModulesPath)
      const repairedTarget = await readlink(profileNodeModulesPath)

      expect(new Set(profiles.map(profile => profile.profileRootKey))).toEqual(
        new Set([firstProfile.profileRootKey]),
      )
      expect(repairedStat.isSymbolicLink()).toBe(true)
      expect(path.resolve(path.dirname(profileNodeModulesPath), repairedTarget)).toBe(
        path.join(firstProfile.xdgCacheHome, 'config-node_modules'),
      )
    } finally {
      if (previousDataHome === undefined) {
        delete process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV]
      } else {
        process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV] = previousDataHome
      }
      if (previousCacheHome === undefined) {
        delete process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV]
      } else {
        process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV] = previousCacheHome
      }
    }
  })

  test('syncs app-global OpenCode auth before real local auth so fresh login wins conflicts', () => {
    expect(
      orderOpenCodeAuthSyncSources({
        globalAuthPath: '/Users/test/Library/Application Support/claude-multimodel-nodejs/opencode/auth.json',
        globalAuthFingerprint: 'old-global-openai',
        sourceAuthPath: '/Users/test/.local/share/opencode/auth.json',
        sourceAuthFingerprint: 'fresh-local-openai',
      })
    ).toEqual([
      '/Users/test/Library/Application Support/claude-multimodel-nodejs/opencode/auth.json',
      '/Users/test/.local/share/opencode/auth.json',
    ])
  })

  test('keeps canonical user OpenCode auth after isolated XDG auth sources', () => {
    expect(
      orderOpenCodeAuthSyncSources({
        globalAuthPath: '/Users/test/Library/Application Support/claude-multimodel-nodejs/opencode/auth.json',
        globalAuthFingerprint: 'old-global-openai',
        sourceAuthSources: [
          {
            path: '/tmp/isolated-xdg/opencode/auth.json',
            fingerprint: null,
          },
          {
            path: '/Users/test/.local/share/opencode/auth.json',
            fingerprint: 'fresh-local-openai',
          },
        ],
      })
    ).toEqual([
      '/Users/test/Library/Application Support/claude-multimodel-nodejs/opencode/auth.json',
      '/Users/test/.local/share/opencode/auth.json',
    ])
  })

  test('keeps managed config fingerprint stable across volatile app MCP environment values', async () => {
    const launchBase = await resolveOpenCodeAppMcpLaunchConfig({
      env: {
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND: '/usr/local/bin/node',
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY: '/tmp/agent-teams-mcp.js',
        HOME: '/Users/test',
        PATH: '/usr/local/bin:/usr/bin',
      },
      pathExists: async () => false,
    })
    const launchVolatile = await resolveOpenCodeAppMcpLaunchConfig({
      env: {
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND: '/usr/local/bin/node',
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY: '/tmp/agent-teams-mcp.js',
        HOME: '/Users/test',
        PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin',
        TMPDIR: '/var/folders/runtime-a',
        CLAUDE_TEAM_CONTROL_URL: 'http://127.0.0.1:43123',
      },
      pathExists: async () => false,
    })
    const baseFingerprint = buildManagedConfigFingerprint(buildManagedConfig(launchBase.config))
    const volatileFingerprint = buildManagedConfigFingerprint(
      buildManagedConfig(launchVolatile.config)
    )

    expect(volatileFingerprint).toBe(baseFingerprint)
  })

  test('still changes managed config fingerprint when the MCP command changes', async () => {
    const launchNode = await resolveOpenCodeAppMcpLaunchConfig({
      env: {
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND: '/usr/local/bin/node',
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY: '/tmp/agent-teams-mcp.js',
      },
      pathExists: async () => false,
    })
    const launchBun = await resolveOpenCodeAppMcpLaunchConfig({
      env: {
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND: '/Users/belief/.bun/bin/bun',
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY: '/tmp/agent-teams-mcp.js',
      },
      pathExists: async () => false,
    })

    expect(
      buildManagedConfigFingerprint(buildManagedConfig(launchNode.config))
    ).not.toBe(buildManagedConfigFingerprint(buildManagedConfig(launchBun.config)))
  })

  test('disables OpenCode auto-update by default but keeps an explicit app override possible', () => {
    const managedConfig = buildManagedConfig()
    const overrideConfig = buildManagedConfig(null, { allowAutoUpdate: true })

    expect(managedConfig.autoupdate).toBe(false)
    expect(overrideConfig).not.toHaveProperty('autoupdate')
    expect(applyOpenCodeAutoUpdatePolicy({}).OPENCODE_DISABLE_AUTOUPDATE).toBe('1')
    expect(
      applyOpenCodeAutoUpdatePolicy({
        CLAUDE_TEAM_OPENCODE_ALLOW_AUTOUPDATE: '1',
        OPENCODE_DISABLE_AUTOUPDATE: '1',
      }).OPENCODE_DISABLE_AUTOUPDATE,
    ).toBeUndefined()
  })

  test('adds an app-managed default model only when explicitly configured', () => {
    const managedConfig = buildManagedConfig(null, {
      defaultModelId: 'openrouter/openai/gpt-oss-20b:free',
    })

    expect(managedConfig.model).toBe('openrouter/openai/gpt-oss-20b:free')
    expect(buildManagedConfig().model).toBeUndefined()
  })

  test('can cap a provider-scoped model output limit in managed config overrides', () => {
    const managedConfig = buildManagedConfig(null, {
      modelOutputLimitOverrides: [
        {
          modelId: 'openrouter/anthropic/claude-3.5-haiku',
          outputTokens: 512,
          contextTokens: 32_000,
        },
      ],
    })

    expect(managedConfig.provider).toEqual({
      openrouter: {
        models: {
          'anthropic/claude-3.5-haiku': {
            limit: {
              context: 32_000,
              output: 512,
            },
          },
        },
      },
    })
  })
})
