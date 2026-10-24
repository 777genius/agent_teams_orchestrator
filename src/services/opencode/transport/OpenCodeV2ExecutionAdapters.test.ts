import { expect, test } from 'bun:test'
import { executionCurrentOperations } from './OpenCodeV2ExecutionCurrentClient.js'
import * as FloorClient from '@opencode/client-v2.0.0'
import * as CurrentClient from '@opencode/client-v2.0.32'
import { executionFloorOperations } from './OpenCodeV2ExecutionFloorClient.js'
import { OpenCodeV2ExecutionFetch } from './OpenCodeV2ExecutionFetch.js'

// Exercise the installed generated SDK, including its HTTP-envelope decoding.
// This controlled HTTP port mints no lease/endpoint or native admission authority.
for (const pin of ['2.0.0', '2.0.32'] as const) {
  test(`${pin} exact execution adapter preserves each published finite response contract`, async () => {
    const base = 'http://127.0.0.1:31999', directory = '/TEST/project', id = 'ses_TESToriginal'
    const location = { directory }
    let response: unknown, status = 200, streaming = false
    const calls: Request[] = []
    const fetch = Object.assign(async (input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]) => {
      calls.push(new Request(input, init))
      return status === 204 ? new Response(null, { status }) : new Response(streaming ? `data: ${JSON.stringify(response)}\n\n` : JSON.stringify(response),
        { status, headers: { 'content-type': streaming ? 'text/event-stream' : 'application/json' } })
    }, { preconnect(): never { throw new Error('TEST preconnect unsupported') } })
    const wire = new OpenCodeV2ExecutionFetch(base, pin, directory, 'TEST-password', { deadline: Date.now() + 10_000 }, fetch)
    const operations = pin === '2.0.0' ? executionFloorOperations(FloorClient, base, directory, wire, fetch) : executionCurrentOperations(CurrentClient, base, directory, wire, fetch)
    const session = { id, directory, agent: 'TEST-agent', model: { providerID: 'TEST-provider', id: 'TEST-model', variant: 'default' }, time: { created: 1 } }
    const inbox = { id: 'msg_TESToriginal', sessionID: id, type: 'user', time: { created: 2 }, delivery: 'queue', payload: { text: 'TEST' } }
    const instruction = { key: 'test', value: { text: 'TEST' } }
    const permission = { id: 'perm_TEST', sessionID: id, action: 'read', resources: ['TEST'] }
    try {
      response = { data: session }
      expect(await operations.create({ sessionID: id, agent: session.agent, model: session.model })).toEqual(session)
      expect(await operations.get(id)).toEqual(session)
      response = { data: inbox }
      expect(await operations.prompt(id, { nativeInputID: inbox.id, text: 'TEST', resume: true })).toEqual(inbox)
      response = { data: [inbox] }; expect(await operations.inbox(id)).toEqual([inbox])
      response = { data: [instruction] }; expect(await operations.instructions(id)).toEqual([instruction])
      response = { data: [permission] }; expect(await operations.permissions(id)).toEqual([permission])
      response = { data: permission }; expect(await operations.permission(id, permission.id)).toEqual(permission)
      // Scoped/catalog responses and message pagination must KEEP their envelope.
      response = { location, data: [session.model] }; expect(await operations.models()).toEqual(response)
      response = { location, data: { id: session.agent } }; expect(await operations.agent(session.agent)).toEqual(response)
      response = { location, data: [{ name: 'TEST-mcp', status: { status: 'connected' } }] }; expect(await operations.mcp()).toEqual(response)
      response = { data: [], cursor: { previous: 'TEST-prev', next: 'TEST-next' } }; expect(await operations.messages(id)).toEqual(response)
      response = [{ type: 'TEST-config' }]; expect(await operations.config?.()).toEqual(response)
      response = { directory }; expect(await operations.location()).toEqual(response)
      response = { version: pin }; expect(await operations.identity()).toEqual(response)
      response = { interrupted: true }; expect(await operations.interrupt(id)).toEqual(response)
      const request = calls.at(-1)!
      expect(new URL(request.url).searchParams.get(pin === '2.0.0' ? 'continue' : 'resume')).toBe('false')
      if (pin === '2.0.0') { status = 204; expect(await operations.ready()).toBeUndefined() }
      else { response = { location, data: [] }; expect(await operations.ready()).toEqual(response) }
      status = 204
      expect(await operations.putInstruction(id, instruction.key, instruction.value)).toBeUndefined()
      expect(await operations.cancelInbox(id, inbox.id)).toBeUndefined()
      expect(await operations.addMcp('TEST-mcp', { type: 'local', command: ['TEST-command'] })).toBeUndefined()
      expect(await operations.connectMcp('TEST-mcp')).toBeUndefined()
      expect(await operations.disconnectMcp('TEST-mcp')).toBeUndefined()
      expect(await operations.replyPermission(id, permission.id, 'once')).toBeUndefined()
      expect(JSON.parse(await calls.at(-1)!.text())).toEqual(pin === '2.0.0' ? { reply: 'once' } : { decision: 'once' })
      status = 200; streaming = true; response = { type: 'event.log.synced', watermark: 3 }
      const log: unknown[] = []; for await (const event of operations.log(id)) log.push(event)
      expect(log).toEqual([response])
    } finally { await wire.dispose() }
  })
}
