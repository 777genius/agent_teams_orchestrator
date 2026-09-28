import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { connect, createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { once } from 'node:events'

import { HostedOwnerFdTransport, type HostedOwnerToolRequest } from './HostedOwnerFdTransport.js'

function frame(value: unknown): Buffer {
  const bytes = Buffer.from(JSON.stringify(value), 'utf8')
  const result = Buffer.alloc(4 + bytes.length)
  result.writeUInt32BE(bytes.length, 0)
  bytes.copy(result, 4)
  return result
}

function fakeFd() {
  const ownerToPlugin = new PassThrough()
  const pluginToOwner = new PassThrough()
  const transport = new HostedOwnerFdTransport(ownerToPlugin, pluginToOwner)
  const request = new Promise<HostedOwnerToolRequest>(resolve => {
    let buffer = Buffer.alloc(0)
    pluginToOwner.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.length >= 4 && buffer.length >= buffer.readUInt32BE(0) + 4) {
        resolve(JSON.parse(buffer.subarray(4, buffer.readUInt32BE(0) + 4).toString('utf8')))
      }
    })
  })
  return { ownerToPlugin, pluginToOwner, transport, request }
}

const input = {
  tool: 'hosted_task_get' as const,
  context: { sessionID: 'ses_1', messageID: 'msg_1', callID: 'call_1' },
  args: { taskId: `task_${'a'.repeat(32)}` },
}

describe('HostedOwnerFdTransport', () => {
  test('sends a bounded framed request and accepts only its correlated reply', async () => {
    const fd = fakeFd()
    const result = fd.transport.exchange(input)
    const request = await fd.request
    expect(request).toMatchObject({ version: 1, type: 'request', ...input })
    expect(request.requestId).toMatch(/^[0-9a-f-]{36}$/)
    const reply = frame({ version: 1, type: 'response', requestId: request.requestId, ok: true, result: 'task data' })
    fd.ownerToPlugin.write(reply.subarray(0, 3))
    fd.ownerToPlugin.write(reply.subarray(3))
    expect(await result).toBe('task data')
  })

  test('rejects mismatched reply and remains closed', async () => {
    const fd = fakeFd()
    const result = fd.transport.exchange(input)
    await fd.request
    fd.ownerToPlugin.write(frame({ version: 1, type: 'response', requestId: 'wrong', ok: true, result: 'bad' }))
    await expect(result).rejects.toThrow('response mismatch')
    await expect(fd.transport.exchange(input)).rejects.toThrow('response mismatch')
  })

  test('rejects EOF and oversized frames without an Owner effect', async () => {
    const eof = fakeFd()
    const eofResult = eof.transport.exchange(input)
    await eof.request
    eof.ownerToPlugin.end()
    await expect(eofResult).rejects.toThrow('FD closed')

    const large = fakeFd()
    const largeResult = large.transport.exchange(input)
    await large.request
    const prefix = Buffer.alloc(4)
    prefix.writeUInt32BE(64 * 1024 + 1, 0)
    large.ownerToPlugin.write(prefix)
    await expect(largeResult).rejects.toThrow('frame size invalid')
  })

  test('rejects oversized request before writing a frame', async () => {
    const fd = fakeFd()
    let writes = 0
    fd.pluginToOwner.on('data', () => { writes++ })
    await expect(fd.transport.exchange({ ...input, args: { text: 'x'.repeat(70_000) } }))
      .rejects.toThrow('request too large')
    expect(writes).toBe(0)
  })

  test('aborted queued call sends zero bytes after the preceding call completes', async () => {
    const fd = fakeFd()
    let writes = 0
    fd.pluginToOwner.on('data', () => { writes++ })
    const first = fd.transport.exchange(input)
    const firstRequest = await fd.request
    const controller = new AbortController()
    const second = fd.transport.exchange({ ...input, context: { ...input.context, callID: 'call_2' } }, controller.signal)
    controller.abort()
    fd.ownerToPlugin.write(frame({
      version: 1, type: 'response', requestId: firstRequest.requestId, ok: true, result: 'first done',
    }))
    expect(await first).toBe('first done')
    await expect(second).rejects.toThrow('Hosted tool call aborted')
    expect(writes).toBe(1)
  })

  test('failure and dispose destroy fake streams exactly once', async () => {
    const ownerToPlugin = new PassThrough()
    const pluginToOwner = new PassThrough()
    const transport = new HostedOwnerFdTransport(ownerToPlugin, pluginToOwner)
    const pending = transport.exchange(input)
    await new Promise<void>(resolve => pluginToOwner.once('data', () => resolve()))
    ownerToPlugin.end()
    await expect(pending).rejects.toThrow('FD closed')
    transport.dispose()
    expect(ownerToPlugin.destroyed).toBe(true)
    expect(pluginToOwner.destroyed).toBe(true)
  })

  test('one real Unix socket owns both directions and disposal closes the peer', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hosted-owner-fd-'))
    const socketPath = join(directory, 'owner.sock')
    const server = createServer()
    let peer: Socket | null = null
    let owned: Socket | null = null
    try {
      server.listen(socketPath)
      await once(server, 'listening')
      const accepted = new Promise<Socket>(resolve => server.once('connection', resolve))
      peer = connect(socketPath)
      await once(peer, 'connect')
      owned = await accepted
      const transport = new HostedOwnerFdTransport(owned, owned)
      const request = new Promise<HostedOwnerToolRequest>(resolve => {
        let bytes = Buffer.alloc(0)
        peer!.on('data', chunk => {
          bytes = Buffer.concat([bytes, chunk])
          if (bytes.length >= 4 && bytes.length >= 4 + bytes.readUInt32BE(0)) {
            resolve(JSON.parse(bytes.subarray(4, 4 + bytes.readUInt32BE(0)).toString('utf8')))
          }
        })
      })
      const result = transport.exchange(input)
      const sent = await request
      peer.write(frame({ version: 1, type: 'response', requestId: sent.requestId, ok: true, result: 'ok' }))
      expect(await result).toBe('ok')
      const peerEnded = once(peer, 'end')
      transport.dispose()
      transport.dispose()
      await peerEnded
      expect(owned.destroyed).toBe(true)
      await expect(transport.exchange(input)).rejects.toThrow('disposed')
    } finally {
      peer?.destroy()
      owned?.destroy()
      await new Promise<void>(resolve => server.close(() => resolve()))
      await rm(directory, { recursive: true, force: true })
    }
  })
})
