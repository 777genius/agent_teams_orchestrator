import { expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { types } from 'node:util'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createOpenCodeV2ColdLocationObservation, projectOpenCodeV2LocationCause, readOpenCodeV2ServerFailure } from './OpenCodeV2ServerFailure.js'

const secret = 'TEST-PRIVATE-SERVER-PAYLOAD'
const fail = (error: unknown) => ({ reasons: [{ _tag: 'Fail', error }] })
const finite = { operation: 'location', kind: 'Fail', tag: 'PlatformError', module: 'FileSystem', method: 'realPath', reason: 'PermissionDenied', errno: 'EACCES' } as const

for (const pin of ['2.0.0', '2.0.32'] as const)
test(`selected ${pin} Effect cause projects one finite error chain without exposing private fields`, async () => {
  const directory = path.dirname(Bun.resolveSync(`@opencode/server-v${pin}/options`, import.meta.dir))
  const { Effect, Exit, PlatformError }: typeof import('effect') = await import(pathToFileURL(Bun.resolveSync('effect', directory)).href)
  const original = PlatformError.systemError({ _tag: 'PermissionDenied', module: 'FileSystem', method: 'realPath',
    pathOrDescriptor: secret, cause: Object.assign(new Error(secret), { code: 'EACCES', path: secret }) })
  const exit = await Effect.runPromiseExit(Effect.fail(original))
  expect(Exit.isFailure(exit)).toBe(true)
  if (!Exit.isFailure(exit)) return
  expect(projectOpenCodeV2LocationCause(exit.cause)).toEqual({ ...finite, name: 'Error' })
  const defect = await Effect.runPromiseExit(Effect.die(new TypeError(secret)))
  if (Exit.isFailure(defect)) expect(projectOpenCodeV2LocationCause(defect.cause)).toEqual({ operation: 'location', kind: 'Die', name: 'TypeError' })
  expect(JSON.stringify(projectOpenCodeV2LocationCause(exit.cause))).not.toContain(secret)
})

test('projection bounds reasons and depth and never merges unrelated leaves or branches', () => {
  expect(projectOpenCodeV2LocationCause({ reasons: [{ _tag: 'Interrupt' }, { _tag: 'Fail', error: { _tag: 'SqlError', reason: { _tag: 'AuthorizationError', code: 'SQLITE_AUTH' } } },
    { _tag: 'Die', defect: { module: 'FileSystem', code: 'EACCES' } }] })).toEqual({ operation: 'location', kind: 'Fail', tag: 'SqlError', reason: 'AuthorizationError', sqlCode: 'SQLITE_AUTH' })
  expect(projectOpenCodeV2LocationCause({ reasons: [...Array(4).fill({ _tag: 'unknown' }), ...fail({ code: 'EACCES' }).reasons] })).toEqual({ operation: 'location', kind: 'unknown' })
  let nested: unknown = { code: 'EACCES' }
  for (let index = 0; index < 5; index++) nested = { cause: nested }
  expect(projectOpenCodeV2LocationCause(fail(nested))).toEqual({ operation: 'location', kind: 'Fail' })
  expect(projectOpenCodeV2LocationCause(fail({ reason: { _tag: 'NotFound' }, cause: { code: 'EACCES' } })))
    .toEqual({ operation: 'location', kind: 'Fail', reason: 'NotFound' })
  const cycle: { cause?: unknown } = {}; cycle.cause = cycle
  expect(projectOpenCodeV2LocationCause(fail(cycle))).toEqual({ operation: 'location', kind: 'Fail' })
})

test('finite reader and cause projection never execute getters, proxies or enumerate caller keys', () => {
  let calls = 0
  const forbidden = () => { calls++; throw new Error(secret) }
  const proxy = new Proxy({}, { get: forbidden, ownKeys: forbidden, getPrototypeOf: forbidden, getOwnPropertyDescriptor: forbidden })
  expect(readOpenCodeV2ServerFailure(proxy)).toBeUndefined()
  expect(projectOpenCodeV2LocationCause(proxy)).toEqual({ operation: 'location', kind: 'unknown' })
  const hostile = Object.setPrototypeOf(Object.defineProperty({}, 'reason', { get: forbidden }), proxy)
  expect(projectOpenCodeV2LocationCause(fail(hostile))).toEqual({ operation: 'location', kind: 'Fail' })
  expect(readOpenCodeV2ServerFailure(Object.defineProperty({ ...finite }, 'errno', { get: forbidden }))).toBeUndefined()
  const extra = Object.defineProperty({ ...finite, raw: secret }, 'private', { get: forbidden })
  expect(readOpenCodeV2ServerFailure(extra)).toEqual(finite)
  for (const changed of [{ kind: secret }, { method: secret }, { errno: 1 }, { operation: 'info' }])
    expect(readOpenCodeV2ServerFailure({ ...finite, ...changed })).toBeUndefined()
  expect(calls).toBe(0)
})

test('server native realpath projection accepts only the existing bounded integers and omits invalid nested metadata', () => {
  const native = { status: 2, operation: 18, win32: 5, anchorCount: 2, matchingAnchorIndex: 1 }
  expect(readOpenCodeV2ServerFailure({ ...finite, realpath: { ...native, path: secret } })?.realpath).toEqual(native)
  let calls = 0
  const forbidden = () => { calls++; throw new Error(secret) }
  for (const changed of [{ status: 0 }, { status: 5 }, { operation: 26 }, { operation: -1 }, { win32: 0x100000000 },
    { anchorCount: 4097 }, { matchingAnchorIndex: 2 }, { matchingAnchorIndex: -2 }, { win32: 5.5 }])
    expect(readOpenCodeV2ServerFailure({ ...finite, realpath: { ...native, ...changed } })).toEqual(finite)
  expect(readOpenCodeV2ServerFailure({ ...finite, realpath: Object.defineProperty({ ...native }, 'win32', { get: forbidden }) })).toEqual(finite)
  expect(readOpenCodeV2ServerFailure({ ...finite, realpath: new Proxy(native, { getOwnPropertyDescriptor: forbidden }) })).toEqual(finite)
  expect(calls).toBe(0)
})

test('cold observation binds exactly one handler entry and consumes or disarms on every outcome', () => {
  const observation = createOpenCodeV2ColdLocationObservation()
  const early = observation.enter()
  observation.begin('TEST-first'); observation.retain(early, fail({ code: 'EPERM' }))
  const token = observation.enter(); observation.retain(token, fail({ code: 'EACCES' }))
  expect(observation.consume('TEST-foreign', 500)).toBeUndefined()
  expect(observation.consume('TEST-first', 500)).toEqual({ operation: 'location', kind: 'Fail', errno: 'EACCES' })
  observation.begin('TEST-second'); expect(observation.enter()).toBeUndefined()
  expect(observation.consume('TEST-second', 500)).toBeUndefined()
  for (const outcome of ['second-entry', 'second-begin', 'success', 'end'] as const) {
    const latch = createOpenCodeV2ColdLocationObservation(); latch.begin('TEST-id')
    const entry = latch.enter(); latch.retain(entry, fail({ code: 'EACCES' }))
    if (outcome === 'second-entry') latch.enter()
    if (outcome === 'second-begin') latch.begin('TEST-other')
    if (outcome === 'end') latch.end('TEST-id')
    expect(latch.consume('TEST-id', outcome === 'success' ? 200 : 500)).toBeUndefined()
    latch.begin('TEST-next'); expect(latch.enter()).toBeUndefined()
  }
})

test('actual host listener ignores foreign child identities and hostile metadata without refusing acquisition', async () => {
  const source = await readFile(new URL('../host/OpenCodeV2ExecutionHost.ts', import.meta.url), 'utf8')
  const start = source.indexOf("child.on('serverFailure', ") + "child.on('serverFailure', ".length
  const listener = source.slice(start, source.indexOf("\n      child.on('retireProgress'", start)).replace(/\)\s*$/, '')
  const body = new Bun.Transpiler({ loader: 'ts' }).transformSync(`const listener = ${listener};`)
  const mapping = { namespace: { name: 'TEST-namespace' }, bun: { nativePID: 42, birth: { format: 'windows-filetime', value: '420', bootId: null } } }
  const scope = { types, mapping, nonce: 'TEST-nonce', leaseOwnerId: 'TEST-lease', plan: { platform: 'win32' }, readOpenCodeV2ServerFailure }
  const inspect = new Function('scope', `const {${Object.keys(scope).join(',')}} = scope; let serverFailure; ${body}; return { listener, retained: () => serverFailure };`)(scope)
  const valid = { nonce: scope.nonce, leaseOwnerId: scope.leaseOwnerId, namespace: mapping.namespace.name,
    pid: 42, birth: mapping.bun.birth, serverFailure: finite }
  let calls = 0
  const forbidden = () => { calls++; throw new Error(secret) }
  for (const key of ['nonce', 'leaseOwnerId', 'namespace', 'pid', 'birth']) {
    inspect.listener({ ...valid, [key]: secret }); expect(inspect.retained()).toBeUndefined()
  }
  inspect.listener(Object.defineProperty({ ...valid }, 'nonce', { get: forbidden }))
  inspect.listener(new Proxy(valid, { getOwnPropertyDescriptor: forbidden }))
  expect(inspect.retained()).toBeUndefined(); expect(calls).toBe(0)
  inspect.listener(valid); expect(inspect.retained()).toEqual(finite)
  inspect.listener({ ...valid, serverFailure: { operation: 'location', kind: 'Die' } })
  expect(inspect.retained()).toEqual(finite)
})
