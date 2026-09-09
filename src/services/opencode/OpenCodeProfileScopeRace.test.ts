import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { readProcessStartTimeMs } from '../../utils/processKill.js'
import { OpenCodeProfileManager, resolveOpenCodeProfileScope } from './OpenCodeProfileManager.js'
import { readOpenCodeAuthCredential, upsertOpenCodeAuthCredential } from './OpenCodeAuthStore.js'
import { buildOpenCodeExpectedBehaviorEvidence } from './OpenCodeExpectedBehaviorFingerprint.js'
import { refreshSelectedProfileAuthority, type OpenCodeAuthorityRejection } from './OpenCodeSelectedProfileAuthority.js'
import { effectiveAgentsFixture } from './OpenCodeEffectiveAgents.test-support.js'
import { OpenCodeExecutionProbe } from './OpenCodeExecutionProbe.js'
import type { OpenCodeHostHandle, OpenCodePreparedProfile, OpenCodeProfilePurpose } from './types.js'

function barrier() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

const credential = { type: 'oauth', access: 'sandbox-access', refresh: 'sandbox-refresh',
  expires: 1000, accountId: 'sandbox-account' }
const successor = { ...credential, access: 'sandbox-successor', refresh: 'sandbox-successor-refresh', expires: 2000 }

// Real resolver, preparation, auth stores, execution probe and authority reads;
// only the HTTP/OpenCode process boundary is replaced. All files are disposable.
describe('profile scope preparation and execution ownership', () => {
  let processBirth: number
  let root: string
  let project: string
  let env: NodeJS.ProcessEnv
  let saved: NodeJS.ProcessEnv
  const manager = new OpenCodeProfileManager()
  beforeEach(async () => {
    processBirth = (await readProcessStartTimeMs(process.pid))!
    root = await mkdtemp(path.join(os.tmpdir(), 'opencode-scope-race-TEST-'))
    project = path.join(root, 'project')
    await mkdir(project)
    env = {
      HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'),
      XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'),
      CLAUDE_MULTIMODEL_DATA_HOME: path.join(root, 'app-data'),
      CLAUDE_MULTIMODEL_CACHE_HOME: path.join(root, 'app-cache'),
      CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL: 'http://127.0.0.1:1/mcp',
    }
    // The existing legacy fanout API resolves managed paths from process.env.
    saved = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]))
    Object.assign(process.env, env)
    await upsertOpenCodeAuthCredential({ authPath: manager.getGlobalAuthPath(), providerId: 'xai', credential })
    await upsertOpenCodeAuthCredential({ authPath: manager.getGlobalAuthPath(), providerId: 'zai',
      credential: { type: 'api', key: 'sandbox-zai' } })
  })
  afterEach(async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(root, { recursive: true, force: true })
  })
  const scope = (selectedModel = 'xai/grok-4.3', purpose: OpenCodeProfilePurpose = 'launch_runtime', extra = {}) =>
    resolveOpenCodeProfileScope({ projectPath: project, selectedModel, purpose, env: { ...env, ...extra } })
  const prepare = async (model = 'xai/grok-4.3', purpose: OpenCodeProfilePurpose = 'launch_runtime') =>
    manager.prepareProfile(project, { profileScope: await scope(model, purpose) })
  const host = (profile: OpenCodePreparedProfile) => ({ profile, baseUrl: 'http://127.0.0.1:1',
    hostKey: `test-${profile.scopeToken}`, profileRootKey: profile.profileRootKey, pid: process.pid,
    processStartedAtMs: processBirth, version: '1.18.4' }) as OpenCodeHostHandle
  const evidence = (profile: OpenCodePreparedProfile, fullModelId = 'xai/grok-4.3') =>
    buildOpenCodeExpectedBehaviorEvidence({ profile, fullModelId, effectiveConfigFingerprint: profile.managedConfigFingerprint })
  async function refresh(profile: OpenCodePreparedProfile, expected: string, model = 'xai/grok-4.3') {
    const rejections: OpenCodeAuthorityRejection[] = []
    const result = await refreshSelectedProfileAuthority({ host: host(profile), selectedModel: model,
      expectedBehaviorFingerprint: expected, onRejection: item => rejections.push(item) }, {
      clientFactory: { create: () => ({ getConfig: async () => structuredClone(profile.managedConfig),
        listAgents: async () => effectiveAgentsFixture(profile.managedConfig, profile.env.XDG_DATA_HOME!) }) as never },
      mcpManager: { ensureAppMcp: async () => ({ summary: { matchedServerName: 'agent-teams', connected: true } }) as never },
    })
    return { result, rejections }
  }
  function probe(profile: OpenCodePreparedProfile, entered = barrier(), proceed = barrier()) {
    let submittedMessageId: string | undefined
    const engine = new OpenCodeExecutionProbe({
      clientFactory: { create: () => ({
        createSession: async () => ({ id: 'probe' }), getSession: async () => ({ id: 'probe' }),
        getSessionStatus: async () => ({ probe: 'idle' }), getPermissions: async () => [],
        getSessionMessages: async () => submittedMessageId ? [
          { info: { id: submittedMessageId, role: 'user', sessionID: 'probe' }, parts: [] },
          { info: { id: 'assistant', parentID: submittedMessageId, role: 'assistant', providerID: 'xai',
          modelID: 'grok-4.3', sessionID: 'probe', time: { created: 101, completed: 110 } },
          parts: [{ type: 'text', text: 'PONG' }] }] : [],
        promptSessionAsync: async (_id: string, body: { messageID: string }) => {
          submittedMessageId = body.messageID
          entered.release(); await proceed.promise
        },
        abortSession: async () => true, deleteSession: async () => true,
      }) as never },
    })
    return { entered, proceed, run: () => engine.probeModelOnHost({ host: host(profile), selectedModel: 'xai/grok-4.3' }) }
  }

  test('same-model probes never import a foreign scope credential into mixed launch readiness', async () => {
    const [xaiA, xaiB, zaiA, zaiB] = await Promise.all([
      prepare(), prepare(), prepare('zai/glm-5.2'), prepare('zai/glm-5.2'),
    ])
    expect(xaiA.scopeToken).toBe(xaiB.scopeToken)
    expect(xaiA.managedAuthPath).toBe(xaiB.managedAuthPath)
    expect(zaiA.managedAuthPath).toBe(zaiB.managedAuthPath)
    expect(zaiA.managedAuthPath).not.toBe(xaiA.managedAuthPath)
    const expected = await evidence(xaiA)
    const zaiExpected = await evidence(zaiA, 'zai/glm-5.2')
    expect((await refresh(xaiA, expected.expectedBehaviorFingerprint)).rejections).toEqual([])
    // A separate execution-probe scope in the SAME project has refreshed auth.
    const foreign = await prepare('xai/grok-4.3', 'execution_probe')
    expect(foreign.scopeToken).not.toBe(xaiA.scopeToken)
    await upsertOpenCodeAuthCredential({ authPath: foreign.managedAuthPath, providerId: 'xai', credential: successor })
    const first = probe(xaiA)
    const running = first.run()
    await first.entered.promise
    // Both preparations and initial authority completed before probe completion.
    // The fake provider itself writes nothing: only runtime fanout can rotate it.
    first.proceed.release()
    expect((await running).outcome).toBe('available')
    const after = await refresh(xaiA, expected.expectedBehaviorFingerprint)
    expect(after.rejections).toEqual([])
    expect(after.result).not.toBeNull()
    expect(await readOpenCodeAuthCredential({ authPath: manager.getGlobalAuthPath(), providerId: 'xai' })).toEqual(credential)
    const second = probe(xaiB)
    second.proceed.release()
    expect((await second.run()).outcome).toBe('available')
    expect((await refresh(xaiB, expected.expectedBehaviorFingerprint)).result).not.toBeNull()
    for (const primary of [zaiA, zaiB]) {
      expect((await refresh(primary, zaiExpected.expectedBehaviorFingerprint, 'zai/glm-5.2')).result).not.toBeNull()
    }
  })

  test('a preparation queued behind a probe cannot restore cached auth over its successor', async () => {
    const selected = await scope()
    const first = await manager.prepareProfile(project, { profileScope: selected })
    const expected = await evidence(first)
    const execution = probe(first)
    const running = execution.run()
    await execution.entered.promise
    const reachedAuth = barrier()
    const pending = manager.prepareProfile(project, { profileScope: selected, progress: {
      enterStep: label => { if (label.endsWith('reconcile managed auth stores')) reachedAuth.release(); return () => {} },
    } })
    // Attach the rejection handler now, before the held execution completes.
    const completion = pending.then(value => ({ value, error: null }), error => ({ value: null, error }))
    await reachedAuth.promise
    // Simulate an upstream refresh under the already held execution lock. This
    // direct fixture write avoids trying to acquire its lock in another async lane.
    await writeFile(first.managedAuthPath, JSON.stringify({ xai: successor }))
    execution.proceed.release()
    await running
    const result = await completion
    expect(result.error).toBeInstanceOf(Error)
    expect(await readOpenCodeAuthCredential({ authPath: first.managedAuthPath, providerId: 'xai' })).toEqual(successor)
    expect((await refresh(first, expected.expectedBehaviorFingerprint)).result).toBeNull()
  })

  test('repeated identical preparation does not replace an active auth file', async () => {
    const first = await prepare()
    const before = await stat(first.managedAuthPath)
    const second = await prepare()
    expect(second.scopeToken).toBe(first.scopeToken)
    expect(second.managedAuthPath).toBe(first.managedAuthPath)
    const after = await stat(first.managedAuthPath)
    expect(after.ino).toBe(before.ino)
    expect(after.mtimeMs).toBe(before.mtimeMs)
  })

  test('distinct effective scope tokens never share profile storage', async () => {
    // Execution-probe snapshots retain the imported provider map, while
    // configFingerprint binds only the selected provider.
    const firstScope = await scope('xai/grok-4.3', 'execution_probe', {
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: { unrelated: { name: 'first' } } }),
    })
    const secondScope = await scope('xai/grok-4.3', 'execution_probe', {
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: { unrelated: { name: 'second' } } }),
    })
    expect(firstScope.configFingerprint).toBe(secondScope.configFingerprint)
    expect(firstScope.scopeToken).not.toBe(secondScope.scopeToken)
    const [first, second] = await Promise.all([firstScope, secondScope].map(profileScope =>
      manager.prepareProfile(project, { profileScope })))
    expect(first.profileRootKey).not.toBe(second.profileRootKey)
    expect(first.managedAuthPath).not.toBe(second.managedAuthPath)
  })
})
