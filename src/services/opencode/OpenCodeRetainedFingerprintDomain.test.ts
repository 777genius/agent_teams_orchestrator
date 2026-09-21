import { expect, test } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { readProcessStartTimeMs } from '../../utils/processKill.js'
import { OpenCodeProvisioningProbe } from './OpenCodeProvisioningProbe.js'
import { OpenCodeProfileManager, resolveOpenCodeProfileScope, buildManagedConfigFingerprint } from './OpenCodeProfileManager.js'
import { OpenCodeHostManager } from './OpenCodeHostManager.js'
import { OpenCodeSessionBridge } from './OpenCodeSessionBridge.js'
import type { OpenCodeSessionRecord } from './types.js'

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
test('fresh selected sessions retain the managed fingerprint domain', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-fingerprint-domain-TEST-'))
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
    profile.managedConfigFingerprint = buildManagedConfigFingerprint(profile.managedConfig, profile.env)
    const serverFile = path.join(root, 'fake-opencode.ts')
    await writeFile(serverFile, `
      Bun.serve({ hostname: '127.0.0.1', port: Number(process.argv[2]), fetch(request) {
        const route = new URL(request.url).pathname;
        if (route === '/global/health') return Response.json({ healthy: true, version: '1.18.4' });
        if (route === '/session' && request.method === 'POST') return Response.json({ id: 'sandbox-session' });
        if (route === '/config') return Response.json({ model: 'deepinfra/chosen' });
        if (route === '/config/providers') return Response.json({ providers: [] });
        if (route === '/agent') return Response.json([]);
        if (route === '/mcp') return Response.json({ 'agent-teams': { status: 'connected' } });
        return new Response('Unexpected endpoint', { status: 404 });
      } });
    `)
    const registryPath = path.join(root, 'registry.json')
    const managers = () => new OpenCodeHostManager({ prepareProfile: async () => profile,
      persistentRegistryPath: registryPath, readProcessStartTimeMs,
      spawnHostProcess: (_profile, port) => {
        const child = spawn(process.execPath, [serverFile, String(port)], {
          cwd: project, env: { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
            XDG_DATA_HOME: process.env.XDG_DATA_HOME, TMPDIR: root }, stdio: ['ignore', 'pipe', 'pipe'],
        })
        children.push(child)
        return child
      },
    })
    const firstManager = managers()
    let saved: OpenCodeSessionRecord | null = null
    const bridge = new OpenCodeSessionBridge({ prepareProfile: async () => profile, hostManager: firstManager,
      sessionStore: { get: async () => saved, upsert: async record => { saved = record; return 'created' },
        markStale: async () => { throw new Error('unexpected stale write') } },
    })
    const record = await bridge.ensureSession({ teamId: 'sandbox', laneId: 'selected', memberName: 'member',
      selectedModel, projectPath: project, preparedProfile: profile, runId: 'run-1' })
    // Before the fix this assertion exposes the broad HTTP inventory hash sealed by ensureSession.
    expect(record.resolvedBehaviorFingerprint).toBe(profile.managedConfigFingerprint)
    const probeFor = (hostManager: OpenCodeHostManager) => new OpenCodeProvisioningProbe({ hostManager,
      inventoryService: { probe: async () => ({ detected: true, projectPath: profile.projectPath, profile,
        binaryPath: serverFile, version: '1.18.4', connectedProviders: [], availableProviders: ['deepinfra'],
        agents: [], authStorePath: null, models: [selectedModel], probeError: null, diagnostics: [] }) },
    })
    const strict = await probeFor(managers()).probeRetainingHost(project, { selectedModel })
    expect(strict.snapshot.hostHealthy).toBe(true)
    expect(strict.host?.pid).toBe(record.runtimePid!)
    expect(children).toHaveLength(1)
    await strict.release(true)
    const registry = JSON.parse(await readFile(registryPath, 'utf8'))
    expect(registry.hosts[record.hostKey].resolvedConfigFingerprint).toBe(profile.managedConfigFingerprint)
    // Simulate a previously persisted mixed-domain record. Adoption must never repair its evidence.
    registry.hosts[record.hostKey].resolvedConfigFingerprint = 'f'.repeat(64)
    await writeFile(registryPath, JSON.stringify(registry))
    await expect(probeFor(managers()).probeRetainingHost(project, { selectedModel }))
      .rejects.toThrow('retained host/profile fingerprint mismatch')
    expect(JSON.parse(await readFile(registryPath, 'utf8')).hosts[record.hostKey].resolvedConfigFingerprint)
      .toBe('f'.repeat(64))
    expect(children).toHaveLength(1)
    // The same stale record with an actually dead, fixture-owned PID must be replaced.
    const oldChild = children[0]
    await stopFixtureChild(oldChild)
    const fresh = await probeFor(managers()).probeRetainingHost(project, { selectedModel })
    expect(fresh.snapshot.hostHealthy).toBe(true)
    expect(fresh.host?.pid).not.toBe(record.runtimePid!)
    expect(fresh.host?.resolvedConfigFingerprint).toBe(profile.managedConfigFingerprint)
    expect(children).toHaveLength(2)
    await fresh.release(true)
    // A long-lived manager has no child exit listener for an adopted process.
    const cachedManager = managers()
    const cached = await probeFor(cachedManager).probeRetainingHost(project, { selectedModel })
    expect(cached.host?.pid).toBe(fresh.host?.pid)
    expect(children).toHaveLength(2)
    await cached.release(true)
    await stopFixtureChild(children[1])
    const recovered = await probeFor(cachedManager).probeRetainingHost(project, { selectedModel })
    expect(recovered.snapshot.hostHealthy).toBe(true)
    expect(recovered.host?.pid).not.toBe(cached.host?.pid)
    expect(recovered.host?.resolvedConfigFingerprint).toBe(profile.managedConfigFingerprint)
    expect(children).toHaveLength(3)
    await recovered.release(true)
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
