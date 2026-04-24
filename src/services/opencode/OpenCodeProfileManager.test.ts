import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import {
  buildManagedConfig,
  buildManagedConfigFingerprint,
  collectProjectBehaviorMetadata,
} from './OpenCodeProfileManager.js'
import { resolveOpenCodeAppMcpLaunchConfig } from './OpenCodeMcpManager.js'
import { applyOpenCodeAutoUpdatePolicy } from './OpenCodeAutoUpdatePolicy.js'

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

    expect(first.behaviorSources).toEqual([
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
      snapshot: false,
      agent: {
        teammate: {
          permission: {
            '*': 'deny',
            'agent-teams_*': 'allow',
            'agent_teams_*': 'allow',
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
})
