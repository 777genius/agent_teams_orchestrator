import { expect, test } from 'bun:test'
import { createV2ProtocolQueueIntent } from './OpenCodeV2TeamBridge.js'
import { assertOpenCodeV2GroupBinding, buildOpenCodeV2GroupProof, parseOpenCodeV2GroupDelivery } from './OpenCodeV2GroupChat.js'
import { parseRunControlRequest } from './OpenCodeV2RunControl.js'
import type { RunMemberStatus } from './OpenCodeV2RunTypes.js'
import type { ControllerToolProof } from './OpenCodeV2ControllerTools.js'
const binding = { teamId: 'TEST-team', runId: 'TEST-run' }
const member = { memberId: 'kimi', laneId: 'secondary:kimi', originalSessionId: 'ses_TEST',
  opencodeSessionId: 'ses_TEST', runtimeSessionId: 'ses_TEST', runtimePid: 123, state: 'accepted',
  bootstrap: { verified: true, strategy: 'instruction-entry', missingNativeMessageID: true } } as RunMemberStatus
const tools = { server: 'agent-teams', schemasHash: 'a'.repeat(64), tools: ['group_chat_list','group_chat_send'].map(name => ({ name, inputSchema: {} })) } as ControllerToolProof
const canonical = '22222222-2222-4222-8222-222222222222'
const physical = canonical + ':g:12345678'
function envelope() { return { schemaVersion: 1 as const, requestId: 'TEST-request', command: 'opencode.sendMessage' as const, cwd: '/TEST',
  startedAt: new Date().toISOString(), timeoutMs: 8000, body: { ...binding, teamName: binding.teamId,
    memberName: 'kimi', laneId: member.laneId, runtimeSessionId: member.originalSessionId,
    deliveryAttemptId: 'TEST-attempt', messageId: physical, text: 'TEST group task',
    groupChatId: '11111111-1111-4111-8111-111111111111', groupMessageId: canonical, groupChatProtocolVersion: 1,
    groupRunKey: binding.runId, from: 'user', timestamp: new Date().toISOString(), relayOfMessageId: 'TEST-parent' } } }
test('group queue preserves the canonical envelope and physical relay across durable control parsing', () => {
  const request = envelope(), proof = buildOpenCodeV2GroupProof(binding, member, tools)!
  const intent = createV2ProtocolQueueIntent(request, proof)
  expect(intent.group).toMatchObject({ groupMessageId: canonical, groupRunKey: binding.runId, from: 'user', relayOfMessageId: 'TEST-parent' })
  expect(intent.identity.localMessageId).toBe(physical)
  expect(intent.input.text).toContain('queued GROUP CHAT message')
  expect(intent.input.text).toContain(physical)
  expect(intent.input.text).toContain('group_chat_send')
  expect(intent.input.text).toContain('TEST-parent')
  expect(parseRunControlRequest({ operation: 'send', memberId: 'kimi', originalSessionId: 'ses_TEST', intent })).toEqual({ operation: 'send', memberId: 'kimi', originalSessionId: 'ses_TEST', intent })
})
test('forged, incomplete and cross-run group deliveries fail before a queue intent exists', () => {
  const proof = buildOpenCodeV2GroupProof(binding, member, tools)!
  for (const change of [{ groupChatId: undefined }, { from: undefined }, { timestamp: 'invalid' },
    { groupChatProtocolVersion: 2 }, { groupRunKey: 'other' }, { messageId: canonical },
    { laneId: 'other' }, { runtimeSessionId: 'ses_other' }])
    expect(() => createV2ProtocolQueueIntent({ ...envelope(), body: { ...envelope().body, ...change } }, proof)).toThrow()
  expect(() => createV2ProtocolQueueIntent(envelope())).toThrow('GROUP_RECIPIENT_INCOMPATIBLE')
  const group = parseOpenCodeV2GroupDelivery(envelope().body, physical)!
  for (const change of [{ runId: 'other' }, { laneId: 'other' }, { runtimePid: 456 }, { runtimeSessionId: 'ses_other' }])
    expect(() => assertOpenCodeV2GroupBinding(group, binding, { ...proof, ...change }, member)).toThrow()
  expect(() => buildOpenCodeV2GroupProof(binding, { ...member, bootstrap: null }, tools)).toThrow()
  expect(buildOpenCodeV2GroupProof(binding, member, { ...tools, tools: [] })).toBeNull()
})
