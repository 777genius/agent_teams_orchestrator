import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmod, chown, lstat, realpath, unlink } from 'node:fs/promises'
import { connect, createServer, type Server, type Socket } from 'node:net'
import path from 'node:path'

import type { HostedOpenCodeContainerSupervisor } from './HostedOpenCodeContainerSupervisor.js'
import type { HostedOpenCodeMemberSupervisorManager } from './HostedOpenCodeMemberSupervisorManager.js'
import type { HostedMemberNetworkRequest } from '../containerNetworkProvisioning/HostedMemberNetworkProvisioner.js'

const VERSION = 1
const MAX_FRAME = 4096
const HANDSHAKE_DEADLINE_MS = 5000
const NONCE = /^[0-9a-f]{64}$/
const PROOF = /^[0-9a-f]{64}$/
const ID = /^[a-z0-9][a-z0-9_-]{7,95}$/
const GENERATION = /^[0-9a-f]{32}$/
const DOMAIN = 'agent-teams.hosted-opencode-supervisor/v1'

type Operation = 'prepareMember' | 'startPrepared' | 'start' | 'lookupStart' | 'observe' | 'stop' |
  'reconcile' | 'beginEndpointUse' | 'endEndpointUse' | 'prepareManagedMember' |
  'startManagedMember' | 'observeManagedMember' | 'stopManagedMember'
const COMMAND_DEADLINE_MS: Readonly<Record<Operation, number>> = {
  prepareMember: 30_000, startPrepared: 120_000,
  start: 120_000, lookupStart: 15_000, observe: 30_000, stop: 60_000,
  reconcile: 60_000, beginEndpointUse: 30_000, endEndpointUse: 15_000,
  prepareManagedMember: 30_000, startManagedMember: 120_000,
  observeManagedMember: 30_000, stopManagedMember: 60_000,
}
type Start = Parameters<HostedOpenCodeContainerSupervisor['start']>[0]
type Handle = Parameters<HostedOpenCodeContainerSupervisor['stop']>[0]
type EndpointEnd = Parameters<HostedOpenCodeContainerSupervisor['endEndpointUse']>[0]
type Prepare = Parameters<HostedOpenCodeContainerSupervisor['prepareMember']>[0]
type PreparedStart = Parameters<HostedOpenCodeContainerSupervisor['startPrepared']>[0]
type ManagedHandle = Parameters<HostedOpenCodeMemberSupervisorManager['stop']>[0]
type Command = Readonly<{ operation: Operation; payload: Start | Handle | EndpointEnd | Prepare |
  PreparedStart | HostedMemberNetworkRequest | ManagedHandle }>
type SupervisorPort = Pick<HostedOpenCodeContainerSupervisor,
  'prepareMember' | 'startPrepared' | 'start' | 'lookupStart' | 'observe' | 'stop' | 'reconcile' |
  'beginEndpointUse' | 'endEndpointUse'>
type ManagerPort = Pick<HostedOpenCodeMemberSupervisorManager,
  'prepareMember' | 'startPrepared' | 'observe' | 'stop'>

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...keys].sort().join(',')
}

function proof(secret: Uint8Array, direction: 'request' | 'response', unsigned: object): string {
  return createHmac('sha256', secret).update(`${DOMAIN}\0${direction}\0${JSON.stringify(unsigned)}`).digest('hex')
}

function verify(secret: Uint8Array, direction: 'request' | 'response', unsigned: object, received: unknown): boolean {
  if (typeof received !== 'string' || !PROOF.test(received)) return false
  return timingSafeEqual(Buffer.from(proof(secret, direction, unsigned), 'hex'), Buffer.from(received, 'hex'))
}

function validCommand(operation: unknown, payload: unknown): operation is Operation {
  if (operation === 'prepareManagedMember') {
    return exactKeys(payload, ['operationId', 'planTeamId', 'planFingerprint', 'runId', 'teamId',
      'laneId', 'memberId']) &&
      ['operationId', 'planTeamId', 'runId', 'teamId', 'laneId', 'memberId']
        .every(key => typeof payload[key] === 'string' && ID.test(payload[key])) &&
      typeof payload.planFingerprint === 'string' && PROOF.test(payload.planFingerprint)
  }
  if (operation === 'startManagedMember') {
    return exactKeys(payload, ['operationId', 'receiptId']) &&
      typeof payload.operationId === 'string' && ID.test(payload.operationId) &&
      typeof payload.receiptId === 'string' && GENERATION.test(payload.receiptId)
  }
  if (operation === 'observeManagedMember' || operation === 'stopManagedMember') {
    return exactKeys(payload, ['memberOperationId', 'operationId', 'handle', 'generation']) &&
      typeof payload.memberOperationId === 'string' && ID.test(payload.memberOperationId) &&
      typeof payload.operationId === 'string' && ID.test(payload.operationId) &&
      typeof payload.handle === 'string' && /^opencode_[0-9a-f]{32}$/.test(payload.handle) &&
      typeof payload.generation === 'string' && GENERATION.test(payload.generation)
  }
  if (operation === 'prepareMember') {
    return exactKeys(payload, ['operationId']) && typeof payload.operationId === 'string' &&
      ID.test(payload.operationId)
  }
  if (operation === 'startPrepared') {
    return exactKeys(payload, ['operationId', 'receiptId']) &&
      typeof payload.operationId === 'string' && ID.test(payload.operationId) &&
      typeof payload.receiptId === 'string' && GENERATION.test(payload.receiptId)
  }
  if (operation === 'start' || operation === 'lookupStart') {
    const channel = payload && typeof payload === 'object' && 'ownerChannel' in payload
      ? Reflect.get(payload, 'ownerChannel') : undefined
    return exactKeys(payload, ['operationId', 'leaseId', 'runId', 'teamId', 'laneId', 'memberId',
      ...(channel === undefined ? [] : ['ownerChannel'])]) &&
      ['operationId', 'leaseId', 'runId', 'teamId', 'laneId', 'memberId']
        .every(key => typeof payload[key] === 'string' && ID.test(payload[key])) &&
      (channel === undefined || exactKeys(channel, ['socketPath', 'challenge']) &&
        typeof channel.socketPath === 'string' && path.isAbsolute(channel.socketPath) &&
        typeof channel.challenge === 'string' && NONCE.test(channel.challenge))
  }
  if (operation === 'observe' || operation === 'stop' || operation === 'reconcile' ||
    operation === 'beginEndpointUse' || operation === 'endEndpointUse') {
    const ending = operation === 'endEndpointUse'
    return exactKeys(payload, ['operationId', 'handle', 'generation', ...(ending ? ['token'] : [])]) &&
      typeof payload.operationId === 'string' && ID.test(payload.operationId) &&
      typeof payload.handle === 'string' && /^opencode_[0-9a-f]{32}$/.test(payload.handle) &&
      typeof payload.generation === 'string' && GENERATION.test(payload.generation) &&
      (!ending || typeof payload.token === 'string' && GENERATION.test(payload.token))
  }
  return false
}

function frame(value: object): Buffer {
  const bytes = Buffer.from(JSON.stringify(value), 'utf8')
  if (bytes.length > MAX_FRAME) throw new Error('hosted-supervisor-frame-too-large')
  const packet = Buffer.allocUnsafe(bytes.length + 4)
  packet.writeUInt32BE(bytes.length, 0)
  bytes.copy(packet, 4)
  return packet
}

async function readFrame(socket: Socket, requireEnd = true): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let chunks = Buffer.alloc(0)
    const fail = () => { cleanup(); socket.destroy(); reject(new Error('hosted-supervisor-frame-invalid')) }
    const cleanup = () => {
      socket.off('data', receive); socket.off('end', finish); socket.off('error', fail)
      socket.off('close', fail)
    }
    const receive = (part: Buffer) => {
      chunks = Buffer.concat([chunks, part])
      if (chunks.length > MAX_FRAME + 4) return fail()
      if (chunks.length < 4) return
      const length = chunks.readUInt32BE(0)
      if (!length || length > MAX_FRAME || chunks.length > length + 4) return fail()
      if (!requireEnd && chunks.length === length + 4) finish()
    }
    const finish = () => {
      if (chunks.length < 4 || chunks.length !== chunks.readUInt32BE(0) + 4) return fail()
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(chunks.subarray(4))
        const parsed: unknown = JSON.parse(text)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fail()
        cleanup(); resolve(parsed as Record<string, unknown>)
      } catch { fail() }
    }
    socket.on('data', receive); socket.on('end', finish); socket.on('error', fail); socket.on('close', fail)
  })
}

async function socketParent(socketPath: string, uid: number, gid: number, testOnly: boolean): Promise<void> {
  if (!path.isAbsolute(socketPath) || /[,=]/.test(socketPath) || path.basename(socketPath).length > 80) {
    throw new Error('hosted-supervisor-socket-path-invalid')
  }
  const parent = path.dirname(socketPath)
  const stat = await lstat(parent)
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(parent) !== parent ||
    stat.uid !== uid || (!testOnly && stat.gid !== gid) ||
    (stat.mode & 0o777) !== (testOnly ? 0o700 : 0o710)) {
    throw new Error('hosted-supervisor-socket-parent-invalid')
  }
}

async function removeStaleSocket(socketPath: string, uid: number, gid: number, testOnly: boolean): Promise<void> {
  const stat = await lstat(socketPath).catch(error => {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null
    throw error
  })
  if (!stat) return
  if (!stat.isSocket() || stat.isSymbolicLink() || stat.uid !== uid ||
    (!testOnly && stat.gid !== gid) || (stat.mode & 0o777) !== (testOnly ? 0o600 : 0o660)) {
    throw new Error('hosted-supervisor-stale-socket-invalid')
  }
  const probe = connect(socketPath)
  const refusal = await new Promise<boolean>(resolve => {
    const timer = setTimeout(() => { probe.destroy(); resolve(false) }, 1000)
    probe.once('connect', () => { clearTimeout(timer); probe.destroy(); resolve(false) })
    probe.once('error', error => { clearTimeout(timer); resolve('code' in error && error.code === 'ECONNREFUSED') })
  })
  if (!refusal) throw new Error('hosted-supervisor-socket-already-live')
  const current = await lstat(socketPath)
  if (!current.isSocket() || current.dev !== stat.dev || current.ino !== stat.ino ||
    current.uid !== stat.uid || current.gid !== stat.gid || (current.mode & 0o777) !== (stat.mode & 0o777)) {
    throw new Error('hosted-supervisor-stale-socket-substituted')
  }
  await unlink(socketPath)
}

/** Root process holds Docker authority; only authenticated, finite commands cross this socket. */
export class HostedOpenCodeSupervisorRpcServer {
  private server: Server | null = null
  private identity: { dev: number; ino: number } | null = null
  private readonly sockets = new Set<Socket>()

  constructor(private readonly options: {
    socketPath: string
    secret: Uint8Array
    ownerGid: number
    supervisor?: SupervisorPort
    manager?: ManagerPort
    /** Inert fixture only. Production is root-owned. */
    testOnlyAllowNonRoot?: boolean
    testOnlyCommandDeadlineMs?: number
  }) {
    if (options.secret.length !== 32 || !Number.isSafeInteger(options.ownerGid) || options.ownerGid < 0 ||
      (!options.supervisor && !options.manager) ||
      options.testOnlyAllowNonRoot && process.env.NODE_ENV !== 'test' ||
      !options.testOnlyAllowNonRoot && (process.platform !== 'linux' || process.getuid?.() !== 0) ||
      options.testOnlyCommandDeadlineMs !== undefined &&
        (!options.testOnlyAllowNonRoot || !Number.isSafeInteger(options.testOnlyCommandDeadlineMs) ||
          options.testOnlyCommandDeadlineMs < 10 || options.testOnlyCommandDeadlineMs > 5000)) {
      throw new Error('hosted-supervisor-server-policy-invalid')
    }
  }

  async start(): Promise<void> {
    if (this.server) throw new Error('hosted-supervisor-server-already-started')
    const uid = this.options.testOnlyAllowNonRoot ? process.getuid!() : 0
    const gid = this.options.testOnlyAllowNonRoot ? process.getgid!() : this.options.ownerGid
    await socketParent(this.options.socketPath, uid, gid, !!this.options.testOnlyAllowNonRoot)
    await removeStaleSocket(this.options.socketPath, uid, gid, !!this.options.testOnlyAllowNonRoot)
    const server = createServer({ allowHalfOpen: true }, socket => {
      this.sockets.add(socket)
      socket.once('close', () => this.sockets.delete(socket))
      void this.handle(socket)
    })
    let boundIdentity: { dev: number; ino: number } | null = null
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(this.options.socketPath, () => { server.off('error', reject); resolve() })
      })
      const bound = await lstat(this.options.socketPath)
      if (!bound.isSocket()) throw new Error('hosted-supervisor-socket-invalid')
      boundIdentity = { dev: bound.dev, ino: bound.ino }
      if (!this.options.testOnlyAllowNonRoot) await chown(this.options.socketPath, 0, this.options.ownerGid)
      await chmod(this.options.socketPath, this.options.testOnlyAllowNonRoot ? 0o600 : 0o660)
      const stat = await lstat(this.options.socketPath)
      if (!stat.isSocket() || stat.isSymbolicLink() || stat.uid !== uid ||
        (!this.options.testOnlyAllowNonRoot && stat.gid !== gid) ||
        (stat.mode & 0o777) !== (this.options.testOnlyAllowNonRoot ? 0o600 : 0o660)) {
        throw new Error('hosted-supervisor-socket-invalid')
      }
      this.identity = { dev: stat.dev, ino: stat.ino }
      this.server = server
    } catch (error) {
      server.close()
      const current = await lstat(this.options.socketPath).catch(() => null)
      if (current && boundIdentity && current.dev === boundIdentity.dev && current.ino === boundIdentity.ino) {
        await unlink(this.options.socketPath).catch(() => undefined)
      }
      throw error
    }
  }

  async close(): Promise<void> {
    const server = this.server
    this.server = null
    for (const socket of this.sockets) socket.destroy()
    if (server) await new Promise<void>(resolve => server.close(() => resolve()))
    const stat = await lstat(this.options.socketPath).catch(() => null)
    if (stat && this.identity && stat.dev === this.identity.dev && stat.ino === this.identity.ino) {
      await unlink(this.options.socketPath)
    }
  }

  private async handle(socket: Socket): Promise<void> {
    socket.setTimeout(HANDSHAKE_DEADLINE_MS, () => socket.destroy())
    try {
      const challenge = randomBytes(32).toString('hex')
      socket.write(frame({ schemaVersion: VERSION, challenge }))
      // Bun closes an AF_UNIX peer when the caller half-closes, even with allowHalfOpen.
      // The length prefix is sufficient; keep the request side open until the reply.
      const row = await readFrame(socket, false)
      socket.on('data', () => socket.destroy())
      if (!exactKeys(row, ['schemaVersion', 'challenge', 'operation', 'nonce', 'payload', 'proof']) ||
        row.schemaVersion !== VERSION || typeof row.nonce !== 'string' || !NONCE.test(row.nonce) ||
        row.challenge !== challenge || !validCommand(row.operation, row.payload)) throw new Error('request-invalid')
      const unsigned = { schemaVersion: row.schemaVersion, challenge: row.challenge, operation: row.operation,
        nonce: row.nonce, payload: row.payload }
      if (!verify(this.options.secret, 'request', unsigned, row.proof)) throw new Error('request-unauthenticated')
      // A dropped or uncertain reply never authorizes another Start: supervisor persists its exact operation claim.
      const command = row as unknown as Command & { nonce: string }
      socket.setTimeout(this.options.testOnlyCommandDeadlineMs ?? COMMAND_DEADLINE_MS[command.operation],
        () => socket.destroy())
      let result: unknown
      switch (command.operation) {
        case 'prepareManagedMember': result = await this.options.manager?.prepareMember(
          command.payload as HostedMemberNetworkRequest); break
        case 'startManagedMember': result = await this.options.manager?.startPrepared(
          command.payload as PreparedStart); break
        case 'observeManagedMember': result = await this.options.manager?.observe(
          command.payload as ManagedHandle); break
        case 'stopManagedMember': result = await this.options.manager?.stop(
          command.payload as ManagedHandle); break
        case 'prepareMember': result = await this.options.supervisor?.prepareMember(command.payload as Prepare); break
        case 'startPrepared': result = await this.options.supervisor?.startPrepared(command.payload as PreparedStart); break
        case 'start': result = await this.options.supervisor?.start(command.payload as Start); break
        case 'lookupStart': result = await this.options.supervisor?.lookupStart(command.payload as Start); break
        case 'observe': result = await this.options.supervisor?.observe(command.payload as Handle); break
        case 'stop': result = await this.options.supervisor?.stop(command.payload as Handle); break
        case 'reconcile': result = await this.options.supervisor?.reconcile(command.payload as Handle); break
        case 'beginEndpointUse': result = await this.options.supervisor?.beginEndpointUse(command.payload as Handle); break
        case 'endEndpointUse': result = await this.options.supervisor?.endEndpointUse(command.payload as EndpointEnd); break
      }
      if (result === undefined) throw new Error('hosted-supervisor-operation-unavailable')
      const response = { schemaVersion: VERSION, challenge, nonce: command.nonce, operation: command.operation,
        ok: true, result }
      socket.end(frame({ ...response, proof: proof(this.options.secret, 'response', response) }))
    } catch { socket.destroy() }
  }
}

export class HostedOpenCodeSupervisorRpcClient {
  constructor(private readonly options: { socketPath: string; secret: Uint8Array; ownerGid: number;
    testOnlyAllowNonRoot?: boolean; testOnlyCommandDeadlineMs?: number;
    testOnlyAfterConnectPathStat?: (socketPath: string) => Promise<{ dev: number; ino: number }> }) {
    if (options.secret.length !== 32 || !Number.isSafeInteger(options.ownerGid) || options.ownerGid < 0 ||
      options.testOnlyAllowNonRoot && process.env.NODE_ENV !== 'test' ||
      options.testOnlyCommandDeadlineMs !== undefined &&
        (!options.testOnlyAllowNonRoot || !Number.isSafeInteger(options.testOnlyCommandDeadlineMs) ||
          options.testOnlyCommandDeadlineMs < 10 || options.testOnlyCommandDeadlineMs > 5000) ||
      options.testOnlyAfterConnectPathStat !== undefined && !options.testOnlyAllowNonRoot) {
      throw new Error('hosted-supervisor-client-policy-invalid')
    }
  }

  start(request: Start): ReturnType<HostedOpenCodeContainerSupervisor['start']> {
    return this.command({ operation: 'start', payload: request })
  }

  prepareMember(request: Prepare): ReturnType<HostedOpenCodeContainerSupervisor['prepareMember']> {
    return this.command({ operation: 'prepareMember', payload: request })
  }

  prepareManagedMember(request: HostedMemberNetworkRequest): ReturnType<ManagerPort['prepareMember']> {
    return this.command({ operation: 'prepareManagedMember', payload: request })
  }

  startManagedMember(request: PreparedStart): ReturnType<ManagerPort['startPrepared']> {
    return this.command({ operation: 'startManagedMember', payload: request })
  }

  observeManagedMember(request: ManagedHandle): ReturnType<ManagerPort['observe']> {
    return this.command({ operation: 'observeManagedMember', payload: request })
  }

  stopManagedMember(request: ManagedHandle): ReturnType<ManagerPort['stop']> {
    return this.command({ operation: 'stopManagedMember', payload: request })
  }

  startPrepared(request: PreparedStart): ReturnType<HostedOpenCodeContainerSupervisor['startPrepared']> {
    return this.command({ operation: 'startPrepared', payload: request })
  }

  lookupStart(request: Start): ReturnType<HostedOpenCodeContainerSupervisor['lookupStart']> {
    return this.command({ operation: 'lookupStart', payload: request })
  }

  observe(request: Handle): ReturnType<HostedOpenCodeContainerSupervisor['observe']> {
    return this.command({ operation: 'observe', payload: request })
  }

  stop(request: Handle): ReturnType<HostedOpenCodeContainerSupervisor['stop']> {
    return this.command({ operation: 'stop', payload: request })
  }

  reconcile(request: Handle): ReturnType<HostedOpenCodeContainerSupervisor['reconcile']> {
    return this.command({ operation: 'reconcile', payload: request })
  }

  beginEndpointUse(request: Handle): ReturnType<HostedOpenCodeContainerSupervisor['beginEndpointUse']> {
    return this.command({ operation: 'beginEndpointUse', payload: request })
  }

  endEndpointUse(request: EndpointEnd): ReturnType<HostedOpenCodeContainerSupervisor['endEndpointUse']> {
    return this.command({ operation: 'endEndpointUse', payload: request })
  }

  async command<T>(command: Command): Promise<T> {
    if (!validCommand(command.operation, command.payload)) throw new Error('hosted-supervisor-command-invalid')
    const uid = this.options.testOnlyAllowNonRoot ? process.getuid!() : 0
    const gid = this.options.testOnlyAllowNonRoot ? process.getgid!() : this.options.ownerGid
    await socketParent(this.options.socketPath, uid, gid, !!this.options.testOnlyAllowNonRoot)
    const stat = await lstat(this.options.socketPath)
    if (!stat.isSocket() || stat.isSymbolicLink() || stat.uid !== uid ||
      (!this.options.testOnlyAllowNonRoot && stat.gid !== gid) ||
      (stat.mode & 0o777) !== (this.options.testOnlyAllowNonRoot ? 0o600 : 0o660)) {
      throw new Error('hosted-supervisor-socket-invalid')
    }
    const nonce = randomBytes(32).toString('hex')
    const socket = connect(this.options.socketPath)
    socket.setTimeout(HANDSHAKE_DEADLINE_MS, () => socket.destroy())
    // Attach before Connect can deliver the server's immediate challenge.
    const greetingFrame = readFrame(socket, false)
    // The peer can close while Connect/path identity is still being awaited.
    // Observe an early rejection immediately; the original promise still rejects when awaited below.
    void greetingFrame.catch(() => undefined)
    let submitted = false
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve); socket.once('error', reject)
      })
      const current = await (this.options.testOnlyAfterConnectPathStat ?? lstat)(this.options.socketPath)
      if (current.dev !== stat.dev || current.ino !== stat.ino) throw new Error('hosted-supervisor-socket-substituted')
      const greeting = await greetingFrame
      if (!exactKeys(greeting, ['schemaVersion', 'challenge']) || greeting.schemaVersion !== VERSION ||
        typeof greeting.challenge !== 'string' || !NONCE.test(greeting.challenge)) {
        throw new Error('hosted-supervisor-challenge-invalid')
      }
      const signedRequest = { schemaVersion: VERSION, challenge: greeting.challenge,
        operation: command.operation, nonce, payload: command.payload }
      const response = readFrame(socket)
      socket.setTimeout(this.options.testOnlyCommandDeadlineMs ?? COMMAND_DEADLINE_MS[command.operation],
        () => socket.destroy())
      submitted = true
      socket.write(frame({ ...signedRequest, proof: proof(this.options.secret, 'request', signedRequest) }))
      const row = await response
      if (!exactKeys(row, ['schemaVersion', 'challenge', 'nonce', 'operation', 'ok', 'result', 'proof']) ||
        row.schemaVersion !== VERSION || row.challenge !== greeting.challenge || row.nonce !== nonce ||
        row.operation !== command.operation || row.ok !== true ||
        !verify(this.options.secret, 'response', { schemaVersion: row.schemaVersion, challenge: row.challenge,
          nonce: row.nonce,
          operation: row.operation, ok: row.ok, result: row.result }, row.proof)) {
        throw new Error('hosted-supervisor-response-unauthenticated')
      }
      return row.result as T
    } catch (error) {
      if (submitted) throw new Error('hosted-supervisor-result-uncertain', { cause: error })
      throw error
    } finally { socket.destroy() }
  }
}
