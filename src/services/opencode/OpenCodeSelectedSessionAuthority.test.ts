import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { buildOpenCodeExpectedBehaviorEvidence } from './OpenCodeExpectedBehaviorFingerprint.js'
import { OpenCodeProfileManager, resolveOpenCodeProfileScope } from './OpenCodeProfileManager.js'
import { OpenCodeSessionBridge } from './OpenCodeSessionBridge.js'
import { upsertOpenCodeAuthCredential, removeOpenCodeAuthCredential } from './OpenCodeAuthStore.js'
import type { OpenCodeHostHandle, OpenCodeSessionRecord } from './types.js'

test('materialized selected sessions preserve sealed authority across repeated send, reconcile, preview and refresh', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-selected-session-'))
  const keys = ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
    'CLAUDE_MULTIMODEL_DATA_HOME', 'CLAUDE_MULTIMODEL_CACHE_HOME', 'DEEPINFRA_API_KEY',
    'CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND', 'CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY',
    'CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ARGS_JSON', 'CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENV_JSON',
    'CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL', 'OPENCODE_CONFIG_CONTENT'] as const
  const original = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  try {
    for (const key of keys) delete process.env[key]
    const project = path.join(root, 'project')
    await mkdir(project)
    await writeFile(path.join(project, 'AGENTS.md'), 'stable behavior')
    const mcpEntry = path.join(root, 'mcp.js')
    await writeFile(mcpEntry, '')
    Object.assign(process.env, {
      HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'),
      XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'),
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
    const host: OpenCodeHostHandle = {
      hostKey: 'sandbox-host', profileRootKey: profile.profileRootKey,
      projectPath: profile.projectPath, projectBehaviorFingerprint: profile.projectBehaviorFingerprint,
      baseUrl: 'http://127.0.0.1:1', port: 1, pid: 123, version: '1.18.4', state: 'healthy',
      profile, resolvedConfigFingerprint: profile.managedConfigFingerprint, diagnostics: [],
    }
    const normalizedConfig = { ...structuredClone(profile.managedConfig), command: {},
      agent: Object.fromEntries(Object.entries(profile.managedConfig.agent as Record<string, object>)
        .map(([name, agent]) => [name, { ...agent, options: {} }])) }
    let liveConfig: Record<string, unknown> = normalizedConfig
    let connected = true
    let saved: OpenCodeSessionRecord | null = null
    let writes = 0
    let broadReads = 0
    let reads = 0
    let released = 0
    let prompts = 0
    let previews = 0
    let messageReads = 0
    let contaminatedHost = false
    let sessionsCreated = 0
    let replaceDuringRetain = false
    const bridge = new OpenCodeSessionBridge({
      prepareProfile: async () => profile,
      sessionStore: { get: async () => saved, upsert: async record => {
        saved = record; writes += 1; return 'created'
      }, markStale: async () => { throw new Error('unexpected stale write') } },
      hostManager: {
        ensureHost: async input => {
          expect(input?.resolveConfigFingerprint).toBe(false)
          expect(input?.prewarmManagedSubscriptionPlugins).toBe(false)
          // Models persistent adoption: the default broad path would change
          // domains even though the live selected config is unchanged.
          if (input?.resolveConfigFingerprint !== false) broadReads += 1
          return { ...host, resolvedConfigFingerprint: contaminatedHost
            || input?.resolveConfigFingerprint !== false ? 'broad-live-digest' : profile.managedConfigFingerprint }
        },
        releaseHost: async () => { released += 1 }, retainHostLease: async () => {
          if (replaceDuringRetain && saved) {
            saved = { ...saved, runId: 'run-2', opencodeSessionId: 'replacement-session' }
          }
        },
        refreshResolvedConfigFingerprint: async () => { broadReads += 1; return 'broad-live-digest' },
      },
      clientFactory: { create: () => ({
        getConfig: async () => { reads += 1; return liveConfig },
        createSession: async () => { sessionsCreated += 1; return { id: 'selected-session' } },
        getSessionMessages: async () => { messageReads += 1; return [] },
        getSessionStatus: async () => ({}), getPermissions: async () => [],
        promptSessionAsync: async () => { prompts += 1 },
      }) as never },
      mcpManager: { ensureAppMcp: async () => ({ mcp: {}, summary: {
        serverName: 'agent-teams', matchedServerName: 'agent-teams', status: 'present', connected,
        launchSource: null, availableServerNames: ['agent-teams'], diagnostics: [],
      } }) },
      oauthRefreshCoordinator: { ensureFreshForPrompt: (async () => ({ refreshed: false })) as never },
      previewObserver: { observeSession: (async () => {
        previews += 1
        return { sessionId: 'selected-session', previewOutcome: 'observed', profileAuthState: 'ok',
          diagnostics: [] }
      }) as never },
    })
    const evidence = await buildOpenCodeExpectedBehaviorEvidence({ profile, fullModelId: selectedModel,
      effectiveConfigFingerprint: profile.managedConfigFingerprint })
    const materialized = await bridge.materializeSessionOnHost({
      teamId: 'sandbox', laneId: 'selected', memberName: 'member', selectedModel, runId: 'run-1',
      host, signal: new AbortController().signal, remainingMs: () => 10_000,
      expectedBehaviorFingerprint: evidence.expectedBehaviorFingerprint,
      expectedBootstrapForSession: () => ({ messageID: 'msg', contextHash: 'context',
        briefingHash: 'briefing', agent: 'teammate' }),
    })
    const record = materialized.record
    const sealed = structuredClone(record)
    const reuseInput = { teamId: 'sandbox', laneId: 'selected', memberName: 'member',
      selectedModel, projectPath: profile.projectPath, preparedProfile: profile, runId: 'run-1' }
    expect((await bridge.ensureSession(reuseInput)).opencodeSessionId).toBe(record.opencodeSessionId)
    for (let i = 0; i < 5; i += 1) {
      await bridge.promptAsync(record, { text: 'sandbox verify only' })
      expect((await bridge.reconcileSession(record)).summary.reconcileOutcome).toBe('reconciled')
      expect((await bridge.observePreview(record)).summary.previewOutcome).toBe('observed')
      const beforeRefreshWrites = writes
      expect(await bridge.refreshSessionEnvironment(record)).toBe(record)
      expect(writes).toBe(beforeRefreshWrites)
    }
    expect(reads).toBe(21)
    expect(prompts).toBe(5)
    expect(previews).toBe(5)
    expect(broadReads).toBe(0)
    expect(record).toEqual(sealed)
    replaceDuringRetain = true
    await expect(bridge.promptAsync(record, { text: 'must not cross replacement' }))
      .rejects.toThrow('no longer active')
    replaceDuringRetain = false
    saved = record
    const effects = () => [prompts, previews, messageReads, writes]
    const before = effects()
    await expect(bridge.ensureSession({ ...reuseInput, fresh: true })).rejects.toThrow('relaunch the lane')
    await expect(bridge.ensureSession({ ...reuseInput, runId: 'stale-run' })).rejects.toThrow('relaunch the lane')
    expect(sessionsCreated).toBe(1)
    liveConfig = { ...normalizedConfig, permission: { '*': 'allow', secretTool: 'allow' } }
    await expect(bridge.promptAsync(record, { text: 'must not send' })).rejects.toThrow('live authority changed')
    liveConfig = normalizedConfig
    connected = false
    await expect(bridge.observePreview(record)).rejects.toThrow('live authority changed')
    connected = true
    await writeFile(path.join(project, 'AGENTS.md'), 'changed behavior')
    await expect(bridge.refreshSessionEnvironment(record)).rejects.toThrow('live authority changed')
    await writeFile(path.join(project, 'AGENTS.md'), 'stable behavior')
    await upsertOpenCodeAuthCredential({ authPath: profile.managedAuthPath,
      providerId: 'deepinfra', credential: { type: 'api', key: 'changed-sandbox-key' } })
    await expect(bridge.promptAsync(record, { text: 'must not send' })).rejects.toThrow('live authority changed')
    await removeOpenCodeAuthCredential({ authPath: profile.managedAuthPath, providerId: 'deepinfra' })
    for (const invalid of [{ ...record, expectedBehaviorFingerprint: undefined },
      { ...record, resolvedBehaviorFingerprint: 'broad-live-digest' }]) {
      await expect(bridge.refreshSessionEnvironment(invalid)).rejects.toThrow('relaunch the lane')
    }
    contaminatedHost = true
    await expect(bridge.promptAsync(record, { text: 'must not send' })).rejects.toThrow('fingerprint domain changed')
    expect(effects()).toEqual(before)
    expect(record).toEqual(sealed)
    expect(broadReads).toBe(0)
    expect(released).toBe(27)
    const readsBeforeStop = reads
    for (const current of [{ ...record, stoppedAt: new Date().toISOString() },
      null, { ...record, runId: 'next-run', opencodeSessionId: 'next-session' }]) {
      saved = current
      await expect(bridge.promptAsync(record, { text: 'old observer must not send' }))
        .rejects.toThrow('no longer active')
    }
    expect(reads).toBe(readsBeforeStop)
    expect(released).toBe(27)
    expect(effects()).toEqual(before)
  } finally {
    for (const key of keys) {
      if (original[key] === undefined) delete process.env[key]
      else process.env[key] = original[key]
    }
    await rm(root, { recursive: true, force: true })
  }
})
