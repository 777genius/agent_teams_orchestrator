import { lstat, mkdtemp, mkdir, readFile, readlink, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { afterEach, beforeEach, describe, expect, mock, setDefaultTimeout, test } from 'bun:test'

import {
  buildManagedConfig,
  buildManagedConfigFingerprint,
  collectProjectBehaviorMetadata,
  ensureOpenCodeCursorPluginAuthCredential,
  ensureOpenCodeKiroPluginAuthCredential,
  ensureOpenCodeNativeCliCredentialBridge,
  isKiroCliWhoamiAuthenticated,
  OpenCodeProfileManager,
  orderOpenCodeAuthSyncSources,
} from './OpenCodeProfileManager.js'
import { resolveOpenCodeAppMcpLaunchConfig } from './OpenCodeMcpManager.js'
import { applyOpenCodeAutoUpdatePolicy } from './OpenCodeAutoUpdatePolicy.js'
import {
  readOpenCodeAuthCredential,
  upsertOpenCodeAuthCredential,
} from './OpenCodeAuthStore.js'
import {
  setOpenCodeManagedDefaultModel,
  setOpenCodeManagedGlobalDefaultModel,
  setOpenCodeManagedModelLimits,
} from './OpenCodeManagedPreferences.js'
import {
  CLAUDE_MULTIMODEL_CACHE_HOME_ENV,
  CLAUDE_MULTIMODEL_DATA_HOME_ENV,
} from './OpenCodeManagedPaths.js'

setDefaultTimeout(30_000)

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/')
}

async function runBunScript(
  scriptPath: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => {
      stdout += String(chunk)
    })
    child.stderr.on('data', chunk => {
      stderr += String(chunk)
    })
    child.on('error', reject)
    child.on('close', code => {
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(`script exited with code ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`))
    })
  })
}

async function runCommandCapture(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => {
      stdout += String(chunk)
    })
    child.stderr.on('data', chunk => {
      stderr += String(chunk)
    })
    child.on('error', reject)
    child.on('close', code => {
      if (code === 0) {
        resolve(stdout)
        return
      }
      reject(new Error(`command exited with code ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`))
    })
  })
}

describe('OpenCodeProfileManager project behavior contract', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-profile-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  test('parses the first balanced Kiro whoami JSON object before its Profile trailer', () => {
    expect(isKiroCliWhoamiAuthenticated({
      stdout: '{"accountType":"IamIdentityCenter","email":"user@example.com"}\n\nProfile:\nKiroProfile',
    })).toBe(true)
  })

  test('treats logged-out and malformed Kiro whoami payloads as unauthenticated', () => {
    expect(isKiroCliWhoamiAuthenticated({ stdout: '{"account":null}' })).toBe(false)
    expect(isKiroCliWhoamiAuthenticated({ stdout: '{not valid json' })).toBe(false)
    expect(isKiroCliWhoamiAuthenticated({ stdout: '{"accountType":"   "}' })).toBe(false)
  })

  test('accepts authenticated Kiro whoami JSON from stderr despite a non-zero exit', () => {
    expect(isKiroCliWhoamiAuthenticated({
      error: Object.assign(new Error('exit 1'), { code: 1 }),
      stdout: '',
      stderr: '{"accountType":"BuilderId"}',
    })).toBe(true)
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
            read: 'allow',
            glob: 'allow',
            grep: 'allow',
            list: 'allow',
            lsp: 'allow',
            todoread: 'allow',
            todowrite: 'allow',
            edit: 'allow',
            bash: 'allow',
            'agent-teams_*': 'allow',
            'agent_teams_*': 'allow',
            'mcp__agent-teams__*': 'allow',
            'mcp__agent_teams__*': 'allow',
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
        'teammate-model-probe': {
          tools: {
            '*': false,
          },
          permission: {
            '*': 'deny',
          },
        },
      },
    })
  })

  test('can build a manual approval teammate profile while keeping app MCP allowed', () => {
    const managedConfig = buildManagedConfig(null, { toolApprovalMode: 'manual' })

    expect(managedConfig).toMatchObject({
      agent: {
        teammate: {
          permission: {
            '*': 'ask',
            task: {
              '*': 'deny',
            },
            external_directory: 'deny',
            doom_loop: 'deny',
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

  test('seeds Z.AI Coding Plan independently of remote catalog hydration', () => {
    const managedConfig = buildManagedConfig()

    expect(managedConfig.provider).toMatchObject({
      'zai-coding-plan': {
        npm: '@ai-sdk/openai-compatible',
        options: {
          baseURL: 'https://api.z.ai/api/coding/paas/v4',
        },
        models: {
          'glm-5.2': {
            reasoning: true,
            tool_call: true,
            interleaved: { field: 'reasoning_content' },
          },
          'glm-5.1': {
            reasoning: true,
            tool_call: true,
            interleaved: { field: 'reasoning_content' },
          },
          'glm-5': {
            reasoning: true,
            tool_call: true,
          },
          'glm-5-turbo': {
            reasoning: true,
            tool_call: true,
          },
        },
      },
    })
  })

  test('keeps Copilot Free and Student usable when live discovery returns no selectable models', () => {
    const managedConfig = buildManagedConfig()

    expect(managedConfig.provider).toMatchObject({
      'github-copilot': {
        name: 'GitHub Copilot',
        npm: '@ai-sdk/github-copilot',
        api: 'https://api.githubcopilot.com',
        models: {
          'gpt-4.1': {
            name: 'GPT-4.1',
            family: 'gpt',
            tool_call: true,
            structured_output: true,
            limit: {
              context: 128_000,
              input: 128_000,
              output: 16_384,
            },
          },
        },
      },
    })
  })

  test('seeds Xiaomi MiMo Token Plan OpenCode providers for regional Token Plan endpoints', () => {
    const managedConfig = buildManagedConfig()

    expect(managedConfig.provider).toMatchObject({
      'xiaomi-token-plan-ams': {
        npm: '@ai-sdk/openai-compatible',
        name: 'Xiaomi MiMo Token Plan - Europe',
        options: {
          baseURL: 'https://token-plan-ams.xiaomimimo.com/v1',
        },
        models: {
          'mimo-v2.5-pro': {
            name: 'mimo-v2.5-pro',
            limit: {
              context: 1_048_576,
              output: 131_072,
            },
            modalities: {
              input: ['text'],
              output: ['text'],
            },
          },
          'mimo-v2.5': {
            modalities: {
              input: ['text', 'image'],
              output: ['text'],
            },
          },
        },
      },
      'xiaomi-token-plan-sgp': {
        options: {
          baseURL: 'https://token-plan-sgp.xiaomimimo.com/v1',
        },
      },
      'xiaomi-token-plan-cn': {
        options: {
          baseURL: 'https://token-plan-cn.xiaomimimo.com/v1',
        },
      },
    })
  })

  test('seeds the official Kimi Code membership endpoint and stable model ids', () => {
    const managedConfig = buildManagedConfig()

    expect(managedConfig.provider).toMatchObject({
      'kimi-for-coding': {
        npm: '@ai-sdk/openai-compatible',
        name: 'Kimi Code Membership',
        options: {
          baseURL: 'https://api.kimi.com/coding/v1',
        },
        models: {
          'kimi-for-coding': {
            name: 'Kimi Code',
            reasoning: true,
            tool_call: true,
            limit: {
              context: 262_144,
              output: 32_768,
            },
            modalities: {
              input: ['text', 'image'],
              output: ['text'],
            },
          },
          'kimi-for-coding-highspeed': {
            name: 'Kimi Code HighSpeed',
          },
        },
      },
    })
  })

  test('seeds plugin-backed Cursor and Kiro providers even when models.dev lags', () => {
    const managedConfig = buildManagedConfig()

    expect(managedConfig.provider).toMatchObject({
      kiro: {
        name: 'Amazon Q Developer / Kiro',
        npm:
          'kiro-acp-ai-provider@https://github.com/777genius/kiro-acp-ai-provider/releases/download/agent-teams-mcp-readiness-v12/kiro-acp-ai-provider-3.0.0.tgz',
        models: {
          auto: {
            name: 'Auto',
            tool_call: true,
            limit: { context: 262_144, output: 32_768 },
          },
        },
      },
      'cursor-acp': {
        name: 'Cursor ACP',
        npm: '@ai-sdk/openai-compatible',
        options: {
          baseURL: 'http://127.0.0.1:32124/v1',
        },
        models: {
          auto: {
            name: 'Auto',
            tool_call: true,
            limit: { context: 262_144, output: 32_768 },
          },
        },
      },
    })
  })

  test('keeps OpenCode isolated while native subscription CLIs reuse the host login home', async () => {
    if (process.platform === 'win32') return

    const hostHomePath = path.join(tempDir, "host user's home")
    const hostBinPath = path.join(tempDir, 'host-bin')
    const profileRootPath = path.join(tempDir, 'profile-root')
    await mkdir(hostBinPath, { recursive: true })
    await writeFile(
      path.join(hostBinPath, 'cursor-agent'),
      '#!/bin/sh\nprintf "cursor:%s" "$HOME"\n',
      { encoding: 'utf8', mode: 0o700 },
    )
    await writeFile(
      path.join(hostBinPath, 'kiro-cli'),
      '#!/bin/sh\nprintf "kiro:%s" "$HOME"\n',
      { encoding: 'utf8', mode: 0o700 },
    )

    const bridge = await ensureOpenCodeNativeCliCredentialBridge(
      profileRootPath,
      {
        HOME: hostHomePath,
        PATH: hostBinPath,
      },
      process.platform,
    )
    const managedEnv = {
      HOME: path.join(profileRootPath, 'home'),
      USERPROFILE: path.join(profileRootPath, 'home'),
      PATH: `${bridge.binPath}${path.delimiter}${hostBinPath}`,
    }

    expect(await runCommandCapture(bridge.cursorAgentExecutablePath, [], managedEnv))
      .toBe(`cursor:${hostHomePath}`)
    expect(await runCommandCapture(path.join(bridge.binPath, 'kiro-cli'), [], managedEnv))
      .toBe(`kiro:${hostHomePath}`)
  })

  test('seeds the Cursor plugin marker after the official CLI reports authenticated', async () => {
    const globalAuthPath = path.join(tempDir, 'cursor-global-auth.json')
    const managedAuthPath = path.join(tempDir, 'cursor-managed-auth.json')
    const probe = mock(async () => true)

    expect(await ensureOpenCodeCursorPluginAuthCredential({
      globalAuthPath,
      managedAuthPath,
      cursorAgentExecutablePath: '/test/cursor-agent',
      platform: 'linux',
      probe,
    })).toBe(true)

    for (const authPath of [globalAuthPath, managedAuthPath]) {
      expect(JSON.parse(await readFile(authPath, 'utf8'))).toMatchObject({
        'cursor-acp': { type: 'api', key: 'cursor-agent' },
      })
    }
    expect(probe).toHaveBeenCalledTimes(1)
  })

  test('removes only the managed Cursor marker after the official CLI logs out', async () => {
    const globalAuthPath = path.join(tempDir, 'cursor-logged-out-global.json')
    const managedAuthPath = path.join(tempDir, 'cursor-logged-out-managed.json')
    const store = JSON.stringify({
      'cursor-acp': { type: 'api', key: 'cursor-agent' },
      openai: { type: 'oauth', access: 'keep-me' },
    })
    await Promise.all([
      writeFile(globalAuthPath, store),
      writeFile(managedAuthPath, store),
    ])

    expect(await ensureOpenCodeCursorPluginAuthCredential({
      globalAuthPath,
      managedAuthPath,
      cursorAgentExecutablePath: '/test/cursor-agent',
      probe: async () => false,
    })).toBe(false)

    for (const authPath of [globalAuthPath, managedAuthPath]) {
      expect(JSON.parse(await readFile(authPath, 'utf8'))).toEqual({
        openai: { type: 'oauth', access: 'keep-me' },
      })
    }
  })

  test('reuses a fresh Cursor marker without repeatedly probing the official CLI', async () => {
    const globalAuthPath = path.join(tempDir, 'cursor-fresh-global.json')
    const managedAuthPath = path.join(tempDir, 'cursor-fresh-managed.json')
    const credential = {
      type: 'api',
      key: 'cursor-agent',
      expires: 20 * 60 * 1000,
    }
    await writeFile(globalAuthPath, JSON.stringify({ 'cursor-acp': credential }))
    const probe = mock(async () => false)

    expect(await ensureOpenCodeCursorPluginAuthCredential({
      globalAuthPath,
      managedAuthPath,
      cursorAgentExecutablePath: '/test/cursor-agent',
      probe,
      now: () => 1_000,
    })).toBe(false)

    expect(probe).not.toHaveBeenCalled()
    expect(JSON.parse(await readFile(managedAuthPath, 'utf8'))).toMatchObject({
      'cursor-acp': credential,
    })
  })

  test('preserves an explicit Cursor API credential without probing the CLI marker', async () => {
    const globalAuthPath = path.join(tempDir, 'cursor-explicit-global.json')
    const managedAuthPath = path.join(tempDir, 'cursor-explicit-managed.json')
    await writeFile(globalAuthPath, JSON.stringify({
      'cursor-acp': { type: 'api', key: 'real-user-key' },
    }))
    const probe = mock(async () => false)

    expect(await ensureOpenCodeCursorPluginAuthCredential({
      globalAuthPath,
      managedAuthPath,
      cursorAgentExecutablePath: '/test/cursor-agent',
      probe,
    })).toBe(false)

    expect(JSON.parse(await readFile(managedAuthPath, 'utf8'))).toMatchObject({
      'cursor-acp': { type: 'api', key: 'real-user-key' },
    })
    expect(probe).not.toHaveBeenCalled()
  })

  test('seeds the Kiro plugin OAuth marker after the official CLI reports authenticated', async () => {
    const globalAuthPath = path.join(tempDir, 'kiro-global-auth.json')
    const managedAuthPath = path.join(tempDir, 'kiro-managed-auth.json')
    const probe = mock(async () => true)

    expect(await ensureOpenCodeKiroPluginAuthCredential({
      globalAuthPath,
      managedAuthPath,
      kiroCliExecutablePath: '/test/kiro-cli',
      platform: 'linux',
      probe,
      now: () => 1_000,
    })).toBe(true)

    for (const authPath of [globalAuthPath, managedAuthPath]) {
      expect(JSON.parse(await readFile(authPath, 'utf8'))).toMatchObject({
        kiro: {
          type: 'oauth',
          access: 'authenticated',
          refresh: '',
          expires: 28_801_000,
        },
      })
    }
    expect(probe).toHaveBeenCalledTimes(1)
  })

  test('does not seed the Kiro plugin marker when the CLI is logged out', async () => {
    const globalAuthPath = path.join(tempDir, 'kiro-logged-out-global.json')
    const managedAuthPath = path.join(tempDir, 'kiro-logged-out-managed.json')

    expect(await ensureOpenCodeKiroPluginAuthCredential({
      globalAuthPath,
      managedAuthPath,
      kiroCliExecutablePath: '/test/kiro-cli',
      probe: async () => false,
    })).toBe(false)

    expect(await lstat(globalAuthPath).then(() => true).catch(() => false)).toBe(false)
    expect(await lstat(managedAuthPath).then(() => true).catch(() => false)).toBe(false)
  })

  test('refreshes a stale Kiro marker after rechecking the official CLI', async () => {
    const globalAuthPath = path.join(tempDir, 'kiro-stale-global.json')
    const managedAuthPath = path.join(tempDir, 'kiro-stale-managed.json')
    await writeFile(globalAuthPath, JSON.stringify({
      kiro: { type: 'oauth', access: 'authenticated', refresh: '', expires: 2_000 },
    }))
    const probe = mock(async () => true)

    expect(await ensureOpenCodeKiroPluginAuthCredential({
      globalAuthPath,
      managedAuthPath,
      kiroCliExecutablePath: '/test/kiro-cli',
      probe,
      now: () => 1_000,
    })).toBe(true)

    for (const authPath of [globalAuthPath, managedAuthPath]) {
      expect(JSON.parse(await readFile(authPath, 'utf8')).kiro.expires).toBe(28_801_000)
    }
    expect(probe).toHaveBeenCalledTimes(1)
  })

  test('removes a stale Kiro marker when the official CLI is logged out', async () => {
    const globalAuthPath = path.join(tempDir, 'kiro-stale-logged-out-global.json')
    const managedAuthPath = path.join(tempDir, 'kiro-stale-logged-out-managed.json')
    const staleStore = JSON.stringify({
      kiro: { type: 'oauth', access: 'authenticated', refresh: '', expires: 2_000 },
      openai: { type: 'oauth', access: 'keep-me' },
    })
    await Promise.all([
      writeFile(globalAuthPath, staleStore),
      writeFile(managedAuthPath, staleStore),
    ])

    expect(await ensureOpenCodeKiroPluginAuthCredential({
      globalAuthPath,
      managedAuthPath,
      kiroCliExecutablePath: '/test/kiro-cli',
      probe: async () => false,
      now: () => 1_000,
    })).toBe(false)

    for (const authPath of [globalAuthPath, managedAuthPath]) {
      expect(JSON.parse(await readFile(authPath, 'utf8'))).toEqual({
        openai: { type: 'oauth', access: 'keep-me' },
      })
    }
  })

  test('rechecks and removes a fresh Kiro marker after CLI logout', async () => {
    const globalAuthPath = path.join(tempDir, 'kiro-fresh-logged-out-global.json')
    const managedAuthPath = path.join(tempDir, 'kiro-fresh-logged-out-managed.json')
    const freshStore = JSON.stringify({
      kiro: { type: 'oauth', access: 'authenticated', refresh: '', expires: 30_000_000 },
      openai: { type: 'oauth', access: 'keep-me' },
    })
    await Promise.all([
      writeFile(globalAuthPath, freshStore),
      writeFile(managedAuthPath, freshStore),
    ])
    const probe = mock(async () => false)

    expect(await ensureOpenCodeKiroPluginAuthCredential({
      globalAuthPath,
      managedAuthPath,
      kiroCliExecutablePath: '/test/kiro-cli',
      probe,
      now: () => 1_000,
    })).toBe(false)

    expect(probe).toHaveBeenCalledTimes(1)
    for (const authPath of [globalAuthPath, managedAuthPath]) {
      expect(JSON.parse(await readFile(authPath, 'utf8'))).toEqual({
        openai: { type: 'oauth', access: 'keep-me' },
      })
    }
  })

  test('can prepare a managed profile without the app MCP overlay for model-only probes', async () => {
    const previousDataHome = process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV]
    const previousCacheHome = process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV]
    const previousMcpCommand = process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND
    const previousMcpEntry = process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY
    const appDataHome = path.join(tempDir, 'app-data-no-mcp')
    const appCacheHome = path.join(tempDir, 'app-cache-no-mcp')
    const mcpEntryPath = path.join(tempDir, 'agent-teams-mcp.js')
    await writeFile(mcpEntryPath, 'process.exit(0)\n', 'utf8')
    process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV] = appDataHome
    process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV] = appCacheHome
    process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND = process.execPath
    process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY = mcpEntryPath

    try {
      const profile = await new OpenCodeProfileManager().prepareProfile(tempDir, {
        includeAppMcp: false,
      })

      expect(profile.managedConfig.mcp).toBeUndefined()
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
      if (previousMcpCommand === undefined) {
        delete process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND
      } else {
        process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND = previousMcpCommand
      }
      if (previousMcpEntry === undefined) {
        delete process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY
      } else {
        process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY = previousMcpEntry
      }
    }
  }, 30_000)

  test('recovers a refreshed xAI OAuth credential from a peer during restart preparation', async () => {
    const previousDataHome = process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV]
    const previousCacheHome = process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV]
    const previousHome = process.env.HOME
    const previousXdgDataHome = process.env.XDG_DATA_HOME
    const previousXdgConfigHome = process.env.XDG_CONFIG_HOME
    const appDataHome = path.join(tempDir, 'app-data-oauth-restart')
    const appCacheHome = path.join(tempDir, 'app-cache-oauth-restart')
    const homePath = path.join(tempDir, 'home-oauth-restart')
    process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV] = appDataHome
    process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV] = appCacheHome
    process.env.HOME = homePath
    process.env.XDG_DATA_HOME = path.join(homePath, '.local', 'share')
    process.env.XDG_CONFIG_HOME = path.join(homePath, '.config')

    const now = Date.now()
    const stale = {
      type: 'oauth',
      access: 'expired-access',
      refresh: 'refresh-before-rotation',
      expires: now - 60_000,
      accountId: 'supergrok-account',
    }
    const rotated = {
      type: 'oauth',
      access: 'refreshed-access',
      refresh: 'refresh-after-rotation',
      expires: now + 3_600_000,
      accountId: 'supergrok-account',
    }

    try {
      const manager = new OpenCodeProfileManager()
      await upsertOpenCodeAuthCredential({
        authPath: manager.getGlobalAuthPath(),
        providerId: 'xai',
        credential: stale,
      })
      const activeProfile = await manager.prepareProfile(path.join(tempDir, 'active-project'), {
        includeAppMcp: false,
        includeManagedSubscriptionPlugins: false,
      })
      await upsertOpenCodeAuthCredential({
        authPath: activeProfile.managedAuthPath,
        providerId: 'xai',
        credential: rotated,
      })

      const restartedProfile = await manager.prepareProfile(path.join(tempDir, 'restarted-project'), {
        includeAppMcp: false,
        includeManagedSubscriptionPlugins: false,
      })

      await expect(Promise.all([
        readOpenCodeAuthCredential({ authPath: manager.getGlobalAuthPath(), providerId: 'xai' }),
        readOpenCodeAuthCredential({ authPath: activeProfile.managedAuthPath, providerId: 'xai' }),
        readOpenCodeAuthCredential({ authPath: restartedProfile.managedAuthPath, providerId: 'xai' }),
      ])).resolves.toEqual([rotated, rotated, rotated])
    } finally {
      if (previousDataHome === undefined) delete process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV]
      else process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV] = previousDataHome
      if (previousCacheHome === undefined) delete process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV]
      else process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV] = previousCacheHome
      if (previousHome === undefined) delete process.env.HOME
      else process.env.HOME = previousHome
      if (previousXdgDataHome === undefined) delete process.env.XDG_DATA_HOME
      else process.env.XDG_DATA_HOME = previousXdgDataHome
      if (previousXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = previousXdgConfigHome
    }
  }, 15_000)

  test('imports only safe user OpenCode config into managed profile content', async () => {
    const previousXdgConfigHome = process.env.XDG_CONFIG_HOME
    const previousOpenCodeConfig = process.env.OPENCODE_CONFIG
    const previousOpenCodeConfigContent = process.env.OPENCODE_CONFIG_CONTENT
    const previousDataHome = process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV]
    const previousCacheHome = process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV]
    const appDataHome = path.join(tempDir, 'app-data-config-import')
    const appCacheHome = path.join(tempDir, 'app-cache-config-import')
    const xdgConfigHome = path.join(tempDir, 'real-xdg-config')
    const customConfigPath = path.join(tempDir, 'custom-opencode.jsonc')
    await mkdir(path.join(xdgConfigHome, 'opencode'), { recursive: true })
    await writeFile(
      path.join(xdgConfigHome, 'opencode', 'opencode.jsonc'),
      `{
        // Local Ollama route should be imported.
        "model": "ollama/qwen2.5-coder:0.5b",
        "provider": {
          "ollama": {
            "npm": "@ai-sdk/openai-compatible",
            "options": { "baseURL": "http://127.0.0.1:11434/v1" },
            "models": { "qwen2.5-coder:0.5b": {} }
          }
        },
        "mcp": { "unsafe": { "type": "local", "command": ["bad"] } },
        "permission": { "*": "allow" },
        "plugin": ["unsafe-plugin"],
        "agent": { "unsafe": { "mode": "primary" } }
      }`,
      'utf8',
    )
    await writeFile(
      customConfigPath,
      JSON.stringify({
        small_model: 'llama.cpp/qwen-test:0.5b',
        provider: {
          'llama.cpp': {
            npm: '@ai-sdk/openai-compatible',
            options: { baseURL: 'http://127.0.0.1:8080/v1' },
            models: { 'qwen-test:0.5b': {} },
          },
        },
        command: { unsafe: 'nope' },
      }),
      'utf8',
    )
    process.env.XDG_CONFIG_HOME = xdgConfigHome
    process.env.OPENCODE_CONFIG = customConfigPath
    process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
      provider: {
        lmstudio: {
          npm: '@ai-sdk/openai-compatible',
          options: { baseURL: 'http://localhost:1234/v1' },
          models: { 'google/gemma-3n-e4b': {} },
        },
      },
      command: { unsafeInline: 'nope' },
    })
    process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV] = appDataHome
    process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV] = appCacheHome

    try {
      const manager = new OpenCodeProfileManager()
      const profile = await manager.prepareProfile(path.join(tempDir, 'project-config-import'))
      const managedConfig = JSON.parse(profile.env.OPENCODE_CONFIG_CONTENT ?? '{}') as Record<string, unknown>
      const providers = managedConfig.provider as Record<string, unknown>
      const agents = managedConfig.agent as Record<string, unknown>
      const mcp = (managedConfig.mcp ?? {}) as Record<string, unknown>

      expect(profile.env.OPENCODE_CONFIG).toBeUndefined()
      expect(providers.ollama).toMatchObject({
        models: { 'qwen2.5-coder:0.5b': {} },
      })
      expect(providers['llama.cpp']).toMatchObject({
        options: { baseURL: 'http://127.0.0.1:8080/v1' },
      })
      expect(providers.lmstudio).toMatchObject({
        models: { 'google/gemma-3n-e4b': {} },
      })
      expect(managedConfig.model).toBe('ollama/qwen2.5-coder:0.5b')
      expect(managedConfig.small_model).toBe('llama.cpp/qwen-test:0.5b')
      expect(managedConfig.plugin).toEqual([
        'opencode-kiro@0.4.0',
        '@rama_nigg/open-cursor@2.5.2',
      ])
      expect(managedConfig).not.toHaveProperty('permission')
      expect(managedConfig).not.toHaveProperty('command')
      expect(mcp.unsafe).toBeUndefined()
      expect(agents.teammate).toBeDefined()
      expect(agents.unsafe).toBeUndefined()
    } finally {
      if (previousXdgConfigHome === undefined) {
        delete process.env.XDG_CONFIG_HOME
      } else {
        process.env.XDG_CONFIG_HOME = previousXdgConfigHome
      }
      if (previousOpenCodeConfig === undefined) {
        delete process.env.OPENCODE_CONFIG
      } else {
        process.env.OPENCODE_CONFIG = previousOpenCodeConfig
      }
      if (previousOpenCodeConfigContent === undefined) {
        delete process.env.OPENCODE_CONFIG_CONTENT
      } else {
        process.env.OPENCODE_CONFIG_CONTENT = previousOpenCodeConfigContent
      }
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

  test('imports Ollama Cloud model routes from user opencode.json', async () => {
    const previousXdgConfigHome = process.env.XDG_CONFIG_HOME
    const previousOpenCodeConfig = process.env.OPENCODE_CONFIG
    const previousOpenCodeConfigContent = process.env.OPENCODE_CONFIG_CONTENT
    const previousDataHome = process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV]
    const previousCacheHome = process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV]
    const appDataHome = path.join(tempDir, 'app-data-ollama-cloud-import')
    const appCacheHome = path.join(tempDir, 'app-cache-ollama-cloud-import')
    const xdgConfigHome = path.join(tempDir, 'xdg-config-ollama-cloud')
    await mkdir(path.join(xdgConfigHome, 'opencode'), { recursive: true })
    await writeFile(
      path.join(xdgConfigHome, 'opencode', 'opencode.json'),
      JSON.stringify({
        model: 'ollama/kimi-k2.6:cloud',
        provider: {
          ollama: {
            models: {
              'kimi-k2.6:cloud': {
                limit: {
                  context: 262_144,
                  output: 262_144,
                },
                attachment: true,
                modalities: {
                  input: ['text', 'image'],
                  output: ['text'],
                },
                name: 'kimi-k2.6:cloud',
              },
              'deepseek-v4-flash:cloud': {
                limit: {
                  context: 1_000_000,
                  output: 1_000_000,
                },
                name: 'deepseek-v4-flash:cloud',
              },
            },
          },
        },
      }),
      'utf8',
    )
    process.env.XDG_CONFIG_HOME = xdgConfigHome
    delete process.env.OPENCODE_CONFIG
    delete process.env.OPENCODE_CONFIG_CONTENT
    process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV] = appDataHome
    process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV] = appCacheHome

    try {
      const profile = await new OpenCodeProfileManager().prepareProfile(
        path.join(tempDir, 'project-ollama-cloud-import'),
      )
      const managedConfig = JSON.parse(profile.env.OPENCODE_CONFIG_CONTENT ?? '{}') as Record<string, unknown>
      const providers = managedConfig.provider as Record<string, unknown>

      expect(managedConfig.model).toBe('ollama/kimi-k2.6:cloud')
      expect(providers.ollama).toMatchObject({
        models: {
          'kimi-k2.6:cloud': {
            limit: {
              context: 262_144,
              output: 262_144,
            },
            attachment: true,
            modalities: {
              input: ['text', 'image'],
              output: ['text'],
            },
            name: 'kimi-k2.6:cloud',
          },
          'deepseek-v4-flash:cloud': {
            limit: {
              context: 1_000_000,
              output: 1_000_000,
            },
            name: 'deepseek-v4-flash:cloud',
          },
        },
      })
    } finally {
      if (previousXdgConfigHome === undefined) {
        delete process.env.XDG_CONFIG_HOME
      } else {
        process.env.XDG_CONFIG_HOME = previousXdgConfigHome
      }
      if (previousOpenCodeConfig === undefined) {
        delete process.env.OPENCODE_CONFIG
      } else {
        process.env.OPENCODE_CONFIG = previousOpenCodeConfig
      }
      if (previousOpenCodeConfigContent === undefined) {
        delete process.env.OPENCODE_CONFIG_CONTENT
      } else {
        process.env.OPENCODE_CONFIG_CONTENT = previousOpenCodeConfigContent
      }
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
    const previousMcpCommand = process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND
    const previousMcpEntry = process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY
    const previousMcpArgsJson = process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ARGS_JSON
    const previousMcpUrl = process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL
    const appDataHome = path.join(tempDir, 'app-data')
    const appCacheHome = path.join(tempDir, 'app-cache')
    const mcpEntryPath = path.join(tempDir, 'agent-teams-mcp.js')
    await writeFile(mcpEntryPath, 'process.stdin.resume()\n', 'utf8')
    process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV] = appDataHome
    process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV] = appCacheHome
    process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND = process.execPath
    process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY = mcpEntryPath
    delete process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ARGS_JSON
    delete process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL
    try {
      const manager = new OpenCodeProfileManager()
      const profile = await manager.prepareProfile(path.join(tempDir, 'project'))
      const profileNodeModulesPath = path.join(profile.xdgConfigHome, 'opencode', 'node_modules')
      const sharedNodeModulesPath = path.join(profile.xdgCacheHome, 'config-node_modules')
      const tmpStat = await lstat(profile.tmpPath)
      const nodeModulesStat = await lstat(profileNodeModulesPath)
      const nodeModulesTarget = await readlink(profileNodeModulesPath)
      const appMcpConfig = (
        profile.managedConfig.mcp as Record<string, { environment?: Record<string, string> }>
      )?.['agent-teams']

      expect(profile.profileRootPath.startsWith(path.join(appDataHome, 'opencode', 'profiles'))).toBe(true)
      expect(profile.tmpPath).toBe(path.join(profile.profileRootPath, 'tmp'))
      expect(profile.env.TMPDIR).toBe(profile.tmpPath)
      expect(profile.env.TMP).toBe(profile.tmpPath)
      expect(profile.env.TEMP).toBe(profile.tmpPath)
      expect(tmpStat.isDirectory()).toBe(true)
      expect(profile.xdgCacheHome).toBe(path.join(appCacheHome, 'opencode', 'shared-cache'))
      expect(profile.env.NPM_CONFIG_CACHE).toBe(path.join(profile.xdgCacheHome, 'npm'))
      expect(profile.env.PLAYWRIGHT_BROWSERS_PATH).toBe(
        path.join(profile.xdgCacheHome, 'tools', 'ms-playwright'),
      )
      expect(profile.env.PUPPETEER_CACHE_DIR).toBe(
        path.join(profile.xdgCacheHome, 'tools', 'puppeteer'),
      )
      expect(profile.env.PIP_CACHE_DIR).toBe(path.join(profile.xdgCacheHome, 'tools', 'pip'))
      expect(profile.env.UV_CACHE_DIR).toBe(path.join(profile.xdgCacheHome, 'tools', 'uv'))
      expect(profile.env.npm_config_devdir).toBe(
        path.join(profile.xdgCacheHome, 'tools', 'node-gyp'),
      )
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
      if (previousMcpCommand === undefined) {
        delete process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND
      } else {
        process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND = previousMcpCommand
      }
      if (previousMcpEntry === undefined) {
        delete process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY
      } else {
        process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY = previousMcpEntry
      }
      if (previousMcpArgsJson === undefined) {
        delete process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ARGS_JSON
      } else {
        process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ARGS_JSON = previousMcpArgsJson
      }
      if (previousMcpUrl === undefined) {
        delete process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL
      } else {
        process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL = previousMcpUrl
      }
    }
  })

  test('does not add local environment keys to remote app MCP config', async () => {
    const previousDataHome = process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV]
    const previousCacheHome = process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV]
    const previousMcpUrl = process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL
    process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV] = path.join(tempDir, 'app-data-remote-mcp')
    process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV] = path.join(tempDir, 'app-cache-remote-mcp')
    process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL = 'http://127.0.0.1:41004/mcp'
    try {
      const manager = new OpenCodeProfileManager()
      const profile = await manager.prepareProfile(path.join(tempDir, 'project-remote-mcp'))
      const appMcpConfig = (
        profile.managedConfig.mcp as Record<string, { environment?: Record<string, string> }>
      )?.['agent-teams']

      expect(appMcpConfig).toMatchObject({
        type: 'remote',
        url: 'http://127.0.0.1:41004/mcp',
      })
      expect(appMcpConfig?.environment).toBeUndefined()
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
      if (previousMcpUrl === undefined) {
        delete process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL
      } else {
        process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL = previousMcpUrl
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

  test('repairs an empty managed OpenCode plugin cache after an interrupted install', async () => {
    const previousDataHome = process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV]
    const previousCacheHome = process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV]
    const appDataHome = path.join(tempDir, 'app-data-plugin-repair')
    const appCacheHome = path.join(tempDir, 'app-cache-plugin-repair')
    const projectPath = path.join(tempDir, 'project-plugin-repair')
    process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV] = appDataHome
    process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV] = appCacheHome
    try {
      await mkdir(projectPath, { recursive: true })
      const manager = new OpenCodeProfileManager()
      const firstProfile = await manager.prepareProfile(projectPath)
      const interruptedCachePath = path.join(
        firstProfile.xdgCacheHome,
        'opencode',
        'packages',
        'opencode-kiro@0.4.0',
      )
      await mkdir(interruptedCachePath, { recursive: true })

      await manager.prepareProfile(projectPath)

      const interruptedCacheStillExists = await lstat(interruptedCachePath)
        .then(() => true)
        .catch(() => false)
      expect(interruptedCacheStillExists).toBe(false)
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
  }, 15_000)

  test('keeps later profile preparation queued when an earlier waiter is aborted', async () => {
    const manager = new OpenCodeProfileManager() as unknown as {
      withProfilePreparationLock<T>(
        profileRootKey: string,
        operation: () => Promise<T>,
        abortSignal?: AbortSignal,
      ): Promise<T>
    }
    let markFirstStarted!: () => void
    let releaseFirst!: () => void
    const firstStarted = new Promise<void>(resolve => {
      markFirstStarted = resolve
    })
    const firstRelease = new Promise<void>(resolve => {
      releaseFirst = resolve
    })
    let firstActive = false
    const first = manager.withProfilePreparationLock('abort-queue', async () => {
      firstActive = true
      markFirstStarted()
      try {
        await firstRelease
      } finally {
        firstActive = false
      }
    })
    await firstStarted

    const controller = new AbortController()
    const timeout = new Error('profile preparation deadline expired')
    let abortedOperationCalled = false
    const aborted = manager.withProfilePreparationLock('abort-queue', async () => {
      abortedOperationCalled = true
    }, controller.signal)
    controller.abort(timeout)
    await expect(aborted).rejects.toBe(timeout)

    let laterOperationCalled = false
    const later = manager.withProfilePreparationLock('abort-queue', async () => {
      laterOperationCalled = true
      expect(firstActive).toBe(false)
    })

    try {
      await new Promise(resolve => setTimeout(resolve, 30))
      expect(abortedOperationCalled).toBe(false)
      expect(laterOperationCalled).toBe(false)
    } finally {
      releaseFirst()
      await first
      await later
    }
    expect(laterOperationCalled).toBe(true)
  })

  test('handles profile node_modules repair across separate process preparation races', async () => {
    const previousDataHome = process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV]
    const previousCacheHome = process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV]
    const appDataHome = path.join(tempDir, 'app-data-process-race')
    const appCacheHome = path.join(tempDir, 'app-cache-process-race')
    const projectPath = path.join(tempDir, 'project-process-race')
    process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV] = appDataHome
    process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV] = appCacheHome
    try {
      await mkdir(projectPath, { recursive: true })
      const manager = new OpenCodeProfileManager()
      const firstProfile = await manager.prepareProfile(projectPath, { includeAppMcp: false })
      const profileNodeModulesPath = path.join(
        firstProfile.xdgConfigHome,
        'opencode',
        'node_modules',
      )
      await rm(profileNodeModulesPath, { recursive: true, force: true })
      await mkdir(profileNodeModulesPath, { recursive: true })
      await writeFile(path.join(profileNodeModulesPath, 'stale.txt'), 'stale directory\n', 'utf8')

      const profileManagerUrl = pathToFileURL(
        path.resolve('src/services/opencode/OpenCodeProfileManager.ts'),
      ).href
      const scriptPath = path.join(tempDir, 'prepare-opencode-profile.mjs')
      await writeFile(
        scriptPath,
        `const { OpenCodeProfileManager } = await import(${JSON.stringify(profileManagerUrl)});
const startAt = Number(process.argv[3]);
while (Date.now() < startAt) {
  await Bun.sleep(5);
}
await new OpenCodeProfileManager().prepareProfile(process.argv[2], { includeAppMcp: false });
`,
        'utf8',
      )
      const childEnv = {
        ...process.env,
        [CLAUDE_MULTIMODEL_DATA_HOME_ENV]: appDataHome,
        [CLAUDE_MULTIMODEL_CACHE_HOME_ENV]: appCacheHome,
      }

      const startAt = String(Date.now() + 750)
      await Promise.all(Array.from(
        { length: 12 },
        () => runBunScript(scriptPath, [projectPath, startAt], childEnv),
      ))

      const repairedStat = await lstat(profileNodeModulesPath)
      const repairedTarget = await readlink(profileNodeModulesPath)
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
  }, 20_000)

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

  test('keeps managed config fingerprint stable across remote app MCP URL port drift', async () => {
    const launchFirst = await resolveOpenCodeAppMcpLaunchConfig({
      env: {
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL: 'http://127.0.0.1:41001/mcp',
      },
      pathExists: async () => false,
    })
    const launchSecond = await resolveOpenCodeAppMcpLaunchConfig({
      env: {
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL: 'http://127.0.0.1:41002/mcp',
      },
      pathExists: async () => false,
    })

    expect(
      buildManagedConfigFingerprint(buildManagedConfig(launchSecond.config))
    ).toBe(buildManagedConfigFingerprint(buildManagedConfig(launchFirst.config)))
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

  test('applies all-projects default to project profiles without overrides', async () => {
    const previousDataHome = process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV]
    const previousCacheHome = process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV]
    const appDataHome = path.join(tempDir, 'app-data-all-projects-default')
    const appCacheHome = path.join(tempDir, 'app-cache-all-projects-default')
    const projectA = path.join(tempDir, 'project-a')
    const projectB = path.join(tempDir, 'project-b')
    process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV] = appDataHome
    process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV] = appCacheHome

    try {
      await mkdir(projectA, { recursive: true })
      await mkdir(projectB, { recursive: true })
      await setOpenCodeManagedGlobalDefaultModel(
        appDataHome,
        'openrouter/openai/gpt-oss-20b:free',
      )

      const manager = new OpenCodeProfileManager()
      const profileA = await manager.prepareProfile(projectA, { includeAppMcp: false })
      const profileB = await manager.prepareProfile(projectB, { includeAppMcp: false })

      expect(profileA.managedConfig.model).toBe('openrouter/openai/gpt-oss-20b:free')
      expect(profileB.managedConfig.model).toBe('openrouter/openai/gpt-oss-20b:free')
      expect(profileA.projectDefaultModelId).toBeNull()
      expect(profileA.allProjectsDefaultModelId).toBe('openrouter/openai/gpt-oss-20b:free')
      expect(profileA.effectiveManagedDefaultSource).toBe('all_projects')
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

  test('project default overrides all-projects default', async () => {
    const previousDataHome = process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV]
    const previousCacheHome = process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV]
    const appDataHome = path.join(tempDir, 'app-data-project-default-wins')
    const appCacheHome = path.join(tempDir, 'app-cache-project-default-wins')
    const projectPath = path.join(tempDir, 'project-default-wins')
    process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV] = appDataHome
    process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV] = appCacheHome

    try {
      await mkdir(projectPath, { recursive: true })
      await setOpenCodeManagedGlobalDefaultModel(appDataHome, 'openrouter/global-model')
      const manager = new OpenCodeProfileManager()
      const initialProfile = await manager.prepareProfile(projectPath, { includeAppMcp: false })
      await setOpenCodeManagedDefaultModel(initialProfile.profileRootPath, 'openrouter/project-model')

      const profile = await manager.prepareProfile(projectPath, { includeAppMcp: false })

      expect(profile.managedConfig.model).toBe('openrouter/project-model')
      expect(profile.projectDefaultModelId).toBe('openrouter/project-model')
      expect(profile.allProjectsDefaultModelId).toBe('openrouter/global-model')
      expect(profile.effectiveManagedDefaultSource).toBe('project')
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

  test('applies app-managed local model limits without changing user or project config', async () => {
    const previousDataHome = process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV]
    const previousCacheHome = process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV]
    const appDataHome = path.join(tempDir, 'app-data-local-limits')
    const appCacheHome = path.join(tempDir, 'app-cache-local-limits')
    const projectPath = path.join(tempDir, 'project-local-limits')
    const projectConfigPath = path.join(projectPath, 'opencode.json')
    process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV] = appDataHome
    process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV] = appCacheHome

    try {
      await mkdir(projectPath, { recursive: true })
      await writeFile(
        projectConfigPath,
        JSON.stringify({ provider: { local: { models: { qwen: { name: 'Qwen local' } } } } }),
      )
      const originalProjectConfig = await readFile(projectConfigPath, 'utf8')
      const manager = new OpenCodeProfileManager()
      const initialProfile = await manager.prepareProfile(projectPath, { includeAppMcp: false })
      await setOpenCodeManagedModelLimits(initialProfile.profileRootPath, {
        modelId: 'local/qwen',
        contextTokens: 128_000,
        outputTokens: 32_000,
      })

      const profile = await manager.prepareProfile(projectPath, { includeAppMcp: false })

      expect(profile.managedConfig).toMatchObject({
        provider: {
          local: {
            models: {
              qwen: {
                limit: { context: 128_000, output: 32_000 },
              },
            },
          },
        },
      })
      expect(await readFile(projectConfigPath, 'utf8')).toBe(originalProjectConfig)
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
  }, 15_000)

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

    expect(managedConfig.provider).toMatchObject({
      atlascloud: {
        npm: '@ai-sdk/openai-compatible',
        options: {
          baseURL: 'https://api.atlascloud.ai/v1',
        },
        models: {
          'zai-org/glm-5.1': {
            tool_call: true,
          },
        },
      },
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
