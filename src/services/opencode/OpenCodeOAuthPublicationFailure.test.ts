// Run in its own Bun process: the atomic writer is fault-injected at the module
// boundary, while resolver, native ownership and recovery remain real.
import { expect, mock, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as atomic from '../../utils/atomicWrite.js'

const writeJson = atomic.writeJsonFileAtomic
let failurePath: string | null = null
mock.module('../../utils/atomicWrite.js', () => ({ ...atomic,
  writeJsonFileAtomic: async (filePath: string, value: unknown, options: Parameters<typeof writeJson>[2]) => {
    if (filePath === failurePath) throw new Error('synthetic saved-owner atomic write failure')
    return writeJson(filePath, value, options)
  },
}))
const { OpenCodeProfileManager, resolveOpenCodeProfileScope } = await import('./OpenCodeProfileManager.js')
const { readOpenCodeAuthCredential, upsertOpenCodeAuthCredential } = await import('./OpenCodeAuthStore.js')
const c0 = { type: 'oauth', access: 'synthetic-C0', refresh: 'single-use-C0', expires: 1000, accountId: 'TEST' }
const c1 = { ...c0, access: 'synthetic-C1', refresh: 'single-use-C1', expires: 500 }

for (const [failLocal, purpose] of [[false, 'launch_runtime'], [true, 'launch_runtime'], [false, 'execution_probe'], [true, 'execution_probe']] as const) test(`saved write failure recovers exact native C1 in a fresh process (${purpose}, partial save: ${failLocal})`, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-oauth-publication-TEST-'))
  const project = path.join(root, 'project')
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'),
    XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'),
    CLAUDE_MULTIMODEL_DATA_HOME: path.join(root, 'app-data'), CLAUDE_MULTIMODEL_CACHE_HOME: path.join(root, 'cache'),
    CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL: 'http://127.0.0.1:1/mcp' }
  const global = path.join(root, 'app-data', 'opencode', 'auth.json')
  const local = path.join(root, 'data', 'opencode', 'auth.json')
  const read = (authPath: string) => readOpenCodeAuthCredential({ authPath, providerId: 'xai' })
  try {
    await mkdir(project)
    for (const authPath of [global, local]) await upsertOpenCodeAuthCredential({ authPath, providerId: 'xai', credential: c0 })
    const manager = new OpenCodeProfileManager()
    const profile = await manager.prepareProfile(project, { profileScope: await resolveOpenCodeProfileScope({
      projectPath: project, selectedModel: 'xai/grok-4.3', purpose, env,
    }) })
    failurePath = failLocal ? local : global
    await expect(manager.withOwnedOAuthRefresh({ profile,
      assertHostOwnership: async () => {},
      operation: () => writeFile(profile.managedAuthPath, JSON.stringify({ xai: c1 })),
    })).rejects.toThrow('synthetic saved-owner atomic write failure')
    expect(await read(profile.managedAuthPath)).toEqual(c1)
    expect(await read(global)).toEqual(failLocal ? c1 : c0)
    expect(await read(local)).toEqual(c0)
    const receiptPath = `${global}.agent-teams-xai-oauth-save.json`
    const receipt = await readFile(receiptPath, 'utf8')
    // Selected authority refresh remains read-only, including when a receipt exists.
    await resolveOpenCodeProfileScope({ projectPath: project, selectedModel: 'xai/grok-4.3', purpose: 'launch_runtime', env, cacheSnapshot: false })
    expect(await readFile(receiptPath, 'utf8')).toBe(receipt)
    expect(await read(local)).toEqual(c0)
    failurePath = null
    const script = `import { OpenCodeProfileManager, resolveOpenCodeProfileScope } from ${JSON.stringify(path.join(import.meta.dir, 'OpenCodeProfileManager.ts'))};
      import { readOpenCodeAuthCredential } from ${JSON.stringify(path.join(import.meta.dir, 'OpenCodeAuthStore.ts'))};
      const projectPath = process.argv[1];
      const profileScope = await resolveOpenCodeProfileScope({ projectPath, selectedModel: 'xai/grok-4.3', purpose: 'launch_runtime' });
      const p = await new OpenCodeProfileManager().prepareProfile(projectPath, { profileScope });
      const c = await readOpenCodeAuthCredential({ authPath: p.managedAuthPath, providerId: 'xai' });
      process.stdout.write(c?.refresh === 'single-use-C1' ? 'recovered-C1' : 'wrong');`
    const child = Bun.spawn([process.execPath, '-e', script, project], { env, stdout: 'pipe', stderr: 'pipe' })
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect(stderr).toBe('')
    expect(code).toBe(0)
    expect(stdout).toBe('recovered-C1')
    expect(await read(global)).toEqual(c1)
    expect(await read(local)).toEqual(c1)
    expect(await Bun.file(receiptPath).exists()).toBe(false)
  } finally {
    failurePath = null
    await rm(root, { recursive: true, force: true })
  }
})

for (const mutation of ['duplicate', 'new-successor', 'account-swap', 'api', 'logout', 'config', 'project-config', 'source-paths', 'corrupt-source', 'corrupt-owner', 'native-result']) {
  test(`pending owned completion handles ${mutation} without overwriting changed authority`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-oauth-receipt-TEST-'))
    const project = path.join(root, 'project')
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'),
      XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'),
      CLAUDE_MULTIMODEL_DATA_HOME: path.join(root, 'app-data'), CLAUDE_MULTIMODEL_CACHE_HOME: path.join(root, 'cache'),
      CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL: 'http://127.0.0.1:1/mcp' }
    const global = path.join(root, 'app-data', 'opencode', 'auth.json')
    const receiptPath = `${global}.agent-teams-xai-oauth-save.json`
    const manager = new OpenCodeProfileManager()
    const resolve = () => resolveOpenCodeProfileScope({ projectPath: project, selectedModel: 'xai/grok-4.3', purpose: 'launch_runtime', env })
    const read = () => readOpenCodeAuthCredential({ authPath: global, providerId: 'xai' })
    try {
      await mkdir(project)
      await upsertOpenCodeAuthCredential({ authPath: global, providerId: 'xai', credential: c0 })
      const profile = await manager.prepareProfile(project, { profileScope: await resolve() })
      failurePath = global
      await expect(manager.withOwnedOAuthRefresh({ profile, assertHostOwnership: async () => {},
        operation: () => writeFile(profile.managedAuthPath, JSON.stringify({ xai: c1 })),
      })).rejects.toThrow('synthetic saved-owner atomic write failure')
      const receipt = await readFile(receiptPath, 'utf8')
      failurePath = null
      if (mutation === 'duplicate' || mutation === 'new-successor') {
        const profileScope = await resolve()
        expect(await read()).toEqual(c1)
        let expected = c1
        if (mutation === 'new-successor') {
          const fresh = await manager.prepareProfile(project, { profileScope })
          expected = { ...c1, access: 'synthetic-C2', refresh: 'single-use-C2' }
          await manager.withOwnedOAuthRefresh({ profile: fresh, assertHostOwnership: async () => {},
            operation: () => writeFile(fresh.managedAuthPath, JSON.stringify({ xai: expected })),
          })
        }
        // Replay only the old completed receipt, never an invented fresher token.
        await writeFile(receiptPath, receipt)
        await resolve()
        expect(await read()).toEqual(expected)
        expect(await Bun.file(receiptPath).exists()).toBe(false)
      } else if (mutation === 'account-swap' || mutation === 'api') {
        const replacement = mutation === 'api' ? { type: 'api', key: 'synthetic-replacement' }
          : { ...c1, accountId: 'different-account', refresh: 'different-account-refresh' }
        await upsertOpenCodeAuthCredential({ authPath: global, providerId: 'xai', credential: replacement })
        await resolve()
        expect(await read()).toEqual(replacement)
        expect(await Bun.file(receiptPath).exists()).toBe(false)
      } else if (mutation === 'logout') {
        await writeFile(global, '{}')
        await expect(resolve()).rejects.toThrow('requires explicit selected authentication')
        expect(await read()).toBeNull()
        expect(await Bun.file(receiptPath).exists()).toBe(false)
      } else if (['config', 'project-config', 'source-paths'].includes(mutation)) {
        if (mutation === 'config') {
          env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ provider: { xai: { options: { baseURL: 'http://test.invalid/changed' } } } })
        } else if (mutation === 'project-config') {
          await writeFile(path.join(project, 'opencode.json'), JSON.stringify({ provider: { xai: { options: { baseURL: 'http://test.invalid/changed-project' } } } }))
        } else {
          env.XDG_DATA_HOME = path.join(root, 'new-data')
        }
        const otherProject = path.join(root, 'other-project')
        await mkdir(otherProject)
        const freshScope = await resolveOpenCodeProfileScope({ projectPath: otherProject,
          selectedModel: 'xai/grok-4.3', purpose: 'launch_runtime', env })
        expect(freshScope.scopeToken).not.toBe(profile.scopeToken)
        expect(await read()).toEqual(c0)
        expect(await Bun.file(receiptPath).exists()).toBe(false)
        expect(await readOpenCodeAuthCredential({ authPath: profile.managedAuthPath, providerId: 'xai' })).toEqual(c1)
        const cnew = { ...c0, access: 'TEST-new-login', refresh: 'TEST-new-login-refresh' }
        await upsertOpenCodeAuthCredential({ authPath: global, providerId: 'xai', credential: cnew })
        const reopened = await manager.prepareProfile(otherProject, { profileScope: await resolveOpenCodeProfileScope({
          projectPath: otherProject, selectedModel: 'xai/grok-4.3', purpose: 'launch_runtime', env }) })
        expect(await readOpenCodeAuthCredential({ authPath: reopened.managedAuthPath, providerId: 'xai' })).toEqual(cnew)
      } else if (mutation.startsWith('corrupt-')) {
        const corrupted = JSON.parse(receipt)
        if (mutation === 'corrupt-source') corrupted.sourceAuthPaths[1] = 42
        else corrupted.managedAuthPath = path.join(path.dirname(profile.managedAuthPath), '..', 'foreign', 'auth.json')
        await writeFile(receiptPath, JSON.stringify(corrupted))
        env.XDG_DATA_HOME = path.join(root, 'new-source')
        await expect(resolve()).rejects.toThrow('invalid')
        expect(await read()).toEqual(c0)
        expect(await readFile(receiptPath, 'utf8')).toBe(JSON.stringify(corrupted))
      } else {
        await writeFile(profile.managedAuthPath, JSON.stringify({ xai: { ...c1, refresh: 'unowned-late-native' } }))
        await expect(resolve()).rejects.toThrow('native result changed')
        expect(await read()).toEqual(c0)
      }
    } finally {
      failurePath = null
      await rm(root, { recursive: true, force: true })
    }
  })
}

test.each(['admission', 'terminal-upgrade'])('native session receipt write failure preserves reuse: %s', async stage => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-oauth-arm-failure-TEST-'))
  const project = path.join(root, 'project')
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'),
    XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'),
    CLAUDE_MULTIMODEL_DATA_HOME: path.join(root, 'app-data'), CLAUDE_MULTIMODEL_CACHE_HOME: path.join(root, 'cache'),
    CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL: 'http://127.0.0.1:1/mcp' }
  const global = path.join(root, 'app-data', 'opencode', 'auth.json')
  const receiptPath = `${global}.agent-teams-xai-oauth-save.json`
  const read = (authPath: string) => readOpenCodeAuthCredential({ authPath, providerId: 'xai' })
  try {
    await mkdir(project)
    await upsertOpenCodeAuthCredential({ authPath: global, providerId: 'xai', credential: c0 })
    const manager = new OpenCodeProfileManager()
    const resolve = () => resolveOpenCodeProfileScope({ projectPath: project, selectedModel: 'xai/grok-4.3',
      purpose: 'launch_runtime', env, isOAuthNativeSessionSettled: async () => true })
    const profile = await manager.prepareProfile(project, { profileScope: await resolve() })
    let nativeCalls = 0
    const operation = () => manager.withOwnedOAuthRefresh({ profile, assertHostOwnership: async () => {},
      operation: async arm => {
        await arm({ record: { projectPath: project, profileScope: profile.profileScope,
          runId: 'TEST-run', opencodeSessionId: 'TEST-session' } as never,
          baseUrl: 'http://127.0.0.1:1', pid: 123, processStartedAtMs: 100, messageId: 'TEST-message', noReply: false })
        if (stage === 'terminal-upgrade') failurePath = receiptPath
        nativeCalls += 1
        await writeFile(profile.managedAuthPath, JSON.stringify({ xai: c1 }))
      } })
    if (stage === 'admission') failurePath = receiptPath
    await expect(operation()).rejects.toThrow('atomic write failure')
    expect(await read(global)).toEqual(c0)
    failurePath = null
    if (stage === 'admission') {
      expect(nativeCalls).toBe(0)
      expect(await read(profile.managedAuthPath)).toEqual(c0)
      expect(await Bun.file(receiptPath).exists()).toBe(false)
      await operation()
    } else {
      expect(nativeCalls).toBe(1)
      expect(JSON.parse(await readFile(receiptPath, 'utf8')).successor).toBeNull()
      await resolve()
    }
    expect(nativeCalls).toBe(1)
    expect(await read(global)).toEqual(c1)
    expect(await Bun.file(receiptPath).exists()).toBe(false)
    const reopened = await manager.prepareProfile(project, { profileScope: await resolve() })
    expect(await read(reopened.managedAuthPath)).toEqual(c1)
  } finally { failurePath = null; await rm(root, { recursive: true, force: true }) }
})

test('Stop publication failure retains the original lease until exact saved C1 is durable', async () => {
  const { OpenCodeSessionBridge } = await import('./OpenCodeSessionBridge.js')
  const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-oauth-stop-write-TEST-'))
  const project = path.join(root, 'project')
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'),
    XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'),
    CLAUDE_MULTIMODEL_DATA_HOME: path.join(root, 'app-data'), CLAUDE_MULTIMODEL_CACHE_HOME: path.join(root, 'cache'),
    CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL: 'http://127.0.0.1:1/mcp' }
  const global = path.join(root, 'app-data', 'opencode', 'auth.json')
  try {
    await mkdir(project)
    await upsertOpenCodeAuthCredential({ authPath: global, providerId: 'xai', credential: c0 })
    const manager = new OpenCodeProfileManager()
    const resolve = () => resolveOpenCodeProfileScope({ projectPath: project, selectedModel: 'xai/grok-4.3', purpose: 'launch_runtime', env })
    const profile = await manager.prepareProfile(project, { profileScope: await resolve() })
    const record = { teamId: 'TEST', laneId: 'primary', memberName: 'owner', runId: 'run', opencodeSessionId: 'session',
      hostKey: `host-${profile.scopeToken}`, projectPath: project, profileRootKey: profile.profileRootKey,
      profileScope: profile.profileScope, selectedModel: 'xai/grok-4.3', runtimePid: 123,
      managedAuthFingerprint: profile.managedAuthFingerprint, managedConfigFingerprint: profile.managedConfigFingerprint,
      expectedBehaviorFingerprint: 'TEST-seal' } as never
    await manager.withOwnedOAuthRefresh({ profile, assertHostOwnership: async () => {},
      operation: async arm => {
        await arm({ record, baseUrl: 'http://127.0.0.1:1', pid: 123, processStartedAtMs: 100,
          messageId: 'owned-message', noReply: false })
        await writeFile(profile.managedAuthPath, JSON.stringify({ xai: c1 }))
      }, isNativeSettled: () => false, allowNativeContinuation: true })
    let releases = 0
    const bridge = new OpenCodeSessionBridge({
      sessionStore: { get: async () => record, upsert: async () => 'unchanged', markStale: async () => null },
      hostManager: { ensureHost: async () => { throw new Error('must not spawn') }, releaseHost: async () => {},
        resolveOwnedSessionEndpoint: async () => ({ baseUrl: 'http://127.0.0.1:1', pid: 123 }),
        releaseHostLeaseStrict: async () => { releases += 1; return true } },
      clientFactory: { create: () => ({ abortSession: async () => true, getSessionStatus: async () => ({ session: 'idle' }),
        getSessionMessages: async () => [{ info: { id: 'owned-message', role: 'user' }, parts: [] }] }) as never },
    })
    failurePath = global
    await expect(bridge.releaseSession(record, { strictLeaseRelease: true })).rejects.toThrow('atomic write failure')
    expect(releases).toBe(0)
    expect(await readOpenCodeAuthCredential({ authPath: global, providerId: 'xai' })).toEqual(c0)
    failurePath = null
    await bridge.releaseSession(record, { strictLeaseRelease: true })
    expect(releases).toBe(1)
    expect(await readOpenCodeAuthCredential({ authPath: global, providerId: 'xai' })).toEqual(c1)
    expect(await Bun.file(`${global}.agent-teams-xai-oauth-save.json`).exists()).toBe(false)
  } finally { failurePath = null; await rm(root, { recursive: true, force: true }) }
})
