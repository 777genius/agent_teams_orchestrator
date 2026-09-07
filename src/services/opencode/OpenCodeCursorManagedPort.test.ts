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
    // Two profiles must never be handed the same endpoint.
    const other = await reserveCursorManagedProxyPort(path.join(root, 'other/proxy-port.json'))
    expect(other).not.toBe(first)
    expect(JSON.parse(await readFile(statePath, 'utf8'))).toEqual({ version: 1, port: first })

    // A reserved port is actually bindable, which is what the plugin will do.
    const close = await listen(first)
    await close()

    for (const corrupt of ['{}', '{"version":2,"port":40000}', '{"version":1,"port":80}', 'not json']) {
      await writeFile(statePath, corrupt, 'utf8')
      const replacement = await reserveCursorManagedProxyPort(statePath)
      expect(replacement).toBeGreaterThan(1024)
      expect(JSON.parse(await readFile(statePath, 'utf8')).port).toBe(replacement)
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
