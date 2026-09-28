import { createHash } from 'node:crypto'
import { expect, test } from 'bun:test'

import { hostedMemberAttempt, type HostedMemberDelivery } from
  '../hostedLaneSession/HostedMemberSessionBridge.js'
import type { RootOpenCodeAction, RootOpenCodeActionResult } from
  '../openCodeRootHttpProxy/RootOpenCodeHttpProxy.js'
import { RootMediatedOpenCodeMemberSessionPort } from './RootMediatedOpenCodeMemberSessionPort.js'

const prompt = 'Test-only canonical prompt.'
const attempt = hostedMemberAttempt({ teamId: 'team_test', runId: `run_${'a'.repeat(32)}`,
  laneId: 'lane_test', memberId: `member_${'b'.repeat(32)}`, memberName: 'tester',
  model: 'openai/test', promptSha256: createHash('sha256').update(prompt).digest('hex'),
  planFingerprint: 'c'.repeat(64), containerHandle: `opencode_${'d'.repeat(32)}`,
  containerGeneration: 'e'.repeat(32) })
const sessionId = `ses${'f'.repeat(12)}`
const initialMessageId = `msg${'1'.repeat(12)}`
const deliveryMessageId = `msg${'2'.repeat(12)}`
const source = `message_${'3'.repeat(16)}`
const delivery: HostedMemberDelivery = { attempt, deliveryId: `wake_${source}`,
  kind: 'message', text: 'Test-only peer message.', taskId: null, taskRevision: null }

test('Owner sends only exact selectors and observes both prompt and peer delivery', async () => {
  const actions: RootOpenCodeAction[] = []
  let session: string | null = null
  let initial: string | null = null
  let delivered: string | null = null
  const root = { async sessionAction(action: RootOpenCodeAction): Promise<RootOpenCodeActionResult> {
    actions.push(action)
    if (action.kind === 'session_create') { session = sessionId
      return { outcome: 'responded', kind: 'session_create', sessionId } }
    if (action.kind === 'initial_prompt') { initial = initialMessageId
      return { outcome: 'responded', kind: 'initial_prompt', accepted: true } }
    if (action.kind === 'session_observe') return { outcome: 'responded', kind: 'session_observe',
      sessionId: session, observedInitialMessageId: initial }
    if (action.kind === 'peer_delivery') { delivered = deliveryMessageId
      return { outcome: 'responded', kind: 'peer_delivery', accepted: true } }
    if (action.kind === 'delivery_observe') return { outcome: 'responded', kind: 'delivery_observe',
      observedUserMessageId: delivered }
    return { outcome: 'responded', kind: 'reply_observe', reply: {
      assistantMessageId: `msg${'4'.repeat(12)}`, parentUserMessageId: deliveryMessageId, text: 'Observed.' } }
  } }
  const port = new RootMediatedOpenCodeMemberSessionPort(root)
  expect((await port.createSession(attempt)).state).toBe('created')
  expect((await port.submitInitial(attempt, sessionId, prompt)).state).toBe('ready')
  expect((await port.post(delivery, sessionId)).observedUserMessageId).toBe(deliveryMessageId)
  expect((await port.observeReply(delivery, sessionId, deliveryMessageId))?.text).toBe('Observed.')
  expect(actions.map(action => action.kind)).toEqual(['session_observe', 'session_create',
    'session_observe', 'initial_prompt', 'session_observe', 'session_observe', 'peer_delivery',
    'session_observe', 'delivery_observe', 'session_observe', 'delivery_observe', 'reply_observe'])
  for (const action of actions) {
    expect(Object.keys(action).sort()).toEqual(['attemptId', 'containerGeneration', 'containerHandle',
      'kind', 'memberId', 'operationId', 'runId', 'sourceRef'])
    expect(action).toMatchObject({ runId: attempt.runId, memberId: attempt.memberId,
      attemptId: attempt.attemptId, containerHandle: attempt.containerHandle,
      containerGeneration: attempt.containerGeneration })
    if (['peer_delivery', 'delivery_observe', 'reply_observe'].includes(action.kind)) {
      expect(action.sourceRef).toBe(source)
    } else expect(action.sourceRef).toBeNull()
  }
  expect(JSON.stringify(actions)).not.toContain(prompt)
  expect(JSON.stringify(actions)).not.toContain(delivery.text)
})

test('bad prompt, swapped session and uncommitted peer source send no write selector', async () => {
  const kinds: string[] = []
  const root = { async sessionAction(action: RootOpenCodeAction): Promise<RootOpenCodeActionResult> {
    kinds.push(action.kind)
    return { outcome: 'responded', kind: 'session_observe',
      sessionId, observedInitialMessageId: initialMessageId }
  } }
  const port = new RootMediatedOpenCodeMemberSessionPort(root)
  await expect(port.submitInitial(attempt, sessionId, 'forged')).rejects.toThrow('initial-invalid')
  expect(kinds).toEqual([])
  await expect(port.post(delivery, `ses${'9'.repeat(12)}`)).rejects.toThrow('binding-invalid')
  expect(kinds).toEqual(['session_observe'])
  await expect(port.post({ ...delivery, deliveryId: 'delivery_uncommitted' }, sessionId))
    .rejects.toThrow('source-invalid')
  expect(kinds).toEqual(['session_observe'])
})

test('ambiguous root write does not get a success receipt or retry', async () => {
  const kinds: string[] = []
  const port = new RootMediatedOpenCodeMemberSessionPort({ async sessionAction(action) {
    kinds.push(action.kind)
    return action.kind === 'session_observe'
      ? { outcome: 'responded' as const, kind: 'session_observe' as const,
        sessionId: null, observedInitialMessageId: null }
      : { outcome: 'uncertain' as const }
  } })
  await expect(port.createSession(attempt)).rejects.toThrow('create-unconfirmed')
  expect(kinds).toEqual(['session_observe', 'session_create'])
})

test('two revisions of one task cannot inherit the same delivery receipt', async () => {
  const actions: RootOpenCodeAction[] = []
  const port = new RootMediatedOpenCodeMemberSessionPort({ async sessionAction(action) {
    actions.push(action)
    // This would falsely acknowledge both revisions if the port used taskId
    // alone as its source selector.
    return action.kind === 'delivery_observe'
      ? { outcome: 'responded' as const, kind: 'delivery_observe' as const,
        observedUserMessageId: deliveryMessageId }
      : { outcome: 'responded' as const, kind: 'session_observe' as const,
        sessionId, observedInitialMessageId: initialMessageId }
  } })
  const task = { ...delivery, kind: 'task' as const, taskId: `task_${'5'.repeat(16)}`,
    deliveryId: 'delivery_task_12345678', taskRevision: 'revision_11111111' }
  const revised = { ...task, taskRevision: 'revision_22222222' }
  for (const version of [task, revised]) {
    await expect(port.post(version, sessionId)).rejects.toThrow('task-revision-unbound')
    await expect(port.observeDelivery(version, sessionId)).rejects.toThrow('task-revision-unbound')
    await expect(port.observeReply(version, sessionId, deliveryMessageId))
      .rejects.toThrow('task-revision-unbound')
  }
  expect(actions).toEqual([])
})
