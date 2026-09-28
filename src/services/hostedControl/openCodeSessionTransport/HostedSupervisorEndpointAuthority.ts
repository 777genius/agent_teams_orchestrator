import { randomBytes } from 'node:crypto'

import type { HostedOpenCodeSupervisorRpcClient } from '../container/HostedOpenCodeSupervisorRpc.js'
import type { OpenCodeEndpointAuthority, OpenCodeEndpointProof } from './OpenCodeHostedMemberSessionTransport.js'

const HANDLE = /^opencode_[0-9a-f]{32}$/
const GENERATION = /^[0-9a-f]{32}$/
const TOKEN = /^[0-9a-f]{32}$/
const ENDPOINT = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{3,4})$/
const PASSWORD = /^[0-9a-f]{64}$/
const LEASE_MS = 30_000
const DEADLINE_MARGIN_MS = 1_000

type EndpointRpc = Pick<HostedOpenCodeSupervisorRpcClient, 'beginEndpointUse' | 'endEndpointUse'>

/** Test-only Owner adapter. Production HTTP effects require a root-mediated exact-action proxy. */
export class HostedSupervisorEndpointAuthority implements OpenCodeEndpointAuthority {
  private readonly inUse = new Set<string>()

  constructor(private readonly rpc: EndpointRpc, private readonly shutdownSignal?: AbortSignal,
    private readonly testOnlyAllowCredentialHandoff = false) {}

  async withAttestedEndpoint<T>(handle: string, generation: string,
    operation: (proof: OpenCodeEndpointProof) => Promise<T>): Promise<T> {
    if (!HANDLE.test(handle) || !GENERATION.test(generation) || typeof operation !== 'function') {
      throw new Error('hosted-opencode-endpoint-request-invalid')
    }
    if (!this.testOnlyAllowCredentialHandoff || process.env.NODE_ENV !== 'test') {
      throw new Error('hosted-opencode-owner-http-credential-disabled')
    }
    if (this.shutdownSignal?.aborted) throw new Error('hosted-opencode-endpoint-aborted')
    if (this.inUse.has(handle)) throw new Error('hosted-opencode-endpoint-overlapping')
    this.inUse.add(handle)
    let token: string | null = null
    let result: T | undefined
    let failed: Error | null = null
    let leaseDeadline = 0
    const controller = new AbortController()
    const abort = () => controller.abort()
    this.shutdownSignal?.addEventListener('abort', abort, { once: true })
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      let raw: unknown
      try { raw = await this.rpc.beginEndpointUse({ operationId: operationId('begin'), handle, generation }) }
      catch { throw new Error('hosted-opencode-endpoint-begin-failed') }
      // A malformed signed response may still carry a real token. Attempt its release.
      if (record(raw) && typeof raw.token === 'string' && TOKEN.test(raw.token)) token = raw.token
      if (!validLease(raw, handle, generation)) throw new Error('hosted-opencode-endpoint-proof-invalid')
      const now = Date.now()
      if (raw.expiresAt <= now + DEADLINE_MARGIN_MS || raw.expiresAt > now + LEASE_MS + 500) {
        throw new Error('hosted-opencode-endpoint-expiry-invalid')
      }
      const expiresAt = raw.expiresAt - DEADLINE_MARGIN_MS
      leaseDeadline = expiresAt
      timer = setTimeout(abort, expiresAt - now)
      const proof: OpenCodeEndpointProof = Object.freeze({ handle, generation,
        endpoint: raw.endpoint, username: raw.username, password: raw.password,
        expiresAt, signal: controller.signal })
      if (this.shutdownSignal?.aborted || controller.signal.aborted) {
        throw new Error('hosted-opencode-endpoint-aborted')
      }
      const aborted = new Promise<never>((_resolve, reject) => {
        if (controller.signal.aborted) reject(new Error('hosted-opencode-endpoint-aborted'))
        else controller.signal.addEventListener('abort', () =>
          reject(new Error('hosted-opencode-endpoint-aborted')), { once: true })
      })
      try {
        result = await Promise.race([Promise.resolve().then(() => operation(proof)), aborted])
        if (controller.signal.aborted || Date.now() >= expiresAt) {
          throw new Error('hosted-opencode-endpoint-aborted')
        }
      } catch {
        // Callback errors can contain an authorization header. Never propagate them.
        throw new Error('hosted-opencode-endpoint-operation-failed')
      }
    } catch {
      failed = new Error('hosted-opencode-endpoint-use-failed')
    } finally {
      controller.abort()
      if (timer) clearTimeout(timer)
      this.shutdownSignal?.removeEventListener('abort', abort)
      if (token) {
        try {
          const end = await this.rpc.endEndpointUse({ operationId: operationId('end'),
            handle, generation, token })
          if (!record(end) || end.released !== true) {
            failed = new Error('hosted-opencode-endpoint-release-unconfirmed')
          }
        } catch { failed = new Error('hosted-opencode-endpoint-release-unconfirmed') }
      }
      this.inUse.delete(handle)
    }
    if (failed) throw failed
    if (this.shutdownSignal?.aborted || Date.now() >= leaseDeadline) {
      throw new Error('hosted-opencode-endpoint-use-failed')
    }
    return result as T
  }
}

function operationId(kind: 'begin' | 'end'): string {
  return `${kind}_${randomBytes(16).toString('hex')}`
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function validLease(value: unknown, handle: string, generation: string): value is {
  token: string; handle: string; generation: string; endpoint: string;
  username: 'opencode'; password: string; expiresAt: number
} {
  if (!record(value) || Object.keys(value).sort().join(',') !==
    'endpoint,expiresAt,generation,handle,password,token,username') return false
  if (value.handle !== handle || value.generation !== generation ||
    typeof value.token !== 'string' || !TOKEN.test(value.token) ||
    typeof value.endpoint !== 'string' || value.username !== 'opencode' ||
    typeof value.password !== 'string' || !PASSWORD.test(value.password) ||
    !Number.isSafeInteger(value.expiresAt)) return false
  const match = ENDPOINT.exec(value.endpoint)
  return !!match && Number(match[1]) <= 65535
}
