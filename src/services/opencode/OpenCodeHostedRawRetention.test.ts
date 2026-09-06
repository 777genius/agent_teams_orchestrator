import { describe, expect, test } from 'bun:test'
import { createOpenCodeRawRetention, type OpenCodeRawObservation,
  type OpenCodeRawRetentionSink } from './OpenCodeHostedRawRetention.js'

function recorder(overrides: Partial<OpenCodeRawRetentionSink> = {}) {
  const records: OpenCodeRawObservation[] = []
  const events: string[] = []
  const port = createOpenCodeRawRetention({
    encode(value) { records.push(value); return { recordId: 'a'.repeat(64), bytes: Buffer.from('record') } },
    isCurrent: () => true,
    async write(_bytes, _offset, length) { events.push('write'); return Math.min(2, length) },
    async sync() { events.push('sync') }, close: async () => {}, ...overrides,
  })
  return { port, records, events }
}

describe('OpenCode bounded raw retention', () => {
  test('copies bytes before async append, loops partial writes and waits for sync', async () => {
    let release!: () => void
    const sync = new Promise<void>(resolve => { release = resolve })
    const { port, records, events } = recorder({ sync: () => sync })
    const bytes = Buffer.from('original')
    let complete = false
    const retained = port.retainRequest(port.bindOperation({ kind: 'capability' }), {
      method: 'GET', path: '/capability', bytes,
    }).then(value => { complete = true; return value })
    bytes.fill(0)
    await Promise.resolve(); await Promise.resolve()
    expect(complete).toBe(false)
    release()
    const request = await retained
    expect(Buffer.from(request.body.bodyBase64, 'base64').toString()).toBe('original')
    expect(events).toEqual(['write', 'write', 'write'])
    expect(records).toHaveLength(1)
    await port.close()
  })

  test('retains empty, Unicode, invalid UTF-8 and 1 MiB response bodies unchanged', async () => {
    for (const bytes of [Buffer.alloc(0), Buffer.from('漢字'), Buffer.from([0xc0, 0xaf]), Buffer.alloc(1024 * 1024, 255)]) {
      const { port, records } = recorder()
      const request = await port.retainRequest(port.bindOperation({ kind: 'observe', sessionId: 'ses_1' }), {
        method: 'GET', path: '/permissions', bytes: Buffer.alloc(0),
      })
      expect(request.body.sha256).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
      const retained = await port.retainResponse(request, { status: 409, contentEncoding: null,
        peerOperationNonce: null, bytes, complete: false })
      expect(Buffer.from(retained.bodyBase64, 'base64')).toEqual(bytes)
      expect(records[1]).toMatchObject({ complete: false, correlation: 'unavailable', peerOperationNonce: null })
      await port.close()
    }
  })

  test('poisons on zero writes, sync failure, overflow and descriptor replacement', async () => {
    for (const overrides of [
      { write: async () => 0 }, { sync: async () => { throw new Error('fsync') } },
      { encode: () => ({ recordId: 'a'.repeat(64), bytes: Buffer.alloc(4 * 1024 * 1024 + 1) }) },
    ]) {
      const { port } = recorder(overrides)
      await expect(port.retainRequest(port.bindOperation({ kind: 'capability' }), {
        method: 'GET', path: '/', bytes: Buffer.alloc(0),
      })).rejects.toThrow()
      expect(port.isCurrent()).toBe(false)
      await port.close()
    }
    let live = true
    const { port } = recorder({ isCurrent: () => live })
    live = false
    expect(port.isCurrent()).toBe(false)
    live = true
    expect(port.isCurrent()).toBe(false)
    await port.close()
  })

  test('rejects operation reuse and cross-port response substitution', async () => {
    const a = recorder().port
    const b = recorder().port
    const binding = a.bindOperation({ kind: 'capability' })
    const init = { method: 'GET' as const, path: '/', bytes: Buffer.alloc(0) }
    const request = await a.retainRequest(binding, init)
    await expect(a.retainRequest(binding, init)).rejects.toThrow()
    await expect(b.retainResponse(request, { status: 200, contentEncoding: null,
      peerOperationNonce: null, bytes: Buffer.alloc(0), complete: true })).rejects.toThrow()
    await a.close(); await b.close()
  })
})
