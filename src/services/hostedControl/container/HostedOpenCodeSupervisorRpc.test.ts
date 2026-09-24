import { createHmac } from 'node:crypto'
import { chmod, lstat, mkdtemp, realpath, rm } from 'node:fs/promises'
import { connect, createServer, type Socket } from 'node:net'
import path from 'node:path'

import { expect, test } from 'bun:test'

import type { HostedOpenCodeContainerSupervisor } from './HostedOpenCodeContainerSupervisor.js'
import { HostedOpenCodeSupervisorRpcClient, HostedOpenCodeSupervisorRpcServer } from './HostedOpenCodeSupervisorRpc.js'

const START = { operationId: 'start_12345678', leaseId: 'lease_12345678', runId: 'run_12345678',
  teamId: 'team_12345678', laneId: 'lane_12345678', memberId: 'member_12345678' }
const HANDLE = { operationId: 'stop_12345678', handle: `opencode_${'a'.repeat(32)}`,
  generation: 'b'.repeat(32) }

function packet(value: object): Buffer {
  const bytes = Buffer.from(JSON.stringify(value))
  const output = Buffer.alloc(bytes.length + 4)
  output.writeUInt32BE(bytes.length)
  bytes.copy(output, 4)
  return output
}

async function greeting(socket: Socket): Promise<{ challenge: string }> {
  return new Promise((resolve, reject) => {
    let bytes = Buffer.alloc(0)
    const receive = (part: Buffer) => {
      bytes = Buffer.concat([bytes, part])
      if (bytes.length < 4 || bytes.length < bytes.readUInt32BE(0) + 4) return
      socket.off('data', receive)
      resolve(JSON.parse(bytes.subarray(4).toString('utf8')) as { challenge: string })
    }
    socket.on('data', receive)
    socket.once('error', reject)
  })
}

async function sendCaptured(socketPath: string, bytes: Buffer): Promise<string> {
  const socket = connect(socketPath)
  const fresh = await greeting(socket)
  socket.end(bytes)
  await new Promise<void>(resolve => {
    socket.once('close', () => resolve())
    socket.once('error', () => resolve())
  })
  return fresh.challenge
}

test('Linux supervisor RPC binds commands to a fresh server challenge without exhausting Stop', async () => {
  // Bun 1.3.11 crashes in its macOS Unix listener; the production daemon is Linux-only.
  if (process.platform !== 'linux') return
  const root = await realpath(await mkdtemp('/tmp/hosted-supervisor-rpc-'))
  await chmod(root, 0o700)
  const socketPath = path.join(root, 's.sock')
  const secret = Buffer.alloc(32, 7)
  let starts = 0
  let prepares = 0
  let preparedStarts = 0
  let lookups = 0
  let stops = 0
  const supervisor = {
    prepareMember: async () => { prepares++; return { operationId: START.operationId,
      receiptId: 'c'.repeat(32), handle: HANDLE.handle, generation: HANDLE.generation,
      connector: { pid: 123, startTicks: '456' } } },
    startPrepared: async () => { preparedStarts++; return { ...HANDLE, status: 'unresolved', effectEnabled: false } },
    start: async () => { starts++; return { ...HANDLE, status: 'unresolved', effectEnabled: false } },
    lookupStart: async () => { lookups++; return null },
    observe: async () => ({ ...HANDLE, status: 'stopped', effectEnabled: false }),
    stop: async () => { stops++; return { ...HANDLE, stopped: true, unresolved: false } },
    reconcile: async () => ({ ...HANDLE, stopped: true, unresolved: false }),
    beginEndpointUse: async () => { throw new Error('inactive-fixture') },
    endEndpointUse: async () => ({ released: false }),
  } as unknown as Pick<HostedOpenCodeContainerSupervisor, 'prepareMember' | 'startPrepared' |
    'start' | 'lookupStart' | 'observe' |
    'stop' | 'reconcile' | 'beginEndpointUse' | 'endEndpointUse'>
  const serverOptions = { socketPath, secret, ownerGid: process.getgid!(), supervisor,
    testOnlyAllowNonRoot: true }
  let server = new HostedOpenCodeSupervisorRpcServer(serverOptions)
  try {
    await server.start()
    const client = new HostedOpenCodeSupervisorRpcClient({ socketPath, secret,
      ownerGid: process.getgid!(), testOnlyAllowNonRoot: true })
    const wrong = new HostedOpenCodeSupervisorRpcClient({ socketPath, secret: Buffer.alloc(32, 8),
      ownerGid: process.getgid!(), testOnlyAllowNonRoot: true })
    await expect(wrong.start(START)).rejects.toThrow()
    expect(starts).toBe(0)
    await expect(client.command({ operation: 'prepareMember', payload: { ...START } }))
      .rejects.toThrow('command-invalid')
    await expect(client.command({ operation: 'startPrepared', payload: {
      operationId: START.operationId, receiptId: 'c'.repeat(32), generation: 'd'.repeat(32),
    } })).rejects.toThrow('command-invalid')
    expect(await client.prepareMember({ operationId: START.operationId }))
      .toMatchObject({ generation: HANDLE.generation, connector: { pid: 123, startTicks: '456' } })
    expect(await client.startPrepared({ operationId: START.operationId, receiptId: 'c'.repeat(32) }))
      .toMatchObject({ status: 'unresolved' })
    expect(prepares).toBe(1)
    expect(preparedStarts).toBe(1)
    expect(await client.start(START)).toMatchObject({ effectEnabled: false, status: 'unresolved' })
    for (let index = 0; index < 4097; index++) {
      await client.lookupStart({ ...START, operationId: `lookup_${String(index).padStart(8, '0')}` })
    }
    expect(lookups).toBe(4097)
    expect(await client.stop(HANDLE)).toMatchObject({ stopped: true, unresolved: false })
    expect(stops).toBe(1)

    const raw = connect(socketPath)
    const first = await greeting(raw)
    const unsigned = { schemaVersion: 1, challenge: first.challenge, operation: 'lookupStart',
      nonce: 'c'.repeat(64), payload: { ...START, operationId: 'lookup_replay01' } }
    const signed = packet({ ...unsigned, proof: createHmac('sha256', secret)
      .update(`agent-teams.hosted-opencode-supervisor/v1\0request\0${JSON.stringify(unsigned)}`).digest('hex') })
    raw.write(signed)
    await new Promise<void>(resolve => raw.once('close', () => resolve()))
    expect(lookups).toBe(4098)
    expect(await sendCaptured(socketPath, signed)).not.toBe(first.challenge)
    expect(lookups).toBe(4098)
    await server.close()
    server = new HostedOpenCodeSupervisorRpcServer(serverOptions)
    await server.start()
    expect(await sendCaptured(socketPath, signed)).not.toBe(first.challenge)
    expect(lookups).toBe(4098)
    const contender = new HostedOpenCodeSupervisorRpcServer(serverOptions)
    await expect(contender.start()).rejects.toThrow('socket-already-live')
    expect(await client.stop(HANDLE)).toMatchObject({ stopped: true })
  } finally {
    await server.close().catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  }
})

test('Linux slow Start times out as uncertain and is recovered by lookup without replay', async () => {
  if (process.platform !== 'linux') return
  const root = await realpath(await mkdtemp('/tmp/hosted-supervisor-slow-rpc-'))
  await chmod(root, 0o700)
  const socketPath = path.join(root, 's.sock')
  const secret = Buffer.alloc(32, 9)
  let starts = 0
  let finish!: () => void
  const finished = new Promise<void>(resolve => { finish = resolve })
  const claimed = { ...HANDLE, status: 'unresolved' as const, effectEnabled: false }
  const supervisor = {
    prepareMember: async () => { throw new Error('inactive-fixture') },
    startPrepared: async () => { throw new Error('inactive-fixture') },
    start: async () => { starts++; await new Promise(resolve => setTimeout(resolve, 90)); finish(); return claimed },
    lookupStart: async () => starts ? claimed : null,
    observe: async () => ({ ...HANDLE, status: 'stopped', effectEnabled: false }),
    stop: async () => ({ ...HANDLE, stopped: true, unresolved: false }),
    reconcile: async () => ({ ...HANDLE, stopped: true, unresolved: false }),
    beginEndpointUse: async () => { throw new Error('inactive-fixture') },
    endEndpointUse: async () => ({ released: false }),
  } as unknown as Pick<HostedOpenCodeContainerSupervisor, 'prepareMember' | 'startPrepared' |
    'start' | 'lookupStart' | 'observe' |
    'stop' | 'reconcile' | 'beginEndpointUse' | 'endEndpointUse'>
  const server = new HostedOpenCodeSupervisorRpcServer({ socketPath, secret, ownerGid: process.getgid!(),
    supervisor, testOnlyAllowNonRoot: true, testOnlyCommandDeadlineMs: 1000 })
  try {
    await server.start()
    const client = new HostedOpenCodeSupervisorRpcClient({ socketPath, secret,
      ownerGid: process.getgid!(), testOnlyAllowNonRoot: true, testOnlyCommandDeadlineMs: 30 })
    await expect(client.start(START)).rejects.toThrow('result-uncertain')
    await finished
    const recovery = new HostedOpenCodeSupervisorRpcClient({ socketPath, secret,
      ownerGid: process.getgid!(), testOnlyAllowNonRoot: true, testOnlyCommandDeadlineMs: 1000 })
    expect(await recovery.lookupStart(START)).toEqual(claimed)
    expect(starts).toBe(1)
  } finally { await server.close().catch(() => undefined); await rm(root, { recursive: true, force: true }) }
})

test('supervisor disconnect rejects once without an unhandled challenge promise', async () => {
  const root = await realpath(await mkdtemp('/tmp/hosted-supervisor-drop-rpc-'))
  await chmod(root, 0o700)
  const socketPath = path.join(root, 's.sock')
  const server = createServer(socket => socket.destroy())
  const unhandled: string[] = []
  const observeUnhandled = (error: unknown) => unhandled.push(String(error))
  process.on('unhandledRejection', observeUnhandled)
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, () => { server.off('error', reject); resolve() })
    })
    await chmod(socketPath, 0o600)
    const client = new HostedOpenCodeSupervisorRpcClient({ socketPath, secret: Buffer.alloc(32, 7),
      ownerGid: process.getgid!(), testOnlyAllowNonRoot: true,
      testOnlyAfterConnectPathStat: async value => {
        await new Promise(resolve => setTimeout(resolve, 40))
        return lstat(value)
      } })
    await expect(client.stop(HANDLE)).rejects.toThrow('frame-invalid')
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(unhandled).toEqual([])
  } finally {
    process.off('unhandledRejection', observeUnhandled)
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
})
