import { afterAll, beforeAll, expect, test } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { buildCursorPluginArtifact } from './build.js'

type Entry = { pid?: number; count?: number; descendantPid?: number }
let root = ''
let host: ChildProcess | undefined
let occupied: ReturnType<typeof Bun.serve> | undefined
let baseURL = ''
let diagnostics = ''
let artifact = ''
let fixture: ReturnType<typeof Bun.serve>
let fixtureEnv: NodeJS.ProcessEnv
const calls: Array<{ name: string; arguments: { id: string } }> = []
let bridgeResults: Record<string, unknown>
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
  artifact = await buildCursorPluginArtifact(path.join(root, 'artifact'))
  const fake = path.join(root, 'fake-cursor')
  await copyFile(path.join(import.meta.dir, 'transport-fake-cursor.ts'), fake)
  await chmod(fake, 0o700)
  try {
    occupied = Bun.serve({ hostname: '127.0.0.1', port: 32124, fetch: () => new Response('test-owned occupied port') })
  } catch (error) {
    // An existing server also proves the port is occupied; never stop or query it.
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error
  }
  // One HTTP MCP endpoint serves both the first-class hook and staged CLI.
  fixture = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    if (req.headers.get('x-fixture') !== 'owned') return new Response(null, { status: 403 })
    if (req.method !== 'POST') return new Response(null, { status: 405 })
    const body = await req.json() as any
    if (!('id' in body)) return new Response(null, { status: 202 })
    let result: unknown
    if (body.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
    else if (body.method === 'tools/list') result = { tools: ['receipt', 'failure', 'protocol'].map(name => ({ name, inputSchema: { type: 'object', properties: { id: { type: 'string' } } } })) }
    else if (body.method === 'tools/call') {
      calls.push(body.params)
      if (body.params.name === 'protocol' || !['receipt', 'failure'].includes(body.params.name)) {
        return Response.json({ jsonrpc: '2.0', id: body.id, error: { code: -32602, message: 'Unknown or rejected tool' } })
      }
      result = { isError: body.params.name === 'failure', content: [{ type: 'text', text: `receipt:${body.params.arguments.id}` }] }
    } else return new Response(null, { status: 400 })
    return Response.json({ jsonrpc: '2.0', id: body.id, result })
  } })
  const config = path.join(root, 'mcp.json')
  await writeFile(config, JSON.stringify({ mcp: { fixture: { type: 'remote', url: `http://127.0.0.1:${fixture.port}/mcp`, headers: { 'x-fixture': 'owned' } } } }))
  fixtureEnv = { PATH: process.env.PATH, HOME: path.join(root, 'home'), OPENCODE_CONFIG: config, CURSOR_ACP_LOG_SILENT: 'true' }
  const ready = path.join(root, 'ready.json')
  host = spawn(process.execPath, [path.join(import.meta.dir, 'transport-host.ts'), artifact, ready], {
    cwd: path.join(root, 'project'), detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: [path.dirname(process.execPath), process.env.PATH].filter(Boolean).join(path.delimiter),
      HOME: path.join(root, 'home'), XDG_CONFIG_HOME: path.join(root, 'config'),
      XDG_DATA_HOME: path.join(root, 'data'), XDG_CACHE_HOME: path.join(root, 'cache'),
      OPENCODE_CONFIG: config, CURSOR_TRANSPORT_TEST_MCP: 'true',
      CURSOR_TRANSPORT_TEST_MCP_CLI: path.join(path.dirname(artifact), 'cli/mcptool.js'),
      CURSOR_AGENT_EXECUTABLE: fake, CURSOR_TRANSPORT_TEST_LOG_ROOT: root,
      CURSOR_ACP_BACKEND: 'cursor-agent', CURSOR_ACP_FORCE: 'false',
      CURSOR_ACP_REUSE_EXISTING_PROXY: 'false', CURSOR_ACP_AGENT_POOL: 'false',
      CURSOR_ACP_SESSION_RESUME: 'false', CURSOR_ACP_MODEL_AUTO_REFRESH: 'false',
      CURSOR_ACP_MCP_BRIDGE: 'true', CURSOR_ACP_ENABLE_OPENCODE_TOOLS: 'false',
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
  const readyData = JSON.parse(readFileSync(ready, 'utf8'))
  baseURL = readyData.baseURL
  bridgeResults = readyData.mcpResults
}, 30_000)

afterAll(async () => {
  for (const controller of active) controller.abort()
  if (host?.pid) {
    // Request groups are separate from the host: clean up only recorded fixtures.
    for (const id of ['cancel', 'normal', 'buffered', 'slow', 'tree', 'resistant', 'silent', 'control']) {
      const pid = entries(id)[0]?.pid
      if (pid) { try { process.kill(-pid, 'SIGKILL') } catch {} }
    }
    try { process.kill(-host.pid, 'SIGTERM') } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
    await waitFor(() => !alive(host!.pid!), 3_000)
  }
  occupied?.stop(true)
  fixture?.stop(true)
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

for (const id of ['tree', 'resistant', 'silent', 'buffered']) {
  test(`abort stops ordinary grandchildren and late files: ${id}`, async () => {
    await rm(path.join(root, `${id}.jsonl`), { force: true })
    const request = start(id, id !== 'buffered')
    const sibling = start('followup')
    await waitFor(() => entries(id).filter(e => e.descendantPid).length === 2)
    request.controller.abort()
    request.controller.abort()
    expect((await request.response).error).not.toBeNull()
    await expectStopped(id)
    await waitFor(() => entries(id).filter(e => e.descendantPid).every(e => !alive(e.descendantPid!)), 3000)
    await Bun.sleep(2300)
    for (const role of ['child', 'grandchild']) {
      expect(existsSync(path.join(root, `${id}-${role}.effect`))).toBe(false)
      expect(calls.filter(call => call.arguments.id === `${id}-${role}`)).toHaveLength(0)
    }
    expect((await sibling.response).error).toBeNull()
  }, 10_000)
}

test('ordinary descendant fixture produces delayed files without cancellation', async () => {
  await rm(path.join(root, 'tree.jsonl'), { force: true })
  const request = start('tree')
  await waitFor(() => existsSync(path.join(root, 'tree-grandchild.effect')), 5000)
  expect(existsSync(path.join(root, 'tree-child.effect'))).toBe(true)
  await waitFor(() => calls.some(call => call.arguments.id === 'tree-grandchild'))
  request.controller.abort()
  await request.response
  await expectStopped('tree')
}, 10_000)

test('staged bridge and mcptool propagate tool failures through the same HTTP server', async () => {
  expect(bridgeResults.receipt).toBe('receipt:bridge')
  expect(bridgeResults.failure).toEqual({ failed: true })
  expect(bridgeResults.protocol).toEqual({ failed: true })
  for (const name of ['receipt', 'failure', 'protocol', 'unknown']) {
    const before = calls.length
    const child = Bun.spawn([process.execPath, path.join(path.dirname(artifact), 'cli/mcptool.js'), 'call', 'fixture', name, '{"id":"cli"}'], {
      env: fixtureEnv, cwd: path.join(root, 'project'), stdout: 'pipe', stderr: 'pipe',
    })
    const timer = setTimeout(() => child.kill(), 5000)
    try {
      const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()])
      expect(code === 0).toBe(name === 'receipt')
      if (name === 'receipt') expect(stdout).toContain('receipt:cli')
      expect(calls.slice(before)).toEqual([{ name, arguments: { id: 'cli' } }])
    } finally { clearTimeout(timer); child.kill() }
  }
}, 25_000)

test('occupied assigned port fails without contacting or replacing its listener', async () => {
  let requests = 0
  const holder = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { requests++; return new Response('foreign') } })
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, 'transport-host.ts'), artifact, path.join(root, 'must-not-ready')], {
    cwd: path.join(root, 'project'), stdout: 'pipe', stderr: 'pipe',
    env: { ...fixtureEnv, AGENT_TEAMS_CURSOR_PROXY_PORT: String(holder.port),
      CURSOR_ACP_MODEL_AUTO_REFRESH: 'false', CURSOR_ACP_MCP_BRIDGE: 'false',
      CURSOR_ACP_REUSE_EXISTING_PROXY: 'true' },
  })
  const timer = setTimeout(() => child.kill(), 5000)
  try {
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
    expect(code).not.toBe(0)
    expect(stderr).toContain('is unavailable')
    expect(requests).toBe(0)
    expect(existsSync(path.join(root, 'must-not-ready'))).toBe(false)
  } finally { clearTimeout(timer); child.kill(); holder.stop(true) }
}, 10_000)

test('an already aborted request never starts a fake process', async () => {
  const controller = new AbortController()
  controller.abort()
  await expect(fetch(`${baseURL}/chat/completions`, { method: 'POST', signal: controller.signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'auto', stream: true, messages: [{ role: 'user', content: 'CASE:preabort' }] }),
  })).rejects.toThrow()
  await Bun.sleep(100)
  expect(entries('preabort')).toEqual([])
})
