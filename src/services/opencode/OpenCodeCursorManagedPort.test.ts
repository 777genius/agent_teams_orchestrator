import { expect, test } from 'bun:test'
import { createServer } from 'node:net'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  applyCursorManagedProxyEndpoint,
  reserveCursorManagedProxyPort,
} from './OpenCodeCursorManagedPort.js'

const listen = (port: number) => new Promise<() => Promise<void>>((resolve, reject) => {
  const server = createServer()
  server.once('error', reject)
  server.listen({ host: '127.0.0.1', port, exclusive: true }, () =>
    resolve(() => new Promise<void>(done => server.close(() => done()))))
})

test('retains one port per profile so the endpoint and fingerprint stay stable', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cursor-managed-port-'))
  try {
    const statePath = path.join(root, 'cursor-control/proxy-port.json')
    const first = await reserveCursorManagedProxyPort(statePath)
    expect(first).toBeGreaterThan(1024)
    expect(first).toBeLessThan(65_536)
    expect(await reserveCursorManagedProxyPort(statePath)).toBe(first)
    // Independent assignments normally differ; neither is an OS reservation.
    const other = await reserveCursorManagedProxyPort(path.join(root, 'other/proxy-port.json'))
    expect(other).not.toBe(first)
    expect(JSON.parse(await readFile(statePath, 'utf8'))).toEqual({ version: 1, port: first })

    // A reserved port is actually bindable, which is what the plugin will do.
    const close = await listen(first)
    await close()

    for (const corrupt of ['{}', '{"version":2,"port":40000}', '{"version":1,"port":80}', 'not json']) {
      await writeFile(statePath, corrupt, 'utf8')
      await expect(reserveCursorManagedProxyPort(statePath)).rejects.toThrow('state is corrupt')
      expect(await readFile(statePath, 'utf8')).toBe(corrupt)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('points the Cursor provider at the retained endpoint and leaves others alone', () => {
  const config = {
    provider: {
      'cursor-acp': { name: 'Cursor ACP', options: { baseURL: 'http://127.0.0.1:32124/v1', apiKey: 'keep' } },
      kiro: { name: 'Kiro', options: { baseURL: 'http://127.0.0.1:32124/v1' } },
    },
  }
  applyCursorManagedProxyEndpoint(config, 45123)
  expect(config.provider['cursor-acp']).toEqual({
    name: 'Cursor ACP', options: { baseURL: 'http://127.0.0.1:45123/v1', apiKey: 'keep' },
  })
  expect(config.provider.kiro.options.baseURL).toBe('http://127.0.0.1:32124/v1')
})

test('never invents a provider entry and refuses an unusable port', () => {
  for (const config of [{}, { provider: {} }, { provider: null }, { provider: [] }]) {
    const before = JSON.stringify(config)
    applyCursorManagedProxyEndpoint(config as Record<string, unknown>, 45123)
    expect(JSON.stringify(config)).toBe(before)
  }
  const withProvider: Record<string, unknown> = { provider: { 'cursor-acp': { name: 'Cursor ACP' } } }
  applyCursorManagedProxyEndpoint(withProvider, 45123)
  expect((withProvider.provider as Record<string, unknown>)['cursor-acp']).toEqual({
    name: 'Cursor ACP', options: { baseURL: 'http://127.0.0.1:45123/v1' },
  })
  for (const port of [0, 80, 70_000, 1.5, Number.NaN]) {
    expect(() => applyCursorManagedProxyEndpoint({ provider: {} }, port))
      .toThrow('Cursor managed proxy port is invalid')
  }
})

test('concurrent preparations publish one complete retained assignment', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cursor-port-race-'))
  try {
    const state = path.join(root, 'port.json')
    const ports = await Promise.all(Array.from({ length: 16 }, () => reserveCursorManagedProxyPort(state)))
    expect(new Set(ports).size).toBe(1)
    expect(JSON.parse(await readFile(state, 'utf8')).port).toBe(ports[0])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('independent processes blocked before publication return the same assignment', async () => {
  const { lock } = await import('../../utils/lockfile.js')
  const root = await mkdtemp(path.join(os.tmpdir(), 'cursor-port-process-race-'))
  const state = path.join(root, 'port.json')
  const release = await lock(state, { realpath: false })
  const modulePath = new URL('./OpenCodeCursorManagedPort.ts', import.meta.url).href
  const children = Array.from({ length: 4 }, () => Bun.spawn([process.execPath, '-e',
    `import { reserveCursorManagedProxyPort } from ${JSON.stringify(modulePath)}; console.log('ready'); console.log(await reserveCursorManagedProxyPort(${JSON.stringify(state)}));`],
  { stdout: 'pipe', stderr: 'pipe' }))
  let released = false
  try {
    const readers = children.map(child => child.stdout.getReader())
    for (const reader of readers) expect(new TextDecoder().decode((await reader.read()).value)).toContain('ready')
    await release()
    released = true
    const ports = await Promise.all(readers.map(async reader => {
      let text = ''
      for (;;) { const chunk = await reader.read(); if (chunk.done) break; text += new TextDecoder().decode(chunk.value) }
      return Number(text.trim())
    }))
    expect(await Promise.all(children.map(child => child.exited))).toEqual([0, 0, 0, 0])
    expect(new Set(ports).size).toBe(1)
    expect(JSON.parse(await readFile(state, 'utf8')).port).toBe(ports[0])
  } finally {
    if (!released) await release()
    for (const child of children) child.kill()
    await rm(root, { recursive: true, force: true })
  }
}, 15_000)
