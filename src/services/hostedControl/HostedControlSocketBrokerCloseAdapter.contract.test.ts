import { expect, mock, spyOn, test } from 'bun:test'

// ISOLATED PROCESS ONLY: startup/custody dependencies are scripted, not native
// qualifications. Execute this file alone. Broker callback bodies and the queue
// are imported unchanged; no source extraction or replica of the close algorithm.
test('real broker close adapter retains same-pair suffix until drain (callback contract)', async () => {
  let downstream: any, upstream: any
  let bound = false
  let batch: Buffer
  let ready!: () => void, failed!: (error: unknown) => void
  const published = new Promise<void>((resolve, reject) => { ready = resolve; failed = reject })
  const events: string[] = []
  const request: Buffer[] = [], response: Buffer[] = []
  const stat = { dev: 1, ino: 2, mode: 0o700, uid: process.getuid?.(), gid: process.getgid?.(),
    isDirectory: () => true, isSymbolicLink: () => false, isSocket: () => true }
  mock.module('node:fs', () => ({
    closeSync() {},
    lstatSync(path: string) {
      if (path === '/contract/0.sock') {
        if (!bound) throw Object.assign(new Error('absent'), { code: 'ENOENT' })
        return { ...stat, ino: 3, mode: 0o600 }
      }
      return stat
    },
    writeSync(_fd: number, text: string) { if (text.includes('"kind":"ready"')) ready(); return Buffer.byteLength(text) },
  }))
  mock.module('./HostedControlSocketBrokerAssociation.js', () => ({
    requireSocketBrokerAssociation() {}, pinSocketBrokerPath() { return { fd: 90, probePath: '/contract/0.sock' } },
  }))
  mock.module('./HostedControlSocketBrokerDescriptors.js', () => ({
    async readSocketBrokerDescriptor(_fd: number, bytes: Buffer) { bytes.set(batch); return batch.length },
    async proveSocketBrokerSelfPeer(_path: string, nonce: Buffer, _deadline: number, accepted: Promise<void>) {
      const probe = { pause() {}, resume() {}, terminate() {} }
      downstream.open(probe); downstream.data(probe, nonce); downstream.end(probe)
      await accepted
    },
  }))
  const once = spyOn(process, 'once').mockImplementation((() => process) as any)
  const stdinResume = spyOn(process.stdin, 'resume').mockImplementation(() => process.stdin)
  const stdinOnce = spyOn(process.stdin, 'once').mockImplementation(() => process.stdin)
  const kill = spyOn(process, 'kill').mockImplementation(() => { throw new Error('Unexpected broker termination') })
  const mask = spyOn(process, 'umask').mockImplementation(() => 0o022)
  const listen = spyOn(Bun, 'listen').mockImplementation(((options: any) => {
    bound = true; downstream = options.socket; return { ref() {} }
  }) as any)
  let short = true
  const client = {
    pause() { events.push('client-pause') }, resume() { events.push('client-resume') },
    write(bytes: Buffer) {
      const accepted = short ? 3 : bytes.length
      response.push(Buffer.from(bytes.subarray(0, accepted)))
      events.push(`response-write:${accepted}/${bytes.length}`)
      return accepted
    },
    shutdown(read: boolean) { expect(read).toBe(false); events.push('response-FIN'); downstream.drain(client) },
    end() { events.push('client-end'); downstream.close(client) },
    terminate() { events.push('client-terminate'); downstream.close(client) },
  }
  const source = {
    pause() { events.push('source-pause') }, resume() { events.push('source-resume') },
    write(bytes: Buffer) { request.push(Buffer.from(bytes)); return bytes.length },
    shutdown(read: boolean) { expect(read).toBe(false); events.push('request-FIN') },
    end() { events.push('source-end'); upstream.close(source) },
    terminate() { events.push('source-terminate'); upstream.close(source) },
  }
  const connect = spyOn(Bun, 'connect').mockImplementation(((options: any) => {
    upstream = options.socket; upstream.open(source); return Promise.resolve(source)
  }) as any)
  const { SocketBrokerWriteQueue } = await import('./HostedControlSocketBrokerTransport.js')
  const closeSource = SocketBrokerWriteQueue.prototype.closeSource
  const detach = spyOn(SocketBrokerWriteQueue.prototype, 'closeSource').mockImplementation(function (this: any) {
    closeSource.call(this)
    if (this.source === source) events.push('response-closeSource')
  })
  try {
    const { encodeSocketBrokerBatch, runHostedControlSocketBroker } = await import('./HostedControlSocketBroker.js')
    const token = Buffer.alloc(32, 41), input = Buffer.from('request')
    batch = encodeSocketBrokerBatch([{ listenPath: '/contract/0.sock', targetPort: 12345, token,
      parentIdentity: { device: 1, inode: 2 } }])
    void runHostedControlSocketBroker([]).catch(failed)
    await published
    downstream.open(client)
    downstream.data(client, input); downstream.end(client)
    expect(Buffer.concat(request)).toEqual(Buffer.concat([token, input]))
    expect(events.filter(event => event === 'request-FIN')).toHaveLength(1)
    const payload = Buffer.from('retained-response-suffix'), expected = Buffer.from(payload)
    upstream.data(source, payload)
    payload.fill(0) // real queue owns retained callback bytes
    expect(Buffer.concat(response)).toEqual(expected.subarray(0, 3))
    expect(events.at(-1)).toBe(`response-write:3/${expected.length}`)
    events.push('clean-close-entry')
    upstream.close(source, undefined) // actual production adapter, same source
    expect(Buffer.concat(response)).toEqual(expected.subarray(0, 3))
    expect(events.filter(event => event === 'response-FIN')).toHaveLength(0)
    short = false
    events.push('external-drain')
    downstream.drain(client)
    expect(Buffer.concat(response)).toEqual(expected)
    const tail = events.slice(events.indexOf('clean-close-entry'))
    expect(tail).toEqual(['clean-close-entry', 'response-closeSource', 'external-drain',
      `response-write:${expected.length - 3}/${expected.length - 3}`, 'response-FIN', 'client-end'])
    // Terminal callback reentry and duplicate wakes cannot emit another byte/FIN.
    downstream.drain(client); upstream.end(source)
    await new Promise<void>(resolve => queueMicrotask(resolve))
    expect(events.slice(events.indexOf('clean-close-entry'))).toEqual(tail)
    expect(events.filter(event => event.includes('terminate'))).toEqual([])
    console.log('BROKER_CLOSE_ADAPTER_CONTRACT', JSON.stringify({ coverage: 'scripted callbacks / real broker and queue; NOT native EOF', events }))
  } finally {
    for (const spy of [detach, connect, listen, mask, kill, stdinOnce, stdinResume, once]) spy.mockRestore()
    mock.restore()
  }
}, 1000)
