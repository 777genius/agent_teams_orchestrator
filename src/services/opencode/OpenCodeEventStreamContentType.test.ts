import { expect, test } from 'bun:test'
import { isOpenCodeEventStreamContentType } from './OpenCodeEventStreamContentType.js'

test('accepts case-insensitive exact SSE media type and valid token/quoted parameters', () => {
  for (const value of ['text/event-stream', 'Text/Event-Stream; charset=utf-8',
    ' text/event-stream\t; note="a; b, c" ', 'text/event-stream; note="escaped\\\"quote"']) {
    expect(isOpenCodeEventStreamContentType(value)).toBe(true)
  }
})

test('rejects misleading substrings, duplicate/ambiguous fields and malformed parameters', () => {
  for (const value of [null, 'application/json; note="text/event-stream"',
    'text/event-stream-extra', 'text/event-stream, text/event-stream',
    'text/event-stream; charset=utf-8; CHARSET=latin1', 'text/event-stream;',
    'text/event-stream; note="unterminated', 'text/event-stream; note="bad\rvalue"',
    'text/event-stream; =utf-8', 'text/event-stream; charset = utf-8']) {
    expect(isOpenCodeEventStreamContentType(value)).toBe(false)
  }
})
