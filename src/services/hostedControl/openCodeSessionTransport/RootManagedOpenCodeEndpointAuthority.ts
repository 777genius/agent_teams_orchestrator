import { connect, type Socket } from 'node:net'

import type { RootOpenCodeLoopbackEndpointAuthority } from
  '../openCodeRootHttpProxy/RootOpenCodeLoopbackWire.js'

const RUN = /^run_[0-9a-f]{32}$/
const MEMBER = /^member_[0-9a-f]{32}$/
const HANDLE = /^opencode_[0-9a-f]{32}$/
const GENERATION = /^[0-9a-f]{32}$/
const INCARNATION = /^[a-z0-9][a-z0-9_-]{7,95}$/
const PASSWORD = /^[0-9a-f]{64}$/
const ENDPOINT = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{3,4})$/
const MAX_LEASE_MS = 30_000
const CONNECT_TIMEOUT_MS = 3_000

export type RootManagedOpenCodeMemberBinding = Readonly<{
  runId: string
  memberId: string
  incarnation: string
}>

export type RootManagedOpenCodeEndpointSnapshot = RootManagedOpenCodeMemberBinding & Readonly<{
  handle: string
  generation: string
  endpoint: string
  state: 'running' | 'stopped'
  effectEnabled: boolean
}>

/**
 * Implemented only by the root supervisor/manager under its lifecycle and
 * network lock. The synchronous read must recheck the exact Product owner
 * incarnation, running container generation, and published loopback binding.
 * Neither this source nor its credential may cross the Owner RPC boundary.
 */
export interface RootManagedOpenCodeEndpointLeaseSource {
  acquire(handle: string, generation: string,
    binding: RootManagedOpenCodeMemberBinding): Promise<RootManagedOpenCodeEndpointSnapshot & Readonly<{
      password: string
      expiresAt: number
      signal: AbortSignal
      readCurrentSync(): RootManagedOpenCodeEndpointSnapshot
      release(): Promise<void>
    }>>
}

function port(endpoint: string): number {
  const match = ENDPOINT.exec(endpoint)
  const value = Number(match?.[1])
  if (!match || value > 65535) throw new Error('root-opencode-endpoint-invalid')
  return value
}

function current(value: RootManagedOpenCodeEndpointSnapshot, expected: RootManagedOpenCodeEndpointSnapshot): void {
  if (!value || value.runId !== expected.runId || value.memberId !== expected.memberId ||
    value.incarnation !== expected.incarnation || value.handle !== expected.handle ||
    value.generation !== expected.generation || value.endpoint !== expected.endpoint ||
    value.state !== 'running' || value.effectEnabled !== true) {
    throw new Error('root-opencode-endpoint-revoked')
  }
}

function connected(portNumber: number, signal: AbortSignal, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port: portNumber })
    const fail = () => { cleanup(); socket.destroy(); reject(new Error('root-opencode-connect-failed')) }
    const ready = () => { cleanup(); resolve(socket) }
    const cleanup = () => {
      clearTimeout(timer)
      socket.off('connect', ready)
      socket.off('error', fail)
      signal.removeEventListener('abort', fail)
    }
    const timer = setTimeout(fail, timeoutMs)
    socket.once('connect', ready)
    socket.once('error', fail)
    signal.addEventListener('abort', fail, { once: true })
    if (signal.aborted) fail()
  })
}

/** Root-only adapter. Production is inert until a trusted lease source is composed by the root daemon. */
export class RootManagedOpenCodeEndpointAuthority implements RootOpenCodeLoopbackEndpointAuthority {
  readonly #inUse = new Set<string>()

  constructor(private readonly binding: RootManagedOpenCodeMemberBinding,
    private readonly source: RootManagedOpenCodeEndpointLeaseSource) {
    if (!RUN.test(binding?.runId) || !MEMBER.test(binding?.memberId) ||
      !INCARNATION.test(binding?.incarnation) || typeof source?.acquire !== 'function') {
      throw new Error('root-opencode-endpoint-policy-invalid')
    }
  }

  async acquireConnected(handle: string, generation: string) {
    if (!HANDLE.test(handle) || !GENERATION.test(generation)) {
      throw new Error('root-opencode-endpoint-request-invalid')
    }
    if (this.#inUse.has(handle)) throw new Error('root-opencode-endpoint-overlapping')
    this.#inUse.add(handle)
    let lease: Awaited<ReturnType<RootManagedOpenCodeEndpointLeaseSource['acquire']>> | undefined
    let socket: Socket | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let released = false
    let revoked = false
    const revoke = () => { revoked = true; socket?.destroy() }
    const release = async () => {
      if (released) return
      released = true
      revoked = true
      if (timer) clearTimeout(timer)
      lease?.signal.removeEventListener('abort', revoke)
      socket?.destroy()
      this.#inUse.delete(handle)
      if (lease) await lease.release()
    }
    try {
      lease = await this.source.acquire(handle, generation, this.binding)
      const endpointPort = port(lease.endpoint)
      const now = Date.now()
      if (lease.runId !== this.binding.runId || lease.memberId !== this.binding.memberId ||
        lease.incarnation !== this.binding.incarnation || lease.handle !== handle ||
        lease.generation !== generation || lease.state !== 'running' || lease.effectEnabled !== true ||
        !PASSWORD.test(lease.password) || !(lease.signal instanceof AbortSignal) ||
        typeof lease.readCurrentSync !== 'function' || typeof lease.release !== 'function' ||
        !Number.isSafeInteger(lease.expiresAt) || lease.expiresAt <= now + 100 ||
        lease.expiresAt > now + MAX_LEASE_MS) {
        throw new Error('root-opencode-endpoint-proof-invalid')
      }
      const active = lease
      const assertCurrentSync = () => {
        if (released || revoked || active.signal.aborted || Date.now() >= active.expiresAt ||
          !socket || socket.destroyed || socket.connecting) {
          throw new Error('root-opencode-endpoint-revoked')
        }
        current(active.readCurrentSync(), active)
      }
      active.signal.addEventListener('abort', revoke, { once: true })
      timer = setTimeout(revoke, active.expiresAt - now)
      if (active.signal.aborted) throw new Error('root-opencode-endpoint-revoked')
      current(active.readCurrentSync(), active)
      socket = await connected(endpointPort, active.signal,
        Math.min(CONNECT_TIMEOUT_MS, active.expiresAt - Date.now() - 100))
      assertCurrentSync()
      return { handle, generation, socket, password: active.password, assertCurrentSync, release }
    } catch {
      await release().catch(() => undefined)
      throw new Error('root-opencode-endpoint-unavailable')
    }
  }
}
