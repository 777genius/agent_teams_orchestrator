import { describe, expect, test } from 'bun:test'

import { createHostedAgentToolExecutors, type HostedAgentTaskSnapshot } from '../agentTools/HostedAgentToolExecutors.js'
import type { HostedAgentToolBinding } from '../agentTools/HostedAgentToolWal.js'
import type { HostedAgentProductEffectWriter } from './HostedAgentProductEffectWriter.js'

const binding: HostedAgentToolBinding = {
  workspaceId: 'sandbox', teamId: `team_${'a'.repeat(32)}`, workspaceRoot: '/tmp/sandbox',
  planGeneration: 'plan_sandbox', runId: 'run_sandbox', laneId: 'lane_worker',
  memberId: `member_${'b'.repeat(32)}`, memberName: 'worker', sessionID: 'session_sandbox',
}
const authority = { actorId: binding.memberId, deploymentId: 'deployment_sandbox', bootId: 'boot_sandbox',
  restoreGeneration: 1, workspaceId: binding.workspaceId, teamId: binding.teamId,
  mountBinding: { mountGeneration: 1, declaredRootHash: 'c'.repeat(64) } }
const ownerBinding = { ownerAuthority: 'owner_sandbox', ownerGeneration: 1,
  ownerSessionId: 'owner_session_sandbox', socketIdentity: { device: '1', inode: '2', uid: 1, gid: 1, mode: 0o600 } }
const taskId = `task_${'d'.repeat(32)}`
const snapshot: HostedAgentTaskSnapshot = { teamId: binding.teamId, taskId, ownerId: binding.memberId,
  status: 'pending', sourceGeneration: 'generation_sandbox', revision: 'revision_1', task: { subject: 'sandbox' } }

function setup(writer?: HostedAgentProductEffectWriter) {
  const localEffects: string[] = []
  const executors = createHostedAgentToolExecutors({ binding, authority, ownerBinding,
    taskReader: { getTask: async () => snapshot }, productWriter: writer,
    recipientForMessage: async () => ({ teamId: binding.teamId, runId: binding.runId,
      laneId: 'lane_peer', memberId: `member_${'e'.repeat(32)}`, memberName: 'peer' }),
    taskService: { mutate: async () => { localEffects.push('task'); return { kind: 'unavailable' } } },
    comments: { addComment: async () => { localEffects.push('comment'); return '' } },
    messages: { send: async () => { localEffects.push('message'); return '' } },
  })
  const signal = new AbortController().signal
  return { executors, localEffects, call: { binding, taskId,
    messageID: 'message_sandbox', callID: 'call_sandbox', signal } }
}

describe('hosted Product final-write boundary', () => {
  test('missing Product writer rejects every effect before Owner-local writers', async () => {
    const { executors, localEffects, call } = setup()
    await expect(executors.hosted_task_start(call)).rejects.toThrow('Product task writer unavailable')
    await expect(executors.hosted_task_add_comment({ ...call, text: 'result' }))
      .rejects.toThrow('Product comment writer unavailable')
    await expect(executors.hosted_message_send({ binding, to: 'peer', text: 'result', taskRefs: [],
      messageID: call.messageID, callID: call.callID, signal: call.signal }))
      .rejects.toThrow('Product message writer unavailable')
    expect(localEffects).toEqual([])
  })

  test('passes exact task, member, run and recipient pins as proposals to Product', async () => {
    const effects: unknown[] = []
    const { executors, localEffects, call } = setup({
      commitTaskStatus: async input => { effects.push(input); return 'status-committed' },
      appendTaskComment: async input => { effects.push(input); return 'comment-appended' },
      appendPeerMessage: async input => { effects.push(input); return 'message-appended' },
    })
    expect(await executors.hosted_task_start(call)).toBe('status-committed')
    expect(await executors.hosted_task_add_comment({ ...call, text: 'result' })).toBe('comment-appended')
    expect(await executors.hosted_message_send({ binding, to: 'peer', text: 'done',
      taskRefs: [{ teamName: 'sandbox', taskId }], messageID: call.messageID,
      callID: call.callID, signal: call.signal }))
      .toBe('message-appended')
    expect(effects).toHaveLength(3)
    expect(effects[0]).toMatchObject({ binding, authority, ownerBinding,
      messageID: call.messageID, callID: call.callID,
      task: { taskId, sourceGeneration: 'generation_sandbox', revision: 'revision_1' }, status: 'in_progress' })
    expect(effects[1]).toMatchObject({ binding, task: { taskId, revision: 'revision_1' }, text: 'result' })
    expect(effects[2]).toMatchObject({ binding, recipient: { teamId: binding.teamId,
      runId: binding.runId, memberId: `member_${'e'.repeat(32)}`, laneId: 'lane_peer' },
      taskRefs: [{ taskId, sourceGeneration: 'generation_sandbox', revision: 'revision_1' }], text: 'done' })
    expect(localEffects).toEqual([])
  })
})
