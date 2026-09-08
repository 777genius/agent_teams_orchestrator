import { afterEach, describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { connect, createServer, type Socket } from 'node:net'
import { join } from 'node:path'
import { isHostedControlSocketBrokerLegacyArgs, runHostedControlSocketBrokerLegacy } from './HostedControlSocketBrokerLegacy.js'
import { runHostedControlSocketBroker } from './HostedControlSocketBroker.js'
import { killSocketBroker, listenLoopback, startSocketBrokerLegacy } from './HostedControlServerPublication.js'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  const errors: unknown[] = []
  for (const close of cleanup.splice(0).reverse()) {
    try { await bounded(close()) } catch (error) { errors.push(error) }
  }
  if (errors.length) throw new AggregateError(errors, 'legacy fixture cleanup failed')
})

function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([promise, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('legacy fixture timed out')), 4_000)
  })]).finally(() => clearTimeout(timer))
}

async function root(): Promise<string> {
  const path = await mkdtemp('/tmp/hc-legacy-')
  cleanup.push(() => rm(path, { recursive: true, force: true }))
  return path
}

async function target() {
  const peers = new Set<Socket>()
  const inputs: Buffer[] = []
  const server = createServer(socket => {
    peers.add(socket)
    socket.on('error', () => undefined)
    socket.once('close', () => peers.delete(socket))
    let bytes = Buffer.alloc(0)
    socket.on('data', chunk => {
      bytes = Buffer.concat([bytes, chunk])
      if (bytes.length === 32 + 6) {
        inputs.push(bytes)
        socket.end('legacy-reply\n')
      } else if (bytes.length > 38) socket.destroy()
    })
  })
  await listenLoopback(server)
  cleanup.push(async () => {
    for (const peer of peers) peer.destroy()
    await bounded(new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  })
  return { port: (server.address() as { port: number }).port, inputs }
}

async function exchange(path: string): Promise<string> {
  const socket = connect(path)
  let bytes = ''
  try {
    return await bounded(new Promise<string>((resolve, reject) => {
      socket.once('connect', () => socket.write('hello\n'))
      socket.on('data', chunk => { bytes += chunk.toString() })
      socket.once('end', () => resolve(bytes))
      socket.once('error', reject)
    }))
  } finally { socket.destroy() }
}

describe('explicit accepted 3bf legacy broker (not native qualification)', () => {
  test('keeps accepted argv validation, including Number conversion, separate from native', async () => {
    for (const args of [[], ['/tmp/a'], ['/tmp/a', '0'], ['/tmp/a', '65536'], ['', '1'],
      ['/tmp/a', '1.5'], ['/tmp/a', 'NaN'], ['/tmp/a', '2', 'extra']]) {
      expect(isHostedControlSocketBrokerLegacyArgs(args)).toBe(false)
      await expect(runHostedControlSocketBrokerLegacy(args)).rejects.toThrow('arguments')
    }
    for (const port of ['1', '65535', '0x10', ' 2 ', '1e2']) {
      const args = ['/tmp/a', port]
      expect(isHostedControlSocketBrokerLegacyArgs(args)).toBe(true)
      await expect(runHostedControlSocketBroker(args)).rejects.toThrow('only its private batch')
    }
  })

  test('actual raw32/schema1 launcher forwards one credential and preserves caller token', async () => {
    const path = join(await root(), 'a.sock')
    const endpoint = await target()
    const token = Buffer.alloc(32, 71)
    let response = ''
    const child = await startSocketBrokerLegacy(path, endpoint.port, token, {
      afterSpawn: broker => broker.stdout!.on('data', chunk => { response += chunk.toString() }),
    })
    cleanup.push(() => killSocketBroker(child))
    expect(child.spawnargs.slice(-2)).toEqual([path, String(endpoint.port)])
    expect(response).toBe('{"schemaVersion":1,"kind":"ready"}\n')
    expect(await exchange(path)).toBe('legacy-reply\n')
    expect(endpoint.inputs).toEqual([Buffer.concat([token, Buffer.from('hello\n')])])
    await killSocketBroker(child)
    await killSocketBroker(child)
    expect(token).toEqual(Buffer.alloc(32, 71))
    expect(() => process.kill(child.pid!, 0)).toThrow()
  }, 10_000)

  test('accepted schema1 parser rejects schema2, trailing records and oversized responses', async () => {
    const entrypoint = new URL('./fixtures/hostedControlSocketBrokerLegacyResponseChild.ts', import.meta.url).pathname
    for (const [response, error] of [
      ['{"schemaVersion":2,"kind":"ready","count":1}\n', 'response was invalid'],
      ['{"schemaVersion":1,"kind":"ready"}\nextra\n', 'response was invalid'],
      [' '.repeat(257), 'response was oversized'],
    ]) {
      let closed = false
      await expect(startSocketBrokerLegacy(response!, 1, Buffer.alloc(32, 61), {
        entrypoint,
        afterSpawn: child => child.once('close', () => { closed = true }),
      })).rejects.toThrow(error!)
      expect(closed).toBe(true)
    }
  }, 15_000)

  test('historical actual-owner flag dispatch reaches legacy with accepted argv', async () => {
    const path = join(await root(), 'a.sock')
    const endpoint = await target()
    const token = Buffer.alloc(32, 83)
    const entry = new URL('../../../scripts/e2e/hosted-actual-owner-owner.ts', import.meta.url).pathname
    const child = spawn(process.execPath, [entry, '--hosted-control-socket-broker', path, String(endpoint.port)], {
      stdio: ['pipe', 'pipe', 'inherit', 'pipe'],
    })
    cleanup.push(() => killSocketBroker(child))
    const ready = bounded(new Promise<string>((resolve, reject) => {
      let bytes = ''
      child.stdout!.on('data', chunk => { bytes += chunk.toString(); if (bytes.includes('\n')) resolve(bytes) })
      child.once('error', reject)
      child.once('exit', () => reject(new Error('legacy dispatch exited before readiness')))
    }))
    const pipe = child.stdio[3]!
    if (!('end' in pipe)) throw new Error('missing credential pipe')
    pipe.end(token)
    expect(await ready).toBe('{"schemaVersion":1,"kind":"ready"}\n')
    expect(await exchange(path)).toBe('legacy-reply\n')
    expect(endpoint.inputs).toEqual([Buffer.concat([token, Buffer.from('hello\n')])])
  }, 10_000)

  test('legacy rejects non-raw32 and native rejects raw32 without retry or publication', async () => {
    const dir = await root()
    const endpoint = await target()
    for (const [fixture, args, bytes] of [
      ['hostedControlSocketBrokerLegacyChild.ts', [join(dir, 'short.sock'), String(endpoint.port)], Buffer.alloc(31)],
      ['hostedControlSocketBrokerLegacyChild.ts', [join(dir, 'frame.sock'), String(endpoint.port)], Buffer.concat([Buffer.from('HCB2'), Buffer.alloc(64)])],
      ['hostedControlSocketBrokerChild.ts', [], Buffer.alloc(32, 71)],
    ] as const) {
      const child = spawn(process.execPath, [new URL(`./fixtures/${fixture}`, import.meta.url).pathname, ...args], {
        stdio: ['pipe', 'pipe', 'ignore', 'pipe'],
      })
      cleanup.push(() => killSocketBroker(child))
      let stdout = ''
      child.stdout!.on('data', chunk => { stdout += chunk.toString() })
      const closed = bounded(new Promise<void>((resolve, reject) => {
        child.once('close', () => resolve())
        child.once('error', reject)
      }))
      const pipe = child.stdio[3]!
      pipe.on('error', () => undefined)
      if (!('end' in pipe)) throw new Error('missing credential pipe')
      pipe.end(bytes)
      await closed
      expect(stdout).toBe('')
      expect(child.exitCode !== 0).toBe(true)
      expect(await readdir(dir)).toEqual([])
      expect(endpoint.inputs).toEqual([])
    }
  }, 15_000)
})
