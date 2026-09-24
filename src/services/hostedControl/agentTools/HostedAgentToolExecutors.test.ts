import { describe, expect, test } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { connect, createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { HostedTaskMutationService } from '../HostedTaskMutationService.js'
import { HostedTaskMutationWal } from '../HostedTaskMutationWal.js'
import { fingerprintHostedTaskCommand, type HostedControlAuthority, type HostedControlOwnerBinding,
  type HostedTaskMutationCommand, type HostedTaskMutationRequest } from '../protocol.js'
import { createHostedAgentToolExecutors, type HostedAgentTaskSnapshot } from './HostedAgentToolExecutors.js'
import { decodeHostedAgentToolRequest } from './HostedAgentToolContract.js'
import { HostedAgentToolEffectGate } from './HostedAgentToolEffectGate.js'
import { HostedAgentToolReceiver } from './HostedAgentToolReceiver.js'
import { HostedAgentToolWal } from './HostedAgentToolWal.js'
import type { HostedAgentToolBinding } from './HostedAgentToolWal.js'

const memberId = `member_${'a'.repeat(32)}`
const teamId = `team_${'b'.repeat(32)}`
const taskId = `task_${'c'.repeat(32)}`
const binding: HostedAgentToolBinding = {
  workspaceId: 'workspace_test', teamId, workspaceRoot: '/tmp/hosted-test',
  planGeneration: `plan-generation_${'d'.repeat(64)}`, runId: 'run_test',
  laneId: 'lane_test', memberId, memberName: 'worker', sessionID: 'session_test',
}
const authority: HostedControlAuthority = {
  actorId: memberId, deploymentId: 'deployment_test', bootId: 'boot_test',
  restoreGeneration: 1, workspaceId: binding.workspaceId,
  mountBinding: { mountGeneration: 1, declaredRootHash: 'e'.repeat(64) }, teamId,
}
const ownerBinding: HostedControlOwnerBinding = {
  ownerAuthority: 'owner-authority_test', ownerGeneration: 1,
  ownerSessionId: 'owner-session_test',
  socketIdentity: { device: '1', inode: '2', uid: 1, gid: 1, mode: 0o600 },
}
const taskSnapshot: HostedAgentTaskSnapshot = {
  teamId, taskId, ownerId: memberId, status: 'pending',
  sourceGeneration: 'generation_test', revision: 'revision_test',
  task: { id: taskId, subject: 'Sandbox task' },
}

function fixture(snapshot: HostedAgentTaskSnapshot | null = taskSnapshot) {
  const mutations: HostedTaskMutationRequest[] = []
  const comments: Array<{ memberId: string; taskId: string; text: string; callID: string }> = []
  const messages: Array<{ memberId: string; to: string; text: string; callID: string }> = []
  const executors = createHostedAgentToolExecutors({
    binding, authority, ownerBinding,
    taskService: { mutate: async request => {
      mutations.push(request)
      return { kind: 'committed', currentSourceGeneration: 'generation_test',
        payloadFingerprint: request.payload.payloadFingerprint,
        receipt: { schemaVersion: 1, outcome: 'committed', commandId: request.payload.command.commandId,
          teamId, sourceGeneration: 'generation_test', revision: 'revision_next', affectedTaskIds: [taskId] } }
    } },
    taskReader: { getTask: async () => snapshot },
    comments: { addComment: async call => {
      comments.push({ memberId: call.binding.memberId, taskId: call.taskId,
        text: call.text, callID: call.callID })
      return 'comment-created'
    } },
    messages: { send: async call => {
      messages.push({ memberId: call.binding.memberId, to: call.to,
        text: call.text, callID: call.callID })
      return 'message-sent'
    } },
  })
  const call = { binding, taskId, callID: 'call_test', signal: new AbortController().signal }
  return { executors, mutations, comments, messages, call }
}

describe('HostedAgentToolExecutors', () => {
  test('reads and mutates only a task assigned to the exact Owner member', async () => {
    const { executors, mutations, call } = fixture()
    expect(JSON.parse(await executors.hosted_task_get(call))).toEqual(taskSnapshot)
    const started = JSON.parse(await executors.hosted_task_start(call))
    expect(started.kind).toBe('committed')
    expect(mutations).toHaveLength(1)
    expect(mutations[0]?.authority.actorId).toBe(memberId)
    expect(mutations[0]?.payload.command).toMatchObject({
      kind: 'update_status', taskId, teamId, status: 'in_progress',
      expectedSourceGeneration: 'generation_test', expectedRevision: 'revision_test',
    })
    expect(mutations[0]?.payload.payloadFingerprint).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  test('completes an in-progress task, and writes comments/messages with bound sender', async () => {
    const f = fixture({ ...taskSnapshot, status: 'in_progress' })
    await f.executors.hosted_task_complete(f.call)
    expect(f.mutations[0]?.payload.command).toMatchObject({ kind: 'update_status', status: 'completed' })
    expect(await f.executors.hosted_task_add_comment({ ...f.call, text: 'Result' })).toBe('comment-created')
    expect(f.comments).toEqual([{ memberId, taskId, text: 'Result', callID: 'call_test' }])
    expect(await f.executors.hosted_message_send({ binding, to: 'team-lead', text: 'Done',
      taskRefs: [], callID: 'call_test', signal: f.call.signal })).toBe('message-sent')
    expect(f.messages).toEqual([{ memberId, to: 'team-lead', text: 'Done', callID: 'call_test' }])
  })

  test('wrong member, run, task, and status never reach an effect', async () => {
    const foreign = fixture({ ...taskSnapshot, ownerId: `member_${'f'.repeat(32)}` })
    await expect(foreign.executors.hosted_task_start(foreign.call)).rejects.toThrow()
    await expect(foreign.executors.hosted_task_add_comment({ ...foreign.call, text: 'No' })).rejects.toThrow()
    expect(foreign.mutations).toHaveLength(0)
    expect(foreign.comments).toHaveLength(0)

    const f = fixture()
    for (const changed of [
      { binding: { ...binding, memberId: `member_${'f'.repeat(32)}` } },
      { binding: { ...binding, runId: 'run_other' } },
      { taskId: `task_${'f'.repeat(32)}` },
    ]) await expect(f.executors.hosted_task_get({ ...f.call, ...changed })).rejects.toThrow()
    await expect(f.executors.hosted_message_send({ binding: { ...binding, runId: 'run_other' },
      to: 'team-lead', text: 'No', taskRefs: [], callID: 'call_test', signal: f.call.signal })).rejects.toThrow()
    await expect(f.executors.hosted_message_send({ binding, to: 'team-lead', text: 'No',
      taskRefs: [{ teamName: 'sandbox', taskId: `task_${'f'.repeat(32)}` }],
      callID: 'call_test', signal: f.call.signal })).rejects.toThrow()
    await expect(f.executors.hosted_task_complete(f.call)).rejects.toThrow()
    expect(f.mutations).toHaveLength(0)
    expect(f.messages).toHaveLength(0)
  })

  test('rejects an executor composed with an actor different from the admitted member', () => {
    expect(() => createHostedAgentToolExecutors({
      binding, authority: { ...authority, actorId: 'user' }, ownerBinding,
      taskService: { mutate: async () => ({ kind: 'not_found' }) },
      taskReader: { getTask: async () => taskSnapshot },
      comments: { addComment: async () => '' }, messages: { send: async () => '' },
    })).toThrow('authority mismatch')
  })

  test('a real task mutation crash after task publication stays ambiguous', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'hosted-agent-tool-crash-')))
    try {
      await chmod(root, 0o700)
      const legacyKey = 'sandbox'
      const teamRoot = join(root, 'teams', legacyKey)
      const taskRoot = join(root, 'tasks', legacyKey)
      await mkdir(teamRoot, { recursive: true })
      await mkdir(taskRoot, { recursive: true })
      await writeFile(join(teamRoot, 'config.json'), JSON.stringify({
        name: legacyKey, members: [{ name: 'worker', memberId }],
      }))
      const rawId = 'hosted-crash-test'
      const publicId = `task_${createHash('sha256').update(JSON.stringify({
        domain: 'hosted-task-board-task/v1', teamId, rawTaskId: rawId,
      })).digest('hex').slice(0, 32)}`
      const taskPath = join(taskRoot, `${rawId}.json`)
      await writeFile(taskPath, JSON.stringify({ id: rawId, subject: 'Crash test', status: 'pending',
        owner: memberId, blocks: [], blockedBy: [] }))
      const serviceOptions = { claudeRoot: root, legacyKey, authority: {
        deploymentId: authority.deploymentId, bootId: authority.bootId,
        restoreGeneration: authority.restoreGeneration, workspaceId: authority.workspaceId,
        mountBinding: authority.mountBinding, teamId,
      }, wal: new HostedTaskMutationWal(teamRoot, teamId) }
      const probe = new HostedTaskMutationService(serviceOptions)
      const command: HostedTaskMutationCommand = { schemaVersion: 1, kind: 'update_status',
        commandId: 'command_probe', idempotencyKey: 'probe', teamId,
        expectedSourceGeneration: 'generation_stale', expectedRevision: 'revision_stale',
        taskId: publicId, status: 'in_progress' }
      const request = (current: HostedTaskMutationCommand): HostedTaskMutationRequest => ({
        schemaVersion: 2, exchangeId: `task-request_${'f'.repeat(32)}`, operation: 'task_mutate',
        ownerBinding, authority, payload: { command: current,
          payloadFingerprint: fingerprintHostedTaskCommand(current) }, ownerProof: '',
      })
      const generation = await probe.mutate(request(command))
      if (generation.kind !== 'stale_generation') throw new Error('Expected source generation')
      const revision = await probe.mutate(request({ ...command,
        expectedSourceGeneration: generation.currentSourceGeneration }))
      if (revision.kind !== 'stale_revision') throw new Error('Expected board revision')
      let crashed = false
      const crashing = new HostedTaskMutationService({ ...serviceOptions,
        crashHook: stage => { if (stage === 'after_task_write') {
          crashed = true
          throw new Error('Simulated crash after task write')
        } },
      })
      const currentBinding = { ...binding, workspaceRoot: root }
      const executors = createHostedAgentToolExecutors({
        binding: currentBinding, authority, ownerBinding, taskService: crashing,
        taskReader: { getTask: async () => ({ ...taskSnapshot, taskId: publicId,
          sourceGeneration: generation.currentSourceGeneration, revision: revision.currentRevision }) },
        comments: { addComment: async () => { throw new Error('Unexpected comment') } },
        messages: { send: async () => { throw new Error('Unexpected message') } },
      })
      const server = createServer()
      server.listen(join(root, 'fd3.sock'))
      await once(server, 'listening')
      const accepted = new Promise<Socket>(resolve => server.once('connection', resolve))
      const peer = connect(join(root, 'fd3.sock'))
      await once(peer, 'connect')
      const owner = await accepted
      const agentWal = new HostedAgentToolWal(join(root, 'agent-tools'))
      const receiver = new HostedAgentToolReceiver({ socket: owner,
        binding: currentBinding, teamName: 'sandbox', gate: new HostedAgentToolEffectGate(),
        wal: agentWal, isCurrent: () => true, canSendTo: () => true, executors })
      try {
        const call = { version: 1 as const, type: 'request' as const, requestId: randomUUID(),
          tool: 'hosted_task_start' as const,
          context: { sessionID: currentBinding.sessionID, messageID: 'message_crash', callID: 'crash_call' },
          args: { taskId: publicId } }
        const bytes = Buffer.from(JSON.stringify(call))
        const frame = Buffer.allocUnsafe(bytes.length + 4)
        frame.writeUInt32BE(bytes.length, 0)
        bytes.copy(frame, 4)
        const response = new Promise<Record<string, unknown>>((resolve, reject) => {
          let incoming = Buffer.alloc(0)
          const onData = (chunk: Buffer) => {
            incoming = Buffer.concat([incoming, chunk])
            if (incoming.length < 4 || incoming.length < incoming.readUInt32BE(0) + 4) return
            peer.off('data', onData)
            try { resolve(JSON.parse(incoming.subarray(4, 4 + incoming.readUInt32BE(0)).toString('utf8'))) }
            catch (error) { reject(error) }
          }
          peer.on('data', onData)
          peer.once('error', reject)
        })
        peer.write(frame)
        expect(await response).toMatchObject({ ok: false, error: 'operator_required' })
        expect(await agentWal.begin({ binding: currentBinding,
          request: decodeHostedAgentToolRequest(JSON.stringify(call)) }))
          .toEqual({ kind: 'operator_required' })
      } finally {
        receiver.close()
        peer.destroy()
        await new Promise<void>(resolve => server.close(() => resolve()))
      }
      expect(crashed).toBe(true)
      expect(JSON.parse(await readFile(taskPath, 'utf8')).status).toBe('in_progress')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
