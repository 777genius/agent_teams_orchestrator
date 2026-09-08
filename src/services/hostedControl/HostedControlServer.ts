import { AsyncLocalStorage } from 'node:async_hooks'
import type { ChildProcess } from 'node:child_process'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { link, lstat } from 'node:fs/promises'
import { createServer, type Server, Socket } from 'node:net'
import { basename, dirname, resolve } from 'node:path'
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
import { isSocketIdentityCurrentSync, socketPublicationPath, listenLoopback, startSocketBrokerBatch, startLegacySocketBroker,
  closeServer, proveSocketPathIsServerOwned, consumePublicationProbe, sameSocketIdentity,
  prepareSocketPath, removeOwnedSocketPathIfCurrent,
  type PublicationProbe, type SocketBrokerBorrow, type SocketBrokerBatch } from './HostedControlServerPublication.js'
import type { SocketBrokerMapping } from './HostedControlSocketBroker.js'
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
  /** Explicit composition choice. Omission and startBatch always mean native. */
  brokerTransport?: 'native-batch' | 'legacy'

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
  afterSocketPublicationForTest?: (brokerPid: number) => void | Promise<void>
  /** Observe the actual child and loopback resources, before publication. */
  afterBrokerSpawnForTest?: (broker: ChildProcess) => void
  afterBrokerTargetCreatedForTest?: (server: Server, token: Buffer) => void
  /** Deterministic close-window seam for hidden-path replacement regression tests. */
  beforeSocketCloseForTest?: (listenPath: string) => void | Promise<void>
  /** Observe the exact shutdown activation promise after preceding resource drains. */
  beforeActivationDrainForTest?: (revocation: Promise<void>) => void
  /** Deterministic retained-write seam for activation transport regression tests. */
  beforeActivationFrameWriteForTest?: (
    phase: 'owner_ready' | 'ready', socket: HostedControlConnection,
  ) => void | Promise<void>
  dispatchCoexistingOperation?: (message: Record<string, unknown>, rawLine: string) => Promise<Record<string, unknown> | null>
  /** Optional one-use approval activation transport. Lifecycle readiness remains independent. */
  activationSessionFactory?: HostedApprovalActivationSessionFactory
  /** Reserve activation for FD5 even during asynchronous socket publication. */
  activationTransport?: 'inherited-v2'
  /** Runs only after the real ready write completes; failure revokes activation. */
  onActivationReady?: () => Promise<void>
  /** Synchronous revocation notification; resource draining remains runtime-owned. */
  onProviderAuthorityLost?: () => void
  /** Native entry keeps ordinary traffic closed until provider adoption settles. */
  isEffectReady?: () => boolean
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
  #broker: SocketBrokerBorrow | null = null
  #brokerToken: Buffer | null = null
  #publicationProbe: PublicationProbe | null = null
  #starting = false
  #stopRevision = 0
  #batchReady = false
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
  readonly #pendingResponses = new Set<{ lease: HostedControlConnection; close: () => void }>()
  readonly #handlers = new Set<Promise<void>>()
  #stopping = false
  #stopPromise: Promise<void> | null = null
  #providerAuthorityLost = false

  constructor(options: HostedControlServerOptions) {
    this.#options = options
  }

  get ownerBinding(): HostedControlOwnerBinding | null {
    // Shared currency is fenced before the first borrower's loss callback;
    // never expose a sibling's retained binding during that callback.
    return this.#broker?.isCurrent() ? this.#ownerBinding : null
  }
  async hasActiveLease(): Promise<boolean> {
    const expectedLease = this.#mutationLease.getStore() ?? this.#leaseSocket
    return !!expectedLease && await this.#hasCurrentSocketIdentity() &&
      !this.#stopping && this.#leaseSocket === expectedLease && !expectedLease.destroyed
  }

  hasRetainedActivation(): boolean {
    return !!this.#activation && this.#activation.phase === 'leased' && this.#isActivationCurrent(this.#activation)
  }

  /** Session component of native provider authority. Root/profile/process
   * fences remain separate. Preparation cannot occur during recovery or the
   * ready write, and consumption retains the exact lifecycle connection. */
  prepareRetainedProviderToken(): { consume(): boolean } | null {
    const candidate = this.#activation
    const lease = this.#mutationLease.getStore() ?? this.#leaseSocket
    if (this.#providerAuthorityLost || !candidate || candidate.phase !== 'leased' || !lease ||
      this.#leaseSocket !== lease || lease.destroyed || !this.hasRetainedActivation()) return null
    const activation = this.#prepareActivationEffectToken(candidate)
    if (!activation) return null
    let used = false
    return Object.freeze({ consume: () => {
      if (used) return false
      used = true
      // Consume even on lease loss; one-use activation authority must not leak.
      const activationCurrent = activation.consume()
      return activationCurrent && !this.#stopping && candidate.phase === 'leased' &&
        this.#activation === candidate && this.#leaseSocket === lease && !lease.destroyed
    } })
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
    if (this.#options.brokerTransport === 'legacy') {
      if (this.#options.activationTransport === 'inherited-v2') {
        throw new Error('Hosted sealed-v2 activation requires native broker transport')
      }
      await this.#startLegacy()
    } else {
      await HostedControlServer.startBatch([this])
    }
  }

  async #startLegacy(): Promise<void> {
    if (this.#server || this.#starting) throw new Error('Hosted control server is already started')
    if (typeof Bun === 'undefined') throw new Error('Hosted control Unix socket publication requires the Bun runtime')
    this.#starting = true
    const revision = this.#stopRevision
    try {
      await this.#stopPromise
      if (this.#stopRevision !== revision) throw new Error('Hosted control server stopped during preparation')
      this.#stopping = false
      const mapping = await this.#prepareBrokerTarget()
      this.#broker = await startLegacySocketBroker(mapping, () => {
        this.#batchReady = false
        this.#ownerBinding = null
        void this.stop().catch(() => undefined)
      }, { afterSpawn: broker => this.#options.afterBrokerSpawnForTest?.(broker) })
      this.#ownedSocketIdentity = this.#broker.identity
      this.#ownsSocket = true
      this.#assertPrepared()
      await this.#publishBrokerSocket()
      this.#assertPrepared()
      if (!this.#broker.isCurrent() || !this.#ownerBinding || !this.#socketParentIdentity ||
        !isSocketIdentityCurrentSync(this.#options.socketPath, this.#ownerBinding, this.#socketParentIdentity)) {
        throw new Error('Hosted control socket broker attachment is stale')
      }
      this.#batchReady = true
    } catch (error) {
      this.#batchReady = false
      this.#publicationProbe?.reject(error)
      this.#publicationProbe = null
      await this.stop().catch(() => undefined)
      throw error
    } finally {
      this.#starting = false
    }
  }

  /** Thin helper prerequisite: prepares all loopback targets, borrows one
   * supervised child, then publishes exactly one or two lifecycle endpoints.
   * Native slot admission and generation ownership remain external. */
  static async startBatch(input: readonly HostedControlServer[]): Promise<void> {
    if (input.length !== 1 && input.length !== 2) throw new Error('Hosted control server batch requires one or two distinct endpoints')
    const servers = [...input]
    if (servers.some(server => server.#options.brokerTransport === 'legacy')) {
      throw new Error('Hosted control native batch cannot select legacy transport')
    }
    if (new Set(servers).size !== servers.length ||
      new Set(servers.map(server => resolve(server.#options.socketPath))).size !== servers.length) {
      throw new Error('Hosted control server batch requires one or two distinct endpoints')
    }
    if (servers.some(server => server.#server || server.#starting)) throw new Error('Hosted control server is already started')
    if (typeof Bun === 'undefined') throw new Error('Hosted control Unix socket publication requires the Bun runtime')
    // Reserve every participant before yielding; overlapping starts cannot take
    // or clean up a server belonging to another batch.
    for (const server of servers) server.#starting = true
    const revisions = servers.map(server => server.#stopRevision)
    let batch: SocketBrokerBatch | null = null
    try {
      await Promise.all(servers.map(server => server.#stopPromise))
      if (servers.some((server, index) => server.#stopRevision !== revisions[index])) {
        throw new Error('Hosted control server stopped during preparation')
      }
      for (const server of servers) server.#stopping = false
      const mappings: SocketBrokerMapping[] = []
      for (const server of servers) mappings.push(await server.#prepareBrokerTarget())
      // Parent-inode aliases must not name the same endpoint. Hidden paths must
      // also be distinct from every selected canonical path.
      for (let index = 0; index < servers.length; index += 1) {
        const mapping = mappings[index]!
        if (servers.some((server, other) => {
          const parent = mappings[other]!.parentIdentity
          const sameParent = parent.device === mapping.parentIdentity.device && parent.inode === mapping.parentIdentity.inode
          return sameParent && (basename(server.#options.socketPath) === basename(mapping.listenPath) ||
            (other !== index && basename(server.#options.socketPath) === basename(servers[index]!.#options.socketPath)))
        })) {
          throw new Error('Hosted control hidden publication path collides with a selected endpoint')
        }
      }
      batch = await startSocketBrokerBatch(mappings, { afterSpawn: broker => {
        for (const server of servers) server.#options.afterBrokerSpawnForTest?.(broker)
      } })
      for (const server of servers) server.#assertPrepared()
      for (const [index, server] of servers.entries()) {
        server.#broker = batch.borrow(index, () => {
          // Every borrower is synchronously fenced in the shared exit turn.
          server.#batchReady = false
          server.#ownerBinding = null
          void server.stop().catch(() => undefined)
        })
        server.#ownedSocketIdentity = server.#broker.identity
        server.#ownsSocket = true
      }
      for (const server of servers) await server.#publishBrokerSocket()
      for (const server of servers) {
        server.#assertPrepared()
        if (!server.#broker?.isCurrent() || !server.#ownerBinding || !server.#socketParentIdentity ||
          !isSocketIdentityCurrentSync(server.#options.socketPath, server.#ownerBinding, server.#socketParentIdentity)) {
          throw new Error('Hosted control socket broker attachment is stale')
        }
      }
      // No ordinary traffic is admitted until all publications have attached.
      for (const server of servers) server.#batchReady = true
    } catch (error) {
      for (const server of servers) {
        server.#batchReady = false
        server.#publicationProbe?.reject(error)
        server.#publicationProbe = null
      }
      await Promise.allSettled(servers.map(server => server.stop()))
      throw error
    } finally {
      try { await batch?.release() } finally {
        for (const server of servers) server.#starting = false
      }
    }
  }

  #assertPrepared(): void {
    if (this.#stopping || !this.#server || !this.#listenPath || !this.#socketParentIdentity) {
      throw new Error('Hosted control socket broker attachment is unavailable')
    }
  }

  async #prepareBrokerTarget(): Promise<SocketBrokerMapping> {
    const parentIdentity = await prepareSocketPath(this.#options.socketPath)
    if (this.#stopping) throw new Error('Hosted control server stopped during preparation')
    this.#socketParentIdentity = parentIdentity
    const listenPath = resolve(socketPublicationPath(this.#options.socketPath))
    const brokerToken = randomBytes(32)
    this.#brokerToken = brokerToken
    const server = createServer({ allowHalfOpen: true }, socket => this.#admitBrokerConnection(socket, brokerToken, (admitted, initialData) => {
      if (this.#publicationProbe) consumePublicationProbe(admitted, this.#publicationProbe, initialData)
      else this.#handleConnection(admitted, initialData)
    }))
    this.#server = server
    this.#listenPath = listenPath
    this.#options.afterBrokerTargetCreatedForTest?.(server, brokerToken)
    await listenLoopback(server)
    this.#assertPrepared()
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Hosted control broker endpoint is unavailable')
    return { listenPath, targetPort: address.port, token: brokerToken, parentIdentity }
  }

  async #publishBrokerSocket(): Promise<void> {
    this.#assertPrepared()
    const listenPath = this.#listenPath!
    const parentIdentity = this.#socketParentIdentity!
    const admittedSocketIdentity = this.#ownedSocketIdentity!
    const broker = this.#broker!
    const admittedSocketStat = await lstat(listenPath)
    if (!sameSocketIdentity(admittedSocketStat, admittedSocketIdentity) || (admittedSocketStat.mode & 0o777) !== 0o600 ||
      (process.getuid?.() !== undefined && admittedSocketStat.uid !== process.getuid?.())) {
      throw new Error('Hosted control publication socket is not privately owned')
    }
    this.#assertPrepared()
    await proveSocketPathIsServerOwned(listenPath, probe => { this.#publicationProbe = probe })
    this.#publicationProbe = null
    this.#assertPrepared()
    const provedSocketStat = await lstat(listenPath)
    if (!sameSocketIdentity(provedSocketStat, admittedSocketIdentity)) {
      throw new Error('Hosted control publication socket changed during ownership proof')
    }
    this.#assertPrepared()
    await link(listenPath, this.#options.socketPath)
    // A concurrent stop may have checked the canonical path before link finished.
    if (this.#stopping) {
      await removeOwnedSocketPathIfCurrent(this.#options.socketPath, admittedSocketIdentity, parentIdentity)
      throw new Error('Hosted control server stopped during publication')
    }
    await removeOwnedSocketPathIfCurrent(listenPath, admittedSocketIdentity, parentIdentity)
    await this.#options.afterSocketPublicationForTest?.(broker.pid)
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
    this.#assertPrepared()
    if (!this.#broker?.isCurrent()) throw new Error('Hosted control socket broker exited during publication')
    this.#ownerBinding = {
      ...this.#options.ownerIdentity,
      socketIdentity: {
        device: String(publishedSocketStat.dev), inode: String(publishedSocketStat.ino),
        uid: publishedSocketStat.uid, gid: publishedSocketStat.gid,
        mode: publishedSocketStat.mode & 0o777,
      },
    }
  }

  async stop(): Promise<void> {
    this.#stopRevision += 1
    if (this.#stopPromise) return this.#stopPromise
    let resolve!: () => void
    let reject!: (error: unknown) => void
    const stopping = new Promise<void>((accept, decline) => { resolve = accept; reject = decline })
    // Publish the drain promise before synchronous revocation callbacks can
    // reenter stop(). Fencing itself still happens in this call's turn.
    this.#stopPromise = stopping
    void this.#stop().then(resolve, reject)
    try {
      await stopping
    } finally {
      if (this.#stopPromise === stopping) this.#stopPromise = null
    }
  }

  async #stop(): Promise<void> {
    this.#stopping = true
    this.#batchReady = false
    this.#ownerBinding = null
    this.#loseProviderAuthority()
    this.#publicationProbe?.reject(new Error('Hosted control server stopped'))
    this.#publicationProbe = null
    this.#brokerToken?.fill(0)
    this.#brokerToken = null
    const errors: unknown[] = []
    try { this.#inheritedActivation?.close() } catch (error) { errors.push(error) }
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
    const peerClosures = [...this.#sockets].filter(socket => socket instanceof Socket)
      .map(socket => new Promise<void>(resolve => socket.once('close', () => resolve())))
    for (const socket of this.#sockets) socket.destroy()
    this.#sockets.clear()
    const drain = async (action: () => Promise<unknown> | unknown) => {
      try { await action() } catch (error) { errors.push(error) }
    }
    // Cleanup failures (including substituted names) never skip another owned
    // resource. Dropping this borrow cannot kill a still-borrowed sibling.
    await drain(() => this.#options.beforeSocketCloseForTest?.(listenPath ?? ''))
    if (broker) await drain(() => broker.release())
    if (server) await drain(() => closeServer(server).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') throw error
    }))
    await Promise.all(peerClosures)
    if (listenPath && ownedSocketIdentity && parentIdentity) {
      await drain(() => removeOwnedSocketPathIfCurrent(listenPath, ownedSocketIdentity, parentIdentity))
    }
    await Promise.allSettled([...this.#handlers])
    try { this.#options.beforeActivationDrainForTest?.(activationRevocation) } catch {}
    await activationRevocation.catch(() => undefined)
    if (this.#ownsSocket) {
      this.#ownsSocket = false
      if (ownedSocketIdentity && parentIdentity) {
        await drain(() => removeOwnedSocketPathIfCurrent(this.#options.socketPath, ownedSocketIdentity, parentIdentity))
      }
    }
    if (errors.length) throw errors[0]
  }

  #handleConnection(socket: HostedControlConnection, initialData = Buffer.alloc(0)): void {
    if (this.#stopping || !this.#server || !this.#batchReady) { socket.destroy(); return }
    socket.setTimeout(this.#options.readDeadlineMs ?? HOSTED_CONTROL_READ_DEADLINE_MS)
    let chunks: Buffer[] = []
    let bytes = 0
    let finished = false
    let terminal = false

    const failClosed = (cause: unknown = new Error('Hosted control connection failed closed')) => {
      terminal = true
      finished = true
      chunks = []
      this.#loseReadinessLease(socket)
      const activation = this.#activation
      if (activation?.socket === socket) {
        void this.#revokeActivation(activation, asError(cause))
      } else {
        socket.destroy()
      }
    }
    socket.once('timeout', failClosed)
    socket.once('error', failClosed)
    socket.once('end', () => {
      // Retained channels lose authority on readable EOF, even with a full frame.
      if (this.#activation?.socket === socket || this.#leaseSocket === socket || !finished || terminal) {
        failClosed(new Error('Hosted control retained or incomplete connection ended'))
      }
      // A finite response remains writable through end(response) flushing.
    })
    socket.once('close', failClosed)
    const onData = (chunk: Buffer) => {
      const activation = this.#activation
      if (activation?.socket === socket) {
        this.#handleActivationData(activation, chunk)
        return
      }
      if (finished) {
        failClosed()
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
      chunks = []
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
      const handler = this.#processLine(socket, line, () => !terminal, failClosed)
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
      if (this.#options.onActivationReady) {
        if (!await this.hasActiveLease()) throw new Error('Hosted approval lifecycle lease missing')
        await this.#options.onActivationReady()
        if (!this.#isActivationCurrent(candidate) || !await this.hasActiveLease()) {
          throw new Error('Hosted approval authority lost during provider adoption')
        }
      }
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
        const current = this.#batchReady && !this.#stopping && !!this.#broker?.isCurrent() &&
          !!ownerBinding && !!parentIdentity &&
          this.#activation === candidate && this.#activationGeneration === generation &&
          candidate.socket === socket && !socket.destroyed &&
          (this.#inheritedSocket !== socket ||
            this.#inheritedActivation!.isEffectCurrent(candidate.phase === 'leased')) &&
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
    let resolve!: () => void
    let reject!: (error: unknown) => void
    const revocation = new Promise<void>((accept, decline) => { resolve = accept; reject = decline })
    // Reentrant provider-loss/stop callbacks must drain this exact cleanup.
    candidate.revokePromise = revocation
    // FIN/close/monitor callers may discard this promise before stop reaches
    // its drain. Observe rejection now without changing its identity/settlement.
    void candidate.revokePromise.catch(() => undefined)
    candidate.phase = 'revoked'
    this.#loseProviderAuthority()
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
    // Invoke synchronously to preserve O2-C's O2-A authority linearization;
    // only settlement is asynchronous, and the published promise never changes.
    try {
      const cleanup = candidate.session?.revoke()
      void Promise.resolve(cleanup).then(resolve, reject)
    } catch (cause) {
      reject(cause)
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

  #loseReadinessLease(socket: HostedControlConnection): void {
    if (this.#leaseSocket !== socket) return
    this.#leaseSocket = null
    for (const pending of this.#pendingResponses) {
      if (pending.lease === socket) pending.close()
    }
    this.#loseProviderAuthority()
  }

  #loseProviderAuthority(): void {
    if (this.#providerAuthorityLost) return
    this.#providerAuthorityLost = true
    for (const pending of this.#pendingResponses) pending.close()
    // Cleanup notification cannot prevent exact socket/session revocation.
    try { this.#options.onProviderAuthorityLost?.() } catch {}
  }

  #admitBrokerConnection(
    socket: Socket,
    expectedToken: Buffer,
    admit: (socket: Socket, initialData: Buffer) => void,
  ): void {
    if (this.#stopping) { socket.destroy(); return }
    this.#sockets.add(socket)
    socket.once('close', () => this.#sockets.delete(socket))
    let buffered = Buffer.alloc(0)
    const reject = () => { buffered = Buffer.alloc(0); socket.destroy() }
    socket.once('end', reject)
    socket.setTimeout(this.#options.readDeadlineMs ?? HOSTED_CONTROL_READ_DEADLINE_MS, reject)
    socket.once('error', () => undefined)
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk])
      if (buffered.byteLength < expectedToken.byteLength) return
      socket.off('data', onData)
      const token = buffered.subarray(0, expectedToken.byteLength)
      if (!timingSafeEqual(token, expectedToken)) { reject(); return }
      socket.setTimeout(0)
      socket.off('timeout', reject)
      socket.off('end', reject)
      const remainder = buffered.subarray(expectedToken.byteLength)
      buffered = Buffer.alloc(0)
      admit(socket, remainder)
    }
    socket.on('data', onData)
  }

  async #processLine(socket: HostedControlConnection, line: string, isNonterminal: () => boolean, failClosed: () => void): Promise<void> {
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
    if (this.#options.isEffectReady && !this.#options.isEffectReady()) { socket.destroy(); return }
    const leaseSocket = this.#leaseSocket
    const eligible = () => isNonterminal() && !socket.destroyed && !this.#stopping &&
      !!leaseSocket && this.#leaseSocket === leaseSocket && !leaseSocket.destroyed &&
      (!this.#options.isEffectReady || this.#options.isEffectReady())
    if (!eligible() || !leaseSocket) { failClosed(); return }
    // Subscribe before the first await; retain cleanup through response flush.
    const pending = { lease: leaseSocket, close: failClosed }
    this.#pendingResponses.add(pending)
    socket.once('close', () => this.#pendingResponses.delete(pending))
    if (message.operation !== HOSTED_CONTROL_OPERATION) {
      const ownerBinding = this.#ownerBinding
      if (!leaseSocket || leaseSocket.destroyed || !(await this.#hasCurrentSocketIdentity()) ||
        !ownerBinding || !this.#options.dispatchCoexistingOperation || !eligible()) {
        socket.destroy()
        return
      }
      const response = await this.#mutationLease.run(
        leaseSocket,
        () => this.#options.dispatchCoexistingOperation!(message, line),
      )
      if (!response || this.#leaseSocket !== leaseSocket || leaseSocket.destroyed ||
        !(await this.#hasCurrentSocketIdentity()) || !isDeepStrictEqual(ownerBinding, this.#ownerBinding) || !eligible()) {
        socket.destroy()
        return
      }
      writeBoundedResponse(socket, response, eligible)
      return
    }
    if (!leaseSocket || leaseSocket.destroyed || !(await this.#hasCurrentSocketIdentity())) { socket.destroy(); return }
    const request = decodeHostedTaskMutationRequest(message)
    const ownerBinding = this.#ownerBinding
    const [socketStat, parentStat] = await Promise.all([lstat(this.#options.socketPath).catch(() => null), lstat(dirname(this.#options.socketPath)).catch(() => null)])
    const parentIdentity = this.#socketParentIdentity
    if (!eligible() || !ownerBinding || !socketStat?.isSocket() ||
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
    if (this.#leaseSocket !== leaseSocket || leaseSocket.destroyed || !(await this.#hasCurrentSocketIdentity()) || JSON.stringify(request.ownerBinding) !== JSON.stringify(this.#ownerBinding) || !eligible()) { socket.destroy(); return }
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
    const responseLine = `${JSON.stringify(response)}\n`
    if (!eligible()) { failClosed(); return }
    socket.end(responseLine)
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
    socket.once('close', () => this.#loseReadinessLease(socket))
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
    if (!this.#batchReady || !this.#broker?.isCurrent()) return false
    const ownerBinding = this.#ownerBinding; const parentIdentity = this.#socketParentIdentity
    if (!ownerBinding || !parentIdentity) return false
    const [socketStat, parentStat] = await Promise.all([lstat(this.#options.socketPath).catch(() => null), lstat(dirname(this.#options.socketPath)).catch(() => null)])
    return this.#batchReady && !!this.#broker?.isCurrent() && this.#ownerBinding === ownerBinding &&
      !!socketStat?.isSocket() && (socketStat.mode & 0o077) === 0 && (process.getuid?.() === undefined || socketStat.uid === process.getuid?.()) && !!parentStat?.isDirectory() && !parentStat.isSymbolicLink() && String(socketStat.dev) === ownerBinding.socketIdentity.device && String(socketStat.ino) === ownerBinding.socketIdentity.inode && socketStat.uid === ownerBinding.socketIdentity.uid && socketStat.gid === ownerBinding.socketIdentity.gid && (socketStat.mode & 0o777) === ownerBinding.socketIdentity.mode && parentStat.dev === parentIdentity.device && parentStat.ino === parentIdentity.inode
  }

  #isCurrentSocketIdentitySync(): boolean {
    if (!this.#batchReady || !this.#broker?.isCurrent()) return false
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

function writeBoundedResponse(socket: HostedControlConnection, value: Record<string, unknown>, eligible: () => boolean): void {
  const line = `${JSON.stringify(value)}\n`
  const maximum = isApprovalOperation(value.operation)
    ? HOSTED_CONTROL_MAX_LINE_BYTES
    : HOSTED_CONTROL_STANDARD_MAX_LINE_BYTES
  if (Buffer.byteLength(line) > maximum) {
    throw new Error('Hosted control response exceeds maximum line size')
  }
  if (!eligible()) { socket.destroy(); return }
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
