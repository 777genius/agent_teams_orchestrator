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
            : request.op === 'CREATE_DIRECTORY' || request.op === 'RENAME_DIRECTORY' || request.op === 'OPEN_CHILD_DIRECTORY'
              || request.op === 'CREATE_CHILD_DIRECTORY' || request.op === 'CREATE_CHILD_FILE'
              ? { volumeSerial: '1', fileId: '5' }
              : request.op === 'WRITE_CHILD_FILE'
                ? { written: String(request.offset + Buffer.from(request.content_base64, 'base64').length), finished: request.finish }
                : {}
      controller.enqueue(encoder.encode(`${JSON.stringify({ version: 1, id: request.id, ok: true, value })}\n`)); return line.length
    } } }
  return { child, kills: () => kills, closes: () => closes, operations, requests }
}

describe('OpenCodeWindowsPublicationAuthorityClient', () => {
  test('keeps cancellation connected and marks recovery after physical settlement', async () => {
    const process = fake(); const abort = new AbortController()
    const client = new OpenCodeWindowsPublicationAuthorityClient({ deadline: performance.now() + 5_000,
      signal: abort.signal, launch: () => process.child })
    await expect(client.openRoot('C:\\root', false, false)).resolves.toMatchObject({ fileId: '2' })
    abort.abort(); await new Promise(resolve => setTimeout(resolve, 0))
    await expect(client.pinRegular('passive-status.sqlite3')).rejects.toThrow('unavailable [redacted]')
    await client.close(); await client.close(); expect(process.kills()).toBe(1); expect(process.closes()).toBe(1)
    expect(process.operations).toEqual(['OPEN_ROOT', 'MARK_RECOVERY_REQUIRED'])
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
})
