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

  test('retains empty, Unicode and invalid UTF-8 response bodies unchanged', async () => {
    for (const bytes of [Buffer.alloc(0), Buffer.from('漢字'), Buffer.from([0xc0, 0xaf])]) {
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

  test('retains a 1 MiB body through actual nested base64 serialization and partial appends', async () => {
    const appended: Buffer[] = []
    const lines: Buffer[] = []
    const { port } = recorder({
      encode(observation) {
        // Exercise the structural/payload/raw-line expansion without defining a
        // production RawRecord adapter (that remains a W1-B/P1 prerequisite).
        const structure = Buffer.from(JSON.stringify(observation))
        const payload = Buffer.from(JSON.stringify({ structureBase64: structure.toString('base64') }))
        const line = Buffer.from(JSON.stringify({ payloadBase64: payload.toString('base64') }) + '\n')
        expect(structure.length).toBeLessThanOrEqual(2 * 1024 * 1024)
        expect(payload.length).toBeLessThanOrEqual(2 * 1024 * 1024)
        lines.push(line)
        return { bytes: line, recordId: 'a'.repeat(64) }
      },
      async write(bytes, offset, length) {
        const written = Math.min(length, 65536)
        appended.push(Buffer.from(bytes.subarray(offset, offset + written)))
        return written
      },
    })
    const request = await port.retainRequest(port.bindOperation({ kind: 'observe', sessionId: 'ses_1' }), {
      method: 'GET', path: '/permissions', bytes: Buffer.alloc(0),
    })
    const bytes = Buffer.alloc(1024 * 1024, 255)
    await port.retainResponse(request, { status: 200, contentEncoding: null, peerOperationNonce: null, bytes, complete: true })
    expect(lines[1]!.length).toBeGreaterThan(2 * 1024 * 1024)
    expect(lines[1]!.length).toBeLessThanOrEqual(4 * 1024 * 1024)
    expect(Buffer.concat(appended)).toEqual(Buffer.concat(lines))
    const payload = JSON.parse(Buffer.from(JSON.parse(lines[1]!.toString()).payloadBase64, 'base64').toString())
    const observation = JSON.parse(Buffer.from(payload.structureBase64, 'base64').toString())
    expect(Buffer.from(observation.body.bodyBase64, 'base64')).toEqual(bytes)
    await port.close()
  })

  test('captures sink operations and record identity before asynchronous writes', async () => {
    let release!: () => void
    let writing!: () => void
    const started = new Promise<void>(resolve => { writing = resolve })
    const pendingWrite = new Promise<void>(resolve => { release = resolve })
    let syncs = 0
    const encoded = { bytes: Buffer.from('record'), recordId: 'a'.repeat(64) }
    const sink: OpenCodeRawRetentionSink = {
      encode: () => encoded, isCurrent: () => true,
      async write(_bytes, _offset, length) { writing(); await pendingWrite; return length },
      async sync() { syncs += 1; throw new Error('actual sync failure') }, close: async () => {},
    }
    const port = createOpenCodeRawRetention(sink)
    const pending = port.retainRequest(port.bindOperation({ kind: 'capability' }), {
      method: 'GET', path: '/', bytes: Buffer.alloc(0),
    })
    const failure = expect(pending).rejects.toThrow('append failed')
    await started
    sink.write = async (_bytes, _offset, length) => length
    sink.sync = async () => {}
    sink.isCurrent = () => true
    encoded.recordId = 'b'.repeat(64)
    release()
    await failure
    expect(syncs).toBe(1)
    expect(port.isCurrent()).toBe(false)
    await port.close()
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
