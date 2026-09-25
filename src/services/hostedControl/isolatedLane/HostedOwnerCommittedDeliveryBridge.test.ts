import { expect, test } from 'bun:test'

import { hostedMemberAttempt } from '../hostedLaneSession/HostedMemberSessionBridge.js'
import type { RootOpenCodeAction, RootOpenCodeActionResult } from
  '../openCodeRootHttpProxy/RootOpenCodeHttpProxy.js'
import { HostedOwnerCommittedDeliveryBridge, type HostedCommittedDelivery,
  type HostedCommittedDeliveryRef } from './HostedOwnerCommittedDeliveryBridge.js'

const attempt = hostedMemberAttempt({
  teamId: `team_${'a'.repeat(32)}`, runId: `run_${'b'.repeat(32)}`,
  laneId: `lane_${'c'.repeat(32)}`, memberId: `member_${'d'.repeat(32)}`,
  memberName: 'test-member', model: 'openai/test-model',
  promptSha256: 'e'.repeat(64), planFingerprint: 'f'.repeat(64),
  containerHandle: `opencode_${'1'.repeat(32)}`, containerGeneration: '2'.repeat(32),
})
const ref: HostedCommittedDeliveryRef = { kind: 'task', sourceRef: `task_${'3'.repeat(32)}` }
const committed: HostedCommittedDelivery = { ...ref, revision: `revision_${'4'.repeat(64)}`,
  runId: attempt.runId, memberId: attempt.memberId, attemptId: attempt.attemptId,
  containerHandle: attempt.containerHandle, containerGeneration: attempt.containerGeneration }
const userMessageId = 'msg_user12345'

function fixture() {
  let current: HostedCommittedDelivery | null = committed
  let observed = false
  const actions: RootOpenCodeAction[] = []
  const bridge = new HostedOwnerCommittedDeliveryBridge(attempt, {
    resolve: async () => current,
  }, {
    sessionAction: async (action): Promise<RootOpenCodeActionResult> => {
      actions.push(action)
      if (action.kind === 'task_delivery' || action.kind === 'peer_delivery') {
        observed = true
        return { outcome: 'responded', kind: action.kind, accepted: true }
      }
      if (action.kind === 'delivery_observe') return { outcome: 'responded',
        kind: action.kind, observedUserMessageId: observed ? userMessageId : null }
      if (action.kind === 'reply_observe') return { outcome: 'responded', kind: action.kind,
        reply: observed ? { assistantMessageId: 'msg_assistant12345',
          parentUserMessageId: userMessageId, text: 'Completed the task.' } : null }
      throw new Error('unexpected action')
    },
  })
  return { bridge, actions, revoke: () => { current = null },
    changeRevision: () => { current = { ...committed, revision: `revision_${'5'.repeat(64)}` } } }
}

test('dispatches only a Product-committed selector and reports observed delivery and reply', async () => {
  const f = fixture()
  expect(await f.bridge.deliver(ref)).toBe('delivered')
  expect(f.actions.map(action => action.kind)).toEqual(['task_delivery', 'delivery_observe'])
  const posted = f.actions[0]!
  expect(posted).toEqual({ operationId: expect.stringMatching(/^action_[a-f0-9]{64}$/),
    kind: 'task_delivery', runId: attempt.runId, memberId: attempt.memberId,
    attemptId: attempt.attemptId, containerHandle: attempt.containerHandle,
    containerGeneration: attempt.containerGeneration, sourceRef: ref.sourceRef })
  expect(await f.bridge.observeReply(ref)).toEqual({ sourceRef: ref.sourceRef,
    revision: committed.revision, observedUserMessageId: userMessageId,
    assistantMessageId: 'msg_assistant12345', parentUserMessageId: userMessageId,
    text: 'Completed the task.' })
})

test('rejects Owner text, foreign binding, and revoked Product reference before dispatch', async () => {
  const f = fixture()
  expect(await f.bridge.deliver({ ...ref, text: 'Owner-selected text' } as never)).toBe('unavailable')
  expect(f.actions).toHaveLength(0)
  const foreign = new HostedOwnerCommittedDeliveryBridge(attempt, {
    resolve: async () => ({ ...committed, memberId: `member_${'9'.repeat(32)}` }),
  }, { sessionAction: async () => { throw new Error('must not dispatch') } })
  expect(await foreign.deliver(ref)).toBe('unavailable')
  f.revoke()
  expect(await f.bridge.deliver(ref)).toBe('unavailable')
  expect(f.actions).toHaveLength(0)
})

test('ambiguous claim is observed, never reported as delivered without user-message evidence', async () => {
  const actions: RootOpenCodeAction[] = []
  const bridge = new HostedOwnerCommittedDeliveryBridge(attempt,
    { resolve: async () => committed }, { sessionAction: async action => {
      actions.push(action)
      return action.kind === 'task_delivery'
        ? { outcome: 'already_claimed' }
        : { outcome: 'responded', kind: 'delivery_observe', observedUserMessageId: null }
    } })
  expect(await bridge.deliver(ref)).toBe('operator_required')
  expect(actions.map(action => action.kind)).toEqual(['task_delivery', 'delivery_observe'])
  expect(await bridge.observeReply(ref)).toBeNull()
})

test('revocation between root dispatch and observation suppresses the delivery receipt', async () => {
  let current: HostedCommittedDelivery | null = committed
  const actions: RootOpenCodeAction[] = []
  const bridge = new HostedOwnerCommittedDeliveryBridge(attempt,
    { resolve: async () => current }, { sessionAction: async action => {
      actions.push(action)
      current = null
      return { outcome: 'responded', kind: 'task_delivery', accepted: true }
    } })
  expect(await bridge.deliver(ref)).toBe('operator_required')
  expect(actions.map(action => action.kind)).toEqual(['task_delivery'])
})

test('replay uses stable operation ID; revision change invalidates the old observed reply', async () => {
  const f = fixture()
  expect(await f.bridge.deliver(ref)).toBe('delivered')
  const first = f.actions[0]!.operationId
  expect(await f.bridge.deliver(ref)).toBe('delivered')
  expect(f.actions[2]!.operationId).toBe(first)
  f.changeRevision()
  f.actions.length = 0
  expect(await f.bridge.deliver(ref)).toBe('delivered')
  expect(f.actions[0]!.operationId).not.toBe(first)
  f.revoke()
  expect(await f.bridge.observeReply(ref)).toBeNull()
})

test('peer reference dispatch uses the peer kind and exact committed binding', async () => {
  const peer: HostedCommittedDeliveryRef = { kind: 'peer', sourceRef: `message_${'6'.repeat(32)}` }
  const actions: RootOpenCodeAction[] = []
  const bridge = new HostedOwnerCommittedDeliveryBridge(attempt,
    { resolve: async () => ({ ...committed, ...peer }) },
    { sessionAction: async action => {
      actions.push(action)
      return action.kind === 'peer_delivery'
        ? { outcome: 'responded', kind: 'peer_delivery', accepted: true }
        : { outcome: 'responded', kind: 'delivery_observe', observedUserMessageId: userMessageId }
    } })
  expect(await bridge.deliver(peer)).toBe('delivered')
  expect(actions.map(action => action.kind)).toEqual(['peer_delivery', 'delivery_observe'])
  expect(actions[0]!.sourceRef).toBe(peer.sourceRef)
})
