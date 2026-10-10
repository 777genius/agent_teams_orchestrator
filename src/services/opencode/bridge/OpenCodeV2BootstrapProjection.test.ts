import { expect, test } from 'bun:test'
import { verifyOpenCodeV2SilentBootstrap } from './OpenCodeV2BootstrapProjection.js'
import type { ExecutionLog, ExecutionMessagePage } from '../transport/OpenCodeV2ExecutionClientFactory.js'
const messages: ExecutionMessagePage = { data: [], previous: null, next: null }
const log: ExecutionLog = { events: [], synced: true, watermark: null }
const base = { before: { messages, log }, after: { messages, log }, key: 'agent-teams.context',
  value: { context: 'TEST-briefing' }, entries: [{ key: 'agent-teams.context', value: { context: 'TEST-briefing' } }] }
test('native durable entry verifies without a model turn or manufactured messageID', () => {
  expect(() => verifyOpenCodeV2SilentBootstrap(base)).not.toThrow()
  const instructions: ExecutionLog = { events: [{ id: 'evt_TEST1', type: 'session.instructions.updated', aggregateID: 'ses_TEST',
    seq: 1, data: { sessionID: 'ses_TEST', delta: {} } }], synced: true, watermark: 1 }
  expect(() => verifyOpenCodeV2SilentBootstrap({ ...base, after: { messages, log: instructions } })).not.toThrow()
})
test('silent bootstrap cannot adopt a foreign key or changed context', () => {
  expect(() => verifyOpenCodeV2SilentBootstrap({ ...base, entries: [{ key: 'other.key', value: base.value }] })).toThrow('run_bootstrap_unknown')
  expect(() => verifyOpenCodeV2SilentBootstrap({ ...base, entries: [{ key: base.key, value: { context: 'foreign' } }] })).toThrow('run_bootstrap_unknown')
})
test('execution or assistant/tool transcript changes cannot be classified as silent bootstrap', () => {
  const execution: ExecutionLog = { events: [{ id: 'evt_TEST1', type: 'session.execution.started', aggregateID: 'ses_TEST',
    seq: 1, data: { sessionID: 'ses_TEST' } }], synced: true, watermark: 1 }
  expect(() => verifyOpenCodeV2SilentBootstrap({ ...base, after: { messages, log: execution } })).toThrow('run_bootstrap_model_turn')
  const assistant: ExecutionMessagePage = { ...messages, data: [{ id: 'msg_TEST1', type: 'assistant', timeCreated: 1, data: {} }] }
  expect(() => verifyOpenCodeV2SilentBootstrap({ ...base, after: { messages: assistant, log } })).toThrow('run_bootstrap_model_turn')
})
