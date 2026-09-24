import { chmod, lstat, realpath, unlink } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { basename, dirname, isAbsolute } from 'node:path'

import { assertNoDuplicateJsonObjectKeys } from '../ownerProof.js'
import type { HostedControlAuthority, HostedControlOwnerBinding } from '../protocol.js'
import type { HostedTaskMutationService } from '../HostedTaskMutationService.js'
import { createHostedAgentToolExecutors, type HostedAgentTaskCommentWriter, type HostedAgentTaskReader, type HostedAgentTeamMessageSender } from '../agentTools/HostedAgentToolExecutors.js'
import { HostedAgentToolEffectGate } from '../agentTools/HostedAgentToolEffectGate.js'
import { HostedAgentToolReceiver } from '../agentTools/HostedAgentToolReceiver.js'
import type { HostedAgentToolRequest } from '../agentTools/HostedAgentToolContract.js'
import { HostedAgentToolWal, type HostedAgentToolBinding } from '../agentTools/HostedAgentToolWal.js'
import { matchesHostedAgentRootConnector, readLinuxHostedAgentPeerCredentials,
  type HostedAgentExpectedRootConnector, type HostedAgentPeerCredentials } from './HostedAgentPeerCredentials.js'

type Context = HostedAgentToolRequest['context']
type PendingBinding = Readonly<Omit<HostedAgentToolBinding, 'sessionID'>>
export type HostedAgentToolRosterMember = Readonly<{
  teamId: string; runId: string; laneId: string; memberId: string; memberName: string
}>
export type HostedAgentToolPostExecProof = Readonly<{
  operationId: string
  containerGeneration: string
  runId: string
  laneId: string
  memberId: string
  sessionID: string
}>

export type HostedAgentToolBrokerOptions = Readonly<{
  socketPath: string
  /** 32 random bytes, hex-encoded; transfer only to the trusted root connector. */
  challenge: string
  operationId: string
  containerGeneration: string
  expectedRootConnector: HostedAgentExpectedRootConnector
  /** Inert fixture only; never installed by a production composition. */
  testOnlyReadPeerCredentials?: (socket: Socket) => Promise<HostedAgentPeerCredentials>
  /** Born before OpenCode Start; session ID must be bound once from its authenticated receipt. */
  binding: PendingBinding
  /** Immutable admitted launch roster, never a tool argument or mutable display-name lookup. */
  roster: readonly HostedAgentToolRosterMember[]
  teamName: string
  gate: HostedAgentToolEffectGate
  wal: HostedAgentToolWal
  authority: Readonly<HostedControlAuthority>
  ownerBinding: Readonly<HostedControlOwnerBinding>
  taskService: Pick<HostedTaskMutationService, 'mutate'>
  taskReader: HostedAgentTaskReader
  comments: HostedAgentTaskCommentWriter
  messages: HostedAgentTeamMessageSender
  isCurrent: (binding: Readonly<HostedAgentToolBinding>, context: Context) => boolean | Promise<boolean>
  /** Must read the current exact recipient incarnation, not resolve by name alone. */
  currentRecipient: (to: string, binding: Readonly<HostedAgentToolBinding>) =>
    HostedAgentToolRosterMember | null | Promise<HostedAgentToolRosterMember | null>
  canSendTo: (to: string, binding: Readonly<HostedAgentToolBinding>) => boolean | Promise<boolean>
  /** Must independently verify root helper and supervisor post-exec attestations. */
  verifyPostExec: (proof: HostedAgentToolPostExecProof) => Promise<boolean>
}>

const MAX_HANDSHAKE_BYTES = 512

/** One socket path, one root connector, one immutable member/attempt. */
export class HostedAgentToolBroker {
  readonly #binding: PendingBinding
  readonly #roster: readonly HostedAgentToolRosterMember[]
  readonly #server: Server
  #socket: Socket | null = null
  #receiver: HostedAgentToolReceiver | null = null
  #boundSessionID: string | null = null
  #peerCredentials: HostedAgentPeerCredentials | null = null
  #state: 'pending' | 'connected' | 'active' | 'revoked' = 'pending'
  #peerPromise: Promise<void>
  #resolvePeer!: () => void
  #rejectPeer!: (error: Error) => void

  private constructor(private readonly options: HostedAgentToolBrokerOptions, server: Server) {
    this.#server = server
    this.#binding = Object.freeze({ ...options.binding })
    this.#roster = Object.freeze(options.roster.map(member => Object.freeze({ ...member })))
    this.#peerPromise = new Promise<void>((resolve, reject) => { this.#resolvePeer = resolve; this.#rejectPeer = reject })
    // Prevent an unhandled rejection when the caller revokes before waiting.
    void this.#peerPromise.catch(() => undefined)
  }

  static async create(options: HostedAgentToolBrokerOptions): Promise<HostedAgentToolBroker> {
    if (!isAbsolute(options.socketPath) || !/^fd3-[0-9a-f]{32}\.sock$/.test(basename(options.socketPath)) ||
      !/^[0-9a-f]{64}$/.test(options.challenge) || !/^[0-9a-f]{32}$/.test(options.containerGeneration) ||
      !/^[A-Za-z0-9._:-]{8,128}$/.test(options.operationId) ||
      Object.hasOwn(options.binding, 'sessionID') ||
      options.authority.teamId !== options.binding.teamId || options.authority.actorId !== options.binding.memberId ||
      options.authority.workspaceId !== options.binding.workspaceId) throw new TypeError('Invalid hosted FD3 broker scope')
    if (!Number.isSafeInteger(options.expectedRootConnector.pid) || options.expectedRootConnector.pid <= 0 ||
      options.expectedRootConnector.uid !== 0 || !/^[1-9][0-9]*$/.test(options.expectedRootConnector.startTicks) ||
      (options.testOnlyReadPeerCredentials && process.env.NODE_ENV !== 'test')) {
      throw new TypeError('Invalid hosted FD3 root connector proof')
    }
    if (!validRoster(options.roster, options.binding)) throw new TypeError('Hosted FD3 immutable roster mismatch')
    const parent = dirname(options.socketPath)
    const parentStat = await lstat(parent)
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || (parentStat.mode & 0o077) !== 0 ||
      (process.getuid?.() !== undefined && parentStat.uid !== process.getuid()) || await realpath(parent) !== parent) {
      throw new Error('Unsafe hosted FD3 broker parent')
    }
    try { await lstat(options.socketPath); throw new Error('Hosted FD3 socket path already exists') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const server = createServer({ allowHalfOpen: false })
    const broker = new HostedAgentToolBroker(options, server)
    server.on('connection', socket => broker.#accept(socket))
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(options.socketPath, () => { server.off('error', reject); resolve() })
      })
      await chmod(options.socketPath, 0o600)
      const stat = await lstat(options.socketPath)
      if (!stat.isSocket() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 ||
        (process.getuid?.() !== undefined && stat.uid !== process.getuid())) throw new Error('Unsafe hosted FD3 socket')
      return broker
    } catch (error) { await broker.revoke(); throw error }
  }

  get socketPath(): string { return this.options.socketPath }

  /** Completes only after the exact root connector receives its acknowledgement. */
  waitForPeer(): Promise<void> { return this.#peerPromise }

  /** Owner calls this once with the independently authenticated OpenCode Start session. */
  bindSession(sessionID: string): void {
    if (this.#state !== 'connected' || this.#boundSessionID !== null ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(sessionID)) {
      throw new Error('Hosted FD3 session binding unavailable')
    }
    this.#boundSessionID = sessionID
  }

  /** Call only after independently verified helper and supervisor post-exec evidence. */
  async activate(proof: HostedAgentToolPostExecProof): Promise<void> {
    await this.#peerPromise
    if (this.#state !== 'connected' || !this.#socket || this.#boundSessionID === null ||
      !sameProof(proof, this.options, this.#binding, this.#boundSessionID) ||
      !(await this.options.verifyPostExec(proof)) || this.#state !== 'connected') {
      await this.revoke()
      throw new Error('Hosted FD3 post-exec proof unavailable')
    }
    const socket = this.#socket
    const binding: Readonly<HostedAgentToolBinding> = Object.freeze({ ...this.#binding, sessionID: proof.sessionID })
    socket.removeAllListeners('data')
    this.#state = 'active'
    const executors = createHostedAgentToolExecutors({
      binding, authority: this.options.authority, ownerBinding: this.options.ownerBinding,
      taskService: this.options.taskService, taskReader: this.options.taskReader,
      comments: this.options.comments, messages: this.options.messages,
    })
    this.#receiver = new HostedAgentToolReceiver({ socket, binding,
      teamName: this.options.teamName, gate: this.options.gate, wal: this.options.wal,
      isCurrent: (binding, context) => this.#state === 'active' && this.options.isCurrent(binding, context),
      canSendTo: async (to, caller) => {
        const admitted = this.#roster.find(member => member.teamId === caller.teamId &&
          member.runId === caller.runId && member.memberName === to && member.memberId !== caller.memberId)
        if (!admitted) return false
        const current = await this.options.currentRecipient(to, caller)
        return !!current && current.teamId === admitted.teamId && current.runId === admitted.runId &&
          current.laneId === admitted.laneId && current.memberId === admitted.memberId &&
          current.memberName === admitted.memberName && await this.options.canSendTo(to, caller)
      }, executors })
  }

  async revoke(): Promise<void> {
    if (this.#state === 'revoked') return
    this.#state = 'revoked'
    this.#rejectPeer(new Error('Hosted FD3 broker revoked'))
    this.#receiver?.close()
    this.#socket?.destroy()
    await new Promise<void>(resolve => this.#server.close(() => resolve())).catch(() => undefined)
    await unlink(this.options.socketPath).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    })
    // The same gate is supplied to stop/reassignment/revoke by the Owner composition.
    await this.options.gate.transition(async () => undefined)
  }

  #accept(socket: Socket): void {
    if (this.#state !== 'pending' || this.#socket) { socket.destroy(); return }
    this.#socket = socket
    let buffer = Buffer.alloc(0)
    const fail = () => { void this.revoke().catch(() => undefined) }
    socket.once('error', fail)
    socket.once('close', () => { if (this.#state !== 'revoked') fail() })
    const onData = (chunk: Buffer) => {
      if (this.#state === 'connected') { fail(); return }
      if (this.#state !== 'pending' || !Buffer.isBuffer(chunk) || buffer.length + chunk.length > MAX_HANDSHAKE_BYTES) { fail(); return }
      buffer = Buffer.concat([buffer, chunk])
      if (!this.#peerCredentials) return
      const end = buffer.indexOf(10)
      if (end < 0) return
      if (end !== buffer.length - 1) { fail(); return }
      try {
        const raw = buffer.subarray(0, end).toString('utf8')
        assertNoDuplicateJsonObjectKeys(raw)
        const value: unknown = JSON.parse(raw)
        if (!isHandshake(value, this.options)) throw new Error('Hosted FD3 connector mismatch')
      } catch { fail(); return }
      void this.#assertExpectedPeer(this.#peerCredentials).then(current => {
        if (!current || this.#state !== 'pending') { fail(); return }
        this.#state = 'connected'
        buffer = Buffer.alloc(0)
        socket.write('{"version":1,"kind":"accepted"}\n', error => {
        if (error) { fail(); return }
        this.#resolvePeer()
        })
        // While pending, even one early tool byte is an authority violation.
        void new Promise<void>(resolve => this.#server.close(() => resolve()))
      }).catch(fail)
    }
    socket.on('data', onData)
    void (this.options.testOnlyReadPeerCredentials?.(socket) ?? readLinuxHostedAgentPeerCredentials(socket))
      .then(async credentials => {
        if (!(await this.#assertExpectedPeer(credentials)) || this.#state !== 'pending') { fail(); return }
        this.#peerCredentials = credentials
        if (buffer.length > 0) onData(Buffer.alloc(0))
      }).catch(fail)
  }

  async #assertExpectedPeer(credentials: HostedAgentPeerCredentials): Promise<boolean> {
    const expected = this.options.expectedRootConnector
    if (credentials.pid !== expected.pid || credentials.uid !== expected.uid) return false
    if (this.options.testOnlyReadPeerCredentials) return process.env.NODE_ENV === 'test'
    return matchesHostedAgentRootConnector(credentials, expected)
  }
}

function isHandshake(value: unknown, options: HostedAgentToolBrokerOptions): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  return Object.keys(row).sort().join(',') === 'challenge,containerGeneration,operationId,version' &&
    row.version === 1 && row.operationId === options.operationId &&
    row.containerGeneration === options.containerGeneration && row.challenge === options.challenge
}

function sameProof(proof: HostedAgentToolPostExecProof, options: HostedAgentToolBrokerOptions,
  binding: PendingBinding, sessionID: string): boolean {
  return proof.operationId === options.operationId && proof.containerGeneration === options.containerGeneration &&
    proof.runId === binding.runId && proof.laneId === binding.laneId &&
    proof.memberId === binding.memberId && proof.sessionID === sessionID
}

function validRoster(roster: readonly HostedAgentToolRosterMember[], binding: PendingBinding): boolean {
  if (!Array.isArray(roster) || roster.length < 1 || roster.length > 512) return false
  const names = new Set<string>()
  const ids = new Set<string>()
  let matches = 0
  for (const member of roster) {
    if (!member || member.teamId !== binding.teamId || member.runId !== binding.runId ||
      typeof member.laneId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(member.laneId) ||
      !/^member_[0-9a-f]{32}$/.test(member.memberId) ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(member.memberName) ||
      ids.has(member.memberId) || names.has(member.memberName.toLowerCase())) return false
    ids.add(member.memberId)
    names.add(member.memberName.toLowerCase())
    if (member.memberId === binding.memberId && member.memberName === binding.memberName &&
      member.laneId === binding.laneId) matches++
  }
  return matches === 1
}
