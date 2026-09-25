import { afterEach, expect, test } from 'bun:test'
import { chmod, mkdtemp, realpath, rm } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { RootDockerApiAdmission, type RootDockerApiPins } from './RootDockerApiAdmission.js'

const pins: RootDockerApiPins = {
  daemonId: '32f002e5-41e9-48cf-b009-0a5a2e3532ad',
  serverVersion: '29.8.1', apiVersion: '1.56', minApiVersion: '1.40',
}
const directories: string[] = []
const servers: Server[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()))
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function fixture(responses: Record<string, { status?: number; body: unknown }> = {},
  unfinishedError = false) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'root-docker-api-')))
  directories.push(directory)
  const socketPath = path.join(directory, 'docker.sock')
  const requests: string[] = []
  const connections: Socket[] = []
  const version = { Version: pins.serverVersion, ApiVersion: pins.apiVersion,
    MinAPIVersion: pins.minApiVersion }
  const info = { ID: pins.daemonId, ServerVersion: pins.serverVersion, OSType: 'linux' }
  const server = createServer(socket => {
    connections.push(socket)
    let bytes = ''
    socket.on('data', chunk => {
      bytes += chunk.toString('latin1')
      if (!bytes.includes('\r\n\r\n')) return
      const line = bytes.split('\r\n', 1)[0]
      requests.push(line)
      const uri = line.split(' ')[1]
      if (unfinishedError && uri === '/v1.47/version') {
        socket.write('HTTP/1.1 500 Error\r\nContent-Length: 1000\r\nConnection: keep-alive\r\n\r\n')
        return
      }
      const reply = responses[uri] ?? { body: uri === '/v1.47/version' ? version : info }
      const body = JSON.stringify(reply.body)
      socket.end(`HTTP/1.1 ${reply.status ?? 200} ${reply.status ? 'Error' : 'OK'}\r\n` +
        `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`)
    })
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(socketPath, resolve))
  await chmod(socketPath, 0o660)
  return { socketPath, requests, connections }
}

test('exact pinned Docker 29 API and daemon identity admit using only Unix socket GETs', async () => {
  const f = await fixture()
  const admission = RootDockerApiAdmission.create({ socketPath: f.socketPath, pins,
    testOnlyAllowNonRoot: true })
  expect(await admission.assertDockerApiCompatible()).toBe(true)
  expect(f.requests).toEqual(['GET /v1.47/version HTTP/1.1', 'GET /v1.47/info HTTP/1.1'])
})

test('version, API range, and daemon identity drift fail closed', async () => {
  const cases: Array<[string, Record<string, { body: unknown }>]> = [
    ['server version', { '/v1.47/version': { body: { Version: '29.8.2', ApiVersion: pins.apiVersion,
      MinAPIVersion: pins.minApiVersion } } }],
    ['API version', { '/v1.47/version': { body: { Version: pins.serverVersion, ApiVersion: '1.55',
      MinAPIVersion: pins.minApiVersion } } }],
    ['daemon ID', { '/v1.47/info': { body: { ID: 'another-daemon-identity',
      ServerVersion: pins.serverVersion, OSType: 'linux' } } }],
    ['non-Linux daemon', { '/v1.47/info': { body: { ID: pins.daemonId,
      ServerVersion: pins.serverVersion, OSType: 'windows' } } }],
  ]
  for (const [_reason, responses] of cases) {
    const f = await fixture(responses)
    expect(await RootDockerApiAdmission.create({ socketPath: f.socketPath, pins,
      testOnlyAllowNonRoot: true }).assertDockerApiCompatible()).toBe(false)
  }
  expect(() => RootDockerApiAdmission.create({ socketPath: '/tmp/docker.sock',
    pins: { ...pins, serverVersion: '27.5.1' }, testOnlyAllowNonRoot: true })).toThrow('policy-invalid')
  expect(() => RootDockerApiAdmission.create({ socketPath: '/tmp/docker.sock',
    pins: { ...pins, minApiVersion: '1.48' }, testOnlyAllowNonRoot: true })).toThrow('policy-invalid')
})

test('untrusted socket and failed read-only probe never admit', async () => {
  const f = await fixture({ '/v1.47/version': { status: 500, body: { message: 'broken' } } })
  const admission = RootDockerApiAdmission.create({ socketPath: f.socketPath, pins,
    testOnlyAllowNonRoot: true })
  expect(await admission.assertDockerApiCompatible()).toBe(false)
  expect(f.requests).toEqual(['GET /v1.47/version HTTP/1.1'])
  await chmod(f.socketPath, 0o666)
  expect(await admission.assertDockerApiCompatible()).toBe(false)
  expect(f.requests).toHaveLength(1)
})

test('unfinished error response closes its Unix socket after rejection', async () => {
  const f = await fixture({}, true)
  try {
    const admission = RootDockerApiAdmission.create({ socketPath: f.socketPath, pins,
      timeoutMs: 100, testOnlyAllowNonRoot: true })
    expect(await admission.assertDockerApiCompatible()).toBe(false)
    expect(f.requests).toEqual(['GET /v1.47/version HTTP/1.1'])
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(f.connections[0]?.destroyed).toBe(true)
  } finally {
    for (const socket of f.connections) socket.destroy()
  }
})
