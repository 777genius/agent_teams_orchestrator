import { describe, expect, test } from 'bun:test'

import { createHostedOwnerToolPlugin } from './HostedOwnerToolPlugin.js'
const taskId = `task_${'a'.repeat(32)}`

const wireContext = { sessionID: 'ses_1', messageID: 'msg_1', callID: 'call_1' }
const runtime = { ...wireContext, abort: new AbortController().signal }

describe('HostedOwnerToolPlugin', () => {
  test('exposes exactly the five v1.18.32 plugin tool definitions with immutable hooks', async () => {
    const plugin = createHostedOwnerToolPlugin({ exchange: async () => 'ok' })
    const hooks = await plugin()
    expect(Object.keys(hooks.tool).sort()).toEqual([
      'hosted_message_send', 'hosted_task_add_comment', 'hosted_task_complete',
      'hosted_task_get', 'hosted_task_start',
    ])
    expect(Object.isFrozen(hooks)).toBe(true)
    expect(Object.isFrozen(hooks.tool)).toBe(true)
    for (const definition of Object.values(hooks.tool)) {
      expect(Object.isFrozen(definition)).toBe(true)
      expect(Object.isFrozen(definition.args)).toBe(true)
    }
  })

  test.each([
    ['hosted_task_get', { taskId }],
    ['hosted_task_start', { taskId }],
    ['hosted_task_complete', { taskId }],
    ['hosted_task_add_comment', { taskId, text: 'done' }],
    ['hosted_message_send', { to: 'bob', text: 'ready', taskRefs: [{ teamName: 'team-a', taskId }] }],
  ] as const)('passes only validated %s args and runtime identity', async (name, args) => {
    const calls: unknown[] = []
    const hooks = await createHostedOwnerToolPlugin({ exchange: async input => {
      calls.push(input)
      return 'Owner reply'
    } })()
    const result = await hooks.tool[name].execute(args, runtime)
    expect(result).toBe('Owner reply')
    expect(calls).toEqual([{ tool: name, context: wireContext, args }])
  })

  test('fails closed before exchange on extra args, invalid refs, and absent callID', async () => {
    let calls = 0
    const hooks = await createHostedOwnerToolPlugin({ exchange: async () => { calls++; return 'ok' } })()
    await expect(hooks.tool.hosted_task_get.execute({ taskId, teamName: 'foreign' }, runtime))
      .rejects.toThrow('arguments invalid')
    await expect(hooks.tool.hosted_message_send.execute({
      to: 'bob', text: 'hello', taskRefs: [{ teamName: 'team-a', taskId, root: '/tmp' }],
    }, runtime)).rejects.toThrow('arguments invalid')
    await expect(hooks.tool.hosted_task_get.execute({ taskId }, {
      sessionID: 'ses_1', messageID: 'msg_1', abort: runtime.abort,
    })).rejects.toThrow('context unavailable')
    await expect(hooks.tool.hosted_task_get.execute({ taskId }, wireContext))
      .rejects.toThrow('context unavailable')
    expect(calls).toBe(0)
  })

  test('passes runtime abort signal out of band without adding it to the wire context', async () => {
    const controller = new AbortController()
    let passedSignal: AbortSignal | undefined
    let passedContext: unknown
    const hooks = await createHostedOwnerToolPlugin({ exchange: async (request, signal) => {
      passedContext = request.context
      passedSignal = signal
      return 'ok'
    } })()
    await hooks.tool.hosted_task_get.execute({ taskId }, { ...runtime, abort: controller.signal })
    expect(passedContext).toEqual(wireContext)
    expect(passedSignal).toBe(controller.signal)
  })
})
