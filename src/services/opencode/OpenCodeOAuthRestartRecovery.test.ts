// Offline restart regression fixtures: synthetic credentials and canonical native history.
// No provider process, credential discovery, or network transport.
import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
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

// Keep OS-owned handles until close, including when Bun cancels a timed-out test.
// Draining pipes through Node streams avoids awaiting Bun's Windows pipe readers.
function startOwnedChild(script: string, args: string[], env: NodeJS.ProcessEnv, phase: string, ipc = false) {
  const child = spawn(process.execPath, ['-e', script, ...args], {
    env, stdio: ipc ? ['pipe', 'pipe', 'pipe', 'ipc'] : ['pipe', 'pipe', 'pipe'], windowsHide: true,
  })
  const state = { phase, stdout: '', stderr: '', stdoutEnded: false,
    exited: false, code: null as number | null, signal: null as NodeJS.Signals | null,
    error: null as Error | null, cleaning: false,
    control: null as null | { ready: boolean; stopSent: boolean; stopAcknowledged: boolean; stopAckSent: boolean } }
  child.stdout!.on('data', chunk => { state.stdout += chunk.toString() })
  child.stdout!.once('end', () => { state.stdoutEnded = true })
  child.stderr!.on('data', chunk => { state.stderr += chunk.toString() })
  child.stdin!.on('error', error => { if (!state.cleaning) state.error = error })
  child.once('error', error => { state.error = error })
  child.once('exit', (code, signal) => {
    state.exited = true; state.code = code; state.signal = signal
  })
  const closed = new Promise<void>(resolve => {
    child.once('close', () => { ownedChildren.delete(entry); resolve() })
  })
  const entry = { child, state, closed }
  ownedChildren.add(entry)
  return entry
}
const ownedChildren = new Set<ReturnType<typeof startOwnedChild>>()

function writerControl(writer: ReturnType<typeof startOwnedChild>, token: string) {
  const control = { ready: false, stopSent: false, stopAcknowledged: false, stopAckSent: false }
  let stopAckSend: Promise<void> | null = null
  writer.state.control = control
  const ready = new Promise<void>((resolve, reject) => {
    const message = (value: unknown) => {
      if (!value || typeof value !== 'object' || !('token' in value) || value.token !== token
        || !('pid' in value) || value.pid !== writer.child.pid || !('type' in value)) {
        writer.state.error ??= new Error('Invalid synthetic writer acknowledgment')
        reject(writer.state.error)
      } else if (value.type === 'ready' && !control.ready) {
        control.ready = true; resolve()
      } else if (value.type === 'stopped' && control.ready && control.stopSent && !control.stopAcknowledged) {
        control.stopAcknowledged = true
        // Only receipt by this parent authorizes the writer's natural exit.
        // Its close can precede this send callback, so join both independently.
        stopAckSend = new Promise<void>(resolve => {
          try {
            writer.child.send({ type: 'stop-ack', token, pid: writer.child.pid }, error => {
              if (error) writer.state.error ??= error
              else control.stopAckSent = true
              resolve()
            })
          } catch (error) {
            writer.state.error ??= error instanceof Error ? error : new Error(String(error))
            resolve()
          }
        })
      } else {
        writer.state.error ??= new Error('Unexpected synthetic writer acknowledgment')
        reject(writer.state.error)
      }
    }
    writer.child.on('message', message)
    void writer.closed.then(() => {
      writer.child.off('message', message)
      if (!control.ready) reject(new Error('Synthetic writer closed before readiness'))
    })
  })
  const stop = async () => {
    await ready
    if (control.stopSent) throw new Error('Synthetic writer stop already requested')
    writer.state.phase = 'writer-ipc-stop'
    control.stopSent = true
    await new Promise<void>((resolve, reject) => {
      writer.child.send({ type: 'stop', token, pid: writer.child.pid }, error => error ? reject(error) : resolve())
    })
    writer.state.phase = 'writer-close-wait'
    await writer.closed
    if (writer.state.cleaning) await stopInterruptedContinuation()
    expect(control.stopAcknowledged).toBe(true)
    expect(stopAckSend).not.toBeNull()
    expect(writer.state.exited).toBe(true)
    if (stopAckSend) {
      // Physical close already removed this entry. Retain the pending parent
      // continuation so afterEach can mark it interrupted without signalling.
      ownedChildren.add(writer)
      try { await stopAckSend } finally { ownedChildren.delete(writer) }
      if (writer.state.cleaning) await stopInterruptedContinuation()
    }
    expect(control.stopAckSent).toBe(true)
    expect(writer.state.error).toBeNull()
    expect(writer.state.exited).toBe(true)
    expect(writer.state.code).toBe(0)
    expect(writer.state.signal).toBeNull()
  }
  return { ready, stop }
}

function syntheticWriterScript(token: string) {
  return `const token = ${JSON.stringify(token)};
    let phase = 'ready';
    process.on('message', value => {
      if (value?.token !== token || value.pid !== process.pid) process.exit(1);
      if (value.type === 'stop' && phase === 'ready') {
        phase = 'stopped';
        process.send({ type: 'stopped', token, pid: process.pid }, error => { if (error) process.exit(1) });
      } else if (value.type === 'stop-ack' && phase === 'stopped') {
        phase = 'done';
        process.exit(0);
      } else process.exit(1);
    });
    process.on('disconnect', () => process.exit(1));
    process.send({ type: 'ready', token, pid: process.pid }, error => { if (error) process.exit(1) });`
}

function startSyntheticWriter(env: NodeJS.ProcessEnv) {
  const token = randomBytes(16).toString('hex')
  // This process supplies only an actual OS lifetime. Its explicit control
  // channel must acknowledge initialization and shutdown; stdin EOF/data is
  // deliberately not part of the native OAuth retirement predicate.
  const writer = startOwnedChild(syntheticWriterScript(token), [], env, 'writer-ready-wait', true)
  return { writer, ...writerControl(writer, token) }
}

async function startUnacknowledgedWriter() {
  const token = randomBytes(16).toString('hex')
  const writer = startOwnedChild(syntheticWriterScript(token), [], process.env, 'TEST-held-stop-ack', true)
  const ready = await new Promise(resolve => writer.child.once('message', resolve))
  expect(ready).toEqual({ type: 'ready', token, pid: writer.child.pid })
  const stop = async () => {
    const stopped = new Promise(resolve => writer.child.once('message', resolve))
    writer.child.send({ type: 'stop', token, pid: writer.child.pid })
    expect(await stopped).toEqual({ type: 'stopped', token, pid: writer.child.pid })
  }
  return { writer, token, stop }
}

// Bun records timeout failure without cancelling the async test body. Once
// afterEach has reaped its resources, park that interrupted continuation on an
// inert promise so it cannot resume assertions or touch deleted sandbox roots.
function stopInterruptedContinuation(): Promise<never> {
  return new Promise(() => {})
}

async function reapOwnedChild(entry: ReturnType<typeof startOwnedChild>): Promise<void> {
  entry.state.cleaning = true
  const diagnostic = { phase: entry.state.phase, stdoutEnded: entry.state.stdoutEnded,
    exited: entry.state.exited, code: entry.state.code, signal: entry.state.signal,
    stdoutBytes: Buffer.byteLength(entry.state.stdout), stderrBytes: Buffer.byteLength(entry.state.stderr),
    ...(entry.state.control ? { control: entry.state.control } : {}) }
  // Only the tracked child handle is signalled, never a persisted registry PID.
  if (!entry.state.exited) entry.child.kill('SIGKILL')
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([entry.closed, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Owned fixture cleanup did not close: ${JSON.stringify(diagnostic)}`)), 2_500)
    })])
  } finally { clearTimeout(timer) }
  // A closed entry may have been retained for its pending parent ACK callback.
  ownedChildren.delete(entry)
  console.error(`Owned recovery fixture reaped after test interruption: ${JSON.stringify({ ...diagnostic,
    closeCode: entry.state.code, closeSignal: entry.state.signal })}`)
}

afterEach(async () => {
  // A timeout must remain a failure; reaping only prevents cascading EBUSY and
  // dangling-child failures in subsequent tests. Preserve roots if reaping fails.
  const interrupted = [...ownedChildren]
  await Promise.all(interrupted.map(reapOwnedChild))
  if (interrupted.length) {
    // Earlier setup IO may still settle after interruption. Keep its isolated
    // roots, rather than race removal against an async body Bun did not cancel.
    console.error(`Interrupted recovery fixture roots retained: ${JSON.stringify(roots.splice(0))}`)
    return
  }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const read = (authPath: string) => readOpenCodeAuthCredential({ authPath, providerId: 'xai' })
const exists = (file: string) => Bun.file(file).exists()

test('synthetic OAuth writer acknowledges readiness and stop before natural physical close', async () => {
  const { writer, ready, stop } = startSyntheticWriter(process.env)
  await ready
  expect(writer.state.exited).toBe(false)
  expect(await readProcessStartTimeMs(writer.child.pid!)).toBeGreaterThan(0)
  await stop()
  expect(writer.state.stdoutEnded).toBe(true)
  expect(ownedChildren.has(writer)).toBe(false)
})

test('synthetic OAuth writer stays physically alive until its parent acknowledges the stopped receipt', async () => {
  const { writer, token, stop } = await startUnacknowledgedWriter()
  const birth = await readProcessStartTimeMs(writer.child.pid!)
  expect(birth).toBeGreaterThan(0)
  await stop()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    // Explicitly withhold receipt authorization while observing physical close;
    // this observation window does not extend any fixture or cleanup deadline.
    expect(await Promise.race([writer.closed.then(() => true), new Promise<boolean>(resolve => {
      timer = setTimeout(() => resolve(false), 50)
    })])).toBe(false)
  } finally { clearTimeout(timer) }
  expect(writer.state.exited).toBe(false)
  expect(await readProcessStartTimeMs(writer.child.pid!)).toBe(birth)
  await new Promise<void>((resolve, reject) => writer.child.send({ type: 'stop-ack', token, pid: writer.child.pid },
    error => error ? reject(error) : resolve()))
  await writer.closed
  expect(writer.state.error).toBeNull()
  expect(writer.state.exited).toBe(true)
  expect(writer.state.code).toBe(0)
  expect(writer.state.signal).toBeNull()
  expect(writer.state.stdoutEnded).toBe(true)
  expect(ownedChildren.has(writer)).toBe(false)
})

for (const kind of ['wrong-token', 'wrong-pid', 'before-stop', 'duplicate-stop'] as const) {
  test(`synthetic OAuth writer rejects ${kind} receipt authorization`, async () => {
    const { writer, token, stop } = await startUnacknowledgedWriter()
    if (kind !== 'before-stop') await stop()
    writer.child.send({ type: kind === 'duplicate-stop' ? 'stop' : 'stop-ack',
      token: kind === 'wrong-token' ? 'TEST-unrelated' : token,
      pid: kind === 'wrong-pid' ? writer.child.pid! + 1 : writer.child.pid })
    await writer.closed
    expect(writer.state.code).toBe(1)
    expect(writer.state.signal).toBeNull()
    expect(ownedChildren.has(writer)).toBe(false)
  })
}

test('synthetic OAuth writer cannot qualify a zero exit without its stopped receipt', async () => {
  const token = randomBytes(16).toString('hex')
  const writer = startOwnedChild(`process.on('message', () => process.exit(0));
    process.send({ type: 'ready', token: ${JSON.stringify(token)}, pid: process.pid });`,
  [], process.env, 'TEST-no-stopped-receipt', true)
  const control = writerControl(writer, token)
  await expect(control.stop()).rejects.toThrow()
  expect(writer.state.exited).toBe(true)
  expect(writer.state.code).toBe(0)
  expect(writer.state.control?.stopAcknowledged).toBe(false)
  expect(writer.state.control?.stopAckSent).toBe(false)
})

test('synthetic OAuth writer cannot qualify duplicate stopped receipts before physical close', async () => {
  const token = randomBytes(16).toString('hex')
  const writer = startOwnedChild(`const token = ${JSON.stringify(token)};
    process.on('message', value => {
      if (value.type === 'stop') {
        process.send({ type: 'stopped', token, pid: process.pid });
        process.send({ type: 'stopped', token, pid: process.pid });
      } else if (value.type === 'finish') process.exit(0);
    });
    process.send({ type: 'ready', token, pid: process.pid });`,
  [], process.env, 'TEST-duplicate-stopped-receipt', true)
  const control = writerControl(writer, token)
  let receipts = 0
  const duplicated = new Promise<void>(resolve => writer.child.on('message', value => {
    if (value && typeof value === 'object' && 'type' in value && value.type === 'stopped' && ++receipts === 2) resolve()
  }))
  const stopping = control.stop()
  await duplicated
  expect(writer.state.error?.message).toBe('Unexpected synthetic writer acknowledgment')
  writer.child.send({ type: 'finish' })
  await expect(stopping).rejects.toThrow()
  expect(writer.state.code).toBe(0)
})

for (const outcome of ['joined', 'send-error', 'interrupted'] as const) {
  const label = outcome === 'interrupted' ? 'parks its interrupted' : outcome === 'send-error' ? 'rejects a failed' : 'joins its'
  test(`synthetic OAuth writer ${label} stop-ack send callback even after physical close`, async () => {
    const { writer, ready, stop } = startSyntheticWriter(process.env)
    await ready
    const send = writer.child.send.bind(writer.child)
    const kill = writer.child.kill
    let signals = 0
    let releaseAck: (() => void) | undefined
    let callbackObserved!: () => void
    const observed = new Promise<void>(resolve => { callbackObserved = resolve })
    writer.child.send = ((message: { type: string }, callback: (error: Error | null) => void) => {
      if (message.type !== 'stop-ack') return send(message, callback)
      return send(message, error => {
        releaseAck = () => callback(outcome === 'send-error' ? new Error('TEST-stop-ack-send-failed') : error)
        callbackObserved()
      })
    }) as typeof writer.child.send
    let completed = false
    const stopping = stop().then(() => { completed = true; return null }, error => { completed = true; return error })
    try {
      await Promise.all([writer.closed, observed])
      if (writer.state.cleaning) await stopInterruptedContinuation()
      expect(writer.state.code).toBe(0)
      expect(writer.state.exited).toBe(true)
      expect(writer.state.control?.stopAcknowledged).toBe(true)
      expect(writer.state.control?.stopAckSent).toBe(false)
      expect(ownedChildren.has(writer)).toBe(true)
      expect(completed).toBe(false)
      if (outcome === 'interrupted') {
        writer.child.kill = (() => { signals++; return false }) as typeof writer.child.kill
        await reapOwnedChild(writer)
        expect(writer.state.cleaning).toBe(true)
        expect(ownedChildren.has(writer)).toBe(false)
        expect(signals).toBe(0)
      }
    } finally { releaseAck?.(); writer.child.send = send; writer.child.kill = kill }
    if (outcome === 'interrupted') {
      // Release all queued ACK microtasks without adding another timing budget.
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(completed).toBe(false)
      expect(ownedChildren.has(writer)).toBe(false)
      return
    }
    const error = await stopping
    expect(ownedChildren.has(writer)).toBe(false)
    if (outcome === 'send-error') {
      expect(error).not.toBeNull()
      expect(writer.state.error?.message).toBe('TEST-stop-ack-send-failed')
      expect(writer.state.control?.stopAckSent).toBe(false)
    } else {
      expect(error).toBeNull()
      expect(writer.state.control?.stopAckSent).toBe(true)
    }
  })
}

test('synthetic OAuth writer rejects an unrelated stop token', async () => {
  const { writer, ready } = startSyntheticWriter(process.env)
  await ready
  writer.child.send({ type: 'stop', token: 'TEST-unrelated', pid: writer.child.pid })
  await writer.closed
  expect(writer.state.code).toBe(1)
  expect(writer.state.control?.stopAcknowledged).toBe(false)
})

test('synthetic OAuth writer cannot qualify a zero exit before readiness', async () => {
  const writer = startOwnedChild('process.exit(0)', [], process.env, 'TEST-before-ready', true)
  await expect(writerControl(writer, 'TEST-never-ready').ready).rejects.toThrow('closed before readiness')
  expect(writer.state.code).toBe(0)
  expect(writer.state.control?.ready).toBe(false)
})

async function fixture(options: { session?: boolean, purpose?: 'launch_runtime' | 'execution_probe', remote?: boolean,
  terminal?: string, successor?: typeof c0, controlUrl?: string, diagnostic?: 'claude-dir' | 'command' } = {}) {
  const started = Date.now()
  const mark = (phase: string) => {
    if (process.platform === 'win32' && options.diagnostic)
      console.error(`Owned recovery fixture ${options.diagnostic}: ${phase} elapsedMs=${Date.now() - started}`)
  }
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
    // Windows child startup fills missing home aliases from the real OS account.
    ...(process.platform === 'win32' ? {
      HOMEDRIVE: path.parse(root).root.replace(/[\\/]$/, ''),
      HOMEPATH: path.join(root, 'home').slice(path.parse(root).root.length - 1),
    } : {}),
    XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'),
    XDG_CACHE_HOME: path.join(root, 'cache'), XDG_STATE_HOME: path.join(root, 'state'),
    TMPDIR: path.join(root, 'tmp'), TMP: path.join(root, 'tmp'), TEMP: path.join(root, 'tmp'),
    CLAUDE_MULTIMODEL_DATA_HOME: path.join(root, 'app-data'), CLAUDE_MULTIMODEL_CACHE_HOME: path.join(root, 'app-cache'),
    CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND: process.execPath,
    CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ARGS_JSON: JSON.stringify([path.join(root, 'never-executed-mcp.js')]),
    CLAUDE_TEAM_CONTROL_URL: options.controlUrl ?? 'http://127.0.0.1:43101', AGENT_TEAMS_MCP_CLAUDE_DIR: path.join(root, 'claude'),
    ...(options.remote ? { CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL: 'http://127.0.0.1:43101/mcp' } : {}),
  }
  const purpose = options.purpose ?? 'launch_runtime'
  const global = path.join(root, 'app-data', 'opencode', 'auth.json')
  const receiptPath = `${global}.agent-teams-xai-oauth-save.json`
  const archivePath = `${receiptPath}.revoked-${createHash('sha256').update(c0.refresh).digest('hex')}`
  await upsertOpenCodeAuthCredential({ authPath: global, providerId: 'xai', credential: c0 })
  mark('prepare-profile begin')
  const profile = await manager.prepareProfile(project, { profileScope: await resolveOpenCodeProfileScope({
    projectPath: project, selectedModel: 'xai/grok-4.3', purpose, env,
  }) })
  mark('prepare-profile end')
  // Real OS birth and ESRCH; this child is only a synthetic writer lifetime.
  const { writer, ready, stop } = startSyntheticWriter(env)
  const { child } = writer
  let native: any
  try {
    await ready
    const pid = child.pid
    if (pid === undefined) throw new Error('Synthetic writer failed to spawn')
    writer.state.phase = 'measure-writer'
    mark('measure-writer begin')
    const birth = await readProcessStartTimeMs(pid)
    expect(birth).toBeGreaterThan(0)
    mark('measure-writer end')
    writer.state.phase = 'write-native-history'
    mark('write-native-history begin')
    native = { projectPath: project, scopeToken: profile.scopeToken!, profileRootKey: profile.profileRootKey,
      hostKey: `audit-host::${profile.scopeToken}`, baseUrl: 'http://127.0.0.1:43210',
      pid, processStartedAtMs: birth!, sessionId: 'audit-session', messageId: 'audit-message', selectedModel: 'xai/grok-4.3' }
    let sessionOwner: any
    if (options.session) {
      const now = new Date().toISOString()
      const record = { teamId: 'AUDIT', laneId: 'primary', memberName: 'owner', runId: 'audit-run',
        providerId: 'opencode' as const, selectedModel: native.selectedModel, projectPath: project,
        profileRootKey: profile.profileRootKey, hostKey: native.hostKey, profileScope: profile.profileScope,
        runtimePid: pid, resolvedBehaviorFingerprint: 'audit-behavior', opencodeSessionId: native.sessionId,
        lastCanonicalCursor: null, lastKnownRawStatus: null, lastKnownDurableState: null,
        sourceAuthFingerprint: profile.sourceAuthFingerprint, managedAuthFingerprint: profile.managedAuthFingerprint,
        projectBehaviorFingerprint: profile.projectBehaviorFingerprint, managedConfigFingerprint: profile.managedConfigFingerprint,
        expectedBehaviorFingerprint: 'audit-proof', staleReason: null, createdAt: now, updatedAt: now }
      sessionOwner = { record, baseUrl: native.baseUrl, pid, processStartedAtMs: birth!,
        messageId: native.messageId, noReply: false }
      await new OpenCodeSessionStore(path.join(path.dirname(global), 'session-store.json')).upsert(record)
      const leaseKey = 'AUDIT::primary::owner'
      await writeFile(path.join(path.dirname(global), 'host-registry.json'), JSON.stringify({
        schemaVersion: 1, processIdentityFormat: 'platform-native-v2', hosts: { [record.hostKey]: {
          ...record, baseUrl: native.baseUrl, port: 43210, pid, processStartedAtMs: birth,
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
    mark('write-native-history end')
  } finally {
    mark('writer-close-wait begin')
    await stop()
    mark('writer-close-wait end')
  }
  const receiptText = await readFile(receiptPath, 'utf8')
  const receipt = JSON.parse(receiptText)
  expect(receipt.successor).toBeNull()
  return { root, project, purpose, env, profile, global, receiptPath, archivePath, native, receipt, receiptText }
}
type Fixture = Awaited<ReturnType<typeof fixture>>

// A new Bun process has no parent's effective-config snapshot map. Default
// production recovery must use the exited writer's canonical SQLite history.
async function fresh(f: Fixture, env = f.env, purpose = f.purpose, project = f.project, fault?: { path: string, after: boolean }, role: 'fault' | 'recovery' | 'idempotent' = fault ? 'fault' : 'recovery') {
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
    if (process.platform === 'win32') {
      const { deepStrictEqual } = await import('node:assert/strict');
      deepStrictEqual([process.env.HOMEDRIVE, process.env.HOMEPATH], ${JSON.stringify([env.HOMEDRIVE, env.HOMEPATH])});
    }
    const { resolveOpenCodeProfileScope } = await import(${JSON.stringify(modulePath)});
    try { const scope = await resolveOpenCodeProfileScope({ projectPath: process.argv[1], selectedModel: 'xai/grok-4.3', purpose: process.argv[2] });
      process.stdout.write(JSON.stringify({ ok: true, scope }));
    } catch (e) { process.stdout.write(JSON.stringify({ ok: false, error: e.message })); }`
  const entry = startOwnedChild(script, [project, purpose], env, `fresh ${role} natural exit`)
  entry.child.stdin!.end()
  await entry.closed
  if (entry.state.cleaning) await stopInterruptedContinuation()
  // Fresh recovery must exit naturally, including closing its imported handles.
  expect(entry.state.error).toBeNull()
  expect(entry.state.stderr).toBe(''); expect(entry.state.code).toBe(0)
  return JSON.parse(entry.state.stdout)
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
    const diagnostic = drift === 'claude-dir' || drift === 'command' ? drift : undefined
    const f = await fixture({ remote: drift === 'remote-port', diagnostic })
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
  }, process.platform === 'win32' && (drift === 'claude-dir' || drift === 'command') ? 60_000 : undefined)
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
    expect((await fresh(f, changed, f.purpose, f.project, undefined, 'idempotent')).ok).toBe(true)
    expect(await read(f.global)).toEqual(c0)
    // Three fresh imports plus 3–5 bounded Windows birth queries share this case budget.
  }, process.platform === 'win32' ? 60_000 : undefined)
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

test('catalog from a foreign project does not harvest a pending OAuth restart', async () => {
  const f = await fixture()
  const project = path.join(f.root, 'catalog-project')
  await mkdir(project)
  const changed = { ...f.env, CLAUDE_TEAM_CONTROL_URL: 'http://127.0.0.1:43102' }
  const catalog = await fresh(f, changed, 'catalog', project)
  expect(catalog.ok).toBe(true)
  expect(await readFile(f.receiptPath, 'utf8')).toBe(f.receiptText)
  expect(await exists(openCodeOAuthSuccessorPath(f.global))).toBe(false)
  expect((await fresh(f, changed)).ok).toBe(true)
  expect((await saved(f, changed)).xai).toEqual(c1)
})

test('catalog from the owner project completes a pending OAuth restart', async () => {
  const f = await fixture()
  const catalog = await fresh(f, f.env, 'catalog', f.project)
  expect(catalog.ok).toBe(true)
  expect((await saved(f)).xai).toEqual(c1)
  expect(await exists(f.receiptPath)).toBe(false)
})

test('execution probe from a foreign project does not harvest a pending OAuth restart', async () => {
  const f = await fixture()
  const project = path.join(f.root, 'probe-project')
  await mkdir(project)
  const changed = { ...f.env, CLAUDE_TEAM_CONTROL_URL: 'http://127.0.0.1:43102' }
  const probe = await fresh(f, changed, 'execution_probe', project)
  expect(probe.ok).toBe(true)
  expect(await readFile(f.receiptPath, 'utf8')).toBe(f.receiptText)
  expect(await exists(openCodeOAuthSuccessorPath(f.global))).toBe(false)
  expect((await fresh(f, changed)).ok).toBe(true)
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

// Permanent independent-review regressions; desired behavior replaces bug characterization.
for (const session of [false, true]) for (const terminal of [undefined, 'incomplete']) for (const drift of ['command', 'authority-root', 'source-paths']) {
  test(`F1 foreign caller retains original receipt session=${session}: ${terminal ?? 'complete'}/${drift}`, async () => {
    const f = await fixture({ terminal, session })
    const foreign = path.join(f.root, 'foreign'); await mkdir(foreign)
    const env = { ...f.env, CLAUDE_TEAM_CONTROL_URL: 'http://127.0.0.1:43102' }
    if (drift === 'command') env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND = '/foreign-command'
    if (drift === 'authority-root') env.AGENT_TEAMS_MCP_CLAUDE_DIR = path.join(f.root, 'foreign-app')
    if (drift === 'source-paths') env.XDG_DATA_HOME = path.join(f.root, 'foreign-source')
    const result = await fresh(f, env, 'execution_probe', foreign)
    expect(result.ok).toBe(true)
    expect(await exists(f.receiptPath)).toBe(true)
    expect(await exists(f.archivePath)).toBe(false)
    const retained = await Bun.file(f.receiptPath).json()
    expect(retained.owner).toEqual(f.receipt.owner)
    expect(retained.successor).toEqual(f.receipt.successor)
    expect(await read(f.global)).toEqual(c0)
    let calls = 0
    await expect(manager.withOwnedOAuthRefresh({ profile: f.profile, assertHostOwnership: async () => {},
      operation: async () => { calls++ } })).rejects.toThrow()
    expect(calls).toBe(0)
    if (terminal) {
      expect((await fresh(f)).ok).toBe(false)
      expect(await exists(f.receiptPath)).toBe(true)
      const db = new Database(path.join(path.dirname(f.profile.managedAuthPath), 'opencode.db'))
      try {
        const row = db.query('select data from message where id = ?').get('audit-assistant') as { data: string }
        const assistant = JSON.parse(row.data)
        assistant.time = { completed: 1 }
        db.query('update message set data = ? where id = ?').run(JSON.stringify(assistant), 'audit-assistant')
      } finally { db.close() }
    }
    expect((await fresh(f)).ok).toBe(true)
    expect((await saved(f)).xai).toEqual(c1)
    expect(await exists(f.receiptPath)).toBe(false)
    expect(await exists(f.archivePath)).toBe(false)
    expect(await read(f.global)).toEqual(c0)
  })
}

for (const state of ['pending', 'published']) for (const [label, url] of [
  ['nonloopback', 'http://192.0.2.1:43102'], ['other-loopback', 'http://127.0.0.2:43102'],
  ['ipv6-host-change', 'http://[::1]:43102'], ['username', 'http://alice@127.0.0.1:43102'],
  ['password', 'http://alice:secret@127.0.0.1:43102'], ['https', 'https://127.0.0.1:43102'],
  ['port-zero', 'http://127.0.0.1:0'], ['invalid-port', 'http://127.0.0.1:65536'], ['malformed', 'not a URL'],
  ['fragment', 'http://127.0.0.1:43102/#fragment'], ['path', 'http://127.0.0.1:43102/foreign'],
  ['query', 'http://127.0.0.1:43102/?secret=other'],
]) {
  test(`endpoint admission ${state}/${label}`, async () => {
    const f = await fixture()
    if (state === 'published') expect((await fresh(f)).ok).toBe(true)
    const changed = { ...f.env, CLAUDE_TEAM_CONTROL_URL: url }
    // Ineligible endpoints cannot acquire port-drift authority.
    expect(await current(f, changed)).toBe(false)
    if (state === 'published') {
      const file = openCodeOAuthSuccessorPath(f.global), before = await readFile(file, 'utf8')
      await expect(saved(f, changed)).rejects.toThrow()
      expect(await readFile(file, 'utf8')).toBe(before)
    } else {
      await fresh(f, changed)
      expect(await exists(openCodeOAuthSuccessorPath(f.global))).toBe(false)
      expect((await Bun.file(f.archivePath).json()).successor).toEqual(c1)
    }
  })
}

test('candidate normalization rejects an ineligible default-port URL with fragment', async () => {
  const f = await fixture()
  const changed = { ...f.env, CLAUDE_TEAM_CONTROL_URL: 'http://127.0.0.1:80/#foreign-fragment' }
  expect(await current(f, changed)).toBe(false)
  const rawScope = await resolveOpenCodeProfileScope({ projectPath: f.project, purpose: f.purpose,
    selectedModel: 'xai/grok-4.3', env: changed, cacheSnapshot: false })
  expect(rawScope.scopeToken).not.toBe(f.receipt.owner.scopeToken)
  expect((await fresh(f, changed)).ok).toBe(true)
  expect(await exists(openCodeOAuthSuccessorPath(f.global))).toBe(false)
})

test('F2 safety source replacement during nonterminal session verification retains active fence', async () => {
  const f = await fixture({ session: true, terminal: 'incomplete' })
  const { OpenCodeSessionBridge } = await import('./OpenCodeSessionBridge')
  const { OpenCodeHostManager } = await import('./OpenCodeHostManager')
  const { OpenCodeSessionStore } = await import('./OpenCodeSessionStore')
  const dataRoot = path.join(f.root, 'app-data')
  const bridge = new OpenCodeSessionBridge({ oauthRecoveryDataRoot: dataRoot,
    hostManager: new OpenCodeHostManager({ persistentRegistryPath: path.join(dataRoot, 'opencode', 'host-registry.json') }),
    sessionStore: new OpenCodeSessionStore(path.join(dataRoot, 'opencode', 'session-store.json')) })
  expect(await bridge.isOwnedOAuthNativeSessionSettled(f.receipt.nativeSession)).toBe(false)
  const replacement = { ...c0, refresh: 'independent-new-login', accountId: 'new-account' }
  let calls = 0
  // This is the production pre-release entry, not a fabricated assertOwner bypass.
  await expect(manager.finishOwnedOAuthBeforeSessionRelease(f.receipt.nativeSession.record, async owner => {
    expect(await bridge.isOwnedOAuthNativeSessionSettled(owner)).toBe(false)
    await writeFile(f.global, JSON.stringify({ xai: replacement }))
    calls++
    return false
  })).rejects.toThrow()
  expect(calls).toBe(1)
  expect(await exists(f.receiptPath)).toBe(true)
  expect(await exists(f.archivePath)).toBe(false)
  expect((await Bun.file(f.receiptPath).json()).publicationRevoked).toBe(true)
  expect(await read(f.global)).toEqual(replacement)
})

for (const state of ['pending', 'published']) for (const mutation of ['version', 'version-string', 'scope-link', 'fingerprint', 'primitive', 'empty-object']) {
  test(`invalid binding denies selection ${state}/${mutation}`, async () => {
    const f = await fixture()
    if (state === 'published') expect((await fresh(f)).ok).toBe(true)
    const file = state === 'pending' ? f.receiptPath : openCodeOAuthSuccessorPath(f.global)
    const value = await Bun.file(file).json()
    if (mutation === 'version') value.owner.credentialBinding.version = 2
    if (mutation === 'version-string') value.owner.credentialBinding.version = '1'
    if (mutation === 'scope-link') value.owner.credentialBinding.scopeToken = 'b'.repeat(64)
    if (mutation === 'fingerprint') value.owner.credentialBinding.fingerprint = 'not-a-fingerprint'
    if (mutation === 'primitive') value.owner.credentialBinding = 'forged'
    if (mutation === 'empty-object') value.owner.credentialBinding = {}
    await writeFile(file, JSON.stringify(value))
    const changed = { ...f.env, CLAUDE_TEAM_CONTROL_URL: 'http://127.0.0.1:43102' }
    expect((await fresh(f, changed)).ok).toBe(false)
    if (state === 'pending') {
      expect((await Bun.file(file).json()).successor).toEqual(c1)
      expect(await exists(openCodeOAuthSuccessorPath(f.global))).toBe(false)
      expect(await exists(f.archivePath)).toBe(false)
    } else {
      await expect(saved(f, changed)).rejects.toThrow('binding')
      expect(await Bun.file(file).json()).toEqual(value)
    }
  })
}

for (const state of ['pending', 'published']) for (const mutation of ['managed-data', 'managed-cache', 'home', 'config', 'provider-secret', 'account', 'source-value']) {
  test(`independent authority isolation ${state}/${mutation}`, async () => {
    const f = await fixture()
    if (state === 'published') expect((await fresh(f)).ok).toBe(true)
    const changed = { ...f.env, CLAUDE_TEAM_CONTROL_URL: 'http://127.0.0.1:43102' }
    const replacement = { ...c0, refresh: 'replacement', ...(mutation === 'account' ? { accountId: 'different' } : {}) }
    if (mutation === 'managed-data') changed.CLAUDE_MULTIMODEL_DATA_HOME = path.join(f.root, 'new-app-data')
    if (mutation === 'managed-cache') changed.CLAUDE_MULTIMODEL_CACHE_HOME = path.join(f.root, 'new-app-cache')
    if (mutation === 'home') changed.HOME = changed.USERPROFILE = path.join(f.root, 'new-home')
    if (mutation === 'config') changed.OPENCODE_CONFIG_CONTENT = JSON.stringify({ provider: { xai: { options: { baseURL: 'http://different.invalid/v1' } } } })
    if (mutation === 'provider-secret') changed.XAI_API_KEY = 'independent-different-static-key'
    if (mutation === 'account' || mutation === 'source-value') await writeFile(f.global, JSON.stringify({ xai: replacement }))
    if (mutation !== 'account' && mutation !== 'source-value') expect(await current(f, changed)).toBe(false)
    const result = await fresh(f, changed)
    if (state === 'pending') expect(await exists(openCodeOAuthSuccessorPath(f.global))).toBe(false)
    else {
      if (mutation === 'account' || mutation === 'source-value') expect((await saved(f, changed)).xai).toEqual(replacement)
      else await expect(saved(f, changed)).rejects.toThrow()
    }
    expect(await read(f.global)).toEqual(mutation === 'account' || mutation === 'source-value' ? replacement : c0)
  })
}

for (const mutation of ['lease-run', 'lease-session', 'birth', 'endpoint', 'session-record']) {
  test(`independent new-port persistent session ownership ${mutation}`, async () => {
    const f = await fixture({ session: true })
    const registryPath = path.join(f.root, 'app-data/opencode/host-registry.json')
    const registry = await Bun.file(registryPath).json()
    const host: any = Object.values(registry.hosts)[0]
    const lease: any = Object.values(host.leases)[0]
    if (mutation === 'lease-run') lease.runId = 'foreign-run'
    if (mutation === 'lease-session') lease.sessionId = 'foreign-session'
    if (mutation === 'birth') host.processStartedAtMs += 1234
    if (mutation === 'endpoint') host.baseUrl = 'http://127.0.0.1:43211'
    if (mutation === 'session-record') {
      // The public upsert rejects a foreign run before it reaches recovery.
      // Mutate durable bytes to exercise recovery's independent ownership check.
      const storePath = path.join(f.root, 'app-data/opencode/session-store.json')
      const store = await Bun.file(storePath).json()
      for (const record of Object.values(store.records) as any[]) record.runId = 'foreign-run'
      await writeFile(storePath, JSON.stringify(store))
    }
    await writeFile(registryPath, JSON.stringify(registry))
    const result = await fresh(f, { ...f.env, CLAUDE_TEAM_CONTROL_URL: 'http://127.0.0.1:43102' })
    if (mutation === 'endpoint') {
      // An exited writer is verified via exact birth/lease and canonical SQLite
      // history; its obsolete registry URL is not contacted or used as proof.
      expect(result.ok).toBe(true)
      expect((await saved(f)).xai).toEqual(c1)
      return
    }
    expect(result.ok).toBe(false)
    expect(await readFile(f.receiptPath, 'utf8')).toBe(f.receiptText)
    expect(await exists(openCodeOAuthSuccessorPath(f.global))).toBe(false)
  })
}

for (const session of [false, true]) test(`independent multiport sidecar chain C0 through C3 session=${session}`, async () => {
  const f = await fixture({ session })
  let predecessor = c1
  let previousScope = f.profile.scopeToken
  for (let stage = 1; stage <= 3; stage++) {
    const env = { ...f.env, CLAUDE_TEAM_CONTROL_URL: `http://127.0.0.1:${44000 + stage}` }
    expect((await fresh(f, env)).ok).toBe(true)
    expect((await saved(f, env)).xai).toEqual(predecessor)
    const scope = await resolveOpenCodeProfileScope({ projectPath: f.project, purpose: f.purpose, selectedModel: 'xai/grok-4.3', env })
    expect(scope.scopeToken).not.toBe(previousScope)
    const next = await manager.prepareProfile(f.project, { profileScope: scope })
    expect(await read(next.managedAuthPath)).toEqual(predecessor)
    const file = openCodeOAuthSuccessorPath(f.global)
    const prior = await readFile(file, 'utf8')
    expect((await fresh(f, env)).ok).toBe(true)
    expect(await readFile(file, 'utf8')).toBe(prior)
    if (stage < 3) {
      const successor = { ...c0, access: `independent-C${stage+1}`, refresh: `independent-single-use-C${stage+1}`, expires: 500-stage }
      await manager.withOwnedOAuthRefresh({ profile: next, assertHostOwnership: async () => {},
        operation: async () => { await writeFile(next.managedAuthPath, JSON.stringify({ xai: successor })) } })
      const authority = await Bun.file(file).json()
      expect(authority.predecessor).toEqual(predecessor)
      expect(authority.successor).toEqual(successor)
      expect(authority.before).toEqual(f.receipt.before)
      expect(authority.owner.scopeToken).toBe(scope.scopeToken)
      expect(authority.owner.credentialBinding.scopeToken).toBe(scope.scopeToken)
      predecessor = successor
    }
    previousScope = scope.scopeToken
    expect(await read(f.global)).toEqual(c0)
  }
})

for (const controlUrl of ['not a URL', 'http://127.0.0.1:0', 'http://127.0.0.1:80/#fragment', 'http://127.0.0.1:80/#']) {
  test(`ineligible original endpoint retains exact-scope compatibility: ${controlUrl}`, async () => {
    const f = await fixture({ controlUrl })
    expect(await current(f)).toBe(true)
    expect(await current(f, { ...f.env, CLAUDE_TEAM_CONTROL_URL: 'http://127.0.0.1:43102' })).toBe(false)
    expect((await fresh(f)).ok).toBe(true)
    expect((await saved(f)).xai).toEqual(c1)
  })
}

for (const session of [false, true]) for (const nativeState of ['throwing', 'unsubmitted']) {
  test(`foreign source paths retain ${nativeState} native receipt session=${session}`, async () => {
    const f = await fixture({ session })
    const foreign = path.join(f.root, 'foreign'); await mkdir(foreign)
    const dbPath = path.join(path.dirname(f.profile.managedAuthPath), 'opencode.db')
    const original = await readFile(dbPath)
    if (nativeState === 'throwing') await writeFile(dbPath, 'invalid SQLite history')
    else {
      await writeFile(f.profile.managedAuthPath, JSON.stringify({ xai: c0 }))
      const db = new Database(dbPath)
      try { db.exec('delete from message') } finally { db.close() }
    }
    const changed = { ...f.env, XDG_DATA_HOME: path.join(f.root, 'foreign-source') }
    expect((await fresh(f, changed, f.purpose, foreign)).ok).toBe(false)
    expect(await readFile(f.receiptPath, 'utf8')).toBe(f.receiptText)
    expect(await exists(f.archivePath)).toBe(false)
    await writeFile(dbPath, original)
    await writeFile(f.profile.managedAuthPath, JSON.stringify({ xai: c1 }))
    expect((await fresh(f)).ok).toBe(true)
    expect((await saved(f)).xai).toEqual(c1)
    expect(await exists(f.archivePath)).toBe(false)
  })
}

for (const session of [false, true]) test(`foreign exact configuration retains unsubmitted receipt session=${session}`, async () => {
  const f = await fixture({ session })
  const foreign = path.join(f.root, 'foreign'); await mkdir(foreign)
  await writeFile(f.profile.managedAuthPath, JSON.stringify({ xai: c0 }))
  const dbPath = path.join(path.dirname(f.profile.managedAuthPath), 'opencode.db')
  const original = await readFile(dbPath)
  const db = new Database(dbPath)
  try { db.exec('delete from message') } finally { db.close() }
  expect((await fresh(f, f.env, f.purpose, foreign)).ok).toBe(false)
  expect(await readFile(f.receiptPath, 'utf8')).toBe(f.receiptText)
  expect(await exists(f.archivePath)).toBe(false)
  await writeFile(dbPath, original)
  await writeFile(f.profile.managedAuthPath, JSON.stringify({ xai: c1 }))
  expect((await fresh(f)).ok).toBe(true)
  expect((await saved(f)).xai).toEqual(c1)
})

test('foreign exact configuration can still publish a proven original completion', async () => {
  const f = await fixture()
  const foreign = path.join(f.root, 'foreign'); await mkdir(foreign)
  expect((await fresh(f, f.env, f.purpose, foreign)).ok).toBe(true)
  expect((await saved(f)).xai).toEqual(c1)
  const authority = await Bun.file(openCodeOAuthSuccessorPath(f.global)).json()
  expect(authority.owner).toEqual(f.receipt.owner)
  expect(authority.completion.managedAuthPath).toBe(f.profile.managedAuthPath)
})
