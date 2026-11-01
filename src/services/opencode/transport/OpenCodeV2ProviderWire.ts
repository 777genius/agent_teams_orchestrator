import { requireExecutionEndpoint } from '../host/OpenCodeV2ExecutionHost.js'
import { executionAssert, type ExecutionAuthority } from '../execution/OpenCodeV2ExecutionContracts.js'
import { openCodeV2Wire } from '../compatibility/OpenCodeV2Registry.js'
import { boundOpenCodeRead, checkOpenCodeReadJson } from './OpenCodeBoundedFetch.js'

export const OPEN_CODE_V2_PROVIDER_OPERATIONS = ['provider-read', 'model-read', 'integration-read', 'activation-await', 'key-connect', 'credential-delete', 'credential-activate'] as const
export const OPEN_CODE_V2_PROVIDER_STAGES = ['request', 'response', 'body', 'decode'] as const
type ProviderOperation = typeof OPEN_CODE_V2_PROVIDER_OPERATIONS[number]
export type OpenCodeV2ProviderWireFailure = Readonly<{ operation: ProviderOperation; stage: typeof OPEN_CODE_V2_PROVIDER_STAGES[number]; status: number | null }>
type ProviderFailure = OpenCodeV2ProviderWireFailure
const failures = new WeakMap<Error, ProviderFailure>()
/** Read only metadata minted at this transport boundary, never caller fields. */
export function readOpenCodeV2ProviderWireFailure(error: unknown): ProviderFailure | undefined {
  for (let depth = 0; depth < 4 && error instanceof Error; depth++) {
    const failure = failures.get(error)
    if (failure) return failure
    error = error.cause
  }
}
/** Only finite published provider/credential operations; no generated session surface escapes. */
export class OpenCodeV2ProviderWire {
  private readonly abort = new AbortController()
  private readonly pending = new Set<Promise<unknown>>()
  private readonly endpoint
  constructor(private readonly authority: ExecutionAuthority, private readonly deadline: number) {
    this.endpoint = requireExecutionEndpoint(authority)
  }
  fetch: typeof globalThis.fetch = Object.assign((input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]) => {
    const work = this.request(input, init); this.pending.add(work)
    void work.finally(() => this.pending.delete(work)).catch(() => undefined)
    return work
  }, { preconnect(): never { throw new Error('provider_transport_unsupported') } })
  private async request(input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]): Promise<Response> {
    requireExecutionEndpoint(this.authority)
    const request = new Request(input, init), url = new URL(request.url)
    executionAssert(url.origin === this.endpoint.baseUrl && !url.username && !url.password && !url.hash, 'provider_authority_changed')
    const scoped = /^\/api\/(?:provider(?:\/[^/]+)?|model|integration(?:\/[^/]+)?|integration\/[^/]+\/connect\/key)$/.test(url.pathname)
    const credential = /^\/api\/credential\/cred_[A-Za-z0-9]+(?:\/activate)?$/.test(url.pathname)
    const key = /^\/api\/integration\/[^/]+\/connect\/key$/.test(url.pathname)
    const floor = openCodeV2Wire(this.authority.pin) === 'floor'
    const activation = floor && request.method === 'POST' && url.pathname === '/api/plugin/await-activation'
    executionAssert((request.method === 'GET' && scoped && !key) || (request.method === 'POST' && key) ||
      (credential && (request.method === 'DELETE' || request.method === 'POST' && url.pathname.endsWith('/activate'))) || activation, 'provider_transport_unsupported')
    executionAssert(!activation || request.body === null, 'provider_transport_unsupported')
    const location = scoped || activation || credential && floor
    executionAssert([...url.searchParams.keys()].every(name => name === 'location[directory]' && url.searchParams.getAll(name).length === 1) &&
      (location ? url.searchParams.get('location[directory]') === this.authority.directory : url.search === ''), 'provider_directory_changed')
    const operation: ProviderOperation = activation ? 'activation-await' : key ? 'key-connect' : credential
      ? request.method === 'DELETE' ? 'credential-delete' : 'credential-activate'
      : url.pathname.startsWith('/api/integration') ? 'integration-read'
      : url.pathname === '/api/model' ? 'model-read' : 'provider-read'
    let stage: ProviderFailure['stage'] = 'request', status: number | null = null
    try {
      const signal = AbortSignal.any([this.abort.signal, this.endpoint.signal, AbortSignal.timeout(Math.max(1, this.deadline - Date.now()))])
      const headers = new Headers(request.headers); headers.set('authorization', 'Basic ' + Buffer.from('opencode:' + this.endpoint.password).toString('base64'))
      const response = await boundOpenCodeRead((this.endpoint.fetch ?? globalThis.fetch)(request, { headers, signal, redirect: 'error' }), this.deadline - Date.now(), signal)
      stage = 'response'; status = response.status
      executionAssert(!response.redirected && (!response.url || new URL(response.url).origin === url.origin), 'provider_authority_changed')
      const reader = response.body?.getReader(); let bytes = 0; const pieces: Uint8Array[] = []
      stage = 'body'
      try {
        if (reader) for (;;) {
          const part = await boundOpenCodeRead(reader.read(), this.deadline - Date.now(), signal)
          if (part.done) break
          executionAssert(part.value instanceof Uint8Array, 'provider_response_invalid'); bytes += part.value.byteLength
          executionAssert(bytes <= 8 * 1024 * 1024, 'provider_response_budget'); pieces.push(part.value)
        }
      } finally { if (reader) { await reader.cancel().catch(() => undefined); reader.releaseLock() } }
      requireExecutionEndpoint(this.authority)
      stage = 'decode'
      const body = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(pieces))
      if (request.method !== 'GET') { executionAssert(response.status === 204 && body === '', 'provider_mutation_unknown'); return new Response(null, { status: 204 }) }
      executionAssert(response.ok && response.headers.get('content-type')?.split(';')[0]?.trim() === 'application/json', 'provider_response_invalid')
      checkOpenCodeReadJson(body); return new Response(body, { status: response.status, headers: response.headers })
    } catch (error) {
      if (error instanceof Error) failures.set(error, Object.freeze({ operation, stage, status }))
      throw error
    }
  }
  async dispose() { this.abort.abort(); await boundOpenCodeRead(Promise.allSettled([...this.pending]), 2000); executionAssert(this.pending.size === 0, 'provider_cleanup_unknown') }
}

