import { expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { stageCursorManagedAssets } from '../../../scripts/cursor-plugin/stage.js'
import {
  CURSOR_MANAGED_ASSET_ROOT_ENV,
  resolveOpenCodeCursorManagedAssets,
} from './OpenCodeCursorManagedAssets.js'
import { CURSOR_MANAGED_PROXY_PORT_ENV } from './OpenCodeCursorManagedPort.js'
import {
  CLAUDE_MULTIMODEL_CACHE_HOME_ENV,
  CLAUDE_MULTIMODEL_DATA_HOME_ENV,
} from './OpenCodeManagedPaths.js'
import {
  ensureOpenCodeNativeCliCredentialBridge,
  OpenCodeProfileManager,
} from './OpenCodeProfileManager.js'
import { planOpenCodeProfilePolicy } from './OpenCodeProfilePolicy.js'

const scope = {
  purpose: 'launch_runtime',
  providerId: 'cursor-acp',
  configFingerprint: 'fingerprint',
  selectedAuthIdentity: 'known:identity',
  scopeToken: 'token',
} as const

test('managed staging replaces the upstream Cursor plugin, and its absence does not', () => {
  expect(planOpenCodeProfilePolicy(scope).managedSubscriptionPlugins)
    .toEqual(['@rama_nigg/open-cursor@2.5.2'])
  for (const value of [null, undefined, '   ']) {
    expect(planOpenCodeProfilePolicy(scope, { cursorManagedPlugin: value }).managedSubscriptionPlugins)
      .toEqual(['@rama_nigg/open-cursor@2.5.2'])
  }
  expect(planOpenCodeProfilePolicy(scope, { cursorManagedPlugin: '/staged/plugin-entry.js' })
    .managedSubscriptionPlugins).toEqual(['/staged/plugin-entry.js'])
  // Other providers must be unaffected by Cursor staging.
  expect(planOpenCodeProfilePolicy({ ...scope, providerId: 'kiro' },
    { cursorManagedPlugin: '/staged/plugin-entry.js' }).managedSubscriptionPlugins)
    .toEqual(['opencode-kiro@0.4.0'])
})

test.skipIf(process.platform !== 'darwin')('the bridge gives the agent the MCP CLI and this profile\'s config', async () => {
  // A space in the path proves the generated bridge quotes every staged location.
  const root = await mkdtemp(path.join(os.tmpdir(), 'cursor managed launch-'))
  try {
    const assetRoot = path.join(root, 'assets')
    await stageCursorManagedAssets(assetRoot)
    const resolved = await resolveOpenCodeCursorManagedAssets({
      env: { [CURSOR_MANAGED_ASSET_ROOT_ENV]: assetRoot, PATH: process.env.PATH },
    })
    expect(resolved.available).toBe(true)
    if (!resolved.available) return

    const hostBin = path.join(root, 'host bin')
    await mkdir(hostBin, { recursive: true })
    const fakeCursorAgent = path.join(hostBin, 'cursor-agent')
    await writeFile(fakeCursorAgent, '#!/bin/sh\necho "argv:$*"\n', 'utf8')
    await chmod(fakeCursorAgent, 0o700)

    const hostEnv = { HOME: root, PATH: hostBin, CURSOR_AGENT_EXECUTABLE: fakeCursorAgent }
    const configPath = path.join(root, 'profile config', 'opencode.json')
    const bridge = await ensureOpenCodeNativeCliCredentialBridge(
      path.join(root, 'profile'), hostEnv, 'darwin', resolved.assets, configPath,
    )
    const source = await readFile(bridge.cursorAgentExecutablePath, 'utf8')
    // mcptool must be reachable, and it must resolve this profile's servers.
    expect(source).toContain(bridge.binPath)
    expect(source).toContain(`export OPENCODE_CONFIG='${configPath}'`)
    // The profile bins go last: this directory also holds a cursor-agent wrapper,
    // and putting it first makes the wrapper exec itself forever.
    expect(source.indexOf(hostBin)).toBeLessThan(source.indexOf(bridge.binPath))
    expect(await readFile(path.join(bridge.binPath, 'mcptool'), 'utf8'))
      .toContain(resolved.assets.mcpToolPath)

    // The wrapper still reaches the real CLI rather than itself.
    const run = Bun.spawnSync([bridge.cursorAgentExecutablePath, '--print', 'a b'], {
      env: { PATH: hostBin, HOME: root }, stdout: 'pipe', stderr: 'pipe',
    })
    expect(run.exitCode, new TextDecoder().decode(run.stderr)).toBe(0)
    expect(new TextDecoder().decode(run.stdout)).toContain('argv:--print a b')

    // Without managed assets nothing is added to the bridge at all.
    const unmanaged = await ensureOpenCodeNativeCliCredentialBridge(
      path.join(root, 'unmanaged'), hostEnv, 'darwin', null, null,
    )
    const unmanagedSource = await readFile(unmanaged.cursorAgentExecutablePath, 'utf8')
    expect(unmanagedSource).not.toContain('OPENCODE_CONFIG=')
    expect(unmanagedSource).not.toContain(unmanaged.binPath + "'")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 60000)

test.skipIf(process.platform !== 'darwin')('binds readiness to the account, binary, assets, config and port', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cursor-readiness-'))
  const keys = [
    CLAUDE_MULTIMODEL_DATA_HOME_ENV, CLAUDE_MULTIMODEL_CACHE_HOME_ENV, CURSOR_MANAGED_ASSET_ROOT_ENV,
    'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'CURSOR_AGENT_EXECUTABLE',
  ]
  const original = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  try {
    const projectPath = path.join(root, 'project')
    await mkdir(projectPath, { recursive: true })
    await Promise.all(['config', 'data', 'cache'].map(dir =>
      mkdir(path.join(root, `source-${dir}`), { recursive: true })))
    await stageCursorManagedAssets(path.join(root, 'assets'))
    // A fake native CLI keeps this offline: no Cursor account usage is spent.
    const fakeAgent = path.join(root, 'cursor-agent')
    await writeFile(fakeAgent, '#!/bin/sh\necho "Logged in as first@example.com"\n', 'utf8')
    await chmod(fakeAgent, 0o700)

    process.env[CURSOR_MANAGED_ASSET_ROOT_ENV] = path.join(root, 'assets')
    process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV] = path.join(root, 'managed-data')
    process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV] = path.join(root, 'managed-cache')
    process.env.XDG_CONFIG_HOME = path.join(root, 'source-config')
    process.env.XDG_DATA_HOME = path.join(root, 'source-data')
    process.env.XDG_CACHE_HOME = path.join(root, 'source-cache')
    process.env.CURSOR_AGENT_EXECUTABLE = fakeAgent

    const manager = new OpenCodeProfileManager()
    const prepare = () => manager.prepareProfile(projectPath, {
      includeAppMcp: false, includeManagedSubscriptionPlugins: true, toolApprovalMode: 'auto',
    })
    const first = await prepare()
    const port = first.env[CURSOR_MANAGED_PROXY_PORT_ENV]
    expect(Number(port)).toBeGreaterThan(1024)
    expect(JSON.parse(first.env.OPENCODE_CONFIG_CONTENT ?? '{}').provider['cursor-acp'].options.baseURL)
      .toBe(`http://127.0.0.1:${port}/v1`)
    expect(first.env.AGENT_TEAMS_CURSOR_READINESS).toMatch(/^[a-f0-9]{64}$/)

    // Nothing drifted, so the retained port and the readiness answer must not either.
    const again = await prepare()
    expect(again.env[CURSOR_MANAGED_PROXY_PORT_ENV]).toBe(port)
    // A drifting managed config would also churn hosts on every launch.
    expect(again.env.OPENCODE_CONFIG_CONTENT).toBe(first.env.OPENCODE_CONFIG_CONTENT)
    expect(again.env.AGENT_TEAMS_CURSOR_READINESS).toBe(first.env.AGENT_TEAMS_CURSOR_READINESS)

    // A different account behind the same path must invalidate the answer.
    await writeFile(fakeAgent, '#!/bin/sh\necho "Logged in as second@example.com"\n', 'utf8')
    await chmod(fakeAgent, 0o700)
    const switched = await prepare()
    expect(switched.env.AGENT_TEAMS_CURSOR_READINESS).toMatch(/^[a-f0-9]{64}$/)
    expect(switched.env.AGENT_TEAMS_CURSOR_READINESS).not.toBe(first.env.AGENT_TEAMS_CURSOR_READINESS)

    // A signed-out CLI yields no readiness at all rather than a stale one.
    await writeFile(fakeAgent, '#!/bin/sh\necho "Not logged in"\n', 'utf8')
    await chmod(fakeAgent, 0o700)
    expect((await prepare()).env.AGENT_TEAMS_CURSOR_READINESS).toBeUndefined()
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(root, { recursive: true, force: true })
  }
}, 120_000)
