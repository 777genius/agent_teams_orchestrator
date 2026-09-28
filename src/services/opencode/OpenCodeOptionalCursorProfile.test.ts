import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, expect, mock, test } from 'bun:test'

import * as managedAssets from './OpenCodeCursorManagedAssets.js'

const originalManagedAssetResolver = managedAssets.resolveOpenCodeCursorManagedAssets

const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-optional-cursor-'))
const assetRoot = path.join(root, 'staged')
await mkdir(assetRoot, { recursive: true })
const pluginEntryPath = path.join(assetRoot, 'plugin.js')
const mcpToolPath = path.join(assetRoot, 'mcptool.js')
await Promise.all([
  writeFile(pluginEntryPath, '/* staged test asset */\n'),
  writeFile(mcpToolPath, '/* staged test asset */\n'),
])

// Model macOS shipped staging on Linux without changing platform support or
// loading the plugin. The profile's real native executable lookup still runs.
mock.module('./OpenCodeCursorManagedAssets.js', () => ({
  ...managedAssets,
  resolveOpenCodeCursorManagedAssets: async () => ({
    available: true as const,
    assets: {
      pluginEntryPath,
      mcpToolPath,
      interpreterPath: process.execPath,
      fingerprint: 'staged-fixture',
    },
  }),
}))

const { OpenCodeProfileManager, ensureOpenCodeNativeCliCredentialBridge, resolveOpenCodeProfileScope } =
  await import('./OpenCodeProfileManager.js')
const { OpenCodeInventoryService } = await import('./OpenCodeInventoryService.js')
const { CLAUDE_MULTIMODEL_DATA_HOME_ENV, CLAUDE_MULTIMODEL_CACHE_HOME_ENV } =
  await import('./OpenCodeManagedPaths.js')

const keys = [
  'HOME', 'USERPROFILE', 'PATH', 'CURSOR_AGENT_EXECUTABLE',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
  'OPENCODE_BIN_PATH', 'CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH',
  CLAUDE_MULTIMODEL_DATA_HOME_ENV, CLAUDE_MULTIMODEL_CACHE_HOME_ENV,
] as const
const originalEnv = Object.fromEntries(keys.map(key => [key, process.env[key]]))

afterAll(async () => {
  // Bun's mock.restore() does not revert mock.module() exports. Restore the
  // original function explicitly before removing paths referenced by the mock.
  mock.module('./OpenCodeCursorManagedAssets.js', () => ({
    ...managedAssets,
    resolveOpenCodeCursorManagedAssets: originalManagedAssetResolver,
  }))
  expect(managedAssets.resolveOpenCodeCursorManagedAssets).toBe(originalManagedAssetResolver)
  for (const key of keys) {
    const original = originalEnv[key]
    if (original === undefined) delete process.env[key]
    else process.env[key] = original
  }
  await rm(root, { recursive: true, force: true })
})

test.skipIf(process.platform === 'win32')(
  'uninstalled optional Cursor cannot block an unscoped OpenCode provider profile', async () => {
    const home = path.join(root, 'home')
    const project = path.join(root, 'project')
    await mkdir(project)
    process.env.HOME = home
    process.env.USERPROFILE = home
    process.env.PATH = path.join(root, 'empty-bin')
    process.env.CURSOR_AGENT_EXECUTABLE = path.join(root, 'absent-cursor-agent')
    process.env.XDG_CONFIG_HOME = path.join(home, 'config')
    process.env.XDG_DATA_HOME = path.join(home, 'data')
    process.env.XDG_CACHE_HOME = path.join(home, 'cache')
    process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV] = path.join(root, 'app-data')
    process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV] = path.join(root, 'app-cache')
    const fakeOpenCode = path.join(root, 'fake-opencode')
    await writeFile(fakeOpenCode, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
    process.env.OPENCODE_BIN_PATH = fakeOpenCode
    process.env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH = fakeOpenCode

    const inventory = await new OpenCodeInventoryService().probe(project, {
      mode: 'profile',
      includeAppMcp: false,
    })
    expect(inventory.detected).toBe(true)
    expect(inventory.profile).not.toBeNull()
    expect(inventory.diagnostics).not.toContain('Managed Cursor requires an absolute native executable')

    const profile = await new OpenCodeProfileManager().prepareProfile(project, {
      includeAppMcp: false,
      includeManagedSubscriptionPlugins: true,
    })

    expect(profile.managedConfig.plugin).toContain('@rama_nigg/open-cursor@2.5.2')
    expect(profile.managedConfig.plugin).toContain('opencode-kiro@0.4.0')
    expect(profile.managedConfig.plugin).not.toContain(pluginEntryPath)
    expect(profile.workingDirectoryPath).toBe(await realpath(project))
    expect(await readFile(profile.managedAuthPath, 'utf8').catch(() => '{}'))
      .not.toContain('cursor-agent')

    const catalogScope = await resolveOpenCodeProfileScope({
      projectPath: project,
      purpose: 'catalog',
      selectedModel: 'openai/fixture-model',
      env: process.env,
    })
    const catalogProfile = await new OpenCodeProfileManager().prepareProfile(project, {
      profileScope: catalogScope,
    })
    expect(catalogProfile.profileScope?.providerId).toBe('openai')

    await expect(ensureOpenCodeNativeCliCredentialBridge(
      path.join(root, 'selected-cursor'), process.env, process.platform,
      { pluginEntryPath, mcpToolPath, interpreterPath: process.execPath, fingerprint: 'staged-fixture' },
    )).rejects.toThrow('Managed Cursor requires an absolute native executable')
    await expect(resolveOpenCodeProfileScope({
      projectPath: project,
      purpose: 'launch_runtime',
      selectedModel: 'cursor-acp/fixture-model',
      env: process.env,
    })).rejects.toThrow('OpenCode strict Cursor profile requires current native authentication')

    const fakeCursor = path.join(root, 'fake-cursor-agent')
    await writeFile(fakeCursor, '#!/bin/sh\nprintf "Logged in as fixture@example.test\\n"\n', {
      mode: 0o700,
    })
    process.env.CURSOR_AGENT_EXECUTABLE = fakeCursor
    const installedProfile = await new OpenCodeProfileManager().prepareProfile(project, {
      includeAppMcp: false,
      includeManagedSubscriptionPlugins: true,
    })
    expect(installedProfile.managedConfig.plugin).toContain(pluginEntryPath)
    expect(installedProfile.managedConfig.plugin).toContain('opencode-kiro@0.4.0')
  },
)
