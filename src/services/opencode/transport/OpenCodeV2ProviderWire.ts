import { requireExecutionEndpoint } from '../host/OpenCodeV2ExecutionHost.js'
import { executionAssert, type ExecutionAuthority } from '../execution/OpenCodeV2ExecutionContracts.js'
import { boundOpenCodeRead, checkOpenCodeReadJson } from './OpenCodeBoundedFetch.js'
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
    executionAssert((request.method === 'GET' && scoped && !key) || (request.method === 'POST' && key) ||
      (credential && (request.method === 'DELETE' || request.method === 'POST' && url.pathname.endsWith('/activate'))), 'provider_transport_unsupported')
    const location = scoped || credential && this.authority.pin === '2.0.0'
    executionAssert([...url.searchParams.keys()].every(name => name === 'location[directory]' && url.searchParams.getAll(name).length === 1) &&
      (location ? url.searchParams.get('location[directory]') === this.authority.directory : url.search === ''), 'provider_directory_changed')
    const signal = AbortSignal.any([this.abort.signal, this.endpoint.signal, AbortSignal.timeout(Math.max(1, this.deadline - Date.now()))])
    const headers = new Headers(request.headers); headers.set('authorization', 'Basic ' + Buffer.from('opencode:' + this.endpoint.password).toString('base64'))
    const response = await boundOpenCodeRead((this.endpoint.fetch ?? globalThis.fetch)(request, { headers, signal, redirect: 'error' }), this.deadline - Date.now(), signal)
    executionAssert(!response.redirected && (!response.url || new URL(response.url).origin === url.origin), 'provider_authority_changed')
    const reader = response.body?.getReader(); let bytes = 0; const pieces: Uint8Array[] = []
    try {
      if (reader) for (;;) {
        const part = await boundOpenCodeRead(reader.read(), this.deadline - Date.now(), signal)
        if (part.done) break
        executionAssert(part.value instanceof Uint8Array, 'provider_response_invalid'); bytes += part.value.byteLength
        executionAssert(bytes <= 8 * 1024 * 1024, 'provider_response_budget'); pieces.push(part.value)
      }
    } finally { if (reader) { await reader.cancel().catch(() => undefined); reader.releaseLock() } }
    requireExecutionEndpoint(this.authority)
    const body = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(pieces))
    if (request.method !== 'GET') { executionAssert(response.status === 204 && body === '', 'provider_mutation_unknown'); return new Response(null, { status: 204 }) }
    executionAssert(response.ok && response.headers.get('content-type')?.split(';')[0]?.trim() === 'application/json', 'provider_response_invalid')
    checkOpenCodeReadJson(body); return new Response(body, { status: response.status, headers: response.headers })
  }
  async dispose() { this.abort.abort(); await boundOpenCodeRead(Promise.allSettled([...this.pending]), 2000); executionAssert(this.pending.size === 0, 'provider_cleanup_unknown') }
}

