import { AsyncLocalStorage } from 'node:async_hooks'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { lstatSync, type Stats } from 'node:fs'
import { constants, chmod, link, lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import { connect, createServer, type Server, type Socket } from 'node:net'
import { basename, dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import {
  createHostedControlProof,
  createHostedDomainProof,
  createHostedRawDomainProof,
  parseStrictHostedProofLastJsonFrame,
  verifyHostedControlProof,
} from './ownerProof.js'
import type { HostedControlBootstrapBinding } from './HostedControlBootstrap.js'
import { isProductOwnerBoundEnvelope } from './HostedProductOwnerBoundEnvelope.js'
import { HOSTED_CONTROL_SOCKET_BROKER_FLAG } from './HostedControlSocketBroker.js'
import {
  HOSTED_APPROVAL_ACTIVATION_PREPARE_MAX_BYTES,
  HOSTED_APPROVAL_ACTIVATION_PUBLICATION_MAX_BYTES,
  type HostedApprovalActivationConnection,
  type HostedApprovalActivationTransportSession,
} from './HostedApprovalActivationSession.js'
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

export const HOSTED_CONTROL_STANDARD_MAX_LINE_BYTES = 64 * 1024
export const HOSTED_CONTROL_MAX_LINE_BYTES = 8 * 1024 * 1024
export const HOSTED_CONTROL_READ_DEADLINE_MS = 5_000
export const HOSTED_CONTROL_ACTIVATION_RECOVERY_DEADLINE_MS = 30_000
export const HOSTED_LIFECYCLE_PROOF_DOMAIN = 'agent-teams.hosted-lifecycle.owner-proof/v1'
export const HOSTED_TEAM_MESSAGE_PROOF_DOMAIN = 'agent-teams.hosted-team-message.owner-proof/v1'
export const HOSTED_READINESS_MAX_LINE_BYTES = 4 * 1024

export type HostedTaskMutationPort = {
  mutate(request: HostedTaskMutationRequest): Promise<HostedTaskMutationTerminalResult>
}

export type HostedApprovalActivationSessionFactory = (
  connection: HostedApprovalActivationConnection,
) => HostedApprovalActivationTransportSession

export type HostedControlServerOptions = {
  socketPath: string
  secret: Uint8Array
  ownerIdentity: Omit<HostedControlOwnerBinding, 'socketIdentity'>
  authority: HostedControlStableAuthority
  service: HostedTaskMutationPort
  readDeadlineMs?: number
  /** Recovery has a separate absolute bound after the publication read completes. */
  activationRecoveryDeadlineMs?: number
  bootstrapBinding?: Readonly<HostedControlBootstrapBinding>
  /** Deterministic publication-window seam for security regression tests. */
  afterSocketPublicationForTest?: () => void | Promise<void>
  /** Deterministic close-window seam for hidden-path replacement regression tests. */
  beforeSocketCloseForTest?: (listenPath: string) => void | Promise<void>
  /** Deterministic retained-write seam for activation transport regression tests. */
  beforeActivationFrameWriteForTest?: (
    phase: 'owner_ready' | 'ready', socket: Socket,
  ) => void | Promise<void>
  dispatchCoexistingOperation?: (message: Record<string, unknown>, rawLine: string) => Promise<Record<string, unknown> | null>
  /** Advisory callback after a signed readiness request retains the owner lease. */
  onReadinessLease?: () => void
  /** Optional one-use approval activation transport. Lifecycle readiness remains independent. */
  activationSessionFactory?: HostedApprovalActivationSessionFactory
}

type ActivationPhase =
  | 'preparing'
  | 'owner_ready_writing'
  | 'awaiting_publication'
  | 'recovering'
  | 'ready_writing'
  | 'leased'
  | 'revoked'

type ActivationCandidate = {
  readonly socket: Socket
  readonly generation: number
  phase: ActivationPhase
  session: HostedApprovalActivationTransportSession | null
  publicationChunks: Buffer[]
  publicationBytes: number
  resolvePublication: ((frame: string) => void) | null
  rejectPublication: ((error: Error) => void) | null
  revokePromise: Promise<void> | null
  monitor: ReturnType<typeof setInterval> | null
  recoveryDeadline: ReturnType<typeof setTimeout> | null
}

export type HostedReadinessAdmission =
  | { protocol: 'legacy'; challenge: string }
  | { protocol: 'canonical'; challenge: string; bootstrapDigest: string }

export class HostedControlServer {
  readonly #options: HostedControlServerOptions
  #server: Server | null = null
  #broker: ChildProcess | null = null
  #ownsSocket = false
  readonly #sockets = new Set<Socket>()
  #ownerBinding: HostedControlOwnerBinding | null = null
  #socketParentIdentity: { device: number; inode: number } | null = null
  #ownedSocketIdentity: { device: number; inode: number } | null = null
  #listenPath: string | null = null
  #leaseSocket: Socket | null = null
  #leaseConsumed = false
  #activationConsumed = false
  #activationGeneration = 0
  #activation: ActivationCandidate | null = null
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
    if (typeof Bun === 'undefined') throw new Error('Hosted control Unix socket publication requires the Bun runtime')
    this.#stopping = false
    const parentIdentity = await prepareSocketPath(this.#options.socketPath)
    this.#socketParentIdentity = parentIdentity
    const listenPath = socketPublicationPath(this.#options.socketPath)
    const brokerToken = randomBytes(32)
    let publicationProbe: PublicationProbe | null = null
    // Product's owner-bound client ends its write side after the request frame; the reply must
    // still flow back on the same connection.
    const server = createServer({ allowHalfOpen: true }, socket => this.#admitBrokerConnection(socket, brokerToken, (admitted, initialData) => {
      if (publicationProbe) consumePublicationProbe(admitted, publicationProbe, initialData)
      else this.#handleConnection(admitted, initialData)
    }))
    let admittedSocketIdentity: { device: number; inode: number } | null = null
    try {
      await listenLoopback(server)
      this.#server = server
      this.#listenPath = listenPath
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Hosted control broker endpoint is unavailable')
      const broker = await startSocketBroker(listenPath, address.port, brokerToken)
      this.#broker = broker
      this.#ownsSocket = true
      const admittedSocketStat = await lstat(listenPath)
      admittedSocketIdentity = { device: admittedSocketStat.dev, inode: admittedSocketStat.ino }
      this.#ownedSocketIdentity = admittedSocketIdentity
      if (!admittedSocketStat.isSocket() || (admittedSocketStat.mode & 0o777) !== 0o600 ||
        (process.getuid?.() !== undefined && admittedSocketStat.uid !== process.getuid?.())) {
        throw new Error('Hosted control publication socket is not privately owned')
      }
      await proveSocketPathIsServerOwned(listenPath, probe => { publicationProbe = probe })
      publicationProbe = null
      const provedSocketStat = await lstat(listenPath)
      if (!sameSocketIdentity(provedSocketStat, admittedSocketIdentity)) {
        throw new Error('Hosted control publication socket changed during ownership proof')
      }
      await link(listenPath, this.#options.socketPath)
      await removeOwnedSocketPathIfCurrent(listenPath, admittedSocketIdentity, parentIdentity)
      await this.#options.afterSocketPublicationForTest?.()
      const [socketStat, parentStat] = await Promise.all([
        lstat(this.#options.socketPath), lstat(dirname(this.#options.socketPath)),
      ])
      if (!sameSocketIdentity(socketStat, admittedSocketIdentity) || (socketStat.mode & 0o777) !== 0o600 ||
        (process.getuid?.() !== undefined && socketStat.uid !== process.getuid?.())) {
        throw new Error('Hosted control socket changed during publication')
      }
      if (!parentStat.isDirectory() || parentStat.isSymbolicLink() ||
        parentStat.dev !== parentIdentity.device || parentStat.ino !== parentIdentity.inode) {
        throw new Error('Hosted control socket parent was substituted')
      }
      const publishedSocketStat = await lstat(this.#options.socketPath)
      if (!sameSocketIdentity(publishedSocketStat, admittedSocketIdentity)) {
        throw new Error('Hosted control socket changed after publication')
      }
      this.#ownerBinding = {
        ...this.#options.ownerIdentity,
        socketIdentity: {
          device: String(publishedSocketStat.dev), inode: String(publishedSocketStat.ino),
          uid: publishedSocketStat.uid, gid: publishedSocketStat.gid,
          mode: publishedSocketStat.mode & 0o777,
        },
      }
      broker.once('exit', () => {
        if (this.#broker === broker) void this.stop().catch(() => undefined)
      })
      if (broker.exitCode !== null || broker.signalCode !== null) {
        throw new Error('Hosted control socket broker exited during publication')
      }
    } catch (error) {
      publicationProbe?.reject(error)
      publicationProbe = null
      await this.stop().catch(() => undefined)
      throw error
    }
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
    // The approval delegate is synchronously fenced before any listener,
    // handler, lifecycle port, root lease, or descriptor cleanup can begin.
    const activationRevocation = this.#activation
      ? this.#revokeActivation(this.#activation, new Error('Hosted control server stopped'))
      : Promise.resolve()
    const server = this.#server
    const broker = this.#broker
    const parentIdentity = this.#socketParentIdentity
    const ownedSocketIdentity = this.#ownedSocketIdentity
    const listenPath = this.#listenPath
    this.#server = null
    this.#broker = null
    this.#ownerBinding = null
    this.#leaseSocket = null
    this.#socketParentIdentity = null
    this.#ownedSocketIdentity = null
    this.#listenPath = null
    for (const socket of this.#sockets) socket.destroy()
    this.#sockets.clear()
    await this.#options.beforeSocketCloseForTest?.(listenPath ?? '')
    if (broker) await killSocketBroker(broker)
    if (server) await closeServer(server)
    if (listenPath && ownedSocketIdentity && parentIdentity) {
      await removeOwnedSocketPathIfCurrent(
        listenPath, ownedSocketIdentity, parentIdentity,
      )
    }
    await Promise.allSettled([...this.#handlers])
    await activationRevocation.catch(() => undefined)
    if (this.#ownsSocket) {
      this.#ownsSocket = false
      const [socketStat, parentStat] = await Promise.all([
        lstat(this.#options.socketPath).catch(() => null),
        lstat(dirname(this.#options.socketPath)).catch(() => null),
      ])
      if (ownedSocketIdentity && parentIdentity && socketStat?.isSocket() && parentStat?.isDirectory() && !parentStat.isSymbolicLink() &&
        socketStat.dev === ownedSocketIdentity.device && socketStat.ino === ownedSocketIdentity.inode &&
        parentStat.dev === parentIdentity.device && parentStat.ino === parentIdentity.inode) {
        await removeSocketIfIdentityMatches(this.#options.socketPath, {
          device: ownedSocketIdentity.device, inode: ownedSocketIdentity.inode,
        }, parentIdentity)
      }
    }
  }

  #handleConnection(socket: Socket, initialData: Buffer = Buffer.alloc(0)): void {
    if (this.#stopping || !this.#server) { socket.destroy(); return }
    socket.setTimeout(this.#options.readDeadlineMs ?? HOSTED_CONTROL_READ_DEADLINE_MS)
    let chunks: Buffer[] = []
    let bytes = 0
    let finished = false

    const failClosed = (cause: unknown = new Error('Hosted control connection failed closed')) => {
      finished = true
      chunks = []
      const activation = this.#activation
      if (activation?.socket === socket) {
        void this.#revokeActivation(activation, asError(cause))
      } else {
        socket.destroy()
      }
    }
    socket.once('timeout', failClosed)
    socket.once('error', error => {
      finished = true
      chunks = []
      const activation = this.#activation
      if (activation?.socket === socket) void this.#revokeActivation(activation, error)
    })
    socket.once('end', () => {
      const activation = this.#activation
      if (activation?.socket === socket) {
        void this.#revokeActivation(activation, new Error('Hosted approval activation lease ended'))
        return
      }
      // Half-open sockets no longer close on FIN; a peer that ends before a complete frame
      // will never send a request, so do not keep it until the read deadline.
      if (!finished) failClosed()
    })
    socket.once('close', () => {
      const activation = this.#activation
      if (activation?.socket === socket) {
        void this.#revokeActivation(activation, new Error('Hosted approval activation lease closed'))
      }
    })
    socket.on('data', chunk => {
      const activation = this.#activation
      if (activation?.socket === socket) {
        this.#handleActivationData(activation, chunk)
        return
      }
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
      if (this.#options.activationSessionFactory && isActivationPrepare(line)) {
        const handler = this.#beginActivation(socket, `${line}\n`).catch(failClosed)
        this.#handlers.add(handler)
        void handler.finally(() => this.#handlers.delete(handler))
        return
      }
      const handler = this.#processLine(socket, line)
        .catch(failClosed)
      this.#handlers.add(handler)
      void handler.finally(() => this.#handlers.delete(handler))
    })
    if (initialData.byteLength > 0) socket.emit('data', initialData)
  }

  async #beginActivation(socket: Socket, prepareFrame: string): Promise<void> {
    if (this.#activationConsumed || this.#activation || this.#stopping ||
      Buffer.byteLength(prepareFrame, 'utf8') > HOSTED_APPROVAL_ACTIVATION_PREPARE_MAX_BYTES) {
      socket.destroy()
      return
    }
    const ownerBinding = this.#ownerBinding
    if (!ownerBinding || !this.#isCurrentSocketIdentitySync()) { socket.destroy(); return }
    const candidate: ActivationCandidate = {
      socket,
      generation: ++this.#activationGeneration,
      phase: 'preparing',
      session: null,
      publicationChunks: [],
      publicationBytes: 0,
      resolvePublication: null,
      rejectPublication: null,
      revokePromise: null,
      monitor: null,
      recoveryDeadline: null,
    }
    this.#activation = candidate
    const connection: HostedApprovalActivationConnection = Object.freeze({
      ownerBinding,
      socketPath: this.#options.socketPath,
      isCurrent: () => this.#isActivationCurrent(candidate),
      prepareEffectToken: () => this.#prepareActivationEffectToken(candidate),
      receivePublicationAfterOwnerReady: (ownerReady, maximumBytes) =>
        this.#receivePublicationAfterOwnerReady(candidate, ownerReady, maximumBytes),
    })
    try {
      candidate.session = this.#options.activationSessionFactory!(connection)
      candidate.monitor = setInterval(() => {
        if (!this.#isActivationCurrent(candidate)) {
          void this.#revokeActivation(candidate, new Error('Hosted approval activation socket identity changed'))
        }
      }, 10)
      candidate.monitor.unref?.()
      const ready = await candidate.session.activate(prepareFrame)
      if (!this.#isActivationCurrent(candidate) || candidate.phase !== 'recovering') {
        throw new Error('Hosted approval activation became stale during recovery')
      }
      candidate.phase = 'ready_writing'
      await this.#options.beforeActivationFrameWriteForTest?.('ready', socket)
      await writeRetainedFrame(socket, ready)
      if (!this.#isActivationCurrent(candidate) || candidate.phase !== 'ready_writing') {
        throw new Error('Hosted approval activation became stale while publishing ready')
      }
      candidate.phase = 'leased'
      this.#clearActivationRecoveryDeadline(candidate)
    } catch (error) {
      await this.#revokeActivation(candidate, asError(error)).catch(() => undefined)
      socket.destroy()
      throw error
    }
  }

  #handleActivationData(candidate: ActivationCandidate, chunk: Buffer): void {
    if (candidate.phase !== 'awaiting_publication') {
      void this.#revokeActivation(candidate, new Error('Unexpected hosted approval activation bytes'))
      candidate.socket.destroy()
      return
    }
    candidate.publicationBytes += chunk.byteLength
    if (candidate.publicationBytes > HOSTED_APPROVAL_ACTIVATION_PUBLICATION_MAX_BYTES) {
      void this.#revokeActivation(candidate, new Error('Hosted approval activation publication exceeds limit'))
      candidate.socket.destroy()
      return
    }
    candidate.publicationChunks.push(chunk)
    const input = Buffer.concat(candidate.publicationChunks)
    const newline = input.indexOf(0x0a)
    if (newline < 0) return
    if (newline !== input.byteLength - 1 || input.indexOf(0x0a, newline + 1) >= 0) {
      void this.#revokeActivation(candidate, new Error('Hosted approval activation publication was pipelined'))
      candidate.socket.destroy()
      return
    }
    let frame: string
    try { frame = `${decodeUtf8(input.subarray(0, newline))}\n` } catch (error) {
      void this.#revokeActivation(candidate, asError(error))
      candidate.socket.destroy()
      return
    }
    candidate.phase = 'recovering'
    // The publication inactivity deadline must not consume a legitimate slow
    // recovery. Recovery instead owns one absolute, fail-closed deadline that
    // also bounds the retained ready write.
    candidate.socket.setTimeout(0)
    candidate.recoveryDeadline = setTimeout(() => {
      void this.#revokeActivation(
        candidate, new Error('Hosted approval activation recovery timed out'),
      )
    }, this.#options.activationRecoveryDeadlineMs ??
      HOSTED_CONTROL_ACTIVATION_RECOVERY_DEADLINE_MS)
    candidate.recoveryDeadline.unref?.()
    candidate.publicationChunks = []
    candidate.resolvePublication?.(frame)
    candidate.resolvePublication = null
    candidate.rejectPublication = null
  }

  async #receivePublicationAfterOwnerReady(
    candidate: ActivationCandidate,
    ownerReady: string,
    maximumBytes: number,
  ): Promise<string> {
    if (maximumBytes !== HOSTED_APPROVAL_ACTIVATION_PUBLICATION_MAX_BYTES ||
      candidate.phase !== 'preparing' || !this.#isActivationCurrent(candidate)) {
      throw new Error('Hosted approval activation publication transition is stale')
    }
    // O2-C reaches this transition only after authenticating the prepare.
    // From this point the process-generation activation slot is permanent,
    // including owner-ready failure, recovery failure, and later revocation.
    this.#activationConsumed = true
    candidate.phase = 'owner_ready_writing'
    candidate.socket.setTimeout(this.#options.readDeadlineMs ?? HOSTED_CONTROL_READ_DEADLINE_MS)
    try {
      await this.#options.beforeActivationFrameWriteForTest?.('owner_ready', candidate.socket)
      await writeRetainedFrame(candidate.socket, ownerReady)
    } catch (error) {
      void this.#revokeActivation(candidate, asError(error))
      throw error
    }
    if (candidate.phase !== 'owner_ready_writing' || !this.#isActivationCurrent(candidate)) {
      throw new Error('Hosted approval activation owner-ready write became stale')
    }
    candidate.phase = 'awaiting_publication'
    candidate.socket.setTimeout(this.#options.readDeadlineMs ?? HOSTED_CONTROL_READ_DEADLINE_MS)
    return new Promise<string>((resolve, reject) => {
      candidate.resolvePublication = resolve
      candidate.rejectPublication = reject
    })
  }

  #prepareActivationEffectToken(candidate: ActivationCandidate): { consume(): boolean } | null {
    if (!this.#isActivationCurrent(candidate)) return null
    const generation = candidate.generation
    const socket = candidate.socket
    const ownerBinding = this.#ownerBinding
    const parentIdentity = this.#socketParentIdentity
    let consumed = false
    return Object.freeze({
      consume: (): boolean => {
        if (consumed) return false
        consumed = true
        const current = !!ownerBinding && !!parentIdentity &&
          this.#activation === candidate && this.#activationGeneration === generation &&
          candidate.socket === socket && !socket.destroyed &&
          isSocketIdentityCurrentSync(
            this.#options.socketPath, ownerBinding, parentIdentity,
          )
        if (!current) void this.#revokeActivation(
          candidate, new Error('Hosted approval activation effect token is stale'),
        )
        return current
      },
    })
  }

  #isActivationCurrent(candidate: ActivationCandidate): boolean {
    return this.#activation === candidate && this.#activationGeneration === candidate.generation &&
      candidate.phase !== 'revoked' && !this.#stopping && !candidate.socket.destroyed &&
      this.#isCurrentSocketIdentitySync()
  }

  #revokeActivation(candidate: ActivationCandidate, error: Error): Promise<void> {
    if (candidate.revokePromise) return candidate.revokePromise
    candidate.phase = 'revoked'
    this.#activationGeneration += 1
    this.#clearActivationRecoveryDeadline(candidate)
    if (candidate.monitor) clearInterval(candidate.monitor)
    candidate.monitor = null
    candidate.rejectPublication?.(error)
    candidate.resolvePublication = null
    candidate.rejectPublication = null
    if (!this.#activationConsumed && this.#activation === candidate) {
      this.#activation = null
    }
    // Invocation, and therefore O2-C's synchronous O2-A linearization point,
    // happens before this method exposes the cleanup promise.
    candidate.revokePromise = Promise.resolve()
    try {
      candidate.revokePromise = candidate.session
        ? Promise.resolve(candidate.session.revoke())
        : Promise.resolve()
    } catch (cause) {
      candidate.revokePromise = Promise.reject(cause)
    }
    // Always close the exact retained connection in the same synchronous
    // revocation turn. Clearing the identity monitor can never orphan it.
    candidate.socket.destroy()
    return candidate.revokePromise
  }

  #clearActivationRecoveryDeadline(candidate: ActivationCandidate): void {
    if (candidate.recoveryDeadline) clearTimeout(candidate.recoveryDeadline)
    candidate.recoveryDeadline = null
  }

  #admitBrokerConnection(
    socket: Socket,
    expectedToken: Buffer,
    admit: (socket: Socket, initialData: Buffer) => void,
  ): void {
    this.#sockets.add(socket)
    socket.once('close', () => this.#sockets.delete(socket))
    let buffered = Buffer.alloc(0)
    const reject = () => socket.destroy()
    socket.setTimeout(this.#options.readDeadlineMs ?? HOSTED_CONTROL_READ_DEADLINE_MS, reject)
    socket.once('error', () => undefined)
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk])
      if (buffered.byteLength < expectedToken.byteLength) return
      socket.off('data', onData)
      const token = buffered.subarray(0, expectedToken.byteLength)
      if (!timingSafeEqual(token, expectedToken)) { reject(); return }
      socket.setTimeout(0)
      const remainder = buffered.subarray(expectedToken.byteLength)
      admit(socket, remainder)
    }
    socket.on('data', onData)
  }

  async #processLine(socket: Socket, line: string): Promise<void> {
    if (this.#stopping) { socket.destroy(); return }
    const parsed = JSON.parse(line) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { socket.destroy(); return }
    const message = parsed as Record<string, unknown>
    const frameBytes = Buffer.byteLength(line, 'utf8') + 1
    if (!isApprovalOperation(message.operation) && frameBytes > HOSTED_CONTROL_STANDARD_MAX_LINE_BYTES) {
      socket.destroy()
      return
    }
    if (message.operation === 'readiness') { await this.#handleReadiness(socket, line, message); return }
    if (message.operation !== HOSTED_CONTROL_OPERATION || isProductOwnerBoundEnvelope(message)) {
      const leaseSocket = this.#leaseSocket
      const ownerBinding = this.#ownerBinding
      const productEnvelope = isProductOwnerBoundEnvelope(message)
      if (!leaseSocket || leaseSocket.destroyed || !(await this.#hasCurrentSocketIdentity()) ||
        !ownerBinding || !this.#options.dispatchCoexistingOperation) {
        if (productEnvelope) logOwnerBoundRejection(message, 'owner-lease-unavailable')
        socket.destroy()
        return
      }
      const response = await this.#mutationLease.run(
        leaseSocket,
        () => this.#options.dispatchCoexistingOperation!(message, line),
      )
      if (!response || this.#leaseSocket !== leaseSocket || leaseSocket.destroyed ||
        !(await this.#hasCurrentSocketIdentity()) || !isDeepStrictEqual(ownerBinding, this.#ownerBinding)) {
        if (productEnvelope) logOwnerBoundRejection(message, response ? 'owner-lease-lost' : 'no-response')
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
        bootstrapBinding: this.#options.bootstrapBinding,
        line,
        message,
      })
    } catch { socket.destroy(); return }
    this.#leaseConsumed = true
    this.#leaseSocket = socket
    socket.once('end', () => {
      if (this.#leaseSocket === socket) this.#leaseSocket = null
      socket.destroy()
    })
    socket.once('close', () => { if (this.#leaseSocket === socket) this.#leaseSocket = null })
    if (admission.protocol === 'legacy') {
      const unsigned = { schemaVersion: 2 as const, kind: 'ready' as const, capability: 'hosted-lifecycle-command' as const, challenge: admission.challenge, ownerBinding }
      socket.write(`${JSON.stringify({ ...unsigned, ownerProof: createHostedDomainProof(this.#options.secret, HOSTED_LIFECYCLE_PROOF_DOMAIN, 'readiness', unsigned) })}\n`)
      try { this.#options.onReadinessLease?.() } catch { /* readiness owns the lease regardless of advisory recovery */ }
      return
    }
    const unsigned = { schemaVersion: 2 as const, kind: 'ready' as const, capability: 'hosted-lifecycle-command' as const, challenge: admission.challenge, bootstrapDigest: admission.bootstrapDigest, ownerBinding }
    const response = { ...unsigned, ownerProof: createHostedRawDomainProof(this.#options.secret, HOSTED_LIFECYCLE_PROOF_DOMAIN, 'readiness', JSON.stringify(unsigned)) }
    socket.write(`${JSON.stringify(response)}\n`)
    try { this.#options.onReadinessLease?.() } catch { /* readiness owns the lease regardless of advisory recovery */ }
  }

  async #hasCurrentSocketIdentity(): Promise<boolean> {
    const ownerBinding = this.#ownerBinding; const parentIdentity = this.#socketParentIdentity
    if (!ownerBinding || !parentIdentity) return false
    const [socketStat, parentStat] = await Promise.all([lstat(this.#options.socketPath).catch(() => null), lstat(dirname(this.#options.socketPath)).catch(() => null)])
    return !!socketStat?.isSocket() && (socketStat.mode & 0o077) === 0 && (process.getuid?.() === undefined || socketStat.uid === process.getuid?.()) && !!parentStat?.isDirectory() && !parentStat.isSymbolicLink() && String(socketStat.dev) === ownerBinding.socketIdentity.device && String(socketStat.ino) === ownerBinding.socketIdentity.inode && socketStat.uid === ownerBinding.socketIdentity.uid && socketStat.gid === ownerBinding.socketIdentity.gid && (socketStat.mode & 0o777) === ownerBinding.socketIdentity.mode && parentStat.dev === parentIdentity.device && parentStat.ino === parentIdentity.inode
  }

  #isCurrentSocketIdentitySync(): boolean {
    const ownerBinding = this.#ownerBinding
    const parentIdentity = this.#socketParentIdentity
    return !!ownerBinding && !!parentIdentity && isSocketIdentityCurrentSync(
      this.#options.socketPath, ownerBinding, parentIdentity,
    )
  }
}

function isActivationPrepare(line: string): boolean {
  try {
    const value = JSON.parse(line) as Record<string, unknown>
    return !!value && typeof value === 'object' && !Array.isArray(value) &&
      value.operation === 'approval_activation_prepare'
  } catch {
    return false
  }
}

function isSocketIdentityCurrentSync(
  socketPath: string,
  ownerBinding: HostedControlOwnerBinding,
  parentIdentity: { device: number; inode: number },
): boolean {
  try {
    const socketStat = lstatSync(socketPath)
    const parentStat = lstatSync(dirname(socketPath))
    return socketStat.isSocket() && (socketStat.mode & 0o077) === 0 &&
      (process.getuid?.() === undefined || socketStat.uid === process.getuid?.()) &&
      parentStat.isDirectory() && !parentStat.isSymbolicLink() &&
      String(socketStat.dev) === ownerBinding.socketIdentity.device &&
      String(socketStat.ino) === ownerBinding.socketIdentity.inode &&
      socketStat.uid === ownerBinding.socketIdentity.uid &&
      socketStat.gid === ownerBinding.socketIdentity.gid &&
      (socketStat.mode & 0o777) === ownerBinding.socketIdentity.mode &&
      parentStat.dev === parentIdentity.device && parentStat.ino === parentIdentity.inode
  } catch {
    return false
  }
}

function writeRetainedFrame(socket: Socket, frame: string): Promise<void> {
  if (!frame.endsWith('\n') || frame.slice(0, -1).includes('\n')) {
    return Promise.reject(new Error('Hosted approval activation response is not one frame'))
  }
  return new Promise<void>((resolve, reject) => {
    socket.write(frame, error => error ? reject(error) : resolve())
  })
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function isApprovalOperation(value: unknown): boolean {
  return value === 'approval_ingress_claim' || value === 'approval_ingress_ack' ||
    value === 'approval_ingress_authority_resolve' || value === 'approval_decision_deliver' ||
    value === 'approval_decision_reconcile'
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
}

export function decodeHostedReadinessRequest(input: {
  secret: Uint8Array
  authority: HostedControlStableAuthority
  ownerBinding: HostedControlOwnerBinding
  bootstrapBinding?: Readonly<HostedControlBootstrapBinding>
  line: string
  message: Record<string, unknown>
}): HostedReadinessAdmission {
  if (Buffer.byteLength(input.line) > HOSTED_READINESS_MAX_LINE_BYTES) {
    throw new TypeError('Invalid hosted readiness frame size')
  }
  if (isLegacyReadiness(input.message)) {
    if (input.bootstrapBinding || !isDeepStrictEqual(input.message.socketIdentity, input.ownerBinding.socketIdentity) ||
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
    Array.isArray(bootstrap) || !input.bootstrapBinding ||
    !isDeepStrictEqual(bootstrap, input.bootstrapBinding) ||
    !validBootstrapBinding(bootstrap as Record<string, unknown>, input.authority, proofKeyId) ||
    !verifyRawReadiness(input.secret, signed.serializedUnsignedEnvelope, signed.proof)) {
    throw new TypeError('Invalid canonical hosted readiness proof')
  }
  return {
    protocol: 'canonical',
    challenge: input.message.challenge,
    bootstrapDigest: (bootstrap as Record<string, unknown>).bootstrapDigest as string,
  }
}

export function admitHostedReadiness(input: {
  secret: Uint8Array
  ownerBinding: HostedControlOwnerBinding
  bootstrapBinding?: Readonly<HostedControlBootstrapBinding>
  line: string
  message: Record<string, unknown>
}): boolean {
  const binding = input.bootstrapBinding
  const authority: HostedControlStableAuthority = {
    deploymentId: binding?.deploymentId ?? '',
    bootId: binding?.bootId ?? '',
    restoreGeneration: 0,
    workspaceId: binding?.workspaceId ?? '',
    teamId: `team_${'0'.repeat(32)}`,
    mountBinding: {
      mountGeneration: binding?.mountGeneration ?? 1,
      declaredRootHash: '0'.repeat(64),
    },
  }
  try {
    decodeHostedReadinessRequest({ ...input, authority })
    return true
  } catch {
    return false
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

function logOwnerBoundRejection(message: Record<string, unknown>, reason: string): void {
  process.stderr.write(`Hosted owner-bound request rejected: operation=${String(message.operation).slice(0, 32)} reason=${reason}\n`)
}

function writeBoundedResponse(socket: Socket, value: Record<string, unknown>): void {
  const line = `${JSON.stringify(value)}\n`
  const maximum = isApprovalOperation(value.operation)
    ? HOSTED_CONTROL_MAX_LINE_BYTES
    : HOSTED_CONTROL_STANDARD_MAX_LINE_BYTES
  if (Buffer.byteLength(line) > maximum) {
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

type PublicationProbe = {
  nonce: Buffer
  resolve(): void
  reject(error: unknown): void
}

function socketPublicationPath(socketPath: string): string {
  const parent = dirname(socketPath)
  const publishedName = basename(socketPath)
  const nameBytes = Buffer.byteLength(publishedName)
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidateName = randomBytes(Math.max(1, Math.ceil(nameBytes * 3 / 4)))
      .toString('base64url').slice(0, nameBytes)
    if (candidateName !== publishedName) return join(parent, candidateName)
  }
  throw new Error('Hosted control publication socket name could not be allocated')
}

async function listenLoopback(server: Server): Promise<void> {
  server.listen({ host: '127.0.0.1', port: 0, exclusive: true })
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => { server.off('listening', onListening); reject(error) }
    const onListening = () => { server.off('error', onError); resolve() }
    server.once('error', onError)
    server.once('listening', onListening)
  })
}

async function startSocketBroker(
  listenPath: string,
  targetPort: number,
  token: Buffer,
): Promise<ChildProcess> {
  const brokerArgs = [HOSTED_CONTROL_SOCKET_BROKER_FLAG, listenPath, String(targetPort)]
  const isCompiledBinary = Array.isArray(Bun.embeddedFiles) && Bun.embeddedFiles.length > 0
  if (!isCompiledBinary) {
    const entrypoint = process.argv[1]
    if (!entrypoint) throw new Error('Hosted control socket broker entrypoint is unavailable')
    if (entrypoint.endsWith('.test.ts')) {
      brokerArgs.splice(0, 1,
        new URL('./fixtures/hostedControlSocketBrokerChild.ts', import.meta.url).pathname)
    } else {
      brokerArgs.unshift(entrypoint)
    }
  }
  const broker = spawn(process.execPath, brokerArgs, {
    stdio: ['pipe', 'pipe', 'inherit', 'pipe'],
  })
  const tokenPipe = broker.stdio[3]
  if (!broker.stdin || !broker.stdout || !tokenPipe || !('write' in tokenPipe)) {
    broker.kill('SIGKILL')
    throw new Error('Hosted control socket broker pipes are unavailable')
  }
  await new Promise<void>((resolve, reject) => {
    let bytes = Buffer.alloc(0)
    const timeout = setTimeout(() => finish(new Error('Hosted control socket broker startup timed out')),
      HOSTED_CONTROL_READ_DEADLINE_MS)
    const finish = (error?: Error) => {
      clearTimeout(timeout)
      broker.stdout?.off('data', onData)
      tokenPipe.off('error', onTokenError)
      broker.off('error', onError)
      broker.off('exit', onExit)
      if (error) reject(error); else resolve()
    }
    const onData = (chunk: Buffer) => {
      bytes = Buffer.concat([bytes, chunk])
      if (bytes.byteLength > 256) { finish(new Error('Hosted control socket broker response was oversized')); return }
      const newline = bytes.indexOf(0x0a)
      if (newline < 0) return
      if (newline !== bytes.byteLength - 1 || bytes.toString('utf8', 0, newline) !==
        '{"schemaVersion":1,"kind":"ready"}') {
        finish(new Error('Hosted control socket broker response was invalid'))
        return
      }
      finish()
    }
    const onError = () => finish(new Error('Hosted control socket broker failed to start'))
    const onTokenError = () => finish(new Error('Hosted control socket broker credential write failed'))
    const onExit = () => finish(new Error('Hosted control socket broker exited before readiness'))
    broker.stdout.on('data', onData)
    tokenPipe.once('error', onTokenError)
    broker.once('error', onError)
    broker.once('exit', onExit)
    tokenPipe.end(token)
  }).catch(async error => {
    await killSocketBroker(broker)
    throw error
  })
  return broker
}

async function killSocketBroker(broker: ChildProcess): Promise<void> {
  if (broker.exitCode !== null || broker.signalCode !== null) return
  const exited = new Promise<void>(resolve => broker.once('exit', () => resolve()))
  broker.kill('SIGKILL')
  await exited
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
  })
}

async function proveSocketPathIsServerOwned(
  socketPath: string,
  arm: (probe: PublicationProbe) => void,
): Promise<void> {
  const nonce = randomBytes(32)
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const accepted = new Promise<void>((accept, decline) => { resolve = accept; reject = decline })
  arm({ nonce, resolve, reject })
  const client = connect(socketPath)
  const timeout = setTimeout(() => reject(
    new Error('Hosted control publication ownership proof timed out'),
  ), HOSTED_CONTROL_READ_DEADLINE_MS)
  client.once('error', reject)
  client.end(nonce)
  await accepted.finally(() => {
    clearTimeout(timeout)
    client.destroy()
  })
}

function consumePublicationProbe(
  socket: Socket,
  probe: PublicationProbe,
  initialData: Buffer = Buffer.alloc(0),
): void {
  let bytes = Buffer.from(initialData)
  socket.setTimeout(HOSTED_CONTROL_READ_DEADLINE_MS, () => {
    socket.destroy()
    probe.reject(new Error('Hosted control publication ownership proof timed out'))
  })
  socket.on('data', chunk => {
    bytes = Buffer.concat([bytes, chunk])
    if (bytes.byteLength > probe.nonce.byteLength) {
      socket.destroy()
      probe.reject(new Error('Hosted control publication ownership proof was invalid'))
    }
  })
  socket.once('end', () => {
    socket.destroy()
    if (bytes.byteLength === probe.nonce.byteLength && timingSafeEqual(bytes, probe.nonce)) probe.resolve()
    else probe.reject(new Error('Hosted control publication ownership proof was invalid'))
  })
  socket.once('error', probe.reject)
}

function sameSocketIdentity(
  stat: Stats,
  expected: { device: number; inode: number },
): boolean {
  return stat.isSocket() && stat.dev === expected.device && stat.ino === expected.inode
}

async function prepareSocketPath(socketPath: string): Promise<{ device: number; inode: number }> {
  const parent = dirname(socketPath)
  await mkdir(parent, { recursive: true, mode: 0o700 })
  await chmod(parent, 0o700)
  const handle = await open(parent, constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0)); const stat = await handle.stat(); await handle.close()
  const parentIdentity = { device: stat.dev, inode: stat.ino }
  let existing
  try { existing = await lstat(socketPath) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return parentIdentity
    throw error
  }
  if (!existing.isSocket() || (existing.mode & 0o077) !== 0 ||
    (process.getuid?.() !== undefined && existing.uid !== process.getuid?.())) {
    throw new Error('Refusing to replace an unsafe hosted control socket path')
  }
  if (await socketAcceptsConnections(socketPath)) {
    throw new Error('Refusing to replace an active hosted control socket')
  }
  await removeSocketIfIdentityMatches(socketPath, {
    device: existing.dev, inode: existing.ino,
  }, parentIdentity)
  return parentIdentity
}

async function socketAcceptsConnections(socketPath: string): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect(socketPath)
    let settled = false
    const finish = (active: boolean) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(active)
    }
    socket.setTimeout(250, () => finish(true))
    socket.once('connect', () => finish(true))
    socket.once('error', error => {
      const code = (error as NodeJS.ErrnoException).code
      finish(code !== 'ECONNREFUSED' && code !== 'ENOENT')
    })
  })
}

async function removeOwnedSocketPathIfCurrent(
  socketPath: string,
  expected: { device: number; inode: number },
  parentExpected: { device: number; inode: number },
): Promise<void> {
  const [socketStat, parentStat] = await Promise.all([
    lstat(socketPath).catch(() => null),
    lstat(dirname(socketPath)).catch(() => null),
  ])
  if (!socketStat || !parentStat?.isDirectory() || parentStat.isSymbolicLink() ||
    parentStat.dev !== parentExpected.device || parentStat.ino !== parentExpected.inode ||
    !sameSocketIdentity(socketStat, expected)) return
  await removeSocketIfIdentityMatches(socketPath, expected, parentExpected)
}

/** Atomically quarantines the path, then deletes only the admitted inode. */
async function removeSocketIfIdentityMatches(
  socketPath: string,
  expected: { device: number; inode: number },
  parentExpected: { device: number; inode: number },
): Promise<void> {
  const parent = dirname(socketPath)
  const quarantine = join(parent, `.${basename(socketPath)}.reclaim-${process.pid}-${randomBytes(16).toString('hex')}`)
  const parentBefore = await lstat(parent)
  if (!parentBefore.isDirectory() || parentBefore.isSymbolicLink() ||
    parentBefore.dev !== parentExpected.device || parentBefore.ino !== parentExpected.inode) {
    throw new Error('Hosted control socket parent was substituted')
  }
  try { await rename(socketPath, quarantine) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  const moved = await lstat(quarantine).catch(() => null)
  const parentAfter = await lstat(parent).catch(() => null)
  const movedMatches = !!moved?.isSocket() && moved.dev === expected.device && moved.ino === expected.inode
  const parentMatches = !!parentAfter?.isDirectory() && !parentAfter.isSymbolicLink() &&
    parentAfter.dev === parentExpected.device && parentAfter.ino === parentExpected.inode
  if (!movedMatches || !parentMatches) {
    // Never let restoration overwrite a replacement that appeared after the
    // quarantine rename. A hard link is an atomic no-replace restoration of
    // the exact inode; if the original name is occupied, preserve both names.
    if (parentMatches) {
      await link(quarantine, socketPath).then(
        () => unlink(quarantine),
        () => undefined,
      ).catch(() => undefined)
    }
    throw new Error('Hosted control socket changed during inode-safe removal')
  }
  await unlink(quarantine)
}
