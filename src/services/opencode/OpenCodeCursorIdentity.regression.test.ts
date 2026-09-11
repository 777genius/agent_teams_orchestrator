import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  OpenCodeProfileManager, resolveManagedCursorAssets, resolveOpenCodeProfileScope,
  ensureOpenCodeCursorPluginAuthCredential,
} from './OpenCodeProfileManager.js'
import { buildOpenCodeExpectedBehaviorEvidence } from './OpenCodeExpectedBehaviorFingerprint.js'
import { sessionManagedAuthMatches } from './OpenCodeSessionBridge.js'
import type { OpenCodeSessionRecord } from './types.js'

const digest = (value: string) => createHash('sha256').update(value).digest('hex')

// Synthetic verified payload only. No staging/build scripts or package installation.
async function fixture(root: string) {
  const assets = path.join(root, 'assets')
  await mkdir(path.join(assets, 'plugin'), { recursive: true, mode: 0o700 })
  const interpreter = path.join(root, 'fixture-interpreter')
  await writeFile(interpreter, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  const publish = async (version: string) => {
    const plugin = `export default async () => ({}); // ${version}`
    const cli = `// fixture cli ${version}`
    await writeFile(path.join(assets, 'plugin/index.js'), plugin, { mode: 0o600 })
    await writeFile(path.join(assets, 'plugin/cli.js'), cli, { mode: 0o600 })
    await writeFile(path.join(assets, 'plugin/manifest.json'), JSON.stringify({ schema: 1,
      backend: 'cursor-agent', entrypoint: 'index.js', artifactSha256: digest(plugin),
      mcpToolEntrypoint: 'cli.js', mcpToolSha256: digest(cli) }), { mode: 0o600 })
  }
  return { assets, interpreter, publish }
}

test.skipIf(process.platform !== 'darwin')('profile resolver has no negative/success cache across restage and interpreter changes', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'cursor-profile-assets-')))
  try {
    const { assets, interpreter, publish } = await fixture(root)
    const env = { HOME: root, PATH: '', AGENT_TEAMS_CURSOR_MANAGED_ASSETS: assets,
      AGENT_TEAMS_CURSOR_SUPERVISOR_NODE: interpreter }
    expect(await resolveManagedCursorAssets(env)).toBeNull()
    await publish('one')
    const first = await resolveManagedCursorAssets(env)
    expect(first).not.toBeNull()
    await publish('two')
    expect((await resolveManagedCursorAssets(env))?.fingerprint).not.toBe(first?.fingerprint)
    const otherInterpreter = path.join(root, 'other interpreter')
    await writeFile(otherInterpreter, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
    expect((await resolveManagedCursorAssets({ ...env, AGENT_TEAMS_CURSOR_SUPERVISOR_NODE: otherInterpreter }))?.interpreterPath)
      .toBe(otherInterpreter)
    expect(await resolveManagedCursorAssets({ ...env, AGENT_TEAMS_CURSOR_SUPERVISOR_NODE: path.join(root, 'missing') }))
      .toBeNull()
  } finally { await rm(root, { recursive: true, force: true }) }
})

test.skipIf(process.platform !== 'darwin')('strict profile reprepare and follow-up survive marker TTL; current account and assets remain authoritative', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'cursor-strict-identity-')))
  try {
    const { assets, interpreter, publish } = await fixture(root)
    await publish('one')
    const home = path.join(root, 'native home')
    const project = path.join(root, 'project')
    const native = path.join(home, '.local/bin/cursor-agent')
    await mkdir(path.dirname(native), { recursive: true })
    await mkdir(project)
    const status = path.join(root, 'synthetic-status')
    await writeFile(status, 'account-a@example.invalid\n')
    await writeFile(native, '#!/bin/sh\nIFS= read -r account < "$CURSOR_FIXTURE_STATUS"\nif [ -n "$account" ]; then echo "Logged in as $account"; else echo "Not logged in"; fi\n', { mode: 0o700 })
    const mcpEntry = path.join(root, 'mcp-fixture.js')
    await writeFile(mcpEntry, '// never executed')
    const env = { HOME: home, PATH: '/usr/bin:/bin', CURSOR_FIXTURE_STATUS: status,
      XDG_CONFIG_HOME: path.join(root, 'source-config'), XDG_DATA_HOME: path.join(root, 'source-data'),
      XDG_CACHE_HOME: path.join(root, 'source-cache'),
      CLAUDE_MULTIMODEL_DATA_HOME: path.join(root, 'data'), CLAUDE_MULTIMODEL_CACHE_HOME: path.join(root, 'cache'),
      CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY: mcpEntry,
      AGENT_TEAMS_CURSOR_MANAGED_ASSETS: assets, AGENT_TEAMS_CURSOR_SUPERVISOR_NODE: interpreter,
      AGENT_TEAMS_CURSOR_READINESS: 'inherited-stale-readiness',
      CURSOR_ACP_BACKEND: 'sdk', CURSOR_ACP_AGENT_POOL: 'true' }
    const scope = () => resolveOpenCodeProfileScope({ projectPath: project, purpose: 'launch_runtime',
      selectedModel: 'cursor-acp/auto', env })
    const firstScope = await scope()
    const manager = new OpenCodeProfileManager()
    const prepare = (profileScope = firstScope) => manager.prepareProfile(project, {
      profileScope, toolApprovalMode: 'auto', includeAppMcp: false,
    })
    const first = await prepare()
    // First preparation introduces the compatibility marker. Its presence must
    // not change the native-authenticated scope, even before any TTL refresh.
    expect(await scope()).toEqual(firstScope)
    expect(first.env.AGENT_TEAMS_CURSOR_READINESS).not.toBe('inherited-stale-readiness')
    expect(first.env.CURSOR_CONFIG_DIR).toStartWith(path.join(root, 'data', 'opencode', 'cursor-native-config'))
    expect(first.env.CURSOR_ACP_BACKEND).toBe('cursor-agent')
    expect(first.env.CURSOR_ACP_AGENT_POOL).toBe('false')
    const originalMarker = await readFile(first.managedAuthPath, 'utf8')
    const evidence = () => buildOpenCodeExpectedBehaviorEvidence({ profile: first,
      fullModelId: 'cursor-acp/auto', effectiveConfigFingerprint: first.managedConfigFingerprint })
    const before = await evidence()
    await ensureOpenCodeCursorPluginAuthCredential({ globalAuthPath: first.globalAuthPath!,
      managedAuthPath: first.managedAuthPath, cursorAgentExecutablePath: native, env,
      now: () => Date.now() + 31 * 60_000 })
    expect(await readFile(first.managedAuthPath, 'utf8')).not.toBe(originalMarker)
    expect(await evidence()).toEqual(before)
    const nextScope = await scope()
    expect(nextScope).toEqual(firstScope)
    // Rehydrate native HOME/PATH/executable from the actual prepared environment.
    expect(await resolveOpenCodeProfileScope({ projectPath: project, purpose: 'launch_runtime',
      selectedModel: 'cursor-acp/auto', env: first.env })).toEqual(firstScope)
    const second = await prepare(nextScope)
    expect(second.env.AGENT_TEAMS_CURSOR_READINESS).toBe(first.env.AGENT_TEAMS_CURSOR_READINESS)
    expect(second.env.AGENT_TEAMS_CURSOR_PROXY_PORT).toBe(first.env.AGENT_TEAMS_CURSOR_PROXY_PORT)
    expect(sessionManagedAuthMatches({ profileScope: firstScope, managedAuthFingerprint: first.managedAuthFingerprint } as OpenCodeSessionRecord, second))
      .toBe(true)
    // The same scope/account may acquire a different host after AGENTS.md edits.
    // It must not retain the still-owned old generation's exclusive proxy port.
    await writeFile(path.join(project, 'AGENTS.md'), 'Synthetic changed project behavior\n')
    const changedBehavior = await prepare(await scope())
    expect(changedBehavior.projectBehaviorFingerprint).not.toBe(second.projectBehaviorFingerprint)
    expect(path.dirname(changedBehavior.env.CURSOR_AGENT_EXECUTABLE!))
      .not.toBe(path.dirname(second.env.CURSOR_AGENT_EXECUTABLE!))
    const stableChangedBehavior = await prepare(await scope())
    expect(stableChangedBehavior.env.CURSOR_AGENT_EXECUTABLE).toBe(changedBehavior.env.CURSOR_AGENT_EXECUTABLE)
    await rm(path.join(project, 'AGENTS.md'))
    await writeFile(status, 'account-b@example.invalid\n')
    expect((await scope()).selectedAuthIdentity).not.toBe(firstScope.selectedAuthIdentity)
    await expect(prepare()).rejects.toThrow('native authority changed')
    await writeFile(status, '\n')
    await expect(scope()).rejects.toThrow('native authentication')
    await writeFile(status, 'account-a@example.invalid\n')
    await publish('two')
    expect((await scope()).scopeToken).not.toBe(firstScope.scopeToken)
    await expect(prepare()).rejects.toThrow('native authority changed')
  } finally { await rm(root, { recursive: true, force: true }) }
})
