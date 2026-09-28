import { afterEach, describe, expect, test } from 'bun:test'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { connect, type Socket } from 'node:net'
import { join } from 'node:path'

import { HostedAgentToolEffectGate } from '../agentTools/HostedAgentToolEffectGate.js'
import { HostedAgentToolWal, type HostedAgentToolBinding } from '../agentTools/HostedAgentToolWal.js'
import { HostedAgentToolBroker, type HostedAgentToolBrokerOptions } from './HostedAgentToolBroker.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

const binding: HostedAgentToolBinding = {
  workspaceId: 'workspace', teamId: `team_${'1'.repeat(32)}`, workspaceRoot: '/sandbox/workspace',
  planGeneration: `plan-generation_${'a'.repeat(64)}`, runId: 'run_1', laneId: 'lane_1', memberId: `member_${'2'.repeat(32)}`,
  memberName: 'worker', sessionID: 'session_1',
}

async function setup(patch: Partial<HostedAgentToolBrokerOptions> = {}) {
  const root = await realpath(await mkdtemp(join('/tmp', 'fd3-'))); roots.push(root)
  const challenge = randomBytes(32).toString('hex')
  let taskEffects = 0
  const { sessionID: _sessionID, ...pendingBinding } = binding
  const options: HostedAgentToolBrokerOptions = {
    socketPath: join(root, `fd3-${'3'.repeat(32)}.sock`), challenge,
    operationId: 'operation_test', containerGeneration: '4'.repeat(32), binding: pendingBinding, teamName: 'sandbox',
    expectedRootConnector: { pid: process.pid, uid: 0, startTicks: '1' },
    testOnlyReadPeerCredentials: async () => ({ pid: process.pid, uid: 0, gid: 0 }),
    roster: [{ teamId: binding.teamId, runId: binding.runId, laneId: binding.laneId,
      memberId: binding.memberId, memberName: binding.memberName },
    { teamId: binding.teamId, runId: binding.runId, laneId: 'lane_peer',
      memberId: `member_${'6'.repeat(32)}`, memberName: 'peer' }],
    gate: new HostedAgentToolEffectGate(), wal: new HostedAgentToolWal(join(root, 'wal')),
    authority: { actorId: binding.memberId, deploymentId: 'deployment', bootId: 'boot',
      restoreGeneration: 1, workspaceId: binding.workspaceId, teamId: binding.teamId,
      mountBinding: { mountGeneration: 1, declaredRootHash: 'a'.repeat(64) } },
    ownerBinding: { ownerAuthority: 'owner_authority1', ownerGeneration: 1,
      ownerSessionId: `owner_session_${'d'.repeat(32)}`,
      socketIdentity: { device: '1', inode: '2', uid: 501, gid: 20, mode: 0o600 } },
    taskService: { mutate: async () => { taskEffects++; return { kind: 'unavailable' as const } } },
    taskReader: { getTask: async input => ({ teamId: binding.teamId, taskId: input.taskId,
      ownerId: binding.memberId, status: 'pending', sourceGeneration: 'generation_test',
      revision: 'revision_test', task: { id: 'sandbox', subject: 'Only test data' } }) },
    comments: { addComment: async () => { taskEffects++; return '' } },
    messages: { send: async () => { taskEffects++; return '' } },
    isCurrent: () => true, currentRecipient: to => to === 'peer' ? {
      teamId: binding.teamId, runId: binding.runId, laneId: 'lane_peer',
      memberId: `member_${'6'.repeat(32)}`, memberName: 'peer',
    } : null, canSendTo: () => true, verifyPostExec: async () => true,
  }
  const finalOptions = { ...options, ...patch }
  const broker = await HostedAgentToolBroker.create(finalOptions)
  return { broker, options: finalOptions, effects: () => taskEffects }
}

function connectPeer(options: HostedAgentToolBrokerOptions, challenge = options.challenge): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(options.socketPath, () => {
      socket.write(`${JSON.stringify({ version: 1, operationId: options.operationId,
        containerGeneration: options.containerGeneration, challenge })}\n`)
      resolve(socket)
    })
    socket.once('error', reject)
  })
}

function ack(socket: Socket): Promise<string> {
  return new Promise(resolve => socket.once('data', bytes => resolve(bytes.toString('utf8'))))
}

describe('HostedAgentToolBroker', () => {
  test('activates exact bound session and serves a read through FD3', async () => {
    const { broker, options, effects } = await setup()
    const socket = await connectPeer(options)
    await ack(socket)
    await broker.waitForPeer()
    broker.bindSession(binding.sessionID)
    await broker.activate({ operationId: options.operationId, containerGeneration: options.containerGeneration,
      runId: binding.runId, laneId: binding.laneId, memberId: binding.memberId, sessionID: binding.sessionID })
    const taskId = `task_${'5'.repeat(32)}`
    const request = Buffer.from(JSON.stringify({ version: 1, type: 'request', requestId: randomUUID(),
      tool: 'hosted_task_get', context: { sessionID: binding.sessionID, messageID: 'message_1', callID: 'call_1' },
      args: { taskId } }))
    const frame = Buffer.alloc(4 + request.length)
    frame.writeUInt32BE(request.length, 0)
    request.copy(frame, 4)
    const response = new Promise<{ ok: boolean; result: string }>(resolve => socket.once('data', bytes => {
      resolve(JSON.parse(bytes.subarray(4).toString('utf8')) as { ok: boolean; result: string })
    }))
    socket.write(frame)
    const result = await response
    expect(result).toMatchObject({ ok: true })
    expect(JSON.parse(result.result)).toMatchObject({ taskId, ownerId: binding.memberId })
    expect(effects()).toBe(0)
    const write = Buffer.from(JSON.stringify({ version: 1, type: 'request', requestId: randomUUID(),
      tool: 'hosted_task_start', context: { sessionID: binding.sessionID,
        messageID: 'message_2', callID: 'call_write_without_product' }, args: { taskId } }))
    const writeFrame = Buffer.alloc(4 + write.length)
    writeFrame.writeUInt32BE(write.length, 0)
    write.copy(writeFrame, 4)
    const denied = new Promise<{ ok: boolean; error: string }>(resolve => socket.once('data', bytes =>
      resolve(JSON.parse(bytes.subarray(4).toString('utf8')) as { ok: boolean; error: string })))
    socket.write(writeFrame)
    expect(await denied).toMatchObject({ ok: false, error: 'operator_required' })
    expect(effects()).toBe(0)
    await broker.revoke()
    socket.destroy()
  })

  test('keeps the one accepted peer inert until exact post-exec proof', async () => {
    const { broker, options, effects } = await setup()
    const socket = await connectPeer(options)
    expect(await ack(socket)).toBe('{"version":1,"kind":"accepted"}\n')
    await broker.waitForPeer()
    broker.bindSession(binding.sessionID)
    expect(() => broker.bindSession(binding.sessionID)).toThrow('unavailable')
    await expect(broker.activate({ operationId: options.operationId, containerGeneration: options.containerGeneration,
      runId: binding.runId, laneId: binding.laneId, memberId: binding.memberId,
      sessionID: 'wrong-session' })).rejects.toThrow()
    expect(effects()).toBe(0)
    socket.destroy()
  })

  test('requires one-time session bind before activation and rejects revocation races', async () => {
    const first = await setup()
    const socket = await connectPeer(first.options)
    await ack(socket)
    await first.broker.waitForPeer()
    await expect(first.broker.activate({ operationId: first.options.operationId,
      containerGeneration: first.options.containerGeneration, runId: binding.runId,
      laneId: binding.laneId, memberId: binding.memberId, sessionID: binding.sessionID })).rejects.toThrow()
    expect(() => first.broker.bindSession(binding.sessionID)).toThrow('unavailable')
    socket.destroy()

    const second = await setup()
    const peer = await connectPeer(second.options)
    await ack(peer)
    await second.broker.waitForPeer()
    second.broker.bindSession(binding.sessionID)
    await second.broker.revoke()
    await expect(second.broker.activate({ operationId: second.options.operationId,
      containerGeneration: second.options.containerGeneration, runId: binding.runId,
      laneId: binding.laneId, memberId: binding.memberId, sessionID: binding.sessionID })).rejects.toThrow()
    expect(second.effects()).toBe(0)
    peer.destroy()
  })

  test('rejects early tool bytes and a forged connector challenge', async () => {
    const first = await setup()
    const early = await connectPeer(first.options)
    expect(await ack(early)).toContain('accepted')
    early.write('early-tool-frame')
    await expect(first.broker.waitForPeer()).resolves.toBeUndefined()
    await new Promise(resolve => early.once('close', resolve))
    expect(first.effects()).toBe(0)

    const second = await setup()
    const forged = await connectPeer(second.options, 'f'.repeat(64))
    await expect(second.broker.waitForPeer()).rejects.toThrow()
    expect(second.effects()).toBe(0)
    forged.destroy()
  })

  test('rejects a same-name replacement in the immutable admitted roster', async () => {
    const { broker, options } = await setup()
    await broker.revoke()
    await expect(HostedAgentToolBroker.create({ ...options,
      roster: [{ ...options.roster[0]!, memberId: `member_${'9'.repeat(32)}` }],
    })).rejects.toThrow('roster mismatch')
  })

  test('rejects the right challenge from a wrong kernel PID or UID before acknowledgement', async () => {
    for (const credentials of [
      { pid: process.pid + 1, uid: 0, gid: 0 },
      { pid: process.pid, uid: 501, gid: 20 },
    ]) {
      const { broker, options, effects } = await setup({ testOnlyReadPeerCredentials: async () => credentials })
      const socket = await connectPeer(options)
      await expect(broker.waitForPeer()).rejects.toThrow()
      expect(effects()).toBe(0)
      socket.destroy()
    }
  })

  test('rejects a same-name recipient whose current member ID changed', async () => {
    const { broker, options, effects } = await setup({ currentRecipient: async () => ({
      teamId: binding.teamId, runId: binding.runId, laneId: 'lane_peer',
      memberId: `member_${'7'.repeat(32)}`, memberName: 'peer',
    }) })
    const socket = await connectPeer(options)
    await ack(socket)
    await broker.waitForPeer()
    broker.bindSession(binding.sessionID)
    await broker.activate({ operationId: options.operationId, containerGeneration: options.containerGeneration,
      runId: binding.runId, laneId: binding.laneId, memberId: binding.memberId, sessionID: binding.sessionID })
    const request = Buffer.from(JSON.stringify({ version: 1, type: 'request', requestId: randomUUID(),
      tool: 'hosted_message_send', context: { sessionID: binding.sessionID,
        messageID: 'message_1', callID: 'call_peer' }, args: { to: 'peer', text: 'hello' } }))
    const frame = Buffer.alloc(4 + request.length)
    frame.writeUInt32BE(request.length, 0); request.copy(frame, 4)
    const response = new Promise<{ ok: boolean; error: string }>(resolve => socket.once('data', bytes =>
      resolve(JSON.parse(bytes.subarray(4).toString('utf8')) as { ok: boolean; error: string })))
    socket.write(frame)
    expect(await response).toMatchObject({ ok: false, error: 'unavailable' })
    expect(effects()).toBe(0)
    await broker.revoke()
    socket.destroy()
  })

  test('rejects recipient replacement between admission and Product proposal', async () => {
    let reads = 0
    let productCalls = 0
    const admitted = { teamId: binding.teamId, runId: binding.runId,
      laneId: 'lane_peer', memberId: `member_${'6'.repeat(32)}`, memberName: 'peer' }
    const replacement = { ...admitted, laneId: 'lane_replacement',
      memberId: `member_${'7'.repeat(32)}` }
    const forbidden = async () => { productCalls++; return 'unexpected Product write' }
    const { broker, options, effects } = await setup({
      currentRecipient: async () => ++reads === 1 ? admitted : replacement,
      productWriter: { commitTaskStatus: forbidden, appendTaskComment: forbidden,
        appendPeerMessage: forbidden },
    })
    const socket = await connectPeer(options)
    await ack(socket)
    await broker.waitForPeer()
    broker.bindSession(binding.sessionID)
    await broker.activate({ operationId: options.operationId, containerGeneration: options.containerGeneration,
      runId: binding.runId, laneId: binding.laneId, memberId: binding.memberId,
      sessionID: binding.sessionID })
    const request = Buffer.from(JSON.stringify({ version: 1, type: 'request', requestId: randomUUID(),
      tool: 'hosted_message_send', context: { sessionID: binding.sessionID,
        messageID: 'message_replacement', callID: 'call_replacement' },
      args: { to: 'peer', text: 'sandbox message' } }))
    const frame = Buffer.alloc(4 + request.length)
    frame.writeUInt32BE(request.length, 0); request.copy(frame, 4)
    const response = new Promise<{ ok: boolean; error: string }>(resolve => socket.once('data', bytes =>
      resolve(JSON.parse(bytes.subarray(4).toString('utf8')) as { ok: boolean; error: string })))
    socket.write(frame)
    expect(await response).toMatchObject({ ok: false, error: 'operator_required' })
    expect(reads).toBe(2)
    expect(productCalls).toBe(0)
    expect(effects()).toBe(0)
    await broker.revoke()
    socket.destroy()
  })
})
