import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'

import { HostedMemberSessionBridge, hostedMemberAttempt, type AuthenticatedHostedMemberSessionPort,
  type HostedMemberAttempt, type HostedMemberDelivery, type HostedMemberSessionClaims } from './HostedMemberSessionBridge.js'

const attempt = hostedMemberAttempt({
  teamId: 'team_test12345', runId: 'run_test12345', laneId: 'lane_test12345',
  memberId: `member_${'a'.repeat(32)}`, memberName: 'coder', model: 'qwen/test',
  promptSha256: createHash('sha256').update('Test prompt').digest('hex'), planFingerprint: 'b'.repeat(64),
  containerHandle: `opencode_${'c'.repeat(32)}`, containerGeneration: 'd'.repeat(32),
})
const ready = (member: HostedMemberAttempt = attempt) => ({ ...member, state: 'ready',
  sessionId: 'ses_test12345', initialMessageId: 'msg_initial12345',
  observedInitialMessageId: 'msg_initial12345' })

class FakeClaims implements HostedMemberSessionClaims {
  starts = new Map<string, string>()
  deliveries = new Map<string, string>()
  async claimStart(member: HostedMemberAttempt) {
    const previous = this.starts.get(member.attemptId)
    if (!previous) this.starts.set(member.attemptId, member.planFingerprint)
    return { created: !previous, fingerprint: previous ?? member.planFingerprint }
  }
  async claimDelivery(delivery: HostedMemberDelivery, fingerprint: string) {
    const previous = this.deliveries.get(delivery.deliveryId)
    if (!previous) this.deliveries.set(delivery.deliveryId, fingerprint)
    return { created: !previous, fingerprint: previous ?? fingerprint }
  }
  async readDelivery(deliveryId: string) {
    const fingerprint = this.deliveries.get(deliveryId)
    return fingerprint ? { fingerprint } : null
  }
}

class FakePort implements AuthenticatedHostedMemberSessionPort {
  createSession?: (member: HostedMemberAttempt) => Promise<unknown>
  submitInitial?: (member: HostedMemberAttempt, sessionId: string, prompt: string) => Promise<unknown>
  starts = 0
  posts = 0
  startReceipt: unknown = ready()
  observed: unknown = ready()
  postReceipt: unknown = { attemptId: attempt.attemptId, containerGeneration: attempt.containerGeneration,
    sessionId: 'ses_test12345', deliveryId: 'delivery_test12345', observedUserMessageId: 'msg_user12345' }
  replyReceipt: unknown = null
  async start() { this.starts++; return this.startReceipt }
  async observe() { return this.observed }
  async post() { this.posts++; return this.postReceipt }
  async observeDelivery() { return this.postReceipt }
  async observeReply() { return this.replyReceipt }
}

const delivery: HostedMemberDelivery = { attempt, deliveryId: 'delivery_test12345', kind: 'message',
  text: 'Test inbox message', taskId: null, taskRevision: null }

describe('hosted member session bridge', () => {
  test('attempt and delivery identities ignore object insertion order', async () => {
    const reversed = hostedMemberAttempt({
      containerGeneration: attempt.containerGeneration, containerHandle: attempt.containerHandle,
      planFingerprint: attempt.planFingerprint, promptSha256: attempt.promptSha256, model: attempt.model,
      memberName: attempt.memberName, memberId: attempt.memberId, laneId: attempt.laneId,
      runId: attempt.runId, teamId: attempt.teamId,
    })
    expect(reversed.attemptId).toBe(attempt.attemptId)
    const port = new FakePort()
    const bridge = new HostedMemberSessionBridge(port, new FakeClaims())
    expect(await bridge.deliver(delivery)).toBe('delivered')
    expect(await bridge.deliver({ taskRevision: null, taskId: null, text: delivery.text,
      kind: 'message', deliveryId: delivery.deliveryId, attempt: reversed })).toBe('delivered')
    expect(port.posts).toBe(1)
  })
  test('requires an observed initial prompt bound to exact member and container generation', async () => {
    const port = new FakePort()
    const bridge = new HostedMemberSessionBridge(port, new FakeClaims())
    port.observed = { ...ready(), observedInitialMessageId: null }
    expect(await bridge.observe(attempt)).toBe('failed')
    port.observed = { ...ready(), containerGeneration: 'e'.repeat(32) }
    expect(await bridge.observe(attempt)).toBe('failed')
    port.observed = { ...ready(), promptSha256: 'f'.repeat(64) }
    expect(await bridge.observe(attempt)).toBe('failed')
    port.observed = ready()
    expect(await bridge.observe(attempt)).toBe('ready')
  })

  test('durable claim prevents duplicate session start after ambiguous response', async () => {
    const port = new FakePort()
    const claims = new FakeClaims()
    port.startReceipt = { ...ready(), observedInitialMessageId: null }
    const bridge = new HostedMemberSessionBridge(port, claims)
    expect(await bridge.start(attempt, 'Test prompt')).toBe('failed')
    port.observed = ready()
    expect(await bridge.start(attempt, 'Test prompt')).toBe('ready')
    expect(port.starts).toBe(1)
    await expect(bridge.start(attempt, 'Changed prompt')).rejects.toThrow('does not match admitted plan')
  })

  test('binds and activates the exact session before the first-turn tool can run', async () => {
    const events: string[] = []
    let active = false
    const port = new FakePort()
    port.createSession = async () => { events.push('create'); return { ...attempt,
      state: 'created', sessionId: 'ses_test12345', initialMessageId: null, observedInitialMessageId: null } }
    port.submitInitial = async (_attempt, sessionId, text) => {
      events.push('prompt')
      expect(sessionId).toBe('ses_test12345')
      expect(text).toBe('Test prompt')
      // Fake first-turn tool arrives synchronously with the prompt.
      expect(active).toBe(true)
      events.push('first-tool')
      return ready()
    }
    const bridge = new HostedMemberSessionBridge(port, new FakeClaims(), async (_member, sessionId) => {
      expect(sessionId).toBe('ses_test12345')
      events.push('bind')
      active = true
      events.push('activate')
    })
    expect(await bridge.start(attempt, 'Test prompt')).toBe('ready')
    expect(events).toEqual(['create', 'bind', 'activate', 'prompt', 'first-tool'])
    expect(port.starts).toBe(0)
  })

  test('failed broker activation cannot submit the first prompt', async () => {
    const port = new FakePort()
    let prompts = 0
    port.createSession = async () => ({ ...attempt, state: 'created',
      sessionId: 'ses_test12345', initialMessageId: null, observedInitialMessageId: null })
    port.submitInitial = async () => { prompts++; return ready() }
    const bridge = new HostedMemberSessionBridge(port, new FakeClaims(), async () => {
      throw new Error('broker unavailable')
    })
    expect(await bridge.start(attempt, 'Test prompt')).toBe('failed')
    expect(prompts).toBe(0)
  })

  test('delivery observes a durable claim after an ambiguous post instead of posting again', async () => {
    const port = new FakePort()
    const bridge = new HostedMemberSessionBridge(port, new FakeClaims())
    port.postReceipt = null
    expect(await bridge.deliver(delivery)).toBe('operator_required')
    port.postReceipt = { attemptId: attempt.attemptId, containerGeneration: attempt.containerGeneration,
      sessionId: 'ses_test12345', deliveryId: delivery.deliveryId, observedUserMessageId: 'msg_user12345' }
    expect(await bridge.deliver(delivery)).toBe('delivered')
    expect(port.posts).toBe(1)
  })

  test('stale session and changed payload cannot deliver, and task needs committed revision', async () => {
    const port = new FakePort()
    const bridge = new HostedMemberSessionBridge(port, new FakeClaims())
    port.observed = { ...ready(), memberId: `member_${'f'.repeat(32)}` }
    expect(await bridge.deliver(delivery)).toBe('unavailable')
    expect(port.posts).toBe(0)
    port.observed = ready()
    expect(await bridge.deliver(delivery)).toBe('delivered')
    expect(await bridge.deliver({ ...delivery, text: 'Changed payload' })).toBe('conflict')
    await expect(bridge.deliver({ ...delivery, kind: 'task', taskId: 'task_test12345',
      taskRevision: null })).rejects.toThrow('committed task and revision')
  })

  test('peer reply requires an observed assistant message linked to the delivered prompt', async () => {
    const port = new FakePort()
    const bridge = new HostedMemberSessionBridge(port, new FakeClaims())
    expect(await bridge.deliver(delivery)).toBe('delivered')
    expect(await bridge.observeReply(delivery)).toBeNull()
    port.replyReceipt = { ...port.postReceipt as object, assistantMessageId: 'msg_assistant12345',
      parentUserMessageId: 'msg_other12345', text: 'Peer reply' }
    expect(await bridge.observeReply(delivery)).toBeNull()
    port.replyReceipt = { ...port.replyReceipt as object, parentUserMessageId: 'msg_user12345' }
    expect(await bridge.observeReply(delivery)).toMatchObject({
      assistantMessageId: 'msg_assistant12345', parentUserMessageId: 'msg_user12345', text: 'Peer reply',
    })
    expect(await bridge.observeReply({ ...delivery, text: 'Changed payload' })).toBeNull()
  })
})
