import { describe, expect, test } from 'bun:test'
import type { SDKMessage } from 'src/entrypoints/agentSdkTypes.js'
import type { StdinMessage } from 'src/entrypoints/sdk/controlTypes.js'
import { StructuredIO } from './structuredIO.js'

type PendingNext = {
  resolve: (result: IteratorResult<string>) => void
}

class ControllableInput implements AsyncIterable<string> {
  private readonly values: string[] = []
  private readonly pending: PendingNext[] = []
  done = false
  nextCalls = 0
  returnCalls = 0;

  [Symbol.asyncIterator](): AsyncIterator<string> {
    return {
      next: () => {
        this.nextCalls++
        const value = this.values.shift()
        if (value !== undefined) return Promise.resolve({ done: false, value })
        if (this.done) return Promise.resolve({ done: true, value: undefined })
        return new Promise(resolve => this.pending.push({ resolve }))
      },
      return: () => {
        this.returnCalls++
        this.end()
        return Promise.resolve({ done: true, value: undefined })
      },
    }
  }

  push(value: string): void {
    const pending = this.pending.shift()
    if (pending) pending.resolve({ done: false, value })
    else this.values.push(value)
  }

  end(): void {
    this.done = true
    for (const pending of this.pending.splice(0)) {
      pending.resolve({ done: true, value: undefined })
    }
  }
}

function userLine(content: string, newline = true): string {
  return `${JSON.stringify({
    type: 'user',
    session_id: '',
    message: { role: 'user', content },
    parent_tool_use_id: null,
  })}${newline ? '\n' : ''}`
}

function interruptLine(requestId: string): string {
  return `${JSON.stringify({
    type: 'control_request',
    request_id: requestId,
    request: { subtype: 'interrupt' },
  })}\n`
}

function userContent(
  result: IteratorResult<StdinMessage | SDKMessage>,
): unknown {
  if (result.done || result.value.type !== 'user') return undefined
  return result.value.message.content
}

async function turn(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

function blockingInput(
  returnBehavior: 'none' | 'throw' | 'reject',
): AsyncIterable<string> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<string> {
      const iterator: AsyncIterator<string> = {
        next: () => new Promise<IteratorResult<string>>(() => {}),
      }
      if (returnBehavior === 'throw') {
        iterator.return = () => {
          throw new Error('synchronous return failure')
        }
      } else if (returnBehavior === 'reject') {
        iterator.return = () =>
          Promise.reject(new Error('asynchronous return failure'))
      }
      return iterator
    },
  }
}

async function* blockedAsyncGenerator(): AsyncGenerator<string> {
  await new Promise<void>(() => {})
  yield userLine('unreachable')
}

describe('StructuredIO hosted input lifetime', () => {
  test('hosted injection wakes a real iterator while stdin next is pending', async () => {
    const input = new ControllableInput()
    const io = new StructuredIO(input)
    const hosted = io.retainHostedInput()

    const next = io.structuredInput.next()
    await turn()
    expect(input.nextCalls).toBe(1)
    expect(hosted.enqueueUserMessage('mailbox turn')).toBe(true)
    expect(userContent(await next)).toBe('mailbox turn')
    expect(input.nextCalls).toBe(1)

    input.end()
    hosted.close()
    expect((await io.structuredInput.next()).done).toBe(true)
  })

  test('multiple hosted turns retain prepend priority over control input', async () => {
    const input = new ControllableInput()
    const io = new StructuredIO(input)
    const hosted = io.retainHostedInput()
    const first = io.structuredInput.next()
    await turn()

    input.push(
      `${JSON.stringify({
        type: 'control_request',
        request_id: 'host-control',
        request: { subtype: 'interrupt' },
      })}\n`,
    )
    expect(hosted.enqueueUserMessage('one')).toBe(true)
    expect(hosted.enqueueUserMessage('two')).toBe(true)

    expect(userContent(await first)).toBe('one')
    expect(userContent(await io.structuredInput.next())).toBe('two')
    const control = await io.structuredInput.next()
    expect(control.done).toBe(false)
    expect(control.value?.type).toBe('control_request')
    if (control.value?.type === 'control_request') {
      expect(control.value.request_id).toBe('host-control')
    }

    hosted.close()
    input.end()
    expect((await io.structuredInput.next()).done).toBe(true)
  })

  test('hosted input continues after underlying stdin EOF until close', async () => {
    const input = new ControllableInput()
    const io = new StructuredIO(input)
    const hosted = io.retainHostedInput()
    const next = io.structuredInput.next()
    await turn()
    expect(input.nextCalls).toBe(1)
    input.end()
    await turn()

    expect(hosted.enqueueUserMessage('after eof')).toBe(true)
    expect(userContent(await next)).toBe('after eof')
    hosted.close()
    expect((await io.structuredInput.next()).done).toBe(true)
  })

  test('buffered partial stdin follows a newly accepted hosted turn', async () => {
    const input = new ControllableInput()
    const io = new StructuredIO(input)
    const hosted = io.retainHostedInput()
    const next = io.structuredInput.next()
    input.push(userLine('partial', false))
    await turn()

    expect(hosted.enqueueUserMessage('priority')).toBe(true)
    expect(userContent(await next)).toBe('priority')
    input.push('\n')
    expect(userContent(await io.structuredInput.next())).toBe('partial')

    hosted.close()
    input.end()
    expect((await io.structuredInput.next()).done).toBe(true)
  })

  test('closing the iterator releases pending stdin and rejects late input', async () => {
    const input = new ControllableInput()
    const io = new StructuredIO(input)
    const hosted = io.retainHostedInput()
    const next = io.structuredInput.next()
    await turn()

    const returned = io.structuredInput.return(undefined)
    expect((await next).done).toBe(true)
    expect((await returned).done).toBe(true)
    expect(input.returnCalls).toBe(1)
    expect(hosted.closed).toBe(true)
    expect(hosted.enqueueUserMessage('discarded')).toBe(false)
  })

  test('ordinary EOF and pre-start prepend behavior remain unchanged', async () => {
    const input = new ControllableInput()
    input.end()
    const io = new StructuredIO(input)
    io.prependUserMessage('ordinary')

    expect(userContent(await io.structuredInput.next())).toBe('ordinary')
    expect((await io.structuredInput.next()).done).toBe(true)
    expect(() => io.retainHostedInput()).toThrow('Structured input is closed')
  })

  test('ordinary prepend keeps priority over an older queued remainder', async () => {
    const input = new ControllableInput()
    input.end()
    const io = new StructuredIO(input)
    io.prependUserMessage('old-one')
    io.prependUserMessage('old-two')

    expect(userContent(await io.structuredInput.next())).toBe('old-one')
    io.prependUserMessage('new-priority')
    expect(userContent(await io.structuredInput.next())).toBe('new-priority')
    expect(userContent(await io.structuredInput.next())).toBe('old-two')
    expect((await io.structuredInput.next()).done).toBe(true)
  })

  test('closed hosted handle rejects enqueue and drains accepted turns', async () => {
    const input = new ControllableInput()
    input.end()
    const io = new StructuredIO(input)
    const hosted = io.retainHostedInput()
    expect(hosted.enqueueUserMessage('accepted')).toBe(true)
    hosted.close()
    expect(hosted.closed).toBe(true)
    expect(hosted.enqueueUserMessage('late')).toBe(false)

    expect(userContent(await io.structuredInput.next())).toBe('accepted')
    expect((await io.structuredInput.next()).done).toBe(true)
  })

  test('sustained hosted enqueue fairly services a permission response and interrupt', async () => {
    const input = new ControllableInput()
    const io = new StructuredIO(input)
    const hosted = io.retainHostedInput()
    const permission = io.handleElicitation('server', 'question')
    const pendingRequests = (
      io as unknown as { pendingRequests: Map<string, unknown> }
    ).pendingRequests
    const requestId = pendingRequests.keys().next().value
    if (typeof requestId !== 'string') {
      throw new Error('elicitation request was not registered')
    }

    const first = io.structuredInput.next()
    await turn()
    input.push(
      `${JSON.stringify({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: requestId,
          response: { action: 'accept', content: {} },
        },
      })}\n${JSON.stringify({
        type: 'control_request',
        request_id: 'fair-interrupt',
        request: { subtype: 'interrupt' },
      })}\n`,
    )
    for (let index = 0; index < 9; index++) {
      expect(hosted.enqueueUserMessage(`queued-${index}`)).toBe(true)
    }

    let result = await first
    for (let index = 0; index < 20 && result.value?.type === 'user'; index++) {
      expect(hosted.enqueueUserMessage(`sustained-${index}`)).toBe(true)
      result = await io.structuredInput.next()
    }

    expect(result.done).toBe(false)
    expect(result.value?.type).toBe('control_request')
    if (result.value?.type === 'control_request') {
      expect(result.value.request_id).toBe('fair-interrupt')
    }
    expect(await permission).toEqual({ action: 'accept', content: {} })

    hosted.close()
    input.end()
    while (!(await io.structuredInput.next()).done) {
      // Drain every hosted turn whose enqueue returned true.
    }
  })

  test('startup hosted backlog starts one stdin read and bounds control delay', async () => {
    const input = new ControllableInput()
    input.push(interruptLine('startup-control'))
    const io = new StructuredIO(input)
    const hosted = io.retainHostedInput()
    for (let index = 0; index < 9; index++) {
      expect(hosted.enqueueUserMessage(`startup-${index}`)).toBe(true)
    }

    for (let index = 0; index < 8; index++) {
      expect(userContent(await io.structuredInput.next())).toBe(
        `startup-${index}`,
      )
    }
    const control = await io.structuredInput.next()
    expect(control.done).toBe(false)
    expect(control.value?.type).toBe('control_request')
    if (control.value?.type === 'control_request') {
      expect(control.value.request_id).toBe('startup-control')
    }
    expect(input.nextCalls).toBe(2)

    hosted.close()
    input.end()
    while (!(await io.structuredInput.next()).done) {
      // Drain the remaining accepted hosted turn.
    }
  })

  test('read-ahead services control from a later block under sustained enqueue', async () => {
    const input = new ControllableInput()
    input.push(userLine('first stdin block'))
    const io = new StructuredIO(input)
    const hosted = io.retainHostedInput()
    for (let index = 0; index < 9; index++) {
      expect(hosted.enqueueUserMessage(`before-block-${index}`)).toBe(true)
    }

    let result = await io.structuredInput.next()
    for (let index = 0; index < 9; index++) {
      if (userContent(result) === 'first stdin block') break
      result = await io.structuredInput.next()
    }
    expect(userContent(result)).toBe('first stdin block')
    expect(input.nextCalls).toBe(2)
    input.push(interruptLine('later-block-control'))

    for (let index = 0; index < 20; index++) {
      expect(hosted.enqueueUserMessage(`after-block-${index}`)).toBe(true)
      result = await io.structuredInput.next()
      if (result.value?.type === 'control_request') break
    }
    expect(result.done).toBe(false)
    expect(result.value?.type).toBe('control_request')
    if (result.value?.type === 'control_request') {
      expect(result.value.request_id).toBe('later-block-control')
    }

    hosted.close()
    input.end()
    while (!(await io.structuredInput.next()).done) {
      // Drain every hosted turn whose enqueue returned true.
    }
  })

  test('read-ahead completes a split control line under sustained enqueue', async () => {
    const input = new ControllableInput()
    const controlLine = interruptLine('split-control')
    const splitAt = Math.floor(controlLine.length / 2)
    input.push(controlLine.slice(0, splitAt))
    const io = new StructuredIO(input)
    const hosted = io.retainHostedInput()
    for (let index = 0; index < 9; index++) {
      expect(hosted.enqueueUserMessage(`before-split-${index}`)).toBe(true)
    }

    for (let index = 0; index < 9; index++) {
      expect(userContent(await io.structuredInput.next())).toBe(
        `before-split-${index}`,
      )
    }
    expect(input.nextCalls).toBe(2)
    input.push(controlLine.slice(splitAt))

    // Resolving the upstream read schedules a microtask; require bounded
    // service under sustained enqueue, not synchronous control priority.
    let control
    for (let index = 0; index < 10; index++) {
      expect(hosted.enqueueUserMessage(`after-split-${index}`)).toBe(true)
      control = await io.structuredInput.next()
      if (control.value?.type === 'control_request') break
    }
    expect(control).toBeDefined()
    expect(control?.done).toBe(false)
    expect(control?.value?.type).toBe('control_request')
    if (control?.value?.type === 'control_request') {
      expect(control.value.request_id).toBe('split-control')
    }

    hosted.close()
    input.end()
    while (!(await io.structuredInput.next()).done) {
      // Drain every hosted turn whose enqueue returned true.
    }
  })

  test('ordinary disposal interrupts a no-return source and settles permissions', async () => {
    const io = new StructuredIO(blockingInput('none'))
    const permission = io.handleElicitation('server', 'question')
    const next = io.structuredInput.next()
    await turn()

    const returned = io.structuredInput.return(undefined)
    expect((await next).done).toBe(true)
    expect((await returned).done).toBe(true)
    expect(await permission).toEqual({ action: 'cancel' })
  })

  test('retained disposal does not await a blocked async-generator return', async () => {
    const io = new StructuredIO(blockedAsyncGenerator())
    const hosted = io.retainHostedInput()
    const next = io.structuredInput.next()
    await turn()

    const returned = io.structuredInput.return(undefined)
    expect((await next).done).toBe(true)
    expect((await returned).done).toBe(true)
    expect(hosted.closed).toBe(true)
  })

  test('ordinary disposal survives a synchronously throwing source return', async () => {
    const io = new StructuredIO(blockingInput('throw'))
    const next = io.structuredInput.next()
    await turn()

    const returned = io.structuredInput.return(undefined)
    expect((await next).done).toBe(true)
    expect((await returned).done).toBe(true)
  })

  test('retained disposal survives a rejecting source return', async () => {
    const io = new StructuredIO(blockingInput('reject'))
    const hosted = io.retainHostedInput()
    const next = io.structuredInput.next()
    await turn()

    const returned = io.structuredInput.return(undefined)
    expect((await next).done).toBe(true)
    expect((await returned).done).toBe(true)
    expect(hosted.closed).toBe(true)
  })

  test('final unterminated EOF yield rejects a late hosted lifetime', async () => {
    const input = new ControllableInput()
    input.push(userLine('final partial', false))
    input.end()
    const io = new StructuredIO(input)

    expect(userContent(await io.structuredInput.next())).toBe('final partial')
    expect(() => io.retainHostedInput()).toThrow('Structured input is closed')
    expect((await io.structuredInput.next()).done).toBe(true)
  })
})


for (const cancel of [false, true]) {
  test(`synchronous upstream failure is observed across queued yield (cancel=${cancel})`, async () => {
    const failure = new Error('sync next failed')
    const input: AsyncIterable<string> = {
      [Symbol.asyncIterator]() {
        return { next(): Promise<IteratorResult<string>> { throw failure } }
      },
    }
    const io = new StructuredIO(input)
    io.prependUserMessage('ordinary')
    expect((await io.structuredInput.next()).value?.type).toBe('user')
    // Cross an event-loop turn while the rejected upstream promise is retained.
    await new Promise(resolve => setTimeout(resolve, 0))
    if (cancel) {
      expect((await io.structuredInput.return()).done).toBe(true)
    } else {
      await expect(io.structuredInput.next()).rejects.toThrow('sync next failed')
    }
  })
}
