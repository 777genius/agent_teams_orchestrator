import { AsyncLocalStorage } from 'node:async_hooks'
import { type ChildProcess } from 'node:child_process'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { link, lstat } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { dirname } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import {
  createHostedControlProof,
  createHostedDomainProof,
  createHostedRawDomainProof,
  verifyHostedControlProof,
} from './ownerProof.js'
import type { HostedControlBootstrapBinding } from './HostedControlBootstrap.js'
import type { HostedControlInheritedActivationV2 } from './HostedControlInheritedActivationV2.js'
import type { HostedControlConnection } from './HostedControlConnection.js'
import { decodeHostedReadinessRequest, HOSTED_LIFECYCLE_PROOF_DOMAIN, HOSTED_READINESS_MAX_LINE_BYTES,
  type HostedReadinessAdmission } from './HostedControlReadiness.js'
export { decodeHostedReadinessRequest, admitHostedReadiness, HOSTED_READINESS_MAX_LINE_BYTES,
  HOSTED_LIFECYCLE_PROOF_DOMAIN, type HostedReadinessAdmission } from './HostedControlReadiness.js'
import { isSocketIdentityCurrentSync, socketPublicationPath, listenLoopback, startSocketBroker,
  killSocketBroker, closeServer, proveSocketPathIsServerOwned, consumePublicationProbe, sameSocketIdentity,
  prepareSocketPath, removeOwnedSocketPathIfCurrent, removeSocketIfIdentityMatches,
  type PublicationProbe } from './HostedControlServerPublication.js'
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
export const HOSTED_TEAM_MESSAGE_PROOF_DOMAIN = 'agent-teams.hosted-team-message.owner-proof/v1'

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
    phase: 'owner_ready' | 'ready', socket: HostedControlConnection,
  ) => void | Promise<void>
  dispatchCoexistingOperation?: (message: Record<string, unknown>, rawLine: string) => Promise<Record<string, unknown> | null>
  /** Optional one-use approval activation transport. Lifecycle readiness remains independent. */
  activationSessionFactory?: HostedApprovalActivationSessionFactory
  /** Reserve activation for FD5 even during asynchronous socket publication. */
  activationTransport?: 'inherited-v2'
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
  readonly socket: HostedControlConnection
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

export class HostedControlServer {
  readonly #options: HostedControlServerOptions
  #server: Server | null = null
  #broker: ChildProcess | null = null
  #ownsSocket = false
  readonly #sockets = new Set<HostedControlConnection>()
  #ownerBinding: HostedControlOwnerBinding | null = null
  #socketParentIdentity: { device: number; inode: number } | null = null
  #ownedSocketIdentity: { device: number; inode: number } | null = null
  #listenPath: string | null = null
  #leaseSocket: HostedControlConnection | null = null
  #leaseConsumed = false
  #activationConsumed = false
  #activationGeneration = 0
  #activation: ActivationCandidate | null = null
  #inheritedActivation: HostedControlInheritedActivationV2 | null = null
  #inheritedSocket: HostedControlConnection | null = null
  readonly #mutationLease = new AsyncLocalStorage<HostedControlConnection>()
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

  /** Transfers the exact admitted FD5; publication remains the actual socket
   * identity used by the existing activation verifier. No broker or reconnect. */
  attachInheritedActivationV2(resource: HostedControlInheritedActivationV2): void {
    if (this.#inheritedActivation === resource) throw new Error('Hosted control inherited activation already attached')
    if (!this.#server || !this.#ownerBinding || !this.#options.activationSessionFactory ||
      this.#options.activationTransport !== 'inherited-v2' || this.#inheritedActivation ||
      this.#stopping || !this.#isCurrentSocketIdentitySync()) {
      resource.close(); throw new Error('Hosted control inherited activation unavailable')
    }
    const socket = resource.take()
    this.#inheritedActivation = resource
    this.#inheritedSocket = socket
    this.#sockets.add(socket)
    socket.once('close', () => this.#sockets.delete(socket))
    this.#handleConnection(socket)
    socket.resume()
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
    const server = createServer(socket => this.#admitBrokerConnection(socket, brokerToken, (admitted, initialData) => {
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
    this.#inheritedActivation?.close()
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

  #handleConnection(socket: HostedControlConnection, initialData = Buffer.alloc(0)): void {
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
      }
    })
    socket.once('close', () => {
      const activation = this.#activation
      if (activation?.socket === socket) {
        void this.#revokeActivation(activation, new Error('Hosted approval activation lease closed'))
      }
    })
    const onData = (chunk: Buffer) => {
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
      if (bytes > (this.#inheritedSocket === socket
        ? HOSTED_APPROVAL_ACTIVATION_PREPARE_MAX_BYTES : HOSTED_CONTROL_MAX_LINE_BYTES)) {
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
      if (this.#inheritedSocket === socket) { failClosed(); return }
      const handler = this.#processLine(socket, line)
        .catch(failClosed)
      this.#handlers.add(handler)
      void handler.finally(() => this.#handlers.delete(handler))
    }
    socket.on('data', onData)
    if (initialData.byteLength > 0) onData(initialData)
  }

  async #beginActivation(socket: HostedControlConnection, prepareFrame: string): Promise<void> {
    if ((this.#options.activationTransport === 'inherited-v2' && socket !== this.#inheritedSocket) ||
      this.#activationConsumed || this.#activation || this.#stopping ||
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
      await writeRetainedFrame(socket, ready, () => this.#isActivationCurrent(candidate))
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
      await writeRetainedFrame(candidate.socket, ownerReady, () => this.#isActivationCurrent(candidate))
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
          (this.#inheritedSocket !== socket || this.#inheritedActivation!.isCurrent()) &&
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
      (this.#inheritedSocket !== candidate.socket || this.#inheritedActivation!.isCurrent()) &&
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

  async #processLine(socket: HostedControlConnection, line: string): Promise<void> {
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

  async #handleReadiness(socket: HostedControlConnection, line: string, message: Record<string, unknown>): Promise<void> {
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

function writeRetainedFrame(socket: HostedControlConnection, frame: string, isCurrent: () => boolean): Promise<void> {
  if (!frame.endsWith('\n') || frame.slice(0, -1).includes('\n')) {
    return Promise.reject(new Error('Hosted approval activation response is not one frame'))
  }
  return new Promise<void>((resolve, reject) => {
    // Revalidate synchronously after any retained-write await/seam, before the
    // first write. The inherited adapter checks the FD again on every send.
    if (!isCurrent()) { reject(new Error('Hosted approval activation write is stale')); return }
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

function writeBoundedResponse(socket: HostedControlConnection, value: Record<string, unknown>): void {
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
