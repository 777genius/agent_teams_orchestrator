// Offline restart regression fixtures: synthetic credentials and canonical native history.
// No provider process, credential discovery, or network transport.
import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  OpenCodeProfileManager, resolveOpenCodeProfileScope, isOpenCodeOAuthPublicationScopeCurrent,
} from './OpenCodeProfileManager.js'
import {
  readOpenCodeAuthCredential, readOpenCodeSavedAuthStore, recoverOpenCodeOwnedOAuthSave,
  upsertOpenCodeAuthCredential, openCodeOAuthSuccessorPath,
} from './OpenCodeAuthStore.js'
import { OpenCodeSessionStore } from './OpenCodeSessionStore.js'
import { OpenCodeExecutionProbe } from './OpenCodeExecutionProbe.js'
import { readProcessStartTimeMs } from '../../utils/processKill.js'

const c0 = { type: 'oauth', access: 'AUDIT-C0', refresh: 'AUDIT-single-use-C0', expires: 1000, accountId: 'AUDIT-account' }
const c1 = { ...c0, access: 'AUDIT-C1', refresh: 'AUDIT-single-use-C1', expires: 500 }
const roots: string[] = []
const manager = new OpenCodeProfileManager()
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const read = (authPath: string) => readOpenCodeAuthCredential({ authPath, providerId: 'xai' })
const exists = (file: string) => Bun.file(file).exists()

async function fixture(options: { session?: boolean, purpose?: 'launch_runtime' | 'execution_probe', remote?: boolean,
  terminal?: string, successor?: typeof c0 } = {}) {
  const root = await realpath(await mkdtemp('/tmp/oauth-restart-audit-'))
  roots.push(root)
  const project = path.join(root, 'project')
  await mkdir(project)
  await mkdir(path.join(root, 'tmp'))
  const env: NodeJS.ProcessEnv = {
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, NODE_ENV: 'test',
    HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'),
    XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'),
    XDG_CACHE_HOME: path.join(root, 'cache'), XDG_STATE_HOME: path.join(root, 'state'),
    TMPDIR: path.join(root, 'tmp'),
    CLAUDE_MULTIMODEL_DATA_HOME: path.join(root, 'app-data'), CLAUDE_MULTIMODEL_CACHE_HOME: path.join(root, 'app-cache'),
    CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND: process.execPath,
    CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ARGS_JSON: JSON.stringify([path.join(root, 'never-executed-mcp.js')]),
    CLAUDE_TEAM_CONTROL_URL: 'http://127.0.0.1:43101', AGENT_TEAMS_MCP_CLAUDE_DIR: path.join(root, 'claude'),
    ...(options.remote ? { CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL: 'http://127.0.0.1:43101/mcp' } : {}),
  }
  const purpose = options.purpose ?? 'launch_runtime'
  const global = path.join(root, 'app-data', 'opencode', 'auth.json')
  const receiptPath = `${global}.agent-teams-xai-oauth-save.json`
  const archivePath = `${receiptPath}.revoked-${createHash('sha256').update(c0.refresh).digest('hex')}`
  await upsertOpenCodeAuthCredential({ authPath: global, providerId: 'xai', credential: c0 })
  const profile = await manager.prepareProfile(project, { profileScope: await resolveOpenCodeProfileScope({
    projectPath: project, selectedModel: 'xai/grok-4.3', purpose, env,
  }) })
  // Real OS birth and ESRCH; this child is only a synthetic writer lifetime.
  const child = Bun.spawn([process.execPath, '-e', 'await Bun.stdin.text()'], { env, stdin: 'pipe', stdout: 'ignore', stderr: 'pipe' })
  let native: any
  try {
    const birth = await readProcessStartTimeMs(child.pid)
    expect(birth).toBeGreaterThan(0)
    native = { projectPath: project, scopeToken: profile.scopeToken!, profileRootKey: profile.profileRootKey,
      hostKey: `audit-host::${profile.scopeToken}`, baseUrl: 'http://127.0.0.1:43210',
      pid: child.pid, processStartedAtMs: birth!, sessionId: 'audit-session', messageId: 'audit-message', selectedModel: 'xai/grok-4.3' }
    let sessionOwner: any
    if (options.session) {
      const now = new Date().toISOString()
      const record = { teamId: 'AUDIT', laneId: 'primary', memberName: 'owner', runId: 'audit-run',
        providerId: 'opencode' as const, selectedModel: native.selectedModel, projectPath: project,
        profileRootKey: profile.profileRootKey, hostKey: native.hostKey, profileScope: profile.profileScope,
        runtimePid: child.pid, resolvedBehaviorFingerprint: 'audit-behavior', opencodeSessionId: native.sessionId,
        lastCanonicalCursor: null, lastKnownRawStatus: null, lastKnownDurableState: null,
        sourceAuthFingerprint: profile.sourceAuthFingerprint, managedAuthFingerprint: profile.managedAuthFingerprint,
        projectBehaviorFingerprint: profile.projectBehaviorFingerprint, managedConfigFingerprint: profile.managedConfigFingerprint,
        expectedBehaviorFingerprint: 'audit-proof', staleReason: null, createdAt: now, updatedAt: now }
      sessionOwner = { record, baseUrl: native.baseUrl, pid: child.pid, processStartedAtMs: birth!,
        messageId: native.messageId, noReply: false }
      await new OpenCodeSessionStore(path.join(path.dirname(global), 'session-store.json')).upsert(record)
      const leaseKey = 'AUDIT::primary::owner'
      await writeFile(path.join(path.dirname(global), 'host-registry.json'), JSON.stringify({
        schemaVersion: 1, processIdentityFormat: 'platform-native-v2', hosts: { [record.hostKey]: {
          ...record, baseUrl: native.baseUrl, port: 43210, pid: child.pid, processStartedAtMs: birth,
          version: 'AUDIT', resolvedConfigFingerprint: profile.managedConfigFingerprint,
          leases: { [leaseKey]: { leaseKey, teamId: record.teamId, laneId: record.laneId,
            memberName: record.memberName, runId: record.runId, sessionId: native.sessionId,
            createdAt: now, updatedAt: now } },
        } },
      }))
    }
    await manager.withOwnedOAuthRefresh({ profile, assertHostOwnership: async () => {},
      operation: async (armSession, armProbe) => {
        if (sessionOwner) await armSession(sessionOwner)
        else await armProbe(native)
      },
      isNativeSettled: () => false, allowNativeContinuation: true })
    await writeFile(profile.managedAuthPath, JSON.stringify({ xai: options.successor ?? c1 }))
    const db = new Database(path.join(path.dirname(profile.managedAuthPath), 'opencode.db'))
    try {
      db.exec(`create table message (id text primary key, session_id text, time_created integer, time_updated integer, data text);
        create table part (id text, message_id text, session_id text, time_created integer, time_updated integer, data text);
        create table session (id text, project_id text, directory text);
        create table project (id text, worktree text, vcs text);`)
      db.query('insert into session values (?, ?, ?)').run(native.sessionId, 'audit-project', options.terminal === 'directory' ? path.join(root, 'foreign') : project)
      db.query('insert into project values (?, ?, ?)').run('audit-project', project, 'git')
      const assistant: any = { id: 'audit-assistant', role: 'assistant', parentID: native.messageId,
        providerID: 'xai', modelID: 'grok-4.3', time: { completed: 1 } }
      if (options.terminal === 'parent') assistant.parentID = 'foreign'
      if (options.terminal === 'provider') assistant.providerID = 'foreign'
      if (options.terminal === 'model') assistant.modelID = 'foreign'
      if (options.terminal === 'incomplete') delete assistant.time
      for (const info of [{ id: native.messageId, role: 'user' }, assistant]) {
        db.query('insert into message values (?, ?, ?, ?, ?)').run(info.id, native.sessionId, 1, null, JSON.stringify(info))
      }
    } finally { db.close() }
  } finally { child.stdin.end(); expect(await child.exited).toBe(0) }
  const receiptText = await readFile(receiptPath, 'utf8')
  const receipt = JSON.parse(receiptText)
  expect(receipt.successor).toBeNull()
  return { root, project, purpose, env, profile, global, receiptPath, archivePath, native, receipt, receiptText }
}
type Fixture = Awaited<ReturnType<typeof fixture>>

// A new Bun process has no parent's effective-config snapshot map. Default
// production recovery must use the exited writer's canonical SQLite history.
async function fresh(f: Fixture, env = f.env, purpose = f.purpose, project = f.project, fault?: { path: string, after: boolean }) {
  const modulePath = path.resolve(import.meta.dir, './OpenCodeProfileManager.ts')
  const inject = fault ? `const { mock } = await import('bun:test');
    const atomicPath = ${JSON.stringify(path.resolve(import.meta.dir, '../../utils/atomicWrite.ts'))};
    const atomic = await import(atomicPath); const originalWrite = atomic.writeJsonFileAtomic;
    mock.module(atomicPath, () => ({ ...atomic, writeJsonFileAtomic: async (p, v, o) => {
      if (p === ${JSON.stringify(fault.path)} && !${fault.after}) throw new Error('AUDIT crash boundary');
      await originalWrite(p, v, o);
      if (p === ${JSON.stringify(fault.path)}) throw new Error('AUDIT crash boundary');
    } }));` : ''
  const script = `${inject}globalThis.fetch = async () => { throw new Error('AUDIT forbids network') };
    const { resolveOpenCodeProfileScope } = await import(${JSON.stringify(modulePath)});
    try { const scope = await resolveOpenCodeProfileScope({ projectPath: process.argv[1], selectedModel: 'xai/grok-4.3', purpose: process.argv[2] });
      process.stdout.write(JSON.stringify({ ok: true, scope }));
    } catch (e) { process.stdout.write(JSON.stringify({ ok: false, error: e.message })); }`
  const child = Bun.spawn([process.execPath, '-e', script, project, purpose], { env, stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  expect(err).toBe(''); expect(code).toBe(0)
  return JSON.parse(out)
}
const current = (f: Fixture, env = f.env) => isOpenCodeOAuthPublicationScopeCurrent(f.receipt.owner, c0, env)
const saved = (f: Fixture, env = f.env) => readOpenCodeSavedAuthStore({ globalAuthPath: f.global, sourceAuthPaths: f.receipt.sourceAuthPaths, env })

test('same-env fresh process harvests exact exited probe C1 and keeps native saved sources unchanged', async () => {
  const f = await fixture()
  expect(await current(f)).toBe(true)
  expect((await fresh(f)).ok).toBe(true)
  expect((await saved(f)).xai).toEqual(c1)
  expect(await read(f.global)).toEqual(c0)
  expect(await exists(f.receiptPath)).toBe(false)
  expect(await exists(f.archivePath)).toBe(false)
  const successor = await Bun.file(openCodeOAuthSuccessorPath(f.global)).json()
  expect(successor.owner).toEqual(f.receipt.owner)
  expect(successor.before).toEqual(f.receipt.before)
  expect(successor.predecessor).toEqual(c0)
  const next = await manager.prepareProfile(f.project, { profileScope: await resolveOpenCodeProfileScope({
    projectPath: f.project, selectedModel: 'xai/grok-4.3', purpose: f.purpose, env: f.env }) })
  expect(await read(next.managedAuthPath)).toEqual(c1)
})

test.each([false, true])('restart acceptance: original completed C1 is selected by a fresh new-port launch (session: %s)', async session => {
  const f = await fixture({ session })
  const changed = { ...f.env, CLAUDE_TEAM_CONTROL_URL: 'http://127.0.0.1:43102' }
  expect(await new OpenCodeExecutionProbe().isOwnedOAuthNativeProbeSettled(f.native, path.join(f.root, 'app-data'))).toBe(true)
  expect((await fresh(f, changed)).ok).toBe(true)
  expect((await saved(f, changed)).xai).toEqual(c1)
  const authority = await Bun.file(openCodeOAuthSuccessorPath(f.global)).json()
  expect(authority.owner).toEqual(f.receipt.owner)
  expect(authority.predecessor).toEqual(c0)
  expect(authority.before).toEqual(f.receipt.before)
  expect(authority.completion.nativeProbe).toEqual(f.receipt.nativeProbe)
  expect(authority.completion.nativeSession).toEqual(f.receipt.nativeSession)
  const scope = await resolveOpenCodeProfileScope({ projectPath: f.project,
    selectedModel: 'xai/grok-4.3', purpose: f.purpose, env: changed })
  expect(scope.scopeToken).not.toBe(f.profile.scopeToken)
  const next = await manager.prepareProfile(f.project, { profileScope: scope })
  expect(await read(next.managedAuthPath)).toEqual(c1)
  let oldOperations = 0
  await expect(manager.withOwnedOAuthRefresh({ profile: f.profile, assertHostOwnership: async () => {},
    operation: async () => { oldOperations++ },
  })).rejects.toThrow('scope changed')
  expect(oldOperations).toBe(0)
  const c2 = { ...c1, access: 'AUDIT-C2', refresh: 'AUDIT-single-use-C2', expires: 250 }
  await manager.withOwnedOAuthRefresh({ profile: next, assertHostOwnership: async () => {},
    operation: async () => { await writeFile(next.managedAuthPath, JSON.stringify({ xai: c2 })) } })
  expect((await saved(f, changed)).xai).toEqual(c2)
  expect(await read(f.global)).toEqual(c0)
})

for (const drift of ['missing-control', 'claude-dir', 'command', 'args', 'remote-port', 'control-host', 'control-path', 'control-query', 'control-scheme', 'security-env']) {
  test(`unauthorized transition retains terminal evidence and fences publication: ${drift}`, async () => {
    const f = await fixture({ remote: drift === 'remote-port' })
    const changed = { ...f.env }
    if (drift === 'control-host') changed.CLAUDE_TEAM_CONTROL_URL = 'http://127.0.0.2:43102'
    if (drift === 'control-path') changed.CLAUDE_TEAM_CONTROL_URL += '/other'
    if (drift === 'control-query') changed.CLAUDE_TEAM_CONTROL_URL += '?authority=other'
    if (drift === 'control-scheme') changed.CLAUDE_TEAM_CONTROL_URL = 'https://127.0.0.1:43102'
    if (drift === 'security-env') changed.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENV_JSON = JSON.stringify({ FOREIGN_AUTHORITY: 'other' })
    if (drift === 'missing-control') delete changed.CLAUDE_TEAM_CONTROL_URL
    if (drift === 'claude-dir') changed.AGENT_TEAMS_MCP_CLAUDE_DIR = path.join(f.root, 'different-claude')
    if (drift === 'command') changed.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND = '/audit/never-executed-other-bun'
    if (drift === 'args') changed.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ARGS_JSON = JSON.stringify([path.join(f.root, 'other-mcp.js')])
    if (drift === 'remote-port') changed.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL = 'http://127.0.0.1:43102/mcp'
    expect(await current(f, changed)).toBe(false)
    expect(await new OpenCodeExecutionProbe().isOwnedOAuthNativeProbeSettled(f.native, path.join(f.root, 'app-data'))).toBe(true)
    expect((await fresh(f, changed)).ok).toBe(true)
    expect(await exists(f.receiptPath)).toBe(false)
    expect(await Bun.file(f.archivePath).json()).toEqual({ ...f.receipt, successor: c1 })
    expect(await exists(openCodeOAuthSuccessorPath(f.global))).toBe(false)
    expect(await read(f.profile.managedAuthPath)).toEqual(c1)
    expect(await read(f.global)).toEqual(c0)
    // Returning to the original environment cannot revive the archived receipt.
    expect((await fresh(f)).ok).toBe(true)
    expect((await saved(f)).xai).toEqual(c0)
    let operations = 0
    await expect(manager.withOwnedOAuthRefresh({ profile: f.profile, assertHostOwnership: async () => {},
      operation: async () => { operations++ } })).rejects.toThrow('revoked pending native admission')
    expect(operations).toBe(0)
  })
}

test('new control port retains exact terminal checks before publishing', async () => {
  const f = await fixture()
  let checks = 0
  await resolveOpenCodeProfileScope({ projectPath: f.project, selectedModel: 'xai/grok-4.3', purpose: f.purpose,
    env: { ...f.env, CLAUDE_TEAM_CONTROL_URL: 'http://127.0.0.1:43102' },
    isOAuthNativeProbeSettled: async () => { checks++; return true } })
  expect(checks).toBe(2)
  expect((await saved(f, { ...f.env, CLAUDE_TEAM_CONTROL_URL: 'http://127.0.0.1:43102' })).xai).toEqual(c1)
})

test('execution_probe-owned receipt ignores app MCP drift and remains recoverable', async () => {
  const f = await fixture({ purpose: 'execution_probe' })
  const changed = { ...f.env, CLAUDE_TEAM_CONTROL_URL: 'http://127.0.0.1:43102', AGENT_TEAMS_MCP_CLAUDE_DIR: path.join(f.root, 'other') }
  expect(await current(f, changed)).toBe(true)
  expect((await fresh(f, changed)).ok).toBe(true)
  expect((await saved(f, changed)).xai).toEqual(c1)
})

test('retained prepared environment recovers old scope and new launch independently admits C1', async () => {
  const f = await fixture()
  const retained = { ...f.profile.env, CLAUDE_TEAM_CONTROL_URL: 'http://127.0.0.1:43102' }
  expect(await current(f, retained)).toBe(true)
  expect((await fresh(f, retained)).ok).toBe(true)
  expect((await saved(f)).xai).toEqual(c1)
  const newPort = { ...f.env, CLAUDE_TEAM_CONTROL_URL: 'http://127.0.0.1:43102' }
  expect((await saved(f, newPort)).xai).toEqual(c1)
  expect((await fresh(f, newPort)).ok).toBe(true)
  expect(await exists(f.archivePath)).toBe(false)
  expect((await saved(f)).xai).toEqual(c1)
})

test('already-published C1 admits port drift read-only without rewriting original authority', async () => {
  const f = await fixture()
  expect((await fresh(f)).ok).toBe(true)
  const authorityPath = openCodeOAuthSuccessorPath(f.global)
  const authority = await readFile(authorityPath, 'utf8')
  const changed = { ...f.env, CLAUDE_TEAM_CONTROL_URL: 'http://127.0.0.1:43102' }
  expect((await fresh(f, changed)).ok).toBe(true)
  expect((await saved(f, changed)).xai).toEqual(c1)
  expect(await readFile(authorityPath, 'utf8')).toBe(authority)
  expect(await exists(f.archivePath)).toBe(false)
  expect((await saved(f)).xai).toEqual(c1)
})

for (const terminal of ['parent', 'provider', 'model', 'incomplete', 'directory']) {
  test(`new-port scope preserves receipt and rejects invalid terminal provenance: ${terminal}`, async () => {
    const f = await fixture({ terminal })
    expect((await fresh(f, { ...f.env, CLAUDE_TEAM_CONTROL_URL: 'http://127.0.0.1:43102' })).ok).toBe(false)
    expect(await readFile(f.receiptPath, 'utf8')).toBe(f.receiptText)
    expect(await exists(f.archivePath)).toBe(false)
    expect(await exists(openCodeOAuthSuccessorPath(f.global))).toBe(false)
    expect(await read(f.global)).toEqual(c0)
  })
}

test('terminal proof does not publish a successor from a different account', async () => {
  const f = await fixture({ successor: { ...c1, accountId: 'AUDIT-foreign' } })
  expect((await fresh(f)).error).toContain('did not retain its OAuth account')
  expect(await readFile(f.receiptPath, 'utf8')).toBe(f.receiptText)
  expect(await exists(openCodeOAuthSuccessorPath(f.global))).toBe(false)
})

for (const mutation of ['saved-account', 'source-paths', 'provider-config']) {
  test(`true provenance/configuration revocation never overwrites current saved authority: ${mutation}`, async () => {
    const f = await fixture()
    const changed = { ...f.env }
    const replacement = { ...c0, accountId: 'AUDIT-new-account', refresh: 'AUDIT-new-login' }
    if (mutation === 'saved-account') await upsertOpenCodeAuthCredential({ authPath: f.global, providerId: 'xai', credential: replacement })
    if (mutation === 'source-paths') changed.XDG_DATA_HOME = path.join(f.root, 'other-source')
    if (mutation === 'provider-config') changed.OPENCODE_CONFIG_CONTENT = JSON.stringify({ provider: { xai: { options: { baseURL: 'http://invalid.audit/provider' } } } })
    expect((await fresh(f, changed)).ok).toBe(true)
    expect(await Bun.file(f.archivePath).json()).toEqual({ ...f.receipt, successor: c1 })
    expect(await read(f.global)).toEqual(mutation === 'saved-account' ? replacement : c0)
    expect(await exists(openCodeOAuthSuccessorPath(f.global))).toBe(false)
  })
}

test('AuthStore owner comparison failure retains terminal capture without admission', async () => {
  const f = await fixture()
  let checks = 0
  await expect(recoverOpenCodeOwnedOAuthSave({ globalAuthPath: f.global, sourceAuthPaths: f.receipt.sourceAuthPaths,
    env: f.env, assertOwner: async () => { throw new Error('AUDIT missing trusted context') },
    isNativeProbeSettled: async () => { checks++; return true } })).rejects.toThrow('AUDIT missing trusted context')
  expect(checks).toBe(2)
  expect(await Bun.file(f.receiptPath).json()).toEqual({ ...f.receipt, successor: c1 })
  expect(await exists(f.archivePath)).toBe(false)
  expect((await fresh(f)).ok).toBe(true)
})

test('cacheSnapshot:false compares current scope without attempting pending recovery', async () => {
  const f = await fixture()
  const changed = { ...f.env, CLAUDE_TEAM_CONTROL_URL: 'http://127.0.0.1:43102' }
  const compared = await resolveOpenCodeProfileScope({ projectPath: f.project, selectedModel: 'xai/grok-4.3',
    purpose: f.purpose, env: changed, cacheSnapshot: false })
  expect(compared.scopeToken).not.toBe(f.profile.scopeToken)
  expect(await readFile(f.receiptPath, 'utf8')).toBe(f.receiptText)
  expect(await exists(f.archivePath)).toBe(false)
  expect(await exists(openCodeOAuthSuccessorPath(f.global))).toBe(false)
})

test('unresolvable MCP configuration is a comparison error and preserves the receipt', async () => {
  const f = await fixture()
  const result = await fresh(f, { ...f.env, CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL: 'invalid-url' })
  expect(result.ok).toBe(false)
  expect(result.error).toContain('must be an http(s) URL')
  expect(await Bun.file(f.receiptPath).json()).toEqual({ ...f.receipt, successor: c1 })
  expect(await exists(f.archivePath)).toBe(false)
})

for (const missing of ['legacy', 'unknown-version', 'wrong-scope']) {
  test(`missing or invalid recovery binding preserves capture without new admission: ${missing}`, async () => {
    const f = await fixture()
    const receipt = structuredClone(f.receipt)
    if (missing === 'legacy') delete receipt.owner.credentialBinding
    if (missing === 'unknown-version') receipt.owner.credentialBinding.version = 99
    if (missing === 'wrong-scope') receipt.owner.credentialBinding.scopeToken = 'a'.repeat(64)
    await writeFile(f.receiptPath, JSON.stringify(receipt))
    const changed = { ...f.env, CLAUDE_TEAM_CONTROL_URL: 'http://127.0.0.1:43102' }
    for (let i = 0; i < 2; i++) {
      const result = await fresh(f, changed)
      expect(result.ok).toBe(false)
      expect(result.error).toContain('binding')
      expect(await Bun.file(f.receiptPath).json()).toEqual({ ...receipt, successor: c1 })
      expect(await exists(openCodeOAuthSuccessorPath(f.global))).toBe(false)
      expect(await exists(f.archivePath)).toBe(false)
    }
    if (missing === 'legacy') {
      // Exact retained original context can still admit a legacy capture.
      expect((await fresh(f)).ok).toBe(true)
      await expect(saved(f, changed)).rejects.toThrow('saved successor scope')
    }
  })
}

test('concurrent fresh recovery and repeated new-port reads publish one original operation', async () => {
  const f = await fixture()
  const changed = { ...f.env, CLAUDE_TEAM_CONTROL_URL: 'http://127.0.0.1:43102' }
  expect((await Promise.all([fresh(f, changed), fresh(f, changed), fresh(f, changed)])).every(r => r.ok)).toBe(true)
  const authorityPath = openCodeOAuthSuccessorPath(f.global)
  const authority = await readFile(authorityPath, 'utf8')
  expect(JSON.parse(authority).operationId).toBe(f.receipt.operationId)
  expect((await fresh(f, changed)).ok).toBe(true)
  expect(await readFile(authorityPath, 'utf8')).toBe(authority)
  expect(await exists(f.receiptPath)).toBe(false)
})

test('late native bytes cannot replace the exact terminal capture', async () => {
  const f = await fixture()
  let checks = 0
  await expect(recoverOpenCodeOwnedOAuthSave({ globalAuthPath: f.global,
    sourceAuthPaths: f.receipt.sourceAuthPaths, env: f.env,
    assertOwner: async owner => { expect(await isOpenCodeOAuthPublicationScopeCurrent(owner, c0, f.env)).toBe(true) },
    isNativeProbeSettled: async owner => {
      expect(await new OpenCodeExecutionProbe().isOwnedOAuthNativeProbeSettled(owner, path.join(f.root, 'app-data'))).toBe(true)
      if (++checks === 2) await writeFile(f.profile.managedAuthPath, JSON.stringify({ xai: { ...c1, refresh: 'late' } }))
      return true
    },
  })).rejects.toThrow('native result changed during settlement')
  expect(await readFile(f.receiptPath, 'utf8')).toBe(f.receiptText)
  expect(await exists(openCodeOAuthSuccessorPath(f.global))).toBe(false)
})

test('late source replacement preserves terminal evidence but cannot publish C1', async () => {
  const f = await fixture()
  let checks = 0
  const replacement = { ...c0, refresh: 'new-login' }
  await expect(recoverOpenCodeOwnedOAuthSave({ globalAuthPath: f.global,
    sourceAuthPaths: f.receipt.sourceAuthPaths, env: f.env,
    assertOwner: async owner => {
      expect(await isOpenCodeOAuthPublicationScopeCurrent(owner, c0, f.env)).toBe(true)
      if (++checks === 2) await writeFile(f.global, JSON.stringify({ xai: replacement }))
    },
    isNativeProbeSettled: owner => new OpenCodeExecutionProbe().isOwnedOAuthNativeProbeSettled(owner, path.join(f.root, 'app-data')),
  })).rejects.toThrow('superseded')
  expect((await Bun.file(f.receiptPath).json()).successor).toEqual(c1)
  expect(await exists(openCodeOAuthSuccessorPath(f.global))).toBe(false)
  expect(await read(f.global)).toEqual(replacement)
})

for (const target of ['capture', 'sidecar']) for (const after of [false, true]) {
  test(`fresh restart retries atomic crash boundary: ${target}, after rename: ${after}`, async () => {
    const f = await fixture()
    const changed = { ...f.env, CLAUDE_TEAM_CONTROL_URL: 'http://127.0.0.1:43102' }
    const result = await fresh(f, changed, f.purpose, f.project, {
      path: target === 'capture' ? f.receiptPath : openCodeOAuthSuccessorPath(f.global), after,
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('crash boundary')
    const captured = await Bun.file(f.receiptPath).json()
    expect(captured.successor).toEqual(target === 'capture' && !after ? null : c1)
    expect(captured.owner).toEqual(f.receipt.owner)
    expect((await fresh(f, changed)).ok).toBe(true)
    expect((await saved(f, changed)).xai).toEqual(c1)
    expect((await fresh(f, changed)).ok).toBe(true)
    expect(await read(f.global)).toEqual(c0)
  })
}

test('foreign project cannot authorize a pending or published restart transition', async () => {
  const f = await fixture()
  const project = path.join(f.root, 'foreign-project'); await mkdir(project)
  const changed = { ...f.env, CLAUDE_TEAM_CONTROL_URL: 'http://127.0.0.1:43102' }
  const result = await fresh(f, changed, f.purpose, project)
  expect(result.ok).toBe(false)
  expect(result.error).toContain('another project')
  expect((await Bun.file(f.receiptPath).json()).successor).toEqual(c1)
  expect(await exists(f.archivePath)).toBe(false)
  expect((await fresh(f, changed)).ok).toBe(true)
  expect((await fresh(f, changed, f.purpose, project)).ok).toBe(false)
  expect((await saved(f, changed)).xai).toEqual(c1)
})

for (const field of ['hostKey', 'processStartedAtMs', 'profileRootKey', 'messageId']) {
  test(`incomplete native identity cannot capture a restart successor: ${field}`, async () => {
    const f = await fixture()
    const receipt = structuredClone(f.receipt)
    receipt.nativeProbe[field] = field === 'processStartedAtMs' ? 0 : 'foreign'
    await writeFile(f.receiptPath, JSON.stringify(receipt))
    expect((await fresh(f, { ...f.env, CLAUDE_TEAM_CONTROL_URL: 'http://127.0.0.1:43102' })).ok).toBe(false)
    expect(await Bun.file(f.receiptPath).json()).toEqual(receipt)
    expect(await exists(openCodeOAuthSuccessorPath(f.global))).toBe(false)
  })
}

for (const mutation of ['command', 'authority-root', 'provider-config']) {
  test(`published sidecar rejects foreign authority without rewriting provenance: ${mutation}`, async () => {
    const f = await fixture()
    expect((await fresh(f)).ok).toBe(true)
    const authorityPath = openCodeOAuthSuccessorPath(f.global)
    const authority = await readFile(authorityPath, 'utf8')
    const changed = { ...f.env, CLAUDE_TEAM_CONTROL_URL: 'http://127.0.0.1:43102' }
    if (mutation === 'command') changed.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND = '/foreign-command'
    if (mutation === 'authority-root') changed.AGENT_TEAMS_MCP_CLAUDE_DIR = path.join(f.root, 'foreign-root')
    if (mutation === 'provider-config') changed.OPENCODE_CONFIG_CONTENT = JSON.stringify({ provider: { xai: { options: { baseURL: 'http://foreign.invalid' } } } })
    expect((await fresh(f, changed)).ok).toBe(false)
    await expect(saved(f, changed)).rejects.toThrow('saved successor scope')
    expect(await readFile(authorityPath, 'utf8')).toBe(authority)
    expect((await saved(f)).xai).toEqual(c1)
  })
}
