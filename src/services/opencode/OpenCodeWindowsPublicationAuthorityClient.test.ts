import { describe, expect, test } from 'bun:test'
import { OpenCodeWindowsPublicationAuthorityClient } from './OpenCodeWindowsPublicationAuthorityClient.js'

function fake() {
  let controller!: ReadableStreamDefaultController<Uint8Array>; let kills = 0; let closes = 0; const operations: string[] = []; const requests: Record<string, unknown>[] = []
  const encoder = new TextEncoder(); const stdout = new ReadableStream<Uint8Array>({ start(value) { controller = value } })
  const child = { pid: 123, stdout, exited: new Promise<number>(() => {}), unref() {},
    kill() { kills += 1; try { controller.close() } catch {} },
    stdin: { end() { closes += 1 }, write(line: string) {
      const request = JSON.parse(line); requests.push(request); operations.push(request.op); const value = request.op === 'OPEN_ROOT'
        ? { volumeSerial: '1', fileId: '2', createdPaths: [] }
        : request.op === 'PIN_REGULAR' || request.op === 'PIN_REGULAR_READONLY'
          ? { volumeSerial: '1', fileId: '3', size: '4' }
          : request.op === 'PREPARE_ATOMIC'
            ? { volumeSerial: '1', fileId: '4', size: String(Buffer.from(request.content_base64, 'base64').length) }
            : request.op === 'RECOVER_ATOMIC'
              ? { recovered: true }
            : request.op === 'CREATE_DIRECTORY' || request.op === 'RENAME_DIRECTORY' || request.op === 'OPEN_CHILD_DIRECTORY'
              || request.op === 'CREATE_CHILD_DIRECTORY' || request.op === 'CREATE_CHILD_FILE'
              ? { volumeSerial: '1', fileId: '5' }
              : request.op === 'NS_STAT'
                ? { volumeSerial: '1', fileId: '8', size: '3', kind: request.path === '.' ? 'directory' : 'file' }
                : request.op === 'NS_OPEN'
                  ? { token: request.token, volumeSerial: '1', fileId: '9', size: '3', kind: request.mode === 'directory' ? 'directory' : 'file' }
                  : request.op === 'NS_READ'
                    ? { content_base64: Buffer.from('abc').subarray(request.offset, request.offset + request.length).toString('base64') }
                    : request.op === 'NS_WRITE'
                      ? { written: String(request.offset + Buffer.from(request.content_base64, 'base64').length) }
                      : request.op === 'NS_LIST'
                        ? { names: ['journal', 'lock'] }
                        : request.op === 'NS_MODIFIED_AT'
                          ? { modifiedAt: 1234 }
                          : request.op === 'NS_RECOVER_ATOMIC'
                            ? { result: 'recovered' }
                            : request.op === 'NS_ACQUIRE_LOCK'
                              ? { token: request.token }
              : request.op === 'WRITE_CHILD_FILE'
                ? { written: String(request.offset + Buffer.from(request.content_base64, 'base64').length), finished: request.finish }
                : {}
      controller.enqueue(encoder.encode(`${JSON.stringify({ version: 1, id: request.id, ok: true, value })}\n`)); return line.length
    } } }
  return { child, kills: () => kills, closes: () => closes, operations, requests }
}

describe('OpenCodeWindowsPublicationAuthorityClient', () => {
  test('cancels the native worker immediately after owner loss', async () => {
    const process = fake(); const abort = new AbortController()
    const client = new OpenCodeWindowsPublicationAuthorityClient({ deadline: performance.now() + 5_000,
      signal: abort.signal, launch: () => process.child })
    await expect(client.openRoot('C:\\root', false, false)).resolves.toMatchObject({ fileId: '2' })
    abort.abort(); await new Promise(resolve => setTimeout(resolve, 0))
    await expect(client.pinRegular('passive-status.sqlite3')).rejects.toThrow('unavailable [redacted]')
    await client.close(); await client.close(); expect(process.kills()).toBe(1); expect(process.closes()).toBe(1)
    expect(process.operations).toEqual(['OPEN_ROOT'])
  })
  test('fails before launch on an expired deadline', () => {
    expect(() => new OpenCodeWindowsPublicationAuthorityClient({ deadline: performance.now() - 1,
      launch: () => fake().child })).toThrow('unavailable [redacted]')
  })
  test('encodes SYNC_ROOT as an acknowledged native protocol barrier', async () => {
    const process = fake(); const client = new OpenCodeWindowsPublicationAuthorityClient({
      deadline: performance.now() + 5_000, launch: () => process.child,
    })
    await client.openRoot('C:\\safe', false, false); await client.syncRoot(); await client.close()
    expect(process.operations).toEqual(['OPEN_ROOT', 'SYNC_ROOT', 'CLOSE'])
  })
  test('preserves the caller absolute deadline after retaining the root', async () => {
    const process = fake(); const deadline = performance.now() + 30_000
    const client = new OpenCodeWindowsPublicationAuthorityClient({ deadline, launch: () => process.child })
    await client.openRoot('C:\\safe', false, false); await client.syncRoot(); await client.close()
    const waits = process.requests.map(request => Number(request.wait_ms))
    expect(waits.every(wait => wait <= deadline - performance.now() + 100)).toBeTrue()
    expect(Math.max(...waits)).toBeLessThan(31_000)
  })
  test('does not reap a live retained owner at the former 90 second lease', async () => {
    const original = globalThis.setTimeout; const delays: number[] = []
    globalThis.setTimeout = ((handler: Parameters<typeof setTimeout>[0], timeout?: number, ...args: unknown[]) => {
      delays.push(Number(timeout)); return original(handler, timeout, ...args)
    }) as typeof setTimeout
    const process = fake(); const client = new OpenCodeWindowsPublicationAuthorityClient({
      deadline: performance.now() + 120_000, launch: () => process.child,
    })
    try {
      await client.openRoot('C:\\safe', false, false)
      expect(delays.at(-1)).toBeGreaterThan(110_000)
      expect(process.kills()).toBe(0)
    } finally {
      globalThis.setTimeout = original; client.kill()
    }
  })
  test('serializes concurrent request/reply ownership', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>; let kills = 0
    const writes: Record<string, unknown>[] = []; const encoder = new TextEncoder()
    const child = { pid: 123, stdout: new ReadableStream<Uint8Array>({ start(value) { controller = value } }),
      exited: new Promise<number>(() => {}), unref() {}, kill() { kills += 1; try { controller.close() } catch {} },
      stdin: { end() {}, write(line: string) { writes.push(JSON.parse(line)); return line.length } } }
    const reply = (request: Record<string, unknown>, value: unknown) => controller.enqueue(encoder.encode(
      `${JSON.stringify({ version: 1, id: request.id, ok: true, value })}\n`))
    const client = new OpenCodeWindowsPublicationAuthorityClient({ deadline: performance.now() + 5_000,
      launch: () => child })
    const opening = client.openRoot('C:\\safe', false, false)
    await new Promise(resolve => setTimeout(resolve, 0)); expect(writes).toHaveLength(1)
    reply(writes[0]!, { volumeSerial: '1', fileId: '2', createdPaths: [] }); await opening
    const first = client.validateRoot(); const second = client.syncRoot()
    await new Promise(resolve => setTimeout(resolve, 0)); expect(writes.map(value => value.op)).toEqual(['OPEN_ROOT', 'VALIDATE_ROOT'])
    reply(writes[1]!, {}); await first
    await new Promise(resolve => setTimeout(resolve, 0)); expect(writes.map(value => value.op)).toEqual(['OPEN_ROOT', 'VALIDATE_ROOT', 'SYNC_ROOT'])
    reply(writes[2]!, {}); await second; client.kill(); expect(kills).toBe(1)
  })
  test('never attributes a coalesced foreign reply to the next queued request', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>; let kills = 0
    const encoder = new TextEncoder(); let writes = 0
    const child = { pid: 123, stdout: new ReadableStream<Uint8Array>({ start(value) { controller = value } }),
      exited: new Promise<number>(() => {}), unref() {}, kill() { kills += 1; try { controller.close() } catch {} },
      stdin: { end() {}, write(line: string) { const request = JSON.parse(line); writes += 1
        if (writes === 1) controller.enqueue(encoder.encode(
          `${JSON.stringify({ version: 1, id: request.id, ok: true,
            value: { volumeSerial: '1', fileId: '2', createdPaths: [] } })}\n`
          + '{"version":1,"id":"00000000-0000-0000-0000-000000000000","ok":true,"value":{}}\n'))
        return line.length } } }
    const client = new OpenCodeWindowsPublicationAuthorityClient({ deadline: performance.now() + 5_000,
      launch: () => child })
    await client.openRoot('C:\\safe', false, false)
    await expect(client.validateRoot()).rejects.toThrow('unavailable [redacted]')
    expect(writes).toBe(2); expect(kills).toBe(1)
  })
  test('kills retained native synchronous I/O at the immutable deadline', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>; let kills = 0
    const encoder = new TextEncoder(); const operations: string[] = []
    const child = { pid: 123, stdout: new ReadableStream<Uint8Array>({ start(value) { controller = value } }),
      exited: new Promise<number>(() => {}), unref() {}, kill() { kills += 1 },
      stdin: { end() {}, write(line: string) { const request = JSON.parse(line); operations.push(request.op)
        if (request.op === 'OPEN_ROOT') controller.enqueue(encoder.encode(`${JSON.stringify({ version: 1,
          id: request.id, ok: true, value: { volumeSerial: '1', fileId: '2', createdPaths: [] } })}\n`))
        return line.length } } }
    const client = new OpenCodeWindowsPublicationAuthorityClient({ deadline: performance.now() + 150,
      launch: () => child })
    await client.openRoot('C:\\safe', false, false)
    await expect(client.syncRoot()).rejects.toThrow('unavailable [redacted]')
    expect(operations).toEqual(['OPEN_ROOT', 'SYNC_ROOT']); expect(kills).toBe(1)
  })
  test('cancels retained synchronous I/O while a reply is pending', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>; let kills = 0
    const encoder = new TextEncoder(); const abort = new AbortController()
    const child = { pid: 123, stdout: new ReadableStream<Uint8Array>({ start(value) { controller = value } }),
      exited: new Promise<number>(() => {}), unref() {}, kill() { kills += 1 },
      stdin: { end() {}, write(line: string) { const request = JSON.parse(line)
        if (request.op === 'OPEN_ROOT') controller.enqueue(encoder.encode(`${JSON.stringify({ version: 1,
          id: request.id, ok: true, value: { volumeSerial: '1', fileId: '2', createdPaths: [] } })}\n`))
        return line.length } } }
    const client = new OpenCodeWindowsPublicationAuthorityClient({ deadline: performance.now() + 5_000,
      signal: abort.signal, launch: () => child })
    await client.openRoot('C:\\safe', false, false)
    const pending = client.syncRoot(); await new Promise(resolve => setTimeout(resolve, 0)); abort.abort()
    await expect(pending).rejects.toThrow('unavailable [redacted]'); expect(kills).toBe(1)
  })
  test('rejects unsafe Win32 roots and leaves without publishing them to native stdin', async () => {
    const process = fake(); const client = new OpenCodeWindowsPublicationAuthorityClient({
      deadline: performance.now() + 5_000, launch: () => process.child,
    })
    for (const root of ['C:\\safe:stream', '\\\\?\\C:\\safe', 'C:\\safe\\..\\escape', 'C:\\NUL']) {
      await expect(client.openRoot(root, false, false)).rejects.toThrow('unavailable [redacted]')
    }
    await client.openRoot('C:\\safe', false, false)
    for (const leaf of ['auth.json:stream', 'CON', 'NUL.txt', '..']) {
      await expect(client.pinRegular(leaf)).rejects.toThrow('unavailable [redacted]')
    }
    await client.close()
  })
  test('encodes retained directory and pinned atomic settlement as single native operations', async () => {
    const process = fake(); const client = new OpenCodeWindowsPublicationAuthorityClient({
      deadline: performance.now() + 5_000, launch: () => process.child,
    })
    await client.openRoot('C:\\safe', false, false)
    await client.createDirectory('attempt.snapshot')
    await client.renameDirectory('attempt.snapshot', 'published')
    await client.prepareAtomic('auth.json', '.auth.tmp', '.auth.backup', '.auth.quarantine',
      '.auth.recovery-required',
      new Uint8Array([1, 2, 3]))
    await client.rollbackAtomic(); await client.close()
    expect(process.operations).toEqual(['OPEN_ROOT', 'CREATE_DIRECTORY', 'RENAME_DIRECTORY',
      'PREPARE_ATOMIC', 'ROLLBACK_ATOMIC', 'CLOSE'])
    expect(process.requests[3]).toMatchObject({ content_base64: 'AQID', final_name: 'auth.json',
      recovery_name: '.auth.recovery-required' })
  })
  test('exposes explicit idempotent successor recovery decisions', async () => {
    const process = fake(); const client = new OpenCodeWindowsPublicationAuthorityClient({
      deadline: performance.now() + 5_000, launch: () => process.child,
    })
    await client.openRoot('C:\\safe', false, false)
    await expect(client.recoverAtomic('.auth.recovery-required', 'rollback')).resolves.toBe(true)
    await client.close()
    expect(process.requests[1]).toMatchObject({ op: 'RECOVER_ATOMIC',
      recovery_name: '.auth.recovery-required', decision: 'rollback' })
  })
  test('materializes descendants only through retained parent and file tokens', async () => {
    const process = fake(); const client = new OpenCodeWindowsPublicationAuthorityClient({
      deadline: performance.now() + 5_000, launch: () => process.child,
    })
    await client.openRoot('C:\\safe', false, false)
    await client.createDirectory('attempt.snapshot')
    await client.createChildDirectory('attempt.snapshot', 'attempt.snapshot/config', 'config')
    await client.createChildFile('attempt.snapshot/config', 'attempt.snapshot/config/opencode.json', 'opencode.json')
    await client.writeChildFile('attempt.snapshot/config/opencode.json', 0, new Uint8Array([1, 2]), false)
    await client.writeChildFile('attempt.snapshot/config/opencode.json', 2, new Uint8Array([3]), true)
    await expect(client.createChildDirectory('attempt.snapshot', 'attempt.snapshot/../escape', '..'))
      .rejects.toThrow('unavailable [redacted]')
    await client.rollbackDirectory('attempt.snapshot')
    await client.rollbackDirectory('attempt.snapshot')
    await client.close()
    expect(process.operations).toEqual(['OPEN_ROOT', 'CREATE_DIRECTORY', 'CREATE_CHILD_DIRECTORY',
      'CREATE_CHILD_FILE', 'WRITE_CHILD_FILE', 'WRITE_CHILD_FILE', 'ROLLBACK_DIRECTORY',
      'ROLLBACK_DIRECTORY', 'CLOSE'])
    expect(process.requests[4]).toMatchObject({ key: 'attempt.snapshot/config/opencode.json', offset: 0,
      content_base64: 'AQI=', finish: false })
  })
  test('opens legacy descendants and pins their files through the original authority', async () => {
    const process = fake(); const client = new OpenCodeWindowsPublicationAuthorityClient({
      deadline: performance.now() + 5_000, launch: () => process.child,
    })
    await client.openRoot('C:\\safe', false, false)
    await client.openChildDirectory('.', 'legacy', 'legacy')
    await client.openChildDirectory('legacy', 'legacy/snapshot', 'snapshot')
    await client.pinRegular('status.json', true, 'legacy/snapshot')
    await client.close()
    expect(process.operations).toEqual(['OPEN_ROOT', 'OPEN_CHILD_DIRECTORY', 'OPEN_CHILD_DIRECTORY',
      'PIN_REGULAR_READONLY', 'CLOSE'])
    expect(process.requests[3]).toMatchObject({ parent_key: 'legacy/snapshot', name: 'status.json' })
  })
  test('keeps journal namespace I/O on retained native tokens', async () => {
    const process = fake(); const client = new OpenCodeWindowsPublicationAuthorityClient({
      deadline: performance.now() + 5_000, launch: () => process.child,
    })
    await client.openRoot('C:\\safe', false, false)
    await client.namespaceMkdir('lease.pending')
    const handle = await client.namespaceOpen('lease.pending/owner.json', 'create_file')
    await client.namespaceWrite(handle.token, Buffer.from('abc'))
    await client.namespaceSyncHandle(handle.token)
    expect(new TextDecoder().decode(await client.namespaceRead(handle.token, 3))).toBe('abc')
    await client.namespaceRename('lease.pending', 'lease')
    expect(await client.namespaceStat('lease/owner.json')).toMatchObject({ kind: 'file', size: '3' })
    await client.namespaceCloseHandle(handle.token)
    await client.namespaceUnlink('lease/owner.json', false)
    await client.namespaceUnlink('lease', true)
    await client.namespaceSyncDirectory('.')
    await client.close()
    expect(process.operations).toEqual(['OPEN_ROOT', 'NS_MKDIR', 'NS_OPEN', 'NS_WRITE',
      'NS_SYNC_HANDLE', 'NS_READ', 'NS_RENAME', 'NS_STAT', 'NS_CLOSE_HANDLE', 'NS_UNLINK',
      'NS_UNLINK', 'NS_SYNC_DIRECTORY', 'CLOSE'])
  })
  test('wires the complete retained namespace publication boundary and releases locks once', async () => {
    const process = fake(); const client = new OpenCodeWindowsPublicationAuthorityClient({
      deadline: performance.now() + 5_000, launch: () => process.child,
    })
    await client.openRoot('C:\\safe', false, false)
    await expect(client.namespaceList('nested')).resolves.toEqual(['journal', 'lock'])
    await expect(client.namespaceModifiedAt('nested/journal', 'file')).resolves.toBe(1234)
    await expect(client.namespaceRecoverAtomic('nested/auth.json', '.auth.json.recovery-required.'))
      .resolves.toBe('recovered')
    await client.namespacePublishImmutable('nested/evidence.json', new Uint8Array([1, 2, 3]))
    await client.namespaceRemoveTree('nested/retired')
    const release = await client.namespaceAcquireLock('nested/owner.lock', {
      stale: 10_000, update: 1_000, retries: { retries: 0, minTimeout: 1, maxTimeout: 1 },
    })
    await release(); await release(); await client.close()
    expect(process.operations).toEqual(['OPEN_ROOT', 'NS_LIST', 'NS_MODIFIED_AT', 'NS_RECOVER_ATOMIC',
      'NS_PUBLISH_IMMUTABLE', 'NS_REMOVE_TREE', 'NS_ACQUIRE_LOCK', 'NS_RELEASE_LOCK', 'CLOSE'])
    expect(process.requests[4]).toMatchObject({ path: 'nested/evidence.json', content_base64: 'AQID' })
  })
  test('rejects malformed retained namespace paths without writing protocol frames', async () => {
    const process = fake(); const client = new OpenCodeWindowsPublicationAuthorityClient({
      deadline: performance.now() + 5_000, launch: () => process.child,
    })
    await client.openRoot('C:\\safe', false, false)
    await expect(client.namespaceList('../escape')).rejects.toThrow('unavailable [redacted]')
    await expect(client.namespacePublishImmutable('safe/NUL', new Uint8Array())).rejects.toThrow('unavailable [redacted]')
    await expect(client.namespaceRecoverAtomic('auth.json', '../recovery')).rejects.toThrow('unavailable [redacted]')
    await expect(client.namespaceRemoveTree('.')).rejects.toThrow('unavailable [redacted]')
    expect(process.operations).toEqual(['OPEN_ROOT'])
    client.kill()
  })
  test('physically releases an acquired retained lock when its caller cancels', async () => {
    const process = fake(); const abort = new AbortController()
    const client = new OpenCodeWindowsPublicationAuthorityClient({
      deadline: performance.now() + 5_000, launch: () => process.child,
    })
    await client.openRoot('C:\\safe', false, false)
    await client.namespaceAcquireLock('owner.lock', {
      stale: 10_000, update: 1_000, retries: { retries: 0, minTimeout: 1, maxTimeout: 1 },
    }, abort.signal)
    abort.abort(); await new Promise(resolve => setTimeout(resolve, 0))
    expect(process.operations).toEqual(['OPEN_ROOT', 'NS_ACQUIRE_LOCK', 'NS_RELEASE_LOCK'])
    await client.close()
  })
})
