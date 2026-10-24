import { expect, spyOn, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import * as childControl from './OpenCodeV2WindowsChildControl.js'
import { bindWindowsExecutionHttp, createWindowsExecutionHttpClient } from './OpenCodeV2WindowsHTTP.js'
import { createOpenCodeV2ColdLocationObservation } from '../../execution/OpenCodeV2ServerFailure.js'
import { openCodeV2ServerLoopbackUrl } from '../OpenCodeV2ServerAddress.js'
import { recordOpenCodeV2ProviderFailure, retainOpenCodeV2CatalogFailure, retainOpenCodeV2CatalogServerFailure } from '../../execution/OpenCodeV2Diagnostics.js'
import { OpenCodeV2ExecutionFetch } from '../../transport/OpenCodeV2ExecutionFetch.js'

for (const pin of ['2.0.0', '2.0.32'] as const)
test(`selected ${pin} NodeHttpServer default500 carries its sole cause on the existing authenticated head`, async () => {
  const directory = path.dirname(Bun.resolveSync(`@opencode/server-v${pin}/options`, import.meta.dir))
  const { Effect, Context, Scope, Exit }: typeof import('effect') = await import(pathToFileURL(Bun.resolveSync('effect', directory)).href)
  const httpTypes: typeof import('effect/http') = await import(pathToFileURL(Bun.resolveSync(pin === '2.0.0' ? 'effect/unstable/http' : 'effect/http', directory)).href)
  const http: typeof import('@effect/platform-node/NodeHttpServer') = await import(pathToFileURL(Bun.resolveSync('@effect/platform-node/NodeHttpServer', directory)).href)
  const client: typeof import('@opencode/client') = await import(`@opencode/client-v${pin}`)
  const latch = createOpenCodeV2ColdLocationObservation(), events = new EventEmitter()
  const nonce = 'TEST-nonce', leaseOwnerId = 'TEST-lease'
  const frames: Record<string, unknown>[] = [], observed: unknown[] = []
  const parent = createWindowsExecutionHttpClient(async frame => { queueMicrotask(() => events.emit('message', { ...frame, nonce, leaseOwnerId })) },
    () => { throw new Error('TEST unexpected transport failure') }, 'windowsHTTP', failure => { observed.push(failure) })
  const control = { events, connected: () => true, disconnect: () => { throw new Error('TEST unexpected disconnect') },
    send: async (frame: Record<string, unknown>) => { frames.push(frame); parent.accept(JSON.parse(JSON.stringify(frame))) } }
  const controlSpy = spyOn(childControl, 'windowsExecutionChildControl').mockReturnValue(control as unknown as ReturnType<typeof childControl.windowsExecutionChildControl>)
  const birthSpy = spyOn(childControl, 'windowsExecutionSelfBirth').mockReturnValue({ format: 'windows-filetime', value: '42', bootId: null })
  const previousNonce = process.env.OPENCODE_V2_WINDOWS_NONCE, previousLease = process.env.OPENCODE_V2_WINDOWS_LEASE
  process.env.OPENCODE_V2_WINDOWS_NONCE = nonce; process.env.OPENCODE_V2_WINDOWS_LEASE = leaseOwnerId
  const original = Object.assign(new TypeError('TEST-PRIVATE-SERVER-PAYLOAD'), { code: 'EACCES' })
  const descriptors = Object.getOwnPropertyDescriptors(original)
  const source = await readFile(new URL('./OpenCodeV2WindowsRuntime.ts', import.meta.url), 'utf8')
  const block = source.slice(source.indexOf('const handler = Effect.withFiber'), source.indexOf('\n        yield* server.serve'))
  const body = new Bun.Transpiler({ loader: 'ts' }).transformSync(block)
  const handler: import('effect').Effect.Effect<never> = new Function('Effect', 'Context', 'httpTypes', 'routes', 'services', 'locationObservation', `${body};return handler;`)(
    Effect, Context, httpTypes, Effect.die(original), Context.empty(), latch)
  const scope = await Effect.runPromise(Scope.make())
  const origin = await Effect.runPromise(Effect.gen(function* () {
    const server = yield* http.make(() => createServer(), { host: '127.0.0.1', port: 0 })
    yield* server.serve(handler).pipe(Effect.provide(http.layerHttpServices))
    return openCodeV2ServerLoopbackUrl(pin, server.address)
  }).pipe(Effect.provideService(Scope.Scope, scope)))
  const bound = bindWindowsExecutionHttp(origin, undefined, latch); parent.bindOrigin(origin)
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'TEST-v2-server-failure-'))
  const previousDataRoot = process.env.CLAUDE_MULTIMODEL_DATA_HOME
  process.env.CLAUDE_MULTIMODEL_DATA_HOME = dataRoot
  const wire = new OpenCodeV2ExecutionFetch(origin, pin, '/TEST/location', 'TEST-password', { deadline: Date.now() + 5000 }, parent.fetch)
  try {
    let caught: unknown
    try { await client.OpenCode.make({ baseUrl: origin, fetch: wire.fetch }).location.get({ location: { directory: '/TEST/location' } }) }
    catch (error) { caught = error }
    expect(caught).toBeInstanceOf(client.ClientError)
    if (caught === null || typeof caught !== 'object') throw new Error('TEST expected original client Error')
    const errorDescriptors = Object.getOwnPropertyDescriptors(caught)
    expect(observed).toEqual([{ operation: 'location', kind: 'Die', name: 'TypeError', errno: 'EACCES' }])
    retainOpenCodeV2CatalogFailure(caught, 'location', client.ClientError.prototype)
    retainOpenCodeV2CatalogServerFailure(caught, observed[0])
    await recordOpenCodeV2ProviderFailure('execution-host-startup', caught, true)
    const diagnosticRoot = path.join(dataRoot, 'opencode/v2/provider-diagnostics')
    const names = await readdir(diagnosticRoot)
    expect(names).toHaveLength(1)
    const bytes = await readFile(path.join(diagnosticRoot, names[0]!), 'utf8')
    expect(JSON.parse(bytes).catalog).toEqual({ phase: 'location', client: { reason: 'Transport' }, wireCode: 'http_failure', wireStatus: 500, serverFailure: observed[0] })
    expect(bytes).not.toContain('TEST-PRIVATE-SERVER-PAYLOAD')
    expect(Object.getOwnPropertyDescriptors(caught)).toEqual(errorDescriptors)
    expect(frames.filter(frame => frame.action === 'head')).toHaveLength(1)
    expect(frames.find(frame => frame.action === 'head')!.status).toBe(500)
    expect(frames.every(frame => frame.type === 'windowsHTTP' && frame.nonce === nonce && frame.leaseOwnerId === leaseOwnerId)).toBe(true)
    expect(frames.some(frame => !['head', 'end', 'done'].includes(String(frame.action)))).toBe(false)
    expect(JSON.stringify(frames)).not.toContain('TEST-PRIVATE-SERVER-PAYLOAD')
    expect(Object.getOwnPropertyDescriptors(original)).toEqual(descriptors)
    await parent.fetch(`${origin}/api/location`)
    expect(observed).toHaveLength(1)
    expect(frames.filter(frame => frame.action === 'head')[1]!.serverFailure).toBeUndefined()
  } finally {
    await wire.dispose(); await parent.close(); await bound.close(); await Effect.runPromise(Scope.close(scope, Exit.void)); controlSpy.mockRestore(); birthSpy.mockRestore()
    if (previousDataRoot === undefined) delete process.env.CLAUDE_MULTIMODEL_DATA_HOME; else process.env.CLAUDE_MULTIMODEL_DATA_HOME = previousDataRoot
    await rm(dataRoot, { recursive: true, force: true })
    if (previousNonce === undefined) delete process.env.OPENCODE_V2_WINDOWS_NONCE; else process.env.OPENCODE_V2_WINDOWS_NONCE = previousNonce
    if (previousLease === undefined) delete process.env.OPENCODE_V2_WINDOWS_LEASE; else process.env.OPENCODE_V2_WINDOWS_LEASE = previousLease
  }
})

test('parent observation requires the original location transaction and500 and cannot break response delivery', async () => {
  for (const entry of [{ path: '/api/info', status: 500 }, { path: '/api/location', status: 200 },
    { path: '/api/location', status: 500, malformed: true }, { path: '/api/location', status: 500 }]) {
    let parent!: ReturnType<typeof createWindowsExecutionHttpClient>, observed = 0, fatal = 0
    parent = createWindowsExecutionHttpClient(async frame => {
      if (frame.action !== 'request') return
      queueMicrotask(() => {
        parent.accept({ type: 'windowsHTTP', id: frame.id, action: 'head', status: entry.status, statusText: '', headers: [], body: false,
          serverFailure: { operation: 'location', kind: entry.malformed ? 'TEST-PRIVATE-SERVER-PAYLOAD' : 'Die' } })
        parent.accept({ type: 'windowsHTTP', id: frame.id, action: 'end', direction: 'response' })
        parent.accept({ type: 'windowsHTTP', id: frame.id, action: 'done' })
      })
    }, () => { fatal++ }, 'windowsHTTP', () => { observed++; throw new Error('TEST observer fault') })
    parent.bindOrigin('http://127.0.0.1:42')
    expect((await parent.fetch(`http://127.0.0.1:42${entry.path}`)).status).toBe(entry.status)
    expect(observed).toBe(entry.path === '/api/location' && entry.status === 500 && !entry.malformed ? 1 : 0)
    expect(fatal).toBe(0); await parent.close()
  }
})
