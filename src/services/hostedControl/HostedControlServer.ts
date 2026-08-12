import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, timingSafeEqual } from 'node:crypto'
import { constants, chmod, lstat, mkdir, open, unlink } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { dirname } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import {
  createHostedControlProof,
  createHostedDomainProof,
  createHostedRawDomainProof,
  parseStrictHostedProofLastJsonFrame,
  verifyHostedControlProof,
} from './ownerProof.js'
import {
  decodeHostedTaskMutationRequest,
  decodeHostedTaskMutationTerminalResult,
  HOSTED_CONTROL_OPERATION,
  HOSTED_CONTROL_SCHEMA_VERSION,
  type HostedControlAuthority,
  type HostedControlOwnerBinding,
  type HostedControlStableAuthority,
  type HostedTaskMutationRequest,
  type HostedTaskMutationResponse,
  type HostedTaskMutationTerminalResult,
} from './protocol.js'

export const HOSTED_CONTROL_MAX_LINE_BYTES = 64 * 1024
export const HOSTED_CONTROL_READ_DEADLINE_MS = 5_000
export const HOSTED_LIFECYCLE_PROOF_DOMAIN = 'agent-teams.hosted-lifecycle.owner-proof/v1'
export const HOSTED_TEAM_MESSAGE_PROOF_DOMAIN = 'agent-teams.hosted-team-message.owner-proof/v1'
export const HOSTED_READINESS_MAX_LINE_BYTES = 4 * 1024

export type HostedTaskMutationPort = {
  mutate(request: HostedTaskMutationRequest): Promise<HostedTaskMutationTerminalResult>
}

export type HostedControlServerOptions = {
  socketPath: string
  secret: Uint8Array
  ownerIdentity: Omit<HostedControlOwnerBinding, 'socketIdentity'>
  authority: HostedControlStableAuthority
  service: HostedTaskMutationPort
  readDeadlineMs?: number
  dispatchCoexistingOperation?: (message: Record<string, unknown>, rawLine: string) => Promise<Record<string, unknown> | null>
}

export type HostedReadinessAdmission =
  | { protocol: 'legacy'; challenge: string }
  | { protocol: 'canonical'; challenge: string; bootstrapDigest: string }

export class HostedControlServer {
  readonly #options: HostedControlServerOptions
  #server: Server | null = null
  #ownsSocket = false
  readonly #sockets = new Set<Socket>()
  #ownerBinding: HostedControlOwnerBinding | null = null
  #socketParentIdentity: { device: number; inode: number } | null = null
  #leaseSocket: Socket | null = null
  #leaseConsumed = false
  readonly #mutationLease = new AsyncLocalStorage<Socket>()
  readonly #handlers = new Set<Promise<void>>()
  #stopping = false
  #stopPromise: Promise<void> | null = null

  constructor(options: HostedControlServerOptions) {
    this.#options = options
  }

  get ownerBinding(): HostedControlOwnerBinding | null {
    return this.#ownerBinding
  }
  async hasActiveLease(): Promise<boolean> {
    const expectedLease = this.#mutationLease.getStore() ?? this.#leaseSocket
    return !!expectedLease && this.#leaseSocket === expectedLease && !expectedLease.destroyed && await this.#hasCurrentSocketIdentity()
  }

  async start(): Promise<void> {
    if (this.#server) throw new Error('Hosted control server is already started')
    if (this.#stopPromise) await this.#stopPromise
    this.#stopping = false
    const parentIdentity = await prepareSocketPath(this.#options.socketPath)
    const server = createServer(socket => this.#handleConnection(socket))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.#options.socketPath, () => {
        server.off('error', reject)
        this.#server = server
        resolve()
      })
    })
    this.#ownsSocket = true
    await chmod(this.#options.socketPath, 0o600)
    const [socketStat, parentStat] = await Promise.all([lstat(this.#options.socketPath), lstat(dirname(this.#options.socketPath))])
    if (!socketStat.isSocket() || (socketStat.mode & 0o077) !== 0 || (process.getuid?.() !== undefined && socketStat.uid !== process.getuid?.())) {
      await this.stop()
      throw new Error('Hosted control socket identity is not privately owned')
    }
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || parentStat.dev !== parentIdentity.device || parentStat.ino !== parentIdentity.inode) { await this.stop(); throw new Error('Hosted control socket parent was substituted') }
    this.#ownerBinding = {
      ...this.#options.ownerIdentity,
      socketIdentity: {
        device: String(socketStat.dev), inode: String(socketStat.ino),
        uid: socketStat.uid, gid: socketStat.gid, mode: socketStat.mode & 0o777,
      },
    }
    this.#socketParentIdentity = parentIdentity
  }

  async stop(): Promise<void> {
    if (this.#stopPromise) return this.#stopPromise
    const stopping = this.#stop()
    this.#stopPromise = stopping
    try {
      await stopping
    } finally {
      if (this.#stopPromise === stopping) this.#stopPromise = null
    }
  }

  async #stop(): Promise<void> {
    this.#stopping = true
    const server = this.#server
    const ownerBinding = this.#ownerBinding
    const parentIdentity = this.#socketParentIdentity
    this.#server = null
    this.#ownerBinding = null
    this.#leaseSocket = null
    this.#socketParentIdentity = null
    for (const socket of this.#sockets) socket.destroy()
    this.#sockets.clear()
    if (server) {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
    await Promise.allSettled([...this.#handlers])
    if (this.#ownsSocket) {
      this.#ownsSocket = false
      const [socketStat, parentStat] = await Promise.all([
        lstat(this.#options.socketPath).catch(() => null),
        lstat(dirname(this.#options.socketPath)).catch(() => null),
      ])
      if (ownerBinding && parentIdentity && socketStat?.isSocket() && parentStat?.isDirectory() && !parentStat.isSymbolicLink() &&
        String(socketStat.dev) === ownerBinding.socketIdentity.device && String(socketStat.ino) === ownerBinding.socketIdentity.inode &&
        parentStat.dev === parentIdentity.device && parentStat.ino === parentIdentity.inode) {
        await unlink(this.#options.socketPath).catch(error => {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        })
      }
    }
  }

  #handleConnection(socket: Socket): void {
    if (this.#stopping || !this.#server) { socket.destroy(); return }
    this.#sockets.add(socket)
    socket.once('close', () => this.#sockets.delete(socket))
    socket.setTimeout(this.#options.readDeadlineMs ?? HOSTED_CONTROL_READ_DEADLINE_MS)
    let chunks: Buffer[] = []
    let bytes = 0
    let finished = false

    const failClosed = () => {
      finished = true
      chunks = []
      socket.destroy()
    }
    socket.once('timeout', failClosed)
    socket.once('error', () => {
      finished = true
      chunks = []
    })
    socket.on('data', chunk => {
      if (finished) {
        socket.destroy()
        return
      }
      bytes += chunk.byteLength
      if (bytes > HOSTED_CONTROL_MAX_LINE_BYTES) {
        failClosed()
        return
      }
      chunks.push(chunk)
      const input = Buffer.concat(chunks)
      const newline = input.indexOf(0x0a)
      if (newline < 0) return
      if (newline !== input.byteLength - 1 || input.indexOf(0x0a, newline + 1) >= 0) {
        failClosed()
        return
      }
      finished = true
      socket.setTimeout(0)
      if (this.#stopping) { failClosed(); return }
      let line: string
      try { line = decodeUtf8(input.subarray(0, newline)) } catch { failClosed(); return }
      const handler = this.#processLine(socket, line)
        .catch(failClosed)
      this.#handlers.add(handler)
      void handler.finally(() => this.#handlers.delete(handler))
    })
  }

  async #processLine(socket: Socket, line: string): Promise<void> {
    if (this.#stopping) { socket.destroy(); return }
    const parsed = JSON.parse(line) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { socket.destroy(); return }
    const message = parsed as Record<string, unknown>
    if (message.operation === 'readiness') { await this.#handleReadiness(socket, line, message); return }
    if (message.operation !== HOSTED_CONTROL_OPERATION) {
      const leaseSocket = this.#leaseSocket
      const ownerBinding = this.#ownerBinding
      if (!leaseSocket || leaseSocket.destroyed || !(await this.#hasCurrentSocketIdentity()) ||
        !ownerBinding || !this.#options.dispatchCoexistingOperation) {
        socket.destroy()
        return
      }
      const response = await this.#mutationLease.run(
        leaseSocket,
        () => this.#options.dispatchCoexistingOperation!(message, line),
      )
      if (!response || this.#leaseSocket !== leaseSocket || leaseSocket.destroyed ||
        !(await this.#hasCurrentSocketIdentity()) || !isDeepStrictEqual(ownerBinding, this.#ownerBinding)) {
        socket.destroy()
        return
      }
      writeBoundedResponse(socket, response)
      return
    }
    const leaseSocket = this.#leaseSocket
    if (!leaseSocket || leaseSocket.destroyed || !(await this.#hasCurrentSocketIdentity())) { socket.destroy(); return }
    const request = decodeHostedTaskMutationRequest(message)
    const ownerBinding = this.#ownerBinding
    const [socketStat, parentStat] = await Promise.all([lstat(this.#options.socketPath).catch(() => null), lstat(dirname(this.#options.socketPath)).catch(() => null)])
    const parentIdentity = this.#socketParentIdentity
    if (!ownerBinding || !socketStat?.isSocket() ||
      (socketStat.mode & 0o077) !== 0 || (process.getuid?.() !== undefined && socketStat.uid !== process.getuid?.()) ||
      !parentIdentity || !parentStat?.isDirectory() || parentStat.isSymbolicLink() || parentIdentity.device !== parentStat.dev || parentIdentity.inode !== parentStat.ino ||
      ownerBinding.socketIdentity.device !== String(socketStat.dev) || ownerBinding.socketIdentity.inode !== String(socketStat.ino) ||
      JSON.stringify(request.ownerBinding) !== JSON.stringify(ownerBinding) ||
      !sameStableAuthority(request.authority, this.#options.authority)) {
      socket.destroy()
      return
    }
    if (!verifyHostedControlProof(this.#options.secret, 'request', request)) {
      socket.destroy()
      return
    }
    // validateOwner callbacks that call hasActiveLease inherit this exact lease
    // through async WAL publication guards. A replacement readiness lease can
    // never validate an in-flight mutation from the connection it replaced.
    const result = decodeHostedTaskMutationTerminalResult(await this.#mutationLease.run(leaseSocket, () => this.#options.service.mutate(request)))
    if (!taskResultMatchesRequest(request, result)) { socket.destroy(); return }
    if (this.#leaseSocket !== leaseSocket || leaseSocket.destroyed || !(await this.#hasCurrentSocketIdentity()) || JSON.stringify(request.ownerBinding) !== JSON.stringify(this.#ownerBinding)) { socket.destroy(); return }
    const unsigned = {
      schemaVersion: HOSTED_CONTROL_SCHEMA_VERSION,
      exchangeId: request.exchangeId,
      operation: HOSTED_CONTROL_OPERATION,
      ownerBinding,
      authority: request.authority,
      payload: result,
    }
    const response: HostedTaskMutationResponse = {
      ...unsigned,
      ownerProof: createHostedControlProof(this.#options.secret, 'response', unsigned),
    }
    socket.end(`${JSON.stringify(response)}\n`)
  }

  async #handleReadiness(socket: Socket, line: string, message: Record<string, unknown>): Promise<void> {
    if (Buffer.byteLength(line) > HOSTED_READINESS_MAX_LINE_BYTES || this.#leaseConsumed || this.#leaseSocket || !this.#options.dispatchCoexistingOperation) { socket.destroy(); return }
    const ownerBinding = this.#ownerBinding
    if (!ownerBinding) { socket.destroy(); return }
    let admission: HostedReadinessAdmission
    try {
      admission = decodeHostedReadinessRequest({
        secret: this.#options.secret,
        authority: this.#options.authority,
        ownerBinding,
        line,
        message,
      })
    } catch { socket.destroy(); return }
    this.#leaseConsumed = true
    this.#leaseSocket = socket
    socket.once('close', () => { if (this.#leaseSocket === socket) this.#leaseSocket = null })
    if (admission.protocol === 'legacy') {
      const unsigned = { schemaVersion: 2 as const, kind: 'ready' as const, capability: 'hosted-lifecycle-command' as const, challenge: admission.challenge, ownerBinding }
      socket.write(`${JSON.stringify({ ...unsigned, ownerProof: createHostedDomainProof(this.#options.secret, HOSTED_LIFECYCLE_PROOF_DOMAIN, 'readiness', unsigned) })}\n`)
      return
    }
    const unsigned = { schemaVersion: 2 as const, kind: 'ready' as const, capability: 'hosted-lifecycle-command' as const, challenge: admission.challenge, bootstrapDigest: admission.bootstrapDigest, ownerBinding }
    const response = { ...unsigned, ownerProof: createHostedRawDomainProof(this.#options.secret, HOSTED_LIFECYCLE_PROOF_DOMAIN, 'readiness', JSON.stringify(unsigned)) }
    socket.write(`${JSON.stringify(response)}\n`)
  }

  async #hasCurrentSocketIdentity(): Promise<boolean> {
    const ownerBinding = this.#ownerBinding; const parentIdentity = this.#socketParentIdentity
    if (!ownerBinding || !parentIdentity) return false
    const [socketStat, parentStat] = await Promise.all([lstat(this.#options.socketPath).catch(() => null), lstat(dirname(this.#options.socketPath)).catch(() => null)])
    return !!socketStat?.isSocket() && (socketStat.mode & 0o077) === 0 && (process.getuid?.() === undefined || socketStat.uid === process.getuid?.()) && !!parentStat?.isDirectory() && !parentStat.isSymbolicLink() && String(socketStat.dev) === ownerBinding.socketIdentity.device && String(socketStat.ino) === ownerBinding.socketIdentity.inode && socketStat.uid === ownerBinding.socketIdentity.uid && socketStat.gid === ownerBinding.socketIdentity.gid && (socketStat.mode & 0o777) === ownerBinding.socketIdentity.mode && parentStat.dev === parentIdentity.device && parentStat.ino === parentIdentity.inode
  }
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
}

export function decodeHostedReadinessRequest(input: {
  secret: Uint8Array
  authority: HostedControlStableAuthority
  ownerBinding: HostedControlOwnerBinding
  line: string
  message: Record<string, unknown>
}): HostedReadinessAdmission {
  if (Buffer.byteLength(input.line) > HOSTED_READINESS_MAX_LINE_BYTES) {
    throw new TypeError('Invalid hosted readiness frame size')
  }
  if (isLegacyReadiness(input.message)) {
    if (!isDeepStrictEqual(input.message.socketIdentity, input.ownerBinding.socketIdentity) ||
      !verifyLegacyReadiness(input.secret, input.line, input.message)) {
      throw new TypeError('Invalid legacy hosted readiness proof')
    }
    return { protocol: 'legacy', challenge: String(input.message.challenge) }
  }
  const signed = parseStrictHostedProofLastJsonFrame(input.line, 'controllerProof')
  if (!isDeepStrictEqual(signed.value, input.message)) throw new TypeError('Invalid hosted readiness raw frame')
  const expectedKeys = ['schemaVersion', 'operation', 'capability', 'socketIdentity', 'challenge', 'bootstrapBinding', 'expectedOwnerBinding', 'controllerProof'].sort()
  const keys = Object.keys(input.message).sort()
  const identity = input.message.socketIdentity
  const bootstrap = input.message.bootstrapBinding
  const expectedOwner = input.message.expectedOwnerBinding
  const proofKeyId = createHash('sha256').update(input.secret).digest('hex')
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index]) ||
    input.message.schemaVersion !== 2 || input.message.operation !== 'readiness' ||
    input.message.capability !== 'hosted-lifecycle-command' || typeof input.message.challenge !== 'string' ||
    !/^[0-9a-f]{64}$/.test(input.message.challenge) || !identity || typeof identity !== 'object' ||
    Array.isArray(identity) || Object.keys(identity).sort().join(',') !== 'device,gid,inode,mode,uid' ||
    !isDeepStrictEqual(identity, input.ownerBinding.socketIdentity) || !expectedOwner ||
    !isDeepStrictEqual(expectedOwner, input.ownerBinding) || !bootstrap || typeof bootstrap !== 'object' ||
    Array.isArray(bootstrap) || !validBootstrapBinding(bootstrap as Record<string, unknown>, input.authority, proofKeyId) ||
    !verifyRawReadiness(input.secret, signed.serializedUnsignedEnvelope, signed.proof)) {
    throw new TypeError('Invalid canonical hosted readiness proof')
  }
  return {
    protocol: 'canonical',
    challenge: input.message.challenge,
    bootstrapDigest: (bootstrap as Record<string, unknown>).bootstrapDigest as string,
  }
}

function isLegacyReadiness(message: Record<string, unknown>): boolean {
  return Object.keys(message).sort().join(',') ===
    'capability,challenge,operation,ownerProof,schemaVersion,socketIdentity' &&
    message.schemaVersion === 2 && message.operation === 'readiness' &&
    message.capability === 'hosted-lifecycle-command' &&
    typeof message.challenge === 'string' && /^[0-9a-f]{64}$/.test(message.challenge)
}

function verifyLegacyReadiness(
  secret: Uint8Array,
  line: string,
  message: Record<string, unknown>,
): boolean {
  const proof = message.ownerProof
  if (typeof proof !== 'string' || !/^[0-9a-f]{64}$/.test(proof)) return false
  const suffix = `,"ownerProof":${JSON.stringify(proof)}}`
  if (!line.endsWith(suffix)) return false
  const serialized = `${line.slice(0, -suffix.length)}}`
  let unsigned: unknown
  try { unsigned = JSON.parse(serialized) } catch { return false }
  if (!unsigned || typeof unsigned !== 'object' || Array.isArray(unsigned) || JSON.stringify(unsigned) !== serialized) return false
  const expected = createHostedDomainProof(secret, HOSTED_LIFECYCLE_PROOF_DOMAIN, 'readiness-request', unsigned)
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(proof, 'hex'))
}

function verifyRawReadiness(secret: Uint8Array, serialized: string, proof: string): boolean {
  const expected = createHostedRawDomainProof(secret, HOSTED_LIFECYCLE_PROOF_DOMAIN, 'readiness-request', serialized)
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(proof, 'hex'))
}

function validBootstrapBinding(
  value: Record<string, unknown>,
  authority: HostedControlStableAuthority,
  proofKeyId: string,
): boolean {
  const keys = Object.keys(value).sort().join(',')
  return keys === 'bootId,bootstrapDigest,deploymentId,mountGeneration,ownerArtifactDigest,proofKeyId,workspaceId' &&
    value.deploymentId === authority.deploymentId && value.bootId === authority.bootId &&
    value.workspaceId === authority.workspaceId && value.mountGeneration === authority.mountBinding.mountGeneration &&
    typeof value.bootstrapDigest === 'string' && /^[0-9a-f]{64}$/.test(value.bootstrapDigest) &&
    typeof value.ownerArtifactDigest === 'string' && /^sha256:[0-9a-f]{64}$/.test(value.ownerArtifactDigest) &&
    value.proofKeyId === proofKeyId
}

function taskResultMatchesRequest(
  request: HostedTaskMutationRequest,
  result: HostedTaskMutationTerminalResult,
): boolean {
  if (result.kind !== 'committed' && result.kind !== 'idempotent_replay') return true
  const command = request.payload.command
  return result.payloadFingerprint === request.payload.payloadFingerprint &&
    result.currentSourceGeneration === command.expectedSourceGeneration &&
    result.receipt.commandId === command.commandId &&
    result.receipt.teamId === command.teamId &&
    result.receipt.sourceGeneration === command.expectedSourceGeneration
}

function writeBoundedResponse(socket: Socket, value: Record<string, unknown>): void {
  const line = `${JSON.stringify(value)}\n`
  if (Buffer.byteLength(line) > HOSTED_CONTROL_MAX_LINE_BYTES) {
    throw new Error('Hosted control response exceeds maximum line size')
  }
  socket.end(line)
}

function sameStableAuthority(
  actual: HostedControlAuthority,
  expected: HostedControlStableAuthority,
): boolean {
  const { actorId: _, ...stable } = actual
  const { actorId: _ignored, ...stableExpected } = expected as HostedControlAuthority
  return isDeepStrictEqual(stable, stableExpected)
}

async function prepareSocketPath(socketPath: string): Promise<{ device: number; inode: number }> {
  const parent = dirname(socketPath)
  await mkdir(parent, { recursive: true, mode: 0o700 })
  await chmod(parent, 0o700)
  const handle = await open(parent, constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0)); const stat = await handle.stat(); await handle.close()
  try {
    await lstat(socketPath)
    throw new Error('Refusing to replace an existing hosted control socket path')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return { device: stat.dev, inode: stat.ino }
}
