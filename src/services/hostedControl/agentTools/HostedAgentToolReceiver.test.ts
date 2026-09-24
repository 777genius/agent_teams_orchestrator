import { afterEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { connect, createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { decodeHostedAgentToolRequest } from './HostedAgentToolContract.js'
import { HostedAgentToolEffectGate } from './HostedAgentToolEffectGate.js'
import { HostedAgentToolReceiver, type HostedAgentToolExecutors } from './HostedAgentToolReceiver.js'
import { HostedAgentToolWal, type HostedAgentToolBinding } from './HostedAgentToolWal.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function frame(value: unknown): Buffer {
  const bytes = Buffer.from(JSON.stringify(value), 'utf8')
  const packet = Buffer.alloc(4 + bytes.length)
  packet.writeUInt32BE(bytes.length, 0)
  bytes.copy(packet, 4)
  return packet
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    version: 1, type: 'request', requestId: randomUUID(), tool: 'hosted_task_start',
    context: { sessionID: 'session_1', messageID: 'message_1', callID: 'call_1' },
    args: { taskId: `task_${'c'.repeat(32)}` }, ...overrides,
  }
}

function readResponse(socket: Socket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0)
    const cleanup = () => {
      socket.off('data', onData)
      socket.off('close', onClose)
      socket.off('error', onError)
    }
    const onClose = () => { cleanup(); reject(new Error('Owner socket closed before response')) }
    const onError = (error: Error) => { cleanup(); reject(error) }
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.length < 4 || buffer.length < 4 + buffer.readUInt32BE(0)) return
      const length = buffer.readUInt32BE(0)
      cleanup()
      resolve(JSON.parse(buffer.subarray(4, 4 + length).toString('utf8')))
    }
    socket.on('data', onData)
    socket.once('close', onClose)
    socket.once('error', onError)
  })
}

async function fixture(input: {
  execute?: HostedAgentToolExecutors['hosted_task_start']
  isCurrent?: (binding: Readonly<HostedAgentToolBinding>) => boolean | Promise<boolean>
} = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'hosted-agent-receiver-')))
  const socketPath = join(root, 'fd3.sock')
  const server = createServer()
  server.listen(socketPath)
  await once(server, 'listening')
  const accepted = new Promise<Socket>(resolve => server.once('connection', resolve))
  const peer = connect(socketPath)
  await once(peer, 'connect')
  const owner = await accepted
  const binding: HostedAgentToolBinding = {
    workspaceId: 'workspace_test', teamId: `team_${'a'.repeat(32)}`,
    workspaceRoot: root, planGeneration: `plan-generation_${'b'.repeat(64)}`,
    runId: 'run_1', laneId: 'lane_1', memberName: 'worker', sessionID: 'session_1',
  }
  const gate = new HostedAgentToolEffectGate()
  const effects: string[] = []
  const task = input.execute ?? (async ({ binding: ownerBinding }) => {
    effects.push(ownerBinding.memberName)
    return 'started'
  })
  const rejectUnexpected = async () => { throw new Error('Unexpected tool effect') }
  const executors: HostedAgentToolExecutors = {
    hosted_task_get: rejectUnexpected,
    hosted_task_start: task,
    hosted_task_complete: rejectUnexpected,
    hosted_task_add_comment: rejectUnexpected,
    hosted_message_send: rejectUnexpected,
  }
  const receiver = new HostedAgentToolReceiver({
    socket: owner, binding, teamName: 'sandbox-team', gate,
    wal: new HostedAgentToolWal(join(root, 'agent-tools')),
    isCurrent: (currentBinding, context) => context.sessionID === currentBinding.sessionID &&
      (input.isCurrent?.(currentBinding) ?? true),
    canSendTo: to => to === 'team-lead', executors,
  })
  cleanups.push(async () => {
    receiver.close()
    peer.destroy()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  })
  return { peer, gate, effects, binding, root, receiver }
}

async function exchange(peer: Socket, value: unknown): Promise<Record<string, unknown>> {
  const response = readResponse(peer)
  peer.write(frame(value))
  return response
}

describe('HostedAgentToolReceiver', () => {
  test('correlates a framed result and replays the durable terminal without another effect', async () => {
    const { peer, effects } = await fixture()
    const first = request()
    expect(await exchange(peer, first)).toEqual({
      version: 1, type: 'response', requestId: first.requestId, ok: true, result: 'started',
    })
    const second = request({ context: first.context })
    expect(await exchange(peer, second)).toEqual({
      version: 1, type: 'response', requestId: second.requestId, ok: true, result: 'started',
    })
    expect(effects).toEqual(['worker'])
  })

  test('revocation during the post-intent authority check prevents the effect', async () => {
    let checks = 0
    let release!: () => void
    let entered!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const waiting = new Promise<void>(resolve => { entered = resolve })
    const { peer, gate, effects } = await fixture({ isCurrent: async () => {
      checks++
      if (checks === 3) { entered(); await held }
      return true
    } })
    const call = request()
    const response = exchange(peer, call)
    await waiting
    const revoke = gate.transition(async () => {})
    release()
    expect(await response).toEqual({
      version: 1, type: 'response', requestId: call.requestId, ok: false, error: 'operator_required',
    })
    await revoke
    expect(effects).toEqual([])
  })

  test('socket close during the post-intent authority check cannot reach an executor', async () => {
    let checks = 0
    let release!: () => void
    let entered!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const waiting = new Promise<void>(resolve => { entered = resolve })
    let effects = 0
    let abortedAtExecution = false
    const { peer, receiver, root, binding } = await fixture({
      isCurrent: async () => {
        if (++checks === 3) { entered(); await held }
        return true
      },
      execute: async ({ signal }) => {
        effects++
        abortedAtExecution = signal.aborted
        return 'should-not-run'
      },
    })
    const call = request()
    peer.write(frame(call))
    await waiting
    const closed = once(peer, 'close')
    receiver.close()
    release()
    await closed
    await Bun.sleep(0)
    expect(effects).toBe(0)
    expect(abortedAtExecution).toBe(false)
    expect(await new HostedAgentToolWal(join(root, 'agent-tools'))
      .begin({ binding, request: decodeHostedAgentToolRequest(JSON.stringify(call)) }))
      .toEqual({ kind: 'operator_required' })
  })

  test('malformed or mismatched FD3 request closes without an effect', async () => {
    for (const bytes of [
      (() => { const prefix = Buffer.alloc(4); prefix.writeUInt32BE(64 * 1024 + 1); return prefix })(),
      frame(request({ context: { sessionID: 'foreign', messageID: 'm', callID: 'c' } })),
      frame(request({ tool: 'hosted_message_send', args: { to: 'team-lead', text: 'status',
        taskRefs: [{ teamName: 'foreign-team', taskId: `task_${'d'.repeat(32)}` }] } })),
      Buffer.concat([frame(request()), frame(request())]),
    ]) {
      const { peer, effects } = await fixture()
      const closed = once(peer, 'close')
      peer.write(bytes)
      await closed
      expect(effects).toEqual([])
    }
  })

  test('an uncertain effect leaves intent unresolved and forbids an automatic retry', async () => {
    let effects = 0
    const { peer } = await fixture({ execute: async () => { effects++; throw new Error('uncertain effect') } })
    const first = request()
    expect(await exchange(peer, first)).toEqual({
      version: 1, type: 'response', requestId: first.requestId, ok: false, error: 'operator_required',
    })
    const second = request({ context: first.context })
    expect(await exchange(peer, second)).toEqual({
      version: 1, type: 'response', requestId: second.requestId, ok: false, error: 'operator_required',
    })
    expect(effects).toBe(1)
  })

  test('a result too large for the FD3 response stays unresolved after its effect', async () => {
    let effects = 0
    const { peer } = await fixture({ execute: async () => { effects++; return '"'.repeat(64 * 1024) } })
    const first = request()
    expect(await exchange(peer, first)).toMatchObject({ ok: false, error: 'operator_required' })
    expect(await exchange(peer, request({ context: first.context })))
      .toMatchObject({ ok: false, error: 'operator_required' })
    expect(effects).toBe(1)
  })
})
