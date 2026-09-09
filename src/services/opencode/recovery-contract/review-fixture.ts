// Fixture setup adapted from snapshot5386695b regression file; assertions in independent-review.test.ts are independently authored.
// Offline restart regression fixtures: synthetic credentials and canonical native history.
// No provider process, credential discovery, or network transport.
import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {
  OpenCodeProfileManager, resolveOpenCodeProfileScope, isOpenCodeOAuthPublicationScopeCurrent,
} from '../OpenCodeProfileManager.js'
import {
  readOpenCodeAuthCredential, readOpenCodeSavedAuthStore, recoverOpenCodeOwnedOAuthSave,
  upsertOpenCodeAuthCredential, openCodeOAuthSuccessorPath,
} from '../OpenCodeAuthStore.js'
import { OpenCodeSessionStore } from '../OpenCodeSessionStore.js'
import { OpenCodeExecutionProbe } from '../OpenCodeExecutionProbe.js'
import { readProcessStartTimeMs } from '../../../utils/processKill.js'

const c0 = { type: 'oauth', access: 'AUDIT-C0', refresh: 'AUDIT-single-use-C0', expires: 1000, accountId: 'AUDIT-account' }
const c1 = { ...c0, access: 'AUDIT-C1', refresh: 'AUDIT-single-use-C1', expires: 500 }
const roots: string[] = []
const manager = new OpenCodeProfileManager()
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const read = (authPath: string) => readOpenCodeAuthCredential({ authPath, providerId: 'xai' })
const exists = (file: string) => Bun.file(file).exists()

async function fixture(options: { session?: boolean, purpose?: 'launch_runtime' | 'execution_probe', remote?: boolean,
  terminal?: string, successor?: typeof c0 } = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'oauth-restart-audit-')))
  roots.push(root)
  const project = path.join(root, 'project')
  await mkdir(project)
  await mkdir(path.join(root, 'tmp'))
  const env: NodeJS.ProcessEnv = {
    PATH: [path.dirname(process.execPath), process.env.PATH ?? process.env.Path ?? ''].join(path.delimiter),
    SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
    COMSPEC: process.env.COMSPEC, PATHEXT: process.env.PATHEXT, NODE_ENV: 'test',
    HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'),
    XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'),
    XDG_CACHE_HOME: path.join(root, 'cache'), XDG_STATE_HOME: path.join(root, 'state'),
    TMPDIR: path.join(root, 'tmp'), TMP: path.join(root, 'tmp'), TEMP: path.join(root, 'tmp'),
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
  const modulePath = path.resolve(import.meta.dir, '../OpenCodeProfileManager.ts')
  const inject = fault ? `const { mock } = await import('bun:test');
    const atomicPath = ${JSON.stringify(path.resolve(import.meta.dir, '../../../utils/atomicWrite.ts'))};
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


export { fixture, fresh, saved, current, read, exists, c0, c1, manager }
