// Run in its own Bun process: the atomic writer is fault-injected at the module
// boundary, while resolver, native ownership and recovery remain real.
import { expect, mock, test } from 'bun:test'
import { mkdtemp, realpath, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as atomic from '../../utils/atomicWrite.js'

const writeJson = atomic.writeJsonFileAtomic
let failurePath: string | null = null
let failureAfter = false
mock.module('../../utils/atomicWrite.js', () => ({ ...atomic,
  writeJsonFileAtomic: async (filePath: string, value: unknown, options: Parameters<typeof writeJson>[2]) => {
    if (filePath === failurePath && !failureAfter) throw new Error('synthetic saved-owner atomic write failure')
    await writeJson(filePath, value, options)
    if (filePath === failurePath) throw new Error('synthetic saved-owner atomic write failure')
  },
}))
const { OpenCodeProfileManager, resolveOpenCodeProfileScope } = await import('./OpenCodeProfileManager.js')
const { readOpenCodeAuthCredential, readOpenCodeSavedAuthStore, openCodeOAuthSuccessorPath, upsertOpenCodeAuthCredential } = await import('./OpenCodeAuthStore.js')
const saved = async (global: string, env: NodeJS.ProcessEnv) => (await readOpenCodeSavedAuthStore({
  globalAuthPath: global, env, sourceAuthPaths: [global, path.join(env.XDG_DATA_HOME!, 'opencode', 'auth.json'),
    path.join(env.HOME!, '.local', 'share', 'opencode', 'auth.json')],
})).xai ?? null
const c0 = { type: 'oauth', access: 'synthetic-C0', refresh: 'single-use-C0', expires: 1000, accountId: 'TEST' }
const c1 = { ...c0, access: 'synthetic-C1', refresh: 'single-use-C1', expires: 500 }
const c2 = { ...c0, access: 'synthetic-C2', refresh: 'single-use-C2', expires: 250 }

for (const [failAfterRename, purpose] of [[false, 'launch_runtime'], [true, 'launch_runtime'], [false, 'execution_probe'], [true, 'execution_probe']] as const) test(`saved write failure recovers exact native C1 and consumes it for C2 in a fresh process (${purpose}, after successor rename: ${failAfterRename})`, async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'opencode-oauth-publication-TEST-')))
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
    failurePath = openCodeOAuthSuccessorPath(global)
    failureAfter = failAfterRename
    await expect(manager.withOwnedOAuthRefresh({ profile,
      assertHostOwnership: async () => {},
      operation: () => writeFile(profile.managedAuthPath, JSON.stringify({ xai: c1 })),
    })).rejects.toThrow('synthetic saved-owner atomic write failure')
    expect(await read(profile.managedAuthPath)).toEqual(c1)
    expect(await read(global)).toEqual(c0)
    expect(await read(local)).toEqual(c0)
    const receiptPath = `${global}.agent-teams-xai-oauth-save.json`
    const receipt = await readFile(receiptPath, 'utf8')
    // Selected authority refresh remains read-only, including when a receipt exists.
    await resolveOpenCodeProfileScope({ projectPath: project, selectedModel: 'xai/grok-4.3', purpose: 'launch_runtime', env, cacheSnapshot: false })
    expect(await readFile(receiptPath, 'utf8')).toBe(receipt)
    expect(await read(local)).toEqual(c0)
    failurePath = null; failureAfter = false
    const script = `import { OpenCodeProfileManager, resolveOpenCodeProfileScope } from ${JSON.stringify(path.join(import.meta.dir, 'OpenCodeProfileManager.ts'))};
      import { readOpenCodeAuthCredential } from ${JSON.stringify(path.join(import.meta.dir, 'OpenCodeAuthStore.ts'))};
      import { writeFile } from 'node:fs/promises';
      import { isDeepStrictEqual } from 'node:util';
      const projectPath = process.argv[1];
      const profileScope = await resolveOpenCodeProfileScope({ projectPath, selectedModel: 'xai/grok-4.3', purpose: 'launch_runtime' });
      const manager = new OpenCodeProfileManager();
      const p = await manager.prepareProfile(projectPath, { profileScope });
      const c = await readOpenCodeAuthCredential({ authPath: p.managedAuthPath, providerId: 'xai' });
      if (!isDeepStrictEqual(c, ${JSON.stringify(c1)})) throw new Error('TEST fresh recovery did not select exact C1');
      let consumed = false;
      await manager.withOwnedOAuthRefresh({ profile: p, assertHostOwnership: async () => {}, operation: async () => {
        const current = await readOpenCodeAuthCredential({ authPath: p.managedAuthPath, providerId: 'xai' });
        if (consumed || !isDeepStrictEqual(current, c)) throw new Error('TEST duplicate or wrong predecessor consumption');
        consumed = true;
        await writeFile(p.managedAuthPath, JSON.stringify({ xai: ${JSON.stringify(c2)} }));
      } });
      if (!consumed || !isDeepStrictEqual(await manager.readSavedOAuthCredential(p), ${JSON.stringify(c2)})) {
        throw new Error('TEST fresh process did not publish C2');
      }
      process.stdout.write('recovered-C1-consumed-for-C2');`
    const child = Bun.spawn([process.execPath, '-e', script, project], { env, stdout: 'pipe', stderr: 'pipe' })
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect(stderr).toBe('')
    expect(code).toBe(0)
    expect(stdout).toBe('recovered-C1-consumed-for-C2')
    expect(await saved(global, env)).toEqual(c2)
    expect(await read(local)).toEqual(c0)
    expect(await Bun.file(receiptPath).exists()).toBe(false)
  } finally {
    failurePath = null; failureAfter = false
    await rm(root, { recursive: true, force: true })
  }
})

for (const mutation of ['duplicate', 'new-successor', 'account-swap', 'api', 'logout', 'config', 'project-config', 'source-paths', 'corrupt-source', 'corrupt-owner', 'native-result']) {
  test(`pending owned completion handles ${mutation} without overwriting changed authority`, async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'opencode-oauth-receipt-TEST-')))
    const project = path.join(root, 'project')
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'),
      XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'),
      CLAUDE_MULTIMODEL_DATA_HOME: path.join(root, 'app-data'), CLAUDE_MULTIMODEL_CACHE_HOME: path.join(root, 'cache'),
      CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL: 'http://127.0.0.1:1/mcp' }
    const global = path.join(root, 'app-data', 'opencode', 'auth.json')
    const receiptPath = `${global}.agent-teams-xai-oauth-save.json`
    const manager = new OpenCodeProfileManager()
    const resolve = () => resolveOpenCodeProfileScope({ projectPath: project, selectedModel: 'xai/grok-4.3', purpose: 'launch_runtime', env })
    const read = () => saved(global, env)
    try {
      await mkdir(project)
      await upsertOpenCodeAuthCredential({ authPath: global, providerId: 'xai', credential: c0 })
      const profile = await manager.prepareProfile(project, { profileScope: await resolve() })
      failurePath = openCodeOAuthSuccessorPath(global)
      await expect(manager.withOwnedOAuthRefresh({ profile, assertHostOwnership: async () => {},
        operation: () => writeFile(profile.managedAuthPath, JSON.stringify({ xai: c1 })),
      })).rejects.toThrow('synthetic saved-owner atomic write failure')
      const receipt = await readFile(receiptPath, 'utf8')
      failurePath = null; failureAfter = false
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
        const spent = await manager.prepareProfile(otherProject, { profileScope: freshScope })
        let spentCalls = 0
        await expect(manager.withOwnedOAuthRefresh({ profile: spent, assertHostOwnership: async () => {},
          operation: async () => { spentCalls += 1 },
        })).rejects.toThrow('pending')
        expect(spentCalls).toBe(0)
        const cnew = { ...c0, access: 'TEST-new-login', refresh: 'TEST-new-login-refresh' }
        await upsertOpenCodeAuthCredential({ authPath: global, providerId: 'xai', credential: cnew })
        const reopened = await manager.prepareProfile(otherProject, { profileScope: await resolveOpenCodeProfileScope({
          projectPath: otherProject, selectedModel: 'xai/grok-4.3', purpose: 'launch_runtime', env }) })
        expect(await readOpenCodeAuthCredential({ authPath: reopened.managedAuthPath, providerId: 'xai' })).toEqual(cnew)
        const cnext = { ...cnew, access: 'TEST-new-next', refresh: 'TEST-new-next-refresh' }
        await manager.withOwnedOAuthRefresh({ profile: reopened, assertHostOwnership: async () => {},
          operation: () => writeFile(reopened.managedAuthPath, JSON.stringify({ xai: cnext })),
        })
        expect(await read()).toEqual(cnext)
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
      failurePath = null; failureAfter = false
      await rm(root, { recursive: true, force: true })
    }
  })
}

test.each(['admission', 'terminal-upgrade'])('native session receipt write failure preserves reuse: %s', async stage => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'opencode-oauth-arm-failure-TEST-')))
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
    failurePath = null; failureAfter = false
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
    expect(await saved(global, env)).toEqual(c1)
    expect(await Bun.file(receiptPath).exists()).toBe(false)
    const reopened = await manager.prepareProfile(project, { profileScope: await resolve() })
    expect(await read(reopened.managedAuthPath)).toEqual(c1)
  } finally { failurePath = null; await rm(root, { recursive: true, force: true }) }
})

test('Stop publication failure retains the original lease until exact saved C1 is durable', async () => {
  const { OpenCodeSessionBridge } = await import('./OpenCodeSessionBridge.js')
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'opencode-oauth-stop-write-TEST-')))
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
    failurePath = openCodeOAuthSuccessorPath(global)
    await expect(bridge.releaseSession(record, { strictLeaseRelease: true })).rejects.toThrow('atomic write failure')
    expect(releases).toBe(0)
    expect(await readOpenCodeAuthCredential({ authPath: global, providerId: 'xai' })).toEqual(c0)
    failurePath = null; failureAfter = false
    await bridge.releaseSession(record, { strictLeaseRelease: true })
    expect(releases).toBe(1)
    expect(await saved(global, env)).toEqual(c1)
    expect(await Bun.file(`${global}.agent-teams-xai-oauth-save.json`).exists()).toBe(false)
  } finally { failurePath = null; await rm(root, { recursive: true, force: true }) }
})

for (const failAfterRename of [false, true]) test(`revoked admission archive failure keeps the active fence (after rename: ${failAfterRename})`, async () => {
  const { createHash } = await import('node:crypto')
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'opencode-oauth-archive-TEST-')))
  const project = path.join(root, 'project')
  const env = { HOME: path.join(root, 'home'), XDG_CONFIG_HOME: path.join(root, 'config'),
    XDG_DATA_HOME: path.join(root, 'data'), CLAUDE_MULTIMODEL_DATA_HOME: path.join(root, 'app'),
    CLAUDE_MULTIMODEL_CACHE_HOME: path.join(root, 'cache'),
    CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL: 'http://127.0.0.1:1/mcp' }
  const global = path.join(env.CLAUDE_MULTIMODEL_DATA_HOME, 'opencode', 'auth.json')
  const receiptPath = `${global}.agent-teams-xai-oauth-save.json`
  const archive = `${receiptPath}.revoked-${createHash('sha256').update(c0.refresh).digest('hex')}`
  try {
    await mkdir(project)
    await upsertOpenCodeAuthCredential({ authPath: global, providerId: 'xai', credential: c0 })
    const manager = new OpenCodeProfileManager()
    const resolve = () => resolveOpenCodeProfileScope({ projectPath: project, selectedModel: 'xai/grok-4.3', purpose: 'launch_runtime', env })
    const profile = await manager.prepareProfile(project, { profileScope: await resolve() })
    await manager.withOwnedOAuthRefresh({ profile, assertHostOwnership: async () => {},
      operation: async arm => {
        await arm({ record: { projectPath: project, profileScope: profile.profileScope,
          runId: 'TEST-run', opencodeSessionId: 'TEST-session' } as never,
          baseUrl: 'http://127.0.0.1:1', pid: 123, processStartedAtMs: 100, messageId: 'TEST-message', noReply: false })
      }, isNativeSettled: () => false, allowNativeContinuation: true })
    const receipt = await readFile(receiptPath, 'utf8')
    const replacement = { ...c0, accountId: 'TEST-new', refresh: 'TEST-new-login' }
    await upsertOpenCodeAuthCredential({ authPath: global, providerId: 'xai', credential: replacement })
    failurePath = archive; failureAfter = failAfterRename
    await expect(resolve()).rejects.toThrow('atomic write failure')
    expect(await readFile(receiptPath, 'utf8')).toBe(receipt)
    expect(await readOpenCodeAuthCredential({ authPath: global, providerId: 'xai' })).toEqual(replacement)
    if (failAfterRename) expect(JSON.parse(await readFile(archive, 'utf8'))).toEqual(JSON.parse(receipt))
    else expect(await Bun.file(archive).exists()).toBe(false)
    failurePath = null; failureAfter = false
    const fresh = await manager.prepareProfile(project, { profileScope: await resolve() })
    expect(await readOpenCodeAuthCredential({ authPath: fresh.managedAuthPath, providerId: 'xai' })).toEqual(replacement)
    expect(await Bun.file(receiptPath).exists()).toBe(false)
    expect(JSON.parse(await readFile(archive, 'utf8'))).toEqual(JSON.parse(receipt))
    // An archived unresolved admission must deny the same refresh token even
    // if an external writer changes its access/expiry fields.
    const changedC0 = { ...c0, access: 'TEST-changed-access', expires: 2000 }
    await upsertOpenCodeAuthCredential({ authPath: global, providerId: 'xai', credential: changedC0 })
    const denied = await manager.prepareProfile(project, { profileScope: await resolve() })
    let nativeCalls = 0
    await expect(manager.withOwnedOAuthRefresh({ profile: denied, assertHostOwnership: async () => {},
      operation: async () => { nativeCalls += 1 },
    })).rejects.toThrow('revoked pending native admission')
    expect(nativeCalls).toBe(0)
    expect(JSON.parse(await readFile(archive, 'utf8'))).toEqual(JSON.parse(receipt))
  } finally { failurePath = null; failureAfter = false; await rm(root, { recursive: true, force: true }) }
})
