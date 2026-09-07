import { afterEach, expect, test } from 'bun:test'
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createManagedCursorControl, CURSOR_CONTROL_HEADERS, type ManagedCursorRequest } from './managed-control.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture(waitTimeoutMs = 1000) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cursor-managed-control-'))
  roots.push(root)
  const control = createManagedCursorControl({ directory: path.join(root, 'control'), profileScopeToken: 'scope-a', waitTimeoutMs })
  const descriptor = control.publish('http://127.0.0.1:43123/v1')
  const request = (sessionId = 'session-a', signal?: AbortSignal) => new Request('http://127.0.0.1:43123/v1/chat/completions', {
    method: 'POST', signal, headers: control.headers({ sessionId, messageId: 'message-a' }),
  })
  const route = (body: Record<string, unknown>, signal?: AbortSignal) => control.handleRequest(new Request(descriptor.controlUrl, {
    method: 'POST', signal, headers: { authorization: `Bearer ${descriptor.controlToken}` },
    body: JSON.stringify({ hostGeneration: descriptor.hostGeneration, profileScopeToken: descriptor.profileScopeToken, ...body }),
  }))!
  return { root, control, descriptor, request, route }
}
function fakeChild() {
  let finish!: (code: number) => void
  let kills = 0
  return {
    child: { pid: 1234, kill() { kills++ }, exited: new Promise<number>(resolve => { finish = resolve }) },
    finish: (code = 0) => finish(code), kills: () => kills,
  }
}
async function ack(request: ManagedCursorRequest, overrides: Record<string, unknown> = {}) {
  await writeFile(request.env.CURSOR_SUPERVISOR_REPORT, JSON.stringify({
    version: 1, requestId: request.requestId, supervisorPid: 1234, cleanupCompleted: true, failures: [], remaining: [], ...overrides,
  }), { mode: 0o600 })
}

test('publishes the exact private descriptor and refuses unauthenticated or stale admissions', async () => {
  const { root, control, descriptor, request, route } = await fixture()
  expect((await stat(path.join(root, 'control'))).mode & 0o777).toBe(0o700)
  const descriptorFile = path.join(root, 'control', `${process.pid}.json`)
  expect((await stat(descriptorFile)).mode & 0o777).toBe(0o600)
  expect(JSON.parse(await readFile(descriptorFile, 'utf8'))).toEqual(descriptor)
  expect(descriptor.controlUrl).toBe('http://127.0.0.1:43123/agent-teams/cursor/stop')
  for (const key of Object.values(CURSOR_CONTROL_HEADERS)) {
    const invalid = request()
    invalid.headers.delete(key)
    expect(() => control.accept(invalid)).toThrow()
  }
  const stale = request()
  stale.headers.set(CURSOR_CONTROL_HEADERS.generation, 'old-generation')
  expect(() => control.accept(stale)).toThrow()
  expect((await route({ action: 'begin', sessionId: 'a', hostGeneration: 'old-generation' })).status).toBe(409)
  expect(control.handleRequest(new Request('http://127.0.0.1:43123/health'))).toBeNull()
  expect((await control.handleRequest(new Request(descriptor.controlUrl, { method: 'POST', body: '{}' }))!).status).toBe(403)
})

test('begin seals synchronously before body/child attachment and repeated begin is idempotent', async () => {
  const { control, request, route } = await fixture()
  const admitted = control.accept(request())
  const response = await route({ action: 'begin', sessionId: 'session-a' })
  const { stopToken } = await response.json() as { stopToken: string }
  expect(admitted.signal.aborted).toBe(true)
  expect(control.beginStop('session-a')).toEqual({ stopToken })
  expect(() => control.accept(request())).toThrow('permanently stopped')
  let done = false
  const wait = control.waitStop(stopToken).then(result => { done = true; return result })
  await Bun.sleep(10)
  expect(done).toBe(false)
  admitted.neverStarted()
  expect(await wait).toEqual({ cleanupCompleted: true })
  const sibling = control.accept(request('session-b'))
  sibling.neverStarted()
  expect((await route({ action: 'wait', stopToken })).status).toBe(200)
})

test('terminal Stop cancels every request in its session but leaves a sibling intact', async () => {
  const { control, request } = await fixture()
  const first = control.accept(request()), second = control.accept(request()), sibling = control.accept(request('session-b'))
  expect(first.requestId).not.toBe(second.requestId)
  const children = [fakeChild(), fakeChild(), fakeChild()]
  ;[first, second, sibling].forEach((handle, i) => handle.attachChild(children[i]!.child))
  const { stopToken } = control.beginStop('session-a')
  expect(children.map(child => child.kills())).toEqual([1, 1, 0])
  await Promise.all([ack(first), ack(second), ack(sibling)])
  children.forEach(child => child.finish())
  expect(await control.waitStop(stopToken)).toEqual({ cleanupCompleted: true })
  expect(await control.waitStop(control.beginStop('session-b').stopToken)).toEqual({ cleanupCompleted: true })
})

test('normal HTTP abort does not seal a session and attach-after-cancel kills immediately', async () => {
  const { control, request } = await fixture()
  const abort = new AbortController()
  const admitted = control.accept(request('session-a', abort.signal))
  abort.abort()
  expect(admitted.signal.aborted).toBe(true)
  const child = fakeChild()
  admitted.attachChild(child.child)
  expect(child.kills()).toBe(1)
  await ack(admitted)
  child.finish()
  const followup = control.accept(request())
  followup.neverStarted()
  expect(await control.waitStop(control.beginStop('session-a').stopToken)).toEqual({ cleanupCompleted: true })
})

test.each([
  ['missing', null], ['wrong request', { requestId: 'previous-request' }],
  ['wrong version', { version: 0 }],
  ['wrong process', { supervisorPid: 9999 }], ['false cleanup', { cleanupCompleted: false }],
  ['failures', { failures: [{ phase: 'cleanup' }] }], ['remaining', { remaining: [{ pid: 9999 }] }],
  ['missing arrays', { failures: null, remaining: null }],
] as const)('a %s ACK is a sticky failure even if a valid report appears later', async (_label, invalid) => {
  const { control, request, route } = await fixture()
  const admitted = control.accept(request())
  const child = fakeChild()
  admitted.attachChild(child.child)
  if (invalid) await ack(admitted, invalid)
  child.finish()
  const { stopToken } = control.beginStop('session-a')
  expect((await control.waitStop(stopToken)).cleanupCompleted).toBe(false)
  await ack(admitted)
  expect((await control.waitStop(stopToken)).cleanupCompleted).toBe(false)
  expect((await route({ action: 'wait', stopToken })).status).toBe(502)
})

test('aborting or timing out a wait never undoes sealing or request cleanup', async () => {
  const { control, request, route } = await fixture(30)
  const admitted = control.accept(request())
  const child = fakeChild()
  admitted.attachChild(child.child)
  const { stopToken } = control.beginStop('session-a')
  const abort = new AbortController()
  const waiting = route({ action: 'wait', stopToken }, abort.signal)
  abort.abort()
  expect((await waiting).status).toBe(408)
  expect((await route({ action: 'wait', stopToken })).status).toBe(408)
  expect(child.kills()).toBe(1)
  expect(() => control.accept(request())).toThrow()
  await ack(admitted)
  child.finish()
  expect((await route({ action: 'wait', stopToken })).status).toBe(200)
  await expect(stat(admitted.env.CURSOR_SUPERVISOR_REPORT)).rejects.toMatchObject({ code: 'ENOENT' })
})

test.each([70, undefined, null, -1, 256, 0.5])('exit %s cannot validate an otherwise successful ACK', async exitCode => {
  const { control, request } = await fixture()
  const admitted = control.accept(request())
  await ack(admitted)
  admitted.attachChild({ pid: 1234, kill() {}, exited: Promise.resolve(exitCode) })
  expect((await control.waitStop(control.beginStop('session-a').stopToken)).cleanupCompleted).toBe(false)
  expect((await stat(admitted.env.CURSOR_SUPERVISOR_REPORT)).isFile()).toBe(true)
})

test('an ACK with non-private permissions cannot confirm cleanup', async () => {
  const { control, request } = await fixture()
  const admitted = control.accept(request())
  await ack(admitted)
  await chmod(admitted.env.CURSOR_SUPERVISOR_REPORT, 0o644)
  admitted.attachChild({ pid: 1234, kill() {}, exited: Promise.resolve(0) })
  expect((await control.waitStop(control.beginStop('session-a').stopToken)).cleanupCompleted).toBe(false)
})

test('an observed cancellation exit with a matching ACK confirms cleanup', async () => {
  const { control, request } = await fixture()
  const admitted = control.accept(request())
  await ack(admitted)
  admitted.attachChild({ pid: 1234, kill() {}, exited: Promise.resolve(143) })
  expect(await control.waitStop(control.beginStop('session-a').stopToken)).toEqual({ cleanupCompleted: true })
})

test('real fake-process completion requires both child exit and its matching cleanup ACK', async () => {
  const { control, request, root } = await fixture()
  const admitted = control.accept(request())
  const child = Bun.spawn([process.execPath, '-e', `
    await Bun.write(process.env.CURSOR_SUPERVISOR_REPORT, JSON.stringify({
      version: 1, requestId: process.env.CURSOR_OWNER_REQUEST_ID, supervisorPid: process.pid,
      cleanupCompleted: true, failures: [], remaining: []
    }));
    await import('node:fs/promises').then(fs => fs.chmod(process.env.CURSOR_SUPERVISOR_REPORT, 0o600));
    await Bun.sleep(150);
  `], { cwd: root, env: admitted.env, stdout: 'ignore', stderr: 'ignore' })
  admitted.attachChild({ pid: child.pid, exited: child.exited, kill() {} })
  const { stopToken } = control.beginStop('session-a')
  let done = false
  const result = control.waitStop(stopToken).then(value => { done = true; return value })
  try {
    await Bun.sleep(50)
    expect(done).toBe(false)
    expect(await result).toEqual({ cleanupCompleted: true })
  } finally {
    child.kill()
    await child.exited
  }
})
