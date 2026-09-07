import { afterAll, beforeAll, expect, test } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { chmod, copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { buildCursorPluginArtifact } from './build.js'

type Entry = { pid?: number; count?: number }
let root = ''
let host: ChildProcess | undefined
let occupied: ReturnType<typeof Bun.serve> | undefined
let baseURL = ''
let diagnostics = ''
const active = new Set<AbortController>()

const entries = (id: string): Entry[] => {
  const file = path.join(root, `${id}.jsonl`)
  return existsSync(file)
    ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    : []
}
const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}
async function waitFor(predicate: () => boolean, timeout = 5_000): Promise<void> {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Transport fixture timed out: ${diagnostics}`)
    await Bun.sleep(25)
  }
}
function start(id: string, stream = true) {
  const controller = new AbortController()
  active.add(controller)
  let settled = false
  const response = fetch(`${baseURL}/chat/completions`, {
    method: 'POST', signal: controller.signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'auto', stream, tools: [], messages: [{ role: 'user', content: `CASE:${id}` }] }),
  }).then(async result => {
    if (!result.ok) throw new Error(`Proxy returned ${result.status}: ${await result.text()}`)
    return result.text()
  }).then(text => ({ text, error: null }), error => ({ text: '', error }))
    .finally(() => { settled = true; active.delete(controller) })
  return { controller, response, settled: () => settled }
}
async function expectStopped(id: string): Promise<void> {
  const pid = entries(id)[0]?.pid
  expect(pid).toBeNumber()
  await waitFor(() => !alive(pid!), 3_000)
  const stoppedCount = entries(id).length
  await Bun.sleep(250)
  expect(entries(id)).toHaveLength(stoppedCount)
}

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'cursor-artifact-transport-'))
  await Promise.all(['home', 'config', 'data', 'cache', 'project'].map(dir => mkdir(path.join(root, dir))))
  const artifact = await buildCursorPluginArtifact(path.join(root, 'artifact'))
  const fake = path.join(root, 'fake-cursor')
  await copyFile(path.join(import.meta.dir, 'transport-fake-cursor.ts'), fake)
  await chmod(fake, 0o700)
  try {
    occupied = Bun.serve({ hostname: '127.0.0.1', port: 32124, fetch: () => new Response('test-owned occupied port') })
  } catch (error) {
    // An existing server also proves the port is occupied; never stop or query it.
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error
  }
  const ready = path.join(root, 'ready.json')
  host = spawn(process.execPath, [path.join(import.meta.dir, 'transport-host.ts'), artifact, ready], {
    cwd: path.join(root, 'project'), detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: [path.dirname(process.execPath), process.env.PATH].filter(Boolean).join(path.delimiter),
      HOME: path.join(root, 'home'), XDG_CONFIG_HOME: path.join(root, 'config'),
      XDG_DATA_HOME: path.join(root, 'data'), XDG_CACHE_HOME: path.join(root, 'cache'),
      CURSOR_AGENT_EXECUTABLE: fake, CURSOR_TRANSPORT_TEST_LOG_ROOT: root,
      CURSOR_ACP_BACKEND: 'cursor-agent', CURSOR_ACP_FORCE: 'false',
      CURSOR_ACP_REUSE_EXISTING_PROXY: 'false', CURSOR_ACP_AGENT_POOL: 'false',
      CURSOR_ACP_SESSION_RESUME: 'false', CURSOR_ACP_MODEL_AUTO_REFRESH: 'false',
      CURSOR_ACP_MCP_BRIDGE: 'false', CURSOR_ACP_ENABLE_OPENCODE_TOOLS: 'false',
      CURSOR_ACP_TOOL_LOOP_MODE: 'opencode', CURSOR_ACP_PROVIDER_BOUNDARY: 'v1',
      CURSOR_ACP_PROVIDER_BOUNDARY_AUTOFALLBACK: 'false', CURSOR_ACP_LOG_SILENT: 'true',
    },
  })
  for (const stream of [host.stdout, host.stderr]) {
    stream?.on('data', chunk => { diagnostics = (diagnostics + chunk.toString()).slice(-4_000) })
  }
  await waitFor(() => {
    if (host?.exitCode !== null) throw new Error(`Plugin host exited: ${diagnostics}`)
    return existsSync(ready)
  }, 15_000)
  baseURL = JSON.parse(readFileSync(ready, 'utf8')).baseURL
}, 30_000)

afterAll(async () => {
  for (const controller of active) controller.abort()
  if (host?.pid) {
    // This detached process group contains only the test host and its fake CLI.
    try { process.kill(-host.pid, 'SIGTERM') } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
    await waitFor(() => !alive(host!.pid!), 3_000)
  }
  occupied?.stop(true)
  if (root) await rm(root, { recursive: true, force: true })
})

test('default plugin hooks expose a working proxy when the preferred port is occupied', async () => {
  expect(new URL(baseURL).port).not.toBe('32124')
  expect((await fetch(new URL('/health', baseURL))).ok).toBe(true)
  if (occupied) {
    expect(await (await fetch('http://127.0.0.1:32124')).text()).toBe('test-owned occupied port')
  }
})

test('HTTP abort stops only its streaming fake child while the sibling completes', async () => {
  const cancelled = start('cancel')
  const sibling = start('normal')
  await waitFor(() => entries('cancel').length >= 3 && entries('normal').length >= 3)
  cancelled.controller.abort()
  expect((await cancelled.response).error).not.toBeNull()
  await expectStopped('cancel')
  const result = await sibling.response
  expect(result.error).toBeNull()
  expect(result.text).toContain('normal:8')
  expect(entries('normal').filter(entry => entry.count)).toHaveLength(8)
  await waitFor(() => !alive(entries('normal')[0]!.pid!))
}, 10_000)

test('HTTP abort also stops the fake child before a buffered response completes', async () => {
  const buffered = start('buffered', false)
  await waitFor(() => entries('buffered').length >= 2)
  buffered.controller.abort()
  expect((await buffered.response).error).not.toBeNull()
  await expectStopped('buffered')
}, 10_000)

test('a silent first token beyond the default ten-second idle timeout remains connected', async () => {
  const slow = start('slow')
  await waitFor(() => entries('slow').length === 1)
  await Bun.sleep(11_000)
  expect(entries('slow')).toHaveLength(1)
  expect(slow.settled()).toBe(false)
  expect(alive(entries('slow')[0]!.pid!)).toBe(true)
  await waitFor(() => entries('slow').length >= 3)
  slow.controller.abort()
  expect((await slow.response).error).not.toBeNull()
  await expectStopped('slow')
}, 20_000)
