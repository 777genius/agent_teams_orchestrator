import { describe, expect, test } from 'bun:test'
import { OpenCodeWindowsPublicationAuthorityClient } from './OpenCodeWindowsPublicationAuthorityClient.js'

function fake(rejectLockAttempts = 0, exitOnKill = true, unknownOperation?: string,
  partialRemoveAttempts = 0) {
  let controller!: ReadableStreamDefaultController<Uint8Array>; let kills = 0; let closes = 0; const operations: string[] = []; const requests: Record<string, unknown>[] = []
  const materializations = new Set<string>()
  let resolveExit!: (code: number) => void; let exited = false
  const exit = (code = 0) => { if (exited) return; exited = true; try { controller.close() } catch {}; resolveExit(code) }
  const encoder = new TextEncoder(); const stdout = new ReadableStream<Uint8Array>({ start(value) { controller = value } })
  const child = { pid: 123, stdout, exited: new Promise<number>(resolve => { resolveExit = resolve }), unref() {},
    kill() { kills += 1; if (exitOnKill) exit(-1) },
    stdin: { end() { closes += 1 }, flush() { return 0 }, write(line: string) {
      const request = JSON.parse(line); requests.push(request); operations.push(request.op)
      const partialRemove = request.op === 'NS_REMOVE_TREE' && partialRemoveAttempts > 0
      if (partialRemove) partialRemoveAttempts -= 1
      const value = request.op === 'OPEN_ROOT'
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
                ? { volumeSerial: '1', fileId: '8', size: '3', linkCount: '1',
                    kind: request.path === '.' ? 'directory' : 'file' }
                : request.op === 'NS_OPEN'
                  ? { token: request.token, volumeSerial: '1', fileId: '9', size: '3', linkCount: '1',
                      kind: request.mode === 'directory' ? 'directory' : 'file' }
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
                            : request.op === 'NS_RENAME' || request.op === 'NS_UNLINK'
                              || request.op === 'NS_SYNC_DIRECTORY' || request.op === 'NS_REMOVE_TREE'
                              ? { committed: true,
                                  namespace: partialRemove ? 'partial' : 'complete',
                                  durability: request.op === unknownOperation || partialRemove ? 'unknown' : 'settled' }
                            : request.op === 'CLOSE'
                              ? { closed: true, durability: 'settled' }
                            : request.op === 'NS_ACQUIRE_LOCK'
                              ? { token: request.token }
              : request.op === 'WRITE_CHILD_FILE'
                ? { written: String(request.offset + Buffer.from(request.content_base64, 'base64').length), finished: request.finish }
                : {}
      if (request.op === 'CREATE_DIRECTORY') materializations.add(request.name)
      if (request.op === 'ROLLBACK_DIRECTORY') materializations.delete(request.root_key)
      const rejected = request.op === 'NS_ACQUIRE_LOCK' && rejectLockAttempts-- > 0
      controller.enqueue(encoder.encode(`${JSON.stringify(rejected
        ? { version: 1, id: request.id, ok: false, error: 'NS_EXISTS' }
        : { version: 1, id: request.id, ok: true, value })}\n`)); return line.length
    } } }
  return { child, kills: () => kills, closes: () => closes, operations, requests, exit,
    materializations: () => [...materializations] }
}

describe('OpenCodeWindowsPublicationAuthorityClient', () => {
  test('reports an early native stage before internal teardown can resolve cancellation', async () => {
    let stdout!: ReadableStreamDefaultController<Uint8Array>
    let stderr!: ReadableStreamDefaultController<Uint8Array>
    let resolveExit!: (code: number) => void; let kills = 0
    const child = {
      pid: 123,
      stdout: new ReadableStream<Uint8Array>({ start(value) { stdout = value } }),
      stderr: new ReadableStream<Uint8Array>({ start(value) { stderr = value } }),
      exited: new Promise<number>(resolve => { resolveExit = resolve }),
      unref() {}, kill() { kills += 1 },
      stdin: { end() {}, flush() { return 0 }, write(line: string) {
        expect(JSON.parse(line).op).toBe('OPEN_ROOT')
        stderr.enqueue(new TextEncoder().encode(
          'OPENCODE_NATIVE_LAUNCHER_FAILURE_V1 stage=job_attribute win32=5\n',
        ))
        stderr.close(); stdout.close(); resolveExit(126)
        return line.length
      } },
    }
    const client = new OpenCodeWindowsPublicationAuthorityClient({ deadline: Date.now() + 5_000,
      launch: () => child })
    await expect(client.openRoot('C:\\safe', false, false)).rejects.toThrow(
      'unavailable [redacted] (native_stage=job_attribute win32=5 exit=126)',
    )
    expect(kills).toBe(1)
  })

  test('flushes each buffered Bun stdin request before waiting for its reply', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>; let buffered = ''
    const encoder = new TextEncoder(); const operations: string[] = []
    const child = { pid: 123,
      stdout: new ReadableStream<Uint8Array>({ start(value) { controller = value } }),
      exited: new Promise<number>(() => {}), unref() {}, kill() { try { controller.close() } catch {} },
      stdin: { end() {}, write(line: string) { buffered = line; return line.length }, async flush() {
        await Promise.resolve()
        const request = JSON.parse(buffered); operations.push(request.op)
        controller.enqueue(encoder.encode(`${JSON.stringify({ version: 1, id: request.id, ok: true,
          value: { volumeSerial: '1', fileId: '2', createdPaths: [] } })}\n`))
        return buffered.length
      } } }
    const client = new OpenCodeWindowsPublicationAuthorityClient({ deadline: Date.now() + 5_000,
      launch: () => child })
    await expect(client.openRoot('C:\\safe', false, false)).resolves.toMatchObject({ fileId: '2' })
    expect(operations).toEqual(['OPEN_ROOT'])
    client.kill()
  })

  test.each([
    ['write', 'write'],
    ['flush', 'flush'],
    ['decode', 'decode'],
    ['native rejection', 'native_rejection authority_code=ROOT_REJECTED'],
  ] as const)('reports bounded %s stage evidence without forwarding transport data', async (failure, stage) => {
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const encoder = new TextEncoder()
    const child = {
      pid: 123,
      stdout: new ReadableStream<Uint8Array>({ start(value) { controller = value } }),
      exited: new Promise<number>(() => {}), unref() {}, kill() { try { controller.close() } catch {} },
      stdin: {
        end() {},
        write(line: string) {
          if (failure === 'write') throw new Error('C:\\secret\\request provider-token')
          const request = JSON.parse(line)
          if (failure === 'decode') controller.enqueue(encoder.encode('C:\\secret\\not-json\n'))
          if (failure === 'native rejection') controller.enqueue(encoder.encode(`${JSON.stringify({
            version: 1, id: request.id, ok: false, error: 'ROOT_REJECTED',
          })}\n`))
          return line.length
        },
        flush() {
          if (failure === 'flush') throw new Error('C:\\secret\\flush provider-token')
          return 0
        },
      },
    }
    const client = new OpenCodeWindowsPublicationAuthorityClient({ deadline: Date.now() + 5_000,
      launch: () => child })
    let error: Error | undefined
    try { await client.openRoot('C:\\safe', false, false) } catch (value) { error = value as Error }
    expect(error?.message).toBe(
      `OpenCode Windows publication authority is unavailable [redacted] (native_stage=${stage})`,
    )
    expect(error?.message).not.toContain('secret')
    expect(error?.message).not.toContain('provider-token')
  })

  test('reports a bounded read stage when the native reply pipe fails', async () => {
    const child = {
      pid: 123,
      stdout: new ReadableStream<Uint8Array>({ pull() { throw new Error('C:\\secret\\pipe') } }),
      exited: new Promise<number>(() => {}), unref() {}, kill() {},
      stdin: { end() {}, flush() { return 0 }, write(line: string) { return line.length } },
    }
    const client = new OpenCodeWindowsPublicationAuthorityClient({ deadline: Date.now() + 5_000,
      launch: () => child })
    let error: Error | undefined
    try { await client.openRoot('C:\\safe', false, false) } catch (value) { error = value as Error }
    expect(error?.message).toBe(
      'OpenCode Windows publication authority is unavailable [redacted] (native_stage=read)',
    )
    expect(error?.message).not.toContain('secret')
  })

  test('keeps retained cleanup authority after a correlated bounded native rejection', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>; let kills = 0
    const encoder = new TextEncoder(); const operations: string[] = []
    const child = {
      pid: 123,
      stdout: new ReadableStream<Uint8Array>({ start(value) { controller = value } }),
      exited: new Promise<number>(() => {}), unref() {}, kill() { kills += 1 },
      stdin: { end() {}, flush() { return 0 }, write(line: string) {
        const request = JSON.parse(line); operations.push(request.op)
        const rejected = request.op === 'VALIDATE_ROOT'
        controller.enqueue(encoder.encode(`${JSON.stringify(rejected
          ? { version: 1, id: request.id, ok: false, error: 'ROOT_REJECTED' }
          : { version: 1, id: request.id, ok: true, value: request.op === 'OPEN_ROOT'
              ? { volumeSerial: '1', fileId: '2', createdPaths: [] } : {} })}\n`))
        return line.length
      } },
    }
    const client = new OpenCodeWindowsPublicationAuthorityClient({ deadline: Date.now() + 5_000,
      launch: () => child })
    await client.openRoot('C:\\safe', false, false)
    await expect(client.validateRoot()).rejects.toThrow(
      'native_stage=native_rejection authority_code=ROOT_REJECTED',
    )
    expect(kills).toBe(0)
    await client.close()
    expect(operations).toEqual(['OPEN_ROOT', 'VALIDATE_ROOT', 'CLOSE'])
  })

  test('cancels caller waits but preserves retained cleanup authority after owner loss', async () => {
    const process = fake(); const abort = new AbortController()
    const client = new OpenCodeWindowsPublicationAuthorityClient({ deadline: Date.now() + 5_000,
      signal: abort.signal, launch: () => process.child })
    await expect(client.openRoot('C:\\root', false, false)).resolves.toMatchObject({ fileId: '2' })
    abort.abort(); await new Promise(resolve => setTimeout(resolve, 0))
    await expect(client.pinRegular('passive-status.sqlite3')).rejects.toThrow('unavailable [redacted]')
    await client.close(); await client.close(); expect(process.kills()).toBe(0); expect(process.closes()).toBe(1)
    expect(process.operations).toEqual(['OPEN_ROOT', 'PIN_REGULAR', 'CLOSE'])
  })
  test.each(['plugins.snapshot-attempt', 'node_modules.dependencies-attempt'])(
    'caller cancellation after creating %s still physically rolls back the attempt tree',
    async temporaryLeaf => {
      const process = fake(); const abort = new AbortController()
      const client = new OpenCodeWindowsPublicationAuthorityClient({ deadline: Date.now() + 5_000,
        signal: abort.signal, launch: () => process.child })
      await client.openRoot('C:\\safe', false, false)
      await client.createDirectory(temporaryLeaf)
      abort.abort(new Error('cancel after temporary creation'))
      await expect(client.validateRoot()).rejects.toThrow('unavailable [redacted]')
      await expect(client.rollbackDirectory(temporaryLeaf)).resolves.toBeUndefined()
      await client.close()
      expect(process.materializations()).toEqual([])
      expect(process.operations).toEqual([
        'OPEN_ROOT', 'CREATE_DIRECTORY', 'VALIDATE_ROOT', 'ROLLBACK_DIRECTORY', 'CLOSE',
      ])
    },
  )
  test('does not report physical settlement when kill precedes controlled child exit', async () => {
    const process = fake(0, false)
    const client = new OpenCodeWindowsPublicationAuthorityClient({ deadline: Date.now() + 5_000,
      launch: () => process.child })
    let settled = false
    void client.physicalSettlement.then(() => { settled = true })
    client.kill(); await new Promise(resolve => setTimeout(resolve, 0))
    expect(process.kills()).toBe(1); expect(settled).toBeFalse()
    process.exit(-1); await client.physicalSettlement
    expect(settled).toBeTrue()
  })
  test('close is idempotent while controlled child exit and physical release are delayed', async () => {
    const process = fake(0, false)
    const client = new OpenCodeWindowsPublicationAuthorityClient({ deadline: Date.now() + 5_000,
      launch: () => process.child })
    await client.openRoot('C:\\safe', false, false)
    const first = client.close(); const second = client.close()
    expect(first).toBe(second)
    await first
    expect(process.operations).toEqual(['OPEN_ROOT', 'CLOSE'])
    expect(process.kills()).toBe(0); expect(process.closes()).toBe(1)
    let physicallySettled = false
    void client.physicalSettlement.then(() => { physicallySettled = true })
    await new Promise(resolve => setTimeout(resolve, 0)); expect(physicallySettled).toBeFalse()
    process.exit(); await client.physicalSettlement
    expect(physicallySettled).toBeTrue()
    await client.close(); client.kill()
    expect(process.kills()).toBe(0); expect(process.closes()).toBe(1)
  })
  test('fails before launch on an expired deadline', () => {
    expect(() => new OpenCodeWindowsPublicationAuthorityClient({ deadline: Date.now() - 1,
      launch: () => fake().child })).toThrow('unavailable [redacted]')
  })
  test('encodes SYNC_ROOT as an acknowledged native protocol barrier', async () => {
    const process = fake(); const client = new OpenCodeWindowsPublicationAuthorityClient({
      deadline: Date.now() + 5_000, launch: () => process.child,
    })
    await client.openRoot('C:\\safe', false, false); await client.syncRoot(); await client.close()
    expect(process.operations).toEqual(['OPEN_ROOT', 'SYNC_ROOT', 'CLOSE'])
  })
  test('preserves the caller deadline while retained wire work uses only the cleanup reserve', async () => {
    const process = fake(); const deadline = Date.now() + 30_000
    const client = new OpenCodeWindowsPublicationAuthorityClient({ deadline, launch: () => process.child })
    await client.openRoot('C:\\safe', false, false); await client.syncRoot(); await client.close()
    expect(Number(process.requests[0]!.wait_ms)).toBeLessThan(30_100)
    expect(Number(process.requests[1]!.wait_ms)).toBeGreaterThan(Number(process.requests[0]!.wait_ms))
    expect(Number(process.requests[1]!.wait_ms)).toBeLessThan(31_100)
    expect(Number(process.requests.at(-1)!.wait_ms)).toBeLessThan(31_100)
  })
  test('does not reap a live retained owner at the former 90 second lease', async () => {
    const original = globalThis.setTimeout; const delays: number[] = []
    globalThis.setTimeout = ((handler: Parameters<typeof setTimeout>[0], timeout?: number, ...args: unknown[]) => {
      delays.push(Number(timeout)); return original(handler, timeout, ...args)
    }) as typeof setTimeout
    const process = fake(); const client = new OpenCodeWindowsPublicationAuthorityClient({
      deadline: Date.now() + 120_000, launch: () => process.child,
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
      stdin: { end() {}, flush() { return 0 }, write(line: string) { writes.push(JSON.parse(line)); return line.length } } }
    const reply = (request: Record<string, unknown>, value: unknown) => controller.enqueue(encoder.encode(
      `${JSON.stringify({ version: 1, id: request.id, ok: true, value })}\n`))
    const client = new OpenCodeWindowsPublicationAuthorityClient({ deadline: Date.now() + 5_000,
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
      stdin: { end() {}, flush() { return 0 }, write(line: string) { const request = JSON.parse(line); writes += 1
        if (writes === 1) controller.enqueue(encoder.encode(
          `${JSON.stringify({ version: 1, id: request.id, ok: true,
            value: { volumeSerial: '1', fileId: '2', createdPaths: [] } })}\n`
          + '{"version":1,"id":"00000000-0000-0000-0000-000000000000","ok":true,"value":{}}\n'))
        return line.length } } }
    const client = new OpenCodeWindowsPublicationAuthorityClient({ deadline: Date.now() + 5_000,
      launch: () => child })
    await client.openRoot('C:\\safe', false, false)
    await expect(client.validateRoot()).rejects.toThrow('unavailable [redacted]')
    expect(writes).toBe(2); expect(kills).toBe(1)
  })
  test('rejects retained synchronous I/O at the caller deadline without killing cleanup authority', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>; let kills = 0
    const encoder = new TextEncoder(); const operations: string[] = []
    const child = { pid: 123, stdout: new ReadableStream<Uint8Array>({ start(value) { controller = value } }),
      exited: new Promise<number>(() => {}), unref() {}, kill() { kills += 1 },
      stdin: { end() {}, flush() { return 0 }, write(line: string) { const request = JSON.parse(line); operations.push(request.op)
        if (request.op === 'OPEN_ROOT') controller.enqueue(encoder.encode(`${JSON.stringify({ version: 1,
          id: request.id, ok: true, value: { volumeSerial: '1', fileId: '2', createdPaths: [] } })}\n`))
        return line.length } } }
    const client = new OpenCodeWindowsPublicationAuthorityClient({ deadline: Date.now() + 150,
      launch: () => child })
    await client.openRoot('C:\\safe', false, false)
    await expect(client.syncRoot()).rejects.toThrow('unavailable [redacted]')
    expect(operations).toEqual(['OPEN_ROOT', 'SYNC_ROOT']); expect(kills).toBe(0)
    client.kill(); expect(kills).toBe(1)
  })
  test('kills a retained fake authority when NS_LIST never replies by its finite physical deadline', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>
    let resolveExit!: (code: number) => void
    let exited = false; let kills = 0
    const encoder = new TextEncoder(); const operations: string[] = []
    const finish = (code: number) => {
      if (exited) return
      exited = true; try { controller.close() } catch {}; resolveExit(code)
    }
    const child = {
      pid: 123,
      stdout: new ReadableStream<Uint8Array>({ start(value) { controller = value } }),
      exited: new Promise<number>(resolve => { resolveExit = resolve }),
      unref() { throw new Error('retained authority must remain referenced') },
      kill() { kills += 1; finish(-1) },
      stdin: { end() {}, flush() { return 0 }, write(line: string) {
        const request = JSON.parse(line); operations.push(request.op)
        if (request.op === 'OPEN_ROOT') controller.enqueue(encoder.encode(`${JSON.stringify({ version: 1,
          id: request.id, ok: true, value: { volumeSerial: '1', fileId: '2', createdPaths: [] } })}\n`))
        return line.length
      } },
    }
    const client = new OpenCodeWindowsPublicationAuthorityClient({
      deadline: Date.now() + 100, launch: () => child,
    })
    await client.openRoot('C:\\safe', false, false)
    await expect(client.namespaceList('.')).rejects.toThrow('unavailable [redacted]')
    await client.physicalSettlement
    expect(operations).toEqual(['OPEN_ROOT', 'NS_LIST'])
    expect(kills).toBe(1)
  }, 3_000)
  test('cancels a caller wait without killing its pending retained physical operation', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>; let kills = 0
    const encoder = new TextEncoder(); const abort = new AbortController()
    const child = { pid: 123, stdout: new ReadableStream<Uint8Array>({ start(value) { controller = value } }),
      exited: new Promise<number>(() => {}), unref() {}, kill() { kills += 1 },
      stdin: { end() {}, flush() { return 0 }, write(line: string) { const request = JSON.parse(line)
        if (request.op === 'OPEN_ROOT') controller.enqueue(encoder.encode(`${JSON.stringify({ version: 1,
          id: request.id, ok: true, value: { volumeSerial: '1', fileId: '2', createdPaths: [] } })}\n`))
        return line.length } } }
    const client = new OpenCodeWindowsPublicationAuthorityClient({ deadline: Date.now() + 5_000,
      signal: abort.signal, launch: () => child })
    await client.openRoot('C:\\safe', false, false)
    const pending = client.syncRoot(); await new Promise(resolve => setTimeout(resolve, 0)); abort.abort()
    await expect(pending).rejects.toThrow('unavailable [redacted]'); expect(kills).toBe(0)
    client.kill(); expect(kills).toBe(1)
  })
  test('lets delayed retained creation settle before queued rollback within cleanup reserve', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>
    let resolveExit!: (code: number) => void
    let kills = 0; let closes = 0; let exited = false
    const encoder = new TextEncoder(); const requests: Record<string, unknown>[] = []
    const materializations = new Set<string>()
    const exit = (code: number) => {
      if (exited) return
      exited = true; try { controller.close() } catch {}; resolveExit(code)
    }
    const reply = (request: Record<string, unknown>, value: unknown) => controller.enqueue(encoder.encode(
      `${JSON.stringify({ version: 1, id: request.id, ok: true, value })}\n`,
    ))
    const child = {
      pid: 123,
      stdout: new ReadableStream<Uint8Array>({ start(value) { controller = value } }),
      exited: new Promise<number>(resolve => { resolveExit = resolve }),
      unref() {},
      kill() { kills += 1; exit(-1) },
      stdin: { end() { closes += 1; exit(0) }, flush() { return 0 }, write(line: string) {
        const request = JSON.parse(line) as Record<string, unknown>; requests.push(request)
        if (request.op === 'OPEN_ROOT') {
          reply(request, { volumeSerial: '1', fileId: '2', createdPaths: [] })
        } else if (request.op === 'ROLLBACK_DIRECTORY') {
          materializations.delete(String(request.root_key)); reply(request, {})
        } else if (request.op === 'CLOSE') reply(request, {})
        return line.length
      } },
    }
    const abort = new AbortController(); const deadline = Date.now() + 80
    const client = new OpenCodeWindowsPublicationAuthorityClient({ deadline, signal: abort.signal,
      launch: () => child })
    await client.openRoot('C:\\safe', false, false)
    const creation = client.createDirectory('plugins.snapshot-attempt')
    while (!requests.some(request => request.op === 'CREATE_DIRECTORY')) {
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    const createRequest = requests.find(request => request.op === 'CREATE_DIRECTORY')!
    abort.abort(new Error('cancel while native creation is in flight'))
    await expect(creation).rejects.toThrow('unavailable [redacted]')
    const rollback = client.rollbackDirectory('plugins.snapshot-attempt')
    await new Promise(resolve => setTimeout(resolve, Math.max(1, deadline - Date.now() + 25)))
    expect(Date.now()).toBeGreaterThan(deadline)
    expect(kills).toBe(0)
    materializations.add('plugins.snapshot-attempt')
    reply(createRequest, { volumeSerial: '1', fileId: '5' })
    await rollback
    expect(materializations).toEqual(new Set())
    expect(requests.map(request => request.op)).toEqual([
      'OPEN_ROOT', 'CREATE_DIRECTORY', 'ROLLBACK_DIRECTORY',
    ])
    await client.close(); await client.physicalSettlement
    expect(requests.map(request => request.op)).toEqual([
      'OPEN_ROOT', 'CREATE_DIRECTORY', 'ROLLBACK_DIRECTORY', 'CLOSE',
    ])
    expect(kills).toBe(0); expect(closes).toBe(1)
  })
  test('rejects unsafe Win32 roots and leaves without publishing them to native stdin', async () => {
    const process = fake(); const client = new OpenCodeWindowsPublicationAuthorityClient({
      deadline: Date.now() + 5_000, launch: () => process.child,
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
      deadline: Date.now() + 5_000, launch: () => process.child,
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
      deadline: Date.now() + 5_000, launch: () => process.child,
    })
    await client.openRoot('C:\\safe', false, false)
    await expect(client.recoverAtomic('.auth.recovery-required', 'rollback')).resolves.toBe(true)
    await client.close()
    expect(process.requests[1]).toMatchObject({ op: 'RECOVER_ATOMIC',
      recovery_name: '.auth.recovery-required', decision: 'rollback' })
  })
  test('materializes descendants only through retained parent and file tokens', async () => {
    const process = fake(); const client = new OpenCodeWindowsPublicationAuthorityClient({
      deadline: Date.now() + 5_000, launch: () => process.child,
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
      deadline: Date.now() + 5_000, launch: () => process.child,
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
      deadline: Date.now() + 5_000, launch: () => process.child,
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
      deadline: Date.now() + 5_000, launch: () => process.child,
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
  test('treats committed durability-unknown as committed and clears it after a later barrier', async () => {
    const process = fake(0, true, 'NS_RENAME'); const client = new OpenCodeWindowsPublicationAuthorityClient({
      deadline: Date.now() + 5_000, launch: () => process.child,
    })
    await client.openRoot('C:\\safe', false, false)
    await expect(client.namespaceRename('old', 'new')).resolves.toBeUndefined()
    expect(client.namespaceDurabilityUnknown).toBe(true)
    await expect(client.namespaceSyncDirectory('.')).resolves.toBeUndefined()
    expect(client.namespaceDurabilityUnknown).toBe(false)
    await client.close()
  })
  test('continues a committed partial tree transition at the retained old root', async () => {
    const process = fake(0, true, undefined, 2); const client = new OpenCodeWindowsPublicationAuthorityClient({
      deadline: Date.now() + 5_000, launch: () => process.child,
    })
    await client.openRoot('C:\\safe', false, false)
    await expect(client.namespaceRemoveTree('nested/retired')).resolves.toBeUndefined()
    expect(process.operations).toEqual(['OPEN_ROOT', 'NS_REMOVE_TREE', 'NS_REMOVE_TREE', 'NS_REMOVE_TREE'])
    expect(client.namespaceDurabilityUnknown).toBe(false)
    await client.close()
  })
  test('rejects malformed retained namespace paths without writing protocol frames', async () => {
    const process = fake(); const client = new OpenCodeWindowsPublicationAuthorityClient({
      deadline: Date.now() + 5_000, launch: () => process.child,
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
      deadline: Date.now() + 5_000, launch: () => process.child,
    })
    await client.openRoot('C:\\safe', false, false)
    await client.namespaceAcquireLock('owner.lock', {
      stale: 10_000, update: 1_000, retries: { retries: 0, minTimeout: 1, maxTimeout: 1 },
    }, abort.signal)
    abort.abort(); await new Promise(resolve => setTimeout(resolve, 0))
    expect(process.operations).toEqual(['OPEN_ROOT', 'NS_ACQUIRE_LOCK', 'NS_RELEASE_LOCK'])
    await client.close()
  })
  test('retries with bounded physical reserve and stops writing after cancellation', async () => {
    const process = fake(2); const abort = new AbortController(); const deadline = Date.now() + 500
    const client = new OpenCodeWindowsPublicationAuthorityClient({ deadline, signal: abort.signal,
      launch: () => process.child })
    await client.openRoot('C:\\safe', false, false)
    const acquisition = client.namespaceAcquireLock('owner.lock', {
      stale: 10_000, update: 1_000, retries: { retries: 5, minTimeout: 40, maxTimeout: 40 },
    }, abort.signal)
    while (process.requests.filter(request => request.op === 'NS_ACQUIRE_LOCK').length < 2) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    abort.abort(new Error('late publication abort'))
    await expect(acquisition).rejects.toThrow('unavailable [redacted]')
    const attempts = process.requests.filter(request => request.op === 'NS_ACQUIRE_LOCK')
    expect(attempts).toHaveLength(2)
    expect(Number(attempts[1]!.wait_ms)).toBeLessThan(Number(attempts[0]!.wait_ms))
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(process.requests.filter(request => request.op === 'NS_ACQUIRE_LOCK')).toHaveLength(2)
    expect(Math.max(...process.requests.map(request => Number(request.wait_ms))))
      .toBeLessThanOrEqual(1_500)
  })
  test('retains namespace authority beyond a one-second work tail and fences it at owner expiry', async () => {
    const originalNow = Date.now
    const originalTimeout = globalThis.setTimeout
    let now = originalNow() + 10_000
    const delays: number[] = []
    Date.now = () => now
    globalThis.setTimeout = ((handler: Parameters<typeof setTimeout>[0], timeout?: number, ...args: unknown[]) => {
      delays.push(Number(timeout)); return originalTimeout(handler, timeout, ...args)
    }) as typeof setTimeout
    const process = fake()
    const workDeadline = now + 1_000
    const ownerDeadline = now + 4_000
    const client = new OpenCodeWindowsPublicationAuthorityClient({ deadline: ownerDeadline,
      launch: () => process.child })
    try {
      await client.openRoot('C:\\safe', false, false)
      expect(delays).toContain(5_000)
      now = workDeadline + 1_501
      await expect(client.namespaceSyncDirectory('.')).resolves.toBeUndefined()
      expect(process.kills()).toBe(0)
      now = ownerDeadline
      await expect(client.namespaceSyncDirectory('.')).rejects.toThrow('unavailable [redacted]')
    } finally {
      Date.now = originalNow
      globalThis.setTimeout = originalTimeout
      client.kill()
    }
  })
})
