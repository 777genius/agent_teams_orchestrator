import { expect, test } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { readProcessStartTimeMs } from '../../utils/processKill.js'
import { buildOpenCodeExpectedBehaviorEvidence } from './OpenCodeExpectedBehaviorFingerprint.js'
import { OpenCodeProfileManager, resolveOpenCodeProfileScope, buildManagedConfigFingerprint } from './OpenCodeProfileManager.js'
import { OpenCodeHostManager } from './OpenCodeHostManager.js'
import { OpenCodeSessionBridge } from './OpenCodeSessionBridge.js'
import type { OpenCodeSessionRecord } from './types.js'

function fixtureProviders(value: unknown): Record<string, unknown> {
  if (value === undefined) return {}
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected a provider map in the prepared fixture')
  }
  return value as Record<string, unknown>
}

async function stopFixtureChild(child: ChildProcess): Promise<void> {
  // Failed spawns have no PID and emit close, but never exit.
  if (child.pid == null || child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolve, reject) => {
    const onExit = () => {
      clearTimeout(timer)
      child.removeListener('exit', onExit)
      resolve()
    }
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit)
      reject(new Error(`Fixture child ${child.pid} did not exit within 2000 ms after SIGKILL`))
    }, 2000)
    child.once('exit', onExit)
    try {
      child.kill('SIGKILL')
    } catch (error) {
      clearTimeout(timer)
      child.removeListener('exit', onExit)
      reject(error)
    }
  })
}

// A fake HTTP binary tests our real registry/reader/bridge, not upstream conformance.
test('selected persistent host adopts through real HTTP authority and remains stoppable after drift', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-selected-adoption-TEST-'))
  const keys = ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
    'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'TMPDIR', 'TMP', 'TEMP',
    'CLAUDE_MULTIMODEL_DATA_HOME', 'CLAUDE_MULTIMODEL_CACHE_HOME', 'DEEPINFRA_API_KEY',
    'CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND', 'CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY',
    'CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ARGS_JSON', 'CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENV_JSON',
    'CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL',
    ...Object.keys(process.env).filter(key => key.startsWith('OPENCODE_'))]
  const original = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  const children: ChildProcess[] = []
  try {
    for (const key of keys) delete process.env[key]
    const project = path.join(root, 'project')
    await mkdir(project)
    await writeFile(path.join(project, 'AGENTS.md'), 'stable behavior')
    const mcpEntry = path.join(root, 'mcp.js')
    await writeFile(mcpEntry, '')
    Object.assign(process.env, {
      HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'),
      APPDATA: path.join(root, 'appdata'), LOCALAPPDATA: path.join(root, 'localappdata'),
      XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'),
      XDG_CACHE_HOME: path.join(root, 'cache'), XDG_STATE_HOME: path.join(root, 'state'),
      TMPDIR: root, TMP: root, TEMP: root,
      CLAUDE_MULTIMODEL_DATA_HOME: path.join(root, 'app-data'),
      CLAUDE_MULTIMODEL_CACHE_HOME: path.join(root, 'app-cache'),
      DEEPINFRA_API_KEY: 'sandbox-only-key',
      CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND: process.execPath,
      CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY: mcpEntry,
    })
    const selectedModel = 'deepinfra/chosen'
    const profileScope = await resolveOpenCodeProfileScope({ projectPath: project,
      purpose: 'launch_runtime', selectedModel })
    const profile = await new OpenCodeProfileManager().prepareProfile(project, { profileScope })
    const model = { name: 'Sandbox', structured_output: true, limit: { context: 8192, output: 1024 } }
    profile.managedConfig.provider = { ...fixtureProviders(profile.managedConfig.provider), deepinfra: { models: { chosen: model } } }
    profile.managedConfigFingerprint = buildManagedConfigFingerprint(profile.managedConfig)
    const config = structuredClone(profile.managedConfig)
    const liveModel = { name: model.name, limit: { ...model.limit } }
    config.provider = { ...fixtureProviders(config.provider), deepinfra: { models: { chosen: liveModel } } }
    // Independent effective policies: not derived from the production comparator
    // or the lossy /config representation.
    const rule = (permission: string, action: string) => ({ permission, pattern: '*', action })
    const mcpRules = ['agent-teams_*', 'agent_teams_*', 'mcp__agent-teams__*', 'mcp__agent_teams__*']
      .map(permission => rule(permission, 'allow'))
    const truncate = { permission: 'external_directory',
      pattern: path.join(profile.env.XDG_DATA_HOME!, 'opencode', 'tool-output', '*'), action: 'allow' }
    const effectiveAgents = [
      { name: 'teammate', mode: 'primary', permission: [rule('*', 'deny'),
        ...['read', 'glob', 'grep', 'list', 'lsp', 'todoread', 'todowrite', 'edit', 'bash']
          .map(permission => rule(permission, 'allow')),
        ...['task', 'external_directory', 'doom_loop'].map(permission => rule(permission, 'deny')),
        ...mcpRules, truncate] },
      { name: 'teammate-bootstrap', mode: 'primary', permission: [rule('*', 'deny'), ...mcpRules, truncate] },
      { name: 'teammate-model-probe', mode: 'primary', permission: [rule('*', 'deny'), truncate] },
    ]
    // Model /config encoding loss while /agent preserves the executable order.
    const configAgents = config.agent as Record<string, Record<string, unknown>>
    const teammatePermission = configAgents.teammate.permission as Record<string, unknown>
    configAgents.teammate.permission = Object.fromEntries(Object.entries(teammatePermission).reverse())
    const stateFile = path.join(root, 'http-state.json')
    const writeState = (liveConfig: unknown, connected = true, agents = effectiveAgents) => writeFile(stateFile,
      JSON.stringify({ config: liveConfig, connected, effectiveAgents: agents }))
    await writeState(config)
    const serverFile = path.join(root, 'fake-opencode.ts')
    await writeFile(serverFile, `
      import { readFileSync } from 'node:fs';
      const counts = { prompts: 0, sessions: 0, aborts: 0, broad: 0, agents: 0, config: 0, mcp: 0, messages: 0, previews: 0 };
      Bun.serve({ hostname: '127.0.0.1', port: Number(process.argv[2]), fetch(request) {
        const url = new URL(request.url); const route = url.pathname;
        const state = JSON.parse(readFileSync(process.argv[3], 'utf8'));
        const json = value => Response.json(value);
        if (route === '/global/health') return json({ healthy: true, version: '1.18.4' });
        if (route === '/config') { counts.config++; return json(state.config); }
        if (route === '/mcp') { counts.mcp++; return json({ 'agent-teams': { status: state.connected ? 'connected' : 'disconnected' } }); }
        if (route === '/agent') { counts.agents++; return json(state.effectiveAgents); }
        if (route === '/config/providers') { counts.broad++; return json({}); }
        if (route === '/session' && request.method === 'POST') { counts.sessions++; return json({ id: 'sandbox-session' }); }
        if (route === '/session/sandbox-session/prompt_async') { counts.prompts++; return new Response(null, { status: 204 }); }
        if (route === '/session/sandbox-session/abort') { counts.aborts++; return json(true); }
        if (route === '/session/status') return json({ 'sandbox-session': { type: 'idle' } });
        if (route === '/permission') return json([]);
        if (route === '/session/sandbox-session/message') { counts.messages++; return json([]); }
        if (route === '/event') {
          counts.previews++;
          return new Response('data: ' + JSON.stringify({ type: 'session.status',
            properties: { sessionID: 'sandbox-session', status: { type: 'idle' } } }) + '\\n\\n',
            { headers: { 'content-type': 'text/event-stream' } });
        }
        if (route === '/counts') return json(counts);
        return new Response('Unexpected endpoint', { status: 404 });
      } });
    `)
    const registryPath = path.join(root, 'registry.json')
    const managers = () => new OpenCodeHostManager({
      prepareProfile: async () => profile,
      persistentRegistryPath: registryPath,
      readProcessStartTimeMs,
      spawnHostProcess: (_profile, port) => {
        // Explicit allowlist: the child cannot inherit user credentials/config.
        const child = spawn(process.execPath, [serverFile, String(port), stateFile], {
          cwd: project, env: { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE,
            XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME,
            XDG_CACHE_HOME: path.join(root, 'cache'), TMPDIR: root }, stdio: ['ignore', 'pipe', 'pipe'],
        })
        children.push(child)
        return child
      },
    })
    const firstManager = managers()
    const first = await firstManager.ensureHost({ preparedProfile: profile,
      healthTimeoutMs: 3000, resolveConfigFingerprint: false, prewarmManagedSubscriptionPlugins: false })
    let saved: OpenCodeSessionRecord | null = null
    let writes = 0
    const store = { get: async () => saved, upsert: async (record: OpenCodeSessionRecord) => {
      saved = record; writes++; return 'created' as const
    }, markStale: async () => { throw new Error('unexpected stale write') } }
    const bridgeFor = (hostManager: OpenCodeHostManager) => new OpenCodeSessionBridge({
      prepareProfile: async () => profile, hostManager, sessionStore: store,
      oauthRefreshCoordinator: { ensureFreshForPrompt: (async () => ({ refreshed: false })) as never },
    })
    const evidence = await buildOpenCodeExpectedBehaviorEvidence({ profile, fullModelId: selectedModel,
      effectiveConfigFingerprint: profile.managedConfigFingerprint })
    const { record } = await bridgeFor(firstManager).materializeSessionOnHost({
      teamId: 'sandbox', laneId: 'selected', memberName: 'member', selectedModel, runId: 'run-1',
      host: first, signal: new AbortController().signal, remainingMs: () => 10_000,
      expectedBehaviorFingerprint: evidence.expectedBehaviorFingerprint,
      expectedBootstrapForSession: () => ({ messageID: 'msg', contextHash: 'context',
        briefingHash: 'briefing', agent: 'teammate' }),
    })
    const sealed = structuredClone(record)
    const secondManager = managers()
    const adopted = await secondManager.ensureHost({ preparedProfile: profile,
      healthTimeoutMs: 3000, resolveConfigFingerprint: false, prewarmManagedSubscriptionPlugins: false })
    expect(adopted.pid).toBe(first.pid)
    expect(adopted.hostKey).toBe(first.hostKey)
    expect(adopted.diagnostics.join(' ')).toContain('adopted persistent')
    expect(adopted.resolvedConfigFingerprint).toBe(profile.managedConfigFingerprint)
    expect(children).toHaveLength(1)
    const bridge = bridgeFor(secondManager)
    expect((await bridge.ensureSession({ teamId: 'sandbox', laneId: 'selected', memberName: 'member',
      selectedModel, projectPath: project, preparedProfile: profile, runId: 'run-1' })).opencodeSessionId)
      .toBe(record.opencodeSessionId)
    await bridge.promptAsync(record, { text: 'sandbox-only HTTP fixture' })
    expect(await bridge.refreshSessionEnvironment(record)).toBe(record)
    const counts = () => fetch(first.baseUrl + '/counts').then(response => response.json())
    for (let attempt = 0; attempt < 3; attempt++) {
      const previous = await counts()
      expect((await bridge.reconcileSession(record)).summary.reconcileOutcome).toBe('reconciled')
      const preview = await bridge.observePreview(record, { timeoutMs: 1000, idleTimeoutMs: 100 })
      expect(preview.summary.previewOutcome).toBe('observed')
      expect(preview.summary.matchedEventCount).toBe(1)
      expect(await bridge.refreshSessionEnvironment(record)).toBe(record)
      const current = await counts()
      expect(current.agents - previous.agents).toBe(3)
      expect(current.config).toBeGreaterThan(previous.config)
      expect(current.messages - previous.messages).toBe(1)
      expect(current.previews - previous.previews).toBe(1)
      expect(record).toEqual(sealed)
    }
    const invalidAgents = structuredClone(effectiveAgents)
    invalidAgents[0].permission.push(rule('bash', 'deny'))
    const writesBeforeDrift = writes
    const beforePolicyDrift = await counts()
    await writeState(config, true, invalidAgents)
    await expect(bridge.promptAsync(record, { text: 'policy drift must not send' }))
      .rejects.toThrow('live authority changed')
    const afterPolicyDrift = await counts()
    expect(afterPolicyDrift.prompts).toBe(beforePolicyDrift.prompts)
    expect(afterPolicyDrift.agents).toBe(beforePolicyDrift.agents + 1)
    expect(record).toEqual(sealed)
    await writeState(config)
    expect(await bridge.refreshSessionEnvironment(record)).toBe(record)
    expect((await counts()).agents).toBe(afterPolicyDrift.agents + 1)
    const before = await counts()
    expect(before.prompts).toBe(1)
    const changed = structuredClone(config)
    changed.provider = { ...fixtureProviders(changed.provider), deepinfra: { models: { chosen: {
      ...liveModel, limit: { ...liveModel.limit, context: liveModel.limit.context + 1 },
    } } } }
    await writeState(changed)
    await expect(bridge.promptAsync(record, { text: 'must not send' })).rejects.toThrow('live authority changed')
    await writeState(config, false)
    await expect(bridge.promptAsync(record, { text: 'must not send either' })).rejects.toThrow('live authority changed')
    await writeState(changed, false)
    const beforeStop = await counts()
    expect(await bridge.abort(record)).toBe(true)
    const after = await counts()
    expect(after.prompts).toBe(before.prompts)
    expect(after.sessions).toBe(1)
    expect(after.aborts).toBe(1)
    expect(after.config).toBe(beforeStop.config)
    expect(after.mcp).toBe(beforeStop.mcp)
    expect(after.agents).toBe(beforeStop.agents)
    expect(after.agents).toBeGreaterThan(0)
    expect(after.broad).toBe(0)
    expect(writes).toBe(writesBeforeDrift)
    const persisted = await store.get()
    expect(persisted?.managedConfigFingerprint).toBe(sealed.managedConfigFingerprint)
    expect(persisted?.resolvedBehaviorFingerprint).toBe(sealed.resolvedBehaviorFingerprint)
    expect(persisted?.expectedBehaviorFingerprint).toBe(sealed.expectedBehaviorFingerprint)
    expect(record).toEqual(sealed)
    const registry = JSON.parse(await readFile(registryPath, 'utf8'))
    expect(registry.hosts[first.hostKey].resolvedConfigFingerprint).toBe(profile.managedConfigFingerprint)
  } finally {
    try {
      await Promise.all(children.map(stopFixtureChild))
    } finally {
      for (const key of keys) {
        if (original[key] === undefined) delete process.env[key]
        else process.env[key] = original[key]
      }
    }
    // Preserve the sandbox for diagnosis if a fixture child failed to exit.
    await rm(root, { recursive: true, force: true })
  }
}, 20_000)
