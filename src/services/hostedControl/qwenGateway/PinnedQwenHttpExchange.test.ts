import { expect, test } from 'bun:test'
import type { Socket } from 'node:net'

import { PinnedQwenResponseParser, writePinnedQwen } from './PinnedQwenHttpExchange.js'

test('partial synchronous kernel write closes the socket and cannot be retried', () => {
  let destroyed = 0
  let calls = 0
  const socket = { _handle: { fd: 9 }, destroyed: false, connecting: false,
    destroy: () => { destroyed++ } } as unknown as Socket
  expect(() => writePinnedQwen(socket, Buffer.from('request'), () => { calls++; return 1 }))
    .toThrow('hosted-qwen-dispatch-partial')
  expect(calls).toBe(1)
  expect(destroyed).toBe(1)
})

test('EAGAIN aborts one attempted write without retry', () => {
  let destroyed = 0
  let calls = 0
  const socket = { _handle: { fd: 9 }, destroyed: false, connecting: false,
    destroy: () => { destroyed++ } } as unknown as Socket
  expect(() => writePinnedQwen(socket, Buffer.from('request'), () => {
    calls++
    throw Object.assign(new Error('try again'), { code: 'EAGAIN' })
  })).toThrow('try again')
  expect(calls).toBe(1)
  expect(destroyed).toBe(1)
})

test('response framing rejects overflow and truncated chunked stream', () => {
  const parser = new PinnedQwenResponseParser(3)
  expect(() => parser.feed(Buffer.from('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4\r\ntext\r\n0\r\n\r\n')))
    .toThrow('hosted-qwen-response-limit')
  const truncated = new PinnedQwenResponseParser(10)
  expect(truncated.feed(Buffer.from('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4\r\nte')))
    .toEqual([Buffer.from('te')])
  expect(() => truncated.ended()).toThrow('hosted-qwen-response-truncated')
  const splitTerminal = new PinnedQwenResponseParser(10)
  expect(splitTerminal.feed(Buffer.from('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1\r\na\r\n0\r\n')))
    .toEqual([Buffer.from('a')])
  expect(splitTerminal.done).toBe(false)
  expect(splitTerminal.feed(Buffer.from('\r\n'))).toEqual([])
  expect(splitTerminal.done).toBe(true)
})
