import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtemp, realpath, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { readProcessStartTimeMs } from '../../utils/processKill.js'
import * as processIdentity from '../../utils/processKill.js'
const realReadProcessBirth = processIdentity.readProcessStartTimeMs
import { OpenCodeProfileManager, resolveOpenCodeProfileScope } from './OpenCodeProfileManager.js'
import { OpenCodeSessionBridge } from './OpenCodeSessionBridge.js'
import { buildOpenCodeExpectedBehaviorEvidence } from './OpenCodeExpectedBehaviorFingerprint.js'
import { effectiveAgentsFixture } from './OpenCodeEffectiveAgents.test-support.js'
import { OpenCodeExecutionProbe } from './OpenCodeExecutionProbe.js'
import { OpenCodeOAuthRefreshCoordinator } from './OpenCodeOAuthRefreshCoordinator.js'
import { resolveClaudeMultimodelPaths } from './OpenCodeManagedPaths.js'
import { readOpenCodeAuthCredential, readOpenCodeSavedAuthStore, upsertOpenCodeAuthCredential } from './OpenCodeAuthStore.js'
import type { OpenCodeHostHandle, OpenCodePreparedProfile, OpenCodeSessionRecord } from './types.js'

const c0 = { type: 'oauth', access: 'synthetic-access-0', refresh: 'single-use-0', expires: 1000, accountId: 'test-account' }
const c1 = { ...c0, access: 'synthetic-access-1', refresh: 'single-use-1', expires: 900000 }
const c2 = { ...c0, access: 'synthetic-access-2', refresh: 'single-use-2', expires: 1900000 }

describe('scoped OAuth native durability integration', () => {
  let root: string, project: string, env: NodeJS.ProcessEnv, saved: NodeJS.ProcessEnv
  let now: number
  let processBirthMock: { mockRestore(): void } | undefined
  const manager = new OpenCodeProfileManager()
  const read = (authPath: string) => readOpenCodeAuthCredential({ authPath, providerId: 'xai' })
  const readSaved = async (global = path.join(env.CLAUDE_MULTIMODEL_DATA_HOME!, 'opencode', 'auth.json')) =>
    (await readOpenCodeSavedAuthStore({ globalAuthPath: global, env, sourceAuthPaths: [global,
      path.join(env.XDG_DATA_HOME!, 'opencode', 'auth.json'), path.join(env.HOME!, '.local', 'share', 'opencode', 'auth.json')] })).xai ?? null
  const save = (authPath: string, credential: typeof c0) => upsertOpenCodeAuthCredential({ authPath, providerId: 'xai', credential })
  const prepare = async () => manager.prepareProfile(project, {
    profileScope: await resolveOpenCodeProfileScope({ projectPath: project, selectedModel: 'xai/grok-4.3', purpose: 'launch_runtime', env }),
  })
  beforeEach(async () => {
    // These synthetic hosts run in this same test process, whose birth cannot
    // change mid-test. Keep repeated OS shell startup out of coordinator timing;
    // PendingOAuthSession/CheckpointLifetime exercise real process replacement.
    const birth = await realReadProcessBirth(process.pid)
    expect(birth).toBeGreaterThan(0)
    processBirthMock = spyOn(processIdentity, 'readProcessStartTimeMs').mockImplementation(
      (pid, platform) => pid === process.pid && (platform === undefined || platform === process.platform)
        ? Promise.resolve(birth) : realReadProcessBirth(pid, platform))
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'opencode-scoped-durability-TEST-')))
    project = path.join(root, 'project')
    await mkdir(project)
    env = { HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'),
      XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'),
      XDG_CACHE_HOME: path.join(root, 'cache'), XDG_STATE_HOME: path.join(root, 'state'),
      APPDATA: path.join(root, 'roaming'), LOCALAPPDATA: path.join(root, 'local'),
      TMPDIR: path.join(root, 'tmp'), TMP: path.join(root, 'tmp'), TEMP: path.join(root, 'tmp'),
      CLAUDE_MULTIMODEL_DATA_HOME: path.join(root, 'app-data'), CLAUDE_MULTIMODEL_CACHE_HOME: path.join(root, 'app-cache'),
      CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL: 'http://127.0.0.1:1/mcp' }
    await mkdir(env.TMPDIR!)
    saved = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]))
    Object.assign(process.env, env)
    // Every managed path participates in scope identity, including config/log/
    // temp. Default session resolution and fresh children read process.env;
    // their inputs must match the explicitly captured fixture on every OS.
    expect(resolveClaudeMultimodelPaths(process.env)).toEqual(resolveClaudeMultimodelPaths(env))
    now = 2000
    await save(manager.getGlobalAuthPath(), c0)
  })
  afterEach(async () => {
    processBirthMock?.mockRestore()
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(root, { recursive: true, force: true })
  })
  function engine(beforeNative?: () => Promise<void>, afterNative?: () => Promise<void>) {
    let active!: OpenCodePreparedProfile
    let submittedProbeId: string | undefined
    const consumed = new Set<string>()
    const seen: string[] = []
    const probe = new OpenCodeExecutionProbe({
      hostManager: {
        ensureHost: async input => {
          active = input.preparedProfile ?? await manager.prepareProfile(input.projectPath, input.profileOptions)
          seen.push(active.managedAuthPath)
          return { profile: active, hostKey: `test-${active.scopeToken}`, baseUrl: 'http://127.0.0.1:1',
            profileRootKey: active.profileRootKey, version: '1.18.4', pid: process.pid,
            processStartedAtMs: await readProcessStartTimeMs(process.pid) } as OpenCodeHostHandle
        }, releaseHost: async () => {},
      },
      clientFactory: { create: () => ({
        createSession: async () => ({ id: 'probe' }), getSession: async () => ({ id: 'probe' }),
        getSessionStatus: async () => ({ probe: 'idle' }), getPermissions: async () => [],
        getSessionMessages: async () => submittedProbeId ? [
          { info: { id: submittedProbeId, role: 'user', sessionID: 'probe' }, parts: [] },
          { info: { id: 'assistant', parentID: submittedProbeId, role: 'assistant', providerID: 'xai',
          modelID: 'grok-4.3', sessionID: 'probe', time: { created: 101, completed: 110 } },
          parts: [{ type: 'text', text: 'PONG' }] }] : [],
        promptSessionAsync: async (_id: string, body: { messageID: string }) => {
          submittedProbeId = body.messageID
          const current = await read(active.managedAuthPath)
          await beforeNative?.()
          expect(consumed.has(String(current?.refresh))).toBe(false)
          consumed.add(String(current?.refresh))
          expect([c0.refresh, c1.refresh]).toContain(String(current?.refresh))
          await writeFile(active.managedAuthPath, JSON.stringify({ xai: current?.refresh === c0.refresh ? c1 : c2 }))
          await afterNative?.()
        },
        abortSession: async () => true, deleteSession: async () => true,
      }) as never },
    })
    const coordinator = new OpenCodeOAuthRefreshCoordinator({ nowMs: () => now, probeModel: probe.probeModel.bind(probe) })
    return { coordinator, probe, seen, consumed, secondCoordinator: new OpenCodeOAuthRefreshCoordinator({
      nowMs: () => now, probeModel: probe.probeModel.bind(probe),
    }) }
  }

  test('real coordinator probes separate P0, saves C1, fresh process prepares C1 and next cycle saves C2', async () => {
    const launch = await prepare()
    const { coordinator, seen, consumed } = engine()
    expect(await coordinator.ensureFreshForPrompt({ selectedModel: 'xai/grok-4.3', projectPath: project, profile: launch }))
      .toEqual({ checked: true, refreshed: true })
    expect(seen[0]).not.toBe(launch.managedAuthPath)
    expect(await read(launch.managedAuthPath)).toEqual(c0)
    expect(await readSaved()).toEqual(c1)
    const script = `import { OpenCodeProfileManager, resolveOpenCodeProfileScope } from ${JSON.stringify(path.join(import.meta.dir, 'OpenCodeProfileManager.ts'))};
      import { readOpenCodeAuthCredential } from ${JSON.stringify(path.join(import.meta.dir, 'OpenCodeAuthStore.ts'))};
      import { resolveClaudeMultimodelPaths } from ${JSON.stringify(path.join(import.meta.dir, 'OpenCodeManagedPaths.ts'))};
      const projectPath = process.argv[1];
      const profileScope = await resolveOpenCodeProfileScope({ projectPath, selectedModel: 'xai/grok-4.3', purpose: 'launch_runtime' });
      const p = await new OpenCodeProfileManager().prepareProfile(projectPath, { profileScope });
      const c = await readOpenCodeAuthCredential({ authPath: p.managedAuthPath, providerId: 'xai' });
      process.stdout.write(JSON.stringify({ credential: c, paths: resolveClaudeMultimodelPaths() }));`
    // Windows environment names are case-insensitive. Remove inherited aliases
    // before adding canonical fixture keys so the child gets one value per key.
    const fixtureKeys = new Set(Object.keys(env).map(key => key.toUpperCase()))
    const inheritedEnv = { ...process.env, home: path.join(root, 'foreign-home'),
      AppData: path.join(root, 'foreign-roaming'), LocalAppData: path.join(root, 'foreign-local'),
      Temp: path.join(root, 'foreign-temp') }
    const childEnv = { ...Object.fromEntries(Object.entries(inheritedEnv)
      .filter(([key]) => !fixtureKeys.has(key.toUpperCase()))), ...env }
    for (const key of fixtureKeys) {
      expect(Object.keys(childEnv).filter(candidate => candidate.toUpperCase() === key)).toEqual([key])
    }
    const child = Bun.spawn([process.execPath, '-e', script, project], { env: childEnv, stdout: 'pipe', stderr: 'pipe' })
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect(stderr).toBe('')
    expect(exit).toBe(0)
    expect(JSON.parse(stdout)).toEqual({ credential: c1, paths: resolveClaudeMultimodelPaths(env) })
    const nextLaunch = await prepare()
    expect(nextLaunch.scopeToken).not.toBe(launch.scopeToken)
    expect(await read(nextLaunch.managedAuthPath)).toEqual(c1)
    now = c1.expires + 1
    expect(await coordinator.ensureFreshForPrompt({ selectedModel: 'xai/grok-4.3', projectPath: project, profile: nextLaunch }))
      .toEqual({ checked: true, refreshed: true })
    expect(await readSaved()).toEqual(c2)
    expect(consumed.size).toBe(2)
  })

  test('a throwing native probe still saves its proven terminal C1 before returning failure', async () => {
    const launch = await prepare()
    const { coordinator, consumed } = engine(undefined, async () => { throw new Error('TEST HTTP result lost after terminal native refresh') })
    await expect(coordinator.ensureFreshForPrompt({ selectedModel: 'xai/grok-4.3', projectPath: project, profile: launch }))
      .rejects.toThrow()
    expect(consumed.size).toBe(1)
    expect(await readSaved()).toEqual(c1)
    const reopened = await prepare()
    expect(await read(reopened.managedAuthPath)).toEqual(c1)
  })

  test('saved successor rejects a different current managed temp root without retiring valid authority', async () => {
    const launch = await prepare()
    const { coordinator } = engine()
    await coordinator.ensureFreshForPrompt({ selectedModel: 'xai/grok-4.3', projectPath: project, profile: launch })
    const global = manager.getGlobalAuthPath()
    const sourceAuthPaths = [global, path.join(env.XDG_DATA_HOME!, 'opencode', 'auth.json'),
      path.join(env.HOME!, '.local', 'share', 'opencode', 'auth.json')]
    const changedEnv = { ...env, TMPDIR: path.join(root, 'other-temp') }
    expect(resolveClaudeMultimodelPaths(changedEnv).temp).not.toBe(resolveClaudeMultimodelPaths(env).temp)
    await expect(readOpenCodeSavedAuthStore({ globalAuthPath: global, sourceAuthPaths, env: changedEnv }))
      .rejects.toThrow('saved successor scope was revoked')
    await expect(resolveOpenCodeProfileScope({ projectPath: project, selectedModel: 'xai/grok-4.3',
      purpose: 'launch_runtime', env: changedEnv, cacheSnapshot: false }))
      .rejects.toThrow('selected authentication is unavailable')
    expect(await readSaved()).toEqual(c1)
    expect(await read((await prepare()).managedAuthPath)).toEqual(c1)
  })

  test.each([false, true])('actual queued coordinators reject stale C0 and fresh resolution reuses C1 (distinct roots: %s)', async distinct => {
    const firstProfile = await prepare()
    const secondProject = distinct ? path.join(root, 'second-project') : project
    if (distinct) await mkdir(secondProject)
    const secondProfile = await manager.prepareProfile(secondProject, { profileScope: await resolveOpenCodeProfileScope({
      projectPath: secondProject, selectedModel: 'xai/grok-4.3', purpose: 'launch_runtime', env,
    }) })
    expect(firstProfile.managedAuthPath === secondProfile.managedAuthPath).toBe(!distinct)
    let enter!: () => void, release!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve })
    const proceed = new Promise<void>(resolve => { release = resolve })
    const { coordinator, secondCoordinator, consumed } = engine(async () => { enter(); await proceed })
    const first = coordinator.ensureFreshForPrompt({ selectedModel: 'xai/grok-4.3', projectPath: project, profile: firstProfile })
    await entered
    const second = secondCoordinator.ensureFreshForPrompt({ selectedModel: 'xai/grok-4.3', projectPath: secondProject, profile: secondProfile })
      .then(() => null, error => error)
    release()
    expect((await first).refreshed).toBe(true)
    expect(await second).toBeInstanceOf(Error)
    expect(consumed.size).toBe(1)
    const fresh = await manager.prepareProfile(secondProject, { profileScope: await resolveOpenCodeProfileScope({
      projectPath: secondProject, selectedModel: 'xai/grok-4.3', purpose: 'launch_runtime', env,
    }) })
    expect(await read(fresh.managedAuthPath)).toEqual(c1)
    expect(await coordinator.ensureFreshForPrompt({ selectedModel: 'xai/grok-4.3', projectPath: secondProject, profile: fresh }))
      .toEqual({ checked: true, refreshed: false })
    expect(consumed.size).toBe(1)
  })

  test('new unprepared session refreshes before creating its first host/session authority', async () => {
    const { coordinator } = engine()
    let stored: OpenCodeSessionRecord | null = null
    let createdProfile: OpenCodePreparedProfile | null = null
    const bridge = new OpenCodeSessionBridge({
      oauthRefreshCoordinator: coordinator,
      sessionStore: { get: async () => stored, upsert: async record => { stored = record; return 'created' },
        markStale: async () => { throw new Error('unexpected stale write') } },
      hostManager: {
        ensureHost: async input => {
          createdProfile = input.preparedProfile!
          expect(await read(createdProfile.managedAuthPath)).toEqual(c1)
          return { profile: createdProfile, hostKey: 'fresh-host', baseUrl: 'http://test.invalid', pid: 123,
            projectPath: createdProfile.projectPath, profileRootKey: createdProfile.profileRootKey,
            projectBehaviorFingerprint: createdProfile.projectBehaviorFingerprint,
            resolvedConfigFingerprint: createdProfile.managedConfigFingerprint } as OpenCodeHostHandle
        }, releaseHost: async () => {},
      },
      clientFactory: { create: () => ({ createSession: async () => {
        expect(await readSaved()).toEqual(c1)
        return { id: 'fresh-session' }
      } }) as never },
    })
    const record = await bridge.ensureSession({ teamId: 'TEST', memberName: 'new', selectedModel: 'xai/grok-4.3',
      projectPath: project, runId: 'fresh-run' })
    expect(record.profileScope).toEqual(createdProfile!.profileScope)
    expect(record.managedAuthFingerprint).toBe(createdProfile!.managedAuthFingerprint)
    expect(record.opencodeSessionId).toBe('fresh-session')
    expect(stored).toEqual(record)
  })

  test.each(['sync', 'settled-async', 'accepted-async', 'submit-only', 'sync-throw', 'settled-async-throw', 'accepted-async-throw', 'submit-only-throw', 'sync-throw-late'])('owned %s session saves C1, rejects old sealed reuse and leaves record unchanged', async mode => {
    const profile = await prepare()
    const host = { profile, hostKey: 'owned-session-host', baseUrl: 'http://127.0.0.1:1', pid: 123, processStartedAtMs: 100,
      version: '1.18.4', projectPath: profile.projectPath, profileRootKey: profile.profileRootKey,
      projectBehaviorFingerprint: profile.projectBehaviorFingerprint, resolvedConfigFingerprint: profile.managedConfigFingerprint } as OpenCodeHostHandle
    let stored: OpenCodeSessionRecord | null = null
    let nativeCalls = 0
    let completeAcceptedNative: (() => Promise<void>) | null = null
    let submittedMessageId: string | undefined
    let nativeTerminal = !mode.endsWith('-late')
    const rotate = async () => {
      nativeCalls += 1
      expect(await read(profile.managedAuthPath)).toEqual(c0)
      await writeFile(profile.managedAuthPath, JSON.stringify({ xai: c1 }))
    }
    const bridge = new OpenCodeSessionBridge({
      oauthRefreshCoordinator: new OpenCodeOAuthRefreshCoordinator({ nowMs: () => 0, refreshSkewMs: 0 }),
      sessionStore: { get: async () => stored, upsert: async record => { stored = record; return 'created' },
        markStale: async () => { throw new Error('unexpected stale write') } },
      hostManager: {
        ensureHost: async () => host, releaseHost: async () => {},
        resolveOwnedSessionEndpoint: async () => ({ baseUrl: host.baseUrl, pid: host.pid }),
      },
      clientFactory: { create: () => ({
        getConfig: async () => structuredClone(profile.managedConfig),
        listAgents: async () => effectiveAgentsFixture(profile.managedConfig, profile.env.XDG_DATA_HOME!),
        createSession: async () => ({ id: 'owned-session' }),
        getSessionMessages: async () => nativeCalls && submittedMessageId ? [
          { info: { id: submittedMessageId, role: 'user' }, parts: [] },
          { info: { id: 'reply', role: 'assistant', parentID: submittedMessageId,
            providerID: 'xai', modelID: 'grok-4.3', time: { completed: 1 } }, parts: [] },
        ].slice(0, nativeTerminal ? 2 : 1) : [],
        getSessionStatus: async () => ({ 'owned-session': 'idle' }), getPermissions: async () => [],
        sendSessionMessage: async (_id: string, body: { messageID: string }) => {
          submittedMessageId = body.messageID
          await rotate(); if (mode.includes('-throw')) throw new Error('TEST response lost after consumption'); return { info: { id: 'reply', time: { completed: 1 } }, parts: [] }
        },
        promptSessionAsync: async (_id: string, body: { messageID: string }) => {
          submittedMessageId = body.messageID
          if (mode === 'accepted-async' || mode === 'submit-only') completeAcceptedNative = rotate
          else { await rotate(); if (mode.includes('-throw')) throw new Error('TEST response lost after consumption') }
        },
      }) as never },
      mcpManager: { ensureAppMcp: async () => ({ summary: {
        matchedServerName: 'agent-teams', connected: true, status: 'present', diagnostics: [],
      } }) as never },
      turnSettledObserver: { observe: input => ({
        runtimePromptMessageId: input.runtimePromptMessageId!, turnId: input.runtimePromptMessageId!,
        markPromptSubmitting: () => {}, markPromptAcceptedByEndpoint: () => {}, markPromptRejectedByEndpoint: () => {},
        waitForSettled: async () => ({ outcome: 'success', sessionId: 'owned-session',
          runtimePromptMessageId: input.runtimePromptMessageId! }) as never,
        dispose: () => {},
      }) },
    })
    const evidence = await buildOpenCodeExpectedBehaviorEvidence({ profile, fullModelId: 'xai/grok-4.3',
      effectiveConfigFingerprint: profile.managedConfigFingerprint })
    const { record } = await bridge.materializeSessionOnHost({
      teamId: 'TEST', laneId: 'primary', memberName: 'owned', selectedModel: 'xai/grok-4.3', runId: 'run-1', host,
      signal: new AbortController().signal, remainingMs: () => 10000,
      expectedBehaviorFingerprint: evidence.expectedBehaviorFingerprint,
      expectedBootstrapForSession: () => ({ messageID: 'bootstrap', contextHash: 'context', briefingHash: 'briefing', agent: 'teammate' }),
    })
    const sealed = structuredClone(record)
    if (mode.includes('-throw')) {
      const action = mode.startsWith('sync-throw') ? bridge.sendMessage(record, { text: 'TEST failing native rotation' })
        : mode === 'settled-async-throw' ? bridge.promptAsyncWithTurnSettled(record, { text: 'TEST failing native rotation' })
        : mode === 'accepted-async-throw' ? bridge.promptAsyncUntilAccepted(record, { text: 'TEST failing native rotation' })
        : bridge.promptAsync(record, { text: 'TEST failing native rotation' })
      await expect(action).rejects.toThrow(nativeTerminal ? 'TEST response lost after consumption' : 'settlement is unconfirmed')
      if (!nativeTerminal) {
        expect(await readSaved()).toEqual(c0)
        expect(await Bun.file(`${manager.getGlobalAuthPath()}.agent-teams-xai-oauth-save.json`).exists()).toBe(true)
        nativeTerminal = true
        await expect(bridge.sendMessage(record, { text: 'recover then reject old seal' })).rejects.toThrow('relaunch')
      }
    } else if (mode === 'sync') await bridge.sendMessage(record, { text: 'TEST native rotation' })
    else if (mode === 'settled-async') await bridge.promptAsyncWithTurnSettled(record, { text: 'TEST native rotation' })
    else {
      if (mode === 'submit-only') await bridge.promptAsync(record, { text: 'TEST native rotation' })
      else await bridge.promptAsyncUntilAccepted(record, { text: 'TEST native rotation' })
      expect(nativeCalls).toBe(0)
      // Acceptance must remain earlier than native completion. A second
      // operation cannot consume the pending predecessor. Reconciliation then
      // publishes only this exact terminal prompt, without renewing its seal.
      await expect(bridge.sendMessage(record, { text: 'pending must not send' })).rejects.toThrow('pending')
      expect(nativeCalls).toBe(0)
      await completeAcceptedNative!()
      await expect(bridge.sendMessage(record, { text: 'old seal after completion' })).rejects.toThrow('relaunch')
    }
    expect(await readSaved()).toEqual(c1)
    expect(record).toEqual(sealed)
    expect(stored).toEqual(sealed)
    await expect(bridge.sendMessage(record, { text: 'old run must not send' })).rejects.toThrow('relaunch')
    expect(nativeCalls).toBe(1)
    const fresh = await prepare()
    expect(fresh.scopeToken).not.toBe(profile.scopeToken)
    expect(await read(fresh.managedAuthPath)).toEqual(c1)
  })

  test('cancelled native C0 consumption remains reusable by a newly resolved launch without login', async () => {
    const launch = await prepare()
    const controller = new AbortController()
    await expect(manager.withOwnedOAuthRefresh({
      profile: launch,
      abortSignal: controller.signal,
      assertHostOwnership: async () => {},
      operation: async () => {
        await writeFile(launch.managedAuthPath, JSON.stringify({ xai: c1 }))
        controller.abort(new Error('synthetic cancellation after native rotation'))
      },
    })).rejects.toThrow('synthetic cancellation')
    // This is required saved reuse, not merely preservation of unreachable C1
    // bytes in the old scope. Keep this rejection until owned recovery exists.
    const reopened = await prepare()
    expect(await read(reopened.managedAuthPath)).toEqual(c1)
    expect(await readSaved()).toEqual(c1)
  })

  test('saved destination and probe environment use captured data root after ambient source switch', async () => {
    const launch = await prepare()
    const global = manager.getGlobalAuthPath()
    process.env.CLAUDE_MULTIMODEL_DATA_HOME = path.join(root, 'foreign-app')
    const foreignGlobal = manager.getGlobalAuthPath()
    await save(foreignGlobal, { ...c0, refresh: 'foreign' })
    const before = await readFile(foreignGlobal, 'utf8')
    const { coordinator } = engine()
    await coordinator.ensureFreshForPrompt({ selectedModel: 'xai/grok-4.3', projectPath: project, profile: launch })
    expect(await readSaved(global)).toEqual(c1)
    expect(await readFile(foreignGlobal, 'utf8')).toBe(before)
  })
})
