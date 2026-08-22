import { describe, expect, test } from 'bun:test'
import { OpenCodeWindowsPublicationAuthorityClient } from './OpenCodeWindowsPublicationAuthorityClient.js'

function fake() {
  let controller!: ReadableStreamDefaultController<Uint8Array>; let kills = 0; let closes = 0; const operations: string[] = []
  const encoder = new TextEncoder(); const stdout = new ReadableStream<Uint8Array>({ start(value) { controller = value } })
  const child = { pid: 123, stdout, exited: new Promise<number>(() => {}), unref() {},
    kill() { kills += 1; try { controller.close() } catch {} },
    stdin: { end() { closes += 1 }, write(line: string) {
      const request = JSON.parse(line); operations.push(request.op); const value = request.op === 'OPEN_ROOT'
        ? { volumeSerial: '1', fileId: '2', createdPaths: [] }
        : request.op === 'PIN_REGULAR' || request.op === 'PIN_REGULAR_READONLY'
          ? { volumeSerial: '1', fileId: '3', size: '4' } : {}
      controller.enqueue(encoder.encode(`${JSON.stringify({ version: 1, id: request.id, ok: true, value })}\n`)); return line.length
    } } }
  return { child, kills: () => kills, closes: () => closes, operations }
}

describe('OpenCodeWindowsPublicationAuthorityClient', () => {
  test('retains across cancellation and closes exactly once', async () => {
    const process = fake(); const abort = new AbortController()
    const client = new OpenCodeWindowsPublicationAuthorityClient({ deadline: performance.now() + 5_000,
      signal: abort.signal, launch: () => process.child })
    await expect(client.openRoot('C:\\root', false, false)).resolves.toMatchObject({ fileId: '2' })
    abort.abort(); await expect(client.pinRegular('passive-status.sqlite3')).resolves.toMatchObject({ size: '4' })
    await client.close(); await client.close(); expect(process.kills()).toBe(1); expect(process.closes()).toBe(1)
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
})
