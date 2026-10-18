import { expect, test, spyOn } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import * as host from '../host/OpenCodeV2ExecutionHost.js'
import { recordOpenCodeV2ProviderFailure, retainOpenCodeV2CatalogServerFailure } from '../execution/OpenCodeV2Diagnostics.js'
import type { ExecutionAuthority, ExecutionContext } from '../execution/OpenCodeV2ExecutionContracts.js'
import { awaitOpenCodeV2CatalogReadiness } from './OpenCodeV2ExecutionClientFactory.js'
import { OpenCodeV2ExecutionFetch } from './OpenCodeV2ExecutionFetch.js'

// Synthetic transport only. The genuine selected Promise decoder and installed
// client/schema/protocol bytes are exercised; no host, native process or model.
for (const phase of ['client-setup', 'info', 'location', 'integration-ready', 'cleanup', 'http-401', 'http-500', 'status-low', 'status-high', 'status-fraction', 'server-location'] as const)
test(`catalog refusal retains ${phase} with original thrown identity and bounded cause`, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'TEST-v2-catalog-phase-'))
  const previous = process.env.CLAUDE_MULTIMODEL_DATA_HOME
  process.env.CLAUDE_MULTIMODEL_DATA_HOME = root
  const pin = '2.0.32', directory = '/TEST/catalog-project'
  const authority: ExecutionAuthority = { generation: 'v2', pin, dialect: 'v2-2.0.32', graphSha256: 'a'.repeat(64),
    selectedCli: { path: '/TEST/opencode', sha256: 'b'.repeat(64), version: pin },
    child: { pid: 42, birth: { format: 'linux-start-ticks', value: '123', bootId: 'TEST-boot' }, executablePath: '/TEST/bun', sha256: 'c'.repeat(64) },
    hostInstanceId: 'TEST-host', profileEpoch: 'TEST-profile', profileRoot: '/TEST/profile', directory, leaseOwnerId: 'TEST-owner' }
  const context: ExecutionContext = { teamId: 'TEST-team', runId: 'TEST-run', laneId: 'primary', memberId: 'alice', deadline: Date.now() + 10_000 }
  const original = new Error(phase === 'cleanup' ? 'cleanup_unknown' : 'TEST-PRIVATE-CATALOG-PAYLOAD')
  const entry = await realpath(Bun.resolveSync('@opencode/client', import.meta.dir))
  const files = await Promise.all([entry, ...['schema/installation-event', 'protocol/groups/pty'].map(name => Bun.resolveSync('@opencode/' + name, path.dirname(entry)))].map(async file => {
    const canonical = await realpath(file)
    return { path: canonical, sha256: createHash('sha256').update(await readFile(canonical)).digest('hex') }
  }))
  const graph = spyOn(host, 'requireExecutionGraph').mockImplementation(() => {
    if (phase === 'client-setup') throw original
    return { sha256: authority.graphSha256, files }
  })
  const endpoint = { baseUrl: 'http://127.0.0.1:12345', password: 'TEST-password', nativePID: 42,
    signal: new AbortController().signal, async fetch(input: Parameters<typeof fetch>[0]) {
      const url = new URL(input instanceof Request ? input.url : String(input))
      const httpStatuses: Partial<Record<typeof phase, number>> = { 'http-401': 401, 'http-500': 500,
        'status-low': 99, 'status-high': 600, 'status-fraction': 401.5 }
      const httpStatus = httpStatuses[phase]
      if (phase === 'server-location' && url.pathname === '/api/location') return new Response(null, { status: 500 })
      if (httpStatus !== undefined) {
        const valid = httpStatus === 401 || httpStatus === 500
        const response = Response.json({ private: 'TEST-PRIVATE-CATALOG-PAYLOAD' }, valid ? { status: httpStatus } : {})
        // Invalid synthetic status data checks diagnostic bounds; production
        // status is read only from the genuine HTTP Response at the wire guard.
        if (!valid) Object.defineProperty(response, 'status', { value: httpStatus })
        return response
      }
      const failing = phase === 'cleanup' || phase === 'info' || phase === 'location' && url.pathname === '/api/location' || phase === 'integration-ready' && url.pathname === '/api/integration'
      if (failing) return new Response('TEST-PRIVATE-CATALOG-PAYLOAD', { headers: { 'content-type': 'text/plain' } })
      return Response.json(url.pathname === '/api/info' ? { pid: 42, version: pin } : url.pathname === '/api/location' ? { directory } : { location: { directory } })
    } }
  const owning = spyOn(host, 'requireExecutionEndpoint').mockReturnValue(endpoint)
  const dispose = phase === 'cleanup' ? spyOn(OpenCodeV2ExecutionFetch.prototype, 'dispose').mockRejectedValue(original) : undefined
  try {
    let caught: unknown
    try { await awaitOpenCodeV2CatalogReadiness(endpoint, authority, context) } catch (failure) { caught = failure }
    expect(caught).toBeDefined()
    if (phase === 'client-setup' || phase === 'cleanup') expect(caught).toBe(original)
    if (caught === null || typeof caught !== 'object') throw new Error('TEST expected catalog Error')
    const before = Object.getOwnPropertyDescriptors(caught)
    const serverFailure = { operation: 'location', kind: 'Fail', tag: 'SqlError', reason: 'AuthorizationError', sqlCode: 'SQLITE_AUTH' }
    retainOpenCodeV2CatalogServerFailure(caught, { ...serverFailure, body: 'TEST-PRIVATE-CATALOG-PAYLOAD' })
    // Later observations cannot replace the first matching private fact.
    retainOpenCodeV2CatalogServerFailure(caught, { operation: 'location', kind: 'Die' })
    expect(Object.getOwnPropertyDescriptors(caught)).toEqual(before)
    await recordOpenCodeV2ProviderFailure('execution-host-startup', caught, true)
    const names = await readdir(path.join(root, 'opencode/v2/provider-diagnostics'))
    expect(names).toHaveLength(1)
    const bytes = await readFile(path.join(root, 'opencode/v2/provider-diagnostics', names[0]!), 'utf8')
    expect(bytes).not.toContain('TEST-PRIVATE-CATALOG-PAYLOAD')
    const catalog = JSON.parse(bytes).catalog
    const http = phase.startsWith('http-') || phase.startsWith('status-')
    expect(catalog).toEqual(phase === 'client-setup' ? { phase } : phase === 'server-location'
      ? { phase: 'location', client: { reason: 'Transport' }, wireCode: 'http_failure', wireStatus: 500, serverFailure }
      : { phase: phase === 'cleanup' || http ? 'info' : phase, client: { reason: 'Transport' }, wireCode: http ? 'http_failure' : 'media_type',
        ...(phase === 'http-401' ? { wireStatus: 401 } : phase === 'http-500' ? { wireStatus: 500 } : {}) })
  } finally {
    dispose?.mockRestore(); owning.mockRestore(); graph.mockRestore()
    if (previous === undefined) delete process.env.CLAUDE_MULTIMODEL_DATA_HOME
    else process.env.CLAUDE_MULTIMODEL_DATA_HOME = previous
    await rm(root, { recursive: true, force: true })
  }
})
