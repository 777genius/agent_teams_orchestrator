import { afterEach, expect, test } from 'bun:test'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { stopCursorSessionWithNativeCleanup } from './OpenCodeCursorStopControl.js'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))) })

async function fixture(overrides: Record<string, unknown> = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cursor-stop-control-test-'))
  directories.push(directory)
  await chmod(directory, 0o700)
  const descriptor = {
    version: 1, hostPid: 123, hostGeneration: 'generation-123456789', profileScopeToken: 'scope',
    controlUrl: 'http://127.0.0.1:32124/agent-teams/cursor/stop', controlToken: 'a'.repeat(48), ...overrides,
  }
  await writeFile(path.join(directory, '123.json'), JSON.stringify(descriptor), { mode: 0o600 })
  const profile = { env: { AGENT_TEAMS_CURSOR_CONTROL_DIR: directory, AGENT_TEAMS_CURSOR_PROFILE_SCOPE: 'scope' } }
  return { profile, runtimePid: 123, sessionId: 'session-a' }
}

test('seals before transport abort and waits for native cleanup before success', async () => {
  const events: string[] = []
  const input = await fixture()
  const fetchMock = (async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body))
    events.push(body.action)
    expect(init.redirect).toBe('error')
    expect(body.hostGeneration).toBe('generation-123456789')
    return Response.json(body.action === 'begin' ? { stopToken: 'stop-token-123456789' } : { cleanupCompleted: true })
  })
  expect(await stopCursorSessionWithNativeCleanup({ ...input, fetch: fetchMock,
    abortTransport: async () => { events.push('abort'); return true },
  })).toBe(true)
  expect(events).toEqual(['begin', 'abort', 'wait'])
})

test('transport idle or abort acceptance cannot replace a native cleanup ACK', async () => {
  for (const response of [{}, { cleanupCompleted: false }]) {
    const input = await fixture()
    let calls = 0
    await expect(stopCursorSessionWithNativeCleanup({ ...input, abortTransport: async () => true,
      fetch: async () => Response.json(++calls === 1 ? { stopToken: 'stop-token-123456789' } : response),
    })).rejects.toThrow('cleanup is unconfirmed')
    expect(calls).toBe(2)
  }
})

test('rejects stale host identity and non-loopback endpoints before sending credentials', async () => {
  for (const overrides of [{ hostPid: 456 }, { profileScopeToken: 'other' }, { controlUrl: 'https://example.com/' }]) {
    const input = await fixture(overrides)
    let aborts = 0, requests = 0
    await expect(stopCursorSessionWithNativeCleanup({ ...input,
      abortTransport: async () => { aborts++; return true },
      fetch: async () => { requests++; return Response.json({}) },
    })).rejects.toThrow('could not seal')
    expect(aborts).toBe(1)
    expect(requests).toBe(0)
  }
})

test('seal failure still attempts transport containment without claiming Stop', async () => {
  const input = await fixture()
  let aborted = false
  await expect(stopCursorSessionWithNativeCleanup({ ...input,
    abortTransport: async () => { aborted = true; return true },
    fetch: async () => new Response(null, { status: 503 }),
  })).rejects.toThrow('cleanup is unconfirmed')
  expect(aborted).toBe(true)
})

test('transport failure still waits for owned processes, then remains an error', async () => {
  const input = await fixture()
  const events: string[] = []
  await expect(stopCursorSessionWithNativeCleanup({ ...input,
    abortTransport: async () => { events.push('abort'); throw new Error('fixture') },
    fetch: (async (_url: unknown, init: RequestInit) => {
      const action = JSON.parse(String(init.body)).action
      events.push(action)
      return Response.json(action === 'begin' ? { stopToken: 'stop-token-123456789' } : { cleanupCompleted: true })
    }),
  })).rejects.toThrow('OpenCode cancellation failed')
  expect(events).toEqual(['begin', 'abort', 'wait'])
})
