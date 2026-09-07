import { expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { existsSync, readFileSync } from 'node:fs'
import { chmod, copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { buildCursorPluginArtifact } from './build.js'
import { stopCursorSessionWithNativeCleanup } from '../../src/services/opencode/OpenCodeCursorStopControl.js'
import type { OpenCodePreparedProfile } from '../../src/services/opencode/types.js'

test('fresh managed artifact seals, aborts and awaits ACK through the runtime client without stopping siblings', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cursor-managed-transport-'))
  const active: AbortController[] = []
  let host: ReturnType<typeof spawn> | undefined
  let diagnostics = ''
  const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
  const lines = (id: string) => existsSync(path.join(root, `${id}.jsonl`))
    ? readFileSync(path.join(root, `${id}.jsonl`), 'utf8').trim().split('\n').map(line => JSON.parse(line)) : []
  const until = async (check: () => boolean, timeout = 5000) => {
    const deadline = Date.now() + timeout
    while (!check()) { if (Date.now() >= deadline) throw new Error(`Managed transport timed out: ${diagnostics}`); await Bun.sleep(20) }
  }
  try {
    await Promise.all(['home', 'config', 'data', 'cache', 'project'].map(dir => mkdir(path.join(root, dir))))
    const artifact = await buildCursorPluginArtifact(path.join(root, 'artifact'))
    const fake = path.join(root, 'fake-cursor'), ready = path.join(root, 'ready.json')
    await copyFile(path.join(import.meta.dir, 'transport-fake-cursor.ts'), fake)
    await chmod(fake, 0o700)
    const assignedPort = await new Promise<number>(resolve => {
      const probe = createServer()
      probe.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
        const address = probe.address()
        const port = typeof address === 'object' && address ? address.port : 0
        probe.close(() => resolve(port))
      })
    })
    const controlEnv = {
      AGENT_TEAMS_CURSOR_CONTROL_DIR: path.join(root, 'control'),
      AGENT_TEAMS_CURSOR_PROFILE_SCOPE: 'transport-scope',
      AGENT_TEAMS_CURSOR_PROXY_PORT: String(assignedPort),
    }
    host = spawn(process.execPath, [path.join(import.meta.dir, 'transport-host.ts'), artifact, ready], {
      cwd: path.join(root, 'project'), detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...controlEnv, PATH: [path.dirname(process.execPath), process.env.PATH].filter(Boolean).join(path.delimiter),
        HOME: path.join(root, 'home'), XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'), XDG_CACHE_HOME: path.join(root, 'cache'),
        CURSOR_AGENT_EXECUTABLE: fake, CURSOR_TRANSPORT_TEST_LOG_ROOT: root, CURSOR_ACP_BACKEND: 'cursor-agent',
        CURSOR_ACP_FORCE: 'false', CURSOR_ACP_REUSE_EXISTING_PROXY: 'false', CURSOR_ACP_AGENT_POOL: 'false',
        CURSOR_ACP_SESSION_RESUME: 'false', CURSOR_ACP_MODEL_AUTO_REFRESH: 'false', CURSOR_ACP_MCP_BRIDGE: 'false',
        CURSOR_ACP_ENABLE_OPENCODE_TOOLS: 'false', CURSOR_ACP_TOOL_LOOP_MODE: 'opencode', CURSOR_ACP_PROVIDER_BOUNDARY: 'v1',
        CURSOR_ACP_PROVIDER_BOUNDARY_AUTOFALLBACK: 'false', CURSOR_ACP_LOG_SILENT: 'true' },
    })
    for (const stream of [host.stdout, host.stderr]) stream?.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-2000) })
    await until(() => { if (host!.exitCode !== null) throw new Error(diagnostics); return existsSync(ready) }, 15000)
    const { baseURL, headers } = JSON.parse(readFileSync(ready, 'utf8'))
    // A managed profile serves on its own assigned endpoint. Sharing the upstream
    // default port let a stale or foreign proxy silently take another profile's
    // traffic, and the provider config would still point at that shared address.
    expect(new URL(baseURL).port).toBe(String(assignedPort))
    expect(new URL(baseURL).port).not.toBe('32124')
    const start = (id: string, credentials: Record<string, string>) => {
      const controller = new AbortController(); active.push(controller)
      const response = fetch(`${baseURL}/chat/completions`, { method: 'POST', signal: controller.signal,
        headers: { 'content-type': 'application/json', ...credentials },
        body: JSON.stringify({ model: 'auto', stream: true, tools: [], messages: [{ role: 'user', content: `CASE:${id}` }] }),
      }).then(async response => ({ status: response.status, text: await response.text() })).catch(() => ({ status: 0, text: '' }))
      return { controller, response }
    }
    const a = start('cancel', headers.a), b = start('normal', headers.b)
    await until(() => lines('cancel').length >= 3 && lines('normal').length >= 3)
    let transportAborts = 0
    const stop = () => stopCursorSessionWithNativeCleanup({ profile: { env: controlEnv } as OpenCodePreparedProfile,
      runtimePid: host!.pid!, sessionId: 'session-a', abortTransport: async () => {
        transportAborts++
        // This uses the original hook credentials. Rejection here proves begin sealed before OC abort.
        expect((await start('blocked', headers.a).response).status).not.toBe(200)
        expect(lines('blocked')).toHaveLength(0)
        a.controller.abort()
        return true
      } })
    expect(await stop()).toBe(true)
    await a.response
    expect(alive(lines('cancel')[0].pid)).toBe(false)
    const stopped = lines('cancel').length
    const sibling = await b.response
    expect(sibling.status).toBe(200)
    expect(sibling.text).toContain('normal:8')
    expect(lines('normal').filter(line => line.count)).toHaveLength(8)
    expect(lines('cancel')).toHaveLength(stopped)
    expect((await start('followup', headers.followup).response).status).toBe(200)
    expect(lines('followup').filter(line => line.count)).toHaveLength(8)
    expect(new Set(['cancel', 'normal', 'followup'].map(id => lines(id)[0].requestId)).size).toBe(3)
    expect(await stop()).toBe(true)
    expect(transportAborts).toBe(2)
    await until(() => !alive(lines('normal')[0].pid) && !alive(lines('followup')[0].pid))
  } finally {
    active.forEach(controller => controller.abort())
    if (host?.pid) {
      try { process.kill(-host.pid, 'SIGTERM') } catch {}
      try { await until(() => !alive(host!.pid!), 3000) }
      catch { try { process.kill(-host.pid, 'SIGKILL') } catch {}; await until(() => !alive(host!.pid!)) }
    }
    await rm(root, { recursive: true, force: true })
  }
}, 30000)
