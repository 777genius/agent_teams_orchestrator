import { createHash } from 'node:crypto'

import type { HostedTaskMutationService } from '../HostedTaskMutationService.js'
import {
  fingerprintHostedTaskCommand,
  type HostedControlAuthority,
  type HostedControlOwnerBinding,
  type HostedTaskMutationCommand,
} from '../protocol.js'
import type { HostedAgentToolExecutors, HostedAgentTaskCall } from './HostedAgentToolReceiver.js'
import type { HostedAgentToolBinding } from './HostedAgentToolWal.js'
import { INACTIVE_HOSTED_AGENT_PRODUCT_EFFECT_WRITER,
  type HostedAgentProductEffectWriter, type HostedAgentProductRecipientPin,
  type HostedAgentProductTaskPin } from '../isolatedAgentTools/HostedAgentProductEffectWriter.js'

export type HostedAgentTaskSnapshot = Readonly<{
  teamId: string
  taskId: string
  ownerId: string | null
  status: 'pending' | 'in_progress' | 'completed'
  sourceGeneration: string
  revision: string
  task: Readonly<Record<string, unknown>>
}>

/** The implementation must read one canonical Owner board snapshot, including its revision. */
export interface HostedAgentTaskReader {
  getTask(input: Readonly<{ binding: Readonly<HostedAgentToolBinding>; taskId: string; signal: AbortSignal }>):
    Promise<HostedAgentTaskSnapshot | null>
}

/** Comment writes must be durable and idempotent by the Owner-bound call ID. */
export interface HostedAgentTaskCommentWriter {
  addComment(input: Readonly<{
    binding: Readonly<HostedAgentToolBinding>
    taskId: string
    text: string
    callID: string
    signal: AbortSignal
  }>): Promise<string>
}

/** The mailbox implementation must derive the sender from binding.memberId. */
export interface HostedAgentTeamMessageSender {
  send(input: Readonly<{
    binding: Readonly<HostedAgentToolBinding>
    to: string
    text: string
    taskRefs: readonly { teamName: string; taskId: string }[]
    callID: string
    signal: AbortSignal
  }>): Promise<string>
}

export type HostedAgentToolExecutorOptions = Readonly<{
  binding: Readonly<HostedAgentToolBinding>
  authority: Readonly<HostedControlAuthority>
  ownerBinding: Readonly<HostedControlOwnerBinding>
  taskService: Pick<HostedTaskMutationService, 'mutate'>
  taskReader: HostedAgentTaskReader
  comments: HostedAgentTaskCommentWriter
  messages: HostedAgentTeamMessageSender
  /** Once supplied, all hosted writes go through this Product final-write port. */
  productWriter?: HostedAgentProductEffectWriter
  /** Existing Owner-local ports are executable only in explicit test fixtures. */
  testOnlyAllowOwnerLocalEffects?: true
  recipientForMessage?: (to: string, binding: Readonly<HostedAgentToolBinding>) =>
    HostedAgentProductRecipientPin | null | Promise<HostedAgentProductRecipientPin | null>
}>

/** Construct once per admitted member session. The receiver's shared gate fences all calls. */
export function createHostedAgentToolExecutors(options: HostedAgentToolExecutorOptions): HostedAgentToolExecutors {
  const expected = Object.freeze({ ...options.binding })
  const productWriter = options.productWriter ?? (options.testOnlyAllowOwnerLocalEffects &&
    process.env.NODE_ENV === 'test' ? null : INACTIVE_HOSTED_AGENT_PRODUCT_EFFECT_WRITER)
  if (!/^member_[0-9a-f]{32}$/.test(expected.memberId) ||
    options.authority.teamId !== expected.teamId ||
    options.authority.workspaceId !== expected.workspaceId ||
    options.authority.actorId !== expected.memberId) {
    throw new TypeError('Hosted agent tool executor authority mismatch')
  }

  const task = async (call: HostedAgentTaskCall): Promise<HostedAgentTaskSnapshot> => {
    assertCall(expected, call.binding, call.signal)
    const snapshot = await options.taskReader.getTask({
      binding: expected, taskId: call.taskId, signal: call.signal,
    })
    assertCall(expected, call.binding, call.signal)
    if (!snapshot || snapshot.teamId !== expected.teamId || snapshot.taskId !== call.taskId ||
      snapshot.ownerId !== expected.memberId ||
      !/^generation_[A-Za-z0-9][A-Za-z0-9._-]{0,245}$/.test(snapshot.sourceGeneration) ||
      !/^revision_[A-Za-z0-9][A-Za-z0-9._-]{0,246}$/.test(snapshot.revision) ||
      !['pending', 'in_progress', 'completed'].includes(snapshot.status) ||
      !snapshot.task || typeof snapshot.task !== 'object' || Array.isArray(snapshot.task)) {
      throw new Error('Hosted agent task is unavailable to this member')
    }
    return snapshot
  }

  const updateStatus = async (call: HostedAgentTaskCall, status: 'in_progress' | 'completed') => {
    const snapshot = await task(call)
    if (snapshot.status !== (status === 'in_progress' ? 'pending' : 'in_progress')) {
      throw new Error('Hosted agent task status transition is unavailable')
    }
    assertCall(expected, call.binding, call.signal)
    if (productWriter) {
      return productWriter.commitTaskStatus({ binding: expected, authority: options.authority,
        ownerBinding: options.ownerBinding, messageID: requiredMessageID(call.messageID),
        callID: call.callID, signal: call.signal,
        task: taskPin(snapshot), status })
    }
    const digest = createHash('sha256').update(JSON.stringify([
      'hosted-agent-task-status/v1', expected.teamId, expected.runId, expected.memberId,
      expected.sessionID, call.callID, call.taskId, status,
    ])).digest('hex')
    const command: HostedTaskMutationCommand = {
      schemaVersion: 1, kind: 'update_status', commandId: `command_${digest}`,
      idempotencyKey: `agent-tool:${digest}`, teamId: expected.teamId,
      expectedSourceGeneration: snapshot.sourceGeneration, expectedRevision: snapshot.revision,
      taskId: call.taskId, status,
    }
    const result = await options.taskService.mutate({
      schemaVersion: 2, exchangeId: `task-request_${digest.slice(0, 32)}`,
      operation: 'task_mutate', ownerBinding: options.ownerBinding,
      authority: options.authority,
      payload: { command, payloadFingerprint: fingerprintHostedTaskCommand(command) },
      // Internal Owner service invocation. The wire proof is verified at the public boundary.
      ownerProof: '',
    })
    assertCall(expected, call.binding, call.signal)
    // unavailable/unsafe_active may be returned after task bytes were published.
    // Throw so the receiver retains its WAL intent and requires operator review.
    if (result.kind !== 'committed' && result.kind !== 'idempotent_replay') {
      throw new Error(`Hosted agent task mutation is not durably committed: ${result.kind}`)
    }
    return JSON.stringify(result)
  }

  return {
    hosted_task_get: async call => JSON.stringify(await task(call)),
    hosted_task_start: call => updateStatus(call, 'in_progress'),
    hosted_task_complete: call => updateStatus(call, 'completed'),
    hosted_task_add_comment: async call => {
      const snapshot = await task(call)
      assertCall(expected, call.binding, call.signal)
      if (productWriter) return productWriter.appendTaskComment({ binding: expected,
        authority: options.authority, ownerBinding: options.ownerBinding,
        messageID: requiredMessageID(call.messageID), callID: call.callID,
        signal: call.signal, task: taskPin(snapshot), text: call.text })
      return options.comments.addComment({ binding: expected, taskId: call.taskId,
        text: call.text, callID: call.callID, signal: call.signal })
    },
    hosted_message_send: async call => {
      assertCall(expected, call.binding, call.signal)
      const taskPins: HostedAgentProductTaskPin[] = []
      for (const ref of call.taskRefs) {
        const snapshot = await task({ binding: call.binding, taskId: ref.taskId, callID: call.callID, signal: call.signal })
        taskPins.push(taskPin(snapshot))
      }
      assertCall(expected, call.binding, call.signal)
      if (productWriter) {
        const recipient = await options.recipientForMessage?.(call.to, expected)
        assertCall(expected, call.binding, call.signal)
        if (!recipient || recipient.teamId !== expected.teamId || recipient.runId !== expected.runId ||
          recipient.memberId === expected.memberId || recipient.memberName !== call.to) {
          throw new Error('Hosted Product message recipient unavailable')
        }
        return productWriter.appendPeerMessage({ binding: expected, authority: options.authority,
          ownerBinding: options.ownerBinding, messageID: requiredMessageID(call.messageID),
          callID: call.callID, signal: call.signal,
          recipient, text: call.text, taskRefs: taskPins })
      }
      return options.messages.send({ binding: expected, to: call.to, text: call.text,
        taskRefs: call.taskRefs, callID: call.callID, signal: call.signal })
    },
  }
}

function taskPin(snapshot: HostedAgentTaskSnapshot): HostedAgentProductTaskPin {
  return { taskId: snapshot.taskId, sourceGeneration: snapshot.sourceGeneration, revision: snapshot.revision }
}

function requiredMessageID(value: string | undefined): string {
  if (!value || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new Error('Hosted Product tool message identity unavailable')
  }
  return value
}

function assertCall(expected: Readonly<HostedAgentToolBinding>, actual: Readonly<HostedAgentToolBinding>, signal: AbortSignal): void {
  if (signal.aborted || expected.workspaceId !== actual.workspaceId || expected.teamId !== actual.teamId ||
    expected.workspaceRoot !== actual.workspaceRoot || expected.planGeneration !== actual.planGeneration ||
    expected.runId !== actual.runId || expected.laneId !== actual.laneId ||
    expected.memberId !== actual.memberId || expected.memberName !== actual.memberName ||
    expected.sessionID !== actual.sessionID) {
    throw new Error('Hosted agent tool member authority is no longer current')
  }
}
