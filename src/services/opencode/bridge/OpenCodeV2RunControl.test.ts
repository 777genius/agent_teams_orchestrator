import { describe, expect, test, spyOn } from 'bun:test'
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm, readFile, rename, chmod, writeFile, mkdir, symlink, lstat, realpath } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { discoverOpenCodeV2Run, awaitOpenCodeV2RunMemberReadiness, parseRunControlRequest, readRunProcessIdentity, requestOpenCodeV2Run, reserveRunControlDirectory, serveOpenCodeV2RunControl, writeRunControlFile } from './OpenCodeV2RunControl.js'
import { boundOpenCodeRead } from '../transport/OpenCodeBoundedFetch.js'

const peer = fileURLToPath(new URL('./fixtures/OpenCodeV2RunControlPeer.ts', import.meta.url))
const binding = { teamId: 'TEST-team', runId: 'TEST-run', controllerInstanceId: 'controller', ownerId: 'owner' }
const execute = promisify(execFile)
function ready(child: ChildProcess): Promise<void> {
  return boundOpenCodeRead(new Promise<void>((resolve, reject) => {
    let output = '', stderr = ''
    child.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-4096) })
    child.stdout?.on('data', chunk => { output += String(chunk); if (output.includes('ready\n')) resolve() })
    child.once('error', reject); child.once('exit', () => reject(new Error('TEST_peer_exited_before_ready: ' + stderr)))
  }), 5000)
}
async function stopTestChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
  child.kill('SIGTERM'); await boundOpenCodeRead(exited, 3000)
}

/** Serialized after Bun transpilation; the complete kernel peer remains typechecked here. */
function socketEndpointPeer(fs: typeof import('node:fs'), net: typeof import('node:net')): void {
  const directory = process.argv[1]
  if (!directory) throw new Error('TEST_peer_directory_required')
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
  const endpoint = `/proc/self/fd/${fd}/control.sock.original`
  const inode = fs.lstatSync(endpoint)
  const facts: { canonical: string; socket: boolean; device: number; inode: number; pathBytes: number;
    connected: boolean; errorCode?: string } = {
    canonical: fs.realpathSync(`/proc/self/fd/${fd}`), socket: inode.isSocket(), device: inode.dev,
    inode: inode.ino, pathBytes: Buffer.byteLength(endpoint), connected: false,
  }
  const socket = net.createConnection(endpoint)
  socket.once('error', (error: NodeJS.ErrnoException) => { facts.errorCode = error.code })
  socket.once('connect', () => { facts.connected = true; socket.destroy() })
  socket.once('close', () => { fs.closeSync(fd); console.log(JSON.stringify(facts)) })
}

describe('private run control with separate synthetic CLI processes', () => {
  test.skipIf(process.platform !== 'darwin')('Darwin retained long directory authenticates status and retires its exact socket without cwd leakage', async () => {
    const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), 'TEST-darwin-control-')))
    const root = path.join(parent, 'durable-owner-directory-'.repeat(7))
    await mkdir(root, { mode: 0o700 })
    const directory = await reserveRunControlDirectory(root, binding, 'a'.repeat(64)), cwd = process.cwd(), deadline = Date.now() + 20_000
    const control = await serveOpenCodeV2RunControl(directory, binding, deadline, 'a'.repeat(64),
      async () => ({ kind: 'status', state: 'starting', members: [], deadline }))
    try {
      expect(Buffer.byteLength(control.record.socketPath)).toBeGreaterThan(103)
      expect(process.cwd()).toBe(cwd)
      expect(control.record.process.startTicks).toMatch(/^\d+:[1-9]\d*$/)
      expect(await requestOpenCodeV2Run(control.record, { operation: 'status' }, 5000)).toEqual({ kind: 'status', state: 'starting', members: [], deadline })
      const module = fileURLToPath(new URL('./OpenCodeV2RunControl.ts', import.meta.url))
      const freshCLI = await execute(process.execPath, ['-e', `import {discoverOpenCodeV2Run,requestOpenCodeV2Run} from ${JSON.stringify(module)};
        const record=await discoverOpenCodeV2Run(${JSON.stringify(root)},'TEST-team','TEST-run');
        if(!record) throw Error('TEST_missing_original');
        console.log(JSON.stringify({pid:process.pid,result:await requestOpenCodeV2Run(record,{operation:'status'},5000)}));`], { cwd: parent, timeout: 10_000 })
      const fresh = JSON.parse(freshCLI.stdout)
      expect(fresh.result).toEqual({ kind: 'status', state: 'starting', members: [], deadline })
      await expect(readRunProcessIdentity(fresh.pid)).rejects.toMatchObject({ code: 'ESRCH' })
      expect(process.cwd()).toBe(cwd)
      await expect(requestOpenCodeV2Run({ ...control.record, process: { ...control.record.process, startTicks: '0:1' } }, { operation: 'status' }, 5000)).rejects.toThrow('run_control_changed')
      await control.close()
      await expect(lstat(control.record.socketPath)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(process.cwd()).toBe(cwd)
    } finally { await control.close(); await rm(parent, { recursive: true, force: true }) }
  })
  test.skipIf(process.platform !== 'darwin')('Darwin listener close preserves a foreign socket basename in the process cwd', async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'TEST-darwin-cwd-')))
    const module = fileURLToPath(new URL('./OpenCodeV2RunControl.ts', import.meta.url))
    try {
      await writeFile(path.join(root, 'control.sock'), 'TEST foreign sentinel', { mode: 0o600 })
      const result = await execute(process.execPath, ['-e', `import {reserveRunControlDirectory,serveOpenCodeV2RunControl} from ${JSON.stringify(module)};
        import {readFile,lstat} from 'node:fs/promises';
        const binding=${JSON.stringify(binding)}, directory=await reserveRunControlDirectory(process.cwd(),binding,'a'.repeat(64));
        const control=await serveOpenCodeV2RunControl(directory,binding,Date.now()+5000,'a'.repeat(64),async()=>{throw Error('TEST_no_operation')});
        await control.close();
        console.log(JSON.stringify({sentinel:await readFile('control.sock','utf8'),socketGone:await lstat(control.record.socketPath).then(()=>false,e=>e.code==='ENOENT')}));`],
        { cwd: root, timeout: 10_000 })
      expect(JSON.parse(result.stdout)).toEqual({ sentinel: 'TEST foreign sentinel', socketGone: true })
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  test('long durable path authenticates fresh CLI and scoped stop retires the same socket without touching a foreign sentinel', async () => {
    const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), 'TEST-r249-ctl-')))
    const root = path.join(parent, 'long-durable-data-root-'.repeat(7))
    await mkdir(root, { mode: 0o700 })
    const directory = await reserveRunControlDirectory(root, binding, 'a'.repeat(64))
    expect(Buffer.byteLength(path.join(directory, 'control.sock'))).toBeGreaterThan(103)
    const owner = spawn(process.execPath, [peer, 'serve', root, JSON.stringify(binding)], { stdio: ['ignore', 'pipe', 'pipe'] })
    const foreign = spawn(process.execPath, [peer, 'sentinel'], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
    try {
      await Promise.all([ready(owner), ready(foreign)])
      const record = await discoverOpenCodeV2Run(root, binding.teamId, binding.runId)
      expect(record?.process.pid).toBe(owner.pid)
      expect(record?.socketPath).toBe(path.join(directory, 'control.sock'))
      const observed = await execute(process.execPath, [peer, 'call', root, JSON.stringify(binding), JSON.stringify({ operation: 'status' })], { timeout: 20_000 })
      expect(JSON.parse(observed.stdout).kind).toBe('status')
      const send = { operation: 'send', memberId: 'worker', originalSessionId: 'ses_TESToriginal', intent: { delivery: 'queue',
        identity: { requestId: 'request', deliveryAttemptId: 'attempt', localMessageId: 'local', nativeInputID: 'msg_TESToriginal' },
        input: { nativeInputID: 'msg_TESToriginal', text: 'TEST durable original', resume: true } } }
      const sent = await execute(process.execPath, [peer, 'semantic-send', root, JSON.stringify(binding), JSON.stringify(send)], { timeout: 20_000 })
      expect(JSON.parse(sent.stdout)).toMatchObject({ accepted: true, sessionId: 'ses_TESToriginal', runtimePromptMessageId: send.intent.identity.nativeInputID })
      const repeatedSend = await execute(process.execPath, [peer, 'semantic-send', root, JSON.stringify(binding), JSON.stringify(send)], { timeout: 20_000 })
      expect(JSON.parse(repeatedSend.stdout)).toMatchObject({ accepted: true, runtimePromptMessageId: send.intent.identity.nativeInputID })
      const transcript = await execute(process.execPath, [peer, 'call', root, JSON.stringify(binding), JSON.stringify({ operation: 'observe',
        memberId: 'worker', originalSessionId: 'ses_TESToriginal', nativeInputID: 'msg_TESToriginal' })], { timeout: 20_000 })
      expect(JSON.parse(transcript.stdout)).toMatchObject({ kind: 'observe', admission: { identity: send.intent.identity }, turn: { state: 'pending', reason: 'input_not_delivered', assistantMessageIds: [], toolEffects: [], visibleReplies: [] } })
      const stopped = await execute(process.execPath, [peer, 'call', root, JSON.stringify(binding), JSON.stringify({ operation: 'stop' })], { timeout: 20_000 })
      expect(JSON.parse(stopped.stdout)).toMatchObject({ kind: 'stop', state: 'cleanup_unknown', ownerRetired: true })
      const repeated = await execute(process.execPath, [peer, 'call', root, JSON.stringify(binding), JSON.stringify({ operation: 'stop' })], { timeout: 20_000 })
      expect(JSON.parse(repeated.stdout)).toMatchObject({ kind: 'stop', state: 'cleanup_unknown', ownerRetired: true })
      expect((await discoverOpenCodeV2Run(root, binding.teamId, binding.runId))?.process.pid).toBe(owner.pid)
      if (!record) throw new Error('TEST_record_missing')
      expect(JSON.parse(await readFile(path.join(record.directory, 'synthetic-effects.json'), 'utf8'))).toEqual({ prompted: 1, closed: 1 })
      const outcomes = JSON.parse(await readFile(path.join(root, 'opencode', 'command-outcomes.json'), 'utf8'))
      expect(outcomes.records.request).toMatchObject({ status: 'prompt_accepted', safeToRetry: false,
        runtimePromptMessageId: send.intent.identity.nativeInputID, sessionId: 'ses_TESToriginal' })
      await expect(lstat(record.socketPath)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(foreign.exitCode).toBeNull(); expect(foreign.signalCode).toBeNull()
      const pong = new Promise<unknown>(resolve => foreign.once('message', resolve))
      foreign.send('ping'); expect(await boundOpenCodeRead(pong, 1000)).toBe('alive')
      if (record) await expect(requestOpenCodeV2Run(record, { operation: 'status' }, 1000)).rejects.toThrow()
    } finally { await Promise.all([stopTestChild(owner), stopTestChild(foreign)]); await rm(parent, { recursive: true, force: true }) }
  }, 120_000)
  test('operation failures retain only exact private codes while the public result remains unknown', async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'TEST-run-private-failure-')))
    const directory = await reserveRunControlDirectory(root, binding, 'a'.repeat(64))
    let failure = 'mutable_readback'
    const control = await serveOpenCodeV2RunControl(directory, binding, Date.now() + 30_000, 'a'.repeat(64),
      async () => { throw new Error(failure) })
    try {
      await expect(requestOpenCodeV2Run(control.record, { operation: 'status' }, 5000)).rejects.toThrow('run_operation_unknown')
      const first = JSON.parse(await readFile(path.join(directory, 'operation-failure.json'), 'utf8'))
      expect(first).toEqual({ schemaVersion: 1, event: 'opencode_v2_run_operation_failure', binding,
        operation: 'status', category: 'mutable_readback', timestamp: expect.any(String) })
      failure = 'mutable_readback SECRET provider body /private/auth'
      await expect(requestOpenCodeV2Run(control.record, { operation: 'status' }, 5000)).rejects.toThrow('run_operation_unknown')
      const text = await readFile(path.join(directory, 'operation-failure.json'), 'utf8')
      expect(JSON.parse(text).category).toBe('unclassified')
      expect(text).not.toContain('SECRET')
      expect(text).not.toContain('/private/auth')
      expect((await lstat(path.join(directory, 'operation-failure.json'))).mode & 0o777).toBe(0o600)
    } finally {
      await control.close()
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)
  for (const archiveDelayMs of [250, 10_001]) test(`stop archive reads retain the caller deadline after ${archiveDelayMs}ms`, async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'TEST-stop-archive-deadline-')))
    const directory = await reserveRunControlDirectory(root, binding, 'a'.repeat(64))
    const origin = Date.now()
    let clock = origin, calls = 0, signedDeadline: number | undefined
    const control = await serveOpenCodeV2RunControl(directory, binding, origin + 5000, 'a'.repeat(64),
      async (_request, deadline) => { calls++; signedDeadline = deadline; throw new Error('TEST_stop_observed') })
    await writeRunControlFile(directory, 'tombstone.json', { binding })
    await writeRunControlFile(directory, 'stop.json', { binding, receipt: { kind: 'stop', state: 'cleanup_unknown', members: [] } })
    const now = spyOn(Date, 'now').mockImplementation(() => clock)
    try {
      const pending = requestOpenCodeV2Run(control.record, { operation: 'stop' }, 10_000)
      // The public request is now awaiting real archive filesystem reads.
      clock += archiveDelayMs
      let failure: unknown
      try { await pending } catch (error) { failure = error }
      if (archiveDelayMs < 10_000) {
        expect(calls).toBe(1)
        expect(signedDeadline).toBe(origin + 10_000)
        expect(failure).toMatchObject({ message: 'run_operation_unknown' })
      } else {
        expect(calls).toBe(0)
        expect(failure).toMatchObject({ message: 'run_deadline_expired' })
      }
    } finally {
      now.mockRestore()
      await control.close()
      await rm(root, { recursive: true, force: true })
    }
  })
  test('published control waits for the same delayed native member before its sole original admission', async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'TEST-r261-ready-')))
    const directory = await reserveRunControlDirectory(root, binding, 'a'.repeat(64))
    const owner = spawn(process.execPath, [peer, 'serve-delayed', root, JSON.stringify(binding)], { stdio: ['ignore', 'pipe', 'pipe'] })
    try {
      await ready(owner)
      const record = await discoverOpenCodeV2Run(root, binding.teamId, binding.runId)
      if (!record) throw new Error('TEST_record_missing')
      const target = { memberId: 'worker', originalSessionId: 'ses_TESToriginal', selectedModel: 'TEST/TEST', pin: '2.0.21' as const }
      const send = { operation: 'send' as const, memberId: target.memberId, originalSessionId: target.originalSessionId,
        intent: { delivery: 'queue' as const, identity: { requestId: 'request', deliveryAttemptId: 'attempt', localMessageId: 'local', nativeInputID: 'msg_TESToriginal' },
          input: { nativeInputID: 'msg_TESToriginal', text: 'TEST delayed original', resume: true } } }
      expect(await requestOpenCodeV2Run(record, { operation: 'status' }, 5000)).toMatchObject({ kind: 'status', state: 'starting' })
      // This is the previous probe ordering: endpoint-ready alone cannot admit input.
      await expect(requestOpenCodeV2Run(record, send, 5000)).rejects.toThrow('run_operation_unknown')
      await expect(lstat(path.join(directory, 'synthetic-effects.json'))).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(awaitOpenCodeV2RunMemberReadiness(record, { ...target, originalSessionId: 'ses_TESTreplacement' }, 5000))
        .rejects.toThrow('run_readiness_changed')
      const waiting = awaitOpenCodeV2RunMemberReadiness(record, target, 15_000)
      await new Promise(resolve => setTimeout(resolve, 100))
      expect(await requestOpenCodeV2Run(record, { operation: 'status' }, 5000)).toMatchObject({ state: 'starting' })
      await writeFile(path.join(directory, 'TEST-release-initialization'), '', { flag: 'wx', mode: 0o600 })
      expect(await waiting).toMatchObject({ ...target, opencodeSessionId: target.originalSessionId,
        runtimeSessionId: target.originalSessionId, state: 'accepted', bootstrap: { verified: true, missingNativeMessageID: true } })
      const result = await requestOpenCodeV2Run(record, send, 5000)
      expect(result).toMatchObject({ kind: 'send', admission: { identity: send.intent.identity } })
      expect(JSON.parse(await readFile(path.join(directory, 'synthetic-effects.json'), 'utf8'))).toEqual({ prompted: 1, closed: 0 })
      expect(await requestOpenCodeV2Run(record, { operation: 'stop' }, 5000)).toMatchObject({ kind: 'stop', state: 'cleanup_unknown', ownerRetired: true })
      expect(JSON.parse(await readFile(path.join(directory, 'synthetic-effects.json'), 'utf8'))).toEqual({ prompted: 1, closed: 1 })
    } finally { await stopTestChild(owner); await rm(root, { recursive: true, force: true }) }
  }, 120_000)
  test('permanent starting and original stop never authorize admission', async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'TEST-r261-ready-')))
    const directory = await reserveRunControlDirectory(root, binding, 'a'.repeat(64))
    const owner = spawn(process.execPath, [peer, 'serve-delayed', root, JSON.stringify(binding)], { stdio: ['ignore', 'pipe', 'pipe'] })
    try {
      await ready(owner)
      const record = await discoverOpenCodeV2Run(root, binding.teamId, binding.runId)
      if (!record) throw new Error('TEST_record_missing')
      const target = { memberId: 'worker', originalSessionId: 'ses_TESToriginal', selectedModel: 'TEST/TEST', pin: '2.0.21' as const }
      expect(await awaitOpenCodeV2RunMemberReadiness(record, target, 1000)).toBeNull()
      await expect(lstat(path.join(directory, 'synthetic-effects.json'))).rejects.toMatchObject({ code: 'ENOENT' })
      const waiting = awaitOpenCodeV2RunMemberReadiness(record, target, 5000).catch(() => null)
      await requestOpenCodeV2Run(record, { operation: 'stop' }, 5000).catch((error: unknown) => {
        // The fixture awaits initialization just like the production entrypoint.
        // Aborting its held acquisition can close the endpoint before the reply.
        if (!(error instanceof Error && error.message === 'run_control_disconnected')) throw error
      })
      expect(JSON.parse(await readFile(path.join(directory, 'tombstone.json'), 'utf8'))).toMatchObject({ binding })
      expect(await waiting).toBeNull()
      await expect(lstat(path.join(directory, 'synthetic-effects.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await stopTestChild(owner); await rm(root, { recursive: true, force: true }) }
  }, 120_000)
  test('changed socket/owner binding or public challenge permissions cannot authorize a stop', async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'TEST-r249-ctl-')))
    const directory = await reserveRunControlDirectory(root, binding, 'a'.repeat(64))
    const owner = spawn(process.execPath, [peer, 'serve', root, JSON.stringify(binding)], { stdio: ['ignore', 'pipe', 'pipe'] })
    try {
      await ready(owner)
      const record = await discoverOpenCodeV2Run(root, binding.teamId, binding.runId)
      expect(record).not.toBeNull()
      if (!record) throw new Error('TEST_record_missing')
      await expect(requestOpenCodeV2Run({ ...record, binding: { ...binding, ownerId: 'foreign' } }, { operation: 'stop' }, 1000)).rejects.toThrow('run_control_changed')
      const challenge = path.join(directory, 'challenge')
      await chmod(challenge, 0o644)
      await expect(requestOpenCodeV2Run(record, { operation: 'stop' }, 1000)).rejects.toThrow('run_control_foreign')
      await chmod(challenge, 0o600)
      await rename(record.socketPath, `${record.socketPath}.original`)
      await writeFile(record.socketPath, '', { mode: 0o600 })
      await expect(requestOpenCodeV2Run(record, { operation: 'stop' }, 1000)).rejects.toThrow('run_control_foreign')
      const durable = JSON.parse(await readFile(path.join(directory, 'control.json'), 'utf8'))
      expect(durable.binding.ownerId).toBe('owner'); expect(owner.exitCode).toBeNull()
    } finally { await stopTestChild(owner); await rm(root, { recursive: true, force: true }) }
  }, 15_000)
  test('replaced pathname refuses cleanup but still retires the owned listener without unlinking the replacement', async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'TEST-r249-ctl-')))
    const directory = await reserveRunControlDirectory(root, binding, 'a'.repeat(64))
    const control = await serveOpenCodeV2RunControl(directory, binding, Date.now() + 5000, 'a'.repeat(64),
      async () => { throw new Error('TEST_no_operation') })
    const original = `${control.record.socketPath}.original`
    try {
      await rename(control.record.socketPath, original)
      await writeFile(control.record.socketPath, 'foreign', { mode: 0o600 })
      const node = process.env.TEST_OPENCODE_NODE_BINARY
      if (!node) throw new Error('TEST_pinned_node_required')
      const connect = async () => {
        const peer = `(${socketEndpointPeer.toString()})(require('node:fs'), require('node:net'))`
        const result = await execute(node, ['-e', peer, directory], { timeout: 3000 })
        return JSON.parse(result.stdout)
      }
      const before = await connect()
      expect(before).toMatchObject({ canonical: directory, socket: true, connected: true })
      expect(before.pathBytes).toBeLessThanOrEqual(103)
      await expect(control.close()).rejects.toThrow('run_control_foreign')
      expect(await readFile(control.record.socketPath, 'utf8')).toBe('foreign')
      await expect(control.close()).rejects.toThrow('run_control_foreign')
      const inode = await lstat(original)
      expect(inode.isSocket()).toBe(true)
      expect(inode.ino).toBe(control.record.socketInode)
      const after = await connect()
      expect(after).toMatchObject({ canonical: directory, socket: true, device: before.device,
        inode: before.inode, connected: false, errorCode: 'ECONNREFUSED' })
      expect(after.pathBytes).toBeLessThanOrEqual(103)
    } finally { await control.close().catch(() => undefined); await rm(root, { recursive: true, force: true }) }
  })
  test('existing foreign socket path and symlink cannot be reclaimed on startup', async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'TEST-r249-ctl-')))
    const directory = await reserveRunControlDirectory(root, binding, 'a'.repeat(64))
    const socketPath = path.join(directory, 'control.sock'), sentinel = path.join(root, 'foreign-sentinel')
    try {
      await writeFile(sentinel, 'untouched', { mode: 0o600 })
      await symlink(sentinel, socketPath)
      await expect(serveOpenCodeV2RunControl(directory, binding, Date.now() + 5000, 'a'.repeat(64),
        async () => { throw new Error('TEST_no_operation') })).rejects.toThrow('run_control_foreign')
      expect(await readFile(sentinel, 'utf8')).toBe('untouched')
      expect((await lstat(socketPath)).isSymbolicLink()).toBe(true)
      await rm(socketPath)
      await writeFile(socketPath, 'foreign', { mode: 0o600 })
      await expect(serveOpenCodeV2RunControl(directory, binding, Date.now() + 5000, 'a'.repeat(64),
        async () => { throw new Error('TEST_no_operation') })).rejects.toThrow('run_control_foreign')
      expect(await readFile(socketPath, 'utf8')).toBe('foreign')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  test('control DTO cannot supply lease, endpoint, changed original ID, or V1 noReply authority', () => {
    expect(() => parseRunControlRequest({ operation: 'status', authority: {} })).toThrow('run_control_invalid')
    expect(() => parseRunControlRequest({ operation: 'observe', memberId: 'worker', originalSessionId: 'replacement', nativeInputID: 'msg_original' }))
      .toThrow('run_control_invalid')
    expect(() => parseRunControlRequest({ operation: 'send', memberId: 'worker', originalSessionId: 'ses_original', intent: {
      delivery: 'queue', identity: { requestId: 'request', deliveryAttemptId: 'attempt', localMessageId: 'local', nativeInputID: 'msg_original' },
      input: { nativeInputID: 'msg_original', text: 'hello', resume: false, noReply: true },
    } })).toThrow('run_control_invalid')
  })
})
