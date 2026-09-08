import { effectiveAgentsFixture } from './OpenCodeEffectiveAgents.test-support.js'
import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { assertOpenCodePreparedProfileScope, resolveOpenCodeProfileScope, buildManagedConfigFingerprint } from './OpenCodeProfileManager.js'
import { refreshSelectedProfileAuthority } from './OpenCodeSelectedProfileAuthority.js'
import type { OpenCodePhaseContext } from './OpenCodeRuntimeDeadline.js'
import type { OpenCodeHostHandle } from './types.js'

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
  const refresh = (phaseContext?: OpenCodePhaseContext) => refreshSelectedProfileAuthority({ host,
    selectedModel: 'custom/team/model', expectedBehaviorFingerprint: 'expected',
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
