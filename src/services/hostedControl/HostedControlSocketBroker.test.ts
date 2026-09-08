import { afterEach, describe, expect, test } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, timingSafeEqual } from 'node:crypto'
import { chmod, lstat, mkdtemp, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { join } from 'node:path'
import { EndpointWriter, closeArgument, constrainSockets, patterned, retainUnixEOF, signal, type WriteObservation } from './fixtures/hostedControlBrokerPressureHelpers.js'
import { encodeSocketBrokerBatch, type SocketBrokerMapping } from './HostedControlSocketBroker.js'
import { closeServer, killSocketBroker, startSocketBroker, startSocketBrokerBatch,
  type SocketBrokerBatch, type SocketBrokerBorrow, type SocketBrokerLaunchForTest } from './HostedControlServerPublication.js'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  const errors: unknown[] = []
  for (const close of cleanup.splice(0).reverse()) { try { await close() } catch (error) { errors.push(error) } }
  if (errors.length) throw errors[0]
})

const observedChildren = new WeakMap<ChildProcess, { exited: boolean; closed: boolean }>()
function observeChild(child: ChildProcess) {
  const state = { exited: false, closed: false }
  observedChildren.set(child, state)
  child.once('exit', () => { state.exited = true })
  child.once('close', () => { state.closed = true })
  return state
}
const batchChildren = new WeakMap<SocketBrokerBatch, ChildProcess>()
async function waitUntil(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('Actual resource transition was not observed')
    await new Promise(resolve => setTimeout(resolve, 2))
  }
}
function expectChildClosed(child: ChildProcess): void {
  expect(observedChildren.get(child)).toEqual({ exited: true, closed: true })
  expect(() => process.kill(child.pid!, 0)).toThrow()
}

async function fixture() {
  const root = await mkdtemp('/tmp/hc-batch-')
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const stat = await lstat(root)
  const parentIdentity = { device: stat.dev, inode: stat.ino }
  const tokens = [Buffer.alloc(32, 41), Buffer.alloc(32, 73)]
  const targets: Array<{ server: Bun.Listener; peers: Set<Bun.Socket>; accepted: Bun.Socket[];
    closedPeers: Set<Bun.Socket>; closed: boolean; fins: number; replies: number; close: () => Promise<void> }> = []
  const ports = await Promise.all(tokens.map(async (expected, index) => {
    const peers = new Set<Bun.Socket>()
    const target = { server: null! as Bun.Listener, peers, accepted: [] as Bun.Socket[],
      closedPeers: new Set<Bun.Socket>(), closed: false, fins: 0, replies: 0, close: async () => {} }
    targets[index] = target
    type TargetState = { bytes: Buffer; writer: EndpointWriter; timer?: ReturnType<typeof setTimeout> }
    const states = new Map<Bun.Socket, TargetState>()
    // The pinned Node accept wrapper also constructs the target's Duplex with
    // allowHalfOpen:false. Exercise a real native target with creation-time
    // half-open policy, retaining the same credential check and delayed reply.
    const server = Bun.listen({
      hostname: '127.0.0.1', port: 0, allowHalfOpen: true,
      socket: {
        open(socket) {
          peers.add(socket)
          target.accepted.push(socket)
          const writer = new EndpointWriter(socket, undefined, () => socket.end())
          states.set(socket, { bytes: Buffer.alloc(0), writer })
        },
        data(socket, chunk) {
          const state = states.get(socket)!
          if (state.bytes.length + chunk.length > 1024 * 1024) { socket.terminate(); return }
          state.bytes = Buffer.concat([state.bytes, chunk])
          if (state.bytes.length < 32) return
          if (!timingSafeEqual(state.bytes.subarray(0, 32), expected)) socket.terminate()
        },
        end(socket) {
          const state = states.get(socket)!
          const bytes = state.bytes
          target.fins += 1
          if (bytes.length < 32 || !timingSafeEqual(bytes.subarray(0, 32), expected) ||
            !bytes.subarray(32).toString().includes('\n')) { socket.terminate(); return }
          // A positive reply is deliberately impossible until AFTER request FIN.
          state.timer = setTimeout(() => {
            target.replies += 1
            state.writer.push(Buffer.from(`target-${index}:${bytes.subarray(32).toString()}`))
            state.writer.end()
          }, 25)
        },
        drain(socket) { states.get(socket)?.writer.drain() },
        close(socket) {
          const state = states.get(socket)
          clearTimeout(state?.timer)
          state?.writer.stop()
          state?.bytes.fill(0)
          states.delete(socket)
          peers.delete(socket)
          target.closedPeers.add(socket)
        },
        error(socket) { socket.terminate() },
      },
    })
    target.server = server
    const port = server.port
    target.close = async () => {
      if (target.closed) return
      server.stop(true) // fixture owns this TCP listener; no UDS pathname effects
      await waitUntil(() => peers.size === 0)
      // Observe actual listener shutdown, not just a boolean set after stop.
      await expect(Bun.connect({ hostname: '127.0.0.1', port, socket: {
        open(socket) { socket.terminate() }, data() {}, connectError() {},
      } })).rejects.toThrow()
      target.closed = true
    }
    cleanup.push(target.close)
    return port
  }))
  const mappings: SocketBrokerMapping[] = ports.map((targetPort, index) => ({
    listenPath: join(root, `${index}.sock`), targetPort, token: tokens[index]!, parentIdentity,
  }))
  const assertTargetsClosed = async () => {
    // The broker owns upstream peers; fixture target listeners remain caller-owned.
    await waitUntil(() => targets.every(target => target.peers.size === 0))
    for (const target of targets) {
      expect(target.closedPeers.size).toBe(target.accepted.length)
      expect(target.accepted.every(peer => target.closedPeers.has(peer))).toBe(true)
      await target.close()
      expect(target.closed).toBe(true)
    }
  }
  return { root, mappings, tokens, targets, assertTargetsClosed }
}

async function launch(mappings: readonly SocketBrokerMapping[]): Promise<SocketBrokerBatch> {
  let child!: ChildProcess
  const batch = await startSocketBrokerBatch(mappings, { afterSpawn: spawned => {
    child = spawned
    observeChild(child)
  } })
  batchChildren.set(batch, child)
  cleanup.push(() => batch.release())
  return batch
}

function borrow(batch: SocketBrokerBatch, index: number, lost: () => void = () => undefined): SocketBrokerBorrow {
  const slot = batch.borrow(index, lost)
  cleanup.push(() => slot.release())
  return slot
}

// Use the documented native SHUT_WR primitive for the actual request FIN.
// The pinned net _final invokes internal @end then immediately calls back;
// that callback does not establish native drain or response-half survival.
// Keep a terminal record so relay and request assertions cannot outrun I/O.
async function halfOpenConnection(path: string) {
  const state = { socket: null! as Bun.Socket, ended: false, closed: false,
    error: null as Error | null, response: '' }
  let finish!: () => void
  const terminal = new Promise<void>(resolve => { finish = resolve })
  let pending: { bytes: Buffer; offset: number } | undefined
  const flush = (socket: Bun.Socket) => {
    if (!pending) return
    const n = socket.write(pending.bytes.subarray(pending.offset))
    if (n < 0) throw new Error('Test route closed before request FIN')
    pending.offset += n
    if (pending.offset === pending.bytes.length) {
      pending = undefined
      socket.shutdown(false)
    }
  }
  state.socket = await Bun.connect({ unix: path, allowHalfOpen: true, socket: {
    data(_socket, bytes) { state.response += bytes.toString() },
    drain(socket) { flush(socket) },
    end(socket) { state.ended = true; socket.end() },
    close() { state.closed = true; finish() },
    error(socket, error) { state.error = error; socket.terminate() },
    connectError() {},
  } })
  return { state, terminal, sendAndFinish(bytes: Buffer) {
    if (pending) throw new Error('Overlapping test writes')
    if (bytes.length === 0) { state.socket.shutdown(false); return }
    pending = { bytes, offset: 0 }; flush(state.socket)
  } }
}

async function request(path: string, input = 'hello\n'): Promise<string> {
  const route = await halfOpenConnection(path)
  const timeout = setTimeout(() => {
    route.state.error = new Error('Broker exchange timed out')
    route.state.socket.terminate()
  }, 2000)
  try {
    route.sendAndFinish(Buffer.from(input)) // actual early FIN, retain read half
    await route.terminal
    if (route.state.error) throw route.state.error
    return route.state.response
  } finally { clearTimeout(timeout); route.state.socket.terminate() }
}

async function absent(path: string): Promise<void> {
  await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' })
}

// Both variants preserve a usable route to the original listener. The proxy
// relays a 32-byte nonce and FIN verbatim and keeps the probe-facing read half
// open, so nonce-only proof would register its foreign inode before B fails.
async function relaySubstitution(mode: 'retained-alias' | 'preconnected'): Promise<void> {
  const { mappings, root, targets, assertTargetsClosed } = await fixture()
  const path = mappings[0]!.listenPath
  const alias = `${path}.retained`
  const occupiedPath = mappings[1]!.listenPath
  await writeFile(occupiedPath, 'occupied B: preserve contents', { mode: 0o600 })
  const occupied = await lstat(occupiedPath)
  if (mode === 'preconnected') await writeFile(`${path}.preconnect`, '')
  let child!: ChildProcess
  let records = ''
  const outcome = startSocketBrokerBatch(mappings, {
    entrypoint: new URL('./fixtures/hostedControlSocketBrokerPausedChild.ts', import.meta.url).pathname,
    afterSpawn: spawned => {
      child = spawned
      const state = observeChild(child)
      cleanup.push(async () => { if (!state.closed) await killSocketBroker(child) })
      child.stdout!.on('data', chunk => { records += chunk.toString() })
    },
  }).then(batch => { cleanup.push(() => batch.release()); return null }, error => error as Error)
  await waitUntil(() => lstat(`${path}.bound`).then(() => true, () => false))
  const original = await lstat(path)
  const relayPeers = new Set<Socket>()
  const track = (socket: Socket) => {
    relayPeers.add(socket)
    socket.on('error', () => undefined)
    socket.once('close', () => relayPeers.delete(socket))
    return socket
  }
  cleanup.push(async () => { for (const peer of relayPeers) peer.destroy() })
  let preconnected: Awaited<ReturnType<typeof halfOpenConnection>> | undefined
  const routes: Array<Awaited<ReturnType<typeof halfOpenConnection>>> = []
  cleanup.push(async () => { for (const route of routes) route.state.socket.terminate(); await Promise.all(routes.map(route => route.terminal)) })
  if (mode === 'retained-alias') {
    await rename(path, alias)
    expect((await lstat(alias)).ino).toBe(original.ino)
  } else {
    preconnected = await halfOpenConnection(path)
    routes.push(preconnected)
    expect(preconnected.state.closed).toBe(false)
    await unlink(path) // no surviving pathname; the connected route stays live
  }
  let connections = 0
  let receivedBytes = 0
  const observedProxyPeers: Array<{ ended: boolean; closed: boolean }> = []
  const replacement = createServer({ allowHalfOpen: true }, socket => {
    socket.allowHalfOpen = true
    const terminal = { ended: false, closed: false }
    observedProxyPeers.push(terminal)
    socket.once('close', () => { terminal.closed = true })
    connections += 1
    track(socket)
    let bytes = Buffer.alloc(0)
    socket.on('data', chunk => { receivedBytes += chunk.length; bytes = Buffer.concat([bytes, chunk]) })
    socket.once('end', () => {
      terminal.ended = true
      if (bytes.length !== 32) { socket.end('foreign proxy reachable'); return }
      void (async () => {
        const upstream = preconnected ?? await halfOpenConnection(alias)
        if (!preconnected) routes.push(upstream)
        upstream.sendAndFinish(bytes) // exactly nonce + SHUT_WR to the ORIGINAL
      })().catch(() => socket.destroy())
      // Deliberately do not end/destroy socket on the original's FIN/close.
    })
  })
  await new Promise<void>((resolve, reject) => {
    replacement.once('error', reject)
    replacement.listen(path, resolve)
  })
  cleanup.push(async () => {
    for (const peer of relayPeers) peer.destroy()
    await closeServer(replacement)
  })
  await chmod(path, 0o600)
  const foreign = await lstat(path)
  expect(foreign.ino).not.toBe(original.ino)
  expect(foreign.uid).toBe(original.uid) // same UID is deliberately insufficient
  expect(await request(path, '')).toBe('foreign proxy reachable')
  const beforeProbe = connections
  await writeFile(`${path}.continue`, '')
  expect(await outcome).toMatchObject({ message: 'Hosted control socket broker exited before readiness' })
  expectChildClosed(child)
  await waitUntil(() => connections > beforeProbe)
  expect(records).toBe('')
  // Credentials are checked before the nonce is exposed to the foreign peer.
  // Wait for this actual probe's terminal event, not merely child death or
  // connection acceptance. Count ALL data, including partial input/reset.
  await waitUntil(() => observedProxyPeers.length > beforeProbe &&
    observedProxyPeers.slice(beforeProbe).every(peer => peer.closed))
  expect(receivedBytes).toBe(0)
  const retained = await lstat(path)
  expect([retained.dev, retained.ino, retained.mode, retained.uid, retained.gid])
    .toEqual([foreign.dev, foreign.ino, foreign.mode, foreign.uid, foreign.gid])
  expect(replacement.listening).toBe(true)
  expect(await request(path, '')).toBe('foreign proxy reachable')
  expect((await lstat(occupiedPath)).ino).toBe(occupied.ino)
  expect(await readFile(occupiedPath, 'utf8')).toBe('occupied B: preserve contents')
  if (mode === 'retained-alias') {
    expect((await lstat(alias)).ino).toBe(original.ino)
  } else {
    // Closing the listener with an accept still in its backlog may reset the
    // preconnection; an accepted half-open peer instead reports EOF.
    await preconnected!.terminal
    expect(preconnected!.state.closed).toBe(true)
    expect(targets.every(target => target.accepted.length === 0)).toBe(true)
    preconnected!.state.socket.terminate()
  }
  expect((await readdir(root)).sort()).toEqual([
    '0.sock', '0.sock.bound', '0.sock.continue',
    ...(mode === 'retained-alias' ? ['0.sock.retained'] : ['0.sock.preconnect']), '1.sock',
  ])
  await assertTargetsClosed()
}

describe('actual hosted control socket broker batch', () => {
  test('two distinct credential forwarders share one child and explicit independent borrows', async () => {
    const { mappings, tokens, root, targets, assertTargetsClosed } = await fixture()
    const batch = await launch(mappings)
    expect(targets.every(target => !target.closed)).toBe(true)
    expect(batchChildren.get(batch)!.pid).toBe(batch.pid)
    const a = borrow(batch, 0)
    const b = borrow(batch, 1)
    expect(a.pid).toBe(batch.pid)
    expect(b.pid).toBe(batch.pid)
    expect(a.identity).not.toEqual(b.identity)
    expect(() => batch.borrow(0, () => undefined)).toThrow('unavailable')
    expect(() => batch.borrow(2, () => undefined)).toThrow('unavailable')
    for (const [index, mapping] of mappings.entries()) {
      const stat = await lstat(mapping.listenPath)
      expect(stat.mode & 0o777).toBe(0o600)
      expect(stat.isSocket()).toBe(true)
      expect(await request(mapping.listenPath)).toBe(`target-${index}:hello\n`)
    }
    expect(targets.map(target => target.fins)).toEqual([1, 1])
    expect(targets.map(target => target.replies)).toEqual([1, 1])
    await batch.release()
    expect(() => batch.borrow(0, () => undefined)).toThrow('unavailable')
    await a.release()
    await a.release()
    expect(a.isCurrent()).toBe(false)
    expect(b.isCurrent()).toBe(true)
    expect(observedChildren.get(batchChildren.get(batch)!)!.closed).toBe(false)
    expect(tokens[0]!.equals(Buffer.alloc(32, 41))).toBe(true)
    expect(tokens[1]!.equals(Buffer.alloc(32, 73))).toBe(true)
    expect(await request(mappings[1]!.listenPath)).toBe('target-1:hello\n')
    await b.release()
    expect(batch.isCurrent()).toBe(false)
    expect(() => process.kill(batch.pid, 0)).toThrow()
    await Promise.all(mappings.map(mapping => absent(mapping.listenPath)))
    expectChildClosed(batchChildren.get(batch)!)
    expect(await readdir(root)).toEqual([])
    await assertTargetsClosed()
  })

  test('swapped and wrong forwarding credentials are denied by the distinct targets', async () => {
    for (const swapped of [true, false]) {
      const { mappings, tokens, root, assertTargetsClosed } = await fixture()
      const wrong = mappings.map((mapping, index) => ({ ...mapping,
        token: swapped ? tokens[1 - index]! : Buffer.alloc(32, 91 + index) }))
      const batch = await launch(wrong)
      for (const mapping of mappings) expect(await request(mapping.listenPath)).toBe('')
      await batch.release()
      expectChildClosed(batchChildren.get(batch)!)
      expect(await readdir(root)).toEqual([])
      await assertTargetsClosed()
    }
  })

  test('singleton helper caller uses the same private versioned batch', async () => {
    const { mappings, root, assertTargetsClosed } = await fixture()
    const mapping = mappings[0]!
    const child = await startSocketBroker(mapping.listenPath, mapping.targetPort, mapping.token)
    cleanup.push(() => killSocketBroker(child))
    observeChild(child)
    expect(child.spawnargs).not.toContain(mapping.listenPath)
    expect(child.spawnargs.join(' ')).not.toContain(mapping.token.toString('hex'))
    expect(await request(mapping.listenPath)).toBe('target-0:hello\n')
    await killSocketBroker(child)
    expectChildClosed(child)
    // Historical singleton callers retain pathname cleanup responsibility.
    expect(await readdir(root)).toEqual(['0.sock'])
    await assertTargetsClosed()
  })

  test('rejects count, duplicate path/port/token and invalid credentials before any launch', async () => {
    const { mappings, root, assertTargetsClosed } = await fixture()
    const a = mappings[0]!, b = mappings[1]!
    let spawns = 0
    for (const invalid of [[], [a, b, a], [a, a], [a, { ...b, targetPort: a.targetPort }],
      [a, { ...b, token: Buffer.from(a.token) }], [a, { ...b, token: Buffer.alloc(31) }],
      [a, { ...b, listenPath: join(root, 'nested', '..', '0.sock') }]]) {
      await expect(startSocketBrokerBatch(invalid, { afterSpawn: () => { spawns += 1 } })).rejects.toThrow()
    }
    expect(await readdir(root)).toEqual([])
    expect(spawns).toBe(0)
    await assertTargetsClosed()
  })

  test('a later bind failure cleans the first acquired inode and preserves the occupied path', async () => {
    const { mappings, root, assertTargetsClosed } = await fixture()
    await writeFile(mappings[1]!.listenPath, 'do not replace', { mode: 0o600 })
    const existing = await lstat(mappings[1]!.listenPath)
    let child!: ChildProcess
    await expect(startSocketBrokerBatch(mappings, { afterSpawn: spawned => { child = spawned; observeChild(child) } })).rejects.toThrow('before readiness')
    expectChildClosed(child)
    await absent(mappings[0]!.listenPath)
    expect((await lstat(mappings[1]!.listenPath)).ino).toBe(existing.ino)
    expect(await readdir(root)).toEqual(['1.sock'])
    await assertTargetsClosed()
  })

  test('substitution before A registration with B occupied never authorizes removal of the replacement', async () => {
    const { mappings, root, assertTargetsClosed } = await fixture()
    const path = mappings[0]!.listenPath
    await writeFile(mappings[1]!.listenPath, 'occupied B', { mode: 0o600 })
    const occupied = await lstat(mappings[1]!.listenPath)
    let child!: ChildProcess
    let records = ''
    const forTest: SocketBrokerLaunchForTest = {
      entrypoint: new URL('./fixtures/hostedControlSocketBrokerPausedChild.ts', import.meta.url).pathname,
      afterSpawn: spawned => {
        child = spawned
        observeChild(child)
        cleanup.push(() => killSocketBroker(child))
        child.stdout!.on('data', chunk => { records += chunk.toString() })
      },
    }
    const outcome = startSocketBrokerBatch(mappings, forTest).then(batch => {
      cleanup.push(() => batch.release())
      return null
    }, error => error as Error)
    await waitUntil(() => lstat(`${path}.bound`).then(() => true, () => false))
    const original = await lstat(path)
    await unlink(path)
    const replacement = createServer({ allowHalfOpen: true }, socket => {
      socket.allowHalfOpen = true
      socket.on('error', () => undefined)
      let bytes = Buffer.alloc(0)
      socket.on('data', chunk => { bytes = Buffer.concat([bytes, chunk]) })
      // Even echoing the ownership nonce is not proof of THIS broker listener.
      socket.once('end', () => socket.end(bytes.length === 32 ? bytes : 'replacement'))
    })
    await new Promise<void>((resolve, reject) => { replacement.once('error', reject); replacement.listen(path, resolve) })
    cleanup.push(() => closeServer(replacement))
    await chmod(path, 0o600)
    const foreign = await lstat(path)
    expect(foreign.ino).not.toBe(original.ino)
    await writeFile(`${path}.continue`, '')
    expect(await outcome).toMatchObject({ message: 'Hosted control socket broker exited before readiness' })
    expectChildClosed(child)
    expect(records).toBe('') // unproved observations never enter parent cleanup authority
    const retained = await lstat(path)
    expect([retained.dev, retained.ino, retained.mode, retained.uid, retained.gid])
      .toEqual([foreign.dev, foreign.ino, foreign.mode, foreign.uid, foreign.gid])
    expect((await lstat(mappings[1]!.listenPath)).ino).toBe(occupied.ino)
    expect(replacement.listening).toBe(true)
    expect(await request(path, '')).toBe('replacement')
    await unlink(`${path}.bound`)
    await unlink(`${path}.continue`)
    expect((await readdir(root)).sort()).toEqual(['0.sock', '1.sock'])
    await assertTargetsClosed()
  })

  test('retained alias and forwarding cannot register a foreign A with B occupied', async () => {
    await relaySubstitution('retained-alias')
  })

  test('preconnected nonce and FIN relay cannot register a foreign A after unlink with B occupied', async () => {
    await relaySubstitution('preconnected')
  })

  test('foreign-first stat and original-for-probe swap cannot authorize foreign-second-stat cleanup', async () => {
    const { mappings, root, targets, assertTargetsClosed } = await fixture()
    const path = mappings[0]!.listenPath, alias = `${path}.original`, parked = `${path}.foreign`
    const occupiedPath = mappings[1]!.listenPath
    await writeFile(occupiedPath, 'occupied B survives exact swaps', { mode: 0o600 })
    const occupied = await lstat(occupiedPath)
    await writeFile(`${path}.swap`, '')
    let child!: ChildProcess
    let records = ''
    const outcome = startSocketBrokerBatch(mappings, {
      entrypoint: new URL('./fixtures/hostedControlSocketBrokerPausedChild.ts', import.meta.url).pathname,
      afterSpawn: spawned => {
        child = spawned
        const state = observeChild(child)
        cleanup.push(async () => { if (!state.closed) await killSocketBroker(child) })
        child.stdout!.on('data', chunk => { records += chunk.toString() })
      },
    }).then(batch => { cleanup.push(() => batch.release()); return null }, error => error as Error)
    await waitUntil(() => lstat(`${path}.bound`).then(() => true, () => false))
    const original = await lstat(path)
    await rename(path, alias)
    const foreignPeers = new Set<Socket>()
    let foreignConnections = 0, foreignReceivedBytes = 0, foreignClosed = 0
    const foreignServer = createServer({ allowHalfOpen: true }, socket => {
      socket.allowHalfOpen = true
      foreignPeers.add(socket)
      foreignConnections += 1
      socket.on('data', bytes => { foreignReceivedBytes += bytes.length })
      socket.once('close', () => { foreignPeers.delete(socket); foreignClosed += 1 })
      socket.on('error', () => undefined)
      socket.resume()
      socket.once('end', () => socket.end('foreign exact-swap listener'))
    })
    await new Promise<void>((resolve, reject) => {
      foreignServer.once('error', reject); foreignServer.listen(path, resolve)
    })
    cleanup.push(async () => { for (const socket of foreignPeers) socket.destroy(); await closeServer(foreignServer) })
    await chmod(path, 0o600)
    const foreign = await lstat(path)
    expect(foreign.ino).not.toBe(original.ino)
    expect(await request(path, '')).toBe('foreign exact-swap listener')
    const beforeProbe = foreignConnections
    await writeFile(`${path}.continue`, '')
    await waitUntil(() => lstat(`${path}.first-stat`).then(() => true, () => false))
    // The broker has actually observed F. Restore A solely for connect,
    // kernel peer PID, and receipt by the exact A nonce callback.
    await rename(path, parked)
    await rename(alias, path)
    expect((await lstat(path)).ino).toBe(original.ino)
    await writeFile(`${path}.first-stat.continue`, '')
    await waitUntil(() => lstat(`${path}.peer-complete`).then(() => true, () => false))
    // The attempt ran with original A restored at the mutable pathname. The
    // held F must receive the connection instead; source without custody would
    // prove A successfully. Resume either outcome before testing preservation.
    await rename(path, alias)
    await rename(parked, path)
    expect((await lstat(path)).ino).toBe(foreign.ino)
    await writeFile(`${path}.peer-complete.continue`, '')
    expect(await outcome).toMatchObject({ message: 'Hosted control socket broker exited before readiness' })
    expectChildClosed(child)
    expect(records).toBe('')
    expect(await readFile(`${path}.peer-complete`, 'utf8')).toBe('false')
    await waitUntil(() => foreignConnections > beforeProbe && foreignClosed === foreignConnections)
    expect(foreignReceivedBytes).toBe(0)
    // All preservation assertions precede fixture cleanup. Under the old
    // double-lstat proof, bound(F) + occupied B authorized removal of F here.
    const retained = await lstat(path)
    expect([retained.dev, retained.ino, retained.mode, retained.uid, retained.gid])
      .toEqual([foreign.dev, foreign.ino, foreign.mode, foreign.uid, foreign.gid])
    expect(foreignServer.listening).toBe(true)
    expect(await request(path, '')).toBe('foreign exact-swap listener')
    expect((await lstat(alias)).ino).toBe(original.ino)
    expect((await lstat(occupiedPath)).ino).toBe(occupied.ino)
    expect(await readFile(occupiedPath, 'utf8')).toBe('occupied B survives exact swaps')
    expect(targets.every(target => target.accepted.length === 0)).toBe(true)
    await waitUntil(() => foreignPeers.size === 0)
    expect((await readdir(root)).sort()).toEqual([
      '0.sock', '0.sock.bound', '0.sock.continue', '0.sock.first-stat',
      '0.sock.first-stat.continue', '0.sock.original', '0.sock.peer-complete',
      '0.sock.peer-complete.continue', '0.sock.swap', '1.sock',
    ])
    await assertTargetsClosed()
  })

  test('actual child waits for delayed fragmented private input and FIN before binding', async () => {
    const { mappings, root, assertTargetsClosed } = await fixture()
    const child = spawn(process.execPath,
      [new URL('./fixtures/hostedControlSocketBrokerPausedChild.ts', import.meta.url).pathname, 'read'],
      { stdio: ['pipe', 'pipe', 'pipe', 'pipe'] })
    const state = observeChild(child)
    cleanup.push(async () => { if (!state.closed) await killSocketBroker(child) })
    let output = ''
    let errors = ''
    child.stdout!.on('data', chunk => { output += chunk.toString() })
    child.stderr!.on('data', chunk => { errors += chunk.toString() })
    const channel = child.stdio[3]!
    if (!('write' in channel)) throw new Error('Missing private channel')
    const writeErrors: unknown[] = []
    channel.on('error', error => { writeErrors.push(error) })
    await waitUntil(() => output.startsWith('reading\n'))
    const payload = encodeSocketBrokerBatch(mappings)
    for (const part of [payload.subarray(0, 2), payload.subarray(2)]) {
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(state.exited).toBe(false)
      channel.write(part)
    }
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(state.exited).toBe(false)
    expect(output).toBe('reading\n')
    expect(await readdir(root)).toEqual([])
    channel.end()
    await waitUntil(() => output.includes('"kind":"ready"'))
    payload.fill(0)
    expect(writeErrors).toEqual([])
    expect(errors).toBe('')
    expect(output.trim().split('\n').slice(1).map(line => JSON.parse(line).kind))
      .toEqual(['bound', 'bound', 'ready'])
    for (const [index, mapping] of mappings.entries()) {
      expect(await request(mapping.listenPath)).toBe(`target-${index}:hello\n`)
    }
    await killSocketBroker(child)
    expectChildClosed(child)
    // This direct child caller has not delegated pathname cleanup to a batch.
    expect((await readdir(root)).sort()).toEqual(['0.sock', '1.sock'])
    await assertTargetsClosed()
  })

  test('last release preserves a substituted hidden socket and its private mode', async () => {
    const { mappings, root, assertTargetsClosed } = await fixture()
    const batch = await launch(mappings)
    const path = mappings[0]!.listenPath
    await unlink(path)
    const replacement = createServer({ allowHalfOpen: true }, socket => {
      socket.allowHalfOpen = true
      socket.on('error', () => undefined)
      socket.resume()
      socket.once('end', () => socket.end('replacement'))
    })
    await new Promise<void>((resolve, reject) => { replacement.once('error', reject); replacement.listen(path, resolve) })
    cleanup.push(() => closeServer(replacement))
    await chmod(path, 0o600)
    const before = await lstat(path)
    await batch.release()
    const after = await lstat(path)
    expect([after.dev, after.ino, after.mode]).toEqual([before.dev, before.ino, before.mode])
    expect(await request(path, '')).toBe('replacement')
    await absent(mappings[1]!.listenPath)
    expectChildClosed(batchChildren.get(batch)!)
    expect(await readdir(root)).toEqual(['0.sock'])
    await assertTargetsClosed()
  })

  test('shared child loss invalidates both attached borrows exactly once', async () => {
    const { mappings, root, assertTargetsClosed } = await fixture()
    const batch = await launch(mappings)
    const losses = [0, 0]
    let finish!: () => void
    const lost = new Promise<void>(resolve => { finish = resolve })
    const a = borrow(batch, 0, () => { losses[0] = losses[0]! + 1 })
    const b = borrow(batch, 1, () => { losses[1] = losses[1]! + 1; finish() })
    await batch.release()
    process.kill(batch.pid, 'SIGKILL')
    await lost
    expect(a.isCurrent()).toBe(false)
    expect(b.isCurrent()).toBe(false)
    expect(losses).toEqual([1, 1])
    await Promise.all([a.release(), b.release()])
    await Promise.all(mappings.map(mapping => absent(mapping.listenPath)))
    expectChildClosed(batchChildren.get(batch)!)
    expect(await readdir(root)).toEqual([])
    await assertTargetsClosed()
  })

  test('actual child rejects malformed private batches and legacy argv credentials', async () => {
    const { mappings, root, assertTargetsClosed } = await fixture()
    const valid = encodeSocketBrokerBatch(mappings)
    const wrongVersion = Buffer.from(valid); wrongVersion[3] = 49
    const wrongCount = Buffer.from(valid); wrongCount[4] = 3
    const zeroCount = Buffer.from(valid); zeroCount[4] = 0
    const duplicateToken = Buffer.from(valid)
    mappings[0]!.token.copy(duplicateToken, duplicateToken.length - 32)
    const duplicatePort = Buffer.from(valid)
    const secondHeader = 5 + 20 + Buffer.byteLength(mappings[0]!.listenPath) + 32
    duplicatePort.writeUInt16BE(mappings[0]!.targetPort, secondHeader + 2)
    for (const [payload, args] of [[wrongVersion, []], [wrongCount, []], [zeroCount, []],
      [duplicateToken, []], [duplicatePort, []], [Buffer.alloc(4097), []], [valid.subarray(0, valid.length - 1), []],
      [Buffer.concat([valid, Buffer.from([0])]), []], [valid, ['legacy-path', '1']]] as const) {
      const child = spawn(process.execPath, [new URL('./fixtures/hostedControlSocketBrokerChild.ts', import.meta.url).pathname, ...args],
        { stdio: ['pipe', 'pipe', 'pipe', 'pipe'] })
      const state = observeChild(child)
      cleanup.push(async () => { if (!state.closed) await killSocketBroker(child) })
      const exited = new Promise<void>((resolve, reject) => { child.once('close', () => resolve()); child.once('error', reject) })
      let output = ''
      child.stdout!.on('data', chunk => { output += chunk.toString() })
      child.stderr!.on('data', chunk => { output += chunk.toString() })
      const channel = child.stdio[3]!
      if (!('write' in channel)) throw new Error('Missing private channel')
      channel.on('error', () => undefined)
      channel.end(payload)
      await exited
      expect(output).toBe('')
      expectChildClosed(child)
      expect(await readdir(root)).toEqual([])
    }
    valid.fill(0)
    await assertTargetsClosed()
  })
})

type PressureRecord = {
  kind: string; id?: number; direction?: string; mapping?: string | number; requested?: number; accepted?: number
  sequence: number; eventTime: number; closeArgument?: ReturnType<typeof closeArgument>
  read?: boolean
  sizes?: number[]; execPath?: string; version?: string
}

// One wall-clock deadline covers setup, barriers, traffic, and terminal events.
// Readiness is exclusively callback/diagnostic driven; predicates have no effects.
async function pressureScenario(mode: 'complete' | 'client-abort' | 'target-abort' | 'child-loss' | 'orderly-shutdown') {
  let phase = 'setup'
  let snapshotFailure = (_reason: string) => {}
  let notificationCloseExpected = false
  let fixtureError: Error | undefined
  let expire!: (error: Error) => void
  const deadline = { promise: new Promise<never>((_resolve, reject) => {
    expire = error => { fixtureError ??= error; snapshotFailure(String(error)); reject(error) }
  }) }
  const timer = setTimeout(() => expire(new Error(`Pressure deadline: ${mode} at ${phase}`)), 12_000)
  const within = <T>(promise: Promise<T>) => Promise.race([promise, deadline.promise])
  let expireCleanup!: (error: Error) => void
  const cleanupDeadline = new Promise<never>((_resolve, reject) => { expireCleanup = reject })
  void cleanupDeadline.catch(() => {})
  const cleanupTimer = setTimeout(() => expireCleanup(new Error('Pressure cleanup deadline')), 14_000)
  const closing = <T>(promise: Promise<T>) => Promise.race([promise, cleanupDeadline])
  const disposers: Array<() => Promise<unknown>> = []
  cleanup.push(async () => {
    const errors: unknown[] = []
    if (phase !== 'complete') snapshotFailure('before cleanup')
    notificationCloseExpected = true
    try {
      for (const dispose of disposers.reverse()) {
        try { await closing(dispose()) } catch (error) { errors.push(error) }
      }
    } finally { clearTimeout(timer); clearTimeout(cleanupTimer) }
    if (errors.length) throw errors[0]
    if (fixtureError) throw fixtureError
  })
  const root = await mkdtemp('/tmp/hc-pressure-')
  disposers.push(() => rm(root, { recursive: true, force: true }))
  const stat = await lstat(root)
  const records: PressureRecord[] = []
  const waiters: Array<{ predicate: () => boolean; resolve: () => void }> = []
  const observe = (record: PressureRecord) => {
    records.push(record)
  }
  const evaluateWaiters = () => {
    for (const waiter of [...waiters]) if (waiter.predicate()) {
      waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve()
    }
  }
  const until = (predicate: () => boolean) => {
    if (predicate()) return Promise.resolve()
    return within(new Promise<void>(resolve => { waiters.push({ predicate, resolve }) }))
  }
  const targets = [0, 1].map(index => {
    const accepted = signal<Bun.Socket>(), fin = signal(), terminal = signal()
    const input = patterned(192 * 1024, 11 + index)
    const output = patterned(768 * 1024, 91 + index)
    const token = Buffer.alloc(32, 41 + index * 32)
    const chunks: Buffer[] = [], writes: WriteObservation[] = []
    const closeArguments: ReturnType<typeof closeArgument>[] = [], errors: string[] = []
    let peer: Bun.Socket | undefined, writer: EndpointWriter | undefined
    let closed = false, ended = false, replied = false, lateData = 0, aborting = false
    const server = Bun.listen({ hostname: '127.0.0.1', port: 0, allowHalfOpen: true, socket: {
      open(socket) {
        if (peer) { socket.terminate(); throw new Error('Unexpected extra target connection') }
        peer = socket
        constrainSockets(server.port)
        socket.pause()
        writer = new EndpointWriter(socket, value => writes.push(value), () => socket.end())
        accepted.resolve(socket)
      },
      data(_socket, bytes) { if (closed) lateData++; chunks.push(Buffer.from(bytes)) },
      end(socket) { ended = true; fin.resolve(); if (aborting) socket.end() },
      drain() { writer?.drain() },
      close(_socket, ...args: unknown[]) {
        const argument = closeArgument(args[0]); closeArguments.push(argument)
        if (argument.argumentKind !== 'undefined') errors.push(JSON.stringify(argument))
        closed = true; writer?.stop(); terminal.resolve()
      },
      error(socket, error) { errors.push(String(error)); socket.terminate() },
    } })
    const sizes = constrainSockets(server.port) // constrain before TCP handshake
    disposers.push(async () => {
      server.stop(true)
      if (peer) await closing(terminal.promise)
    })
    return { server, input, output, token, chunks, writes, sizes, accepted, fin, terminal, closeArguments, errors,
      get peer() { return peer! }, get closed() { return closed },
      get lateData() { return lateData }, get replied() { return replied },
      get replyFinished() { return writer?.finSent ?? false },
      abortExpected() { aborting = true },
      reply() {
        expect(ended).toBe(true)
        expect(replied).toBe(false)
        replied = true; writer!.push(output); writer!.end()
      },
    }
  })
  let clientObservations = () => [] as object[]
  disposers.push(async () => {
    console.log('BROKER_PRESSURE_OBSERVATIONS', JSON.stringify({ mode, phase, records, clients: clientObservations(),
      ingestion: ingestionSnapshot(),
      targetCloseArguments: targets.map(target => target.closeArguments), targetErrors: targets.map(target => target.errors),
      targetWrites: targets.map(target => target.writes), targetBufferSizes: targets.map(target => target.sizes) }))
  })
  const mappings = targets.map((target, index) => ({ listenPath: join(root, `${index}.sock`),
    targetPort: target.server.port, token: target.token,
    parentIdentity: { device: stat.dev, inode: stat.ino } }))
  let child!: ChildProcess
  const childClosed = signal()
  const evidencePath = join(root, 'native-writes.jsonl')
  const entrypoint = join(root, 'pressure-child.ts')
  await writeFile(evidencePath, '')
  if (mode === 'orderly-shutdown') {
    await writeFile(entrypoint, `process.env.HCB_PRESSURE_ORDERLY = '1';\nawait import(${JSON.stringify(new URL('./fixtures/hostedControlSocketBrokerPressureChild.ts', import.meta.url).pathname)})\n`)
  } else {
    await writeFile(entrypoint, `import ${JSON.stringify(new URL('./fixtures/hostedControlSocketBrokerPressureChild.ts', import.meta.url).pathname)}\n`)
  }
  let consumedLines = 0, readStarts = 0, readCompletions = 0
  let receiptSequence = 0, notifiedSequence = 0, controlBytes = 0
  const actions: object[] = []
  let pendingControl = Buffer.alloc(0)
  const notifications: Array<{ receiptSequence: number; receiptTime: number; sequence: number;
    id: number; direction: string; mapping: string | number; requested: number; accepted: number;
    readStartTime?: number; readCompletionTime?: number; importedTime?: number }> = []
  const notificationKeys = new Set<string>()
  const ingestedKeys = new Set<string>()
  const ingestionSnapshot = () => ({ consumedLines, readStarts, readCompletions,
    watcherNotifications: 0, watcherEnabled: false, receiptSequence, notifiedSequence,
    controlBytes, pendingControlBytes: pendingControl.length, actions, notifications: notifications.map(value => ({ ...value })) })
  let failureSnapshotTaken = false
  snapshotFailure = reason => {
    if (failureSnapshotTaken) return
    failureSnapshotTaken = true
    console.log('BROKER_PRESSURE_PRE_CLEANUP', JSON.stringify({ mode, phase, reason,
      parentTime: performance.now(), ingestion: ingestionSnapshot(), records,
      clients: clientObservations(), targetWrites: targets.map(target => target.writes),
      targets: targets.map(target => ({ closed: target.closed, replied: target.replied,
        replyFinished: target.replyFinished, closeArguments: target.closeArguments, errors: target.errors })) }))
  }
  let reading = Promise.resolve()
  let ingestionError: Error | undefined
  const readEvidence = (notification?: typeof notifications[number]) => {
    reading = reading.then(async () => {
      if (notification && ingestionError) throw ingestionError
      readStarts++
      if (notification) notification.readStartTime = performance.now()
      const lines = (await readFile(evidencePath, 'utf8')).split('\n')
      readCompletions++
      if (notification) notification.readCompletionTime = performance.now()
      // The notified append completed and was fsynced before FD4 was written.
      // A missing sequence is an error, never a polling/retry opportunity.
      const through = notification?.sequence ?? lines.length - 1
      if (through > lines.length - 1 || through < consumedLines) throw new Error('Missing notified durable sequence')
      const imported: PressureRecord[] = []
      for (let index = consumedLines; index < through; index++) {
        const record = JSON.parse(lines[index]!) as PressureRecord
        if (record.sequence !== index + 1 || !Number.isFinite(record.eventTime)) throw new Error('Invalid durable sequence')
        imported.push(record)
      }
      if (notification) {
        const actual = imported.at(-1)
        if (!actual || actual.kind !== 'write' || actual.sequence !== notification.sequence ||
          actual.id !== notification.id || actual.direction !== notification.direction ||
          actual.mapping !== notification.mapping || actual.requested !== notification.requested ||
          actual.accepted !== notification.accepted) throw new Error('Notification does not match durable write')
        // A first-short notification must point at the first actual positive
        // short for this mapping/direction, including earlier durable records.
        const first = [...records, ...imported].find(record => record.kind === 'write' &&
          record.direction === notification.direction && record.mapping === notification.mapping &&
          record.accepted! > 0 && record.accepted! < record.requested!)
        if (first?.sequence !== notification.sequence) throw new Error('Notification is not first positive short')
        ingestedKeys.add(JSON.stringify([notification.direction, notification.mapping]))
        notification.importedTime = performance.now()
      }
      for (const record of imported) observe(record)
      consumedLines = through
      if (notification) evaluateWaiters()
    }).catch(error => {
      ingestionError = error instanceof Error ? error : new Error(String(error))
      expire(ingestionError)
    })
  }
  const receiveNotification = (chunk: Buffer) => {
    if (fixtureError) return
    try {
      controlBytes += chunk.length
      if (controlBytes > 2048) throw new Error('Pressure control byte bound exceeded')
      pendingControl = Buffer.concat([pendingControl, chunk])
      let newline: number
      while ((newline = pendingControl.indexOf(10)) !== -1) {
        if (newline + 1 > 512 || notifications.length >= 4) throw new Error('Pressure frame bound exceeded')
        const frame = JSON.parse(pendingControl.subarray(0, newline).toString('utf8'))
        pendingControl = pendingControl.subarray(newline + 1)
        if (!frame || Object.keys(frame).sort().join(',') !== 'accepted,direction,id,mapping,requested,sequence' ||
          !Number.isSafeInteger(frame.sequence) || frame.sequence <= notifiedSequence ||
          !Number.isSafeInteger(frame.id) || frame.id <= 0 ||
          !Number.isSafeInteger(frame.requested) || !Number.isSafeInteger(frame.accepted) ||
          !(frame.accepted > 0 && frame.accepted < frame.requested) ||
          !mappings.some(mapping => frame.direction === 'request' ? frame.mapping === mapping.targetPort :
            frame.direction === 'response' && frame.mapping === mapping.listenPath)) throw new Error('Invalid pressure notification')
        const key = JSON.stringify([frame.direction, frame.mapping])
        if (notificationKeys.has(key)) throw new Error('Duplicate pressure notification')
        notificationKeys.add(key)
        notifiedSequence = frame.sequence
        const notification = { ...frame, receiptSequence: ++receiptSequence, receiptTime: performance.now() }
        notifications.push(notification)
        readEvidence(notification)
      }
      if (pendingControl.length >= 512) throw new Error('Unterminated pressure frame exceeds bound')
    } catch (error) { expire(error instanceof Error ? error : new Error(String(error))) }
  }
  disposers.push(async () => {
    // Child teardown runs first; retain the mandatory complete final read.
    readEvidence(); await reading
    if (ingestionError) throw ingestionError
  })
  const batch = await within(startSocketBrokerBatch(mappings, {
    entrypoint, pressureNotificationPipe: true,
    afterSpawn(spawned) {
      child = spawned; observeChild(child)
      child.once('close', () => childClosed.resolve())
      // Install teardown even when startup itself fails.
      disposers.push(async () => {
        if (!observedChildren.get(child)!.closed) await killSocketBroker(child)
        await closing(childClosed.promise)
      })
      // Publication invokes this hook before sending the private FD3 batch.
      const control = child.stdio[4]
      if (!control || !('read' in control)) throw new Error('Missing pressure FD4')
      control.on('data', receiveNotification)
      control.on('error', error => expire(error))
      const checkControlEnd = () => {
        if (pendingControl.length || !notificationCloseExpected) expire(new Error('Premature pressure FD4 close'))
      }
      control.once('end', checkControlEnd)
      control.once('close', checkControlEnd)
    },
  }))
  disposers.push(() => batch.release())
  const losses = [0, 0]
  const slots = [0, 1].map(i => batch.borrow(i, () => { losses[i] = losses[i]! + 1 }))
  disposers.push(() => Promise.all(slots.map(slot => slot.release())))
  const clients = await within(Promise.all(mappings.map(async mapping => {
    const terminal = signal(), finSent = signal()
    const chunks: Buffer[] = [], writes: WriteObservation[] = []
    let ended = false, closed = false, lateData = 0, drains = 0, writer: EndpointWriter
    let eof: ReturnType<typeof retainUnixEOF> | undefined, eofRead: number | undefined
    const errors: string[] = [], closeArguments: ReturnType<typeof closeArgument>[] = []
    const socket = await Bun.connect({ unix: mapping.listenPath, allowHalfOpen: true, socket: {
      // No response exists until finish() explicitly releases the targets.
      // Keep native readiness active while our own request writer needs drain.
      open() {},
      data(_socket, bytes) { if (closed) lateData++; chunks.push(Buffer.from(bytes)) },
      drain() { drains++; writer?.drain() },
      end(socket) { ended = true; socket.end() },
      close(_socket, ...args: unknown[]) {
        const argument = closeArgument(args[0]); closeArguments.push(argument)
        if (argument.argumentKind !== 'undefined') errors.push(JSON.stringify(argument))
        closed = true; writer?.stop()
        try { eofRead = eof?.peek() } finally { eof?.release(); terminal.resolve() }
      },
      error(socket, error) { errors.push(String(error)); eof?.release(); eof = undefined; socket.terminate() }, connectError() {},
    } })
    const abort = () => { eof?.release(); eof = undefined; socket.terminate() }
    disposers.push(async () => { abort(); await closing(terminal.promise) })
    eof = retainUnixEOF(mapping.listenPath)
    writer = new EndpointWriter(socket, value => writes.push(value), () => {
      // Pause only once the complete request and real SHUT_WR have been sent;
      // reply production remains behind the external request-FIN barrier.
      socket.pause(); finSent.resolve()
    })
    return { socket, writer, chunks, writes, terminal, finSent, errors, closeArguments, abort,
      get drains() { return drains },
      get eofRead() { return eofRead },
      get ended() { return ended }, get closed() { return closed }, get lateData() { return lateData } }
  })))
  clientObservations = () => clients.map(client => ({ writes: client.writes, drains: client.drains,
    finSent: client.writer.finSent, ended: client.ended, closed: client.closed, eofRead: client.eofRead,
    errors: client.errors, closeArguments: client.closeArguments, bytes: Buffer.concat(client.chunks).length,
    sha256: createHash('sha256').update(Buffer.concat(client.chunks)).digest('hex') }))
  phase = 'target accepts'
  await within(Promise.all(targets.map(target => target.accepted.promise)))
  clients.forEach((client, index) => { client.writer.push(targets[index]!.input); client.writer.end() })
  const short = (direction: string, index: number) =>
    ingestedKeys.has(JSON.stringify([direction, direction === 'request' ? mappings[index]!.targetPort : mappings[index]!.listenPath])) &&
    records.some(record => record.kind === 'write' &&
    record.direction === direction && record.mapping === (direction === 'request' ? mappings[index]!.targetPort : mappings[index]!.listenPath) &&
    record.accepted! > 0 && record.accepted! < record.requested!)
  phase = 'both request short writes'
  await until(() => [0, 1].every(index => short('request', index)))
  // Actual input SHUT_WR occurs while both target readers are still paused and
  // each broker request has an observed native short-write suffix.
  phase = 'both client SHUT_WRs with target readers paused'
  await within(Promise.all(clients.map(client => client.finSent.promise)))
  for (const mapping of mappings) {
    const latest = records.filter(record => record.kind === 'write' && record.direction === 'request' && record.mapping === mapping.targetPort).at(-1)!
    expect(latest.accepted!).toBeLessThan(latest.requested!)
  }
  expect(targets.map(target => target.replied)).toEqual([false, false])
  expect(clients.map(client => client.ended)).toEqual([false, false])

  const verifyInput = (index: number) => {
    const target = targets[index]!, actual = Buffer.concat(target.chunks)
    const expected = Buffer.concat([target.token, target.input])
    expect(actual.equals(expected)).toBe(true)
    expect(actual.length).toBe(expected.length)
    expect(actual.indexOf(target.token)).toBe(0)
    expect(actual.indexOf(target.token, 1)).toBe(-1)
    expect(createHash('sha256').update(actual).digest('hex'))
      .toBe(createHash('sha256').update(expected).digest('hex'))
  }
  const recordAction = (action: string) => {
    actions.push({ action, parentTime: performance.now(), consumedLines,
      importedSequences: notifications.filter(value => value.importedTime !== undefined).map(value => value.sequence),
      inputFINs: clients.map(client => client.writer.finSent),
      retainedRequests: mappings.map(mapping => {
        const latest = records.filter(record => record.kind === 'write' && record.direction === 'request' &&
          record.mapping === mapping.targetPort).at(-1)
        return { mapping: mapping.targetPort, sequence: latest?.sequence,
          requested: latest?.requested, accepted: latest?.accepted,
          suffix: latest ? latest.requested! - latest.accepted! : undefined }
      }),
      ...(mode === 'orderly-shutdown' ? { retainedResponses: mappings.map(mapping => {
        const latest = records.filter(record => record.kind === 'write' && record.direction === 'response' &&
          record.mapping === mapping.listenPath).at(-1)
        return { mapping: mapping.listenPath, id: latest?.id, sequence: latest?.sequence,
          requested: latest?.requested, accepted: latest?.accepted,
          suffix: latest ? latest.requested! - latest.accepted! : undefined }
      }) } : {}),
      targets: targets.map(target => ({ replied: target.replied, replyFinished: target.replyFinished })) })
  }
  recordAction('both request shorts imported and both client SHUT_WRs; targets still paused')
  const finish = async (indices: number[]) => {
    phase = `target request EOFs: ${indices}`
    recordAction(`resume targets: ${indices}`)
    indices.forEach(index => targets[index]!.peer.resume())
    await within(Promise.all(indices.map(index => targets[index]!.fin.promise)))
    indices.forEach(verifyInput)
    // Explicit external barrier after actual FIN, not a time-based readiness
    // assumption: both full requests have been verified before releasing replies.
    indices.forEach(index => targets[index]!.reply())
    phase = `response short writes: ${indices}`
    await until(() => indices.every(index => short('response', index)))
  }
  if (mode === 'orderly-shutdown') {
    await finish([0, 1]) // verified target request EOF + both imported response shorts
    expect(targets.map(target => target.replyFinished)).toEqual([false, false])
    for (const mapping of mappings) {
      const latest = records.filter(record => record.kind === 'write' && record.direction === 'response' &&
        record.mapping === mapping.listenPath).at(-1)!
      expect(latest.accepted!).toBeGreaterThanOrEqual(0)
      expect(latest.accepted!).toBeLessThan(latest.requested!)
    }
    await batch.release() // outstanding borrows must receive exactly one loss
    targets.forEach(target => target.abortExpected())
    phase = 'active orderly shutdown terminals'
    recordAction('scenario handled SIGTERM after request FIN and imported response pressure')
    notificationCloseExpected = true
    process.kill(batch.pid, 'SIGTERM')
    await within(childClosed.promise)
    clients.forEach(client => client.socket.resume())
    targets.forEach(target => target.peer.resume())
    await within(Promise.all([...targets.map(target => target.terminal.promise), ...clients.map(client => client.terminal.promise)]))
    expect(losses).toEqual([1, 1])
    expect(slots.map(slot => slot.isCurrent())).toEqual([false, false])
    clients.forEach((client, index) => expect(Buffer.concat(client.chunks).length).toBeLessThan(targets[index]!.output.length))
  } else if (mode === 'child-loss') {
    phase = 'child loss terminals'
    await batch.release() // borrows retain the child
    targets.forEach(target => target.abortExpected())
    recordAction('scenario SIGKILL; both targets still paused')
    notificationCloseExpected = true
    process.kill(batch.pid, 'SIGKILL')
    await within(childClosed.promise)
    // Paused sockets must be resumed to observe kernel EOF/reset.
    targets.forEach(target => target.peer.resume())
    clients.forEach(client => client.socket.resume())
    await within(Promise.all([...targets.map(target => target.terminal.promise), ...clients.map(client => client.terminal.promise)]))
    expect(losses).toEqual([1, 1])
    expect(slots.map(slot => slot.isCurrent())).toEqual([false, false])
    expect(clients.map(client => Buffer.concat(client.chunks).length)).toEqual([0, 0])
  } else {
    if (mode === 'client-abort') {
      phase = 'client abort terminals'
      targets[0]!.abortExpected()
      clients[0]!.abort()
      targets[0]!.peer.resume()
      await within(Promise.all([clients[0]!.terminal.promise, targets[0]!.terminal.promise]))
      expect(clients[0]!.chunks.length).toBe(0)
      await finish([1])
    } else {
      await finish([0, 1])
      if (mode === 'target-abort') {
        phase = 'target abort terminals'
        expect(targets[0]!.replyFinished).toBe(false)
        recordAction('scenario target abort')
        targets[0]!.peer.terminate()
        clients[0]!.socket.resume()
        await within(Promise.all([clients[0]!.terminal.promise, targets[0]!.terminal.promise]))
      }
    }
    const victimBytes = Buffer.concat(clients[0]!.chunks)
    const healthy = mode === 'complete' ? [0, 1] : [1]
    healthy.forEach(index => clients[index]!.socket.resume())
    phase = `healthy terminals: ${healthy}`
    await within(Promise.all(healthy.flatMap(index => [clients[index]!.terminal.promise, targets[index]!.terminal.promise])))
    for (const index of healthy) {
      const actual = Buffer.concat(clients[index]!.chunks), expected = targets[index]!.output
      expect(actual.equals(expected)).toBe(true)
      expect(actual.length).toBe(expected.length)
      expect(createHash('sha256').update(actual).digest('hex')).toBe(createHash('sha256').update(expected).digest('hex'))
      // Bun may close normally without end after local SHUT_WR. Preserve the
      // EOF obligation with an actual positive-length kernel receive, not a
      // close flag, byte count, or a synthesized end callback.
      expect(clients[index]!.eofRead).toBe(0)
      expect(clients[index]!.errors).toEqual([])
      expect(targets[index]!.errors).toEqual([])
      expect(targets[index]!.writes.some(write => write.accepted > 0 && write.accepted < write.requested)).toBe(true)
      expect(targets[index]!.writes.some(write => write.accepted === 0)).toBe(true)
    }
    if (mode !== 'complete') {
      expect(Buffer.concat(clients[0]!.chunks).equals(victimBytes)).toBe(true)
      expect(victimBytes.length).toBeLessThan(targets[0]!.output.length)
    }
    expect(losses).toEqual([0, 0])
    expect(slots[1]!.isCurrent()).toBe(true)
  }
  phase = 'release and evidence'
  notificationCloseExpected = true
  await within(batch.release())
  await within(slots[0]!.release()); await within(slots[0]!.release())
  if (mode !== 'orderly-shutdown') {
    if (mode !== 'child-loss') expect(slots[1]!.isCurrent()).toBe(true)
  }
  await within(slots[1]!.release()); await within(slots[1]!.release())
  await within(childClosed.promise)
  expectChildClosed(child)
  expect(targets.every(target => target.closed && target.lateData === 0)).toBe(true)
  expect(clients.every(client => client.closed && client.lateData === 0)).toBe(true)
  await Promise.all(mappings.map(mapping => absent(mapping.listenPath)))
  readEvidence(); await within(reading)
  if (ingestionError) throw ingestionError
  expect(notifications.length).toBe(mode === 'child-loss' ? 2 : mode === 'client-abort' ? 3 : 4)
  expect(ingestedKeys.size).toBe(notifications.length)
  expect(pendingControl.length).toBe(0)
  expect(records.filter(record => record.kind === 'fixture-error')).toEqual([])
  const healthy = mode === 'complete' ? [0, 1] : mode === 'child-loss' || mode === 'orderly-shutdown' ? [] : [1]
  for (const index of healthy) {
    // Exclude startup proof connections by selecting the response writer ID.
    const id = records.find(record => record.kind === 'write' && record.direction === 'response' &&
      record.mapping === mappings[index]!.listenPath)!.id
    expect(records.filter(record => record.id === id && record.kind === 'shutdown')).toMatchObject([{ read: false }])
    expect(records.filter(record => record.id === id && record.kind === 'terminate')).toEqual([])
  }
  if (mode === 'orderly-shutdown') {
    const entries = records.filter(record => record.kind === 'global-shutdown-entry')
    const terminals = records.filter(record => record.kind === 'global-shutdown-terminal')
    expect(entries.length).toBe(1)
    expect(terminals.length).toBe(1)
    const entry = entries[0]!.sequence, terminal = terminals[0]!.sequence
    expect(terminal).toBeGreaterThan(entry)
    // No output from handler entry onward, including synchronous close reentry.
    expect(records.filter(record => record.sequence > entry &&
      ['write', 'shutdown', 'resume', 'local-end', 'end', 'queue-end'].includes(record.kind))).toEqual([])
    for (const [index, mapping] of mappings.entries()) {
      const responseID = records.find(record => record.kind === 'write' && record.direction === 'response' && record.mapping === mapping.listenPath)!.id
      const requestID = records.find(record => record.kind === 'write' && record.direction === 'request' && record.mapping === mapping.targetPort)!.id
      const requestWrites = records.filter(record => record.id === requestID && record.kind === 'write')
      expect(requestWrites.reduce((sum, record) => sum + record.accepted!, 0)).toBe(targets[index]!.input.length + 32)
      const fins = records.filter(record => record.id === requestID && record.kind === 'shutdown')
      expect(fins).toMatchObject([{ read: false }])
      expect(fins[0]!.sequence).toBeLessThan(entry)
      const last = records.filter(record => record.id === responseID && record.kind === 'write').at(-1)!
      expect(last.accepted!).toBeGreaterThanOrEqual(0)
      expect(last.accepted!).toBeLessThan(last.requested!) // latest durable same-pair cursor at fence
      const accepted = records.filter(record => record.id === responseID && record.kind === 'write')
        .reduce((sum, record) => sum + record.accepted!, 0)
      const received = Buffer.concat(clients[index]!.chunks)
      expect(received.length).toBe(accepted)
      expect(received.equals(targets[index]!.output.subarray(0, accepted))).toBe(true)
      expect(records.filter(record => record.id === responseID && record.kind === 'shutdown')).toEqual([])
      for (const id of [responseID, requestID]) {
        const stopped = records.find(record => record.id === id && record.kind === 'queue-stop' && record.sequence > entry)!
        const terminate = records.find(record => record.id === id && record.kind === 'terminate' && record.sequence > entry)!
        const close = records.find(record => record.id === id && record.kind === 'close' && record.sequence > entry)!
        expect(stopped).toBeDefined(); expect(terminate).toBeDefined(); expect(close).toBeDefined()
        expect(stopped.sequence).toBeLessThan(terminate.sequence)
        expect(terminate.sequence).toBeLessThan(close.sequence)
        expect(close.sequence).toBeLessThan(terminal)
        expect(records.some(record => record.id === id && record.kind === 'queue-closeSource' &&
          record.sequence > close.sequence && record.sequence < terminal)).toBe(true)
      }
    }
  }
  expect(records.find(record => record.kind === 'runtime')).toMatchObject({ execPath: process.execPath, version: Bun.version })
  // Preserve actual zero counts (including absence); never relabel EAGAIN or
  // fabricate a syscall. The small contract suite separately forces zero wakes.
  console.log('BROKER_PRESSURE_EVIDENCE', JSON.stringify({ mode, execPath: process.execPath, version: Bun.version,
    ...(mode === 'orderly-shutdown' ? { pid: batch.pid, losses, current: slots.map(slot => slot.isCurrent()) } : {}),
    records, ingestion: ingestionSnapshot(), endpointWrites: clients.map(client => client.writes), targetWrites: targets.map(target => target.writes),
    targetBufferSizes: targets.map(target => target.sizes),
    inputFINs: clients.map(client => client.writer.finSent),
    responseEndCallbacks: clients.map(client => client.ended),
    responseEOFReads: clients.map(client => client.eofRead),
    inputBytes: targets.map(target => Buffer.concat(target.chunks).length),
    outputBytes: clients.map(client => Buffer.concat(client.chunks).length),
    zeroBrokerWrites: records.filter(record => record.kind === 'write' && record.accepted === 0).length,
    inputHashes: targets.map(target => createHash('sha256').update(Buffer.concat(target.chunks)).digest('hex')),
    outputHashes: clients.map(client => createHash('sha256').update(Buffer.concat(client.chunks)).digest('hex')),
  }))
  phase = 'complete'
  clearTimeout(timer)
}

describe('independent native broker pressure (Linux; root runs Bun 1.4.0)', () => {
  for (const mode of ['complete', 'client-abort', 'target-abort', 'child-loss'] as const) {
    test(mode, () => pressureScenario(mode), 15_000)
  }
})

// Focused root gate; the original four-case loop remains intact.
test('active orderly shutdown at response pressure after request FIN', () => pressureScenario('orderly-shutdown'), 15_000)
