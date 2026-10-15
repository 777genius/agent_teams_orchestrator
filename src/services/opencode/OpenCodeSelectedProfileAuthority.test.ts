import type { OpenCodeOAuthNativeProbeOwner } from './OpenCodeAuthStore.js'
import * as processIdentity from '../../utils/processKill.js'
import { OpenCodeExecutionProbe } from './OpenCodeExecutionProbe.js'
import { buildOpenCodeExecutionProof, validateOpenCodeExecutionProof } from './OpenCodeExecutionProof.js'
import {
  buildOpenCodeExpectedBehaviorEvidence,
  computeOpenCodeExpectedBehaviorFingerprint,
} from './OpenCodeExpectedBehaviorFingerprint.js'
import { openCodeOAuthSuccessorPath, readOpenCodeAuthCredential, upsertOpenCodeAuthCredential } from './OpenCodeAuthStore.js'
import { effectiveAgentsFixture } from './OpenCodeEffectiveAgents.test-support.js'
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { OpenCodeProfileManager, assertOpenCodePreparedProfileScope, resolveOpenCodeProfileScope, buildManagedConfigFingerprint } from './OpenCodeProfileManager.js'
import { refreshSelectedProfileAuthority, type OpenCodeAuthorityRejection } from './OpenCodeSelectedProfileAuthority.js'
import type { OpenCodePhaseContext } from './OpenCodeRuntimeDeadline.js'
import type { OpenCodeExpectedBehaviorEvidence, OpenCodeHostHandle } from './types.js'

function fixture() {
  const config = {
    model: 'custom/team/model',
    provider: { custom: { options: { route: '{env:ROUTE}', environment: { REGION: 'one' } },
      models: { 'team/model': { limit: { context: 100, output: 20 }, structured_output: true }, extra: {} } } },
    agent: Object.fromEntries(['teammate', 'teammate-bootstrap', 'teammate-model-probe'].map(name => [name, {
      mode: 'primary', permission: { '*': 'deny', read: { '*': 'deny', '*.ts': 'allow' } }, tools: { read: true },
    }])),
    mcp: { 'agent-teams': { type: 'remote', url: 'http://test.invalid/?a=1&a=2', environment: { ID: 'one' } } },
  }
  const env = { ROUTE: 'route-one', XDG_DATA_HOME: path.join(os.tmpdir(), 'authority-TEST-data') }
  const scope = { purpose: 'launch_runtime', scopeToken: 'scope', configFingerprint: 'config', selectedAuthIdentity: 'auth' }
  const profile = { managedConfig: config, env, profileScope: scope,
    managedConfigFingerprint: buildManagedConfigFingerprint(config, env), canonicalProjectPath: '/sandbox/authority-test',
    projectBehaviorFingerprint: 'behavior', managedAuthPath: '/sandbox/authority-test/auth.json' }
  const host = { profile, baseUrl: 'http://test.invalid' } as unknown as OpenCodeHostHandle
  let live: any = JSON.parse(JSON.stringify(config).replace(/\{env:([^}]+)\}/g, (_m, name) => (env as any)[name] || ''))
  let agents: any = effectiveAgentsFixture(config, env.XDG_DATA_HOME)
  let agentReads = 0
  let listAgents = async () => agents
  let getConfig = async () => live
  let resolveScope: typeof resolveOpenCodeProfileScope = async () => structuredClone(scope) as never
  let buildEvidence = async () => ({ expectedBehaviorFingerprint: 'expected' }) as any
  const diagnostics: unknown[] = []
  const refresh = (phaseContext?: OpenCodePhaseContext,
    initialExpectedBehaviorEvidence?: OpenCodeExpectedBehaviorEvidence,
    expectedBehaviorFingerprint = 'expected') => refreshSelectedProfileAuthority({ host,
    selectedModel: 'custom/team/model', expectedBehaviorFingerprint, initialExpectedBehaviorEvidence,
    phaseContext, onRejection: value => diagnostics.push(value),
  }, { clientFactory: { create: () => ({ getConfig: () => getConfig(), listAgents: () => { agentReads += 1; return listAgents() } }) as never },
    mcpManager: { ensureAppMcp: async () => ({ summary: { matchedServerName: 'agent-teams', connected: true } }) as never },
    collectBehavior: async () => ({ projectBehaviorFingerprint: 'behavior' }) as never,
    resolveScope: input => resolveScope(input),
    buildEvidence: (..._args) => buildEvidence(),
  })
  return { config, env, profile, host, diagnostics, refresh,
    get agentReads() { return agentReads },
    get agents() { return agents }, set agents(value) { agents = value },
    set agentReader(value: () => Promise<any>) { listAgents = value },
    get live() { return live }, set live(value) { live = value },
    set read(value: () => Promise<any>) { getConfig = value },
    set scopeReader(value: typeof resolveOpenCodeProfileScope) { resolveScope = value },
    set evidence(value: () => Promise<any>) { buildEvidence = value },
  }
}

describe('selected launch authority contract', () => {
  test('accepts schema metadata removal, standard defaults, nested model IDs, ordinary key order', async () => {
    const f = fixture()
    delete f.live.provider.custom.models['team/model'].structured_output
    f.live.provider.custom.models['team/model'].unknown_annotation = 'ignored'
    f.live.command = {}
    for (const agent of Object.values(f.live.agent) as any[]) agent.options = {}
    f.live.provider.custom.options = { environment: { REGION: 'one' }, route: 'route-one' }
    expect(await f.refresh()).not.toBeNull()
    expect(f.diagnostics).toEqual([])
  })

  test('rejects provider routes, opaque environment, configured model set and retained live env literals', async () => {
    for (const mutate of [
      (live: any) => { live.provider.custom.options.route = 'changed' },
      (live: any) => { live.provider.custom.options.environment.REGION = 'two' },
      (live: any) => { delete live.provider.custom.models.extra },
      (live: any) => { live.provider.custom.options.route = '{env:ROUTE}' },
      (live: any) => { live.provider.custom.models['team/model'].limit.context = 101 },
    ]) {
      const f = fixture(); mutate(f.live)
      expect(await f.refresh()).toBeNull()
      expect(f.diagnostics).toContainEqual({ check: 'selected_config_match', fields: ['provider'] })
    }
  })

  test('accepts wire key reordering but rejects actual effective policy reordering', async () => {
    const f = fixture()
    f.live.agent.teammate.permission = { read: { '*.ts': 'allow', '*': 'deny' }, '*': 'deny' }
    expect(await f.refresh()).not.toBeNull()
    expect(f.agentReads).toBe(1)
    f.agents[0].permission.splice(2, 2, ...f.agents[0].permission.slice(2, 4).reverse())
    expect(await f.refresh()).toBeNull()
    expect(f.agentReads).toBe(2)
    const g = fixture(); g.live.permission = { '*': 'allow' }
    expect(await g.refresh()).toBeNull()
  })

  test('rejects missing, duplicate and malformed effective agents before auth evidence', async () => {
    for (const mutate of [
      (f: ReturnType<typeof fixture>) => { f.agents = null },
      (f: ReturnType<typeof fixture>) => { f.agents.pop() },
      (f: ReturnType<typeof fixture>) => { f.agents.push(structuredClone(f.agents[0])) },
      (f: ReturnType<typeof fixture>) => { f.agents[0].permission = {} },
      (f: ReturnType<typeof fixture>) => { f.agents[0].permission.at(-1).pattern = '/wrong/path/*' },
    ]) {
      const f = fixture(); mutate(f)
      let authReads = 0
      f.evidence = async () => { authReads += 1; return { expectedBehaviorFingerprint: 'expected' } }
      expect(await f.refresh()).toBeNull()
      expect(f.agentReads).toBe(1)
      expect(authReads).toBe(0)
    }
  })

  test('bounds effective agent reads with cancellation and sanitizes failures', async () => {
    const f = fixture()
    f.agentReader = async () => { throw new Error('secret effective agents failure') }
    expect(await f.refresh()).toBeNull()
    expect(f.diagnostics).toContainEqual({ check: 'exception', phase: 'effective_agents', errorClass: 'Error' })
    expect(JSON.stringify(f.diagnostics)).not.toContain('secret')
    const g = fixture()
    const controller = new AbortController()
    let rejectLate!: (reason: unknown) => void
    g.agentReader = () => new Promise((_resolve, reject) => { rejectLate = reject })
    const pending = g.refresh({ phase: 'post_probe_refresh', signal: controller.signal,
      remainingMs: () => 1000, throwIfExpired: () => { if (controller.signal.aborted) throw controller.signal.reason } })
    controller.abort(new Error('cancel'))
    expect(await pending).toBeNull()
    expect(g.agentReads).toBe(1)
    rejectLate(new Error('late agent error'))
    await new Promise(resolve => setTimeout(resolve, 0))
  })

  test('does not reconstruct missing agent permission, mode or tools', async () => {
    for (const name of ['teammate', 'teammate-bootstrap', 'teammate-model-probe']) {
      for (const field of ['permission', 'mode', 'tools']) {
        const f = fixture(); delete f.live.agent[name][field]; expect(await f.refresh()).toBeNull()
      }
    }
  })

  test('captures expectation before reads and rejects order, transport, env and identity mutation during await', async () => {
    for (const mutate of [
      (f: ReturnType<typeof fixture>) => { f.config.agent.teammate.permission = { read: f.config.agent.teammate.permission.read, '*': 'deny' } },
      (f: ReturnType<typeof fixture>) => { f.config.provider.custom.options.environment.REGION = 'changed' },
      (f: ReturnType<typeof fixture>) => { f.config.mcp['agent-teams'].url = 'http://test.invalid/?a=2&a=1' },
      (f: ReturnType<typeof fixture>) => { f.env.ROUTE = 'changed' },
      (f: ReturnType<typeof fixture>) => { (f.env as NodeJS.ProcessEnv).UNDEFINED_ADDITION = undefined },
      (f: ReturnType<typeof fixture>) => { f.profile.profileScope.scopeToken = 'changed' },
    ]) {
      const f = fixture()
      f.read = async () => { await Promise.resolve(); mutate(f); return f.live }
      expect(await f.refresh()).toBeNull()
    }
  })

  test('checks integrity and cancellation after final asynchronous auth evidence', async () => {
    const f = fixture()
    f.evidence = async () => { f.env.ROUTE = 'changed'; return { expectedBehaviorFingerprint: 'expected' } }
    expect(await f.refresh()).toBeNull()
    const g = fixture()
    const controller = new AbortController()
    const phaseContext: OpenCodePhaseContext = { phase: 'post_probe_refresh', signal: controller.signal,
      remainingMs: () => 10000, throwIfExpired: () => { if (controller.signal.aborted) throw controller.signal.reason } }
    let started!: () => void
    const entered = new Promise<void>(resolve => { started = resolve })
    let late!: (value: any) => void
    g.evidence = () => { started(); return new Promise(resolve => { late = resolve }) }
    const pending = g.refresh(phaseContext)
    await entered
    controller.abort(new Error('secret-cancellation'))
    expect(await pending).toBeNull()
    late({ expectedBehaviorFingerprint: 'expected' })
    await Promise.resolve()
    expect(g.profile.projectBehaviorFingerprint).toBe('behavior')
    expect(JSON.stringify(g.diagnostics)).not.toContain('secret-cancellation')
  })

  test('aborts an in-flight config read and safely consumes its late rejection', async () => {
    const f = fixture()
    const controller = new AbortController()
    let fail!: (reason: unknown) => void
    let downstream = 0
    f.read = () => new Promise((_resolve, reject) => { fail = reject })
    f.evidence = async () => { downstream += 1; return { expectedBehaviorFingerprint: 'expected' } }
    const pending = f.refresh({ phase: 'post_probe_refresh', signal: controller.signal,
      remainingMs: () => 1000, throwIfExpired: () => { if (controller.signal.aborted) throw controller.signal.reason } })
    controller.abort(new Error('cancel'))
    expect(await pending).toBeNull()
    fail(new Error('late secret config failure'))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(downstream).toBe(0)
    expect(JSON.stringify(f.diagnostics)).not.toContain('secret')
  })

  test('an aborted authority refresh never publishes the real resolver late scope snapshot', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-readonly-scope-TEST-'))
    try {
      await mkdir(path.join(root, 'project'))
      const project = await realpath(path.join(root, 'project'))
      const f = fixture()
      const controller = new AbortController()
      let began!: () => void
      const entered = new Promise<void>(resolve => { began = resolve })
      let lateScope!: ReturnType<typeof resolveOpenCodeProfileScope>
      f.scopeReader = input => {
        expect(input.cacheSnapshot).toBe(false)
        // Real resolver immediately starts asynchronous canonical/config/auth reads.
        // All paths and credentials belong only to this disposable test project.
        lateScope = resolveOpenCodeProfileScope({ ...input, projectPath: project,
          selectedModel: 'deepinfra/chosen', env: {
            HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'),
            XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'),
            CLAUDE_MULTIMODEL_DATA_HOME: path.join(root, 'app-data'),
            CLAUDE_MULTIMODEL_CACHE_HOME: path.join(root, 'app-cache'),
            DEEPINFRA_API_KEY: 'sandbox-only-key',
            CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL: 'http://127.0.0.1:1/mcp',
          } })
        began()
        return lateScope
      }
      const pending = f.refresh({ phase: 'post_probe_refresh', signal: controller.signal,
        remainingMs: () => 1000, throwIfExpired: () => { if (controller.signal.aborted) throw controller.signal.reason } })
      await entered
      controller.abort(new Error('cancel'))
      expect(await pending).toBeNull()
      const scope = await lateScope
      await expect(assertOpenCodePreparedProfileScope({
        ...f.host.profile, profileScope: scope, scopeToken: scope.scopeToken,
        canonicalProjectPath: project, projectPath: project,
      })).rejects.toThrow('scope token is invalid or expired')
      // Default preparation callers still publish precisely the same snapshot.
      const published = await resolveOpenCodeProfileScope({ projectPath: project,
        purpose: 'launch_runtime', selectedModel: 'deepinfra/chosen', env: {
          HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'),
          XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'),
          CLAUDE_MULTIMODEL_DATA_HOME: path.join(root, 'app-data'),
          CLAUDE_MULTIMODEL_CACHE_HOME: path.join(root, 'app-cache'),
          DEEPINFRA_API_KEY: 'sandbox-only-key',
          CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL: 'http://127.0.0.1:1/mcp',
        } })
      expect(published).toEqual(scope)
      await expect(assertOpenCodePreparedProfileScope({
        ...f.host.profile, profileScope: published, scopeToken: published.scopeToken,
        canonicalProjectPath: project, projectPath: project,
      })).resolves.toBeUndefined()
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  test('uses only retained env, substitutes keys once and leaves dollar syntax literal', async () => {
    const previous = process.env.ROUTE
    try {
      process.env.ROUTE = 'ambient-ignored'
      for (const value of [undefined, '', 'route-retained', '{env:OTHER}', '${ROUTE}']) {
        const f = fixture()
        if (value === undefined) delete (f.env as Record<string, string>).ROUTE
        else f.env.ROUTE = value
        f.profile.managedConfigFingerprint = buildManagedConfigFingerprint(f.config, f.env)
        f.live.provider.custom.options.route = value || ''
        expect(await f.refresh()).not.toBeNull()
      }
      const f = fixture()
      const options = f.config.provider.custom.options as Record<string, unknown>
      options['{env:ROUTE}'] = '${ROUTE}'
      f.live.provider.custom.options['route-one'] = '${ROUTE}'
      f.profile.managedConfigFingerprint = buildManagedConfigFingerprint(f.config, f.env)
      expect(await f.refresh()).not.toBeNull()
    } finally {
      if (previous === undefined) delete process.env.ROUTE
      else process.env.ROUTE = previous
    }
  })

  test('rejects malformed live config, exact MCP routing, extra effective rules and unsupported root policies', async () => {
    for (const value of [null, [], '', 1]) {
      const f = fixture(); f.live = value; expect(await f.refresh()).toBeNull()
    }
    const f = fixture()
    f.live.mcp['agent-teams'].url = 'http://test.invalid/?a=2&a=1'
    expect(await f.refresh()).toBeNull()
    const g = fixture()
    g.agents[0].permission.push({ permission: 'read', pattern: '*', action: 'allow' })
    expect(await g.refresh()).toBeNull()
    const h = fixture()
    ;(h.config as Record<string, unknown>).permission = { '*': 'deny' }
    h.profile.managedConfigFingerprint = buildManagedConfigFingerprint(h.config, h.env)
    expect(await h.refresh()).toBeNull()
    expect(h.agentReads).toBe(0)
  })

  test('fails closed on invalid interpolation and file expansion without disclosing values', async () => {
    for (const value of ['unescaped"secret', '{file:/sensitive}', '{env:OTHER}']) {
      const f = fixture(); f.env.ROUTE = value
      f.profile.managedConfigFingerprint = buildManagedConfigFingerprint(f.config, f.env)
      if (value === '{env:OTHER}') f.live.provider.custom.options.route = value
      const result = await f.refresh()
      if (value === '{env:OTHER}') expect(result).not.toBeNull()
      else expect(result).toBeNull()
      expect(JSON.stringify(f.diagnostics)).not.toContain('sensitive')
      expect(JSON.stringify(f.diagnostics)).not.toContain('secret')
    }
  })
})

function syntheticBehaviorEvidence(
  overrides: Partial<Omit<OpenCodeExpectedBehaviorEvidence, 'expectedBehaviorFingerprint'>> = {},
  expectedBehaviorFingerprint?: string,
): OpenCodeExpectedBehaviorEvidence {
  const unsigned = {
    canonicalProjectPathFingerprint: 'a'.repeat(64),
    modelProviderId: 'custom',
    fullModelId: 'custom/team/model',
    projectBehaviorFingerprint: 'b'.repeat(64),
    effectiveConfigFingerprint: 'c'.repeat(64),
    effectiveSelectedAuthFingerprint: 'd'.repeat(64),
    ...overrides,
  }
  return { ...unsigned, expectedBehaviorFingerprint:
    expectedBehaviorFingerprint ?? computeOpenCodeExpectedBehaviorFingerprint(unsigned) }
}

describe('selected behavior mismatch diagnostics', () => {
  test('exposes exact differing field names without evidence values or sensitive model payload', async () => {
    const initial = syntheticBehaviorEvidence()
    const fresh = syntheticBehaviorEvidence({
      fullModelId: 'custom/team/SECRET-model',
      projectBehaviorFingerprint: 'e'.repeat(64),
      effectiveConfigFingerprint: 'f'.repeat(64),
      effectiveSelectedAuthFingerprint: '1'.repeat(64),
    })
    const f = fixture()
    f.evidence = async () => fresh
    expect(await f.refresh(undefined, initial, initial.expectedBehaviorFingerprint)).toBeNull()
    expect(f.diagnostics.at(-1)).toEqual({
      check: 'behavior_match',
      fields: ['fullModelId', 'projectBehaviorFingerprint', 'effectiveConfigFingerprint',
        'effectiveSelectedAuthFingerprint'],
      comparison: { initialEvidenceMatchesExpectation: true, projectBehaviorChanged: true,
        effectiveSelectedAuthChanged: true, otherEvidenceChanged: true,
        sourcesAvailable: false, changedSourceCount: 0, sources: [] },
    })
    const rendered = JSON.stringify(f.diagnostics)
    expect(rendered).not.toContain('SECRET-model')
    for (const value of ['e'.repeat(64), 'f'.repeat(64), '1'.repeat(64)]) expect(rendered).not.toContain(value)
  })

  test('missing, malformed or inconsistent optional evidence preserves behavior_match rejection without field details', async () => {
    const initial = syntheticBehaviorEvidence()
    const foreign = syntheticBehaviorEvidence({ fullModelId: 'custom/team/foreign-secret' })
    const cases: Array<[OpenCodeExpectedBehaviorEvidence | undefined, string]> = [
      [undefined, initial.expectedBehaviorFingerprint],
      [{ expectedBehaviorFingerprint: initial.expectedBehaviorFingerprint } as OpenCodeExpectedBehaviorEvidence,
        initial.expectedBehaviorFingerprint],
      [initial, syntheticBehaviorEvidence({ modelProviderId: 'other' }).expectedBehaviorFingerprint],
      [foreign, foreign.expectedBehaviorFingerprint],
    ]
    for (const [initialEvidence, expected] of cases) {
      const f = fixture()
      f.evidence = async () => syntheticBehaviorEvidence({
        projectBehaviorFingerprint: 'e'.repeat(64), effectiveSelectedAuthFingerprint: '1'.repeat(64),
      })
      expect(await f.refresh(undefined, initialEvidence, expected)).toBeNull()
      expect(f.diagnostics.at(-1)).toEqual({ check: 'behavior_match', comparison: expect.objectContaining({
        sourcesAvailable: false, changedSourceCount: 0, sources: [],
      }) })
      expect(JSON.stringify(f.diagnostics)).not.toContain('foreign-secret')
    }
  })

  test('valid optional evidence remains diagnostic-only and does not alter matching authority', async () => {
    const initial = syntheticBehaviorEvidence()
    const f = fixture()
    f.evidence = async () => initial
    expect(await f.refresh(undefined, initial, initial.expectedBehaviorFingerprint)).not.toBeNull()
    expect(f.diagnostics).toEqual([])
  })
})

const selectedModel = 'xai/grok-4.3'
const c0 = { type: 'oauth', access: 'synthetic-access-0', refresh: 'synthetic-single-use-0', expires: 1000, accountId: 'TEST' }
const c1 = { ...c0, access: 'synthetic-access-1', refresh: 'synthetic-single-use-1', expires: 900000 }
const readBirth = processIdentity.readProcessStartTimeMs

describe('selected readiness owned OAuth rotation', () => {
  let root: string, project: string, env: NodeJS.ProcessEnv, saved: NodeJS.ProcessEnv
  let host: OpenCodeHostHandle, live: Record<string, unknown>, expected: string
  let initialEvidence: OpenCodeExpectedBehaviorEvidence
  let manager: OpenCodeProfileManager, global: string, successorPath: string
  let birthMock: { mockRestore(): void } | undefined
  let submitted: string | undefined
  let diagnostics: OpenCodeAuthorityRejection[]
  let afterNative: (() => Promise<void>) | undefined
  let completedProbe: OpenCodeOAuthNativeProbeOwner | undefined
  let nativeError: unknown
  let observedModel: string
  let nativeCredential: unknown
  let probe: OpenCodeExecutionProbe
  let evidenceHook: (() => Promise<void>) | undefined

  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'readiness-oauth-TEST-')))
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
    manager = new OpenCodeProfileManager()
    global = manager.getGlobalAuthPath()
    successorPath = openCodeOAuthSuccessorPath(global)
    await upsertOpenCodeAuthCredential({ authPath: global, providerId: 'xai', credential: c0 })
    const scope = await resolveOpenCodeProfileScope({ projectPath: project, selectedModel, purpose: 'launch_runtime', env })
    const profile = await manager.prepareProfile(project, { profileScope: scope })
    const birth = await readBirth(process.pid)
    expect(birth).toBeGreaterThan(0)
    birthMock = spyOn(processIdentity, 'readProcessStartTimeMs').mockImplementation(
      (pid, platform) => pid === process.pid && (platform === undefined || platform === process.platform)
        ? Promise.resolve(birth) : readBirth(pid, platform))
    host = { profile, hostKey: `TEST-${scope.scopeToken}`, baseUrl: 'http://127.0.0.1:1',
      profileRootKey: profile.profileRootKey, projectPath: project, projectBehaviorFingerprint: profile.projectBehaviorFingerprint,
      version: '1.18.4', pid: process.pid, processStartedAtMs: birth, port: 1, state: 'healthy',
      resolvedConfigFingerprint: profile.managedConfigFingerprint, diagnostics: [] }
    live = JSON.parse(JSON.stringify(profile.managedConfig)
      .replace(/\{env:([^}]+)\}/g, (_match, name: string) => profile.env[name] || ''))
    initialEvidence = await buildOpenCodeExpectedBehaviorEvidence({ profile, fullModelId: selectedModel,
      effectiveConfigFingerprint: profile.managedConfigFingerprint })
    expected = initialEvidence.expectedBehaviorFingerprint
    submitted = undefined
    afterNative = undefined
    evidenceHook = undefined
    nativeCredential = c1
    completedProbe = undefined
    nativeError = undefined
    observedModel = 'grok-4.3'
    diagnostics = []
    probe = new OpenCodeExecutionProbe({ hostManager: {
      // These OAuth tests supply synthetic hosts; registry concurrency has its own fixtures.
      ensureHost: async () => { throw new Error('Synthetic OAuth fixture cannot spawn a host') },
      releaseHost: async () => {},
      withHostOperation: async (_host, _owner, operation) => operation(),
    },  clientFactory: { create: () => ({
      createSession: async () => ({ id: 'TEST-probe' }), getSession: async () => ({ id: 'TEST-probe' }),
      getSessionStatus: async () => ({ 'TEST-probe': 'idle' }), getPermissions: async () => [],
      getSessionMessages: async () => submitted ? [
        { info: { id: submitted, role: 'user', sessionID: 'TEST-probe' }, parts: [] },
        { info: { id: 'TEST-assistant', parentID: submitted, role: 'assistant', providerID: 'xai',
          modelID: observedModel, error: nativeError, sessionID: 'TEST-probe', time: { created: 101, completed: 110 } },
          parts: [{ type: 'text', text: 'PONG' }] }] : [],
      promptSessionAsync: async (_id: string, body: { messageID: string }) => {
        submitted = body.messageID
        expect(await readOpenCodeAuthCredential({ authPath: host.profile.managedAuthPath, providerId: 'xai' })).toEqual(c0)
        await writeFile(host.profile.managedAuthPath, JSON.stringify({ xai: nativeCredential }))
        await afterNative?.()
      },
      abortSession: async () => true, deleteSession: async () => true,
    }) as never } })
  })
  afterEach(async () => {
    birthMock?.mockRestore()
    for (const [key, value] of Object.entries(saved ?? {})) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(root, { recursive: true, force: true })
  })
  const refresh = (allowOwnedOAuthRotation = false, phaseContext?: import('./OpenCodeRuntimeDeadline.js').OpenCodePhaseContext) => refreshSelectedProfileAuthority({
    host, selectedModel, expectedBehaviorFingerprint: expected, initialExpectedBehaviorEvidence: initialEvidence, completedOAuthProbe: allowOwnedOAuthRotation ? completedProbe : undefined, phaseContext,
    onRejection: value => diagnostics.push(value),
  }, {
    clientFactory: { create: () => ({ getConfig: async () => live,
      listAgents: async () => effectiveAgentsFixture(host.profile.managedConfig, host.profile.env.XDG_DATA_HOME!),
    }) as never },
    mcpManager: { ensureAppMcp: async () => ({ summary: { matchedServerName: 'agent-teams', connected: true } }) as never },
    buildEvidence: async input => {
      const evidence = await buildOpenCodeExpectedBehaviorEvidence(input)
      await evidenceHook?.()
      return evidence
    },
  })
  const execute = async () => {
    completedProbe = undefined
    return probe.probeModelOnHost({ host, selectedModel, cleanupSuccessfulSession: true,
      onOwnedOAuthProbeSuccess: owner => { completedProbe = owner },
    })
  }

  test('C0 precheck, real owned native C1 commit, postcheck accepts only the completed rotation', async () => {
    const original = structuredClone(host)
    expect(await refresh()).not.toBeNull()
    expect((await execute()).outcome).toBe('available')
    const committed = JSON.parse(await readFile(successorPath, 'utf8'))
    expect(committed.predecessor).toEqual(c0)
    expect(committed.successor).toEqual(c1)
    expect(committed.completion.nativeProbe.messageId).toBe(submitted)
    const current = await resolveOpenCodeProfileScope({ projectPath: project, selectedModel, purpose: 'launch_runtime', env, cacheSnapshot: false })
    expect(current.scopeToken).not.toBe(original.profile.scopeToken)
    expect(current.configFingerprint).toBe(original.profile.profileScope!.configFingerprint)
    expect(current.selectedAuthIdentity).not.toBe(original.profile.profileScope!.selectedAuthIdentity)
    expect(await refresh()).toBeNull()
    expect(diagnostics.at(-1)).toEqual({ check: 'scope_token_match' })
    diagnostics = []
    const refreshed = await refresh(true)
    expect({ refreshed, diagnostics }).toMatchObject({ diagnostics: [] })
    expect(refreshed).not.toBeNull()
    expect(host).toEqual(original)
    const snapshot = { detected: true, hostHealthy: true, projectPath: project, profile: refreshed,
      host, config: null, configProviders: null, providers: null, providerAuth: null,
      agents: [], mcp: null, appMcp: null, probeError: null, diagnostics: [] }
    const proof = await buildOpenCodeExecutionProof({ selectedModel, snapshot, capabilitySnapshotId: null }, {
      resolveBinaryPath: () => path.join(root, 'synthetic-opencode'), resolveBinaryIdentity: async () => 'TEST-binary',
    })
    expect(proof.credentialMode).toBe('oauth')
    expect(proof.reusable).toBe(false)
    expect(proof.expectedBehaviorEvidence.expectedBehaviorFingerprint).not.toBe(expected)
    expect(proof.expectedBehaviorEvidence).toEqual(await buildOpenCodeExpectedBehaviorEvidence({
      profile: host.profile, fullModelId: selectedModel, effectiveConfigFingerprint: host.profile.managedConfigFingerprint,
      readCredential: async () => c1,
    }))
    expect(await validateOpenCodeExecutionProof({ proof, selectedModel, projectPath: project,
      snapshot, capabilitySnapshotId: null })).toEqual({ valid: false, reason: 'execution proof is not reusable for oauth credentials' })
    // Continuity authorizes evidence only, never a second submission from C0.
    await expect(execute()).rejects.toThrow()
    const fresh = await manager.prepareProfile(project, { profileScope: await resolveOpenCodeProfileScope({
      projectPath: project, selectedModel, purpose: 'launch_runtime', env,
    }) })
    expect(fresh.scopeToken).not.toBe(original.profile.scopeToken)
    expect(await readOpenCodeAuthCredential({ authPath: fresh.managedAuthPath, providerId: 'xai' })).toEqual(c1)
    expect(await buildOpenCodeExpectedBehaviorEvidence({ profile: fresh, fullModelId: selectedModel,
      effectiveConfigFingerprint: fresh.managedConfigFingerprint })).toEqual(proof.expectedBehaviorEvidence)
  })

  test('no rotation follows the unchanged authority path', async () => {
    nativeCredential = c0
    expect(await refresh()).not.toBeNull()
    expect((await execute()).outcome).toBe('available')
    expect(await refresh(true)).not.toBeNull()
    expect(await readFile(successorPath, 'utf8').catch(() => null)).toBeNull()
  })

  test.each([
    ['owner', null], ['owner.scopeToken', 'f'.repeat(64)], ['owner.projectPath', '/foreign-project'],
    ['owner.purpose', 'execution_probe'], ['completion', null], ['completion.nativeProbe', null],
    ['completion.managedAuthPath', '/foreign-managed'],
    ['completion.nativeProbe.hostKey', 'foreign-host'], ['completion.nativeProbe.baseUrl', 'http://127.0.0.1:2'],
    ['completion.nativeProbe.pid', 1], ['completion.nativeProbe.processStartedAtMs', 1],
    ['completion.nativeProbe.profileRootKey', 'foreign-root'], ['completion.nativeProbe.scopeToken', 'f'.repeat(64)],
    ['completion.nativeProbe.projectPath', '/foreign-project'], ['completion.nativeProbe.selectedModel', 'xai/foreign-model'],
    ['completion.nativeProbe.messageId', ''], ['completion.nativeProbe.sessionId', ''],
    ['completion.nativeProbe.messageId', 'TEST-other-message'], ['completion.nativeProbe.sessionId', 'TEST-other-session'],
    ['predecessor.access', 'unrelated-same-account'], ['successor.access', 'unrelated-same-account'],
    ['sourceAuthPaths', []],
  ])('rejects foreign/missing committed provenance: %s', async (field, value) => {
    expect((await execute()).outcome).toBe('available')
    const authority = JSON.parse(await readFile(successorPath, 'utf8'))
    const fields = field.split('.')
    let parent = authority
    for (const name of fields.slice(0, -1)) parent = parent[name]
    parent[fields.at(-1)!] = value
    await writeFile(successorPath, JSON.stringify(authority))
    expect(await refresh(true)).toBeNull()
  })

  test.each(['missing publication', 'pending admission', 'partial publication', 'retired publication'])('rejects %s', async kind => {
    await execute()
    const committed = await readFile(successorPath, 'utf8')
    if (kind === 'missing publication') await rm(successorPath)
    else {
      const receipt = JSON.parse(committed)
      receipt.successor = kind === 'pending admission' ? null : c1
      if (kind === 'retired publication') receipt.publicationRevoked = true
      await writeFile(`${global}.agent-teams-xai-oauth-save.json`, JSON.stringify(receipt))
    }
    const before = await readFile(successorPath, 'utf8').catch(() => null)
    expect(await refresh(true)).toBeNull()
    expect(await readFile(successorPath, 'utf8').catch(() => null)).toBe(before)
  })

  test.each([
    ['same-account unrelated OAuth', { ...c1, access: 'foreign-access', refresh: 'foreign-refresh' }],
    ['account change', { ...c1, accountId: 'foreign' }], ['API replacement', { type: 'api', key: 'synthetic-foreign' }],
    ['logout', null],
  ])('rejects saved and native %s after a legitimate commit', async (_name, replacement) => {
    await execute()
    const committed = await readFile(successorPath, 'utf8')
    await writeFile(host.profile.managedAuthPath, JSON.stringify({ xai: replacement }))
    expect(await refresh(true)).toBeNull()
    await writeFile(host.profile.managedAuthPath, JSON.stringify({ xai: c1 }))
    await writeFile(global, JSON.stringify({ xai: replacement }))
    expect(await refresh(true)).toBeNull()
    expect(await readFile(successorPath, 'utf8')).toBe(committed)
  })

  test.each(['project config', 'project behavior', 'MCP', 'live config', 'host owner', 'project identity'])('rejects non-auth %s drift', async kind => {
    await execute()
    if (kind === 'project config') await writeFile(path.join(project, 'opencode.json'), JSON.stringify({ command: { foreign: { template: 'foreign' } } }))
    if (kind === 'project behavior') await writeFile(path.join(project, 'AGENTS.md'), 'Synthetic changed project instructions')
    if (kind === 'MCP') live.mcp = { 'agent-teams': { type: 'remote', url: 'http://127.0.0.1:2/mcp' } }
    if (kind === 'live config') live.default_agent = 'foreign'
    if (kind === 'host owner') host.hostKey = 'foreign'
    if (kind === 'project identity') host.projectPath = path.join(root, 'other-project')
    expect(await refresh(true)).toBeNull()
  })

  test.each(['saved auth', 'native auth', 'publication', 'host'])('rejects %s changes during final behavior evidence', async kind => {
    await execute()
    evidenceHook = async () => {
      if (kind === 'saved auth') await writeFile(global, JSON.stringify({ xai: { ...c0, access: 'foreign' } }))
      if (kind === 'native auth') await writeFile(host.profile.managedAuthPath, JSON.stringify({ xai: { ...c1, access: 'foreign' } }))
      if (kind === 'publication') await rm(successorPath)
      if (kind === 'host') host.pid += 1
    }
    expect(await refresh(true)).toBeNull()
  })

  test('behavior rejection distinguishes retained project sources from reread selected auth without exposing either', async () => {
    expect(await refresh()).not.toBeNull()
    expect(diagnostics).toEqual([])
    await writeFile(path.join(project, 'AGENTS.md'), 'TEST-PRIVATE project instructions')
    await mkdir(path.join(project, '.opencode', 'tools'), { recursive: true })
    await writeFile(path.join(project, '.opencode', 'tools', 'TEST-PRIVATE-tool.ts'), 'TEST-PRIVATE tool contents')
    expect(await refresh()).toBeNull()
    expect(diagnostics.at(-1)).toEqual({ check: 'behavior_match', fields: ['projectBehaviorFingerprint'], comparison: {
      initialEvidenceMatchesExpectation: true, projectBehaviorChanged: true,
      effectiveSelectedAuthChanged: false, otherEvidenceChanged: false,
      sourcesAvailable: true, changedSourceCount: 2,
      sources: [
        { label: '.opencode/tools', initial: 'missing', refreshed: 'present' },
        { label: 'AGENTS.md', initial: 'missing', refreshed: 'present' },
      ],
    } })
    expect(JSON.stringify(diagnostics)).not.toContain('TEST-PRIVATE')
    expect(JSON.stringify(diagnostics)).not.toContain(project)
    await rm(path.join(project, 'AGENTS.md'))
    await rm(path.join(project, '.opencode', 'tools'), { recursive: true })
    await writeFile(host.profile.managedAuthPath, JSON.stringify({ xai: { ...c0, access: 'TEST-PRIVATE credential' } }))
    expect(await refresh()).toBeNull()
    expect(diagnostics.at(-1)).toEqual({ check: 'behavior_match', fields: ['effectiveSelectedAuthFingerprint'], comparison: {
      initialEvidenceMatchesExpectation: true, projectBehaviorChanged: false,
      effectiveSelectedAuthChanged: true, otherEvidenceChanged: false,
      sourcesAvailable: true, changedSourceCount: 0, sources: [],
    } })
    expect(JSON.stringify(diagnostics)).not.toContain('TEST-PRIVATE')
    expect(JSON.stringify(diagnostics)).not.toContain(c0.access)
    expect(JSON.stringify(diagnostics)).not.toContain(initialEvidence.effectiveSelectedAuthFingerprint)
  })

  test('rotation cannot replace a different initial behavior expectation', async () => {
    await execute()
    expected = 'f'.repeat(64)
    expect(await refresh(true)).toBeNull()
    expect(diagnostics.at(-1)).toMatchObject({ check: 'behavior_match', comparison: { initialEvidenceMatchesExpectation: false } })
  })

  test('cancellation of the postcheck preserves committed saved authority and rejects', async () => {
    await execute()
    const committed = await readFile(successorPath, 'utf8')
    const controller = new AbortController()
    evidenceHook = async () => { controller.abort(new Error('synthetic cancellation')) }
    expect(await refresh(true, { phase: 'post_probe_refresh', signal: controller.signal,
      remainingMs: () => 10000, throwIfExpired: () => { if (controller.signal.aborted) throw controller.signal.reason },
    })).toBeNull()
    expect(await readFile(successorPath, 'utf8')).toBe(committed)
  })

  test.each([null, { ...c1, refresh: '' }, { ...c1, accountId: 'foreign' }])('failed/invalid native refresh cannot establish continuity %#', async credential => {
    nativeCredential = credential
    await expect(execute()).rejects.toThrow()
    expect(await refresh(true)).toBeNull()
    expect(await readFile(successorPath, 'utf8').catch(() => null)).toBeNull()
  })

  test('foreign saved authority during native work prevents commit and postcheck acceptance', async () => {
    afterNative = () => writeFile(global, JSON.stringify({ xai: { ...c0, access: 'independent-login' } }))
    await expect(execute()).rejects.toThrow()
    expect(await refresh(true)).toBeNull()
    expect(await readFile(successorPath, 'utf8').catch(() => null)).toBeNull()
  })

  test.each(['success', 'failure'])('A cannot consume later B publication: %s', async kind => {
    // Native execution alone is serialized; both independent prechecks finish first.
    expect(await refresh()).not.toBeNull()
    expect(await refresh()).not.toBeNull()
    nativeCredential = c0
    expect((await execute()).outcome).toBe('available')
    const ownerA = completedProbe!
    nativeCredential = c1
    if (kind === 'failure') nativeError = { name: 'APIError', data: {
      message: 'Synthetic TEST failure', statusCode: 500, isRetryable: false } }
    const resultB = await execute()
    const ownerB = completedProbe
    const receipt = JSON.parse(await readFile(successorPath, 'utf8'))
    expect(receipt.completion.nativeProbe.messageId).not.toBe(ownerA.messageId)
    completedProbe = ownerA
    expect(await refresh(true)).toBeNull()
    completedProbe = ownerB
    if (kind === 'success') {
      expect(resultB.outcome).toBe('available')
      expect(ownerB?.messageId).toBe(receipt.completion.nativeProbe.messageId)
      expect(await refresh(true)).not.toBeNull()
    } else {
      expect(resultB.outcome).not.toBe('available')
      expect(ownerB).toBeUndefined()
      expect(await refresh(true)).toBeNull()
    }
    // Failure cleanup can save C1 for a fresh scope, without authorizing A or B.
    expect(await manager.readSavedOAuthCredential(host.profile)).toEqual(c1)
  })

  test('mismatched native execution cannot authorize rotation', async () => {
    observedModel = 'TEST-wrong-model'
    await expect(execute()).rejects.toThrow('settlement is unconfirmed')
    expect(completedProbe).toBeUndefined()
    expect(await refresh(true)).toBeNull()
    expect(await readFile(successorPath, 'utf8').catch(() => null)).toBeNull()
  })

  test.each(['missing owner', 'missing session', 'missing message'])('rotation requires execution identity: %s', async kind => {
    await execute()
    if (kind === 'missing owner') completedProbe = undefined
    if (kind === 'missing session') completedProbe!.sessionId = ''
    if (kind === 'missing message') completedProbe!.messageId = ''
    expect(await refresh(true)).toBeNull()
  })

  test.each(['before postcheck', 'during behavior evidence'])('rejects replaced process %s', async when => {
    await execute()
    const replaceProcess = async () => {
      birthMock?.mockRestore()
      birthMock = spyOn(processIdentity, 'readProcessStartTimeMs').mockResolvedValue(host.processStartedAtMs! + 1000)
    }
    if (when === 'before postcheck') await replaceProcess()
    else evidenceHook = replaceProcess
    expect(await refresh(true)).toBeNull()
  })

  test('public readiness returns complete C1 proof evidence matching fresh admission', async () => {
    const { executeOpenCodeBridgeCommandEnvelope, __resetAppMcpToolProofCacheForTests } = await import('./OpenCodeBridgeCommandHandler.js')
    const { openCodeProvisioningProbe } = await import('./OpenCodeProvisioningProbe.js')
    const { openCodeExecutionProbe } = await import('./OpenCodeExecutionProbe.js')
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
    const mocks: Array<{mockRestore(): void}> = []
    const retainedHost = host
    const retainedBefore = structuredClone(host)
    let releases = 0
    const toolNames = [
      'cross_team_get_outbox', 'cross_team_list_targets', 'cross_team_send', 'member_briefing',
      'message_send', 'process_list', 'process_register', 'process_stop', 'process_unregister',
      'review_approve', 'review_request', 'review_request_changes', 'review_start',
      'runtime_bootstrap_checkin', 'runtime_deliver_message', 'runtime_task_event', 'runtime_heartbeat',
      'task_add_comment', 'task_attach_comment_file', 'task_attach_file', 'task_briefing', 'task_complete',
      'task_create', 'task_create_from_message', 'task_get', 'task_get_comment', 'task_link', 'task_list',
      'task_set_clarification', 'task_set_owner', 'task_set_status', 'task_start', 'task_unlink',
    ]
    const snap = () => ({ detected: true, hostHealthy: true, projectPath: project, profile: host.profile, host,
      config: live, configProviders: { providers: [{ id: 'xai', models: { 'grok-4.3': {} } }], default: { xai: 'grok-4.3' } },
      providers: { connected: ['xai'], default: { xai: 'grok-4.3' } }, providerAuth: null, agents: [], mcp: {},
      appMcp: { serverName: 'agent-teams', matchedServerName: 'agent-teams', status: 'present', connected: true,
        launchSource: 'env-override', availableServerNames: ['agent-teams'], diagnostics: [] },
      probeError: null, diagnostics: [] })
    const envelope = (command: string, body: Record<string, unknown>) => ({ schemaVersion: 1 as const,
      requestId: `TEST-${command}`, command, cwd: project, startedAt: new Date().toISOString(), timeoutMs: 30000, body })
    const binary = path.join(root, 'TEST-binary')
    await writeFile(binary, 'SYNTHETIC TEST BINARY IDENTITY ONLY; NEVER EXECUTE')
    const savedBinary = process.env.OPENCODE_BIN_PATH
    const savedCache = process.env.AGENT_TEAMS_OPENCODE_MCP_TOOL_PROOF_CACHE_DISABLED
    process.env.OPENCODE_BIN_PATH = binary
    process.env.AGENT_TEAMS_OPENCODE_MCP_TOOL_PROOF_CACHE_DISABLED = '1'
    __resetAppMcpToolProofCacheForTests()
    try {
      mocks.push(spyOn(Client.prototype, 'connect').mockImplementation(async () => {}))
      mocks.push(spyOn(Client.prototype, 'listTools').mockImplementation(async () => ({ tools: toolNames.map(name => ({name})) }) as never))
      mocks.push(spyOn(Client.prototype, 'close').mockImplementation(async () => {}))
      mocks.push(spyOn(openCodeProvisioningProbe, 'probeRetainingHost').mockImplementation(async () => ({snapshot: snap(), host, release: async () => { releases += 1 }}) as never))
      mocks.push(spyOn(openCodeProvisioningProbe, 'refreshSelectedProfileAuthority').mockImplementation(async input => refreshSelectedProfileAuthority(input, {
        clientFactory: { create: () => ({ getConfig: async () => live,
          listAgents: async () => effectiveAgentsFixture(host.profile.managedConfig, host.profile.env.XDG_DATA_HOME!), }) as never },
        mcpManager: { ensureAppMcp: async () => ({ summary: { matchedServerName: 'agent-teams', connected: true } }) as never },
      })))
      mocks.push(spyOn(openCodeExecutionProbe, 'probeModelOnHost').mockImplementation(input => probe.probeModelOnHost(input)))
      const readiness = await executeOpenCodeBridgeCommandEnvelope(envelope('opencode.readiness', {
        projectPath: project, selectedModel, requireExecutionProbe: true,
      }))
      expect(readiness.ok).toBe(true)
      if (!readiness.ok) throw new Error(JSON.stringify(readiness.error))
      expect(readiness.data.launchAllowed).toBe(true)
      expect(releases).toBe(1)
      expect(retainedHost).toEqual(retainedBefore)
      expect(readiness.data.executionProof.credentialMode).toBe('oauth')
      expect(readiness.data.executionProof.reusable).toBe(false)
      expect(readiness.data.expectedBehaviorEvidence).toEqual(readiness.data.executionProof.expectedBehaviorEvidence)
      expect(readiness.data.executionProof.expectedBehaviorEvidence.expectedBehaviorFingerprint).not.toBe(expected)
      const fresh = await manager.prepareProfile(project, { profileScope: await resolveOpenCodeProfileScope({projectPath: project, selectedModel, purpose: 'launch_runtime', env}) })
      host = { ...host, profile: fresh, profileRootKey: fresh.profileRootKey, hostKey: `TEST-${fresh.scopeToken}` }
      const freshEvidence = await buildOpenCodeExpectedBehaviorEvidence({ profile: fresh, fullModelId: selectedModel,
        effectiveConfigFingerprint: fresh.managedConfigFingerprint })
      expect(freshEvidence).toEqual(readiness.data.executionProof.expectedBehaviorEvidence)
      expect(freshEvidence).toEqual(readiness.data.expectedBehaviorEvidence)
    } finally {
      for (const mock of mocks.reverse()) mock.mockRestore()
      if (savedBinary === undefined) delete process.env.OPENCODE_BIN_PATH
      else process.env.OPENCODE_BIN_PATH = savedBinary
      if (savedCache === undefined) delete process.env.AGENT_TEAMS_OPENCODE_MCP_TOOL_PROOF_CACHE_DISABLED
      else process.env.AGENT_TEAMS_OPENCODE_MCP_TOOL_PROOF_CACHE_DISABLED = savedCache
      __resetAppMcpToolProofCacheForTests()
    }
  })
})
