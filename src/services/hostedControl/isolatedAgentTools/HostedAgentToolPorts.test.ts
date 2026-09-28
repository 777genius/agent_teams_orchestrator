import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { HostedTaskMutationService } from '../HostedTaskMutationService.js'
import { HostedTaskMutationWal } from '../HostedTaskMutationWal.js'
import { createHostedAgentToolExecutors } from '../agentTools/HostedAgentToolExecutors.js'
import type { HostedAgentToolBinding } from '../agentTools/HostedAgentToolWal.js'
import { hostedMemberAttempt } from '../hostedLaneSession/HostedMemberSessionBridge.js'
import { HostedAgentPeerMailboxPort, HostedAgentSessionRecipientWakePort, HostedAgentTaskCommentFilePort, HostedAgentTaskReaderPort,
  type HostedAgentRecipientWakePort } from './HostedAgentToolPorts.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

const binding: HostedAgentToolBinding = {
  workspaceId: 'workspace', teamId: `team_${'1'.repeat(32)}`, workspaceRoot: '/sandbox/workspace',
  planGeneration: 'plan_1', runId: 'run_1', laneId: 'lane_1', memberId: `member_${'2'.repeat(32)}`,
  memberName: 'worker', sessionID: 'session_1',
}
const peerRecipient = { teamId: binding.teamId, runId: binding.runId,
  laneId: 'lane_peer', memberId: `member_${'3'.repeat(32)}`, memberName: 'peer' }

async function fixture() {
  const root = await realpath(await mkdtemp('/tmp/agent-tool-'))
  roots.push(root)
  const teamRoot = join(root, 'teams', 'sandbox')
  const taskRoot = join(root, 'tasks', 'sandbox')
  await mkdir(teamRoot, { recursive: true, mode: 0o700 })
  await mkdir(taskRoot, { recursive: true, mode: 0o700 })
  await writeFile(join(teamRoot, 'config.json'), JSON.stringify({ members: [
    { name: 'worker', memberId: binding.memberId, joinedAt: 1 },
    { name: 'peer', memberId: `member_${'3'.repeat(32)}`, joinedAt: 2 },
  ] }))
  const rawTaskId = 'example'
  const taskId = `task_${createHash('sha256').update(JSON.stringify({ domain: 'hosted-task-board-task/v1',
    teamId: binding.teamId, rawTaskId })).digest('hex').slice(0, 32)}`
  await writeFile(join(taskRoot, `${rawTaskId}.json`), JSON.stringify({ id: rawTaskId,
    subject: 'sandbox task', owner: binding.memberId, status: 'pending', blocks: [], blockedBy: [] }))
  const authority = { actorId: binding.memberId, deploymentId: 'deployment', bootId: 'boot',
    restoreGeneration: 1, workspaceId: binding.workspaceId, teamId: binding.teamId,
    mountBinding: { mountGeneration: 1, declaredRootHash: 'a'.repeat(64) } }
  const service = new HostedTaskMutationService({ claudeRoot: root, legacyKey: 'sandbox',
    authority, wal: new HostedTaskMutationWal(teamRoot, binding.teamId) })
  return { root, teamRoot, taskRoot, taskId, service, authority }
}

describe('concrete Owner agent tool ports', () => {
  test('starts and completes only its assigned sandbox task via canonical mutation service', async () => {
    const f = await fixture()
    const reader = new HostedAgentTaskReaderPort(f.service)
    const executors = createHostedAgentToolExecutors({ binding, authority: f.authority,
      testOnlyAllowOwnerLocalEffects: true,
      ownerBinding: { ownerAuthority: 'owner_authority1', ownerGeneration: 1,
        ownerSessionId: `owner_session_${'d'.repeat(32)}`,
        socketIdentity: { device: '1', inode: '2', uid: 501, gid: 20, mode: 0o600 } },
      taskService: f.service, taskReader: reader,
      comments: { addComment: async () => { throw new Error('unexpected comment') } },
      messages: { send: async () => { throw new Error('unexpected message') } },
    })
    const signal = new AbortController().signal
    expect(JSON.parse(await executors.hosted_task_start({ binding, taskId: f.taskId, callID: 'call_start', signal })).kind)
      .toBe('committed')
    expect(JSON.parse(await executors.hosted_task_complete({ binding, taskId: f.taskId, callID: 'call_complete', signal })).kind)
      .toBe('committed')
    const task = JSON.parse(await readFile(join(f.taskRoot, 'example.json'), 'utf8')) as { status: string; owner: string }
    expect(task).toMatchObject({ status: 'completed', owner: binding.memberId })
  })

  test('reads canonical task revision only for the active immutable owner', async () => {
    const f = await fixture()
    const reader = new HostedAgentTaskReaderPort(f.service)
    const signal = new AbortController().signal
    const snapshot = await reader.getTask({ binding, taskId: f.taskId, signal })
    expect(snapshot?.ownerId).toBe(binding.memberId)
    expect(snapshot?.sourceGeneration).toStartWith('generation_')
    expect(snapshot?.revision).toStartWith('revision_')
    expect(await reader.getTask({ binding: { ...binding, memberId: `member_${'3'.repeat(32)}` },
      taskId: f.taskId, signal })).toBeNull()
    await writeFile(join(f.teamRoot, 'config.json'), JSON.stringify({ members: [
      { name: 'worker', memberId: binding.memberId, joinedAt: 1, removedAt: 2 },
    ] }))
    expect(await reader.getTask({ binding, taskId: f.taskId, signal })).toBeNull()
  })

  test('appends one immutable comment per member call without changing task JSON', async () => {
    const f = await fixture()
    const before = await readFile(join(f.taskRoot, 'example.json'), 'utf8')
    const baseReader = new HostedAgentTaskReaderPort(f.service)
    const port = new HostedAgentTaskCommentFilePort(join(f.teamRoot, 'comments'), binding.teamId, baseReader)
    const input = { binding, taskId: f.taskId, text: 'Result', callID: 'call_1', signal: new AbortController().signal }
    const first = await port.addComment(input)
    expect(await port.addComment(input)).toBe(first)
    await expect(port.addComment({ ...input, text: 'Different' })).rejects.toThrow('conflict')
    expect(await readFile(join(f.taskRoot, 'example.json'), 'utf8')).toBe(before)
    const richReader = new HostedAgentTaskReaderPort(f.service, port)
    const snapshot = await richReader.getTask({ binding, taskId: f.taskId, signal: input.signal })
    const comments = snapshot?.task.hostedComments as Array<{ commentId: string; text: string;
      sourceGeneration: string; authorId: string }> | undefined
    expect(comments).toHaveLength(1)
    expect(comments?.[0]).toMatchObject({ text: 'Result', authorId: binding.memberId,
      sourceGeneration: snapshot?.sourceGeneration })
    expect(comments?.[0]?.commentId).toStartWith('comment_')
  })

  test('keeps task_get below FD3 budget with bounded comment page and unrelated global history', async () => {
    const f = await fixture()
    const baseReader = new HostedAgentTaskReaderPort(f.service)
    const directory = join(f.teamRoot, 'comments')
    const port = new HostedAgentTaskCommentFilePort(directory, binding.teamId, baseReader)
    const signal = new AbortController().signal
    for (let index = 0; index < 4; index++) await port.addComment({ binding, taskId: f.taskId,
      text: `comment-${index}-${'x'.repeat(19_000)}`, callID: `call_comment_${index}`, signal })
    for (let index = 0; index < 513; index++) await writeFile(join(directory,
      `${index.toString(16).padStart(64, '0')}.comment.v1.json`), '{}')
    const snapshot = await new HostedAgentTaskReaderPort(f.service, port).getTask({ binding, taskId: f.taskId, signal })
    expect(Buffer.byteLength(JSON.stringify(snapshot), 'utf8')).toBeLessThan(64 * 1024)
    expect(snapshot?.task.hostedCommentTotalCount).toBe(4)
    expect(snapshot?.task.hostedCommentsTruncated).toBe(true)
    expect((snapshot?.task.hostedComments as unknown[]).length).toBeLessThan(4)
  })

  test('budgets the escaped outer FD3 frame and rejects oversized durable records before append', async () => {
    const f = await fixture()
    const baseReader = new HostedAgentTaskReaderPort(f.service)
    const port = new HostedAgentTaskCommentFilePort(join(f.teamRoot, 'comments'), binding.teamId, baseReader)
    const signal = new AbortController().signal
    for (let index = 0; index < 2; index++) await port.addComment({ binding, taskId: f.taskId,
      text: '"'.repeat(11_500), callID: `quote_${index}`, signal })
    await expect(port.addComment({ binding, taskId: f.taskId,
      text: '"'.repeat(20_000), callID: 'oversized_quote', signal })).rejects.toThrow('record budget')
    const snapshot = await new HostedAgentTaskReaderPort(f.service, port).getTask({ binding, taskId: f.taskId, signal })
    const result = JSON.stringify(snapshot)
    const outer = JSON.stringify({ version: 1, type: 'response',
      requestId: '00000000-0000-4000-8000-000000000000', ok: true, result })
    expect(Buffer.byteLength(outer, 'utf8')).toBeLessThanOrEqual(64 * 1024)
    expect(snapshot?.task.hostedCommentTotalCount).toBe(2)
    expect(snapshot?.task.hostedCommentsTruncated).toBe(true)
  })

  test('delivers to the peer mailbox and requires a real wake acknowledgement', async () => {
    const f = await fixture()
    const woke: string[] = []
    const port = new HostedAgentPeerMailboxPort(f.teamRoot, { wake: async input => {
      expect(input.envelope.text).toBe('Ready')
      woke.push(input.recipient.memberName)
    } }, [peerRecipient])
    const input = { binding, to: 'peer', text: 'Ready', taskRefs: [] as const,
      callID: 'call_2', signal: new AbortController().signal }
    const first = JSON.parse(await port.send(input)) as { messageId: string }
    await port.send(input)
    const inbox = JSON.parse(await readFile(join(f.teamRoot, 'inboxes', 'peer.json'), 'utf8')) as Array<{ messageId: string; from: string }>
    expect(inbox).toHaveLength(1)
    expect(inbox[0]).toMatchObject({ messageId: first.messageId, from: 'worker' })
    expect(woke).toEqual(['peer', 'peer'])
    const failedWake = new HostedAgentPeerMailboxPort(f.teamRoot,
      { wake: async () => { throw new Error('no wake') } }, [peerRecipient])
    await expect(failedWake.send({ ...input, callID: 'call_3' })).rejects.toThrow('no wake')
  })

  test('session wake binds the admitted recipient and requires delivery receipt', async () => {
    const attempt = hostedMemberAttempt({ teamId: binding.teamId, runId: binding.runId,
      laneId: 'lane_peer', memberId: `member_${'3'.repeat(32)}`, memberName: 'peer',
      model: 'test-model', promptSha256: 'a'.repeat(64), planFingerprint: 'b'.repeat(64),
      containerHandle: `opencode_${'c'.repeat(32)}`, containerGeneration: 'd'.repeat(32) })
    const deliveries: string[] = []
    const wake = new HostedAgentSessionRecipientWakePort({ deliver: async delivery => {
      deliveries.push(delivery.text)
      return 'delivered'
    } }, () => attempt)
    const f = await fixture()
    let captured: Parameters<HostedAgentRecipientWakePort['wake']>[0] | null = null
    const port = new HostedAgentPeerMailboxPort(f.teamRoot, { wake: async input => {
      captured = input
      await wake.wake(input)
    } }, [peerRecipient])
    await port.send({ binding, to: 'peer', text: 'Full durable body', taskRefs: [],
      callID: 'call_wake', signal: new AbortController().signal })
    expect(deliveries[0]).toContain('Full durable body')
    expect(deliveries[0]).toContain('sha256:')
    if (!captured) throw new Error('missing verified wake')
    await expect(wake.wake({ ...captured,
      envelope: { ...captured.envelope, text: 'Substituted body' },
    })).rejects.toThrow('envelope mismatch')
    const replaced = hostedMemberAttempt({ teamId: binding.teamId, runId: binding.runId,
      laneId: 'lane_peer', memberId: `member_${'4'.repeat(32)}`, memberName: 'peer',
      model: 'test-model', promptSha256: 'a'.repeat(64), planFingerprint: 'b'.repeat(64),
      containerHandle: `opencode_${'c'.repeat(32)}`, containerGeneration: 'd'.repeat(32) })
    const unsafeWake = new HostedAgentSessionRecipientWakePort({ deliver: async () => 'delivered' }, () => replaced)
    const unsafePort = new HostedAgentPeerMailboxPort(f.teamRoot, unsafeWake, [peerRecipient])
    await expect(unsafePort.send({ binding, to: 'peer', text: 'Wrong incarnation', taskRefs: [],
      callID: 'call_replaced', signal: new AbortController().signal })).rejects.toThrow('unavailable')
  })
})
