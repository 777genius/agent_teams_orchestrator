import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync,
  symlinkSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { RootDockerEngineDispatcher, writeCompleteSync,
  type RootCurrentMemberDecision, type RootDockerOperation } from './RootDockerEngineDispatcher.js'

const temporary: string[] = []
const servers: Server[] = []
const sha = (data: string) => createHash('sha256').update(data).digest('hex')
const operation = (id: string, body = '{"Name":"private-network"}'):
  Extract<RootDockerOperation, { kind: 'create_network' }> => ({
  kind: 'create_network', operationId: id, body, bodySha256: sha(body),
})

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()))
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true })
})

type SyntheticFixture = { directory: string; socketPath: string; requests: Buffer[];
  canonical: Map<string, RootDockerOperation>; receivedBytes: () => number }

async function fixture(behavior: 'reply' | 'drop' = 'reply'): Promise<SyntheticFixture> {
  const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'root-docker-dispatch-')))
  temporary.push(directory)
  mkdirSync(path.join(directory, 'claims'), { mode: 0o700 })
  const socketPath = path.join(directory, 'docker.sock')
  const requests: Buffer[] = []
  let receivedBytes = 0
  const server = createServer(socket => {
    const chunks: Buffer[] = []
    socket.on('data', chunk => {
      receivedBytes += chunk.length
      chunks.push(chunk)
      const bytes = Buffer.concat(chunks)
      const split = bytes.indexOf('\r\n\r\n')
      if (split < 0) return
      const match = /\r\nContent-Length: ([0-9]+)\r\n/.exec(bytes.subarray(0, split + 4).toString())
      if (!match || bytes.length < split + 4 + Number(match[1])) return
      requests.push(bytes)
      if (behavior === 'drop') socket.destroy()
      else socket.end('HTTP/1.1 201 Created\r\nContent-Length: 12\r\nConnection: close\r\n\r\n{"Id":"abc"}')
    })
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(socketPath, resolve))
  return { directory, socketPath, requests, canonical: new Map(), receivedBytes: () => receivedBytes }
}

function dispatcher(f: SyntheticFixture, decision: RootCurrentMemberDecision<{ key: string }>,
  resolver = (_binding: Readonly<{ key: string }>, _current: unknown, operationId: string): RootDockerOperation => {
    const canonical = f.canonical.get(operationId)
    if (!canonical) throw new Error('target-not-bound')
    return canonical
  }): RootDockerEngineDispatcher<{ key: string }> {
  return RootDockerEngineDispatcher.create({ stateDir: path.join(f.directory, 'claims'),
    socketPath: f.socketPath, decision, resolveAuthorizedOperation: resolver, timeoutMs: 200,
    testOnlyAllowNonRoot: true })
}

test('revoke first leaves a durable claim and sends no Docker bytes', async () => {
  const f = await fixture()
  let called = false
  const dispatch = dispatcher(f, { async withCurrentMemberDecision(_binding, _kind, callback) {
    called = true
    throw new Error('product-revoked')
  } })
  const input = operation('operation_revoke_first')
  f.canonical.set(input.operationId, input)
  expect(await dispatch.dispatch(input, { key: 'member' })).toEqual({ outcome: 'uncertain', reason: 'product-revoked' })
  expect(called).toBe(true)
  expect(readdirSync(path.join(f.directory, 'claims'))).toHaveLength(1)
  expect(await dispatch.dispatch(input, { key: 'member' })).toEqual({ outcome: 'already_claimed' })
  await new Promise(resolve => setTimeout(resolve, 10))
  expect(f.receivedBytes()).toBe(0)
  expect(f.requests).toHaveLength(0)
})

test('dispatch first writes exact finite request while Product callback is active and cannot replay', async () => {
  const f = await fixture()
  let active = false
  let policyCount = 0
  const dispatch = dispatcher(f, { async withCurrentMemberDecision(_binding, kind, callback) {
    expect(kind).toBe('prepare')
    active = true
    try { return callback({}) } finally { active = false }
  } }, (_binding, _current, operationId) => {
    expect(active).toBe(true)
    policyCount++
    return f.canonical.get(operationId)!
  })
  const input = operation('operation_dispatch_first')
  f.canonical.set(input.operationId, input)
  const result = await dispatch.dispatch(input, { key: 'member' })
  expect(result).toMatchObject({ outcome: 'responded' })
  expect(policyCount).toBe(1)
  expect(f.requests).toHaveLength(1)
  expect(f.requests[0].toString()).toStartWith('POST /v1.47/networks/create HTTP/1.1\r\n')
  expect(f.requests[0].toString()).toEndWith(input.body)
  expect(await dispatch.dispatch(input, { key: 'member' })).toEqual({ outcome: 'already_claimed' })
  expect(f.requests).toHaveLength(1)
})

test('ambiguous server drop is never resent and operation binding conflicts fail closed', async () => {
  const f = await fixture('drop')
  const dispatch = dispatcher(f, { async withCurrentMemberDecision(_binding, _kind, callback) {
    return callback({})
  } })
  const input = operation('operation_uncertain_drop')
  f.canonical.set(input.operationId, input)
  expect((await dispatch.dispatch(input, { key: 'member' })).outcome).toBe('uncertain')
  expect(f.requests).toHaveLength(1)
  expect(await dispatch.dispatch(input, { key: 'member' })).toEqual({ outcome: 'already_claimed' })
  expect(await dispatch.dispatch(input, { key: 'other-member' })).toEqual({ outcome: 'claim_conflict' })
  expect(await dispatch.dispatch(operation(input.operationId, '{"Name":"other"}'), { key: 'member' }))
    .toEqual({ outcome: 'claim_conflict' })
  expect(f.requests).toHaveLength(1)
  const claim = readFileSync(path.join(f.directory, 'claims', readdirSync(path.join(f.directory, 'claims'))[0]), 'utf8')
  expect(JSON.parse(claim).bodySha256).toBe(input.bodySha256)
})

test('request boundaries reject arbitrary targets, body hashes and oversized create payloads before claim', async () => {
  const f = await fixture()
  const dispatch = dispatcher(f, { async withCurrentMemberDecision(_binding, _kind, callback) {
    return callback({})
  } })
  const invalid = [
    { ...operation('operation_bad_target'), kind: 'start_container', containerId: '../images/prune' },
    { ...operation('operation_bad_hash'), bodySha256: sha('different') },
    { ...operation('operation_extra_field'), arbitraryPath: '/images/prune' },
    operation('operation_big_payload', JSON.stringify({ x: 'a'.repeat(256 * 1024) })),
  ] as RootDockerOperation[]
  for (const item of invalid) expect(dispatch.dispatch(item, { key: 'member' })).rejects.toThrow()
  expect(readdirSync(path.join(f.directory, 'claims'))).toHaveLength(0)
  expect(f.requests).toHaveLength(0)
})

test('each Docker effect has a fixed method and path with no generic proxy route', async () => {
  const f = await fixture()
  const dispatch = dispatcher(f, { async withCurrentMemberDecision(_binding, _kind, callback) {
    return callback({})
  } })
  const emptyHash = sha('')
  const body = '{"Image":"example:test"}'
  const cases: Array<[RootDockerOperation, string]> = [
    [{ kind: 'create_container', operationId: 'operation_create_container', containerName: 'member-1',
      body, bodySha256: sha(body) }, 'POST /v1.47/containers/create?name=member-1 HTTP/1.1'],
    [{ kind: 'start_container', operationId: 'operation_start_container', containerId: 'abc',
      bodySha256: emptyHash }, 'POST /v1.47/containers/abc/start HTTP/1.1'],
    [{ kind: 'inspect_container', operationId: 'operation_inspect_container', containerId: 'abc',
      bodySha256: emptyHash }, 'GET /v1.47/containers/abc/json HTTP/1.1'],
    [{ kind: 'stop_container', operationId: 'operation_stop_container', containerId: 'abc',
      bodySha256: emptyHash }, 'POST /v1.47/containers/abc/stop HTTP/1.1'],
    [{ kind: 'inspect_network', operationId: 'operation_inspect_network', networkId: 'net1',
      bodySha256: emptyHash }, 'GET /v1.47/networks/net1 HTTP/1.1'],
  ]
  for (const [input, requestLine] of cases) {
    f.canonical.set(input.operationId, input)
    await dispatch.dispatch(input, { key: 'member' })
    expect(f.requests.at(-1)?.toString().startsWith(requestLine)).toBe(true)
  }
  expect(f.requests).toHaveLength(cases.length)
})

test('root claim and state path reject hardlink or symlink substitution', async () => {
  const f = await fixture()
  const dispatch = dispatcher(f, { async withCurrentMemberDecision(_binding, _kind, callback) {
    return callback({})
  } })
  const input = operation('operation_link_attack')
  f.canonical.set(input.operationId, input)
  await dispatch.dispatch(input, { key: 'member' })
  const claimsDir = path.join(f.directory, 'claims')
  const claim = path.join(claimsDir, readdirSync(claimsDir)[0])
  linkSync(claim, path.join(claimsDir, 'alias.claim'))
  expect(dispatch.dispatch(input, { key: 'member' })).rejects.toThrow('root-docker-claim-substituted')
  renameSync(claimsDir, path.join(f.directory, 'moved-claims'))
  symlinkSync(path.join(f.directory, 'moved-claims'), claimsDir)
  expect(dispatch.dispatch(operation('operation_path_attack'), { key: 'member' }))
    .rejects.toThrow('root-docker-state-dir-substituted')
})

test('synchronous partial write completes now; no drain or delayed write is accepted', () => {
  const bytes = Buffer.from('fixed request')
  const offsets: number[] = []
  writeCompleteSync(3, bytes, (_fd, _buffer, offset, length) => {
    offsets.push(offset)
    return Math.min(length, 4)
  })
  expect(offsets).toEqual([0, 4, 8, 12])
  let calls = 0
  expect(() => writeCompleteSync(3, bytes, () => { calls++; return 0 })).toThrow('root-docker-sync-write-incomplete')
  expect(calls).toBe(1)
  expect(() => writeCompleteSync(3, bytes, () => { throw Object.assign(new Error('resource busy'), { code: 'EAGAIN' }) }))
    .toThrow('resource busy')
})

test('caller mutation during socket connect cannot change Product binding or approved body', async () => {
  const f = await fixture()
  const original = operation('operation_mutation_race')
  f.canonical.set(original.operationId, original)
  const input = { ...original }
  const binding = { key: 'member' }
  let approved = false
  const dispatch = dispatcher(f, { async withCurrentMemberDecision(seen, _kind, callback) {
    expect(seen.key).toBe('member')
    return callback({})
  } }, (bound, _current, operationId) => {
    expect(bound.key).toBe('member')
    approved = true
    return f.canonical.get(operationId)!
  })
  const pending = dispatch.dispatch(input, binding)
  input.body = '{"Name":"unapproved-network"}'
  input.bodySha256 = sha(input.body)
  binding.key = 'attacker'
  expect((await pending).outcome).toBe('responded')
  expect(approved).toBe(true)
  expect(f.requests[0]?.toString()).toEndWith(original.body)
})

test('nested binding is copied and frozen before connection or Product lookup', async () => {
  const f = await fixture()
  const input = operation('operation_nested_binding')
  f.canonical.set(input.operationId, input)
  const binding = { key: 'member', scope: { generation: 7, labels: ['trusted'] } }
  const dispatch = RootDockerEngineDispatcher.create<typeof binding>({ stateDir: path.join(f.directory, 'claims'),
    socketPath: f.socketPath, testOnlyAllowNonRoot: true, timeoutMs: 200,
    decision: { async withCurrentMemberDecision(seen, _kind, callback) {
      expect(seen.scope.generation).toBe(7)
      expect(seen.scope.labels).toEqual(['trusted'])
      expect(Object.isFrozen(seen.scope)).toBe(true)
      expect(Object.isFrozen(seen.scope.labels)).toBe(true)
      return callback({})
    } },
    resolveAuthorizedOperation: (seen, _current, id) => {
      expect(seen.scope.generation).toBe(7)
      return f.canonical.get(id)!
    },
  })
  const pending = dispatch.dispatch(input, binding)
  binding.scope.generation = 8
  binding.scope.labels[0] = 'attacker'
  expect((await pending).outcome).toBe('responded')
  expect(f.requests).toHaveLength(1)
})

test('binding accessors are rejected before a claim without invoking them', async () => {
  const f = await fixture()
  const dispatch = dispatcher(f, { async withCurrentMemberDecision(_binding, _kind, callback) {
    return callback({})
  } })
  let getterCalls = 0
  const binding = Object.defineProperty({ key: 'member' }, 'scope', {
    enumerable: true,
    get() { getterCalls++; return 'untrusted' },
  })
  expect(dispatch.dispatch(operation('operation_accessor_binding'), binding))
    .rejects.toThrow('root-docker-snapshot-invalid')
  expect(getterCalls).toBe(0)
  expect(readdirSync(path.join(f.directory, 'claims'))).toHaveLength(0)
})

test('start target requires root-owned authorization before any socket write', async () => {
  const f = await fixture()
  const dispatch = dispatcher(f, { async withCurrentMemberDecision(_binding, _kind, callback) {
    return callback({})
  } }, () => { throw new Error('target-not-bound') })
  const input: RootDockerOperation = { kind: 'start_container', operationId: 'operation_unbound_start',
    containerId: 'arbitrary', bodySha256: sha('') }
  expect(await dispatch.dispatch(input, { key: 'member' })).toEqual({ outcome: 'uncertain', reason: 'target-not-bound' })
  expect(f.receivedBytes()).toBe(0)
})

test('syntactically valid but different target is denied against root-owned operation', async () => {
  const f = await fixture()
  const input: RootDockerOperation = { kind: 'stop_container', operationId: 'operation_wrong_target',
    containerId: 'caller-target', bodySha256: sha('') }
  f.canonical.set(input.operationId, { ...input, containerId: 'root-owned-target' })
  const dispatch = dispatcher(f, { async withCurrentMemberDecision(_binding, _kind, callback) {
    return callback({})
  } })
  expect(await dispatch.dispatch(input, { key: 'member' }))
    .toEqual({ outcome: 'uncertain', reason: 'root-docker-operation-not-authorized' })
  expect(f.receivedBytes()).toBe(0)
})

test('dispatcher requires an already provisioned claim directory', async () => {
  const f = await fixture()
  const stateDir = path.join(f.directory, 'not-provisioned')
  expect(() => RootDockerEngineDispatcher.create({ stateDir, socketPath: f.socketPath,
    decision: { async withCurrentMemberDecision(_binding, _kind, callback) { return callback({}) } },
    resolveAuthorizedOperation: () => operation('operation_missing_state'),
    testOnlyAllowNonRoot: true })).toThrow()
  expect(existsSync(stateDir)).toBe(false)
})
